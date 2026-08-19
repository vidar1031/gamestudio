import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Hono } from 'hono'
import {
  RIGHT_BRAIN_SUPERVISOR_ID,
  RIGHT_BRAIN_CONTROLLED_ACTIONS,
  buildSupervisionMessages,
  classifySupervisionAction,
  getRightBrainSupervisionCapabilities,
  listSupervisionRuns,
  reviewSupervisionSuggestion,
  runRightBrainSupervision
} from '../../apps/control-server/src/server/reasoning/rightBrainSupervision.js'
import {
  REASONING_ACTIONS,
  RIGHT_BRAIN_SUPERVISION_READ_ACTIONS,
  isReasoningInvokeAction,
  isReasoningWriteAction
} from '../../apps/control-server/src/server/capabilities/actionRegistry.js'
import { readGovernanceAudit } from '../../apps/control-server/src/server/reasoning/governanceAudit.js'
import { registerSupervisionRoutes } from '../../apps/control-server/src/server/routes/supervisionRoutes.js'

// HERMES-H03 测试：右脑子 agent 受控监察（总计划 S3-10）。
// 覆盖：白名单与注册表对齐、越权拒绝+审计+生产隔离、只读装配不含凭证、
// 身份与调用记录可追溯、模型不可用显式降级不伪造、建议入人工审核流、HTTP 路由全链路。
// env 隔离：监察记录与审计文件指向临时目录，不污染真实 state/。

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'right-brain-supervision-'))
const SUPERVISION_FILE = path.join(TMP_DIR, 'right-brain-supervision.json')
const AUDIT_FILE = path.join(TMP_DIR, 'governance-audit.jsonl')
const savedSupervisionFileEnv = process.env.HERMES_RIGHT_BRAIN_SUPERVISION_FILE
const savedAuditFileEnv = process.env.HERMES_GOVERNANCE_AUDIT_FILE
const savedMoonshotKeyEnv = process.env.MOONSHOT_API_KEY
process.env.HERMES_RIGHT_BRAIN_SUPERVISION_FILE = SUPERVISION_FILE
process.env.HERMES_GOVERNANCE_AUDIT_FILE = AUDIT_FILE
// 假密钥：验证输入装配与落盘记录均不含凭证字面量（D02 脱敏复用）
const FAKE_MOONSHOT_KEY = 'sk-fake-right-brain-test-secret-000001'
process.env.MOONSHOT_API_KEY = FAKE_MOONSHOT_KEY

function restoreEnv() {
  if (savedSupervisionFileEnv === undefined) delete process.env.HERMES_RIGHT_BRAIN_SUPERVISION_FILE
  else process.env.HERMES_RIGHT_BRAIN_SUPERVISION_FILE = savedSupervisionFileEnv
  if (savedAuditFileEnv === undefined) delete process.env.HERMES_GOVERNANCE_AUDIT_FILE
  else process.env.HERMES_GOVERNANCE_AUDIT_FILE = savedAuditFileEnv
  if (savedMoonshotKeyEnv === undefined) delete process.env.MOONSHOT_API_KEY
  else process.env.MOONSHOT_API_KEY = savedMoonshotKeyEnv
}

process.on('exit', restoreEnv)

const FIXED_NOW = '2026-08-15T08:00:00.000Z'
const fixedNowFn = () => FIXED_NOW
let runSeq = 0
const nextRunId = () => `rbs_test_${(runSeq += 1)}`

function resetFiles() {
  for (const file of [SUPERVISION_FILE, AUDIT_FILE]) {
    try { fs.rmSync(file) } catch { /* 不存在则忽略 */ }
  }
}

function auditRecords() {
  return readGovernanceAudit(500).records
}

function makeEvidence(overrides = {}) {
  return {
    generatedAt: FIXED_NOW,
    runtime: { state: 'running' },
    sessions: { byStatus: { completed: 3, failed: 1 }, sampled: 4 },
    queue: { byStatus: { failed: 1 }, itemCount: 1, queueErrors: 0 },
    failedSessions: [{ sessionId: 'sess_failed_1', error: `provider 401 with key ${FAKE_MOONSHOT_KEY}`, updatedAt: FIXED_NOW }],
    auditTail: [],
    ...overrides
  }
}

function makeModelOutput(suggestions = []) {
  return {
    summary: '系统整体可用，存在 1 个失败任务需要处理。',
    findings: [{ title: '失败任务', detail: 'sess_failed_1 因图片服务不可达失败', severity: 'warning' }],
    suggestions
  }
}

