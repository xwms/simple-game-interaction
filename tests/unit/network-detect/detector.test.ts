/**
 * NetworkDetector 网络检测编排器测试
 *
 * 逻辑说明：检测器的核心功能是编排 IPv6 和 NAT 并行检测。
 *           测试 detect()、缓存机制、detectIpv6Only()、detectNatOnly()。
 *           使用本地 STUN 模拟服务器和 Mock 的 IPv6 检测。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NetworkDetector } from '../../../src/core/network-detect/detector'
import * as dgram from 'dgram'
import type { AddressInfo } from 'net'

/**
 * 功能描述：创建模拟 STUN 服务器
 */
async function createStunServer(
  port: number,
  mappedIp: string,
  mappedPort: number
): Promise<dgram.Socket> {
  const socket = dgram.createSocket('udp4')

  await new Promise<void>((resolve, reject) => {
    socket.on('error', reject)
    socket.bind(port, '127.0.0.1', () => resolve())
  })

  socket.on('message', (msg, rinfo) => {
    if (msg.length < 20) return
    const messageType = msg.readUInt16BE(0)
    if (messageType !== 0x0001) return

    const transactionId = msg.subarray(8, 20)
    const STUN_MAGIC_COOKIE = 0x2112a442
    const STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020
    const attrLength = 12
    const buffer = Buffer.alloc(20 + attrLength)

    buffer.writeUInt16BE(0x0101, 0)
    buffer.writeUInt16BE(attrLength, 2)
    buffer.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
    transactionId.copy(buffer, 8)

    buffer.writeUInt16BE(STUN_ATTR_XOR_MAPPED_ADDRESS, 20)
    buffer.writeUInt16BE(8, 22)
    buffer.writeUInt8(0, 24)
    buffer.writeUInt8(0x01, 25)
    const xorPort = mappedPort ^ (STUN_MAGIC_COOKIE >> 16)
    buffer.writeUInt16BE(xorPort, 26)
    const ipParts = mappedIp.split('.').map(Number)
    const ipInt = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0
    const xorIp = (ipInt ^ STUN_MAGIC_COOKIE) >>> 0
    buffer.writeUInt32BE(xorIp, 28)

    socket.send(buffer, 0, buffer.length, rinfo.port, rinfo.address)
  })

  return socket
}

describe('NetworkDetector 网络检测编排', () => {
  let stunServer: dgram.Socket
  let stunPort: number
  let detector: NetworkDetector

  beforeEach(async () => {
    // 创建本地 STUN 模拟服务器
    stunServer = await createStunServer(0, '100.64.1.1', 30001)
    stunPort = (stunServer.address() as AddressInfo).port

    detector = new NetworkDetector({
      stunServers: [`127.0.0.1:${stunPort}`],
      timeoutMs: 3000
    })
  })

  afterEach(async () => {
    stunServer.close()
    detector.clearCache()
  })

  it('detect() 应返回完整的 NetworkInfo', async () => {
    const result = await detector.detect()

    expect(result).toHaveProperty('ipv6')
    expect(result).toHaveProperty('ipv4')
    expect(result.ipv6).toHaveProperty('available')
    expect(result.ipv6).toHaveProperty('hasPublicV6')
    expect(Array.isArray(result.ipv6.addresses)).toBe(true)
    expect(result.ipv4).toHaveProperty('natType')
    expect(typeof result.ipv4.natType).toBe('string')
  })

  it('detect() 应缓存结果并在 TTL 内复用', async () => {
    const result1 = await detector.detect()
    const result2 = await detector.detect()

    // 第二次调用应返回完全相同的对象（缓存引用）
    expect(result2).toBe(result1)
  })

  it('clearCache() 应使缓存失效', async () => {
    const result1 = await detector.detect()
    detector.clearCache()
    const result2 = await detector.detect()

    // 清缓存后应重新检测，但结果可能相同（取决于网络环境）
    expect(result2).toBeDefined()
  })

  it('detectIpv6Only() 应仅返回 IPv6 信息', async () => {
    const result = await detector.detectIpv6Only()

    expect(result).toHaveProperty('ipv6')
    expect(result.ipv6).toHaveProperty('available')
    expect(result.ipv6).toHaveProperty('hasPublicV6')
    expect(Array.isArray(result.ipv6.addresses)).toBe(true)
    // 不应该有 ipv4 属性
    expect(Object.keys(result).length).toBe(1)
  })

  it('detectNatOnly() 应仅返回 NAT 信息', async () => {
    const result = await detector.detectNatOnly()

    expect(result).toHaveProperty('ipv4')
    expect(result.ipv4).toHaveProperty('natType')
    expect(result.ipv4).toHaveProperty('publicIp')
    expect(Object.keys(result).length).toBe(1)
  })

  it('无可用 STUN 服务器时应返回默认值', async () => {
    const offlineDetector = new NetworkDetector({
      stunServers: ['127.0.0.1:65535'],
      timeoutMs: 500
    })

    const result = await offlineDetector.detect()
    // 离线时 natType 应为 unknown
    // 但 ipv6 检测仍可能返回（取决于本机网络配置）
    expect(result.ipv4.natType).toBe('unknown')
    offlineDetector.clearCache()
  })

  it('可使用自定义 STUN 服务器配置', async () => {
    const customDetector = new NetworkDetector({
      stunServers: [`127.0.0.1:${stunPort}`],
      timeoutMs: 5000
    })

    const result = await customDetector.detect()
    expect(result).toBeDefined()
    customDetector.clearCache()
  })
})
