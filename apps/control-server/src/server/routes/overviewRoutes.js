export function registerOverviewRoutes(app, context) {
  const {
    fs,
    HERMES_HOME,
    HERMES_RUNTIME_LOG_FILE,
    appendHermesLog,
    buildHermesActionContract,
    buildHermesAgentRecord,
    buildHermesNextAction,
    buildHermesStartupFlow,
    buildHermesStartupProfile,
    buildModelStateSnapshot,
    buildOpenClawAgentRecord,
    buildRuntimeStateSnapshot,
    getHermesControlState,
    getPersistedHermesControlConfig,
    getHermesRuntimeState,
    hermesAgentDefinition,
    inspectProviderModelState,
    listActiveReasoningExecutions,
    loadProviderModel,
    normalizeModelBaseUrl,
    normalizeProviderName,
    openclawAgentDefinition,
    unloadProviderModel,
    updateHermesControlState,
  } = context

  app.get('/api/control/agents/:agentId/logs', (c) => {
    try {
      if (!fs.existsSync(HERMES_RUNTIME_LOG_FILE)) return c.json({ ok: true, logs: '无运行日志' })
      const raw = fs.readFileSync(HERMES_RUNTIME_LOG_FILE, 'utf8')
      let lines = raw.split('\n')
      if (lines.length > 200) lines = lines.slice(-200)
      return c.json({ ok: true, logs: lines.join('\n') })
    } catch (error) {
      return c.json({ ok: true, logs: '无法读取日志: ' + error.message })
    }
  })

  app.post('/api/control/models/:action', async (c) => {
    const { action } = c.req.param()
    const body = await c.req.json().catch(() => ({}))

    const provider = normalizeProviderName(body.provider)
    const model = String(body.model || '').trim()
    const baseUrl = normalizeModelBaseUrl(body.baseUrl, provider)
    appendHermesLog(`[MODEL] Request ${action} model: ${model || 'unknown'} on ${provider} at ${baseUrl}`)

    if (action === 'load') {
      const loadResult = await loadProviderModel({ provider, baseUrl, model })
      if (!loadResult.ok) {
        appendHermesLog(`[MODEL][ERROR] ${loadResult.detail}`)
        return c.json({ ok: false, action, model, error: loadResult.detail }, 409)
      }
      const inspection = await inspectProviderModelState({ provider, baseUrl, model })
      if (!inspection.accessible || inspection.loaded !== true) {
        updateHermesControlState({
          model: buildModelStateSnapshot({ provider, baseUrl, model, inspection, lastAction: 'load' })
        })
        appendHermesLog(`[MODEL][ERROR] ${inspection.detail}`)
        return c.json({ ok: false, action, model, error: inspection.detail, inspection }, 409)
      }
      const state = updateHermesControlState({
        model: buildModelStateSnapshot({ provider, baseUrl, model, inspection, lastAction: 'load' })
      })
      appendHermesLog(`[MODEL][OK] ${loadResult.detail}`)
      return c.json({ ok: true, action, model, inspection, state })
    }

    if (action === 'unload') {
      const runtimeStatus = getHermesRuntimeState()
      const activeExecutions = listActiveReasoningExecutions()
      const persistedConfig = getPersistedHermesControlConfig()
      const unloadingCurrentRuntimeModel = runtimeStatus.state === 'running'
        && String(persistedConfig.provider || '') === provider
        && String(persistedConfig.baseUrl || '') === baseUrl
        && String(persistedConfig.model || '') === model

      if (activeExecutions.length > 0) {
        return c.json({
          ok: false,
          action,
          model,
          error: 'reasoning_in_progress',
          detail: '当前仍有模型请求在执行，禁止卸载模型。',
          activeExecutions
        }, 409)
      }

      if (unloadingCurrentRuntimeModel) {
        return c.json({
          ok: false,
          action,
          model,
          error: 'runtime_model_in_use',
          detail: '当前模型仍被 Hermes runtime 使用，请先停止或切换模型。',
          runtimeStatus
        }, 409)
      }

      const unloadResult = await unloadProviderModel({ provider, baseUrl, model })
      if (!unloadResult.ok) {
        appendHermesLog(`[MODEL][ERROR] ${unloadResult.detail}`)
        return c.json({ ok: false, action, model, error: unloadResult.detail }, 409)
      }

      const inspection = await inspectProviderModelState({ provider, baseUrl, model })

      const currentModelState = getHermesControlState().model
      const shouldUpdateControlModel = String(currentModelState?.provider || '') === provider
        && String(currentModelState?.baseUrl || '') === baseUrl
        && String(currentModelState?.model || '') === model
      const state = shouldUpdateControlModel
        ? updateHermesControlState({
            model: buildModelStateSnapshot({ provider, baseUrl, model, inspection, lastAction: 'unload' })
          })
        : getHermesControlState()
      appendHermesLog(`[MODEL][OK] ${unloadResult.detail}`)
      return c.json({ ok: true, action, model, state })
    }

    return c.json({ ok: false, error: 'Unknown action' }, 400)
  })

  app.get('/api/health', (c) => {
    return c.json({
      ok: true,
      service: 'gamestudio_control_server',
      version: '0.1.0',
      now: new Date().toISOString()
    })
  })

  app.get('/api/control/overview', (c) => {
    const hermesAgent = buildHermesAgentRecord()
    return c.json({
      ok: true,
      HERMES_HOME,
      controlSystem: {
        status: 'bootstrapped',
        mode: 'scaffold',
        focus: 'state-machine-foundation'
      },
      primaryAgent: {
        id: hermesAgent.definition.id,
        runtime: hermesAgent.definition.runtime,
        availability: hermesAgent.status.availability
      },
      modules: {
        stateModel: 'pending',
        stageModel: 'pending',
        agentRegistry: 'bootstrapped',
        eventLog: 'pending',
        recoveryActions: 'pending'
      }
    })
  })

  app.get('/api/control/bootstrap', (c) => {
    return c.json({
      ok: true,
      nextMilestones: [
        'Define project state machine schema',
        'Define stage machine schema',
        'Bind Hermes actions to manager commands',
        'Add task/event persistence',
        'Expose Hermes-friendly command endpoints'
      ]
    })
  })

  app.get('/api/control/agents', (c) => {
    const state = getHermesControlState()
    return c.json({
      ok: true,
      agents: [buildHermesAgentRecord(), buildOpenClawAgentRecord()],
      activeAgentId: state.manager.currentAgentId,
      selectionLocked: state.manager.selectionLocked,
      state
    })
  })

  app.get('/api/control/agents/:agentId', (c) => {
    const { agentId } = c.req.param()
    if (agentId === hermesAgentDefinition.id) {
      return c.json({ ok: true, agent: buildHermesAgentRecord() })
    }

    if (agentId === openclawAgentDefinition.id) {
      return c.json({ ok: true, agent: buildOpenClawAgentRecord() })
    }

    return c.json({ ok: false, error: 'agent_not_found' }, 404)
  })

  app.get('/api/control/agents/:agentId/contract', (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    return c.json({ ok: true, agentId, contract: buildHermesActionContract() })
  })

  app.get('/api/control/agents/:agentId/startup-profile', (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    return c.json({ ok: true, agentId, startupProfile: buildHermesStartupProfile() })
  })

  app.get('/api/control/agents/:agentId/startup-flow', (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    return c.json({ ok: true, agentId, startupFlow: buildHermesStartupFlow() })
  })

  app.get('/api/control/agents/:agentId/next-action', (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    return c.json({ ok: true, agentId, nextAction: buildHermesNextAction() })
  })

  app.get('/api/control/agents/:agentId/runtime-status', (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const runtimeStatus = getHermesRuntimeState()
    const state = updateHermesControlState({
      runtime: buildRuntimeStateSnapshot(runtimeStatus)
    })

    return c.json({ ok: true, agentId, runtimeStatus, state })
  })
}
