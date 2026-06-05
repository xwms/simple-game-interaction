/**
 * 连接状态指示器组件
 *
 * 使用方式：<ConnectionStatus :status="status" :transport="transport" />
 * 逻辑说明：根据连接状态显示不同颜色和文字。
 */

<script setup lang="ts">
import type { TunnelStatus } from '@shared/types'

defineProps<{
  status: TunnelStatus
  transport?: 'ipv6' | 'p2p' | 'relay' | null
}>()
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
      <template v-if="status === 'disconnected'">未连接</template>
      <template v-else-if="status === 'connecting'">连接中...</template>
      <template v-else-if="status === 'connected'">
        已连接
        <template v-if="transport">
          ·
          <template v-if="transport === 'ipv6'">IPv6 直连</template>
          <template v-else-if="transport === 'p2p'">P2P 直连</template>
          <template v-else>中继转发</template>
        </template>
      </template>
      <template v-else>连接异常</template>
    </span>
  </div>
</template>
