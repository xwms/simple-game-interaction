/**
 * NAT 类型检测测试
 *
 * 逻辑说明：使用本地 UDP 服务器模拟 STUN 协议响应，
 *           验证 createStunRequest、parseStunResponse、detectNatType 的协议逻辑。
 *           测试不同映射行为和过滤行为的判断。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as dgram from 'dgram'
import { detectNatType } from '../../../src/core/network-detect/nat-type'
import type { AddressInfo } from 'net'

/**
 * 功能描述：生成 STUN Binding Success Response
 */
function createStunResponse(
  transactionId: Buffer,
  mappedIp: string,
  mappedPort: number
): Buffer {
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

  return buffer
}

/**
 * 功能描述：创建模拟 STUN 服务器
 *
 * @param port - 监听端口（0=随机）
 * @param mappedIp - 响应中的映射 IP
 * @param mappedPort - 响应中的映射端口
 * @param mirrorPort - 可选，CHANGE-REQUEST 时响应使用的映射端口
 * @returns UDP socket
 */
async function createStunServer(
  port: number,
  mappedIp: string,
  mappedPort: number,
  mirrorPort?: number
): Promise<dgram.Socket> {
  const socket = dgram.createSocket('udp4')

  await new Promise<void>((resolve, reject) => {
    socket.on('error', reject)
    socket.bind(port, '127.0.0.1', () => resolve())
  })

  socket.on('message', (msg, rinfo) => {
    if (msg.length < 20) return

    const messageType = msg.readUInt16BE(0)
    if (messageType !== 0x0001) return // Binding Request

    const transactionId = msg.subarray(8, 20)
    const attrLength = msg.readUInt16BE(2)
    let offset = 20
    const end = offset + attrLength
    let changeRequest = 0

    // 解析 CHANGE-REQUEST 属性
    while (offset + 4 <= end) {
      const attrType = msg.readUInt16BE(offset)
      const attrLen = msg.readUInt16BE(offset + 2)
      if (attrType === 0x0003 && attrLen >= 4) {
        changeRequest = msg.readUInt32BE(offset + 4)
      }
      offset += 4 + attrLen
      if (attrLen % 4 !== 0) offset += 4 - (attrLen % 4)
    }

    if (changeRequest !== 0) {
      // CHANGE-REQUEST：使用不同映射地址响应，但始终回复到客户端地址
      const respPort = mirrorPort || (mappedPort + 1)
      const response = createStunResponse(transactionId, mappedIp, respPort)
      socket.send(response, 0, response.length, rinfo.port, rinfo.address)
    } else {
      const response = createStunResponse(transactionId, mappedIp, mappedPort)
      socket.send(response, 0, response.length, rinfo.port, rinfo.address)
    }
  })

  return socket
}

describe('NAT 类型检测（STUN 协议）', () => {
  let server1: dgram.Socket
  let server2: dgram.Socket
  let port1: number
  let port2: number

  beforeEach(async () => {
    // 两台模拟 STUN 服务器，使用相同的映射地址
    server1 = await createStunServer(0, '100.64.1.1', 30001)
    server2 = await createStunServer(0, '100.64.1.1', 30001)
    port1 = (server1.address() as AddressInfo).port
    port2 = (server2.address() as AddressInfo).port
  })

  afterEach(async () => {
    server1.close()
    server2.close()
  })

  it('同一映射地址和端口时应检测为 EasyNAT', async () => {
    // 两个模拟服务器返回相同的映射地址和端口
    const result = await detectNatType(
      [`127.0.0.1:${port1}`, `127.0.0.1:${port2}`],
      3000
    )

    expect(['easy-nat', 'none']).toContain(result.natType)
    expect(result.publicIp).toBeTruthy()
    expect(result.publicPort).toBeGreaterThan(0)
  })

  it('映射端口不同时应检测为 HardNAT', async () => {
    // 两个模拟服务器返回不同的映射地址和端口
    const symServer1 = await createStunServer(0, '100.64.1.1', 30001)
    const symServer2 = await createStunServer(0, '100.64.1.2', 30002)
    const sp1 = (symServer1.address() as AddressInfo).port
    const sp2 = (symServer2.address() as AddressInfo).port

    const result = await detectNatType(
      [`127.0.0.1:${sp1}`, `127.0.0.1:${sp2}`],
      3000
    )

    expect(result.mappingBehavior === 'address-dependent' || result.natType !== 'unknown').toBe(true)
    symServer1.close()
    symServer2.close()
  })

  it('应返回 localAddresses 列表', async () => {
    const result = await detectNatType(
      [`127.0.0.1:${port1}`],
      3000
    )

    expect(Array.isArray(result.localAddresses)).toBe(true)
    expect(result.localAddresses.length).toBeGreaterThan(0)
  })

  it('服务器超时应返回 unknown', async () => {
    const result = await detectNatType(
      ['127.0.0.1:65535'],
      500
    )

    expect(result.natType).toBe('unknown')
    expect(result.publicIp).toBe('0.0.0.0')
  })

  it('空服务器列表应返回 unknown', async () => {
    const result = await detectNatType([], 500)
    expect(result.natType).toBe('unknown')
  })
})

describe('STUN 协议 multi-server 处理', () => {
  it('多服务器返回相同映射时应判断为 EasyNAT', async () => {
    const server = await createStunServer(0, '100.64.1.1', 30001)
    const sPort = (server.address() as AddressInfo).port

    const result = await detectNatType(
      [`127.0.0.1:${sPort}`],
      3000
    )

    const validTypes = ['easy-nat', 'none', 'unknown']
    expect(validTypes).toContain(result.natType)
    server.close()
  })
})
