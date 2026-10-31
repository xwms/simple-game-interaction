using System.Collections.Generic;

namespace SGI
{
    /// <summary>
    /// 连接路径选择器
    ///
    /// 对应 src/core/connection/path-selector.ts 的 C# 移植。
    /// 根据房主和加入者的网络检测结果，计算最优连接路径优先级。
    /// 优先级：IPv6 直连 > P2P > Relay。
    /// IPv6 需要双方均有公网 IPv6 可达；
    /// P2P 需要双方 NAT 类型非 Symmetric（也非 Unknown，保守处理）；
    /// Relay 无条件兜底。
    /// 每次返回有序路径列表，TunnelManager 按序尝试并自动降级。
    /// </summary>
    internal static class PathSelector
    {
        /// <summary>
        /// 功能描述：判断 NAT 组合是否支持 P2P
        ///
        /// 逻辑说明：两层级联判断：
        ///           1. NatType 基准阻断（hard-nat 直接排除）
        ///           2. MappingBehavior 精细化判断（address-and-port-dependent 确保拦截）
        ///           unknown + 无公网 IP 时视为无 NAT 环境（本地调试），允许 P2P。
        ///
        /// @param natType - NAT 分类（easy-nat / hard-nat）
        /// @param mappingBehavior - RFC 5780 映射行为
        /// @param hasPublicIp - 是否有公网 IP（STUN 探测结果）
        /// @returns true 表示可 P2P
        /// </summary>
        private static bool CanP2P(NatType natType, MappingBehavior mappingBehavior, bool hasPublicIp)
        {
            if (natType == NatType.Unknown && !hasPublicIp) return true;
            if (natType == NatType.HardNat || natType == NatType.Unknown) return false;
            if (mappingBehavior == MappingBehavior.AddressAndPortDependent) return false;
            if (mappingBehavior == MappingBehavior.Unknown) return false;
            return true;
        }

        /// <summary>
        /// 功能描述：判断 NAT 组合是否支持 KCP（UDP 打洞）
        ///
        /// 逻辑说明：UDP 打洞要求 NAT 映射方式是 endpoint-independent（固定端口映射）。
        ///           HardNAT（address-dependent mapping）每目标地址分配不同端口，
        ///           简单的单端口打洞必然失败。本项目未实现端口扫描，故 HardNAT 下
        ///           直接跳过 KCP，减少 5s 超时等待。
        ///           unknown + 无公网 IP 时视为无 NAT 环境（本地调试），允许 KCP。
        ///
        /// @param natType - NAT 分类（easy-nat / hard-nat）
        /// @param mappingBehavior - RFC 5780 映射行为
        /// @param hasPublicIp - 是否有公网 IP（STUN 探测结果）
        /// @returns true 表示可尝试 KCP
        /// </summary>
        private static bool CanKcp(NatType natType, MappingBehavior mappingBehavior, bool hasPublicIp)
        {
            if (natType == NatType.Unknown && !hasPublicIp) return true;
            if (natType == NatType.Unknown) return false;
            if (natType == NatType.HardNat) return false;
            if (mappingBehavior == MappingBehavior.Unknown) return false;
            if (mappingBehavior == MappingBehavior.AddressAndPortDependent) return false;
            return true;
        }

        /// <summary>
        /// 功能描述：生成连接路径列表
        ///
        /// 逻辑说明：按优先级顺序生成所有可用路径。IPv6 直连条件最苛刻（双方均需公网 V6），
        ///           P2P 要求双方 NAT 为 EasyNAT，KCP UDP 打洞容错性更强，
        ///           Relay 始终可用。
        ///           调用方按列表顺序尝试，失败后尝试下一项即完成自动降级。
        ///
        /// @param serverNetwork - 房主网络信息
        /// @param clientNetwork - 加入者网络信息
        /// @returns 按优先级排序的路径列表（至少包含 Relay）
        /// </summary>
        public static List<ConnectionPath> SelectPath(NetworkInfo serverNetwork, NetworkInfo clientNetwork)
        {
            var paths = new List<ConnectionPath>();

            if (serverNetwork == null || clientNetwork == null)
            {
                return new List<ConnectionPath>
                {
                    new ConnectionPath { Type = ConnectionPathType.Relay, Priority = 0, Description = "Relay forwarding" }
                };
            }

            // 优先级 1：IPv6 直连（双方均有公网 IPv6）
            if (serverNetwork.Ipv6.HasPublicV6 && clientNetwork.Ipv6.HasPublicV6)
            {
                paths.Add(new ConnectionPath
                {
                    Type = ConnectionPathType.Ipv6,
                    Priority = 0,
                    Description = "IPv6 direct"
                });
            }

            // 优先级 2：P2P（含 TCP 直连 + UDP KCP 打洞两种子策略）
            var serverNat = serverNetwork.Ipv4.NatType;
            var clientNat = clientNetwork.Ipv4.NatType;
            var serverMapping = serverNetwork.Ipv4.MappingBehavior;
            var clientMapping = clientNetwork.Ipv4.MappingBehavior;
            bool serverHasPublic = !string.IsNullOrEmpty(serverNetwork.Ipv4.PublicIp);
            bool clientHasPublic = !string.IsNullOrEmpty(clientNetwork.Ipv4.PublicIp);

            bool canP2P = CanP2P(serverNat, serverMapping, serverHasPublic) && CanP2P(clientNat, clientMapping, clientHasPublic);
            bool canKcp = CanKcp(serverNat, serverMapping, serverHasPublic) && CanKcp(clientNat, clientMapping, clientHasPublic);

            if (canP2P || canKcp)
            {
                var methods = new List<string>();
                string desc = "";
                if (canP2P)
                {
                    methods.Add("tcp");
                    desc = "TCP direct";
                }
                if (canKcp)
                {
                    methods.Add("udp");
                    desc = desc.Length > 0 ? $"{desc} + UDP hole punching" : "UDP hole punching";
                }

                paths.Add(new ConnectionPath
                {
                    Type = ConnectionPathType.P2p,
                    Priority = 1,
                    Description = desc,
                    P2pStrategy = new P2pStrategy
                    {
                        Server = new NatBehavior
                        {
                            MappingBehavior = serverMapping,
                            FilteringBehavior = serverNetwork.Ipv4.FilteringBehavior
                        },
                        Client = new NatBehavior
                        {
                            MappingBehavior = clientMapping,
                            FilteringBehavior = clientNetwork.Ipv4.FilteringBehavior
                        },
                        Methods = methods
                    }
                });
            }

            // 优先级 3：Relay 兜底
            paths.Add(new ConnectionPath
            {
                Type = ConnectionPathType.Relay,
                Priority = paths.Count > 0 ? paths[paths.Count - 1].Priority + 1 : 0,
                Description = "Relay forwarding"
            });

            return paths;
        }
    }
}
