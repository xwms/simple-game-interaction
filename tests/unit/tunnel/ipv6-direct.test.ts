/**
 * IPv6 TCP 直连传输测试
 *
 * 逻辑说明：通过创建本地 IPv6 TCP 服务器模拟对端，
 *           验证 Ipv6DirectTransport 的连接、发送和断开流程。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as net from 'net'
import { Ipv6DirectTransport } from '../../../src/core/tunnel/ipv6-direct'
import { TRANSPORT_EVENTS } from '../../../src/core/connection'

describe('Ipv6DirectTransport IPv6 直连传输', () => {
  let server: net.Server
  let serverPort: number
  let transport: Ipv6DirectTransport

  beforeEach(async () => {
    // 创建 localhost IPv6 TCP 服务器
    server = net.createServer()
    await new Promise<void>((resolve, reject) => {
      server.on('listening', () => {
        const addr = server.address() as net.AddressInfo
        serverPort = addr.port
        resolve()
      })
      server.on('error', reject)
      server.listen(0, '::1')
    })
  })

  afterEach(async () => {
    if (transport) {
      try { await transport.disconnect() } catch { /* ignore */ }
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })

  it('connect() 应成功连接到 IPv6 地址', async () => {
    transport = new Ipv6DirectTransport(3000)

    // 让服务器接受连接
    const acceptPromise = new Promise<net.Socket>((resolve) => {
      server.on('connection', (socket) => resolve(socket))
    })

    await transport.connect({
      peerId: 'test-peer',
      ipv6Address: '::1',
      ipv6Port: serverPort
    })

    expect(transport.status).toBe('connected')
    const clientSocket = await acceptPromise
    expect(clientSocket).toBeTruthy()
  })

  it('connect() 应拒绝无效地址', async () => {
    transport = new Ipv6DirectTransport(1000)

    await expect(transport.connect({
      peerId: 'test',
      ipv6Address: '',  // 无效地址
      ipv6Port: 0       // 无效端口
    })).rejects.toThrow(/无效/)
  })

  it('send() 应发送数据到对端', async () => {
    transport = new Ipv6DirectTransport(3000)

    const dataPromise = new Promise<Buffer>((resolve) => {
      server.on('connection', (socket) => {
        socket.on('data', (data: Buffer) => resolve(data))
      })
    })

    await transport.connect({
      peerId: 'test-peer',
      ipv6Address: '::1',
      ipv6Port: serverPort
    })

    await transport.send(Buffer.from([0x10, 0x20, 0x30]))
    const received = await dataPromise
    expect(received).toEqual(Buffer.from([0x10, 0x20, 0x30]))
  })

  it('disconnect() 应断开连接', async () => {
    transport = new Ipv6DirectTransport(3000)

    await transport.connect({
      peerId: 'test-peer',
      ipv6Address: '::1',
      ipv6Port: serverPort
    })

    const closePromise = new Promise<void>((resolve) => {
      transport.on(TRANSPORT_EVENTS.CLOSE, () => resolve())
    })

    await transport.disconnect()
    await closePromise

    expect(transport.status).toBe('disconnected')
  })

  it('发送数据到无连接应抛出错误', async () => {
    transport = new Ipv6DirectTransport(1000)

    await expect(transport.send(Buffer.from([0x01])))
      .rejects.toThrow(/未连接/)
  })
})
