/**
 * reasoning 最小持久化任务队列。
 *
 * AUTO-C01：将单 session 执行升级为持久化队列——任务可排队、领取、执行，
 * 并在服务重启后恢复调度且不重复领取。
 *
 * 语义约定：
 * - queue item 持久化在 state/reasoning-queue/<sessionId>.json（HERMES_REASONING_QUEUE_DIR 可覆盖），
 *   taskId 与 sessionId 同源；写盘采用 tmp+rename 原子语义，崩溃不留半截文件。
 * - item 状态机：queued -> claimed -> running -> 终态（completed/failed/cancelled/timeout/blocked，
 *   镜像 session 状态机终态）；waiting_review 是「已释放」状态：人工审核等待期间释放
 *   project 槽位（人可能永远不审，不允许槽位被无限占用造成同 project 死锁）。
 * - 领取原子且可持久化验证：claim 写 workerId + claimedAt + 单调递增 claimGeneration；
 *   进程内全部走同步 fs（Node 单线程，check 与 write 之间无 await，天然互斥）；
 *   跨进程由唯一 workerId + claimGeneration 判定：重启后旧 worker 的 claim 一律视为 stale，
 *   必须先经启动恢复收敛，再由新 worker 重新领取，绝不直接接着跑。
 * - 调度约束：同一 projectId 串行（一个 project 同时最多 1 个 running）；projectId 缺失时
 *   按 sessionId 自身作为串行键（互不阻塞，仅受全局并发上限约束）；跨 project 受全局并发
 *   上限 HERMES_REASONING_QUEUE_MAX_CONCURRENCY（默认 2：reasoning 任务 plan/step 都打本地模型，
 *   更高并发容易打爆本地模型触发 hard timeout，2 允许跨 project 并行又限制模型压力）。
 * - 重启恢复（S2-10）：已 claimed/running 的 item 按 B03 orphan 语义先收敛 session
 *   （worker 死了 -> orphaned，证据不足 -> blocked），再决定重新入队；
 *   重新入队的 item 从 B02 checkpoint 的 nextStepIndex 恢复，已成功 step 不重跑；
 *   从未开始执行的（session 仍为 queued）直接重新排队从头跑（plan 阶段幂等，无副作用）。
 * - 人工审核门禁不可绕过：重启时处于 waiting_review（或刚从 waiting_review 收敛为 orphaned）
 *   的 session 不自动重排队，item 释放为 waiting_review，走 B03 人工 recover。
 * - AUTO-C02 重试调度：session 失败经 retryPolicy 确定性分类——retryable 且未达上限时
 *   item 回 queued 落 nextAttemptAt（指数退避，到点才可再领取），session 转 retry_wait；
 *   达到上限稳定终结 failed（retryHistory 记录每次原因与时间）；needs_review/blocked 类
 *   收敛 blocked；非重试错误按原语义终结 failed。retry_wait 中被 cancel 的 session 由
 *   tick 第 2 段镜像终结，绝不再被领取。
 * - AUTO-F01 多项目隔离与配额：
 *   1) projectId 回写（补 C01 窗口）：story 类 session 创建时项目尚未生成，item.projectId
 *      为 null 按 session 键独立调度；项目创建/定位成功后由核心侧调用
 *      backfillQueueItemProjectId 回写 item.projectId，此后同 project 串行与配额统计
 *      对该任务生效，事件流留 project_id_backfilled 证据；
 *   2) 每项目在制配额：HERMES_REASONING_MAX_TASKS_PER_PROJECT（默认 1，与同 project
 *      串行语义对齐）限制同一 projectId 的调度中任务数（queued/claimed/running；
 *      waiting_review 已释放槽位不计入，避免人工不审造成死锁）。配额判定是纯函数
 *      evaluateProjectQuota，由发起路径（HTTP 提交/dispatch/cron）在新建 item 前调用；
 *      既有 item 的幂等入队、人工重试与重试调度不受配额阻断（不扼杀恢复路径）；
 *   3) 失败隔离：item 的终结/重试/阻断全部按 sessionId 粒度落盘，active 槽位按
 *      sessionId 持有，一个 project 的 failed/cancelled/blocked 不进入其他 project
 *      的调度判定（selectClaimableQueueItems 只读状态与 projectKey，不读他项目结果）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REASONING_SESSION_STATE,
  isTerminalSessionState,
  normalizeLegacySessionStatus,
  applySessionTransition
} from './sessionStateMachine.js'
import {
  REASONING_RETRY_CATEGORY,
  classifyReasoningFailure,
  extractFailureSignals,
  resolveRetryMaxAttempts,
  resolveRetryBaseMs,
  resolveRetryMaxDelayMs,
  computeRetryBackoffMs
} from './retryPolicy.js'
import {
  ORPHAN_REASON_SERVER_RESTART,
  evaluateOrphanRecovery,
  buildOrphanedTransition,
  buildOrphanBlockedTransition
} from './orphanRecovery.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..')
const DEFAULT_QUEUE_DIR = path.join(REPO_ROOT, 'state', 'reasoning-queue')

// 全局并发上限：HERMES_REASONING_QUEUE_MAX_CONCURRENCY 可覆盖，默认 2
const DEFAULT_MAX_CONCURRENCY = 2
// AUTO-F01：每项目在制配额上限：HERMES_REASONING_MAX_TASKS_PER_PROJECT 可覆盖，默认 1
// （与同 project 串行语义对齐：同一项目同时最多 1 个任务在调度中）
const DEFAULT_MAX_TASKS_PER_PROJECT = 1
// worker 调度 tick：HERMES_REASONING_QUEUE_TICK_MS 可覆盖，默认 1000ms
const DEFAULT_TICK_MS = 1000
// 心跳过期扫描间隔（挂 worker 周期能力，B03 遗留的可选增强）：
// HERMES_REASONING_QUEUE_HEARTBEAT_SCAN_INTERVAL_MS 可覆盖，默认 60000ms；<=0 关闭
const DEFAULT_HEARTBEAT_SCAN_INTERVAL_MS = 60000
// item history 上限，避免长期运行无限增长
const MAX_ITEM_HISTORY_ENTRIES = 30
// AUTO-C02：item retryHistory 上限（每次重试调度记录原因与时间）
const MAX_ITEM_RETRY_HISTORY_ENTRIES = 30

export const REASONING_QUEUE_ITEM_STATE = Object.freeze({
  QUEUED: 'queued',
  CLAIMED: 'claimed',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout',
  BLOCKED: 'blocked',
  WAITING_REVIEW: 'waiting_review'
})

// 终态：不再调度、不再镜像 session
const TERMINAL_ITEM_STATES = new Set([
  REASONING_QUEUE_ITEM_STATE.COMPLETED,
  REASONING_QUEUE_ITEM_STATE.FAILED,
  REASONING_QUEUE_ITEM_STATE.CANCELLED,
  REASONING_QUEUE_ITEM_STATE.TIMEOUT,
  REASONING_QUEUE_ITEM_STATE.BLOCKED
])

export function isTerminalQueueItemState(status) {
  return TERMINAL_ITEM_STATES.has(status)
}

// 是否已释放调度槽位（终态 + 人工审核等待）
export function isReleasedQueueItemState(status) {
  return TERMINAL_ITEM_STATES.has(status) || status === REASONING_QUEUE_ITEM_STATE.WAITING_REVIEW
}

export function resolveQueueMaxConcurrency(value) {
  const raw = value ?? process.env.HERMES_REASONING_QUEUE_MAX_CONCURRENCY
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_MAX_CONCURRENCY
  return Math.max(1, Math.floor(num))
}

export function resolveQueueTickMs(value) {
  const raw = value ?? process.env.HERMES_REASONING_QUEUE_TICK_MS
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_TICK_MS
  return Math.max(1, Math.floor(num))
}

export function resolveQueueHeartbeatScanIntervalMs(value) {
  const raw = value ?? process.env.HERMES_REASONING_QUEUE_HEARTBEAT_SCAN_INTERVAL_MS
  if (raw === undefined || raw === null || raw === '') return DEFAULT_HEARTBEAT_SCAN_INTERVAL_MS
  const num = Number(raw)
  if (!Number.isFinite(num)) return DEFAULT_HEARTBEAT_SCAN_INTERVAL_MS
  return Math.floor(num)
}

// AUTO-F01：每项目在制配额上限解析（默认 1）
export function resolveQueueMaxTasksPerProject(value) {
  const raw = value ?? process.env.HERMES_REASONING_MAX_TASKS_PER_PROJECT
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_MAX_TASKS_PER_PROJECT
  return Math.max(1, Math.floor(num))
}

export function getQueueDir() {
  return process.env.HERMES_REASONING_QUEUE_DIR || DEFAULT_QUEUE_DIR
}

function ensureQueueDir() {
  const dir = getQueueDir()
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getQueueItemFilePath(sessionId) {
  return path.join(getQueueDir(), `${sessionId}.json`)
}

/**
 * item 的串行键：有 projectId 按 project 串行；缺失时按 session 自身独立（互不阻塞）。
 */
