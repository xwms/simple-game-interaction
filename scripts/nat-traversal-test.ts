/**
 * 功能描述：UDP 打洞 NAT 穿透验证测试
 *
 * 逻辑说明：通过中继信令交换 UDP 地址，验证两端 UDP 是否可穿透 NAT 直连。
 *
 * 使用方式：
 *   # 云服务器端（先启动）
 *   npx tsx scripts/nat-traversal-test.ts --mode server
 *
 *   # 本地端（等 server 输出房间码后）
 *   npx tsx scripts/nat-traversal-test.ts --mode client --code <房间码>
 *
 *   # 单机回环测试（验证脚本逻辑）
 *   npx tsx scripts/nat-traversal-test.ts --mode local
 */

import WebSocket from 'ws'
import * as dgram from 'dgram'
import * as os from 'os'
import * as http from 'http'

const RELAY_URL = 'ws://159.75.150.37:9800'
function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

const MODE = arg('--mode') || 'local'
const ROOM_CODE = arg('--code')
const PUBLIC_IP = arg('--public-ip')

const SUCCESS_ICON = '✅'
const FAIL_ICON = '❌'

function ts(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 23)
}

function log(tag: string, msg: string): void {
  console.log(`[${ts()}] [${tag}] ${msg}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function getLocalIps(): string[] {
  const ips: string[] = ['127.0.0.1']
  for (const info of Object.values(os.networkInterfaces())) {
    if (!info) continue
    for (const i of info) {
      if (i.family === 'IPv4' && !i.internal) ips.push(i.address)
    }
  }
  return ips
}

/**
 * 功能描述：通过中继服务器 HTTP API 获取本机公网 IP
 *
 * 逻辑说明：向中继服务器的 /api/remote-addr 发送 GET 请求，
 *           返回中继看到的本机公网 IPv4 地址。
 *
 * @returns 公网 IP 字符串
 */
function getPublicIp(): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(RELAY_URL.replace('ws://', 'http://').replace(':9800', ':9801') + '/api/remote-addr')
    http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data).ip) }
        catch { reject(new Error('解析公网 IP 失败')) }
      })
    }).on('error', reject)
  })
}

// ─── WebSocket 辅助 ─────────────────────────────────

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

// ─── UDP 通信测试函数 ────────────────────────────────

interface TestStats {
  handshakeOk: boolean
  pingsSent: number
  pongsReceived: number
  rttSum: number
  rttCount: number
  remoteAddr: { address: string; port: number } | null
}

/**
 * 功能描述：运行 UDP 打洞测试
 *
 * 逻辑说明：
 *   握手阶段：主动方发 0xBB → 被动方回 0xCC → 双向连通
 *   测量阶段：双方互发 [0xDA, seq] Ping，收到后回 [0xDA, seq, t_hi, t_lo] Pong
 *
 * @param socket - 已绑定的 UDP 套接字
 * @param targetAddr - 对端地址（主动方需提供，被动方可为 null）
 * @param isInitiator - 是否为握手发起方
 * @param duration - 测试持续时间（毫秒）
 * @returns 测试统计
 */
async function runUdpTest(
  socket: dgram.Socket,
  targetAddr: { address: string; port: number } | null,
  isInitiator: boolean,
  duration: number
): Promise<TestStats> {
  const stats: TestStats = {
    handshakeOk: false,
    pingsSent: 0,
    pongsReceived: 0,
    rttSum: 0,
    rttCount: 0,
    remoteAddr: null
  }

  const pingTimes = new Map<number, number>()
  let seqCounter = 0
  let handshakeDone = false

  socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    // 握手请求 0xBB → 回复 0xCC
    if (msg.length === 1 && msg[0] === 0xBB) {
      stats.remoteAddr = { address: rinfo.address, port: rinfo.port }
      socket.send(Buffer.from([0xCC]), rinfo.port, rinfo.address)
      if (!handshakeDone) {
        stats.handshakeOk = true
        handshakeDone = true
        log('  ←', `${SUCCESS_ICON} 握手 0xBB → 0xCC (${rinfo.address}:${rinfo.port})`)
      } else {
        log('  ←', `握手 0xBB → 0xCC (${rinfo.address}:${rinfo.port})`)
      }
      return
    }

    // 握手回复 0xCC（收到对端的 ACK）
    if (msg.length === 1 && msg[0] === 0xCC) {
      stats.remoteAddr = { address: rinfo.address, port: rinfo.port }
      stats.handshakeOk = true
      handshakeDone = true
      log('  ←', `${SUCCESS_ICON} 握手 ACK 来自 ${rinfo.address}:${rinfo.port}`)
      return
    }

    // Pong: [0xDA, seq, t_hi, t_lo]
    if (msg.length >= 4 && msg[0] === 0xDA) {
      stats.pongsReceived++
      const seq = msg[1]
      const sendTime = pingTimes.get(seq)
      if (sendTime !== undefined) {
        const rtt = Math.round(performance.now() - sendTime)
        stats.rttSum += rtt
        stats.rttCount++
        pingTimes.delete(seq)
        log('  ←', `Pong #${seq} RTT=${rtt}ms`)
      }
      return
    }

    // Ping 首包（第一次收到对端数据）
    if (msg.length >= 2 && msg[0] === 0xDA) {
      const seq = msg[1]
      const pong = Buffer.alloc(6)
      pong[0] = 0xDA; pong[1] = seq
      pong.writeUInt16BE(Math.round(performance.now()) & 0xFFFF, 4)
      socket.send(pong, rinfo.port, rinfo.address)
      if (!handshakeDone) {
        stats.remoteAddr = { address: rinfo.address, port: rinfo.port }
        stats.handshakeOk = true
        handshakeDone = true
        log('  ←', `${SUCCESS_ICON} 首包 Ping #${seq} → 回复 Pong, 地址=${rinfo.address}:${rinfo.port}`)
      } else {
        log('  ←', `Ping #${seq} → Pong`)
      }
      return
    }
  })

  socket.on('error', (e: Error) => log('  !', `UDP 错误: ${e.message}`))

  // 发起方发送握手包
  if (isInitiator && targetAddr) {
    socket.send(Buffer.from([0xBB]), targetAddr.port, targetAddr.address)
    log('  →', `握手 0xBB → ${targetAddr.address}:${targetAddr.port}`)
  }

  // 等待握手完成（最多 5 秒）
  const startTime = Date.now()
  while (!handshakeDone && Date.now() - startTime < 5000) {
    if (isInitiator) {
      // 重发握手包每秒一次
      if (targetAddr) {
        socket.send(Buffer.from([0xBB]), targetAddr.port, targetAddr.address)
      }
    }
    await sleep(1000)
  }

  if (handshakeDone) {
    log('  ✓', `UDP 双向通信已建立, 对端: ${stats.remoteAddr!.address}:${stats.remoteAddr!.port}`)

    // Ping 阶段：使用握手阶段确认的真实对端地址（注意 NAT 映射差异）
    const target = stats.remoteAddr!

    for (let i = 0; i < 10; i++) {
      const seq = seqCounter++
      pingTimes.set(seq, performance.now())
      stats.pingsSent++
      const ping = Buffer.alloc(2)
      ping[0] = 0xDA; ping[1] = seq
      socket.send(ping, target.port, target.address)
      log('  →', `Ping #${seq}`)
      await sleep(1000)
    }

    // 等剩余 Pong 回来
    await sleep(2000)
  } else {
    log('  ✗', `握手失败: ${isInitiator ? '未收到对端回复' : '未收到任何数据'}`)
  }

  return stats
}

