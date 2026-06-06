/**
 * 进程扫描器测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock child_process.exec
vi.mock('child_process', () => {
  const mockExec = vi.fn()
  return { exec: mockExec, promisify: vi.fn() }
})

// Need to mock promisify differently since it's imported from util
vi.mock('util', () => ({
  promisify: vi.fn(() => {
    return vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
  })
}))

// Re-import with mocks
import { exec } from 'child_process'

describe('process-scanner 模块', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('应正确导入模块', async () => {
    const mod = await import('../../../src/core/game-detect/process-scanner')
    expect(mod.processScanner).toBeDefined()
    expect(typeof mod.processScanner.isRunning).toBe('function')
  })
})
