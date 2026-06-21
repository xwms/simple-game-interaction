/**
 * 游戏检测集成测试
 */
import { describe, it, expect } from 'vitest'
import { detectLocalGames, detectGame } from '../../../src/core/local-detect/index'

describe('游戏检测集成', () => {
  it('detectLocalGames 应返回所有游戏的检测结果', async () => {
    const results = await detectLocalGames()
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThanOrEqual(8)
    for (const r of results) {
      expect(r).toHaveProperty('gameId')
      expect(r).toHaveProperty('name')
      expect(r).toHaveProperty('running')
      expect(r).toHaveProperty('portOpen')
      expect(typeof r.running).toBe('boolean')
      expect(typeof r.portOpen).toBe('boolean')
    }
  })

  it('detectGame 应返回指定游戏的检测结果', async () => {
    const result = await detectGame('minecraft-java')
    expect(result).not.toBeNull()
    expect(result!.gameId).toBe('minecraft-java')
    expect(result!.name).toBe('Minecraft: Java Edition')
  })

  it('detectGame 对不存在的游戏应返回 null', async () => {
    const result = await detectGame('non-existent')
    expect(result).toBeNull()
  })

  it('所有检测结果中的名称应与游戏数据库匹配', async () => {
    const results = await detectLocalGames()
    const gameNames = results.map((r) => r.name)
    expect(gameNames).toContain('Minecraft: Java Edition')
    expect(gameNames).toContain('Terraria')
    expect(gameNames).toContain('Factorio')
    expect(gameNames).toContain('Valheim')
  })
})
