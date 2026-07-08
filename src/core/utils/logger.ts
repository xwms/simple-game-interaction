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
/** 生产环境标记 — 由主进程启动时设置 */
let _isProduction = true

/**
 * 功能描述：设置生产环境标记，控制 debug 日志是否输出
 *
 * @param v - true 为生产环境，debug 日志将被抑制
 */
export function setProduction(v: boolean): void {
  _isProduction = v
}
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
  return formatDateStr(new Date())
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

/** 日志写入流（按日滚动） */
let _writeStream: fs.WriteStream | null = null
let _currentDateStr: string | null = null

/**
 * 功能描述：写入日志文件（异步，按日期自动分文件）
 *
 * 逻辑说明：使用 fs.WriteStream 异步写入，避免同步 I/O 阻塞事件循环。
 *           按日滚动：日期变化时关闭旧流创建新流。
 *
 * @param message - 完整日志文本（含时间戳和级别）
 */
function writeToFile(message: string): void {
  const filePath = getLogFilePath()
  if (!filePath) return
  try {
    const dateStr = getDateStr()
    if (!_writeStream || _currentDateStr !== dateStr) {
      if (_writeStream) _writeStream.end()
      _writeStream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf-8' })
      _currentDateStr = dateStr
    }
    _writeStream.write(message + '\n')
  } catch {
    // 写入失败不影响程序运行
  }
}

/**
 * 功能描述：清理超过指定天数的日志文件
 *
 * 逻辑说明：扫描日志目录下所有 YYYY-MM-DD.log 文件，根据文件名日期判断
 *           是否超过 retentionDays，删除过期文件。字符串比较对 ISO 日期有效。
 *
 * @param retentionDays - 保留天数，超过此天数的文件将被删除
 * @returns 删除的文件数量
 */
export function cleanupLogFiles(retentionDays: number): number {
  if (!_logDir || retentionDays <= 0) return 0
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)
  const cutoffStr = formatDateStr(cutoff)
  let deletedCount = 0
  try {
    const files = fs.readdirSync(_logDir)
    for (const file of files) {
      const m = file.match(/^(\d{4}-\d{2}-\d{2})\.log$/)
      if (!m) continue
      if (m[1] < cutoffStr) {
        fs.unlinkSync(path.join(_logDir, file))
        deletedCount++
      }
    }
  } catch {
    // 清理失败不影响程序运行
  }
  return deletedCount
}

/**
 * 功能描述：删除所有日志文件
 *
 * @returns 删除的文件数量
 */
export function deleteAllLogFiles(): number {
  if (!_logDir) return 0
  let deletedCount = 0
  try {
    const files = fs.readdirSync(_logDir)
    for (const file of files) {
      if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(file)) continue
      fs.unlinkSync(path.join(_logDir, file))
      deletedCount++
    }
  } catch {
    // 清理失败不影响程序运行
  }
  return deletedCount
}

function formatDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
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
    if (_isProduction) return
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
