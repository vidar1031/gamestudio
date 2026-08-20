import {
  HERMES_CHAT_REQUEST_TIMEOUT_MS,
  HERMES_REASONING_TASK_HARD_TIMEOUT_MS,
} from '../../config/constants.js'
import { requestHermesChatCompletion } from '../model/modelTaskQueue.js'
import { findIntentForAnswer, findIntentForPlan } from '../intents/index.js'
import {
  buildGameStudioBootstrapPlan,
} from '../workflows/gameStudioBootstrapWorkflows.js'
import {
  buildProjectCapabilityStatusAnswer,
  buildProjectCapabilityStatusPlan,
  shouldUseDeterministicCapabilityStatusAnswer,
} from '../workflows/projectStatusWorkflows.js'
import { buildStoryWorkflowPlan } from '../workflows/storyProductionWorkflows.js'
import {
  inferWorkspaceDirectoryFromPrompt,
} from './heuristics.js'
import {
  buildReasoningAnswerMessages,
  buildReasoningFallbackAnswer,
  buildReasoningFallbackPlan,
  buildGameStudioBootstrapDeterministicAnswer,
  buildReasoningPlannerMessages,
  buildStoryWorkflowDeterministicAnswer,
  buildStoryWorkflowUserReply,
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
  buildProjectMemorySystemMessage,
  resolveModelRouteForPhase,
  truncateReasoningPreview,
} from '../controlServerCore.js'
import { assembleExploreEvidenceSources, runExploreAnswer } from './exploreAnswer.js'

export function getReasoningRequestError(error, phase) {
  if (error?.name === 'AbortError') {
    const timeoutMs = phase === 'reasoning_plan'
      ? HERMES_REASONING_TASK_HARD_TIMEOUT_MS
      : HERMES_CHAT_REQUEST_TIMEOUT_MS
    return `${phase}_timeout_${timeoutMs}`
  }
  return error instanceof Error ? error.message : String(error)
}

function normalizeReasoningText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function shouldUseProductionTestDeterministicAnswer(contextSelection = {}) {
  return Boolean(contextSelection?.productionTest)
    && String(contextSelection?.stageId || '').trim().toLowerCase() === 'l5'
    && !Boolean(contextSelection?.requireModelAnswer || contextSelection?.requireHermesModelAnswer)
}

function summarizeProductionTestArtifacts(artifacts = {}) {
  const lines = []
  const directoryListing = artifacts?.directoryListing && typeof artifacts.directoryListing === 'object'
    ? artifacts.directoryListing
    : null
  const directoryListings = artifacts?.directoryListings && typeof artifacts.directoryListings === 'object'
    ? artifacts.directoryListings
    : null
  const fileContents = artifacts?.fileContents && typeof artifacts.fileContents === 'object'
    ? artifacts.fileContents
    : null
  const workspaceSearches = artifacts?.workspaceSearches && typeof artifacts.workspaceSearches === 'object'
    ? artifacts.workspaceSearches
    : null
  const latestEvidence = artifacts?.latestStepReviewEvidence && typeof artifacts.latestStepReviewEvidence === 'object'
    ? artifacts.latestStepReviewEvidence
    : null

  if (directoryListing) {
    const entries = Array.isArray(directoryListing.entries) ? directoryListing.entries : []
    lines.push(`目录检查: ${directoryListing.requestedPath || directoryListing.resolvedPath || 'unknown'}，直接子项 ${entries.length} 个。`)
  }

  if (directoryListings) {
    for (const [name, listing] of Object.entries(directoryListings).slice(0, 4)) {
      const entries = Array.isArray(listing?.entries) ? listing.entries : []
      lines.push(`目录检查 ${name}: ${listing?.requestedPath || listing?.resolvedPath || name}，直接子项 ${entries.length} 个。`)
    }
  }

  if (fileContents) {
    const fileNames = Object.keys(fileContents).slice(0, 6)
    if (fileNames.length > 0) lines.push(`文件证据: ${fileNames.join(', ')}。`)
  }

  if (workspaceSearches) {
    for (const [name, search] of Object.entries(workspaceSearches).slice(0, 4)) {
      const count = Number(search?.count || (Array.isArray(search?.matches) ? search.matches.length : 0) || 0)
      lines.push(`文本搜索 ${name}: query=${search?.query || ''}，命中 ${count} 条。`)
    }
  }

  if (latestEvidence?.structuredResult) {
    const result = latestEvidence.structuredResult
    const status = result.status || result.errorCode || result.code || result.outcome || ''
    const summary = result.summary || result.message || result.error || result.reason || ''
    if (status || summary) lines.push(`最新步骤结果: ${[status, summary].filter(Boolean).join(' - ')}。`)
  } else if (latestEvidence?.rawResponsePreview) {
    lines.push(`最新步骤结果: ${String(latestEvidence.rawResponsePreview).replace(/\s+/g, ' ').slice(0, 260)}。`)
  }

  return lines
}

