/**
 * 功能描述：UDP 广播扫描器 — 发现局域网中的游戏服务器
 *
 * 逻辑说明：通过 UDP 广播发送发现请求，监听游戏服务器的响应。
 *           解析响应数据为 DiscoveredGame 对象，通过事件通知调用方。
 *           15 秒无响应的游戏自动移除。使用 EventEmitter 模式，
 *           支持 start/stop 生命周期管理。
 *
 * @module scanner
 */

import { EventEmitter } from 'events'
import * as dgram from 'dgram'
import * as os from 'os'
import type { DiscoveredGame, ScanEvent } from '@shared/types'

// ─── 常量 ───────────────────────────────────────────────
const DISCOVERY_PORT = 24861
const DISCOVERY_REQUEST = 'SGI1:DISCOVER\n'
const STALE_TIMEOUT_MS = 15000
const CLEANUP_INTERVAL_MS = 5000
const SCAN_INTERVAL_MS = 3000

/** 扫描器事件名称 */
export const SCANNER_EVENTS = {
  GAME_DISCOVERED: 'game-discovered',
  GAME_UPDATED: 'game-updated',
  GAME_REMOVED: 'game-removed',
  ERROR: 'error',
  STATE_CHANGE: 'state-change'
} as const

/** 扫描器运行状态 */
export type ScannerState = 'idle' | 'scanning' | 'error'

/**
 * 功能描述：解析 UDP 响应数据包
 *
 * 逻辑说明：格式为 SGI1:DISCOVER_RESP|gameId|name|port|protocol
 *           解析后转换为 DiscoveredGame 对象。
 *
 * @param msg - UDP 数据包
 * @param rinfo - 远程地址信息
 * @returns 解析后的游戏信息，格式错误返回 null
 */
export function parseResponse(
  msg: Buffer,
  rinfo: dgram.RemoteInfo
): DiscoveredGame | null {
  const text = msg.toString('utf8').trim()
  if (!text.startsWith('SGI1:DISCOVER_RESP|')) {
    return null
  }

  const parts = text.split('|')
  // SGI1:DISCOVER_RESP|gameId|name|port|protocol
  if (parts.length < 5) {
    return null
  }

  const gameId = parts[1]
  const name = parts[2]
  const port = parseInt(parts[3], 10)
  const protocol = parts[4]

  if (!gameId || !name || isNaN(port) || !protocol) {
    return null
  }

  return {
    id: `${gameId}-${rinfo.address}-${port}`,
    gameId,
    name,
    host: rinfo.address,
    port,
    protocol: protocol === 'udp' ? 'udp' : 'tcp',
    viaLan: true,
    lastSeen: Date.now()
  }
}

/**
 * 功能描述：UDP 广播扫描器类
 *
 * 逻辑说明：创建 UDP socket，定期发送广播发现请求并监听响应。
 *           维护已发现游戏列表，定期清理过期条目。
 *           使用 EventEmitter 通知调用方游戏状态变化。
 */
export class Scanner extends EventEmitter {
  private _socket: dgram.Socket | null = null
  private _state: ScannerState = 'idle'
  private _games: Map<string, DiscoveredGame> = new Map()
  private _scanTimer: ReturnType<typeof setInterval> | null = null
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null
  private _discoveryPort: number = DISCOVERY_PORT

  /**
   * 功能描述：创建 Scanner 实例
   *
   * @param discoveryPort - 发现端口号，默认 24861
   */
  constructor(discoveryPort: number = DISCOVERY_PORT) {
    super()
    this._discoveryPort = discoveryPort
  }

  /**
   * 功能描述：获取当前扫描器状态
   *
   * @returns 扫描器状态
   */
  get state(): ScannerState {
    return this._state
  }

  /**
   * 功能描述：获取当前已发现的游戏列表
   *
   * @returns 游戏列表
   */
  get games(): DiscoveredGame[] {
    return Array.from(this._games.values())
  }

  /**
   * 功能描述：获取可用网络接口的广播地址
   *
   * 逻辑说明：遍历所有网络接口，找到支持 IPv4 且非内部接口的广播地址。
   *
   * @returns 广播地址列表
   */
  private _getBroadcastAddresses(): string[] {
    const addresses: string[] = []
    const interfaces = os.networkInterfaces()

    for (const iface of Object.values(interfaces)) {
      if (!iface) continue
      for (const info of iface) {
        if (info.family === 'IPv4' && !info.internal) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const bc = (info as any).broadcast as string | undefined
          if (bc) {
            addresses.push(bc)
          }
          // 部分系统不提供 broadcast，使用 255.255.255.255 兜底
          addresses.push('255.255.255.255')
        }
      }
    }

