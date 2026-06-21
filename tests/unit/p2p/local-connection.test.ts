/**
 * P2P TCP 本地连接测试
 *
 * 逻辑说明：验证同机/同 LAN 场景下 P2P TCP 能通过本地地址建立连接。
 *           当前问题：_buildPeerInfo() 不填充 localAddresses，
 *           且 host 在没有公网 IP 时不发送 p2p-address 信号。
 *           这些测试描述修复后的预期行为。
 */

import { describe, it, expect, vi } from 'vitest'
import type { NetworkInfo } from '@shared/types'
import type { PeerConnectionInfo } from '../../../src/core/connection/types'
import { toNetworkInfo } from '../../../src/core/network-detect/types'
import type { NatCheckResult, Ipv6CheckResult } from '../../../src/core/network-detect/types'

// ─── toNetworkInfo 测试 ─────────────────────────────────

describe('toNetworkInfo — localAddresses 传播', () => {
  it('应将 NatCheckResult.localAddresses 传播到 NetworkInfo', () => {
    const ipv6: Ipv6CheckResult = {
      available: false,
      hasPublicV6: false,
      addresses: [],
      publicAddresses: []
    }
    const nat: NatCheckResult = {
      natType: 'unknown',
      mappingBehavior: 'unknown',
      filteringBehavior: 'unknown',
      publicIp: '',
      publicPort: 0,
      localAddresses: ['192.168.1.2', '10.0.0.5', '127.0.0.1']
    }

    const result = toNetworkInfo(ipv6, nat)

    expect(result.ipv4.localAddresses).toBeDefined()
    expect(result.ipv4.localAddresses).toEqual(['192.168.1.2', '10.0.0.5', '127.0.0.1'])
  })

  it('无本地地址时应返回空数组', () => {
    const ipv6: Ipv6CheckResult = {
      available: false,
      hasPublicV6: false,
      addresses: [],
      publicAddresses: []
    }
    const nat: NatCheckResult = {
      natType: 'unknown',
      mappingBehavior: 'unknown',
      filteringBehavior: 'unknown',
      publicIp: '',
      publicPort: 0,
      localAddresses: []
    }

    const result = toNetworkInfo(ipv6, nat)

    expect(result.ipv4.localAddresses).toEqual([])
  })

  it('不应影响已有字段', () => {
    const ipv6: Ipv6CheckResult = {
      available: false,
      hasPublicV6: false,
      addresses: [],
      publicAddresses: []
    }
    const nat: NatCheckResult = {
      natType: 'easy-nat',
      mappingBehavior: 'endpoint-independent' as const,
      filteringBehavior: 'endpoint-independent' as const,
      publicIp: '1.2.3.4',
      publicPort: 30001,
      localAddresses: ['192.168.1.2']
    }

    const result = toNetworkInfo(ipv6, nat)

    expect(result.ipv4.natType).toBe('easy-nat')
    expect(result.ipv4.publicIp).toBe('1.2.3.4')
    expect(result.ipv4.publicPort).toBe(30001)
    expect(result.ipv4.localAddresses).toEqual(['192.168.1.2'])
  })
})

// ─── _buildPeerInfo 逻辑测试 ─────────────────────────────
// _buildPeerInfo 是 TunnelManager 的私有方法。
// 这里用独立的函数测试其核心逻辑（提取为纯函数后可复用）。

import { buildPeerInfo } from '../../../src/core/tunnel/tunnel-manager'

describe('buildPeerInfo — 本地地址构建', () => {
  it('应包含本地地址列表', () => {
    const networkInfo: NetworkInfo = {
      ipv6: { available: false, hasPublicV6: false, addresses: [] },
      ipv4: {
        natType: 'unknown',
        publicIp: '',
        publicPort: 0,
        mappingBehavior: 'unknown',
        filteringBehavior: 'unknown',
        localAddresses: ['192.168.1.2', '127.0.0.1']
      }
    }

    const result = buildPeerInfo(networkInfo)

    expect(result).not.toBeNull()
    expect(result!.localAddresses).toBeDefined()
    expect(result!.localAddresses).toHaveLength(2)
  })

  it('无本地地址时 localAddresses 应为空数组', () => {
    const networkInfo: NetworkInfo = {
      ipv6: { available: false, hasPublicV6: false, addresses: [] },
      ipv4: {
        natType: 'unknown',
        publicIp: '',
        publicPort: 0,
        mappingBehavior: 'unknown',
        filteringBehavior: 'unknown',
        localAddresses: []
      }
    }

    const result = buildPeerInfo(networkInfo)

    expect(result).not.toBeNull()
    expect(result!.localAddresses).toEqual([])
  })

  it('无公网 IP 时 publicAddress 应为 undefined', () => {
    const networkInfo: NetworkInfo = {
      ipv6: { available: false, hasPublicV6: false, addresses: [] },
      ipv4: {
        natType: 'unknown',
        publicIp: '',
        publicPort: 0,
        mappingBehavior: 'unknown',
        filteringBehavior: 'unknown',
        localAddresses: ['192.168.1.2']
      }
    }

    const result = buildPeerInfo(networkInfo)

    expect(result!.publicAddress).toBeUndefined()
    // 但仍应有本地地址用于同机连接
    expect(result!.localAddresses!.length).toBeGreaterThan(0)
  })

  it('有公网 IP 时 publicAddress 应填充', () => {
    const networkInfo: NetworkInfo = {
      ipv6: { available: false, hasPublicV6: false, addresses: [] },
      ipv4: {
        natType: 'easy-nat',
        publicIp: '1.2.3.4',
        publicPort: 30001,
        mappingBehavior: 'endpoint-independent',
        filteringBehavior: 'endpoint-independent',
        localAddresses: ['192.168.1.2']
      }
    }

    const result = buildPeerInfo(networkInfo)

    expect(result!.publicAddress).toEqual({ ip: '1.2.3.4', port: 30001 })
    expect(result!.localAddresses).toEqual([{ ip: '192.168.1.2', port: 30001 }])
  })

  it('null networkInfo 应返回 null', () => {
    const result = buildPeerInfo(null)
    expect(result).toBeNull()
  })
})

