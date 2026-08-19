import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Hono } from 'hono'
import {
  CRON_WORKFLOW_REGISTRY,
  createCronJob,
  getCronJob,
  getCronJobsFile,
  listCronJobs,
  runDueCronJobs,
  setCronJobStatus,
  triggerCronJob
} from '../../apps/control-server/src/server/reasoning/cronGovernance.js'
import { readGovernanceAudit } from '../../apps/control-server/src/server/reasoning/governanceAudit.js'
import { registerCronRoutes } from '../../apps/control-server/src/server/routes/cronRoutes.js'

// HERMES-H02 测试：cron 受控生产触发（S3-08 白名单与受控链路、S3-09 前置的触发治理）。
// 覆盖：白名单拒绝+审计、可追溯 task/session 创建、幂等去重、暂停/恢复/停用、
// 启动门禁、调度 tick、HTTP 路由全链路（注入 fake createSession/dispatch）。
// env 隔离：jobs 文件与审计文件指向临时目录，不污染真实 state/。

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-governance-'))
const JOBS_FILE = path.join(TMP_DIR, 'cron-jobs.json')
const AUDIT_FILE = path.join(TMP_DIR, 'governance-audit.jsonl')
const savedJobsFileEnv = process.env.HERMES_CRON_JOBS_FILE
const savedAuditFileEnv = process.env.HERMES_GOVERNANCE_AUDIT_FILE
process.env.HERMES_CRON_JOBS_FILE = JOBS_FILE
process.env.HERMES_GOVERNANCE_AUDIT_FILE = AUDIT_FILE

function restoreEnv() {
  if (savedJobsFileEnv === undefined) delete process.env.HERMES_CRON_JOBS_FILE
  else process.env.HERMES_CRON_JOBS_FILE = savedJobsFileEnv
  if (savedAuditFileEnv === undefined) delete process.env.HERMES_GOVERNANCE_AUDIT_FILE
  else process.env.HERMES_GOVERNANCE_AUDIT_FILE = savedAuditFileEnv
}

process.on('exit', restoreEnv)

const FIXED_NOW = '2026-08-15T08:00:00.000Z'
const fixedNowFn = () => FIXED_NOW

function resetFiles() {
  for (const file of [JOBS_FILE, AUDIT_FILE]) {
    try { fs.rmSync(file) } catch { /* 不存在则忽略 */ }
  }
}

function auditRecords() {
  return readGovernanceAudit(500).records
}

let sessionSeq = 0
// fake 受控依赖：镜像 createReasoningSession + dispatchReasoningSession 的调用形状
function makeDeps({ sessionStatus = 'running', startAllowed = { ok: true } } = {}) {
  const calls = { createSession: [], dispatch: [] }
  const sessions = new Map()
  return {
    calls,
    sessions,
    deps: {
      createSession: async (prompt, submissionContext) => {
        sessionSeq += 1
        const sessionId = `cron_sess_${sessionSeq}`
        calls.createSession.push({ prompt, submissionContext })
        sessions.set(sessionId, { sessionId, status: sessionStatus, submissionContext })
        return { sessionId }
      },
      dispatch: (sessionId) => {
        calls.dispatch.push(sessionId)
        return { taskId: `task_for_${sessionId}`, sessionId }
      },
      readSession: (sessionId) => sessions.get(sessionId) || null,
      checkStartAllowed: () => startAllowed
    }
  }
}

function createValidJob(overrides = {}) {
  const result = createCronJob({
    name: '每日故事生产',
    workflow: 'story_production',
    prompt: '生产一个狼来了互动故事，P0 完整闭环',
    intervalMs: 60000,
    ...overrides
  }, { nowFn: fixedNowFn })
  assert.equal(result.ok, true, result.detail)
  return result.job
}

