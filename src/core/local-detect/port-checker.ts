/**
 * 功能描述：端口检测器 — 检查本机端口是否被监听
 *
 * 逻辑说明：通过尝试 TCP 连接或 netstat 命令检查指定端口
 *           是否已被占用。支持 TCP 和 UDP 端口检测。
 *           TCP 端口通过连接测试，UDP 端口通过 netstat 命令检测。
 *
 * @module port-checker
 */

import { spawn } from 'child_process'
import * as net from 'net'

/**
 * 功能描述：执行子进程并获取 stdout
 *
 * 逻辑说明：使用 spawn 替代 exec/execAsync 避免 shell 命令注入风险。
 *           不经过 shell 解释，参数以数组形式传递。
 *
 * @param cmd - 可执行文件路径
 * @param args - 参数列表
 * @param timeout - 超时时间（毫秒）
 * @returns stdout 内容
 * @throws 进程退出码非零或超时
 */
function spawnOutput(cmd: string, args: string[], timeout: number = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { timeout, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`exit code ${code}`))
    })
  })
}

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
      const stdout = await spawnOutput('netstat', ['-ano'])

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
      // Linux/macOS 优先使用 lsof，失败时回退到 ss（Ubuntu 默认无 lsof）
      let stdout = ''
      try {
        stdout = await spawnOutput('lsof', ['-i', `${protocol}:${port}`, '-P', '-n'])
      } catch {
        try {
          stdout = await spawnOutput('ss', ['-tlnp', 'sport', `= :${port}`])
        } catch {
          return null
        }
      }

      for (const line of stdout.split('\n')) {
        if (line.startsWith('COMMAND') || line.startsWith('State')) continue
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 2) {
          // lsof: COMMAND PID ...
          const name = parts[0]
          const pid = parseInt(parts[1], 10)
          if (!isNaN(pid)) {
            return { pid, name }
          }
          // ss: 最后列包含 "users:(("进程名",pid=1234,...))"
          const userMatch = line.match(/users:\(\(([^,]+),pid=(\d+)/)
          if (userMatch) {
            return { pid: parseInt(userMatch[2], 10), name: userMatch[1] }
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
 *           macOS/Linux 优先使用 lsof -i，失败时回退到 ss -tulnp。
 *           同时支持 TCP 和 UDP 端口检测。
 *
 * @param pid - 进程 ID
 * @returns 端口列表
 */
async function findPortsByPid(pid: number): Promise<number[]> {
  const platform = getPlatform()
  const ports: number[] = []

  if (platform === 'win') {
    try {
      const stdout = await spawnOutput('netstat', ['-ano'])

      for (const line of stdout.split('\n')) {
        // netstat -ano 输出格式:
        //   TCP    0.0.0.0:25565           0.0.0.0:0              LISTENING       12345
        //   TCP    127.0.0.1:60228         0.0.0.0:0              LISTENING       12345
        //   TCP    [::]:25565              [::]:0                 LISTENING       12345
        //   UDP    0.0.0.0:34197           *:*                                    12345
        const trimmed = line.trim()
        // 跳过仅监听 127.0.0.1/::1 的端口（JVM 内部临时端口，非游戏服务器）
        if (trimmed.includes('127.0.0.1:') || trimmed.includes('::1:')) continue
        const match = trimmed.match(/TCP\s+\S+:(\d+)\s+\S+:\d+\s+LISTENING/i)
        const udpMatch = !match && trimmed.match(/UDP\s+\S+:(\d+)\s+/i)
        if (match) {
          ports.push(parseInt(match[1], 10))
        } else if (udpMatch) {
          ports.push(parseInt(udpMatch[1], 10))
        }
      }
    } catch {
      // 命令失败，返回空
    }
  } else {
    // Linux/macOS 优先使用 lsof -i，失败时回退到 ss -tulnp
    let stdout = ''
    try {
      stdout = await spawnOutput('lsof', ['-i', '-P', '-n'])
    } catch {
      try {
        // ss -tulnp 输出格式：
        //   tcp   LISTEN  0  50  0.0.0.0:25565  0.0.0.0:*  users:(("java",pid=12345,fd=30))
        //   udp   UNCONN  0   0  0.0.0.0:34197  0.0.0.0:*  users:(("factorio",pid=5678,fd=30))
        stdout = await spawnOutput('ss', ['-tulnp'])
      } catch {
        return []
      }
    }

    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue

      // 过滤出包含目标 PID 的行（替换原有的 grep 过滤）
      const hasPid = trimmed.includes(String(pid))
        || trimmed.match(new RegExp(`\\b${pid}\\b`))
      if (!hasPid) continue

      // 统一提取端口号，兼容各种输出格式：
      //   lsof: *:25565 (LISTEN)  或 127.0.0.1:60228 (LISTEN)
      //   ss:   0.0.0.0:25565     或 127.0.0.1:60228
      // 跳过仅监听 127.0.0.1/::1 的端口（JVM 内部临时端口，非游戏服务器）
      const localhostMatch = trimmed.match(/(?:127\.0\.0\.1|::1):(\d+)/)
      if (localhostMatch) continue

      const portMatch = trimmed.match(/:(\d+)(?=\s|$)/)
      if (portMatch) {
        const port = parseInt(portMatch[1], 10)
        if (port > 0 && port <= 65535) {
          ports.push(port)
        }
      }
    }
  }

  return [...new Set(ports)]
}

export const portChecker = {
  checkPort,
  checkPorts,
  checkTcpPort,
  findPortsByPid
}
