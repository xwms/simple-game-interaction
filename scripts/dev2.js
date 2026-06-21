'use strict'

const { spawn, exec } = require('child_process')
const path = require('path')
const http = require('http')
const net = require('net')

const ROOT = path.join(__dirname, '..')
const VITE_PORT = 5174
const VITE_DEV_URL = `http://localhost:${VITE_PORT}`

/**
 * 功能描述：清理指定端口上的残留进程
 *
 * 逻辑说明：Windows 上用 netstat + taskkill，非 Windows 上用 lsof + kill。
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
      for (const line of stdout.trim().split('\n')) {
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

function waitForVite(viteProcess) {
  return new Promise((resolve, reject) => {
    const maxAttempts = 30
    let attempts = 0

    const check = () => {
      if (viteProcess.exitCode !== null) {
        reject(new Error(`Vite process exited prematurely with code ${viteProcess.exitCode}`))
        return
      }
      attempts++
      const req = http.get(VITE_DEV_URL, (res) => {
        res.resume()
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
    console.error(`[dev2] Port ${VITE_PORT} is still in use.`)
    process.exit(1)
  }

  console.log('[dev2] Starting Vite dev server...')

  const vite = spawn('npx', ['vite'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env, NODE_ENV: 'development', VITE_DEV_SERVER_PORT: String(VITE_PORT) }
  })

  vite.stdout.pipe(process.stdout)
  vite.stderr.pipe(process.stderr)

  vite.on('error', (err) => {
    console.error('[dev2] Failed to start Vite:', err.message)
    process.exit(1)
  })

  try {
    await waitForVite(vite)
    console.log('[dev2] Vite dev server ready, starting Electron...')
  } catch (err) {
    console.error('[dev2]', err.message)
    vite.kill()
    process.exit(1)
  }

  const userDataDir = path.join(ROOT, '.dev2-userdata')
  const mainEntry = path.join(ROOT, 'src/main/main.js')
  const electron = spawn('npx', ['electron', mainEntry, '--user-data-dir', userDataDir], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      VITE_DEV_SERVER_URL: VITE_DEV_URL,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import tsx'].filter(Boolean).join(' ')
    }
  })

  electron.stdout.pipe(process.stdout)
  electron.stderr.pipe(process.stderr)

  electron.on('error', (err) => {
    console.error('[dev2] Failed to start Electron:', err.message)
    vite.kill()
    process.exit(1)
  })

  electron.on('close', (code) => {
    vite.kill()
    process.exit(code ?? 0)
  })

  vite.on('close', (code) => {
    electron.kill()
    process.exit(code ?? 0)
  })

  process.on('SIGINT', () => {
    console.log('\n[dev2] Shutting down...')
    vite.kill()
    electron.kill()
    process.exit(0)
  })
}

main()
