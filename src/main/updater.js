/**
 * 功能描述：自动更新模块 — 检查更新、下载、安装
 *
 * 逻辑说明：启动后延迟 3 秒异步检查。优先请求 Gitee API，失败降级到 GitHub API。
 *           版本使用 semver 比较。下载支持进度上报。缓存策略：1 小时内不重复检查。
 *           根据运行平台自动选择对应安装包（exe / dmg / AppImage）。
 *           下载支持断点续传（含跨重启）。安装覆盖 Windows/macOS/Linux。
 *
 * @module updater
 */

'use strict'

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync, execSync, execFileSync } = require('child_process')
const { app, shell } = require('electron')

// ─── 配置 ────────────────────────────────────────────
const UPDATE_CACHE_TTL = 3600 * 1000 // 1 小时缓存
const CHECK_DELAY = 3000 // 启动后延迟 3 秒
const UPDATE_FILE_BASE = 'sgi-update'

const defaultConfig = {
  gitee: { owner: 'xwms', repo: 'simple-game-interaction' },
  github: { owner: 'xwms', repo: 'simple-game-interaction' }
}

/**
 * 功能描述：返回当前平台的安装包扩展名
 *
 * 逻辑说明：Linux 根据安装方式选择：AppImage 环境变量存在时用 .AppImage，
 *           否则 Arch Linux 用 .pacman，其余用 .deb。
 *
 * @returns {string} 扩展名（.exe / .dmg / .AppImage / .deb / .pacman）
 */
function getPlatformAssetSuffix() {
  switch (process.platform) {
    case 'win32': return '.exe'
    case 'darwin': return '.dmg'
    case 'linux': {
      if (process.env.APPIMAGE) return '.AppImage'
      return _detectLinuxDistro() === 'arch' ? '.pacman' : '.deb'
    }
    default: return '.exe'
  }
}

/**
 * 功能描述：获取更新文件的目标路径（固定路径，支持续传）
 *
 * 逻辑说明：使用 userData 目录而非 os.tmpdir()，与 electron-updater 行为一致
 *
 * @returns {string} userData 目录下的固定文件名路径
 */
function getUpdateDestPath() {
  return path.join(app.getPath('userData'), UPDATE_FILE_BASE + getPlatformAssetSuffix())
}

/**
 * 功能描述：写入下载完成标记（附带版本号）
 *
 * @param {string} version - 已下载的版本号
 */
function markDownloadComplete(version) {
  fs.writeFileSync(getUpdateDestPath() + '.done', version, 'utf-8')
}

/**
 * 功能描述：检查指定版本是否已下载完成
 *
 * @param {string} version - 要检查的版本号
 * @returns {boolean} 标记存在且版本匹配时返回 true
 */
function isDownloadComplete(version) {
  try {
    const content = fs.readFileSync(getUpdateDestPath() + '.done', 'utf-8')
    return content.trim() === version
  } catch {
    return false
  }
}

/**
 * 功能描述：清理更新临时文件和标记
 */
