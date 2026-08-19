import {
  RIGHT_BRAIN_SUPERVISION_ROUTE_ACTION,
  getRightBrainSupervisionCapabilities,
  listSupervisionRuns,
  reviewSupervisionSuggestion,
  runRightBrainSupervision
} from '../reasoning/rightBrainSupervision.js'
import { appendGovernanceAudit, readGovernanceAudit } from '../reasoning/governanceAudit.js'
import { executeGovernedSessionRetry } from './reasoningRoutes.js'

// HERMES-H03：右脑子 agent 受控监察 API。
// - GET：子 agent 身份/能力白名单/右脑模型可用性/监察运行记录（只读）；
// - POST run：人工触发一次监察（依赖全部走 controlServerCore 既有受控入口，
//   模型不可用/输出非法显式降级留证，绝不伪造结果）；
// - POST review：人工 approve/reject 受控建议，approve 后经既有受控 API
//   （retry 与守护台人工重试同一核心、cancel 复用 cancelReasoningSession）执行，
//   子 agent 自身没有 executor，无法自批准。
// 写类端点受 AUTO-D02 访问边界保护（/api/* 全局中间件，默认仅本机）。
export function registerSupervisionRoutes(app, context) {
  const {
    buildHermesBinding,
    cancelReasoningSession,
    getHermesRuntimeState,
    listQueueItems,
    listReasoningSessions,
    readQueueItem,
    readReasoningSession,
    requestHermesChatCompletion,
    resolveModelRouteForPhase
  } = context

  // 右脑模型路由解析：读既有配置（actionRoutes.right_brain_supervision，右脑 Kimi 路由）；
  // 缺配置或 key 失效时显式返回 unavailableReason，由监察记录与守护台如实呈现
  const resolveRightBrainRoute = () => {
    const binding = buildHermesBinding()
    if (!binding?.rightBrainEnabled || !binding?.rightBrain) {
      return {
        unavailableReason: 'right_brain_not_configured',
        provider: binding?.rightBrain?.provider || null,
        model: binding?.rightBrain?.model || null
      }
    }
    const resolved = resolveModelRouteForPhase(binding, RIGHT_BRAIN_SUPERVISION_ROUTE_ACTION, {
      action: RIGHT_BRAIN_SUPERVISION_ROUTE_ACTION
    })
    if (!resolved?.apiKey) {
      return {
        unavailableReason: 'right_brain_api_key_missing',
        provider: resolved?.provider || binding.rightBrain.provider || null,
        model: resolved?.model || binding.rightBrain.model || null
      }
    }
    return {
      provider: resolved.provider,
      baseUrl: resolved.baseUrl,
      model: resolved.model,
      apiKey: resolved.apiKey,
      headers: resolved.headers,
      transport: resolved.transport
    }
  }

  // 只读证据装配：任务健康（runtime/session 状态分布）、失败证据（失败 session + 错误摘要）、
  // 治理日志尾部（审计记录）。全部来自既有只读数据面，不发起任何写操作。
  const collectSupervisionEvidence = async ({ focusSessionId } = {}) => {
    const runtimeStatus = getHermesRuntimeState()
    const sessions = listReasoningSessions({ limit: 30, includeTerminal: true })
    const sessionsByStatus = {}
    for (const session of sessions) {
      const status = session.status || 'unknown'
      sessionsByStatus[status] = (sessionsByStatus[status] || 0) + 1
    }
    const queue = listQueueItems()
    const queueByStatus = {}
    for (const item of queue.items) {
      const status = item.status || 'unknown'
      queueByStatus[status] = (queueByStatus[status] || 0) + 1
    }
    const failedSessions = sessions
      .filter((session) => session.status === 'failed')
      .slice(0, 5)
      .map((session) => {
        const full = readReasoningSession(session.sessionId)
        return {
          sessionId: session.sessionId,
          title: session.title || null,
          updatedAt: session.updatedAt || null,
          verdict: session.verdict || null,
          error: String(full?.error || '').slice(0, 300) || null,
          currentStepId: full?.currentStepId || null
        }
      })
    const focusSession = focusSessionId ? readReasoningSession(focusSessionId) : null
    return {
      generatedAt: new Date().toISOString(),
      runtime: { state: runtimeStatus?.state || 'unknown' },
      sessions: { byStatus: sessionsByStatus, sampled: sessions.length },
      queue: { byStatus: queueByStatus, itemCount: queue.items.length, queueErrors: queue.errors.length },
      failedSessions,
      focusSession: focusSession
        ? {
            sessionId: focusSession.sessionId,
            status: focusSession.status,
            error: String(focusSession.error || '').slice(0, 300) || null,
            currentStepId: focusSession.currentStepId || null
          }
        : null,
      auditTail: readGovernanceAudit(20).records
    }
  }

  // 右脑模型调用：经既有 requestHermesChatCompletion（与 meta_analysis 同一通道），
  // 调用记录由 model 请求链路留证；401/超时等错误向上抛，由 runRightBrainSupervision 收敛为 model_error
  const requestRightBrainModel = async ({ route, messages, runId }) => {
    const data = await requestHermesChatCompletion({
      sessionId: runId,
      phase: RIGHT_BRAIN_SUPERVISION_ROUTE_ACTION,
      messages,
      maxTokens: 4000,
      temperature: 0.2,
      route: {
        transport: route.transport,
        baseUrl: route.baseUrl,
        model: route.model,
        headers: { ...(route.headers || {}), 'User-Agent': 'Kilo-Code/1.0' }
      },
      timeoutMs: 120000
    })
    const usage = data?.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens
        }
      : null
    return { content: data?.choices?.[0]?.message?.content || '', usage }
  }

  // 受控建议 executor：approve 后经既有受控 API 执行（子 agent 自身没有这套 executor）
  const suggestionExecutors = {
    retry_session: async (params) => {
      const sessionId = String(params?.sessionId || '').trim()
      if (!sessionId) return { ok: false, error: 'session_id_required' }
      const result = executeGovernedSessionRetry(context, sessionId)
      return {
        ok: result.httpStatus === 200 && result.body?.ok === true,
        error: result.body?.error || null,
        detail: result.body?.detail || result.body?.error || null
      }
    },
    cancel_session: async (params) => {
      const sessionId = String(params?.sessionId || '').trim()
      if (!sessionId) return { ok: false, error: 'session_id_required' }
      try {
        // 与守护台取消端点同一受控函数 + 同一审计语义
        const session = cancelReasoningSession(sessionId)
        appendGovernanceAudit({
          action: 'cancel',
          sessionId,
          taskId: readQueueItem(sessionId)?.taskId || null,
          result: 'ok',
          detail: `session_status:${session?.status || 'unknown'}`
        })
        return { ok: true, detail: `session_status:${session?.status || 'unknown'}` }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  }

  app.get('/api/control/supervision/right-brain', (c) => {
    const route = resolveRightBrainRoute()
    return c.json({
      ok: true,
      supervisor: {
        ...getRightBrainSupervisionCapabilities(),
        model: {
          available: Boolean(route && !route.unavailableReason && route.apiKey),
          provider: route?.provider || null,
          model: route?.model || null,
          unavailableReason: route?.unavailableReason || null
        }
      },
      runs: listSupervisionRuns(20)
    })
  })

  app.post('/api/control/supervision/right-brain/run', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const focusSessionId = String(body.focusSessionId || '').trim() || null
    const record = await runRightBrainSupervision({
      trigger: 'manual',
      focusSessionId,
      deps: {
        collectEvidence: collectSupervisionEvidence,
        resolveRoute: resolveRightBrainRoute,
        requestModel: requestRightBrainModel
      }
    })
    return c.json({ ok: true, run: record })
  })

  app.post('/api/control/supervision/right-brain/runs/:runId/suggestions/:suggestionId/review', async (c) => {
    const { runId, suggestionId } = c.req.param()
    const body = await c.req.json().catch(() => ({}))
    const decision = String(body.decision || '').trim()
    const result = await reviewSupervisionSuggestion(runId, suggestionId, decision, {
      executors: suggestionExecutors
    })
    if (!result.ok) {
      const notFound = result.error === 'supervision_run_not_found' || result.error === 'supervision_suggestion_not_found'
      return c.json({ ok: false, error: result.error, detail: result.detail || null, suggestion: result.suggestion || null }, notFound ? 404 : 409)
    }
    return c.json({ ok: true, suggestion: result.suggestion })
  })
}
