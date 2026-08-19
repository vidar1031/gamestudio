import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GATEWAY_EXIT_CATEGORY,
  GATEWAY_SUPERVISION_STATUS,
  classifyGatewayExit,
  computeGatewayRestartBackoffMs,
  selectGatewayRestorableWaitingTasks,
  isGatewayExitAffectedSession,
  createGatewaySupervisor
} from '../../apps/control-server/src/server/reasoning/gatewaySupervision.js'
import { applySessionTransition } from '../../apps/control-server/src/server/reasoning/sessionStateMachine.js'
import { classifyReasoningFailure, REASONING_RETRY_CATEGORY } from '../../apps/control-server/src/server/reasoning/retryPolicy.js'

// AUTO-C04 测试：Hermes gateway 监督恢复（S3-04）。
// 全部注入式：假 probe/假 restart/内存 session（真状态机转移），
// 毫秒级 poll/backoff 时钟，不启动真实 gateway 进程、不等真实秒级退避。

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(condition, timeoutMs = 3000) {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitFor_timeout')
    }
    await sleep(5)
  }
}

// 内存 session 存储：用真状态机执行转移，验证核心侧传播的合法性
function makeSessionStore(initial = []) {
  const sessions = new Map()
  for (const session of initial) {
    sessions.set(session.sessionId, {
      sessionId: session.sessionId,
      status: session.status,
      error: null,
      stateTransitions: [],
      events: [],
      artifacts: {}
    })
  }
  return {
    list() {
      return [...sessions.values()].map((s) => ({ ...s }))
    },
    get(sessionId) {
      return sessions.get(sessionId) || null
    },
    // 模拟 core markReasoningSessionFailed 的状态语义（仅转移，不清 checkpoint）
    fail(sessionId, error) {
      const current = sessions.get(sessionId)
      if (!current) return
      const detail = error instanceof Error ? error.message : String(error)
      const next = applySessionTransition(current, 'failed', detail)
      sessions.set(sessionId, { ...next, error: detail })
    },
    // 模拟 core blockReasoningSessionByGateway 的状态语义：
    // running/retry_wait/failed 直接 blocked；pausing/resuming 先 failed 再 blocked；终态/取消不动
    block(sessionId, reason) {
      let current = sessions.get(sessionId)
      if (!current) return
      if (current.status === 'pausing' || current.status === 'resuming') {
        current = applySessionTransition(current, 'failed', reason)
      }
      const next = applySessionTransition(current, 'blocked', reason)
      sessions.set(sessionId, { ...next, error: reason })
    }
  }
}

// 假 gateway 进程：running 可控；restart 按编排序列返回结果
function makeFakeGateway({ restartResults = [] } = {}) {
  const state = { running: true, pid: 4242, installed: true }
  const calls = { restart: 0, intentionalStop: false }
  return {
    state,
    calls,
    probe: () => ({ installed: state.installed, running: state.running, pid: state.running ? state.pid : null }),
    wasStoppingIntentionally: () => calls.intentionalStop,
    restart: async () => {
      calls.restart += 1
      const next = restartResults.length > 0 ? restartResults.shift() : { ok: true, state: 'running' }
      if (next.ok) {
        state.running = true
        state.pid = 4242 + calls.restart
      }
      return next
    }
  }
}

function makeSupervisorHarness({ sessions = [], queueItems = [], restartResults = [], overrides = {} } = {}) {
  const gateway = makeFakeGateway({ restartResults })
  const store = makeSessionStore(sessions)
  const events = []
  const sessionEvents = []
  const kicks = { count: 0 }
  const supervisor = createGatewaySupervisor({
    probe: gateway.probe,
    wasStoppingIntentionally: gateway.wasStoppingIntentionally,
    restart: gateway.restart,
    listAffectedSessions: () => store.list(),
    failSession: (sessionId, error) => store.fail(sessionId, error),
    blockSession: (sessionId, reason) => store.block(sessionId, reason),
    appendSessionEvent: (sessionId, type, title, summary, extra = {}) => {
      sessionEvents.push({ sessionId, type, title, summary, ...extra })
    },
    kickQueue: () => { kicks.count += 1 },
    listQueueItemsFn: () => ({ items: queueItems, errors: [] }),
    onEvent: (event) => events.push(event),
    enabled: true,
    pollMs: 5,
    baseMs: 5,
    maxDelayMs: 10,
    healthyResetMs: 50,
    maxAttempts: 3,
    ...overrides
  })
  return { gateway, store, events, sessionEvents, kicks, supervisor }
}

// ---------------------------------------------------------------------------
// 纯函数：exit 分类 / 退避 / 恢复资格
// ---------------------------------------------------------------------------