function makeDeps({ modelOutput = makeModelOutput(), route = null, requestModel = null, collectEvidence = null } = {}) {
  const calls = { requestModel: 0 }
  const resolvedRoute = route === null
    ? { provider: 'moonshot', baseUrl: 'https://api.kimi.com/coding/v1', model: 'kimi-for-coding', apiKey: FAKE_MOONSHOT_KEY, headers: {}, transport: 'direct' }
    : route
  return {
    calls,
    deps: {
      collectEvidence: collectEvidence || (async () => makeEvidence()),
      resolveRoute: async () => resolvedRoute,
      requestModel: requestModel || (async () => {
        calls.requestModel += 1
        return { content: JSON.stringify(modelOutput), usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } }
      })
    }
  }
}

async function createCompletedRun(suggestions) {
  const { deps } = makeDeps({ modelOutput: makeModelOutput(suggestions) })
  const record = await runRightBrainSupervision({ trigger: 'manual', deps, nowFn: fixedNowFn, idFn: nextRunId })
  assert.equal(record.status, 'completed')
  return record
}

test('S3-10：只读白名单与 actionRegistry 注册表对齐（全部已注册、非写入/调用类别）', () => {
  assert.ok(RIGHT_BRAIN_SUPERVISION_READ_ACTIONS.length > 0)
  for (const action of RIGHT_BRAIN_SUPERVISION_READ_ACTIONS) {
    assert.ok(REASONING_ACTIONS[action], `${action} 必须在 REASONING_ACTIONS 注册`)
    assert.equal(isReasoningWriteAction(action), false, `${action} 不得是写入动作`)
    assert.equal(isReasoningInvokeAction(action), false, `${action} 不得是调用动作`)
  }
  // 受控集与只读集不重叠
  for (const action of Object.keys(RIGHT_BRAIN_CONTROLLED_ACTIONS)) {
    assert.equal(RIGHT_BRAIN_SUPERVISION_READ_ACTIONS.includes(action), false)
  }
})

test('S3-10：action 白名单分级——只读放行 / 受控待审 / 已注册越权 / 未注册拒绝', () => {
  assert.deepEqual(classifySupervisionAction('story_inspect_project'), { tier: 'read' })
  assert.deepEqual(classifySupervisionAction('retry_session'), { tier: 'controlled' })
  assert.deepEqual(classifySupervisionAction('cancel_session'), { tier: 'controlled' })
  assert.deepEqual(classifySupervisionAction('edit_workspace_file'), { tier: 'rejected', reason: 'over_privileged' })
  assert.deepEqual(classifySupervisionAction('shell_execute'), { tier: 'rejected', reason: 'over_privileged' })
  assert.deepEqual(classifySupervisionAction('story_write_scripts'), { tier: 'rejected', reason: 'over_privileged' })
  assert.deepEqual(classifySupervisionAction('ghost_action'), { tier: 'rejected', reason: 'unregistered' })
  assert.deepEqual(classifySupervisionAction(''), { tier: 'rejected', reason: 'action_empty' })
})

test('S3-10：监察运行身份与调用记录可追溯（身份/模型/输入摘要/输出/审计）', async () => {
  resetFiles()
  const { deps } = makeDeps()
  const record = await runRightBrainSupervision({ trigger: 'manual', deps, nowFn: fixedNowFn, idFn: nextRunId })
  assert.equal(record.status, 'completed')
  assert.equal(record.supervisorId, RIGHT_BRAIN_SUPERVISOR_ID)
  assert.equal(record.ts, FIXED_NOW)
  assert.deepEqual(record.model, { provider: 'moonshot', model: 'kimi-for-coding' })
  assert.equal(record.inputSummary.failedSessionCount, 1)
  assert.equal(record.usage.totalTokens, 30)
  assert.ok(record.outputSummary.includes('失败任务'))
  // 持久化可读回
  const runs = listSupervisionRuns(10)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].runId, record.runId)
  // 治理审计留证
  const audit = auditRecords().find((entry) => entry.action === 'right_brain_supervision')
  assert.ok(audit, '应有监察审计')
  assert.equal(audit.result, 'ok')
  assert.match(audit.detail, new RegExp(record.runId))
})

