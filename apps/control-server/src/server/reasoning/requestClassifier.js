import { classifyReasoningRequestFromRuleTable, inferRouteForType, listRequestClassificationRules } from './requestClassificationRules.js'

export const REASONING_REQUEST_DECISION_TYPES = [
  'project_listing',
  'project_structure_inspection',
  'directory_listing',
  'file_inspection',
  'directory_inspection',
  'surface_location',
  'capability_status_inspection',
  'story_workflow_execute',
  'write_or_invoke_review',
  'contextual_plan_answer',
  'answer_only'
]

function normalizePrompt(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function makeDecision(type, confidence, reason, overrides = {}) {
  return {
    type,
    confidence,
    reason,
    route: overrides.route || inferRouteForType(type),
    needsContext: Boolean(overrides.needsContext),
    requiresHumanReview: Boolean(overrides.requiresHumanReview),
    deterministicPlan: Boolean(overrides.deterministicPlan),
    modelDecision: Boolean(overrides.modelDecision),
    ruleId: String(overrides.ruleId || '').trim() || null,
  }
}

export function classifyReasoningRequest(userPrompt, options = {}) {
  const prompt = normalizePrompt(userPrompt)
  const decision = classifyReasoningRequestFromRuleTable(prompt, {
    contextSelection: options.contextSelection || {}
  })
  return makeDecision(decision.type, decision.confidence, decision.reason, decision)
}

export function shouldAskModelForRequestDecision(decision, options = {}) {
  if (!decision) return false
  if (options.contextSelection?.productionTest && !options.contextSelection?.requireModelAnswer && !options.contextSelection?.requireHermesModelAnswer) return false
  if (decision.deterministicPlan) return false
  if (decision.type === 'story_workflow_execute') return false
  return true
}

export function shouldUseDeterministicPlanForDecision(decision) {
  return Boolean(decision?.deterministicPlan)
}

export function buildReasoningRequestDecisionMessages(userPrompt, options = {}) {
  const ruleLines = listRequestClassificationRules().map((rule) => {
    const ruleId = String(rule.ruleId || '').trim()
    const requestType = String(rule.requestType || '').trim()
    const route = String(rule.route || inferRouteForType(requestType)).trim()
    const needsContext = rule.needsContext ? 'yes' : 'no'
    return `- ${ruleId}: type=${requestType}; route=${route}; needsContext=${needsContext}; detector=${rule.detector}`
  })
  const recentContextSummary = String(options.recentContextSummary || '').trim()
  return [
    {
      role: 'system',
      content: [
        'You are the request classification layer for the GameStudio Control Server.',
        'Your task is classification only. Do not answer the user request. Do not plan tool steps.',
        'You are deciding which rule matches the request and whether recent context memory must be used in the next planning stage.',
        'Use the rule table below to match the latest question to one request type.',
        'If the question is about a project, directory, file, or artifact existence, prefer object inspection rules over capability-status rules.',
        'Only use capability_status_inspection when the question explicitly asks whether the system is complete, covered, closed-loop, observable, recoverable, or has gaps.',
        'If the question says continue / based on previous / just now / above, treat context inheritance as a first-class signal rather than optional chat memory.',
        'Recent context is provided as a candidate reference only. You must decide whether it should be used by setting needsContext true or false.',
        'When the request depends on a previously selected project, previously listed directory, or prior session result, set needsContext=true even if the latest prompt is short.',
        'Return one strict JSON object only.',
        `Allowed type values: ${REASONING_REQUEST_DECISION_TYPES.join(', ')}.`,
        'Rule table:',
        ...ruleLines,
        'Schema: {"ruleId": string|null, "type": string, "confidence": number, "reason": string, "needsContext": boolean, "route": string}'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `Question: ${normalizePrompt(userPrompt)}`,
        recentContextSummary ? `Recent context candidates:\n${recentContextSummary}` : 'Recent context candidates: (none)'
      ].join('\n\n')
    }
  ]
}

export function parseReasoningRequestDecision(rawText, fallbackDecision) {
  const raw = String(rawText || '').trim()
  const firstBrace = raw.indexOf('{')
  const lastBrace = raw.lastIndexOf('}')
  if (firstBrace < 0 || lastBrace <= firstBrace) return fallbackDecision

  try {
    const parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1))
    const type = String(parsed?.type || '').trim()
    if (!REASONING_REQUEST_DECISION_TYPES.includes(type)) return fallbackDecision
    const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence || 0)))
    const parsedNeedsContext = typeof parsed?.needsContext === 'boolean'
      ? parsed.needsContext
      : (type === 'contextual_plan_answer' || type === 'story_workflow_execute' || type === 'project_structure_inspection')
    return makeDecision(type, confidence || 0.6, String(parsed?.reason || 'model_request_decision'), {
      needsContext: parsedNeedsContext,
      requiresHumanReview: type === 'write_or_invoke_review',
      deterministicPlan: type === 'capability_status_inspection',
      modelDecision: true,
      route: String(parsed?.route || inferRouteForType(type)).trim() || inferRouteForType(type),
      ruleId: String(parsed?.ruleId || '').trim() || fallbackDecision?.ruleId || null,
    })
  } catch {
    return fallbackDecision
  }
}