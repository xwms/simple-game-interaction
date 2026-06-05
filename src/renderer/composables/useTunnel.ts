/**
 * 功能描述：隧道管理 composable — 封装隧道启停和状态监控
 */

import { useTunnelStore } from '../store/tunnel'

export function useTunnel() {
  const store = useTunnelStore()

  return {
    status: store.status,
    transport: store.transport,
    localPort: store.localPort,
    error: store.error,
    startTunnel: store.startTunnel,
    stopTunnel: store.stopTunnel
  }
}
