/**
 * 功能描述：本地隧道客户端 — 房主侧连接游戏服务器
 *
 * 逻辑说明：房主的游戏服务器已运行在本地某端口（如 Minecraft :25565），
 *           本模块创建一个 TCP 客户端连接该游戏服务器，将游戏数据通过
 *           Transport 转发到远端（加入者）。
 *           相当于：GameServer ←TCP→ LocalClient ←Transport→ Remote
 *
 *           重连策略：惰性重连。游戏服务器断开后不主动重连，
 *           而是等 transport 有数据到达时再建立连接，避免无效重连。
 *
 * @module local-client
 */

import { EventEmitter } from 'events'
import * as net from 'net'
import { Logger } from '../utils/logger'
import { TRANSPORT_EVENTS } from '../connection'
import type { Transport } from '../connection'
import type { TransportStatus } from '@shared/types'

const logger = new Logger('LocalClient')

/**
 * 功能描述：本地隧道客户端
 *
 * 逻辑说明：作为 TCP 客户端连接到本机游戏服务器端口，
 *           连接建立后将 socket 与 Transport 桥接：
 *           socket.data → transport.send()
 *           transport.data → socket.write()
 *
 *           断线后采用惰性重连：仅当 transport 有数据要发送时
 *           才发起连接，数据在连接建立期间暂存于缓冲区。
 *
 * @fires connected - 已连接到游戏服务器
 * @fires disconnected - 与游戏服务器断开
 * @fires error - 错误
 */
export class LocalTunnelClient extends EventEmitter {
  private _socket: net.Socket | null = null
  private _transport: Transport | null = null
  private _status: TransportStatus = 'disconnected'
  private _port: number = 0
  private _host: string = '127.0.0.1'
  private _connectPromise: Promise<void> | null = null
  private _pendingBuffer: Buffer[] = []
  private _disconnecting: boolean = false
  /** 代际计数器 — 每次重连递增，用于连接回调中判断是否为当前代际 */
  private _gen: number = 0

  /** 当前连接状态 */
  get status(): TransportStatus {
    return this._status
  }

  /** 是否已连接到游戏服务器 */
  get connected(): boolean {
    return this._socket !== null && !this._socket.destroyed
  }

  /**
   * 功能描述：立即关闭当前游戏服务器连接
   *
   * 逻辑说明：由 relay close-game-conn 信令触发。
   *           与 forceReconnect 不同，不等待数据到达，立即销毁 socket。
   *           不设置 _disconnecting，下次数据到达时惰性重连会正常工作。
   */
  closeConnection(): void {
    if (this._disconnecting) return
    this._connectPromise = null
    this._pendingBuffer = []
    if (this._socket) {
      this._socket.destroy()
      this._socket = null
    }
    this._gen++
    this._setStatus('disconnected')
    logger.debug('Game server connection closed (close-game-conn signal)')
    this.emit('disconnected')
  }

  /**
   * 功能描述：连接到本机游戏服务器
   *
   * 逻辑说明：创建 net.Socket 连接到 127.0.0.1:port。
   *           连接建立后设置 NoDelay 并桥接数据。
   *           断开后不自动重连，等待 _lazyConnect 按需触发。
   *
   * @param port - 游戏服务器端口
   * @param host - 游戏服务器地址（默认 127.0.0.1）
   * @returns 连接成功时 resolve
   * @throws 连接失败或超时时抛出 Error
   */
  async connect(port: number, host: string = '127.0.0.1'): Promise<void> {
    if (this._socket) {
      return
    }

    this._port = port
    this._host = host

    return this._doConnect()
  }

  /**
   * 功能描述：断开与游戏服务器的连接
   *
   * 逻辑说明：标记 _disconnecting 防止 _lazyConnect 被触发，
   *           清理 socket 和缓冲区。
   */
  async disconnect(): Promise<void> {
    this._disconnecting = true
    this._connectPromise = null
    this._pendingBuffer = []
    if (this._socket) {
      this._socket.destroy()
      this._socket = null
    }
    this._setStatus('disconnected')
    logger.debug('Local client disconnected')
    this.emit('disconnected')
  }

