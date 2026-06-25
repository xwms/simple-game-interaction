# 更新日志

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