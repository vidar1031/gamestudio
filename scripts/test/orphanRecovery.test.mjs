import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Hono } from 'hono'
import {
  ORPHAN_REASON_SERVER_RESTART,
  ORPHAN_REASON_HEARTBEAT_EXPIRED,
  ORPHAN_BLOCK_REASON,
  determineOrphanReason,
  evaluateOrphanRecovery,
  scanAndConvergeOrphanedSessions,
  resolveMaxRecoveryCount
} from '../../apps/control-server/src/server/reasoning/orphanRecovery.js'
import { writeStepCheckpoint } from '../../apps/control-server/src/server/reasoning/stepCheckpoint.js'
import { registerReasoningRoutes } from '../../apps/control-server/src/server/routes/reasoningRoutes.js'

// 隔离 checkpoint 目录，不污染真实 state/
const CHECKPOINT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-checkpoints-'))
const SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-sessions-'))
const savedCheckpointDirEnv = process.env.HERMES_REASONING_CHECKPOINT_DIR
const savedMaxRecoveryEnv = process.env.HERMES_REASONING_MAX_RECOVERY_COUNT
// HERMES-H01：治理审计文件同样隔离，recover 路由的审计记录不写入真实 state/
const AUDIT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-audit-')), 'audit.jsonl')
const savedAuditFileEnv = process.env.HERMES_GOVERNANCE_AUDIT_FILE
process.env.HERMES_REASONING_CHECKPOINT_DIR = CHECKPOINT_DIR
process.env.HERMES_GOVERNANCE_AUDIT_FILE = AUDIT_FILE
delete process.env.HERMES_REASONING_MAX_RECOVERY_COUNT

function restoreEnv() {
  if (savedCheckpointDirEnv === undefined) delete process.env.HERMES_REASONING_CHECKPOINT_DIR
  else process.env.HERMES_REASONING_CHECKPOINT_DIR = savedCheckpointDirEnv
  if (savedMaxRecoveryEnv === undefined) delete process.env.HERMES_REASONING_MAX_RECOVERY_COUNT
  else process.env.HERMES_REASONING_MAX_RECOVERY_COUNT = savedMaxRecoveryEnv
  if (savedAuditFileEnv === undefined) delete process.env.HERMES_GOVERNANCE_AUDIT_FILE
  else process.env.HERMES_GOVERNANCE_AUDIT_FILE = savedAuditFileEnv
}

function makeSession(sessionId, overrides = {}) {
  return {
    sessionId,
    status: 'running',
    submissionContext: { projectId: 'proj_1' },
    artifacts: {},
    events: [],
    stateTransitions: [],
    plan: { steps: [{ stepId: 's0' }, { stepId: 's1' }, { stepId: 's2' }] },
    ...overrides
  }
}

function makeStep(stepId) {
  return { stepId, action: 'read_file', tool: 'fs.read', title: stepId, params: {} }
}

function writeSessionFile(dir, session) {
  fs.writeFileSync(path.join(dir, `${session.sessionId}.json`), JSON.stringify(session, null, 2), 'utf8')
}

function readSessionFile(dir, sessionId) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${sessionId}.json`), 'utf8'))
}

// 注入 scan 的 session 存取实现：直接操作临时目录文件
function makeSessionStore(dir) {
  const events = []
  return {
    events,
    updateSession(sessionId, updater) {
      const current = readSessionFile(dir, sessionId)
      const next = { ...updater(current), updatedAt: new Date().toISOString() }
      writeSessionFile(dir, next)
      return next
    },
    appendEvent(sessionId, type, title, summary, extra = {}) {
      events.push({ sessionId, type, title, summary, ...extra })
    }
  }
}

function buildRecoverTestApp(session, runAllImpl) {
  writeSessionFile(SESSION_DIR, session)
  const store = makeSessionStore(SESSION_DIR)
  const calls = { runAll: [] }
  const stubConfig = { provider: 'p', baseUrl: 'u', model: 'm' }
  const controlState = {
    config: { saved: true, savedFingerprint: 'fp' },
    model: { status: 'loaded', provider: 'p', baseUrl: 'u', model: 'm' },
    preflight: { ready: true, configFingerprint: 'fp' }
  }
  const context = {
    hermesAgentDefinition: { id: 'hermes-manager' },
    readReasoningSession: (sessionId) => {
      try {
        return readSessionFile(SESSION_DIR, sessionId)
      } catch {
        return null
      }
    },
    updateReasoningSession: store.updateSession,
    appendReasoningEvent: store.appendEvent,
    clearReasoningReview: () => {},
    getHermesRuntimeState: () => ({ state: 'running' }),
    getHermesControlState: () => controlState,
    getPersistedHermesControlConfig: () => stubConfig,
    getHermesControlConfigFingerprint: () => 'fp',
    buildConfigValidation: () => ({ ready: true }),
    // AUTO-C01：发起门禁与入队改由 context 注入（core 统一实现）
    buildReasoningStartBlocker: () => null,
    dispatchReasoningSession: () => {},
    buildHermesBinding: () => ({}),
    readHermesChatHistory: () => [],
    runAllReasoningStepsFrom: (...args) => {
      calls.runAll.push(args)
      return runAllImpl ? runAllImpl(...args) : Promise.resolve()
    },
    markReasoningSessionFailed: () => {},
    // HERMES-H01：治理审计记录 taskId 需读 queue item；本用例不涉及队列，置空即可
    readQueueItem: () => null
  }
  const app = new Hono()
  registerReasoningRoutes(app, context)
  return { app, calls, store }
}

function postRecover(app, sessionId, body = {}) {
  return app.request(`/api/control/agents/hermes-manager/reasoning-sessions/${sessionId}/recover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

