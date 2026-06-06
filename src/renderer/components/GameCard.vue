/**
 * 游戏卡片组件
 *
 * 使用方式：<GameCard :game="game" :selected="bool" @select="fn" />
 * 逻辑说明：展示发现的游戏信息（名称、端口、状态），支持选中态高亮。
 */

<script setup lang="ts">
defineProps<{
  game: { gameId: string; name: string; port: number; running?: boolean; portOpen?: boolean }
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
      端口 {{ game.portOpen ? game.port : '待开放' }}
      <span v-if="game.running && game.portOpen" class="ml-2 text-green-500">· 运行中</span>
      <span v-else-if="game.running && !game.portOpen" class="ml-2 text-yellow-500">· 进程运行（端口未开放）</span>
      <span v-else-if="game.portOpen" class="ml-2">· 端口开放</span>
    </div>
  </div>
</template>
