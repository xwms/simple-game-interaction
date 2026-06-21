/**
 * 根组件
 *
 * 逻辑说明：提供全局布局结构 — 顶栏 NavBar + 路由视图主体区域。
 *          Naive UI 的消息/通知/对话框在根组件注入。
 *          应用启动后立即开始网络检测，全局错误通知。
 */

<script setup lang="ts">
import { onMounted, watch, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { NConfigProvider, darkTheme, NMessageProvider, NNotificationProvider, NDialogProvider } from 'naive-ui'
import type { GlobalTheme } from 'naive-ui'
import NavBar from './components/NavBar.vue'
import GlobalErrorWatcher from './components/GlobalErrorWatcher.vue'
import { useNetworkDetect } from './composables/useNetworkDetect'
import { useRoomStore } from './store/room'
import { useTunnelStore } from './store/tunnel'
import { useSettingsStore } from './store/settings'
import { useLogStore } from './store/log'

const { detect } = useNetworkDetect()
const logStore = useLogStore()
const settings = useSettingsStore()
const roomStore = useRoomStore()
const tunnelStore = useTunnelStore()
const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const showRoomFloatingBtn = computed(() => {
  return roomStore.roomCode !== '' && !route.path.startsWith('/room/')
})

const naiveTheme = computed<GlobalTheme | null>(() => {
  if (settings.theme === 'dark') return darkTheme
  if (settings.theme === 'light') return null
  // auto: 跟随系统
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? darkTheme : null
})

/**
 * 功能描述：根据当前主题设置，在 html 上添加/移除 dark class，并通知主进程
 */
function applyTheme(theme: string): void {
  if (theme === 'dark') {
    document.documentElement.classList.add('dark')
  } else if (theme === 'light') {
    document.documentElement.classList.remove('dark')
  } else {
    document.documentElement.classList.toggle('dark', window.matchMedia('(prefers-color-scheme: dark)').matches)
  }
  // 通知主进程主题变化（用于托盘菜单同步）
  window.electronAPI.invoke('app:theme-changed', theme).catch(() => {})
}

const bgStyle = computed(() => {
  if (!settings.backgroundDataUrl) return {}
  return {
    backgroundImage: `url(${settings.backgroundDataUrl})`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat'
  }
})

const overlayStyle = computed(() => {
  if (!settings.backgroundDataUrl) return {}
  // 根据当前主题选择遮罩颜色（深色用黑，浅色用白）
  const isDark = settings.theme === 'dark' || (settings.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const baseColor = isDark ? '0, 0, 0' : '255, 255, 255'
  return {
    backgroundColor: `rgba(${baseColor}, ${settings.backgroundOpacity / 100})`
  }
})

onMounted(() => {
  detect()
  logStore.ensureListeners()
  applyTheme(settings.theme)
  settings.loadBackgroundImage()
  // 同步保存的日志文件路径到主进程
  if (settings.logFilePath) {
    window.electronAPI.invoke('app:set-log-file-path', settings.logFilePath)
  }
  // 同步关闭行为设置到主进程
  window.electronAPI.invoke('app:set-close-behavior', settings.closeBehavior)
})

// 主题变化时更新遮罩颜色
watch(() => settings.theme, () => {
  // overlayStyle 是 computed，强制触发重新计算
  applyTheme(settings.theme)
})

// 监听主题切换
watch(() => settings.theme, applyTheme)

// 同步关闭行为到主进程
watch(() => settings.closeBehavior, (val) => {
  window.electronAPI.invoke('app:set-close-behavior', val)
})

// 卡片透明度 → CSS 变量
function applyCardOpacity(val: number): void {
  document.documentElement.style.setProperty('--card-opacity', String(val / 100))
}
watch(() => settings.cardOpacity, applyCardOpacity, { immediate: true })

// 跟随系统模式时，监听系统色彩方案变化
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (settings.theme === 'auto') {
    document.documentElement.classList.toggle('dark', e.matches)
    window.electronAPI.invoke('app:theme-changed', 'auto').catch(() => {})
  }
})
</script>

<template>
  <NConfigProvider :theme="naiveTheme">
    <NNotificationProvider>
      <NDialogProvider>
        <NMessageProvider>
          <GlobalErrorWatcher />
          <div class="app-container relative flex flex-col h-screen select-none rounded-xl overflow-hidden bg-gradient-to-br from-gray-50 via-white to-blue-50 dark:from-gray-950 dark:via-gray-900 dark:to-gray-800">
            <!-- 背景图片层 -->
            <div v-if="settings.backgroundDataUrl" class="absolute inset-0 z-0" :style="bgStyle"></div>
            <!-- 遮罩层 -->
            <div v-if="settings.backgroundDataUrl" class="absolute inset-0 z-[1]" :style="overlayStyle"></div>
            <!-- 内容层 -->
            <div class="relative z-10 flex flex-col h-full">
              <NavBar />
              <main class="flex-1 overflow-auto relative" style="scrollbar-gutter: stable">
                <router-view v-slot="{ Component }">
                  <Transition name="fade">
                    <component :is="Component" :key="route.path" />
                  </Transition>
                </router-view>

                <!-- 返回房间悬浮按钮 -->
                <button
                  v-if="showRoomFloatingBtn"
                  class="fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 bg-primary text-white rounded-full shadow-lg hover:opacity-90 transition-opacity text-sm"
                  @click="router.push('/room/' + roomStore.roomCode)"
                >
                  <span>{{ t('nav.backToRoom') }}</span>
                  <span
                    v-if="tunnelStore.transport"
                    class="text-xs opacity-75"
                  >
                    {{ tunnelStore.transport === 'ipv6' ? 'IPv6' : tunnelStore.transport === 'p2p' ? 'P2P' : t('room.transportRelay') }}
                  </span>
                </button>
              </main>
            </div>
          </div>
        </NMessageProvider>
      </NDialogProvider>
    </NNotificationProvider>
  </NConfigProvider>
</template>