test('classifyGatewayExit：manual/auth/config/crash 四类确定性分类', () => {
  const manual = classifyGatewayExit({ intentionalStop: true })
  assert.equal(manual.category, GATEWAY_EXIT_CATEGORY.MANUAL_LIFECYCLE)
  assert.equal(manual.recoverable, false)

  const auth = classifyGatewayExit({ detail: 'model_task_http_401_Unauthorized' })
  assert.equal(auth.category, GATEWAY_EXIT_CATEGORY.UNRECOVERABLE_AUTH)
  assert.equal(auth.recoverable, false)

  const config = classifyGatewayExit({ installed: false })
  assert.equal(config.category, GATEWAY_EXIT_CATEGORY.UNRECOVERABLE_CONFIG)
  assert.equal(config.recoverable, false)

  const crash = classifyGatewayExit({ detail: 'SIGSEGV core dumped' })
  assert.equal(crash.category, GATEWAY_EXIT_CATEGORY.RECOVERABLE_CRASH)
  assert.equal(crash.recoverable, true)

  // 注入 G02 同源判定：503 不误判为认证失败
  const notAuth = classifyGatewayExit({ detail: 'model_task_http_503' })
  assert.equal(notAuth.category, GATEWAY_EXIT_CATEGORY.RECOVERABLE_CRASH)
})

test('computeGatewayRestartBackoffMs：指数退避并封顶', () => {
  assert.equal(computeGatewayRestartBackoffMs(1, { baseMs: 100, maxDelayMs: 1000 }), 100)
  assert.equal(computeGatewayRestartBackoffMs(2, { baseMs: 100, maxDelayMs: 1000 }), 200)
  assert.equal(computeGatewayRestartBackoffMs(3, { baseMs: 100, maxDelayMs: 1000 }), 400)
  assert.equal(computeGatewayRestartBackoffMs(10, { baseMs: 100, maxDelayMs: 1000 }), 1000)
})

test('selectGatewayRestorableWaitingTasks：仅合法未取消的等待任务可恢复', () => {
  const sessions = [
    { sessionId: 's_retry', status: 'retry_wait' },
    { sessionId: 's_queued', status: 'queued' },
    { sessionId: 's_running', status: 'running' },
    { sessionId: 's_cancelled', status: 'cancelled' },
    { sessionId: 's_done', status: 'completed' }
  ]
  const items = [
    { sessionId: 's_retry', status: 'queued', taskId: 't_retry', projectId: 'p1' },
    { sessionId: 's_queued', status: 'queued', taskId: 't_queued' },
    { sessionId: 's_running', status: 'running', taskId: 't_running' },
    { sessionId: 's_cancelled', status: 'cancelled', taskId: 't_cancelled' }
  ]
  const restorable = selectGatewayRestorableWaitingTasks(sessions, items)
  assert.deepEqual(restorable.map((t) => t.sessionId), ['s_retry', 's_queued'])
  // retry_wait session 但 item 已终态：不恢复
  const withTerminalItem = selectGatewayRestorableWaitingTasks(
    [{ sessionId: 's_retry', status: 'retry_wait' }],
    [{ sessionId: 's_retry', status: 'failed', taskId: 't_retry' }]
  )
  assert.deepEqual(withTerminalItem, [])
})

test('isGatewayExitAffectedSession：running/pausing/resuming/retry_wait 受影响，其余不受影响', () => {
  for (const status of ['running', 'pausing', 'resuming', 'retry_wait']) {
    assert.equal(isGatewayExitAffectedSession({ status }), true, status)
  }
  for (const status of ['queued', 'waiting_review', 'paused', 'completed', 'failed', 'blocked', 'cancelled', 'orphaned']) {
    assert.equal(isGatewayExitAffectedSession({ status }), false, status)
  }
})

// ---------------------------------------------------------------------------
// S3-04：模拟 exit —— 事件含原因/时间/受影响 task，可恢复退出传播 retryable 失败
// ---------------------------------------------------------------------------

