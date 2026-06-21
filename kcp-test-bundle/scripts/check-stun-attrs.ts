/**
 * 功能描述：检查 STUN 服务器支持的属性（CHANGED-ADDRESS, OTHER-ADDRESS 等）
 */
import * as dgram from 'dgram'
import * as crypto from 'crypto'

const STUN_MAGIC_COOKIE = 0x2112a442
const SERVERS = [
  'stun.miwifi.com:3478',
  'stun.chat.bilibili.com:3478',
  'stun.cloudflare.com:3478',
  'stun.l.google.com:19302',
]

function createRequest(changeRequest = 0): Buffer {
  const attrLen = changeRequest ? 8 : 0
  const buf = Buffer.alloc(20 + attrLen)
  buf.writeUInt16BE(0x0001, 0)
  buf.writeUInt16BE(attrLen, 2)
  buf.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  crypto.randomBytes(12).copy(buf, 8)
  if (changeRequest) {
    buf.writeUInt16BE(0x0003, 20)
    buf.writeUInt16BE(4, 22)
    buf.writeUInt32BE(changeRequest, 24)
  }
  return buf
}

function enumerateAttrs(msg: Buffer, tid: Buffer): string[] {
  if (msg.length < 20 || msg.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return []
  if (!msg.subarray(8, 20).equals(tid)) return []
  const len = msg.readUInt16BE(2)
  const attrs: string[] = []
  let off = 20
  while (off + 4 <= 20 + len) {
    const t = msg.readUInt16BE(off)
    const alen = msg.readUInt16BE(off + 2)
    const names: Record<number, string> = {
      0x0001: 'MAPPED-ADDRESS',
      0x0004: 'SOURCE-ADDRESS',
      0x0005: 'CHANGED-ADDRESS',
      0x0020: 'XOR-MAPPED-ADDRESS',
      0x8023: 'OTHER-ADDRESS',   // RFC 5389 variant
      0x802B: 'OTHER-ADDRESS(2)',
    }
    attrs.push(`${names[t] || `0x${t.toString(16)}`} (len=${alen})`)
    off += 4 + alen
    if (alen % 4 !== 0) off += 4 - (alen % 4)
  }
  return attrs
}

async function test(host: string, port: number): Promise<void> {
  const socket = dgram.createSocket('udp4')

  // 1. Normal request
  const buf1 = createRequest(0)
  const tid1 = buf1.subarray(8, 20)
  const r1 = await new Promise<string[]>((resolve) => {
    let done = false
    socket.on('message', (msg) => {
      if (done) return
      done = true; socket.close()
      resolve(enumerateAttrs(msg, tid1))
    })
    socket.send(buf1, 0, buf1.length, port, host)
    setTimeout(() => { if (!done) { done = true; socket.close(); resolve([]) } }, 3000)
  })

  console.log(`\n${host}:${port} 普通请求响应属性:`)
  if (r1.length === 0) {
    console.log('  无响应')
  } else {
    for (const a of r1) console.log(`  ${a}`)
  }

  // 2. CHANGE-REQUEST (change IP + port)
  const socket2 = dgram.createSocket('udp4')
  const buf2 = createRequest(0x0006) // CHANGE_IP | CHANGE_PORT
  const tid2 = buf2.subarray(8, 20)
  const r2 = await new Promise<{ ok: boolean; fromPort: number }>((resolve) => {
    let done = false
    socket2.on('message', (msg, rinfo) => {
      if (done) return
      const attrs = enumerateAttrs(msg, tid2)
      if (attrs.length > 0) {
        done = true; socket2.close()
        resolve({ ok: true, fromPort: rinfo.port })
      }
    })
    socket2.send(buf2, 0, buf2.length, port, host)
    setTimeout(() => { if (!done) { done = true; socket2.close(); resolve({ ok: false, fromPort: 0 }) } }, 3000)
  })

  if (r2.ok) {
    console.log(`  CHANGE-REQUEST(IP+Port): ✅ 支持 (响应来源端口: ${r2.fromPort}, 请求目标端口: ${port})`)
    console.log(`  ${r2.fromPort !== port ? '→ 从不同端口响应，支持 RFC 3489' : '→ 从同一端口响应，未真正 CHANGE'}`)
  } else {
    console.log(`  CHANGE-REQUEST(IP+Port): ❌ 不支持`)
  }
}

async function main() {
  for (const s of SERVERS) {
    const [host, portStr] = s.split(':')
    await test(host, parseInt(portStr))
  }
  console.log()
}

main().catch(console.error)
