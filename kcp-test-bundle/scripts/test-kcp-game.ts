/**
 * 功能描述：KcpTransport 游戏数据模拟测试
 *
 * 逻辑说明：
 *   1. 通过中继交换 KCP 地址信号
 *   2. 使用 KcpTransport 建立 KCP UDP 打洞连接
 *   3. 模拟游戏数据双向传输（64B 包, 20包/秒）
 *   4. 测量延迟、吞吐量、丢包率
 *
 * 使用方式：
 *   # 房主（先启动）
 *   npx tsx scripts/test-kcp-game.ts --mode host --code TEST01
 *
 *   # 加入者（后启动）
 *   npx tsx scripts/test-kcp-game.ts --mode guest --code TEST01
 *
 * 可选参数：
 *   --duration <秒>    测试持续时间（默认 30）
 *   --rate <包/秒>     发送速率（默认 20）
 *   --size <字节>      包大小（默认 64）
 */

import WebSocket from 'ws'
import { KcpTransport } from '../src/core/tunnel/kcp-transport'
import type { PeerConnectionInfo } from '../src/core/connection'

const RELAY_URL = 'ws://159.75.150.37:9800'

// ─── 参数 ───────────────────────────────────────────────

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

const MODE = arg('--mode') || ''
const ROOM_CODE = arg('--code') || ''
const DURATION = parseInt(arg('--duration') || '30', 10)
const RATE = parseInt(arg('--rate') || '20', 10)
const PACKET_SIZE = parseInt(arg('--size') || '64', 10)

let passed = 0
let failed = 0

// ─── 工具 ───────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 23)
}

function log(tag: string, msg: string): void {
  console.log(`[${ts()}] [${tag}] ${msg}`)
}

function ok(msg: string): void { console.log(`  ✅ ${msg}`); passed++ }
function fail(msg: string): void { console.log(`  ❌ ${msg}`); failed++ }
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
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

// ─── 游戏数据模拟 ───────────────────────────────────────

const PACKET_TYPE_GAME = 0x00
const PACKET_TYPE_PING = 0x01
const PACKET_TYPE_PONG = 0x02

function makePacket(seq: number, type: number): Buffer {
  const buf = Buffer.alloc(PACKET_SIZE)
  buf.writeUInt32BE(seq, 0)       // [0-3] 序号
  buf[4] = type                    // [4]   类型
  buf.writeDoubleLE(Date.now(), 5) // [5-12] 时间戳
  return buf
}

interface GameStats {
  sent: number
  received: number
  bytesSent: number
  bytesReceived: number
  rttSamples: number[]
  lossRate: number
}

function computeLossRate(hostSent: number, guestReceived: number): number {
  if (hostSent === 0) return 0
  return Math.max(0, 1 - guestReceived / hostSent) * 100
}

// ─── 心跳 ───────────────────────────────────────────────

function startHeartbeat(ws: WebSocket): ReturnType<typeof setInterval> {
  return setInterval(() => wsSend(ws, { type: 'heartbeat' }), 10000)
}

// ─── 房主 ───────────────────────────────────────────────

