export function registerRuntimeRoutes(app, context) {
  let runtimeActionInFlight = null

  const {
    CONTROL_RESTART_SCRIPT,
    GAMESTUDIO_ROOT,
    appendHermesLog,
    buildConfigValidation,
    buildHermesPreflight,
    buildHermesSelfCheck,
    buildModelStateSnapshot,
    buildRuntimeStateSnapshot,
    fetchLocalModelCatalog,
    fs,
    getHermesControlConfigFingerprint,
    getHermesRuntimeState,
    getPersistedHermesControlConfig,
    hermesAgentDefinition,
    inspectModelAccess,
    mergeHermesControlConfig,
    spawn,
    startHermesRuntime,
    stopHermesRuntime,
    updateHermesControlState,
    buildHermesBindingFromConfig,
  } = context

  app.post('/api/control/agents/:agentId/runtime-action', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => ({}))
    const action = body.action

    if (action !== 'start' && action !== 'stop' && action !== 'pause' && action !== 'resume' && action !== 'exit' && action !== 'all-restart') {
      return c.json({ ok: false, error: 'invalid_action' }, 400)
    }

    if (runtimeActionInFlight) {
      return c.json({
        ok: false,
        error: 'runtime_action_busy',
        activeAction: runtimeActionInFlight.action,
        startedAt: runtimeActionInFlight.startedAt
      }, 409)
    }

    runtimeActionInFlight = {
      action,
      startedAt: new Date().toISOString()
    }

    try {
      let runtimeStatus
      const current = getHermesRuntimeState()
    if (action === 'all-restart') {
      const existing = getPersistedHermesControlConfig()
      const requestedConfig = mergeHermesControlConfig(existing, body.config || {})
      const persistedFingerprint = getHermesControlConfigFingerprint(existing)
      const requestedFingerprint = getHermesControlConfigFingerprint(requestedConfig)
      if (requestedFingerprint !== persistedFingerprint) {
        const persistedBinding = buildHermesBindingFromConfig(existing)
        const readiness = buildConfigValidation(existing, persistedBinding)
        appendHermesLog('[RESTART][ERROR] Left-brain config has unsaved changes, full restart aborted')
        return c.json({ ok: false, error: 'config_not_saved', readiness }, 409)
      }

      const nextBinding = buildHermesBindingFromConfig(existing)
      const readiness = buildConfigValidation(existing, nextBinding)
      if (!readiness.ready) {
        appendHermesLog([
          '[RESTART][ERROR] Full restart config is incomplete',
          ...readiness.items
            .filter((item) => item.status !== 'ok')
            .map((item) => `[RESTART][ERROR] ${item.label}: ${item.detail}`)
        ])
        return c.json({ ok: false, error: 'config_not_ready', readiness }, 409)
      }

      if (!fs.existsSync(CONTROL_RESTART_SCRIPT)) {
        appendHermesLog(`[RESTART][ERROR] Missing restart script: ${CONTROL_RESTART_SCRIPT}`)
        return c.json({ ok: false, error: 'restart_script_missing' }, 500)
      }

      appendHermesLog('[RESTART] Scheduling full control restart via restart_control.sh')
      const child = spawn('bash', ['-lc', `sleep 1 && exec '${CONTROL_RESTART_SCRIPT}'`], {
        cwd: GAMESTUDIO_ROOT,
        detached: true,
        stdio: 'ignore'
      })
      child.unref()

      return c.json({
        ok: true,
        restartingControl: true,
        detail: 'Control 与 Hermes 正在整体重启。',
        runtimeStatus: current,
        state: context.getHermesControlState()
      })
    }

    if (action === 'start' || action === 'resume' || action === 'all-restart') {
      const existing = getPersistedHermesControlConfig()
      const requestedConfig = mergeHermesControlConfig(existing, body.config || {})
      const persistedFingerprint = getHermesControlConfigFingerprint(existing)
      const requestedFingerprint = getHermesControlConfigFingerprint(requestedConfig)
      if (requestedFingerprint !== persistedFingerprint) {
        const persistedBinding = buildHermesBindingFromConfig(existing)
        const readiness = buildConfigValidation(existing, persistedBinding)
        appendHermesLog('[START][ERROR] Left-brain config has unsaved changes, startup aborted')
        return c.json({ ok: false, error: 'config_not_saved', readiness }, 409)
      }

      const nextBinding = buildHermesBindingFromConfig(existing)
      const readiness = buildConfigValidation(existing, nextBinding)
      if (!readiness.ready) {
        appendHermesLog([
          '[START][ERROR] Startup config is incomplete',
          ...readiness.items
            .filter((item) => item.status !== 'ok')
            .map((item) => `[START][ERROR] ${item.label}: ${item.detail}`)
        ])
        return c.json({ ok: false, error: 'config_not_ready', readiness }, 409)
      }

      if (action === 'all-restart' && current.state === 'running') {
        appendHermesLog('[RESTART] Performing full Hermes restart')
        await stopHermesRuntime()
      }

      appendHermesLog('[START] Preparing left-brain model preflight')
      const preflight = await buildHermesPreflight(existing, { appendLogs: true })
      updateHermesControlState({
        preflight: {
          ready: preflight.ready,
          checkedAt: preflight.checkedAt,
          configFingerprint: getHermesControlConfigFingerprint(existing),
          detail: preflight.ready ? '左脑自检通过' : '左脑自检未通过',
          checks: preflight.checks,
          inspection: preflight.inspection || null
        },
        model: buildModelStateSnapshot({
          provider: existing.provider,
          baseUrl: existing.baseUrl,
          model: preflight.selectedModel,
          inspection: preflight.inspection,
          lastAction: 'load'
        })
      })
      if (!preflight.ready) {
        appendHermesLog('[START][ERROR] Preflight failed, Hermes launch aborted')
        return c.json({ ok: false, error: 'preflight_failed', readiness: preflight.readiness, preflight }, 409)
      }

      appendHermesLog(`[START][OK] Model ready: ${preflight.selectedModel}`)
      appendHermesLog(action === 'all-restart' ? '[RESTART] Launching Hermes runtime after full restart' : '[START] Launching Hermes runtime')
      runtimeStatus = await startHermesRuntime()
      updateHermesControlState({
        runtime: buildRuntimeStateSnapshot(runtimeStatus, action)
      })
      const side = body.config?.side || 'unknown'
      appendHermesLog(action === 'all-restart'
        ? `[RESTART][OK] Restarted ${side} brain binding to ${preflight.selectedModel}`
        : `[START][OK] Started ${side} brain binding to ${preflight.selectedModel}`)
    } else {
      const side = body.brainSide || 'unknown'
      appendHermesLog(`[STOP] Stopped ${side} brain`)
      if (action === 'pause' || action === 'stop') {
        if (body.stopAll) {
          runtimeStatus = await stopHermesRuntime()
        } else {
          runtimeStatus = current
        }
      } else {
        runtimeStatus = await stopHermesRuntime()
      }
      updateHermesControlState({
        runtime: buildRuntimeStateSnapshot(runtimeStatus, action)
      })
    }

      return c.json({
        ok: true,
        agentId,
        action,
        runtimeStatus,
        state: context.getHermesControlState()
      })
    } finally {
      runtimeActionInFlight = null
    }
  })

  app.get('/api/control/local-models', async (c) => {
    const provider = c.req.query('provider') || 'omlx'
    const requestedBaseUrl = c.req.query('baseUrl') || undefined
    return c.json(await fetchLocalModelCatalog({ provider, baseUrl: requestedBaseUrl }))
  })

  app.get('/api/control/local-models/inspect', async (c) => {
    const provider = String(c.req.query('provider') || 'omlx')
    const model = String(c.req.query('model') || '').trim()
    const baseUrl = c.req.query('baseUrl') || undefined
    return c.json({ ok: true, inspection: await inspectModelAccess({ provider, baseUrl, model }) })
  })

  app.get('/api/control/agents/:agentId/self-check', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const runtimeStatus = getHermesRuntimeState()
    if (runtimeStatus.state !== 'running') {
      return c.json({ ok: false, error: 'runtime_not_running', runtimeStatus }, 409)
    }

    return c.json({ ok: true, agentId, selfCheck: await buildHermesSelfCheck() })
  })
}
