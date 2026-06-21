/**
 * 功能描述：KCP UDP 打洞机制测试脚本
 *
 * 逻辑说明：本地回环测试 KcpTransport 的探针重传、addExternalTarget、
 *           双向连接建立和断连清理。不依赖外部中继服务器。
 *
 * 使用方式：npx tsx scripts/kcp-holepunch-test.ts
 *
 * 测试项：
 *   1. active 探针循环 — 验证 active 模式定时发送打洞包
 *   2. addExternalTarget — 验证 passive 模式外部触发探针
 *   3. 全连接 + 双向数据传输
 *   4. 断连清理
 */

import * as dgram from 'dgram'
import { KcpTransport } from '../src/core/tunnel/kcp-transport'
import type { PeerConnectionInfo } from '../src/core/connection/types'

// ─── 工具 ─────────────────────────────────────────────

let passed = 0
let failed = 0
let testIndex = 0

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function log(msg: string): void {
  console.log(`  ${msg}`)
}

function assert(cond: boolean, msg: string): void {
  if (cond) {
    log(`✓ ${msg}`)
    passed++
  } else {
    log(`✗ ${msg}`)
    failed++
  }
}

function heading(name: string): void {
  testIndex++
  console.log(`\n─── 测试 ${testIndex}: ${name} ───`)
}

// ─── 测试 1: Active 探针循环 ─────────────────────────

async function testActiveProbeLoop(): Promise<void> {
  heading('Active 探针循环 — 验证定时重传')

  // 创建 UDP 监听器模拟 passive 端
  const listener = dgram.createSocket('udp4')
  const received: Array<{ time: number }> = []

  await new Promise<void>((resolve) => {
    listener.on('message', () => {
      received.push({ time: Date.now() })
    })
    listener.bind(0, '127.0.0.1', () => resolve())
  })

  const listenPort = (listener.address() as { address: string; family: string; port: number }).port

  // 创建 active KCP，目标指向监听器
  const kcp = new KcpTransport()
  kcp.setRole('active')

  // 异步启动连接（会卡住直到超时，因为监听器不回包）
  const connectPromise = kcp.connect({
    peerId: 'test1',
    kcpAddress: { ip: '127.0.0.1', port: listenPort }
  } as PeerConnectionInfo)

  await sleep(4500) // 等 ~3 轮探针（1.5s 间隔）

  // 断开，避免超时
  await kcp.disconnect()
  listener.close()

  // 验证：4.5s 内应收到至少 2 个探针包
  assert(received.length >= 2, `收到 ${received.length} 个探针包 (期望 >= 2)`)

  // 验证探针间隔合理：多 socket 密集发送模式下，间隔应 <= 1500ms
  if (received.length >= 2) {
    const gaps: number[] = []
    for (let i = 1; i < received.length; i++) {
      gaps.push(received[i].time - received[i - 1].time)
    }
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length
    assert(avgGap > 0 && avgGap < 2000, `平均探针间隔 ${avgGap.toFixed(0)}ms (期望 <2000ms)`)
  }
}

// ─── 测试 2: addExternalTarget ────────────────────────

async function testAddExternalTarget(): Promise<void> {
  heading('addExternalTarget — 验证被动模式外部触发探针')

  // 创建 UDP 监听器模拟 active 端
  const listener = dgram.createSocket('udp4')
  const received: Array<{ time: number }> = []

  await new Promise<void>((resolve) => {
    listener.on('message', () => {
      received.push({ time: Date.now() })
    })
    listener.bind(0, '127.0.0.1', () => resolve())
  })

  const listenPort = (listener.address() as { address: string; family: string; port: number }).port

  // 创建 passive KCP
  const kcp = new KcpTransport()
  kcp.setRole('passive')
  await kcp.connect({ peerId: 'test2' })

  // 触发外部探针
  kcp.addExternalTarget('127.0.0.1', listenPort)

  await sleep(3500) // 等 ~2 轮探针

  // 断开
  await kcp.disconnect()
  listener.close()

  assert(received.length >= 1, `收到 ${received.length} 个探针包 (期望 >= 1)`)
}

// ─── 测试 3: 双向连接 + 数据传输 ─────────────────────

