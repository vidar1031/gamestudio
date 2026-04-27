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
}

export type ReasoningReview = {
  status: 'pending'
  targetType: 'plan' | 'runtime_task_graph' | 'step' | 'completion' | 'answer'
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

export type ReasoningStoryIndexItem = {
  projectId: string
  filePath: string
  nodeCount: number
  nodeNames: string[]
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
  }
  error?: string | null
}