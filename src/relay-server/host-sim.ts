/**
 * 功能描述：房主模拟脚本 — 连接本地游戏服务器，通过 WebSocket 中继转发数据
 *
 * 逻辑说明：1) 连接到中继服务器并创建房间
 *           2) 每个加入者拥有独立的 TCP 连接到游戏服务器（per-guest）
 *           3) 收到重置帧（payloadLen=0）时重建游戏连接
 *              适配 Minecraft 单连接单协议模式（STATUS 和 LOGIN 需独立连接）
 *           4) 将游戏服务器数据通过中继转发到对应加入者
 *           5) 将加入者的数据写回游戏服务器的对应连接
 *           使用代际计数器防止陈旧事件干扰新连接。
 *
 * 使用方式：npx tsx src/relay-server/host-sim.ts [游戏端口] [游戏主机] [房间码]
 *           默认连接 127.0.0.1:25565 (Minecraft)，房间码固定为 TEST12
 */

import WebSocket from 'ws'
import * as net from 'net'

const RELAY_URL = 'ws://127.0.0.1:9800'
const ROOM_CODE = process.argv[4] || 'TEST12'
const GAME_HOST = process.argv[2] || '127.0.0.1'
const GAME_PORT = parseInt(process.argv[3] || '25565', 10)

/**
 * 功能描述：加入者状态
 *
 * 逻辑说明：socket 为游戏服务器的 TCP 连接（惰性建立），
 *           gen 为代际计数器，每次重建连接时递增，
 *           闭包中捕获的 gen 用于忽略陈旧连接的事件。
 */
interface GuestState {
  memberId: string
  memberName: string
  socket: net.Socket | null
  connectPromise: Promise<void> | null
  pendingBuffer: Buffer[]
  gen: number
}

let roomCode = ''
let ws: WebSocket | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let running = true

/** 每个 Guest 独立的游戏服务器连接状态 */
const guests = new Map<string, GuestState>()

function safeSend(socket: WebSocket, data: string | Buffer): void {
  try {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(data)
    }
  } catch {
    // ws.send 在网络波动时可能抛出，忽略
  }
}

function sendJson(socket: WebSocket, msg: Record<string, unknown>): void {
  safeSend(socket, JSON.stringify(msg))
}

/**
 * 功能描述：发送带有目标成员 ID 的二进制数据帧（Host→Guest）
 *
 * 逻辑说明：帧格式 [4B targetIdLen][targetId UTF8][4B payloadLen][payload]
 *           中继服务器根据 targetId 转发到指定 Guest。
 */
function sendBinaryToGuest(socket: WebSocket, targetId: string, data: Buffer): void {
  const idBuf = Buffer.from(targetId, 'utf8')
  const idHeader = Buffer.alloc(4)
  idHeader.writeUInt32BE(idBuf.length, 0)
  const payloadHeader = Buffer.alloc(4)
  payloadHeader.writeUInt32BE(data.length, 0)
  safeSend(socket, Buffer.concat([idHeader, idBuf, payloadHeader, data]))
}

/**
 * 功能描述：惰性连接指定 Guest 的游戏服务器连接
 *
 * 逻辑说明：使用代际计数器（gen）确保回调中只处理属于当前代的连接。
 *           陈旧连接的事件（data/close/error）被静默忽略。
 *
 * @param memberId - Guest 成员 ID
 */
