/**
 * 功能描述：UDP 打洞 + KCP 连接综合调试脚本
 *
 * 逻辑说明：分两步验证：
 *   第一步：裸 UDP 探针交换验证双向可达
 *   第二步：在 UDP 打通基础上建立 KCP 连接
 *   使用中继信令交换地址。
 *
 * 使用方式：npx tsx scripts/test-udp-kcp.ts --mode host --code TEST01
 *           npx tsx scripts/test-udp-kcp.ts --mode guest --code TEST01
 */

import WebSocket from 'ws'
import * as dgram from 'dgram'
import * as http from 'http'
import { KcpTransport } from '../src/core/tunnel/kcp-transport'
import type { PeerConnectionInfo } from '../src/core/connection/types'

const RELAY_URL = 'ws://159.75.150.37:9800'

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

const MODE = arg('--mode') || ''
const ROOM_CODE = arg('--code') || ''
const PUBLIC_IP = arg('--public-ip') || ''

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

function getPublicIp(): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get('http://api.ipify.org', (res) => {
      let data = ''
      res.on('data', (chunk) => data += chunk)
      res.on('end', () => resolve(data.trim()))
    }).on('error', reject)
    setTimeout(() => reject(new Error('超时')), 5000)
  })
}

/** 等待中继信号（带超时） */
function waitForSignal(ws: WebSocket, timeout = 20000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('信号超时')), timeout)
    const handler = (raw: Buffer | string) => {
      try {
        const m = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
        if (m.type === 'signal') { clearTimeout(timer); ws.off('message', handler); resolve(m) }
      } catch { /* ignore */ }
    }
    ws.on('message', handler)
  })
}

// ─── Host ─────────────────────────────────────────────

