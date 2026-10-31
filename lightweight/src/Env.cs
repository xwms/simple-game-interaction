using System;
using System.IO;
using System.Reflection;

namespace SGI
{
    /// <summary>
    /// 环境与路径：版本号、userData 目录、SPA 目录、原生 DLL 释放
    ///
    /// 对应 Electron 版 app.getVersion() / app.getPath('userData') 的替代实现。
    /// </summary>
    internal static class Env
    {
        /// <summary>WebView2 虚拟域名（SPA 通过 https://app.local 加载）</summary>
        public const string VirtualHost = "app.local";

        /// <summary>应用版本号（由 csproj Version 属性生成，build.mjs 可注入）</summary>
        public static string Version { get; } = ReadVersion();

        /// <summary>userData 目录：%LOCALAPPDATA%\SGI</summary>
        public static string UserDataDir { get; } = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SGI");

        /// <summary>解压后的 SPA 根目录</summary>
        public static string WebDir { get; } = Path.Combine(UserDataDir, "web");

        /// <summary>日志目录</summary>
        public static string LogsDir { get; } = Path.Combine(UserDataDir, "logs");

        /// <summary>WebView2 用户数据目录（隔离，避免与浏览器冲突）</summary>
        public static string WebView2UserDataDir { get; } = Path.Combine(UserDataDir, "WebView2");

        /// <summary>WebView2Loader.dll 释放目录</summary>
        public static string NativeBinDir { get; } = Path.Combine(UserDataDir, "bin");

        /// <summary>
        /// 功能描述：读取程序集版本号作为应用版本
        ///
        /// @returns 形如 1.2.2 的三段版本号，读取失败时返回 1.0.0
        /// </summary>
        private static string ReadVersion()
        {
            try
            {
                var version = Assembly.GetExecutingAssembly().GetName().Version;
                return version != null ? version.ToString(3) : "1.0.0";
            }
            catch
            {
                return "1.0.0";
            }
        }

        /// <summary>
        /// 功能描述：初始化目录结构并释放内嵌的 WebView2Loader.dll
        ///
        /// 逻辑说明：单文件打包下 WebView2Loader.dll 无法随 exe 直接加载，
        ///           首次启动释放到 userData/bin 并写入当前目录注册表搜索路径，
        ///           使托管包装层的 DllImport 能定位到该原生 DLL。
        /// </summary>
        public static void Init()
        {
            Directory.CreateDirectory(UserDataDir);
            Directory.CreateDirectory(WebDir);
            Directory.CreateDirectory(LogsDir);

            string loader = ExtractNativeLoader();
            if (loader != null)
            {
                SetDllDirectory(Path.GetDirectoryName(loader));
            }
        }

        /// <summary>
        /// 功能描述：从内嵌资源释放 WebView2Loader.dll 到 userData/bin
        ///
        /// @returns 释放后的完整路径；资源缺失或已存在时返回现有路径；失败返回 null
        /// </summary>
        private static string ExtractNativeLoader()
        {
            string dest = Path.Combine(NativeBinDir, "WebView2Loader.dll");
            if (File.Exists(dest))
            {
                return dest;
            }

            try
            {
                Directory.CreateDirectory(NativeBinDir);
                using (var stream = Assembly.GetExecutingAssembly()
                    .GetManifestResourceStream("SGI.Resources.WebView2Loader.dll"))
                {
                    if (stream == null)
                    {
                        return null;
                    }
                    using (var fs = new FileStream(dest, FileMode.Create, FileAccess.Write))
                    {
                        stream.CopyTo(fs);
                    }
                }
                return dest;
            }
            catch (Exception ex)
            {
                Log.Error($"释放 WebView2Loader.dll 失败: {ex.Message}");
                return null;
            }
        }

        [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
        private static extern bool SetDllDirectory(string lpPathName);
    }
}
