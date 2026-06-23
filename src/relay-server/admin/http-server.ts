/**
 * 功能描述：HTTP 管理服务 — 健康检查、房间列表、Prometheus 指标
 *
 * 逻辑说明：在独立端口提供 HTTP API，用于健康检查、运维监控和 Prometheus 采集。
 *           默认仅监听 127.0.0.1，不暴露到公网。
 *           所有端点均返回 JSON（/metrics 返回 Prometheus 文本格式）。
 */

import http from 'http'
import type { Store } from '../store/types'
import type { RelayServer } from '../server'
import type { RelayConfig } from '../types'
import { nowISO } from '../utils'

export class AdminServer {
  private _server: http.Server | null = null

  /**
   * 功能描述：启动 HTTP 管理服务
   *
   * @param config - 中继配置
   * @param server - 中继服务器实例（获取运行时状态）
   * @param store - 存储层实例（获取房间/成员数据）
   */
  start(config: RelayConfig, server: RelayServer, store: Store): void {
    this._server = http.createServer(async (req, res) => {
      try {
        await this._handleRequest(req, res, server, store)
      } catch (err) {
        this._writeJson(res, 500, { error: (err as Error).message })
      }
    })

    this._server.listen(config.adminPort, config.adminHost, () => {
      console.log(JSON.stringify({
        time: nowISO(), level: 'info', module: 'admin',
        msg: `Admin HTTP server listening on ${config.adminHost}:${config.adminPort}`
      }))
    })

    this._server.on('error', (err: Error) => {
      console.log(JSON.stringify({
        time: nowISO(), level: 'error', module: 'admin',
        msg: 'Admin server error', error: err.message
      }))
    })
  }

  /**
   * 功能描述：停止 HTTP 管理服务
   */
  stop(): void {
    if (this._server) {
      this._server.close()
      this._server = null
    }
  }