// ─── Server 模式 ─────────────────────────────────────

async function runServer(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  UDP 打洞测试 — Server 模式`)
  console.log(`  中继: ${RELAY_URL}`)
  console.log(`  本地 IP: ${getLocalIps().join(', ')}`)
  console.log(`${'='.repeat(56)}`)

  // 支持 --bind-port 指定固定端口（方便云防火墙放行）
  const bindPort = parseInt(arg('--bind-port') || '0', 10)

  // 绑定 UDP
  const udp = dgram.createSocket('udp4')
  const port = await new Promise<number>(r => udp.bind(bindPort, '0.0.0.0', () => r(udp.address().port)))
  log('UDP', `已绑定端口 ${port}`)

  // 连接中继 + 创建房间
  const ws = new WebSocket(RELAY_URL)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', (e) => reject(new Error(`WS 错误: ${e.message}`)))
    setTimeout(() => reject(new Error('WS 连接超时')), 5000)
  })
  log('WS', '已连接')

  // 心跳保持连接
  const hbTimer = setInterval(() => wsSend(ws, { type: 'heartbeat' }), 10000)
  ws.on('close', () => { log('WS', '连接已关闭'); clearInterval(hbTimer) })
  ws.on('error', (e) => log('WS', `错误: ${e.message}`))

  // 支持固定房间码（通过 --code 指定），方便调试
  const fixedCode = arg('--code')
  wsSend(ws, {
    type: 'create-room',
    data: {
      gameId: 'nat-test', gameName: 'NAT Test', gamePort: 9999,
      memberName: 'Server',
      ...(fixedCode ? { roomCode: fixedCode } : {})
    }
  })
  const created = await wsWait(ws, 'room-created')
  const roomCode = created.data.roomCode
  const myId = created.data.memberId
  log('WS', `房间已创建: ${roomCode}, ID: ${myId}`)
  console.log(`\n  房间码: ${roomCode}\n`)

  // 等待加入者（手动操作，给 5 分钟时间）
  log('WS', '等待加入者连接（请在其他终端运行 client 模式）...')
  const joined = await wsWait(ws, 'member-joined', 300000)
  const partnerId = joined.data.memberId
  log('WS', `加入者: ${partnerId},\n        网络信息: ${JSON.stringify(joined.data.networkInfo)}`)

  // 发送 UDP 地址给 Client（如果指定了 --public-ip 则用公网 IP）
  const myIp = PUBLIC_IP || getLocalIps()[0]
  wsSend(ws, {
    type: 'signal',
    data: {
      to: partnerId,
      signalData: { type: 'nat-address', ip: myIp, port, mode: 'server' }
    }
  })
  log('SIG', `已发送 UDP 地址 → ${partnerId}: ${myIp}:${port}`)

  // 等待 Client 回传它的 UDP 地址（通过信令）
  log('SIG', '等待客户端回传 UDP 地址...')
  const clientSignal = await wsWait(ws, 'signal', 300000)
  const clientAddr = clientSignal.data.signalData
  log('SIG', `收到客户端 UDP 地址: ${clientAddr.ip}:${clientAddr.port}`)

  // 两端同时作为发起方发送 UDP 包，实现双向打洞
  log('UDP', '开始双向打洞（服务端 → 客户端 + 客户端 → 服务端 同时发送）')
  const stats = await runUdpTest(
    udp,
    { address: clientAddr.ip, port: clientAddr.port },
    true, // 作为发起方
    20000
  )

  // 汇总
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  测试结果`)
  console.log(`${'='.repeat(56)}`)
  console.log(`  对端地址:     ${stats.remoteAddr ? `${stats.remoteAddr.address}:${stats.remoteAddr.port}` : '未知'}`)
  console.log(`  握手:         ${stats.handshakeOk ? SUCCESS_ICON : FAIL_ICON}`)
  console.log(`  收到 Pong:    ${stats.pongsReceived}/${stats.pingsSent}`)
  if (stats.rttCount > 0) console.log(`  平均 RTT:     ${Math.round(stats.rttSum / stats.rttCount)}ms`)

  udp.close()
  ws.close()
  process.exit(stats.handshakeOk ? 0 : 1)
}