async function runHost(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  UDP+KCP 综合调试 — Host 模式`)
  console.log(`  中继: ${RELAY_URL}`)
  console.log(`${'='.repeat(56)}`)

  // ── 公网 IP ──
  let myPublicIp = PUBLIC_IP
  if (!myPublicIp) {
    try { myPublicIp = await getPublicIp(); log('HTTP', `本机公网 IP: ${myPublicIp}`) }
    catch { myPublicIp = '127.0.0.1'; log('HTTP', '获取公网 IP 失败，用 127.0.0.1') }
  }

  // ── 中继连接 ──
  const ws = new WebSocket(RELAY_URL)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', e => reject(e))
    setTimeout(() => reject(new Error('WS连接超时')), 5000)
  })
  log('WS', '已连接')
  const hbTimer = setInterval(() => wsSend(ws, { type: 'heartbeat' }), 10000)
  ws.on('close', () => clearInterval(hbTimer))

  // 创建房间
  wsSend(ws, {
    type: 'create-room',
    data: {
      gameId: 'udp-test', gameName: 'UDP Test', gamePort: 9805,
      memberName: 'Host',
      ...(ROOM_CODE ? { roomCode: ROOM_CODE } : {})
    }
  })
  const created = await wsWait(ws, 'room-created')
  const roomCode = created.data.roomCode
  const myId = created.data.memberId
  log('WS', `房间 ${roomCode}, ID: ${myId}`)
  console.log(`\n  房间码: ${roomCode}\n`)

  // 等待加入者
  log('WS', '等待加入者...')
  const joined = await wsWait(ws, 'member-joined', 300000)
  const guestId = joined.data.memberId
  log('WS', `加入者: ${guestId}`)

  // ══════════════════════════════════════════════════
  // 第一步：裸 UDP 探针交换
  // ══════════════════════════════════════════════════
  console.log(`\n─── 第一步：裸 UDP 探针交换 ───`)

  const udpHost = dgram.createSocket('udp4')
  udpHost.bind(0, '0.0.0.0')
  const udpHostPort = await new Promise<number>(resolve => {
    udpHost.on('listening', () => resolve((udpHost.address() as any).port))
  })
  log('UDP', `Host UDP 端口: ${udpHostPort}`)

  // 发送 UDP 地址给加入者
  wsSend(ws, {
    type: 'signal',
    data: { to: guestId, signalData: { type: 'udp-address', ip: myPublicIp, port: udpHostPort } }
  })
  log('SIG', `已发送 UDP 地址: ${myPublicIp}:${udpHostPort}`)

  // 等加入者的地址信号
  const guestSig = await waitForSignal(ws)
  const guestSigData = guestSig.data.signalData
  const guestUdpAddr = `${guestSigData.ip}:${guestSigData.port}`
  log('SIG', `收到加入者 UDP 地址: ${guestUdpAddr}`)

  // Host 开始向加入者发探针（建立 NAT 映射）
  const hostProbeInterval = setInterval(() => {
    const buf = Buffer.from('H')
    udpHost.send(buf, 0, 1, guestSigData.port, guestSigData.ip)
  }, 1000)

  // 等待收到加入者的探针
  const hostGotProbe = new Promise<boolean>(resolve => {
    udpHost.on('message', (msg) => {
      log('UDP', `Host 收到探针: "${msg.toString()}" 来自 ${msg.length}B`)
      resolve(true)
    })
    setTimeout(() => resolve(false), 8000)
  })

  const hostProbeOk = await hostGotProbe
  clearInterval(hostProbeInterval)

  if (hostProbeOk) {
    ok('裸 UDP 双向可达！')
  } else {
    fail('裸 UDP 未收到加入者探针（NAT 打洞失败？防火墙拦截？）')
    log('HINT', '检查：1) 双端公网 IP 是否正确 2) 防火墙是否放行 UDP')
    // 继续尝试 KCP，但大概率也会失败
  }

  // ══════════════════════════════════════════════════
  // 第二步：KCP 连接
  // ══════════════════════════════════════════════════
  console.log(`\n─── 第二步：KCP 连接 ───`)

  const kcp = new KcpTransport()
  kcp.setRole('passive')

  const kcpReceived: Buffer[] = []
  kcp.on('data', (data: Buffer) => { kcpReceived.push(data) })

  await kcp.connect({ peerId: myId })
  const kcpPort = kcp.localPort!
  log('KCP', `KCP passive 端口: ${kcpPort}`)

  // 发送 KCP 地址
  wsSend(ws, {
    type: 'signal',
    data: { to: guestId, signalData: { type: 'kcp-address', ip: myPublicIp, port: kcpPort } }
  })
  log('SIG', `已发送 KCP 地址: ${myPublicIp}:${kcpPort}`)

  // 等加入者 kcp-port 信号，触发外部探针
  try {
    const kcpSig = await waitForSignal(ws)
    const kcpSigData = kcpSig.data.signalData
    if (kcpSigData?.type === 'kcp-port') {
      const guestKcpIp = kcpSigData.publicIp || guestSigData.ip
      const guestKcpPort = kcpSigData.kcpPort
      log('SIG', `收到 kcp-port 信号: ${guestKcpIp}:${guestKcpPort}`)
      kcp.addExternalTarget(guestKcpIp, guestKcpPort)
      log('KCP', `外部探针已触发 → ${guestKcpIp}:${guestKcpPort}`)
    }
  } catch {
    log('SIG', 'kcp-port 信号超时')
  }

  // 等 KCP 连接
  for (let i = 0; i < 20; i++) {
    if (kcp.status === 'connected') break
    await sleep(500)
  }

  if (kcp.status === 'connected') {
    ok('KCP 连接已建立')

    // 等数据
    for (let i = 0; i < 20 && kcpReceived.length === 0; i++) await sleep(500)
    if (kcpReceived.length >= 1) {
      ok(`收到消息: "${kcpReceived[0].toString()}"`)
    } else {
      fail('未收到数据')
    }

    try {
      await kcp.send(Buffer.from('HelloFromHost!'))
      ok('已发送回复')
    } catch (e) {
      fail('发送失败', (e as Error).message)
    }
  } else {
    fail(`KCP 连接未建立 (status=${kcp.status})`)
  }

  await kcp.disconnect()
  udpHost.close()
  ws.close()

  console.log(`\n${'='.repeat(56)}`)
  console.log(`  通过: ${passed}  失败: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

// ─── Guest ────────────────────────────────────────────

async function runGuest(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  UDP+KCP 综合调试 — Guest 模式`)
  console.log(`  中继: ${RELAY_URL}`)
  console.log(`${'='.repeat(56)}`)

  if (!ROOM_CODE) {
    console.error('\n  需要 --code <房间码>\n')
    process.exit(1)
  }

  // ── 公网 IP ──
  let myPublicIp = PUBLIC_IP
  if (!myPublicIp) {
    try { myPublicIp = await getPublicIp(); log('HTTP', `本机公网 IP: ${myPublicIp}`) }
    catch { log('HTTP', '获取公网 IP 失败'); myPublicIp = '' }
  }

  // ── 中继连接 ──
  const ws = new WebSocket(RELAY_URL)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', e => reject(e))
    setTimeout(() => reject(new Error('WS连接超时')), 5000)
  })
  log('WS', '已连接')
  const hbTimer = setInterval(() => wsSend(ws, { type: 'heartbeat' }), 10000)
  ws.on('close', () => clearInterval(hbTimer))

  // 加入房间
  wsSend(ws, {
    type: 'join-room',
    data: { roomCode: ROOM_CODE, memberName: 'Guest' }
  })
  const joined = await wsWait(ws, 'room-joined')
  const hostId = joined.data.hostId
  log('WS', `已加入, 房主: ${hostId}`)

  // ══════════════════════════════════════════════════
  // 第一步：裸 UDP 探针交换
  // ══════════════════════════════════════════════════
  console.log(`\n─── 第一步：裸 UDP 探针交换 ───`)

  // 等 Host 的 UDP 地址信号
  const hostUdpSig = await waitForSignal(ws)
  const hostUdp = hostUdpSig.data.signalData
  log('SIG', `收到 Host UDP 地址: ${hostUdp.ip}:${hostUdp.port}`)

  // Guest 开一个 UDP 端口
  const udpGuest = dgram.createSocket('udp4')
  udpGuest.bind(0, '0.0.0.0')
  const udpGuestPort = await new Promise<number>(resolve => {
    udpGuest.on('listening', () => resolve((udpGuest.address() as any).port))
  })
  log('UDP', `Guest UDP 端口: ${udpGuestPort}`)

  // 发 UDP 地址给 Host
  wsSend(ws, {
    type: 'signal',
    data: { to: hostId, signalData: { type: 'udp-address', ip: myPublicIp || '127.0.0.1', port: udpGuestPort } }
  })
  log('SIG', `已发送 UDP 地址`)

  // Guest 开始向 Host 发探针（建立 NAT 映射 + 探测 Host）
  let gotHostProbe = false
  udpGuest.on('message', (msg) => {
    gotHostProbe = true
    log('UDP', `Guest 收到探针: "${msg.toString()}" 来自 ${msg.length}B`)
  })

  const guestProbeInterval = setInterval(() => {
    const buf = Buffer.from('G')
    udpGuest.send(buf, 0, 1, hostUdp.port, hostUdp.ip)
  }, 1000)

  await sleep(8000)
  clearInterval(guestProbeInterval)

  if (gotHostProbe) {
    ok('裸 UDP 双向可达！')
  } else {
    fail(`裸 UDP 未收到 Host 探针`)
  }

  // ══════════════════════════════════════════════════
  // 第二步：KCP 连接
  // ══════════════════════════════════════════════════
  console.log(`\n─── 第二步：KCP 连接 ───`)

  // 等 Host 的 KCP 地址信号
  const hostKcpSig = await waitForSignal(ws)
  const hostKcp = hostKcpSig.data.signalData
  log('SIG', `收到 Host KCP 地址: ${hostKcp.ip}:${hostKcp.port}`)

  const kcp = new KcpTransport()
  kcp.setRole('active')

  const kcpReceived: Buffer[] = []
  kcp.on('data', (data: Buffer) => { kcpReceived.push(data) })

  // 绑定后发 kcp-port 信号
  kcp.on('bound', (localPort: number) => {
    log('KCP', `KCP 端口: ${localPort}，发送 kcp-port 信号`)
    const sigData: Record<string, unknown> = { type: 'kcp-port', kcpPort: localPort }
    if (myPublicIp) sigData.publicIp = myPublicIp
    wsSend(ws, {
      type: 'signal',
      data: { to: hostId, signalData: sigData }
    })
  })

  try {
    await kcp.connect({
      peerId: hostId,
      kcpAddress: { ip: hostKcp.ip, port: hostKcp.port }
    } as PeerConnectionInfo)
  } catch (e) {
    fail('KCP 连接失败', (e as Error).message)
    udpGuest.close()
    ws.close()
    process.exit(1)
  }

  ok('KCP 连接已建立')

  try {
    await kcp.send(Buffer.from('HelloFromGuest!'))
    ok('已发送消息')
  } catch (e) {
    fail('发送失败', (e as Error).message)
  }

  for (let i = 0; i < 20 && kcpReceived.length === 0; i++) await sleep(500)
  if (kcpReceived.length >= 1) {
    ok(`收到回复: "${kcpReceived[0].toString()}"`)
  } else {
    fail('未收到回复')
  }

  await kcp.disconnect()
  udpGuest.close()
  ws.close()

  console.log(`\n${'='.repeat(56)}`)
  console.log(`  通过: ${passed}  失败: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

// ─── 入口 ─────────────────────────────────────────────

async function main(): Promise<void> {
  if (MODE === 'host') await runHost()
  else if (MODE === 'guest') await runGuest()
  else {
    console.error('用法: --mode host|guest --code <房间码> [--public-ip <IP>]')
    process.exit(1)
  }
}

main().catch(e => { console.error(`\n❌ ${e.message}\n`); process.exit(1) })
