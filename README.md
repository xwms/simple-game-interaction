# SGI 中继服务器

SGI（局域网游戏联机工具）的独立中继服务器。基于 Node.js + `ws`，负责房间管理、信令转发与游戏数据转发，是客户端连接路径中 IPv6 直连、P2P 直连之后的兜底方案。

## 分支说明

| 分支 | 内容 |
|------|------|
| `main` | Electron 全平台客户端 |
| `relay-server` | 本分支：独立中继服务器（Node/TypeScript + Docker） |
| `lightweight` | C# + WebView2 轻量版 Windows 客户端 |

## 功能

- 6 位房间码的房间生命周期管理
- 房主/加入者信令转发与二进制游戏数据转发
- 心跳检测、空闲房间回收、客户端与 IP 级限流、熔断
- HTTP 管理 API：健康检查、指标、房间列表、删除房间
- 可选管理令牌鉴权，支持 TLS（WSS）

## 目录结构

```
src/relay-server/
├── main.ts                 # CLI 入口：加载配置、启动 WS 与 Admin 服务
├── server.ts               # WebSocket 中继主逻辑
├── config.ts               # RELAY_* 环境变量解析与校验
├── types.ts                # 配置、房间、客户端类型与默认值
├── protocol.md             # 通信协议规范
├── admin/http-server.ts    # 管理 API（health / metrics / rooms / delete）
├── store/                  # 内存存储
├── utils.ts                # 工具函数
├── Dockerfile
└── docker-compose.yml

tests/
├── unit/relay-server/      # 管理 API 单元测试（vitest）
└── relay-integration.ts    # 端到端协议集成测试
```

## 快速开始

需要 Node.js 20+（推荐 22）。

```bash
npm install
npm run dev        # tsx 直接运行
```

生产构建与启动：

```bash
npm run build      # tsc → dist/relay-server/
npm start          # node dist/relay-server/main.js
```

## 配置

所有配置通过 `RELAY_*` 环境变量覆盖默认值，完整示例见 [.env.example](.env.example)。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RELAY_HOST` | `0.0.0.0` | WebSocket 监听地址 |
| `RELAY_PORT` | `9800` | WebSocket 端口 |
| `RELAY_ADMIN_HOST` | `0.0.0.0` | 管理 API 监听地址 |
| `RELAY_ADMIN_PORT` | `9801` | 管理 API 端口 |
| `RELAY_ADMIN_TOKEN` | 空 | 管理 API 令牌；为空时不鉴权 |
| `RELAY_TLS_CERT` / `RELAY_TLS_KEY` | 空 | 配置后启用 WSS |
| `RELAY_MAX_ROOMS` | `1000` | 最大房间数 |
| `RELAY_MAX_MEMBERS` | `8` | 单房间最大成员数 |
| `RELAY_MAX_CLIENTS` | `5000` | 最大连接数 |
| `RELAY_MAX_PER_IP` | `10` | 单 IP 最大连接数 |
| `RELAY_MSG_RATE` | `100` | 单连接每秒消息数上限 |
| `RELAY_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## 管理 API

设置 `RELAY_ADMIN_TOKEN` 后，以下任一种方式携带令牌：

```bash
# Authorization 头
curl -H "Authorization: Bearer $RELAY_ADMIN_TOKEN" http://127.0.0.1:9801/health
# 自定义头
curl -H "X-Admin-Token: $RELAY_ADMIN_TOKEN" http://127.0.0.1:9801/metrics
# 查询参数
curl "http://127.0.0.1:9801/api/rooms?token=$RELAY_ADMIN_TOKEN"
```

| 方法与路径 | 说明 |
|------------|------|
| `GET /health` | 健康检查 |
| `GET /metrics` | 运行指标 |
| `GET /api/rooms` | 房间列表 |
| `DELETE /api/rooms/:code` | 删除指定房间 |

## Docker

```bash
# 可选：在 .env 中设置 RELAY_ADMIN_TOKEN
docker compose -f src/relay-server/docker-compose.yml up -d --build
```

管理端口默认只绑定宿主机 `127.0.0.1:9801`，远程运维请使用 SSH 隧道。WebSocket 端口 `9800` 对外暴露。

## 测试

```bash
npm test                         # 单元测试
npm run test:integration         # 需先启动服务端
RELAY_URL=ws://服务器:9800 npm run test:integration
```

## 协议

客户端与服务器的帧格式、房间与信令流程见 [src/relay-server/protocol.md](src/relay-server/protocol.md)。

## 许可证

Copyright © 2026. MIT License.
