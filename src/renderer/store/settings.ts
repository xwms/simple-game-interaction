/**
 * 设置状态 Store
 *
 * 逻辑说明：管理用户偏好设置：界面语言、主题、中继服务器地址。
 *           设置持久化存储在本地（通过 electron store 或 localStorage）。
 */

import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export const useSettingsStore = defineStore('settings', () => {
  // ─── 状态 ───────────────────────────────────────────
  const locale = ref<'zh-CN' | 'en-US'>('zh-CN')
  const theme = ref<'light' | 'dark' | 'auto'>('auto')
  const relayServerUrl = ref('wss://relay.sgi.example.com')
  const autoUpdateCheck = ref(true)

  // ─── 方法 ───────────────────────────────────────────

  /**
   * 功能描述：切换语言
   */
  function setLocale(l: 'zh-CN' | 'en-US'): void {
    locale.value = l
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
        autoUpdateCheck: autoUpdateCheck.value
      })
    )
  }

  // 自动保存
  watch([locale, theme, relayServerUrl, autoUpdateCheck], save, { deep: true })

  return { locale, theme, relayServerUrl, autoUpdateCheck, setLocale, setTheme, load, save }
})