// ---------- determineOrphanReason ----------

test('determineOrphanReason: 终态 session 不会被判定为 orphan', () => {
  for (const status of ['completed', 'blocked', 'cancelled', 'timeout']) {
    const result = determineOrphanReason({ sessionId: 's', status }, { assumeRestart: true })
    assert.equal(result.orphan, false, `status=${status}`)
  }
})

test('determineOrphanReason: failed session 不转 orphan（保留失败证据与 retry 路径）', () => {
  const result = determineOrphanReason({ sessionId: 's', status: 'failed' }, { assumeRestart: true })
  assert.equal(result.orphan, false)
})

test('determineOrphanReason: 重启扫描时所有非终结 active 状态都判定为 orphan', () => {
  for (const status of ['queued', 'running', 'waiting_review', 'pausing', 'paused', 'resuming', 'retry_wait']) {
    const result = determineOrphanReason({ sessionId: 's', status }, { assumeRestart: true })
    assert.equal(result.orphan, true, `status=${status}`)
    assert.equal(result.reason, ORPHAN_REASON_SERVER_RESTART)
  }
})

test('determineOrphanReason: 心跳过期判定 heartbeat_expired', () => {
  const nowMs = Date.now()
  const session = { sessionId: 's', status: 'running', updatedAt: new Date(nowMs - 120000).toISOString() }
  const result = determineOrphanReason(session, { assumeRestart: false, heartbeatTimeoutMs: 30000, nowMs })
  assert.equal(result.orphan, true)
  assert.equal(result.reason, ORPHAN_REASON_HEARTBEAT_EXPIRED)
})

test('determineOrphanReason: 心跳未过期不判 orphan', () => {
  const nowMs = Date.now()
  const session = { sessionId: 's', status: 'running', updatedAt: new Date(nowMs - 5000).toISOString() }
  const result = determineOrphanReason(session, { assumeRestart: false, heartbeatTimeoutMs: 30000, nowMs })
  assert.equal(result.orphan, false)
})

test('determineOrphanReason: 无心跳证据时不猜测', () => {
  const result = determineOrphanReason({ sessionId: 's', status: 'running' }, { assumeRestart: false })
  assert.equal(result.orphan, false)
})

test('determineOrphanReason: 已 orphaned 不重复判定（由扫描器直接评估资格）', () => {
  const result = determineOrphanReason({ sessionId: 's', status: 'orphaned' }, { assumeRestart: true })
  assert.equal(result.orphan, false)
})

// ---------- evaluateOrphanRecovery ----------

test('evaluateOrphanRecovery: checkpoint 缺失 -> checkpoint_missing', () => {
  const result = evaluateOrphanRecovery(makeSession('eval_missing'))
  assert.equal(result.recoverable, false)
  assert.equal(result.reason, ORPHAN_BLOCK_REASON.CHECKPOINT_MISSING)
})

test('evaluateOrphanRecovery: 证据完整 -> recoverable 且 nextStepIndex 正确', () => {
  const sessionId = 'eval_ok'
  const session = makeSession(sessionId)
  writeStepCheckpoint(session, makeStep('s0'), 0)
  writeStepCheckpoint(session, makeStep('s1'), 1)

  const result = evaluateOrphanRecovery(makeSession(sessionId, { status: 'orphaned' }))
  assert.equal(result.recoverable, true)
  assert.equal(result.checkpointStepIndex, 1)
  assert.equal(result.nextStepIndex, 2)
  assert.ok(result.checkpoint)
})

