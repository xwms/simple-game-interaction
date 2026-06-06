/**
 * 功能描述：LAN 游戏发现模块统一导出
 *
 * 逻辑说明：聚合导出 UDP 扫描器、响应器和游戏协议数据库。
 *           外部通过此入口访问所有发现相关功能。
 */

export { Scanner, SCANNER_EVENTS } from './scanner'
export type { ScannerState } from './scanner'

export { Responder, RESPONDER_EVENTS } from './responder'
export type { ResponderState } from './responder'

export { gameDatabase } from './game-db'

export { getSniffer, getAllSniffers, registerSniffer } from './protocols'
export type { GameProtocolSniffer, SniffResult } from './protocols'
