# 中继服务器协议文档

## 概述

中继服务器（Relay Server）是联机工具的兜底传输层，负责房间管理、P2P 信令中转和 TCP 数据中继。协议设计以客户端实现为准（`src/core/tunnel/relay-client.ts`），与本文档保持一致。

## 传输层

WebSocket（明文 `ws://` 或加密 `wss://`），默认端口 9800。

## 消息格式

### JSON 控制消息（文本帧）

```typescript
// 请求（客户端→服务器）
{
  type: string          // 消息类型
  messageId?: string    // 请求 ID（需响应的消息必填）
  data?: { ... }       // 消息数据
}

// 响应（服务器→客户端）
{
  type: string
  messageId?: string    // 与请求的 messageId 对应
  data?: { ... }
  error?: { code: string, message: string }
}

// 推送（服务器→客户端，无对应请求）
{
  type: string
  data?: { ... }
}
```

### 二进制数据帧

```
Guest → 服务器:  [4B payloadLen UInt32BE][payload]
服务器 → Host:   [4B sourceIdLen UInt32BE][sourceId UTF8][4B payloadLen UInt32BE][payload]
Host → 服务器:   [4B targetIdLen UInt32BE][targetId UTF8][4B payloadLen UInt32BE][payload]
服务器 → Guest:  [payload] (raw, 无前缀)
```

- `payloadLen=0` 表示重置帧（通知目标重建游戏连接）
- Host 端使用 `_isServer=true` 模式解析入站帧

## 消息类型

### create-room / room-created

**请求：**
```json
{
  "type": "create-room",
  "messageId": "req_1_xxx",
  "data": {
    "gameId": "minecraft",
    "gameName": "Minecraft Java Edition",
    "gamePort": 25565,
    "memberName": "Player1",
    "networkInfo": { ... }
  }
}
```

**响应：**
```json
{
  "type": "room-created",
  "messageId": "req_1_xxx",
  "data": {
    "roomCode": "A3K8MZ",
    "memberId": "member_1"
  }
}
```

### join-room / room-joined

**请求：**
```json
{
  "type": "join-room",
  "messageId": "req_2_xxx",
  "data": {
    "roomCode": "A3K8MZ",
    "memberName": "Player2",
    "networkInfo": { ... }
  }
}
```

**响应：**
```json
{
  "type": "room-joined",
  "messageId": "req_2_xxx",
  "data": {
    "roomCode": "A3K8MZ",
    "memberId": "member_2",
    "serverId": "member_1",
    "serverNetworkInfo": { ... },
    "gamePort": 25565,
    "members": [
      { "id": "member_1", "name": "Player1" },
      { "id": "member_2", "name": "Player2" }
    ]
  }
}
```

### leave-room

**请求（无响应）：**
```json
{
  "type": "leave-room",
  "data": { "roomCode": "A3K8MZ" }
}
```

**服务器推送（member-left）：**
```json
{
  "type": "member-left",
  "data": { "memberId": "member_2" }
}
```

### heartbeat

**请求（无响应）：**
```json
{
  "type": "heartbeat",
  "data": { "roomCode": "A3K8MZ" }
}
```

服务器不回复。客户端通过 TCP 发送成功更新存活时间戳。

### signal

**请求（无响应）：**
```json
{
  "type": "signal",
  "data": {
    "to": "member_2",
    "signalData": { "type": "offer", "sdp": "..." }
  }
}
```

**转发：**
```json
{
  "type": "signal",
  "data": {
    "from": "member_1",
    "signalData": { "type": "offer", "sdp": "..." }
  }
}
```

### member-joined（服务器推送）

```json
{
  "type": "member-joined",
  "data": {
    "memberId": "member_2",
    "memberName": "Player2",
    "memberIndex": 1,
    "networkInfo": { ... }
  }
}
```

### room-closed（服务器推送）

```json
{
  "type": "room-closed"
}
```

### error

```json
{
  "type": "error",
  "messageId": "req_1_xxx",
  "error": {
    "code": "room-not-found",
    "message": "Room not found"
  }
}
```

## 错误码

| 错误码 | 含义 |
|--------|------|
| `invalid-params` | 缺少必要参数或格式错误 |
| `room-not-found` | 房间码不存在 |
| `room-full` | 房间已满（上限 8 人） |
| `room-limit-reached` | 服务器达最大房间数 |
| `rate-limited` | 频率超限 |
| `internal-error` | 服务器内部错误 |

## 二进制帧转发逻辑

```
Guest sendData(data)
  → wire: [4B payloadLen][data]
  → 服务器读取 payload，查找房间 Host
  → 转发给 Host: [4B sourceIdLen][sourceMemberId][4B payloadLen][payload]

Host sendData(data, targetMemberId)
  → wire: [4B targetIdLen][targetId][4B payloadLen][data]
  → 服务器读取 targetId，查找目标 Guest
  → 转发给 Guest: [payload] (raw)
```

## 管理 API

### `GET /health`

```json
{
  "status": "ok",
  "uptime": 3600,
  "rooms": 5,
  "clients": 12,
  "version": "0.1.0"
}
```

### `GET /api/rooms`

```json
[
  {
    "code": "A3K8MZ",
    "gameId": "minecraft",
    "gameName": "Minecraft Java Edition",
    "gamePort": 25565,
    "memberCount": 2,
    "members": [ ... ],
    "createdAt": "2026-06-22T12:00:00.000Z",
    "lastActivityAt": "2026-06-22T12:05:00.000Z"
  }
]
```

### `GET /metrics`

Prometheus 文本格式，暴露 `sgi_relay_*` 指标。
