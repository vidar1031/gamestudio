import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// AUTO-E02 / S4-02：锁定资产到场景渲染闭环。
// 覆盖路径：
// - 缺引用：场景含 ref_required 但未锁定的资产 → 409 scene_reference_missing（BLOCKED），禁止降级无参考生成
// - 锁定引用文件不真实 → 409 reference_file_missing（BLOCKED），不静默丢弃
// - 成功：合法 reference 进入渲染输入（断言输入装配内容），产物真实落盘并回填 story/project，
//   且通过 validate 与 export（真实 dist 证据）
// - 失败隔离：渲染失败 / scene_bind 绑定失败不污染已成功场景的资产与数据
// 环境说明：ComfyUI/SD-WebUI 不可达，底层 provider 调用经 STUDIO_ENABLE_TEST_HOOKS 注入替代；
// 注入函数仅返回真实 PNG 夹具字节，其后的 sniff/落盘/回填/validate/export 均为真实实现。
// 环境隔离：STUDIO_STORAGE_ROOT 指向临时目录，不触碰真实 storage/projects。

const TMP = await mkdtemp(path.join(os.tmpdir(), 'gs-e02-'))
process.env.STUDIO_STORAGE_ROOT = TMP
process.env.STUDIO_ENABLE_TEST_HOOKS = '1'
// 指向必然拒绝连接的回环地址，保证未注入时 provider 失败快速且确定
process.env.COMFYUI_BASE_URL = 'http://127.0.0.1:9'
process.env.SDWEBUI_BASE_URL = 'http://127.0.0.1:9'

const { buildStorySceneRenderSpec } = await import('../../apps/server/src/ai/storyAssets.js')
const { setBackgroundImageGeneratorForTest } = await import('../../apps/server/src/ai/background.js')
const { verifyStoryAssetReferenceFile, sniffImageMetaFromBytes } = await import('../../apps/server/src/ai/storyAssetReferenceGate.js')
const { default: app } = await import('../../apps/server/src/index.js')

// 1x1 透明 PNG（真实图片字节）
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_B64, 'base64')

const PROJECT_ID = 'proj_e02'
const PROJECT_DIR = path.join(TMP, 'projects', PROJECT_ID)
const PLAN_PATH = path.join(PROJECT_DIR, 'story-assets', 'plan.json')

const LOCKED_REF_REL = 'assets/ai/story_assets/char.locked/ref.png'
const BROKEN_REF_REL = 'assets/ai/story_assets/char.broken/ref.png'

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
    sceneIds: ['scene_a'],
    sceneCount: 1,
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

const ASSET_LOCKED = makePlanAsset({ id: 'char.locked', referenceStatus: 'ready', uri: LOCKED_REF_REL })
const ASSET_UNLOCKED = makePlanAsset({ id: 'char.unlocked', referenceStatus: 'missing', uri: '' })
const ASSET_BROKEN = makePlanAsset({ id: 'char.broken', referenceStatus: 'ready', uri: BROKEN_REF_REL })

async function seedProject() {
  await mkdir(path.join(PROJECT_DIR, 'story-assets'), { recursive: true })
  const plan = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    worldAnchor: 'test world anchor',
    forbiddenSubstitutes: [],
    eventChain: [],
    excludedAssetIds: [],
    assets: [ASSET_LOCKED, ASSET_UNLOCKED, ASSET_BROKEN],
    scenes: [
      makeSceneEntry({ sceneId: 'scene_a', sceneIndex: 1, assets: [ASSET_LOCKED] }),
      makeSceneEntry({ sceneId: 'scene_b', sceneIndex: 2, assets: [ASSET_UNLOCKED] }),
      makeSceneEntry({ sceneId: 'scene_c', sceneIndex: 3, assets: [ASSET_BROKEN] }),
      makeSceneEntry({ sceneId: 'scene_d', sceneIndex: 4, assets: [ASSET_LOCKED] }),
      // 存量快照与 live 状态不一致：快照说缺失，但资产已锁定 → 以 live 判定为准
      { ...makeSceneEntry({ sceneId: 'scene_e', sceneIndex: 5, assets: [ASSET_LOCKED] }), missingRequiredAssetIds: ['char.locked'] }
    ],
    summary: {}
  }
  await writeFile(PLAN_PATH, JSON.stringify(plan, null, 2))

  const project = {
    schemaVersion: '1.0',
    id: PROJECT_ID,
    name: 'E02 测试项目',
    characters: [],
    assets: [],
    state: {},
    updatedAt: new Date().toISOString()
  }
  await writeFile(path.join(PROJECT_DIR, 'project.json'), JSON.stringify(project, null, 2))

  const storyNode = (id) => ({ id, kind: 'scene', name: `场景${id}`, body: { title: `场景${id}`, text: '…' }, visuals: {}, choices: [] })
  await writeFile(
    path.join(PROJECT_DIR, 'story.json'),
    JSON.stringify({ schemaVersion: '2.0', startNodeId: 'scene_a', nodes: ['scene_a', 'scene_b', 'scene_c', 'scene_d', 'scene_e'].map(storyNode) }, null, 2)
  )

  // 可通过 validate 的 blueprint：一个场景节点 + 一个可达结局
  await writeFile(
    path.join(PROJECT_DIR, 'blueprint.json'),
    JSON.stringify(
      {
        schemaVersion: '1.0',
        startNodeId: 'bp_scene',
        placeholders: [],
        nodes: [
          { id: 'bp_scene', kind: 'scene', name: '开场', choices: [{ id: 'c1', text: '继续', toNodeId: 'bp_end' }] },
          { id: 'bp_end', kind: 'ending', name: '结局', choices: [] }
        ],
        updatedAt: new Date().toISOString()
      },
      null,
      2
    )
  )

  // 已锁定的参考图真实落盘（broken 刻意不落盘）
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

