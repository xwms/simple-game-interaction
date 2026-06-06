/**
 * 功能描述：Terraria 服务器嗅探器
 *
 * 逻辑说明：Terraria 服务器在 TCP 连接建立后会发送版本标识数据。
 *           通过 TCP 连接并读取响应数据来确认服务器运行。
 *           收到数据的前几个字节包含 Terraria 版本号信息。
 */

import type { GameInfo } from '@shared/types'
import type { GameProtocolSniffer, SniffResult } from './types'
import * as net from 'net'

export const terrariaSniffer: GameProtocolSniffer = {
  gameId: 'terraria',

  async sniff(
    host: string,
    port: number,
    timeoutMs: number = 3000
  ): Promise<SniffResult> {
    const start = Date.now()

    try {
      const data = await new Promise<Buffer>((resolve, reject) => {
        const socket = new net.Socket()
        const chunks: Buffer[] = []
        let settled = false

        socket.setTimeout(timeoutMs)

        socket.once('connect', () => {
          // Terraria 会主动发送数据
        })

        socket.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          if (chunks.length >= 2 || chunk.length > 10) {
            settled = true
            socket.destroy()
            resolve(Buffer.concat(chunks))
          }
        })

        socket.once('error', (err) => {
          if (!settled) {
            settled = true
            socket.destroy()
            reject(err)
          }
        })

        socket.once('timeout', () => {
          if (!settled) {
            settled = true
            socket.destroy()
            resolve(Buffer.alloc(0))
          }
        })

        socket.connect(port, host)
      })

      return {
        detected: true,
        gameId: 'terraria',
        host,
        port,
        extra: data.length > 0
          ? { serverData: data.slice(0, 64).toString('hex') }
          : undefined,
        latencyMs: Date.now() - start
      }
    } catch {
      return {
        detected: false,
        gameId: 'terraria',
        host,
        port
      }
    }
  },

  toGameInfo(result: SniffResult): GameInfo {
    return {
      id: result.gameId,
      name: 'Terraria',
      port: result.port,
      protocol: 'tcp',
      host: result.host,
      status: result.detected ? 'online' : 'offline'
    }
  }
}
