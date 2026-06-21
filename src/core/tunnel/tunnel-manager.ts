/**
 * 功能描述：隧道管理器 — 连接生命周期编排中心
 *
 * 逻辑说明：协调 Relay 连接、路径选择、传输层建立、本地隧道和自动降级。
 *           状态机：IDLE → CONNECTING_RELAY → CONNECTING_TRANSPORT → CONNECTED
 *           当传输层断开时自动降级到下一优先级路径。
 *           房主和加入者共用此类，通过 createRoom / joinRoom 区分角色。
 */

import { EventEmitter } from 'events'
import { Logger } from '../utils/logger'
import { RelayClient } from './relay-client'
import { LocalTunnelClient } from './local-client'
import { LocalTunnelServer } from './local-server'
import { Ipv6DirectTransport } from './ipv6-direct'
import { KcpTransport } from './kcp-transport'
import { P2pTransport, RelayPeerTransport } from '../p2p'
import { selectPath } from '../connection'
import { NetworkDetector } from '../network-detect/detector'
import { TRANSPORT_EVENTS } from '../connection'
import type { Transport, PeerConnectionInfo } from '../connection'
import type { CreateRoomResult, MemberJoinedData } from './types'
import type { NetworkInfo, ConnectionPath, TrafficSnapshot, TransportStatus, CreateRoomOptions } from '@shared/types'

const logger = new Logger('TunnelManager')

/** 隧道管理器状态 */
export type TunnelManagerState =
  | 'idle'
  | 'connecting-relay'
  | 'connecting-transport'
  | 'connected'
  | 'degrading'
  | 'disconnecting'
  | 'error'

/** 隧道管理器配置 */
export interface TunnelManagerConfig {
  relayUrl: string
  memberName: string
  connectTimeout: number
}

const DEFAULT_MANAGER_CONFIG: TunnelManagerConfig = {
  relayUrl: 'ws://159.75.150.37:9800',
  memberName: 'Player',
  connectTimeout: 30000
}

/** KCP 重连最大尝试次数 */
const KCP_RECONNECT_MAX_RETRIES = 3
/** KCP 重连基础延迟（毫秒，指数退避） */
const KCP_RECONNECT_BASE_DELAY = 2000

/** 状态报告 */
export interface TunnelStatusReport {
  state: TunnelManagerState
  transportType: Transport['type'] | null
  localPort: number
  clientCount: number
  trafficBytesSent: number
  trafficBytesReceived: number
}

/**
 * 功能描述：隧道管理器
 *
 * 逻辑说明：封装整个连接生命周期。对外提供 createRoom / joinRoom / leaveRoom 方法，
 *           对内协调 NetworkDetector, RelayClient, LocalTunnelServer 和各 Transport。
 *           当传输断开时自动按 IPv6 → P2P → Relay 顺序降级。
 *
 * @fires status - 管理器状态变更
 * @fires transport-changed - 传输层切换
 * @fires traffic - 流量统计快照
 * @fires connected - 连接建立成功
 * @fires disconnected - 连接断开
 * @fires error - 错误
 * @fires degrading - 正在降级
 * @fires member-joined - 新成员加入（房主侧）
 * @fires member-left - 成员离开
 */
export class TunnelManager extends EventEmitter {
  private _relayClient: RelayClient
  /** KCP 重连尝试次数（加入者侧） */
  private _kcpReconnectAttempts: number = 0
  private _guestTransports: Map<string, Transport> = new Map()
  private _guestClients: Map<string, LocalTunnelClient> = new Map()
  /** P2P 备选传输（IPv6 最优时额外创建的被动监听，用于降级切换） */
  private _p2pBackups: Map<string, P2pTransport> = new Map()
  /** Relay 备选传输（非 Relay 路径时创建，用于加入者降级到中继后的数据通道） */
  private _relayFallbacks: Map<string, RelayPeerTransport> = new Map()
  /** P2P 空闲超时定时器（memberId → timer） */
  private _p2pTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private _localServer: LocalTunnelServer = new LocalTunnelServer()
  private _currentTransport: Transport | null = null
  private _currentPath: ConnectionPath | null = null
  private _availablePaths: ConnectionPath[] = []
  private _currentPathIndex: number = -1
  private _isDegrading: boolean = false
  private _hostNetwork: NetworkInfo | null = null
  private _guestNetwork: NetworkInfo | null = null
  /** 房主侧各成员的 KCP 传输实例（用于外部探针触发） */
  private _guestKcpTransports: Map<string, KcpTransport> = new Map()
  /** 房主侧各成员的网络信息（用于 kcp-port 信号中查找加入者公网 IP） */
  private _guestNetworkInfos: Map<string, NetworkInfo> = new Map()
  private _role: 'host' | 'guest' | null = null
  private _config: TunnelManagerConfig
  private _state: TunnelManagerState = 'idle'
  private _gameId: string = ''
  private _gameName: string = ''
  private _gamePort: number = 0
  private _guestPeerInfo: PeerConnectionInfo | null = null
  /** 房主成员 ID（加入者侧使用，用于发送重置信号） */
  private _hostMemberId: string = ''
  private _networkDetector: NetworkDetector = new NetworkDetector()
  private _trafficBytesSent: number = 0
  private _trafficBytesReceived: number = 0

