/**
 * 游戏协议数据库测试
 */
import { describe, it, expect } from 'vitest'
import { gameDatabase } from '../../../src/core/discovery/game-db'

describe('游戏协议数据库', () => {
  it('应包含至少 8 款内置游戏', () => {
    const games = gameDatabase.getAll()
    expect(games.length).toBeGreaterThanOrEqual(8)
  })

  it('应按 ID 查询游戏', () => {
    const mc = gameDatabase.getById('minecraft-java')
    expect(mc).toBeDefined()
    expect(mc!.name).toContain('Minecraft')
    expect(mc!.defaultPort).toBe(25565)
    expect(mc!.protocol).toBe('tcp')
  })

  it('按端口号查询应返回匹配游戏', () => {
    const games = gameDatabase.getByPort(7777)
    expect(games.length).toBeGreaterThanOrEqual(1)
    expect(games[0].id).toBe('terraria')
  })

  it('按端口号查询应包含 altPorts', () => {
    const games = gameDatabase.getByPort(2457)
    expect(games.length).toBeGreaterThanOrEqual(1)
    expect(games[0].id).toBe('valheim')
  })

  it('按进程名查询应忽略大小写和 .exe 后缀', () => {
    const games = gameDatabase.getByProcessName('JAVA.EXE')
    expect(games.some((g) => g.id === 'minecraft-java')).toBe(true)
  })

  it('可嗅探的游戏列表应只包含 sniffable=true 的游戏', () => {
    const sniffable = gameDatabase.getSniffable()
    for (const game of sniffable) {
      expect(game.sniffable).toBe(true)
    }
  })

  it('运行时注册新游戏应生效', () => {
    gameDatabase.register({
      id: 'test-game',
      name: 'Test Game',
      processNames: ['test'],
      defaultPort: 9999,
      protocol: 'tcp',
      sniffable: false
    })

    const game = gameDatabase.getById('test-game')
    expect(game).toBeDefined()
    expect(game!.name).toBe('Test Game')
    expect(game!.defaultPort).toBe(9999)
  })

  it('查询不存在的 ID 应返回 undefined', () => {
    const game = gameDatabase.getById('non-existent-game')
    expect(game).toBeUndefined()
  })

  it('查询不存在的端口应返回空列表', () => {
    const games = gameDatabase.getByPort(1)
    expect(games).toHaveLength(0)
  })
})
