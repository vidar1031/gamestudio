import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// AUTO-E01 / S4-01：角色锁定图仅在「真实文件存在」且「视觉评审通过」时写入 primaryReferenceAssetUri。
// 覆盖路径：
// - 成功：夹具图片 + 真实评审通过 → 引用写入，资产记录/文件/schema 引用一致
// - 评审未通过 / 评审被跳过（兜底假通过）/ 无评审记录 → BLOCKED（409），不写引用
// - 文件缺失 / 空文件 / 非图片 → FAIL（400），不写引用
// - provider 未启用 / 不可达 → 生成显式 FAIL，不产生候选与引用
// - lock_confirm approve：文件缺失显式失败且审核保持 pending；文件存在才落锁
// 环境隔离：STUDIO_STORAGE_ROOT 指向临时目录，不触碰真实 storage/projects。

const TMP = await mkdtemp(path.join(os.tmpdir(), 'gs-e01-'))
process.env.STUDIO_STORAGE_ROOT = TMP
// 指向必然拒绝连接的回环地址，保证 postprocess/provider 失败快速且确定
process.env.COMFYUI_BASE_URL = 'http://127.0.0.1:9'
process.env.SDWEBUI_BASE_URL = 'http://127.0.0.1:9'

const {
  evaluateStoryAssetReferenceReview,
  sniffImageMetaFromBytes,
  verifyStoryAssetReferenceFile
} = await import('../../apps/server/src/ai/storyAssetReferenceGate.js')
const { default: app } = await import('../../apps/server/src/index.js')

// 1x1 透明 PNG（真实图片字节）
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_B64, 'base64')

const PROJECT_ID = 'proj_e01'
const PROJECT_DIR = path.join(TMP, 'projects', PROJECT_ID)
const PLAN_PATH = path.join(PROJECT_DIR, 'story-assets', 'plan.json')

function relOf(assetId, name) {
  return `assets/ai/story_assets/${assetId}/${name}.png`
}

function passedAnalysis(rel) {
  return {
    reviewedAt: new Date().toISOString(),
    targetAssetUri: rel,
    passed: true,
    score: 92,
    summary: '主体、白底、单视角均符合要求',
    issues: [],
    skipped: false
  }
}

// 构造一个待选角色资产：候选批次 + 生成记录 + 项目资产 + 磁盘文件（可选）
function makeCharacterAsset({ assetId, projectCharacterId, rel, analysis, withGeneratedRef = true }) {
  return {
    id: assetId,
    name: `角色${assetId}`,
    category: 'character',
    lockProfile: 'character_core',
    lockWorkflow: 'character_sheet',
    persistence: 'high',
    renderStrategy: 'ref_required',
    anchorPrompt: 'a cute fox, full body',
    negativePrompt: '',
    aliases: [],
    sceneIds: ['scene_1'],
    sceneCount: 1,
    projectCharacterId: projectCharacterId || '',
    primaryReferenceAssetId: '',
    primaryReferenceAssetUri: '',
    referenceStatus: 'candidates_ready',
    generatedRefs: withGeneratedRef
      ? [{ projectAssetId: `asset_${assetId}`, projectAssetUri: rel, createdAt: new Date().toISOString(), prompt: 'p', negativePrompt: 'n' }]
      : [],
    latestReferenceBatch: [{ attempt: 1, seed: 1, assetPath: rel, url: `/project-assets/${PROJECT_ID}/${rel}`, ...(analysis ? { analysis } : {}) }],
    latestReferenceReview: null,
    referencePromptHint: 'single full-body front view'
  }
}

const ASSETS = {
  ok: { assetId: 'char.ok', rel: relOf('char.ok', 'ref') },
  reviewFail: { assetId: 'char.reviewfail', rel: relOf('char.reviewfail', 'ref') },
  skipped: { assetId: 'char.skipped', rel: relOf('char.skipped', 'ref') },
  noRecord: { assetId: 'char.norecord', rel: relOf('char.norecord', 'ref') },
  fileMissing: { assetId: 'char.filemissing', rel: relOf('char.filemissing', 'ref') },
  genFail: { assetId: 'char.genfail', rel: relOf('char.genfail', 'ref') },
  lock: { assetId: 'char.lock', rel: relOf('char.lock', 'lock_test') },
  lockMissing: { assetId: 'char.lockmissing', rel: relOf('char.lockmissing', 'lock_test') }
}

