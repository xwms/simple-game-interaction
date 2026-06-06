/**
 * 功能描述：连接层类型定义 — Transport 接口及连接参数
 *
 * 逻辑说明：Transport 是所有传输方式的统一抽象接口，
 *           IPv6 直连 / P2P / Relay 三种传输均需实现此接口。
 *           消费者（TunnelManager）通过此接口无感切换传输方式。
 */

import type { TransportStatus } from '@shared/types'

/** Transport 事件名常量 */
export const TRANSPORT_EVENTS = {
  DATA: 'data',
  STATUS: 'status',
  ERROR: 'error',
  CLOSE: 'close',
  TRAFFIC: 'traffic',
  RESET: 'reset'
} as const

/** 连接超时（默认 5 秒） */
export const TRANSPORT_TIMEOUT_MS = 5000

/**
 * 功能描述：对端连接信息
 *
 * 逻辑说明：建立传输连接时需要知道的对端网络信息。
 *           不同传输方式使用不同字段：
 *           IPv6 使用 ipv6Address + ipv6Port，
 *           P2P 使用 publicAddress 或 localAddresses，
 *           Relay 仅需 peerId。
 */
export interface PeerConnectionInfo {
  peerId: string
  /** 公网地址（STUN 发现） */
  publicAddress?: { ip: string; port: number }
  /** 本机地址列表（同 LAN 检测用） */
  localAddresses?: Array<{ ip: string; port: number }>
  /** IPv6 地址 */
  ipv6Address?: string
  /** IPv6 端口 */
  ipv6Port?: number
}

/**
 * 功能描述：连接请求参数
 *
 * 逻辑说明：TunnelManager 发起连接时需提供的双方网络信息，
 *           PathSelector 据此计算最优连接路径。
 */
export interface ConnectionRequest {
  hostNetwork: import('@shared/types').NetworkInfo
  guestNetwork: import('@shared/types').NetworkInfo
  hostId: string
  guestId: string
  gamePort: number
}

/**
 * 功能描述：传输层统一接口
 *
 * 逻辑说明：所有传输方式（IPv6/P2P/Relay）实现此接口。
 *           通过 EventEmitter 发射 DATA / STATUS / ERROR / CLOSE / TRAFFIC 事件。
 *           connect() 和 disconnect() 管理生命周期，
 *           send() 发送数据到对端。
 */
export interface Transport {
  readonly type: 'ipv6' | 'p2p' | 'relay'
  readonly status: TransportStatus

  /**
   * 功能描述：连接到对端
   *
   * @param peerInfo - 对端连接信息
   * @throws 连接超时或失败时抛出 Error
   */
  connect(peerInfo: PeerConnectionInfo): Promise<void>

  /**
   * 功能描述：断开连接
   */
  disconnect(): Promise<void>

  /**
   * 功能描述：发送数据到对端
   *
   * @param data - 二进制数据
   * @throws 未连接时抛出 Error
   */
  send(data: Buffer): Promise<void>

  /**
   * 功能描述：注册事件监听（由 EventEmitter 实现）
   */
  on(event: string, listener: (...args: unknown[]) => void): this

  /**
   * 功能描述：移除事件监听（由 EventEmitter 实现）
   */
  removeAllListeners(event?: string): this
}