test('S3-04：gateway 异常退出被记录为含原因、时间和受影响 task 的事件', async () => {
  const { gateway, store, events, supervisor } = makeSupervisorHarness({
    sessions: [
      { sessionId: 's_running', status: 'running' },
      { sessionId: 's_retry', status: 'retry_wait' },
      { sessionId: 's_done', status: 'completed' }
    ]
  })
  supervisor.start()
  gateway.state.running = false // 模拟崩溃
  await waitFor(() => events.some((e) => e.type === 'gateway_exit'))

  const exitEvent = events.find((e) => e.type === 'gateway_exit')
  assert.equal(exitEvent.category, GATEWAY_EXIT_CATEGORY.RECOVERABLE_CRASH)
  assert.equal(exitEvent.reason, 'gateway_unexpected_exit')
  assert.ok(exitEvent.at)
  assert.deepEqual(
    exitEvent.affectedTasks.map((t) => t.sessionId).sort(),
    ['s_retry', 's_running']
  )

  // 受影响 running session 被标 failed；错误文本必须被 C02 retryPolicy 分类为 retryable
  const failed = store.get('s_running')
  assert.equal(failed.status, 'failed')
  const classification = classifyReasoningFailure({ error: failed.error })
  assert.equal(classification.category, REASONING_RETRY_CATEGORY.RETRYABLE)

  // retry_wait 保持等待（不重复传播），终态绝不动
  assert.equal(store.get('s_retry').status, 'retry_wait')
  assert.equal(store.get('s_done').status, 'completed')

  // 已调度退避重启，次数可观测
  await waitFor(() => events.some((e) => e.type === 'gateway_restart_scheduled'))
  const state = supervisor.getState()
  assert.equal(state.status, GATEWAY_SUPERVISION_STATUS.BACKING_OFF)
  assert.equal(state.restartAttempts, 1)
  assert.equal(state.maxAttempts, 3)
  supervisor.stop()
})

// ---------------------------------------------------------------------------
// S3-04：恢复成功 —— 仅恢复合法、未取消的等待任务
// ---------------------------------------------------------------------------

test('S3-04：有限退避重启成功，恢复事件只含合法未取消的等待任务', async () => {
  const { gateway, events, kicks, supervisor } = makeSupervisorHarness({
    sessions: [
      { sessionId: 's_retry', status: 'retry_wait' },
      { sessionId: 's_queued', status: 'queued' },
      { sessionId: 's_cancelled', status: 'cancelled' }
    ],
    queueItems: [
      { sessionId: 's_retry', status: 'queued', taskId: 't_retry', projectId: 'p1' },
      { sessionId: 's_queued', status: 'queued', taskId: 't_queued' },
      { sessionId: 's_cancelled', status: 'cancelled', taskId: 't_cancelled' }
    ]
  })
  supervisor.start()
  gateway.state.running = false
  await waitFor(() => events.some((e) => e.type === 'gateway_recovered'))

  const recovered = events.find((e) => e.type === 'gateway_recovered')
  assert.equal(recovered.attempt, 1)
  // 仅 retry_wait/queued + 非终态 item；cancelled 绝不恢复
  assert.deepEqual(
    recovered.restoredTasks.map((t) => t.sessionId).sort(),
    ['s_queued', 's_retry']
  )
  assert.ok(gateway.state.running)
  assert.ok(kicks.count >= 1) // 唤醒队列 worker，等待任务到点可领取

  const state = supervisor.getState()
  assert.equal(state.status, GATEWAY_SUPERVISION_STATUS.MONITORING)
  assert.equal(state.restartAttempts, 1) // 次数可观测
  assert.ok(state.lastRecovery)
  supervisor.stop()
})

// ---------------------------------------------------------------------------
// S3-04：达到上限 —— 收敛 blocked，不无限循环，任务状态传播
// ---------------------------------------------------------------------------

test('S3-04：重启达到上限后进入 blocked，受影响任务收敛 blocked，不再重启', async () => {
  const { gateway, store, events, sessionEvents, supervisor } = makeSupervisorHarness({
    sessions: [
      { sessionId: 's_retry', status: 'retry_wait' },
      { sessionId: 's_running', status: 'running' }
    ],
    restartResults: [
      { ok: false, detail: 'spawn crashed exit_code_1' },
      { ok: false, detail: 'spawn crashed exit_code_1' }
    ],
    overrides: { maxAttempts: 2 }
  })
  supervisor.start()
  gateway.state.running = false
  await waitFor(() => events.some((e) => e.type === 'gateway_restart_exhausted'))

  // 恰好重启 maxAttempts 次，等足够时间确认不再增长（不无限循环）
  assert.equal(gateway.calls.restart, 2)
  await sleep(60)
  assert.equal(gateway.calls.restart, 2)

  const state = supervisor.getState()
  assert.equal(state.status, GATEWAY_SUPERVISION_STATUS.BLOCKED)
  assert.equal(state.restartAttempts, 2)
  assert.ok(state.blocked.reason.includes('gateway_restart_exhausted'))

  // 受影响 running + retry_wait session 均收敛 blocked（真状态机转移），事件含受影响 task
  assert.equal(store.get('s_running').status, 'blocked')
  assert.equal(store.get('s_retry').status, 'blocked')
  const exhausted = events.find((e) => e.type === 'gateway_restart_exhausted')
  assert.deepEqual(
    exhausted.affectedTasks.map((t) => t.sessionId).sort(),
    ['s_retry', 's_running']
  )
  const blockedSessionEvents = sessionEvents.filter((e) => e.type === 'session_gateway_blocked')
  assert.equal(blockedSessionEvents.length, 2)
  supervisor.stop()
})