  /**
   * 功能描述：设置数据传输通道
   *
   * 逻辑说明：注册 Transport 的 data 事件，将从远端收到的数据写入游戏服务器 socket。
   *           当 socket 已断开时，缓冲数据并触发惰性重连。
   *
   * @param transport - 传输层
   */
  setTransport(transport: Transport): void {
    if (this._transport) {
      this._transport.removeAllListeners(TRANSPORT_EVENTS.DATA)
      this._transport.removeAllListeners(TRANSPORT_EVENTS.STATUS)
      this._transport.removeAllListeners(TRANSPORT_EVENTS.ERROR)
      this._transport.removeAllListeners(TRANSPORT_EVENTS.CLOSE)
      this._transport.removeAllListeners(TRANSPORT_EVENTS.RESET)
    }

    this._transport = transport
    this._setStatus(transport.status)

    transport.on(TRANSPORT_EVENTS.DATA, (data: unknown) => {
      const buf = data as Buffer
      if (this._socket && !this._socket.destroyed) {
        logger.debug(`LocalClient remote data → writing to game socket ${buf.length}B (status=${this._status})`)
        this._socket.write(buf)
      } else if (!this._disconnecting) {
        logger.debug(`LocalClient remote data → buffering ${buf.length}B (socket=${!!this._socket}), triggering lazy reconnect`)
        this._pendingBuffer.push(buf)
        this._triggerLazyConnect()
      }
    })

    transport.on(TRANSPORT_EVENTS.STATUS, (status: unknown) => {
      this._setStatus(status as TransportStatus)
    })

    transport.on(TRANSPORT_EVENTS.ERROR, (err: unknown) => {
      logger.error(`Transport error: ${(err as Error).message}`)
      this.emit('error', err as Error)
    })

    transport.on(TRANSPORT_EVENTS.CLOSE, () => {
      logger.info('Transport closed')
    })

    // 重置帧：通知重新建立游戏连接（适配 MC 多连接单协议模式）
    transport.on(TRANSPORT_EVENTS.RESET, () => {
      logger.debug('Received reset signal, reconnecting to game server')
      this._handleReset()
    })
  }

  /**
   * 功能描述：执行实际的 TCP 连接
   *
   * 逻辑说明：创建 socket 到游戏服务器，设置事件处理器。
   *           使用代际计数器防止陈旧连接回调覆盖当前连接。
   *           连接建立后刷新缓冲区。
   *
   * @returns 连接成功时 resolve
   * @throws 连接失败或超时时抛出 Error
   */
  private _doConnect(): Promise<void> {
    const myGen = ++this._gen
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ port: this._port, host: this._host }, () => {
        // 连接建立时检查代际 — 若已过时说明有更新的连接，销毁这个过期 socket
        if (this._gen !== myGen) {
          socket.destroy()
          resolve()
          return
        }
        socket.setNoDelay(true)
        this._socket = socket
        this._flushBuffer()
        this._setStatus('connected')
        logger.debug(`Connected to game server ${this._host}:${this._port}`)
        this.emit('connected', { port: this._port, host: this._host })
        resolve()
      })

      socket.on('data', (data: Buffer) => {
        const transportType = this._transport ? (this._transport as { type?: string }).type || 'unknown' : 'null'
        logger.debug(`Game server → local [${transportType}]: ${data.length}B`)
        if (this._transport) {
          this._transport.send(data).catch((err: Error) => {
            logger.error(`Transport send failed: ${err.message} (${data.length}B)`)
          })
        } else {
          logger.warn(`Game server data arrived but no transport, dropping ${data.length}B`)
        }
      })

      socket.on('close', () => {
        this._socket = null
        this._setStatus('disconnected')
        logger.debug('Game server connection closed, awaiting lazy reconnect')
        this.emit('disconnected')
        // 不主动重连，transport data 到达时 _lazyConnect 会触发
      })

      socket.on('error', (err: Error) => {
        this._socket = null
        this._setStatus('disconnected')
        reject(err)
      })

      socket.setTimeout(10000, () => {
        socket.destroy()
        reject(new Error(`Connection to game server timed out ${this._host}:${this._port}`))
      })
    })
  }

  /**
   * 功能描述：触发惰性重连
   *
   * 逻辑说明：如果当前没有正在进行的连接，发起新连接。
   *           连接失败时重置 _connectPromise 以便下次 data 到达时重试。
   */
  private _triggerLazyConnect(): void {
    if (this._connectPromise) {
      return // 连接已在进行中，数据会继续入队
    }

    this._connectPromise = this._doConnect().catch((err: Error) => {
      logger.warn(`Lazy reconnect failed: ${err.message}, will retry on next data arrival`)
    }).finally(() => {
      this._connectPromise = null
    })
  }

  /**
   * 功能描述：重置游戏服务器连接（销毁旧连接，创建新连接）
   *
   * 逻辑说明：由重置帧触发。销毁当前 socket，清空缓冲区，
   *           递增代际计数器使任何陈旧连接事件失效，立即触发惰性重连。
   */
  private _handleReset(): void {
    if (this._disconnecting) return

    logger.debug(`LocalClient handling reset signal, socket=${!!this._socket}`)
    // 销毁旧 socket
    if (this._socket) {
      this._socket.destroy()
      this._socket = null
    }
    this._connectPromise = null
    this._pendingBuffer = []
    // 递增 gen 使遗留连接回调被 gen 检查拦截
    this._gen++
    this._triggerLazyConnect()
  }

  /**
   * 功能描述：将缓冲区数据写入 socket
   *
   * 逻辑说明：连接建立后将暂存的数据按序写入。
   */
  private _flushBuffer(): void {
    if (this._pendingBuffer.length === 0) return
    if (!this._socket || this._socket.destroyed) return

    logger.debug(`Flushing reconnect buffer (${this._pendingBuffer.length} packets)`)
    for (const buf of this._pendingBuffer) {
      this._socket.write(buf)
    }
    this._pendingBuffer = []
  }

  /**
   * 功能描述：设置状态并发射事件
   *
   * @param status - 新状态
   */
  private _setStatus(status: TransportStatus): void {
    this._status = status
    this.emit('status', status)
  }
}