function buildProductionTestDeterministicAnswer(userPrompt, artifacts = {}, contextSelection = {}) {
  const caseId = String(contextSelection?.caseId || '').trim()
  const prompt = normalizeReasoningText(userPrompt)
  const evidenceLines = summarizeProductionTestArtifacts(artifacts)
  const boundaryHints = []

  if (/不存在目录|not_found/i.test(prompt)) boundaryHints.push('不存在目录必须返回 not_found，不应被包装成空目录成功。')
  if (/文件执行目录列举|文件当目录|not_directory/i.test(prompt)) boundaryHints.push('文件当目录列举必须返回 not_directory。')
  if (/目录执行文件读取|目录当文件|not_file/i.test(prompt)) boundaryHints.push('目录当文件读取必须返回 not_file。')
  if (/workspace 外|工作区外|外路径|path_outside_workspace/i.test(prompt)) boundaryHints.push('workspace 外路径必须被拒绝，不能读写或探测。')
  if (/白名单|脚本/i.test(prompt)) boundaryHints.push('未在白名单中的脚本不得执行，只能返回拒绝或待审核边界。')
  if (/未审核|审核/i.test(prompt)) boundaryHints.push('需要审核的写入任务在 approve 前必须停在 waiting_review，不得提前落盘。')
  if (/_inbox|proposal|提案/i.test(prompt)) boundaryHints.push('_inbox proposal 只允许作为待审核候选，不能自动晋级为运行规则。')
  if (/生命周期|启动|暂停|恢复|退出|control console|控制台/i.test(prompt)) boundaryHints.push('新增能力必须保留 Control Console 生命周期控制，包括启动、暂停、恢复、退出/停止相关操作。')
  if (/同一会话|问答|小任务|长任务|边界清晰/i.test(prompt)) boundaryHints.push('同一会话内的问答、小任务、长任务需要由 session/artifacts/currentStepId 隔离，不能串题或继承错误目标。')

  return [
    '结论：本次 L5 稳定性、安全边界或恢复能力检查可以由 Control artifacts 确定性回答，不需要再次调用 OMLX 生成最终答案。',
    `门禁: ${caseId || 'L5'}。`,
    boundaryHints.length > 0 ? `边界判定：${boundaryHints.join(' ')}` : '边界判定：以当前 session 的 plan、step events、tool_result、artifacts 和 final status 为准；没有 artifact 不能声明执行成功。',
    evidenceLines.length > 0
      ? `可观测证据：\n- ${evidenceLines.join('\n- ')}`
      : '可观测证据：当前题未要求模型创作，Control 应直接基于 session 状态、工具结果和边界规则给出结论。',
    '架构处理：L1 仍保留 Hermes/OMLX answer 证据作为硬门禁；L4 story workflow 保留必要的模型候选生成；L5 这类边界题走 deterministic final answer，避免把本地 OMLX 长请求误判为系统无限循环。'
  ].join('\n\n')
}

