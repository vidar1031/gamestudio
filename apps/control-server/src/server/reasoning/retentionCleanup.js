/**
 * 缓存、session 与日志保留清理。
 *
 * AUTO-C03：为长期运行建立可配置的 TTL/保留上限，避免 session 文件、queue item、
 * checkpoint 与内存缓存无限增长，同时硬保护活跃任务与审计证据。
 *
 * 策略表（env 可配 + 安全默认）：
 * | 数据 | 策略 | env | 默认 |
 * | --- | --- | --- | --- |
 * | sessionCallCounts（内存） | 上限淘汰，跳过活跃 session 与 global | HERMES_MODEL_TASK_SESSION_CALL_CACHE_MAX_ENTRIES | 500 |
 * | inspectModelAccessCache（内存） | TTL 过期 + 上限淘汰（淘汰只触发重探测） | HERMES_INSPECT_MODEL_CACHE_TTL_MS / HERMES_INSPECT_MODEL_CACHE_MAX_ENTRIES | 24h / 200 |
 * | reasoning session 文件 | 终态/failed 超过 TTL 后「先归档再删除」 | HERMES_RETENTION_SESSION_TTL_DAYS | 30 |
 * | queue item 文件 | 终态超过 TTL 且所属 session 已清理/可清理后「先归档再删除」 | HERMES_RETENTION_QUEUE_ITEM_TTL_DAYS | 30 |
 * | step checkpoint 文件 | 随「已可清理的 session」一起清理；孤儿 checkpoint 超 TTL 且 queue item 缺席/终结才可清理 | HERMES_RETENTION_CHECKPOINT_TTL_DAYS | 30 |
 * | chat history | 既有 lifecycleMaintenance：mtime 超期归档 + 单文件条目上限 | HERMES_CHAT_ARCHIVE_AFTER_DAYS / HERMES_CHAT_MAX_ENTRIES_PER_FILE | 30 / 120 |
 *
 * 保护规则（硬约束，不可被配置绕过）：
 * - 非终态 session（queued/running/waiting_review/pausing/paused/resuming/retry_wait/orphaned）
 *   与 protectedSessionIds（进程内活跃执行句柄）一律跳过；
 * - 任何 review.status === 'pending' 的 session（人工审核未决）一律跳过；
 * - failed session 保留重试证据价值：仅在超过 TTL 后才可清理（与终态同一 TTL）；
 * - 非终态 queue item（queued/claimed/running）与 waiting_review（人工审核等待）一律跳过；
 * - checkpoint 只随「本次可清理的 session」清理，活跃/保留中 session 的 checkpoint 不动；
 *   session 文件已缺失的孤儿 checkpoint 仅在超过 TTL 且 queue item 缺席或终结时才清理；
 * - 删除一律「先归档后删除」（state/memory-archive/retention/ 下留副本）；
 *   归档失败则保留原件并记 error，未归档证据绝不硬删；
 * - 无法解析的文件（JSON 损坏等）一律保留并记 error，不猜测内容。
 *
 * dry-run（dryRun: true）返回将删除/将保留清单与原因统计，不落任何删除、不写报告。
 * 执行模式产出可追溯报告：state/retention-cleanup/latest-report.json（最近一次的完整明细）
 * 与 state/retention-cleanup/history.jsonl（每次运行追加一行摘要）。
 * 重复运行幂等：已清理的文件下一轮不再出现，归档副本已存在则不覆盖。
 *
 * 与既有机制的分工（统一接入同一调度点，不另起平行系统）：
 * - maintenance/retention.js：人工运维入口（路由触发），把超量 session/jsonl/event-runs
 *   「移动」到 state/_archive 批次，不硬删、不感知 queue/checkpoint/内存缓存；
 * - memory/lifecycleMaintenance.js：context pool 规范化、chat history 归档/截断、session 索引；
 * - 本模块：reasoning 数据（session/queue item/checkpoint）的 TTL 清理 + 内存缓存淘汰，
 *   随 scheduleMemoryLifecycleMaintenance 低频自动执行。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REASONING_SESSION_STATE,
  isTerminalSessionState,
  normalizeLegacySessionStatus
} from './sessionStateMachine.js'
import {
  REASONING_QUEUE_ITEM_STATE,
  isTerminalQueueItemState,
  getQueueDir
} from './persistentQueue.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')
const DEFAULT_CHECKPOINT_DIR = path.join(REPO_ROOT, 'state', 'reasoning-checkpoints')
const DEFAULT_ARCHIVE_ROOT_DIR = path.join(REPO_ROOT, 'state', 'memory-archive', 'retention')
const DEFAULT_REPORT_DIR = path.join(REPO_ROOT, 'state', 'retention-cleanup')

const DAY_MS = 24 * 60 * 60 * 1000
// 报告明细条目上限，避免单次大批量清理时报告文件无限膨胀（统计数字始终精确）
const MAX_REPORT_ENTRIES = 1000

export const RETENTION_POLICY_DEFAULTS = Object.freeze({
  enabled: true,
  intervalMs: 6 * 60 * 60 * 1000,
  sessionTtlDays: 30,
  queueItemTtlDays: 30,
  checkpointTtlDays: 30,
  inspectModelCacheTtlMs: 24 * 60 * 60 * 1000,
  inspectModelCacheMaxEntries: 200,
  sessionCallCacheMaxEntries: 500
})

function parsePositiveNumber(value, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return num
}

function parseBoolean(value, fallback) {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return fallback
  if (['1', 'true', 'yes', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'off'].includes(text)) return false
  return fallback
}

/**
 * 解析保留策略（env 可覆盖，缺省取 RETENTION_POLICY_DEFAULTS 安全值）。
 */
