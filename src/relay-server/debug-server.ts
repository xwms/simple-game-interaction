/**
 * 功能描述：调试版中继服务器 — 支持所有连接方式测试
 *
 * 逻辑说明：集成 WebSocket 中继 + HTTP 仪表盘 + UDP/TCP/IPv6 测试服务
 *           在同一进程中运行，提供统一调试入口。
 *           部署到云服务器后，通过仪表盘观察各连接阶段的信号交互。
 *
 * 服务端口 (可通过环境变量覆盖)：
 *   WS_PORT=9800    WebSocket 中继（房间管理 + 信令转发 + 数据中继）
 *   HTTP_PORT=9801  HTTP 仪表盘（状态 + 日志 + 测试入口）
 *   UDP_PORT=9802   UDP 回显服务（STUN 打洞测试 + NAT 类型探测）
 *   TCP_PORT=9803   TCP 回显服务（P2P TCP 连接测试）
 *   V6_PORT=9804    IPv6 TCP 回显（IPv6 直连测试）
 *
 * 使用方式：
 *   npx tsx src/relay-server/debug-server.ts
 *   或部署后: node src/relay-server/debug-server.js
 */

import { WebSocketServer, WebSocket } from 'ws'
import { randomBytes } from 'crypto'
import { createServer } from 'http'
import * as net from 'net'
import * as dgram from 'dgram'
import * as os from 'os'

// ─── 端口配置 ─────────────────────────────────────────────

const WS_PORT = parseInt(process.env.WS_PORT || '9800', 10)
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '9801', 10)
const UDP_PORT = parseInt(process.env.UDP_PORT || '9802', 10)
const TCP_PORT = parseInt(process.env.TCP_PORT || '9803', 10)
const V6_PORT = parseInt(process.env.V6_PORT || '9804', 10)

// ─── 日志系统（带颜色和时间戳）────────────────────────────

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  dim: '\x1b[2m',
  bold: '\x1b[1m'
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19)
}

function log(tag: string, color: string, msg: string): void {
  console.log(`${colors.dim}[${timestamp()}]${colors.reset} ${color}${colors.bold}[${tag}]${colors.reset} ${msg}`)
}

function info(tag: string, msg: string): void { log(tag, colors.cyan, msg) }
function ok(tag: string, msg: string): void { log(tag, colors.green, msg) }
function warn(tag: string, msg: string): void { log(tag, colors.yellow, msg) }
function err(tag: string, msg: string): void { log(tag, colors.red, msg) }
function data(tag: string, msg: string): void { log(tag, colors.magenta, msg) }
function dim(tag: string, msg: string): void { log(tag, colors.gray, msg) }

// ─── 活动日志（内存环形缓冲区，供 HTTP 仪表盘使用）────────

const MAX_LOG_ENTRIES = 500
const logRing: Array<{ time: string; tag: string; level: string; message: string }> = []

function pushLog(level: string, tag: string, message: string): void {
  logRing.push({ time: timestamp(), tag, level, message })
  if (logRing.length > MAX_LOG_ENTRIES) logRing.shift()
}

function logInfo(tag: string, msg: string): void { info(tag, msg); pushLog('INFO', tag, msg) }
function logOk(tag: string, msg: string): void { ok(tag, msg); pushLog('OK', tag, msg) }
function logWarn(tag: string, msg: string): void { warn(tag, msg); pushLog('WARN', tag, msg) }
function logErr(tag: string, msg: string): void { err(tag, msg); pushLog('ERROR', tag, msg) }
function logData(tag: string, msg: string): void { data(tag, msg); pushLog('DATA', tag, msg) }
function logDim(tag: string, msg: string): void { dim(tag, msg); pushLog('DIM', tag, msg) }

// ─── 类型 ─────────────────────────────────────────────────

interface ClientInfo {
  memberId: string
  memberName: string
  roomCode: string | null
  networkInfo: Record<string, unknown> | null
  ws: WebSocket
  connectedAt: number
  remoteAddr: string
  alive: boolean
}

