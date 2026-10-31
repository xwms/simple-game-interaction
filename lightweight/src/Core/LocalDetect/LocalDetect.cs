using System.Collections.Generic;

namespace SGI
{
    /// <summary>
    /// 本地游戏检测 — 聚合进程扫描与端口检测
    ///
    /// 对应 src/core/local-detect/index.ts 的 C# 移植。
    /// 结合游戏数据库判断检测到的进程/端口对应哪款游戏。
    /// </summary>
    internal static class LocalDetect
    {
        /// <summary>
        /// 功能描述：检测本机运行的所有已知游戏
        ///
        /// 逻辑说明：遍历游戏数据库，检查每个游戏关联的进程名是否运行。
        ///           当匹配到进程时遍历所有匹配项，找到第一个实际有监听端口的进程。
        ///           展开结果：每个端口一个独立条目（gameId 追加端口号以去重）。
        ///
        /// @returns 检测结果列表
        /// </summary>
        public static List<GameDetectResult> DetectLocalGames()
        {
            var games = GameDb.GetAll();
            var results = new List<GameDetectResult>();
            foreach (var game in games)
            {
                try
                {
                    results.Add(DetectGameEntry(game));
                }
                catch
                {
                    // 单个游戏检测失败忽略，不影响其他游戏
                }
            }

            // 展开：每个端口一个独立条目（gameId 追加端口号以去重）
            var flat = new List<GameDetectResult>();
            foreach (var r in results)
            {
                if (r.Ports.Count > 1)
                {
                    foreach (var p in r.Ports)
                    {
                        flat.Add(new GameDetectResult
                        {
                            GameId = $"{r.GameId}:{p}",
                            Name = r.Name,
                            Running = r.Running,
                            PortOpen = true,
                            Port = p,
                            Ports = new List<int> { p },
                            Pid = r.Pid,
                            ProcessName = r.ProcessName
                        });
                    }
                }
                else
                {
                    flat.Add(r);
                }
            }
            return flat;
        }

        /// <summary>
        /// 功能描述：检测指定游戏是否在本地运行
        ///
        /// @param gameId - 游戏 ID
        /// @returns 检测结果，游戏未找到返回 null
        /// </summary>
        public static GameDetectResult DetectGame(string gameId)
        {
            var game = GameDb.GetById(gameId);
            if (game == null)
            {
                return null;
            }
            return DetectGameEntry(game);
        }

        /// <summary>
        /// 功能描述：检测单个游戏条目的运行状态
        ///
        /// 逻辑说明：匹配进程后遍历每个进程实际监听的端口。
        ///           仅当进程运行且实际端口开放时才标记 portOpen。
        ///           都没监听端口时仍记录首个匹配的进程（供 UI 显示）。
        ///
        /// @param game - 游戏协议数据库条目
        /// @returns 检测结果
        /// </summary>
        private static GameDetectResult DetectGameEntry(GameProtocolEntry game)
        {
            var allMatches = new List<ProcessInfo>();
            foreach (var name in game.ProcessNames)
            {
                allMatches.AddRange(ProcessScanner.FindProcesses(name));
            }

            var running = allMatches.Count > 0;
            int? pid = null;
            string processName = null;
            var allPorts = new List<int>();

            // 遍历所有匹配的进程，收集每个进程实际监听的端口
            // 多个同游戏进程同时运行时（如 HMCL 启动器 + Minecraft 服务端），
            // 全部列出让用户选择
            foreach (var match in allMatches)
            {
                var actualPorts = PortChecker.FindPortsByPid(match.Pid);
                if (processName == null)
                {
                    processName = match.Name;
                }
                foreach (var p in actualPorts)
                {
                    if (!allPorts.Contains(p))
                    {
                        allPorts.Add(p);
                        if (pid == null)
                        {
                            pid = match.Pid;
                        }
                    }
                }
            }

            var portOpen = allPorts.Count > 0;

            // 都没监听端口时仍记录首个匹配的进程（供 UI 显示）
            if (!portOpen && allMatches.Count > 0)
            {
                pid = allMatches[0].Pid;
                processName = allMatches[0].Name;
            }

            return new GameDetectResult
            {
                GameId = game.Id,
                Name = game.Name,
                Running = running,
                PortOpen = portOpen,
                Port = allPorts.Count > 0 ? allPorts[0] : game.DefaultPort,
                Ports = allPorts,
                Pid = pid,
                ProcessName = processName
            };
        }
    }
}
