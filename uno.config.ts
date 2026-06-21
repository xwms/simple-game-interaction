/**
 * UnoCSS 配置
 *
 * 逻辑说明：UnoCSS 预设与自定义规则。使用默认 preset-uno + preset-attributify。
 */

import { defineConfig, presetUno, presetAttributify, presetIcons, presetTypography } from 'unocss'

export default defineConfig({
  presets: [
    presetUno(),
    presetAttributify(),
    presetIcons({
      scale: 1.2,
      warn: true
    }),
    presetTypography()
  ],
  shortcuts: {
    'btn-primary': 'px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-600 transition',
    'card': 'rounded-xl shadow-sm border border-gray-200/60 dark:border-gray-700/60',
    'card-hover': 'card hover:shadow-lg hover:border-gray-300 dark:hover:border-gray-600 hover:scale-[1.02] active:scale-[1.01] transition-all duration-200'
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
      },
      accent: {
        DEFAULT: '#6c5ce7',
        50: '#f0eeff',
        100: '#d5d0ff',
        200: '#b3a8ff',
        300: '#8c7cf5',
        400: '#6c5ce7',
        500: '#4f42c9',
        600: '#3b2fa8',
        700: '#2a2087'
      },
      surface: {
        DEFAULT: '#ffffff',
        dark: '#1a1a2e'
      }
    }
  },
  rules: [
    ['font-mono', { 'font-family': '"SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, monospace' }]
  ]
})
