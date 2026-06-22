/**
 * E2E 测试：Electron 应用基本流程
 *
 * 逻辑说明：启动 Electron 应用，验证首页加载、页面路由切换（通过 UI 点击，
 *           因为 Vue Router 使用 createMemoryHistory，URL 不会随路由变化）、
 *           创建房间/加入房间页面、设置页面交互等基本用户流程。
 *           部分路由测试通过 page.evaluate 访问 Vue Router 实例实现。
 *
 * 运行方式：npx playwright test --config=tests/e2e/playwright.config.ts
 */

import { test, expect } from '@playwright/test'
import { _electron as electron } from 'playwright'
import type { ElectronApplication, Page } from 'playwright'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import path from 'path'
import http from 'http'

let electronApp: ElectronApplication
let page: Page
let viteProcess: ChildProcess | null = null

/**
 * 功能描述：启动 Vite dev server 并等待就绪
 *
 * 逻辑说明：E2E 测试需要 Vite 提供前端资源，使用 spawn 启动子进程，
 *           轮询 localhost:5173 等待返回 200。
 */
async function startVite(): Promise<void> {
  const root = path.join(__dirname, '../..')

  viteProcess = spawn('npx', ['vite'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env, NODE_ENV: 'development' }
  })

  viteProcess.stdout?.pipe(process.stdout)
  viteProcess.stderr?.pipe(process.stderr)

  // 轮询等待 Vite 就绪（最多 15 秒）
  const maxAttempts = 30
  for (let i = 0; i < maxAttempts; i++) {
    if (viteProcess.exitCode !== null) {
      throw new Error(`Vite exited prematurely with code ${viteProcess.exitCode}`)
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get('http://localhost:5173', (res) => {
          res.resume()
          if (res.statusCode === 200) resolve()
          else reject(new Error(`Vite status ${res.statusCode}`))
        })
        req.on('error', reject)
        req.end()
      })
      return // Vite is ready
    } catch {
      // Not ready yet, wait and retry
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error('Vite dev server did not start in time')
}

/**
 * 功能描述：通过 page.evaluate 访问 Vue Router 进行导航
 *
 * 逻辑说明：Vue 3 将 app 实例挂载到 #app 元素的 __vue_app__ 属性，
 *           通过 globalProperties.$router 可获取 router 实例。
 *           由于 contextIsolation 不影响 page.evaluate（它在主世界执行），
 *           此方法可行。
 *
 * @param path - 路由路径
 */
async function routerPush(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    const root = document.querySelector('#app') as any
    const router = root?.__vue_app__?.config?.globalProperties?.$router
    if (router) {
      router.push(p)
    }
  }, path)
  await page.waitForTimeout(400)
}

/**
 * 功能描述：获取当前路由路径
 */
async function getCurrentRoute(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.querySelector('#app') as any
    const router = root?.__vue_app__?.config?.globalProperties?.$router
    return router?.currentRoute?.value?.path ?? ''
  })
}

test.beforeAll(async () => {
  // 启动 Vite dev server
  await startVite()

  electronApp = await electron.launch({
    args: [path.join(__dirname, '../..')],
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test'
    }
  })

  // 等待主窗口出现。openDevTools({ mode: 'detach' }) 会创建 DevTools 窗口，
  // 该窗口可能被 firstWindow() 优先捕获。这里等待标题不是 DevTools 的窗口。
  page = await new Promise<Page>((resolve) => {
    let resolved = false

    const onWindow = (w: Page) => {
      w.title().then((t) => {
        if (!resolved && t !== 'DevTools') {
          resolved = true
          resolve(w)
        }
      })
    }

    // 检查现有窗口
    for (const w of electronApp.windows()) {
      w.title().then((t) => {
        if (!resolved && t !== 'DevTools') {
          resolved = true
          resolve(w)
        }
      })
    }

    // 监听新窗口
    electronApp.on('window', onWindow)
  })

  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (electronApp) {
    await electronApp.close()
  }
  if (viteProcess && viteProcess.exitCode === null) {
    viteProcess.kill()
  }
})

// ─── 应用启动 ─────────────────────────────────────────

test.describe('应用启动', () => {
  test('应成功启动 Electron 窗口并显示标题', async () => {
    const title = await page.title()
    expect(title).toBe('SGI')
  })

  test('导航栏应可见并包含页面导航按钮', async () => {
    const nav = page.locator('nav')
    await expect(nav).toBeVisible()

    // 验证四个导航按钮存在（首页/设置/日志/关于）
    const navTexts = ['首页', '设置', '日志', '关于']
    for (const text of navTexts) {
      await expect(nav.getByText(text).first()).toBeVisible()
    }
  })
})

