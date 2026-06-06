/**
 * 功能描述：NAT 类型检测 — 基于 STUN (RFC 3489/5389) 检测 NAT 类型
 *
 * 逻辑说明：两阶段检测 + 映射稳定性验证，全程使用同一 UDP socket 确保 NAT 映射一致：
 *
 *           Phase 1（多服务器映射行为检测）：
 *             同一个 socket 向多个 STUN 服务器发送 Binding Request，
 *             收集至少 2 个独立响应后比对映射端口差异。
 *             映射端口一致 → Endpoint-Independent Mapping
 *             映射端口不同 → Address-Dependent Mapping（即 Symmetric NAT）
 *
 *           Phase 2（CHANGE-REQUEST 过滤行为检测）：
 *             Phase 1 确认是 Cone NAT 后，至多尝试 2 台延迟最低的服务器。
 *             使用 RFC 3489 CHANGE-REQUEST 属性区分过滤行为：
 *               - 换 IP+端口能收到 → Endpoint-Independent Filtering（Full Cone）
 *               - 仅换端口能收到   → Address-Dependent Filtering（Restricted Cone）
 *               - 均无响应         → Port Restricted Cone
 *
 *           稳定性验证：
 *             Phase 1 完成后重新查询最快服务器，确认映射地址不变。
 *             若映射发生变化，说明 NAT 端口分配不稳定，保守判定为 Symmetric。
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
const STUN_ATTR_CHANGE_REQUEST = 0x0003

/** CHANGE-REQUEST 标志 */
const CHANGE_REQUEST_CHANGE_IP = 0x00000004
const CHANGE_REQUEST_CHANGE_PORT = 0x00000002

// ─── 默认 STUN 服务器 ─────────────────────────────────
const DEFAULT_STUN_SERVERS: string[] = [
  'stun.l.google.com:19302',
  'stun1.l.google.com:19302',
  'stun2.l.google.com:19302',
  'stun.stunprotocol.org:3478',
  'stun.iptel.org:3478'
]

/** STUN 服务器响应 */
interface StunResponse {
  mappedAddress: string
  mappedPort: number
  serverAddress: string
  latencyMs: number
}

/**
 * 功能描述：生成 STUN Binding Request 消息
 *
 * 逻辑说明：根据 RFC 5389 生成 STUN 消息格式。
 *           当 changeRequest 非 0 时，追加 CHANGE-REQUEST 属性，
 *           请求服务器从不同 IP 和/或端口回包（RFC 3489）。
 *
 * @param changeRequest - CHANGE-REQUEST 标志（0x04=换IP, 0x02=换端口, 0x06=都换），0=普通请求
 * @returns 消息 buffer 和事务 ID
 */
function createStunRequest(changeRequest: number = 0): { buffer: Buffer; transactionId: Buffer } {
  const transactionId = crypto.randomBytes(12)

  // CHANGE-REQUEST 属性为 8 字节（4 字节属性头 + 4 字节值）
  const attrLen = changeRequest !== 0 ? 8 : 0
  const buffer = Buffer.alloc(20 + attrLen)

  // 消息类型 (2 字节): Binding Request
  buffer.writeUInt16BE(STUN_BINDING_REQUEST, 0)

  // 消息长度 (2 字节)
  buffer.writeUInt16BE(attrLen, 2)

  // Magic Cookie (4 字节)
  buffer.writeUInt32BE(STUN_MAGIC_COOKIE, 4)

  // Transaction ID (12 字节)
  transactionId.copy(buffer, 8)

  if (changeRequest !== 0) {
    buffer.writeUInt16BE(STUN_ATTR_CHANGE_REQUEST, 20)  // type
    buffer.writeUInt16BE(4, 22)                          // length
    buffer.writeUInt32BE(changeRequest, 24)              // value
  }

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

  // 验证 Magic Cookie 和 Transaction ID
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
      // XOR-MAPPED-ADDRESS: 1 byte padding + 1 byte family + 2 bytes port + 16/4 bytes address
      const family = attrValue.readUInt8(1)
      const xorPort = attrValue.readUInt16BE(2) ^ (STUN_MAGIC_COOKIE >> 16)

      if (family === 0x01) {
        // IPv4: 4 字节地址
        const xorAddr = attrValue.readUInt32BE(4) ^ STUN_MAGIC_COOKIE
        const address = [
          (xorAddr >>> 24) & 0xff,
          (xorAddr >>> 16) & 0xff,
          (xorAddr >>> 8) & 0xff,
          xorAddr & 0xff
        ].join('.')
        return { address, port: xorPort }
      }
      // IPv6 简化处理
      return { address: '::1', port: xorPort }
    }

    if (attrType === STUN_ATTR_MAPPED_ADDRESS && attrLength >= 8) {
      // MAPPED-ADDRESS: 1 byte padding + 1 byte family + 2 bytes port + 4/16 bytes address
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
    // 对齐到 4 字节
    if (attrLength % 4 !== 0) {
      offset += 4 - (attrLength % 4)
    }
  }

  return null
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
 * 功能描述：发送 CHANGE-REQUEST 探测
 *
 * 逻辑说明：通过已有 socket 发送带 CHANGE-REQUEST 属性的 STUN 请求，
 *           等待服务器从不同 IP/端口回包。超时无响应时自动重试一次。
 *
 * @param socket - 已绑定的 UDP socket
 * @param serverAddr - 服务器地址（host:port）
 * @param changeRequest - CHANGE-REQUEST 标志
 * @param timeoutMs - 每次尝试的超时时间
 * @returns 是否收到有效响应
 */