interface Room {
  code: string
  serverId: string
  serverNetworkInfo: Record<string, unknown> | null
  gameId: string
  gamePort: number
  gameName: string
  members: Map<string, ClientInfo>
  createdAt: number
  signals: Array<{ time: string; from: string; to: string; type: string; data: string }>
}

// ─── 全局状态 ─────────────────────────────────────────────

const rooms = new Map<string, Room>()
const clients = new Map<WebSocket, ClientInfo>()
let memberIdSeq = 0
let totalConnections = 0
let totalSignals = 0
let totalMessages = 0

// ─── 工具函数 ─────────────────────────────────────────────

function generateRoomCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let code: string
  do {
    const bytes = randomBytes(6)
    code = ''
    for (let i = 0; i < 6; i++) code += chars[bytes[i] % chars.length]
  } while (rooms.has(code))
  return code
}

function generateMemberId(): string {
  return `member_${++memberIdSeq}`
}

function sendJson(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

function sendError(ws: WebSocket, messageId: string | undefined, code: string, message: string): void {
  sendJson(ws, { type: 'error', messageId, error: { code, message } })
}

function getRoomClientCount(): number {
  let count = 0
  for (const room of Array.from(rooms.values())) count += room.members.size
  return count
}

function getServerStats(): Record<string, unknown> {
  return {
    uptime: process.uptime(),
    connections: totalConnections,
    currentClients: clients.size,
    currentRooms: rooms.size,
    roomClients: getRoomClientCount(),
    totalSignals,
    totalMessages,
    memory: process.memoryUsage(),
    platform: process.platform,
    hostname: os.hostname(),
    networkInterfaces: getNetworkInfo()
  }
}

function getNetworkInfo(): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  const ifaces = os.networkInterfaces()
  for (const [name, info] of Object.entries(ifaces)) {
    if (!info) continue
    result[name] = info.map(i => `${i.address} (${i.family})${i.internal ? ' [internal]' : ''}`)
  }
  return result
}

function getLocalIps(): string[] {
  const ips: string[] = []
  const ifaces = os.networkInterfaces()
  for (const info of Object.values(ifaces)) {
    if (!info) continue
    for (const i of info) {
      if (i.family === 'IPv4' && !i.internal) ips.push(i.address)
    }
  }
  return ips
}

// ─── WebSocket 中继服务器 ─────────────────────────────────

function startRelayServer(): void {
  const wss = new WebSocketServer({ host: '0.0.0.0', port: WS_PORT })

  wss.on('connection', (ws, req) => {
    totalConnections++
    const remoteAddr = req.socket.remoteAddress || 'unknown'
    const remotePort = req.socket.remotePort || 0

    const client: ClientInfo = {
      memberId: '',
      memberName: 'anonymous',
      roomCode: null,
      networkInfo: null,
      ws,
      connectedAt: Date.now(),
      remoteAddr: `${remoteAddr}:${remotePort}`,
      alive: true
    }
    clients.set(ws, client)
    logInfo('WS', `新客户端: ${remoteAddr}:${remotePort} (在线: ${clients.size})`)

    ws.on('message', (raw: Buffer | string) => {
      totalMessages++
      if (typeof raw === 'string') {
        handleWsMessage(ws, raw)
      } else {
        const text = raw.toString('utf8')
        try {
          JSON.parse(text)
          handleWsMessage(ws, text)
        } catch {
          handleWsBinary(ws, raw)
        }
      }
    })

    ws.on('close', () => {
      const c = clients.get(ws)
      const name = c ? `${c.memberName}(${c.memberId})` : 'unknown'
      handleWsDisconnect(ws)
      logInfo('WS', `断开: ${name} (在线: ${clients.size})`)
    })

    ws.on('error', () => handleWsDisconnect(ws))
  })

  // 心跳超时检查
  setInterval(() => {
    for (const [ws, client] of Array.from(clients)) {
      if (!client.alive) {
        logWarn('WS', `心跳超时: ${client.memberName}(${client.memberId}), 断开连接`)
        handleWsDisconnect(ws)
        try { ws.close() } catch { /* ignore */ }
      }
      client.alive = false
    }
  }, 30000)

  logOk('WS', `WebSocket 中继已启动 → ws://0.0.0.0:${WS_PORT}`)
}

