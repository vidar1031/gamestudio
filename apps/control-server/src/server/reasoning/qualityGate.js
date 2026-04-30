import {
  HERMES_REASONING_MIN_ACCEPT_SCORE,
  HERMES_REASONING_QUALITY_REQUEST_TIMEOUT_MS,
} from '../../config/constants.js'
import { findIntentForEvaluation } from '../intents/index.js'
import { enqueueSelfReviewOperatorProposals } from '../intents/proposals.js'
import { requestHermesChatCompletion } from '../model/modelTaskQueue.js'
import { summarizeReasoningArtifactsForAssessment } from './heuristics.js'
import { extractJsonObjectString } from './promptBuilders.js'
import {
  appendReasoningEvent,
  buildReasoningReview,
  finalizeReasoningSession,
  readReasoningSession,
  readRecentReasoningQualityCalibrations,
  appendReasoningImprovementCandidateRecord,
  appendReasoningSelfReviewRecord,
  requestReasoningReview,
  truncateReasoningPreview,
  updateReasoningSession,
} from '../controlServerCore.js'

const QUALITY_MODEL_HEARTBEAT_MS = 10000
const QUALITY_MODEL_CANCEL_POLL_MS = 1000

const QUALITY_PHASE_LABELS = {
  quality_assessment: '最终答案评分',
  quality_self_review: '自我审查'
}

function getQualityPhaseLabel(phase) {
  return QUALITY_PHASE_LABELS[phase] || phase
}

function isReasoningCancelledError(error) {
  return /reasoning_cancelled_by_user|model_task_cancelled|model_task_aborted/i.test(String(error instanceof Error ? error.message : error || ''))
}

function assertReasoningSessionNotCancelled(sessionId) {
  const session = readReasoningSession(sessionId)
  if (session?.status === 'cancelled') {
    throw new Error(session.error || 'reasoning_cancelled_by_user')
  }
}

async function requestQualityGateChatCompletion({ sessionId, phase, messages, maxTokens, temperature }) {
  const phaseLabel = getQualityPhaseLabel(phase)
  const controller = new AbortController()
  let startedAt = 0
  let heartbeatTimer = null
  let cancelPollTimer = null

  const clearHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  const clearCancelPoll = () => {
    if (cancelPollTimer) {
      clearInterval(cancelPollTimer)
      cancelPollTimer = null
    }
  }

  const abortIfCancelled = () => {
    const session = readReasoningSession(sessionId)
    if (session?.status !== 'cancelled') return false
    controller.abort(session.error || 'reasoning_cancelled_by_user')
    return true
  }

  try {
    assertReasoningSessionNotCancelled(sessionId)
    cancelPollTimer = setInterval(abortIfCancelled, QUALITY_MODEL_CANCEL_POLL_MS)
    return await requestHermesChatCompletion({
      sessionId,
      phase,
      messages,
      maxTokens,
      temperature,
      signal: controller.signal,
      timeoutMs: HERMES_REASONING_QUALITY_REQUEST_TIMEOUT_MS,
      onStatus: (status) => {
        if (status.status === 'queued') {
          appendReasoningEvent(sessionId, 'model_task_queued', `${phaseLabel}排队`, `${phaseLabel}模型请求已进入全局模型队列。`, {
            data: { phase, activeCount: status.activeCount, queuedCount: status.queuedCount, callNumber: status.callNumber }
          })
          return
        }

        if (status.status === 'started') {
          startedAt = Date.now()
          appendReasoningEvent(sessionId, 'model_task_started', `${phaseLabel}开始`, `${phaseLabel}模型请求已开始执行。`, {
            data: { phase, queuedForMs: status.queuedForMs, activeCount: status.activeCount, queuedCount: status.queuedCount, callNumber: status.callNumber }
          })
          heartbeatTimer = setInterval(() => {
            if (abortIfCancelled()) return
            appendReasoningEvent(sessionId, 'task_heartbeat', `${phaseLabel}任务`, `${phaseLabel}仍在执行，已运行 ${Math.round((Date.now() - startedAt) / 1000)} 秒。`, {
              data: { phase, activeForMs: Date.now() - startedAt, heartbeatMs: QUALITY_MODEL_HEARTBEAT_MS }
            })
          }, QUALITY_MODEL_HEARTBEAT_MS)
          return
        }

        if (status.status === 'finished') {
          clearHeartbeat()
          appendReasoningEvent(sessionId, 'model_task_completed', `${phaseLabel}完成`, `${phaseLabel}模型请求已结束。`, {
            data: { phase, activeForMs: status.activeForMs, activeCount: status.activeCount, queuedCount: status.queuedCount, callNumber: status.callNumber }
          })
        }
      }
    })
  } catch (error) {
    if (isReasoningCancelledError(error)) throw error
    appendReasoningEvent(sessionId, 'model_task_failed', `${phaseLabel}失败`, error instanceof Error ? error.message : String(error), {
      data: { phase }
    })
    throw error
  } finally {
    clearHeartbeat()
    clearCancelPoll()
  }
}

