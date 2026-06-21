/**
 * 房间页
 *
 * 使用方式：路由 '/room/:roomCode'
 * 逻辑说明：显示房间码（大号可复制）、连接状态指示器、
 *           流量统计（含趋势图）、游戏连接检测、错误恢复、断开按钮。
 */

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { useRoomStore } from '../store/room'
import { useTunnelStore } from '../store/tunnel'
import ConnectionStatus from '../components/ConnectionStatus.vue'

const router = useRouter()
const roomStore = useRoomStore()
const tunnelStore = useTunnelStore()
const { t } = useI18n()
const message = useMessage()

const gameStatus = ref<'waiting' | 'connected' | 'disconnected'>('waiting')
const gamePort = computed(() => roomStore.isHost ? roomStore.hostGamePort : (tunnelStore.localPort || 0))
let gamePollTimer: ReturnType<typeof setInterval> | null = null
let hostGameTimer: ReturnType<typeof setInterval> | null = null
let trafficTimer: ReturnType<typeof setInterval> | null = null
let _prevSent = 0
let _prevReceived = 0

// ─── 流量展示增强 ─────────────────────────────────────
/** EMA 平滑后的速率 */
const smoothedSendRate = ref(0)
const smoothedReceiveRate = ref(0)
/** 速率峰值 */
const peakSend = ref(0)
const peakReceive = ref(0)
/** 历史数据（30 秒窗口），用于趋势图 */
const trafficHistory = ref<Array<{ send: number; receive: number }>>([])
/** 连接开始时间 */
const connectionStartTime = ref(0)
/** 连接时长（秒） */
const connectionDuration = ref(0)
/** EMA 平滑系数（0-1，越大越灵敏） */
const SMOOTHING_ALPHA = 0.35
/** SVG sparkline 尺寸 */
const SVG_WIDTH = 300
const SVG_HEIGHT = 50
/** 进度条参考带宽（auto-scaling bottom） */
const barRef = computed(() => Math.max(102400, peakSend.value * 1.2, peakReceive.value * 1.2))
/** 趋势图垂直参考线位置（%） */
const gridLines = [25, 50, 75]

// ─── 流量展示字符串（显式 .value，防模板 unwrap 异常） ──
function useRateDisplay(r: Ref<number | null>): ComputedRef<string> {
  return computed(() => {
    const v = r.value
    return (typeof v === 'number' && isFinite(v) && v >= 1) ? formatBytes(v, true) : '0 B/s'
  })
}
const displaySendRateStr = useRateDisplay(smoothedSendRate)
const displayReceiveRateStr = useRateDisplay(smoothedReceiveRate)
const displayPeakSendStr = useRateDisplay(peakSend)
const displayPeakReceiveStr = useRateDisplay(peakReceive)

/**
 * 功能描述：根据延迟值返回对应的颜色 class
 *
 * 逻辑说明：<50ms 绿色，50-150ms 黄色，>150ms 红色
 *
 * @returns 颜色 class 字符串
 */
const latencyColor = computed(() => {
  const v = tunnelStore.latency
  if (v === null) return 'text-gray-400'
  if (v < 50) return 'text-green-500'
  if (v < 150) return 'text-yellow-500'
  return 'text-red-500'
})

/**
 * 功能描述：断开连接并返回首页，先弹出确认对话框
 */
function handleDisconnect(): void {
  if (roomStore.connectionStatus !== 'connected' && roomStore.connectionStatus !== 'connecting') {
    router.push('/')
    return
  }
  window.__showDisconnectConfirm?.()
}

/**
 * 功能描述：复制房间码到剪贴板，显示成功提示
 */
function copyRoomCode(): void {
  if (roomStore.roomCode) {
    navigator.clipboard.writeText(roomStore.roomCode)
    message.success(t('room.copied'))
  }
}

/**
 * 功能描述：格式化字节数为可读字符串
 *
 * @param bytes - 字节数
 * @param perSecond - 是否显示 /s 后缀（用于速率）
 * @returns 格式化后的字符串
 */
function formatBytes(bytes: unknown, perSecond: boolean = false): string {
  const n = typeof bytes === 'number' ? bytes : Number(bytes)
  if (!isFinite(n) || n < 1) {
    return perSecond ? '0 B/s' : '0 B'
  }
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(n) / Math.log(k))
  return parseFloat((n / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i] + (perSecond ? '/s' : '')
}

/**
 * 功能描述：格式化秒数为可读时长
 *
 * @param seconds - 秒数
 * @returns 如 "3m 42s"
 */
