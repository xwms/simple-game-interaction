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
import type { TrafficSnapshot } from '@shared/types'

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
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private _trafficBytesSent: number = 0
  private _trafficBytesReceived: number = 0
  private _trafficTimer: ReturnType<typeof setInterval> | null = null
  /** 是否为房主端（影响二进制帧解析格式） */
  private _isHost: boolean = false
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

  /** 设为房主端模式（改变二进制帧解析方式） */
  setHostMode(): void {
    this._isHost = true
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

    this._state = 'connecting'
    this._cleanupWebSocket()

    return new Promise<void>((resolve, reject) => {
      try {
        const ws = new WebSocket(this._config.relayUrl)
        const timeoutTimer = setTimeout(() => {
          ws.close()
          reject(new Error(`Relay 连接超时 (${this._config.connectTimeout}ms)`))
        }, this._config.connectTimeout)

        ws.onopen = () => {
          clearTimeout(timeoutTimer)
          this._ws = ws
          this._state = 'connected'
          this._reconnectAttempts = 0
          this._startHeartbeat()
          this._startTrafficMonitor()
          this.emit('connected')
          resolve()
        }

        ws.onmessage = (event: WebSocket.MessageEvent) => {
          this._onMessage(event)
        }

        ws.onclose = (event: WebSocket.CloseEvent) => {
          logger.warn(`WebSocket 关闭: code=${event.code} reason=${event.reason || '无'}`)
          this._state = 'disconnected'
          this._stopHeartbeat()
          this._stopTrafficMonitor()
          this.emit('disconnected')
          this._attemptReconnect()
        }

        ws.onerror = () => {
          // error 事件后 onclose 一定会触发，在 close 中处理重连
        }
      } catch (err) {
        reject(new Error(`Relay 连接失败: ${(err as Error).message}`))
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
    this._stopTrafficMonitor()
    this._rejectAllPending(new Error('连接已断开'))
    this._cleanupWebSocket()
    this._state = 'disconnected'
    this._memberId = ''
    this._roomCode = ''
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

    const result = await this._sendRequest<JoinRoomResult>(
      RELAY_MESSAGE_TYPES.JOIN_ROOM,
      { roomCode, ...params }
    )
    this._memberId = result.memberId
    this._roomCode = roomCode
    return result
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

  /** 获取当前是否为房主端模式 */
  get isHostMode(): boolean {
    return this._isHost
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
      throw new Error('Relay 未连接')
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
        reject(new Error(`请求超时: ${type}`))
      }, 30000)

      this._pendingRequests.set(messageId, { resolve: resolve as (d: unknown) => void, reject, timer })

      const msg: Record<string, unknown> = { type, messageId }
      if (data !== undefined) msg.data = data

      try {
        this._ws!.send(JSON.stringify(msg))
      } catch (err) {
        this._pendingRequests.delete(messageId)
        clearTimeout(timer)
        reject(new Error(`发送失败: ${(err as Error).message}`))
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
      // Windows 下 ws 包可能将文本帧以 Buffer 交付
      const raw = event.data as Buffer
      const text = raw.toString('utf8')
      try {
        JSON.parse(text)
        this._handleTextMessage(text)
      } catch {
        this._handleBinaryData(raw)
      }
    }
  }

  /**
   * 功能描述：处理 JSON 文本消息
   *
   * @param text - JSON 字符串
   */
  private _handleTextMessage(text: string): void {
    let msg: { type: string; messageId?: string; data?: unknown; error?: { code: string; message: string } }
    try {
      msg = JSON.parse(text)
    } catch {
      logger.warn('收到非法 JSON 消息', text)
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
        // 心跳响应不做特殊处理
        break
      case RELAY_MESSAGE_TYPES.ERROR:
        this.emit(RELAY_MESSAGE_TYPES.ERROR, msg.error)
        break
      default:
        logger.debug('未处理的消息类型', msg.type)
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

    if (this._isHost) {
      // 房主端：[4B sourceIdLen][sourceId][4B payloadLen][payload]
      if (raw.length < 8) {
        logger.warn('收到过短的二进制帧', raw.length)
        return
      }
      const idLen = raw.readUInt32BE(0)
      if (raw.length < 4 + idLen + 4) {
        logger.warn('收到不完整的二进制帧')
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
      // 加入者端：[4B payloadLen][payload]
      if (raw.length < BINARY_FRAME_HEADER_SIZE) {
        logger.warn('收到过短的二进制帧', raw.length)
        return
      }
      const payloadLen = raw.readUInt32BE(0)
      payload = raw.subarray(BINARY_FRAME_HEADER_SIZE, BINARY_FRAME_HEADER_SIZE + payloadLen)
    }

    this._trafficBytesReceived += payload.length
    this.emit(RELAY_MESSAGE_TYPES.RELAY_DATA, payload, sourceMemberId)
  }

  // ─── 心跳 ───────────────────────────────────────────

  /**
   * 功能描述：启动心跳定时器
   *
   * 逻辑说明：每 10 秒发送一次心跳消息维持连接。
   */
  private _startHeartbeat(): void {
    this._stopHeartbeat()
    this._heartbeatTimer = setInterval(() => {
      try {
        this._sendMessage(RELAY_MESSAGE_TYPES.HEARTBEAT, {
          roomCode: this._roomCode || undefined
        })
      } catch {
        // 连接已断开，心跳失败可忽略
      }
    }, this._config.heartbeatInterval)
  }

  /**
   * 功能描述：停止心跳定时器
   */
  private _stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
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
   * 逻辑说明：最大重试次数后停止，发射错误事件。
   *           延迟计算：baseDelay * 2^attempt，上限 30 秒。
   */
  private _attemptReconnect(): void {
    if (this._reconnectAttempts >= this._config.reconnectMaxAttempts) {
      logger.error('Relay 重连次数已达上限', this._reconnectAttempts)
      this.emit('error', new Error(`Relay 重连失败 (已重试 ${this._reconnectAttempts} 次)`))
      return
    }

    const delay = Math.min(
      this._config.reconnectBaseDelay * Math.pow(2, this._reconnectAttempts),
      30000
    )
    this._reconnectAttempts++

    logger.info(`Relay 将在 ${delay}ms 后重连 (第 ${this._reconnectAttempts} 次)`)
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
      throw new Error('Relay 未连接，请先调用 connect()')
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
