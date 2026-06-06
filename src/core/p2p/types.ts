/**
 * 功能描述：P2P 模块类型定义
 *
 * 逻辑说明：P2P 连接相关的类型定义，包括信令数据格式和配置项。
 *           P2P 使用 TCP 直连方式（当前阶段）而非 WebRTC，
 *           通过中继服务器交换公网地址信息后建立直接 TCP 连接。
 */

/** P2P 信令数据类型 */
export interface P2PSignalData {
  type: 'connection-request' | 'connection-accept' | 'nat-info'
  publicIp: string
  publicPort: number
  privateIp?: string
  privatePort?: number
}

/** P2P 配置 */
export interface P2PConfig {
  connectTimeout: number
  maxRetries: number
}

export const DEFAULT_P2P_CONFIG: P2PConfig = {
  connectTimeout: 8000,
  maxRetries: 2
}

/** P2P 连接角色 */
export type P2PRole = 'active' | 'passive'
