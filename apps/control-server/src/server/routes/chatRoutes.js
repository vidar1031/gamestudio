export function registerChatRoutes(app, context) {
  const {
    buildActiveHermesChatRequestPayload,
    buildHermesChatWaterLevel,
    compactHermesChatHistory,
    listHermesChatSessions,
    archiveCurrentHermesChatSession,
    openHermesChatSession,
    deleteHermesChatSession,
    getHermesChatFilePath,
    getHermesChatFileRecord,
    hermesAgentDefinition,
    openFileInEditor,
    parseHermesChatHistoryContent,
    readStoredHermesChatHistory,
    writeHermesChatHistory,
  } = context

  app.get('/api/control/agents/:agentId/chat-history', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }
    try {
      const history = readStoredHermesChatHistory()
      return c.json({
        ok: true,
        history,
        file: getHermesChatFileRecord(),
        activeRequest: buildActiveHermesChatRequestPayload(),
        waterLevel: typeof buildHermesChatWaterLevel === 'function' ? buildHermesChatWaterLevel(history) : null
      })
    } catch (error) {
      return c.json({ ok: false, error: error.message })
    }
  })

  // 对话水位管理（ChatGPT 式）：用户确认后压缩早期对话为有界摘要，或归档后清空重开。
  // 压缩/清空都是确定性本地操作，不调用模型；结果携带新水位供 UI 即时刷新。
  app.post('/api/control/agents/:agentId/chat-history/compact', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }
    const body = await c.req.json().catch(() => ({}))
    const action = String(body?.action || '').trim()
    if (action !== 'compress' && action !== 'clear') {
      return c.json({ ok: false, error: 'invalid_action', detail: 'action 必须是 compress 或 clear。' }, 400)
    }
    try {
      const result = compactHermesChatHistory({
        action,
        keepRecentPairs: Number(body?.keepRecentPairs) || 4
      })
      return c.json({ ok: true, ...result, file: getHermesChatFileRecord() })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // ============ 会话历史管理（文件存储 ai/chat/sessions/） ============
  // 列表
  app.get('/api/control/agents/:agentId/chat-sessions', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }
    try {
      return c.json({ ok: true, sessions: listHermesChatSessions() })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // 归档当前会话并开启新会话（新建会话按钮的服务端动作）
  app.post('/api/control/agents/:agentId/chat-sessions/archive-current', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }
    const body = await c.req.json().catch(() => ({}))
    try {
      const archived = archiveCurrentHermesChatSession(typeof body?.title === 'string' ? body.title : undefined)
      return c.json({
        ok: true,
        archived,
        history: [],
        file: getHermesChatFileRecord(),
        waterLevel: buildHermesChatWaterLevel([])
      })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // 打开历史会话继续（当前工作区非空时自动先归档）
  app.post('/api/control/agents/:agentId/chat-sessions/:sessionId/open', async (c) => {
    const { agentId, sessionId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }
    try {
      const opened = openHermesChatSession(sessionId)
      if (!opened) return c.json({ ok: false, error: 'session_not_found' }, 404)
      const history = readStoredHermesChatHistory()
      return c.json({
        ok: true,
        opened,
        history,
        file: getHermesChatFileRecord(),
        waterLevel: buildHermesChatWaterLevel(history)
      })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // 删除历史会话记录
  app.delete('/api/control/agents/:agentId/chat-sessions/:sessionId', async (c) => {
    const { agentId, sessionId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }
    try {
      const deleted = deleteHermesChatSession(sessionId)
      if (!deleted) return c.json({ ok: false, error: 'session_not_found' }, 404)
      return c.json({ ok: true, deleted: sessionId })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.get('/api/control/agents/:agentId/chat-memory-file', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    try {
      return c.json({ ok: true, file: getHermesChatFileRecord({ includeContent: true }) })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.get('/api/control/agents/:agentId/chat-history-file', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    try {
      return c.json({ ok: true, file: getHermesChatFileRecord({ includeContent: true }) })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.put('/api/control/agents/:agentId/chat-memory-file', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => null)
    const content = typeof body?.content === 'string' ? body.content : ''

    try {
      const normalizedHistory = parseHermesChatHistoryContent(content)
      writeHermesChatHistory(normalizedHistory)
      return c.json({
        ok: true,
        file: getHermesChatFileRecord({ includeContent: true }),
        history: normalizedHistory
      })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })

  app.put('/api/control/agents/:agentId/chat-history-file', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => null)
    const content = typeof body?.content === 'string' ? body.content : ''

    try {
      const normalizedHistory = parseHermesChatHistoryContent(content)
      writeHermesChatHistory(normalizedHistory)
      return c.json({
        ok: true,
        file: getHermesChatFileRecord({ includeContent: true }),
        history: normalizedHistory
      })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })

  app.post('/api/control/agents/:agentId/chat-history-file/open', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    try {
      const openedWith = openFileInEditor(getHermesChatFilePath())
      return c.json({ ok: true, openedWith, file: getHermesChatFileRecord() })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })
}