function postRender(sceneId, { reviewMode = 'off' } = {}) {
  return app.request(`/api/projects/${PROJECT_ID}/ai/story/scenes/${sceneId}/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-image-review-mode': reviewMode },
    body: JSON.stringify({})
  })
}

async function appendReview(review) {
  const reviewsPath = path.join(PROJECT_DIR, 'reviews', 'image_reviews.jsonl')
  await mkdir(path.dirname(reviewsPath), { recursive: true })
  const line = JSON.stringify({
    schemaVersion: '1.0',
    phase: 'scene_bind',
    assetId: '',
    prompt: 'p',
    negativePrompt: 'n',
    referenceImages: [],
    params: {},
    execute: null,
    aiReview: null,
    status: 'pending',
    createdAt: new Date().toISOString(),
    decidedAt: '',
    decidedBy: '',
    rejectReason: '',
    ...review
  })
  await writeFile(reviewsPath, `${line}\n`, { flag: 'a' })
  return review.reviewId
}

test.after(async () => {
  setBackgroundImageGeneratorForTest(null)
  await rm(TMP, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// renderSpec live 判定：存量快照不可信，以当前计划资产状态为准
// ---------------------------------------------------------------------------

test('buildStorySceneRenderSpec：ref_required 未锁定实时判为缺失，已锁定不误判', () => {
  const planDoc = {
    worldAnchor: 'w',
    assets: [ASSET_LOCKED, ASSET_UNLOCKED],
    scenes: [
      makeSceneEntry({ sceneId: 's_missing', sceneIndex: 1, assets: [ASSET_UNLOCKED] }),
      { ...makeSceneEntry({ sceneId: 's_ready', sceneIndex: 2, assets: [ASSET_LOCKED] }), missingRequiredAssetIds: ['char.locked'] }
    ]
  }
  const missing = buildStorySceneRenderSpec({ plan: planDoc, sceneId: 's_missing' })
  assert.equal(missing.missingRequiredAssetIds.length, 1)
  assert.equal(missing.missingRequiredAssets[0].id, 'char.unlocked')
  assert.equal(missing.missingRequiredAssets[0].reason, 'reference_not_locked')

  // 存量快照 missingRequiredAssetIds=['char.locked'] 与 live 就绪状态冲突时，以 live 为准
  const ready = buildStorySceneRenderSpec({ plan: planDoc, sceneId: 's_ready' })
  assert.equal(ready.missingRequiredAssetIds.length, 0)
  assert.equal(ready.missingRequiredAssets.length, 0)
  assert.deepEqual(ready.requiredAssetIds, ['char.locked'])
})

// ---------------------------------------------------------------------------
// S4-02 缺引用阻断：明确 BLOCKED，禁止降级为无参考生成
// ---------------------------------------------------------------------------

test('缺引用阻断：ref_required 未锁定 → 409 scene_reference_missing，项目数据零写入', async () => {
  const beforeProject = await readJson('project.json')
  const beforeStory = await readJson('story.json')
  const res = await postRender('scene_b')
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.success, false)
  assert.equal(body.error, 'scene_reference_missing')
  assert.ok(body.missingRequiredAssets.some((a) => a.id === 'char.unlocked'), '必须列出缺失资产')
  assert.ok(String(body.message || '').includes('char.unlocked'))

  assert.deepEqual(await readJson('project.json'), beforeProject)
  assert.deepEqual(await readJson('story.json'), beforeStory)

  // 任务进度可见 blocked 状态
  const tasks = await (await app.request(`/api/projects/${PROJECT_ID}/ai/tasks`)).json()
  const blocked = tasks.tasks.find((t) => t.taskId === body.taskId)
  assert.ok(blocked, '阻断场景必须有任务记录')
  assert.equal(blocked.stage, 'blocked')
})

test('锁定引用文件不真实：磁盘无文件 → 409 reference_file_missing，不静默丢弃参考', async () => {
  const beforeProject = await readJson('project.json')
  const res = await postRender('scene_c')
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.success, false)
  assert.equal(body.error, 'reference_file_missing')
  assert.equal(body.reference.assetId, 'char.broken')
  assert.deepEqual(await readJson('project.json'), beforeProject)
})

// ---------------------------------------------------------------------------
// S4-02 成功路径：合法 reference 进入渲染输入，产物回填并通过 validate/export
// ---------------------------------------------------------------------------

test('成功路径：reference 传入渲染输入，产物真实落盘回填，validate/export 通过', async () => {
  let captured = null
  setBackgroundImageGeneratorForTest(async (input) => {
    captured = input
    return { bytes: PNG_BYTES, ext: 'png', meta: { provider: 'test-injected', url: '' } }
  })

  const res = await postRender('scene_a')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.success, true)

  // 渲染输入装配证据：锁定参考图真实字节进入 referenceImages
  assert.ok(captured, '注入生成器必须被调用')
  assert.equal(captured.referenceImages.length, 1)
  const refInput = captured.referenceImages[0]
  assert.equal(refInput.role, 'character')
  assert.equal(refInput.assetName, ASSET_LOCKED.name)
  assert.equal(refInput.weight, 0.9)
  assert.ok(Buffer.from(refInput.bytes).equals(PNG_BYTES), '渲染输入必须携带锁定参考图的真实字节')
  assert.equal(captured.continuity.ipadapterEnabled, true)
  assert.ok(String(captured.prompt).includes('test world anchor'), 'prompt 必须包含 worldAnchor')
  assert.ok(String(captured.prompt).includes(`anchor of ${ASSET_LOCKED.id}`), 'prompt 必须包含资产锚点')

  // 响应携带输入证据
  assert.equal(body.referencesUsed.length, 1)
  assert.equal(body.referencesUsed[0].assetId, 'char.locked')
  assert.equal(body.referencesUsed[0].assetPath, LOCKED_REF_REL)

  // 产物真实落盘且为有效图片
  const sceneFile = await verifyStoryAssetReferenceFile({ dir: PROJECT_DIR, assetPath: body.assetPath })
  assert.equal(sceneFile.ok, true)
  assert.equal(sniffImageMetaFromBytes(await readFile(sceneFile.absPath)).ext, 'png')

  // 回填：story 节点绑定 + project assets 索引 + 引用证据
  const story = await readJson('story.json')
  const node = story.nodes.find((n) => n.id === 'scene_a')
  assert.equal(node.visuals.backgroundAssetId, body.projectAsset.id)
  const project = await readJson('project.json')
  const indexed = project.assets.find((a) => a.id === body.projectAsset.id)
  assert.ok(indexed, '场景图资产必须写入项目 assets 索引')
  assert.equal(indexed.uri, body.assetPath)
  assert.equal(indexed.source.references.length, 1)
  assert.equal(indexed.source.references[0].assetId, 'char.locked')

  // validate 通过
  const validateRes = await app.request(`/api/projects/${PROJECT_ID}/validate/blueprint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
  assert.equal(validateRes.status, 200)
  const validation = (await validateRes.json()).validation
  assert.equal(validation.ok, true)
  assert.equal(validation.errors.length, 0)

  // export 通过：dist 含 story/project/场景图真实文件
  const exportRes = await app.request(`/api/projects/${PROJECT_ID}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
  assert.equal(exportRes.status, 200)
  const exportBody = await exportRes.json()
  assert.equal(exportBody.success, true)
  const distDir = path.join(PROJECT_DIR, 'builds', String(exportBody.buildId), 'dist')
  const distStory = JSON.parse(await readFile(path.join(distDir, 'story.json'), 'utf-8'))
  assert.equal(distStory.nodes.find((n) => n.id === 'scene_a').visuals.backgroundAssetId, body.projectAsset.id)
  const distSceneFile = await readFile(path.join(distDir, body.assetPath))
  assert.equal(sniffImageMetaFromBytes(distSceneFile).ext, 'png', '导出包必须包含真实场景图文件')
})

// ---------------------------------------------------------------------------
// S4-02 失败隔离：渲染失败不污染已成功场景的资产与数据
// ---------------------------------------------------------------------------

test('渲染失败隔离：provider 失败显式 FAIL，已成功场景绑定与资产不被污染', async () => {
  const beforeProject = await readJson('project.json')
  const beforeStory = await readJson('story.json')
  assert.ok(beforeStory.nodes.find((n) => n.id === 'scene_a').visuals.backgroundAssetId, '前置：scene_a 已成功绑定')

  setBackgroundImageGeneratorForTest(async () => {
    const e = new Error('provider unreachable (injected)')
    e.status = 502
    throw e
  })
  const res = await postRender('scene_d')
  assert.ok(res.status >= 500, `渲染失败必须显式 FAIL，实际状态 ${res.status}`)
  const body = await res.json()
  assert.equal(body.success, false)
  assert.ok(body.error, '必须携带错误码')

  // scene_d 无绑定；scene_a 绑定与项目资产完全不变
  assert.deepEqual(await readJson('project.json'), beforeProject)
  assert.deepEqual(await readJson('story.json'), beforeStory)

  // 失败场景不产生新文件之外的写入：plan 引用保持一致
  const plan = await readJson('story-assets/plan.json')
  assert.equal(plan.assets.find((a) => a.id === 'char.locked').primaryReferenceAssetUri, LOCKED_REF_REL)

  setBackgroundImageGeneratorForTest(null)
})

// ---------------------------------------------------------------------------
// S4-02 scene_bind 审核：文件真实性校验补强，失败保持 pending 不消费
// ---------------------------------------------------------------------------

test('scene_bind approve：结果文件缺失显式失败，审核保持 pending，不绑定', async () => {
  const beforeProject = await readJson('project.json')
  const beforeStory = await readJson('story.json')
  const missingRel = 'assets/ai/story_scenes/scene_x_missing.png'
  const reviewId = await appendReview({
    reviewId: 'imgrev_e02_bind_missing',
    targetKey: `scene_bind:scene_x:${missingRel}`,
    sceneId: 'scene_x',
    resultImagePath: missingRel,
    params: { sceneName: '场景X', references: [{ assetId: 'char.locked', assetPath: LOCKED_REF_REL }] }
  })
  const res = await app.request(`/api/projects/${PROJECT_ID}/ai/reviews/${reviewId}/approve`, { method: 'POST' })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.success, false)
  assert.equal(body.error, 'reference_file_missing')

  const pending = await (await app.request(`/api/projects/${PROJECT_ID}/ai/reviews?status=pending`)).json()
  assert.ok(pending.reviews.some((item) => item.reviewId === reviewId), '失败的审核必须保持 pending，不得被消费')
  assert.deepEqual(await readJson('project.json'), beforeProject)
  assert.deepEqual(await readJson('story.json'), beforeStory)
})

test('scene_bind approve：文件真实存在时绑定成功，引用证据随资产持久化', async () => {
  const rel = 'assets/ai/story_scenes/scene_b_manual.png'
  const abs = path.join(PROJECT_DIR, rel)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, PNG_BYTES)
  const reviewId = await appendReview({
    reviewId: 'imgrev_e02_bind_ok',
    targetKey: `scene_bind:scene_b:${rel}`,
    sceneId: 'scene_b',
    resultImagePath: rel,
    params: { sceneName: '场景scene_b', references: [{ assetId: 'char.locked', assetName: ASSET_LOCKED.name, category: 'character', assetPath: LOCKED_REF_REL }] }
  })
  const res = await app.request(`/api/projects/${PROJECT_ID}/ai/reviews/${reviewId}/approve`, { method: 'POST' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.success, true)
  assert.equal(body.review.status, 'approved')

  const story = await readJson('story.json')
  assert.equal(story.nodes.find((n) => n.id === 'scene_b').visuals.backgroundAssetId, body.projectAsset.id)
  const project = await readJson('project.json')
  const indexed = project.assets.find((a) => a.id === body.projectAsset.id)
  assert.equal(indexed.uri, rel)
  assert.equal(indexed.source.references[0].assetId, 'char.locked')
})

test('scene_bind reject：人工拒绝不绑定，项目数据不变', async () => {
  const beforeProject = await readJson('project.json')
  const beforeStory = await readJson('story.json')
  const rel = 'assets/ai/story_scenes/scene_b_manual.png'
  const reviewId = await appendReview({
    reviewId: 'imgrev_e02_bind_reject',
    targetKey: `scene_bind:scene_b:${rel}:reject`,
    sceneId: 'scene_b',
    resultImagePath: rel,
    params: { sceneName: '场景scene_b' }
  })
  const res = await app.request(`/api/projects/${PROJECT_ID}/ai/reviews/${reviewId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: '场景氛围不符' })
  })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).review.status, 'rejected')
  assert.deepEqual(await readJson('project.json'), beforeProject)
  assert.deepEqual(await readJson('story.json'), beforeStory)
})
