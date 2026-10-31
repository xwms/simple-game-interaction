# 轻量级 Windows 端 (Lightweight) 实施计划 — C# + WebView2 版

> 状态：待审核 | 更新日期：2026-08-01
> 技术路线变更：~~Node SEA（~90MB）~~ → **C# (.NET Framework 4.8) + WebView2（~3MB）**，对标 PCL 启动器

## 背景与目标

现有产品是 Electron 桌面应用（安装包需安装）。目标做一个**轻量级 Windows 版**：
- **单个 exe，体积对标 PCL 启动器**（C# 单文件，约 2-5MB），双击即用，无需安装
- 支持热更新
- UI 与功能与 Electron 版一致

已确认的设计决策：
1. **技术路线**：C# (.NET Framework 4.8) + WebView2 承载 Vue SPA，**放弃 Node 运行时**（Node 本体 ~90MB，不放弃无法做小体积）
2. **窗口承载**：无边框 WinForms 窗口 + WebView2 控件（与 Electron 版 `frame: false` 一致，Vue NavBar 提供最小化/关闭按钮）
3. **IPC**：WebView2 原生 `postMessage`（`window.chrome.webview`），**无需本地 HTTP/WS 服务**
4. **托盘/菜单**：去掉，关闭窗口即退出
5. **核心引擎**：从 TypeScript 移植到 C#（约 6500 行可移植代码）

## 为什么可行（关键前提）

- **核心引擎很"干净"**：全仓库只有 `ws` + `denque` 两个 npm 依赖，其余全是 `net`/`dgram`/`child_process` 标准库，C# 有直接等价物（`ClientWebSocket`/`Socket`/`Process`）
- **没有 WebRTC**：`p2p/` 是纯 TCP 直连 + STUN 打洞的自研实现，无 ICE/SDP/DTLS，移植难度中等
- **IPC 契约极简**：`ElectronAPI` 只有两个泛型方法 `invoke(channel, args)` + `on(channel, cb)`（见 `src/shared/types.ts`），WebView2 原生消息通道即可 1:1 实现
- **Vue SPA 无需改动配置**：已确认 `base: './'`、内存路由（`createMemoryHistory`）、`VITE_LITE` 环境变量自动注入 `import.meta.env`

## 架构总览

```
SGI.exe (~3MB, .NET Framework 4.8 + WebView2, 单个文件)

  Program.cs (单实例 Mutex → 启动 MainForm)
   └─ MainForm (无边框 900x600)
        ├─ WebView2 控件
        │    ├─ Vue SPA (dist/renderer 压缩为 SPA.zip 内嵌资源,
        │    │   首次启动解压到 %LOCALAPPDATA%\SGI\web, 虚拟域名 https://app.local)
        │    └─ JS⇄C# postMessage (invoke 请求/响应 + 事件推送)
        ├─ IpcBridge.cs        (33 invoke + 14 事件通道, 1:1 实现 ElectronAPI 契约)
        ├─ 核心引擎 (C# 移植版)
        │    ├─ Network/     Detector, NatType(STUN), Ipv6Check
        │    ├─ Discovery/   Scanner(UDP 广播), Responder, GameDb, Protocols
        │    ├─ Tunnel/      LocalServer, LocalClient, RelayClient(ClientWebSocket),
        │    │               Ipv6Direct, TunnelManager, Transports(relay-peer, kcp-transport)
        │    ├─ P2p/         PeerConnection(TCP 直连), Signaling
        │    ├─ Connection/  PathSelector
        │    ├─ LocalDetect/ ProcessScanner, PortChecker
        │    └─ Utils/       Kcp, Logger
        ├─ Updater.cs         (Gitee/GitHub 检查 → 下载 → 替换 exe 重启)
        └─ Log.cs             (文件日志, 对应 src/core/utils/logger.ts)
```

## 目录结构（新增，仓库根）

