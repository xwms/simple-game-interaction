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

// UnoCSS 全局样式
import 'virtual:uno.css'
import '@unocss/reset/tailwind.css'
import './styles/global.scss'

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(i18n)

app.mount('#app')
