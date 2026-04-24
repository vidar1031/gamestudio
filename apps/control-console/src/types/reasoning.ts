export type ReasoningPlanStep = {
  stepId: string
  title: string
  action: string
  tool: string
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
  targetType: 'plan' | 'step' | 'completion' | 'answer'
  stepId?: string | null
  stepIndex?: number | null
  title: string
  summary: string
  correctionPrompt?: string | null
  iteration?: number
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
  agentId: string
  userPrompt: string
  status: 'planning' | 'running' | 'waiting_review' | 'completed' | 'failed'
  createdAt: string
  updatedAt: string
  plan: ReasoningPlan | null
  currentStepId: string | null
  review?: ReasoningReview | null
  events: ReasoningEvent[]
  artifacts: {
    projectRoot?: string
    storyIndex?: ReasoningStoryIndexItem[]
    finalAnswer?: string
    finalAnswerPersisted?: boolean
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