function cleanUpdateFiles() {
  try { fs.unlinkSync(getUpdateDestPath()) } catch (e) { /* ignore */ }
  try { fs.unlinkSync(getUpdateDestPath() + '.done') } catch (e) { /* ignore */ }
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

    // GitHub API 在国内可能被 SNI 阻断导致证书验证失败
    if (url.startsWith('https')) {
      options.rejectUnauthorized = false
    }

    client.get(url, options, (res) => {
      res.setEncoding('utf-8')
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
    }).on('error', reject)
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
 * 功能描述：从 Release assets 中筛选当前平台的安装包
 *
 * 逻辑说明：根据文件名扩展名匹配当前平台。找不到时回退到第一个 asset。
 *
 * @param {Array<{name: string, browser_download_url: string}>} assets - Release 的 assets 列表
 * @returns {{name: string, browser_download_url: string}|null} 匹配的 asset
 */
function findPlatformAsset(assets) {
  if (!assets || assets.length === 0) return null
  const suffix = getPlatformAssetSuffix()
  const match = assets.find(a =>
    a.name.toLowerCase().endsWith(suffix.toLowerCase()) ||
    a.browser_download_url.toLowerCase().endsWith(suffix.toLowerCase())
  )
  return match || assets[0]
}

/**
 * 功能描述：检查更新（Gitee 优先，GitHub 降级）
 *
 * 逻辑说明：1) 检查缓存是否过期 2) 请求 Gitee API 3) 失败则请求 GitHub API
 *           4) 比较版本号 5) 写入缓存
 *
 * @param {string} [versionOverride] - 可选，由渲染进程传入的版本号（避免 dev 模式下 app.getVersion() 返回 Electron 版本）
 * @returns {Promise<object|null>} 更新信息或 null（已是最新）
 */
async function checkForUpdates(versionOverride) {
  const now = Date.now()

  // 缓存命中但版本不一致时（如 dev 模式 app.getVersion 返回 Electron 版本），
  // 忽略缓存重新请求
  if (versionOverride && updateCache && updateCache.version !== versionOverride) {
    updateCache = null
    lastCheckTime = 0
  }

  if (now - lastCheckTime < UPDATE_CACHE_TTL && updateCache) {
    // 缓存命中时重新验证安装包文件是否仍存在
    if (updateCache.installAvailable) {
      try {
        const stat = fs.statSync(getUpdateDestPath())
        if (!stat.isFile() || stat.size === 0) {
          updateCache.installAvailable = false
          delete updateCache.installPath
          cleanUpdateFiles()
        }
      } catch {
        updateCache.installAvailable = false
        delete updateCache.installPath
        cleanUpdateFiles()
      }
    }
    return updateCache
  }

  const currentVersion = versionOverride || app.getVersion()
  let releaseData = null
  let source

  // 优先 Gitee
  if (defaultConfig.gitee.owner && defaultConfig.gitee.repo) {
    try {
      const url = getGiteeApiUrl(defaultConfig.gitee.owner, defaultConfig.gitee.repo)
      releaseData = await fetchJson(url)
      source = 'gitee'
    } catch {
      // 忽略，降级到 GitHub
    }
  }

  // 降级到 GitHub
  if (!releaseData && defaultConfig.github.owner && defaultConfig.github.repo) {
    try {
      const url = getGitHubApiUrl(defaultConfig.github.owner, defaultConfig.github.repo)
      releaseData = await fetchJson(url)
      source = 'github'
    } catch {
      // 忽略
    }
  }

  if (!releaseData) {
    updateCache = null
    lastCheckTime = now
    return null
  }

  const latestVersion = releaseData.tag_name.replace(/^v/, '')
  const hasUpdate = isNewerVersion(currentVersion, latestVersion)

  // 检测是否存在已部分下载的文件，用于跨重启续传
  let downloadedBytes = 0
  let installAvailable = false
  if (hasUpdate) {
    try {
      const stat = fs.statSync(getUpdateDestPath())
      if (stat.isFile() && stat.size > 0) {
        downloadedBytes = stat.size
      }
    } catch { /* 文件不存在，从头下载 */ }
    installAvailable = isDownloadComplete(latestVersion)

    // 验证实际安装包文件存在，不存在则清理标记
    if (installAvailable) {
      try {
        const stat = fs.statSync(getUpdateDestPath())
        if (!stat.isFile() || stat.size === 0) {
          installAvailable = false
          cleanUpdateFiles()
        }
      } catch {
        installAvailable = false
        cleanUpdateFiles()
      }
    }

    // 下载完成标记存在但版本不匹配（如已下载 v0.2.0 但服务器已发布 v0.3.0）
    // 清理旧文件，避免误判为"继续下载"或安装旧版本
    if (!installAvailable && downloadedBytes > 0) {
      try {
        const content = fs.readFileSync(getUpdateDestPath() + '.done', 'utf-8').trim()
        if (content && content !== latestVersion) {
          cleanUpdateFiles()
          downloadedBytes = 0
        }
      } catch { /* 无标记文件，说明是未完成的部分下载，保留用于续传 */ }
    }
  }

  const result = {
    hasUpdate,
    version: hasUpdate ? latestVersion : currentVersion,
    releaseNotes: releaseData.body || '',
    source,
    ...(hasUpdate
      ? {
          downloadUrl: findPlatformAsset(releaseData.assets)?.browser_download_url || '',
          downloadedBytes,
          installAvailable,
          ...(installAvailable ? { installPath: getUpdateDestPath() } : {})
        }
      : {})
  }

  updateCache = result
  lastCheckTime = now
  return result
}

/**
 * 功能描述：下载更新文件，实时回调进度
 *
 * 逻辑说明：从 downloadUrl 下载安装包到临时目录，每收到一个数据块
 *           计算下载百分比并通过 onProgress 回调上报。支持断点重连。
 *
 * @param {string} downloadUrl - 下载 URL
 * @param {string} destPath - 目标文件路径
 * @param {function} onProgress - 进度回调 (percent: number)
 * @returns {Promise<string>} 下载完成后的文件路径
 * @throws 下载失败、文件写入失败
 */
function downloadUpdate(downloadUrl, destPath, onProgress, redirectCount) {
  return new Promise((resolve, reject) => {
    redirectCount = redirectCount || 0
    if (redirectCount > 5) {
      reject(new Error('重定向次数过多'))
      return
    }

    const client = downloadUrl.startsWith('https') ? https : http

    // 检查是否存在部分下载的文件，用于断点续传
    let existingSize = 0
    try {
      const stat = fs.statSync(destPath)
      if (stat.isFile() && stat.size > 0) {
        existingSize = stat.size
      }
    } catch { /* 文件不存在，从头下载 */ }

    const options = {
      headers: {
        'User-Agent': 'SGI/' + app.getVersion()
      }
    }

    if (downloadUrl.startsWith('https')) {
      options.rejectUnauthorized = false
    }

    // 已有部分文件：请求 Range 续传（仅首次请求）
    if (existingSize > 0) {
      options.headers.Range = `bytes=${existingSize}-`
    }

    client.get(downloadUrl, options, (res) => {
      // 处理重定向（Gitee CDN 会返回 302）
      if (res.statusCode >= 301 && res.statusCode <= 303 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, downloadUrl).href
        return resolve(downloadUpdate(redirectUrl, destPath, onProgress, redirectCount + 1))
      }

      // 服务器不支持 Range / 文件已变更：重新下载
      if (res.statusCode === 200 && existingSize > 0) {
        existingSize = 0
      }

      if (res.statusCode !== 200 && res.statusCode !== 206) {
        reject(new Error(`下载失败: HTTP ${res.statusCode}`))
        return
      }

      // 总大小：206 时从 Content-Range 取，200 时从 Content-Length 取
      let totalSize = parseInt(res.headers['content-length'] || '0', 10)
      if (res.statusCode === 206) {
        const match = (res.headers['content-range'] || '').match(/bytes \d+-\d+\/(\d+)/)
        if (match) totalSize = parseInt(match[1], 10)
      }

      let downloadedSize = existingSize
      let lastReported = -1

      // append 模式写入（续传时不覆盖已有内容）
      const writeStream = fs.createWriteStream(destPath, { flags: existingSize > 0 ? 'a' : 'w' })

      res.on('data', (chunk) => {
        downloadedSize += chunk.length
        writeStream.write(chunk)

        if (totalSize > 0) {
          const percent = Math.min(Math.round((downloadedSize / totalSize) * 100), 100)
          if (percent !== lastReported) {
            lastReported = percent
            onProgress(percent)
          }
        }
      })

      res.on('end', () => {
        writeStream.end()
        onProgress(100)
        resolve(destPath)
      })

      res.on('error', (err) => {
        writeStream.destroy()
        reject(err)
      })
    }).on('error', reject)
  })
}

