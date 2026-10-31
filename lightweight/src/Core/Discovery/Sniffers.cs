using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading.Tasks;

namespace SGI
{
    /// <summary>
    /// 协议嗅探器接口与注册表
    ///
    /// 对应 src/core/discovery/protocols/ 的 C# 移植。
    /// 嗅探器通过 TCP 连接检测游戏服务器是否运行，并按游戏 ID 注册查找。
    /// </summary>

    /// <summary>嗅探器接口</summary>
    internal interface ISniffer
    {
        /// <summary>对应的游戏 ID</summary>
        string GameId { get; }

        /// <summary>
        /// 功能描述：嗅探指定主机和端口是否运行对应的游戏服务器
        ///
        /// @param host - 目标主机 IP
        /// @param port - 目标端口
        /// @param timeoutMs - 超时时间（毫秒）
        /// @returns 嗅探结果
        /// </summary>
        Task<SniffResult> SniffAsync(string host, int port, int timeoutMs = 3000);

        /// <summary>
        /// 功能描述：将 SniffResult 转换为 GameInfo
        ///
        /// @param result - 嗅探结果
        /// @returns 游戏信息
        /// </summary>
        GameInfo ToGameInfo(SniffResult result);
    }

    /// <summary>协议嗅探器注册表</summary>
    internal static class SnifferRegistry
    {
        private static readonly Dictionary<string, ISniffer> Sniffers = new Dictionary<string, ISniffer>();

        static SnifferRegistry()
        {
            Register(new MinecraftSniffer());
            Register(new TerrariaSniffer());
            Register(new StardewValleySniffer());
            Register(new GenericSniffer());
        }

        /// <summary>
        /// 功能描述：获取指定游戏 ID 的嗅探器
        ///
        /// @param gameId - 游戏 ID
        /// @returns 嗅探器实例，未找到返回 null
        /// </summary>
        public static ISniffer Get(string gameId)
        {
            if (gameId != null && Sniffers.TryGetValue(gameId, out var sniffer))
            {
                return sniffer;
            }
            return null;
        }

        /// <summary>
        /// 功能描述：获取所有已注册的嗅探器
        ///
        /// @returns 嗅探器列表
        /// </summary>
        public static List<ISniffer> GetAll()
        {
            return new List<ISniffer>(Sniffers.Values);
        }

        /// <summary>
        /// 功能描述：注册自定义嗅探器
        ///
        /// @param sniffer - 嗅探器实例
        /// </summary>
        public static void Register(ISniffer sniffer)
        {
            Sniffers[sniffer.GameId] = sniffer;
        }

        /// <summary>
        /// 功能描述：获取当前 UTC 毫秒时间戳（供各嗅探器测量延迟）
        ///
        /// @returns 自 Unix 纪元起的毫秒数
        /// </summary>
        public static long NowMs()
        {
            return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }
    }

    /// <summary>Minecraft Java Edition 服务器嗅探器</summary>
    internal class MinecraftSniffer : ISniffer
    {
        public string GameId => "minecraft-java";

        public async Task<SniffResult> SniffAsync(string host, int port, int timeoutMs = 3000)
        {
            long start = SnifferRegistry.NowMs();
            try
            {
                var data = await TcpUtil.TryConnectReadAsync(host, port, timeoutMs, readData: true).ConfigureAwait(false);
                long latency = SnifferRegistry.NowMs() - start;
                var result = new SniffResult
                {
                    Detected = true,
                    GameId = GameId,
                    Host = host,
                    Port = port,
                    LatencyMs = latency
                };
                if (data != null && data.Length > 0)
                {
                    int take = Math.Min(data.Length, 128);
                    string serverData = Encoding.UTF8.GetString(data, 0, take);
                    result.Extra = new Dictionary<string, string>
                    {
                        ["serverData"] = StripControlChars(serverData)
                    };
                }
                return result;
            }
            catch
            {
                return new SniffResult { Detected = false, GameId = GameId, Host = host, Port = port };
            }
        }

        public GameInfo ToGameInfo(SniffResult result)
        {
            return new GameInfo
            {
                Id = GameId,
                Name = "Minecraft: Java Edition",
                Port = result.Port,
                Protocol = "tcp",
                Host = result.Host,
                Status = result.Detected ? "online" : "offline"
            };
        }

        /// <summary>
        /// 功能描述：剔除字符串中的控制字符（\x00-\x1f）
        ///
        /// @param s - 原始字符串
        /// @returns 过滤控制字符后的字符串
        /// </summary>
        private static string StripControlChars(string s)
        {
            var sb = new StringBuilder(s.Length);
            foreach (char c in s)
            {
                if (c < 0x20)
                {
                    continue;
                }
                sb.Append(c);
            }
            return sb.ToString();
        }
    }

    /// <summary>Terraria 服务器嗅探器</summary>
    internal class TerrariaSniffer : ISniffer
    {
        public string GameId => "terraria";

