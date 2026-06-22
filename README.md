# SGI — 局域网游戏联机工具

[![Version](https://img.shields.io/badge/version-0.0.5-blue.svg)]()
[![CI](https://github.com/xwms/simple-game-interaction/actions/workflows/ci.yml/badge.svg)](https://github.com/xwms/simple-game-interaction/actions/workflows/ci.yml)
[![Electron](https://img.shields.io/badge/Electron-35+-47848F.svg)]()
[![Vue](https://img.shields.io/badge/Vue-3.5+-4FC08D.svg)]()

**SGI (Simple Game Interaction)** 是一款帮助非技术用户将**局域网联机游戏**通过互联网进行联机的桌面工具。无需公网 IP、无需端口转发、无需复杂配置，几步即可和朋友联机。 🎮

## ✨ 功能特性

- 🔍 **自动游戏发现** — 自动检测本机安装的局域网联机游戏（Minecraft、Terraria、Stardew Valley 等）
- 🧠 **智能连接选择** — IPv6 直连 → P2P 直连 → 中继转发，自动选择最优连接路径
- 🔑 **房间码加入** — 房主创建房间后生成 6 位房间码，朋友输入即可加入
- 📡 **网络自检** — 自动检测 NAT 类型、IPv6 能力，显示预计连接方式
- 📊 **流量监控** — 实时显示上传/下载速率
- 💻 **跨平台** — Windows、macOS、Linux 全平台支持
- 🌐 **国际化** — 中文 / English 双语界面
- 🔄 **自动更新** — 启动时静默检查更新，一键下载安装

## 🚀 快速开始

### 下载安装

从 [GitHub Releases](https://github.com/xwms/simple-game-interaction/releases) 下载对应平台安装包：

| 平台 | 安装包 |
|------|--------|
| Windows | `SGI-Setup-0.0.5-win.exe` |
| macOS Intel | `SGI-0.0.5-mac.dmg` |
| Linux | `SGI-0.0.5-linux.AppImage` / `.deb` |

> macOS Apple Silicon 暂需本地构建或通过 Rosetta 2 运行 x64 版本。

### 从源码运行

```bash
# 克隆项目
git clone https://github.com/xwms/simple-game-interaction.git
cd simple-game-interaction

# 安装依赖
npm install

# 开发模式运行
npm run dev

# 生产构建
npm run build
npm run pack    # 打包为目录（未压缩）
npm run dist    # 打包为安装包
```

## 📖 使用指南

### 👑 房主（创建房间）

1. 打开 SGI，点击「创建房间」
2. 工具自动扫描本机游戏，选择你要联机的游戏
3. 确认游戏端口，点击「创建房间」
4. 将生成的 **6 位房间码** 发给朋友
5. 等待朋友加入，开始游戏

### 🎮 加入者（加入房间）

1. 打开 SGI，点击「加入房间」
2. 输入房主给你的 6 位房间码
3. 等待连接建立
4. 打开游戏，连接 `127.0.0.1:SGI本地端口` 即可

### ⚙️ 设置

- **语言**：中文 / English，即时切换
- **主题**：浅色 / 深色 / 跟随系统
- **中继服务器**：自定义中继服务器地址（默认 `ws://sgi-relay:9800`）
- **自动更新**：开关启动时自动检查更新

## 🔗 连接优先级

SGI 根据双方网络状况自动选择最优连接路径：

1. 🌐 **IPv6 直连** — 最低延迟，最高吞吐（双方均有公网 IPv6）
2. ⚡ **P2P 直连** — TCP 直连，无中间节点（非 Symmetric NAT）
3. 🔁 **中继转发** — 兜底方案，通过中继服务器转发（所有网络类型可用）

## 🛠 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 桌面框架 | Electron 35 | 主进程 (JS) |
| 前端 UI | Vue 3.5 + TypeScript | 渲染进程 |
| UI 组件 | Naive UI + UnoCSS | 界面组件库 |
| 状态管理 | Pinia | 渲染进程状态 |
| 核心引擎 | TypeScript | 主进程运行, 平台无关 |
| 网络隧道 | TCP Socket (net) | IPv6/P2P/Relay 传输 |
| NAT 检测 | STUN (RFC 3489) | NAT 类型识别 |
| 测试 | Vitest + Playwright | 单元 + E2E 测试 |
| 构建 | Vite 6 + electron-builder | 开发构建与打包 |

## 📁 项目结构

```
src/
├── main/                # Electron 主进程 (JS)
│   ├── main.js          #   应用入口
│   ├── ipc-handlers.js  #   IPC 通道
│   ├── window-manager.js#   窗口管理
│   ├── tray.js          #   系统托盘
│   ├── updater.js       #   自动更新
│   └── menu.js          #   应用菜单
├── renderer/            # 渲染进程 (Vue3 + TS)
│   ├── views/           #   页面视图
│   ├── components/      #   公共组件
│   ├── store/           #   Pinia 状态
│   ├── i18n/            #   国际化
│   ├── router/          #   路由
│   └── composables/     #   组合式函数
├── core/                # 核心引擎 (TS, 平台无关)
│   ├── discovery/       #   LAN 游戏发现
│   ├── network-detect/  #   网络检测
│   ├── connection/      #   路径选择
│   ├── tunnel/          #   TCP 隧道
│   ├── p2p/             #   P2P 直连
│   ├── game-detect/     #   本地游戏检测
│   └── utils/           #   工具函数
└── shared/              # 共享类型
```

## 💻 开发命令

```bash
npm run dev              # 启动开发环境
npm run build            # 生产构建
npm run test             # 运行单元测试
npm run test:watch       # 测试监听模式
npm run test:e2e         # E2E 测试
npm run type-check       # TypeScript 类型检查
npm run lint             # ESLint 检查
npm run dist:win         # 打包 Windows 安装包
npm run dist:mac         # 打包 macOS 安装包
npm run dist:linux       # 打包 Linux 安装包
```

## ❓ 常见问题

**Q: 需要公网 IP 吗？**  
A: 不需要。SGI 的 IPv6直连/P2P 直连/中继转发三种模式均不要求公网 IP。

**Q: 支持哪些游戏？**  
A: 内置支持 Minecraft Java Edition、Terraria、Stardew Valley、Factorio、Valheim、CS:GO、OpenArena 等常见局域网联机游戏，也可手动指定端口适配任意游戏。

**Q: 连接不上怎么办？**  
A: 检查网络连接状态，确保双方 SGI 版本一致。如果 NAT 类型为 Symmetric，将自动使用中继模式。

**Q: 中继服务器是自己搭建的吗？**  
A: SGI 默认使用公共中继服务器。你也可以在设置中指定自己的中继服务器地址。

## 📄 许可证

Copyright © 2026. MIT License.