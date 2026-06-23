/**
 * 功能描述：内存存储实现
 *
 * 逻辑说明：基于 Map 的同步存储，所有方法返回 Promise 以符合 Store 接口约定。
 *          房间按 code 索引，成员通过扫全量房间查找（O(n)，n=房间数）。
 *
 * 依赖：../types (Room, ClientInfo, TokenBucket, IpRateInfo, CircuitBreaker)
 */

import type { Room, ClientInfo, TokenBucket, IpRateInfo, CircuitBreaker } from '../types'
import type { Store } from './types'

export class MemoryStore implements Store {
  private readonly _rooms = new Map<string, Room>()
  private readonly _tokenBuckets = new Map<string, TokenBucket>()
  private readonly _ipRateInfo = new Map<string, IpRateInfo>()
  private _circuitBreaker: CircuitBreaker = {
    state: 'closed',
    errorCount: 0,
    totalCount: 0,
    windowStart: Date.now()
  }

  // ─── 房间 ─────────────────────────────────────────────

  async createRoom(room: Room): Promise<void> {
    this._rooms.set(room.code, room)
  }

  async getRoom(code: string): Promise<Room | null> {
    return this._rooms.get(code) ?? null
  }

  async deleteRoom(code: string): Promise<boolean> {
    return this._rooms.delete(code)
  }

  async listRooms(): Promise<Room[]> {
    return Array.from(this._rooms.values())
  }

  async getRoomCount(): Promise<number> {
    return this._rooms.size
  }

  // ─── 成员 ─────────────────────────────────────────────

  async addMember(roomCode: string, client: ClientInfo): Promise<void> {
    const room = this._rooms.get(roomCode)
    if (!room) throw new Error(`Room ${roomCode} not found`)
    room.members.set(client.memberId, client)
    room.lastActivityAt = Date.now()
  }

  async removeMember(roomCode: string, memberId: string): Promise<ClientInfo | null> {
    const room = this._rooms.get(roomCode)
    if (!room) return null
    const client = room.members.get(memberId)
    if (!client) return null
    room.members.delete(memberId)
    room.lastActivityAt = Date.now()
    return client
  }

  async getMembers(roomCode: string): Promise<ClientInfo[]> {
    const room = this._rooms.get(roomCode)
    if (!room) return []
    return Array.from(room.members.values())
  }

  async findMember(memberId: string): Promise<{ room: Room; client: ClientInfo } | null> {
    for (const room of this._rooms.values()) {
      const client = room.members.get(memberId)
      if (client) return { room, client }
    }
    return null
  }

  async getClientCount(): Promise<number> {
    let count = 0
    for (const room of this._rooms.values()) {
      count += room.members.size
    }
    return count
  }

  // ─── 限流 ─────────────────────────────────────────────

  async getTokenBucket(key: string): Promise<TokenBucket | undefined> {
    return this._tokenBuckets.get(key)
  }

  async setTokenBucket(key: string, bucket: TokenBucket): Promise<void> {
    this._tokenBuckets.set(key, bucket)
  }

  async getIpRateInfo(ip: string): Promise<IpRateInfo | undefined> {
    return this._ipRateInfo.get(ip)
  }

  async setIpRateInfo(ip: string, info: IpRateInfo): Promise<void> {
    this._ipRateInfo.set(ip, info)
  }

  // ─── 熔断 ─────────────────────────────────────────────

  async getCircuitBreaker(): Promise<CircuitBreaker> {
    return this._circuitBreaker
  }

  async setCircuitBreaker(cb: CircuitBreaker): Promise<void> {
    this._circuitBreaker = cb
  }

  // ─── 清理 ─────────────────────────────────────────────

  async removeIdleRooms(maxIdleSeconds: number): Promise<string[]> {
    const now = Date.now()
    const threshold = now - maxIdleSeconds * 1000
    const removed: string[] = []

    for (const [code, room] of this._rooms) {
      if (room.members.size === 0 && room.lastActivityAt < threshold) {
        this._rooms.delete(code)
        removed.push(code)
      }
    }

    return removed
  }

  async removeExpiredRooms(maxAgeSeconds: number): Promise<string[]> {
    const now = Date.now()
    const threshold = now - maxAgeSeconds * 1000
    const removed: string[] = []

    for (const [code, room] of this._rooms) {
      if (room.createdAt < threshold) {
        this._rooms.delete(code)
        removed.push(code)
      }
    }

    return removed
  }

  async clear(): Promise<void> {
    this._rooms.clear()
    this._tokenBuckets.clear()
    this._ipRateInfo.clear()
    this._circuitBreaker = {
      state: 'closed',
      errorCount: 0,
      totalCount: 0,
      windowStart: Date.now()
    }
  }
}