    // 去重
    return [...new Set(addresses)]
  }

  /**
   * 功能描述：发送 UDP 广播发现请求
   *
   * 逻辑说明：向所有网络接口的广播地址发送发现请求。
   */
  private _broadcast(): void {
    if (!this._socket) return

    const message = Buffer.from(DISCOVERY_REQUEST)
    const targets = this._getBroadcastAddresses()

    for (const addr of targets) {
      this._socket.send(message, 0, message.length, this._discoveryPort, addr, (err) => {
        if (err) {
          this.emit(SCANNER_EVENTS.ERROR, err)
        }
      })
    }
  }

  /**
   * 功能描述：清理过期游戏
   *
   * 逻辑说明：遍历已发现游戏列表，移除 lastSeen 超过 STALE_TIMEOUT_MS 的条目。
   */
  private _cleanup(): void {
    const now = Date.now()
    for (const [id, game] of this._games) {
      if (now - game.lastSeen > STALE_TIMEOUT_MS) {
        this._games.delete(id)
        const event: ScanEvent = { type: 'removed', game }
        this.emit(SCANNER_EVENTS.GAME_REMOVED, event)
      }
    }
  }

  /**
   * 功能描述：处理收到的 UDP 响应
   *
   * @param msg - 数据包内容
   * @param rinfo - 发送方信息
   */
  private _onMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    const game = parseResponse(msg, rinfo)
    if (!game) return

    const existing = this._games.get(game.id)
    if (existing) {
      // 更新已有游戏
      existing.lastSeen = Date.now()
      existing.port = game.port
      this.emit(SCANNER_EVENTS.GAME_UPDATED, { type: 'updated', game: existing })
    } else {
      // 新发现的游戏
      this._games.set(game.id, game)
      this.emit(SCANNER_EVENTS.GAME_DISCOVERED, { type: 'discovered', game })
    }
  }

  /**
   * 功能描述：启动扫描
   *
   * 逻辑说明：创建 UDP socket，绑定到随机端口，开始监听广播响应。
   *           启动定期广播和清理定时器。广播间隔 3 秒，清理间隔 5 秒。
   *
   * @returns Promise，socket 就绪时 resolve
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._state === 'scanning') {
        resolve()
        return
      }

      try {
        this._socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

        this._socket.on('message', (msg, rinfo) => {
          this._onMessage(msg, rinfo)
        })

        this._socket.on('error', (err) => {
          this.emit(SCANNER_EVENTS.ERROR, err)
        })

        this._socket.bind(0, undefined, () => {
          this._socket!.setBroadcast(true)
          this._state = 'scanning'
          this.emit(SCANNER_EVENTS.STATE_CHANGE, this._state)

          // 首次立即广播
          this._broadcast()

          // 定期广播
          this._scanTimer = setInterval(() => {
            this._broadcast()
          }, SCAN_INTERVAL_MS)

          // 定期清理过期游戏
          this._cleanupTimer = setInterval(() => {
            this._cleanup()
          }, CLEANUP_INTERVAL_MS)

          resolve()
        })
      } catch (err) {
        this._state = 'error'
        this.emit(SCANNER_EVENTS.STATE_CHANGE, this._state)
        reject(err)
      }
    })
  }

  /**
   * 功能描述：停止扫描
   *
   * 逻辑说明：关闭 UDP socket，清除所有定时器，清理游戏列表。
   */
  stop(): void {
    this._state = 'idle'
    this.emit(SCANNER_EVENTS.STATE_CHANGE, this._state)

    if (this._scanTimer) {
      clearInterval(this._scanTimer)
      this._scanTimer = null
    }

    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer)
      this._cleanupTimer = null
    }

    if (this._socket) {
      try {
        this._socket.close()
      } catch {
        // socket 可能已关闭
      }
      this._socket = null
    }

    this._games.clear()
  }

  /**
   * 功能描述：添加或更新一个游戏（用于从其他源添加游戏，非广播发现）
   *
   * @param game - 游戏信息
   */
  addGame(game: DiscoveredGame): void {
    const existing = this._games.get(game.id)
    if (existing) {
      existing.lastSeen = Date.now()
      this.emit(SCANNER_EVENTS.GAME_UPDATED, { type: 'updated', game: existing })
    } else {
      this._games.set(game.id, game)
      this.emit(SCANNER_EVENTS.GAME_DISCOVERED, { type: 'discovered', game })
    }
  }
}
