/**
 * 功能描述：中继通信 + P2P 直连综合测试
 *
 * 逻辑说明：完整模拟房主与加入者的交互流程：
 *   阶段 1 — 中继通信：通过中继服务器转发二进制数据
 *   阶段 2 — P2P 直连：信令交换 → TCP 直连 → 数据交换
 *   使用真实的中继服务器 (159.75.150.37:9800)
 *
 * 用法：node scripts/relay-p2p-test.mjs
 */

import WebSocket from 'ws'
import { createServer, createConnection, Socket } from 'net'
import { createSocket } from 'dgram'
import http from 'http'

const RELAY_URL = 'ws://159.75.150.37:9800'
const SERVER = '159.75.150.37'
const PORTS = { RELAY: 9800, UDP: 9802, TCP: 9803 }

let passed = 0
let failed = 0
const errors = []

function section(n, title) {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  阶段 ${n}: ${title}`)
  console.log(`${'='.repeat(56)}`)
}

function ok(msg) {
  console.log(`  ✅ ${msg}`)
  passed++
}

function fail(msg, err = '') {
  console.log(`  ❌ ${msg}${err ? ` — ${err}` : ''}`)
  failed++
  if (err) errors.push(`${msg}: ${err}`)
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ─── Helper: WebSocket JSON 消息收发 ─────────────────

function wsSendJson(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function waitForMessage(ws, typeFilter, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待消息 "${typeFilter}" 超时`)), timeout)
    const handler = (raw) => {
      try {
        const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
        if (msg.type === typeFilter) {
          clearTimeout(timer)
          ws.off('message', handler)
          resolve(msg)
        }
      } catch { /* binary, ignore */ }
    }
    ws.on('message', handler)
  })
}

function waitForBinary(ws, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待二进制帧超时')), timeout)
    const handler = (raw) => {
      if (Buffer.isBuffer(raw)) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(raw)
      } else {
        // Might be a text frame, check if it's valid JSON first
        try { JSON.parse(raw) } catch {
          clearTimeout(timer)
          ws.off('message', handler)
          resolve(Buffer.from(raw))
        }
      }
    }
    ws.on('message', handler)
  })
}

// ─── 阶段 1: 中继通信 ────────────────────────────────

