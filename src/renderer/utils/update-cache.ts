/**
 * 功能描述：更新检查缓存模块 + 全局后台下载状态
 *
 * 逻辑说明：模块级缓存，5 分钟 TTL。HomeView 和 SettingsView 共享同一缓存，
 *           避免每次切换页面或重复点击都请求 API。
 *           另维护全局下载状态（reactive），下载完成后 App.vue 弹出通知。
 */

import { reactive } from 'vue'

export interface UpdateCheckData {
  hasUpdate: boolean
  version: string
  releaseNotes?: string
  downloadUrl?: string
  installAvailable?: boolean
  downloadedBytes?: number
  installPath?: string
}

interface CacheEntry {
  data: UpdateCheckData
  expiry: number
  /** 创建缓存时的当前版本号，版本变更时缓存自动失效 */
  currentVersion: string
}

let cache: CacheEntry | null = null
const TTL = 120_000

/**
 * 功能描述：获取缓存的更新数据（未过期且版本匹配时返回）
 *
 * @param currentVersion - 当前版本号，传此参数时版本变更会自动失效
 * @returns 缓存数据或 null
 */
export function getCachedUpdate(currentVersion?: string): UpdateCheckData | null {
  if (cache && Date.now() < cache.expiry) {
    // 版本已变更时忽略缓存，避免版本号不同返回旧数据
    if (currentVersion && cache.currentVersion !== currentVersion) {
      return null
    }
    return cache.data
  }
  return null
}

/**
 * 功能描述：清空并设置一个过期缓存
 *
 * @param data - 更新数据
 * @param currentVersion - 缓存时的版本号，用于后续版本变更时自动失效
 */
export function setCachedUpdate(data: UpdateCheckData, currentVersion?: string): void {
  cache = { data, expiry: Date.now() + TTL, currentVersion: currentVersion || '' }
}

/**
 * 功能描述：通过 IPC 检查更新，结果自动缓存
 *
 * @param currentVersion - 当前应用版本号（由渲染进程从 package.json 读取，避免主进程 app.getVersion() 返回 Electron 版本号）
 * @returns 更新数据（成功时）或 null
 */
export async function fetchUpdate(currentVersion?: string): Promise<UpdateCheckData | null> {
  const cached = getCachedUpdate(currentVersion)
  if (cached) return cached

  console.debug('[update-cache] 缓存未命中，请求 API')
  try {
    const result = await window.electronAPI.invoke('update:check', { currentVersion })
    if (result.success && result.data) {
      const data = result.data as UpdateCheckData
      setCachedUpdate(data, currentVersion)
      return data
    }
  } catch (err) {
    console.warn('[update-cache] 检查更新失败:', err)
  }
  return null
}

// ─── 全局后台下载状态 ─────────────────────────────────────

export interface DownloadState {
  isDownloading: boolean
  progress: number
  version: string
  filePath: string
  done: boolean
  error: string | null
}

const _downloadState = reactive<DownloadState>({
  isDownloading: false,
  progress: 0,
  version: '',
  filePath: '',
  done: false,
  error: null
})

/**
 * 功能描述：获取全局后台下载状态（响应式，视图可直接绑定）
 *
 * @returns 全局 DownloadState 对象
 */
export function getDownloadState(): DownloadState {
  return _downloadState
}

/**
 * 功能描述：启动后台下载（fire-and-forget）
 *
 * 逻辑说明：设置全局下载状态后调用 IPC，不 await 返回结果。
 *           下载进度/完成/错误由 App.vue 的持久监听器更新全局状态。
 *
 * @param url - 下载 URL
 * @param version - 下载版本号
 */
export function startBackgroundDownload(url: string, version: string): void {
  _downloadState.isDownloading = true
  _downloadState.progress = 0
  _downloadState.version = version
  _downloadState.filePath = ''
  _downloadState.done = false
  _downloadState.error = null

  window.electronAPI.invoke('update:start-download', url, version).catch(() => {
    _downloadState.isDownloading = false
    _downloadState.error = '启动下载失败'
  })
}