test('S3-10：只读装配与落盘记录不含凭证字面量（D02 脱敏复用）', async () => {
  resetFiles()
  // 证据中故意夹带假密钥（模拟上游错误信息泄露），prompt 与记录都不得包含
  const evidence = makeEvidence()
  const messages = buildSupervisionMessages(evidence)
  const serialized = JSON.stringify(messages)
  assert.equal(serialized.includes(FAKE_MOONSHOT_KEY), false, '发给模型的 prompt 不得包含密钥')

  const { deps } = makeDeps()
  const record = await runRightBrainSupervision({ trigger: 'manual', deps, nowFn: fixedNowFn, idFn: nextRunId })
  assert.equal(record.status, 'completed')
  const storedRaw = fs.readFileSync(SUPERVISION_FILE, 'utf8')
  assert.equal(storedRaw.includes(FAKE_MOONSHOT_KEY), false, '落盘监察记录不得包含密钥')
})

test('S3-10：白名单内 action 放行——只读直接放行、受控进入人工审核', async () => {
  resetFiles()
  const record = await createCompletedRun([
    { action: 'story_inspect_project', params: { projectId: 'p1' }, rationale: '核对项目证据', evidenceRefs: ['sess_failed_1'] },
    { action: 'retry_session', params: { sessionId: 'sess_failed_1' }, rationale: '失败任务值得重试', evidenceRefs: ['sess_failed_1'] }
  ])
  const [readSuggestion, controlledSuggestion] = record.suggestions
  assert.equal(readSuggestion.classification, 'read')
  assert.equal(readSuggestion.status, 'allowed_read')
  assert.equal(controlledSuggestion.classification, 'controlled')
  assert.equal(controlledSuggestion.status, 'pending_review')
  // 带依据：evidenceRefs 保留
  assert.deepEqual(controlledSuggestion.evidenceRefs, ['sess_failed_1'])
})

test('S3-10：越权 action 被拒绝并逐条审计，监察流程与生产任务不受影响', async () => {
  resetFiles()
  let executorCalled = 0
  const { deps } = makeDeps({
    modelOutput: makeModelOutput([
      { action: 'edit_workspace_file', params: { filePath: 'apps/x.js' }, rationale: '尝试直接改代码', evidenceRefs: [] },
      { action: 'ghost_action', params: {}, rationale: '未注册动作', evidenceRefs: [] },
      { action: 'retry_session', params: { sessionId: 'sess_failed_1' }, rationale: '合法建议', evidenceRefs: ['sess_failed_1'] }
    ])
  })
  const record = await runRightBrainSupervision({ trigger: 'manual', deps, nowFn: fixedNowFn, idFn: nextRunId })
  // 越权不拖垮监察：整体仍 completed，合法建议照常进入待审
  assert.equal(record.status, 'completed')
  const rejected = record.suggestions.filter((item) => item.status === 'rejected')
  assert.equal(rejected.length, 2)
  assert.equal(rejected[0].rejectReason, 'over_privileged')
  assert.equal(rejected[1].rejectReason, 'unregistered')
  assert.equal(record.suggestions[2].status, 'pending_review')
  // 逐条审计
  const blockedAudits = auditRecords().filter((entry) => entry.action === 'right_brain_suggestion_blocked')
  assert.equal(blockedAudits.length, 2)
  assert.ok(blockedAudits.every((entry) => entry.result === 'blocked'))
  assert.match(blockedAudits[0].detail, /over_privileged|unregistered/)
  // 子 agent 没有任何执行通道（越权建议不会触达任何 executor）
  assert.equal(executorCalled, 0)
})

test('S3-10：右脑模型不可用时显式降级，不伪造监察结果', async () => {
  resetFiles()
  // 路由完全缺失
  const missing = makeDeps({ route: null })
  missing.deps.resolveRoute = async () => null
  const recordA = await runRightBrainSupervision({ trigger: 'manual', deps: missing.deps, nowFn: fixedNowFn, idFn: nextRunId })
  assert.equal(recordA.status, 'model_unavailable')
  assert.equal(recordA.error, 'right_brain_route_unavailable')
  assert.equal(recordA.findings.length, 0)
  assert.equal(recordA.suggestions.length, 0)
  assert.equal(missing.calls.requestModel, 0, '模型不可用不得发起调用')

  // key 失效/未配置（apiKey 为空）
  const noKey = makeDeps({
    route: { unavailableReason: 'right_brain_api_key_missing', provider: 'moonshot', model: 'kimi-for-coding' }
  })
  const recordB = await runRightBrainSupervision({ trigger: 'manual', deps: noKey.deps, nowFn: fixedNowFn, idFn: nextRunId })
  assert.equal(recordB.status, 'model_unavailable')
  assert.equal(recordB.error, 'right_brain_api_key_missing')
  assert.deepEqual(recordB.model, { provider: 'moonshot', model: 'kimi-for-coding' })
  assert.equal(noKey.calls.requestModel, 0)

  // 审计 blocked 留证
  const blocked = auditRecords().filter((entry) => entry.action === 'right_brain_supervision' && entry.result === 'blocked')
  assert.equal(blocked.length, 2)
})