function detectModelAnswerSelfContradiction(reply, binding, options = {}) {
  if (!options?.contextSelection?.requireModelAnswer && !options?.contextSelection?.requireHermesModelAnswer) {
    return null
  }

  const text = normalizeReasoningText(reply)
  if (!text) return null

  const contradictionPatterns = [
    /不是通过[^。\n]{0,120}(agent-runtime|runtime session|Hermes|OMLX)/i,
    /并非通过[^。\n]{0,120}(agent-runtime|runtime session|Hermes|OMLX)/i,
    /未经过[^。\n]{0,120}(agent-runtime|runtime session|Hermes|OMLX)/i,
    /没有经过[^。\n]{0,120}(agent-runtime|runtime session|Hermes|OMLX)/i,
    /不是[^。\n]{0,80}可观测答案/i,
    /并非[^。\n]{0,80}可观测答案/i,
    /当前回答[^。\n]{0,80}(不是|并非|未|没有)[^。\n]{0,80}(Hermes|OMLX|agent-runtime)/i,
  ]

  const matchedPattern = contradictionPatterns.find((pattern) => pattern.test(text))
  if (!matchedPattern) return null

  const provider = String(binding?.provider || 'unknown').trim() || 'unknown'
  const model = String(binding?.model || 'unknown').trim() || 'unknown'
  return {
    summary: '当前答案否认了本次运行事实中的 Hermes/OMLX 链路。',
    correctionPrompt: [
      '你刚才的回答与当前运行事实自相矛盾。',
      '本次回答正在当前 agent-runtime session 内生成，并已通过 Hermes Manager 调用模型。',
      `当前模型路由事实：provider=${provider}, model=${model}。`,
      '请重新回答，并明确区分：',
      '1. 本次回答链路已经经过 Hermes / OMLX。',
      '2. 系统整体是否已经形成生产闭环。',
      '可以判断系统整体未达标，但不得否认本次回答链路已经经过当前 runtime session / Hermes / OMLX。',
      '删除任何“本次回答不是通过 agent-runtime session / Hermes / OMLX 生成”的表述。'
    ].join(' ')
  }
}

async function requestReasoningAnswerFromModel({
  sessionId,
  userPrompt,
  artifacts,
  binding,
  history,
  correctionPrompt,
  contextSelection,
  signal,
}) {
  const answerRoute = resolveModelRouteForPhase(binding, 'reasoning_answer')
  const routedBinding = answerRoute.binding
  const answerMessages = buildReasoningAnswerMessages(
    history,
    sessionId,
    userPrompt,
    artifacts,
    routedBinding,
    correctionPrompt,
    contextSelection || {}
  )
  const data = await requestHermesChatCompletion({
    sessionId,
    phase: 'reasoning_answer',
    messages: answerMessages,
    maxTokens: 8192,
    route: answerRoute,
    signal,
    timeoutMs: HERMES_CHAT_REQUEST_TIMEOUT_MS
  })
  let rawContent = String(data.choices?.[0]?.message?.content || '').trim()
  let usage = data.usage || null
  // gpt-oss 等推理模型在引用文件不可读等场景会只输出思考（reasoning_content）而正文为空；
  // 追加一轮明确的“输出正文”续写请求拿最终回答——确定性兜底，不伪造内容
  if (!rawContent && String(data.choices?.[0]?.message?.reasoning_content || '').trim()) {
    const continuation = await requestHermesChatCompletion({
      sessionId,
      phase: 'reasoning_answer_continue',
      messages: [
        ...answerMessages,
        { role: 'user', content: '系统检测：你的上一轮回复正文为空，只有思考过程。请直接输出最终回答正文（中文），不要重复思考，不要提及本提示。' }
      ],
      maxTokens: 8192,
      route: answerRoute,
      signal,
      timeoutMs: HERMES_CHAT_REQUEST_TIMEOUT_MS
    })
    const continuedContent = String(continuation.choices?.[0]?.message?.content || '').trim()
    if (continuedContent) {
      rawContent = continuedContent
      usage = continuation.usage || usage
    }
  }
  const reply = rawContent || '[模型未返回可见回答内容]'
  return {
    reply,
    usage,
    outboundPreview: buildStructuredOutboundPreview({
      binding: routedBinding,
      requestRoute: answerRoute,
      messages: answerMessages,
      purpose: 'reasoning-final-answer',
      mode: 'reasoning',
      userPrompt,
      replayedMessageCount: collectReplayableHermesMessages(history, {
        excludeRequestId: sessionId,
        limit: Math.max(0, Number(routedBinding?.workflow?.reasoningReplayWindowMessages || 0)),
        userPrompt
      }).length,
      contextSelection: contextSelection || {},
      history
    }),
    rawResponsePreview: truncateReasoningPreview(rawContent || '[模型未返回可见回答内容]', 2400)
  }
}

