/**
 * 功能描述：KCP UDP 打洞传输 — 基于 UDP 的可靠传输层（多 socket 优化版）
 *
 * 逻辑说明：通过多个 UDP 套接字进行 NAT 打洞，在 UDP 之上使用 KCP 协议提供
 *           可靠、有序的数据传输。支持 active/passive 双模式：
 *           - active（加入者）：绑定多个 UDP 端口，向对端地址发送打洞包，
 *             创建 KCP 实例管理连接。启动探针定时重传，通过 Relay 信号
 *             通知房主本端端口，触发房主侧探针建立双向 NAT 映射。
 *           - passive（房主）：绑定多个 UDP 端口等待对端首包到达，
 *             收到首包后创建 KCP 实例。收到加入者 kcp-port 信号后，
 *             通过 addExternalTarget() 向加入者发送探针建立 NAT 映射。
 *           探针循环使用 10 个 socket 同时发送，提高 NAT 打洞成功率。
 *           初始密集期 100ms 间隔，3 秒后退避到 1500ms 间隔。
 *           bound 事件绑定后立即发射，不等待 STUN 完成。
 *           首个收到回包的 socket 成为主 socket，其余自动关闭。
 *           KCP 配置为低延迟模式（nodelay + 快速重传 + 无拥塞控制），
 *           适用于游戏流量场景。
 *           实现 Transport 接口。
 *
 * 重要：data 事件必须在 connect() 之前或立即之后注册，
 *       否则 KCP ACK 会先于监听器发送，导致数据永久丢失。
 *       _pendingData 缓冲区可缓解此问题，但推荐提前注册监听器。
 *
 * @fires data - 收到对端应用数据
 * @fires status - 连接状态变更
 * @fires error - 错误
 * @fires close - 连接关闭
 * @fires traffic - 流量统计
 * @fires bound - UDP 绑定完成，携带本地端口
 * @fires public-addr - STUN 公网地址发现完成（异步补充）
 */

import { EventEmitter } from 'events'
import * as crypto from 'crypto'
import * as dgram from 'dgram'
import { Logger } from '../../utils/logger'
import { TRANSPORT_EVENTS } from '../../transports'
import { Kcp } from '../../utils/kcp'
import type { Transport, PeerConnectionInfo } from '../../transports'
import type { TransportStatus, TrafficSnapshot } from '@shared/types'

const logger = new Logger('KcpTransport')

/** KCP 更新间隔（毫秒） */
const KCP_UPDATE_INTERVAL = 10

/** KCP 角色 */
type KcpRole = 'active' | 'passive'

/** 绑定的 UDP socket 数量（多个端口增加打洞成功率） */
const BIND_PORT_COUNT = 10

/** 探针密集发送间隔（毫秒） */
const PROBE_INTERVAL_FAST = 100

/** 探针稳态发送间隔（毫秒） */
const PROBE_INTERVAL_SLOW = 1500

/** 密集期持续时间（毫秒） */
const PROBE_FAST_DURATION = 3000

/** 探针包大小（模拟真实 KCP 包，避免 NAT 丢弃小包） */
const PROBE_PACKET_SIZE = 32

/** 探针包标识前缀（两个字节，用于接收侧过滤，避免误喂 KCP） */
const PROBE_MAGIC = Buffer.from([0xCB, 0xCE])

/** KCP input -1 警告上限（连接建立后残余探针包可能误入 KCP） */
const MAX_KCP_INPUT_WARNINGS = 5

/** 心跳发送间隔（毫秒） */
const KEEPALIVE_INTERVAL = 5000
/** 无数据超时（毫秒），超过此时间未收到任何 KCP 包视为断开 */
const IDLE_TIMEOUT = 15000
/** 空闲检测轮询间隔（毫秒） */
const IDLE_CHECK_INTERVAL = 5000

/**
 * 功能描述：KCP UDP 打洞传输（多 socket 版）
 *
 * 逻辑说明：绑定多个 UDP 端口提高 NAT 打洞成功率。
 *           active 方主动从所有 socket 发送打洞包；
 *           passive 方在所有 socket 上监听首包。
 *           首个收到回包的 socket 成为主 socket，其余自动关闭。
 *           KCP update 循环每 10ms 执行一次，驱动数据发送和确认。
 */
