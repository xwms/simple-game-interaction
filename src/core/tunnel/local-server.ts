/**
 * 功能描述：本地 TCP 隧道服务端
 *
 * 逻辑说明：在本地监听 TCP 端口（IPv4 + IPv6 双栈），
 *           接收游戏客户端的连接。每个客户端连接的数据通过
 *           Transport 转发到远端。远端的响应数据再写回所有客户端。
 *           支持多个游戏客户端同时连接（同一游戏的多玩家加入）。
 */

import { EventEmitter } from 'events'
import * as net from 'net'
import { Logger } from '../utils/logger'
import { TRANSPORT_EVENTS } from '../transports'
import type { Transport } from '../transports'
import type { TransportStatus } from '@shared/types'

const logger = new Logger('LocalServer')

/** 最大端口尝试次数 */
const MAX_PORT_RETRIES = 10

/**
 * 功能描述：本地 TCP 隧道服务端
 *
 * 逻辑说明：net.Server 监听本地端口，接收游戏客户端 TCP 连接。
 *           每个客户端的入站数据通过 Transport.send() 发到远端，
 *           远端的出站数据通过 Transport 的 data 事件接收后写入所有客户端。
 *           Transport 可以随时切换（用于自动降级场景）。
 *
 * @fires started - 服务端已启动，附带 { port: number }
 * @fires stopped - 服务端已停止
 * @fires client-connected - 新客户端连接
 * @fires client-disconnected - 客户端断开
 * @fires status - 隧道状态变更
 * @fires error - 错误
 */
export class LocalTunnelServer extends EventEmitter {
  private _server: net.Server | null = null
  private _localPort: number = 0
  private _transport: Transport | null = null
  private _clientConnections: Set<net.Socket> = new Set()
  private _status: TransportStatus = 'disconnected'
  /** 是否全部客户端已断开（用于检测客户端重连） */
  private _allClientsDisconnected: boolean = false

  /** 当前监听端口（0 表示未启动） */
  get localPort(): number {
    return this._localPort
  }

  /** 当前隧道状态 */
  get status(): TransportStatus {
    return this._status
  }

  /** 当前连接的客户端数量 */
  get clientCount(): number {
    return this._clientConnections.size
  }

  /** 当前使用的传输层 */
  get transport(): Transport | null {
    return this._transport
  }

