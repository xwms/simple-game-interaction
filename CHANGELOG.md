# 更新日志

## [0.0.5] — 2026-06-22

### 新增
- GitHub Actions 跨平台 CI（三平台测试 + 构建）
- 自动发布到 GitHub Releases（打 tag 触发）
- 全平台安装包：Windows (.exe) / macOS Intel (.dmg) + Apple Silicon (.dmg) / Linux (.AppImage + .deb)
- E2E 测试覆盖扩展至 19 个用例（首页/导航/设置/404/路由守卫）

### 修复
- local-server 测试跨平台竞态问题（改用 polling 等待）
- macOS CI 测试未捕获的 ECONNRESET 导致构建失败
- Windows 开发环境端口 5173 残留进程自动清理
- Node.js 20 GitHub Actions 弃用警告
- create-release 与 build 并行导致 Release 无安装包
- E2E 测试 DevTools 窗口竞争导致 firstWindow() 返回错误窗口
- E2E 测试缺少 Vite dev server 自动启动导致页面无法加载

### 变更
- macOS arm64 构建恢复：在 macos-latest (ARM64 runner) 上同时构建 x64 + arm64 双架构 DMG
- artifactName 加入 ${arch} 区分 macOS 架构

## [1.1.2] — 2026-06-07

### 修复
- 首页版本号从写死的 v0.1.0 改为实际运行版本号
- 更新内容支持 Markdown 渲染（marked + DOMPurify）
- 安装更新包后自动退出旧进程（app.quit），让 NSIS 安装器覆盖文件
- dist:win 等打包脚本缺少 vite build 导致渲染进程代码陈旧

### 优化
- 移除 updater 模块死代码（Mock 模式、未使用的 os/execFile 导入）
- 修复 macOS 分支未导入 execSync 的隐式 bug
- 添加 UnoCSS typography 预设

## [1.1.1] — 2026-06-07

### 修复
- 首页版本号从写死的 v0.1.0 改为实际运行版本号
- 更新内容现在正确显示当前版本的发布说明
- 安装更新包后自动退出旧版本进程

## [1.1.0] — 2026-06-07

### 修复
- updater.js 添加 Gitee/GitHub owner/repo 配置，更新检测可正常工作
- checkForUpdates 返回结果始终包含 releaseNotes，避免切换页面时空数据
- Gitee CDN 302 重定向处理（递归跳转最多 5 次）
- 缓存命中时重新验证安装包文件是否存在
- 断点续传支持跨重启恢复
- SettingsView 更新 UI 完整重写（useMessage 通知、installing 加载态、错误处理）
- installUpdate 错误通过 IPC 正确传播到渲染进程

## [1.0.0] — 2026-06-07

### 第一阶段：项目脚手架
- 项目初始化：Electron 35 + Vue 3.5 + TypeScript + Vite 6 技术栈
- Electron 主进程：窗口管理、IPC、系统托盘、菜单
- Vue3 渲染进程：7 个路由页面、4 个 Pinia Store、6 个组件、中英文 i18n
- 核心引擎骨架 + 共享类型定义

### 第二阶段：核心引擎
- UDP 广播扫描器 + 响应器（LAN 游戏发现）
- 游戏协议数据库（内置 8 款游戏）
- 协议嗅探器（Minecraft、Terraria、Stardew Valley、通用 TCP）
- 本地游戏检测（进程扫描 + 端口检测）
- 网络检测模块（IPv6 能力检测 + NAT 类型检测 RFC 3489 STUN）

### 第三阶段：连接管理
- 连接路径选择器（IPv6 → P2P → Relay 三级优先级）
- Relay Client（WebSocket 中继协议实现）
- IPv6 TCP 直连通道
- P2P TCP 直连（active/passive 双端通信）
- Relay 中继传输适配器
- 本地 TCP 隧道服务端 + 客户端
- 隧道管理器（状态机、生命周期编排、自动降级）
- 中继服务器协议规范

### 第四阶段：UI 界面
- 首页：创建/加入房间按钮、网络状态、更新日志、版本指示
- 创建房间流程：自动游戏扫描、手动端口兜底
- 加入房间流程：6 位房间码输入（自动跳格/大写）
- 房间页：实时流量、游戏连接检测、错误恢复
- 设置页：语言/主题/中继地址/自动更新
- 全局错误通知 + 路由守卫 + 404 页面
- 自动更新 UI（检查 → 下载 → 安装）
- 国际化：中文 / English 全部视图覆盖

### 第五阶段：Updater 模块
- Gitee/GitHub 双源版本检查（1 小时缓存）
- 断点续传下载（支持跨重启恢复）
- 跨平台安装（Windows spawn / macOS DMG / Linux AppImage）
- Mock 测试服务器
- 安装需要代码签名（Windows 下未签名 exe 无法创建 GUI）

### 第六阶段：测试与优化
- 19 个测试文件，136 个测试用例全部通过
- 覆盖全部核心模块：网络检测、连接管理、隧道传输、P2P、Updater
- 集成测试：Scanner + 游戏数据库联合
- E2E 测试基础设施：Playwright + Electron
- vue-tsc 类型检查零错误
