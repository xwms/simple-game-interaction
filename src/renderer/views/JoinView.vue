/**
 * 加入房间页
 *
 * 使用方式：路由 '/join'
 * 逻辑说明：用户输入 6 位房间码，网络检测结果从全局共享状态读取。
 *           点击"加入"连接房间，连接成功后跳转到房间页。
 *           网络检测结果影响连接路径选择：
 *           IPv6 公网可达 → IPv6 直连
 *           无 IPv6 + 非 Symmetric NAT → P2P
 *           Symmetric NAT 或无 P2P 条件 → Relay 中继
 */

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useRoomStore } from '../store/room'
import { useSettingsStore } from '../store/settings'
import { useNetworkDetect, natTypeLabel, inferConnectionPath } from '../composables/useNetworkDetect'

const router = useRouter()
const roomStore = useRoomStore()
const settings = useSettingsStore()
const { status, result, refresh } = useNetworkDetect()
const { t } = useI18n()

onMounted(() => {
  if (roomStore.roomCode) {
    router.replace('/room/' + roomStore.roomCode)
    return
  }
  roomStore.error = null
})

const roomCode = ref('')
const isJoining = ref(false)

const portBusy = ref(false)
const portBusyMessage = ref('')

/**
 * 功能描述：加入房间
 *
 * 逻辑说明：如果设置了自定义本地端口，先检查端口是否被占用。
 *           被占用则提示用户，不继续连接流程。
 */
async function handleJoin(): Promise<void> {
  if (roomCode.value.length !== 6 || isJoining.value) return
  portBusy.value = false

  // 检查自定义端口是否被占用
  const customPort = settings.localPort
  if (customPort > 0) {
    const checkResult = await window.electronAPI.invoke('game:check-port', customPort)
    if (checkResult.success && checkResult.data === true) {
      portBusyMessage.value = t('join.portBusy', { port: customPort })
      portBusy.value = true
      return
    }
  }

  isJoining.value = true
  await roomStore.joinRoom(roomCode.value.toUpperCase())
  isJoining.value = false
  if (roomStore.connectionStatus === 'connected') {
    router.push(`/room/${roomStore.roomCode}`)
  }
}
</script>

<template>
  <div class="join-view p-6 flex justify-center">
    <div class="w-full max-w-lg">
      <h2 class="text-xl font-bold mb-5">{{ t('join.title') }}</h2>

      <n-input
        v-model:value="roomCode"
        :placeholder="t('join.placeholder')"
        :maxlength="6"
        size="large"
        class="text-center tracking-[0.5em] font-mono text-xl"
        @keyup.enter="handleJoin"
      />

      <!-- 网络检测结果 -->
      <div class="mb-4 mt-8">
        <div v-if="status === 'detecting'" class="card px-4 py-3 flex items-center gap-3 text-sm">
          <n-spin size="small" />
          <span class="text-gray-500">{{ t('join.detecting') }}</span>
        </div>

        <div v-else-if="status === 'error'" class="card px-4 py-3 flex items-center gap-2 text-sm">
          <span class="iconfont icon-wangluozhongduan text-lg" />
          <span style="color:#ef4444!important">{{ t('home.offline') }}</span>
          <n-button size="tiny" text @click="refresh">{{ t('home.retry') }}</n-button>
        </div>

        <div v-else-if="status === 'done' && result" class="card px-4 py-3 flex items-center gap-2 text-sm flex-wrap">
          <div v-if="inferConnectionPath(result).type !== 'none'" class="flex items-center gap-1.5">
            <span class="inline-block w-2 h-2 rounded-full"
              :class="result.ipv6.available ? 'bg-green-500' : 'bg-gray-400'" />
            <span class="text-gray-600 dark:text-gray-300">{{
              result.ipv6.hasPublicV6 ? t('home.ipv6Reachable') :
              result.ipv6.available ? t('home.ipv6Available') :
              t('home.ipv6NotAvailable')
            }}</span>
          </div>
          <template v-if="natTypeLabel(result.ipv4)">
            <span class="text-gray-300 dark:text-gray-600">|</span>
            <span class="text-gray-600 dark:text-gray-300">{{ natTypeLabel(result.ipv4) }}</span>
            <span class="text-gray-300 dark:text-gray-600">|</span>
          </template>
          <span class="font-medium" :class="inferConnectionPath(result).type === 'none' ? 'text-red-500' : 'text-primary'">{{ t('join.expectedPath') }}{{ inferConnectionPath(result).label }}</span>
          <button class="ml-auto w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors" @click="refresh" :title="t('home.retry')">
            <span class="iconfont icon-shuaxin" />
          </button>
        </div>
      </div>

      <!-- 端口被占用提示 -->
      <n-alert v-if="portBusy" type="warning" :bordered="false" class="mb-4" closable @close="portBusy = false">
        {{ portBusyMessage }}
      </n-alert>

      <!-- 错误提示 -->
      <n-alert v-if="roomStore.error" type="error" :bordered="false" class="mb-4" closable @close="roomStore.error = null">
        {{ roomStore.error }}
      </n-alert>

      <!-- 操作按钮 -->
      <div class="flex items-center justify-between pt-4 border-t border-gray-100 dark:border-gray-700">
        <n-button @click="router.push('/')">{{ t('join.back') }}</n-button>
        <n-button
          :disabled="roomCode.length !== 6 || isJoining"
          :loading="isJoining"
          @click="handleJoin"
        >
          {{ t('join.join') }}
        </n-button>
      </div>
    </div>
  </div>
</template>
