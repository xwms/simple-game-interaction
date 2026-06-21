/**
 * 功能描述：结构化日志工具
 *
 * 逻辑说明：提供带时间戳和级别的日志输出，支持 info/warn/error/debug 级别。
 *           支持通过静态 forwarder 将日志转发到外部（如 IPC 广播到渲染进程）。
 *           支持文件日志输出（主进程），通过 setLogFilePath 配置路径。
 */

import * as fs from 'fs'
import * as path from 'path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogForwarder = (level: LogLevel, message: string, module: string) => void

/** 全局日志转发器列表 */
const _forwarders: Set<LogForwarder> = new Set()
/** 日志文件目录（可选，仅在主进程设置） */
let _logDir: string | null = null

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

/**
 * 功能描述：获取当天日期字符串（格式：year-month-day）
 *
 * @returns 日期字符串，如 "2026-06-11"
 */
function getDateStr(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 功能描述：设置日志文件目录（主进程启动时调用）
 *
 * 逻辑说明：自动创建目录，日志文件按日期自动命名（如 2026-06-11.log）。
 *
 * @param filePath - 日志文件路径（仅提取目录部分）
 */
export function setLogFilePath(filePath: string): void {
  _logDir = path.dirname(filePath)
  if (!fs.existsSync(_logDir)) {
    fs.mkdirSync(_logDir, { recursive: true })
  }
}

/**
 * 功能描述：获取当前日志文件完整路径（含当天日期）
 *
 * @returns 日志文件路径，未配置则返回 null
 */
export function getLogFilePath(): string | null {
  if (!_logDir) return null
  return path.join(_logDir, `${getDateStr()}.log`)
}

/**
 * 功能描述：写入日志文件（同步，按日期自动分文件）
 *
 * @param message - 完整日志文本（含时间戳和级别）
 */
function writeToFile(message: string): void {
  const filePath = getLogFilePath()
  if (!filePath) return
  try {
    fs.appendFileSync(filePath, message + '\n', 'utf-8')
  } catch {
    // 文件写入失败不影响程序运行
  }
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
    writeToFile(fullMsg)

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
