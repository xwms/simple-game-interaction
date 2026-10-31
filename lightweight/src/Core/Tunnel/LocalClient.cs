using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

namespace SGI
{
    /// <summary>
    /// 本地隧道客户端：房主侧连接游戏服务器
    ///
    /// 对应 src/core/tunnel/local-client.ts 的 C# 移植。
    /// 房主游戏服务器已运行在本地某端口，本模块创建 TCP 客户端连接该服务器，
    /// 将游戏数据经 ITransport 转发到远端（加入者）。
    /// 重连策略：惰性重连——服务器断开后不主动重连，待 transport 有数据到达时再建连。
    /// </summary>
    internal class LocalTunnelClient
    {
        private readonly object _lock = new object();
        private TcpClient _socket;
        private ITransport _transport;
        private TransportStatus _status = TransportStatus.Disconnected;
        private int _port;
        private string _host = "127.0.0.1";
        private Task _connectTask;
        private readonly List<byte[]> _pendingBuffer = new List<byte[]>();
        private bool _disconnecting;
        /// <summary>代际计数器：每次重连递增，用于连接回调判断是否为当前代际</summary>
        private int _gen;

        // SetTransport 订阅的处理器
        private Action<byte[]> _dataHandler;
        private Action<TransportStatus> _statusHandler;
        private Action<Exception> _errorHandler;
        private Action _closeHandler;
        private Action _resetHandler;

        /// <summary>已连接到游戏服务器</summary>
        public event Action<int, string> Connected;
        /// <summary>与游戏服务器断开</summary>
        public event Action Disconnected;
        /// <summary>状态变更</summary>
        public event Action<TransportStatus> StatusChanged;
        /// <summary>错误</summary>
        public event Action<Exception> Error;

        /// <summary>当前连接状态</summary>
        public TransportStatus Status
        {
            get { lock (_lock) { return _status; } }
        }

        /// <summary>是否已连接到游戏服务器</summary>
        public bool ConnectedFlag
        {
            get { lock (_lock) { return _socket != null && _socket.Client != null && _socket.Connected; } }
        }

        /// <summary>
        /// 功能描述：立即关闭当前游戏服务器连接
        ///
        /// 逻辑说明：由 relay close-game-conn 信令触发。与 forceReconnect 不同，
        ///           不等待数据到达，立即销毁 socket。下次数据到达时惰性重连正常工作。
        /// </summary>
        public void CloseConnection()
        {
            lock (_lock)
            {
                if (_disconnecting)
                {
                    return;
                }
                _connectTask = null;
                _pendingBuffer.Clear();
                if (_socket != null)
                {
                    try
                    {
                        _socket.Close();
                    }
                    catch
                    {
                        // 忽略关闭失败
                    }
                    _socket = null;
                }
                _gen++;
            }
            SetStatus(TransportStatus.Disconnected);
            Log.Info("Game server connection closed (close-game-conn signal)");
            Disconnected?.Invoke();
        }

        /// <summary>
        /// 功能描述：连接到本机游戏服务器
        ///
        /// 逻辑说明：创建 TCP 客户端连接到 127.0.0.1:port。连接建立后设置 NoDelay
        ///           并桥接数据。断开后不自动重连，等待惰性重连按需触发。
        ///
        /// @param port - 游戏服务器端口
        /// @param host - 游戏服务器地址（默认 127.0.0.1）
        /// @returns 连接成功时完成
        /// @throws 连接失败或超时时抛出
        /// </summary>
        public Task ConnectAsync(int port, string host = "127.0.0.1")
        {
            lock (_lock)
            {
                if (_socket != null)
                {
                    return Task.CompletedTask;
                }
                _port = port;
                _host = host;
            }
            return DoConnect();
        }

        /// <summary>
        /// 功能描述：断开与游戏服务器的连接
        ///
        /// 逻辑说明：标记 _disconnecting 防止惰性重连被触发，清理 socket 和缓冲区。
        /// </summary>
        public Task DisconnectAsync()
        {
            lock (_lock)
            {
                _disconnecting = true;
                _connectTask = null;
                _pendingBuffer.Clear();
                if (_socket != null)
                {
                    try
                    {
                        _socket.Close();
                    }
                    catch
                    {
                        // 忽略关闭失败
                    }
                    _socket = null;
                }
            }
            SetStatus(TransportStatus.Disconnected);
            Log.Info("Local client disconnected");
            Disconnected?.Invoke();
            return Task.CompletedTask;
        }

