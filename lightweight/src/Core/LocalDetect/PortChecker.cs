using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net.Sockets;
using System.Text.RegularExpressions;

namespace SGI
{
    /// <summary>
    /// 本地端口检测器 — 检查本机端口是否被监听
    ///
    /// 对应 src/core/local-detect/port-checker.ts 的 C# 移植（仅 Windows）。
    /// TCP 端口通过连接测试，UDP 端口通过 netstat -ano 命令检测。
    /// </summary>
    internal static class PortChecker
    {
        /// <summary>
        /// 功能描述：通过 TCP 连接检测端口是否被使用
        ///
        /// @param port - 端口号
        /// @param timeoutMs - 超时时间
        /// @returns 是否被使用
        /// </summary>
        public static bool CheckTcpPort(int port, int timeoutMs = 2000)
        {
            try
            {
                using (var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp))
                {
                    var result = socket.BeginConnect("127.0.0.1", port, null, null);
                    if (!result.AsyncWaitHandle.WaitOne(timeoutMs))
                    {
                        socket.Close();
                        return false;
                    }
                    socket.EndConnect(result);
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// 功能描述：检查单个端口的占用情况
        ///
        /// @param port - 端口号
        /// @param protocol - 协议类型（tcp/udp）
        /// @returns 检测结果
        /// </summary>
        public static PortCheckResult CheckPort(int port, string protocol = "tcp")
        {
            // UDP 端口检测需要系统命令支持，此处保持与 TS 一致（UDP 恒为 false）
            var inUse = protocol == "tcp" ? CheckTcpPort(port) : false;

            int? pid = null;
            string processName = null;
            if (inUse)
            {
                var info = FindProcessByPort(port, protocol);
                if (info != null)
                {
                    pid = info.Item1;
                    processName = info.Item2;
                }
            }

            return new PortCheckResult
            {
                Port = port,
                Protocol = protocol,
                InUse = inUse,
                Pid = pid,
                ProcessName = processName
            };
        }

        /// <summary>
        /// 功能描述：批量检查多个端口
        ///
        /// @param ports - 端口号列表
        /// @param protocol - 协议类型（tcp/udp）
        /// @returns 检测结果列表
        /// </summary>
        public static List<PortCheckResult> CheckPorts(List<int> ports, string protocol = "tcp")
        {
            return ports.Select(p => CheckPort(p, protocol)).ToList();
        }

        /// <summary>
        /// 功能描述：通过 PID 查找进程占用的端口（Windows netstat -ano）
        ///
        /// @param pid - 进程 ID
        /// @returns 端口列表
        /// </summary>
        public static List<int> FindPortsByPid(int pid)
        {
            var ports = new List<int>();
            string stdout;
            try
            {
                stdout = RunCommand("netstat", "-ano");
            }
            catch
            {
                return ports;
            }

            foreach (var line in stdout.Split('\n'))
            {
                var trimmed = line.Trim();
                if (trimmed.Length == 0)
                {
                    continue;
                }
                // netstat -ano 输出格式:
                //   TCP    0.0.0.0:25565           0.0.0.0:0              LISTENING       12345
                //   TCP    127.0.0.1:60228         0.0.0.0:0              LISTENING       12345
                //   UDP    0.0.0.0:34197           *:*                                    12345
                var pidMatch = Regex.Match(trimmed, @"(\d+)\s*$");
                if (!pidMatch.Success || int.Parse(pidMatch.Groups[1].Value) != pid)
                {
                    continue;
                }
                // 跳过仅监听 127.0.0.1/::1 的端口（JVM 内部临时端口，非游戏服务器）
                if (trimmed.Contains("127.0.0.1:") || trimmed.Contains("::1:"))
                {
                    continue;
                }
                var match = Regex.Match(trimmed, @"TCP\s+\S+:(\d+)\s+\S+:\d+\s+LISTENING", RegexOptions.IgnoreCase);
                var udpMatch = Regex.Match(match.Success ? "" : trimmed, @"UDP\s+\S+:(\d+)\s+", RegexOptions.IgnoreCase);
                if (match.Success)
                {
                    ports.Add(int.Parse(match.Groups[1].Value));
                }
                else if (udpMatch.Success)
                {
                    ports.Add(int.Parse(udpMatch.Groups[1].Value));
                }
            }

            return ports.Distinct().ToList();
        }

        /// <summary>
        /// 功能描述：通过端口查找占用进程（Windows netstat -ano）
        ///
        /// @param port - 端口号
        /// @param protocol - 协议类型（tcp/udp）
        /// @returns 进程信息（如有）
        /// </summary>
        private static Tuple<int, string> FindProcessByPort(int port, string protocol)
        {
            string stdout;
            try
            {
                stdout = RunCommand("netstat", "-ano");
            }
            catch
            {
                return null;
            }

            foreach (var line in stdout.Split('\n'))
            {
                if (line.Contains($":{port}") && line.ToLowerInvariant().Contains(protocol))
                {
                    var parts = line.Trim().Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length > 0 && int.TryParse(parts[parts.Length - 1], out int foundPid) && foundPid != 0)
                    {
                        return Tuple.Create(foundPid, $"pid:{foundPid}");
                    }
                }
            }
            return null;
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
                proc.WaitForExit(3000);
                return stdout;
            }
        }
    }
}
