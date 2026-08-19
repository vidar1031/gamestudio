import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  resolveTaskTimeoutMs,
  resolveStepTimeoutMs,
  registerSessionCancelSignal,
  requestSessionCancel,
  isSessionCancelRequested,
  getSessionCancelReason,
  getSessionCancelSignal,
  clearSessionCancelSignal,
  getSessionCancelRegistrySize,
  getActiveDeadlineTimerCount,
  raceStepExecution,
  resolveStepDeadline,
  evaluateExecutionGate,
  buildTimeoutTransition,
  buildCancelledTransition,
  convergeSessionTermination
} from '../../apps/control-server/src/server/reasoning/taskDeadline.js'

// AUTO-B04 测试：超时、取消与资源收敛。
// env 隔离：超时压到毫秒级，不在测试里真实等待秒级默认超时。
// session 存取走临时目录，不污染真实 state/。

const SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'task-deadline-sessions-'))
const savedTaskTimeoutEnv = process.env.HERMES_REASONING_TASK_TIMEOUT_MS
const savedStepTimeoutEnv = process.env.HERMES_REASONING_STEP_TIMEOUT_MS
delete process.env.HERMES_REASONING_TASK_TIMEOUT_MS
delete process.env.HERMES_REASONING_STEP_TIMEOUT_MS

function restoreEnv() {
  if (savedTaskTimeoutEnv === undefined) delete process.env.HERMES_REASONING_TASK_TIMEOUT_MS
  else process.env.HERMES_REASONING_TASK_TIMEOUT_MS = savedTaskTimeoutEnv
  if (savedStepTimeoutEnv === undefined) delete process.env.HERMES_REASONING_STEP_TIMEOUT_MS
  else process.env.HERMES_REASONING_STEP_TIMEOUT_MS = savedStepTimeoutEnv
}

// 迟到 reject 观测：raceStepExecution 必须吞掉被遗弃 promise 的 reject
const lateUnhandledRejections = []
process.on('unhandledRejection', (error) => {
  lateUnhandledRejections.push(error instanceof Error ? error.message : String(error))
})

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function writeSessionFile(session) {
  fs.writeFileSync(path.join(SESSION_DIR, `${session.sessionId}.json`), JSON.stringify(session, null, 2), 'utf8')
}

function readSessionFile(sessionId) {
  return JSON.parse(fs.readFileSync(path.join(SESSION_DIR, `${sessionId}.json`), 'utf8'))
}

// 注入 converge 的 session 存取实现：直接操作临时目录文件（镜像 updateReasoningSession 语义）
function makeSessionStore() {
  const events = []
  return {
    events,
    read(sessionId) {
      try {
        return readSessionFile(sessionId)
      } catch {
        return null
      }
    },
    update(sessionId, updater) {
      const current = readSessionFile(sessionId)
      const next = { ...updater(current), updatedAt: new Date().toISOString() }
      writeSessionFile(next)
      return next
    },
    appendEvent(sessionId, type, title, summary, extra = {}) {
      events.push({ sessionId, type, title, summary, ...extra })
    }
  }
}

/**
 * 执行循环 harness：镜像 controlServerCore.runAllReasoningStepsFrom 的
 * AUTO-B04 控制流（注册信号 -> task deadline -> 每步门禁 -> race -> 分支收敛 -> finally 清理），
 * 使用与生产完全相同的 taskDeadline primitives，step 执行器注入。
 */
