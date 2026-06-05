/**
 * 功能描述：核心引擎统一导出入口
 *
 * 逻辑说明：集中导出所有核心模块的类、函数和类型。
 *           外部（主进程）通过此文件访问核心引擎。
 */

// 类型导出
export type {
  GameInfo,
  NetworkInfo,
  NatType,
  ConnectionPath,
  ConnectionPathType,
  TunnelStatus,
  RoomInfo,
  MemberInfo,
  UpdateInfo,
  IpcResult
} from '@shared/types'

// ─── 工具 ─────────────────────────────────────────────
export { Logger } from './utils/logger'

// ─── 暂未实现，以下为预留导出 ─────────────────────────
// export { Scanner } from './discovery/scanner'
// export { Responder } from './discovery/responder'
// export { gameDatabase } from './discovery/game-db'
// export { NetworkDetector } from './network-detect/detector'
// export { PathSelector } from './connection/path-selector'
// export { LocalTunnelServer } from './tunnel/local-server'
// export { RelayClient } from './tunnel/relay-client'
// export { TunnelManager } from './tunnel/tunnel-manager'
// export { PeerConnection } from './p2p/peer-connection'
// export { Signaling } from './p2p/signaling'
// export { ProcessScanner } from './game-detect/process-scanner'
// export { PortChecker } from './game-detect/port-checker'
