/**
 * 功能描述：Relay 中继客户端 — WebSocket 协议实现
 *
 * 逻辑说明：通过 WebSocket 连接到中继服务器，处理所有协议方面：
 *           连接生命周期、房间管理、P2P 信令、数据中继、心跳、重连。
 *           文本帧为 JSON 控制消息，二进制帧为中继数据。
 *           ！！！中继服务器代码在独立仓库 simple-game-relay 中，
 *           当前仅实现客户端逻辑！！！
 *
 * @module relay-client
 */

import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { Logger } from '../utils/logger'
import { BINARY_FRAME_HEADER_SIZE, DEFAULT_RELAY_CONFIG, RELAY_MESSAGE_TYPES } from './types'
import type { RelayConfig, RelayClientStatus, CreateRoomParams, CreateRoomResult, JoinRoomParams, JoinRoomResult, MemberJoinedData } from './types'
import type { NetworkInfo, TrafficSnapshot } from '@shared/types'

const logger = new Logger('RelayClient')

/** Relay 客户端状态 */
type WsState = 'disconnected' | 'connecting' | 'connected'

/**
 * 功能描述：Relay 客户端 — 管理到中继服务器的 WebSocket 连接
 *
 * 逻辑说明：继承 EventEmitter，发射事件供 TunnelManager 消费。
 *           内部状态机：disconnected → connecting → connected → (reconnecting)
 *           所有对外部服务器的操作（createRoom/joinRoom/leaveRoom）通过
 *           消息 ID 关联请求和响应。
 *
 * @fires connected - WebSocket 连接建立
 * @fires disconnected - WebSocket 连接断开
 * @fires room-created - 房间创建成功，附带 CreateRoomResult
 * @fires room-joined - 加入房间成功，附带 JoinRoomResult
 * @fires member-joined - 新成员加入，附带 MemberJoinedData
 * @fires member-left - 成员离开，附带 { memberId: string }
 * @fires signal - P2P 信令消息，附带 { from: string, signalData: unknown }
 * @fires data - 中继数据（Buffer）
 * @fires room-closed - 房间被关闭
 * @fires traffic - 流量统计
 * @fires error - 错误
 */
