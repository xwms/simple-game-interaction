/**
 * 功能描述：游戏协议数据库 — 管理所有已知游戏的端口、协议、进程名
 *
 * 逻辑说明：内置 8 款常见局域网联机游戏的端口/协议信息。
 *           支持运行时注册新游戏。提供通过端口、进程名、游戏 ID
 *           查询游戏条目的方法。
 *
 * @module game-db
 */

import type { GameProtocolEntry } from '@shared/types'

// ─── 内置游戏列表 ───────────────────────────────────────
const BUILT_IN_GAMES: GameProtocolEntry[] = [
  {
    id: 'minecraft-java',
    name: 'Minecraft: Java Edition',
    processNames: ['java', 'javaw'],
    defaultPort: 25565,
    protocol: 'tcp',
    altPorts: [25566, 25567, 25568, 25569, 25570],
    sniffable: true,
    description: 'Minecraft Java Edition 服务器（TCP 25565）'
  },
  {
    id: 'terraria',
    name: 'Terraria',
    processNames: ['Terraria', 'TerrariaServer', 'TerrariaServer.exe'],
    defaultPort: 7777,
    protocol: 'tcp',
    altPorts: [7778, 7779, 7780],
    sniffable: true,
    description: 'Terraria 服务器（TCP 7777）'
  },
  {
    id: 'stardew-valley',
    name: 'Stardew Valley',
    processNames: ['Stardew Valley', 'StardewModdingAPI'],
    defaultPort: 24642,
    protocol: 'tcp',
    sniffable: false,
    description: 'Stardew Valley 联机（TCP 24642）'
  },
  {
    id: 'factorio',
    name: 'Factorio',
    processNames: ['factorio', 'factorio.exe'],
    defaultPort: 34197,
    protocol: 'udp',
    sniffable: false,
    description: 'Factorio 服务器（UDP 34197）'
  },
  {
    id: 'valheim',
    name: 'Valheim',
    processNames: ['valheim_server', 'valheim_server.exe'],
    defaultPort: 2456,
    protocol: 'tcp',
    altPorts: [2457, 2458],
    sniffable: false,
    description: 'Valheim 服务器（TCP 2456-2458）'
  },
  {
    id: 'csgo',
    name: 'Counter-Strike: Global Offensive',
    processNames: ['csgo', 'csgo.exe'],
    defaultPort: 27015,
    protocol: 'udp',
    altPorts: [27016, 27017, 27018, 26900],
    sniffable: false,
    description: 'CS:GO 局域网服务器（UDP 27015）'
  },
  {
    id: 'openarena',
    name: 'OpenArena',
    processNames: ['openarena', 'openarena.exe', 'oa_ded'],
    defaultPort: 27960,
    protocol: 'udp',
    altPorts: [27961, 27962, 27963, 27964, 27965],
    sniffable: false,
    description: 'OpenArena 服务器（UDP 27960）'
  },
  {
    id: 'donut-server',
    name: 'Donut Server',
    processNames: ['donut-server', 'donut-server.exe'],
    defaultPort: 24860,
    protocol: 'tcp',
    sniffable: false,
    description: '通用 TCP 游戏服务器'
  }
]

// ─── 运行时注册表 ───────────────────────────────────────
const _registry: Map<string, GameProtocolEntry> = new Map()

// 初始化时加载内置游戏
for (const game of BUILT_IN_GAMES) {
  _registry.set(game.id, game)
}

/**
 * 功能描述：按游戏 ID 查询
 *
 * @param id - 游戏标识（如 'minecraft-java'）
 * @returns 游戏条目，未找到返回 undefined
 */
function getById(id: string): GameProtocolEntry | undefined {
  return _registry.get(id)
}

/**
 * 功能描述：按端口号查询所有匹配的游戏
 *
 * 逻辑说明：同时匹配 defaultPort 和 altPorts。
 *
 * @param port - 端口号
 * @returns 匹配的游戏列表
 */
function getByPort(port: number): GameProtocolEntry[] {
  const result: GameProtocolEntry[] = []
  for (const entry of _registry.values()) {
    if (entry.defaultPort === port || entry.altPorts?.includes(port)) {
      result.push(entry)
    }
  }
  return result
}

/**
 * 功能描述：按进程名查询所有匹配的游戏
 *
 * @param processName - 进程名（不含 .exe 后缀，大小写不敏感）
 * @returns 匹配的游戏列表
 */
function getByProcessName(processName: string): GameProtocolEntry[] {
  const lower = processName.toLowerCase().replace(/\.exe$/, '')
  const result: GameProtocolEntry[] = []
  for (const entry of _registry.values()) {
    if (entry.processNames.some((name) => name.toLowerCase() === lower)) {
      result.push(entry)
    }
  }
  return result
}

/**
 * 功能描述：获取所有已注册的游戏
 *
 * @returns 游戏条目列表
 */
function getAll(): GameProtocolEntry[] {
  return Array.from(_registry.values())
}

/**
 * 功能描述：获取所有可嗅探的游戏
 *
 * @returns 可嗅探的游戏条目列表
 */
function getSniffable(): GameProtocolEntry[] {
  return Array.from(_registry.values()).filter((g) => g.sniffable)
}

/**
 * 功能描述：运行时注册新游戏
 *
 * 逻辑说明：如果游戏 ID 已存在则覆盖，可通过此方法扩展数据库。
 *
 * @param entry - 游戏条目
 */
function register(entry: GameProtocolEntry): void {
  _registry.set(entry.id, entry)
}

/**
 * 功能描述：批量注册游戏
 *
 * @param entries - 游戏条目列表
 */
function registerAll(entries: GameProtocolEntry[]): void {
  for (const entry of entries) {
    _registry.set(entry.id, entry)
  }
}

export const gameDatabase = {
  getById,
  getByPort,
  getByProcessName,
  getAll,
  getSniffable,
  register,
  registerAll
}
