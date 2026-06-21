/**
 * 游戏协议嗅探器测试
 *
 * 逻辑说明：使用本地 TCP 服务器模拟游戏服务器响应，
 *           验证各嗅探器的协议识别逻辑。测试 toGameInfo 转换。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as net from 'net'
import { minecraftSniffer } from '../../../src/core/discovery/protocols/minecraft'
import { terrariaSniffer } from '../../../src/core/discovery/protocols/terraria'
import { stardewValleySniffer } from '../../../src/core/discovery/protocols/stardew-valley'
import { genericSniffer } from '../../../src/core/discovery/protocols/generic'
import type { AddressInfo } from 'net'

describe('Minecraft 嗅探器', () => {
  let server: net.Server
  let port: number

  beforeEach(async () => {
    server = net.createServer()
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })

  it('应检测到开放的 Minecraft 服务器（有数据响应）', async () => {
    server.on('connection', (socket) => {
      socket.write(Buffer.from([0x00, 0x48, 0x65, 0x6c, 0x6c, 0x6f]))
    })

    const result = await minecraftSniffer.sniff('127.0.0.1', port, 1000)
    expect(result.detected).toBe(true)
    expect(result.gameId).toBe('minecraft-java')
    expect(result.extra?.serverData).toBeDefined()
  })

  it('应检测到开放的 Minecraft 服务器（无数据响应-超时）', async () => {
    server.on('connection', () => {
      // 接受连接但不发送数据
    })

    const result = await minecraftSniffer.sniff('127.0.0.1', port, 500)
    expect(result.detected).toBe(true)
    expect(result.port).toBe(port)
  })

  it('应检测到端口关闭', async () => {
    const result = await minecraftSniffer.sniff('127.0.0.1', 1, 500)
    expect(result.detected).toBe(false)
  })

  it('toGameInfo 应正确转换', () => {
    const result = { detected: true, gameId: 'minecraft-java', host: '127.0.0.1', port: 25565, latencyMs: 10 }
    const info = minecraftSniffer.toGameInfo(result)
    expect(info.name).toBe('Minecraft: Java Edition')
    expect(info.status).toBe('online')
    expect(info.port).toBe(25565)
  })

  it('toGameInfo 应正确转换离线状态', () => {
    const result = { detected: false, gameId: 'minecraft-java', host: '127.0.0.1', port: 25565 }
    const info = minecraftSniffer.toGameInfo(result)
    expect(info.status).toBe('offline')
  })
})

describe('Terraria 嗅探器', () => {
  let server: net.Server
  let port: number

  beforeEach(async () => {
    server = net.createServer()
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })

  it('应检测到开放的 Terraria 服务器（版本数据响应）', async () => {
    server.on('connection', (socket) => {
      // Terraria 发送版本标识数据
      const data = Buffer.alloc(20)
      data.write('Terraria', 0)
      socket.write(data)
    })

    const result = await terrariaSniffer.sniff('127.0.0.1', port, 1000)
    expect(result.detected).toBe(true)
    expect(result.gameId).toBe('terraria')
  })

  it('应检测到开放的 Terraria 服务器（无数据但端口开放）', async () => {
    server.on('connection', () => {})

    const result = await terrariaSniffer.sniff('127.0.0.1', port, 500)
    expect(result.detected).toBe(true)
  })

  it('toGameInfo 应正确转换', () => {
    const result = { detected: true, gameId: 'terraria', host: '127.0.0.1', port: 7777 }
    const info = terrariaSniffer.toGameInfo(result)
    expect(info.name).toBe('Terraria')
    expect(info.status).toBe('online')
  })
})

describe('Stardew Valley 嗅探器', () => {
  let server: net.Server
  let port: number

  beforeEach(async () => {
    server = net.createServer()
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })

  it('应检测到开放的 Stardew Valley 服务器', async () => {
    server.on('connection', (socket) => {
      socket.destroy()
    })

    const result = await stardewValleySniffer.sniff('127.0.0.1', port, 1000)
    expect(result.detected).toBe(true)
    expect(result.gameId).toBe('stardew-valley')
  })

  it('toGameInfo 应正确转换', () => {
    const result = { detected: true, gameId: 'stardew-valley', host: '127.0.0.1', port: 24642 }
    const info = stardewValleySniffer.toGameInfo(result)
    expect(info.name).toBe('Stardew Valley')
    expect(info.status).toBe('online')
  })
})

describe('通用嗅探器', () => {
  let server: net.Server
  let port: number

  beforeEach(async () => {
    server = net.createServer()
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })

  it('应检测到开放端口', async () => {
    server.on('connection', (socket) => {
      socket.destroy()
    })

    const result = await genericSniffer.sniff('127.0.0.1', port, 1000)
    expect(result.detected).toBe(true)
    expect(result.gameId).toBe('__generic__')
  })

  it('应检测到端口关闭', async () => {
    const result = await genericSniffer.sniff('127.0.0.1', 1, 500)
    expect(result.detected).toBe(false)
  })

  it('toGameInfo 应正确转换', () => {
    const result = { detected: true, gameId: '__generic__', host: '127.0.0.1', port: 8080 }
    const info = genericSniffer.toGameInfo(result)
    expect(info.status).toBe('online')
    expect(info.protocol).toBe('tcp')
  })
})
