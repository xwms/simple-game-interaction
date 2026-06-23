/**
 * 功能描述：中继服务器配置加载与验证
 *
 * 逻辑说明：从环境变量加载配置，合并默认值，启动时验证并打印配置摘要。
 *          环境变量命名规则：RELAY_${SECTION}_${KEY}
 *          所有非零值环境变量覆盖对应默认值。
 */

import { DEFAULTS } from './types'
import type { RelayConfig } from './types'

/**
 * 功能描述：加载并验证配置
 *
 * 逻辑说明：从 process.env 读取 RELAY_ 前缀的环境变量，
 *           解析为对应类型后合并到默认配置中。
 *           数值类型使用 parseInt，布尔类型按 truthy/falsy 解析。
 *
 * @returns 验证通过的完整配置对象
 * @throws 配置校验失败时抛出 Error
 */
export function loadConfig(): RelayConfig {
  const config: RelayConfig = { ...DEFAULTS }

  // ─── 基础 ───────────────────────────
  if (process.env.RELAY_HOST) config.host = process.env.RELAY_HOST
  if (process.env.RELAY_PORT) config.port = parseInt(process.env.RELAY_PORT, 10)
  if (process.env.RELAY_TLS_CERT) config.tlsCert = process.env.RELAY_TLS_CERT
  if (process.env.RELAY_TLS_KEY) config.tlsKey = process.env.RELAY_TLS_KEY

  // ─── 管理 API ───────────────────────
  if (process.env.RELAY_ADMIN_HOST) config.adminHost = process.env.RELAY_ADMIN_HOST
  if (process.env.RELAY_ADMIN_PORT) config.adminPort = parseInt(process.env.RELAY_ADMIN_PORT, 10)

  // ─── 房间 ───────────────────────────
  if (process.env.RELAY_MAX_ROOMS) config.maxRooms = parseInt(process.env.RELAY_MAX_ROOMS, 10)
  if (process.env.RELAY_MAX_MEMBERS) config.maxMembers = parseInt(process.env.RELAY_MAX_MEMBERS, 10)
  if (process.env.RELAY_ROOM_IDLE_TIMEOUT) config.roomIdleTimeout = parseInt(process.env.RELAY_ROOM_IDLE_TIMEOUT, 10)

  // ─── 客户端 ─────────────────────────
  if (process.env.RELAY_MAX_CLIENTS) config.maxClients = parseInt(process.env.RELAY_MAX_CLIENTS, 10)
  if (process.env.RELAY_MAX_PER_IP) config.maxPerIp = parseInt(process.env.RELAY_MAX_PER_IP, 10)
  if (process.env.RELAY_MSG_RATE) config.msgRate = parseInt(process.env.RELAY_MSG_RATE, 10)
  if (process.env.RELAY_MAX_MESSAGE_SIZE) config.maxMessageSize = parseInt(process.env.RELAY_MAX_MESSAGE_SIZE, 10)
  if (process.env.RELAY_MAX_FRAME_SIZE) config.maxFrameSize = parseInt(process.env.RELAY_MAX_FRAME_SIZE, 10)
  if (process.env.RELAY_ROOM_CREATE_RATE) config.roomCreateRate = parseInt(process.env.RELAY_ROOM_CREATE_RATE, 10)

  // ─── 心跳 ───────────────────────────
  if (process.env.RELAY_HEARTBEAT_TIMEOUT) config.heartbeatTimeout = parseInt(process.env.RELAY_HEARTBEAT_TIMEOUT, 10)
  if (process.env.RELAY_HANDSHAKE_TIMEOUT) config.handshakeTimeout = parseInt(process.env.RELAY_HANDSHAKE_TIMEOUT, 10)
  if (process.env.RELAY_IDLE_TIMEOUT) config.idleTimeout = parseInt(process.env.RELAY_IDLE_TIMEOUT, 10)

  // ─── 熔断 ───────────────────────────
  if (process.env.RELAY_CIRCUIT_BREAK_THRESHOLD) config.circuitBreakThreshold = parseFloat(process.env.RELAY_CIRCUIT_BREAK_THRESHOLD)

  // ─── 日志 ───────────────────────────
  if (process.env.RELAY_LOG_LEVEL) config.logLevel = process.env.RELAY_LOG_LEVEL

  validateConfig(config)
  return config
}

