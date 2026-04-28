export function registerContextRoutes(app, context) {
  const {
    createOpaqueId,
    buildChatContextSourcesPayload,
    buildHermesBinding,
    buildHermesChatMessages,
    buildManualContextSourceCandidates,
    buildReasoningPlannerMessages,
    buildStructuredOutboundPreview,
    generateContextDraft,
    getContextPoolEntryFilePath,
    getSelectableContextSourceById,
    hermesAgentDefinition,
    listContextPoolEntries,
    openFileInEditor,
    readContextPoolEntry,
    readHermesChatHistory,
    readUtf8FileRecord,
    writeContextPoolEntry,
    writeUtf8FileRecord,
  } = context

  app.get('/api/control/agents/:agentId/context-candidates', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const binding = buildHermesBinding()
    const sources = buildManualContextSourceCandidates(binding).map((source) => ({
      sourceId: source.sourceId,
      kind: source.kind,
      label: source.label,
      filePath: source.filePath,
      exists: source.exists,
      totalChars: source.totalChars,
      loadedChars: source.loadedChars ?? 0,
      truncated: Boolean(source.truncated)
    }))

    return c.json({ ok: true, sources, contextPoolEntries: listContextPoolEntries() })
  })

  app.get('/api/control/agents/:agentId/context-source-content', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const sourceId = String(c.req.query('sourceId') || '').trim()
    const binding = buildHermesBinding()
    const source = getSelectableContextSourceById(binding, sourceId)
    if (!source) {
      return c.json({ ok: false, error: 'context_source_not_found' }, 404)
    }

    try {
      return c.json({ ok: true, source, file: readUtf8FileRecord(source.filePath) })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.put('/api/control/agents/:agentId/context-source-content', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => ({}))
    const sourceId = String(body.sourceId || '').trim()
    const binding = buildHermesBinding()
    const source = getSelectableContextSourceById(binding, sourceId)
    if (!source) {
      return c.json({ ok: false, error: 'context_source_not_found' }, 404)
    }

    try {
      return c.json({ ok: true, source, file: writeUtf8FileRecord(source.filePath, body.content) })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.post('/api/control/agents/:agentId/context-drafts', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => ({}))
    const prompt = String(body.prompt || '').trim()
    if (!prompt) {
      return c.json({ ok: false, error: 'prompt_required' }, 400)
    }

    const binding = buildHermesBinding()
    const history = readHermesChatHistory({ includeAllSessions: true })
    const draft = await generateContextDraft(prompt, binding, {
      selectedSourceIds: body.selectedSourceIds,
      selectedContextPoolIds: body.selectedContextPoolIds,
      confirmedContextSummary: body.confirmedContextSummary,
      history
    })

    return c.json({ ok: true, draft })
  })

  app.post('/api/control/agents/:agentId/submission-preview', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => ({}))
    const prompt = String(body.prompt || '').trim()
    if (!prompt) {
      return c.json({ ok: false, error: 'prompt_required' }, 400)
    }

    const mode = String(body.mode || 'chat') === 'reasoning' ? 'reasoning' : 'chat'
    const binding = buildHermesBinding()
    const history = readHermesChatHistory({ includeAllSessions: true })
    const contextSelection = {
      selectedSourceIds: body.selectedSourceIds,
      selectedContextPoolIds: body.selectedContextPoolIds,
      confirmedContextSummary: body.confirmedContextSummary
    }

    if (mode === 'reasoning') {
      const plannerContext = buildReasoningPlannerMessages(history, prompt, binding, '', contextSelection)
      return c.json({
        ok: true,
        preview: {
          mode,
          summary: `当前仅预览 Hermes 生成 reasoning plan 时将发送给 OMLX 的消息，不会真正调用模型。最后一条 user 消息是本次输入；前面 ${plannerContext.replayableMessages.length} 条为历史重放。`,
          outboundPreview: buildStructuredOutboundPreview({
            binding,
            messages: plannerContext.messages,
            purpose: 'reasoning-plan-preview',
            mode,
            userPrompt: prompt,
            replayedMessageCount: plannerContext.replayableMessages.length,
            contextSelection,
            history
          }),
          contextSources: buildChatContextSourcesPayload({
            replayedMessageCount: plannerContext.replayableMessages.length,
            projectMemory: plannerContext.projectMemory
          }, binding)
        }
      })
    }

    const chatContext = buildHermesChatMessages(history, prompt, binding, contextSelection)
    return c.json({
      ok: true,
      preview: {
        mode,
        summary: `当前仅预览 Hermes 将发送给 OMLX 的聊天消息，不会真正调用模型。最后一条 user 消息是本次输入；前面 ${chatContext.replayedMessageCount} 条为历史重放。`,
        outboundPreview: buildStructuredOutboundPreview({
          binding,
          messages: chatContext.messages,
          purpose: 'chat-preview',
          mode,
          userPrompt: prompt,
          replayedMessageCount: chatContext.replayedMessageCount,
          contextSelection,
          history
        }),
        contextSources: buildChatContextSourcesPayload(chatContext, binding)
      }
    })
  })

  app.get('/api/control/agents/:agentId/context-pool', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    return c.json({ ok: true, entries: listContextPoolEntries() })
  })

  app.post('/api/control/agents/:agentId/context-pool', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => ({}))
    const summary = String(body.summary || '').trim()
    if (!summary) {
      return c.json({ ok: false, error: 'summary_required' }, 400)
    }

    const now = new Date().toISOString()
    const entry = writeContextPoolEntry({
      entryId: createOpaqueId('ctx'),
      title: String(body.title || `Context ${now}`).trim(),
      prompt: String(body.prompt || '').trim(),
      summary,
      selectedSourceIds: Array.isArray(body.selectedSourceIds) ? body.selectedSourceIds.map((value) => String(value)) : [],
      selectedContextPoolIds: Array.isArray(body.selectedContextPoolIds) ? body.selectedContextPoolIds.map((value) => String(value)) : [],
      createdAt: now,
      updatedAt: now
    })

    return c.json({ ok: true, entry })
  })

  app.get('/api/control/agents/:agentId/context-pool/:entryId', async (c) => {
    const { agentId, entryId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const entry = readContextPoolEntry(entryId)
    if (!entry) {
      return c.json({ ok: false, error: 'context_pool_entry_not_found' }, 404)
    }

    return c.json({ ok: true, entry, filePath: getContextPoolEntryFilePath(entryId) })
  })

  app.get('/api/control/agents/:agentId/context-pool/:entryId/file', async (c) => {
    const { agentId, entryId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const entry = readContextPoolEntry(entryId)
    if (!entry) {
      return c.json({ ok: false, error: 'context_pool_entry_not_found' }, 404)
    }

    try {
      return c.json({ ok: true, entry, file: readUtf8FileRecord(getContextPoolEntryFilePath(entryId)) })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.put('/api/control/agents/:agentId/context-pool/:entryId', async (c) => {
    const { agentId, entryId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const existing = readContextPoolEntry(entryId)
    if (!existing) {
      return c.json({ ok: false, error: 'context_pool_entry_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => ({}))
    const next = writeContextPoolEntry({
      ...existing,
      title: String(body.title ?? existing.title),
      summary: String(body.summary ?? existing.summary),
      updatedAt: new Date().toISOString()
    })
    return c.json({ ok: true, entry: next })
  })

  app.put('/api/control/agents/:agentId/context-pool/:entryId/file', async (c) => {
    const { agentId, entryId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const existing = readContextPoolEntry(entryId)
    if (!existing) {
      return c.json({ ok: false, error: 'context_pool_entry_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => ({}))
    try {
      const file = writeUtf8FileRecord(getContextPoolEntryFilePath(entryId), body.content)
      return c.json({ ok: true, file, entry: readContextPoolEntry(entryId) })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.delete('/api/control/agents/:agentId/context-pool/:entryId', async (c) => {
    const { agentId, entryId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const filePath = getContextPoolEntryFilePath(entryId)
    if (!context.fs.existsSync(filePath)) {
      return c.json({ ok: false, error: 'context_pool_entry_not_found' }, 404)
    }

    try {
      context.fs.unlinkSync(filePath)
      return c.json({ ok: true, entryId })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.post('/api/control/agents/:agentId/context-pool/:entryId/open', async (c) => {
    const { agentId, entryId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const entry = readContextPoolEntry(entryId)
    if (!entry) {
      return c.json({ ok: false, error: 'context_pool_entry_not_found' }, 404)
    }

    const filePath = getContextPoolEntryFilePath(entryId)
    const openedWith = openFileInEditor(filePath)
    return c.json({ ok: true, openedWith, filePath })
  })
}