  constructor(config?: Partial<TunnelManagerConfig>) {
    super()
    this._config = { ...DEFAULT_MANAGER_CONFIG, ...config }
    this._relayClient = new RelayClient({ relayUrl: this._config.relayUrl })

    this._relayClient.on('connected', () => {
      logger.info('Relay 连接已建立')
    })

    this._relayClient.on('disconnected', () => {
      logger.warn('Relay 连接已断开')
    })

    this._relayClient.on('error', (err: Error) => {
      logger.error(`Relay 客户端错误: ${err.message}`)
      this.emit('error', err)
    })

    // 监听游戏客户端连接状态信令：
    // close-game-conn — 加入者全部客户端断开，房主立即关闭游戏连接
    this._relayClient.on('signal', (data: { from: string; signalData: unknown }) => {
      if (this._role !== 'host') return
      const sig = data.signalData as Record<string, unknown>
      if (sig?.type === 'close-game-conn') {
        const client = this._guestClients.get(data.from)
        if (client) {
          logger.debug(`收到 close-game-conn 信令, 关闭游戏连接 (成员 ${data.from})`)
          client.closeConnection()
        }
      }
      if (sig?.type === 'kcp-port' && typeof sig.kcpPort === 'number') {
        const kcp = this._guestKcpTransports.get(data.from)
        if (kcp) {
          // 优先使用信号中携带的公网 IP（加入者 STUN 结果），
          // 降级到 member-joined 时的 networkInfo
          const guestPublicIp = (sig.publicIp as string) || this._guestNetworkInfos.get(data.from)?.ipv4.publicIp
          if (guestPublicIp) {
            logger.info(`KCP 外部探针触发: 成员 ${data.from} 公网 ${guestPublicIp}:${sig.kcpPort}`)
            kcp.addExternalTarget(guestPublicIp, sig.kcpPort)
          } else {
            logger.warn(`KCP 收到 kcp-port 但无法获取成员 ${data.from} 的公网 IP`)
          }
        }
      }
    })

    this._relayClient.on('member-joined', (data: MemberJoinedData) => {
      logger.info(`成员加入: ${data.memberName} (${data.memberId})`)

      // 房主侧：根据网络检测结果选择最优路径，为加入者创建传输通道
      if (this._role === 'host') {
        this._setupHostTransportForGuest(data.memberId, data.networkInfo).catch((err) => {
          logger.error(`成员 ${data.memberId} 传输通道建立失败: ${(err as Error).message}`)
        })
      }

      this.emit(RELAY_MESSAGE_TYPES.MEMBER_JOINED, {
        id: data.memberId,
        name: data.memberName,
        transport: undefined
      })
    })

    this._relayClient.on('member-left', (data: { memberId: string }) => {
      logger.info(`成员离开: ${data.memberId}`)

      // 房主侧：清理该成员的资源
      if (this._role === 'host') {
        this._cleanupGuestTransport(data.memberId).catch((err) => {
          logger.error(`清理成员 ${data.memberId} 资源失败: ${(err as Error).message}`)
        })
      }

      this.emit(RELAY_MESSAGE_TYPES.MEMBER_LEFT, data)
    })

    this._localServer.on('status', () => {
      this.emit('status', this._state)
    })

    this._localServer.on('error', (err: Error) => {
      this.emit('error', err)
    })

    // 加入者全部游戏客户端断开 → 通知房主立即关闭游戏连接
    // 在断开间隙（用户重开游戏前）发送，无竞争
    this._localServer.on('all-clients-disconnected', () => {
      if (this._role === 'guest' && this._hostMemberId) {
        logger.info('所有游戏客户端已断开, 通知房主关闭游戏连接')
        this._relayClient.sendSignal(this._hostMemberId, { type: 'close-game-conn' }).catch((err: Error) => {
          logger.error(`发送 close-game-conn 信号失败: ${err.message}`)
        })
      }
    })

    // 游戏客户端重连 → 通过 KCP 带内重置信号通知房主销毁旧连接，
    // RESET 帧与游戏数据同路径（KCP 流），保证到达顺序
    this._localServer.on('client-reconnected', () => {
      if (this._role === 'guest') {
        if (this._currentTransport instanceof KcpTransport) {
          this._currentTransport.sendControl('reset')
          logger.debug('已发送 KCP 带内重置信号')
        }
      }
    })
  }

  get state(): TunnelManagerState { return this._state }

  /**
   * 功能描述：更新中继服务器地址（下次连接时生效）
   *
   * @param url - 中继服务器 WebSocket 地址
   */
  setRelayUrl(url: string): void {
    this._relayClient.setRelayUrl(url)
    this._config.relayUrl = url
  }

  // ─── 公共 API ───────────────────────────────────────

  /**
   * 功能描述：创建房间（房主调用）
   *
   * 逻辑说明：检测网络 → 连接 Relay → 创建房间 → 本地客户端连接游戏服务器。
   *
   * @param options - 游戏信息
   * @returns 房间创建结果
   * @throws 网络检测失败、Relay 连接失败、连接游戏服务器失败
   */
  async createRoom(options: CreateRoomOptions): Promise<CreateRoomResult> {
    this._role = 'host'
    this._gameId = options.gameId
    this._gameName = options.gameName
    this._gamePort = options.gamePort

    // 1. 网络检测
    this._setState('connecting-relay')
    this._hostNetwork = await this._networkDetector.detect()

    // 1.5 应用自定义中继地址（如有）
    if (options.relayUrl && options.relayUrl !== this._config.relayUrl) {
      this.setRelayUrl(options.relayUrl)
    }

    // 2. 连接 Relay（房主端模式：二进制帧包含 sourceMemberId）
    await this._relayClient.connect()
    this._relayClient.setHostMode()

    // 3. 创建房间
    const roomResult = await this._relayClient.createRoom({
      gameId: this._gameId,
      gameName: this._gameName,
      gamePort: this._gamePort,
      memberName: this._config.memberName,
      networkInfo: this._hostNetwork
    })

    this._setState('connected')
    logger.info(`房间已创建: ${roomResult.roomCode}`)

    this.emit('connected', {
      localPort: this._gamePort,
      gamePort: this._gamePort,
      roomCode: roomResult.roomCode
    })

    return roomResult
  }

