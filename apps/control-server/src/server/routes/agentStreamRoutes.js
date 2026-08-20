import { streamSSE } from 'hono/streaming'

import { classifyReasoningRequest } from '../reasoning/requestClassifier.js'
import { runAgentStreamChat } from '../reasoning/agentStreamBridge.js'
import { REASONING_SESSION_STATE, applySessionTransition } from '../reasoning/sessionStateMachine.js'

// 流式咨询执行模式标记：写入 session.submissionContext.executionMode，供 UI/治理区分确定性链路与 agent 流
export const AGENT_STREAM_EXECUTION_MODE = 'agent_stream'

/**
 * 咨询/问答类聊天的 agent 流式路径（「边想边做边展示」）。
 *
 * 分流契约：
 * - 命中 answer_only（含 R013 咨询问句形态）→ 本路径：创建 reasoning session（治理证据锚点），
 *   桥接 hermes 网关 SSE，边消费边透传给 console，关键事件同步落 session 事件流；
 * - 其它类型（生产工作流/计划类）→ 返回 { ok:false, code:'not_consultative' }，console 回退既有确定性链。
 *
 * 治理边界：桥内只读工具白名单硬拦截（agentStreamBridge），回答本身不产生写入副作用，
 * 因此不引入额外审核门禁；runtime/左脑门禁与既有 session 创建路径一致。
 */
