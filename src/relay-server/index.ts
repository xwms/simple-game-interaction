/**
 * 功能描述：简化版 Relay 中继服务器 — 用于开发调试
 *
 * 逻辑说明：WebSocket 服务器，管理房间和成员状态，
 *           转发控制消息（JSON）和二进制数据帧。
 *           所有数据在内存中，无需数据库。
 *           与 RelayClient 的协议完全兼容。
 *
 * 使用方式：npx tsx src/relay-server/index.ts
 *           默认监听 ws://0.0.0.0:9800
 *           可通过 PORT 环境变量修改端口
 *
 * 协议文档：docs/技术文档.md 5.7 节
 */

import { WebSocketServer, WebSocket } from 'ws'
import { randomBytes } from 'crypto'
import { execSync } from 'child_process'

const PORT = parseInt(process.env.PORT || '9800', 10)

// ─── 类型 ─────────────────────────────────────────────

/** 客户端信息 */
interface ClientInfo {
  memberId: string
  memberName: string
  roomCode: string | null
  networkInfo: unknown | null
  ws: WebSocket
}

/** 房间信息 */
interface Room {
  code: string
  serverId: string
  serverNetworkInfo: unknown | null
  gameId: string
  gamePort: number
  gameName: string
  members: Map<string, ClientInfo>
  createdAt: number
}

// ─── 全局状态 ─────────────────────────────────────────

const rooms = new Map<string, Room>()
const clients = new Map<WebSocket, ClientInfo>()
let memberIdSeq = 0

// ─── 工具函数 ─────────────────────────────────────────

/**
 * 功能描述：生成 6 位房间码（大写字母 + 数字）
 *
 * 逻辑说明：检查碰撞，确保唯一性。
 *
 * @returns 6 位房间码
 */
function generateRoomCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let code: string
  do {
    const bytes = randomBytes(6)
    code = ''
    for (let i = 0; i < 6; i++) {
      code += chars[bytes[i] % chars.length]
    }
  } while (rooms.has(code))
  return code
}

/**
 * 功能描述：生成成员 ID
 *
 * @returns 成员 ID
 */
function generateMemberId(): string {
  return `member_${++memberIdSeq}`
}

/**
 * 功能描述：发送 JSON 消息到客户端
 *
 * @param ws - 目标 WebSocket
 * @param data - 消息数据
 */
function sendJson(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

/**
 * 功能描述：发送错误响应
 *
 * @param ws - 目标 WebSocket
 * @param messageId - 对应请求的 messageId
 * @param code - 错误码
 * @param message - 错误描述
 */
function sendError(ws: WebSocket, messageId: string | undefined, code: string, message: string): void {
  sendJson(ws, {
    type: 'error',
    messageId,
    error: { code, message }
  })
}

// ─── 消息处理器 ───────────────────────────────────────

/**
 * 功能描述：处理收到的 JSON 文本消息
 *
 * 逻辑说明：按 type 分发到对应处理器。
 */
function handleMessage(ws: WebSocket, raw: string): void {
  let msg: Record<string, any>
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }

  const client = clients.get(ws)
  if (!client) return

  switch (msg.type) {
    case 'create-room':
      return handleCreateRoom(ws, client, msg)
    case 'join-room':
      return handleJoinRoom(ws, client, msg)
    case 'leave-room':
      return handleLeaveRoom(ws, client, msg)
    case 'signal':
      return handleSignal(ws, client, msg)
    case 'heartbeat':
      return handleHeartbeat(client)
    default:
      break
  }
}

/**
 * 功能描述：处理房间创建
 *
 * 逻辑说明：验证参数 → 生成房间码 → 创建房间 → 返回 room-created。
 *           创建者自动成为房主。
 */
function handleCreateRoom(ws: WebSocket, client: ClientInfo, msg: Record<string, any>): void {
  const { gameId, gamePort, gameName, memberName, networkInfo, roomCode: customCode } = msg.data || {}

  if (!gameId || !gamePort || !memberName) {
    return sendError(ws, msg.messageId, 'invalid-params', '缺少必要参数: gameId, gamePort, memberName')
  }

  // 支持固定房间码：传入则使用，冲突则报错
  if (customCode) {
    const code = customCode.toUpperCase()
    if (rooms.has(code)) {
      return sendError(ws, msg.messageId, 'room-exists', `房间码 ${code} 已被占用`)
    }
    var roomCode = code
  } else {
    var roomCode = generateRoomCode()
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
    gameId,
    gamePort,
    gameName,
    members: new Map([[memberId, client]]),
    createdAt: Date.now()
  }

  rooms.set(roomCode, room)
  console.log(`[房间 ${roomCode}] 已创建 — ${gameName}:${gamePort}，房主: ${memberName}(${memberId})`)

  sendJson(ws, {
    type: 'room-created',
    messageId: msg.messageId,
    data: { roomCode, memberId }
  })
}