async function sendChangeRequest(
  socket: dgram.Socket,
  serverAddr: string,
  changeRequest: number,
  timeoutMs: number = 2000
): Promise<boolean> {
  const [host, portStr] = serverAddr.split(':')
  const port = parseInt(portStr, 10)
  if (!host || isNaN(port)) return false

  for (let attempt = 0; attempt < 2; attempt++) {
    const ok = await _sendChangeRequestOnce(socket, host, port, changeRequest, timeoutMs)
    if (ok) return true
  }
  return false
}

async function _sendChangeRequestOnce(
  socket: dgram.Socket,
  host: string,
  port: number,
  changeRequest: number,
  timeoutMs: number
): Promise<boolean> {
  const { buffer, transactionId } = createStunRequest(changeRequest)

  return new Promise((resolve) => {
    let settled = false

    const onMessage = (msg: Buffer) => {
      const result = parseStunResponse(msg, transactionId)
      if (result !== null) {
        cleanup()
        resolve(true)
      }
    }

    const onError = () => {
      cleanup()
      resolve(false)
    }

    function cleanup() {
      settled = true
      socket.off('message', onMessage)
      socket.off('error', onError)
    }

    socket.on('message', onMessage)
    socket.on('error', onError)

    socket.send(buffer, 0, buffer.length, port, host, (err) => {
      if (err) {
        cleanup()
        resolve(false)
      }
    })

    setTimeout(() => {
      if (!settled) {
        cleanup()
        resolve(false)
      }
    }, timeoutMs)
  })
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

  // 最多尝试 2 次，防 UDP 丢包
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
          latencyMs: Date.now() - start
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
 * 功能描述：检测 NAT 类型
 *
 * 逻辑说明：两阶段检测 + 映射稳定性验证，全程使用同一 UDP socket 确保 NAT 映射一致：
 *
 *           Phase 1（多服务器映射行为检测）：
 *             同一个 socket 向多个 STUN 服务器发送 Binding Request，
 *             收集到 3 个响应即提前退出（足够判断映射行为）。
 *             不足 2 个时尽力尝试剩余服务器凑足第二个数据点。
 *             映射端口一致 → Endpoint-Independent Mapping
 *             映射端口不同 → Address-Dependent Mapping（即 Symmetric NAT）
 *
 *           稳定性验证：
 *             重新查询最快服务器，确认映射地址/端口未发生变化。
 *             若变化 → 保守判定为 Symmetric NAT。
 *
 *           Phase 2（CHANGE-REQUEST 过滤行为检测）：
 *             至多尝试 2 台延迟最低的服务器（避免长时间等待不支持 RFC 3489 的服务器）。
 *             使用 CHANGE-REQUEST 属性区分三种过滤行为：
 *               - 换 IP+端口能收到 → Endpoint-Independent Filtering（Full Cone）
 *               - 仅换端口能收到   → Address-Dependent Filtering（Restricted Cone）
 *               - 均无响应         → Port Restricted Cone（最保守默认）
 *
 * @param stunServers - STUN 服务器列表，默认 5 台
 * @param timeoutMs - 每个请求超时，实际以 2500ms 封顶
 * @returns NAT 检测结果
 */
export async function detectNatType(
  stunServers: string[] = DEFAULT_STUN_SERVERS,
  timeoutMs: number = 5000
): Promise<NatCheckResult> {
  const localAddresses = getLocalIpv4Addresses()

  // 创建单例 socket（整个检测周期复用同一本地端口）
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
    // ── Phase 1: STUN Binding Request — 对称性 + 映射行为检测 ──
    // 同一 socket 顺序发往所有服务器，避免响应交叉混淆。
    // 收集到 3 个响应即足够判断映射行为，后续无需继续等待。
    // 若不足 2 个，则继续尝试所有剩余服务器，尽力获取第二个数据点。
    const QUERY_TIMEOUT = Math.min(timeoutMs, 2500)
    const responses: StunResponse[] = []

    for (const server of stunServers) {
      const resp = await queryOnSocket(socket, server, QUERY_TIMEOUT)
      if (resp) {
        responses.push(resp)
        if (responses.length >= 3) break
      }
    }

    // 不足 2 个响应时继续尝试剩余服务器（尽力获取第二个映射数据点）
    if (responses.length < 2) {
      for (const server of stunServers) {
        if (responses.some(r => r.serverAddress === server)) continue
        const resp = await queryOnSocket(socket, server, QUERY_TIMEOUT)
        if (resp) responses.push(resp)
        if (responses.length >= 2) break
      }
    }

    if (responses.length === 0) return _unknownResult()

    // 取延迟最低的响应作为主地址
    const best = responses.reduce((a, b) =>
      a.latencyMs < b.latencyMs ? a : b
    )
    const { mappedAddress, mappedPort } = best

    // 检查是否无 NAT
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
    // 重新请求最佳服务器，确认映射地址/端口未变化。
    // 若发生变化（NAT 映射超时过短或路由器行为异常），保守判为 Symmetric。
    const verifyResult = await queryOnSocket(socket, best.serverAddress, 2000)
    if (verifyResult) {
      const mappingStable = verifyResult.mappedAddress === mappedAddress
        && verifyResult.mappedPort === mappedPort
      if (!mappingStable) {
        return {
          natType: 'symmetric',
          mappingBehavior: 'address-and-port-dependent',
          filteringBehavior: 'address-and-port-dependent',
          publicIp: mappedAddress, publicPort: mappedPort, localAddresses
        }
      }
    }

    // 判断 Mapping Behavior：同一端口 → Endpoint-Independent；不同 → Address-Dependent
    let mappingBehavior: MappingBehavior = 'unknown'
    if (responses.length >= 2) {
      const uniqueMappings = new Set(
        responses.map((r) => `${r.mappedAddress}:${r.mappedPort}`)
      )
      mappingBehavior = uniqueMappings.size > 1
        ? 'address-dependent'
        : 'endpoint-independent'
    }

    // 单服务器响应场景：通过稳定性验证后标记为 endpoint-independent（最佳推测）
    if (responses.length < 2 && mappingBehavior === 'unknown') {
      mappingBehavior = 'endpoint-independent'
    }

    // Symmetric NAT = Address-Dependent Mapping
    if (mappingBehavior === 'address-dependent') {
      return {
        natType: 'symmetric',
        mappingBehavior,
        filteringBehavior: 'address-and-port-dependent',
        publicIp: mappedAddress, publicPort: mappedPort, localAddresses
      }
    }

    // ── Phase 2: CHANGE-REQUEST — 过滤行为检测 ──
    // 双服务器限：按延迟排序，至多尝试 2 台最快的服务器。
    // 某台不支持 CHANGE-REQUEST 时自动 fallback 到下一台。
    // 均不支持则默认 Port Restricted Cone（最保守的锥型类型）。
    const sortedServers = [...responses].sort((a, b) => a.latencyMs - b.latencyMs)
    const CHANGE_REQUEST_SERVER_LIMIT = 2

    let filteringBehavior: FilteringBehavior = 'unknown'
    let natType: NatType = 'port-restricted-cone'

    for (let i = 0; i < Math.min(sortedServers.length, CHANGE_REQUEST_SERVER_LIMIT); i++) {
      const { serverAddress } = sortedServers[i]
      if (await sendChangeRequest(socket, serverAddress,
        CHANGE_REQUEST_CHANGE_IP | CHANGE_REQUEST_CHANGE_PORT, 1500)) {
        filteringBehavior = 'endpoint-independent'
        natType = 'full-cone'
        break
      }
      if (await sendChangeRequest(socket, serverAddress,
        CHANGE_REQUEST_CHANGE_PORT, 1500)) {
        filteringBehavior = 'address-dependent'
        natType = 'restricted-cone'
        break
      }
    }

    // 所有支持的服务器均不支持 CHANGE-REQUEST → Port Restricted Cone
    if (filteringBehavior === 'unknown') {
      filteringBehavior = 'address-and-port-dependent'
    }

    return {
      natType,
      mappingBehavior,
      filteringBehavior,
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
