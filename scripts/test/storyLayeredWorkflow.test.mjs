import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// AUTO-E04：control 侧「背景+立绘分层合成」工作流接线测试。
// 覆盖：
// - 计划形状：分层合成关键词触发 FullP0 + 分层资产链变体；既有变体（普通创建/生产交付/AI 创建）不回归
// - action/tool 映射与四个注册点（actionRegistry、toolRegistry、story workflow/mutation 名单、projectWorkflowRegistry 白名单）
// - 批次轮询等待器（注入假 fetchBatch/sleep）：终结汇总、失败分类、拉取失败、等待超时
// - 执行器结果评估（ok/fail 路径）：背景批量与 placements 两个 evaluator 的 passed/failedStage/retryable 语义
// - client 方法（真实 node:http 假服务端）：端点路径、mode:'background' 注入、审核旁路头、失败 retryable 分类

process.env.GAMESTUDIO_SERVER_BASE_URL = 'http://127.0.0.1:1'

const { buildStoryWorkflowPlan } = await import('../../apps/control-server/src/server/workflows/storyProductionWorkflows.js')
const { REASONING_ACTIONS, REASONING_STORY_WORKFLOW_ACTION_NAMES, REASONING_STORY_MUTATION_ACTION_NAMES } = await import('../../apps/control-server/src/server/capabilities/actionRegistry.js')
const { REASONING_TOOLS } = await import('../../apps/control-server/src/server/capabilities/toolRegistry.js')
const { getRegistryWorkflow } = await import('../../apps/control-server/src/server/reasoning/projectWorkflowRegistry.js')
const {
  isSceneBatchFinished,
  summarizeSceneBatch,
  waitForSceneBatchTerminal,
  evaluateSceneBackgroundsOutcome,
  evaluateScenePlacementsOutcome
} = await import('../../apps/control-server/src/server/services/storySceneLayeringSupport.js')

const noSleep = async () => {}

// ---------------------------------------------------------------------------
// 计划形状：分层合成变体
// ---------------------------------------------------------------------------

test('分层合成变体：FullP0 文本链 + 分层资产链 + answer，步骤顺序与参数正确', () => {
  for (const prompt of [
    '创建一个狼来了互动故事，采用背景+立绘分层合成方式出图',
    '生产一个分层合成的互动故事，题目为 狼来了',
    '新建互动故事项目，角色用立绘、场景只出背景图'
  ]) {
    const plan = buildStoryWorkflowPlan(prompt)
    const actions = plan.steps.map((s) => s.action)
    // 文本链关键步骤存在且在前
    assert.ok(actions.indexOf('story_create_project') >= 0)
    assert.ok(actions.indexOf('story_compile_compose') > actions.indexOf('story_create_bible'))
    // 分层资产链：计划 → 立绘锁定 → 背景批量 → placements → 校验 → 导出
    const iPlan = actions.indexOf('story_create_asset_plan')
    const iLock = actions.indexOf('story_generate_lock_asset_references')
    const iBg = actions.indexOf('story_render_scene_backgrounds')
    const iPl = actions.indexOf('story_generate_scene_placements')
    assert.ok(iPlan > actions.indexOf('story_compile_compose'), `${prompt}：资产计划必须在文本链之后`)
    assert.ok(iLock > iPlan && iBg > iLock && iPl > iBg, `${prompt}：分层链顺序错误`)
    assert.ok(actions.lastIndexOf('story_validate_project') > iPl)
    assert.ok(actions.lastIndexOf('story_export_project') > iPl)
    assert.equal(actions[actions.length - 1], 'generate_default_answer')
    // 不得混入旧的单场景渲染 action
    assert.ok(!actions.includes('story_render_scene'), `${prompt}：分层变体不得使用旧单场景渲染`)

    const bgStep = plan.steps.find((s) => s.action === 'story_render_scene_backgrounds')
    assert.equal(bgStep.params.mode, 'background')
    assert.equal(bgStep.params.stepTimeoutMs, 3600000, 'B04 步级放宽必须声明')
    assert.equal(bgStep.tool, 'gamestudio.story.renderSceneBackgrounds')
    const plStep = plan.steps.find((s) => s.action === 'story_generate_scene_placements')
    assert.equal(plStep.tool, 'gamestudio.story.generateScenePlacements')
    // 依赖链：每步依赖前一步
    assert.deepEqual(bgStep.dependsOn, [plan.steps[iBg - 1].stepId])
  }
})

