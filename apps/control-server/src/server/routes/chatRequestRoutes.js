export function registerChatRequestRoutes(app, context) {
  const {
    HERMES_API_SERVER_BASE_URL,
    HERMES_CHAT_REQUEST_TIMEOUT_MS,
    appendHermesLog,
    buildActiveHermesChatRequestPayload,
    buildChatContextSourcesPayload,
    buildHermesBinding,
    buildHermesChatMessages,
    buildHermesOutboundRequestSummary,
    getActiveHermesChatRecovery,
    getActiveHermesChatRequest,
    getHermesRuntimeState,
    hermesAgentDefinition,
    persistHermesChatError,
    persistHermesChatFailure,
    persistHermesChatPrompt,
    persistHermesChatReply,
    readHermesChatHistory,
    requestJsonWithoutHeadersTimeout,
    setActiveHermesChatRequest,
  } = context

  app.post('/api/control/agents/:agentId/ping-model', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => ({}))
    const userPrompt = body.prompt || 'Hello, are you there?'
    const runtimeStatus = getHermesRuntimeState()

    if (runtimeStatus.state !== 'running') {
      return c.json({ ok: false, error: 'runtime_not_running', runtimeStatus }, 409)
    }

    let requestId = null
    try {
      const binding = buildHermesBinding()
      const history = readHermesChatHistory({ includeAllSessions: true })
      const chatContext = buildHermesChatMessages(history, userPrompt, binding, {
        selectedSourceIds: body.selectedSourceIds,
        selectedContextPoolIds: body.selectedContextPoolIds,
        confirmedContextSummary: body.confirmedContextSummary
      })
      const contextSources = buildChatContextSourcesPayload(chatContext, binding)
      const activeRequest = getActiveHermesChatRequest()
      const activeRecovery = getActiveHermesChatRecovery()

      if (activeRequest) {
        const activeForMs = Date.now() - activeRequest.startedAt
        appendHermesLog([
          `[CHAT][BUSY] activeForMs=${activeForMs} promptChars=${activeRequest.promptChars}`,
          `[CHAT][BUSY] rejectedPromptChars=${userPrompt.length}`
        ])
        return c.json({
          ok: false,
          error: 'chat_busy',
          details: `Hermes chat request already running for ${Math.round(activeForMs / 1000)}s`,
          contextSources,
          timeoutMs: HERMES_CHAT_REQUEST_TIMEOUT_MS,
          activeRequest: buildActiveHermesChatRequestPayload(activeRequest),
          recovery: activeRecovery
            ? {
                attempted: true,
                ok: false,
                reason: 'recovery_in_progress',
                detail: 'Hermes 正在执行上一轮超时后的自动恢复，请稍后重试。'
              }
            : null
        }, 409)
      }

      requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`
      const nextRequest = {
        requestId,
        startedAt: Date.now(),
        promptChars: userPrompt.length,
        contextSources,
        outboundRequest: buildHermesOutboundRequestSummary(chatContext, userPrompt),
      }
      setActiveHermesChatRequest(nextRequest)
      persistHermesChatPrompt(requestId, userPrompt)
      const messages = chatContext.messages
      appendHermesLog([
        `[CHAT][REQUEST] userPromptChars=${userPrompt.length} replayedMessages=${chatContext.replayedMessageCount}`,
        `[CHAT][RUNTIME] provider=${binding.provider} model=${binding.model} baseUrl=${binding.baseUrl}`,
        `[CHAT][MEMORY] loadedSources=${chatContext.projectMemory.loadedSources.length}/${chatContext.projectMemory.selectedSources.length} selected=${chatContext.projectMemory.selectedSources.length}/${chatContext.projectMemory.sources.length}`,
        ...chatContext.projectMemory.selectedSources.map((source) => {
          const status = source.exists ? 'loaded' : 'missing'
          const suffix = source.exists
            ? ` chars=${source.totalChars}${source.truncated ? ' truncated' : ''}`
            : ''
          return `[CHAT][MEMORY] ${status} ${source.label}: ${source.filePath}${suffix}`
        })
      ])
      const completionPromise = (async () => {
        try {
          const response = await requestJsonWithoutHeadersTimeout(`${HERMES_API_SERVER_BASE_URL}/chat/completions`, {
            model: 'hermes-agent',
            messages,
            max_tokens: 150
          })

          if (!response.ok) {
            const errorBody = String(response.text || '')
            appendHermesLog(`[CHAT][ERROR] httpStatus=${response.status} statusText=${response.statusText} bodyChars=${errorBody.length}`)
            persistHermesChatError(
              requestId,
              `Hermes chat service returned HTTP ${response.status}: ${response.statusText}`,
              errorBody.slice(0, 1000)
            )
            return {
              kind: 'error',
              status: response.status,
              error: `Hermes chat service returned HTTP ${response.status}: ${response.statusText}`,
              details: errorBody.slice(0, 1000)
            }
          }

          const data = response.json()
          const reply = data.choices?.[0]?.message?.content || JSON.stringify(data)
          persistHermesChatReply(requestId, reply, data.usage)
          appendHermesLog(`[CHAT][RESPONSE] durationMs=${Date.now() - getActiveHermesChatRequest().startedAt} replyChars=${reply.length}`)
          return {
            kind: 'success',
            reply,
            raw: data,
          }
        } catch (error) {
          const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : null
          const errorMessage = error?.message || 'unknown_error'
          const currentRequest = getActiveHermesChatRequest()
          const durationMs = currentRequest ? Date.now() - currentRequest.startedAt : null
          appendHermesLog(`[CHAT][ERROR] durationMs=${durationMs ?? -1} message=${errorMessage}`)
          persistHermesChatError(
            requestId,
            errorMessage,
            cause ? String(cause) : ''
          )
          return {
            kind: 'error',
            error: errorMessage,
            details: cause ? String(cause) : undefined,
          }
        } finally {
          if (getActiveHermesChatRequest()?.requestId === requestId) {
            setActiveHermesChatRequest(null)
          }
        }
      })()

      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), HERMES_CHAT_REQUEST_TIMEOUT_MS)
      })

      const result = await Promise.race([completionPromise, timeoutPromise])
      if (result?.kind === 'timeout') {
        appendHermesLog(`[CHAT][TIMEOUT] requestId=${requestId} waitedMs=${HERMES_CHAT_REQUEST_TIMEOUT_MS} continueInBackground=true`)
        return c.json({
          ok: false,
          error: 'chat_timeout',
          details: '等待超时，Hermes 仍在后台继续处理；结果返回后会补写到聊天记录文件。',
          hermesApiBaseUrl: HERMES_API_SERVER_BASE_URL,
          contextSources,
          timeoutMs: HERMES_CHAT_REQUEST_TIMEOUT_MS,
          activeRequest: buildActiveHermesChatRequestPayload(getActiveHermesChatRequest()),
          pending: true,
          runtimeStatus: getHermesRuntimeState(),
        }, 202)
      }

      if (result?.kind === 'success') {
        return c.json({
          ok: true,
          agentId,
          reply: result.reply,
          raw: result.raw,
          contextSources,
          timeoutMs: HERMES_CHAT_REQUEST_TIMEOUT_MS,
        })
      }

      return c.json({
        ok: false,
        error: result?.error || 'unknown_error',
        details: result?.details,
        hermesApiBaseUrl: HERMES_API_SERVER_BASE_URL,
        contextSources,
        timeoutMs: HERMES_CHAT_REQUEST_TIMEOUT_MS,
        activeRequest: buildActiveHermesChatRequestPayload(getActiveHermesChatRequest()),
        runtimeStatus: getHermesRuntimeState(),
      }, result?.status && Number.isFinite(result.status) ? result.status : 500)

    } catch (error) {
      const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : null
      const errorMessage = error?.message || 'unknown_error'
      const currentRequest = getActiveHermesChatRequest()
      const durationMs = currentRequest ? Date.now() - currentRequest.startedAt : null
      appendHermesLog(`[CHAT][ERROR] durationMs=${durationMs ?? -1} message=${errorMessage}`)
      if (requestId) {
        persistHermesChatError(requestId, errorMessage, cause ? String(cause) : '')
      } else {
        persistHermesChatFailure(userPrompt, errorMessage, cause ? String(cause) : '')
      }
      return c.json({
        ok: false,
        error: errorMessage,
        details: cause ? String(cause) : undefined,
        hermesApiBaseUrl: HERMES_API_SERVER_BASE_URL,
        timeoutMs: HERMES_CHAT_REQUEST_TIMEOUT_MS,
        activeRequest: buildActiveHermesChatRequestPayload(getActiveHermesChatRequest()),
        runtimeStatus: getHermesRuntimeState(),
      })
    }
  })
}
