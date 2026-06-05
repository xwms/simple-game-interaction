/**
 * 日志页
 *
 * 使用方式：路由 '/logs'
 * 逻辑说明：显示应用运行日志，便于调试和用户反馈。
 */

<script setup lang="ts">
import { useRouter } from 'vue-router'
import LogViewer from '../components/LogViewer.vue'
import { ref } from 'vue'

const router = useRouter()
const logs = ref<string[]>([
  '[INFO] 应用启动',
  '[INFO] 网络检测完成 - IPv6: 可用, NAT: FullCone',
  '[INFO] 已连接到中继服务器'
])
</script>

<template>
  <div class="log-view p-6">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-xl font-bold">日志</h2>
      <n-button size="small" @click="router.push('/')">返回</n-button>
    </div>

    <LogViewer :logs="logs" />

    <div class="mt-4 flex gap-2">
      <n-button size="small" @click="logs.push('[INFO] ' + new Date().toISOString())">
        刷新
      </n-button>
      <n-button size="small" @click="logs.length = 0">清空</n-button>
    </div>
  </div>
</template>
