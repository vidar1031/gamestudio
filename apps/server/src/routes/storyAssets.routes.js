// ---------------------------------------------------------------------------
// registerStoryAssetsRoutes（模块化拆分机械迁出，字义未改；协议层+族内编排，域算法引自 ../ai/*，index 本地辅助经 ctx 注入）
// ---------------------------------------------------------------------------
import path from 'node:path'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rename, stat, writeFile, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import crypto from 'node:crypto'
import { genId } from '../ai/scripts.js'
import { classifyAiError, createTraceId, logStage } from '../ai/runtime.js'
import { createAiTask, updateAiTask } from '../ai/taskProgress.js'
import { generateBackgroundImage, generateComfyuiLineartFromReference, generateComfyuiCutoutFromReference, mapComfySampler, mapComfyScheduler, normalizeComfyCheckpointName, parseComfyTimeoutMs, runComfyuiPromptWorkflow } from '../ai/background.js'
import { optimizeGeneratedImage, IMAGE_KIND } from '../ai/imageOptimize.js'
import { buildStoryAssetPlan, buildStoryAssetReferenceNegativePrompt, buildStoryAssetReferencePrompt, getStoryAssetRenderProfile, repairStoryAssetPlanSceneLinks, resolveStoryStylePreset, summarizeStoryAssetPlan } from '../ai/storyAssets.js'
import { buildStoryboardLockTestNegativePrompt, buildStoryboardLockTestPrompt, buildStoryboardLockTestWorkflow, pickStoryboardLockTestAsset, reviewStoryboardLockImageWithAi } from '../ai/storyLock.js'
import { evaluateStoryAssetReferenceReview, sniffImageMetaFromBytes, verifyStoryAssetReferenceFile } from '../ai/storyAssetReferenceGate.js'
import { generateStoryboardGlobalPromptWithAi, normalizeStoryboardPromptReviewInput } from '../ai/storyboardPromptReview.js'
import { enhanceStoryAssetPromptWithAi } from '../ai/storyAssetPromptEnhance.js'
import { getEffectiveStudioConfig } from '../studio/settings.js'
import { createImageReview, decideImageReview, findPendingReview } from '../review/imageReviewStore.js'
import { recordCreationEvent } from '../creationBuffer.js'
import { storyInputGate } from '../middleware/storyInputGate.js'

export function registerStoryAssetsRoutes(app, ctx) {
app.post('/api/projects/:id/ai/storyboard/global-prompt-generate', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const input = normalizeStoryboardPromptReviewInput({ ...(body || {}), scope: 'global' })
  if (!String(input.projectTitle || '').trim()) {
    const project = await ctx.readProjectJson(id).catch(() => null)
    input.projectTitle = String(project && project.title ? project.title : '').trim()
  }

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.prompt) {
    return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)
  }
  const provider = String(studio.effective.prompt.provider || '').trim().toLowerCase()
  if (!provider || provider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“提示词生成”并选择 Provider/Model' }, 400)
  }

  const startedAt = Date.now()
  const traceId = createTraceId()
  logStage({ stage: 'storyboard.global_prompt_generate', event: 'start', traceId, project: id, provider, model: studio.effective.prompt.model || '-' })
  try {
    const generated = await generateStoryboardGlobalPromptWithAi({
      input,
      provider,
      model: studio.effective.prompt.model || undefined,
      apiUrl: studio.effective.prompt.apiUrl || undefined,
      proxyUrl: studio.effective.network.proxyUrl || undefined
    })
    if (!generated?.result) throw new Error('unsupported_prompt_provider')
    logStage({ stage: 'storyboard.global_prompt_generate', event: 'ok', traceId, project: id, provider, model: generated.meta?.model || studio.effective.prompt.model || '-', ok: true, durationMs: Math.max(0, Date.now() - startedAt) })
    return c.json({ success: true, result: generated.result, meta: generated.meta || null, traceId })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const mapped = classifyAiError(e)
    logStage({ stage: 'storyboard.global_prompt_generate', event: 'fail', traceId, project: id, provider, model: studio.effective.prompt.model || '-', status: mapped.httpStatus, ok: false, durationMs: Math.max(0, Date.now() - startedAt), err: msg })
    return c.json({ success: false, error: mapped.code, message: msg, traceId }, mapped.httpStatus)
  }
})

// [拆分] GET /api/projects 已迁至 apps/server/src/routes/story.routes.js
// [拆分] GET /api/projects/summary 已迁至 apps/server/src/routes/story.routes.js
// [拆分] POST /api/projects/:id/confirm-draft 已迁至 apps/server/src/routes/story.routes.js
// [拆分] POST /api/projects 已迁至 apps/server/src/routes/story.routes.js
// [拆分] POST /api/projects/ai/create 已迁至 apps/server/src/routes/story.routes.js
// [拆分] POST /api/projects/:id/ai/regenerate 已迁至 apps/server/src/routes/story.routes.js
// [拆分] POST /api/projects/:id/analyze/scripts 已迁至 apps/server/src/routes/story.routes.js
// [拆分] POST /api/projects/:id/validate/blueprint 已迁至 apps/server/src/routes/story.routes.js
// [拆分] POST /api/projects/:id/ai/fix/scripts 已迁至 apps/server/src/routes/story.routes.js
// [拆分] GET /api/projects/:id 已迁至 apps/server/src/routes/story.routes.js
// [拆分] PUT /api/projects/:id 已迁至 apps/server/src/routes/story.routes.js
// [拆分] DELETE /api/projects/:id 已迁至 apps/server/src/routes/story.routes.js
// [拆分] GET /api/projects/:id/scripts 已迁至 apps/server/src/routes/story.routes.js
// [拆分] PUT /api/projects/:id/scripts 已迁至 apps/server/src/routes/story.routes.js
// [拆分] GET /api/projects/:id/blueprint 已迁至 apps/server/src/routes/story.routes.js
// [拆分] PUT /api/projects/:id/blueprint 已迁至 apps/server/src/routes/story.routes.js
// [拆分] POST /api/projects/:id/compile/blueprint 已迁至 apps/server/src/routes/story.routes.js
// [拆分] POST /api/projects/:id/compile/compose 已迁至 apps/server/src/routes/story.routes.js

app.post('/api/projects/:id/ai/story/assets/plan', storyInputGate('story.assets.plan', (c, body) => ({ projectId: c.req.param('id'), ...body })), async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const bundle = await ctx.readProjectBundle(id)
  const storyBible = body && body.storyBible && typeof body.storyBible === 'object'
    ? body.storyBible
    : ctx.readStoryBibleFromProjectDoc(bundle.project)
  if (!storyBible || typeof storyBible !== 'object') {
    return c.json({ success: false, error: 'missing_story_bible', message: '未找到 Story Bible。请先生成 Story Bible，或在请求中传入 storyBible。' }, 400)
  }

  // V1.1 重建保真：rebuild:true 也从磁盘真相继承既有锁定/变体状态（prevManifest 不再传 null）——
  // 此前 rebuild 全量丢失 primaryReferenceAssetUri/generatedRefs/线稿/状态变体（青蛙王子 63MB 孤儿文件事故）。
  // rebuild:false 且已有持久化计划时直接返回磁盘真相，不再 rebuild 派生——
  // 派生会把人工补充的资产（如猪妈妈）与 repair-links 的场景关联丢掉，编辑器看到并与真相不一致。
  const prevManifest = await ctx.readStoryAssetPlanIfExists(id)
  if (!body?.rebuild && prevManifest) {
    return c.json({ success: true, plan: prevManifest })
  }
  const plan = buildStoryAssetPlan({
    project: bundle.project,
    story: bundle.story,
    storyBible,
    prevManifest
  })
  await ctx.saveStoryAssetPlan(id, plan)
  // 2026-10-08 《xxxx2》命名约定：plan 落盘后自动继承基底项目已锁定资产（跳过抽卡/锁定/线稿）
  const inherit = await ctx.maybeAutoInheritStoryAssets(id).catch((e) => ({ error: String(e && e.message || e) }))
  const finalPlan = inherit && !inherit.error ? await ctx.readStoryAssetPlanIfExists(id) || plan : plan
  return c.json({ success: true, plan: finalPlan, ...(inherit ? { inherit } : {}) })
})

app.post('/api/projects/:id/ai/story/assets/plan/persist', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const plan = body && body.plan && typeof body.plan === 'object' ? body.plan : null
  if (!plan) {
    return c.json({ success: false, error: 'missing_plan', message: '缺少要保存的资产计划。' }, 400)
  }
  await ctx.saveStoryAssetPlan(id, plan, { mergeAssetsById: true, protectTerminalFields: true })
  // 2026-09-03 返回最新 _rev：saveStoryAssetPlan 会递增 project.json 版本号，
  // 编辑器不采信的话，外部更新检测横幅会把"自己刚才的保存"误报成外部更新（实测假阳性）。
  let rev = 0
  try {
    const doc = await ctx.readJson(path.join(ctx.projectDir(id), 'project.json'))
    rev = Number(doc && doc._rev) || 0
  } catch (_) {}
  return c.json({ success: true, plan, _rev: rev })
})

