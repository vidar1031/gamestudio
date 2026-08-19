/**
 * reasoning session 任务状态机。
 *
 * AUTO-B01：消除隐式状态与非法跳转。
 * 所有 session.status 变更必须通过 transitionReasoningSession 执行，
 * 由状态机校验合法性并记录转移事件。
 */

export const REASONING_SESSION_STATE = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_REVIEW: 'waiting_review',
  PAUSING: 'pausing',
  PAUSED: 'paused',
  RESUMING: 'resuming',
  RETRY_WAIT: 'retry_wait',
  COMPLETED: 'completed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled',
  ORPHANED: 'orphaned',
  TIMEOUT: 'timeout'
})

const TERMINAL_STATES = new Set([
  REASONING_SESSION_STATE.COMPLETED,
  REASONING_SESSION_STATE.BLOCKED,
  REASONING_SESSION_STATE.CANCELLED,
  REASONING_SESSION_STATE.TIMEOUT
])

const LEGAL_TRANSITIONS = Object.freeze({
  [REASONING_SESSION_STATE.QUEUED]: [
    REASONING_SESSION_STATE.RUNNING,
    REASONING_SESSION_STATE.CANCELLED,
    REASONING_SESSION_STATE.BLOCKED,
    // AUTO-B03：queued 任务在进程重启/心跳过期时同样是孤儿
    REASONING_SESSION_STATE.ORPHANED
  ],
  [REASONING_SESSION_STATE.RUNNING]: [
    REASONING_SESSION_STATE.WAITING_REVIEW,
    REASONING_SESSION_STATE.PAUSING,
    REASONING_SESSION_STATE.RETRY_WAIT,
    REASONING_SESSION_STATE.COMPLETED,
    REASONING_SESSION_STATE.FAILED,
    REASONING_SESSION_STATE.BLOCKED,
    REASONING_SESSION_STATE.CANCELLED,
    REASONING_SESSION_STATE.ORPHANED,
    REASONING_SESSION_STATE.TIMEOUT
  ],
  [REASONING_SESSION_STATE.WAITING_REVIEW]: [
    REASONING_SESSION_STATE.RUNNING,
    REASONING_SESSION_STATE.CANCELLED,
    REASONING_SESSION_STATE.BLOCKED,
    REASONING_SESSION_STATE.ORPHANED
  ],
  [REASONING_SESSION_STATE.PAUSING]: [
    REASONING_SESSION_STATE.PAUSED,
    REASONING_SESSION_STATE.RUNNING,
    REASONING_SESSION_STATE.FAILED,
    REASONING_SESSION_STATE.CANCELLED,
    // AUTO-B03：pausing 是瞬时状态，进程重启时需收敛为孤儿
    REASONING_SESSION_STATE.ORPHANED
  ],
  [REASONING_SESSION_STATE.PAUSED]: [
    REASONING_SESSION_STATE.RESUMING,
    REASONING_SESSION_STATE.CANCELLED,
    REASONING_SESSION_STATE.ORPHANED
  ],
  [REASONING_SESSION_STATE.RESUMING]: [
    REASONING_SESSION_STATE.RUNNING,
    REASONING_SESSION_STATE.FAILED,
    REASONING_SESSION_STATE.CANCELLED,
    REASONING_SESSION_STATE.ORPHANED
  ],
  [REASONING_SESSION_STATE.RETRY_WAIT]: [
    REASONING_SESSION_STATE.RUNNING,
    REASONING_SESSION_STATE.FAILED,
    REASONING_SESSION_STATE.BLOCKED,
    REASONING_SESSION_STATE.CANCELLED,
    REASONING_SESSION_STATE.ORPHANED,
    REASONING_SESSION_STATE.TIMEOUT
  ],
  [REASONING_SESSION_STATE.COMPLETED]: [],
  [REASONING_SESSION_STATE.FAILED]: [
    REASONING_SESSION_STATE.RETRY_WAIT,
    REASONING_SESSION_STATE.QUEUED,
    // AUTO-C02：needs_review/blocked 类失败（如审核拒绝）失败后收敛为 blocked，等待人工处理
    REASONING_SESSION_STATE.BLOCKED
  ],
  [REASONING_SESSION_STATE.BLOCKED]: [
    REASONING_SESSION_STATE.QUEUED,
    REASONING_SESSION_STATE.RUNNING,
    REASONING_SESSION_STATE.CANCELLED
  ],
  [REASONING_SESSION_STATE.CANCELLED]: [],
  [REASONING_SESSION_STATE.ORPHANED]: [
    REASONING_SESSION_STATE.RUNNING,
    REASONING_SESSION_STATE.FAILED,
    REASONING_SESSION_STATE.BLOCKED,
    REASONING_SESSION_STATE.CANCELLED
  ],
  [REASONING_SESSION_STATE.TIMEOUT]: [
    REASONING_SESSION_STATE.RETRY_WAIT,
    REASONING_SESSION_STATE.FAILED,
    REASONING_SESSION_STATE.BLOCKED
  ]
})

/**
 * 判断状态是否为终态。
 */
export function isTerminalSessionState(status) {
  return TERMINAL_STATES.has(status)
}

/**
 * 判断 from -> to 是否为合法转移。
 */
export function isLegalSessionTransition(from, to) {
  if (!from || !to) return false
  if (from === to) return true
  const allowed = LEGAL_TRANSITIONS[from]
  if (!allowed) return false
  return allowed.includes(to)
}

/**
 * 获取某状态允许转移到的目标状态列表。
 */
export function getAllowedTransitions(from) {
  return LEGAL_TRANSITIONS[from] || []
}

/**
 * 校验并返回转移结果；不修改持久化。
 */
export function validateSessionTransition(from, to) {
  if (!Object.values(REASONING_SESSION_STATE).includes(to)) {
    return { ok: false, error: `unknown_target_state:${to}` }
  }
  if (isTerminalSessionState(from)) {
    return { ok: false, error: `terminal_state_cannot_transition:${from}->${to}` }
  }
  if (!isLegalSessionTransition(from, to)) {
    return { ok: false, error: `illegal_transition:${from}->${to}` }
  }
  return { ok: true }
}

/**
 * 在 updateReasoningSession 的 updater 内执行状态转移。
 * 返回更新后的 session 副本，并附带 stateTransition 记录。
 */
export function applySessionTransition(session, toStatus, reason = '') {
  const fromStatus = session.status
  const validation = validateSessionTransition(fromStatus, toStatus)
  if (!validation.ok) {
    throw new Error(`session_state_transition_rejected:${validation.error}`)
  }

  const now = new Date().toISOString()
  const transition = {
    from: fromStatus,
    to: toStatus,
    reason: String(reason || ''),
    timestamp: now
  }

  const transitions = Array.isArray(session.stateTransitions)
    ? [...session.stateTransitions, transition]
    : [transition]

  return {
    ...session,
    status: toStatus,
    stateTransitions: transitions,
    updatedAt: now
  }
}

/**
 * 兼容旧状态的映射：将历史隐式状态映射到状态机状态。
 */
export function normalizeLegacySessionStatus(status) {
  const value = String(status || '').trim()
  if (!value) return REASONING_SESSION_STATE.QUEUED
  if (Object.values(REASONING_SESSION_STATE).includes(value)) return value
  if (value === 'pending') return REASONING_SESSION_STATE.QUEUED
  if (value === 'pending-review') return REASONING_SESSION_STATE.WAITING_REVIEW
  if (value === 'error') return REASONING_SESSION_STATE.FAILED
  if (value === 'skipped') return REASONING_SESSION_STATE.COMPLETED
  return REASONING_SESSION_STATE.BLOCKED
}
