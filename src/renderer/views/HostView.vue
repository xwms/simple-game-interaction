/**
 * 创建房间页
 *
 * 使用方式：路由 '/host'
 * 逻辑说明：自动扫描本机游戏（每 5 秒刷新），网络检测结果从全局读取。
 *           自动检测不到时支持手动输入端口。
 *           用户选择一个游戏后点击"创建房间"。
 */

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useRoomStore } from '../store/room'
import GameCard from '../components/GameCard.vue'
import { useNetworkDetect, natTypeLabel, inferConnectionPath } from '../composables/useNetworkDetect'

const router = useRouter()
const roomStore = useRoomStore()
const { status, result, refresh } = useNetworkDetect()
const { t } = useI18n()

onMounted(() => {
  if (roomStore.roomCode) {
    router.replace('/room/' + roomStore.roomCode)
    return
  }
  roomStore.error = null
})

const games = ref<any[]>([])
const isScanning = ref(true)
const selectedGame = ref<string | null>(null)
const isCreating = ref(false)

// ─── 手动输入 ───────────────────────────────────────
const showManualInput = ref(false)
const manualGameId = ref('minecraft-java')
const manualPort = ref<number | null>(null)
const availableGames = [
  { id: 'minecraft-java', name: 'Minecraft: Java Edition', defaultPort: 25565 },
  { id: 'terraria', name: 'Terraria', defaultPort: 7777 },
  { id: 'stardew-valley', name: 'Stardew Valley', defaultPort: 24642 },
  { id: 'factorio', name: 'Factorio', defaultPort: 34197 },
  { id: 'valheim', name: 'Valheim', defaultPort: 2456 },
  { id: 'csgo', name: 'Counter-Strike: GO', defaultPort: 27015 },
  { id: 'openarena', name: 'OpenArena', defaultPort: 27960 },
  { id: 'donut-server', name: 'Donut Server', defaultPort: 24860 }
]

// ─── 定时刷新 ───────────────────────────────────────
let refreshTimer: ReturnType<typeof setInterval> | null = null

/**
 * 功能描述：扫描本机游戏
 */
async function scanGames(): Promise<void> {
  try {
    const res = await window.electronAPI.invoke('game:detect-local')
    if (res.success) {
      const all = (res.data as any[]) || []
      games.value = all.filter((g: any) => g.running && g.portOpen)
      games.value.sort((a: any, b: any) => (b.running ? 1 : 0) - (a.running ? 1 : 0))
    }
  } finally {
    isScanning.value = false
  }
}

/**
 * 功能描述：手动添加一个游戏到列表
 */
function addManualGame(): void {
  const selected = availableGames.find((g) => g.id === manualGameId.value)
  if (!selected) return

  const port = Number(manualPort.value) || selected.defaultPort
  const existIdx = games.value.findIndex(
    (g: any) => g.gameId === `manual-${selected.id}` && g.port === port
  )
  if (existIdx >= 0) {
    selectedGame.value = games.value[existIdx].gameId
    showManualInput.value = false
    return
  }

  const entry = {
    gameId: `manual-${selected.id}`,
    name: `${selected.name}${t('host.manualSuffix')}`,
    port,
    running: true,
    portOpen: true,
    pid: undefined,
    processName: undefined
  }
  games.value.unshift(entry)
  selectedGame.value = entry.gameId
  showManualInput.value = false
}

/**
 * 功能描述：创建房间
 */
async function handleCreate(): Promise<void> {
  if (!selectedGame.value || isCreating.value) return
  isCreating.value = true

  let game = games.value.find((g: any) => g.gameId === selectedGame.value)
  const actualGameId = selectedGame.value.replace(/^manual-/, '')
  const port = game?.port ?? 0
  const name = game?.gameName ?? actualGameId

  if (port === 0) {
    roomStore.error = t('host.portInvalid')
    isCreating.value = false
    return
  }

  await roomStore.createRoom(actualGameId, port, name)
  isCreating.value = false

  if (roomStore.roomCode) {
    router.push(`/room/${roomStore.roomCode}`)
  }
}

// ─── 生命周期 ───────────────────────────────────────
scanGames()
refreshTimer = setInterval(scanGames, 5000)

onUnmounted(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
})
</script>

