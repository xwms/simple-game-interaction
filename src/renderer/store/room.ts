/**
 * 房间状态 Store
 *
 * 逻辑说明：管理房间创建/加入/离开流程的状态。包括房间码、成员列表、
 *           本机角色（房主/加入者）、连接状态和错误信息。
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useTunnelStore } from './tunnel'
import { useSettingsStore } from './settings'
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

export const useRoomStore = defineStore('room', () => {
  // ─── 状态 ───────────────────────────────────────────
  const roomCode = ref<string>('')
  const role = ref<'host' | 'guest' | null>(null)
  const connectionStatus = ref<'idle' | 'connecting' | 'connected' | 'disconnected'>('idle')
  const error = ref<string | null>(null)
  const memberName = ref<string>('')
  const hostGameId = ref<string>('')
  const hostGamePort = ref<number>(0)
  const memberCount = ref(0)

  // ─── 计算属性 ───────────────────────────────────────
  const isHost = computed(() => role.value === 'host')

  // ─── IPC 监听器 ─────────────────────────────────────
  let _initialized = false
  const _cleanups: (() => void)[] = []

  function _ensureListeners(): void {
    if (_initialized) return
    _initialized = true
    const c1 = window.electronAPI.on('room:member-joined', () => { memberCount.value++ })
    _cleanups.push(c1)
    const c2 = window.electronAPI.on('room:member-left', () => { memberCount.value = Math.max(0, memberCount.value - 1) })
    _cleanups.push(c2)
  }

  function destroy(): void {
    _cleanups.forEach(fn => fn())
    _cleanups.length = 0
    _initialized = false
    reset()
  }

  /**
   * 功能描述：创建房间
   *
   * @param gameId - 游戏标识
   * @param gamePort - 游戏端口号
   * @param gameName - 游戏名称（可选，用于日志和显示）
   */
  async function createRoom(gameId: string, gamePort: number, gameName?: string): Promise<void> {
    _ensureListeners()
    error.value = null
    connectionStatus.value = 'connecting'
    role.value = 'host'
    hostGameId.value = gameId
    hostGamePort.value = gamePort
    try {
      const settings = useSettingsStore()
      const result = await window.electronAPI.invoke('room:create', {
        gameId, gamePort, gameName,
        relayUrl: settings.relayServerUrl
      })
      if (result.success) {
        roomCode.value = (result.data as { roomCode: string }).roomCode
        connectionStatus.value = 'connected'
      } else {
        throw new Error(result.error)
      }
    } catch (err: unknown) {
      error.value = err instanceof Error ? _translateError(err.message) : i18n.global.t('store.createRoomFailed')
      connectionStatus.value = 'disconnected'
    }
  }

  /**
   * 功能描述：加入房间
   *
   * @param code - 6 位房间码
   */
  async function joinRoom(code: string): Promise<void> {
    _ensureListeners()
    error.value = null
    connectionStatus.value = 'connecting'
    role.value = 'guest'
    try {
      const settings = useSettingsStore()
      const result = await window.electronAPI.invoke('room:join', {
        roomCode: code,
        memberName: memberName.value || 'Player',
        relayUrl: settings.relayServerUrl,
        localPort: settings.localPort || 0
      })
      if (result.success) {
        roomCode.value = code
        connectionStatus.value = 'connected'
        // 更新隧道信息
        const tunnelStore = useTunnelStore()
        tunnelStore.localPort = (result.data as { localPort?: number })?.localPort ?? null
        tunnelStore.status = 'connected'
      } else {
        throw new Error(result.error)
      }
    } catch (err: unknown) {
      error.value = err instanceof Error ? _translateError(err.message) : i18n.global.t('store.joinRoomFailed')
      connectionStatus.value = 'disconnected'
    }
  }

  /**
   * 功能描述：离开房间
   */
  async function leaveRoom(): Promise<void> {
    try {
      await window.electronAPI.invoke('room:leave')
    } finally {
      reset()
    }
  }

  /**
   * 功能描述：重置状态
   */
  function reset(): void {
    roomCode.value = ''
    role.value = null
    connectionStatus.value = 'idle'
    error.value = null
    memberCount.value = 0
    hostGameId.value = ''
    hostGamePort.value = 0
  }

  return {
    roomCode,
    role,
    connectionStatus,
    error,
    memberName,
    isHost,
    memberCount,
    hostGameId,
    hostGamePort,
    destroy,
    createRoom,
    joinRoom,
    leaveRoom,
    reset
  }
})
