import {
  HERMES_CHAT_REQUEST_TIMEOUT_MS,
  HERMES_REASONING_TASK_HARD_TIMEOUT_MS,
} from '../../config/constants.js'
import { requestHermesChatCompletion } from '../model/modelTaskQueue.js'
import { findIntentForAnswer, findIntentForPlan } from '../intents/index.js'
import { buildProjectCapabilityStatusPlan } from '../workflows/projectStatusWorkflows.js'
import {
  inferWorkspaceDirectoryFromPrompt,
} from './heuristics.js'
import {
  buildReasoningAnswerMessages,
  buildReasoningFallbackAnswer,
  buildReasoningFallbackPlan,
  buildReasoningPlannerMessages,
  extractJsonObjectString,
  isLikelyReadOnlyReasoningPrompt,
  normalizeReasoningPlan,
} from './promptBuilders.js'
import { buildReasoningRecentContextArtifact } from './memory.js'
import {
  buildReasoningRequestDecisionMessages,
  classifyReasoningRequest,
  parseReasoningRequestDecision,
  shouldAskModelForRequestDecision,
  shouldUseDeterministicPlanForDecision,
} from './requestClassifier.js'
import {
  buildStructuredOutboundPreview,
  collectReplayableHermesMessages,
  inferWorkspaceDirectoriesFromRecentContext,
  truncateReasoningPreview,
} from '../controlServerCore.js'

export function getReasoningRequestError(error, phase) {
  if (error?.name === 'AbortError') {
    const timeoutMs = phase === 'reasoning_plan'
      ? HERMES_REASONING_TASK_HARD_TIMEOUT_MS
      : HERMES_CHAT_REQUEST_TIMEOUT_MS
    return `${phase}_timeout_${timeoutMs}`
  }
  return error instanceof Error ? error.message : String(error)
}

async function resolveReasoningRequestDecision(userPrompt, options = {}) {
  const fallbackDecision = classifyReasoningRequest(userPrompt, {
    contextSelection: options.contextSelection || {}
  })
  const messages = buildReasoningRequestDecisionMessages(userPrompt)

  if (!shouldAskModelForRequestDecision(fallbackDecision, options)) {
    return {
      decision: fallbackDecision,
      messages,
      usage: null,
      rawResponsePreview: JSON.stringify({ reason: 'deterministic_request_decision', decision: fallbackDecision }, null, 2)
    }
  }

  try {
    const data = await requestHermesChatCompletion({
      sessionId: options.sessionId || null,
      phase: 'reasoning_decision',
      messages,
      maxTokens: 160,
      temperature: 0,
      signal: options.signal || undefined,
      timeoutMs: Math.min(Number(options.timeoutMs || HERMES_CHAT_REQUEST_TIMEOUT_MS), 20000)
    })
    const content = data.choices?.[0]?.message?.content || ''
    return {
      decision: parseReasoningRequestDecision(content, fallbackDecision),
      messages,
      usage: data.usage || null,
      rawResponsePreview: content || JSON.stringify({ reason: 'empty_model_request_decision', decision: fallbackDecision }, null, 2)
    }
  } catch (error) {
    return {
      decision: fallbackDecision,
      messages,
      usage: null,
      rawResponsePreview: JSON.stringify({
        reason: 'model_request_decision_failed',
        error: error instanceof Error ? error.message : String(error),
        decision: fallbackDecision
      }, null, 2)
    }
  }
}

