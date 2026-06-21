/**
 * 功能描述：P2P TCP 直连传输
 *
 * 逻辑说明：通过 IPv4 TCP 直接连接对端公网地址。
 *           使用 RelayClient 交换双方公网 IP:Port（通过 STUN 获取），
 *           然后尝试直接 TCP 连接。同 LAN 情况下优先使用私有 IP 地址。
 *           连接失败时由 TunnelManager 降级到 Relay。
 *           实现 Transport 接口。
 *
 *           数据帧格式：所有 TCP 数据均采用长度前缀帧封装。
 *           [frameType(1), payload...]
 *           - 0x00 (DATA):  + UInt32BE(length) + data → 游戏数据
 *           - 0x01 (PING):  + seqNo(1) → 延迟探测
 *           - 0x02 (PONG):  + seqNo(1) → 延迟回复
 *           接收端根据帧类型和长度精确切分，不存在字节冲突。
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

/** 帧类型常量 */
const FT_DATA = 0x00
const FT_PING = 0x01
const FT_PONG = 0x02

/**
 * 功能描述：P2P TCP 直连传输
 *
 * 逻辑说明：Attempts direct TCP connection to peer's public IPv4 address.
 *           Active role (usually client) initiates the TCP connection.
 *           Passive role (usually server) creates a temporary TCP server
 *           listening on an ephemeral port for the incoming connection.
 *           On LAN, prefers private IP for lower latency.
 *
 * @fires data - 收到对端数据
 * @fires status - 连接状态变更
 * @fires error - 连接错误
 * @fires close - 连接关闭
 * @fires traffic - 流量统计
 * @fires latency - 延迟测量结果
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
  /** TCP 接收缓冲区 — 累积数据并逐帧解析 */
  private _recvBuffer: Buffer = Buffer.alloc(0)
  /** 延迟测量定时器 */
  private _latencyTimer: ReturnType<typeof setInterval> | null = null
  /** Ping 序列号计数器 */
  private _pingSeqNo: number = 0
  /** 在途 Ping 的时间戳表（seqNo → timestamp），用于匹配 Pong 响应 */
  private _lastPingTimes: Map<number, number> = new Map()

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
    this._stopLatencyMonitor()
    this._localPort = null
    this._recvBuffer = Buffer.alloc(0)
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
      throw new Error('P2P transport not connected')
    }

    const frame = Buffer.allocUnsafe(5 + data.length)
    frame[0] = FT_DATA
    frame.writeUInt32BE(data.length, 1)
    data.copy(frame, 5)

    return new Promise<void>((resolve, reject) => {
      this._socket!.write(frame, (err?: Error | null) => {
        if (err) reject(err)
      })
      this._trafficBytesSent += data.length
      resolve()
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
        targets.push({ host: addr.ip, port: addr.port, label: `local address ${addr.ip}` })
      }
    }
    if (peerInfo.publicAddress) {
      targets.push({
        host: peerInfo.publicAddress.ip,
        port: peerInfo.publicAddress.port,
        label: `public address ${peerInfo.publicAddress.ip}`
      })
    }

    if (targets.length === 0) {
      throw new Error('P2P missing peer address info')
    }

    for (const target of targets) {
      try {
        await this._tryConnect(target.host, target.port, this._config.connectTimeout)
        const okInfo = process.env.NODE_ENV !== 'production' ? ` (${target.label})` : ''
        logger.info(`P2P connection successful${okInfo}`)
        return
      } catch (err) {
        const failInfo = process.env.NODE_ENV !== 'production' ? ` (${target.label})` : ' (address hidden)'
        logger.warn(`P2P connection failed${failInfo}: ${(err as Error).message}`)
      }
    }

    throw new Error('P2P connection failed, all addresses unreachable')
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
        logger.info(`P2P passive received connection [${remoteAddr}]`)
        this._onConnected(socket)
      })

      server.on('listening', () => {
        const addr = server.address()
        if (addr && typeof addr !== 'string') {
          this._localPort = addr.port
          logger.info(`P2P temporary server started :${addr.port}`)
        }
        resolve()
      })

      server.on('error', (err: Error) => {
        reject(new Error(`P2P server error: ${err.message}`))
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
        reject(new Error(`Connection timeout`))
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
    this._startLatencyMonitor()

    socket.on('data', (chunk: Buffer) => {
      this._recvBuffer = Buffer.concat([this._recvBuffer, chunk])
      this._parseFrames()
    })

    socket.on('close', () => {
      this._stopTrafficMonitor()
      this._stopLatencyMonitor()
      this._socket = null
      this._recvBuffer = Buffer.alloc(0)
      this._setStatus('disconnected')
      this.emit(TRANSPORT_EVENTS.CLOSE)
    })

    socket.on('error', (err: Error) => {
      logger.error(`P2P socket error: ${err.message}`)
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

  /**
   * 功能描述：从接收缓冲区逐帧解析
   *
   * 逻辑说明：TCP 流模式下，多个帧可能在同一 data 事件中到达。
   *           循环解析 _recvBuffer 中的帧，每帧根据类型和长度精确切分。
   *           DATA 帧游戏数据从帧中剥离后发出 data 事件。
   *           PING/PONG 帧直接处理延迟测量，不进入游戏数据流。
   */
  private _parseFrames(): void {
    while (this._recvBuffer.length > 0) {
      const frameType = this._recvBuffer[0]

      if (frameType === FT_DATA) {
        // DATA 帧: [0x00, UInt32BE(length), data...]
        if (this._recvBuffer.length < 5) break
        const dataLen = this._recvBuffer.readUInt32BE(1)
        if (this._recvBuffer.length < 5 + dataLen) break
        const data = this._recvBuffer.subarray(5, 5 + dataLen)
        this._recvBuffer = this._recvBuffer.subarray(5 + dataLen)
        this._trafficBytesReceived += dataLen
        this.emit(TRANSPORT_EVENTS.DATA, data)

      } else if (frameType === FT_PING) {
        // PING 帧: [0x01, seqNo] → 回复 PONG
        if (this._recvBuffer.length < 2) break
        const seqNo = this._recvBuffer[1]
        this._recvBuffer = this._recvBuffer.subarray(2)
        if (this._socket) {
          this._socket.write(Buffer.from([FT_PONG, seqNo]))
        }

      } else if (frameType === FT_PONG) {
        // PONG 帧: [0x02, seqNo] → 计算 RTT
        if (this._recvBuffer.length < 2) break
        const seqNo = this._recvBuffer[1]
        this._recvBuffer = this._recvBuffer.subarray(2)
        const pingTime = this._lastPingTimes.get(seqNo)
        if (pingTime !== undefined) {
          const rtt = performance.now() - pingTime
          if (rtt >= 0 && rtt < 60000) {
            this._lastPingTimes.delete(seqNo)
            this.emit(TRANSPORT_EVENTS.LATENCY, Math.round(rtt))
          }
        }

      } else {
        // 未知帧类型，跳过 1 字节防止死循环
        this._recvBuffer = this._recvBuffer.subarray(1)
      }
    }
  }

  /**
   * 功能描述：启动延迟测量（每 5 秒发送 Ping 帧）
   *
   * 逻辑说明：仅主动端（active）发送 Ping，被动端只回显 Pong。
   *           帧格式：[0x01, seqNo]，被动端回显 [0x02, seqNo]。
   *           时间戳存储在本地 _lastPingTimes 映射表中，收到 Pong 后计算 RTT。
   */
  private _startLatencyMonitor(): void {
    this._stopLatencyMonitor()
    if (this._role !== 'active') return
    this._latencyTimer = setInterval(() => {
      if (!this._socket) return
      const seqNo = this._pingSeqNo++ & 0xFF
      this._lastPingTimes.delete(seqNo)
      this._lastPingTimes.set(seqNo, performance.now())
      this._socket.write(Buffer.from([FT_PING, seqNo]))
    }, 5000)
  }

  /**
   * 功能描述：停止延迟测量
   */
  private _stopLatencyMonitor(): void {
    if (this._latencyTimer) {
      clearInterval(this._latencyTimer)
      this._latencyTimer = null
    }
    this._lastPingTimes.clear()
  }
}
