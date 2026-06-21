/**
 * 功能描述：IPv6 直连跨机器通信测试 — 通过中继信令 + IPv6 TCP 直连
 *
 * 逻辑说明：云服务器端（passive）监听 IPv6 端口，本地端（active）通过中继获取地址后
 *           建立 IPv6 TCP 连接，验证双向数据传输。
 *
 * 使用方式：
 *   # 服务器端（先启动）
 *   npx tsx scripts/ipv6-cross-test.ts --mode server --public-ip 159.75.150.37 --code IPV6TEST
 *
 *   # 本地端
 *   npx tsx scripts/ipv6-cross-test.ts --mode client --code IPV6TEST
 *
 *   # 单机回环测试
 *   npx tsx scripts/ipv6-cross-test.ts --mode local
 */

import WebSocket from 'ws'
import * as http from 'http'
import { Ipv6DirectTransport } from '../src/core/tunnel/ipv6-direct'
import type { PeerConnectionInfo } from '../src/core/connection/types'

const RELAY_URL = 'ws://159.75.150.37:9800'
function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

const MODE = arg('--mode') || 'local'
const ROOM_CODE = arg('--code')
const PUBLIC_IP = arg('--public-ip')

let passed = 0
let failed = 0
const errors: string[] = []

function ts(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 23)
}
function log(tag: string, msg: string): void {
  console.log(`[${ts()}] [${tag}] ${msg}`)
}
function ok(msg: string): void { console.log(`  ✅ ${msg}`); passed++ }
function fail(msg: string, err = ''): void {
  console.log(`  ❌ ${msg}${err ? ` — ${err}` : ''}`)
  failed++
  if (err) errors.push(`${msg}: ${err}`)
}
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function wsSend(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function wsWait(ws: WebSocket, type: string, timeout = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`消息 "${type}" 超时`)), timeout)
    const handler = (raw: Buffer | string): void => {
      try {
        const m = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
        if (m.type === type) { clearTimeout(timer); ws.off('message', handler); resolve(m) }
      } catch { /* ignore */ }
    }
    ws.on('message', handler)
  })
}

function getServerNetwork(): Promise<{ ipv6: string }> {
  return new Promise((resolve, reject) => {
    http.get('http://159.75.150.37:9801/api/network', (res) => {
      let data = ''
      res.on('data', (chunk) => data += chunk)
      res.on('end', () => {
        try {
          const info = JSON.parse(data)
          const v6Addrs = info.ipv6 as string[]
          const globalV6 = v6Addrs.find((a: string) => a !== '::1' && !a.startsWith('fe80'))
          if (globalV6) resolve({ ipv6: globalV6 })
          else reject(new Error('无全局 IPv6 地址'))
        } catch { reject(new Error('解析失败')) }
      })
    }).on('error', reject)
  })
}

// ─── Server 模式 ────────────────────────────────────────