export async function generateReasoningPlan(userPrompt, history, binding, options = {}) {
  const correctionPrompt = String(options.correctionPrompt || '').trim()
  const requestDecision = await resolveReasoningRequestDecision(userPrompt, {
    sessionId: options.sessionId || null,
    signal: options.signal || null,
    timeoutMs: options.timeoutMs,
    contextSelection: options.contextSelection || {}
  })
  const deterministicPlan = requestDecision.decision?.type === 'capability_status_inspection'
    ? buildProjectCapabilityStatusPlan(userPrompt)
    : buildReasoningFallbackPlan(userPrompt, history, binding, options.contextSelection || {})
  const inferredDirPath = inferWorkspaceDirectoryFromPrompt(userPrompt)
  const inferredContextDirPaths = inferredDirPath ? [] : inferWorkspaceDirectoriesFromRecentContext(userPrompt, history)
  const readOnlyProductionTest = Boolean(options.contextSelection?.productionTest)
    && isLikelyReadOnlyReasoningPrompt(userPrompt)

  const planMatchCtx = {
    history,
    binding,
    contextSelection: options.contextSelection || {},
    inferredDirPath,
    inferredContextDirPaths,
  }
  const matchedPlanIntent = findIntentForPlan(userPrompt, planMatchCtx)
  if (shouldUseDeterministicPlanForDecision(requestDecision.decision) || matchedPlanIntent || readOnlyProductionTest) {
    const recentContextArtifact = {
      replayedMessageCount: 0,
      selectedMemorySources: [],
      loadedMemorySources: [],
      plannerSource: 'request_decision',
      requestDecision: requestDecision.decision
    }
    return {
      plan: normalizeReasoningPlan(deterministicPlan, userPrompt, history, binding, options.contextSelection || {}),
      source: 'fallback',
      intentId: matchedPlanIntent?.id || null,
      usage: null,
      recentContextArtifact,
      outboundPreview: buildStructuredOutboundPreview({
        binding,
        messages: requestDecision.messages,
        purpose: 'reasoning-request-decision',
        mode: 'reasoning',
        userPrompt,
        replayedMessageCount: 0,
        contextSelection: options.contextSelection || {},
        history
      }),
      rawResponsePreview: truncateReasoningPreview(JSON.stringify({
        reason: readOnlyProductionTest
          ? 'production_test_read_only_fallback_plan'
          : (matchedPlanIntent ? `matched_intent_${matchedPlanIntent.id}` : 'matched_request_decision'),
        requestDecision: requestDecision.decision,
        plan: deterministicPlan
      }, null, 2), 2400)
    }
  }

  const plannerContext = buildReasoningPlannerMessages(
    history,
    userPrompt,
    binding,
    correctionPrompt,
    {
      ...(options.contextSelection || {}),
      requestDecision: requestDecision.decision
    },
    options.priorArtifacts || null
  )
  const recentContextArtifact = buildReasoningRecentContextArtifact(plannerContext.projectMemory, plannerContext.replayableMessages, 'model')
  recentContextArtifact.requestDecision = requestDecision.decision

  const controller = new AbortController()
  const timeoutMs = Number(options.timeoutMs || HERMES_REASONING_TASK_HARD_TIMEOUT_MS)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const externalSignal = options.signal || null
  const abortFromExternalSignal = () => controller.abort()

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort()
    } else {
      externalSignal.addEventListener('abort', abortFromExternalSignal, { once: true })
    }
  }

  try {
    const data = await requestHermesChatCompletion({
      sessionId: options.sessionId || null,
      phase: 'reasoning_plan',
      messages: plannerContext.messages,
      maxTokens: 260,
      temperature: 0.1,
      signal: controller.signal,
      timeoutMs
    })
    const content = data.choices?.[0]?.message?.content || ''
    let parsed = null
    let source = 'model'
    try {
      parsed = JSON.parse(extractJsonObjectString(content))
    } catch {
      parsed = buildReasoningFallbackPlan(userPrompt, history, binding, options.contextSelection || {})
      source = 'fallback'
    }
    return {
      plan: normalizeReasoningPlan(parsed, userPrompt, history, binding, options.contextSelection || {}),
      source,
      usage: data.usage || null,
      recentContextArtifact,
      outboundPreview: buildStructuredOutboundPreview({
        binding,
        messages: plannerContext.messages,
        purpose: 'reasoning-plan',
        mode: 'reasoning',
        userPrompt,
        replayedMessageCount: plannerContext.replayableMessages.length,
        contextSelection: options.contextSelection || {},
        history
      }),
      rawResponsePreview: truncateReasoningPreview(content, 2400)
    }
  } catch (error) {
    const detail = getReasoningRequestError(error, 'reasoning_plan')
    const plannerError = new Error(detail)
    plannerError.cause = error
    plannerError.recentContextArtifact = recentContextArtifact
    throw plannerError
  } finally {
    if (externalSignal && !externalSignal.aborted) {
      externalSignal.removeEventListener('abort', abortFromExternalSignal)
    }
    clearTimeout(timeout)
  }
}