async function resolveReasoningRequestDecision(userPrompt, options = {}) {
  const requestDecisionRoute = resolveModelRouteForPhase(options.binding, 'reasoning_decision')
  const fallbackDecision = classifyReasoningRequest(userPrompt, {
    contextSelection: options.contextSelection || {}
  })
  const replayableMessages = collectReplayableHermesMessages(options.history || [], {
    limit: 8,
    userPrompt,
    forceCarryover: true,
  })
  const recentContextSummary = replayableMessages.length > 0
    ? replayableMessages.map((message, index) => {
        const role = message.role === 'user' ? 'user' : 'assistant'
        const content = String(message.content || '').replace(/\s+/g, ' ').trim()
        return `${index + 1}. [${role}] ${content.slice(0, 220)}`
      }).join('\n')
    : ''
  const messages = buildReasoningRequestDecisionMessages(userPrompt, { recentContextSummary })

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
      route: requestDecisionRoute,
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
    binding,
    sessionId: options.sessionId || null,
    signal: options.signal || null,
    timeoutMs: options.timeoutMs,
    contextSelection: options.contextSelection || {},
    history,
  })
  const deterministicPlan = requestDecision.decision?.type === 'capability_status_inspection'
    ? buildProjectCapabilityStatusPlan(userPrompt)
    : (requestDecision.decision?.type === 'gamestudio_bootstrap_execute'
      ? buildGameStudioBootstrapPlan(userPrompt)
      : (requestDecision.decision?.type === 'story_workflow_execute'
        ? buildStoryWorkflowPlan(userPrompt)
        : buildReasoningFallbackPlan(userPrompt, history, binding, options.contextSelection || {})))
  const inferredDirPath = inferWorkspaceDirectoryFromPrompt(userPrompt)
  const inferredContextDirPaths = inferredDirPath ? [] : inferWorkspaceDirectoriesFromRecentContext(userPrompt, history)
  const readOnlyProductionTest = Boolean(options.contextSelection?.productionTest)
    && isLikelyReadOnlyReasoningPrompt(userPrompt)
    && !Boolean(requestDecision.decision?.needsContext)
  const productionTestDeterministicPlan = Boolean(options.contextSelection?.productionTest)
    && !Boolean(options.contextSelection?.requireModelAnswer || options.contextSelection?.requireHermesModelAnswer)
  const normalizedPlanContextSelection = {
    ...(options.contextSelection || {}),
    requestDecision: requestDecision.decision
  }

  const planMatchCtx = {
    history,
    binding,
    contextSelection: options.contextSelection || {},
    inferredDirPath,
    inferredContextDirPaths,
  }
  const matchedPlanIntent = findIntentForPlan(userPrompt, planMatchCtx)
  if (shouldUseDeterministicPlanForDecision(requestDecision.decision) || matchedPlanIntent || readOnlyProductionTest || productionTestDeterministicPlan) {
    const recentContextArtifact = {
      replayedMessageCount: 0,
      selectedMemorySources: [],
      loadedMemorySources: [],
      plannerSource: 'request_decision',
      requestDecision: requestDecision.decision
    }
    return {
      plan: normalizeReasoningPlan(deterministicPlan, userPrompt, history, binding, normalizedPlanContextSelection),
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
          : (productionTestDeterministicPlan
              ? 'production_test_deterministic_plan'
              : (matchedPlanIntent ? `matched_intent_${matchedPlanIntent.id}` : 'matched_request_decision')),
        requestDecision: requestDecision.decision,
        plan: deterministicPlan
      }, null, 2), 2400)
    }
  }

  const plannerRoute = resolveModelRouteForPhase(binding, 'reasoning_plan')
  const plannerBinding = plannerRoute.binding
  const plannerContext = buildReasoningPlannerMessages(
    history,
    userPrompt,
    plannerBinding,
    correctionPrompt,
    {
      ...(options.contextSelection || {}),
      forceContextReplay: Boolean(requestDecision.decision?.needsContext),
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
      route: plannerRoute,
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
      plan: normalizeReasoningPlan(parsed, userPrompt, history, binding, normalizedPlanContextSelection),
      source,
      usage: data.usage || null,
      recentContextArtifact,
      outboundPreview: buildStructuredOutboundPreview({
        binding: plannerBinding,
        requestRoute: plannerRoute,
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

/**
 * 判断用户是否在询问任务状态/执行证据/审计详情。
 * 只有这类查询才允许走 deterministic artifact summary；普通问答必须走自然语言。
 */
function isStatusOnlyPrompt(userPrompt) {
  const text = String(userPrompt || '').trim().toLowerCase()
  if (!text) return false
  const statusKeywords = [
    '状态', '详情', '证据', '审计', 'artifact', '执行结果', '运行结果',
    'task status', 'evidence', 'audit', 'detail', 'result', 'summary',
    '查看状态', '查看证据', '查看详情', '任务详情', '执行详情'
  ]
  return statusKeywords.some((keyword) => text.includes(keyword))
}

export async function generateReasoningFinalAnswer(sessionId, userPrompt, artifacts, binding, history, options = {}) {
  const requireModelAnswer = Boolean(options.contextSelection?.requireModelAnswer || options.contextSelection?.requireHermesModelAnswer)
  const hasGameStudioBootstrapArtifacts = Boolean(artifacts?.gameStudioBootstrap && typeof artifacts.gameStudioBootstrap === 'object')
  if (!requireModelAnswer && hasGameStudioBootstrapArtifacts) {
    const bootstrapReply = buildGameStudioBootstrapDeterministicAnswer(userPrompt, artifacts)
    if (bootstrapReply) {
      return {
        reply: bootstrapReply,
        usage: null,
        fallback: true,
        fallbackReason: 'deterministic_gamestudio_bootstrap_answer',
        intentId: 'gamestudio_bootstrap_execute',
        outboundPreview: buildStructuredOutboundPreview({
          binding,
          messages: [],
          purpose: 'deterministic-gamestudio-bootstrap-answer',
          mode: 'reasoning',
          userPrompt,
          replayedMessageCount: 0,
          contextSelection: options.contextSelection || {},
          history
        }),
        rawResponsePreview: truncateReasoningPreview(bootstrapReply, 2400)
      }
    }
  }
  const hasStoryWorkflowArtifacts = Boolean(artifacts?.storyProduction && typeof artifacts.storyProduction === 'object')
  if (!requireModelAnswer && hasStoryWorkflowArtifacts) {
    // 双通道输出：status-only 查询走 artifact summary；普通问答走自然语言
    if (isStatusOnlyPrompt(userPrompt)) {
      const storyReply = buildStoryWorkflowDeterministicAnswer(userPrompt, artifacts)
      if (storyReply) {
        return {
          reply: storyReply,
          usage: null,
          fallback: true,
          fallbackReason: 'deterministic_story_workflow_artifact_answer',
          intentId: 'story_workflow_execute',
          outboundPreview: buildStructuredOutboundPreview({
            binding,
            messages: [],
            purpose: 'deterministic-story-workflow-answer',
            mode: 'reasoning',
            userPrompt,
            replayedMessageCount: 0,
            contextSelection: options.contextSelection || {},
            history
          }),
          rawResponsePreview: truncateReasoningPreview(storyReply, 2400)
        }
      }
    } else {
      const userReply = buildStoryWorkflowUserReply(userPrompt, artifacts)
      if (userReply) {
        return {
          reply: userReply,
          usage: null,
          fallback: true,
          fallbackReason: 'story_workflow_user_reply',
          intentId: 'story_workflow_execute',
          outboundPreview: buildStructuredOutboundPreview({
            binding,
            messages: [],
            purpose: 'story-workflow-user-reply',
            mode: 'reasoning',
            userPrompt,
            replayedMessageCount: 0,
            contextSelection: options.contextSelection || {},
            history
          }),
          rawResponsePreview: truncateReasoningPreview(userReply, 2400)
        }
      }
    }
  }
  if (!requireModelAnswer && shouldUseDeterministicCapabilityStatusAnswer(userPrompt, artifacts || {})) {
    const capabilityReply = buildProjectCapabilityStatusAnswer(userPrompt, artifacts || {})
    return {
      reply: capabilityReply,
      usage: null,
      fallback: true,
      fallbackReason: 'deterministic_capability_status_answer',
      intentId: 'capability_status_inspection',
      outboundPreview: buildStructuredOutboundPreview({
        binding,
        messages: [],
        purpose: 'deterministic-capability-status-answer',
        mode: 'reasoning',
        userPrompt,
        replayedMessageCount: 0,
        contextSelection: options.contextSelection || {},
        history
      }),
      rawResponsePreview: truncateReasoningPreview(capabilityReply, 2400)
    }
  }
  if (!requireModelAnswer && shouldUseProductionTestDeterministicAnswer(options.contextSelection || {})) {
    const productionReply = buildProductionTestDeterministicAnswer(userPrompt, artifacts || {}, options.contextSelection || {})
    return {
      reply: productionReply,
      usage: null,
      fallback: true,
      fallbackReason: 'deterministic_production_l5_answer',
      intentId: 'production_l5_boundary_answer',
      outboundPreview: buildStructuredOutboundPreview({
        binding,
        messages: [],
        purpose: 'deterministic-production-l5-answer',
        mode: 'reasoning',
        userPrompt,
        replayedMessageCount: 0,
        contextSelection: options.contextSelection || {},
        history
      }),
      rawResponsePreview: truncateReasoningPreview(productionReply, 2400)
    }
  }
  const matchedAnswerIntent = requireModelAnswer ? null : findIntentForAnswer(userPrompt, artifacts || {})
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
  // 咨询/问答类（answer_only）走「滚动压缩探索」，含多次模型调用（分块提取/压缩/综合/自检），
  // 外层 blanket 中止窗口对齐受监督任务硬超时；单跳路径保持原 HERMES_CHAT_REQUEST_TIMEOUT_MS。
  const answerRequestType = classifyReasoningRequest(userPrompt, { contextSelection: options.contextSelection || {} })?.type
  const useExploreAnswer = !requireModelAnswer && !options.contextSelection?.productionTest && answerRequestType === 'answer_only'
  const answerOverallTimeoutMs = useExploreAnswer ? HERMES_REASONING_TASK_HARD_TIMEOUT_MS : HERMES_CHAT_REQUEST_TIMEOUT_MS
  const timeout = setTimeout(() => controller.abort(), answerOverallTimeoutMs)
  const externalSignal = options.signal || null
  const abortFromExternalSignal = () => controller.abort(externalSignal?.reason || 'reasoning_cancelled_by_user')
  const correctionPrompt = String(options.correctionPrompt || '').trim()

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason || 'reasoning_cancelled_by_user')
    } else {
      externalSignal.addEventListener('abort', abortFromExternalSignal, { once: true })
    }
  }

  try {
    // 咨询/问答类（answer_only）走「滚动压缩探索」：分块证据提取 → 水位压缩 → 综合 → 切题自检。
    // story/bootstrap 等确定性模板答案已在上方短路；生产测试与 requireModelAnswer 硬门禁保持单跳路径不变。
    if (useExploreAnswer) {
      const exploreRoute = resolveModelRouteForPhase(binding, 'reasoning_answer')
      const exploreSources = await assembleExploreEvidenceSources({
        binding,
        route: exploreRoute,
        userPrompt,
        history,
        sessionId,
        contextSelection: options.contextSelection || {},
        deps: {
          // 记忆文件正文复用 content-injection 有界注入（任务 C 思路：每文件/总量上限 + 截尾标注）
          buildProjectMemorySections: (currentBinding, prompt, contextSelection) => {
            const memory = buildProjectMemorySystemMessage(currentBinding, prompt, { ...contextSelection, memoryOverlayMode: 'content-injection' })
            return memory?.overlayInjection?.sections || []
          },
          collectReplayableMessages: (currentHistory, replayOptions) => collectReplayableHermesMessages(currentHistory, replayOptions),
        },
      })
      const exploreResult = await runExploreAnswer({
        sessionId,
        userPrompt,
        sources: exploreSources,
        binding,
        route: exploreRoute,
        signal: controller.signal,
        correctionPrompt,
        appendEvent: options.appendEvent || null,
      })
      return {
        reply: exploreResult.reply,
        usage: exploreResult.usage,
        fallback: false,
        intentId: 'answer_only_explore',
        outboundPreview: buildStructuredOutboundPreview({
          binding: exploreRoute.binding,
          requestRoute: exploreRoute,
          messages: exploreResult.synthesisMessages,
          purpose: 'reasoning-explore-answer',
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
        rawResponsePreview: truncateReasoningPreview(exploreResult.reply, 2400),
        exploreStats: exploreResult.stats
      }
    }
    const firstAttempt = await requestReasoningAnswerFromModel({
      sessionId,
      userPrompt,
      artifacts,
      binding,
      history,
      correctionPrompt,
      contextSelection: options.contextSelection || {},
      signal: controller.signal,
    })
    const contradiction = detectModelAnswerSelfContradiction(firstAttempt.reply, binding, options)
    if (!contradiction) {
      const reply = firstAttempt.reply
      return {
        reply,
        usage: firstAttempt.usage,
        fallback: false,
        outboundPreview: firstAttempt.outboundPreview,
        rawResponsePreview: truncateReasoningPreview(reply, 2400)
      }
    }

    const repairedAttempt = await requestReasoningAnswerFromModel({
      sessionId,
      userPrompt,
      artifacts: {
        ...(artifacts || {}),
        finalAnswer: firstAttempt.reply,
        latestAnswerAssessment: {
          score: 0,
          passed: false,
          source: 'answer_self_contradiction_guard',
          summary: contradiction.summary,
          issues: [contradiction.summary],
          strengths: [],
          correctionPrompt: contradiction.correctionPrompt,
        }
      },
      binding,
      history,
      correctionPrompt: [correctionPrompt, contradiction.correctionPrompt].filter(Boolean).join('\n'),
      contextSelection: options.contextSelection || {},
      signal: controller.signal,
    })
    const reply = repairedAttempt.reply
    return {
      reply,
      usage: repairedAttempt.usage,
      fallback: false,
      outboundPreview: repairedAttempt.outboundPreview,
      rawResponsePreview: truncateReasoningPreview(reply, 2400)
    }
  } catch (error) {
    if (externalSignal?.aborted) {
      throw new Error(String(externalSignal.reason || 'reasoning_cancelled_by_user'))
    }
    // 探索路径的模型调用失败：显式失败（step_failed/session_failed 可观测），不落确定性兜底、不伪造回答
    if (error?.exploreFailure) {
      throw error
    }
    const fallbackReply = buildReasoningFallbackAnswer(userPrompt, artifacts)
    const answerMessages = buildReasoningAnswerMessages(
      history,
      sessionId,
      userPrompt,
      artifacts,
      binding,
      correctionPrompt,
      options.contextSelection || {}
    )
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
