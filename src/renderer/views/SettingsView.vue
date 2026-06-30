/**
 * 设置页
 *
 * 使用方式：路由 '/settings'
 * 逻辑说明：设置分为四个分组 — 通用（语言/主题/关闭行为/更新）、
 *           连接（中继地址/本地端口）、外观（背景图片/卡片透明度）、
 *           日志（日志路径）。
 *           更新流程三态：检查 → 发现新版本（下载）→ 下载完成（安装）。
 */

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage, useDialog } from 'naive-ui'
import { useSettingsStore } from '../store/settings'
import { fetchUpdate, getDownloadState, startBackgroundDownload } from '../utils/update-cache'

const settings = useSettingsStore()
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()

/** 本地端口验证状态 */
const localPortStatus = computed(() => {
  const v = settings.localPort
  if (v === 0) return 'success'
  if (!Number.isInteger(v) || v < 0 || v > 65535) return 'error'
  return 'success'
})

/**
 * 功能描述：选择日志文件目录
 */
async function handleSelectLogDir(): Promise<void> {
  const result = await window.electronAPI.invoke('app:select-log-directory')
  if (result.success && result.data) {
    settings.logFilePath = result.data as string
    // 同步到主进程
    await window.electronAPI.invoke('app:set-log-file-path', result.data)
    message.success(t('settings.logPathUpdated'))
  }
}

/**
 * 功能描述：恢复默认日志文件路径
 */
async function handleResetLogDir(): Promise<void> {
  settings.logFilePath = ''
  await window.electronAPI.invoke('app:set-log-file-path', null)
  message.success(t('settings.logPathReset'))
}

/**
 * 功能描述：删除所有日志文件（弹出确认对话框）
 */
function handleDeleteAllLogs(): void {
  dialog.warning({
    title: t('settings.logCleanupAll'),
    content: t('settings.logCleanupAllConfirm'),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    positiveButtonProps: { type: 'success' },
    onPositiveClick: async () => {
      const result = await window.electronAPI.invoke('log:delete-all')
      if (result.success) {
        const count = result.data?.deletedCount ?? 0
        message.success(t('settings.logCleanupDone', { count }))
      }
    }
  })
}

// 保留天数变化时提示
watch(() => settings.logRetentionDays, (days) => {
  if (days && days > 0) {
    message.info(t('settings.logRetentionChanged'))
  } else if (days === 0) {
    message.info(t('settings.logRetentionDisabled'))
  }
})

type UpdateState = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'done' | 'installing' | 'error'

const updateState = ref<UpdateState>('idle')
const updateVersion = ref('')
const updateDownloadUrl = ref('')
const updateFilePath = ref('')
const downloadedBytes = ref(0)
const downloadState = getDownloadState()

/**
 * 功能描述：手动检查更新（带缓存）
 *
 * 逻辑说明：通过共享缓存模块获取更新数据。如果已有下载完成的安装包
 *          （installAvailable=true）则直接进入 done 状态；否则进入 available 状态。
 */
async function handleCheckUpdate(): Promise<void> {
  updateState.value = 'checking'
  try {
    const data = await fetchUpdate()
    if (data) {
      if (data.hasUpdate) {
        updateVersion.value = data.version
        updateDownloadUrl.value = data.downloadUrl || ''
        downloadedBytes.value = data.downloadedBytes || 0
        if (data.installAvailable && data.installPath) {
          updateFilePath.value = data.installPath
          updateState.value = 'done'
        } else if (downloadState.isDownloading) {
          updateState.value = 'downloading'
        } else {
          updateState.value = 'available'
        }
      } else {
        updateState.value = 'latest'
      }
    } else {
      updateState.value = 'error'
    }
  } catch {
    updateState.value = 'error'
  }
}

/**
 * 功能描述：下载更新包（后台运行，不阻塞 UI）
 *
 * 逻辑说明：改为 fire-and-forget 模式，App.vue 的持久监听器更新全局
 *           downloadState，本组件通过 watch 同步状态变化。
 */