// ─── Linux 安装工具函数 ─────────────────────────────

/**
 * 功能描述：探测 Linux 发行版类型
 *
 * @returns {'debian'|'arch'|'unknown'} 发行版类型
 */
function _detectLinuxDistro() {
  if (process.platform !== 'linux') return 'unknown'
  // Arch Linux
  try {
    if (fs.existsSync('/etc/arch-release')) return 'arch'
    execFileSync('which', ['pacman'], { encoding: 'utf-8', timeout: 2000 })
    return 'arch'
  } catch { /* not arch */ }
  // Debian / Ubuntu
  try {
    if (fs.existsSync('/etc/debian_version')) return 'debian'
    execFileSync('which', ['dpkg'], { encoding: 'utf-8', timeout: 2000 })
    return 'debian'
  } catch { /* not debian */ }
  return 'unknown'
}

/**
 * 功能描述：探测可用的图形化提权命令
 *
 * 逻辑说明：按优先级探测 gksudo / kdesudo / pkexec / sudo。
 *          优先使用带 GUI 弹窗的工具，sudo 作为最后回退。
 *
 * @returns {string} 提权命令
 */
function _detectSudoCommand() {
  const candidates = ['gksudo', 'kdesudo', 'pkexec', 'sudo']
  for (const cmd of candidates) {
    try {
      execFileSync('which', [cmd], { encoding: 'utf-8', timeout: 2000 })
      return cmd
    } catch { /* not available */ }
  }
  return 'sudo'
}

