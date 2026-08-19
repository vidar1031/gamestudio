import { spawnSync } from 'node:child_process'
import { gameStudioServerClient, GAMESTUDIO_SERVER_BASE_URL } from '../services/gameStudioServerClient.js'

export function registerOverviewRoutes(app, context) {
  const {
    fs,
    GAMESTUDIO_ROOT,
    HERMES_HOME,
    HERMES_RUNTIME_LOG_FILE,
    path,
    appendHermesLog,
    buildHermesActionContract,
    buildHermesAgentRecord,
    buildHermesNextAction,
    buildHermesStartupFlow,
    buildHermesStartupProfile,
    buildModelStateSnapshot,
    buildRuntimeStateSnapshot,
    fetchLocalModelCatalog,
    getHermesControlState,
    getPersistedHermesControlConfig,
    getHermesRuntimeState,
    getProviderAccess,
    hermesAgentDefinition,
    inspectProviderModelState,
    listActiveReasoningExecutions,
    loadProviderModel,
    normalizeModelBaseUrl,
    normalizeProviderName,
    startOmlxApp,
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

    const config = getPersistedHermesControlConfig()
    const rightBrainApiKey = (config.brains?.rightBrainEnabled && config.brains?.rightBrain && config.brains.rightBrain.provider === provider)
      ? String(config.brains.rightBrain.apiKey || '').trim() || null
      : null
    if (rightBrainApiKey) appendHermesLog(`[MODEL] Using rightBrain apiKey override for provider=${provider}`)

    if (action === 'load') {
      const loadResult = await loadProviderModel({ provider, baseUrl, model })
      if (!loadResult.ok) {
        appendHermesLog(`[MODEL][ERROR] ${loadResult.detail}`)
        return c.json({ ok: false, action, model, error: loadResult.detail }, 409)
      }
      const inspection = await inspectProviderModelState({ provider, baseUrl, model, apiKeyOverride: rightBrainApiKey })
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

      const inspection = await inspectProviderModelState({ provider, baseUrl, model, apiKeyOverride: rightBrainApiKey })

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

  app.get('/api/control/overview', async (c) => {
    const hermesAgent = buildHermesAgentRecord()
    const runtimeStatus = getHermesRuntimeState()
    const state = getHermesControlState()
    const config = getPersistedHermesControlConfig()

    // 真实探测 GameStudio Editor (Studio) 状态
    // 注意：editor 的 Vite dev server 默认绑定 localhost（本机解析为 ::1，IPv6-only），
    // 用 127.0.0.1 探测会被拒绝。必须以 canonical 地址 localhost 探测。
    let studioStatus = { reachable: false, detail: '未探测' }
    const studioProbeUrls = ['http://localhost:8868/', 'http://127.0.0.1:8868/']
    for (const probeUrl of studioProbeUrls) {
      try {
        const studioController = new AbortController()
        const studioTimeout = setTimeout(() => studioController.abort(), 2000)
        const studioRes = await fetch(probeUrl, {
          signal: studioController.signal,
          method: 'HEAD'
        })
        clearTimeout(studioTimeout)
        if (studioRes.ok || studioRes.status === 200 || studioRes.status === 404) {
          studioStatus = { reachable: true, detail: `Studio 编辑器可访问 (${probeUrl.replace(/\/$/, '')})` }
          break
        }
        studioStatus = { reachable: false, detail: `Studio 返回 HTTP ${studioRes.status}` }
      } catch (err) {
        studioStatus = { reachable: false, detail: err instanceof Error ? err.message : String(err) }
      }
    }

    // 真实探测 OMLX 服务状态
    let omlxStatus = { reachable: false, detail: '未探测' }
    try {
      const access = getProviderAccess(config.provider, config.baseUrl)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2000)
      const res = await fetch(`${access.baseUrl}/models`, {
        signal: controller.signal,
        headers: access.headers
      })
      clearTimeout(timeout)
      if (res.ok) {
        const data = await res.json().catch(() => ({}))
        const entries = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : [])
        omlxStatus = {
          reachable: true,
          baseUrl: access.baseUrl,
          modelCount: entries.length,
          detail: `OMLX OK，发现 ${entries.length} 个模型`
        }
      } else {
        omlxStatus = { reachable: false, baseUrl: access.baseUrl, detail: `OMLX 返回 HTTP ${res.status}` }
      }
    } catch (err) {
      omlxStatus = { reachable: false, detail: err instanceof Error ? err.message : String(err) }
    }

    // 真实模型加载状态
    const modelState = state.model || {}
    const modelLoaded = modelState.status === 'loaded'
    const rawModelName = modelState.model || config.model || 'unknown'
    const modelName = typeof rawModelName === 'string' ? rawModelName : (typeof rawModelName?.id === 'string' ? rawModelName.id : String(rawModelName))

    // 全局严重告警（前置条件不满足时阻止 story 生产）
    const alerts = []
    if (!omlxStatus.reachable) {
      alerts.push({ level: 'critical', source: 'omlx', message: `OMLX 模型服务不可达：${omlxStatus.detail}` })
    }
    if (runtimeStatus.state !== 'running') {
      alerts.push({ level: 'critical', source: 'hermes', message: `Hermes runtime 未运行：${runtimeStatus.detail || runtimeStatus.label}` })
    }
    if (!modelLoaded) {
      alerts.push({ level: 'critical', source: 'model', message: `模型未加载就绪：${modelName}` })
    }
    const configSaved = state.config?.saved === true
    if (!configSaved) {
      alerts.push({ level: 'warning', source: 'config', message: '左脑配置尚未保存，禁止进行模型切换/启动操作。' })
    }
    if (!studioStatus.reachable) {
      alerts.push({ level: 'warning', source: 'studio', message: `GameStudio Editor 未启动：${studioStatus.detail}` })
    }

    return c.json({
      ok: true,
      HERMES_HOME,
      alerts,
      readyForProduction: alerts.filter((a) => a.level === 'critical').length === 0,
      studio: studioStatus,
      controlSystem: {
        status: alerts.length === 0 ? 'ready' : 'degraded',
        mode: 'managed',
        focus: 'model-ready-gate'
      },
      primaryAgent: {
        id: hermesAgent.definition.id,
        runtime: hermesAgent.definition.runtime,
        availability: hermesAgent.status.availability
      },
      omlx: omlxStatus,
      studio: studioStatus,
      hermes: {
        state: runtimeStatus.state,
        label: runtimeStatus.label,
        detail: runtimeStatus.detail,
        pid: runtimeStatus.pid
      },
      model: {
        name: modelName,
        loaded: modelLoaded,
        detail: typeof modelState.detail === 'string' ? modelState.detail : '未加载',
        provider: modelState.provider || config.provider || null,
        baseUrl: modelState.baseUrl || config.baseUrl || null
      },
      modules: {
        stateModel: 'bootstrapped',
        stageModel: 'bootstrapped',
        agentRegistry: 'bootstrapped',
        eventLog: 'bootstrapped',
        recoveryActions: 'bootstrapped'
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
      agents: [buildHermesAgentRecord()],
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

  app.post('/api/control/omlx/start', async (c) => {
    const result = await startOmlxApp()
    return c.json(result, result.ok ? 200 : 500)
  })

  app.get('/api/control/versions', async (c) => {
    let hermesVersion = 'unknown'
    let hermesVersionSource = 'unknown'
    try {
      const hermesResult = spawnSync('hermes', ['--version'], { encoding: 'utf8', timeout: 3000 })
      if (hermesResult.status === 0) {
        const stdout = String(hermesResult.stdout).trim()
        const m = stdout.match(/Hermes Agent v?(\d+\.\d+\.\d+)/i)
        hermesVersion = m ? `v${m[1]}` : stdout
        hermesVersionSource = 'hermes-cli'
      }
    } catch {
      // ignore
    }

    if (hermesVersion === 'unknown') {
      // Fallback: control-server package version (not the real Hermes version)
      try {
        const pkgPath = path.join(GAMESTUDIO_ROOT, 'apps', 'control-server', 'package.json')
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
          hermesVersion = pkg.version || 'unknown'
          hermesVersionSource = 'control-server-package'
        }
      } catch {
        // ignore
      }
    }

    let omlxVersion = null
    let omlxAppVersion = null
    const omlxAppCandidates = [
      '/Volumes/ovokit2t/Applications/oMLX.app',
      '/Applications/oMLX.app',
    ]
    const omlxAppPath = omlxAppCandidates.find((p) => {
      try { return fs.existsSync(p) } catch { return false }
    })

    if (omlxAppPath) {
      try {
        const plistResult = spawnSync('defaults', ['read', `${omlxAppPath}/Contents/Info`, 'CFBundleShortVersionString'], { encoding: 'utf8', timeout: 3000 })
        if (plistResult.status === 0) {
          omlxAppVersion = plistResult.stdout.trim() || null
        }
      } catch {
        // ignore
      }
    }

    // Fallback: read version from omlx CLI
    if (!omlxAppVersion) {
      for (const omlxBin of ['/opt/homebrew/bin/omlx', '/usr/local/bin/omlx']) {
        try {
          if (!fs.existsSync(omlxBin)) continue
          const versionResult = spawnSync(omlxBin, ['--version'], { encoding: 'utf8', timeout: 3000 })
          if (versionResult.status === 0) {
            const m = String(versionResult.stdout).match(/(\d+\.\d+\.\d+)/)
            if (m) {
              omlxAppVersion = m[1]
              break
            }
          }
        } catch {
          // ignore
        }
      }
    }

    // 尝试探测 OMLX 服务 /health 端点
    let omlxServiceHealthy = false
    let omlxServiceInfo = null
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2000)
      const res = await fetch('http://127.0.0.1:18888/health', { signal: controller.signal })
      clearTimeout(timeout)
      if (res.ok) {
        omlxServiceHealthy = true
        omlxServiceInfo = await res.json().catch(() => null)
      }
    } catch {
      // ignore
    }

    return c.json({
      ok: true,
      hermesVersion,
      hermesVersionSource,
      omlxVersion: omlxAppVersion,
      omlxServiceHealthy,
      omlxServiceInfo,
    })
  })

  // ── 监督评估 API ──

  app.get('/api/control/supervision/latest', async (c) => {
    try {
      const sessionsDir = path.join(GAMESTUDIO_ROOT, 'state', 'reasoning-sessions')
      if (!fs.existsSync(sessionsDir)) {
        return c.json({ ok: true, hasData: false })
      }
      const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')).map((f) => path.join(sessionsDir, f))
      const sessions = []
      for (const file of files) {
        let s = null
        try { s = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* ignore */ }
        // supervision 标识在 submissionContext.type（createReasoningSession 不落顶层 type 字段）
        const sessionType = s?.submissionContext?.type || s?.type || ''
        if (s && s.sessionId && sessionType === 'supervision') sessions.push(s)
      }
      sessions.sort((a, b) => {
        try { return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() } catch { return 0 }
      })
      const latest = sessions[0]
      if (!latest) {
        return c.json({ ok: true, hasData: false })
      }
      const result = latest.artifacts?.supervision?.lastResult
      return c.json({
        ok: true,
        hasData: true,
        sessionId: latest.sessionId,
        status: latest.status,
        updatedAt: latest.updatedAt,
        scorecard: result?.artifacts?.supervision?.scorecard || null,
        correctionPlan: result?.artifacts?.supervision?.correctionPlan || null,
      })
    } catch (error) {
      return c.json({ ok: false, error: String(error) })
    }
  })

  app.post('/api/control/supervision/trigger', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const requested = String(body?.trigger || 'manual')
      const trigger = ['manual', 'post_startup', 'periodic'].includes(requested) ? requested : 'manual'
      // 真实触发：创建 supervision session 并返回 sessionId，评估在后台执行，前端轮询 /supervision/latest 跟踪
      const result = await context.triggerSupervision({ trigger })
      return c.json({ ok: true, message: '监督评估已触发', ...result, timer: context.getSupervisionTimerState() })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  app.get('/api/control/supervision/state', (c) => {
    try {
      return c.json({
        ok: true,
        enabled: context.isSupervisionEnabled(),
        ...context.getSupervisionTimerState(),
        // AUTO-C04：gateway 进程监督状态（重启次数/退避/阻断/最近事件），供守护台展示
        gatewaySupervision: context.getGatewaySupervisionState()
      })
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500)
    }
  })

  // ── 结构化日志查询 ──────────────────────────────────
  app.get('/api/control/logs/:prefix', async (c) => {
    try {
      const prefix = c.req.param('prefix')
      const lines = Math.min(parseInt(c.req.query('lines') || '100', 10), 1000)
      const { readStructuredLogs } = await import('../utils/logger.js')
      const logs = readStructuredLogs(prefix, lines)
      return c.json({ ok: true, prefix, count: logs.length, logs })
    } catch (error) {
      return c.json({ ok: false, error: String(error) })
    }
  })

  // ── 内存生命周期维护 ────────────────────────────────
  app.post('/api/control/agents/:agentId/memory-lifecycle/maintenance', async (c) => {
    try {
      const { agentId } = c.req.param()
      if (agentId !== hermesAgentDefinition.id) {
        return c.json({ ok: false, error: 'agent_not_found' }, 404)
      }
      const report = runMemoryLifecycleMaintenance({
        fs,
        rootDir: GAMESTUDIO_ROOT,
        contextPoolDir: path.join(GAMESTUDIO_ROOT, 'ai', 'context-pool'),
        chatDir: path.join(GAMESTUDIO_ROOT, 'ai', 'chat'),
        sessionDirs: [path.join(GAMESTUDIO_ROOT, 'state', 'agent-runtime-sessions'), path.join(GAMESTUDIO_ROOT, 'state', 'reasoning-sessions')]
      })
      return c.json({ ok: true, report })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.get('/api/control/agents/:agentId/memory-lifecycle/report', (c) => {
    try {
      const { agentId } = c.req.param()
      if (agentId !== hermesAgentDefinition.id) {
        return c.json({ ok: false, error: 'agent_not_found' }, 404)
      }
      const reportPath = path.join(GAMESTUDIO_ROOT, 'state', 'memory-lifecycle', 'latest-report.json')
      if (!fs.existsSync(reportPath)) {
        return c.json({ ok: false, error: 'report_not_found' }, 404)
      }
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
      return c.json({ ok: true, report })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // ── GameStudio 项目代理 ─────────────────────────────
  app.get('/api/control/projects', async (c) => {
    try {
      const result = await gameStudioServerClient.listProjects()
      return c.json({ ok: result.ok, projects: result.data?.projects || [], error: result.error || null })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.post('/api/control/projects', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}))
      const title = String(body.title || '').trim() || '未命名项目'
      const result = await gameStudioServerClient.createProject({ title })
      return c.json({ ok: result.ok, project: result.data?.project || null, error: result.error || null })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.get('/api/control/projects/:projectId', async (c) => {
    try {
      const { projectId } = c.req.param()
      const result = await gameStudioServerClient.getProject(projectId)
      return c.json({ ok: result.ok, project: result.data?.project || null, error: result.error || null })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  app.delete('/api/control/projects/:projectId', async (c) => {
    try {
      const { projectId } = c.req.param()
      const result = await gameStudioServerClient.updateProject(projectId, { deleted: true })
      return c.json({ ok: result.ok, project: result.data?.project || null, error: result.error || null })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500)
    }
  })

  // ── ComfyUI 能力检查与自愈代理（所有权属于 GameStudio server，此处透传）──
  app.get('/api/control/gamestudio/comfyui/capability-check', async (c) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const res = await fetch(`${GAMESTUDIO_SERVER_BASE_URL}/api/ai/comfyui/capability-check`, { signal: controller.signal })
      const payload = await res.json().catch(() => null)
      if (!res.ok || !payload) return c.json({ ok: false, error: `capability_check_http_${res.status}` }, res.ok ? 500 : res.status)
      return c.json({ ok: true, ...payload })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502)
    } finally {
      clearTimeout(timeout)
    }
  })

  app.post('/api/control/gamestudio/comfyui/auto-fix', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 600000)
    try {
      const res = await fetch(`${GAMESTUDIO_SERVER_BASE_URL}/api/ai/comfyui/auto-fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: controller.signal
      })
      const payload = await res.json().catch(() => null)
      if (!res.ok || !payload) return c.json({ ok: false, error: (payload && payload.message) || `auto_fix_http_${res.status}` }, res.ok ? 500 : res.status)
      return c.json({ ok: Boolean(payload.success), ...payload })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502)
    } finally {
      clearTimeout(timeout)
    }
  })
}
