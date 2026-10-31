/**
 * 功能描述：轻量版 (WebView2) 渲染进程 electronAPI shim
 *
 * 逻辑说明：WebView2 原生 postMessage 桥。VITE_LITE 环境下由 main.ts 引导安装，
 *           用 window.chrome.webview 与 C# 宿主通信，实现与 Electron 版一致的
 *           window.electronAPI 契约（invoke/on）：
 *           - invoke：发送 {id, channel, args}，宿主回复 {id, success, data|error}，
 *             用 pending Map 按 id 关联 Promise。
 *           - on：宿主推送 {channel, args}，按 channel 分发到已注册回调，返回退订函数。
 *           特例拦截 app:background-select，用浏览器文件选择器读图转 dataUrl。
 */

import type { IpcResult } from '@shared/types'

/** WebView2 暴露的 window.chrome.webview 原生桥 */
interface WebView2Bridge {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (e: { data: string }) => void): void
  removeEventListener(type: 'message', listener: (e: { data: string }) => void): void
}

/** C# 宿主与 shim 之间的消息形状 */
interface WebView2Message {
  /** invoke 响应消息的关联 id（事件推送无此字段） */
  id?: number
  channel?: string
  args?: unknown[]
  success?: boolean
  data?: unknown
  error?: string
}

// 注入 WebView2 原生对象类型（DOM lib 未包含 window.chrome.webview）
declare global {
  interface Window {
    chrome?: {
      webview?: WebView2Bridge
    }
  }
}

/**
 * 功能描述：安装 electronAPI shim
 *
 * 逻辑说明：绑定 window.chrome.webview 消息监听，分别处理 invoke 响应和事件推送；
 *           在 window.electronAPI 上注册 invoke/on 两个方法。
 *
 * @returns Promise，WebView2 桥不可用时静默跳过
 */
export async function installLiteShim(): Promise<void> {
  // WebView2 的 Blink 会吞掉带 -webkit-app-region 元素（drag 与 no-drag 均吞）的鼠标事件。
  // 因此 lite 模式下 NavBar 不渲染任何 -webkit-app-region 样式，拖拽区用 data-drag-region
  // 属性标记、由本 shim 的 mousedown 监听检测。

  const webview = window.chrome?.webview
  if (!webview) {
    console.warn('[lite] WebView2 桥不可用，跳过 electronAPI shim')
    return
  }

  const pending = new Map<number, { resolve: (v: IpcResult<unknown>) => void; reject: (e: Error) => void }>()
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  let nextId = 0

  webview.addEventListener('message', (e) => {
    // 兼容两种 e.data：部分 WebView2 版本直接传解析后的对象，部分传 JSON 字符串
    let msg: WebView2Message
    if (typeof e.data === 'string') {
      try {
        msg = JSON.parse(e.data) as WebView2Message
      } catch {
        return
      }
    } else if (e.data && typeof e.data === 'object') {
      msg = e.data as WebView2Message
    } else {
      return
    }

    // invoke 响应：按 id 找到对应 Promise 并结算
    if (typeof msg.id === 'number') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.success) {
        p.resolve({ success: true, data: msg.data })
      } else {
        p.reject(new Error(msg.error || 'IPC error'))
      }
      return
    }

    // 事件推送：按 channel 分发到已注册回调
    if (typeof msg.channel === 'string') {
      const cbs = listeners.get(msg.channel)
      if (!cbs) return
      const args = Array.isArray(msg.args) ? msg.args : []
      for (const cb of cbs) cb(...args)
    }
  })

  // WebView2 不支持 -webkit-app-region: drag，改为在拖拽区 mousedown 时通知 C# 宿主启动窗口拖拽
  document.addEventListener('mousedown', (e) => {
    if (isDragRegion(e.target)) {
      webview.postMessage({ channel: 'window:drag-start' })
    }
  })

  window.electronAPI = {
    invoke(channel, ...args) {
      if (channel === 'app:background-select') {
        return selectBackgroundImage()
      }
      return new Promise<IpcResult<unknown>>((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        webview.postMessage({ id, channel, args })
      })
    },
    on(channel, callback) {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(callback)
      return () => {
        const set = listeners.get(channel)
        if (set) set.delete(callback)
      }
    }
  }
}

/**
 * 功能描述：判断鼠标按下位置是否属于窗口拖拽区
 *
 * 逻辑说明：lite 模式下拖拽区用 data-drag-region 属性标记（不用 -webkit-app-region，
 *           因 Blink 会吞掉该区域的鼠标事件）。目标位于任何 data-no-drag 元素内（按钮）时
 *           判定为非拖拽区；否则向上找 data-drag-region 命中即拖拽。data-no-drag 必须
 *           先于 data-drag-region 检查——按钮在导航栏内部，会被最近的祖先拖拽区误命中。
 *
 * @param target - mousedown 事件的目标元素
 * @returns 是否应启动窗口拖拽
 */
function isDragRegion(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('[data-no-drag]')) return false
  return target.closest('[data-drag-region]') !== null
}

/**
 * 功能描述：用浏览器文件选择器实现背景图选择（替代 Electron 原生对话框）
 *
 * 逻辑说明：创建隐藏的 <input type="file" accept="image/*"> 触发点击，选中后用
 *           FileReader 读为 dataURL。取消对话框时 focus 事件回到窗口且未选中文件，
 *           判定为取消并返回 data:null，避免 Promise 悬挂。返回形状与 Electron 版一致。
 *
 * @returns IpcResult：成功含 {path, dataUrl}，取消 data 为 null，读取失败返回 error
 */
function selectBackgroundImage(): Promise<IpcResult<unknown>> {
  return new Promise<IpcResult<unknown>>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.style.display = 'none'

    let settled = false
    const finish = (result: IpcResult<unknown>): void => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onFocus)
      input.remove()
      resolve(result)
    }
    // 对话框关闭后窗口重新获得焦点，若此时未选中任何文件，判定为取消。
    // 延迟 300ms 再判：input.files 在 change 事件同步赋值，选中文件后不会误判取消；
    // 原实现焦点一返回即 resolve(null)，与 FileReader 异步读取竞争，导致选中图片失效。
    const onFocus = (): void => {
      window.setTimeout(() => {
        if (!settled && !input.files?.length) {
          finish({ success: true, data: null })
        }
      }, 300)
    }

    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) {
        finish({ success: true, data: null })
        return
      }
      const reader = new FileReader()
      reader.onload = () => finish({ success: true, data: { path: file.name, dataUrl: reader.result as string } })
      reader.onerror = () => finish({ success: false, error: 'Failed to read image' })
      reader.readAsDataURL(file)
    }

    window.addEventListener('focus', onFocus)
    document.body.appendChild(input)
    input.click()
  })
}
