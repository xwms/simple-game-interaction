using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SGI
{
    /// <summary>
    /// NAT 类型检测：基于 STUN (RFC 5389) 检测 NAT 映射行为
    ///
    /// 对应 src/core/network/nat-type.ts 的 C# 移植。
    /// 单阶段多服务器映射行为检测，参照 FRP classify.go 的 EasyNAT/HardNAT 分类：
    /// 同一个 UDP socket 向多个 STUN 服务器发送 Binding Request，收集响应后比对
    /// 映射端口；并从响应中提取 OTHER-ADDRESS 向额外目标查询获取更多映射数据点。
    /// 映射端口全部一致 → EasyNAT；存在差异 → HardNAT。
    /// 稳定性验证：重新查询最快服务器，映射变化则保守判定为 HardNAT。
    /// </summary>
    internal static class NatDetector
    {
        // ─── STUN 协议常量 ─────────────────────────────────────
        private const int StunBindingRequest = 0x0001;
        private const int StunSuccessResponse = 0x0101;
        private const uint StunMagicCookie = 0x2112a442;

        private const int StunAttrMappedAddress = 0x0001;
        private const int StunAttrXorMappedAddress = 0x0020;
        private const int StunAttrChangedAddress = 0x0005;
        private const int StunAttrOtherAddress = 0x8023;
        private const int StunAttrOtherAddress2 = 0x802B;

        private static readonly string[] DefaultStunServers =
        {
            "stun.miwifi.com:3478",
            "stun.chat.bilibili.com:3478",
            "stun.cloudflare.com:3478",
            "stun.l.google.com:19302"
        };

        /// <summary>
        /// 功能描述：检测 NAT 类型
        ///
        /// 逻辑说明：复用同一 UDP socket 并发查询所有 STUN 服务器，从响应中提取
        ///           OTHER-ADDRESS 额外查询；综合所有映射数据点判定 EasyNAT/HardNAT，
        ///           并做映射稳定性验证。socket 创建失败或全部超时返回 unknown。
        ///
        /// @param stunServers - STUN 服务器列表（host:port），空则用默认 4 台
        /// @param timeoutMs - 每个请求超时（毫秒）
        /// @returns NAT 检测结果
        /// </summary>
        public static async Task<NatCheckResult> DetectNatTypeAsync(
            List<string> stunServers = null,
            int timeoutMs = 5000)
        {
            var localAddresses = GetLocalIpv4Addresses();
            if (stunServers == null || stunServers.Count == 0)
            {
                stunServers = new List<string>(DefaultStunServers);
            }

            using (var socket = StunSocket.Create())
            {
                if (socket == null)
                {
                    return UnknownResult(localAddresses);
                }

                int queryTimeout = Math.Min(timeoutMs, 1500);
                var responses = new List<StunResponse>();
                var otherAddrResponses = new List<StunResponse>();

                // ── 多服务器 STUN 并行查询（每台服务器重试 2 次防 UDP 丢包）──
                var tasks = stunServers
                    .Select(server => QueryWithRetry(socket, server, queryTimeout))
                    .ToArray();
                try
                {
                    await Task.WhenAll(tasks).ConfigureAwait(false);
                }
                catch
                {
                    // 各查询不抛异常，此处仅防御
                }
                foreach (var t in tasks)
                {
                    StunResponse r = SafeResult(t);
                    if (r != null)
                    {
                        responses.Add(r);
                    }
                }

                if (responses.Count == 0)
                {
                    return UnknownResult(localAddresses);
                }

                // ── 从任一响应提取 OTHER-ADDRESS 作为第二个目标 ──
                foreach (var resp in responses)
                {
                    var other = ExtractChangedAddress(resp.Raw);
                    if (other != null)
                    {
                        var cr = await QueryWithRetry(socket,
                            $"{other.Value.Address}:{other.Value.Port}", queryTimeout).ConfigureAwait(false);
                        if (cr != null)
                        {
                            otherAddrResponses.Add(cr);
                            break;
                        }
                    }
                }

                // ── 取延迟最低的响应作为主地址 ──
                var best = responses.OrderBy(r => r.LatencyMs).First();
                string mappedAddress = best.MappedAddress;
                int mappedPort = best.MappedPort;

                // ── 无 NAT（映射地址是本机地址）──
                if (localAddresses.Contains(mappedAddress))
                {
                    return new NatCheckResult
                    {
                        NatType = NatType.None,
                        MappingBehavior = MappingBehavior.EndpointIndependent,
                        FilteringBehavior = FilteringBehavior.EndpointIndependent,
                        PublicIp = mappedAddress,
                        PublicPort = mappedPort,
                        LocalAddresses = localAddresses
                    };
                }

                // ── 映射稳定性验证 ──
                var verify = await QueryWithRetry(socket, best.ServerAddress, 2000).ConfigureAwait(false);
                if (verify != null)
                {
                    bool stable = verify.MappedAddress == mappedAddress && verify.MappedPort == mappedPort;
                    if (!stable)
                    {
                        return new NatCheckResult
                        {
                            NatType = NatType.HardNat,
                            MappingBehavior = MappingBehavior.AddressAndPortDependent,
                            FilteringBehavior = FilteringBehavior.Unknown,
                            PublicIp = mappedAddress,
                            PublicPort = mappedPort,
                            LocalAddresses = localAddresses
                        };
                    }
                }

                // ── EasyNAT / HardNAT 判定 ──
                var allMappings = new List<StunResponse>(responses);
                allMappings.AddRange(otherAddrResponses);
                var mappingBehavior = MappingBehavior.Unknown;
                var natType = NatType.EasyNat;

                if (allMappings.Count >= 2)
                {
                    var unique = new HashSet<string>(
                        allMappings.Select(r => $"{r.MappedAddress}:{r.MappedPort}"));
                    if (unique.Count > 1)
                    {
                        natType = NatType.HardNat;
                        mappingBehavior = MappingBehavior.AddressDependent;
                    }
                    else
                    {
                        mappingBehavior = MappingBehavior.EndpointIndependent;
                    }
                }

                // 单服务器响应场景：最佳推测为 endpoint-independent
                if (responses.Count < 2 && mappingBehavior == MappingBehavior.Unknown)
                {
                    mappingBehavior = MappingBehavior.EndpointIndependent;
                }

                return new NatCheckResult
                {
                    NatType = natType,
                    MappingBehavior = mappingBehavior,
                    FilteringBehavior = FilteringBehavior.Unknown,
                    PublicIp = mappedAddress,
                    PublicPort = mappedPort,
                    LocalAddresses = localAddresses
                };
            }
        }

        /// <summary>
        /// 功能描述：带重试的单次服务器查询（2 次尝试防 UDP 丢包）
        ///
        /// @param socket - 已绑定的 STUN socket
        /// @param serverAddr - 服务器地址（host:port）
        /// @param timeoutMs - 每次尝试的超时（毫秒）
        /// @returns 响应信息，失败返回 null
        /// </summary>
        private static async Task<StunResponse> QueryWithRetry(
            StunSocket socket, string serverAddr, int timeoutMs)
        {
            for (int attempt = 0; attempt < 2; attempt++)
            {
                var result = await socket.QueryAsync(serverAddr, timeoutMs).ConfigureAwait(false);
                if (result != null)
                {
                    return result;
                }
            }
            return null;
        }

        /// <summary>
        /// 功能描述：安全读取已完成任务的返回值
        ///
        /// @param task - 已完成的任务
        /// @returns 任务结果，任务异常返回 null
        /// </summary>
        private static StunResponse SafeResult(Task<StunResponse> task)
        {
            try
            {
                return task.Result;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// 功能描述：获取本机 IPv4 地址列表
        ///
        /// @returns IPv4 地址列表
        /// </summary>
        private static List<string> GetLocalIpv4Addresses()
        {
            var addresses = new List<string>();
            foreach (var iface in NetworkInterface.GetAllNetworkInterfaces())
            {
                try
                {
                    foreach (var addr in iface.GetIPProperties().UnicastAddresses)
                    {
                        if (addr.Address.AddressFamily == AddressFamily.InterNetwork &&
                            !IPAddress.IsLoopback(addr.Address))
                        {
                            addresses.Add(addr.Address.ToString());
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
        /// 功能描述：构造 unknown 结果
        ///
        /// @param localAddresses - 本机 IPv4 地址列表
        /// @returns NAT 检测结果（全部 unknown，公网地址 0.0.0.0:0）
        /// </summary>
        private static NatCheckResult UnknownResult(List<string> localAddresses)
        {
            return new NatCheckResult
            {
                NatType = NatType.Unknown,
                MappingBehavior = MappingBehavior.Unknown,
                FilteringBehavior = FilteringBehavior.Unknown,
                PublicIp = "0.0.0.0",
                PublicPort = 0,
                LocalAddresses = localAddresses
            };
        }

        /// <summary>
        /// 功能描述：生成 STUN Binding Request 消息（RFC 5389）
        ///
        /// @returns 消息 buffer 和事务 ID
        /// </summary>
        private static (byte[] Buffer, byte[] TransactionId) CreateStunRequest()
        {
            var transactionId = new byte[12];
            using (var rng = new RNGCryptoServiceProvider())
            {
                rng.GetBytes(transactionId);
            }
            var buffer = new byte[20];
            WriteUInt16BE(buffer, 0, StunBindingRequest);
            WriteUInt16BE(buffer, 2, 0);
            WriteUInt32BE(buffer, 4, StunMagicCookie);
            Buffer.BlockCopy(transactionId, 0, buffer, 8, 12);
            return (buffer, transactionId);
        }

        /// <summary>
        /// 功能描述：解析 STUN 响应
        ///
        /// 逻辑说明：验证 Magic Cookie 与事务 ID（由 Dispatch 按事务 ID 匹配保证），
        ///           提取 XOR-MAPPED-ADDRESS 或 MAPPED-ADDRESS 属性。
        ///
        /// @param response - 响应数据
        /// @returns 解析后的映射地址，解析失败返回 null
        /// </summary>
        private static (string Address, int Port)? ParseStunResponse(byte[] response)
        {
            if (response.Length < 20)
            {
                return null;
            }
            int messageType = ReadUInt16BE(response, 0);
            uint cookie = ReadUInt32BE(response, 4);
            if (cookie != StunMagicCookie || messageType != StunSuccessResponse)
            {
                return null;
            }

            int length = ReadUInt16BE(response, 2);
            int offset = 20;
            int end = offset + length;
            if (end > response.Length)
            {
                end = response.Length;
            }

            while (offset + 4 <= end)
            {
                int attrType = ReadUInt16BE(response, offset);
                int attrLength = ReadUInt16BE(response, offset + 2);
                int valueStart = offset + 4;

                if (attrType == StunAttrXorMappedAddress && attrLength >= 8)
                {
                    int family = response[valueStart + 1];
                    int xorPort = ReadUInt16BE(response, valueStart + 2) ^ (int)(StunMagicCookie >> 16);
                    if (family == 0x01)
                    {
                        uint xorAddr = ReadUInt32BE(response, valueStart + 4) ^ StunMagicCookie;
                        string address = string.Format("{0}.{1}.{2}.{3}",
                            (xorAddr >> 24) & 0xff, (xorAddr >> 16) & 0xff, (xorAddr >> 8) & 0xff, xorAddr & 0xff);
                        return (address, xorPort);
                    }
                    return ("::1", xorPort);
                }

                if (attrType == StunAttrMappedAddress && attrLength >= 8)
                {
                    int family = response[valueStart + 1];
                    int port = ReadUInt16BE(response, valueStart + 2);
                    if (family == 0x01)
                    {
                        string address = string.Format("{0}.{1}.{2}.{3}",
                            response[valueStart + 4], response[valueStart + 5],
                            response[valueStart + 6], response[valueStart + 7]);
                        return (address, port);
                    }
                }

                offset = valueStart + attrLength;
                if (attrLength % 4 != 0)
                {
                    offset += 4 - (attrLength % 4);
                }
            }
            return null;
        }

        /// <summary>
        /// 功能描述：从 STUN 响应中提取 OTHER-ADDRESS / CHANGED-ADDRESS
        ///
        /// 逻辑说明：OTHER-ADDRESS（RFC 5389, 0x8023）/ CHANGED-ADDRESS（RFC 3489, 0x0005）
        ///           表示 STUN 服务器的另一个 IP:PORT，向该地址查询可获得另一映射数据点，
        ///           用于判断映射行为是否地址相关。
        ///
        /// @param response - STUN 响应原始数据
        /// @returns 地址和端口，未找到返回 null
        /// </summary>
        private static (string Address, int Port)? ExtractChangedAddress(byte[] response)
        {
            if (response.Length < 20)
            {
                return null;
            }
            int length = ReadUInt16BE(response, 2);
            int offset = 20;
            int end = offset + length;
            if (end > response.Length)
            {
                end = response.Length;
            }

            while (offset + 4 <= end)
            {
                int attrType = ReadUInt16BE(response, offset);
                int attrLength = ReadUInt16BE(response, offset + 2);
                int valueStart = offset + 4;

                if ((attrType == StunAttrChangedAddress ||
                     attrType == StunAttrOtherAddress ||
                     attrType == StunAttrOtherAddress2) && attrLength >= 8)
                {
                    int family = response[valueStart + 1];
                    int port = ReadUInt16BE(response, valueStart + 2);
                    if (family == 0x01)
                    {
                        string address = string.Format("{0}.{1}.{2}.{3}",
                            response[valueStart + 4], response[valueStart + 5],
                            response[valueStart + 6], response[valueStart + 7]);
                        return (address, port);
                    }
                }

                offset = valueStart + attrLength;
                if (attrLength % 4 != 0)
                {
                    offset += 4 - (attrLength % 4);
                }
            }
            return null;
        }

        // ─── 字节工具 ─────────────────────────────────────────

        private static int ReadUInt16BE(byte[] b, int offset)
        {
            return (b[offset] << 8) | b[offset + 1];
        }

        private static uint ReadUInt32BE(byte[] b, int offset)
        {
            return ((uint)b[offset] << 24) | ((uint)b[offset + 1] << 16) |
                   ((uint)b[offset + 2] << 8) | b[offset + 3];
        }

        private static void WriteUInt16BE(byte[] b, int offset, int value)
        {
            b[offset] = (byte)(value >> 8);
            b[offset + 1] = (byte)value;
        }

        private static void WriteUInt32BE(byte[] b, int offset, uint value)
        {
            b[offset] = (byte)(value >> 24);
            b[offset + 1] = (byte)(value >> 16);
            b[offset + 2] = (byte)(value >> 8);
            b[offset + 3] = (byte)value;
        }

        private static string ToHex(byte[] data, int offset, int count)
        {
            var sb = new StringBuilder(count * 2);
            for (int i = 0; i < count; i++)
            {
                sb.Append(data[offset + i].ToString("x2"));
            }
            return sb.ToString();
        }

        private static long NowMs()
        {
            return DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond;
        }

        /// <summary>
        /// 功能描述：STUN UDP socket 封装
        ///
        /// 逻辑说明：持有单个已绑定 UDP socket 与后台接收线程，按事务 ID 分发
        ///           匹配的响应到挂起的查询任务。多个查询并发复用同一本地端口，
        ///           以保证映射行为判定基于同一映射。
        /// </summary>
        private class StunSocket : IDisposable
        {
            private readonly Socket _socket;
            private readonly object _lock = new object();
            private readonly Dictionary<string, PendingQuery> _pending = new Dictionary<string, PendingQuery>();
            private readonly Thread _receiver;
            private volatile bool _disposed;

            private StunSocket(Socket socket)
            {
                _socket = socket;
                _receiver = new Thread(ReceiveLoop) { IsBackground = true, Name = "stun-receive" };
                _receiver.Start();
            }

            /// <summary>
            /// 功能描述：创建并绑定 UDP socket 到随机端口
            ///
            /// @returns StunSocket；绑定失败返回 null
            /// </summary>
            public static StunSocket Create()
            {
                var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
                try
                {
                    socket.Bind(new IPEndPoint(IPAddress.Any, 0));
                }
                catch
                {
                    socket.Dispose();
                    return null;
                }
                return new StunSocket(socket);
            }

            /// <summary>
            /// 功能描述：向服务器发送 Binding Request 并等待匹配响应
            ///
            /// 逻辑说明：生成随机事务 ID 注册挂起查询，发送请求，超时或响应到达后
            ///           清理挂起项。超时返回 null（由调用方重试）。
            ///
            /// @param serverAddr - 服务器地址（host:port）
            /// @param timeoutMs - 超时（毫秒）
            /// @returns 响应信息，失败返回 null
            /// </summary>
            public async Task<StunResponse> QueryAsync(string serverAddr, int timeoutMs)
            {
                if (_disposed)
                {
                    return null;
                }
                var (buffer, transactionId) = CreateStunRequest();
                string key = ToHex(transactionId, 0, 12);

                int colon = serverAddr.LastIndexOf(':');
                if (colon <= 0)
                {
                    return null;
                }
                string host = serverAddr.Substring(0, colon);
                if (!int.TryParse(serverAddr.Substring(colon + 1), out int port))
                {
                    return null;
                }
                var endpoint = ResolveHost(host, port);
                if (endpoint == null)
                {
                    return null;
                }

                var tcs = new TaskCompletionSource<StunResponse>(
                    TaskCreationOptions.RunContinuationsAsynchronously);
                lock (_lock)
                {
                    if (_disposed)
                    {
                        return null;
                    }
                    _pending[key] = new PendingQuery
                    {
                        Key = key,
                        ServerAddress = serverAddr,
                        StartMs = NowMs(),
                        Tcs = tcs
                    };
                }

                try
                {
                    _socket.SendTo(buffer, 0, buffer.Length, SocketFlags.None, endpoint);
                }
                catch
                {
                    RemovePending(key);
                    return null;
                }

                var done = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs)).ConfigureAwait(false);
                RemovePending(key);
                if (done != tcs.Task)
                {
                    return null; // 超时
                }
                return await tcs.Task.ConfigureAwait(false);
            }

            public void Dispose()
            {
                if (_disposed)
                {
                    return;
                }
                _disposed = true;
                try
                {
                    _socket.Close();
                }
                catch
                {
                    // 关闭失败忽略
                }
                lock (_lock)
                {
                    foreach (var pq in _pending.Values)
                    {
                        pq.Tcs.TrySetResult(null);
                    }
                    _pending.Clear();
                }
            }

            /// <summary>
            /// 功能描述：后台接收线程，分发匹配事务 ID 的响应
            /// </summary>
            private void ReceiveLoop()
            {
                var buffer = new byte[2048];
                EndPoint remote = new IPEndPoint(IPAddress.Any, 0);
                while (!_disposed)
                {
                    int length;
                    try
                    {
                        length = _socket.ReceiveFrom(buffer, ref remote);
                    }
                    catch
                    {
                        if (_disposed)
                        {
                            break;
                        }
                        continue;
                    }
                    if (length <= 0 || length > buffer.Length)
                    {
                        continue;
                    }
                    var data = new byte[length];
                    Buffer.BlockCopy(buffer, 0, data, 0, length);
                    Dispatch(data);
                }
            }

            /// <summary>
            /// 功能描述：按事务 ID 查找挂起查询并完成
            ///
            /// @param data - 收到的完整数据报
            /// </summary>
            private void Dispatch(byte[] data)
            {
                if (data.Length < 20)
                {
                    return;
                }
                string key = ToHex(data, 8, 12);
                PendingQuery pq;
                lock (_lock)
                {
                    if (!_pending.TryGetValue(key, out pq))
                    {
                        return;
                    }
                }
                var parsed = ParseStunResponse(data);
                if (parsed == null)
                {
                    return;
                }
                pq.Tcs.TrySetResult(new StunResponse
                {
                    MappedAddress = parsed.Value.Address,
                    MappedPort = parsed.Value.Port,
                    ServerAddress = pq.ServerAddress,
                    LatencyMs = NowMs() - pq.StartMs,
                    Raw = data
                });
            }

            private void RemovePending(string key)
            {
                lock (_lock)
                {
                    _pending.Remove(key);
                }
            }

            /// <summary>
            /// 功能描述：解析 host 并构造远端端点（优先 IPv4）
            ///
            /// @param host - 主机名或 IP
            /// @param port - 端口
            /// @returns 远端端点，解析失败返回 null
            /// </summary>
            private static IPEndPoint ResolveHost(string host, int port)
            {
                IPAddress ip;
                if (!IPAddress.TryParse(host, out ip))
                {
                    try
                    {
                        var addresses = Dns.GetHostAddresses(host);
                        ip = null;
                        foreach (var a in addresses)
                        {
                            if (a.AddressFamily == AddressFamily.InterNetwork)
                            {
                                ip = a;
                                break;
                            }
                        }
                        if (ip == null && addresses.Length > 0)
                        {
                            ip = addresses[0];
                        }
                    }
                    catch
                    {
                        return null;
                    }
                }
                return ip == null ? null : new IPEndPoint(ip, port);
            }
        }

        /// <summary>一次挂起的 STUN 查询</summary>
        private class PendingQuery
        {
            public string Key;
            public string ServerAddress;
            public long StartMs;
            public TaskCompletionSource<StunResponse> Tcs;
        }

        /// <summary>STUN 服务器响应</summary>
        private class StunResponse
        {
            public string MappedAddress;
            public int MappedPort;
            public string ServerAddress;
            public long LatencyMs;
            public byte[] Raw;
        }
    }
}
