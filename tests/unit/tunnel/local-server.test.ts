/**
 * 本地 TCP 隧道服务端测试
 *
 * 逻辑说明：通过真实 TCP 客户端连接 LocalTunnelServer，
 *           验证数据转发和连接管理功能。
 *           使用 Mock Transport 模拟远端传输层。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as net from 'net'
import { EventEmitter } from 'events'
import { LocalTunnelServer } from '../../../src/core/tunnel/local-server'
import { TRANSPORT_EVENTS } from '../../../src/core/transports'
import type { Transport, PeerConnectionInfo } from '../../../src/core/transports'
import type { TransportStatus } from '../../../src/shared/types'

class MockTransport extends EventEmitter implements Transport {
  readonly type = 'p2p' as const
  status: TransportStatus = 'disconnected'
  sentData: Buffer[] = []

  async connect(_peerInfo: PeerConnectionInfo): Promise<void> {
    this.status = 'connected'
    this.emit(TRANSPORT_EVENTS.STATUS, 'connected')
  }
  async disconnect(): Promise<void> {
    this.status = 'disconnected'
    this.emit(TRANSPORT_EVENTS.CLOSE)
  }
  async send(data: Buffer): Promise<void> {
    this.sentData.push(data)
  }
  /** 模拟收到远端数据 */
  simulateRemoteData(data: Buffer): void {
    this.emit(TRANSPORT_EVENTS.DATA, data)
  }
}

describe('LocalTunnelServer 本地隧道服务端', () => {
  let server: LocalTunnelServer
  let transport: MockTransport
  let localPort: number

  beforeEach(async () => {
    server = new LocalTunnelServer()
    transport = new MockTransport()
    localPort = await server.start(0)
    server.setTransport(transport)
  })

  afterEach(async () => {
    try { await server.stop() } catch { /* ignore */ }
  })

  it('start() 应在指定端口启动', async () => {
    expect(localPort).toBeGreaterThan(0)
    expect(server.localPort).toBe(localPort)
    expect(server.status).toBe('connected')
  })

  it('客户端连接后应计入 clientCount', async () => {
    const client = net.createConnection({ host: '127.0.0.1', port: localPort })
    await new Promise<void>((resolve) => client.on('connect', () => resolve()))
    // 等待服务端处理 connection 事件（CI 环境下事件循环时序有差异）
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout waiting for client')), 3000)
      const check = () => {
        if (server.clientCount >= 1) {
          clearTimeout(timeout)
          resolve()
        } else {
          setImmediate(check)
        }
      }
      setImmediate(check)
    })

    expect(server.clientCount).toBe(1)
    client.destroy()
  })

  it('客户端发送的数据应通过 transport 转发', async () => {
    const client = net.createConnection({ host: '127.0.0.1', port: localPort })
    await new Promise<void>((resolve) => client.on('connect', () => resolve()))

    client.write(Buffer.from([0x01, 0x02, 0x03]))

    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    expect(transport.sentData.length).toBeGreaterThanOrEqual(1)

    const sent = transport.sentData[transport.sentData.length - 1]
    expect(sent).toEqual(Buffer.from([0x01, 0x02, 0x03]))
    client.destroy()
  })

  it('transport 收到数据应转发到所有客户端', async () => {
    const client = net.createConnection({ host: '127.0.0.1', port: localPort })
    await new Promise<void>((resolve) => client.on('connect', () => resolve()))
    // 确保服务端已完成 connection 处理
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout waiting for client')), 3000)
      const check = () => {
        if (server.clientCount >= 1) {
          clearTimeout(timeout)
          resolve()
        } else {
          setImmediate(check)
        }
      }
      setImmediate(check)
    })

    const dataPromise = new Promise<Buffer>((resolve) => {
      client.on('data', (data: Buffer) => resolve(data))
    })

    transport.simulateRemoteData(Buffer.from([0xAA, 0xBB]))
    const received = await dataPromise
    expect(received).toEqual(Buffer.from([0xAA, 0xBB]))
    client.destroy()
  })

  it('start() 端口冲突时自动尝试下一个', async () => {
    const server2 = new LocalTunnelServer()
    const port2 = await server2.start(0)
    expect(port2).toBeGreaterThan(0)
    await server2.stop()
  })

  it('stop() 应断开所有客户端', async () => {
    const client = net.createConnection({ host: '127.0.0.1', port: localPort })
    await new Promise<void>((resolve) => client.on('connect', () => resolve()))

    const closePromise = new Promise<void>((resolve) => {
      client.on('close', () => resolve())
    })

    await server.stop()
    await closePromise
    expect(server.clientCount).toBe(0)
  })

  it('多个客户端可同时连接', async () => {
    const connectedClients: string[] = []
    server.on('client-connected', (data: { remoteAddr: string }) => {
      connectedClients.push(data.remoteAddr)
    })

    const client1 = net.createConnection({ host: '127.0.0.1', port: localPort })
    const client2 = net.createConnection({ host: '127.0.0.1', port: localPort })
    await Promise.all([
      new Promise<void>((resolve) => client1.on('connect', () => resolve())),
      new Promise<void>((resolve) => client2.on('connect', () => resolve()))
    ])
    // 等待服务端处理两个 connection 事件（CI 环境下事件循环时序有差异）
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timeout waiting for 2 clients')), 3000)
      const check = () => {
        if (connectedClients.length >= 2) {
          clearTimeout(timeout)
          resolve()
        } else {
          setImmediate(check)
        }
      }
      setImmediate(check)
    })

    expect(server.clientCount).toBe(2)
    client1.destroy()
    client2.destroy()
  })
})