async function runLoopHarness({ sessionId, store, steps, taskTimeoutMs, stepTimeoutMs, executeStep }) {
  registerSessionCancelSignal(sessionId)
  const taskDeadlineAt = Date.now() + taskTimeoutMs
  try {
    for (let i = 0; i < steps.length; i++) {
      const currentSession = store.read(sessionId)
      const gate = evaluateExecutionGate({
        session: currentSession,
        cancelRequested: isSessionCancelRequested(sessionId),
        cancelReason: getSessionCancelReason(sessionId),
        taskDeadlineAt,
        nowMs: Date.now()
      })
      if (gate.action === 'stop') return
      if (gate.action === 'converge' && gate.outcome === 'cancelled') {
        convergeSessionTermination({
          sessionId, outcome: 'cancelled', reason: gate.reason,
          readSession: store.read, updateSession: store.update, appendEvent: store.appendEvent
        })
        return
      }
      if (gate.action === 'converge' && gate.outcome === 'task_timeout') {
        convergeSessionTermination({
          sessionId, outcome: 'timeout', reason: gate.reason, scope: 'task', timeoutMs: taskTimeoutMs,
          readSession: store.read, updateSession: store.update, appendEvent: store.appendEvent
        })
        return
      }
      const step = steps[i]
      const stepDeadline = resolveStepDeadline({ taskDeadlineAt, stepTimeoutMs, nowMs: Date.now() })
      const outcome = await raceStepExecution(executeStep(step, i), {
        timeoutMs: stepDeadline.timeoutMs,
        scope: stepDeadline.scope,
        signal: getSessionCancelSignal(sessionId)
      })
      if (outcome.kind === 'timeout') {
        convergeSessionTermination({
          sessionId, outcome: 'timeout',
          reason: `${outcome.scope}_deadline_exceeded: step ${step.stepId} 超过上限 ${outcome.timeoutMs}ms`,
          scope: outcome.scope, stepId: step.stepId, stepIndex: i, timeoutMs: outcome.timeoutMs,
          readSession: store.read, updateSession: store.update, appendEvent: store.appendEvent
        })
        return
      }
      if (outcome.kind === 'cancelled') {
        convergeSessionTermination({
          sessionId, outcome: 'cancelled',
          reason: getSessionCancelReason(sessionId) || 'reasoning_cancelled_by_user',
          readSession: store.read, updateSession: store.update, appendEvent: store.appendEvent
        })
        return
      }
      if (outcome.kind === 'rejected') throw outcome.error
      // resolved：镜像 nextStepIndex 推进
      store.update(sessionId, (s) => ({ ...s, artifacts: { ...s.artifacts, nextStepIndex: i + 1 } }))
    }
  } finally {
    clearSessionCancelSignal(sessionId)
  }
}

// ---------------------------------------------------------------------------
// env 配置解析
// ---------------------------------------------------------------------------

test('resolveTaskTimeoutMs：默认 2 小时', () => {
  assert.equal(resolveTaskTimeoutMs(), 7200000)
})

test('resolveStepTimeoutMs：默认 30 分钟', () => {
  assert.equal(resolveStepTimeoutMs(), 1800000)
})

test('resolveTaskTimeoutMs：env 与显式值覆盖，非法值回退默认', () => {
  process.env.HERMES_REASONING_TASK_TIMEOUT_MS = '1234'
  try {
    assert.equal(resolveTaskTimeoutMs(), 1234)
    assert.equal(resolveTaskTimeoutMs(567), 567)
  } finally {
    delete process.env.HERMES_REASONING_TASK_TIMEOUT_MS
  }
  assert.equal(resolveTaskTimeoutMs(0), 7200000)
  assert.equal(resolveTaskTimeoutMs(-5), 7200000)
  assert.equal(resolveTaskTimeoutMs('abc'), 7200000)
  assert.equal(resolveTaskTimeoutMs(1500.9), 1500)
})

test('resolveStepTimeoutMs：env 覆盖与非法回退', () => {
  process.env.HERMES_REASONING_STEP_TIMEOUT_MS = '50'
  try {
    assert.equal(resolveStepTimeoutMs(), 50)
  } finally {
    delete process.env.HERMES_REASONING_STEP_TIMEOUT_MS
  }
  assert.equal(resolveStepTimeoutMs(-1), 1800000)
})

// ---------------------------------------------------------------------------
// 取消信号 registry
// ---------------------------------------------------------------------------

test('取消信号：注册幂等，请求后 aborted 且记录首个 reason，重复请求幂等', () => {
  const id = 'reg_1'
  const entry1 = registerSessionCancelSignal(id)
  const entry2 = registerSessionCancelSignal(id)
  assert.equal(entry1, entry2)
  assert.equal(isSessionCancelRequested(id), false)

  const first = requestSessionCancel(id, 'reason_A')
  assert.equal(first.requested, true)
  assert.equal(first.reason, 'reason_A')
  assert.equal(isSessionCancelRequested(id), true)
  assert.equal(getSessionCancelReason(id), 'reason_A')
  assert.ok(getSessionCancelSignal(id)?.aborted)

  const second = requestSessionCancel(id, 'reason_B')
  assert.equal(second.requested, false)
  assert.equal(second.reason, 'reason_A') // 保留首个原因，事件可追溯

  clearSessionCancelSignal(id)
  assert.equal(isSessionCancelRequested(id), false)
  assert.equal(getSessionCancelSignal(id), null)
  assert.equal(getSessionCancelReason(id), null)
})