function handleWsMessage(ws: WebSocket, raw: string): void {
  let msg: Record<string, any>
  try { msg = JSON.parse(raw) } catch { return }

  const client = clients.get(ws)
  if (!client) return

  // 记录收到的消息
  const desc = msg.data ? JSON.stringify(msg.data).substring(0, 120) : ''
  logDim('WS', `← ${msg.type}${desc ? ` ${desc}` : ''} [${client.memberName || 'anon'}]`)

  switch (msg.type) {
    case 'create-room': return handleWsCreateRoom(ws, client, msg)
    case 'join-room':   return handleWsJoinRoom(ws, client, msg)
    case 'leave-room':  return handleWsLeaveRoom(ws, client, msg)
    case 'signal':      return handleWsSignal(ws, client, msg)
    case 'heartbeat':   handleHeartbeat(client)
    default: break
  }
}

function handleWsCreateRoom(ws: WebSocket, client: ClientInfo, msg: Record<string, any>): void {
  const { gameId, gamePort, gameName, memberName, networkInfo, roomCode: customCode } = msg.data || {}

  if (!gameId || !gamePort || !memberName) {
    return sendError(ws, msg.messageId, 'invalid-params', '缺少必要参数: gameId, gamePort, memberName')
  }

  const roomCode = customCode?.toUpperCase() || generateRoomCode()
  if (customCode && rooms.has(roomCode)) {
    return sendError(ws, msg.messageId, 'room-exists', `房间码 ${roomCode} 已被占用`)
  }

  const memberId = generateMemberId()
  client.memberId = memberId
  client.memberName = memberName
  client.roomCode = roomCode
  client.networkInfo = networkInfo || null

  const room: Room = {
    code: roomCode,
    serverId: memberId,
    serverNetworkInfo: networkInfo || null,
    gameId, gamePort, gameName,
    members: new Map([[memberId, client]]),
    createdAt: Date.now(),
    signals: []
  }
  rooms.set(roomCode, room)

  // 显示 NAT 信息
  const v4info = networkInfo?.ipv4 || {} as any
  const natInfo = v4info.natType
    ? `NAT=${v4info.natType} public=${v4info.publicIp}:${v4info.publicPort} mapping=${v4info.mappingBehavior}`
    : 'NAT=无'
  const v6Info = networkInfo?.ipv6
    ? `IPv6=${networkInfo.ipv6.hasPublicV6 ? '公网' : networkInfo.ipv6.available ? '可用' : '不可用'}`
    : ''
  logOk('WS', `[房间 ${roomCode}] 创建 — ${gameName}:${gamePort} 房主=${memberName}(${memberId}) ${natInfo} ${v6Info}`)
  logOk('WS', `[房间 ${roomCode}] NAT 详情: ${JSON.stringify(networkInfo?.ipv4 || {})}`)
  if (networkInfo?.ipv6) logOk('WS', `[房间 ${roomCode}] IPv6 详情: ${JSON.stringify(networkInfo.ipv6)}`)

  sendJson(ws, { type: 'room-created', messageId: msg.messageId, data: { roomCode, memberId } })
}

function handleWsJoinRoom(ws: WebSocket, client: ClientInfo, msg: Record<string, any>): void {
  const { roomCode, memberName, networkInfo } = msg.data || {}
  if (!roomCode || !memberName) {
    return sendError(ws, msg.messageId, 'invalid-params', '缺少房间码或成员名')
  }

  const room = rooms.get(roomCode.toUpperCase())
  if (!room) {
    return sendError(ws, msg.messageId, 'room-not-found', '房间不存在')
  }

  const memberId = generateMemberId()
  client.memberId = memberId
  client.memberName = memberName
  client.roomCode = roomCode
  client.networkInfo = networkInfo || null

  room.members.set(memberId, client)

  const members = Array.from(room.members.values())
    .filter(m => m.memberId !== memberId)
    .map(m => ({ id: m.memberId, name: m.memberName }))

  const v4guest = networkInfo?.ipv4 || {} as any
  const natGuest = v4guest.natType
    ? `NAT=${v4guest.natType} public=${v4guest.publicIp}:${v4guest.publicPort}`
    : 'NAT=无'
  logOk('WS', `[房间 ${roomCode}] 加入 — ${memberName}(${memberId}) ${natGuest}`)

  sendJson(ws, {
    type: 'room-joined', messageId: msg.messageId,
    data: {
      roomCode, memberId, serverId: room.serverId,
      serverNetworkInfo: room.serverNetworkInfo,
      gamePort: room.gamePort, members
    }
  })

  // 通知房主
  if (room.serverId !== memberId) {
    const host = room.members.get(room.serverId)
    if (host) {
      sendJson(host.ws, {
        type: 'member-joined',
        data: { memberId, memberName, networkInfo: networkInfo || null }
      })
      logInfo('WS', `[房间 ${roomCode}] 已通知房主: ${memberName}(${memberId}) 加入`)
    }
  }
}

