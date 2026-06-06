/**
 * 功能描述：IPv6 TCP 直连传输（支持 active/passive 双模式）
 *
 * 逻辑说明：active 模式作为 TCP 客户端连接到对端 IPv6 地址；
 *           passive 模式作为 TCP 服务端监听 IPv6 端口等待对端连接。
 *           使用 Node.js net 模块，实现 Transport 接口。
 *           房主侧使用 passive 模式，加入者侧使用 active 模式。
 *
 * @module ipv6-direct
 */

import { EventEmitter } from 'events'
import * as net from 'net'
import { Logger } from '../utils/logger'
import { TRANSPORT_EVENTS, TRANSPORT_TIMEOUT_MS } from '../connection'
import type { Transport, PeerConnectionInfo } from '../connection'
import type { TransportStatus, TrafficSnapshot } from '@shared/types'

const logger = new Logger('Ipv6Direct')

/** IPv6 角色 */
type Ipv6Role = 'active' | 'passive'

/**
 * 功能描述：IPv6 TCP 直连传输
 *
 * 逻辑说明：作为 Transport 接口的 IPv6 实现。
 *           active 模式直接创建 TCP 连接到对端的 IPv6 地址。
 *           passive 模式创建 TCP 服务端监听 IPv6 端口，接受对端连接。
 *           连接成功后禁用 Nagle 算法以降低游戏流量延迟。
 *           提供流量统计和状态变更事件。
 *
 * @fires data - 收到对端数据
 * @fires status - 连接状态变更
 * @fires error - 连接错误
 * @fires close - 连接关闭
 * @fires traffic - 流量统计
 */
export class Ipv6DirectTransport extends EventEmitter implements Transport {
  readonly type = 'ipv6' as const
  private _socket: net.Socket | null = null
  private _server: net.Server | null = null
  private _status: TransportStatus = 'disconnected'
  private _trafficBytesSent: number = 0
  private _trafficBytesReceived: number = 0
  private _trafficTimer: ReturnType<typeof setInterval> | null = null
  private _connectTimeoutMs: number
  private _role: Ipv6Role = 'active'
  private _localPort: number | null = null

  constructor(connectTimeoutMs: number = TRANSPORT_TIMEOUT_MS) {
    super()
    this._connectTimeoutMs = connectTimeoutMs
  }

  get status(): TransportStatus {
    return this._status
  }

  /** passive 模式的本地监听端口 */
  get localPort(): number | null {
    return this._localPort
  }

  /**
   * 功能描述：设置连接角色（在 connect 之前调用）
   *
   * @param role - active（发起方）或 passive（接收方）
   */
  setRole(role: Ipv6Role): void {
    this._role = role
  }

  /**
   * 功能描述：建立 IPv6 连接
   *
   * 逻辑说明：active 模式连接到对端 IPv6 地址，
   *           passive 模式创建 TCP 服务端等待连接。
   *
   * @param peerInfo - 对端连接信息（active 模式需含 ipv6Address 和 ipv6Port）
   * @throws 地址无效 / 连接超时 / 连接拒绝
   */
  async connect(peerInfo: PeerConnectionInfo): Promise<void> {
    this._setStatus('connecting')

    if (this._role === 'passive') {
      await this._startPassive()
    } else {
      if (!peerInfo.ipv6Address || !peerInfo.ipv6Port || peerInfo.ipv6Port <= 0) {
        throw new Error('IPv6 地址或端口无效')
      }
      await this._startActive(peerInfo)
    }
  }

  /**
   * 功能描述：断开 IPv6 连接
   *
   * 逻辑说明：清理 socket、server 和流量定时器。
   */
  async disconnect(): Promise<void> {
    this._stopTrafficMonitor()
    this._localPort = null
    if (this._socket) {
      this._socket.destroy()
      this._socket = null
    }
    if (this._server) {
      this._server.close()
      this._server = null
    }
    this._setStatus('disconnected')
    this.emit(TRANSPORT_EVENTS.CLOSE)
  }

  /**
   * 功能描述：通过 IPv6 连接发送数据
   *
   * @param data - 二进制数据
   * @throws 未连接时抛出 Error
   */
  async send(data: Buffer): Promise<void> {
    if (!this._socket) {
      throw new Error('IPv6 传输未连接')
    }

    return new Promise<void>((resolve, reject) => {
      const canContinue = this._socket!.write(data, (err?: Error | null) => {
        if (err) reject(err)
      })
      this._trafficBytesSent += data.length
      if (canContinue) {
        resolve()
      } else {
        this._socket!.once('drain', resolve)
      }
    })
  }