async function phase1RelayCommunication() {
  section(1, '中继通信 — 通过 WebSocket 转发二进制数据')

  let hostWs, guestWs
  let roomCode, hostId, guestId

  // 1a. 房主连接并创建房间
  try {
    hostWs = new WebSocket(RELAY_URL)
    await new Promise((resolve, reject) => {
      hostWs.on('open', resolve)
      hostWs.on('error', reject)
      setTimeout(() => reject(new Error('房主 WS 连接超时')), 5000)
    })
    ok('房主 WebSocket 连接成功')

    wsSendJson(hostWs, {
      type: 'create-room',
      messageId: 'p1-1',
      data: {
        gameId: 'test-game',
        gameName: 'TestGame',
        gamePort: 25565,
        memberName: 'Host',
        networkInfo: { ipv4: { natType: 'full-cone', publicIp: '1.2.3.4', publicPort: 30001 }, ipv6: { available: false, hasPublicV6: false } }
      }
    })

    const created = await waitForMessage(hostWs, 'room-created')
    roomCode = created.data.roomCode
    hostId = created.data.memberId
    ok(`房间已创建: ${roomCode}, 房主 ID: ${hostId}`)
  } catch (e) {
    fail('创建房间失败', e.message)
    return
  }

  // 1b. 加入者连接并加入房间
  try {
    guestWs = new WebSocket(RELAY_URL)
    await new Promise((resolve, reject) => {
      guestWs.on('open', resolve)
      guestWs.on('error', reject)
      setTimeout(() => reject(new Error('加入者 WS 连接超时')), 5000)
    })
    ok('加入者 WebSocket 连接成功')

    // 先注册 host 的 member-joined 监听（防竞态），再让 guest 发送加入请求
    const memberJoinedPromise = waitForMessage(hostWs, 'member-joined')

    wsSendJson(guestWs, {
      type: 'join-room',
      messageId: 'p1-2',
      data: {
        roomCode,
        memberName: 'Guest',
        networkInfo: { ipv4: { natType: 'full-cone', publicIp: '5.6.7.8', publicPort: 40001 }, ipv6: { available: false, hasPublicV6: false } }
      }
    })

    const joined = await waitForMessage(guestWs, 'room-joined')
    guestId = joined.data.memberId
    ok(`加入者已加入房间, ID: ${guestId}, 房主 ID: ${joined.data.hostId}`)

    const memberJoined = await memberJoinedPromise
    ok(`房主收到加入通知: ${memberJoined.data.memberName}`)
  } catch (e) {
    fail('加入房间失败', e.message)
    hostWs?.close()
    return
  }

  // 1c. 房主 → 加入者：发送二进制数据
  try {
    const testPayload = Buffer.from('HelloFromHostViaRelay!')
    const idBuf = Buffer.from(guestId, 'utf8')
    const idHeader = Buffer.alloc(4)
    idHeader.writeUInt32BE(idBuf.length, 0)
    const payloadHeader = Buffer.alloc(4)
    payloadHeader.writeUInt32BE(testPayload.length, 0)
    const frame = Buffer.concat([idHeader, idBuf, payloadHeader, testPayload])
    hostWs.send(frame)
    ok(`房主发送 ${testPayload.length} 字节 → ${guestId}`)

    const received = await waitForBinary(guestWs)
    // 中继服务器直接转发 payload，无额外头
    const guestPayload = received
    if (guestPayload.toString() === 'HelloFromHostViaRelay!') {
      ok(`加入者收到房主数据: "${guestPayload.toString()}" (${guestPayload.length} 字节)`)
    } else {
      fail(`加入者收到数据不匹配: "${guestPayload.toString()}"`)
    }
  } catch (e) {
    fail('房主→加入者 数据转发失败', e.message)
  }

  // 1d. 加入者 → 房主：发送二进制数据
  try {
    const testPayload = Buffer.from('HelloFromGuestViaRelay!')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(testPayload.length, 0)
    guestWs.send(Buffer.concat([header, testPayload]))
    ok(`加入者发送 ${testPayload.length} 字节 → 房主`)

    const received = await waitForBinary(hostWs)
    const srcIdLen = received.readUInt32BE(0)
    const srcId = received.subarray(4, 4 + srcIdLen).toString('utf8')
    const replyPayloadLen = received.readUInt32BE(4 + srcIdLen)
    const replyPayload = received.subarray(4 + srcIdLen + 4, 4 + srcIdLen + 4 + replyPayloadLen)
    if (replyPayload.toString() === 'HelloFromGuestViaRelay!') {
      ok(`房主收到加入者数据: "${replyPayload.toString()}" (来自 ${srcId})`)
    } else {
      fail(`房主收到数据不匹配: "${replyPayload.toString()}"`)
    }
  } catch (e) {
    fail('加入者→房主 数据转发失败', e.message)
  }

  // 1e. 多次往返测试
  try {
    for (let i = 1; i <= 3; i++) {
      const data = Buffer.from(`RelayPing-${i}`)
      const idBuf = Buffer.from(guestId, 'utf8')
      const idHeader = Buffer.alloc(4)
      idHeader.writeUInt32BE(idBuf.length, 0)
      const payloadHeader = Buffer.alloc(4)
      payloadHeader.writeUInt32BE(data.length, 0)
      hostWs.send(Buffer.concat([idHeader, idBuf, payloadHeader, data]))

      const received = await waitForBinary(guestWs)
      const payload = received.toString()
      if (payload === `RelayPing-${i}`) {
        ok(`中继多轮测试 #${i}: 数据正确`)
      } else {
        fail(`中继多轮测试 #${i}: 收到 "${payload}"`)
      }
    }
  } catch (e) {
    fail('中继多轮测试失败', e.message)
  }

  // 清理阶段 1 的 WS 连接（先不关，阶段 2 会新建）
  hostWs.close()
  guestWs.close()
  ok('中继通信 WS 连接已关闭')
}

// ─── 阶段 2: P2P 信令 + TCP 直连 ─────────────────────