function getReasoningRequestDecision(artifacts) {
  const decision = artifacts?.recentContext?.requestDecision
  return decision && typeof decision === 'object' ? decision : null
}

function buildQualityGateTypeRules(userPrompt, artifacts) {
  const requestDecision = getReasoningRequestDecision(artifacts)
  const type = String(requestDecision?.type || '').trim()
  const commonRules = [
    '必须只审核当前这一轮的最终回答，不要求重新规划，不要求第二轮执行。',
    '如果 artifacts 已经证明答案直接回答了问题，且没有编造未执行的工具、文件、API 或成功状态，应允许通过。',
    '如果答案缺少关键证据、把设计文档当成已实现事实、或宣称未执行过的项目写入/删除/编辑成功，必须判为 human_review 或 repair。'
  ]

  if (type === 'capability_status_inspection') {
    return [
      `请求类型：${type}。这是能力状态/覆盖度/是否完成类问题。`,
      '这类问题的正确审核标准是：回答必须基于已读取文档、intent 目录、workspace search 或代码搜索 artifacts，明确给出“已完成/未完成/部分完成/无法证明”的状态判断。',
      '允许回答“尚未覆盖、尚未实现、仍在设计阶段”，只要这个结论来自当前 artifacts 中的零命中、目录证据或文档证据。',
      '不要因为答案指出系统尚未完成而降低评分；只审核它是否诚实、可验证、没有把规划目标说成已落地。',
      ...commonRules
    ].join('\n')
  }

  if (type === 'story_workflow_execute') {
    return [
      `请求类型：${type}。这是故事创建/配置/生成/校验/导出类问题。`,
      '这类问题的正确审核标准是：回答必须引用真实执行 artifacts，包括项目路径、写入文件、校验结果、失败阶段或审核阻断原因。',
      '如果没有真实写入或业务 API 结果，不能把候选文本当成创建、删除、编辑或导出成功。',
      ...commonRules
    ].join('\n')
  }

  if (type === 'project_listing' || type === 'directory_listing') {
    return [
      `请求类型：${type}。这是目录/项目列表类问题。`,
      '这类问题的正确审核标准是：回答必须以目录 listing artifact 为准，只能陈述直接子项、数量、路径和边界错误。',
      '不能读取未执行的文件内容，也不能把目录名推断成项目配置内容。',
      ...commonRules
    ].join('\n')
  }

  return [`请求类型：${type || 'unknown'}。`, ...commonRules].join('\n')
}

