/**
 * reasoning 长任务超时、取消与资源收敛。
 *
 * AUTO-B04：为 reasoning task 和 step 建立硬超时、取消信号和终结事件，
 * 避免模型调用或恢复流程无限悬挂。
 *
 * 语义约定：
 * - task 超时（HERMES_REASONING_TASK_TIMEOUT_MS）是单次执行循环的执行预算，
 *   覆盖 step 链整体；人工审核等待不计入（循环在等待审核时已返回）。
 * - step 超时（HERMES_REASONING_STEP_TIMEOUT_MS）是单个 step 的上限；
 *   task 剩余预算更紧时以 task 预算为准（scope='task'）。
 * - 超时经状态机转 `timeout`（终态），取消经状态机转 `cancelled`（终态）；
 *   两者都不再执行后续 step，不遗留 active timer / 取消信号 / 恢复锁。
 * - 重复 cancel / timeout 幂等：已终态的 session 不重复转移、不重复写事件。
 * - plan 阶段的单次模型调用上限仍由既有 HERMES_REASONING_TASK_HARD_TIMEOUT_MS 约束。
 */

import {
  REASONING_SESSION_STATE,
  isTerminalSessionState,
  applySessionTransition
} from './sessionStateMachine.js'

// task 执行预算：HERMES_REASONING_TASK_TIMEOUT_MS 可覆盖，默认 2 小时
const DEFAULT_TASK_TIMEOUT_MS = 7200000
// step 执行上限：HERMES_REASONING_STEP_TIMEOUT_MS 可覆盖，默认 30 分钟
// （需不小于单次模型调用 HARD_TIMEOUT 1500000ms，让模型调用硬超时先生效）
const DEFAULT_STEP_TIMEOUT_MS = 1800000

export function resolveTaskTimeoutMs(value) {
  const raw = value ?? process.env.HERMES_REASONING_TASK_TIMEOUT_MS
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_TASK_TIMEOUT_MS
  return Math.max(1, Math.floor(num))
}

export function resolveStepTimeoutMs(value) {
  const raw = value ?? process.env.HERMES_REASONING_STEP_TIMEOUT_MS
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_STEP_TIMEOUT_MS
  return Math.max(1, Math.floor(num))
}

// ---------------------------------------------------------------------------
// 取消信号 registry（进程内）：sessionId -> { controller, reason, requestedAt }
// 参考 orphanRecovery 的 in-flight 幂等模式：首次请求生效，重复请求幂等。
// ---------------------------------------------------------------------------

const sessionCancelEntries = new Map()

/**
 * 为执行循环注册取消信号；重复注册幂等（返回已有 entry）。
 */
export function registerSessionCancelSignal(sessionId) {
  const key = String(sessionId)
  let entry = sessionCancelEntries.get(key)
  if (!entry) {
    entry = { controller: new AbortController(), reason: null, requestedAt: null }
    sessionCancelEntries.set(key, entry)
  }
  return entry
}

/**
 * 请求取消：abort 信号并记录首个取消原因。
 * 重复请求幂等：不重复 abort 语义，保留首个 reason（事件可追溯）。
 * 返回 { requested, reason }：requested 表示本次是否为首次生效请求。
 */
export function requestSessionCancel(sessionId, reason = 'reasoning_cancelled_by_user') {
  const entry = registerSessionCancelSignal(sessionId)
  if (entry.controller.signal.aborted) {
    return { requested: false, reason: entry.reason }
  }
  entry.reason = String(reason || 'reasoning_cancelled_by_user')
  entry.requestedAt = new Date().toISOString()
  try {
    entry.controller.abort(entry.reason)
  } catch {
    // abort 传播失败不影响取消状态记录
  }
  return { requested: true, reason: entry.reason }
}

export function isSessionCancelRequested(sessionId) {
  const entry = sessionCancelEntries.get(String(sessionId))
  return Boolean(entry?.controller?.signal?.aborted)
}

export function getSessionCancelReason(sessionId) {
  const entry = sessionCancelEntries.get(String(sessionId))
  return entry?.reason || null
}

export function getSessionCancelSignal(sessionId) {
  const entry = sessionCancelEntries.get(String(sessionId))
  return entry?.controller?.signal || null
}

/**
 * 清理取消信号注册项（执行循环结束 / 收敛完成后调用），不遗留注册引用。
 */
export function clearSessionCancelSignal(sessionId) {
  sessionCancelEntries.delete(String(sessionId))
}