test('S3-08：未注册 workflow 的 job 创建被拒绝并审计 blocked', () => {
  resetFiles()
  const result = createCronJob({ workflow: 'ghost_workflow', prompt: 'x', intervalMs: 60000 }, { nowFn: fixedNowFn })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'workflow_not_registered')
  assert.equal(listCronJobs().length, 0)
  const record = auditRecords().find((entry) => entry.action === 'cron_job_create')
  assert.ok(record, '应有创建审计')
  assert.equal(record.result, 'blocked')
  assert.match(record.detail, /ghost_workflow/)
})

test('S3-08：合法 job 注册成功并持久化（白名单与 workflows/ 注册表对齐）', () => {
  resetFiles()
  assert.deepEqual(Object.keys(CRON_WORKFLOW_REGISTRY).sort(), ['gamestudio_bootstrap', 'project_status', 'story_production'])
  const job = createValidJob()
  assert.equal(job.status, 'active')
  assert.equal(job.reviewMode, 'manual')
  assert.ok(job.nextTriggerAt, '应计算下次触发时间')
  const listed = listCronJobs()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].jobId, job.jobId)
  const record = auditRecords().find((entry) => entry.action === 'cron_job_create' && entry.jobId === job.jobId)
  assert.ok(record)
  assert.equal(record.result, 'ok')
})

test('缺 prompt / 间隔低于下限的 job 被拒绝并审计', () => {
  resetFiles()
  const noPrompt = createCronJob({ workflow: 'story_production', prompt: '', intervalMs: 60000 }, { nowFn: fixedNowFn })
  assert.equal(noPrompt.ok, false)
  assert.equal(noPrompt.error, 'prompt_required')
  const smallInterval = createCronJob({ workflow: 'story_production', prompt: 'x', intervalMs: 500 }, { nowFn: fixedNowFn })
  assert.equal(smallInterval.ok, false)
  assert.equal(smallInterval.error, 'interval_too_small')
  assert.equal(auditRecords().filter((entry) => entry.action === 'cron_job_create' && entry.result === 'blocked').length, 2)
})

test('触发创建可追溯 session/task：submissionContext 标注 cron 来源，dispatch 入队，审计互查', async () => {
  resetFiles()
  const job = createValidJob()
  const { calls, deps } = makeDeps()
  const result = await triggerCronJob(job.jobId, deps, { nowFn: fixedNowFn })
  assert.equal(result.ok, true)
  assert.equal(result.result, 'submitted')
  assert.ok(result.sessionId)
  assert.equal(result.taskId, `task_for_${result.sessionId}`)
  assert.equal(calls.createSession.length, 1)
  const { prompt, submissionContext } = calls.createSession[0]
  assert.equal(prompt, job.prompt)
  assert.equal(submissionContext.origin, 'cron')
  assert.equal(submissionContext.cronJobId, job.jobId)
  assert.equal(submissionContext.workflow, 'story_production')
  assert.ok(submissionContext.cronIdempotencyKey.startsWith(`${job.jobId}:`))
  assert.deepEqual(calls.dispatch, [result.sessionId])
  const updated = getCronJob(job.jobId)
  assert.equal(updated.lastTriggeredAt, FIXED_NOW)
  assert.equal(updated.recentTriggers[0].result, 'submitted')
  assert.equal(updated.recentTriggers[0].sessionId, result.sessionId)
  const record = auditRecords().find((entry) => entry.action === 'cron_trigger' && entry.jobId === job.jobId)
  assert.ok(record)
  assert.equal(record.result, 'ok')
  assert.equal(record.sessionId, result.sessionId)
  assert.equal(record.taskId, result.taskId)
})

