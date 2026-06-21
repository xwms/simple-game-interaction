/**
 * 功能描述：中继服务器连通性测试 — 逐一验证所有连接方式
 *
 * 逻辑说明：按顺序测试 HTTP 仪表盘、WebSocket 中继、TCP 回显、UDP 回显、
 *           IPv6 TCP 回显服务。每项测试输出清晰的结果信息。
 *           使用 Node.js 内置模块 + ws 库。
 *
 * 用法：node scripts/connectivity-test.mjs
 */

import { createConnection } from 'net'
import { createSocket } from 'dgram'
import WebSocket from 'ws'
import http from 'http'
import os from 'os'

const SERVER = '159.75.150.37'
const PORTS = {
  WS: 9800,
  HTTP: 9801,
  UDP: 9802,
  TCP: 9803,
  V6: 9804
}

// ─── 工具 ─────────────────────────────────────────────

let passed = 0
let failed = 0

function section(title) {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  ${title}`)
  console.log(`${'='.repeat(56)}`)
}

function ok(msg) {
  console.log(`  ✅ ${msg}`)
  passed++
}

function fail(msg, err = '') {
  console.log(`  ❌ ${msg}${err ? ` — ${err}` : ''}`)
  failed++
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ─── 测试 1: HTTP 仪表盘 ──────────────────────────────

async function testHttpDashboard() {
  section('测试 1: HTTP 仪表盘 (端口 9801)')

  try {
    const body = await new Promise((resolve, reject) => {
      http.get(`http://${SERVER}:${PORTS.HTTP}/api/status`, (res) => {
        let data = ''
        res.on('data', (chunk) => data += chunk)
        res.on('end', () => resolve(data))
      }).on('error', reject)
    })

    const json = JSON.parse(body)
    if (json.uptime !== undefined) {
      ok(`仪表盘 API 正常 — 运行时间: ${json.uptime.toFixed(0)}s, 连接数: ${json.connections}`)
    } else {
      fail('仪表盘返回格式异常')
    }

    // 检查 rooms API
    const roomsBody = await new Promise((resolve, reject) => {
      http.get(`http://${SERVER}:${PORTS.HTTP}/api/rooms`, (res) => {
        let data = ''
        res.on('data', (chunk) => data += chunk)
        res.on('end', () => resolve(data))
      }).on('error', reject)
    })
    const rooms = JSON.parse(roomsBody)
    ok(`房间 API 正常 — 当前 ${rooms.length} 个房间`)

  } catch (e) {
    fail('无法访问仪表盘', e.message)
  }
}

// ─── 测试 2: WebSocket 中继 — 创建房间 + 心跳 ─────────

