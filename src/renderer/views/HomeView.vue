/**
 * 首页
 *
 * 使用方式：路由 '/'
 * 逻辑说明：顶部两个操作按钮（创建/加入房间）；中间显示网络检测状态；
 *           再下方显示当前版本更新日志；底部显示版本号和更新状态。
 */

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useRoomStore } from '../store/room'
import { useNetworkDetect, natTypeLabel, inferConnectionPath } from '../composables/useNetworkDetect'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { version as appVersion } from '../../../package.json'
import { getCachedUpdate, fetchUpdate, getDownloadState, startBackgroundDownload } from '../utils/update-cache'
import type { UpdateCheckData } from '../utils/update-cache'

const router = useRouter()
const roomStore = useRoomStore()
const { status, result, refresh } = useNetworkDetect()
const { t } = useI18n()

// 同步恢复缓存状态，避免组件挂载后闪烁
const _cachedInit = getCachedUpdate()
const currentVersion = ref(appVersion)
const updateStatus = ref<'checking' | 'latest' | 'available' | 'error' | 'downloading' | 'done'>(
  _cachedInit
    ? _cachedInit.hasUpdate
      ? _cachedInit.installAvailable ? 'done' : 'available'
      : 'latest'
    : 'checking'
)
const updateVersion = ref(_cachedInit?.version || '')
const releaseNotes = ref(_cachedInit?.releaseNotes || '')
const checkError = ref('')

const updateDownloadUrl = ref(_cachedInit?.downloadUrl || '')
const updateFilePath = ref(_cachedInit?.installPath || '')
const downloadedBytes = ref(_cachedInit?.downloadedBytes || 0)
const downloadState = getDownloadState()

/**
 * 功能描述：检查更新（带 5 分钟缓存）
 */
async function checkUpdate(): Promise<void> {
  const cached = getCachedUpdate()
  if (cached) {
    applyUpdateData(cached)
    return
  }

  updateStatus.value = 'checking'
  checkError.value = ''
  try {
    const data = await fetchUpdate(currentVersion.value)
    if (data) {
      applyUpdateData(data)
    } else {
      updateStatus.value = 'error'
      checkError.value = t('home.updateCheckFailed')
    }
  } catch {
    updateStatus.value = 'error'
    checkError.value = t('home.updateCheckFailed')
  }
}

/**
 * 功能描述：将更新数据应用到响应式状态
 *
 * @param data - 更新检查返回的数据
 */
function applyUpdateData(data: UpdateCheckData): void {
  updateVersion.value = data.version
  releaseNotes.value = data.releaseNotes || ''

  if (!data.hasUpdate) {
    updateStatus.value = 'latest'
    return
  }

  // 下载进行中或已完成，不覆盖状态
  if (updateStatus.value !== 'downloading' && updateStatus.value !== 'done') {
    if (data.installAvailable) {
      updateStatus.value = 'done'
      if (data.installPath) updateFilePath.value = data.installPath
    } else {
      updateStatus.value = 'available'
    }
  }
  updateDownloadUrl.value = data.downloadUrl || ''
  downloadedBytes.value = data.downloadedBytes || 0
}

/**
 * 功能描述：下载更新（后台运行，不阻塞 UI）
 *
 * 逻辑说明：改为 fire-and-forget 模式。App.vue 的持久监听器负责更新
 *           全局 downloadState，本组件通过 watch 同步状态变化。
 */
async function handleDownload(): Promise<void> {
  if (!updateDownloadUrl.value) return
  updateStatus.value = 'downloading'
  startBackgroundDownload(updateDownloadUrl.value, updateVersion.value)
}

// 同步全局下载状态到本地状态
watch(() => downloadState.done, (done) => {
  if (done) {
    updateFilePath.value = downloadState.filePath
    updateStatus.value = 'done'
  }
})

watch(() => downloadState.error, (err) => {
  if (err && !downloadState.isDownloading) {
    updateStatus.value = 'error'
  }
})

/**
 * 功能描述：安装更新
 */