export class KcpTransport extends EventEmitter implements Transport {
  readonly type = 'p2p' as const
  /** 所有绑定的 UDP socket */
  private _udpSockets: dgram.Socket[] = []
  /** 主 socket 索引（首个收到对端响应的 socket） */
  private _primarySocketIndex: number = 0
  private _kcp: Kcp | null = null
  private _status: TransportStatus = 'disconnected'
  private _role: KcpRole | null = null
  private _peerAddr: { address: string; port: number } | null = null
  private _localPort: number | null = null
  /** STUN 发现的公网 IP（NAT 映射地址） */
  private _publicIp: string | null = null
  /** STUN 发现的公网端口（NAT 映射端口） */
  private _publicPort: number | null = null
  /** 指定绑定端口（默认 0 = 随机，仅主 socket 使用此端口） */
  private _bindPort: number = 0
  private _updateTimer: ReturnType<typeof setInterval> | null = null
  private _trafficBytesSent: number = 0
  private _trafficBytesReceived: number = 0
  private _trafficTimer: ReturnType<typeof setInterval> | null = null
  /** connect() Promise resolve，用于 _onMessage 握手确认后回连 */
  private _connectResolve: (() => void) | null = null
  /** 握手超时定时器 */
  private _connectHandshakeTimer: ReturnType<typeof setTimeout> | null = null
  /** 延迟测量定时器 */
  private _latencyTimer: ReturnType<typeof setInterval> | null = null
  /** NAT 打洞探针定时重传 */
  private _probeTimer: ReturnType<typeof setInterval> | null = null
  /** 探针目标地址列表 */
  private _probeTargets: Array<{ address: string; port: number }> = []
  /** 探针密集期结束定时器 */
  private _probeFastTimer: ReturnType<typeof setTimeout> | null = null
  /** 固定的探针包数据（带 magic 前缀，用于接收侧过滤） */
  private _probePacket: Buffer = Buffer.concat([
    PROBE_MAGIC,
    crypto.randomBytes(PROBE_PACKET_SIZE - PROBE_MAGIC.length)
  ])
  /** 标记是否已建立连接（防止首包重复触发建连） */
  private _connectionEstablished: boolean = false
  /** KCP input -1 计数，超过上限不再打印警告 */
  private _kcpInputErrorCount: number = 0
  /**
   * 待消费数据缓冲区
   * 防止 data 事件在监听器注册前到达时数据丢失。
   * drainPendingData() 可在注册监听器后回放。
   */
  private _pendingData: Buffer[] = []
  /** 最后收到 KCP 数据的时间戳（用于空闲超时检测） */
  private _lastReceiveTime: number = 0
  /** 心跳发送定时器 */
  private _keepaliveTimer: ReturnType<typeof setInterval> | null = null
  /** 空闲超时检测定时器 */
  private _idleCheckTimer: ReturnType<typeof setInterval> | null = null
  get status(): TransportStatus {
    return this._status
  }

  /** passive 模式的本地 UDP 端口 */
  get localPort(): number | null {
    return this._localPort
  }

  /** STUN 发现的 NAT 映射公网 IP */
  get publicIp(): string | null {
    return this._publicIp
  }

  /** STUN 发现的 NAT 映射公网端口 */
  get publicPort(): number | null {
    return this._publicPort
  }

  /**
   * 功能描述：设置本地绑定端口（可选，默认随机）
   *           仅主 socket 使用此端口，其余 socket 绑定随机端口。
   *
   * @param port - UDP 端口号（0=随机）
   */
  setBindPort(port: number): void {
    this._bindPort = port
  }

  /**
   * 功能描述：设置连接角色（在 connect 之前调用）
   *
   * @param role - active（发起方）或 passive（接收方）
   */
  setRole(role: KcpRole): void {
    this._role = role
  }

  /**
   * 功能描述：回放 pending 缓冲区数据到回调
   *
   * 逻辑说明：对于 connect() 后延迟注册 data 监听器的场景，
   *           调用此方法将期间缓冲的数据回放到回调中。
   *           此方法应在 on('data', handler) 后立即调用。
   *
   * @param handler - 数据回调，收到 buffer 数据
   * @returns 回放的数据条数
   */
  drainPendingData(handler: (data: Buffer) => void): number {
    let count = 0
    while (this._pendingData.length > 0) {
      handler(this._pendingData.shift()!)
      count++
    }
    return count
  }

