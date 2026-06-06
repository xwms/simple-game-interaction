/**
 * UDP 响应器测试
 */
import { describe, it, expect } from 'vitest'
import { Responder } from '../../../src/core/discovery/responder'

describe('Responder 实例管理', () => {
  it('初始状态应为 idle', () => {
    const responder = new Responder()
    expect(responder.state).toBe('idle')
  })

  it('初始游戏列表应为空', () => {
    const responder = new Responder()
    expect(responder.games).toHaveLength(0)
  })

  it('addGame 后应出现在列表中', () => {
    const responder = new Responder()
    responder.addGame({
      id: 'test',
      name: 'Test Game',
      port: 9999,
      protocol: 'tcp',
      host: '0.0.0.0'
    })
    expect(responder.games).toHaveLength(1)
    expect(responder.games[0].id).toBe('test')
  })

  it('removeGame 应从列表中移除', () => {
    const responder = new Responder()
    responder.addGame({
      id: 'test',
      name: 'Test Game',
      port: 9999,
      protocol: 'tcp',
      host: '0.0.0.0'
    })
    responder.removeGame('test')
    expect(responder.games).toHaveLength(0)
  })

  it('clearGames 应清空所有游戏', () => {
    const responder = new Responder()
    responder.addGame({
      id: 'game1',
      name: 'Game 1',
      port: 1111,
      protocol: 'tcp',
      host: '0.0.0.0'
    })
    responder.addGame({
      id: 'game2',
      name: 'Game 2',
      port: 2222,
      protocol: 'udp',
      host: '0.0.0.0'
    })
    responder.clearGames()
    expect(responder.games).toHaveLength(0)
  })
})
