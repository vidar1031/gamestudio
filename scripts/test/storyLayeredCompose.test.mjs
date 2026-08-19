import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// AUTO-E04：背景+立绘分层合成方向的服务端能力测试。
// 覆盖路径：
// - 场景渲染背景-only 模式：prompt 剥离人物/事物、负提示词含人物排除词、不再要求角色锁定引用、
//   已锁定 location 参考图仍作为可选引导进入渲染输入；默认模式（full）既有 E02 门禁语义不变
// - E03 批量端点：mode/backgroundOnly 透传到单场景渲染并随 checkpoint 持久化
// - 立绘 placements 生成端点：默认站位正确、characters[].imageAssetId 同步、幂等不产生重复、
//   未锁定角色跳过并报告、prop 暂不合成如实报告、人工站位保留、导出物含写入后的 story/project
// 环境说明与 E02 相同：STUDIO_ENABLE_TEST_HOOKS 注入底层出图调用，其余链路均为真实实现；
// STUDIO_STORAGE_ROOT 指向临时目录，不触碰真实 storage/projects。

const TMP = await mkdtemp(path.join(os.tmpdir(), 'gs-e04-'))
process.env.STUDIO_STORAGE_ROOT = TMP
process.env.STUDIO_ENABLE_TEST_HOOKS = '1'
process.env.COMFYUI_BASE_URL = 'http://127.0.0.1:9'
process.env.SDWEBUI_BASE_URL = 'http://127.0.0.1:9'

const { buildStorySceneRenderSpec } = await import('../../apps/server/src/ai/storyAssets.js')
const { setBackgroundImageGeneratorForTest } = await import('../../apps/server/src/ai/background.js')
const { default: app } = await import('../../apps/server/src/index.js')

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_B64, 'base64')

const PROJECT_ID = 'proj_e04'
const PROJECT_DIR = path.join(TMP, 'projects', PROJECT_ID)

const LOC_REF_REL = 'assets/ai/story_assets/location/loc_meadow/ref.png'

function makeCharAsset({ id, name, locked, sceneIds, projectCharacterId = '', aliases = [] }) {
  return {
    id,
    name,
    category: 'character',
    lockProfile: 'character_core',
    lockWorkflow: 'character_sheet',
    persistence: 'high',
    renderStrategy: 'ref_required',
    anchorPrompt: `anchor of ${name}`,
    negativePrompt: '',
    aliases,
    forbiddenSubstitutes: [],
    sceneIds,
    sceneCount: sceneIds.length,
    projectCharacterId,
    primaryReferenceAssetId: locked ? `asset_${id}` : '',
    primaryReferenceAssetUri: locked ? `assets/ai/story_assets/character/${id}/ref.png` : '',
    primaryReferenceSelectedAt: locked ? new Date().toISOString() : '',
    referenceStatus: locked ? 'ready' : 'missing',
    generatedRefs: [],
    latestReferenceBatch: [],
    latestReferenceReview: null,
    referencePromptHint: 'single full-body front view'
  }
}

function makeLocAsset({ id, name, sceneIds }) {
  return {
    id,
    name,
    category: 'location',
    lockProfile: 'environment',
    lockWorkflow: 'scene_reference',
    persistence: 'medium',
    renderStrategy: 'optional_ref',
    anchorPrompt: `anchor of ${name}`,
    negativePrompt: '',
    aliases: [],
    forbiddenSubstitutes: [],
    sceneIds,
    sceneCount: sceneIds.length,
    projectCharacterId: '',
    primaryReferenceAssetId: `asset_${id}`,
    primaryReferenceAssetUri: LOC_REF_REL,
    referenceStatus: 'ready',
    generatedRefs: [],
    referencePromptHint: 'wide establishing shot'
  }
}

function makePropAsset({ id, name, sceneIds }) {
  return {
    id,
    name,
    category: 'prop',
    renderStrategy: 'prompt_only',
    anchorPrompt: `anchor of ${name}`,
    aliases: [],
    forbiddenSubstitutes: [],
    sceneIds,
    sceneCount: sceneIds.length,
    referenceStatus: 'missing',
    generatedRefs: []
  }
}

