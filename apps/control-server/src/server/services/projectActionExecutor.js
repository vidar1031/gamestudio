// 项目动作执行器（阶段 3：项目动作执行器）。
// 职责：
// - 把 action（capability 实例）转成受控事件执行；
// - 接入事件总线 dispatchGameStudioEvent；
// - 执行后调用 actionValidator 回填验证结论；
// - 失败时按 retryPolicy 进入 retry_wait，超过上限标记 failed。

import { dispatchGameStudioEvent } from '../events/eventDispatcher.js'
import { getProjectBinding } from './projectBindingService.js'
import { getProjectCapabilities } from './projectCapabilityService.js'
import {
  getAction,
  transitionAction,
  setActionResult,
  ACTION_STATE
} from './actionExecutionService.js'
import { validateActionResult } from './actionValidator.js'
import { appendGovernanceAudit } from '../reasoning/governanceAudit.js'

/**
 * 执行动作。
 * @param {string} actionId
 * @param {object} options
 * @param {boolean} options.dryRun - 只校验不执行
 * @param {boolean} options.confirmed - 是否已人工确认（用于 reviewRequired 动作）
 * @returns {Promise<{ ok: boolean, action: object, validation?: object }>}
 */
export async function executeAction(actionId, { dryRun = false, confirmed = false } = {}) {
  const action = getAction(actionId)
  if (!action) {
    return { ok: false, error: 'action_not_found', action: null }
  }
  if (action.state !== ACTION_STATE.READY && action.state !== ACTION_STATE.RETRY_WAIT) {
    return { ok: false, error: `action_not_executable:${action.state}`, action }
  }

  const binding = getProjectBinding()
  const capabilitySummary = getProjectCapabilities(binding)
  const capability = capabilitySummary.capabilities.find((item) => item.id === action.capabilityId)
  if (!capability) {
    const failed = transitionAction(actionId, ACTION_STATE.FAILED, 'capability_not_found', {
      type: 'execution_error',
      error: 'capability_not_found'
    })
    return { ok: false, error: 'capability_not_found', action: failed }
  }

  // dryRun：只校验 schema 与 review 要求，不真正执行
  if (dryRun) {
    transitionAction(actionId, ACTION_STATE.READY, 'dry_run_validated', {
      type: 'dry_run',
      capability: { id: capability.id, type: capability.type, requiresReview: capability.requiresReview }
    })
    return { ok: true, action: getAction(actionId), validation: { ok: true, dryRun: true } }
  }

  // review gate：需要审核但未确认
  if (capability.requiresReview && !confirmed) {
    transitionAction(actionId, ACTION_STATE.WAITING_REVIEW, 'review_required', {
      type: 'review_gate',
      capability: { id: capability.id, requiresReview: true }
    })
    return { ok: false, error: 'review_required', action: getAction(actionId) }
  }

  transitionAction(actionId, ACTION_STATE.EXECUTING, 'execution_started', {
    type: 'execution_start',
    dryRun: false
  })

  let result = null
  let error = null
  try {
    const dispatchResult = await dispatchGameStudioEvent(action.capabilityId, action.input, {
      caller: action.actor === 'console' ? 'console' : 'workflow',
      confirmed,
      sessionId: action.sessionId || null
    })
    if (!dispatchResult.ok) {
      error = dispatchResult.error || 'dispatch_failed'
      result = dispatchResult
    } else {
      result = dispatchResult.result ?? dispatchResult
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  setActionResult(actionId, result, error)

  if (error) {
    const nextState = action.retryCount < action.maxRetries ? ACTION_STATE.RETRY_WAIT : ACTION_STATE.FAILED
    const updated = transitionAction(actionId, nextState, error, {
      type: 'execution_error',
      error,
      retryCount: action.retryCount
    })
    if (nextState === ACTION_STATE.RETRY_WAIT) {
      // 增加重试计数
      const current = getAction(actionId)
      current.retryCount += 1
      const fs = await import('node:fs')
      const path = await import('node:path')
      const { GAMESTUDIO_ROOT } = await import('../../config/paths.js')
      const file = path.join(GAMESTUDIO_ROOT, 'state', 'actions', `${actionId}.json`)
      fs.writeFileSync(file, JSON.stringify(current, null, 2), 'utf8')
    }
    appendGovernanceAudit({
      action: 'action_executed',
      result: 'failed',
      detail: `动作 ${actionId} 执行失败：${error}`,
      actor: action.actor,
      data: { actionId, error, retryCount: action.retryCount }
    })
    return { ok: false, error, action: getAction(actionId) }
  }

  // 验证结果
  const validation = validateActionResult(action, capability, result)
  const finalState = validation.ok ? ACTION_STATE.COMPLETED : ACTION_STATE.FAILED
  const finalAction = transitionAction(actionId, finalState, validation.ok ? 'validation_passed' : 'validation_failed', {
    type: 'validation',
    validation
  })

  appendGovernanceAudit({
    action: 'action_executed',
    result: validation.ok ? 'ok' : 'failed',
    detail: `动作 ${actionId} 执行${validation.ok ? '成功' : '失败'}：${validation.issues.join('; ') || '无问题'}`,
    actor: action.actor,
    data: { actionId, validation }
  })

  return { ok: validation.ok, action: finalAction, validation }
}
