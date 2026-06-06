/**
 * P2P 信令通道测试
 *
 * 逻辑说明：通过 Mock RelayClient 验证 P2PSignaling 的信令收发逻辑。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { P2PSignaling } from '../../../src/core/p2p/signaling'
import type { P2PSignalData } from '../../../src/core/p2p/types'

class MockRelayClient extends EventEmitter {
  signalTo: string | null = null
  signalData: unknown = null

  async sendSignal(to: string, signalData: unknown): Promise<void> {
    this.signalTo = to
    this.signalData = signalData
  }
}

describe('P2PSignaling 信令通道', () => {
  let relayClient: MockRelayClient
  let signaling: P2PSignaling

  beforeEach(() => {
    relayClient = new MockRelayClient()
    signaling = new P2PSignaling(relayClient as any)
  })

  it('requestConnection() 应通过 relay 发送连接请求', async () => {
    const myInfo: P2PSignalData = {
      type: 'connection-request',
      publicIp: '1.2.3.4',
      publicPort: 12345,
      privateIp: '192.168.1.100',
      privatePort: 25565
    }

    await signaling.requestConnection('peer-1', myInfo)

    expect(relayClient.signalTo).toBe('peer-1')
    const sent = relayClient.signalData as P2PSignalData
    expect(sent.type).toBe('connection-request')
    expect(sent.publicIp).toBe('1.2.3.4')
    expect(sent.publicPort).toBe(12345)
  })

  it('acceptConnection() 应发送接受响应', async () => {
    const myInfo: P2PSignalData = {
      type: 'connection-accept',
      publicIp: '5.6.7.8',
      publicPort: 54321
    }

    await signaling.acceptConnection('peer-1', myInfo)

    const sent = relayClient.signalData as P2PSignalData
    expect(sent.type).toBe('connection-accept')
    expect(sent.publicIp).toBe('5.6.7.8')
  })

  it('onSignal() 应接收并解析信令事件', async () => {
    const handler = vi.fn()
    signaling.onSignal(handler)

    // 模拟 relay client 收到 signal 事件
    const signalData: P2PSignalData = {
      type: 'connection-request',
      publicIp: '1.2.3.4',
      publicPort: 12345
    }
    relayClient.emit('signal', { from: 'peer-1', signalData })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('peer-1', signalData)
  })

  it('onSignal() 应忽略非法的信令数据', async () => {
    const handler = vi.fn()
    signaling.onSignal(handler)

    relayClient.emit('signal', { from: 'peer-1', signalData: { invalid: true } })
    // 没有 type 字段应被过滤
    expect(handler).not.toHaveBeenCalled()
  })

  it('removeSignalHandler() 应取消监听', async () => {
    const handler = vi.fn()
    signaling.onSignal(handler)
    signaling.removeSignalHandler()

    relayClient.emit('signal', { from: 'peer-1', signalData: { type: 'connection-request', publicIp: '1.2.3.4', publicPort: 12345 } })
    expect(handler).not.toHaveBeenCalled()
  })
})