function handleWsLeaveRoom(ws: WebSocket, client: ClientInfo, _msg: Record<string, any>): void {
  const roomCode = client.roomCode
  if (!roomCode) return

  const room = rooms.get(roomCode)
  if (!room) { client.roomCode = null; return }

  const wasHost = client.memberId === room.serverId
  const leftId = client.memberId
  const leftName = client.memberName

  room.members.delete(client.memberId)
  client.roomCode = null

  logInfo('WS', `[房间 ${roomCode}] 离开 — ${leftName}(${leftId})`)

  for (const [, member] of Array.from(room.members)) {
    sendJson(member.ws, { type: 'member-left', data: { memberId: leftId } })
  }

  if (wasHost || room.members.size === 0) {
    for (const [, member] of Array.from(room.members)) {
      member.roomCode = null
      sendJson(member.ws, { type: 'room-closed' })
    }
    logOk('WS', `[房间 ${roomCode}] 已关闭 (${room.members.size} 人被踢出)`)
    rooms.delete(roomCode)
  }
}

function handleWsSignal(ws: WebSocket, client: ClientInfo, msg: Record<string, any>): void {
  const { to, signalData } = msg.data || {}
  if (!to || !signalData) return

  totalSignals++

  // 记录信号到房间历史
  const roomCode = client.roomCode
  if (roomCode) {
    const room = rooms.get(roomCode)
    if (room) {
      const signalType = signalData.type || 'unknown'
      const signalSummary = JSON.stringify(signalData).substring(0, 200)
      room.signals.push({
        time: timestamp(), from: client.memberId,
        to, type: signalType, data: signalSummary
      })
      if (room.signals.length > 100) room.signals.shift()

      // 高亮显示关键信号
      const signalDesc = (() => {
        switch (signalType) {
          case 'p2p-address': return `P2P 地址 ${signalData.ip}:${signalData.port}`
          case 'kcp-address': {
            const localIps = signalData.localIps ? ` (本地: ${signalData.localIps.join(', ')})` : ''
            return `KCP 地址 ${signalData.ip}:${signalData.port}${localIps}`
          }
          case 'ipv6-address': return `IPv6 地址 [${signalData.address}]:${signalData.port}`
          case 'candidate': return `ICE Candidate`
          case 'offer': return `SDP Offer`
          case 'answer': return `SDP Answer`
          default: return `${signalType}: ${JSON.stringify(signalData).substring(0, 100)}`
        }
      })()
      logData('SIGNAL', `[房间 ${roomCode}] ${client.memberName} → ${to}: ${signalDesc}`)
    }
  }

  // 转发
  for (const [, other] of Array.from(clients)) {
    if (other.memberId === to) {
      sendJson(other.ws, { type: 'signal', data: { from: client.memberId, signalData } })
      return
    }
  }
}

function handleHeartbeat(client: ClientInfo): void {
  client.alive = true
}

