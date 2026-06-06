/**
 * 根组件
 *
 * 逻辑说明：提供全局布局结构 — 顶栏 NavBar + 路由视图主体区域。
 *          Naive UI 的消息/通知/对话框在根组件注入。
 *          应用启动后立即开始网络检测。
 */

<script setup lang="ts">
import { onMounted } from 'vue'
import { NMessageProvider, NNotificationProvider, NDialogProvider } from 'naive-ui'
import NavBar from './components/NavBar.vue'
import { useNetworkDetect } from './composables/useNetworkDetect'
import { useLogStore } from './store/log'

const { detect } = useNetworkDetect()
const logStore = useLogStore()

onMounted(() => {
  detect()
  logStore.ensureListeners() // 全局注册日志 IPC 监听，收集主进程日志
})
</script>

<template>
  <NNotificationProvider>
    <NDialogProvider>
      <NMessageProvider>
        <div class="app-container flex flex-col h-screen">
          <NavBar />
          <main class="flex-1 overflow-auto">
            <router-view />
          </main>
        </div>
      </NMessageProvider>
    </NDialogProvider>
  </NNotificationProvider>
</template>
