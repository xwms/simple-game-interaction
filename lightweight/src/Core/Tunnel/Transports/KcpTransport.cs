using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace SGI
{
    /// <summary>
    /// KCP UDP 打洞传输 — 基于 UDP 的可靠传输层（多 socket 优化版）
    ///
    /// 对应 src/core/tunnel/transports/kcp-transport.ts 的 C# 移植。
    /// 通过多个 UDP 套接字进行 NAT 打洞，在 UDP 之上使用 KCP 协议提供
    /// 可靠、有序的数据传输。支持 active/passive 双模式：
    /// - active（加入者）：绑定多个 UDP 端口，向对端地址发送打洞包，
    ///   创建 KCP 实例管理连接。启动探针定时重传，通过 Relay 信号
    ///   通知房主本端端口，触发房主侧探针建立双向 NAT 映射。
    /// - passive（房主）：绑定多个 UDP 端口等待对端首包到达，
    ///   收到首包后创建 KCP 实例。收到加入者 kcp-port 信号后，
    ///   通过 AddExternalTarget() 向加入者发送探针建立 NAT 映射。
    /// 探针循环使用 10 个 socket 同时发送，提高 NAT 打洞成功率。
    /// 首个收到回包的 socket 成为主 socket，其余自动关闭。
    ///
    /// @fires Bound - UDP 绑定完成，携带本地端口
    /// @fires PublicAddr - STUN 公网地址发现完成（异步补充）
    /// </summary>
    internal class KcpTransport : ITransport
    {
        /// <summary>KCP 更新间隔（毫秒）</summary>
        private const int KcpUpdateInterval = 10;
        /// <summary>绑定的 UDP socket 数量（多个端口增加打洞成功率）</summary>
        private const int BindPortCount = 10;
        /// <summary>探针密集发送间隔（毫秒）</summary>
        private const int ProbeIntervalFast = 100;
        /// <summary>探针稳态发送间隔（毫秒）</summary>
        private const int ProbeIntervalSlow = 1500;
        /// <summary>密集期持续时间（毫秒）</summary>
        private const int ProbeFastDuration = 3000;
        /// <summary>探针包大小（模拟真实 KCP 包，避免 NAT 丢弃小包）</summary>
        private const int ProbePacketSize = 32;
        /// <summary>KCP input -1 警告上限</summary>
        private const int MaxKcpInputWarnings = 5;
        /// <summary>心跳发送间隔（毫秒）</summary>
        private const int KeepaliveInterval = 5000;
        /// <summary>无数据超时（毫秒）</summary>
        private const int IdleTimeout = 15000;
        /// <summary>空闲检测轮询间隔（毫秒）</summary>
        private const int IdleCheckInterval = 5000;
        /// <summary>握手超时（毫秒）</summary>
        private const int HandshakeTimeout = 8000;

        /// <summary>探针包标识前缀（用于接收侧过滤，避免误喂 KCP）</summary>
        private static readonly byte[] ProbeMagic = { 0xCB, 0xCE };

        private readonly object _lock = new object();
        private readonly List<UdpClient> _udpSockets = new List<UdpClient>();
        private int _primarySocketIndex;
        private Kcp _kcp;
        private TransportStatus _status = TransportStatus.Disconnected;
        private string _role = "active";
        private EndpointInfo _peerAddr;
        private int _localPort;
        private string _publicIp;
        private int _publicPort;
        private int _bindPort;
        private Timer _updateTimer;
        private long _trafficBytesSent;
        private long _trafficBytesReceived;
        private Timer _trafficTimer;
        private Timer _latencyTimer;
        private Timer _probeTimer;
        private Timer _probeFastTimer;
        private Timer _connectHandshakeTimer;
        private Timer _keepaliveTimer;
        private Timer _idleCheckTimer;
        private TaskCompletionSource<object> _connectResolve;
        private readonly List<EndpointInfo> _probeTargets = new List<EndpointInfo>();
        private readonly byte[] _probePacket;
        private bool _connectionEstablished;
        private int _kcpInputErrorCount;
        private readonly List<byte[]> _pendingData = new List<byte[]>();
        private long _lastReceiveTime;
        /// <summary>STUN 响应处理器（socket 0 收包线程调用）</summary>
        private volatile Action<byte[]> _stunHandler;

        /// <summary>传输类型（p2p）</summary>
        public string Type => "p2p";

        /// <summary>当前状态</summary>
        public TransportStatus Status
        {
            get { lock (_lock) { return _status; } }
        }

        /// <summary>passive 模式的本地 UDP 端口</summary>
        public int LocalPort
        {
            get { lock (_lock) { return _localPort; } }
        }

        /// <summary>STUN 发现的 NAT 映射公网 IP</summary>
        public string PublicIp
        {
            get { return _publicIp; }
        }

        /// <summary>STUN 发现的 NAT 映射公网端口</summary>
        public int PublicPort
        {
            get { return _publicPort; }
        }

        /// <summary>收到对端数据</summary>
        public event Action<byte[]> Data;
        /// <summary>状态变更</summary>
        public event Action<TransportStatus> StatusChanged;
        /// <summary>错误</summary>
        public event Action<Exception> Error;
        /// <summary>关闭</summary>
        public event Action Close;
        /// <summary>流量统计</summary>
        public event Action<TrafficSnapshot> Traffic;
        /// <summary>重置信号（重建游戏连接）</summary>
        public event Action Reset;
        /// <summary>延迟测量</summary>
        public event Action<long> Latency;
        /// <summary>UDP 绑定完成（携带本地端口）</summary>
        public event Action<int> Bound;
        /// <summary>STUN 公网地址发现完成（异步补充）</summary>
        public event Action<int, string> PublicAddr;

        /// <summary>
        /// 功能描述：构造 KCP 传输
        ///
        /// 逻辑说明：生成固定探针包（带 magic 前缀），供打洞循环复用。
        /// </summary>
        public KcpTransport()
        {
            _probePacket = new byte[ProbePacketSize];
            _probePacket[0] = ProbeMagic[0];
            _probePacket[1] = ProbeMagic[1];
            var rand = new Random();
            rand.NextBytes(_probePacket);
            _probePacket[0] = ProbeMagic[0];
            _probePacket[1] = ProbeMagic[1];
        }

        /// <summary>
        /// 功能描述：设置本地绑定端口（可选，默认随机）
        ///           仅主 socket 使用此端口，其余 socket 绑定随机端口。
        ///
        /// @param port - UDP 端口号（0=随机）
        /// </summary>
        public void SetBindPort(int port)
        {
            _bindPort = port;
        }

        /// <summary>
        /// 功能描述：设置连接角色（在 connect 之前调用）
        ///
        /// @param role - active（发起方）或 passive（接收方）
        /// </summary>
        public void SetRole(string role)
        {
            _role = role;
        }

        /// <summary>
        /// 功能描述：回放 pending 缓冲区数据到回调
        ///
        /// 逻辑说明：对于 connect() 后延迟注册 Data 监听器的场景，
        ///           调用此方法将期间缓冲的数据回放到回调中。
        ///
        /// @param handler - 数据回调，收到 byte[] 数据
        /// @returns 回放的数据条数
        /// </summary>
        public int DrainPendingData(Action<byte[]> handler)
        {
            int count = 0;
            List<byte[]> pending;
            lock (_lock)
            {
                pending = _pendingData.ToList();
                _pendingData.Clear();
            }
            foreach (var data in pending)
            {
                handler(data);
                count++;
            }
            return count;
        }

        /// <summary>
        /// 功能描述：向订阅者发射收到数据的事件
        ///
        /// 逻辑说明：C# 事件只能在声明类内部调用，TunnelManager 需通过此方法
        ///           把回放/重连缓冲的数据送入 Data 事件流。
        ///
        /// @param data - 收到的数据
        /// </summary>
        public void EmitData(byte[] data)
        {
            Data?.Invoke(data);
        }

        /// <summary>
        /// 功能描述：建立 KCP UDP 连接
        ///
        /// 逻辑说明：
        ///   - 绑定 BindPortCount 个 UDP 端口，增大打洞成功率
        ///   - active 模式：绑定后立即发送打洞包 → 对端首包到达后创建 KCP
        ///   - passive 模式：绑定后等待首包 → 收到后创建 KCP → 发送 ACK
        ///   - Bound 事件在绑定完成后立即发射，不等待 STUN 完成
        ///   - STUN 查询异步执行，完成后更新 PublicIp/PublicPort
        ///
        /// @param peerInfo - 对端连接信息（active 模式需含 KcpAddress 或 PublicAddress）
        /// @throws 缺少地址信息 / 套接字错误 / 握手超时
        /// </summary>
        public Task ConnectAsync(PeerConnectionInfo peerInfo)
        {
            SetStatus(TransportStatus.Connecting);
            var tcs = new TaskCompletionSource<object>();

            try
            {
                for (int i = 0; i < BindPortCount; i++)
                {
                    var client = new UdpClient();
                    int port = i == 0 ? _bindPort : 0;
                    client.Client.Bind(new IPEndPoint(IPAddress.Any, port));
                    _udpSockets.Add(client);

                    int socketIndex = i;
                    var thread = new Thread(() => ReceiveLoop(client, socketIndex))
                    {
                        IsBackground = true,
                        Name = $"kcp-udp-{i}"
                    };
                    thread.Start();
                }

                _localPort = ((IPEndPoint)_udpSockets[0].Client.LocalEndPoint).Port;
                Bound?.Invoke(_localPort);

                StartStunQuery();

                if (_role == "active")
                {
                    var targetAddr = peerInfo.KcpAddress ?? peerInfo.PublicAddress;
                    if (targetAddr == null)
                    {
                        throw new Exception("KCP missing peer address");
                    }

                    // 构建候选地址列表
                    var candidates = new List<EndpointInfo>();
                    if (targetAddr.Ip != "127.0.0.1")
                    {
                        candidates.Add(new EndpointInfo { Ip = "127.0.0.1", Port = targetAddr.Port });
                    }
                    if (peerInfo.LocalAddresses != null)
                    {
                        foreach (var addr in peerInfo.LocalAddresses)
                        {
                            if (addr.Ip != targetAddr.Ip && addr.Ip != "127.0.0.1")
                            {
                                candidates.Add(new EndpointInfo { Ip = addr.Ip, Port = addr.Port });
                            }
                        }
                    }
                    candidates.Add(new EndpointInfo { Ip = targetAddr.Ip, Port = targetAddr.Port });

                    lock (_lock)
                    {
                        _probeTargets.Clear();
                        _probeTargets.AddRange(candidates);
                    }

                    _connectResolve = tcs;
                    StartProbeLoop(true);

                    _connectHandshakeTimer = new Timer(_ =>
                    {
                        TaskCompletionSource<object> resolve;
                        lock (_lock)
                        {
                            resolve = _connectResolve;
                            _connectResolve = null;
                        }
                        if (resolve != null && !resolve.Task.IsCompleted)
                        {
                            resolve.TrySetException(new Exception($"UDP hole punching handshake timeout, no response from peer (target={targetAddr.Ip}:{targetAddr.Port})"));
                        }
                    }, null, HandshakeTimeout, Timeout.Infinite);
                }
                else
                {
                    Log.Info($"KCP passive mode ready ({BindPortCount} sockets)");
                    tcs.TrySetResult(null);
                }
            }
            catch (Exception ex)
            {
                tcs.TrySetException(ex);
            }

            return tcs.Task;
        }

        /// <summary>
        /// 功能描述：断开 KCP 连接
        ///
        /// 逻辑说明：停止所有定时器，关闭所有 UDP 套接字，重置状态。
        /// </summary>
        public Task DisconnectAsync()
        {
            ClearHandshake();
            StopLatencyMonitor();
            StopUpdateLoop();
            StopTrafficMonitor();
            StopProbeLoop();
            lock (_lock)
            {
                _kcp = null;
                _peerAddr = null;
                _localPort = 0;
                _publicIp = null;
                _publicPort = 0;
                _pendingData.Clear();
                _connectionEstablished = false;
                _lastReceiveTime = 0;
            }
            foreach (var socket in _udpSockets)
            {
                try { socket.Close(); } catch { /* 忽略 */ }
            }
            _udpSockets.Clear();
            _primarySocketIndex = 0;
            SetStatus(TransportStatus.Disconnected);
            Close?.Invoke();
            return Task.CompletedTask;
        }

        /// <summary>
        /// 功能描述：通过 KCP 发送数据到对端
        ///
        /// 逻辑说明：调用 Kcp.Send() 将数据加入 KCP 发送队列，
        ///           加入后立即调用 Flush() 刷出，避免等待定时器。
        ///           为防止单次 send 超过 KCP 内部分片上限（256 fragments），
        ///           将输入数据按 MSS × 200 大小分块发送。
        ///           每个分块前添加帧类型字节（0x00=DATA）。
        ///
        /// @param data - 二进制数据
        /// @throws 未连接时抛出 Exception
        /// </summary>
        public Task SendAsync(byte[] data)
        {
            Kcp kcp;
            lock (_lock)
            {
                kcp = _kcp;
            }
            if (kcp == null || _status != TransportStatus.Connected)
            {
                throw new Exception("KCP transport not connected");
            }

            uint mss = kcp.GetMss();
            int maxChunkSize = (int)(mss * 200) - 1;
            int offset = 0;
            int chunkCount = 0;

            while (offset < data.Length)
            {
                int end = Math.Min(offset + maxChunkSize, data.Length);
                int chunkLen = end - offset;
                var framed = new byte[1 + chunkLen];
                framed[0] = 0x00;
                Buffer.BlockCopy(data, offset, framed, 1, chunkLen);
                int ret = kcp.Send(framed);
                if (ret < 0)
                {
                    throw new Exception($"KCP send failed (ret={ret})");
                }
                _trafficBytesSent += framed.Length;
                offset = end;
                chunkCount++;
            }

            if (chunkCount > 1)
            {
                Log.Debug($"KCP send split {data.Length}B → {chunkCount} chunks");
            }

            kcp.Update((uint)Now());
            kcp.Flush();
            return Task.CompletedTask;
        }

        /// <summary>
        /// 功能描述：通过 KCP 发送控制帧
        ///
        /// 逻辑说明：发送带帧类型字节的控制消息，与数据帧共享同一 KCP 流，
        ///           保证控制信号与游戏数据的到达顺序。
        ///
        /// @param type - 控制帧类型（'reset' = 0x01，'keepalive' = 0x02）
        /// </summary>
        public void SendControl(string type)
        {
            Kcp kcp;
            lock (_lock)
            {
                kcp = _kcp;
            }
            if (kcp == null || _status != TransportStatus.Connected)
            {
                Log.Warn("KCP send control frame failed: not connected");
                return;
            }

            byte frameType;
            switch (type)
            {
                case "reset":
                    frameType = 0x01;
                    break;
                case "keepalive":
                    frameType = 0x02;
                    break;
                default:
                    Log.Warn($"Unknown control frame type: {type}");
                    return;
            }

            int ret = kcp.Send(new[] { frameType });
            if (ret < 0)
            {
                Log.Warn($"KCP control frame send failed (ret={ret})");
                return;
            }
            _trafficBytesSent += 1;
            kcp.Update((uint)Now());
            kcp.Flush();
        }

        /// <summary>
        /// 功能描述：初始化 KCP 实例
        ///
        /// 逻辑说明：创建 Kcp 实例，注册 output 回调（通过主 socket 发送数据到对端）。
        ///           使用低延迟配置：启用 nodelay、快速重传、无拥塞控制。
        /// </summary>
        private void InitKcp()
        {
            var kcp = new Kcp(0, 0, buf =>
            {
                UdpClient socket;
                EndpointInfo peer;
                lock (_lock)
                {
                    if (_udpSockets.Count == 0 || _primarySocketIndex >= _udpSockets.Count)
                    {
                        return;
                    }
                    socket = _udpSockets[_primarySocketIndex];
                    peer = _peerAddr;
                }
                if (socket != null && peer != null)
                {
                    try
                    {
                        var copy = new byte[buf.Length];
                        Buffer.BlockCopy(buf, 0, copy, 0, buf.Length);
                        socket.Send(copy, copy.Length, peer.Ip, peer.Port);
                    }
                    catch (Exception ex)
                    {
                        Log.Warn($"KCP output UDP send error: {ex.Message}");
                    }
                }
            });
            kcp.SetNodelay(true, 2, true);
            kcp.SetInterval(KcpUpdateInterval);
            kcp.SetWndSize(2048, 1024);
            lock (_lock)
            {
                _kcp = kcp;
            }
        }

        /// <summary>
        /// 功能描述：关闭除主 socket 外的所有其余 socket
        ///
        /// 逻辑说明：建立连接后只需一个 socket 传输 KCP 数据。
        ///           关闭其他 socket 释放端口，防止后续垃圾数据干扰。
        /// </summary>
        private void CloseExtraSockets()
        {
            lock (_lock)
            {
                for (int i = 0; i < _udpSockets.Count; i++)
                {
                    if (i != _primarySocketIndex)
                    {
                        try { _udpSockets[i].Close(); } catch { /* 忽略 */ }
                    }
                }
                var primary = _udpSockets[_primarySocketIndex];
                _udpSockets.Clear();
                _udpSockets.Add(primary);
                _primarySocketIndex = 0;
            }
        }

        /// <summary>
        /// 功能描述：通过 STUN 协议获取本机公网 IP 和端口
        ///
        /// 逻辑说明：复用主 socket（socket 0），向多个 STUN 服务器并发发送 Binding Request，
        ///           取最快返回的 XOR-MAPPED-ADDRESS。超时 3 秒后返回 null（不影响打洞）。
        ///           确保 STUN 映射地址与实际通信的 NAT 映射一致。
        /// </summary>
        private void StartStunQuery()
        {
            var servers = new[]
            {
                "stun.miwifi.com:3478",
                "stun.chat.bilibili.com:3478",
                "stun.cloudflare.com:3478",
                "stun.l.google.com:19302"
            };

            UdpClient socket;
            lock (_lock)
            {
                if (_udpSockets.Count == 0)
                {
                    return;
                }
                socket = _udpSockets[0];
            }

            int pending = servers.Length;
            var done = false;
            var timeoutTimer = new Timer(_ =>
            {
                _stunHandler = null;
                if (!done)
                {
                    done = true;
                    lock (_lock)
                    {
                        _publicPort = _localPort;
                    }
                }
            }, null, 3000, Timeout.Infinite);

            _stunHandler = msg =>
            {
                if (done) return;
                try
                {
                    if (msg.Length < 20) return;
                    if (ReadUInt16BE(msg, 0) != 0x0101) return;
                    if (ReadUInt32BE(msg, 4) != 0x2112a442u) return;

                    int offset = 20;
                    while (offset + 4 <= msg.Length)
                    {
                        int attrType = ReadUInt16BE(msg, offset);
                        int attrLen = ReadUInt16BE(msg, offset + 2);
                        if (attrType == 0x0020 && attrLen >= 8)
                        {
                            int xPort = ReadUInt16BE(msg, offset + 6) ^ 0x2112;
                            byte a0 = (byte)(msg[offset + 8] ^ ((0x2112a442 >> 24) & 0xff));
                            byte a1 = (byte)(msg[offset + 9] ^ ((0x2112a442 >> 16) & 0xff));
                            byte a2 = (byte)(msg[offset + 10] ^ ((0x2112a442 >> 8) & 0xff));
                            byte a3 = (byte)(msg[offset + 11] ^ (0x2112a442 & 0xff));
                            string ip = $"{a0}.{a1}.{a2}.{a3}";

                            done = true;
                            _stunHandler = null;
                            timeoutTimer.Dispose();
                            lock (_lock)
                            {
                                _publicIp = ip;
                                _publicPort = xPort;
                            }
                            PublicAddr?.Invoke(xPort, ip);
                            return;
                        }
                        offset += 4 + attrLen;
                        if (offset % 4 != 0)
                        {
                            offset += 4 - (offset % 4);
                        }
                    }
                }
                catch
                {
                    // 忽略解析异常
                }
            };

            foreach (var server in servers)
            {
                var parts = server.Split(':');
                if (parts.Length != 2) { pending--; continue; }
                string host = parts[0];
                int serverPort;
                if (!int.TryParse(parts[1], out serverPort)) { pending--; continue; }

                var buf = new byte[20];
                WriteUInt16BE(buf, 0, 0x0001);   // Binding Request
                WriteUInt16BE(buf, 2, 0);        // message length
                WriteUInt32BE(buf, 4, 0x2112a442u); // magic cookie
                var rand = new Random();
                rand.NextBytes(buf);
                buf[0] = 0x00; buf[1] = 0x01;
                buf[2] = 0x00; buf[3] = 0x00;
                WriteUInt32BE(buf, 4, 0x2112a442u);

                try
                {
                    socket.Send(buf, buf.Length, host, serverPort);
                }
                catch
                {
                    pending--;
                    if (pending <= 0 && !done)
                    {
                        done = true;
                        _stunHandler = null;
                        timeoutTimer.Dispose();
                        lock (_lock)
                        {
                            _publicPort = _localPort;
                        }
                    }
                }
            }
        }

        /// <summary>
        /// 功能描述：后台 UDP 接收循环
        ///
        /// @param client - UDP 套接字
        /// @param socketIndex - socket 索引
        /// </summary>
        private void ReceiveLoop(UdpClient client, int socketIndex)
        {
            var remoteEp = new IPEndPoint(IPAddress.Any, 0);
            while (true)
            {
                byte[] data;
                try
                {
                    data = client.Receive(ref remoteEp);
                }
                catch
                {
                    break; // socket 已关闭
                }
                OnMessage(data, remoteEp, socketIndex);
            }
        }

        /// <summary>
        /// 功能描述：处理收到的 UDP 消息
        ///
        /// 逻辑说明：
        ///   - 过滤 STUN 响应（可能延迟到达）
        ///   - active 模式首包：确认双向可达 → 记录对端地址 → 创建 KCP
        ///   - passive 模式首包：记录对端地址 → 创建 KCP → 发送原始 ACK
        ///   - 后续数据包：送入 Kcp.Input() 处理
        ///
        /// @param msg - 收到的 UDP 数据
        /// @param remote - 发送方地址
        /// @param socketIndex - 收到消息的 socket 索引
        /// </summary>
        private void OnMessage(byte[] msg, IPEndPoint remote, int socketIndex)
        {
            // 过滤 STUN 响应
            if (msg.Length >= 20 && ReadUInt16BE(msg, 0) == 0x0101 && ReadUInt32BE(msg, 4) == 0x2112a442u)
            {
                var handler = _stunHandler;
                if (handler != null)
                {
                    handler(msg);
                }
                else
                {
                    Log.Debug($"KCP STUN response received from {remote.Address}:{remote.Port}");
                }
                return;
            }

            // 过滤探针包：仅连接建立后过滤，否则会误杀对端的合法探针
            bool isProbe = msg.Length >= ProbeMagic.Length && msg[0] == ProbeMagic[0] && msg[1] == ProbeMagic[1];
            if (isProbe && _connectionEstablished)
            {
                Log.Debug($"KCP probe filtered (connected), from={remote.Address}:{remote.Port}");
                return;
            }

            _lastReceiveTime = Now();

            // 首包处理（连接建立前收到的第一个非 STUN 包）
            if (!_connectionEstablished && _status == TransportStatus.Connecting && _kcp == null)
            {
                string packetType = isProbe ? "probe" : "KCP data";
                Log.Info($"KCP {_role} first packet from {remote.Address}:{remote.Port} (type={packetType}, socket[{socketIndex}])");
                _connectionEstablished = true;
                _primarySocketIndex = socketIndex;

                lock (_lock)
                {
                    _peerAddr = new EndpointInfo { Ip = remote.Address.ToString(), Port = remote.Port };
                }
                InitKcp();
                StartUpdateLoop();
                SetStatus(TransportStatus.Connected);
                StartLatencyMonitor();
                StopProbeLoop();
                CloseExtraSockets();

                if (_role == "active")
                {
                    TaskCompletionSource<object> resolve;
                    lock (_lock)
                    {
                        resolve = _connectResolve;
                        _connectResolve = null;
                    }
                    if (resolve != null && !resolve.Task.IsCompleted)
                    {
                        resolve.TrySetResult(null);
                    }
                    ClearHandshake();
                    Log.Info($"KCP connection established (handshake confirmed, {remote.Address}:{remote.Port}, socket[{socketIndex}])");
                    SendAck();
                }
                else
                {
                    Log.Info($"KCP passive connection established ← {remote.Address}:{remote.Port} (socket[{socketIndex}])");
                    SendAck();
                }
                return;
            }

            Kcp kcp;
            lock (_lock)
            {
                kcp = _kcp;
            }
            if (kcp == null)
            {
                Log.Warn($"KCP received data but no KCP instance, len={msg.Length}, from={remote.Address}:{remote.Port}");
                return;
            }
            int ret = kcp.Input(msg);
            _trafficBytesReceived += msg.Length;
            if (ret < 0)
            {
                if (_kcpInputErrorCount < MaxKcpInputWarnings)
                {
                    _kcpInputErrorCount++;
                    uint conv = msg.Length >= 28 ? Kcp.GetConv(msg) : uint.MaxValue;
                    uint token = msg.Length >= 28 ? Kcp.GetToken(msg) : uint.MaxValue;
                    Log.Warn($"KCP input returned {ret}: conv={conv}, token={token}, len={msg.Length}");
                }
            }
            DrainKcp();
        }

        /// <summary>
        /// 功能描述：通过主 socket 发送 1 字节 ACK，使对端 connect 立即返回
        /// </summary>
        private void SendAck()
        {
            try
            {
                UdpClient socket;
                EndpointInfo peer;
                lock (_lock)
                {
                    if (_udpSockets.Count == 0 || _primarySocketIndex >= _udpSockets.Count)
                    {
                        return;
                    }
                    socket = _udpSockets[_primarySocketIndex];
                    peer = _peerAddr;
                }
                if (socket != null && peer != null)
                {
                    socket.Send(new byte[1], 1, peer.Ip, peer.Port);
                }
            }
            catch
            {
                Log.Warn("KCP send ACK failed");
            }
        }

        /// <summary>
        /// 功能描述：清理握手超时定时器和 resolve
        /// </summary>
        private void ClearHandshake()
        {
            lock (_lock)
            {
                if (_connectHandshakeTimer != null)
                {
                    _connectHandshakeTimer.Dispose();
                    _connectHandshakeTimer = null;
                }
                _connectResolve = null;
            }
        }

        /// <summary>
        /// 功能描述：从 KCP 接收缓冲区读取应用数据
        ///
        /// 逻辑说明：循环调用 kcp.Recv() 直到无数据。
        ///           解析帧类型字节：0x00=DATA, 0x01=RESET, 0x02=KEEPALIVE。
        /// </summary>
        private void DrainKcp()
        {
            Kcp kcp;
            lock (_lock)
            {
                kcp = _kcp;
            }
            if (kcp == null) return;

            int dataCount = 0;
            int controlCount = 0;
            while (true)
            {
                int peekSize = kcp.PeekSize();
                if (peekSize <= 0) break;
                var buf = new byte[peekSize];
                int len = kcp.Recv(buf);
                if (len <= 0) break;
                if (len < 1) continue;

                byte frameType = buf[0];
                if (frameType == 0x00)
                {
                    var payload = new byte[len - 1];
                    Buffer.BlockCopy(buf, 1, payload, 0, len - 1);
                    lock (_lock)
                    {
                        _pendingData.Add(payload);
                    }
                    Data?.Invoke(payload);
                    dataCount++;
                }
                else if (frameType == 0x01)
                {
                    Reset?.Invoke();
                    controlCount++;
                }
                else if (frameType == 0x02)
                {
                    // KEEPALIVE 帧：仅更新时间戳，不传递到上层
                    _lastReceiveTime = Now();
                }
                else
                {
                    Log.Warn($"KCP received unknown frame type: {frameType}");
                }
            }

            if (dataCount > 0 || controlCount > 0)
            {
                Log.Debug($"_drainKcp read {dataCount} data messages, {controlCount} control frames");
            }
        }

        /// <summary>
        /// 功能描述：启动 KCP update 循环
        /// </summary>
        private void StartUpdateLoop()
        {
            if (_updateTimer != null) return;
            StartTrafficMonitor();
            StartKeepalive();
            StartIdleCheck();
            _updateTimer = new Timer(_ =>
            {
                Kcp kcp;
                lock (_lock)
                {
                    kcp = _kcp;
                }
                if (kcp == null) return;
                DrainKcp();
                kcp.Update((uint)Now());
                DrainKcp();
                int waitSnd = kcp.GetWaitSnd();
                if (waitSnd > 2048)
                {
                    Log.Warn($"KCP send queue backlog: {waitSnd} packets");
                }
            }, null, KcpUpdateInterval, KcpUpdateInterval);
        }

        /// <summary>
        /// 功能描述：停止 KCP update 循环
        /// </summary>
        private void StopUpdateLoop()
        {
            if (_updateTimer != null)
            {
                _updateTimer.Dispose();
                _updateTimer = null;
            }
            StopKeepalive();
            StopIdleCheck();
        }

        /// <summary>
        /// 功能描述：启动 KCP 心跳发送
        ///
        /// 逻辑说明：每 5 秒发送一次 KEEPALIVE 帧 (0x02)，使对端知道本端仍在线。
        /// </summary>
        private void StartKeepalive()
        {
            StopKeepalive();
            _keepaliveTimer = new Timer(_ =>
            {
                if (_status != TransportStatus.Connected) return;
                SendControl("keepalive");
            }, null, KeepaliveInterval, KeepaliveInterval);
        }

        /// <summary>
        /// 功能描述：停止心跳发送
        /// </summary>
        private void StopKeepalive()
        {
            if (_keepaliveTimer != null)
            {
                _keepaliveTimer.Dispose();
                _keepaliveTimer = null;
            }
        }

        /// <summary>
        /// 功能描述：启动空闲超时检测
        ///
        /// 逻辑说明：每 5s 检查是否超过 IdleTimeout（15s）未收到任何 KCP 数据。
        ///           超时说明对端已不可达（UDP 无连接状态），
        ///           将状态设为 error 触发上层降级或重连。
        /// </summary>
        private void StartIdleCheck()
        {
            StopIdleCheck();
            _lastReceiveTime = Now();
            _idleCheckTimer = new Timer(_ =>
            {
                if (_status != TransportStatus.Connected) return;
                long elapsed = Now() - _lastReceiveTime;
                if (elapsed > IdleTimeout)
                {
                    Log.Warn($"KCP idle timeout: {elapsed}ms without any data");
                    StopIdleCheck();
                    SetStatus(TransportStatus.Error);
                    Error?.Invoke(new Exception($"KCP connection idle timeout ({IdleTimeout / 1000}s)"));
                }
            }, null, IdleCheckInterval, IdleCheckInterval);
        }

        /// <summary>
        /// 功能描述：停止空闲超时检测
        /// </summary>
        private void StopIdleCheck()
        {
            if (_idleCheckTimer != null)
            {
                _idleCheckTimer.Dispose();
                _idleCheckTimer = null;
            }
        }

        /// <summary>
        /// 功能描述：启动延迟测量（每 2 秒读取一次 KCP 内部 RTT）
        /// </summary>
        private void StartLatencyMonitor()
        {
            StopLatencyMonitor();
            _latencyTimer = new Timer(_ =>
            {
                Kcp kcp;
                lock (_lock)
                {
                    kcp = _kcp;
                }
                if (kcp == null) return;
                uint rtt = kcp.GetRtt();
                if (rtt > 0)
                {
                    Latency?.Invoke(rtt);
                }
            }, null, 2000, 2000);
        }

        /// <summary>
        /// 功能描述：停止延迟测量
        /// </summary>
        private void StopLatencyMonitor()
        {
            if (_latencyTimer != null)
            {
                _latencyTimer.Dispose();
                _latencyTimer = null;
            }
        }

        /// <summary>
        /// 功能描述：启动流量统计定时器（每秒发射一次）
        /// </summary>
        private void StartTrafficMonitor()
        {
            StopTrafficMonitor();
            _trafficTimer = new Timer(_ =>
            {
                var snapshot = new TrafficSnapshot
                {
                    BytesSent = _trafficBytesSent,
                    BytesReceived = _trafficBytesReceived,
                    Timestamp = Now()
                };
                Traffic?.Invoke(snapshot);
            }, null, 1000, 1000);
        }

        /// <summary>
        /// 功能描述：停止流量统计定时器
        /// </summary>
        private void StopTrafficMonitor()
        {
            if (_trafficTimer != null)
            {
                _trafficTimer.Dispose();
                _trafficTimer = null;
            }
        }

        /// <summary>
        /// 功能描述：启动 NAT 打洞探针定时重传
        ///
        /// 逻辑说明：使用所有绑定的 socket 向所有候选目标发送固定大小的打洞包。
        ///           active 模式下 connect() 后即启动持续发送直到连接建立；
        ///           passive 模式下由 AddExternalTarget() 外部触发。
        ///           初始使用密集间隔 100ms，3 秒后退避到 1500ms。
        ///
        /// @param fast - 是否从密集间隔开始
        /// </summary>
        private void StartProbeLoop(bool fast = false)
        {
            StopProbeLoop();
            if (_probeFastTimer != null)
            {
                _probeFastTimer.Dispose();
                _probeFastTimer = null;
            }

            int interval = fast ? ProbeIntervalFast : ProbeIntervalSlow;

            _probeTimer = new Timer(_ => SendProbes(), null, interval, interval);

            if (fast)
            {
                _probeFastTimer = new Timer(_ =>
                {
                    StopProbeLoop();
                    StartProbeLoop(false);
                }, null, ProbeFastDuration, Timeout.Infinite);
            }

            // 立即发送一次
            SendProbes();
        }

        /// <summary>
        /// 功能描述：向所有探针目标发送打洞包
        ///
        /// 逻辑说明：使用所有绑定的 socket 向每个目标发送固定大小的打洞包。
        ///           多 socket × 多目标组合提高 NAT 映射命中概率。
        /// </summary>
        private void SendProbes()
        {
            if (_connectionEstablished) return;
            List<UdpClient> sockets;
            List<EndpointInfo> targets;
            lock (_lock)
            {
                sockets = _udpSockets.ToList();
                targets = _probeTargets.ToList();
            }
            if (sockets.Count == 0 || targets.Count == 0) return;

            foreach (var socket in sockets)
            {
                foreach (var target in targets)
                {
                    try
                    {
                        socket.Send(_probePacket, _probePacket.Length, target.Ip, target.Port);
                    }
                    catch (Exception ex)
                    {
                        Log.Warn($"KCP probe send failed [{target.Ip}:{target.Port}]: {ex.Message}");
                    }
                }
            }
        }

        /// <summary>
        /// 功能描述：停止 NAT 打洞探针定时重传
        /// </summary>
        private void StopProbeLoop()
        {
            if (_probeTimer != null)
            {
                _probeTimer.Dispose();
                _probeTimer = null;
            }
            if (_probeFastTimer != null)
            {
                _probeFastTimer.Dispose();
                _probeFastTimer = null;
            }
        }

        /// <summary>
        /// 功能描述：添加外部探针目标并启动探针循环（被动模式用）
        ///
        /// 逻辑说明：房主收到加入者的 kcp-port 信号后调用此方法，
        ///           向加入者的公网地址发送打洞包，在房主 NAT 上建立端口映射。
        ///
        /// @param address - 目标 IP（加入者公网 IP）
        /// @param port - 目标端口（加入者 KCP 本地端口）
        /// </summary>
        public void AddExternalTarget(string address, int port)
        {
            if (_connectionEstablished) return;

            bool exists;
            lock (_lock)
            {
                exists = _probeTargets.Any(t => t.Ip == address && t.Port == port);
                if (!exists)
                {
                    _probeTargets.Add(new EndpointInfo { Ip = address, Port = port });
                    Log.Info($"KCP added external probe target: {address}:{port}");
                }
            }
            if (_probeTimer == null)
            {
                StartProbeLoop(false);
            }
        }

        /// <summary>
        /// 功能描述：设置连接状态并触发事件
        ///
        /// @param status - 新状态
        /// </summary>
        private void SetStatus(TransportStatus status)
        {
            lock (_lock)
            {
                _status = status;
            }
            StatusChanged?.Invoke(status);
        }

        /// <summary>
        /// 功能描述：当前毫秒时间戳
        /// </summary>
        private static long Now()
        {
            return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }

        private static void WriteUInt16BE(byte[] buf, int offset, int value)
        {
            buf[offset] = (byte)((value >> 8) & 0xFF);
            buf[offset + 1] = (byte)(value & 0xFF);
        }

        private static int ReadUInt16BE(byte[] buf, int offset)
        {
            return (buf[offset] << 8) | buf[offset + 1];
        }

        private static void WriteUInt32BE(byte[] buf, int offset, uint value)
        {
            buf[offset] = (byte)((value >> 24) & 0xFF);
            buf[offset + 1] = (byte)((value >> 16) & 0xFF);
            buf[offset + 2] = (byte)((value >> 8) & 0xFF);
            buf[offset + 3] = (byte)(value & 0xFF);
        }

        private static uint ReadUInt32BE(byte[] buf, int offset)
        {
            return ((uint)buf[offset] << 24) | ((uint)buf[offset + 1] << 16) | ((uint)buf[offset + 2] << 8) | buf[offset + 3];
        }
    }
}
