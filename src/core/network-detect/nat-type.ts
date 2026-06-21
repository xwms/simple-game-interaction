/**
 * 功能描述：NAT 类型检测 — 基于 STUN (RFC 5389) 检测 NAT 映射行为
 *
 * 逻辑说明：单阶段多服务器映射行为检测，参照 FRP classify.go 的 EasyNAT/HardNAT 分类：
 *
 *           同一个 UDP socket 向多个 STUN 服务器发送 Binding Request，
 *           收集响应后比对映射端口。同时从响应中提取 OTHER-ADDRESS 属性，
 *           向该额外目标再次查询以获得更多映射数据点。
 *
 *           映射端口全部一致 → EasyNAT（Endpoint-Independent Mapping）
 *           存在任何差异     → HardNAT（Address-Dependent Mapping）
 *
 *           稳定性验证：重新查询最快服务器，确认映射地址不变。
 *           若发生变化 → 保守判定为 HardNAT。
 *
 * @module nat-type
 */

import * as dgram from 'dgram'
import * as crypto from 'crypto'
import * as os from 'os'
import type { NatCheckResult, MappingBehavior, FilteringBehavior } from './types'
import type { NatType } from '@shared/types'

// ─── STUN 协议常量 ─────────────────────────────────────
const STUN_BINDING_REQUEST = 0x0001
const STUN_SUCCESS_RESPONSE = 0x0101
const STUN_MAGIC_COOKIE = 0x2112a442

// STUN 属性类型
const STUN_ATTR_MAPPED_ADDRESS = 0x0001
const STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020

// ─── 默认 STUN 服务器 ─────────────────────────────────
const DEFAULT_STUN_SERVERS: string[] = [
  'stun.miwifi.com:3478',
  'stun.chat.bilibili.com:3478',
  'stun.cloudflare.com:3478',
  'stun.l.google.com:19302'
]

/** OTHER-ADDRESS (RFC 5389) / CHANGED-ADDRESS (RFC 3489) */
const STUN_ATTR_CHANGED_ADDRESS = 0x0005
const STUN_ATTR_OTHER_ADDRESS = 0x8023
const STUN_ATTR_OTHER_ADDRESS_2 = 0x802B

/** STUN 服务器响应 */
interface StunResponse {
  mappedAddress: string
  mappedPort: number
  serverAddress: string
  latencyMs: number
  raw: Buffer
}

/**
 * 功能描述：生成 STUN Binding Request 消息
 *
 * 逻辑说明：根据 RFC 5389 生成 STUN 消息格式。
 *
 * @returns 消息 buffer 和事务 ID
 */
function createStunRequest(): { buffer: Buffer; transactionId: Buffer } {
  const transactionId = crypto.randomBytes(12)
  const buffer = Buffer.alloc(20)
  buffer.writeUInt16BE(STUN_BINDING_REQUEST, 0)
  buffer.writeUInt16BE(0, 2)
  buffer.writeUInt32BE(STUN_MAGIC_COOKIE, 4)
  transactionId.copy(buffer, 8)
  return { buffer, transactionId }
}

/**
 * 功能描述：解析 STUN 响应
 *
 * 逻辑说明：验证 Magic Cookie 和 Transaction ID，提取
 *           XOR-MAPPED-ADDRESS 或 MAPPED-ADDRESS 属性。
 *
 * @param response - 响应数据
 * @param transactionId - 期望的事务 ID
 * @returns 解析后的映射地址，解析失败返回 null
 */
