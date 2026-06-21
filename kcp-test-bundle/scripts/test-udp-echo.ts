/**
 * 功能描述：纯 UDP 双向通信测试 — 验证公网 UDP 双向可达
 *
 * 逻辑说明：Host 监听 UDP，Guest 发探测包建立连接后双向发送确认。
 *          跳过 KCP，直接测试原始 UDP 能否双向通行。
 *
 * 使用方式：
 *   # Host（云服务器）
 *   npx tsx scripts/test-udp-echo.ts --mode host --public-ip 159.75.150.37
 *
 *   # Guest（本地）
 *   npx tsx scripts/test-udp-echo.ts --mode guest --host-ip 159.75.150.37
 */

import * as dgram from 'dgram'

const HOST_PORT = 19800

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

function log(tag: string, msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 23)}] [${tag}] ${msg}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function runHost(): Promise<void> {
  const useIpv6 = arg('--v6') === 'true'
  const hostBind = useIpv6 ? '::' : '0.0.0.0'
  const hostIp = arg('--public-ip') || hostBind
  const socket = dgram.createSocket(useIpv6 ? 'udp6' : 'udp4')
  socket.bind(HOST_PORT, hostBind)

  let guestAddr: dgram.RemoteInfo | null = null

  socket.on('message', (msg, rinfo) => {
    if (!guestAddr) {
      guestAddr = rinfo
      log('HOST', `收到 Guest 首包: ${rinfo.address}:${rinfo.port}, 回复确认`)
    }
    socket.send(Buffer.from(`ACK:${msg.toString()}`), rinfo.port, rinfo.address)
    log('HOST', `回显 ${msg.length}B 到 ${rinfo.address}:${rinfo.port}`)
  })

  log('HOST', `监听 ${hostIp}:${HOST_PORT}...`)
  log('HOST', `公网地址: ${arg('--public-ip') || '未知'}:${HOST_PORT}`)

  // 等待 guest 发 5 轮，然后退出
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    if (guestAddr) break
  }

  await sleep(15000)
  log('HOST', '测试结束')
  socket.close()
  process.exit(0)
}

async function runGuest(): Promise<void> {
  const useIpv6 = arg('--v6') === 'true'
  const hostIp = arg('--host-ip') || (useIpv6 ? '::1' : '127.0.0.1')
  const hostPort = arg('--host-port') ? parseInt(arg('--host-port')!, 10) : HOST_PORT

  const socket = dgram.createSocket(useIpv6 ? 'udp6' : 'udp4')
  socket.bind(0)

  const received: string[] = []

  socket.on('message', (msg) => {
    const text = msg.toString()
    received.push(text)
    log('GUEST', `收到回复: "${text}"`)
  })

  await sleep(500)

  // 发送 5 轮探测，每轮 5 个包（模拟多 socket），间隔 200ms
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 5; i++) {
      const payload = Buffer.from(`HELLO-${round}-${i}`)
      socket.send(payload, hostPort, hostIp)
      log('GUEST', `发送: HELLO-${round}-${i}`)
    }
    await sleep(200)
  }

  // 等待回复
  await sleep(3000)

  const recvCount = received.filter(r => r.startsWith('ACK:')).length
  console.log(`\n─── 结果 ───`)
  console.log(`发送 25 个包，收到 ${received.length} 个回复`)
  if (received.length > 0) {
    console.log(`双向 UDP 通信成功！`)
  } else {
    console.log(`双向 UDP 通信失败 — 运营商/防火墙阻止了入站 UDP`)
  }

  socket.close()
  process.exit(received.length > 0 ? 0 : 1)
}

async function main(): Promise<void> {
  const mode = arg('--mode') || 'guest'
  if (mode === 'host') await runHost()
  else await runGuest()
}

main().catch(e => { console.error(e); process.exit(1) })