export function resolveQueueProjectKey(item) {
  const projectId = String(item?.projectId || '').trim()
  if (projectId) return `project:${projectId}`
  return `session:${String(item?.sessionId || '')}`
}

/**
 * session 状态 -> item 状态映射；非终态且非 waiting_review 返回 null（item 保持原状）。
 */
export function mapSessionStatusToQueueItemStatus(sessionStatus) {
  const status = normalizeLegacySessionStatus(sessionStatus)
  switch (status) {
    case REASONING_SESSION_STATE.COMPLETED: return REASONING_QUEUE_ITEM_STATE.COMPLETED
    case REASONING_SESSION_STATE.FAILED: return REASONING_QUEUE_ITEM_STATE.FAILED
    case REASONING_SESSION_STATE.CANCELLED: return REASONING_QUEUE_ITEM_STATE.CANCELLED
    case REASONING_SESSION_STATE.TIMEOUT: return REASONING_QUEUE_ITEM_STATE.TIMEOUT
    case REASONING_SESSION_STATE.BLOCKED: return REASONING_QUEUE_ITEM_STATE.BLOCKED
    case REASONING_SESSION_STATE.WAITING_REVIEW: return REASONING_QUEUE_ITEM_STATE.WAITING_REVIEW
    default: return null
  }
}

function appendItemHistory(item, to, reason, now, workerId = null) {
  const history = Array.isArray(item.history) ? [...item.history] : []
  history.push({
    from: item.status || null,
    to,
    reason: String(reason || ''),
    workerId,
    at: now
  })
  return history.slice(-MAX_ITEM_HISTORY_ENTRIES)
}

/**
 * 原子写 queue item（tmp + rename），崩溃不留半截文件。
 */
export function writeQueueItem(item) {
  const dir = ensureQueueDir()
  const filePath = path.join(dir, `${item.sessionId}.json`)
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmpPath, JSON.stringify(item, null, 2), 'utf8')
  fs.renameSync(tmpPath, filePath)
  return item
}

