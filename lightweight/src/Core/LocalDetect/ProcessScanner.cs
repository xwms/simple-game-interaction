using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.RegularExpressions;

namespace SGI
{
    /// <summary>
    /// 本地进程扫描器 — 通过 tasklist 检测正在运行的进程
    ///
    /// 对应 src/core/local-detect/process-scanner.ts 的 C# 移植（仅 Windows）。
    /// 匹配进程名时忽略大小写和 .exe 后缀，支持部分匹配。
    /// </summary>
    internal static class ProcessScanner
    {
        /// <summary>
        /// 功能描述：枚举 Windows 全部进程
        ///
        /// @returns 进程列表（名称已小写化）
        /// </summary>
        public static List<ProcessInfo> ListProcesses()
        {
            var processes = new List<ProcessInfo>();
            string stdout;
            try
            {
                stdout = RunCommand("tasklist", "/NH /FO CSV");
            }
            catch
            {
                return processes;
            }

            foreach (var line in stdout.Split('\n'))
            {
                var trimmed = line.Trim();
                if (trimmed.Length == 0)
                {
                    continue;
                }
                // CSV 格式: "image name","pid","session name","session#","mem usage"
                var match = Regex.Match(trimmed, "\"([^\"]+)\",\"(\\d+)\"");
                if (match.Success)
                {
                    processes.Add(new ProcessInfo
                    {
                        Name = match.Groups[1].Value.ToLowerInvariant(),
                        Pid = int.Parse(match.Groups[2].Value)
                    });
                }
            }
            return processes;
        }

        /// <summary>
        /// 功能描述：查找匹配名称的进程
        ///
        /// 逻辑说明：模糊匹配进程名，忽略大小写和 .exe 后缀。
        ///           支持部分匹配（如 'java' 匹配 'javaw.exe'）。
        ///
        /// @param nameOrPattern - 进程名或部分名称
        /// @returns 匹配的进程列表
        /// </summary>
        public static List<ProcessInfo> FindProcesses(string nameOrPattern)
        {
            var pattern = nameOrPattern.ToLowerInvariant();
            if (pattern.EndsWith(".exe"))
            {
                pattern = pattern.Substring(0, pattern.Length - 4);
            }
            var processes = ListProcesses();
            return processes.Where(p => p.Name.Contains(pattern)).ToList();
        }

        /// <summary>
        /// 功能描述：检查指定进程名是否正在运行
        ///
        /// @param processName - 进程名
        /// @returns 是否运行中
        /// </summary>
        public static bool IsRunning(string processName)
        {
            return FindProcesses(processName).Count > 0;
        }

        /// <summary>
        /// 功能描述：执行子进程并读取 stdout
        ///
        /// @param fileName - 可执行文件路径
        /// @param args - 参数
        /// @returns stdout 内容
        /// @throws 进程启动失败时抛出
        /// </summary>
        private static string RunCommand(string fileName, string args)
        {
            var psi = new ProcessStartInfo(fileName, args)
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using (var proc = Process.Start(psi))
            {
                if (proc == null)
                {
                    return "";
                }
                var stdout = proc.StandardOutput.ReadToEnd();
                proc.WaitForExit(5000);
                return stdout;
            }
        }
    }
}
