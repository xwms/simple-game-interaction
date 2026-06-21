/**
 * 功能描述：P2P 信令通道 — 通过中继服务器交换连接信息
 *
 * 逻辑说明：包装 RelayClient 的信令能力，提供类型化的 P2P 连接协商方法。
 *           信令消息通过中继服务器的 signal 通道转发，使双方能交换
 *           公网/私网地址信息，从而建立直接 TCP 连接。
 */

import { Logger } from '../utils/logger'
import type { RelayClient } from '../tunnel/relay-client'
import type { P2PSignalData } from './types'

const logger = new Logger('P2PSignaling')

/**
 * 功能描述：P2P 信令管理器
 *
 * 逻辑说明：通过 RelayClient 的 signal 事件通道转发 P2P 连接协商消息。
 *           不直接创建网络连接，仅负责信令交换。
 */
export class P2PSignaling {
  private _relayClient: RelayClient
  private _boundOnSignal: ((data: { from: string; signalData: unknown }) => void) | null = null

  constructor(relayClient: RelayClient) {
    this._relayClient = relayClient
  }

  /**
   * 功能描述：发送连接请求（发起方）
   *
   * @param peerId - 目标成员 ID
   * @param myInfo - 本机网络信息
   */
  async requestConnection(peerId: string, myInfo: P2PSignalData): Promise<void> {
    await this._relayClient.sendSignal(peerId, {
      ...myInfo,
      type: 'connection-request'
    } as P2PSignalData)
    logger.info(`Sent connection request to ${peerId}`)
  }

  /**
   * 功能描述：接受连接请求（接收方）
   *
   * @param peerId - 请求方成员 ID
   * @param myInfo - 本机网络信息
   */
  async acceptConnection(peerId: string, myInfo: P2PSignalData): Promise<void> {
    await this._relayClient.sendSignal(peerId, {
      ...myInfo,
      type: 'connection-accept'
    } as P2PSignalData)
    logger.info(`Accepted connection request from ${peerId}`)
  }

  /**
   * 功能描述：发送 NAT 探测信息
   *
   * @param peerId - 目标成员 ID
   * @param natInfo - NAT 探测到的公网地址
   */
  async sendNatInfo(peerId: string, natInfo: P2PSignalData): Promise<void> {
    await this._relayClient.sendSignal(peerId, {
      ...natInfo,
      type: 'nat-info'
    } as P2PSignalData)
  }

  /**
   * 功能描述：注册信令接收处理器
   *
   * @param handler - 收到信令时的回调 (from, data) => void
   */
  onSignal(handler: (from: string, data: P2PSignalData) => void): void {
    this._boundOnSignal = (event: { from: string; signalData: unknown }) => {
      const signalData = event.signalData as P2PSignalData
      if (signalData && signalData.type) {
        handler(event.from, signalData)
      } else {
        logger.warn(`Received invalid signal data: ${JSON.stringify(event.signalData)}`)
      }
    }
    this._relayClient.on('signal', this._boundOnSignal)
  }

  /**
   * 功能描述：移除信令接收处理器
   */
  removeSignalHandler(): void {
    if (this._boundOnSignal) {
      this._relayClient.off('signal', this._boundOnSignal)
      this._boundOnSignal = null
    }
  }

  /**
   * 功能描述：销毁信令管理器
   */
  destroy(): void {
    this.removeSignalHandler()
  }
}