async function seedProject() {
  await mkdir(path.join(PROJECT_DIR, 'story-assets'), { recursive: true })
  const planAssets = [
    makeCharacterAsset({ assetId: ASSETS.ok.assetId, projectCharacterId: 'pc_ok', rel: ASSETS.ok.rel, analysis: passedAnalysis(ASSETS.ok.rel) }),
    makeCharacterAsset({
      assetId: ASSETS.reviewFail.assetId,
      rel: ASSETS.reviewFail.rel,
      analysis: { ...passedAnalysis(ASSETS.reviewFail.rel), passed: false, score: 35, summary: '出现多视角拼贴' }
    }),
    // 兜底假通过：passed=true 但 skipped=true（视觉评审未真实执行）
    makeCharacterAsset({
      assetId: ASSETS.skipped.assetId,
      rel: ASSETS.skipped.rel,
      analysis: { ...passedAnalysis(ASSETS.skipped.rel), skipped: true, summary: '未启用视觉判定，已生成测试图，请人工确认。' }
    }),
    makeCharacterAsset({ assetId: ASSETS.noRecord.assetId, rel: ASSETS.noRecord.rel, analysis: null }),
    makeCharacterAsset({ assetId: ASSETS.fileMissing.assetId, rel: ASSETS.fileMissing.rel, analysis: passedAnalysis(ASSETS.fileMissing.rel) }),
    {
      ...makeCharacterAsset({ assetId: ASSETS.genFail.assetId, rel: ASSETS.genFail.rel, analysis: null, withGeneratedRef: false }),
      latestReferenceBatch: [],
      referenceStatus: 'missing'
    },
    { ...makeCharacterAsset({ assetId: ASSETS.lock.assetId, rel: ASSETS.lock.rel, analysis: null }), latestReferenceBatch: [], referenceStatus: 'missing' },
    { ...makeCharacterAsset({ assetId: ASSETS.lockMissing.assetId, rel: ASSETS.lockMissing.rel, analysis: null }), latestReferenceBatch: [], referenceStatus: 'missing' }
  ]
  const plan = {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    worldAnchor: 'test world',
    forbiddenSubstitutes: [],
    eventChain: [],
    excludedAssetIds: [],
    assets: planAssets,
    scenes: [],
    summary: {}
  }
  await writeFile(PLAN_PATH, JSON.stringify(plan, null, 2))

  const project = {
    schemaVersion: '1.0',
    id: PROJECT_ID,
    name: 'E01 测试项目',
    characters: [{ id: 'pc_ok', name: '角色char.ok', profile: {}, ai: {} }],
    assets: [{ id: `asset_${ASSETS.ok.assetId}`, kind: 'image', name: '故事资产 角色char.ok', uri: ASSETS.ok.rel }],
    state: {},
    updatedAt: new Date().toISOString()
  }
  await writeFile(path.join(PROJECT_DIR, 'project.json'), JSON.stringify(project, null, 2))
  await writeFile(path.join(PROJECT_DIR, 'story.json'), JSON.stringify({ schemaVersion: '2.0', startNodeId: 'start', nodes: [] }, null, 2))

  // 真实存在的候选文件（fileMissing / lockMissing 刻意不落盘）
  for (const key of ['ok', 'reviewFail', 'skipped', 'noRecord', 'lock']) {
    const abs = path.join(PROJECT_DIR, ASSETS[key].rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, PNG_BYTES)
  }
}

await seedProject()

async function readPlanAsset(assetId) {
  const plan = JSON.parse(await readFile(PLAN_PATH, 'utf-8'))
  return plan.assets.find((a) => a.id === assetId) || null
}

async function readProject() {
  return JSON.parse(await readFile(path.join(PROJECT_DIR, 'project.json'), 'utf-8'))
}

function postSelect(assetId, assetPath) {
  return app.request(`/api/projects/${PROJECT_ID}/ai/story/assets/reference/select`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId, assetPath })
  })
}