        /// <summary>
        /// 功能描述：设置数据传输通道
        ///
        /// 逻辑说明：注册 transport 的 Data 事件，将远端数据写入游戏服务器 socket；
        ///           当 socket 已断开时缓冲数据并触发惰性重连。Reset 帧触发重建连接。
        ///
        /// @param transport - 传输层
        /// </summary>
        public void SetTransport(ITransport transport)
        {
            if (_transport != null)
            {
                _transport.Data -= _dataHandler;
                _transport.StatusChanged -= _statusHandler;
                _transport.Error -= _errorHandler;
                _transport.Close -= _closeHandler;
                _transport.Reset -= _resetHandler;
            }

            _transport = transport;
            SetStatus(transport.Status);

            _dataHandler = d =>
            {
                TcpClient socket;
                bool disconnecting;
                lock (_lock)
                {
                    socket = _socket;
                    disconnecting = _disconnecting;
                }
                if (socket != null && socket.Connected)
                {
                    try
                    {
                        socket.GetStream().Write(d, 0, d.Length);
                    }
                    catch (Exception ex)
                    {
                        Log.Error($"write to game socket failed: {ex.Message}");
                    }
                }
                else if (!disconnecting)
                {
                    lock (_lock)
                    {
                        _pendingBuffer.Add(d);
                    }
                    TriggerLazyConnect();
                }
            };
            _statusHandler = s => SetStatus(s);
            _errorHandler = err =>
            {
                Log.Error($"Transport error: {err.Message}");
                Error?.Invoke(err);
            };
            _closeHandler = () => Log.Info("Transport closed");
            _resetHandler = () =>
            {
                Log.Info("Received reset signal, reconnecting to game server");
                HandleReset();
            };

            _transport.Data += _dataHandler;
            _transport.StatusChanged += _statusHandler;
            _transport.Error += _errorHandler;
            _transport.Close += _closeHandler;
            _transport.Reset += _resetHandler;
        }

        /// <summary>
        /// 功能描述：执行实际的 TCP 连接
        ///
        /// 逻辑说明：创建客户端到游戏服务器，设置事件处理器。使用代际计数器防止
        ///           陈旧连接回调覆盖当前连接。连接建立后刷新缓冲区。
        ///
        /// @returns 连接成功时完成
        /// @throws 连接失败或超时时抛出
        /// </summary>
        private Task DoConnect()
        {
            int myGen;
            lock (_lock)
            {
                myGen = ++_gen;
            }

            return Task.Run(() =>
            {
                var client = new TcpClient();
                try
                {
                    var connectTask = client.ConnectAsync(_host, _port);
                    if (!connectTask.Wait(10000))
                    {
                        client.Close();
                        throw new Exception($"Connection to game server timed out {_host}:{_port}");
                    }
                    if (connectTask.IsFaulted)
                    {
                        throw connectTask.Exception?.GetBaseException() ?? new Exception("connect failed");
                    }

                    // 连接建立时检查代际 — 若已过时说明有更新的连接，销毁这个过期 socket
                    int currentGen;
                    lock (_lock)
                    {
                        currentGen = _gen;
                    }
                    if (currentGen != myGen)
                    {
                        client.Close();
                        return;
                    }

                    client.NoDelay = true;
                    lock (_lock)
                    {
                        _socket = client;
                    }
                    FlushBuffer();

                    // 后台读取游戏服务器数据 → 发送到 transport
                    var reader = new Thread(() => ServerReadLoop(client))
                    {
                        IsBackground = true,
                        Name = "local-tunnel-server-read"
                    };
                    reader.Start();

                    SetStatus(TransportStatus.Connected);
                    Log.Info($"Connected to game server {_host}:{_port}");
                    Connected?.Invoke(_port, _host);
                }
                catch
                {
                    try
                    {
                        client.Close();
                    }
                    catch
                    {
                        // 忽略
                    }
                    lock (_lock)
                    {
                        if (_socket == client)
                        {
                            _socket = null;
                        }
                    }
                    SetStatus(TransportStatus.Disconnected);
                    throw;
                }
            });
        }