/**
 * 功能描述：处理加入房间
 *
 * 逻辑说明：查找房间 → 添加成员 → 回复加入者 → 通知房主。
 */
function handleJoinRoom(ws: WebSocket, client: ClientInfo, msg: Record<string, any>): void {
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

  // 收集当前成员列表（排除自己）
  const members = Array.from(room.members.values())
    .filter(m => m.memberId !== memberId)
    .map(m => ({ id: m.memberId, name: m.memberName }))

  console.log(`[房间 ${roomCode}] ${memberName}(${memberId}) 已加入，当前 ${room.members.size} 人`)

  // 回复加入者
  sendJson(ws, {
    type: 'room-joined',
    messageId: msg.messageId,
    data: {
      roomCode,
      memberId,
      serverId: room.serverId,
      serverNetworkInfo: room.serverNetworkInfo,
      gamePort: room.gamePort,
      members
    }
  })

  // 通知房主有新成员（除非房主就是加入者）
  if (room.serverId !== memberId) {
    const host = room.members.get(room.serverId)
    if (host) {
      sendJson(host.ws, {
        type: 'member-joined',
        data: { memberId, memberName, networkInfo: networkInfo || null }
      })
    }
  }
}

/**
 * 功能描述：处理离开房间
 *
 * 逻辑说明：从房间移除成员 → 通知其他成员 → 房主离开或房间为空则关闭房间。
 */
function handleLeaveRoom(_ws: WebSocket, client: ClientInfo, _msg: Record<string, any>): void {
  const roomCode = client.roomCode
  if (!roomCode) return

  const room = rooms.get(roomCode)
  if (!room) {
    client.roomCode = null
    return
  }

  const wasHost = client.memberId === room.serverId
  const leftMemberId = client.memberId
  const leftMemberName = client.memberName

  room.members.delete(client.memberId)
  client.roomCode = null

  console.log(`[房间 ${roomCode}] ${leftMemberName}(${leftMemberId}) 离开`)

  // 通知其他成员
  for (const [, member] of room.members) {
    sendJson(member.ws, {
      type: 'member-left',
      data: { memberId: leftMemberId }
    })
  }

  // 房主离开或房间空了 → 关闭房间
  if (wasHost || room.members.size === 0) {
    for (const [, member] of room.members) {
      member.roomCode = null
      sendJson(member.ws, { type: 'room-closed' })
    }
    rooms.delete(roomCode)
    console.log(`[房间 ${roomCode}] 已关闭`)
  }
}

/**
 * 功能描述：处理 P2P 信令中转
 *
 * 逻辑说明：查找目标成员 → 转发 signal 消息。
 */
function handleSignal(_ws: WebSocket, client: ClientInfo, msg: Record<string, any>): void {
  const { to, signalData } = msg.data || {}
  if (!to || !signalData) return

  for (const [, other] of clients) {
    if (other.memberId === to) {
      sendJson(other.ws, {
        type: 'signal',
        data: { from: client.memberId, signalData }
      })
      return
    }
  }
}

/**
 * 功能描述：处理心跳
 *
 * 逻辑说明：标记客户端存活，不做响应。
 */
function handleHeartbeat(client: ClientInfo): void {
  client.alive = true
}

// ─── 二进制数据转发 ───────────────────────────────────

/**
 * 功能描述：转发二进制数据帧
 *
 * 逻辑说明：
 *   Guest → Host: 包裹 sourceMemberId 前缀后仅转发给房主
 *   Host → Guest: 从帧头解析 targetMemberId 转发给指定 Guest
 *   帧格式: [4B memberIdLen UInt32BE][memberId UTF8][payload]
 *   不再广播给其他 Guest，避免数据交织导致解码错误。
 */
