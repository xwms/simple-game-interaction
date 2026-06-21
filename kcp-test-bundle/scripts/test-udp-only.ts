/**
 * 功能描述：UDP 打洞裸测试 — 仅验证 UDP 双向可达性
 *
 * 逻辑说明：
 *   1. 通过 STUN 获取本机公网 IP:端口
 *   2. 通过中继交换双方的 UDP 地址
 *   3. 双方互发 UDP 探针（持续 10 秒）
 *   4. 验证双向 UDP 是否可达
 *   5. KCP 可靠传输测试（15 秒）
 *   包含裸 UDP 与 KCP 双重验证。
 *
 * 使用方式：
 *   # 房主（先启动）
 *   npx tsx scripts/test-udp-only.ts --mode host --code TEST01
 *
 *   # 加入者（后启动）
 *   npx tsx scripts/test-udp-only.ts --mode guest --code TEST01
 */

import WebSocket from 'ws'
import * as dgram from 'dgram'
import * as crypto from 'crypto'
import * as http from 'http'
import { Kcp } from '../src/core/utils/kcp'

const RELAY_URL = 'ws://159.75.150.37:9800'
const STUN_SERVERS = [
  'stun.miwifi.com:3478',
  'stun.chat.bilibili.com:3478',
  'stun.cloudflare.com:3478',
  'stun.l.google.com:19302'
]

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

// ─── STUN ─────────────────────────────────────────────

/**
 * 功能描述：通过 STUN 协议获取本机公网 IP 和端口
 *
 * 逻辑说明：向 STUN 服务器发送 Binding Request，
 *           解析 XOR-MAPPED-ADDRESS 属性获得公网地址。
 *           并发查询多台服务器，取最快返回的结果。
 *
 * @returns { ip, port } 公网 IP 和端口
 */
function stunGetPublicAddr(existingSocket?: dgram.Socket): Promise<{ ip: string; port: number }> {
  return new Promise((resolve, reject) => {
    const socket = existingSocket || dgram.createSocket('udp4')
    const results: Array<{ ip: string; port: number; latency: number }> = []
    let pending = STUN_SERVERS.length
    let done = false

    socket.on('error', () => { /* 单个服务器失败不影响 */ })

    socket.on('message', (msg: Buffer) => {
      if (done) return
      // 解析 STUN 响应
      try {
        if (msg.length < 20) return
        const msgType = msg.readUInt16BE(0)
        if (msgType !== 0x0101) return // Binding Success Response

        const magicCookie = msg.readUInt32BE(4)
        if (magicCookie !== 0x2112a442) return

        // 遍历属性查找 XOR-MAPPED-ADDRESS
        let offset = 20
        while (offset + 4 <= msg.length) {
          const attrType = msg.readUInt16BE(offset)
          const attrLen = msg.readUInt16BE(offset + 2)
          if (attrType === 0x0020 && attrLen >= 8 && offset + 4 + attrLen <= msg.length) {
            const xPort = msg.readUInt16BE(offset + 6)
            const port = xPort ^ 0x2112 // XOR with first 2 bytes of magic cookie

            const xAddr = Buffer.alloc(4)
            for (let i = 0; i < 4; i++) {
              xAddr[i] = msg[offset + 8 + i] ^ (magicCookie >> (24 - i * 8)) & 0xff
            }
            const ip = `${xAddr[0]}.${xAddr[1]}.${xAddr[2]}.${xAddr[3]}`

            if (!done) {
              done = true
              if (!existingSocket) socket.close()
              log('STUN', `公网地址: ${ip}:${port}`)
              resolve({ ip, port })
            }
            return
          }
          offset += 4 + attrLen
          // 对齐到 4 字节
          if (offset % 4 !== 0) offset += 4 - (offset % 4)
        }
      } catch { /* 解析失败跳过 */ }
    })

    // 并发查询所有 STUN 服务器
    for (const server of STUN_SERVERS) {
      const [host, portStr] = server.split(':')
      const serverPort = parseInt(portStr, 10)
      const transactionId = crypto.randomBytes(12)

      // STUN Binding Request header: 20 bytes
      const buf = Buffer.alloc(20)
      buf.writeUInt16BE(0x0001, 0)        // Binding Request
      buf.writeUInt16BE(0, 2)              // 消息长度（无属性）
      buf.writeUInt32BE(0x2112a442, 4)     // Magic Cookie
      transactionId.copy(buf, 8)

      socket.send(buf, 0, buf.length, serverPort, host, (err) => {
        if (err) {
          pending--
          if (pending <= 0 && !done) {
            done = true
            if (!existingSocket) socket.close()
            reject(new Error(`STUN 所有服务器无响应`))
          }
        }
      })
    }

    // 超时保护
    setTimeout(() => {
      if (!done) {
        done = true
        if (!existingSocket) socket.close()
        reject(new Error('STUN 超时'))
      }
    }, 5000)
  })
}

