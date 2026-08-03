export type ReasoningPlanStep = {
  stepId: string
  title: string
  action: string
  tool: string
  params?: Record<string, unknown>
  skipReview?: boolean
  dependsOn: string[]
}

export type ReasoningPlan = {
  planId: string
  goal: string
  strategy: string
  steps: ReasoningPlanStep[]
}

export type ReasoningEvent = {
  eventId: string
  sessionId: string
  type: string
  timestamp: string
  stepId?: string
  title: string
  summary: string
  data?: Record<string, unknown>
}

export type ChatHistoryEntry = {
  role: string
  content: string
  tokens?: any
  transient?: boolean
  sourceKey?: string
}

export type ReasoningReview = {
  status: 'pending'
  targetType: 'plan' | 'runtime_task_graph' | 'step' | 'completion' | 'answer'
  reviewPhase?: 'before_execution' | 'after_execution' | 'standard' | 'quality_override'
  action?: string | null
  stepId?: string | null
  stepIndex?: number | null
  title: string
  summary: string
  correctionPrompt?: string | null
  iteration?: number
  allowAutoApprove?: boolean
  requiredHumanDecision?: boolean
  requiresApplyOnApprove?: boolean
  evidence?: {
    outboundPreview?: unknown
    rawResponsePreview?: string | null
    structuredResult?: unknown
  } | null
}

export type ReasoningAnswerAssessment = {
  score: number
  passed: boolean
  source: string
  summary: string
  issues: string[]
  strengths: string[]
  correctionPrompt: string
}

export type ReasoningSelfReview = {
  verdict: 'approve' | 'repair' | 'human_review'
  summary: string
  issues: string[]
  strengths: string[]
  correctionPrompt: string
  reusableSections?: string[]
  promotableLesson?: {
    category: string
    summary: string
    candidateText: string
    recommendedActions: string[]
  } | null
  source?: string
}

export type ReasoningStoryIndexItem = {
  projectId: string
  filePath: string
  nodeCount: number
  nodeNames: string[]
}

export type ReasoningStoryStepResult = {
  action: string
  projectId?: string | null
  ok: boolean
  status?: string
  summary?: string
  failedStage?: string | null
  retryable?: boolean
  evaluator?: {
    name?: string
    passed?: boolean
    checks?: Record<string, unknown>
  } | null
  snapshot?: {
    projectDir?: string
    fileNames?: string[]
    distExists?: boolean
  } | null
  evidence?: {
    distExists?: boolean
    distUrl?: string | null
    distPath?: string | null
  } | null
  data?: Record<string, unknown> | null
}

export type ReasoningStoryProductionArtifacts = {
  projectId?: string | null
  steps?: Record<string, ReasoningStoryStepResult>
  scriptsCandidate?: unknown
  scriptsCandidateMeta?: {
    fallback?: boolean
    fallbackReason?: string | null
    provider?: string | null
    model?: string | null
  } | null
}

export type ReasoningSession = {
  sessionId: string
  runtimeSessionId?: string | null
  sessionKind?: 'reasoning' | 'agent_runtime'
  agentId: string
  userPrompt: string
  parentSessionId?: string | null
  childSessionIds?: string[]
  status: 'planning' | 'running' | 'waiting_review' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
  updatedAt: string
  plan: ReasoningPlan | null
  runtimeTaskGraph?: ReasoningPlan | null
  currentStepId: string | null
  review?: ReasoningReview | null
  events: ReasoningEvent[]
  artifacts: {
    projectRoot?: string
    storyIndex?: ReasoningStoryIndexItem[]
    storyProduction?: ReasoningStoryProductionArtifacts
    finalAnswer?: string
    finalAnswerPersisted?: boolean
    workspaceStructure?: Record<string, unknown>
    writtenFiles?: Array<Record<string, unknown>>
    pendingWrites?: Record<string, unknown>
    tasks?: Record<string, unknown>
    qualityGateAttempt?: number
    answerAssessmentAutoEnabled?: boolean
    latestAnswerAssessment?: ReasoningAnswerAssessment | null
    answerAssessmentHistory?: Array<{
      attempt: number
      assessedAt: string
      assessment: ReasoningAnswerAssessment
    }>
    latestSelfReview?: ReasoningSelfReview | null
    selfReviewHistory?: Array<{
      attempt: number
      reviewedAt: string
      selfReview: ReasoningSelfReview
    }>
  }
  error?: string | null
}