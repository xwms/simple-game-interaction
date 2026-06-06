/**
 * 功能描述：连接路径选择器
 *
 * 逻辑说明：根据房主和加入者的网络检测结果，计算最优连接路径优先级。
 *           优先级：IPv6 直连 > P2P > Relay。
 *           IPv6 需要双方均有公网 IPv6 可达；
 *           P2P 需要双方 NAT 类型非 Symmetric（也非 Unknown，保守处理）；
 *           Relay 无条件兜底。
 *           每次返回有序路径列表，TunnelManager 按序尝试并自动降级。
 */

import type { NetworkInfo, NatType, MappingBehavior, ConnectionPath } from '@shared/types'

/**
 * 功能描述：判断 NAT 组合是否支持 P2P
 *
 * 逻辑说明：两层级联判断：
 *           1. NatType 基准阻断（symmetric / unknown 直接排除）
 *           2. MappingBehavior 精细化判断（address-and-port-dependent 虽会归类为 symmetric，
 *              但存在边界情况直接使用 mappingBehavior 确保拦截）
 *
 * @param natType - 经典 NAT 分类
 * @param mappingBehavior - RFC 5780 映射行为
 * @returns true 表示可 P2P
 */
function _canP2P(natType: NatType, mappingBehavior: MappingBehavior): boolean {
  if (natType === 'symmetric' || natType === 'unknown') return false
  if (mappingBehavior === 'address-and-port-dependent') return false
  if (mappingBehavior === 'unknown') return false
  return true
}

/**
 * 功能描述：生成连接路径列表
 *
 * 逻辑说明：按优先级顺序生成所有可用路径。IPv6 直连条件最苛刻（双方均需公网 V6），
 *           P2P 要求双方 NAT 类型可穿透，Relay 始终可用。
 *           调用方按列表顺序尝试，失败后尝试下一项即完成自动降级。
 *
 * @param hostNetwork - 房主网络信息
 * @param guestNetwork - 加入者网络信息
 * @returns 按优先级排序的路径列表（至少包含 Relay）
 */
export function selectPath(
  hostNetwork: NetworkInfo | null,
  guestNetwork: NetworkInfo | null
): ConnectionPath[] {
  const paths: ConnectionPath[] = []

  if (!hostNetwork || !guestNetwork) {
    return [
      { type: 'relay', priority: 0, description: '中继转发' }
    ]
  }

  // 优先级 1：IPv6 直连（双方均有公网 IPv6）
  const hostV6 = hostNetwork.ipv6
  const guestV6 = guestNetwork.ipv6
  if (hostV6.hasPublicV6 && guestV6.hasPublicV6) {
    paths.push({
      type: 'ipv6',
      priority: 0,
      description: 'IPv6 直连'
    })
  }

  // 优先级 2：P2P（双方 NAT 均可穿透）
  if (_canP2P(hostNetwork.ipv4.natType, hostNetwork.ipv4.mappingBehavior) &&
      _canP2P(guestNetwork.ipv4.natType, guestNetwork.ipv4.mappingBehavior)) {
    paths.push({
      type: 'p2p',
      priority: 1,
      description: 'P2P 直连',
      p2pStrategy: {
        host: {
          mappingBehavior: hostNetwork.ipv4.mappingBehavior,
          filteringBehavior: hostNetwork.ipv4.filteringBehavior
        },
        guest: {
          mappingBehavior: guestNetwork.ipv4.mappingBehavior,
          filteringBehavior: guestNetwork.ipv4.filteringBehavior
        }
      }
    })
  }

  // 优先级 3：Relay 兜底
  paths.push({
    type: 'relay',
    priority: paths.length > 0 ? paths[paths.length - 1].priority + 1 : 0,
    description: '中继转发'
  })

  return paths
}