function handleBinary(ws: WebSocket, data: Buffer): void {
  const client = clients.get(ws)
  if (!client || !client.roomCode) return

  const room = rooms.get(client.roomCode)
  if (!room) return

  if (client.memberId === room.serverId) {
    // 房主 → 指定 Guest
    if (data.length < 5) return
    const targetIdLen = data.readUInt32BE(0)
    if (data.length < 4 + targetIdLen) return
    const targetId = data.subarray(4, 4 + targetIdLen).toString('utf8')
    const payload = data.subarray(4 + targetIdLen)

    for (const [, member] of room.members) {
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
}

// ─── 连接管理 ─────────────────────────────────────────

/**
 * 功能描述：处理客户端断开连接
 *
 * 逻辑说明：从房间中移除 → 通知其他成员 → 清理状态。
 */
function handleDisconnect(ws: WebSocket): void {
  const client = clients.get(ws)
  if (!client) return

  // 如果客户端在房间中，先离开房间
  if (client.roomCode) {
    handleLeaveRoom(ws, client, {})
  }

  clients.delete(ws)
  console.log(`客户端 ${client.memberName}(${client.memberId}) 已断开`)
}

/**
 * 功能描述：检查超时客户端
 *
 * 逻辑说明：遍历所有客户端，关闭 30 秒未发送心跳的连接。
 */
function checkTimeout(intervalMs: number = 30000): void {
  const interval = setInterval(() => {
    const now = Date.now()
    for (const [ws, client] of clients) {
      if (!client.alive) {
        console.log(`客户端 ${client.memberName}(${client.memberId}) 心跳超时，断开连接`)
        handleDisconnect(ws)
        ws.close()
      }
      // 重置，等待下一次检查
      client.alive = false
    }

    // 清理过期房间（24 小时无活动）
    for (const [code, room] of rooms) {
      if (now - room.createdAt > 24 * 60 * 60 * 1000) {
        for (const [, member] of room.members) {
          member.roomCode = null
          sendJson(member.ws, { type: 'room-closed' })
        }
        rooms.delete(code)
        console.log(`[房间 ${code}] 已过期关闭`)
      }
    }
  }, intervalMs)
}

// ─── 服务器启动 ───────────────────────────────────────

/**
 * 功能描述：检查端口是否被占用，是则杀掉对应进程
 *
 * 逻辑说明：跨平台实现 — Windows 用 netstat + taskkill，
 *           Linux/macOS 用 lsof + kill。
 *           跳过自身进程防止误杀。
 *
 * @param port - 要检查的端口号
 */
function ensurePortFree(port: number): void {
  try {
    let pid: number | null = null

    if (process.platform === 'win32') {
      const output = execSync(
        `netstat -ano | findstr ":${port} "`,
        { encoding: 'utf8', timeout: 3000 }
      )
      for (const line of output.trim().split('\n')) {
        if (line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/)
          const found = parseInt(parts[parts.length - 1], 10)
          if (!isNaN(found)) { pid = found; break }
        }
      }
    } else {
      const output = execSync(
        `lsof -ti:${port} 2>/dev/null`,
        { encoding: 'utf8', timeout: 3000 }
      )
      const firstLine = output.trim().split('\n')[0]
      if (firstLine) {
        const found = parseInt(firstLine, 10)
        if (!isNaN(found)) pid = found
      }
    }

    if (pid !== null && pid !== process.pid) {
      const killCmd = process.platform === 'win32'
        ? `taskkill /F /PID ${pid}`
        : `kill -9 ${pid}`
      execSync(killCmd, { timeout: 3000 })
      console.log(`已释放端口 ${port}（终止进程 ${pid}）`)
    }
  } catch {
    // findstr 没找到匹配、lsof 无输出等均视为端口空闲
  }
}

/**
 * 功能描述：启动 WebSocket 服务器
 *
 * 逻辑说明：创建 ws.WebSocketServer，绑定连接/消息/关闭事件。
 */
function start(): void {
  ensurePortFree(PORT)
  const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT })

  wss.on('connection', (ws) => {
    // 注册新客户端
    const client: ClientInfo = {
      memberId: '',
      memberName: 'anonymous',
      roomCode: null,
      networkInfo: null,
      alive: true,
      ws
    }
    clients.set(ws, client)

    console.log(`新客户端连接，当前在线: ${clients.size}`)

    ws.on('message', (data: Buffer | string) => {
      if (typeof data === 'string') {
        handleMessage(ws, data)
      } else if (Buffer.isBuffer(data)) {
        // ws v8 可能将文本帧以 Buffer 形式送达
        // 尝试解析为 JSON，失败则作为二进制数据转发
        const text = data.toString('utf8')
        try {
          JSON.parse(text)  // 验证是否为 JSON
          handleMessage(ws, text)
        } catch {
          handleBinary(ws, data)
        }
      }
    })

    ws.on('close', () => {
      handleDisconnect(ws)
    })

    ws.on('error', () => {
      handleDisconnect(ws)
    })
  })

  // 启动心跳超时检查
  checkTimeout()

  console.log(`\n  Relay 中继服务器已启动`)
  console.log(`  地址: ws://localhost:${PORT}`)
  console.log(`  进程: ${process.pid}\n`)
}

start()