async function testWebSocketRelay() {
  section('测试 2: WebSocket 中继 (端口 9800)')

  // 测试 2a: WS 连接 + 心跳
  try {
    const ws = new WebSocket(`ws://${SERVER}:${PORTS.WS}`)
    await new Promise((resolve, reject) => {
      ws.on('open', resolve)
      ws.on('error', reject)
      setTimeout(() => reject(new Error('WebSocket 连接超时')), 5000)
    })
    ok('WebSocket 连接成功')

    // 发送心跳
    ws.send(JSON.stringify({ type: 'heartbeat' }))
    ok('心跳发送成功')
    await sleep(200)

    // 测试 2b: 创建房间
    const createResult = await new Promise((resolve, reject) => {
      ws.send(JSON.stringify({
        type: 'create-room',
        messageId: 'test-1',
        data: {
          gameId: 'minecraft',
          gameName: 'Minecraft',
          gamePort: 25565,
          memberName: 'TestHost',
          networkInfo: {
            ipv4: {
              natType: 'full-cone',
              publicIp: '1.2.3.4',
              publicPort: 30001,
              mappingBehavior: 'endpoint-independent',
              filteringBehavior: 'endpoint-independent'
            },
            ipv6: { available: false, hasPublicV6: false }
          }
        }
      }))

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'room-created') resolve(msg.data)
      })
      setTimeout(() => reject(new Error('创建房间超时')), 5000)
    })
    ok(`房间创建成功: ${createResult.roomCode}, memberId: ${createResult.memberId}`)

    // 测试 2c: 第二个客户端加入房间
    const ws2 = new WebSocket(`ws://${SERVER}:${PORTS.WS}`)
    await new Promise((resolve, reject) => {
      ws2.on('open', resolve)
      ws2.on('error', reject)
      setTimeout(() => reject(new Error('第二个 WS 连接超时')), 5000)
    })

    const joinResult = await new Promise((resolve, reject) => {
      ws2.send(JSON.stringify({
        type: 'join-room',
        messageId: 'test-2',
        data: {
          roomCode: createResult.roomCode,
          memberName: 'TestGuest',
          networkInfo: {
            ipv4: {
              natType: 'full-cone',
              publicIp: '5.6.7.8',
              publicPort: 40001,
              mappingBehavior: 'endpoint-independent',
              filteringBehavior: 'endpoint-independent'
            },
            ipv6: { available: false, hasPublicV6: false }
          }
        }
      }))

      ws2.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'room-joined') resolve(msg.data)
      })
      setTimeout(() => reject(new Error('加入房间超时')), 5000)
    })
    ok(`加入房间成功: roomCode=${joinResult.roomCode}, hostId=${joinResult.hostId}`)

    // 测试 2d: 房主收到 member-joined 通知
    const memberJoined = await new Promise((resolve, reject) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'member-joined') resolve(msg.data)
      })
      setTimeout(() => reject(new Error('等待 member-joined 超时')), 5000)
    })
    ok(`房主收到加入通知: ${memberJoined.memberName}(${memberJoined.memberId})`)

    // 测试 2e: 通过信令交换数据
    ws2.send(JSON.stringify({
      type: 'signal',
      data: {
        to: joinResult.hostId,
        signalData: { type: 'p2p-address', ip: '192.168.1.100', port: 50001 }
      }
    }))

    const signalReceived = await new Promise((resolve, reject) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'signal') resolve(msg.data)
      })
      setTimeout(() => reject(new Error('等待信令超时')), 5000)
    })
    ok(`信令转发成功: ${signalReceived.signalData.type} ${signalReceived.from} → ${joinResult.hostId}`)

    // 清理
    ws.close()
    ws2.close()
    ok('WebSocket 断开正常')

  } catch (e) {
    fail('WebSocket 测试失败', e.message)
  }
}

// ─── 测试 3: TCP 回显 ─────────────────────────────────

async function testTcpEcho() {
  section('测试 3: TCP 回显 (端口 9803)')

  try {
    const client = createConnection({ host: SERVER, port: PORTS.TCP })
    await new Promise((resolve, reject) => {
      client.on('connect', resolve)
      client.on('error', reject)
      setTimeout(() => reject(new Error('TCP 连接超时')), 5000)
    })
    ok('TCP 连接成功')

    const testData = 'Hello TCP Echo!'
    const response = await new Promise((resolve, reject) => {
      let data = ''
      client.on('data', (chunk) => { data += chunk.toString() })
      client.write(testData)
      setTimeout(() => {
        client.end()
        resolve(data)
      }, 1000)
      client.on('error', reject)
    })

    if (response.trim() === testData) {
      ok(`TCP 回显正确: "${testData}" → "${response.trim()}"`)
    } else {
      fail(`TCP 回显不匹配: 发送 "${testData}", 收到 "${response.trim()}"`)
    }

  } catch (e) {
    fail('TCP 测试失败', e.message)
  }
}

// ─── 测试 4: UDP 回显 ─────────────────────────────────

