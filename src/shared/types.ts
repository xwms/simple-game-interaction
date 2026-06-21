/**
 * 功能描述：跨进程共享类型定义
 *
 * 逻辑说明：所有在渲染进程和主进程之间共享的类型在此定义。
 *           核心引擎导出的类型与这些类型保持一致。
 */

// ─── 游戏发现 ─────────────────────────────────────────
export interface GameInfo {
  id: string
  name: string
  port: number
  protocol: 'tcp' | 'udp'
  host: string
  status?: string
}

/** 游戏协议数据库条目 */
export interface GameProtocolEntry {
  id: string
  name: string
  processNames: string[]
  defaultPort: number
  protocol: 'tcp' | 'udp'
  altPorts?: number[]
  sniffable: boolean
  description?: string
}

/** LAN 扫描发现的游戏实例 */
export interface DiscoveredGame {
  id: string
  gameId: string
  name: string
  host: string
  port: number
  protocol: 'tcp' | 'udp'
  viaLan: boolean
  lastSeen: number
  extra?: Record<string, string>
}

/** 本地游戏检测结果 */
export interface GameDetectResult {
  gameId: string
  name: string
  running: boolean
  portOpen: boolean
  port: number
  pid?: number
  processName?: string
}

/** LAN 扫描事件 */
export type ScanEventType = 'discovered' | 'updated' | 'removed' | 'error'

export interface ScanEvent {
  type: ScanEventType
  game?: DiscoveredGame
  error?: string
}

// ─── 网络检测 ─────────────────────────────────────────
export type NatType =
  | 'none'
  | 'easy-nat'
  | 'hard-nat'
  | 'unknown'

/**
 * 映射行为 (RFC 5780 Mapping Behavior)
 *
 * Endpoint-Independent Mapping:  对任意目的地址复用同一映射端口 → Cone NAT
 * Address-Dependent Mapping:     不同目的 IP 使用不同映射端口
 * Address-and-Port-Dependent:    不同目的 IP:端口 使用不同映射端口 → Symmetric NAT
 */
export type MappingBehavior =
  | 'endpoint-independent'
  | 'address-dependent'
  | 'address-and-port-dependent'
  | 'unknown'

/**
 * 过滤行为 (RFC 5780 Filtering Behavior)
 *
 * Endpoint-Independent Filtering:   任意外部主机均可向映射地址发包 → Full Cone
 * Address-Dependent Filtering:      仅本机曾联系过的 IP 可发回 → Restricted Cone
 * Address-and-Port-Dependent:       仅本机曾联系过的精确 IP:端口 可发回 → Port Restricted Cone
 */
export type FilteringBehavior =
  | 'endpoint-independent'
  | 'address-dependent'
  | 'address-and-port-dependent'
  | 'unknown'

export interface NetworkInfo {
  ipv6: {
    available: boolean
    hasPublicV6: boolean
    addresses: string[]
  }
  ipv4: {
    natType: NatType
    publicIp: string
    publicPort: number
    mappingBehavior: MappingBehavior
    filteringBehavior: FilteringBehavior
    localAddresses: string[]
  }
}

// ─── 连接路径 ─────────────────────────────────────────
export type ConnectionPathType = 'ipv6' | 'p2p' | 'relay'

export interface ConnectionPath {
  type: ConnectionPathType
  priority: number
  description: string
/** P2P 连接策略（NAT 行为类型），供 P2P 传输层决定打洞方式 */
  p2pStrategy?: {
    server: { mappingBehavior: MappingBehavior; filteringBehavior: FilteringBehavior }
    client: { mappingBehavior: MappingBehavior; filteringBehavior: FilteringBehavior }
    /** 可用的 P2P 子策略（按优先级排序） */
    methods: ('tcp' | 'udp')[]
  }
}

// ─── 隧道 ─────────────────────────────────────────────
export type TunnelStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/** 传输层类型（与 ConnectionPathType 一致，作为规范名称） */
export type TransportType = 'ipv6' | 'p2p' | 'relay'
export type TransportStatus = TunnelStatus

/** 流量快照 */
export interface TrafficSnapshot {
  bytesSent: number
  bytesReceived: number
  timestamp: number
}

/** 房间创建参数（渲染进程 → 主进程） */
export interface CreateRoomOptions {
  gameId: string
  gameName: string
  gamePort: number
  /** 中继服务器地址，不传则使用 TunnelManager 默认值 */
  relayUrl?: string
}

/** 加入房间结果（主进程 → 渲染进程） */
export interface JoinRoomResult {
  roomCode: string
  memberId: string
  hostId: string
  hostNetworkInfo?: NetworkInfo
  gamePort: number
  members: MemberInfo[]
}

/** 隧道启动参数 */
export interface TunnelStartOptions {
  port: number
  roomCode: string
}

/** 隧道启动结果 */
export interface TunnelStartResult {
  port: number
  transport: TransportType
}

// ─── 房间 ─────────────────────────────────────────────
export interface MemberInfo {
  id: string
  name: string
  transport?: ConnectionPathType
}

export interface RoomInfo {
  roomCode: string
  hostId: string
  gameId: string
  gameName: string
  gamePort: number
  members: MemberInfo[]
  createdAt: number
}

// ─── IPC 统一返回格式 ─────────────────────────────────
export type IpcResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }

// ─── 更新信息 ─────────────────────────────────────────
export interface UpdateInfo {
  hasUpdate: boolean
  version: string
  releaseNotes?: string
  downloadUrl?: string
  source?: 'gitee' | 'github'
}

// ─── 窗口类型声明 ─────────────────────────────────────
export interface ElectronAPI {
  invoke(channel: string, ...args: unknown[]): Promise<IpcResult<unknown>>
  on(channel: string, callback: (...args: unknown[]) => void): () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
    __showDisconnectConfirm?: () => void
  }
}
