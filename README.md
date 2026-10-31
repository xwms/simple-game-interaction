# SGI 轻量版 — C# + WebView2

SGI 的 Windows 轻量客户端分支。外壳使用 **C# (.NET Framework 4.8) + WebView2**，复用主仓库的 **Vue 3 SPA**，目标是单个 `SGI.exe`（约 2-5MB），双击即用、免安装。

## 分支说明

| 分支 | 内容 |
|------|------|
| `main` | Electron 全平台客户端 |
| `relay-server` | 独立中继服务器（Node/TypeScript + Docker） |
| `lightweight` | 本分支：C# + WebView2 轻量版 Windows 客户端 |

渲染层（`src/renderer`）与共享类型（`src/shared`）与 `main` 共用，渲染层改动需要双向同步；核心引擎在本分支用 C# 重写（`lightweight/src/Core`），不再依赖 TypeScript 引擎。本分支不包含 Electron 主进程与中继服务器。

## 目录结构

```
lightweight/                    # C# 宿主
├── SGI.csproj                  #   .NET Framework 4.8 + WinForms + WebView2
├── build.mjs                   #   三步构建：SPA → SPA.zip → dotnet build
└── src/
    ├── Program.cs              #   入口
    ├── MainForm.cs             #   无边框窗口 + WebView2
    ├── IpcBridge.cs            #   WebView2 postMessage 桥
    ├── IpcHandlers.cs          #   IPC 处理器
    ├── Env.cs / Log.cs         #   环境与日志
    ├── Core/                   #   C# 核心引擎移植（Tunnel/Network/P2P 等）
    └── Resources/SPA.zip       #   构建产物（不提交）

src/renderer/                   # Vue SPA（与 main 共用）
src/shared/                     # 跨进程类型（与 main 共用）
docs/轻量级Windows端计划.md      # 技术方案与移植计划
```

## 前置要求

- Windows 10/11 x64
- Node.js 22+
- Visual Studio Build Tools 2022，勾选「.NET 桌面开发」工作负载
- WebView2 Runtime（Windows 11 自带，Windows 10 可能需安装）

## 构建

```bash
npm install
npm run build:lite
```

`build.mjs` 依次执行：

1. `VITE_LITE=true vite build` → `dist/renderer`
2. 将渲染产物压缩为 `lightweight/src/Resources/SPA.zip`
3. `dotnet build` → `lightweight/dist/SGI.exe`

产物位置：`lightweight/dist/SGI.exe`。

## 开发与检查

```bash
npm run type-check     # vue-tsc 类型检查
npm run dev:vite       # 仅调试 SPA（无 C# 宿主，IPC 不可用）
npm run build:renderer # 仅构建渲染层
```

`VITE_LITE` 为真时，`main.ts` 会加载 `src/renderer/utils/lite-shim.ts`，用 `window.chrome.webview` 实现与 Electron 版一致的 `window.electronAPI` 契约。

## 相关文档

- [轻量级 Windows 端实施计划](docs/轻量级Windows端计划.md)
- 联机协议与核心引擎说明见 `main` 分支的 `docs/技术文档.md`

## 许可证

Copyright © 2026. MIT License.
