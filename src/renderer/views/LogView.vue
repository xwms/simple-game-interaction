/**
 * 日志页
 *
 * 使用方式：路由 '/logs'
 * 逻辑说明：显示应用运行日志，从主进程广播接收并实时更新。
 */

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import LogViewer from '../components/LogViewer.vue'
import { useLogStore } from '../store/log'

const logStore = useLogStore()
const { t } = useI18n()

/**
 * 功能描述：打开日志文件
 */
function handleOpenLogFile(): void {
  window.electronAPI.invoke('app:open-log-file')
}

/**
 * 功能描述：打开日志目录
 */
function handleOpenLogDir(): void {
  window.electronAPI.invoke('app:open-log-dir')
}
</script>

<template>
  <div class="log-view p-6 flex flex-col h-full">
    <div class="flex items-center mb-4 shrink-0">
      <h2 class="text-xl font-bold">{{ t('nav.logs') }}</h2>
    </div>

    <LogViewer :logs="logStore.logs" class="flex-1 min-h-0" />

    <div class="mt-4 flex gap-2 shrink-0">
      <n-button size="small" @click="logStore.clear()">
        {{ t('logs.clear') }}
      </n-button>
      <n-button size="small" @click="handleOpenLogDir">
        {{ t('logs.openDir') }}
      </n-button>
      <n-button size="small" @click="handleOpenLogFile">
        {{ t('logs.openFile') }}
      </n-button>
    </div>
  </div>
</template>
