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
import {
  appendGovernanceAudit,
  readGovernanceAudit
} from '../../apps/control-server/src/server/reasoning/governanceAudit.js'

// HERMES-H01 测试：治理闭环 API（S3-05 查看一致性、S3-06 受控动作反馈与审计）。
// 覆盖：待审核中心、队列详情 artifact 证据、治理操作审计（成功与阻断都留证）。
// env 隔离：queue 目录与审计文件指向临时目录，不污染真实 state/；
// session 存取用内存 mock（镜像 updateReasoningSession 语义），队列用真实持久化实现。

const QUEUE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-queue-'))
const AUDIT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'governance-audit-')), 'audit.jsonl')
const savedQueueDirEnv = process.env.HERMES_REASONING_QUEUE_DIR
const savedAuditFileEnv = process.env.HERMES_GOVERNANCE_AUDIT_FILE
process.env.HERMES_REASONING_QUEUE_DIR = QUEUE_DIR
process.env.HERMES_GOVERNANCE_AUDIT_FILE = AUDIT_FILE

function restoreEnv() {
  if (savedQueueDirEnv === undefined) delete process.env.HERMES_REASONING_QUEUE_DIR
  else process.env.HERMES_REASONING_QUEUE_DIR = savedQueueDirEnv
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
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    plan: { steps: [{ stepId: 's0', title: '生成故事草稿', action: 'write' }, { stepId: 's1', title: '校验故事', action: 'validate' }] },
    ...overrides
  }
}

// 内存 session 存储 + 可注入门禁的 context 工厂（含审核路径所需的全部 stub）
function makeHarness({ runtimeState = 'running', startBlocker = null } = {}) {
  const sessions = new Map()
  const calls = { dispatch: [], events: [], reviewDecisions: [], resumed: [] }
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
    listReasoningSessions: () => [...sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      status: s.status,
      updatedAt: s.updatedAt
    })),
    appendReasoningEvent: (sessionId, type, title, summary, extra = {}) => {
      calls.events.push({ sessionId, type, title, summary })
      const current = sessions.get(sessionId)
      if (current) {
        current.events = [...(current.events || []), { type, title, summary, timestamp: new Date().toISOString(), ...extra }]
      }
    },
    clearReasoningReview: (sessionId) => {
      const current = sessions.get(sessionId)
      if (current) sessions.set(sessionId, { ...current, status: 'running', review: null })
    },
    cancelReasoningSession: (sessionId) => {
      const current = sessions.get(sessionId)
      if (!current) throw new Error('reasoning_session_not_found')
      const next = { ...current, status: 'cancelled' }
      sessions.set(sessionId, next)
      return next
    },
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
    persistReasoningReviewDecision: (sessionId, decision, review, correctionPrompt) => {
      calls.reviewDecisions.push({ sessionId, decision, correctionPrompt })
    },
    approveReasoningQualityOverride: async (sessionId) => sessions.get(sessionId),
    applyPreparedLifecycleScript: () => { throw new Error('not_used') },
    applyPreparedWorkspaceOperation: () => { throw new Error('not_used') },
    applyPreparedReasoningWrite: () => { throw new Error('not_used') },
    prepareReasoningSessionPlan: async () => {},
    continueReasoningSessionFromStep: async (sessionId, binding, history, options) => {
      calls.resumed.push({ sessionId, options })
    },
    runAllReasoningStepsFrom: async (sessionId, binding, history, stepIndex) => {
      calls.resumed.push({ sessionId, stepIndex })
    },
    // 队列只读视图与人工重试（真实持久化实现 + 临时目录）
    listQueueItems,
    readQueueItem,
    resetQueueItemForManualRetry,
    listStepCheckpoints: () => [],
    readLatestStepCheckpoint: () => null
  }
  const app = new Hono()
  registerReasoningRoutes(app, context)
  return { app, sessions, calls }
}

function readAuditRecords() {
  return readGovernanceAudit(500).records
}

// ---------------------------------------------------------------------------
// S3-05：待审核中心——waiting_review 任务集中呈现（审核不再散在聊天页）
// ---------------------------------------------------------------------------

test('GET /api/control/reviews/pending：无等待审核任务时返回空列表', async () => {
  const { app, sessions } = makeHarness()
  const runningId = nextId('gov_running')
  sessions.set(runningId, makeSession(runningId, { status: 'running' }))

  const res = await app.request('/api/control/reviews/pending')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.count, 0)
  assert.deepEqual(body.items, [])
})

