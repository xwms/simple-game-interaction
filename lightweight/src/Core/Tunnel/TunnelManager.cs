using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace SGI
{
    /// <summary>
    /// 隧道管理器 — 连接生命周期编排中心
    ///
    /// 对应 src/core/tunnel/manager.ts 的 C# 移植。
    /// 协调 Relay 连接、路径选择、传输层建立、本地隧道和自动降级。
    /// 状态机：idle → connecting-relay → connecting-transport → connected
    /// 当传输层断开时自动降级到下一优先级路径。
    /// 房主和加入者共用此类，通过 CreateRoomAsync / JoinRoomAsync 区分角色。
    /// </summary>
    internal class TunnelManager
    {
        /// <summary>默认中继服务器地址</summary>
        private const string RelayDefaultUrl = "ws://159.75.150.37:9800";
        /// <summary>默认成员名</summary>
        private const string DefaultMemberName = "Player";
        /// <summary>默认连接超时（毫秒）</summary>
        private const int DefaultConnectTimeout = 30000;
        /// <summary>KCP 重连最大尝试次数</summary>
        private const int KcpReconnectMaxRetries = 3;
        /// <summary>KCP 重连基础延迟（毫秒，指数退避）</summary>
        private const int KcpReconnectBaseDelay = 2000;

        private readonly object _lock = new object();
        private readonly RelayClient _relayClient;
        private int _kcpReconnectAttempts;
        /// <summary>房主侧各成员的主传输</summary>
        private readonly Dictionary<string, ITransport> _clientTransports = new Dictionary<string, ITransport>();
        /// <summary>房主侧各成员的本地游戏客户端</summary>
        private readonly Dictionary<string, LocalTunnelClient> _clientTunnels = new Dictionary<string, LocalTunnelClient>();
        /// <summary>P2P 备选传输（IPv6 最优时额外创建的被动监听，用于降级切换）</summary>
        private readonly Dictionary<string, P2pTransport> _p2pBackups = new Dictionary<string, P2pTransport>();
        /// <summary>Relay 备选传输（非 Relay 路径时创建，用于降级到中继后的数据通道）</summary>
        private readonly Dictionary<string, RelayPeerTransport> _relayFallbacks = new Dictionary<string, RelayPeerTransport>();
        /// <summary>P2P 空闲超时定时器（memberId → timer）</summary>
        private readonly Dictionary<string, Timer> _p2pTimeouts = new Dictionary<string, Timer>();
        private readonly LocalTunnelServer _localServer = new LocalTunnelServer();
        private ITransport _currentTransport;
        private ConnectionPath _currentPath;
        private List<ConnectionPath> _availablePaths = new List<ConnectionPath>();
        private int _currentPathIndex = -1;
        private bool _isDegrading;
        private NetworkInfo _serverNetwork;
        private NetworkInfo _clientNetwork;
        /// <summary>房主侧各成员的 KCP 传输实例（用于外部探针触发）</summary>
        private readonly Dictionary<string, KcpTransport> _clientKcpTransports = new Dictionary<string, KcpTransport>();
        /// <summary>房主侧各成员的网络信息（用于 kcp-port 信号中查找客户端公网 IP）</summary>
        private readonly Dictionary<string, NetworkInfo> _clientNetworkInfos = new Dictionary<string, NetworkInfo>();
        private string _role;
        private string _relayUrl;
        private string _memberName;
        private int _connectTimeout;
        private string _state = "idle";
        private string _gameId = "";
        private string _gameName = "";
        private int _gamePort;
        private PeerConnectionInfo _clientPeerInfo;
        /// <summary>房主成员 ID（加入者侧使用，用于发送重置信号）</summary>
        private string _serverMemberId = "";
        private readonly NetworkDetector _networkDetector = new NetworkDetector();
        private long _trafficBytesSent;
        private long _trafficBytesReceived;
        /// <summary>加入者侧本地隧道 client-connected 监听（leaveRoom 时退订）</summary>
        private Action<string> _onClientConnectedHandler;

        /// <summary>管理器状态变更</summary>
        public event Action<string> StatusChanged;
        /// <summary>传输层切换</summary>
        public event Action<string> TransportChanged;
        /// <summary>流量统计快照</summary>
        public event Action<TrafficSnapshot> Traffic;
        /// <summary>连接建立成功</summary>
        public event Action<TunnelConnectedInfo> Connected;
        /// <summary>连接断开</summary>
        public event Action Disconnected;
        /// <summary>错误</summary>
        public event Action<Exception> Error;
        /// <summary>正在降级（from → to）</summary>
        public event Action<string, string> Degrading;
        /// <summary>新成员加入（房主侧）</summary>
        public event Action<MemberInfo> MemberJoined;
        /// <summary>成员离开</summary>
        public event Action<string> MemberLeft;
        /// <summary>延迟测量</summary>
        public event Action<long> Latency;

        /// <summary>当前管理器状态</summary>
        public string State
        {
            get { lock (_lock) { return _state; } }
        }

        /// <summary>
        /// 功能描述：构造隧道管理器
        ///
        /// @param relayUrl - 中继服务器地址
        /// @param memberName - 成员名
        /// @param connectTimeout - 连接超时（毫秒）
        /// </summary>
        public TunnelManager(string relayUrl = null, string memberName = null, int connectTimeout = DefaultConnectTimeout)
        {
            _relayUrl = relayUrl ?? RelayDefaultUrl;
            _memberName = memberName ?? DefaultMemberName;
            _connectTimeout = connectTimeout;
            _relayClient = new RelayClient(new RelayConfig { RelayUrl = _relayUrl });

            _relayClient.Connected += () => Log.Info("[TunnelManager] Relay connection established");
            _relayClient.Disconnected += () => Log.Warn("[TunnelManager] Relay connection disconnected");
            _relayClient.Error += ex =>
            {
                Log.Error($"[TunnelManager] Relay client error: {ex.Message}");
                Error?.Invoke(ex);
            };

            // 监听游戏客户端连接状态信令：
            // close-game-conn — 加入者全部客户端断开，房主立即关闭游戏连接
            // kcp-port — 加入者报告 KCP 本地/公网端口，房主触发外部探针建立 NAT 映射
            _relayClient.Signal += HandleRelaySignal;
            _relayClient.MemberJoined += HandleMemberJoined;
            _relayClient.MemberLeft += HandleMemberLeft;

            _localServer.StatusChanged += _ => StatusChanged?.Invoke(State);
            _localServer.Error += ex => Error?.Invoke(ex);

            // 加入者全部游戏客户端断开 → 通知房主立即关闭游戏连接
            // 在断开间隙（用户重开游戏前）发送，无竞争
            _localServer.AllClientsDisconnected += () =>
            {
                if (GetRole() != "client" || string.IsNullOrEmpty(_serverMemberId))
                {
                    return;
                }
                Log.Info("All game clients disconnected, notifying server to close game connection");
                try
                {
                    _relayClient.SendSignal(_serverMemberId, new JObject { ["type"] = "close-game-conn" });
                }
                catch (Exception ex)
                {
                    Log.Error($"Failed to send close-game-conn signal: {ex.Message}");
                }
            };

            // 游戏客户端重连 → 通知房主销毁旧连接重建，
            // 避免旧游戏响应数据通过中继污染新连接
            _localServer.ClientReconnected += () =>
            {
                if (GetRole() != "client")
                {
                    return;
                }
                if (_currentTransport is KcpTransport kcp)
                {
                    kcp.SendControl("reset");
                    Log.Debug("KCP in-band reset signal sent");
                }
                else if (_currentTransport != null && _currentTransport.Type == "relay")
                {
                    _relayClient.SendData(new byte[0]);
                    Log.Debug("Relay reset signal sent");
                }
            };
        }

        /// <summary>
        /// 功能描述：更新中继服务器地址（下次连接时生效）
        ///
        /// @param url - 中继服务器 WebSocket 地址
        /// </summary>
        public void SetRelayUrl(string url)
        {
            _relayClient.SetRelayUrl(url);
            _relayUrl = url;
        }

        // ─── 公共 API ───────────────────────────────────────

        /// <summary>
        /// 功能描述：创建房间（房主调用）
        ///
        /// 逻辑说明：检测网络 → 连接 Relay → 创建房间 → 返回房间码。
        ///
        /// @param options - 游戏信息
        /// @returns 房间创建结果
        /// @throws 网络检测失败、Relay 连接失败
        /// </summary>
        public async Task<CreateRoomResult> CreateRoomAsync(CreateRoomOptions options)
        {
            _role = "server";
            _gameId = options.GameId;
            _gameName = options.GameName;
            _gamePort = options.GamePort;

            // 1. 网络检测
            SetState("connecting-relay");
            _serverNetwork = await _networkDetector.DetectAsync();

            // 1.5 应用自定义中继地址（如有）
            if (!string.IsNullOrEmpty(options.RelayUrl) && options.RelayUrl != _relayUrl)
            {
                SetRelayUrl(options.RelayUrl);
            }

            // 2. 连接 Relay（房主端模式：二进制帧包含 sourceMemberId）
            await _relayClient.ConnectAsync();
            _relayClient.SetServerMode();

            // 3. 创建房间
            var roomResult = await _relayClient.CreateRoomAsync(new CreateRoomParams
            {
                GameId = _gameId,
                GameName = _gameName,
                GamePort = _gamePort,
                MemberName = _memberName,
                NetworkInfo = _serverNetwork
            });

            SetState("connected");
            Log.Info($"[TunnelManager] Room created: {roomResult.RoomCode}");

            Connected?.Invoke(new TunnelConnectedInfo
            {
                LocalPort = _gamePort,
                GamePort = _gamePort,
                RoomCode = roomResult.RoomCode
            });

            return roomResult;
        }

        /// <summary>
        /// 功能描述：加入房间（加入者调用）
        ///
        /// 逻辑说明：检测网络 → 连接 Relay → 加入房间 → 收集房主地址信号 →
        ///           路径选择 → 建立传输 → 启动本地隧道。
        ///
        /// @param roomCode - 6 位房间码
        /// @param relayUrl - 可选，自定义中继服务器地址
        /// @param localPort - 可选，本地隧道监听端口
        /// @throws 网络检测失败、房间不存在、所有连接方式均不可用
        /// </summary>
        public async Task JoinRoomAsync(string roomCode, string relayUrl = null, int? localPort = null)
        {
            _role = "client";
            SetState("connecting-relay");

            // 1. 网络检测
            _clientNetwork = await _networkDetector.DetectAsync();

            // 1.5 应用自定义中继地址（如有）
            if (!string.IsNullOrEmpty(relayUrl) && relayUrl != _relayUrl)
            {
                SetRelayUrl(relayUrl);
            }

            // 2. 连接 Relay
            await _relayClient.ConnectAsync();

            // 3. 注册信号预收集器（在 joinRoom 之前，防止房主 Signal 在监听器注册前到达）
            var earlySignals = new List<Tuple<string, JToken>>();
            Action<string, JToken> onEarlySignal = (from, signalData) =>
            {
                var sigType = (signalData as JObject)?.Value<string>("type") ?? "unknown";
                Log.Debug($"[Signal] Signal received: from {from}, type: {sigType}");
                earlySignals.Add(Tuple.Create(from, signalData));
            };
            _relayClient.Signal += onEarlySignal;

            string serverId = "";

            try
            {
                var joinResult = await _relayClient.JoinRoomAsync(roomCode, new JoinRoomParams
                {
                    MemberName = _memberName,
                    NetworkInfo = _clientNetwork
                });

                serverId = joinResult.ServerId;
                _serverMemberId = serverId;
                _gameId = "";
                _gamePort = joinResult.GamePort;
                _serverNetwork = joinResult.ServerNetworkInfo;
                _clientPeerInfo = BuildPeerInfo(joinResult.ServerNetworkInfo ?? _serverNetwork);

                // 将 earlySignals 中来自房主的地址信号应用到 _clientPeerInfo
                // 逻辑说明：遍历缓冲队列，更新 P2P/IPv6/KCP 地址。幂等操作，
                //           可在不同阶段多次调用（首次回放 joinRoom 期间到达的信号，
                //           二次回放 _waitFor* 超时后到达的信号）。
                void ApplyAddressSignals()
                {
                    foreach (var entry in earlySignals)
                    {
                        if (entry.Item1 != serverId)
                        {
                            continue;
                        }
                        var data = entry.Item2 as JObject;
                        if (data == null)
                        {
                            continue;
                        }
                        var type = data.Value<string>("type");

                        if (type == "p2p-address" && data["port"]?.Type == JTokenType.Integer && _clientPeerInfo != null)
                        {
                            var port = data.Value<int>("port");
                            var ip = data.Value<string>("ip");
                            if (!string.IsNullOrEmpty(ip))
                            {
                                _clientPeerInfo.PublicAddress = new EndpointInfo { Ip = ip, Port = port };
                            }
                            var localIps = data["localIps"] as JArray;
                            if (localIps != null && localIps.Count > 0)
                            {
                                _clientPeerInfo.LocalAddresses = localIps
                                    .Select(x => new EndpointInfo { Ip = x.ToString(), Port = port })
                                    .ToList();
                            }
                            // 用信号中携带的真实 NAT 信息覆盖 joinResult 中的 unknown 值
                            var natType = data.Value<string>("natType");
                            var mappingBehavior = data.Value<string>("mappingBehavior");
                            if (natType != null && mappingBehavior != null && _serverNetwork != null)
                            {
                                _serverNetwork.Ipv4.NatType = EnumUtil.ParseApiString<NatType>(natType);
                                _serverNetwork.Ipv4.MappingBehavior = EnumUtil.ParseApiString<MappingBehavior>(mappingBehavior);
                                var filtering = data.Value<string>("filteringBehavior");
                                if (filtering != null)
                                {
                                    _serverNetwork.Ipv4.FilteringBehavior = EnumUtil.ParseApiString<FilteringBehavior>(filtering);
                                }
                            }
                        }
                        if (type == "ipv6-address" && data["address"]?.Type == JTokenType.String && data["port"]?.Type == JTokenType.Integer && _clientPeerInfo != null)
                        {
                            _clientPeerInfo.Ipv6Address = data.Value<string>("address");
                            _clientPeerInfo.Ipv6Port = data.Value<int>("port");
                        }
                        if (type == "kcp-address" && data["ip"]?.Type == JTokenType.String && data["port"]?.Type == JTokenType.Integer && _clientPeerInfo != null)
                        {
                            _clientPeerInfo.KcpAddress = new EndpointInfo { Ip = data.Value<string>("ip"), Port = data.Value<int>("port") };
                        }
                    }
                }

                // 首次回放：joinRoom 期间到达的信号
                ApplyAddressSignals();

                // 3.5 根据自身网络能力按需等待信号（IPv6/P2P 不可用时无需等待）
                // IPv6 条件与 path-selector 一致: 双方 hasPublicV6 均 true 时路径才会包含 IPv6
                var signalWaits = new List<Task>();
                var serverV6 = joinResult.ServerNetworkInfo?.Ipv6 ?? _serverNetwork?.Ipv6;
                var clientV6 = _clientNetwork.Ipv6;
                if (serverV6 != null && serverV6.HasPublicV6 && clientV6.HasPublicV6)
                {
                    signalWaits.Add(WaitForIpv6Signal(serverId, 3000));
                }
                if (!string.IsNullOrEmpty(_clientNetwork.Ipv4.PublicIp))
                {
                    signalWaits.Add(WaitForP2pSignal(serverId, 1500));
                    signalWaits.Add(WaitForKcpSignal(serverId, 1500));
                }
                Log.Debug($"[Signal] Waiting for signals — IPv6: {serverV6 != null && serverV6.HasPublicV6 && clientV6.HasPublicV6}, P2P/KCP: {!string.IsNullOrEmpty(_clientNetwork.Ipv4.PublicIp)}");
                await Task.WhenAll(signalWaits);
                Log.Info("Address signal collection complete, starting path selection");

                // 二次回放：_waitFor* 超时后才到达的信号（如 STUN > 1500ms 的 kcp-address）
                ApplyAddressSignals();
            }
            finally
            {
                _relayClient.Signal -= onEarlySignal;
            }

            // 4. 路径选择与连接
            await SelectAndConnect();

            // 5. 注册游戏客户端连接处理器（仅记录日志）
            _onClientConnectedHandler = addr =>
            {
                Log.Debug($"Game client connected, transport: {GetCurrentTransport()?.Type ?? "null"}");
            };
            _localServer.ClientConnected += _onClientConnectedHandler;

            // 6. 启动本地隧道（传入自定义端口或自动选择）
            var allocPort = await _localServer.StartAsync(localPort ?? 0);

            SetState("connected");
            Log.Info($"[TunnelManager] Joined room {roomCode}, local port: {allocPort}");

            Connected?.Invoke(new TunnelConnectedInfo
            {
                LocalPort = allocPort,
                GamePort = _gamePort,
                RoomCode = roomCode
            });
        }

        /// <summary>
        /// 功能描述：离开房间
        ///
        /// 逻辑说明：停止本地隧道、断开传输、离开房间、重置状态。
        /// </summary>
        public async Task LeaveRoomAsync()
        {
            SetState("disconnecting");

            List<ITransport> clientTransports;
            List<LocalTunnelClient> clientTunnels;
            List<P2pTransport> p2pBackups;
            List<RelayPeerTransport> relayFallbacks;
            ITransport currentTransport;
            lock (_lock)
            {
                clientTransports = _clientTransports.Values.ToList();
                _clientTransports.Clear();
                clientTunnels = _clientTunnels.Values.ToList();
                _clientTunnels.Clear();
                p2pBackups = _p2pBackups.Values.ToList();
                _p2pBackups.Clear();
                relayFallbacks = _relayFallbacks.Values.ToList();
                _relayFallbacks.Clear();
                currentTransport = _currentTransport;
                _currentTransport = null;
            }

            // 断开所有 Guest 传输通道（房主侧）
            foreach (var transport in clientTransports)
            {
                try { await transport.DisconnectAsync(); } catch { /* ignore */ }
            }
            // 断开所有 Guest 本地客户端（房主侧）
            foreach (var client in clientTunnels)
            {
                try { await client.DisconnectAsync(); } catch { /* ignore */ }
            }

            // 清除所有 P2P 超时定时器
            List<string> timeoutKeys;
            lock (_lock) { timeoutKeys = _p2pTimeouts.Keys.ToList(); }
            foreach (var mid in timeoutKeys)
            {
                ClearP2pTimeout(mid);
            }

            // 断开所有 P2P 备选传输（房主侧，IPv6 场景）
            foreach (var p2p in p2pBackups)
            {
                try { await p2p.DisconnectAsync(); } catch { /* ignore */ }
            }
            // 断开所有 Relay 备选传输（房主侧）
            foreach (var relay in relayFallbacks)
            {
                try { await relay.DisconnectAsync(); } catch { /* ignore */ }
            }

            // 清理 KCP 传输映射和网络信息（房主侧）
            lock (_lock)
            {
                _clientKcpTransports.Clear();
                _clientNetworkInfos.Clear();
            }

            // 断开当前传输（加入者侧）
            if (currentTransport != null)
            {
                try { await currentTransport.DisconnectAsync(); } catch { /* ignore */ }
            }

            // 停止本地隧道服务端（加入者侧）
            try { await _localServer.StopAsync(); } catch { /* ignore */ }
            // 清理客户端连接事件监听器
            if (_onClientConnectedHandler != null)
            {
                _localServer.ClientConnected -= _onClientConnectedHandler;
                _onClientConnectedHandler = null;
            }

            // 离开房间并断开 Relay
            try { await _relayClient.LeaveRoomAsync(); } catch { /* ignore */ }
            try { await _relayClient.DisconnectAsync(); } catch { /* ignore */ }

            lock (_lock)
            {
                _currentPath = null;
                _availablePaths = new List<ConnectionPath>();
                _currentPathIndex = -1;
                _role = null;
                _serverMemberId = "";
                _trafficBytesSent = 0;
                _trafficBytesReceived = 0;
                _serverNetwork = null;
                _clientNetwork = null;
                _clientPeerInfo = null;
                _kcpReconnectAttempts = 0;
            }
            SetState("idle");
            Disconnected?.Invoke();
            Log.Info("[TunnelManager] Left room");
        }

        /// <summary>
        /// 功能描述：获取当前状态报告
        ///
        /// @returns 状态报告
        /// </summary>
        public TunnelStatusReport GetStatus()
        {
            bool isServer;
            string state;
            ITransport currentTransport;
            int localPort;
            int clientCount;
            long sent;
            long received;
            lock (_lock)
            {
                isServer = _role == "server";
                state = _state;
                currentTransport = _currentTransport;
                localPort = isServer ? _gamePort : _localServer.LocalPort;
                clientCount = isServer ? _clientTunnels.Count : _localServer.ClientCount;
                sent = _trafficBytesSent;
                received = _trafficBytesReceived;
            }
            return new TunnelStatusReport
            {
                State = state,
                TransportType = currentTransport?.Type,
                LocalPort = localPort,
                ClientCount = clientCount,
                TrafficBytesSent = sent,
                TrafficBytesReceived = received
            };
        }

        // ─── 私有方法 ───────────────────────────────────────

        /// <summary>
        /// 功能描述：中继信号统一处理（房主侧）
        ///
        /// 逻辑说明：close-game-conn 触发 LocalTunnelClient 关闭游戏连接；
        ///           kcp-port 携带加入者 KCP 端口与公网 IP，触发外部探针。
        ///
        /// @param from - 发送方成员 ID
        /// @param signalData - 信号内容
        /// </summary>
        private void HandleRelaySignal(string from, JToken signalData)
        {
            if (GetRole() != "server")
            {
                return;
            }
            var sig = signalData as JObject;
            if (sig == null)
            {
                return;
            }
            var type = sig.Value<string>("type");

            if (type == "close-game-conn")
            {
                LocalTunnelClient client;
                lock (_lock) { _clientTunnels.TryGetValue(from, out client); }
                if (client != null)
                {
                    Log.Debug($"Received close-game-conn signal, closing game connection (member {from})");
                    client.CloseConnection();
                }
            }
            if (type == "kcp-port" && sig["kcpPort"]?.Type == JTokenType.Integer)
            {
                KcpTransport kcp;
                lock (_lock) { _clientKcpTransports.TryGetValue(from, out kcp); }
                if (kcp != null)
                {
                    // 优先使用信号中携带的公网 IP（加入者 STUN 结果），
                    // 降级到 member-joined 时的 networkInfo
                    var kcpPort = sig.Value<int>("kcpPort");
                    var clientPublicIp = sig.Value<string>("publicIp");
                    if (string.IsNullOrEmpty(clientPublicIp))
                    {
                        NetworkInfo ni;
                        lock (_lock) { _clientNetworkInfos.TryGetValue(from, out ni); }
                        clientPublicIp = ni?.Ipv4.PublicIp ?? "";
                    }
                    Log.Debug($"[KCP] Received kcp-port signal: member={from}, kcpPort={kcpPort}, publicIp={clientPublicIp}, localPort={kcp.LocalPort}");
                    if (!string.IsNullOrEmpty(clientPublicIp))
                    {
                        Log.Info($"KCP external probe triggered: member {from} public {clientPublicIp}:{kcpPort}");
                        kcp.AddExternalTarget(clientPublicIp, kcpPort);
                    }
                    else
                    {
                        Log.Warn($"KCP received kcp-port but could not get member {from}'s public IP");
                    }
                }
            }
        }

        /// <summary>
        /// 功能描述：成员加入处理
        ///
        /// @param data - 成员加入数据
        /// </summary>
        private void HandleMemberJoined(MemberJoinedData data)
        {
            Log.Info($"[TunnelManager] Member joined: {data.MemberName} ({data.MemberId})");

            // 房主侧：根据网络检测结果选择最优路径，为加入者创建传输通道
            if (GetRole() == "server")
            {
                SetupServerTransport(data.MemberId, data.NetworkInfo).ContinueWith(t =>
                {
                    if (t.IsFaulted)
                    {
                        Log.Error($"Failed to establish transport for member {data.MemberId}: {t.Exception?.GetBaseException().Message}");
                    }
                });
            }

            MemberJoined?.Invoke(new MemberInfo { Id = data.MemberId, Name = data.MemberName });
        }

        /// <summary>
        /// 功能描述：成员离开处理
        ///
        /// @param memberId - 成员 ID
        /// </summary>
        private void HandleMemberLeft(string memberId)
        {
            Log.Info($"[TunnelManager] Member left: {memberId}");

            // 房主侧：清理该成员的资源
            if (GetRole() == "server")
            {
                CleanupClientTransport(memberId).ContinueWith(t =>
                {
                    if (t.IsFaulted)
                    {
                        Log.Error($"Failed to cleanup resources for member {memberId}: {t.Exception?.GetBaseException().Message}");
                    }
                });
            }

            MemberLeft?.Invoke(memberId);
        }

        /// <summary>
        /// 功能描述：启动 P2P 空闲超时定时器
        ///
        /// 逻辑说明：P2P 临时服务器创建后在指定时间内未收到连接则自动关闭。
        ///
        /// @param memberId - 成员 ID
        /// @param p2p - P2P 传输实例
        /// @param timeoutMs - 超时毫秒数
        /// </summary>
        private void StartP2pTimeout(string memberId, P2pTransport p2p, int timeoutMs)
        {
            ClearP2pTimeout(memberId);
            var timer = new Timer(_ =>
            {
                // 已连接，无需清理
                if (p2p.Status == TransportStatus.Connected)
                {
                    return;
                }

                Log.Debug($"P2P transport timeout, closing server (member {memberId})");

                // 从备选列表移除
                lock (_lock)
                {
                    if (_p2pBackups.TryGetValue(memberId, out var cur) && ReferenceEquals(cur, p2p))
                    {
                        _p2pBackups.Remove(memberId);
                    }
                }

                p2p.DisconnectAsync().ContinueWith(t => { });
            }, null, timeoutMs, Timeout.Infinite);
            lock (_lock)
            {
                _p2pTimeouts[memberId] = timer;
            }
        }

        /// <summary>
        /// 功能描述：清除 P2P 空闲超时定时器
        ///
        /// @param memberId - 成员 ID
        /// </summary>
        private void ClearP2pTimeout(string memberId)
        {
            Timer timer;
            lock (_lock)
            {
                if (_p2pTimeouts.TryGetValue(memberId, out timer))
                {
                    _p2pTimeouts.Remove(memberId);
                }
                else
                {
                    timer = null;
                }
            }
            if (timer != null)
            {
                timer.Dispose();
            }
        }

        /// <summary>
        /// 功能描述：为指定成员创建传输通道和游戏服务器连接（房主侧）
        ///
        /// 逻辑说明：根据路径选择结果创建对应传输通道：
        ///           - P2P:   创建 P2pTransport(passive) + KcpTransport(active 打洞)，
        ///                    通过 Relay Signal 将地址通知加入者
        ///           - IPv6:  创建 Ipv6DirectTransport(passive)，P2P 作为备选
        ///           - Relay: 创建 RelayPeerTransport（兜底）
        ///
        /// @param memberId - 目标成员 ID
        /// @param clientNetwork - 加入者的网络检测结果
        /// </summary>
        private async Task SetupServerTransport(string memberId, NetworkInfo clientNetwork)
        {
            ITransport existing;
            lock (_lock) { _clientTransports.TryGetValue(memberId, out existing); }
            if (existing != null)
            {
                Log.Info($"Member {memberId} already has a transport, skipping");
                return;
            }

            var paths = PathSelector.SelectPath(_serverNetwork, clientNetwork);
            var bestPath = paths[0];

            ITransport transport = null;
            P2pTransport p2pBackup = null;

            if (bestPath.Type == ConnectionPathType.P2p)
            {
                var methods = bestPath.P2pStrategy?.Methods;
                if (methods == null || methods.Count == 0)
                {
                    methods = new List<string> { "tcp", "udp" };
                }
                var hasTcp = methods.Contains("tcp");
                var hasUdp = methods.Contains("udp");

                if (hasTcp)
                {
                    var p2p = new P2pTransport();
                    p2p.SetRole("passive");
                    await p2p.ConnectAsync(new PeerConnectionInfo { PeerId = memberId });

                    var pubAddr = _serverNetwork?.Ipv4;
                    var serverLocalIps = pubAddr?.LocalAddresses ?? new List<string>();
                    if ((!string.IsNullOrEmpty(pubAddr?.PublicIp) || serverLocalIps.Count > 0) && p2p.LocalPort != 0)
                    {
                        try
                        {
                            _relayClient.SendSignal(memberId, BuildP2pAddressSignal(pubAddr, p2p.LocalPort, serverLocalIps));
                        }
                        catch (Exception ex)
                        {
                            Log.Error($"Failed to send P2P address signal: {ex.Message}");
                        }
                    }

                    transport = p2p;
                    Log.Info($"[P2P] Channel opened — member {memberId} listening on 0.0.0.0:{p2p.LocalPort}");
                    StartP2pTimeout(memberId, p2p, 60000);
                }

                if (hasUdp)
                {
                    var kcp = new KcpTransport();
                    // 双方同时主动打洞 — 参考 EasyTier/frp 的双向主动连接
                    // 房主也主动向加入者发送探针，提前在 NAT 上建立端口映射
                    kcp.SetRole("active");
                    var kcpPeer = new PeerConnectionInfo
                    {
                        PeerId = memberId,
                        PublicAddress = !string.IsNullOrEmpty(clientNetwork.Ipv4.PublicIp)
                            ? new EndpointInfo { Ip = clientNetwork.Ipv4.PublicIp, Port = clientNetwork.Ipv4.PublicPort }
                            : null,
                        LocalAddresses = clientNetwork.Ipv4.LocalAddresses.Count > 0
                            ? clientNetwork.Ipv4.LocalAddresses.Select(ip => new EndpointInfo { Ip = ip, Port = clientNetwork.Ipv4.PublicPort }).ToList()
                            : new List<EndpointInfo>()
                    };
                    // 不 await — 后台探测，立即注册信号处理器
                    kcp.ConnectAsync(kcpPeer).ContinueWith(t =>
                    {
                        if (t.IsFaulted)
                        {
                            Log.Debug($"KCP host active probe ended (member {memberId}): {t.Exception?.GetBaseException().Message}");
                        }
                    });

                    // 注册 public-addr 监听在 STUN 完成后发送 KCP 地址信号
                    Action<bool> sendKcpAddress = null;
                    sendKcpAddress = fromStun =>
                    {
                        var ip = kcp.PublicIp ?? _serverNetwork?.Ipv4.PublicIp;
                        var port = kcp.PublicPort != 0 ? kcp.PublicPort : kcp.LocalPort;
                        if (!string.IsNullOrEmpty(ip) && port != 0)
                        {
                            Log.Debug($"[KCP] Sending kcp-address signal: member={memberId}, ip={ip}, port={port}, source={(fromStun ? "STUN" : "fallback")}");
                            try
                            {
                                _relayClient.SendSignal(memberId, new JObject
                                {
                                    ["type"] = "kcp-address",
                                    ["ip"] = ip,
                                    ["port"] = port
                                });
                            }
                            catch (Exception ex)
                            {
                                Log.Error($"Failed to send KCP address signal: {ex.Message}");
                            }
                        }
                    };
                    // STUN 完成后发送（优先），未完成时用本地地址兜底
                    kcp.PublicAddr += (pubPort, pubIp) => sendKcpAddress(true);
                    // 兜底：STUN 超时/失败时 publicPort 被设为 localPort，定时器确保在其之后执行
                    new Timer(_ => sendKcpAddress(false), null, 3500, Timeout.Infinite);

                    // 注册 KCP 传输实例，使 kcp-port 信号处理器能触发外部探针
                    lock (_lock)
                    {
                        _clientKcpTransports[memberId] = kcp;
                        _clientNetworkInfos[memberId] = clientNetwork;
                    }

                    if (!hasTcp)
                    {
                        transport = kcp;
                        Log.Info($"[KCP] Channel opened — member {memberId} listening on 0.0.0.0:{kcp.LocalPort}");
                        var kcpTimer = new Timer(_ =>
                        {
                            if (kcp.Status != TransportStatus.Connected)
                            {
                                Log.Warn($"Member {memberId} KCP connection timeout");
                                kcp.DisconnectAsync().ContinueWith(t => { });
                                lock (_lock) { _clientTransports.Remove(memberId); }
                            }
                        }, null, 30000, Timeout.Infinite);
                        Action<TransportStatus> onKcpStatus = null;
                        onKcpStatus = status =>
                        {
                            if (status == TransportStatus.Connected || status == TransportStatus.Error)
                            {
                                kcpTimer.Dispose();
                                kcp.StatusChanged -= onKcpStatus;
                            }
                        };
                        kcp.StatusChanged += onKcpStatus;
                    }
                    else
                    {
                        Log.Info($"[KCP] Backup channel opened — member {memberId} listening on 0.0.0.0:{kcp.LocalPort}");
                        var tcpTransport = transport;
                        kcp.StatusChanged += status =>
                        {
                            if (status != TransportStatus.Connected)
                            {
                                return;
                            }
                            LocalTunnelClient cl;
                            ITransport cur;
                            lock (_lock)
                            {
                                _clientTunnels.TryGetValue(memberId, out cl);
                                _clientTransports.TryGetValue(memberId, out cur);
                            }
                            if (cl == null || cur != tcpTransport)
                            {
                                return;
                            }

                            ClearP2pTimeout(memberId);
                            Log.Info($"Member {memberId} switched to KCP transport (TCP fallback)");
                            cl.SetTransport(kcp);
                            var pendingCount = kcp.DrainPendingData(data => kcp.EmitData(data));
                            if (pendingCount > 0)
                            {
                                Log.Debug($"KCP switch: replaying {pendingCount} buffered data packets to LocalClient");
                            }
                            lock (_lock) { _clientTransports[memberId] = kcp; }
                            SetupTransportEvents(kcp);
                            tcpTransport.DisconnectAsync().ContinueWith(t => { });
                            TransportChanged?.Invoke("p2p");
                        };
                        // 主 TCP 先连接时，KCP 备选无需继续打洞
                        Action<TransportStatus> onTcpConnected = null;
                        onTcpConnected = status =>
                        {
                            if (status == TransportStatus.Connected)
                            {
                                kcp.DisconnectAsync().ContinueWith(t => { });
                                tcpTransport.StatusChanged -= onTcpConnected;
                            }
                        };
                        tcpTransport.StatusChanged += onTcpConnected;
                    }
                }
            }
            else if (bestPath.Type == ConnectionPathType.Ipv6)
            {
                Log.Info($"Setting up transport for member {memberId} (IPv6 primary, P2P backup)");

                var ipv6Transport = new Ipv6DirectTransport();
                ipv6Transport.SetRole(Ipv6DirectTransport.Ipv6Role.Passive);
                await ipv6Transport.ConnectAsync(new PeerConnectionInfo { PeerId = memberId });

                var v6Addr = _serverNetwork?.Ipv6.Addresses.Count > 0 ? _serverNetwork.Ipv6.Addresses[0] : null;
                if (!string.IsNullOrEmpty(v6Addr) && ipv6Transport.LocalPort != 0)
                {
                    try
                    {
                        _relayClient.SendSignal(memberId, new JObject
                        {
                            ["type"] = "ipv6-address",
                            ["address"] = v6Addr,
                            ["port"] = ipv6Transport.LocalPort
                        });
                    }
                    catch (Exception ex)
                    {
                        Log.Error($"Failed to send IPv6 address signal: {ex.Message}");
                    }
                }

                Log.Info($"[IPv6] Channel opened — member {memberId} listening on :::{ipv6Transport.LocalPort}");
                transport = ipv6Transport;

                var p2p = new P2pTransport(connectTimeout: 30000);
                p2p.SetRole("passive");
                await p2p.ConnectAsync(new PeerConnectionInfo { PeerId = memberId });

                var pubAddr = _serverNetwork?.Ipv4;
                var serverLocalIps = pubAddr?.LocalAddresses ?? new List<string>();
                if ((!string.IsNullOrEmpty(pubAddr?.PublicIp) || serverLocalIps.Count > 0) && p2p.LocalPort != 0)
                {
                    try
                    {
                        _relayClient.SendSignal(memberId, BuildP2pAddressSignal(pubAddr, p2p.LocalPort, serverLocalIps));
                    }
                    catch (Exception ex)
                    {
                        Log.Error($"Failed to send P2P backup address signal: {ex.Message}");
                    }
                }

                p2pBackup = p2p;
                lock (_lock) { _p2pBackups[memberId] = p2p; }
                Log.Info($"[P2P] Backup channel opened — member {memberId} listening on 0.0.0.0:{p2p.LocalPort} (30s timeout)");
                StartP2pTimeout(memberId, p2p, 30000);
            }
            else
            {
                Log.Info($"Setting up transport for member {memberId} (relay forwarding)");
                transport = new RelayPeerTransport(_relayClient, memberId);
                await transport.ConnectAsync(new PeerConnectionInfo { PeerId = memberId });
            }

            var client = new LocalTunnelClient();
            client.Error += err => Log.Error($"LocalTunnelClient error: {err.Message}");
            client.SetTransport(transport);
            await client.ConnectAsync(_gamePort, "127.0.0.1");

            lock (_lock)
            {
                _clientTransports[memberId] = transport;
                _clientTunnels[memberId] = client;
            }
            SetupTransportEvents(transport);
            TransportChanged?.Invoke(transport.Type);
            Log.Info($"Member {memberId} local proxy connected to 127.0.0.1:{_gamePort}");

            // 主 P2P 连接成功时清除超时定时器
            if (transport is P2pTransport primaryP2p)
            {
                primaryP2p.StatusChanged += status =>
                {
                    if (status == TransportStatus.Connected)
                    {
                        ClearP2pTimeout(memberId);
                    }
                };
            }

            if (p2pBackup != null)
            {
                var backup = p2pBackup;
                backup.StatusChanged += status =>
                {
                    if (status != TransportStatus.Connected)
                    {
                        return;
                    }
                    LocalTunnelClient cl;
                    ITransport cur;
                    lock (_lock)
                    {
                        _clientTunnels.TryGetValue(memberId, out cl);
                        _clientTransports.TryGetValue(memberId, out cur);
                    }
                    if (cl == null || cur != transport)
                    {
                        return;
                    }

                    ClearP2pTimeout(memberId);
                    Log.Info($"Member {memberId} switched to P2P transport (IPv6 backup)");
                    cl.SetTransport(backup);
                    lock (_lock)
                    {
                        _clientTransports[memberId] = backup;
                        _p2pBackups.Remove(memberId);
                    }
                    SetupTransportEvents(backup);
                    transport.DisconnectAsync().ContinueWith(t => { });
                    TransportChanged?.Invoke(backup.Type);
                };
            }

            if (bestPath.Type != ConnectionPathType.Relay)
            {
                AddRelayFallback(memberId, transport).ContinueWith(t => { });
            }
        }

        /// <summary>
        /// 功能描述：构建 p2p-address 信号 JObject
        ///
        /// @param pubAddr - 房主 IPv4 网络信息
        /// @param port - P2P 监听端口
        /// @param serverLocalIps - 房主本地地址列表
        /// @returns 信号内容
        /// </summary>
        private static JObject BuildP2pAddressSignal(Ipv4Info pubAddr, int port, List<string> serverLocalIps)
        {
            var sig = new JObject
            {
                ["type"] = "p2p-address",
                ["ip"] = pubAddr?.PublicIp ?? "",
                ["port"] = port,
                ["natType"] = EnumUtil.ToApiString(pubAddr?.NatType ?? NatType.Unknown),
                ["mappingBehavior"] = EnumUtil.ToApiString(pubAddr?.MappingBehavior ?? MappingBehavior.Unknown),
                ["filteringBehavior"] = EnumUtil.ToApiString(pubAddr?.FilteringBehavior ?? FilteringBehavior.Unknown),
                ["publicIp"] = pubAddr?.PublicIp ?? ""
            };
            if (serverLocalIps != null && serverLocalIps.Count > 0)
            {
                sig["localIps"] = new JArray(serverLocalIps.Select(x => (JToken)x.ToString()));
            }
            return sig;
        }

        /// <summary>
        /// 功能描述：创建 Relay 备选传输（房主侧）
        ///
        /// 逻辑说明：当加入者侧的 IPv6/P2P 连接失败后降级到中继，
        ///           但房主侧仍在使用主传输，导致中继数据无人接收。
        ///           注册中继数据监听器，收到数据时自动将
        ///           LocalTunnelClient 切换到 Relay 备选传输。
        ///
        /// @param memberId - 目标成员 ID
        /// @param primaryTransport - 当前主传输（切换后将被断开）
        /// </summary>
        private async Task AddRelayFallback(string memberId, ITransport primaryTransport)
        {
            var relayFallback = new RelayPeerTransport(_relayClient, memberId);
            await relayFallback.ConnectAsync(new PeerConnectionInfo { PeerId = memberId });
            lock (_lock) { _relayFallbacks[memberId] = relayFallback; }

            Action<byte[]> onRelayData = null;
            onRelayData = data =>
            {
                LocalTunnelClient cl;
                ITransport cur;
                lock (_lock)
                {
                    _clientTunnels.TryGetValue(memberId, out cl);
                    _clientTransports.TryGetValue(memberId, out cur);
                }
                if (cl == null)
                {
                    return;
                }

                // 已切换到中继，跳过
                if (ReferenceEquals(cur, relayFallback))
                {
                    return;
                }

                Log.Info($"Member {memberId} switched to relay transport (primary transport degraded)");
                relayFallback.Data -= onRelayData;
                lock (_lock) { _relayFallbacks.Remove(memberId); }

                cl.SetTransport(relayFallback);
                lock (_lock) { _clientTransports[memberId] = relayFallback; }
                SetupTransportEvents(relayFallback);
                primaryTransport.DisconnectAsync().ContinueWith(t => { });
                TransportChanged?.Invoke("relay");

                // 重新发射本次数据，让客户端的 DATA 监听器处理
                relayFallback.EmitData(data);
            };

            relayFallback.Data += onRelayData;
        }

        /// <summary>
        /// 功能描述：清理指定成员的传输资源
        ///
        /// @param memberId - 成员 ID
        /// </summary>
        private async Task CleanupClientTransport(string memberId)
        {
            ClearP2pTimeout(memberId);

            LocalTunnelClient client;
            ITransport transport;
            P2pTransport p2pBackup;
            RelayPeerTransport relayBackup;
            lock (_lock)
            {
                _clientTunnels.TryGetValue(memberId, out client);
                if (client != null) { _clientTunnels.Remove(memberId); }
                _clientTransports.TryGetValue(memberId, out transport);
                if (transport != null) { _clientTransports.Remove(memberId); }
                _p2pBackups.TryGetValue(memberId, out p2pBackup);
                if (p2pBackup != null) { _p2pBackups.Remove(memberId); }
                _relayFallbacks.TryGetValue(memberId, out relayBackup);
                if (relayBackup != null) { _relayFallbacks.Remove(memberId); }
                _clientKcpTransports.Remove(memberId);
                _clientNetworkInfos.Remove(memberId);
            }

            if (client != null)
            {
                try { await client.DisconnectAsync(); } catch { /* ignore */ }
            }
            if (transport != null)
            {
                try { await transport.DisconnectAsync(); } catch { /* ignore */ }
            }
            if (p2pBackup != null)
            {
                try { await p2pBackup.DisconnectAsync(); } catch { /* ignore */ }
            }
            if (relayBackup != null)
            {
                try { await relayBackup.DisconnectAsync(); } catch { /* ignore */ }
            }

            Log.Info($"Transport resources cleaned up for member {memberId}");
        }

        /// <summary>
        /// 功能描述：路径选择并建立连接（加入者侧）
        ///
        /// 逻辑说明：使用 PathSelector 获取有序路径列表，按序尝试连接。
        /// </summary>
        private async Task SelectAndConnect()
        {
            SetState("connecting-transport");
            _availablePaths = PathSelector.SelectPath(_serverNetwork, _clientNetwork);

            // 日志：NAT 类型与路径选择摘要
            var serverNat = _serverNetwork?.Ipv4.NatType ?? NatType.Unknown;
            var clientNat = _clientNetwork?.Ipv4.NatType ?? NatType.Unknown;
            var serverMapping = _serverNetwork?.Ipv4.MappingBehavior ?? MappingBehavior.Unknown;
            var clientMapping = _clientNetwork?.Ipv4.MappingBehavior ?? MappingBehavior.Unknown;
            var descriptions = string.Join(" → ", _availablePaths.Select(p => p.Description));
            Log.Info($"Path selection: [{descriptions}] (server NAT: {EnumUtil.ToApiString(serverNat)}/{EnumUtil.ToApiString(serverMapping)}, client NAT: {EnumUtil.ToApiString(clientNat)}/{EnumUtil.ToApiString(clientMapping)})");

            // 顺序尝试每个路径，失败后自动切换到下一路径
            for (int i = 0; i < _availablePaths.Count; i++)
            {
                try
                {
                    lock (_lock)
                    {
                        _currentPathIndex = i;
                        _currentPath = _availablePaths[i];
                    }
                    await ConnectWithPath();
                    return;
                }
                catch (Exception err)
                {
                    if (i < _availablePaths.Count - 1)
                    {
                        var nextDesc = _availablePaths[i + 1].Description;
                        Log.Warn($"{_availablePaths[i].Description} connection failed: {err.Message}, falling back to {nextDesc}");
                    }
                    else
                    {
                        SetState("error");
                        var finalErr = new Exception("All connection methods unavailable");
                        Error?.Invoke(finalErr);
                        throw finalErr;
                    }
                }
            }
        }

        /// <summary>
        /// 功能描述：使用当前路径建立连接（加入者侧）
        ///
        /// 逻辑说明：创建 Transport，连接对端，设置到本地隧道。
        ///           成功时更新状态，失败时抛出异常供 SelectAndConnect / Degrade 处理。
        ///
        /// @throws 创建或连接 Transport 失败
        /// </summary>
        private async Task ConnectWithPath()
        {
            Log.Info($"Attempting connection: {_currentPath.Description}");

            // 断开旧传输（先置 null 防止 STATUS 事件触发重复降级）
            ITransport oldTransport;
            lock (_lock)
            {
                oldTransport = _currentTransport;
                _currentTransport = null;
            }
            if (oldTransport != null)
            {
                try { await oldTransport.DisconnectAsync(); } catch { /* ignore */ }
            }

            var transport = await CreateAndConnect();

            // 设置到本地隧道（加入者侧）
            lock (_lock) { _currentTransport = transport; }
            _localServer.SetTransport(transport);

            // 回放 KCP 缓冲数据：监听器注册前到达的数据可能丢失
            if (transport is KcpTransport kcp)
            {
                var drained = kcp.DrainPendingData(data => kcp.EmitData(data));
                if (drained > 0)
                {
                    Log.Debug($"KCP replaying {drained} buffered data packets to LocalServer");
                }
            }

            SetupTransportEvents(transport);

            SetState("connected");
            TransportChanged?.Invoke(transport.Type);
            Log.Info($"{_currentPath.Description} connection successful");
        }

        /// <summary>
        /// 功能描述：创建并连接 Transport（P2P 路径并行尝试 TCP/UDP，非 P2P 直接创建）
        ///
        /// 逻辑说明：
        ///   - 非 P2P 路径（IPv6/Relay）：直接创建对应 Transport 并连接
        ///   - P2P 路径且仅单方法：顺序连接
        ///   - P2P 路径且多方法：并行同时尝试 TCP 和 UDP，取最快建立的连接
        ///   - KCP 连接成功后（加入者侧）：自动创建中继备用传输，主传输断开时无缝切换
        ///
        /// @returns 已连接的 Transport 实例
        /// </summary>
        private async Task<ITransport> CreateAndConnect()
        {
            if (_currentPath.Type != ConnectionPathType.P2p)
            {
                var transport = CreateTransport(_currentPath.Type);
                if (transport is P2pTransport p2p)
                {
                    p2p.SetRole(_role == "server" ? "passive" : "active");
                }
                await transport.ConnectAsync(_clientPeerInfo ?? new PeerConnectionInfo { PeerId = "" });
                return transport;
            }

            // P2P：按优先级尝试 TCP / UDP
            var methods = _currentPath.P2pStrategy?.Methods;
            if (methods == null || methods.Count == 0)
            {
                methods = new List<string> { "tcp", "udp" };
            }
            var role = _role == "server" ? "passive" : "active";

            if (methods.Count == 1)
            {
                // 单方法：顺序尝试
                return await TrySingleP2pMethod(methods[0], role);
            }

            // 多方法：并行竞争，取最快建立的连接
            var pending = new List<Tuple<string, ITransport, Task<ITransport>>>();
            var peerInfo = _clientPeerInfo ?? new PeerConnectionInfo { PeerId = "" };

            foreach (var method in methods)
            {
                if (method == "tcp")
                {
                    var p2p = new P2pTransport();
                    p2p.SetRole(role);
                    var promise = p2p.ConnectAsync(peerInfo).ContinueWith(t =>
                    {
                        if (t.IsFaulted)
                        {
                            throw t.Exception?.GetBaseException() ?? new Exception("P2P connect failed");
                        }
                        return (ITransport)p2p;
                    });
                    pending.Add(Tuple.Create(method, (ITransport)p2p, promise));
                }
                else
                {
                    var kcp = CreateKcpWithSignals();
                    var promise = kcp.ConnectAsync(peerInfo).ContinueWith(t =>
                    {
                        if (t.IsFaulted)
                        {
                            throw t.Exception?.GetBaseException() ?? new Exception("KCP connect failed");
                        }
                        // KCP 成功 → 创建中继备用
                        if (GetRole() == "client")
                        {
                            AddClientRelayFallback(kcp).ContinueWith(ft =>
                            {
                                if (ft.IsFaulted)
                                {
                                    Log.Warn($"Failed to create relay fallback: {ft.Exception?.GetBaseException().Message}");
                                }
                            });
                        }
                        return (ITransport)kcp;
                    });
                    pending.Add(Tuple.Create(method, (ITransport)kcp, promise));
                }
            }

            try
            {
                var winnerPromise = await Task.WhenAny(pending.Select(p => p.Item3));
                var winner = await winnerPromise;

                // 清理较慢的传输
                foreach (var p in pending)
                {
                    if (!ReferenceEquals(p.Item2, winner))
                    {
                        p.Item2.DisconnectAsync().ContinueWith(t => { });
                        p.Item3.ContinueWith(t => { }); // 吞掉被断开的 connect 异常
                    }
                }

                var winnerMethod = pending.FirstOrDefault(p => ReferenceEquals(p.Item2, winner))?.Item1 ?? "unknown";
                Log.Info($"P2P parallel race: {winnerMethod} won");
                return winner;
            }
            catch (Exception err)
            {
                // 所有方法均失败：确保所有 transport 已清理
                foreach (var p in pending)
                {
                    if (p.Item2.Status != TransportStatus.Disconnected)
                    {
                        p.Item2.DisconnectAsync().ContinueWith(t => { });
                    }
                    p.Item3.ContinueWith(t => { });
                }
                throw err;
            }
        }

        /// <summary>
        /// 功能描述：尝试单一 P2P 连接方法
        ///
        /// @param method - "tcp" 或 "udp"
        /// @param role - 连接角色（active/passive）
        /// @returns 已连接的 Transport
        /// </summary>
        private async Task<ITransport> TrySingleP2pMethod(string method, string role)
        {
            if (method == "tcp")
            {
                var p2p = new P2pTransport();
                p2p.SetRole(role);
                await p2p.ConnectAsync(_clientPeerInfo ?? new PeerConnectionInfo { PeerId = "" });
                return p2p;
            }

            var kcp = CreateKcpWithSignals();
            await kcp.ConnectAsync(_clientPeerInfo ?? new PeerConnectionInfo { PeerId = "" });

            // KCP 成功 → 创建中继备用（加入者侧）
            if (GetRole() == "client")
            {
                AddClientRelayFallback(kcp).ContinueWith(t =>
                {
                    if (t.IsFaulted)
                    {
                        Log.Warn($"Failed to create relay fallback: {t.Exception?.GetBaseException().Message}");
                    }
                });
            }

            return kcp;
        }

        /// <summary>
        /// 功能描述：创建 KCP 传输并注册信号处理器
        ///
        /// 逻辑说明：提取 KCP 实例创建和 bound/public-addr 信号注册的公共逻辑，
        ///           供 CreateAndConnect 和 TryKcpReconnect 复用。
        ///
        /// @returns 配置好的 KcpTransport 实例（尚未 connect）
        /// </summary>
        private KcpTransport CreateKcpWithSignals()
        {
            var kcp = new KcpTransport();
            kcp.SetRole(_role == "server" ? "passive" : "active");

            if (_role == "client" && !string.IsNullOrEmpty(_serverMemberId))
            {
                // Guest 侧：绑定后立即发送 kcp-port（本地端口），
                // 房主尽早开始探测建立 NAT 映射；STUN 公网地址发现后更新
                kcp.Bound += localPort =>
                {
                    var publicIp = _clientNetwork?.Ipv4.PublicIp ?? "";
                    Log.Debug($"[KCP] Sending kcp-port signal: localPort={localPort}, publicIp={publicIp}");
                    try
                    {
                        _relayClient.SendSignal(_serverMemberId, new JObject
                        {
                            ["type"] = "kcp-port",
                            ["kcpPort"] = localPort,
                            ["publicIp"] = publicIp
                        });
                    }
                    catch (Exception ex)
                    {
                        Log.Error($"Failed to send KCP port signal: {ex.Message}");
                    }
                };
                kcp.PublicAddr += (pubPort, pubIp) =>
                {
                    var publicIp = string.IsNullOrEmpty(pubIp) ? (_clientNetwork?.Ipv4.PublicIp ?? "") : pubIp;
                    Log.Debug($"[KCP] Sending kcp-port UPDATE signal: pubPort={pubPort}, publicIp={publicIp}");
                    try
                    {
                        _relayClient.SendSignal(_serverMemberId, new JObject
                        {
                            ["type"] = "kcp-port",
                            ["kcpPort"] = pubPort,
                            ["publicIp"] = publicIp
                        });
                    }
                    catch (Exception ex)
                    {
                        Log.Error($"Failed to send KCP port update signal: {ex.Message}");
                    }
                };
            }

            return kcp;
        }

        /// <summary>
        /// 功能描述：创建加入者侧中继备用传输
        ///
        /// 逻辑说明：KCP 连接建立后额外创建一个 RelayPeerTransport 作为备用。
        ///           当 KCP 断开且中继有数据到达时自动切换，实现无缝降级。
        ///
        /// @param primaryTransport - 主传输（KCP）
        /// </summary>
        private async Task AddClientRelayFallback(ITransport primaryTransport)
        {
            if (string.IsNullOrEmpty(_serverMemberId))
            {
                return;
            }

            var relayFallback = new RelayPeerTransport(_relayClient, null, _serverMemberId);
            await relayFallback.ConnectAsync(new PeerConnectionInfo { PeerId = _serverMemberId });

            Action<byte[]> onRelayData = null;
            onRelayData = data =>
            {
                ITransport current;
                lock (_lock) { current = _currentTransport; }

                // 已切换到中继，跳过
                if (ReferenceEquals(current, relayFallback))
                {
                    return;
                }

                // 主传输仍连接，忽略中继数据
                if (primaryTransport.Status == TransportStatus.Connected)
                {
                    return;
                }

                Log.Info("Client switched to relay transport (KCP disconnected)");
                relayFallback.Data -= onRelayData;

                ITransport oldTransport;
                lock (_lock)
                {
                    oldTransport = _currentTransport;
                    _currentTransport = relayFallback;
                }
                _localServer.SetTransport(relayFallback);
                SetupTransportEvents(relayFallback);

                if (oldTransport != null && !ReferenceEquals(oldTransport, relayFallback))
                {
                    oldTransport.DisconnectAsync().ContinueWith(t => { });
                }
                TransportChanged?.Invoke("relay");

                // 重新发射本次数据
                relayFallback.EmitData(data);
            };

            relayFallback.Data += onRelayData;
            Log.Debug("Relay fallback transport established");
        }

        /// <summary>
        /// 功能描述：KCP 传输重连（加入者侧）
        ///
        /// 逻辑说明：KCP 空闲超时或传输错误时尝试重建连接。
        ///           指数退避：2s → 4s → 8s，最多 3 次。
        ///           成功后重新绑定到 LocalServer，重设传输事件。
        ///           超过重试次数后降级到下一路径。
        ///
        /// @throws 所有重试均失败时抛出错误
        /// </summary>
        private async Task TryKcpReconnect()
        {
            if (_kcpReconnectAttempts >= KcpReconnectMaxRetries)
            {
                Log.Warn("KCP reconnect reached max attempts, switching to degrade");
                _kcpReconnectAttempts = 0;
                Degrade().ContinueWith(t =>
                {
                    if (t.IsFaulted)
                    {
                        Error?.Invoke(t.Exception?.GetBaseException());
                    }
                });
                return;
            }

            var delay = KcpReconnectBaseDelay * (int)Math.Pow(2, _kcpReconnectAttempts);
            _kcpReconnectAttempts++;
            Log.Info($"KCP reconnect attempt {_kcpReconnectAttempts} (waiting {delay}ms)");

            await Task.Delay(delay);

            try
            {
                ITransport oldTransport;
                lock (_lock) { oldTransport = _currentTransport; }

                var kcp = CreateKcpWithSignals();
                await kcp.ConnectAsync(_clientPeerInfo ?? new PeerConnectionInfo { PeerId = "" });

                // 切换传输
                lock (_lock) { _currentTransport = kcp; }
                _localServer.SetTransport(kcp);

                // 断开旧传输
                if (oldTransport != null)
                {
                    try { await oldTransport.DisconnectAsync(); } catch { /* ignore */ }
                }

                // 回放缓冲数据
                var drained = kcp.DrainPendingData(data => kcp.EmitData(data));
                if (drained > 0)
                {
                    Log.Debug($"KCP reconnect: replaying {drained} buffered data packets to LocalServer");
                }

                SetupTransportEvents(kcp);
                _kcpReconnectAttempts = 0;
                Log.Info("KCP reconnection successful");
                TransportChanged?.Invoke("p2p");
            }
            catch (Exception err)
            {
                Log.Warn($"KCP reconnection failed: {err.Message}");
                // 递归重试
                await TryKcpReconnect();
            }
        }

        /// <summary>
        /// 功能描述：自动降级到下一优先级路径
        ///
        /// 逻辑说明：当前传输失败时自动尝试下一优先级。发射 degrading 事件。
        /// </summary>
        private async Task Degrade()
        {
            // 防止重复降级（断开旧传输时触发的 STATUS 事件可能导致递归）
            lock (_lock)
            {
                if (_isDegrading)
                {
                    Log.Warn("Already degrading, skipping duplicate degrade request");
                    return;
                }
                _isDegrading = true;
            }

            try
            {
                string fromPath;
                int nextIndex;
                lock (_lock)
                {
                    fromPath = _currentPath?.Description ?? "unknown";
                    nextIndex = _currentPathIndex + 1;
                }

                if (nextIndex >= _availablePaths.Count)
                {
                    SetState("error");
                    Error?.Invoke(new Exception("All connection methods unavailable"));
                    return;
                }

                var toDesc = _availablePaths[nextIndex].Description;
                Degrading?.Invoke(fromPath, toDesc);
                Log.Info($"Degrading: {fromPath} → {toDesc}");

                // 顺序尝试后续每个路径，避免递归 degrade
                for (int i = nextIndex; i < _availablePaths.Count; i++)
                {
                    try
                    {
                        lock (_lock)
                        {
                            _currentPathIndex = i;
                            _currentPath = _availablePaths[i];
                        }
                        await ConnectWithPath();
                        return;
                    }
                    catch (Exception err)
                    {
                        Log.Warn($"{_availablePaths[i].Description} degrade failed: {err.Message}");
                    }
                }

                // 所有路径均失败
                SetState("error");
                Error?.Invoke(new Exception("All connection methods unavailable"));
            }
            finally
            {
                lock (_lock) { _isDegrading = false; }
            }
        }

        /// <summary>
        /// 功能描述：根据路径类型创建对应的 Transport 实例
        ///
        /// @param type - 路径类型
        /// @returns Transport 实例
        /// </summary>
        private ITransport CreateTransport(ConnectionPathType type)
        {
            switch (type)
            {
                case ConnectionPathType.Ipv6:
                    return new Ipv6DirectTransport();
                case ConnectionPathType.P2p:
                    return new P2pTransport();
                default:
                    return new RelayPeerTransport(_relayClient, null, _serverMemberId);
            }
        }

        /// <summary>
        /// 功能描述：注册 Transport 的事件监听
        ///
        /// @param transport - Transport 实例
        /// </summary>
        private void SetupTransportEvents(ITransport transport)
        {
            transport.Data += data =>
            {
                lock (_lock) { _trafficBytesReceived += data.Length; }
            };

            transport.Latency += rtt =>
            {
                Log.Debug($"Latency: {rtt}ms");
                Latency?.Invoke(rtt);
            };

            transport.StatusChanged += status =>
            {
                ITransport current;
                List<ConnectionPath> paths;
                bool isClient;
                lock (_lock)
                {
                    current = _currentTransport;
                    paths = _availablePaths;
                    isClient = _role == "client";
                }

                if (status == TransportStatus.Disconnected)
                {
                    // 旧传输被替换时忽略其状态变更
                    if (!ReferenceEquals(current, transport))
                    {
                        return;
                    }
                    // 房主侧不管理路径选择
                    if (paths.Count == 0)
                    {
                        Log.Warn("Server transport disconnected, waiting for reconnect");
                        return;
                    }
                    // 传输短暂断开，等待 RelayClient 自动重连
                    Log.Warn("Transport disconnected, waiting for auto-reconnect...");
                    return;
                }
                if (status == TransportStatus.Error)
                {
                    if (!ReferenceEquals(current, transport))
                    {
                        return;
                    }
                    if (paths.Count == 0)
                    {
                        Log.Warn("Server transport error, waiting for client to reconnect");
                        return;
                    }
                    // KCP 传输错误时尝试重连，而非直接降级
                    if (transport is KcpTransport && isClient)
                    {
                        TryKcpReconnect().ContinueWith(t =>
                        {
                            if (t.IsFaulted)
                            {
                                Log.Error($"KCP reconnection failed: {t.Exception?.GetBaseException().Message}");
                            }
                        });
                        return;
                    }
                    Log.Warn($"Transport error: {status}");
                    if (transport is KcpTransport)
                    {
                        Log.Info("KCP transport disconnected, skipping degrade (server/single-path scenario)");
                        return;
                    }
                    Degrade().ContinueWith(t =>
                    {
                        if (t.IsFaulted)
                        {
                            Error?.Invoke(t.Exception?.GetBaseException());
                        }
                    });
                }
            };

            transport.Traffic += snapshot =>
            {
                lock (_lock)
                {
                    _trafficBytesSent = snapshot.BytesSent;
                    _trafficBytesReceived = snapshot.BytesReceived;
                }
                Traffic?.Invoke(snapshot);
            };

            transport.Error += err => Log.Error($"Transport error: {err.Message}");
        }

        /// <summary>
        /// 功能描述：从 NetworkInfo 构建 PeerConnectionInfo
        ///
        /// 逻辑说明：提取对端网络信息中的公网地址、IPv6 地址和本地地址列表。
        ///
        /// @param networkInfo - 对端网络信息
        /// @returns 连接信息，null 表示无可用的网络信息
        /// </summary>
        private static PeerConnectionInfo BuildPeerInfo(NetworkInfo networkInfo)
        {
            if (networkInfo == null)
            {
                return null;
            }
            return new PeerConnectionInfo
            {
                PeerId = "",
                Ipv6Address = networkInfo.Ipv6.Addresses.Count > 0 ? networkInfo.Ipv6.Addresses[0] : null,
                Ipv6Port = 0,
                PublicAddress = !string.IsNullOrEmpty(networkInfo.Ipv4.PublicIp)
                    ? new EndpointInfo { Ip = networkInfo.Ipv4.PublicIp, Port = networkInfo.Ipv4.PublicPort }
                    : null,
                LocalAddresses = networkInfo.Ipv4.LocalAddresses.Count > 0
                    ? networkInfo.Ipv4.LocalAddresses.Select(ip => new EndpointInfo { Ip = ip, Port = networkInfo.Ipv4.PublicPort }).ToList()
                    : new List<EndpointInfo>()
            };
        }

        /// <summary>
        /// 功能描述：等待房主通过 Signal 发送 P2P 地址
        ///
        /// 逻辑说明：房主创建 P2P 被动传输后在临时端口监听，通过 Relay Signal
        ///           将该地址通知加入者。超时表示房主未选择 P2P 路径。
        ///
        /// @param serverId - 房主成员 ID
        /// @param timeoutMs - 等待超时（毫秒）
        /// @returns 信号是否到达
        /// </summary>
        private Task<bool> WaitForP2pSignal(string serverId, int timeoutMs)
        {
            var tcs = new TaskCompletionSource<bool>();
            Timer timer = null;
            Action<string, JToken> onSignal = null;

            timer = new Timer(_ =>
            {
                _relayClient.Signal -= onSignal;
                Log.Info("P2P address signal wait timed out, continuing with path ordering");
                tcs.TrySetResult(false);
            }, null, timeoutMs, Timeout.Infinite);

            onSignal = (from, signalData) =>
            {
                if (from != serverId)
                {
                    return;
                }
                var sig = signalData as JObject;
                if (sig == null)
                {
                    return;
                }
                if (sig.Value<string>("type") == "p2p-address" && sig["port"]?.Type == JTokenType.Integer)
                {
                    timer.Dispose();
                    _relayClient.Signal -= onSignal;
                    if (_clientPeerInfo != null)
                    {
                        var port = sig.Value<int>("port");
                        var ip = sig.Value<string>("ip");
                        if (!string.IsNullOrEmpty(ip))
                        {
                            _clientPeerInfo.PublicAddress = new EndpointInfo { Ip = ip, Port = port };
                        }
                        var localIps = sig["localIps"] as JArray;
                        if (localIps != null && localIps.Count > 0)
                        {
                            _clientPeerInfo.LocalAddresses = localIps
                                .Select(x => new EndpointInfo { Ip = x.ToString(), Port = port })
                                .ToList();
                        }
                        // 用信号中携带的真实 NAT 信息覆盖 joinResult 中的 unknown 值
                        var natType = sig.Value<string>("natType");
                        var mappingBehavior = sig.Value<string>("mappingBehavior");
                        if (natType != null && mappingBehavior != null && _serverNetwork != null)
                        {
                            _serverNetwork.Ipv4.NatType = EnumUtil.ParseApiString<NatType>(natType);
                            _serverNetwork.Ipv4.MappingBehavior = EnumUtil.ParseApiString<MappingBehavior>(mappingBehavior);
                            var filtering = sig.Value<string>("filteringBehavior");
                            if (filtering != null)
                            {
                                _serverNetwork.Ipv4.FilteringBehavior = EnumUtil.ParseApiString<FilteringBehavior>(filtering);
                            }
                            Log.Info($"Server NAT info applied from signal: {natType}/{mappingBehavior}");
                        }
                    }
                    Log.Info("Server P2P address signal received");
                    tcs.TrySetResult(true);
                }
            };
            _relayClient.Signal += onSignal;
            return tcs.Task;
        }

        /// <summary>
        /// 功能描述：等待房主通过 Signal 发送 IPv6 监听地址
        ///
        /// @param serverId - 房主成员 ID
        /// @param timeoutMs - 等待超时（毫秒）
        /// @returns 信号是否到达
        /// </summary>
        private Task<bool> WaitForIpv6Signal(string serverId, int timeoutMs)
        {
            var tcs = new TaskCompletionSource<bool>();
            Timer timer = null;
            Action<string, JToken> onSignal = null;

            timer = new Timer(_ =>
            {
                _relayClient.Signal -= onSignal;
                Log.Info("IPv6 address signal wait timed out, continuing with path ordering");
                tcs.TrySetResult(false);
            }, null, timeoutMs, Timeout.Infinite);

            onSignal = (from, signalData) =>
            {
                if (from != serverId)
                {
                    return;
                }
                var sig = signalData as JObject;
                if (sig == null)
                {
                    return;
                }
                if (sig.Value<string>("type") == "ipv6-address" && sig["address"]?.Type == JTokenType.String && sig["port"]?.Type == JTokenType.Integer)
                {
                    timer.Dispose();
                    _relayClient.Signal -= onSignal;
                    if (_clientPeerInfo != null)
                    {
                        _clientPeerInfo.Ipv6Address = sig.Value<string>("address");
                        _clientPeerInfo.Ipv6Port = sig.Value<int>("port");
                    }
                    Log.Info("Server IPv6 address signal received");
                    tcs.TrySetResult(true);
                }
            };
            _relayClient.Signal += onSignal;
            return tcs.Task;
        }

        /// <summary>
        /// 功能描述：等待房主通过 Signal 发送 KCP UDP 地址
        ///
        /// @param serverId - 房主成员 ID
        /// @param timeoutMs - 等待超时（毫秒）
        /// @returns 信号是否到达
        /// </summary>
        private Task<bool> WaitForKcpSignal(string serverId, int timeoutMs)
        {
            var tcs = new TaskCompletionSource<bool>();
            Timer timer = null;
            Action<string, JToken> onSignal = null;

            timer = new Timer(_ =>
            {
                _relayClient.Signal -= onSignal;
                Log.Info("KCP address signal wait timed out, continuing with path ordering");
                tcs.TrySetResult(false);
            }, null, timeoutMs, Timeout.Infinite);

            onSignal = (from, signalData) =>
            {
                if (from != serverId)
                {
                    return;
                }
                var sig = signalData as JObject;
                if (sig == null)
                {
                    return;
                }
                if (sig.Value<string>("type") == "kcp-address" && sig["ip"]?.Type == JTokenType.String && sig["port"]?.Type == JTokenType.Integer)
                {
                    timer.Dispose();
                    _relayClient.Signal -= onSignal;
                    if (_clientPeerInfo != null)
                    {
                        _clientPeerInfo.KcpAddress = new EndpointInfo { Ip = sig.Value<string>("ip"), Port = sig.Value<int>("port") };
                    }
                    Log.Info("Server KCP address signal received");
                    tcs.TrySetResult(true);
                }
            };
            _relayClient.Signal += onSignal;
            return tcs.Task;
        }

        /// <summary>
        /// 功能描述：设置管理器状态并触发事件
        ///
        /// @param state - 新状态
        /// </summary>
        private void SetState(string state)
        {
            lock (_lock) { _state = state; }
            StatusChanged?.Invoke(state);
        }

        /// <summary>
        /// 功能描述：线程安全读取当前角色
        ///
        /// @returns 当前角色（server/client/null）
        /// </summary>
        private string GetRole()
        {
            lock (_lock) { return _role; }
        }

        /// <summary>
        /// 功能描述：线程安全读取当前传输
        ///
        /// @returns 当前主传输
        /// </summary>
        private ITransport GetCurrentTransport()
        {
            lock (_lock) { return _currentTransport; }
        }
    }
}