/**
 * 功能描述：使用提权执行安装命令（同步，带超时）
 *
 * @param {string} sudoCmd - 提权命令
 * @param {string} command - 要执行的命令
 * @param {string[]} args - 参数列表
 * @throws {Error} 安装失败或超时
 */
function _execWithSudo(sudoCmd, command, args) {
  let cmd, cmdArgs

  switch (sudoCmd) {
    case 'pkexec':
      cmd = 'pkexec'
      cmdArgs = [command, ...args]
      break
    case 'gksudo':
      cmd = 'gksudo'
      cmdArgs = ['--message', '需要提权来安装更新', '-c', `${command} ${args.join(' ')}`]
      break
    case 'kdesudo':
      cmd = 'kdesudo'
      cmdArgs = ['--comment', '需要提权来安装更新', '-c', `${command} ${args.join(' ')}`]
      break
    default: // sudo
      cmd = 'sudo'
      cmdArgs = [command, ...args]
  }

  const result = spawnSync(cmd, cmdArgs, { stdio: 'inherit', timeout: 300000, encoding: 'utf-8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`命令退出码 ${result.status}`)
}

/**
 * 功能描述：安装更新（跨平台）
 *
 * 逻辑说明：Windows 下用 shell.openPath 启动安装器（绕过 Chromium Job Object）；
 *           macOS 下挂载 DMG → 拷贝 .app 到 /Applications → 打开；
 *           Linux 下根据发行版选择 deb/pacman/AppImage。
 *
 * @param {string} filePath - 下载完成的安装包路径
 * @returns {Promise<void>}
 */
async function installUpdate(filePath) {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.exe') {
    // 使用 spawn + detached + shell 绕过 Chromium Job Object 限制
    // 传入 --updated 告诉 NSIS 这是更新（自动读取注册表中的上次安装路径）
    console.log(`[updater] 启动安装: ${filePath}`)
    try {
      spawn(filePath, ['--updated'], {
        detached: true,
        stdio: 'ignore',
        shell: true
      }).unref()
      console.log('[updater] 安装进程已启动，退出应用...')
    } catch (err) {
      console.error(`[updater] 安装异常: ${err.message}`)
    }
    // 退出当前应用，让 NSIS 安装器覆盖文件
    setTimeout(() => app.quit(), 500)
    return
  }

  if (ext === '.dmg') {
    // macOS：挂载 DMG → 拷贝 .app → 卸载 → 打开
    const mountOutput = execSync(`hdiutil attach "${filePath}" -nobrowse -quiet`, { encoding: 'utf-8', timeout: 30000 })
    const lines = mountOutput.trim().split('\n').filter(Boolean)
    const mountPoint = lines[lines.length - 1].split('\t').pop().trim()

    try {
      const items = fs.readdirSync(mountPoint)
      const appName = items.find(i => i.endsWith('.app'))
      if (appName) {
        const destApp = path.join('/Applications', appName)
        // 删除旧版本（如果有）
        try { fs.rmSync(destApp, { recursive: true, force: true }) } catch { /* ignore */ }
        execSync(`cp -R "${path.join(mountPoint, appName)}" /Applications/`, { timeout: 60000 })
        spawn('open', ['-a', destApp], { detached: true })
      }
    } finally {
      try { execSync(`hdiutil detach "${mountPoint}" -quiet`, { timeout: 10000 }) } catch { /* ignore */ }
    }
    app.quit()
    return
  }

  if (ext === '.appimage') {
    // Linux AppImage：替换旧文件后启动
    // APPIMAGE 环境变量由 AppImage 运行时自动设置，指向原 .AppImage 文件路径
    const currentAppImage = process.env.APPIMAGE
    if (currentAppImage && currentAppImage !== filePath) {
      try {
        fs.copyFileSync(filePath, currentAppImage)
        fs.chmodSync(currentAppImage, 0o755)
        spawn(currentAppImage, ['--updated'], { detached: true, stdio: 'ignore' })
        console.log(`[updater] 已替换 ${currentAppImage}，启动新版本...`)
      } catch (err) {
        // ETXTBSY: 运行中的 AppImage 无法被直接 overwrite
        // 改用 unlink + mv 策略：先删除原文件的目录项（进程因持有 fd 继续运行），
        // 再 mv 新文件到原路径。来源参考：https://stackoverflow.com/a/1712051/1910191
        console.error(`[updater] 替换旧文件失败，改用 unlink+mv 策略: ${err.message}`)
        try {
          fs.unlinkSync(currentAppImage)
          execFileSync('mv', ['-f', filePath, currentAppImage])
          fs.chmodSync(currentAppImage, 0o755)
          spawn(currentAppImage, ['--updated'], { detached: true, stdio: 'ignore' })
        } catch (err2) {
          // 最后的回退：直接从下载路径启动
          console.error(`[updater] unlink+mv 也失败，回退到直接启动: ${err2.message}`)
          fs.chmodSync(filePath, 0o755)
          spawn(filePath, ['--updated'], { detached: true, stdio: 'ignore' })
        }
      }
    } else {
      fs.chmodSync(filePath, 0o755)
      spawn(filePath, ['--updated'], { detached: true, stdio: 'ignore' })
    }
    app.quit()
    return
  }

  // ─── Linux deb ─────────────────────────────────────
  if (ext === '.deb') {
    const sudoCmd = _detectSudoCommand()
    console.log(`[updater] 使用 ${sudoCmd} 安装 deb: ${filePath}`)

    try {
      _execWithSudo(sudoCmd, 'dpkg', ['-i', filePath])
      console.log('[updater] deb 安装成功')
    } catch (err) {
      // dpkg 因缺少依赖失败时，补 apt-get install -f
      console.error(`[updater] dpkg -i 失败，尝试修复依赖: ${err.message}`)
      try {
        _execWithSudo(sudoCmd, 'apt-get', ['install', '-f', '-y'])
        console.log('[updater] 依赖修复完成')
      } catch (err2) {
        console.error(`[updater] 依赖修复失败: ${err2.message}`)
      }
    }

    app.quit()
    return
  }

  // ─── Linux pacman (Arch) ───────────────────────────
  if (ext === '.pacman' || filePath.endsWith('.pkg.tar.zst') || filePath.endsWith('.pkg.tar.xz')) {
    const sudoCmd = _detectSudoCommand()
    console.log(`[updater] 使用 ${sudoCmd} 安装 pacman: ${filePath}`)

    try {
      _execWithSudo(sudoCmd, 'pacman', ['-U', '--noconfirm', filePath])
      console.log('[updater] pacman 安装成功')
    } catch (err) {
      console.error(`[updater] pacman -U 失败，尝试更新数据库后重试: ${err.message}`)
      try {
        _execWithSudo(sudoCmd, 'pacman', ['-Sy', '--noconfirm'])
        _execWithSudo(sudoCmd, 'pacman', ['-U', '--noconfirm', filePath])
        console.log('[updater] pacman 重试安装成功')
      } catch (err2) {
        console.error(`[updater] pacman 重试也失败: ${err2.message}`)
      }
    }

    app.quit()
    return
  }

  // 未知格式：让用户手动处理
  await shell.openPath(filePath)
}

module.exports = { initUpdater, checkForUpdates, downloadUpdate, installUpdate, getUpdateDestPath, markDownloadComplete, isDownloadComplete, cleanUpdateFiles }
