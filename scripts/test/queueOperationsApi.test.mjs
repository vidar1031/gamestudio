import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Hono } from 'hono'
import { registerReasoningRoutes } from '../../apps/control-server/src/server/routes/reasoningRoutes.js'
import {
  enqueueQueueItem,
  readQueueItem,
  updateQueueItem,
  listQueueItems,
  resetQueueItemForManualRetry
} from '../../apps/control-server/src/server/reasoning/persistentQueue.js'
import { listStepCheckpoints, readLatestStepCheckpoint } from '../../apps/control-server/src/server/reasoning/stepCheckpoint.js'

// AUTO-D01 测试：队列/task 只读运维视图与人工重试受控端点（S3-05/S3-06）。
// env 隔离：queue / checkpoint 目录指向临时目录，不污染真实 state/；
// session 存取用内存 mock（镜像 updateReasoningSession 语义），队列用真实持久化实现。

const QUEUE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-ops-'))
const CHECKPOINT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-ops-checkpoints-'))
const savedQueueDirEnv = process.env.HERMES_REASONING_QUEUE_DIR
const savedCheckpointDirEnv = process.env.HERMES_REASONING_CHECKPOINT_DIR
// HERMES-H01：治理审计文件隔离，retry 路由的审计记录不写入真实 state/
const AUDIT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'queue-ops-audit-')), 'audit.jsonl')
const savedAuditFileEnv = process.env.HERMES_GOVERNANCE_AUDIT_FILE
process.env.HERMES_REASONING_QUEUE_DIR = QUEUE_DIR
process.env.HERMES_REASONING_CHECKPOINT_DIR = CHECKPOINT_DIR
process.env.HERMES_GOVERNANCE_AUDIT_FILE = AUDIT_FILE

function restoreEnv() {
  if (savedQueueDirEnv === undefined) delete process.env.HERMES_REASONING_QUEUE_DIR
  else process.env.HERMES_REASONING_QUEUE_DIR = savedQueueDirEnv
  if (savedCheckpointDirEnv === undefined) delete process.env.HERMES_REASONING_CHECKPOINT_DIR
  else process.env.HERMES_REASONING_CHECKPOINT_DIR = savedCheckpointDirEnv
  if (savedAuditFileEnv === undefined) delete process.env.HERMES_GOVERNANCE_AUDIT_FILE
  else process.env.HERMES_GOVERNANCE_AUDIT_FILE = savedAuditFileEnv
}

let seq = 0
function nextId(prefix) {
  seq += 1
  return `${prefix}_${seq}`
}

function makeSession(sessionId, overrides = {}) {
  return {
    sessionId,
    status: 'queued',
    title: '做一个互动故事',
    userPrompt: '做一个互动故事',
    submissionContext: { projectId: null },
    artifacts: {},
    events: [],
    stateTransitions: [],
    currentStepId: null,
    currentStepIndex: null,
    review: null,
    plan: { steps: [{ stepId: 's0', title: '生成故事草稿', action: 'write' }, { stepId: 's1', title: '校验故事', action: 'validate' }] },
    ...overrides
  }
}

// 内存 session 存储 + 可注入门禁的 context 工厂
function makeHarness({ runtimeState = 'running', startBlocker = null } = {}) {
  const sessions = new Map()
  const calls = { dispatch: [], events: [] }
  const context = {
    hermesAgentDefinition: { id: 'hermes-manager' },
    readReasoningSession: (sessionId) => sessions.get(sessionId) || null,
    updateReasoningSession: (sessionId, updater) => {
      const current = sessions.get(sessionId)
      if (!current) throw new Error('reasoning_session_not_found')
      const next = { ...updater(current), updatedAt: new Date().toISOString() }
      sessions.set(sessionId, next)
      return next
    },
    appendReasoningEvent: (sessionId, type, title, summary, extra = {}) => {
      calls.events.push({ sessionId, type, title, summary })
      const current = sessions.get(sessionId)
      if (current) {
        current.events = [...(current.events || []), { type, title, summary, timestamp: new Date().toISOString(), ...extra }]
      }
    },
    clearReasoningReview: () => {},
    getHermesRuntimeState: () => ({ state: runtimeState }),
    getHermesControlState: () => ({}),
    buildReasoningStartBlocker: () => startBlocker,
    buildHermesBinding: () => ({}),
    readHermesChatHistory: () => [],
    createReasoningSession: async () => { throw new Error('not_used') },
    persistHermesChatPrompt: () => {},
    persistHermesChatReply: () => {},
    dispatchReasoningSession: (sessionId) => { calls.dispatch.push(sessionId) },
    markReasoningSessionFailed: () => {},
    listReasoningSessions: () => [],
    // AUTO-D01：队列只读视图与人工重试（真实持久化实现 + 临时目录）
    listQueueItems,
    readQueueItem,
    resetQueueItemForManualRetry,
    listStepCheckpoints,
    readLatestStepCheckpoint
  }
  const app = new Hono()
  registerReasoningRoutes(app, context)
  return { app, sessions, calls }
}