export function registerAgentStreamRoutes(app, context) {
  const {
    appendReasoningEvent,
    buildReasoningStartBlocker,
    createReasoningSession,
    getHermesControlState,
    getHermesRuntimeState,
    hermesAgentDefinition,
    HERMES_API_SERVER_BASE_URL,
    markReasoningSessionFailed,
    persistHermesChatPrompt,
    persistHermesChatReply,
    readHermesApiServerKey,
    readReasoningSession,
    updateReasoningSession,
  } = context

  app.post('/api/control/agents/:agentId/agent-stream', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => ({}))
    const userPrompt = String(body.prompt || '').trim()
    if (!userPrompt) {
      return c.json({ ok: false, error: 'prompt_required' }, 400)
    }

    // 与既有 session 创建路径一致的硬门禁：runtime 未运行 / 左脑未就绪时明确阻断
    const runtimeStatus = getHermesRuntimeState()
    if (runtimeStatus.state !== 'running') {
      return c.json({ ok: false, error: 'runtime_not_running', runtimeStatus }, 409)
    }
    const startBlocker = buildReasoningStartBlocker()
    if (startBlocker) {
      return c.json({ ok: false, ...startBlocker, runtimeStatus, controlState: getHermesControlState() }, 409)
    }

    // 分流：仅咨询/问答类进入 agent 流；其余交由 console 回退到既有确定性执行链
    const classification = classifyReasoningRequest(userPrompt)
    if (classification.route !== 'answer_only') {
      return c.json({
        ok: false,
        code: 'not_consultative',
        classification: {
          type: classification.type,
          route: classification.route,
          ruleId: classification.ruleId || null,
          reason: classification.reason
        }
      })
    }

    const session = await createReasoningSession(agentId, userPrompt, {
      reviewMode: String(body.reviewMode || '').trim().toLowerCase() || 'manual',
      executionMode: AGENT_STREAM_EXECUTION_MODE,
      // 咨询流不做质检重试/记忆回写，与 answer_only 轻量语义一致
      disableQualityAutoRetry: true,
      disableMemorySync: true,
    })
    persistHermesChatPrompt(session.sessionId, userPrompt)
    const sessionId = session.sessionId

    return streamSSE(c, async (stream) => {
      let clientGone = false
      stream.onAbort(() => {
        clientGone = true
      })

      const send = (type, payload = {}) => stream.writeSSE({ event: type, data: JSON.stringify({ type, ...payload }) })

      await send('session', { sessionId, classification: { type: classification.type, ruleId: classification.ruleId || null } })

      // queued → running（状态机合法转移），随后全程事件落证据
      updateReasoningSession(sessionId, (current) => applySessionTransition(current, REASONING_SESSION_STATE.RUNNING, 'agent_stream_started'))
      appendReasoningEvent(sessionId, 'agent_stream_started', '进入 agent 流式咨询', `分类 ${classification.type}（${classification.ruleId || '规则表'}），咨询走 agent 边想边做路径，工具限定只读集。`, {
        data: { executionMode: AGENT_STREAM_EXECUTION_MODE, classification: { type: classification.type, route: classification.route, ruleId: classification.ruleId || null } }
      })

      // 心跳：agent 长考（无工具事件的模型生成段）期间更新 artifacts.lastHeartbeatAt，
      // 防止孤儿扫描（默认 60s 无心跳）把本 session 误判为 orphaned/blocked。
      // 只写字段时间戳，不产生事件噪音（与 qualityGate 的 task_heartbeat 语义对齐）。
      const heartbeatTimer = setInterval(() => {
        try {
          updateReasoningSession(sessionId, (current) => {
            if (current.status !== REASONING_SESSION_STATE.RUNNING) return current
            return { ...current, artifacts: { ...current.artifacts, lastHeartbeatAt: new Date().toISOString() } }
          })
        } catch {
          // best effort：session 已被并发收敛时忽略
        }
      }, 20000)

      try {
        const result = await runAgentStreamChat({
          prompt: userPrompt,
          agentId,
          hermesApiBaseUrl: HERMES_API_SERVER_BASE_URL,
          hermesApiKey: typeof readHermesApiServerKey === 'function' ? readHermesApiServerKey() : '',
          onStreamEvent: (evt) => send(evt.type, evt),
          appendEvidence: (type, title, summary, extra) => appendReasoningEvent(sessionId, type, title, summary, extra),
          isAborted: () => clientGone || readReasoningSession(sessionId)?.status === REASONING_SESSION_STATE.CANCELLED
        })

        if (result.aborted) {
          // 客户端断开或经停止按钮取消：若仍是 running 则收敛为 cancelled（停止按钮路径已由 cancel 端点转移，幂等跳过）
          const current = readReasoningSession(sessionId)
          if (current && current.status === REASONING_SESSION_STATE.RUNNING) {
            updateReasoningSession(sessionId, (latest) => applySessionTransition(latest, REASONING_SESSION_STATE.CANCELLED, 'agent_stream_aborted'))
            appendReasoningEvent(sessionId, 'session_cancelled', '咨询已中断', '连接断开或人工停止，agent 流式咨询已中止。')
          }
          await send('done')
          return
        }

        if (result.blockedTool) {
          updateReasoningSession(sessionId, (current) => ({
            ...applySessionTransition(current, REASONING_SESSION_STATE.BLOCKED, `tool_blocked:${result.blockedTool}`),
            artifacts: { ...current.artifacts, finalAnswer: result.finalAnswer }
          }))
          appendReasoningEvent(sessionId, 'session_blocked', '咨询被边界拦截', `越权工具 ${result.blockedTool} 已拦截，session 收敛为 blocked。`)
          persistHermesChatReply(sessionId, result.finalAnswer, result.usage || null, { provisional: true })
          await send('final', { answer: result.finalAnswer, blocked: true })
          await send('done')
          return
        }

        if (!result.ok) {
          throw new Error(result.error || 'agent_stream_failed')
        }

        updateReasoningSession(sessionId, (current) => ({
          ...applySessionTransition(current, REASONING_SESSION_STATE.COMPLETED, 'agent_stream_completed'),
          artifacts: {
            ...current.artifacts,
            finalAnswer: result.finalAnswer,
            finalAnswerUsage: result.usage || null,
            finalAnswerPersisted: true,
          }
        }))
        appendReasoningEvent(sessionId, 'final_answer_ready', '最终回答', 'agent 流式咨询已完成，最终回答已写回聊天。', {
          data: { targetType: 'answer', executionMode: AGENT_STREAM_EXECUTION_MODE }
        })
        appendReasoningEvent(sessionId, 'session_completed', '咨询完成', 'agent 流式咨询链路结束。')
        persistHermesChatReply(sessionId, result.finalAnswer, result.usage || null)
        await send('final', { answer: result.finalAnswer, usage: result.usage || null })
        await send('done')
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        markReasoningSessionFailed(sessionId, detail)
        await send('error', { message: detail })
        await send('done')
      } finally {
        clearInterval(heartbeatTimer)
      }
    })
  })
}