test('幂等去重：同周期已有未终结任务时跳过并记录；任务终结后允许再次提交', async () => {
  resetFiles()
  const job = createValidJob()
  const { calls, sessions, deps } = makeDeps({ sessionStatus: 'running' })
  const first = await triggerCronJob(job.jobId, deps, { nowFn: fixedNowFn })
  assert.equal(first.result, 'submitted')
  // 同周期第二次触发：session 仍 running -> 跳过
  const second = await triggerCronJob(job.jobId, deps, { nowFn: fixedNowFn })
  assert.equal(second.ok, true)
  assert.equal(second.result, 'skipped_duplicate')
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(calls.dispatch.length, 1, '跳过时不应重复入队')
  const updated = getCronJob(job.jobId)
  assert.equal(updated.recentTriggers[0].result, 'skipped_duplicate')
  const skipAudit = auditRecords().find((entry) => entry.action === 'cron_trigger' && entry.detail?.startsWith('skipped_duplicate'))
  assert.ok(skipAudit, '跳过也应留审计')
  // 前一任务已终结（completed）-> 同周期允许再次提交
  sessions.get(first.sessionId).status = 'completed'
  const third = await triggerCronJob(job.jobId, deps, { nowFn: fixedNowFn })
  assert.equal(third.result, 'submitted')
  assert.equal(calls.dispatch.length, 2)
})

test('启动门禁：runtime 未就绪时触发被阻断、不入队、审计 blocked', async () => {
  resetFiles()
  const job = createValidJob()
  const { calls, deps } = makeDeps({ startAllowed: { ok: false, reason: 'runtime_not_running' } })
  const result = await triggerCronJob(job.jobId, deps, { nowFn: fixedNowFn })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'start_blocked')
  assert.match(result.detail, /runtime_not_running/)
  assert.equal(calls.dispatch.length, 0)
  const record = auditRecords().find((entry) => entry.action === 'cron_trigger' && entry.jobId === job.jobId)
  assert.ok(record)
  assert.equal(record.result, 'blocked')
})

test('暂停/恢复/停用：治理流转受控，非 active 触发被阻断，全部留审计', async () => {
  resetFiles()
  const job = createValidJob()
  const { calls, deps } = makeDeps()
  // 暂停后触发阻断
  const paused = setCronJobStatus(job.jobId, 'pause', { nowFn: fixedNowFn })
  assert.equal(paused.ok, true)
  assert.equal(paused.job.status, 'paused')
  const blockedTrigger = await triggerCronJob(job.jobId, deps, { nowFn: fixedNowFn })
  assert.equal(blockedTrigger.ok, false)
  assert.equal(blockedTrigger.error, 'cron_job_not_active')
  assert.equal(calls.dispatch.length, 0)
  // 重复暂停属于非法流转
  const repause = setCronJobStatus(job.jobId, 'pause', { nowFn: fixedNowFn })
  assert.equal(repause.ok, false)
  assert.equal(repause.error, 'illegal_status_transition')
  // 恢复后触发成功
  const resumed = setCronJobStatus(job.jobId, 'resume', { nowFn: fixedNowFn })
  assert.equal(resumed.ok, true)
  assert.equal(resumed.job.status, 'active')
  const triggered = await triggerCronJob(job.jobId, deps, { nowFn: fixedNowFn })
  assert.equal(triggered.result, 'submitted')
  // 停用后恢复非法、触发阻断
  const disabled = setCronJobStatus(job.jobId, 'disable', { nowFn: fixedNowFn })
  assert.equal(disabled.job.status, 'disabled')
  assert.equal(setCronJobStatus(job.jobId, 'resume', { nowFn: fixedNowFn }).ok, false)
  const disabledTrigger = await triggerCronJob(job.jobId, deps, { nowFn: fixedNowFn })
  assert.equal(disabledTrigger.error, 'cron_job_not_active')
  const actions = auditRecords().map((entry) => `${entry.action}:${entry.result}`)
  assert.ok(actions.includes('cron_job_pause:ok'))
  assert.ok(actions.includes('cron_job_pause:blocked'))
  assert.ok(actions.includes('cron_job_resume:ok'))
  assert.ok(actions.includes('cron_job_disable:ok'))
  assert.ok(actions.includes('cron_trigger:blocked'))
})