async function runServer(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  IPv6 跨机器直连测试 — Server 模式`)
  console.log(`  中继: ${RELAY_URL}`)
  console.log(`${'='.repeat(56)}`)

  const ws = new WebSocket(RELAY_URL)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', (e) => reject(new Error(`WS 错误: ${e.message}`)))
    setTimeout(() => reject(new Error('WS 连接超时')), 5000)
  })
  log('WS', '已连接')

  const hbTimer = setInterval(() => wsSend(ws, { type: 'heartbeat' }), 10000)
  ws.on('close', () => { log('WS', '连接已关闭'); clearInterval(hbTimer) })
  ws.on('error', (e) => log('WS', `错误: ${e.message}`))

  const fixedCode = arg('--code')
  wsSend(ws, {
    type: 'create-room',
    data: {
      gameId: 'ipv6-test', gameName: 'IPv6 Test', gamePort: 9804,
      memberName: 'Ipv6Server',
      ...(fixedCode ? { roomCode: fixedCode } : {})
    }
  })
  const created = await wsWait(ws, 'room-created')
  const roomCode = created.data.roomCode
  const myId = created.data.memberId
  log('WS', `房间已创建: ${roomCode}, ID: ${myId}`)
  console.log(`\n  房间码: ${roomCode}\n`)

  // 等待加入者
  log('WS', '等待加入者连接...')
  const joined = await wsWait(ws, 'member-joined', 300000)
  const partnerId = joined.data.memberId

  // 预注册 signal 监听器（避免竞态）
  let sigResolve: (v: any) => void
  const sigPromise = new Promise<any>(r => { sigResolve = r })
  const sigHandler = (raw: Buffer | string) => {
    try {
      const m = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
      if (m.type === 'signal') sigResolve(m)
    } catch {}
  }
  ws.on('message', sigHandler)

  // 获取服务器 IPv6 地址
  let serverV6 = ''
  try {
    const net = await getServerNetwork()
    serverV6 = net.ipv6
    log('NET', `服务器 IPv6: ${serverV6}`)
  } catch (e) {
    fail('获取服务器 IPv6 地址失败', (e as Error).message)
    ws.close()
    process.exit(1)
  }

  // 启动 IPv6 passive（固定端口 44446，需在安全组中放行）
  const ipv6Server = new Ipv6DirectTransport()
  ipv6Server.setRole('passive')
  ipv6Server.setBindPort(44446)
  await ipv6Server.connect({ peerId: myId })
  const serverPort = ipv6Server.localPort!
  log('IPv6', `IPv6 passive 已启动, 端口: ${serverPort}`)

  // 发送 IPv6 地址信号给客户端
  wsSend(ws, {
    type: 'signal',
    data: { to: partnerId, signalData: { type: 'ipv6-address', address: serverV6, port: serverPort } }
  })
  log('SIG', `已发送 IPv6 地址 → ${partnerId}: [${serverV6}]:${serverPort}`)

  // 等待客户端确认
  const clientSig = await sigPromise
  log('SIG', `客户端已确认`)

  // 等待连接建立
  await sleep(500)
  if (ipv6Server.status !== 'connected') {
    log('IPv6', '等待连接...')
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (ipv6Server.status === 'connected') { clearInterval(check); resolve() }
      }, 100)
      setTimeout(() => { clearInterval(check); resolve() }, 10000)
    })
  }

  // ─── 数据传输测试 ─────────────────────────────────
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  IPv6 数据传输测试`)
  console.log(`${'='.repeat(56)}`)

  if (ipv6Server.status !== 'connected') {
    fail('IPv6 连接未建立')
  } else {
    ok(`IPv6 连接已建立 (${ipv6Server.status})`)

    const received: Buffer[] = []
    // 注册 data 监听器后立即 drainPendingData，回放缓冲的数据
    ipv6Server.on('data', (data: Buffer) => { received.push(data) })
    ipv6Server.drainPendingData((data) => { received.push(data) })

    // 等待客户端数据
    log('IPv6', '等待客户端数据...')
    for (let i = 0; i < 20 && received.length === 0; i++) {
      await sleep(500)
    }

    // TCP 是流协议，数据可能合并/拆分，使用 includes 检查而非严格相等
    const allData = received.map(b => b.toString()).join('')
    if (allData.includes('HelloFromClient!')) {
      ok(`收到客户端消息 (包含 "HelloFromClient!")`)
    } else if (received.length >= 1) {
      fail(`消息不匹配: "${received.map(b => b.toString()).join(' | ')}"`)
    } else {
      fail('未收到客户端消息')
    }

    // 回复客户端
    if (ipv6Server.status === 'connected') {
      try {
        await ipv6Server.send(Buffer.from('HelloFromServer!'))
        ok('已发送回复给客户端')
      } catch (e) {
        fail('发送回复失败', (e as Error).message)
      }
    }

    // 等待多包数据（TCP 流式传输，数据包可能合并）
    for (let i = 0; i < 20; i++) {
      if (received.length >= 4) break
      await sleep(500)
    }

    const allReceived = received.map(b => b.toString()).join('')
    const dataCount = (allReceived.match(/IPv6-Data-/g) || []).length
    if (dataCount >= 3) {
      ok(`收到 ${dataCount} 个数据包`)
    } else {
      log('IPv6', `数据包 count=${dataCount}, 原始数据: "${allReceived}"`)
    }
  }

  await ipv6Server.disconnect()
  ok('IPv6 已断开')

  console.log(`\n${'='.repeat(56)}`)
  console.log(`  测试完成: ${passed + failed} 项`)
  console.log(`  ✅ ${passed} 通过, ❌ ${failed} 失败`)
  if (errors.length > 0) console.log(`  错误: ${errors.join(', ')}`)

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