// 2026-09-16 资产计划真删除：按 assetId 从磁盘真相计划移除资产并清洗场景引用，全量覆盖写盘。
// 背景：persist 通道 mergeAssetsById 会保留磁盘独有条目，编辑器推"已过滤计划"删不掉（实测删除静默无效）。
// 删除类写按 2026-09-09 治理注释不走 merge（与 repair-links 同款全量覆盖）。
app.post('/api/projects/:id/ai/story/assets/plan/remove-asset', async (c) => {
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)
  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)
  const assets = Array.isArray(plan.assets) ? plan.assets : []
  const target = assets.find((a) => String(a && a.id || '').trim() === assetId) || null
  if (!target) return c.json({ success: false, error: 'asset_not_found', message: '计划中未找到该事物资产。' }, 404)
  const scrubIdList = (list) => (Array.isArray(list) ? list : []).map((x) => String(x || '').trim()).filter((x) => x && x !== assetId)
  const nextPlan = {
    ...plan,
    generatedAt: ctx.nowIso(),
    excludedAssetIds: Array.from(new Set([...(Array.isArray(plan.excludedAssetIds) ? plan.excludedAssetIds : []), assetId])),
    assets: assets.filter((a) => String(a && a.id || '').trim() !== assetId),
    scenes: (Array.isArray(plan.scenes) ? plan.scenes : []).map((scene) => ({
      ...scene,
      assetIds: scrubIdList(scene && scene.assetIds),
      promptAssets: (Array.isArray(scene && scene.promptAssets) ? scene.promptAssets : []).filter((x) => String(x && x.id || '').trim() !== assetId),
      missingRequiredAssetIds: scrubIdList(scene && scene.missingRequiredAssetIds),
      readyReferenceAssetIds: scrubIdList(scene && scene.readyReferenceAssetIds)
    }))
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await ctx.saveStoryAssetPlan(id, nextPlan)
  let rev = 0
  try {
    const doc = await ctx.readJson(path.join(dir, 'project.json'))
    rev = Number(doc && doc._rev) || 0
  } catch (_) {}
  return c.json({ success: true, plan: nextPlan, removedAssetId: assetId, removedAssetName: String(target.name || ''), _rev: rev })
})

// 场景↦资产关联确定性修复：按计划资产的名称/别名（+调用方证据别名 aliasOverrides）在场景文本中
// 子串匹配，重建 scene.promptAssets 与 asset.sceneIds/sceneCount。用于修复计划生成器漏写关联的缺陷
//（关联缺失会导致场景渲染 prompt 只剩 worldAnchor，出图同质跑题）。
app.post('/api/projects/:id/ai/story/assets/plan/repair-links', async (c) => {
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)
  const body = await c.req.json().catch(() => ({}))
  const aliasOverrides = body && typeof body.aliasOverrides === 'object' && body.aliasOverrides ? body.aliasOverrides : {}
  const { plan: nextPlan, changes } = repairStoryAssetPlanSceneLinks(plan, { aliasOverrides })
  await ctx.saveStoryAssetPlan(id, nextPlan)
  return c.json({ success: true, changes, plan: nextPlan })
})

// 手动/事件链继承入口：sourceId 可省略（按《xxxx2》命名约定自动解析基底）
app.post('/api/projects/:id/ai/story/assets/inherit', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  let sourceId = String(body?.sourceId || '').trim()
  let baseTitle = ''
  if (!sourceId) {
    const meta = await ctx.readJson(path.join(dir, 'meta.json')).catch(() => null)
    baseTitle = ctx.resolveInheritBaseTitle(meta?.title)
    if (!baseTitle) return c.json({ success: false, error: 'inherit_base_not_resolved', message: '项目名不含数字后缀，无法按《xxxx2》约定解析基底项目；请显式传 sourceId。' }, 400)
    sourceId = await ctx.findProjectIdByTitle(baseTitle, { excludeId: id })
    if (!sourceId) return c.json({ success: false, error: 'inherit_base_not_found', message: `未找到基底项目《${baseTitle}》` }, 404)
  }
  try {
    const summary = await ctx.inheritStoryAssetsFromProject({ id, dir, sourceId, force: body?.force === true })
    return c.json({ success: true, baseTitle: baseTitle || undefined, sourceId, ...summary })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const code = String((e && e.code) || 'inherit_failed')
    return c.json({ success: false, error: code, message: msg }, code === 'missing_plan' ? 400 : 500)
  }
})

// [拆分回收] 辅助定义 已回 index.js

// 锁定主参考的抠图后处理：character/prop 走 RMBG 透明立绘（分层合成方向），
// 失败时兜底回退为原图引用（catch 语义保留，不阻断 select 主流程）
// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// 2026-09-28：锁定写回时补齐提示词中文稿（确定性模板，不调 LLM、不阻断锁定）。
// 背景：自动生产链不走编辑器「AI 生成提示词」向导，promptZh 从未产生，编辑器打开时只能归一化出
// 英文/负向词骨架，锁定工作区提示词面板首栏（中文稿）空白（《小猫钓鱼》12/12 资产实测全空）。
// 这里用 buildStoryAssetPromptEnhancement 的本地模板兜底中文稿；编辑器「AI 生成提示词」仍可覆盖出更精细的稿子。
// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