test.after(async () => {
  await rm(TMP, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 门禁单元语义
// ---------------------------------------------------------------------------

test('verifyStoryAssetReferenceFile：有效 PNG 文件通过校验', async () => {
  const result = await verifyStoryAssetReferenceFile({ dir: PROJECT_DIR, assetPath: ASSETS.ok.rel })
  assert.equal(result.ok, true)
  assert.equal(result.sniff.ext, 'png')
})

test('verifyStoryAssetReferenceFile：缺失/空/非图片/越界分别显式失败', async () => {
  const missing = await verifyStoryAssetReferenceFile({ dir: PROJECT_DIR, assetPath: ASSETS.fileMissing.rel })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'reference_file_missing')

  const emptyRel = relOf('char.ok', 'empty')
  await writeFile(path.join(PROJECT_DIR, emptyRel), Buffer.alloc(0))
  const empty = await verifyStoryAssetReferenceFile({ dir: PROJECT_DIR, assetPath: emptyRel })
  assert.equal(empty.code, 'reference_file_empty')

  const textRel = relOf('char.ok', 'text')
  await writeFile(path.join(PROJECT_DIR, textRel), 'not an image')
  const invalid = await verifyStoryAssetReferenceFile({ dir: PROJECT_DIR, assetPath: textRel })
  assert.equal(invalid.code, 'reference_file_invalid')

  const outside = await verifyStoryAssetReferenceFile({ dir: PROJECT_DIR, assetPath: '../outside.png' })
  assert.equal(outside.code, 'reference_path_outside_project')
})

test('evaluateStoryAssetReferenceReview：通过/未通过/跳过/无记录四种判定', () => {
  assert.equal(evaluateStoryAssetReferenceReview(passedAnalysis('x.png')).passed, true)
  assert.equal(evaluateStoryAssetReferenceReview({ passed: false, score: 30, skipped: false }).code, 'review_not_passed')
  // 兜底假通过（passed=true 但 skipped=true）不得视为评审通过
  assert.equal(evaluateStoryAssetReferenceReview({ passed: true, score: 60, skipped: true }).code, 'review_unavailable')
  assert.equal(evaluateStoryAssetReferenceReview(null).code, 'review_record_missing')
})

test('sniffImageMetaFromBytes：识别 PNG，拒绝非图片字节', () => {
  assert.equal(sniffImageMetaFromBytes(PNG_BYTES).ext, 'png')
  assert.equal(sniffImageMetaFromBytes(Buffer.from('hello world')), null)
  assert.equal(sniffImageMetaFromBytes(Buffer.alloc(0)), null)
})

// ---------------------------------------------------------------------------
// S4-01 成功路径：评审通过 + 文件真实存在 → 写入引用且三方一致
// ---------------------------------------------------------------------------

test('成功路径：select 写入 primaryReferenceAssetUri，资产记录/文件/schema 引用一致', async () => {
  const res = await postSelect(ASSETS.ok.assetId, ASSETS.ok.rel)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.success, true)

  // 计划内引用
  const asset = await readPlanAsset(ASSETS.ok.assetId)
  assert.equal(asset.primaryReferenceAssetUri, ASSETS.ok.rel)
  assert.equal(asset.referenceStatus, 'ready')
  assert.ok(asset.primaryReferenceSelectedAt)
  // 评审记录可追溯
  assert.equal(asset.latestReferenceReview.passed, true)

  // 文件真实存在且为有效图片
  const check = await verifyStoryAssetReferenceFile({ dir: PROJECT_DIR, assetPath: asset.primaryReferenceAssetUri })
  assert.equal(check.ok, true)

  // 项目 schema：角色 ai.referenceAssetId 与 assets 索引一致
  const project = await readProject()
  const character = project.characters.find((ch) => ch.id === 'pc_ok')
  assert.equal(character.ai.referenceAssetId, asset.primaryReferenceAssetId)
  const indexed = project.assets.find((a) => a.id === asset.primaryReferenceAssetId)
  assert.ok(indexed, '主参考资产必须存在于项目 assets 索引')
  assert.equal(indexed.uri, asset.primaryReferenceAssetUri)
})

// ---------------------------------------------------------------------------
// S4-01 评审失败路径：不写假引用
// ---------------------------------------------------------------------------

test('评审未通过：select 返回 409 review_not_passed，计划与项目均无写入', async () => {
  const before = await readProject()
  const res = await postSelect(ASSETS.reviewFail.assetId, ASSETS.reviewFail.rel)
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.success, false)
  assert.equal(body.error, 'review_not_passed')
  assert.ok(body.review && body.review.passed === false, '响应必须携带可追溯评审记录')

  const asset = await readPlanAsset(ASSETS.reviewFail.assetId)
  assert.equal(asset.primaryReferenceAssetUri, '')
  assert.notEqual(asset.referenceStatus, 'ready')
  assert.deepEqual(await readProject(), before)
})

test('评审兜底假通过（skipped）：select 返回 409 review_unavailable，不写引用', async () => {
  const res = await postSelect(ASSETS.skipped.assetId, ASSETS.skipped.rel)
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.error, 'review_unavailable')
  const asset = await readPlanAsset(ASSETS.skipped.assetId)
  assert.equal(asset.primaryReferenceAssetUri, '')
})

test('无评审记录：select 返回 409 review_record_missing，不写引用', async () => {
  const res = await postSelect(ASSETS.noRecord.assetId, ASSETS.noRecord.rel)
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.error, 'review_record_missing')
  const asset = await readPlanAsset(ASSETS.noRecord.assetId)
  assert.equal(asset.primaryReferenceAssetUri, '')
})

// ---------------------------------------------------------------------------
// S4-01 文件缺失路径：评审通过但文件不存在 → 显式失败，不写引用
// ---------------------------------------------------------------------------

test('文件缺失：评审通过但磁盘无文件，select 返回 400 reference_file_missing，不写引用', async () => {
  const res = await postSelect(ASSETS.fileMissing.assetId, ASSETS.fileMissing.rel)
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.success, false)
  assert.equal(body.error, 'reference_file_missing')
  const asset = await readPlanAsset(ASSETS.fileMissing.assetId)
  assert.equal(asset.primaryReferenceAssetUri, '')
})