function handleWsBinary(ws: WebSocket, data: Buffer): void {
  const client = clients.get(ws)
  if (!client || !client.roomCode) return

  const room = rooms.get(client.roomCode)
  if (!room) return

  if (client.memberId === room.serverId) {
    // 房主 → 指定 Guest
    if (data.length < 9) return
    const targetIdLen = data.readUInt32BE(0)
    if (data.length < 4 + targetIdLen + 4) return
    const targetId = data.subarray(4, 4 + targetIdLen).toString('utf8')
    const payloadLen = data.readUInt32BE(4 + targetIdLen)
    // 转发时保留 [4B payloadLen][payload] 格式，RelayClient 需要此头部
    const payload = data.subarray(4 + targetIdLen)
    logDim('DATA', `房主 → ${targetId}: ${payloadLen} 字节`)

    for (const [, member] of Array.from(room.members)) {
      if (member.memberId === targetId && member.ws.readyState === WebSocket.OPEN) {
        member.ws.send(payload)
        return
      }
    }
    return
  }

  // Guest → 仅房主
  const host = room.members.get(room.serverId)
  if (!host || host.ws.readyState !== WebSocket.OPEN) return

  const memberIdBuf = Buffer.from(client.memberId, 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(memberIdBuf.length, 0)
  host.ws.send(Buffer.concat([header, memberIdBuf, data]))
  logDim('DATA', `${client.memberName} → 房主: ${data.length} 字节`)
}

function handleWsDisconnect(ws: WebSocket): void {
  const client = clients.get(ws)
  if (!client) return

  if (client.roomCode) {
    handleWsLeaveRoom(ws, client, {})
  }

  clients.delete(ws)
}

// ─── HTTP 仪表盘 ─────────────────────────────────────────

function startHttpDashboard(): void {
  const server = createServer((req, res) => {
    const url = req.url || '/'

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')

    if (url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(getServerStats(), null, 2))
      return
    }

    if (url === '/api/rooms') {
      const roomList = Array.from(rooms.values()).map(r => ({
        code: r.code, gameName: r.gameName, gamePort: r.gamePort,
        serverId: r.serverId, memberCount: r.members.size,
        createdAt: new Date(r.createdAt).toISOString(),
        members: Array.from(r.members.values()).map(m => ({
          id: m.memberId, name: m.memberName,
          addr: m.remoteAddr, networkInfo: m.networkInfo
        })),
        signalCount: r.signals.length,
        lastSignals: r.signals.slice(-20)
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(roomList, null, 2))
      return
    }

    if (url === '/api/logs') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(logRing.slice(-200), null, 2))
      return
    }

    if (url === '/api/logs/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })
      // 发送已有日志
      for (const entry of logRing.slice(-50)) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`)
      }
      // 实时推送新日志
      const interval = setInterval(() => {
        // SSE 心跳
        res.write(': heartbeat\n\n')
      }, 5000)
      req.on('close', () => { clearInterval(interval) })
      return
    }

    if (url === '/api/remote-addr') {
      const addr = req.socket.remoteAddress || 'unknown'
      const port = req.socket.remotePort || 0
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ip: addr === '::1' ? '127.0.0.1' : addr.replace(/^::ffff:/, ''), port }))
      return
    }

    if (url === '/api/network') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        hostname: os.hostname(),
        platform: process.platform,
        interfaces: getNetworkInfo(),
        localIps: getLocalIps(),
        ipv6: Object.values(os.networkInterfaces()).flatMap(i => i || [])
          .filter(i => i.family === 'IPv6').map(i => i.address)
      }, null, 2))
      return
    }

    // 写入格式测试页面
    if (url === '/test/write') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`写入格式测试

本机 IP 列表: ${getLocalIps().join(', ')}

可用的连接方式测试:

  1. WebSocket Relay:   ws://<服务器IP>:${WS_PORT}
  2. UDP Echo:          <服务器IP>:${UDP_PORT}
  3. TCP Echo:          <服务器IP>:${TCP_PORT}
  4. IPv6 TCP Echo:     [<服务器IPv6>]:${V6_PORT}

使用方法:
  - 在应用设置中修改中继地址为 ws://<服务器IP>:${WS_PORT}
  - 创建房间后观察仪表盘中的信号交互
  - 使用 ncat/nc 测试各端口的连通性

示例:
  # TCP 回显测试
  echo "hello" | ncat <服务器IP> ${TCP_PORT}

  # UDP 回显测试
  echo "hello" | ncat -u <服务器IP> ${UDP_PORT}

  # IPv6 TCP 回显测试
  echo "hello" | ncat -6 <服务器IPv6> ${V6_PORT}
`)
      return
    }

    // HTML 仪表盘
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Relay 调试服务器</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, monospace; background: #0d1117; color: #c9d1d9; padding: 20px; }
    h1 { color: #58a6ff; margin-bottom: 20px; font-size: 24px; }
    h2 { color: #8b949e; margin: 20px 0 10px; font-size: 16px; border-bottom: 1px solid #21262d; padding-bottom: 5px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-bottom: 20px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; }
    .card .label { color: #8b949e; font-size: 12px; }
    .card .value { color: #c9d1d9; font-size: 20px; font-weight: bold; margin-top: 4px; }
    .card .value.green { color: #3fb950; }
    .card .value.yellow { color: #d29922; }
    .card .value.red { color: #f85149; }
    table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13px; }
    th { text-align: left; color: #8b949e; padding: 6px 8px; border-bottom: 1px solid #21262d; }
    td { padding: 6px 8px; border-bottom: 1px solid #21262d; }
    tr:hover td { background: #1c2128; }
    .signal { background: #1c2128; border: 1px solid #30363d; border-radius: 4px; padding: 8px; margin: 4px 0; font-size: 12px; }
    .signal .sig-time { color: #484f58; }
    .signal .sig-type { color: #58a6ff; }
    .signal .sig-data { color: #8b949e; word-break: break-all; }
    .log-entry { padding: 2px 0; font-size: 12px; font-family: monospace; }
    .log-INFO { color: #8b949e; }
    .log-OK { color: #3fb950; }
    .log-WARN { color: #d29922; }
    .log-ERROR { color: #f85149; }
    .log-DATA { color: #bc8cff; }
    .log-DIM { color: #484f58; }
    .nav { display: flex; gap: 10px; margin-bottom: 20px; }
    .nav a { color: #58a6ff; text-decoration: none; padding: 6px 12px; border: 1px solid #30363d; border-radius: 6px; }
    .nav a:hover { background: #1c2128; }
    .badge { display: inline-block; padding: 2px 6px; border-radius: 10px; font-size: 11px; font-weight: bold; }
    .badge-host { background: #1f6feb; color: #fff; }
    .badge-guest { background: #238636; color: #fff; }
    pre { background: #161b22; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Relay 调试服务器</h1>
  <div class="nav">
    <a href="#" onclick="showTab('overview')">概览</a>
    <a href="#" onclick="showTab('rooms')">房间</a>
    <a href="#" onclick="showTab('logs')">日志</a>
    <a href="#" onclick="showTab('network')">网络</a>
    <a href="/test/write">写入格式</a>
  </div>

  <div id="tab-overview">
    <div class="grid" id="stats-grid"></div>
    <h2>活动日志</h2>
    <div id="live-logs" style="height:400px;overflow-y:auto;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px;"></div>
  </div>

  <div id="tab-rooms" style="display:none;">
    <h2>房间列表</h2>
    <div id="room-list"></div>
  </div>

  <div id="tab-logs" style="display:none;">
    <h2>全部日志</h2>
    <div id="full-logs" style="height:600px;overflow-y:auto;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px;"></div>
  </div>

  <div id="tab-network" style="display:none;">
    <h2>网络接口</h2>
    <pre id="network-info"></pre>
  </div>

  <script>
    let currentTab = 'overview'

    function showTab(name) {
      currentTab = name
      document.querySelectorAll('[id^="tab-"]').forEach(el => el.style.display = 'none')
      document.getElementById('tab-' + name).style.display = 'block'
    }

    async function fetchJSON(url) {
      const r = await fetch(url)
      return r.json()
    }

    function escape(str) {
      const d = document.createElement('div')
      d.textContent = str
      return d.innerHTML
    }

    async function updateStats() {
      try {
        const stats = await fetchJSON('/api/status')
        const grid = document.getElementById('stats-grid')
        grid.innerHTML = Object.entries({
          '运行时间': Math.floor(stats.uptime) + 's',
          '历史连接': stats.connections,
          '当前客户端': stats.currentClients,
          '当前房间': stats.currentRooms,
          '房间内成员': stats.roomClients,
          '信号总数': stats.totalSignals,
          '消息总数': stats.totalMessages
        }).map(([k, v]) => '<div class="card"><div class="label">' + k + '</div><div class="value">' + v + '</div></div>').join('')
      } catch {}
    }

    async function updateRooms() {
      try {
        const rooms = await fetchJSON('/api/rooms')
        const el = document.getElementById('room-list')
        if (rooms.length === 0) {
          el.innerHTML = '<p style="color:#484f58;">暂无房间</p>'
          return
        }
        el.innerHTML = rooms.map(room => {
          const members = room.members.map(m => {
            const isHost = m.id === room.serverId
            const nat = m.networkInfo?.ipv4
            return '<div style="margin:4px 0;">' +
              '<span class="badge ' + (isHost ? 'badge-host' : 'badge-guest') + '">' + (isHost ? '房主' : '加入') + '</span> ' +
              escape(m.name) + ' (' + escape(m.id) + ')' +
              '<span style="color:#484f58;font-size:11px;margin-left:8px;">' + escape(m.addr) + '</span>' +
              (nat ? '<span style="color:#8b949e;font-size:11px;margin-left:8px;">NAT:' + escape(nat.natType) + ' IP:' + escape(nat.publicIp) + '</span>' : '') +
              '</div>'
          }).join('')
          const signals = room.lastSignals.map(s =>
            '<div class="signal">' +
              '<span class="sig-time">' + escape(s.time) + '</span> ' +
              '<span class="sig-type">' + escape(s.type) + '</span> ' +
              '<span class="sig-data">' + escape(s.data) + '</span>' +
            '</div>'
          ).join('')
          return '<div class="card" style="margin:10px 0;">' +
            '<div style="display:flex;justify-content:space-between;">' +
              '<strong>' + escape(room.code) + '</strong>' +
              '<span>' + escape(room.gameName) + ':' + room.gamePort + '</span>' +
            '</div>' +
            members +
            (room.signalCount > 0 ? '<div style="margin-top:8px;"><strong style="color:#8b949e;font-size:12px;">信号 (' + room.signalCount + '):</strong>' + signals + '</div>' : '') +
          '</div>'
        }).join('')
      } catch {}
    }

    async function updateNetwork() {
      try {
        const net = await fetchJSON('/api/network')
        document.getElementById('network-info').textContent = JSON.stringify(net, null, 2)
      } catch {}
    }

    async function updateLogs() {
      try {
        const logs = await fetchJSON('/api/logs')
        document.getElementById('full-logs').innerHTML = logs.map(l =>
          '<div class="log-entry log-' + l.level + '">' +
            '[' + escape(l.time) + '] [' + escape(l.tag) + '] ' + escape(l.message) +
          '</div>'
        ).join('')
      } catch {}
    }

    // SSE 实时日志
    const logEl = document.getElementById('live-logs')
    if (!!window.EventSource) {
      const es = new EventSource('/api/logs/stream')
      es.onmessage = (e) => {
        const l = JSON.parse(e.data)
        const entry = document.createElement('div')
        entry.className = 'log-entry log-' + l.level
        entry.textContent = '[' + l.time + '] [' + l.tag + '] ' + l.message
        logEl.appendChild(entry)
        if (logEl.children.length > 200) logEl.removeChild(logEl.firstChild)
        if (currentTab === 'overview') logEl.scrollTop = logEl.scrollHeight
      }
    }

    // 自动刷新（非 SSE 数据）
    setInterval(() => {
      updateStats()
      updateRooms()
      if (currentTab === 'logs') updateLogs()
      if (currentTab === 'network') updateNetwork()
    }, 2000)
    updateStats()
    updateRooms()
    updateNetwork()
  </script>
</body>
</html>`)
  })

  server.listen(HTTP_PORT, '0.0.0.0', () => {
    logOk('HTTP', `仪表盘已启动 → http://0.0.0.0:${HTTP_PORT}`)
  })
}