async function handleDownload(): Promise<void> {
  if (!updateDownloadUrl.value) return
  updateState.value = 'downloading'
  startBackgroundDownload(updateDownloadUrl.value, updateVersion.value)
}

// 同步全局下载状态
watch(() => downloadState.done, (done) => {
  if (done) {
    updateFilePath.value = downloadState.filePath
    updateState.value = 'done'
  }
})

watch(() => downloadState.error, (err) => {
  if (err && !downloadState.isDownloading) {
    updateState.value = 'error'
  }
})

/**
 * 功能描述：安装更新
 *
 * 逻辑说明：调用主进程 update:install IPC 启动安装程序。
 *           安装器以 detached 模式运行，不会阻塞应用。
 */
async function handleInstall(): Promise<void> {
  if (!updateFilePath.value) return
  updateState.value = 'installing'
  message.info(t('settings.updateStarting'))
  try {
    const result = await window.electronAPI.invoke('update:install', updateFilePath.value)
    if (result.success) {
      message.success(t('settings.updateStarted'))
    } else {
      message.error(t('settings.updateStartFailed'))
      updateState.value = 'done'
    }
  } catch (err) {
    message.error(t('settings.updateError') + ': ' + String(err))
    updateState.value = 'done'
  }
}

/**
 * 功能描述：选择背景图片
 */
async function handleSelectBg(): Promise<void> {
  await settings.selectBackgroundImage()
  if (settings.backgroundDataUrl) {
    message.success(t('settings.backgroundSet'))
  }
}

/**
 * 功能描述：移除背景图片
 */
function handleRemoveBg(): void {
  settings.removeBackgroundImage()
  message.success(t('settings.backgroundRemoved'))
}

// 进入页面时如果后台下载已完成，同步状态
onMounted(() => {
  if (downloadState.done) {
    updateFilePath.value = downloadState.filePath
    updateState.value = 'done'
  } else if (downloadState.isDownloading) {
    updateState.value = 'downloading'
  }
})
</script>