  /**
   * 功能描述：建立 KCP UDP 连接
   *
   * 逻辑说明：
   *   - 绑定 BIND_PORT_COUNT 个 UDP 端口，增大打洞成功率
   *   - active 模式：绑定后立即发送打洞包 → 对端首包到达后创建 KCP
   *   - passive 模式：绑定后等待首包 → 收到后创建 KCP → 发送 ACK
   *   - bound 事件在绑定完成后立即发射，不等待 STUN 完成
   *   - STUN 查询异步执行，完成后更新 publicIp/publicPort
   *   passive 模式 resolve 时仅表示 UDP 已就绪，首包到达后状态才变为 connected。
   *
   * @param peerInfo - 对端连接信息（active 模式需含 kcpAddress 或 publicAddress）
   * @throws 缺少地址信息 / 套接字错误
   */
  async connect(peerInfo: PeerConnectionInfo): Promise<void> {
    this._setStatus('connecting')

    return new Promise<void>((resolve, reject) => {
      let boundCount = 0
      let hasError = false
      const totalSockets = BIND_PORT_COUNT

      for (let i = 0; i < totalSockets; i++) {
        const socket = dgram.createSocket({ type: 'udp4' })
        this._udpSockets.push(socket)

        socket.on('error', (err: Error) => {
          if (hasError) return
          hasError = true
          if (this._status === 'connecting') {
            reject(new Error(`UDP socket[${i}] error: ${err.message}`))
          } else {
            logger.error(`KCP socket[${i}] error: ${err.message}`)
          }
        })

        // 每个 socket 都注册消息处理器，socketIndex 用于标记哪个 socket 收到首包
        const socketIndex = i
        socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
          this._onMessage(msg, rinfo, socketIndex)
        })

        socket.on('listening', () => {
          // bind 完成后设置 UDP 缓冲区（bind 前调用会 ENOTSOCK）
          try {
            socket.setRecvBufferSize(4 * 1024 * 1024)
            socket.setSendBufferSize(4 * 1024 * 1024)
          } catch (err) {
            logger.warn(`socket[${i}] set UDP buffer size failed: ${(err as Error).message}`)
          }
          boundCount++
          // 等待所有 socket 绑定完成后统一处理
          if (boundCount < totalSockets) return

          // 使用主 socket（socket 0）的地址
          const primaryAddr = this._udpSockets[0]!.address()
          this._localPort = primaryAddr.port

          // 立即发射 bound 事件，不等待 STUN
          this.emit('bound', primaryAddr.port, null, primaryAddr.port)

          // 异步 STUN 查询，完成后更新公网地址
          this._queryPublicAddress().then((stunResult) => {
            if (stunResult) {
              this._publicIp = stunResult.ip
              this._publicPort = stunResult.port
              // 发射公网地址更新事件
              this.emit('public-addr', stunResult.port, stunResult.ip, primaryAddr.port)
            } else {
              this._publicPort = primaryAddr.port
            }
          }).catch(() => {
            this._publicPort = primaryAddr.port
          })

          if (this._role === 'active') {
            const targetAddr = peerInfo.kcpAddress || peerInfo.publicAddress
            if (!targetAddr) {
              reject(new Error('KCP missing peer address'))
              return
            }

            // 构建候选地址列表
            const candidates: Array<{ address: string; port: number }> = []
            if (targetAddr.ip !== '127.0.0.1') {
              candidates.push({ address: '127.0.0.1', port: targetAddr.port })
            }
            if (peerInfo.localAddresses) {
              for (const addr of peerInfo.localAddresses) {
                if (addr.ip !== targetAddr.ip && addr.ip !== '127.0.0.1') {
                  candidates.push({ address: addr.ip, port: addr.port })
                }
              }
            }
            candidates.push({ address: targetAddr.ip, port: targetAddr.port })

            logger.debug(`KCP active hole punching → candidates: [${candidates.map(c => `${c.address}:${c.port}`).join(', ')}]`)
            this._probeTargets = candidates

            // 启动密集探针（所有 socket 同时发送）
            this._startProbeLoop(true)

            this._connectResolve = resolve
            this._connectHandshakeTimer = setTimeout(() => {
              this._connectResolve = null
              const warnInfo = process.env.NODE_ENV !== 'production'
                ? ` (target=${targetAddr.ip}:${targetAddr.port})` : ''
              reject(new Error(`UDP hole punching handshake timeout, no response from peer${warnInfo}`))
            }, 8000)
          } else {
            logger.info(`KCP passive mode ready (${totalSockets} sockets)`)
            resolve()
          }
        })

        // 主 socket (0) 使用指定端口，其余随机
        if (i === 0) {
          socket.bind(this._bindPort, '0.0.0.0')
        } else {
          socket.bind(0, '0.0.0.0')
        }
      }
    })
  }

  /**
   * 功能描述：断开 KCP 连接
   *
   * 逻辑说明：停止所有定时器，关闭所有 UDP 套接字，重置状态。
   */
  async disconnect(): Promise<void> {
    this._clearHandshake()
    this._stopLatencyMonitor()
    this._stopUpdateLoop()
    this._stopTrafficMonitor()
    this._stopProbeLoop()
    this._kcp = null
    this._peerAddr = null
    this._localPort = null
    this._publicIp = null
    this._publicPort = null
    this._pendingData = []
    this._connectionEstablished = false
    this._lastReceiveTime = 0
    for (const socket of this._udpSockets) {
      try { socket.close() } catch { /* 忽略 */ }
    }
    this._udpSockets = []
    this._primarySocketIndex = 0
    this._setStatus('disconnected')
    this.emit(TRANSPORT_EVENTS.CLOSE)
  }

  /**
   * 功能描述：通过 KCP 发送数据到对端
   *
   * 逻辑说明：调用 Kcp.send() 将数据加入 KCP 发送队列，
   *           加入后立即调用 flush() 刷出，避免等待 10ms 定时器。
   *           为防止单次 send 超过 KCP 内部分片上限（256 fragments），
   *           将输入数据按 MSS × 200 大小分块发送，确保不超过限制。
   *           每个分块前添加帧类型字节（0x00=DATA），
   *           与 _drainKcp 的帧解析配合实现带内控制信号。
   *
   * @param data - 二进制数据
   * @throws 未连接时抛出 Error
   */
  async send(data: Buffer): Promise<void> {
    if (!this._kcp || this._status !== 'connected') {
      throw new Error('KCP transport not connected')
    }

    const mss = this._kcp.getMss()
    const maxChunkSize = mss * 200 - 1
    let offset = 0
    let chunkCount = 0

    while (offset < data.length) {
      const end = Math.min(offset + maxChunkSize, data.length)
      const chunk = data.subarray(offset, end)
      const framed = Buffer.alloc(1 + chunk.length)
      framed[0] = 0x00
      framed.set(chunk, 1)
      const ret = this._kcp.send(framed)
      if (ret < 0) {
        throw new Error(`KCP send failed (ret=${ret})`)
      }
      this._trafficBytesSent += framed.length
      offset = end
      chunkCount++
    }

    if (chunkCount > 1) {
      logger.debug(`KCP send split ${data.length}B → ${chunkCount} chunks`)
    }

    this._kcp.update(Date.now())
    this._kcp.flush()
  }

  /**
   * 功能描述：通过 KCP 发送控制帧
   *
   * 逻辑说明：发送带帧类型字节的控制消息，与数据帧共享同一 KCP 流，
   *           保证控制信号与游戏数据的到达顺序（先到先处理）。
   *
   * @param type - 控制帧类型（'reset' = 0x01）
   */
  sendControl(type: string): void {
    if (!this._kcp || this._status !== 'connected') {
      logger.warn(`KCP send control frame failed: not connected`)
      return
    }

    let frameType: number
    switch (type) {
      case 'reset':
        frameType = 0x01
        break
      case 'keepalive':
        frameType = 0x02
        break
      default:
        logger.warn(`Unknown control frame type: ${type}`)
        return
    }

    const frame = Buffer.from([frameType])
    const ret = this._kcp.send(frame)
    if (ret < 0) {
      logger.warn(`KCP control frame send failed (ret=${ret})`)
      return
    }
    this._trafficBytesSent += 1
    this._kcp.update(Date.now())
    this._kcp.flush()
  }

  // ─── 私有方法 ───────────────────────────────────────

  /**
   * 功能描述：初始化 KCP 实例
   *
   * 逻辑说明：创建 Kcp 实例，注册 output 回调（通过主 socket 发送数据到对端）。
   *           使用低延迟配置：启用 nodelay、快速重传、无拥塞控制。
   */
  private _initKcp(): void {
    const kcp = new Kcp(0, 0, (buf: Buffer) => {
      const socket = this._udpSockets[this._primarySocketIndex]
      if (socket && this._peerAddr) {
        // 必须复制 buf，因为 KCP 内部的 flush() 会复用 this.buf，而 socket.send()
        // 是异步操作，发送完成前 this.buf 可能已被新数据覆盖。
        const copy = Buffer.from(buf)
        socket.send(copy, 0, copy.length, this._peerAddr.port, this._peerAddr.address, (err) => {
          if (err) logger.warn(`KCP output UDP send error: ${err.message}`)
        })
      }
    })
    kcp.setNodelay(true, 2, true)
    kcp.setInterval(KCP_UPDATE_INTERVAL)
    kcp.setWndSize(2048, 1024)
    this._kcp = kcp
  }

  /**
   * 功能描述：关闭除主 socket 外的所有其余 socket
   *
   * 逻辑说明：建立连接后只需一个 socket 传输 KCP 数据。
   *           关闭其他 socket 释放端口，防止后续垃圾数据干扰。
   */
  private _closeExtraSockets(): void {
    for (let i = 0; i < this._udpSockets.length; i++) {
      if (i !== this._primarySocketIndex) {
        try { this._udpSockets[i]!.close() } catch { /* 忽略 */ }
      }
    }
    const primary = this._udpSockets[this._primarySocketIndex]
    this._udpSockets = [primary]
    this._primarySocketIndex = 0
  }

  /**
   * 功能描述：通过 STUN 协议获取本机公网 IP 和端口
   *
   * 逻辑说明：复用主 socket（socket 0），向多个 STUN 服务器并发发送 Binding Request，
   *           取最快返回的 XOR-MAPPED-ADDRESS。超时 3 秒后返回 null（不影响打洞）。
   *           确保 STUN 映射地址与实际通信的 NAT 映射一致。
   *
   * @returns 公网 IP 和端口，失败返回 null
   */
  private async _queryPublicAddress(): Promise<{ ip: string; port: number } | null> {
    const stunServers = [
      'stun.miwifi.com:3478',
      'stun.chat.bilibili.com:3478',
      'stun.cloudflare.com:3478',
      'stun.l.google.com:19302'
    ]

    const socket = this._udpSockets[0]
    if (!socket) return null

    return new Promise((resolve) => {
      let pending = stunServers.length
      let done = false

      const onMessage = (msg: Buffer): void => {
        if (done) return
        try {
          if (msg.length < 20) return
          if (msg.readUInt16BE(0) !== 0x0101) return
          if (msg.readUInt32BE(4) !== 0x2112a442) return

          let offset = 20
          while (offset + 4 <= msg.length) {
            const attrType = msg.readUInt16BE(offset)
            const attrLen = msg.readUInt16BE(offset + 2)
            if (attrType === 0x0020 && attrLen >= 8) {
              const xPort = msg.readUInt16BE(offset + 6)
              const port = xPort ^ 0x2112
              const xAddr = Buffer.alloc(4)
              for (let i = 0; i < 4; i++) {
                xAddr[i] = msg[offset + 8 + i] ^ ((0x2112a442 >> (24 - i * 8)) & 0xff)
              }
              const ip = `${xAddr[0]}.${xAddr[1]}.${xAddr[2]}.${xAddr[3]}`
              done = true
              socket.removeListener('message', onMessage)
              resolve({ ip, port })
              return
            }
            offset += 4 + attrLen
            if (offset % 4 !== 0) offset += 4 - (offset % 4)
          }
        } catch { /* 忽略 */ }
      }

      socket.on('message', onMessage)

      for (const server of stunServers) {
        const [host, portStr] = server.split(':')
        const serverPort = parseInt(portStr, 10)
        if (!host || isNaN(serverPort)) { pending--; continue }
        const transactionId = crypto.randomBytes(12)

        const buf = Buffer.alloc(20)
        buf.writeUInt16BE(0x0001, 0)
        buf.writeUInt16BE(0, 2)
        buf.writeUInt32BE(0x2112a442, 4)
        transactionId.copy(buf, 8)

        socket.send(buf, 0, buf.length, serverPort, host, (err) => {
          if (err) {
            pending--
            if (pending <= 0 && !done) {
              done = true
              socket.removeListener('message', onMessage)
              resolve(null)
            }
          }
        })
      }

      setTimeout(() => {
        if (!done) {
          done = true
          socket.removeListener('message', onMessage)
          resolve(null)
        }
      }, 3000)
    })
  }

  /**
   * 功能描述：处理收到的 UDP 消息
   *
   * 逻辑说明：
   *   - 过滤 STUN 响应（可能延迟到达）
   *   - active 模式首包：确认双向可达 → 记录对端地址 → 创建 KCP
   *   - passive 模式首包：记录对端地址 → 创建 KCP → 发送原始 ACK
   *   - 后续数据包：送入 Kcp.input() 处理
   *   - 记录收到首包的 socket 索引，后续 KCP 输出使用该 socket
   *
   * @param msg - 收到的 UDP 数据
   * @param rinfo - 发送方地址信息
   * @param socketIndex - 收到消息的 socket 索引
   */
  private _onMessage(msg: Buffer, rinfo: dgram.RemoteInfo, socketIndex: number): void {
    // 过滤 STUN 响应
    if (msg.length >= 20 && msg.readUInt16BE(0) === 0x0101 && msg.readUInt32BE(4) === 0x2112a442) {
      logger.debug(`KCP STUN response received from ${rinfo.address}:${rinfo.port}`)
      return
    }

    // 过滤探针包：仅连接建立后过滤，否则会误杀对端的合法探针
    const isProbe = msg.length >= PROBE_MAGIC.length && msg[0] === PROBE_MAGIC[0] && msg[1] === PROBE_MAGIC[1]
    if (isProbe && this._connectionEstablished) {
      logger.debug(`KCP probe filtered (connected), from=${rinfo.address}:${rinfo.port}`)
      return
    }

    // 经过 STUN/探针过滤，确认为对端 KCP 数据，更新时间戳
    this._lastReceiveTime = Date.now()

    // 首包处理（连接建立前收到的第一个非 STUN 包）
    if (!this._connectionEstablished && this._status === 'connecting' && !this._kcp) {
      const packetType = isProbe ? 'probe' : 'KCP data'
      logger.info(`KCP ${this._role} first packet from ${rinfo.address}:${rinfo.port} (type=${packetType}, socket[${socketIndex}])`)
      this._connectionEstablished = true
      this._primarySocketIndex = socketIndex

      if (this._role === 'active') {
        this._peerAddr = { address: rinfo.address, port: rinfo.port }
        this._initKcp()
        this._startUpdateLoop()
        this._setStatus('connected')
        this._startLatencyMonitor()
        this._stopProbeLoop()
        this._closeExtraSockets()
        if (this._connectResolve) {
          this._connectResolve()
          this._connectResolve = null
        }
        this._clearHandshake()
        logger.info(`KCP connection established (handshake confirmed, ${rinfo.address}:${rinfo.port}, socket[${socketIndex}])`)
        // Send ACK so the peer's active connect() resolves immediately
        try {
          const socket = this._udpSockets[this._primarySocketIndex]
          if (socket) {
            socket.send(Buffer.alloc(1), 0, 1, rinfo.port, rinfo.address)
          }
        } catch {
          logger.warn('KCP active send ACK failed')
        }
        return
      }

      if (this._role === 'passive') {
        this._peerAddr = { address: rinfo.address, port: rinfo.port }
        this._initKcp()
        this._startUpdateLoop()
        this._setStatus('connected')
        this._startLatencyMonitor()
        this._stopProbeLoop()
        this._closeExtraSockets()
        logger.info(`KCP passive connection established ← ${rinfo.address}:${rinfo.port} (socket[${socketIndex}])`)
        try {
          const socket = this._udpSockets[this._primarySocketIndex]
          if (socket) {
            socket.send(Buffer.alloc(1), 0, 1, rinfo.port, rinfo.address)
          }
        } catch {
          logger.warn(`KCP passive send ACK failed`)
        }
        return
      }
    }

    if (!this._kcp) {
      logger.warn(`KCP received data but no KCP instance, len=${msg.length}, from=${rinfo.address}:${rinfo.port}`)
      return
    }
    const ret = this._kcp.input(msg)
    this._trafficBytesReceived += msg.length
    if (ret < 0) {
      if (this._kcpInputErrorCount < MAX_KCP_INPUT_WARNINGS) {
        this._kcpInputErrorCount++
        const conv = msg.length >= 28 ? msg.readUInt32LE(0) : -1
        const token = msg.length >= 28 ? msg.readUInt32LE(4) : -1
        logger.warn(`KCP input returned ${ret}: conv=${conv}, token=${token}, len=${msg.length}`)
      }
    }
    this._drainKcp()
  }

  /**
   * 功能描述：清理握手超时定时器和 resolve
   */
  private _clearHandshake(): void {
    if (this._connectHandshakeTimer) {
      clearTimeout(this._connectHandshakeTimer)
      this._connectHandshakeTimer = null
    }
    this._connectResolve = null
  }

  /**
   * 功能描述：从 KCP 接收缓冲区读取应用数据
   *
   * 逻辑说明：循环调用 kcp.recv() 直到无数据（返回 <= 0）。
   *           使用 peekSize() 预先获取消息大小，动态分配精确大小的缓冲区。
   *           解析帧类型字节：0x00=DATA, 0x01=RESET。
   */
  private _drainKcp(): void {
    if (!this._kcp) return

    let dataCount = 0
    let controlCount = 0
    while (true) {
      const peekSize = this._kcp.peekSize()
      if (peekSize <= 0) break
      const buf = Buffer.alloc(peekSize)
      const len = this._kcp.recv(buf)
      if (len <= 0) break

      if (len < 1) continue

      const frameType = buf[0]
      if (frameType === 0x00) {
        const payload = Buffer.alloc(len - 1)
        buf.copy(payload, 0, 1, len)
        this._pendingData.push(payload)
        this.emit(TRANSPORT_EVENTS.DATA, payload)
        dataCount++
      } else if (frameType === 0x01) {
        this.emit(TRANSPORT_EVENTS.RESET)
        controlCount++
      } else if (frameType === 0x02) {
        // KEEPALIVE 帧：仅更新时间戳，不传递到上层
        this._lastReceiveTime = Date.now()
      } else {
        logger.warn(`KCP received unknown frame type: ${frameType}`)
      }
    }

    if (dataCount > 0 || controlCount > 0) {
      logger.debug(`_drainKcp read ${dataCount} data messages, ${controlCount} control frames`)
    }
  }

  /**
   * 功能描述：启动 KCP update 循环
   */
  private _startUpdateLoop(): void {
    if (this._updateTimer) return
    this._startTrafficMonitor()
    this._startKeepalive()
    this._startIdleCheck()
    this._updateTimer = setInterval(() => {
      if (!this._kcp) return
      this._drainKcp()
      this._kcp.update(Date.now())
      this._drainKcp()
      const waitSnd = this._kcp.getWaitSnd()
      if (waitSnd > 2048) {
        logger.warn(`KCP send queue backlog: ${waitSnd} packets`)
      }
    }, KCP_UPDATE_INTERVAL)
  }

  /**
   * 功能描述：停止 KCP update 循环
   */
  private _stopUpdateLoop(): void {
    if (this._updateTimer) {
      clearInterval(this._updateTimer)
      this._updateTimer = null
    }
    this._stopKeepalive()
    this._stopIdleCheck()
  }

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

  // ═══════════════════════════════════════════════════════════
  //  心跳 + 空闲超时（KCP 层保活）
  // ═══════════════════════════════════════════════════════════

  /**
   * 功能描述：启动 KCP 心跳发送
   *
   * 逻辑说明：每 5 秒发送一次 KEEPALIVE 帧 (0x02)，使对端知道本端仍在线。
   *           心跳帧仅更新接收侧时间戳，不会传递给应用层。
   *           连接建立后启动，断开时停止。
   */
  private _startKeepalive(): void {
    this._stopKeepalive()
    this._keepaliveTimer = setInterval(() => {
      if (this._status !== 'connected') return
      this.sendControl('keepalive')
    }, KEEPALIVE_INTERVAL)
  }

  /**
   * 功能描述：停止心跳发送
   */
  private _stopKeepalive(): void {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer)
      this._keepaliveTimer = null
    }
  }

  /**
   * 功能描述：启动空闲超时检测
   *
   * 逻辑说明：每 5s 检查是否超过 IDLE_TIMEOUT（15s）未收到任何 KCP 数据。
   *           超时说明对端已不可达（UDP 无连接状态），
   *           将状态设为 error 触发上层降级或重连。
   *           收到首包时初始化时间戳，后续每次收到 KCP 包时更新。
   */
  private _startIdleCheck(): void {
    this._stopIdleCheck()
    this._lastReceiveTime = Date.now()
    this._idleCheckTimer = setInterval(() => {
      if (this._status !== 'connected') return
      const elapsed = Date.now() - this._lastReceiveTime
      if (elapsed > IDLE_TIMEOUT) {
        logger.warn(`KCP idle timeout: ${elapsed}ms without any data`)
        this._stopIdleCheck()
        this._setStatus('error')
        this.emit(TRANSPORT_EVENTS.ERROR, new Error(`KCP connection idle timeout (${IDLE_TIMEOUT / 1000}s)`))
      }
    }, IDLE_CHECK_INTERVAL)
  }

  /**
   * 功能描述：停止空闲超时检测
   */
  private _stopIdleCheck(): void {
    if (this._idleCheckTimer) {
      clearInterval(this._idleCheckTimer)
      this._idleCheckTimer = null
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  延迟检测（KCP 内部 RTT）
  // ═══════════════════════════════════════════════════════════

  /**
   * 功能描述：启动延迟测量（每 2 秒读取一次 KCP 内部 RTT）
   */
  private _startLatencyMonitor(): void {
    this._stopLatencyMonitor()
    this._latencyTimer = setInterval(() => {
      if (!this._kcp) return
      const rtt = this._kcp.getRtt()
      if (rtt > 0) {
        this.emit(TRANSPORT_EVENTS.LATENCY, rtt)
      }
    }, 2000)
  }

  /**
   * 功能描述：停止延迟测量
   */
  private _stopLatencyMonitor(): void {
    if (this._latencyTimer) {
      clearInterval(this._latencyTimer)
      this._latencyTimer = null
    }
  }

  /**
   * 功能描述：启动 NAT 打洞探针定时重传
   *
   * 逻辑说明：使用所有绑定的 socket 向所有候选目标发送固定大小的打洞包。
   *           active 模式下 connect() 后即启动持续发送直到连接建立；
   *           passive 模式下由 addExternalTarget() 外部触发。
   *           初始使用密集间隔 100ms，3 秒后退避到 1500ms。
   *           探针包使本端 NAT 建立端口映射。
   *
   * @param fast - 是否从密集间隔开始
   */
  private _startProbeLoop(fast: boolean = false): void {
    this._stopProbeLoop()

    if (this._probeFastTimer) {
      clearTimeout(this._probeFastTimer)
      this._probeFastTimer = null
    }

    const interval = fast ? PROBE_INTERVAL_FAST : PROBE_INTERVAL_SLOW

    this._probeTimer = setInterval(() => {
      this._sendProbes()
    }, interval)

    if (fast) {
      this._probeFastTimer = setTimeout(() => {
        this._stopProbeLoop()
        this._startProbeLoop(false)
      }, PROBE_FAST_DURATION)
    }

    // 立即发送一次
    this._sendProbes()
  }

  /**
   * 功能描述：向所有探针目标发送打洞包
   *
   * 逻辑说明：使用所有绑定的 socket 向每个目标发送固定大小的打洞包。
   *           多 socket × 多目标组合提高 NAT 映射命中概率。
   */
  private _sendProbes(): void {
    if (this._connectionEstablished) return
    if (this._probeTargets.length === 0) return

    for (const socket of this._udpSockets) {
      if (!socket) continue
      for (const target of this._probeTargets) {
        socket.send(this._probePacket, 0, PROBE_PACKET_SIZE, target.port, target.address, (err) => {
          if (err) logger.warn(`KCP probe send failed [${target.address}:${target.port}]: ${err.message}`)
        })
      }
    }
  }

  /**
   * 功能描述：停止 NAT 打洞探针定时重传
   */
  private _stopProbeLoop(): void {
    if (this._probeTimer) {
      clearInterval(this._probeTimer)
      this._probeTimer = null
    }
    if (this._probeFastTimer) {
      clearTimeout(this._probeFastTimer)
      this._probeFastTimer = null
    }
  }

  /**
   * 功能描述：添加外部探针目标并启动探针循环（被动模式用）
   *
   * 逻辑说明：房主收到加入者的 kcp-port 信号后调用此方法，
   *           向加入者的公网地址发送打洞包，在房主 NAT 上建立端口映射。
   *
   * @param address - 目标 IP（加入者公网 IP）
   * @param port - 目标端口（加入者 KCP 本地端口）
   */
  addExternalTarget(address: string, port: number): void {
    if (this._connectionEstablished) return

    const exists = this._probeTargets.some(t => t.address === address && t.port === port)
    if (!exists) {
      this._probeTargets.push({ address, port })
      logger.info(`KCP added external probe target: ${address}:${port}`)
    }
    if (!this._probeTimer) {
      this._startProbeLoop(false)
    }
  }
}