/**
 * 当前注册的取消信号数量（测试与观测用）。
 */
export function getSessionCancelRegistrySize() {
  return sessionCancelEntries.size
}

// ---------------------------------------------------------------------------
// step 执行竞速：deadline + 取消信号
// ---------------------------------------------------------------------------

// 模块内 active timer 计数（测试与观测用）：race 结束必须归零，不遗留 timer
let activeDeadlineTimerCount = 0

export function getActiveDeadlineTimerCount() {
  return activeDeadlineTimerCount
}

/**
 * 以 deadline 与取消信号竞速一个 step 执行 promise。
 *
 * 返回：
 * - { kind: 'resolved', value }
 * - { kind: 'rejected', error }
 * - { kind: 'timeout', scope, timeoutMs }
 * - { kind: 'cancelled', reason }
 *
 * 保证：
 * - 任意返回路径都清理内部 timer 与 signal 监听，不遗留 active timer；
 * - 被遗弃的执行 promise 挂有空 catch，迟到的 reject 不会触发 unhandledRejection；
 * - signal 在竞速前已 aborted 时立即返回 cancelled，不再等待执行。
 */
export function raceStepExecution(executionPromise, { timeoutMs, scope = 'step', signal = null } = {}) {
  const limit = Math.max(1, Number(timeoutMs) || 1)
  const tracked = Promise.resolve(executionPromise)
  // 无论竞速结果如何，执行 promise 的迟到 reject 都必须被吞掉，避免进程级 unhandledRejection
  tracked.catch(() => {})

  return new Promise((resolve) => {
    let settled = false
    let timer = null

    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
        activeDeadlineTimerCount -= 1
        timer = null
      }
      if (signal) {
        try {
          signal.removeEventListener('abort', onAbort)
        } catch {
          // 监听移除失败不影响收敛
        }
      }
      resolve(result)
    }

    const onAbort = () => finish({ kind: 'cancelled', reason: signal?.reason || 'reasoning_cancelled_by_user' })

    if (signal?.aborted) {
      finish({ kind: 'cancelled', reason: signal.reason || 'reasoning_cancelled_by_user' })
      return
    }

    timer = setTimeout(() => {
      finish({ kind: 'timeout', scope, timeoutMs: limit })
    }, limit)
    activeDeadlineTimerCount += 1

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    tracked.then(
      (value) => finish({ kind: 'resolved', value }),
      (error) => finish({ kind: 'rejected', error })
    )
  })
}

// ---------------------------------------------------------------------------
// 执行循环门禁与 deadline 计算（纯函数）
// ---------------------------------------------------------------------------

/**
 * 计算单个 step 的竞速上限：step 上限与 task 剩余预算取较小值。
 * 返回 { timeoutMs, scope }：task 剩余预算更紧时 scope='task'。
 */
export function resolveStepDeadline({ taskDeadlineAt, stepTimeoutMs, nowMs = Date.now() } = {}) {
  const stepLimit = Math.max(1, Number(stepTimeoutMs) || 1)
  const taskRemainingMs = Number.isFinite(taskDeadlineAt)
    ? Math.max(1, Math.floor(taskDeadlineAt - nowMs))
    : stepLimit
  if (taskRemainingMs <= stepLimit) {
    return { timeoutMs: taskRemainingMs, scope: 'task' }
  }
  return { timeoutMs: stepLimit, scope: 'step' }
}

/**
 * 执行循环每个 step 前的门禁判定（优先级从高到低）：
 * 1. session 缺失 -> stop(missing)，循环直接退出；
 * 2. session 已终态 -> stop(terminal)，幂等退出（事件已由首次收敛写入）；
 * 3. 取消信号已请求 -> converge(cancelled)，调用方收敛为 cancelled；
 * 4. task deadline 已过 -> converge(task_timeout)，调用方收敛为 timeout；
 * 5. 其余 -> execute，继续执行当前 step。
 */
export function evaluateExecutionGate({ session, cancelRequested = false, cancelReason = null, taskDeadlineAt = null, nowMs = Date.now() } = {}) {
  if (!session) {
    return { action: 'stop', outcome: 'missing' }
  }
  if (isTerminalSessionState(session.status)) {
    return { action: 'stop', outcome: 'terminal', status: session.status }
  }
  if (cancelRequested) {
    return {
      action: 'converge',
      outcome: 'cancelled',
      reason: String(cancelReason || 'reasoning_cancelled_by_user')
    }
  }
  if (Number.isFinite(taskDeadlineAt) && nowMs >= taskDeadlineAt) {
    return {
      action: 'converge',
      outcome: 'task_timeout',
      reason: `task_deadline_exceeded: 执行循环超过 task 上限（deadlineAt=${new Date(taskDeadlineAt).toISOString()}）`
    }
  }
  return { action: 'execute' }
}

