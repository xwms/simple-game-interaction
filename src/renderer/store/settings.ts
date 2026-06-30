/**
 * 设置状态 Store
 *
 * 逻辑说明：管理用户偏好设置：界面语言、主题、中继服务器地址、日志文件路径、背景图片。
 *           设置持久化存储在本地（localStorage）。
 */

import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { i18n } from '../i18n'

export const useSettingsStore = defineStore('settings', () => {
  // ─── 状态 ───────────────────────────────────────────
  const locale = ref<'zh-CN' | 'en-US'>('zh-CN')
  const theme = ref<'light' | 'dark' | 'auto'>('auto')
  const relayServerUrl = ref('ws://159.75.150.37:9800')
  const autoUpdateCheck = ref(true)
  const logFilePath = ref('')
  const closeBehavior = ref<'quit' | 'hide'>('hide')
  /** 加入者端自定义本地端口（0 = 自动分配） */
  const localPort = ref(0)

  /** 日志保留天数（启动时自动清理，0 = 不自动清理） */
  const logRetentionDays = ref(7)

  /** 背景图片文件路径（空字符串 = 无背景） */
  const backgroundImage = ref('')
  /** 背景图片遮罩透明度（0-100） */
  const backgroundOpacity = ref(30)
  /** 背景图片 base64 data URL（运行时缓存，不持久化） */
  const backgroundDataUrl = ref('')

  /** 卡片透明度（0-100，默认 80） */
  const cardOpacity = ref(80)

  // ─── 方法 ───────────────────────────────────────────

  /**
   * 功能描述：切换语言，同时更新 vue-i18n 实例
   */
  function setLocale(l: 'zh-CN' | 'en-US'): void {
    locale.value = l
    i18n.global.locale.value = l
  }

  /**
   * 功能描述：切换主题
   */
  function setTheme(t: 'light' | 'dark' | 'auto'): void {
    theme.value = t
  }

  /**
   * 功能描述：从 localStorage 恢复设置
   */
  function load(): void {
    try {
      const saved = localStorage.getItem('sgi-settings')
      if (saved) {
        const data = JSON.parse(saved)
        if (data.locale) locale.value = data.locale
        if (data.theme) theme.value = data.theme
        if (data.relayServerUrl) relayServerUrl.value = data.relayServerUrl
        if (data.autoUpdateCheck !== undefined) autoUpdateCheck.value = data.autoUpdateCheck
        if (data.logFilePath) logFilePath.value = data.logFilePath
        if (data.closeBehavior) closeBehavior.value = data.closeBehavior
        if (data.localPort !== undefined) localPort.value = data.localPort
        if (data.backgroundImage) backgroundImage.value = data.backgroundImage
        if (data.backgroundOpacity !== undefined) backgroundOpacity.value = data.backgroundOpacity
        if (data.cardOpacity !== undefined) cardOpacity.value = data.cardOpacity
        if (data.logRetentionDays !== undefined) logRetentionDays.value = data.logRetentionDays
      }
    } catch {
      // 忽略反序列化错误
    }
  }

  /**
   * 功能描述：保存设置到 localStorage
   */
  function save(): void {
    localStorage.setItem(
      'sgi-settings',
      JSON.stringify({
        locale: locale.value,
        theme: theme.value,
        relayServerUrl: relayServerUrl.value,
        autoUpdateCheck: autoUpdateCheck.value,
        logFilePath: logFilePath.value,
        closeBehavior: closeBehavior.value,
        localPort: localPort.value,
        backgroundImage: backgroundImage.value,
        backgroundOpacity: backgroundOpacity.value,
        cardOpacity: cardOpacity.value,
        logRetentionDays: logRetentionDays.value
      })
    )
  }

  /**
   * 功能描述：选择背景图片，调用主进程打开文件对话框
   */
  async function selectBackgroundImage(): Promise<void> {
    try {
      const result = await window.electronAPI.invoke('app:background-select')
      if (result.success && result.data) {
        const data = result.data as { path: string; dataUrl: string }
        backgroundImage.value = data.path
        backgroundDataUrl.value = data.dataUrl
      }
    } catch {
      // 静默失败
    }
  }

  /**
   * 功能描述：移除背景图片
   */
  function removeBackgroundImage(): void {
    backgroundImage.value = ''
    backgroundDataUrl.value = ''
  }

  /**
   * 功能描述：启动时根据持久化的路径加载背景图片
   */
  async function loadBackgroundImage(): Promise<void> {
    if (!backgroundImage.value) return
    try {
      const result = await window.electronAPI.invoke('app:background-select', backgroundImage.value)
      if (result.success && result.data) {
        const data = result.data as { dataUrl: string }
        backgroundDataUrl.value = data.dataUrl
      } else {
        // 文件不存在或无法读取，清空
        backgroundImage.value = ''
      }
    } catch {
      backgroundImage.value = ''
    }
  }

  // 自动保存
  watch([locale, theme, relayServerUrl, autoUpdateCheck, logFilePath, closeBehavior, localPort, backgroundImage, backgroundOpacity, cardOpacity, logRetentionDays], save, { deep: true })

  return {
    locale, theme, relayServerUrl, autoUpdateCheck, logFilePath, closeBehavior, localPort,
    backgroundImage, backgroundOpacity, backgroundDataUrl, cardOpacity, logRetentionDays,
    setLocale, setTheme, load, save,
    selectBackgroundImage, removeBackgroundImage, loadBackgroundImage
  }
})
