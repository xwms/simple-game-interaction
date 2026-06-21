/**
 * KCP STUN 公网地址发现测试
 *
 * 逻辑说明：验证 KcpTransport._queryPublicAddress() 的 STUN 协议解析正确性，
 *           STUN 响应过滤机制，以及 bound/public-addr 事件的正确发射。
 *           通过 mock dgram.Socket.send 控制 STUN 请求的发送结果，
 *           通过模拟触发 message 事件注入 STUN 响应数据。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as dgram from 'dgram'
import { KcpTransport } from '../../../src/core/tunnel/kcp-transport'

/** 默认超时时间 */
const TEST_TIMEOUT = 10000

/**
 * 功能描述：构造合法的 STUN Binding Response 数据包
 *
 * 逻辑说明：按照 STUN RFC 5389 规范构造包含 XOR-MAPPED-ADDRESS 属性的响应包。
 *           消息头（20 字节）+ XOR-MAPPED-ADDRESS 属性（12 字节）。
 *           IP 和端口经过 XOR 混淆后写入，测试解析逻辑能否正确还原。
 *
 * @param ip - 要编码在 STUN 响应中的 IP 地址
 * @param port - 要编码在 STUN 响应中的端口号
 * @returns 完整的 STUN 响应 Buffer（32 字节）
 */
function buildStunResponse(ip: string, port: number): Buffer {
  const parts = ip.split('.').map(Number)

  // XOR-MAPPED-ADDRESS attribute value（8 字节）
  const attrValue = Buffer.alloc(8)
  attrValue[0] = 0        // 保留字节
  attrValue[1] = 0x01     // 地址族：IPv4
  // X-Port = port ^ 0x2112（magic cookie 前 2 字节）
  attrValue.writeUInt16BE(port ^ 0x2112, 2)
  // X-Address = IP ^ magic cookie（4 字节）
  attrValue[4] = parts[0]! ^ 0x21
  attrValue[5] = parts[1]! ^ 0x12
  attrValue[6] = parts[2]! ^ 0xa4
  attrValue[7] = parts[3]! ^ 0x42

  // Attribute TLV 头（4 字节）
  const attrHeader = Buffer.alloc(4)
  attrHeader.writeUInt16BE(0x0020, 0) // XOR-MAPPED-ADDRESS
  attrHeader.writeUInt16BE(8, 2)       // 属性长度

  // STUN 消息头（20 字节）
  const header = Buffer.alloc(20)
  header.writeUInt16BE(0x0101, 0)       // Binding Success Response
  header.writeUInt16BE(12, 2)           // 消息长度（不含 20 字节头）
  header.writeUInt32BE(0x2112a442, 4)   // Magic Cookie
  // Transaction ID（12 字节），测试中用 0 填充

  return Buffer.concat([header, attrHeader, attrValue])
}