  /**
   * 功能描述：加入房间（加入者调用）
   *
   * 逻辑说明：检测网络 → 连接 Relay → 加入房间 → 路径选择 → 建立传输 → 启动本地隧道。
   *
   * @param roomCode - 6 位房间码
   * @param relayUrl - 可选，自定义中继服务器地址
   * @throws 网络检测失败、房间不存在、所有连接方式均不可用
   */
  async joinRoom(roomCode: string, relayUrl?: string, localPort?: number): Promise<void> {
    this._role = 'guest'
    this._setState('connecting-relay')

    // 1. 网络检测
    this._guestNetwork = await this._networkDetector.detect()

    // 1.5 应用自定义中继地址（如有）
    if (relayUrl && relayUrl !== this._config.relayUrl) {
      this.setRelayUrl(relayUrl)
    }

    // 2. 连接 Relay
    await this._relayClient.connect()

    // 3. 注册信号预收集器（在 joinRoom 之前，防止房主 Signal 在监听器注册前到达）
    const earlySignals: Array<{ from: string; signalData: unknown }> = []
    const onEarlySignal = (data: { from: string; signalData: unknown }): void => {
      const sigType = ((data as { signalData?: { type?: string } }).signalData?.type) || 'unknown'
      logger.debug(`[SIGNAL] 收到信号: from=${data.from}, type=${sigType}`)
      earlySignals.push(data)
    }
    this._relayClient.on('signal', onEarlySignal)

    let hostId = ''

    try {
      const joinResult = await this._relayClient.joinRoom(roomCode, {
        memberName: this._config.memberName,
        networkInfo: this._guestNetwork
      })

      hostId = joinResult.hostId
      this._hostMemberId = hostId
      this._gameId = ''
      this._gamePort = joinResult.gamePort
      this._hostNetwork = joinResult.hostNetworkInfo || null
      this._guestPeerInfo = this._buildPeerInfo(joinResult.hostNetworkInfo || this._hostNetwork)

      // 应用在 joinRoom 响应返回前已到达的信号（房主迅速创建 P2P/IPv6 通道并发出 Signal）
      for (const sig of earlySignals) {
        if (sig.from !== joinResult.hostId) continue
        const data = sig.signalData as Record<string, unknown>
        if (data?.type === 'p2p-address' && typeof data.ip === 'string' && typeof data.port === 'number') {
          if (this._guestPeerInfo) {
            this._guestPeerInfo.publicAddress = { ip: data.ip, port: data.port }
            const p2pPreInfo = process.env.NODE_ENV !== 'production' ? ` [${data.ip}]:${data.port}` : ''
            logger.info(`预接收 P2P 地址信号${p2pPreInfo}`)
          }
        }
        if (data?.type === 'ipv6-address' && typeof data.address === 'string' && typeof data.port === 'number') {
          if (this._guestPeerInfo) {
            this._guestPeerInfo.ipv6Address = data.address
            this._guestPeerInfo.ipv6Port = data.port
            const v6PreInfo = process.env.NODE_ENV !== 'production' ? ` [${data.address}]:${data.port}` : ''
            logger.info(`预接收 IPv6 地址信号${v6PreInfo}`)
          }
        }
        if (data?.type === 'kcp-address' && typeof data.ip === 'string' && typeof data.port === 'number') {
          if (this._guestPeerInfo) {
            this._guestPeerInfo.kcpAddress = { ip: data.ip, port: data.port }
            const kcpPreInfo = process.env.NODE_ENV !== 'production' ? ` [${data.ip}]:${data.port}` : ''
            logger.info(`预接收 KCP 地址信号${kcpPreInfo}`)
          }
        }
      }

      // 3.5 根据自身网络能力按需等待信号（IPv6/P2P 不可用时无需等待）
      // IPv6 条件与 path-selector 一致: 双方 hasPublicV6 均 true 时路径才会包含 IPv6
      const signalWaits: Promise<void>[] = []
      const hostV6 = joinResult.hostNetworkInfo?.ipv6 ?? this._hostNetwork?.ipv6
      const guestV6 = this._guestNetwork!.ipv6
      if (hostV6?.hasPublicV6 && guestV6.hasPublicV6) {
        signalWaits.push(this._waitForIpv6Signal(joinResult.hostId, 3000).then(() => {}))
      }
      if (this._guestNetwork!.ipv4.publicIp !== '') {
        signalWaits.push(this._waitForP2pSignal(joinResult.hostId, 1500).then(() => {}))
        signalWaits.push(this._waitForKcpSignal(joinResult.hostId, 1500).then(() => {}))
      }
      logger.debug(`[SIGNAL] 等待信号: IPv6=${!!(hostV6?.hasPublicV6 && guestV6.hasPublicV6)}, P2P/KCP=${this._guestNetwork!.ipv4.publicIp !== ''}`)
      await Promise.all(signalWaits)
      logger.info('地址信号接收完成, 开始路径选择')
    } finally {
      this._relayClient.removeListener('signal', onEarlySignal)
    }

    // 4. 路径选择与连接
    await this._selectAndConnect()

    // 5. 注册游戏客户端连接处理器 — LocalClient 的惰性重连机制
    //    已能自动处理游戏服务器连接断开后的重建：
    //    数据到达时检测 socket 无效，自动创建新连接并刷新缓冲区。
    //    KCP 重连时通过 sendControl('reset') 发送带内 RESET 帧确保顺序，
    //    非 KCP 传输（IPv6/Relay）无需额外重置（TCP 断开即清空）。
    this._localServer.on('client-connected', () => {
      if (this._currentTransport) {
        logger.debug(`游戏客户端已连接, transport=${this._currentTransport.type}`)
      }
    })

    // 6. 启动本地隧道（传入自定义端口或自动选择）
    const allocPort = await this._localServer.start(localPort || 0)

    this._setState('connected')
    logger.info(`已加入房间 ${roomCode}, 本地端口: ${allocPort}`)

    this.emit('connected', {
      localPort: allocPort,
      gamePort: this._gamePort,
      roomCode
    })
  }

  /**
   * 功能描述：离开房间
   *
   * 逻辑说明：停止本地隧道、断开传输、离开房间、重置状态。
   */
  async leaveRoom(): Promise<void> {
    this._setState('disconnecting')

    // 断开所有 Guest 传输通道（房主侧）
    for (const [, transport] of this._guestTransports) {
      try { await transport.disconnect() } catch { /* ignore */ }
    }
    this._guestTransports.clear()

    // 断开所有 Guest 本地客户端（房主侧）
    for (const [, client] of this._guestClients) {
      try { await client.disconnect() } catch { /* ignore */ }
    }
    this._guestClients.clear()

    // 清除所有 P2P 超时定时器
    for (const [mid] of this._p2pTimeouts) this._clearP2pTimeout(mid)

    // 断开所有 P2P 备选传输（房主侧，IPv6 场景）
    for (const [, p2p] of this._p2pBackups) {
      try { await p2p.disconnect() } catch { /* ignore */ }
    }
    this._p2pBackups.clear()

    // 断开所有 Relay 备选传输（房主侧）
    for (const [, relay] of this._relayFallbacks) {
      try { await relay.disconnect() } catch { /* ignore */ }
    }
    this._relayFallbacks.clear()

    // 清理 KCP 传输映射和网络信息（房主侧）
    this._guestKcpTransports.clear()
    this._guestNetworkInfos.clear()

    // 断开当前传输（加入者侧）
    if (this._currentTransport) {
      try { await this._currentTransport.disconnect() } catch { /* ignore */ }
      this._currentTransport = null
    }

    // 停止本地隧道服务端（加入者侧）
    try { await this._localServer.stop() } catch { /* ignore */ }
    // 清理客户端连接事件监听器
    this._localServer.removeAllListeners('client-connected')

    // 离开房间
    try { await this._relayClient.leaveRoom() } catch { /* ignore */ }

    // 断开 Relay
    try { await this._relayClient.disconnect() } catch { /* ignore */ }

    this._currentPath = null
    this._availablePaths = []
    this._currentPathIndex = -1
    this._role = null
    this._hostMemberId = ''
    this._trafficBytesSent = 0
    this._trafficBytesReceived = 0
    this._hostNetwork = null
    this._guestNetwork = null
    this._guestPeerInfo = null
    this._kcpReconnectAttempts = 0
    this._setState('idle')
    this.emit('disconnected')
    logger.info('已离开房间')
  }

  /**
   * 功能描述：获取当前状态报告
   *
   * @returns 状态报告
   */
  async getStatus(): Promise<TunnelStatusReport> {
    return {
      state: this._state,
      transportType: this._currentTransport?.type || null,
      localPort: this._role === 'host' ? this._gamePort : this._localServer.localPort,
      clientCount: this._role === 'host' ? this._guestClients.size : this._localServer.clientCount,
      trafficBytesSent: this._trafficBytesSent,
      trafficBytesReceived: this._trafficBytesReceived
    }
  }

  // ─── 私有方法 ───────────────────────────────────────

  /**
   * 功能描述：启动 P2P 空闲超时定时器
   *
   * 逻辑说明：P2P 临时服务器创建后在指定时间内未收到连接则自动关闭。
   *
   * @param memberId - 成员 ID
   * @param p2p - P2P 传输实例
   * @param timeoutMs - 超时毫秒数
   */
  private _startP2pTimeout(memberId: string, p2p: P2pTransport, timeoutMs: number): void {
    this._clearP2pTimeout(memberId)
    const timer = setTimeout(async () => {
      // 已连接，无需清理
      if (p2p.status === 'connected') return

      logger.debug(`P2P 传输超时未连接，关闭服务器 (成员 ${memberId})`)

      // 从备选列表移除
      if (this._p2pBackups.get(memberId) === p2p) {
        this._p2pBackups.delete(memberId)
      }

      try { await p2p.disconnect() } catch { /* ignore */ }
    }, timeoutMs)
    this._p2pTimeouts.set(memberId, timer)
  }