<template>
  <div class="host-view p-6 flex justify-center">
    <div class="w-full max-w-lg">
      <h2 class="text-xl font-bold mb-5">{{ t('host.title') }}</h2>

      <!-- 网络检测状态 -->
      <div class="mb-4">
        <div v-if="status === 'detecting'" class="card px-4 py-3 flex items-center gap-3 text-sm">
          <n-spin size="small" />
          <span class="text-gray-500">{{ t('host.detecting') }}</span>
        </div>
        <div v-else-if="status === 'error'" class="card px-4 py-3 flex items-center gap-2 text-sm text-red-400">
          <span class="iconfont icon-wangluozhongduan text-lg" />
          <span style="color:#ef4444!important">{{ t('home.offline') }}</span>
          <button class="ml-auto text-primary hover:underline" @click="refresh">{{ t('home.retry') }}</button>
        </div>
        <div v-else-if="status === 'done' && result" class="card px-4 py-3 flex items-center gap-3 text-sm text-gray-500">
          <span v-if="inferConnectionPath(result).type !== 'none'" class="flex items-center gap-1.5">
            <span class="inline-block w-2 h-2 rounded-full" :class="result.ipv6.available ? 'bg-green-500' : 'bg-gray-400'" />
            <span class="text-gray-600 dark:text-gray-300">{{ result.ipv6.hasPublicV6 ? t('home.ipv6Public') : result.ipv6.available ? t('home.ipv6Available') : t('home.ipv6Unavailable') }}</span>
          </span>
          <template v-if="natTypeLabel(result.ipv4)">
            <span class="text-gray-300 dark:text-gray-600">|</span>
            <span class="text-gray-600 dark:text-gray-300">{{ natTypeLabel(result.ipv4) }}</span>
            <span class="text-gray-300 dark:text-gray-600">|</span>
          </template>
          <span class="font-medium" :class="inferConnectionPath(result).type === 'none' ? 'text-red-500' : 'text-primary'">{{ t('join.expectedPath') }}{{ inferConnectionPath(result).label }}</span>
          <button class="ml-auto w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors" @click="refresh" :title="t('home.retry')">
            <span class="iconfont icon-shuaxin" />
          </button>
        </div>
      </div>

      <!-- 游戏扫描 / 列表 -->
      <div class="card p-5 mb-4">
        <div class="flex items-center justify-between mb-3">
          <span class="text-sm font-medium text-gray-600 dark:text-gray-300">{{ t('host.localGames') }}</span>
          <span v-if="!isScanning" class="text-xs text-gray-400">{{ t('host.gamesDetected', { count: games.length }) }}</span>
        </div>

        <div v-if="isScanning" class="text-gray-500 text-sm flex items-center gap-2 py-4 justify-center">
          <n-spin size="small" />
          {{ t('host.scanning') }}
        </div>

        <div v-else-if="games.length === 0" class="text-gray-400 text-sm text-center py-6">
          {{ t('host.noGames') }}
          <div class="mt-2">
            <button class="text-xs text-primary hover:underline" @click="showManualInput = true">{{ t('host.manualPort') }}</button>
          </div>
        </div>

        <div v-else class="space-y-2">
          <GameCard
            v-for="game in games"
            :key="game.gameId"
            :game="game"
            :selected="selectedGame === game.gameId"
            @select="selectedGame = game.gameId"
          />
        </div>

        <!-- 手动添加入口 -->
        <div v-if="games.length > 0 && !showManualInput" class="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
          <button class="text-xs text-primary hover:underline inline-flex items-center gap-1" @click="showManualInput = true">
            {{ t('host.manualPort') }}
          </button>
        </div>
      </div>

      <!-- 手动输入面板 -->
      <div v-if="showManualInput" class="card p-4 mb-4 border border-dashed border-primary/30 dark:border-primary/20">
        <div class="text-xs text-gray-500 mb-3">{{ t('host.manualTitle') }}</div>
        <div class="flex gap-2 mb-3">
          <n-select
            v-model:value="manualGameId"
            :options="availableGames.map(g => ({ label: g.name, value: g.id }))"
            class="flex-1"
            size="small"
          />
          <n-input-number
            v-model:value="manualPort"
            :placeholder="t('host.portPlaceholder')"
            class="w-28"
            size="small"
            :min="1" :max="65535"
            :precision="0"
          />
        </div>
        <div class="flex gap-2">
          <n-button size="small" @click="showManualInput = false">{{ t('host.cancel') }}</n-button>
          <n-button size="small" @click="addManualGame">{{ t('host.confirm') }}</n-button>
        </div>
      </div>

      <!-- 错误提示 -->
      <n-alert v-if="roomStore.error" type="error" :bordered="false" class="mb-4" closable @close="roomStore.error = null">
        {{ roomStore.error }}
      </n-alert>

      <!-- 操作按钮 -->
      <div class="flex items-center justify-between pt-4 border-t border-gray-100 dark:border-gray-700">
        <n-button @click="router.push('/')">{{ t('host.back') }}</n-button>
        <n-button
          :disabled="!selectedGame || isCreating"
          :loading="isCreating"
          @click="handleCreate"
        >
          {{ t('host.create') }}
        </n-button>
      </div>

      <!-- 自动刷新提示 -->
      <div class="mt-4 text-xs text-gray-400 text-center">
        {{ t('host.autoRefresh') }}
      </div>
    </div>
  </div>
</template>
