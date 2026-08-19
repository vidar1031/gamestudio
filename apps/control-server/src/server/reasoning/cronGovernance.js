/**
 * HERMES-H02：cron 受控生产触发治理。
 *
 * 把「定时生产」收敛到治理层，杜绝匿名调度：
 * - job 必须先注册（持久化在 state/cron-jobs.json，HERMES_CRON_JOBS_FILE 可覆盖，测试用），
 *   字段含 jobId、workflow 标识、prompt、间隔、状态与最近触发记录；
 * - workflow 白名单与 server/workflows/ 注册表对齐，cron 只能引用已注册、被允许的
 *   workflow；未注册的一律拒绝并写治理审计（创建时与触发时双重校验）；
 * - 每次触发都通过受控适配器走与 HTTP 入口相同的链路：创建 reasoning session
 *   （submissionContext.origin='cron' + cronJobId + 幂等键）→ dispatchReasoningSession
 *   入队 → worker 执行 → 审核门禁 → 终态 verdict，全程可追溯，cron 不直接写
 *   storage/projects，也不自行批准任何审核点；
 * - 幂等/去重：同一 job 同一周期（floor(now/intervalMs)）已有未终结任务时跳过并记录；
 * - 治理操作：暂停/恢复/停用/删除均留审计；调度 tick 在 controlServerCore 中接线。
 *
 * 安全边界（与 AGENTS.md 一致）：本模块只做「提交受控任务」，执行与审核全部由既有
 * 队列 worker 与审核门禁承担；审计写入 best-effort，不放大为生产故障。
 */

import fs from 'node:fs'
import path from 'node:path'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'
import { appendGovernanceAudit } from './governanceAudit.js'
import {
  getRegistryWorkflow,
  isRegistryWorkflowTriggerable,
  resolveRegistryProjectBinding
} from './projectWorkflowRegistry.js'

// cron 面向的内建 workflow 视图（与 HERMES-H04 注册表内建条目对齐，保持 H02 API 形状）。
// 触发资格判定的唯一事实源是 H04 注册表（isRegistryWorkflowTriggerable）：
// cron job 只能引用注册表中已注册且启用、所属项目启用的 workflow；
// 新增 workflow 先经注册表受控 API 登记（人类 actor + 审计），无需再改代码。
export const CRON_WORKFLOW_REGISTRY = Object.freeze({
  story_production: Object.freeze({
    workflowId: 'story_production',
    label: '互动故事生产',
    source: 'workflows/storyProductionWorkflows.js'
  }),
  gamestudio_bootstrap: Object.freeze({
    workflowId: 'gamestudio_bootstrap',
    label: 'GameStudio 启动引导',
    source: 'workflows/gameStudioBootstrapWorkflows.js'
  }),
  project_status: Object.freeze({
    workflowId: 'project_status',
    label: '项目状态查询',
    source: 'workflows/projectStatusWorkflows.js'
  })
})

export const CRON_JOB_STATUS = Object.freeze({
  ACTIVE: 'active',
  PAUSED: 'paused',
  DISABLED: 'disabled'
})

// 每个 job 保留的最近触发记录条数上限（证据索引，不全量留存）
const CRON_RECENT_TRIGGERS_LIMIT = 20
// job 最小触发间隔（env 可覆盖，防止误配高频生产）
const CRON_MIN_INTERVAL_MS = Math.max(1000, Number(process.env.HERMES_CRON_MIN_INTERVAL_MS || 60000))

// 用于幂等判定的 session 终态（与 listReasoningSessions 的 includeTerminal 语义一致）
const CRON_DEDUP_TERMINAL_SESSION_STATES = new Set(['completed', 'failed', 'cancelled', 'blocked', 'timeout'])

export function getCronJobsFile() {
  const override = process.env.HERMES_CRON_JOBS_FILE
  if (override && String(override).trim()) return String(override)
  return path.join(GAMESTUDIO_ROOT, 'state', 'cron-jobs.json')
}

function emptyCronJobsFile() {
  return { version: 1, jobs: [] }
}

