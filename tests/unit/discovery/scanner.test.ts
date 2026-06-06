/**
 * UDP 广播扫描器测试
 */
import { describe, it, expect, vi } from 'vitest'
import { Scanner, parseResponse } from '../../../src/core/discovery/scanner'
import * as dgram from 'dgram'

describe('parseResponse - UDP 响应解析', () => {
  const rinfo = { address: '192.168.1.100', port: 24861, family: 'IPv4', size: 100 }

  it('应正确解析有效的响应数据包', () => {
    const msg = Buffer.from('SGI1:DISCOVER_RESP|minecraft-java|Minecraft: Java Edition|25565|tcp\n')
    const result = parseResponse(msg, rinfo)

    expect(result).not.toBeNull()
    expect(result!.gameId).toBe('minecraft-java')
    expect(result!.name).toBe('Minecraft: Java Edition')
    expect(result!.port).toBe(25565)
    expect(result!.protocol).toBe('tcp')
    expect(result!.host).toBe('192.168.1.100')
    expect(result!.viaLan).toBe(true)
    expect(result!.lastSeen).toBeGreaterThan(0)
  })

  it('应拒绝无效的请求头', () => {
    const msg = Buffer.from('INVALID|game|name|1234|tcp\n')
    expect(parseResponse(msg, rinfo)).toBeNull()
  })

  it('应拒绝字段不足的响应', () => {
    const msg = Buffer.from('SGI1:DISCOVER_RESP|game|name\n')
    expect(parseResponse(msg, rinfo)).toBeNull()
  })

  it('应拒绝端口号为非数字的响应', () => {
    const msg = Buffer.from('SGI1:DISCOVER_RESP|game|name|abc|tcp\n')
    expect(parseResponse(msg, rinfo)).toBeNull()
  })

  it('应为 UDP 协议设置正确的 protocol 值', () => {
    const msg = Buffer.from('SGI1:DISCOVER_RESP|game|name|1234|udp\n')
    const result = parseResponse(msg, rinfo)
    expect(result!.protocol).toBe('udp')
  })

  it('应生成唯一的游戏 ID（host + port）', () => {
    const msg = Buffer.from('SGI1:DISCOVER_RESP|game|name|1234|tcp\n')
    const result = parseResponse(msg, rinfo)
    expect(result!.id).toBe('game-192.168.1.100-1234')
  })
})

describe('Scanner 实例管理', () => {
  it('初始状态应为 idle', () => {
    const scanner = new Scanner()
    expect(scanner.state).toBe('idle')
  })

  it('初始游戏列表应为空', () => {
    const scanner = new Scanner()
    expect(scanner.games).toHaveLength(0)
  })

  it('addGame 应添加游戏到列表', () => {
    const scanner = new Scanner()
    const game = {
      id: 'test-game-127.0.0.1-9999',
      gameId: 'test-game',
      name: 'Test',
      host: '127.0.0.1',
      port: 9999,
      protocol: 'tcp' as const,
      viaLan: true,
      lastSeen: Date.now()
    }

    scanner.addGame(game)
    expect(scanner.games).toHaveLength(1)
    expect(scanner.games[0].gameId).toBe('test-game')
  })

  it('addGame 应触发 game-discovered 事件', () => {
    const scanner = new Scanner()
    const listener = vi.fn()
    scanner.on('game-discovered', listener)

    scanner.addGame({
      id: 'test-1',
      gameId: 'test',
      name: 'Test',
      host: '127.0.0.1',
      port: 9999,
      protocol: 'tcp',
      viaLan: true,
      lastSeen: Date.now()
    })

    expect(listener).toHaveBeenCalledTimes(1)
  })
})
