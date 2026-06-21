/**
 * P2pTransport TCP 直连测试
 *
 * 逻辑说明：使用本地 TCP 连接验证 P2P 传输的 active/passive 角色通信。
 *           Passive 方创建临时 TCP 服务器，Active 方连接并交换数据。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { P2pTransport } from '../../../src/core/p2p/peer-connection'

describe('P2pTransport TCP 直连', () => {
  let passiveTransport: P2pTransport
  let activeTransport: P2pTransport
  let passivePort: number

  afterEach(async () => {
    if (activeTransport) {
      try { await activeTransport.disconnect() } catch { /* ignore */ }
    }
    if (passiveTransport) {
      try { await passiveTransport.disconnect() } catch { /* ignore */ }
    }
  })

  it('passive 方应创建 TCP 服务器并返回本地端口', async () => {
    passiveTransport = new P2pTransport({ connectTimeout: 3000 })
    passiveTransport.setRole('passive')
    await passiveTransport.connect({ peerId: 'test-peer' })

    expect(passiveTransport.localPort).toBeGreaterThan(0)
    // passive 模式 connect() 在服务器就绪时 resolve，此时状态为 connecting
    // （等待 active 方连接触发 _onConnected 后才变为 connected）
    expect(passiveTransport.status).toBe('connecting')
  })

  it('active 方应连接到 passive 方', async () => {
    passiveTransport = new P2pTransport({ connectTimeout: 3000 })
    passiveTransport.setRole('passive')
    await passiveTransport.connect({ peerId: 'host-1' })
    passivePort = passiveTransport.localPort!

    activeTransport = new P2pTransport({ connectTimeout: 3000 })
    activeTransport.setRole('active')
    await activeTransport.connect({
      peerId: 'guest-1',
      publicAddress: { ip: '127.0.0.1', port: passivePort }
    })

    expect(activeTransport.status).toBe('connected')
    // passive 方在有 active 连接后也应变为 connected
    await new Promise(r => setTimeout(r, 100))
    expect(passiveTransport.status).toBe('connected')
  })

  it('active 方应能发送数据到 passive 方', async () => {
    passiveTransport = new P2pTransport({ connectTimeout: 3000 })
    passiveTransport.setRole('passive')
    await passiveTransport.connect({ peerId: 'host-1' })
    passivePort = passiveTransport.localPort!

    activeTransport = new P2pTransport({ connectTimeout: 3000 })
    activeTransport.setRole('active')
    await activeTransport.connect({
      peerId: 'guest-1',
      publicAddress: { ip: '127.0.0.1', port: passivePort }
    })

    const dataPromise = new Promise<Buffer>((resolve) => {
      passiveTransport.on('data', (data: Buffer) => resolve(data))
    })

    await activeTransport.send(Buffer.from([0x01, 0x02, 0x03, 0x04]))

    const received = await dataPromise
    expect(received).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04]))
  })

  it('数据应能双向传输', async () => {
    passiveTransport = new P2pTransport({ connectTimeout: 3000 })
    passiveTransport.setRole('passive')
    await passiveTransport.connect({ peerId: 'host-1' })
    passivePort = passiveTransport.localPort!

    activeTransport = new P2pTransport({ connectTimeout: 3000 })
    activeTransport.setRole('active')
    await activeTransport.connect({
      peerId: 'guest-1',
      publicAddress: { ip: '127.0.0.1', port: passivePort }
    })

    // active → passive
    const passiveReceived = new Promise<Buffer>((resolve) => {
      passiveTransport.on('data', (data: Buffer) => resolve(data))
    })
    await activeTransport.send(Buffer.from([0x01, 0x02]))
    expect(await passiveReceived).toEqual(Buffer.from([0x01, 0x02]))

    // passive → active
    const activeReceived = new Promise<Buffer>((resolve) => {
      activeTransport.on('data', (data: Buffer) => resolve(data))
    })
    await passiveTransport.send(Buffer.from([0x03, 0x04]))
    expect(await activeReceived).toEqual(Buffer.from([0x03, 0x04]))
  })

  it('disconnect() 应断开连接并更新状态', async () => {
    passiveTransport = new P2pTransport({ connectTimeout: 3000 })
    passiveTransport.setRole('passive')
    await passiveTransport.connect({ peerId: 'host-1' })
    passivePort = passiveTransport.localPort!

    activeTransport = new P2pTransport({ connectTimeout: 3000 })
    activeTransport.setRole('active')
    await activeTransport.connect({
      peerId: 'guest-1',
      publicAddress: { ip: '127.0.0.1', port: passivePort }
    })

    await activeTransport.disconnect()
    expect(activeTransport.status).toBe('disconnected')
  })

  it('active 方连接失败应抛出错误', async () => {
    activeTransport = new P2pTransport({ connectTimeout: 500 })
    activeTransport.setRole('active')

    await expect(activeTransport.connect({
      peerId: 'guest-1',
      publicAddress: { ip: '127.0.0.1', port: 1 }
    })).rejects.toThrow()
  })

  it('缺少目标地址应抛出错误', async () => {
    activeTransport = new P2pTransport()
    activeTransport.setRole('active')

    await expect(activeTransport.connect({ peerId: 'guest-1' })).rejects.toThrow(/missing/)
  })

  it('type 属性应为 p2p', () => {
    const t = new P2pTransport()
    expect(t.type).toBe('p2p')
  })

  it('应优先使用私有地址进行连接', async () => {
    passiveTransport = new P2pTransport({ connectTimeout: 3000 })
    passiveTransport.setRole('passive')
    await passiveTransport.connect({ peerId: 'host-1' })
    passivePort = passiveTransport.localPort!

    activeTransport = new P2pTransport({ connectTimeout: 3000 })
    activeTransport.setRole('active')

    await activeTransport.connect({
      peerId: 'guest-1',
      localAddresses: [{ ip: '127.0.0.1', port: passivePort }],
      publicAddress: { ip: '192.168.1.1', port: 9999 }
    })

    expect(activeTransport.status).toBe('connected')
  })
})