async function testUdpEcho() {
  section('测试 4: UDP 回显 (端口 9802)')

  try {
    const socket = createSocket('udp4')
    await new Promise((resolve, reject) => {
      socket.on('error', reject)
      socket.bind(0, '0.0.0.0', resolve)
    })

    const testData = 'Hello UDP Echo!'
    const response = await new Promise((resolve, reject) => {
      socket.on('message', (msg) => {
        resolve(msg.toString())
      })
      socket.send(testData, PORTS.UDP, SERVER, (err) => {
        if (err) reject(err)
      })
      setTimeout(() => {
        socket.close()
        reject(new Error('UDP 回显超时'))
      }, 5000)
    })

    if (response.trim() === testData) {
      ok(`UDP 回显正确: "${testData}" → "${response.trim()}"`)
    } else if (response.includes(testData)) {
      ok(`UDP 回显收到 (含 STUN 头): "${response.trim().substring(0, 50)}..."`)
    } else {
      fail(`UDP 回显不匹配: 发送 "${testData}", 收到 "${response.trim()}"`)
    }

    socket.close()

  } catch (e) {
    if (e.message === 'UDP 回显超时') {
      fail('UDP 回显无响应 — 防火墙可能阻止了 UDP')
    } else {
      fail('UDP 测试失败', e.message)
    }
  }
}

// ─── 测试 5: IPv6 TCP 回显 ────────────────────────────

async function testIpv6TcpEcho() {
  section('测试 5: IPv6 TCP 回显 (端口 9804)')

  // 先检查本机是否有 IPv6
  const hasV6 = Object.values(os.networkInterfaces()).some(
    info => info && info.some(i => i.family === 'IPv6' && !i.internal)
  )

  if (!hasV6) {
    console.log('  ⚠️  本机无 IPv6 地址，跳过 IPv6 测试')
    // 我们仍然可以尝试通过 IPv4 连接 IPv6 服务（如果双栈可用）
  }

  try {
    const client = createConnection({ host: SERVER, port: PORTS.V6 })
    await new Promise((resolve, reject) => {
      client.on('connect', resolve)
      client.on('error', (e) => reject(e))
      setTimeout(() => reject(new Error('IPv6 TCP 连接超时')), 5000)
    })
    ok('IPv6 TCP 端口 (9804) 可以连接（可能通过双栈）')

    const testData = 'Hello V6 Echo!'
    const response = await new Promise((resolve, reject) => {
      let data = ''
      client.on('data', (chunk) => { data += chunk.toString() })
      client.write(testData)
      setTimeout(() => {
        client.end()
        resolve(data)
      }, 1000)
      client.on('error', reject)
    })

    if (response.trim() === testData) {
      ok(`IPv6 TCP 回显正确: "${testData}" → "${response.trim()}"`)
    } else {
      fail(`IPv6 TCP 回显不匹配: 发送 "${testData}", 收到 "${response.trim()}"`)
    }

  } catch (e) {
    if (e.message === 'IPv6 TCP 连接超时') {
      fail('IPv6 TCP 端口连接超时 — 服务器可能无 IPv6 或防火墙阻止')
    } else {
      fail('IPv6 TCP 测试失败', e.message)
    }
  }
}

// ─── 运行所有测试 ─────────────────────────────────────

async function main() {
  console.log(`\n🌐 中继服务器连通性测试`)
  console.log(`   服务器: ${SERVER}`)
  console.log(`   时间:   ${new Date().toISOString()}`)
  console.log(`\n   WebSocket:  ws://${SERVER}:${PORTS.WS}`)
  console.log(`   仪表盘:     http://${SERVER}:${PORTS.HTTP}`)
  console.log(`   UDP 回显:   ${SERVER}:${PORTS.UDP}`)
  console.log(`   TCP 回显:   ${SERVER}:${PORTS.TCP}`)
  console.log(`   IPv6 TCP:   ${SERVER}:${PORTS.V6}`)

  await testHttpDashboard()
  await testWebSocketRelay()
  await testTcpEcho()
  await testUdpEcho()
  await testIpv6TcpEcho()

  // 汇总
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  测试完成: ${passed + failed} 项`)
  if (failed === 0) {
    console.log(`  🎉 全部通过 (${passed}/${passed + failed})`)
  } else {
    console.log(`  ✅ ${passed} 通过, ❌ ${failed} 失败`)
  }
  console.log(`${'='.repeat(56)}\n`)

  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('测试脚本异常:', e)
  process.exit(1)
})