test('取消信号：clearSessionCancelSignal 后 registry 不遗留', () => {
  const base = getSessionCancelRegistrySize()
  registerSessionCancelSignal('reg_2')
  assert.equal(getSessionCancelRegistrySize(), base + 1)
  clearSessionCancelSignal('reg_2')
  assert.equal(getSessionCancelRegistrySize(), base)
  clearSessionCancelSignal('reg_2') // 重复清理幂等
  assert.equal(getSessionCancelRegistrySize(), base)
})

// ---------------------------------------------------------------------------
// raceStepExecution
// ---------------------------------------------------------------------------

test('raceStepExecution：resolved 透传值，timer 计数归零', async () => {
  const base = getActiveDeadlineTimerCount()
  const outcome = await raceStepExecution(Promise.resolve('ok'), { timeoutMs: 1000 })
  assert.equal(outcome.kind, 'resolved')
  assert.equal(outcome.value, 'ok')
  assert.equal(getActiveDeadlineTimerCount(), base)
})

test('raceStepExecution：rejected 透传错误，timer 计数归零', async () => {
  const base = getActiveDeadlineTimerCount()
  const outcome = await raceStepExecution(Promise.reject(new Error('boom')), { timeoutMs: 1000 })
  assert.equal(outcome.kind, 'rejected')
  assert.equal(outcome.error.message, 'boom')
  assert.equal(getActiveDeadlineTimerCount(), base)
})

test('raceStepExecution：卡住调用在显式 deadline 内结束为 timeout，迟到 reject 被吞掉', async () => {
  const base = getActiveDeadlineTimerCount()
  const unhandledBase = lateUnhandledRejections.length
  let rejectStuck = null
  const stuckPromise = new Promise((_, reject) => { rejectStuck = reject })
  const outcome = await raceStepExecution(stuckPromise, { timeoutMs: 25, scope: 'step' })
  assert.equal(outcome.kind, 'timeout')
  assert.equal(outcome.scope, 'step')
  assert.equal(outcome.timeoutMs, 25)
  assert.equal(getActiveDeadlineTimerCount(), base)

  // 被遗弃的执行 promise 迟到 reject：race 已挂空 catch，不得触发 unhandledRejection
  rejectStuck(new Error('late_failure'))
  await sleep(10)
  assert.equal(lateUnhandledRejections.length, unhandledBase)
})

test('raceStepExecution：预 aborted signal 立即返回 cancelled，不启动 timer', async () => {
  const base = getActiveDeadlineTimerCount()
  const controller = new AbortController()
  controller.abort('pre_cancelled')
  const outcome = await raceStepExecution(sleep(5000), { timeoutMs: 5000, signal: controller.signal })
  assert.equal(outcome.kind, 'cancelled')
  assert.equal(outcome.reason, 'pre_cancelled')
  assert.equal(getActiveDeadlineTimerCount(), base)
})

test('raceStepExecution：竞速中途 abort 立即返回 cancelled，timer 清理', async () => {
  const base = getActiveDeadlineTimerCount()
  const controller = new AbortController()
  const outcomePromise = raceStepExecution(sleep(5000), { timeoutMs: 5000, signal: controller.signal })
  await sleep(10)
  controller.abort('mid_cancel')
  const outcome = await outcomePromise
  assert.equal(outcome.kind, 'cancelled')
  assert.equal(outcome.reason, 'mid_cancel')
  assert.equal(getActiveDeadlineTimerCount(), base)
})

// ---------------------------------------------------------------------------
// resolveStepDeadline / evaluateExecutionGate
// ---------------------------------------------------------------------------

test('resolveStepDeadline：step 上限更紧为 step，task 剩余预算更紧为 task', () => {
  const now = Date.now()
  const stepScope = resolveStepDeadline({ taskDeadlineAt: now + 60000, stepTimeoutMs: 5000, nowMs: now })
  assert.deepEqual(stepScope, { timeoutMs: 5000, scope: 'step' })
  const taskScope = resolveStepDeadline({ taskDeadlineAt: now + 3000, stepTimeoutMs: 5000, nowMs: now })
  assert.equal(taskScope.scope, 'task')
  assert.ok(taskScope.timeoutMs <= 3000 && taskScope.timeoutMs >= 1)
  // task 已过期：clamp 到 1ms，scope 仍为 task
  const expired = resolveStepDeadline({ taskDeadlineAt: now - 10, stepTimeoutMs: 5000, nowMs: now })
  assert.deepEqual(expired, { timeoutMs: 1, scope: 'task' })
})

