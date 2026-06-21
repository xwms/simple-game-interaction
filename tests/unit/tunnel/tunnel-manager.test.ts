/**
 * TunnelManager 隧道管理器测试
 *
 * 逻辑说明：验证 TunnelManager 的状态机、生命周期编排、事件发射。
 *           外部依赖（RelayClient、NetworkDetector、Transport 等）全部 Mock。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ─── 创建可引用 Mock（避免在 vi.hoisted 中使用 require） ──
const { createMockRelayClient, createMockDetector, createMockLocalServer } = vi.hoisted(() => {
  function makeEvented() {
    const handlers: Record<string, (...args: unknown[]) => void> = {}
    return {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => { handlers[event] = handler }),
      emit: vi.fn((event: string, ...args: unknown[]) => { handlers[event]?.(...args) }),
      removeAllListeners: vi.fn(),
      removeListener: vi.fn((event: string) => { delete handlers[event] }),
      listenerCount: vi.fn(() => 0),
      off: vi.fn()
    }
  }

  function createMockRelayClient() {
    return {
      ...makeEvented(),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      createRoom: vi.fn().mockResolvedValue({ roomCode: 'ABC123', memberId: 'server-1' }),
      joinRoom: vi.fn().mockResolvedValue({
        roomCode: 'ABC123', memberId: 'client-1', serverId: 'server-1', gamePort: 25565,
        serverNetworkInfo: {
          ipv6: { available: true, hasPublicV6: true, addresses: ['2001:db8::1'] },
          ipv4: { natType: 'easy-nat', publicIp: '1.2.3.4', publicPort: 12345, localAddresses: [] }
        },
        members: [{ id: 'server-1', name: 'ServerPlayer' }]
      }),
      leaveRoom: vi.fn().mockResolvedValue(undefined),
      sendSignal: vi.fn().mockResolvedValue(undefined),
      setServerMode: vi.fn(),
      sendData: vi.fn(),
      setRelayUrl: vi.fn(),
      state: 'connected',
      memberId: '',
      roomCode: ''
    }
  }

  function createMockDetector() {
    return {
      detect: vi.fn().mockResolvedValue({
        ipv6: { available: true, hasPublicV6: true, addresses: ['2001:db8::1'] },
        ipv4: { natType: 'easy-nat', publicIp: '1.2.3.4', publicPort: 12345, localAddresses: ['192.168.1.2'] }
      }),
      clearCache: vi.fn()
    }
  }

  function createMockLocalServer() {
    return {
      ...makeEvented(),
      start: vi.fn().mockResolvedValue(25565),
      stop: vi.fn().mockResolvedValue(undefined),
      setTransport: vi.fn(),
      removeAllListeners: vi.fn(),
      localPort: 25565,
      clientCount: 0
    }
  }

  return { createMockRelayClient, createMockDetector, createMockLocalServer }
})

// ─── Mock 外部依赖 ───────────────────────────────────
const mockRelayClient = vi.hoisted(() => createMockRelayClient())
const mockLocalServer = vi.hoisted(() => createMockLocalServer())
const mockLocalClient = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  setTransport: vi.fn(),
  connected: true,
  status: 'connected',
  on: vi.fn(),
  removeAllListeners: vi.fn()
}))
const mockTransport = vi.hoisted(() => ({
  type: 'ipv6',
  status: 'connected',
  on: vi.fn(),
  emit: vi.fn(),
  removeListener: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue(undefined),
  setRole: vi.fn(),
  localPort: 30000,
  removeAllListeners: vi.fn()
}))

vi.mock('../../../src/core/tunnel/relay-client', () => ({
  RelayClient: vi.fn().mockImplementation(() => mockRelayClient)
}))

vi.mock('../../../src/core/tunnel/local-server', () => ({
  LocalTunnelServer: vi.fn().mockImplementation(() => mockLocalServer)
}))

vi.mock('../../../src/core/tunnel/local-client', () => ({
  LocalTunnelClient: vi.fn().mockImplementation(() => mockLocalClient)
}))

vi.mock('../../../src/core/tunnel/ipv6-direct', () => ({
  Ipv6DirectTransport: vi.fn().mockImplementation(() => mockTransport)
}))

vi.mock('../../../src/core/p2p/peer-connection', () => ({
  P2pTransport: vi.fn().mockImplementation(() => mockTransport)
}))

vi.mock('../../../src/core/p2p/relay-peer', () => ({
  RelayPeerTransport: vi.fn().mockImplementation(() => mockTransport)
}))

vi.mock('../../../src/core/connection/path-selector', () => ({
  selectPath: vi.fn().mockReturnValue([
    { type: 'ipv6', description: 'IPv6 直连', priority: 1 },
    { type: 'p2p', description: 'P2P TCP 直连', priority: 2 },
    { type: 'relay', description: '中继转发', priority: 3 }
  ])
}))

vi.mock('../../../src/core/network-detect/detector', () => ({
  NetworkDetector: vi.fn().mockImplementation(() => createMockDetector())
}))

// ─── 导入被测试模块 ──────────────────────────────────
import { TunnelManager } from '../../../src/core/tunnel/tunnel-manager'

describe('TunnelManager 隧道管理器', () => {
  let manager: TunnelManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new TunnelManager()
  })

  afterEach(async () => {
    if (manager) {
      try { await manager.leaveRoom() } catch { /* ignore */ }
    }
  })

  it('初始状态应为 idle', () => {
    expect(manager.state).toBe('idle')
  })

  it('createRoom() 应完成完整创建流程', async () => {
    const result = await manager.createRoom({
      gameId: 'minecraft-java',
      gameName: 'Minecraft',
      gamePort: 25565
    })

    expect(result.roomCode).toBe('ABC123')
    expect(result.memberId).toBe('server-1')
    expect(manager.state).toBe('connected')
  })

  it('createRoom() 应使用自定义中继地址', async () => {
    const result = await manager.createRoom({
      gameId: 'minecraft-java',
      gameName: 'Minecraft',
      gamePort: 25565,
      relayUrl: 'ws://custom-relay:9800'
    })

    expect(result.roomCode).toBe('ABC123')
    expect(mockRelayClient.setRelayUrl).toHaveBeenCalledWith('ws://custom-relay:9800')
  })

  it('joinRoom() 应完成加入流程', async () => {
    await manager.joinRoom('ABC123')
    expect(manager.state).toBe('connected')
  })

  it('joinRoom() 应创建传输通道并启动本地隧道', async () => {
    await manager.joinRoom('ABC123')
    expect(mockTransport.connect).toHaveBeenCalled()
    expect(mockLocalServer.start).toHaveBeenCalled()
  })

  it('leaveRoom() 应清理所有资源并重置状态', async () => {
    await manager.createRoom({
      gameId: 'minecraft-java',
      gameName: 'Minecraft',
      gamePort: 25565
    })

    await manager.leaveRoom()
    expect(manager.state).toBe('idle')
    expect(mockRelayClient.leaveRoom).toHaveBeenCalled()
    expect(mockRelayClient.disconnect).toHaveBeenCalled()
  })

  it('setRelayUrl() 应更新中继地址', () => {
    manager.setRelayUrl('ws://new-relay:9800')
    expect(mockRelayClient.setRelayUrl).toHaveBeenCalledWith('ws://new-relay:9800')
  })

  it('getStatus() 应返回当前状态报告', async () => {
    const status = await manager.getStatus()
    expect(status).toHaveProperty('state')
    expect(status).toHaveProperty('localPort')
    expect(status).toHaveProperty('clientCount')
  })

  it('member-joined 事件应触发 server 侧传输设置', async () => {
    await manager.createRoom({
      gameId: 'minecraft-java',
      gameName: 'Minecraft',
      gamePort: 25565
    })

    // 模拟成员加入事件
    mockRelayClient.emit('member-joined', {
      memberId: 'client-1',
      memberName: 'TestPlayer',
      networkInfo: {
        ipv6: { available: true, hasPublicV6: true, addresses: ['2001:db8::2'] },
        ipv4: { natType: 'easy-nat', publicIp: '5.6.7.8', publicPort: 54321, localAddresses: ['192.168.1.3'] }
      }
    })

    // 给异步操作一点时间
    await new Promise(r => setTimeout(r, 50))
    expect(manager.state).toBe('connected')
  })

  it('member-left 事件应触发资源清理', async () => {
    await manager.createRoom({
      gameId: 'minecraft-java',
      gameName: 'Minecraft',
      gamePort: 25565
    })

    const cleanupPromise = new Promise<void>((resolve) => {
      manager.on('member-left', () => resolve())
    })

    mockRelayClient.emit('member-left', { memberId: 'client-1' })
    await cleanupPromise
  })

  it('应发射 connected 事件', async () => {
    const connectedPromise = new Promise<any>((resolve) => {
      manager.on('connected', (data) => resolve(data))
    })

    await manager.createRoom({
      gameId: 'minecraft-java',
      gameName: 'Minecraft',
      gamePort: 25565
    })

    const event = await connectedPromise
    expect(event).toHaveProperty('roomCode')
    expect(event.roomCode).toBe('ABC123')
  })

  it('应发射 disconnected 事件', async () => {
    const disconnectedPromise = new Promise<void>((resolve) => {
      manager.on('disconnected', () => resolve())
    })

    await manager.createRoom({
      gameId: 'minecraft-java',
      gameName: 'Minecraft',
      gamePort: 25565
    })
    await manager.leaveRoom()

    await disconnectedPromise
  })

  it('createRoom() 应设置 server 模式', async () => {
    await manager.createRoom({
      gameId: 'minecraft-java',
      gameName: 'Minecraft',
      gamePort: 25565
    })

    expect(mockRelayClient.setServerMode).toHaveBeenCalled()
  })
})
