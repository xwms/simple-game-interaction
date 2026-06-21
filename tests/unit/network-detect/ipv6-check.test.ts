/**
 * IPv6 能力检测测试
 */
import { describe, it, expect } from 'vitest'
import { checkIpv6Capability } from '../../../src/core/network/ipv6-check'

describe('IPv6 地址判断', () => {
  // 测试 isPublicIpv6 函数的逻辑（通过公共 API 间接测试）
  // 实际 IPv6 地址的判断逻辑在模块内部，通过网卡扫描结果验证

  it('应正确返回网络接口信息（集成测试）', async () => {
    const result = await checkIpv6Capability(2000)
    expect(result).toHaveProperty('available')
    expect(result).toHaveProperty('hasPublicV6')
    expect(Array.isArray(result.addresses)).toBe(true)
    expect(Array.isArray(result.publicAddresses)).toBe(true)
  })

  it('available 和 hasPublicV6 应为布尔值', async () => {
    const result = await checkIpv6Capability(2000)
    expect(typeof result.available).toBe('boolean')
    expect(typeof result.hasPublicV6).toBe('boolean')
  })

  it('publicAddresses 应是 addresses 的子集', async () => {
    const result = await checkIpv6Capability(2000)
    for (const addr of result.publicAddresses) {
      expect(result.addresses).toContain(addr)
    }
  })
})
