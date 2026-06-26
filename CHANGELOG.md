# 更新日志

## [0.0.8] — 2026-06-26

### 新增
- 后台下载更新：点击下载后不阻塞 UI，完成后通知可安装
- deb 安装改进：支持 gksudo/kdesudo/pkexec/sudo 多种提权方式
- 新增 Arch Linux pacman 包安装支持（pacman -U --noconfirm）

### 修复
- Linux AppImage ETXTBSY 错误：运行中 AppImage 更新改用 unlink+mv 策略
- 端口检测过滤 localhost-only 端口（JVM 临时端口不再误扫）
- 游戏检测结果按端口展开为独立卡片（每个端口一张卡片）

### 变更
- 安装通知中的操作按钮使用 Naive UI NButton 组件（不再被对话框拉伸）
- 更新安装确认对话框适配英文
- 创建房间时兼容复合 gameId（自动剥离 :port 后缀）

## [0.0.7] — 2026-06-24

### 新增
- 单实例锁：防止同时启动多个应用实例

## [0.0.6] — 2026-06-23

### 新增
- 中继服务器完整实现（WebSocket 房间管理 + 二进制转发 + 心跳检测）
- HTTP 管理面板（/health、/metrics、/api/rooms、Web Dashboard）
- 中继服务器 Docker 部署支持（Dockerfile + docker-compose）
- 中继服务器端到端集成测试（33 个断言，覆盖完整协议流程）
- Linux deb 安装包自动更新（pkexec dpkg -i 提权安装）
- AppImage 更新时自动替换旧文件

### 修复
- Linux 托盘菜单不可用（GNOME/KDE 改用原生 Menu API）
- Linux 游戏端口扫描不到（findPortsByPid 增加 ss 回退）
- HMCL 等 Java 启动器干扰游戏检测（遍历进程取真实监听端口）
- UDP 游戏（Factorio/CS:GO/OpenArena）端口检测遗漏
- 手动添加端口后自动扫描清空列表（合并模式保留 manual- 条目）

### 变更
- 游戏检测不再扫固定端口，端口信息完全来自进程实际监听状态
- Linux 更新器根据安装方式自动选择 .AppImage 或 .deb 下载
- 移除旧版中继服务器代码（移至 _archive）