test('evaluateExecutionGate：缺失/终态/取消/超时/正常与优先级', () => {
  const now = Date.now()
  assert.deepEqual(evaluateExecutionGate({ session: null }), { action: 'stop', outcome: 'missing' })
  assert.equal(evaluateExecutionGate({ session: { status: 'cancelled' } }).outcome, 'terminal')
  assert.equal(evaluateExecutionGate({ session: { status: 'timeout' } }).outcome, 'terminal')
  assert.equal(evaluateExecutionGate({ session: { status: 'completed' } }).outcome, 'terminal')
  assert.equal(evaluateExecutionGate({ session: { status: 'blocked' } }).outcome, 'terminal')

  const cancel = evaluateExecutionGate({ session: { status: 'running' }, cancelRequested: true, cancelReason: 'r1' })
  assert.deepEqual(cancel, { action: 'converge', outcome: 'cancelled', reason: 'r1' })

  const timeout = evaluateExecutionGate({ session: { status: 'running' }, taskDeadlineAt: now - 1, nowMs: now })
  assert.equal(timeout.action, 'converge')
  assert.equal(timeout.outcome, 'task_timeout')
  assert.match(timeout.reason, /task_deadline_exceeded/)

  // 取消优先于超时；终态优先于取消
  const both = evaluateExecutionGate({ session: { status: 'running' }, cancelRequested: true, cancelReason: 'r2', taskDeadlineAt: now - 1, nowMs: now })
  assert.equal(both.outcome, 'cancelled')
  const terminalCancel = evaluateExecutionGate({ session: { status: 'cancelled' }, cancelRequested: true, taskDeadlineAt: now - 1, nowMs: now })
  assert.equal(terminalCancel.outcome, 'terminal')

  assert.deepEqual(evaluateExecutionGate({ session: { status: 'running' }, taskDeadlineAt: now + 60000, nowMs: now }), { action: 'execute' })
})

// ---------------------------------------------------------------------------
// build*Transition 纯函数
// ---------------------------------------------------------------------------

test('buildTimeoutTransition：running -> timeout，写入收敛信息与转移记录', () => {
  const session = makeSession('bt_1', { artifacts: { nextStepIndex: 2 } })
  const next = buildTimeoutTransition(session, { detail: 'step_deadline_exceeded: s1', scope: 'step', stepId: 's1', stepIndex: 1, timeoutMs: 25 }, '2026-08-15T00:00:00.000Z')
  assert.equal(next.status, 'timeout')
  assert.equal(next.error, 'step_deadline_exceeded: s1')
  assert.equal(next.currentStepId, null)
  assert.equal(next.stateTransitions.length, 1)
  assert.equal(next.stateTransitions[0].from, 'running')
  assert.equal(next.stateTransitions[0].to, 'timeout')
  assert.equal(next.artifacts.timeoutScope, 'step')
  assert.deepEqual(next.artifacts.timeoutConvergence, {
    scope: 'step', stepId: 's1', stepIndex: 1, timeoutMs: 25, nextStepIndex: 2, at: '2026-08-15T00:00:00.000Z'
  })
})

test('buildTimeoutTransition：终态不可再转移（状态机拒绝）', () => {
  assert.throws(() => buildTimeoutTransition(makeSession('bt_2', { status: 'completed' }), { detail: 'x' }), /session_state_transition_rejected/)
  assert.throws(() => buildTimeoutTransition(makeSession('bt_2', { status: 'cancelled' }), { detail: 'x' }), /session_state_transition_rejected/)
})

test('buildCancelledTransition：queued/running/waiting_review -> cancelled；failed 非法', () => {
  for (const from of ['queued', 'running', 'waiting_review', 'orphaned', 'paused']) {
    const next = buildCancelledTransition(makeSession('bc_1', { status: from }), { detail: 'user_stop', phase: 'step' })
    assert.equal(next.status, 'cancelled')
    assert.equal(next.error, 'user_stop')
    assert.equal(next.artifacts.cancelledPhase, 'step')
    assert.ok(next.artifacts.cancelledAt)
  }
  // failed -> cancelled 不在状态机合法表内：core 层必须先行短路，此处验证状态机拒绝
  assert.throws(() => buildCancelledTransition(makeSession('bc_2', { status: 'failed' }), { detail: 'x' }), /session_state_transition_rejected/)
})

