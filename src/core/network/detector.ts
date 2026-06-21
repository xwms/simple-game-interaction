/**
 * 功能描述：网络检测编排器 — 并行执行 IPv6 和 NAT 检测
 *
 * 逻辑说明：同时启动 IPv6 能力检测和 NAT 类型检测，
 *           两张检测耗时约 1-3 秒。将结果合并为 NetworkInfo。
 *           检测结果可在连接阶段缓存复用。检测完成后输出详细日志。
 *
 * @module detector
 */

import * as net from 'net'
import type { NetworkInfo } from '@shared/types'
import { checkIpv6Capability } from './ipv6-check'
import { detectNatType } from './nat-type'
import {
  toNetworkInfo,
  DEFAULT_DETECTOR_CONFIG
} from './types'
import type { NetworkDetectorConfig } from './types'
import { Logger } from '../utils/logger'

const logger = new Logger('NetworkDetector')

/** 联网探测目标（国内可访问站点） */
const CONNECTIVITY_TARGETS: Array<{ host: string; port: number }> = [
  { host: 'baidu.com', port: 80 },
  { host: 'qq.com', port: 80 },
  { host: 'aliyun.com', port: 80 }
]

/**
 * 功能描述：快速检测本机是否已联网
 *
 * 逻辑说明：同时向多个常见服务器发起 TCP 连接，
 *           任一成功即认为已联网。避免 DNS 污染或单点故障导致误判。
 *
 * @param timeoutMs - 单次连接超时
 * @returns 是否联网
 */
async function checkInternetConnectivity(timeoutMs: number = 2000): Promise<boolean> {
  const results = await Promise.allSettled(
    CONNECTIVITY_TARGETS.map(({ host, port }) =>
      new Promise<void>((resolve, reject) => {
        const socket = new net.Socket()
        socket.setTimeout(timeoutMs)
        socket.once('connect', () => { socket.destroy(); resolve() })
        socket.once('error', () => { socket.destroy(); reject() })
        socket.once('timeout', () => { socket.destroy(); reject() })
        socket.connect(port, host)
      })
    )
  )
  return results.some(r => r.status === 'fulfilled')
}

const MAPPING_LABELS: Record<string, string> = {
  'endpoint-independent': 'Endpoint-Independent',
  'address-dependent': 'Address-Dependent',
  'address-and-port-dependent': 'Address-and-Port-Dependent',
  'unknown': 'Unknown'
}

const FILTERING_LABELS: Record<string, string> = {
  'endpoint-independent': 'Endpoint-Independent',
  'address-dependent': 'Address-Dependent',
  'address-and-port-dependent': 'Address-and-Port-Dependent',
  'unknown': 'Unknown'
}

/** 缓存条目 */
let _cache: { result: NetworkInfo; timestamp: number } | null = null
const CACHE_TTL_MS = 30000 // 30 秒缓存
const CACHE_TTL_OFFLINE_MS = 5000 // 离线结果 5 秒缓存（更快重试）

/**
 * 功能描述：网络检测器类
 *
 * 逻辑说明：编排 IPv6 和 NAT 并行检测，支持结果缓存。
 *           检测结果可用于连接路径选择器的输入。
 */
export class NetworkDetector {
  private _config: NetworkDetectorConfig

  /**
   * @param config - 检测器配置（可选）
   */
  constructor(config?: Partial<NetworkDetectorConfig>) {
    this._config = { ...DEFAULT_DETECTOR_CONFIG, ...config }
  }

  /**
   * 功能描述：执行并行网络检测
   *
   * 逻辑说明：同时启动 IPv6 检测和 NAT 检测，等待两者完成。
   *           检测结果合并为 NetworkInfo 并写入缓存。
   *           完成后通过 Logger 输出 NAT 详细行为信息。
   *
   * @returns 网络信息
   */
  async detect(): Promise<NetworkInfo> {
    // 检查缓存（离线结果用更短的 TTL）
    if (_cache) {
      const elapsed = Date.now() - _cache.timestamp
      const isOffline = !_cache.result.ipv4.publicIp && _cache.result.ipv4.natType === 'unknown'
      const ttl = isOffline ? CACHE_TTL_OFFLINE_MS : CACHE_TTL_MS
      if (elapsed < ttl) {
        return _cache.result
      }
    }

    // 第一步：快速联网探测
    const online = await checkInternetConnectivity(2000)
    if (!online) {
      const noNetResult: NetworkInfo = {
        ipv6: { available: false, hasPublicV6: false, addresses: [] },
        ipv4: {
          natType: 'unknown', publicIp: '', publicPort: 0,
          mappingBehavior: 'unknown', filteringBehavior: 'unknown',
          localAddresses: []
        }
      }
      logger.warn('No internet connectivity, skipping network detection')
      _cache = { result: noNetResult, timestamp: Date.now() }
      return noNetResult
    }

    // 并行检测
    const [ipv6Result, natResult] = await Promise.all([
      checkIpv6Capability(this._config.timeoutMs),
      detectNatType(this._config.stunServers, this._config.timeoutMs)
    ])

    const result = toNetworkInfo(ipv6Result, natResult)

    // 日志：IPv6 + NAT 检测结果
    const ipv6Str = ipv6Result.hasPublicV6
      ? `IPv6 publicly reachable (${ipv6Result.publicAddresses[0] || ''})`
      : ipv6Result.available
        ? `IPv6 available (${ipv6Result.addresses.length} addresses, none public)`
        : 'IPv6 unavailable'
    logger.info(ipv6Str)
    logger.info(`NAT type: ${result.ipv4.natType}`)
    logger.info(`Mapping behavior: ${MAPPING_LABELS[natResult.mappingBehavior] || natResult.mappingBehavior}`)
    logger.info(`Filtering behavior: ${FILTERING_LABELS[natResult.filteringBehavior] || natResult.filteringBehavior}`)
    logger.info(`Public address: ${natResult.publicIp}:${natResult.publicPort}`)

    // 写入缓存
    _cache = { result, timestamp: Date.now() }

    return result
  }

  /**
   * 功能描述：清除检测缓存
   *
   * 逻辑说明：强制下次 detect() 重新检测而非使用缓存。
   */
  clearCache(): void {
    _cache = null
  }

  /**
   * 功能描述：仅检测 IPv6（不包含 NAT 检测）
   *
   * @returns IPv6 检测结果
   */
  async detectIpv6Only(): Promise<Pick<NetworkInfo, 'ipv6'>> {
    const ipv6Result = await checkIpv6Capability(this._config.timeoutMs)
    return {
      ipv6: {
        available: ipv6Result.available,
        hasPublicV6: ipv6Result.hasPublicV6,
        addresses: ipv6Result.addresses
      }
    }
  }

  /**
   * 功能描述：仅检测 NAT 类型（不包含 IPv6 检测）
   *
   * @returns NAT 检测结果
   */
  async detectNatOnly(): Promise<Pick<NetworkInfo, 'ipv4'>> {
    const natResult = await detectNatType(this._config.stunServers, this._config.timeoutMs)
    return {
      ipv4: {
        natType: natResult.natType,
        publicIp: natResult.publicIp,
        publicPort: natResult.publicPort,
        mappingBehavior: natResult.mappingBehavior,
        filteringBehavior: natResult.filteringBehavior,
        localAddresses: natResult.localAddresses
      }
    }
  }
}
