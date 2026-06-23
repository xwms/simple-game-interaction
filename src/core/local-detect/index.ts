/**
 * 功能描述：本地游戏检测模块统一导出
 *
 * 逻辑说明：聚合进程扫描器和端口检测器，提供一键检测本地
 *           游戏运行状态的接口。结合游戏数据库判断检测到的
 *           进程/端口对应哪款游戏。
 */

import { processScanner } from './process-scanner'
import { portChecker } from './port-checker'
import { gameDatabase } from '@core/discovery/game-db'
import type { GameDetectResult } from '@shared/types'

export { processScanner, portChecker }

/**
 * 功能描述：检测本机运行的所有已知游戏
 *
 * 逻辑说明：遍历游戏数据库，检查每个游戏关联的进程名是否运行。
 *           当匹配到进程时遍历所有匹配项，找到第一个实际有监听端口的进程（规避启动器
 *           等非服务端进程的干扰）。仅当进程运行且实际端口开放时才标记为检测到。
 *           不扫描固定端口——端口信息完全来自进程的实际监听状态。
 *
 * @returns 检测结果列表
 */
async function detectLocalGames(): Promise<GameDetectResult[]> {
  const games = gameDatabase.getAll()
  const results: GameDetectResult[] = []

  const checks = games.map(async (game) => {
    // 检查进程
    const processChecks = game.processNames.map((name) =>
      processScanner.findProcesses(name)
    )
    const processResults = await Promise.all(processChecks)
    const allMatches = processResults.flat()

    const running = allMatches.length > 0
    let pid: number | undefined
    let processName: string | undefined
    let detectedPort = game.defaultPort
    let portOpen = false

    // 遍历所有匹配的进程，取第一个实际在监听端口的
    // 避免 HMCL（Java 启动器）等非服务端进程的干扰
    for (const match of allMatches) {
      const actualPorts = await portChecker.findPortsByPid(match.pid)
      if (actualPorts.length > 0) {
        pid = match.pid
        processName = match.name
        detectedPort = actualPorts[0]
        portOpen = true
        break
      }
    }

    // 都没监听端口时仍记录首个匹配的进程（供 UI 显示）
    if (!portOpen && allMatches.length > 0) {
      pid = allMatches[0].pid
      processName = allMatches[0].name
    }

    return {
      gameId: game.id,
      name: game.name,
      running,
      portOpen,
      port: detectedPort,
      pid,
      processName
    }
  })

  const settled = await Promise.allSettled(checks)
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      results.push(result.value)
    }
  }

  return results
}

/**
 * 功能描述：检测指定游戏是否在本地运行
 *
 * @param gameId - 游戏 ID
 * @returns 检测结果，游戏未找到返回 null
 */
async function detectGame(gameId: string): Promise<GameDetectResult | null> {
  const game = gameDatabase.getById(gameId)
  if (!game) return null

  const processChecks = game.processNames.map((name) =>
    processScanner.findProcesses(name)
  )
  const processResults = await Promise.all(processChecks)
  const allMatches = processResults.flat()

  const running = allMatches.length > 0
  let pid: number | undefined
  let processName: string | undefined
  let detectedPort = game.defaultPort
  let portOpen = false

  for (const match of allMatches) {
    const actualPorts = await portChecker.findPortsByPid(match.pid)
    if (actualPorts.length > 0) {
      pid = match.pid
      processName = match.name
      detectedPort = actualPorts[0]
      portOpen = true
      break
    }
  }

  if (!portOpen && allMatches.length > 0) {
    pid = allMatches[0].pid
    processName = allMatches[0].name
  }

  return {
    gameId: game.id,
    name: game.name,
    running,
    portOpen,
    port: detectedPort,
    pid,
    processName
  }
}

export { detectLocalGames, detectGame }