export class RelayClient extends EventEmitter {
  private _ws: WebSocket | null = null
  private _state: WsState = 'disconnected'
  private _config: RelayConfig
  private _memberId: string = ''
  private _roomCode: string = ''
  private _reconnectAttempts: number = 0
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _trafficBytesSent: number = 0
  private _trafficBytesReceived: number = 0
  private _trafficTimer: ReturnType<typeof setInterval> | null = null
  /** 心跳发送指数退避定时器 */
  private _heartbeatBackoffTimer: ReturnType<typeof setTimeout> | null = null
  /** Pong 超时检测定时器 */
  private _pongCheckTimer: ReturnType<typeof setInterval> | null = null
  /** 上次收到心跳响应/任何消息的时间戳（用于超时检测） */
  private _lastPongTime: number = 0
  /** 连续心跳发送失败次数（用于指数退避） */
  private _heartbeatFailures: number = 0
  /** 是否为服务端端（影响二进制帧解析格式） */
  private _isServer: boolean = false
  /** 待响应请求表 <messageId, { resolve, reject, timer }> */
  private _pendingRequests: Map<string, {
    resolve: (data: unknown) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = new Map()
  private _messageIdSeq: number = 0

  constructor(config?: Partial<RelayConfig>) {
    super()
    this._config = { ...DEFAULT_RELAY_CONFIG, ...config }
  }

  /**
   * 功能描述：更新中继服务器地址（下次 connect 时生效）
   *
   * @param url - WebSocket 中继服务器地址
   */
  setRelayUrl(url: string): void {
    this._config.relayUrl = url
  }

  /** 设为服务端模式（改变二进制帧解析方式） */
  setServerMode(): void {
    this._isServer = true
  }

  // ─── 公共属性 ───────────────────────────────────────

  /** 当前连接状态 */
  get state(): RelayClientStatus {
    if (this._reconnectTimer !== null) return 'reconnecting'
    if (this._state === 'connected') return 'connected'
    if (this._state === 'connecting') return 'connecting'
    return 'disconnected'
  }

  /** 本机成员 ID（加入房间后赋值） */
  get memberId(): string {
    return this._memberId
  }

  /** 当前房间码 */
  get roomCode(): string {
    return this._roomCode
  }

  // ─── 连接管理 ───────────────────────────────────────

  /**
   * 功能描述：连接到中继服务器
   *
   * 逻辑说明：创建 WebSocket 连接到配置的 relayUrl。
   *           设置 onopen/onmessage/onclose/onerror 处理器。
   *           返回 Promise，连接成功 resolve，超时或失败 reject。
   *
   * @throws 连接超时错误
   */
  async connect(): Promise<void> {
    if (this._state === 'connected' && this._ws?.readyState === WebSocket.OPEN) {
      return
    }

    this._cancelReconnect()
    this._state = 'connecting'
    this._cleanupWebSocket()

    return new Promise<void>((resolve, reject) => {
      try {
        const ws = new WebSocket(this._config.relayUrl)
        const timeoutTimer = setTimeout(() => {
          ws.close()
          reject(new Error('Relay connection timed out'))
        }, this._config.connectTimeout)

        ws.onopen = () => {
          clearTimeout(timeoutTimer)
          this._ws = ws
          this._state = 'connected'
          this._reconnectAttempts = 0
          this._lastPongTime = Date.now()
          this._heartbeatFailures = 0
          this._startHeartbeat()
          this._startPongCheck()
          this._startTrafficMonitor()

          this.emit('connected')
          resolve()
        }

        ws.onmessage = (event: WebSocket.MessageEvent) => {
          this._onMessage(event)
        }

        ws.onclose = (event: WebSocket.CloseEvent) => {
          logger.warn(`Relay connection disconnected (code: ${event.code}, reason: ${event.reason || 'none'})`)
          this._state = 'disconnected'
          this._stopHeartbeat()
          this._stopPongCheck()
          this._stopTrafficMonitor()
          this.emit('disconnected')
          this._attemptReconnect()
        }

        ws.onerror = () => {
          // error 事件后 onclose 一定会触发，在 close 中处理重连
        }
      } catch (err) {
        reject(new Error(`Relay connection failed: ${(err as Error).message}`))
      }
    })
  }

  /**
   * 功能描述：断开中继服务器连接
   *
   * 逻辑说明：清理所有定时器、待响应请求、WebSocket 连接。
   */
  async disconnect(): Promise<void> {
    this._cancelReconnect()
    this._stopHeartbeat()
    this._stopPongCheck()
    this._stopTrafficMonitor()
    this._rejectAllPending(new Error('Connection closed'))
    this._cleanupWebSocket()
    // _cleanupWebSocket 会触发 onclose → _attemptReconnect，
    // 需要二次取消防止泄漏的重连定时器
    this._cancelReconnect()
    this._state = 'disconnected'
    this._memberId = ''
    this._roomCode = ''
    this._isServer = false
    this._reconnectAttempts = 0
    this._trafficBytesSent = 0
    this._trafficBytesReceived = 0
    this.emit('disconnected')
  }

  // ─── 房间管理 ───────────────────────────────────────

  /**
   * 功能描述：创建房间（房主调用）
   *
   * 逻辑说明：发送 create-room 消息，等待 room-created 响应。
   *
   * @param params - 创建房间参数
   * @returns 房间码和成员 ID
   * @throws 中继服务器返回错误或连接未就绪
   */
  async createRoom(params: CreateRoomParams): Promise<CreateRoomResult> {
    this._assertConnected()

    const result = await this._sendRequest<CreateRoomResult>(
      RELAY_MESSAGE_TYPES.CREATE_ROOM,
      params
    )
    this._memberId = result.memberId
    this._roomCode = result.roomCode
    return result
  }

  /**
   * 功能描述：加入房间（加入者调用）
   *
   * 逻辑说明：发送 join-room 消息，等待 room-joined 响应，
   *           响应中附带房主的网络检测结果。
   *
   * @param roomCode - 6 位房间码
   * @param params - 加入房间参数
   * @returns 加入房间结果（含房主网络信息）
   * @throws 房间不存在/已满/连接未就绪
   */
  async joinRoom(roomCode: string, params: JoinRoomParams): Promise<JoinRoomResult> {
    this._assertConnected()

    const result = await this._sendRequest<Record<string, unknown>>(
      RELAY_MESSAGE_TYPES.JOIN_ROOM,
      { roomCode, ...params }
    )
    this._memberId = result.memberId as string
    this._roomCode = roomCode
    // 中继服务器返回 hostId/hostNetworkInfo（旧命名），映射为 serverId/serverNetworkInfo
    return {
      roomCode: result.roomCode as string,
      memberId: result.memberId as string,
      serverId: (result.serverId || result.hostId) as string,
      serverNetworkInfo: (result.serverNetworkInfo || result.hostNetworkInfo) as (NetworkInfo | undefined),
      gamePort: result.gamePort as number,
      members: result.members as Array<{ id: string; name: string }>
    }
  }

  /**
   * 功能描述：离开房间
   *
   * 逻辑说明：发送 leave-room 消息，重置本地房间状态。
   */
  async leaveRoom(): Promise<void> {
    if (!this._roomCode) return

    try {
      this._sendMessage(RELAY_MESSAGE_TYPES.LEAVE_ROOM, { roomCode: this._roomCode })
    } catch {
      // 发送失败不影响本地清理
    }

    this._memberId = ''
    this._roomCode = ''
    this.emit('left')
  }

  /**
   * 功能描述：发送 P2P 信令消息
   *
   * 逻辑说明：通过中继服务器转发 SDP/ICE 等信令数据到指定成员。
   *
   * @param to - 目标成员 ID
   * @param signalData - 信令数据
   */
  async sendSignal(to: string, signalData: unknown): Promise<void> {
    this._assertConnected()
    this._sendMessage(RELAY_MESSAGE_TYPES.SIGNAL, { to, signalData })
  }

  /**
   * 功能描述：发送中继数据（二进制）
   *
   * 逻辑说明：房主端发送时需要指定目标成员 ID，帧格式：
   *           [4B targetIdLen][targetId UTF8][4B payloadLen][payload]
   *           加入者端直接发送：[4B payloadLen][payload]
   *
   * @param data - 要中继的二进制数据
   * @param targetMemberId - 目标成员 ID（房主端必填，加入者端忽略）
   */
  sendData(data: Buffer, targetMemberId?: string): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      return
    }

