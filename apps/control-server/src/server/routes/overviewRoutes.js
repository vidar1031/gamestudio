export function registerOverviewRoutes(app, context) {
  const {
    fs,
    fetch,
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
    getHermesRuntimeState,
    getProviderAccess,
    hermesAgentDefinition,
    inspectModelAccess,
    normalizeModelBaseUrl,
    normalizeProviderName,
    openclawAgentDefinition,
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
      const inspection = await inspectModelAccess({ provider, baseUrl, model })
      if (!inspection.accessible) {
        updateHermesControlState({
          model: buildModelStateSnapshot({ provider, baseUrl, model, inspection, lastAction: 'load' })
        })
        appendHermesLog(`[MODEL][ERROR] ${inspection.detail}`)
        return c.json({ ok: false, action, model, error: inspection.detail, inspection }, 409)
      }
      const state = updateHermesControlState({
        model: buildModelStateSnapshot({ provider, baseUrl, model, inspection, lastAction: 'load' })
      })
      appendHermesLog(`[MODEL][OK] ${model} ready for inference`)
      return c.json({ ok: true, action, model, inspection, state })
    }

    if (action === 'unload') {
      if (provider === 'omlx') {
        try {
          const access = getProviderAccess(provider, baseUrl)
          const response = await fetch(`${access.baseUrl}/models/${model}/unload`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(access.headers || {})
            }
          })
          const data = await response.json().catch(() => null)
          if (!response.ok) {
            const error = data?.error?.message || data?.message || `HTTP ${response.status}`
            appendHermesLog(`[MODEL][ERROR] Failed to unload model: ${error}`)
            return c.json({ ok: false, action, model, error }, response.status)
          }
          appendHermesLog(`[MODEL][OK] ${model} successfully unloaded from OMLX`)
        } catch (error) {
          appendHermesLog(`[MODEL][ERROR] Could not reach OMLX for unload: ${error.message}`)
          return c.json({ ok: false, action, model, error: error.message }, 500)
        }
      } else {
        appendHermesLog(`[MODEL] ${model || 'unknown'} marked for unload (Provider ${provider} does not support explicit unload)`)
      }
      const state = updateHermesControlState({
        model: {
          status: 'unloaded',
          label: '未启动',
          detail: `${model || '当前模型'} 已卸载`,
          provider,
          baseUrl,
          model,
          inspectedAt: new Date().toISOString(),
          loadedAt: null,
          lastAction: 'unload',
          inspection: null
        }
      })
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
