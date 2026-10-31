using System;
using System.Collections.Generic;
using System.Net.Sockets;
using System.Threading.Tasks;

namespace SGI
{
    /// <summary>
    /// 网络检测编排器：并行执行 IPv6 与 NAT 检测，带结果缓存
    ///
    /// 对应 src/core/network/detector.ts 的 C# 移植。
    /// 同时启动 IPv6 能力检测与 NAT 类型检测（约 1-3 秒），合并为 NetworkInfo；
    /// 结果在连接阶段可缓存复用。
    /// </summary>
    internal class NetworkDetector
    {
        /// <summary>联网探测目标（国内可访问站点）</summary>
        private static readonly (string Host, int Port)[] ConnectivityTargets =
        {
            ("baidu.com", 80),
            ("qq.com", 80),
            ("aliyun.com", 80)
        };

        private const long CacheTtlMs = 30000;        // 在线结果 30 秒缓存
        private const long CacheTtlOfflineMs = 5000;  // 离线结果 5 秒缓存（更快重试）

        /// <summary>检测器默认 STUN 服务器（对应 TS DEFAULT_DETECTOR_CONFIG）</summary>
        private static readonly string[] DefaultStunServers =
        {
            "stun.l.google.com:19302",
            "stun1.l.google.com:19302",
            "stun2.l.google.com:19302",
            "stun.stunprotocol.org:3478",
            "stun.iptel.org:3478"
        };

        private static readonly object CacheLock = new object();
        private static CacheEntry _cache;

        private readonly List<string> _stunServers;
        private readonly int _timeoutMs;

        /// <summary>
        /// @param stunServers - STUN 服务器列表，null 用默认 5 台
        /// @param timeoutMs - 检测超时（毫秒）
        /// </summary>
        public NetworkDetector(List<string> stunServers = null, int timeoutMs = 5000)
        {
            _stunServers = stunServers ?? new List<string>(DefaultStunServers);
            _timeoutMs = timeoutMs;
        }

        /// <summary>
        /// 功能描述：执行并行网络检测
        ///
        /// 逻辑说明：检查缓存（离线结果用更短 TTL）→ 快速联网探测（任一目标连通即在线，
        ///           避免 DNS 污染/单点故障误判）→ 并行 IPv6 + NAT 检测 → 合并 NetworkInfo
        ///           写入缓存，并输出详细日志。
        ///
        /// @returns 网络信息
        /// </summary>
        public async Task<NetworkInfo> DetectAsync()
        {
            lock (CacheLock)
            {
                if (_cache != null)
                {
                    long elapsed = NowMs() - _cache.TimestampMs;
                    bool isOffline = string.IsNullOrEmpty(_cache.Result.Ipv4.PublicIp) &&
                                     _cache.Result.Ipv4.NatType == NatType.Unknown;
                    long ttl = isOffline ? CacheTtlOfflineMs : CacheTtlMs;
                    if (elapsed < ttl)
                    {
                        return _cache.Result;
                    }
                }
            }

            // 第一步：快速联网探测
            bool online = await CheckInternetConnectivityAsync(2000).ConfigureAwait(false);
            if (!online)
            {
                var noNetResult = new NetworkInfo
                {
                    Ipv6 = new Ipv6Info { Available = false, HasPublicV6 = false, Addresses = new List<string>() },
                    Ipv4 = new Ipv4Info
                    {
                        NatType = NatType.Unknown,
                        PublicIp = "",
                        PublicPort = 0,
                        MappingBehavior = MappingBehavior.Unknown,
                        FilteringBehavior = FilteringBehavior.Unknown,
                        LocalAddresses = new List<string>()
                    }
                };
                Log.Info("No internet connectivity, skipping network detection");
                lock (CacheLock)
                {
                    _cache = new CacheEntry { Result = noNetResult, TimestampMs = NowMs() };
                }
                return noNetResult;
            }

            // 并行检测
            var ipv6Task = Ipv6Check.CheckIpv6Capability(_timeoutMs);
            var natTask = NatDetector.DetectNatTypeAsync(_stunServers, _timeoutMs);
            await Task.WhenAll(ipv6Task, natTask).ConfigureAwait(false);
            var ipv6Result = await ipv6Task.ConfigureAwait(false);
            var natResult = await natTask.ConfigureAwait(false);

            var result = ToNetworkInfo(ipv6Result, natResult);

            // 日志：IPv6 + NAT 检测结果
            string ipv6Str = ipv6Result.HasPublicV6
                ? "IPv6 publicly reachable (" +
                  (ipv6Result.PublicAddresses.Count > 0 ? ipv6Result.PublicAddresses[0] : "") + ")"
                : ipv6Result.Available
                    ? $"IPv6 available ({ipv6Result.Addresses.Count} addresses, none public)"
                    : "IPv6 unavailable";
            Log.Info(ipv6Str);
            Log.Info($"NAT type: {EnumUtil.ToApiString(result.Ipv4.NatType)}");
            Log.Info($"Mapping behavior: {EnumUtil.ToApiString(result.Ipv4.MappingBehavior)}");
            Log.Info($"Filtering behavior: {EnumUtil.ToApiString(result.Ipv4.FilteringBehavior)}");
            Log.Info($"Public address: {result.Ipv4.PublicIp}:{result.Ipv4.PublicPort}");

            lock (CacheLock)
            {
                _cache = new CacheEntry { Result = result, TimestampMs = NowMs() };
            }
            return result;
        }

