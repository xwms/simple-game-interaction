/**
 * 功能描述：加入者模拟脚本 — 监听本地端口，通过 WebSocket 中继转发游戏数据
 *
 * 逻辑说明：1) 连接到中继服务器并加入房间
 *           2) 在本地监听 TCP 端口
 *           3) 将中继收到的游戏数据转发给本地连接的游戏客户端
 *           4) 将游戏客户端的数据发回房主
 *           5) 新客户端连接时先发送重置帧，确保房主创建全新游戏连接
 *              （适配 Minecraft 单连接单协议模式：STATUS 和 LOGIN 用不同连接）
 *
 * 使用方式：npx tsx src/relay-server/guest-sim.ts <房间码> [本地端口]
 */

import WebSocket from 'ws'
import * as net from 'net'

const RELAY_URL = 'ws://159.75.150.37:9800'
const LOCAL_PORT = parseInt(process.argv[3] || '5555', 10)

let ws: WebSocket | null = null
let localServer: net.Server | null = null
let clientSocket: net.Socket | null = null
let clientGen = 0
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let running = true

function safeSend(socket: WebSocket, data: string | Buffer): void {
  try {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(data)
    }
  } catch { /* ignore */ }
}

function sendJson(socket: WebSocket, msg: Record<string, unknown>): void {
  safeSend(socket, JSON.stringify(msg))
}

/**
 * 功能描述：发送二进制数据帧到房主
 *
 * 逻辑说明：帧格式 [4B payloadLen][payload]
 *           发送的数据先经过中继服务器包装 sourceId 前缀后再发给房主。
 *           房主侧解析 payloadLen 提取实际游戏数据。
 *
 * @param data - 游戏数据
 */
function sendBinary(socket: WebSocket, data: Buffer): void {
  const header = Buffer.alloc(4)
  header.writeUInt32BE(data.length, 0)
  safeSend(socket, Buffer.concat([header, data]))
}

/**
 * 功能描述：发送重置帧 — 通知房主重建该加入者的游戏连接
 *
 * 逻辑说明：发送 payloadLen=0 的二进制帧，房主检测到 0 长度后
 *           销毁旧游戏连接并创建新连接。后续数据帧会进入缓冲等待新连接就绪。
 *           使用二进制通道而非 JSON 信号，避免中继路由问题。
 */
function sendResetFrame(): void {
  if (!ws) return
  // payloadLen=0 表示重置连接
  const header = Buffer.alloc(4)
  header.writeUInt32BE(0, 0)
  safeSend(ws, header)
}

function cleanup(): void {
  if (!running) return
  running = false
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  if (clientSocket) { clientSocket.destroy(); clientSocket = null }
  if (localServer) { localServer.close(); localServer = null }
  if (ws) {
    ws.removeAllListeners('close')
    ws.removeAllListeners('error')
    ws.close()
    ws = null
  }
}

function startLocalServer(): void {
  localServer = net.createServer((socket) => {
    if (!running) return

    // 替换旧连接
    if (clientSocket) {
      clientSocket.destroy()
      clientSocket = null
    }

    const gen = ++clientGen
    clientSocket = socket
    console.log(`[加入者] 游戏客户端已连接: ${socket.remoteAddress}:${socket.remotePort}`)

    // 发送重置帧 — 通知房主重建游戏连接
    // 重置帧先于所有数据帧到达房主（WebSocket 保序）
    sendResetFrame()

    socket.on('data', (data: Buffer) => {
      if (!running || !ws) return
      sendBinary(ws, data)
    })

    socket.on('close', () => {
      console.log('[加入者] 游戏客户端已断开')
      if (gen === clientGen) {
        clientSocket = null
      }
    })

    socket.on('error', () => {
      if (gen === clientGen) {
        clientSocket = null
      }
    })

    socket.setNoDelay(true)
  })

  localServer.listen(LOCAL_PORT, '127.0.0.1', () => {
    console.log(`[加入者] 本地隧道已启动: 127.0.0.1:${LOCAL_PORT}`)
  })

  localServer.on('error', (err: Error) => {
    console.error(`[加入者] 本地服务端错误: ${err.message}`)
  })
}

async function main(): Promise<void> {
  const roomCode = process.argv[2]
  if (!roomCode) {
    console.error('[加入者] 用法: npx tsx src/relay-server/guest-sim.ts <房间码> [本地端口]')
    process.exit(1)
  }

  startLocalServer()

  ws = new WebSocket(RELAY_URL)

  ws.on('open', () => {
    console.log('[加入者] 已连接到中继服务器')
    console.log(`[加入者] 正在加入房间 ${roomCode}...`)
    sendJson(ws!, {
      type: 'join-room',
      messageId: 'req_1',
      data: { roomCode, memberName: 'Guest' }
    })

    heartbeatTimer = setInterval(() => {
      if (ws && running) {
        sendJson(ws, { type: 'heartbeat', data: { roomCode } })
      }
    }, 10000)
  })

  function handleJsonMessage(msg: Record<string, any>): void {
    switch (msg.type) {
      case 'room-joined':
        console.log(`[加入者] 已加入房间 ${msg.data.roomCode}`)
        console.log(`[加入者] 本地端口: ${LOCAL_PORT}`)
        console.log(`[加入者] 请在游戏中连接 127.0.0.1:${LOCAL_PORT}\n`)
        break
      case 'error':
        console.error(`[加入者] 错误: ${msg.error?.message || JSON.stringify(msg.error)}`)
        break
    }
  }

  ws.on('message', (raw: Buffer | string) => {
    if (!running) return

    if (typeof raw !== 'string' && Buffer.isBuffer(raw)) {
      const text = raw.toString('utf8')
      try {
        const msg = JSON.parse(text)
        handleJsonMessage(msg)
        return
      } catch {
        if (raw.length < 4) return
        const payloadLen = raw.readUInt32BE(0)
        const payload = raw.subarray(4, 4 + payloadLen)
        if (clientSocket && !clientSocket.destroyed) {
          try { clientSocket.write(payload) } catch { /* ignore */ }
        }
        return
      }
    }

    try {
      handleJsonMessage(JSON.parse(raw as string))
    } catch { /* ignore */ }
  })

  ws.on('close', () => {
    console.log('[加入者] 中继连接已关闭')
    cleanup()
  })

  ws.on('error', (err: Error) => {
    console.error(`[加入者] 中继错误: ${err.message}`)
  })
}

process.on('uncaughtException', (err: Error) => {
  console.error(`[加入者] 未捕获异常: ${err.message}`)
})
process.on('unhandledRejection', (err: Error) => {
  console.error(`[加入者] 未捕获 Promise 拒绝: ${err?.message || String(err)}`)
})

main().catch(console.error)
