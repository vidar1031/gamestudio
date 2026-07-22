/**
 * story workflow 失败判定的单一真相源。
 *
 * 历史 bug(L4-04 false-pass):只检查 step.ok === false,
 * 步骤本身 ok 但 evaluator.passed === false(如 compose evaluator 失败)
 * 会被漏判,最终 case 被自动判为 PASS。
 * 现在 evaluator 失败与步骤失败同等记为 FAIL。
 */
export function inspectStoryWorkflowFailure(session) {
  const steps = session?.artifacts?.storyProduction?.steps && typeof session.artifacts.storyProduction.steps === 'object'
    ? Object.values(session.artifacts.storyProduction.steps)
    : []
  const failedSteps = steps.filter((step) => {
    if (!step || typeof step !== 'object') return false
    if (step.ok === false) return true
    const evaluator = step.evaluator
    if (evaluator && typeof evaluator === 'object' && evaluator.passed === false) return true
    return false
  })
  return {
    hasFailure: failedSteps.length > 0,
    stepCount: steps.length,
    detail: failedSteps.length > 0
      ? `failedSteps=${failedSteps.map((step) => {
        const evaluatorFailed = step.ok !== false && step.evaluator && step.evaluator.passed === false
        return `${step.action || 'unknown'}:${step.failedStage || (evaluatorFailed ? 'evaluator_failed' : 'unknown')}`
      }).join(',')}`
      : 'failedSteps=none'
  }
}

/** 该 session 是否包含 story workflow 步骤(用于决定是否应用 workflow 失败判定)。 */
export function hasStoryWorkflowSteps(session) {
  const steps = session?.artifacts?.storyProduction?.steps
  return Boolean(steps && typeof steps === 'object' && Object.keys(steps).length > 0)
}
