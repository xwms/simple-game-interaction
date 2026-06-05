/**
 * 功能描述：系统托盘管理 — 创建系统托盘图标和右键菜单
 *
 * 逻辑说明：创建 Tray 实例，设置右键菜单（显示窗口/退出），
 *           左键点击显示窗口，支持跨平台图标路径。
 *
 * @module tray
 */

'use strict'

const { Tray, Menu, app } = require('electron')
const path = require('path')

/** @type {Tray|null} */
let tray = null

/**
 * 功能描述：获取托盘实例
 *
 * @returns {Tray|null}
 */
function getTray() {
  return tray
}

/**
 * 功能描述：创建系统托盘
 *
 * 逻辑说明：根据平台选择图标格式（macOS: 16x16@2x, Windows: .ico, Linux: .png）。
 *           右键菜单含"显示窗口"和"退出"。
 *
 * @param {Function} showWindowFn - 显示主窗口的回调
 */
function createTray(showWindowFn) {
  const iconName = process.platform === 'darwin' ? 'tray-icon.png' : 'tray-icon.png'
  const iconPath = path.join(__dirname, '../../resources/icons', iconName)

  tray = new Tray(iconPath)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (showWindowFn) showWindowFn()
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit()
      }
    }
  ])

  tray.setToolTip('SGI — 局域网联机工具')
  tray.setContextMenu(contextMenu)

  // 左键/双击点击显示窗口
  tray.on('click', () => {
    if (showWindowFn) showWindowFn()
  })

  return tray
}

module.exports = { createTray, getTray }