// ---------------------------------------------------------------------------
// convergeSessionTermination（幂等终结收敛）
// ---------------------------------------------------------------------------

test('convergeSessionTermination：timeout 收敛写事件与转移，重复调用幂等', () => {
  const store = makeSessionStore()
  writeSessionFile(makeSession('cv_1'))
  const deps = { sessionId: 'cv_1', readSession: store.read, updateSession: store.update, appendEvent: store.appendEvent }

  const first = convergeSessionTermination({ ...deps, outcome: 'timeout', reason: 'step_deadline_exceeded', scope: 'step', stepId: 's0', stepIndex: 0, timeoutMs: 25 })
  assert.equal(first.converged, true)
  const session1 = readSessionFile('cv_1')
  assert.equal(session1.status, 'timeout')
  assert.equal(session1.stateTransitions.length, 1)
  assert.equal(store.events.length, 1)
  assert.equal(store.events[0].type, 'session_timeout')
  assert.equal(store.events[0].data.scope, 'step')
  assert.equal(store.events[0].data.stepId, 's0')

  // 重复 timeout 幂等：不重复转移、不重复写事件
  const second = convergeSessionTermination({ ...deps, outcome: 'timeout', reason: 'step_deadline_exceeded', scope: 'step' })
  assert.equal(second.converged, false)
  assert.equal(second.reason, 'already_terminal')
  const session2 = readSessionFile('cv_1')
  assert.equal(session2.stateTransitions.length, 1)
  assert.equal(store.events.length, 1)
})

test('convergeSessionTermination：cancelled 收敛与幂等；session 缺失返回 session_missing', () => {
  const store = makeSessionStore()
  writeSessionFile(makeSession('cv_2'))
  const deps = { sessionId: 'cv_2', readSession: store.read, updateSession: store.update, appendEvent: store.appendEvent }

  const first = convergeSessionTermination({ ...deps, outcome: 'cancelled', reason: 'reasoning_cancelled_by_user', phase: 'step' })
  assert.equal(first.converged, true)
  assert.equal(readSessionFile('cv_2').status, 'cancelled')
  assert.equal(store.events.length, 1)
  assert.equal(store.events[0].type, 'session_cancelled')

  const second = convergeSessionTermination({ ...deps, outcome: 'cancelled', reason: 'again' })
  assert.equal(second.converged, false)
  assert.equal(second.reason, 'already_terminal')
  assert.equal(store.events.length, 1)

  const missing = convergeSessionTermination({ sessionId: 'cv_missing', outcome: 'cancelled', reason: 'x', readSession: store.read, updateSession: store.update, appendEvent: store.appendEvent })
  assert.equal(missing.converged, false)
  assert.equal(missing.reason, 'session_missing')

  assert.throws(() => convergeSessionTermination({ sessionId: 'cv_2', outcome: 'cancelled', reason: 'x' }), /converge_requires_updateSession/)
})

// ---------------------------------------------------------------------------
// S2-06：模拟卡住调用，step/task 在显式 deadline 内结束为 timeout 并释放资源
// ---------------------------------------------------------------------------

test('S2-06：卡住的 step 在显式 deadline 内收敛为 timeout，后续 step 不执行，无遗留 timer/信号', async () => {
  const store = makeSessionStore()
  writeSessionFile(makeSession('s206a'))
  const executedSteps = []
  const timerBase = getActiveDeadlineTimerCount()
  const registryBase = getSessionCancelRegistrySize()

  await runLoopHarness({
    sessionId: 's206a',
    store,
    steps: [{ stepId: 's0' }, { stepId: 's1' }, { stepId: 's2' }],
    taskTimeoutMs: 60000,
    stepTimeoutMs: 25,
    executeStep: (step) => {
      executedSteps.push(step.stepId)
      return new Promise(() => {}) // 永不 resolve，模拟模型调用卡住
    }
  })

  const session = readSessionFile('s206a')
  assert.equal(session.status, 'timeout')
  // 卡住在第一步：后续 step 未执行
  assert.deepEqual(executedSteps, ['s0'])
  // 状态事件可追溯：running -> timeout 一条转移 + session_timeout 事件
  assert.equal(session.stateTransitions.length, 1)
  assert.equal(session.stateTransitions[0].to, 'timeout')
  assert.match(session.stateTransitions[0].reason, /step_deadline_exceeded/)
  assert.equal(store.events.filter((e) => e.type === 'session_timeout').length, 1)
  // checkpoint 收敛信息
  assert.equal(session.artifacts.timeoutConvergence.scope, 'step')
  assert.equal(session.artifacts.timeoutConvergence.stepId, 's0')
  // 资源收敛：无 active timer、无取消信号遗留
  assert.equal(getActiveDeadlineTimerCount(), timerBase)
  assert.equal(getSessionCancelRegistrySize(), registryBase)
})

