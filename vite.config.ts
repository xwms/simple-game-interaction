import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { NaiveUiResolver } from 'unplugin-vue-components/resolvers'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    vue(),

    // UnoCSS 原子化 CSS
    UnoCSS(),

    // 自动导入 Vue API
    AutoImport({
      imports: [
        'vue',
        'vue-router',
        'pinia',
        {
          'naive-ui': ['useDialog', 'useMessage', 'useNotification', 'useLoadingBar']
        }
      ],
      dts: 'src/auto-imports.d.ts'
    }),

    // 自动注册组件
    Components({
      resolvers: [NaiveUiResolver()],
      dts: 'src/components.d.ts'
    })
  ],

  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core')
    }
  },

  // 渲染进程源码目录（包含 index.html）
  root: 'src/renderer',

  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true
  },

  // 开发服务器配置（可通过 VITE_DEV_SERVER_PORT 环境变量覆盖，用于多实例调试）
  server: {
    port: parseInt(process.env.VITE_DEV_SERVER_PORT || '5173', 10),
    strictPort: true
  },

  // 基路径 - 生产环境下使用相对路径
  base: './'
})