function readCronJobsFile() {
  const file = getCronJobsFile()
  try {
    if (!fs.existsSync(file)) return emptyCronJobsFile()
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!raw || !Array.isArray(raw.jobs)) throw new Error('invalid_cron_jobs_file')
    return raw
  } catch {
    // 损坏文件隔离留证后按空处理，不猜测内容（与队列损坏处理同一语义）
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      // 隔离失败不阻断读取
    }
    return emptyCronJobsFile()
  }
}

function writeCronJobsFile(data) {
  const file = getCronJobsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function normalizeJob(job) {
  return {
    jobId: String(job.jobId),
    name: String(job.name || job.jobId),
    workflow: String(job.workflow || ''),
    prompt: String(job.prompt || ''),
    intervalMs: Number(job.intervalMs),
    reviewMode: String(job.reviewMode || 'manual'),
    // AUTO-F01：可选项目归属——携带时透传 submissionContext，队列按 project 串行与配额调度，
    // 触发记录与治理审计可按项目对照；不携带时行为与 H02 一致（无项目归属）
    projectId: String(job.projectId || '').trim() || null,
    status: String(job.status || CRON_JOB_STATUS.ACTIVE),
    createdAt: job.createdAt || null,
    updatedAt: job.updatedAt || null,
    lastTriggeredAt: job.lastTriggeredAt || null,
    nextTriggerAt: job.nextTriggerAt || null,
    recentTriggers: Array.isArray(job.recentTriggers) ? job.recentTriggers : []
  }
}

function updateJob(jobId, updater) {
  const data = readCronJobsFile()
  const index = data.jobs.findIndex((job) => job.jobId === jobId)
  if (index < 0) return null
  const next = updater(normalizeJob(data.jobs[index]))
  data.jobs[index] = next
  writeCronJobsFile(data)
  return next
}

export function listCronJobs() {
  return readCronJobsFile().jobs.map(normalizeJob)
}

export function getCronJob(jobId) {
  const job = readCronJobsFile().jobs.find((entry) => entry.jobId === jobId)
  return job ? normalizeJob(job) : null
}

export function isCronWorkflowRegistered(workflow) {
  // HERMES-H04：唯一事实源为项目/workflow 注册表——已注册、启用、所属项目启用
  // 的 workflow 才可被 cron 选择；内建条目始终满足（保持 H02 白名单语义不回归）
  return isRegistryWorkflowTriggerable(workflow)
}

// 周期对齐：同一 job 同一周期共用幂等键；下次触发取下一周期起点
function resolvePeriodStartMs(nowMs, intervalMs) {
  return Math.floor(nowMs / intervalMs) * intervalMs
}

function buildIdempotencyKey(jobId, nowMs, intervalMs) {
  return `${jobId}:${resolvePeriodStartMs(nowMs, intervalMs)}`
}

/**
 * 注册 cron job。未注册 workflow / 缺 prompt / 间隔低于下限一律拒绝并审计。
 * @returns { ok: true, job } | { ok: false, error, detail }
 */
export function createCronJob(input = {}, { nowFn = () => new Date().toISOString() } = {}) {
  const now = nowFn()
  const workflow = String(input.workflow || '').trim()
  const prompt = String(input.prompt || '').trim()
  const intervalMs = Number(input.intervalMs)
  const name = String(input.name || '').trim() || `${workflow}-job`
  const reviewMode = ['suggest', 'auto-edit', 'full-auto', 'manual'].includes(String(input.reviewMode || '').trim().toLowerCase())
    ? String(input.reviewMode).trim().toLowerCase()
    : 'manual'

  const reject = (error, detail) => {
    appendGovernanceAudit({ action: 'cron_job_create', result: 'blocked', detail: `${error}:${detail}` }, { nowFn })
    return { ok: false, error, detail }
  }

  if (!isCronWorkflowRegistered(workflow)) {
    return reject('workflow_not_registered', `workflow=${workflow || '-'} 未在项目/workflow 注册表登记或已停用（内建：${Object.keys(CRON_WORKFLOW_REGISTRY).join('/')}）`)
  }
  if (!prompt) {
    return reject('prompt_required', 'cron job 必须携带提交给受控链路的 prompt')
  }
  if (!Number.isFinite(intervalMs) || intervalMs < CRON_MIN_INTERVAL_MS) {
    return reject('interval_too_small', `intervalMs=${input.intervalMs ?? '-'} 低于下限 ${CRON_MIN_INTERVAL_MS}ms`)
  }

  // HERMES-H04：job 携带项目归属时，必须是 workflow 注册项目本身或其根目录下的实例，
  // 跨项目归属一律拒绝并审计（注册时拦截，触发时再双重校验）
  const requestedProjectId = String(input.projectId || '').trim() || null
  if (requestedProjectId) {
    const binding = resolveRegistryProjectBinding(getRegistryWorkflow(workflow), requestedProjectId)
    if (!binding.ok) {
      return reject(binding.error, binding.detail)
    }
  }

  const jobId = `cron_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
  const job = {
    jobId,
    name,
    workflow,
    prompt,
    intervalMs,
    reviewMode,
    // AUTO-F01：可选项目归属（空字符串视为无归属）；HERMES-H04：取值经注册表归属校验
    projectId: requestedProjectId,
    status: CRON_JOB_STATUS.ACTIVE,
    createdAt: now,
    updatedAt: now,
    lastTriggeredAt: null,
    nextTriggerAt: new Date(resolvePeriodStartMs(Date.parse(now), intervalMs) + intervalMs).toISOString(),
    recentTriggers: []
  }
  const data = readCronJobsFile()
  data.jobs.push(job)
  writeCronJobsFile(data)
  appendGovernanceAudit({ action: 'cron_job_create', jobId, projectId: job.projectId, result: 'ok', detail: `workflow=${workflow} intervalMs=${intervalMs} name=${name}` }, { nowFn })
  return { ok: true, job: normalizeJob(job) }
}

/**
 * 治理操作：暂停/恢复/停用/删除。全部留审计；非法转移被拒绝并审计。
 * @param {string} action 'pause' | 'resume' | 'disable' | 'delete'
 */
export function setCronJobStatus(jobId, action, { nowFn = () => new Date().toISOString() } = {}) {
  const now = nowFn()
  const auditAction = `cron_job_${action}`
  const job = getCronJob(jobId)
  if (!job) {
    return { ok: false, error: 'cron_job_not_found' }
  }
  const reject = (error, detail) => {
    appendGovernanceAudit({ action: auditAction, jobId, result: 'blocked', detail }, { nowFn })
    return { ok: false, error, detail }
  }

  if (action === 'delete') {
    const data = readCronJobsFile()
    data.jobs = data.jobs.filter((entry) => entry.jobId !== jobId)
    writeCronJobsFile(data)
    appendGovernanceAudit({ action: auditAction, jobId, result: 'ok', detail: `已删除 cron job（原状态 ${job.status}）` }, { nowFn })
    return { ok: true, job }
  }

  const transitions = {
    pause: { from: [CRON_JOB_STATUS.ACTIVE], to: CRON_JOB_STATUS.PAUSED },
    resume: { from: [CRON_JOB_STATUS.PAUSED], to: CRON_JOB_STATUS.ACTIVE },
    disable: { from: [CRON_JOB_STATUS.ACTIVE, CRON_JOB_STATUS.PAUSED], to: CRON_JOB_STATUS.DISABLED }
  }
  const rule = transitions[action]
  if (!rule) {
    return reject('unknown_action', `action=${action || '-'} 仅支持 pause/resume/disable/delete`)
  }
  if (!rule.from.includes(job.status)) {
    return reject('illegal_status_transition', `当前状态 ${job.status} 不允许 ${action}`)
  }

  const next = updateJob(jobId, (current) => ({
    ...current,
    status: rule.to,
    updatedAt: now,
    // 恢复时重新对齐下一周期，避免暂停期间积压的周期被立即补触发
    ...(action === 'resume'
      ? { nextTriggerAt: new Date(resolvePeriodStartMs(Date.parse(now), current.intervalMs) + current.intervalMs).toISOString() }
      : {})
  }))
  appendGovernanceAudit({ action: auditAction, jobId, result: 'ok', detail: `${job.status} -> ${rule.to}` }, { nowFn })
  return { ok: true, job: next }
}

/**
 * 受控触发适配器：到点（或人工）触发一个 cron job。
 * 与 HTTP 入口同一治理语义：白名单校验 -> 状态校验 -> 启动门禁 -> 幂等去重 ->
 * 创建 reasoning session（标注 cron 来源）-> dispatch 入队。全部结果留审计。
 *
 * @param {object} deps {
 *   createSession: async (prompt, submissionContext) => session,   // 受控 session 创建入口
 *   dispatch: (sessionId) => queueItem,                            // dispatchReasoningSession
 *   readSession: (sessionId) => session | null,                    // 幂等判定用
 *   checkStartAllowed?: () => { ok: true } | { ok: false, reason } // 与 HTTP 入口一致的启动门禁
 * }
 * @param {object} options { nowFn?, manual? } manual=守护台人工触发（走同一适配器与幂等规则）
 */
export async function triggerCronJob(jobId, deps = {}, { nowFn = () => new Date().toISOString(), manual = false } = {}) {
  const now = nowFn()
  const nowMs = Date.parse(now)
  const job = getCronJob(jobId)
  if (!job) {
    return { ok: false, error: 'cron_job_not_found' }
  }
  const block = (error, detail) => {
    appendGovernanceAudit({ action: 'cron_trigger', jobId, result: 'blocked', detail: `${error}:${detail}` }, { nowFn })
    return { ok: false, error, detail }
  }

  // 白名单双重校验：注册时拦一次，触发时再拦一次（防止 jobs 文件被篡改后越权提交）
  if (!isCronWorkflowRegistered(job.workflow)) {
    return block('workflow_not_registered', `workflow=${job.workflow || '-'} 未在项目/workflow 注册表登记或已停用`)
  }
  // HERMES-H04：项目归属双重校验——跨项目归属的任务不得进入受控链路
  if (job.projectId) {
    const binding = resolveRegistryProjectBinding(getRegistryWorkflow(job.workflow), job.projectId)
    if (!binding.ok) {
      return block(binding.error, binding.detail)
    }
  }
  if (job.status !== CRON_JOB_STATUS.ACTIVE) {
    return block('cron_job_not_active', `当前状态 ${job.status}，仅 active 可触发`)
  }
  if (typeof deps.checkStartAllowed === 'function') {
    const gate = deps.checkStartAllowed()
    if (gate && gate.ok === false) {
      return block('start_blocked', String(gate.reason || 'start_not_allowed'))
    }
  }

  const idempotencyKey = buildIdempotencyKey(jobId, nowMs, job.intervalMs)
  const existing = job.recentTriggers.find((entry) => entry.idempotencyKey === idempotencyKey && entry.result === 'submitted')
  if (existing) {
    const existingSession = typeof deps.readSession === 'function' ? deps.readSession(existing.sessionId) : null
    const existingStatus = String(existingSession?.status || '').trim()
    // 同周期已有未终结任务 -> 跳过并记录（幂等去重）；session 记录缺失按已终结处理
    if (existingSession && !CRON_DEDUP_TERMINAL_SESSION_STATES.has(existingStatus)) {
      const trigger = {
        idempotencyKey,
        triggeredAt: now,
        result: 'skipped_duplicate',
        reason: `同周期任务 ${existing.sessionId} 未终结（${existingStatus}）`,
        sessionId: existing.sessionId,
        taskId: existing.taskId || null,
        manual: Boolean(manual)
      }
      appendTriggerRecord(jobId, trigger, now)
      appendGovernanceAudit({ action: 'cron_trigger', jobId, sessionId: existing.sessionId, taskId: existing.taskId || null, projectId: job.projectId || null, result: 'ok', detail: `skipped_duplicate:${idempotencyKey}` }, { nowFn })
      return { ok: true, result: 'skipped_duplicate', idempotencyKey, sessionId: existing.sessionId, taskId: existing.taskId || null }
    }
  }

  const submissionContext = {
    origin: 'cron',
    cronJobId: job.jobId,
    cronIdempotencyKey: idempotencyKey,
    workflow: job.workflow,
    reviewMode: job.reviewMode,
    // AUTO-F01：job 携带项目归属时透传，队列按 project 串行与每项目配额调度
    ...(job.projectId ? { projectId: job.projectId } : {}),
    title: `[cron] ${job.name}`
  }
  const session = await deps.createSession(job.prompt, submissionContext)
  const queueItem = deps.dispatch(session.sessionId)
  // AUTO-F01：dispatch 配额门禁拒绝（project_quota_exceeded）时记录阻断而非 submitted，
  // session 已被核心侧收敛为 blocked（含用量证据），审计可按项目对照
  if (queueItem?.quotaRejected) {
    const quotaTrigger = {
      idempotencyKey,
      triggeredAt: now,
      result: 'blocked_quota',
      reason: `project_quota_exceeded: 在制 ${queueItem.quota?.activeCount ?? '-'}/${queueItem.quota?.limit ?? '-'}`,
      sessionId: session.sessionId,
      taskId: null,
      manual: Boolean(manual)
    }
    appendTriggerRecord(jobId, quotaTrigger, now)
    appendGovernanceAudit({ action: 'cron_trigger', jobId, sessionId: session.sessionId, projectId: job.projectId, result: 'blocked', detail: `project_quota_exceeded:${idempotencyKey}` }, { nowFn })
    return { ok: false, error: 'project_quota_exceeded', idempotencyKey, sessionId: session.sessionId }
  }
  const trigger = {
    idempotencyKey,
    triggeredAt: now,
    result: 'submitted',
    sessionId: session.sessionId,
    taskId: queueItem?.taskId || null,
    manual: Boolean(manual)
  }
  const next = updateJob(jobId, (current) => ({
    ...current,
    updatedAt: now,
    lastTriggeredAt: now,
    nextTriggerAt: new Date(resolvePeriodStartMs(nowMs, current.intervalMs) + current.intervalMs).toISOString(),
    recentTriggers: [trigger, ...current.recentTriggers].slice(0, CRON_RECENT_TRIGGERS_LIMIT)
  }))
  appendGovernanceAudit({ action: 'cron_trigger', jobId, sessionId: session.sessionId, taskId: trigger.taskId, projectId: job.projectId, result: 'ok', detail: `submitted:${idempotencyKey}${manual ? '（人工触发）' : ''}` }, { nowFn })
  return { ok: true, result: 'submitted', idempotencyKey, sessionId: session.sessionId, taskId: trigger.taskId, job: next }
}

function appendTriggerRecord(jobId, trigger, now) {
  updateJob(jobId, (current) => ({
    ...current,
    updatedAt: now,
    recentTriggers: [trigger, ...current.recentTriggers].slice(0, CRON_RECENT_TRIGGERS_LIMIT)
  }))
}

/**
 * 调度 tick：触发所有到点的 active job。
 * 单个 job 异常不影响其他 job；异常 job 推进到下一周期并审计阻断，避免热循环。
 * @returns { scanned, submitted, skipped, blocked, errors }
 */
export async function runDueCronJobs(deps = {}, { nowFn = () => new Date().toISOString() } = {}) {
  const now = nowFn()
  const nowMs = Date.parse(now)
  const summary = { scanned: 0, submitted: 0, skipped: 0, blocked: 0, errors: [] }
  for (const job of listCronJobs()) {
    if (job.status !== CRON_JOB_STATUS.ACTIVE) continue
    if (!job.nextTriggerAt || Date.parse(job.nextTriggerAt) > nowMs) continue
    summary.scanned += 1
    try {
      const result = await triggerCronJob(job.jobId, deps, { nowFn })
      if (!result.ok) summary.blocked += 1
      else if (result.result === 'skipped_duplicate') summary.skipped += 1
      else summary.submitted += 1
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      summary.blocked += 1
      summary.errors.push({ jobId: job.jobId, error: detail })
      appendGovernanceAudit({ action: 'cron_trigger', jobId: job.jobId, result: 'blocked', detail: `trigger_error:${detail}` }, { nowFn })
      // 推进到下一周期，防止异常 job 每个 tick 反复失败
      updateJob(job.jobId, (current) => ({
        ...current,
        updatedAt: now,
        nextTriggerAt: new Date(resolvePeriodStartMs(nowMs, current.intervalMs) + current.intervalMs).toISOString()
      }))
    }
  }
  return summary
}
