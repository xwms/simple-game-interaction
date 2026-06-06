/**
 * 功能描述：协议嗅探器类型定义
 *
 * 逻辑说明：定义嗅探器接口和数据模型，所有游戏嗅探器实现此接口。
 *           嗅探器通过 TCP/UDP 连接检测游戏服务器是否正在运行。
 */

import type { GameInfo } from '@shared/types'

/** 嗅探结果 */
export interface SniffResult {
  detected: boolean
  gameId: string
  host: string
  port: number
  extra?: Record<string, string>
  latencyMs?: number
}

/** 嗅探器接口 */
export interface GameProtocolSniffer {
  /** 对应的游戏 ID */
  gameId: string

  /**
   * 功能描述：嗅探指定主机和端口是否运行对应的游戏服务器
   *
   * @param host - 目标主机 IP
   * @param port - 目标端口
   * @param timeoutMs - 超时时间（毫秒）
   * @returns 嗅探结果
   */
  sniff(host: string, port: number, timeoutMs?: number): Promise<SniffResult>

  /**
   * 功能描述：将 SniffResult 转换为 GameInfo
   *
   * @param result - 嗅探结果
   * @returns 游戏信息
   */
  toGameInfo(result: SniffResult): GameInfo
}