    let frame: Buffer

    if (targetMemberId) {
      // 房主 → 指定 Guest: [4B targetIdLen][targetId][4B payloadLen][payload]
      const idBuf = Buffer.from(targetMemberId, 'utf8')
      const idHeader = Buffer.alloc(4)
      idHeader.writeUInt32BE(idBuf.length, 0)
      const payloadHeader = Buffer.alloc(BINARY_FRAME_HEADER_SIZE)
      payloadHeader.writeUInt32BE(data.length, 0)
      frame = Buffer.concat([idHeader, idBuf, payloadHeader, data])
    } else {
      // Guest → Host: [4B payloadLen][payload]
      const header = Buffer.alloc(BINARY_FRAME_HEADER_SIZE)
      header.writeUInt32BE(data.length, 0)
      frame = Buffer.concat([header, data])
    }

    this._ws.send(frame)
    this._trafficBytesSent += data.length
  }

  /** 获取当前是否为服务端模式 */
  get isServerMode(): boolean {
    return this._isServer
  }

  // ─── 私有方法 ───────────────────────────────────────

  /**
   * 功能描述：发送 JSON 文本消息（无需响应）
   *
   * @param type - 消息类型
   * @param data - 消息数据
   */
  private _sendMessage(type: string, data?: unknown): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw new Error('Relay not connected')
    }

    const msg: Record<string, unknown> = { type }
    if (data !== undefined) msg.data = data
    this._ws.send(JSON.stringify(msg))
  }

  /**
   * 功能描述：发送请求并等待响应
   *
   * 逻辑说明：为消息分配唯一 ID，注册到 _pendingRequests 表，
   *           等待 _onMessage 中匹配的响应来 resolve。
   *           30 秒超时自动 reject。
   *
   * @param type - 请求消息类型
   * @param data - 请求数据
   * @returns Promise，resolve 响应数据
   */
  private _sendRequest<T>(type: string, data?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const messageId = `req_${++this._messageIdSeq}_${Date.now()}`
      const timer = setTimeout(() => {
        this._pendingRequests.delete(messageId)
        reject(new Error(`Request timed out: ${type}`))
      }, 30000)

      this._pendingRequests.set(messageId, { resolve: resolve as (d: unknown) => void, reject, timer })

      const msg: Record<string, unknown> = { type, messageId }
      if (data !== undefined) msg.data = data

      try {
        this._ws!.send(JSON.stringify(msg))
      } catch (err) {
        this._pendingRequests.delete(messageId)
        clearTimeout(timer)
        reject(new Error(`Send failed: ${(err as Error).message}`))
      }
    })
  }

  /**
   * 功能描述：处理 WebSocket 消息
   *
   * 逻辑说明：区分文本帧（JSON 控制消息）和二进制帧（中继数据）。
   *           文本帧按 type 路由到对应处理器。
   *
   * @param event - WebSocket 消息事件
   */
  private _onMessage(event: WebSocket.MessageEvent): void {
    if (typeof event.data === 'string') {
      this._handleTextMessage(event.data)
    } else {
      // ws 库自动根据 WebSocket opcode 区分：文本帧 → string，二进制帧 → Buffer
      this._handleBinaryData(event.data as Buffer)
    }
  }

  /**
   * 功能描述：处理 JSON 文本消息
   *
   * @param text - JSON 字符串
   */
  private _handleTextMessage(text: string): void {
    // 任何来自服务器的消息都视为连接存活证明
    this._lastPongTime = Date.now()

    let msg: { type: string; messageId?: string; data?: unknown; error?: { code: string; message: string } }
    try {
      msg = JSON.parse(text)
    } catch {
      logger.warn(`Received invalid JSON message: ${text}`)
      return
    }

    // 检查是否是对请求的响应
    if (msg.messageId) {
      const pending = this._pendingRequests.get(msg.messageId)
      if (pending) {
        clearTimeout(pending.timer)
        this._pendingRequests.delete(msg.messageId)
        if (msg.error) {
          pending.reject(new Error(`[${msg.error.code}] ${msg.error.message}`))
        } else {
          pending.resolve(msg.data)
        }
        return
      }
    }

    // 服务器主动推送的消息
    switch (msg.type) {
      case RELAY_MESSAGE_TYPES.MEMBER_JOINED:
        this.emit(RELAY_MESSAGE_TYPES.MEMBER_JOINED, msg.data as MemberJoinedData)
        break
      case RELAY_MESSAGE_TYPES.MEMBER_LEFT:
        this.emit(RELAY_MESSAGE_TYPES.MEMBER_LEFT, msg.data as { memberId: string })
        break
      case RELAY_MESSAGE_TYPES.SIGNAL:
        this.emit(RELAY_MESSAGE_TYPES.SIGNAL, msg.data as { from: string; signalData: unknown })
        break
      case RELAY_MESSAGE_TYPES.ROOM_CLOSED:
        this.emit(RELAY_MESSAGE_TYPES.ROOM_CLOSED)
        break
      case RELAY_MESSAGE_TYPES.HEARTBEAT:
        // 心跳响应（或服务端主动心跳）— 更新存活时间戳
        this._lastPongTime = Date.now()
        break
      case RELAY_MESSAGE_TYPES.ERROR:
        this.emit(RELAY_MESSAGE_TYPES.ERROR, msg.error)
        break
      default:
        logger.debug(`Unhandled message type: ${msg.type}`)
    }
  }

  /**
   * 功能描述：处理二进制数据帧
   *
   * 逻辑说明：
   *   房主端帧格式：[4B sourceIdLen UInt32BE][sourceId UTF8][4B payloadLen UInt32BE][payload]
   *   加入者端帧格式：[4B payloadLen UInt32BE][payload]
   *   payloadLen=0 时为重置帧（通知房主重建该 Guest 的游戏连接）。
   *   房主端通过 sourceMemberId 区分数据来源，支持多 Guest。
   *
   * @param raw - 原始二进制数据
   */
  private _handleBinaryData(raw: Buffer): void {
    let sourceMemberId: string | undefined
    let payload: Buffer

    if (this._isServer) {
      // 房主端：[4B sourceIdLen][sourceId][4B payloadLen][payload]
      if (raw.length < 8) {
        logger.warn(`Received undersized binary frame: ${raw.length} bytes`)
        return
      }
      const idLen = raw.readUInt32BE(0)
      if (raw.length < 4 + idLen + 4) {
        logger.warn('Received incomplete binary frame')
        return
      }
      sourceMemberId = raw.subarray(4, 4 + idLen).toString('utf8')
      const innerData = raw.subarray(4 + idLen)
      const payloadLen = innerData.readUInt32BE(0)

      // payloadLen=0 为重置帧 — 通知重建该加入者的游戏连接
      if (payloadLen === 0) {
        this.emit('reset', { sourceMemberId })
        return
      }

      payload = innerData.subarray(BINARY_FRAME_HEADER_SIZE, BINARY_FRAME_HEADER_SIZE + payloadLen)
    } else {
      // 加入者端：中继服务器转发时去掉了所有前缀，只发送原始 payload
      payload = raw
    }

    this._trafficBytesReceived += payload.length
    this.emit(RELAY_MESSAGE_TYPES.RELAY_DATA, payload, sourceMemberId)
  }

  // ─── 心跳（指数退避） ───────────────────────────────

  /**
   * 功能描述：启动心跳系统（指数退避发送 + 独立超时检测）
   *
   * 逻辑说明：借鉴 frp 的双协程设计：
   *           1. 心跳发送：使用 setTimeout 链，发送失败时指数退避重试
   *              （1s→2s→4s→...，上限为 heartbeatInterval），
   *              成功时重置为正常间隔。
   *           2. 超时检测：独立 1s 定时器检查 _lastPongTime，
   *              超过 heartbeatTimeout 未收到消息则触发重连。
   *           连接上来的任何服务器消息都会更新 _lastPongTime，
   *           因此即使服务端未回显心跳也能正常工作。
   */
  private _startHeartbeat(): void {
    this._stopHeartbeat()
    this._lastPongTime = Date.now()
    this._heartbeatFailures = 0
    this._scheduleNextHeartbeat(this._config.heartbeatInterval)
  }

  /**
   * 功能描述：调度下一次心跳发送
   *
   * @param delay - 下次发送延迟（毫秒）
   */
  private _scheduleNextHeartbeat(delay: number): void {
    this._stopHeartbeatBackoff()
    this._heartbeatBackoffTimer = setTimeout(() => {
      this._doHeartbeat()
    }, delay)
  }

  /**
   * 功能描述：执行一次心跳发送
   *
   * 逻辑说明：发送失败时指数退避（并发失败次数递增），
   *           成功时重置间隔为配置值。
   */
  private _doHeartbeat(): void {
    try {
      this._sendMessage(RELAY_MESSAGE_TYPES.HEARTBEAT, {
        roomCode: this._roomCode || undefined
      })
      // 发送成功 → 连接可写即视为存活（更新 _lastPongTime 阻止 pong 超时误判）
      this._heartbeatFailures = 0
      this._lastPongTime = Date.now()
      this._scheduleNextHeartbeat(this._config.heartbeatInterval)
    } catch {
      // 发送失败 → 指数退避
      this._heartbeatFailures++
      const backoffDelay = Math.min(
        this._config.reconnectBaseDelay * Math.pow(2, this._heartbeatFailures - 1),
        this._config.heartbeatInterval
      )
      logger.debug(`Heartbeat send failed, backing off ${backoffDelay}ms (attempt ${this._heartbeatFailures})`)
      this._scheduleNextHeartbeat(backoffDelay)
    }
  }

  /**
   * 功能描述：停止心跳发送定时器
   */
  private _stopHeartbeat(): void {
    this._stopHeartbeatBackoff()
  }

  /**
   * 功能描述：停止心跳退避定时器
   */
  private _stopHeartbeatBackoff(): void {
    if (this._heartbeatBackoffTimer) {
      clearTimeout(this._heartbeatBackoffTimer)
      this._heartbeatBackoffTimer = null
    }
  }

  // ─── 心跳超时检测 ────────────────────────────────────

  /**
   * 功能描述：启动 Pong 超时检测
   *
   * 逻辑说明：每秒检查一次 _lastPongTime 和 _heartbeatFailures。
   *           心跳发送成功即更新 _lastPongTime（TCP 可写视为存活），
   *           所以超时仅发生在：心跳发送连续失败 + 长时间无服务器消息。
   *           双重条件防止中继服务器不回显心跳时误判超时。
   *
   * 触发条件：距上次心跳成功 / 收到消息 > heartbeatTimeout
   *           且连续心跳发送失败 >= 3 次
   */
  private _startPongCheck(): void {
    this._stopPongCheck()
    this._pongCheckTimer = setInterval(() => {
      const elapsed = Date.now() - this._lastPongTime
      if (elapsed > this._config.heartbeatTimeout && this._heartbeatFailures >= 3) {
        logger.warn(`Heartbeat timeout (${elapsed}ms no response, ${this._heartbeatFailures} consecutive send failures), triggering reconnect`)
        this._state = 'disconnected'
        this._stopHeartbeat()
        this._stopPongCheck()
        this._cleanupWebSocket()
        this.emit('disconnected')
        this._attemptReconnect()
      }
    }, 1000)
  }

  /**
   * 功能描述：停止 Pong 超时检测
   */
  private _stopPongCheck(): void {
    if (this._pongCheckTimer) {
      clearInterval(this._pongCheckTimer)
      this._pongCheckTimer = null
    }
  }

  // ─── 流量监控 ───────────────────────────────────────

  /**
   * 功能描述：启动流量统计定时器
   *
   * 逻辑说明：每秒发射一次流量快照供 UI 展示。
   */
  private _startTrafficMonitor(): void {
    this._stopTrafficMonitor()
    this._trafficTimer = setInterval(() => {
      const snapshot: TrafficSnapshot = {
        bytesSent: this._trafficBytesSent,
        bytesReceived: this._trafficBytesReceived,
        timestamp: Date.now()
      }
      this.emit('traffic', snapshot)
    }, 1000)
  }

  /**
   * 功能描述：停止流量统计定时器
   */
  private _stopTrafficMonitor(): void {
    if (this._trafficTimer) {
      clearInterval(this._trafficTimer)
      this._trafficTimer = null
    }
  }

  // ─── 重连 ───────────────────────────────────────────

  /**
   * 功能描述：尝试重连（指数退避）
   *
   * 逻辑说明：仅在未加入房间时自动重连。若已在房间中（_roomCode 非空），
   *           跳过重连：重建 WebSocket 无法恢复房间关联。
   *           服务端在旧连接断开时已清理房间状态。
   *           最大重试次数后停止，发射错误事件。
   *           延迟计算：baseDelay * 2^attempt，上限 30 秒。
   */
  private _attemptReconnect(): void {
    // 已在房间中时跳过自动重连，由上层（TunnelManager）处理房间清理
    if (this._roomCode) {
      logger.warn('Already in a room, skipping auto-reconnect (need to create/join a new room)')
      this.emit('error', new Error('Relay connection lost, room is no longer valid'))
      return
    }

    if (this._reconnectAttempts >= this._config.reconnectMaxAttempts) {
      logger.error(`Relay reconnect attempts reached limit: ${this._reconnectAttempts}`)
      this.emit('error', new Error(`Relay reconnect failed (${this._reconnectAttempts} attempts made)`))
      return
    }

    const delay = Math.min(
      this._config.reconnectBaseDelay * Math.pow(2, this._reconnectAttempts),
      30000
    )
    this._reconnectAttempts++

    logger.info(`Relay will reconnect in ${delay}ms (attempt ${this._reconnectAttempts})`)
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null
      try {
        await this.connect()
      } catch {
        // connect 内部已处理重连
      }
    }, delay)
  }

  /**
   * 功能描述：取消重连定时器
   */
  private _cancelReconnect(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
  }

  // ─── 工具方法 ───────────────────────────────────────

  /**
   * 功能描述：断言连接已就绪
   *
   * @throws 连接未就绪时抛出 Error
   */
  private _assertConnected(): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw new Error('Relay not connected, please call connect() first')
    }
  }

  /**
   * 功能描述：清理 WebSocket 资源
   */
  private _cleanupWebSocket(): void {
    if (this._ws) {
      try {
        this._ws.onopen = null
        this._ws.onmessage = null
        this._ws.onclose = null
        this._ws.onerror = null
        if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
          this._ws.close()
        }
      } catch {
        // 忽略关闭时的错误
      }
      this._ws = null
    }
  }

  /**
   * 功能描述：拒绝所有待响应请求
   *
   * @param err - 拒绝原因
   */
  private _rejectAllPending(err: Error): void {
    for (const [, pending] of this._pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this._pendingRequests.clear()
  }
}
