/**
 * 功能描述：系统托盘管理 — 创建系统托盘图标和自定义弹出菜单
 *
 * 逻辑说明：创建 Tray 实例，左键点击弹出自定义样式菜单（BrowserWindow）。
 *           菜单窗口为无边框弹窗，定位在托盘图标附近，失焦自动关闭。
 *           菜单使用 iconfont 图标。
 *
 * @module tray
 */

'use strict'

const { Tray, Menu, BrowserWindow, ipcMain, app, nativeTheme } = require('electron')
const path = require('path')

/** @type {Tray|null} */
let tray = null
/** @type {BrowserWindow|null} */
let menuWindow = null
/** @type {boolean} */
let _handlerRegistered = false
/** @type {Function|null} */
let _showWindowFn = null

/**
 * 功能描述：获取托盘实例
 *
 * @returns {Tray|null}
 */
function getTray() {
  return tray
}

/**
 * 功能描述：关闭弹出菜单
 */
function closeMenu() {
  if (menuWindow && !menuWindow.isDestroyed()) {
    menuWindow.close()
  }
  menuWindow = null
}

/**
 * 功能描述：创建托盘弹出菜单
 *
 * 逻辑说明：创建无边框 BrowserWindow，加载 tray-menu.html。
 *           窗口定位在托盘图标附近，失焦时自动关闭。
 */
function createTrayMenu() {
  if (menuWindow && !menuWindow.isDestroyed()) {
    closeMenu()
    return
  }

  const trayBounds = tray.getBounds()

  menuWindow = new BrowserWindow({
    width: 180,
    height: 50,
    x: Math.round(trayBounds.x + trayBounds.width / 2 - 90),
    y: Math.round(trayBounds.y + trayBounds.height + 4),
    frame: false,
    transparent: false,
    resizable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'tray-menu-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  menuWindow.loadFile(path.join(__dirname, 'tray-menu.html'))

  menuWindow.once('ready-to-show', () => {
    // 同步主窗口主题到菜单
    const { getCurrentTheme } = require('./ipc-handlers')
    const theme = getCurrentTheme()
    const isDark = theme === 'dark' || (theme === 'auto' && nativeTheme.shouldUseDarkColors)

    const p = isDark
      ? Promise.resolve()
      : menuWindow.webContents.executeJavaScript('document.body.classList.add("light")')

    p.then(() => {
      // 自适应内容高度
      return menuWindow.webContents.executeJavaScript('document.documentElement.scrollHeight')
    }).then((h) => {
      if (h > 0) menuWindow.setSize(180, Math.min(h, 400))
    }).catch(() => {})

    menuWindow.show()
    menuWindow.focus()
  })

  // 失焦关闭
  menuWindow.on('blur', () => {
    closeMenu()
  })

  menuWindow.on('closed', () => {
    menuWindow = null
  })
}

/**
 * 功能描述：注册 IPC 监听（仅一次）—— 处理菜单弹出窗口点击事件
 */
function _registerIpcHandler() {
  if (_handlerRegistered) return
  _handlerRegistered = true

  ipcMain.on('tray-menu:action', (_event, action) => {
    if (action === 'show') {
      if (_showWindowFn) _showWindowFn()
    } else if (action === 'disconnect') {
      // 弹出主窗口，由渲染进程显示确认对话框
      if (_showWindowFn) _showWindowFn()
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send('app:confirm-disconnect')
        }
      })
    } else if (action === 'quit') {
      app.quit()
    }

    closeMenu()
  })
}

/**
 * 功能描述：创建系统托盘
 *
 * 逻辑说明：根据平台选择图标格式（macOS: 16x16@2x, Windows: .ico, Linux: .png）。
 *           左键点击显示主窗口，右键点击弹出菜单。
 *           Linux 下右键使用原生 Menu.popup（自定义 BrowserWindow 菜单在 GNOME 上不可靠）。
 *
 * @param {Function} showWindowFn - 显示主窗口的回调
 */
function createTray(showWindowFn) {
  _showWindowFn = showWindowFn

  const iconName = 'icon.png'
  const iconPath = path.join(__dirname, '../../resources/icons', iconName)

  tray = new Tray(iconPath)
  tray.setToolTip('SGI — 局域网联机工具')

  // 左键点击显示主窗口
  tray.on('click', () => {
    if (_showWindowFn) _showWindowFn()
    closeMenu()
  })

  _registerIpcHandler()

  if (process.platform === 'linux') {
    // Linux: 使用原生菜单（兼容 GNOME/KDE）
    const contextMenu = Menu.buildFromTemplate([
      { label: '显示窗口', click: () => { if (_showWindowFn) _showWindowFn() } },
      { type: 'separator' },
      {
        label: '断开连接',
        click: () => {
          if (_showWindowFn) _showWindowFn()
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
              win.webContents.send('app:confirm-disconnect')
            }
          })
        }
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
    tray.setContextMenu(contextMenu)
  } else {
    // Windows/macOS: 使用自定义 BrowserWindow 菜单
    tray.on('right-click', () => {
      if (menuWindow && !menuWindow.isDestroyed()) {
        closeMenu()
      } else {
        createTrayMenu()
      }
    })
  }

  return tray
}

module.exports = { createTray, getTray }