```
lightweight/
├── SGI.csproj                # .NET Framework 4.8 + WinForms + Microsoft.Web.WebView2
├── src/
│   ├── Program.cs            # 单实例 Mutex → 启动 MainForm
│   ├── MainForm.cs           # 无边框窗体 + WebView2 + 窗口拖拽/最小化/关闭
│   ├── IpcBridge.cs          # postMessage 分发: invoke 请求/响应 + 事件推送
│   ├── IpcHandlers.cs        # 33 个 invoke 通道实现 (映射核心引擎)
│   ├── EventBus.cs           # 核心引擎事件 → PostWebMessageAsJson 推送
│   ├── Env.cs                # 版本号、userData 路径 (%LOCALAPPDATA%\SGI)、openExternal
│   ├── Updater.cs            # 热更新
│   ├── Log.cs                # 文件日志
│   ├── Resources/            # 内嵌: SPA.zip、应用图标
│   └── Core/                 # 移植的核心引擎 (C#)，模块结构对应 src/core/**
├── build.mjs                 # 编排: vite build(VITE_LITE) → 压缩 SPA → dotnet build → SGI.exe
└── dist/                     # 输出 SGI.exe
```

渲染进程改动（最小）：
- 新增：`src/renderer/utils/lite-shim.ts`
- 修改：`src/renderer/main.ts` 加 1 行条件引导

## 实现步骤

### Phase 1: 项目骨架 + IPC 桥 + 窗口

**1. 构建工具链准备**
- 本机当前无 .NET SDK / Visual Studio（已确认）。需安装 **VS Build Tools 2022**（勾选「.NET 桌面开发」工作负载，含 .NET Framework 4.8 目标包 + MSBuild + C# 编译器），或安装 .NET SDK + .NET Framework 4.8 Developer Pack
- 验证：`dotnet build` 能编译一个空的 net48 WinForms 项目

**2. WebView2 宿主窗口 (`MainForm.cs`)**
- 无边框窗体 900x600，可拖拽（WM_NCHITTEST），关闭即退出
- 最小化/关闭由渲染层 NavBar 触发 `window:minimize` / `window:close`
- WebView2 初始化：`SetVirtualHostNameToFolderMapping("app.local", SPA目录, Allow)`，Navigate 到 `https://app.local/index.html`
- `WebMessageReceived` 处理 JS→C#；`PostWebMessageAsJson` 推送事件

**3. 渲染层 shim (`src/renderer/utils/lite-shim.ts`)**
- 实现 `window.electronAPI` = `{ invoke, on }`，用 `window.chrome.webview.postMessage` + `addEventListener('message')`
- 消息格式：请求 `{id, channel, args}`；响应 `{id, success, data|error}`；事件 `{channel, args}`
- 维护 pending Map (id→resolve/reject) 与 listener Map (channel→回调集合)，`on` 返回退订函数
- 特例拦截 `app:background-select` → 浏览器 `<input type=file accept="image/*">` 读图转 dataUrl，返回 `{path:'', dataUrl}`
- `src/renderer/main.ts` 在 `app.mount('#app')` 前加 `if (import.meta.env.VITE_LITE) await installLiteShim()`

**4. IPC 桥 (`IpcBridge.cs` + `IpcHandlers.cs`)**
- 33 个 invoke 通道，先实现薄封装（无需核心引擎）：
  - `app:get-version` / `app:get-platform`（版本号、win32）
  - `app:open-log-file` / `app:open-log-dir` → `Process.Start` 打开 `notepad` / `explorer`（带文件存在性检查）
  - `app:open-external` → `start <url>`，仅允许 https
  - `app:select-log-directory` → 返回 `null`（保留默认路径）
  - `app:set-log-file-path` / `app:set-close-behavior` / `app:theme-changed` / `app:confirm-disconnect` → 薄封装
  - `window:minimize` / `window:close` → MainForm 方法
  - `log:cleanup` / `log:delete-all` → 日志清理
  - `log:info` / `log:error` → 写文件日志
- 事件推送（Phase 1 先做不依赖核心引擎的）：`log:info` 转发、`update:*` 占位

### Phase 2: 核心引擎移植 (C#)

