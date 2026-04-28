import {
  HERMES_API_SERVER_BASE_URL,
  HERMES_REASONING_MAX_QUALITY_RETRIES,
  HERMES_REASONING_MIN_ACCEPT_SCORE,
} from '../../config/constants.js'
import { findIntentForEvaluation } from '../intents/index.js'
import { summarizeReasoningArtifactsForAssessment } from './heuristics.js'
import { extractJsonObjectString } from './promptBuilders.js'
import {
  appendReasoningEvent,
  buildReasoningReview,
  finalizeReasoningSession,
  prepareReasoningSessionPlan,
  readReasoningSession,
  readRecentReasoningQualityCalibrations,
  requestReasoningReview,
  truncateReasoningPreview,
  updateReasoningSession,
} from '../controlServerCore.js'

export async function evaluateReasoningFinalAnswerQuality(sessionId, userPrompt, answer, artifacts, binding) {
  const matchedIntent = findIntentForEvaluation(userPrompt, artifacts || {})
  if (matchedIntent && typeof matchedIntent.evaluateAnswer === 'function') {
    try {
      const verdict = matchedIntent.evaluateAnswer(userPrompt, answer, artifacts)
      if (verdict && typeof verdict === 'object') {
        return { ...verdict, intentId: matchedIntent.id }
      }
    } catch (error) {
      console.warn('[control-server] [intents] evaluator threw:', error?.message || error)
    }
  }

  const artifactSummary = summarizeReasoningArtifactsForAssessment(artifacts)
  const qualityCalibrations = readRecentReasoningQualityCalibrations(8)
  const messages = [
    {
      role: 'system',
      content: [
        'You are the GameStudio observable reasoning answer evaluator.',
        'Return one strict JSON object only.',
        'Score the final answer from 0 to 100 against the user question and the observable artifacts.',
        'Prefer repository-local observable evidence over eloquence.',
        'If the answer invents files, tools, APIs, or folders not supported by artifacts, score it harshly.',
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
    const response = await fetch(`${HERMES_API_SERVER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'hermes-agent',
        messages,
        max_tokens: 220,
        temperature: 0
      })
    })

    if (!response.ok) {
      throw new Error(`reasoning_answer_assessment_http_${response.status}_${response.statusText}`)
    }

    const data = await response.json()
    const raw = data.choices?.[0]?.message?.content || '{}'
    const parsed = JSON.parse(extractJsonObjectString(raw))
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

export async function finalizeReasoningSessionWithQualityGate(sessionId, binding, history) {
  const session = readReasoningSession(sessionId)
  if (!session) {
    throw new Error('reasoning_session_not_found')
  }

  const answer = String(session.artifacts?.finalAnswer || '').trim()
  if (!answer) {
    return finalizeReasoningSession(sessionId, { persistFinalAnswer: true })
  }

  const attempt = Math.max(0, Number(session.artifacts?.qualityGateAttempt || 0)) + 1
  const assessment = await evaluateReasoningFinalAnswerQuality(sessionId, session.userPrompt, answer, session.artifacts || {}, binding)

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

  appendReasoningEvent(sessionId, 'final_answer_ready', '最终答案质检', `${assessment.summary}（第 ${attempt} / ${HERMES_REASONING_MAX_QUALITY_RETRIES} 轮）`, {
    data: {
      attempt,
      score: assessment.score,
      source: assessment.source,
      issues: assessment.issues,
      strengths: assessment.strengths
    }
  })

  if (assessment.passed) {
    return finalizeReasoningSession(sessionId, { persistFinalAnswer: true })
  }

  if (attempt < HERMES_REASONING_MAX_QUALITY_RETRIES) {
    appendReasoningEvent(sessionId, 'planning_started', '答案未通过质检，重新规划', `评分 ${assessment.score}/100，低于 ${HERMES_REASONING_MIN_ACCEPT_SCORE} 分。将带着修正条件重新规划。`, {
      data: {
        attempt,
        correctionPrompt: assessment.correctionPrompt
      }
    })

    updateReasoningSession(sessionId, (current) => ({
      ...current,
      status: 'planning',
      plan: null,
      currentStepId: null,
      review: null,
      error: null,
      artifacts: {
        ...current.artifacts,
        finalAnswer: '',
        finalAnswerUsage: null,
        finalAnswerPersisted: false,
        latestPlanReviewEvidence: null,
        latestStepReviewEvidence: null,
        nextStepIndex: 0
      }
    }))

    await prepareReasoningSessionPlan(sessionId, binding, history, {
      correctionPrompt: [
        `最终答案质量评分只有 ${assessment.score}/100。`,
        assessment.correctionPrompt
      ].filter(Boolean).join('\n')
    })
    return readReasoningSession(sessionId)
  }

  const reviewSummary = [
    `自动质检已执行 ${attempt} 轮，最终评分 ${assessment.score}/100，低于 ${HERMES_REASONING_MIN_ACCEPT_SCORE} 分。`,
    'Hermes 的原始最终回答已保留在下方。请人工判断：如果答案正确，可通过并强化评分系统；如果答案不正确，可驳回并补充修正条件。',
    assessment.issues.length ? `自动质检认为的问题：${assessment.issues.join('；')}` : ''
  ].filter(Boolean).join('\n\n')

  appendReasoningEvent(sessionId, 'quality_review_required', '自动质检未通过，等待人工确认', reviewSummary, {
    data: {
      attempt,
      score: assessment.score,
      issues: assessment.issues,
      strengths: assessment.strengths,
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
        action: 'approve 将确认答案正确并记录评分校准样本；reject 将按修正条件重新执行。'
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
