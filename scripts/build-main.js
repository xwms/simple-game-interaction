/**
 * 功能描述：主进程构建脚本 — 使用 esbuild 打包 Electron 主进程 + 核心引擎
 *
 * 逻辑说明：1) 将 src/main/main.js 及其依赖（src/core/*）打包为单一 CommonJS 文件；
 *           2) Electron 和 ws 标记为 external（运行时从 node_modules 加载）；
 *           3) 输出到 dist/main/main.js，附带 sourcemap；
 *           4) 复制 preload.js（独立文件，不纳入 bundle，供 BrowserWindow 引用）。
 *
 * 使用方法：node scripts/build-main.js
 */

'use strict'

const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')

async function main() {
  console.log('[build-main] 正在构建主进程...')

  // ─── 步骤 1: esbuild 打包 ────────────────────────────
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/main/main.js')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    external: ['electron', 'ws'],
    outfile: path.join(ROOT, 'dist/main/main.js'),
    format: 'cjs',
    sourcemap: true,
    minify: false,
    define: {
      'process.env.NODE_ENV': '"production"'
    }
  })

  if (result.errors.length > 0) {
    console.error('[build-main] 构建失败:')
    result.errors.forEach(e => console.error(`  ${e.text}`))
    process.exit(1)
  }

  if (result.warnings.length > 0) {
    result.warnings.forEach(w => console.warn(`  ⚠ ${w.text}`))
  }

  console.log('[build-main] ✓ dist/main/main.js')

  // ─── 步骤 2: 复制独立文件 ──────────────────────────
  // preload、tray-menu 在独立沙盒中运行，不能纳入 esbuild bundle
  const filesToCopy = [
    ['src/main/preload.js', 'dist/main/preload.js'],
    ['src/main/tray-menu.html', 'dist/main/tray-menu.html'],
    ['src/main/tray-menu-preload.js', 'dist/main/tray-menu-preload.js']
  ]

  for (const [srcRel, destRel] of filesToCopy) {
    const src = path.join(ROOT, srcRel)
    const dest = path.join(ROOT, destRel)
    fs.copyFileSync(src, dest)
    console.log(`[build-main] ✓ ${destRel}`)
  }

  // ─── 步骤 3: 复制托盘菜单所需的 iconfont 资源 ──────────
  const iconfontSrcDir = path.join(ROOT, 'src/renderer/assets/iconfont')
  const iconfontDestDir = path.join(ROOT, 'dist/main/iconfont')
  if (fs.existsSync(iconfontSrcDir)) {
    fs.mkdirSync(iconfontDestDir, { recursive: true })
    for (const file of fs.readdirSync(iconfontSrcDir)) {
      fs.copyFileSync(path.join(iconfontSrcDir, file), path.join(iconfontDestDir, file))
    }
    console.log('[build-main] ✓ dist/main/iconfont/')
  }
}

main()