// ─── 首页 ─────────────────────────────────────────────

test.describe('首页', () => {
  test('应显示"创建房间"和"加入房间"操作卡片', async () => {
    await expect(page.getByText('创建房间').first()).toBeVisible()
    await expect(page.getByText('加入房间').first()).toBeVisible()
  })

  test('应显示版本号信息', async () => {
    const bodyText = await page.textContent('body')
    expect(bodyText).toMatch(/v0\.0\.5/)
  })

  test('应显示网络检测状态或检测中提示', async () => {
    // 网络检测可能在测试环境中显示"未联网"或"IPv6"等状态
    // 也可能仍在检测中，只要能检测到网络区域即可
    await page.waitForTimeout(2000)
    const bodyText = await page.textContent('body')
    const hasNetworkIndicator =
      bodyText.includes('IPv6') ||
      bodyText.includes('正在检测') ||
      bodyText.includes('NAT') ||
      bodyText.includes('未联网') ||
      bodyText.includes('Offline') ||
      bodyText.includes('网络')
    expect(hasNetworkIndicator).toBeTruthy()
  })
})

// ─── 导航栏页面切换 ───────────────────────────────────

test.describe('导航栏页面切换', () => {
  test('应能从首页导航到设置页', async () => {
    // 单击 NavBar 中的"设置"按钮
    await page.locator('nav button').filter({ hasText: '设置' }).click()
    await page.waitForTimeout(300)

    // 验证设置页标题
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible()
  })

  test('应能从设置页导航到日志页', async () => {
    await page.locator('nav button').filter({ hasText: '日志' }).click()
    await page.waitForTimeout(300)

    await expect(page.locator('h2').filter({ hasText: '日志' })).toBeVisible()
  })

  test('应能从日志页导航到关于页', async () => {
    await page.locator('nav button').filter({ hasText: '关于' }).click()
    await page.waitForTimeout(300)

    // 关于页应有应用名和作者信息
    await expect(page.getByText('Simple Game Interaction')).toBeVisible()
    await expect(page.getByText('X_watermelons')).toBeVisible()
  })

  test('应能从关于页返回首页', async () => {
    await page.locator('nav button').filter({ hasText: '首页' }).click()
    await page.waitForTimeout(300)

    // 首页显示操作卡片
    await expect(page.getByText('创建房间').first()).toBeVisible()
  })
})

// ─── 首页卡片导航 ─────────────────────────────────────

test.describe('首页卡片导航', () => {
  test('点击"创建房间"卡片应进入创建房间页', async () => {
    await page.getByText('创建房间').first().click()
    await page.waitForTimeout(300)

    await expect(page.getByRole('heading', { name: '创建房间' })).toBeVisible()

    // 返回首页
    await page.locator('nav button').filter({ hasText: '首页' }).click()
    await page.waitForTimeout(300)
  })

  test('点击"加入房间"卡片应进入加入房间页', async () => {
    await page.getByText('加入房间').first().click()
    await page.waitForTimeout(300)

    await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()

    // 返回首页
    await page.locator('nav button').filter({ hasText: '首页' }).click()
    await page.waitForTimeout(300)
  })
})

// ─── 加入房间页 ───────────────────────────────────────

test.describe('加入房间页', () => {
  test('房间码输入框应限制最多 6 位字符', async () => {
    // 进入加入房间页
    await page.getByText('加入房间').first().click()
    await page.waitForTimeout(300)

    // 找到输入框（带有占位符"输入 6 位房间码"的 input）
    const input = page.locator('input[maxlength="6"]')
    await expect(input).toBeVisible()

    // 输入超过 6 位字符，验证被截断
    await input.fill('ABCDEFGH')
    const value = await input.inputValue()
    expect(value.length).toBe(6)
    expect(value).toBe('ABCDEF')

    // 清空并输入正常 6 位码
    await input.fill('')
    await input.fill('ABC123')
    expect(await input.inputValue()).toBe('ABC123')

    // 返回首页
    await page.locator('nav button').filter({ hasText: '首页' }).click()
    await page.waitForTimeout(300)
  })

  test('"加入"按钮在房间码不足 6 位时应禁用', async () => {
    await page.getByText('加入房间').first().click()
    await page.waitForTimeout(300)

    const input = page.locator('input[maxlength="6"]')
    await input.fill('ABC')

    // 加入按钮应该是禁用状态
    const joinBtn = page.locator('button').filter({ hasText: '加入' }).first()
    await expect(joinBtn).toBeDisabled()

    await page.locator('nav button').filter({ hasText: '首页' }).click()
    await page.waitForTimeout(300)
  })
})