async function phase2P2PCommunication() {
  section(2, 'P2P 通信 — 信令交换 → TCP 直连 → 数据交换')

  let hostWs, guestWs
  let roomCode, hostId, guestId
  let p2pServer
  let p2pHostPort

  // 2a. 创建房间 (P2P 测试用)
  try {
    hostWs = new WebSocket(RELAY_URL)
    await new Promise((resolve, reject) => {
      hostWs.on('open', resolve)
      hostWs.on('error', reject)
      setTimeout(() => reject(new Error('P2P 房主 WS 连接超时')), 5000)
    })

    wsSendJson(hostWs, {
      type: 'create-room',
      messageId: 'p2-1',
      data: {
        gameId: 'p2p-test',
        gameName: 'P2PTest',
        gamePort: 25565,
        memberName: 'P2PHost',
        networkInfo: { ipv4: { natType: 'full-cone', publicIp: SERVER, publicPort: PORTS.TCP }, ipv6: { available: false, hasPublicV6: false } }
      }
    })

    const created = await waitForMessage(hostWs, 'room-created')
    roomCode = created.data.roomCode
    hostId = created.data.memberId
    ok(`P2P 房间已创建: ${roomCode}, 房主 ID: ${hostId}`)
  } catch (e) {
    fail('P2P 创建房间失败', e.message)
    return
  }

  // 2b. 加入者加入
  try {
    guestWs = new WebSocket(RELAY_URL)
    await new Promise((resolve, reject) => {
      guestWs.on('open', resolve)
      guestWs.on('error', reject)
      setTimeout(() => reject(new Error('P2P 加入者 WS 连接超时')), 5000)
    })

    // 先注册 host 的 member-joined 监听（防竞态），再让 guest 发送加入请求
    const p2pMemberJoined = waitForMessage(hostWs, 'member-joined')

    wsSendJson(guestWs, {
      type: 'join-room',
      messageId: 'p2-2',
      data: {
        roomCode,
        memberName: 'P2PGuest',
        networkInfo: { ipv4: { natType: 'full-cone', publicIp: SERVER, publicPort: PORTS.TCP }, ipv6: { available: false, hasPublicV6: false } }
      }
    })

    const joined = await waitForMessage(guestWs, 'room-joined')
    guestId = joined.data.memberId
    ok(`P2P 加入者已加入, ID: ${guestId}`)

    await p2pMemberJoined
    ok('P2P 房主收到加入通知')
  } catch (e) {
    fail('P2P 加入房间失败', e.message)
    hostWs?.close()
    return
  }

  // 2c. 房主启动 P2P TCP 服务器（模拟 passive 方）
  try {
    p2pServer = createServer((socket) => {
      socket.on('data', (data) => {
        // Echo 回显
        socket.write(data)
      })
    })

    await new Promise((resolve) => p2pServer.listen(0, '127.0.0.1', resolve))
    p2pHostPort = p2pServer.address().port
    ok(`P2P 房主 TCP 服务器已启动: 127.0.0.1:${p2pHostPort}`)
  } catch (e) {
    fail('P2P 房主启动 TCP 服务器失败', e.message)
    hostWs?.close()
    guestWs?.close()
    return
  }

  // 2d. 通过信令交换 P2P 地址
  try {
    // 房主发送 P2P 地址给加入者
    wsSendJson(hostWs, {
      type: 'signal',
      data: {
        to: guestId,
        signalData: {
          type: 'p2p-address',
          ip: '127.0.0.1',
          port: p2pHostPort
        }
      }
    })
    ok('房主发送 P2P 地址信号')

    // 等待加入者收到信号
    const signal = await waitForMessage(guestWs, 'signal')
    const addr = signal.data.signalData
    ok(`加入者收到 P2P 地址信号: ${addr.ip}:${addr.port}`)

    // 2e. 加入者通过 P2P 地址直连房主
    const p2pClient = createConnection({ host: addr.ip, port: addr.port }, () => {
      ok(`P2P TCP 直连成功: ${addr.ip}:${addr.port}`)
    })

    await new Promise((resolve, reject) => {
      p2pClient.on('connect', resolve)
      p2pClient.on('error', reject)
      setTimeout(() => reject(new Error('P2P TCP 直连超时')), 5000)
    })

    // 2f. 通过 P2P 直连发送数据
    const testData = 'HelloP2P!'
    const response = await new Promise((resolve, reject) => {
      let data = ''
      p2pClient.on('data', (chunk) => { data += chunk.toString() })
      p2pClient.write(testData)
      setTimeout(() => {
        p2pClient.end()
        resolve(data)
      }, 1000)
      p2pClient.on('error', reject)
    })

    if (response.trim() === testData) {
      ok(`P2P 直连数据回显正确: "${testData}" → "${response.trim()}"`)
    } else {
      fail(`P2P 直连回显不匹配: 发送 "${testData}", 收到 "${response.trim()}"`)
    }

    p2pClient.destroy()
  } catch (e) {
    fail('P2P 信令/直连失败', e.message)
  }

  // 2g. 通过中继信令交换 ICE-style 地址后再次直连
  try {
    const p2pServer2 = createServer((socket) => {
      let received = ''
      socket.on('data', (data) => { received += data.toString() })
      socket.on('end', () => {
        if (received.trim() === 'SecondP2PTest') {
          socket.write('SecondP2POK')
        }
        socket.end()
      })
    })
    await new Promise((resolve) => p2pServer2.listen(0, '127.0.0.1', resolve))
    const port2 = p2pServer2.address().port

    // 通过信令发送第二个地址
    wsSendJson(hostWs, {
      type: 'signal',
      data: {
        to: guestId,
        signalData: { type: 'candidate', ip: '127.0.0.1', port: port2, protocol: 'tcp' }
      }
    })

    const signal2 = await waitForMessage(guestWs, 'signal')
    const addr2 = signal2.data.signalData
    ok(`第二轮 P2P 信令交换完成: ${addr2.ip}:${addr2.port}`)

    const p2pClient2 = createConnection({ host: addr2.ip, port: addr2.port })
    await new Promise((resolve, reject) => {
      p2pClient2.on('connect', resolve)
      p2pClient2.on('error', reject)
      setTimeout(() => reject(new Error('第二轮 P2P 直连超时')), 5000)
    })

    const response2 = await new Promise((resolve, reject) => {
      let data = ''
      p2pClient2.on('data', (chunk) => { data += chunk.toString() })
      p2pClient2.write('SecondP2PTest')
      p2pClient2.end()
      setTimeout(() => {
        resolve(data)
      }, 1000)
      p2pClient2.on('error', reject)
    })

    if (response2 === 'SecondP2POK') {
      ok(`第二轮 P2P 直连通信正常: "SecondP2PTest" → "SecondP2POK"`)
    } else {
      fail(`第二轮 P2P 通信异常: 收到 "${response2}"`)
    }

    p2pClient2.destroy()
    p2pServer2.close()
  } catch (e) {
    fail('第二轮 P2P 信令/直连失败', e.message)
  }

  // 清理
  p2pServer?.close()
  hostWs.close()
  guestWs.close()
  ok('P2P 测试资源已清理')
}