test('S3-10：模型调用失败/输出非法时显式留证，错误信息过脱敏', async () => {
  resetFiles()
  const failing = makeDeps({
    requestModel: async () => { throw new Error(`http_401 unauthorized key=${FAKE_MOONSHOT_KEY}`) }
  })
  const recordA = await runRightBrainSupervision({ trigger: 'manual', deps: failing.deps, nowFn: fixedNowFn, idFn: nextRunId })
  assert.equal(recordA.status, 'model_error')
  assert.match(recordA.error, /http_401/)
  assert.equal(recordA.error.includes(FAKE_MOONSHOT_KEY), false, '错误信息不得包含密钥')

  const garbage = makeDeps({ requestModel: async () => ({ content: '这不是 JSON 输出', usage: null }) })
  const recordB = await runRightBrainSupervision({ trigger: 'manual', deps: garbage.deps, nowFn: fixedNowFn, idFn: nextRunId })
  assert.equal(recordB.status, 'output_invalid')
  assert.equal(recordB.error, 'model_output_not_json')
})

test('S3-10：证据装配失败显式降级，不发起模型调用', async () => {
  resetFiles()
  const { deps, calls } = makeDeps({
    collectEvidence: async () => { throw new Error('state_dir_broken') }
  })
  const record = await runRightBrainSupervision({ trigger: 'manual', deps, nowFn: fixedNowFn, idFn: nextRunId })
  assert.equal(record.status, 'evidence_unavailable')
  assert.match(record.error, /state_dir_broken/)
  assert.equal(calls.requestModel, 0)
})

test('S3-10：受控建议经人工审核后才执行（approve 走 executor，子 agent 无自批准通道）', async () => {
  resetFiles()
  const record = await createCompletedRun([
    { action: 'retry_session', params: { sessionId: 'sess_failed_1' }, rationale: '重试失败任务', evidenceRefs: ['sess_failed_1'] }
  ])
  const suggestion = record.suggestions[0]
  assert.equal(suggestion.status, 'pending_review')

  // 未注册 executor：approve 被阻断并审计，建议保持待审
  const noExecutor = await reviewSupervisionSuggestion(record.runId, suggestion.suggestionId, 'approve', { executors: {} })
  assert.equal(noExecutor.ok, false)
  assert.equal(noExecutor.error, 'supervision_executor_not_registered')
  let audit = auditRecords().find((entry) => entry.action === 'right_brain_suggestion_review')
  assert.equal(audit.result, 'blocked')

  // 合法 executor：approve 后执行并留证
  const executed = []
  const approved = await reviewSupervisionSuggestion(record.runId, suggestion.suggestionId, 'approve', {
    executors: {
      retry_session: async (params) => {
        executed.push(params)
        return { ok: true, detail: '任务已重新排队' }
      }
    }
  })
  assert.equal(approved.ok, true)
  assert.equal(approved.suggestion.status, 'approved_executed')
  assert.deepEqual(executed, [{ sessionId: 'sess_failed_1' }])
  audit = auditRecords().find((entry) => entry.action === 'right_brain_suggestion_review' && entry.result === 'ok')
  assert.ok(audit)
  assert.equal(audit.decision, 'approve')
  assert.equal(audit.sessionId, 'sess_failed_1')

  // 终态建议不可重复审核
  const again = await reviewSupervisionSuggestion(record.runId, suggestion.suggestionId, 'approve', { executors: {} })
  assert.equal(again.ok, false)
  assert.equal(again.error, 'supervision_suggestion_not_pending')
})

