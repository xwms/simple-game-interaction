/**
 * 功能描述：IPC 通道注册 — 桥接渲染进程与核心引擎
 *
 * 逻辑说明：使用 ipcMain.handle 注册所有 IPC 通道，每个处理函数接收
 *           event 和 args，处理后返回结果给渲染进程。所有通道返回
 *           { success, data/error } 统一格式。
 *           同时注册 Logger 日志转发器，将核心引擎的日志广播到渲染进程。
 *
 * @module ipc-handlers
 */

'use strict'

const { ipcMain, app, shell, BrowserWindow } = require('electron')

/**
 * 功能描述：注册所有 IPC 通道
 */
function registerIpcHandlers() {
  // ─── 日志转发（核心引擎 Logger → 渲染进程）────────────
  const { addLogForwarder } = require('../core/utils/logger')

  addLogForwarder((_level, message) => {
    const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
    for (const win of wins) {
      win.webContents.send('log:info', message)
    }
  })

  // ─── 通用 ───────────────────────────────────────────

  ipcMain.handle('app:get-version', () => {
    return { success: true, data: app.getVersion() }
  })

  ipcMain.handle('app:get-platform', () => {
    return { success: true, data: process.platform }
  })

  ipcMain.handle('app:open-external', (_event, url) => {
    shell.openExternal(url)
    return { success: true }
  })

  // ─── 网络检测 ───────────────────────────────────────

  ipcMain.handle('network:detect', async () => {
    try {
      const { NetworkDetector } = require('../core/network-detect/detector')
      const detector = new NetworkDetector()
      const result = await detector.detect()
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // ─── 房间 ───────────────────────────────────────────

  /** @type {import('../core/tunnel/tunnel-manager').TunnelManager|null} */
  let _tunnelManager = null

  /**
   * 功能描述：获取或创建 TunnelManager 单例
   */
  function _getTunnelManager() {
    if (!_tunnelManager) {
      const { TunnelManager } = require('../core/tunnel/tunnel-manager')
      _tunnelManager = new TunnelManager()

      _tunnelManager.on('status', (status) => {
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('tunnel:status', status)
        })
      })

      _tunnelManager.on('traffic', (stats) => {
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('tunnel:traffic', stats)
        })
      })

      _tunnelManager.on('error', (err) => {
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('tunnel:error', { message: err.message })
        })
      })

      _tunnelManager.on('member-joined', (member) => {
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('room:member-joined', member)
        })
      })

      _tunnelManager.on('member-left', (data) => {
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('room:member-left', data)
        })
      })

      _tunnelManager.on('connected', (data) => {
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('tunnel:connected', data)
        })
      })

      _tunnelManager.on('transport-changed', (transportType) => {
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('tunnel:transport-changed', transportType)
        })
      })

    }
    return _tunnelManager
  }

  ipcMain.handle('room:create', async (_event, options) => {
    try {
      const manager = _getTunnelManager()
      const result = await manager.createRoom(options)
      return { success: true, data: { roomCode: result.roomCode, status: 'created' } }
    } catch (err) {
      console.error(`创建房间失败: ${err.message}`)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('room:join', async (_event, { roomCode, memberName }) => {
    try {
      const manager = _getTunnelManager()
      await manager.joinRoom(roomCode)
      const status = await manager.getStatus()
      return { success: true, data: { status: 'connected', localPort: status.localPort } }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('room:leave', async () => {
    try {
      if (_tunnelManager) {
        await _tunnelManager.leaveRoom()
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('room:info', async () => {
    try {
      if (_tunnelManager) {
        const status = await _tunnelManager.getStatus()
        return { success: true, data: status }
      }
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // ─── 隧道 ───────────────────────────────────────────

  ipcMain.handle('tunnel:start', async (_event, options) => {
    try {
      const manager = _getTunnelManager()
      const status = await manager.getStatus()
      return {
        success: true,
        data: { port: status.localPort, transport: status.transportType || 'relay' }
      }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('tunnel:stop', async () => {
    try {
      if (_tunnelManager) {
        await _tunnelManager.leaveRoom()
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // ─── 更新 ───────────────────────────────────────────

  ipcMain.handle('update:check', async () => {
    try {
      const { checkForUpdates } = require('./updater')
      const result = await checkForUpdates()
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // ─── 日志（渲染进程上报 → 统一格式后广播）───────────────

  function _formatLog(level, message) {
    const ts = new Date().toISOString()
    return `[${ts}] [${level}] [Renderer] ${message}`
  }

  function _broadcastLog(message) {
    const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
    for (const win of wins) {
      win.webContents.send('log:info', message)
    }
  }

  ipcMain.handle('log:info', (_event, message) => {
    const formatted = _formatLog('INFO', message)
    console.log(formatted)
    _broadcastLog(formatted)
    return { success: true }
  })

  ipcMain.handle('log:error', (_event, message) => {
    const formatted = _formatLog('ERROR', message)
    console.error(formatted)
    _broadcastLog(formatted)
    return { success: true }
  })

  // ─── LAN 扫描 ───────────────────────────────────────

  /** @type {import('../core/discovery/scanner').Scanner|null} */
  let _scanner = null

  ipcMain.handle('lan:start-scan', async () => {
    try {
      const { Scanner } = require('../core/discovery/scanner')
      if (!_scanner) {
        _scanner = new Scanner()
        _scanner.on('game-discovered', (event) => {
          // 向渲染进程推送发现的游戏
          BrowserWindow.getAllWindows().forEach((win) => {
            win.webContents.send('lan:scan-result', event)
          })
        })
      }
      await _scanner.start()
      return { success: true, data: { status: 'scanning' } }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('lan:stop-scan', async () => {
    try {
      if (_scanner) {
        _scanner.stop()
      }
      return { success: true, data: { status: 'stopped' } }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // ─── 本地游戏检测 ───────────────────────────────────

  ipcMain.handle('game:detect-local', async () => {
    try {
      const { detectLocalGames } = require('../core/game-detect/index')
      const results = await detectLocalGames()
      return { success: true, data: results }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}

module.exports = { registerIpcHandlers }
