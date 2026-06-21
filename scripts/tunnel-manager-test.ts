/**
 * 功能描述：TunnelManager 端到端集成测试 — 模拟完整应用流程
 *
 * 逻辑说明：房主侧启动一个模拟游戏服务器（TCP 回显），通过 TunnelManager
 *           创建房间并等待加入者。加入者通过 TunnelManager 加入房间，
 *           经过路径选择和传输建立后，发送数据验证端到端可达。
 *
 * 使用方式：
 *   # 房主（先启动）
 *   npx tsx scripts/tunnel-manager-test.ts --mode host --code TMFULL
 *
 *   # 加入者
 *   npx tsx scripts/tunnel-manager-test.ts --mode guest --code TMFULL
 */

import * as net from 'net'
import { TunnelManager } from '../src/core/tunnel/tunnel-manager'

const RELAY_URL = 'ws://159.75.150.37:9800'
const GAME_PORT = 44447

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

const MODE = arg('--mode') || 'host'
const ROOM_CODE = arg('--code') || 'TMFULL'

let passed = 0
let failed = 0

function ts(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 23)
}
function log(tag: string, msg: string): void {
  console.log(`[${ts()}] [${tag}] ${msg}`)
}
function ok(msg: string): void { console.log(`  ✅ ${msg}`); passed++ }
function fail(msg: string, err = ''): void {
  console.log(`  ❌ ${msg}${err ? ` — ${err}` : ''}`)
  failed++
}
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * 功能描述：启动一个 TCP 回显服务器（模拟游戏服务器）
 */
function startEchoServer(port: number): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      const addr = `${socket.remoteAddress}:${socket.remotePort}`
      log('ECHO', `客户端已连接 [${addr}]`)
      socket.on('data', (data: Buffer) => {
        log('ECHO', `收到 ${data.length} 字节, 回显`)
        socket.write(data)
      })
      socket.on('close', () => log('ECHO', `断开 [${addr}]`))
    })
    server.listen(port, () => {
      log('ECHO', `回显服务器 :${port}`)
      resolve(server)
    })
  })
}

/**
 * 功能描述：通过 TCP 发送测试数据并验证回显
 */
function testEcho(host: string, port: number, msg: string, timeoutMs = 10000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    const timer = setTimeout(() => { socket.destroy(); resolve(false) }, timeoutMs)
    socket.connect(port, host, () => {
      socket.write(msg)
      socket.once('data', (data: Buffer) => {
        clearTimeout(timer)
        const reply = data.toString()
        const ok_ = reply.trim() === msg.trim()
        if (ok_) log('TCP', `回显正确: "${reply}"`)
        else log('TCP', `回显不匹配: 期望="${msg}", 实际="${reply}"`)
        socket.destroy()
        resolve(ok_)
      })
    })
    socket.on('error', () => { clearTimeout(timer); resolve(false) })
  })
}

// ─── Host 模式 ────────────────────────────────────────

async function runHost(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  TunnelManager 端到端测试 — HOST 模式`)
  console.log(`  中继: ${RELAY_URL}`)
  console.log(`${'='.repeat(56)}`)

  const echoServer = await startEchoServer(GAME_PORT)

  const manager = new TunnelManager({
    relayUrl: RELAY_URL,
    memberName: 'TestHost',
    connectTimeout: 30000
  })

  manager.on('connected', (data) => {
    log('TM', `连接已建立: roomCode=${data.roomCode}`)
  })
  manager.on('member-joined', (data: any) => {
    log('TM', `成员加入: ${data.name} (${data.id})`)
  })
  manager.on('error', (err: Error) => {
    log('TM', `错误: ${err.message}`)
  })

  try {
    const roomResult = await manager.createRoom({
      gameId: 'tunnel-test',
      gameName: 'Tunnel Test',
      gamePort: GAME_PORT,
      relayUrl: RELAY_URL
    })
    ok(`房间已创建: ${roomResult.roomCode}`)
    // 单独输出房间码（方便 guest 读取）
    console.log(`\n  >>> 房间码: ${roomResult.roomCode} <<<\n`)

    log('TM', '等待加入者...')
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('等待加入者超时')), 120000)
      manager.on('member-joined', () => { clearTimeout(timeout); resolve() })
    })
    ok(`加入者已连接`)

    await sleep(5000)
    log('TM', 'Host 测试完成')
    ok('Host 流程完成')
  } catch (e) {
    fail('Host 流程失败', (e as Error).message)
  }

  console.log(`\n${'='.repeat(56)}`)
  console.log(`  测试完成: ${passed + failed} 项`)
  console.log(`  ✅ ${passed} 通过, ❌ ${failed} 失败`)
  echoServer.close()
  process.exit(failed > 0 ? 1 : 0)
}

// ─── Guest 模式 ───────────────────────────────────────

async function runGuest(): Promise<void> {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  TunnelManager 端到端测试 — GUEST 模式`)
  console.log(`  中继: ${RELAY_URL}`)
  console.log(`${'='.repeat(56)}`)

  const manager = new TunnelManager({
    relayUrl: RELAY_URL,
    memberName: 'TestGuest',
    connectTimeout: 60000
  })

  let transportReady = false
  let guestLocalPort = 0
  let guestGamePort = 0

  manager.on('connected', (data: any) => {
    transportReady = true
    guestLocalPort = data.localPort
    guestGamePort = data.gamePort
    log('TM', `传输已建立: localPort=${data.localPort}, gamePort=${data.gamePort}`)
  })
  manager.on('error', (err: Error) => {
    log('TM', `错误: ${err.message}`)
  })
  manager.on('status', (state: string) => {
    log('TM', `状态: ${state}`)
  })

  try {
    await manager.joinRoom(ROOM_CODE, RELAY_URL)
    ok('已加入房间')

    // 等待 connected 事件
    for (let i = 0; i < 60; i++) {
      if (transportReady) break
      await sleep(1000)
    }

    if (!transportReady) {
      fail('传输未建立')
      process.exit(1)
    }
    // 获取传输类型
    const status = await manager.getStatus()
    ok(`传输已建立 (type=${status.transportType}, localPort=${guestLocalPort})`)

    // 通过隧道发送测试数据：连接 localhost:guestLocalPort
    // 数据流：guest → LocalTunnelServer → Transport → host LocalTunnelClient → 游戏回显服务器
    await sleep(500) // 等待隧道就绪
    const echoOk = await testEcho('127.0.0.1', guestLocalPort, 'HelloTunnel!')
    if (echoOk) ok('端到端数据回显正确')
    else fail('端到端数据回显失败')

    // 多发几包验证稳定性
    let allOk = true
    for (let i = 0; i < 3; i++) {
      const r = await testEcho('127.0.0.1', guestLocalPort, `Data-${i}`)
      if (!r) allOk = false
    }
    if (allOk) ok('多包数据传输正常')
    else fail('多包数据传输异常')

  } catch (e) {
    fail('Guest 流程失败', (e as Error).message)
  }

  console.log(`\n${'='.repeat(56)}`)
  console.log(`  测试完成: ${passed + failed} 项`)
  console.log(`  ✅ ${passed} 通过, ❌ ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

// ─── 入口 ─────────────────────────────────────────────

async function main(): Promise<void> {
  if (MODE === 'guest') await runGuest()
  else await runHost()
}

main().catch(e => { console.error(`\n❌ ${e.message}\n`); process.exit(1) })