// ─── Client 模式 ─────────────────────────────────────

async function runClient(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  UDP 打洞测试 — Client 模式`)
  console.log(`  中继: ${RELAY_URL}`)
  console.log(`  本地 IP: ${getLocalIps().join(', ')}`)
  console.log(`${'='.repeat(56)}`)

  if (!ROOM_CODE) {
    console.error('\n  需要房间码: npx tsx scripts/nat-traversal-test.ts --mode client --code <房间码>\n')
    process.exit(1)
  }

  // 绑定 UDP
  const udp = dgram.createSocket('udp4')
  const port = await new Promise<number>(r => udp.bind(0, '0.0.0.0', () => r(udp.address().port)))
  log('UDP', `已绑定端口 ${port}`)

  // 连接中继 + 加入房间
  const ws = new WebSocket(RELAY_URL)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', (e) => reject(new Error(`WS 错误: ${e.message}`)))
    setTimeout(() => reject(new Error('WS 连接超时')), 5000)
  })
  log('WS', '已连接')

  // 心跳保持连接
  const hbTimer = setInterval(() => wsSend(ws, { type: 'heartbeat' }), 10000)
  ws.on('close', () => { log('WS', '连接已关闭'); clearInterval(hbTimer) })
  ws.on('error', (e) => log('WS', `错误: ${e.message}`))

  // 预注册 signal 监听器，避免 room-joined → signal 之间的竞态
  let signalResolve: (v: any) => void, signalReject: (e: Error) => void
  const signalPromise = new Promise<any>((resolve, reject) => {
    signalResolve = resolve; signalReject = reject
  })
  const signalTimer = setTimeout(() => signalReject(new Error('信号超时')), 30000)
  const signalHandler = (raw: Buffer | string): void => {
    try {
      const m = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
      if (m.type === 'signal') {
        clearTimeout(signalTimer)
        ws.off('message', signalHandler)
        signalResolve(m)
      }
    } catch { /* ignore */ }
  }
  ws.on('message', signalHandler)

  wsSend(ws, {
    type: 'join-room',
    data: { roomCode: ROOM_CODE, memberName: 'Client' }
  })
  const joined = await wsWait(ws, 'room-joined')
  const serverId = joined.data.hostId
  log('WS', `已加入房间, 房主: ${serverId}`)
  log('WS', `房主网络信息: ${JSON.stringify(joined.data.hostNetworkInfo)}`)

  // 等 Server 的 UDP 地址信令（使用预注册的监听器，无竞态）
  let signal: any
  try {
    signal = await signalPromise
  } catch (e) {
    log('SIG', `等待信号超时: ${(e as Error).message}`)
    udp.close()
    ws.close()
    process.exit(1)
  }

  // ─── 从信号中提取 Server 地址 ──────────────────────────
  const serverAddr = signal.data.signalData
  const serverMemberId = signal.data.from
  log('SIG', `收到 Server UDP 地址: ${serverAddr.ip}:${serverAddr.port}`)

  // ─── 获取本机公网 IP ──────────────────────────────────
  let clientPublicIp = arg('--public-ip')
  if (!clientPublicIp) {
    try {
      clientPublicIp = await getPublicIp()
      log('HTTP', `公网 IP: ${clientPublicIp}`)
    } catch (e) {
      log('HTTP', `获取公网 IP 失败: ${(e as Error).message}, 使用本地地址`)
    }
  }
  if (clientPublicIp) {
    wsSend(ws, {
      type: 'signal',
      data: {
        to: serverMemberId,
        signalData: { type: 'nat-address', ip: clientPublicIp, port, mode: 'client' }
      }
    })
    log('SIG', `已回传 UDP 地址 → ${serverMemberId}: ${clientPublicIp}:${port}`)
    await sleep(500) // 等 Server 先发送，建立防火墙状态
  }

  // ─── UDP 打洞（双端同时发起） ──────────────────────────
  const stats = await runUdpTest(
    udp,
    { address: serverAddr.ip, port: serverAddr.port },
    true,
    20000
  )

  // ─── 汇总 ──────────────────────────────────────────────
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  测试结果`)
  console.log(`${'='.repeat(56)}`)
  console.log(`  对端地址:     ${serverAddr.ip}:${serverAddr.port}`)
  console.log(`  握手:         ${stats.handshakeOk ? SUCCESS_ICON : FAIL_ICON}`)
  console.log(`  收到 Pong:    ${stats.pongsReceived}/${stats.pingsSent}`)
  if (stats.rttCount > 0) console.log(`  平均 RTT:     ${Math.round(stats.rttSum / stats.rttCount)}ms`)

  udp.close()
  ws.close()
  process.exit(stats.handshakeOk ? 0 : 1)
}

