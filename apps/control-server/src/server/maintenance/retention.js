import fs from 'node:fs'
import path from 'node:path'

import {
  GAMESTUDIO_ROOT,
  HERMES_REASONING_SESSIONS_DIR,
  HERMES_AGENT_RUNTIME_SESSIONS_DIR,
  HERMES_AGENT_RUNTIME_EVENTS_FILE,
  HERMES_AGENT_RUNTIME_REVIEW_RECORDS_FILE,
  HERMES_REASONING_REVIEW_RECORDS_FILE
} from '../../config/paths.js'

// Control 状态保留策略（retention）。
// 原则：先归档（state/_archive/<ts>/），再清理；活跃数据（非 terminal session、当天 jsonl）永不清理。
// 可选覆盖配置：config/control/retention.json；无文件时用 DEFAULT_POLICY。

const STATE_ROOT = path.join(GAMESTUDIO_ROOT, 'state')
const ARCHIVE_ROOT = path.join(STATE_ROOT, '_archive')
const EVENTS_JSONL = path.join(STATE_ROOT, 'events', 'events.jsonl')
const EVENT_RUNS_ROOT = path.join(STATE_ROOT, 'event-runs')
const MEMORY_ARCHIVE_ROOT = path.join(STATE_ROOT, 'memory-archive')
const REASONING_IMPROVEMENT_FILE = path.join(STATE_ROOT, 'reasoning-improvement-candidates.jsonl')
const REASONING_CALIBRATION_FILE = path.join(STATE_ROOT, 'reasoning-quality-calibrations.jsonl')
const REASONING_SELF_REVIEWS_FILE = path.join(STATE_ROOT, 'reasoning-self-reviews.jsonl')
const POLICY_FILE = path.join(GAMESTUDIO_ROOT, 'config', 'control', 'retention.json')

export const DEFAULT_POLICY = {
  sessions: { keepRecent: 100, keepDays: 7 },
  jsonl: { maxSizeBytes: 10 * 1024 * 1024 },
  eventRuns: { keepPerCase: 20 },
  archives: { keepBatches: 3 }
}

const TERMINAL_SESSION_STATUS = new Set(['completed', 'failed', 'cancelled'])

export function loadRetentionPolicy() {
  try {
    if (fs.existsSync(POLICY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'))
      return {
        sessions: { ...DEFAULT_POLICY.sessions, ...(raw.sessions || {}) },
        jsonl: { ...DEFAULT_POLICY.jsonl, ...(raw.jsonl || {}) },
        eventRuns: { ...DEFAULT_POLICY.eventRuns, ...(raw.eventRuns || {}) },
        archives: { ...DEFAULT_POLICY.archives, ...(raw.archives || {}) }
      }
    }
  } catch {
    // 配置损坏时回退默认策略
  }
  return DEFAULT_POLICY
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .filter((filePath) => {
      try { return fs.statSync(filePath).isFile() } catch { return false }
    })
}

function dirStats(targetPath) {
  if (!fs.existsSync(targetPath)) return { exists: false, fileCount: 0, totalBytes: 0, oldestAt: null, newestAt: null }
  let fileCount = 0
  let totalBytes = 0
  let oldestMs = null
  let newestMs = null
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(entryPath)
      } else if (entry.isFile()) {
        fileCount += 1
        const stat = fs.statSync(entryPath)
        totalBytes += stat.size
        if (oldestMs === null || stat.mtimeMs < oldestMs) oldestMs = stat.mtimeMs
        if (newestMs === null || stat.mtimeMs > newestMs) newestMs = stat.mtimeMs
      }
    }
  }
  try { walk(targetPath) } catch { /* ignore */ }
  return {
    exists: true,
    fileCount,
    totalBytes,
    oldestAt: oldestMs ? new Date(oldestMs).toISOString() : null,
    newestAt: newestMs ? new Date(newestMs).toISOString() : null
  }
}

