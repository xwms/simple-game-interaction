/**
 * 功能描述：IPv6 TCP 直连传输（支持 active/passive 双模式）
 *
 * 逻辑说明：active 模式作为 TCP 客户端连接到对端 IPv6 地址；
 *           passive 模式作为 TCP 服务端监听 IPv6 端口等待对端连接。
 *           使用 Node.js net 模块，实现 Transport 接口。
 *           房主侧使用 passive 模式，加入者侧使用 active 模式。
 *
 *           数据帧格式：所有 TCP 数据均采用长度前缀帧封装。
 *           [frameType(1), payload...]
 *           - 0x00 (DATA):  + UInt32BE(length) + data → 游戏数据
 *           - 0x01 (PING):  + seqNo(1) → 延迟探测
 *           - 0x02 (PONG):  + seqNo(1) → 延迟回复
 *           接收端根据帧类型和长度精确切分，不存在字节冲突。
 *
 * @module ipv6-direct
 */

import { EventEmitter } from 'events'
import * as net from 'net'
import { Logger } from '../../utils/logger'
import { TRANSPORT_EVENTS, TRANSPORT_TIMEOUT_MS } from '../../transports'
import type { Transport, PeerConnectionInfo } from '../../transports'
import type { TransportStatus, TrafficSnapshot } from '@shared/types'

const logger = new Logger('Ipv6Direct')

/** IPv6 角色 */
type Ipv6Role = 'active' | 'passive'

/** 帧类型常量 */
const FT_DATA = 0x00
const FT_PING = 0x01
const FT_PONG = 0x02

/**
 * 功能描述：IPv6 TCP 直连传输
 *
 * 逻辑说明：作为 Transport 接口的 IPv6 实现。
 *           active 模式直接创建 TCP 连接到对端的 IPv6 地址。
 *           passive 模式创建 TCP 服务端监听 IPv6 端口，接受对端连接。
 *           连接成功后禁用 Nagle 算法以降低游戏流量延迟。
 *
 *           所有 TCP 数据使用长度前缀帧协议：
 *           - 游戏数据帧:  [0x00, 4-byte-length, data...]
 *           - Ping 帧:     [0x01, seqNo]
 *           - Pong 帧:     [0x02, seqNo]
 *           接收端通过 _recvBuffer 累积解析，精确切分每个帧。
 *
 * @fires data - 收到对端数据
 * @fires status - 连接状态变更
 * @fires error - 连接错误
 * @fires close - 连接关闭
 * @fires traffic - 流量统计
 * @fires latency - 延迟测量结果
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
  /** 指定绑定端口（默认 0 = 随机） */
  private _bindPort: number = 0
  /**
   * 待消费数据缓冲区
   * 防止 data 事件在监听器注册前到达时数据丢失。
   * drainPendingData() 可在注册监听器后回放。
   */
  private _pendingData: Buffer[] = []
  /** TCP 接收缓冲区 — 累积数据并逐帧解析 */
  private _recvBuffer: Buffer = Buffer.alloc(0)
  /** 延迟测量定时器 */
  private _latencyTimer: ReturnType<typeof setInterval> | null = null
  /** Ping 序列号计数器 */
  private _pingSeqNo: number = 0
  /** 在途 Ping 的时间戳表（seqNo → timestamp），用于匹配 Pong 响应 */
  private _lastPingTimes: Map<number, number> = new Map()

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
   * 功能描述：设置本地绑定端口（可选，默认随机）
   *
   * @param port - TCP 端口号（0=随机）
   */
  setBindPort(port: number): void {
    this._bindPort = port
  }

  /**
   * 功能描述：回放 pending 缓冲区数据到回调
   *
   * 逻辑说明：对于 connect() 后延迟注册 data 监听器的场景，
   *           调用此方法将期间缓冲的数据回放到回调中。
   *           此方法应在 on('data', handler) 后立即调用。
   *
   * @param handler - 数据回调，收到 buffer 数据
   */
  drainPendingData(handler: (data: Buffer) => void): void {
    while (this._pendingData.length > 0) {
      handler(this._pendingData.shift()!)
    }
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
        throw new Error('IPv6 address or port invalid')
      }
      await this._startActive(peerInfo)
    }
  }

  /**
   * 功能描述：断开 IPv6 连接
   *
   * 逻辑说明：清理 socket、server、流量定时器和接收缓冲区。
   */
  async disconnect(): Promise<void> {
    this._stopTrafficMonitor()
    this._stopLatencyMonitor()
    this._localPort = null
    this._pendingData = []
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
   * 功能描述：通过 IPv6 连接发送数据
   *
   * 逻辑说明：将游戏数据封装为 DATA 帧：[0x00, 4-byte-length, data...]
   *
   * @param data - 二进制数据
   * @throws 未连接时抛出 Error
   */
  async send(data: Buffer): Promise<void> {
    if (!this._socket) {
      throw new Error('IPv6 transport not connected')
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
        logger.info(`IPv6 connection successful${v6Info}`)
        resolve()
      })

      socket.on('error', (err: Error) => {
        if (settled) return
        settled = true
        socket.destroy()
        this._setStatus('error')
        reject(new Error(`IPv6 connection failed: ${err.message}`))
      })

      socket.on('timeout', () => {
        if (settled) return
        settled = true
        socket.destroy()
        this._setStatus('error')
        reject(new Error(`IPv6 connection timeout (${this._connectTimeoutMs}ms)`))
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
        logger.info(`IPv6 passive received connection [${remoteAddr}]`)
        this._onConnected(socket)
      })

      server.on('listening', () => {
        const addr = server.address()
        if (addr && typeof addr !== 'string') {
          this._localPort = addr.port
          logger.info(`IPv6 passive server started :${addr.port}`)
        }
        resolve()
      })

      server.on('error', (err: Error) => {
        reject(new Error(`IPv6 server error: ${err.message}`))
      })

      server.listen(this._bindPort, '::')
      this._server = server
    })
  }

  // ─── 公共处理 ─────────────────────────────────────

  /**
   * 功能描述：连接建立后的公共处理
   *
   * 逻辑说明：关闭 passive 服务器，禁用 Nagle 算法，
   *           注册帧解析数据处理器，启动流量和延迟监控。
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
      logger.error(`IPv6 socket error: ${err.message}`)
    })
  }

  /**
   * 功能描述：从接收缓冲区逐帧解析
   *
   * 逻辑说明：TCP 流模式下，多个帧可能在同一 data 事件中到达。
   *           循环解析 _recvBuffer 中的帧，每帧根据类型和长度精确切分。
   *           DATA 帧游戏数据从帧中剥离后发出的 data 事件。
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
        this._pendingData.push(data)
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

  // ─── 延迟测量 ─────────────────────────────────────

  /**
   * 功能描述：启动延迟测量（每 5 秒发送 Ping 帧）
   *
   * 逻辑说明：仅主动端（active）发送 Ping，被动端只回显 Pong。
   *           帧格式：[0x01, seqNo]，被动端回显 [0x02, seqNo]。
   *           时间戳存储在本地 _lastPingTimes 映射表中，收到 Pong 后计算 RTT。
   *           帧协议确保不存在字节冲突。
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
