/**
 * 功能描述：KCP 跨机器通信测试 — 通过中继信令 + KCP UDP 直连
 *
 * 逻辑说明：云服务器端（passive）绑定固定端口，本地端（active）通过中继获取地址后
 *           建立 KCP 连接，验证可靠传输和数据完整性。
 *
 * 使用方式：
 *   # 服务器端（先启动，需放行 UDP 9805）
 *   npx tsx scripts/kcp-cross-test.ts --mode server --public-ip 159.75.150.37 --code KCPTEST
 *
 *   # 本地端
 *   npx tsx scripts/kcp-cross-test.ts --mode client --code KCPTEST
 *
 *   # 单机回环测试
 *   npx tsx scripts/kcp-cross-test.ts --mode local
 */

import WebSocket from 'ws'
import * as http from 'http'
import { KcpTransport } from '../src/core/tunnel/kcp-transport'
import type { PeerConnectionInfo } from '../src/core/connection/types'

const RELAY_URL = 'ws://159.75.150.37:9800'
function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

const MODE = arg('--mode') || 'local'
const ROOM_CODE = arg('--code')
const PUBLIC_IP = arg('--public-ip')
const BIND_PORT = parseInt(arg('--bind-port') || '9805', 10)

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

function getPublicIp(): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = `http://159.75.150.37:9801/api/remote-addr`
    http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data).ip) }
        catch { reject(new Error('解析失败')) }
      })
    }).on('error', reject)
  })
}

// ─── Server 模式 ────────────────────────────────────────