export function resolveRetentionPolicies(env = process.env) {
  const source = env && typeof env === 'object' ? env : {}
  return {
    enabled: parseBoolean(source.HERMES_RETENTION_CLEANUP_ENABLED, RETENTION_POLICY_DEFAULTS.enabled),
    intervalMs: parsePositiveNumber(source.HERMES_RETENTION_CLEANUP_INTERVAL_MS, RETENTION_POLICY_DEFAULTS.intervalMs),
    sessionTtlDays: parsePositiveNumber(source.HERMES_RETENTION_SESSION_TTL_DAYS, RETENTION_POLICY_DEFAULTS.sessionTtlDays),
    queueItemTtlDays: parsePositiveNumber(source.HERMES_RETENTION_QUEUE_ITEM_TTL_DAYS, RETENTION_POLICY_DEFAULTS.queueItemTtlDays),
    checkpointTtlDays: parsePositiveNumber(source.HERMES_RETENTION_CHECKPOINT_TTL_DAYS, RETENTION_POLICY_DEFAULTS.checkpointTtlDays),
    inspectModelCacheTtlMs: parsePositiveNumber(source.HERMES_INSPECT_MODEL_CACHE_TTL_MS, RETENTION_POLICY_DEFAULTS.inspectModelCacheTtlMs),
    inspectModelCacheMaxEntries: Math.floor(parsePositiveNumber(source.HERMES_INSPECT_MODEL_CACHE_MAX_ENTRIES, RETENTION_POLICY_DEFAULTS.inspectModelCacheMaxEntries)),
    sessionCallCacheMaxEntries: Math.floor(parsePositiveNumber(source.HERMES_MODEL_TASK_SESSION_CALL_CACHE_MAX_ENTRIES, RETENTION_POLICY_DEFAULTS.sessionCallCacheMaxEntries))
  }
}

/**
 * 通用内存缓存淘汰（TTL + 上限，纯函数语义，直接原地修改传入 Map）。
 * 用于 inspectModelAccessCache 这类「删除只触发重探测」的探测缓存。
 */
