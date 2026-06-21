/**
 * 集成测试：Discovery + Tunnel 联合测试
 *
 * 逻辑说明：模拟完整的游戏发现和隧道建立流程。
 *           测试 Scanner 的 addGame/parseResponse + 游戏数据库查询 + 事件发射。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as dgram from 'dgram'
import { Scanner, parseResponse } from '../../src/core/discovery/scanner'
import { gameDatabase } from '../../src/core/discovery/game-db'
import type { AddressInfo } from 'net'
import type { DiscoveredGame } from '../../src/shared/types'

describe('Discovery + 数据库集成', () => {
  let scanner: Scanner

  beforeEach(() => {
    scanner = new Scanner()
  })

  afterEach(() => {
    scanner.stop()
  })

  it('parseResponse 应正确解析 UDP 响应', () => {
    const msg = Buffer.from('SGI1:DISCOVER_RESP|minecraft-java|Minecraft Java Edition|25565|tcp')
    const rinfo = { address: '192.168.1.100', port: 25565, family: 'IPv4' } as dgram.RemoteInfo

    const result = parseResponse(msg, rinfo)
    expect(result).not.toBeNull()
    expect(result!.gameId).toBe('minecraft-java')
    expect(result!.host).toBe('192.168.1.100')
    expect(result!.port).toBe(25565)
    expect(result!.protocol).toBe('tcp')
  })

  it('parseResponse 应拒绝格式错误的消息', () => {
    const badMsgs = [
      'INVALID_FORMAT',
      'SGI1:DISCOVER_RESP|partial',
      Buffer.from([0x00, 0x01, 0x02]),
      ''
    ]

    const rinfo = { address: '127.0.0.1', port: 12345, family: 'IPv4' } as dgram.RemoteInfo

    for (const msg of badMsgs) {
      const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg)
      expect(parseResponse(buf, rinfo)).toBeNull()
    }
  })

  it('addGame() 应添加游戏到 scanner 列表', async () => {
    const game: DiscoveredGame = {
      id: 'minecraft-java-192.168.1.100-25565',
      gameId: 'minecraft-java',
      name: 'Minecraft: Java Edition',
      host: '192.168.1.100',
      port: 25565,
      protocol: 'tcp',
      viaLan: true,
      lastSeen: Date.now()
    }

    scanner.addGame(game)
    expect(scanner.games.length).toBe(1)
    expect(scanner.games[0].gameId).toBe('minecraft-java')
  })

  it('addGame() 应发射 game-discovered 事件', async () => {
    const discoverPromise = new Promise<DiscoveredGame>((resolve) => {
      scanner.on('game-discovered', (event) => resolve(event.game))
    })

    const game: DiscoveredGame = {
      id: 'minecraft-java-192.168.1.100-25565',
      gameId: 'minecraft-java',
      name: 'Minecraft: Java Edition',
      host: '192.168.1.100',
      port: 25565,
      protocol: 'tcp',
      viaLan: true,
      lastSeen: Date.now()
    }

    scanner.addGame(game)
    const discovered = await discoverPromise
    expect(discovered.gameId).toBe('minecraft-java')
  })

  it('addGame() 应支持多款游戏', () => {
    const games = [
      { id: 'g1', gameId: 'minecraft-java', name: 'Minecraft', host: '192.168.1.1', port: 25565, protocol: 'tcp' as const, viaLan: true, lastSeen: Date.now() },
      { id: 'g2', gameId: 'terraria', name: 'Terraria', host: '192.168.1.2', port: 7777, protocol: 'tcp' as const, viaLan: true, lastSeen: Date.now() }
    ]

    for (const g of games) {
      scanner.addGame(g)
    }

    expect(scanner.games.length).toBe(2)
    expect(scanner.games.filter(g => g.viaLan).length).toBe(2)
  })

  it('发现游戏后应能通过数据库查询协议信息', () => {
    // 解析 Minecraft 发现响应
    const msg = Buffer.from('SGI1:DISCOVER_RESP|minecraft-java|Minecraft Java Edition|25565|tcp')
    const rinfo = { address: '192.168.1.100', port: 25565, family: 'IPv4' } as dgram.RemoteInfo
    const discovered = parseResponse(msg, rinfo)

    expect(discovered).not.toBeNull()

    // 通过游戏数据库查询协议详情
    const entry = gameDatabase.getById(discovered!.gameId)
    expect(entry).toBeDefined()
    expect(entry!.name).toBe('Minecraft: Java Edition')
    expect(entry!.defaultPort).toBe(25565)
    expect(entry!.processNames).toContain('java')
  })

  it('Scanner stop() 应清理所有资源', async () => {
    scanner.addGame({
      id: 'test-1', gameId: 'minecraft-java', name: 'Minecraft',
      host: '192.168.1.1', port: 25565, protocol: 'tcp', viaLan: true, lastSeen: Date.now()
    })

    scanner.stop()
    expect(scanner.state).toBe('idle')
    expect(scanner.games.length).toBe(0)
  })

  it('游戏数据库可嗅探游戏数量应 >= 2', () => {
    const sniffable = gameDatabase.getSniffable()
    expect(sniffable.length).toBeGreaterThanOrEqual(2)

    const ids = sniffable.map(g => g.id)
    expect(ids).toContain('minecraft-java')
    expect(ids).toContain('terraria')
  })

  it('游戏数据库应包含所有内置游戏', () => {
    const all = gameDatabase.getAll()
    expect(all.length).toBe(8)

    const names = all.map(g => g.name)
    expect(names).toContain('Minecraft: Java Edition')
    expect(names).toContain('Terraria')
    expect(names).toContain('Stardew Valley')
    expect(names).toContain('Factorio')
    expect(names).toContain('Valheim')
    expect(names).toContain('Counter-Strike: Global Offensive')
    expect(names).toContain('OpenArena')
    expect(names).toContain('Donut Server')
  })

  it('游戏数据库支持运行时注册新游戏', () => {
    const before = gameDatabase.getAll().length

    gameDatabase.register({
      id: 'test-game',
      name: 'Test Game',
      processNames: ['test'],
      defaultPort: 12345,
      protocol: 'tcp',
      sniffable: true
    })

    const after = gameDatabase.getAll().length
    expect(after).toBe(before + 1)

    const found = gameDatabase.getById('test-game')
    expect(found).toBeDefined()
    expect(found!.name).toBe('Test Game')
  })
})
