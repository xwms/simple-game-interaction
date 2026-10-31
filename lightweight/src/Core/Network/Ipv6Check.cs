using System;
using System.Collections.Generic;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Threading.Tasks;

namespace SGI
{
    /// <summary>
    /// IPv6 能力检测：扫描本机 IPv6 地址并验证外网可达性
    ///
    /// 对应 src/core/network/ipv6-check.ts 的 C# 移植。
    /// 1) 扫描系统网络接口，收集 IPv6 地址；
    /// 2) 判断是否存在公网 IPv6 地址（非 fe80/fc/fd/ff/::1）；
    /// 3) 尝试 IPv6 TCP 连接外部服务器验证可达性，整体约 1-2 秒。
    /// </summary>
    internal static class Ipv6Check
    {
        /// <summary>
        /// 功能描述：获取本机所有 IPv6 地址
        ///
        /// 逻辑说明：遍历所有网络接口的 UnicastAddresses，收集 IPv6 地址，
        ///           排除内部回环地址（::1）。
        ///
        /// @returns IPv6 地址列表
        /// </summary>
        public static List<string> GetLocalIpv6Addresses()
        {
            var addresses = new List<string>();
            foreach (var iface in NetworkInterface.GetAllNetworkInterfaces())
            {
                try
                {
                    var props = iface.GetIPProperties();
                    foreach (var addr in props.UnicastAddresses)
                    {
                        if (addr.Address.AddressFamily != AddressFamily.InterNetworkV6)
                        {
                            continue;
                        }
                        string text = addr.Address.ToString();
                        if (!text.Equals("::1", StringComparison.Ordinal))
                        {
                            addresses.Add(text);
                        }
                    }
                }
                catch
                {
                    // 跳过无法读取的网卡
                }
            }
            return addresses;
        }

        /// <summary>
        /// 功能描述：判断是否为公网 IPv6 地址
        ///
        /// 逻辑说明：公网 IPv6 不以 fe80（链路本地）、fc/fd（ULA）、
        ///           ff（多播）开头，且非环回 ::1；其余视为全局单播（2000::/3）。
        ///
        /// @param address - IPv6 地址
        /// @returns 是否为公网地址
        /// </summary>
        public static bool IsPublicIpv6(string address)
        {
            string lower = address.ToLowerInvariant();
            if (lower.StartsWith("fe80", StringComparison.Ordinal)) return false;
            if (lower.StartsWith("fc", StringComparison.Ordinal)) return false;
            if (lower.StartsWith("fd", StringComparison.Ordinal)) return false;
            if (lower.StartsWith("ff", StringComparison.Ordinal)) return false;
            if (lower == "::1") return false;
            return true;
        }

        /// <summary>
        /// 功能描述：获取公网 IPv6 地址列表
        ///
        /// @param addresses - 所有 IPv6 地址
        /// @returns 公网 IPv6 地址列表
        /// </summary>
        public static List<string> GetPublicIpv6Addresses(List<string> addresses)
        {
            var result = new List<string>();
            foreach (var addr in addresses)
            {
                if (IsPublicIpv6(addr))
                {
                    result.Add(addr);
                }
            }
            return result;
        }

        /// <summary>
        /// 功能描述：尝试 IPv6 TCP 连接验证可达性
        ///
        /// 逻辑说明：依次连接多个 IPv6 可访问目标（Google 系），
        ///           任一连接成功即认为 IPv6 出站正常；全部失败返回 false。
        ///
        /// @param timeoutMs - 单次连接超时（毫秒）
        /// @returns 是否可达
        /// </summary>
        public static async Task<bool> CheckIpv6Reachability(int timeoutMs = 3000)
        {
            var targets = new[] { "ipv6.google.com", "ipv6.l.google.com" };
            foreach (var host in targets)
            {
                if (await TryConnectAsync(host, 80, timeoutMs).ConfigureAwait(false))
                {
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// 功能描述：执行 IPv6 能力检测
        ///
        /// 逻辑说明：无任何 IPv6 地址 → 不可用；有公网 IPv6 → 验证可达性，
        ///           可达则 available=true；仅有链路本地 → 不可用但保留地址列表。
        ///
        /// @param timeoutMs - 检测超时（毫秒）
        /// @returns IPv6 检测结果
        /// </summary>
        public static async Task<Ipv6CheckResult> CheckIpv6Capability(int timeoutMs = 5000)
        {
            var addresses = GetLocalIpv6Addresses();
            var publicAddresses = GetPublicIpv6Addresses(addresses);

            if (addresses.Count == 0)
            {
                return new Ipv6CheckResult
                {
                    Available = false,
                    HasPublicV6 = false,
                    Addresses = addresses,
                    PublicAddresses = publicAddresses
                };
            }

            if (publicAddresses.Count > 0)
            {
                bool reachable = await CheckIpv6Reachability(timeoutMs).ConfigureAwait(false);
                return new Ipv6CheckResult
                {
                    Available = reachable,
                    HasPublicV6 = true,
                    Addresses = addresses,
                    PublicAddresses = publicAddresses
                };
            }

            return new Ipv6CheckResult
            {
                Available = false,
                HasPublicV6 = false,
                Addresses = addresses,
                PublicAddresses = publicAddresses
            };
        }

        /// <summary>
        /// 功能描述：建立一条带超时的 IPv6 TCP 连接
        ///
        /// @param host - 目标主机
        /// @param port - 目标端口
        /// @param timeoutMs - 超时（毫秒）
        /// @returns 是否连接成功
        /// </summary>
        private static async Task<bool> TryConnectAsync(string host, int port, int timeoutMs)
        {
            using (var client = new TcpClient(AddressFamily.InterNetworkV6))
            {
                var connectTask = client.ConnectAsync(host, port);
                var done = await Task.WhenAny(connectTask, Task.Delay(timeoutMs)).ConfigureAwait(false);
                if (done != connectTask)
                {
                    return false;
                }
                if (connectTask.IsFaulted || connectTask.IsCanceled)
                {
                    return false;
                }
                return client.Connected;
            }
        }
    }
}