test('GET /api/control/reviews/pending：返回 review 详情与队列状态，按 updatedAt 倒序，排除其他状态', async () => {
  const { app, sessions } = makeHarness()
  const olderId = nextId('gov_review_old')
  const newerId = nextId('gov_review_new')
  const runningId = nextId('gov_review_running')
  sessions.set(olderId, makeSession(olderId, {
    status: 'waiting_review',
    updatedAt: '2026-08-15T01:00:00.000Z',
    review: { title: '确认任务计划', summary: '计划包含 2 个步骤', targetType: 'plan', reviewPhase: 'standard', stepIndex: null, stepId: null }
  }))
  sessions.set(newerId, makeSession(newerId, {
    status: 'waiting_review',
    updatedAt: '2026-08-15T02:00:00.000Z',
    submissionContext: { projectId: 'proj_gov' },
    review: { title: '确认写入', summary: null, targetType: 'step', reviewPhase: 'before_execution', stepIndex: 1, stepId: 's1' }
  }))
  sessions.set(runningId, makeSession(runningId, { status: 'running', updatedAt: '2026-08-15T03:00:00.000Z' }))
  enqueueQueueItem({ sessionId: newerId, projectId: 'proj_gov', taskId: 'task_gov_new' })
  updateQueueItem(newerId, (current) => ({ ...current, status: 'running' }))

  const res = await app.request('/api/control/reviews/pending')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.count, 2)
  // 最新在前
  assert.equal(body.items[0].sessionId, newerId)
  assert.equal(body.items[1].sessionId, olderId)
  // review 详情完整
  assert.equal(body.items[0].review.title, '确认写入')
  assert.equal(body.items[0].review.targetType, 'step')
  assert.equal(body.items[0].review.stepIndex, 1)
  assert.equal(body.items[0].projectId, 'proj_gov')
  // 队列状态 join
  assert.equal(body.items[0].queueItem.status, 'running')
  assert.equal(body.items[0].queueItem.taskId, 'task_gov_new')
  assert.equal(body.items[1].queueItem, null)
})

// ---------------------------------------------------------------------------
// S3-05：队列详情 artifact 证据（产物可追溯）
// ---------------------------------------------------------------------------

test('GET /api/control/queue/items/:sessionId：证据含 artifact 索引（项目目录/最终回答预览截断）', async () => {
  const { app, sessions } = makeHarness()
  const sessionId = nextId('gov_artifacts')
  const longAnswer = '故事完成。'.repeat(200) // 超过预览上限
  sessions.set(sessionId, makeSession(sessionId, {
    status: 'completed',
    artifacts: {
      projectRoot: 'storage/projects/gov-demo',
      storyIndex: 3,
      finalAnswer: longAnswer
    }
  }))
  enqueueQueueItem({ sessionId })
  updateQueueItem(sessionId, (current) => ({ ...current, status: 'completed' }))

  const res = await app.request(`/api/control/queue/items/${sessionId}`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.evidence.artifacts.projectRoot, 'storage/projects/gov-demo')
  assert.equal(body.evidence.artifacts.storyIndex, 3)
  assert.equal(body.evidence.artifacts.finalAnswerPreview.length, 240)
  assert.ok(longAnswer.startsWith(body.evidence.artifacts.finalAnswerPreview))
})

// ---------------------------------------------------------------------------
// S3-06：治理操作审计——重试/取消/审核的成功与阻断都留证（可追溯 sessionId/taskId）
// ---------------------------------------------------------------------------

test('POST retry 成功写入审计（action=retry, result=ok, 含 taskId）', async () => {
  const { app, sessions } = makeHarness()
  const sessionId = nextId('gov_audit_retry')
  sessions.set(sessionId, makeSession(sessionId, { status: 'failed', error: 'model_http_503' }))
  enqueueQueueItem({ sessionId, taskId: 'task_audit_retry' })
  updateQueueItem(sessionId, (current) => ({ ...current, status: 'failed' }))

  const res = await app.request(`/api/control/agents/hermes-manager/reasoning-sessions/${sessionId}/retry`, { method: 'POST' })
  assert.equal(res.status, 200)

  const records = readAuditRecords()
  const record = records.find((entry) => entry.sessionId === sessionId && entry.action === 'retry')
  assert.ok(record)
  assert.equal(record.result, 'ok')
  assert.equal(record.taskId, 'task_audit_retry')
  assert.ok(record.ts)
})

test('POST retry 阻断写入审计（result=blocked，原因透传）', async () => {
  const { app, sessions } = makeHarness({ runtimeState: 'stopped' })
  const sessionId = nextId('gov_audit_retry_blocked')
  sessions.set(sessionId, makeSession(sessionId, { status: 'failed' }))

  const res = await app.request(`/api/control/agents/hermes-manager/reasoning-sessions/${sessionId}/retry`, { method: 'POST' })
  assert.equal(res.status, 409)

  const record = readAuditRecords().find((entry) => entry.sessionId === sessionId && entry.action === 'retry')
  assert.ok(record)
  assert.equal(record.result, 'blocked')
  assert.equal(record.detail, 'runtime_not_running')
})