// ─── 设置页 ───────────────────────────────────────────

test.describe('设置页', () => {
  test('设置页应显示四个设置分组', async () => {
    await page.locator('nav button').filter({ hasText: '设置' }).click()
    await page.waitForTimeout(300)

    // 检查设置页标题
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible()

    // 检查四个分组（使用 contains 避免 NavBar 中的"日志"按钮干扰）
    await expect(page.getByText('通用')).toBeVisible()
    await expect(page.getByText('连接')).toBeVisible()
    await expect(page.getByText('外观')).toBeVisible()
    await expect(page.locator('h3').filter({ hasText: '日志' })).toBeVisible()

    await page.locator('nav button').filter({ hasText: '首页' }).click()
    await page.waitForTimeout(300)
  })

  test('设置页应包含语言和主题选择器', async () => {
    await page.locator('nav button').filter({ hasText: '设置' }).click()
    await page.waitForTimeout(300)

    // 通用分组下应有语言和主题设置
    await expect(page.getByText('语言').first()).toBeVisible()
    await expect(page.getByText('主题').first()).toBeVisible()

    await page.locator('nav button').filter({ hasText: '首页' }).click()
    await page.waitForTimeout(300)
  })
})

// ─── 关于页 ───────────────────────────────────────────

test.describe('关于页', () => {
  test('关于页应显示应用信息', async () => {
    await page.locator('nav button').filter({ hasText: '关于' }).click()
    await page.waitForTimeout(300)

    // 应用名
    await expect(page.getByText('SGI').first()).toBeVisible()
    // 作者
    await expect(page.getByText('X_watermelons')).toBeVisible()
    // GitHub 链接
    await expect(page.getByText('GitHub')).toBeVisible()
    // 版权信息
    await expect(page.getByText(/Copyright/i)).toBeVisible()

    await page.locator('nav button').filter({ hasText: '首页' }).click()
    await page.waitForTimeout(300)
  })
})

// ─── 404 页面 ─────────────────────────────────────────

test.describe('404 页面', () => {
  test('访问无效路由应显示 404 页面', async () => {
    // 通过 Vue Router 导航到不存在的路径
    await routerPush(page, '/this-path-does-not-exist')

    // 验证显示 404（h1 大标题）
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible()
    await expect(page.getByText('页面不存在')).toBeVisible()
    // 应有"返回首页"按钮
    await expect(page.getByText('返回首页')).toBeVisible()

    // 点击返回首页按钮
    await page.getByText('返回首页').click()
    await page.waitForTimeout(300)

    // 确认返回首页
    await expect(page.getByText('创建房间').first()).toBeVisible()
  })
})

// ─── 房间路由守卫 ─────────────────────────────────────

test.describe('房间路由守卫', () => {
  test('未加入房间时访问 /room/xxx 应重定向到首页', async () => {
    // 确认当前在首页
    await expect(page.getByText('创建房间').first()).toBeVisible()

    // 通过 Vue Router 导航到房间页（但没有 roomStore.roomCode）
    await routerPush(page, '/room/ABCDEF')

    // 路由守卫应将请求重定向到首页
    await expect(page.getByText('创建房间').first()).toBeVisible()

    // 验证当前路由不是房间页
    const route = await getCurrentRoute(page)
    expect(route).not.toContain('room')
    expect(route).toBe('/')
  })
})

// ─── 日志页 ───────────────────────────────────────────

test.describe('日志页', () => {
  test('日志页应包含清空按钮和日志查看器', async () => {
    await page.locator('nav button').filter({ hasText: '日志' }).click()
    await page.waitForTimeout(300)

    // 日志页标题
    await expect(page.getByRole('heading', { name: '日志' })).toBeVisible()

    // 操作按钮
    await expect(page.getByText('清空')).toBeVisible()
    await expect(page.getByText('打开日志目录').first()).toBeVisible()
    await expect(page.getByText('打开日志文件').first()).toBeVisible()

    await page.locator('nav button').filter({ hasText: '首页' }).click()
    await page.waitForTimeout(300)
  })
})