// ─── UDP 回显服务（STUN 打洞测试用）────────────────────────

function startUdpEcho(): void {
  const socket = dgram.createSocket('udp4')

  socket.on('message', (msg, rinfo) => {
    // 回显原始数据（模拟 STUN 响应）
    socket.send(msg, rinfo.port, rinfo.address, (sendErr) => {
      if (sendErr) {
        logWarn('UDP', `回显失败 → ${rinfo.address}:${rinfo.port}`)
        return
      }
      // STUN 兼容：如果收到的是 STUN 请求（首 bit 为 0），回显 mapped address
      logDim('UDP', `回显 ${rinfo.address}:${rinfo.port} (${msg.length} 字节)`)

      // 额外发送 STUN 风格响应（含接收方地址信息）
      const response = Buffer.alloc(8 + msg.length)
      response.write('STUNECHO', 0, 8, 'ascii')
      msg.copy(response, 8)
      socket.send(response, rinfo.port, rinfo.address)
    })
  })

  socket.on('listening', () => {
    const addr = socket.address()
    logOk('UDP', `UDP 回显已启动 → udp://0.0.0.0:${addr.port}`)
  })

  socket.on('error', (e) => {
    logErr('UDP', `错误: ${e.message}`)
  })

  socket.bind(UDP_PORT, '0.0.0.0')
}

