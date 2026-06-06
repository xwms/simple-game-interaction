/**
 * 房间状态 Store
 *
 * 逻辑说明：管理房间创建/加入/离开流程的状态。包括房间码、成员列表、
 *           本机角色（房主/加入者）、连接状态和错误信息。
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { MemberInfo } from '@shared/types'

import { useTunnelStore } from './tunnel'

export const useRoomStore = defineStore('room', () => {
  // ─── 状态 ───────────────────────────────────────────
  const roomCode = ref<string>('')
  const role = ref<'host' | 'guest' | null>(null)
  const members = ref<MemberInfo[]>([])
  const connectionStatus = ref<'idle' | 'connecting' | 'connected' | 'disconnected'>('idle')
  const error = ref<string | null>(null)
  const memberName = ref<string>('')

  // ─── 计算属性 ───────────────────────────────────────
  const isHost = computed(() => role.value === 'host')
  const memberCount = computed(() => members.value.length)

  // ─── IPC 监听器（仅注册一次） ────────────────────────
  let _initialized = false
  function _ensureListeners(): void {
    if (_initialized) return
    _initialized = true

    window.electronAPI.on('room:member-joined', (member: unknown) => {
      const m = member as MemberInfo
      const idx = members.value.findIndex(x => x.id === m.id)
      if (idx === -1) members.value.push(m)
    })

    window.electronAPI.on('room:member-left', (data: unknown) => {
      const d = data as { memberId: string }
      members.value = members.value.filter(m => m.id !== d.memberId)
    })
  }

  // ─── 方法 ───────────────────────────────────────────

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
    try {
      const result = await window.electronAPI.invoke('room:create', { gameId, gamePort, gameName })
      if (result.success) {
        roomCode.value = (result.data as { roomCode: string }).roomCode
        connectionStatus.value = 'connected'
      } else {
        throw new Error(result.error)
      }
    } catch (err: unknown) {
      error.value = err instanceof Error ? err.message : '创建房间失败'
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
      const result = await window.electronAPI.invoke('room:join', {
        roomCode: code,
        memberName: memberName.value || 'Player'
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
      error.value = err instanceof Error ? err.message : '加入房间失败'
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
    members.value = []
    connectionStatus.value = 'idle'
    error.value = null
  }

  return {
    roomCode,
    role,
    members,
    connectionStatus,
    error,
    memberName,
    isHost,
    memberCount,
    createRoom,
    joinRoom,
    leaveRoom,
    reset
  }
})