function writeCheckpoint(sessionId, stepIndex) {
  const filePath = path.join(CHECKPOINT_DIR, `${sessionId}_step_${stepIndex}.json`)
  fs.writeFileSync(filePath, JSON.stringify({
    version: '1',
    sessionId,
    stepId: `s${stepIndex}`,
    stepIndex,
    nextStepIndex: stepIndex + 1,
    completedAt: new Date().toISOString()
  }), 'utf8')
}

// ---------------------------------------------------------------------------
// S3-05：队列只读列表——join session 摘要（状态/当前步骤/原因），损坏文件留证
// ---------------------------------------------------------------------------

test('GET /api/control/queue/items：返回 item + session 摘要（状态、当前步骤、重试、原因）', async () => {
  const { app, sessions } = makeHarness()
  const activeId = nextId('ops_active')
  const terminalId = nextId('ops_terminal')
  sessions.set(activeId, makeSession(activeId, {
    status: 'retry_wait',
    currentStepIndex: 0,
    error: 'model_http_503'
  }))
  sessions.set(terminalId, makeSession(terminalId, { status: 'completed', currentStepIndex: 1 }))
  enqueueQueueItem({ sessionId: activeId, projectId: 'proj_a' })
  updateQueueItem(activeId, (current) => ({
    ...current,
    retryCount: 1,
    nextAttemptAt: '2026-08-15T12:00:00.000Z',
    updatedAt: '2026-08-15T01:00:00.000Z'
  }))
  enqueueQueueItem({ sessionId: terminalId, projectId: 'proj_b' })
  updateQueueItem(terminalId, (current) => ({ ...current, status: 'completed', updatedAt: '2026-08-15T02:00:00.000Z' }))

  const res = await app.request('/api/control/queue/items')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.count, 2)
  // 非终态在前
  assert.equal(body.items[0].sessionId, activeId)
  assert.equal(body.items[0].status, 'queued')
  assert.equal(body.items[0].retryCount, 1)
  assert.equal(body.items[0].nextAttemptAt, '2026-08-15T12:00:00.000Z')
  assert.equal(body.items[0].projectId, 'proj_a')
  assert.equal(body.items[0].session.status, 'retry_wait')
  assert.equal(body.items[0].session.error, 'model_http_503')
  assert.equal(body.items[0].session.currentStepIndex, 0)
  assert.equal(body.items[0].session.stepCount, 2)
  assert.equal(body.items[1].sessionId, terminalId)
  assert.equal(body.items[1].status, 'completed')
})

test('GET /api/control/queue/items：session 缺失不猜测（session=null），损坏 item 计入 errors', async () => {
  const { app } = makeHarness()
  const orphanItemId = nextId('ops_missing_session')
  enqueueQueueItem({ sessionId: orphanItemId })
  fs.writeFileSync(path.join(QUEUE_DIR, 'corrupt_item.json'), '{not-json', 'utf8')

  const res = await app.request('/api/control/queue/items')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  const view = body.items.find((entry) => entry.sessionId === orphanItemId)
  assert.ok(view)
  assert.equal(view.session, null)
  assert.ok(body.errors.some((entry) => entry.file === 'corrupt_item.json'))
})

// ---------------------------------------------------------------------------
// S3-05：队列详情——item 全量 + 证据索引（checkpoint / 重试计划 / 最近事件）
// ---------------------------------------------------------------------------