test('evaluateOrphanRecovery: 最新 checkpoint JSON 损坏 -> checkpoint_corrupt', () => {
  const sessionId = 'eval_corrupt_json'
  writeStepCheckpoint(makeSession(sessionId), makeStep('s0'), 0)
  fs.writeFileSync(path.join(CHECKPOINT_DIR, `${sessionId}_step_1.json`), 'not-json{{{', 'utf8')

  const result = evaluateOrphanRecovery(makeSession(sessionId, { status: 'orphaned' }))
  assert.equal(result.recoverable, false)
  assert.equal(result.reason, ORPHAN_BLOCK_REASON.CHECKPOINT_CORRUPT)
})

test('evaluateOrphanRecovery: 最新 checkpoint 结构非法 -> checkpoint_corrupt', () => {
  const sessionId = 'eval_corrupt_shape'
  fs.writeFileSync(
    path.join(CHECKPOINT_DIR, `${sessionId}_step_0.json`),
    JSON.stringify({ sessionId, stepIndex: 0, nextStepIndex: 5 }),
    'utf8'
  )

  const result = evaluateOrphanRecovery(makeSession(sessionId, { status: 'orphaned' }))
  assert.equal(result.recoverable, false)
  assert.equal(result.reason, ORPHAN_BLOCK_REASON.CHECKPOINT_CORRUPT)
})

test('evaluateOrphanRecovery: session 侧恢复次数超限 -> recovery_limit_exceeded', () => {
  const sessionId = 'eval_limit_session'
  writeStepCheckpoint(makeSession(sessionId), makeStep('s0'), 0)

  const session = makeSession(sessionId, { status: 'orphaned', artifacts: { checkpointRecoveryCount: 3 } })
  const result = evaluateOrphanRecovery(session, { maxRecoveryCount: 3 })
  assert.equal(result.recoverable, false)
  assert.equal(result.reason, ORPHAN_BLOCK_REASON.RECOVERY_LIMIT_EXCEEDED)
})

test('evaluateOrphanRecovery: checkpoint 侧恢复次数同样计入上限', () => {
  const sessionId = 'eval_limit_checkpoint'
  // checkpoint.recoveryCount 来自写入时 session.artifacts.checkpointRecoveryCount
  writeStepCheckpoint(makeSession(sessionId, { artifacts: { checkpointRecoveryCount: 3 } }), makeStep('s0'), 0)

  const result = evaluateOrphanRecovery(makeSession(sessionId, { status: 'orphaned' }), { maxRecoveryCount: 3 })
  assert.equal(result.recoverable, false)
  assert.equal(result.reason, ORPHAN_BLOCK_REASON.RECOVERY_LIMIT_EXCEEDED)
})

test('resolveMaxRecoveryCount: 默认 3，可配置', () => {
  assert.equal(resolveMaxRecoveryCount(undefined), 3)
  assert.equal(resolveMaxRecoveryCount(5), 5)
  assert.equal(resolveMaxRecoveryCount(0), 3)
})

// ---------- scanAndConvergeOrphanedSessions（模拟重启） ----------

test('scan: running + 证据完整 -> orphaned，记录原因与转移事件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'))
  const sessionId = 'scan_orphan'
  writeSessionFile(dir, makeSession(sessionId, { status: 'running' }))
  writeStepCheckpoint(makeSession(sessionId), makeStep('s0'), 0)

  const store = makeSessionStore(dir)
  const summary = scanAndConvergeOrphanedSessions({
    sessionDirs: [dir],
    updateSession: store.updateSession,
    appendEvent: store.appendEvent,
    assumeRestart: true
  })

  assert.equal(summary.orphaned, 1)
  assert.equal(summary.blocked, 0)
  assert.deepEqual(summary.errors, [])

  const persisted = readSessionFile(dir, sessionId)
  assert.equal(persisted.status, 'orphaned')
  assert.equal(persisted.artifacts.orphanReason, ORPHAN_REASON_SERVER_RESTART)
  assert.ok(persisted.artifacts.orphanedAt)
  const transition = persisted.stateTransitions.at(-1)
  assert.equal(transition.from, 'running')
  assert.equal(transition.to, 'orphaned')
  assert.equal(transition.reason, ORPHAN_REASON_SERVER_RESTART)
  assert.ok(store.events.some((e) => e.type === 'session_orphaned'))
})

