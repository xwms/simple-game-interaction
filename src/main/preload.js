/**
 * 功能描述：预加载脚本 — 通过 contextBridge 安全暴露 IPC API 给渲染进程
 *
 * 逻辑说明：使用 contextBridge.exposeInMainWorld 在 window.electronAPI 上
 *           暴露 IPC 调用方法。所有通信走白名单通道，渲染进程无法直接调用
 *           ipcRenderer.send。
 *
 * 安全说明：contextIsolation: true 下，渲染进程无法访问 Node.js 或 Electron API。
 *           本脚本是唯一暴露通道，所有通道名在 CHANNEL_WHITELIST 中枚举。
 */

'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * 白名单 IPC 通道 — 渲染进程只能调用这些通道
 */
const CHANNEL_WHITELIST = [
  // LAN 发现
  'lan:start-scan',
  'lan:stop-scan',
  'lan:scan-result',

  // 游戏检测
  'game:detect-local',
  'game:detect-result',
  'game:check-port',

  // 房间
  'room:create',
  'room:join',
  'room:leave',
  'room:info',
  'room:member-joined',
  'room:member-left',

  // 隧道/连接
  'tunnel:status',
  'tunnel:start',
  'tunnel:stop',
  'tunnel:error',
  'tunnel:traffic',
  'tunnel:connected',
  'tunnel:transport-changed',
  'tunnel:latency',
  // 网络检测
  'network:detect',
  'network:detect-result',

  // 更新
  'update:check',
  'update:available',
  'update:download',
  'update:start-download',
  'update:download-progress',
  'update:download-complete',
  'update:download-error',
  'update:install',

  // 日志
  'log:info',
  'log:error',
  'log:cleanup',
  'log:delete-all',

  // 通用
  'app:get-version',
  'app:get-platform',
  'app:open-external',
  'app:theme-changed',
  'app:confirm-disconnect',
  'app:open-log-file',
  'app:open-log-dir',
  'app:select-log-directory',
  'app:set-log-file-path',
  'app:set-close-behavior',

  // 背景图片
  'app:background-select',

  // 窗口控制
  'window:minimize',
  'window:close'
]

contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * 功能描述：向主进程发送消息（双向通信）
   *
   * @param {string} channel - IPC 通道名（必须在白名单中）
   * @param {...*} args - 参数列表
   * @returns {Promise<*>} 主进程返回的结果
   */
  invoke(channel, ...args) {
    if (!CHANNEL_WHITELIST.includes(channel)) {
      return Promise.reject(new Error(`IPC channel "${channel}" is not allowed`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },

  /**
   * 功能描述：监听主进程发送的消息
   *
   * @param {string} channel - IPC 通道名
   * @param {Function} callback - 消息回调函数
   */
  on(channel, callback) {
    if (!CHANNEL_WHITELIST.includes(channel)) {
      console.error(`IPC channel "${channel}" is not allowed`)
      return
    }
    const handler = (_event, ...args) => callback(...args)
    ipcRenderer.on(channel, handler)

    // 返回取消监听的函数
    return () => {
      ipcRenderer.removeListener(channel, handler)
    }
  }
})
