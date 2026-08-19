import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Hono } from 'hono'

// AUTO-F01 测试：多项目隔离与配额（S4-04 / S4-05）。
// 覆盖路径：
// - S4-04 双项目并发：task_id/projectId/artifacts/日志（queue 事件 + worker 日志）逐项对照无串写
// - S4-04 同项目交替串行、跨项目不互相阻塞
// - S4-04 每项目在制配额：evaluateProjectQuota 判定证据、HTTP 提交 429 拒绝、cron 触发阻断记录
// - S4-05 失败隔离：项目 A failed/blocked/cancelled 不污染项目 B 的调度与状态
// - S4-05 路径边界：apps/server 拒绝越过项目根的 id；跨 project 相对路径写入被 E01 gate 拒绝
// - C01 窗口补强：projectId 回写队列 item 的语义（写入/不覆盖/终态不写）
// env 隔离：queue/audit/cron/storage 全部指向临时目录，不污染真实 state/ 与 storage/。

const QUEUE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'f01-queue-'))
const AUDIT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'f01-audit-')), 'audit.jsonl')
const CRON_JOBS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'f01-cron-')), 'cron-jobs.json')
const STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'f01-storage-'))

const savedEnv = {
  HERMES_REASONING_QUEUE_DIR: process.env.HERMES_REASONING_QUEUE_DIR,
  HERMES_GOVERNANCE_AUDIT_FILE: process.env.HERMES_GOVERNANCE_AUDIT_FILE,
  HERMES_CRON_JOBS_FILE: process.env.HERMES_CRON_JOBS_FILE,
  HERMES_REASONING_MAX_TASKS_PER_PROJECT: process.env.HERMES_REASONING_MAX_TASKS_PER_PROJECT,
  STUDIO_STORAGE_ROOT: process.env.STUDIO_STORAGE_ROOT,
  STUDIO_SERVER_LOG_REQUESTS: process.env.STUDIO_SERVER_LOG_REQUESTS
}
process.env.HERMES_REASONING_QUEUE_DIR = QUEUE_DIR
process.env.HERMES_GOVERNANCE_AUDIT_FILE = AUDIT_FILE
process.env.HERMES_CRON_JOBS_FILE = CRON_JOBS_FILE
delete process.env.HERMES_REASONING_MAX_TASKS_PER_PROJECT
process.env.STUDIO_STORAGE_ROOT = STORAGE_ROOT
process.env.STUDIO_SERVER_LOG_REQUESTS = '0'

const {
  REASONING_QUEUE_ITEM_STATE,
  resolveQueueMaxTasksPerProject,
  enqueueQueueItem,
  readQueueItem,
  updateQueueItem,
  createReasoningQueueWorker,
  backfillQueueItemProjectId,
  countActiveQueueItemsForProject,
  evaluateProjectQuota
} = await import('../../apps/control-server/src/server/reasoning/persistentQueue.js')
const { createCronJob, getCronJob, triggerCronJob } = await import('../../apps/control-server/src/server/reasoning/cronGovernance.js')
const { registerReasoningRoutes } = await import('../../apps/control-server/src/server/routes/reasoningRoutes.js')
const { verifyStoryAssetReferenceFile } = await import('../../apps/server/src/ai/storyAssetReferenceGate.js')
const { default: gameStudioApp } = await import('../../apps/server/src/index.js')

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(condition, timeoutMs = 4000) {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor_timeout')
    await sleep(5)
  }
}

function makeSession(sessionId, projectId, overrides = {}) {
  return {
    sessionId,
    status: 'queued',
    submissionContext: { projectId: projectId || null },
    artifacts: {},
    events: [],
    stateTransitions: [],
    plan: { steps: [{ stepId: 's0' }] },
    ...overrides
  }
}