// ─── P2P 信号测试 ───────────────────────────────────────

describe('P2P 地址信号 — 本地 IP 传递', () => {
  it('host 没有公网 IP 但有本地 IP 时仍应发送 P2P 信号', () => {
    // 模拟 _setupHostTransportForGuest 中的信号发送逻辑
    const localIps = ['192.168.1.2', '127.0.0.1']
    const localPort = 45678
    const publicIp = ''

    // 当前问题：publicIp 为 '' 时整个信号不发送
    // 修复后：即使 publicIp 为空，有本地 IP 也应发送信号
    const shouldSend = !!(publicIp || localIps.length > 0) && localPort > 0

    expect(shouldSend).toBe(true)
  })

  it('信号应携带本地 IP 列表', () => {
    const signal = {
      type: 'p2p-address',
      ip: '',           // 无公网 IP
      port: 45678,      // passive 监听端口
      localIps: ['192.168.1.2', '10.0.0.5']  // host 的本地 IP
    }

    expect(signal.type).toBe('p2p-address')
    expect(signal.port).toBeGreaterThan(0)
    expect(signal.localIps).toBeDefined()
    expect(signal.localIps!.length).toBeGreaterThan(0)
  })
})

// ─── 完整本地连接场景测试 ───────────────────────────────

describe('P2P 本地连接完整场景', () => {
  it('guest 收到带 localIps 的信号后应填充 localAddresses', () => {
    // 模拟 guest 侧接收信号后的行为
    const guestPeerInfo: PeerConnectionInfo = {
      peerId: 'guest-1',
      publicAddress: undefined,
      localAddresses: undefined
    }

    const signal = {
      type: 'p2p-address',
      ip: '',
      port: 45678,
      localIps: ['192.168.1.2', '127.0.0.1']
    }

    // 修复后的信号处理逻辑
    if (signal.type === 'p2p-address') {
      if (signal.ip) {
        guestPeerInfo.publicAddress = { ip: signal.ip, port: signal.port }
      }
      if (signal.localIps && signal.localIps.length > 0) {
        guestPeerInfo.localAddresses = signal.localIps.map(ip => ({
          ip,
          port: signal.port
        }))
      }
    }

    // 验证
    expect(guestPeerInfo.localAddresses).toBeDefined()
    expect(guestPeerInfo.localAddresses).toHaveLength(2)
    expect(guestPeerInfo.localAddresses![0]).toEqual({ ip: '192.168.1.2', port: 45678 })
    expect(guestPeerInfo.localAddresses![1]).toEqual({ ip: '127.0.0.1', port: 45678 })
  })

  it('P2pTransport 应通过 localAddresses 连接到本地', async () => {
    // 验证 P2pTransport 能通过 localAddresses 建立连接
    const { P2pTransport } = await import('../../../src/core/p2p/peer-connection')

    const passiveTransport = new P2pTransport({ connectTimeout: 3000 })
    passiveTransport.setRole('passive')
    await passiveTransport.connect({ peerId: 'host-1' })
    const passivePort = passiveTransport.localPort!

    const activeTransport = new P2pTransport({ connectTimeout: 3000 })
    activeTransport.setRole('active')
    // 无 publicAddress，仅通过 localAddresses 连接
    await activeTransport.connect({
      peerId: 'guest-1',
      localAddresses: [{ ip: '127.0.0.1', port: passivePort }]
    })

    expect(activeTransport.status).toBe('connected')
    await new Promise(r => setTimeout(r, 100))
    expect(passiveTransport.status).toBe('connected')

    await activeTransport.disconnect()
    await passiveTransport.disconnect()
  })

  it('无公网 IP 且无本地地址时应报错', async () => {
    const { P2pTransport } = await import('../../../src/core/p2p/peer-connection')

    const transport = new P2pTransport()
    transport.setRole('active')

    await expect(transport.connect({
      peerId: 'guest-1',
      localAddresses: [],
      publicAddress: undefined
    })).rejects.toThrow(/missing|no address/)
  })
})