        /// <summary>
        /// 功能描述：清除检测缓存
        ///
        /// 逻辑说明：强制下次 DetectAsync 重新检测而非使用缓存。
        /// </summary>
        public void ClearCache()
        {
            lock (CacheLock)
            {
                _cache = null;
            }
        }

        /// <summary>
        /// 功能描述：仅检测 IPv6（不包含 NAT 检测）
        ///
        /// @returns IPv6 部分网络信息
        /// </summary>
        public async Task<Ipv6Info> DetectIpv6OnlyAsync()
        {
            var ipv6Result = await Ipv6Check.CheckIpv6Capability(_timeoutMs).ConfigureAwait(false);
            return new Ipv6Info
            {
                Available = ipv6Result.Available,
                HasPublicV6 = ipv6Result.HasPublicV6,
                Addresses = ipv6Result.Addresses
            };
        }

        /// <summary>
        /// 功能描述：仅检测 NAT 类型（不包含 IPv6 检测）
        ///
        /// @returns IPv4/NAT 部分网络信息
        /// </summary>
        public async Task<Ipv4Info> DetectNatOnlyAsync()
        {
            var natResult = await NatDetector.DetectNatTypeAsync(_stunServers, _timeoutMs).ConfigureAwait(false);
            return new Ipv4Info
            {
                NatType = natResult.NatType,
                PublicIp = natResult.PublicIp,
                PublicPort = natResult.PublicPort,
                MappingBehavior = natResult.MappingBehavior,
                FilteringBehavior = natResult.FilteringBehavior,
                LocalAddresses = natResult.LocalAddresses
            };
        }

        /// <summary>
        /// 功能描述：快速检测本机是否已联网
        ///
        /// 逻辑说明：同时向多个常见服务器发起 TCP 连接，任一成功即认为联网，
        ///           避免 DNS 污染或单点故障导致误判。
        ///
        /// @param timeoutMs - 单次连接超时（毫秒）
        /// @returns 是否联网
        /// </summary>
        private static async Task<bool> CheckInternetConnectivityAsync(int timeoutMs)
        {
            var tasks = new List<Task<bool>>();
            foreach (var target in ConnectivityTargets)
            {
                tasks.Add(TryConnectAsync(target.Host, target.Port, timeoutMs));
            }
            var results = await Task.WhenAll(tasks).ConfigureAwait(false);
            foreach (bool r in results)
            {
                if (r)
                {
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// 功能描述：建立一条带超时的 TCP 连接
        ///
        /// @param host - 目标主机
        /// @param port - 目标端口
        /// @param timeoutMs - 超时（毫秒）
        /// @returns 是否连接成功
        /// </summary>
        private static async Task<bool> TryConnectAsync(string host, int port, int timeoutMs)
        {
            using (var client = new TcpClient())
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

        /// <summary>
        /// 功能描述：将内部检测结果转换为 NetworkInfo
        ///
        /// @param ipv6 - IPv6 检测结果
        /// @param nat - NAT 检测结果
        /// @returns 标准 NetworkInfo 对象
        /// </summary>
        private static NetworkInfo ToNetworkInfo(Ipv6CheckResult ipv6, NatCheckResult nat)
        {
            return new NetworkInfo
            {
                Ipv6 = new Ipv6Info
                {
                    Available = ipv6.Available,
                    HasPublicV6 = ipv6.HasPublicV6,
                    Addresses = ipv6.Addresses
                },
                Ipv4 = new Ipv4Info
                {
                    NatType = nat.NatType,
                    PublicIp = nat.PublicIp,
                    PublicPort = nat.PublicPort,
                    MappingBehavior = nat.MappingBehavior,
                    FilteringBehavior = nat.FilteringBehavior,
                    LocalAddresses = nat.LocalAddresses
                }
            };
        }

        private static long NowMs()
        {
            return DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond;
        }

        private class CacheEntry
        {
            public NetworkInfo Result;
            public long TimestampMs;
        }
    }
}
