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
import { Ipv6DirectTransport, KcpTransport, RelayPeerTransport } from './transports'
import { P2pTransport } from '../p2p'
import { selectPath } from '../connection'
import { NetworkDetector } from '../network/detector'
import { TRANSPORT_EVENTS } from '../transports'
import type { Transport, PeerConnectionInfo } from '../transports'
import type { CreateRoomResult, MemberJoinedData } from './types'
import type { NetworkInfo, ConnectionPath, TrafficSnapshot, TransportStatus, CreateRoomOptions, NatType, MappingBehavior, FilteringBehavior } from '@shared/types'

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
 * 功能描述：从 NetworkInfo 构建 PeerConnectionInfo
 *
 * 逻辑说明：提取对端网络信息中的公网地址、IPv6 地址和本地地址列表，
 *           填充到 PeerConnectionInfo 供 Transport 连接使用。
 *           本地地址列表使用 publicPort 作为端口（同机连接时监听端口与映射端口一致）。
 *
 * @param networkInfo - 对端网络信息
 * @returns 连接信息，null 表示无可用的网络信息
 */
export function buildPeerInfo(networkInfo: NetworkInfo | null): PeerConnectionInfo | null {
  if (!networkInfo) return null

  return {
    peerId: '',
    ipv6Address: networkInfo.ipv6.addresses[0],
    ipv6Port: undefined,
    publicAddress: networkInfo.ipv4.publicIp
      ? { ip: networkInfo.ipv4.publicIp, port: networkInfo.ipv4.publicPort }
      : undefined,
    localAddresses: networkInfo.ipv4.localAddresses.length > 0
      ? networkInfo.ipv4.localAddresses.map(ip => ({
          ip,
          port: networkInfo.ipv4.publicPort
        }))
      : []
  }
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
  private _clientTransports: Map<string, Transport> = new Map()
  private _clientTunnels: Map<string, LocalTunnelClient> = new Map()
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
  private _serverNetwork: NetworkInfo | null = null
  private _clientNetwork: NetworkInfo | null = null
  /** 房主侧各成员的 KCP 传输实例（用于外部探针触发） */
  private _clientKcpTransports: Map<string, KcpTransport> = new Map()
  /** 服务端各成员的网络信息（用于 kcp-port 信号中查找客户端公网 IP） */
  private _clientNetworkInfos: Map<string, NetworkInfo> = new Map()
  private _role: 'server' | 'client' | null = null
  private _config: TunnelManagerConfig
  private _state: TunnelManagerState = 'idle'
  private _gameId: string = ''
  private _gameName: string = ''
  private _gamePort: number = 0
  private _clientPeerInfo: PeerConnectionInfo | null = null
  /** 房主成员 ID（加入者侧使用，用于发送重置信号） */
  private _serverMemberId: string = ''
  private _networkDetector: NetworkDetector = new NetworkDetector()
  private _trafficBytesSent: number = 0
  private _trafficBytesReceived: number = 0

  constructor(config?: Partial<TunnelManagerConfig>) {
    super()
    this._config = { ...DEFAULT_MANAGER_CONFIG, ...config }
    this._relayClient = new RelayClient({ relayUrl: this._config.relayUrl })

    this._relayClient.on('connected', () => {
      logger.info('[TunnelManager] Relay connection established')
    })

    this._relayClient.on('disconnected', () => {
      logger.warn('[TunnelManager] Relay connection disconnected')
    })

    this._relayClient.on('error', (err: Error) => {
      logger.error(`[TunnelManager] Relay client error: ${err.message}`)
      this.emit('error', err)
    })

    // 监听游戏客户端连接状态信令：
    // close-game-conn — 加入者全部客户端断开，房主立即关闭游戏连接
    this._relayClient.on('signal', (data: { from: string; signalData: unknown }) => {
      if (this._role !== 'server') return
      const sig = data.signalData as Record<string, unknown>
      if (sig?.type === 'close-game-conn') {
        const client = this._clientTunnels.get(data.from)
        if (client) {
          logger.debug(`Received close-game-conn signal, closing game connection (member ${data.from})`)
          client.closeConnection()
        }
      }
      if (sig?.type === 'kcp-port' && typeof sig.kcpPort === 'number') {
        const kcp = this._clientKcpTransports.get(data.from)
        if (kcp) {
          // 优先使用信号中携带的公网 IP（加入者 STUN 结果），
          // 降级到 member-joined 时的 networkInfo
          const clientPublicIp = (sig.publicIp as string) || this._clientNetworkInfos.get(data.from)?.ipv4.publicIp
          logger.debug(`[KCP] Received kcp-port signal: member=${data.from}, kcpPort=${sig.kcpPort}, publicIp=${clientPublicIp}, localPort=${kcp.localPort}`)
          if (clientPublicIp) {
            logger.info(`KCP external probe triggered: member ${data.from} public ${clientPublicIp}:${sig.kcpPort}`)
            kcp.addExternalTarget(clientPublicIp, sig.kcpPort)
          } else {
            logger.warn(`KCP received kcp-port but could not get member ${data.from}'s public IP`)
          }
        }
      }
    })

    this._relayClient.on('member-joined', (data: MemberJoinedData) => {
      logger.info(`[TunnelManager] Member joined: ${data.memberName} (${data.memberId})`)

      // 房主侧：根据网络检测结果选择最优路径，为加入者创建传输通道
      if (this._role === 'server') {
        this._setupServerTransport(data.memberId, data.networkInfo).catch((err) => {
          logger.error(`Failed to establish transport for member ${data.memberId}: ${(err as Error).message}`)
        })
      }

      this.emit(RELAY_MESSAGE_TYPES.MEMBER_JOINED, {
        id: data.memberId,
        name: data.memberName,
        transport: undefined
      })
    })

    this._relayClient.on('member-left', (data: { memberId: string }) => {
      logger.info(`[TunnelManager] Member left: ${data.memberId}`)

      // 房主侧：清理该成员的资源
      if (this._role === 'server') {
        this._cleanupClientTransport(data.memberId).catch((err) => {
          logger.error(`Failed to cleanup resources for member ${data.memberId}: ${(err as Error).message}`)
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
      if (this._role === 'client' && this._serverMemberId) {
        logger.info('All game clients disconnected, notifying server to close game connection')
        this._relayClient.sendSignal(this._serverMemberId, { type: 'close-game-conn' }).catch((err: Error) => {
          logger.error(`Failed to send close-game-conn signal: ${err.message}`)
        })
      }
    })

    // 游戏客户端重连 → 通知房主销毁旧连接重建，
    // 避免旧游戏响应数据通过中继污染新连接
    this._localServer.on('client-reconnected', () => {
      if (this._role === 'client') {
        if (this._currentTransport instanceof KcpTransport) {
          this._currentTransport.sendControl('reset')
          logger.debug('KCP in-band reset signal sent')
        } else if (this._currentTransport && this._currentTransport.type === 'relay') {
          this._relayClient.sendData(Buffer.alloc(0))
          logger.debug('Relay reset signal sent')
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
    this._role = 'server'
    this._gameId = options.gameId
    this._gameName = options.gameName
    this._gamePort = options.gamePort

    // 1. 网络检测
    this._setState('connecting-relay')
    this._serverNetwork = await this._networkDetector.detect()

    // 1.5 应用自定义中继地址（如有）
    if (options.relayUrl && options.relayUrl !== this._config.relayUrl) {
      this.setRelayUrl(options.relayUrl)
    }

    // 2. 连接 Relay（房主端模式：二进制帧包含 sourceMemberId）
    await this._relayClient.connect()
    this._relayClient.setServerMode()

    // 3. 创建房间
    const roomResult = await this._relayClient.createRoom({
      gameId: this._gameId,
      gameName: this._gameName,
      gamePort: this._gamePort,
      memberName: this._config.memberName,
      networkInfo: this._serverNetwork
    })

    this._setState('connected')
    logger.info(`[TunnelManager] Room created: ${roomResult.roomCode}`)

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
    this._role = 'client'
    this._setState('connecting-relay')

    // 1. 网络检测
    this._clientNetwork = await this._networkDetector.detect()

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
      logger.debug(`[Signal] Signal received: from ${data.from}, type: ${sigType}`)
      earlySignals.push(data)
    }
    this._relayClient.on('signal', onEarlySignal)

    let serverId = ''

    try {
      const joinResult = await this._relayClient.joinRoom(roomCode, {
        memberName: this._config.memberName,
        networkInfo: this._clientNetwork
      })

      serverId = joinResult.serverId
      this._serverMemberId = serverId
      this._gameId = ''
      this._gamePort = joinResult.gamePort
      this._serverNetwork = joinResult.serverNetworkInfo || null
      this._clientPeerInfo = this._buildPeerInfo(joinResult.serverNetworkInfo || this._serverNetwork)

      /**
       * 功能描述：将 earlySignals 中来自房主的地址信号应用到 _clientPeerInfo
       *
       * 逻辑说明：遍历缓冲队列，更新 P2P/IPv6/KCP 地址。幂等操作，
       *           可在不同阶段多次调用（首次回放 joinRoom 期间到达的信号，
       *           二次回放 _waitFor* 超时后到达的信号）。
       */
      const applyAddressSignals = (): void => {
        for (const sig of earlySignals) {
          if (sig.from !== serverId) continue
          const data = sig.signalData as Record<string, unknown>
          if (data?.type === 'p2p-address' && typeof data.port === 'number' && this._clientPeerInfo) {
            if (data.ip && typeof data.ip === 'string') {
              this._clientPeerInfo.publicAddress = { ip: data.ip, port: data.port }
            }
            if (Array.isArray(data.localIps) && data.localIps.length > 0) {
              this._clientPeerInfo.localAddresses = data.localIps.map((ip: string) => ({
                ip, port: data.port as number
              }))
            }
            if (typeof data.natType === 'string' && typeof data.mappingBehavior === 'string' && this._serverNetwork) {
              this._serverNetwork.ipv4.natType = data.natType as NatType
              this._serverNetwork.ipv4.mappingBehavior = data.mappingBehavior as MappingBehavior
              if (typeof data.filteringBehavior === 'string') {
                this._serverNetwork.ipv4.filteringBehavior = data.filteringBehavior as FilteringBehavior
              }
            }
          }
          if (data?.type === 'ipv6-address' && typeof data.address === 'string' && typeof data.port === 'number' && this._clientPeerInfo) {
            this._clientPeerInfo.ipv6Address = data.address
            this._clientPeerInfo.ipv6Port = data.port
          }
          if (data?.type === 'kcp-address' && typeof data.ip === 'string' && typeof data.port === 'number' && this._clientPeerInfo) {
            this._clientPeerInfo.kcpAddress = { ip: data.ip, port: data.port }
          }
        }
      }

      // 首次回放：joinRoom 期间到达的信号
      applyAddressSignals()

      // 3.5 根据自身网络能力按需等待信号（IPv6/P2P 不可用时无需等待）
      // IPv6 条件与 path-selector 一致: 双方 hasPublicV6 均 true 时路径才会包含 IPv6
      const signalWaits: Promise<void>[] = []
      const serverV6 = joinResult.serverNetworkInfo?.ipv6 ?? this._serverNetwork?.ipv6
      const clientV6 = this._clientNetwork!.ipv6
      if (serverV6?.hasPublicV6 && clientV6.hasPublicV6) {
        signalWaits.push(this._waitForIpv6Signal(joinResult.serverId, 3000).then(() => {}))
      }
      if (this._clientNetwork!.ipv4.publicIp !== '') {
        signalWaits.push(this._waitForP2pSignal(joinResult.serverId, 1500).then(() => {}))
        signalWaits.push(this._waitForKcpSignal(joinResult.serverId, 1500).then(() => {}))
      }
      logger.debug(`[Signal] Waiting for signals — IPv6: ${!!(serverV6?.hasPublicV6 && clientV6.hasPublicV6)}, P2P/KCP: ${this._clientNetwork!.ipv4.publicIp !== ''}`)
      await Promise.all(signalWaits)
      logger.info('Address signal collection complete, starting path selection')

      // 二次回放：_waitFor* 超时后才到达的信号（如 STUN > 1500ms 的 kcp-address）
      applyAddressSignals()
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
        logger.debug(`Game client connected, transport: ${this._currentTransport.type}`)
      }
    })

    // 6. 启动本地隧道（传入自定义端口或自动选择）
    const allocPort = await this._localServer.start(localPort || 0)

    this._setState('connected')
    logger.info(`[TunnelManager] Joined room ${roomCode}, local port: ${allocPort}`)

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
    for (const [, transport] of this._clientTransports) {
      try { await transport.disconnect() } catch { /* ignore */ }
    }
    this._clientTransports.clear()

    // 断开所有 Guest 本地客户端（房主侧）
    for (const [, client] of this._clientTunnels) {
      try { await client.disconnect() } catch { /* ignore */ }
    }
    this._clientTunnels.clear()

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
    this._clientKcpTransports.clear()
    this._clientNetworkInfos.clear()

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
    this._serverMemberId = ''
    this._trafficBytesSent = 0
    this._trafficBytesReceived = 0
    this._serverNetwork = null
    this._clientNetwork = null
    this._clientPeerInfo = null
    this._kcpReconnectAttempts = 0
    this._setState('idle')
    this.emit('disconnected')
    logger.info('[TunnelManager] Left room')
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
      localPort: this._role === 'server' ? this._gamePort : this._localServer.localPort,
      clientCount: this._role === 'server' ? this._clientTunnels.size : this._localServer.clientCount,
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

      logger.debug(`P2P transport timeout, closing server (member ${memberId})`)

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
   * @param clientNetwork - 加入者的网络检测结果
   */
  private async _setupServerTransport(
    memberId: string,
    clientNetwork: NetworkInfo
  ): Promise<void> {
    if (this._clientTransports.has(memberId)) {
      logger.info(`Member ${memberId} already has a transport, skipping`)
      return
    }

    const paths = selectPath(this._serverNetwork, clientNetwork)
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

        const pubAddr = this._serverNetwork!.ipv4
        const serverLocalIps = pubAddr.localAddresses || []
        if ((pubAddr.publicIp || serverLocalIps.length > 0) && p2p.localPort) {
          this._relayClient.sendSignal(memberId, {
            type: 'p2p-address',
            ip: pubAddr.publicIp,
            port: p2p.localPort,
            localIps: serverLocalIps.length > 0 ? serverLocalIps : undefined,
            natType: pubAddr.natType,
            mappingBehavior: pubAddr.mappingBehavior,
            filteringBehavior: pubAddr.filteringBehavior,
            publicIp: pubAddr.publicIp
          }).catch((err: Error) => {
            logger.error(`Failed to send P2P address signal: ${err.message}`)
          })
        }

        transport = p2p
        logger.info(`[P2P] Channel opened — member ${memberId} listening on 0.0.0.0:${p2p.localPort}`)
        this._startP2pTimeout(memberId, p2p, 60000)
      }

      if (hasUdp) {
        const kcp = new KcpTransport()
        // 双方同时主动打洞 — 参考 EasyTier/frp 的双向主动连接
        // 房主也主动向加入者发送探针，提前在 NAT 上建立端口映射
        kcp.setRole('active')
        kcp.connect({
          peerId: memberId,
          publicAddress: clientNetwork.ipv4.publicIp
            ? { ip: clientNetwork.ipv4.publicIp, port: clientNetwork.ipv4.publicPort }
            : undefined,
          localAddresses: clientNetwork.ipv4.localAddresses.length > 0
            ? clientNetwork.ipv4.localAddresses.map(ip => ({ ip, port: clientNetwork.ipv4.publicPort }))
            : []
        }).catch((err: Error) => {
          logger.debug(`KCP host active probe ended (member ${memberId}): ${err.message}`)
        }) // 不 await — 后台探测，立即注册信号处理器

        // 不 await connect，此处 kcp.connect 正在后台执行（UDP 绑定 + STUN），
        // 注册 public-addr 监听在 STUN 完成后发送 KCP 地址信号
        const sendKcpAddress = (fromStun: boolean = false): void => {
          const ip = kcp.publicIp || this._serverNetwork?.ipv4.publicIp
          const port = kcp.publicPort || kcp.localPort
          if (ip && port) {
            logger.debug(`[KCP] Sending kcp-address signal: member=${memberId}, ip=${ip}, port=${port}, source=${fromStun ? 'STUN' : 'fallback'}`)
            this._relayClient.sendSignal(memberId, {
              type: 'kcp-address',
              ip,
              port
            }).catch((err: Error) => {
              logger.error(`Failed to send KCP address signal: ${err.message}`)
            })
          }
        }
        // STUN 完成后发送（优先），未完成时用本地地址兜底
        kcp.on('public-addr', () => sendKcpAddress(true))
        // 兜底：STUN 超时/失败时 publicPort 被设为 localPort，setTimeout 确保在其之后执行
        setTimeout(() => sendKcpAddress(false), 3500)

        // 注册 KCP 传输实例，使 kcp-port 信号处理器能触发外部探针
        this._clientKcpTransports.set(memberId, kcp)
        this._clientNetworkInfos.set(memberId, clientNetwork)

        if (!hasTcp) {
          transport = kcp
          logger.info(`[KCP] Channel opened — member ${memberId} listening on 0.0.0.0:${kcp.localPort}`)
          const kcpTimer = setTimeout(() => {
            if (kcp.status !== 'connected') {
              logger.warn(`Member ${memberId} KCP connection timeout`)
              kcp.disconnect().catch(() => {})
              this._clientTransports.delete(memberId)
            }
          }, 30000)
          kcp.on('status', function onKcpStatus(status: TransportStatus) {
            if (status === 'connected' || status === 'error') {
              clearTimeout(kcpTimer)
              kcp.removeListener('status', onKcpStatus)
            }
          })
        } else {
          logger.info(`[KCP] Backup channel opened — member ${memberId} listening on 0.0.0.0:${kcp.localPort}`)
          const tcpTransport = transport!
          kcp.on('status', (status: TransportStatus) => {
            if (status !== 'connected') return
            const cl = this._clientTunnels.get(memberId)
            const cur = this._clientTransports.get(memberId)
            if (!cl || cur !== tcpTransport) return

            this._clearP2pTimeout(memberId)
            logger.info(`Member ${memberId} switched to KCP transport (TCP fallback)`)
            cl.setTransport(kcp)
            const pendingCount = kcp.drainPendingData((data: Buffer) => {
              kcp.emit(TRANSPORT_EVENTS.DATA, data)
            })
            if (pendingCount > 0) logger.debug(`KCP switch: replaying ${pendingCount} buffered data packets to LocalClient`)
            this._clientTransports.set(memberId, kcp)
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
      logger.info(`Setting up transport for member ${memberId} (IPv6 primary, P2P backup)`)

      const ipv6Transport = new Ipv6DirectTransport()
      ipv6Transport.setRole('passive')
      await ipv6Transport.connect({ peerId: memberId })

      const v6Addr = this._serverNetwork!.ipv6.addresses[0]
      if (v6Addr && ipv6Transport.localPort) {
        this._relayClient.sendSignal(memberId, {
          type: 'ipv6-address',
          address: v6Addr,
          port: ipv6Transport.localPort
        }).catch((err: Error) => {
          logger.error(`Failed to send IPv6 address signal: ${err.message}`)
        })
      }

      logger.info(`[IPv6] Channel opened — member ${memberId} listening on :::${ipv6Transport.localPort}`)
      transport = ipv6Transport

      const p2p = new P2pTransport({ connectTimeout: 30000 })
      p2p.setRole('passive')
      await p2p.connect({ peerId: memberId })

      const pubAddr = this._serverNetwork!.ipv4
      const serverLocalIps = pubAddr.localAddresses || []
      if ((pubAddr.publicIp || serverLocalIps.length > 0) && p2p.localPort) {
        this._relayClient.sendSignal(memberId, {
          type: 'p2p-address',
          ip: pubAddr.publicIp,
          port: p2p.localPort,
          localIps: serverLocalIps.length > 0 ? serverLocalIps : undefined,
          natType: pubAddr.natType,
          mappingBehavior: pubAddr.mappingBehavior,
          filteringBehavior: pubAddr.filteringBehavior,
          publicIp: pubAddr.publicIp
        }).catch((err: Error) => {
          logger.error(`Failed to send P2P backup address signal: ${err.message}`)
        })
      }

      p2pBackup = p2p
      this._p2pBackups.set(memberId, p2p)
      logger.info(`[P2P] Backup channel opened — member ${memberId} listening on 0.0.0.0:${p2p.localPort} (30s timeout)`)
      this._startP2pTimeout(memberId, p2p, 30000)
    } else {
      logger.info(`Setting up transport for member ${memberId} (relay forwarding)`)
      transport = new RelayPeerTransport(this._relayClient, memberId)
      await transport.connect({ peerId: memberId })
    }

    const client = new LocalTunnelClient()
    client.on('error', (err) => {
      logger.error(`LocalTunnelClient error: ${(err as Error).message}`)
    })
    client.setTransport(transport)
    await client.connect(this._gamePort, '127.0.0.1')

    this._clientTransports.set(memberId, transport)
    this._clientTunnels.set(memberId, client)
    this._setupTransportEvents(transport)
    this.emit('transport-changed', transport.type)
    logger.info(`Member ${memberId} local proxy connected to 127.0.0.1:${this._gamePort}`)

    // 主 P2P 连接成功时清除超时定时器
    if (transport instanceof P2pTransport) {
      transport.on('status', (status: TransportStatus) => {
        if (status === 'connected') this._clearP2pTimeout(memberId)
      })
    }

    if (p2pBackup) {
      const onP2pConnected = (status: TransportStatus) => {
        if (status !== 'connected') return
        const cl = this._clientTunnels.get(memberId)
        const cur = this._clientTransports.get(memberId)
        if (!cl || cur !== transport) return

        this._clearP2pTimeout(memberId)
        logger.info(`Member ${memberId} switched to P2P transport (IPv6 backup)`)
        cl.setTransport(p2pBackup!)
        this._clientTransports.set(memberId, p2pBackup!)
        this._p2pBackups.delete(memberId)
        this._setupTransportEvents(p2pBackup!)
        transport.disconnect().catch(() => {})
        this.emit('transport-changed', p2pBackup!.type)
      }
      p2pBackup.on('status', onP2pConnected)
    }

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
      const cl = this._clientTunnels.get(memberId)
      if (!cl) return

      // 已切换到中继，跳过
      if (this._clientTransports.get(memberId) === relayFallback) return

      logger.info(`Member ${memberId} switched to relay transport (primary transport degraded)`)
      relayFallback.removeListener(TRANSPORT_EVENTS.DATA, onRelayData)
      this._relayFallbacks.delete(memberId)

      cl.setTransport(relayFallback)
      this._clientTransports.set(memberId, relayFallback)
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
  private async _cleanupClientTransport(memberId: string): Promise<void> {
    this._clearP2pTimeout(memberId)
    const client = this._clientTunnels.get(memberId)
    if (client) {
      try { await client.disconnect() } catch { /* ignore */ }
      this._clientTunnels.delete(memberId)
    }

    const transport = this._clientTransports.get(memberId)
    if (transport) {
      try { await transport.disconnect() } catch { /* ignore */ }
      this._clientTransports.delete(memberId)
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

    this._clientKcpTransports.delete(memberId)
    this._clientNetworkInfos.delete(memberId)

    logger.info(`Transport resources cleaned up for member ${memberId}`)
  }

  /**
   * 功能描述：路径选择并建立连接
   *
   * 逻辑说明：使用 PathSelector 获取有序路径列表，按序尝试连接。
   */
  private async _selectAndConnect(): Promise<void> {
    this._setState('connecting-transport')
    this._availablePaths = selectPath(this._serverNetwork, this._clientNetwork)

    // 日志：NAT 类型与路径选择摘要
    const serverNat = this._serverNetwork?.ipv4.natType || 'unknown'
    const clientNat = this._clientNetwork?.ipv4.natType || 'unknown'
    const serverMapping = this._serverNetwork?.ipv4.mappingBehavior || 'unknown'
    const clientMapping = this._clientNetwork?.ipv4.mappingBehavior || 'unknown'
    const descriptions = this._availablePaths.map(p => p.description).join(' → ')
    logger.info(`Path selection: [${descriptions}] (server NAT: ${serverNat}/${serverMapping}, client NAT: ${clientNat}/${clientMapping})`)

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
          logger.warn(`${this._availablePaths[i].description} connection failed: ${(err as Error).message}, falling back to ${nextDesc}`)
        } else {
          this._setState('error')
          const finalErr = new Error('All connection methods unavailable')
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
    logger.info(`Attempting connection: ${this._currentPath!.description}`)

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
        logger.debug(`KCP replaying ${drained} buffered data packets to LocalServer`)
      }
    }

    this._setupTransportEvents(transport)

    this._setState('connected')
    this.emit('transport-changed', transport.type)
    logger.info(`${this._currentPath!.description} connection successful`)
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
        transport.setRole(this._role === 'server' ? 'passive' : 'active')
      }
      await transport.connect(this._clientPeerInfo || { peerId: '' })
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
        p2p.setRole(this._role === 'server' ? 'passive' : 'active')
        pending.push({
          method,
          transport: p2p,
          promise: p2p.connect(this._clientPeerInfo || { peerId: '' }).then(() => p2p)
        })
      } else {
        const kcp = this._createKcpWithSignals()
        pending.push({
          method,
          transport: kcp,
          promise: kcp.connect(this._clientPeerInfo || { peerId: '' }).then(() => {
            // KCP 成功 → 创建中继备用
            if (this._role === 'client') {
              this._addClientRelayFallback(kcp).catch((err: Error) => {
                logger.warn(`Failed to create relay fallback: ${err.message}`)
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

      logger.info(`P2P parallel race: ${pending.filter(p => p.transport === winner)[0]?.method || 'unknown'} won`)
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
      throw lastError || new Error('P2P connection failed')
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
      p2p.setRole(this._role === 'server' ? 'passive' : 'active')
      await p2p.connect(this._clientPeerInfo || { peerId: '' })
      return p2p
    }

    const kcp = this._createKcpWithSignals()
    await kcp.connect(this._clientPeerInfo || { peerId: '' })

    // KCP 成功 → 创建中继备用（加入者侧）
    if (this._role === 'client') {
      this._addClientRelayFallback(kcp).catch((err: Error) => {
        logger.warn(`Failed to create relay fallback: ${err.message}`)
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
    kcp.setRole(this._role === 'server' ? 'passive' : 'active')

    if (this._role === 'client' && this._serverMemberId) {
      // Guest 侧：绑定后立即发送 kcp-port（本地端口），
      // 房主尽早开始探测建立 NAT 映射；STUN 公网地址发现后更新
      kcp.on('bound', (localPort: number) => {
        const publicIp = this._clientNetwork?.ipv4.publicIp || ''
        logger.debug(`[KCP] Sending kcp-port signal: localPort=${localPort}, publicIp=${publicIp}`)
        this._relayClient.sendSignal(this._serverMemberId, {
          type: 'kcp-port',
          kcpPort: localPort,
          publicIp
        }).catch((err: Error) => {
          logger.error(`Failed to send KCP port signal: ${err.message}`)
        })
      })
      kcp.on('public-addr', (pubPort: number, pubIp: string | null) => {
        const publicIp = pubIp || this._clientNetwork?.ipv4.publicIp || ''
        logger.debug(`[KCP] Sending kcp-port UPDATE signal: pubPort=${pubPort}, publicIp=${publicIp}`)
        this._relayClient.sendSignal(this._serverMemberId, {
          type: 'kcp-port',
          kcpPort: pubPort,
          publicIp
        }).catch((err: Error) => {
          logger.error(`Failed to send KCP port update signal: ${err.message}`)
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
  private async _addClientRelayFallback(primaryTransport: Transport): Promise<void> {
    if (!this._serverMemberId) return

    const relayFallback = new RelayPeerTransport(this._relayClient, undefined, this._serverMemberId)
    await relayFallback.connect({ peerId: this._serverMemberId })

    const onRelayData = (data: Buffer): void => {
      // 已切换到中继，跳过
      if (this._currentTransport === relayFallback) return

      // 主传输仍连接，忽略中继数据
      if (primaryTransport.status === 'connected') return

      logger.info('Client switched to relay transport (KCP disconnected)')
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
    logger.debug('Relay fallback transport established')
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
      logger.warn('KCP reconnect reached max attempts, switching to degrade')
      this._kcpReconnectAttempts = 0
      this._degrade().catch((err) => {
        this.emit('error', err)
      })
      return
    }

    const delay = KCP_RECONNECT_BASE_DELAY * Math.pow(2, this._kcpReconnectAttempts)
    this._kcpReconnectAttempts++
    logger.info(`KCP reconnect attempt ${this._kcpReconnectAttempts} (waiting ${delay}ms)`)

    await new Promise(resolve => setTimeout(resolve, delay))

    try {
      const oldTransport = this._currentTransport

      const kcp = this._createKcpWithSignals()
      await kcp.connect(this._clientPeerInfo || { peerId: '' })

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
        logger.debug(`KCP reconnect: replaying ${drained} buffered data packets to LocalServer`)
      }

      this._setupTransportEvents(kcp)
      this._kcpReconnectAttempts = 0
      logger.info('KCP reconnection successful')
      this.emit('transport-changed', 'p2p')
    } catch (err) {
      logger.warn(`KCP reconnection failed: ${(err as Error).message}`)
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
      logger.warn('Already degrading, skipping duplicate degrade request')
      return
    }

    this._isDegrading = true
    try {
      const fromPath = this._currentPath?.description || 'unknown'
      const nextIndex = this._currentPathIndex + 1

      if (nextIndex >= this._availablePaths.length) {
        this._setState('error')
        const err = new Error('All connection methods unavailable')
        this.emit('error', err)
        return
      }

      this.emit('degrading', { from: fromPath, to: this._availablePaths[nextIndex].description })
      logger.info(`Degrading: ${fromPath} → ${this._availablePaths[nextIndex].description}`)

      // 顺序尝试后续每个路径，避免递归 degrade
      for (let i = nextIndex; i < this._availablePaths.length; i++) {
        try {
          this._currentPathIndex = i
          this._currentPath = this._availablePaths[i]
          await this._connectWithPath()
          return
        } catch (err) {
          logger.warn(`${this._availablePaths[i].description} degrade failed: ${(err as Error).message}`)
        }
      }

      // 所有路径均失败
      this._setState('error')
      this.emit('error', new Error('All connection methods unavailable'))
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
        return new RelayPeerTransport(this._relayClient, undefined, this._serverMemberId)
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
      logger.debug(`Latency: ${rtt}ms`)
      this.emit('latency', rtt as number)
    })

    transport.on(TRANSPORT_EVENTS.STATUS, (status: unknown) => {
      const s = status as string
      if (s === 'disconnected') {
        // 旧传输被替换时忽略其状态变更
        if (this._currentTransport !== transport) return
        // 房主侧不管理路径选择
        if (this._availablePaths.length === 0) {
          logger.warn(`Server transport disconnected, waiting for reconnect`)
          return
        }
        // 传输短暂断开，等待 RelayClient 自动重连
        logger.warn(`Transport disconnected, waiting for auto-reconnect...`)
        return
      }
      if (s === 'error') {
        if (this._currentTransport !== transport) return
        if (this._availablePaths.length === 0) {
          logger.warn(`Server transport error, waiting for client to reconnect`)
          return
        }
        // KCP 传输错误时尝试重连，而非直接降级
        if (transport instanceof KcpTransport && this._role === 'client') {
          this._tryKcpReconnect().catch((err) => {
            logger.error(`KCP reconnection failed: ${(err as Error).message}`)
          })
          return
        }
        logger.warn(`Transport error: ${s}`)
        if (transport instanceof KcpTransport) {
          logger.info('KCP transport disconnected, skipping degrade (server/single-path scenario)')
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
      logger.error(`Transport error: ${(err as Error).message}`)
    })
  }

  /**
   * 功能描述：从 NetworkInfo 构建 PeerConnectionInfo
   *
   * @param networkInfo - 对端网络信息
   * @returns 连接信息
   */
  private _buildPeerInfo(networkInfo: NetworkInfo | null): PeerConnectionInfo | null {
    return buildPeerInfo(networkInfo)
  }

  /**
   * 功能描述：等待房主通过 Signal 发送 P2P 地址
   *
   * 逻辑说明：房主创建 P2P 被动传输后在临时端口监听，
   *           通过 Relay Signal 将该地址通知加入者。
   *           本方法在此等待信号到达并更新 _clientPeerInfo.publicAddress。
   *           超时表示房主未选择 P2P 路径，_clientPeerInfo 保持初始值，
   *           后续由路径选择器决定实际连接方式。
   *
   * @param serverId - 房主成员 ID
   * @param timeoutMs - 等待超时（毫秒）
   * @returns 信号是否到达
   */
  private _waitForP2pSignal(serverId: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this._relayClient.removeListener('signal', onSignal)
        logger.info('P2P address signal wait timed out, continuing with path ordering')
        resolve(false)
      }, timeoutMs)

      const onSignal = (data: { from: string; signalData: unknown }): void => {
        if (data.from !== serverId) return
        const sig = data.signalData as Record<string, unknown>
        if (sig?.type === 'p2p-address' && typeof sig.port === 'number') {
          clearTimeout(timer)
          this._relayClient.removeListener('signal', onSignal)
          if (this._clientPeerInfo) {
            if (sig.ip && typeof sig.ip === 'string') {
              this._clientPeerInfo.publicAddress = { ip: sig.ip, port: sig.port }
            }
            if (Array.isArray(sig.localIps) && sig.localIps.length > 0) {
              this._clientPeerInfo.localAddresses = sig.localIps.map((ip: string) => ({
                ip, port: sig.port as number
              }))
            }
            // 用信号中携带的真实 NAT 信息覆盖 joinResult 中的 unknown 值
            if (typeof sig.natType === 'string' && typeof sig.mappingBehavior === 'string' && this._serverNetwork) {
              this._serverNetwork.ipv4.natType = sig.natType as NatType
              this._serverNetwork.ipv4.mappingBehavior = sig.mappingBehavior as MappingBehavior
              if (typeof sig.filteringBehavior === 'string') {
                this._serverNetwork.ipv4.filteringBehavior = sig.filteringBehavior as FilteringBehavior
              }
              logger.info(`Server NAT info applied from signal: ${sig.natType}/${sig.mappingBehavior}`)
            }
          }
          logger.info('Server P2P address signal received')
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
   *           本方法在此等待信号到达并更新 _clientPeerInfo.ipv6Port，
   *           使加入者的 Ipv6DirectTransport(active) 能连到正确的端口。
   *           超时表示房主未选择 IPv6 路径，_clientPeerInfo 保持初始值，
   *           后续由路径选择器决定实际连接方式。
   *
   * @param serverId - 房主成员 ID
   * @param timeoutMs - 等待超时（毫秒）
   * @returns 信号是否到达
   */
  private _waitForIpv6Signal(serverId: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this._relayClient.removeListener('signal', onSignal)
        logger.info('IPv6 address signal wait timed out, continuing with path ordering')
        resolve(false)
      }, timeoutMs)

      const onSignal = (data: { from: string; signalData: unknown }): void => {
        if (data.from !== serverId) {
          logger.debug(`[Signal] IPv6 wait ignored non-server signal: from ${data.from}`)
          return
        }
        const sig = data.signalData as Record<string, unknown>
        if (sig?.type === 'ipv6-address' && typeof sig.address === 'string' && typeof sig.port === 'number') {
          clearTimeout(timer)
          this._relayClient.removeListener('signal', onSignal)
          if (this._clientPeerInfo) {
            this._clientPeerInfo.ipv6Address = sig.address
            this._clientPeerInfo.ipv6Port = sig.port
          }
          const v6SigInfo = process.env.NODE_ENV !== 'production' ? ` [${sig.address}]:${sig.port}` : ''
          logger.info(`Server IPv6 address signal received${v6SigInfo}`)
          resolve(true)
        } else {
          logger.debug(`[Signal] IPv6 wait received non-target signal: type: ${sig?.type}, from ${data.from}`)
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
   *           本方法在此等待信号到达并更新 _clientPeerInfo.kcpAddress。
   *           超时表示房主未选择 KCP 路径，_clientPeerInfo 保持初始值，
   *           后续由路径选择器决定实际连接方式。
   *
   * @param serverId - 房主成员 ID
   * @param timeoutMs - 等待超时（毫秒）
   * @returns 信号是否到达
   */
  private _waitForKcpSignal(serverId: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this._relayClient.removeListener('signal', onSignal)
        logger.info('KCP address signal wait timed out, continuing with path ordering')
        resolve(false)
      }, timeoutMs)

      const onSignal = (data: { from: string; signalData: unknown }): void => {
        if (data.from !== serverId) return
        const sig = data.signalData as Record<string, unknown>
        if (sig?.type === 'kcp-address' && typeof sig.ip === 'string' && typeof sig.port === 'number') {
          clearTimeout(timer)
          this._relayClient.removeListener('signal', onSignal)
          if (this._clientPeerInfo) {
            this._clientPeerInfo.kcpAddress = { ip: sig.ip, port: sig.port }
          }
          logger.info(`Server KCP address signal received`)
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
