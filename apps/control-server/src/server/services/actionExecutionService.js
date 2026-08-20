// 项目动作执行服务（阶段 2：受控执行状态机）。
// 职责：
// - 为每个项目动作（capability 调用）提供独立 actionId、状态机、traceId、证据链；
// - 复用 persistentQueue 做任务排队与并发控制；
// - 与 session 级状态机解耦：action 状态独立存储，session 通过 actionIds[] 引用。
//
// 状态机：
// planned → ready → executing → waiting_review → approved → completed
//                    ↓              ↓
//                  failed ← retry_wait（可重试）
//                    ↓
//                 rolled_back（写入已撤销）
//
// 存储：state/actions/<actionId>.json（原子写：tmp + rename）

import fs from 'node:fs'
import path from 'node:path'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'
import { appendGovernanceAudit } from '../reasoning/governanceAudit.js'

const DEFAULT_ACTIONS_DIR = path.join(GAMESTUDIO_ROOT, 'state', 'actions')
const MAX_ACTION_HISTORY_ENTRIES = 50

export const ACTION_STATE = Object.freeze({
  PLANNED: 'planned',
  READY: 'ready',
  EXECUTING: 'executing',
  WAITING_REVIEW: 'waiting_review',
  APPROVED: 'approved',
  FAILED: 'failed',
  RETRY_WAIT: 'retry_wait',
  COMPLETED: 'completed',
  ROLLED_BACK: 'rolled_back'
})

const TERMINAL_ACTION_STATES = new Set([
  ACTION_STATE.COMPLETED,
  ACTION_STATE.FAILED,
  ACTION_STATE.ROLLED_BACK
])

export function isTerminalActionState(status) {
  return TERMINAL_ACTION_STATES.has(status)
}

function getActionsDir() {
  const override = process.env.HERMES_ACTIONS_DIR
  if (override && String(override).trim()) return String(override)
  return DEFAULT_ACTIONS_DIR
}

function getActionFile(actionId) {
  return path.join(getActionsDir(), `${actionId}.json`)
}

function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function generateActionId() {
  return `action_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

function generateTraceId() {
  return `trace_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

/**
 * 创建新动作。
 * @param {object} input
 * @param {string} input.sessionId - 所属 reasoning session（可选）
 * @param {string} input.capabilityId - 能力 ID（对应 eventId）
 * @param {object} input.input - 动作输入参数
 * @param {string} input.actor - 发起者（chat/console/cron/workflow/testcase）
 * @param {string} input.projectId - 项目 ID（可选，从 input 中提取）
 * @returns {object} action
 */
export function createAction({ sessionId = null, capabilityId, input = {}, actor = 'unknown', projectId = null }) {
  const actionId = generateActionId()
  const traceId = generateTraceId()
  const now = new Date().toISOString()
  const action = {
    actionId,
    traceId,
    sessionId,
    capabilityId: String(capabilityId || '').trim(),
    projectId: projectId || String(input?.projectId || '').trim() || null,
    input: input && typeof input === 'object' ? input : {},
    actor,
    state: ACTION_STATE.PLANNED,
    stateTransitions: [{ from: null, to: ACTION_STATE.PLANNED, reason: 'created', timestamp: now }],
    evidence: [],
    review: null,
    result: null,
    error: null,
    retryCount: 0,
    maxRetries: 3,
    createdAt: now,
    updatedAt: now,
    optimization: {
      round: 1,
      parentActionId: null,
      bestScore: null,
      history: []
    }
  }
  atomicWriteJson(getActionFile(actionId), action)
  appendGovernanceAudit({
    action: 'action_created',
    result: 'ok',
    detail: `创建动作 ${actionId}（${capabilityId}）`,
    actor,
    data: { actionId, traceId, capabilityId, sessionId, projectId: action.projectId }
  })
  return action
}

/**
 * 读取动作。
 */
export function getAction(actionId) {
  const file = getActionFile(actionId)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 列出动作（按创建时间倒序）。
 */
export function listActions({ sessionId = null, status = null, projectId = null, limit = 50 } = {}) {
  const dir = getActionsDir()
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
  const actions = []
  for (const name of files) {
    try {
      const action = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (sessionId && action.sessionId !== sessionId) continue
      if (status && action.state !== status) continue
      if (projectId && action.projectId !== projectId) continue
      actions.push(action)
    } catch {
      // 跳过损坏文件
    }
  }
  actions.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  return actions.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
}

/**
 * 状态转移。
 * @param {string} actionId
 * @param {string} toState
 * @param {string} reason
 * @param {object} evidence - 可选证据，会追加到 evidence[]
 * @returns {object|null} 更新后的 action
 */
export function transitionAction(actionId, toState, reason, evidence = null) {
  const action = getAction(actionId)
  if (!action) return null
  if (isTerminalActionState(action.state)) {
    // 终态不允许再转移（幂等返回）
    return action
  }
  const now = new Date().toISOString()
  const from = action.state
  const to = String(toState || '').trim()
  if (!Object.values(ACTION_STATE).includes(to)) {
    throw new Error(`invalid_action_state:${to}`)
  }
  action.state = to
  action.updatedAt = now
  action.stateTransitions.push({ from, to, reason: String(reason || ''), timestamp: now })
  if (action.stateTransitions.length > MAX_ACTION_HISTORY_ENTRIES) {
    action.stateTransitions = action.stateTransitions.slice(-MAX_ACTION_HISTORY_ENTRIES)
  }
  if (evidence && typeof evidence === 'object') {
    action.evidence.push({ timestamp: now, ...evidence })
    if (action.evidence.length > MAX_ACTION_HISTORY_ENTRIES) {
      action.evidence = action.evidence.slice(-MAX_ACTION_HISTORY_ENTRIES)
    }
  }
  atomicWriteJson(getActionFile(actionId), action)
  appendGovernanceAudit({
    action: 'action_transition',
    result: 'ok',
    detail: `动作 ${actionId} 从 ${from} 转移到 ${to}：${reason}`,
    actor: action.actor,
    data: { actionId, from, to, reason }
  })
  return action
}

/**
 * 设置动作结果。
 */
export function setActionResult(actionId, result, error = null) {
  const action = getAction(actionId)
  if (!action) return null
  action.result = result && typeof result === 'object' ? result : null
  action.error = error ? String(error) : null
  action.updatedAt = new Date().toISOString()
  atomicWriteJson(getActionFile(actionId), action)
  return action
}

/**
 * 记录审核决策。
 */
export function recordActionReview(actionId, { decision, actor, note = '' }) {
  const action = getAction(actionId)
  if (!action) return null
  const now = new Date().toISOString()
  action.review = { decision, actor, note, reviewedAt: now }
  action.updatedAt = now
  atomicWriteJson(getActionFile(actionId), action)
  appendGovernanceAudit({
    action: 'action_review',
    result: decision === 'approve' ? 'ok' : 'blocked',
    detail: `动作 ${actionId} 审核：${decision}${note ? `（${note}）` : ''}`,
    actor,
    data: { actionId, decision, note }
  })
  return action
}