test('既有变体不回归：普通创建/生产交付/AI 创建故事的计划形状不含新 action', () => {
  const plain = buildStoryWorkflowPlan('创建一个新的互动故事项目，题目为 狼来了')
  assert.deepEqual(plain.steps.map((s) => s.action), ['story_create_project', 'story_inspect_project', 'generate_default_answer'])

  const delivery = buildStoryWorkflowPlan('生产交付一个完整互动故事，题目为 狼来了')
  const deliveryActions = delivery.steps.map((s) => s.action)
  assert.ok(deliveryActions.includes('story_render_scene'), '生产交付旧链保留单场景渲染')
  assert.ok(!deliveryActions.includes('story_render_scene_backgrounds'))
  assert.ok(!deliveryActions.includes('story_generate_scene_placements'))

  const aiCompose = buildStoryWorkflowPlan('用 AI 创建故事并完成蓝图合成，题目为 夜航船')
  const aiActions = aiCompose.steps.map((s) => s.action)
  assert.ok(aiActions.includes('story_create_ai_project'))
  assert.ok(!aiActions.includes('story_render_scene_backgrounds'))
})

// ---------------------------------------------------------------------------
// 注册点
// ---------------------------------------------------------------------------

test('注册接线：action/tool 注册表与白名单均包含两个新 action', () => {
  for (const action of ['story_render_scene_backgrounds', 'story_generate_scene_placements']) {
    assert.ok(REASONING_ACTIONS[action], `REASONING_ACTIONS 缺少 ${action}`)
    assert.ok(REASONING_STORY_WORKFLOW_ACTION_NAMES.includes(action), `story workflow 名单缺少 ${action}`)
    assert.ok(REASONING_STORY_MUTATION_ACTION_NAMES.includes(action), `mutation 名单缺少 ${action}`)
    const tool = REASONING_ACTIONS[action].tool
    assert.ok(REASONING_TOOLS[tool], `REASONING_TOOLS 缺少 ${tool}`)
    assert.equal(REASONING_TOOLS[tool].reviewPolicy, 'required')
  }
  const storyProduction = getRegistryWorkflow('story_production')
  assert.ok(storyProduction.allowedActions.includes('story_render_scene_backgrounds'))
  assert.ok(storyProduction.allowedActions.includes('story_generate_scene_placements'))
})

// ---------------------------------------------------------------------------
// 批次轮询等待器
// ---------------------------------------------------------------------------

test('批次轮询：到达终态后返回汇总，per-scene 失败/待审/完成分类正确', async () => {
  const batch = {
    batchId: 'b1',
    status: 'partial',
    items: [
      { sceneId: 's1', status: 'completed' },
      { sceneId: 's2', status: 'skipped' },
      { sceneId: 's3', status: 'failed', error: 'provider_timeout', errorCategory: 'retryable' },
      { sceneId: 's4', status: 'blocked', error: 'scene_reference_missing', errorCategory: 'blocked' },
      { sceneId: 's5', status: 'waiting_review' }
    ]
  }
  const outcome = await waitForSceneBatchTerminal({
    fetchBatch: async () => ({ ok: true, data: { batch } }),
    timeoutMs: 60000,
    sleep: noSleep
  })
  assert.equal(outcome.finished, true)
  assert.equal(outcome.summary.total, 5)
  assert.equal(outcome.summary.doneCount, 2)
  assert.equal(outcome.summary.failedCount, 2)
  assert.equal(outcome.summary.waitingCount, 1)
  assert.deepEqual(outcome.summary.failedScenes.map((x) => x.sceneId), ['s3', 's4'])
  assert.equal(outcome.summary.retryable, true, '含 retryable 失败项时整批可重试')
})

test('批次轮询：queued/running 非终态持续轮询，onProgress 每次回调', async () => {
  const states = [
    { batchId: 'b2', status: 'queued', items: [] },
    { batchId: 'b2', status: 'running', items: [{ sceneId: 's1', status: 'running' }] },
    { batchId: 'b2', status: 'completed', items: [{ sceneId: 's1', status: 'completed' }] }
  ]
  let calls = 0
  let progressCalls = 0
  const outcome = await waitForSceneBatchTerminal({
    fetchBatch: async () => ({ ok: true, data: { batch: states[Math.min(calls++, states.length - 1)] } }),
    timeoutMs: 60000,
    sleep: noSleep,
    onProgress: () => { progressCalls += 1 }
  })
  assert.equal(outcome.finished, true)
  assert.equal(outcome.polls, 3)
  assert.equal(progressCalls, 3)
  assert.equal(isSceneBatchFinished(states[0]), false)
  assert.equal(isSceneBatchFinished(states[1]), false)
})

