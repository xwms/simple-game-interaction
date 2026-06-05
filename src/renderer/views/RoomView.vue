/**
 * 房间页
 *
 * 使用方式：路由 '/room/:roomCode'
 * 逻辑说明：显示房间码（大号可复制）、成员列表、连接状态指示器、
 *           流量统计、断开按钮。
 */

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useRoomStore } from '../store/room'
import { useTunnelStore } from '../store/tunnel'
import ConnectionStatus from '../components/ConnectionStatus.vue'
import FriendList from '../components/FriendList.vue'

const router = useRouter()
const roomStore = useRoomStore()
const tunnelStore = useTunnelStore()

/**
 * 功能描述：断开连接并返回首页
 */
async function handleDisconnect(): Promise<void> {
  await tunnelStore.stopTunnel()
  await roomStore.leaveRoom()
  router.push('/')
}

/**
 * 功能描述：复制房间码到剪贴板
 */
function copyRoomCode(): void {
  if (roomStore.roomCode) {
    navigator.clipboard.writeText(roomStore.roomCode)
  }
}
</script>

<template>
  <div class="room-view p-6 flex flex-col items-center pt-10">
    <!-- 房间码 -->
    <div class="text-center mb-6">
      <div class="text-sm text-gray-400 mb-2">
        {{ roomStore.isHost ? '你的房间码' : '已加入房间' }}
      </div>
      <div
        v-if="roomStore.isHost"
        class="text-4xl font-mono font-bold tracking-widest cursor-pointer hover:text-primary"
        @click="copyRoomCode"
      >
        {{ roomStore.roomCode }}
      </div>
      <div v-else class="text-lg">
        房间 {{ roomStore.roomCode }}
      </div>
    </div>

    <!-- 连接状态 -->
    <ConnectionStatus
      :status="tunnelStore.status"
      :transport="tunnelStore.transport"
      class="mb-6"
    />

    <!-- 成员列表 -->
    <FriendList :members="roomStore.members" class="w-full max-w-sm mb-6" />

    <!-- 连接信息 -->
    <div class="text-sm text-gray-500 mb-6 text-center">
      <div v-if="tunnelStore.localPort">
        请在游戏中连接 <strong>127.0.0.1:{{ tunnelStore.localPort }}</strong>
      </div>
      <div v-if="tunnelStore.transport" class="mt-1">
        连接方式：
        <template v-if="tunnelStore.transport === 'ipv6'">IPv6 直连</template>
        <template v-else-if="tunnelStore.transport === 'p2p'">P2P 直连</template>
        <template v-else>中继转发</template>
      </div>
    </div>

    <!-- 操作按钮 -->
    <n-button type="error" ghost @click="handleDisconnect">
      断开连接
    </n-button>
  </div>
</template>
