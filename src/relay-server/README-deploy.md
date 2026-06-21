# Relay 调试服务器部署文档

用于云服务器部署，支持 WebSocket 中继、UDP/TCP/IPv6 测试。

## 端口说明

| 端口 | 协议 | 用途 | 测试对象 |
|------|------|------|---------|
| 9800 | TCP | WebSocket 中继 | Relay 连接 |
| 9801 | TCP | HTTP 仪表盘 | 浏览器访问 |
| 9802 | UDP | UDP 回显 | KCP/UDP 打洞测试 |
| 9803 | TCP | TCP 回显 | P2P TCP 直连测试 |
| 9804 | TCP | IPv6 TCP 回显 | IPv6 直连测试 |

## 部署步骤

### 1. 安装 Node.js

```bash
sudo curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
sudo apt-get install -y nodejs
node -v   # 确认 >= 20
npm -v
```

### 2. 创建目录并上传文件

```bash
sudo mkdir -p /opt/relay-debug
sudo chown ubuntu:ubuntu /opt/relay-debug
```

在本机上传：

```bash
scp src/relay-server/debug-server.ts ubuntu@服务器IP:/opt/relay-debug/
```

### 3. 安装依赖

```bash
cd /opt/relay-debug
npm init -y
npm install ws
npm install -D tsx
```

### 4. 开放防火墙端口

```bash
sudo ufw allow 9800/tcp
sudo ufw allow 9801/tcp
sudo ufw allow 9802/udp
sudo ufw allow 9803/tcp
sudo ufw allow 9804/tcp
```

云服务商安全组也需要开放以上端口。

### 5. 启动

```bash
cd /opt/relay-debug

# 前台启动（调试用）
npx tsx debug-server.ts

# 后台启动
nohup npx tsx debug-server.ts > relay.log 2>&1 &
```

### 6. 注册为系统服务（推荐）

```bash
sudo tee /etc/systemd/system/relay-debug.service > /dev/null << 'EOF'
[Unit]
Description=Relay Debug Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/relay-debug
ExecStart=npx tsx /opt/relay-debug/debug-server.ts
Restart=always
RestartSec=5
StandardOutput=append:/opt/relay-debug/relay.log
StandardError=append:/opt/relay-debug/relay.log

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable relay-debug
sudo systemctl start relay-debug
```

## 常用命令

```bash
# 查看状态
sudo systemctl status relay-debug

# 查看日志
journalctl -u relay-debug -f
tail -f /opt/relay-debug/relay.log

# 重启
sudo systemctl restart relay-debug

# 停止
sudo systemctl stop relay-debug

# 非 systemd 启动时的重启
ps aux | grep debug-server   # 查 PID
kill <PID>
nohup npx tsx debug-server.ts > relay.log 2>&1 &
```

## 验证部署

```bash
# 仪表盘
curl http://localhost:9801/api/status

# WebSocket 服务
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" http://localhost:9800

# UDP 回显（需安装 ncat）
echo "test" | ncat -u localhost 9802

# TCP 回显
echo "test" | ncat localhost 9803
```

## 应用配置

在应用的设置页面中修改：

- **中继服务器地址**: `ws://服务器IP:9800`

然后打开浏览器访问 `http://服务器IP:9801` 查看实时仪表盘。

## 环境变量

可选配置，默认值如下：

```bash
WS_PORT=9800     # WebSocket 中继端口
HTTP_PORT=9801   # HTTP 仪表盘端口
UDP_PORT=9802    # UDP 回显端口
TCP_PORT=9803    # TCP 回显端口
V6_PORT=9804     # IPv6 TCP 回显端口
```

使用方式：

```bash
WS_PORT=9900 HTTP_PORT=9901 nohup npx tsx debug-server.ts > relay.log 2>&1 &
```