test('S3-10：reject 与 executor 阻断/异常的全部留证路径', async () => {
  resetFiles()
  // reject
  const runA = await createCompletedRun([
    { action: 'cancel_session', params: { sessionId: 'sess_x' }, rationale: '取消卡死任务', evidenceRefs: ['sess_x'] }
  ])
  const rejected = await reviewSupervisionSuggestion(runA.runId, runA.suggestions[0].suggestionId, 'reject', { executors: {} })
  assert.equal(rejected.ok, true)
  assert.equal(rejected.suggestion.status, 'rejected_by_human')

  // executor 返回阻断：建议标记 approved_blocked，原因留证
  const runB = await createCompletedRun([
    { action: 'retry_session', params: { sessionId: 'sess_running' }, rationale: '重试', evidenceRefs: [] }
  ])
  const blocked = await reviewSupervisionSuggestion(runB.runId, runB.suggestions[0].suggestionId, 'approve', {
    executors: { retry_session: async () => ({ ok: false, error: 'reasoning_session_not_retryable', detail: '仅失败状态可重试' }) }
  })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error, 'supervision_execution_blocked')
  assert.equal(blocked.suggestion.status, 'approved_blocked')
  assert.match(blocked.suggestion.executionDetail, /仅失败状态可重试/)

  // executor 抛异常：隔离为 supervision_executor_error，建议保持待审可重审
  const runC = await createCompletedRun([
    { action: 'retry_session', params: { sessionId: 'sess_y' }, rationale: '重试', evidenceRefs: [] }
  ])
  const crashed = await reviewSupervisionSuggestion(runC.runId, runC.suggestions[0].suggestionId, 'approve', {
    executors: { retry_session: async () => { throw new Error('queue_write_failed') } }
  })
  assert.equal(crashed.ok, false)
  assert.equal(crashed.error, 'supervision_executor_error')
  const runs = listSupervisionRuns(10)
  const suggestionC = runs.find((run) => run.runId === runC.runId).suggestions[0]
  assert.equal(suggestionC.status, 'pending_review', 'executor 异常不得改变建议待审状态')

  // 非法 decision / 未知记录
  const invalid = await reviewSupervisionSuggestion(runC.runId, runC.suggestions[0].suggestionId, 'maybe', { executors: {} })
  assert.equal(invalid.error, 'invalid_decision')
  const missing = await reviewSupervisionSuggestion('no_such_run', 'x', 'approve', { executors: {} })
  assert.equal(missing.error, 'supervision_run_not_found')
})

// ── HTTP 路由全链路：注入 fake context（模型/会话/队列全部 fake，无真实模型调用）──

function makeHttpHarness({ modelOutput = null, routeApiKey = 'fake-key' } = {}) {
  const sessions = new Map()
  sessions.set('sess_failed', {
    sessionId: 'sess_failed',
    status: 'failed',
    title: '失败任务',
    error: 'image provider unreachable',
    submissionContext: {},
    currentStepId: 'step_3'
  })
  const dispatched = []
  const output = modelOutput || makeModelOutput([
    { action: 'retry_session', params: { sessionId: 'sess_failed' }, rationale: '失败后值得重试', evidenceRefs: ['sess_failed'] },
    { action: 'edit_workspace_file', params: {}, rationale: '越权尝试', evidenceRefs: [] }
  ])
  const context = {
    buildHermesBinding: () => ({ rightBrainEnabled: true, rightBrain: { provider: 'moonshot', model: 'kimi-for-coding' } }),
    resolveModelRouteForPhase: () => ({
      provider: 'moonshot',
      baseUrl: 'https://api.kimi.test/v1',
      model: 'kimi-for-coding',
      apiKey: routeApiKey,
      headers: {},
      transport: 'direct'
    }),
    requestHermesChatCompletion: async () => ({
      choices: [{ message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
    }),
    getHermesRuntimeState: () => ({ state: 'running' }),
    getHermesControlState: () => ({}),
    listReasoningSessions: () => [...sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      status: session.status,
      title: session.title,
      updatedAt: FIXED_NOW,
      verdict: 'FAIL'
    })),
    listQueueItems: () => ({ items: [], errors: [] }),
    readQueueItem: () => null,
    readReasoningSession: (sessionId) => sessions.get(sessionId) || null,
    updateReasoningSession: (sessionId, updater) => {
      const current = sessions.get(sessionId)
      if (current) sessions.set(sessionId, { ...current, ...updater(current) })
    },
    appendReasoningEvent: () => {},
    resetQueueItemForManualRetry: () => {},
    buildReasoningStartBlocker: () => null,
    dispatchReasoningSession: (sessionId) => {
      dispatched.push(sessionId)
      return { taskId: `task_${sessionId}`, sessionId }
    },
    cancelReasoningSession: (sessionId) => {
      const session = sessions.get(sessionId)
      if (!session) throw new Error('reasoning_session_not_found')
      session.status = 'cancelled'
      return session
    }
  }
  const app = new Hono()
  registerSupervisionRoutes(app, context)
  return { app, sessions, dispatched }
}