  /**
   * 功能描述：清除 P2P 空闲超时定时器
   *
   * @param memberId - 成员 ID
   */
  private _clearP2pTimeout(memberId: string): void {
    const timer = this._p2pTimeouts.get(memberId)
    if (timer) {
      clearTimeout(timer)
      this._p2pTimeouts.delete(memberId)
    }
  }

  /**
   * 功能描述：为指定成员创建传输通道和游戏服务器连接
   *
   * 逻辑说明：根据网络检测结果选择最优路径，创建对应传输通道：
   *           - P2P:   创建 P2pTransport(passive)，监听临时端口，
   *                    通过 Relay Signal 将地址通知加入者
   *           - Relay: 创建 RelayPeerTransport（兜底）
   *
   * @param memberId - 目标成员 ID
   * @param guestNetwork - 加入者的网络检测结果
   */
  private async _setupHostTransportForGuest(
    memberId: string,
    guestNetwork: NetworkInfo
  ): Promise<void> {
    if (this._guestTransports.has(memberId)) {
      logger.info(`成员 ${memberId} 已有传输通道, 跳过`)
      return
    }

    const paths = selectPath(this._hostNetwork, guestNetwork)
    const bestPath = paths[0]

    let transport: Transport = null as unknown as Transport
    let p2pBackup: P2pTransport | null = null

    if (bestPath.type === 'p2p') {
      const methods = bestPath.p2pStrategy?.methods || ['tcp', 'udp']
      const hasTcp = methods.includes('tcp')
      const hasUdp = methods.includes('udp')

      if (hasTcp) {
        const p2p = new P2pTransport()
        p2p.setRole('passive')
        await p2p.connect({ peerId: memberId })

        const pubAddr = this._hostNetwork!.ipv4
        if (pubAddr.publicIp && p2p.localPort) {
          this._relayClient.sendSignal(memberId, {
            type: 'p2p-address',
            ip: pubAddr.publicIp,
            port: p2p.localPort
          }).catch((err: Error) => {
            logger.error(`发送 P2P 地址信号失败: ${err.message}`)
          })
        }

        transport = p2p
        logger.info(`[P2P 通道已开启] 成员 ${memberId} 监听 0.0.0.0:${p2p.localPort}`)
        this._startP2pTimeout(memberId, p2p, 60000)
      }

      if (hasUdp) {
        const kcp = new KcpTransport()
        kcp.setRole('passive')
        await kcp.connect({ peerId: memberId })

        // KCP connect 已立即返回（bound 不等待 STUN），
        // 等待 public-addr 事件获得公网地址后发送 KCP 地址信号
        const sendKcpAddress = (): void => {
          const ip = kcp.publicIp || this._hostNetwork?.ipv4.publicIp
          const port = kcp.publicPort || kcp.localPort
          if (ip && port) {
            this._relayClient.sendSignal(memberId, {
              type: 'kcp-address',
              ip,
              port
            }).catch((err: Error) => {
              logger.error(`发送 KCP 地址信号失败: ${err.message}`)
            })
          }
        }
        // STUN 完成后发送（优先），未完成时用本地地址兜底
        kcp.on('public-addr', sendKcpAddress)
        // 兜底：STUN 超时/失败时 publicPort 被设为 localPort，setTimeout 确保在其之后执行
        setTimeout(sendKcpAddress, 3500)

        // 注册 KCP 传输实例，使 kcp-port 信号处理器能触发外部探针
        this._guestKcpTransports.set(memberId, kcp)
        this._guestNetworkInfos.set(memberId, guestNetwork)

        if (!hasTcp) {
          transport = kcp
          logger.info(`[KCP 通道已开启] 成员 ${memberId} 监听 0.0.0.0:${kcp.localPort}`)
          const kcpTimer = setTimeout(() => {
            if (kcp.status !== 'connected') {
              logger.warn(`成员 ${memberId} KCP 连接超时`)
              kcp.disconnect().catch(() => {})
              this._guestTransports.delete(memberId)
            }
          }, 30000)
          kcp.on('status', function onKcpStatus(status: TransportStatus) {
            if (status === 'connected' || status === 'error') {
              clearTimeout(kcpTimer)
              kcp.removeListener('status', onKcpStatus)
            }
          })
        } else {
          logger.info(`[KCP 备选通道已开启] 成员 ${memberId} 监听 0.0.0.0:${kcp.localPort}`)
          const tcpTransport = transport!
          kcp.on('status', (status: TransportStatus) => {
            if (status !== 'connected') return
            const cl = this._guestClients.get(memberId)
            const cur = this._guestTransports.get(memberId)
            if (!cl || cur !== tcpTransport) return

            this._clearP2pTimeout(memberId)
            logger.info(`成员 ${memberId} 切换到 KCP 传输 (TCP 降级)`)
            cl.setTransport(kcp)
            const pendingCount = kcp.drainPendingData((data: Buffer) => {
              kcp.emit(TRANSPORT_EVENTS.DATA, data)
            })
            if (pendingCount > 0) logger.debug(`KCP 切换: 回放 ${pendingCount} 条缓冲数据到 LocalClient`)
            this._guestTransports.set(memberId, kcp)
            this._setupTransportEvents(kcp)
            tcpTransport.disconnect().catch(() => {})
            this.emit('transport-changed', 'p2p')
          })
          tcpTransport.on('status', function onTcpConnected(...args: unknown[]) {
            if (args[0] === 'connected') {
              kcp.disconnect().catch(() => {})
            }
          })
        }
      }
    } else if (bestPath.type === 'ipv6') {
      logger.info(`为成员 ${memberId} 建立传输通道 (IPv6 主, P2P 备选)`)

      const ipv6Transport = new Ipv6DirectTransport()
      ipv6Transport.setRole('passive')
      await ipv6Transport.connect({ peerId: memberId })

      const v6Addr = this._hostNetwork!.ipv6.addresses[0]
      if (v6Addr && ipv6Transport.localPort) {
        this._relayClient.sendSignal(memberId, {
          type: 'ipv6-address',
          address: v6Addr,
          port: ipv6Transport.localPort
        }).catch((err: Error) => {
          logger.error(`发送 IPv6 地址信号失败: ${err.message}`)
        })
      }

      logger.info(`[IPv6 通道已开启] 成员 ${memberId} 监听 :::${ipv6Transport.localPort}`)
      transport = ipv6Transport

      const p2p = new P2pTransport({ connectTimeout: 30000 })
      p2p.setRole('passive')
      await p2p.connect({ peerId: memberId })

      const pubAddr = this._hostNetwork!.ipv4
      if (pubAddr.publicIp && p2p.localPort) {
        this._relayClient.sendSignal(memberId, {
          type: 'p2p-address',
          ip: pubAddr.publicIp,
          port: p2p.localPort
        }).catch((err: Error) => {
          logger.error(`发送 P2P 备选地址信号失败: ${err.message}`)
        })
      }

      p2pBackup = p2p
      this._p2pBackups.set(memberId, p2p)
      logger.info(`[P2P 备选通道已开启] 成员 ${memberId} 监听 0.0.0.0:${p2p.localPort} (30s 超时)`)
      this._startP2pTimeout(memberId, p2p, 30000)
    } else {
      logger.info(`为成员 ${memberId} 建立传输通道 (中继转发)`)
      transport = new RelayPeerTransport(this._relayClient, memberId)
      await transport.connect({ peerId: memberId })
    }

    const client = new LocalTunnelClient()
    client.setTransport(transport)
    await client.connect(this._gamePort, '127.0.0.1')

    this._guestTransports.set(memberId, transport)
    this._guestClients.set(memberId, client)
    this._setupTransportEvents(transport)
    this.emit('transport-changed', transport.type)
    logger.info(`成员 ${memberId} 本地代理已连接到 127.0.0.1:${this._gamePort}`)

    // 主 P2P 连接成功时清除超时定时器
    if (transport instanceof P2pTransport) {
      transport.on('status', (status: TransportStatus) => {
        if (status === 'connected') this._clearP2pTimeout(memberId)
      })
    }

    if (p2pBackup) {
      const onP2pConnected = (status: TransportStatus) => {
        if (status !== 'connected') return
        const cl = this._guestClients.get(memberId)
        const cur = this._guestTransports.get(memberId)
        if (!cl || cur !== transport) return

        this._clearP2pTimeout(memberId)
        logger.info(`成员 ${memberId} 切换到 P2P 传输 (IPv6 备选)`)
        cl.setTransport(p2pBackup!)
        this._guestTransports.set(memberId, p2pBackup!)
        this._p2pBackups.delete(memberId)
        this._setupTransportEvents(p2pBackup!)
        transport.disconnect().catch(() => {})
        this.emit('transport-changed', p2pBackup!.type)
      }
      p2pBackup.on('status', onP2pConnected)
    }

    this.emit('transport-changed', transport.type)
    logger.info(`成员 ${memberId} 本地代理已连接到 127.0.0.1:${this._gamePort}`)

    if (bestPath.type !== 'relay') {
      this._addRelayFallback(memberId, transport)
    }
  }