// 内存 session 存取（镜像 updateReasoningSession 语义），事件流留证供对照
function createSessionStore() {
  const sessions = new Map()
  const events = []
  return {
    events,
    write(session) { sessions.set(session.sessionId, session) },
    read: (sessionId) => sessions.get(sessionId) || null,
    update(sessionId, updater) {
      const current = sessions.get(sessionId)
      if (!current) throw new Error('session_not_found')
      const next = updater(current)
      sessions.set(sessionId, next)
      return next
    },
    appendEvent(sessionId, type, title, summary, extra = {}) {
      events.push({ sessionId, type, title, data: extra.data || null })
    }
  }
}

function readAuditRecords() {
  if (!fs.existsSync(AUDIT_FILE)) return []
  return fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

// ---------------------------------------------------------------------------
// S4-04：双项目并发——task_id/projectId/artifacts/日志无串写
// ---------------------------------------------------------------------------

test('S4-04 双项目并发：task_id/projectId/artifacts/日志逐项对照无串写', async () => {
  const store = createSessionStore()
  store.write(makeSession('f01_s_a1', 'proj_alpha'))
  store.write(makeSession('f01_s_b1', 'proj_beta'))
  enqueueQueueItem({ sessionId: 'f01_s_a1', projectId: 'proj_alpha' })
  enqueueQueueItem({ sessionId: 'f01_s_b1', projectId: 'proj_beta' })

  const logLines = []
  const executions = []
  let running = 0
  let maxRunning = 0
  const worker = createReasoningQueueWorker({
    workerId: 'w-f01-dual',
    maxConcurrency: 2,
    tickMs: 5,
    readSession: store.read,
    updateSession: store.update,
    appendEvent: store.appendEvent,
    retryMaxAttempts: 0,
    logger: (line) => logLines.push(String(line)),
    executeItem: async (item) => {
      running += 1
      maxRunning = Math.max(maxRunning, running)
      executions.push({ sessionId: item.sessionId, taskId: item.taskId, projectId: item.projectId })
      await sleep(25) // 制造执行重叠窗口，验证真实并发
      running -= 1
      store.update(item.sessionId, (s) => ({
        ...s,
        status: 'completed',
        artifacts: { ...(s.artifacts || {}), producedBy: { taskId: item.taskId, projectId: item.projectId } }
      }))
    }
  })
  worker.start()
  try {
    await waitFor(() =>
      readQueueItem('f01_s_a1')?.status === REASONING_QUEUE_ITEM_STATE.COMPLETED
      && readQueueItem('f01_s_b1')?.status === REASONING_QUEUE_ITEM_STATE.COMPLETED)
  } finally {
    worker.stop()
  }

  // 真实并发：两个项目的任务执行窗口重叠
  assert.equal(maxRunning, 2)
  // task_id 与 projectId 对照：各自归属，无串写
  const itemA = readQueueItem('f01_s_a1')
  const itemB = readQueueItem('f01_s_b1')
  assert.equal(itemA.taskId, 'f01_s_a1')
  assert.equal(itemB.taskId, 'f01_s_b1')
  assert.equal(itemA.projectId, 'proj_alpha')
  assert.equal(itemB.projectId, 'proj_beta')
  // artifacts 对照：各 session 产物只携带自己的 taskId/projectId
  assert.deepEqual(store.read('f01_s_a1').artifacts.producedBy, { taskId: 'f01_s_a1', projectId: 'proj_alpha' })
  assert.deepEqual(store.read('f01_s_b1').artifacts.producedBy, { taskId: 'f01_s_b1', projectId: 'proj_beta' })
  // queue 事件（日志流）对照：claimed/finished 事件的 projectId 与 session 归属一致
  for (const event of store.events.filter((e) => e.type === 'queue_claimed' || e.type === 'queue_finished')) {
    const expected = event.sessionId === 'f01_s_a1' ? 'proj_alpha' : 'proj_beta'
    assert.equal(event.data?.projectId, expected, `事件 ${event.type} sessionId=${event.sessionId} projectId 串写`)
  }
  // worker 文本日志对照：CLAIM 行携带本任务 projectId，不夹带他项目
  const claimA = logLines.find((line) => line.includes('[CLAIM]') && line.includes('f01_s_a1'))
  const claimB = logLines.find((line) => line.includes('[CLAIM]') && line.includes('f01_s_b1'))
  assert.ok(claimA && claimB, '缺少 CLAIM 日志')
  assert.ok(claimA.includes('projectId=proj_alpha') && !claimA.includes('proj_beta'))
  assert.ok(claimB.includes('projectId=proj_beta') && !claimB.includes('proj_alpha'))
})

// ---------------------------------------------------------------------------
// S4-04：同项目交替串行、跨项目不互相阻塞
// ---------------------------------------------------------------------------

test('S4-04 同项目交替串行，跨项目任务不被另一项目占用阻塞', async () => {
  const store = createSessionStore()
  store.write(makeSession('f01_s_a2', 'proj_gamma'))
  store.write(makeSession('f01_s_a3', 'proj_gamma'))
  store.write(makeSession('f01_s_b2', 'proj_delta'))
  enqueueQueueItem({ sessionId: 'f01_s_a2', projectId: 'proj_gamma' })
  enqueueQueueItem({ sessionId: 'f01_s_a3', projectId: 'proj_gamma' })
  enqueueQueueItem({ sessionId: 'f01_s_b2', projectId: 'proj_delta' })

  const gates = {
    f01_s_a2: (() => { let resolve; const p = new Promise((r) => { resolve = r }); return { p, resolve } })(),
    f01_s_b2: (() => { let resolve; const p = new Promise((r) => { resolve = r }); return { p, resolve } })()
  }
  const started = []
  const finished = []
  const worker = createReasoningQueueWorker({
    workerId: 'w-f01-serial',
    maxConcurrency: 2,
    tickMs: 5,
    readSession: store.read,
    updateSession: store.update,
    appendEvent: store.appendEvent,
    retryMaxAttempts: 0,
    executeItem: async (item) => {
      started.push(item.sessionId)
      if (gates[item.sessionId]) await gates[item.sessionId].p
      store.update(item.sessionId, (s) => ({ ...s, status: 'completed' }))
      finished.push(item.sessionId)
    }
  })
  worker.start()
  try {
    // 不同项目：f01_s_b2 不被 proj_gamma 的运行阻塞，与 f01_s_a2 并发领取
    await waitFor(() => started.includes('f01_s_a2') && started.includes('f01_s_b2'))
    // 同项目串行：f01_s_a3 在 f01_s_a2 终结前保持 queued
    assert.equal(readQueueItem('f01_s_a2').status, REASONING_QUEUE_ITEM_STATE.RUNNING)
    assert.equal(readQueueItem('f01_s_a3').status, REASONING_QUEUE_ITEM_STATE.QUEUED)
    // 项目 delta 终结不释放 proj_gamma 的串行约束
    gates.f01_s_b2.resolve()
    await waitFor(() => readQueueItem('f01_s_b2')?.status === REASONING_QUEUE_ITEM_STATE.COMPLETED)
    assert.equal(readQueueItem('f01_s_a3').status, REASONING_QUEUE_ITEM_STATE.QUEUED)
    // proj_gamma 首任务终结后，同项目下一任务才被领取（交替语义）
    gates.f01_s_a2.resolve()
    await waitFor(() => readQueueItem('f01_s_a3')?.status === REASONING_QUEUE_ITEM_STATE.COMPLETED)
  } finally {
    worker.stop()
  }
  assert.ok(finished.indexOf('f01_s_a2') < started.indexOf('f01_s_a3'), '同项目任务未串行')
})

// ---------------------------------------------------------------------------
// S4-04：每项目在制配额——判定证据与可配置上限
// ---------------------------------------------------------------------------

test('S4-04 配额判定：在制计数、waiting_review/终态不计入、上限可配置', () => {
  enqueueQueueItem({ sessionId: 'f01_s_q1', projectId: 'proj_quota' })

  // 默认上限 1：同项目已有 1 个调度中任务 -> 拒绝并给出用量证据
  const rejected = evaluateProjectQuota({ projectId: 'proj_quota' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error, 'project_quota_exceeded')
  assert.equal(rejected.limit, 1)
  assert.equal(rejected.activeCount, 1)
  assert.deepEqual(rejected.activeSessionIds, ['f01_s_q1'])
  // 排除自身（人工重试/幂等入队场景）-> 放行
  assert.equal(evaluateProjectQuota({ projectId: 'proj_quota', excludeSessionId: 'f01_s_q1' }).ok, true)
  // 上限可配置：显式 maxPerProject=2 -> 放行
  assert.equal(evaluateProjectQuota({ projectId: 'proj_quota', maxPerProject: 2 }).ok, true)
  // env 可配置：HERMES_REASONING_MAX_TASKS_PER_PROJECT
  process.env.HERMES_REASONING_MAX_TASKS_PER_PROJECT = '3'
  try {
    assert.equal(resolveQueueMaxTasksPerProject(), 3)
    assert.equal(evaluateProjectQuota({ projectId: 'proj_quota' }).ok, true)
  } finally {
    delete process.env.HERMES_REASONING_MAX_TASKS_PER_PROJECT
  }
  assert.equal(resolveQueueMaxTasksPerProject(), 1)

  // waiting_review 已释放槽位，不计入配额（人工可能永远不审，不允许占配额死锁）
  updateQueueItem('f01_s_q1', (current) => ({ ...current, status: REASONING_QUEUE_ITEM_STATE.WAITING_REVIEW }))
  assert.equal(evaluateProjectQuota({ projectId: 'proj_quota' }).ok, true)
  assert.deepEqual(countActiveQueueItemsForProject('proj_quota'), { activeCount: 0, activeSessionIds: [] })
  // 终态不计入
  updateQueueItem('f01_s_q1', (current) => ({ ...current, status: REASONING_QUEUE_ITEM_STATE.COMPLETED }))
  assert.equal(evaluateProjectQuota({ projectId: 'proj_quota' }).ok, true)
  // 无 projectId 的任务不占项目配额（仅受全局并发约束）
  assert.equal(evaluateProjectQuota({ projectId: null }).ok, true)
})

test('S4-04 配额拒绝：HTTP 提交同步 429，拒绝原因与用量证据明确并留审计', async () => {
  enqueueQueueItem({ sessionId: 'f01_s_r1', projectId: 'proj_reject' })

  const calls = { create: [], dispatch: [] }
  const context = {
    hermesAgentDefinition: { id: 'hermes-manager' },
    readReasoningSession: () => null,
    updateReasoningSession: () => { throw new Error('not_used') },
    appendReasoningEvent: () => {},
    clearReasoningReview: () => {},
    getHermesRuntimeState: () => ({ state: 'running' }),
    getHermesControlState: () => ({}),
    buildReasoningStartBlocker: () => null,
    buildHermesBinding: () => ({}),
    readHermesChatHistory: () => [],
    createReasoningSession: async (agentId, prompt, submissionContext) => {
      calls.create.push({ agentId, prompt, submissionContext })
      return {
        sessionId: 'f01_s_route_new',
        runtimeSessionId: 'f01_s_route_new',
        status: 'queued',
        createdAt: '2026-08-15T00:00:00.000Z',
        plan: null,
        artifacts: {},
        submissionContext
      }
    },
    persistHermesChatPrompt: () => {},
    persistHermesChatReply: () => {},
    dispatchReasoningSession: (sessionId) => { calls.dispatch.push(sessionId) },
    markReasoningSessionFailed: () => {}
  }
  const app = new Hono()
  registerReasoningRoutes(app, context)

  // 同项目已有调度中任务 -> 429 同步拒绝，不创建 session、不入队
  const rejectedRes = await app.request('/api/control/agents/hermes-manager/reasoning-sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '继续生产项目', projectId: 'proj_reject' })
  })
  assert.equal(rejectedRes.status, 429)
  const rejectedBody = await rejectedRes.json()
  assert.equal(rejectedBody.ok, false)
  assert.equal(rejectedBody.error, 'project_quota_exceeded')
  assert.equal(rejectedBody.projectId, 'proj_reject')
  assert.equal(rejectedBody.limit, 1)
  assert.equal(rejectedBody.activeCount, 1)
  assert.deepEqual(rejectedBody.activeSessionIds, ['f01_s_r1'])
  assert.equal(calls.create.length, 0, '配额拒绝不应创建 session')
  assert.equal(calls.dispatch.length, 0, '配额拒绝不应入队')
  // 治理审计留证（可按项目对照）
  const audit = readAuditRecords().find((r) => r.action === 'session_submit' && r.projectId === 'proj_reject')
  assert.ok(audit, '缺少 session_submit 审计')
  assert.equal(audit.result, 'blocked')
  assert.ok(String(audit.detail).includes('project_quota_exceeded'))

  // 其他项目不受影响：不同 projectId 正常提交
  const okRes = await app.request('/api/control/agents/hermes-manager/reasoning-sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '生产另一个项目', projectId: 'proj_free' })
  })
  assert.equal(okRes.status, 200)
  assert.equal(calls.create.length, 1)
  assert.equal(calls.create[0].submissionContext.projectId, 'proj_free')
})