export async function evaluateReasoningFinalAnswerQuality(sessionId, userPrompt, answer, artifacts, binding) {
  const matchedIntent = findIntentForEvaluation(userPrompt, artifacts || {})
  if (matchedIntent && typeof matchedIntent.evaluateAnswer === 'function') {
    try {
      const verdict = matchedIntent.evaluateAnswer(userPrompt, answer, artifacts)
      if (verdict && typeof verdict === 'object') {
        return applyReasoningQualityCalibrations({ ...verdict, intentId: matchedIntent.id }, {
          userPrompt,
          answer,
          artifacts,
          intentId: matchedIntent.id,
          verdict
        })
      }
    } catch (error) {
      console.warn('[control-server] [intents] evaluator threw:', error?.message || error)
    }
  }

  const artifactSummary = summarizeReasoningArtifactsForAssessment(artifacts)
  const qualityCalibrations = readRecentReasoningQualityCalibrations(8)
  const typeRules = buildQualityGateTypeRules(userPrompt, artifacts)
  const messages = [
    {
      role: 'system',
      content: [
        'You are the GameStudio observable reasoning answer evaluator.',
        'Return one strict JSON object only.',
        'Score the final answer from 0 to 100 against the user question and the observable artifacts.',
        'Prefer repository-local observable evidence over eloquence.',
        'If the answer invents files, tools, APIs, or folders not supported by artifacts, score it harshly.',
        'This production quality gate is one-pass only. Do not request another planning or execution round. If the answer cannot pass in this pass, explain the exact issue for human review.',
        '',
        'Request-type-specific review rules:',
        typeRules,
        'Schema: {"score": number, "summary": string, "issues": string[], "strengths": string[], "correctionPrompt": string}'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `用户问题：${userPrompt}`,
        '',
        `最终回答：${answer}`,
        '',
        '可观测 artifacts：',
        truncateReasoningPreview(JSON.stringify(artifactSummary, null, 2), 2400),
        qualityCalibrations.length > 0 ? '' : null,
        qualityCalibrations.length > 0 ? '人工确认过的评分校准样本：' : null,
        qualityCalibrations.length > 0
          ? qualityCalibrations.map((record, index) => [
              `${index + 1}. 问题：${record.userPrompt}`,
              `人工确认答案：${truncateReasoningPreview(record.finalAnswer || '', 700)}`,
              `校准建议：${truncateReasoningPreview(record.calibrationLesson || '', 700)}`
            ].join('\n')).join('\n\n')
          : null
      ].filter(Boolean).join('\n')
    }
  ]

  try {
    const data = await requestQualityGateChatCompletion({
      sessionId,
      phase: 'quality_assessment',
      messages,
      maxTokens: 220,
      temperature: 0
    })
    const raw = data.choices?.[0]?.message?.content || '{}'
    let parsed = null
    try {
      parsed = JSON.parse(extractJsonObjectString(raw))
    } catch (parseError) {
      const deterministicFallback = evaluateAnswerWithRequestTypeRules(userPrompt, answer, artifacts, parseError)
      if (deterministicFallback) return deterministicFallback
      throw parseError
    }
    const score = Math.max(0, Math.min(100, Number(parsed?.score || 0)))
    return {
      score,
      passed: score >= HERMES_REASONING_MIN_ACCEPT_SCORE,
      source: 'model',
      summary: String(parsed?.summary || '').trim() || `最终答案评分 ${score}/100。`,
      issues: Array.isArray(parsed?.issues) ? parsed.issues.map((item) => String(item || '').trim()).filter(Boolean) : [],
      strengths: Array.isArray(parsed?.strengths) ? parsed.strengths.map((item) => String(item || '').trim()).filter(Boolean) : [],
      correctionPrompt: String(parsed?.correctionPrompt || '').trim() || '请严格基于当前 observable artifacts 修正答案，删除任何未经验证的路径、工具或服务推断。'
    }
  } catch (error) {
    if (isReasoningCancelledError(error)) throw error
    const deterministicFallback = evaluateAnswerWithRequestTypeRules(userPrompt, answer, artifacts, error)
    if (deterministicFallback) return deterministicFallback
    return {
      score: 0,
      passed: false,
      source: 'fallback',
      summary: '最终答案质量评估失败。',
      issues: [error instanceof Error ? error.message : String(error)],
      strengths: [],
      correctionPrompt: '质量评估失败，请严格基于当前 observable artifacts 重新生成答案，不要引入仓库外路径或泛化架构推断。'
    }
  }
}

