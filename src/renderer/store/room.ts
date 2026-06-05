/**
 * 房间状态 Store
 *
 * 逻辑说明：管理房间创建/加入/离开流程的状态。包括房间码、成员列表、
 *           本机角色（房主/加入者）、连接状态和错误信息。
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { MemberInfo } from '@shared/types'

export const useRoomStore = defineStore('room', () => {
  // ─── 状态 ───────────────────────────────────────────
  const roomCode = ref<string>('')
  const role = ref<'host' | 'guest' | null>(null)
  const members = ref<MemberInfo[]>([])
  const connectionStatus = ref<'idle' | 'connecting' | 'connected' | 'disconnected'>('idle')
  const error = ref<string | null>(null)

  // ─── 计算属性 ───────────────────────────────────────
  const isHost = computed(() => role.value === 'host')
  const memberCount = computed(() => members.value.length)

  // ─── 方法 ───────────────────────────────────────────

  /**
   * 功能描述：创建房间
   *
   * @param gameId - 游戏标识
   * @param gamePort - 游戏端口号
   */
  async function createRoom(gameId: string, gamePort: number): Promise<void> {
    connectionStatus.value = 'connecting'
    role.value = 'host'
    try {
      const result = await window.electronAPI.invoke('room:create', { gameId, gamePort })
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
    connectionStatus.value = 'connecting'
    role.value = 'guest'
    try {
      const result = await window.electronAPI.invoke('room:join', code)
      if (result.success) {
        roomCode.value = code
        connectionStatus.value = 'connected'
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
      await window.electronAPI.invoke('room:leave', roomCode.value)
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
    isHost,
    memberCount,
    createRoom,
    joinRoom,
    leaveRoom,
    reset
  }
})