<template>
  <div class="settings-view p-6 max-w-lg mx-auto">
    <h2 class="text-xl font-bold mb-6">{{ t('settings.title') }}</h2>

    <!-- ═══════ 通用 ═══════ -->
    <div class="mb-6">
      <h3 class="text-sm font-semibold text-gray-400 dark:text-gray-500 tracking-wider mb-3 px-1">{{ t('settings.groupGeneral') }}</h3>
      <div class="card p-5 space-y-5">
        <!-- 语言 -->
        <div>
          <label class="block text-sm text-gray-500 mb-2 flex items-center gap-1.5">
            {{ t('settings.language') }}
          </label>
          <n-select
            :value="settings.locale"
            :options="[
              { label: '中文', value: 'zh-CN' },
              { label: 'English', value: 'en-US' }
            ]"
            @update-value="settings.setLocale"
          />
        </div>

        <!-- 主题 -->
        <div>
          <label class="block text-sm text-gray-500 mb-2 flex items-center gap-1.5">
            {{ t('settings.theme') }}
          </label>
          <n-select
            :value="settings.theme"
            :options="[
              { label: t('settings.themeLight'), value: 'light' },
              { label: t('settings.themeDark'), value: 'dark' },
              { label: t('settings.themeAuto'), value: 'auto' }
            ]"
            @update-value="settings.setTheme"
          />
        </div>

        <!-- 关闭行为 -->
        <div>
          <label class="block text-sm text-gray-500 mb-2 flex items-center gap-1.5">
            {{ t('settings.closeBehavior') }}
          </label>
          <n-select
            :value="settings.closeBehavior"
            :options="[
              { label: t('settings.closeHide'), value: 'hide' },
              { label: t('settings.closeQuit'), value: 'quit' }
            ]"
            @update-value="(v: 'quit' | 'hide') => settings.closeBehavior = v"
          />
        </div>

        <!-- 自动检查更新 -->
        <div class="flex items-center justify-between pt-1">
          <span class="text-sm flex items-center gap-1.5">
            {{ t('settings.autoUpdate') }}
          </span>
          <n-switch v-model:value="settings.autoUpdateCheck" />
        </div>

        <!-- 手动检查更新 -->
        <div class="pt-2 border-t border-gray-100 dark:border-gray-700">
          <div class="text-sm text-gray-500 mb-3 flex items-center gap-1.5">
            {{ t('settings.checkUpdate') }}
          </div>

          <n-button
            v-if="updateState === 'idle' || updateState === 'checking'"
            quaternary
            :loading="updateState === 'checking'"
            @click="handleCheckUpdate"
          >
            <template #icon><span class="iconfont icon-banbengengxin" /></template>
            {{ t('settings.checkUpdate') }}
          </n-button>

          <div v-else-if="updateState === 'latest'" class="flex items-center gap-2">
            <span class="text-sm text-gray-500">{{ t('settings.updateLatest') }}</span>
            <button class="ml-2 text-xs text-gray-400 hover:text-gray-600 inline-flex items-center gap-1" @click="handleCheckUpdate">
              {{ t('settings.checkUpdate') }}
            </button>
          </div>

          <div v-else-if="updateState === 'available'">
            <n-button quaternary @click="handleDownload">
              {{ downloadedBytes > 0 ? t('home.updateResume') : t('settings.updateAvailable', { version: updateVersion }) }}
            </n-button>
          </div>

          <div v-else-if="updateState === 'downloading' || downloadState.isDownloading" class="flex flex-col gap-2">
            <span class="text-sm text-gray-500">
              {{ t('settings.updateDownloading', { progress: downloadState.progress }) }}
            </span>
            <div class="w-48 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div class="h-full bg-primary rounded-full transition-all duration-300" :style="{ width: downloadState.progress + '%' }"></div>
            </div>
          </div>

          <div v-else-if="updateState === 'done'">
            <n-button quaternary @click="handleInstall" type="primary">
              {{ t('settings.updateInstall', { version: updateVersion }) }}
            </n-button>
          </div>

          <div v-else-if="updateState === 'installing'">
            <n-button quaternary loading type="primary">
              {{ t('settings.updateStarting') }}
            </n-button>
          </div>

          <div v-else-if="updateState === 'error'" class="flex items-center gap-2">
            <span class="text-sm text-gray-500">{{ t('settings.updateCheckFailed') }}</span>
            <button class="ml-2 text-xs text-primary hover:underline inline-flex items-center gap-1" @click="handleCheckUpdate">
              {{ t('home.retry') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══════ 连接 ═══════ -->
    <div class="mb-6">
      <h3 class="text-sm font-semibold text-gray-400 dark:text-gray-500 tracking-wider mb-3 px-1">{{ t('settings.groupConnection') }}</h3>
      <div class="card p-5 space-y-5">
        <!-- 中继服务器 -->
        <div>
          <label class="block text-sm text-gray-500 mb-2 flex items-center gap-1.5">
            {{ t('settings.relayServer') }}
          </label>
          <n-input v-model:value="settings.relayServerUrl" placeholder="wss://..." />
        </div>

        <!-- 本地端口（加入者） -->
        <div>
          <label class="block text-sm text-gray-500 mb-2 flex items-center gap-1.5">
            {{ t('settings.localPort') }}
          </label>
          <n-input-number v-model:value="settings.localPort" :min="0" :max="65535" :precision="0" :status="localPortStatus" placeholder="0" class="w-40" />
          <p v-if="localPortStatus === 'error'" class="text-xs text-red-500 mt-1">{{ t('settings.localPortError') }}</p>
          <p v-else class="text-xs text-gray-400 mt-1">{{ t('settings.localPortHint') }}</p>
        </div>
      </div>
    </div>

    <!-- ═══════ 外观 ═══════ -->
    <div class="mb-6">
      <h3 class="text-sm font-semibold text-gray-400 dark:text-gray-500 tracking-wider mb-3 px-1">{{ t('settings.groupAppearance') }}</h3>
      <div class="card p-5 mb-4 space-y-5">
        <!-- 背景图片 -->
        <div>
          <label class="block text-sm text-gray-500 mb-3 flex items-center gap-1.5">
            {{ t('settings.backgroundImage') }}
          </label>

          <div v-if="settings.backgroundDataUrl" class="relative w-full h-28 rounded-lg overflow-hidden mb-3 border border-gray-200 dark:border-gray-700">
            <img :src="settings.backgroundDataUrl" class="w-full h-full object-cover" />
            <div class="absolute inset-0" :style="{ backgroundColor: `rgba(0,0,0,${settings.backgroundOpacity / 100})` }"></div>
          </div>

          <div class="flex items-center gap-2">
            <n-button size="small" @click="handleSelectBg">{{ t('settings.backgroundSelect') }}</n-button>
            <n-button v-if="settings.backgroundImage" size="small" @click="handleRemoveBg">{{ t('settings.backgroundRemove') }}</n-button>
          </div>

          <div v-if="settings.backgroundImage" class="mt-3 flex items-center gap-3">
            <span class="text-xs text-gray-400 w-14 flex-shrink-0">{{ t('settings.backgroundOpacity') }} {{ settings.backgroundOpacity }}%</span>
            <n-slider v-model:value="settings.backgroundOpacity" :min="0" :max="80" :step="5" class="flex-1" />
          </div>
        </div>

        <!-- 卡片透明度 -->
        <div>
          <div class="flex items-center justify-between">
            <label class="block text-sm text-gray-500 flex items-center gap-1.5">
              {{ t('settings.cardOpacity') }}
            </label>
            <span class="text-xs text-gray-400">{{ settings.cardOpacity }}%</span>
          </div>
          <n-slider v-model:value="settings.cardOpacity" :min="30" :max="100" :step="5" class="mt-2" />
        </div>
      </div>
    </div>

    <!-- ═══════ 日志 ═══════ -->
    <div class="mb-6">
      <h3 class="text-sm font-semibold text-gray-400 dark:text-gray-500 tracking-wider mb-3 px-1">{{ t('settings.groupLog') }}</h3>
      <div class="card p-5">
        <div>
          <label class="block text-sm text-gray-500 mb-2 flex items-center gap-1.5">
            {{ t('settings.logFilePath') }}
          </label>
          <div class="flex gap-2">
            <n-input v-model:value="settings.logFilePath" :placeholder="t('settings.defaultPath')" readonly class="flex-1" />
            <n-button size="small" @click="handleSelectLogDir">{{ t('settings.logFileSelect') }}</n-button>
            <n-button size="small" @click="handleResetLogDir">{{ t('settings.logFileReset') }}</n-button>
          </div>
        </div>

        <div class="pt-2">
          <label class="block text-sm text-gray-500 mb-2 flex items-center gap-1.5">
            {{ t('settings.logRetentionDays') }}
          </label>
          <n-input-number v-model:value="settings.logRetentionDays" :min="0" :max="365" class="w-28" @blur="() => { if (settings.logRetentionDays === null || settings.logRetentionDays === undefined) settings.logRetentionDays = 0 }" />
          <p class="text-xs text-gray-400 mt-1">{{ t('settings.logRetentionDaysHint') }}</p>
        </div>

        <div class="pt-2">
          <n-button size="small" type="error" quaternary @click="handleDeleteAllLogs">
            {{ t('settings.logCleanupAll') }}
          </n-button>
        </div>
      </div>
    </div>

  </div>
</template>