function fileStats(targetPath) {
  if (!fs.existsSync(targetPath)) return { exists: false, fileCount: 0, totalBytes: 0, oldestAt: null, newestAt: null }
  const stat = fs.statSync(targetPath)
  return {
    exists: true,
    fileCount: 1,
    totalBytes: stat.size,
    oldestAt: stat.mtime.toISOString(),
    newestAt: stat.mtime.toISOString()
  }
}

export function getStorageOverview() {
  const reasoningSessions = dirStats(HERMES_REASONING_SESSIONS_DIR)
  const runtimeSessions = dirStats(HERMES_AGENT_RUNTIME_SESSIONS_DIR)
  const eventsJsonl = fileStats(EVENTS_JSONL)
  const runtimeEventsJsonl = fileStats(HERMES_AGENT_RUNTIME_EVENTS_FILE)
  const reviewA = fileStats(HERMES_AGENT_RUNTIME_REVIEW_RECORDS_FILE)
  const reviewB = fileStats(HERMES_REASONING_REVIEW_RECORDS_FILE)
  const eventRuns = dirStats(EVENT_RUNS_ROOT)
  const archive = dirStats(ARCHIVE_ROOT)
  const memoryArchive = dirStats(MEMORY_ARCHIVE_ROOT)

  const overview = [
    { key: 'reasoning-sessions', label: 'Reasoning 会话', ...reasoningSessions },
    { key: 'agent-runtime-sessions', label: 'Runtime 会话', ...runtimeSessions },
    { key: 'events-jsonl', label: '事件分发记录', ...eventsJsonl },
    { key: 'runtime-events-jsonl', label: 'Runtime 事件记录', ...runtimeEventsJsonl },
    { key: 'review-records', label: '审核记录', exists: reviewA.exists || reviewB.exists, fileCount: reviewA.fileCount + reviewB.fileCount, totalBytes: reviewA.totalBytes + reviewB.totalBytes, oldestAt: null, newestAt: null },
    { key: 'event-runs', label: '事件测试报告', ...eventRuns },
    { key: 'archive', label: '归档目录', ...archive },
    { key: 'memory-archive', label: '记忆归档', ...memoryArchive }
  ].map((entry) => ({ ...entry, sizeLabel: formatBytes(entry.totalBytes) }))

  const aggregate = (statsList) => {
    const merged = statsList.reduce((acc, stat) => ({
      exists: acc.exists || stat.exists,
      fileCount: acc.fileCount + stat.fileCount,
      totalBytes: acc.totalBytes + stat.totalBytes,
      newestAt: [acc.newestAt, stat.newestAt].filter(Boolean).sort().pop() || null
    }), { exists: false, fileCount: 0, totalBytes: 0, newestAt: null })
    return { ...merged, sizeLabel: formatBytes(merged.totalBytes) }
  }

  const statsByCategory = {
    sessions: aggregate([reasoningSessions, runtimeSessions]),
    events: aggregate([eventsJsonl, runtimeEventsJsonl]),
    reviews: aggregate([reviewA, reviewB]),
    'event-runs': aggregate([eventRuns]),
    archives: aggregate([archive, memoryArchive])
  }

  const categories = Object.entries(RESET_CATEGORIES).map(([key, def]) => ({
    key,
    label: def.label,
    impactLevel: def.impactLevel,
    impactLabel: def.impactLabel,
    description: def.description,
    impactSummary: def.impactSummary,
    ...statsByCategory[key]
  }))

  return { overview, categories }
}

function formatBytes(bytes) {
  const value = Number(bytes || 0)
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

function moveToArchive(sourcePath, archiveDir) {
  if (!fs.existsSync(sourcePath)) return null
  const targetPath = path.join(archiveDir, path.basename(sourcePath))
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.renameSync(sourcePath, targetPath)
  return targetPath
}

function readSessionTerminal(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const status = String(raw?.status || '').trim()
    return TERMINAL_SESSION_STATUS.has(status)
  } catch {
    return true // 无法解析的 session 文件视为可清理
  }
}

