/**
 * 功能描述：Relay 中转传输 — 通过 RelayClient 转发 TCP 数据
 *
 * 逻辑说明：当 IPv6 和 P2P 均不可用时，使用 Relay 模式作为兜底。
 *           数据通过 RelayClient 的 WebSocket 连接中转。
 *           实现 Transport 接口，对 TunnelManager 透明。
 *           实际网络 I/O 由 RelayClient 完成，本类仅做适配。
 */

import { EventEmitter } from 'events'
import { Logger } from '../utils/logger'
import { TRANSPORT_EVENTS } from '../connection'
import { RELAY_MESSAGE_TYPES } from '../tunnel/types'
import type { Transport, PeerConnectionInfo } from '../connection'
import type { TransportStatus, TrafficSnapshot } from '@shared/types'
import type { RelayClient } from '../tunnel/relay-client'

const logger = new Logger('RelayPeer')

/**
 * 功能描述：Relay 中转传输适配器
 *
 * 逻辑说明：包装 RelayClient 的中继数据收发能力为 Transport 接口。
 *           connect() 确保 RelayClient 已连接，
 *           send() 通过 RelayClient.sendData() 发送，
 *           通过 RelayClient 的 data 事件接收对端数据。
 *
 * @fires data - 收到对端中继数据
 * @fires status - 连接状态变更
 * @fires error - 连接错误
 * @fires close - 连接关闭
 * @fires traffic - 流量统计
 */
export class RelayPeerTransport extends EventEmitter implements Transport {
  readonly type = 'relay' as const
  private _relayClient: RelayClient
  private _status: TransportStatus = 'disconnected'
  private _trafficBytesSent: number = 0
  private _trafficBytesReceived: number = 0
  private _trafficTimer: ReturnType<typeof setInterval> | null = null
  private _targetMemberId: string = ''
  private _boundOnData: ((data: Buffer, sourceMemberId?: string) => void) | null = null
  private _boundOnDisconnected: (() => void) | null = null
  private _boundOnReconnected: (() => void) | null = null
  private _boundOnReset: ((payload: { sourceMemberId: string }) => void) | null = null

  /**
   * @param relayClient - Relay 客户端
   * @param targetMemberId - 目标成员 ID（房主端填写，指定本通道对应哪个加入者）
   */
  constructor(relayClient: RelayClient, targetMemberId?: string) {
    super()
    this._relayClient = relayClient
    this._targetMemberId = targetMemberId || ''
  }

  get status(): TransportStatus {
    return this._status
  }

  /**
   * 功能描述：建立 Relay 传输通道
   *
   * 逻辑说明：确保 RelayClient 已连接。Relay 方式的"连接"就是
   *           中继 WebSocket 连接本身，无需额外建立通道。
   *           注册 relay client 的 data 事件监听。
   */
  async connect(_peerInfo: PeerConnectionInfo): Promise<void> {
    this._setStatus('connecting')

    // 确保 relay 已连接
    if (this._relayClient.state === 'disconnected' || this._relayClient.state === 'reconnecting') {
      try {
        await this._relayClient.connect()
      } catch (err) {
        this._setStatus('error')
        throw new Error(`Relay 传输连接失败: ${(err as Error).message}`)
      }
    }

    this._boundOnData = (data: Buffer, sourceMemberId?: string) => {
      // 房主端有 targetMemberId，仅接收指定成员的 data
      if (this._targetMemberId && sourceMemberId !== this._targetMemberId) {
        return
      }
      this._trafficBytesReceived += data.length
      this.emit(TRANSPORT_EVENTS.DATA, data)
    }
    this._relayClient.on(RELAY_MESSAGE_TYPES.RELAY_DATA, this._boundOnData)

    // 监听重置帧：从 guest 侧通知房主重建游戏连接
    this._boundOnReset = (payload: { sourceMemberId: string }) => {
      if (this._targetMemberId && payload.sourceMemberId !== this._targetMemberId) {
        return
      }
      this.emit(TRANSPORT_EVENTS.RESET)
    }
    this._relayClient.on('reset', this._boundOnReset)

    this._boundOnDisconnected = () => {
      this._setStatus('disconnected')
      this.emit(TRANSPORT_EVENTS.CLOSE)
    }
    this._relayClient.on('disconnected', this._boundOnDisconnected)

    // 中继重连后自动恢复传输状态
    this._boundOnReconnected = () => {
      logger.info('Relay 传输通道已恢复')
      this._setStatus('connected')
    }
    this._relayClient.on('connected', this._boundOnReconnected)

    this._setStatus('connected')
    this._startTrafficMonitor()
    logger.info('Relay 传输通道已建立')
  }

  /**
   * 功能描述：断开 Relay 传输通道
   *
   * 逻辑说明：取消事件监听，重置流量统计。不断开 RelayClient
   *           WebSocket 连接（TunnelManager 统一管理连接生命周期）。
   */
  async disconnect(): Promise<void> {
    this._stopTrafficMonitor()

    if (this._boundOnData) {
      this._relayClient.off(RELAY_MESSAGE_TYPES.RELAY_DATA, this._boundOnData)
      this._boundOnData = null
    }
    if (this._boundOnDisconnected) {
      this._relayClient.off('disconnected', this._boundOnDisconnected)
      this._boundOnDisconnected = null
    }
    if (this._boundOnReconnected) {
      this._relayClient.off('connected', this._boundOnReconnected)
      this._boundOnReconnected = null
    }
    if (this._boundOnReset) {
      this._relayClient.off('reset', this._boundOnReset)
      this._boundOnReset = null
    }

    this._setStatus('disconnected')
    this.emit(TRANSPORT_EVENTS.CLOSE)
  }

  /**
   * 功能描述：通过中继发送数据
   *
   * @param data - 二进制数据
   */
  async send(data: Buffer): Promise<void> {
    // 房主端发送时需指定目标成员 ID，relay 服务器据此转发到对应 Guest
    this._relayClient.sendData(data, this._targetMemberId || undefined)
    this._trafficBytesSent += data.length
  }

  /**
   * 功能描述：设置连接状态并发射事件
   */
  private _setStatus(status: TransportStatus): void {
    this._status = status
    this.emit(TRANSPORT_EVENTS.STATUS, status)
  }

  /**
   * 功能描述：启动流量统计定时器
   */
  private _startTrafficMonitor(): void {
    this._stopTrafficMonitor()
    this._trafficTimer = setInterval(() => {
      const snapshot: TrafficSnapshot = {
        bytesSent: this._trafficBytesSent,
        bytesReceived: this._trafficBytesReceived,
        timestamp: Date.now()
      }
      this.emit(TRANSPORT_EVENTS.TRAFFIC, snapshot)
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
}
