/**
 * 连接路径选择器测试
 */

import { describe, it, expect } from 'vitest'
import { selectPath } from '../../../src/core/connection/path-selector'
import type { NetworkInfo, NatType } from '../../../src/shared/types'

function makeNetworkInfo(ipv6: { available: boolean; hasPublicV6: boolean }, natType: NatType): NetworkInfo {
  const mappingBehavior = natType === 'hard-nat' ? 'address-and-port-dependent'
    : natType === 'unknown' ? 'unknown'
    : 'endpoint-independent'

  return {
    ipv6: {
      available: ipv6.available,
      hasPublicV6: ipv6.hasPublicV6,
      addresses: ipv6.available ? ['2001:db8::1'] : []
    },
    ipv4: {
      natType,
      publicIp: '1.2.3.4',
      publicPort: 12345,
      mappingBehavior,
      filteringBehavior: natType === 'unknown' ? 'unknown' : 'endpoint-independent',
      localAddresses: []
    }
  }
}

describe('selectPath 路径选择', () => {
  it('双方均有公网 IPv6 时 IPv6 优先', () => {
    const server = makeNetworkInfo({ available: true, hasPublicV6: true }, 'none')
    const client = makeNetworkInfo({ available: true, hasPublicV6: true }, 'none')
    const paths = selectPath(server, client)

    expect(paths.length).toBeGreaterThanOrEqual(2)
    expect(paths[0].type).toBe('ipv6')
  })

  it('仅一方有 IPv6 时不应返回 IPv6 路径', () => {
    const server = makeNetworkInfo({ available: true, hasPublicV6: true }, 'none')
    const client = makeNetworkInfo({ available: false, hasPublicV6: false }, 'none')
    const paths = selectPath(server, client)

    expect(paths.every(p => p.type !== 'ipv6')).toBe(true)
  })

  it('双方 NAT 均可穿透时 P2P 可用', () => {
    const server = makeNetworkInfo({ available: false, hasPublicV6: false }, 'easy-nat')
    const client = makeNetworkInfo({ available: false, hasPublicV6: false }, 'easy-nat')
    const paths = selectPath(server, client)

    expect(paths.some(p => p.type === 'p2p')).toBe(true)
  })

  it('一方 HardNAT 时不应返回 P2P', () => {
    const server = makeNetworkInfo({ available: false, hasPublicV6: false }, 'hard-nat')
    const client = makeNetworkInfo({ available: false, hasPublicV6: false }, 'easy-nat')
    const paths = selectPath(server, client)

    expect(paths.every(p => p.type !== 'p2p')).toBe(true)
    expect(paths[paths.length - 1].type).toBe('relay')
  })

  it('一方 Unknown NAT 时不应返回 P2P（保守策略）', () => {
    const server = makeNetworkInfo({ available: false, hasPublicV6: false }, 'unknown')
    const client = makeNetworkInfo({ available: false, hasPublicV6: false }, 'easy-nat')
    const paths = selectPath(server, client)

    expect(paths.every(p => p.type !== 'p2p')).toBe(true)
  })

  it('双方 HardNAT 时不应返回 P2P', () => {
    const server = makeNetworkInfo({ available: false, hasPublicV6: false }, 'hard-nat')
    const client = makeNetworkInfo({ available: false, hasPublicV6: false }, 'hard-nat')
    const paths = selectPath(server, client)

    expect(paths.every(p => p.type !== 'p2p')).toBe(true)
    expect(paths.length).toBe(1)
    expect(paths[0].type).toBe('relay')
  })

  it('IPv6 + EasyNAT 应返回 IPv6 > P2P > Relay', () => {
    const server = makeNetworkInfo({ available: true, hasPublicV6: true }, 'easy-nat')
    const client = makeNetworkInfo({ available: true, hasPublicV6: true }, 'none')
    const paths = selectPath(server, client)

    expect(paths.length).toBeGreaterThanOrEqual(3)
    expect(paths[0].type).toBe('ipv6')
    expect(paths[1].type).toBe('p2p')
    expect(paths[paths.length - 1].type).toBe('relay')
  })

  it('无 NAT（公网 IP）时 P2P 可用', () => {
    const server = makeNetworkInfo({ available: false, hasPublicV6: false }, 'none')
    const client = makeNetworkInfo({ available: false, hasPublicV6: false }, 'none')
    const paths = selectPath(server, client)

    expect(paths.some(p => p.type === 'p2p')).toBe(true)
  })

  it('null 网络信息时仅返回 Relay', () => {
    const paths = selectPath(null, null)
    expect(paths).toHaveLength(1)
    expect(paths[0].type).toBe('relay')
  })

  it('一方为 null 时仅返回 Relay', () => {
    const server = makeNetworkInfo({ available: true, hasPublicV6: true }, 'none')
    const paths = selectPath(server, null)
    expect(paths).toHaveLength(1)
    expect(paths[0].type).toBe('relay')
  })

  it('路径包含 description 字段', () => {
    const server = makeNetworkInfo({ available: true, hasPublicV6: true }, 'none')
    const client = makeNetworkInfo({ available: true, hasPublicV6: true }, 'none')
    const paths = selectPath(server, client)

    for (const p of paths) {
      expect(p.description).toBeTruthy()
    }
  })

  it('所有 NAT 类型正确覆盖', () => {
    const natTypes: NatType[] = ['none', 'easy-nat', 'hard-nat', 'unknown']
    const server = makeNetworkInfo({ available: false, hasPublicV6: false }, 'none')

    for (const nat of natTypes) {
      const client = makeNetworkInfo({ available: false, hasPublicV6: false }, nat)
      const paths = selectPath(server, client)
      expect(paths.some(p => p.type === 'relay')).toBe(true)
    }
  })
})
