/**
 * 功能描述：LAN 发现 composable — 封装扫描启停和游戏列表
 *
 * 逻辑说明：通过 IPC 调用主进程的 UDP 广播扫描器，返回响应式游戏列表。
 *           组件卸载时自动停止扫描。
 */

import { onUnmounted } from 'vue'
import { useDiscoveryStore } from '../store/discovery'

export function useLanDiscovery() {
  const store = useDiscoveryStore()

  onUnmounted(() => {
    store.stopScan()
  })

  return {
    games: store.games,
    isScanning: store.isScanning,
    startScan: store.startScan,
    stopScan: store.stopScan
  }
}