test('GET /api/control/queue/items/:sessionId：返回证据索引（checkpoint、retryPolicy、最近事件）', async () => {
  const { app, sessions } = makeHarness()
  const sessionId = nextId('ops_detail')
  sessions.set(sessionId, makeSession(sessionId, {
    status: 'failed',
    error: 'model_http_503',
    currentStepIndex: 0,
    artifacts: { retryPolicy: { retryCount: 2, maxAttempts: 3, nextAttemptAt: null } },
    events: [
      { type: 'queue_retry_scheduled', title: '任务进入重试等待', summary: '第 1 次重试', timestamp: '2026-08-15T00:00:00.000Z' },
      { type: 'queue_retry_exhausted', title: '重试次数已达上限', summary: '收敛为 failed', timestamp: '2026-08-15T01:00:00.000Z' }
    ]
  }))
  enqueueQueueItem({ sessionId })
  updateQueueItem(sessionId, (current) => ({
    ...current,
    status: 'failed',
    retryCount: 2,
    retryHistory: [
      { attempt: 1, scheduledAt: '2026-08-15T00:00:00.000Z', nextAttemptAt: '2026-08-15T00:01:00.000Z', rule: 'network_error', reason: '网络错误' },
      { attempt: 2, scheduledAt: '2026-08-15T00:05:00.000Z', nextAttemptAt: '2026-08-15T00:10:00.000Z', rule: 'network_error', reason: '网络错误' }
    ]
  }))
  writeCheckpoint(sessionId, 0)

  const res = await app.request(`/api/control/queue/items/${sessionId}`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.item.sessionId, sessionId)
  assert.equal(body.item.retryHistory.length, 2)
  assert.equal(body.session.status, 'failed')
  assert.equal(body.session.currentStep.title, '生成故事草稿')
  assert.equal(body.evidence.checkpoints.length, 1)
  assert.equal(body.evidence.checkpoints[0].stepIndex, 0)
  assert.equal(body.evidence.latestCheckpoint.nextStepIndex, 1)
  assert.equal(body.evidence.retryPolicy.retryCount, 2)
  assert.equal(body.evidence.recentEvents.length, 2)
  assert.equal(body.evidence.recentEvents[1].type, 'queue_retry_exhausted')
})

test('GET /api/control/queue/items/:sessionId：item 不存在返回 404', async () => {
  const { app } = makeHarness()
  const res = await app.request('/api/control/queue/items/no_such_item')
  assert.equal(res.status, 404)
  const body = await res.json()
  assert.equal(body.error, 'queue_item_not_found')
})

// ---------------------------------------------------------------------------
// S3-06：人工重试——受控 API，成功/失败/阻断原因全部透传
// ---------------------------------------------------------------------------