function cleanupSessionDir(dir, policy, archiveDir, report) {
  const files = listJsonFiles(dir).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  const cutoffMs = Date.now() - Number(policy.keepDays || 7) * 24 * 60 * 60 * 1000
  const keepRecent = Math.max(0, Number(policy.keepRecent || 100))
  const candidates = []
  files.forEach((filePath, index) => {
    const stat = fs.statSync(filePath)
    const tooOld = stat.mtimeMs < cutoffMs
    const beyondRecent = index >= keepRecent
    if (!tooOld && !beyondRecent) return
    if (!readSessionTerminal(filePath)) {
      report.protected += 1
      report.protectedFiles.push(path.basename(filePath))
      return
    }
    candidates.push(filePath)
  })
  for (const filePath of candidates) {
    moveToArchive(filePath, archiveDir)
    report.archived += 1
    report.archivedFiles.push(path.basename(filePath))
  }
}

function truncateJsonlIfOversized(filePath, maxSizeBytes, archiveDir, report) {
  if (!fs.existsSync(filePath)) return
  const stat = fs.statSync(filePath)
  if (stat.size <= maxSizeBytes) return
  moveToArchive(filePath, archiveDir)
  report.archived += 1
  report.archivedFiles.push(path.basename(filePath))
  report.truncated += 1
}

function cleanupEventRuns(policy, archiveDir, report) {
  if (!fs.existsSync(EVENT_RUNS_ROOT)) return
  const keepPerCase = Math.max(1, Number(policy.keepPerCase || 20))
  for (const caseName of fs.readdirSync(EVENT_RUNS_ROOT)) {
    const caseDir = path.join(EVENT_RUNS_ROOT, caseName)
    if (!fs.statSync(caseDir).isDirectory()) continue
    const files = listJsonFiles(caseDir).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    const excess = files.slice(keepPerCase)
    for (const filePath of excess) {
      moveToArchive(filePath, path.join(archiveDir, caseName))
      report.archived += 1
      report.archivedFiles.push(`${caseName}/${path.basename(filePath)}`)
    }
  }
}

