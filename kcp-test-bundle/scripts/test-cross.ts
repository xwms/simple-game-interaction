/**
 * 功能描述：KCP 跨机器 UDP 打洞测试 — 通过中继信令触发双向探针
 *
 * 逻辑说明：
 *   验证 KCP UDP 打洞修复：加入者定时发送探针，
 *   房主收到 kcp-port 信号后调用 addExternalTarget 也发送探针，
 *   双向 NAT 映射建立后 KCP 连接成功。
 *
 * 使用方式：
 *   # 房主（先启动，带公网 IP 或 NAT）
 *   npx tsx scripts/test-cross.ts --mode host --code TESTKP
 *
 *   # 加入者（后启动，使用同一房间码）
 *   npx tsx scripts/test-cross.ts --mode guest --code TESTKP
 *
 *   # 单机回环测试
 *   npx tsx scripts/test-cross.ts --mode local
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
const ROOM_CODE = arg('--code') || ''

let passed = 0
let failed = 0

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
}
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** 通过 https://api.ipify.org 获取本机公网 IP */
function getPublicIp(): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get('http://api.ipify.org', (res) => {
      let data = ''
      res.on('data', (chunk) => data += chunk)
      res.on('end', () => resolve(data.trim()))
    }).on('error', reject)
    setTimeout(() => reject(new Error('获取公网 IP 超时')), 5000)
  })
}

function wsSend(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function wsWait(ws: WebSocket, type: string, timeout = 15000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`消息 "${type}" 超时`)), timeout)
    const handler = (raw: Buffer | string) => {
      try {
        const m = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
        if (m.type === type) { clearTimeout(timer); ws.off('message', handler); resolve(m) }
      } catch { /* ignore */ }
    }
    ws.on('message', handler)
  })
}

// ─── Host 模式（房主，passive KCP）────────────────────

