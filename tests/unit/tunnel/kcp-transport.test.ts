/**
 * KCP UDP 打洞传输吞吐与死锁测试
 *
 * 逻辑说明：通过两个 KcpTransport 实例在本地回环地址建立连接，
 *           验证大数据量传输不会死锁。
 */

import { describe, it, expect, afterEach } from 'vitest'
import { KcpTransport } from '../../../src/core/tunnel/kcp-transport'
import { TRANSPORT_EVENTS } from '../../../src/core/connection'

describe('KcpTransport 大数据量传输', () => {
  const transports: KcpTransport[] = []

  afterEach(async () => {
    for (const t of transports) {
      try { await t.disconnect() } catch { /* ignore */ }
    }
    transports.length = 0
  })

  async function createConnectedPair(): Promise<{
    active: KcpTransport
    passive: KcpTransport
  }> {
    const passive = new KcpTransport()
    const active = new KcpTransport()
    transports.push(passive, active)

    passive.setRole('passive')
    await passive.connect({ peerId: 'passive-test' })

    active.setRole('active')
    await active.connect({
      peerId: 'active-test',
      kcpAddress: { ip: '127.0.0.1', port: passive.localPort! }
    })

    expect(active.status).toBe('connected')
    expect(passive.status).toBe('connected')

    return { active, passive }
  }

  function randomBuffer(size: number): Buffer {
    const buf = Buffer.alloc(size)
    for (let i = 0; i < size; i += 4096) {
      const chunk = Math.min(4096, size - i)
      buf.fill(Math.floor(Math.random() * 256), i, i + chunk)
    }
    return buf
  }

  // ═══════════════════════════════════════════════════════════
  //  Test 1: 小数据验证连接可用
  // ═══════════════════════════════════════════════════════════
  it('小数据（100KB）应正常传输', async () => {
    const { active, passive } = await createConnectedPair()

    const received: Buffer[] = []
    passive.on(TRANSPORT_EVENTS.DATA, (data: Buffer) => {
      received.push(Buffer.from(data))
    })

    const sent = randomBuffer(100 * 1024)
    await active.send(sent)

    // 最多等 10s
    for (let i = 0; i < 100; i++) {
      if (received.reduce((s, c) => s + c.length, 0) >= sent.length) break
      await new Promise(r => setTimeout(r, 100))
    }

    expect(Buffer.concat(received).equals(sent)).toBe(true)
  }, 20000)

  // ═══════════════════════════════════════════════════════════
  //  Test 2: 累积数据爆发（模拟 MC 世界数据，~1.5MB）
  // ═══════════════════════════════════════════════════════════
  it('应完整接收累积数据爆发（模拟 MC 世界数据，1.5MB+）', async () => {
    const { active, passive } = await createConnectedPair()

    const receivedChunks: Buffer[] = []
    passive.on(TRANSPORT_EVENTS.DATA, (data: Buffer) => {
      receivedChunks.push(Buffer.from(data))
    })

    // MC 世界数据模式
    const sendSizes: number[] = [
      2361, 47, 16060, 9831, 2786, 4997, 5526, 4605, 4310, 4074, 3565, 3720,
      4195, 4136, 4481, 4289, 4472, 4328, 4398, 4262, 4363, 4080, 3640, 3458,
      4463, 5302, 5147, 5984, 4863, 11759, 4576, 5696, 5183, 9671, 5367, 3761,
      6617, 5570, 5115, 21645, 11728, 5982, 3880, 4078, 18883, 4036, 3518,
      4385, 4129, 4524, 4429, 9946, 13341
    ]

    const totalToSend = sendSizes.reduce((a, b) => a + b, 0)
    const sentBuffers: Buffer[] = []

    for (const size of sendSizes) {
      const buf = randomBuffer(size)
      sentBuffers.push(buf)
      await active.send(buf)
    }

    const maxWaitMs = 60000
    let waited = 0
    let totalReceived = 0
    while (waited < maxWaitMs) {
      totalReceived = receivedChunks.reduce((s, c) => s + c.length, 0)
      if (totalReceived >= totalToSend) break
      await new Promise(r => setTimeout(r, 100))
      waited += 100
    }

    expect(totalReceived).toBe(totalToSend)
    expect(waited).toBeLessThan(maxWaitMs)

    const allSent = Buffer.concat(sentBuffers)
    const allReceived = Buffer.concat(receivedChunks)
    expect(allReceived.equals(allSent)).toBe(true)
  }, 120000)

  // ═══════════════════════════════════════════════════════════
  //  Test 3: 双向传输不死锁
  // ═══════════════════════════════════════════════════════════
  it('数据与回复交替时不会死锁', async () => {
    const { active, passive } = await createConnectedPair()

    const activeReceived: Buffer[] = []
    active.on(TRANSPORT_EVENTS.DATA, (data: Buffer) => {
      activeReceived.push(Buffer.from(data))
    })

    const passiveReceived: Buffer[] = []
    passive.on(TRANSPORT_EVENTS.DATA, (data: Buffer) => {
      passiveReceived.push(Buffer.from(data))
    })

    // passive 收到数据立即回一条小消息
    passive.on(TRANSPORT_EVENTS.DATA, async (data: Buffer) => {
      try { await passive.send(randomBuffer(32)) } catch { /* ok */ }
    })

    // 发送 100 条数据
    for (let i = 0; i < 100; i++) {
      await active.send(randomBuffer(1024))
    }

    // 等待回复到达
    for (let i = 0; i < 200; i++) {
      if (activeReceived.length >= 90) break
      await new Promise(r => setTimeout(r, 100))
    }

    expect(passiveReceived.length).toBe(100)
    expect(activeReceived.length).toBeGreaterThanOrEqual(80)
  }, 60000)
})
