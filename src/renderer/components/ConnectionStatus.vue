/**
 * 连接状态指示器组件
 *
 * 使用方式：<ConnectionStatus :status="status" />
 * 逻辑说明：根据连接状态显示不同颜色和文字。
 */

<script setup lang="ts">
import type { TunnelStatus } from '@shared/types'
import { useI18n } from 'vue-i18n'

defineProps<{
  status: TunnelStatus
}>()

const { t } = useI18n()
</script>

<template>
  <div class="connection-status flex items-center gap-2">
    <span
      class="w-3 h-3 rounded-full"
      :class="{
        'bg-gray-300': status === 'disconnected',
        'bg-yellow-400 animate-pulse': status === 'connecting',
        'bg-green-500': status === 'connected',
        'bg-red-500': status === 'error'
      }"
    />
    <span class="text-sm">
      <template v-if="status === 'disconnected'">{{ t('status.disconnected') }}</template>
      <template v-else-if="status === 'connecting'">{{ t('status.connecting') }}</template>
      <template v-else-if="status === 'connected'">{{ t('status.connected') }}</template>
      <template v-else>{{ t('status.error') }}</template>
    </span>
  </div>
</template>