test('S4-04 cron 触发：projectId 透传 submissionContext，配额阻断留触发记录与审计', async () => {
  const created = createCronJob({
    workflow: 'story_production',
    name: 'f01-cron-quota',
    prompt: '每天生产一集互动故事',
    intervalMs: 60000,
    projectId: 'proj_cron'
  })
  assert.equal(created.ok, true)
  assert.equal(created.job.projectId, 'proj_cron')

  // dispatch 配额门禁拒绝（核心侧返回 quotaRejected 标记）-> 触发记录 blocked_quota + 审计 blocked
  const captured = { submissionContext: null }
  const blockedResult = await triggerCronJob(created.job.jobId, {
    createSession: async (prompt, submissionContext) => {
      captured.submissionContext = submissionContext
      return { sessionId: 'f01_s_cron_1' }
    },
    dispatch: () => ({ taskId: null, quotaRejected: true, quota: { activeCount: 1, limit: 1 } }),
    readSession: () => null
  })
  assert.equal(blockedResult.ok, false)
  assert.equal(blockedResult.error, 'project_quota_exceeded')
  assert.equal(captured.submissionContext.projectId, 'proj_cron') // projectId 透传进受控链路
  const jobAfterBlock = getCronJob(created.job.jobId)
  assert.equal(jobAfterBlock.recentTriggers[0].result, 'blocked_quota')
  const blockedAudit = readAuditRecords().find((r) => r.action === 'cron_trigger' && r.projectId === 'proj_cron' && r.result === 'blocked')
  assert.ok(blockedAudit, '缺少 cron_trigger 配额阻断审计')
  assert.ok(String(blockedAudit.detail).includes('project_quota_exceeded'))

  // 正常触发：submissionContext 带 projectId，审计带 projectId，可按项目对照
  const okResult = await triggerCronJob(created.job.jobId, {
    createSession: async () => ({ sessionId: 'f01_s_cron_2' }),
    dispatch: () => ({ taskId: 'f01_s_cron_2' }),
    readSession: () => null
  })
  assert.equal(okResult.ok, true)
  assert.equal(okResult.result, 'submitted')
  const okAudit = readAuditRecords().find((r) => r.action === 'cron_trigger' && r.projectId === 'proj_cron' && r.result === 'ok' && String(r.detail).startsWith('submitted:'))
  assert.ok(okAudit, '缺少 cron_trigger 提交审计（projectId 维度）')
})

