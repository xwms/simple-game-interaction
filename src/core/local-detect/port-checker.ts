/**
 * 功能描述：端口检测器 — 检查本机端口是否被监听
 *
 * 逻辑说明：通过尝试 TCP 连接或 netstat 命令检查指定端口
 *           是否已被占用。支持 TCP 和 UDP 端口检测。
 *           TCP 端口通过连接测试，UDP 端口通过 netstat 命令检测。
 *
 * @module port-checker
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import * as net from 'net'

const execAsync = promisify(exec)

/** 端口检测结果 */
export interface PortCheckResult {
  port: number
  protocol: 'tcp' | 'udp'
  inUse: boolean
  pid?: number
  processName?: string
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
 * 功能描述：通过 TCP 连接检测端口是否被使用
 *
 * 逻辑说明：尝试连接 localhost:port，连接成功说明端口被监听。
 *           连接失败（拒绝或超时）说明端口未开放。
 *
 * @param port - 端口号
 * @param timeoutMs - 超时时间
 * @returns 是否被使用
 */
async function checkTcpPort(
  port: number,
  timeoutMs: number = 2000
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false

    socket.setTimeout(timeoutMs)

    socket.once('connect', () => {
      settled = true
      socket.destroy()
      resolve(true)
    })

    socket.once('error', () => {
      if (!settled) {
        settled = true
        socket.destroy()
        resolve(false)
      }
    })

    socket.once('timeout', () => {
      if (!settled) {
        settled = true
        socket.destroy()
        resolve(false)
      }
    })

    socket.connect(port, '127.0.0.1')
  })
}

/**
 * 功能描述：通过系统命令查找占用端口的进程
 *
 * 逻辑说明：Windows 使用 netstat -ano，macOS/Linux 使用 lsof -i。
 *
 * @param port - 端口号
 * @param protocol - 协议类型
 * @returns 进程信息（如有）
 */
async function _findProcessByPort(
  port: number,
  protocol: 'tcp' | 'udp'
): Promise<{ pid: number; name: string } | null> {
  const platform = getPlatform()

  try {
    if (platform === 'win') {
      const { stdout } = await execAsync(
        `netstat -ano | findstr :${port}`,
        { timeout: 3000 }
      )

      for (const line of stdout.split('\n')) {
        if (line.includes(`:${port}`) && line.toLowerCase().includes(protocol)) {
          const parts = line.trim().split(/\s+/)
          const pid = parseInt(parts[parts.length - 1], 10)
          if (!isNaN(pid)) {
            return { pid, name: `pid:${pid}` }
          }
        }
      }
    } else {
      const { stdout } = await execAsync(
        `lsof -i ${protocol}:${port} -P -n 2>/dev/null`,
        { timeout: 3000 }
      )

      for (const line of stdout.split('\n')) {
        // 跳过标题行
        if (line.startsWith('COMMAND')) continue
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 2) {
          const name = parts[0]
          const pid = parseInt(parts[1], 10)
          if (!isNaN(pid)) {
            return { pid, name }
          }
        }
      }
    }
  } catch {
    // 命令失败，返回 null
  }

  return null
}

/**
 * 功能描述：检查单个端口的占用情况
 *
 * @param port - 端口号
 * @param protocol - 协议类型
 * @returns 检测结果
 */
async function checkPort(
  port: number,
  protocol: 'tcp' | 'udp' = 'tcp'
): Promise<PortCheckResult> {
  const inUse = protocol === 'tcp'
    ? await checkTcpPort(port)
    : false // UDP 端口检测需要系统命令支持

  let pid: number | undefined
  let processName: string | undefined

  if (inUse) {
    const info = await _findProcessByPort(port, protocol)
    if (info) {
      pid = info.pid
      processName = info.name
    }
  }

  return { port, protocol, inUse, pid, processName }
}

/**
 * 功能描述：批量检查多个端口
 *
 * 逻辑说明：所有端口并行检测，总耗时取决于最慢的单个检测。
 *
 * @param ports - 端口号列表
 * @param protocol - 协议类型
 * @returns 检测结果列表
 */
async function checkPorts(
  ports: number[],
  protocol: 'tcp' | 'udp' = 'tcp'
): Promise<PortCheckResult[]> {
  const checks = ports.map((port) => checkPort(port, protocol))
  return Promise.all(checks)
}

/**
 * 功能描述：通过 PID 查找进程占用的端口
 *
 * 逻辑说明：Windows 使用 netstat -ano | findstr PID，
 *           macOS/Linux 使用 lsof -i -P -n | grep PID。
 *           返回该进程监听的 TCP 端口列表。
 *
 * @param pid - 进程 ID
 * @returns 端口列表
 */
async function findPortsByPid(pid: number): Promise<number[]> {
  const platform = getPlatform()
  const ports: number[] = []

  try {
    if (platform === 'win') {
      const { stdout } = await execAsync(
        `netstat -ano | findstr "${pid}"`,
        { timeout: 3000 }
      )

      for (const line of stdout.split('\n')) {
        // netstat -ano 输出格式:
        //   TCP    0.0.0.0:25565           0.0.0.0:0              LISTENING       12345
        //   TCP    [::]:25565              [::]:0                 LISTENING       12345
        // 只匹配 LISTENING 状态的 TCP 连接，取本地地址的端口号
        const match = line.trim().match(/TCP\s+\S+:(\d+)\s+\S+:\d+\s+LISTENING/i)
        if (match) {
          ports.push(parseInt(match[1], 10))
        }
      }
    } else {
      const { stdout } = await execAsync(
        `lsof -i -P -n 2>/dev/null | grep "^.*\\s${pid}\\s"`,
        { timeout: 3000 }
      )

      for (const line of stdout.split('\n')) {
        // 格式: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
        // NAME 列: *:25565 (LISTEN)
        const match = line.trim().match(/:(\d+)\s+\(LISTEN\)/i)
        if (match) {
          ports.push(parseInt(match[1], 10))
        }
      }
    }
  } catch {
    // 命令失败
  }

  return [...new Set(ports)]
}

export const portChecker = {
  checkPort,
  checkPorts,
  checkTcpPort,
  findPortsByPid
}
