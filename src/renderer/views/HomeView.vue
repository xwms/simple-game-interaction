/**
 * 首页
 *
 * 使用方式：路由 '/'
 * 逻辑说明：顶部两个操作按钮（创建/加入房间）；中间显示网络检测状态；
 *           再下方显示当前版本更新日志；底部显示版本号和更新状态。
 */

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useNetworkDetect, natTypeLabel, inferConnectionPath } from '../composables/useNetworkDetect'

const router = useRouter()
const { status, result, refresh } = useNetworkDetect()

const currentVersion = ref('0.1.0')
const updateStatus = ref<'checking' | 'latest' | 'available' | 'error'>('checking')
const updateVersion = ref('')
const releaseNotes = ref<string[]>([])

/**
 * 功能描述：检查更新
 */
async function checkUpdate(): Promise<void> {
  updateStatus.value = 'checking'
  try {
    const result = await window.electronAPI.invoke('update:check')
    if (result.success && result.data) {
      const data = result.data as { hasUpdate: boolean; version: string; releaseNotes?: string }
      if (data.hasUpdate) {
        updateStatus.value = 'available'
        updateVersion.value = data.version
        // 将 Release Notes 按行分割
        releaseNotes.value = (data.releaseNotes || '')
          .split('\n')
          .filter((line: string) => line.trim().length > 0)
      } else {
        updateStatus.value = 'latest'
        releaseNotes.value = ['初始版本发布', '基础功能框架搭建']
      }
    } else {
      updateStatus.value = 'error'
    }
  } catch {
    updateStatus.value = 'error'
  }
}

onMounted(() => {
  // 启动后延迟 3 秒检查更新（由主进程触发，但 UI 先显示 checking）
  setTimeout(checkUpdate, 3000)
})
</script>

<template>
  <div class="home-view flex flex-col items-center px-6 pt-12 pb-6 h-full">
    <!-- 顶部操作按钮 -->
    <div class="flex gap-6 mb-10">
      <n-button
        size="large"
        type="primary"
        class="w-48 h-20 text-xl rounded-2xl"
        @click="router.push('/host')"
      >
        🎮 创建房间
      </n-button>
      <n-button
        size="large"
        type="info"
        class="w-48 h-20 text-xl rounded-2xl"
        @click="router.push('/join')"
      >
        🔗 加入房间
      </n-button>
    </div>

    <!-- 网络检测状态 -->
    <div class="w-full max-w-md mb-4">
      <div v-if="status === 'detecting'" class="flex items-center gap-3 px-4 py-3 rounded-xl bg-gray-50 dark:bg-gray-800">
        <n-spin size="small" />
        <span class="text-sm text-gray-500">正在检测网络环境...</span>
      </div>

      <div v-else-if="status === 'done' && result" class="flex items-center gap-3 px-4 py-3 rounded-xl bg-gray-50 dark:bg-gray-800 text-sm">
        <div class="flex items-center gap-1.5">
          <span class="inline-block w-2.5 h-2.5 rounded-full"
            :class="result.ipv6.available ? 'bg-green-500' : 'bg-gray-400'">
          </span>
          <span class="text-gray-600 dark:text-gray-300">
            {{ result.ipv6.hasPublicV6 ? 'IPv6' : result.ipv6.available ? 'IPv6(本地)' : 'IPv6×' }}
          </span>
        </div>
        <span class="text-gray-300">|</span>
        <span class="text-gray-600 dark:text-gray-300">{{ natTypeLabel(result.ipv4) }}</span>
        <span class="text-gray-300">|</span>
        <span class="text-primary">{{ inferConnectionPath(result).label }}</span>
        <button class="ml-auto text-gray-400 hover:text-gray-600 text-xs" @click="refresh" title="重新检测">↻</button>
      </div>

      <div v-else-if="status === 'error'" class="flex items-center gap-2 px-4 py-3 rounded-xl bg-gray-50 dark:bg-gray-800 text-sm text-gray-400">
        <span>⚠</span>
        <span>网络检测失败</span>
        <button class="ml-auto text-primary hover:underline text-xs" @click="refresh">重新检测</button>
      </div>
    </div>

    <!-- 更新日志 -->
    <div class="w-full max-w-md flex-1">
      <div class="text-sm text-gray-400 mb-2">
        v{{ currentVersion }} 更新内容
      </div>
      <div class="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 space-y-2">
        <div
          v-for="(note, index) in releaseNotes"
          :key="index"
          class="text-sm leading-relaxed"
        >
          {{ index + 1 }}. {{ note }}
        </div>
        <div v-if="releaseNotes.length === 0" class="text-sm text-gray-400">
          暂无更新信息
        </div>
      </div>
    </div>

    <!-- 底部版本状态 -->
    <div class="mt-4 text-xs text-gray-400 text-center">
      <template v-if="updateStatus === 'checking'">
        v{{ currentVersion }} · 正在检查更新...
      </template>
      <template v-else-if="updateStatus === 'latest'">
        v{{ currentVersion }} · ✓ 已是最新版本
      </template>
      <template v-else-if="updateStatus === 'available'">
        v{{ currentVersion }} ·
        <span class="text-primary cursor-pointer hover:underline">
          新版本 v{{ updateVersion }} 立即更新
        </span>
      </template>
      <template v-else>
        v{{ currentVersion }}
      </template>
    </div>

    <!-- 底部导航 -->
    <div class="mt-4 flex gap-4 text-xs text-gray-400">
      <span class="cursor-pointer hover:text-gray-600" @click="router.push('/settings')">
        设置
      </span>
      <span class="cursor-pointer hover:text-gray-600" @click="router.push('/logs')">
        日志
      </span>
    </div>
  </div>
</template>
