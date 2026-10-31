using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace SGI
{
    /// <summary>
    /// IPC 通道处理器：按通道名分发到具体实现，返回统一 {success, data|error} 结构
    ///
    /// 对应 Electron 版 ipc-handlers.js。薄封装通道（app:*/window:*/log:*）与
    /// 核心引擎通道（room:*/tunnel:*/network:*/game:*/lan:*）均已实现；
    /// update:* 四个通道待 Phase 3 Updater.cs 落地。
    /// </summary>
    internal class IpcHandlers
    {
        private readonly MainForm _mainForm;
        private readonly Dictionary<string, Func<JArray, Task<JObject>>> _handlers;

        /// <summary>LAN 扫描器单例（对应 Electron 版模块级 _scanner）</summary>
        private static Scanner _lanScanner;

        /// <summary>隧道管理器单例（对应 Electron 版模块级 _tunnelManager，懒创建 + 事件接线）</summary>
        private TunnelManager _tunnelManager;

        public IpcHandlers(MainForm mainForm)
        {
            _mainForm = mainForm;
            _handlers = BuildHandlers();
        }

        /// <summary>
        /// 功能描述：分发 invoke 请求到对应通道处理器
        ///
        /// @param channel - IPC 通道名
        /// @param args - 调用参数数组
        /// @returns 统一的 IpcResult 结构（{success, data|error}）
        /// </summary>
        public async Task<JObject> DispatchAsync(string channel, JArray args)
        {
            if (channel != null && _handlers.TryGetValue(channel, out var handler))
            {
                return await handler(args).ConfigureAwait(false);
            }
            return Error($"未知 IPC 通道: {channel}");
        }

        /// <summary>
        /// 功能描述：注册所有通道处理器
        /// </summary>
        private Dictionary<string, Func<JArray, Task<JObject>>> BuildHandlers()
        {
            return new Dictionary<string, Func<JArray, Task<JObject>>>
            {
                // ─── 应用信息 ──────────────────────────────
                { "app:get-version", _ => T(Ok(Env.Version)) },
                { "app:get-platform", _ => T(Ok("win32")) },

                // ─── 文件/外部打开 ─────────────────────────
                { "app:open-log-file", _ => OpenLogFile() },
                { "app:open-log-dir", _ => OpenLogDir() },
                { "app:open-external", args => OpenExternal(args) },

                // ─── 设置类（无 Electron UI，薄封装）────────
                { "app:select-log-directory", _ => T(Ok(_mainForm.SelectLogDirectory())) },
                { "app:set-log-file-path", _ => T(Ok()) },
                { "app:set-close-behavior", _ => T(Ok()) },
                { "app:theme-changed", _ => T(Ok()) },

                // 无托盘：广播断开确认事件（与 Electron 全窗口广播行为对齐）
                { "app:confirm-disconnect", _ =>
                    {
                        EventBus.Push("app:confirm-disconnect");
                        return T(Ok());
                    }
                },

                // ─── 更新 ──────────────────────────────────
                { "update:check", args => UpdateCheck(args) },
                { "update:download", args => DownloadBlocking(args) },
                { "update:start-download", args => StartDownload(args) },
                { "update:install", args => InstallUpdate(args) },

                // ─── 窗口控制 ──────────────────────────────
                { "window:minimize", _ =>
                    {
                        _mainForm.MinimizeWindow();
                        return T(Ok());
                    }
                },
                { "window:close", _ =>
                    {
                        _mainForm.CloseWindow();
                        return T(Ok());
                    }
                },

                // ─── 日志 ──────────────────────────────────
                { "log:cleanup", args => CleanupLogs(args) },
                { "log:delete-all", _ => DeleteAllLogs() },
                { "log:info", args =>
                    {
                        string message = GetArgString(args, 0) ?? string.Empty;
                        Log.Info($"[Renderer] {message}");
                        return T(Ok());
                    }
                },
                { "log:error", args =>
                    {
                        string message = GetArgString(args, 0) ?? string.Empty;
                        Log.Error($"[Renderer] {message}");
                        return T(Ok());
                    }
                },

                // ─── 房间 ──────────────────────────────────
                { "room:create", args => CreateRoom(args) },
                { "room:join", args => JoinRoom(args) },
                { "room:leave", _ => LeaveRoom() },
                { "room:info", _ => GetRoomInfo() },

                // ─── 隧道 ──────────────────────────────────
                { "tunnel:status", _ => GetTunnelStatus() },
                { "tunnel:start", _ => StartTunnel() },
                { "tunnel:stop", _ => StopTunnel() },

                // ─── 核心引擎通道 ───────────────────────────
                { "network:detect", _ => DetectNetwork() },
                { "game:detect-local", _ => DetectLocalGames() },
                { "game:check-port", args => CheckPort(args) },
                { "lan:start-scan", _ => StartLanScan() },
                { "lan:stop-scan", _ => StopLanScan() }
            };
        }

        // ─── 通道实现 ───────────────────────────────────────

        // ─── 更新通道实现 ─────────────────────────────────

        /// <summary>
        /// 功能描述：检查更新（Gitee 优先，GitHub 降级）
        ///
        /// @param args - 参数[0] 为 {currentVersion}
        /// @returns IpcResult，data 为 UpdateInfo，无更新/失败时 data 为 null
        /// </summary>
        private static async Task<JObject> UpdateCheck(JArray args)
        {
            try
            {
                var arg = args.Count > 0 ? args[0] as JObject : null;
                string currentVersion = arg?.Value<string>("currentVersion");
                var result = await Updater.CheckForUpdatesAsync(currentVersion).ConfigureAwait(false);
                return Ok(result);
            }
            catch (Exception ex)
            {
                Log.Error($"update:check 失败: {ex.Message}");
                return Error(ex.Message);
            }
        }

        /// <summary>
        /// 功能描述：阻塞式下载更新（返回完成后的文件路径）
        ///
        /// @param args - 参数[0] 为下载 URL
        /// @returns IpcResult，data 为 {filePath}
        /// </summary>
        private static async Task<JObject> DownloadBlocking(JArray args)
        {
            try
            {
                string url = GetArgString(args, 0);
                if (string.IsNullOrEmpty(url))
                {
                    return Error("缺少下载地址");
                }
                string filePath = await Updater.DownloadUpdateAsync(url, null).ConfigureAwait(false);
                return Ok(new { filePath });
            }
            catch (Exception ex)
            {
                return Error(ex.Message);
            }
        }

        /// <summary>
        /// 功能描述：后台下载更新（fire-and-forget）
        ///
        /// 逻辑说明：立即返回 success，下载在后台异步进行；
        ///           进度/完成/错误通过 EventBus 推送（对应 Electron 版 update:start-download）。
        ///
        /// @param args - 参数[0] 为 URL，参数[1] 为版本号
        /// @returns IpcResult，data 为 null
        /// </summary>
        private static Task<JObject> StartDownload(JArray args)
        {
            string url = GetArgString(args, 0);
            string version = GetArgString(args, 1) ?? string.Empty;
            if (string.IsNullOrEmpty(url))
            {
                return T(Error("缺少下载地址"));
            }
            _ = DownloadInBackground(url, version);
            return T(Ok());
        }

        /// <summary>
        /// 功能描述：后台执行下载并推送进度/完成/错误事件
        ///
        /// @param url - 下载 URL
        /// @param version - 下载版本号
        /// </summary>
        private static async Task DownloadInBackground(string url, string version)
        {
            try
            {
                string filePath = await Updater.DownloadUpdateAsync(
                    url, percent => EventBus.Push("update:download-progress", percent)).ConfigureAwait(false);
                Updater.MarkDownloadComplete(version);
                EventBus.Push("update:download-complete", new { filePath, version });
            }
            catch (Exception ex)
            {
                Log.Error($"update 下载失败: {ex.Message}");
                EventBus.Push("update:download-error", ex.Message);
            }
        }

        /// <summary>
        /// 功能描述：安装更新（覆盖当前 exe 并重启）
        ///
        /// 逻辑说明：调用 Updater.InstallUpdate 写分离启动脚本；
        ///           成功后延迟退出当前进程，让成功响应先送达渲染进程。
        ///
        /// @param args - 参数[0] 为下载完成的安装包路径
        /// @returns IpcResult，data 为 null
        /// </summary>
        private static Task<JObject> InstallUpdate(JArray args)
        {
            string filePath = GetArgString(args, 0);
            if (string.IsNullOrEmpty(filePath) || !Updater.InstallUpdate(filePath))
            {
                return T(Error("安装失败"));
            }
            _ = DelayedQuit();
            return T(Ok());
        }

        /// <summary>
        /// 功能描述：延迟 800ms 后退出当前进程（等待安装脚本接管替换）
        /// </summary>
        private static async Task DelayedQuit()
        {
            await Task.Delay(800).ConfigureAwait(false);
            try
            {
                System.Windows.Forms.Application.Exit();
            }
            catch
            {
                // 忽略
            }
            Environment.Exit(0);
        }

        /// <summary>
        /// 功能描述：打开日志文件（用 notepad）
        ///
        /// 逻辑说明：文件不存在时返回 error（对应 Electron 版 fs.existsSync 前置检查）。
        ///
        /// @returns IpcResult
        /// </summary>
        private static Task<JObject> OpenLogFile()
        {
            string logPath = Log.LogFilePath;
            if (!File.Exists(logPath))
            {
                return T(Error("日志文件不存在"));
            }
            try
            {
                Process.Start("notepad.exe", logPath);
            }
            catch (Exception ex)
            {
                return T(Error($"打开日志文件失败: {ex.Message}"));
            }
            return T(Ok());
        }

        /// <summary>
        /// 功能描述：打开日志目录（用 explorer）
        ///
        /// @returns IpcResult
        /// </summary>
        private static Task<JObject> OpenLogDir()
        {
            if (!Directory.Exists(Env.LogsDir))
            {
                return T(Error("日志目录不存在"));
            }
            try
            {
                Process.Start("explorer.exe", Env.LogsDir);
            }
            catch (Exception ex)
            {
                return T(Error($"打开日志目录失败: {ex.Message}"));
            }
            return T(Ok());
        }

        /// <summary>
        /// 功能描述：打开外部链接，仅允许 https 协议
        ///
        /// @param args - 参数[0] 为 URL 字符串
        /// @returns IpcResult
        /// </summary>
        private static Task<JObject> OpenExternal(JArray args)
        {
            string url = GetArgString(args, 0);
            if (string.IsNullOrEmpty(url) || !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                return T(Error("Only https URLs are allowed"));
            }
            try
            {
                Process.Start(url);
            }
            catch (Exception ex)
            {
                return T(Error($"打开链接失败: {ex.Message}"));
            }
            return T(Ok());
        }

        /// <summary>
        /// 功能描述：清理超过保留天数的日志文件
        ///
        /// @param args - 参数[0] 为保留天数
        /// @returns IpcResult，data 为 {deletedCount}
        /// </summary>
        private static Task<JObject> CleanupLogs(JArray args)
        {
            int days = GetArgInt(args, 0, 7);
            int deleted = Log.Cleanup(days);
            return T(Ok(new { deletedCount = deleted }));
        }

        /// <summary>
        /// 功能描述：删除全部日志文件
        ///
        /// @returns IpcResult，data 为 {deletedCount}
        /// </summary>
        private static Task<JObject> DeleteAllLogs()
        {
            int deleted = Log.DeleteAll();
            return T(Ok(new { deletedCount = deleted }));
        }

        /// <summary>
        /// 功能描述：执行网络检测（IPv6 + NAT 并行）
        ///
        /// @returns IpcResult，data 为 NetworkInfo
        /// </summary>
        private static async Task<JObject> DetectNetwork()
        {
            try
            {
                var detector = new NetworkDetector();
                var result = await detector.DetectAsync().ConfigureAwait(false);
                return Ok(result);
            }
            catch (Exception ex)
            {
                Log.Error($"network:detect 失败: {ex}");
                return Error(ex.Message);
            }
        }

        /// <summary>
        /// 功能描述：启动 LAN 广播扫描
        ///
        /// 逻辑说明：懒创建 Scanner 单例并挂接发现事件 → 推送给渲染进程，
        ///           然后启动扫描（幂等，重复调用直接返回）。
        ///
        /// @returns IpcResult，data 为 {status: 'scanning'}
        /// </summary>
        private static async Task<JObject> StartLanScan()
        {
            try
            {
                if (_lanScanner == null)
                {
                    _lanScanner = new Scanner();
                    _lanScanner.GameDiscovered += evt => EventBus.Push("lan:scan-result", evt);
                }
                await _lanScanner.StartAsync().ConfigureAwait(false);
                return Ok(new { status = "scanning" });
            }
            catch (Exception ex)
            {
                Log.Error($"lan:start-scan 失败: {ex}");
                return Error(ex.Message);
            }
        }

        /// <summary>
        /// 功能描述：停止 LAN 广播扫描
        ///
        /// @returns IpcResult，data 为 {status: 'stopped'}
        /// </summary>
        private static Task<JObject> StopLanScan()
        {
            try
            {
                _lanScanner?.Stop();
                return T(Ok(new { status = "stopped" }));
            }
            catch (Exception ex)
            {
                return T(Error(ex.Message));
            }
        }

        /// <summary>
        /// 功能描述：创建房间（房主）
        ///
        /// 逻辑说明：懒创建 TunnelManager 单例（首次调用时接线事件推送），
        ///           调用 CreateRoomAsync 走完整建房流程（网络检测→中继→启动本地服务）。
        ///
        /// @param args - 参数[0] 为 CreateRoomOptions
        /// @returns IpcResult，data 为 {roomCode, status: 'created'}
        /// </summary>
        private async Task<JObject> CreateRoom(JArray args)
        {
            try
            {
                var options = args.Count > 0 ? args[0].ToObject<CreateRoomOptions>() : null;
                if (options == null || string.IsNullOrEmpty(options.GameId))
                {
                    return Error("缺少游戏信息");
                }
                var manager = GetTunnelManager();
                var result = await manager.CreateRoomAsync(options).ConfigureAwait(false);
                return Ok(new { roomCode = result.RoomCode, status = "created" });
            }
            catch (Exception ex)
            {
                Log.Error($"room:create 失败: {ex}");
                return Error(ex.Message);
            }
        }

        /// <summary>
        /// 功能描述：加入房间（加入者）
        ///
        /// 逻辑说明：加入成功后从状态中取本地隧道端口返回给渲染进程；
        ///           失败时清理已建立的中继连接（对应 Electron 版 catch 内 leaveRoom）。
        ///
        /// @param args - 参数[0] 为 {roomCode, memberName, relayUrl, localPort}
        /// @returns IpcResult，data 为 {status: 'connected', localPort}
        /// </summary>
        private async Task<JObject> JoinRoom(JArray args)
        {
            var manager = GetTunnelManager();
            try
            {
                var arg = args.Count > 0 ? args[0] as JObject : null;
                string roomCode = arg?.Value<string>("roomCode") ?? string.Empty;
                string relayUrl = arg?.Value<string>("relayUrl");
                int localPort = arg?.Value<int?>("localPort") ?? 0;
                if (string.IsNullOrEmpty(roomCode))
                {
                    return Error("缺少房间码");
                }
                await manager.JoinRoomAsync(roomCode, relayUrl, localPort).ConfigureAwait(false);
                var status = manager.GetStatus();
                return Ok(new { status = "connected", localPort = status.LocalPort });
            }
            catch (Exception ex)
            {
                Log.Error($"room:join 失败: {ex}");
                // joinRoom 失败时清理已建立的中继连接
                try
                {
                    await manager.LeaveRoomAsync().ConfigureAwait(false);
                }
                catch
                {
                    // 清理失败忽略
                }
                return Error(ex.Message);
            }
        }

        /// <summary>
        /// 功能描述：离开房间 / 停止隧道
        ///
        /// @returns IpcResult，data 为 null
        /// </summary>
        private async Task<JObject> LeaveRoom()
        {
            try
            {
                if (_tunnelManager != null)
                {
                    await _tunnelManager.LeaveRoomAsync().ConfigureAwait(false);
                }
                return Ok();
            }
            catch (Exception ex)
            {
                return Error(ex.Message);
            }
        }

        /// <summary>
        /// 功能描述：获取房间/隧道当前状态
        ///
        /// @returns IpcResult，data 为 TunnelStatusReport，未建房时返回 null
        /// </summary>
        private Task<JObject> GetRoomInfo()
        {
            try
            {
                if (_tunnelManager == null)
                {
                    return T(Ok(null));
                }
                return T(Ok(_tunnelManager.GetStatus()));
            }
            catch (Exception ex)
            {
                return T(Error(ex.Message));
            }
        }

        /// <summary>
        /// 功能描述：获取隧道状态（与 room:info 同源）
        ///
        /// @returns IpcResult，data 为 TunnelStatusReport，未建房时返回 null
        /// </summary>
        private Task<JObject> GetTunnelStatus()
        {
            return GetRoomInfo();
        }

        /// <summary>
        /// 功能描述：启动隧道（获取本地端口与当前传输方式）
        ///
        /// 逻辑说明：对应 Electron 版直接读 getStatus() 的 localPort/transportType。
        ///
        /// @returns IpcResult，data 为 {port, transport}
        /// </summary>
        private Task<JObject> StartTunnel()
        {
            try
            {
                var manager = GetTunnelManager();
                var status = manager.GetStatus();
                string transport = string.IsNullOrEmpty(status.TransportType) ? "relay" : status.TransportType;
                return T(Ok(new { port = status.LocalPort, transport }));
            }
            catch (Exception ex)
            {
                return T(Error(ex.Message));
            }
        }

        /// <summary>
        /// 功能描述：停止隧道（调用 leaveRoom）
        ///
        /// @returns IpcResult，data 为 null
        /// </summary>
        private Task<JObject> StopTunnel()
        {
            if (_tunnelManager == null)
            {
                return T(Ok());
            }
            return LeaveRoom();
        }

        /// <summary>
        /// 功能描述：检测本机运行的所有已知游戏
        ///
        /// @returns IpcResult，data 为 GameDetectResult 列表
        /// </summary>
        private static Task<JObject> DetectLocalGames()
        {
            try
            {
                var results = LocalDetect.DetectLocalGames();
                return T(Ok(results));
            }
            catch (Exception ex)
            {
                return T(Error(ex.Message));
            }
        }

        /// <summary>
        /// 功能描述：检查本地 TCP 端口是否被监听（1000ms 超时，对应 Electron 版）
        ///
        /// @param args - 参数[0] 为端口号
        /// @returns IpcResult，data 为布尔值
        /// </summary>
        private static Task<JObject> CheckPort(JArray args)
        {
            try
            {
                int port = GetArgInt(args, 0, 0);
                bool inUse = PortChecker.CheckTcpPort(port, 1000);
                return T(Ok(inUse));
            }
            catch (Exception ex)
            {
                return T(Error(ex.Message));
            }
        }

        /// <summary>
        /// 功能描述：懒创建 TunnelManager 单例并接线事件推送（对应 Electron 版 _getTunnelManager）
        ///
        /// 逻辑说明：首次调用时创建实例，把核心引擎事件桥接到 EventBus 推送给渲染进程。
        ///
        /// @returns TunnelManager 单例
        /// </summary>
        private TunnelManager GetTunnelManager()
        {
            if (_tunnelManager == null)
            {
                _tunnelManager = new TunnelManager();
                _tunnelManager.StatusChanged += status => EventBus.Push("tunnel:status", status);
                _tunnelManager.Traffic += stats => EventBus.Push("tunnel:traffic", stats);
                _tunnelManager.Latency += rtt => EventBus.Push("tunnel:latency", rtt);
                _tunnelManager.Error += ex => EventBus.Push("tunnel:error", new { message = ex.Message });
                _tunnelManager.MemberJoined += member => EventBus.Push("room:member-joined", member);
                _tunnelManager.MemberLeft += memberId => EventBus.Push("room:member-left", new { memberId });
                _tunnelManager.Connected += data => EventBus.Push("tunnel:connected", data);
                _tunnelManager.TransportChanged += transportType => EventBus.Push("tunnel:transport-changed", transportType);
            }
            return _tunnelManager;
        }

        // ─── 工具方法 ───────────────────────────────────────

        /// <summary>
        /// 功能描述：将 JObject 包装为已完成的 Task
        ///
        /// @param obj - 结果对象
        /// @returns 已完成的 Task
        /// </summary>
        private static Task<JObject> T(JObject obj)
        {
            return Task.FromResult(obj);
        }

        /// <summary>
        /// 功能描述：构造成功响应
        ///
        /// @param data - 返回数据，null 时 data 字段为 JSON null
        /// @returns IpcResult 成功结构
        /// </summary>
        private static JObject Ok(object data = null)
        {
            var obj = new JObject { ["success"] = true };
            obj["data"] = data == null ? JValue.CreateNull() : JToken.FromObject(data);
            return obj;
        }

        /// <summary>
        /// 功能描述：构造失败响应
        ///
        /// @param message - 错误信息
        /// @returns IpcResult 失败结构
        /// </summary>
        private static JObject Error(string message)
        {
            return new JObject
            {
                ["success"] = false,
                ["error"] = message
            };
        }

        /// <summary>
        /// 功能描述：从参数数组读取第 index 个字符串参数
        ///
        /// @param args - 参数数组
        /// @param index - 索引
        /// @returns 字符串值，缺失或非字符串时返回 null
        /// </summary>
        private static string GetArgString(JArray args, int index)
        {
            return index < args.Count ? args[index]?.Value<string>() : null;
        }

        /// <summary>
        /// 功能描述：从参数数组读取第 index 个整数参数
        ///
        /// @param args - 参数数组
        /// @param index - 索引
        /// @param fallback - 解析失败时的默认值
        /// @returns 整数值
        /// </summary>
        private static int GetArgInt(JArray args, int index, int fallback)
        {
            if (index < args.Count && args[index] is JValue value && value.Type == JTokenType.Integer)
            {
                return value.Value<int>();
            }
            return fallback;
        }
    }
}
