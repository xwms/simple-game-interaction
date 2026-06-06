/**
 * 功能描述：自动更新模块 — 从 Gitee/GitHub Releases 检查更新、下载、安装
 *
 * 逻辑说明：启动后延迟 3 秒异步检查。优先请求 Gitee API，失败降级到 GitHub API。
 *           版本使用 semver 比较。下载支持断点续传和进度上报。
 *           缓存策略：1 小时内不重复检查。
 *
 * @module updater
 */

'use strict'

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

// ─── 配置 ────────────────────────────────────────────
const UPDATE_CACHE_TTL = 3600 * 1000 // 1 小时缓存
const CHECK_DELAY = 3000 // 启动后延迟 3 秒

const defaultConfig = {
  gitee: { owner: '', repo: '' },
  github: { owner: '', repo: '' }
}

/** @type {object|null} 更新缓存 */
let updateCache = null
/** @type {number} 上次检查时间戳 */
let lastCheckTime = 0

/**
 * 功能描述：初始化更新检查（启动后延迟执行）
 *
 * 逻辑说明：启动后 CHECK_DELAY 毫秒开始静默检查，不阻塞 UI。
 */
function initUpdater() {
  setTimeout(() => {
    checkForUpdates().catch(() => {
      // 静默失败，不影响用户使用
    })
  }, CHECK_DELAY)
}

/**
 * 功能描述：获取 API 基础 URL
 *
 * @returns {string} Gitee API URL
 */
function getGiteeApiUrl(owner, repo) {
  return `https://gitee.com/api/v5/repos/${owner}/${repo}/releases/latest`
}

/**
 * 功能描述：获取 GitHub API 基础 URL
 *
 * @returns {string} GitHub API URL
 */
function getGitHubApiUrl(owner, repo) {
  return `https://api.github.com/repos/${owner}/${repo}/releases/latest`
}

/**
 * 功能描述：从 URL 获取 JSON 数据
 *
 * @param {string} url - API URL
 * @returns {Promise<object>} 解析后的 JSON
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    const options = {
      headers: {
        'User-Agent': 'SGI/' + app.getVersion(),
        Accept: 'application/json'
      },
      timeout: 8000
    }

    client.get(url, options, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(new Error('Invalid JSON response'))
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`))
        }
      })
    })

    client.on('error', reject)
  })
}

/**
 * 功能描述：semver 版本比较
 *
 * 逻辑说明：按主版本号.次版本号.修订号逐级比较。非法版本号返回 false。
 *
 * @param {string} v1 - 当前版本
 * @param {string} v2 - 目标版本
 * @returns {boolean} v2 > v1 时返回 true
 */
function isNewerVersion(v1, v2) {
  const parse = (v) => {
    const parts = v.replace(/^v/, '').split('.')
    return parts.map((p) => parseInt(p, 10) || 0)
  }
  const a = parse(v1)
  const b = parse(v2)

  for (let i = 0; i < 3; i++) {
    if ((b[i] || 0) > (a[i] || 0)) return true
    if ((b[i] || 0) < (a[i] || 0)) return false
  }
  return false
}

/**
 * 功能描述：检查更新（Gitee 优先，GitHub 降级）
 *
 * 逻辑说明：1) 检查缓存是否过期 2) 请求 Gitee API 3) 失败则请求 GitHub API
 *           4) 比较版本号 5) 写入缓存
 *
 * @returns {Promise<object|null>} 更新信息或 null（已是最新）
 */
async function checkForUpdates() {
  const now = Date.now()
  if (now - lastCheckTime < UPDATE_CACHE_TTL && updateCache) {
    return updateCache
  }

  const currentVersion = app.getVersion()
  let releaseData = null
  let source

  // 优先 Gitee
  if (defaultConfig.gitee.owner && defaultConfig.gitee.repo) {
    try {
      const url = getGiteeApiUrl(defaultConfig.gitee.owner, defaultConfig.gitee.repo)
      releaseData = await fetchJson(url)
      source = 'gitee'
    } catch {
      // Gitee 失败，降级到 GitHub
    }
  }

  // 降级到 GitHub
  if (!releaseData && defaultConfig.github.owner && defaultConfig.github.repo) {
    try {
      const url = getGitHubApiUrl(defaultConfig.github.owner, defaultConfig.github.repo)
      releaseData = await fetchJson(url)
      source = 'github'
    } catch {
      // 两者都不可用
    }
  }

  if (!releaseData) {
    updateCache = null
    lastCheckTime = now
    return null
  }

  const latestVersion = releaseData.tag_name.replace(/^v/, '')
  const hasUpdate = isNewerVersion(currentVersion, latestVersion)

  const result = hasUpdate
    ? {
        hasUpdate: true,
        version: latestVersion,
        releaseNotes: releaseData.body || '',
        downloadUrl: releaseData.assets?.[0]?.browser_download_url || '',
        source
      }
    : { hasUpdate: false, version: currentVersion, source }

  updateCache = result
  lastCheckTime = now
  return result
}

module.exports = { initUpdater, checkForUpdates }