  /**
   * 功能描述：创建 Relay 备选传输（加入者侧可能降级到中继）
   *
   * 逻辑说明：当加入者侧的 IPv6/P2P 连接失败后降级到中继，
   *           但房主侧仍在使用主传输，导致中继数据无人接收。
   *           注册中继数据监听器，收到数据时自动将
   *           LocalTunnelClient 切换到 Relay 备选传输。
   *
   * @param memberId - 目标成员 ID
   * @param primaryTransport - 当前主传输（切换后将被断开）
   */
  private async _addRelayFallback(memberId: string, primaryTransport: Transport): Promise<void> {
    const relayFallback = new RelayPeerTransport(this._relayClient, memberId)
    await relayFallback.connect({ peerId: memberId })
    this._relayFallbacks.set(memberId, relayFallback)

    const onRelayData = (data: Buffer): void => {
      const cl = this._guestClients.get(memberId)
      if (!cl) return

      // 已切换到中继，跳过
      if (this._guestTransports.get(memberId) === relayFallback) return

      logger.info(`成员 ${memberId} 切换到中继传输 (主传输降级)`)
      relayFallback.removeListener(TRANSPORT_EVENTS.DATA, onRelayData)
      this._relayFallbacks.delete(memberId)

      cl.setTransport(relayFallback)
      this._guestTransports.set(memberId, relayFallback)
      this._setupTransportEvents(relayFallback)
      primaryTransport.disconnect().catch(() => {})
      this.emit('transport-changed', 'relay')

      // 重新发射本次数据，让客户端的 DATA 监听器处理
      relayFallback.emit(TRANSPORT_EVENTS.DATA, data)
    }

    relayFallback.on(TRANSPORT_EVENTS.DATA, onRelayData)
  }

  /**
   * 功能描述：清理指定成员的传输资源
   *
   * @param memberId - 成员 ID
   */
  private async _cleanupGuestTransport(memberId: string): Promise<void> {
    this._clearP2pTimeout(memberId)
    const client = this._guestClients.get(memberId)
    if (client) {
      try { await client.disconnect() } catch { /* ignore */ }
      this._guestClients.delete(memberId)
    }

    const transport = this._guestTransports.get(memberId)
    if (transport) {
      try { await transport.disconnect() } catch { /* ignore */ }
      this._guestTransports.delete(memberId)
    }

    // 清理 P2P 备选传输（如果尚未切换）
    const p2pBackup = this._p2pBackups.get(memberId)
    if (p2pBackup) {
      try { await p2pBackup.disconnect() } catch { /* ignore */ }
      this._p2pBackups.delete(memberId)
    }

    // 清理 Relay 备选传输（加入者降级到中继时的数据通道）
    const relayBackup = this._relayFallbacks.get(memberId)
    if (relayBackup) {
      try { await relayBackup.disconnect() } catch { /* ignore */ }
      this._relayFallbacks.delete(memberId)
    }

    this._guestKcpTransports.delete(memberId)
    this._guestNetworkInfos.delete(memberId)

    logger.info(`成员 ${memberId} 的传输资源已清理`)
  }

  /**
   * 功能描述：路径选择并建立连接
   *
   * 逻辑说明：使用 PathSelector 获取有序路径列表，按序尝试连接。
   */
  private async _selectAndConnect(): Promise<void> {
    this._setState('connecting-transport')
    this._availablePaths = selectPath(this._hostNetwork, this._guestNetwork)

    // 日志：NAT 类型与路径选择摘要
    const hostNat = this._hostNetwork?.ipv4.natType || 'unknown'
    const guestNat = this._guestNetwork?.ipv4.natType || 'unknown'
    const hostMapping = this._hostNetwork?.ipv4.mappingBehavior || 'unknown'
    const guestMapping = this._guestNetwork?.ipv4.mappingBehavior || 'unknown'
    const descriptions = this._availablePaths.map(p => p.description).join(' → ')
    logger.info(`路径选择: [${descriptions}] (host NAT: ${hostNat}/${hostMapping}, guest NAT: ${guestNat}/${guestMapping})`)

    // 顺序尝试每个路径，失败后自动切换到下一路径
    for (let i = 0; i < this._availablePaths.length; i++) {
      try {
        this._currentPathIndex = i
        this._currentPath = this._availablePaths[i]
        await this._connectWithPath()
        return
      } catch (err) {
        if (i < this._availablePaths.length - 1) {
          const nextDesc = this._availablePaths[i + 1].description
          logger.warn(`${this._availablePaths[i].description} 连接失败: ${(err as Error).message}, 降级到 ${nextDesc}`)
        } else {
          this._setState('error')
          const finalErr = new Error('所有连接方式均不可用')
          this.emit('error', finalErr)
          throw finalErr
        }
      }
    }
  }

