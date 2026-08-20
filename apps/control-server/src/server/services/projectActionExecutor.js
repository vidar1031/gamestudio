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
import { enforceActionBoundary } from './projectBoundaryGuard.js'
import { backupActionArtifacts, rollbackAction } from './rollbackService.js'
import { appendGovernanceAudit } from '../reasoning/governanceAudit.js'

/**
 * 证据链完整性检查：确保 action 具备认定成功所需的最小证据集。
 */
function checkEvidenceCompleteness(action, capability) {
  const missing = []
  const evidenceTypes = new Set((action?.evidence || []).map((item) => item?.type))

  if (!evidenceTypes.has('capability_bound')) missing.push('capability_bound')
  if (!evidenceTypes.has('execution_start')) missing.push('execution_start')
  if (!evidenceTypes.has('validation')) missing.push('validation')
  if (!action?.result && !action?.error) missing.push('result_or_error')
  if (capability?.type === 'write' && !evidenceTypes.has('artifact_backup')) missing.push('artifact_backup')
  if (capability?.requiresReview && !action?.review) missing.push('review_record')

  return { ok: missing.length === 0, missing }
}

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
  if (action.state !== ACTION_STATE.READY && action.state !== ACTION_STATE.RETRY_WAIT && action.state !== ACTION_STATE.APPROVED) {
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

  // 项目边界保护：所有动作执行前必须校验路径与项目边界
  const boundaryCheck = enforceActionBoundary(action, capability, capabilitySummary.runtimeDescriptor)
  if (!boundaryCheck.ok) {
    transitionAction(actionId, ACTION_STATE.FAILED, 'boundary_violation', {
      type: 'boundary_check',
      errors: boundaryCheck.errors
    })
    appendGovernanceAudit({
      action: 'action_boundary_blocked',
      result: 'blocked',
      detail: `动作 ${actionId} 越界被拦截：${boundaryCheck.errors.map((e) => `${e.field}=${e.path}(${e.error})`).join('; ')}`,
      actor: action.actor,
      data: { actionId, errors: boundaryCheck.errors }
    })
    return { ok: false, error: 'boundary_violation', action: getAction(actionId), boundaryErrors: boundaryCheck.errors }
  }

  // dryRun：只校验 schema 与 review 要求，不真正执行
  if (dryRun) {
    transitionAction(actionId, ACTION_STATE.READY, 'dry_run_validated', {
      type: 'dry_run',
      capability: { id: capability.id, type: capability.type, requiresReview: capability.requiresReview },
      boundaryCheck: 'passed'
    })
    return { ok: true, action: getAction(actionId), validation: { ok: true, dryRun: true } }
  }

  // review gate 强制闭环：需要审核的动作，必须处于 APPROVED 状态才能执行真实 output。
  // confirmed 参数仅在 action.state === APPROVED 时有效；否则一律拒绝。
  if (capability.requiresReview) {
    if (action.state !== ACTION_STATE.APPROVED) {
      if (!confirmed) {
        transitionAction(actionId, ACTION_STATE.WAITING_REVIEW, 'review_required', {
          type: 'review_gate',
          capability: { id: capability.id, requiresReview: true },
          boundaryCheck: 'passed'
        })
        return { ok: false, error: 'review_required', action: getAction(actionId) }
      }
      // 已确认但未获批准：强制拒绝，防止绕过审核直接执行
      transitionAction(actionId, ACTION_STATE.FAILED, 'review_not_approved', {
        type: 'review_gate',
        capability: { id: capability.id, requiresReview: true },
        boundaryCheck: 'passed',
        error: 'action_not_approved'
      })
      appendGovernanceAudit({
        action: 'action_review_bypass_blocked',
        result: 'blocked',
        detail: `动作 ${actionId} 未获批准但被尝试执行（confirmed=${confirmed}），已强制阻断`,
        actor: action.actor,
        data: { actionId, confirmed, state: action.state }
      })
      return { ok: false, error: 'review_not_approved', action: getAction(actionId) }
    }
  }

  // 写入类动作：执行前备份将被修改的文件
  let backups = []
  if (capability.type === 'write') {
    const backupResult = backupActionArtifacts(actionId, action, capability, capabilitySummary.runtimeDescriptor)
    if (!backupResult.ok) {
      transitionAction(actionId, ACTION_STATE.FAILED, 'backup_failed', {
        type: 'backup_error',
        error: backupResult.error
      })
      return { ok: false, error: `backup_failed:${backupResult.error}`, action: getAction(actionId) }
    }
    backups = backupResult.backups
    if (backups.length) {
      transitionAction(actionId, ACTION_STATE.READY, 'artifacts_backed_up', {
        type: 'artifact_backup',
        backups: backups.map((b) => ({ relPath: b.relPath, backupPath: b.backupPath }))
      })
    }
  }

  transitionAction(actionId, ACTION_STATE.EXECUTING, 'execution_started', {
    type: 'execution_start',
    dryRun: false
  })

  // 确定底层事件 ID：优先使用 capability.event.eventId（业务动作到真实事件的映射）
  const eventId = String(capability.event?.eventId || action.capabilityId || '').trim()
  if (!eventId) {
    transitionAction(actionId, ACTION_STATE.FAILED, 'event_id_missing', {
      type: 'execution_error',
      error: 'event_id_missing'
    })
    return { ok: false, error: 'event_id_missing', action: getAction(actionId) }
  }

  let result = null
  let error = null
  try {
    const dispatchResult = await dispatchGameStudioEvent(eventId, action.input, {
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
    // 写入类动作执行失败：尝试回滚
    if (capability.type === 'write' && backups.length) {
      rollbackAction(actionId, `execution_failed:${error}`)
    }
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
  if (!validation.ok && capability.type === 'write' && backups.length) {
    // 验证失败：回滚到之前版本
    rollbackAction(actionId, `validation_failed:${validation.issues.join('; ')}`)
  }

  // 证据链完整性检查：无证据不能认定成功
  const currentAction = getAction(actionId)
  const evidenceCheck = checkEvidenceCompleteness(currentAction, capability)
  if (!evidenceCheck.ok) {
    transitionAction(actionId, ACTION_STATE.FAILED, 'evidence_incomplete', {
      type: 'evidence_check',
      missing: evidenceCheck.missing
    })
    appendGovernanceAudit({
      action: 'action_evidence_blocked',
      result: 'blocked',
      detail: `动作 ${actionId} 证据链不完整：${evidenceCheck.missing.join(', ')}`,
      actor: action.actor,
      data: { actionId, missing: evidenceCheck.missing }
    })
    return { ok: false, error: 'evidence_incomplete', action: getAction(actionId), validation, evidenceCheck }
  }

  const finalState = validation.ok ? ACTION_STATE.COMPLETED : ACTION_STATE.FAILED
  const finalAction = transitionAction(actionId, finalState, validation.ok ? 'validation_passed' : 'validation_failed', {
    type: 'validation',
    validation,
    evidenceCheck
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