const CHAR_A = makeCharAsset({ id: 'char_a', name: '牧羊人', locked: true, sceneIds: ['scene_s1', 'scene_s2', 'scene_s3'], projectCharacterId: 'ch_shepherd' })
const CHAR_B = makeCharAsset({ id: 'char_b', name: '狼', locked: true, sceneIds: ['scene_s1', 'scene_s2', 'scene_s3'], aliases: ['大灰狼'] })
const CHAR_C = makeCharAsset({ id: 'char_c', name: '村民', locked: false, sceneIds: ['scene_s2'] })
const CHAR_D = makeCharAsset({ id: 'char_d', name: '长者', locked: true, sceneIds: ['scene_s3'] })
const LOC_A = makeLocAsset({ id: 'loc_meadow', name: '牧场', sceneIds: ['scene_s1'] })
const PROP_X = makePropAsset({ id: 'prop_x', name: '木杖', sceneIds: ['scene_s1'] })

function makeSceneEntry({ sceneId, sceneIndex, summary, assets }) {
  return {
    sceneId,
    sceneIndex,
    sceneName: `场景${sceneId}`,
    summary,
    sourceKey: sceneId,
    workflow: 'scene_prompt_only',
    missingRequiredAssetIds: [],
    readyReferenceAssetIds: [],
    assetIds: assets.map((a) => a.id),
    promptAssets: assets
  }
}

async function seedProject() {
  await mkdir(path.join(PROJECT_DIR, 'story-assets'), { recursive: true })
  const plan = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    worldAnchor: 'test world anchor',
    forbiddenSubstitutes: [],
    eventChain: [],
    excludedAssetIds: [],
    assets: [CHAR_A, CHAR_B, CHAR_C, CHAR_D, LOC_A, PROP_X],
    scenes: [
      makeSceneEntry({ sceneId: 'scene_s1', sceneIndex: 1, summary: '清晨的牧场上，牧羊人带着木杖出发，狼在远处窥视。', assets: [CHAR_A, CHAR_B, LOC_A, PROP_X] }),
      makeSceneEntry({ sceneId: 'scene_s2', sceneIndex: 2, summary: '村民们聚集，牧羊人警告大家。', assets: [CHAR_A, CHAR_B, CHAR_C] }),
      makeSceneEntry({ sceneId: 'scene_s3', sceneIndex: 3, summary: '山坡上，牧羊人、狼与长者对峙。', assets: [CHAR_A, CHAR_B, CHAR_D] })
    ],
    summary: {}
  }
  await writeFile(path.join(PROJECT_DIR, 'story-assets', 'plan.json'), JSON.stringify(plan, null, 2))

  const project = {
    schemaVersion: '1.0',
    id: PROJECT_ID,
    title: 'E04 测试项目',
    pluginId: 'story-pixi',
    // 既有角色条目：无 imageAssetId，验证同步更新路径
    characters: [{ id: 'ch_shepherd', name: '牧羊人' }],
    assets: [],
    state: {},
    updatedAt: new Date().toISOString()
  }
  await writeFile(path.join(PROJECT_DIR, 'project.json'), JSON.stringify(project, null, 2))

  const storyNode = (id) => ({ id, kind: 'scene', name: `场景${id}`, body: { title: `场景${id}`, text: '…' }, visuals: { placements: [] }, choices: [] })
  await writeFile(
    path.join(PROJECT_DIR, 'story.json'),
    JSON.stringify({ schemaVersion: '2.0', startNodeId: 'scene_s1', nodes: ['scene_s1', 'scene_s2', 'scene_s3'].map(storyNode) }, null, 2)
  )

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

  // 已锁定 location 参考图真实落盘（角色立绘文件本测试不经文件门禁，无需落盘）
  const locAbs = path.join(PROJECT_DIR, LOC_REF_REL)
  await mkdir(path.dirname(locAbs), { recursive: true })
  await writeFile(locAbs, PNG_BYTES)

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

