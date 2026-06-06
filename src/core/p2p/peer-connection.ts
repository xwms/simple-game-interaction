/**
 * 功能描述：P2P TCP 直连传输
 *
 * 逻辑说明：通过 IPv4 TCP 直接连接对端公网地址。
 *           使用 RelayClient 交换双方公网 IP:Port（通过 STUN 获取），
 *           然后尝试直接 TCP 连接。同 LAN 情况下优先使用私有 IP 地址。
 *           连接失败时由 TunnelManager 降级到 Relay。
 *           实现 Transport 接口。
 */

import { EventEmitter } from 'events'
import * as net from 'net'
import { Logger } from '../utils/logger'
import { TRANSPORT_EVENTS } from '../connection'
import { DEFAULT_P2P_CONFIG } from './types'
import type { Transport, PeerConnectionInfo } from '../connection'
import type { TransportStatus, TrafficSnapshot } from '@shared/types'
import type { P2PConfig, P2PRole } from './types'

const logger = new Logger('P2pTransport')

/**
 * 功能描述：P2P TCP 直连传输
 *
 * 逻辑说明：Attempts direct TCP connection to peer's public IPv4 address.
 *           Active role (usually guest) initiates the TCP connection.
 *           Passive role (usually host) creates a temporary TCP server
 *           listening on an ephemeral port for the incoming connection.
 *           On LAN, prefers private IP for lower latency.
 *
 * @fires data - 收到对端数据
 * @fires status - 连接状态变更
 * @fires error - 连接错误
 * @fires close - 连接关闭
 * @fires traffic - 流量统计
 */
export class P2pTransport extends EventEmitter implements Transport {
  readonly type = 'p2p' as const
  private _socket: net.Socket | null = null
  private _server: net.Server | null = null
  private _status: TransportStatus = 'disconnected'
  private _trafficBytesSent: number = 0
  private _trafficBytesReceived: number = 0
  private _trafficTimer: ReturnType<typeof setInterval> | null = null
  private _config: P2PConfig
  private _role: P2PRole | null = null
  /** passive 模式下 TCP 服务器的本地监听端口 */
  private _localPort: number | null = null

  constructor(config?: Partial<P2PConfig>) {
    super()
    this._config = { ...DEFAULT_P2P_CONFIG, ...config }
  }

  get status(): TransportStatus {
    return this._status
  }

  /**
   * 功能描述：获取 passive 模式的本地监听端口
   *
   * @returns 监听端口号，非 passive 模式或未就绪时返回 null
   */
  get localPort(): number | null {
    return this._localPort
  }

  /**
   * 功能描述：建立 P2P TCP 连接
   *
   * 逻辑说明：Active 方主动连接对端公网地址（优先同 LAN 私有地址）。
   *           Passive 方创建临时 TCP 服务器等待连接。
   *           超时时间由 config.connectTimeout 控制。
   *
   * @param peerInfo - 对端连接信息
   * @throws 连接超时 / 地址无效 / 连接拒绝
   */
  async connect(peerInfo: PeerConnectionInfo): Promise<void> {
    this._setStatus('connecting')

    if (this._role === 'passive') {
      await this._startPassive()
    } else {
      await this._startActive(peerInfo)
    }
  }

  /**
   * 功能描述：设置连接角色（在 connect 之前调用）
   *
   * @param role - active（发起方）或 passive（接收方）
   */
  setRole(role: P2PRole): void {
    this._role = role
  }

  /**
   * 功能描述：断开 P2P 连接
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
   * 功能描述：发送数据到对端
   *
   * @param data - 二进制数据
   * @throws 未连接时抛出 Error
   */
  async send(data: Buffer): Promise<void> {
    if (!this._socket) {
      throw new Error('P2P 传输未连接')
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

  /**
   * 功能描述：Active 方发起 TCP 连接
   *
   * 逻辑说明：优先尝试私有 IP 地址（同 LAN 场景），
   *           然后尝试公网 IP 地址。
   *
   * @param peerInfo - 对端连接信息
   */
  private async _startActive(peerInfo: PeerConnectionInfo): Promise<void> {
    // 优先尝试私有地址（同 LAN）
    const targets: Array<{ host: string; port: number; label: string }> = []

    if (peerInfo.localAddresses) {
      for (const addr of peerInfo.localAddresses) {
        targets.push({ host: addr.ip, port: addr.port, label: `私有地址 ${addr.ip}` })
      }
    }
    if (peerInfo.publicAddress) {
      targets.push({
        host: peerInfo.publicAddress.ip,
        port: peerInfo.publicAddress.port,
        label: `公网地址 ${peerInfo.publicAddress.ip}`
      })
    }

    if (targets.length === 0) {
      throw new Error('P2P 缺少对端地址信息')
    }

    for (const target of targets) {
      try {
        await this._tryConnect(target.host, target.port, this._config.connectTimeout)
        const okInfo = process.env.NODE_ENV !== 'production' ? ` (${target.label})` : ''
        logger.info(`P2P 连接成功${okInfo}`)
        return
      } catch (err) {
        const failInfo = process.env.NODE_ENV !== 'production' ? ` (${target.label})` : ' (地址已隐藏)'
        logger.warn(`P2P 连接失败${failInfo}: ${(err as Error).message}`)
      }
    }

    throw new Error('P2P 连接失败，所有地址均不可达')
  }

  /**
   * 功能描述：Passive 方创建临时 TCP 服务器
   *
   * 逻辑说明：监听 0.0.0.0 上的临时端口，等待对端连接。
   */
  private _startPassive(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`
        logger.info(`P2P passive 收到连接 [${remoteAddr}]`)
        this._onConnected(socket)
      })

      server.on('listening', () => {
        const addr = server.address()
        if (addr && typeof addr !== 'string') {
          this._localPort = addr.port
          logger.info(`P2P 临时服务器已启动 :${addr.port}`)
        }
        resolve()
      })

      server.on('error', (err: Error) => {
        reject(new Error(`P2P 服务器错误: ${err.message}`))
      })

      server.listen(0, '0.0.0.0')
      this._server = server
    })
  }

  /**
   * 功能描述：尝试 TCP 连接到指定地址
   *
   * @param host - 目标主机
   * @param port - 目标端口
   * @param timeoutMs - 超时时间
   */
  private _tryConnect(host: string, port: number, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new net.Socket()
      let settled = false

      socket.setTimeout(timeoutMs)
      socket.setNoDelay(true)

      socket.on('connect', () => {
        if (settled) return
        settled = true
        this._onConnected(socket)
        resolve()
      })

      socket.on('error', (err: Error) => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(err)
      })

      socket.on('timeout', () => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(new Error(`连接超时`))
      })

      socket.connect({ host, port })
    })
  }

  /**
   * 功能描述：连接建立后的公共处理
   *
   * @param socket - 已连接的 TCP socket
   */
  private _onConnected(socket: net.Socket): void {
    // 关闭 passive 服务器
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
      logger.error('P2P socket 错误', err.message)
    })
  }

  /**
   * 功能描述：设置连接状态并发射事件
   */
  private _setStatus(status: TransportStatus): void {
    this._status = status
    this.emit(TRANSPORT_EVENTS.STATUS, status)
  }

  /**
   * 功能描述：启动流量统计定时器
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
