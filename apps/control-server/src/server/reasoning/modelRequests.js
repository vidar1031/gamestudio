import {
  HERMES_API_SERVER_BASE_URL,
  HERMES_CHAT_REQUEST_TIMEOUT_MS,
  HERMES_REASONING_TASK_HARD_TIMEOUT_MS,
} from '../../config/constants.js'
import { findIntentForAnswer, findIntentForPlan } from '../intents/index.js'
import {
  inferWorkspaceDirectoryFromPrompt,
} from './heuristics.js'
import {
  buildReasoningAnswerMessages,
  buildReasoningFallbackAnswer,
  buildReasoningFallbackPlan,
  buildReasoningPlannerMessages,
  extractJsonObjectString,
  normalizeReasoningPlan,
} from './promptBuilders.js'
import { buildReasoningRecentContextArtifact } from './memory.js'
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

export async function generateReasoningPlan(userPrompt, history, binding, options = {}) {
  const correctionPrompt = String(options.correctionPrompt || '').trim()
  const plannerContext = buildReasoningPlannerMessages(history, userPrompt, binding, correctionPrompt, options.contextSelection || {})
  const recentContextArtifact = buildReasoningRecentContextArtifact(plannerContext.projectMemory, plannerContext.replayableMessages, 'model')
  const deterministicPlan = buildReasoningFallbackPlan(userPrompt, history, binding, options.contextSelection || {})
  const inferredDirPath = inferWorkspaceDirectoryFromPrompt(userPrompt)
  const inferredContextDirPaths = inferredDirPath ? [] : inferWorkspaceDirectoriesFromRecentContext(userPrompt, history)

  const planMatchCtx = {
    history,
    binding,
    contextSelection: options.contextSelection || {},
    inferredDirPath,
    inferredContextDirPaths,
  }
  const matchedPlanIntent = findIntentForPlan(userPrompt, planMatchCtx)
  if (matchedPlanIntent) {
    return {
      plan: normalizeReasoningPlan(deterministicPlan, userPrompt, history, binding, options.contextSelection || {}),
      source: 'fallback',
      intentId: matchedPlanIntent.id,
      usage: null,
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
      rawResponsePreview: truncateReasoningPreview(JSON.stringify(deterministicPlan, null, 2), 2400)
    }
  }

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
    const response = await fetch(`${HERMES_API_SERVER_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'hermes-agent',
        messages: plannerContext.messages,
        max_tokens: 260,
        temperature: 0.1
      })
    })

    if (!response.ok) {
      throw new Error(`reasoning_plan_http_${response.status}_${response.statusText}`)
    }

    const data = await response.json()
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
    const response = await fetch(`${HERMES_API_SERVER_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'hermes-agent',
        messages: answerMessages,
        max_tokens: 220
      })
    })

    if (!response.ok) {
      throw new Error(`reasoning_model_http_${response.status}_${response.statusText}`)
    }

    const data = await response.json()
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
          limit: Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || 0))
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
          limit: Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || 0))
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