test('批次轮询：拉取失败显式 scene_batch_poll_failed；超时显式 scene_batch_wait_timeout 且可重试', async () => {
  const pollFail = await waitForSceneBatchTerminal({
    fetchBatch: async () => ({ ok: false, error: 'http_500', message: 'server error', retryable: true }),
    timeoutMs: 60000,
    sleep: noSleep
  })
  assert.equal(pollFail.finished, false)
  assert.equal(pollFail.error, 'http_500')
  assert.equal(pollFail.retryable, true)

  const timeout = await waitForSceneBatchTerminal({
    fetchBatch: async () => ({ ok: true, data: { batch: { batchId: 'b3', status: 'running', items: [] } } }),
    timeoutMs: 1,
    sleep: noSleep
  })
  assert.equal(timeout.finished, false)
  assert.equal(timeout.error, 'scene_batch_wait_timeout')
  assert.equal(timeout.retryable, true)
})

// ---------------------------------------------------------------------------
// 执行器结果评估（ok/fail 路径）
// ---------------------------------------------------------------------------

test('背景批量评估：成功路径 passed=true，failedStage 为空', () => {
  const outcome = evaluateSceneBackgroundsOutcome({
    submitResult: { ok: true, data: { batchId: 'b1' } },
    waitOutcome: {
      finished: true,
      polls: 3,
      summary: { batchId: 'b1', status: 'completed', total: 9, doneCount: 9, waitingCount: 0, failedCount: 0, failedScenes: [], waitingScenes: [], retryable: false }
    }
  })
  assert.equal(outcome.passed, true)
  assert.equal(outcome.failedStage, null)
  assert.ok(outcome.summaryText.includes('9/9'))
})

test('背景批量评估：提交失败/渲染失败/待审/超时分别归类 failedStage 与 retryable', () => {
  const submitFail = evaluateSceneBackgroundsOutcome({
    submitResult: { ok: false, error: 'scene_batch_running', message: '已有批量队列在执行中', retryable: false },
    waitOutcome: null
  })
  assert.equal(submitFail.passed, false)
  assert.equal(submitFail.failedStage, 'scene_backgrounds_batch_api')
  assert.equal(submitFail.retryable, false)

  const renderFail = evaluateSceneBackgroundsOutcome({
    submitResult: { ok: true, data: { batchId: 'b1' } },
    waitOutcome: {
      finished: true,
      summary: { batchId: 'b1', status: 'partial', total: 3, doneCount: 2, waitingCount: 0, failedCount: 1, failedScenes: [{ sceneId: 's3', status: 'failed', error: 'provider_timeout', errorCategory: 'retryable' }], waitingScenes: [], retryable: true }
    }
  })
  assert.equal(renderFail.passed, false)
  assert.equal(renderFail.failedStage, 'scene_backgrounds_render')
  assert.equal(renderFail.retryable, true)
  assert.ok(renderFail.summaryText.includes('s3'))

  const waiting = evaluateSceneBackgroundsOutcome({
    submitResult: { ok: true, data: { batchId: 'b1' } },
    waitOutcome: {
      finished: true,
      summary: { batchId: 'b1', status: 'completed', total: 2, doneCount: 1, waitingCount: 1, failedCount: 0, failedScenes: [], waitingScenes: ['s2'], retryable: false }
    }
  })
  assert.equal(waiting.passed, false)
  assert.equal(waiting.failedStage, 'scene_backgrounds_review')

  const timeout = evaluateSceneBackgroundsOutcome({
    submitResult: { ok: true, data: { batchId: 'b1' } },
    waitOutcome: { finished: false, error: 'scene_batch_wait_timeout', message: '等待批量渲染终结超时（1000ms）', retryable: true, summary: { batchId: 'b1', status: 'running', total: 2, doneCount: 1, waitingCount: 0, failedCount: 0, failedScenes: [], waitingScenes: [], retryable: false } }
  })
  assert.equal(timeout.passed, false)
  assert.equal(timeout.failedStage, 'scene_backgrounds_batch_timeout')
  assert.equal(timeout.retryable, true)
})