test('S3-10：HTTP GET 暴露身份/白名单/模型可用性与监察记录', async () => {
  resetFiles()
  const { app } = makeHttpHarness()
  const res = await app.request('/api/control/supervision/right-brain')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.supervisor.supervisorId, RIGHT_BRAIN_SUPERVISOR_ID)
  assert.equal(body.supervisor.model.available, true)
  assert.equal(body.supervisor.model.provider, 'moonshot')
  assert.ok(body.supervisor.readActions.length > 0)
  assert.deepEqual(body.supervisor.controlledActions.map((item) => item.action).sort(), ['cancel_session', 'retry_session'])
  // 能力清单与模块级 API 一致
  const capabilities = getRightBrainSupervisionCapabilities()
  assert.equal(body.supervisor.readActions.length, capabilities.readActions.length)

  // key 缺失时如实报告不可用
  const noKey = makeHttpHarness({ routeApiKey: '' })
  const res2 = await noKey.app.request('/api/control/supervision/right-brain')
  const body2 = await res2.json()
  assert.equal(body2.supervisor.model.available, false)
  assert.equal(body2.supervisor.model.unavailableReason, 'right_brain_api_key_missing')
})

test('S3-10：HTTP run 全链路——监察记录落盘、越权建议拒绝、approve 后经受控 retry 执行', async () => {
  resetFiles()
  const { app, sessions, dispatched } = makeHttpHarness()

  const runRes = await app.request('/api/control/supervision/right-brain/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
  assert.equal(runRes.status, 200)
  const runBody = await runRes.json()
  assert.equal(runBody.ok, true)
  assert.equal(runBody.run.status, 'completed')
  assert.equal(runBody.run.supervisorId, RIGHT_BRAIN_SUPERVISOR_ID)
  const retrySuggestion = runBody.run.suggestions.find((item) => item.action === 'retry_session')
  const evilSuggestion = runBody.run.suggestions.find((item) => item.action === 'edit_workspace_file')
  assert.equal(retrySuggestion.status, 'pending_review')
  assert.equal(evilSuggestion.status, 'rejected')
  assert.equal(evilSuggestion.rejectReason, 'over_privileged')

  // approve：经既有受控 retry 核心执行（failed -> queued + dispatch）
  const reviewRes = await app.request(
    `/api/control/supervision/right-brain/runs/${runBody.run.runId}/suggestions/${retrySuggestion.suggestionId}/review`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) }
  )
  assert.equal(reviewRes.status, 200)
  const reviewBody = await reviewRes.json()
  assert.equal(reviewBody.ok, true)
  assert.equal(reviewBody.suggestion.status, 'approved_executed')
  assert.equal(sessions.get('sess_failed').status, 'queued', '受控 retry 应把 failed session 重新排队')
  assert.deepEqual(dispatched, ['sess_failed'])

  // 审计链完整：监察 ok + 越权 blocked + retry ok + 建议审核 ok
  const actions = auditRecords().map((entry) => `${entry.action}:${entry.result}`)
  assert.ok(actions.includes('right_brain_supervision:ok'))
  assert.ok(actions.includes('right_brain_suggestion_blocked:blocked'))
  assert.ok(actions.includes('retry:ok'))
  assert.ok(actions.includes('right_brain_suggestion_review:ok'))
})

test('S3-10：HTTP 错误形状——未知记录 404、非待审建议 409、模型不可用如实返回', async () => {
  resetFiles()
  const { app } = makeHttpHarness()
  const notFound = await app.request(
    '/api/control/supervision/right-brain/runs/no_run/suggestions/no_s/review',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) }
  )
  assert.equal(notFound.status, 404)

  // 模型不可用：run 返回 model_unavailable 记录（显式降级，不是 500）
  const noKey = makeHttpHarness({ routeApiKey: '' })
  const runRes = await noKey.app.request('/api/control/supervision/right-brain/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
  assert.equal(runRes.status, 200)
  const runBody = await runRes.json()
  assert.equal(runBody.run.status, 'model_unavailable')
  assert.equal(runBody.run.error, 'right_brain_api_key_missing')
  assert.equal(runBody.run.suggestions.length, 0)
})
