/**
 * 中继服务器管理 API 测试
 *
 * 逻辑说明：在本地 ephemeral 端口启动 AdminServer，通过 HTTP 请求验证
 *           健康检查、令牌鉴权、删除房间和无 CORS 通配符等行为。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AdminServer } from '../../../src/relay-server/admin/http-server'
import { MemoryStore } from '../../../src/relay-server/store/memory-store'
import { DEFAULTS } from '../../../src/relay-server/types'
import type { RelayConfig, Room } from '../../../src/relay-server/types'
import type { RelayServer } from '../../../src/relay-server/server'

/** 测试用房间 */
function makeRoom(code: string): Room {
  return {
    code,
    serverId: 'member_1',
    serverNetworkInfo: null,
    gameId: 'minecraft',
    gamePort: 25565,
    gameName: 'Minecraft Java Edition',
    members: new Map(),
    createdAt: Date.now(),
    lastActivityAt: Date.now()
  }
}

/**
 * 功能描述：等待管理服务完成端口绑定
 *
 * @param admin - 管理服务实例
 */
async function waitForPort(admin: AdminServer): Promise<number> {
  for (let i = 0; i < 100; i++) {
    if (admin.port !== 0) return admin.port
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Admin server did not start')
}

describe('中继服务器管理 API', () => {
  let store: MemoryStore
  let admin: AdminServer
  let fakeServer: RelayServer
  let baseUrl: string

  /** 功能描述：以指定配置启动管理服务 */
  async function startAdmin(overrides: Partial<RelayConfig> = {}): Promise<void> {
    const config: RelayConfig = { ...DEFAULTS, adminHost: '127.0.0.1', adminPort: 0, ...overrides }
    admin = new AdminServer()
    admin.start(config, fakeServer, store)
    baseUrl = `http://127.0.0.1:${await waitForPort(admin)}`
  }

  beforeEach(() => {
    store = new MemoryStore()
    fakeServer = { uptime: 42, connectionCount: 3 } as unknown as RelayServer
  })

  afterEach(() => {
    admin?.stop()
  })

  it('未配置令牌时应允许访问健康检查', async () => {
    await startAdmin()
    const res = await fetch(`${baseUrl}/health`)
    const body = await res.json() as { status: string; uptime: number; rooms: number; clients: number }

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.uptime).toBe(42)
    expect(body.rooms).toBe(0)
    expect(body.clients).toBe(3)
  })

  it('配置令牌后无令牌请求应返回 401', async () => {
    await startAdmin({ adminToken: 'secret-token' })
    const res = await fetch(`${baseUrl}/health`)

    expect(res.status).toBe(401)
  })

  it('配置令牌后应支持 Bearer、X-Admin-Token 和查询参数三种方式', async () => {
    await startAdmin({ adminToken: 'secret-token' })

    const bearer = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: 'Bearer secret-token' }
    })
    const header = await fetch(`${baseUrl}/health`, {
      headers: { 'X-Admin-Token': 'secret-token' }
    })
    const query = await fetch(`${baseUrl}/health?token=secret-token`)

    expect(bearer.status).toBe(200)
    expect(header.status).toBe(200)
    expect(query.status).toBe(200)
  })

  it('错误令牌应返回 401', async () => {
    await startAdmin({ adminToken: 'secret-token' })
    const res = await fetch(`${baseUrl}/api/rooms`, {
      headers: { Authorization: 'Bearer wrong-token' }
    })

    expect(res.status).toBe(401)
  })

  it('删除房间需要令牌，成功后房间从存储中移除', async () => {
    await store.createRoom(makeRoom('ABC123'))
    await startAdmin({ adminToken: 'secret-token' })

    const unauthorized = await fetch(`${baseUrl}/api/rooms/ABC123`, { method: 'DELETE' })
    expect(unauthorized.status).toBe(401)

    const res = await fetch(`${baseUrl}/api/rooms/ABC123`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer secret-token' }
    })
    expect(res.status).toBe(200)
    expect(await store.getRoom('ABC123')).toBeNull()
  })

  it('不应返回 CORS 通配符响应头', async () => {
    await startAdmin()
    const res = await fetch(`${baseUrl}/health`)

    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('房间列表应返回 JSON 数组', async () => {
    await store.createRoom(makeRoom('ABC123'))
    await startAdmin()

    const res = await fetch(`${baseUrl}/api/rooms`)
    const body = await res.json() as Array<{ code: string; gamePort: number }>

    expect(res.status).toBe(200)
    expect(body).toHaveLength(1)
    expect(body[0].code).toBe('ABC123')
    expect(body[0].gamePort).toBe(25565)
  })
})