test('触发时白名单双重校验：jobs 文件被篡改为未注册 workflow 时阻断并审计', async () => {
  resetFiles()
  const job = createValidJob()
  // 直接篡改持久化文件（绕过创建校验），模拟越权注入
  const raw = JSON.parse(fs.readFileSync(getCronJobsFile(), 'utf8'))
  raw.jobs[0].workflow = 'ghost_workflow'
  fs.writeFileSync(getCronJobsFile(), JSON.stringify(raw), 'utf8')
  const { calls, deps } = makeDeps()
  const result = await triggerCronJob(job.jobId, deps, { nowFn: fixedNowFn })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'workflow_not_registered')
  assert.equal(calls.dispatch.length, 0)
  const record = auditRecords().find((entry) => entry.action === 'cron_trigger' && entry.jobId === job.jobId)
  assert.ok(record)
  assert.equal(record.result, 'blocked')
})

test('runDueCronJobs：只触发到点的 active job，异常 job 推进到下一周期并审计', async () => {
  resetFiles()
  const dueJob = createValidJob({ name: '到点任务' })
  const futureJob = createValidJob({ name: '未到点任务' })
  const pausedJob = createValidJob({ name: '已暂停任务' })
  setCronJobStatus(pausedJob.jobId, 'pause', { nowFn: fixedNowFn })
  // dueJob 手动拉回到点（创建时 nextTriggerAt 为下一周期起点，尚未到点）；
  // futureJob 手动改成未来时间
  const raw = JSON.parse(fs.readFileSync(getCronJobsFile(), 'utf8'))
  raw.jobs.find((entry) => entry.jobId === dueJob.jobId).nextTriggerAt = FIXED_NOW
  const future = raw.jobs.find((entry) => entry.jobId === futureJob.jobId)
  future.nextTriggerAt = '2026-08-15T09:00:00.000Z'
  fs.writeFileSync(getCronJobsFile(), JSON.stringify(raw), 'utf8')

  const { calls, deps } = makeDeps()
  const summary = await runDueCronJobs(deps, { nowFn: fixedNowFn })
  assert.equal(summary.scanned, 1)
  assert.equal(summary.submitted, 1)
  assert.equal(calls.dispatch.length, 1)
  assert.equal(getCronJob(pausedJob.jobId).status, 'paused')

  // 异常路径：createSession 抛错 -> blocked + 推进 nextTriggerAt
  const failingDeps = {
    ...deps,
    createSession: async () => { throw new Error('model_down') }
  }
  // dueJob 刚触发过，nextTriggerAt 已推进；手动拉回制造再次到点。
  // 用下一周期的时间触发，避开同周期幂等去重（前次 session 仍未终结会走 skipped_duplicate）
  const laterNowFn = () => '2026-08-15T08:05:00.000Z'
  const raw2 = JSON.parse(fs.readFileSync(getCronJobsFile(), 'utf8'))
  raw2.jobs.find((entry) => entry.jobId === dueJob.jobId).nextTriggerAt = FIXED_NOW
  fs.writeFileSync(getCronJobsFile(), JSON.stringify(raw2), 'utf8')
  const failingSummary = await runDueCronJobs(failingDeps, { nowFn: laterNowFn })
  assert.equal(failingSummary.blocked, 1)
  assert.equal(failingSummary.errors.length, 1)
  assert.match(failingSummary.errors[0].error, /model_down/)
  assert.ok(Date.parse(getCronJob(dueJob.jobId).nextTriggerAt) > Date.parse(FIXED_NOW), '异常 job 应推进到下一周期')
  const errorAudit = auditRecords().find((entry) => entry.action === 'cron_trigger' && entry.detail?.startsWith('trigger_error'))
  assert.ok(errorAudit)
  assert.equal(errorAudit.result, 'blocked')
})

// --- HTTP 路由全链路（注入 stub context，fake dispatch） ---

