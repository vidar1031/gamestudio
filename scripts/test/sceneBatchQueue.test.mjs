import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// AUTO-E03 / S4-03：批量场景生产队列。
// 覆盖路径：
// - 三 scene 提交并以可观测顺序（= 提交顺序）串行执行，per-scene checkpoint 落盘
// - 单 scene 失败不阻塞其他合法 scene：reference gate BLOCKED 保留、临时故障按 C02 退避重试恢复
// - 确定性失败不盲重试，显式恢复（retryFailed）后重跑成功
// - 成功保护：已成功 scene 不重复生成（project/story 前后 deepEqual），显式 regenerate 才重新生成且门禁保留
// - 重启恢复：崩溃瞬间 checkpoint（running 状态）→ 恢复扫描从断点继续，已成功 scene 不重复执行
// 环境说明：ComfyUI/SD-WebUI 不可达，底层 provider 调用经 STUDIO_ENABLE_TEST_HOOKS 注入替代；
// 注入函数仅返回真实 PNG 夹具字节或模拟故障，其后的 sniff/落盘/回填均为真实实现，未伪造任何图片/评审/导出物。
// 环境隔离：STUDIO_STORAGE_ROOT 指向临时目录，不触碰真实 storage/projects。

const TMP = await mkdtemp(path.join(os.tmpdir(), 'gs-e03-'))
process.env.STUDIO_STORAGE_ROOT = TMP
process.env.STUDIO_ENABLE_TEST_HOOKS = '1'
// 指向必然拒绝连接的回环地址，保证未注入时 provider 失败快速且确定
process.env.COMFYUI_BASE_URL = 'http://127.0.0.1:9'
process.env.SDWEBUI_BASE_URL = 'http://127.0.0.1:9'
// 测试尺度退避：C02 指数退避语义不变，仅压缩等待时间
process.env.STUDIO_SCENE_BATCH_RETRY_BASE_MS = '20'
process.env.STUDIO_SCENE_BATCH_RETRY_MAX_DELAY_MS = '40'

const { setBackgroundImageGeneratorForTest } = await import('../../apps/server/src/ai/background.js')
const { verifyStoryAssetReferenceFile } = await import('../../apps/server/src/ai/storyAssetReferenceGate.js')
const { loadSceneBatch, findInterruptedSceneBatches, resumeSceneBatch, classifySceneFailure } = await import('../../apps/server/src/ai/sceneBatchQueue.js')
const { default: app } = await import('../../apps/server/src/index.js')

// 1x1 透明 PNG（真实图片字节）
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_B64, 'base64')

const PROJECT_ID = 'proj_e03'
const PROJECT_DIR = path.join(TMP, 'projects', PROJECT_ID)
const PROJECTS_DIR = path.join(TMP, 'projects')
const LOCKED_REF_REL = 'assets/ai/story_assets/char.locked/ref.png'

function makePlanAsset({ id, referenceStatus, uri }) {
  return {
    id,
    name: `角色${id}`,
    category: 'character',
    lockProfile: 'character_core',
    lockWorkflow: 'character_sheet',
    persistence: 'high',
    renderStrategy: 'ref_required',
    anchorPrompt: `anchor of ${id}`,
    negativePrompt: '',
    aliases: [],
    forbiddenSubstitutes: [],
    sceneIds: [],
    sceneCount: 0,
    projectCharacterId: '',
    primaryReferenceAssetId: uri ? `asset_${id.replace(/[^a-z0-9]+/gi, '_')}` : '',
    primaryReferenceAssetUri: uri || '',
    primaryReferenceSelectedAt: uri ? new Date().toISOString() : '',
    referenceStatus,
    generatedRefs: [],
    latestReferenceBatch: [],
    latestReferenceReview: uri ? { passed: true, score: 90, skipped: false } : null,
    referencePromptHint: 'single full-body front view'
  }
}

const ASSET_LOCKED = makePlanAsset({ id: 'char.locked', referenceStatus: 'ready', uri: LOCKED_REF_REL })
const ASSET_UNLOCKED = makePlanAsset({ id: 'char.unlocked', referenceStatus: 'missing', uri: '' })

