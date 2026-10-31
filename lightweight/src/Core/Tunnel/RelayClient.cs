using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace SGI
{
    /// <summary>
    /// Relay 中继客户端：WebSocket 协议实现
    ///
    /// 对应 src/core/tunnel/relay-client.ts 的 C# 移植。
    /// 通过 WebSocket 连接中继服务器，处理连接生命周期、房间管理、P2P 信令、
    /// 数据中继、心跳与重连。文本帧为 JSON 控制消息，二进制帧为中继数据。
    /// 中继服务器代码在独立仓库 simple-game-relay 中。
    /// </summary>
    internal class RelayClient
    {
        private readonly object _lock = new object();
        private readonly RelayConfig _config;

        private ClientWebSocket _ws;
        private string _state = "disconnected"; // disconnected/connecting/connected
        private string _memberId = "";
        private string _roomCode = "";
        private int _reconnectAttempts;
        private bool _reconnectTimerActive;
        private bool _connectionLostHandled;
        private bool _manualDisconnect;
        private long _trafficBytesSent;
        private long _trafficBytesReceived;
        private long _lastPongTime;
        private int _heartbeatFailures;
        private bool _isServer;
        private int _messageIdSeq;

        private readonly Dictionary<string, PendingRequest> _pendingRequests =
            new Dictionary<string, PendingRequest>();

        private CancellationTokenSource _heartbeatCts;
        private Timer _pongTimer;
        private Timer _trafficTimer;
        private CancellationTokenSource _receiveCts;
        private CancellationTokenSource _reconnectCts = new CancellationTokenSource();

        /// <summary>WebSocket 连接建立</summary>
        public event Action Connected;
        /// <summary>WebSocket 连接断开</summary>
        public event Action Disconnected;
        /// <summary>房间创建成功</summary>
        public event Action<CreateRoomResult> RoomCreated;
        /// <summary>加入房间成功</summary>
        public event Action<TunnelJoinRoomResult> RoomJoined;
        /// <summary>新成员加入</summary>
        public event Action<MemberJoinedData> MemberJoined;
        /// <summary>成员离开</summary>
        public event Action<string> MemberLeft;
        /// <summary>P2P 信令消息</summary>
        public event Action<string, JToken> Signal;
        /// <summary>中继数据</summary>
        public event Action<byte[], string> RelayData;
        /// <summary>房间被关闭</summary>
        public event Action RoomClosed;
        /// <summary>流量统计</summary>
        public event Action<TrafficSnapshot> Traffic;
        /// <summary>错误</summary>
        public event Action<Exception> Error;
        /// <summary>重置帧（重建指定加入者的游戏连接）</summary>
        public event Action<string> Reset;
        /// <summary>离开房间</summary>
        public event Action Left;

        public RelayClient(RelayConfig config = null)
        {
            var d = new RelayConfig();
            if (config != null)
            {
                d.RelayUrl = config.RelayUrl;
                d.ReconnectMaxAttempts = config.ReconnectMaxAttempts;
                d.ReconnectBaseDelay = config.ReconnectBaseDelay;
                d.HeartbeatInterval = config.HeartbeatInterval;
                d.HeartbeatTimeout = config.HeartbeatTimeout;
                d.ConnectTimeout = config.ConnectTimeout;
            }
            _config = d;
        }

        /// <summary>
        /// 功能描述：更新中继服务器地址（下次 connect 时生效）
        ///
        /// @param url - WebSocket 中继服务器地址
        /// </summary>
        public void SetRelayUrl(string url)
        {
            _config.RelayUrl = url;
        }

        /// <summary>设为服务端模式（改变二进制帧解析方式）</summary>
        public void SetServerMode()
        {
            _isServer = true;
        }

        /// <summary>当前连接状态（含 reconnecting）</summary>
        public string State
        {
            get
            {
                lock (_lock)
                {
                    if (_reconnectTimerActive) return "reconnecting";
                    if (_state == "connected") return "connected";
                    if (_state == "connecting") return "connecting";
                    return "disconnected";
                }
            }
        }

        /// <summary>本机成员 ID</summary>
        public string MemberId
        {
            get { lock (_lock) { return _memberId; } }
        }

        /// <summary>当前房间码</summary>
        public string RoomCode
        {
            get { lock (_lock) { return _roomCode; } }
        }

        /// <summary>是否为服务端模式</summary>
        public bool IsServerMode
        {
            get { return _isServer; }
        }

        // ─── 连接管理 ───────────────────────────────────────

        /// <summary>
        /// 功能描述：连接到中继服务器
        ///
        /// 逻辑说明：创建 ClientWebSocket 连接配置的 relayUrl，带连接超时。
        ///           连接成功后启动心跳、超时检测与流量监控及接收循环。
        ///
        /// @throws 连接超时或失败
        /// </summary>
        public async Task ConnectAsync()
        {
            lock (_lock)
            {
                if (_state == "connected" && _ws != null && _ws.State == WebSocketState.Open)
                {
                    return;
                }
            }

            CancelReconnect();
            lock (_lock) _state = "connecting";
            CleanupWebSocket();

            var ws = new ClientWebSocket();
            var connectTask = ws.ConnectAsync(new Uri(_config.RelayUrl), CancellationToken.None);
            var done = await Task.WhenAny(connectTask, Task.Delay(_config.ConnectTimeout)).ConfigureAwait(false);
            if (done != connectTask)
            {
                try { ws.Dispose(); } catch { }
                throw new TimeoutException("Relay connection timed out");
            }
            await connectTask.ConfigureAwait(false);

            lock (_lock)
            {
                _ws = ws;
                _state = "connected";
                _reconnectAttempts = 0;
                _lastPongTime = NowMs();
                _heartbeatFailures = 0;
                _connectionLostHandled = false;
                _manualDisconnect = false;
            }

            StartHeartbeat();
            StartPongCheck();
            StartTrafficMonitor();

            _receiveCts = new CancellationTokenSource();
            var token = _receiveCts.Token;
            Task.Run(() => ReceiveLoop(ws, token));
            _receiveCts.Token.Register(() => HandleConnectionLost());

            Connected?.Invoke();
        }

        /// <summary>
        /// 功能描述：断开中继服务器连接
        ///
        /// 逻辑说明：取消重连，停止所有定时器，拒绝全部待响应请求，清理 WebSocket。
        /// </summary>
        public Task DisconnectAsync()
        {
            CancelReconnect();
            StopHeartbeat();
            StopPongCheck();
            StopTrafficMonitor();
            RejectAllPending(new Exception("Connection closed"));

            lock (_lock) _manualDisconnect = true;
            CleanupWebSocket();
            CancelReconnect();

            lock (_lock)
            {
                _state = "disconnected";
                _memberId = "";
                _roomCode = "";
                _isServer = false;
                _reconnectAttempts = 0;
                _trafficBytesSent = 0;
                _trafficBytesReceived = 0;
            }
            Disconnected?.Invoke();
            return Task.CompletedTask;
        }

        // ─── 房间管理 ───────────────────────────────────────

        /// <summary>
        /// 功能描述：创建房间（房主调用）
        ///
        /// @param p - 创建房间参数
        /// @returns 房间码和成员 ID
        /// @throws 中继服务器返回错误或连接未就绪
        /// </summary>
        public async Task<CreateRoomResult> CreateRoomAsync(CreateRoomParams p)
        {
            AssertConnected();
            var data = new JObject
            {
                ["gameId"] = p.GameId,
                ["gameName"] = p.GameName,
                ["gamePort"] = p.GamePort,
                ["memberName"] = p.MemberName,
                ["networkInfo"] = JToken.FromObject(p.NetworkInfo)
            };
            var result = await SendRequestAsync(RelayMessageTypes.CreateRoom, data).ConfigureAwait(false);
            string roomCode = result["roomCode"]?.Value<string>();
            string memberId = result["memberId"]?.Value<string>();
            lock (_lock)
            {
                _memberId = memberId;
                _roomCode = roomCode;
            }
            RoomCreated?.Invoke(new CreateRoomResult { RoomCode = roomCode, MemberId = memberId });
            return new CreateRoomResult { RoomCode = roomCode, MemberId = memberId };
        }

        /// <summary>
        /// 功能描述：加入房间（加入者调用）
        ///
        /// 逻辑说明：发送 join-room 消息，响应中附带房主网络信息；
        ///           中继返回 hostId/hostNetworkInfo（旧命名）时映射为 serverId/serverNetworkInfo。
        ///
        /// @param roomCode - 6 位房间码
        /// @param p - 加入房间参数
        /// @returns 加入房间结果
        /// @throws 房间不存在/已满/连接未就绪
        /// </summary>
        public async Task<TunnelJoinRoomResult> JoinRoomAsync(string roomCode, JoinRoomParams p)
        {
            AssertConnected();
            var data = new JObject
            {
                ["roomCode"] = roomCode,
                ["memberName"] = p.MemberName,
                ["networkInfo"] = JToken.FromObject(p.NetworkInfo)
            };
            var result = await SendRequestAsync(RelayMessageTypes.JoinRoom, data).ConfigureAwait(false);
            string memberId = result["memberId"]?.Value<string>();
            lock (_lock)
            {
                _memberId = memberId;
                _roomCode = roomCode;
            }
            string serverId = result["serverId"]?.Value<string>() ?? result["hostId"]?.Value<string>();
            var serverNetworkInfo = (result["serverNetworkInfo"] ?? result["hostNetworkInfo"])?.ToObject<NetworkInfo>();
            var members = new List<MemberInfo>();
            if (result["members"] is JArray arr)
            {
                foreach (var m in arr)
                {
                    members.Add(new MemberInfo
                    {
                        Id = m["id"]?.Value<string>(),
                        Name = m["name"]?.Value<string>()
                    });
                }
            }
            var res = new TunnelJoinRoomResult
            {
                RoomCode = result["roomCode"]?.Value<string>() ?? roomCode,
                MemberId = memberId,
                ServerId = serverId,
                ServerNetworkInfo = serverNetworkInfo,
                GamePort = result["gamePort"]?.Value<int>() ?? 0,
                Members = members
            };
            RoomJoined?.Invoke(res);
            return res;
        }

        /// <summary>
        /// 功能描述：离开房间
        ///
        /// 逻辑说明：发送 leave-room 消息，重置本地房间状态。
        /// </summary>
        public Task LeaveRoomAsync()
        {
            string roomCode;
            lock (_lock) roomCode = _roomCode;
            if (string.IsNullOrEmpty(roomCode))
            {
                return Task.CompletedTask;
            }
            try
            {
                SendMessage(RelayMessageTypes.LeaveRoom, new JObject { ["roomCode"] = roomCode });
            }
            catch
            {
                // 发送失败不影响本地清理
            }
            lock (_lock)
            {
                _memberId = "";
                _roomCode = "";
            }
            Left?.Invoke();
            return Task.CompletedTask;
        }

        /// <summary>
        /// 功能描述：发送 P2P 信令消息
        ///
        /// @param to - 目标成员 ID
        /// @param signalData - 信令数据
        /// </summary>
        public void SendSignal(string to, JToken signalData)
        {
            AssertConnected();
            SendMessage(RelayMessageTypes.Signal, new JObject { ["to"] = to, ["signalData"] = signalData });
        }

        /// <summary>
        /// 功能描述：发送中继数据（二进制）
        ///
        /// 逻辑说明：房主端发送需指定目标成员 ID：[4B targetIdLen][targetId][4B payloadLen][payload]；
        ///           加入者端直接发送：[4B payloadLen][payload]。
        ///
        /// @param data - 要中继的二进制数据
        /// @param targetMemberId - 目标成员 ID（房主端必填，加入者端忽略）
        /// </summary>
        public void SendData(byte[] data, string targetMemberId = null)
        {
            ClientWebSocket ws;
            lock (_lock) ws = _ws;
            if (ws == null || ws.State != WebSocketState.Open)
            {
                return;
            }

            byte[] frame;
            if (!string.IsNullOrEmpty(targetMemberId))
            {
                byte[] idBuf = Encoding.UTF8.GetBytes(targetMemberId);
                frame = new byte[4 + idBuf.Length + 4 + data.Length];
                WriteUInt32BE(frame, 0, idBuf.Length);
                Buffer.BlockCopy(idBuf, 0, frame, 4, idBuf.Length);
                WriteUInt32BE(frame, 4 + idBuf.Length, data.Length);
                Buffer.BlockCopy(data, 0, frame, 8 + idBuf.Length, data.Length);
            }
            else
            {
                frame = new byte[4 + data.Length];
                WriteUInt32BE(frame, 0, data.Length);
                Buffer.BlockCopy(data, 0, frame, 4, data.Length);
            }

            try
            {
                ws.SendAsync(new ArraySegment<byte>(frame), WebSocketMessageType.Binary, true, CancellationToken.None)
                    .GetAwaiter().GetResult();
                lock (_lock) _trafficBytesSent += data.Length;
            }
            catch
            {
                // 发送失败忽略，连接断开由接收循环处理
            }
        }

        // ─── 私有方法 ───────────────────────────────────────

        /// <summary>
        /// 功能描述：发送 JSON 文本消息（无需响应）
        ///
        /// @param type - 消息类型
        /// @param data - 消息数据
        /// @throws 连接未就绪时抛出
        /// </summary>
        private void SendMessage(string type, JToken data)
        {
            ClientWebSocket ws;
            lock (_lock) ws = _ws;
            if (ws == null || ws.State != WebSocketState.Open)
            {
                throw new Exception("Relay not connected");
            }
            var msg = new JObject { ["type"] = type };
            if (data != null)
            {
                msg["data"] = data;
            }
            SendRaw(ws, msg.ToString(Formatting.None));
        }

        /// <summary>
        /// 功能描述：发送请求并等待响应
        ///
        /// 逻辑说明：为消息分配唯一 ID 注册待响应表，等待匹配的响应 resolve；
        ///           30 秒超时自动 reject。
        ///
        /// @param type - 请求消息类型
        /// @param data - 请求数据
        /// @returns 响应数据
        /// </summary>
        private Task<JToken> SendRequestAsync(string type, JToken data)
        {
            ClientWebSocket ws;
            lock (_lock)
            {
                ws = _ws;
                if (ws == null || ws.State != WebSocketState.Open)
                {
                    throw new Exception("Relay not connected, please call connect() first");
                }
            }

            var tcs = new TaskCompletionSource<JToken>(TaskCreationOptions.RunContinuationsAsynchronously);
            string messageId;
            lock (_lock)
            {
                messageId = $"req_{++_messageIdSeq}_{NowMs()}";
            }

            var timer = new Timer(_ =>
            {
                lock (_lock) _pendingRequests.Remove(messageId);
                tcs.TrySetException(new TimeoutException($"Request timed out: {type}"));
            }, null, 30000, Timeout.Infinite);

            lock (_lock)
            {
                _pendingRequests[messageId] = new PendingRequest { Tcs = tcs, Timer = timer };
            }

            var msg = new JObject { ["type"] = type, ["messageId"] = messageId };
            if (data != null)
            {
                msg["data"] = data;
            }
            try
            {
                SendRaw(ws, msg.ToString(Formatting.None));
            }
            catch (Exception ex)
            {
                lock (_lock) _pendingRequests.Remove(messageId);
                timer.Dispose();
                tcs.TrySetException(new Exception($"Send failed: {ex.Message}"));
            }
            return tcs.Task;
        }

        /// <summary>
        /// 功能描述：通过 WebSocket 发送文本
        ///
        /// @param ws - WebSocket 连接
        /// @param text - 文本消息
        /// </summary>
        private static void SendRaw(ClientWebSocket ws, string text)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None)
                .GetAwaiter().GetResult();
        }

        /// <summary>
        /// 功能描述：后台接收循环
        ///
        /// 逻辑说明：分帧读取文本（JSON 控制）与二进制（中继数据）消息；
        ///           支持单条消息跨越多个 Receive 分片。
        ///
        /// @param ws - WebSocket 连接
        /// @param token - 取消令牌（断开时中止）
        /// </summary>
        private async Task ReceiveLoop(ClientWebSocket ws, CancellationToken token)
        {
            var buffer = new byte[16384];
            try
            {
                while (ws.State == WebSocketState.Open)
                {
                    using (var stream = new System.IO.MemoryStream())
                    {
                        WebSocketReceiveResult result;
                        do
                        {
                            result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), token).ConfigureAwait(false);
                            if (result.MessageType == WebSocketMessageType.Close)
                            {
                                HandleConnectionLost();
                                return;
                            }
                            stream.Write(buffer, 0, result.Count);
                        } while (!result.EndOfMessage);

                        byte[] data = stream.ToArray();
                        if (result.MessageType == WebSocketMessageType.Text)
                        {
                            HandleTextMessage(Encoding.UTF8.GetString(data));
                        }
                        else
                        {
                            HandleBinaryData(data);
                        }
                    }
                }
                HandleConnectionLost();
            }
            catch (OperationCanceledException)
            {
                // 主动断开
            }
            catch
            {
                HandleConnectionLost();
            }
        }

        /// <summary>
        /// 功能描述：处理 JSON 文本消息
        ///
        /// @param text - JSON 字符串
        /// </summary>
        private void HandleTextMessage(string text)
        {
            // 任何来自服务器的消息都视为连接存活证明
            lock (_lock) _lastPongTime = NowMs();

            JObject msg;
            try
            {
                msg = JObject.Parse(text);
            }
            catch
            {
                Log.Error($"Received invalid JSON message: {text}");
                return;
            }

            // 检查是否是对请求的响应
            string messageId = msg["messageId"]?.Value<string>();
            if (messageId != null)
            {
                PendingRequest pending;
                lock (_lock) _pendingRequests.TryGetValue(messageId, out pending);
                if (pending != null)
                {
                    try { pending.Timer.Dispose(); } catch { }
                    lock (_lock) _pendingRequests.Remove(messageId);
                    var err = msg["error"];
                    if (err != null)
                    {
                        pending.Tcs.TrySetException(new Exception($"[{err["code"]?.Value<string>()}] {err["message"]?.Value<string>()}"));
                    }
                    else
                    {
                        pending.Tcs.TrySetResult(msg["data"]);
                    }
                    return;
                }
            }

            // 服务器主动推送的消息
            switch (msg["type"]?.Value<string>())
            {
                case RelayMessageTypes.MemberJoined:
                    MemberJoined?.Invoke(msg["data"]?.ToObject<MemberJoinedData>());
                    break;
                case RelayMessageTypes.MemberLeft:
                    MemberLeft?.Invoke(msg["data"]?["memberId"]?.Value<string>());
                    break;
                case RelayMessageTypes.Signal:
                    var sd = msg["data"];
                    Signal?.Invoke(sd?["from"]?.Value<string>(), sd?["signalData"]);
                    break;
                case RelayMessageTypes.RoomClosed:
                    RoomClosed?.Invoke();
                    break;
                case RelayMessageTypes.Heartbeat:
                    lock (_lock) _lastPongTime = NowMs();
                    break;
                case RelayMessageTypes.Error:
                    Error?.Invoke(new Exception($"[{msg["error"]?["code"]?.Value<string>()}] {msg["error"]?["message"]?.Value<string>()}"));
                    break;
                default:
                    Log.Info($"Unhandled message type: {msg["type"]?.Value<string>()}");
                    break;
            }
        }

        /// <summary>
        /// 功能描述：处理二进制数据帧
        ///
        /// 逻辑说明：房主端帧格式 [4B sourceIdLen][sourceId][4B payloadLen][payload]，
        ///           加入者端帧格式 [4B payloadLen][payload]；payloadLen=0 为重置帧。
        ///
        /// @param raw - 原始二进制数据
        /// </summary>
        private void HandleBinaryData(byte[] raw)
        {
            string sourceMemberId = null;
            byte[] payload;

            if (_isServer)
            {
                if (raw.Length < 8)
                {
                    Log.Error($"Received undersized binary frame: {raw.Length} bytes");
                    return;
                }
                int idLen = ReadUInt32BE(raw, 0);
                if (raw.Length < 4 + idLen + 4)
                {
                    Log.Error("Received incomplete binary frame");
                    return;
                }
                sourceMemberId = Encoding.UTF8.GetString(raw, 4, idLen);
                int innerStart = 4 + idLen;
                int payloadLen = ReadUInt32BE(raw, innerStart);

                if (payloadLen == 0)
                {
                    // 重置帧 — 通知重建该加入者的游戏连接
                    Reset?.Invoke(sourceMemberId);
                    return;
                }

                payload = new byte[payloadLen];
                Buffer.BlockCopy(raw, innerStart + 4, payload, 0, payloadLen);
            }
            else
            {
                // 加入者端：中继服务器转发时已去掉前缀，直接为原始 payload
                payload = raw;
            }

            lock (_lock) _trafficBytesReceived += payload.Length;
            RelayData?.Invoke(payload, sourceMemberId);
        }

        // ─── 心跳（指数退避） ───────────────────────────────

        /// <summary>
        /// 功能描述：启动心跳系统（指数退避发送 + 独立超时检测）
        ///
        /// 逻辑说明：发送成功即视为存活（更新 _lastPongTime 阻止误判）；
        ///           发送失败时指数退避（1s→2s→4s…上限为 heartbeatInterval），
        ///           成功时重置为正常间隔。
        /// </summary>
        private void StartHeartbeat()
        {
            StopHeartbeat();
            lock (_lock)
            {
                _lastPongTime = NowMs();
                _heartbeatFailures = 0;
            }
            _heartbeatCts = new CancellationTokenSource();
            var token = _heartbeatCts.Token;
            Task.Run(async () =>
            {
                try
                {
                    while (!token.IsCancellationRequested)
                    {
                        int delay = _config.HeartbeatInterval;
                        try
                        {
                            var data = new JObject();
                            string roomCode;
                            lock (_lock) roomCode = _roomCode;
                            if (!string.IsNullOrEmpty(roomCode))
                            {
                                data["roomCode"] = roomCode;
                            }
                            SendMessage(RelayMessageTypes.Heartbeat, data);
                            lock (_lock)
                            {
                                _heartbeatFailures = 0;
                                _lastPongTime = NowMs();
                            }
                        }
                        catch
                        {
                            lock (_lock) _heartbeatFailures++;
                            delay = Math.Min(
                                _config.ReconnectBaseDelay * (1 << (_heartbeatFailures - 1)),
                                _config.HeartbeatInterval);
                        }
                        try
                        {
                            await Task.Delay(delay, token).ConfigureAwait(false);
                        }
                        catch
                        {
                            break;
                        }
                    }
                }
                catch
                {
                    // 心跳线程退出
                }
            });
        }

        /// <summary>
        /// 功能描述：停止心跳发送定时器
        /// </summary>
        private void StopHeartbeat()
        {
            if (_heartbeatCts != null)
            {
                _heartbeatCts.Cancel();
                _heartbeatCts = null;
            }
        }

        // ─── 心跳超时检测 ────────────────────────────────────

        /// <summary>
        /// 功能描述：启动 Pong 超时检测
        ///
        /// 逻辑说明：每秒检查 _lastPongTime 与 _heartbeatFailures。
        ///           仅当距上次心跳成功/收到消息超过 heartbeatTimeout 且连续
        ///           心跳发送失败 >= 3 次时触发重连（双条件防误判）。
        /// </summary>
        private void StartPongCheck()
        {
            StopPongCheck();
            _pongTimer = new Timer(_ =>
            {
                bool timeout;
                lock (_lock)
                {
                    timeout = (NowMs() - _lastPongTime) > _config.HeartbeatTimeout &&
                              _heartbeatFailures >= 3;
                }
                if (timeout)
                {
                    Log.Error("Heartbeat timeout, triggering reconnect");
                    HandleConnectionLost();
                }
            }, null, 1000, 1000);
        }

        /// <summary>
        /// 功能描述：停止 Pong 超时检测
        /// </summary>
        private void StopPongCheck()
        {
            if (_pongTimer != null)
            {
                _pongTimer.Dispose();
                _pongTimer = null;
            }
        }

        // ─── 流量监控 ───────────────────────────────────────

        /// <summary>
        /// 功能描述：启动流量统计定时器（每秒发射一次快照）
        /// </summary>
        private void StartTrafficMonitor()
        {
            StopTrafficMonitor();
            _trafficTimer = new Timer(_ =>
            {
                long sent, recv;
                lock (_lock)
                {
                    sent = _trafficBytesSent;
                    recv = _trafficBytesReceived;
                }
                Traffic?.Invoke(new TrafficSnapshot
                {
                    BytesSent = sent,
                    BytesReceived = recv,
                    Timestamp = NowMs()
                });
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

        // ─── 重连与断开处理 ─────────────────────────────────

        /// <summary>
        /// 功能描述：连接丢失统一处理（幂等）
        ///
        /// 逻辑说明：主动断开或已处理时直接返回；否则置为 disconnected，
        ///           停止心跳/超时/流量，触发 disconnected 事件并尝试重连。
        /// </summary>
        private void HandleConnectionLost()
        {
            lock (_lock)
            {
                if (_manualDisconnect || _connectionLostHandled)
                {
                    return;
                }
                _connectionLostHandled = true;
                _state = "disconnected";
            }
            StopHeartbeat();
            StopPongCheck();
            StopTrafficMonitor();
            Disconnected?.Invoke();
            AttemptReconnect();
        }

        /// <summary>
        /// 功能描述：尝试重连（指数退避）
        ///
        /// 逻辑说明：已在房间中时跳过自动重连（由上层清理房间）；
        ///           超过最大重试次数停止并发射错误；延迟 baseDelay * 2^attempt 上限 30 秒。
        /// </summary>
        private void AttemptReconnect()
        {
            lock (_lock)
            {
                if (!string.IsNullOrEmpty(_roomCode))
                {
                    Log.Error("Already in a room, skipping auto-reconnect (need to create/join a new room)");
                    Error?.Invoke(new Exception("Relay connection lost, room is no longer valid"));
                    return;
                }
                if (_reconnectAttempts >= _config.ReconnectMaxAttempts)
                {
                    Log.Error($"Relay reconnect attempts reached limit: {_reconnectAttempts}");
                    Error?.Invoke(new Exception($"Relay reconnect failed ({_reconnectAttempts} attempts made)"));
                    return;
                }

                int delay = Math.Min(_config.ReconnectBaseDelay * (1 << _reconnectAttempts), 30000);
                _reconnectAttempts++;
                _reconnectTimerActive = true;
                Log.Info($"Relay will reconnect in {delay}ms (attempt {_reconnectAttempts})");

                var token = _reconnectCts.Token;
                Task.Run(async () =>
                {
                    try
                    {
                        await Task.Delay(delay, token).ConfigureAwait(false);
                    }
                    catch
                    {
                        return; // 已取消
                    }
                    lock (_lock) _reconnectTimerActive = false;
                    try
                    {
                        await ConnectAsync().ConfigureAwait(false);
                    }
                    catch
                    {
                        // connect 内部已处理重连
                    }
                });
            }
        }

        /// <summary>
        /// 功能描述：取消重连定时器
        /// </summary>
        private void CancelReconnect()
        {
            _reconnectCts.Cancel();
            _reconnectCts = new CancellationTokenSource();
            lock (_lock) _reconnectTimerActive = false;
        }

        // ─── 工具方法 ───────────────────────────────────────

        /// <summary>
        /// 功能描述：断言连接已就绪
        ///
        /// @throws 连接未就绪时抛出
        /// </summary>
        private void AssertConnected()
        {
            lock (_lock)
            {
                if (_ws == null || _ws.State != WebSocketState.Open)
                {
                    throw new Exception("Relay not connected, please call connect() first");
                }
            }
        }

        /// <summary>
        /// 功能描述：清理 WebSocket 资源
        /// </summary>
        private void CleanupWebSocket()
        {
            lock (_lock)
            {
                if (_ws != null)
                {
                    try
                    {
                        if (_ws.State == WebSocketState.Open || _ws.State == WebSocketState.Connecting)
                        {
                            _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "close", CancellationToken.None)
                                .GetAwaiter().GetResult();
                        }
                    }
                    catch
                    {
                        // 忽略关闭时的错误
                    }
                    try
                    {
                        _ws.Dispose();
                    }
                    catch
                    {
                        // 忽略
                    }
                    _ws = null;
                }
            }
            try
            {
                _receiveCts?.Cancel();
            }
            catch
            {
                // 忽略
            }
        }

        /// <summary>
        /// 功能描述：拒绝所有待响应请求
        ///
        /// @param err - 拒绝原因
        /// </summary>
        private void RejectAllPending(Exception err)
        {
            List<PendingRequest> pending;
            lock (_lock)
            {
                pending = _pendingRequests.Values.ToList();
                _pendingRequests.Clear();
            }
            foreach (var p in pending)
            {
                try { p.Timer.Dispose(); } catch { }
                p.Tcs.TrySetException(err);
            }
        }

        private static void WriteUInt32BE(byte[] b, int offset, int value)
        {
            b[offset] = (byte)((value >> 24) & 0xff);
            b[offset + 1] = (byte)((value >> 16) & 0xff);
            b[offset + 2] = (byte)((value >> 8) & 0xff);
            b[offset + 3] = (byte)(value & 0xff);
        }

        private static int ReadUInt32BE(byte[] b, int offset)
        {
            return (b[offset] << 24) | (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3];
        }

        private static long NowMs()
        {
            return DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond;
        }

        private class PendingRequest
        {
            public TaskCompletionSource<JToken> Tcs;
            public Timer Timer;
        }
    }
}
