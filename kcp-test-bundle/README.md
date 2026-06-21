# KCP UDP 打洞测试包

测试 KCP NAT 打洞修复（探针重传 + addExternalTarget 双向探测）。

## 安装

```bash
npm install
```

## 单机回环测试

```bash
npm run test:local
```

验证探针循环、addExternalTarget、双向数据传输和断连清理。

## 跨机器测试（通过中继服务器）

**房主（先启动）：**

```bash
npm run test:host -- --code TESTKP
```

**加入者（后启动）：**

```bash
npm run test:guest -- --code TESTKP
```

房主创建房间后显示房间码，加入者用同一房间码连接。
中继服务器地址硬编码为 `ws://159.75.150.37:9800`，按需修改 `scripts/test-cross.ts` 中的 `RELAY_URL`。

## 测试内容

1. 探针循环 — active 模式定时发送打洞包
2. addExternalTarget — passive 模式收到信号后触发探针
3. 双向 NAT 映射建立 → KCP 连接
4. 双向可靠数据传输
5. 断连后资源清理
