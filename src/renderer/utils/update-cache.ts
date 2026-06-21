/**
 * 功能描述：更新检查缓存模块
 *
 * 逻辑说明：模块级缓存，5 分钟 TTL。HomeView 和 SettingsView 共享同一缓存，
 *           避免每次切换页面或重复点击都请求 Gitee API。
 */

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
}

let cache: CacheEntry | null = null
const TTL = 120_000

/**
 * 功能描述：获取缓存的更新数据（未过期时返回，过期返回 null）
 *
 * @returns 缓存数据或 null
 */
export function getCachedUpdate(): UpdateCheckData | null {
  if (cache && Date.now() < cache.expiry) {
    return cache.data
  }
  return null
}

/**
 * 功能描述：清空并设置一个过期缓存
 */
export function setCachedUpdate(data: UpdateCheckData): void {
  cache = { data, expiry: Date.now() + TTL }
}

/**
 * 功能描述：通过 IPC 检查更新，结果自动缓存
 *
 * @param currentVersion - 当前应用版本号（由渲染进程从 package.json 读取，避免主进程 app.getVersion() 返回 Electron 版本号）
 * @returns 更新数据（成功时）或 null
 */
export async function fetchUpdate(currentVersion?: string): Promise<UpdateCheckData | null> {
  const cached = getCachedUpdate()
  if (cached) return cached

  console.debug('[update-cache] 缓存未命中，请求 Gitee API')
  try {
    const result = await window.electronAPI.invoke('update:check', { currentVersion })
    if (result.success && result.data) {
      const data = result.data as UpdateCheckData
      setCachedUpdate(data)
      return data
    }
  } catch {
    // 调用失败
  }
  return null
}
