/**
 * 功能描述：WebSocket 中继服务器主类
 *
 * 逻辑说明：管理 WebSocket 连接生命周期，处理 JSON 控制消息和二进制数据帧转发。
 *          消息路由严格按 `RelayClient` 实现（src/core/tunnel/relay-client.ts）处理，
 *          不参考旧版文档格式。
 *
 * 依赖：../types (RELAY_MESSAGE_TYPES, RelayConfig, ClientInfo, Room)
 *       ../utils (generateRoomCode, generateMemberId, sendJson, sendError 等)
 *       ../store/types (Store)
 */

import fs from 'fs'
import https from 'https'
import { WebSocketServer } from 'ws'
import WebSocket from 'ws'
import type { IncomingMessage } from 'http'
import type { Store } from './store/types'
import type { RelayConfig, ClientInfo, Room } from './types'
import {
  generateRoomCode,
  generateMemberId,
  sendJson,
  sendError,
  nowISO,
  isValidRoomCode
} from './utils'
import { RELAY_MESSAGE_TYPES, BINARY_FRAME_HEADER_SIZE } from './types'

/** 连接运行态元数据 */
interface ConnectionState {
  id: string
  memberId: string
  memberName: string
  roomCode: string | null
  memberIndex: number
  ip: string
  connectedAt: number
  lastActivity: number
  alive: boolean
  messageCount: number
  byteCount: number
}

/** 令牌桶本地缓存（比 Store 存取更快） */
interface LocalBucket {
  tokens: number
  lastRefill: number
}

export class RelayServer {
  private _wss: WebSocketServer | null = null
  private readonly _store: Store
  private readonly _config: RelayConfig
  private readonly _connections = new Map<WebSocket, ConnectionState>()
  private readonly _memberWs = new Map<string, WebSocket>()
  private _connSeq = 0
  private _startTime = 0
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null
  // 每连接令牌桶缓存（key=connectionId）
  private readonly _buckets = new Map<string, LocalBucket>()

  constructor(store: Store, config: RelayConfig) {
    this._store = store
    this._config = config
  }

  // ─── 生命周期 ─────────────────────────────────────────

