export function registerRuntimeRoutes(app, context) {
  let runtimeActionInFlight = null

  function buildSavedConfigState(config, detail = '已保存左脑配置') {
    return {
      saved: true,
      savedAt: new Date().toISOString(),
      savedFingerprint: getHermesControlConfigFingerprint(config),
      lastSavedModel: config.model,
      detail
    }
  }

  function buildRecordedPreflightState(config, preflight) {
    return {
      ready: preflight.ready,
      checkedAt: preflight.checkedAt,
      configFingerprint: getHermesControlConfigFingerprint(config),
      detail: preflight.ready ? '左脑自检通过' : '左脑自检未通过',
      checks: preflight.checks,
      inspection: preflight.inspection || null
    }
  }

  function synchronizeSwitchConfig(config) {
    const workflow = config?.workflow && typeof config.workflow === 'object' ? config.workflow : {}
    const modelRouting = workflow?.modelRouting && typeof workflow.modelRouting === 'object' ? workflow.modelRouting : {}
    return {
      ...config,
      workflow: {
        ...workflow,
        modelRouting: {
          ...modelRouting,
          defaultRoute: {
            ...(modelRouting.defaultRoute && typeof modelRouting.defaultRoute === 'object' ? modelRouting.defaultRoute : {}),
            provider: config.provider,
            baseUrl: config.baseUrl,
            model: config.model,
            transport: 'hermes',
            strict: false
          }
        }
      }
    }
  }

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
    getHermesControlState,
    getHermesRuntimeState,
    getPersistedHermesControlConfig,
    hermesAgentDefinition,
    inspectModelAccess,
    inspectProviderModelState,
    listActiveReasoningExecutions,
    loadProviderModel,
    mergeHermesControlConfig,
    reconcileResources,
    setHermesControlConfig,
    spawn,
    startHermesRuntime,
    stopHermesRuntime,
    unloadProviderModel,
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

      // 整体重启的真实语义（修复长期"all-restart 只重启 control、不动 Hermes"的死代码问题：
      // 早期分支提前 return，下方 Hermes 停止/启动逻辑从未触达）：
      // 先在当前进程内停止 Hermes（避免新 control 面对孤儿进程），
      // 脚本拉起新 control 后按重启前状态把 Hermes 恢复运行。
      const hermesWasRunning = current.state === 'running' && Boolean(current.pid)
      if (hermesWasRunning) {
        appendHermesLog(`[RESTART] Stopping Hermes pid=${current.pid} before control restart`)
        await stopHermesRuntime()
      }

      appendHermesLog('[RESTART] Scheduling full control restart via restart_control.sh')
      const controlPort = String(process.env.CONTROL_SERVER_PORT || 2099)
      const resumeHermesCmd = hermesWasRunning
        ? ` && sleep 2 && curl -sS -m 120 -X POST 'http://127.0.0.1:${controlPort}/api/control/agents/hermes-manager/runtime-action' -H 'Content-Type: application/json' -d '{"action":"start"}' >/dev/null 2>&1 || true`
        : ''
      const child = spawn('bash', ['-lc', `sleep 1 && '${CONTROL_RESTART_SCRIPT}'${resumeHermesCmd}`], {
        cwd: GAMESTUDIO_ROOT,
        detached: true,
        stdio: 'ignore'
      })
      child.unref()

      return c.json({
        ok: true,
        restartingControl: true,
        hermesRestarting: hermesWasRunning,
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
      if (preflight.ready) {
        appendHermesLog(`[START] Loading provider model before runtime start: ${preflight.selectedModel}`)
        const loadStart = Date.now()
        let loadResult = await loadProviderModel({
          provider: existing.provider,
          baseUrl: existing.baseUrl,
          model: preflight.selectedModel
        })
        if (!loadResult.ok && typeof reconcileResources === 'function') {
          // 内存竞态自愈：OMLX 启动/杂散请求会自动拉起其默认模型占位，导致配置模型加载撞内存上限；
          // 先做资源守卫收敛（卸载外来模型）再重试一次，仍失败才显式 409
          appendHermesLog(`[START][WARN] 模型首次加载失败（${String(loadResult.detail || '').slice(0, 120)}），触发资源守卫收敛后重试`)
          try {
            await reconcileResources()
          } catch (reconcileError) {
            appendHermesLog(`[START][RESOURCE][WARN] 守卫收敛失败: ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}`)
          }
          loadResult = await loadProviderModel({
            provider: existing.provider,
            baseUrl: existing.baseUrl,
            model: preflight.selectedModel
          })
        }
        const loadDuration = Date.now() - loadStart
        if (!loadResult.ok) {
          appendHermesLog(`[START][ERROR] Provider load failed: ${loadResult.detail} time_ms=${loadDuration}`)
          return c.json({ ok: false, error: 'provider_load_failed', detail: loadResult.detail, preflight }, 409)
        }
        appendHermesLog(`[START][DETAIL] provider_load_time_ms=${loadDuration} model=${preflight.selectedModel}`)
      }
      const loadedInspection = preflight.ready
        ? await inspectProviderModelState({ provider: existing.provider, baseUrl: existing.baseUrl, model: preflight.selectedModel })
        : preflight.inspection
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
          inspection: loadedInspection,
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
      if (action === 'stop') {
        if (body.stopAll) {
          runtimeStatus = await stopHermesRuntime()
        } else {
          runtimeStatus = current
        }
      } else if (action === 'pause') {
        runtimeStatus = await stopHermesRuntime()
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

  app.post('/api/control/agents/:agentId/switch-model', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    if (runtimeActionInFlight) {
      return c.json({
        ok: false,
        error: 'runtime_action_busy',
        activeAction: runtimeActionInFlight.action,
        startedAt: runtimeActionInFlight.startedAt
      }, 409)
    }

    const activeExecutions = listActiveReasoningExecutions()
    if (activeExecutions.length > 0) {
      return c.json({
        ok: false,
        error: 'reasoning_in_progress',
        detail: '当前仍有模型请求在执行，禁止切换左脑模型。',
        activeExecutions
      }, 409)
    }

    const body = await c.req.json().catch(() => ({}))
    const persistedConfig = getPersistedHermesControlConfig()
    const currentConfig = synchronizeSwitchConfig(persistedConfig)
    const nextConfig = synchronizeSwitchConfig(mergeHermesControlConfig(persistedConfig, body.config || {}))
    const currentRuntime = getHermesRuntimeState()
    const shouldRestartRuntime = currentRuntime.state === 'running'
    const switchTarget = `${nextConfig.provider || 'unknown'} / ${nextConfig.model || 'unknown'}`
    const currentConfigNeedsSync = getHermesControlConfigFingerprint(persistedConfig) !== getHermesControlConfigFingerprint(currentConfig)

    if (!String(nextConfig.model || '').trim()) {
      return c.json({ ok: false, error: 'missing_target_model', detail: '请先选择要切换到的模型。' }, 400)
    }

    if (
      String(currentConfig.provider || '') === String(nextConfig.provider || '')
      && String(currentConfig.baseUrl || '') === String(nextConfig.baseUrl || '')
      && String(currentConfig.model || '') === String(nextConfig.model || '')
    ) {
      if (currentConfigNeedsSync) {
        const preflight = await buildHermesPreflight(currentConfig, { appendLogs: true })
        const loadedInspection = await inspectProviderModelState({
          provider: currentConfig.provider,
          baseUrl: currentConfig.baseUrl,
          model: currentConfig.model
        })
        setHermesControlConfig(currentConfig)
        const state = updateHermesControlState({
          config: buildSavedConfigState(currentConfig, '已修正左脑 routing 配置'),
          preflight: buildRecordedPreflightState(currentConfig, preflight),
          model: buildModelStateSnapshot({
            provider: currentConfig.provider,
            baseUrl: currentConfig.baseUrl,
            model: preflight.selectedModel,
            inspection: loadedInspection,
            lastAction: 'sync'
          })
        })
        return c.json({
          ok: true,
          switched: false,
          detail: `当前已在使用 ${switchTarget}，并已修正 routing 绑定。`,
          preflight,
          runtimeStatus: currentRuntime,
          state
        })
      }
      return c.json({
        ok: true,
        switched: false,
        detail: `当前已在使用 ${switchTarget}。`,
        runtimeStatus: currentRuntime,
        state: getHermesControlState()
      })
    }

    runtimeActionInFlight = {
      action: 'switch-model',
      startedAt: new Date().toISOString()
    }

    let runtimeStatus = currentRuntime
    try {
      appendHermesLog(`[MODEL][SWITCH] validating target=${switchTarget}`)
      const preflight = await buildHermesPreflight(nextConfig, { appendLogs: true })
      if (!preflight.ready) {
        appendHermesLog(`[MODEL][SWITCH][ERROR] preflight_failed target=${switchTarget}`)
        return c.json({
          ok: false,
          error: 'preflight_failed',
          detail: '目标模型自检未通过，已阻止切换。',
          readiness: preflight.readiness,
          preflight,
          runtimeStatus,
          state: getHermesControlState()
        }, 409)
      }

      if (shouldRestartRuntime) {
        appendHermesLog(`[MODEL][SWITCH] stopping runtime before switching target=${switchTarget}`)
        runtimeStatus = await stopHermesRuntime()
        updateHermesControlState({ runtime: buildRuntimeStateSnapshot(runtimeStatus, 'stop') })
      }

      let unloadResult = { ok: true, attempted: false, skipped: true, reason: 'same_model', detail: '无需卸载旧模型。' }
      const previousModelChanged = String(currentConfig.model || '') !== String(nextConfig.model || '')
        || String(currentConfig.provider || '') !== String(nextConfig.provider || '')
        || String(currentConfig.baseUrl || '') !== String(nextConfig.baseUrl || '')
      if (previousModelChanged && String(currentConfig.model || '').trim()) {
        unloadResult = await unloadProviderModel({
          provider: currentConfig.provider,
          baseUrl: currentConfig.baseUrl,
          model: currentConfig.model
        })
        if (!unloadResult.ok) {
          throw new Error(`provider_unload_failed:${unloadResult.detail}`)
        }
      }

      const loadResult = await loadProviderModel({
        provider: nextConfig.provider,
        baseUrl: nextConfig.baseUrl,
        model: nextConfig.model
      })
      if (!loadResult.ok) {
        throw new Error(`provider_load_failed:${loadResult.detail}`)
      }

      const loadedInspection = await inspectProviderModelState({
        provider: nextConfig.provider,
        baseUrl: nextConfig.baseUrl,
        model: nextConfig.model
      })

      setHermesControlConfig(nextConfig)
      const state = updateHermesControlState({
        config: buildSavedConfigState(nextConfig, '已保存并切换左脑配置'),
        preflight: buildRecordedPreflightState(nextConfig, preflight),
        model: buildModelStateSnapshot({
          provider: nextConfig.provider,
          baseUrl: nextConfig.baseUrl,
          model: preflight.selectedModel,
          inspection: loadedInspection,
          lastAction: 'switch'
        })
      })

      if (shouldRestartRuntime) {
        appendHermesLog(`[MODEL][SWITCH] starting runtime on target=${switchTarget}`)
        runtimeStatus = await startHermesRuntime()
        updateHermesControlState({ runtime: buildRuntimeStateSnapshot(runtimeStatus, 'start') })
      }

      appendHermesLog(`[MODEL][SWITCH][OK] target=${switchTarget} restarted=${shouldRestartRuntime}`)
      return c.json({
        ok: true,
        switched: true,
        restartedRuntime: shouldRestartRuntime,
        detail: shouldRestartRuntime
          ? `已切换到 ${switchTarget}，Hermes 已按新模型重启。`
          : `已切换到 ${switchTarget}，Hermes 当前未运行。`,
        unloadResult,
        preflight,
        runtimeStatus,
        state
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      appendHermesLog(`[MODEL][SWITCH][ERROR] target=${switchTarget} detail=${detail}`)

      let recovered = false
      let recoveryDetail = ''
      try {
        setHermesControlConfig(currentConfig)
        const rollbackPreflight = await buildHermesPreflight(currentConfig, { appendLogs: true })
        const rollbackLoad = await loadProviderModel({
          provider: currentConfig.provider,
          baseUrl: currentConfig.baseUrl,
          model: currentConfig.model
        })
        if (!rollbackLoad.ok) {
          throw new Error(`provider_recovery_load_failed:${rollbackLoad.detail}`)
        }
        const rollbackInspection = await inspectProviderModelState({
          provider: currentConfig.provider,
          baseUrl: currentConfig.baseUrl,
          model: currentConfig.model
        })
        updateHermesControlState({
          config: buildSavedConfigState(currentConfig, '已回滚到切换前左脑配置'),
          preflight: buildRecordedPreflightState(currentConfig, rollbackPreflight),
          model: buildModelStateSnapshot({
            provider: currentConfig.provider,
            baseUrl: currentConfig.baseUrl,
            model: rollbackPreflight.selectedModel,
            inspection: rollbackInspection,
            lastAction: 'rollback'
          })
        })
        if (shouldRestartRuntime) {
          runtimeStatus = await startHermesRuntime()
          updateHermesControlState({ runtime: buildRuntimeStateSnapshot(runtimeStatus, 'resume') })
        }
        recovered = true
        recoveryDetail = shouldRestartRuntime ? '已回滚旧配置并恢复 Hermes。' : '已回滚旧配置。'
        appendHermesLog(`[MODEL][SWITCH][RECOVERED] detail=${recoveryDetail}`)
      } catch (recoveryError) {
        recoveryDetail = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        appendHermesLog(`[MODEL][SWITCH][RECOVERY_ERROR] detail=${recoveryDetail}`)

        // 最终保底：尝试加载 fallback 模型，确保 OMLX 不会处于空模型状态
        try {
          const fallbackModel = currentConfig.model || 'gpt-oss-20b-MXFP4-Q8'
          appendHermesLog(`[MODEL][SWITCH][FALLBACK] attempting to load fallback model=${fallbackModel}`)
          const fallbackLoad = await loadProviderModel({
            provider: currentConfig.provider,
            baseUrl: currentConfig.baseUrl,
            model: fallbackModel
          })
          if (fallbackLoad.ok) {
            appendHermesLog(`[MODEL][SWITCH][FALLBACK][OK] loaded=${fallbackModel}`)
            updateHermesControlState({
              model: buildModelStateSnapshot({
                provider: currentConfig.provider,
                baseUrl: currentConfig.baseUrl,
                model: fallbackModel,
                inspection: await inspectProviderModelState({
                  provider: currentConfig.provider,
                  baseUrl: currentConfig.baseUrl,
                  model: fallbackModel
                }),
                lastAction: 'fallback'
              })
            })
          } else {
            appendHermesLog(`[MODEL][SWITCH][FALLBACK][ERROR] ${fallbackLoad.detail}`)
          }
        } catch (fallbackErr) {
          appendHermesLog(`[MODEL][SWITCH][FALLBACK][ERROR] ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`)
        }
      }

      return c.json({
        ok: false,
        error: 'model_switch_failed',
        detail,
        recovered,
        recoveryDetail,
        runtimeStatus,
        state: getHermesControlState()
      }, 500)
    } finally {
      runtimeActionInFlight = null
    }
  })

  app.get('/api/control/local-models', async (c) => {
    const provider = c.req.query('provider') || 'omlx'
    const requestedBaseUrl = c.req.query('baseUrl') || undefined
    const config = getPersistedHermesControlConfig()
    const rightBrainApiKey = (config.brains?.rightBrainEnabled && config.brains?.rightBrain && config.brains.rightBrain.provider === provider)
      ? String(config.brains.rightBrain.apiKey || '').trim() || null
      : null
    return c.json(await fetchLocalModelCatalog({ provider, baseUrl: requestedBaseUrl, apiKeyOverride: rightBrainApiKey }))
  })

  app.get('/api/control/local-models/inspect', async (c) => {
    const provider = String(c.req.query('provider') || 'omlx')
    const model = String(c.req.query('model') || '').trim()
    const baseUrl = c.req.query('baseUrl') || undefined
    const config = getPersistedHermesControlConfig()
    const rightBrainApiKey = (config.brains?.rightBrainEnabled && config.brains?.rightBrain && config.brains.rightBrain.provider === provider)
      ? String(config.brains.rightBrain.apiKey || '').trim() || null
      : null
    appendHermesLog(`[INSPECT] provider=${provider} model=${model || 'unknown'} rightBrainApiKeyOverride=${Boolean(rightBrainApiKey)}`)
    return c.json({ ok: true, inspection: await inspectProviderModelState({ provider, baseUrl, model, apiKeyOverride: rightBrainApiKey }) })
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
