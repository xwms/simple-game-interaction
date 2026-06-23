#!/usr/bin/env node

/**
 * 功能描述：中继服务器 CLI 入口
 *
 * 逻辑说明：加载配置 → 初始化 MemoryStore → 启动 WebSocket 中继服务
 *          → 启动 HTTP 管理 API → 注册信号处理 → 优雅关闭。
 */

import { loadConfig, printConfig } from './config'
import { MemoryStore } from './store/memory-store'
import { RelayServer } from './server'
import { AdminServer } from './admin/http-server'
import { nowISO } from './utils'

async function main(): Promise<void> {
  // ─── 配置加载 ───────────────────────
  const config = loadConfig()
  printConfig(config)

  // ─── 存储初始化 ─────────────────────
  const store = new MemoryStore()

  // ─── 中继服务启动 ───────────────────
  const server = new RelayServer(store, config)

  // ─── 管理 API 启动 ──────────────────
  const admin = new AdminServer()
  try {
    admin.start(config, server, store)
  } catch (err) {
    console.log(JSON.stringify({
      time: nowISO(), level: 'warn', module: 'main',
      msg: 'Admin server failed to start (non-fatal)', error: (err as Error).message
    }))
  }

  process.on('SIGTERM', () => handleShutdown(server, admin))
  process.on('SIGINT', () => handleShutdown(server, admin))

  await server.start()

  console.log(JSON.stringify({
    time: nowISO(), level: 'info', module: 'main',
    msg: `Relay server ready on ${config.host}:${config.port}`
  }))
}

/**
 * 功能描述：优雅关闭处理器
 *
 * 逻辑说明：收到 SIGTERM/SIGINT 后先停止接受新连接，
 *           通知所有房间成员，然后退出进程。
 *           等待超时（10s）后强制退出。
 */
async function handleShutdown(server: RelayServer, admin: AdminServer): Promise<void> {
  console.log(JSON.stringify({
    time: nowISO(), level: 'info', module: 'main',
    msg: 'Received shutdown signal, starting graceful shutdown...'
  }))

  try { admin.stop() } catch { /* admin may not have started */ }

  const forceExit = setTimeout(() => {
    console.log(JSON.stringify({
      time: nowISO(), level: 'warn', module: 'main',
      msg: 'Forced shutdown after timeout'
    }))
    process.exit(1)
  }, 10000)

  try {
    await server.stop()
    clearTimeout(forceExit)
    process.exit(0)
  } catch (err) {
    console.log(JSON.stringify({
      time: nowISO(), level: 'error', module: 'main',
      msg: 'Shutdown error', error: (err as Error).message
    }))
    clearTimeout(forceExit)
    process.exit(1)
  }
}

main().catch(err => {
  console.error(JSON.stringify({
    time: nowISO(), level: 'error', module: 'main',
    msg: 'Failed to start server', error: (err as Error).message
  }))
  process.exit(1)
})
