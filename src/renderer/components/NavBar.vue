/**
 * 导航栏组件
 *
 * 使用方式：<NavBar />
 * 逻辑说明：顶部导航栏，显示返回按钮（非首页时）和应用标题。
 */

<script setup lang="ts">
import { useRouter, useRoute } from 'vue-router'

const router = useRouter()
const route = useRoute()
</script>

<template>
  <nav class="nav-bar flex items-center h-12 px-4 border-b border-gray-200 dark:border-gray-700">
    <button
      v-if="route.path !== '/'"
      class="text-sm text-gray-500 hover:text-gray-800 mr-3"
      @click="router.back()"
    >
      ← 返回
    </button>
    <span class="text-sm font-medium">SGI</span>
  </nav>
</template>
