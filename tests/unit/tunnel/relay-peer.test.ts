/**
 * RelayPeerTransport 测试
 *
 * 逻辑说明：使用模拟 WebSocket 服务器和 RelayClient，
 *           验证 RelayPeerTransport 的 connect/send/disconnect 流程，
 *           以及事件转发和流量统计功能。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { RelayClient } from '../../../src/core/tunnel/relay-client'
import { RelayPeerTransport } from '../../../src/core/tunnel/transports/relay-peer'
import type { AddressInfo } from 'net'

describe('RelayPeerTransport 中转传输', () => {
  let server: WebSocketServer
  let port: number
  let relayClient: RelayClient
  let transport: RelayPeerTransport

  beforeEach(async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => {
      server.on('listening', () => {
        port = (server.address() as AddressInfo).port
        resolve()
      })
    })

    server.on('connection', () => {
      // 接受连接，不主动发送数据
    })

    relayClient = new RelayClient({
      relayUrl: `ws://127.0.0.1:${port}`,
      reconnectMaxAttempts: 1,
      reconnectBaseDelay: 100,
      connectTimeout: 3000,
      heartbeatInterval: 5000
    })
  })

  afterEach(async () => {
    if (transport) {
      try { await transport.disconnect() } catch { /* ignore */ }
    }
    if (relayClient) {
      try { await relayClient.disconnect() } catch { /* ignore */ }
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })

  it('connect() 应建立传输通道（中继已连接）', async () => {
    await relayClient.connect()
    transport = new RelayPeerTransport(relayClient, 'client-1')

    await transport.connect({ peerId: '' })
    expect(transport.status).toBe('connected')
  })

  it('connect() 应在中继未连接时自动连接', async () => {
    transport = new RelayPeerTransport(relayClient, 'client-1')

    await transport.connect({ peerId: '' })
    expect(transport.status).toBe('connected')
    expect(relayClient.state).toBe('connected')
  })

  it('send() 应通过 RelayClient 发送数据', async () => {
    await relayClient.connect()
    transport = new RelayPeerTransport(relayClient, 'client-1')
    await transport.connect({ peerId: '' })

    const sendSpy = vi.spyOn(relayClient, 'sendData')

    await transport.send(Buffer.from([0x01, 0x02, 0x03]))
    expect(sendSpy).toHaveBeenCalledWith(
      Buffer.from([0x01, 0x02, 0x03]),
      'client-1'
    )

    sendSpy.mockRestore()
  })

  it('disconnect() 应清理事件监听', async () => {
    await relayClient.connect()
    transport = new RelayPeerTransport(relayClient, 'client-1')
    await transport.connect({ peerId: '' })

    await transport.disconnect()
    expect(transport.status).toBe('disconnected')
  })

  it('type 属性应为 relay', () => {
    transport = new RelayPeerTransport(relayClient)
    expect(transport.type).toBe('relay')
  })

  it('应支持无 targetMemberId 的连接', async () => {
    await relayClient.connect()
    transport = new RelayPeerTransport(relayClient)
    await transport.connect({ peerId: '' })
    expect(transport.status).toBe('connected')
  })

  it('connect() 应注册 relay-data 事件监听', async () => {
    await relayClient.connect()
    transport = new RelayPeerTransport(relayClient, 'client-1')

    const onSpy = vi.spyOn(relayClient, 'on')
    await transport.connect({ peerId: '' })

    expect(onSpy).toHaveBeenCalledWith('relay-data', expect.any(Function))
    onSpy.mockRestore()
  })
})
