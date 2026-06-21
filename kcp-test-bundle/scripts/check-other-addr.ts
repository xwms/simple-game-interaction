/**
 * 功能描述：解析 stun.miwifi.com 的 OTHER-ADDRESS 并测试作为第二目标
 */
import * as dgram from 'dgram'
import * as crypto from 'crypto'

const STUN_MAGIC_COOKIE = 0x2112a442

function parseOtherAddress(msg: Buffer, tid: Buffer): { ip: string; port: number } | null {
  if (msg.length < 20 || msg.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return null
  if (!msg.subarray(8, 20).equals(tid)) return null
  const len = msg.readUInt16BE(2)
  let off = 20
  while (off + 4 <= 20 + len) {
    const t = msg.readUInt16BE(off), alen = msg.readUInt16BE(off + 2)
    // 0x802B is OTHER-ADDRESS per RFC 5389
    if ((t === 0x0005 || t === 0x8023 || t === 0x802B) && alen >= 8) {
      const family = msg.readUInt8(off + 5)
      const port = msg.readUInt16BE(off + 6)
      if (family === 1) { // IPv4
        const ip = Array.from(msg.subarray(off + 8, off + 12)).join('.')
        return { ip, port }
      }
    }
    off += 4 + alen
    if (alen % 4 !== 0) off += 4 - (alen % 4)
  }
  return null
}

function createRequest(): { buf: Buffer; tid: Buffer } {
  const tid = crypto.randomBytes(12)
  const buf = Buffer.alloc(20)
  buf.writeUInt16BE(0x0001, 0)
  buf.writeUInt16BE(0, 2)
  buf.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  tid.copy(buf, 8)
  return { buf, tid }
}

async function query(socket: dgram.Socket, host: string, port: number, tid: Buffer): Promise<{ ip: string; port: number } | null> {
  const { buf } = createRequest()
  // Overwrite with provided tid
  tid.copy(buf, 8)
  return new Promise(resolve => {
    let done = false
    socket.on('message', (msg) => {
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
            ip: [(xAddr>>>24)&255,(xAddr>>>16)&255,(xAddr>>>8)&255,xAddr&255].join('.'),
            port: xPort
          })
          return
        }
        off += 4 + alen
        if (alen % 4 !== 0) off += 4 - (alen % 4)
      }
    })
    const onMsg = (msg: Buffer) => {}
    socket.on('message', onMsg)
    socket.send(buf, 0, buf.length, port, host)
    setTimeout(() => { if (!done) { done = true; resolve(null) } }, 3000)
  })
}

async function main() {
  const socket = dgram.createSocket('udp4')
  await new Promise<void>(r => socket.bind(0, () => r()))
  const localPort = (socket.address() as dgram.AddressInfo).port
  console.log(`本地端口: ${localPort}\n`)

  // 1. Query miwifi
  const { buf, tid } = createRequest()
  const miwifiResp = await new Promise<Buffer | null>(resolve => {
    let done = false
    const onMsg = (msg: Buffer) => {
      if (done) return
      if (!msg.subarray(8, 20).equals(tid)) return
      done = true; socket.off('message', onMsg); resolve(msg)
    }
    socket.on('message', onMsg)
    socket.send(buf, 0, buf.length, 3478, 'stun.miwifi.com')
    setTimeout(() => { if (!done) { done = true; resolve(null) } }, 3000)
  })

  if (!miwifiResp) { console.log('miwifi 无响应'); socket.close(); return }

  // Parse mapped address
  const mapped = parseOtherAddress(miwifiResp, tid) // wrong function for mapped, let me fix
  const parsedMapped = (() => {
    const len = miwifiResp.readUInt16BE(2)
    let off = 20
    while (off + 4 <= 20 + len) {
      const t = miwifiResp.readUInt16BE(off), alen = miwifiResp.readUInt16BE(off + 2)
      if (t === 0x0020 && alen >= 8) {
        const xPort = miwifiResp.readUInt16BE(off + 6) ^ (STUN_MAGIC_COOKIE >> 16)
        const xAddr = miwifiResp.readUInt32BE(off + 8) ^ STUN_MAGIC_COOKIE
        return { ip: [(xAddr>>>24)&255,(xAddr>>>16)&255,(xAddr>>>8)&255,xAddr&255].join('.'), port: xPort }
      }
      off += 4 + alen; if (alen % 4 !== 0) off += 4 - (alen % 4)
    }
    return null
  })()

  console.log(`miwifi 映射地址: ${parsedMapped.ip}:${parsedMapped.port}`)

  // Parse OTHER-ADDRESS
  const otherAddr = parseOtherAddress(miwifiResp, tid)
  if (otherAddr) {
    console.log(`miwifi OTHER-ADDRESS: ${otherAddr.ip}:${otherAddr.port}`)
  } else {
    console.log('miwifi 无 OTHER-ADDRESS')
    socket.close()
    return
  }

  // 3. Query the OTHER-ADDRESS
  const otherTid = crypto.randomBytes(12)
  const otherBuf = Buffer.alloc(20)
  otherBuf.writeUInt16BE(0x0001, 0)
  otherBuf.writeUInt16BE(0, 2)
  otherBuf.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  otherTid.copy(otherBuf, 8)

  const otherResp = await new Promise<{ ip: string; port: number } | null>(resolve => {
    let done = false
    const onMsg = (msg: Buffer) => {
      if (done) return
      if (!msg.subarray(8, 20).equals(otherTid)) return
      done = true; socket.off('message', onMsg)
      const len = msg.readUInt16BE(2)
      let off = 20
      while (off + 4 <= 20 + len) {
        const t = msg.readUInt16BE(off), alen = msg.readUInt16BE(off + 2)
        if (t === 0x0020 && alen >= 8) {
          const xPort = msg.readUInt16BE(off + 6) ^ (STUN_MAGIC_COOKIE >> 16)
          const xAddr = msg.readUInt32BE(off + 8) ^ STUN_MAGIC_COOKIE
          resolve({ ip: [(xAddr>>>24)&255,(xAddr>>>16)&255,(xAddr>>>8)&255,xAddr&255].join('.'), port: xPort })
          return
        }
        off += 4 + alen; if (alen % 4 !== 0) off += 4 - (alen % 4)
      }
      resolve(null)
    }
    socket.on('message', onMsg)
    socket.send(otherBuf, 0, otherBuf.length, otherAddr.port, otherAddr.ip)
    setTimeout(() => { if (!done) { done = true; resolve(null) } }, 3000)
  })

  if (otherResp) {
    console.log(`OTHER-ADDRESS 映射: ${otherResp.ip}:${otherResp.port}`)
    const samePort = otherResp.port === parsedMapped.port
    console.log(`\n端口对比: ${parsedMapped.port} vs ${otherResp.port}`)
    console.log(samePort ? '✅ 端口一致 → Endpoint-Independent Mapping' : '❌ 端口不同 → Address-Dependent Mapping (Symmetric)')
  } else {
    console.log('OTHER-ADDRESS 无响应')
  }

  socket.close()
}

main().catch(console.error)
