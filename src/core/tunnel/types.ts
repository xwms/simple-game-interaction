/**
 * 功能描述：隧道模块类型定义 — Relay 配置、协议消息类型常量
 *
 * 逻辑说明：定义中继客户端所需的配置项和协议消息格式。
 *           中继消息遵循 JSON 文本帧 + 二进制数据帧的双通道协议。
 *           JSON 帧用于控制消息（房间管理、信令、心跳），
 *           二进制帧用于 TCP 数据中继。
 */

import type { NetworkInfo, TransportStatus } from '@shared/types'

// ─── 配置 ─────────────────────────────────────────────

/** Relay 客户端配置 */
export interface RelayConfig {
  /** WebSocket 中继服务器地址 */
  relayUrl: string
  /** 最大重连次数 */
  reconnectMaxAttempts: number
  /** 重连基础延迟（毫秒，指数退避） */
  reconnectBaseDelay: number
  /** 心跳发送间隔（毫秒） */
  heartbeatInterval: number
  /** 心跳超时阈值（毫秒，超过此时间未收到心跳响应/任何消息则触发重连，需 >= heartbeatInterval * 2） */
  heartbeatTimeout: number
  /** 连接超时（毫秒） */
  connectTimeout: number
}

export const DEFAULT_RELAY_CONFIG: RelayConfig = {
  relayUrl: 'ws://159.75.150.37:9800',
  reconnectMaxAttempts: 5,
  reconnectBaseDelay: 1000,
  heartbeatInterval: 10000,
  heartbeatTimeout: 30000,
  connectTimeout: 5000
}

// ─── 协议消息类型 ─────────────────────────────────────

/** Relay 协议消息类型常量 */
export const RELAY_MESSAGE_TYPES = {
  // 房间管理
  CREATE_ROOM: 'create-room',
  ROOM_CREATED: 'room-created',
  JOIN_ROOM: 'join-room',
  ROOM_JOINED: 'room-joined',
  LEAVE_ROOM: 'leave-room',
  MEMBER_JOINED: 'member-joined',
  MEMBER_LEFT: 'member-left',
  ROOM_CLOSED: 'room-closed',
  // 数据中继
  RELAY_DATA: 'relay-data',
  // P2P 信令
  SIGNAL: 'signal',
  // 心跳
  HEARTBEAT: 'heartbeat',
  // 错误
  ERROR: 'error'
} as const

// ─── 消息接口 ─────────────────────────────────────────

/** Relay 消息基类 */
export interface RelayMessage {
  type: string
  messageId?: string
  data?: unknown
  error?: { code: string; message: string }
}

/** 创建房间参数 */
export interface CreateRoomParams {
  gameId: string
  gameName: string
  gamePort: number
  memberName: string
  networkInfo: NetworkInfo
}

/** 创建房间结果 */
export interface CreateRoomResult {
  roomCode: string
  memberId: string
}

/** 加入房间参数 */
export interface JoinRoomParams {
  memberName: string
  networkInfo: NetworkInfo
}

/** 加入房间结果 */
export interface JoinRoomResult {
  roomCode: string
  memberId: string
  serverId: string
  serverNetworkInfo?: NetworkInfo
  gamePort: number
  members: Array<{ id: string; name: string }>
}

/** 成员信息消息 */
export interface MemberJoinedData {
  memberId: string
  memberName: string
  networkInfo: NetworkInfo
}

/** Relay 客户端状态 */
export type RelayClientStatus = TransportStatus | 'reconnecting'

/** 二进制数据帧格式：
 *  [4 bytes: payload length (UInt32BE)]
 *  [N bytes: raw payload]
 */
export const BINARY_FRAME_HEADER_SIZE = 4
