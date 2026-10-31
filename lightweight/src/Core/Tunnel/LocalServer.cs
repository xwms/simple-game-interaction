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
    /// 本地 TCP 隧道服务端
    ///
    /// 对应 src/core/tunnel/local-server.ts 的 C# 移植。
    /// 在本地监听 TCP 端口，接收游戏客户端连接；每个客户端的数据经
    /// ITransport 转发到远端，远端数据再写回所有客户端。支持多客户端。
    /// </summary>
    internal class LocalTunnelServer
    {
        /// <summary>最大端口尝试次数</summary>
        private const int MaxPortRetries = 10;

        private readonly object _lock = new object();
        private TcpListener _server;
        private int _localPort;
        private ITransport _transport;
        private readonly HashSet<TcpClient> _clientConnections = new HashSet<TcpClient>();
        private TransportStatus _status = TransportStatus.Disconnected;
        private bool _allClientsDisconnected;

        // SetTransport 订阅的处理器（用于退订旧 transport）
        private Action<byte[]> _dataHandler;
        private Action<TransportStatus> _statusHandler;
        private Action<Exception> _errorHandler;
        private Action _closeHandler;

        /// <summary>服务端已启动（参数为实际端口）</summary>
        public event Action<int> Started;
        /// <summary>服务端已停止</summary>
        public event Action Stopped;
        /// <summary>新客户端连接（参数为 remoteAddr）</summary>
        public event Action<string> ClientConnected;
        /// <summary>客户端断开（参数为 remoteAddr）</summary>
        public event Action<string> ClientDisconnected;
        /// <summary>检测到游戏客户端重连</summary>
        public event Action ClientReconnected;
        /// <summary>所有客户端均已断开</summary>
        public event Action AllClientsDisconnected;
        /// <summary>隧道状态变更</summary>
        public event Action<TransportStatus> StatusChanged;
        /// <summary>错误</summary>
        public event Action<Exception> Error;

        /// <summary>当前监听端口（0 表示未启动）</summary>
        public int LocalPort
        {
            get { lock (_lock) { return _localPort; } }
        }

        /// <summary>当前隧道状态</summary>
        public TransportStatus Status
        {
            get { lock (_lock) { return _status; } }
        }

        /// <summary>当前连接的客户端数量</summary>
        public int ClientCount
        {
            get { lock (_lock) { return _clientConnections.Count; } }
        }

        /// <summary>当前使用的传输层</summary>
        public ITransport Transport
        {
            get { lock (_lock) { return _transport; } }
        }

        /// <summary>
        /// 功能描述：启动本地隧道服务端
        ///
        /// 逻辑说明：创建 TcpListener 监听 127.0.0.1。指定端口被占用时自动尝试
        ///           下一个端口（最多 10 次）。
        ///
        /// @param port - 监听端口（0 表示自动选择）
        /// @returns 实际监听端口号
        /// @throws 所有端口均被占用时抛出
        /// </summary>
        public Task<int> StartAsync(int port = 0)
        {
            lock (_lock)
            {
                if (_server != null)
                {
                    return Task.FromResult(_localPort);
                }
            }
            return Task.Run(() => TryStart(port));
        }

        /// <summary>
        /// 功能描述：停止本地隧道服务端
        ///
        /// 逻辑说明：关闭所有客户端连接，关闭服务器。
        /// </summary>
        public Task StopAsync()
        {
            DisconnectAllClients();
            lock (_lock)
            {
                if (_server != null)
                {
                    try
                    {
                        _server.Stop();
                    }
                    catch
                    {
                        // server 可能已关闭
                    }
                    _server = null;
                }
                _localPort = 0;
                _allClientsDisconnected = false;
                SetStatus(TransportStatus.Disconnected);
            }
            Log.Info("Local tunnel server stopped");
            Stopped?.Invoke();
            return Task.CompletedTask;
        }

        /// <summary>
        /// 功能描述：设置数据传输通道
        ///
        /// 逻辑说明：替换当前 ITransport，退订旧 transport 的事件并订阅新的。
        ///           新 transport 的 Data 事件转发到所有已连接的客户端。
        ///
        /// @param transport - 新的传输层
        /// </summary>
        public void SetTransport(ITransport transport)
        {
            if (_transport != null)
            {
                _transport.Data -= _dataHandler;
                _transport.StatusChanged -= _statusHandler;
                _transport.Error -= _errorHandler;
                _transport.Close -= _closeHandler;
            }

            _transport = transport;

            _dataHandler = d => WriteToAllClients(d);
            _statusHandler = s => SetStatus(s);
            _errorHandler = err =>
            {
                Log.Error($"Transport error: {err.Message}");
                Error?.Invoke(err);
            };
            _closeHandler = () => Log.Info("Transport closed, waiting for switch...");

            _transport.Data += _dataHandler;
            _transport.StatusChanged += _statusHandler;
            _transport.Error += _errorHandler;
            _transport.Close += _closeHandler;
        }

        /// <summary>
        /// 功能描述：执行端口绑定与监听启动（在后台线程运行）
        ///
        /// @param port - 期望端口（0 表示自动选择）
        /// @returns 实际监听端口
        /// </summary>
        private int TryStart(int port)
        {
            for (int attempt = 0; attempt < MaxPortRetries; attempt++)
            {
                int target = port == 0 ? 0 : port + attempt;
                var server = new TcpListener(IPAddress.Loopback, target);
                try
                {
                    server.Start();
                    lock (_lock)
                    {
                        _server = server;
                        _localPort = ((IPEndPoint)server.LocalEndpoint).Port;
                    }
                    SetStatus(TransportStatus.Connected);
                    Log.Info($"Local tunnel server started on :{_localPort}");
                    Started?.Invoke(_localPort);

                    var acceptor = new Thread(() => AcceptLoop(server))
                    {
                        IsBackground = true,
                        Name = "local-tunnel-accept"
                    };
                    acceptor.Start();
                    return _localPort;
                }
                catch (SocketException ex)
                {
                    if ((ex.SocketErrorCode == SocketError.AddressAlreadyInUse ||
                         ex.SocketErrorCode == SocketError.AccessDenied) && attempt < MaxPortRetries - 1)
                    {
                        continue;
                    }
                    throw new Exception($"Failed to bind port {target}: {ex.Message}");
                }
            }
            throw new Exception("Failed to bind any port");
        }

        /// <summary>
        /// 功能描述：后台接受客户端连接循环
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
                OnClientConnection(client);
            }
        }

        /// <summary>
        /// 功能描述：处理新客户端 TCP 连接
        ///
        /// 逻辑说明：断开之前的连接（防数据写到多个客户端导致协议错乱），
        ///           跟踪全部断开状态以检测客户端重连，随后启动读取循环。
        ///
        /// @param client - 客户端连接
        /// </summary>
        private void OnClientConnection(TcpClient client)
        {
            client.NoDelay = true;
            string remoteAddr = client.Client.RemoteEndPoint?.ToString() ?? "unknown";

            bool wasAllDisconnected;
            lock (_lock)
            {
                foreach (var existing in _clientConnections.ToList())
                {
                    try
                    {
                        existing.Close();
                    }
                    catch
                    {
                        // 忽略关闭失败
                    }
                }
                _clientConnections.Clear();

                wasAllDisconnected = _allClientsDisconnected;
                _allClientsDisconnected = false;
                _clientConnections.Add(client);
            }

            if (wasAllDisconnected)
            {
                Log.Info("Game client reconnection detected");
                ClientReconnected?.Invoke();
            }
            Log.Info($"Client connected [{remoteAddr}]");
            ClientConnected?.Invoke(remoteAddr);

            var reader = new Thread(() => ClientReadLoop(client, remoteAddr))
            {
                IsBackground = true,
                Name = "local-tunnel-client-read"
            };
            reader.Start();
        }

        /// <summary>
        /// 功能描述：单个客户端的读取循环
        ///
        /// 逻辑说明：持续读取游戏客户端数据并转发给 transport；
        ///           连接关闭或出错时清理并触发断开事件。
        ///
        /// @param client - 客户端连接
        /// @param remoteAddr - 客户端地址字符串
        /// </summary>
        private void ClientReadLoop(TcpClient client, string remoteAddr)
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
                        break; // 连接出错
                    }
                    if (n <= 0)
                    {
                        break; // 对端关闭
                    }
                    var data = new byte[n];
                    Buffer.BlockCopy(buffer, 0, data, 0, n);

                    ITransport transport;
                    TransportStatus status;
                    lock (_lock)
                    {
                        transport = _transport;
                        status = _status;
                    }
                    if (transport != null && status == TransportStatus.Connected)
                    {
                        try
                        {
                            transport.SendAsync(data).ContinueWith(t =>
                            {
                                if (t.IsFaulted)
                                {
                                    Log.Error($"Transport send failed: {t.Exception?.GetBaseException().Message}");
                                }
                            });
                        }
                        catch (Exception ex)
                        {
                            Log.Error($"Transport send failed: {ex.Message}");
                        }
                    }
                    // 无 transport 时静默丢弃数据（等待降级完成）
                }
            }
            catch
            {
                // 读取异常按断开处理
            }
            finally
            {
                bool empty;
                lock (_lock)
                {
                    _clientConnections.Remove(client);
                    empty = _clientConnections.Count == 0;
                }
                Log.Info($"Client disconnected [{remoteAddr}]");
                if (empty)
                {
                    _allClientsDisconnected = true;
                    AllClientsDisconnected?.Invoke();
                }
                ClientDisconnected?.Invoke(remoteAddr);
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
        /// 功能描述：将数据写入所有已连接的客户端
        ///
        /// @param data - 要写入的数据
        /// </summary>
        private void WriteToAllClients(byte[] data)
        {
            List<TcpClient> clients;
            lock (_lock)
            {
                clients = _clientConnections.ToList();
            }
            if (clients.Count == 0)
            {
                Log.Info($"Remote data arrived but no clients connected, dropping {data.Length}B");
                return;
            }
            foreach (var client in clients)
            {
                try
                {
                    var stream = client.GetStream();
                    stream.Write(data, 0, data.Length);
                    stream.Flush();
                }
                catch
                {
                    try
                    {
                        client.Close();
                    }
                    catch
                    {
                        // 忽略关闭失败
                    }
                    lock (_lock)
                    {
                        _clientConnections.Remove(client);
                    }
                }
            }
        }

        /// <summary>
        /// 功能描述：断开所有客户端连接
        /// </summary>
        private void DisconnectAllClients()
        {
            List<TcpClient> clients;
            lock (_lock)
            {
                clients = _clientConnections.ToList();
                _clientConnections.Clear();
            }
            foreach (var client in clients)
            {
                try
                {
                    client.Close();
                }
                catch
                {
                    // 忽略关闭失败
                }
            }
        }

        /// <summary>
        /// 功能描述：设置服务端状态并触发事件
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
    }
}
