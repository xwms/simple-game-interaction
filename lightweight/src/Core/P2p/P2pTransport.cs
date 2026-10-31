using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace SGI
{
    /// <summary>
    /// P2P TCP 直连传输
    ///
    /// 对应 src/core/p2p/peer-connection.ts 的 C# 移植。
    /// 通过 IPv4 TCP 直接连接对端公网地址。
    /// 使用 RelayClient 交换双方公网 IP:Port（通过 STUN 获取），
    /// 然后尝试直接 TCP 连接。同 LAN 情况下优先使用私有 IP 地址。
    /// 连接失败时由 TunnelManager 降级到 Relay。
    ///
    /// 数据帧格式：所有 TCP 数据均采用长度前缀帧封装。
    /// [frameType(1), payload...]
    /// - 0x00 (DATA):  + UInt32BE(length) + data → 游戏数据
    /// - 0x01 (PING):  + seqNo(1) → 延迟探测
    /// - 0x02 (PONG):  + seqNo(1) → 延迟回复
    /// </summary>
    internal class P2pTransport : ITransport
    {
        /// <summary>帧类型常量</summary>
        private const byte FtData = 0x00;
        private const byte FtPing = 0x01;
        private const byte FtPong = 0x02;

        private readonly object _lock = new object();
        private readonly int _connectTimeoutMs;
        private readonly int _maxRetries;
        private TcpClient _socket;
        private TcpListener _server;
        private TransportStatus _status = TransportStatus.Disconnected;
        private long _trafficBytesSent;
        private long _trafficBytesReceived;
        private Timer _trafficTimer;
        private string _role = "active";
        private int _localPort;
        /// <summary>TCP 接收缓冲区 — 累积数据并逐帧解析</summary>
        private byte[] _recvBuffer = new byte[0];
        /// <summary>延迟测量定时器</summary>
        private Timer _latencyTimer;
        /// <summary>Ping 序列号计数器</summary>
        private int _pingSeqNo;
        /// <summary>在途 Ping 的时间戳表（seqNo → 毫秒时间戳）</summary>
        private readonly Dictionary<int, long> _lastPingTimes = new Dictionary<int, long>();
        private Thread _readThread;
        private Thread _acceptThread;

        /// <summary>传输类型（p2p）</summary>
        public string Type => "p2p";

        /// <summary>当前状态</summary>
        public TransportStatus Status
        {
            get { lock (_lock) { return _status; } }
        }

        /// <summary>passive 模式下 TCP 服务器的本地监听端口</summary>
        public int LocalPort
        {
            get { lock (_lock) { return _localPort; } }
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
        /// <summary>重置信号（本传输不产生，保留接口）</summary>
        public event Action Reset;
        /// <summary>延迟测量</summary>
        public event Action<long> Latency;

        /// <summary>
        /// 功能描述：构造 P2P 传输
        ///
        /// @param connectTimeout - 连接超时（毫秒）
        /// @param maxRetries - 最大重试次数
        /// </summary>
        public P2pTransport(int connectTimeout = 8000, int maxRetries = 2)
        {
            _connectTimeoutMs = connectTimeout;
            _maxRetries = maxRetries;
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
        /// 功能描述：建立 P2P TCP 连接
        ///
        /// 逻辑说明：Active 方主动连接对端公网地址（优先同 LAN 私有地址）。
        ///           Passive 方创建临时 TCP 服务器等待连接。
        ///           超时时间由 connectTimeout 控制。
        ///
        /// @param peerInfo - 对端连接信息
        /// @throws 连接超时 / 地址无效 / 连接拒绝
        /// </summary>
        public Task ConnectAsync(PeerConnectionInfo peerInfo)
        {
            SetStatus(TransportStatus.Connecting);

            if (_role == "passive")
            {
                return StartPassive();
            }
            return StartActive(peerInfo);
        }

        /// <summary>
        /// 功能描述：断开 P2P 连接
        /// </summary>
        public Task DisconnectAsync()
        {
            StopTrafficMonitor();
            StopLatencyMonitor();
            lock (_lock)
            {
                _localPort = 0;
                _recvBuffer = new byte[0];
                if (_socket != null)
                {
                    try { _socket.Close(); } catch { /* 忽略 */ }
                    _socket = null;
                }
                if (_server != null)
                {
                    try { _server.Stop(); } catch { /* 忽略 */ }
                    _server = null;
                }
            }
            SetStatus(TransportStatus.Disconnected);
            Close?.Invoke();
            return Task.CompletedTask;
        }

        /// <summary>
        /// 功能描述：发送数据到对端
        ///
        /// @param data - 二进制数据
        /// @throws 未连接时抛出 Exception
        /// </summary>
        public Task SendAsync(byte[] data)
        {
            TcpClient socket;
            lock (_lock)
            {
                socket = _socket;
            }
            if (socket == null)
            {
                throw new Exception("P2P transport not connected");
            }

            var frame = new byte[5 + data.Length];
            frame[0] = FtData;
            WriteUInt32BE(frame, 1, data.Length);
            Buffer.BlockCopy(data, 0, frame, 5, data.Length);

            try
            {
                socket.GetStream().Write(frame, 0, frame.Length);
                _trafficBytesSent += data.Length;
            }
            catch (Exception ex)
            {
                throw new Exception($"P2P send failed: {ex.Message}");
            }
            return Task.CompletedTask;
        }

        /// <summary>
        /// 功能描述：Active 方发起 TCP 连接
        ///
        /// 逻辑说明：优先尝试私有 IP 地址（同 LAN 场景），
        ///           然后尝试公网 IP 地址。
        ///
        /// @param peerInfo - 对端连接信息
        /// </summary>
        private Task StartActive(PeerConnectionInfo peerInfo)
        {
            // 优先尝试私有地址（同 LAN）
            var targets = new List<(string Host, int Port, string Label)>();
            if (peerInfo.LocalAddresses != null)
            {
                foreach (var addr in peerInfo.LocalAddresses)
                {
                    targets.Add((addr.Ip, addr.Port, $"local address {addr.Ip}"));
                }
            }
            if (peerInfo.PublicAddress != null)
            {
                targets.Add((peerInfo.PublicAddress.Ip, peerInfo.PublicAddress.Port, $"public address {peerInfo.PublicAddress.Ip}"));
            }

            if (targets.Count == 0)
            {
                throw new Exception("P2P missing peer address info");
            }

            return Task.Run(async () =>
            {
                foreach (var target in targets)
                {
                    try
                    {
                        await TryConnect(target.Host, target.Port, _connectTimeoutMs);
                        Log.Info($"P2P connection successful ({target.Label})");
                        return;
                    }
                    catch (Exception ex)
                    {
                        Log.Warn($"P2P connection failed ({target.Label}): {ex.Message}");
                    }
                }
                throw new Exception("P2P connection failed, all addresses unreachable");
            });
        }

        /// <summary>
        /// 功能描述：Passive 方创建临时 TCP 服务器
        ///
        /// 逻辑说明：监听 0.0.0.0 上的临时端口，等待对端连接。
        /// </summary>
        private Task StartPassive()
        {
            return Task.Run(() =>
            {
                var server = new TcpListener(IPAddress.Any, 0);
                try
                {
                    server.Start();
                    lock (_lock)
                    {
                        _server = server;
                        _localPort = ((IPEndPoint)server.LocalEndpoint).Port;
                    }
                    Log.Info($"P2P temporary server started :{_localPort}");
                    _acceptThread = new Thread(() => AcceptLoop(server))
                    {
                        IsBackground = true,
                        Name = "p2p-accept"
                    };
                    _acceptThread.Start();
                }
                catch (Exception ex)
                {
                    throw new Exception($"P2P server error: {ex.Message}");
                }
            });
        }

        /// <summary>
        /// 功能描述：Passive 模式接受连接循环
        ///
        /// @param server - 本线程专属的监听器
        /// </summary>
        private void AcceptLoop(TcpListener server)
        {
            while (true)
            {
                TcpClient client;
                try
                {
                    client = server.AcceptTcpClient();
                }
                catch
                {
                    if (!ReferenceEquals(_server, server))
                    {
                        break;
                    }
                    continue;
                }
                Log.Info($"P2P passive received connection [{client.Client.RemoteEndPoint}]");
                OnConnected(client);
            }
        }

        /// <summary>
        /// 功能描述：尝试 TCP 连接到指定地址
        ///
        /// @param host - 目标主机
        /// @param port - 目标端口
        /// @param timeoutMs - 超时时间
        /// </summary>
        private Task TryConnect(string host, int port, int timeoutMs)
        {
            return Task.Run(() =>
            {
                var client = new TcpClient(AddressFamily.InterNetwork);
                try
                {
                    client.NoDelay = true;
                    var connectTask = client.ConnectAsync(host, port);
                    if (!connectTask.Wait(timeoutMs))
                    {
                        client.Close();
                        throw new Exception("Connection timeout");
                    }
                    if (connectTask.IsFaulted)
                    {
                        client.Close();
                        throw connectTask.Exception?.GetBaseException() ?? new Exception("connect failed");
                    }
                    OnConnected(client);
                }
                catch
                {
                    try { client.Close(); } catch { /* 忽略 */ }
                    throw;
                }
            });
        }

        /// <summary>
        /// 功能描述：连接建立后的公共处理
        ///
        /// @param client - 已连接的 TCP socket
        /// </summary>
        private void OnConnected(TcpClient client)
        {
            TcpListener server;
            lock (_lock)
            {
                server = _server;
                if (server != null)
                {
                    _server = null;
                }
                _socket = client;
            }
            if (server != null)
            {
                try { server.Stop(); } catch { /* 忽略 */ }
            }

            client.NoDelay = true;
            SetStatus(TransportStatus.Connected);
            StartTrafficMonitor();
            StartLatencyMonitor();

            _readThread = new Thread(() => ReadLoop(client))
            {
                IsBackground = true,
                Name = "p2p-read"
            };
            _readThread.Start();
        }

        /// <summary>
        /// 功能描述：后台读取循环
        ///
        /// @param client - 已连接的 socket
        /// </summary>
        private void ReadLoop(TcpClient client)
        {
            try
            {
                var stream = client.GetStream();
                var buffer = new byte[8192];
                while (true)
                {
                    int n;
                    try
                    {
                        n = stream.Read(buffer, 0, buffer.Length);
                    }
                    catch
                    {
                        break;
                    }
                    if (n <= 0)
                    {
                        break;
                    }
                    var chunk = new byte[n];
                    Buffer.BlockCopy(buffer, 0, chunk, 0, n);
                    AppendRecvBuffer(chunk);
                    ParseFrames();
                }
            }
            catch
            {
                // 读取异常按断开处理
            }
            finally
            {
                StopTrafficMonitor();
                StopLatencyMonitor();
                lock (_lock)
                {
                    if (_socket == client)
                    {
                        _socket = null;
                    }
                    _recvBuffer = new byte[0];
                }
                SetStatus(TransportStatus.Disconnected);
                Close?.Invoke();
                try
                {
                    client.Close();
                }
                catch
                {
                    // 客户端可能已关闭
                }
            }
        }

        /// <summary>
        /// 功能描述：将新数据追加到接收缓冲区
        ///
        /// @param chunk - 新到达的数据
        /// </summary>
        private void AppendRecvBuffer(byte[] chunk)
        {
            lock (_lock)
            {
                var merged = new byte[_recvBuffer.Length + chunk.Length];
                Buffer.BlockCopy(_recvBuffer, 0, merged, 0, _recvBuffer.Length);
                Buffer.BlockCopy(chunk, 0, merged, _recvBuffer.Length, chunk.Length);
                _recvBuffer = merged;
            }
        }

        /// <summary>
        /// 功能描述：从接收缓冲区逐帧解析
        ///
        /// 逻辑说明：TCP 流模式下，多个帧可能在同一 data 事件中到达。
        ///           循环解析 _recvBuffer 中的帧，每帧根据类型和长度精确切分。
        ///           DATA 帧游戏数据从帧中剥离后发出 Data 事件。
        ///           PING/PONG 帧直接处理延迟测量，不进入游戏数据流。
        /// </summary>
        private void ParseFrames()
        {
            while (true)
            {
                byte[] buffer;
                lock (_lock)
                {
                    buffer = _recvBuffer;
                }
                if (buffer.Length == 0)
                {
                    return;
                }
                int frameType = buffer[0];

                if (frameType == FtData)
                {
                    if (buffer.Length < 5) return;
                    int dataLen = ReadUInt32BE(buffer, 1);
                    if (buffer.Length < 5 + dataLen) return;
                    var data = new byte[dataLen];
                    Buffer.BlockCopy(buffer, 5, data, 0, dataLen);
                    ConsumeRecvBuffer(5 + dataLen);
                    _trafficBytesReceived += dataLen;
                    Data?.Invoke(data);

                }
                else if (frameType == FtPing)
                {
                    if (buffer.Length < 2) return;
                    byte seqNo = buffer[1];
                    ConsumeRecvBuffer(2);
                    TcpClient socket;
                    lock (_lock)
                    {
                        socket = _socket;
                    }
                    if (socket != null)
                    {
                        try
                        {
                            socket.GetStream().Write(new[] { FtPong, seqNo }, 0, 2);
                        }
                        catch
                        {
                            // 忽略写入失败
                        }
                    }

                }
                else if (frameType == FtPong)
                {
                    if (buffer.Length < 2) return;
                    byte seqNo = buffer[1];
                    ConsumeRecvBuffer(2);
                    long pingTime;
                    lock (_lock)
                    {
                        if (_lastPingTimes.TryGetValue(seqNo, out pingTime))
                        {
                            _lastPingTimes.Remove(seqNo);
                        }
                        else
                        {
                            continue;
                        }
                    }
                    long rtt = Stopwatch.GetTimestamp() - pingTime;
                    if (rtt >= 0 && rtt < 60000)
                    {
                        Latency?.Invoke(rtt);
                    }

                }
                else
                {
                    ConsumeRecvBuffer(1);
                }
            }
        }

        /// <summary>
        /// 功能描述：移除接收缓冲区前 n 字节
        ///
        /// @param n - 移除字节数
        /// </summary>
        private void ConsumeRecvBuffer(int n)
        {
            lock (_lock)
            {
                if (n >= _recvBuffer.Length)
                {
                    _recvBuffer = new byte[0];
                    return;
                }
                var rest = new byte[_recvBuffer.Length - n];
                Buffer.BlockCopy(_recvBuffer, n, rest, 0, rest.Length);
                _recvBuffer = rest;
            }
        }

        /// <summary>
        /// 功能描述：启动延迟测量（每 5 秒发送 Ping 帧）
        ///
        /// 逻辑说明：仅主动端（active）发送 Ping，被动端只回显 Pong。
        /// </summary>
        private void StartLatencyMonitor()
        {
            StopLatencyMonitor();
            if (_role != "active")
            {
                return;
            }
            _latencyTimer = new Timer(_ =>
            {
                TcpClient socket;
                lock (_lock)
                {
                    socket = _socket;
                }
                if (socket == null)
                {
                    return;
                }
                byte seqNo = (byte)(_pingSeqNo++ & 0xFF);
                lock (_lock)
                {
                    _lastPingTimes.Remove(seqNo);
                    _lastPingTimes[seqNo] = Stopwatch.GetTimestamp();
                }
                try
                {
                    socket.GetStream().Write(new[] { FtPing, seqNo }, 0, 2);
                }
                catch
                {
                    // 忽略写入失败
                }
            }, null, 5000, 5000);
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
            lock (_lock)
            {
                _lastPingTimes.Clear();
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
                    Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
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
        /// 功能描述：将 32 位整数按大端序写入字节数组
        ///
        /// @param buffer - 目标数组
        /// @param offset - 写入偏移
        /// @param value - 要写入的值
        /// </summary>
        private static void WriteUInt32BE(byte[] buffer, int offset, int value)
        {
            buffer[offset] = (byte)((value >> 24) & 0xFF);
            buffer[offset + 1] = (byte)((value >> 16) & 0xFF);
            buffer[offset + 2] = (byte)((value >> 8) & 0xFF);
            buffer[offset + 3] = (byte)(value & 0xFF);
        }

        /// <summary>
        /// 功能描述：从字节数组按大端序读取 32 位整数
        ///
        /// @param buffer - 源数组
        /// @param offset - 读取偏移
        /// @returns 读取到的值
        /// </summary>
        private static int ReadUInt32BE(byte[] buffer, int offset)
        {
            return (buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3];
        }
    }
}
