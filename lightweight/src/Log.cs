using System;
using System.IO;

namespace SGI
{
    /// <summary>
    /// 文件日志：写入 %LOCALAPPDATA%\SGI\logs\app.log
    ///
    /// 对应 src/core/utils/logger.ts 的文件日志能力（精简版，单文件）。
    /// </summary>
    internal static class Log
    {
        private static readonly object LockObj = new object();

        /// <summary>当前日志文件路径</summary>
        public static string LogFilePath => Path.Combine(Env.LogsDir, "app.log");

        /// <summary>
        /// 功能描述：写入 INFO 级别日志
        ///
        /// @param message - 日志内容
        /// </summary>
        public static void Info(string message)
        {
            Write("INFO", message);
        }

        /// <summary>
        /// 功能描述：写入 WARN 级别日志
        ///
        /// @param message - 日志内容
        /// </summary>
        public static void Warn(string message)
        {
            Write("WARN", message);
        }

        /// <summary>
        /// 功能描述：写入 DEBUG 级别日志
        ///
        /// @param message - 日志内容
        /// </summary>
        public static void Debug(string message)
        {
            Write("DEBUG", message);
        }

        /// <summary>
        /// 功能描述：写入 ERROR 级别日志
        ///
        /// @param message - 日志内容
        /// </summary>
        public static void Error(string message)
        {
            Write("ERROR", message);
        }

        /// <summary>
        /// 功能描述：追加一条格式化日志到文件
        ///
        /// 逻辑说明：加锁避免多线程交错；日志写失败不影响主流程。
        ///
        /// @param level - 日志级别（INFO/ERROR）
        /// @param message - 日志内容
        /// </summary>
        private static void Write(string level, string message)
        {
            string line;
            try
            {
                lock (LockObj)
                {
                    Directory.CreateDirectory(Env.LogsDir);
                    line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] [{level}] {message}";
                    File.AppendAllText(LogFilePath, line + Environment.NewLine);
                }
            }
            catch
            {
                line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] [{level}] {message}";
            }
            // 同步推送到渲染进程日志页（WebView2 未就绪时 EventBus 内部空转）
            EventBus.Push("log:info", line);
        }

        /// <summary>
        /// 功能描述：清理超过保留天数的日志文件
        ///
        /// @param retentionDays - 保留天数，&lt;=0 表示不清理
        /// @returns 删除的文件数量
        /// </summary>
        public static int Cleanup(int retentionDays)
        {
            int deleted = 0;
            if (retentionDays <= 0 || !Directory.Exists(Env.LogsDir))
            {
                return 0;
            }

            try
            {
                var cutoff = DateTime.Now.AddDays(-retentionDays);
                foreach (var file in Directory.GetFiles(Env.LogsDir, "*.log"))
                {
                    if (File.GetLastWriteTime(file) < cutoff)
                    {
                        try
                        {
                            File.Delete(file);
                            deleted++;
                        }
                        catch
                        {
                            // 忽略单个文件删除失败
                        }
                    }
                }
            }
            catch
            {
                // 目录读取失败返回已删除数量
            }
            return deleted;
        }

        /// <summary>
        /// 功能描述：删除全部日志文件
        ///
        /// @returns 删除的文件数量
        /// </summary>
        public static int DeleteAll()
        {
            int deleted = 0;
            if (!Directory.Exists(Env.LogsDir))
            {
                return 0;
            }

            try
            {
                foreach (var file in Directory.GetFiles(Env.LogsDir, "*.log"))
                {
                    try
                    {
                        File.Delete(file);
                        deleted++;
                    }
                    catch
                    {
                        // 忽略单个文件删除失败
                    }
                }
            }
            catch
            {
                // 目录读取失败返回已删除数量
            }
            return deleted;
        }
    }
}