// ---------------------------------------------------------------------------
// S4-05：失败隔离——项目 A 的 failed/blocked/cancelled 不污染项目 B
// ---------------------------------------------------------------------------

test('S4-05 失败隔离：项目 A 失败/阻断/取消不影响项目 B 的调度与状态', async () => {
  const store = createSessionStore()
  // 三对任务：A 侧分别 failed/blocked/cancelled，B 侧均正常完成
  const pairs = [
    { bad: 'f01_s_fa', badProject: 'proj_fail_a', badStatus: 'failed', badArtifacts: { error: 'deterministic_boom' }, good: 'f01_s_fb', goodProject: 'proj_fail_b' },
    { bad: 'f01_s_ca', badProject: 'proj_block_a', badStatus: 'blocked', good: 'f01_s_cb', goodProject: 'proj_block_b' },
    { bad: 'f01_s_xa', badProject: 'proj_cancel_a', badStatus: 'cancelled', good: 'f01_s_xb', goodProject: 'proj_cancel_b' }
  ]
  for (const pair of pairs) {
    store.write(makeSession(pair.bad, pair.badProject))
    store.write(makeSession(pair.good, pair.goodProject))
    enqueueQueueItem({ sessionId: pair.bad, projectId: pair.badProject })
    enqueueQueueItem({ sessionId: pair.good, projectId: pair.goodProject })
  }

  const worker = createReasoningQueueWorker({
    workerId: 'w-f01-isolation',
    maxConcurrency: 2,
    tickMs: 5,
    readSession: store.read,
    updateSession: store.update,
    appendEvent: store.appendEvent,
    retryMaxAttempts: 0, // 关闭自动重试：失败稳定终结，聚焦隔离语义
    executeItem: async (item) => {
      const pair = pairs.find((p) => p.bad === item.sessionId || p.good === item.sessionId)
      await sleep(10)
      if (item.sessionId === pair.bad) {
        store.update(item.sessionId, (s) => ({
          ...s,
          status: pair.badStatus,
          artifacts: { ...(s.artifacts || {}), ...(pair.badArtifacts || {}) }
        }))
        return
      }
      store.update(item.sessionId, (s) => ({
        ...s,
        status: 'completed',
        artifacts: { ...(s.artifacts || {}), producedBy: { taskId: item.taskId, projectId: item.projectId } }
      }))
    }
  })
  worker.start()
  try {
    await waitFor(() => pairs.every((pair) =>
      readQueueItem(pair.bad)?.status === pair.badStatus
      && readQueueItem(pair.good)?.status === REASONING_QUEUE_ITEM_STATE.COMPLETED))
    await sleep(20) // 多跑几个 tick，验证终态稳定不复发
  } finally {
    worker.stop()
  }

  for (const pair of pairs) {
    const badItem = readQueueItem(pair.bad)
    const goodItem = readQueueItem(pair.good)
    // A 侧按自身语义终结（failed/blocked/cancelled），证据留在自己 item/session 上
    assert.equal(badItem.status, pair.badStatus)
    assert.equal(badItem.projectId, pair.badProject)
    assert.equal(store.read(pair.bad).status, pair.badStatus)
    // B 侧调度与状态完全不受污染：正常领取、正常完成、artifacts 干净
    assert.equal(goodItem.status, REASONING_QUEUE_ITEM_STATE.COMPLETED)
    assert.equal(goodItem.projectId, pair.goodProject)
    assert.equal(goodItem.lastError, null)
    assert.deepEqual(store.read(pair.good).artifacts.producedBy, { taskId: pair.good, projectId: pair.goodProject })
    assert.equal(store.read(pair.good).artifacts.error, undefined)
    // B 侧事件流不出现 A 侧失败信息（按 sessionId  scoped）
    for (const event of store.events.filter((e) => e.sessionId === pair.good)) {
      assert.equal(event.data?.projectId, pair.goodProject)
    }
  }
})