  /**
   * 功能描述：路由处理
   */
  private async _handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    server: RelayServer,
    store: Store
  ): Promise<void> {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    // CORS 头（允许管理端跨域访问）
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS')

    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    switch (url) {
      case '/':
        return this._handleDashboard(res)
      case '/health':
        return this._handleHealth(res, server, store)
      case '/metrics':
        return this._handleMetrics(res, server, store)
      case '/api/rooms':
        return this._handleRooms(res, store)
      default:
        if (method === 'DELETE' && url?.startsWith('/api/rooms/')) {
          const code = url.slice('/api/rooms/'.length)
          return this._handleDeleteRoom(res, code, store)
        }
        this._writeJson(res, 404, { error: 'Not found' })
    }
  }

  /**
   * 功能描述：管理面板页面
   *
   * GET / → HTML 仪表盘
   */
  private _handleDashboard(res: http.ServerResponse): void {
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SGI Relay Server</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, sans-serif; background: #f5f5f5; color: #333; padding: 20px; }
h1 { font-size: 20px; margin-bottom: 16px; }
.card { background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
.stats { display: flex; gap: 12px; flex-wrap: wrap; }
.stat { flex: 1; min-width: 100px; text-align: center; padding: 12px; background: #fafafa; border-radius: 6px; }
.stat-value { font-size: 28px; font-weight: 700; color: #1677ff; }
.stat-label { font-size: 12px; color: #888; margin-top: 4px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #eee; }
th { color: #888; font-weight: 500; }
.member-tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin: 1px; }
.member-host { background: #e6f4ff; color: #1677ff; }
.member-guest { background: #f6ffed; color: #52c41a; }
.member-dead { opacity: .5; }
.empty { color: #888; text-align: center; padding: 24px; font-size: 14px; }
.error { color: #ff4d4f; }
#updated { font-size: 12px; color: #aaa; margin-top: 8px; text-align: right; }
</style>
</head>
<body>
<h1>SGI Relay Server</h1>
<div class="card">
  <div class="stats" id="stats">
    <div class="stat"><div class="stat-value" id="uptime">-</div><div class="stat-label">运行时长</div></div>
    <div class="stat"><div class="stat-value" id="rooms">-</div><div class="stat-label">房间数</div></div>
    <div class="stat"><div class="stat-value" id="clients">-</div><div class="stat-label">成员数</div></div>
    <div class="stat"><div class="stat-value" id="connections">-</div><div class="stat-label">连接数</div></div>
  </div>
</div>
<div class="card">
  <div id="room-list"><div class="empty">加载中...</div></div>
</div>
<div id="updated"></div>
<script>
function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? d+'d '+h+'h '+m+'m' : h ? h+'h '+m+'m' : m ? m+'m '+s%60+'s' : s+'s';
}
async function load() {
  try {
    const [health, rooms] = await Promise.all([
      fetch('/health').then(r => r.json()),
      fetch('/api/rooms').then(r => r.json())
    ]);
    document.getElementById('uptime').textContent = fmtUptime(health.uptime);
    document.getElementById('rooms').textContent = health.rooms;
    document.getElementById('clients').textContent = health.clients;
    document.getElementById('connections').textContent = health.connections ?? '-';
    const list = document.getElementById('room-list');
    if (!rooms.length) { list.innerHTML = '<div class="empty">暂无房间</div>'; return; }
    let html = '<table><thead><tr><th>房间码</th><th>游戏</th><th>端口</th><th>成员</th><th>活动时间</th></tr></thead><tbody>';
    for (const r of rooms) {
      html += '<tr><td><strong>' + r.code + '</strong></td><td>' + esc(r.gameName) + '</td><td>' + r.gamePort + '</td><td>';
      for (const m of r.members) {
        const cls = m.memberIndex === 0 ? 'member-host' : 'member-guest';
        const dead = m.alive ? '' : ' member-dead';
        html += '<span class="member-tag ' + cls + dead + '">' + esc(m.memberName) + '</span> ';
      }
      html += '</td><td style="font-size:11px;color:#888">' + timeAgo(r.lastActivityAt) + '</td></tr>';
    }
    html += '</tbody></table>';
    list.innerHTML = html;
  } catch (e) {
    document.getElementById('room-list').innerHTML = '<div class="error">加载失败: ' + e.message + '</div>';
  }
  document.getElementById('updated').textContent = '更新于 ' + new Date().toLocaleTimeString();
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function timeAgo(iso) { const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000); return s < 60 ? s+'秒前' : s < 3600 ? Math.floor(s/60)+'分钟前' : Math.floor(s/3600)+'小时前'; }
load();
setInterval(load, 5000);
</script>
</body>
</html>`
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  }

  /**
   * 功能描述：健康检查端点
   *
   * GET /health → { status: "ok", uptime, rooms, clients, version }
   */
  private async _handleHealth(
    res: http.ServerResponse,
    server: RelayServer,
    store: Store
  ): Promise<void> {
    const roomCount = await store.getRoomCount()
    this._writeJson(res, 200, {
      status: 'ok',
      uptime: server.uptime,
      rooms: roomCount,
      clients: server.connectionCount,
      version: '0.1.0'
    })
  }

  /**
   * 功能描述：Prometheus 指标端点
   *
   * GET /metrics → Prometheus 文本格式
   */
  private async _handleMetrics(
    res: http.ServerResponse,
    server: RelayServer,
    store: Store
  ): Promise<void> {
    const roomCount = await store.getRoomCount()
    const clientCount = await store.getClientCount()

    const lines = [
      '# HELP sgi_relay_rooms_total 当前房间总数',
      '# TYPE sgi_relay_rooms_total gauge',
      `sgi_relay_rooms_total ${roomCount}`,
      '',
      '# HELP sgi_relay_clients_total 当前成员总数',
      '# TYPE sgi_relay_clients_total gauge',
      `sgi_relay_clients_total ${clientCount}`,
      '',
      '# HELP sgi_relay_connections_total 当前 WebSocket 连接数',
      '# TYPE sgi_relay_connections_total gauge',
      `sgi_relay_connections_total ${server.connectionCount}`,
      '',
      '# HELP sgi_relay_uptime_seconds 服务器运行时长',
      '# TYPE sgi_relay_uptime_seconds gauge',
      `sgi_relay_uptime_seconds ${server.uptime}`
    ]

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(lines.join('\n'))
  }

  /**
   * 功能描述：房间列表端点
   *
   * GET /api/rooms → [{ code, gameId, gameName, memberCount, createdAt, ... }]
   */
  private async _handleRooms(res: http.ServerResponse, store: Store): Promise<void> {
    const rooms = await store.listRooms()

    const list = rooms.map(room => ({
      code: room.code,
      gameId: room.gameId,
      gameName: room.gameName,
      gamePort: room.gamePort,
      memberCount: room.members.size,
      members: Array.from(room.members.values()).map(m => ({
        memberId: m.memberId,
        memberName: m.memberName,
        memberIndex: m.memberIndex,
        alive: m.alive,
        connectedAt: new Date(m.connectedAt).toISOString(),
        messageCount: m.messageCount,
        byteCount: m.byteCount
      })),
      createdAt: new Date(room.createdAt).toISOString(),
      lastActivityAt: new Date(room.lastActivityAt).toISOString()
    }))

    this._writeJson(res, 200, list)
  }

  /**
   * 功能描述：删除房间端点
   *
   * DELETE /api/rooms/:code → { success: true }
   */
  private async _handleDeleteRoom(
    res: http.ServerResponse,
    code: string,
    store: Store
  ): Promise<void> {
    const room = await store.getRoom(code)
    if (!room) {
      this._writeJson(res, 404, { error: 'Room not found' })
      return
    }
    // 关闭房间会通过 notify 所有成员，但这里只从 store 删除
    // 成员需要由 server 的 _removeMember 逻辑通知
    await store.deleteRoom(code)
    this._writeJson(res, 200, { success: true })
  }

  /**
   * 功能描述：写入 JSON 响应
   */
  private _writeJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }
}