// ---------------------------------------------------------------------------
// S3-04：不可恢复原因（认证失败）—— 不继续重试，直接 blocked
// ---------------------------------------------------------------------------

test('S3-04：重启失败为认证错误时判定不可恢复，不再重试并传播 blocked', async () => {
  const { gateway, store, events, supervisor } = makeSupervisorHarness({
    sessions: [{ sessionId: 's_retry', status: 'retry_wait' }],
    restartResults: [{ ok: false, detail: 'model_task_http_401_Unauthorized' }]
  })
  supervisor.start()
  gateway.state.running = false
  await waitFor(() => events.some((e) => e.type === 'gateway_unrecoverable'))

  // 只尝试了 1 次即收敛，不继续重试
  assert.equal(gateway.calls.restart, 1)
  await sleep(40)
  assert.equal(gateway.calls.restart, 1)

  const unrecoverable = events.find((e) => e.type === 'gateway_unrecoverable')
  assert.ok(unrecoverable.reason.includes('gateway_auth_failure'))
  assert.equal(supervisor.getState().status, GATEWAY_SUPERVISION_STATUS.BLOCKED)
  assert.equal(store.get('s_retry').status, 'blocked')
  supervisor.stop()
})

// ---------------------------------------------------------------------------
// 硬边界：生命周期关停绝不自动拉起、不传播任务状态
// ---------------------------------------------------------------------------

test('人工 stop/exit 发起的关停只记录 manual 事件，绝不自动拉起、不传播任务', async () => {
  const { gateway, store, events, supervisor } = makeSupervisorHarness({
    sessions: [{ sessionId: 's_running', status: 'running' }]
  })
  supervisor.start()
  gateway.calls.intentionalStop = true // 生命周期控制发起
  gateway.state.running = false
  await waitFor(() => events.some((e) => e.type === 'gateway_exit'))
  await sleep(40) // 等超过多个 backoff 周期

  const exitEvent = events.find((e) => e.type === 'gateway_exit')
  assert.equal(exitEvent.category, GATEWAY_EXIT_CATEGORY.MANUAL_LIFECYCLE)
  assert.equal(gateway.calls.restart, 0) // 绝不自动拉起
  assert.equal(store.get('s_running').status, 'running') // 不传播任务状态
  assert.equal(events.some((e) => e.type === 'gateway_restart_scheduled'), false)
  supervisor.stop()
})

// ---------------------------------------------------------------------------
// 次数重置 / 禁用门禁 / 初始基线
// ---------------------------------------------------------------------------

test('恢复后持续健康超过健康窗口，重启次数归零', async () => {
  const { gateway, events, supervisor } = makeSupervisorHarness({ overrides: { healthyResetMs: 30 } })
  supervisor.start()
  gateway.state.running = false
  await waitFor(() => events.some((e) => e.type === 'gateway_recovered'))
  assert.equal(supervisor.getState().restartAttempts, 1)
  // 持续健康（restart 成功已把 running 置回 true），等健康窗口后 tick 重置次数
  await waitFor(() => supervisor.getState().restartAttempts === 0)
  supervisor.stop()
})

test('监督器默认禁用语义：enabled=false 时不轮询、状态 disabled', async () => {
  const { gateway, events, supervisor } = makeSupervisorHarness({ overrides: { enabled: false } })
  supervisor.start()
  gateway.state.running = false
  await sleep(40)
  assert.equal(events.length, 0)
  const state = supervisor.getState()
  assert.equal(state.enabled, false)
  assert.equal(state.status, GATEWAY_SUPERVISION_STATUS.DISABLED)
  supervisor.stop()
})

test('启动时 gateway 已是 down：以初始观测为基线，不误判为 exit', async () => {
  const { gateway, events, supervisor } = makeSupervisorHarness()
  gateway.state.running = false // start 之前就是 down（从未观测到 running）
  supervisor.start()
  await sleep(40)
  assert.equal(events.some((e) => e.type === 'gateway_exit'), false)
  assert.equal(gateway.calls.restart, 0)
  supervisor.stop()
})

test('blocked 后人工 resume 恢复健康：监督器回到 monitoring', async () => {
  const { gateway, events, supervisor } = makeSupervisorHarness({
    restartResults: [{ ok: false, detail: 'crash' }],
    overrides: { maxAttempts: 1 }
  })
  supervisor.start()
  gateway.state.running = false
  await waitFor(() => events.some((e) => e.type === 'gateway_restart_exhausted'))
  assert.equal(supervisor.getState().status, GATEWAY_SUPERVISION_STATUS.BLOCKED)
  // 人工通过生命周期 resume 拉起
  gateway.state.running = true
  await waitFor(() => supervisor.getState().status === GATEWAY_SUPERVISION_STATUS.MONITORING)
  assert.ok(events.some((e) => e.type === 'gateway_supervision_resumed'))
  supervisor.stop()
})
