/**
 * 功能描述：开发启动脚本 — 先启动 Vite dev server，再启动 Electron
 *
 * 逻辑说明：1) 检查端口 5173 是否已被占用（上次残留），如有则自动清理；
 *           2) 启动 Vite 子进程；
 *           3) 轮询等待 Vite 就绪，同时监测子进程存活状态（防止端口冲突导致 Vite 早退）；
 *           4) Vite 就绪后启动 Electron；
 *           5) 任一进程退出时结束整个流程。
 *
 * @module dev
 */

'use strict'

const { spawn, exec } = require('child_process')
const path = require('path')
const http = require('http')
const net = require('net')

const ROOT = path.join(__dirname, '..')
const VITE_PORT = 5173
const VITE_DEV_URL = `http://localhost:${VITE_PORT}`

/**
 * 功能描述：清理指定端口上的残留进程
 *
 * 逻辑说明：Windows 上用 netstat + taskkill，非 Windows 上用 lsof + kill。
 *           找不到进程或执行失败时静默返回，不阻塞启动流程。
 *
 * @param {number} port - 端口号
 */
function killPort(port) {
  return new Promise((resolve) => {
    const findCmd = process.platform === 'win32'
      ? `netstat -ano | findstr ":${port} " | findstr LISTEN`
      : `lsof -ti:${port}`

    exec(findCmd, { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve()

      const lines = stdout.trim().split('\n')
      for (const line of lines) {
        const pid = process.platform === 'win32'
          ? line.trim().split(/\s+/).pop()
          : line.trim()
        if (pid && /^\d+$/.test(pid)) {
          const killCmd = process.platform === 'win32'
            ? `taskkill /F /PID ${pid}`
            : `kill -9 ${pid}`
          exec(killCmd, { timeout: 3000 }, () => {})
        }
      }
      resolve()
    })
  })
}

/**
 * 功能描述：检查端口是否被占用
 *
 * 逻辑说明：尝试连接指定端口，连接成功说明端口被占用。
 *
 * @param {number} port - 端口号
 * @returns {Promise<boolean>} 是否被占用
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(true))
    server.once('listening', () => {
      server.close()
      resolve(false)
    })
    server.listen(port, '127.0.0.1')
  })
}

/**
 * 功能描述：等待 Vite dev server 就绪
 *
 * 逻辑说明：每隔 500ms 轮询 Vite dev server，直到收到 200 响应。
 *           每次轮询同时检查 Vite 子进程存活状态，若 Vite 已退出则提前中止。
 *           超时 15 秒后放弃。
 *
 * @param {import('child_process').ChildProcess} viteProcess - Vite 子进程
 * @returns {Promise<void>}
 * @throws {Error} 超时或 Vite 进程异常退出时抛出
 */
function waitForVite(viteProcess) {
  return new Promise((resolve, reject) => {
    const maxAttempts = 30
    let attempts = 0

    const check = () => {
      // Vite 进程已退出（如端口冲突、配置错误等）
      if (viteProcess.exitCode !== null) {
        reject(new Error(`Vite process exited prematurely with code ${viteProcess.exitCode}`))
        return
      }

      attempts++
      const req = http.get(VITE_DEV_URL, (res) => {
        res.resume() // 消费响应体，避免内存泄漏
        if (res.statusCode === 200) {
          resolve()
        } else if (attempts < maxAttempts) {
          setTimeout(check, 500)
        } else {
          reject(new Error('Vite dev server did not start in time'))
        }
      })

      req.on('error', () => {
        if (attempts < maxAttempts) {
          setTimeout(check, 500)
        } else {
          reject(new Error('Vite dev server did not start in time'))
        }
      })

      req.end()
    }

    check()
  })
}

async function main() {
  // 清理上次残留的 Vite 进程
  await killPort(VITE_PORT)

  // 二次确认端口已释放
  if (await isPortInUse(VITE_PORT)) {
    console.error(`[dev] Port ${VITE_PORT} is still in use.`)
    process.exit(1)
  }

  console.log('[dev] Starting Vite dev server...')

  // 启动 Vite（pipe 模式，避免子进程污染终端状态）
  const vite = spawn('npx', ['vite'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env, NODE_ENV: 'development' }
  })

  vite.stdout.pipe(process.stdout)
  vite.stderr.pipe(process.stderr)

  vite.on('error', (err) => {
    console.error('[dev] Failed to start Vite:', err.message)
    process.exit(1)
  })

  try {
    await waitForVite(vite)
    console.log('[dev] Vite dev server ready, starting Electron...')
  } catch (err) {
    console.error('[dev]', err.message)
    vite.kill()
    process.exit(1)
  }

  // 启动 Electron（pipe 模式，避免子进程污染终端状态）
  const electron = spawn('npx', ['electron', '.'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env, NODE_ENV: 'development', VITE_DEV_SERVER_URL: VITE_DEV_URL, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import tsx'].filter(Boolean).join(' ') }
  })

  electron.stdout.pipe(process.stdout)
  electron.stderr.pipe(process.stderr)

  electron.on('error', (err) => {
    console.error('[dev] Failed to start Electron:', err.message)
    vite.kill()
    process.exit(1)
  })

  // 任一进程退出时结束整个流程
  electron.on('close', (code) => {
    vite.kill()
    process.exit(code ?? 0)
  })

  vite.on('close', (code) => {
    electron.kill()
    process.exit(code ?? 0)
  })

  // 捕获 Ctrl+C，清理子进程
  process.on('SIGINT', () => {
    console.log('\n[dev] Shutting down...')
    vite.kill()
    electron.kill()
    process.exit(0)
  })
}

main()
