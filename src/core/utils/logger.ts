/**
 * 功能描述：结构化日志工具
 *
 * 逻辑说明：提供带时间戳和级别的日志输出，支持 info/warn/error/debug 级别。
 *           支持通过静态 forwarder 将日志转发到外部（如 IPC 广播到渲染进程）。
 *           日志格式统一，便于后续接入文件日志或远程日志。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogForwarder = (level: LogLevel, message: string, module: string) => void

/** 全局日志转发器列表 */
const _forwarders: Set<LogForwarder> = new Set()

/**
 * 功能描述：注册全局日志转发器
 *
 * 逻辑说明：所有 Logger 实例的日志都会输出到注册的转发器。
 *           用于将主进程日志广播到渲染进程等场景。
 *
 * @param forwarder - 转发回调，接收 level、message、module 三个参数
 * @returns 取消注册的函数
 */
export function addLogForwarder(forwarder: LogForwarder): () => void {
  _forwarders.add(forwarder)
  return () => { _forwarders.delete(forwarder) }
}

export class Logger {
  private module: string

  constructor(module: string) {
    this.module = module
  }

  private _log(level: LogLevel, message: string, data?: unknown): void {
    const timestamp = new Date().toISOString()
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [${this.module}]`

    const fullMsg = data !== undefined
      ? `${prefix} ${message} ${JSON.stringify(data)}`
      : `${prefix} ${message}`

    console[level](fullMsg)

    // 调用全局转发器
    for (const fn of _forwarders) {
      try {
        fn(level, fullMsg, this.module)
      } catch {
        // 转发器失败不影响正常日志输出
      }
    }
  }

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