test('S2-06：task 预算耗尽时卡住的 step 以 scope=task 收敛为 timeout', async () => {
  const store = makeSessionStore()
  writeSessionFile(makeSession('s206b'))
  const executedSteps = []

  await runLoopHarness({
    sessionId: 's206b',
    store,
    steps: [{ stepId: 's0' }, { stepId: 's1' }],
    taskTimeoutMs: 60,
    stepTimeoutMs: 60000,
    executeStep: async (step) => {
      executedSteps.push(step.stepId)
      await sleep(40) // 每步 40ms：第二步竞速时 task 剩余预算更紧
      return { ok: true }
    }
  })

  const session = readSessionFile('s206b')
  assert.equal(session.status, 'timeout')
  assert.equal(session.artifacts.timeoutScope, 'task')
  // 第二步在 task 预算内未跑完即被判超时；不会出现第三步
  assert.deepEqual(executedSteps, ['s0', 's1'])
  assert.equal(store.events.filter((e) => e.type === 'session_timeout').length, 1)
})

test('S2-06：全链路成功后 session 不被误收敛（无超时误报）', async () => {
  const store = makeSessionStore()
  writeSessionFile(makeSession('s206c'))
  const executedSteps = []

  await runLoopHarness({
    sessionId: 's206c',
    store,
    steps: [{ stepId: 's0' }, { stepId: 's1' }],
    taskTimeoutMs: 60000,
    stepTimeoutMs: 5000,
    executeStep: async (step) => {
      executedSteps.push(step.stepId)
      return { ok: true }
    }
  })

  const session = readSessionFile('s206c')
  assert.equal(session.status, 'running') // harness 不写 completed；关键是未触发 timeout/cancelled
  assert.deepEqual(executedSteps, ['s0', 's1'])
  assert.equal(session.stateTransitions.length, 0)
  assert.equal(store.events.length, 0)
  assert.equal(session.artifacts.nextStepIndex, 2)
})

// ---------------------------------------------------------------------------
// S2-07：取消 queued / running / terminal task，重复取消幂等
// ---------------------------------------------------------------------------

test('S2-07：取消 queued session 收敛为 cancelled，重复取消幂等', () => {
  const store = makeSessionStore()
  writeSessionFile(makeSession('s207a', { status: 'queued' }))
  const deps = { sessionId: 's207a', readSession: store.read, updateSession: store.update, appendEvent: store.appendEvent }

  // 镜像 cancelReasoningSession：先发信号再收敛再清理
  requestSessionCancel('s207a', 'user_stop')
  const first = convergeSessionTermination({ ...deps, outcome: 'cancelled', reason: 'user_stop' })
  assert.equal(first.converged, true)
  clearSessionCancelSignal('s207a')
  assert.equal(readSessionFile('s207a').status, 'cancelled')

  // 重复取消：终态幂等，不重复转移/写事件
  const second = convergeSessionTermination({ ...deps, outcome: 'cancelled', reason: 'user_stop' })
  assert.equal(second.converged, false)
  const session = readSessionFile('s207a')
  assert.equal(session.stateTransitions.length, 1)
  assert.equal(store.events.filter((e) => e.type === 'session_cancelled').length, 1)
})