async function runServer(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  KCP 跨机器通信测试 — Server 模式`)
  console.log(`  中继: ${RELAY_URL}`)
  console.log(`  KCP 端口: ${BIND_PORT}`)
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
      gameId: 'kcp-test', gameName: 'KCP Test', gamePort: BIND_PORT,
      memberName: 'KcpServer',
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

  // 设置 KCP passive，绑定固定端口
  const kcpServer = new KcpTransport()
  kcpServer.setBindPort(BIND_PORT)

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

  // 启动 KCP passive
  kcpServer.setRole('passive')

  // 必须在 connect 之前/立即之后注册 data 监听器，
  // 否则 KCP ACK 在监听器注册前已发送，数据永久丢失
  const received: Buffer[] = []
  kcpServer.on('data', (data: Buffer) => { received.push(data) })

  await kcpServer.connect({ peerId: myId })
  const serverPort = kcpServer.localPort!
  log('KCP', `KCP passive 已启动, 端口: ${serverPort}`)

  // 信号：发送 KCP 地址给客户端
  const myIp = PUBLIC_IP || '127.0.0.1'
  wsSend(ws, {
    type: 'signal',
    data: { to: partnerId, signalData: { type: 'kcp-address', ip: myIp, port: serverPort } }
  })
  log('SIG', `已发送 KCP 地址 → ${partnerId}: ${myIp}:${serverPort}`)

  // 等待客户端回传地址（确认双向可达）
  const clientSig = await sigPromise
  log('SIG', `客户端已确认，地址: ${JSON.stringify(clientSig.data?.signalData)}`)

  // 等待 KCP 连接建立（由 active 端的握手完成）
  await sleep(1000)

  if (kcpServer.status !== 'connected') {
    log('KCP', '等待连接...')
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (kcpServer.status === 'connected') { clearInterval(check); resolve() }
      }, 100)
      setTimeout(() => { clearInterval(check); resolve() }, 10000)
    })
  }

  // ─── KCP 数据传输测试 ───────────────────────────────
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  KCP 数据传输测试`)
  console.log(`${'='.repeat(56)}`)

  if (kcpServer.status !== 'connected') {
    fail('KCP 连接未建立')
  } else {
    ok(`KCP 连接已建立 (${kcpServer.status})`)

    // 回放可能延迟缓冲的数据（安全兜底，防止注册前已到达的数据丢失）
    kcpServer.drainPendingData((data: Buffer) => { received.push(data) })

    // 等待收到 HelloFromClient!（最多 10 秒）
    log('KCP', '等待客户端数据...')
    for (let i = 0; i < 20 && received.length === 0; i++) {
      await sleep(500)
    }

    if (received.length >= 1) {
      const hello = received[0].toString()
      if (hello === 'HelloFromClient!') {
        ok(`收到客户端消息: "${hello}"`)
      } else {
        fail(`消息不匹配: "${hello}"`)
      }
    } else {
      fail('未收到客户端消息')
    }

    // 立即回复，不等待剩余数据包
    if (kcpServer.status === 'connected') {
      try {
        await kcpServer.send(Buffer.from('HelloFromServer!'))
        ok('已发送回复给客户端')
      } catch (e) {
        fail('发送回复失败', (e as Error).message)
      }
    }

    // 等待多包数据（客户端在超时后会继续发 3 个包）
    for (let i = 0; i < 20; i++) {
      if (received.length >= 4) break
      await sleep(500)
    }

    // 检查多包数据
    const dataMsgs = received.filter(r => r.toString().startsWith('KCP-Data-'))
    if (dataMsgs.length >= 3) {
      ok(`收到 ${dataMsgs.length} 个数据包`)
    }
  }

  // ─── 断开清理 ──────────────────────────────────────
  await kcpServer.disconnect()
  ok('KCP 已断开')

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
  console.log(`  KCP 跨机器通信测试 — Client 模式`)
  console.log(`  中继: ${RELAY_URL}`)
  console.log(`${'='.repeat(56)}`)

  if (!ROOM_CODE) {
    console.error('\n  需要房间码: npx tsx scripts/kcp-cross-test.ts --mode client --code <房间码>\n')
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

  // 预注册 signal 监听器（避免竞态）
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
    data: { roomCode: ROOM_CODE, memberName: 'KcpClient' }
  })
  const joined = await wsWait(ws, 'room-joined')
  const serverId = joined.data.hostId
  log('WS', `已加入房间, 房主: ${serverId}`)

  // 等 Server 的 KCP 地址信令
  let signal: any
  try {
    signal = await sigPromise
  } catch (e) {
    log('SIG', `等待信号超时: ${(e as Error).message}`)
    ws.close()
    process.exit(1)
  }
  const serverAddr = signal.data.signalData
  const serverMemberId = signal.data.from
  log('SIG', `收到 Server KCP 地址: ${serverAddr.ip}:${serverAddr.port}`)

  // 获取本机公网 IP 并回传
  let clientPublicIp = arg('--public-ip')
  if (!clientPublicIp) {
    try {
      clientPublicIp = await getPublicIp()
      log('HTTP', `公网 IP: ${clientPublicIp}`)
    } catch (e) {
      log('HTTP', `获取公网 IP 失败: ${(e as Error).message}`)
    }
  }
  if (clientPublicIp) {
    wsSend(ws, {
      type: 'signal',
      data: { to: serverMemberId, signalData: { type: 'kcp-address', ip: clientPublicIp, port: 0 } }
    })
    log('SIG', `已回传地址给服务器`)
    await sleep(300)
  }

  // 建立 KCP 连接（active）
  const kcpClient = new KcpTransport()
  kcpClient.setRole('active')
  const peerInfo: PeerConnectionInfo = {
    peerId: serverId,
    kcpAddress: { ip: serverAddr.ip, port: serverAddr.port }
  }

  // 提前注册 data 监听器（防止 connect 后立即收到的数据丢失）
  const received: Buffer[] = []
  kcpClient.on('data', (data: Buffer) => { received.push(data) })

  try {
    await kcpClient.connect(peerInfo)
  } catch (e) {
    fail('KCP 连接失败', (e as Error).message)
    ws.close()
    process.exit(1)
  }

  // ─── KCP 数据传输测试 ───────────────────────────────
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  KCP 数据传输测试`)
  console.log(`${'='.repeat(56)}`)

  ok(`KCP 连接已建立 (${kcpClient.status})`)

  // 回放可能延迟缓冲的数据（连接建立后到监听器注册前的数据）
  kcpClient.drainPendingData((data: Buffer) => { received.push(data) })

  // 发送消息
  try {
    await kcpClient.send(Buffer.from('HelloFromClient!'))
    ok('已发送 HelloFromClient!')
  } catch (e) {
    fail('发送失败', (e as Error).message)
  }

  // 等待服务器回复（KCP 可靠传输，需要等待 update 周期 + 网络延迟）
  await sleep(5000)
  if (received.length >= 1) {
    const reply = received[0].toString()
    if (reply === 'HelloFromServer!') {
      ok(`收到服务端回复: "${reply}"`)
    } else {
      fail(`回复不匹配: "${reply}"`)
    }
  } else {
    fail('未收到服务端回复')
  }

  // 发送多包数据
  try {
    for (let i = 0; i < 3; i++) {
      await kcpClient.send(Buffer.from(`KCP-Data-${i}`))
    }
    ok('已发送 3 个数据包')
  } catch (e) {
    fail('发送多包失败', (e as Error).message)
  }

  // 等待延迟测量
  let rtt = -1
  kcpClient.on('latency', (v: number) => { rtt = v })
  for (let i = 0; i < 15; i++) {
    if (rtt >= 0) break
    await sleep(200)
  }
  if (rtt >= 0) {
    ok(`KCP 延迟: RTT = ${rtt}ms`)
  } else {
    fail('延迟测量超时')
  }

  // 断开
  await kcpClient.disconnect()
  ok('KCP 已断开')

  console.log(`\n${'='.repeat(56)}`)
  console.log(`  测试完成: ${passed + failed} 项`)
  console.log(`  ✅ ${passed} 通过, ❌ ${failed} 失败`)
  if (errors.length > 0) console.log(`  错误: ${errors.join(', ')}`)

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

// ─── Local 模式（单机回环验证）─────────────────────────

async function runLocal(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  KCP 单机回环测试`)
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
    data: { gameId: 'kcp-test', gameName: 'KCPTest', gamePort: 25565, memberName: 'LocalA' }
  })
  const room = await wsWait(ws, 'room-created')
  const code = room.data.roomCode
  const idA = room.data.memberId
  log('WS', `房间 ${code}, ID: ${idA}`)

  // Peer B
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

  // KCP passive (A) + active (B) 直连
  const kcpA = new KcpTransport()
  kcpA.setRole('passive')
  await kcpA.connect({ peerId: idA })
  const portA = kcpA.localPort!
  log('KCP-A', `passive 端口: ${portA}`)

  const kcpB = new KcpTransport()
  kcpB.setRole('active')
  await kcpB.connect({ peerId: idB, kcpAddress: { ip: '127.0.0.1', port: portA } })
  await sleep(500)

  if (kcpA.status !== 'connected' || kcpB.status !== 'connected') {
    fail(`KCP 连接失败: A=${kcpA.status} B=${kcpB.status}`)
    ws.close(); wsB.close()
    process.exit(1)
  }
  ok('KCP 双向连接已建立')

  // 数据传输
  const receivedA: Buffer[] = []
  const receivedB: Buffer[] = []
  kcpA.on('data', (d: Buffer) => receivedA.push(d))
  kcpB.on('data', (d: Buffer) => receivedB.push(d))

  await kcpA.send(Buffer.from('FromA'))
  await kcpB.send(Buffer.from('FromB'))
  await sleep(500)

  if (receivedA.some(r => r.toString() === 'FromB')) ok('A 收到 FromB')
  else fail('A 未收到数据')

  if (receivedB.some(r => r.toString() === 'FromA')) ok('B 收到 FromA')
  else fail('B 未收到数据')

  // 延迟
  let rttA = -1
  kcpA.on('latency', (v: number) => { rttA = v })
  for (let i = 0; i < 15; i++) {
    if (rttA >= 0) break
    await sleep(200)
  }
  if (rttA >= 0) ok(`A 延迟 RTT = ${rttA}ms`)
  else fail('延迟测量超时')

  await kcpA.disconnect()
  await kcpB.disconnect()
  ok('KCP 已断开')

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
