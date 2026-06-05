/**
 * 功能描述：IPC 通道注册 — 桥接渲染进程与核心引擎
 *
 * 逻辑说明：使用 ipcMain.handle 注册所有 IPC 通道，每个处理函数接收
 *           event 和 args，处理后返回结果给渲染进程。所有通道返回
 *           { success, data/error } 统一格式。
 *
 * @module ipc-handlers
 */

'use strict'

const { ipcMain, app, shell } = require('electron')

/**
 * 功能描述：注册所有 IPC 通道
 */
function registerIpcHandlers() {
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
      const { NetworkDetector } = require('@core/network-detect/detector')
      const detector = new NetworkDetector()
      const result = await detector.detect()
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  // ─── 房间 ───────────────────────────────────────────

  ipcMain.handle('room:create', async (_event, options) => {
    try {
      // TODO: 实现房间创建逻辑
      return { success: true, data: { roomCode: '------', status: 'created' } }
    } catch (err) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('room:join', async (_event, roomCode) => {
    try {
      // TODO: 实现加入房间逻辑
      return { success: true, data: { status: 'connecting' } }
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

  // ─── 日志 ───────────────────────────────────────────

  ipcMain.handle('log:info', (_event, message) => {
    console.log(`[Renderer] ${message}`)
    return { success: true }
  })

  ipcMain.handle('log:error', (_event, message) => {
    console.error(`[Renderer] ${message}`)
    return { success: true }
  })

  // ─── 预留通道桩 ────────────────────────────────────
  // LAN 扫描和游戏检测通道将在实现后完善

  ipcMain.handle('lan:start-scan', async () => {
    return { success: true, data: { status: 'scanning' } }
  })

  ipcMain.handle('lan:stop-scan', async () => {
    return { success: true, data: { status: 'stopped' } }
  })
}

module.exports = { registerIpcHandlers }
