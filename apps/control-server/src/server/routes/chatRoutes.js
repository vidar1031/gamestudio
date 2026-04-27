export function registerChatRoutes(app, context) {
  const {
    buildActiveHermesChatRequestPayload,
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
        activeRequest: buildActiveHermesChatRequestPayload()
      })
    } catch (error) {
      return c.json({ ok: false, error: error.message })
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
