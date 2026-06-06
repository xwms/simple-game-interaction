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
 * 逻辑说明：遍历游戏数据库，检查每个游戏的进程是否运行。
 *           如果进程运行，自动查找该进程实际监听的端口。
 *           仅当进程运行且实际端口开放时才标记为检测到。
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
    const pid = allMatches[0]?.pid
    const processName = allMatches[0]?.name

    let detectedPort = game.defaultPort
    let portOpen = false

    if (pid !== undefined) {
      // 通过 PID 查找进程实际监听的端口（最准确）
      const actualPorts = await portChecker.findPortsByPid(pid)
      if (actualPorts.length > 0) {
        detectedPort = actualPorts[0]
        portOpen = true
      }
    } else {
      // 没有找到进程，回退到默认端口检测（可能是无头服务器）
      const portsToCheck = [game.defaultPort, ...(game.altPorts || [])]
      const portResults = await portChecker.checkPorts(portsToCheck, game.protocol)
      const openPort = portResults.find((p) => p.inUse)
      if (openPort) {
        detectedPort = openPort.port
        portOpen = true
      }
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
  const pid = allMatches[0]?.pid
  const processName = allMatches[0]?.name

  let detectedPort = game.defaultPort
  let portOpen = false

  if (pid !== undefined) {
    const actualPorts = await portChecker.findPortsByPid(pid)
    if (actualPorts.length > 0) {
      detectedPort = actualPorts[0]
      portOpen = true
    }
  }

  if (!portOpen) {
    const portsToCheck = [game.defaultPort, ...(game.altPorts || [])]
    const portResults = await portChecker.checkPorts(portsToCheck, game.protocol)
    const openPort = portResults.find((p) => p.inUse)
    if (openPort) {
      detectedPort = openPort.port
      portOpen = true
    }
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
