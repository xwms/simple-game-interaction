/**
 * 游戏卡片组件
 *
 * 使用方式：<GameCard :game="game" :selected="bool" @select="fn" />
 * 逻辑说明：展示发现的游戏信息（名称、端口、状态），支持选中态高亮。
 *           如果检测到多个端口则全部列出。
 */

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{
  game: { gameId: string; name: string; port: number; ports?: number[]; running?: boolean; portOpen?: boolean }
  selected: boolean
}>()

const emit = defineEmits<{
  select: []
}>()

const { t } = useI18n()
</script>

<template>
  <div
    class="game-card p-4 rounded-xl border cursor-pointer transition-colors"
    :class="selected ? 'border-primary bg-primary bg-opacity-5' : 'border-gray-200 hover:border-gray-400'"
    @click="emit('select')"
  >
    <div class="font-medium">{{ game.name }}</div>
    <div class="text-sm text-gray-500">
      <template v-if="game.ports && game.ports.length > 1">
        {{ t('host.portsLabel') }} {{ game.ports.join(', ') }}
      </template>
      <template v-else>
        {{ t('host.portLabel') }} {{ game.port }}
      </template>
      <span class="ml-2 text-green-500">{{ t('host.running') }}</span>
    </div>
  </div>
</template>
