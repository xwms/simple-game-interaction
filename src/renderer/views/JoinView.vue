/**
 * 加入房间页
 *
 * 使用方式：路由 '/join'
 * 逻辑说明：用户输入 6 位房间码，网络检测结果从全局共享状态读取。
 *           点击"加入"连接房间，连接成功后跳转到房间页。
 *
 * 逻辑说明：网络检测结果影响连接路径选择：
 *           IPv6 公网可达 → IPv6 直连
 *           无 IPv6 + 非 Symmetric NAT → P2P
 *           Symmetric NAT 或无 P2P 条件 → Relay 中继
 */

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useRoomStore } from '../store/room'
import RoomCodeInput from '../components/RoomCodeInput.vue'
import { useNetworkDetect, natTypeLabel, inferConnectionPath } from '../composables/useNetworkDetect'

const router = useRouter()
const roomStore = useRoomStore()
const { status, result, refresh } = useNetworkDetect()

// 进入页面时清除残留错误
onMounted(() => {
  roomStore.error = null
})

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

    <!-- 网络检测结果（从全局共享状态读取） -->
    <div class="w-full max-w-sm mt-6">
      <div v-if="status === 'detecting'" class="text-sm text-gray-500 flex items-center gap-2">
        <n-spin size="small" />
        <span>正在检测网络环境...</span>
      </div>

      <div v-else-if="status === 'error'" class="text-sm text-red-400 flex items-center gap-2">
        <span>网络检测失败，将使用中继模式连接</span>
        <button class="text-primary hover:underline text-xs" @click="refresh">重新检测</button>
      </div>

      <div v-else-if="status === 'done' && result" class="text-sm space-y-1.5">
        <div class="flex items-center gap-2">
          <span class="inline-block w-3 h-3 rounded-full"
            :class="result.ipv6.available ? 'bg-green-500' : 'bg-gray-400'">
          </span>
          <span>IPv6：{{ result.ipv6.hasPublicV6 ? '公网可达' : result.ipv6.available ? '可用' : '不可用' }}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="inline-block w-3 h-3 rounded-full"
            :class="result.ipv4.natType === 'unknown' ? 'bg-red-400' : 'bg-green-500'">
          </span>
          <span>NAT 类型：{{ natTypeLabel(result.ipv4) }}</span>
        </div>
        <div class="text-gray-400 mt-1">
          预计连接方式：{{ inferConnectionPath(result).label }}
        </div>
      </div>
    </div>

    <div class="flex gap-3 mt-6">
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
  </div>
</template>