function triggerLazyConnect(memberId: string): void {
  const guest = guests.get(memberId)
  if (!guest || guest.connectPromise) return
  if (guest.socket && !guest.socket.destroyed) return

  const myGen = ++guest.gen
  console.log(`[房主] 连接游戏服务器 [${memberId}]: ${GAME_HOST}:${GAME_PORT}...`)

  guest.connectPromise = new Promise<void>((resolve) => {
    const socket = net.createConnection({ host: GAME_HOST, port: GAME_PORT }, () => {
      if (!running) { socket.destroy(); resolve(); return }
      // 检查代际：如果连接建立时 gen 已过时，说明已有更新的连接，销毁这个过期 socket
      const currentGuest = guests.get(memberId)
      if (!currentGuest || currentGuest.gen !== myGen) {
        socket.destroy()
        resolve()
        return
      }
      guest.socket = socket
      guest.connectPromise = null
      flushPendingBuffer(memberId)
      console.log(`[房主] 游戏服务器已连接 [${memberId}]`)
      resolve()
    })

    socket.on('data', (data: Buffer) => {
      if (!running || !ws) return
      // 忽略陈旧代际的数据（旧连接被重置后仍在缓冲中的数据）
      const currentGuest = guests.get(memberId)
      if (!currentGuest || currentGuest.gen !== myGen) return
      sendBinaryToGuest(ws, memberId, data)
    })

    socket.on('close', () => {
      const currentGuest = guests.get(memberId)
      if (!currentGuest || currentGuest.gen !== myGen) return
      console.log(`[房主] 游戏服务器连接已断开 [${memberId}]，等待惰性重连...`)
      guest.socket = null
      guest.connectPromise = null
    })

    socket.on('error', (err: Error) => {
      console.error(`[房主] 游戏服务器错误 [${memberId}]: ${err.message}`)
      socket.destroy()
      const currentGuest = guests.get(memberId)
      if (!currentGuest || currentGuest.gen !== myGen) return
      guest.socket = null
      guest.connectPromise = null
      resolve()
    })

    socket.setTimeout(10000, () => {
      socket.destroy()
      const currentGuest = guests.get(memberId)
      if (!currentGuest || currentGuest.gen !== myGen) return
      guest.socket = null
      guest.connectPromise = null
      resolve()
    })

    socket.setNoDelay(true)
  })
}

/**
 * 功能描述：重置指定 Guest 的游戏连接（销毁旧连接，创建新连接）
 *
 * 逻辑说明：用于响应重置帧，确保新游戏客户端连接使用全新的
 *           游戏服务器 TCP 通道，避免协议状态污染。
 *
 * @param memberId - Guest 成员 ID
 */
function resetGuestConnection(memberId: string): void {
  const guest = guests.get(memberId)
  if (!guest) return

  console.log(`[房主] 重置游戏连接 [${memberId}]`)
  if (guest.socket) {
    guest.socket.destroy()
    guest.socket = null
  }
  guest.connectPromise = null
  guest.pendingBuffer = []
  triggerLazyConnect(memberId)
}

/**
 * 功能描述：将缓冲的游戏数据写入 Guest 的连接
 *
 * @param memberId - Guest 成员 ID
 */
function flushPendingBuffer(memberId: string): void {
  const guest = guests.get(memberId)
  if (!guest || !guest.socket || guest.socket.destroyed) return
  if (guest.pendingBuffer.length === 0) return

  console.log(`[房主] 刷新缓冲区 [${memberId}]（${guest.pendingBuffer.length} 个数据包）`)
  for (const buf of guest.pendingBuffer) {
    try { guest.socket.write(buf) } catch { /* ignore */ }
  }
  guest.pendingBuffer = []
}

function cleanup(): void {
  if (!running) return
  running = false

  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }

  // 清理所有 Guest 连接
  for (const [, guest] of guests) {
    if (guest.socket) { guest.socket.destroy() }
  }
  guests.clear()

  if (ws) {
    ws.removeAllListeners('close')
    ws.removeAllListeners('error')
    ws.close()
    ws = null
  }
}