export async function generateReasoningFinalAnswer(sessionId, userPrompt, artifacts, binding, history, options = {}) {
  const matchedAnswerIntent = findIntentForAnswer(userPrompt, artifacts || {})
  if (matchedAnswerIntent && typeof matchedAnswerIntent.buildDeterministicAnswer === 'function') {
    try {
      const deterministicReply = matchedAnswerIntent.buildDeterministicAnswer(userPrompt, artifacts)
      if (deterministicReply !== null && deterministicReply !== undefined && String(deterministicReply).trim() !== '') {
        const replyText = String(deterministicReply)
        return {
          reply: replyText,
          usage: null,
          fallback: true,
          fallbackReason: matchedAnswerIntent.deterministicAnswerReason || `deterministic_intent_${matchedAnswerIntent.id}`,
          intentId: matchedAnswerIntent.id,
          outboundPreview: buildStructuredOutboundPreview({
            binding,
            messages: [],
            purpose: `deterministic-intent-answer:${matchedAnswerIntent.id}`,
            mode: 'reasoning',
            userPrompt,
            replayedMessageCount: 0,
            contextSelection: options.contextSelection || {},
            history
          }),
          rawResponsePreview: truncateReasoningPreview(replyText, 2400)
        }
      }
    } catch (error) {
      console.warn('[control-server] [intents] deterministic answer threw:', error?.message || error)
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HERMES_CHAT_REQUEST_TIMEOUT_MS)
  const externalSignal = options.signal || null
  const abortFromExternalSignal = () => controller.abort(externalSignal?.reason || 'reasoning_cancelled_by_user')
  const correctionPrompt = String(options.correctionPrompt || '').trim()
  const answerMessages = buildReasoningAnswerMessages(
    history,
    sessionId,
    userPrompt,
    artifacts,
    binding,
    correctionPrompt,
    options.contextSelection || {}
  )

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason || 'reasoning_cancelled_by_user')
    } else {
      externalSignal.addEventListener('abort', abortFromExternalSignal, { once: true })
    }
  }

  try {
    const data = await requestHermesChatCompletion({
      sessionId,
      phase: 'reasoning_answer',
      messages: answerMessages,
      maxTokens: 220,
      signal: controller.signal,
      timeoutMs: HERMES_CHAT_REQUEST_TIMEOUT_MS
    })
    return {
      reply: data.choices?.[0]?.message?.content || JSON.stringify(data),
      usage: data.usage || null,
      fallback: false,
      outboundPreview: buildStructuredOutboundPreview({
        binding,
        messages: answerMessages,
        purpose: 'reasoning-final-answer',
        mode: 'reasoning',
        userPrompt,
        replayedMessageCount: collectReplayableHermesMessages(history, {
          excludeRequestId: sessionId,
          limit: Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || 0)),
          userPrompt
        }).length,
        contextSelection: options.contextSelection || {},
        history
      }),
      rawResponsePreview: truncateReasoningPreview(data.choices?.[0]?.message?.content || JSON.stringify(data), 2400)
    }
  } catch (error) {
    if (externalSignal?.aborted) {
      throw new Error(String(externalSignal.reason || 'reasoning_cancelled_by_user'))
    }
    const fallbackReply = buildReasoningFallbackAnswer(userPrompt, artifacts)
    return {
      reply: fallbackReply,
      usage: null,
      fallback: true,
      fallbackReason: getReasoningRequestError(error, 'reasoning_answer'),
      outboundPreview: buildStructuredOutboundPreview({
        binding,
        messages: answerMessages,
        purpose: 'reasoning-final-answer',
        mode: 'reasoning',
        userPrompt,
        replayedMessageCount: collectReplayableHermesMessages(history, {
          excludeRequestId: sessionId,
          limit: Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || 0)),
          userPrompt
        }).length,
        contextSelection: options.contextSelection || {},
        history
      }),
      rawResponsePreview: truncateReasoningPreview(fallbackReply, 2400)
    }
  } finally {
    if (externalSignal && !externalSignal.aborted) {
      externalSignal.removeEventListener('abort', abortFromExternalSignal)
    }
    clearTimeout(timeout)
  }
}