  /**
   * 功能描述：使用当前路径建立连接
   *
   * 逻辑说明：创建 Transport，连接对端，设置到本地隧道。
   *           成功时更新状态，失败时抛出异常供 _selectAndConnect / _degrade 处理。
   *
   * @throws 创建或连接 Transport 失败
   */
  private async _connectWithPath(): Promise<void> {
    logger.info(`尝试连接: ${this._currentPath!.description}`)

    // 断开旧传输（先置 null 防止 STATUS 事件触发重复降级）
    if (this._currentTransport) {
      const oldTransport = this._currentTransport
      this._currentTransport = null
      try {
        await oldTransport.disconnect()
      } catch { /* ignore */ }
    }

    const transport = await this._createAndConnect()

    // 设置到本地隧道（加入者侧）
    this._currentTransport = transport
    this._localServer.setTransport(transport)

    // 回放 KCP 缓冲数据：监听器注册前到达的数据可能丢失
    if (transport instanceof KcpTransport) {
      const drained = transport.drainPendingData((data: Buffer) => {
        transport.emit(TRANSPORT_EVENTS.DATA, data)
      })
      if (drained > 0) {
        logger.debug(`KCP 回放 ${drained} 条缓冲数据到 LocalServer`)
      }
    }

    this._setupTransportEvents(transport)

    this._setState('connected')
    this.emit('transport-changed', transport.type)
    logger.info(`${this._currentPath!.description} 连接成功`)
  }

  /**
   * 功能描述：创建并连接 Transport（P2P 路径并行尝试 TCP/UDP，非 P2P 直接创建）
   *
   * 逻辑说明：
   *   - 非 P2P 路径（IPv6/Relay）：直接创建对应 Transport 并连接
   *   - P2P 路径且仅单方法：顺序连接
   *   - P2P 路径且多方法：并行同时尝试 TCP 和 UDP，取最快建立的连接
   *   - KCP 连接成功后（加入者侧）：自动创建中继备用传输，主传输断开时无缝切换
   *
   * @returns 已连接的 Transport 实例
   */
  private async _createAndConnect(): Promise<Transport> {
    if (this._currentPath?.type !== 'p2p') {
      const transport = this._createTransport(this._currentPath!.type)
      if (transport instanceof P2pTransport) {
        transport.setRole(this._role === 'host' ? 'passive' : 'active')
      }
      await transport.connect(this._guestPeerInfo || { peerId: '' })
      return transport
    }

    // P2P：按优先级尝试 TCP / UDP
    const methods = this._currentPath.p2pStrategy?.methods || ['tcp', 'udp']
    let lastError: Error | null = null

    if (methods.length === 1) {
      // 单方法：顺序尝试
      return await this._trySingleP2pMethod(methods[0]!)
    }

    // 多方法：并行竞争，取最快建立的连接
    const pending: Array<{
      method: string
      transport: Transport
      promise: Promise<Transport>
    }> = []

    for (const method of methods) {
      if (method === 'tcp') {
        const p2p = new P2pTransport()
        p2p.setRole(this._role === 'host' ? 'passive' : 'active')
        pending.push({
          method,
          transport: p2p,
          promise: p2p.connect(this._guestPeerInfo || { peerId: '' }).then(() => p2p)
        })
      } else {
        const kcp = this._createKcpWithSignals()
        pending.push({
          method,
          transport: kcp,
          promise: kcp.connect(this._guestPeerInfo || { peerId: '' }).then(() => {
            // KCP 成功 → 创建中继备用
            if (this._role === 'guest') {
              this._addGuestRelayFallback(kcp).catch((err: Error) => {
                logger.warn(`创建中继备用失败: ${err.message}`)
              })
            }
            return kcp
          })
        })
      }
    }

    try {
      const winner = await Promise.race(pending.map(p => p.promise))

      // 清理较慢的传输
      for (const p of pending) {
        if (p.transport !== winner) {
          p.transport.disconnect().catch(() => {})
          p.promise.catch(() => {}) // 吞掉被断开的 connect 异常
        }
      }

      logger.info(`P2P 并行竞争: ${pending.filter(p => p.transport === winner)[0]?.method || 'unknown'} 胜出`)
      return winner
    } catch (err) {
      // 所有方法均失败：确保所有 transport 已清理
      for (const p of pending) {
        if (p.transport.status !== 'disconnected') {
          p.transport.disconnect().catch(() => {})
        }
        p.promise.catch(() => {})
      }
      lastError = err as Error
      throw lastError || new Error('P2P 连接失败')
    }
  }

  /**
   * 功能描述：尝试单一 P2P 连接方法
   *
   * @param method - 'tcp' 或 'udp'
   * @returns 已连接的 Transport
   */
  private async _trySingleP2pMethod(method: string): Promise<Transport> {
    if (method === 'tcp') {
      const p2p = new P2pTransport()
      p2p.setRole(this._role === 'host' ? 'passive' : 'active')
      await p2p.connect(this._guestPeerInfo || { peerId: '' })
      return p2p
    }

    const kcp = this._createKcpWithSignals()
    await kcp.connect(this._guestPeerInfo || { peerId: '' })

    // KCP 成功 → 创建中继备用（加入者侧）
    if (this._role === 'guest') {
      this._addGuestRelayFallback(kcp).catch((err: Error) => {
        logger.warn(`创建中继备用失败: ${err.message}`)
      })
    }

    return kcp
  }

  /**
   * 功能描述：创建 KCP 传输并注册信号处理器
   *
   * 逻辑说明：提取 KCP 实例创建和 bound/public-addr 信号注册的公共逻辑，
   *           供 _createAndConnect 和 _tryKcpReconnect 复用。
   *
   * @returns 配置好的 KcpTransport 实例（尚未 connect）
   */
  private _createKcpWithSignals(): KcpTransport {
    const kcp = new KcpTransport()
    kcp.setRole(this._role === 'host' ? 'passive' : 'active')

    if (this._role === 'guest' && this._hostMemberId) {
      // Guest 侧：绑定后立即发送 kcp-port（本地端口），
      // 房主尽早开始探测建立 NAT 映射；STUN 公网地址发现后更新
      kcp.on('bound', (localPort: number) => {
        const publicIp = this._guestNetwork?.ipv4.publicIp || ''
        this._relayClient.sendSignal(this._hostMemberId, {
          type: 'kcp-port',
          kcpPort: localPort,
          publicIp
        }).catch((err: Error) => {
          logger.error(`发送 KCP 端口信号失败: ${err.message}`)
        })
      })
      kcp.on('public-addr', (pubPort: number, pubIp: string | null) => {
        const publicIp = pubIp || this._guestNetwork?.ipv4.publicIp || ''
        this._relayClient.sendSignal(this._hostMemberId, {
          type: 'kcp-port',
          kcpPort: pubPort,
          publicIp
        }).catch((err: Error) => {
          logger.error(`发送 KCP 端口更新信号失败: ${err.message}`)
        })
      })
    }

    return kcp
  }

