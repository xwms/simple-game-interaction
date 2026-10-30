#!/usr/bin/env node
/**
 * 功能描述：一键发布 SGI 新版本
 *
 * 逻辑说明：预检（分支/工作区/远端同步/tag 冲突）→ 更新版本号与 CHANGELOG →
 *           本地 type-check/test/build → 提交 → 打 tag → 推送 →
 *           跟踪 GitHub Actions → 校验 Release 产物。
 *           更新日志默认从上次 tag 以来的提交自动生成，也可用位置参数覆盖。
 *
 * 用法：
 *   node scripts/release.mjs 1.2.3
 *   node scripts/release.mjs 1.2.3 "本次发布的补充说明"
 *   node scripts/release.mjs 1.2.3 --dry-run
 *   node scripts/release.mjs 1.2.3 --skip-checks
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── 常量 ─────────────────────────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IS_WIN = process.platform === 'win32'
const NPM = IS_WIN ? 'npm.cmd' : 'npm'
const TAG_PREFIX = 'v'
const CI_WORKFLOW = 'ci.yml'
const CI_CREATE_TIMEOUT_MS = 5 * 60 * 1000
const RELEASE_TIMEOUT_MS = 20 * 60 * 1000
const POLL_INTERVAL_MS = 5000

/** 提交类型到更新日志分组的映射 */
const NOTES_HEADINGS = {
  feat: '新增',
  fix: '修复',
  perf: '优化',
  refactor: '优化',
  docs: '文档',
  test: '测试',
  chore: '其他',
  style: '其他',
  build: '其他',
  ci: '其他'
}

// ─── 命令执行 ─────────────────────────────────────────

/**
 * 功能描述：执行命令并继承输出，失败时抛错
 *
 * @param {string} command - 可执行文件
 * @param {string[]} args - 参数列表
 * @param {object} [options] - spawnSync 选项
 * @returns {import('node:child_process').SpawnSyncReturns<Buffer>} 执行结果
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WIN,
    ...options
  })
  if (result.error) throw new Error(`${command} 无法执行：${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败（exit ${result.status}）`)
  return result
}

/**
 * 功能描述：执行命令并捕获输出
 *
 * @param {string} command - 可执行文件
 * @param {string[]} args - 参数列表
 * @returns {{ ok: boolean, out: string, err: string, status: number | null }} 执行结果
 */
function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: IS_WIN
  })
  return {
    ok: result.status === 0,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
    status: result.status
  }
}

/**
 * 功能描述：执行 git 命令并返回输出，失败抛错
 *
 * @param {...string} args - git 参数
 * @returns {string} 去尾空白的输出
 */
function gitOut(...args) {
  const result = capture('git', args)
  if (!result.ok) throw new Error(`git ${args.join(' ')} 失败：${result.err || `exit ${result.status}`}`)
  return result.out
}

/**
 * 功能描述：执行可失败的 git 命令
 *
 * @param {...string} args - git 参数
 * @returns {{ ok: boolean, out: string, err: string, status: number | null }} 执行结果
 */
function tryGit(...args) {
  return capture('git', args)
}

// ─── 通用工具 ─────────────────────────────────────────

/** 功能描述：打印进度 */
function log(message) {
  console.log(`[release] ${message}`)
}

/** 功能描述：打印警告 */
function warn(message) {
  console.warn(`[release] 警告：${message}`)
}

/** 功能描述：打印用法并以指定状态退出 */
function usage(exitCode = 0) {
  console.log(`用法：node scripts/release.mjs <version> [说明] [选项]

参数：
  version        新版本号，格式 X.Y.Z（不含 v 前缀）
  说明           可选，作为更新日志正文；省略时按提交记录自动生成

选项：
  --dry-run      只预检并打印将写入的更新日志，不修改文件、不提交、不推送
  --skip-checks  跳过本地 type-check/test/build（不建议）
  --offline      跳过远端 fetch/tag 检查（网络不可用时的预览模式）
  --help, -h     显示本帮助`)
  process.exit(exitCode)
}

/** 功能描述：返回本地日期 YYYY-MM-DD */
function today() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 功能描述：按数字段比较两个 X.Y.Z 版本 */
function compareVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

/** 功能描述：等待指定毫秒 */
function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

// ─── 更新日志 ─────────────────────────────────────────

/**
 * 功能描述：从上次 tag 以来的提交生成更新日志
 *
 * 逻辑说明：读取 git log 的提交标题，按 conventional commit 前缀分组；
 *           无前缀或未知类型的提交归入“其他”。跳过 merge 提交。
 *
 * @param {string} lastTag - 上一个 tag，空字符串表示从首个提交开始
 * @returns {string} Markdown 更新日志正文
 */
