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

// ─── 网络检测 ─────────────────────────────────────────
export type NatType =
  | 'none'
  | 'full-cone'
  | 'restricted-cone'
  | 'port-restricted-cone'
  | 'symmetric'
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
  }
}

// ─── 连接路径 ─────────────────────────────────────────
export type ConnectionPathType = 'ipv6' | 'p2p' | 'relay'

export interface ConnectionPath {
  type: ConnectionPathType
  priority: number
  description: string
}

// ─── 隧道 ─────────────────────────────────────────────
export type TunnelStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

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
  }
}
