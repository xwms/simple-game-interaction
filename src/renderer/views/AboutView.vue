<script setup lang="ts">
/**
 * 关于页面
 *
 * 使用方式：路由 '/about'
 * 逻辑说明：显示作者、开源地址、版权和软著号等信息。
 */

import { version as appVersion } from '../../../package.json'
</script>

<template>
  <div class="about-view flex h-full p-6">
    <div class="card max-w-md w-full mx-auto p-8 flex flex-col items-center text-center gap-5">
      <!-- Logo / 应用名 -->
      <div class="w-16 h-16 rounded-2xl bg-primary/10 dark:bg-primary/20 flex items-center justify-center">
        <span class="text-2xl font-bold text-primary">SGI</span>
      </div>
      <div>
        <div class="text-lg font-bold">Simple Game Interaction</div>
        <div class="text-xs text-gray-400 mt-1">v{{ appVersion }}</div>
      </div>

      <div class="w-full h-px bg-gray-200 dark:bg-gray-700" />

      <!-- 信息列表 -->
      <div class="w-full text-sm space-y-3 text-left">
        <div class="flex justify-between">
          <span class="text-gray-400">{{ $t('about.author') }}</span>
          <span class="text-gray-700 dark:text-gray-200">X_watermelons</span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-400">{{ $t('about.source') }}</span>
          <a
            href="https://github.com/xwms/simple-game-interaction"
            target="_blank"
            class="text-primary hover:underline"
          >GitHub</a>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-400">{{ $t('about.copyright') }}</span>
          <span class="text-gray-700 dark:text-gray-200">Copyright © 2026 xwms</span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-400">{{ $t('about.softwareCopyright') }}</span>
          <span class="text-gray-700 dark:text-gray-200">待填写</span>
        </div>
      </div>
    </div>
  </div>
</template>