export function readQueueItem(sessionId) {
  const filePath = getQueueItemFilePath(sessionId)
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 列出全部 queue item；损坏文件跳过并计入 errors（不猜测内容）。
 */
export function listQueueItems() {
  const dir = getQueueDir()
  const result = { items: [], errors: [] }
  if (!fs.existsSync(dir)) return result
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return result
  }
  for (const file of files) {
    const filePath = path.join(dir, file)
    try {
      const item = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (!item?.sessionId) {
        result.errors.push({ file, error: 'queue_item_missing_session_id' })
        continue
      }
      result.items.push(item)
    } catch (error) {
      result.errors.push({ file, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

/**
 * read-modify-write（同步 fs，进程内互斥）；item 不存在抛 queue_item_not_found。
 */
export function updateQueueItem(sessionId, updater) {
  const current = readQueueItem(sessionId)
  if (!current) throw new Error('queue_item_not_found')
  const next = updater(current)
  next.updatedAt = new Date().toISOString()
  return writeQueueItem(next)
}

/**
 * 入队（幂等）：同一 session 已有未终结 item 时直接返回现有 item，不重复入队。
 * 已终结 item 不重建（session 与 item 一一对应，终结即证据保留）。
 * 损坏的 item 文件先改名留证再新建，不静默覆盖。
 */
export function enqueueQueueItem({ sessionId, projectId = null, taskId = null, nowFn = () => new Date().toISOString() } = {}) {
  if (!sessionId) throw new Error('queue_enqueue_requires_session_id')
  const now = nowFn()
  const existingPath = getQueueItemFilePath(sessionId)
  if (fs.existsSync(existingPath)) {
    const existing = readQueueItem(sessionId)
    if (existing) {
      return { created: false, terminal: isTerminalQueueItemState(existing.status), item: existing }
    }
    try {
      fs.renameSync(existingPath, `${existingPath}.corrupt-${Date.now()}`)
    } catch {
      // 留证失败不阻断入队
    }
  }
  const item = {
    version: '1',
    taskId: String(taskId || sessionId),
    sessionId: String(sessionId),
    projectId: String(projectId || '').trim() || null,
    status: REASONING_QUEUE_ITEM_STATE.QUEUED,
    claim: { workerId: null, claimedAt: null, claimGeneration: 0 },
    attempts: 0,
    recoveryCount: 0,
    resumeFromStep: null,
    lastError: null,
    // AUTO-C02：重试元数据——retryCount 已调度的重试次数（不含首次执行），
    // nextAttemptAt 到点前不可被领取，retryHistory 记录每次重试的原因与时间
    retryCount: 0,
    nextAttemptAt: null,
    retryHistory: [],
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    history: [{ from: null, to: REASONING_QUEUE_ITEM_STATE.QUEUED, reason: 'enqueued', workerId: null, at: now }]
  }
  writeQueueItem(item)
  return { created: true, terminal: false, item }
}

/**
 * 领取（原子、可持久化验证）：仅 queued 可领取；写入 workerId + claimedAt +
 * 单调递增 claimGeneration。同步 fs 保证进程内 check-write 不交错；
 * 重启后旧 workerId 的 claim 由启动恢复先收敛，不会被新 worker 直接接着跑。
 */
export function claimQueueItem(sessionId, { workerId, nowFn = () => new Date().toISOString() } = {}) {
  if (!workerId) throw new Error('queue_claim_requires_worker_id')
  const now = nowFn()
  const item = readQueueItem(sessionId)
  if (!item) return { claimed: false, reason: 'queue_item_not_found', item: null }
  if (item.status !== REASONING_QUEUE_ITEM_STATE.QUEUED) {
    return { claimed: false, reason: `not_queued:${item.status}`, item }
  }
  const claimGeneration = Number(item.claim?.claimGeneration || 0) + 1
  const claimed = {
    ...item,
    status: REASONING_QUEUE_ITEM_STATE.CLAIMED,
    claim: { workerId: String(workerId), claimedAt: now, claimGeneration },
    attempts: Number(item.attempts || 0) + 1,
    // AUTO-C02：领取即消费本次重试窗口，清空 nextAttemptAt（重试元数据保留在 retryCount/retryHistory）
    nextAttemptAt: null,
    updatedAt: now,
    history: appendItemHistory(item, REASONING_QUEUE_ITEM_STATE.CLAIMED, `claimed_by:${workerId}`, now, workerId)
  }
  writeQueueItem(claimed)
  return { claimed: true, item: claimed }
}

/**
 * 调度选择（纯函数）：FIFO（createdAt 升序，sessionId 兜底），
 * 同 projectKey 同时最多 1 个在执行，全局受 maxConcurrency 限制。
 * activeProjectKeys/activeCount 为当前已在执行的槽位快照。
 * AUTO-C02：nextAttemptAt 未到点的 retry_wait item 不参与领取（到点后恢复可领取）。
 */
export function selectClaimableQueueItems(items, { activeProjectKeys = new Set(), activeCount = 0, maxConcurrency, nowMs } = {}) {
  const limit = Math.max(1, Number(maxConcurrency) || DEFAULT_MAX_CONCURRENCY)
  const slotsLeft = Math.max(0, limit - Math.max(0, Number(activeCount) || 0))
  if (slotsLeft === 0) return []
  const nowMsValue = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  const busy = new Set(activeProjectKeys)
  const candidates = (Array.isArray(items) ? items : [])
    .filter((item) => {
      if (item?.status !== REASONING_QUEUE_ITEM_STATE.QUEUED) return false
      const nextAttemptAtMs = Date.parse(String(item?.nextAttemptAt || ''))
      if (Number.isFinite(nextAttemptAtMs) && nextAttemptAtMs > nowMsValue) return false
      return true
    })
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.sessionId).localeCompare(String(b.sessionId)))
  const picked = []
  for (const item of candidates) {
    if (picked.length >= slotsLeft) break
    const key = resolveQueueProjectKey(item)
    if (busy.has(key)) continue
    busy.add(key)
    picked.push(item)
  }
  return picked
}

// ---------------------------------------------------------------------------
// AUTO-F01：多项目隔离——projectId 回写与每项目在制配额
// ---------------------------------------------------------------------------

/**
 * projectId 回写（补 C01 窗口）：story 类 session 创建时项目尚未生成，item 以
 * projectId=null 入队；项目创建/定位成功后由核心侧回写。仅当 item 存在、未终结
 * 且 projectId 为空时写入；已终结或已有 projectId 的 item 不覆盖（证据不可篡改）。
 * 返回 { updated, item }；item 不存在时 { updated: false, item: null }。
 */
export function backfillQueueItemProjectId(sessionId, projectId, { nowFn = () => new Date().toISOString() } = {}) {
  const target = String(projectId || '').trim()
  if (!sessionId || !target) return { updated: false, item: null }
  const item = readQueueItem(sessionId)
  if (!item) return { updated: false, item: null }
  if (isTerminalQueueItemState(item.status) || String(item.projectId || '').trim()) {
    return { updated: false, item }
  }
  const now = nowFn()
  const next = updateQueueItem(sessionId, (current) => ({
    ...current,
    projectId: target,
    updatedAt: now,
    history: appendItemHistory(current, current.status, `project_id_backfilled:${target}`, now, current.claim?.workerId || null)
  }))
  return { updated: true, item: next }
}

/**
 * 统计同一 projectId 的调度中任务（queued/claimed/running）。
 * waiting_review 与终态已释放槽位，不计入（人工可能永远不审，不允许占配额造成死锁）。
 */
export function countActiveQueueItemsForProject(projectId, { excludeSessionId = null } = {}) {
  const target = String(projectId || '').trim()
  if (!target) return { activeCount: 0, activeSessionIds: [] }
  const { items } = listQueueItems()
  const active = items.filter((item) =>
    String(item?.projectId || '').trim() === target
    && item.sessionId !== excludeSessionId
    && !isReleasedQueueItemState(item.status))
  return { activeCount: active.length, activeSessionIds: active.map((item) => item.sessionId) }
}

/**
 * 每项目在制配额判定（纯函数）：同一 projectId 的调度中任务数达到上限时拒绝新任务。
 * 返回 { ok, limit, activeCount, activeSessionIds, error }；
 * error 为 'project_quota_exceeded' 时调用方必须拒绝并透传用量证据。
 */
export function evaluateProjectQuota({ projectId, excludeSessionId = null, maxPerProject } = {}) {
  const target = String(projectId || '').trim()
  const limit = resolveQueueMaxTasksPerProject(maxPerProject)
  if (!target) return { ok: true, limit, activeCount: 0, activeSessionIds: [], error: null }
  const { activeCount, activeSessionIds } = countActiveQueueItemsForProject(target, { excludeSessionId })
  if (activeCount >= limit) {
    return { ok: false, limit, activeCount, activeSessionIds, error: 'project_quota_exceeded' }
  }
  return { ok: true, limit, activeCount, activeSessionIds, error: null }
}

// ---------------------------------------------------------------------------
// 启动恢复（S2-10）
// ---------------------------------------------------------------------------

function markQueueItemTerminal(item, to, reason, nowFn, extra = {}) {
  const now = nowFn()
  return updateQueueItem(item.sessionId, (current) => ({
    ...current,
    ...extra,
    status: to,
    lastError: extra.lastError !== undefined ? extra.lastError : current.lastError,
    finishedAt: now,
    updatedAt: now,
    history: appendItemHistory(current, to, reason, now, current.claim?.workerId || null)
  }))
}

function requeueQueueItem(item, { resumeFromStep, reason, nowFn }) {
  const now = nowFn()
  return updateQueueItem(item.sessionId, (current) => ({
    ...current,
    status: REASONING_QUEUE_ITEM_STATE.QUEUED,
    // claimGeneration 保持单调递增不重置：旧 worker 的 claim 永远失效
    claim: { workerId: null, claimedAt: null, claimGeneration: Number(current.claim?.claimGeneration || 0) },
    recoveryCount: Number(current.recoveryCount || 0) + 1,
    resumeFromStep: Number.isInteger(resumeFromStep) ? resumeFromStep : null,
    lastError: null,
    startedAt: null,
    updatedAt: now,
    history: appendItemHistory(current, REASONING_QUEUE_ITEM_STATE.QUEUED, reason, now, current.claim?.workerId || null)
  }))
}

/**
 * 服务重启后的队列恢复扫描。对每个未终结 item：
 * - session 缺失 -> item blocked（明确阻断，不猜测）；
 * - session 终态 / failed -> item 镜像终结（不重复领取、不重复执行）；
 * - session queued（从未开始或死于 plan 阶段）-> item 重置为 queued 从头跑（plan 幂等）；
 * - session waiting_review -> item 释放为 waiting_review（人工在环，不动 session）；
 * - session 其他非终结状态 -> 按 B03 orphan 语义先收敛为 orphaned；
 *   其中从 waiting_review 收敛来的不自动重排队（审核门禁不可绕过）；
 *   其余评估恢复资格：证据完整 -> 重新入队（resumeFromStep=checkpoint.nextStepIndex，
 *   已成功 step 不重跑），证据不足 -> session 转 blocked，item blocked。
 *
 * 返回 summary（含 managedSessionIds：调用方应让 B03 orphan 扫描跳过这些 session，
 * 由本恢复流程全权收敛，避免 queued 等待中的 session 被误判 orphan -> blocked）。
 */
export function recoverPersistentQueueOnStartup({
  readSession,
  updateSession,
  appendEvent = () => {},
  nowFn = () => new Date().toISOString(),
  maxRecoveryCount
} = {}) {
  if (typeof readSession !== 'function') throw new Error('queue_recovery_requires_readSession')
  if (typeof updateSession !== 'function') throw new Error('queue_recovery_requires_updateSession')

  const summary = {
    scanned: 0,
    keptQueued: 0,
    requeued: 0,
    mirroredTerminal: 0,
    releasedWaitingReview: 0,
    blocked: 0,
    errors: [],
    managedSessionIds: new Set()
  }
  const { items, errors } = listQueueItems()
  for (const entry of errors) {
    summary.errors.push({ file: entry.file, error: entry.error })
  }

  for (const item of items) {
    if (isTerminalQueueItemState(item.status)) continue
    summary.managedSessionIds.add(item.sessionId)
    summary.scanned += 1
    try {
      recoverOneQueueItem(item, { readSession, updateSession, appendEvent, nowFn, maxRecoveryCount, summary })
    } catch (error) {
      summary.errors.push({ sessionId: item.sessionId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return summary
}

function recoverOneQueueItem(item, { readSession, updateSession, appendEvent, nowFn, maxRecoveryCount, summary }) {
  const session = readSession(item.sessionId)
  if (!session) {
    markQueueItemTerminal(item, REASONING_QUEUE_ITEM_STATE.BLOCKED, 'queue_session_missing', nowFn, { lastError: 'queue_session_missing' })
    summary.blocked += 1
    return
  }

  const status = normalizeLegacySessionStatus(session.status)
  // 终态与 failed（有失败证据与 retry 路径，B03 同样不触碰）：镜像终结，不重复领取
  if (isTerminalSessionState(status) || status === REASONING_SESSION_STATE.FAILED) {
    const mapped = mapSessionStatusToQueueItemStatus(status)
    markQueueItemTerminal(item, mapped, `queue_mirror_session_${status}`, nowFn)
    summary.mirroredTerminal += 1
    return
  }

  // 从未开始或死于 plan 阶段：plan 幂等无副作用，直接重新排队从头跑
  if (status === REASONING_SESSION_STATE.QUEUED) {
    if (item.status === REASONING_QUEUE_ITEM_STATE.QUEUED) {
      summary.keptQueued += 1
    } else {
      requeueQueueItem(item, { resumeFromStep: null, reason: 'queue_restart_before_start', nowFn })
      summary.requeued += 1
    }
    return
  }

  // 人工审核等待：释放槽位，session 保持等待人工，不触碰
  if (status === REASONING_SESSION_STATE.WAITING_REVIEW) {
    releaseQueueItemToWaitingReview(item, 'queue_restart_while_waiting_review', nowFn)
    summary.releasedWaitingReview += 1
    return
  }

  // AUTO-C02：retry_wait 是队列管理内的等待重试状态（item queued + nextAttemptAt），
  // 重启不收敛 orphan、不清空重试计划；仅重置可能残留的 stale claim，到点后正常领取
  if (status === REASONING_SESSION_STATE.RETRY_WAIT) {
    if (item.status === REASONING_QUEUE_ITEM_STATE.QUEUED) {
      summary.keptQueued += 1
    } else {
      resetQueueItemToRetryWait(item, 'queue_restart_while_retry_wait', nowFn)
      summary.requeued += 1
    }
    return
  }

  // running/paused/pausing/resuming/retry_wait/orphaned：worker 已死，按 B03 orphan 语义先收敛
  let current = session
  if (status !== REASONING_SESSION_STATE.ORPHANED) {
    current = updateSession(item.sessionId, (latest) => buildOrphanedTransition(latest, ORPHAN_REASON_SERVER_RESTART, nowFn()))
    appendEvent(
      item.sessionId,
      'session_orphaned',
      'session 被判定为孤儿',
      '服务重启时本 session 仍为非终结状态，已收敛为 orphaned，等待恢复资格评估。',
      { data: { reason: ORPHAN_REASON_SERVER_RESTART, fromStatus: status, source: 'queue_recovery' } }
    )
  }

  // 从 waiting_review 收敛来的 orphan：人工审核门禁不可绕过，不自动重排队
  const transitions = Array.isArray(current.stateTransitions) ? current.stateTransitions : []
  const lastTransition = transitions[transitions.length - 1] || null
  if (lastTransition?.to === REASONING_SESSION_STATE.ORPHANED && lastTransition?.from === REASONING_SESSION_STATE.WAITING_REVIEW) {
    releaseQueueItemToWaitingReview(item, 'queue_orphaned_from_waiting_review', nowFn)
    summary.releasedWaitingReview += 1
    return
  }

  const qualification = evaluateOrphanRecovery(current, { maxRecoveryCount })
  if (qualification.recoverable) {
    requeueQueueItem(item, { resumeFromStep: qualification.nextStepIndex, reason: 'queue_restart_recover_orphan', nowFn })
    appendEvent(
      item.sessionId,
      'queue_requeued',
      '任务已重新排队',
      `服务重启后恢复调度：将从 checkpoint 的 nextStepIndex=${qualification.nextStepIndex} 继续，已成功 step 不重跑。`,
      {
        data: {
          taskId: item.taskId,
          projectId: item.projectId || null,
          resumeFromStep: qualification.nextStepIndex,
          checkpointStepIndex: qualification.checkpointStepIndex,
          recoveryCount: Number(item.recoveryCount || 0) + 1
        }
      }
    )
    summary.requeued += 1
    return
  }

  updateSession(item.sessionId, (latest) => buildOrphanBlockedTransition(latest, qualification, nowFn()))
  appendEvent(
    item.sessionId,
    'session_orphan_blocked',
    'orphan 不可恢复，已阻断',
    qualification.detail,
    { data: { reason: qualification.reason, source: 'queue_recovery' } }
  )
  markQueueItemTerminal(item, REASONING_QUEUE_ITEM_STATE.BLOCKED, qualification.reason, nowFn, { lastError: qualification.reason })
  summary.blocked += 1
}

// ---------------------------------------------------------------------------
// AUTO-D01：人工重试（Console 运维动作）
// ---------------------------------------------------------------------------

/**
 * 人工重试重置（受控 API 专用）：仅终态 item 可重置回 queued 等待重新领取。
 * - 人工重试是显式动作，与 C02 自动重试语义区分：清空退避窗口（nextAttemptAt）
 *   并重置 retryCount，本次执行再失败时按 retryPolicy 重新获得完整自动重试预算；
 *   retryHistory 保留（历史证据不抹除）。
 * - 非终态 item 拒绝（queue_item_not_terminal:<status>），避免与 worker 并发执行冲突；
 *   item 不存在抛 queue_item_not_found。
 * - 调用方必须先完成 session 状态转移（failed -> queued）再调用本函数：
 *   反向顺序会让 worker tick 把 queued item 按 failed session 镜像终结。
 */
export function resetQueueItemForManualRetry(sessionId, { reason = 'manual_retry', nowFn = () => new Date().toISOString() } = {}) {
  const item = readQueueItem(sessionId)
  if (!item) throw new Error('queue_item_not_found')
  if (!isTerminalQueueItemState(item.status)) {
    throw new Error(`queue_item_not_terminal:${item.status}`)
  }
  const now = nowFn()
  return updateQueueItem(sessionId, (current) => ({
    ...current,
    status: REASONING_QUEUE_ITEM_STATE.QUEUED,
    // claimGeneration 保持单调递增不重置：旧 worker 的 claim 永远失效
    claim: { workerId: null, claimedAt: null, claimGeneration: Number(current.claim?.claimGeneration || 0) },
    retryCount: 0,
    nextAttemptAt: null,
    lastError: null,
    resumeFromStep: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    history: appendItemHistory(current, REASONING_QUEUE_ITEM_STATE.QUEUED, reason, now, current.claim?.workerId || null)
  }))
}

function releaseQueueItemToWaitingReview(item, reason, nowFn) {
  const now = nowFn()
  updateQueueItem(item.sessionId, (current) => ({
    ...current,
    status: REASONING_QUEUE_ITEM_STATE.WAITING_REVIEW,
    claim: { workerId: null, claimedAt: null, claimGeneration: Number(current.claim?.claimGeneration || 0) },
    updatedAt: now,
    history: appendItemHistory(current, REASONING_QUEUE_ITEM_STATE.WAITING_REVIEW, reason, now, current.claim?.workerId || null)
  }))
}

// AUTO-C02：重启时 item 处于 claimed/running 但 session 在 retry_wait（崩溃在领取与执行之间）：
// 重置回 queued 等待到点领取，保留 retryCount/nextAttemptAt/retryHistory 重试计划，
// 不计 recoveryCount（非 orphan 恢复，不消耗 orphan 恢复预算）
function resetQueueItemToRetryWait(item, reason, nowFn) {
  const now = nowFn()
  updateQueueItem(item.sessionId, (current) => ({
    ...current,
    status: REASONING_QUEUE_ITEM_STATE.QUEUED,
    claim: { workerId: null, claimedAt: null, claimGeneration: Number(current.claim?.claimGeneration || 0) },
    startedAt: null,
    updatedAt: now,
    history: appendItemHistory(current, REASONING_QUEUE_ITEM_STATE.QUEUED, reason, now, current.claim?.workerId || null)
  }))
}

// ---------------------------------------------------------------------------
// worker / 调度器
// ---------------------------------------------------------------------------

/**
 * 创建队列 worker（依赖全注入，便于测试隔离）。
 * - readSession(sessionId) -> session | null
 * - executeItem(item) -> Promise：执行一个已领取 item（核心侧走既有执行链，
 *   含 B04 deadline/cancel）；正常实现内部自捕获异常（markReasoningSessionFailed），
 *   reject 仅作兜底——worker 会将 item 终结为 failed 并释放槽位。
 * - appendEvent(sessionId, type, title, summary, extra)：队列事件挂 session 事件流
 * - canExecute() -> boolean：领取门禁（如模型未就绪时保持 queued 等待，不失败任务）
 * - claimGate(item) -> { ok, reason? }：可选，AUTO-R01 单 item 领取前二次门禁
 *   （如资源互斥：llm 类任务在出图占用期跳过领取保持 queued，不动用 retry 预算）；
 *   返回 ok:false 时本轮跳过该 item，不失败、不占槽；抛异常按放行处理并记日志（不阻断既有调度）
 * - onHeartbeatScan：可选，挂心跳过期扫描（B03 遗留增强），由调用方实现扫描语义
 * - updateSession：可选，AUTO-C02 重试调度需要（session failed -> retry_wait/blocked）；
 *   缺失时重试能力降级，失败一律按既有语义终结 failed
 * - retryMaxAttempts/retryBaseMs/retryMaxDelayMs：可选，AUTO-C02 重试上限与退避参数，
 *   默认取 HERMES_REASONING_RETRY_* env / retryPolicy 默认值
 */
export function createReasoningQueueWorker({
  workerId,
  maxConcurrency,
  tickMs,
  heartbeatScanIntervalMs = 0,
  readSession,
  executeItem,
  appendEvent = () => {},
  canExecute = () => true,
  claimGate = null,
  onHeartbeatScan = null,
  updateSession = null,
  retryMaxAttempts,
  retryBaseMs,
  retryMaxDelayMs,
  logger = () => {},
  nowFn = () => new Date().toISOString()
} = {}) {
  if (!workerId) throw new Error('queue_worker_requires_worker_id')
  if (typeof readSession !== 'function') throw new Error('queue_worker_requires_readSession')
  if (typeof executeItem !== 'function') throw new Error('queue_worker_requires_executeItem')

  const limit = Math.max(1, Number(maxConcurrency) || DEFAULT_MAX_CONCURRENCY)
  const intervalMs = Math.max(1, Number(tickMs) || DEFAULT_TICK_MS)
  // AUTO-C02：重试上限与退避参数（创建时解析一次，运行期不随 env 漂移）
  const retryLimit = resolveRetryMaxAttempts(retryMaxAttempts)
  const retryBackoffBaseMs = resolveRetryBaseMs(retryBaseMs)
  const retryBackoffMaxMs = resolveRetryMaxDelayMs(retryMaxDelayMs)
  // 本会话 worker 持有中的执行槽位：sessionId -> { projectKey, claimGeneration }
  const active = new Map()
  let timer = null
  let heartbeatTimer = null
  let kickTimer = null
  let tickInFlight = false
  let stopped = true

  const safeAppendEvent = (sessionId, type, title, summary, extra = {}) => {
    try {
      appendEvent(sessionId, type, title, summary, extra)
    } catch (error) {
      logger(`[REASONING][QUEUE][EVENT][ERROR] sessionId=${sessionId} type=${type} detail=${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const safeReadSession = (sessionId) => {
    try {
      return readSession(sessionId)
    } catch {
      return null
    }
  }

  // 终结本会话持有的 item（claim 守卫：只终结自己领取的代数），释放槽位
  const finalizeHeldItem = (item, held, to, reason, lastError = null) => {
    const now = nowFn()
    try {
      updateQueueItem(item.sessionId, (current) => {
        if (current.claim?.workerId !== workerId || current.claim?.claimGeneration !== held.claimGeneration) {
          return current // claim 已被改写（如启动恢复重排队），不覆盖
        }
        return {
          ...current,
          status: to,
          lastError,
          finishedAt: now,
          updatedAt: now,
          history: appendItemHistory(current, to, reason, now, workerId)
        }
      })
    } catch (error) {
      logger(`[REASONING][QUEUE][FINALIZE][ERROR] sessionId=${item.sessionId} detail=${error instanceof Error ? error.message : String(error)}`)
    }
    active.delete(item.sessionId)
    safeAppendEvent(
      item.sessionId,
      'queue_finished',
      '队列任务已终结',
      `taskId=${item.taskId} 以 ${to} 终结，释放调度槽位。`,
      {
        data: {
          taskId: item.taskId,
          projectId: item.projectId || null,
          workerId,
          claimGeneration: held.claimGeneration,
          attempt: Number(item.attempts || 0),
          outcome: to,
          reason
        }
      }
    )
    scheduleKick()
  }

  // AUTO-C02：session artifacts 镜像重试计划/收敛记录（Console D01 可直接读取）
  const mirrorRetryPolicyToSession = (sessionId, patch) => {
    if (typeof updateSession !== 'function') return
    try {
      updateSession(sessionId, (current) => ({
        ...current,
        artifacts: {
          ...(current.artifacts || {}),
          retryPolicy: {
            ...(current.artifacts?.retryPolicy || {}),
            ...patch,
            updatedAt: nowFn()
          }
        }
      }))
    } catch (error) {
      logger(`[REASONING][QUEUE][RETRY][ERROR] sessionId=${sessionId} detail=${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // AUTO-C02：task 级失败的确定性收敛——分类为 retryable 且未达上限时：
  // item 回 queued 落 nextAttemptAt（指数退避），session failed -> retry_wait；
  // 达到上限稳定终结 failed；needs_review/blocked 类收敛 blocked；其余按原语义终结 failed。
  // 返回 true 表示本函数已处理（含重试调度），false 不会发生（兜底也走终结）。
  const settleHeldItemFailure = (item, held, reason, lastError = null) => {
    const session = safeReadSession(item.sessionId)
    const signals = extractFailureSignals(session)
    const classification = classifyReasoningFailure({
      ...signals,
      error: signals.error || lastError || reason
    })
    const errorDetail = String(signals.error || lastError || reason || '')
    const retryCount = Number(item.retryCount || 0)
    const now = nowFn()

    // 1. 可重试且未达上限：调度重试（仅当 session 确在 failed——并发取消/终结时不抢状态）
    const canScheduleRetry = classification.category === REASONING_RETRY_CATEGORY.RETRYABLE
      && retryCount < retryLimit
      && typeof updateSession === 'function'
      && session
      && normalizeLegacySessionStatus(session.status) === REASONING_SESSION_STATE.FAILED
    if (canScheduleRetry) {
      const attempt = retryCount + 1
      const backoffMs = computeRetryBackoffMs(attempt, { baseMs: retryBackoffBaseMs, maxDelayMs: retryBackoffMaxMs })
      const nextAttemptAt = new Date(Date.parse(now) + backoffMs).toISOString()
      let requeued = false
      try {
        updateQueueItem(item.sessionId, (current) => {
          if (current.claim?.workerId !== workerId || current.claim?.claimGeneration !== held.claimGeneration) {
            return current // claim 已被改写，不覆盖
          }
          requeued = true
          const retryHistory = [
            ...(Array.isArray(current.retryHistory) ? current.retryHistory : []),
            {
              attempt,
              scheduledAt: now,
              nextAttemptAt,
              backoffMs,
              category: classification.category,
              rule: classification.rule,
              reason: classification.reason,
              error: errorDetail
            }
          ].slice(-MAX_ITEM_RETRY_HISTORY_ENTRIES)
          return {
            ...current,
            status: REASONING_QUEUE_ITEM_STATE.QUEUED,
            // claimGeneration 保持单调递增不重置：旧 claim 永远失效
            claim: { workerId: null, claimedAt: null, claimGeneration: Number(current.claim?.claimGeneration || 0) },
            retryCount: attempt,
            nextAttemptAt,
            lastError: errorDetail,
            retryHistory,
            finishedAt: null,
            updatedAt: now,
            history: appendItemHistory(current, REASONING_QUEUE_ITEM_STATE.QUEUED, `retry_scheduled:${classification.rule}`, now, workerId)
          }
        })
      } catch (error) {
        logger(`[REASONING][QUEUE][RETRY][ERROR] sessionId=${item.sessionId} detail=${error instanceof Error ? error.message : String(error)}`)
      }
      if (requeued) {
        // 2. session failed -> retry_wait（updater 内对最新状态幂等：已被取消/推进则不覆盖）
        let transitioned = false
        try {
          updateSession(item.sessionId, (current) => {
            if (normalizeLegacySessionStatus(current?.status) !== REASONING_SESSION_STATE.FAILED) return current
            const next = applySessionTransition(current, REASONING_SESSION_STATE.RETRY_WAIT, `queue retry #${attempt}/${retryLimit}: ${classification.reason}`)
            transitioned = true
            return {
              ...next,
              artifacts: {
                ...(next.artifacts || {}),
                retryPolicy: {
                  ...(current.artifacts?.retryPolicy || {}),
                  retryCount: attempt,
                  maxAttempts: retryLimit,
                  nextAttemptAt,
                  lastError: errorDetail,
                  lastClassification: { category: classification.category, rule: classification.rule, reason: classification.reason },
                  history: [
                    ...(Array.isArray(current.artifacts?.retryPolicy?.history) ? current.artifacts.retryPolicy.history : []),
                    { attempt, scheduledAt: now, nextAttemptAt, backoffMs, rule: classification.rule, reason: classification.reason, error: errorDetail }
                  ].slice(-MAX_ITEM_RETRY_HISTORY_ENTRIES),
                  updatedAt: now
                }
              }
            }
          })
        } catch (error) {
          logger(`[REASONING][QUEUE][RETRY][ERROR] sessionId=${item.sessionId} detail=${error instanceof Error ? error.message : String(error)}`)
          transitioned = false
        }
        active.delete(item.sessionId)
        if (transitioned) {
          safeAppendEvent(
            item.sessionId,
            'queue_retry_scheduled',
            '任务进入重试等待',
            `taskId=${item.taskId} 分类为可重试（${classification.rule}），第 ${attempt}/${retryLimit} 次重试将于 ${nextAttemptAt} 执行（退避 ${backoffMs}ms）。`,
            {
              data: {
                taskId: item.taskId,
                projectId: item.projectId || null,
                workerId,
                claimGeneration: held.claimGeneration,
                retryCount: attempt,
                maxAttempts: retryLimit,
                backoffMs,
                nextAttemptAt,
                classification: { category: classification.category, rule: classification.rule, reason: classification.reason },
                error: errorDetail
              }
            }
          )
          logger(`[REASONING][QUEUE][RETRY] sessionId=${item.sessionId} taskId=${item.taskId} attempt=${attempt}/${retryLimit} backoffMs=${backoffMs} nextAttemptAt=${nextAttemptAt} rule=${classification.rule}`)
        }
        // session 已被并发推进（如取消）：item 保持 queued，由 tick 第 2 段镜像终态，绝不强行调度
        scheduleKick()
        return true
      }
    }

    // 2. 达到重试上限：稳定终结 failed，记录每次原因与时间（retryHistory 已在各次调度时落盘）
    if (classification.category === REASONING_RETRY_CATEGORY.RETRYABLE && retryCount >= retryLimit) {
      mirrorRetryPolicyToSession(item.sessionId, {
        exhausted: true,
        exhaustedAt: now,
        retryCount,
        maxAttempts: retryLimit,
        lastError: errorDetail,
        lastClassification: { category: classification.category, rule: classification.rule, reason: classification.reason }
      })
      safeAppendEvent(
        item.sessionId,
        'queue_retry_exhausted',
        '重试次数已达上限，任务失败',
        `taskId=${item.taskId} 已重试 ${retryCount}/${retryLimit} 次仍为临时故障（${classification.rule}），收敛为 failed。`,
        {
          data: {
            taskId: item.taskId,
            projectId: item.projectId || null,
            workerId,
            retryCount,
            maxAttempts: retryLimit,
            classification: { category: classification.category, rule: classification.rule, reason: classification.reason },
            error: errorDetail
          }
        }
      )
      logger(`[REASONING][QUEUE][RETRY][EXHAUSTED] sessionId=${item.sessionId} taskId=${item.taskId} retryCount=${retryCount}/${retryLimit} rule=${classification.rule}`)
      finalizeHeldItem(item, held, REASONING_QUEUE_ITEM_STATE.FAILED, 'queue_retry_exhausted', errorDetail)
      return true
    }

    // 3. 审核类/阻断类：session failed -> blocked（需人工处理），item 终结 blocked
    if (classification.category === REASONING_RETRY_CATEGORY.NEEDS_REVIEW || classification.category === REASONING_RETRY_CATEGORY.BLOCKED) {
      let blocked = false
      if (typeof updateSession === 'function' && session && normalizeLegacySessionStatus(session.status) === REASONING_SESSION_STATE.FAILED) {
        try {
          updateSession(item.sessionId, (current) => {
            if (normalizeLegacySessionStatus(current?.status) !== REASONING_SESSION_STATE.FAILED) return current
            blocked = true
            return applySessionTransition(current, REASONING_SESSION_STATE.BLOCKED, `queue ${classification.category}: ${classification.reason}`)
          })
        } catch (error) {
          logger(`[REASONING][QUEUE][BLOCK][ERROR] sessionId=${item.sessionId} detail=${error instanceof Error ? error.message : String(error)}`)
          blocked = false
        }
      }
      if (blocked) {
        safeAppendEvent(
          item.sessionId,
          'queue_blocked_needs_review',
          '任务需人工处理，已阻断',
          `taskId=${item.taskId} 分类为 ${classification.category}（${classification.rule}）：${classification.reason}`,
          {
            data: {
              taskId: item.taskId,
              projectId: item.projectId || null,
              workerId,
              classification: { category: classification.category, rule: classification.rule, reason: classification.reason },
              error: errorDetail
            }
          }
        )
        finalizeHeldItem(item, held, REASONING_QUEUE_ITEM_STATE.BLOCKED, `queue_${classification.category}:${classification.rule}`, errorDetail)
        return true
      }
      // session 状态不允许转移（并发取消等）：回退按原语义终结 failed
    }

    // 4. 非重试错误：按原语义终结 failed（reason/lastError 透传，不覆盖既有行为）
    finalizeHeldItem(item, held, REASONING_QUEUE_ITEM_STATE.FAILED, reason, lastError)
    return true
  }

  const releaseHeldItemToWaitingReview = (item, held) => {
    const now = nowFn()
    try {
      updateQueueItem(item.sessionId, (current) => {
        if (current.claim?.workerId !== workerId || current.claim?.claimGeneration !== held.claimGeneration) {
          return current
        }
        return {
          ...current,
          status: REASONING_QUEUE_ITEM_STATE.WAITING_REVIEW,
          claim: { workerId: null, claimedAt: null, claimGeneration: Number(current.claim?.claimGeneration || 0) },
          updatedAt: now,
          history: appendItemHistory(current, REASONING_QUEUE_ITEM_STATE.WAITING_REVIEW, 'queue_waiting_human_review', now, workerId)
        }
      })
    } catch (error) {
      logger(`[REASONING][QUEUE][RELEASE][ERROR] sessionId=${item.sessionId} detail=${error instanceof Error ? error.message : String(error)}`)
    }
    active.delete(item.sessionId)
    safeAppendEvent(
      item.sessionId,
      'queue_waiting_review',
      '等待人工审核，释放调度槽位',
      `taskId=${item.taskId} 进入人工审核等待，调度槽位已释放；审核后的继续执行由人工驱动。`,
      { data: { taskId: item.taskId, projectId: item.projectId || null, workerId, outcome: 'waiting_review' } }
    )
    scheduleKick()
  }

  // 镜像未领取 item 的 session 终态（等待期间被取消/删除等），不领取、不占槽
  const mirrorUnclaimedItem = (item, to, reason, lastError = null) => {
    const now = nowFn()
    try {
      updateQueueItem(item.sessionId, (current) => {
        if (current.status !== item.status) return current // 状态已被其他路径推进，不覆盖
        return {
          ...current,
          status: to,
          lastError,
          finishedAt: now,
          updatedAt: now,
          history: appendItemHistory(current, to, reason, now, null)
        }
      })
      safeAppendEvent(
        item.sessionId,
        'queue_finished',
        '队列任务已终结',
        `taskId=${item.taskId} 在领取前已以 ${to} 终结（${reason}）。`,
        { data: { taskId: item.taskId, projectId: item.projectId || null, workerId, outcome: to, reason } }
      )
    } catch (error) {
      logger(`[REASONING][QUEUE][MIRROR][ERROR] sessionId=${item.sessionId} detail=${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const claimAndExecute = (target) => {
    const claim = claimQueueItem(target.sessionId, { workerId, nowFn })
    if (!claim.claimed) return false
    const held = { projectKey: resolveQueueProjectKey(target), claimGeneration: claim.item.claim.claimGeneration }
    active.set(target.sessionId, held)
    const now = nowFn()
    let runningItem = claim.item
    try {
      runningItem = updateQueueItem(target.sessionId, (current) => {
        if (current.claim?.workerId !== workerId || current.claim?.claimGeneration !== held.claimGeneration) {
          return current
        }
        return {
          ...current,
          status: REASONING_QUEUE_ITEM_STATE.RUNNING,
          startedAt: current.startedAt || now,
          updatedAt: now,
          history: appendItemHistory(current, REASONING_QUEUE_ITEM_STATE.RUNNING, 'execution_started', now, workerId)
        }
      })
    } catch (error) {
      active.delete(target.sessionId)
      logger(`[REASONING][QUEUE][START][ERROR] sessionId=${target.sessionId} detail=${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    safeAppendEvent(
      target.sessionId,
      'queue_claimed',
      '任务已被领取执行',
      `taskId=${target.taskId} projectId=${target.projectId || '-'} worker=${workerId} 第 ${claim.item.attempts} 次领取。`,
      {
        data: {
          taskId: target.taskId,
          projectId: target.projectId || null,
          workerId,
          claimGeneration: held.claimGeneration,
          attempt: claim.item.attempts,
          resumeFromStep: runningItem.resumeFromStep ?? null
        }
      }
    )
    logger(`[REASONING][QUEUE][CLAIM] sessionId=${target.sessionId} taskId=${target.taskId} projectId=${target.projectId || '-'} workerId=${workerId} generation=${held.claimGeneration} attempt=${claim.item.attempts}`)
    void Promise.resolve()
      .then(() => executeItem(runningItem))
      .catch((error) => {
        // 兜底：正常实现内部自捕获异常；走到这里说明执行链未收敛 session，
        // worker 直接将 item 终结为 failed 并释放槽位，不阻塞后续任务
        const detail = error instanceof Error ? error.message : String(error)
        logger(`[REASONING][QUEUE][EXECUTE][ERROR] sessionId=${target.sessionId} detail=${detail}`)
        const heldNow = active.get(target.sessionId)
        if (heldNow) {
          // AUTO-C02：执行链未自捕获的兜底失败同样过错误分类（多为链路透出的临时故障）
          settleHeldItemFailure(target, heldNow, 'queue_execute_rejected', detail)
        }
      })
      .finally(() => {
        scheduleKick()
      })
    return true
  }

  const tick = () => {
    // 不设 stopped 门禁：手动 tick() 是测试与运维的显式驱动入口；
    // start/stop 只管定时器与 kick，stop 后不会再有自动 tick
    if (tickInFlight) return
    tickInFlight = true
    try {
      const { items, errors } = listQueueItems()
      for (const entry of errors) {
        logger(`[REASONING][QUEUE][SCAN][ERROR] file=${entry.file} detail=${entry.error}`)
      }
      const byId = new Map(items.map((item) => [item.sessionId, item]))

      // 1.  reconcile 本会话持有的执行槽位：以 session 状态为准收敛 item
      for (const [sessionId, held] of [...active.entries()]) {
        const item = byId.get(sessionId)
        if (!item) {
          active.delete(sessionId) // item 文件丢失：保守释放槽位
          continue
        }
        if (item.claim?.workerId !== workerId || item.claim?.claimGeneration !== held.claimGeneration) {
          active.delete(sessionId) // claim 已被改写（如恢复重排队），放弃内存持有
          continue
        }
        if (item.status !== REASONING_QUEUE_ITEM_STATE.CLAIMED && item.status !== REASONING_QUEUE_ITEM_STATE.RUNNING) {
          active.delete(sessionId) // 已被外部路径终结
          continue
        }
        const session = safeReadSession(sessionId)
        if (!session) {
          finalizeHeldItem(item, held, REASONING_QUEUE_ITEM_STATE.BLOCKED, 'queue_session_missing', 'queue_session_missing')
          continue
        }
        const mapped = mapSessionStatusToQueueItemStatus(session.status)
        if (mapped === REASONING_QUEUE_ITEM_STATE.FAILED) {
          // AUTO-C02：session 失败先过错误分类——可重试转 retry_wait 退避调度，
          // 达上限/非重试/审核类分别收敛 failed/blocked
          settleHeldItemFailure(item, held, `queue_mirror_session_${normalizeLegacySessionStatus(session.status)}`)
          continue
        }
        if (mapped && isTerminalQueueItemState(mapped)) {
          finalizeHeldItem(item, held, mapped, `queue_mirror_session_${normalizeLegacySessionStatus(session.status)}`)
          continue
        }
        if (mapped === REASONING_QUEUE_ITEM_STATE.WAITING_REVIEW) {
          releaseHeldItemToWaitingReview(item, held)
          continue
        }
        // 其余（含重规划/质量门禁派生的后台继续执行）：保持持有，由后续 tick 跟进
      }

      // 2. 未领取的 queued / 已释放的 waiting_review item：session 已终结或缺失时镜像，不领取
      for (const item of items) {
        if (item.status === REASONING_QUEUE_ITEM_STATE.QUEUED) {
          const session = safeReadSession(item.sessionId)
          if (!session) {
            mirrorUnclaimedItem(item, REASONING_QUEUE_ITEM_STATE.BLOCKED, 'queue_session_missing', 'queue_session_missing')
            continue
          }
          const mapped = mapSessionStatusToQueueItemStatus(session.status)
          if (mapped && isTerminalQueueItemState(mapped)) {
            mirrorUnclaimedItem(item, mapped, `queue_mirror_session_${normalizeLegacySessionStatus(session.status)}`)
          }
          continue
        }
        if (item.status === REASONING_QUEUE_ITEM_STATE.WAITING_REVIEW) {
          const session = safeReadSession(item.sessionId)
          if (!session) continue // 人工审核中的 session 缺失不猜测（保留 item 证据）
          const mapped = mapSessionStatusToQueueItemStatus(session.status)
          if (mapped && isTerminalQueueItemState(mapped)) {
            mirrorUnclaimedItem(item, mapped, `queue_mirror_session_${normalizeLegacySessionStatus(session.status)}`)
          }
        }
      }

      // 3. 领取新任务：模型未就绪（canExecute=false）时保持 queued 等待，不失败任务；
      //    AUTO-C02：nextAttemptAt 未到点的 retry_wait item 由 selectClaimableQueueItems 排除；
      //    AUTO-R01：claimGate 单 item 二次门禁（如 llm 任务在出图占用期跳过领取保持 queued）
      if (canExecute()) {
        const fresh = listQueueItems().items
        const activeProjectKeys = new Set([...active.values()].map((held) => held.projectKey))
        const claimable = selectClaimableQueueItems(fresh, {
          activeProjectKeys,
          activeCount: active.size,
          maxConcurrency: limit,
          nowMs: Date.parse(nowFn())
        })
        for (const target of claimable) {
          if (!canExecute()) break
          if (typeof claimGate === 'function') {
            let gate = null
            try {
              gate = claimGate(target)
            } catch (error) {
              logger(`[REASONING][QUEUE][CLAIM_GATE][ERROR] sessionId=${target.sessionId} detail=${error instanceof Error ? error.message : String(error)}`)
              gate = null // 门禁异常按放行处理，不阻断既有调度
            }
            if (gate && gate.ok === false) continue // 保持 queued 等待（不失败、不占槽、不动 retry 预算）
          }
          claimAndExecute(target)
        }
      }
    } catch (error) {
      logger(`[REASONING][QUEUE][TICK][ERROR] detail=${error instanceof Error ? error.message : String(error)}`)
    } finally {
      tickInFlight = false
    }
  }

  const scheduleKick = () => {
    if (stopped || kickTimer) return
    kickTimer = setTimeout(() => {
      kickTimer = null
      tick()
    }, 0)
  }

  const runHeartbeatScan = () => {
    if (stopped || typeof onHeartbeatScan !== 'function') return
    try {
      onHeartbeatScan()
    } catch (error) {
      logger(`[REASONING][QUEUE][HEARTBEAT][ERROR] detail=${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    workerId,
    start() {
      if (!stopped) return
      stopped = false
      timer = setInterval(tick, intervalMs)
      const hbInterval = Math.floor(Number(heartbeatScanIntervalMs) || 0)
      if (hbInterval > 0 && typeof onHeartbeatScan === 'function') {
        heartbeatTimer = setInterval(runHeartbeatScan, hbInterval)
      }
      scheduleKick()
    },
    stop() {
      stopped = true
      if (timer) { clearInterval(timer); timer = null }
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
      if (kickTimer) { clearTimeout(kickTimer); kickTimer = null }
    },
    kick: scheduleKick,
    tick,
    getState() {
      return {
        workerId,
        running: !stopped,
        activeCount: active.size,
        activeProjects: [...new Set([...active.values()].map((held) => held.projectKey))],
        activeSessionIds: [...active.keys()]
      }
    }
  }
}
