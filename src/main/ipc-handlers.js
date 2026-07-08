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
const path = require('path')

/** @type {import('../core/tunnel/manager').TunnelManager|null} */
let _tunnelManager = null

/** @type {'light'|'dark'|'auto'} */
let _currentTheme = 'auto'

/**
 * 功能描述：清理隧道管理器（应用退出时调用）
 */
async function cleanupTunnel() {
  if (_tunnelManager) {
    try {
      await _tunnelManager.leaveRoom()
    } catch {
      // 退出清理忽略错误
    }
    _tunnelManager = null
  }
}

/**
 * 功能描述：注册所有 IPC 通道
 */
function registerIpcHandlers() {
  // ─── 日志转发（核心引擎 Logger → 渲染进程）────────────
  const { addLogForwarder } = require('../core/utils/logger')

  addLogForwarder((level, message) => {
    if (level === 'debug') return
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

  ipcMain.handle('app:open-external', async (_event, url) => {
    try {
      // 只允许 https 协议，防止 file:// 等协议被滥用
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:') {
        return { success: false, error: 'Only https URLs are allowed' }
      }
      await shell.openExternal(url)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('app:theme-changed', (_event, theme) => {
    // 存储主题供托盘菜单同步
    _currentTheme = theme
    return { success: true }
  })

  ipcMain.handle('app:open-log-file', async () => {
    const { getLogFilePath } = require('../core/utils/logger')
    const logPath = getLogFilePath() || path.join(app.getPath('userData'), 'logs', 'app.log')
    const err = await shell.openPath(logPath)
    if (err) {
      return { success: false, error: err }
    }
    return { success: true }
  })

  ipcMain.handle('app:open-log-dir', async () => {
    try {
      const { getLogFilePath } = require('../core/utils/logger')
      const logPath = getLogFilePath() || path.join(app.getPath('userData'), 'logs', 'app.log')
      shell.showItemInFolder(logPath)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('app:select-log-directory', async () => {
    const { dialog } = require('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择日志文件目录'
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: true, data: null }
    }
    return { success: true, data: result.filePaths[0] }
  })

  ipcMain.handle('app:set-close-behavior', (_event, behavior) => {
    if (behavior === 'quit' || behavior === 'hide') {
      global._closeBehavior = behavior
    }
  })

  /**
   * 功能描述：选择/加载背景图片
   *
   * 逻辑说明：无参数时打开文件选择对话框（支持 png/jpg/webp/gif），
   *           选择后读取文件转为 base64 data URL 返回。
   *           传入已有路径时直接读取该路径。
   *
   * @param {string} [existingPath] - 已保存的图片路径（可选）
   * @returns {Promise<{success: true, data: {path: string, dataUrl: string}}|{success: false}>}
   */
  ipcMain.handle('app:background-select', async (_event, existingPath) => {
    const fs = require('fs')
    const pathModule = require('path')
    let filePath = existingPath

    if (!filePath) {
      const { dialog } = require('electron')
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        title: '选择背景图片',
        filters: [
          { name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }
        ]
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: true, data: null }
      }
      filePath = result.filePaths[0]
    }

    // 校验路径：必须存在且是允许的图片格式
    const allowedExts = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']
    const ext = pathModule.extname(filePath).toLowerCase()
    if (!allowedExts.includes(ext)) {
      return { success: false, error: 'Unsupported image format' }
    }
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' }
    }

    try {
      const buffer = fs.readFileSync(filePath)
      const ext = pathModule.extname(filePath).slice(1).toLowerCase()
      const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif' }
      const mime = mimeMap[ext] || 'image/png'
      const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
      return { success: true, data: { path: filePath, dataUrl } }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('app:set-log-file-path', (_event, dirPath) => {
    const { setLogFilePath } = require('../core/utils/logger')
    if (dirPath) {
      setLogFilePath(path.join(dirPath, 'app.log'))
    } else {
      setLogFilePath(path.join(app.getPath('userData'), 'logs', 'app.log'))
    }
    return { success: true }
  })

  ipcMain.handle('app:confirm-disconnect', () => {
    // 转发给所有渲染进程，由 GlobalErrorWatcher 显示确认对话框
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send('app:confirm-disconnect')
      }
    })
    return { success: true }
  })

  // ─── 网络检测 ───────────────────────────────────────

  ipcMain.handle('network:detect', async () => {
    try {
      const { NetworkDetector } = require('../core/network/detector')
      const detector = new NetworkDetector()
      const result = await detector.detect()
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // ─── 房间 ───────────────────────────────────────────

  /**
   * 功能描述：获取或创建 TunnelManager 单例
   */
  function _getTunnelManager() {
    if (!_tunnelManager) {
      const { TunnelManager } = require('../core/tunnel/manager')
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

      _tunnelManager.on('latency', (rtt) => {
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('tunnel:latency', rtt)
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

  ipcMain.handle('room:join', async (_event, { roomCode, memberName, relayUrl, localPort }) => {
    const manager = _getTunnelManager()
    try {
      await manager.joinRoom(roomCode, relayUrl || undefined, localPort || 0)
      const status = await manager.getStatus()
      return { success: true, data: { status: 'connected', localPort: status.localPort } }
    } catch (err) {
      // joinRoom 失败时清理已建立的中继连接
      try { await manager.leaveRoom() } catch { /* ignore */ }
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

  ipcMain.handle('tunnel:status', async () => {
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

  ipcMain.handle('update:check', async (_event, options) => {
    try {
      const { checkForUpdates } = require('./updater')
      const result = await checkForUpdates(options?.currentVersion)
      return { success: true, data: result }
    } catch (err) {
      console.error(`[ipc] update:check 异常:`, err.message)
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('update:download', async (_event, downloadUrl, version) => {
    try {
      const { downloadUpdate, getUpdateDestPath, markDownloadComplete } = require('./updater')
      const destPath = getUpdateDestPath()

      const filePath = await downloadUpdate(downloadUrl, destPath, (percent) => {
        const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
        for (const win of wins) {
          win.webContents.send('update:download-progress', percent)
        }
      })

      markDownloadComplete(version)

      return { success: true, data: { filePath } }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  /**
   * 功能描述：后台下载更新（fire-and-forget）
   *
   * 逻辑说明：与 update:download 不同，本 handler 立即返回 success，
   *           下载在后台异步进行。进度/完成/错误通过 webContents.send 推送。
   *           渲染进程无需阻塞等待下载完成。
   */
  ipcMain.handle('update:start-download', (event, downloadUrl, version) => {
    const { downloadUpdate, getUpdateDestPath, markDownloadComplete } = require('./updater')
    const destPath = getUpdateDestPath()

    downloadUpdate(downloadUrl, destPath, (percent) => {
      const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
      for (const win of wins) {
        win.webContents.send('update:download-progress', percent)
      }
    }).then((filePath) => {
      markDownloadComplete(version)
      const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
      for (const win of wins) {
        win.webContents.send('update:download-complete', { filePath, version })
      }
    }).catch((err) => {
      const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
      for (const win of wins) {
        win.webContents.send('update:download-error', err.message)
      }
    })

    return { success: true }
  })

  ipcMain.handle('update:install', async (_event, filePath) => {
    try {
      const { installUpdate } = require('./updater')
      await installUpdate(filePath)
      return { success: true }
    } catch (err) {
      console.error(`[ipc] 安装失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: String(err) }
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

  ipcMain.handle('log:cleanup', (_event, retentionDays) => {
    const { cleanupLogFiles } = require('../core/utils/logger')
    const count = cleanupLogFiles(retentionDays)
    return { success: true, data: { deletedCount: count } }
  })

  ipcMain.handle('log:delete-all', () => {
    const { deleteAllLogFiles } = require('../core/utils/logger')
    const count = deleteAllLogFiles()
    return { success: true, data: { deletedCount: count } }
  })

  // ─── 窗口控制 ───────────────────────────────────────

  ipcMain.handle('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.minimize()
    return { success: true }
  })

  ipcMain.handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) win.close()
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
      const { detectLocalGames } = require('../core/local-detect/index')
      const results = await detectLocalGames()
      return { success: true, data: results }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('game:check-port', async (_event, port) => {
    try {
      const { portChecker } = require('../core/local-detect/port-checker')
      const result = await portChecker.checkTcpPort(port, 1000)
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })
}

/**
 * 功能描述：获取当前主题设置
 *
 * @returns {'light'|'dark'|'auto'}
 */
function getCurrentTheme() {
  return _currentTheme
}

module.exports = { registerIpcHandlers, cleanupTunnel, getCurrentTheme }
