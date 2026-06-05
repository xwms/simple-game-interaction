/**
 * UnoCSS 配置
 *
 * 逻辑说明：UnoCSS 预设与自定义规则。使用默认 preset-uno + preset-attributify。
 */

import { defineConfig, presetUno, presetAttributify, presetIcons } from 'unocss'

export default defineConfig({
  presets: [
    presetUno(),
    presetAttributify(),
    presetIcons({
      scale: 1.2,
      warn: true
    })
  ],
  shortcuts: {
    'btn-primary': 'px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-600 transition',
    'card': 'bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700'
  },
  theme: {
    colors: {
      primary: {
        DEFAULT: '#2080f0',
        50: '#f0f8ff',
        100: '#daecff',
        200: '#b3d9ff',
        300: '#80c0ff',
        400: '#4da6ff',
        500: '#2080f0',
        600: '#0d6cd4',
        700: '#0a5ab3',
        800: '#084a96',
        900: '#063c7a'
      }
    }
  },
  rules: [
    ['font-mono', { 'font-family': '"SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace' }]
  ]
})
