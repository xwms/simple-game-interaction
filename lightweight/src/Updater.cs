using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace SGI
{
    /// <summary>
    /// 自动更新：检查更新、下载、替换自身 exe
    ///
    /// 对应 Electron 版 updater.js 的 C# 移植（仅 Windows 单文件 exe）。
    /// 检查更新优先 Gitee、失败降级 GitHub；下载支持断点续传；
    /// 安装通过分离启动的 .cmd 脚本等待本进程退出后覆盖自身 exe 并重启。
    /// </summary>
    internal static class Updater
    {
        // ─── 配置 ────────────────────────────────────────────
        private const long UpdateCacheTtlMs = 3600 * 1000; // 1 小时缓存
        private const string UpdateFileBase = "sgi-update"; // 与 installer 区分，固定名支持续传
        private const string Owner = "xwms";
        private const string Repo = "simple-game-interaction";

        private static readonly object CacheLock = new object();
        private static UpdateInfo _updateCache;
        private static long _lastCheckTime;

        private static readonly HttpClient Http;
        private static bool _tlsConfigured;

        static Updater()
        {
            var handler = new HttpClientHandler
            {
                AllowAutoRedirect = true,
                MaxAutomaticRedirections = 10,
                // GitHub API 在国内可能被 SNI 阻断导致证书验证失败
                ServerCertificateCustomValidationCallback = (sender, cert, chain, errors) => true
            };
            Http = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(30) };
        }

        /// <summary>更新包下载目标路径（userData 下固定名，支持续传）</summary>
        private static string UpdateDestPath
        {
            get { return Path.Combine(Env.UserDataDir, UpdateFileBase + ".exe"); }
        }

        /// <summary>下载完成标记路径（内容为已下载版本号）</summary>
        private static string UpdateDonePath
        {
            get { return UpdateDestPath + ".done"; }
        }

        /// <summary>
        /// 功能描述：初始化自动更新（启动后延迟 3 秒静默检查，结果写入缓存）
        ///
        /// 逻辑说明：不阻塞 UI，失败静默忽略。
        /// </summary>
        public static async void InitAsync()
        {
            await Task.Delay(3000).ConfigureAwait(false);
            try
            {
                await CheckForUpdatesAsync(Env.Version).ConfigureAwait(false);
            }
            catch
            {
                // 静默失败，不影响用户使用
            }
        }

        /// <summary>
        /// 功能描述：检查更新（Gitee 优先，GitHub 降级）
        ///
        /// 逻辑说明：1) 1 小时内缓存命中直接返回 2) 请求 Gitee API 3) 失败降级 GitHub API
        ///           4) semver 比较版本 5) 写入缓存。有更新时附带下载相关信息（续传/已装）。
        ///
        /// @param versionOverride - 当前版本号（渲染进程传入，缺失时用 Env.Version）
        /// @returns 更新信息，无更新或请求失败返回 null
        /// </summary>
        public static async Task<UpdateInfo> CheckForUpdatesAsync(string versionOverride)
        {
            EnsureTls();
            string currentVersion = string.IsNullOrEmpty(versionOverride) ? Env.Version : versionOverride;
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            lock (CacheLock)
            {
                if (now - _lastCheckTime < UpdateCacheTtlMs && _updateCache != null)
                {
                    // 缓存命中时重新验证安装包文件是否仍存在
                    ValidateCachedInstall();
                    return _updateCache;
                }
            }

            JToken releaseData = null;
            string source = null;

            // 优先 Gitee
            try
            {
                releaseData = await FetchJsonAsync($"https://gitee.com/api/v5/repos/{Owner}/{Repo}/releases/latest").ConfigureAwait(false);
                source = "gitee";
            }
            catch
            {
                // 忽略，降级到 GitHub
            }

            // 降级到 GitHub
            if (releaseData == null)
            {
                try
                {
                    releaseData = await FetchJsonAsync($"https://api.github.com/repos/{Owner}/{Repo}/releases/latest").ConfigureAwait(false);
                    source = "github";
                }
                catch
                {
                    // 忽略
                }
            }

            if (releaseData == null)
            {
                lock (CacheLock)
                {
                    _updateCache = null;
                    _lastCheckTime = now;
                }
                return null;
            }

            string tagName = releaseData["tag_name"]?.Value<string>() ?? "";
            string latestVersion = tagName.StartsWith("v", StringComparison.Ordinal) ? tagName.Substring(1) : tagName;
            bool hasUpdate = IsNewerVersion(currentVersion, latestVersion);

            Log.Info($"[updater] 当前版本={currentVersion}, 最新={latestVersion}, 源={source}, 有更新={hasUpdate}");

            long downloadedBytes = 0;
            bool installAvailable = false;
            if (hasUpdate)
            {
                try
                {
                    var fi = new FileInfo(UpdateDestPath);
                    if (fi.Exists && fi.Length > 0)
                    {
                        downloadedBytes = fi.Length;
                    }
                }
                catch
                {
                    // 文件不存在，从头下载
                }
                installAvailable = IsDownloadComplete(latestVersion);

                if (installAvailable)
                {
                    try
                    {
                        var fi = new FileInfo(UpdateDestPath);
                        if (!fi.Exists || fi.Length == 0)
                        {
                            installAvailable = false;
                            CleanUpdateFiles();
                        }
                    }
                    catch
                    {
                        installAvailable = false;
                        CleanUpdateFiles();
                    }
                }

                // 标记存在但版本不匹配（已下载旧版，服务器已发布新版）：清理避免误判
                if (!installAvailable && downloadedBytes > 0)
                {
                    try
                    {
                        string content = File.ReadAllText(UpdateDonePath).Trim();
                        if (content.Length > 0 && content != latestVersion)
                        {
                            CleanUpdateFiles();
                            downloadedBytes = 0;
                        }
                    }
                    catch
                    {
                        // 无标记文件，说明是未完成的部分下载，保留用于续传
                    }
                }
            }

            string downloadUrl = "";
            if (hasUpdate)
            {
                JToken assets = releaseData["assets"];
                var asset = FindPlatformAsset(assets);
                if (asset != null)
                {
                    downloadUrl = asset["browser_download_url"]?.Value<string>() ?? "";
                }
            }

            var result = new UpdateInfo
            {
                HasUpdate = hasUpdate,
                Version = hasUpdate ? latestVersion : currentVersion,
                ReleaseNotes = releaseData["body"]?.Value<string>() ?? "",
                Source = source,
                DownloadUrl = downloadUrl,
                DownloadedBytes = downloadedBytes,
                InstallAvailable = installAvailable,
                InstallPath = installAvailable ? UpdateDestPath : null
            };

            lock (CacheLock)
            {
                _updateCache = result;
                _lastCheckTime = now;
            }
            return result;
        }

        /// <summary>
        /// 功能描述：下载更新文件到固定路径（断点续传），实时回调进度
        ///
        /// 逻辑说明：已有部分文件时发送 Range 请求续传；服务器返回 200（不支持 Range）时从头下载。
        ///           总大小优先从 Content-Range 取，否则用 Content-Length。
        ///
        /// @param downloadUrl - 下载 URL
        /// @param onProgress - 进度回调 (0-100)
        /// @returns 下载完成后的文件路径
        /// @throws 下载失败或写入失败
        /// </summary>
        public static async Task<string> DownloadUpdateAsync(string downloadUrl, Action<int> onProgress)
        {
            EnsureTls();
            string destPath = UpdateDestPath;

            long existingSize = 0;
            try
            {
                var fi = new FileInfo(destPath);
                if (fi.Exists && fi.Length > 0)
                {
                    existingSize = fi.Length;
                }
            }
            catch
            {
                // 文件不存在，从头下载
            }

            using (var request = new HttpRequestMessage(HttpMethod.Get, downloadUrl))
            {
                request.Headers.TryAddWithoutValidation("User-Agent", "SGI/" + Env.Version);
                if (existingSize > 0)
                {
                    request.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(existingSize, null);
                }

                using (var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false))
                {
                    if (response.StatusCode == HttpStatusCode.OK && existingSize > 0)
                    {
                        // 服务器不支持 Range / 文件已变更：从头下载
                        existingSize = 0;
                    }
                    if (response.StatusCode != HttpStatusCode.OK && response.StatusCode != HttpStatusCode.PartialContent)
                    {
                        throw new Exception($"下载失败: HTTP {(int)response.StatusCode}");
                    }

                    long totalSize = response.Content.Headers.ContentLength ?? 0;
                    var contentRange = response.Content.Headers.ContentRange;
                    if (contentRange != null && contentRange.Length.HasValue)
                    {
                        totalSize = contentRange.Length.Value;
                    }

                    var flags = existingSize > 0 ? FileMode.Append : FileMode.Create;
                    using (var fs = new FileStream(destPath, flags, FileAccess.Write))
                    using (var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                    {
                        var buffer = new byte[64 * 1024];
                        long downloadedSize = existingSize;
                        int lastReported = -1;
                        int read;
                        while ((read = await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0)
                        {
                            await fs.WriteAsync(buffer, 0, read).ConfigureAwait(false);
                            downloadedSize += read;
                            if (totalSize > 0 && onProgress != null)
                            {
                                int percent = (int)Math.Min((downloadedSize * 100) / totalSize, 100);
                                if (percent != lastReported)
                                {
                                    lastReported = percent;
                                    onProgress(percent);
                                }
                            }
                        }
                    }
                }
            }

            onProgress?.Invoke(100);
            return destPath;
        }

        /// <summary>
        /// 功能描述：安装更新 — 覆盖当前 exe 并重启
        ///
        /// 逻辑说明：单文件 exe 无法在运行中覆盖自身，写一个分离启动的 .cmd：
        ///           等待 SGI.exe 退出 → 备份为 SGI.old.exe → 用下载的新 exe 覆盖 → 启动新版本。
        ///           调用成功后延迟退出当前进程，让响应先送达渲染进程。
        ///
        /// @param filePath - 下载完成的更新包路径
        /// @returns 是否成功启动安装
        /// </summary>
        public static bool InstallUpdate(string filePath)
        {
            if (string.IsNullOrEmpty(filePath) || !filePath.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(filePath))
            {
                return false;
            }

            string currentExe = GetCurrentExePath();
            string oldExe = Path.Combine(Path.GetDirectoryName(currentExe) ?? Env.UserDataDir, "SGI.old.exe");
            string cmdPath = Path.Combine(Env.UserDataDir, "sgi-update.cmd");

            string exeName = Path.GetFileName(currentExe);

            var sb = new StringBuilder();
            sb.AppendLine("@echo off");
            sb.AppendLine($"set \"NEW={filePath}\"");
            sb.AppendLine($"set \"OLD={oldExe}\"");
            sb.AppendLine($"set \"TARGET={currentExe}\"");
            sb.AppendLine($":wait");
            sb.AppendLine($"tasklist /FI \"IMAGENAME eq {exeName}\" 2>nul | find /I \"{exeName}\" >nul");
            sb.AppendLine($"if not errorlevel 1 (");
            sb.AppendLine($"  ping -n 2 127.0.0.1 >nul");
            sb.AppendLine($"  goto wait");
            sb.AppendLine($")");
            sb.AppendLine($"move /Y \"%TARGET%\" \"%OLD%\" >nul 2>&1");
            sb.AppendLine($"copy /Y \"%NEW%\" \"%TARGET%\" >nul 2>&1");
            sb.AppendLine($"start \"\" \"%TARGET%\"");
            sb.AppendLine($"del \"%~f0\"");

            try
            {
                File.WriteAllText(cmdPath, sb.ToString(), Encoding.Default);

                var psi = new ProcessStartInfo(cmdPath)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = Path.GetDirectoryName(currentExe) ?? Env.UserDataDir
                };
                Process.Start(psi);

                Log.Info($"[updater] 安装脚本已启动: {cmdPath}");
                return true;
            }
            catch (Exception ex)
            {
                Log.Error($"[updater] 启动安装脚本失败: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// 功能描述：写入下载完成标记（附带版本号）
        ///
        /// @param version - 已下载的版本号
        /// </summary>
        public static void MarkDownloadComplete(string version)
        {
            try
            {
                File.WriteAllText(UpdateDonePath, version, Encoding.UTF8);
            }
            catch
            {
                // 标记失败忽略
            }
        }

        /// <summary>
        /// 功能描述：检查指定版本是否已下载完成
        ///
        /// @param version - 要检查的版本号
        /// @returns 标记存在且版本匹配时返回 true
        /// </summary>
        public static bool IsDownloadComplete(string version)
        {
            try
            {
                return File.ReadAllText(UpdateDonePath).Trim() == version;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// 功能描述：清理更新临时文件和标记
        /// </summary>
        public static void CleanUpdateFiles()
        {
            try { if (File.Exists(UpdateDestPath)) File.Delete(UpdateDestPath); } catch { }
            try { if (File.Exists(UpdateDonePath)) File.Delete(UpdateDonePath); } catch { }
        }

        /// <summary>
        /// 功能描述：清理上次更新留下的旧 exe 备份（启动时调用）
        /// </summary>
        public static void CleanOldExe()
        {
            try
            {
                string currentDir = Path.GetDirectoryName(GetCurrentExePath()) ?? "";
                string oldExe = Path.Combine(currentDir, "SGI.old.exe");
                if (File.Exists(oldExe))
                {
                    File.Delete(oldExe);
                }
            }
            catch
            {
                // 清理失败忽略
            }
        }

        // ─── 私有工具 ───────────────────────────────────────

        /// <summary>
        /// 功能描述：确保启用 TLS 1.2
        /// </summary>
        private static void EnsureTls()
        {
            if (!_tlsConfigured)
            {
                try
                {
                    ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
                }
                catch
                {
                    // 已启用则忽略
                }
                _tlsConfigured = true;
            }
        }

        /// <summary>
        /// 功能描述：从 URL 获取 JSON 数据
        ///
        /// @param url - API URL
        /// @returns 解析后的 JSON，非 200 或解析失败抛异常
        /// </summary>
        private static async Task<JToken> FetchJsonAsync(string url)
        {
            using (var request = new HttpRequestMessage(HttpMethod.Get, url))
            {
                request.Headers.TryAddWithoutValidation("User-Agent", "SGI/" + Env.Version);
                request.Headers.TryAddWithoutValidation("Accept", "application/json");
                using (var cts = new System.Threading.CancellationTokenSource(8000))
                using (var response = await Http.SendAsync(request, cts.Token).ConfigureAwait(false))
                {
                    if (response.StatusCode != HttpStatusCode.OK)
                    {
                        throw new Exception($"HTTP {(int)response.StatusCode}");
                    }
                    string body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                    return JToken.Parse(body);
                }
            }
        }

        /// <summary>
        /// 功能描述：semver 版本比较
        ///
        /// @param v1 - 当前版本
        /// @param v2 - 目标版本
        /// @returns v2 &gt; v1 时返回 true
        /// </summary>
        private static bool IsNewerVersion(string v1, string v2)
        {
            var a = ParseVersion(v1);
            var b = ParseVersion(v2);
            for (int i = 0; i < 3; i++)
            {
                if (b[i] > a[i]) return true;
                if (b[i] < a[i]) return false;
            }
            return false;
        }

        /// <summary>
        /// 功能描述：解析版本号为三段数字
        ///
        /// @param version - 版本号字符串
        /// @returns 三段数组（缺省补 0）
        /// </summary>
        private static int[] ParseVersion(string version)
        {
            string v = version.StartsWith("v", StringComparison.Ordinal) ? version.Substring(1) : version;
            var parts = v.Split('.');
            var result = new int[3];
            for (int i = 0; i < 3 && i < parts.Length; i++)
            {
                int n;
                result[i] = int.TryParse(parts[i], out n) ? n : 0;
            }
            return result;
        }

        /// <summary>
        /// 功能描述：从 Release assets 中筛选 Windows .exe 安装包
        ///
        /// 逻辑说明：按 .exe 后缀匹配，找不到时回退到第一个 asset。
        ///
        /// @param assets - Release 的 assets 数组（可能为 null）
        /// @returns 匹配的 asset 对象或 null
        /// </summary>
        private static JToken FindPlatformAsset(JToken assets)
        {
            if (assets == null || assets.Type != JTokenType.Array || !assets.HasValues)
            {
                return null;
            }
            JToken fallback = null;
            foreach (var asset in assets)
            {
                if (fallback == null)
                {
                    fallback = asset;
                }
                string name = asset["name"]?.Value<string>() ?? "";
                string url = asset["browser_download_url"]?.Value<string>() ?? "";
                if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ||
                    url.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                {
                    return asset;
                }
            }
            return fallback;
        }

        /// <summary>
        /// 功能描述：校验缓存的安装包文件是否仍存在，不存在则清理
        /// </summary>
        private static void ValidateCachedInstall()
        {
            if (_updateCache != null && _updateCache.InstallAvailable)
            {
                try
                {
                    var fi = new FileInfo(UpdateDestPath);
                    if (!fi.Exists || fi.Length == 0)
                    {
                        _updateCache.InstallAvailable = false;
                        CleanUpdateFiles();
                    }
                }
                catch
                {
                    _updateCache.InstallAvailable = false;
                    CleanUpdateFiles();
                }
            }
        }

        /// <summary>
        /// 功能描述：获取当前可执行文件路径
        ///
        /// @returns 当前 exe 完整路径
        /// </summary>
        private static string GetCurrentExePath()
        {
            var assembly = Assembly.GetExecutingAssembly().Location;
            if (!string.IsNullOrEmpty(assembly))
            {
                return assembly;
            }
            var cmdLine = Environment.GetCommandLineArgs();
            return cmdLine.Length > 0 ? cmdLine[0] : Path.Combine(Env.UserDataDir, "SGI.exe");
        }
    }
}