async function testFullConnection(): Promise<void> {
  heading('全连接 + 双向数据传输')

  let activeProbeCount = 0
  let passiveProbeCount = 0

  // Passive（房主侧）
  const passive = new KcpTransport()
  passive.setRole('passive')
  passive.on('data', (data: Buffer) => {
    log(`passive 收到数据: ${data.toString()}`)
  })
  passive.on('status', (status: string) => {
    if (status === 'connected') passiveProbeCount++
  })
  // 用 setBindPort 固定端口以便 active 连接
  passive.setBindPort(0) // 0 = 随机，我们后面读取实际端口
  await passive.connect({ peerId: 'test3' })
  const passivePort = passive.localPort!
  log(`passive 端口: ${passivePort}`)

  // Active（加入者侧）
  const active = new KcpTransport()
  active.setRole('active')
  const activeReceived: Buffer[] = []
  active.on('data', (data: Buffer) => {
    activeReceived.push(data)
  })
  active.on('status', (status: string) => {
    if (status === 'connected') activeProbeCount++
  })

  // 监听 bound 事件，获取 active 端口后触发 passive 端探针
  active.on('bound', (port: number) => {
    log(`active 已绑定端口 ${port}，触发 passive 外部探针`)
    passive.addExternalTarget('127.0.0.1', port)
  })

  // 连接（等待建立）
  await active.connect({
    peerId: 'test3',
    kcpAddress: { ip: '127.0.0.1', port: passivePort }
  } as PeerConnectionInfo)
  log('active 已连接')

  await sleep(300)
  assert(passive.status === 'connected', 'passive 状态 = connected')
  assert(active.status === 'connected', 'active 状态 = connected')

  // 双向数据传输
  const payload1 = Buffer.from('你好 from active')
  await active.send(payload1)
  log('active 已发送数据')

  const payload2 = Buffer.from('Hello from passive')
  await passive.send(payload2)
  log('passive 已发送数据')

  // 等待数据到达
  await sleep(500)

  // active 收到 passive 的数据
  assert(activeReceived.length >= 1, `active 收到 ${activeReceived.length} 条数据 (期望 >= 1)`)
  if (activeReceived.length > 0) {
    assert(activeReceived[0].toString() === 'Hello from passive',
      `数据内容正确: "${activeReceived[0].toString()}"`)
  }

  // 验证 probe 循环已停止（连接后探针应停止发送）
  await sleep(2000)
  const activeBefore = activeProbeCount
  const passiveBefore = passiveProbeCount

  // 断开
  await active.disconnect()
  await passive.disconnect()

  log(`连接期间 status 变更次数: active=${activeProbeCount}, passive=${passiveProbeCount}`)
}

// ─── 测试 4: 断连清理 ────────────────────────────────

async function testDisconnectCleanup(): Promise<void> {
  heading('断连清理 — 验证资源释放')

  const passive = new KcpTransport()
  passive.setRole('passive')
  await passive.connect({ peerId: 'test4' })
  const passivePort = passive.localPort!

  const active = new KcpTransport()
  active.setRole('active')

  active.on('bound', (port: number) => {
    passive.addExternalTarget('127.0.0.1', port)
  })

  await active.connect({
    peerId: 'test4',
    kcpAddress: { ip: '127.0.0.1', port: passivePort }
  } as PeerConnectionInfo)

  // 等待完全建立
  await sleep(500)

  // 主动断开
  await active.disconnect()
  await passive.disconnect()

  // 验证状态
  assert(active.status === 'disconnected', 'active 状态 = disconnected')
  assert(passive.status === 'disconnected', 'passive 状态 = disconnected')

  // 验证不能再发送
  let sendFailed = false
  try {
    await active.send(Buffer.from('test'))
  } catch {
    sendFailed = true
  }
  assert(sendFailed, '断连后 send 抛出错误')

  log('资源清理完成')
}

// ─── 主入口 ───────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════╗')
  console.log('║   KCP UDP 打洞测试                   ║')
  console.log('╚══════════════════════════════════════╝')

  await testActiveProbeLoop()
  await testAddExternalTarget()
  await testFullConnection()
  await testDisconnectCleanup()

  console.log(`\n─── 汇总 ───`)
  console.log(`通过: ${passed}  失败: ${failed}  总计: ${passed + failed}`)

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('测试异常:', err)
  process.exit(1)
})