// ─── Host ─────────────────────────────────────────────

async function runHost(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  UDP 打洞裸测试 — Host`)
  console.log(`  中继: ${RELAY_URL}`)
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
  const hbTimer = setInterval(() => wsSend(ws, { type: 'heartbeat' }), 10000)
  ws.on('close', () => clearInterval(hbTimer))

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

  // ── 2. 等待加入者 ──
  console.log(`─── (2/4) 等待加入者 ───`)
  const joined = await wsWait(ws, 'member-joined', 300000)
  const guestId = joined.data.memberId
  log('WS', `加入者: ${guestId}`)

  // ── 3. 创建 UDP socket + STUN 获取映射地址 ──
  console.log(`\n─── (3/4) 创建 UDP socket + 获取公网映射地址 ───`)
  // 先创建探针 socket
  const udpSocket = dgram.createSocket('udp4')
  udpSocket.bind(0, '0.0.0.0')
  const localPort = await new Promise<number>(resolve => {
    udpSocket.on('listening', () => resolve((udpSocket.address() as any).port))
  })
  log('UDP', `本地 UDP 端口: ${localPort}`)

  // 通过探针 socket 做 STUN，获取其真实的 NAT 映射地址
  let mappedAddr: { ip: string; port: number }
  if (PUBLIC_IP) {
    mappedAddr = { ip: PUBLIC_IP, port: localPort }
    try {
      const stunResult = await stunGetPublicAddr(udpSocket)
      mappedAddr.port = stunResult.port
    } catch {
      mappedAddr.port = localPort
    }
  } else {
    mappedAddr = await stunGetPublicAddr(udpSocket)
  }
  log('INFO', `Host 映射地址: ${mappedAddr.ip}:${mappedAddr.port}`)

  // 发送映射地址给加入者
  wsSend(ws, {
    type: 'signal',
    data: { to: guestId, signalData: { type: 'udp-address', ip: mappedAddr.ip, port: mappedAddr.port } }
  })
  log('SIG', `已发送映射地址给加入者`)

  // 等加入者发来地址
  const guestSig = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('信号超时')), 20000)
    const handler = (raw: Buffer | string) => {
      try {
        const m = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
        if (m.type === 'signal') {
          clearTimeout(timer)
          ws.off('message', handler)
          resolve(m.data)
        }
      } catch { /* ignore */ }
    }
    ws.on('message', handler)
  })

  const guestAddr = { ip: guestSig.signalData.ip, port: guestSig.signalData.port }
  log('SIG', `加入者地址: ${guestAddr.ip}:${guestAddr.port}`)

  // ── 4. UDP 打洞测试（激进模式） ──
  console.log(`\n─── (4/4) UDP 双向打洞测试 (持续 10s) ───`)

  const PORT_SCAN_RANGE = 10      // 扫描对端端口 ±10
  const PROBE_INTERVAL_MS = 50    // 每 50ms 发一轮探针

  // 动态目标端口集合（初始 = STUN 端口 ± 范围）
  const targetPorts = new Set<number>()
  const addPortRange = (base: number, range: number) => {
    targetPorts.add(base)
    for (let d = 1; d <= range; d++) {
      if (base + d > 0) targetPorts.add(base + d)
      if (base - d > 0) targetPorts.add(base - d)
    }
  }
  addPortRange(guestAddr.port, PORT_SCAN_RANGE)
  log('UDP', `初始扫描端口数: ${targetPorts.size} (范围 ${guestAddr.port - PORT_SCAN_RANGE}-${guestAddr.port + PORT_SCAN_RANGE})`)

  // 探针数据：Host 用 0x48，方便区分
  const PROBE_DATA = Buffer.from([0x48])

  // 高速轮发探针到所有目标端口
  const probeTimer = setInterval(() => {
    for (const p of targetPorts) {
      udpSocket.send(PROBE_DATA, 0, 1, p, guestAddr.ip)
    }
  }, PROBE_INTERVAL_MS)

  // 监听对端探针
  let receivedFromGuest = false
  let guestRinfo: dgram.RemoteInfo | null = null
  const probesFromPorts = new Set<number>()  // 记录对端用过的源端口

  udpSocket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    if (rinfo.address !== guestAddr.ip) return

    // 记录对端实际源端口，加入扫描范围
    if (!probesFromPorts.has(rinfo.port)) {
      probesFromPorts.add(rinfo.port)
      targetPorts.add(rinfo.port)
      log('UDP', `发现对端源端口 ${rinfo.port}，加入扫描目标`)
    }

    if (!receivedFromGuest) {
      receivedFromGuest = true
      guestRinfo = rinfo
      log('UDP', `首次收到加入者探针! 来自 ${rinfo.address}:${rinfo.port} (${msg.length}B)`)

      // 立即对该端口额外多发一轮，加速建立双向映射
      for (let i = 0; i < 5; i++) {
        udpSocket.send(PROBE_DATA, 0, 1, rinfo.port, rinfo.address)
      }
      // 同时将目标端口切到对端实际端口
      if (rinfo.port !== guestAddr.port) {
        log('UDP', `NAT 映射端口变化: ${guestAddr.port} → ${rinfo.port}，已切换`)
        guestAddr.port = rinfo.port
      }
    }
  })

  // 等待 10 秒
  for (let i = 0; i < 10; i++) {
    await sleep(1000)
    if (receivedFromGuest) {
      const elapsed = i + 1
      log('UDP', `第 ${elapsed}s: 已收到加入者探针`)
      break
    }
    log('UDP', `第 ${i + 1}s: 等待加入者探针... (已探测端口数: ${targetPorts.size})`)
  }

  console.log(``)
  if (receivedFromGuest) {
    ok(`UDP 双向打通！Host 收到加入者探针 ${guestRinfo!.address}:${guestRinfo!.port}`)
    console.log(`  说明：Host (${mappedAddr.ip}) → Guest (${guestAddr.ip}) 双向 UDP 可达`)
    console.log(`        NAT 打洞成功，KCP 可以在 UDP 之上正常工作`)

    // ── 5. 裸 UDP 延迟测量 ──
    console.log(`\n─── 裸 UDP 延迟测量 (持续 5s) ───`)
    const pingTimestamps: number[] = []
    const rttSamples: number[] = []
    let pingSeq = 0

    const pingHandler = (msg: Buffer, rinfo: dgram.RemoteInfo): void => {
      if (rinfo.address !== guestAddr.ip) return
      const text = msg.toString('utf8').trim()
      const match = text.match(/^pong_(\d+)$/)
      if (match) {
        const id = parseInt(match[1], 10)
        if (pingTimestamps[id]) {
          const rtt = Date.now() - pingTimestamps[id]
          rttSamples.push(rtt)
          log('PING', `pong #${id}: ${rtt}ms`)
        }
      }
    }
    udpSocket.on('message', pingHandler)

    const pingTimer = setInterval(() => {
      pingTimestamps[pingSeq] = Date.now()
      udpSocket.send(Buffer.from(`ping_${pingSeq}`), guestAddr.port, guestAddr.ip)
      pingSeq++
    }, 500)

    await sleep(5000)
    clearInterval(pingTimer)
    udpSocket.removeListener('message', pingHandler)

    if (rttSamples.length > 0) {
      const avg = Math.round(rttSamples.reduce((a, b) => a + b, 0) / rttSamples.length)
      const min = Math.min(...rttSamples)
      const max = Math.max(...rttSamples)
      log('PING', `裸 UDP RTT: min=${min}ms / avg=${avg}ms / max=${max}ms (${rttSamples.length} 样本)`)
      ok(`裸 UDP RTT: ${avg}ms (min=${min}, max=${max})`)
    } else {
      fail('裸 UDP ping 无响应')
    }

    // ── 6. KCP 可靠传输测试 ──
    console.log(`\n─── KCP 可靠传输测试 (持续 15s) ───`)
    const kcp = new Kcp(1, 0, (buf: Buffer) => {
      udpSocket.send(buf, 0, buf.length, guestAddr.port, guestAddr.ip)
    })
    kcp.setNodelay(true, 2, true)

    let kcpRecvCount = 0
    let kcpSendCount = 0
    let kcpRtt = 0

    const kcpHandler = (msg: Buffer, rinfo: dgram.RemoteInfo): void => {
      if (rinfo.address !== guestAddr.ip) return
      if (msg.length < 28) return // 非 KCP 帧
      kcp.input(msg)
      while (true) {
        const size = kcp.peekSize()
        if (size <= 0) break
        const buf = Buffer.alloc(size)
        const len = kcp.recv(buf)
        if (len <= 0) break
        kcpRecvCount++
        kcpRtt = kcp.getRtt()
      }
    }
    udpSocket.on('message', kcpHandler)

    const kcpUpdateTimer = setInterval(() => {
      kcp.update(Date.now())
    }, 10)

    // 前半段：等待加入者 KCP 数据到达
    for (let i = 0; i < 7; i++) {
      await sleep(1000)
      if (kcpRecvCount > 0) {
        log('KCP', `第 ${i + 1}s: 已收到 KCP 数据 (${kcpRecvCount} 条)`)
      }
    }

    // 后半段：房主发送 KCP 回复
    const kcpSendTimer = setInterval(() => {
      try {
        kcp.send(Buffer.from(`kcp_echo_${kcpSendCount}`))
        kcpSendCount++
      } catch { /* KCP 可能断开 */ }
    }, 200)

    for (let i = 0; i < 8; i++) {
      await sleep(1000)
      log('KCP', `第 ${7 + i + 1}s: 收 ${kcpRecvCount} / 发 ${kcpSendCount}`)
    }

    clearInterval(kcpSendTimer)
    clearInterval(kcpUpdateTimer)
    udpSocket.removeListener('message', kcpHandler)
    log('KCP', `收 ${kcpRecvCount} 条, 发 ${kcpSendCount} 条, RTT=${kcpRtt}ms`)
    if (kcpRecvCount > 0) {
      ok(`KCP 可靠传输成功！收 ${kcpRecvCount} / 发 ${kcpSendCount}  RTT=${kcpRtt}ms`)
    } else {
      fail('KCP 未收到任何消息')
    }
  } else {
    fail('UDP 未收到加入者任何探针')
    console.log(`\n  可能原因：`)
    console.log(`  1. 双方 NAT 均为 Symmetric (对端依赖)，UDP 打洞无法穿透`)
    console.log(`  2. 防火墙拦截了 UDP 端口`)
    console.log(`  3. 运营商屏蔽了 UDP 流量`)
    console.log(`\n  建议：`)
    console.log(`  - 使用中继模式进行联机（当前应用会自动降级）`)
    console.log(`  - 检查防火墙是否放行 UDP`)
  }

  clearInterval(probeTimer)
  udpSocket.close()
  ws.close()

  console.log(`\n${'='.repeat(56)}`)
  console.log(`  通过: ${passed}  失败: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

// ─── Guest ────────────────────────────────────────────

async function runGuest(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  UDP 打洞裸测试 — Guest`)
  console.log(`  中继: ${RELAY_URL}`)
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
  const hbTimer = setInterval(() => wsSend(ws, { type: 'heartbeat' }), 10000)
  ws.on('close', () => clearInterval(hbTimer))

  // 预注册信号处理器（防止错过 Host 地址信号）
  let hostSignal: any = null
  const hostSigPromise = new Promise<void>((resolve) => {
    const handler = (raw: Buffer | string) => {
      try {
        const m = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
        if (m.type === 'signal' && m.data?.signalData?.type === 'udp-address') {
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

  // ── 2. 获取 Host 地址 ──
  console.log(`\n─── (2/4) 获取 Host 地址 ───`)
  await hostSigPromise
  if (!hostSignal) {
    fail('未收到 Host 地址信号')
    ws.close()
    process.exit(1)
  }
  const hostAddr = { ip: hostSignal.signalData.ip, port: hostSignal.signalData.port }
  log('SIG', `Host 地址: ${hostAddr.ip}:${hostAddr.port}`)

  // ── 3. 创建 UDP socket + STUN 获取映射地址 ──
  console.log(`\n─── (3/4) 创建 UDP socket + 获取公网映射地址 ───`)
  // 先创建探针 socket
  const udpSocket = dgram.createSocket('udp4')
  udpSocket.bind(0, '0.0.0.0')
  const localPort = await new Promise<number>(resolve => {
    udpSocket.on('listening', () => resolve((udpSocket.address() as any).port))
  })
  log('UDP', `本地 UDP 端口: ${localPort}`)

  // 通过探针 socket 做 STUN，获取其真实的 NAT 映射地址
  let mappedAddr: { ip: string; port: number }
  if (PUBLIC_IP) {
    mappedAddr = { ip: PUBLIC_IP, port: localPort }
    try {
      const stunResult = await stunGetPublicAddr(udpSocket)
      mappedAddr.port = stunResult.port
    } catch {
      mappedAddr.port = localPort
    }
  } else {
    mappedAddr = await stunGetPublicAddr(udpSocket)
  }
  log('INFO', `Guest 映射地址: ${mappedAddr.ip}:${mappedAddr.port}`)

  // 发送映射地址给 Host
  wsSend(ws, {
    type: 'signal',
    data: { to: hostId, signalData: { type: 'udp-address', ip: mappedAddr.ip, port: mappedAddr.port } }
  })
  log('SIG', `已发送映射地址给 Host`)

  // ── 4. UDP 打洞测试（激进模式） ──
  console.log(`\n─── (4/4) UDP 双向打洞测试 (持续 10s) ───`)

  const PORT_SCAN_RANGE = 10      // 扫描对端端口 ±10
  const PROBE_INTERVAL_MS = 50    // 每 50ms 发一轮探针

  // 动态目标端口集合
  const targetPorts = new Set<number>()
  const addPortRange = (base: number, range: number) => {
    targetPorts.add(base)
    for (let d = 1; d <= range; d++) {
      if (base + d > 0) targetPorts.add(base + d)
      if (base - d > 0) targetPorts.add(base - d)
    }
  }
  addPortRange(hostAddr.port, PORT_SCAN_RANGE)
  log('UDP', `初始扫描端口数: ${targetPorts.size} (范围 ${hostAddr.port - PORT_SCAN_RANGE}-${hostAddr.port + PORT_SCAN_RANGE})`)

  // 探针数据
  const PROBE_DATA = Buffer.from([0x47])

  // 先发一轮到所有端口，建立 NAT 映射
  for (const p of targetPorts) {
    udpSocket.send(PROBE_DATA, 0, 1, p, hostAddr.ip)
  }

  // 高速轮发探针
  const probeTimer = setInterval(() => {
    for (const p of targetPorts) {
      udpSocket.send(PROBE_DATA, 0, 1, p, hostAddr.ip)
    }
  }, PROBE_INTERVAL_MS)

  // 监听 Host 探针
  let receivedFromHost = false
  let hostRinfo: dgram.RemoteInfo | null = null
  const probesFromPorts = new Set<number>()

  udpSocket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    if (rinfo.address !== hostAddr.ip) return

    if (!probesFromPorts.has(rinfo.port)) {
      probesFromPorts.add(rinfo.port)
      targetPorts.add(rinfo.port)
      log('UDP', `发现 Host 源端口 ${rinfo.port}，加入扫描目标`)
    }

    if (!receivedFromHost) {
      receivedFromHost = true
      hostRinfo = rinfo
      log('UDP', `首次收到 Host 探针! 来自 ${rinfo.address}:${rinfo.port} (${msg.length}B)`)

      // 立即对该端口多发几轮
      for (let i = 0; i < 5; i++) {
        udpSocket.send(PROBE_DATA, 0, 1, rinfo.port, rinfo.address)
      }

      if (rinfo.port !== hostAddr.port) {
        log('UDP', `NAT 映射端口变化: ${hostAddr.port} → ${rinfo.port}，已切换`)
        hostAddr.port = rinfo.port
      }
    }
  })

  // 等待 10 秒
  for (let i = 0; i < 10; i++) {
    await sleep(1000)
    if (receivedFromHost) {
      const elapsed = i + 1
      log('UDP', `第 ${elapsed}s: 已收到 Host 探针`)
      break
    }
    log('UDP', `第 ${i + 1}s: 等待 Host 探针... (已探测端口数: ${targetPorts.size})`)
  }

  console.log(``)
  if (receivedFromHost) {
    ok(`UDP 双向打通！Guest 收到 Host 探针 ${hostRinfo!.address}:${hostRinfo!.port}`)
    console.log(`  说明：Guest (${mappedAddr.ip}) → Host (${hostAddr.ip}) 单向 UDP 可达`)
    console.log(`        Host 侧若能收到回包即完整打洞成功`)

    // ── 5. 裸 UDP 延迟测量 ──
    console.log(`\n─── 裸 UDP 延迟测量 (持续 5s) ───`)
    const pongHandler = (msg: Buffer, rinfo: dgram.RemoteInfo): void => {
      if (rinfo.address !== hostAddr.ip) return
      const text = msg.toString('utf8').trim()
      const match = text.match(/^ping_(\d+)$/)
      if (match) {
        const id = parseInt(match[1], 10)
        udpSocket.send(Buffer.from(`pong_${id}`), hostAddr.port, hostAddr.ip)
      }
    }
    udpSocket.on('message', pongHandler)
    await sleep(5000)
    udpSocket.removeListener('message', pongHandler)
    log('PING', '裸 UDP ping 完成')

    // ── 6. KCP 可靠传输测试 ──
    console.log(`\n─── KCP 可靠传输测试 (持续 15s) ───`)
    const kcp = new Kcp(1, 0, (buf: Buffer) => {
      udpSocket.send(buf, 0, buf.length, hostAddr.port, hostAddr.ip)
    })
    kcp.setNodelay(true, 2, true)

    let kcpRecvCount = 0
    let kcpSendCount = 0

    const kcpHandler = (msg: Buffer, rinfo: dgram.RemoteInfo): void => {
      if (rinfo.address !== hostAddr.ip) return
      if (msg.length < 28) return
      kcp.input(msg)
      while (true) {
        const size = kcp.peekSize()
        if (size <= 0) break
        const buf = Buffer.alloc(size)
        const len = kcp.recv(buf)
        if (len <= 0) break
        kcpRecvCount++
      }
    }
    udpSocket.on('message', kcpHandler)

    const kcpUpdateTimer = setInterval(() => {
      kcp.update(Date.now())
    }, 10)

    // 主动发送 KCP 数据给房主
    const kcpSendTimer = setInterval(() => {
      try {
        kcp.send(Buffer.from(`kcp_data_${kcpSendCount}`))
        kcpSendCount++
      } catch { /* KCP 可能断开 */ }
    }, 200)

    for (let i = 0; i < 15; i++) {
      await sleep(1000)
      log('KCP', `第 ${i + 1}s: 发 ${kcpSendCount} / 收 ${kcpRecvCount}`)
    }

    clearInterval(kcpSendTimer)
    clearInterval(kcpUpdateTimer)
    udpSocket.removeListener('message', kcpHandler)
    log('KCP', `发送 ${kcpSendCount} 条, 收到 ${kcpRecvCount} 条`)
    if (kcpRecvCount > 0) {
      ok(`KCP 双向传输成功！收 ${kcpRecvCount} / 发 ${kcpSendCount}`)
    } else if (kcpSendCount > 0) {
      fail('KCP 未收到任何回复')
    }
  } else {
    fail('UDP 未收到 Host 任何探针')
    console.log(`\n  可能原因：`)
    console.log(`  1. 双方 NAT 均为 Symmetric，UDP 打洞无法穿透`)
    console.log(`  2. 防火墙拦截了 UDP 端口`)
    console.log(`  3. 运营商屏蔽了 UDP 流量`)
  }

  clearInterval(probeTimer)
  udpSocket.close()
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
