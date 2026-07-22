import { test } from 'node:test'
import assert from 'node:assert'
import { Hono } from 'hono'
import { registerOverviewRoutes } from '../../src/server/routes/overviewRoutes.js'
import { registerReasoningRoutes } from '../../src/server/routes/reasoningRoutes.js'

function buildMockContext(overrides = {}) {
  const baseModel = {
    status: 'unloaded',
    loaded: false,
    model: 'Qwen3.5-9B-MLX-4bit',
    provider: 'omlx',
    baseUrl: 'http://127.0.0.1:18888/v1',
    detail: '模型未启动'
  }
  const baseConfig = {
    provider: 'omlx',
    baseUrl: 'http://127.0.0.1:18888/v1',
    model: 'Qwen3.5-9B-MLX-4bit'
  }
  const baseFingerprint = JSON.stringify(baseConfig)

  return {
    fs: {
      existsSync: () => false,
      readFileSync: () => '',
      mkdirSync: () => {},
      writeFileSync: () => {},
      readdirSync: () => []
    },
    GAMESTUDIO_ROOT: '/tmp/gamestudio',
    HERMES_HOME: '/tmp/hermes',
    HERMES_RUNTIME_LOG_FILE: '/tmp/hermes.log',
    path: {
      join: (...parts) => parts.join('/'),
      dirname: (p) => p.split('/').slice(0, -1).join('/') || '/',
      relative: () => ''
    },
    appendHermesLog: () => {},
    appendReasoningEvent: () => {},
    approveReasoningQualityOverride: () => {},
    applyPreparedLifecycleScript: () => {},
    applyPreparedWorkspaceOperation: () => {},
    applyPreparedReasoningWrite: () => {},
    buildConfigValidation: () => ({ ready: false, items: [] }),
    buildHermesActionContract: () => ({}),
    buildHermesAgentRecord: () => ({
      definition: { id: 'hermes-manager', runtime: 'hermes' },
      status: { availability: 'unknown' }
    }),
    buildHermesBinding: () => baseConfig,
    buildHermesBindingFromConfig: () => baseConfig,
    buildHermesChatMessages: () => [],
    buildHermesNextAction: () => ({}),
    buildHermesStartupFlow: () => ({}),
    buildHermesStartupProfile: () => ({}),
    buildHermesPreflight: async () => ({ ready: false }),
    buildHermesSelfCheck: async () => ({}),
    buildModelStateSnapshot: () => baseModel,
    buildRuntimeStateSnapshot: (status) => status,
    cancelReasoningSession: () => {},
    clearReasoningReview: () => {},
    continueReasoningSessionFromStep: () => {},
    createReasoningSession: async () => ({ sessionId: 'sess-test', status: 'planning' }),
    deleteReasoningSessionRecord: () => {},
    fetchLocalModelCatalog: async () => ({ ok: false, models: [] }),
    getHermesControlConfigFingerprint: () => baseFingerprint,
    getHermesControlState: () => ({
      config: { saved: true, savedFingerprint: baseFingerprint },
      model: baseModel,
      preflight: { ready: false, configFingerprint: baseFingerprint }
    }),
    getHermesRuntimeState: () => ({
      state: 'stopped',
      label: '已停止',
      detail: 'Hermes 未运行',
      pid: null
    }),
    getPersistedHermesControlConfig: () => baseConfig,
    getProviderAccess: () => ({
      provider: 'omlx',
      baseUrl: 'http://127.0.0.1:18888/v1',
      apiKey: 'omlx123',
      headers: { Authorization: 'Bearer omlx123' }
    }),
    hermesAgentDefinition: { id: 'hermes-manager' },
    inspectProviderModelState: async () => baseModel,
    listActiveReasoningExecutions: () => [],
    listReasoningSessions: () => [],
    loadProviderModel: async () => ({ ok: false }),
    markReasoningSessionFailed: () => {},
    mergeHermesControlConfig: (a, b) => ({ ...a, ...b }),
    normalizeModelBaseUrl: (url) => url,
    normalizeProviderName: (p) => p,
    openFileInEditor: () => {},
    persistHermesChatPrompt: () => {},
    persistHermesChatReply: () => {},
    persistReasoningReviewDecision: () => {},
    prepareReasoningSessionPlan: async () => {},
    readHermesChatHistory: () => [],
    readReasoningSession: () => null,
    runAllReasoningStepsFrom: async () => {},
    runReasoningSession: async () => {},
    startOmlxApp: async () => ({ ok: false }),
    stopHermesRuntime: async () => ({}),
    unloadProviderModel: async () => ({ ok: true }),
    updateHermesControlState: (patch) => ({ ...patch }),
    updateReasoningSession: () => {},
    writeReasoningSession: (s) => s,
    ...overrides
  }
}

