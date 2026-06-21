/**
 * 导航栏组件
 *
 * 使用方式：<NavBar />
 * 逻辑说明：顶部导航栏。首页显示 SGI logo + 标题；子页面显示返回按钮 + 当前页面名称。
 *           右侧固定显示设置和日志入口图标按钮，最右侧为窗口控制按钮。
 *           整个导航栏支持窗口拖拽（-webkit-app-region: drag），按钮排除拖拽区域。
 */

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'

const router = useRouter()
const route = useRoute()
const { t } = useI18n()

/**
 * 功能描述：根据当前路由显示对应的页面名称
 */
const pageTitle = computed(() => {
  const key = route.meta.title as string
  return key ? t(key) : ''
})

/**
 * 功能描述：最小化窗口
 */
function handleMinimize(): void {
  window.electronAPI.invoke('window:minimize')
}

/**
 * 功能描述：关闭窗口
 */
function handleClose(): void {
  window.electronAPI.invoke('window:close')
}
</script>

<template>
  <nav class="nav-bar flex items-center h-12 px-4 border-b border-gray-200/60 dark:border-gray-700/60 bg-white dark:bg-gray-900 shadow-sm" style="-webkit-app-region: drag">
    <!-- 左侧：Logo（可拖拽） -->
    <div class="flex items-center flex-1">
      <div class="flex items-center gap-1.5">
        <span class="text-lg font-bold">SGI</span>
        <span v-if="pageTitle && route.path !== '/'" class="text-sm text-gray-400 dark:text-gray-500 ml-1">/ {{ pageTitle }}</span>
      </div>
    </div>

    <!-- 中间：导航按钮 -->
    <div class="flex items-center justify-center flex-1 gap-1 whitespace-nowrap">
      <button
        class="h-9 px-3 flex items-center gap-1.5 rounded-lg text-[15px] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        :class="{ 'text-primary!': ['/', '/host', '/join'].includes(route.path) }"
        style="-webkit-app-region: no-drag"
        @click="router.push('/')"
      >
        <span class="iconfont icon-shouye" />
        <span>{{ t('nav.home') }}</span>
      </button>
      <button
        class="h-9 px-3 flex items-center gap-1.5 rounded-lg text-[15px] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        :class="{ 'text-primary!': route.path === '/settings' }"
        style="-webkit-app-region: no-drag"
        @click="router.push('/settings')"
      >
        <span class="iconfont icon-shezhi text-lg" />
        <span>{{ t('nav.settings') }}</span>
      </button>
      <button
        class="h-9 px-3 flex items-center gap-1.5 rounded-lg text-[15px] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        :class="{ 'text-primary!': route.path === '/logs' }"
        style="-webkit-app-region: no-drag"
        @click="router.push('/logs')"
      >
        <span class="iconfont icon-rizhi" />
        <span>{{ t('nav.logs') }}</span>
      </button>
      <button
        class="h-9 px-3 flex items-center gap-1.5 rounded-lg text-[15px] text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        :class="{ 'text-primary!': route.path === '/about' }"
        style="-webkit-app-region: no-drag"
        @click="router.push('/about')"
      >
        <span class="iconfont icon-guanyu" />
        <span>{{ t('nav.about') }}</span>
      </button>
    </div>

    <!-- 右侧：窗口控制按钮 -->
    <div class="flex items-center justify-end flex-1 gap-1">
      <button
        class="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-gray-800 transition-colors"
        style="-webkit-app-region: no-drag"
        @click="handleMinimize"
      >
        <span class="iconfont icon-zuixiaohua text-lg font-bold" />
      </button>
      <button
        class="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:text-red-400 dark:hover:bg-red-900/20 transition-colors"
        style="-webkit-app-region: no-drag"
        @click="handleClose"
      >
        <span class="iconfont icon-kaiguan text-lg font-bold" />
      </button>
    </div>
  </nav>
</template>