test('POST retry：failed + 终态 item -> 200，session 转 queued，item 重置并清空退避、保留重试记录', async () => {
  const { app, sessions, calls } = makeHarness()
  const sessionId = nextId('ops_retry')
  sessions.set(sessionId, makeSession(sessionId, { status: 'failed', error: 'model_http_503' }))
  enqueueQueueItem({ sessionId, projectId: 'proj_retry' })
  updateQueueItem(sessionId, (current) => ({
    ...current,
    status: 'failed',
    retryCount: 3,
    nextAttemptAt: null,
    lastError: 'model_http_503',
    retryHistory: [{ attempt: 3, scheduledAt: '2026-08-15T00:00:00.000Z', rule: 'network_error' }]
  }))

  const res = await app.request(`/api/control/agents/hermes-manager/reasoning-sessions/${sessionId}/retry`, { method: 'POST' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.session.status, 'queued')
  assert.equal(body.session.error, null)
  // item 重置：queued、重试预算重新获得、退避窗口清空、历史记录保留
  assert.equal(body.item.status, 'queued')
  assert.equal(body.item.retryCount, 0)
  assert.equal(body.item.nextAttemptAt, null)
  assert.equal(body.item.lastError, null)
  assert.equal(body.item.retryHistory.length, 1)
  // dispatch 被调用（幂等入队 + 唤醒 worker）
  assert.deepEqual(calls.dispatch, [sessionId])
  // 状态转移与事件留证
  const session = sessions.get(sessionId)
  assert.ok(session.stateTransitions.some((t) => t.from === 'failed' && t.to === 'queued'))
  assert.ok(calls.events.some((e) => e.type === 'queue_manual_retry'))
})

test('POST retry：failed 但 queue item 缺失（历史 session）-> 200，走 dispatch 创建新 item', async () => {
  const { app, sessions, calls } = makeHarness()
  const sessionId = nextId('ops_retry_legacy')
  sessions.set(sessionId, makeSession(sessionId, { status: 'failed', error: 'plan_failed' }))

  const res = await app.request(`/api/control/agents/hermes-manager/reasoning-sessions/${sessionId}/retry`, { method: 'POST' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.session.status, 'queued')
  assert.deepEqual(calls.dispatch, [sessionId])
})

test('POST retry：非 failed 状态 -> 409 阻断原因透传', async () => {
  const { app, sessions } = makeHarness()
  const sessionId = nextId('ops_retry_running')
  sessions.set(sessionId, makeSession(sessionId, { status: 'running' }))

  const res = await app.request(`/api/control/agents/hermes-manager/reasoning-sessions/${sessionId}/retry`, { method: 'POST' })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.error, 'reasoning_session_not_retryable')
  assert.equal(body.status, 'running')
  assert.ok(body.detail)
})

test('POST retry：failed 但 item 仍在调度中 -> 409 queue_item_active', async () => {
  const { app, sessions } = makeHarness()
  const sessionId = nextId('ops_retry_active')
  sessions.set(sessionId, makeSession(sessionId, { status: 'failed' }))
  enqueueQueueItem({ sessionId })
  updateQueueItem(sessionId, (current) => ({ ...current, status: 'running' }))

  const res = await app.request(`/api/control/agents/hermes-manager/reasoning-sessions/${sessionId}/retry`, { method: 'POST' })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.error, 'queue_item_active')
  assert.equal(body.status, 'running')
})

test('POST retry：runtime 未运行 -> 409 runtime_not_running', async () => {
  const { app, sessions } = makeHarness({ runtimeState: 'stopped' })
  const sessionId = nextId('ops_retry_stopped')
  sessions.set(sessionId, makeSession(sessionId, { status: 'failed' }))

  const res = await app.request(`/api/control/agents/hermes-manager/reasoning-sessions/${sessionId}/retry`, { method: 'POST' })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.error, 'runtime_not_running')
})

test('POST retry：左脑门禁未就绪 -> 409 阻断原因透传', async () => {
  const blocker = { error: 'left_brain_model_not_loaded', details: '模型未启动，请先加载模型。' }
  const { app, sessions } = makeHarness({ startBlocker: blocker })
  const sessionId = nextId('ops_retry_blocked')
  sessions.set(sessionId, makeSession(sessionId, { status: 'failed' }))

  const res = await app.request(`/api/control/agents/hermes-manager/reasoning-sessions/${sessionId}/retry`, { method: 'POST' })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.error, 'left_brain_model_not_loaded')
  assert.equal(body.details, '模型未启动，请先加载模型。')
})

test('POST retry：session 不存在 -> 404', async () => {
  const { app } = makeHarness()
  const res = await app.request('/api/control/agents/hermes-manager/reasoning-sessions/no_such_session/retry', { method: 'POST' })
  assert.equal(res.status, 404)
  const body = await res.json()
  assert.equal(body.error, 'reasoning_session_not_found')
})

// ---------------------------------------------------------------------------
// resetQueueItemForManualRetry 纯函数语义
// ---------------------------------------------------------------------------

test('resetQueueItemForManualRetry：终态可重置；非终态与缺失拒绝', () => {
  const terminalId = nextId('ops_reset_terminal')
  enqueueQueueItem({ sessionId: terminalId })
  updateQueueItem(terminalId, (current) => ({ ...current, status: 'failed', retryCount: 2 }))
  const reset = resetQueueItemForManualRetry(terminalId)
  assert.equal(reset.status, 'queued')
  assert.equal(reset.retryCount, 0)

  const activeId = nextId('ops_reset_active')
  enqueueQueueItem({ sessionId: activeId })
  assert.throws(() => resetQueueItemForManualRetry(activeId), /queue_item_not_terminal:queued/)
  assert.throws(() => resetQueueItemForManualRetry('no_such_item'), /queue_item_not_found/)
})

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

test('cleanup：恢复 env', () => {
  restoreEnv()
})