export function pruneTtlCache(map, { now = Date.now(), ttlMs, maxEntries, getTimestamp } = {}) {
  const evicted = []
  if (!(map instanceof Map)) return { evicted }
  const ttlValue = Number(ttlMs)
  if (Number.isFinite(ttlValue) && ttlValue > 0 && typeof getTimestamp === 'function') {
    for (const [key, value] of map) {
      const ts = Date.parse(String(getTimestamp(value) || ''))
      if (Number.isFinite(ts) && now - ts >= ttlValue) {
        map.delete(key)
        evicted.push(key)
      }
    }
  }
  const limit = Math.floor(Number(maxEntries))
  if (Number.isFinite(limit) && limit > 0) {
    while (map.size > limit) {
      const oldestKey = map.keys().next().value
      map.delete(oldestKey)
      evicted.push(oldestKey)
    }
  }
  return { evicted }
}

/**
 * 通用内存缓存上限淘汰（无时间语义，插入顺序最旧优先，跳过受保护 key）。
 * 用于 sessionCallCounts 这类预算计数缓存：活跃/受保护条目的预算不可被重置。
 */
export function evictOldestCacheEntries(map, { maxEntries, protectedKeys = new Set() } = {}) {
  const evicted = []
  if (!(map instanceof Map)) return { evicted }
  const limit = Math.floor(Number(maxEntries))
  if (!Number.isFinite(limit) || limit <= 0) return { evicted }
  const protectedSet = protectedKeys instanceof Set ? protectedKeys : new Set(protectedKeys || [])
  for (const key of map.keys()) {
    if (map.size <= limit) break
    if (protectedSet.has(key)) continue
    map.delete(key)
    evicted.push(key)
  }
  return { evicted }
}

function resolveCheckpointDir() {
  return process.env.HERMES_REASONING_CHECKPOINT_DIR || DEFAULT_CHECKPOINT_DIR
}

function parseTimeMs(value) {
  const ms = Date.parse(String(value || ''))
  return Number.isFinite(ms) ? ms : null
}

// 记录的时间基线：优先最近活动时间（updatedAt/finishedAt），缺失回退 createdAt，再回退文件 mtime
function resolveRecordAgeMs(record, fileStatMs, nowMs, timeFields) {
  for (const field of timeFields) {
    const ms = parseTimeMs(record?.[field])
    if (ms != null) return Math.max(0, nowMs - ms)
  }
  return Math.max(0, nowMs - Number(fileStatMs || nowMs))
}

function createCategoryResult() {
  return { scanned: 0, deleted: 0, kept: 0, archived: 0, reasons: {} }
}

function bumpReason(categoryResult, reason) {
  categoryResult.reasons[reason] = (categoryResult.reasons[reason] || 0) + 1
}

/**
 * 先归档后删除：归档副本已存在则不覆盖；归档失败抛错由调用方保留原件。
 */
function archiveFileThenDelete(filePath, archivePath) {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true })
  const copied = !fs.existsSync(archivePath)
  if (copied) {
    fs.copyFileSync(filePath, archivePath)
  }
  // 归档副本已就位（本次复制或此前已存在）后才允许删除原件
  fs.unlinkSync(filePath)
  return copied
}

/**
 * 执行一轮保留清理。
 *
 * @param {object} options
 * @param {boolean} [options.dryRun] - 预览模式：只返回将删除/将保留清单与原因，不落任何删除、不写报告
 * @param {Date}   [options.now]
 * @param {string[]} [options.sessionDirs] - session 文件目录（runtime + legacy 两个目录都传）
 * @param {string} [options.queueDir] - queue item 目录，默认取 persistentQueue 的 getQueueDir()
 * @param {string} [options.checkpointDir] - checkpoint 目录，默认取 HERMES_REASONING_CHECKPOINT_DIR / state/reasoning-checkpoints
 * @param {string} [options.archiveRootDir] - 归档根目录，默认 state/memory-archive/retention
 * @param {string} [options.reportDir] - 报告目录，默认 state/retention-cleanup
 * @param {Set<string>} [options.protectedSessionIds] - 进程内活跃 session（活跃执行句柄），硬保护
 * @param {object} [options.policies] - 策略覆盖，默认 resolveRetentionPolicies()
 * @param {function} [options.logger]
 */