test('placements 评估：新建/幂等刷新通过；全部未锁定显式失败；API 失败归类 api 阶段', () => {
  const okCreated = evaluateScenePlacementsOutcome({
    ok: true,
    data: {
      summary: { scenes: 9, placementsCreated: 20, placementsUpdated: 0, charactersCreated: 3, charactersUpdated: 0, skippedCharacters: 0, skippedProps: 0 },
      scenes: [{ sceneId: 's1', ok: true }],
      skippedCharacters: [],
      skippedProps: []
    }
  })
  assert.equal(okCreated.passed, true)
  assert.equal(okCreated.failedStage, null)
  assert.equal(okCreated.stats.written, 20)

  const okIdempotent = evaluateScenePlacementsOutcome({
    ok: true,
    data: {
      summary: { scenes: 9, placementsCreated: 0, placementsUpdated: 20, charactersCreated: 0, charactersUpdated: 0, skippedCharacters: 0, skippedProps: 0 },
      scenes: [],
      skippedCharacters: [],
      skippedProps: []
    }
  })
  assert.equal(okIdempotent.passed, true, '幂等重跑（全刷新无新建）必须通过')

  const allSkipped = evaluateScenePlacementsOutcome({
    ok: true,
    data: {
      summary: { scenes: 2, placementsCreated: 0, placementsUpdated: 0, charactersCreated: 0, charactersUpdated: 0, skippedCharacters: 2, skippedProps: 0 },
      scenes: [],
      skippedCharacters: [{ sceneId: 's1', assetId: 'char_a', name: '牧羊人', reason: 'reference_not_locked' }],
      skippedProps: []
    }
  })
  assert.equal(allSkipped.passed, false)
  assert.equal(allSkipped.failedStage, 'scene_placements_evaluator')
  assert.ok(allSkipped.summaryText.includes('牧羊人'))

  const apiFail = evaluateScenePlacementsOutcome({ ok: false, error: 'missing_plan', message: '请先生成资产计划。', retryable: false })
  assert.equal(apiFail.passed, false)
  assert.equal(apiFail.failedStage, 'scene_placements_api')
  assert.equal(apiFail.retryable, false)
})

// ---------------------------------------------------------------------------
// client 方法（真实 node:http 假服务端，验证请求形状与失败分类）
// ---------------------------------------------------------------------------

test('client：背景批量提交带 mode=background 与审核旁路头；placements/查询端点路径正确', async () => {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, reviewMode: req.headers['x-image-review-mode'], body: body ? JSON.parse(body) : null })
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'POST' && req.url.endsWith('/ai/story/scenes/batch')) {
        res.statusCode = 202
        res.end(JSON.stringify({ success: true, batchId: 'batch_fake', taskId: 'task_fake', total: 2 }))
        return
      }
      if (req.method === 'GET' && req.url.endsWith('/ai/story/scenes/batch')) {
        res.end(JSON.stringify({ success: true, batch: { batchId: 'batch_fake', status: 'completed', items: [] } }))
        return
      }
      if (req.method === 'POST' && req.url.endsWith('/ai/story/scenes/placements')) {
        res.end(JSON.stringify({ success: true, summary: { placementsCreated: 2, placementsUpdated: 0 }, scenes: [], skippedCharacters: [], skippedProps: [] }))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ success: false, error: 'not_found' }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  process.env.GAMESTUDIO_SERVER_BASE_URL = `http://127.0.0.1:${port}`
  try {
    const client = await import(`../../apps/control-server/src/server/services/gameStudioServerClient.js?test=${port}`)
    const submit = await client.renderStorySceneBackgroundsBatch('proj_x', { width: 768, height: 1024, timeoutMs: 600000 })
    assert.equal(submit.ok, true)
    assert.equal(submit.data.batchId, 'batch_fake')

    const query = await client.getStorySceneBatch('proj_x')
    assert.equal(query.ok, true)
    assert.equal(query.data.batch.status, 'completed')

    const placements = await client.generateStoryScenePlacements('proj_x', {})
    assert.equal(placements.ok, true)
    assert.equal(placements.data.summary.placementsCreated, 2)

    assert.equal(seen[0].method, 'POST')
    assert.ok(seen[0].url.startsWith('/api/projects/proj_x/ai/story/scenes/batch'))
    assert.equal(seen[0].body.mode, 'background', '批量提交必须带 background 模式')
    assert.equal(seen[0].body.width, 768)
    assert.equal(seen[0].reviewMode, 'off', 'control 驱动调用必须带审核旁路头')
    assert.equal(seen[1].method, 'GET')
    assert.equal(seen[2].method, 'POST')
    assert.ok(seen[2].url.endsWith('/ai/story/scenes/placements'))

    // 失败分类：5xx → ok:false 且 retryable
    const failing = http.createServer((req, res) => {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ success: false, error: 'provider_unavailable', message: 'down' }))
    })
    await new Promise((resolve) => failing.listen(0, '127.0.0.1', resolve))
    process.env.GAMESTUDIO_SERVER_BASE_URL = `http://127.0.0.1:${failing.address().port}`
    try {
      const failClient = await import(`../../apps/control-server/src/server/services/gameStudioServerClient.js?test=fail${failing.address().port}`)
      const failed = await failClient.renderStorySceneBackgroundsBatch('proj_x', {})
      assert.equal(failed.ok, false)
      assert.equal(failed.retryable, true)
    } finally {
      await new Promise((resolve) => failing.close(resolve))
    }
  } finally {
    server.close()
  }
})