function cleanupArchiveBatches(rootDir, keepBatches, archiveTrashDir, report) {
  if (!fs.existsSync(rootDir)) return
  const batches = fs.readdirSync(rootDir)
    .map((name) => path.join(rootDir, name))
    .filter((entryPath) => {
      try { return fs.statSync(entryPath).isDirectory() } catch { return false }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  const excess = batches.slice(Math.max(1, keepBatches))
  for (const batchDir of excess) {
    const targetPath = path.join(archiveTrashDir, path.basename(batchDir))
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.renameSync(batchDir, targetPath)
    report.archived += 1
    report.archivedFiles.push(`${path.basename(rootDir)}/${path.basename(batchDir)}`)
  }
}

// 周期性保留清理：把超出策略的数据移动到归档，不删除。
// options.trigger: 'startup' | 'manual' | 'reset'
export function runRetentionCleanup(options = {}) {
  const policy = loadRetentionPolicy()
  const ts = safeTimestamp()
  const archiveDir = path.join(ARCHIVE_ROOT, `retention_${ts}`)
  const report = {
    trigger: options.trigger || 'manual',
    startedAt: new Date().toISOString(),
    archiveDir: path.relative(GAMESTUDIO_ROOT, archiveDir),
    archived: 0,
    truncated: 0,
    protected: 0,
    archivedFiles: [],
    protectedFiles: []
  }

  cleanupSessionDir(HERMES_REASONING_SESSIONS_DIR, policy.sessions, path.join(archiveDir, 'reasoning-sessions'), report)
  cleanupSessionDir(HERMES_AGENT_RUNTIME_SESSIONS_DIR, policy.sessions, path.join(archiveDir, 'agent-runtime-sessions'), report)

  const maxSize = Number(policy.jsonl.maxSizeBytes || DEFAULT_POLICY.jsonl.maxSizeBytes)
  for (const filePath of [
    EVENTS_JSONL,
    HERMES_AGENT_RUNTIME_EVENTS_FILE,
    HERMES_AGENT_RUNTIME_REVIEW_RECORDS_FILE,
    HERMES_REASONING_REVIEW_RECORDS_FILE,
    REASONING_IMPROVEMENT_FILE,
    REASONING_CALIBRATION_FILE,
    REASONING_SELF_REVIEWS_FILE
  ]) {
    truncateJsonlIfOversized(filePath, maxSize, path.join(archiveDir, 'jsonl'), report)
  }

  cleanupEventRuns(policy.eventRuns, path.join(archiveDir, 'event-runs'), report)

  report.endedAt = new Date().toISOString()
  if (report.archived === 0 && report.protected === 0) {
    // 没有产生任何归档动作时删除空归档目录，避免留下垃圾
    try { fs.rmSync(archiveDir, { recursive: true, force: true }); report.archiveDir = null } catch { /* ignore */ }
  }
  return report
}

const RESET_CATEGORIES = {
  sessions: {
    label: '会话历史',
    targets: [HERMES_REASONING_SESSIONS_DIR, HERMES_AGENT_RUNTIME_SESSIONS_DIR],
    kind: 'dir-clear',
    impactLevel: 'caution',
    impactLabel: '谨慎删除',
    description: '归档并清空全部 reasoning / agent-runtime session 文件（含已完成、失败、已取消与进行中的会话）。',
    impactSummary: '丢失 plan、步骤执行、审核流转、artifacts 与最终回答证据；不删除长期记忆与配置。'
  },
  events: {
    label: '事件分发记录',
    targets: [EVENTS_JSONL, HERMES_AGENT_RUNTIME_EVENTS_FILE],
    kind: 'file-clear',
    impactLevel: 'safe',
    impactLabel: '可删除',
    description: '归档并清空事件分发 JSONL（events.jsonl）与 runtime 事件记录。',
    impactSummary: '仅影响事件溯源与审计回看；事件机制、注册表与后续分发不受影响。'
  },
  reviews: {
    label: '审核记录',
    targets: [HERMES_AGENT_RUNTIME_REVIEW_RECORDS_FILE, HERMES_REASONING_REVIEW_RECORDS_FILE],
    kind: 'file-clear',
    impactLevel: 'caution',
    impactLabel: '谨慎删除',
    description: '归档并清空 agent-runtime 与 reasoning 两份审核记录 JSONL。',
    impactSummary: '丢失人工审核、自动审核与质量门裁决的历史证据。'
  },
  'event-runs': {
    label: '事件测试报告',
    targets: [EVENT_RUNS_ROOT],
    kind: 'dir-clear',
    impactLevel: 'safe',
    impactLabel: '可删除',
    description: '归档并清空事件测试用例的历史运行报告（state/event-runs/）。',
    impactSummary: '仅影响历史测试报告回看；测试用例定义（testcases/）不受影响。'
  },
  archives: {
    label: '归档目录（含记忆归档）',
    targets: [ARCHIVE_ROOT, MEMORY_ARCHIVE_ROOT],
    kind: 'dir-clear',
    impactLevel: 'high',
    impactLabel: '高影响',
    description: '清空 state/_archive 与 state/memory-archive 全部历史归档批次。',
    impactSummary: '删除后无法再从归档恢复任何历史数据；当前在用状态不受影响。'
  }
}

// 逐项清理的类别定义。注意：不提供 'all' 一键全清（严重影响，已按用户决定移除）。

export function getResetCategories() {
  return Object.entries(RESET_CATEGORIES).map(([key, value]) => ({
    key,
    label: value.label,
    impactLevel: value.impactLevel,
    impactLabel: value.impactLabel,
    description: value.description,
    impactSummary: value.impactSummary
  }))
}

// 一键重置：先整体归档目标目录/文件，再清空。confirm=true 才执行。
// 注意：不支持 'all' 全清（严重影响，已按用户决定移除），只能按类别逐项清理。
export function runMaintenanceReset(category, options = {}) {
  const ts = safeTimestamp()
  const report = {
    category,
    confirmed: options.confirm === true,
    startedAt: new Date().toISOString(),
    results: []
  }
  if (report.confirmed !== true) {
    report.error = 'confirm_required'
    return report
  }
  if (category === 'all' || !RESET_CATEGORIES[category]) {
    report.error = category === 'all' ? 'category_disabled' : 'unknown_category'
    return report
  }
  const categories = [category]

  for (const key of categories) {
    const def = RESET_CATEGORIES[key]
    if (!def) {
      report.results.push({ key, ok: false, error: 'unknown_category' })
      continue
    }
    const archiveDir = path.join(ARCHIVE_ROOT, `reset_${ts}`, key)
    const result = { key, label: def.label, ok: true, archivedFiles: 0, cleared: 0, archiveDir: path.relative(GAMESTUDIO_ROOT, archiveDir), skipped: [] }
    for (const target of def.targets) {
      if (!fs.existsSync(target)) {
        result.skipped.push(`${path.basename(target)}（不存在）`)
        continue
      }
      const stat = fs.statSync(target)
      if (stat.isDirectory()) {
        const files = []
        const walk = (dir) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const entryPath = path.join(dir, entry.name)
            if (entry.isDirectory()) walk(entryPath)
            else if (entry.isFile()) files.push(entryPath)
          }
        }
        walk(target)
        for (const filePath of files) {
          const rel = path.relative(target, filePath)
          const dest = path.join(archiveDir, rel)
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.renameSync(filePath, dest)
          result.archivedFiles += 1
          result.cleared += 1
        }
        // 保留目录本体，只清空内容（事件分类目录保留 events/ 等结构）
      } else if (stat.isFile()) {
        moveToArchive(target, archiveDir)
        result.archivedFiles += 1
        result.cleared += 1
      }
    }
    if (result.archivedFiles === 0 && result.skipped.length > 0) {
      result.archiveDir = null
    }
    report.results.push(result)
  }

  report.endedAt = new Date().toISOString()
  return report
}