function generateNotes(lastTag) {
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD'
  const raw = gitOut('log', range, '--no-merges', '--pretty=format:%s')
  if (!raw) return '### 其他\n- 版本更新'

  const groups = new Map()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const match = line.match(/^([a-zA-Z]+)(?:\([^)]*\))?!?:\s*(.*)$/)
    const type = match ? match[1].toLowerCase() : ''
    const text = match ? match[2] : line
    const heading = NOTES_HEADINGS[type] ?? '其他'
    if (!groups.has(heading)) groups.set(heading, [])
    groups.get(heading).push(text)
  }

  const order = ['新增', '修复', '优化', '文档', '测试', '其他']
  return order
    .filter(heading => groups.has(heading))
    .map(heading => `### ${heading}\n${groups.get(heading).map(text => `- ${text}`).join('\n')}`)
    .join('\n\n')
}

// ─── 文件写入 ─────────────────────────────────────────

/**
 * 功能描述：更新 package.json 与 package-lock.json 的根版本号
 *
 * 逻辑说明：用正则只替换根版本字段，避免 JSON 重新序列化造成无关格式变动；
 *           lock 文件的根版本可能长期未同步，此处一并修正。
 *
 * @param {string} version - 新版本号
 */
function bumpVersion(version) {
  const pkgPath = resolve(ROOT, 'package.json')
  const pkgRaw = readFileSync(pkgPath, 'utf8')
  const pkgNext = pkgRaw.replace(/("version"\s*:\s*")[^"]+(")/, (_match, before, after) => `${before}${version}${after}`)
  if (pkgNext === pkgRaw) throw new Error('无法更新 package.json 的 version 字段')
  writeFileSync(pkgPath, pkgNext)

  const lockPath = resolve(ROOT, 'package-lock.json')
  if (!existsSync(lockPath)) return
  const lockRaw = readFileSync(lockPath, 'utf8')
  let lockNext = lockRaw.replace(
    /("name"\s*:\s*"[^"]*",\s*"version"\s*:\s*")[^"]+(")/,
    (_match, before, after) => `${before}${version}${after}`
  )
  lockNext = lockNext.replace(
    /("packages"\s*:\s*\{\s*"":\s*\{[\s\S]*?"version"\s*:\s*")[^"]+(")/,
    (_match, before, after) => `${before}${version}${after}`
  )
  if (lockNext !== lockRaw) writeFileSync(lockPath, lockNext)
}

/**
 * 功能描述：在 CHANGELOG.md 顶部插入新版本段落
 *
 * @param {string} version - 新版本号
 * @param {string} body - 更新日志正文
 */
function writeChangelog(version, body) {
  const path = resolve(ROOT, 'CHANGELOG.md')
  const raw = readFileSync(path, 'utf8')
  const anchorIndex = raw.indexOf('# 更新日志')
  if (anchorIndex === -1) throw new Error('CHANGELOG.md 缺少“# 更新日志”标题')

  const lineEnd = raw.indexOf('\n', anchorIndex)
  const insertAt = lineEnd === -1 ? raw.length : lineEnd + 1
  const section = `\n## [${version}] — ${today()}\n\n${body.trim()}\n\n---\n`
  writeFileSync(path, raw.slice(0, insertAt) + section + raw.slice(insertAt))
}

// ─── CI 跟踪 ──────────────────────────────────────────

/**
 * 功能描述：等待并跟踪 tag 对应的 CI 运行
 *
 * 逻辑说明：推送 main 与 tag 会各触发一次流水线，按 headBranch 精确匹配 tag；
 *           找到后用 gh run watch 阻塞等待结果。
 *
 * @param {string} tag - 版本 tag
 * @returns {Promise<boolean>} CI 是否成功
 */
async function watchCi(tag) {
  if (!capture('gh', ['auth', 'status']).ok) {
    warn('gh 未安装或未登录，跳过 CI 跟踪。请手动查看 Actions 页面。')
    return true
  }

  log('等待 GitHub Actions 创建 tag 流水线...')
  const deadline = Date.now() + CI_CREATE_TIMEOUT_MS
  let runId = ''

  while (Date.now() < deadline) {
    const result = capture('gh', [
      'run', 'list',
      '--workflow', CI_WORKFLOW,
      '--limit', '20',
      '--json', 'databaseId,headBranch,status,conclusion'
    ])
    if (result.ok && result.out) {
      try {
        const runs = JSON.parse(result.out)
        const match = runs.find(item => item.headBranch === tag)
        if (match) {
          runId = String(match.databaseId)
          break
        }
      } catch {
        // 输出解析失败时继续轮询
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }

  if (!runId) {
    warn(`未找到 tag ${tag} 的流水线，请手动检查：gh run list`)
    return false
  }

  log(`跟踪 CI 运行 ${runId} ...`)
  const result = spawnSync('gh', ['run', 'watch', runId, '--interval', '15', '--exit-status'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: IS_WIN
  })
  return result.status === 0
}

/**
 * 功能描述：等待 GitHub Release 及其产物出现
 *
 * @param {string} tag - 版本 tag
 * @returns {Promise<boolean>} Release 是否可用
 */
async function waitForRelease(tag) {
  const deadline = Date.now() + RELEASE_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = capture('gh', ['release', 'view', tag, '--json', 'url,assets'])
    if (result.ok && result.out) {
      try {
        const data = JSON.parse(result.out)
        if (Array.isArray(data.assets) && data.assets.length > 0) {
          log(`Release 已创建：${data.url}`)
          for (const asset of data.assets) log(`  - ${asset.name}`)
          return true
        }
      } catch {
        // 继续轮询
      }
    }
    await sleep(10000)
  }
  return false
}

/** 功能描述：打印发布失败后的回滚提示 */
function rollbackHint(tag) {
  return [
    '回滚参考（不会自动执行）：',
    `  git tag -d ${tag}`,
    `  git push origin --delete ${tag}`,
    '  已推送到 main 的提交请使用 git revert，不要 force push。'
  ].join('\n')
}

// ─── 主流程 ───────────────────────────────────────────

/**
 * 功能描述：发布主流程
 */
async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) usage()

  const flags = new Set(argv.filter(arg => arg.startsWith('--')))
  const positional = argv.filter(arg => !arg.startsWith('--'))
  const version = positional[0]
  const providedNotes = positional.slice(1).join(' ').trim()
  const dryRun = flags.has('--dry-run')
  const skipChecks = flags.has('--skip-checks')
  const offline = flags.has('--offline')

  if (!version) usage(1)
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`版本号必须是 X.Y.Z，收到：${version}`)

  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
  if (compareVersions(version, pkg.version) <= 0) {
    throw new Error(`新版本 ${version} 必须大于当前版本 ${pkg.version}`)
  }

  log(`准备发布 ${pkg.version} -> ${version}`)

  if (!tryGit('rev-parse', '--is-inside-work-tree').ok) throw new Error('当前目录不是 git 仓库')

  const branch = gitOut('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== 'main') throw new Error(`必须在 main 分支发布，当前分支：${branch}`)

  const dirty = gitOut('status', '--porcelain')
  if (dirty && !dryRun) {
    throw new Error(`工作区不干净，请先提交或清理：\n${dirty}`)
  }
  if (dirty && dryRun) warn('工作区有未提交改动，dry-run 仅做预览')

  if (offline) {
    warn('--offline：跳过远端同步与远端 tag 检查')
  } else {
    const fetched = tryGit('fetch', 'origin', 'main', '--tags')
    if (!fetched.ok) throw new Error(`无法 fetch origin，发布中止：${fetched.err || `exit ${fetched.status}`}`)

    const behind = Number(gitOut('rev-list', '--count', 'HEAD..origin/main'))
    if (behind > 0) throw new Error(`本地 main 落后 origin/main ${behind} 个提交，请先 pull`)
  }

  const tag = `${TAG_PREFIX}${version}`
  if (tryGit('rev-parse', '-q', '--verify', `refs/tags/${tag}`).ok) {
    throw new Error(`本地 tag ${tag} 已存在`)
  }
  if (!offline) {
    const remoteTag = tryGit('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)
    if (!remoteTag.ok) throw new Error(`无法检查远端 tag，发布中止：${remoteTag.err || `exit ${remoteTag.status}`}`)
    if (remoteTag.out) throw new Error(`远端 tag ${tag} 已存在`)
  }

  const lastTagResult = tryGit('describe', '--tags', '--abbrev=0', '--match', 'v*')
  const lastTag = lastTagResult.ok ? lastTagResult.out : ''
  const notes = providedNotes || generateNotes(lastTag)

  if (dryRun) {
    log(`将创建 tag：${tag}`)
    console.log(`\n## [${version}] — ${today()}\n\n${notes}\n`)
    log('dry-run 结束：未修改文件、未提交、未推送')
    return
  }

  bumpVersion(version)
  writeChangelog(version, notes)

  if (!skipChecks) {
    log('运行本地验证：type-check / test / build')
    run(NPM, ['run', 'type-check'])
    run(NPM, ['test'])
    run(NPM, ['run', 'build'])
  } else {
    warn('已跳过本地验证，仅依赖 CI')
  }

  const files = ['package.json', 'CHANGELOG.md']
  if (existsSync(resolve(ROOT, 'package-lock.json'))) files.push('package-lock.json')

  log(`提交并打 tag ${tag}`)
  run('git', ['add', ...files])
  run('git', ['commit', '-m', `chore: v${version}`])
  run('git', ['tag', '-a', tag, '-m', tag])

  log('推送 main 与 tag')
  run('git', ['push', 'origin', 'main'])
  run('git', ['push', 'origin', tag])

  const ciOk = await watchCi(tag)
  if (!ciOk) {
    warn('CI 失败，发布未完成')
    console.log(rollbackHint(tag))
    process.exitCode = 1
    return
  }

  const released = await waitForRelease(tag)
  if (!released) {
    warn('CI 已成功，但未在规定时间内找到 Release 产物')
    process.exitCode = 1
    return
  }

  log(`发布完成：${tag}`)
}

main().catch(error => {
  console.error(`[release] 失败：${error.message}`)
  process.exitCode = 1
})
