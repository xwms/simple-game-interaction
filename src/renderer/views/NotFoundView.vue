/**
 * 404 页面
 *
 * 使用方式：路由 '/:pathMatch(.*)*'
 * 逻辑说明：未知路由时显示友好的错误页面，提供返回首页按钮。
 */

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

const router = useRouter()
const { t } = useI18n()
</script>

<template>
  <div class="not-found-view flex flex-col items-center justify-center h-full p-6">
    <div class="card p-10 text-center max-w-sm">
      <h1 class="text-5xl font-bold text-gray-200 dark:text-gray-600 mb-2">404</h1>
      <p class="text-gray-500 mb-6">{{ t('notFound.message') }}</p>
      <n-button type="primary" @click="router.push('/')">
        {{ t('notFound.backHome') }}
      </n-button>
    </div>
  </div>
</template>
