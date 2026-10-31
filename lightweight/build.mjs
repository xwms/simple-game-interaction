/**
 * 功能描述：轻量版 (C# + WebView2) 构建脚本
 *
 * 逻辑说明：三步流水线：
 *   1. VITE_LITE=true 构建渲染进程 → dist/renderer（SPA 打包时注入 electronAPI shim）
 *   2. 用 PowerShell Compress-Archive 把 dist/renderer 压缩为 SPA.zip → lightweight/src/Resources/
 *   3. dotnet build 生成 SGI.exe（内嵌 SPA.zip + WebView2Loader.dll，Costura 合并托管 DLL）→ lightweight/dist/
 *
 * 前置：已安装 VS Build Tools 2022（.NET 桌面开发工作负载）。
 */

import { execSync } from 'child_process'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lite = resolve(root, 'lightweight')

/** 功能描述：执行命令并打印，失败时抛错 */
function run(command) {
  console.log(`> ${command}`)
  execSync(command, { stdio: 'inherit', shell: 'cmd.exe' })
}

/** 功能描述：构建渲染进程（VITE_LITE=true） */
function buildRenderer() {
  run(`cd /d "${root}" && set VITE_LITE=true && npx vite build`)
}

/** 功能描述：把 dist/renderer 压缩为 SPA.zip */
function zipSpa() {
  const rendererDist = resolve(root, 'dist', 'renderer')
  const spaZip = resolve(lite, 'src', 'Resources', 'SPA.zip')
  if (!existsSync(rendererDist)) {
    throw new Error(`渲染产物不存在: ${rendererDist}，请先确认 vite build 成功`)
  }
  mkdirSync(dirname(spaZip), { recursive: true })
  if (existsSync(spaZip)) rmSync(spaZip)
  const ps = `Compress-Archive -Path '${rendererDist}\\*' -DestinationPath '${spaZip}' -Force`
  run(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`)
}

/** 功能描述：dotnet 编译生成 SGI.exe */
function dotnetBuild() {
  const out = resolve(lite, 'dist')
  mkdirSync(out, { recursive: true })
  run(`dotnet build "${resolve(lite, 'SGI.csproj')}" -c Release -o "${out}"`)

  // 清理冗余产物：WebView2Loader.dll 已内嵌资源并在运行时解压，runtimes 目录无用；pdb 不进发布
  rmSync(resolve(out, 'runtimes'), { recursive: true, force: true })
  rmSync(resolve(out, 'SGI.pdb'), { force: true })
}

buildRenderer()
zipSpa()
dotnetBuild()

console.log(`\n✅ 构建完成: ${resolve(lite, 'dist', 'SGI.exe')}`)