// ---------------------------------------------------------------------------
// S4-05：路径边界——apps/server 拒绝越过项目根的 id
// ---------------------------------------------------------------------------

test('S4-05 路径边界：越过项目根目录的项目 id 被拒绝（400 invalid_project_id）', async () => {
  // 编码后的路径穿越：..%2f 解码进 param 为 '../proj_victim'，解析结果越出 PROJECTS_DIR
  // （纯 %2e%2e 在 URL 规范化阶段已被点段消解，到不了路由，天然安全；这里验证到达路由的穿越形态）
  const traversalWrite = await gameStudioApp.request('/api/projects/..%2fproj_victim/scripts', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scripts: {} })
  })
  assert.equal(traversalWrite.status, 400)
  const traversalBody = await traversalWrite.json()
  assert.equal(traversalBody.error, 'invalid_project_id')

  const traversalRead = await gameStudioApp.request('/api/projects/..%2fproj_victim')
  assert.equal(traversalRead.status, 400)
  assert.equal((await traversalRead.json()).error, 'invalid_project_id')

  // 合法 id 不受误伤：项目不存在走既有 404，而非边界拒绝
  const missing = await gameStudioApp.request('/api/projects/proj_f01_missing')
  assert.equal(missing.status, 404)
  assert.notEqual((await missing.json()).error, 'invalid_project_id')
})

