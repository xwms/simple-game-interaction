/**
 * 功能描述：用同一 socket 测试多 STUN 服务器的映射端口一致性
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

function createRequest(): { buf: Buffer; tid: Buffer } {
  const tid = crypto.randomBytes(12)
  const buf = Buffer.alloc(20)
  buf.writeUInt16BE(0x0001, 0)
  buf.writeUInt16BE(0, 2)
  buf.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  tid.copy(buf, 8)
  return { buf, tid }
}

function queryOnce(socket: dgram.Socket, host: string, port: number, timeout = 2000): Promise<{ ip: string; port: number } | null> {
  const { buf, tid } = createRequest()
  return new Promise(resolve => {
    let done = false
    const onMsg = (msg: Buffer) => {
      if (done) return
      if (msg.length < 20 || msg.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return
      if (!msg.subarray(8, 20).equals(tid)) return
      const len = msg.readUInt16BE(2)
      let off = 20
      while (off + 4 <= 20 + len) {
        const t = msg.readUInt16BE(off), alen = msg.readUInt16BE(off + 2)
        if (t === 0x0020 && alen >= 8) {
          const xPort = msg.readUInt16BE(off + 6) ^ (STUN_MAGIC_COOKIE >> 16)
          const xAddr = msg.readUInt32BE(off + 8) ^ STUN_MAGIC_COOKIE
          done = true; socket.off('message', onMsg)
          resolve({
            ip: [(xAddr >>> 24) & 255, (xAddr >>> 16) & 255, (xAddr >>> 8) & 255, xAddr & 255].join('.'),
            port: xPort
          })
          return
        }
        off += 4 + alen
        if (alen % 4 !== 0) off += 4 - (alen % 4)
      }
    }
    socket.on('message', onMsg)
    socket.send(buf, 0, buf.length, port, host, (err) => {
      if (err) { done = true; socket.off('message', onMsg); resolve(null) }
    })
    setTimeout(() => {
      if (!done) { done = true; socket.off('message', onMsg); resolve(null) }
    }, timeout)
  })
}

async function main(): Promise<void> {
  const socket = dgram.createSocket('udp4')
  await new Promise<void>(r => socket.bind(0, () => r()))
  const localPort = (socket.address() as dgram.AddressInfo).port
  console.log(`同一 socket 本地端口: ${localPort}\n`)

  for (const s of SERVERS) {
    const [host, portStr] = s.split(':')
    const port = parseInt(portStr, 10)
    const r = await queryOnce(socket, host, port)
    if (r) {
      console.log(`  ${(s + ' ').padEnd(35)}映射 ${r.ip}:${r.port}`)
    } else {
      console.log(`  ${(s + ' ').padEnd(35)}超时`)
    }
  }

  socket.close()
  console.log(`\n所有端口相同 → endpoint-independent mapping`)
  console.log(`端口不同 → address-dependent mapping (Symmetric NAT)`)
}

main().catch(console.error)