function parseStunResponse(
  response: Buffer,
  transactionId: Buffer
): { address: string; port: number } | null {
  if (response.length < 20) return null

  const messageType = response.readUInt16BE(0)
  const cookie = response.readUInt32BE(4)
  const receivedTid = response.subarray(8, 20)

  if (cookie !== STUN_MAGIC_COOKIE) return null
  if (!receivedTid.equals(transactionId)) return null
  if (messageType !== STUN_SUCCESS_RESPONSE) return null

  const length = response.readUInt16BE(2)
  let offset = 20
  const end = offset + length

  while (offset + 4 <= end) {
    const attrType = response.readUInt16BE(offset)
    const attrLength = response.readUInt16BE(offset + 2)
    const attrValue = response.subarray(offset + 4, offset + 4 + attrLength)

    if (attrType === STUN_ATTR_XOR_MAPPED_ADDRESS && attrLength >= 8) {
      const family = attrValue.readUInt8(1)
      const xorPort = attrValue.readUInt16BE(2) ^ (STUN_MAGIC_COOKIE >> 16)

      if (family === 0x01) {
        const xorAddr = attrValue.readUInt32BE(4) ^ STUN_MAGIC_COOKIE
        const address = [
          (xorAddr >>> 24) & 0xff,
          (xorAddr >>> 16) & 0xff,
          (xorAddr >>> 8) & 0xff,
          xorAddr & 0xff
        ].join('.')
        return { address, port: xorPort }
      }
      return { address: '::1', port: xorPort }
    }

    if (attrType === STUN_ATTR_MAPPED_ADDRESS && attrLength >= 8) {
      const family = attrValue.readUInt8(1)
      const port = attrValue.readUInt16BE(2)

      if (family === 0x01) {
        const address = Array.from(attrValue.subarray(4, 8))
          .map((b) => b.toString())
          .join('.')
        return { address, port }
      }
    }

    offset += 4 + attrLength
    if (attrLength % 4 !== 0) {
      offset += 4 - (attrLength % 4)
    }
  }

  return null
}

/**
 * 功能描述：从 STUN 响应中提取 OTHER-ADDRESS / CHANGED-ADDRESS
 *
 * 逻辑说明：OTHER-ADDRESS（RFC 5389, type 0x8023）和
 *           CHANGED-ADDRESS（RFC 3489, type 0x0005）表示 STUN 服务器的
 *           另一个 IP:PORT。向该地址发送 Binding Request 可获取另一个
 *           映射数据点，用于判断 NAT 映射行为是否为地址相关。
 *
 * @param response - STUN 响应原始数据
 * @returns 地址和端口，未找到返回 null
 */
function extractChangedAddress(response: Buffer): { address: string; port: number } | null {
  if (response.length < 20) return null
  const length = response.readUInt16BE(2)
  let offset = 20
  const end = offset + length

  while (offset + 4 <= end) {
    const attrType = response.readUInt16BE(offset)
    const attrLength = response.readUInt16BE(offset + 2)
    const attrValue = response.subarray(offset + 4, offset + 4 + attrLength)

    if ((attrType === STUN_ATTR_CHANGED_ADDRESS || attrType === STUN_ATTR_OTHER_ADDRESS || attrType === STUN_ATTR_OTHER_ADDRESS_2) && attrLength >= 8) {
      const family = attrValue.readUInt8(1)
      const port = attrValue.readUInt16BE(2)
      if (family === 0x01) {
        const address = Array.from(attrValue.subarray(4, 8))
          .map(b => b.toString()).join('.')
        return { address, port }
      }
    }

    offset += 4 + attrLength
    if (attrLength % 4 !== 0) offset += 4 - (attrLength % 4)
  }
  return null
}

/**
 * 功能描述：向 OTHER-ADDRESS 发送 STUN 请求
 *
 * 逻辑说明：复用已有 socket，向提取的 second 目标发送 Binding Request，
 *           获取该目标下的 NAT 映射地址，用于与主服务器对比。
 *
 * @param socket - 已绑定的 UDP socket
 * @param target - 目标地址和端口
 * @param timeoutMs - 超时时间
 * @returns 响应信息，失败返回 null
 */
