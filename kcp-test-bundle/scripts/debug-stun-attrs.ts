/**
 * 功能描述：测试同一 socket 对不同 STUN 目标/NAT 的端口分配
 */
import * as dgram from 'dgram'
import * as dns from 'dns'
import * as crypto from 'crypto'

const STUN_MAGIC_COOKIE = 0x2112a442

function createStunRequest(): Buffer {
  const buf = Buffer.alloc(20)
  buf.writeUInt16BE(0x0001, 0); buf.writeUInt16BE(0, 2)
  buf.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  crypto.randomBytes(12).copy(buf, 8)
  return buf
}

function parseStunAddr(msg: Buffer): { ip: string; port: number; tid: Buffer } | null {
  if (msg.length < 20 || msg.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return null
  const len = msg.readUInt16BE(2)
  let off = 20, end = off + len
  while (off + 4 <= end) {
    const t = msg.readUInt16BE(off), alen = msg.readUInt16BE(off + 2)
    if (t === 0x0020 && alen >= 8) {
      const port = msg.readUInt16BE(off + 6) ^ (STUN_MAGIC_COOKIE >> 16)
      const x = msg.readUInt32BE(off + 8) ^ STUN_MAGIC_COOKIE
      const ip = [x>>>24&255, x>>>16&255, x>>>8&255, x&255].join('.')
      return { ip, port, tid: msg.subarray(8, 20) }
    }
    off += 4 + alen; if (alen % 4 !== 0) off += 4 - (alen % 4)
  }
  return null
}

async function stunQuery(socket: dgram.Socket, host: string, port: number, timeout = 3000): Promise<{ ip: string; port: number } | null> {
  const buf = createStunRequest()
  const tid = buf.subarray(8, 20)
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeout)
    const handler = (msg: Buffer) => {
      if (!msg.subarray(8, 20).equals(tid)) return
      clearTimeout(t)
      const r = parseStunAddr(msg)
      resolve(r ? { ip: r.ip, port: r.port } : null)
    }
    socket.on('message', handler)
    socket.send(buf, 0, buf.length, port, host, (err) => {
      if (err) { clearTimeout(t); socket.off('message', handler); resolve(null) }
    })
    // No cleanup on timeout — the handler stays but won't cause issues
  })
}

async function test(): Promise<void> {
  const targets = [
    { name: 'stun.l.google.com', host: 'stun.l.google.com', port: 19302 },
  ]

  // Resolve DNS to get IPs
  const googleIPs = await new Promise<string[]>((resolve) => {
    dns.resolve4('stun.l.google.com', (err, addrs) => resolve(err ? [] : addrs))
  })
  const google1IPs = await new Promise<string[]>((resolve) => {
    dns.resolve4('stun1.l.google.com', (err, addrs) => resolve(err ? [] : addrs))
  })

  console.log('stun.l.google.com 解析:', googleIPs)
  console.log('stun1.l.google.com 解析:', google1IPs)

  // Same socket, query different targets
  const socket = dgram.createSocket('udp4')
  await new Promise<void>(r => socket.bind(0, () => r()))
  const localPort = (socket.address() as dgram.AddressInfo).port
  console.log(`\n本地端口: ${localPort}`)
  console.log('')

  const results: Array<{ target: string; mapped: string }> = []

  // Query 1 — stun.l.google.com
  for (const ip of [...new Set([...googleIPs, ...google1IPs])]) {
    const r = await stunQuery(socket, ip, 19302, 2000)
    if (r) {
      results.push({ target: ip, mapped: `${r.ip}:${r.port}` })
      console.log(`  目标 ${ip}:19302 → 映射 ${r.ip}:${r.port}`)
    } else {
      console.log(`  目标 ${ip}:19302 → 超时`)
    }
  }

  // Query stun.l.google.com by hostname (may resolve to different IP)
  const r1 = await stunQuery(socket, 'stun.l.google.com', 19302, 3000)
  if (r1) results.push({ target: 'stun.l.google.com', mapped: `${r1.ip}:${r1.port}` })

  // If we have 2+ results, check for port changes
  console.log(`\n── 端口对比 ──`)
  if (results.length >= 2) {
    const ports = results.map(r => parseInt(r.mapped.split(':')[1]))
    const uniquePorts = new Set(ports)
    if (uniquePorts.size > 1) {
      console.log(`❌ 端口不一致! ${results.map(r => `${r.target}=${r.mapped.split(':')[1]}`).join(', ')}`)
      console.log(`   判定: Address-Dependent Mapping (Symmetric NAT)`)
    } else {
      console.log(`✅ 端口一致: ${ports[0]}`)
      console.log(`   判定: Endpoint-Independent Mapping`)
    }
  } else {
    console.log('  不足以判断 (仅 1 个响应)')
  }

  socket.close()
}

test().catch(console.error)