  // ─── Active ────────────────────────────────────────

  /**
   * 功能描述：Active 模式 — 连接到对端 IPv6 地址
   *
   * @param peerInfo - 对端连接信息
   */
  private _startActive(peerInfo: PeerConnectionInfo): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new net.Socket()
      let settled = false

      socket.setTimeout(this._connectTimeoutMs)
      socket.setNoDelay(true)

      socket.on('connect', () => {
        if (settled) return
        settled = true
        this._onConnected(socket)
        const v6Info = process.env.NODE_ENV !== 'production' ? ` [${peerInfo.ipv6Address}]:${peerInfo.ipv6Port}` : ''
        logger.info(`IPv6 连接成功${v6Info}`)
        resolve()
      })

      socket.on('error', (err: Error) => {
        if (settled) return
        settled = true
        socket.destroy()
        this._setStatus('error')
        reject(new Error(`IPv6 连接失败: ${err.message}`))
      })

      socket.on('timeout', () => {
        if (settled) return
        settled = true
        socket.destroy()
        this._setStatus('error')
        reject(new Error(`IPv6 连接超时 (${this._connectTimeoutMs}ms)`))
      })

      socket.connect({
        host: peerInfo.ipv6Address!,
        port: peerInfo.ipv6Port!
      })
    })
  }

  // ─── Passive ───────────────────────────────────────

  /**
   * 功能描述：Passive 模式 — 创建 IPv6 TCP 服务端
   *
   * 逻辑说明：监听 IPv6 通配地址（"::"，双栈模式同时接受 IPv4 连接）
   *           的临时端口，等待对端连接。
   */
  private _startPassive(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`
        logger.info(`IPv6 passive 收到连接 [${remoteAddr}]`)
        this._onConnected(socket)
      })

      server.on('listening', () => {
        const addr = server.address()
        if (addr && typeof addr !== 'string') {
          this._localPort = addr.port
          logger.info(`IPv6 passive 服务器已启动 :${addr.port}`)
        }
        resolve()
      })

      server.on('error', (err: Error) => {
        reject(new Error(`IPv6 服务器错误: ${err.message}`))
      })

      server.listen(0, '::')
      this._server = server
    })
  }

  // ─── 公共处理 ─────────────────────────────────────

  /**
   * 功能描述：连接建立后的公共处理
   *
   * 逻辑说明：关闭 passive 服务器，禁用 Nagle 算法，
   *           注册数据/关闭/错误处理器，启动流量监控。
   *
   * @param socket - 已连接的 TCP socket
   */
  private _onConnected(socket: net.Socket): void {
    if (this._server) {
      this._server.close()
      this._server = null
    }

    this._socket = socket
    this._setStatus('connected')
    this._startTrafficMonitor()

    socket.on('data', (data: Buffer) => {
      this._trafficBytesReceived += data.length
      this.emit(TRANSPORT_EVENTS.DATA, data)
    })

    socket.on('close', () => {
      this._stopTrafficMonitor()
      this._socket = null
      this._setStatus('disconnected')
      this.emit(TRANSPORT_EVENTS.CLOSE)
    })

    socket.on('error', (err: Error) => {
      logger.error('IPv6 socket 错误', err.message)
    })
  }

  // ─── 工具方法 ─────────────────────────────────────

  /**
   * 功能描述：设置连接状态并发射事件
   */
  private _setStatus(status: TransportStatus): void {
    this._status = status
    this.emit(TRANSPORT_EVENTS.STATUS, status)
  }

  /**
   * 功能描述：启动流量统计定时器（每秒发射一次）
   */
  private _startTrafficMonitor(): void {
    this._stopTrafficMonitor()
    this._trafficTimer = setInterval(() => {
      const snapshot: TrafficSnapshot = {
        bytesSent: this._trafficBytesSent,
        bytesReceived: this._trafficBytesReceived,
        timestamp: Date.now()
      }
      this.emit(TRANSPORT_EVENTS.TRAFFIC, snapshot)
    }, 1000)
  }

  /**
   * 功能描述：停止流量统计定时器
   */
  private _stopTrafficMonitor(): void {
    if (this._trafficTimer) {
      clearInterval(this._trafficTimer)
      this._trafficTimer = null
    }
  }
}
