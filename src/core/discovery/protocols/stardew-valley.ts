/**
 * 功能描述：Stardew Valley 服务器嗅探器
 *
 * 逻辑说明：Stardew Valley 使用 TCP 24642 端口进行联机。
 *           通过 TCP 连接检测端口是否开放。Stardew Valley 使用
 *           自定义协议，简单检测仅确认端口可连接。
 */

import type { GameInfo } from '@shared/types'
import type { GameProtocolSniffer, SniffResult } from './types'
import * as net from 'net'

export const stardewValleySniffer: GameProtocolSniffer = {
  gameId: 'stardew-valley',

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
        gameId: 'stardew-valley',
        host,
        port,
        latencyMs: Date.now() - start
      }
    } catch {
      return {
        detected: false,
        gameId: 'stardew-valley',
        host,
        port
      }
    }
  },

  toGameInfo(result: SniffResult): GameInfo {
    return {
      id: result.gameId,
      name: 'Stardew Valley',
      port: result.port,
      protocol: 'tcp',
      host: result.host,
      status: result.detected ? 'online' : 'offline'
    }
  }
}
