/**
 * 功能描述：中继服务器存储抽象层
 *
 * 逻辑说明：定义 Store 接口，将房间/成员/限流/熔断等状态操作抽象化。
 *          目前只有 MemoryStore 实现，后续可扩展 RedisStore 实现多实例部署。
 */

import type { Room, ClientInfo, TokenBucket, IpRateInfo, CircuitBreaker } from '../types'

/**
 * 功能描述：存储层接口
 *
 * 逻辑说明：所有存储操作均返回 Promise，方便后续替换为异步存储后端。
 *          当前 MemoryStore 为同步实现，但返回 Promise 保持接口一致性。
 */
export interface Store {
  // ─── 房间 ───────────────────────────

  /** 创建房间 */
  createRoom(room: Room): Promise<void>

  /** 查询房间 */
  getRoom(code: string): Promise<Room | null>

  /** 删除房间 */
  deleteRoom(code: string): Promise<boolean>

  /** 列出所有房间 */
  listRooms(): Promise<Room[]>

  /** 获取房间总数 */
  getRoomCount(): Promise<number>

  // ─── 成员 ───────────────────────────

  /** 添加成员到房间 */
  addMember(roomCode: string, client: ClientInfo): Promise<void>

  /** 从房间移除成员 */
  removeMember(roomCode: string, memberId: string): Promise<ClientInfo | null>

  /** 查询房间内所有成员 */
  getMembers(roomCode: string): Promise<ClientInfo[]>

  /** 查询某个成员在当前所在房间 */
  findMember(memberId: string): Promise<{ room: Room; client: ClientInfo } | null>

  /** 获取全局客户端连接数 */
  getClientCount(): Promise<number>

  // ─── 限流 ───────────────────────────

  /** 获取或创建令牌桶 */
  getTokenBucket(key: string): Promise<TokenBucket | undefined>

  /** 更新令牌桶 */
  setTokenBucket(key: string, bucket: TokenBucket): Promise<void>

  /** 获取 IP 频率记录 */
  getIpRateInfo(ip: string): Promise<IpRateInfo | undefined>

  /** 更新 IP 频率记录 */
  setIpRateInfo(ip: string, info: IpRateInfo): Promise<void>

  // ─── 熔断 ───────────────────────────

  /** 获取熔断器 */
  getCircuitBreaker(): Promise<CircuitBreaker>

  /** 更新熔断器 */
  setCircuitBreaker(cb: CircuitBreaker): Promise<void>

  // ─── 清理 ───────────────────────────

  /** 移除超过指定时间无活动的房间，返回被移除的房间码列表 */
  removeIdleRooms(maxIdleSeconds: number): Promise<string[]>

  /** 清理超过 24 小时的过期房间 */
  removeExpiredRooms(maxAgeSeconds: number): Promise<string[]>

  /** 清空所有状态 */
  clear(): Promise<void>
}
