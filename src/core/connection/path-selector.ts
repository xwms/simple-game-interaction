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
 *           1. NatType 基准阻断（hard-nat 直接排除）
 *           2. MappingBehavior 精细化判断（address-and-port-dependent 确保拦截）
 *           unknown + 无公网 IP 时视为无 NAT 环境（本地调试），允许 P2P。
 *
 * @param natType - NAT 分类（easy-nat / hard-nat）
 * @param mappingBehavior - RFC 5780 映射行为
 * @param hasPublicIp - 是否有公网 IP（STUN 探测结果）
 * @returns true 表示可 P2P
 */
function _canP2P(natType: NatType, mappingBehavior: MappingBehavior, hasPublicIp: boolean): boolean {
  if (natType === 'unknown' && !hasPublicIp) return true
  if (natType === 'hard-nat' || natType === 'unknown') return false
  if (mappingBehavior === 'address-and-port-dependent') return false
  if (mappingBehavior === 'unknown') return false
  return true
}

/**
 * 功能描述：判断 NAT 组合是否支持 KCP（UDP 打洞）
 *
 * 逻辑说明：UDP 打洞要求 NAT 映射方式是 endpoint-independent（固定端口映射）。
 *           HardNAT（address-dependent mapping）每目标地址分配不同端口，
 *           简单的单端口打洞必然失败。frp 对此场景通过端口范围扫描/多端口猜解处理，
 *           本项目暂未实现端口扫描，故 HardNAT 下直接跳过 KCP，减少 5s 超时等待。
 *           unknown + 无公网 IP 时视为无 NAT 环境（本地调试），允许 KCP。
 *
 * @param natType - NAT 分类（easy-nat / hard-nat）
 * @param mappingBehavior - RFC 5780 映射行为
 * @param hasPublicIp - 是否有公网 IP（STUN 探测结果）
 * @returns true 表示可尝试 KCP
 */
function _canKCP(natType: NatType, mappingBehavior: MappingBehavior, hasPublicIp: boolean): boolean {
  if (natType === 'unknown' && !hasPublicIp) return true
  if (natType === 'unknown') return false
  if (natType === 'hard-nat') return false
  if (mappingBehavior === 'unknown') return false
  if (mappingBehavior === 'address-and-port-dependent') return false
  return true
}

/**
 * 功能描述：生成连接路径列表
 *
 * 逻辑说明：按优先级顺序生成所有可用路径。IPv6 直连条件最苛刻（双方均需公网 V6），
 *           P2P 要求双方 NAT 为 EasyNAT，KCP UDP 打洞容错性更强，
 *           Relay 始终可用。
 *           调用方按列表顺序尝试，失败后尝试下一项即完成自动降级。
 *
 * @param serverNetwork - 房主网络信息
 * @param clientNetwork - 加入者网络信息
 * @returns 按优先级排序的路径列表（至少包含 Relay）
 */
export function selectPath(
  serverNetwork: NetworkInfo | null,
  clientNetwork: NetworkInfo | null
): ConnectionPath[] {
  const paths: ConnectionPath[] = []

  if (!serverNetwork || !clientNetwork) {
    return [
      { type: 'relay', priority: 0, description: 'Relay forwarding' }
    ]
  }

  // 优先级 1：IPv6 直连（双方均有公网 IPv6）
  const serverV6 = serverNetwork.ipv6
  const clientV6 = clientNetwork.ipv6
  if (serverV6.hasPublicV6 && clientV6.hasPublicV6) {
    paths.push({
      type: 'ipv6',
      priority: 0,
      description: 'IPv6 direct'
    })
  }

  // 优先级 2：P2P（含 TCP 直连 + UDP KCP 打洞两种子策略）
  const serverNat = serverNetwork.ipv4.natType
  const clientNat = clientNetwork.ipv4.natType
  const serverMapping = serverNetwork.ipv4.mappingBehavior
  const clientMapping = clientNetwork.ipv4.mappingBehavior
  const serverHasPublic = !!serverNetwork.ipv4.publicIp
  const clientHasPublic = !!clientNetwork.ipv4.publicIp

  const canP2P = _canP2P(serverNat, serverMapping, serverHasPublic) && _canP2P(clientNat, clientMapping, clientHasPublic)
  const canKCP = _canKCP(serverNat, serverMapping, serverHasPublic) && _canKCP(clientNat, clientMapping, clientHasPublic)

  if (canP2P || canKCP) {
    const methods: ('tcp' | 'udp')[] = []
    let desc = ''
    if (canP2P) {
      methods.push('tcp')
      desc = 'TCP direct'
    }
    if (canKCP) {
      methods.push('udp')
      desc = desc ? `${desc} + UDP hole punching` : 'UDP hole punching'
    }

    paths.push({
      type: 'p2p',
      priority: 1,
      description: desc,
      p2pStrategy: {
        server: { mappingBehavior: serverMapping, filteringBehavior: serverNetwork.ipv4.filteringBehavior },
        client: { mappingBehavior: clientMapping, filteringBehavior: clientNetwork.ipv4.filteringBehavior },
        methods
      }
    })
  }

  // 优先级 3：Relay 兜底
  paths.push({
    type: 'relay',
    priority: paths.length > 0 ? paths[paths.length - 1].priority + 1 : 0,
    description: 'Relay forwarding'
  })

  return paths
}
