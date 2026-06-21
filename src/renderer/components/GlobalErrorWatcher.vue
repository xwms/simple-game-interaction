/**
 * 全局错误通知组件
 *
 
 * 使用方式：放在 NNotificationProvider 内部（App.vue）
 * 逻辑说明：监听 roomStore 和 tunnelStore 的错误，通过 Naive UI Notification 弹出通知。
 *           通知不会自动消失（duration: 0），需要用户手动关闭。
 *           同时处理托盘菜单"断开连接"确认对话框。
 */

<script setup lang="ts">
import { watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useNotification, useDialog } from 'naive-ui'
import type { NotificationReactive } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRoomStore } from '../store/room'
import { useTunnelStore } from '../store/tunnel'

const router = useRouter()
const notification = useNotification()
const dialog = useDialog()
const roomStore = useRoomStore()
const tunnelStore = useTunnelStore()
const { t } = useI18n()

let tunnelErrorNotif: NotificationReactive | null = null
let roomErrorNotif: NotificationReactive | null = null

watch(() => tunnelStore.error, (err) => {
  if (tunnelErrorNotif) {
    tunnelErrorNotif.destroy()
    tunnelErrorNotif = null
  }
  if (err) {
    tunnelErrorNotif = notification.error({
      title: t('notify.connectionError'),
      content: err,
      duration: 0,
      closable: true
    })
  }
})

watch(() => roomStore.error, (err) => {
  if (roomErrorNotif) {
    roomErrorNotif.destroy()
    roomErrorNotif = null
  }
  if (err) {
    roomErrorNotif = notification.error({
      title: t('notify.roomError'),
      content: err,
      duration: 0,
      closable: true
    })
  }
})

/**
 * 功能描述：显示断开连接确认对话框，确认后执行完整清理
 */
function showDisconnectConfirm(): void {
  if (roomStore.connectionStatus !== 'connected' && roomStore.connectionStatus !== 'connecting') {
    return
  }
  dialog.warning({
    title: t('room.disconnectTitle'),
    content: t('room.disconnectConfirm'),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    positiveButtonProps: { type: 'success' },
    onPositiveClick: async () => {
      try {
        await roomStore.leaveRoom()
      } finally {
        tunnelStore.destroy()
        roomStore.destroy()
        router.push('/')
      }
    }
  })
}

// 暴露到全局，供 RoomView 直接调用
window.__showDisconnectConfirm = showDisconnectConfirm

onMounted(() => {
  // 监听托盘菜单的断开连接请求
  window.electronAPI.on('app:confirm-disconnect', showDisconnectConfirm)
})
</script>

<template>
  <!-- 纯逻辑组件，无 UI -->
</template>

<style scoped>
:global(.n-button--success-type:not(.n-button--disabled)) {
  background-color: #18a058 !important;
  background-image: none !important;
}
</style>
