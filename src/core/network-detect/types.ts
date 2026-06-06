/**
 * 功能描述：网络检测模块本地类型定义
 *
 * 逻辑说明：补充 shared/types.ts 中 NetworkInfo 的内部类型。
 *           这些类型仅在网络检测模块内部使用。
 *
 * @module network-detect/types
 */

import type { NatType, NetworkInfo, MappingBehavior, FilteringBehavior } from '@shared/types'

// 从 shared 重新导出，使模块内部引用路径不变
export type { MappingBehavior, FilteringBehavior }

/** IPv6 检测结果（模块内部使用） */
export interface Ipv6CheckResult {
  available: boolean
  hasPublicV6: boolean
  addresses: string[]
  publicAddresses: string[]
}

/** NAT 检测结果（模块内部使用） */
export interface NatCheckResult {
  natType: NatType
  mappingBehavior: MappingBehavior
  filteringBehavior: FilteringBehavior
  publicIp: string
  publicPort: number
  localAddresses: string[]
}

/** 网络检测器配置 */
export interface NetworkDetectorConfig {
  /** STUN 服务器地址列表 */
  stunServers: string[]
  /** 检测超时（毫秒） */
  timeoutMs: number
}

/** 默认配置 */
export const DEFAULT_DETECTOR_CONFIG: NetworkDetectorConfig = {
  stunServers: [
    'stun.l.google.com:19302',
    'stun1.l.google.com:19302',
    'stun2.l.google.com:19302',
    'stun.stunprotocol.org:3478',
    'stun.iptel.org:3478'
  ],
  timeoutMs: 5000
}

/**
 * 功能描述：将内部检测结果转换为 NetworkInfo
 *
 * @param ipv6 - IPv6 检测结果
 * @param nat - NAT 检测结果
 * @returns 标准 NetworkInfo 对象
 */
export function toNetworkInfo(
  ipv6: Ipv6CheckResult,
  nat: NatCheckResult
): NetworkInfo {
  return {
    ipv6: {
      available: ipv6.available,
      hasPublicV6: ipv6.hasPublicV6,
      addresses: ipv6.addresses
    },
    ipv4: {
      natType: nat.natType,
      publicIp: nat.publicIp,
      publicPort: nat.publicPort,
      mappingBehavior: nat.mappingBehavior,
      filteringBehavior: nat.filteringBehavior
    }
  }
}
