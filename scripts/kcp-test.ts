/**
 * 功能描述：KCP 通信测试 — 通过中继信令交换 KCP 地址 + KCP UDP 直连通信
 *
 * 逻辑说明：
 *   阶段 1 — KCP 信令交换：通过中继服务器 (159.75.150.37) 进行房间管理和 KCP 地址交换
 *   阶段 2 — KCP 连接建立：使用 KcpTransport 建立 KCP UDP 连接
 *   阶段 3 — KCP 数据传输：验证可靠传输、数据完整性、延迟测量
 *   阶段 4 — 断开重连：验证 disconnect 后停止发射事件
 *
 * 使用方式：npx tsx scripts/kcp-test.ts
 */

import WebSocket from 'ws'
import { KcpTransport } from '../src/core/tunnel/kcp-transport'
import { performance } from 'perf_hooks'
import type { PeerConnectionInfo } from '../src/core/connection/types'

const RELAY_URL = 'ws://159.75.150.37:9800'

let passed = 0
let failed = 0
const errors: string[] = []

function section(n: number, title: string): void {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  阶段 ${n}: ${title}`)
  console.log(`${'='.repeat(56)}`)
}

function ok(msg: string): void {
  console.log(`  ✅ ${msg}`)
  passed++
}

function fail(msg: string, err = ''): void {
  console.log(`  ❌ ${msg}${err ? ` — ${err}` : ''}`)
  failed++
  if (err) errors.push(`${msg}: ${err}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function sendJson(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function waitForMessage(ws: WebSocket, typeFilter: string, timeout = 10000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待消息 "${typeFilter}" 超时`)), timeout)
    const handler = (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
        if (msg.type === typeFilter) {
          clearTimeout(timer)
          ws.off('message', handler)
          resolve(msg)
        }
      } catch { /* ignore */ }
    }
    ws.on('message', handler)
  })
}

// ─── 辅助: WebSocket 连接（带重试）────────────────────

function connectWithRetry(url: string, label: string, retries = 3): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const attempt = (n: number) => {
      if (n > retries) {
        reject(new Error(`${label} WS 连接失败（重试 ${retries} 次）`))
        return
      }
      const ws = new WebSocket(url)
      const timer = setTimeout(() => {
        ws.close()
        if (n < retries) {
          setTimeout(() => attempt(n + 1), 1000)
        } else {
          reject(new Error(`${label} WS 连接超时`))
        }
      }, 5000)
      ws.on('open', () => {
        clearTimeout(timer)
        resolve(ws)
      })
      ws.on('error', () => {
        clearTimeout(timer)
        ws.close()
        if (n < retries) {
          setTimeout(() => attempt(n + 1), 1000)
        } else {
          reject(new Error(`${label} WS 连接错误`))
        }
      })
    }
    attempt(1)
  })
}

// ─── 阶段 1: 信令交换 ────────────────────────────────

interface SignalData {
  hostId: string
  guestId: string
  hostWs: WebSocket
  guestWs: WebSocket
}

async function phase1SignalExchange(): Promise<SignalData | null> {
  section(1, 'KCP 信令交换 — 通过中继交换 KCP 地址')

  let hostWs: WebSocket | null = null
  let guestWs: WebSocket | null = null
  let hostId = ''
  let guestId = ''

  try {
    // 房主连接（带重试）
    hostWs = await connectWithRetry(RELAY_URL, '房主')
    ok('房主 WebSocket 连接成功')

    // 创建房间
    sendJson(hostWs, {
      type: 'create-room',
      messageId: 'kcp-1',
      data: {
        gameId: 'kcp-test',
        gameName: 'KCPTest',
        gamePort: 25565,
        memberName: 'KcpHost',
        networkInfo: {
          ipv4: {
            natType: 'full-cone', publicIp: '127.0.0.1', publicPort: 30001,
            mappingBehavior: 'endpoint-independent', filteringBehavior: 'endpoint-independent'
          },
          ipv6: { available: false, hasPublicV6: false }
        }
      }
    })

    const created = await waitForMessage(hostWs, 'room-created')
    const roomCode = created.data.roomCode
    hostId = created.data.memberId
    ok(`房间已创建: ${roomCode}, 房主 ID: ${hostId}`)

    // 加入者连接（带重试，间隔 500ms）
    await sleep(500)
    guestWs = await connectWithRetry(RELAY_URL, '加入者')
    ok('加入者 WebSocket 连接成功')

    // 先注册 host 的 member-joined 监听
    const memberJoinedPromise = waitForMessage(hostWs, 'member-joined')

    // 加入房间
    sendJson(guestWs, {
      type: 'join-room',
      messageId: 'kcp-2',
      data: {
        roomCode,
        memberName: 'KcpGuest',
        networkInfo: {
          ipv4: {
            natType: 'full-cone', publicIp: '127.0.0.1', publicPort: 40001,
            mappingBehavior: 'endpoint-independent', filteringBehavior: 'endpoint-independent'
          },
          ipv6: { available: false, hasPublicV6: false }
        }
      }
    })

    const joined = await waitForMessage(guestWs, 'room-joined')
    guestId = joined.data.memberId
    ok(`加入者已加入房间, ID: ${guestId}`)

    await memberJoinedPromise
    ok('房主收到加入通知')

    return { hostId, guestId, hostWs, guestWs }
  } catch (e) {
    fail('信令交换失败', (e as Error).message)
    hostWs.close()
    guestWs.close()
    return null
  }
}

// ─── 阶段 2: KCP 连接建立 ────────────────────────────

async function phase2KcpConnect(signal: SignalData): Promise<{
  kcpActive: KcpTransport
  kcpPassive: KcpTransport
  guestPort: number
} | null> {
  section(2, 'KCP 连接建立 — 通过信令交换地址 + UDP 打洞')

  const { hostId, guestId, hostWs, guestWs } = signal
  const kcpPassive = new KcpTransport()
  const kcpActive = new KcpTransport()

  try {
    // passive 方先启动，监听 UDP 端口
    kcpPassive.setRole('passive')
    await kcpPassive.connect({ peerId: hostId })
    const passivePort = kcpPassive.localPort!
    ok(`KCP passive 已启动, 本地端口: ${passivePort}`)

    // passive 方将地址通过信令发给 active 方
    // 先注册 active 方的 signal 监听
    const signalPromise = waitForMessage(guestWs, 'signal')

    sendJson(hostWs, {
      type: 'signal',
      data: {
        to: guestId,
        signalData: {
          type: 'kcp-address',
          ip: '127.0.0.1',
          port: passivePort,
          localIps: ['127.0.0.1']
        }
      }
    })

    const signalMsg = await signalPromise
    const kcpAddr = signalMsg.data.signalData
    ok(`加入者收到 KCP 地址信号: ${kcpAddr.ip}:${kcpAddr.port}`)

    // active 方连接到 passive（127.0.0.1 已在 KCP candidate 列表中自动处理）
    const peerInfo: PeerConnectionInfo = {
      peerId: hostId,
      kcpAddress: { ip: kcpAddr.ip, port: kcpAddr.port }
    }

    kcpActive.setRole('active')
    await kcpActive.connect(peerInfo)

    // 等待 passive 也变为 connected
    await sleep(500)

    expectEqual(kcpActive.status, 'connected', 'KCP active 状态为 connected')
    expectEqual(kcpPassive.status, 'connected', 'KCP passive 状态为 connected')

    return { kcpActive, kcpPassive, guestPort: passivePort }
  } catch (e) {
    fail('KCP 连接建立失败', (e as Error).message)
    return null
  }
}

// ─── 阶段 3: KCP 数据传输 ────────────────────────────

async function phase3KcpData(
  kcpActive: KcpTransport,
  kcpPassive: KcpTransport
): Promise<void> {
  section(3, 'KCP 数据传输 — 可靠传输 + 数据完整性 + 延迟测量')

  // 3a. 单向传输: active → passive
  try {
    const dataPromise = new Promise<Buffer>((resolve) => {
      kcpPassive.on('data', (data: Buffer) => resolve(data))
    })

    const testData = Buffer.from('HelloKCPFromActive!')
    await kcpActive.send(testData)

    const received = await dataPromise
    if (received.toString() === 'HelloKCPFromActive!') {
      ok(`active→passive: "${received.toString()}" (${received.length} 字节)`)
    } else {
      fail(`active→passive 数据不匹配: "${received.toString()}"`)
    }
  } catch (e) {
    fail('active→passive 传输失败', (e as Error).message)
  }

  // 3b. 反向传输: passive → active
  try {
    const dataPromise = new Promise<Buffer>((resolve) => {
      kcpActive.on('data', (data: Buffer) => resolve(data))
    })

    const testData = Buffer.from('HelloKCPFromPassive!')
    await kcpPassive.send(testData)

    const received = await dataPromise
    if (received.toString() === 'HelloKCPFromPassive!') {
      ok(`passive→active: "${received.toString()}" (${received.length} 字节)`)
    } else {
      fail(`passive→active 数据不匹配: "${received.toString()}"`)
    }
  } catch (e) {
    fail('passive→active 传输失败', (e as Error).message)
  }

  // 3c. 多包连续传输（验证有序可靠）
  try {
    const receivedPackets: Buffer[] = []
    const listener = (data: Buffer): void => { receivedPackets.push(data) }
    kcpPassive.on('data', listener)

    const count = 10
    for (let i = 0; i < count; i++) {
      await kcpActive.send(Buffer.from(`KCP-Packet-${i}`))
    }

    await sleep(500) // 等待 KCP flush

    kcpPassive.off('data', listener)

    if (receivedPackets.length === count) {
      let allMatch = true
      for (let i = 0; i < count; i++) {
        if (receivedPackets[i].toString() !== `KCP-Packet-${i}`) {
          allMatch = false
          fail(`多包数据 #${i} 不匹配: "${receivedPackets[i].toString()}"`)
        }
      }
      if (allMatch) ok(`多包连续传输: ${count}/${count} 包有序到达`)
    } else {
      fail(`多包传输不完整: 收到 ${receivedPackets.length}/${count}`)
    }
  } catch (e) {
    fail('多包传输失败', (e as Error).message)
  }

  // 3d. 大包传输（验证分片和重组）
  try {
    const largeData = Buffer.alloc(50000)
    for (let i = 0; i < 50000; i++) {
      largeData[i] = i % 256
    }

    const dataPromise = new Promise<Buffer>((resolve) => {
      kcpPassive.on('data', (data: Buffer) => resolve(data))
    })

    await kcpActive.send(largeData)
    const received = await dataPromise

    if (received.length === 50000) {
      let match = true
      for (let i = 0; i < 50000; i++) {
        if (received[i] !== i % 256) { match = false; break }
      }
      if (match) {
        ok(`大包传输: 50000 字节完整到达 (${(received.length / 1024).toFixed(0)} KB)`)
      } else {
        fail('大包数据内容损坏')
      }
    } else {
      fail(`大包传输不完整: 收到 ${received.length}/50000 字节`)
    }
  } catch (e) {
    fail('大包传输失败', (e as Error).message)
  }

  // 3e. 延迟测量
  try {
    let rtt = -1
    kcpActive.on('latency', (v: number) => { rtt = v })

    // 等待延迟测量（ping/pong 每 2s 一次）
    for (let i = 0; i < 15; i++) {
      if (rtt >= 0) break
      await sleep(200)
    }

    if (rtt >= 0) {
      ok(`KCP 延迟测量: RTT = ${rtt}ms`)
    } else {
      fail('KCP 延迟测量超时（15 次轮询后无事件）')
    }
  } catch (e) {
    fail('延迟测量异常', (e as Error).message)
  }
}

