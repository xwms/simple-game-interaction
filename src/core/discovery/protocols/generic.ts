/**
 * 功能描述：通用 TCP 端口检测嗅探器
 *
 * 逻辑说明：通过 TCP 连接尝试检测端口是否开放。
 *           适用于未实现自定义协议的游戏的简单检测。
 *           仅检测端口是否可连接，不验证协议内容。
 */

import type { GameInfo } from '@shared/types'
import type { GameProtocolSniffer, SniffResult } from './types'
import * as net from 'net'

export const genericSniffer: GameProtocolSniffer = {
  gameId: '__generic__',

  async sniff(
    host: string,
    port: number,
    timeoutMs: number = 3000
  ): Promise<SniffResult> {
    const start = Date.now()
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new net.Socket()
        socket.setTimeout(timeoutMs)
        socket.once('connect', () => {
          socket.destroy()
          resolve()
        })
        socket.once('error', (err) => {
          socket.destroy()
          reject(err)
        })
        socket.once('timeout', () => {
          socket.destroy()
          reject(new Error('Connection timeout'))
        })
        socket.connect(port, host)
      })

      return {
        detected: true,
        gameId: '__generic__',
        host,
        port,
        latencyMs: Date.now() - start
      }
    } catch {
      return {
        detected: false,
        gameId: '__generic__',
        host,
        port
      }
    }
  },

  toGameInfo(result: SniffResult): GameInfo {
    return {
      id: result.gameId,
      name: 'Unknown Game',
      port: result.port,
      protocol: 'tcp',
      host: result.host,
      status: result.detected ? 'online' : 'offline'
    }
  }
}