// ---------------------------------------------------------------------------
// provider 不可用路径：生成显式 FAIL，不产生候选与引用
// ---------------------------------------------------------------------------

test('provider 未启用：生成候选返回 503 disabled，计划无候选无引用', async () => {
  const res = await app.request(`/api/projects/${PROJECT_ID}/ai/story/assets/reference`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId: ASSETS.genFail.assetId })
  })
  assert.equal(res.status, 503)
  const body = await res.json()
  assert.equal(body.success, false)
  assert.equal(body.error, 'disabled')
  const asset = await readPlanAsset(ASSETS.genFail.assetId)
  assert.equal(asset.primaryReferenceAssetUri, '')
  assert.equal(asset.generatedRefs.length, 0)
})

test('provider 不可达：生成候选显式 FAIL（含原因），计划无候选无引用', async () => {
  // 启用出图并指向必然拒绝连接的 sdwebui 地址
  await mkdir(path.join(TMP, '_config'), { recursive: true })
  await writeFile(
    path.join(TMP, '_config', 'studio_settings.json'),
    JSON.stringify({ enabled: { image: true }, image: { provider: 'sdwebui', sdwebuiBaseUrl: 'http://127.0.0.1:9' } }, null, 2)
  )
  const res = await app.request(`/api/projects/${PROJECT_ID}/ai/story/assets/reference`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assetId: ASSETS.genFail.assetId, batchSize: 1 })
  })
  assert.ok(res.status >= 500, `provider 不可达必须显式失败，实际状态 ${res.status}`)
  const body = await res.json()
  assert.equal(body.success, false)
  assert.ok(body.error, '必须携带错误码')
  assert.ok(String(body.message || '').length > 0, '必须携带失败原因')
  const asset = await readPlanAsset(ASSETS.genFail.assetId)
  assert.equal(asset.primaryReferenceAssetUri, '')
  assert.equal(asset.generatedRefs.length, 0)
  assert.equal(asset.latestReferenceBatch.length, 0)
})

// ---------------------------------------------------------------------------
// lock_confirm 写入路径（第二写入口）：文件缺失显式失败，文件存在才落锁
// ---------------------------------------------------------------------------

async function seedLockConfirmReview(assetId, resultImagePath) {
  const review = {
    reviewId: `imgrev_e01_${assetId.replace(/[^a-z0-9]+/gi, '_')}`,
    schemaVersion: '1.0',
    phase: 'lock_confirm',
    targetKey: `lock_confirm:${assetId}:${resultImagePath}`,
    assetId,
    sceneId: '',
    prompt: 'p',
    negativePrompt: 'n',
    referenceImages: [],
    params: {},
    execute: null,
    resultImagePath,
    aiReview: { passed: true, score: 88 },
    status: 'pending',
    createdAt: new Date().toISOString(),
    decidedAt: '',
    decidedBy: '',
    rejectReason: ''
  }
  const reviewsPath = path.join(PROJECT_DIR, 'reviews', 'image_reviews.jsonl')
  await mkdir(path.dirname(reviewsPath), { recursive: true })
  await writeFile(reviewsPath, JSON.stringify(review) + '\n')
  return review
}

test('lock_confirm approve：文件缺失时显式失败，审核保持 pending，不写引用', async () => {
  const review = await seedLockConfirmReview(ASSETS.lockMissing.assetId, ASSETS.lockMissing.rel)
  const res = await app.request(`/api/projects/${PROJECT_ID}/ai/reviews/${review.reviewId}/approve`, { method: 'POST' })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.success, false)
  assert.equal(body.error, 'reference_file_missing')

  const asset = await readPlanAsset(ASSETS.lockMissing.assetId)
  assert.equal(asset.primaryReferenceAssetUri, '')

  const reviews = await app.request(`/api/projects/${PROJECT_ID}/ai/reviews?status=pending`)
  const list = (await reviews.json()).reviews
  assert.ok(list.some((item) => item.reviewId === review.reviewId), '失败的审核必须保持 pending，不得被消费')
})

test('lock_confirm approve：文件真实存在时落锁写入引用', async () => {
  const review = await seedLockConfirmReview(ASSETS.lock.assetId, ASSETS.lock.rel)
  const res = await app.request(`/api/projects/${PROJECT_ID}/ai/reviews/${review.reviewId}/approve`, { method: 'POST' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.success, true)
  assert.equal(body.review.status, 'approved')

  const asset = await readPlanAsset(ASSETS.lock.assetId)
  assert.equal(asset.primaryReferenceAssetUri, ASSETS.lock.rel)
  const check = await verifyStoryAssetReferenceFile({ dir: PROJECT_DIR, assetPath: asset.primaryReferenceAssetUri })
  assert.equal(check.ok, true)
})