test('scan: running + checkpoint 缺失 -> orphaned 再转 blocked，不猜测继续', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'))
  const sessionId = 'scan_blocked'
  writeSessionFile(dir, makeSession(sessionId, { status: 'running' }))

  const store = makeSessionStore(dir)
  const summary = scanAndConvergeOrphanedSessions({
    sessionDirs: [dir],
    updateSession: store.updateSession,
    appendEvent: store.appendEvent,
    assumeRestart: true
  })

  assert.equal(summary.blocked, 1)

  const persisted = readSessionFile(dir, sessionId)
  assert.equal(persisted.status, 'blocked')
  assert.equal(persisted.artifacts.orphanBlockedReason, ORPHAN_BLOCK_REASON.CHECKPOINT_MISSING)
  assert.ok(String(persisted.error).length > 0)
  const transitions = persisted.stateTransitions.map((t) => `${t.from}->${t.to}`)
  assert.deepEqual(transitions, ['running->orphaned', 'orphaned->blocked'])
  assert.ok(store.events.some((e) => e.type === 'session_orphaned'))
  assert.ok(store.events.some((e) => e.type === 'session_orphan_blocked'))
})

test('scan: 终态 session 不会被扫描为 orphan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'))
  for (const status of ['completed', 'blocked', 'cancelled', 'timeout']) {
    const sessionId = `scan_terminal_${status}`
    writeSessionFile(dir, makeSession(sessionId, { status }))
  }

  const store = makeSessionStore(dir)
  const summary = scanAndConvergeOrphanedSessions({
    sessionDirs: [dir],
    updateSession: store.updateSession,
    appendEvent: store.appendEvent,
    assumeRestart: true
  })

  assert.equal(summary.terminalSkipped, 4)
  assert.equal(summary.orphaned, 0)
  assert.equal(summary.blocked, 0)
  for (const status of ['completed', 'blocked', 'cancelled', 'timeout']) {
    const persisted = readSessionFile(dir, `scan_terminal_${status}`)
    assert.equal(persisted.status, status)
    assert.equal(persisted.stateTransitions.length, 0)
  }
  assert.equal(store.events.length, 0)
})

test('scan: failed session 不动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'))
  const sessionId = 'scan_failed'
  writeSessionFile(dir, makeSession(sessionId, { status: 'failed', error: 'step failed' }))

  const store = makeSessionStore(dir)
  const summary = scanAndConvergeOrphanedSessions({
    sessionDirs: [dir],
    updateSession: store.updateSession,
    appendEvent: store.appendEvent,
    assumeRestart: true
  })

  assert.equal(summary.failedSkipped, 1)
  const persisted = readSessionFile(dir, sessionId)
  assert.equal(persisted.status, 'failed')
  assert.equal(persisted.error, 'step failed')
})

test('scan: 已 orphaned 且证据完整 -> 保持 orphaned，不重复转移', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'))
  const sessionId = 'scan_already'
  writeSessionFile(dir, makeSession(sessionId, {
    status: 'orphaned',
    artifacts: { orphanReason: ORPHAN_REASON_SERVER_RESTART },
    stateTransitions: [{ from: 'running', to: 'orphaned', reason: ORPHAN_REASON_SERVER_RESTART, timestamp: new Date().toISOString() }]
  }))
  writeStepCheckpoint(makeSession(sessionId), makeStep('s0'), 0)

  const store = makeSessionStore(dir)
  const summary = scanAndConvergeOrphanedSessions({
    sessionDirs: [dir],
    updateSession: store.updateSession,
    appendEvent: store.appendEvent,
    assumeRestart: true
  })

  assert.equal(summary.alreadyOrphaned, 1)
  const persisted = readSessionFile(dir, sessionId)
  assert.equal(persisted.status, 'orphaned')
  assert.equal(persisted.stateTransitions.length, 1)
})