app.post('/api/projects/:id/ai/story/assets/reference', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const traceId = createTraceId()

  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const bundle = await ctx.readProjectBundle(id)
  let plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) {
    const storyBible = ctx.readStoryBibleFromProjectDoc(bundle.project)
    if (!storyBible || typeof storyBible !== 'object') {
      return c.json({ success: false, error: 'missing_story_bible', message: '未找到 Story Bible。请先生成 Story Bible 并创建资产计划。' }, 400)
    }
    plan = buildStoryAssetPlan({ project: bundle.project, story: bundle.story, storyBible, prevManifest: null })
  }

  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
  const imgProvider = String(studio.effective.image.provider || process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()
  if (!imgProvider || imgProvider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“出图（背景图）”并选择 Provider/Model' }, 400)
  }

  const aiBg = bundle.project && bundle.project.state && bundle.project.state.aiBackground && typeof bundle.project.state.aiBackground === 'object'
    ? bundle.project.state.aiBackground
    : {}
  const draft = aiBg && aiBg.storyboardBatchDraft && typeof aiBg.storyboardBatchDraft === 'object'
    ? aiBg.storyboardBatchDraft
    : {}
  const requestedLoras = Array.isArray(body?.loras)
    ? body.loras.map((x) => String(x || '').trim()).filter(Boolean)
    : (
        Array.isArray(draft?.loras)
          ? draft.loras.map((x) => String(x || '').trim()).filter(Boolean)
          : (Array.isArray(studio.effective.image.loras) ? studio.effective.image.loras.map((x) => String(x || '').trim()).filter(Boolean) : [])
      )
  const stylePreset = resolveStoryStylePreset(studio)
  const effectiveLoras = ctx.chooseStoryboardAssetLoras({ asset, requestedLoras, stylePreset })
  const requestedModel = String(body?.model || draft?.model || '').trim()
  const modelResolution = await ctx.resolveStoryboardAssetModel({ studio, imgProvider, requestedModel, asset })
  const effectiveModel = String(modelResolution.model || '').trim()
  const style = ctx.normalizeStyleEnum(body?.style || draft.style || 'picture_book')
  const { width: widthDefault, height: heightDefault } = ctx.getStoryAssetRenderSize(asset, stylePreset)
  const width = ctx.clampInt(body?.width, 256, 2048, widthDefault)
  const height = ctx.clampInt(body?.height, 256, 2048, heightDefault)
  const batchSize = ctx.clampInt(body?.batchSize, 1, 6, 4)
  const globalPrompt = String(body?.globalPrompt || '').trim()
  const globalNegativePrompt = String(body?.globalNegativePrompt || '').trim()
  const sanitizedDraft = ctx.sanitizeProtectedAssetPrompt({
    asset,
    promptEn: String(body?.assetPrompt || body?.promptEn || '').trim(),
    negativePrompt: String(body?.assetNegativePrompt || '').trim()
  })
  const assetPrompt = ctx.pickEnglishPrompt(
    sanitizedDraft.promptEn,
    ctx.storyAssetStr(asset && asset.referencePromptEn).trim(),
    ctx.storyAssetStr(asset && asset.referencePromptHint).trim()
  )
  const assetNegativePrompt = sanitizedDraft.negativePrompt
  const prompt = String(body?.prompt || '').trim() || buildStoryAssetReferencePrompt({ plan, asset, style, globalPrompt, assetPrompt, stylePreset })
  const negativePrompt = String(body?.negativePrompt || '').trim() || buildStoryAssetReferenceNegativePrompt({ plan, asset, globalNegativePrompt, assetNegativePrompt })

  try {
    logStage({ stage: 'asset.reference.batch', event: 'start', traceId, project: id, item: assetId, ok: true, detail: 'generate_candidates_only' })
    // 2026-08-29 出图可观测（AGENTS.md 强制规则）：参考图抽卡批次必须在 UI 暴露真实进度，禁止黑盒
    const refTask = createAiTask(id, 'story.asset.reference_batch', {
      total: batchSize,
      message: `参考图抽卡：${String(asset.name || assetId).trim()}`
    })
    let currentPlan = await ctx.persistStoryAssetReferenceBatch({
      id,
      plan,
      assetId,
      latestReferenceBatch: [],
      recommendedReferenceAssetUri: ''
    })
    let currentBundle = bundle
    let bestResult = null
    let bestReview = null
    let attemptPrompt = prompt
    let attemptNegativePrompt = negativePrompt
    const baseSeed = Math.floor(Math.random() * 4_294_900_000)
    const rawCandidates = []
    const maxAttempts = Math.max(batchSize, Math.min(12, batchSize + 4))
    for (let i = 0; i < maxAttempts && rawCandidates.length < batchSize; i += 1) {
      const seed = (baseSeed + i * 9973) % 4_294_967_295
      updateAiTask(refTask.taskId, { stage: 'generating', current: i + 1, message: `第 ${i + 1}/${batchSize} 张生成中…（${String(asset.name || assetId).trim()}）` })
      const result = await ctx.generateAndPersistStoryAssetReference({
        id,
        dir,
        bundle: currentBundle,
        plan: currentPlan,
        asset,
        studio,
        imgProvider,
        style,
        width,
        height,
        steps: body?.steps,
        cfgScale: body?.cfgScale,
        sampler: body?.sampler,
        scheduler: body?.scheduler,
        model: effectiveModel,
        loras: effectiveLoras,
        prompt: attemptPrompt,
        negativePrompt: attemptNegativePrompt,
        timeoutMs: body?.timeoutMs,
        seed
      })
      currentPlan = result.plan
      currentBundle = await ctx.readProjectBundle(id)
      updateAiTask(refTask.taskId, { stage: 'reviewing', current: i + 1, message: `第 ${i + 1}/${batchSize} 张 AI 评审中…` })
      const reviewed = await ctx.reviewAndPersistStoryAssetReference({
        id,
        dir,
        studio,
        plan: currentPlan,
        asset,
        prompt: result.prompt,
        negativePrompt: result.negativePrompt,
        assetPath: result.assetPath
      })
      currentPlan = reviewed.plan
      const revisedPrompt = ctx.pickEnglishPrompt(String(reviewed.analysis?.revisedPrompt || '').trim(), attemptPrompt)
      const revisedNegativePrompt = String(reviewed.analysis?.revisedNegativePrompt || '').trim() || attemptNegativePrompt
      if (!Boolean(reviewed.analysis?.passed) && (revisedPrompt !== attemptPrompt || revisedNegativePrompt !== attemptNegativePrompt)) {
        attemptPrompt = revisedPrompt
        attemptNegativePrompt = revisedNegativePrompt
      }
      if (!ctx.shouldDiscardStoryAssetReferenceCandidate(reviewed.analysis)) {
        rawCandidates.push({
          attempt: i + 1,
          seed,
          assetPath: result.assetPath,
          url: result.url,
          analysis: reviewed.analysis
        })
      }
      if (!bestResult || ctx.storyAssetReviewScore(reviewed.analysis) > ctx.storyAssetReviewScore(bestReview)) {
        bestResult = result
        bestReview = reviewed.analysis
      }
      const partialRecommendedAssetPath = bestResult ? String(bestResult.assetPath || '').trim() : ''
      const partialCandidates = rawCandidates.map((item) => ({
        ...item,
        recommended: Boolean(partialRecommendedAssetPath && String(item.assetPath || '').trim() === partialRecommendedAssetPath)
      }))
      currentPlan = await ctx.persistStoryAssetReferenceBatch({
        id,
        plan: currentPlan,
        assetId,
        latestReferenceBatch: partialCandidates,
        recommendedReferenceAssetUri: partialRecommendedAssetPath
      })
    }
    const recommendedAssetPath = bestResult ? String(bestResult.assetPath || '').trim() : ''
    const candidates = rawCandidates.map((item) => ({
      ...item,
      recommended: Boolean(recommendedAssetPath && String(item.assetPath || '').trim() === recommendedAssetPath)
    }))
    currentPlan = await ctx.persistStoryAssetReferenceBatch({
      id,
      plan: currentPlan,
      assetId,
      latestReferenceBatch: candidates,
      recommendedReferenceAssetUri: recommendedAssetPath
    })
    const currentAsset = (Array.isArray(currentPlan.assets) ? currentPlan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null) || null
    // 2026-10-12 ④ 抽卡自动选优（脱离监控）：autoSelect=true 时批次结束后自动锁定最优过审候选。
    // 策略：仅接受 AI 评审 passed 且分 ≥50 的候选（取最高分）；无合格候选不自动锁——标 needs_manual 挂人工队列，
    // 绝不自动锁垃圾参考图污染整个故事。选定走内部 select 链（抠图+lock_confirm 留痕同源）。
    let autoSelect = null
    if (body?.autoSelect === true && candidates.length) {
      const qualified = candidates.filter((item) => Boolean(item && item.analysis && item.analysis.passed) && ctx.storyAssetReviewScore(item.analysis) >= 50)
      const chosen = qualified.length
        ? qualified.reduce((a, b) => (ctx.storyAssetReviewScore(b.analysis) > ctx.storyAssetReviewScore(a.analysis) ? b : a))
        : null
      if (chosen) {
        try {
          const selResp = await app.request(`/api/projects/${encodeURIComponent(id)}/ai/story/assets/reference/select`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-image-review-mode': 'off' },
            body: JSON.stringify({ assetId, assetPath: String(chosen.assetPath || '').trim() })
          })
          const selJson = await selResp.json().catch(() => null)
          const selOk = selResp.ok && (!selJson || selJson.success !== false)
          autoSelect = { picked: String(chosen.assetPath || '').trim(), score: ctx.storyAssetReviewScore(chosen.analysis), success: selOk, decidedBy: 'auto-select' }
          logStage({ stage: 'asset.reference.batch', event: 'auto_select', traceId, project: id, item: assetId, ok: selOk, detail: String(chosen.assetPath || '') })
        } catch (e) {
          autoSelect = { picked: String(chosen.assetPath || '').trim(), success: false, error: e && e.message ? String(e.message) : String(e) }
        }
      } else {
        autoSelect = { picked: '', reason: 'no_qualified_candidate', message: '无过审候选（AI 评审通过且 ≥50 分），留待人工选定', decidedBy: 'auto-select' }
      }
    }
    updateAiTask(refTask.taskId, {
      stage: autoSelect && !autoSelect.picked ? 'needs_manual' : 'done',
      done: true,
      current: candidates.length,
      message: autoSelect
        ? (autoSelect.picked ? `抽卡完成并自动锁定：${candidates.length} 张候选，选定最优过审（${autoSelect.score} 分）` : `抽卡完成：${candidates.length} 张候选，无过审合格项，待人工选定`)
        : `抽卡完成：${candidates.length} 张候选（${String(asset.name || assetId).trim()}）`
    })
    logStage({ stage: 'asset.reference.batch', event: 'ok', traceId, project: id, item: assetId, ok: true, detail: 'generate_candidates_only', count: candidates.length })
    return c.json({ success: true, asset: currentAsset, analysis: bestReview, recommendedAssetPath, candidates, ...(autoSelect ? { autoSelect } : {}), model: effectiveModel || undefined, modelSource: modelResolution.source, ...(bestResult || {}), plan: currentPlan })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    if (typeof refTask !== 'undefined' && refTask) updateAiTask(refTask.taskId, { stage: 'error', done: true, error: msg, message: msg })
    logStage({ stage: 'asset.reference.batch', event: 'fail', traceId, project: id, item: assetId, status: mapped.httpStatus, ok: false, err: msg })
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

app.post('/api/projects/:id/ai/story/assets/reference/review', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  const assetPath = String(asset.primaryReferenceAssetUri || '').trim()
  if (!assetPath) return c.json({ success: false, error: 'missing_reference_image', message: '请先从 4 张候选图中手动选择主参考，再执行分析。' }, 400)
  const latestRef = Array.isArray(asset.generatedRefs) ? asset.generatedRefs.find((x) => String(x?.projectAssetUri || '').trim() === assetPath) : null
  const prompt = String(latestRef?.prompt || buildStoryAssetReferencePrompt({ plan, asset, style: 'picture_book' })).trim()
  const negativePrompt = String(latestRef?.negativePrompt || buildStoryAssetReferenceNegativePrompt({ plan, asset })).trim()

  try {
    const studio = await getEffectiveStudioConfig(ctx.ROOT)
    const result = await ctx.reviewAndPersistStoryAssetReference({
      id,
      dir,
      studio,
      plan,
      asset,
      prompt,
      negativePrompt,
      assetPath
    })
    return c.json({ success: true, ...result })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

app.post('/api/projects/:id/ai/story/assets/reference/optimize', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const bundle = await ctx.readProjectBundle(id)
  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  const currentAssetPath = String(asset.primaryReferenceAssetUri || '').trim()
  if (!currentAssetPath) return c.json({ success: false, error: 'missing_reference_image', message: '请先从 4 张候选图中手动选择主参考，再执行增强。' }, 400)

  try {
    const studio = await getEffectiveStudioConfig(ctx.ROOT)
    if (!studio.effective.enabled.image) {
      return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
    }
    const imgProvider = String(studio.effective.image.provider || process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()
    if (!imgProvider || imgProvider === 'none') {
      return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“出图（背景图）”并选择 Provider/Model' }, 400)
    }

    const latestRef = Array.isArray(asset.generatedRefs) ? asset.generatedRefs.find((x) => String(x?.projectAssetUri || '').trim() === currentAssetPath) : null
    const globalPrompt = String(body?.globalPrompt || '').trim()
    const globalNegativePrompt = String(body?.globalNegativePrompt || '').trim()
    const sanitizedDraft = ctx.sanitizeProtectedAssetPrompt({
      asset,
      promptEn: String(body?.assetPrompt || body?.promptEn || '').trim(),
      negativePrompt: String(body?.assetNegativePrompt || '').trim()
    })
    const assetPrompt = ctx.pickEnglishPrompt(
      sanitizedDraft.promptEn,
      ctx.storyAssetStr(asset && asset.referencePromptEn).trim(),
      ctx.storyAssetStr(asset && asset.referencePromptHint).trim()
    )
    const assetNegativePrompt = sanitizedDraft.negativePrompt
    const prompt = String(latestRef?.prompt || buildStoryAssetReferencePrompt({ plan, asset, style: String(body?.style || 'picture_book'), globalPrompt, assetPrompt })).trim()
    const negativePrompt = String(latestRef?.negativePrompt || buildStoryAssetReferenceNegativePrompt({ plan, asset, globalNegativePrompt, assetNegativePrompt })).trim()
    const reviewed = await ctx.reviewAndPersistStoryAssetReference({
      id,
      dir,
      studio,
      plan,
      asset,
      prompt,
      negativePrompt,
      assetPath: currentAssetPath
    })
    const effectiveAnalysis = reviewed.analysis || {}
    const style = ctx.normalizeStyleEnum(body?.style || 'picture_book')
    const aiBg = bundle.project && bundle.project.state && bundle.project.state.aiBackground && typeof bundle.project.state.aiBackground === 'object'
      ? bundle.project.state.aiBackground
      : {}
    const draft = aiBg && aiBg.storyboardBatchDraft && typeof aiBg.storyboardBatchDraft === 'object'
      ? aiBg.storyboardBatchDraft
      : {}
    const requestedLoras = Array.isArray(body?.loras)
      ? body.loras.map((x) => String(x || '').trim()).filter(Boolean)
      : (
          Array.isArray(draft?.loras)
            ? draft.loras.map((x) => String(x || '').trim()).filter(Boolean)
            : (Array.isArray(studio.effective.image.loras) ? studio.effective.image.loras.map((x) => String(x || '').trim()).filter(Boolean) : [])
        )
    const effectiveLoras = ctx.chooseStoryboardAssetLoras({ asset, requestedLoras, stylePreset: resolveStoryStylePreset(studio) })
    const requestedModel = String(body?.model || draft?.model || '').trim()
    const modelResolution = await ctx.resolveStoryboardAssetModel({ studio, imgProvider, requestedModel, asset })
    const effectiveModel = String(modelResolution.model || '').trim()
    const { width: widthDefault, height: heightDefault } = ctx.getStoryAssetRenderSize(asset, resolveStoryStylePreset(studio))
    const width = ctx.clampInt(body?.width, 256, 2048, widthDefault)
    const height = ctx.clampInt(body?.height, 256, 2048, heightDefault)
    const batchSize = ctx.clampInt(body?.batchSize, 1, 6, 4)
    let currentPlan = await ctx.persistStoryAssetReferenceBatch({
      id,
      plan: reviewed.plan,
      assetId,
      latestReferenceBatch: [],
      recommendedReferenceAssetUri: ''
    })
    let currentBundle = bundle
    let bestResult = null
    let bestReview = effectiveAnalysis
    let attemptPrompt = ctx.pickEnglishPrompt(String(effectiveAnalysis.revisedPrompt || '').trim(), prompt)
    let attemptNegativePrompt = String(effectiveAnalysis.revisedNegativePrompt || negativePrompt).trim() || negativePrompt
    const baseSeed = Math.floor(Math.random() * 4_294_900_000)
    const rawCandidates = []
    const maxAttempts = Math.max(batchSize, Math.min(12, batchSize + 4))
    for (let i = 0; i < maxAttempts && rawCandidates.length < batchSize; i += 1) {
      const seed = (baseSeed + i * 9973) % 4_294_967_295
      const result = await ctx.generateAndPersistStoryAssetReference({
        id,
        dir,
        bundle: currentBundle,
        plan: currentPlan,
        asset,
        studio,
        imgProvider,
        style,
        width,
        height,
        steps: body?.steps,
        cfgScale: body?.cfgScale,
        sampler: body?.sampler,
        scheduler: body?.scheduler,
        model: effectiveModel,
        loras: effectiveLoras,
        prompt: attemptPrompt,
        negativePrompt: attemptNegativePrompt,
        timeoutMs: body?.timeoutMs,
        seed
      })
      currentPlan = result.plan
      currentBundle = await ctx.readProjectBundle(id)
      const rerReviewed = await ctx.reviewAndPersistStoryAssetReference({
        id,
        dir,
        studio,
        plan: currentPlan,
        asset,
        prompt: result.prompt,
        negativePrompt: result.negativePrompt,
        assetPath: result.assetPath
      })
      currentPlan = rerReviewed.plan
      const revisedPrompt = ctx.pickEnglishPrompt(String(rerReviewed.analysis?.revisedPrompt || '').trim(), attemptPrompt)
      const revisedNegativePrompt = String(rerReviewed.analysis?.revisedNegativePrompt || '').trim() || attemptNegativePrompt
      if (!Boolean(rerReviewed.analysis?.passed) && (revisedPrompt !== attemptPrompt || revisedNegativePrompt !== attemptNegativePrompt)) {
        attemptPrompt = revisedPrompt
        attemptNegativePrompt = revisedNegativePrompt
      }
      if (!ctx.shouldDiscardStoryAssetReferenceCandidate(rerReviewed.analysis)) {
        rawCandidates.push({
          attempt: i + 1,
          seed,
          assetPath: result.assetPath,
          url: result.url,
          analysis: rerReviewed.analysis
        })
      }
      if (!bestResult || ctx.storyAssetReviewScore(rerReviewed.analysis) > ctx.storyAssetReviewScore(bestReview)) {
        bestResult = result
        bestReview = rerReviewed.analysis
      }
      const partialRecommendedAssetPath = bestResult ? String(bestResult.assetPath || '').trim() : ''
      const partialCandidates = rawCandidates.map((item) => ({
        ...item,
        recommended: Boolean(partialRecommendedAssetPath && String(item.assetPath || '').trim() === partialRecommendedAssetPath)
      }))
      currentPlan = await ctx.persistStoryAssetReferenceBatch({
        id,
        plan: currentPlan,
        assetId,
        latestReferenceBatch: partialCandidates,
        recommendedReferenceAssetUri: partialRecommendedAssetPath
      })
    }
    const recommendedAssetPath = bestResult ? String(bestResult.assetPath || '').trim() : ''
    const candidates = rawCandidates.map((item) => ({
      ...item,
      recommended: Boolean(recommendedAssetPath && String(item.assetPath || '').trim() === recommendedAssetPath)
    }))
    currentPlan = await ctx.persistStoryAssetReferenceBatch({
      id,
      plan: currentPlan,
      assetId,
      latestReferenceBatch: candidates,
      recommendedReferenceAssetUri: recommendedAssetPath
    })
    const currentAsset = (Array.isArray(currentPlan.assets) ? currentPlan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null) || null
    return c.json({ success: true, asset: currentAsset, analysis: bestReview, recommendedAssetPath, model: effectiveModel || undefined, modelSource: modelResolution.source, ...(bestResult || {}), candidates, plan: currentPlan })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

app.get('/api/projects/:id/ai/story/assets/:assetId/gallery', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const assetId = ctx.storyAssetStr(c.req.param('assetId')).trim()
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => ctx.storyAssetStr(item && item.id).trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)
  const cleaned = await ctx.pruneMissingStoryAssetGalleryEntries({ id, dir, plan, asset })
  return c.json({ success: true, asset: cleaned.asset, items: cleaned.items, plan: cleaned.plan })
})

app.post('/api/projects/:id/ai/story/assets/:assetId/prompt-enhance', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const assetId = ctx.storyAssetStr(c.req.param('assetId')).trim()
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const body = await c.req.json().catch(() => ({}))
  const rewriteFromScratch = true
  const forceRegenerate = Boolean(body?.forceRegenerate)
  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => ctx.storyAssetStr(item && item.id).trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  const bundle = await ctx.readProjectBundle(id)
  const fallback = ctx.buildStoryAssetPromptEnhancement({
    asset,
    plan,
    globalPromptZh: body?.globalPromptZh,
    globalNegativePromptZh: body?.globalNegativePromptZh,
    currentPromptZh: rewriteFromScratch ? '' : body?.promptZh,
    currentPromptEn: rewriteFromScratch ? '' : body?.promptEn,
    currentNegativePromptZh: rewriteFromScratch ? '' : body?.negativePromptZh,
    currentNegativePrompt: rewriteFromScratch ? '' : body?.negativePrompt
  })
  const fallbackSanitized = ctx.sanitizeProtectedAssetPrompt({
    asset,
    promptEn: fallback.promptEn,
    negativePrompt: fallback.negativePrompt
  })
  const studio = await getEffectiveStudioConfig(ctx.ROOT).catch(() => null)
  const provider = String(studio?.effective?.prompt?.provider || '').trim().toLowerCase()
  const model = studio?.effective?.prompt?.model || undefined
  const apiUrl = studio?.effective?.prompt?.apiUrl || undefined
  const proxyUrl = studio?.effective?.network?.proxyUrl || undefined
  const traceId = createTraceId()
  const startedAt = Date.now()

  let result = {
    ...fallback,
    promptEn: fallbackSanitized.promptEn || fallback.promptEn,
    negativePrompt: fallbackSanitized.negativePrompt || fallback.negativePrompt
  }
  let meta = { provider: 'local', model: null, api: null, durationMs: 0, note: 'local_template_fallback' }
  let aiError = null
  const promptReviews = []
  const minAcceptScore = 50
  const maxRegenerateAttempts = 3
  try {
    const usageContext = fallback.context && typeof fallback.context.usageContext === 'object' ? fallback.context.usageContext : undefined
    const buildPromptReviewFeedbackZh = (review) => {
      if (!review || typeof review !== 'object') return ''
      const risks = Array.isArray(review.risks) ? review.risks.map((x) => ctx.storyAssetStr(x).trim()).filter(Boolean) : []
      const suggestions = Array.isArray(review.suggestions) ? review.suggestions.map((x) => ctx.storyAssetStr(x).trim()).filter(Boolean) : []
      const score = Number(review.score)
      const parts = []
      if (Number.isFinite(score)) parts.push(`上一轮提示词评分 ${Math.round(score)}/100`)
      if (risks.length) parts.push(`主要问题：${risks.slice(0, 4).join('；')}`)
      if (suggestions.length) parts.push(`必须修正：${suggestions.slice(0, 4).join('；')}`)
      return parts.join('。')
    }
    const scoreCandidate = (candidate, source, attempt) => {
      const review = ctx.scoreStoryAssetPromptCandidate({
        asset,
        promptZh: candidate.promptZh,
        promptEn: candidate.promptEn,
        negativePromptZh: candidate.negativePromptZh,
        negativePrompt: candidate.negativePrompt,
        context: usageContext
      })
      promptReviews.push({ attempt, source, ...review })
      return review
    }

    const fallbackReview = scoreCandidate(result, 'fallback', 0)

    if (provider && provider !== 'none') {
      logStage({ stage: 'asset.prompt_enhance', event: 'start', traceId, project: id, provider: provider || 'local', model: model || '-', item: assetId })
      let feedbackZh = buildPromptReviewFeedbackZh(body?.promptReview)
      if (forceRegenerate && feedbackZh) {
        feedbackZh = `${feedbackZh}。这是一次显式重新生成，必须优先根据这些问题重写，不要沿用原先措辞。`
      }
      // 2026-08-26 重构：循环内只让本地模型写中文稿并打分选优，胜出后才翻译一次。
      // 旧实现每轮 2 次并行翻译 + 增强，27B 在 32G/16K 环境下 KV 峰值翻倍（实测触发 oMLX prefill 内存护栏 400）。
      let aiWinner = null
      for (let attempt = 1; attempt <= maxRegenerateAttempts; attempt += 1) {
        const aiInput = {
          projectTitle: String(bundle?.project?.title || '').trim(),
          storyBibleJson: JSON.stringify(ctx.readStoryBibleFromProjectDoc(bundle.project) || {}),
          asset,
          plan,
          assetUsageContext: usageContext,
          promptReviewFeedbackZh: feedbackZh,
          globalPromptZh: body?.globalPromptZh,
          globalNegativePromptZh: body?.globalNegativePromptZh,
          currentPromptZh: rewriteFromScratch ? '' : ctx.sanitizeStoryAssetPromptZh({ asset, promptZh: body?.promptZh }),
          currentPromptEn: rewriteFromScratch ? '' : body?.promptEn,
          currentNegativePromptZh: rewriteFromScratch ? '' : body?.negativePromptZh,
          currentNegativePrompt: rewriteFromScratch ? '' : body?.negativePrompt
        }
        let enhanced = null
        try {
          enhanced = await Promise.race([
            enhanceStoryAssetPromptWithAi({
              input: aiInput,
              provider,
              model,
              apiUrl,
              proxyUrl
            }),
            new Promise((_, reject) => setTimeout(() => {
              const e = new Error('asset_prompt_enhance_timeout')
              e.status = 504
              reject(e)
            }, ['localoxml', 'ollama'].includes(provider) ? 300_000 : 60_000))
            // 2026-08-26 修复：本地模型原 15s 掐表必超时（27B 需 1-5 分钟），兜底模板横行；
            // 放宽后 AI 真正写完，模板只在 AI 失败时才上桌
          ])
        } catch (e) {
          const emsg = e instanceof Error ? e.message : String(e)
          // 2026-08-26：oMLX 内存护栏拒绝是瞬态（天花板随系统负载波动，实测差 0.03GB 也被拒），
          // 等待 25s 后重试而非直接兜底——慢可以，掉模板不行
          if (/prefill memory guard|prefill_memory_exceeded/i.test(emsg) && attempt < maxRegenerateAttempts) {
            logStage({ stage: 'asset.prompt_enhance', event: 'retry', traceId, project: id, item: assetId, attempt, err: 'omlx_memory_guard' })
            await new Promise((resolve) => setTimeout(resolve, 25_000))
            continue
          }
          throw e
        }
        if (!enhanced || !enhanced.result) continue
        const nextPromptZh = ctx.sanitizeStoryAssetPromptZh({ asset, promptZh: enhanced.result.promptZh }) || fallback.promptZh
        const nextNegativePromptZh = ctx.storyAssetStr(enhanced.result.negativePromptZh).trim() || fallback.negativePromptZh
        // 评分阶段英文沿用兜底件（仅供关键词评分参考），中文稿胜出后才翻译
        const review = scoreCandidate({
          promptZh: nextPromptZh,
          promptEn: fallback.promptEn,
          negativePromptZh: nextNegativePromptZh,
          negativePrompt: fallback.negativePrompt
        }, 'ai', attempt)
        if (!aiWinner || review.score > aiWinner.review.score) {
          aiWinner = {
            promptZh: nextPromptZh,
            negativePromptZh: nextNegativePromptZh,
            summary: ctx.storyAssetStr(enhanced.result.summary).trim() || fallback.summary,
            review
          }
        }
        meta = {
          ...(enhanced.meta || {}),
          provider: enhanced.meta?.provider || provider,
          model: enhanced.meta?.model || model || null,
          api: enhanced.meta?.api || apiUrl || null,
          durationMs: Math.max(0, Date.now() - startedAt)
        }
        if (!forceRegenerate && (review.passed || review.score >= minAcceptScore)) break
        feedbackZh = `${buildPromptReviewFeedbackZh(review)}。请根据这些问题完全重写，不要保留泛化模板。`
      }
      // 2026-08-26 修复：AI 中文稿有效即上桌。评分器只认固定字面关键词（纯白背景/无场景/单一物件），
      // 模板恰好自带这些词（实测 34 分），27B 语义正确的稿子实测仅 26-34 分，旧规则要求严格超过模板导致 AI 稿永不上桌。
      // 提示词终审是人的审核闸（第 4 步：确认中文稿 → 翻译 → 批准），此处评分仅作顾问；
      // 仅当 AI 稿遭硬性污染罚分（跨道具语义混入等，分数崩到阈值以下）时才保留模板兜底。
      if (aiWinner) {
        const fallbackScore = fallbackReview && Number.isFinite(fallbackReview.score) ? fallbackReview.score : 0
        const aiAcceptFloor = Math.max(20, fallbackScore - 15)
        if (aiWinner.review.score >= aiAcceptFloor) {
          const translated = await ctx.translateStoryAssetPromptPair({
            studio,
            promptZh: aiWinner.promptZh,
            negativePromptZh: aiWinner.negativePromptZh,
            fallbackPromptEn: fallback.promptEn,
            fallbackNegativePrompt: fallback.negativePrompt,
            timeoutMs: ['localoxml', 'ollama'].includes(provider) ? 300_000 : 60_000
          }).catch((translateErr) => {
            // 2026-10-07 可观测：内联翻译失败不再静默——落日志说明英文栏将回落到模板兜底件
            logStage({ stage: 'asset.prompt_enhance', event: 'translate_fallback', traceId, project: id, item: assetId, err: translateErr instanceof Error ? translateErr.message : String(translateErr) })
            return {
              promptEn: fallback.promptEn,
              negativePrompt: fallback.negativePrompt,
              meta: { provider: 'fallback', model: null, api: null, note: 'translation_fallback' }
            }
          })
          const sanitizedTranslated = ctx.sanitizeProtectedAssetPrompt({
            asset,
            promptEn: translated.promptEn,
            negativePrompt: translated.negativePrompt
          })
          result = {
            promptZh: aiWinner.promptZh,
            promptEn: sanitizedTranslated.promptEn || fallback.promptEn,
            negativePromptZh: aiWinner.negativePromptZh,
            negativePrompt: sanitizedTranslated.negativePrompt || fallback.negativePrompt,
            summary: aiWinner.summary,
            context: {
              ...(fallback.context || {}),
              aiGenerated: true,
              translatedBy: translated.meta || null
            }
          }
        }
      }
      if (!result || !ctx.storyAssetStr(result.promptZh).trim()) {
        result = {
          ...fallback,
          promptEn: fallbackSanitized.promptEn || fallback.promptEn,
          negativePrompt: fallbackSanitized.negativePrompt || fallback.negativePrompt
        }
      }
      if (meta.provider || meta.model || meta.api) {
        logStage({ stage: 'asset.prompt_enhance', event: 'ok', traceId, project: id, provider: meta.provider || provider || 'local', model: meta.model || model || '-', item: assetId, ok: true, durationMs: meta.durationMs })
      }
    }
  } catch (e) {
    aiError = {
      message: e instanceof Error ? e.message : String(e),
      status: e && e.status ? Number(e.status) : null,
      code: e && e.code ? String(e.code) : null
    }
    meta = {
      ...meta,
      provider: provider || 'local',
      model: model || null,
      api: apiUrl || null,
      durationMs: Math.max(0, Date.now() - startedAt),
      note: 'ai_failed_fallback_to_local_template'
    }
    logStage({ stage: 'asset.prompt_enhance', event: 'fail', traceId, project: id, provider: provider || 'local', model: model || '-', item: assetId, status: aiError.status || 500, ok: false, durationMs: meta.durationMs, err: aiError.message })
  }
  const finalReview = ctx.scoreStoryAssetPromptCandidate({
    asset,
    promptZh: result.promptZh,
    promptEn: result.promptEn,
    negativePromptZh: result.negativePromptZh,
    negativePrompt: result.negativePrompt,
    context: fallback.context && typeof fallback.context.usageContext === 'object' ? fallback.context.usageContext : undefined
  })
  result = {
    ...result,
    context: {
      ...(result.context && typeof result.context === 'object' ? result.context : {}),
      promptReview: finalReview
    }
  }
  recordCreationEvent(dir, {
    type: 'prompt_drafted',
    summary: `资产提示词起草：${assetId}（${meta.provider || 'local'}${finalReview && finalReview.score != null ? `，评分 ${finalReview.score}` : ''}）`,
    actor: 'prompt_flow',
    data: { assetId, provider: String(meta.provider || ''), score: finalReview && finalReview.score != null ? Number(finalReview.score) : null }
  })
  return c.json({ success: true, asset, result, meta, aiError, traceId, promptReview: finalReview, promptReviewAttempts: promptReviews, promptReviewThreshold: minAcceptScore })
})

app.post('/api/projects/:id/ai/story/assets/:assetId/gallery/delete', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const routeAssetId = ctx.storyAssetStr(c.req.param('assetId')).trim()
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const assetId = ctx.storyAssetStr(body && body.assetId).trim() || routeAssetId
  const assetPath = ctx.normalizeStoryAssetUri(body && body.assetPath)
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)
  if (!assetPath) return c.json({ success: false, error: 'missing_asset_path', message: 'assetPath 不能为空' }, 400)

  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => ctx.storyAssetStr(item && item.id).trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  try {
    const result = await ctx.deleteStoryAssetManagedFile({ id, dir, plan, asset, targetAssetPath: assetPath })
    const cleaned = await ctx.pruneMissingStoryAssetGalleryEntries({
      id,
      dir,
      plan: result.plan,
      asset: result.asset || asset
    })
    return c.json({
      success: true,
      ...result,
      plan: cleaned.plan,
      asset: cleaned.asset,
      items: cleaned.items
    })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const status = e && typeof e.status === 'number' ? e.status : 500
    return c.json({ success: false, error: 'story_asset_delete_failed', message: msg }, status)
  }
})

app.post('/api/projects/:id/ai/story/assets/reference/select', storyInputGate('story.assets.reference.lock', (c, body) => ({ projectId: c.req.param('id'), ...body })), async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const traceId = createTraceId()

  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  const targetAssetPath = String(body?.assetPath || body?.primaryReferenceAssetUri || '').trim().replace(/^\/+/, '')
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)
  if (!targetAssetPath) return c.json({ success: false, error: 'missing_asset_path', message: '请选择一个候选图作为主参考。' }, 400)

  let plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  const batch = Array.isArray(asset.latestReferenceBatch) ? asset.latestReferenceBatch : []
  const pickedCandidate = batch.find((item) => String(item?.assetPath || '').trim().replace(/^\/+/, '') === targetAssetPath) || null
  const generatedRef = Array.isArray(asset.generatedRefs)
    ? asset.generatedRefs.find((item) => String(item?.projectAssetUri || '').trim().replace(/^\/+/, '') === targetAssetPath)
    : null
  if (!pickedCandidate && !generatedRef) {
    return c.json({ success: false, error: 'candidate_not_found', message: '所选候选图不在当前资产的候选列表中。' }, 404)
  }

  // S4-01 写入门禁：仅「视觉评审真实通过」且「文件真实存在」的候选可写入 primaryReferenceAssetUri
  const candidateReview = pickedCandidate && pickedCandidate.analysis && typeof pickedCandidate.analysis === 'object'
    ? pickedCandidate.analysis
    : (
        asset.latestReferenceReview && typeof asset.latestReferenceReview === 'object' &&
        String(asset.latestReferenceReview.targetAssetUri || '').trim().replace(/^\/+/, '') === targetAssetPath
          ? asset.latestReferenceReview
          : null
      )
  const reviewGate = evaluateStoryAssetReferenceReview(candidateReview)
  // 人工特批（2026-08-30 用户指令）：AI 评审只是候选意见，人工可点击确认越过门禁；
  // 越权必须显式 manualOverride=true，且全程留痕（locked 记录带 manual_override 与被越过的评审结论）。
  const manualOverride = body?.manualOverride === true
  if (!reviewGate.passed && !manualOverride) {
    logStage({ stage: 'asset.reference.select', event: 'blocked', traceId, project: id, item: assetId, ok: false, err: reviewGate.code })
    return c.json({ success: false, error: reviewGate.code, message: reviewGate.message, review: candidateReview }, 409)
  }
  if (!reviewGate.passed && manualOverride) {
    logStage({ stage: 'asset.reference.select', event: 'manual_override', traceId, project: id, item: assetId, ok: true, err: reviewGate.code, detail: 'human_override_review_gate' })
  }
  const fileGate = await verifyStoryAssetReferenceFile({ dir, assetPath: targetAssetPath })
  if (!fileGate.ok) {
    logStage({ stage: 'asset.reference.select', event: 'fail', traceId, project: id, item: assetId, ok: false, err: fileGate.code })
    return c.json({ success: false, error: fileGate.code, message: fileGate.message }, 400)
  }

  try {
    logStage({ stage: 'asset.reference.select', event: 'start', traceId, project: id, item: assetId, ok: true, detail: 'transparent_cutout' })
    const studio = await getEffectiveStudioConfig(ctx.ROOT)
    const sourceRef = generatedRef || {
      projectAssetId: '',
      projectAssetUri: targetAssetPath,
      prompt: '',
      negativePrompt: '',
      width: undefined,
      height: undefined,
      seed: undefined,
      loras: undefined
    }
    const processed = await ctx.applyCutoutToStoryAssetReference({
      id,
      dir,
      plan,
      asset,
      sourceRef,
      studio,
      timeoutMs: body?.timeoutMs
    })
    plan = processed.plan
    const primaryReferenceAssetId = String(processed.primaryReferenceAssetId || '').trim()
    const primaryReferenceAssetUri = String(processed.primaryReferenceAssetUri || targetAssetPath).trim()
    plan = await ctx.setPrimaryStoryAssetReference({
      id,
      plan,
      assetId,
      primaryReferenceAssetId,
      primaryReferenceAssetUri,
      latestReferenceReview: pickedCandidate?.analysis || asset.latestReferenceReview || null,
      latestReferenceBatch: batch,
      selectedBatchAssetPath: targetAssetPath,
      resetLineart: true
    })
    const nextAsset = (Array.isArray(plan.assets) ? plan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null) || asset
    await ctx.writeStoryAssetPrimaryToProject({ id, dir, asset: nextAsset, primaryReferenceAssetId })
    // 2026-09-28：锁定即补齐提示词中文稿（模板兜底，失败不阻断选定）
    try {
      await ctx.backfillStoryAssetPromptDraftZh({ id, dir, plan, asset: nextAsset })
    } catch (_) { /* 回填失败不阻断选定结果 */ }
    // 结论留痕：选定即补写 lock_confirm（approved）。control 旁路链路（x-image-review-mode: off）同样落审核事实，
    // 否则出图总账的 locked 状态永远缺这部分资产。
    try {
      const lockTargetKey = `lock_confirm:${assetId}:${primaryReferenceAssetUri}`
      const decidedBy = ctx.resolveImageReviewMode(c, body) === 'off' ? 'control' : 'user'
      const pendingLock = await findPendingReview(dir, { phase: 'lock_confirm', targetKey: lockTargetKey })
      if (pendingLock) {
        await decideImageReview(dir, pendingLock.reviewId, { approved: true, decidedBy })
      } else {
        const lockRecord = await createImageReview(dir, {
          phase: 'lock_confirm',
          targetKey: lockTargetKey,
          assetId,
          prompt: String(nextAsset.anchorPrompt || '').trim(),
          resultImagePath: primaryReferenceAssetUri,
          aiReview: pickedCandidate?.analysis || asset.latestReferenceReview || null,
          params: manualOverride
            ? { manual_override: true, overriddenGateCode: reviewGate.code, overriddenGateMessage: reviewGate.message }
            : {}
        })
        await decideImageReview(dir, lockRecord.reviewId, { approved: true, decidedBy })
      }
    } catch (_) { /* 留痕失败不阻断选定结果 */ }
    recordCreationEvent(dir, {
      type: 'asset_locked',
      summary: `资产主参考锁定：${assetId} -> ${primaryReferenceAssetUri}${manualOverride ? '（人工特批）' : ''}`,
      actor: 'select_flow',
      data: { assetId, manualOverride }
    })
    logStage({ stage: 'asset.reference.select', event: 'ok', traceId, project: id, item: assetId, ok: true, detail: 'transparent_cutout' })
    return c.json({ success: true, asset: nextAsset, plan })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    logStage({ stage: 'asset.reference.select', event: 'fail', traceId, project: id, item: assetId, status: mapped.httpStatus, ok: false, err: msg })
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

app.post('/api/projects/:id/ai/story/assets/lineart', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const traceId = createTraceId()

  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  const primaryReferenceAssetUri = String(asset.primaryReferenceAssetUri || '').trim()
  if (!primaryReferenceAssetUri) {
    return c.json({ success: false, error: 'missing_reference_image', message: '请先从 4 张候选图中手动选择主参考，再生成线稿。' }, 400)
  }

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  const comfyuiBaseUrl = String(studio.effective.image.comfyuiBaseUrl || process.env.COMFYUI_BASE_URL || '').trim()
  if (!comfyuiBaseUrl) {
    return c.json({ success: false, error: 'missing_comfyui_base_url', message: '未配置 ComfyUI 地址，无法生成线稿。' }, 400)
  }

  const lineartPrompt = String(body?.prompt || '').trim() || (
    String(asset.category || '').trim() === 'character'
      ? `redraw the uploaded ${String(asset.name || asset.id || 'character').trim()} reference as clean black ink lineart, preserve exact species, face shape, fur markings, outfit silhouette, body proportions and pose, full body, one subject only, white background, monochrome, no color fill, no shading, no gray wash, no painterly rendering`
      : `redraw the uploaded ${String(asset.name || asset.id || 'prop').trim()} reference as clean black ink object lineart, preserve exact silhouette, handle, rim, strap, edge shape and proportions, single object only, centered, white background, monochrome, no color fill, no shading, no extra objects, no person`
  )
  const lineartNegative = String(body?.negativePrompt || '').trim() || 'color, watercolor, gouache, shading, shadow, grayscale wash, background scene, extra character, extra limbs, multiple views, text, logo, realistic photo'

  const lineartTargetName = String(asset.name || assetId).trim()
  const lineartTask = createAiTask(id, 'story.asset.lineart', {
    total: 1,
    message: `线稿准备：${lineartTargetName}`
  })

  // 出图前审核（manual 模式）：挂起并返回 202，批准后自动执行
  const reviewMode = ctx.resolveImageReviewMode(c, body)
  if (reviewMode === 'manual' && !(await ctx.hasApprovedPreGenerate(dir, c))) {
    const targetKey = `lineart:${assetId}`
    let review = await findPendingReview(dir, { phase: 'pre_generate', targetKey })
    if (!review) {
      review = await createImageReview(dir, {
        phase: 'pre_generate',
        targetKey,
        assetId,
        prompt: lineartPrompt,
        negativePrompt: lineartNegative,
        params: { kind: 'asset.lineart', targetName: String(asset.name || assetId).trim(), primaryReferenceAssetUri },
        execute: { endpoint: `/api/projects/${encodeURIComponent(id)}/ai/story/assets/lineart`, payload: body && typeof body === 'object' ? body : {} }
      })
    }
    updateAiTask(lineartTask.taskId, { stage: 'waiting_review', done: true, message: `出图前审核待批准：${lineartTargetName}` })
    return c.json({ success: true, pendingReview: review, taskId: lineartTask.taskId }, 202)
  }

  try {
    logStage({ stage: 'asset.lineart', event: 'start', traceId, project: id, item: assetId, ok: true, detail: 'controlnet_lineart_only' })
    const abs = path.join(dir, primaryReferenceAssetUri.replace(/^\/+/, ''))
    const refBytes = await readFile(abs)
    const { width: widthDefault, height: heightDefault } = ctx.getStoryAssetRenderSize(asset, resolveStoryStylePreset(studio))
    const result = await generateComfyuiLineartFromReference({
      referenceBytes: refBytes,
      referenceFilename: `${String(asset.id || 'asset').trim() || 'asset'}.png`,
      comfyuiBaseUrl,
      model: String(body?.model || studio.effective.image.model || '').trim(),
      controlnetModel: String(body?.controlnetModel || '').trim() || 'SDXL/controlnet-union-sdxl-1.0/diffusion_pytorch_model_promax.safetensors',
      width: ctx.clampInt(body?.width, 256, 2048, widthDefault),
      height: ctx.clampInt(body?.height, 256, 2048, heightDefault),
      preprocessor: String(asset.category || '').trim() === 'character' ? 'anime' : 'lineart',
      unionType: 'canny/lineart/anime_lineart/mlsd',
      prompt: lineartPrompt,
      negativePrompt: lineartNegative,
      steps: body?.steps,
      cfgScale: body?.cfgScale,
      denoise: body?.denoise,
      seed: body?.seed,
      timeoutMs: body?.timeoutMs,
      hintPrefix: ctx.buildStoryAssetComfyPrefix(asset, 'lineart_hint'),
      finalPrefix: ctx.buildStoryAssetComfyPrefix(asset, 'lineart_final'),
      onStage: (stage) => {
        if (stage === 'hint') updateAiTask(lineartTask.taskId, { stage: 'preprocessing', message: `线稿预处理中：${lineartTargetName}` })
        else if (stage === 'final') updateAiTask(lineartTask.taskId, { stage: 'redrawing', message: `线稿重绘中：${lineartTargetName}` })
      }
    })
    const persisted = await ctx.persistStoryAssetLineartResult({
      id,
      dir,
      plan,
      asset,
      hintBytes: result.hintBytes,
      hintExt: result.hintExt,
      finalBytes: result.finalBytes,
      finalExt: result.finalExt,
      meta: result.meta,
      prompt: lineartPrompt,
      negativePrompt: lineartNegative
    })
    logStage({ stage: 'asset.lineart', event: 'ok', traceId, project: id, item: assetId, ok: true, detail: 'controlnet_lineart_only' })
    recordCreationEvent(dir, {
      type: 'lineart_done',
      summary: `线稿生成完成：${assetId}`,
      actor: 'lineart_flow',
      data: { assetId, finalAssetPath: persisted.finalAssetPath }
    })
    // 同步到 project.json 的 aiBackground.storyAssetPlan，保证工作区线稿门卡立即可见
    try {
      const projectPath = path.join(dir, 'project.json')
      const projectDoc = await ctx.readJson(projectPath).catch(() => ({}))
      if (!projectDoc.state || typeof projectDoc.state !== 'object') projectDoc.state = {}
      if (!projectDoc.state.aiBackground || typeof projectDoc.state.aiBackground !== 'object') projectDoc.state.aiBackground = {}
      projectDoc.state.aiBackground.storyAssetPlan = persisted.plan
      projectDoc.updatedAt = ctx.nowIso()
      projectDoc._rev = Number(projectDoc._rev || 0) + 1
      await ctx.writeJson(projectPath, projectDoc)
    } catch (_) { /* 同步失败不阻断线稿结果 */ }
    updateAiTask(lineartTask.taskId, { stage: 'done', done: true, current: 1, message: `线稿完成：${lineartTargetName}` })
    return c.json({ success: true, taskId: lineartTask.taskId, asset: persisted.asset, plan: persisted.plan, hintAssetPath: persisted.hintAssetPath, finalAssetPath: persisted.finalAssetPath, hintUrl: persisted.hintUrl, finalUrl: persisted.finalUrl, meta: result.meta, prompt: lineartPrompt, negativePrompt: lineartNegative })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    updateAiTask(lineartTask.taskId, { stage: 'error', done: true, error: msg, message: msg })
    logStage({ stage: 'asset.lineart', event: 'fail', traceId, project: id, item: assetId, status: mapped.httpStatus, ok: false, err: msg })
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

// [拆分] GET /api/ai/comfyui/capability-check 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] POST /api/ai/comfyui/auto-fix 已迁至 apps/server/src/routes/studio.routes.js

app.post('/api/projects/:id/ai/story/lock/test', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const bundle = await ctx.readProjectBundle(id)
  let plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) {
    const storyBible = ctx.readStoryBibleFromProjectDoc(bundle.project)
    if (!storyBible || typeof storyBible !== 'object') {
      return c.json({ success: false, error: 'missing_story_bible', message: '未找到 Story Bible。请先生成 Story Bible 并创建资产计划。' }, 400)
    }
    plan = buildStoryAssetPlan({ project: bundle.project, story: bundle.story, storyBible, prevManifest: null })
    await ctx.saveStoryAssetPlan(id, plan, { mergeAssetsById: true })
  }

  // 显式 assetId 优先（control/事件链路按资产锁定）；缺省时沿用自动挑选逻辑（第一个未锁定资产）
  const requestedAssetId = String(body?.assetId || '').trim()
  const testTarget = requestedAssetId
    ? ((Array.isArray(plan.assets) ? plan.assets : []).find((a) => String(a && a.id || '').trim() === requestedAssetId) || null)
    : pickStoryboardLockTestAsset(plan)
  if (!testTarget) {
    return c.json({
      success: false,
      error: requestedAssetId ? 'asset_not_found' : 'missing_test_target',
      message: requestedAssetId ? `未找到故事资产：${requestedAssetId}` : '资产计划为空，无法执行锁定测试。'
    }, requestedAssetId ? 404 : 400)
  }

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
  const imgProvider = String(studio.effective.image.provider || process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()
  if (imgProvider !== 'comfyui') {
    return c.json({ success: false, error: 'story_lock_requires_comfyui', message: '锁定测试工作流目前仅支持 ComfyUI。' }, 400)
  }

  const requestedModel = normalizeComfyCheckpointName(body?.model || studio.effective.image.model || '')
  const requestedLoras = Array.isArray(body?.loras) ? body.loras.map((x) => String(x || '').trim()).filter(Boolean) : []
  if (!requestedModel) {
    return c.json({ success: false, error: 'missing_model_config', message: '请先在锁定事物标签中填写 checkpoint。' }, 400)
  }

  const style = ctx.normalizeStyleEnum(body?.style || 'picture_book')
  const width = ctx.clampInt(body?.width, 256, 2048, 512)
  const height = ctx.clampInt(body?.height, 256, 2048, 512)
  const steps = ctx.clampInt(body?.steps, 5, 80, 20)
  const cfgScale = Number.isFinite(Number(body?.cfgScale)) ? Number(body.cfgScale) : 7
  const samplerInput = body?.sampler || 'DPM++ 2M'
  const schedulerInput = body?.scheduler || 'Automatic'
  const sampler = mapComfySampler(samplerInput)
  const scheduler = mapComfyScheduler(schedulerInput, samplerInput)
  const timeoutMs = parseComfyTimeoutMs(body?.timeoutMs)
  const maxAttempts = ctx.clampInt(body?.maxAttempts, 1, 4, 3)
  const traceId = createTraceId()

  let positivePrompt = buildStoryboardLockTestPrompt({ plan, asset: testTarget, style })
  let negativePrompt = buildStoryboardLockTestNegativePrompt({ plan, asset: testTarget })
  const attempts = []
  let passed = false
  let finalSummary = ''

  logStage({
    stage: 'story.lock_test',
    event: 'start',
    traceId,
    project: id,
    provider: imgProvider,
    model: requestedModel || '-',
    item: `${String(testTarget.name || testTarget.id || 'asset').trim()} / attempts:${maxAttempts}`
  })

  const lockTask = createAiTask(id, 'story.lock_test', {
    total: maxAttempts,
    message: `锁定测试：${String(testTarget.name || testTarget.id || 'asset').trim()}`
  })
  updateAiTask(lockTask.taskId, { stage: 'preparing', message: '准备工作流…' })

  // 出图前审核（manual 模式）：无已批准审核时创建 pending 并挂起，批准后自动执行
  const reviewMode = ctx.resolveImageReviewMode(c, body)
  if (reviewMode === 'manual' && !(await ctx.hasApprovedPreGenerate(dir, c))) {
    const targetKey = `lock_test:${String(testTarget.id || '').trim()}`
    let review = await findPendingReview(dir, { phase: 'pre_generate', targetKey })
    if (!review) {
      review = await createImageReview(dir, {
        phase: 'pre_generate',
        targetKey,
        assetId: String(testTarget.id || '').trim(),
        prompt: positivePrompt,
        negativePrompt,
        params: { kind: 'story.lock_test', targetName: String(testTarget.name || '').trim(), model: requestedModel, width, height, steps, maxAttempts },
        execute: { endpoint: `/api/projects/${encodeURIComponent(id)}/ai/story/lock/test`, payload: body && typeof body === 'object' ? body : {} }
      })
    }
    updateAiTask(lockTask.taskId, { stage: 'waiting_review', done: true, message: `出图前审核待批准：${String(testTarget.name || testTarget.id || '').trim()}` })
    return c.json({ success: true, pendingReview: review, taskId: lockTask.taskId }, 202)
  }
  let pendingLockReview = null

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      updateAiTask(lockTask.taskId, { stage: 'generating', current: attempt, message: `第 ${attempt}/${maxAttempts} 次生成中…` })
      const workflow = await buildStoryboardLockTestWorkflow({
        model: requestedModel,
        loras: requestedLoras.length ? requestedLoras : studio.effective.image.loras,
        positivePrompt,
        negativePrompt,
        width,
        height,
        steps,
        cfgScale,
        samplerName: sampler,
        scheduler,
        // ComfyUI seed 有效范围 [0, 4294967295]；之前用 9_999_999_999 导致 57% 被 clamp 成固定值 4294967295，命中同一份空缓存
        seed: Math.floor(Math.random() * 4_294_967_296),
        filenamePrefix: ctx.buildStoryAssetComfyPrefix(testTarget, 'lock_test')
      })
      const gen = await runComfyuiPromptWorkflow({
        workflow,
        comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
        timeoutMs
      })
      const buf = gen.bytes
      const ext0 = String(gen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
      const sniff = sniffImageMetaFromBytes(buf)
      const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'
      const relDir = path.join('assets', 'ai', 'story_lock_tests')
      const outDir = path.join(dir, relDir)
      await mkdir(outDir, { recursive: true })
      const safeAssetSlug = String(testTarget.id || 'asset').replace(/[^a-z0-9_.-]+/gi, '_')
      const fname = `${safeAssetSlug}_attempt_${attempt}_${Date.now()}.${ext}`
      const abs = path.join(outDir, fname)
      await writeFile(abs, buf)
      let assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
      { // 2026-09-09 出图即压：锁定测试候选 WebP q92
        const opt = await optimizeGeneratedImage(abs, IMAGE_KIND.CANDIDATE).catch(() => null)
        if (opt && opt.outPath && opt.outPath !== abs) assetPath = String(ctx.assetPathFromAbsolute(id, opt.outPath) || assetPath)
      }
      const dataUrl = `data:${sniff?.contentType || (ext === 'jpg' ? 'image/jpeg' : 'image/png')};base64,${buf.toString('base64')}`

      updateAiTask(lockTask.taskId, { stage: 'reviewing', current: attempt, message: `第 ${attempt}/${maxAttempts} 次 AI 评审中…` })
      const analysis = await reviewStoryboardLockImageWithAi({
        provider: process.env.MOONSHOT_API_KEY ? 'moonshot' : studio.effective.prompt.provider,
        model: process.env.MOONSHOT_API_KEY ? 'kimi-for-coding' : studio.effective.prompt.model,
        apiUrl: studio.effective.prompt.apiUrl,
        proxyUrl: studio.effective.network.proxyUrl,
        moonshotApiKey: process.env.MOONSHOT_API_KEY || '',
        moonshotBaseUrl: process.env.MOONSHOT_BASE_URL || 'https://api.kimi.com/coding/v1',
        asset: testTarget,
        prompt: positivePrompt,
        negativePrompt,
        imageDataUrl: dataUrl,
        attempt,
        maxAttempts
      })

      attempts.push({
        attempt,
        assetId: String(testTarget.id || '').trim(),
        assetName: String(testTarget.name || testTarget.id || '').trim(),
        prompt: positivePrompt,
        negativePrompt,
        assetPath,
        url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`,
        remoteUrl: String(gen?.meta?.url || '').trim() || undefined,
        analysis
      })

      if (analysis && analysis.passed) {
        passed = true
        finalSummary = String(analysis.summary || '锁定测试已通过').trim() || '锁定测试已通过'
        if (reviewMode === 'manual') {
          // Step D（manual）：AI 评审通过后先挂人工确认，approve 后才真正落锁
          pendingLockReview = await createImageReview(dir, {
            phase: 'lock_confirm',
            targetKey: `lock_confirm:${String(testTarget.id || '').trim()}:${assetPath}`,
            assetId: String(testTarget.id || '').trim(),
            prompt: positivePrompt,
            negativePrompt,
            resultImagePath: assetPath,
            aiReview: analysis
          })
          finalSummary = `AI 评审通过（${Number(analysis.score) || '-'} 分），待人工确认锁定：${String(testTarget.name || testTarget.id || '').trim()}`
        } else {
          // Step D：测试图通过评审后，写入 asset.primaryReferenceAssetUri 并持久化
          try {
            await ctx.persistPrimaryReferenceLock(id, dir, String(testTarget.id || '').trim(), assetPath)
          } catch (_) { /* 持久化失败不阻断测试结果 */ }
          // 结论留痕（off/ai_only 模式直接落锁时同样补写 lock_confirm approved 记录，否则出图总账 locked 缺这批资产）
          try {
            const offTargetKey = `lock_confirm:${String(testTarget.id || '').trim()}:${assetPath}`
            const offDecidedBy = reviewMode === 'off' ? 'control' : 'system'
            const pendingLock = await findPendingReview(dir, { phase: 'lock_confirm', targetKey: offTargetKey })
            if (pendingLock) {
              await decideImageReview(dir, pendingLock.reviewId, { approved: true, decidedBy: offDecidedBy })
            } else {
              const lockRec = await createImageReview(dir, {
                phase: 'lock_confirm',
                targetKey: offTargetKey,
                assetId: String(testTarget.id || '').trim(),
                prompt: positivePrompt,
                negativePrompt,
                resultImagePath: assetPath,
                aiReview: analysis
              })
              await decideImageReview(dir, lockRec.reviewId, { approved: true, decidedBy: offDecidedBy })
            }
          } catch (_) { /* 留痕失败不阻断测试结果 */ }
        }
        break
      }

      positivePrompt = String((analysis && analysis.revisedPrompt) || positivePrompt).trim() || positivePrompt
      negativePrompt = String((analysis && analysis.revisedNegativePrompt) || negativePrompt).trim() || negativePrompt
      finalSummary = String((analysis && analysis.summary) || '锁定测试未通过').trim() || '锁定测试未通过'
    }

    if (!passed && !finalSummary) {
      finalSummary = `锁定测试未通过，已达到最大重试次数（${maxAttempts}）`
    } else if (passed) {
      finalSummary = finalSummary || `锁定测试通过：${String(testTarget.name || testTarget.id || 'asset')}`
    }

    logStage({
      stage: 'story.lock_test',
      event: passed ? 'ok' : 'fail',
      traceId,
      project: id,
      provider: imgProvider,
      model: requestedModel || '-',
      item: `${String(testTarget.name || testTarget.id || 'asset').trim()} / attempts:${attempts.length}`
    })

    updateAiTask(lockTask.taskId, {
      stage: pendingLockReview ? 'waiting_review' : (passed ? 'passed' : 'failed'),
      done: true,
      message: finalSummary,
      result: { passed, pendingReviewId: pendingLockReview ? pendingLockReview.reviewId : undefined }
    })
    return c.json({
      success: true,
      passed,
      summary: finalSummary,
      taskId: lockTask.taskId,
      pendingReview: pendingLockReview || undefined,
      testTarget: {
        id: String(testTarget.id || '').trim(),
        name: String(testTarget.name || '').trim(),
        category: String(testTarget.category || '').trim(),
        anchorPrompt: String(testTarget.anchorPrompt || '').trim(),
        referencePromptHint: String(testTarget.referencePromptHint || '').trim()
      },
      attempts
    })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    logStage({
      stage: 'story.lock_test',
      event: 'error',
      traceId,
      project: id,
      provider: imgProvider,
      model: requestedModel || '-',
      item: msg
    })
    updateAiTask(lockTask.taskId, { stage: 'error', done: true, error: msg, message: msg })
    return c.json({ success: false, error: mapped.code, message: msg, taskId: lockTask.taskId }, mapped.httpStatus)
  }
})
}
