/**
 * 成员列表组件
 *
 * 使用方式：<FriendList :members="members" />
 * 逻辑说明：展示房间内的成员列表，每个成员显示名称和连接方式。
 */

<script setup lang="ts">
import type { MemberInfo } from '@shared/types'

defineProps<{
  members: MemberInfo[]
}>()
</script>

<template>
  <div class="friend-list">
    <div class="text-sm text-gray-400 mb-2">成员 ({{ members.length }})</div>
    <div v-if="members.length === 0" class="text-sm text-gray-500">
      等待其他玩家加入...
    </div>
    <div
      v-for="member in members"
      :key="member.id"
      class="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800"
    >
      <span class="text-sm">{{ member.name }}</span>
      <span class="text-xs text-gray-400">{{ member.transport || '等待连接' }}</span>
    </div>
  </div>
</template>