  /**
   * 功能描述：启动中继服务器
   *
   * 逻辑说明：创建 WebSocketServer，注册 connection 处理器，启动心跳和清理定时器。
   *           Tls 配置存在时自动创建 WSS（WebSocket Secure）。
   */
  async start(): Promise<void> {
    if (this._wss) throw new Error('RelayServer already started')

    if (this._config.tlsCert && this._config.tlsKey) {
      const server = https.createServer({
        cert: fs.readFileSync(this._config.tlsCert),
        key: fs.readFileSync(this._config.tlsKey)
      })
      this._wss = new WebSocketServer({ server })
      server.listen(this._config.port, this._config.host)
    } else {
      this._wss = new WebSocketServer({
        host: this._config.host,
        port: this._config.port,
        maxPayload: this._config.maxFrameSize
      })
    }

    this._wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this._onConnection(ws, req)
    })

    this._startTime = Date.now()

    this._heartbeatTimer = setInterval(() => this._checkHeartbeats(), 5000)
    this._cleanupTimer = setInterval(() => this._cleanup(), 30000)

    console.log(JSON.stringify({
      time: nowISO(), level: 'info', module: 'server',
      msg: `Relay server started on ${this._config.host}:${this._config.port}`
    }))
  }

  /**
   * 功能描述：优雅关闭服务器
   *
   * 逻辑说明：停止接受新连接 → 通知所有房间成员 → 等待处理中请求 → 关闭所有连接。
   */
  async stop(): Promise<void> {
    console.log(JSON.stringify({
      time: nowISO(), level: 'info', module: 'server',
      msg: 'Shutting down relay server...'
    }))

    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer)
      this._cleanupTimer = null
    }

    // 通知所有房间的成员
    const rooms = await this._store.listRooms()
    for (const room of rooms) {
      for (const [, member] of room.members) {
        const ws = this._memberWs.get(member.memberId)
        if (ws && ws.readyState === WebSocket.OPEN) {
          sendJson(ws, { type: RELAY_MESSAGE_TYPES.ROOM_CLOSED })
        }
      }
    }

    // 关闭所有连接
    for (const [ws] of this._connections) {
      try { ws.close() } catch { /* ignore */ }
    }
    this._connections.clear()
    this._memberWs.clear()
    this._buckets.clear()

    await this._store.clear()

    if (this._wss) {
      this._wss.close()
      this._wss = null
    }

    console.log(JSON.stringify({
      time: nowISO(), level: 'info', module: 'server',
      msg: 'Relay server stopped'
    }))
  }

  // ─── 公开状态 ─────────────────────────────────────────

  /** 服务器启动时长（秒） */
  get uptime(): number {
    return this._startTime ? Math.floor((Date.now() - this._startTime) / 1000) : 0
  }

  /** 当前连接数 */
  get connectionCount(): number {
    return this._connections.size
  }

  /** 服务器是否正在运行 */
  get running(): boolean {
    return this._wss !== null
  }

  // ─── 连接处理 ─────────────────────────────────────────

  /**
   * 功能描述：处理新 WebSocket 连接
   *
   * 逻辑说明：检查连接数限制（全局/IP），创建连接状态，注册事件处理器，
   *           启动握手超时（指定时间内未发消息则断开）。
   *
   * @param ws - WebSocket 实例
   * @param req - HTTP 请求对象
   */
  private _onConnection(ws: WebSocket, req: IncomingMessage): void {
    const ip = this._parseIp(req)

    // 全局连接数检查
    if (this._connections.size >= this._config.maxClients) {
      ws.close(1013, 'Server full')
      console.log(JSON.stringify({
        time: nowISO(), level: 'warn', module: 'server',
        msg: 'Connection rejected: max clients reached', ip
      }))
      return
    }

    // 每 IP 连接数检查
    let ipCount = 0
    for (const [, state] of this._connections) {
      if (state.ip === ip) ipCount++
    }
    if (ipCount >= this._config.maxPerIp) {
      ws.close(1013, 'Too many connections from this IP')
      console.log(JSON.stringify({
        time: nowISO(), level: 'warn', module: 'server',
        msg: 'Connection rejected: IP limit reached', ip
      }))
      return
    }

    const connId = `conn_${++this._connSeq}`
    const state: ConnectionState = {
      id: connId,
      memberId: '',
      memberName: '',
      roomCode: null,
      memberIndex: -1,
      ip,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      alive: true,
      messageCount: 0,
      byteCount: 0
    }
    this._connections.set(ws, state)

    // 每连接令牌桶初始化
    this._buckets.set(connId, {
      tokens: this._config.msgRate,
      lastRefill: Date.now()
    })

    ws.on('message', (raw: Buffer | string) => { this._onMessage(ws, raw) })
    ws.on('close', () => { this._onDisconnect(ws) })
    ws.on('error', () => { /* close 事件会随后触发 */ })

    // 握手超时 — 在指定时间内未分配 memberId 则断开
    setTimeout(() => {
      const s = this._connections.get(ws)
      if (s && !s.memberId) {
        console.log(JSON.stringify({
          time: nowISO(), level: 'warn', module: 'server',
          msg: 'Handshake timeout, closing connection', ip
        }))
        ws.close()
      }
    }, this._config.handshakeTimeout)

    console.log(JSON.stringify({
      time: nowISO(), level: 'info', module: 'server',
      msg: 'Client connected', ip, connId
    }))
  }

  /**
   * 功能描述：处理 WebSocket 消息
   *
   * 逻辑说明：区分二进制帧和数据帧。文本帧解析 JSON 后按 type 路由。
   *           所有消息先经过限流检查。超限消息被静默丢弃。
   *
   * @param ws - 来源 WebSocket
   * @param raw - 原始消息数据
   */
  private _onMessage(ws: WebSocket, raw: Buffer | string): void {
    const state = this._connections.get(ws)
    if (!state) return

    // 限流检查（每连接每秒消息数）
    if (!this._consumeToken(state.id)) return

    state.lastActivity = Date.now()
    state.alive = true

    // 文本（JSON）或二进制
    if (typeof raw === 'string') {
      this._handleText(ws, state, raw)
    } else {
      // ws 包在 Windows 下也可能以 Buffer 交付文本帧
      if (raw.length > this._config.maxFrameSize) {
        console.log(JSON.stringify({
          time: nowISO(), level: 'warn', module: 'server',
          msg: 'Frame too large, closing', bytes: raw.length, ip: state.ip
        }))
        ws.close(1009, 'Frame too large')
        return
      }

      const text = raw.toString('utf8')
      try {
        JSON.parse(text)
        this._handleText(ws, state, text)
      } catch {
        this._handleBinary(ws, state, raw)
      }
    }
  }

  /**
   * 功能描述：处理 JSON 文本消息
   *
   * @param ws - 来源 WebSocket
   * @param state - 连接状态
   * @param text - JSON 字符串
   */
  private _handleText(ws: WebSocket, state: ConnectionState, text: string): void {
    // 消息大小检查
    if (text.length > this._config.maxMessageSize) {
      ws.close(1009, 'Message too large')
      return
    }

    let msg: { type: string; messageId?: string; data?: Record<string, unknown> }
    try {
      msg = JSON.parse(text)
    } catch {
      sendError(ws, undefined, 'invalid-params', 'Invalid JSON')
      return
    }

    if (!msg.type || typeof msg.type !== 'string') {
      sendError(ws, msg.messageId, 'invalid-params', 'Missing message type')
      return
    }

    state.messageCount++

    switch (msg.type) {
      case RELAY_MESSAGE_TYPES.CREATE_ROOM:
        this._handleCreateRoom(ws, state, msg).catch(err => {
          console.log(JSON.stringify({
            time: nowISO(), level: 'error', module: 'room',
            msg: 'Create room error', error: (err as Error).message
          }))
          sendError(ws, msg.messageId, 'internal-error', (err as Error).message)
        })
        break
      case RELAY_MESSAGE_TYPES.JOIN_ROOM:
        this._handleJoinRoom(ws, state, msg).catch(err => {
          console.log(JSON.stringify({
            time: nowISO(), level: 'error', module: 'room',
            msg: 'Join room error', error: (err as Error).message
          }))
          sendError(ws, msg.messageId, 'internal-error', (err as Error).message)
        })
        break
      case RELAY_MESSAGE_TYPES.LEAVE_ROOM:
        this._handleLeaveRoom(ws, state).catch(() => { /* 已由断开清理 */ })
        break
      case RELAY_MESSAGE_TYPES.HEARTBEAT:
        this._handleHeartbeat(ws, state)
        break
      case RELAY_MESSAGE_TYPES.SIGNAL:
        this._handleSignal(ws, state, msg).catch(err => {
          console.log(JSON.stringify({
            time: nowISO(), level: 'error', module: 'signal',
            msg: 'Signal error', error: (err as Error).message
          }))
        })
        break
      case RELAY_MESSAGE_TYPES.RELAY_DATA:
        // relay-data over JSON is not used, but silently ignore
        break
      default:
        sendError(ws, msg.messageId, 'invalid-params', `Unknown message type: ${msg.type}`)
    }
  }

  /**
   * 功能描述：处理二进制数据帧
   *
   * 逻辑说明：
   *   Guest→Server：payload 格式 [4B payloadLen][payload]
   *     服务器读取 payload 后转发给 Host，格式为 [4B sourceIdLen][sourceId][4B payloadLen][payload]
   *   Host→Server：payload 格式 [4B targetIdLen][targetId][4B payloadLen][payload]
   *     服务器读取 targetId 后转发给对应 Guest，格式为 [payload]（去掉所有前缀）
   *
   * @param ws - 来源 WebSocket
   * @param state - 连接状态
   * @param buf - 二进制数据
   */
  private _handleBinary(ws: WebSocket, state: ConnectionState, buf: Buffer): void {
    if (!state.roomCode || !state.memberId) return

    const isHost = state.memberIndex === 0

    if (isHost) {
      // Host→Guest：[4B targetIdLen][targetId][4B payloadLen][payload]
      if (buf.length < 8) return
      const targetIdLen = buf.readUInt32BE(0)
      if (buf.length < 4 + targetIdLen + 4) return
      const targetId = buf.subarray(4, 4 + targetIdLen).toString('utf8')
      const payloadLen = buf.readUInt32BE(4 + targetIdLen)
      const payload = buf.subarray(4 + targetIdLen + 4, 4 + targetIdLen + 4 + payloadLen)

      // 转发给目标 Guest（去掉所有前缀，只发送原始 payload）
      const targetWs = this._memberWs.get(targetId)
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(payload)
        state.byteCount += payload.length
      }
    } else {
      // Guest→Host：[4B payloadLen][payload]
      if (buf.length < BINARY_FRAME_HEADER_SIZE) return
      const payloadLen = buf.readUInt32BE(0)
      const payload = buf.subarray(BINARY_FRAME_HEADER_SIZE, BINARY_FRAME_HEADER_SIZE + payloadLen)

      // 查找房间内 Host（memberIndex === 0）
      const room = this._store.getRoom(state.roomCode) // synchronous for MemoryStore
      // We need a sync approach here since binary forwarding must be fast
      // Use the memberWs map to find the host
      // Actually we need to look up the room's host memberId first
      this._forwardToHost(state.roomCode, state.memberId, payload).catch(() => {})
    }
  }

  /**
   * 功能描述：转发 Guest 数据到房间 Host
   *
   * 逻辑说明：查询房间内的 Host 成员（memberIndex===0），
   *           将数据以 [4B sourceIdLen][sourceId][4B payloadLen][payload] 格式发送。
   *
   * @param roomCode - 房间码
   * @param sourceMemberId - 来源成员 ID
   * @param payload - 数据负载
   */
  private async _forwardToHost(
    roomCode: string,
    sourceMemberId: string,
    payload: Buffer
  ): Promise<void> {
    const room = await this._store.getRoom(roomCode)
    if (!room) return

    for (const [, member] of room.members) {
      if (member.memberIndex === 0) {
        const hostWs = this._memberWs.get(member.memberId)
        if (hostWs && hostWs.readyState === WebSocket.OPEN) {
          // 格式：[4B sourceIdLen][sourceId][4B payloadLen][payload]
          const sourceIdBuf = Buffer.from(sourceMemberId, 'utf8')
          const idHeader = Buffer.alloc(4)
          idHeader.writeUInt32BE(sourceIdBuf.length, 0)
          const payloadHeader = Buffer.alloc(BINARY_FRAME_HEADER_SIZE)
          payloadHeader.writeUInt32BE(payload.length, 0)
          const frame = Buffer.concat([idHeader, sourceIdBuf, payloadHeader, payload])
          hostWs.send(frame)
        }
        return
      }
    }
  }

  // ─── 消息处理 ─────────────────────────────────────────

  /**
   * 功能描述：处理创建房间请求
   *
   * 逻辑说明：检查创建频率限制，生成唯一房间码，创建 Room 对象，
   *           将请求者设为 Host（memberIndex=0）。
   *           注意：data 内的 gameId/gamePort/gameName/memberName/networkInfo 均为客户端提供。
   *
   * @param ws - 请求者 WebSocket
   * @param state - 请求者连接状态
   * @param msg - 解析后的消息对象
   */
  private async _handleCreateRoom(
    ws: WebSocket,
    state: ConnectionState,
    msg: { type: string; messageId?: string; data?: Record<string, unknown> }
  ): Promise<void> {
    const data = msg.data ?? {}

    // 如果已加入房间，拒绝
    if (state.roomCode) {
      sendError(ws, msg.messageId, 'invalid-params', 'Already in a room')
      return
    }

    // 校验参数
    const gameId = String(data.gameId ?? '')
    const gameName = String(data.gameName ?? '')
    const gamePort = Number(data.gamePort) || 0
    const memberName = String(data.memberName ?? '')

    if (!gameId) {
      sendError(ws, msg.messageId, 'invalid-params', 'Missing gameId')
      return
    }

    // 房间创建频率检查
    if (!await this._checkRoomCreateRate(state.ip)) {
      sendError(ws, msg.messageId, 'rate-limited', 'Room creation rate limit exceeded (5/min)')
      return
    }

    // 检查最大房间数
    const roomCount = await this._store.getRoomCount()
    if (roomCount >= this._config.maxRooms) {
      sendError(ws, msg.messageId, 'room-limit-reached', 'Server room limit reached')
      return
    }

    // 生成唯一房间码
    const roomCode = await this._generateUniqueRoomCode()

    const memberId = generateMemberId()
    const now = Date.now()
    const clientInfo: ClientInfo = {
      memberId,
      memberName: memberName || `Player_${memberId}`,
      roomCode,
      memberIndex: 0,
      networkInfo: (data.networkInfo as Record<string, unknown>) ?? null,
      ws,
      ip: state.ip,
      connectedAt: now,
      alive: true,
      messageCount: 0,
      byteCount: 0,
      errorCount: 0
    }

    const room: Room = {
      code: roomCode,
      serverId: memberId,
      serverNetworkInfo: (data.networkInfo as Record<string, unknown>) ?? null,
      gameId,
      gamePort,
      gameName,
      members: new Map([[memberId, clientInfo]]),
      createdAt: now,
      lastActivityAt: now
    }

    await this._store.createRoom(room)

    // 更新连接状态
    state.memberId = memberId
    state.memberName = memberName
    state.roomCode = roomCode
    state.memberIndex = 0
    this._memberWs.set(memberId, ws)

    sendJson(ws, {
      type: RELAY_MESSAGE_TYPES.ROOM_CREATED,
      messageId: msg.messageId,
      data: { roomCode, memberId }
    })

    console.log(JSON.stringify({
      time: nowISO(), level: 'info', module: 'room',
      msg: 'Room created', code: roomCode, gameId, memberId
    }))
  }

  /**
   * 功能描述：处理加入房间请求
   *
   * 逻辑说明：校验房间码、房间存在、房间未满，然后分配 memberId，
   *           返回房间信息（含房主 networkInfo），广播 member-joined 给其他成员。
   *
   * @param ws - 请求者 WebSocket
   * @param state - 请求者连接状态
   * @param msg - 解析后的消息对象
   */
  private async _handleJoinRoom(
    ws: WebSocket,
    state: ConnectionState,
    msg: { type: string; messageId?: string; data?: Record<string, unknown> }
  ): Promise<void> {
    const data = msg.data ?? {}

    if (state.roomCode) {
      sendError(ws, msg.messageId, 'invalid-params', 'Already in a room')
      return
    }

    const roomCode = String(data.roomCode ?? '')

    if (!isValidRoomCode(roomCode)) {
      sendError(ws, msg.messageId, 'invalid-params', 'Invalid room code')
      return
    }

    const room = await this._store.getRoom(roomCode)
    if (!room) {
      sendError(ws, msg.messageId, 'room-not-found', 'Room not found')
      return
    }

    if (room.members.size >= this._config.maxMembers) {
      sendError(ws, msg.messageId, 'room-full', 'Room is full')
      return
    }

    const memberName = String(data.memberName ?? '')
    const memberId = generateMemberId()
    const now = Date.now()
    const clientInfo: ClientInfo = {
      memberId,
      memberName: memberName || `Player_${memberId}`,
      roomCode,
      memberIndex: room.members.size,
      networkInfo: (data.networkInfo as Record<string, unknown>) ?? null,
      ws,
      ip: state.ip,
      connectedAt: now,
      alive: true,
      messageCount: 0,
      byteCount: 0,
      errorCount: 0
    }

    await this._store.addMember(roomCode, clientInfo)

    // 更新连接状态
    state.memberId = memberId
    state.memberName = memberName
    state.roomCode = roomCode
    state.memberIndex = clientInfo.memberIndex
    this._memberWs.set(memberId, ws)

    // 构造成员列表
    const membersList: Array<{ id: string; name: string }> = []
    for (const [, m] of room.members) {
      membersList.push({ id: m.memberId, name: m.memberName })
      if (m.memberId === memberId) continue // 排除自己
    }
    // 从 room（未更新前的 snapshot）中构造——但 addMember 已更新 room.members
    // 重新从 store 获取最新列表
    const updatedMembers = await this._store.getMembers(roomCode)
    const allMembers = updatedMembers.map(m => ({ id: m.memberId, name: m.memberName }))

    // 查找房主信息（memberIndex === 0）
    const hostInfo = updatedMembers.find(m => m.memberIndex === 0)

    sendJson(ws, {
      type: RELAY_MESSAGE_TYPES.ROOM_JOINED,
      messageId: msg.messageId,
      data: {
        roomCode,
        memberId,
        serverId: hostInfo?.memberId ?? room.serverId,
        serverNetworkInfo: hostInfo?.networkInfo ?? room.serverNetworkInfo,
        gamePort: room.gamePort,
        members: allMembers
      }
    })

    // 广播 member-joined 给其他成员（不含刚加入者）
    for (const [, m] of room.members) {
      if (m.memberId === memberId) continue
      const memberWs = this._memberWs.get(m.memberId)
      if (memberWs && memberWs.readyState === WebSocket.OPEN) {
        sendJson(memberWs, {
          type: RELAY_MESSAGE_TYPES.MEMBER_JOINED,
          data: {
            memberId,
            memberName: clientInfo.memberName,
            memberIndex: clientInfo.memberIndex,
            networkInfo: clientInfo.networkInfo
          }
        })
      }
    }

    console.log(JSON.stringify({
      time: nowISO(), level: 'info', module: 'room',
      msg: 'Member joined', code: roomCode, memberId, memberName
    }))
  }

  /**
   * 功能描述：处理离开房间请求
   *
   * 逻辑说明：从房间移除成员，房主离开时关闭房间并通知所有人。
   *
   * @param ws - 请求者 WebSocket
   * @param state - 请求者连接状态
   */
  private async _handleLeaveRoom(ws: WebSocket, state: ConnectionState): Promise<void> {
    if (!state.roomCode || !state.memberId) return
    await this._removeMemberFromRoom(ws, state)
  }

  /**
   * 功能描述：处理心跳消息
   *
   * 逻辑说明：客户端心跳仅用于维持 TCP 连接活跃。服务器不发送响应。
   *
   * @param ws - 来源 WebSocket
   * @param state - 连接状态
   */
  private _handleHeartbeat(ws: WebSocket, state: ConnectionState): void {
    state.alive = true
    // 服务器不回复心跳 — 由客户端自行检测 TCP 发送成功
  }

  /**
   * 功能描述：处理 P2P 信令转发
   *
   * 逻辑说明：信令包含 SDP/ICE candidate 等 P2P 连接信息。
   *           服务器不解析信令内容，纯透传。
   *
   * @param ws - 来源 WebSocket
   * @param state - 来源连接状态
   * @param msg - 信令消息
   */
  private async _handleSignal(
    ws: WebSocket,
    state: ConnectionState,
    msg: { type: string; messageId?: string; data?: Record<string, unknown> }
  ): Promise<void> {
    const data = msg.data ?? {}
    const targetId = String(data.to ?? '')
    const signalData = data.signalData

    if (!targetId) {
      sendError(ws, msg.messageId, 'invalid-params', 'Missing target member ID')
      return
    }

    const targetWs = this._memberWs.get(targetId)
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
      sendJson(targetWs, {
        type: RELAY_MESSAGE_TYPES.SIGNAL,
        data: { from: state.memberId, signalData }
      })
    }
  }

  // ─── 断开处理 ─────────────────────────────────────────

  /**
   * 功能描述：处理 WebSocket 断开连接
   *
   * 逻辑说明：清理连接状态、成员房间关系、通知同房间其他成员。
   *
   * @param ws - 断开的 WebSocket
   */
  private _onDisconnect(ws: WebSocket): void {
    const state = this._connections.get(ws)
    if (!state) return

    // 从房间移除
    if (state.roomCode && state.memberId) {
      this._removeMemberFromRoom(ws, state).catch(() => { /* 忽略清理错误 */ })
    }

    // 清理运行时状态
    if (state.memberId) {
      this._memberWs.delete(state.memberId)
    }
    this._connections.delete(ws)
    this._buckets.delete(state.id)

    console.log(JSON.stringify({
      time: nowISO(), level: 'info', module: 'server',
      msg: 'Client disconnected', ip: state.ip, memberId: state.memberId || 'unauthed',
      messages: state.messageCount, bytes: state.byteCount
    }))
  }

  /**
   * 功能描述：将成员从房间移除，房主离开时关闭房间
   *
   * @param ws - 成员 WebSocket
   * @param state - 成员连接状态
   */
  private async _removeMemberFromRoom(ws: WebSocket, state: ConnectionState): Promise<void> {
    const { roomCode, memberId } = state
    if (!roomCode || !memberId) return

    const room = await this._store.getRoom(roomCode)
    if (!room) return

    const client = await this._store.removeMember(roomCode, memberId)
    if (!client) return

    const isHost = client.memberIndex === 0
    const remaining = await this._store.getMembers(roomCode)

    if (remaining.length === 0) {
      // 房间没人了，直接删除
      await this._store.deleteRoom(roomCode)
    } else if (isHost) {
      // 房主离开 — 关闭房间
      await this._store.deleteRoom(roomCode)
      for (const member of remaining) {
        const memberWs = this._memberWs.get(member.memberId)
        if (memberWs && memberWs.readyState === WebSocket.OPEN) {
          sendJson(memberWs, { type: RELAY_MESSAGE_TYPES.ROOM_CLOSED })
        }
      }
    } else {
      // 普通成员离开 — 通知其他成员
      for (const member of remaining) {
        if (member.memberId === memberId) continue
        const memberWs = this._memberWs.get(member.memberId)
        if (memberWs && memberWs.readyState === WebSocket.OPEN) {
          sendJson(memberWs, {
            type: RELAY_MESSAGE_TYPES.MEMBER_LEFT,
            data: { memberId }
          })
        }
      }
    }

    state.roomCode = null
  }

  // ─── 定时任务 ─────────────────────────────────────────

  /**
   * 功能描述：心跳超时检查
   *
   * 逻辑说明：遍历所有连接，超过 heartbeatTimeout 无活动的标记为 timeout 并断开。
   */
  private _checkHeartbeats(): void {
    const now = Date.now()
    const timeout = this._config.heartbeatTimeout

    for (const [ws, state] of this._connections) {
      if (now - state.lastActivity > timeout) {
        console.log(JSON.stringify({
          time: nowISO(), level: 'warn', module: 'heartbeat',
          msg: 'Heartbeat timeout, closing connection',
          memberId: state.memberId || 'unauthed', idle: now - state.lastActivity
        }))
        ws.close()
      }
    }
  }

  /**
   * 功能描述：房间清理和维护
   *
   * 逻辑说明：移除空闲房间（无成员且超过 roomIdleTimeout），
   *           移除超时房间（创建超过 24h），
   *           断开未加入房间的空闲连接。
   */
  private async _cleanup(): Promise<void> {
    try {
      // 空闲房间
      const idleRemoved = await this._store.removeIdleRooms(this._config.roomIdleTimeout)
      for (const code of idleRemoved) {
        console.log(JSON.stringify({
          time: nowISO(), level: 'info', module: 'cleanup',
          msg: 'Idle room removed', code
        }))
      }

      // 过期房间（24h）
      const expiredRemoved = await this._store.removeExpiredRooms(86400)
      for (const code of expiredRemoved) {
        console.log(JSON.stringify({
          time: nowISO(), level: 'info', module: 'cleanup',
          msg: 'Expired room removed', code
        }))
      }

      // 断开未加入房间的超时空闲连接
      const idleTimeoutMs = this._config.idleTimeout * 1000
      const now = Date.now()
      for (const [ws, state] of this._connections) {
        if (!state.roomCode && now - state.connectedAt > idleTimeoutMs) {
          console.log(JSON.stringify({
            time: nowISO(), level: 'warn', module: 'cleanup',
            msg: 'Idle connection timeout', ip: state.ip
          }))
          ws.close()
        }
      }
    } catch (err) {
      console.log(JSON.stringify({
        time: nowISO(), level: 'error', module: 'cleanup',
        msg: 'Cleanup error', error: (err as Error).message
      }))
    }
  }

  // ─── 工具方法 ─────────────────────────────────────────

  /**
   * 功能描述：从 HTTP 请求中提取客户端 IP
   *
   * @param req - HTTP 请求
   * @returns IP 字符串
   */
  private _parseIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim()
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  /**
   * 功能描述：生成唯一房间码（最多重试 10 次）
   *
   * 逻辑说明：30^6 ≈ 7.29 亿种组合，碰撞概率极低。
   *
   * @returns 唯一 6 位房间码
   * @throws 10 次重试后仍碰撞则抛出
   */
  private async _generateUniqueRoomCode(): Promise<string> {
    for (let i = 0; i < 10; i++) {
      const code = generateRoomCode()
      const existing = await this._store.getRoom(code)
      if (!existing) return code
    }
    throw new Error('Failed to generate unique room code after 10 attempts')
  }

  /**
   * 功能描述：消费一个令牌（消息限流）
   *
   * 逻辑说明：使用令牌桶算法，每连接每秒最多 msgRate 条消息。
   *           桶初始满，以 msgRate/s 速率补充，超限返回 false。
   *
   * @param connId - 连接 ID
   * @returns 是否可以发送消息
   */
  private _consumeToken(connId: string): boolean {
    const bucket = this._buckets.get(connId)
    if (!bucket) return true // 不存在时放行

    const now = Date.now()
    const elapsed = (now - bucket.lastRefill) / 1000
    bucket.tokens = Math.min(this._config.msgRate, bucket.tokens + elapsed * this._config.msgRate)
    bucket.lastRefill = now

    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  /**
   * 功能描述：检查房间创建频率
   *
   * 逻辑说明：每 IP 每分钟最多创建 RELAY_ROOM_CREATE_RATE 个房间。
   *           窗口固定为 60 秒。
   *
   * @param ip - 客户端 IP
   * @returns 是否允许创建
   */
  private async _checkRoomCreateRate(ip: string): Promise<boolean> {
    const now = Date.now()
    const info = await this._store.getIpRateInfo(ip)
    const windowMs = 60000

    if (!info || now - info.windowStart > windowMs) {
      await this._store.setIpRateInfo(ip, { count: 1, windowStart: now })
      return true
    }

    if (info.count >= this._config.roomCreateRate) return false

    info.count++
    await this._store.setIpRateInfo(ip, info)
    return true
  }
}