function evaluateAnswerWithRequestTypeRules(userPrompt, answer, artifacts, sourceError = null) {
  const requestDecision = getReasoningRequestDecision(artifacts)
  const type = String(requestDecision?.type || '').trim()
  if (type !== 'capability_status_inspection') return null

  const text = String(answer || '')
  const workspaceSearches = artifacts?.workspaceSearches && typeof artifacts.workspaceSearches === 'object'
    ? Object.values(artifacts.workspaceSearches)
    : []
  const fileContentPaths = artifacts?.fileContents && typeof artifacts.fileContents === 'object'
    ? Object.keys(artifacts.fileContents)
    : []
  const hasRelevantFiles = fileContentPaths.some((filePath) => /GAMESTUDIO_INTERACTIVE_STORY_AGENT|CONTROL_SYSTEM/.test(filePath))
  const hasIntentListing = Boolean(artifacts?.directoryListings?.['config/hermes/intents'] || artifacts?.directoryListing?.requestedPath === 'config/hermes/intents')
  const hasCodeSearch = workspaceSearches.some((item) => /apps\/control-server\/src\/server/.test(String(item?.startDir || '')))
  const hasDocsSearch = workspaceSearches.some((item) => /\/docs$|^docs$/.test(String(item?.startDir || '')))
  const hasZeroHitEvidence = workspaceSearches.some((item) => Number(item?.count || 0) === 0)
  const answersStatus = /尚未|未覆盖|没有|不存在|未实现|只存在|设计|规划|不完整|不能证明/.test(text)
  const citesEvidence = /证据|搜索|命中|文档|代码|intent|workflow|evaluator|artifacts?/i.test(text)
  const directlyAnswers = /deterministic evaluator|确定性评估|故事 workflow|故事相关 workflow|覆盖/.test(text)

  if (hasRelevantFiles && hasIntentListing && hasCodeSearch && hasDocsSearch && hasZeroHitEvidence && answersStatus && citesEvidence && directlyAnswers) {
    return {
      score: 88,
      passed: true,
      source: 'deterministic_request_type_rules',
      summary: '能力状态类答案已基于文档、intent 目录和代码/文档搜索 artifacts 给出明确状态判断；评分模型格式异常已由确定性规则兜底。',
      issues: sourceError ? [`评分模型输出格式异常：${sourceError instanceof Error ? sourceError.message : String(sourceError)}`] : [],
      strengths: [
        '回答直接回应了 deterministic evaluator 是否覆盖故事 workflow。',
        '回答没有把设计目标宣称为已实现能力。',
        '回答引用了当前可观测 artifacts 中的文档、目录或搜索证据。'
      ],
      correctionPrompt: '当前答案已通过能力状态类一轮制规则审核；后续同类问题应继续先取证再回答。'
    }
  }

  return {
    score: 55,
    passed: false,
    source: 'deterministic_request_type_rules',
    summary: '能力状态类答案未满足一轮制规则审核：需要明确状态判断，并引用当前文档、目录和代码/文档搜索 artifacts。',
    issues: [
      hasRelevantFiles ? '' : '缺少关键文档读取证据。',
      hasIntentListing ? '' : '缺少 intent 目录证据。',
      hasCodeSearch ? '' : '缺少 control-server 代码搜索证据。',
      hasDocsSearch ? '' : '缺少 docs 搜索证据。',
      answersStatus ? '' : '答案没有明确给出已完成/未完成/未覆盖/无法证明的状态判断。',
      directlyAnswers ? '' : '答案没有直接回应当前 deterministic evaluator 与故事 workflow 覆盖关系。'
    ].filter(Boolean),
    strengths: [],
    correctionPrompt: '请基于当前 observable artifacts 直接回答能力是否已覆盖；不要启动第二轮自动执行。'
  }
}

