/**
 * 加入房间页
 *
 * 使用方式：路由 '/join'
 * 逻辑说明：用户输入 6 位房间码，点击"加入"→ 显示连接中 →
 *           连接成功后跳转到房间页。
 */

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useRoomStore } from '../store/room'
import RoomCodeInput from '../components/RoomCodeInput.vue'

const router = useRouter()
const roomStore = useRoomStore()

const roomCode = ref('')
const isJoining = ref(false)

/**
 * 功能描述：加入房间
 */
async function handleJoin(): Promise<void> {
  if (roomCode.value.length !== 6 || isJoining.value) return
  isJoining.value = true
  await roomStore.joinRoom(roomCode.value.toUpperCase())
  isJoining.value = false
  if (roomStore.connectionStatus === 'connected') {
    router.push(`/room/${roomStore.roomCode}`)
  }
}
</script>

<template>
  <div class="join-view p-6 flex flex-col items-center pt-16">
    <h2 class="text-xl font-bold mb-8">加入房间</h2>

    <RoomCodeInput v-model="roomCode" />

    <div v-if="roomStore.error" class="text-red-500 text-sm mt-4">
      {{ roomStore.error }}
    </div>

    <div class="flex gap-3 mt-8">
      <n-button @click="router.push('/')">返回</n-button>
      <n-button
        type="primary"
        :disabled="roomCode.length !== 6"
        :loading="isJoining"
        @click="handleJoin"
      >
        加入
      </n-button>
    </div>

    <div v-if="isJoining" class="mt-4 text-sm text-gray-500">
      正在检测网络环境并连接...
    </div>
  </div>
</template>