function formatDuration(seconds: number): string {
  if (seconds < 0) return '0s'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/**
 * 功能描述：生成 SVG sparkline points 字符串
 *
 * 逻辑说明：将历史数据映射为 SVG polyline 坐标。
 *           数据归一化到最大值的 90% 高度，留出边距。
 *
 * @param key - 'send' | 'receive'
 * @returns polyline points 字符串
 */
function sparklinePoints(key: 'send' | 'receive'): string {
  const h = trafficHistory.value
  if (h.length < 2) return ''
  const maxVal = Math.max(...h.map(p => p[key]), 1)
  const stepX = SVG_WIDTH / (h.length - 1)
  return h.map((p, i) => {
    const x = i * stepX
    const y = SVG_HEIGHT - (p[key] / maxVal) * SVG_HEIGHT * 0.85 - 2
    return `${x},${y}`
  }).join(' ')
}

/** 连接断开时自动离开房间并返回首页/加入页 */
watch(() => tunnelStore.status, (newStatus) => {
  if (newStatus === 'error') {
    handleLeaveAndGoBack()
  }
  // 断开连接时重置流量统计数据
  if (newStatus === 'disconnected' || newStatus === 'error') {
    trafficHistory.value = []
    smoothedSendRate.value = 0
    smoothedReceiveRate.value = 0
    peakSend.value = 0
    peakReceive.value = 0
    connectionDuration.value = 0
  }
})

async function handleLeaveAndGoBack(): Promise<void> {
  const wasHost = roomStore.isHost
  await roomStore.leaveRoom()
  if (wasHost) {
    router.push('/host')
  } else {
    router.push('/join')
  }
}

onMounted(async () => {
  // 确保隧道 IPC 监听器已注册
  tunnelStore.ensureListeners()

  // 主动拉取当前隧道状态（防止连接事件在监听器注册前已到达）
  try {
    const statusResult = await window.electronAPI.invoke('tunnel:status')
    if (statusResult.success && statusResult.data) {
      const s = statusResult.data as { state?: string; localPort?: number; transportType?: string }
      if (s.state === 'connected') {
        tunnelStore.status = 'connected'
        if (s.localPort) tunnelStore.localPort = s.localPort
        if (s.transportType) tunnelStore.transport = s.transportType as any
      }
    }
  } catch { /* ignore */ }

  // 房主：先检查端口状态，然后开始定期检测
  if (roomStore.isHost) {
    try {
      const initResult = await window.electronAPI.invoke('game:check-port', roomStore.hostGamePort)
      gameStatus.value = (initResult.success && initResult.data) ? 'connected' : 'disconnected'
    } catch {
      gameStatus.value = 'disconnected'
    }
    hostGameTimer = setInterval(async () => {
      try {
        const result = await window.electronAPI.invoke('game:check-port', roomStore.hostGamePort)
        if (result.success) {
          const open = result.data as boolean
          if (!open && gameStatus.value === 'connected') {
            gameStatus.value = 'disconnected'
          } else if (open) {
            gameStatus.value = 'connected'
          }
        }
      } catch { /* 静默重试 */ }
    }, 3000)
  }

  // 初始化流量采样基准值
  _prevSent = tunnelStore.bytesSent
  _prevReceived = tunnelStore.bytesReceived

  // 实时流量速率采样（每秒计算差值）→ EMA 平滑 + 峰值 + 历史
  trafficTimer = setInterval(() => {
    if (tunnelStore.status !== 'connected') return
    const rawSend = tunnelStore.bytesSent - _prevSent
    const rawReceive = tunnelStore.bytesReceived - _prevReceived
    _prevSent = tunnelStore.bytesSent
    _prevReceived = tunnelStore.bytesReceived

    // EMA 平滑（防止 NaN 传播）
    const safeRawSend = isFinite(rawSend) ? rawSend : 0
    const safeRawReceive = isFinite(rawReceive) ? rawReceive : 0
    if (smoothedSendRate.value === 0) {
      smoothedSendRate.value = safeRawSend
      smoothedReceiveRate.value = safeRawReceive
    } else {
      smoothedSendRate.value = SMOOTHING_ALPHA * safeRawSend + (1 - SMOOTHING_ALPHA) * smoothedSendRate.value
      smoothedReceiveRate.value = SMOOTHING_ALPHA * safeRawReceive + (1 - SMOOTHING_ALPHA) * smoothedReceiveRate.value
    }

    // 峰值
    if (smoothedSendRate.value > peakSend.value) peakSend.value = smoothedSendRate.value
    if (smoothedReceiveRate.value > peakReceive.value) peakReceive.value = smoothedReceiveRate.value

    // 历史（30 秒滚动窗口）
    trafficHistory.value.push({ send: smoothedSendRate.value, receive: smoothedReceiveRate.value })
    if (trafficHistory.value.length > 30) trafficHistory.value.shift()
  }, 1000)

  // 连接时长计时
  if (tunnelStore.status === 'connected') {
    connectionStartTime.value = Date.now()
  }

  // 定时轮询隧道活跃连接，检测游戏是否已连接
  gamePollTimer = setInterval(async () => {
    if (tunnelStore.status !== 'connected') return
    try {
      const result = await window.electronAPI.invoke('tunnel:status')
      if (result.success && result.data) {
        const statusData = result.data as { activeConnections?: number }
        if (statusData.activeConnections && statusData.activeConnections > 0) {
          if (gameStatus.value === 'waiting') {
            gameStatus.value = 'connected'
          }
          if (gamePollTimer) {
            clearInterval(gamePollTimer)
            gamePollTimer = null
          }
        }
      }
    } catch {
      // 静默重试
    }
  }, 2000)
})

// 时长计时器（独立于 onMounted 防止 DOM 生命周期影响）
let durationTimer: ReturnType<typeof setInterval> | null = null
watch(() => tunnelStore.status, (s) => {
  if (s === 'connected' && connectionStartTime.value === 0) {
    connectionStartTime.value = Date.now()
  }
  if (s === 'connected' && !durationTimer) {
    durationTimer = setInterval(() => {
      if (tunnelStore.status === 'connected') {
        connectionDuration.value = Math.floor((Date.now() - connectionStartTime.value) / 1000)
      }
    }, 1000)
  }
  if (s !== 'connected' && durationTimer) {
    clearInterval(durationTimer)
    durationTimer = null
    connectionStartTime.value = 0
  }
})

onUnmounted(() => {
  if (durationTimer) {
    clearInterval(durationTimer)
    durationTimer = null
  }
  if (gamePollTimer) {
    clearInterval(gamePollTimer)
    gamePollTimer = null
  }
  if (hostGameTimer) {
    clearInterval(hostGameTimer)
    hostGameTimer = null
  }
  if (trafficTimer) {
    clearInterval(trafficTimer)
    trafficTimer = null
  }
})
</script>

<template>
  <div class="room-view p-6 max-w-4xl mx-auto pt-8">
    <!-- 房间码 -->
    <div class="card p-5 mb-4">
      <div class="text-xs text-gray-400 mb-2">
        {{ roomStore.isHost ? t('room.yourCode') : t('room.joined') }}
      </div>
      <div
        v-if="roomStore.isHost"
        class="flex items-center gap-3"
      >
        <span class="text-3xl font-mono font-bold tracking-widest select-all">{{ roomStore.roomCode }}</span>
        <button
          class="h-8 px-3 flex items-center gap-1.5 rounded-lg text-sm text-primary border border-primary/30 hover:bg-primary/10 dark:hover:bg-primary/20 transition-colors"
          @click="copyRoomCode"
        >
          <span class="iconfont icon-fuzhi" />
          <span>{{ t('room.copy') }}</span>
        </button>
      </div>
      <div v-else class="text-lg font-medium flex items-center gap-2">
        <span class="iconfont icon-jiarufangjian text-primary" />
        {{ t('room.room') }} {{ roomStore.roomCode }}
      </div>
    </div>

    <!-- 状态卡片：连接状态 + 延迟 + 游戏连接 -->
    <div class="card p-5 flex flex-col gap-4 mb-4">
      <!-- 连接状态 + 连接方式 -->
      <div v-if="!roomStore.isHost" class="flex items-center gap-2">
        <ConnectionStatus :status="tunnelStore.status" />
        <template v-if="tunnelStore.transport && tunnelStore.status === 'connected'">
          <span class="text-gray-300 dark:text-gray-600">·</span>
          <span class="text-xs text-gray-400">
            <template v-if="tunnelStore.transport === 'ipv6'">{{ t('room.transportV6') }}</template>
            <template v-else-if="tunnelStore.transport === 'p2p'">{{ t('room.transportP2p') }}</template>
            <template v-else>{{ t('room.transportRelay') }}</template>
          </span>
        </template>
      </div>
      <!-- 房主：显示连接人数 -->
      <div v-else-if="roomStore.isHost && tunnelStore.status === 'connected'" class="flex items-center gap-2">
        <span class="text-sm text-gray-600 dark:text-gray-300">{{ t('room.connectedMembers', { count: roomStore.memberCount }) }}</span>
      </div>

      <!-- 实时延迟（仅非房主显示） -->
      <div v-if="!roomStore.isHost && tunnelStore.status === 'connected'" class="flex items-center gap-2">
        <span class="iconfont icon-yanchi text-sm text-primary" />
        <span class="text-sm text-gray-600 dark:text-gray-300">{{ t('room.latency') }}:</span>
        <span class="font-mono text-sm" :class="latencyColor">
          {{ tunnelStore.latency !== null ? tunnelStore.latency + ' ms' : '--' }}
        </span>
      </div>

      <!-- 游戏连接状态 -->
      <div v-if="tunnelStore.status === 'connected'">
        <div v-if="gameStatus === 'connected'" class="flex items-center gap-2 text-xs text-green-500">
          <span class="w-2 h-2 rounded-full bg-green-500" />
          {{ t('room.gameConnected', { port: gamePort }) }}
        </div>
        <div v-else-if="gameStatus === 'disconnected'" class="flex items-center gap-2 text-xs text-red-500">
          <span class="w-2 h-2 rounded-full bg-red-500" />
          {{ t('room.gameDisconnected', { port: gamePort }) }}
        </div>
        <div v-else class="flex items-center gap-2 text-xs text-yellow-500">
          <span class="w-2 h-2 rounded-full bg-yellow-400" />
          {{ t('room.waitingGame', { host: '127.0.0.1', port: gamePort }) }}
        </div>
      </div>
    </div>

    <!-- 流量监控卡片 -->
    <div v-if="tunnelStore.status === 'connected'" class="card p-5 mb-4">
      <div class="text-sm text-gray-400 mb-4 flex items-center gap-1">
        <span class="iconfont icon-liuliang text-primary font-bold" />
        {{ t('room.traffic') }}
      </div>

      <!-- 速率进度条 -->
      <div class="flex flex-col gap-2.5 mb-4">
        <div class="flex items-center gap-2 text-xs">
          <span class="text-green-500 shrink-0 min-w-[3em]">▲ {{ t('room.upload') }}</span>
          <div class="flex-1 h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
            <div
              class="h-full rounded-full bg-green-400 transition-all duration-300 ease-out"
              :style="{ width: Math.min(100, (smoothedSendRate / barRef) * 100) + '%' }"
            />
          </div>
          <span class="font-mono text-xs w-24 text-right text-gray-600 dark:text-gray-300 tabular-nums">{{ displaySendRateStr }}</span>
        </div>
        <div class="flex items-center gap-2 text-xs">
          <span class="text-blue-500 shrink-0 min-w-[3em]">▼ {{ t('room.download') }}</span>
          <div class="flex-1 h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
            <div
              class="h-full rounded-full bg-blue-400 transition-all duration-300 ease-out"
              :style="{ width: Math.min(100, (smoothedReceiveRate / barRef) * 100) + '%' }"
            />
          </div>
          <span class="font-mono text-xs w-24 text-right text-gray-600 dark:text-gray-300 tabular-nums">{{ displayReceiveRateStr }}</span>
        </div>
      </div>

      <!-- Sparkline 趋势图（始终渲染，防布局跳动） -->
      <div class="mb-4">
        <svg
          :viewBox="`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`"
          class="w-full h-12"
          preserveAspectRatio="none"
        >
          <!-- 网格线 -->
          <line
            v-for="(val, idx) in gridLines" :key="idx"
            :x1="val * SVG_WIDTH / 100" y1="0"
            :x2="val * SVG_WIDTH / 100" :y2="SVG_HEIGHT"
            stroke="currentColor" stroke-opacity="0.06" stroke-width="1"
          />
          <!-- 下载趋势（蓝色，在上层） -->
          <polyline
            v-if="sparklinePoints('receive')"
            :points="sparklinePoints('receive')"
            fill="none"
            stroke="#60a5fa"
            stroke-width="1.5"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
          <!-- 上传趋势（绿色） -->
          <polyline
            v-if="sparklinePoints('send')"
            :points="sparklinePoints('send')"
            fill="none"
            stroke="#4ade80"
            stroke-width="1.5"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
        </svg>
        <div class="flex justify-between text-2xs text-gray-400 mt-0.5">
          <span>{{ t('room.trendAgo') }}</span>
          <span>{{ t('room.trendNow') }}</span>
        </div>
      </div>

      <!-- 统计信息：总量 + 峰值 + 时长 -->
      <div class="flex items-center gap-4 text-xs text-gray-500 flex-wrap">
        <span class="tabular-nums">{{ t('room.trafficTotal') }} {{ formatBytes(tunnelStore.bytesSent) }} / {{ formatBytes(tunnelStore.bytesReceived) }}</span>
        <span class="tabular-nums">{{ t('room.peakValue') }} {{ displayPeakSendStr }} / {{ displayPeakReceiveStr }}</span>
        <span v-if="connectionDuration > 0" class="tabular-nums">{{ t('room.duration') }} {{ formatDuration(connectionDuration) }}</span>
      </div>
    </div>

    <!-- 断开连接 -->
    <div class="text-center mt-6">
      <n-button type="error" ghost @click="handleDisconnect">
        <template #icon><span class="iconfont icon-yizhongduan" /></template>
        {{ t('room.disconnect') }}
      </n-button>
    </div>
  </div>
</template>
