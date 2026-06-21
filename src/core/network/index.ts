/**
 * 功能描述：网络检测模块统一导出
 *
 * 逻辑说明：聚合导出 IPv6 检测、NAT 类型检测和检测编排器。
 *           外部通过此入口访问所有网络检测功能。
 */

export { NetworkDetector } from './detector'
export { checkIpv6Capability } from './ipv6-check'
export { detectNatType } from './nat-type'

export type { Ipv6CheckResult, NatCheckResult, NetworkDetectorConfig } from './types'