        /// <summary>
        /// 功能描述：后台读取游戏服务器数据并转发给 transport
        ///
        /// @param client - 游戏服务器连接
        /// </summary>
        private void ServerReadLoop(TcpClient client)
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
                    var data = new byte[n];
                    Buffer.BlockCopy(buffer, 0, data, 0, n);
                    ITransport transport;
                    lock (_lock)
                    {
                        transport = _transport;
                    }
                    if (transport != null)
                    {
                        try
                        {
                            transport.SendAsync(data).ContinueWith(t =>
                            {
                                if (t.IsFaulted)
                                {
                                    Log.Error($"Transport send failed: {t.Exception?.GetBaseException().Message} ({n}B)");
                                }
                            });
                        }
                        catch (Exception ex)
                        {
                            Log.Error($"Transport send failed: {ex.Message} ({n}B)");
                        }
                    }
                    else
                    {
                        Log.Error($"Game server data arrived but no transport, dropping {n}B");
                    }
                }
            }
            catch
            {
                // 读取异常按断开处理
            }
            finally
            {
                lock (_lock)
                {
                    if (_socket == client)
                    {
                        _socket = null;
                    }
                }
                SetStatus(TransportStatus.Disconnected);
                Log.Info("Game server connection closed, awaiting lazy reconnect");
                Disconnected?.Invoke();
                try
                {
                    client.Close();
                }
                catch
                {
                    // 忽略
                }
            }
        }

        /// <summary>
        /// 功能描述：触发惰性重连
        ///
        /// 逻辑说明：如果当前没有正在进行的连接，发起新连接。
        ///           连接失败时重置 _connectTask 以便下次数据到达时重试。
        /// </summary>
        private void TriggerLazyConnect()
        {
            lock (_lock)
            {
                if (_connectTask != null)
                {
                    return; // 连接已在进行中，数据会继续入队
                }
                _connectTask = DoConnect();
                _connectTask.ContinueWith(t =>
                {
                    if (t.IsFaulted)
                    {
                        Log.Error($"Lazy reconnect failed: {t.Exception?.GetBaseException().Message}, will retry on next data arrival");
                    }
                    lock (_lock)
                    {
                        if (_connectTask == t)
                        {
                            _connectTask = null;
                        }
                    }
                });
            }
        }

        /// <summary>
        /// 功能描述：重置游戏服务器连接（销毁旧连接，创建新连接）
        ///
        /// 逻辑说明：由重置帧触发。销毁当前 socket，清空缓冲区，递增代际计数器使
        ///           任何陈旧连接事件失效，立即触发惰性重连。
        /// </summary>
        private void HandleReset()
        {
            lock (_lock)
            {
                if (_disconnecting)
                {
                    return;
                }
                if (_socket != null)
                {
                    try
                    {
                        _socket.Close();
                    }
                    catch
                    {
                        // 忽略
                    }
                    _socket = null;
                }
                _connectTask = null;
                _pendingBuffer.Clear();
                _gen++;
            }
            TriggerLazyConnect();
        }

        /// <summary>
        /// 功能描述：将缓冲区数据写入 socket
        ///
        /// 逻辑说明：连接建立后将暂存的数据按序写入。
        /// </summary>
        private void FlushBuffer()
        {
            List<byte[]> pending;
            TcpClient socket;
            lock (_lock)
            {
                pending = _pendingBuffer.ToList();
                _pendingBuffer.Clear();
                socket = _socket;
            }
            if (pending.Count == 0 || socket == null)
            {
                return;
            }
            try
            {
                var stream = socket.GetStream();
                foreach (var buf in pending)
                {
                    stream.Write(buf, 0, buf.Length);
                }
            }
            catch (Exception ex)
            {
                Log.Error($"flush buffer failed: {ex.Message}");
            }
        }

        /// <summary>
        /// 功能描述：设置状态并触发事件
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
