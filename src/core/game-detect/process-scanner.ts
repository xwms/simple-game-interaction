/**
 * 功能描述：跨平台进程扫描器 — 通过系统命令检测正在运行的进程
 *
 * 逻辑说明：根据操作系统使用不同的系统命令枚举进程列表。
 *           Windows 使用 tasklist，macOS/Linux 使用 ps。
 *           匹配进程名时忽略大小写和 .exe 后缀。
 *           异步非阻塞，不阻塞主进程。
 *
 * @module process-scanner
 */

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

/** 进程信息 */
export interface ProcessInfo {
  pid: number
  name: string
}

/**
 * 功能描述：获取当前平台类型
 *
 * @returns 平台标识
 */
function getPlatform(): 'win' | 'mac' | 'linux' {
  if (process.platform === 'win32') return 'win'
  if (process.platform === 'darwin') return 'mac'
  return 'linux'
}

/**
 * 功能描述：使用 tasklist 枚举 Windows 进程
 *
 * @returns 进程列表
 */
async function _listWindowsProcesses(): Promise<ProcessInfo[]> {
  const { stdout } = await execAsync('tasklist /NH /FO CSV', {
    timeout: 5000
  })

  const processes: ProcessInfo[] = []

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // CSV 格式: "image name","pid","session name","session#","mem usage"
    const match = trimmed.match(/"([^"]+)","(\d+)"/)
    if (match) {
      processes.push({
        name: match[1].toLowerCase(),
        pid: parseInt(match[2], 10)
      })
    }
  }

  return processes
}

/**
 * 功能描述：使用 ps 枚举 macOS/Linux 进程
 *
 * @returns 进程列表
 */
async function _listUnixProcesses(): Promise<ProcessInfo[]> {
  const { stdout } = await execAsync('ps -eo pid,comm --no-headers 2>/dev/null || ps -eo pid,comm', {
    timeout: 5000
  })

  const processes: ProcessInfo[] = []

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const parts = trimmed.split(/\s+/)
    if (parts.length >= 2) {
      const pid = parseInt(parts[0], 10)
      if (!isNaN(pid)) {
        processes.push({
          pid,
          name: parts[parts.length - 1].toLowerCase()
        })
      }
    }
  }

  return processes
}

/**
 * 功能描述：获取系统当前所有进程列表
 *
 * @returns 进程列表
 */
async function listProcesses(): Promise<ProcessInfo[]> {
  const platform = getPlatform()
  if (platform === 'win') {
    return _listWindowsProcesses()
  }
  return _listUnixProcesses()
}

/**
 * 功能描述：查找匹配名称的进程
 *
 * 逻辑说明：模糊匹配进程名，忽略大小写和 .exe 后缀。
 *           支持部分匹配（如 'java' 匹配 'javaw.exe'）。
 *
 * @param nameOrPattern - 进程名或部分名称
 * @returns 匹配的进程列表
 */
async function findProcesses(nameOrPattern: string): Promise<ProcessInfo[]> {
  const pattern = nameOrPattern.toLowerCase().replace(/\.exe$/, '')
  const processes = await listProcesses()

  return processes.filter((p) => p.name.includes(pattern))
}

/**
 * 功能描述：检查指定进程名是否正在运行
 *
 * @param processName - 进程名
 * @returns 是否运行中
 */
async function isRunning(processName: string): Promise<boolean> {
  const matches = await findProcesses(processName)
  return matches.length > 0
}

export const processScanner = {
  listProcesses,
  findProcesses,
  isRunning
}