// ---------------------------------------------------------------------------
// 终结转移构造（纯函数，不落盘）
// ---------------------------------------------------------------------------

/**
 * 构造 -> timeout 的转移结果：状态机校验 + stateTransitions +
 * artifacts.timeoutConvergence 收敛信息（scope/step/nextStepIndex/时限）。
 */
export function buildTimeoutTransition(session, { detail, scope = 'step', stepId = null, stepIndex = null, timeoutMs = null } = {}, now = new Date().toISOString()) {
  const reason = String(detail || 'reasoning_timeout')
  const transitioned = applySessionTransition(session, REASONING_SESSION_STATE.TIMEOUT, reason)
  return {
    ...transitioned,
    currentStepId: null,
    review: null,
    error: reason,
    artifacts: {
      ...transitioned.artifacts,
      timeoutAt: now,
      timeoutScope: scope,
      timeoutConvergence: {
        scope,
        stepId,
        stepIndex,
        timeoutMs,
        nextStepIndex: Number.isInteger(transitioned.artifacts?.nextStepIndex)
          ? transitioned.artifacts.nextStepIndex
          : null,
        at: now
      }
    }
  }
}

/**
 * 构造 -> cancelled 的转移结果：状态机校验 + stateTransitions +
 * artifacts.cancelledAt / cancelledPhase。
 */
export function buildCancelledTransition(session, { detail, phase = null } = {}, now = new Date().toISOString()) {
  const reason = String(detail || 'reasoning_cancelled_by_user')
  const transitioned = applySessionTransition(session, REASONING_SESSION_STATE.CANCELLED, reason)
  return {
    ...transitioned,
    currentStepId: null,
    review: null,
    error: reason,
    artifacts: {
      ...transitioned.artifacts,
      cancelledAt: now,
      cancelledPhase: phase
    }
  }
}

/**
 * 收敛 session 为终结状态（cancelled / timeout），注入式、幂等。
 *
 * 幂等保证：updater 内以最新状态判定，已终态时不重复转移、不重复写事件，
 * 返回 { converged: false, reason: 'already_terminal', status }。
 * 事件：timeout -> session_timeout；cancelled -> session_cancelled（与既有事件类型一致）。
 *
 * 返回 { converged: true, outcome, session } 或 { converged: false, outcome, reason, status? }。
 */
export function convergeSessionTermination({
  sessionId,
  outcome,
  reason,
  scope = null,
  stepId = null,
  stepIndex = null,
  timeoutMs = null,
  phase = null,
  eventSummary = null,
  readSession,
  updateSession,
  appendEvent = () => {},
  nowFn = () => new Date().toISOString()
}) {
  if (typeof updateSession !== 'function') throw new Error('converge_requires_updateSession')
  const currentSnapshot = typeof readSession === 'function' ? readSession(sessionId) : null
  if (!currentSnapshot) {
    return { converged: false, outcome, reason: 'session_missing' }
  }

  const detail = String(reason || (outcome === 'timeout' ? 'reasoning_timeout' : 'reasoning_cancelled_by_user'))
  let converged = false
  const next = updateSession(sessionId, (current) => {
    if (!current || isTerminalSessionState(current.status)) {
      return current
    }
    converged = true
    if (outcome === 'timeout') {
      return buildTimeoutTransition(current, { detail, scope: scope || 'step', stepId, stepIndex, timeoutMs }, nowFn())
    }
    return buildCancelledTransition(current, { detail, phase }, nowFn())
  })

  if (!converged) {
    return { converged: false, outcome, reason: 'already_terminal', status: next?.status || currentSnapshot.status }
  }

  if (outcome === 'timeout') {
    appendEvent(sessionId, 'session_timeout', '推理超时', eventSummary || detail, {
      data: { reason: detail, scope: scope || 'step', stepId, stepIndex, timeoutMs }
    })
  } else {
    appendEvent(sessionId, 'session_cancelled', '推理已停止', eventSummary || detail, {
      data: { reason: detail, phase }
    })
  }
  return { converged: true, outcome, session: next }
}
