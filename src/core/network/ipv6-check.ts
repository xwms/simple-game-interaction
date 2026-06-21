/**
 * 功能描述：IPv6 能力检测 — 检测本机 IPv6 网络能力
 *
 * 逻辑说明：1) 扫描系统网络接口，获取所有 IPv6 地址；
 *           2) 判断是否存在公网 IPv6 地址（非链路本地 fe80::，非唯一本地 fc00::）；
 *           3) 尝试通过 IPv6 TCP 连接外部服务器验证 IPv6 可达性。
 *           整个过程约 1-2 秒。
 *
 * @module ipv6-check
 */

import * as os from 'os'
import * as net from 'net'
import type { Ipv6CheckResult } from './types'

/**
 * 功能描述：获取本机所有 IPv6 地址
 *
 * 逻辑说明：遍历所有网络接口，收集 IPv6 地址。
 *           排除内部回环地址（::1）。
 *
 * @returns IPv6 地址列表
 */
function getLocalIpv6Addresses(): string[] {
  const addresses: string[] = []
  const interfaces = os.networkInterfaces()

  for (const iface of Object.values(interfaces)) {
    if (!iface) continue
    for (const info of iface) {
      if (info.family === 'IPv6' && info.address !== '::1') {
        addresses.push(info.address)
      }
    }
  }

  return addresses
}

/**
 * 功能描述：判断是否为公网 IPv6 地址
 *
 * 逻辑说明：公网 IPv6 地址不以 fe80（链路本地）、fc00/fd00（唯一本地地址）
 *           开头。2000::/3 是全局单播地址范围。
 *
 * @param address - IPv6 地址
 * @returns 是否为公网地址
 */
function isPublicIpv6(address: string): boolean {
  const lower = address.toLowerCase()
  // 链路本地地址
  if (lower.startsWith('fe80')) return false
  // 唯一本地地址 (ULA)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return false
  // 多播地址
  if (lower.startsWith('ff')) return false
  // 环回地址
  if (lower === '::1') return false
  // 剩余的一般是全局单播地址 (2000::/3)
  return true
}

/**
 * 功能描述：获取公网 IPv6 地址列表
 *
 * @param addresses - 所有 IPv6 地址
 * @returns 公网 IPv6 地址列表
 */
function getPublicIpv6Addresses(addresses: string[]): string[] {
  return addresses.filter(isPublicIpv6)
}

/**
 * 功能描述：尝试 IPv6 TCP 连接验证可达性
 *
 * 逻辑说明：连接 Google 的 IPv6 服务器验证 IPv6 外网可达性。
 *           连接成功说明本机 IPv6 出站正常。
 *
 * @param timeoutMs - 超时时间（毫秒）
 * @returns 是否可达
 */
async function checkIpv6Reachability(timeoutMs: number = 3000): Promise<boolean> {
  // 多个 IPv6 可访问的目标
  const targets: Array<{ host: string; port: number }> = [
    { host: 'ipv6.google.com', port: 80 },
    { host: 'ipv6.l.google.com', port: 80 }
  ]

  for (const target of targets) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new net.Socket()
        socket.setTimeout(timeoutMs)

        socket.once('connect', () => {
          socket.destroy()
          resolve()
        })

        socket.once('error', (err) => {
          socket.destroy()
          reject(err)
        })

        socket.once('timeout', () => {
          socket.destroy()
          reject(new Error('Timeout'))
        })

        socket.connect(target.port, target.host)
      })
      return true
    } catch {
      continue
    }
  }

  return false
}

/**
 * 功能描述：执行 IPv6 能力检测
 *
 * 逻辑说明：并行扫描网卡和检测可达性。
 *           如果本机有公网 IPv6 地址，则认为 hasPublicV6 = true；
 *           如果 IPv6 外网可达，则 available = true。
 *
 * @param timeoutMs - 检测超时
 * @returns IPv6 检测结果
 */
export async function checkIpv6Capability(
  timeoutMs: number = 5000
): Promise<Ipv6CheckResult> {
  // 网卡扫描（快速，本地操作）
  const addresses = getLocalIpv6Addresses()
  const publicAddresses = getPublicIpv6Addresses(addresses)

  // 如果没有任何 IPv6 地址，直接返回
  if (addresses.length === 0) {
    return {
      available: false,
      hasPublicV6: false,
      addresses: [],
      publicAddresses: []
    }
  }

  // 有公网 IPv6 地址 → 尝试验证可达性
  if (publicAddresses.length > 0) {
    const reachable = await checkIpv6Reachability(timeoutMs)
    return {
      available: reachable,
      hasPublicV6: true,
      addresses,
      publicAddresses
    }
  }

  // 仅有链路本地地址，IPv6 可能可用但没有公网 IPv6
  return {
    available: false,
    hasPublicV6: false,
    addresses,
    publicAddresses
  }
}