async function runHost(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  KCP 跨机器打洞测试 — Host 模式`)
  console.log(`  中继: ${RELAY_URL}`)
  console.log(`${'='.repeat(56)}`)

  if (arg('--code')) log('MODE', `房间码: ${ROOM_CODE}`)

  // 获取本机公网 IP
  let myPublicIp = arg('--public-ip')
  if (!myPublicIp) {
    try {
      myPublicIp = await getPublicIp()
      log('HTTP', `本机公网 IP: ${myPublicIp}`)
    } catch (e) {
      log('HTTP', `获取公网 IP 失败: ${(e as Error).message}，使用 127.0.0.1`)
      myPublicIp = '127.0.0.1'
    }
  }

  const ws = new WebSocket(RELAY_URL)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', e => reject(new Error(`WS 错误: ${e.message}`)))
    setTimeout(() => reject(new Error('WS 连接超时')), 5000)
  })
  log('WS', '已连接')

  const hbTimer = setInterval(() => wsSend(ws, { type: 'heartbeat' }), 10000)
  ws.on('close', () => { log('WS', '连接已关闭'); clearInterval(hbTimer) })
  ws.on('error', e => log('WS', `错误: ${e.message}`))

  // 创建房间（支持固定房间码）
  wsSend(ws, {
    type: 'create-room',
    data: {
      gameId: 'kcp-test', gameName: 'KCP Test', gamePort: 9805,
      memberName: 'Host',
      ...(ROOM_CODE ? { roomCode: ROOM_CODE } : {})
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
  const guestId = joined.data.memberId
  log('WS', `加入者已连接: ${guestId}`)

  // 创建 KCP passive
  const kcp = new KcpTransport()
  kcp.setRole('passive')

  const received: Buffer[] = []
  kcp.on('data', (data: Buffer) => { received.push(data) })

  await kcp.connect({ peerId: myId })
  const myPort = kcp.localPort!
  log('KCP', `KCP passive 已启动, 端口: ${myPort}`)

  // 发送 KCP 地址给加入者（用真实公网 IP）
  wsSend(ws, {
    type: 'signal',
    data: { to: guestId, signalData: { type: 'kcp-address', ip: myPublicIp, port: myPort } }
  })
  log('SIG', `已发送 KCP 地址给加入者: ${myPublicIp}:${myPort}`)

  // 监听 kcp-port 信号，触发外部探针（核心修复点）
  const kcpSignal = new Promise<void>((resolve) => {
    const handler = (raw: Buffer | string) => {
      try {
        const m = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
        if (m.type === 'signal') {
          const sig = m.data?.signalData
          if (sig?.type === 'kcp-port' && typeof sig.kcpPort === 'number') {
            // 加入者公网 IP 从信号中获取，或从 member-joined 事件中获取
            const guestIp = sig.publicIp || joined.data.networkInfo?.ipv4?.publicIp
            if (guestIp && guestIp !== '127.0.0.1') {
              log('SIG', `收到加入者 KCP 端口信号: ${guestIp}:${sig.kcpPort}`)
              kcp.addExternalTarget(guestIp, sig.kcpPort)
              log('KCP', `已触发外部探针 → ${guestIp}:${sig.kcpPort}`)
            } else {
              log('SIG', `kcp-port 信号缺少加入者公网 IP (guestIp=${guestIp}), 跳过外部探针`)
            }
            ws.off('message', handler)
            resolve()
          }
        }
      } catch { /* ignore */ }
    }
    ws.on('message', handler)
    // 超时后备
    setTimeout(() => { ws.off('message', handler); resolve() }, 15000)
  })
  await kcpSignal

  // 等待连接建立（探针双向打洞后）
  log('KCP', '等待 KCP 连接建立...')
  for (let i = 0; i < 30; i++) {
    if (kcp.status === 'connected') break
    await sleep(500)
  }

  // ─── 数据传输测试 ──────────────────────────────────
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  数据传输测试`)
  console.log(`${'='.repeat(56)}`)

  if (kcp.status === 'connected') {
    ok(`KCP 连接已建立`)

    // 等待加入者消息
    for (let i = 0; i < 20 && received.length === 0; i++) await sleep(500)
    if (received.length >= 1) {
      ok(`收到消息: "${received[0].toString()}"`)
    } else {
      fail('未收到加入者消息')
    }

    // 回复
    try {
      await kcp.send(Buffer.from('HelloFromHost!'))
      ok('已发送回复')
    } catch (e) {
      fail('发送回复失败', (e as Error).message)
    }
  } else {
    fail('KCP 连接未建立')
  }

  await kcp.disconnect()
  ok('KCP 已断开')
  ws.close()

  console.log(`\n${'='.repeat(56)}`)
  console.log(`  通过: ${passed}  失败: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

// ─── Guest 模式（加入者，active KCP）───────────────────

async function runGuest(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  KCP 跨机器打洞测试 — Guest 模式`)
  console.log(`  中继: ${RELAY_URL}`)
  console.log(`${'='.repeat(56)}`)

  if (!ROOM_CODE) {
    console.error('\n  需要房间码: --code <房间码>\n')
    process.exit(1)
  }

  // 获取本机公网 IP
  let myPublicIp = arg('--public-ip')
  if (!myPublicIp) {
    try {
      myPublicIp = await getPublicIp()
      log('HTTP', `本机公网 IP: ${myPublicIp}`)
    } catch (e) {
      log('HTTP', `获取公网 IP 失败: ${(e as Error).message}`)
      myPublicIp = ''
    }
  }

  const ws = new WebSocket(RELAY_URL)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', e => reject(new Error(`WS 错误: ${e.message}`)))
    setTimeout(() => reject(new Error('WS 连接超时')), 5000)
  })
  log('WS', '已连接')

  const hbTimer = setInterval(() => wsSend(ws, { type: 'heartbeat' }), 10000)
  ws.on('close', () => { log('WS', '连接已关闭'); clearInterval(hbTimer) })
  ws.on('error', e => log('WS', `错误: ${e.message}`))

  // 预注册信号处理器（避免错过房主信号）
  let hostKcpAddr: { ip: string; port: number } | null = null
  const sigPromise = new Promise<void>((resolve) => {
    const handler = (raw: Buffer | string) => {
      try {
        const m = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
        if (m.type === 'signal') {
          const sig = m.data?.signalData
          if (sig?.type === 'kcp-address' && typeof sig.port === 'number') {
            hostKcpAddr = { ip: sig.ip || '127.0.0.1', port: sig.port }
            log('SIG', `收到房主 KCP 地址`)
            ws.off('message', handler)
            resolve()
          }
        }
      } catch { /* ignore */ }
    }
    ws.on('message', handler)
    setTimeout(() => { ws.off('message', handler); resolve() }, 15000)
  })

  // 加入房间
  wsSend(ws, {
    type: 'join-room',
    data: { roomCode: ROOM_CODE, memberName: 'Guest' }
  })
  const joined = await wsWait(ws, 'room-joined')
  const hostId = joined.data.hostId
  log('WS', `已加入房间, 房主 ID: ${hostId}`)

  // 等待房主的 KCP 地址信号
  await sigPromise
  if (!hostKcpAddr) {
    fail('未收到房主 KCP 地址')
    ws.close()
    process.exit(1)
  }
  const hostAddr: { ip: string; port: number } = hostKcpAddr
  log('SIG', `房主 KCP 地址: ${hostAddr.ip}:${hostAddr.port}`)

  // 创建 KCP active
  const kcp = new KcpTransport()
  kcp.setRole('active')

  const received: Buffer[] = []
  kcp.on('data', (data: Buffer) => { received.push(data) })

  // 绑定后发送 kcp-port 信号给房主（触发外部探针）
  kcp.on('bound', (localPort: number) => {
    log('KCP', `KCP 已绑定端口 ${localPort}，通知房主触发探针`)
    const sigData: Record<string, unknown> = { type: 'kcp-port', kcpPort: localPort }
    if (myPublicIp) sigData.publicIp = myPublicIp
    wsSend(ws, {
      type: 'signal',
      data: { to: hostId, signalData: sigData }
    })
    log('SIG', `已发送 kcp-port 信号 ${myPublicIp ? `(公网: ${myPublicIp})` : ''}`)

    // 信号发送后关闭 WS（不再需要中继）
    ws.close()
  })

  // 连接（含探针循环，自动重传直到收到响应）
  try {
    await kcp.connect({
      peerId: hostId,
      kcpAddress: { ip: hostAddr.ip, port: hostAddr.port }
    } as PeerConnectionInfo)
  } catch (e) {
    fail('KCP 连接失败', (e as Error).message)
    ws.close()
    process.exit(1)
  }

  ok(`KCP 连接已建立`)

  // ─── 数据传输 ──────────────────────────────────────
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  数据传输测试`)
  console.log(`${'='.repeat(56)}`)

  try {
    await kcp.send(Buffer.from('HelloFromGuest!'))
    ok('已发送 HelloFromGuest!')
  } catch (e) {
    fail('发送失败', (e as Error).message)
  }

  // 等待房主回复
  for (let i = 0; i < 20; i++) {
    if (received.length > 0) break
    await sleep(500)
  }
  if (received.length >= 1) {
    ok(`收到回复: "${received[0].toString()}"`)
  } else {
    fail('未收到回复')
  }

  await kcp.disconnect()
  ok('KCP 已断开')

  console.log(`\n${'='.repeat(56)}`)
  console.log(`  通过: ${passed}  失败: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