describe('KcpTransport STUN 公网地址发现', () => {
  let transport: KcpTransport

  beforeEach(() => {
    transport = new KcpTransport()
  })

  afterEach(async () => {
    try { await transport.disconnect() } catch { /* 忽略 */ }
    vi.restoreAllMocks()
  })

  // ═══════════════════════════════════════════════════════════
  //  Test 1: STUN XOR-MAPPED-ADDRESS 解析
  // ═══════════════════════════════════════════════════════════
  it('应正确解析 STUN XOR-MAPPED-ADDRESS（IPv4）', async () => {
    expect.hasAssertions()

    transport.setRole('passive')
    await transport.connect({ peerId: 'test' })

    // 获取主 socket 并 mock send（使 STUN 请求发送成功，不触发失败降级）
    const socket: dgram.Socket = (transport as any)._udpSockets[0]
    expect(socket).toBeTruthy()
    vi.spyOn(socket, 'send').mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1]
      if (typeof cb === 'function') (cb as (err: unknown) => void)(null)
    })

    // STUN 查询已由 listening 回调自动启动，注入 crafted 响应
    const stunResponse = buildStunResponse('1.2.3.4', 56789)
    const fakeRinfo = { address: 'stun.l.google.com', port: 19302, family: 'IPv4' as const, size: stunResponse.length }

    // 通过 socket 的 message 事件注入 STUN 响应
    socket.emit('message', stunResponse, fakeRinfo)

    // 等待 STUN 完成
    await vi.waitFor(
      () => {
        expect(transport.publicIp).toBe('1.2.3.4')
        expect(transport.publicPort).toBe(56789)
      },
      { timeout: TEST_TIMEOUT, interval: 50 }
    )
  }, TEST_TIMEOUT)

  // ═══════════════════════════════════════════════════════════
  //  Test 2: 多种 IP 地址的 XOR 解析
  // ═══════════════════════════════════════════════════════════
  it('应正确解析多种 IP 地址的 XOR-MAPPED-ADDRESS', async () => {
    expect.hasAssertions()

    const testCases = [
      { ip: '192.168.1.1', port: 12345 },
      { ip: '10.0.0.1', port: 80 },
      { ip: '172.16.0.1', port: 443 },
      { ip: '8.8.8.8', port: 53 },
      { ip: '114.114.114.114', port: 65535 },
      { ip: '0.0.0.0', port: 0 },
      { ip: '255.255.255.255', port: 65535 }
    ]

    for (const tc of testCases) {
      // 每个用例创建新 transport，避免 socket 状态污染
      const t = new KcpTransport()
      t.setRole('passive')
      await t.connect({ peerId: 'test' })

      const socket: dgram.Socket = (t as any)._udpSockets[0]
      vi.spyOn(socket, 'send').mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1]
        if (typeof cb === 'function') (cb as (err: unknown) => void)(null)
      })

      const response = buildStunResponse(tc.ip, tc.port)
      socket.emit('message', response, {
        address: 'stun.l.google.com',
        port: 19302,
        family: 'IPv4' as const,
        size: response.length
      })

      await vi.waitFor(
        () => {
          expect(t.publicIp).toBe(tc.ip)
          expect(t.publicPort).toBe(tc.port)
        },
        { timeout: 5000, interval: 50 }
      )

      await t.disconnect()
    }
  }, TEST_TIMEOUT)

  // ═══════════════════════════════════════════════════════════
  //  Test 3: STUN 失败（send 返回错误）→ 降级到本地端口
  // ═══════════════════════════════════════════════════════════
  it('STUN 发送失败时应降级，publicPort 等于 localPort', async () => {
    expect.hasAssertions()

    // Mock 所有 socket.send 使 STUN 请求立即失败
    vi.spyOn(dgram.Socket.prototype, 'send').mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1]
      if (typeof cb === 'function') (cb as (err: unknown) => void)(new Error('mock: network unreachable'))
    })

    transport.setRole('passive')
    await transport.connect({ peerId: 'test' })

    const localPort = transport.localPort
    expect(localPort).toBeGreaterThan(0)

    // STUN 请求全部失败后 pending 归零 → resolve(null)，
    // 等待其执行完成
    await vi.waitFor(
      () => {
        expect(transport.publicIp).toBeNull()
        expect(transport.publicPort).toBe(localPort)
      },
      { timeout: 5000, interval: 100 }
    )
  }, 8000)

  // ═══════════════════════════════════════════════════════════
  //  Test 4: 过滤 STUN 响应包
  // ═══════════════════════════════════════════════════════════
  it('_onMessage 应过滤 STUN 响应，不改变任何状态', () => {
    const stunResponse = buildStunResponse('1.2.3.4', 56789)

    // 直接调用私有 _onMessage 方法
    const stateBefore = {
      kcp: (transport as any)._kcp,
      connectionEstablished: (transport as any)._connectionEstablished,
      status: (transport as any)._status
    }

    ;(transport as any)._onMessage(
      stunResponse,
      { address: '1.2.3.4', port: 3478, family: 'IPv4' as const },
      0
    )

    // STUN 过滤后不应改变任何状态
    expect((transport as any)._kcp).toBe(stateBefore.kcp)
    expect((transport as any)._connectionEstablished).toBe(stateBefore.connectionEstablished)
    expect((transport as any)._status).toBe(stateBefore.status)
  })

  // ═══════════════════════════════════════════════════════════
  //  Test 5: bound 事件携带正确的本地端口
  // ═══════════════════════════════════════════════════════════
  it('bound 事件应在绑定后发射，携带本地端口', async () => {
    expect.hasAssertions()

    const boundPromise = new Promise<number>((resolve) => {
      transport.on('bound', (localPort: number) => {
        resolve(localPort)
      })
    })

    transport.setRole('passive')
    await transport.connect({ peerId: 'test' })

    const boundPort = await boundPromise
    expect(boundPort).toBeGreaterThan(0)
    expect(boundPort).toBe(transport.localPort)
  }, TEST_TIMEOUT)

  // ═══════════════════════════════════════════════════════════
  //  Test 6: public-addr 事件在 STUN 完成后发射
  // ═══════════════════════════════════════════════════════════
  it('public-addr 事件应在 STUN 完成后发射正确公网地址', async () => {
    expect.hasAssertions()

    transport.setRole('passive')

    const publicAddrPromise = new Promise<{ port: number; ip: string; localPort: number }>((resolve) => {
      transport.on('public-addr', (pubPort: number, pubIp: string, localPort: number) => {
        resolve({ port: pubPort, ip: pubIp, localPort })
      })
    })

    await transport.connect({ peerId: 'test' })

    // Mock socket.send 使 STUN 请求成功
    const socket: dgram.Socket = (transport as any)._udpSockets[0]
    vi.spyOn(socket, 'send').mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1]
      if (typeof cb === 'function') (cb as (err: unknown) => void)(null)
    })

    // 注入 STUN 响应
    const stunResponse = buildStunResponse('203.0.113.5', 42846)
    socket.emit('message', stunResponse, {
      address: 'stun.l.google.com',
      port: 19302,
      family: 'IPv4' as const,
      size: stunResponse.length
    })

    const result = await publicAddrPromise
    expect(result.port).toBe(42846)
    expect(result.ip).toBe('203.0.113.5')
    expect(result.localPort).toBe(transport.localPort)
  }, TEST_TIMEOUT)

  // ═══════════════════════════════════════════════════════════
  //  Test 7: 断开连接时清除公网地址状态
  // ═══════════════════════════════════════════════════════════
  it('disconnect() 应重置 publicIp 和 publicPort', async () => {
    transport.setRole('passive')
    await transport.connect({ peerId: 'test' })

    // 模拟设置公网地址（STUN 已完成的状态）
    ;(transport as any)._publicIp = '1.2.3.4'
    ;(transport as any)._publicPort = 56789

    await transport.disconnect()

    expect(transport.publicIp).toBeNull()
    expect(transport.publicPort).toBeNull()
  })

  // ═══════════════════════════════════════════════════════════
  //  Test 8: 多 socket 绑定后 bound 只发射一次
  // ═══════════════════════════════════════════════════════════
  it('connect() 在所有 socket 绑定完成后只发射一次 bound 事件', async () => {
    expect.hasAssertions()

    let boundCount = 0
    transport.on('bound', () => { boundCount++ })

    transport.setRole('passive')
    await transport.connect({ peerId: 'test' })

    // bound 应在所有 socket 绑定完成后发射一次
    expect(boundCount).toBe(1)
    // passive 模式 connect() resolve 时仅表示 UDP 已就绪，
    // 状态仍为 'connecting'，对端首包到达后才变为 'connected'
    expect(transport.status).toBe('connecting')
    expect(transport.localPort).toBeGreaterThan(0)
  }, TEST_TIMEOUT)
})
