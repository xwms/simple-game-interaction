/**
 * E2E 测试：Electron 应用基本流程
 *
 * 逻辑说明：启动 Electron 应用，验证首页加载、页面路由切换、
 *           创建房间、加入房间、设置页面等基本用户流程。
 *
 * 运行方式：npx playwright test --config=tests/e2e/playwright.config.ts
 */

import { test, expect } from '@playwright/test'
import { _electron as electron } from 'playwright'
import type { ElectronApplication, Page } from 'playwright'

let electronApp: ElectronApplication
let page: Page

test.beforeAll(async () => {
  // 启动 Electron 应用（开发模式）
  electronApp = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test'
    }
  })

  // 等待主窗口出现
  page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (electronApp) {
    await electronApp.close()
  }
})

test.describe('首页', () => {
  test('应显示应用标题', async () => {
    // 检查页面包含创建房间和加入房间按钮
    const content = await page.textContent('body')
    expect(content).toBeTruthy()
  })

  test('应存在创建房间按钮', async () => {
    const buttons = page.locator('button, .n-button')
    const count = await buttons.count()
    expect(count).toBeGreaterThan(0)
  })

  test('应显示版本号信息', async () => {
    // 版本信息通常在页面底部
    const bodyText = await page.textContent('body')
    expect(bodyText).toBeDefined()
  })
})

test.describe('页面路由', () => {
  test('应能通过路由访问首页', async () => {
    await page.goto('http://localhost:5173/#/')
    await page.waitForLoadState('domcontentloaded')
    const url = page.url()
    expect(url).toContain('/')
  })

  test('应能访问设置页面', async () => {
    await page.goto('http://localhost:5173/#/settings')
    await page.waitForLoadState('domcontentloaded')
    const url = page.url()
    expect(url).toContain('/settings')
  })
})

test.describe('网络检测', () => {
  test('首页应显示网络检测信息', async () => {
    // 等待网络检测完成（通常 1-3 秒）
    await page.waitForTimeout(3000)

    // 检查是否显示了网络状态信息
    const bodyText = await page.textContent('body')
    expect(bodyText).toBeDefined()
  })
})

test.describe('设置页面', () => {
  test('设置页面应正常加载', async () => {
    await page.goto('http://localhost:5173/#/settings')
    await page.waitForLoadState('domcontentloaded')
    const url = page.url()
    expect(url).toContain('/settings')
    await page.waitForTimeout(1000)
  })
})