// ─── Local 模式（单机回环）────────────────────────────

async function runLocal(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  KCP 单机回环测试`)
  console.log(`${'='.repeat(56)}`)

  // Host (passive)
  const host = new KcpTransport()
  host.setRole('passive')
  await host.connect({ peerId: 'local-host' })
  const hostPort = host.localPort!
  log('HOST', `passive 端口: ${hostPort}`)

  // Guest (active) - 监听 bound 事件后触发 host 的 addExternalTarget
  const guest = new KcpTransport()
  guest.setRole('active')
  guest.on('bound', (port: number) => {
    log('GUEST', `active 绑定端口 ${port}，触发 host 外部探针`)
    host.addExternalTarget('127.0.0.1', port)
  })

  await guest.connect({
    peerId: 'local-guest',
    kcpAddress: { ip: '127.0.0.1', port: hostPort }
  } as PeerConnectionInfo)
  await sleep(300)

  if (host.status === 'connected' && guest.status === 'connected') {
    ok('双向连接已建立')
  } else {
    fail(`连接失败: host=${host.status} guest=${guest.status}`)
  }

  // 数据传输
  const hostReceived: Buffer[] = []
  const guestReceived: Buffer[] = []
  host.on('data', (d: Buffer) => hostReceived.push(d))
  guest.on('data', (d: Buffer) => guestReceived.push(d))

  await host.send(Buffer.from('FromHost'))
  await guest.send(Buffer.from('FromGuest'))
  await sleep(500)

  if (hostReceived.some(r => r.toString() === 'FromGuest')) ok('Host 收到 FromGuest')
  else fail('Host 未收到数据')

  if (guestReceived.some(r => r.toString() === 'FromHost')) ok('Guest 收到 FromHost')
  else fail('Guest 未收到数据')

  await host.disconnect()
  await guest.disconnect()
  ok('KCP 已断开')

  console.log(`\n${'='.repeat(56)}`)
  console.log(`  通过: ${passed}  失败: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

// ─── 入口 ─────────────────────────────────────────────

async function main(): Promise<void> {
  if (MODE === 'host') await runHost()
  else if (MODE === 'guest') await runGuest()
  else await runLocal()
}

main().catch(e => { console.error(`\n❌ ${e.message}\n`); process.exit(1) })