test('scan: 已 orphaned 但 checkpoint 损坏 -> blocked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'))
  const sessionId = 'scan_already_corrupt'
  writeSessionFile(dir, makeSession(sessionId, { status: 'orphaned' }))
  fs.writeFileSync(path.join(CHECKPOINT_DIR, `${sessionId}_step_0.json`), '{{{corrupt', 'utf8')

  const store = makeSessionStore(dir)
  const summary = scanAndConvergeOrphanedSessions({
    sessionDirs: [dir],
    updateSession: store.updateSession,
    appendEvent: store.appendEvent,
    assumeRestart: true
  })

  assert.equal(summary.blocked, 1)
  const persisted = readSessionFile(dir, sessionId)
  assert.equal(persisted.status, 'blocked')
  assert.equal(persisted.artifacts.orphanBlockedReason, ORPHAN_BLOCK_REASON.CHECKPOINT_CORRUPT)
})

test('scan: 旧隐式状态 pending 归一为 queued 后收敛为 orphaned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'))
  const sessionId = 'scan_legacy_pending'
  writeSessionFile(dir, makeSession(sessionId, { status: 'pending' }))
  writeStepCheckpoint(makeSession(sessionId), makeStep('s0'), 0)

  const store = makeSessionStore(dir)
  const summary = scanAndConvergeOrphanedSessions({
    sessionDirs: [dir],
    updateSession: store.updateSession,
    appendEvent: store.appendEvent,
    assumeRestart: true
  })

  assert.equal(summary.orphaned, 1)
  const persisted = readSessionFile(dir, sessionId)
  assert.equal(persisted.status, 'orphaned')
})

test('scan: 两个目录下同一 sessionId 只处理一次', () => {
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-a-'))
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-b-'))
  const sessionId = 'scan_dedupe'
  writeSessionFile(dir1, makeSession(sessionId, { status: 'running' }))
  writeSessionFile(dir2, makeSession(sessionId, { status: 'running' }))
  writeStepCheckpoint(makeSession(sessionId), makeStep('s0'), 0)

  const store = makeSessionStore(dir1)
  const summary = scanAndConvergeOrphanedSessions({
    sessionDirs: [dir1, dir2],
    updateSession: store.updateSession,
    appendEvent: store.appendEvent,
    assumeRestart: true
  })

  assert.equal(summary.scannedFiles, 2)
  assert.equal(summary.sessions, 1)
  assert.equal(summary.orphaned, 1)
})

// ---------- recover 路由 ----------

test('recover: 证据完整的 orphan 仅从 checkpoint 的 nextStepIndex 恢复', async () => {
  const sessionId = 'route_ok'
  writeStepCheckpoint(makeSession(sessionId), makeStep('s0'), 0)
  writeStepCheckpoint(makeSession(sessionId), makeStep('s1'), 1)
  const { app, calls } = buildRecoverTestApp(makeSession(sessionId, {
    status: 'orphaned',
    artifacts: { orphanReason: ORPHAN_REASON_SERVER_RESTART }
  }))

  const res = await postRecover(app, sessionId)
  const body = await res.json()

  assert.equal(res.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.stepIndex, 2)
  // 已成功 step 不重跑：执行入口收到的 startIndex 就是 checkpoint 的 nextStepIndex
  assert.equal(calls.runAll.length, 1)
  assert.equal(calls.runAll[0][0], sessionId)
  assert.equal(calls.runAll[0][3], 2)

  const persisted = readSessionFile(SESSION_DIR, sessionId)
  assert.equal(persisted.status, 'running')
  assert.equal(persisted.artifacts.nextStepIndex, 2)
  assert.equal(persisted.artifacts.checkpointRecoveryCount, 1)
  assert.ok(persisted.artifacts.recoveredFromOrphanAt)
  assert.equal(persisted.error, null)
  const transition = persisted.stateTransitions.at(-1)
  assert.equal(transition.from, 'orphaned')
  assert.equal(transition.to, 'running')
})

test('recover: 客户端指定与 nextStepIndex 相同的 stepIndex 允许', async () => {
  const sessionId = 'route_same_index'
  writeStepCheckpoint(makeSession(sessionId), makeStep('s0'), 0)
  const { app, calls } = buildRecoverTestApp(makeSession(sessionId, { status: 'orphaned' }))

  const res = await postRecover(app, sessionId, { stepIndex: 1 })
  const body = await res.json()

  assert.equal(res.status, 200)
  assert.equal(body.stepIndex, 1)
  assert.equal(calls.runAll.length, 1)
})

