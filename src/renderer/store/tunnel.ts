/**
 * 隧道连接状态 Store
 *
 * 逻辑说明：管理 TCP 隧道的连接方式和状态。记录当前使用的传输层
 *           （IPv6 / P2P / Relay）、流量统计和连接健康度。
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { TunnelStatus, TransportType } from '@shared/types'

export const useTunnelStore = defineStore('tunnel', () => {
  // ─── 状态 ───────────────────────────────────────────
  const status = ref<TunnelStatus>('disconnected')
  const transport = ref<TransportType | null>(null)
  const localPort = ref<number | null>(null)
  const bytesSent = ref(0)
  const bytesReceived = ref(0)
  const error = ref<string | null>(null)

  // ─── IPC 监听（仅注册一次） ──────────────────────────
  let _initialized = false
  function _ensureListeners(): void {
    if (_initialized) return
    _initialized = true

    window.electronAPI.on('tunnel:status', (newStatus: unknown) => {
      status.value = newStatus as TunnelStatus
    })

    window.electronAPI.on('tunnel:traffic', (stats: unknown) => {
      const s = stats as { bytesSent: number; bytesReceived: number }
      bytesSent.value = s.bytesSent
      bytesReceived.value = s.bytesReceived
    })

    window.electronAPI.on('tunnel:error', (data: unknown) => {
      error.value = (data as { message: string }).message
      status.value = 'error'
    })

    window.electronAPI.on('tunnel:connected', (data: unknown) => {
      const d = data as { localPort: number; transportType?: string }
      localPort.value = d.localPort
      status.value = 'connected'
    })

    window.electronAPI.on('tunnel:transport-changed', (transportType: unknown) => {
      transport.value = transportType as TransportType
    })
  }

  // ─── 方法 ───────────────────────────────────────────

  /**
   * 功能描述：启动本地隧道
   *
   * @param port - 本地监听端口
   */
  async function startTunnel(port: number): Promise<void> {
    _ensureListeners()
    status.value = 'connecting'
    try {
      const result = await window.electronAPI.invoke('tunnel:start', { port, roomCode: '' })
      if (result.success) {
        const data = result.data as { port: number; transport: TransportType }
        localPort.value = data.port
        transport.value = data.transport
        status.value = 'connected'
      } else {
        throw new Error(result.error)
      }
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : '隧道启动失败'
      status.value = 'error'
    }
  }

  /**
   * 功能描述：停止隧道
   */
  async function stopTunnel(): Promise<void> {
    _ensureListeners()
    try {
      await window.electronAPI.invoke('tunnel:stop')
    } finally {
      status.value = 'disconnected'
      transport.value = null
      localPort.value = null
    }
  }

  function reset(): void {
    status.value = 'disconnected'
    transport.value = null
    localPort.value = null
    bytesSent.value = 0
    bytesReceived.value = 0
    error.value = null
  }

  return {
    status,
    transport,
    localPort,
    bytesSent,
    bytesReceived,
    error,
    startTunnel,
    stopTunnel,
    reset
  }
})