// ─── 阶段 4: 断开 + 状态清理 ──────────────────────────

async function phase4Disconnect(
  kcpActive: KcpTransport,
  kcpPassive: KcpTransport,
  hostWs: WebSocket,
  guestWs: WebSocket
): Promise<void> {
  section(4, '断开清理 — 断开后停止事件 + WS 清理')

  // 4a. 断开后不应再有延迟事件
  try {
    let latencyCount = 0
    kcpActive.on('latency', () => { latencyCount++ })

    await kcpActive.disconnect()
    await kcpPassive.disconnect()

    await sleep(2500)

    if (latencyCount === 0) {
      ok('断开后延迟事件已停止')
    } else {
      fail(`断开后仍有 ${latencyCount} 次延迟事件`)
    }
  } catch (e) {
    fail('断开测试异常', (e as Error).message)
  }

  // 4b. 状态检查
  expectEqual(kcpActive.status, 'disconnected', 'KCP active 状态为 disconnected')
  expectEqual(kcpPassive.status, 'disconnected', 'KCP passive 状态为 disconnected')

  // 4c. WS 断开
  hostWs.close()
  guestWs.close()
  ok('WebSocket 连接已关闭')
}

// ─── 辅助断言 ─────────────────────────────────────────

function expectEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    ok(`${label}: ${actual}`)
  } else {
    fail(`${label}: 期望 ${expected}, 实际 ${actual}`)
  }
}

