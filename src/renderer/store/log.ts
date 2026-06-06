/**
 * 日志状态 Store
 *
 * 逻辑说明：接收主进程广播的 log:info IPC 消息，维护日志列表。
 *           上限 1000 条，超出时丢弃最早记录。
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'

const MAX_LOGS = 1000

export const useLogStore = defineStore('log', () => {
  // ─── 状态 ───────────────────────────────────────────
  const logs = ref<string[]>([])

  // ─── IPC 监听器（仅注册一次） ────────────────────────
  let _initialized = false
  let _removeListener: (() => void) | null = null

  function ensureListeners(): void {
    if (_initialized) return
    _initialized = true

    _removeListener = window.electronAPI.on('log:info', (message: unknown) => {
      const line = typeof message === 'string' ? message : String(message)
      logs.value.push(line)
      if (logs.value.length > MAX_LOGS) {
        logs.value.splice(0, logs.value.length - MAX_LOGS)
      }
    })
  }

  // ─── 方法 ───────────────────────────────────────────

  function clear(): void {
    logs.value = []
  }

  function destroy(): void {
    if (_removeListener) {
      _removeListener()
      _removeListener = null
    }
    _initialized = false
  }

  return {
    logs,
    ensureListeners,
    clear,
    destroy
  }
})
