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
  relayUrl: 'ws://127.0.0.1:9800',
  memberName: 'Player',
  connectTimeout: 30000
}

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
  private _guestTransports: Map<string, Transport> = new Map()
  private _guestClients: Map<string, LocalTunnelClient> = new Map()
  /** P2P 备选传输（IPv6 最优时额外创建的被动监听，用于降级切换） */
  private _p2pBackups: Map<string, P2pTransport> = new Map()
  /** Relay 备选传输（非 Relay 路径时创建，用于加入者降级到中继后的数据通道） */
  private _relayFallbacks: Map<string, RelayPeerTransport> = new Map()
  private _localServer: LocalTunnelServer = new LocalTunnelServer()
  private _currentTransport: Transport | null = null
  private _currentPath: ConnectionPath | null = null
  private _availablePaths: ConnectionPath[] = []
  private _currentPathIndex: number = -1
  private _isDegrading: boolean = false
  private _hostNetwork: NetworkInfo | null = null
  private _guestNetwork: NetworkInfo | null = null
  private _role: 'host' | 'guest' | null = null
  private _config: TunnelManagerConfig
  private _state: TunnelManagerState = 'idle'
  private _gameId: string = ''
  private _gameName: string = ''
  private _gamePort: number = 0
  private _guestPeerInfo: PeerConnectionInfo | null = null
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
  }

  get state(): TunnelManagerState { return this._state }

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
   * @throws 网络检测失败、房间不存在、所有连接方式均不可用
   */
  async joinRoom(roomCode: string): Promise<void> {
    this._role = 'guest'
    this._setState('connecting-relay')

    // 1. 网络检测
    this._guestNetwork = await this._networkDetector.detect()

    // 2. 连接 Relay
    await this._relayClient.connect()

    // 3. 注册信号预收集器（在 joinRoom 之前，防止房主 Signal 在监听器注册前到达）
    const earlySignals: Array<{ from: string; signalData: unknown }> = []
    const onEarlySignal = (data: { from: string; signalData: unknown }): void => {
      earlySignals.push(data)
    }
    this._relayClient.on('signal', onEarlySignal)

    try {
      const joinResult = await this._relayClient.joinRoom(roomCode, {
        memberName: this._config.memberName,
        networkInfo: this._guestNetwork
      })

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
      }

      // 3.5 根据自身网络能力按需等待信号（IPv6/P2P 不可用时无需等待）
      const signalWaits: Promise<void>[] = []
      if (this._guestNetwork!.ipv6.available) {
        signalWaits.push(this._waitForIpv6Signal(joinResult.hostId, 1500).then(() => {}))
      }
      if (this._guestNetwork!.ipv4.publicIp !== '') {
        signalWaits.push(this._waitForP2pSignal(joinResult.hostId, 1500).then(() => {}))
      }
      await Promise.all(signalWaits)
      logger.info('地址信号接收完成, 开始路径选择')
    } finally {
      this._relayClient.removeListener('signal', onEarlySignal)
    }

    // 4. 路径选择与连接
    await this._selectAndConnect()

    // 5. 注册游戏客户端连接处理器 — 发送重置帧通知房主重建游戏连接
    //    适配 Minecraft 等游戏：每次新客户端连接使用独立游戏 TCP 通道
    this._localServer.on('client-connected', () => {
      if (this._currentTransport) {
        this._currentTransport.send(Buffer.alloc(0)).catch(() => { /* ignore */ })
        logger.info('游戏客户端已连接, 已发送重置帧')
      }
    })

    // 6. 启动本地隧道（自动选择端口）
    const localPort = await this._localServer.start(0)

    this._setState('connected')
    logger.info(`已加入房间 ${roomCode}, 本地端口: ${localPort}`)

    this.emit('connected', {
      localPort,
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
    this._hostNetwork = null
    this._guestNetwork = null
    this._guestPeerInfo = null
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
      // P2P 最优：创建 P2pTransport(passive)，通过 Signal 通告地址
      logger.info(`为成员 ${memberId} 建立 P2P 传输通道`)
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
    } else if (bestPath.type === 'ipv6') {
      // IPv6 最优：主传输使用 Ipv6DirectTransport(passive)，
      // 同时创建 P2pTransport(passive) 备选，应对 IPv6 不可达的降级场景
      logger.info(`为成员 ${memberId} 建立传输通道 (IPv6 主, P2P 备选)`)
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

      // IPv6 直连主传输（passive 模式）
      const ipv6Transport = new Ipv6DirectTransport()
      ipv6Transport.setRole('passive')
      await ipv6Transport.connect({ peerId: memberId })

      // 通告 IPv6 监听端口给加入者，使 active 端能连到正确端口
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
    } else {
      // Relay 兜底
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

    // P2P 备选切换监听：当加入者降级到 P2P 连接成功时，
    // 将 LocalTunnelClient 从主传输切换到 P2pTransport
    if (p2pBackup) {
      const onP2pConnected = (status: TransportStatus) => {
        if (status !== 'connected') return
        const cl = this._guestClients.get(memberId)
        const cur = this._guestTransports.get(memberId)
        if (!cl || cur !== transport) return

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
    logger.info(`成员 ${memberId} 传输通道已就绪 (${bestPath.description})`)

    // 非中继路径：创建 Relay 备选传输，用于加入者降级到中继后的数据通道
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
    this._currentPathIndex = 0
    await this._connectWithPath(0)
  }

  /**
   * 功能描述：使用指定索引的路径建立连接
   *
   * @param index - 路径列表中的索引
   */
  private async _connectWithPath(index: number): Promise<void> {
    if (index >= this._availablePaths.length) {
      this._setState('error')
      const err = new Error('所有连接方式均不可用')
      this.emit('error', err)
      throw err
    }

    this._currentPathIndex = index
    this._currentPath = this._availablePaths[index]
    logger.info(`尝试连接: ${this._currentPath.description}`)

    // 断开旧传输（先置 null 防止 STATUS 事件触发重复降级）
    if (this._currentTransport) {
      const oldTransport = this._currentTransport
      this._currentTransport = null
      try {
        await oldTransport.disconnect()
      } catch { /* ignore */ }
    }

    try {
      const transport = this._createTransport(this._currentPath.type)

      // 设置角色（P2P 专用）
      if (transport instanceof P2pTransport) {
        transport.setRole(this._role === 'host' ? 'passive' : 'active')
      }

      // 连接
      await transport.connect(this._guestPeerInfo || { peerId: '' })

      // 设置到本地隧道（加入者侧）
      this._currentTransport = transport
      this._localServer.setTransport(transport)
      this._setupTransportEvents(transport)

      this._setState('connected')
      this.emit('transport-changed', transport.type)
      logger.info(`${this._currentPath.description} 连接成功`)
    } catch (err) {
      logger.warn(`${this._currentPath.description} 连接失败: ${(err as Error).message}`)
      await this._degrade()
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
        throw err
      }

      const toPath = this._availablePaths[nextIndex].description
      this.emit('degrading', { from: fromPath, to: toPath })
      logger.info(`降级: ${fromPath} → ${toPath}`)

      await this._connectWithPath(nextIndex)
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
        return new RelayPeerTransport(this._relayClient)
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
        logger.warn(`Transport 异常: ${s}`)
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
      ipv6Port: this._gamePort || undefined,
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
        if (data.from !== hostId) return
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