// ─── 主流程 ──────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n📡 KCP 通信测试`)
  console.log(`   中继服务器: ${RELAY_URL}`)
  console.log(`   时间:       ${new Date().toISOString()}`)

  // 先验证中继服务器可达
  try {
    const http = await import('http')
    await new Promise<void>((resolve, reject) => {
      http.get('http://159.75.150.37:9801/api/status', (res) => {
        let data = ''
        res.on('data', (chunk) => data += chunk)
        res.on('end', () => { try { JSON.parse(data); resolve() } catch { reject(new Error('invalid JSON')) } })
      }).on('error', reject)
    })
    ok('中继服务器可达')
  } catch (e) {
    fail('中继服务器不可达', (e as Error).message)
    process.exit(1)
  }

  // 阶段 1: 信令交换
  const signal = await phase1SignalExchange()
  if (!signal) {
    console.log(`\n${'='.repeat(56)}`)
    console.log(`  测试完成: ${passed + failed} 项 (阶段 1 失败，跳过后续)`)
    console.log(`  ✅ ${passed} 通过, ❌ ${failed} 失败`)
    process.exit(1)
  }

  // 阶段 2: KCP 连接建立
  const kcpResult = await phase2KcpConnect(signal)
  if (!kcpResult) {
    signal.hostWs.close()
    signal.guestWs.close()
    console.log(`\n${'='.repeat(56)}`)
    console.log(`  测试完成: ${passed + failed} 项 (阶段 2 失败，跳过后续)`)
    console.log(`  ✅ ${passed} 通过, ❌ ${failed} 失败`)
    process.exit(1)
  }

  // 阶段 3: KCP 数据传输
  await phase3KcpData(kcpResult.kcpActive, kcpResult.kcpPassive)

  // 阶段 4: 断开清理
  await phase4Disconnect(
    kcpResult.kcpActive,
    kcpResult.kcpPassive,
    signal.hostWs,
    signal.guestWs
  )

  // 汇总
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  测试完成: ${passed + failed} 项`)
  if (failed === 0) {
    console.log(`  🎉 全部通过 (${passed}/${passed + failed})`)
  } else {
    console.log(`  ✅ ${passed} 通过, ❌ ${failed} 失败`)
    if (errors.length > 0) {
      console.log(`\n  错误详情:`)
      for (const e of errors) console.log(`    • ${e}`)
    }
  }
  console.log(`${'='.repeat(56)}\n`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('测试脚本异常:', e)
  process.exit(1)
})