test('recover: 客户端指定越过/回退 checkpoint 的 stepIndex -> 409 且不执行', async () => {
  const sessionId = 'route_bad_index'
  writeStepCheckpoint(makeSession(sessionId), makeStep('s0'), 0)
  writeStepCheckpoint(makeSession(sessionId), makeStep('s1'), 1)
  const { app, calls } = buildRecoverTestApp(makeSession(sessionId, { status: 'orphaned' }))

  for (const badIndex of [0, 1, 3]) {
    const res = await postRecover(app, sessionId, { stepIndex: badIndex })
    const body = await res.json()
    assert.equal(res.status, 409, `stepIndex=${badIndex}`)
    assert.equal(body.error, 'step_index_not_allowed')
    assert.equal(body.nextStepIndex, 2)
  }
  assert.equal(calls.runAll.length, 0)
  assert.equal(readSessionFile(SESSION_DIR, sessionId).status, 'orphaned')
})

test('recover: 不可恢复 orphan -> 409 并转 blocked', async () => {
  const sessionId = 'route_blocked'
  const { app, calls } = buildRecoverTestApp(makeSession(sessionId, { status: 'orphaned' }))

  const res = await postRecover(app, sessionId)
  const body = await res.json()

  assert.equal(res.status, 409)
  assert.equal(body.error, 'reasoning_session_not_recoverable')
  assert.equal(body.reason, ORPHAN_BLOCK_REASON.CHECKPOINT_MISSING)
  assert.equal(calls.runAll.length, 0)

  const persisted = readSessionFile(SESSION_DIR, sessionId)
  assert.equal(persisted.status, 'blocked')
  assert.equal(persisted.artifacts.orphanBlockedReason, ORPHAN_BLOCK_REASON.CHECKPOINT_MISSING)
})

test('recover: 恢复次数超限 -> 409 并转 blocked', async () => {
  const sessionId = 'route_limit'
  writeStepCheckpoint(makeSession(sessionId), makeStep('s0'), 0)
  const { app, calls } = buildRecoverTestApp(makeSession(sessionId, {
    status: 'orphaned',
    artifacts: { checkpointRecoveryCount: 3 }
  }))

  const res = await postRecover(app, sessionId)
  const body = await res.json()

  assert.equal(res.status, 409)
  assert.equal(body.reason, ORPHAN_BLOCK_REASON.RECOVERY_LIMIT_EXCEEDED)
  assert.equal(calls.runAll.length, 0)
  assert.equal(readSessionFile(SESSION_DIR, sessionId).status, 'blocked')
})

test('recover: 非 orphaned 状态 -> 409（旧 failed+restart 语义不再支持）', async () => {
  const sessionId = 'route_legacy_failed'
  const { app, calls } = buildRecoverTestApp(makeSession(sessionId, {
    status: 'failed',
    error: '服务器重启，本次 session 被中断（orphaned by server restart）'
  }))

  const res = await postRecover(app, sessionId)
  const body = await res.json()

  assert.equal(res.status, 409)
  assert.equal(body.error, 'reasoning_session_not_recoverable')
  assert.equal(body.status, 'failed')
  assert.equal(calls.runAll.length, 0)
  assert.equal(readSessionFile(SESSION_DIR, sessionId).status, 'failed')
})

test('recover: 重复恢复幂等安全，不重复触发执行', async () => {
  const sessionId = 'route_idempotent'
  writeStepCheckpoint(makeSession(sessionId), makeStep('s0'), 0)

  let releaseExecution
  const execution = new Promise((resolve) => { releaseExecution = resolve })
  const { app, calls } = buildRecoverTestApp(makeSession(sessionId, { status: 'orphaned' }), () => execution)

  const first = await postRecover(app, sessionId)
  assert.equal(first.status, 200)
  assert.equal((await first.json()).ok, true)

  // 恢复执行进行中：第二次请求返回幂等结果，不重复触发
  const second = await postRecover(app, sessionId)
  const secondBody = await second.json()
  assert.equal(second.status, 200)
  assert.equal(secondBody.ok, true)
  assert.equal(secondBody.idempotent, true)
  assert.equal(calls.runAll.length, 1)

  // 执行结束后 in-flight 清除；此时 session 已是 running，再次恢复被拒绝
  releaseExecution()
  await execution
  await new Promise((resolve) => setImmediate(resolve))
  const third = await postRecover(app, sessionId)
  const thirdBody = await third.json()
  assert.equal(third.status, 409)
  assert.equal(thirdBody.error, 'reasoning_session_not_recoverable')
  assert.equal(calls.runAll.length, 1)
})

test('teardown', () => {
  restoreEnv()
  fs.rmSync(CHECKPOINT_DIR, { recursive: true, force: true })
  fs.rmSync(SESSION_DIR, { recursive: true, force: true })
})