function makeRouteHarness() {
  const calls = { createSession: [], dispatch: [] }
  const sessions = new Map()
  const context = {
    hermesAgentDefinition: { id: 'hermes-manager' },
    createReasoningSession: async (agentId, prompt, submissionContext) => {
      sessionSeq += 1
      const sessionId = `route_sess_${sessionSeq}`
      calls.createSession.push({ agentId, prompt, submissionContext })
      sessions.set(sessionId, { sessionId, status: 'queued' })
      return { sessionId }
    },
    dispatchReasoningSession: (sessionId) => {
      calls.dispatch.push(sessionId)
      return { taskId: `task_for_${sessionId}`, sessionId }
    },
    readReasoningSession: (sessionId) => sessions.get(sessionId) || null,
    getHermesRuntimeState: () => ({ state: 'running' }),
    buildReasoningStartBlocker: () => null,
    getCronSchedulerState: () => ({ running: false, tickMs: 15000 })
  }
  const app = new Hono()
  registerCronRoutes(app, context)
  return { app, calls, sessions }
}

test('路由：POST /api/control/cron/jobs 未注册 workflow 返回 400 并审计', async () => {
  resetFiles()
  const { app } = makeRouteHarness()
  const res = await app.request('/api/control/cron/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflow: 'ghost_workflow', prompt: 'x', intervalMs: 60000 })
  })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.equal(body.error, 'workflow_not_registered')
  const record = auditRecords().find((entry) => entry.action === 'cron_job_create')
  assert.ok(record)
  assert.equal(record.result, 'blocked')
})

test('路由：注册 -> 列表 -> 暂停/恢复 -> 人工触发 -> 删除 全链路受控', async () => {
  resetFiles()
  const { app, calls } = makeRouteHarness()
  // 注册
  const created = await app.request('/api/control/cron/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '巡检任务', workflow: 'project_status', prompt: '汇总当前项目状态', intervalMs: 60000 })
  })
  assert.equal(created.status, 200)
  const createdBody = await created.json()
  assert.equal(createdBody.ok, true)
  const jobId = createdBody.job.jobId
  // 列表含调度器状态与白名单
  const list = await (await app.request('/api/control/cron/jobs')).json()
  assert.equal(list.ok, true)
  assert.equal(list.jobs.length, 1)
  assert.equal(list.scheduler.running, false)
  assert.ok(list.workflows.some((entry) => entry.workflowId === 'project_status'))
  // 人工触发（active）：走受控适配器创建 session + 入队
  const triggered = await app.request(`/api/control/cron/jobs/${jobId}/trigger`, { method: 'POST' })
  assert.equal(triggered.status, 200)
  const triggeredBody = await triggered.json()
  assert.equal(triggeredBody.result, 'submitted')
  assert.equal(calls.createSession.length, 1)
  assert.equal(calls.createSession[0].agentId, 'hermes-manager')
  assert.equal(calls.createSession[0].submissionContext.origin, 'cron')
  assert.equal(calls.createSession[0].submissionContext.cronJobId, jobId)
  assert.equal(calls.dispatch.length, 1)
  // 暂停后人工触发被 409 阻断
  const paused = await app.request(`/api/control/cron/jobs/${jobId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pause' })
  })
  assert.equal(paused.status, 200)
  assert.equal((await paused.json()).job.status, 'paused')
  const blockedTrigger = await app.request(`/api/control/cron/jobs/${jobId}/trigger`, { method: 'POST' })
  assert.equal(blockedTrigger.status, 409)
  assert.equal((await blockedTrigger.json()).error, 'cron_job_not_active')
  // 恢复后同周期幂等：前一 session queued（未终结）-> 跳过
  await app.request(`/api/control/cron/jobs/${jobId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'resume' })
  })
  const dupTrigger = await app.request(`/api/control/cron/jobs/${jobId}/trigger`, { method: 'POST' })
  assert.equal(dupTrigger.status, 200)
  assert.equal((await dupTrigger.json()).result, 'skipped_duplicate')
  assert.equal(calls.dispatch.length, 1, '幂等跳过不重复入队')
  // 未知 job 404；删除后列表为空
  const missing = await app.request('/api/control/cron/jobs/cron_missing/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pause' })
  })
  assert.equal(missing.status, 404)
  const deleted = await app.request(`/api/control/cron/jobs/${jobId}`, { method: 'DELETE' })
  assert.equal(deleted.status, 200)
  assert.equal((await (await app.request('/api/control/cron/jobs')).json()).jobs.length, 0)
})
