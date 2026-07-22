import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../../../../../')
const DEFAULT_LOGS_DIR = path.join(PROJECT_ROOT, 'logs')

/**
 * 按日期轮转的文件日志工具
 * - 文件命名: {baseName}.{YYYY-MM-DD}.{ext}
 * - 保留最近 N 天（默认 7 天）
 * - 自动清理过期文件
 */

function getDateStr(d = new Date()) {
  return d.toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-')
}

function parseDateStr(str) {
  const m = str.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]))
}

function getRotatedPath(basePath, dateStr) {
  const dir = path.dirname(basePath)
  const ext = path.extname(basePath)
  const base = path.basename(basePath, ext)
  return path.join(dir, `${base}.${dateStr}${ext}`)
}

function cleanupOldFiles(basePath, keepDays) {
  try {
    const dir = path.dirname(basePath)
    const ext = path.extname(basePath)
    const base = path.basename(basePath, ext)
    if (!fs.existsSync(dir)) return
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - keepDays)
    const files = fs.readdirSync(dir)
    for (const f of files) {
      if (!f.startsWith(base + '.')) continue
      if (!f.endsWith(ext)) continue
      const datePart = f.slice(base.length + 1, f.length - ext.length)
      const d = parseDateStr(datePart)
      if (!d) continue
      if (d < cutoff) {
        fs.unlinkSync(path.join(dir, f))
      }
    }
  } catch {
    // ignore cleanup errors
  }
}

/**
 * 获取当前日期的日志文件路径，必要时清理旧文件
 * @param {string} basePath - 基础文件路径（如 /tmp/gamestudio-hermes-gateway.log）
 * @param {number} keepDays - 保留天数，默认 7
 * @returns {string} 当日日志文件路径
 */
export function getDailyLogPath(basePath, keepDays = 7) {
  const today = getDateStr()
  const rotatedPath = getRotatedPath(basePath, today)
  // 延迟清理：只在创建新文件时执行（每天一次）
  cleanupOldFiles(basePath, keepDays)
  return rotatedPath
}

/**
 * 追加写入按日期轮转的日志文件
 * @param {string} basePath - 基础文件路径
 * @param {string} content - 要写入的内容
 * @param {number} keepDays - 保留天数
 */
export function appendDailyLog(basePath, content, keepDays = 7) {
  try {
    const logPath = getDailyLogPath(basePath, keepDays)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, content, 'utf8')
  } catch {
    // ignore logging failures
  }
}

/**
 * 追加写入按日期轮转的 JSONL 文件
 * @param {string} basePath - 基础文件路径
 * @param {object} record - 要写入的记录对象
 * @param {number} keepDays - 保留天数
 */
export function appendDailyJsonl(basePath, record, keepDays = 7) {
  try {
    const logPath = getDailyLogPath(basePath, keepDays)
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // ignore logging failures
  }
}

/**
 * 读取按日期轮转的日志文件（合并最近 N 天的内容）
 * @param {string} basePath - 基础文件路径
 * @param {number} days - 读取最近 N 天，默认 1（当天）
 * @returns {string[]} 每行一条的日志数组
 */
export function readDailyLogs(basePath, days = 1) {
  const lines = []
  try {
    const dir = path.dirname(basePath)
    const ext = path.extname(basePath)
    const base = path.basename(basePath, ext)
    if (!fs.existsSync(dir)) return lines
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)
    const files = fs.readdirSync(dir).sort()
    for (const f of files) {
      if (!f.startsWith(base + '.')) continue
      if (!f.endsWith(ext)) continue
      const datePart = f.slice(base.length + 1, f.length - ext.length)
      const d = parseDateStr(datePart)
      if (!d || d < cutoff) continue
      const content = fs.readFileSync(path.join(dir, f), 'utf8')
      lines.push(...content.split('\n').filter(Boolean))
    }
  } catch {
    // ignore read errors
  }
  return lines
}

/* ── 结构化日志（目录式轮转）──────────────────────────── */

function getTodayDir(baseDir = DEFAULT_LOGS_DIR) {
  const dateStr = new Date().toISOString().slice(0, 10)
  return path.join(baseDir, dateStr)
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function cleanupOldLogDirs(baseDir, retentionDays = 7) {
  if (!fs.existsSync(baseDir)) return
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  for (const entry of fs.readdirSync(baseDir)) {
    const entryPath = path.join(baseDir, entry)
    const stat = fs.statSync(entryPath)
    if (stat.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry)) {
      const entryTime = new Date(entry).getTime()
      if (entryTime < cutoff) {
        fs.rmSync(entryPath, { recursive: true, force: true })
      }
    }
  }
}

/**
 * 写入结构化日志（JSONL 格式）到 logs/YYYY-MM-DD/{prefix}.log
 * @param {string} prefix - 日志前缀（如 'supervision', 'agent-runtime', 'hermes-runtime'）
 * @param {string} level - 日志级别：info, warn, error, debug
 * @param {string} message - 日志消息
 * @param {object} meta - 附加结构化字段
 * @param {string} baseDir - 日志根目录，默认 PROJECT_ROOT/logs
 */
export function writeStructuredLog(prefix, level, message, meta = {}, baseDir = DEFAULT_LOGS_DIR) {
  const dir = getTodayDir(baseDir)
  ensureDir(dir)
  cleanupOldLogDirs(baseDir, 7)
  const filePath = path.join(dir, `${prefix}.log`)
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  }
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8')
}

/**
 * 读取最近 N 条结构化日志
 * @param {string} prefix - 日志前缀
 * @param {number} lines - 读取行数，默认 100
 * @param {string} baseDir - 日志根目录
 * @returns {object[]} 解析后的日志对象数组
 */
export function readStructuredLogs(prefix, lines = 100, baseDir = DEFAULT_LOGS_DIR) {
  const filePath = path.join(getTodayDir(baseDir), `${prefix}.log`)
  if (!fs.existsSync(filePath)) return []
  const content = fs.readFileSync(filePath, 'utf8').trim()
  if (!content) return []
  const all = content.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return { raw: l } }
  })
  return all.slice(-lines)
}