test('overview returns real readiness alerts and blocks production when dependencies are missing', async () => {
  const app = new Hono()
  registerOverviewRoutes(app, buildMockContext())

  // Isolate from the real OMLX service: force the /models probe to fail.
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/models')) {
      throw new Error('simulated_unreachable')
    }
    return originalFetch(url, options)
  }

  let res
  try {
    res = await app.request('/api/control/overview')
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(res.status, 200)
  const body = await res.json()

  assert.equal(body.ok, true)
  assert.equal(body.readyForProduction, false)
  assert.ok(Array.isArray(body.alerts))
  assert.ok(body.alerts.some((a) => a.level === 'critical' && a.source === 'omlx'))
  assert.ok(body.alerts.some((a) => a.level === 'critical' && a.source === 'hermes'))
  assert.ok(body.alerts.some((a) => a.level === 'critical' && a.source === 'model'))
  assert.equal(body.controlSystem.status, 'degraded')
  assert.equal(body.omlx.reachable, false)
  assert.equal(body.hermes.state, 'stopped')
  assert.equal(body.model.loaded, false)
})

test('overview reports readyForProduction when OMLX, Hermes and model are all healthy', async () => {
  const app = new Hono()
  const runningModel = {
    status: 'loaded',
    loaded: true,
    model: 'Qwen3.5-9B-MLX-4bit',
    provider: 'omlx',
    baseUrl: 'http://127.0.0.1:18888/v1',
    detail: '模型已加载'
  }
  const ctx = buildMockContext({
    getHermesRuntimeState: () => ({
      state: 'running',
      label: '运行中',
      detail: 'Hermes OK',
      pid: 12345
    }),
    getHermesControlState: () => ({
      config: { saved: true, savedFingerprint: JSON.stringify({ provider: 'omlx', baseUrl: 'http://127.0.0.1:18888/v1', model: 'Qwen3.5-9B-MLX-4bit' }) },
      model: runningModel,
      preflight: { ready: true }
    }),
    // Simulate a reachable OMLX service by making /models return successfully.
    getProviderAccess: () => ({
      provider: 'omlx',
      baseUrl: 'http://127.0.0.1:18888/v1',
      apiKey: 'omlx123',
      headers: { Authorization: 'Bearer omlx123' }
    })
  })
  // Provide a global fetch mock for this test only.
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/models')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'Qwen3.5-9B-MLX-4bit' }, { id: 'another-model' }] })
      }
    }
    return originalFetch(url, options)
  }
  try {
    registerOverviewRoutes(app, ctx)
    const res = await app.request('/api/control/overview')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.readyForProduction, true)
    assert.equal(body.omlx.reachable, true)
    assert.equal(body.omlx.modelCount, 2)
    assert.equal(body.hermes.state, 'running')
    assert.equal(body.model.loaded, true)
    assert.equal(body.alerts.filter((a) => a.level === 'critical').length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('reasoning session creation is blocked when Hermes runtime is not running', async () => {
  const app = new Hono()
  registerReasoningRoutes(app, buildMockContext())

  const res = await app.request('/api/control/agents/hermes-manager/reasoning-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'create a story project', productionTest: true })
  })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.error, 'runtime_not_running')
})

test('reasoning session creation is blocked when model is not loaded even if productionTest is true', async () => {
  const app = new Hono()
  const ctx = buildMockContext({
    getHermesRuntimeState: () => ({
      state: 'running',
      label: '运行中',
      detail: 'Hermes OK',
      pid: 12345
    }),
    buildConfigValidation: () => ({ ready: true, items: [] })
  })
  registerReasoningRoutes(app, ctx)

  const res = await app.request('/api/control/agents/hermes-manager/reasoning-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'create a story project', productionTest: true })
  })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.error, 'left_brain_model_not_loaded')
})