// 读取事件分发历史（倒序最近 N 条）
export function readEventHistory(limit = 100) {
  return readJsonlTail(EVENTS_JSONL, limit)
}

// 读取审核记录（两个来源合并，倒序最近 N 条）
export function readReviewRecords(limit = 100) {
  const runtimeRecords = readJsonlTail(HERMES_AGENT_RUNTIME_REVIEW_RECORDS_FILE, limit).map((item) => ({ ...item, source: 'agent-runtime' }))
  const reasoningRecords = readJsonlTail(HERMES_REASONING_REVIEW_RECORDS_FILE, limit).map((item) => ({ ...item, source: 'reasoning' }))
  return [...runtimeRecords, ...reasoningRecords]
    .sort((a, b) => String(b.timestamp || b.ts || b.decidedAt || '').localeCompare(String(a.timestamp || a.ts || a.decidedAt || '')))
    .slice(0, limit)
}

function readJsonlTail(filePath, limit) {
  if (!fs.existsSync(filePath)) return []
  const content = fs.readFileSync(filePath, 'utf8').trim()
  if (!content) return []
  return content.split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) } catch { return { raw: line } }
    })
    .slice(-Math.max(1, Number(limit) || 100))
    .reverse()
}

// 自动发现当天结构化日志前缀
export function listLogPrefixes() {
  const logsRoot = path.join(GAMESTUDIO_ROOT, 'logs')
  const today = new Date().toISOString().slice(0, 10)
  const todayDir = path.join(logsRoot, today)
  const prefixes = []
  if (fs.existsSync(todayDir)) {
    for (const name of fs.readdirSync(todayDir)) {
      if (name.endsWith('.log')) prefixes.push(name.slice(0, -4))
    }
  }
  return { today, prefixes: prefixes.sort() }
}