/**
 * 功能描述：校验配置合法性
 *
 * @param config - 待校验配置
 * @throws 任意字段不合法时抛出 Error
 */
function validateConfig(config: RelayConfig): void {
  const checks: Array<[boolean, string]> = [
    [isPort(config.port), `RELAY_PORT must be 1-65535, got ${config.port}`],
    [isPort(config.adminPort), `RELAY_ADMIN_PORT must be 1-65535, got ${config.adminPort}`],
    [config.maxRooms > 0, `RELAY_MAX_ROOMS must be > 0, got ${config.maxRooms}`],
    [config.maxMembers > 0 && config.maxMembers <= 100, `RELAY_MAX_MEMBERS must be 1-100, got ${config.maxMembers}`],
    [config.maxPerIp > 0, `RELAY_MAX_PER_IP must be > 0, got ${config.maxPerIp}`],
    [config.maxClients > 0, `RELAY_MAX_CLIENTS must be > 0, got ${config.maxClients}`],
    [config.roomIdleTimeout >= 60, `RELAY_ROOM_IDLE_TIMEOUT must be >= 60, got ${config.roomIdleTimeout}`],
    [config.heartbeatTimeout >= 5000, `RELAY_HEARTBEAT_TIMEOUT must be >= 5000, got ${config.heartbeatTimeout}`],
    [config.handshakeTimeout >= 1000, `RELAY_HANDSHAKE_TIMEOUT must be >= 1000, got ${config.handshakeTimeout}`],
    [config.maxMessageSize >= 1024, `RELAY_MAX_MESSAGE_SIZE must be >= 1024, got ${config.maxMessageSize}`],
    [config.maxFrameSize >= 65536, `RELAY_MAX_FRAME_SIZE must be >= 65536, got ${config.maxFrameSize}`],
    [['debug', 'info', 'warn', 'error'].includes(config.logLevel), `invalid RELAY_LOG_LEVEL: ${config.logLevel}`]
  ]

  for (const [ok, msg] of checks) {
    if (!ok) throw new Error(msg)
  }
}

/**
 * 功能描述：检查端口号合法性
 */
function isPort(v: number): boolean {
  return Number.isInteger(v) && v > 0 && v < 65536
}

/**
 * 功能描述：打印配置摘要（隐藏敏感信息）
 *
 * @param config - 运行配置
 */
export function printConfig(config: RelayConfig): void {
  console.log('')
  console.log('  Relay Server Configuration')
  console.log('  ─────────────────────────')
  console.log(`  Listen:     ${config.host}:${config.port}${config.tlsCert ? ' (WSS)' : ' (WS)'}`)
  console.log(`  Admin API:  ${config.adminHost}:${config.adminPort}`)
  console.log(`  Max Rooms:  ${config.maxRooms}  (${config.maxMembers}/room, ${config.roomIdleTimeout}s idle)`)
  console.log(`  Max Conn:   ${config.maxClients}  (${config.maxPerIp}/IP)`)
  console.log(`  Rate Lim:   ${config.msgRate} msg/s/conn  |  Room create: ${config.roomCreateRate}/min/IP`)
  console.log(`  Size Lim:   ${(config.maxMessageSize / 1024).toFixed(0)}KB msg  |  ${(config.maxFrameSize / 1024 / 1024).toFixed(1)}MB frame`)
  console.log(`  Heartbeat:  ${config.heartbeatTimeout}ms timeout`)
  console.log(`  Log Level:  ${config.logLevel}`)
  console.log('')
}
