// 多轮优化闭环服务（阶段 4：多轮优化闭环）。
// 职责：
// - 动作失败后自动归因、修正策略、重试；
// - 硬上限 maxRounds（默认 3），超过强制终止并输出失败证据；
// - 记录每轮目标、失败原因、修正点、验证方法、结论。

import { getAction, createAction, transitionAction, ACTION_STATE } from './actionExecutionService.js'
import { executeAction } from './projectActionExecutor.js'
import { appendGovernanceAudit } from '../reasoning/governanceAudit.js'

const DEFAULT_MAX_ROUNDS = 3

/**
 * 失败归因：从 action error / validation issues 中提取可修正信号。
 */
function analyzeFailure(action) {
  const reasons = []
  if (action.error) reasons.push(String(action.error))
  const lastEvidence = Array.isArray(action.evidence) ? action.evidence[action.evidence.length - 1] : null
  if (lastEvidence?.validation?.issues) {
    reasons.push(...lastEvidence.validation.issues.map(String))
  }
  return reasons.length ? reasons : ['unknown_failure']
}

/**
 * 策略修正：根据失败原因生成下一轮输入调整。
 * 当前为最小实现：仅在 input 中追加 retryHint；后续可接入模型改写 prompt。
 */
function reviseStrategy(action, failureReasons) {
  const revision = {
    type: 'retry_with_hint',
    failureReasons,
    changes: {}
  }
  const nextInput = { ...(action.input || {}) }
  // 针对常见失败模式做最小修正
  if (failureReasons.some((r) => r.includes('missing_required'))) {
    revision.type = 'retry_fill_required'
    revision.changes.fillRequired = true
  } else if (failureReasons.some((r) => r.includes('timeout'))) {
    revision.type = 'retry_extend_timeout'
    nextInput.timeoutMs = Math.min(600000, Number(nextInput.timeoutMs || 30000) * 2)
    revision.changes.timeoutMs = nextInput.timeoutMs
  } else if (failureReasons.some((r) => r.includes('review_required'))) {
    revision.type = 'retry_with_confirmation'
    revision.changes.requiresConfirmation = true
  } else {
    nextInput.retryHint = `上一轮失败：${failureReasons.join('; ')}`
    revision.changes.retryHint = nextInput.retryHint
  }
  return { nextInput, revision }
}

/**
 * 运行多轮优化闭环。
 * @param {string} actionId - 初始动作 ID
 * @param {object} options
 * @param {number} options.maxRounds - 最大轮次（默认 3）
 * @param {boolean} options.confirmed - 是否已人工确认（用于 reviewRequired 动作）
 * @returns {Promise<{ ok: boolean, finalAction: object, rounds: Array }>}
 */
export async function runOptimizationLoop(actionId, { maxRounds = DEFAULT_MAX_ROUNDS, confirmed = false } = {}) {
  const initial = getAction(actionId)
  if (!initial) {
    return { ok: false, error: 'action_not_found', finalAction: null, rounds: [] }
  }

  const rounds = []
  let current = initial
  let bestScore = -1
  let bestAction = null

  for (let round = 1; round <= Math.max(1, maxRounds); round += 1) {
    // 更新当前动作为优化第 N 轮
    if (round > 1) {
      current.optimization.round = round
      current.optimization.history = [...rounds]
    }

    const result = await executeAction(current.actionId, { confirmed })
    const validation = result.validation || { ok: false, score: 0, issues: [] }
    const failureReasons = result.ok ? [] : analyzeFailure(getAction(current.actionId))

    const roundRecord = {
      round,
      actionId: current.actionId,
      target: current.capabilityId,
      input: current.input,
      ok: result.ok,
      score: validation.score,
      failureReasons,
      revision: null,
      finishedAt: new Date().toISOString()
    }
    rounds.push(roundRecord)

    if (result.ok) {
      if (validation.score > bestScore) {
        bestScore = validation.score
        bestAction = getAction(current.actionId)
      }
      appendGovernanceAudit({
        action: 'optimization_loop',
        result: 'ok',
        detail: `动作 ${current.actionId} 第 ${round} 轮成功，得分 ${validation.score}`,
        actor: current.actor,
        data: { actionId: current.actionId, round, score: validation.score }
      })
      return { ok: true, finalAction: getAction(current.actionId), rounds, bestAction }
    }

    // 失败：记录并准备下一轮
    appendGovernanceAudit({
      action: 'optimization_loop',
      result: 'failed',
      detail: `动作 ${current.actionId} 第 ${round} 轮失败：${failureReasons.join('; ')}`,
      actor: current.actor,
      data: { actionId: current.actionId, round, failureReasons }
    })

    if (round >= maxRounds) {
      transitionAction(current.actionId, ACTION_STATE.FAILED, 'max_rounds_exceeded', {
        type: 'optimization_terminated',
        maxRounds,
        rounds
      })
      return { ok: false, error: 'max_rounds_exceeded', finalAction: getAction(current.actionId), rounds, bestAction }
    }

    // 创建下一轮动作
    const { nextInput, revision } = reviseStrategy(current, failureReasons)
    roundRecord.revision = revision
    const nextAction = createAction({
      sessionId: current.sessionId,
      capabilityId: current.capabilityId,
      input: nextInput,
      actor: current.actor,
      projectId: current.projectId
    })
    nextAction.optimization.round = round + 1
    nextAction.optimization.parentActionId = current.actionId
    transitionAction(nextAction.actionId, ACTION_STATE.READY, `optimization_round_${round + 1}`, {
      type: 'optimization_retry',
      parentActionId: current.actionId,
      revision
    })
    current = nextAction
  }

  return { ok: false, error: 'optimization_loop_exhausted', finalAction: getAction(current.actionId), rounds, bestAction }
}
