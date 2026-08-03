import type { ReasoningEvent, ReasoningSession, ReasoningStoryStepResult } from '../types/reasoning'

export type ReasoningStepState = 'pending' | 'running' | 'waiting_review' | 'completed' | 'failed' | 'blocked' | 'skipped'

export type ReasoningStepView = {
  stepId: string
  title: string
  action: string
  tool: string
  state: ReasoningStepState
  summary: string
  failedStage: string | null
  evaluatorName: string
  evaluatorPassed: boolean | null
  evaluatorScore: number | null
  reviewProvider: string
  evidenceFiles: string[]
  distExists: boolean
  distUrl: string
}

function getStoryStepResult(session: ReasoningSession, stepId: string): ReasoningStoryStepResult | null {
  const steps = session.artifacts?.storyProduction?.steps
  if (!steps || typeof steps !== 'object') return null
  const hit = steps[stepId]
  return hit && typeof hit === 'object' ? hit : null
}

function getEventStepState(session: ReasoningSession, stepId: string): 'completed' | 'failed' | null {
  const events = Array.isArray(session.events) ? session.events : []
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.stepId !== stepId) continue
    if (event.type === 'step_completed') return 'completed'
    if (event.type === 'step_failed') return 'failed'
  }
  return null
}

/**
 * 把 session 的 plan 步骤推导为可视化状态：优先取 story 工作流逐步结果（含 evaluator/证据），
 * 其次取事件流（step_completed/step_failed），再结合 currentStepId 与待审核 stepId。
 */
export function getReasoningStepStates(session: ReasoningSession | null): ReasoningStepView[] {
  if (!session) return []
  const plan = session.runtimeTaskGraph || session.plan
  const steps = Array.isArray(plan?.steps) ? plan.steps : []
  return steps.map((step) => {
    const result = getStoryStepResult(session, step.stepId)
    let state: ReasoningStepState = 'pending'
    if (result) {
      if (result.ok === true) state = 'completed'
      else if (typeof result.failedStage === 'string' && result.failedStage.startsWith('blocked_by')) state = 'blocked'
      else if (result.data && (result.data as Record<string, unknown>).skipped === true) state = 'skipped'
      else state = 'failed'
    } else {
      const eventState = getEventStepState(session, step.stepId)
      if (eventState) state = eventState
    }
    if (session.review?.stepId === step.stepId && session.status === 'waiting_review') state = 'waiting_review'
    else if (session.currentStepId === step.stepId && (session.status === 'running' || session.status === 'planning')) state = 'running'

    const checks = result?.evaluator?.checks && typeof result.evaluator.checks === 'object' ? result.evaluator.checks : null
    const finalScore = checks && Number.isFinite(Number(checks.finalScore)) ? Number(checks.finalScore) : null
    const hermesReview = result?.data && typeof result.data === 'object'
      ? (result.data as Record<string, unknown>).hermesReview as Record<string, unknown> | null
      : null
    return {
      stepId: step.stepId,
      title: step.title,
      action: step.action,
      tool: step.tool,
      state,
      summary: String(result?.summary || ''),
      failedStage: result?.failedStage || null,
      evaluatorName: String(result?.evaluator?.name || ''),
      evaluatorPassed: typeof result?.evaluator?.passed === 'boolean' ? result.evaluator.passed : null,
      evaluatorScore: finalScore,
      reviewProvider: hermesReview && typeof hermesReview.provider === 'string' ? hermesReview.provider : '',
      evidenceFiles: Array.isArray(result?.snapshot?.fileNames) ? result.snapshot.fileNames.map((name) => String(name)) : [],
      distExists: Boolean(result?.snapshot?.distExists) || Boolean(result?.evidence?.distExists),
      distUrl: String(result?.evidence?.distUrl || '')
    }
  })
}

export function getStoryProductionMeta(session: ReasoningSession | null) {
  const story = session?.artifacts?.storyProduction
  let projectId = story?.projectId || null
  if (!projectId && story?.steps && typeof story.steps === 'object') {
    for (const step of Object.values(story.steps)) {
      if (step?.projectId) { projectId = step.projectId; break }
    }
  }
  return {
    projectId,
    fallback: story?.scriptsCandidateMeta?.fallback === true,
    fallbackReason: story?.scriptsCandidateMeta?.fallbackReason || null,
    provider: story?.scriptsCandidateMeta?.provider || null,
    model: story?.scriptsCandidateMeta?.model || null
  }
}

export function formatDurationSeconds(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.round(Number(totalSeconds) || 0))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const seconds = safeSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function getReasoningSessionElapsedSeconds(session: ReasoningSession | null, nowMs: number) {
  if (!session) return 0
  const startedAt = new Date(session.createdAt).getTime()
  if (Number.isNaN(startedAt)) return 0
  const isFinished = session.status === 'completed' || session.status === 'failed' || session.status === 'cancelled'
  const endAt = isFinished ? new Date(session.updatedAt).getTime() : nowMs
  if (Number.isNaN(endAt)) return 0
  return Math.max(0, Math.round((endAt - startedAt) / 1000))
}

