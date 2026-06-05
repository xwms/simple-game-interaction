/**
 * 日志查看器组件
 *
 * 使用方式：<LogViewer :logs="logs" />
 * 逻辑说明：类终端样式的日志列表，自动滚动到底部。
 */

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'

const props = defineProps<{
  logs: string[]
}>()

const containerRef = ref<HTMLDivElement | null>(null)

watch(
  () => props.logs.length,
  async () => {
    await nextTick()
    if (containerRef.value) {
      containerRef.value.scrollTop = containerRef.value.scrollHeight
    }
  }
)
</script>

<template>
  <div
    ref="containerRef"
    class="log-viewer bg-gray-900 text-gray-100 text-xs font-mono p-4 rounded-xl h-64 overflow-y-auto"
  >
    <div v-for="(line, index) in logs" :key="index" class="leading-relaxed">
      {{ line }}
    </div>
    <div v-if="logs.length === 0" class="text-gray-500">暂无日志</div>
  </div>
</template>