  /**
   * 功能描述：启动本地隧道服务端
   *
   * 逻辑说明：创建 net.Server，监听 127.0.0.1 和 ::1。
   *           如果指定端口被占用，自动尝试下一个端口。
   *
   * @param port - 监听端口（0 表示自动选择）
   * @returns 实际监听端口号
   * @throws 所有端口均被占用时抛出
   */
  async start(port: number = 0): Promise<number> {
    if (this._server) {
      return this._localPort
    }

    return new Promise<number>((resolve, reject) => {
      const tryPort = (attempt: number) => {
        const targetPort = port === 0 ? 0 : port + attempt

        const server = net.createServer((socket) => {
          this._onClientConnection(socket)
        })

        server.on('error', (err: NodeJS.ErrnoException) => {
          if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && attempt < MAX_PORT_RETRIES) {
            server.close()
            tryPort(attempt + 1)
          } else {
            reject(new Error(`Failed to bind port ${targetPort}: ${err.message}`))
          }
        })

        server.on('listening', () => {
          const addr = server.address()
          if (addr && typeof addr !== 'string') {
            this._localPort = addr.port
          }
          this._server = server
          this._setStatus('connected')
          logger.info(`Local tunnel server started on :${this._localPort}`)
          this.emit('started', { port: this._localPort })
          resolve(this._localPort)
        })

        if (targetPort === 0) {
          server.listen(0, '127.0.0.1')
        } else {
          server.listen(targetPort, '127.0.0.1')
        }
      }

      tryPort(0)
    })
  }

  /**
   * 功能描述：停止本地隧道服务端
   *
   * 逻辑说明：关闭所有客户端连接，关闭服务器。
   */
  async stop(): Promise<void> {
    this._disconnectAllClients()
    if (this._server) {
      this._server.close()
      this._server = null
    }
    this._localPort = 0
    this._allClientsDisconnected = false
    this._setStatus('disconnected')
    logger.info('Local tunnel server stopped')
    this.emit('stopped')
  }

  /**
   * 功能描述：设置数据传输通道
   *
   * 逻辑说明：替换当前使用的 Transport。旧 Transport 的 data 监听会被移除。
   *           新 Transport 的 data 事件将转发到所有已连接的客户端。
   *
   * @param transport - 新的传输层
   */
  setTransport(transport: Transport): void {
    // 移除旧 transport 的监听
    if (this._transport) {
      this._transport.removeAllListeners(TRANSPORT_EVENTS.DATA)
      this._transport.removeAllListeners(TRANSPORT_EVENTS.STATUS)
      this._transport.removeAllListeners(TRANSPORT_EVENTS.ERROR)
      this._transport.removeAllListeners(TRANSPORT_EVENTS.CLOSE)
    }

    this._transport = transport

    // 注册新 transport 的事件监听
    transport.on(TRANSPORT_EVENTS.DATA, (data: unknown) => {
      this._writeToAllClients(data as Buffer)
    })

    transport.on(TRANSPORT_EVENTS.STATUS, (status: unknown) => {
      this._setStatus(status as TransportStatus)
    })

    transport.on(TRANSPORT_EVENTS.ERROR, (err: unknown) => {
      logger.error(`Transport error: ${(err as Error).message}`)
      this.emit('error', err as Error)
    })

    transport.on(TRANSPORT_EVENTS.CLOSE, () => {
      logger.info('Transport closed, waiting for switch...')
    })
  }

  // ─── 私有方法 ───────────────────────────────────────

  /**
   * 功能描述：处理新客户端 TCP 连接
   *
   * @param socket - 客户端 socket
   */
  private _onClientConnection(socket: net.Socket): void {
    socket.setNoDelay(true)

    const wasAllDisconnected = this._allClientsDisconnected
    this._allClientsDisconnected = false
    this._clientConnections.add(socket)
    if (wasAllDisconnected) {
      logger.info('Game client reconnection detected')
      this.emit('client-reconnected')
    }

    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`
    logger.info(`Client connected [${remoteAddr}]`)

    socket.on('data', (data: Buffer) => {
      if (this._transport && this._status === 'connected') {
        this._transport.send(data).catch((err: Error) => {
          logger.error(`Transport send failed: ${err.message}`)
        })
      }
      // 无 transport 时静默丢弃数据（等待降级完成）
    })

    socket.on('close', () => {
      this._clientConnections.delete(socket)
      logger.info(`Client disconnected [${remoteAddr}]`)
      if (this._clientConnections.size === 0) {
        this._allClientsDisconnected = true
        this.emit('all-clients-disconnected')
      }
      this.emit('client-disconnected', { remoteAddr })
    })

    socket.on('error', (err: Error) => {
      logger.warn(`Client error [${remoteAddr}]: ${err.message}`)
      socket.destroy()
      this._clientConnections.delete(socket)
    })

    this.emit('client-connected', { socket, remoteAddr })
  }

  /**
   * 功能描述：将数据写入所有已连接的客户端
   *
   * @param data - 要写入的数据
   */
  private _writeToAllClients(data: Buffer): void {
    const clientCount = this._clientConnections.size
    if (clientCount === 0) {
      logger.debug(`Remote data arrived but no clients connected, dropping ${data.length}B`)
      return
    }
    // 记录数据前 4 字节（hex）用于识别 Minecraft 协议包
    const hexPrefix = data.length >= 4 ? data.subarray(0, 4).toString('hex') : data.toString('hex')
    logger.debug(`Writing to ${clientCount} clients, data=${data.length}B, hex=${hexPrefix}`)
    for (const socket of this._clientConnections) {
      try {
        const written = socket.write(data)
        if (!written) {
          logger.debug(`socket.write returned false (buffer full), data=${data.length}B`)
        }
      } catch {
        socket.destroy()
        this._clientConnections.delete(socket)
      }
    }
  }

  /**
   * 功能描述：断开所有客户端连接
   */
  private _disconnectAllClients(): void {
    for (const socket of this._clientConnections) {
      socket.destroy()
    }
    this._clientConnections.clear()
  }

  /**
   * 功能描述：设置服务端状态并发射事件
   *
   * @param status - 新状态
   */
  private _setStatus(status: TransportStatus): void {
    this._status = status
    this.emit('status', status)
  }
}