test('S2-07：取消运行中（卡住）task 立即中止，后续 step 不执行，无遗留资源', async () => {
  const store = makeSessionStore()
  writeSessionFile(makeSession('s207b'))
  const executedSteps = []
  const timerBase = getActiveDeadlineTimerCount()
  const registryBase = getSessionCancelRegistrySize()

  const loopPromise = runLoopHarness({
    sessionId: 's207b',
    store,
    steps: [{ stepId: 's0' }, { stepId: 's1' }, { stepId: 's2' }],
    taskTimeoutMs: 60000,
    stepTimeoutMs: 60000, // step 上限很大：验证取消信号而非超时唤醒
    executeStep: (step) => {
      executedSteps.push(step.stepId)
      return new Promise(() => {}) // 卡住，等待取消信号
    }
  })

  await sleep(15) // 等 loop 进入第一步竞速
  // 镜像 cancelReasoningSession 顺序：requestSessionCancel -> converge -> clear
  requestSessionCancel('s207b', 'user_abort_running')
  convergeSessionTermination({
    sessionId: 's207b', outcome: 'cancelled', reason: 'user_abort_running',
    readSession: store.read, updateSession: store.update, appendEvent: store.appendEvent
  })
  clearSessionCancelSignal('s207b')
  await loopPromise

  const session = readSessionFile('s207b')
  assert.equal(session.status, 'cancelled')
  assert.deepEqual(executedSteps, ['s0']) // 后续 step 未执行
  assert.equal(session.stateTransitions.length, 1)
  assert.equal(session.stateTransitions[0].to, 'cancelled')
  assert.equal(store.events.filter((e) => e.type === 'session_cancelled').length, 1) // 事件仅一次
  assert.equal(getActiveDeadlineTimerCount(), timerBase)
  assert.equal(getSessionCancelRegistrySize(), registryBase)
})

test('S2-07：循环门禁兜底——信号先于状态收敛到达时 loop 自行收敛为 cancelled', async () => {
  const store = makeSessionStore()
  writeSessionFile(makeSession('s207c'))
  const executedSteps = []

  await runLoopHarness({
    sessionId: 's207c',
    store,
    steps: [{ stepId: 's0' }, { stepId: 's1' }],
    taskTimeoutMs: 60000,
    stepTimeoutMs: 5000,
    executeStep: async (step) => {
      executedSteps.push(step.stepId)
      if (step.stepId === 's0') {
        // 第一步成功后仅发信号（不收敛状态），验证下一迭代门禁 converge 分支
        requestSessionCancel('s207c', 'gate_cancel')
      }
      return { ok: true }
    }
  })

  const session = readSessionFile('s207c')
  assert.equal(session.status, 'cancelled')
  assert.deepEqual(executedSteps, ['s0']) // 第二步未执行
  assert.equal(session.error, 'gate_cancel')
  assert.equal(store.events.filter((e) => e.type === 'session_cancelled').length, 1)
  // 兜底收敛后 finally 清理注册项
  assert.equal(getSessionCancelSignal('s207c'), null)
})

test('S2-07：取消已终结 task 幂等返回，状态事件不变', () => {
  const store = makeSessionStore()
  for (const terminal of ['completed', 'timeout', 'blocked', 'cancelled']) {
    const sessionId = `s207d_${terminal}`
    writeSessionFile(makeSession(sessionId, { status: terminal, stateTransitions: [{ from: 'running', to: terminal, reason: 'seed', timestamp: '2026-08-15T00:00:00.000Z' }] }))
    const result = convergeSessionTermination({
      sessionId, outcome: 'cancelled', reason: 'cancel_after_terminal',
      readSession: store.read, updateSession: store.update, appendEvent: store.appendEvent
    })
    assert.equal(result.converged, false)
    assert.equal(result.reason, 'already_terminal')
    const session = readSessionFile(sessionId)
    assert.equal(session.status, terminal)
    assert.equal(session.stateTransitions.length, 1)
  }
  assert.equal(store.events.length, 0)
})

test('S2-07：同一 task 重复 cancel 信号幂等，保留首个 reason', async () => {
  const id = 's207e'
  const first = requestSessionCancel(id, 'first_reason')
  const second = requestSessionCancel(id, 'second_reason')
  assert.equal(first.requested, true)
  assert.equal(second.requested, false)
  assert.equal(getSessionCancelReason(id), 'first_reason')
  clearSessionCancelSignal(id)
})

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------

test('cleanup：恢复 env，无遗留取消信号与 active timer，无 unhandledRejection', async () => {
  await sleep(5)
  restoreEnv()
  assert.equal(getSessionCancelRegistrySize(), 0)
  assert.equal(getActiveDeadlineTimerCount(), 0)
  assert.deepEqual(lateUnhandledRejections, [])
})
