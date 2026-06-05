/**
 * 设置页
 *
 * 使用方式：路由 '/settings'
 * 逻辑说明：语言切换、主题切换、中继服务器地址、代理设置、手动检查更新。
 */

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useSettingsStore } from '../store/settings'

const router = useRouter()
const settings = useSettingsStore()
</script>

<template>
  <div class="settings-view p-6 max-w-lg mx-auto">
    <h2 class="text-xl font-bold mb-6">设置</h2>

    <!-- 语言 -->
    <div class="mb-5">
      <label class="block text-sm text-gray-500 mb-2">语言 / Language</label>
      <n-select
        :value="settings.locale"
        :options="[
          { label: '中文', value: 'zh-CN' },
          { label: 'English', value: 'en-US' }
        ]"
        @update-value="settings.setLocale"
      />
    </div>

    <!-- 主题 -->
    <div class="mb-5">
      <label class="block text-sm text-gray-500 mb-2">主题</label>
      <n-select
        :value="settings.theme"
        :options="[
          { label: '浅色', value: 'light' },
          { label: '深色', value: 'dark' },
          { label: '跟随系统', value: 'auto' }
        ]"
        @update-value="settings.setTheme"
      />
    </div>

    <!-- 中继服务器 -->
    <div class="mb-5">
      <label class="block text-sm text-gray-500 mb-2">中继服务器地址</label>
      <n-input v-model:value="settings.relayServerUrl" placeholder="wss://..." />
    </div>

    <!-- 自动检查更新 -->
    <div class="mb-5 flex items-center justify-between">
      <span class="text-sm">自动检查更新</span>
      <n-switch v-model:value="settings.autoUpdateCheck" />
    </div>

    <!-- 手动检查更新 -->
    <div class="mb-8">
      <n-button quaternary @click="router.push('/')">检查更新</n-button>
    </div>

    <n-button @click="router.push('/')">返回</n-button>
  </div>
</template>
