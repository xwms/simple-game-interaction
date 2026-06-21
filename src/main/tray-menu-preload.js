/**
 * 功能描述：托盘菜单预加载脚本 — 注册菜单点击事件和注入 iconfont 样式
 *
 * 逻辑说明：在 DOMContentLoaded 时注入 iconfont CSS 并注册菜单项的点击事件。
 *           通过 ipcRenderer.send 直接通知主进程，无需 contextBridge 暴露给页面脚本。
 *           CSS 路径根据运行环境（开发/生产）自动选择正确的 iconfont 位置。
 *
 * @module tray-menu-preload
 */

'use strict'

const { ipcRenderer } = require('electron')

window.addEventListener('DOMContentLoaded', () => {
  // ─── 注入 iconfont 样式（仅开发环境） ──────────
  // HTML 中的 <link href="iconfont/iconfont.css"> 在生产环境正常工作，
  // 但在开发环境中相对路径指向 src/main/iconfont/ 不存在，
  // 需要从 src/renderer/assets/iconfont/ 加载
  const isDev = __dirname.includes('\\src\\') || __dirname.includes('/src/')
  if (isDev) {
    const basePath = __dirname.replace(/\\/g, '/')
    const filePrefix = basePath.startsWith('/') ? 'file://' : 'file:///'
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = `${filePrefix}${basePath}/../renderer/assets/iconfont/iconfont.css`
    document.head?.appendChild(link)
  }

  // ─── 注册菜单项点击事件 ──────────────────────────
  document.getElementById('action-show')?.addEventListener('click', () => {
    ipcRenderer.send('tray-menu:action', 'show')
  })
  document.getElementById('action-disconnect')?.addEventListener('click', () => {
    ipcRenderer.send('tray-menu:action', 'disconnect')
  })
  document.getElementById('action-quit')?.addEventListener('click', () => {
    ipcRenderer.send('tray-menu:action', 'quit')
  })
})