test('POST cancel 成功写入审计（action=cancel, result=ok）', async () => {
  const { app, sessions } = makeHarness()
  const sessionId = nextId('gov_audit_cancel')
  sessions.set(sessionId, makeSession(sessionId, { status: 'running' }))

  const res = await app.request(`/api/control/agents/hermes-manager/reasoning-sessions/${sessionId}/cancel`, { method: 'POST' })
  assert.equal(res.status, 200)

  const record = readAuditRecords().find((entry) => entry.sessionId === sessionId && entry.action === 'cancel')
  assert.ok(record)
  assert.equal(record.result, 'ok')
  assert.equal(record.detail, 'session_status:cancelled')
})

test('POST review 批准成功写入审计（decision=approve）；非等待审核阻断也留证', async () => {
  const { app, sessions, calls } = makeHarness()
  const sessionId = nextId('gov_audit_review')
  sessions.set(sessionId, makeSession(sessionId, {
    status: 'waiting_review',
    review: { title: '确认任务计划', targetType: 'plan', reviewPhase: 'standard', stepIndex: null }
  }))
  enqueueQueueItem({ sessionId, taskId: 'task_audit_review' })
  updateQueueItem(sessionId, (current) => ({ ...current, status: 'running' }))

  const res = await app.request(`/api/control/agents/hermes-manager/reasoning-sessions/${sessionId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approve' })
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.deepEqual(calls.reviewDecisions, [{ sessionId, decision: 'approve', correctionPrompt: '' }])

  const record = readAuditRecords().find((entry) => entry.sessionId === sessionId && entry.action === 'review')
  assert.ok(record)
  assert.equal(record.result, 'ok')
  assert.equal(record.decision, 'approve')
  assert.equal(record.taskId, 'task_audit_review')

  // 同一 session 再次审核：状态已推进，返回 409 阻断并留证
  const res2 = await app.request(`/api/control/agents/hermes-manager/reasoning-sessions/${sessionId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approve' })
  })
  assert.equal(res2.status, 409)
  const blocked = readAuditRecords().filter((entry) => entry.sessionId === sessionId && entry.action === 'review' && entry.result === 'blocked')
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].detail, 'reasoning_session_not_waiting_review:running')
})

test('POST review 拒绝（含修正意见）写入审计（decision=reject）', async () => {
  const { app, sessions, calls } = makeHarness()
  const sessionId = nextId('gov_audit_reject')
  sessions.set(sessionId, makeSession(sessionId, {
    status: 'waiting_review',
    review: { title: '确认步骤结果', targetType: 'step', reviewPhase: 'after_execution', stepIndex: 0, stepId: 's0' }
  }))

  // 修正意见会触发提案入队（enqueueHumanCorrectionProposal 直写文件），
  // 本用例聚焦审计语义，修正意见留空；decision=reject 路径照常重跑
  const res = await app.request(`/api/control/agents/hermes-manager/reasoning-sessions/${sessionId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'reject' })
  })
  assert.equal(res.status, 200)
  assert.equal(calls.reviewDecisions[0]?.decision, 'reject')

  const record = readAuditRecords().find((entry) => entry.sessionId === sessionId && entry.action === 'review')
  assert.ok(record)
  assert.equal(record.result, 'ok')
  assert.equal(record.decision, 'reject')
})

// ---------------------------------------------------------------------------
// 审计读取端点：倒序、limit、损坏行计数
// ---------------------------------------------------------------------------

test('GET /api/control/governance/audit：最新在前、limit 生效、损坏行计入 skipped', async () => {
  const { app } = makeHarness()
  appendGovernanceAudit({ action: 'cancel', sessionId: 'audit_order_1', result: 'ok' })
  appendGovernanceAudit({ action: 'retry', sessionId: 'audit_order_2', result: 'blocked', detail: 'runtime_not_running' })
  fs.appendFileSync(AUDIT_FILE, '{corrupt-line\n', 'utf8')

  const res = await app.request('/api/control/governance/audit?limit=1')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.count, 1)
  assert.equal(body.records[0].sessionId, 'audit_order_2')

  const resAll = await app.request('/api/control/governance/audit')
  const bodyAll = await resAll.json()
  assert.ok(bodyAll.count >= 2)
  assert.ok(bodyAll.skipped >= 1)
  // 倒序：后写的在前
  const idx2 = bodyAll.records.findIndex((entry) => entry.sessionId === 'audit_order_2')
  const idx1 = bodyAll.records.findIndex((entry) => entry.sessionId === 'audit_order_1')
  assert.ok(idx2 !== -1 && idx1 !== -1 && idx2 < idx1)
})

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

test('cleanup：恢复 env', () => {
  restoreEnv()
})
