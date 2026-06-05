/**
 * 根组件
 *
 * 逻辑说明：提供全局布局结构 — 顶栏 NavBar + 路由视图主体区域。
 *          Naive UI 的消息/通知/对话框在根组件注入。
 */

<script setup lang="ts">
import { NMessageProvider, NNotificationProvider, NDialogProvider } from 'naive-ui'
import NavBar from './components/NavBar.vue'
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