async function runHost(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  KcpTransport 游戏数据测试 — Host`)
  console.log(`  中继: ${RELAY_URL}`)
  console.log(`  参数: ${DURATION}s, ${RATE}包/秒, ${PACKET_SIZE}B/包`)
  console.log(`${'='.repeat(56)}`)

  // ── 1. 连接中继 ──
  console.log(`\n─── (1/4) 连接中继 ───`)
  const ws = new WebSocket(RELAY_URL)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', e => reject(e))
    setTimeout(() => reject(new Error('WS 超时')), 5000)
  })
  log('WS', '已连接')
  const hbTimer = startHeartbeat(ws)
  ws.on('close', () => clearInterval(hbTimer))

  wsSend(ws, {
    type: 'create-room',
    data: {
      gameId: 'kcp-game-test', gameName: 'KCP Game Test', gamePort: 9805,
      memberName: 'Host',
      ...(ROOM_CODE ? { roomCode: ROOM_CODE } : {})
    }
  })
  const created = await wsWait(ws, 'room-created')
  const roomCode = created.data.roomCode
  const myId = created.data.memberId
  log('WS', `房间 ${roomCode}, ID: ${myId}`)
  console.log(`\n  房间码: ${roomCode}`)

  // ── 2. 等待加入者 ──
  console.log(`\n─── (2/4) 等待加入者 ───`)
  const joined = await wsWait(ws, 'member-joined', 300000)
  const guestId = joined.data.memberId
  log('WS', `加入者: ${guestId}`)

  // ── 3. 创建 KcpTransport（被动模式） ──
  console.log(`\n─── (3/4) 创建 KcpTransport ───`)
  const transport = new KcpTransport()
  transport.setRole('passive')
  await transport.connect({ peerId: guestId })
  log('KCP', `本地端口: ${transport.localPort}`)

  if (transport.publicPort && transport.publicPort !== transport.localPort) {
    log('STUN', `NAT 映射端口: ${transport.publicIp}:${transport.publicPort} (本地: ${transport.localPort})`)
  } else if (transport.publicPort) {
    log('STUN', `公网地址: ${transport.publicIp}:${transport.publicPort}`)
  } else {
    log('STUN', '未发现 NAT 映射')
  }

  // 发送 KCP 地址信号给加入者
  const kcpPubIp = transport.publicIp
  const kcpPubPort = transport.publicPort
  if (kcpPubIp && kcpPubPort) {
    wsSend(ws, {
      type: 'signal',
      data: { to: guestId, signalData: { type: 'kcp-address', ip: kcpPubIp, port: kcpPubPort } }
    })
    log('SIG', `已发送 KCP 地址: ${kcpPubIp}:${kcpPubPort}`)
  } else {
    fail('未获取到 KCP 公网地址')
    ws.close()
    process.exit(1)
  }

  // 等待 kcp-port 信号（加入者通知本端端口）
  log('SIG', '等待 kcp-port 信号...')
  const guestPortSig = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('kcp-port 信号超时')), 20000)
    const handler = (raw: Buffer | string) => {
      try {
        const m = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
        if (m.type === 'signal' && m.data?.signalData?.type === 'kcp-port') {
          clearTimeout(timer)
          ws.off('message', handler)
          resolve(m.data)
        }
      } catch { /* ignore */ }
    }
    ws.on('message', handler)
  })
  const guestKcpPort = guestPortSig.signalData.kcpPort as number
  const guestPublicIp = guestPortSig.signalData.publicIp as string | undefined
  if (guestPublicIp) {
    transport.addExternalTarget(guestPublicIp, guestKcpPort)
    log('SIG', `收到 kcp-port: ${guestPublicIp}:${guestKcpPort}, 已添加外部探针目标`)
  } else {
    fail('未能获取加入者公网 IP')
    ws.close()
    process.exit(1)
  }

  // 等待 KCP 连接建立
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('KCP 连接超时')), 15000)
    transport.on('status', function onStatus(status: string) {
      if (status === 'connected') {
        clearTimeout(timer)
        transport.removeListener('status', onStatus)
        resolve()
      }
    })
  })
  log('KCP', `连接已建立`)
  ok('KCP 连接成功')

  // ── 4. 游戏数据模拟 ──
  console.log(`\n─── (4/4) 游戏数据模拟 (${DURATION}s) ───`)

  const stats: GameStats = { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0, rttSamples: [], lossRate: 0 }
  const INTERVAL_MS = Math.round(1000 / RATE)
  let gameSeq = 0
  let pingSeq = 0

  // 接收数据
  transport.on('data', (data: Buffer) => {
    stats.received++
    stats.bytesReceived += data.length
    const type = data[4]
    if (type === PACKET_TYPE_PING) {
      // 收到 ping → 立即回复 pong
      const pong = Buffer.alloc(PACKET_SIZE)
      data.copy(pong, 0, 0, PACKET_SIZE) // 原样回复
      pong[4] = PACKET_TYPE_PONG
      transport.send(pong).catch(() => {})
    } else if (type === PACKET_TYPE_PONG) {
      // 收到 pong → 计算 RTT
      const sendTime = data.readDoubleLE(5)
      const rtt = Date.now() - sendTime
      stats.rttSamples.push(rtt)
    }
  })

  // 定时发送游戏数据
  const sendTimer = setInterval(() => {
    const packet = makePacket(gameSeq, PACKET_TYPE_GAME)
    transport.send(packet).catch(() => {})
    stats.sent++
    stats.bytesSent += packet.length
    gameSeq++
  }, INTERVAL_MS)

  // 定时发送 ping
  const pingTimer = setInterval(() => {
    const packet = makePacket(pingSeq, PACKET_TYPE_PING)
    transport.send(packet).catch(() => {})
    pingSeq++
  }, 2000)

  // 每秒报告
  for (let i = 0; i < DURATION; i++) {
    await sleep(1000)
    const sent = stats.sent
    const recv = stats.received
    const elapsed = i + 1
    log('GAME', `第 ${elapsed}s: 发 ${sent} / 收 ${recv}  (${(stats.bytesSent / 1024).toFixed(0)}KB↑ ${(stats.bytesReceived / 1024).toFixed(0)}KB↓)`)
  }

  // 清理
  clearInterval(sendTimer)
  clearInterval(pingTimer)
  clearInterval(hbTimer)

  // ── 报告 ──
  console.log(`\n${'='.repeat(56)}`)
  const lossRate = gameSeq > 0
    ? Math.max(0, 1 - stats.received / Math.max(gameSeq, 1)) * 100
    : 0
  const avgRtt = stats.rttSamples.length > 0
    ? Math.round(stats.rttSamples.reduce((a, b) => a + b, 0) / stats.rttSamples.length)
    : 0
  const minRtt = stats.rttSamples.length > 0 ? Math.min(...stats.rttSamples) : 0
  const maxRtt = stats.rttSamples.length > 0 ? Math.max(...stats.rttSamples) : 0

  log('结果', `发送: ${stats.sent} 包 / ${(stats.bytesSent / 1024).toFixed(1)}KB`)
  log('结果', `接收: ${stats.received} 包 / ${(stats.bytesReceived / 1024).toFixed(1)}KB`)
  log('结果', `丢包率: ${lossRate.toFixed(2)}%`)
  log('结果', `RTT: avg=${avgRtt}ms min=${minRtt}ms max=${maxRtt}ms (${stats.rttSamples.length} 样本)`)

  if (stats.received > 0) {
    ok(`游戏数据传输成功 — 收 ${stats.received} / 发 ${stats.sent}`)
  } else {
    fail('未收到任何游戏数据')
  }

  // 断开连接
  await transport.disconnect()
  ws.close()

  console.log(`\n${'='.repeat(56)}`)
  console.log(`  通过: ${passed}  失败: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

// ─── 加入者 ─────────────────────────────────────────────

async function runGuest(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  KcpTransport 游戏数据测试 — Guest`)
  console.log(`  中继: ${RELAY_URL}`)
  console.log(`  参数: ${DURATION}s, ${RATE}包/秒, ${PACKET_SIZE}B/包`)
  console.log(`${'='.repeat(56)}`)

  if (!ROOM_CODE) {
    console.error('\n  需要 --code <房间码>\n')
    process.exit(1)
  }

  // ── 1. 连接中继 ──
  console.log(`\n─── (1/4) 连接中继 ───`)
  const ws = new WebSocket(RELAY_URL)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', e => reject(e))
    setTimeout(() => reject(new Error('WS 超时')), 5000)
  })
  log('WS', '已连接')
  const hbTimer = startHeartbeat(ws)
  ws.on('close', () => clearInterval(hbTimer))

  // 预注册信号处理器（防止错过地址信号）
  let hostSignal: any = null
  const hostSigPromise = new Promise<void>((resolve) => {
    const handler = (raw: Buffer | string) => {
      try {
        const m = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
        if (m.type === 'signal' && m.data?.signalData?.type === 'kcp-address') {
          hostSignal = m.data
          ws.off('message', handler)
          resolve()
        }
      } catch { /* ignore */ }
    }
    ws.on('message', handler)
    setTimeout(() => { ws.off('message', handler); resolve() }, 20000)
  })

  // 加入房间
  wsSend(ws, {
    type: 'join-room',
    data: { roomCode: ROOM_CODE, memberName: 'Guest' }
  })
  const joined = await wsWait(ws, 'room-joined')
  const hostId = joined.data.hostId
  log('WS', `已加入, 房主: ${hostId}`)

  // ── 2. 获取 Host KCP 地址 ──
  console.log(`\n─── (2/4) 获取 Host KCP 地址 ───`)
  await hostSigPromise
  if (!hostSignal) {
    fail('未收到 Host KCP 地址信号')
    ws.close()
    process.exit(1)
  }
  const hostAddr = { ip: hostSignal.signalData.ip as string, port: hostSignal.signalData.port as number }
  log('SIG', `Host KCP 地址: ${hostAddr.ip}:${hostAddr.port}`)

  // ── 3. 创建 KcpTransport（主动模式） ──
  console.log(`\n─── (3/4) 创建 KcpTransport ───`)
  const transport = new KcpTransport()
  transport.setRole('active')

  // 绑定后通知房主本端 KCP 端口（含公网 IP）
  transport.on('bound', (pubPort: number) => {
    const publicIp = transport.publicIp || ''
    wsSend(ws, {
      type: 'signal',
      data: { to: hostId, signalData: { type: 'kcp-port', kcpPort: pubPort, publicIp } }
    })
    log('SIG', `已发送 kcp-port: ${publicIp}:${pubPort}`)
  })

  // 建立连接
  const peerInfo: PeerConnectionInfo = {
    peerId: hostId,
    kcpAddress: hostAddr
  }
  await transport.connect(peerInfo)
  log('KCP', `连接已建立`)
  if (transport.publicPort && transport.publicPort !== transport.localPort) {
    log('STUN', `NAT 映射端口: ${transport.publicIp}:${transport.publicPort} (本地: ${transport.localPort})`)
  } else if (transport.publicPort) {
    log('STUN', `公网地址: ${transport.publicIp}:${transport.publicPort}`)
  } else {
    log('STUN', '未发现 NAT 映射')
  }
  ok('KCP 连接成功')

  // ── 4. 游戏数据模拟 ──
  console.log(`\n─── (4/4) 游戏数据模拟 (${DURATION}s) ───`)

  const stats: GameStats = { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0, rttSamples: [], lossRate: 0 }
  const INTERVAL_MS = Math.round(1000 / RATE)
  let gameSeq = 0
  let pingSeq = 0

  transport.on('data', (data: Buffer) => {
    stats.received++
    stats.bytesReceived += data.length
    const type = data[4]
    if (type === PACKET_TYPE_PING) {
      const pong = Buffer.alloc(PACKET_SIZE)
      data.copy(pong, 0, 0, PACKET_SIZE)
      pong[4] = PACKET_TYPE_PONG
      transport.send(pong).catch(() => {})
    } else if (type === PACKET_TYPE_PONG) {
      const sendTime = data.readDoubleLE(5)
      const rtt = Date.now() - sendTime
      stats.rttSamples.push(rtt)
    }
  })

  const sendTimer = setInterval(() => {
    const packet = makePacket(gameSeq, PACKET_TYPE_GAME)
    transport.send(packet).catch(() => {})
    stats.sent++
    stats.bytesSent += packet.length
    gameSeq++
  }, INTERVAL_MS)

  const pingTimer = setInterval(() => {
    const packet = makePacket(pingSeq, PACKET_TYPE_PING)
    transport.send(packet).catch(() => {})
    pingSeq++
  }, 2000)

  for (let i = 0; i < DURATION; i++) {
    await sleep(1000)
    const elapsed = i + 1
    log('GAME', `第 ${elapsed}s: 发 ${stats.sent} / 收 ${stats.received}  (${(stats.bytesSent / 1024).toFixed(0)}KB↑ ${(stats.bytesReceived / 1024).toFixed(0)}KB↓)`)
  }

  clearInterval(sendTimer)
  clearInterval(pingTimer)
  clearInterval(hbTimer)

  // ── 报告 ──
  console.log(`\n${'='.repeat(56)}`)
  const lossRate = gameSeq > 0
    ? Math.max(0, 1 - stats.received / Math.max(gameSeq, 1)) * 100
    : 0
  const avgRtt = stats.rttSamples.length > 0
    ? Math.round(stats.rttSamples.reduce((a, b) => a + b, 0) / stats.rttSamples.length)
    : 0
  const minRtt = stats.rttSamples.length > 0 ? Math.min(...stats.rttSamples) : 0
  const maxRtt = stats.rttSamples.length > 0 ? Math.max(...stats.rttSamples) : 0

  log('结果', `发送: ${stats.sent} 包 / ${(stats.bytesSent / 1024).toFixed(1)}KB`)
  log('结果', `接收: ${stats.received} 包 / ${(stats.bytesReceived / 1024).toFixed(1)}KB`)
  log('结果', `丢包率: ${lossRate.toFixed(2)}%`)
  log('结果', `RTT: avg=${avgRtt}ms min=${minRtt}ms max=${maxRtt}ms (${stats.rttSamples.length} 样本)`)

  if (stats.received > 0) {
    ok(`游戏数据传输成功 — 收 ${stats.received} / 发 ${stats.sent}`)
  } else {
    fail('未收到任何游戏数据')
  }

  await transport.disconnect()
  ws.close()

  console.log(`\n${'='.repeat(56)}`)
  console.log(`  通过: ${passed}  失败: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

// ─── 入口 ───────────────────────────────────────────────

async function main(): Promise<void> {
  if (MODE === 'host') await runHost()
  else if (MODE === 'guest') await runGuest()
  else {
    console.error('用法: --mode host|guest --code <房间码> [--duration 30] [--rate 20] [--size 64]')
    process.exit(1)
  }
}

main().catch(e => { console.error(`\n❌ ${e.message}\n`); process.exit(1) })
