/**
 * 功能描述：连接层类型定义 — 连接请求参数
 *
 * 逻辑说明：TunnelManager 发起连接时需提供的双方网络信息，
 *           PathSelector 据此计算最优连接路径。
 */

/**
 * 功能描述：连接请求参数
 *
 * 逻辑说明：TunnelManager 发起连接时需提供的双方网络信息，
 *           PathSelector 据此计算最优连接路径。
 */
export interface ConnectionRequest {
  serverNetwork: import('@shared/types').NetworkInfo
  clientNetwork: import('@shared/types').NetworkInfo
  serverId: string
  clientId: string
  gamePort: number
}