function makeSceneEntry({ sceneId, sceneIndex, assets }) {
  return {
    sceneId,
    sceneIndex,
    sceneName: `场景${sceneId}`,
    summary: `summary of ${sceneId}`,
    sourceKey: sceneId,
    workflow: 'scene_prompt_only',
    missingRequiredAssetIds: [],
    readyReferenceAssetIds: [],
    assetIds: assets.map((a) => a.id),
    promptAssets: assets.map((a) => ({
      id: a.id,
      name: a.name,
      category: a.category,
      lockProfile: a.lockProfile,
      lockWorkflow: a.lockWorkflow,
      renderStrategy: a.renderStrategy,
      referenceStatus: a.referenceStatus,
      primaryReferenceAssetId: a.primaryReferenceAssetId,
      primaryReferenceAssetUri: a.primaryReferenceAssetUri,
      anchorPrompt: a.anchorPrompt,
      negativePrompt: '',
      forbiddenSubstitutes: []
    }))
  }
}

// 合法场景（锁定参考）+ scene_gate（ref_required 未锁定 → reference gate BLOCKED）
const SCENE_IDS = ['scene_a', 'scene_b', 'scene_c', 'scene_d', 'scene_e', 'scene_f', 'scene_g', 'scene_h', 'scene_gate']

async function seedProject() {
  await mkdir(path.join(PROJECT_DIR, 'story-assets'), { recursive: true })
  const plan = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    worldAnchor: 'test world anchor',
    forbiddenSubstitutes: [],
    eventChain: [],
    excludedAssetIds: [],
    assets: [ASSET_LOCKED, ASSET_UNLOCKED],
    scenes: SCENE_IDS.map((sceneId, i) => makeSceneEntry({
      sceneId,
      sceneIndex: i + 1,
      assets: sceneId === 'scene_gate' ? [ASSET_UNLOCKED] : [ASSET_LOCKED]
    })),
    summary: {}
  }
  await writeFile(path.join(PROJECT_DIR, 'story-assets', 'plan.json'), JSON.stringify(plan, null, 2))

  const project = {
    schemaVersion: '1.0',
    id: PROJECT_ID,
    name: 'E03 测试项目',
    characters: [],
    assets: [],
    state: {},
    updatedAt: new Date().toISOString()
  }
  await writeFile(path.join(PROJECT_DIR, 'project.json'), JSON.stringify(project, null, 2))

  const storyNode = (id) => ({ id, kind: 'scene', name: `场景${id}`, body: { title: `场景${id}`, text: '…' }, visuals: {}, choices: [] })
  await writeFile(
    path.join(PROJECT_DIR, 'story.json'),
    JSON.stringify({ schemaVersion: '2.0', startNodeId: 'scene_a', nodes: SCENE_IDS.map(storyNode) }, null, 2)
  )

  // 已锁定的参考图真实落盘
  const lockedAbs = path.join(PROJECT_DIR, LOCKED_REF_REL)
  await mkdir(path.dirname(lockedAbs), { recursive: true })
  await writeFile(lockedAbs, PNG_BYTES)

  // 启用出图 provider（指向不可达地址；成功路径由注入生成器替代底层调用）
  await mkdir(path.join(TMP, '_config'), { recursive: true })
  await writeFile(
    path.join(TMP, '_config', 'studio_settings.json'),
    JSON.stringify({ enabled: { image: true }, image: { provider: 'sdwebui', sdwebuiBaseUrl: 'http://127.0.0.1:9' } }, null, 2)
  )
}

await seedProject()

async function readJson(rel) {
  return JSON.parse(await readFile(path.join(PROJECT_DIR, rel), 'utf-8'))
}

function postBatch(body, { reviewMode = 'off' } = {}) {
  return app.request(`/api/projects/${PROJECT_ID}/ai/story/scenes/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-image-review-mode': reviewMode },
    body: JSON.stringify(body)
  })
}

function postResume(body) {
  return app.request(`/api/projects/${PROJECT_ID}/ai/story/scenes/batch/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  })
}

async function getBatch() {
  const res = await app.request(`/api/projects/${PROJECT_ID}/ai/story/scenes/batch`)
  return (await res.json()).batch
}