async function handleInstall(): Promise<void> {
  if (!updateFilePath.value) return
  try {
    await window.electronAPI.invoke('update:install', updateFilePath.value)
  } catch {
    // 静默失败
  }
}

/**
 * 功能描述：标题显示的版本号 — 有更新时显示新版号，否则显示当前版本
 */
const headingVersion = computed(() =>
  updateStatus.value === 'available' || updateStatus.value === 'done'
    ? (updateVersion.value || currentVersion.value)
    : currentVersion.value
)

const renderedNotes = computed(() => {
  if (!releaseNotes.value) return ''
  const html = marked.parse(releaseNotes.value, { async: false }) as string
  return DOMPurify.sanitize(html)
})

onMounted(() => {
  // 恢复后台下载状态（全局状态 persist，本地 updateStatus 从缓存恢复可能不一致）
  if (downloadState.done) {
    updateFilePath.value = downloadState.filePath
    updateStatus.value = 'done'
  } else if (downloadState.isDownloading) {
    updateStatus.value = 'downloading'
  }

  setTimeout(checkUpdate, 3000)
})
</script>

<template>
  <!-- 两栏 flex，顶部自然对齐 -->
  <div class="home-view flex h-full p-6 gap-8">
    <!-- 左栏：卡片 + 网络检测 + 版本 -->
    <div class="flex-1 flex flex-col gap-5 max-w-sm">
      <!-- 操作卡片并排 -->
      <div class="flex gap-4">
        <div
          class="group flex-1 card card-hover p-5 flex flex-col items-center gap-3 cursor-pointer text-center"
          :class="{ 'opacity-50 pointer-events-none': !!roomStore.roomCode }"
          @click="roomStore.roomCode ? router.push('/room/' + roomStore.roomCode) : router.push('/host')"
        >
          <div class="w-14 h-14 rounded-2xl bg-primary/10 dark:bg-primary/20 flex items-center justify-center group-hover:scale-110 group-hover:bg-primary/15 dark:group-hover:bg-primary/30 transition-all duration-200">
            <span class="iconfont icon-chuangjianfangjian text-[1.65rem] text-primary" />
          </div>
          <div>
            <div class="font-bold text-base">{{ t('home.createRoom') }}</div>
            <div class="text-xs text-gray-400 mt-0.5">{{ t('home.createDesc') }}</div>
          </div>
        </div>

        <div
          class="group flex-1 card card-hover p-5 flex flex-col items-center gap-3 cursor-pointer text-center"
          :class="{ 'opacity-50 pointer-events-none': !!roomStore.roomCode }"
          @click="roomStore.roomCode ? router.push('/room/' + roomStore.roomCode) : router.push('/join')"
        >
          <div class="w-14 h-14 rounded-2xl bg-accent/10 dark:bg-accent/20 flex items-center justify-center group-hover:scale-110 group-hover:bg-accent/15 dark:group-hover:bg-accent/30 transition-all duration-200">
            <span class="iconfont icon-jiarufangjian text-[1.65rem] text-accent" />
          </div>
          <div>
            <div class="font-bold text-base">{{ t('home.joinRoom') }}</div>
            <div class="text-xs text-gray-400 mt-0.5">{{ t('home.joinDesc') }}</div>
          </div>
        </div>
      </div>

      <!-- 网络检测状态 -->
      <div>
        <div v-if="status === 'detecting'" class="card px-4 py-3 flex items-center gap-3 text-sm">
          <n-spin size="small" />
          <span class="text-gray-500">{{ t('home.detecting') }}</span>
        </div>

        <div v-else-if="status === 'done' && result" class="card px-4 py-3 flex items-center gap-2 text-sm flex-wrap">
          <div v-if="inferConnectionPath(result).type !== 'none'" class="flex items-center gap-1.5">
            <span class="inline-block w-2 h-2 rounded-full" :class="result.ipv6.available ? 'bg-green-500' : 'bg-gray-400'" />
            <span class="text-gray-600 dark:text-gray-300">
              {{ result.ipv6.hasPublicV6 ? t('home.ipv6Public') : result.ipv6.available ? t('home.ipv6Local') : t('home.ipv6Unavailable') }}
            </span>
          </div>
          <template v-if="natTypeLabel(result.ipv4)">
            <span class="text-gray-300 dark:text-gray-600">|</span>
            <span class="text-gray-600 dark:text-gray-300">{{ natTypeLabel(result.ipv4) }}</span>
          </template>
          <button class="ml-auto w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors" @click="refresh" :title="t('home.retry')">
            <span class="iconfont icon-shuaxin" />
          </button>
        </div>

        <div v-else-if="status === 'error'" class="card px-4 py-3 flex items-center gap-2 text-sm text-gray-400">
          <span class="iconfont icon-wangluozhongduan text-lg" />
          <span style="color:#ef4444!important">{{ t('home.offline') }}</span>
          <button class="ml-auto text-primary hover:underline text-xs" @click="refresh">{{ t('home.retry') }}</button>
        </div>
      </div>

      <div class="flex-1" />

      <!-- 底部版本 -->
      <div class="text-xs text-gray-400 text-center leading-relaxed">
        <template v-if="updateStatus === 'checking'">
          <span class="inline-flex items-center gap-1">v{{ currentVersion }} · {{ t('home.updateChecking') }}</span>
        </template>
        <template v-else-if="updateStatus === 'latest'">
          <span class="inline-flex items-center gap-1">v{{ currentVersion }} · {{ t('home.updateLatest') }}</span>
        </template>
        <template v-else-if="updateStatus === 'error'">
          <span class="inline-flex items-center gap-1 text-red-500">{{ checkError || t('home.updateCheckFailed') }}</span>
        </template>
        <template v-else-if="updateStatus === 'available'">
          v{{ currentVersion }} · <span class="text-primary cursor-pointer hover:underline inline-flex items-center gap-1" @click="handleDownload"><span class="iconfont icon-banbengengxin" />{{ downloadedBytes > 0 ? t('home.updateResume') : t('home.updateAvailable', { version: updateVersion }) }}</span>
        </template>
        <template v-else-if="updateStatus === 'downloading' || downloadState.isDownloading">
          v{{ currentVersion }} · {{ t('home.downloading', { progress: downloadState.progress }) }}
          <div class="w-32 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full mt-1 mx-auto overflow-hidden"><div class="h-full bg-primary rounded-full transition-all duration-300" :style="{ width: downloadState.progress + '%' }"></div></div>
        </template>
        <template v-else-if="updateStatus === 'done'">
          v{{ currentVersion }} · <span class="text-green-500 cursor-pointer hover:underline inline-flex items-center gap-1" @click="handleInstall">{{ t('home.installUpdate', { version: updateVersion }) }}</span>
        </template>
        <template v-else>v{{ currentVersion }}</template>
      </div>
    </div>

    <!-- 右栏：更新日志，顶部与卡片顶部自然对齐 -->
    <div class="flex-1 flex flex-col">
      <div class="card flex-1 p-5 prose prose-sm dark:prose-invert max-w-none overflow-y-auto">
        <div class="text-xs mb-3 flex items-center gap-1.5" :class="updateStatus === 'available' || updateStatus === 'done' ? 'text-primary' : 'text-gray-400'">
          <span class="iconfont icon-banbengengxin" />
          {{ t('home.updateContent', { version: headingVersion }) }}
          <span v-if="updateStatus === 'available' || updateStatus === 'done'" class="ml-1.5 px-2 py-0.5 rounded text-xs leading-none font-bold bg-primary text-white">{{ t('home.newBadge') }}</span>
        </div>
        <div v-if="checkError" class="text-sm text-red-500 flex items-center justify-center py-12">
          {{ checkError }}
        </div>
        <div v-else-if="renderedNotes" v-html="renderedNotes" class="text-sm leading-relaxed"></div>
        <div v-else class="text-sm text-gray-400 flex items-center justify-center py-12">
          {{ t('home.noReleaseNotes') }}
        </div>
      </div>
    </div>
  </div>
</template>
