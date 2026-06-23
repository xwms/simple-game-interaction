/**
 * 功能描述：中继服务器共享类型定义
 *
 * 逻辑说明：定义 RelayClient 兼容的消息类型、服务器内部状态类型。
 *          保持与 src/core/tunnel/types.ts 中 RELAY_MESSAGE_TYPES 一致。
 */

import type WebSocket from 'ws'

// ─── 配置类型 ─────────────────────────────────────────────

export interface RelayConfig {
  host: string
  port: number
  tlsCert: string
  tlsKey: string
  adminHost: string
  adminPort: number
  maxRooms: number
  maxMembers: number
  roomIdleTimeout: number
  maxClients: number
  maxPerIp: number
  msgRate: number
  maxMessageSize: number
  maxFrameSize: number
  heartbeatTimeout: number
  handshakeTimeout: number
  idleTimeout: number
  roomCreateRate: number
  circuitBreakThreshold: number
  logLevel: string
}

export const DEFAULTS: RelayConfig = {
  host: '0.0.0.0',
  port: 9800,
  tlsCert: '',
  tlsKey: '',
  adminHost: '127.0.0.1',
  adminPort: 9801,
  maxRooms: 1000,
  maxMembers: 8,
  roomIdleTimeout: 600,
  maxClients: 5000,
  maxPerIp: 10,
  msgRate: 100,
  maxMessageSize: 65536,
  maxFrameSize: 1048576,
  heartbeatTimeout: 30000,
  handshakeTimeout: 10000,
  idleTimeout: 300,
  roomCreateRate: 5,
  circuitBreakThreshold: 0.1,
  logLevel: 'info'
}

// ─── 运行时类型 ─────────────────────────────────────────────

/** 成员信息 */
export interface ClientInfo {
  memberId: string
  memberName: string
  roomCode: string | null
  memberIndex: number
  networkInfo: Record<string, unknown> | null
  ws: WebSocket
  ip: string
  connectedAt: number
  alive: boolean
  messageCount: number
  byteCount: number
  errorCount: number
}

/** 房间信息 */
export interface Room {
  code: string
  serverId: string
  serverNetworkInfo: Record<string, unknown> | null
  gameId: string
  gamePort: number
  gameName: string
  members: Map<string, ClientInfo>
  createdAt: number
  lastActivityAt: number
}

/** 限流令牌桶 */
export interface TokenBucket {
  tokens: number
  lastRefill: number
  maxTokens: number
  refillRate: number
}

/** 房间创建频率跟踪 */
export interface IpRateInfo {
  count: number
  windowStart: number
}

/** 熔断器状态 */
export type CircuitBreakerState = 'closed' | 'open' | 'half-open'

/** 熔断器 */
export interface CircuitBreaker {
  state: CircuitBreakerState
  errorCount: number
  totalCount: number
  windowStart: number
}

// ─── 消息类型 ─────────────────────────────────────────────

/** 消息类型常量（与 src/core/tunnel/types.ts RELAY_MESSAGE_TYPES 保持一致） */
export const RELAY_MESSAGE_TYPES = {
  CREATE_ROOM: 'create-room',
  ROOM_CREATED: 'room-created',
  JOIN_ROOM: 'join-room',
  ROOM_JOINED: 'room-joined',
  LEAVE_ROOM: 'leave-room',
  MEMBER_JOINED: 'member-joined',
  MEMBER_LEFT: 'member-left',
  ROOM_CLOSED: 'room-closed',
  RELAY_DATA: 'relay-data',
  SIGNAL: 'signal',
  HEARTBEAT: 'heartbeat',
  ERROR: 'error',
  AUTH: 'auth'
} as const

export const BINARY_FRAME_HEADER_SIZE = 4
