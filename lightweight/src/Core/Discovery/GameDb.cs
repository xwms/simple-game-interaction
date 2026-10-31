using System;
using System.Collections.Generic;

namespace SGI
{
    /// <summary>
    /// 游戏协议数据库：管理所有已知游戏的端口、协议、进程名
    ///
    /// 对应 src/core/discovery/game-db.ts 的 C# 移植。
    /// 内置 8 款常见局域网联机游戏，支持运行时注册新游戏。
    /// </summary>
    internal static class GameDb
    {
        private static readonly Dictionary<string, GameProtocolEntry> Registry =
            new Dictionary<string, GameProtocolEntry>();

        static GameDb()
        {
            foreach (var game in BuiltInGames)
            {
                Registry[game.Id] = game;
            }
        }

        /// <summary>内置游戏列表（与 TS BUILT_IN_GAMES 一致）</summary>
        private static readonly GameProtocolEntry[] BuiltInGames =
        {
            new GameProtocolEntry
            {
                Id = "minecraft-java", Name = "Minecraft: Java Edition",
                ProcessNames = new List<string> { "java", "javaw" },
                DefaultPort = 25565, Protocol = "tcp",
                AltPorts = new List<int> { 25566, 25567, 25568, 25569, 25570 },
                Sniffable = true, Description = "Minecraft Java Edition 服务器（TCP 25565）"
            },
            new GameProtocolEntry
            {
                Id = "terraria", Name = "Terraria",
                ProcessNames = new List<string> { "Terraria", "TerrariaServer", "TerrariaServer.exe" },
                DefaultPort = 7777, Protocol = "tcp",
                AltPorts = new List<int> { 7778, 7779, 7780 },
                Sniffable = true, Description = "Terraria 服务器（TCP 7777）"
            },
            new GameProtocolEntry
            {
                Id = "stardew-valley", Name = "Stardew Valley",
                ProcessNames = new List<string> { "Stardew Valley", "StardewModdingAPI" },
                DefaultPort = 24642, Protocol = "tcp",
                Sniffable = false, Description = "Stardew Valley 联机（TCP 24642）"
            },
            new GameProtocolEntry
            {
                Id = "factorio", Name = "Factorio",
                ProcessNames = new List<string> { "factorio", "factorio.exe" },
                DefaultPort = 34197, Protocol = "udp",
                Sniffable = false, Description = "Factorio 服务器（UDP 34197）"
            },
            new GameProtocolEntry
            {
                Id = "valheim", Name = "Valheim",
                ProcessNames = new List<string> { "valheim_server", "valheim_server.exe" },
                DefaultPort = 2456, Protocol = "tcp",
                AltPorts = new List<int> { 2457, 2458 },
                Sniffable = false, Description = "Valheim 服务器（TCP 2456-2458）"
            },
            new GameProtocolEntry
            {
                Id = "csgo", Name = "Counter-Strike: Global Offensive",
                ProcessNames = new List<string> { "csgo", "csgo.exe" },
                DefaultPort = 27015, Protocol = "udp",
                AltPorts = new List<int> { 27016, 27017, 27018, 26900 },
                Sniffable = false, Description = "CS:GO 局域网服务器（UDP 27015）"
            },
            new GameProtocolEntry
            {
                Id = "openarena", Name = "OpenArena",
                ProcessNames = new List<string> { "openarena", "openarena.exe", "oa_ded" },
                DefaultPort = 27960, Protocol = "udp",
                AltPorts = new List<int> { 27961, 27962, 27963, 27964, 27965 },
                Sniffable = false, Description = "OpenArena 服务器（UDP 27960）"
            },
            new GameProtocolEntry
            {
                Id = "donut-server", Name = "Donut Server",
                ProcessNames = new List<string> { "donut-server", "donut-server.exe" },
                DefaultPort = 24860, Protocol = "tcp",
                Sniffable = false, Description = "通用 TCP 游戏服务器"
            }
        };

        /// <summary>
        /// 功能描述：按游戏 ID 查询
        ///
        /// @param id - 游戏标识（如 'minecraft-java'）
        /// @returns 游戏条目，未找到返回 null
        /// </summary>
        public static GameProtocolEntry GetById(string id)
        {
            if (id != null && Registry.TryGetValue(id, out var entry))
            {
                return entry;
            }
            return null;
        }

        /// <summary>
        /// 功能描述：按端口号查询所有匹配的游戏（含 altPorts）
        ///
        /// @param port - 端口号
        /// @returns 匹配的游戏列表
        /// </summary>
        public static List<GameProtocolEntry> GetByPort(int port)
        {
            var result = new List<GameProtocolEntry>();
            foreach (var entry in Registry.Values)
            {
                if (entry.DefaultPort == port || entry.AltPorts.Contains(port))
                {
                    result.Add(entry);
                }
            }
            return result;
        }

        /// <summary>
        /// 功能描述：按进程名查询所有匹配的游戏（去 .exe 后缀，大小写不敏感）
        ///
        /// @param processName - 进程名
        /// @returns 匹配的游戏列表
        /// </summary>
        public static List<GameProtocolEntry> GetByProcessName(string processName)
        {
            string lower = processName.ToLowerInvariant();
            if (lower.EndsWith(".exe", StringComparison.Ordinal))
            {
                lower = lower.Substring(0, lower.Length - 4);
            }
            var result = new List<GameProtocolEntry>();
            foreach (var entry in Registry.Values)
            {
                foreach (var name in entry.ProcessNames)
                {
                    if (name.ToLowerInvariant() == lower)
                    {
                        result.Add(entry);
                        break;
                    }
                }
            }
            return result;
        }

        /// <summary>
        /// 功能描述：获取所有已注册的游戏
        ///
        /// @returns 游戏条目列表
        /// </summary>
        public static List<GameProtocolEntry> GetAll()
        {
            return new List<GameProtocolEntry>(Registry.Values);
        }

        /// <summary>
        /// 功能描述：获取所有可嗅探的游戏
        ///
        /// @returns 可嗅探的游戏条目列表
        /// </summary>
        public static List<GameProtocolEntry> GetSniffable()
        {
            var result = new List<GameProtocolEntry>();
            foreach (var entry in Registry.Values)
            {
                if (entry.Sniffable)
                {
                    result.Add(entry);
                }
            }
            return result;
        }

        /// <summary>
        /// 功能描述：运行时注册或覆盖一款游戏
        ///
        /// @param entry - 游戏条目
        /// </summary>
        public static void Register(GameProtocolEntry entry)
        {
            Registry[entry.Id] = entry;
        }

        /// <summary>
        /// 功能描述：批量注册游戏
        ///
        /// @param entries - 游戏条目列表
        /// </summary>
        public static void RegisterAll(IEnumerable<GameProtocolEntry> entries)
        {
            foreach (var entry in entries)
            {
                Registry[entry.Id] = entry;
            }
        }
    }
}