// ─── 阶段 3: 综合场景 — 中继 + P2P 混合 ──────────────

async function phase3MixedScenario() {
  section(3, '综合场景 — 中继 + P2P 混合通信')

  // 验证：中继服务器中房间/信号统计是否正常
  try {
    const body = await new Promise((resolve, reject) => {
      http.get(`http://${SERVER}:9801/api/status`, (res) => {
        let data = ''
        res.on('data', (chunk) => data += chunk)
        res.on('end', () => resolve(data))
      }).on('error', reject)
    })
    const stats = JSON.parse(body)
    if (stats.totalSignals > 0 && stats.totalMessages > 0) {
      ok(`仪表盘统计正常: 消息=${stats.totalMessages}, 信号=${stats.totalSignals}, 运行=${(stats.uptime / 60).toFixed(0)}m`)
    } else {
      fail(`仪表盘统计异常: ${JSON.stringify(stats)}`)
    }
  } catch (e) {
    fail('无法获取仪表盘统计', e.message)
  }

  // 验证：服务器网络信息
  try {
    const body = await new Promise((resolve, reject) => {
      http.get(`http://${SERVER}:9801/api/network`, (res) => {
        let data = ''
        res.on('data', (chunk) => data += chunk)
        res.on('end', () => resolve(data))
      }).on('error', reject)
    })
    const net = JSON.parse(body)
    const ips = net.localIps || []
    ok(`服务器网络信息: 主机名=${net.hostname}, IP=${ips.join(', ') || '无'}`)
  } catch (e) {
    fail('无法获取服务器网络信息', e.message)
  }
}

// ─── 主流程 ──────────────────────────────────────────

async function main() {
  console.log(`\n🔌 中继通信 + P2P 直连综合测试`)
  console.log(`   服务器: ${RELAY_URL}`)
  console.log(`   时间:   ${new Date().toISOString()}`)

  // 先验证服务器可达
  try {
    await new Promise((resolve, reject) => {
      http.get(`http://${SERVER}:9801/api/status`, (res) => {
        let data = ''
        res.on('data', (chunk) => data += chunk)
        res.on('end', () => { try { JSON.parse(data); resolve() } catch { reject(new Error('invalid JSON')) } })
      }).on('error', reject)
    })
    ok('服务器可达，开始测试')
  } catch (e) {
    fail('服务器不可达', e.message)
    process.exit(1)
  }

  await phase1RelayCommunication()
  await phase2P2PCommunication()
  await phase3MixedScenario()

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
