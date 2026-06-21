/**
 * 功能描述：测试各个 STUN 服务器在国内的可达性
 */
import * as dgram from 'dgram'
import * as crypto from 'crypto'

const STUN_MAGIC_COOKIE = 0x2112a442

const SERVERS = [
  'stun.qq.com:3478',
  'stun.miwifi.com:3478',
  'stun.chat.bilibili.com:3478',
  'stun.wide.net.cn:3478',
  'stun.cloudflare.com:3478',
  'stun.l.google.com:19302',
  'stun.ekiga.net:3478',
  'stun.ideasip.com:3478',
]

function createStunRequest(): Buffer {
  const buf = Buffer.alloc(20)
  buf.writeUInt16BE(0x0001, 0)
  buf.writeUInt16BE(0, 2)
  buf.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  crypto.randomBytes(12).copy(buf, 8)
  return buf
}

function parseStunResponse(msg: Buffer, tid: Buffer): { ip: string; port: number } | null {
  if (msg.length < 20 || msg.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return null
  if (!msg.subarray(8, 20).equals(tid)) return null
  const len = msg.readUInt16BE(2)
  let off = 20
  while (off + 4 <= 20 + len) {
    const t = msg.readUInt16BE(off), alen = msg.readUInt16BE(off + 2)
    if (t === 0x0020 && alen >= 8) {
      const xPort = msg.readUInt16BE(off + 6) ^ (STUN_MAGIC_COOKIE >> 16)
      const xAddr = msg.readUInt32BE(off + 8) ^ STUN_MAGIC_COOKIE
      return {
        ip: [(xAddr >>> 24) & 255, (xAddr >>> 16) & 255, (xAddr >>> 8) & 255, xAddr & 255].join('.'),
        port: xPort
      }
    }
    off += 4 + alen
    if (alen % 4 !== 0) off += 4 - (alen % 4)
  }
  return null
}

async function test(host: string, port: number): Promise<{ ok: boolean; ms?: number; mapped?: string; err?: string }> {
  return new Promise(resolve => {
    const socket = dgram.createSocket('udp4')
    const buf = createStunRequest()
    const tid = buf.subarray(8, 20)
    const start = Date.now()
    let done = false

    const cleanup = () => { done = true; socket.close() }

    socket.on('message', (msg) => {
      if (done) return
      const r = parseStunResponse(msg, tid)
      if (r) {
        cleanup()
        resolve({ ok: true, ms: Date.now() - start, mapped: `${r.ip}:${r.port}` })
      }
    })

    socket.send(buf, 0, buf.length, port, host, (err) => {
      if (err) { cleanup(); resolve({ ok: false, err: err.message }) }
    })

    setTimeout(() => { if (!done) { cleanup(); resolve({ ok: false, err: 'timeout' }) } }, 3000)
  })
}

async function main(): Promise<void> {
  console.log('STUN 服务器可达性测试\n')
  for (const s of SERVERS) {
    const [host, portStr] = s.split(':')
    const port = parseInt(portStr, 10)
    const r = await test(host, port)
    if (r.ok) {
      console.log(`  OK  ${s}  (${r.ms}ms) 映射: ${r.mapped}`)
    } else {
      console.log(`  --  ${s}  (${r.err})`)
    }
  }
}

main().catch(console.error)
