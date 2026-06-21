/**
 * 功能描述：核心引擎统一导出入口
 *
 * 逻辑说明：集中导出所有核心模块的类、函数和类型。
 *           外部（主进程）通过此文件访问核心引擎。
 */

// 类型导出
export type {
  GameInfo,
  GameProtocolEntry,
  DiscoveredGame,
  GameDetectResult,
  ScanEvent,
  ScanEventType,
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

// ─── 传输层类型 ───────────────────────────────────────
export { TRANSPORT_EVENTS, TRANSPORT_TIMEOUT_MS } from './transports'
export type { Transport, PeerConnectionInfo } from './transports'

// ─── LAN 发现 ─────────────────────────────────────────
export { Scanner, Responder, gameDatabase, SCANNER_EVENTS, RESPONDER_EVENTS } from './discovery'
export { getSniffer, getAllSniffers, registerSniffer } from './discovery/protocols'
export type { GameProtocolSniffer, SniffResult } from './discovery/protocols'

// ─── 网络检测 ─────────────────────────────────────────
export { NetworkDetector, checkIpv6Capability, detectNatType } from './network'

// ─── 本地游戏检测 ─────────────────────────────────────
export { processScanner, portChecker, detectLocalGames, detectGame } from './local-detect'
export type { ProcessInfo } from './local-detect/process-scanner'
export type { PortCheckResult } from './local-detect/port-checker'

// ─── 连接路径选择 ─────────────────────────────────────
export { selectPath } from './connection'
export type { ConnectionRequest } from './connection'

// ─── 隧道 ─────────────────────────────────────────────
export {
  TunnelManager,
  LocalTunnelServer,
  LocalTunnelClient,
  RelayClient,
  Ipv6DirectTransport,
  KcpTransport,
  RelayPeerTransport
} from './tunnel'
export type {
  RelayConfig,
  RelayClientStatus,
  CreateRoomParams,
  CreateRoomResult,
  JoinRoomParams,
  JoinRoomResult,
  MemberJoinedData,
  RelayMessage
} from './tunnel'
export { DEFAULT_RELAY_CONFIG, RELAY_MESSAGE_TYPES, BINARY_FRAME_HEADER_SIZE } from './tunnel'

// ─── P2P ──────────────────────────────────────────────
export { P2PSignaling, P2pTransport } from './p2p'
export type { P2PSignalData, P2PConfig, P2PRole } from './p2p'
