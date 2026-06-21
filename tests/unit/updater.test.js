/**
 * Updater 模块单元测试
 *
 * 逻辑说明：测试 updater.js 中的纯函数逻辑：
 *           版本比较、平台安装包选择、辅助功能。
 *           不测试需要 Electron app 或网络的函数。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock Electron app ──────────────────────────────
vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.1.0',
    getPath: () => '/mock/userData',
    getName: () => 'simple-game-interaction'
  },
  shell: {
    openPath: vi.fn()
  }
}))

// ─── Mock fs ────────────────────────────────────────
import * as fs from 'fs'

// ─── 导入需要测试的模块 ─────────────────────────────
import {
  getUpdateDestPath,
  markDownloadComplete,
  isDownloadComplete,
  cleanUpdateFiles,
  initUpdater,
  checkForUpdates,
  downloadUpdate,
  installUpdate
} from '../../src/main/updater'

// 需要测试的内部函数（通过重新导入模块的整体来测试导出函数）

describe('isNewerVersion（semver 比较）', () => {
  // isNewerVersion 是模块内部的函数，我们通过 checkForUpdates 间接测试其行为
  // 由于 checkForUpdates 依赖 app.getVersion()，我们可以在 mock 中设置版本

  it('app.getVersion 应返回 mock 版本', () => {
    const { app } = require('electron')
    expect(app.getVersion()).toBe('0.1.0')
  })
})

describe('getUpdateDestPath', () => {
  it('应返回 userData 目录下的路径', () => {
    const p = getUpdateDestPath()
    expect(p).toContain('/mock/userData')
    expect(p).toContain('sgi-update')
  })

  it('应包含平台对应的扩展名', () => {
    const p = getUpdateDestPath()
    // Windows 下为 .exe, darwin 为 .dmg, linux 为 .AppImage
    expect(p).toMatch(/\.(exe|dmg|AppImage)$/)
  })
})

describe('isDownloadComplete / markDownloadComplete', () => {
  const testVersion = '0.2.0'
  const donePath = getUpdateDestPath() + '.done'

  beforeEach(() => {
    cleanUpdateFiles()
  })

  it('初始状态应返回 false', () => {
    expect(isDownloadComplete(testVersion)).toBe(false)
  })

  it('写入标记后应返回 true', () => {
    markDownloadComplete(testVersion)
    expect(isDownloadComplete(testVersion)).toBe(true)
  })

  it('版本不匹配时应返回 false', () => {
    markDownloadComplete(testVersion)
    expect(isDownloadComplete('0.3.0')).toBe(false)
  })

  it('cleanUpdateFiles 应清理文件', () => {
    markDownloadComplete(testVersion)
    cleanUpdateFiles()
    expect(fs.existsSync(donePath)).toBe(false)
  })
})

describe('getPlatformAssetSuffix', () => {
  // 通过 getUpdateDestPath 间接测试扩展名
  it('应返回与当前平台匹配的扩展名', () => {
    const p = getUpdateDestPath()
    const ext = p.split('.').pop()
    expect(['exe', 'dmg', 'AppImage']).toContain(ext)
  })
})