export function getReasoningEventData(event: ReasoningEvent) {
  return event.data && typeof event.data === 'object' ? event.data : null
}

export function getReasoningEventMetaLines(event: ReasoningEvent) {
  const data = getReasoningEventData(event)
  if (!data) return [] as string[]

  const lines: string[] = []
  if (typeof data.phase === 'string' && data.phase.trim()) {
    lines.push(`阶段: ${data.phase.trim()}`)
  }
  if (typeof data.tool === 'string' && data.tool.trim()) {
    lines.push(`工具: ${data.tool.trim()}`)
  }
  if (typeof data.action === 'string' && data.action.trim()) {
    lines.push(`动作: ${data.action.trim()}`)
  }
  if (typeof data.provider === 'string' && data.provider.trim()) {
    lines.push(`Provider: ${data.provider.trim()}`)
  }
  if (typeof data.model === 'string' && data.model.trim()) {
    lines.push(`模型: ${data.model.trim()}`)
  }
  if (Number.isInteger(data.stepIndex)) {
    lines.push(`步骤序号: #${Number(data.stepIndex) + 1}`)
  }
  if (Number.isInteger(data.renewalCount) && Number.isInteger(data.maxRenewals)) {
    lines.push(`续租: ${Number(data.renewalCount)}/${Number(data.maxRenewals)}`)
  }
  if (typeof data.leaseMs === 'number' && Number.isFinite(data.leaseMs)) {
    lines.push(`租约: ${Math.round(Number(data.leaseMs) / 1000)}s`)
  }
  if (typeof data.leaseExpiresAt === 'string' && data.leaseExpiresAt.trim()) {
    lines.push(`下次检查: ${formatReasoningEventTime(data.leaseExpiresAt.trim())}`)
  }
  if (typeof data.hardTimeoutAt === 'string' && data.hardTimeoutAt.trim()) {
    lines.push(`硬超时: ${formatReasoningEventTime(data.hardTimeoutAt.trim())}`)
  }
  const providerStatus = data.providerStatus && typeof data.providerStatus === 'object' ? data.providerStatus as Record<string, unknown> : null
  if (providerStatus) {
    if (typeof providerStatus.state === 'string' && providerStatus.state.trim()) {
      lines.push(`Provider状态: ${providerStatus.state.trim()}`)
    }
    if (typeof providerStatus.telemetrySource === 'string' && providerStatus.telemetrySource.trim()) {
      lines.push(`遥测来源: ${providerStatus.telemetrySource.trim()}`)
    }
    if (typeof providerStatus.checkedAt === 'string' && providerStatus.checkedAt.trim()) {
      lines.push(`最近探测: ${formatReasoningEventTime(providerStatus.checkedAt.trim())}`)
    }
    if (typeof providerStatus.nativeSessionSupported === 'boolean') {
      lines.push(`原生任务遥测: ${providerStatus.nativeSessionSupported ? '支持' : '不支持'}`)
    }
  }
  return lines
}

export function getReasoningEventOps(event: ReasoningEvent) {
  const data = getReasoningEventData(event)
  if (!data || !Array.isArray(data.observableOps)) return [] as string[]
  return data.observableOps.map((item) => String(item || '').trim()).filter(Boolean)
}

export function getReasoningEventPreviewBlocks(event: ReasoningEvent) {
  const data = getReasoningEventData(event)
  if (!data) return [] as Array<{ title: string, content: string }>

  const blocks: Array<{ title: string, content: string }> = []
  const rawResponsePreview = typeof data.rawResponsePreview === 'string' ? data.rawResponsePreview.trim() : ''
  const finalAnswerPreview = typeof data.finalAnswerPreview === 'string' ? data.finalAnswerPreview.trim() : ''
  const finalAnswer = typeof data.finalAnswer === 'string' ? data.finalAnswer.trim() : ''

  if (rawResponsePreview) {
    blocks.push({ title: 'Hermes 原始返回', content: rawResponsePreview })
  }
  if (finalAnswerPreview) {
    blocks.push({ title: 'Hermes 最终回答预览', content: finalAnswerPreview })
  } else if (finalAnswer) {
    blocks.push({ title: 'Hermes 最终回答预览', content: finalAnswer })
  }

  return blocks
}

export function formatReasoningEventTime(timestamp: string) {
  const value = new Date(timestamp)
  if (Number.isNaN(value.getTime())) return timestamp
  return value.toLocaleTimeString('zh-CN', { hour12: false })
}