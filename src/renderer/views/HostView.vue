/**
 * 创建房间页
 *
 * 使用方式：路由 '/host'
 * 逻辑说明：自动扫描本机游戏进程和 LAN 游戏，列表展示可分享的游戏。
 *           用户选择一个后点击"创建房间"。
 */

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useRoomStore } from '../store/room'
import GameCard from '../components/GameCard.vue'

const router = useRouter()
const roomStore = useRoomStore()

const games = ref<any[]>([])
const isScanning = ref(true)
const selectedGame = ref<string | null>(null)
const isCreating = ref(false)

/**
 * 功能描述：扫描本机游戏
 */
async function scanGames(): Promise<void> {
  isScanning.value = true
  try {
    const result = await window.electronAPI.invoke('game:detect-local')
    if (result.success) {
      games.value = (result.data as any[]) || []
    }
  } finally {
    isScanning.value = false
  }
}

/**
 * 功能描述：创建房间
 */
async function handleCreate(): Promise<void> {
  if (!selectedGame.value || isCreating.value) return
  isCreating.value = true
  const game = games.value.find((g) => g.id === selectedGame.value)
  if (game) {
    await roomStore.createRoom(game.id, game.port)
    if (roomStore.roomCode) {
      router.push(`/room/${roomStore.roomCode}`)
    }
  }
  isCreating.value = false
}

// 页面挂载时自动扫描
scanGames()
</script>

<template>
  <div class="host-view p-6">
    <h2 class="text-xl font-bold mb-4">创建房间</h2>

    <div v-if="isScanning" class="text-gray-500 mb-4">正在扫描本机游戏...</div>

    <div v-else-if="games.length === 0" class="text-gray-500 mb-4">
      未检测到游戏，请确保游戏服务器已启动
    </div>

    <div v-else class="space-y-3 mb-6">
      <GameCard
        v-for="game in games"
        :key="game.id"
        :game="game"
        :selected="selectedGame === game.id"
        @select="selectedGame = game.id"
      />
    </div>

    <div class="flex gap-3">
      <n-button @click="router.push('/')">返回</n-button>
      <n-button
        type="primary"
        :disabled="!selectedGame"
        :loading="isCreating"
        @click="handleCreate"
      >
        创建房间
      </n-button>
    </div>
  </div>
</template>
