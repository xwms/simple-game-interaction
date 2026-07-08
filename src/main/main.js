/**
 * 功能描述：Electron 主进程入口 — 创建应用窗口，注册 IPC，管理生命周期
 *
 * 逻辑说明：1) 应用准备就绪后创建主窗口；2) 注册所有 IPC 通道；3) 管理窗口生命周期，
 *           macOS 下保持 activate 事件处理。窗口关闭时判断平台决定是否退出。
 *
 * @module main
 */

'use strict'

const { app, BrowserWindow } = require('electron')
const path = require('path')
const { createWindow, showMainWindow } = require('./window-manager')
const { registerIpcHandlers } = require('./ipc-handlers')
const { createTray } = require('./tray')
const { createMenu } = require('./menu')

// 开发环境下加载 Vite dev server URL
const isDev = !app.isPackaged

// 开发模式下抑制 Electron CSP 安全警告
// Vite HMR 需要 'unsafe-eval'，属于开发环境预期行为，生产环境有严格 CSP
if (isDev) {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
}

// Linux 下禁用 Chromium sandbox（electron-builder 打包后需 --no-sandbox 才能启动）
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox')
}

/**
 * 功能描述：应用启动入口
 *
 * 逻辑说明：按顺序执行：配置日志文件 → 创建菜单 → 注册 IPC → 创建窗口 → 创建托盘。
 *           macOS 下 app.dock 在创建窗口前显示。
 */

// 单实例锁：防止启动多个实例
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  function bootstrap() {
  // 配置日志文件路径和级别
  const { setLogFilePath, setProduction } = require('../core/utils/logger')
  setLogFilePath(path.join(app.getPath('userData'), 'logs', 'app.log'))
  setProduction(false) // debug 模式：打包后也输出 debug 日志

  createMenu()
  registerIpcHandlers()
  createWindow()
  createTray(showMainWindow)

  if (isDev) {
    const { initUpdater } = require('./updater')
    initUpdater()
  }
}

app.whenReady().then(() => {
  bootstrap()

  app.on('activate', () => {
    // macOS: 点击 Dock 图标时如果没有窗口则重建
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})
}

app.on('window-all-closed', () => {
  // macOS 下不退出应用（保持 Dock 图标）
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  global._isQuitting = true
  // 清理系统托盘
  const { getTray } = require('./tray')
  const tray = getTray()
  if (tray) {
    tray.destroy()
  }
})

// 退出前自动离开房间，通知中继服务器清理状态
app.on('will-quit', () => {
  const { cleanupTunnel } = require('./ipc-handlers')
  cleanupTunnel().catch(() => {})
})
