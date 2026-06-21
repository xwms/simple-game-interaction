import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './',
  timeout: 30000,
  expect: {
    timeout: 10000
  },
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 }
  },
  projects: [
    {
      name: 'electron',
      use: {
        // 使用 Electron 作为浏览器
        browserName: 'chromium'
      }
    }
  ],
  // Electron 不需要下载浏览器
  // 通过 electron 命令启动
  workers: 1
})
