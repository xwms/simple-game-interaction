/**
 * 功能描述：本地游戏检测 composable — 检测本机运行的游戏
 */

export function useGameDetect() {
  /**
   * 功能描述：检测本机运行的局域网联机游戏
   *
   * @returns 游戏列表
   */
  async function detectLocalGames() {
    const result = await window.electronAPI.invoke('game:detect-local')
    return result.success ? result.data : []
  }

  return { detectLocalGames }
}
