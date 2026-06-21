/**
 * 功能描述：网络检测共享状态 — 启动时自动检测，全局可读
 *
 * 逻辑说明：使用模块级单例状态，所有组件读写同一份检测结果。
 *           App.vue 挂载时触发首次检测，检测结果自动写入日志。
 *           HostView / JoinView 通过此 composable 读取结果。
 */

import { ref } from 'vue'
import type { NetworkInfo } from '@shared/types'
import { i18n } from '../i18n'

// ─── 模块级单例状态 ───────────────────────────────────
const _status = ref<'idle' | 'detecting' | 'done' | 'error'>('idle')
const _result = ref<NetworkInfo | null>(null)
const _error = ref<string | null>(null)

/** 离线自动重试定时器 */
let _retryTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 功能描述：获取 NAT 类型的中文描述
 *
 * @param ipv4 - IPv4 网络信息（含 publicIp，用于区分"未联网"和"UDP 受限"）
 */
export function natTypeLabel(ipv4: NetworkInfo['ipv4']): string {
  // 无公网 IP 且 NAT unknown → 无法检测（区别于已检测但 NAT 未知）
  if (ipv4.natType === 'unknown' && !ipv4.publicIp) {
    return ''
  }
  const key = ipv4.natType === 'easy-nat' ? 'nat.easyNat'
    : ipv4.natType === 'hard-nat' ? 'nat.hardNat'
    : ipv4.natType === 'none' ? 'nat.none'
    : ipv4.natType === 'unknown' ? 'nat.unknown'
    : ''
  return key ? i18n.global.t(key) : ipv4.natType
}

/**
 * 功能描述：推断本机的最佳连接路径
 */
export function inferConnectionPath(info: NetworkInfo): { type: string; label: string } {
  // 未联网
  if (!info.ipv4.publicIp && info.ipv4.natType === 'unknown' && !info.ipv6.available) {
    return { type: 'none', label: i18n.global.t('home.offline') }
  }
  if (info.ipv6.hasPublicV6 && info.ipv6.available) {
    return { type: 'ipv6', label: 'IPv6 直连（低延迟）' }
  }
  if (info.ipv4.natType === 'hard-nat' || info.ipv4.natType === 'unknown') {
    return { type: 'relay', label: '需中继转发' }
  }
  if (info.ipv4.natType === 'none') {
    return { type: 'direct', label: '公网 IP 直连' }
  }
  return { type: 'p2p', label: 'P2P 直连' }
}

/**
 * 功能描述：网络检测共享状态 — 启动时自动检测，支持手动刷新
 *
 * 逻辑说明：调用主进程 IPC，检测结果写入日志。
 *           detect() 首次执行，refresh() 无视缓存重新检测。
 */
export function useNetworkDetect() {
  /**
   * 功能描述：执行检测
   *
   * @param force - 是否强制刷新（无视缓存）
   */
  /**
   * 功能描述：取消离线自动重试定时器
   */
  function _cancelRetry(): void {
    if (_retryTimer !== null) {
      clearTimeout(_retryTimer)
      _retryTimer = null
    }
  }

  /**
   * 功能描述：检测到离线时，定时自动重试
   */
  function _scheduleRetryIfOffline(info: NetworkInfo): void {
    _cancelRetry()
    // offline 判定：无公网 IP + NAT unknown + IPv6 不可用
    const isOffline = !info.ipv4.publicIp && info.ipv4.natType === 'unknown' && !info.ipv6.available
    if (isOffline) {
      _retryTimer = setTimeout(() => {
        _retryTimer = null
        window.electronAPI.invoke('log:info', '网络检测离线重试中...')
        detect(true) // force 跳过缓存
      }, 5000)
    }
  }

  async function detect(force: boolean = false): Promise<void> {
    _cancelRetry()
    if (_status.value === 'detecting') return
    if (!force && _status.value === 'done') return
    _status.value = 'detecting'
    _error.value = null

    try {
      const result = await window.electronAPI.invoke('network:detect')
      if (result.success) {
        const data = result.data as NetworkInfo
        _result.value = data
        _status.value = 'done'
        _scheduleRetryIfOffline(data)
      } else {
        _status.value = 'error'
        _error.value = (result as { error: string }).error || '检测失败'
        window.electronAPI.invoke('log:error', `网络检测失败：${_error.value}`)
      }
    } catch (err) {
      _status.value = 'error'
      _error.value = '检测异常'
      window.electronAPI.invoke('log:error', `网络检测异常：${err}`)
    }
  }

  /**
   * 功能描述：手动刷新网络检测
   *
   * 逻辑说明：重置状态后重新检测。
   */
  async function refresh(): Promise<void> {
    _status.value = 'idle'
    _result.value = null
    _error.value = null
    await detect(true)
  }

  return {
    status: _status,
    result: _result,
    error: _error,
    detect,
    refresh,
    /** 停止离线自动重试 */
    stopAutoRetry: _cancelRetry
  }
}
