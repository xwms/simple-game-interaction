/**
 * Relay 客户端测试
 *
 * 逻辑说明：模拟 WebSocket 服务器验证 RelayClient 的协议实现。
 *           使用真实 WebSocket 服务器（本地 ephemeral 端口）进行测试。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { RelayClient } from '../../../src/core/tunnel/relay-client'
import { WebSocketServer } from 'ws'
import * as net from 'net'
import type { AddressInfo } from 'net'

describe('RelayClient 协议实现', () => {
  let server: WebSocketServer
  let port: number
  let client: RelayClient
  /** 服务器收到的最后一个消息 */
  let lastReceived: string | Buffer | null = null
  /** 收到的所有消息 */
  let allReceived: Array<string | Buffer> = []
  /** 服务器是否应主动关闭连接 */
  let shouldCloseOnOpen = false

  beforeEach(async () => {
    shouldCloseOnOpen = false
    lastReceived = null
    allReceived = []

    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => {
      server.on('listening', () => {
        port = (server.address() as AddressInfo).port
        resolve()
      })
    })
  })

  afterEach(async () => {
    if (client) {
      try { await client.disconnect() } catch { /* ignore */ }
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })

  /**
   * 功能描述：辅助函数 — 启动客户端并等待连接建立
   */
  async function startClient(): Promise<void> {
    client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${port}`,
      reconnectMaxAttempts: 1,
      reconnectBaseDelay: 100,
      connectTimeout: 3000,
      heartbeatInterval: 5000
    })

    // 让服务器记录收到的消息
    server.on('connection', (ws) => {
      if (shouldCloseOnOpen) {
        ws.close()
        return
      }
      ws.on('message', (data) => {
        lastReceived = data
        allReceived.push(data)
      })
    })

    await client.connect()
  }

  /**
   * 功能描述：辅助函数 — 服务器发送 JSON 消息到客户端
   */
  function serverSend(type: string, data?: unknown, messageId?: string): void {
    const srv = server as WebSocketServer
    const clients = srv.clients

    // 如果未指定 messageId，尝试从最近一条请求中提取
    if (!messageId && allReceived.length > 0) {
      const last = allReceived[allReceived.length - 1]
      const text = typeof last === 'string' ? last : Buffer.isBuffer(last) ? last.toString('utf8') : null
      if (text) {
        try {
          const parsed = JSON.parse(text)
          if (parsed.messageId) messageId = parsed.messageId
        } catch { /* ignore */ }
      }
    }

    for (const ws of clients) {
      ws.send(JSON.stringify({
        type,
        data,
        messageId: messageId || undefined
      }))
    }
  }

  it('connect() 应建立 WebSocket 连接', async () => {
    await startClient()
    expect(client.state).toBe('connected')
  })

  it('connect() 应超时失败', async () => {
    // 先关闭 beforeEach 创建的 WebSocket 服务器
    await new Promise<void>((resolve) => server.close(() => resolve()))

    // 创建一个纯 TCP 服务器，接受 TCP 连接但不完成 WebSocket 升级握手
    const tcpServer = net.createServer()
    await new Promise<void>((resolve) => {
      tcpServer.listen(0, '127.0.0.1', () => resolve())
    })
    const tcpPort = (tcpServer.address() as AddressInfo).port

    client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${tcpPort}`,
      connectTimeout: 500,
      reconnectMaxAttempts: 1
    })

    await expect(client.connect()).rejects.toThrow(/超时/)
    tcpServer.close()
  })

  it('createRoom() 应发送 JSON 并等待 room-created 响应', async () => {
    await startClient()

    const resultPromise = client.createRoom({
      gameId: 'minecraft-java',
      gameName: 'Minecraft',
      gamePort: 25565,
      memberName: 'HostPlayer',
      networkInfo: {
        ipv6: { available: false, hasPublicV6: false, addresses: [] },
        ipv4: { natType: 'none', publicIp: '1.2.3.4', publicPort: 12345 }
      }
    })

    // 验证客户端发送的消息
    await new Promise<void>((resolve) => {
      const check = () => {
        if (lastReceived) {
          const msg = JSON.parse(lastReceived as string)
          expect(msg.type).toBe('create-room')
          expect(msg.data.gameId).toBe('minecraft-java')
          expect(msg.data.gamePort).toBe(25565)
          resolve()
        } else {
          setTimeout(check, 50)
        }
      }
      check()
    })

    // 服务器回复 room-created
    serverSend('room-created', { roomCode: 'ABC123', memberId: 'host-1' })

    const result = await resultPromise
    expect(result.roomCode).toBe('ABC123')
    expect(result.memberId).toBe('host-1')
  })

  it('joinRoom() 应发送 JSON 并等待 room-joined 响应', async () => {
    await startClient()

    const resultPromise = client.joinRoom('ABC123', {
      memberName: 'GuestPlayer',
      networkInfo: {
        ipv6: { available: false, hasPublicV6: false, addresses: [] },
        ipv4: { natType: 'full-cone', publicIp: '5.6.7.8', publicPort: 54321 }
      }
    })

    // 验证客户端发送的消息
    await new Promise<void>((resolve) => {
      const check = () => {
        if (lastReceived) {
          const msg = JSON.parse(lastReceived as string)
          expect(msg.type).toBe('join-room')
          expect(msg.data.roomCode).toBe('ABC123')
          resolve()
        } else {
          setTimeout(check, 50)
        }
      }
      check()
    })

    // 服务器回复 room-joined
    serverSend('room-joined', {
      roomCode: 'ABC123',
      memberId: 'guest-1',
      hostId: 'host-1',
      hostNetworkInfo: {
        ipv6: { available: false, hasPublicV6: false, addresses: [] },
        ipv4: { natType: 'none', publicIp: '1.2.3.4', publicPort: 12345 }
      }
    })

    const result = await resultPromise
    expect(result.roomCode).toBe('ABC123')
    expect(result.memberId).toBe('guest-1')
    expect(result.hostNetworkInfo?.ipv4.publicIp).toBe('1.2.3.4')
  })

  it('leaveRoom() 应发送 leave-room 消息', async () => {
    await startClient()
    client['_roomCode'] = 'ABC123' // 设置房间码

    await client.leaveRoom()

    await new Promise<void>((resolve) => {
      const check = () => {
        if (lastReceived) {
          const msg = JSON.parse(lastReceived as string)
          expect(msg.type).toBe('leave-room')
          resolve()
        } else {
          setTimeout(check, 50)
        }
      }
      check()
    })

    expect(client.roomCode).toBe('')
  })

  it('member-joined 事件应正确发射', async () => {
    await startClient()

    const eventPromise = new Promise<any>((resolve) => {
      client.on('member-joined', (data) => resolve(data))
    })

    serverSend('member-joined', {
      memberId: 'guest-1',
      memberName: 'TestPlayer',
      networkInfo: {
        ipv6: { available: false, hasPublicV6: false, addresses: [] },
        ipv4: { natType: 'full-cone', publicIp: '5.6.7.8', publicPort: 54321 }
      }
    })

    const event = await eventPromise
    expect(event.memberId).toBe('guest-1')
    expect(event.memberName).toBe('TestPlayer')
  })

  it('sendData() 应发送二进制帧', async () => {
    await startClient()

    client.sendData(Buffer.from([0x01, 0x02, 0x03]))

    await new Promise<void>((resolve) => {
      const check = () => {
        if (lastReceived && Buffer.isBuffer(lastReceived)) {
          // 帧格式: [4B 长度][负载]
          expect(lastReceived.length).toBe(4 + 3)
          expect(lastReceived.readUInt32BE(0)).toBe(3)
          expect(lastReceived[4]).toBe(0x01)
          expect(lastReceived[5]).toBe(0x02)
          expect(lastReceived[6]).toBe(0x03)
          resolve()
        } else {
          setTimeout(check, 50)
        }
      }
      check()
    })
  })

  it('disconnect() 应清理所有资源', async () => {
    await startClient()
    await client.disconnect()
    expect(client.state).toBe('disconnected')
    expect(client.memberId).toBe('')
    expect(client.roomCode).toBe('')
  })
})