async function main(): Promise<void> {
  console.log(`[房主] 目标游戏服务器: ${GAME_HOST}:${GAME_PORT}`)

  ws = new WebSocket(RELAY_URL)

  ws.on('open', () => {
    console.log('[房主] 已连接到中继服务器，正在创建房间...')
    sendJson(ws!, {
      type: 'create-room',
      messageId: 'req_1',
      data: { gameId: 'test-game', gamePort: GAME_PORT, memberName: 'Host', roomCode: ROOM_CODE }
    })
  })

  /**
   * 功能描述：处理 JSON 控制消息
   *
   * 逻辑说明：处理房间生命周期事件（创建、加入、离开）。
   */
  function handleJsonMessage(msg: Record<string, any>): void {
    switch (msg.type) {
      case 'room-created':
        roomCode = msg.data.roomCode
        console.log(`[房主] 房间已创建: ${roomCode}`)
        break

      case 'member-joined':
        const memberId: string = msg.data.memberId
        const memberName: string = msg.data.memberName
        console.log(`[房主] 加入者已加入: ${memberName}(${memberId})`)

        if (!guests.has(memberId)) {
          guests.set(memberId, {
            memberId,
            memberName,
            socket: null,
            connectPromise: null,
            pendingBuffer: [],
            gen: 0
          })
          triggerLazyConnect(memberId)
        }
        break

      case 'member-left':
        const leftId: string = msg.data.memberId
        console.log(`[房主] 加入者已离开: ${leftId}`)
        const leftGuest = guests.get(leftId)
        if (leftGuest) {
          if (leftGuest.socket) { leftGuest.socket.destroy() }
          guests.delete(leftId)
        }
        break
    }
  }

  /**
   * 功能描述：处理二进制数据帧
   *
   * 逻辑说明：帧格式来自中继服务器：[4B sourceIdLen][sourceId UTF8][payload]
   *           其中 payload 来自 Guest：[4B payloadLen][游戏数据]
   *           payloadLen=0 时为重置帧，通知房主重建该 Guest 的游戏连接。
   */
  function handleBinaryMessage(raw: Buffer): void {
    if (raw.length < 8) return
    const idLen = raw.readUInt32BE(0)
    if (raw.length < 4 + idLen + 4) return
    const sourceMemberId = raw.subarray(4, 4 + idLen).toString('utf8')
    const payloadLen = raw.readUInt32BE(4 + idLen)

    // payloadLen=0 为重置帧 → 重建游戏连接
    if (payloadLen === 0) {
      resetGuestConnection(sourceMemberId)
      return
    }

    const payload = raw.subarray(4 + idLen + 4, 4 + idLen + 4 + payloadLen)

    // 查找或创建 Guest 状态
    let guestState = guests.get(sourceMemberId)
    if (!guestState) {
      guestState = {
        memberId: sourceMemberId,
        memberName: sourceMemberId,
        socket: null,
        connectPromise: null,
        pendingBuffer: [],
        gen: 0
      }
      guests.set(sourceMemberId, guestState)
      triggerLazyConnect(sourceMemberId)
    }

    const socket = guestState.socket
    if (socket && !socket.destroyed) {
      try { socket.write(payload) } catch { /* ignore */ }
      console.log(`[房主] ${sourceMemberId} → 游戏: ${payload.length} 字节`)
    } else {
      guestState.pendingBuffer.push(payload)
      console.log(`[房主] ${sourceMemberId} → (缓冲): ${payload.length} 字节`)
      triggerLazyConnect(sourceMemberId)
    }
  }

  ws.on('message', (raw: Buffer | string) => {
    if (!running) return

    // Windows 下 ws 包可能将文本帧以 Buffer 交付
    if (typeof raw !== 'string' && Buffer.isBuffer(raw)) {
      const text = raw.toString('utf8')
      try {
        const msg = JSON.parse(text)
        handleJsonMessage(msg)
        return
      } catch {
        handleBinaryMessage(raw)
        return
      }
    }

    // 文本帧
    try {
      handleJsonMessage(JSON.parse(raw as string))
    } catch { /* ignore */ }
  })

  ws.on('close', () => {
    console.log('[房主] 中继连接已关闭')
    cleanup()
  })

  ws.on('error', (err: Error) => {
    console.error(`[房主] 中继错误: ${err.message}`)
  })

  // 心跳
  heartbeatTimer = setInterval(() => {
    if (ws && running) {
      sendJson(ws, { type: 'heartbeat', data: { roomCode: roomCode || undefined } })
    }
  }, 10000)
}

// 全局未捕获异常处理
process.on('uncaughtException', (err: Error) => {
  console.error(`[房主] 未捕获异常: ${err.message}`)
})
process.on('unhandledRejection', (err: Error) => {
  console.error(`[房主] 未捕获 Promise 拒绝: ${err?.message || String(err)}`)
})

main().catch(console.error)