async function queryOtherAddress(
  socket: dgram.Socket,
  target: { address: string; port: number },
  timeoutMs: number = 3000
): Promise<StunResponse | null> {
  const serverAddr = `${target.address}:${target.port}`
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await _queryOnce(socket, target.address, target.port, serverAddr, timeoutMs)
    if (result) return result
  }
  return null
}

/**
 * 功能描述：通过已有 socket 向 STUN 服务器发送请求
 *
 * 逻辑说明：复用已有 socket（保持同一本地端口），向指定服务器发送 Binding Request，
 *           等待匹配 transaction ID 的响应。超时无响应时自动重试一次（防 UDP 丢包）。
 *
 * @param socket - 已绑定的 UDP socket
 * @param serverAddr - 服务器地址（host:port）
 * @param timeoutMs - 每次尝试的超时时间
 * @returns 响应信息，失败返回 null
 */
async function queryOnSocket(
  socket: dgram.Socket,
  serverAddr: string,
  timeoutMs: number = 3000
): Promise<StunResponse | null> {
  const [host, portStr] = serverAddr.split(':')
  const port = parseInt(portStr, 10)
  if (!host || isNaN(port)) return null

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await _queryOnce(socket, host, port, serverAddr, timeoutMs)
    if (result) return result
  }
  return null
}

async function _queryOnce(
  socket: dgram.Socket,
  host: string,
  port: number,
  serverAddr: string,
  timeoutMs: number
): Promise<StunResponse | null> {
  const start = Date.now()
  const { buffer, transactionId } = createStunRequest()

  return new Promise((resolve) => {
    let settled = false

    const onMessage = (msg: Buffer) => {
      if (settled) return
      const result = parseStunResponse(msg, transactionId)
      if (result) {
        settled = true
        socket.off('message', onMessage)
        resolve({
          mappedAddress: result.address,
          mappedPort: result.port,
          serverAddress: serverAddr,
          latencyMs: Date.now() - start,
          raw: msg
        })
      }
    }

    socket.on('message', onMessage)

    socket.send(buffer, 0, buffer.length, port, host, (err) => {
      if (err) {
        settled = true
        socket.off('message', onMessage)
        resolve(null)
      }
    })

    setTimeout(() => {
      if (!settled) {
        settled = true
        socket.off('message', onMessage)
        resolve(null)
      }
    }, timeoutMs)
  })
}

/**
 * 功能描述：创建 UDP socket 并绑定到随机端口
 *
 * @param timeoutMs - 超时时间
 * @returns socket，失败返回 null
 */
async function createUdpSocket(timeoutMs: number = 2000): Promise<dgram.Socket | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4')
    const timer = setTimeout(() => {
      socket.close()
      resolve(null)
    }, timeoutMs)
    socket.once('listening', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      socket.close()
      resolve(null)
    })
    socket.bind()
  })
}

/**
 * 功能描述：检测 NAT 类型
 *
 * 逻辑说明：单阶段多服务器映射检测，参照 FRP 的 EasyNAT/HardNAT 分类：
 *
 *           1. 同一个 socket 向多个 STUN 服务器并发发送 Binding Request
 *           2. 从响应中提取 OTHER-ADDRESS 作为额外目标查询
 *           3. 收集所有映射地址，全部端口一致 → EasyNAT，存在差异 → HardNAT
 *           4. 稳定性验证：重新查询最快服务器确认映射未变化
 *
 * @param stunServers - STUN 服务器列表
 * @param timeoutMs - 每个请求超时
 * @returns NAT 检测结果
 */
