/**
 * 端口检测器测试
 */
import { describe, it, expect } from 'vitest'
import { portChecker } from '../../../src/core/game-detect/port-checker'

describe('端口检测器', () => {
  it('未使用的端口应返回 inUse=false', async () => {
    const result = await portChecker.checkPort(48721, 'tcp')
    expect(result.inUse).toBe(false)
    expect(result.port).toBe(48721)
    expect(result.protocol).toBe('tcp')
  })

  it('checkPorts 应返回所有结果', async () => {
    const results = await portChecker.checkPorts([48722, 48723, 48724], 'tcp')
    expect(results).toHaveLength(3)
    for (const r of results) {
      expect(r.inUse).toBe(false)
    }
  })
})
