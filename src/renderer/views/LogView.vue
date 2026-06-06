/**
 * 日志页
 *
 * 使用方式：路由 '/logs'
 * 逻辑说明：显示应用运行日志，从主进程广播接收并实时更新。
 */

<script setup lang="ts">
import { useRouter } from 'vue-router'
import LogViewer from '../components/LogViewer.vue'
import { useLogStore } from '../store/log'

const router = useRouter()
const logStore = useLogStore()
</script>

<template>
  <div class="log-view p-6">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-xl font-bold">日志</h2>
      <n-button size="small" @click="router.push('/')">返回</n-button>
    </div>

    <LogViewer :logs="logStore.logs" />

    <div class="mt-4 flex gap-2">
      <n-button size="small" @click="logStore.clear()">清空</n-button>
    </div>
  </div>
</template>
