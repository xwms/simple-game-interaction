/**
 * 功能描述：UDP 响应器 — 响应局域网中其他实例的发现请求
 *
 * 逻辑说明：监听 UDP 发现端口，收到 SGI1:DISCOVER 请求后，
 *           回复本机运行的游戏信息。支持运行时动态增删要广播的游戏。
 *           使用 EventEmitter 模式。
 *
 * @module responder
 */

import { EventEmitter } from 'events'
import * as dgram from 'dgram'
import type { GameInfo } from '@shared/types'

// ─── 常量 ───────────────────────────────────────────────
const DISCOVERY_PORT = 24861
const DISCOVER_REQUEST_PREFIX = 'SGI1:DISCOVER'

/** 响应器事件名称 */
export const RESPONDER_EVENTS = {
  REQUEST_RECEIVED: 'request-received',
  RESPONSE_SENT: 'response-sent',
  ERROR: 'error',
  STATE_CHANGE: 'state-change'
} as const

/** 响应器运行状态 */
export type ResponderState = 'idle' | 'listening' | 'error'

/**
 * 功能描述：构建 UDP 响应数据包
 *
 * @param game - 游戏信息
 * @returns 响应字符串
 */
function buildResponse(game: GameInfo): string {
  return `SGI1:DISCOVER_RESP|${game.id}|${game.name}|${game.port}|${game.protocol}\n`
}

/**
 * 功能描述：UDP 响应器类
 *
 * 逻辑说明：绑定到发现端口，监听 SGI1:DISCOVER 请求。
 *           收到请求后向请求方回复本机运行的游戏信息。
 *           可同时广播多款游戏。
 */
export class Responder extends EventEmitter {
  private _socket: dgram.Socket | null = null
  private _state: ResponderState = 'idle'
  private _games: Map<string, GameInfo> = new Map()
  private _discoveryPort: number = DISCOVERY_PORT

  /**
   * 功能描述：创建 Responder 实例
   *
   * @param discoveryPort - 发现端口号，默认 24861
   */
  constructor(discoveryPort: number = DISCOVERY_PORT) {
    super()
    this._discoveryPort = discoveryPort
  }

  /**
   * 功能描述：获取当前响应器状态
   *
   * @returns 响应器状态
   */
  get state(): ResponderState {
    return this._state
  }

  /**
   * 功能描述：获取当前注册的游戏列表
   *
   * @returns 游戏列表
   */
  get games(): GameInfo[] {
    return Array.from(this._games.values())
  }

  /**
   * 功能描述：注册一款游戏到响应列表
   *
   * @param game - 游戏信息
   */
  addGame(game: GameInfo): void {
    this._games.set(game.id, game)
  }

  /**
   * 功能描述：从响应列表中移除一款游戏
   *
   * @param gameId - 游戏 ID
   */
  removeGame(gameId: string): void {
    this._games.delete(gameId)
  }

  /**
   * 功能描述：清空响应列表
   */
  clearGames(): void {
    this._games.clear()
  }

  /**
   * 功能描述：处理收到的发现请求
   *
   * 逻辑说明：验证请求格式，向请求方回复本机所有已注册游戏的信息。
   *
   * @param msg - 请求数据包
   * @param rinfo - 请求方信息
   */
  private _handleRequest(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    const text = msg.toString('utf8').trim()
    if (!text.startsWith(DISCOVER_REQUEST_PREFIX)) return

    this.emit(RESPONDER_EVENTS.REQUEST_RECEIVED, { from: rinfo.address })

    // 向请求方回复所有游戏信息
    for (const game of this._games.values()) {
      const response = Buffer.from(buildResponse(game))
      this._socket!.send(response, 0, response.length, rinfo.port, rinfo.address, (err) => {
        if (err) {
          this.emit(RESPONDER_EVENTS.ERROR, err)
        } else {
          this.emit(RESPONDER_EVENTS.RESPONSE_SENT, {
            game: game.id,
            to: rinfo.address
          })
        }
      })
    }
  }

  /**
   * 功能描述：启动响应器
   *
   * 逻辑说明：绑定到发现端口，开始监听发现请求。
   *           reuseAddr 允许多个实例同时监听。
   *
   * @returns Promise，socket 就绪时 resolve
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._state === 'listening') {
        resolve()
        return
      }

      try {
        this._socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

        this._socket.on('message', (msg, rinfo) => {
          this._handleRequest(msg, rinfo)
        })

        this._socket.on('error', (err) => {
          this.emit(RESPONDER_EVENTS.ERROR, err)
        })

        this._socket.bind(this._discoveryPort, undefined, () => {
          this._socket!.setBroadcast(true)
          this._state = 'listening'
          this.emit(RESPONDER_EVENTS.STATE_CHANGE, this._state)
          resolve()
        })
      } catch (err) {
        this._state = 'error'
        this.emit(RESPONDER_EVENTS.STATE_CHANGE, this._state)
        reject(err)
      }
    })
  }

  /**
   * 功能描述：停止响应器
   *
   * 逻辑说明：关闭 UDP socket，清空游戏列表。
   */
  stop(): void {
    this._state = 'idle'
    this.emit(RESPONDER_EVENTS.STATE_CHANGE, this._state)

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
}