test.after(async () => {
  setBackgroundImageGeneratorForTest(null)
  await rm(TMP, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 背景-only 模式：renderSpec 纯函数层
// ---------------------------------------------------------------------------

test('背景模式 renderSpec：剥离人物提示词/参考图/引用门禁，负提示词含人物排除词', () => {
  const planDoc = { worldAnchor: 'w', assets: [CHAR_A, CHAR_B, CHAR_C, LOC_A, PROP_X], scenes: [
    makeSceneEntry({ sceneId: 'sx', sceneIndex: 1, summary: '清晨的牧场上，牧羊人带着木杖出发，狼在远处窥视。', assets: [CHAR_A, CHAR_C, LOC_A, PROP_X] })
  ] }
  const spec = buildStorySceneRenderSpec({ plan: planDoc, sceneId: 'sx', mode: 'background' })
  assert.equal(spec.mode, 'background')
  // 未锁定 ref_required 角色（char_c）不再构成门禁缺失
  assert.equal(spec.missingRequiredAssets.length, 0)
  assert.deepEqual(spec.requiredAssetIds, [])
  // 人物/道具锚点不进 promptLocks，location 锚点保留
  assert.ok(!spec.promptLocks.some((line) => line.includes('牧羊人') || line.includes('木杖')))
  assert.ok(spec.promptLocks.some((line) => line.includes('anchor of 牧场')))
  // 已锁定 location 参考图保留（optional_ref 引导），角色参考图剔除
  assert.deepEqual(spec.referenceAssets.map((r) => r.id), ['loc_meadow'])
  // 场景描述剥离人物/道具名（含别名），但保留环境描述
  assert.ok(!spec.backgroundPrompt.includes('牧羊人'), 'backgroundPrompt 不得含角色名')
  assert.ok(!spec.backgroundPrompt.includes('木杖'), 'backgroundPrompt 不得含道具名')
  assert.ok(spec.backgroundPrompt.includes('牧场'), 'backgroundPrompt 必须保留场景环境描述')
  // 负提示词含通用人物排除词
  for (const word of ['person', 'character', 'crowd']) assert.ok(spec.negativePrompt.includes(word), `负提示词缺少 ${word}`)
  // 被剔除对象如实留痕
  assert.deepEqual(spec.excludedSubjects.map((s) => s.id).sort(), ['char_a', 'char_c', 'prop_x'])
})

test('默认模式（full）语义不变：未锁定 ref_required 角色仍触发门禁缺失', () => {
  const planDoc = { worldAnchor: 'w', assets: [CHAR_C, LOC_A], scenes: [
    makeSceneEntry({ sceneId: 'sf', sceneIndex: 1, summary: '村民们聚集。', assets: [CHAR_C, LOC_A] })
  ] }
  const spec = buildStorySceneRenderSpec({ plan: planDoc, sceneId: 'sf' })
  assert.equal(spec.mode, 'full')
  assert.equal(spec.missingRequiredAssets.length, 1)
  assert.equal(spec.missingRequiredAssets[0].id, 'char_c')
  assert.equal(spec.backgroundPrompt, '')
  assert.deepEqual(spec.excludedSubjects, [])
  assert.ok(!spec.negativePrompt.includes('person'))
})

// ---------------------------------------------------------------------------
// 背景-only 模式：路由层（注入生成器捕获真实渲染输入）
// ---------------------------------------------------------------------------

test('背景模式渲染：未锁定角色不阻断，prompt 剥离人物，仅 location 参考图进入输入', async () => {
  let captured = null
  setBackgroundImageGeneratorForTest(async (input) => {
    captured = input
    return { bytes: PNG_BYTES, ext: 'png', meta: { provider: 'test-injected', url: '' } }
  })

  const res = await app.request(`/api/projects/${PROJECT_ID}/ai/story/scenes/scene_s2/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-image-review-mode': 'off' },
    body: JSON.stringify({ mode: 'background' })
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.success, true)
  assert.equal(body.renderSpec.mode, 'background')

  // 渲染输入证据：无角色参考图（scene_s2 无 location 资产），人物名称被剥离
  assert.ok(captured, '注入生成器必须被调用')
  assert.equal(captured.referenceImages.length, 0)
  assert.ok(!captured.prompt.includes('anchor of'), '背景模式 prompt 不得含人物锚点')
  assert.ok(!captured.prompt.includes('牧羊人') && !captured.prompt.includes('村民'), '背景模式 prompt 不得含人物名')
  assert.ok(captured.prompt.includes('test world anchor'))
  assert.ok(captured.negativePrompt.includes('person'))
  setBackgroundImageGeneratorForTest(null)
})

test('同场景默认模式仍阻断：未锁定 ref_required 角色 → 409 scene_reference_missing', async () => {
  const res = await app.request(`/api/projects/${PROJECT_ID}/ai/story/scenes/scene_s2/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-image-review-mode': 'off' },
    body: JSON.stringify({})
  })
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.error, 'scene_reference_missing')
  assert.ok(body.missingRequiredAssets.some((a) => a.id === 'char_c'))
})

// ---------------------------------------------------------------------------
// placements 生成端点
// ---------------------------------------------------------------------------

test('placements 生成：站位正确、characters[].imageAssetId 同步、未锁定跳过、prop 如实报告', async () => {
  const res = await app.request(`/api/projects/${PROJECT_ID}/ai/story/scenes/placements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.success, true)

  // scene_s1：牧羊人 + 狼（2 人站位 0.3/0.7）
  const story = await readJson('story.json')
  const s1 = story.nodes.find((n) => n.id === 'scene_s1')
  assert.equal(s1.visuals.placements.length, 2)
  assert.equal(s1.visuals.placements[0].characterId, 'ch_shepherd')
  assert.equal(s1.visuals.placements[0].imageAssetId, 'asset_char_a')
  // 默认缩放 0.62：立绘原始像素 ≈ 62% 舞台高（无尺寸信息时的回退值），避免 scale=1 铺满舞台
  assert.deepEqual(s1.visuals.placements[0].transform, { x: 0.3, y: 1, scale: 0.62, rotationDeg: 0 })
  assert.equal(s1.visuals.placements[0].zIndex, 1)
  assert.equal(s1.visuals.placements[0].visible, true)
  assert.equal(s1.visuals.placements[1].transform.x, 0.7)
  assert.equal(s1.visuals.placements[1].zIndex, 2)

  // scene_s2：村民未锁定跳过并报告，仅 牧羊人 + 狼
  const s2 = story.nodes.find((n) => n.id === 'scene_s2')
  assert.equal(s2.visuals.placements.length, 2)
  assert.ok(body.skippedCharacters.some((x) => x.sceneId === 'scene_s2' && x.assetId === 'char_c' && x.reason === 'reference_not_locked'))

  // scene_s3：3 人站位 0.25/0.5/0.75
  const s3 = story.nodes.find((n) => n.id === 'scene_s3')
  assert.equal(s3.visuals.placements.length, 3)
  assert.deepEqual(s3.visuals.placements.map((p) => p.transform.x), [0.25, 0.5, 0.75])

  // project.json：既有角色更新 imageAssetId；狼/长者补建角色条目并同步立绘
  const project = await readJson('project.json')
  const shepherd = project.characters.find((ch) => ch.id === 'ch_shepherd')
  assert.equal(shepherd.imageAssetId, 'asset_char_a')
  const wolf = project.characters.find((ch) => ch.name === '狼')
  assert.ok(wolf, '狼必须补建角色条目')
  assert.equal(wolf.imageAssetId, 'asset_char_b')
  assert.equal(s1.visuals.placements[1].characterId, wolf.id)

  // 计划回写：补建角色的 projectCharacterId 真实落盘
  const plan = await readJson('story-assets/plan.json')
  assert.equal(plan.assets.find((a) => a.id === 'char_b').projectCharacterId, wolf.id)

  // prop 暂不合成：如实报告（已知限制）
  assert.ok(body.skippedProps.some((x) => x.assetId === 'prop_x' && x.reason === 'prop_not_composited'))
})

test('placements 幂等：重复调用不产生重复 placements，人工站位保留', async () => {
  const before = await readJson('story.json')
  // 模拟编辑器人工调整站位后再调用：既站位必须保留
  before.nodes.find((n) => n.id === 'scene_s1').visuals.placements[0].transform.x = 0.42
  await writeFile(path.join(PROJECT_DIR, 'story.json'), JSON.stringify(before, null, 2))

  const res = await app.request(`/api/projects/${PROJECT_ID}/ai/story/scenes/placements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.success, true)
  assert.equal(body.summary.placementsCreated, 0, '二次调用不得再创建 placement')

  const after = await readJson('story.json')
  assert.deepEqual(after, before, '二次调用后 story.json 必须保持不变（幂等）')
  const s1 = after.nodes.find((n) => n.id === 'scene_s1')
  assert.equal(s1.visuals.placements.length, 2)
  assert.equal(s1.visuals.placements[0].transform.x, 0.42, '人工调整的站位必须保留')
})

test('placements 指定子集与未知场景：sceneIds 过滤生效，未知 id → 404', async () => {
  // 先清掉 scene_s3 的 placements，仅对该场景重跑
  const story = await readJson('story.json')
  story.nodes.find((n) => n.id === 'scene_s3').visuals.placements = []
  await writeFile(path.join(PROJECT_DIR, 'story.json'), JSON.stringify(story, null, 2))

  const res = await app.request(`/api/projects/${PROJECT_ID}/ai/story/scenes/placements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneIds: ['scene_s3'] })
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.scenes.map((s) => s.sceneId), ['scene_s3'])
  const after = await readJson('story.json')
  assert.equal(after.nodes.find((n) => n.id === 'scene_s3').visuals.placements.length, 3)

  const bad = await app.request(`/api/projects/${PROJECT_ID}/ai/story/scenes/placements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneIds: ['scene_nope'] })
  })
  assert.equal(bad.status, 404)
  assert.equal((await bad.json()).error, 'scene_not_found')
})