test('S4-05 路径边界：携带他项目相对路径的写入被 E01 gate 拒绝', async () => {
  // 1x1 透明 PNG（真实图片字节）
  const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  const projectADir = path.join(STORAGE_ROOT, 'projects', 'proj_gate_a')
  const projectBDir = path.join(STORAGE_ROOT, 'projects', 'proj_gate_b')
  fs.mkdirSync(path.join(projectADir, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(projectBDir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(projectBDir, 'assets', 'secret.png'), pngBytes)
  fs.writeFileSync(path.join(projectADir, 'assets', 'ref.png'), pngBytes)

  // 任务 A 携带 projectB 的相对路径：即使目标文件真实存在，也越界拒绝
  const crossProject = await verifyStoryAssetReferenceFile({ dir: projectADir, assetPath: '../proj_gate_b/assets/secret.png' })
  assert.equal(crossProject.ok, false)
  assert.equal(crossProject.code, 'reference_path_outside_project')

  // 项目内合法路径正常放行（门禁不误伤）
  const legit = await verifyStoryAssetReferenceFile({ dir: projectADir, assetPath: 'assets/ref.png' })
  assert.equal(legit.ok, true)
})

// ---------------------------------------------------------------------------
// C01 窗口补强：projectId 回写队列 item
// ---------------------------------------------------------------------------

test('projectId 回写：空 projectId item 可回写，已有值/终态/缺失不覆盖', () => {
  // story 类任务创建时项目尚未生成：projectId=null 入队
  enqueueQueueItem({ sessionId: 'f01_s_bf1', projectId: null })
  assert.equal(readQueueItem('f01_s_bf1').projectId, null)

  // 项目创建/定位成功后回写：item 绑定项目，history 留证
  const backfilled = backfillQueueItemProjectId('f01_s_bf1', 'proj_backfill')
  assert.equal(backfilled.updated, true)
  assert.equal(backfilled.item.projectId, 'proj_backfill')
  assert.ok(backfilled.item.history.some((h) => String(h.reason).includes('project_id_backfilled:proj_backfill')))
  // 回写后该任务计入项目配额（C01 窗口关闭：同 project 冲突可被串行与配额识别）
  const quota = evaluateProjectQuota({ projectId: 'proj_backfill' })
  assert.equal(quota.ok, false)
  assert.deepEqual(quota.activeSessionIds, ['f01_s_bf1'])

  // 已有 projectId 不覆盖（先入证据不可篡改）
  const again = backfillQueueItemProjectId('f01_s_bf1', 'proj_other')
  assert.equal(again.updated, false)
  assert.equal(readQueueItem('f01_s_bf1').projectId, 'proj_backfill')

  // 终态 item 不回写
  enqueueQueueItem({ sessionId: 'f01_s_bf2', projectId: null })
  updateQueueItem('f01_s_bf2', (current) => ({ ...current, status: REASONING_QUEUE_ITEM_STATE.COMPLETED }))
  assert.equal(backfillQueueItemProjectId('f01_s_bf2', 'proj_backfill').updated, false)
  assert.equal(readQueueItem('f01_s_bf2').projectId, null)

  // item 缺失 / 空 projectId：no-op
  assert.deepEqual(backfillQueueItemProjectId('f01_s_missing', 'proj_backfill'), { updated: false, item: null })
  assert.equal(backfillQueueItemProjectId('f01_s_bf1', '').updated, false)
})

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

test('cleanup：恢复 env，无 worker 遗留 timer', () => {
  restoreEnv()
})
