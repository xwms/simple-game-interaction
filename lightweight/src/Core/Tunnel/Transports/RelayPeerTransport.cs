using System;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace SGI
{
    /// <summary>
    /// Relay 中转传输 — 通过 RelayClient 转发 TCP 数据
    ///
    /// 对应 src/core/tunnel/transports/relay-peer.ts 的 C# 移植。
    /// 当 IPv6 和 P2P 均不可用时，使用 Relay 模式作为兜底。
    /// 数据通过 RelayClient 的 WebSocket 连接中转。
    /// 实现 ITransport 接口，对 TunnelManager 透明。
    /// 实际网络 I/O 由 RelayClient 完成，本类仅做适配。
    /// 端到端延迟通过 Relay 信号通道发送 ping/pong 测量：
    /// Guest →信号→ Host →信号→ Guest，经过中继服务器转发，
    /// 路径与游戏数据一致，反映真实端到端延迟。
    /// </summary>
    internal class RelayPeerTransport : ITransport
    {
        private readonly RelayClient _relayClient;
        private readonly string _targetMemberId;
        private readonly string _serverMemberId;
        private TransportStatus _status = TransportStatus.Disconnected;
        private long _trafficBytesSent;
        private long _trafficBytesReceived;
        private Timer _trafficTimer;
        /// <summary>延迟探测定时器</summary>
        private Timer _latencyTimer;
        /// <summary>延迟探测序列号</summary>
        private int _pingSeq;

        // 订阅 RelayClient 事件的处理器（用于退订）
        private Action<byte[], string> _boundOnData;
        private Action<string> _boundOnReset;
        private Action _boundOnDisconnected;
        private Action _boundOnReconnected;
        private Action<string, JToken> _boundOnSignal;

        /// <summary>传输类型（relay）</summary>
        public string Type => "relay";

        /// <summary>当前状态</summary>
        public TransportStatus Status
        {
            get { lock (this) { return _status; } }
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

        /// <summary>
        /// 功能描述：构造 Relay 中转传输
        ///
        /// @param relayClient - Relay 客户端
        /// @param targetMemberId - 目标成员 ID（房主端填写，指定本通道对应哪个加入者）
        /// @param serverMemberId - 房主成员 ID（加入者侧填写，用于发送延迟探测 ping）
        /// </summary>
        public RelayPeerTransport(RelayClient relayClient, string targetMemberId = null, string serverMemberId = null)
        {
            _relayClient = relayClient;
            _targetMemberId = targetMemberId ?? "";
            _serverMemberId = serverMemberId ?? "";
        }

        /// <summary>
        /// 功能描述：建立 Relay 传输通道
        ///
        /// 逻辑说明：确保 RelayClient 已连接。Relay 方式的"连接"就是
        ///           中继 WebSocket 连接本身，无需额外建立通道。
        ///           注册 relay client 的 data 事件监听。
        ///           同时注册信号监听器处理端到端延迟探测：
        ///           - 房主侧（有 targetMemberId）：收到 latency-ping 时回复 latency-pong
        ///           - 加入者侧（无 targetMemberId）：定时发送 latency-ping 并计算 RTT
        ///
        /// @param peerInfo - 对端连接信息（Relay 方式忽略）
        /// </summary>
        public Task ConnectAsync(PeerConnectionInfo peerInfo)
        {
            SetStatus(TransportStatus.Connecting);

            // 确保 relay 已连接
            if (_relayClient.State == "disconnected" || _relayClient.State == "reconnecting")
            {
                try
                {
                    _relayClient.ConnectAsync().GetAwaiter().GetResult();
                }
                catch (Exception ex)
                {
                    SetStatus(TransportStatus.Error);
                    throw new Exception($"Relay transport connection failed: {ex.Message}");
                }
            }

            _boundOnData = (data, sourceMemberId) =>
            {
                // 房主端有 targetMemberId，仅接收指定成员的数据
                if (!string.IsNullOrEmpty(_targetMemberId) && sourceMemberId != _targetMemberId)
                {
                    return;
                }
                _trafficBytesReceived += data.Length;
                Data?.Invoke(data);
            };
            _relayClient.RelayData += _boundOnData;

            // 监听重置帧：从 client 侧通知 server 重建游戏连接
            _boundOnReset = sourceMemberId =>
            {
                if (!string.IsNullOrEmpty(_targetMemberId) && sourceMemberId != _targetMemberId)
                {
                    return;
                }
                Reset?.Invoke();
            };
            _relayClient.Reset += _boundOnReset;

            _boundOnDisconnected = () =>
            {
                SetStatus(TransportStatus.Disconnected);
                Close?.Invoke();
            };
            _relayClient.Disconnected += _boundOnDisconnected;

            // 中继重连后自动恢复传输状态
            _boundOnReconnected = () =>
            {
                Log.Info("Relay transport channel restored");
                SetStatus(TransportStatus.Connected);
            };
            _relayClient.Connected += _boundOnReconnected;

            // 注册信号监听器：处理端到端延迟探测
            _boundOnSignal = (from, signalData) =>
            {
                var sig = signalData as JObject;
                if (sig == null)
                {
                    return;
                }
                var type = sig.Value<string>("type");

                if (type == "latency-ping")
                {
                    // 房主侧：仅处理来自本通道对应成员的 ping
                    if (!string.IsNullOrEmpty(_targetMemberId) && from != _targetMemberId) return;
                    // 立即回复 pong（原样返回 time 字段计算 RTT）
                    _relayClient.SendSignal(from, new JObject
                    {
                        ["type"] = "latency-pong",
                        ["seq"] = sig["seq"],
                        ["time"] = sig["time"]
                    });
                }
                else if (type == "latency-pong")
                {
                    // 加入者侧：仅处理来自房主的 pong
                    if (!string.IsNullOrEmpty(_serverMemberId) && from != _serverMemberId) return;
                    var time = sig.Value<long>("time");
                    long rtt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - time;
                    if (rtt > 0)
                    {
                        Latency?.Invoke(rtt);
                    }
                }
            };
            _relayClient.Signal += _boundOnSignal;

            // 加入者侧（无 targetMemberId）：启动延迟探测
            if (string.IsNullOrEmpty(_targetMemberId))
            {
                StartLatencyMonitor();
            }

            SetStatus(TransportStatus.Connected);
            StartTrafficMonitor();
            Log.Info("Relay transport channel established");
            return Task.CompletedTask;
        }

        /// <summary>
        /// 功能描述：向订阅者发射收到数据的事件
        ///
        /// 逻辑说明：C# 事件只能在声明类内部调用，TunnelManager 需通过此方法
        ///           把切换传输时缓冲的数据送入 Data 事件流。
        ///
        /// @param data - 收到的数据
        /// </summary>
        public void EmitData(byte[] data)
        {
            Data?.Invoke(data);
        }

        /// <summary>
        /// 功能描述：断开 Relay 传输通道
        ///
        /// 逻辑说明：取消事件监听，重置流量统计。不断开 RelayClient
        ///           WebSocket 连接（TunnelManager 统一管理连接生命周期）。
        /// </summary>
        public Task DisconnectAsync()
        {
            StopTrafficMonitor();
            StopLatencyMonitor();

            if (_boundOnData != null)
            {
                _relayClient.RelayData -= _boundOnData;
                _boundOnData = null;
            }
            if (_boundOnDisconnected != null)
            {
                _relayClient.Disconnected -= _boundOnDisconnected;
                _boundOnDisconnected = null;
            }
            if (_boundOnReconnected != null)
            {
                _relayClient.Connected -= _boundOnReconnected;
                _boundOnReconnected = null;
            }
            if (_boundOnReset != null)
            {
                _relayClient.Reset -= _boundOnReset;
                _boundOnReset = null;
            }
            if (_boundOnSignal != null)
            {
                _relayClient.Signal -= _boundOnSignal;
                _boundOnSignal = null;
            }

            SetStatus(TransportStatus.Disconnected);
            Close?.Invoke();
            return Task.CompletedTask;
        }

        /// <summary>
        /// 功能描述：通过中继发送数据
        ///
        /// @param data - 二进制数据
        /// </summary>
        public Task SendAsync(byte[] data)
        {
            // 房主端发送时需指定目标成员 ID，relay 服务器据此转发到对应 Guest
            _relayClient.SendData(data, string.IsNullOrEmpty(_targetMemberId) ? null : _targetMemberId);
            _trafficBytesSent += data.Length;
            return Task.CompletedTask;
        }

        /// <summary>
        /// 功能描述：启动端到端延迟探测
        ///
        /// 逻辑说明：加入者侧每 5 秒通过 Relay 信号通道发送 latency-ping
        ///           到房主，房主收到后立即回复 latency-pong，加入者计算 RTT。
        ///           信号经过中继服务器转发，路径与游戏数据一致。
        /// </summary>
        private void StartLatencyMonitor()
        {
            StopLatencyMonitor();
            _latencyTimer = new Timer(_ =>
            {
                if (string.IsNullOrEmpty(_serverMemberId))
                {
                    return;
                }
                int seq = ++_pingSeq;
                _relayClient.SendSignal(_serverMemberId, new JObject
                {
                    ["type"] = "latency-ping",
                    ["seq"] = seq,
                    ["time"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                });
            }, null, 5000, 5000);
        }

        /// <summary>
        /// 功能描述：停止延迟探测
        /// </summary>
        private void StopLatencyMonitor()
        {
            if (_latencyTimer != null)
            {
                _latencyTimer.Dispose();
                _latencyTimer = null;
            }
            _pingSeq = 0;
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
            _status = status;
            StatusChanged?.Invoke(status);
        }
    }
}
