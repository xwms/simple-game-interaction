/**
 * 功能描述：延迟监测器 — 通过 TCP 应用层 ping/pong 计算 RTT
 *
 * 逻辑说明：挂载到 net.Socket，定时发送 Ping 控制帧，
 *           接收端识别后原路返回 Pong 帧，发送端据此计算往返时间。
 *           控制帧在 socket data 事件中被剥离，不会透传到游戏数据流。
 *           适用于 IPv6 直连和 P2P 直连等基于 raw TCP 的传输方式。
 *
 * @module latency-monitor
 */

import { EventEmitter } from 'events'
import * as net from 'net'
import { Logger } from '../utils/logger'

const logger = new Logger('LatencyMonitor')

/** 控制帧魔数（3 字节） */
const MAGIC = [0xCC, 0xCC, 0xCC]

/** 时间戳验证窗口：控制帧中的时间戳必须在当前时间的 ±2 小时内，防止游戏数据误识别 */
const TS_VALID_WINDOW_MS = 2 * 3600 * 1000

/** 控制帧类型 */
const FRAME_TYPE_PING = 0x01
const FRAME_TYPE_PONG = 0x02

/** 控制帧总长度：3B magic + 1B type + 8B timestamp（BigInt64BE） */
const CONTROL_FRAME_LENGTH = 12

/** 默认测量间隔（毫秒） */
const DEFAULT_INTERVAL_MS = 5000

/**
 * 功能描述：延迟监测器
 *
 * 逻辑说明：由传输层（Ipv6DirectTransport / P2pTransport）在连接建立后创建并挂载。
 *           handleData 插入 socket data 事件处理链，仅在数据以魔数开头时尝试剥离
 *           控制帧，其余数据全部透传。
 *           注：当前已从 P2pTransport 和 Ipv6DirectTransport 中移除（控制帧与游戏数据
 *           共享 TCP 流导致数据损坏），保留此类代码供独立控制通道场景使用。
 *
 * @fires latency - RTT 测量结果（毫秒），仅当收到 Pong 且时间戳合法时发射
 */
export class LatencyMonitor extends EventEmitter {
  private _socket: net.Socket | null = null
  private _timer: ReturnType<typeof setInterval> | null = null
  private _intervalMs: number
  private _lastPingTime: number = 0

  constructor(intervalMs: number = DEFAULT_INTERVAL_MS) {
    super()
    this._intervalMs = intervalMs
  }

  /**
   * 功能描述：挂载到已连接的 TCP Socket
   *
   * @param socket - 已连接的 net.Socket
   */
  attachSocket(socket: net.Socket): void {
    this._socket = socket
  }

  /**
   * 功能描述：处理 socket 收到的数据，剥离控制帧并处理 ping/pong
   *
   * 逻辑说明：检查数据是否以魔数开头且长度 >= 控制帧长度：
   *           - 魔数匹配 → 检查 type 是否为有效值（0x01/0x02）
   *           - type 有效 → 验证 8B 时间戳是否在 ±2 小时内（防止游戏数据误识别）
   *           - 验证通过 → Ping 原路返回 Pong 帧 / Pong 计算 RTT，返回剩余数据
   *           控制帧只会在数据缓冲区开头被识别，不会从中间扫描。
   *           时间戳二次验证使得误识别概率降低到 2^-64 量级。
   *
   * @param data - 从 socket 收到的原始数据
   * @returns 剥离控制帧后的剩余数据，全部消耗完返回 null
   */
  handleData(data: Buffer): Buffer | null {
    if (data.length < CONTROL_FRAME_LENGTH) return data
    if (data[0] !== MAGIC[0] || data[1] !== MAGIC[1] || data[2] !== MAGIC[2]) return data

    const type = data[3]
    if (type !== FRAME_TYPE_PING && type !== FRAME_TYPE_PONG) return data

    // 验证时间戳字段：必须是当前时间 ±2 小时内的合理值
    // 防止游戏数据恰好以魔数字节开头时被误识别为控制帧
    const ts = Number(data.readBigInt64BE(4))
    const now = Date.now()
    if (ts < now - TS_VALID_WINDOW_MS || ts > now + TS_VALID_WINDOW_MS) return data

    if (type === FRAME_TYPE_PING) {
      this._handlePing(data)
      return data.length > CONTROL_FRAME_LENGTH ? data.subarray(CONTROL_FRAME_LENGTH) : null
    }

    this._handlePong(data)
    return data.length > CONTROL_FRAME_LENGTH ? data.subarray(CONTROL_FRAME_LENGTH) : null
  }

  /**
   * 功能描述：开始周期性延迟测量
   *
   * 逻辑说明：每 intervalMs 发送一次 Ping 控制帧。需先调用 attachSocket。
   */
  start(): void {
    this.stop()
    if (!this._socket) {
      logger.warn('LatencyMonitor cannot start: no socket attached')
      return
    }
    this._timer = setInterval(() => {
      if (!this._socket || this._socket.destroyed) {
        this.stop()
        return
      }
      this._sendPing()
    }, this._intervalMs)
  }

  /**
   * 功能描述：停止延迟测量，清理定时器
   */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  // ─── 私有方法 ───────────────────────────────────────

  /**
   * 功能描述：发送 Ping 控制帧
   *
   * 逻辑说明：构建 [3B magic][1B type=0x01][8B BigInt64BE timestamp] 写入 socket。
   */
  private _sendPing(): void {
    if (!this._socket) return
    this._lastPingTime = Date.now()
    const buf = Buffer.alloc(CONTROL_FRAME_LENGTH)
    buf[0] = MAGIC[0]
    buf[1] = MAGIC[1]
    buf[2] = MAGIC[2]
    buf[3] = FRAME_TYPE_PING
    buf.writeBigInt64BE(BigInt(this._lastPingTime), 4)
    try {
      this._socket.write(buf)
    } catch {
      // 写失败（如 socket 已关闭）静默忽略
    }
  }

  /**
   * 功能描述：处理收到的 Ping 帧 — 原路返回 Pong 帧
   *
   * @param data - 完整的控制帧数据
   */
  private _handlePing(data: Buffer): void {
    if (!this._socket) return
    const pong = Buffer.alloc(CONTROL_FRAME_LENGTH)
    pong[0] = MAGIC[0]
    pong[1] = MAGIC[1]
    pong[2] = MAGIC[2]
    pong[3] = FRAME_TYPE_PONG
    // 复制 Ping 帧中的时间戳到 Pong 帧
    data.copy(pong, 4, 4, CONTROL_FRAME_LENGTH)
    try {
      this._socket.write(pong)
    } catch {
      // 写失败静默忽略
    }
  }

  /**
   * 功能描述：处理收到的 Pong 帧 — 计算 RTT 并发射 latency 事件
   *
   * @param data - 完整的控制帧数据
   */
  private _handlePong(data: Buffer): void {
    const sentTime = Number(data.readBigInt64BE(4))
    if (sentTime <= 0) return
    const rtt = Date.now() - sentTime
    if (rtt >= 0) {
      this.emit('latency', rtt)
    }
  }
}