export async function evaluateReasoningSelfReview(sessionId, userPrompt, answer, artifacts, assessment, binding) {
  const artifactSummary = summarizeReasoningArtifactsForAssessment(artifacts)
  const typeRules = buildQualityGateTypeRules(userPrompt, artifacts)
  const messages = [
    {
      role: 'system',
      content: [
        'You are the GameStudio observable reasoning self-reviewer.',
        'Return one strict JSON object only.',
        'Your job is to critique the current final answer and decide whether this single run can pass.',
        'Never ask for a second automatic repair round. If this single run is not acceptable, return repair or human_review with precise correction conditions.',
        'Do not invent tools, files, or facts outside the observable artifacts and the provided assessment.',
        '',
        'Request-type-specific review rules:',
        typeRules,
        'Schema: {"verdict":"approve|repair|human_review","summary":string,"issues":string[],"strengths":string[],"correctionPrompt":string,"reusableSections":string[],"promotableLesson":{"category":string,"summary":string,"candidateText":string,"recommendedActions":string[]}|null}'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `sessionId：${sessionId}`,
        `用户问题：${userPrompt}`,
        '',
        `当前最终回答：${answer}`,
        '',
        '自动质检结论：',
        truncateReasoningPreview(JSON.stringify(assessment, null, 2), 1800),
        '',
        '可观测 artifacts：',
        truncateReasoningPreview(JSON.stringify(artifactSummary, null, 2), 2400)
      ].join('\n')
    }
  ]

  try {
    const data = await requestQualityGateChatCompletion({
      sessionId,
      phase: 'quality_self_review',
      messages,
      maxTokens: 320,
      temperature: 0
    })
    const raw = data.choices?.[0]?.message?.content || '{}'
    const parsed = JSON.parse(extractJsonObjectString(raw))
    const verdict = ['approve', 'repair', 'human_review'].includes(String(parsed?.verdict || ''))
      ? String(parsed.verdict)
      : (assessment.passed ? 'approve' : 'repair')
    const promotableLesson = parsed?.promotableLesson && typeof parsed.promotableLesson === 'object'
      ? {
          category: String(parsed.promotableLesson.category || '').trim() || 'reasoning-pattern',
          summary: String(parsed.promotableLesson.summary || '').trim(),
          candidateText: String(parsed.promotableLesson.candidateText || '').trim(),
          recommendedActions: Array.isArray(parsed.promotableLesson.recommendedActions)
            ? parsed.promotableLesson.recommendedActions.map((item) => String(item || '').trim()).filter(Boolean)
            : []
        }
      : null
    return {
      verdict,
      summary: String(parsed?.summary || '').trim() || (assessment.passed ? '当前答案与证据链一致，可直接通过。' : '当前答案仍需继续修复后再提交。'),
      issues: Array.isArray(parsed?.issues) ? parsed.issues.map((item) => String(item || '').trim()).filter(Boolean) : [],
      strengths: Array.isArray(parsed?.strengths) ? parsed.strengths.map((item) => String(item || '').trim()).filter(Boolean) : [],
      correctionPrompt: String(parsed?.correctionPrompt || '').trim() || assessment.correctionPrompt,
      reusableSections: Array.isArray(parsed?.reusableSections) ? parsed.reusableSections.map((item) => String(item || '').trim()).filter(Boolean) : [],
      promotableLesson: promotableLesson?.summary || promotableLesson?.candidateText ? promotableLesson : null,
      source: 'model'
    }
  } catch (error) {
    if (isReasoningCancelledError(error)) throw error
    return {
      verdict: assessment.passed ? 'approve' : 'repair',
      summary: assessment.passed
        ? '自动自审回退为规则结果：当前答案已通过质量门。'
        : '自动自审回退为规则结果：当前答案需继续修复。',
      issues: Array.isArray(assessment.issues) ? assessment.issues : [],
      strengths: Array.isArray(assessment.strengths) ? assessment.strengths : [],
      correctionPrompt: assessment.correctionPrompt,
      reusableSections: [],
      promotableLesson: assessment.passed
        ? {
            category: 'quality-calibration',
            summary: '通过质量门的答案与其证据链可作为后续同类题目的校准样本。',
            candidateText: '复用本次最终答案与质检证据链，优先要求回答只引用可观测 artifacts 中出现的真实路径、工具和输出。',
            recommendedActions: ['reuse_observable_artifacts', 'enforce_verified_paths_only']
          }
        : null,
      source: 'fallback',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function applyReasoningQualityCalibrations(verdict, context) {
  const normalizedVerdict = normalizeReasoningQualityVerdict(verdict)
  if (normalizedVerdict.passed) return normalizedVerdict

  const calibrations = readRecentReasoningQualityCalibrations(20)
    .map((record) => buildComparableCalibrationRecord(record, context))
    .filter(Boolean)
    .filter((record) => record.safeToApply)
    .filter((record) => record.similarityScore >= 4)
    .sort((left, right) => right.similarityScore - left.similarityScore)

  const selfConsistent = isSelfConsistentLowScore(normalizedVerdict)
  const bestCalibration = calibrations[0] || null
  if (!selfConsistent && !bestCalibration) return normalizedVerdict

  const calibratedFloor = bestCalibration
    ? Math.max(HERMES_REASONING_MIN_ACCEPT_SCORE, bestCalibration.scoreFloor)
    : HERMES_REASONING_MIN_ACCEPT_SCORE
  const score = Math.max(normalizedVerdict.score, calibratedFloor)
  const strengths = [...normalizedVerdict.strengths]
  const issues = [...normalizedVerdict.issues]
  const appliedReasons = []

  if (bestCalibration) {
    strengths.push(`已匹配人工评分校准样本：${bestCalibration.reason}`)
    appliedReasons.push(bestCalibration.reason)
  }
  if (selfConsistent) {
    strengths.push('自动评分无明确问题且证据链完整，按自洽规则提升为可人工信任结果')
    appliedReasons.push('self_consistent_evidence_chain')
  }

  return {
    ...normalizedVerdict,
    score,
    passed: score >= HERMES_REASONING_MIN_ACCEPT_SCORE,
    source: `${normalizedVerdict.source || 'deterministic'}+calibrated`,
    summary: score >= HERMES_REASONING_MIN_ACCEPT_SCORE
      ? `评分校准后 ${score}/100，已通过。`
      : normalizedVerdict.summary,
    strengths: [...new Set(strengths)],
    issues,
    calibration: {
      applied: true,
      reasons: appliedReasons,
      matchedSessionId: bestCalibration?.sessionId || null,
      previousScore: normalizedVerdict.score,
      calibratedScore: score
    },
    correctionPrompt: score >= HERMES_REASONING_MIN_ACCEPT_SCORE
      ? '当前答案已通过质量门槛；后续同类问题应复用本次人工校准和证据链自洽规则。'
      : normalizedVerdict.correctionPrompt
  }
}

function normalizeReasoningQualityVerdict(verdict) {
  const score = Math.max(0, Math.min(100, Number(verdict?.score || 0)))
  return {
    ...verdict,
    score,
    passed: Boolean(verdict?.passed) || score >= HERMES_REASONING_MIN_ACCEPT_SCORE,
    source: String(verdict?.source || 'deterministic'),
    summary: String(verdict?.summary || `最终答案评分 ${score}/100。`),
    issues: Array.isArray(verdict?.issues) ? verdict.issues.map((item) => String(item || '').trim()).filter(Boolean) : [],
    strengths: Array.isArray(verdict?.strengths) ? verdict.strengths.map((item) => String(item || '').trim()).filter(Boolean) : [],
    correctionPrompt: String(verdict?.correctionPrompt || '').trim()
  }
}

function buildComparableCalibrationRecord(record, context) {
  if (!record || typeof record !== 'object') return null
  const assessment = record.assessment && typeof record.assessment === 'object' ? record.assessment : null
  if (!assessment) return null
  const recordIntentId = assessment.intentId || record.intentId || ''
  const currentIntentId = context.intentId || ''
  let similarityScore = 0
  const reasons = []

  if (recordIntentId && currentIntentId && recordIntentId === currentIntentId) {
    similarityScore += 3
    reasons.push(`intent=${currentIntentId}`)
  }

  const currentTargets = extractQualityComparableTargets(context.userPrompt, context.answer)
  const recordTargets = extractQualityComparableTargets(record.userPrompt, record.finalAnswer)
  const sharedTargets = currentTargets.filter((target) => recordTargets.includes(target))
  if (sharedTargets.length > 0) {
    similarityScore += Math.min(4, sharedTargets.length * 2)
    reasons.push(`target=${sharedTargets.slice(0, 3).join(',')}`)
  }

  const currentTerms = extractQualityComparableTerms(context.userPrompt)
  const recordTerms = extractQualityComparableTerms(record.userPrompt)
  const overlap = currentTerms.filter((term) => recordTerms.includes(term)).length
  if (overlap > 0) {
    similarityScore += Math.min(3, overlap)
    reasons.push(`promptOverlap=${overlap}`)
  }

  const currentIssues = Array.isArray(context?.verdict?.issues) ? context.verdict.issues : []
  const recordIssues = Array.isArray(assessment.issues) ? assessment.issues : []
  if (currentIssues.length === 0 && recordIssues.length === 0) {
    similarityScore += 2
    reasons.push('noIssues')
  }

  const safeToApply = currentIssues.length === 0 || currentIssues.every(isCalibrationCompatibleIssue)

  return {
    sessionId: record.sessionId || null,
    similarityScore,
    safeToApply,
    reason: reasons.join('; ') || 'similar_calibration',
    scoreFloor: inferCalibrationScoreFloor(record)
  }
}

function isCalibrationCompatibleIssue(issue) {
  return /格式|措辞|表格|结构|README|质量评分|评分|未达到|证据.*完整但|人工确认|校准/i.test(String(issue || ''))
}

function inferCalibrationScoreFloor(record) {
  const text = [record?.calibrationLesson, record?.correctionPrompt]
    .filter(Boolean)
    .join('\n')
  const explicitScores = Array.from(String(text).matchAll(/(?:上调至|提升至|不低于|至少|score\s*(?:>=|至)?|分数[^0-9]{0,8})(\d{2,3})/gi))
    .map((match) => Number(match[1]))
    .filter((score) => Number.isFinite(score) && score >= HERMES_REASONING_MIN_ACCEPT_SCORE && score <= 100)
  if (explicitScores.length > 0) return Math.max(...explicitScores)
  return HERMES_REASONING_MIN_ACCEPT_SCORE
}

function extractQualityComparableTargets(...values) {
  const text = values.map((value) => String(value || '')).join('\n')
  return [...new Set((text.match(/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g) || [])
    .map((target) => target.replace(/[).,;，。；：]+$/g, '').replace(/^\/+/, ''))
    .filter((target) => /^(apps|packages|storage|docs|scripts|ai|config|monitor|state)\//.test(target)))]
}

function extractQualityComparableTerms(value) {
  const stopTerms = new Set(['the', 'what', 'role', 'purpose', 'explain', 'compare', 'apps', 'src', 'index', '职责', '作用', '是什么', '说明', '解释'])
  return [...new Set(String(value || '')
    .toLowerCase()
    .match(/[a-z0-9_-]{3,}|[\u4e00-\u9fff]{2,}/g) || [])]
    .filter((term) => !stopTerms.has(term))
    .slice(0, 24)
}

function isSelfConsistentLowScore(verdict) {
  if (verdict.score < 55) return false
  if (verdict.issues.length > 0) return false
  const strengths = verdict.strengths.join('\n')
  const hasAnswer = /已回答/.test(strengths)
  const hasListing = /已列出|目录作为证据|listing/i.test(strengths)
  const hasFileEvidence = /已读取|入口证据|read_file|package\.json/i.test(strengths)
  return hasAnswer && hasListing && hasFileEvidence
}

export async function finalizeReasoningSessionWithQualityGate(sessionId, binding, history) {
  const session = readReasoningSession(sessionId)
  if (!session) {
    throw new Error('reasoning_session_not_found')
  }

  const answer = String(session.artifacts?.finalAnswer || '').trim()
  if (!answer) {
    return finalizeReasoningSession(sessionId, { persistFinalAnswer: true })
  }

  // 当 submissionContext.disableQualityAutoRetry 为 true（生产测试脚本和后续 production-test 路径默认会传），
  // 不再触发 evaluateReasoningFinalAnswerQuality + evaluateReasoningSelfReview 这两次额外的 OMLX 推理。
  // 这两次质检/自审本身是控制层主动追加的「答案出来后又进 agent 自测」的来源。
  // 关闭后，最终答案直接落盘，避免与同一 session 的下一题或其它 control 操作在 OMLX 上叠加。
  const submissionContext = session.submissionContext || {}
  if (submissionContext.disableQualityAutoRetry) {
    appendReasoningEvent(sessionId, 'quality_gate_skipped', '质检与自我审查已跳过', '提交时声明 disableQualityAutoRetry=true，按契约不再触发额外的评分与自审推理调用，最终答案直接落盘。', {
      data: {
        reason: 'disable_quality_auto_retry',
        productionTest: Boolean(submissionContext.productionTest)
      }
    })
    return finalizeReasoningSession(sessionId, { persistFinalAnswer: true })
  }

  const attempt = Math.max(0, Number(session.artifacts?.qualityGateAttempt || 0)) + 1
  assertReasoningSessionNotCancelled(sessionId)
  const assessment = await evaluateReasoningFinalAnswerQuality(sessionId, session.userPrompt, answer, session.artifacts || {}, binding)
  if (readReasoningSession(sessionId)?.status === 'cancelled') return readReasoningSession(sessionId)
  updateReasoningSession(sessionId, (current) => ({
    ...current,
    artifacts: {
      ...current.artifacts,
      qualityGateAttempt: attempt,
      latestAnswerAssessment: assessment,
      answerAssessmentHistory: [
        ...(Array.isArray(current.artifacts?.answerAssessmentHistory) ? current.artifacts.answerAssessmentHistory : []),
        {
          attempt,
          assessedAt: new Date().toISOString(),
          assessment
        }
      ]
    }
  }))
  appendReasoningEvent(sessionId, 'quality_assessment_completed', '最终答案评分完成', `${assessment.summary}（一轮制质检）`, {
    data: {
      attempt,
      score: assessment.score,
      passed: assessment.passed,
      source: assessment.source,
      issues: assessment.issues,
      strengths: assessment.strengths
    }
  })

  assertReasoningSessionNotCancelled(sessionId)
  const selfReview = await evaluateReasoningSelfReview(sessionId, session.userPrompt, answer, session.artifacts || {}, assessment, binding)
  if (readReasoningSession(sessionId)?.status === 'cancelled') return readReasoningSession(sessionId)

  updateReasoningSession(sessionId, (current) => ({
    ...current,
    artifacts: {
      ...current.artifacts,
      qualityGateAttempt: attempt,
      latestSelfReview: selfReview,
      selfReviewHistory: [
        ...(Array.isArray(current.artifacts?.selfReviewHistory) ? current.artifacts.selfReviewHistory : []),
        {
          attempt,
          reviewedAt: new Date().toISOString(),
          selfReview
        }
      ]
    }
  }))

  appendReasoningSelfReviewRecord({
    sessionId,
    attempt,
    userPrompt: session.userPrompt,
    finalAnswer: answer,
    assessment,
    selfReview,
    artifactsSummary: summarizeReasoningArtifactsForAssessment(session.artifacts || {})
  })

  appendReasoningEvent(sessionId, 'final_answer_ready', '最终答案质检', `${assessment.summary}（一轮制质检）`, {
    data: {
      attempt,
      score: assessment.score,
      source: assessment.source,
      issues: assessment.issues,
      strengths: assessment.strengths
    }
  })

  appendReasoningEvent(sessionId, 'self_review_completed', '自我审查结论', selfReview.summary, {
    data: {
      attempt,
      verdict: selfReview.verdict,
      issues: selfReview.issues,
      strengths: selfReview.strengths,
      correctionPrompt: selfReview.correctionPrompt,
      reusableSections: selfReview.reusableSections,
      promotableLesson: selfReview.promotableLesson
    }
  })

  const selfReviewAllowsPass = selfReview.verdict === 'approve'
  const assessmentSelfReviewConflict = !assessment.passed && selfReviewAllowsPass
  if (assessment.passed && selfReviewAllowsPass) {
    if (selfReview.promotableLesson) {
      appendReasoningImprovementCandidateRecord({
        source: 'quality_gate_passed',
        sessionId,
        userPrompt: session.userPrompt,
        finalAnswer: answer,
        assessment,
        selfReview,
        candidate: selfReview.promotableLesson,
        artifactsSummary: summarizeReasoningArtifactsForAssessment(session.artifacts || {})
      })
      appendReasoningEvent(sessionId, 'self_improvement_candidate_recorded', '自我强化候选已记录', `已记录 1 条待审核强化候选：${selfReview.promotableLesson.summary || selfReview.promotableLesson.category || '未命名候选'}`, {
        data: {
          source: 'quality_gate_passed',
          promotableLesson: selfReview.promotableLesson
        }
      })

      const operatorProposalResult = enqueueSelfReviewOperatorProposals({
        source: 'quality_gate_passed',
        sessionId,
        userPrompt: session.userPrompt,
        finalAnswer: answer,
        assessment,
        selfReview,
      })
      if (operatorProposalResult.written.length > 0) {
        appendReasoningEvent(sessionId, 'operator_rule_proposal_enqueued', 'Operator 规则提案已入队', `已根据 operator 规则自动生成 ${operatorProposalResult.written.length} 个待审核 JSON intent 候选。`, {
          data: operatorProposalResult
        })
      }
    }
    return finalizeReasoningSession(sessionId, { persistFinalAnswer: true })
  }

  const reviewSummary = [
    assessmentSelfReviewConflict
      ? `自动质检评分 ${assessment.score}/100 未通过，但自我审查明确认为当前答案可以直接通过。当前更像评分机制与答案证据链冲突，而不是答案已经被证伪。`
      : assessment.passed && !selfReviewAllowsPass
      ? `一轮制质检已完成，评分 ${assessment.score}/100 虽已过线，但自我审查仍判定当前答案不可直接通过。`
      : `一轮制质检已完成，最终评分 ${assessment.score}/100，低于 ${HERMES_REASONING_MIN_ACCEPT_SCORE} 分。`,
    'Hermes 的原始最终回答已保留在下方。系统不会自动开启第二轮。请人工判断：如果答案正确，可通过并写入评分校准样本；如果答案不正确，可驳回并补充修正条件。校准样本只供后续质量门参考，不会自动修改评分器代码、intent、workflow 或智能体规则。',
    assessment.issues.length ? `自动质检认为的问题：${assessment.issues.join('；')}` : '',
    selfReview.summary ? `本轮自审结论：${selfReview.summary}` : ''
  ].filter(Boolean).join('\n\n')

  appendReasoningEvent(sessionId, 'quality_review_required', '自动质检未通过，等待人工确认', reviewSummary, {
    data: {
      attempt,
      score: assessment.score,
      issues: assessment.issues,
      strengths: assessment.strengths,
      selfReview,
      finalAnswerPreview: truncateReasoningPreview(answer, 1200)
    }
  })

  requestReasoningReview(sessionId, buildReasoningReview('answer', {
    reviewPhase: 'quality_override',
    title: '人工确认最终答案',
    summary: reviewSummary,
    allowAutoApprove: false,
    requiredHumanDecision: true,
    evidence: {
      targetType: 'answer',
      rawResponsePreview: answer,
      finalAnswerPreview: truncateReasoningPreview(answer, 2400),
      structuredResult: {
        phase: 'quality_override',
        attempt,
        minAcceptScore: HERMES_REASONING_MIN_ACCEPT_SCORE,
        assessment,
        selfReview,
        action: 'approve 将确认答案可接受并记录评分校准样本；如未填写反馈，只记录通过决策，不会自动修改评分器代码、intent、workflow 或智能体规则。reject 将按修正条件结束本轮并由用户决定是否重新发起。'
      }
    }
  }), {
    targetType: 'answer',
    reviewPhase: 'quality_override',
    attempt,
    score: assessment.score
  })

  return readReasoningSession(sessionId)
}
