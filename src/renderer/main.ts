/**
 * 功能描述：Vue 应用初始化入口
 *
 * 逻辑说明：创建 Vue 应用实例，依次安装 Pinia、Vue Router、i18n、Naive UI，
 *           然后挂载到 #app 节点。UnoCSS 样式全局导入。
 */

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { i18n } from './i18n'
import { useSettingsStore } from './store/settings'

// UnoCSS 全局样式
import 'virtual:uno.css'
import '@unocss/reset/tailwind.css'
import './styles/global.scss'

// 阿里矢量图标库
import './assets/iconfont/iconfont.css'

// 全局压制 wheel/touch 事件非 passive 警告（Naive UI 下拉框等组件触发的性能提示）
const _orig = EventTarget.prototype.addEventListener
EventTarget.prototype.addEventListener = function (
  type: string,
  listener: EventListenerOrEventListenerObject | null,
  options?: boolean | AddEventListenerOptions
) {
  if (type === 'wheel' || type === 'touchstart' || type === 'touchmove') {
    if (typeof options === 'object') {
      options = { ...options, passive: true }
    } else if (options === undefined || options === false) {
      options = { passive: true, capture: false }
    }
  }
  return _orig.call(this, type, listener, options)
}

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)
app.use(i18n)

// 注册 Iconify 图标组件为全局组件

// 从 localStorage 恢复设置，同步初始 locale 到 vue-i18n
const settings = useSettingsStore()
settings.load()
i18n.global.locale.value = settings.locale

app.mount('#app')
