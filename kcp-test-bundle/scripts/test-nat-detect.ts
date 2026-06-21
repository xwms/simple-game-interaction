/**
 * 功能描述：NAT 类型检测 — 独立版（无需主项目依赖）
 *
 * 使用方式：npx tsx scripts/test-nat-detect.ts
 */

import * as dgram from 'dgram'
import * as crypto from 'crypto'
import * as os from 'os'

const STUN = [
  'stun.miwifi.com:3478',
  'stun.chat.bilibili.com:3478',
  'stun.cloudflare.com:3478',
  'stun.l.google.com:19302',
]
const MC = 0x2112a442

function ts() { return new Date().toISOString().replace('T', ' ').substring(0, 23) }
function log(tag: string, msg: string) { console.log(`[${ts()}] [${tag}] ${msg}`) }

function getLocalIPv4(): string[] {
  const r: string[] = []
  for (const iface of Object.values(os.networkInterfaces())) {
    if (!iface) continue
    for (const i of iface) {
      if (i.family === 'IPv4' && !i.internal) r.push(i.address)
    }
  }
  return r
}

function checkIPv6(): { ok: boolean; pub: boolean; list: string[] } {
  const a: string[] = []
  for (const iface of Object.values(os.networkInterfaces())) {
    if (!iface) continue
    for (const i of iface) {
      if (i.family === 'IPv6' && !i.internal) a.push(i.address)
    }
  }
  return { ok: a.length > 0, pub: a.some(x => !x.startsWith('fe80') && !x.startsWith('fd')), list: a }
}

async function stunQuery(sock: dgram.Socket, host: string, port: number, ttl: number) {
  const tid = crypto.randomBytes(12)
  const buf = Buffer.alloc(20)
  buf.writeUInt16BE(1, 0); buf.writeUInt32BE(MC, 4); tid.copy(buf, 8)
  const start = Date.now()
  return new Promise<any>(resolve => {
    let done = false
    const handler = (msg: Buffer) => {
      if (done || msg.length < 20 || msg.readUInt16BE(0) !== 0x0101 || msg.readUInt32BE(4) !== MC) return
      let off = 20
      const end = off + msg.readUInt16BE(2)
      while (off + 4 <= end) {
        const t = msg.readUInt16BE(off), l = msg.readUInt16BE(off + 2)
        if (t === 0x0020 && l >= 8) {
          const xp = msg.readUInt16BE(off + 6) ^ 0x2112
          const xa = Buffer.alloc(4)
          for (let i = 0; i < 4; i++) xa[i] = msg[off + 8 + i] ^ ((MC >> (24 - i * 8)) & 0xff)
          done = true; sock.off('message', handler)
          resolve({ ip: xa.join('.'), port: xp, server: `${host}:${port}`, ms: Date.now() - start, raw: msg })
          return
        }
        off += 4 + l; if (l % 4) off += 4 - (l % 4)
      }
    }
    sock.on('message', handler)
    sock.send(buf, 0, buf.length, port, host, () => {})
    setTimeout(() => { if (!done) { done = true; sock.off('message', handler); resolve(null) } }, ttl)
  })
}

async function main() {
  console.log(`\n${'='.repeat(50)}`)
  console.log('  NAT 类型检测')
  console.log(`${'='.repeat(50)}`)

  // IPv6
  console.log(`\n── IPv6 ──`)
  const v6 = checkIPv6()
  if (v6.ok) {
    log('IPv6', v6.pub ? `公网可达: ${v6.list.filter(x => !x.startsWith('fe80') && !x.startsWith('fd'))[0]}` : `可用 (${v6.list.length}个, 无公网)`)
  } else {
    log('IPv6', '不可用')
  }

  // STUN
  console.log(`\n── NAT ──`)
  const sock = dgram.createSocket('udp4')
  const localPort = await new Promise<number>(r => sock.on('listening', () => r((sock.address() as any).port)).bind())
  log('UDP', `本地端口: ${localPort}`)

  const results: any[] = []
  for (const s of STUN) {
    const [h, p] = s.split(':')
    const r = await stunQuery(sock, h, parseInt(p), 3000)
    if (r) results.push(r)
  }

  if (results.length === 0) { log('FAIL', 'STUN 全超时'); sock.close(); return }

  const best = results.reduce((a, b) => a.ms < b.ms ? a : b)
  log('STUN', `最快: ${best.server} (${best.ms}ms) → ${best.ip}:${best.port}`)

  // 多服务器映射对比
  const unique = new Set(results.map(r => `${r.ip}:${r.port}`))
  const locals = getLocalIPv4()
  const isNone = locals.includes(best.ip)

  console.log(`\n── 结果 ──`)
  log('NAT', `公网: ${best.ip}:${best.port}`)
  console.log(`  本机 IPv4: ${locals.join(', ') || '无'}`)
  console.log(`  本地端口: ${localPort}`)

  if (isNone) {
    log('NAT', '类型: none (无 NAT，公网 IP)')
  } else if (unique.size > 1) {
    log('NAT', '类型: hard-nat (Address-Dependent Mapping)')
    console.log(`  不同 STUN 服务器返回不同映射地址:`)
    for (const r of results) console.log(`    ${r.server} → ${r.ip}:${r.port}`)
  } else {
    log('NAT', '类型: easy-nat (Endpoint-Independent Mapping)')
  }

  console.log(`\n── UDP 打洞可用性 ──`)
  if (isNone) console.log('  ✅ 公网 IP，UDP 直连')
  else if (unique.size > 1) console.log('  ❌ HardNAT，UDP 打洞基本不可行（需中继）')
  else console.log('  ⚠️  EasyNAT，UDP 打洞可能可行（取决于过滤行为）')

  if (v6.pub) console.log('  ✅ IPv6 直连可用')

  sock.close()
}

main().catch(e => { console.error(`\n${e.message}\n`); process.exit(1) })