// ─── Local 模式（单机回环验证）────────────────────────

// ─── Local 模式（单机回环验证）────────────────────────

async function runLocal(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  UDP 打洞测试 — 单机回环模式`)
  console.log(`  中继: ${RELAY_URL}`)
  console.log(`  本地 IP: ${getLocalIps().join(', ')}`)
  console.log(`${'='.repeat(56)}`)

  log('LOCAL', `此模式在本地启动两个 peer 通过中继交换 + UDP 直连`)

  // Peer A — 房主（类似 server）
  const wsA = new WebSocket(RELAY_URL)
  await new Promise<void>((resolve, reject) => {
    wsA.on('open', resolve); wsA.on('error', reject)
    setTimeout(() => reject(new Error('WS-A 超时')), 5000)
  })
  wsSend(wsA, {
    type: 'create-room',
    data: { gameId: 'nat-test', gameName: 'NAT Test', gamePort: 9999, memberName: 'PeerA' }
  })
  const room = await wsWait(wsA, 'room-created')
  const code = room.data.roomCode
  const idA = room.data.memberId
  log('WS-A', `房间 ${code}, ID: ${idA}`)

  // Peer B — 加入者
  const wsB = new WebSocket(RELAY_URL)
  await new Promise<void>((resolve, reject) => {
    wsB.on('open', resolve); wsB.on('error', reject)
    setTimeout(() => reject(new Error('WS-B 超时')), 5000)
  })
  wsSend(wsB, {
    type: 'join-room',
    data: { roomCode: code, memberName: 'PeerB' }
  })
  const joinResult = await Promise.all([
    wsWait(wsB, 'room-joined'),
    wsWait(wsA, 'member-joined')
  ])
  const idB = joinResult[0].data.memberId
  const idAfromB = joinResult[0].data.hostId
  log('WS-B', `已加入, hostId=${idAfromB}`)

  // 绑定两个 UDP 端口
  const udpA = dgram.createSocket('udp4')
  const udpB = dgram.createSocket('udp4')
  const [portA, portB] = await Promise.all([
    new Promise<number>(r => udpA.bind(0, '0.0.0.0', () => r(udpA.address().port))),
    new Promise<number>(r => udpB.bind(0, '0.0.0.0', () => r(udpB.address().port)))
  ])
  log('UDP-A', `端口 ${portA}`)
  log('UDP-B', `端口 ${portB}`)

  // PeerA 发信令给 PeerB
  wsSend(wsA, {
    type: 'signal',
    data: { to: idB, signalData: { type: 'nat-address', ip: '127.0.0.1', port: portA, mode: 'a' } }
  })

  // Wait for signal at B (A's address)
  const sigToB = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('B 等待信号超时')), 10000)
    wsB.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString())
        if (m.type === 'signal') { clearTimeout(timer); resolve(m.data) }
      } catch { /* ignore */ }
    })
  })
  const addrA: SignalData = sigToB.signalData
  log('SIG-B', `收到 A 地址: ${addrA.ip}:${addrA.port}`)

  // B sends its address to A
  wsSend(wsB, {
    type: 'signal',
    data: { to: idA, signalData: { type: 'nat-address', ip: '127.0.0.1', port: portB, mode: 'b' } }
  })

  const sigToA = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('A 等待信号超时')), 10000)
    wsA.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString())
        if (m.type === 'signal') { clearTimeout(timer); resolve(m.data) }
      } catch { /* ignore */ }
    })
  })
  const addrB: SignalData = sigToA.signalData
  log('SIG-A', `收到 B 地址: ${addrB.ip}:${addrB.port}`)

  // 双向 UDP 打洞测试（并行启动，确保双方同时监听）
  log('LOCAL', '\n--- 并行启动 PeerA (发起方) + PeerB (接收方) ---')
  const [statsA, statsB] = await Promise.all([
    runUdpTest(udpA, { address: addrB.ip, port: addrB.port }, true, 15000),
    runUdpTest(udpB, { address: addrA.ip, port: addrA.port }, false, 15000)
  ])

  // 汇总
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  回环测试结果`)
  console.log(`${'='.repeat(56)}`)
  if (statsA.handshakeOk && statsB.handshakeOk) {
    console.log(`  双向握手:     ${SUCCESS_ICON}`)
    console.log(`  A 收到 Pong:  ${statsA.pongsReceived}/${statsA.pingsSent}`)
    console.log(`  B 收到 Pong:  ${statsB.pongsReceived}/${statsB.pingsSent}`)
    if (statsA.rttCount > 0) console.log(`  A 平均 RTT:   ${Math.round(statsA.rttSum / statsA.rttCount)}ms`)
  } else {
    console.log(`  双向握手:     ${FAIL_ICON}`)
  }

  udpA.close(); udpB.close(); wsA.close(); wsB.close()
  process.exit(statsA.handshakeOk && statsB.handshakeOk ? 0 : 1)
}

// ─── 入口 ────────────────────────────────────────────

interface SignalData {
  type: string; ip: string; port: number; mode: string
}

async function main(): Promise<void> {
  if (MODE === 'server') {
    await runServer()
  } else if (MODE === 'client') {
    await runClient()
  } else {
    await runLocal()
  }
}

main().catch(e => { console.error(`\n  ${FAIL_ICON} ${e.message}\n`); process.exit(1) })
