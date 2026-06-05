/**
 * 功能描述：结构化日志工具
 *
 * 逻辑说明：提供带时间戳和级别的日志输出，支持 info/warn/error/debug 级别。
 *           日志格式统一，便于后续接入文件日志或远程日志。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export class Logger {
  private module: string

  constructor(module: string) {
    this.module = module
  }

  // ─── 私有方法 ───────────────────────────────────────

  /**
   * 功能描述：格式化日志输出
   *
   * @param level - 日志级别
   * @param message - 日志内容
   * @param data - 附加数据（可选）
   */
  private _log(level: LogLevel, message: string, data?: unknown): void {
    const timestamp = new Date().toISOString()
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${this.module}]`

    if (data !== undefined) {
      console[level](`${prefix} ${message}`, data)
    } else {
      console[level](`${prefix} ${message}`)
    }
  }

  // ─── 公开方法 ───────────────────────────────────────

  debug(message: string, data?: unknown): void {
    this._log('debug', message, data)
  }

  info(message: string, data?: unknown): void {
    this._log('info', message, data)
  }

  warn(message: string, data?: unknown): void {
    this._log('warn', message, data)
  }

  error(message: string, data?: unknown): void {
    this._log('error', message, data)
  }
}

// 预创建默认 logger 实例
export const logger = new Logger('core')
