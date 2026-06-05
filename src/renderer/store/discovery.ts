/**
 * LAN 游戏发现状态 Store
 *
 * 逻辑说明：管理局域网游戏扫描的启停和结果列表。
 *           通过 IPC 调用主进程的 UDP 广播扫描器，结果实时更新。
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { GameInfo } from '@shared/types'

export const useDiscoveryStore = defineStore('discovery', () => {
  // ─── 状态 ───────────────────────────────────────────
  const games = ref<GameInfo[]>([])
  const isScanning = ref(false)

  // ─── 方法 ───────────────────────────────────────────

  /**
   * 功能描述：开始扫描局域网游戏
   */
  async function startScan(): Promise<void> {
    isScanning.value = true
    try {
      await window.electronAPI.invoke('lan:start-scan')
    } catch {
      isScanning.value = false
    }
  }

  /**
   * 功能描述：停止扫描
   */
  async function stopScan(): Promise<void> {
    try {
      await window.electronAPI.invoke('lan:stop-scan')
    } finally {
      isScanning.value = false
    }
  }

  return { games, isScanning, startScan, stopScan }
})
