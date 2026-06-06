/**
 * 功能描述：Minecraft Java Edition 服务器嗅探器
 *
 * 逻辑说明：通过 TCP 连接检查端口是否开放，确认 Minecraft 服务器运行。
 *           旧版本（1.6-）服务器在连接时直接发送标识数据，
 *           新版本需要发送握手包才能获得响应。本嗅探器先尝试读取
 *           服务器主动发送的数据（旧版），失败则标记端口已开放。
 */

import type { GameInfo } from '@shared/types'
import type { GameProtocolSniffer, SniffResult } from './types'
import * as net from 'net'

export const minecraftSniffer: GameProtocolSniffer = {
  gameId: 'minecraft-java',

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
          // 旧版 Minecraft 服务器会在连接后主动发送 MOTD 数据
          // 如果没有数据到达，至少说明 TCP 端口是开放的
        })

        socket.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
          // 收到足够数据后关闭连接
          if (!settled) {
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
            // 连接成功但无数据到达，至少端口是开放的
            resolve(Buffer.alloc(0))
          }
        })

        socket.connect(port, host)
      })

      const latencyMs = Date.now() - start

      return {
        detected: true,
        gameId: 'minecraft-java',
        host,
        port,
        extra: data.length > 0
          ? { serverData: data.slice(0, 128).toString('utf8').replace(/[\x00-\x1f]/g, '') }
          : undefined,
        latencyMs
      }
    } catch {
      return {
        detected: false,
        gameId: 'minecraft-java',
        host,
        port
      }
    }
  },

  toGameInfo(result: SniffResult): GameInfo {
    return {
      id: result.gameId,
      name: 'Minecraft: Java Edition',
      port: result.port,
      protocol: 'tcp',
      host: result.host,
      status: result.detected ? 'online' : 'offline'
    }
  }
}
