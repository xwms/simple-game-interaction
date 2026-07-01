/**
 * Relay 客户端测试
 *
 * 逻辑说明：模拟 WebSocket 服务器验证 RelayClient 的协议实现。
 *           使用真实 WebSocket 服务器（本地 ephemeral 端口）进行测试。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { RelayClient } from '../../../src/core/tunnel/relay-client'
import type { RelayConfig } from '../../../src/core/tunnel/types'
import { RELAY_MESSAGE_TYPES } from '../../../src/core/tunnel/types'
import { WebSocketServer, WebSocket } from 'ws'
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
  /** 服务端到客户端的连接引用（用于向客户端发送数据） */
  let clientWs: WebSocket | null = null

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
   *
   * @param configOverrides - 可选的配置覆盖（心跳间隔/超时等）
   */
  async function startClient(configOverrides?: Partial<RelayConfig>): Promise<void> {
    client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${port}`,
      reconnectMaxAttempts: 1,
      reconnectBaseDelay: 100,
      connectTimeout: 3000,
      heartbeatInterval: 5000,
      heartbeatTimeout: 15000,
      ...configOverrides
    })

    // 让服务器记录收到的消息
    server.on('connection', (ws) => {
      clientWs = ws
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

    await expect(client.connect()).rejects.toThrow(/timed out/)
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
    serverSend('room-created', { roomCode: 'ABC123', memberId: 'server-1' })

    const result = await resultPromise
    expect(result.roomCode).toBe('ABC123')
    expect(result.memberId).toBe('server-1')
  })

  it('joinRoom() 应发送 JSON 并等待 room-joined 响应', async () => {
    await startClient()

    const resultPromise = client.joinRoom('ABC123', {
      memberName: 'GuestPlayer',
      networkInfo: {
        ipv6: { available: false, hasPublicV6: false, addresses: [] },
        ipv4: { natType: 'easy-nat', publicIp: '5.6.7.8', publicPort: 54321 }
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
      memberId: 'client-1',
      serverId: 'server-1',
      serverNetworkInfo: {
        ipv6: { available: false, hasPublicV6: false, addresses: [] },
        ipv4: { natType: 'none', publicIp: '1.2.3.4', publicPort: 12345 }
      }
    })

    const result = await resultPromise
    expect(result.roomCode).toBe('ABC123')
    expect(result.memberId).toBe('client-1')
    expect(result.serverNetworkInfo?.ipv4.publicIp).toBe('1.2.3.4')
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
      memberId: 'client-1',
      memberName: 'TestPlayer',
      networkInfo: {
        ipv6: { available: false, hasPublicV6: false, addresses: [] },
        ipv4: { natType: 'easy-nat', publicIp: '5.6.7.8', publicPort: 54321 }
      }
    })

    const event = await eventPromise
    expect(event.memberId).toBe('client-1')
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

  // ─── 心跳测试 ─────────────────────────────────────────

  it('连接后应定期发送心跳消息', async () => {
    // 直接监听 server 的 message 事件，避免 allReceived 兼容问题
    const heartbeatReceived = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('未在超时前收到心跳消息')), 4000)
      server.on('connection', (ws) => {
        ws.on('message', (data: unknown) => {
          const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : ''
          try {
            if (JSON.parse(text).type === 'heartbeat') {
              clearTimeout(timeout)
              resolve()
            }
          } catch { /* ignore non-JSON */ }
        })
      })
    })

    client = new RelayClient({
      relayUrl: `ws://127.0.0.1:${port}`,
      reconnectMaxAttempts: 1,
      heartbeatInterval: 500
    })
    await client.connect()

    await heartbeatReceived
    await client.disconnect()
  })

  it('连接断开后应自动重连', async () => {
    await startClient({ reconnectBaseDelay: 100 })

    // 等待第二次 connected（初始连接 + 断开重连）
    const reconnectEvent = new Promise<void>((resolve) => {
      let connectedCount = 1 // 已连接一次（startClient 中 connect 触发）
      client!.on('connected', () => {
        connectedCount++
        if (connectedCount >= 2) resolve()
      })
    })

    // 让服务器断开连接，触发客户端重连
    for (const ws of server.clients) {
      ws.close()
    }

    await expect(reconnectEvent).resolves.toBeUndefined()
  }, 10000) // 10s timeout

  it('心跳发送成功即可保持连接活跃（无需服务端回显）', async () => {
    // 服务端不发任何消息，仅靠客户端心跳维持连接
    // heartbeatTimeout=2000ms 但心跳发送成功会更新 _lastPongTime
    await startClient({ heartbeatInterval: 500, heartbeatTimeout: 2000 })

    let disconnected = false
    client.on('disconnected', () => {
      disconnected = true
    })

    // 等 5 秒确认未因服务端静默而断开
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 5000)
    })

    expect(disconnected).toBe(false)
    expect(client.state).toBe('connected')
  }, 10000) // 10s timeout

  // ─── 消息路由测试 ─────────────────────────────────────────

  it('收到文本帧（JSON 控制消息）应触发对应事件', async () => {
    await startClient()

    const eventPromise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for member-joined')), 2000)
      client.on(RELAY_MESSAGE_TYPES.MEMBER_JOINED, (data) => {
        clearTimeout(timer)
        resolve(data)
      })
    })

    clientWs!.send(JSON.stringify({
      type: RELAY_MESSAGE_TYPES.MEMBER_JOINED,
      data: { memberId: 'test-1', memberName: 'TestPlayer', networkInfo: null }
    }))

    const event = await eventPromise
    expect(event.memberId).toBe('test-1')
    expect(event.memberName).toBe('TestPlayer')
  })

  it('收到二进制帧（游戏数据）应发射 RELAY_DATA', async () => {
    await startClient()

    const dataPromise = new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for RELAY_DATA')), 2000)
      client.on(RELAY_MESSAGE_TYPES.RELAY_DATA, (payload: Buffer) => {
        clearTimeout(timer)
        resolve(payload)
      })
    })

    const gameData = Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50])
    clientWs!.send(gameData)

    const payload = await dataPromise
    expect(payload).toEqual(gameData)
  })

  it('二进制帧内容恰好为合法 JSON 时不应被误判为文本消息', async () => {
    await startClient()

    const relayDataPromise = new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out — data was misrouted as text')), 2000)
      client.on(RELAY_MESSAGE_TYPES.RELAY_DATA, (payload: Buffer) => {
        clearTimeout(timer)
        resolve(payload)
      })
    })

    // 游戏数据恰好以 { 开头且可被 JSON.parse
    const jsonLikeData = Buffer.from('{"type":"game","cmd":"move","x":1}')
    clientWs!.send(jsonLikeData)

    const payload = await relayDataPromise
    expect(payload).toEqual(jsonLikeData)
  })

  it('极小二进制帧（1-3 字节）应正确转发', async () => {
    await startClient()

    const dataPromise = new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for small RELAY_DATA')), 2000)
      client.on(RELAY_MESSAGE_TYPES.RELAY_DATA, (payload: Buffer) => {
        clearTimeout(timer)
        resolve(payload)
      })
    })

    // 模拟任意游戏协议中的小包（如 keep-alive / ack）
    clientWs!.send(Buffer.from([0x00, 0x01, 0x02]))

    const payload = await dataPromise
    expect(payload.length).toBe(3)
    expect(payload).toEqual(Buffer.from([0x00, 0x01, 0x02]))
  })

  it('文本帧与二进制帧交替到达时路由应正确', async () => {
    await startClient()

    const textEvents: any[] = []
    const binaryEvents: Buffer[] = []

    client.on(RELAY_MESSAGE_TYPES.MEMBER_JOINED, (data) => textEvents.push(data))
    client.on(RELAY_MESSAGE_TYPES.RELAY_DATA, (data: Buffer) => binaryEvents.push(data))

    // 1. 控制消息
    clientWs!.send(JSON.stringify({
      type: RELAY_MESSAGE_TYPES.MEMBER_JOINED,
      data: { memberId: 'p1', memberName: 'P1', networkInfo: null }
    }))
    await new Promise(r => setTimeout(r, 50))

    // 2. 游戏数据
    clientWs!.send(Buffer.from([0x01, 0x02, 0x03]))
    await new Promise(r => setTimeout(r, 50))

    // 3. 控制消息
    clientWs!.send(JSON.stringify({
      type: RELAY_MESSAGE_TYPES.MEMBER_JOINED,
      data: { memberId: 'p2', memberName: 'P2', networkInfo: null }
    }))
    await new Promise(r => setTimeout(r, 50))

    // 4. 游戏数据
    clientWs!.send(Buffer.from([0x04, 0x05]))
    await new Promise(r => setTimeout(r, 50))

    expect(textEvents.length).toBe(2)
    expect(binaryEvents.length).toBe(2)
    expect(binaryEvents[0]).toEqual(Buffer.from([0x01, 0x02, 0x03]))
    expect(binaryEvents[1]).toEqual(Buffer.from([0x04, 0x05]))
  })
})
