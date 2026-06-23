/**
 * 功能描述：中继服务器工具函数
 *
 * 逻辑说明：房间码生成、成员 ID 生成、JSON 发送/错误响应等通用工具。
 */

import { randomBytes } from 'crypto'
import WebSocket from 'ws'

/** 房间码字符集（排除易混淆的 0/O、1/I） */
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 成员 ID 序号 */
let memberIdSeq = 0

/**
 * 功能描述：生成 6 位房间码
 *
 * 逻辑说明：使用随机字节生成大写字母+数字组合。
 *           调用方需自行检查碰撞并重试。
 *
 * @returns 6 位房间码
 */
export function generateRoomCode(): string {
  const bytes = randomBytes(6)
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_CHARS[bytes[i] % ROOM_CODE_CHARS.length]
  }
  return code
}

/**
 * 功能描述：生成递增成员 ID
 *
 * @returns 形如 member_42 的成员 ID
 */
export function generateMemberId(): string {
  return `member_${++memberIdSeq}`
}

/**
 * 功能描述：发送 JSON 消息到 WebSocket 客户端
 *
 * @param ws - 目标 WebSocket
 * @param data - JSON 可序列化的消息数据
 */
export function sendJson(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

/**
 * 功能描述：发送错误响应
 *
 * 逻辑说明：匹配 RelayClient 的 error 响应格式：
 *           { type: 'error', messageId?, error: { code, message } }
 *
 * @param ws - 目标 WebSocket
 * @param messageId - 对应请求的 messageId（可选）
 * @param code - 错误码
 * @param message - 错误描述
 */
export function sendError(
  ws: WebSocket,
  messageId: string | undefined,
  code: string,
  message: string
): void {
  sendJson(ws, {
    type: 'error',
    ...(messageId ? { messageId } : {}),
    error: { code, message }
  })
}

/**
 * 功能描述：格式化字节数为人类可读字符串
 *
 * @param bytes - 字节数
 * @returns 如 "1.5 MB" 的字符串
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 功能描述：获取当前 ISO 时间戳
 */
export function nowISO(): string {
  return new Date().toISOString()
}

/**
 * 功能描述：校验 roomCode 格式（6 位大写字母+数字）
 *
 * @param code - 待校验房间码
 * @returns 是否合法
 */
export function isValidRoomCode(code: string): boolean {
  return /^[A-Z0-9]{6}$/.test(code)
}

/**
 * 功能描述：校验 memberId 格式
 *
 * @param id - 待校验成员 ID
 * @returns 是否合法
 */
export function isValidMemberId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id)
}
