// 工作流编排引擎（阶段 5：工作流编排）。
// 职责：
// - 按 ProductionPlan 顺序执行事件；
// - 每个事件执行前检查 review gate；
// - 执行后验证产物；
// - 验证失败时自动修正并重试；
// - 全部完成后生成证据包。

import { createAction, getAction, transitionAction, ACTION_STATE } from './actionExecutionService.js'
import { executeAction } from './projectActionExecutor.js'
import { validateArtifact, extractProjectIdFromResult } from './artifactValidator.js'
import { appendGovernanceAudit } from '../reasoning/governanceAudit.js'

/**
 * 执行生产计划。
 * @param {object} plan - ProductionPlan（由 productionIntentCompiler 生成）
 * @param {object} context - { sessionId, actor, confirmed }
 * @returns {Promise<{ ok: boolean, plan: object, results: Array, evidencePack: object|null }>}
 */
export async function orchestrateProduction(plan, context = {}) {
  const { sessionId = null, actor = 'workflow', confirmed = false } = context
  const results = []
  let currentProjectId = null

  appendGovernanceAudit({
    action: 'workflow_orchestration_started',
    result: 'ok',
    detail: `开始执行生产计划：${plan.goal}（${plan.steps.length} 步）`,
    actor,
    data: { planId: plan.planId, steps: plan.steps.length }
  })

  for (let i = 0; i < plan.steps.length; i += 1) {
    const step = plan.steps[i]
    const stepIndex = i + 1

    // 自动填充 projectId（如果前一步已创建项目）
    const input = { ...step.input }
    if (currentProjectId && !input.projectId) {
      input.projectId = currentProjectId
    }

    // 创建 action 并自动进入 ready
    const action = createAction({
      sessionId,
      capabilityId: step.eventId,
      input,
      actor,
      projectId: input.projectId || null
    })
    transitionAction(action.actionId, ACTION_STATE.READY, 'orchestration_ready', {
      type: 'orchestration_step',
      stepId: step.stepId,
      stepIndex
    })

    // 补充 capability_bound 证据（orchestration 路径不经过 actionRoutes 的自动绑定）
    transitionAction(action.actionId, ACTION_STATE.READY, 'capability_bound', {
      type: 'capability_bound',
      capability: { id: step.eventId, type: step.resourceKind === 'none' ? 'read' : 'write', requiresReview: step.reviewRequired }
    })

    // 需要审核的动作：confirmed=true 时自动批准（生产工作流由用户显式确认后触发）
    if (step.reviewRequired && confirmed) {
      transitionAction(action.actionId, ACTION_STATE.APPROVED, 'orchestration_auto_approved', {
        type: 'orchestration_review',
        stepId: step.stepId,
        stepIndex,
        autoApproved: true
      })
    }

    // 执行 action
    const execResult = await executeAction(action.actionId, { confirmed })

    // 提取 projectId（供后续步骤使用）
    if (!currentProjectId) {
      currentProjectId = extractProjectIdFromResult(execResult.action?.result) || action.projectId
    }

    const stepResult = {
      stepId: step.stepId,
      stepIndex,
      eventId: step.eventId,
      title: step.title,
      actionId: action.actionId,
      ok: execResult.ok,
      state: execResult.action?.state || 'unknown',
      error: execResult.error || null,
      validation: execResult.validation || null,
      artifactCheck: execResult.artifactCheck || null,
      finishedAt: new Date().toISOString()
    }
    results.push(stepResult)

    // 如果步骤失败且不可重试，终止整个计划
    if (!execResult.ok) {
      const finalAction = getAction(action.actionId)
      const waitingForReview = execResult.error === 'review_required'
        || finalAction?.state === ACTION_STATE.WAITING_REVIEW
      if (waitingForReview) {
        appendGovernanceAudit({
          action: 'workflow_orchestration_waiting_review',
          result: 'blocked',
          detail: `生产计划在第 ${stepIndex} 步等待人工审核：${step.title}`,
          actor,
          data: { planId: plan.planId, stepIndex, stepId: step.stepId, actionId: action.actionId }
        })
        return {
          ok: false,
          plan,
          results,
          evidencePack: null,
          failedStep: stepResult,
          waitingForReview: true
        }
      }
      if (finalAction?.state === ACTION_STATE.FAILED || finalAction?.state === ACTION_STATE.ROLLED_BACK) {
        appendGovernanceAudit({
          action: 'workflow_orchestration_failed',
          result: 'failed',
          detail: `生产计划在第 ${stepIndex} 步失败：${step.title}（${execResult.error || 'unknown'}）`,
          actor,
          data: { planId: plan.planId, stepIndex, stepId: step.stepId, error: execResult.error }
        })
        return {
          ok: false,
          plan,
          results,
          evidencePack: null,
          failedStep: stepResult
        }
      }
    }
  }

  // 全部步骤完成：生成证据包
  const evidencePack = {
    planId: plan.planId,
    goal: plan.goal,
    userPrompt: plan.userPrompt,
    projectId: currentProjectId,
    steps: results,
    completedAt: new Date().toISOString()
  }

  appendGovernanceAudit({
    action: 'workflow_orchestration_completed',
    result: 'ok',
    detail: `生产计划完成：${plan.goal}，项目 ${currentProjectId || 'unknown'}`,
    actor,
    data: { planId: plan.planId, projectId: currentProjectId, steps: results.length }
  })

  return {
    ok: true,
    plan,
    results,
    evidencePack,
    projectId: currentProjectId
  }
}