**5. 移植顺序（每模块完成即配单元测试，以 TS 版测试行为为基线）**
1. `Network/` — Detector(编排) + NatType(STUN RFC 5389, 462 行) + Ipv6Check
2. `Discovery/` — Scanner(UDP 广播) + Responder + GameDb + Protocols(minecraft/terraria/stardew/generic TCP 嗅探)
3. `Tunnel/` 基础 — LocalServer + LocalClient + Ipv6Direct + RelayClient(`ClientWebSocket`，唯一依赖 `ws` 的文件，帧格式/心跳/重连状态机照 `src/relay-server/protocol.md`)
4. `P2p/` — PeerConnection(TCP 直连, 长度前缀帧) + Signaling(复用中继 signal 通道)
5. `Tunnel/` 传输层 — relay-peer + kcp-transport + `Utils/Kcp`（**最难点**，合计约 2000 行：可靠 UDP/ARQ/拥塞控制/滑动窗口，denque→自定义 deque）
6. `Tunnel/Manager`（状态机 1546 行）+ `Connection/PathSelector` + `LocalDetect/`（tasklist/netstat 调用）
7. 事件映射：TunnelManager 的 status/traffic/latency/error/member-joined/left/connected/transport-changed → EventBus → 推送
8. `src/shared/types.ts` 类型 → C# DTO（`NetworkInfo`/`TunnelStatusReport`/`MemberInfo`/`UpdateInfo`/`CreateRoomOptions` 等，字段名对齐）

- 中继服务器默认地址 `ws://159.75.150.37:9800`（与 Electron 版一致，用户可在设置改）
- STUN 默认 4 台公共服务器（与 `nat-type.ts:35-40` 一致）

### Phase 3: 更新 + 热更新

**6. `Updater.cs`**
- `update:check` → Gitee/GitHub releases（`HttpClient`），复用 Electron 版 `src/main/updater.js` 检测逻辑（版本号从 Env 读取，1h 缓存）
- `update:start-download` → 下载新 exe 到 `%TEMP%\sgi-update.exe`，进度经事件推送 `update:download-progress/complete/error`
- `update:install` → 写临时 `.cmd` 并分离启动：`等待 SGI.exe 退出 → move SGI.exe → SGI.old.exe → copy 新exe → start SGI.exe`，随后 `Application.Exit()`

### Phase 4: 收尾

- 行为对齐剩余通道（theme-changed、log:*、confirm-disconnect 等，均为薄封装）
- exe 图标/版本信息（.NET 资源嵌入）
- `build.mjs` 自动化：`VITE_LITE=true npm run build` → 压缩 `dist/renderer` 为 SPA.zip → `dotnet build`（内嵌 SPA.zip）→ 输出 `dist/SGI.exe`
- 体积与首次启动速度检查

## 复用的现有代码
- Vue SPA：`src/renderer/**` 原样复用（仅 main.ts 加 shim 引导行）
- 核心引擎逻辑：`src/core/**` 作为 C# 移植蓝本（**不修改**，Electron 版保持源实现）
- IPC 契约：`src/shared/types.ts`（ElectronAPI、IpcResult、各 DTO）
- 中继协议：`src/relay-server/protocol.md`

## 需要新建/修改的文件
- 新增：`lightweight/` 整个 C# 工程 + `build.mjs`
- 新增：`src/renderer/utils/lite-shim.ts`
- 修改：`src/renderer/main.ts`（1 行条件引导）
- 不改：`src/core/**`、`src/shared/**`、`src/main/**`（Electron 版不动）

## 验证
1. `node lightweight/build.mjs` → `lightweight/dist/SGI.exe`（体积约 2-5MB）
2. 双击运行 → 无边框窗口弹出，Vue 界面与 Electron 版一致
3. 功能验证：网络检测 → 建房 → Electron 版加入（联机/流量/延迟）；反向加入；日志页/设置页/关于页/背景图选择
4. 热更新：更新源指向假新版本 → 下载 → 安装 → exe 被替换并自动重启
5. 单实例：二次启动退出
6. 回归：`npm test` 通过（`src/core` 未改动）

## 风险与说明
- **构建工具链**：本机当前无 .NET SDK/VS，需先安装 VS Build Tools 2022（免费，约 1-2GB）——实施第一步
- **WebView2 运行时**：Win11 自带；Win10 需系统装有 Edge/WebView2（绝大多数已有）
- **双重实现维护**：C# 核心与 TS 核心是两套实现，后续功能变更需同步移植；通过保持模块结构一一对应便于对照
- **KCP/STUN 移植**：算法密集，需大量测试验证（以 TS 版测试为基线）
- **少量功能简化**：无托盘（关闭即退出）、日志目录选择器返回默认路径（v1）、open-external 仅 https
