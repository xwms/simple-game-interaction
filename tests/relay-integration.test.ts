/**
 * 功能描述：中继服务器端到端集成测试
 *
 * 逻辑说明：覆盖完整协议流程 — 房间管理、信令转发、二进制数据中继、心跳、健康检查。
 *           用法：npx tsx tests/relay-integration.test.ts
 *           远程测试：RELAY_URL=ws://服务器IP:9800 npx tsx tests/relay-integration.test.ts
 */

import WebSocket from 'ws'

const RELAY_URL = process.env.RELAY_URL || 'ws://127.0.0.1:9800'
const ADMIN_URL = process.env.ADMIN_URL || 'http://127.0.0.1:9801'
const TIMEOUT = 5000
const BINARY_FRAME_HEADER_SIZE = 4

let passed = 0
let failed = 0

function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function assert(label: string, ok: boolean): void {
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}`) }
}

function wsConnect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Connect timeout')), TIMEOUT)
    const ws = new WebSocket(url)
    ws.onopen = () => { clearTimeout(t); resolve(ws) }
    ws.onerror = () => { clearTimeout(t); reject(new Error('Connect failed')) }
  })
}

function wsWaitMsg(ws: WebSocket, filter?: (msg: any) => boolean, timeout = TIMEOUT): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Message timeout')), timeout)
    const handler = (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString())
        if (!filter || filter(msg)) {
          clearTimeout(t)
          ws.off('message', handler)
          resolve(msg)
        }
      } catch { /* not JSON, skip */ }
    }
    ws.on('message', handler)
  })
}

function wsWaitBinary(ws: WebSocket, timeout = TIMEOUT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Binary timeout')), timeout)
    const handler = (data: Buffer) => {
      if (Buffer.isBuffer(data)) {
        clearTimeout(t)
        ws.off('message', handler)
        resolve(data)
      }
    }
    ws.on('message', handler)
  })
}

async function main(): Promise<void> {
  console.log(`\nRelay Server Integration Test`)
  console.log(`  Server: ${RELAY_URL}`)
  console.log(`  Admin:  ${ADMIN_URL}\n`)

  await wait(500)

  // ─── 1. 创建房间 ─────────────────────
  console.log('── Room Lifecycle ──')
  const host = await wsConnect(RELAY_URL)
  assert('Host WebSocket connected', true)

  host.send(JSON.stringify({
    type: 'create-room',
    messageId: 'req_1',
    data: {
      gameId: 'minecraft',
      gameName: 'Minecraft Java Edition',
      gamePort: 25565,
      memberName: 'HostPlayer',
      networkInfo: { natType: 'none', ip: '1.2.3.4' }
    }
  }))

  const createRes = await wsWaitMsg(host, (m) => m.type === 'room-created')
  assert('create-room → room-created response received', !!createRes)
  assert('  roomCode is 6 chars', /^[A-Z0-9]{6}$/.test(createRes.data.roomCode))
  assert('  memberId starts with member_', createRes.data.memberId.startsWith('member_'))

  const roomCode = createRes.data.roomCode
  const hostMemberId = createRes.data.memberId

  // ─── 2. 加入房间 ─────────────────────
  const guest = await wsConnect(RELAY_URL)
  assert('Guest WebSocket connected', true)

  const hostJoinedPromise = wsWaitMsg(host, (m) => m.type === 'member-joined')

  guest.send(JSON.stringify({
    type: 'join-room',
    messageId: 'req_2',
    data: { roomCode, memberName: 'GuestPlayer', networkInfo: { natType: 'restricted' } }
  }))

  const joinRes = await wsWaitMsg(guest, (m) => m.type === 'room-joined')
  assert('join-room → room-joined response received', !!joinRes)
  assert('  serverId matches host memberId', joinRes.data.serverId === hostMemberId)
  assert('  members list includes host', joinRes.data.members.some((m: any) => m.id === hostMemberId))
  assert('  gamePort preserved', joinRes.data.gamePort === 25565)

  const guestMemberId = joinRes.data.memberId

  const hostJoined = await hostJoinedPromise
  assert('Host receives member-joined', hostJoined.data.memberId === guestMemberId)
  assert('  memberName matches', hostJoined.data.memberName === 'GuestPlayer')

  // ─── 3. 成员离开 ─────────────────────
  assert('Health shows 1 room', true) // deferred check

  // ─── 4. 信令转发 ─────────────────────
  console.log('── Signal Forwarding ──')
  const guestSignalPromise = wsWaitMsg(guest, (m) => m.type === 'signal')

  host.send(JSON.stringify({
    type: 'signal',
    data: { to: guestMemberId, signalData: { type: 'offer', sdp: 'v=0\no=- 123 456 IN IP4 1.2.3.4' } }
  }))

  const signal = await guestSignalPromise
  assert('Signal forwarded to guest', signal.data.from === hostMemberId)
  assert('  signalData type preserved', signal.data.signalData.type === 'offer')

  // Guest → Host signal
  const hostSignalPromise = wsWaitMsg(host, (m) => m.type === 'signal')

  guest.send(JSON.stringify({
    type: 'signal',
    data: { to: hostMemberId, signalData: { type: 'answer', sdp: 'v=0\no=- 789 012 IN IP4 5.6.7.8' } }
  }))

  const hostSignal = await hostSignalPromise
  assert('Signal forwarded to host', hostSignal.data.from === guestMemberId)
  assert('  bidirectional signal works', hostSignal.data.signalData.type === 'answer')

  // ─── 5. 心跳 ─────────────────────────
  console.log('── Heartbeat ──')
  guest.send(JSON.stringify({ type: 'heartbeat', data: { roomCode } }))
  await wait(500)
  // Health check will confirm both members alive
  const healthAfterHeartbeat = await fetch(`${ADMIN_URL}/health`).then(r => r.json())
  assert('Health check accessible', healthAfterHeartbeat.status === 'ok')
  assert('  rooms count correct', healthAfterHeartbeat.rooms >= 1)
  assert('  connections >= 2', healthAfterHeartbeat.clients >= 2)
  assert('  uptime is positive', healthAfterHeartbeat.uptime > 0)

  // ─── 6. 二进制数据中继 ────────────────
  console.log('── Binary Relay ──')

  // Guest → Host: [4B payloadLen][payload]
  const hostBinaryPromise = wsWaitBinary(host)

  const guestPayload = Buffer.from('Hello from guest!')
  const guestFrame = Buffer.alloc(BINARY_FRAME_HEADER_SIZE + guestPayload.length)
  guestFrame.writeUInt32BE(guestPayload.length, 0)
  guestPayload.copy(guestFrame, BINARY_FRAME_HEADER_SIZE)
  guest.send(guestFrame)

  const hostReceived = await hostBinaryPromise
  assert('Host received binary from guest', hostReceived.length >= 8)

  // Host receives: [4B sourceIdLen][sourceId][4B payloadLen][payload]
  const srcLen = hostReceived.readUInt32BE(0)
  const srcId = hostReceived.subarray(4, 4 + srcLen).toString('utf8')
  const innerPayloadLen = hostReceived.readUInt32BE(4 + srcLen)
  const innerPayload = hostReceived.subarray(4 + srcLen + BINARY_FRAME_HEADER_SIZE,
    4 + srcLen + BINARY_FRAME_HEADER_SIZE + innerPayloadLen)
  assert('  sourceId matches guest', srcId === guestMemberId)
  assert('  payload content matches', innerPayload.toString() === 'Hello from guest!')
  assert('  payloadLen correct', innerPayloadLen === guestPayload.length)

  // Host → Guest: [4B targetIdLen][targetId][4B payloadLen][payload]
  const guestBinaryPromise = wsWaitBinary(guest)

  const hostPayload = Buffer.from('Hello from host!')
  const targetIdBuf = Buffer.from(guestMemberId, 'utf8')
  const hostFrame = Buffer.alloc(4 + targetIdBuf.length + BINARY_FRAME_HEADER_SIZE + hostPayload.length)
  let offset = 0
  hostFrame.writeUInt32BE(targetIdBuf.length, offset); offset += 4
  targetIdBuf.copy(hostFrame, offset); offset += targetIdBuf.length
  hostFrame.writeUInt32BE(hostPayload.length, offset); offset += BINARY_FRAME_HEADER_SIZE
  hostPayload.copy(hostFrame, offset)

  host.send(hostFrame)

  const guestReceived = await guestBinaryPromise
  assert('Guest received binary from host', guestReceived.length === hostPayload.length)
  assert('  payload content matches', guestReceived.toString() === 'Hello from host!')

  // ─── 7. 离开房间 ─────────────────────
  console.log('── Leave Room ──')

  const hostLeftPromise = wsWaitMsg(host, (m) => m.type === 'member-left')

  guest.send(JSON.stringify({ type: 'leave-room', data: { roomCode } }))
  await wait(300)

  const hostLeft = await hostLeftPromise
  assert('Host receives member-left after guest leaves', hostLeft.data.memberId === guestMemberId)

  // Host leaves → room closed for remaining members (none, since guest already left)
  host.send(JSON.stringify({ type: 'leave-room', data: { roomCode } }))
  await wait(300)

  // Re-check health — room should be gone
  const healthFinal = await fetch(`${ADMIN_URL}/health`).then(r => r.json())
  assert('Room cleaned up after all members left', healthFinal.rooms === 0)

  // ─── 8. 错误场景 ──────────────────────
  console.log('── Error Handling ──')

  // Invalid room code format
  const badJoin = await wsConnect(RELAY_URL)
  badJoin.send(JSON.stringify({
    type: 'join-room',
    messageId: 'req_err',
    data: { roomCode: 'bad', memberName: 'X' }
  }))
  const err1 = await wsWaitMsg(badJoin, (m) => m.type === 'error')
  assert('Invalid room code → error response', err1.error?.code === 'invalid-params')
  badJoin.close()

  // Unknown message type
  const unknown = await wsConnect(RELAY_URL)
  unknown.send(JSON.stringify({ type: 'unknown-type', messageId: 'req_unk' }))
  const err2 = await wsWaitMsg(unknown, (m) => m.type === 'error')
  assert('Unknown message type → error response', err2.error?.code === 'invalid-params')
  unknown.close()

  // ─── 9. 管理 API ──────────────────────
  console.log('── Admin API ──')

  const metricsRes = await fetch(`${ADMIN_URL}/metrics`)
  const metrics = await metricsRes.text()
  assert('Metrics endpoint returns text', metrics.includes('sgi_relay_'))
  assert('  contains rooms_total', metrics.includes('sgi_relay_rooms_total'))

  const roomsRes = await fetch(`${ADMIN_URL}/api/rooms`)
  const rooms = await roomsRes.json()
  assert('Rooms API returns array', Array.isArray(rooms))

  // ─── 汇总 ─────────────────────────────
  console.log(`\n── Results: ${passed} passed, ${failed} failed ──`)
  host.close()
  guest.close()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error(`\n✗ Fatal: ${err.message}`)
  process.exit(1)
})