// ---------------------------------------------------------------------------
// E03 批量端点：背景模式透传 + checkpoint 持久化
// ---------------------------------------------------------------------------

test('批量渲染透传背景模式：checkpoint 持久化 mode，单场景渲染收到背景模式输入', async () => {
  // scene_s1 尚未绑定背景图（前面 placements 不写 backgroundAssetId），可进入批量
  let captured = null
  setBackgroundImageGeneratorForTest(async (input) => {
    captured = input
    return { bytes: PNG_BYTES, ext: 'png', meta: { provider: 'test-injected', url: '' } }
  })

  const res = await app.request(`/api/projects/${PROJECT_ID}/ai/story/scenes/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-image-review-mode': 'off' },
    body: JSON.stringify({ sceneIds: ['scene_s1'], mode: 'background' })
  })
  assert.equal(res.status, 202)
  const submit = await res.json()
  assert.equal(submit.success, true)

  // 轮询批次直至终态
  let batch = null
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    batch = (await (await app.request(`/api/projects/${PROJECT_ID}/ai/story/scenes/batch`)).json()).batch
    if (batch && batch.items.every((it) => ['completed', 'failed', 'blocked', 'skipped', 'waiting_review'].includes(it.status))) break
  }
  assert.ok(batch, '批次必须存在')
  assert.equal(batch.items[0].status, 'completed', `批量渲染必须成功，实际 ${batch.items[0].status} ${batch.items[0].error || ''}`)
  assert.equal(batch.options.mode, 'background', '模式必须随 checkpoint 持久化')

  // 单场景渲染真实收到背景模式输入：人物锚点/名称剥离，location 参考图保留
  assert.ok(captured)
  assert.deepEqual(captured.referenceImages.map((r) => r.role), ['location'])
  assert.ok(!captured.prompt.includes('牧羊人') && !captured.prompt.includes('anchor of 牧羊人'))
  assert.ok(captured.prompt.includes('anchor of 牧场'))
  assert.ok(captured.negativePrompt.includes('person'))

  // 背景图绑定不破坏既有 placements
  const story = await readJson('story.json')
  const s1 = story.nodes.find((n) => n.id === 'scene_s1')
  assert.ok(s1.visuals.backgroundAssetId, '背景图必须绑定')
  assert.equal(s1.visuals.placements.length, 2, 'placements 必须保留')
  setBackgroundImageGeneratorForTest(null)
})

// ---------------------------------------------------------------------------
// 导出兼容：dist 含写入后的 story.json / project.json
// ---------------------------------------------------------------------------

test('导出兼容：dist 包包含 placements 与 characters[].imageAssetId', async () => {
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
  const distS1 = distStory.nodes.find((n) => n.id === 'scene_s1')
  assert.equal(distS1.visuals.placements.length, 2, '导出 story.json 必须含 placements')
  assert.ok(distS1.visuals.backgroundAssetId, '导出 story.json 必须含背景绑定')
  const distProject = JSON.parse(await readFile(path.join(distDir, 'project.json'), 'utf-8'))
  assert.equal(distProject.characters.find((ch) => ch.id === 'ch_shepherd').imageAssetId, 'asset_char_a')
})
