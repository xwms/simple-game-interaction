/**
 * 功能描述：协议嗅探器注册表 — 管理所有游戏嗅探器
 *
 * 逻辑说明：提供统一的嗅探器注册和查找机制。通过游戏 ID
 *           查找对应嗅探器，支持运行时注册新嗅探器。
 */

import type { GameProtocolSniffer } from './types'
import { minecraftSniffer } from './minecraft'
import { terrariaSniffer } from './terraria'
import { stardewValleySniffer } from './stardew-valley'
import { genericSniffer } from './generic'

// ─── 内置嗅探器 ─────────────────────────────────────────
const BUILT_IN_SNIFFERS: GameProtocolSniffer[] = [
  minecraftSniffer,
  terrariaSniffer,
  stardewValleySniffer,
  genericSniffer
]

const _sniffers: Map<string, GameProtocolSniffer> = new Map()

for (const sniffer of BUILT_IN_SNIFFERS) {
  _sniffers.set(sniffer.gameId, sniffer)
}

/**
 * 功能描述：获取指定游戏 ID 的嗅探器
 *
 * @param gameId - 游戏 ID
 * @returns 嗅探器实例，未找到返回 undefined
 */
function getSniffer(gameId: string): GameProtocolSniffer | undefined {
  return _sniffers.get(gameId)
}

/**
 * 功能描述：获取所有已注册的嗅探器
 *
 * @returns 嗅探器列表
 */
function getAllSniffers(): GameProtocolSniffer[] {
  return Array.from(_sniffers.values())
}

/**
 * 功能描述：注册自定义嗅探器
 *
 * @param sniffer - 嗅探器实例
 */
function registerSniffer(sniffer: GameProtocolSniffer): void {
  _sniffers.set(sniffer.gameId, sniffer)
}

export { getSniffer, getAllSniffers, registerSniffer }
export type { GameProtocolSniffer, SniffResult } from './types'
