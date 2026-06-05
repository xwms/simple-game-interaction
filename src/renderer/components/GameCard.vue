/**
 * 游戏卡片组件
 *
 * 使用方式：<GameCard :game="game" :selected="bool" @select="fn" />
 * 逻辑说明：展示发现的游戏信息（名称、端口、状态），支持选中态高亮。
 */

<script setup lang="ts">
defineProps<{
  game: { id: string; name: string; port: number; status?: string }
  selected: boolean
}>()

const emit = defineEmits<{
  select: []
}>()
</script>

<template>
  <div
    class="game-card p-4 rounded-xl border cursor-pointer transition-colors"
    :class="selected ? 'border-primary bg-primary bg-opacity-5' : 'border-gray-200 hover:border-gray-400'"
    @click="emit('select')"
  >
    <div class="font-medium">{{ game.name }}</div>
    <div class="text-sm text-gray-500">
      端口 {{ game.port }}
      <span v-if="game.status" class="ml-2">· {{ game.status }}</span>
    </div>
  </div>
</template>