  /**
   * 功能描述：创建加入者侧中继备用传输
   *
   * 逻辑说明：KCP 连接建立后额外创建一个 RelayPeerTransport 作为备用。
   *           当 KCP 断开且中继有数据到达时自动切换，实现无缝降级。
   *           不阻塞主流程（fire-and-forget）。
   *
   * @param primaryTransport - 主传输（KCP）
   */
  private async _addGuestRelayFallback(primaryTransport: Transport): Promise<void> {
    if (!this._hostMemberId) return

    const relayFallback = new RelayPeerTransport(this._relayClient, undefined, this._hostMemberId)
    await relayFallback.connect({ peerId: this._hostMemberId })

    const onRelayData = (data: Buffer): void => {
      // 已切换到中继，跳过
      if (this._currentTransport === relayFallback) return

      // 主传输仍连接，忽略中继数据
      if (primaryTransport.status === 'connected') return

      logger.info('加入者切换到中继传输 (KCP 断开)')
      relayFallback.removeListener(TRANSPORT_EVENTS.DATA, onRelayData)

      const oldTransport = this._currentTransport
      this._currentTransport = relayFallback
      this._localServer.setTransport(relayFallback)
      this._setupTransportEvents(relayFallback)

      if (oldTransport && oldTransport !== relayFallback) {
        oldTransport.disconnect().catch(() => {})
      }
      this.emit('transport-changed', 'relay')

      // 重新发射本次数据
      relayFallback.emit(TRANSPORT_EVENTS.DATA, data)
    }

    relayFallback.on(TRANSPORT_EVENTS.DATA, onRelayData)
    logger.debug('中继备用传输已建立')
  }

  /**
   * 功能描述：KCP 传输重连（加入者侧）
   *
   * 逻辑说明：KCP 空闲超时或传输错误时尝试重建连接。
   *           指数退避：2s → 4s → 8s，最多 3 次。
   *           成功后重新绑定到 LocalServer，重设传输事件。
   *           超过重试次数后降级到下一路径。
   *
   * @throws 所有重试均失败时抛出错误
   */
  private async _tryKcpReconnect(): Promise<void> {
    if (this._kcpReconnectAttempts >= KCP_RECONNECT_MAX_RETRIES) {
      logger.warn('KCP 重连已达最大次数, 切换到 degrade')
      this._kcpReconnectAttempts = 0
      this._degrade().catch((err) => {
        this.emit('error', err)
      })
      return
    }

    const delay = KCP_RECONNECT_BASE_DELAY * Math.pow(2, this._kcpReconnectAttempts)
    this._kcpReconnectAttempts++
    logger.info(`KCP 重连第 ${this._kcpReconnectAttempts} 次 (等待 ${delay}ms)`)

    await new Promise(resolve => setTimeout(resolve, delay))

    try {
      const oldTransport = this._currentTransport

      const kcp = this._createKcpWithSignals()
      await kcp.connect(this._guestPeerInfo || { peerId: '' })

      // 切换传输
      this._currentTransport = kcp
      this._localServer.setTransport(kcp)

      // 断开旧传输
      if (oldTransport) {
        try { await oldTransport.disconnect() } catch { /* 忽略 */ }
      }

      // 回放缓冲数据
      const drained = kcp.drainPendingData((data: Buffer) => {
        kcp.emit(TRANSPORT_EVENTS.DATA, data)
      })
      if (drained > 0) {
        logger.debug(`KCP 重连: 回放 ${drained} 条缓冲数据到 LocalServer`)
      }

      this._setupTransportEvents(kcp)
      this._kcpReconnectAttempts = 0
      logger.info('KCP 重连成功')
      this.emit('transport-changed', 'p2p')
    } catch (err) {
      logger.warn(`KCP 重连失败: ${(err as Error).message}`)
      // 递归重试
      await this._tryKcpReconnect()
    }
  }

  /**
   * 功能描述：自动降级到下一优先级路径
   *
   * 逻辑说明：当前传输失败时自动尝试下一优先级。发射 degrading 事件。
   */
  private async _degrade(): Promise<void> {
    // 防止重复降级（断开旧传输时触发的 STATUS 事件可能导致递归）
    if (this._isDegrading) {
      logger.warn('正在降级中, 跳过重复降级请求')
      return
    }

    this._isDegrading = true
    try {
      const fromPath = this._currentPath?.description || '未知'
      const nextIndex = this._currentPathIndex + 1

      if (nextIndex >= this._availablePaths.length) {
        this._setState('error')
        const err = new Error('所有连接方式均不可用')
        this.emit('error', err)
        return
      }

      this.emit('degrading', { from: fromPath, to: this._availablePaths[nextIndex].description })
      logger.info(`降级: ${fromPath} → ${this._availablePaths[nextIndex].description}`)

      // 顺序尝试后续每个路径，避免递归 degrade
      for (let i = nextIndex; i < this._availablePaths.length; i++) {
        try {
          this._currentPathIndex = i
          this._currentPath = this._availablePaths[i]
          await this._connectWithPath()
          return
        } catch (err) {
          logger.warn(`${this._availablePaths[i].description} 降级失败: ${(err as Error).message}`)
        }
      }

      // 所有路径均失败
      this._setState('error')
      this.emit('error', new Error('所有连接方式均不可用'))
    } finally {
      this._isDegrading = false
    }
  }

  /**
   * 功能描述：根据路径类型创建对应的 Transport 实例
   *
   * @param type - 路径类型
   * @returns Transport 实例
   */
  private _createTransport(type: ConnectionPath['type']): Transport {
    switch (type) {
      case 'ipv6':
        return new Ipv6DirectTransport()
      case 'p2p':
        return new P2pTransport()
      case 'relay':
        return new RelayPeerTransport(this._relayClient, undefined, this._hostMemberId)
    }
  }

  /**
   * 功能描述：注册 Transport 的事件监听
   *
   * @param transport - Transport 实例
   */
  private _setupTransportEvents(transport: Transport): void {
    transport.on(TRANSPORT_EVENTS.DATA, (data: unknown) => {
      this._trafficBytesReceived += (data as Buffer).length
    })

    transport.on(TRANSPORT_EVENTS.LATENCY, (rtt: unknown) => {
      this.emit('latency', rtt as number)
    })

    transport.on(TRANSPORT_EVENTS.STATUS, (status: unknown) => {
      const s = status as string
      if (s === 'disconnected') {
        // 旧传输被替换时忽略其状态变更
        if (this._currentTransport !== transport) return
        // 房主侧不管理路径选择
        if (this._availablePaths.length === 0) {
          logger.warn(`房主传输断开, 等待重连`)
          return
        }
        // 传输短暂断开，等待 RelayClient 自动重连
        logger.warn(`传输断开, 等待自动重连...`)
        return
      }
      if (s === 'error') {
        if (this._currentTransport !== transport) return
        if (this._availablePaths.length === 0) {
          logger.warn(`房主传输错误, 等待加入者重新连接`)
          return
        }
        // KCP 传输错误时尝试重连，而非直接降级
        if (transport instanceof KcpTransport && this._role === 'guest') {
          this._tryKcpReconnect().catch((err) => {
            logger.error(`KCP 重连失败: ${(err as Error).message}`)
          })
          return
        }
        logger.warn(`Transport 异常: ${s}`)
        if (transport instanceof KcpTransport) {
          logger.info('KCP 传输断开, 跳过 degrade (房主/单路径场景)')
          return
        }
        this._degrade().catch((err) => {
          this.emit('error', err)
        })
      }
    })

    transport.on(TRANSPORT_EVENTS.TRAFFIC, (snapshot: unknown) => {
      const s = snapshot as TrafficSnapshot
      this._trafficBytesSent = s.bytesSent
      this._trafficBytesReceived = s.bytesReceived
      this.emit('traffic', s)
    })

    transport.on(TRANSPORT_EVENTS.ERROR, (err: unknown) => {
      logger.error('Transport 错误', (err as Error).message)
    })
  }