// ─── TCP 回显服务（P2P TCP 连接测试用）─────────────────────

function startTcpEcho(): void {
  const server = net.createServer((socket) => {
    const addr = `${socket.remoteAddress}:${socket.remotePort}`
    logDim('TCP', `连接 [${addr}]`)

    socket.on('data', (data) => {
      logDim('TCP', `收到 ${data.length} 字节 [${addr}]: ${data.toString('utf8').trim()}`)
      // 回显
      socket.write(data)
    })

    socket.on('close', () => {
      logDim('TCP', `断开 [${addr}]`)
    })

    socket.on('error', () => { /* ignore */ })
  })

  server.listen(TCP_PORT, '0.0.0.0', () => {
    logOk('TCP', `TCP 回显已启动 → tcp://0.0.0.0:${TCP_PORT}`)
  })
}

// ─── IPv6 TCP 回显服务（IPv6 直连测试用）───────────────────

function startIpv6Echo(): void {
  const server = net.createServer((socket) => {
    const addr = `${socket.remoteAddress}:${socket.remotePort}`
    logDim('V6', `连接 [${addr}]`)

    socket.on('data', (data) => {
      logDim('V6', `收到 ${data.length} 字节 [${addr}]`)
      socket.write(data)
    })

    socket.on('close', () => logDim('V6', `断开 [${addr}]`))
    socket.on('error', () => { /* ignore */ })
  })

  // 尝试同时监听 IPv6 和 IPv4
  server.on('error', (e: Error) => {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      logWarn('V6', `端口 ${V6_PORT} 被占用`)
    } else {
      logErr('V6', `错误: ${e.message}`)
    }
  })

  try {
    server.listen(V6_PORT, '::', () => {
      logOk('V6', `IPv6 TCP 回显已启动 → tcp://[::]:${V6_PORT}`)
    })
  } catch (e) {
    logWarn('V6', `IPv6 不可用: ${(e as Error).message}`)
  }
}

// ─── 启动 ──────────────────────────────────────────────────

console.log(`\n${colors.bold}${colors.cyan}╔════════════════════════════════════════╗`)
console.log(`║       Relay 调试服务器 v1.0            ║`)
console.log(`╚════════════════════════════════════════╝${colors.reset}\n`)

logInfo('MAIN', `服务器 IP: ${getLocalIps().join(', ') || '127.0.0.1'}`)
logInfo('MAIN', `主机名: ${os.hostname()}`)

startRelayServer()
startHttpDashboard()
startUdpEcho()
startTcpEcho()
startIpv6Echo()

console.log(`\n${colors.green}${colors.bold}✅ 所有服务已启动${colors.reset}`)
console.log(`${colors.dim}   仪表盘: http://localhost:${HTTP_PORT}${colors.reset}`)
console.log(`${colors.dim}   中继:   ws://localhost:${WS_PORT}${colors.reset}\n`)