// ─── Client 模式 ────────────────────────────────────────

async function runClient(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  IPv6 跨机器直连测试 — Client 模式`)
  console.log(`  中继: ${RELAY_URL}`)
  console.log(`${'='.repeat(56)}`)

  if (!ROOM_CODE) {
    console.error('\n  需要房间码: npx tsx scripts/ipv6-cross-test.ts --mode client --code <房间码>\n')
    process.exit(1)
  }

  const ws = new WebSocket(RELAY_URL)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', (e) => reject(new Error(`WS 错误: ${e.message}`)))
    setTimeout(() => reject(new Error('WS 连接超时')), 5000)
  })
  log('WS', '已连接')

  const hbTimer = setInterval(() => wsSend(ws, { type: 'heartbeat' }), 10000)
  ws.on('close', () => { log('WS', '连接已关闭'); clearInterval(hbTimer) })
  ws.on('error', (e) => log('WS', `错误: ${e.message}`))

  // 预注册 signal 监听器
  let sigResolve: (v: any) => void, sigReject: (e: Error) => void
  const sigPromise = new Promise<any>((resolve, reject) => {
    sigResolve = resolve; sigReject = reject
  })
  const sigTimer = setTimeout(() => sigReject(new Error('信号超时')), 30000)
  const sigHandler = (raw: Buffer | string) => {
    try {
      const m = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
      if (m.type === 'signal') { clearTimeout(sigTimer); ws.off('message', sigHandler); sigResolve(m) }
    } catch {}
  }
  ws.on('message', sigHandler)

  wsSend(ws, {
    type: 'join-room',
    data: { roomCode: ROOM_CODE, memberName: 'Ipv6Client' }
  })
  const joined = await wsWait(ws, 'room-joined')
  const serverId = joined.data.hostId
  log('WS', `已加入房间, 房主: ${serverId}`)

  // 等服务器 IPv6 地址信号
  let signal: any
  try {
    signal = await sigPromise
  } catch (e) {
    log('SIG', `等待信号超时: ${(e as Error).message}`)
    ws.close()
    process.exit(1)
  }
  const serverV6Addr = signal.data.signalData
  log('SIG', `收到 Server IPv6 地址: [${serverV6Addr.address}]:${serverV6Addr.port}`)

  // 发确认给服务器
  wsSend(ws, {
    type: 'signal',
    data: { to: signal.data.from, signalData: { type: 'ack' } }
  })

  // 建立 IPv6 连接（active）— 在 connect 前注册 data 监听
  const ipv6Client = new Ipv6DirectTransport()
  ipv6Client.setRole('active')
  const peerInfo: PeerConnectionInfo = {
    peerId: serverId,
    ipv6Address: serverV6Addr.address,
    ipv6Port: serverV6Addr.port
  }
  const received: Buffer[] = []
  ipv6Client.on('data', (data: Buffer) => { received.push(data) })

  try {
    await ipv6Client.connect(peerInfo)
  } catch (e) {
    fail('IPv6 连接失败', (e as Error).message)
    ws.close()
    process.exit(1)
  }

  // ─── 数据传输测试 ─────────────────────────────────
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  IPv6 数据传输测试`)
  console.log(`${'='.repeat(56)}`)

  ok(`IPv6 连接已建立 (${ipv6Client.status})`)

  // 发送消息
  try {
    await ipv6Client.send(Buffer.from('HelloFromClient!'))
    ok('已发送 HelloFromClient!')
  } catch (e) {
    fail('发送失败', (e as Error).message)
  }

  // 等待服务器回复
  await sleep(5000)
  const allClientData = received.map(b => b.toString()).join('')
  if (allClientData.includes('HelloFromServer!')) {
    ok(`收到服务端回复 (包含 "HelloFromServer!")`)
  } else if (received.length >= 1) {
    fail(`回复不匹配: "${received.map(b => b.toString()).join(' | ')}"`)
  } else {
    fail('未收到服务端回复')
  }

  // 发送多包数据
  try {
    for (let i = 0; i < 3; i++) {
      await ipv6Client.send(Buffer.from(`IPv6-Data-${i}`))
    }
    ok('已发送 3 个数据包')
  } catch (e) {
    fail('发送多包失败', (e as Error).message)
  }

  await ipv6Client.disconnect()
  ok('IPv6 已断开')

  console.log(`\n${'='.repeat(56)}`)
  console.log(`  测试完成: ${passed + failed} 项`)
  console.log(`  ✅ ${passed} 通过, ❌ ${failed} 失败`)
  if (errors.length > 0) console.log(`  错误: ${errors.join(', ')}`)

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