async function waitFor(cond, { timeoutMs = 10000, intervalMs = 20, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await cond()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

async function waitBatchTerminal() {
  return waitFor(async () => {
    const batch = await getBatch()
    return batch && ['completed', 'partial', 'failed'].includes(batch.status) ? batch : null
  }, { label: '批次收敛到终态' })
}

// 等批次任务收尾（finalize 后进程内守卫释放，避免后续 submit/resume 撞 409）
async function waitTaskDone(taskId) {
  return waitFor(async () => {
    const tasks = await (await app.request(`/api/projects/${PROJECT_ID}/ai/tasks`)).json()
    const task = tasks.tasks.find((t) => t.taskId === taskId)
    return task && task.done ? task : null
  }, { label: `任务 ${taskId} 收尾` })
}

async function submitBatchAndWait(body) {
  const res = await postBatch(body)
  assert.equal(res.status, 202)
  const accepted = await res.json()
  const batch = await waitBatchTerminal()
  await waitTaskDone(accepted.taskId)
  return { accepted, batch }
}

function findItem(batch, sceneId) {
  return batch.items.find((it) => it.sceneId === sceneId)
}

// 与 index.js makeSceneBatchRunner 等价的 renderScene 映射（测试直接驱动模块恢复路径时使用）
function makeTestRenderScene() {
  return async (sceneId) => {
    try {
      const resp = await app.request(`/api/projects/${PROJECT_ID}/ai/story/scenes/${encodeURIComponent(sceneId)}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-image-review-mode': 'off' },
        body: JSON.stringify({})
      })
      const json = await resp.json().catch(() => ({}))
      if (resp.status === 202 && json && json.pendingReview) return { pendingReview: true, message: '待审核' }
      if (resp.ok && json && json.success) return { ok: true, assetPath: json.assetPath, projectAssetId: json.projectAsset && json.projectAsset.id }
      return { ok: false, httpStatus: resp.status, error: String(json.error || ''), message: String(json.message || json.error || `http_${resp.status}`) }
    } catch (e) {
      return { ok: false, httpStatus: 0, error: '', message: e && e.message ? String(e.message) : String(e) }
    }
  }
}

// 生成器调用记录：[{ sceneId, prompt }]，sceneId 从 prompt 中的场景 summary 提取
const renderCalls = []
function installSuccessGenerator() {
  setBackgroundImageGeneratorForTest(async (input) => {
    const prompt = String(input && input.prompt || '')
    const matched = SCENE_IDS.find((sid) => prompt.includes(`summary of ${sid}`))
    renderCalls.push({ sceneId: matched || 'unknown', prompt })
    return { bytes: PNG_BYTES, ext: 'png', meta: { provider: 'test-injected', url: '' } }
  })
}

test.after(async () => {
  setBackgroundImageGeneratorForTest(null)
  await rm(TMP, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// S4-03 三 scene：可观测顺序执行 + per-scene checkpoint + 进度可见
// ---------------------------------------------------------------------------

test('三 scene 批次：按提交顺序串行执行，checkpoint 与 /ai/tasks 进度可见', async () => {
  installSuccessGenerator()
  renderCalls.length = 0

  const { accepted, batch } = await submitBatchAndWait({ sceneIds: ['scene_a', 'scene_b', 'scene_c'] })
  assert.equal(accepted.success, true)
  assert.ok(accepted.batchId)
  assert.ok(accepted.taskId)
  assert.equal(accepted.total, 3)
  assert.equal(batch.status, 'completed')
  assert.equal(batch.items.length, 3)

  // 可观测顺序：生成器真实调用顺序 = 提交顺序
  assert.deepEqual(renderCalls.map((c) => c.sceneId), ['scene_a', 'scene_b', 'scene_c'])

  // per-scene checkpoint：状态、产物 URI、时间戳逐项落盘
  for (const sceneId of ['scene_a', 'scene_b', 'scene_c']) {
    const item = findItem(batch, sceneId)
    assert.equal(item.status, 'completed')
    assert.equal(item.attempts, 1)
    assert.ok(item.assetPath, `${sceneId} checkpoint 必须含产物 URI`)
    const fileGate = await verifyStoryAssetReferenceFile({ dir: PROJECT_DIR, assetPath: item.assetPath })
    assert.equal(fileGate.ok, true, `${sceneId} 产物文件必须真实存在`)
    assert.ok(item.history.some((h) => h.event === 'completed'))
  }

  // 回填真实发生
  const story = await readJson('story.json')
  for (const sceneId of ['scene_a', 'scene_b', 'scene_c']) {
    assert.ok(story.nodes.find((n) => n.id === sceneId).visuals.backgroundAssetId, `${sceneId} 必须回填绑定`)
  }

  // 长任务进度经 /ai/tasks 可见
  const tasks = await (await app.request(`/api/projects/${PROJECT_ID}/ai/tasks`)).json()
  const batchTask = tasks.tasks.find((t) => t.taskId === accepted.taskId)
  assert.ok(batchTask, '批次必须有任务进度记录')
  assert.equal(batchTask.kind, 'story.scenes.batch')
  assert.equal(batchTask.done, true)
  assert.equal(batchTask.stage, 'done')
  assert.equal(batchTask.result.items.length, 3)
})

// ---------------------------------------------------------------------------
// S4-03 单失败不阻塞：reference gate BLOCKED 保留 + 临时故障 C02 退避重试恢复
// ---------------------------------------------------------------------------

test('单失败不阻塞：gate 场景 BLOCKED、临时故障退避重试成功、后续场景照常完成', async () => {
  let flakyFailed = false
  setBackgroundImageGeneratorForTest(async (input) => {
    const prompt = String(input && input.prompt || '')
    const matched = SCENE_IDS.find((sid) => prompt.includes(`summary of ${sid}`))
    renderCalls.push({ sceneId: matched || 'unknown', prompt })
    if (matched === 'scene_d' && !flakyFailed) {
      flakyFailed = true
      const e = new Error('provider unreachable (injected)')
      e.status = 502
      throw e
    }
    return { bytes: PNG_BYTES, ext: 'png', meta: { provider: 'test-injected', url: '' } }
  })
  renderCalls.length = 0

  const { batch } = await submitBatchAndWait({ sceneIds: ['scene_gate', 'scene_d', 'scene_e'] })
  assert.equal(batch.status, 'partial', '有阻断也有成功 → partial')

  // reference gate 全保留：缺引用场景 BLOCKED（E02 语义），不阻塞其他场景
  const gate = findItem(batch, 'scene_gate')
  assert.equal(gate.status, 'blocked')
  assert.equal(gate.errorCategory, 'blocked')
  assert.equal(gate.attempts, 1, '门禁阻断不得重试')
  assert.match(gate.error, /scene_reference_missing|必须参考图/)

  // 临时故障按 C02 策略恢复：首次 502 → retry_wait → 退避重试成功
  const flaky = findItem(batch, 'scene_d')
  assert.equal(flaky.status, 'completed')
  assert.equal(flaky.attempts, 2, '临时故障必须重试一次后成功')
  assert.ok(flaky.history.some((h) => h.event === 'retry_wait'), '必须留下 retry_wait 退避记录')
  assert.equal(renderCalls.filter((c) => c.sceneId === 'scene_d').length, 2)

  // 后续合法场景不被失败阻塞
  assert.equal(findItem(batch, 'scene_e').status, 'completed')

  // 阻断场景零写入，成功场景真实回填
  const story = await readJson('story.json')
  assert.equal(story.nodes.find((n) => n.id === 'scene_gate').visuals.backgroundAssetId, undefined)
  assert.ok(story.nodes.find((n) => n.id === 'scene_d').visuals.backgroundAssetId)
  assert.ok(story.nodes.find((n) => n.id === 'scene_e').visuals.backgroundAssetId)
})

// ---------------------------------------------------------------------------
// S4-03 确定性失败：不盲重试；显式恢复（retryFailed）后重跑成功
// ---------------------------------------------------------------------------

test('确定性失败不盲重试，显式恢复后重跑成功', async () => {
  setBackgroundImageGeneratorForTest(async (input) => {
    const prompt = String(input && input.prompt || '')
    const matched = SCENE_IDS.find((sid) => prompt.includes(`summary of ${sid}`))
    renderCalls.push({ sceneId: matched || 'unknown', prompt })
    if (matched === 'scene_f') throw new Error('invalid_json_response (injected)')
    return { bytes: PNG_BYTES, ext: 'png', meta: { provider: 'test-injected', url: '' } }
  })
  renderCalls.length = 0

  const { batch } = await submitBatchAndWait({ sceneIds: ['scene_f'] })
  assert.equal(batch.status, 'failed')
  const item = findItem(batch, 'scene_f')
  assert.equal(item.status, 'failed')
  assert.equal(item.errorCategory, 'non_retryable')
  assert.equal(item.attempts, 1, '确定性错误（provider_invalid_output）不得盲重试')
  assert.equal(renderCalls.filter((c) => c.sceneId === 'scene_f').length, 1)

  // 无显式恢复意图：resume 不重跑失败场景
  const noopRes = await postResume({})
  assert.equal(noopRes.status, 202)
  const noopAccepted = await noopRes.json()
  await waitTaskDone(noopAccepted.taskId)
  const unchanged = findItem(await getBatch(), 'scene_f')
  assert.equal(unchanged.status, 'failed', '无 retryFailed 时失败场景不得自动重跑')
  assert.equal(renderCalls.filter((c) => c.sceneId === 'scene_f').length, 1)

  // 修复故障源 + 显式恢复：失败场景重置预算重跑成功
  installSuccessGenerator()
  const resumeRes = await postResume({ retryFailed: true })
  assert.equal(resumeRes.status, 202)
  const resumeAccepted = await resumeRes.json()
  // 先等恢复任务收尾（文件在 worker 内更新，立即读可能拿到旧终态）
  await waitTaskDone(resumeAccepted.taskId)
  const recovered = await getBatch()
  assert.equal(recovered.status, 'completed')
  const recoveredItem = findItem(recovered, 'scene_f')
  assert.equal(recoveredItem.status, 'completed')
  assert.equal(recoveredItem.attempts, 1, '显式恢复后获得全新尝试预算')
  assert.ok(recoveredItem.history.some((h) => h.event === 'resumed'), '必须留下恢复记录')
  assert.ok(recoveredItem.assetPath)
  const story = await readJson('story.json')
  assert.ok(story.nodes.find((n) => n.id === 'scene_f').visuals.backgroundAssetId)
})

// ---------------------------------------------------------------------------
// S4-03 成功保护：已成功 scene 不重复生成；显式 regenerate 才重新生成且门禁保留
// ---------------------------------------------------------------------------

test('成功保护：已成功场景默认跳过零写入，显式 regenerate 重新生成且 reference gate 保留', async () => {
  installSuccessGenerator()
  const beforeProject = await readJson('project.json')
  const beforeStory = await readJson('story.json')
  assert.ok(beforeStory.nodes.find((n) => n.id === 'scene_a').visuals.backgroundAssetId, '前置：scene_a 已成功')
  renderCalls.length = 0

  // 无 regenerate 意图：已成功场景 skipped，生成器零调用，项目数据前后 deepEqual 不变
  const { accepted, batch } = await submitBatchAndWait({ sceneIds: ['scene_a', 'scene_b'] })
  assert.ok(accepted.items.every((it) => it.status === 'skipped' && it.skipReason === 'already_succeeded'))
  assert.equal(batch.status, 'completed')
  assert.equal(renderCalls.length, 0, '已成功场景不得重复生成')
  assert.deepEqual(await readJson('project.json'), beforeProject)
  assert.deepEqual(await readJson('story.json'), beforeStory)

  // 显式 regenerate：scene_a 重新生成（走完整链路），scene_gate 在 regenerate 下仍被 reference gate BLOCKED
  const beforeAssetCount = beforeProject.assets.length
  const { batch: regenBatch } = await submitBatchAndWait({ sceneIds: ['scene_a', 'scene_gate'], regenerate: true })
  assert.equal(regenBatch.status, 'partial')
  const regenA = findItem(regenBatch, 'scene_a')
  assert.equal(regenA.status, 'completed')
  assert.ok(regenA.assetPath)
  assert.equal(renderCalls.map((c) => c.sceneId).filter((s) => s === 'scene_a').length, 1, '显式 regenerate 必须真实重新生成')
  const regenGate = findItem(regenBatch, 'scene_gate')
  assert.equal(regenGate.status, 'blocked', 'regenerate 不得绕过 reference gate')
  assert.equal(regenGate.errorCategory, 'blocked')

  const afterProject = await readJson('project.json')
  const afterStory = await readJson('story.json')
  assert.equal(afterProject.assets.length, beforeAssetCount + 1, 'regenerate 追加新资产而非覆盖')
  const newBinding = afterStory.nodes.find((n) => n.id === 'scene_a').visuals.backgroundAssetId
  assert.notEqual(newBinding, beforeStory.nodes.find((n) => n.id === 'scene_a').visuals.backgroundAssetId)
  assert.equal(afterStory.nodes.find((n) => n.id === 'scene_gate').visuals.backgroundAssetId, undefined)
})

// ---------------------------------------------------------------------------
// S4-03 重启恢复：崩溃瞬间 checkpoint（running）→ 恢复扫描从断点继续，已成功不重复
// ---------------------------------------------------------------------------

test('重启恢复：running 中断场景从 checkpoint 继续，已成功场景不重复执行', async () => {
  // scene_g 成功、scene_h 渲染中“崩溃”（注入永不 resolve 模拟进程死在渲染途中）
  setBackgroundImageGeneratorForTest(async (input) => {
    const prompt = String(input && input.prompt || '')
    const matched = SCENE_IDS.find((sid) => prompt.includes(`summary of ${sid}`))
    renderCalls.push({ sceneId: matched || 'unknown', prompt })
    if (matched === 'scene_h') return new Promise(() => {})
    return { bytes: PNG_BYTES, ext: 'png', meta: { provider: 'test-injected', url: '' } }
  })
  renderCalls.length = 0

  const res = await postBatch({ sceneIds: ['scene_g', 'scene_h'] })
  assert.equal(res.status, 202)

  // 等到真实崩溃瞬间的 checkpoint：scene_g completed、scene_h running（已落盘）
  const crashBatch = await waitFor(async () => {
    const batch = await loadSceneBatch(PROJECT_DIR)
    const g = batch && findItem(batch, 'scene_g')
    const h = batch && findItem(batch, 'scene_h')
    return g && h && g.status === 'completed' && h.status === 'running' ? batch : null
  }, { label: '崩溃瞬间 checkpoint 落盘' })
  assert.equal(crashBatch.status, 'running')
  assert.ok(findItem(crashBatch, 'scene_g').assetPath)

  // 模拟重启：恢复生成器为成功路径，走与启动钩子相同的扫描 + 恢复代码路径
  installSuccessGenerator()
  renderCalls.length = 0
  const interrupted = await findInterruptedSceneBatches(PROJECTS_DIR)
  assert.equal(interrupted.length, 1)
  assert.equal(interrupted[0].projectId, PROJECT_ID)

  const { resumed, batch } = await resumeSceneBatch({ dir: PROJECT_DIR, renderScene: makeTestRenderScene() })
  assert.equal(resumed, true)
  assert.equal(batch.status, 'completed')

  // 已成功场景不重复执行：恢复后生成器只被 scene_h 调用
  assert.deepEqual(renderCalls.map((c) => c.sceneId), ['scene_h'], '已完成的 scene_g 不得重复生成')

  // 中断场景 history 留恢复证据；scene_g checkpoint 原样保留
  const h = findItem(batch, 'scene_h')
  assert.equal(h.status, 'completed')
  assert.ok(h.history.some((x) => x.event === 'resumed'), '中断 running 必须重置并留恢复记录')
  assert.ok(h.assetPath)
  const g = findItem(batch, 'scene_g')
  assert.equal(g.status, 'completed')
  assert.equal(g.assetPath, findItem(crashBatch, 'scene_g').assetPath, '已成功场景 checkpoint 不得被改写')

  // 恢复后回填真实发生
  const story = await readJson('story.json')
  assert.ok(story.nodes.find((n) => n.id === 'scene_g').visuals.backgroundAssetId)
  assert.ok(story.nodes.find((n) => n.id === 'scene_h').visuals.backgroundAssetId)
})

// ---------------------------------------------------------------------------
// 分类表单元断言（C02 同源语义）
// ---------------------------------------------------------------------------

test('classifySceneFailure：gate 阻断 / 临时故障 / 确定性错误分类与 C02 语义一致', () => {
  assert.equal(classifySceneFailure({ httpStatus: 409, error: 'scene_reference_missing' }).category, 'blocked')
  assert.equal(classifySceneFailure({ httpStatus: 409, error: 'reference_file_missing' }).category, 'blocked')
  assert.equal(classifySceneFailure({ httpStatus: 502, error: 'provider_request_failed' }).category, 'retryable')
  assert.equal(classifySceneFailure({ httpStatus: 502, error: 'provider_timeout' }).category, 'retryable')
  assert.equal(classifySceneFailure({ httpStatus: 0, message: 'fetch failed' }).category, 'retryable')
  assert.equal(classifySceneFailure({ httpStatus: 502, error: 'provider_invalid_output' }).category, 'non_retryable')
  assert.equal(classifySceneFailure({ httpStatus: 503, error: 'disabled' }).category, 'non_retryable')
  assert.equal(classifySceneFailure({ httpStatus: 400, error: 'missing_scene_prompt' }).category, 'non_retryable')
  assert.equal(classifySceneFailure({ httpStatus: 418, error: 'weird' }).category, 'non_retryable')
})