export async function detectNatType(
  stunServers: string[] = DEFAULT_STUN_SERVERS,
  timeoutMs: number = 5000
): Promise<NatCheckResult> {
  const localAddresses = getLocalIpv4Addresses()

  const socket = await createUdpSocket(2000)
  if (!socket) {
    return {
      natType: 'unknown',
      mappingBehavior: 'unknown',
      filteringBehavior: 'unknown',
      publicIp: '0.0.0.0',
      publicPort: 0,
      localAddresses
    }
  }

  const _unknownResult = (ip = '0.0.0.0', port = 0) => ({
    natType: 'unknown' as NatType,
    mappingBehavior: 'unknown' as MappingBehavior,
    filteringBehavior: 'unknown' as FilteringBehavior,
    publicIp: ip, publicPort: port, localAddresses
  })

  try {
    // ── 多服务器 STUN 并行查询 ──
    const QUERY_TIMEOUT = Math.min(timeoutMs, 1500)
    const responses: StunResponse[] = []
    const otherAddrResponses: StunResponse[] = []

    const settled = await Promise.allSettled(
      stunServers.map(server => queryOnSocket(socket, server, QUERY_TIMEOUT))
    )
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value !== null) {
        responses.push(r.value)
      }
    }

    if (responses.length === 0) return _unknownResult()

    // 从任一响应中提取 OTHER-ADDRESS 作为第二个目标
    for (const resp of responses) {
      const other = extractChangedAddress(resp.raw)
      if (other) {
        const cr = await queryOtherAddress(socket, other, QUERY_TIMEOUT)
        if (cr) { otherAddrResponses.push(cr); break }
      }
    }

    if (responses.length === 0) return _unknownResult()

    // 取延迟最低的响应作为主地址
    const best = responses.reduce((a, b) =>
      a.latencyMs < b.latencyMs ? a : b
    )
    const { mappedAddress, mappedPort } = best

    // 检查是否无 NAT（公网 IP）
    if (localAddresses.includes(mappedAddress)) {
      return {
        natType: 'none',
        mappingBehavior: 'endpoint-independent',
        filteringBehavior: 'endpoint-independent',
        publicIp: mappedAddress,
        publicPort: mappedPort,
        localAddresses
      }
    }

    // ── 映射稳定性验证 ──
    const verifyResult = await queryOnSocket(socket, best.serverAddress, 2000)
    if (verifyResult) {
      const mappingStable = verifyResult.mappedAddress === mappedAddress
        && verifyResult.mappedPort === mappedPort
      if (!mappingStable) {
        // 映射发生变化 → 保守判定为 HardNAT
        return {
          natType: 'hard-nat',
          mappingBehavior: 'address-and-port-dependent',
          filteringBehavior: 'unknown',
          publicIp: mappedAddress, publicPort: mappedPort, localAddresses
        }
      }
    }

    // ── EasyNAT / HardNAT 判定 ──
    // 收集所有映射数据点，对比映射地址和端口
    const allMappings = [...responses, ...otherAddrResponses]
    let mappingBehavior: MappingBehavior = 'unknown'
    let natType: NatType = 'easy-nat'

    if (allMappings.length >= 2) {
      const uniqueMappings = new Set(
        allMappings.map(r => `${r.mappedAddress}:${r.mappedPort}`)
      )
      if (uniqueMappings.size > 1) {
        natType = 'hard-nat'
        mappingBehavior = 'address-dependent'
      } else {
        mappingBehavior = 'endpoint-independent'
      }
    }

    // 单服务器响应场景：最佳推测为 endpoint-independent
    if (responses.length < 2 && mappingBehavior === 'unknown') {
      mappingBehavior = 'endpoint-independent'
    }

    return {
      natType,
      mappingBehavior,
      filteringBehavior: 'unknown',
      publicIp: mappedAddress, publicPort: mappedPort, localAddresses
    }
  } finally {
    socket.close()
  }
}

/**
 * 功能描述：获取本机 IPv4 地址列表
 *
 * @returns IPv4 地址列表
 */
function getLocalIpv4Addresses(): string[] {
  const addresses: string[] = []
  const interfaces = os.networkInterfaces()

  for (const iface of Object.values(interfaces)) {
    if (!iface) continue
    for (const info of iface) {
      if (info.family === 'IPv4' && !info.internal) {
        addresses.push(info.address)
      }
    }
  }

  return addresses
}