        public async Task<SniffResult> SniffAsync(string host, int port, int timeoutMs = 3000)
        {
            long start = SnifferRegistry.NowMs();
            try
            {
                var data = await TcpUtil.TryConnectReadAsync(host, port, timeoutMs, readData: true).ConfigureAwait(false);
                var result = new SniffResult
                {
                    Detected = true,
                    GameId = GameId,
                    Host = host,
                    Port = port,
                    LatencyMs = SnifferRegistry.NowMs() - start
                };
                if (data != null && data.Length > 0)
                {
                    int take = Math.Min(data.Length, 64);
                    result.Extra = new Dictionary<string, string>
                    {
                        ["serverData"] = BitConverter.ToString(data, 0, take).Replace("-", "").ToLowerInvariant()
                    };
                }
                return result;
            }
            catch
            {
                return new SniffResult { Detected = false, GameId = GameId, Host = host, Port = port };
            }
        }

        public GameInfo ToGameInfo(SniffResult result)
        {
            return new GameInfo
            {
                Id = GameId,
                Name = "Terraria",
                Port = result.Port,
                Protocol = "tcp",
                Host = result.Host,
                Status = result.Detected ? "online" : "offline"
            };
        }
    }

    /// <summary>Stardew Valley 服务器嗅探器（仅检测端口开放）</summary>
    internal class StardewValleySniffer : ISniffer
    {
        public string GameId => "stardew-valley";

        public async Task<SniffResult> SniffAsync(string host, int port, int timeoutMs = 3000)
        {
            long start = SnifferRegistry.NowMs();
            try
            {
                await TcpUtil.TryConnectReadAsync(host, port, timeoutMs, readData: false).ConfigureAwait(false);
                return new SniffResult
                {
                    Detected = true,
                    GameId = GameId,
                    Host = host,
                    Port = port,
                    LatencyMs = SnifferRegistry.NowMs() - start
                };
            }
            catch
            {
                return new SniffResult { Detected = false, GameId = GameId, Host = host, Port = port };
            }
        }

        public GameInfo ToGameInfo(SniffResult result)
        {
            return new GameInfo
            {
                Id = GameId,
                Name = "Stardew Valley",
                Port = result.Port,
                Protocol = "tcp",
                Host = result.Host,
                Status = result.Detected ? "online" : "offline"
            };
        }
    }

    /// <summary>通用 TCP 端口检测嗅探器</summary>
    internal class GenericSniffer : ISniffer
    {
        public string GameId => "__generic__";

        public async Task<SniffResult> SniffAsync(string host, int port, int timeoutMs = 3000)
        {
            long start = SnifferRegistry.NowMs();
            try
            {
                await TcpUtil.TryConnectReadAsync(host, port, timeoutMs, readData: false).ConfigureAwait(false);
                return new SniffResult
                {
                    Detected = true,
                    GameId = GameId,
                    Host = host,
                    Port = port,
                    LatencyMs = SnifferRegistry.NowMs() - start
                };
            }
            catch
            {
                return new SniffResult { Detected = false, GameId = GameId, Host = host, Port = port };
            }
        }

        public GameInfo ToGameInfo(SniffResult result)
        {
            return new GameInfo
            {
                Id = GameId,
                Name = "Unknown Game",
                Port = result.Port,
                Protocol = "tcp",
                Host = result.Host,
                Status = result.Detected ? "online" : "offline"
            };
        }
    }

    /// <summary>TCP 连接嗅探工具：连接成功返回 true 及已读数据；连接失败/超时抛异常</summary>
    internal static class TcpUtil
    {
        /// <summary>
        /// 功能描述：建立 TCP 连接并可选择读取服务器主动推送的数据
        ///
        /// 逻辑说明：连接成功且 readData=true 时持续读取直到超时或对端关闭；
        ///           连接成功但 readData=false 时立即返回（对应 TS 连接即销毁场景）。
        ///           连接失败或连接超时抛异常，由调用方转为未检测到。
        ///
        /// @param host - 目标主机
        /// @param port - 目标端口
        /// @param timeoutMs - 超时（毫秒）
        /// @param readData - 是否读取服务器主动数据
        /// @returns 已读取的数据（无数据返回空数组）
        /// @throws 连接失败或连接超时
        /// </summary>
        public static async Task<byte[]> TryConnectReadAsync(
            string host, int port, int timeoutMs, bool readData)
        {
            using (var client = new TcpClient())
            {
                var connectTask = client.ConnectAsync(host, port);
                var connectDone = await Task.WhenAny(connectTask, Task.Delay(timeoutMs)).ConfigureAwait(false);
                if (connectDone != connectTask)
                {
                    throw new TimeoutException("Connection timeout");
                }
                await connectTask.ConfigureAwait(false);
                if (!client.Connected)
                {
                    throw new SocketException((int)SocketError.ConnectionRefused);
                }
                if (!readData)
                {
                    return new byte[0];
                }

                using (var stream = client.GetStream())
                using (var buffer = new MemoryStream())
                {
                    long deadline = NowMs() + timeoutMs;
                    var one = new byte[4096];
                    while (true)
                    {
                        int remaining = (int)(deadline - NowMs());
                        if (remaining <= 0)
                        {
                            break;
                        }
                        var readTask = stream.ReadAsync(one, 0, one.Length);
                        var done = await Task.WhenAny(readTask, Task.Delay(remaining)).ConfigureAwait(false);
                        if (done != readTask)
                        {
                            break; // 超时，停止读取
                        }
                        int n = await readTask.ConfigureAwait(false);
                        if (n <= 0)
                        {
                            break; // 对端关闭
                        }
                        buffer.Write(one, 0, n);
                    }
                    return buffer.ToArray();
                }
            }
        }

        private static long NowMs()
        {
            return DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond;
        }
    }
}
