using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SGI
{
    /// <summary>
    /// UDP 广播扫描器：发现局域网中的游戏服务器
    ///
    /// 对应 src/core/discovery/scanner.ts 的 C# 移植。
    /// 定期向各网卡广播地址发送 SGI1:DISCOVER 请求，解析响应为 DiscoveredGame，
    /// 15 秒无响应的游戏自动移除，通过事件通知调用方。
    /// </summary>
    internal class Scanner : IDisposable
    {
        /// <summary>发现端口</summary>
        public const int DiscoveryPort = 24861;

        private const string DiscoveryRequestText = "SGI1:DISCOVER\n";
        private const int StaleTimeoutMs = 15000;
        private const int CleanupIntervalMs = 5000;
        private const int ScanIntervalMs = 3000;

        private readonly object _lock = new object();
        private readonly int _discoveryPort;

        private Socket _socket;
        private string _state = "idle";
        private readonly Dictionary<string, DiscoveredGame> _games = new Dictionary<string, DiscoveredGame>();
        private Timer _scanTimer;
        private Timer _cleanupTimer;

        /// <summary>新发现游戏</summary>
        public event Action<ScanEvent> GameDiscovered;
        /// <summary>游戏信息更新</summary>
        public event Action<ScanEvent> GameUpdated;
        /// <summary>游戏过期移除</summary>
        public event Action<ScanEvent> GameRemoved;
        /// <summary>扫描错误</summary>
        public event Action<Exception> Error;
        /// <summary>状态变化（idle/scanning/error）</summary>
        public event Action<string> StateChanged;

        /// <summary>
        /// @param discoveryPort - 发现端口号，默认 24861
        /// </summary>
        public Scanner(int discoveryPort = DiscoveryPort)
        {
            _discoveryPort = discoveryPort;
        }

        /// <summary>当前扫描器状态</summary>
        public string State
        {
            get { lock (_lock) { return _state; } }
        }

        /// <summary>当前已发现的游戏列表</summary>
        public List<DiscoveredGame> Games
        {
            get { lock (_lock) { return _games.Values.ToList(); } }
        }

        /// <summary>
        /// 功能描述：启动扫描
        ///
        /// 逻辑说明：创建 UDP socket 绑定随机端口并启用广播，立即广播一次，
        ///           随后每 3 秒广播、每 5 秒清理过期游戏。
        ///
        /// @returns Task，socket 就绪时完成
        /// </summary>
        public Task StartAsync()
        {
            lock (_lock)
            {
                if (_state == "scanning")
                {
                    return Task.CompletedTask;
                }

                try
                {
                    var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
                    socket.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                    socket.EnableBroadcast = true;
                    socket.Bind(new IPEndPoint(IPAddress.Any, 0));

                    _socket = socket;
                    _state = "scanning";

                    var receiver = new Thread(() => ReceiveLoop(socket))
                    {
                        IsBackground = true,
                        Name = "lan-scan-receive"
                    };
                    receiver.Start();

                    _scanTimer = new Timer(_ => Broadcast(), null, 0, ScanIntervalMs);
                    _cleanupTimer = new Timer(_ => Cleanup(), null, CleanupIntervalMs, CleanupIntervalMs);

                    StateChanged?.Invoke(_state);
                    return Task.CompletedTask;
                }
                catch (Exception ex)
                {
                    _state = "error";
                    StateChanged?.Invoke(_state);
                    return Task.FromException(ex);
                }
            }
        }

        /// <summary>
        /// 功能描述：停止扫描
        ///
        /// 逻辑说明：关闭 UDP socket，清除所有定时器，清空游戏列表。
        /// </summary>
        public void Stop()
        {
            lock (_lock)
            {
                if (_socket == null && _state == "idle")
                {
                    return;
                }
                _state = "idle";
                _scanTimer?.Dispose();
                _scanTimer = null;
                _cleanupTimer?.Dispose();
                _cleanupTimer = null;
                if (_socket != null)
                {
                    try
                    {
                        _socket.Close();
                    }
                    catch
                    {
                        // socket 可能已关闭
                    }
                    _socket = null;
                }
                _games.Clear();
            }
            StateChanged?.Invoke("idle");
        }

        public void Dispose()
        {
            Stop();
        }

        /// <summary>
        /// 功能描述：添加或更新一个游戏（用于从其他源添加，非广播发现）
        ///
        /// @param game - 游戏信息
        /// </summary>
        public void AddGame(DiscoveredGame game)
        {
            lock (_lock)
            {
                if (_games.TryGetValue(game.Id, out var existing))
                {
                    existing.LastSeen = NowMs();
                    GameUpdated?.Invoke(new ScanEvent { Type = "updated", Game = existing });
                }
                else
                {
                    _games[game.Id] = game;
                    GameDiscovered?.Invoke(new ScanEvent { Type = "discovered", Game = game });
                }
            }
        }

        /// <summary>
        /// 功能描述：解析 UDP 响应数据包
        ///
        /// 逻辑说明：格式为 SGI1:DISCOVER_RESP|gameId|name|port|protocol，
        ///           解析后转换为 DiscoveredGame 对象；格式错误返回 null。
        ///
        /// @param msg - UDP 数据包
        /// @param rinfo - 远程地址信息
        /// @returns 解析后的游戏信息，格式错误返回 null
        /// </summary>
        public static DiscoveredGame ParseResponse(byte[] msg, IPEndPoint rinfo)
        {
            string text = Encoding.UTF8.GetString(msg).Trim();
            if (!text.StartsWith("SGI1:DISCOVER_RESP|", StringComparison.Ordinal))
            {
                return null;
            }

            var parts = text.Split('|');
            if (parts.Length < 5)
            {
                return null;
            }

            string gameId = parts[1];
            string name = parts[2];
            if (!int.TryParse(parts[3], out int port))
            {
                return null;
            }
            string protocol = parts[4];

            if (string.IsNullOrEmpty(gameId) || string.IsNullOrEmpty(name) || string.IsNullOrEmpty(protocol))
            {
                return null;
            }

            return new DiscoveredGame
            {
                Id = $"{gameId}-{rinfo.Address}-{port}",
                GameId = gameId,
                Name = name,
                Host = rinfo.Address.ToString(),
                Port = port,
                Protocol = protocol == "udp" ? "udp" : "tcp",
                ViaLan = true,
                LastSeen = NowMs()
            };
        }

        /// <summary>
        /// 功能描述：发送 UDP 广播发现请求
        ///
        /// 逻辑说明：向所有网络接口的广播地址发送发现请求，发送失败触发 error 事件。
        /// </summary>
        private void Broadcast()
        {
            Socket socket;
            lock (_lock)
            {
                socket = _socket;
            }
            if (socket == null)
            {
                return;
            }

            byte[] message = Encoding.UTF8.GetBytes(DiscoveryRequestText);
            foreach (string addr in GetBroadcastAddresses())
            {
                try
                {
                    socket.SendTo(message, new IPEndPoint(IPAddress.Parse(addr), _discoveryPort));
                }
                catch (Exception ex)
                {
                    Error?.Invoke(ex);
                }
            }
        }

        /// <summary>
        /// 功能描述：清理过期游戏
        ///
        /// 逻辑说明：移除 lastSeen 超过 15 秒的条目，并逐个触发 removed 事件。
        /// </summary>
        private void Cleanup()
        {
            long now = NowMs();
            List<DiscoveredGame> stale;
            lock (_lock)
            {
                stale = _games.Values.Where(g => now - g.LastSeen > StaleTimeoutMs).ToList();
                foreach (var game in stale)
                {
                    _games.Remove(game.Id);
                }
            }
            foreach (var game in stale)
            {
                GameRemoved?.Invoke(new ScanEvent { Type = "removed", Game = game });
            }
        }

        /// <summary>
        /// 功能描述：处理收到的 UDP 响应
        ///
        /// @param msg - 数据包内容
        /// @param rinfo - 发送方信息
        /// </summary>
        private void OnMessage(byte[] msg, IPEndPoint rinfo)
        {
            var game = ParseResponse(msg, rinfo);
            if (game == null)
            {
                return;
            }

            lock (_lock)
            {
                if (_games.TryGetValue(game.Id, out var existing))
                {
                    existing.LastSeen = NowMs();
                    existing.Port = game.Port;
                    GameUpdated?.Invoke(new ScanEvent { Type = "updated", Game = existing });
                }
                else
                {
                    _games[game.Id] = game;
                    GameDiscovered?.Invoke(new ScanEvent { Type = "discovered", Game = game });
                }
            }
        }

        /// <summary>
        /// 功能描述：后台接收线程，解析并分发广播响应
        ///
        /// 逻辑说明：阻塞接收直到 socket 关闭；仅当当前 socket 不再是活动 socket
        ///           （已 stop 或被替换）时退出线程。
        ///
        /// @param socket - 本线程专属的接收 socket
        /// </summary>
        private void ReceiveLoop(Socket socket)
        {
            var buffer = new byte[2048];
            EndPoint remote = new IPEndPoint(IPAddress.Any, 0);
            while (true)
            {
                int length;
                try
                {
                    length = socket.ReceiveFrom(buffer, ref remote);
                }
                catch
                {
                    if (!ReferenceEquals(_socket, socket))
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
                OnMessage(data, (IPEndPoint)remote);
            }
        }

        /// <summary>
        /// 功能描述：获取可用网络接口的广播地址
        ///
        /// 逻辑说明：遍历 IPv4 非环回接口，由 IP 与子网掩码计算广播地址；
        ///           同时以 255.255.255.255 兜底（对应 TS 的 broadcast 缺失场景）。
        ///
        /// @returns 去重后的广播地址列表
        /// </summary>
        private static List<string> GetBroadcastAddresses()
        {
            var result = new List<string>();
            foreach (var iface in NetworkInterface.GetAllNetworkInterfaces())
            {
                try
                {
                    var props = iface.GetIPProperties();
                    var v4 = props.GetIPv4Properties();
                    if (v4 == null)
                    {
                        continue;
                    }
                    foreach (var ua in props.UnicastAddresses)
                    {
                        if (ua.Address.AddressFamily != AddressFamily.InterNetwork ||
                            IPAddress.IsLoopback(ua.Address))
                        {
                            continue;
                        }
                        var ipBytes = ua.Address.GetAddressBytes();
                        var maskBytes = ua.IPv4Mask.GetAddressBytes();
                        var bc = new byte[4];
                        for (int i = 0; i < 4; i++)
                        {
                            bc[i] = (byte)(ipBytes[i] | ~maskBytes[i]);
                        }
                        result.Add(new IPAddress(bc).ToString());
                        result.Add("255.255.255.255");
                    }
                }
                catch
                {
                    // 跳过无法读取的网卡
                }
            }

            var seen = new HashSet<string>(result);
            result.Clear();
            result.AddRange(seen);
            return result;
        }

        private static long NowMs()
        {
            return DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond;
        }
    }
}
