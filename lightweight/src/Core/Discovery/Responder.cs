using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SGI
{
    /// <summary>
    /// UDP 响应器：响应局域网中其他实例的发现请求
    ///
    /// 对应 src/core/discovery/responder.ts 的 C# 移植。
    /// 绑定发现端口，收到 SGI1:DISCOVER 请求后向请求方回复本机运行的游戏信息。
    /// </summary>
    internal class Responder : IDisposable
    {
        /// <summary>发现端口</summary>
        public const int DiscoveryPort = 24861;

        private const string DiscoverRequestPrefix = "SGI1:DISCOVER";

        private readonly object _lock = new object();
        private readonly int _discoveryPort;

        private Socket _socket;
        private string _state = "idle";
        private readonly Dictionary<string, GameInfo> _games = new Dictionary<string, GameInfo>();

        /// <summary>收到发现请求（参数为请求方地址）</summary>
        public event Action<string> RequestReceived;
        /// <summary>已发送响应（参数：游戏 ID、目标地址）</summary>
        public event Action<string, string> ResponseSent;
        /// <summary>发送错误</summary>
        public event Action<Exception> Error;
        /// <summary>状态变化（idle/listening/error）</summary>
        public event Action<string> StateChanged;

        /// <summary>
        /// @param discoveryPort - 发现端口号，默认 24861
        /// </summary>
        public Responder(int discoveryPort = DiscoveryPort)
        {
            _discoveryPort = discoveryPort;
        }

        /// <summary>当前响应器状态</summary>
        public string State
        {
            get { lock (_lock) { return _state; } }
        }

        /// <summary>当前注册的游戏列表</summary>
        public List<GameInfo> Games
        {
            get { lock (_lock) { return _games.Values.ToList(); } }
        }

        /// <summary>
        /// 功能描述：注册一款游戏到响应列表
        ///
        /// @param game - 游戏信息
        /// </summary>
        public void AddGame(GameInfo game)
        {
            lock (_lock)
            {
                _games[game.Id] = game;
            }
        }

        /// <summary>
        /// 功能描述：从响应列表中移除一款游戏
        ///
        /// @param gameId - 游戏 ID
        /// </summary>
        public void RemoveGame(string gameId)
        {
            lock (_lock)
            {
                _games.Remove(gameId);
            }
        }

        /// <summary>
        /// 功能描述：清空响应列表
        /// </summary>
        public void ClearGames()
        {
            lock (_lock)
            {
                _games.Clear();
            }
        }

        /// <summary>
        /// 功能描述：启动响应器
        ///
        /// 逻辑说明：绑定到发现端口开始监听，reuseAddr 允许多个实例同时监听。
        ///
        /// @returns Task，socket 就绪时完成
        /// </summary>
        public Task StartAsync()
        {
            lock (_lock)
            {
                if (_state == "listening")
                {
                    return Task.CompletedTask;
                }

                try
                {
                    var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
                    socket.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                    socket.EnableBroadcast = true;
                    socket.Bind(new IPEndPoint(IPAddress.Any, _discoveryPort));

                    _socket = socket;
                    _state = "listening";

                    var receiver = new Thread(() => ReceiveLoop(socket))
                    {
                        IsBackground = true,
                        Name = "lan-respond-receive"
                    };
                    receiver.Start();

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
        /// 功能描述：停止响应器
        ///
        /// 逻辑说明：关闭 UDP socket，清空游戏列表。
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
        /// 功能描述：后台接收线程，处理发现请求
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
                HandleRequest(data, (IPEndPoint)remote);
            }
        }

        /// <summary>
        /// 功能描述：处理收到的发现请求
        ///
        /// 逻辑说明：验证请求格式，向请求方回复本机所有已注册游戏的信息。
        ///
        /// @param msg - 请求数据包
        /// @param rinfo - 请求方信息
        /// </summary>
        private void HandleRequest(byte[] msg, IPEndPoint rinfo)
        {
            string text = Encoding.UTF8.GetString(msg).Trim();
            if (!text.StartsWith(DiscoverRequestPrefix, StringComparison.Ordinal))
            {
                return;
            }

            RequestReceived?.Invoke(rinfo.Address.ToString());

            List<GameInfo> games;
            lock (_lock)
            {
                games = _games.Values.ToList();
            }
            foreach (var game in games)
            {
                byte[] response = Encoding.UTF8.GetBytes(BuildResponse(game));
                Socket socket;
                lock (_lock)
                {
                    socket = _socket;
                }
                if (socket == null)
                {
                    return;
                }
                try
                {
                    socket.SendTo(response, new IPEndPoint(rinfo.Address, rinfo.Port));
                    ResponseSent?.Invoke(game.Id, rinfo.Address.ToString());
                }
                catch (Exception ex)
                {
                    Error?.Invoke(ex);
                }
            }
        }

        /// <summary>
        /// 功能描述：构建 UDP 响应数据包
        ///
        /// @param game - 游戏信息
        /// @returns 响应字符串
        /// </summary>
        private static string BuildResponse(GameInfo game)
        {
            return $"SGI1:DISCOVER_RESP|{game.Id}|{game.Name}|{game.Port}|{game.Protocol}\n";
        }
    }
}