export function runReasoningRetentionCleanup({
  dryRun = false,
  now = new Date(),
  sessionDirs = [],
  queueDir = null,
  checkpointDir = null,
  archiveRootDir = DEFAULT_ARCHIVE_ROOT_DIR,
  reportDir = DEFAULT_REPORT_DIR,
  protectedSessionIds = new Set(),
  policies = resolveRetentionPolicies(),
  logger = () => {}
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now()
  const protectedIds = protectedSessionIds instanceof Set ? protectedSessionIds : new Set(protectedSessionIds || [])
  const normalizedSessionDirs = Array.from(new Set((Array.isArray(sessionDirs) ? sessionDirs : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)))
  const resolvedQueueDir = String(queueDir || getQueueDir() || '').trim()
  const resolvedCheckpointDir = String(checkpointDir || resolveCheckpointDir() || '').trim()

  const report = {
    version: 1,
    dryRun: Boolean(dryRun),
    ranAt: new Date(nowMs).toISOString(),
    policies: {
      sessionTtlDays: policies.sessionTtlDays,
      queueItemTtlDays: policies.queueItemTtlDays,
      checkpointTtlDays: policies.checkpointTtlDays
    },
    summary: { scanned: 0, deleted: 0, kept: 0, archived: 0, errors: 0 },
    categories: {
      reasoningSessions: createCategoryResult(),
      queueItems: createCategoryResult(),
      checkpoints: createCategoryResult()
    },
    entries: [],
    errors: []
  }

  const pushEntry = (entry) => {
    if (report.entries.length < MAX_REPORT_ENTRIES) {
      report.entries.push(entry)
    }
  }
  const recordError = (category, id, error) => {
    const detail = error instanceof Error ? error.message : String(error)
    report.errors.push({ category, id, error: detail })
    report.summary.errors += 1
    logger(`[RETENTION][ERROR] category=${category} id=${id} detail=${detail}`)
  }
  // action: delete（执行删除/预览将删除）| keep（保留）| error（解析或归档失败，保留）
  const record = (categoryResult, category, entry) => {
    if (entry.action === 'delete') categoryResult.deleted += 1
    else categoryResult.kept += 1
    bumpReason(categoryResult, entry.reason)
    report.summary.scanned += 1
    pushEntry({ category, ...entry })
  }

  // 删除执行：dry-run 只记账不落盘；归档失败保留原件记 error（未归档证据绝不硬删）
  const deleteWithArchive = ({ categoryResult, category, id, file, reason, ageDays }) => {
    if (dryRun) {
      record(categoryResult, category, { id, file, action: 'delete', reason, ageDays, archived: false })
      return true
    }
    try {
      // 归档路径保留来源目录名，避免 runtime/legacy 两个 session 目录的同名副本互相覆盖
      const archivePath = path.join(archiveRootDir, category, path.basename(path.dirname(file)), path.basename(file))
      const archived = archiveFileThenDelete(file, archivePath)
      if (archived) {
        categoryResult.archived += 1
        report.summary.archived += 1
      }
      record(categoryResult, category, { id, file, action: 'delete', reason, ageDays, archived: true })
      return true
    } catch (error) {
      recordError(category, id, error)
      record(categoryResult, category, { id, file, action: 'error', reason: 'archive_failed_kept', ageDays })
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // 第 1 段：reasoning session（两个目录按 sessionId 归组，判定一次，逐文件处理）
  // ---------------------------------------------------------------------------
  const sessionTtlMs = policies.sessionTtlDays * DAY_MS
  const sessionGroups = new Map() // sessionId -> { files: [{file, dirName}], session, parseError }
  for (const sessionDir of normalizedSessionDirs) {
    if (!sessionDir || !fs.existsSync(sessionDir)) continue
    const dirName = path.basename(sessionDir)
    for (const name of fs.readdirSync(sessionDir).filter((item) => item.endsWith('.json'))) {
      const file = path.join(sessionDir, name)
      const sessionId = name.replace(/\.json$/, '')
      report.categories.reasoningSessions.scanned += 1
      if (!sessionGroups.has(sessionId)) {
        sessionGroups.set(sessionId, { files: [], session: null, parseError: null, statMs: null })
      }
      const group = sessionGroups.get(sessionId)
      group.files.push({ file, dirName })
      // 同 sessionId 的多份副本只解析一次（优先第一份），损坏即整组保留
      if (!group.session && !group.parseError) {
        try {
          group.session = JSON.parse(fs.readFileSync(file, 'utf8'))
          group.statMs = fs.statSync(file).mtimeMs
        } catch (error) {
          group.parseError = error
        }
      }
    }
  }

  const deletedSessionIds = new Set()
  const retainedSessionIds = new Set()
  for (const [sessionId, group] of sessionGroups) {
    const category = report.categories.reasoningSessions
    if (group.parseError || !group.session) {
      recordError('reasoningSessions', sessionId, group.parseError || new Error('session_parse_failed'))
      record(category, 'reasoningSessions', { id: sessionId, file: group.files[0]?.file || null, action: 'error', reason: 'parse_failed_kept', ageDays: null })
      continue
    }
    const evaluation = evaluateSessionForCleanup(group.session, {
      sessionId,
      nowMs,
      ttlMs: sessionTtlMs,
      statMs: group.statMs,
      protectedIds
    })
    if (!evaluation.eligible) {
      retainedSessionIds.add(sessionId)
      record(category, 'reasoningSessions', { id: sessionId, file: group.files[0]?.file || null, action: 'keep', reason: evaluation.reason, ageDays: evaluation.ageDays })
      continue
    }
    // 同一 session 的所有副本（runtime + legacy）全部归档删除；全部成功才算 session 已清理
    let allDeleted = true
    for (const { file, dirName } of group.files) {
      const deleted = deleteWithArchive({
        categoryResult: category,
        category: 'reasoningSessions',
        id: `${sessionId}(${dirName})`,
        file,
        reason: evaluation.reason,
        ageDays: evaluation.ageDays
      })
      if (!deleted) allDeleted = false
    }
    if (allDeleted) deletedSessionIds.add(sessionId)
    else retainedSessionIds.add(sessionId)
  }

  // ---------------------------------------------------------------------------
  // 第 2 段：queue item（终态 + 超 TTL + 所属 session 已清理/不存在才可删除）
  // ---------------------------------------------------------------------------
  const queueTtlMs = policies.queueItemTtlDays * DAY_MS
  if (resolvedQueueDir && fs.existsSync(resolvedQueueDir)) {
    for (const name of fs.readdirSync(resolvedQueueDir).filter((item) => item.endsWith('.json'))) {
      const file = path.join(resolvedQueueDir, name)
      const category = report.categories.queueItems
      category.scanned += 1
      let item = null
      try {
        item = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch (error) {
        recordError('queueItems', name, error)
        record(category, 'queueItems', { id: name, file, action: 'error', reason: 'parse_failed_kept', ageDays: null })
        continue
      }
      const sessionId = String(item?.sessionId || name.replace(/\.json$/, ''))
      const status = String(item?.status || '').trim()
      const ageMs = resolveRecordAgeMs(item, safeStatMs(file, nowMs), nowMs, ['finishedAt', 'updatedAt', 'createdAt'])
      const ageDays = roundDays(ageMs)

      if (status === REASONING_QUEUE_ITEM_STATE.WAITING_REVIEW) {
        record(category, 'queueItems', { id: sessionId, file, action: 'keep', reason: 'waiting_review', ageDays })
        continue
      }
      if (!isTerminalQueueItemState(status)) {
        record(category, 'queueItems', { id: sessionId, file, action: 'keep', reason: `active_status:${status || 'unknown'}`, ageDays })
        continue
      }
      if (ageMs < queueTtlMs) {
        record(category, 'queueItems', { id: sessionId, file, action: 'keep', reason: 'within_ttl', ageDays })
        continue
      }
      // session 仍保留（未过期或受保护）时 item 作为其证据一起保留
      if (retainedSessionIds.has(sessionId)) {
        record(category, 'queueItems', { id: sessionId, file, action: 'keep', reason: 'session_retained', ageDays })
        continue
      }
      deleteWithArchive({
        categoryResult: category,
        category: 'queueItems',
        id: sessionId,
        file,
        reason: 'terminal_expired',
        ageDays
      })
    }
  }

  // ---------------------------------------------------------------------------
  // 第 3 段：checkpoint（只随「本次已清理的 session」清理；
  // session 缺失的孤儿 checkpoint 需超 TTL 且 queue item 缺席/终结）
  // ---------------------------------------------------------------------------
  const checkpointTtlMs = policies.checkpointTtlDays * DAY_MS
  if (resolvedCheckpointDir && fs.existsSync(resolvedCheckpointDir)) {
    const checkpointGroups = new Map() // sessionId -> [{file, stepIndex}]
    for (const name of fs.readdirSync(resolvedCheckpointDir).filter((item) => item.endsWith('.json'))) {
      const match = name.match(/^(.*)_step_(\d+)\.json$/)
      if (!match) continue
      const sessionId = match[1]
      if (!checkpointGroups.has(sessionId)) checkpointGroups.set(sessionId, [])
      checkpointGroups.get(sessionId).push({ file: path.join(resolvedCheckpointDir, name), name })
    }

    for (const [sessionId, files] of checkpointGroups) {
      const category = report.categories.checkpoints
      for (const { file, name } of files) {
        category.scanned += 1
        const ageMs = resolveRecordAgeMs(readCheckpointCreatedAt(file), safeStatMs(file, nowMs), nowMs, ['createdAt'])
        const ageDays = roundDays(ageMs)

        if (deletedSessionIds.has(sessionId)) {
          deleteWithArchive({
            categoryResult: category,
            category: 'checkpoints',
            id: `${sessionId}/${name}`,
            file,
            reason: 'session_cleaned',
            ageDays
          })
          continue
        }
        if (retainedSessionIds.has(sessionId)) {
          record(category, 'checkpoints', { id: `${sessionId}/${name}`, file, action: 'keep', reason: 'session_retained', ageDays })
          continue
        }
        // 孤儿 checkpoint：session 文件已不存在
        if (ageMs < checkpointTtlMs) {
          record(category, 'checkpoints', { id: `${sessionId}/${name}`, file, action: 'keep', reason: 'orphan_within_ttl', ageDays })
          continue
        }
        // queue item 仍活跃（非终态）时保留恢复证据
        const queueItemStatus = readQueueItemStatus(resolvedQueueDir, sessionId)
        if (queueItemStatus && !isTerminalQueueItemState(queueItemStatus)) {
          record(category, 'checkpoints', { id: `${sessionId}/${name}`, file, action: 'keep', reason: `queue_item_active:${queueItemStatus}`, ageDays })
          continue
        }
        deleteWithArchive({
          categoryResult: category,
          category: 'checkpoints',
          id: `${sessionId}/${name}`,
          file,
          reason: 'orphan_expired',
          ageDays
        })
      }
    }
  }

  report.summary.deleted = report.categories.reasoningSessions.deleted
    + report.categories.queueItems.deleted
    + report.categories.checkpoints.deleted
  report.summary.kept = report.categories.reasoningSessions.kept
    + report.categories.queueItems.kept
    + report.categories.checkpoints.kept

  if (!dryRun) {
    persistRetentionReport(reportDir, report)
  }
  logger(`[RETENTION] ranAt=${report.ranAt} dryRun=${report.dryRun} scanned=${report.summary.scanned} deleted=${report.summary.deleted} kept=${report.summary.kept} archived=${report.summary.archived} errors=${report.summary.errors}`)
  return report
}

/**
 * session 清理资格判定（纯函数，便于测试与审计）。
 * failed 不算状态机终态（有 retry 路径），但超过 TTL 后证据价值耗尽，按可清理处理。
 */
export function evaluateSessionForCleanup(session, { sessionId, nowMs, ttlMs, statMs, protectedIds = new Set() } = {}) {
  const id = String(sessionId || session?.sessionId || '')
  const ageMs = resolveRecordAgeMs(session, statMs, nowMs, ['updatedAt', 'createdAt'])
  const ageDays = roundDays(ageMs)
  const keep = (reason) => ({ eligible: false, reason, ageDays })

  if (id && protectedIds.has(id)) return keep('protected_active')
  const status = normalizeLegacySessionStatus(session?.status)
  if (status === REASONING_SESSION_STATE.WAITING_REVIEW) return keep('waiting_review')
  // 人工审核未决硬保护（含终态上残留 pending review 的防御场景）
  if (session?.review && typeof session.review === 'object' && session.review.status === 'pending') {
    return keep('pending_review')
  }
  const isFailed = status === REASONING_SESSION_STATE.FAILED
  if (!isTerminalSessionState(status) && !isFailed) {
    return keep(`active_status:${status}`)
  }
  if (ageMs < ttlMs) return keep('within_ttl')
  return { eligible: true, reason: isFailed ? 'failed_expired' : 'terminal_expired', ageDays }
}

function readCheckpointCreatedAt(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readQueueItemStatus(queueDir, sessionId) {
  if (!queueDir) return null
  try {
    const file = path.join(queueDir, `${sessionId}.json`)
    if (!fs.existsSync(file)) return null
    const item = JSON.parse(fs.readFileSync(file, 'utf8'))
    return String(item?.status || '').trim() || null
  } catch {
    // 损坏的 item 按「状态未知」处理：返回活跃占位，保守保留 checkpoint
    return 'unknown'
  }
}

function safeStatMs(file, fallbackMs) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return fallbackMs
  }
}

function roundDays(ageMs) {
  return Math.round((Number(ageMs) / DAY_MS) * 100) / 100
}

/**
 * 可追溯报告：latest-report.json 保留最近一次完整明细；history.jsonl 每次追加一行摘要。
 */
function persistRetentionReport(reportDir, report) {
  try {
    fs.mkdirSync(reportDir, { recursive: true })
    fs.writeFileSync(path.join(reportDir, 'latest-report.json'), JSON.stringify(report, null, 2), 'utf8')
    const historyLine = JSON.stringify({
      ranAt: report.ranAt,
      dryRun: report.dryRun,
      scanned: report.summary.scanned,
      deleted: report.summary.deleted,
      kept: report.summary.kept,
      archived: report.summary.archived,
      errors: report.summary.errors,
      byCategory: {
        reasoningSessions: { deleted: report.categories.reasoningSessions.deleted, kept: report.categories.reasoningSessions.kept },
        queueItems: { deleted: report.categories.queueItems.deleted, kept: report.categories.queueItems.kept },
        checkpoints: { deleted: report.categories.checkpoints.deleted, kept: report.categories.checkpoints.kept }
      }
    })
    fs.appendFileSync(path.join(reportDir, 'history.jsonl'), `${historyLine}\n`, 'utf8')
  } catch {
    // 报告写入失败不阻断清理结果（清理本身已完成并留有归档副本）
  }
}
