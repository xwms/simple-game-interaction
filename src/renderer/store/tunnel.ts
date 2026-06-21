/**
 * 隧道连接状态 Store
 *
 * 逻辑说明：管理 TCP 隧道的连接方式和状态。记录当前使用的传输层
 *           （IPv6 / P2P / Relay）、流量统计和连接健康度。
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { TunnelStatus, TransportType } from '@shared/types'
import { i18n } from '../i18n'

/** 核心引擎/中继服务器返回的已知错误 → i18n key 映射 */
const KNOWN_ERROR_PREFIXES: [string, string][] = [
  ['Relay 连接超时', 'store.relayTimeout'],
  ['IPv6 连接超时', 'store.relayTimeout'],
  ['连接超时', 'store.relayTimeout'],
  ['[room-not-found]', 'store.roomNotFound']
]

function _translateError(msg: string): string {
  for (const [prefix, key] of KNOWN_ERROR_PREFIXES) {
    if (msg.startsWith(prefix)) return i18n.global.t(key)
  }
  return msg
}

export const useTunnelStore = defineStore('tunnel', () => {
  // ─── 状态 ───────────────────────────────────────────
  const status = ref<TunnelStatus>('disconnected')
  const transport = ref<TransportType | null>(null)
  const localPort = ref<number | null>(null)
  const bytesSent = ref(0)
  const bytesReceived = ref(0)
  const latency = ref<number | null>(null)
  const error = ref<string | null>(null)

  // ─── IPC 监听（仅注册一次） ──────────────────────────
  let _initialized = false
  const _cleanups: (() => void)[] = []

  function ensureListeners(): void {
    if (_initialized) return
    _initialized = true

    const c1 = window.electronAPI.on('tunnel:status', (newStatus: unknown) => {
      status.value = newStatus as TunnelStatus
    })
    _cleanups.push(c1)

    const c2 = window.electronAPI.on('tunnel:traffic', (stats: unknown) => {
      const s = stats as { bytesSent: number; bytesReceived: number }
      bytesSent.value = typeof s.bytesSent === 'number' ? s.bytesSent : 0
      bytesReceived.value = typeof s.bytesReceived === 'number' ? s.bytesReceived : 0
    })
    _cleanups.push(c2)

    const c3 = window.electronAPI.on('tunnel:error', (data: unknown) => {
      error.value = (data as { message: string }).message
      status.value = 'error'
    })
    _cleanups.push(c3)

    const c4 = window.electronAPI.on('tunnel:connected', (data: unknown) => {
      const d = data as { localPort: number; transportType?: string }
      localPort.value = d.localPort
      status.value = 'connected'
    })
    _cleanups.push(c4)

    const c5 = window.electronAPI.on('tunnel:transport-changed', (transportType: unknown) => {
      transport.value = transportType as TransportType
    })
    _cleanups.push(c5)

    const c6 = window.electronAPI.on('tunnel:latency', (rtt: unknown) => {
      latency.value = typeof rtt === 'number' ? rtt : null
    })
    if (c6) _cleanups.push(c6)
  }

  function destroy(): void {
    _cleanups.forEach(fn => fn())
    _cleanups.length = 0
    _initialized = false
    reset()
  }

  // ─── 方法 ───────────────────────────────────────────

  /**
   * 功能描述：启动本地隧道
   *
   * @param port - 本地监听端口
   */
  async function startTunnel(port: number): Promise<void> {
    ensureListeners()
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
      error.value = err instanceof Error ? _translateError(err.message) : i18n.global.t('store.tunnelStartFailed')
      status.value = 'error'
    }
  }

  /**
   * 功能描述：停止隧道
   */
  async function stopTunnel(): Promise<void> {
    ensureListeners()
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
    latency.value = null
    error.value = null
  }

  return {
    status,
    transport,
    localPort,
    bytesSent,
    bytesReceived,
    latency,
    error,
    ensureListeners,
    destroy,
    startTunnel,
    stopTunnel,
    reset
  }
})
