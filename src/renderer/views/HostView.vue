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
import { useRoomStore } from '../store/room'
import GameCard from '../components/GameCard.vue'
import { useNetworkDetect, natTypeLabel, inferConnectionPath } from '../composables/useNetworkDetect'

const router = useRouter()
const roomStore = useRoomStore()
const { status, result, refresh } = useNetworkDetect()

// 进入页面时清除残留错误
onMounted(() => {
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
      // 只显示检测到的游戏（进程运行或端口开放）
      games.value = all.filter((g: any) => g.running || g.portOpen)
      // 按运行中优先排序
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

  const port = manualPort.value || selected.defaultPort
  // 检查是否已存在同类手动项
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
    name: `${selected.name}（手动）`,
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

  // 先从自动检测列表中找，再从手动列表找
  let game = games.value.find((g: any) => g.gameId === selectedGame.value)
  // 手动添加的 gameId 带 manual- 前缀，传给 store 时去掉
  const actualGameId = selectedGame.value.replace(/^manual-/, '')
  const port = game?.port ?? 0
  const name = game?.gameName ?? actualGameId

  console.log(`创建房间: gameId=${actualGameId} port=${port} name=${name}`)
  if (port === 0) {
    roomStore.error = '游戏端口无效（0），请手动输入端口号'
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
// 页面挂载时自动扫描，之后每 5 秒刷新
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
  <div class="host-view p-6">
    <h2 class="text-xl font-bold mb-4">创建房间</h2>

    <!-- 网络检测状态（从全局共享状态读取） -->
    <div v-if="status === 'detecting'" class="mb-4 text-xs text-gray-400 flex items-center gap-2">
      <n-spin size="small" />
      检测网络中...
    </div>
    <div v-else-if="status === 'done' && result" class="mb-4 text-xs text-gray-400 flex items-center gap-3">
      <span class="flex items-center gap-1">
        <span class="inline-block w-2 h-2 rounded-full"
          :class="result.ipv6.available ? 'bg-green-500' : 'bg-gray-400'">
        </span>
        IPv6 {{ result.ipv6.hasPublicV6 ? '公网' : result.ipv6.available ? '可用' : '×' }}
      </span>
      <span>NAT {{ natTypeLabel(result.ipv4) }}</span>
      <span class="text-primary">{{ inferConnectionPath(result).label }}</span>
      <button class="text-gray-400 hover:text-gray-600" @click="refresh" title="重新检测">↻</button>
    </div>

    <div v-if="isScanning" class="text-gray-500 mb-4 flex items-center gap-2">
      <n-spin size="small" />
      正在扫描本机游戏...
    </div>

    <div v-else-if="games.length === 0" class="text-gray-500 mb-4">
      未检测到游戏，请确保游戏服务器已启动
    </div>

    <div v-else class="space-y-3 mb-4">
      <GameCard
        v-for="game in games"
        :key="game.gameId"
        :game="game"
        :selected="selectedGame === game.gameId"
        @select="selectedGame = game.gameId"
      />
    </div>

    <!-- 错误提示 -->
    <div v-if="roomStore.error" class="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-600 dark:text-red-400">
      {{ roomStore.error }}
    </div>

    <!-- 手动输入端口 -->
    <div class="mb-6">
      <button
        v-if="!showManualInput"
        class="text-xs text-primary hover:underline"
        @click="showManualInput = true"
      >
        + 手动输入端口
      </button>

      <div v-else class="bg-gray-50 dark:bg-gray-800 rounded-xl p-4 space-y-3">
        <div class="text-xs text-gray-500 mb-1">手动指定游戏和端口</div>
        <div class="flex gap-2">
          <select
            v-model="manualGameId"
            class="flex-1 px-3 py-2 text-sm border rounded-lg bg-white dark:bg-gray-700"
          >
            <option v-for="g in availableGames" :key="g.id" :value="g.id">
              {{ g.name }}
            </option>
          </select>
          <input
            v-model.number="manualPort"
            type="number"
            class="w-28 px-3 py-2 text-sm border rounded-lg bg-white dark:bg-gray-700"
            placeholder="端口号"
            min="1"
            max="65535"
          />
        </div>
        <div class="flex gap-2">
          <n-button size="small" @click="showManualInput = false">取消</n-button>
          <n-button size="small" type="primary" @click="addManualGame">确认添加</n-button>
        </div>
      </div>
    </div>

    <div class="flex gap-3">
      <n-button @click="router.push('/')">返回</n-button>
      <n-button
        type="primary"
        :disabled="!selectedGame"
        :loading="isCreating"
        @click="handleCreate"
      >
        创建房间
      </n-button>
    </div>

    <!-- 自动刷新提示 -->
    <div class="mt-4 text-xs text-gray-400 text-center">
      每 5 秒自动刷新
    </div>
  </div>
</template>