  /**
   * 功能描述：从 NetworkInfo 构建 PeerConnectionInfo
   *
   * @param networkInfo - 对端网络信息
   * @returns 连接信息
   */
  private _buildPeerInfo(networkInfo: NetworkInfo | null): PeerConnectionInfo | null {
    if (!networkInfo) return null

    return {
      peerId: '',
      ipv6Address: networkInfo.ipv6.addresses[0],
      // 不默认设置 ipv6Port，等待房主通过 Signal 提供 IPv6 passive 端口。
      // 若信号未到达则 ipv6Port 为 undefined，IPv6 直连会因端口无效而快速失败，
      // 路径选择器将自动降级到下一优先级路径。
      ipv6Port: undefined,
      publicAddress: networkInfo.ipv4.publicIp
        ? { ip: networkInfo.ipv4.publicIp, port: networkInfo.ipv4.publicPort }
        : undefined
    }
  }

  /**
   * 功能描述：等待房主通过 Signal 发送 P2P 地址
   *
   * 逻辑说明：房主创建 P2P 被动传输后在临时端口监听，
   *           通过 Relay Signal 将该地址通知加入者。
   *           本方法在此等待信号到达并更新 _guestPeerInfo.publicAddress。
   *           超时表示房主未选择 P2P 路径，_guestPeerInfo 保持初始值，
   *           后续由路径选择器决定实际连接方式。
   *
   * @param hostId - 房主成员 ID
   * @param timeoutMs - 等待超时（毫秒）
   * @returns 信号是否到达
   */
  private _waitForP2pSignal(hostId: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this._relayClient.removeListener('signal', onSignal)
        logger.info('P2P 地址信号等待超时, 按路径顺序继续')
        resolve(false)
      }, timeoutMs)

      const onSignal = (data: { from: string; signalData: unknown }): void => {
        if (data.from !== hostId) return
        const sig = data.signalData as Record<string, unknown>
        if (sig?.type === 'p2p-address' && typeof sig.ip === 'string' && typeof sig.port === 'number') {
          clearTimeout(timer)
          this._relayClient.removeListener('signal', onSignal)
          if (this._guestPeerInfo) {
            this._guestPeerInfo.publicAddress = { ip: sig.ip, port: sig.port }
          }
          logger.info('已接收房主 P2P 地址信号')
          resolve(true)
        }
      }

      this._relayClient.on('signal', onSignal)
    })
  }

  /**
   * 功能描述：等待房主通过 Signal 发送 IPv6 监听地址
   *
   * 逻辑说明：房主创建 Ipv6DirectTransport(passive) 后在临时端口监听，
   *           通过 Relay Signal 将该端口通知加入者。
   *           本方法在此等待信号到达并更新 _guestPeerInfo.ipv6Port，
   *           使加入者的 Ipv6DirectTransport(active) 能连到正确的端口。
   *           超时表示房主未选择 IPv6 路径，_guestPeerInfo 保持初始值，
   *           后续由路径选择器决定实际连接方式。
   *
   * @param hostId - 房主成员 ID
   * @param timeoutMs - 等待超时（毫秒）
   * @returns 信号是否到达
   */
  private _waitForIpv6Signal(hostId: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this._relayClient.removeListener('signal', onSignal)
        logger.info('IPv6 地址信号等待超时, 按路径顺序继续')
        resolve(false)
      }, timeoutMs)

      const onSignal = (data: { from: string; signalData: unknown }): void => {
        if (data.from !== hostId) {
          logger.debug(`[SIGNAL] IPv6 wait 忽略非房主信号: from=${data.from}`)
          return
        }
        const sig = data.signalData as Record<string, unknown>
        if (sig?.type === 'ipv6-address' && typeof sig.address === 'string' && typeof sig.port === 'number') {
          clearTimeout(timer)
          this._relayClient.removeListener('signal', onSignal)
          if (this._guestPeerInfo) {
            this._guestPeerInfo.ipv6Address = sig.address
            this._guestPeerInfo.ipv6Port = sig.port
          }
          const v6SigInfo = process.env.NODE_ENV !== 'production' ? ` [${sig.address}]:${sig.port}` : ''
          logger.info(`已接收房主 IPv6 地址信号${v6SigInfo}`)
          resolve(true)
        } else {
          logger.debug(`[SIGNAL] IPv6 wait 收到非目标信号: type=${sig?.type}, from=${data.from}`)
        }
      }

      this._relayClient.on('signal', onSignal)
    })
  }

  /**
   * 功能描述：等待房主通过 Signal 发送 KCP UDP 地址
   *
   * 逻辑说明：房主创建 KcpTransport(passive) 后在 UDP 端口监听，
   *           通过 Relay Signal 将 UDP 地址通知加入者。
   *           本方法在此等待信号到达并更新 _guestPeerInfo.kcpAddress。
   *           超时表示房主未选择 KCP 路径，_guestPeerInfo 保持初始值，
   *           后续由路径选择器决定实际连接方式。
   *
   * @param hostId - 房主成员 ID
   * @param timeoutMs - 等待超时（毫秒）
   * @returns 信号是否到达
   */
  private _waitForKcpSignal(hostId: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this._relayClient.removeListener('signal', onSignal)
        logger.info('KCP 地址信号等待超时, 按路径顺序继续')
        resolve(false)
      }, timeoutMs)

      const onSignal = (data: { from: string; signalData: unknown }): void => {
        if (data.from !== hostId) return
        const sig = data.signalData as Record<string, unknown>
        if (sig?.type === 'kcp-address' && typeof sig.ip === 'string' && typeof sig.port === 'number') {
          clearTimeout(timer)
          this._relayClient.removeListener('signal', onSignal)
          if (this._guestPeerInfo) {
            this._guestPeerInfo.kcpAddress = { ip: sig.ip, port: sig.port }
          }
          logger.info(`已接收房主 KCP 地址信号`)
          resolve(true)
        }
      }

      this._relayClient.on('signal', onSignal)
    })
  }

  /**
   * 功能描述：设置管理器状态并发射事件
   *
   * @param state - 新状态
   */
  private _setState(state: TunnelManagerState): void {
    this._state = state
    this.emit('status', state)
  }
}

// 重新导出事件常量
const RELAY_MESSAGE_TYPES = {
  MEMBER_JOINED: 'member-joined',
  MEMBER_LEFT: 'member-left'
} as const
