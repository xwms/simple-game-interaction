<script setup lang="ts">
/**
 * 关于页面
 *
 * 使用方式：路由 '/about'
 * 逻辑说明：显示作者、开源地址、版权和软著号等信息。
 */

import { version as appVersion } from '../../../package.json'

/**
 * 功能描述：打开意见反馈链接（系统默认浏览器）
 */
function openFeedback(): void {
  window.electronAPI.invoke('app:open-external', 'https://docs.qq.com/form/page/DQ0V1Y3Z4eGVZZ3FV')
}

/**
 * 功能描述：打开开源地址（系统默认浏览器）
 */
function openSource(): void {
  window.electronAPI.invoke('app:open-external', 'https://github.com/xwms/simple-game-interaction')
}

/**
 * 功能描述：发送邮件到作者
 */
function openMail(): void {
  window.electronAPI.invoke('app:open-external', 'mailto:3188074406@qq.com')
}

// /**
//  * 功能描述：打开用户协议与免责声明页面
//  */
// function openLegal(): void {
//   window.electronAPI.invoke('app:open-external', 'https://www.baidu.com')
// }

/**
 * 功能描述：打开隐私说明
 */
function openPrivacy(): void {
  window.electronAPI.invoke('app:open-external', 'https://github.com/xwms/simple-game-interaction/blob/main/PRIVACY.md')
}

/**
 * 功能描述：打开 kcp-ts 开源库地址
 */
function openKcp(): void {
  window.electronAPI.invoke('app:open-external', 'https://github.com/boba-ps/kcp-ts')
}

/**
 * 功能描述：打开常见问题解答
 */
function openFaq(): void {
  window.electronAPI.invoke('app:open-external', 'https://docs.qq.com/doc/DQ0FyWW54WmdaU1VX')
}
</script>

<template>
  <div class="about-view flex h-full p-6">
    <div class="card max-w-md w-full mx-auto p-8 flex flex-col items-center text-center gap-5 overflow-y-auto">
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

        <!-- 开发者信息 -->
        <div class="flex items-center gap-3 my-2">
          <div class="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
          <span class="text-xs text-gray-400 font-bold tracking-wider flex-shrink-0">{{ $t('about.groupDev') }}</span>
          <div class="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
        </div>

        <div class="flex justify-between">
          <span class="text-gray-400">{{ $t('about.author') }}</span>
          <span class="text-gray-700 dark:text-gray-200">X_watermelons</span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-400">{{ $t('about.contact') }}</span>
          <span
            class="text-primary hover:underline cursor-pointer"
            @click="openMail"
          >3188074406@qq.com</span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-400">{{ $t('about.source') }}</span>
          <span
            class="text-primary hover:underline cursor-pointer"
            @click="openSource"
          >GitHub</span>
        </div>

        <!-- 法律信息 -->
        <div class="flex items-center gap-3 my-2">
          <div class="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
          <span class="text-xs text-gray-400 font-bold tracking-wider flex-shrink-0">{{ $t('about.groupLegal') }}</span>
          <div class="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
        </div>

        <!-- <div class="flex justify-between">
          <span class="text-gray-400">{{ $t('about.legal') }}</span>
          <span
            class="text-primary hover:underline cursor-pointer"
            @click="openLegal"
          >用户协议与免责声明</span>
        </div> -->
        <div class="flex justify-between">
          <span class="text-gray-400">{{ $t('about.privacy') }}</span>
          <span
            class="text-primary hover:underline cursor-pointer"
            @click="openPrivacy"
          >{{ $t('about.privacy') }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-400">{{ $t('about.oss') }}</span>
          <span
            class="text-primary hover:underline cursor-pointer"
            @click="openKcp"
          >kcp-ts</span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-400">{{ $t('about.copyright') }}</span>
          <span class="text-gray-700 dark:text-gray-200">Copyright © 2026 xwms</span>
        </div>
        <!-- <div class="flex justify-between">
          <span class="text-gray-400">{{ $t('about.softwareCopyright') }}</span>
          <span class="text-gray-700 dark:text-gray-200">无需</span>
        </div> -->

        <!-- 支持 -->
        <div class="flex items-center gap-3 my-2">
          <div class="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
          <span class="text-xs text-gray-400 font-bold tracking-wider flex-shrink-0">{{ $t('about.groupSupport') }}</span>
          <div class="h-px flex-1 bg-gray-200 dark:bg-gray-700" />
        </div>

        <div class="flex justify-between">
          <span class="text-gray-400">{{ $t('about.faq') }}</span>
          <span
            class="text-primary hover:underline cursor-pointer"
            @click="openFaq"
          >{{ $t('about.faq') }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-400">{{ $t('about.feedback') }}</span>
          <span
            class="text-primary hover:underline cursor-pointer"
            @click="openFeedback"
          >{{ $t('about.feedbackAction') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
