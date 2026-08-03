/**
 * story workflow 失败判定的单一真相源。
 *
 * 历史 bug(L4-04 false-pass):只检查 step.ok === false,
 * 步骤本身 ok 但 evaluator.passed === false(如 compose evaluator 失败)
 * 会被漏判,最终 case 被自动判为 PASS。
 * 现在 evaluator 失败、evaluator 不可用或 evaluator 结果不明确均记为 FAIL。
 *
 * 注意: apps/control-server/src/server/reasoning/qualityGate.js 中有等价判定,
 * 两处逻辑必须保持一致。
 */

/** 统一 verdict 语义:session / step / production case 共享。 */
export const REASONING_VERDICT = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED'
}

/** 将 session 状态与 story workflow 失败证据转换为统一 verdict。 */
export function resolveSessionVerdict(session) {
  const status = String(session?.status || '').trim()
  const workflowFailure = inspectStoryWorkflowFailure(session)

  if (status === 'cancelled') {
    return { verdict: REASONING_VERDICT.CANCELLED, reason: 'session cancelled' }
  }
  if (status === 'waiting_review') {
    return { verdict: REASONING_VERDICT.BLOCKED, reason: 'session blocked in review' }
  }
  if (workflowFailure.hasFailure) {
    if (/image_provider_(?:not_ready|preflight)/i.test(workflowFailure.detail)) {
      return { verdict: REASONING_VERDICT.BLOCKED, reason: `story workflow blocked: ${workflowFailure.detail}` }
    }
    return { verdict: REASONING_VERDICT.FAIL, reason: `story workflow failure: ${workflowFailure.detail}` }
  }
  if (status === 'failed') {
    return { verdict: REASONING_VERDICT.FAIL, reason: session.error || 'session failed' }
  }
  if (status === 'completed') {
    const finalAnswer = String(session?.artifacts?.finalAnswer || '').trim()
    if (finalAnswer.length > 0) {
      return { verdict: REASONING_VERDICT.PASS, reason: 'session completed with final answer' }
    }
    return { verdict: REASONING_VERDICT.FAIL, reason: 'final_answer_missing' }
  }
  return { verdict: REASONING_VERDICT.BLOCKED, reason: `unexpected session status: ${status}` }
}

export function inspectStoryWorkflowFailure(session) {
  const steps = session?.artifacts?.storyProduction?.steps && typeof session.artifacts.storyProduction.steps === 'object'
    ? Object.values(session.artifacts.storyProduction.steps)
    : []
  const failedSteps = steps.filter((step) => {
    if (!step || typeof step !== 'object') return false
    if (step.ok === false) return true
    const evaluator = step.evaluator
    if (evaluator && typeof evaluator === 'object') {
      if (evaluator.passed === false) return true
      if (typeof evaluator.passed !== 'boolean') return true
      return false
    }
    // evaluator 缺失或非对象：视为 evaluator_unavailable
    if (step.ok === true) return true
    return false
  })
  return {
    hasFailure: failedSteps.length > 0,
    stepCount: steps.length,
    detail: failedSteps.length > 0
      ? `failedSteps=${failedSteps.map((step) => {
        if (step.ok === false) return `${step.action || 'unknown'}:${step.failedStage || 'unknown'}`
        const evaluator = step.evaluator
        if (!evaluator || typeof evaluator !== 'object') return `${step.action || 'unknown'}:evaluator_unavailable`
        if (typeof evaluator.passed !== 'boolean') return `${step.action || 'unknown'}:evaluator_indeterminate`
        return `${step.action || 'unknown'}:evaluator_failed`
      }).join(',')}`
      : 'failedSteps=none'
  }
}

/** 该 session 是否包含 story workflow 步骤(用于决定是否应用 workflow 失败判定)。 */
export function hasStoryWorkflowSteps(session) {
  const steps = session?.artifacts?.storyProduction?.steps
  return Boolean(steps && typeof steps === 'object' && Object.keys(steps).length > 0)
}