// ─── Local 模式 ──────────────────────────────────────────

async function runLocal(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  IPv6 单机回环测试`)
  console.log(`  中继: ${RELAY_URL}`)
  console.log(`${'='.repeat(56)}`)

  const ws = new WebSocket(RELAY_URL)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve); ws.on('error', reject)
    setTimeout(() => reject(new Error('WS 连接超时')), 5000)
  })
  const hbTimer = setInterval(() => wsSend(ws, { type: 'heartbeat' }), 10000)
  ws.on('close', () => clearInterval(hbTimer))

  wsSend(ws, {
    type: 'create-room',
    data: { gameId: 'ipv6-test', gameName: 'IPv6 Test', gamePort: 9804, memberName: 'LocalA' }
  })
  const room = await wsWait(ws, 'room-created')
  const code = room.data.roomCode
  const idA = room.data.memberId
  log('WS', `房间 ${code}, ID: ${idA}`)

  const wsB = new WebSocket(RELAY_URL)
  await new Promise<void>((resolve, reject) => {
    wsB.on('open', resolve); wsB.on('error', reject)
    setTimeout(() => reject(new Error('WS-B 超时')), 5000)
  })
  const hbTimerB = setInterval(() => wsSend(wsB, { type: 'heartbeat' }), 10000)
  wsB.on('close', () => clearInterval(hbTimerB))

  wsSend(wsB, {
    type: 'join-room',
    data: { roomCode: code, memberName: 'LocalB' }
  })
  const [joinB] = await Promise.all([
    wsWait(wsB, 'room-joined'),
    wsWait(ws, 'member-joined')
  ])
  const idB = joinB.data.memberId
  log('WS', `加入者 ID: ${idB}`)

  // IPv6 passive (A) + active (B) 直连（使用回环地址 ::1）
  const ipv6A = new Ipv6DirectTransport()
  ipv6A.setRole('passive')
  await ipv6A.connect({ peerId: idA })
  const portA = ipv6A.localPort!
  log('IPv6-A', `passive 监听 :::${portA}`)

  const ipv6B = new Ipv6DirectTransport()
  ipv6B.setRole('active')
  await ipv6B.connect({ peerId: idB, ipv6Address: '::1', ipv6Port: portA })
  await sleep(500)

  if (ipv6A.status !== 'connected' || ipv6B.status !== 'connected') {
    fail(`IPv6 连接失败: A=${ipv6A.status} B=${ipv6B.status}`)
    ws.close(); wsB.close()
    process.exit(1)
  }
  ok('IPv6 双向连接已建立')

  // 数据传输
  const receivedA: Buffer[] = []
  const receivedB: Buffer[] = []
  ipv6A.on('data', (d: Buffer) => receivedA.push(d))
  ipv6B.on('data', (d: Buffer) => receivedB.push(d))

  await ipv6A.send(Buffer.from('FromA'))
  await ipv6B.send(Buffer.from('FromB'))
  await sleep(500)

  if (receivedA.some(r => r.toString() === 'FromB')) ok('A 收到 FromB')
  else fail('A 未收到数据')

  if (receivedB.some(r => r.toString() === 'FromA')) ok('B 收到 FromA')
  else fail('B 未收到数据')

  await ipv6A.disconnect()
  await ipv6B.disconnect()
  ok('IPv6 已断开')

  ws.close(); wsB.close()
  ok('WebSocket 已关闭')

  console.log(`\n${'='.repeat(56)}`)
  console.log(`  测试完成: ${passed + failed} 项`)
  console.log(`  ✅ ${passed} 通过, ❌ ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

// ─── 入口 ───────────────────────────────────────────────

async function main(): Promise<void> {
  if (MODE === 'server') {
    await runServer()
  } else if (MODE === 'client') {
    await runClient()
  } else {
    await runLocal()
  }
}

main().catch(e => { console.error(`\n❌ ${e.message}\n`); process.exit(1) })
