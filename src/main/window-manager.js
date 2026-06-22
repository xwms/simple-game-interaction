/**
 * 功能描述：窗口管理器 — 创建和管理 Electron 主窗口
 *
 * 逻辑说明：创建 BrowserWindow，配置 webPreferences（contextIsolation + preload），
 *           开发环境加载 Vite dev server，生产环境加载打包后的 index.html。
 *           窗口最小化时隐藏到托盘（非 macOS）。
 *
 * @module window-manager
 */

'use strict'

const { BrowserWindow, session } = require('electron')
const path = require('path')

const isDev = !require('electron').app.isPackaged

/** @type {BrowserWindow|null} */
let mainWindow = null

/**
 * 功能描述：创建主窗口
 *
 * 逻辑说明：设置窗口大小、最小尺寸、frame: false 自定义标题栏、preload 脚本路径。
 *           开发环境加载 http://localhost:5173，生产加载 dist/renderer/index.html。
 */
/**
 * 功能描述：设置 Content-Security-Policy
 *
 * 逻辑说明：开发环境放宽 CSP（Vite HMR 需要 unsafe-eval），
 *           生产环境使用严格 CSP。
 */
function setCsp() {
  const cspDirectives = isDev
    ? [
        "default-src 'self'",
        "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self' ws://localhost:* http://localhost:* ws://159.75.150.37:* ws://159.75.150.37:*",
        "font-src 'self' data:"
      ]
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self' ws://159.75.150.37:* ws://159.75.150.37:*",
        "font-src 'self' data:"
      ]

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspDirectives.join('; ')]
      }
    })
  })
}

function createWindow() {
  // 设置 CSP（必须在加载页面之前）
  setCsp()

  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 720,
    minHeight: 500,
    title: 'SGI',
    show: false,
    frame: false,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 窗口准备好后再显示，避免白屏闪烁
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'
    mainWindow.loadURL(devUrl)
    // 在测试环境下不打开 DevTools，避免干扰 E2E 测试
    if (process.env.NODE_ENV !== 'test') {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 根据设置决定关闭行为：退出或隐藏到托盘
  mainWindow.on('close', (event) => {
    if (global._isQuitting || global._closeBehavior === 'quit') {
      return
    }
    event.preventDefault()
    mainWindow.hide()
  })
}

/**
 * 功能描述：显示主窗口（从托盘恢复）
 */
function showMainWindow() {
  if (mainWindow === null) {
    createWindow()
  } else {
    mainWindow.show()
    mainWindow.focus()
  }
}

module.exports = { createWindow, showMainWindow }
