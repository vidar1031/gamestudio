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
import { createAiTask, listAiTasks, updateAiTask } from '../ai/taskProgress.js'
import { generateBackgroundImage, generateComfyuiLineartFromReference, generateComfyuiCutoutFromReference, generateComfyuiPoseVariantSprite, generateComfyuiMvAdapterModelSheet, mapComfySampler, mapComfyScheduler, normalizeComfyCheckpointName, parseComfyTimeoutMs, runComfyuiPromptWorkflow } from '../ai/background.js'
import { optimizeGeneratedImage, IMAGE_KIND } from '../ai/imageOptimize.js'
import { buildStoryAssetPlan, buildStoryAssetReferenceNegativePrompt, buildStoryAssetReferencePrompt, getStoryAssetRenderProfile, repairStoryAssetPlanSceneLinks, resolveStoryStylePreset, summarizeStoryAssetPlan } from '../ai/storyAssets.js'
import { chooseStoryboardAssetLoras } from '../ai/storyAssetText.js'
import { applyAssetNameMapping, normalizeAssetNames } from '../ai/storyAssetNameNormalize.js'
import { buildStoryboardLockTestNegativePrompt, buildStoryboardLockTestPrompt, buildStoryboardLockTestWorkflow, pickStoryboardLockTestAsset, reviewStoryboardLockImageWithAi } from '../ai/storyLock.js'
import { evaluateStoryAssetReferenceReview, sniffImageMetaFromBytes, verifyStoryAssetReferenceFile } from '../ai/storyAssetReferenceGate.js'
import { analyzeSceneElements } from '../ai/sceneElementAnalysis.js'
import { generateStoryboardGlobalPromptWithAi, normalizeStoryboardPromptReviewInput } from '../ai/storyboardPromptReview.js'
import { enhanceStoryAssetPromptWithAi } from '../ai/storyAssetPromptEnhance.js'
import { getEffectiveStudioConfig } from '../studio/settings.js'
import { createImageReview, decideImageReview, findPendingReview } from '../review/imageReviewStore.js'
import { isAnimalLikeAnchor } from '../ai/storyPoseVariants.js'
import { MODEL_SHEET_VIEWS, MODEL_SHEET_VIEW_IPADAPTER, MODEL_SHEET_VIEW_IPADAPTER_ANIMAL, MODEL_SHEET_VIEW_LABELS, MODEL_SHEET_VIEW_NEGATIVE_EXTRA, MODEL_SHEET_VIEW_SKELETON, MODEL_SHEET_CHARTURN_LORA, MODEL_SHEET_CHARTURN_LORA_BACK, buildColorAnchorEn, buildModelSheetNegativePrompt, buildModelSheetWholeNegativePrompt, buildModelSheetViewPrompt, isBgPureEnough, upsertModelSheetTestRun, upsertModelSheetView } from '../ai/storyModelSheet.js'
import { renderSizeOf } from '../ai/storyRenderSizes.js'
import { recordCreationEvent } from '../creationBuffer.js'
import { storyInputGate } from '../middleware/storyInputGate.js'

export function registerStoryAssetsRoutes(app, ctx) {
// 2026-10-21 蓝图 B2+：逐场景 AI 元素分析（场景文本 → LLM 提取背景/角色/道具 → 写回 plan.json 同源，幂等）
app.post('/api/projects/:id/ai/story/scenes/:sceneId/analyze-elements', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const sceneId = String(c.req.param('sceneId') || '').trim()
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.prompt) {
    return c.json({ success: false, error: 'disabled', message: '「提示词生成」已在设置中关闭' }, 503)
  }
  const provider = String(studio.effective.prompt.provider || '').trim().toLowerCase()
  if (!provider || provider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用「提示词生成」并选择 Provider/Model' }, 400)
  }

  const startedAt = Date.now()
  const traceId = createTraceId()
  logStage({ stage: 'story.scene.analyze_elements', event: 'start', traceId, project: id, item: sceneId })
  // 明面执行纪律（2026-10-21 用户指令）：分析入全局任务台账，UI 任务指示器可见进度/成败，不走黑盒
  const task = createAiTask(id, 'story.scene.analyze_elements', { total: 1, message: `场景元素分析：${sceneId}` })
  try {
    // story.json 缺失不致命（蓝图阶段常态）：bundle 读取失败按空故事处理，真相源回退到 blueprint.json
    const bundle = await ctx.readProjectBundle(id).catch(() => null)
    const dir = ctx.projectDir(id)
    const storyNodes = Array.isArray(bundle?.story?.nodes) ? bundle.story.nodes : []
    // 真相源顺序修正（2026-10-25 用户实测 P1）：蓝图阶段 story.json 可能不存在——先 story 后蓝图节点兜底，
    // 蓝图阶段的真相源是 blueprint.json（节点 id 与编译后 story 同源 bn_sc_*）。
    let node = storyNodes.find((n) => String(n?.id || '') === sceneId)
    if (node) {
    } else {
      const blueprint = await ctx.readJson(path.join(dir, 'blueprint.json')).catch(() => null)
      const bpNodes = Array.isArray(blueprint?.nodes) ? blueprint.nodes : []
      const bpNode = bpNodes.find((n) => String(n?.id || '') === sceneId)
      if (!bpNode) {
        const msg = '该场景不在蓝图结构里（请先在脚本层解析生成蓝图）'
        updateAiTask(task.taskId, { done: true, stage: 'failed', error: msg })
        return c.json({ success: false, error: 'missing_scene', message: msg }, 400)
      }
      node = { id: bpNode.id, name: bpNode.name, body: { text: bpNode.textDraft } }
    }
    let plan = await ctx.readStoryAssetPlanIfExists(id)
    if (!plan) {
      // 冷启动（2026-10-21 用户实测修复）：蓝图阶段逐场景分析应能从零累积计划——
      // 无计划时按场景节点建骨架（场景清单+空资产表），分析结果随后幂等合入，不再拒绝。
      const sceneSource = storyNodes.length
        ? storyNodes
        : (await ctx.readJson(path.join(dir, 'blueprint.json')).catch(() => null))?.nodes?.filter?.((n) => n?.kind === 'scene') || []
      plan = {
        schemaVersion: '1.0',
        generatedAt: ctx.nowIso(),
        assets: [],
        scenes: sceneSource.map((n, i) => ({
          sceneId: String(n?.id || ''),
          sceneIndex: i + 1,
          sceneName: String(n?.name || n?.id || ''),
          assetIds: [],
          promptAssets: []
        })),
        summary: null
      }
    }

    const sceneText = [node?.body?.text, node?.name].filter(Boolean).join('\n')
    const result = await analyzeSceneElements({
      plan,
      sceneId,
      sceneName: String(node?.name || ''),
      sceneText,
      provider,
      model: studio.effective.prompt.model || undefined,
      apiUrl: studio.effective.prompt.apiUrl || undefined,
      proxyUrl: studio.effective.network.proxyUrl || undefined,
      timeoutMs: 120_000
    })

    const nextPlan = { ...result.plan }
    nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
    await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
    updateAiTask(task.taskId, { done: true, stage: 'done', current: 1, message: `分析完成：${result.elements.length} 个元素（新增 ${result.added} · 更新 ${result.updated}）` })
    logStage({
      stage: 'story.scene.analyze_elements',
      event: 'ok',
      traceId,
      project: id,
      item: `${sceneId} elements=${result.elements.length} added=${result.added} updated=${result.updated}`,
      ok: true,
      durationMs: Math.max(0, Date.now() - startedAt)
    })
    return c.json({
      success: true,
      sceneId,
      sceneElements: result.elements.length,
      elements: result.elements,
      added: result.added,
      updated: result.updated,
      meta: result.meta || null
    })
  } catch (e) {
    const rawMsg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    // 2026-10-21 失败文案用户化（禁止裸技术串）：租约阻断与模型不可达给下一步引导
    let msg = rawMsg
    if (/resource_scheduler_unreachable/.test(rawMsg)) {
      msg = '守护台离线且资源租约已启用：请启动守护台，或到 设置 → 守护台关联 关闭后重试'
    } else if (/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(rawMsg)) {
      msg = '文本模型服务不可达：请确认本地模型服务（OMLX :18888）已启动并加载模型，或到设置检查「提示词生成」的接口地址'
    }
    console.error(`[story.scene.analyze_elements] project=${id} scene=${sceneId} error=${rawMsg}`)
    logStage({ stage: 'story.scene.analyze_elements', event: 'error', traceId, project: id, item: rawMsg.slice(0, 300) })
    updateAiTask(task.taskId, { done: true, stage: 'failed', error: msg })
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

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
  // 2026-10-27 黑盒治理：全局稿生成入任务台账
  const globalTask = createAiTask(id, 'story.global_prompt.generate', { total: 1, message: '全局提示词生成（结合 Story Bible）' })
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
    updateAiTask(globalTask.taskId, { done: true, stage: 'done', current: 1, message: '全局提示词已生成' })
    return c.json({ success: true, result: generated.result, meta: generated.meta || null, traceId })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const mapped = classifyAiError(e)
    logStage({ stage: 'storyboard.global_prompt_generate', event: 'fail', traceId, project: id, provider, model: studio.effective.prompt.model || '-', status: mapped.httpStatus, ok: false, durationMs: Math.max(0, Date.now() - startedAt), err: msg })
    try {
      updateAiTask(globalTask.taskId, { done: true, stage: 'failed', error: `全局提示词生成失败：${msg.slice(0, 160)}` })
    } catch {}
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

// M 波（2026-10-27）：AI 补齐中文名——LLM 产 {id→中文名} 映射（候选），确定性双修写回：
// plan 资产名 + 圣经实体名（characters/props/locations）同改；id/aliases/sceneIds/构图引用不动。
// 挂 aiTask；非中文输出跳过并如实汇总；失败人话化。
app.post('/api/projects/:id/ai/story/assets/normalize-names', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.prompt) {
    return c.json({ success: false, error: 'disabled', message: '「提示词生成」已在设置中关闭' }, 503)
  }
  const provider = String(studio.effective.prompt.provider || '').trim().toLowerCase()
  if (!provider || provider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用「提示词生成」并选择 Provider/Model' }, 400)
  }
  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)

  const task = createAiTask(id, 'story.assets.normalize_names', { total: 1, message: '元素名补齐：AI 整理中文名' })
  const traceId = createTraceId()
  try {
    const bundle = await ctx.readProjectBundle(id)
    const storyBible = ctx.readStoryBibleFromProjectDoc(bundle.project)
    const sceneSummaries = (Array.isArray(bundle?.story?.nodes) ? bundle.story.nodes : [])
      .filter((n) => ['scene', 'ending'].includes(String(n?.kind || '')))
      .map((n) => ({ sceneId: String(n?.id || ''), name: String(n?.name || ''), summary: String(n?.body?.text || '').slice(0, 200) }))
    const { mapping, skipped, meta } = await normalizeAssetNames({
      assets: plan.assets,
      storyTitle: String(bundle?.project?.title || ''),
      sceneSummaries,
      provider,
      model: studio.effective.prompt.model || undefined,
      apiUrl: studio.effective.prompt.apiUrl || undefined,
      proxyUrl: studio.effective.network.proxyUrl || undefined,
      timeoutMs: 120_000
    })
    const { nextPlan, nextBible, changed } = applyAssetNameMapping({ plan, bible: storyBible, mapping })
    if (changed.length) {
      const finalPlan = { ...nextPlan, generatedAt: ctx.nowIso() }
      finalPlan.summary = summarizeStoryAssetPlan(finalPlan)
      await ctx.saveStoryAssetPlan(id, finalPlan, { mergeAssetsById: true })
      // 圣经实体名双修：写回 project.json 的 storyBible（characters/props/locations[].name）
      if (storyBible && typeof storyBible === 'object') {
        const projectPath = path.join(dir, 'project.json')
        const projectDoc = await ctx.readJson(projectPath).catch(() => null)
        if (projectDoc && typeof projectDoc === 'object') {
          if (!projectDoc.state || typeof projectDoc.state !== 'object') projectDoc.state = {}
          if (!projectDoc.state.aiBackground || typeof projectDoc.state.aiBackground !== 'object') projectDoc.state.aiBackground = {}
          projectDoc.state.aiBackground.storyBible = nextBible
          projectDoc.state.aiBackground.storyBibleJson = JSON.stringify(nextBible)
          await ctx.writeJson(projectPath, projectDoc)
        }
      }
    }
    const changedText = changed.map((x) => `${x.from}→${x.to}`).join('、')
    updateAiTask(task.taskId, {
      done: true,
      stage: 'done',
      current: 1,
      message: changed.length ? `元素名补齐：已改 ${changed.length} 个（${changedText.slice(0, 120)}）` : '元素名补齐：全部已是中文，无需改动'
    })
    logStage({ stage: 'story.assets.normalize_names', event: 'ok', traceId, project: id, item: `changed:${changed.length} skipped:${skipped.length}` })
    return c.json({ success: true, changed, skipped, meta: meta || null })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    const human = (() => {
      if (/empty_ai_output/.test(msg)) return 'AI 未产出内容（本地模型繁忙或内存不足），可重试'
      if (/timeout|timed out|超时/i.test(msg)) return '生成超时，可重试'
      if (/invalid|parse/i.test(msg)) return 'AI 输出格式异常，可重试'
      if (/fetch failed|ECONNREFUSED|ETIMEDOUT/i.test(msg)) return '文本模型服务不可达：请确认本地模型服务（OMLX :18888）已启动'
      return msg.slice(0, 160)
    })()
    try {
      updateAiTask(task.taskId, { done: true, stage: 'failed', error: human })
    } catch {}
    logStage({ stage: 'story.assets.normalize_names', event: 'error', traceId, project: id, item: msg.slice(0, 300) })
    return c.json({ success: false, error: mapped.code, message: human }, mapped.httpStatus)
  }
})

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
// 手工新增计划资产（2026-10-26 用户实测修复：要素库 + 号应产出真实计划资产，不是写进废弃占位库）。
// 幂等（同名同类合并）；可选 sceneId 直接分配到幕；写盘走 saveStoryAssetPlan 纪律。
app.post('/api/projects/:id/ai/story/plan/assets', async (c) => {
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const name = String(body?.name || '').trim()
  const category = String(body?.category || '').trim()
  const sceneId = String(body?.sceneId || '').trim()
  if (!name) return c.json({ success: false, error: 'bad_request', message: '需要元素名称' }, 400)
  if (!['character', 'location', 'prop'].includes(category)) {
    return c.json({ success: false, error: 'bad_request', message: '类目须为 character/location/prop' }, 400)
  }
  let plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) {
    plan = { schemaVersion: '1.0', generatedAt: ctx.nowIso(), assets: [], scenes: [], summary: null }
  }
  const assets = Array.isArray(plan.assets) ? plan.assets : []
  const dup = assets.find((a) => String(a?.name || '').trim() === name && String(a?.category || '').trim() === category)
  let asset = dup || null
  let added = false
  if (!asset) {
    asset = { id: genId('el'), name, category, referenceStatus: 'none', aliases: [], sceneIds: [], createdAt: ctx.nowIso() }
    assets.push(asset)
    added = true
  }
  const scenes = Array.isArray(plan.scenes) ? plan.scenes : []
  if (sceneId) {
    const scene = scenes.find((s) => String(s?.sceneId || '') === sceneId)
    if (scene) {
      const ids = new Set(Array.isArray(scene.assetIds) ? scene.assetIds.map((x) => String(x)) : [])
      ids.add(asset.id)
      scene.assetIds = Array.from(ids)
      scene.assignedAt = new Date().toISOString()
    }
  }
  const nextPlan = { ...plan, assets, scenes }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
  return c.json({ success: true, asset: { id: asset.id, name: asset.name, category: asset.category }, added, assigned: Boolean(sceneId) })
})

// 要素分配写口（2026-10-25 用户指令）：蓝图层右栏「要素分配」激活——把计划元素分配到场景（或移除），
// 写 plan.scenes[].assetIds（同源），预演/构图/合成摆位全从这里长。幂等；保存走既有 mergeAssetsById 纪律。
// 2026-11-10 根修（用户裁决：背景元素分配必须端到端生效）：三处同步——
//   ① scene.assetIds（蓝图/预演要素清单）；② scene.promptAssets（场景出图 prompt 纳入——
//   render spec 只读 promptAssets，空时才回退资产侧反推）；③ asset.sceneIds（摆位链消费口径，
//   placementDecision 按资产侧 sceneIds 判定进场）。此前只写 ①，分配后出图/摆位都不含新元素。
app.post('/api/projects/:id/ai/story/plan/scenes/:sceneId/assign', async (c) => {
  const id = c.req.param('id')
  const sceneId = String(c.req.param('sceneId') || '').trim()
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_plan', message: '还没有资产计划：先在蓝图做一次场景元素分析' }, 400)
  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  const action = String(body?.action || '').trim().toLowerCase()
  if (!assetId || (action !== 'add' && action !== 'remove')) {
    return c.json({ success: false, error: 'bad_request', message: '需要 assetId 与 action（add/remove）' }, 400)
  }
  const assets = Array.isArray(plan.assets) ? plan.assets : []
  const asset = assets.find((a) => String(a?.id || '') === assetId)
  if (!asset) {
    return c.json({ success: false, error: 'asset_not_in_plan', message: '该元素不在资产计划里' }, 400)
  }
  const scenes = Array.isArray(plan.scenes) ? plan.scenes : []
  const scene = scenes.find((s) => String(s?.sceneId || '') === sceneId)
  if (!scene) return c.json({ success: false, error: 'scene_not_in_plan', message: '该幕不在资产计划里' }, 400)
  const ids = new Set(Array.isArray(scene.assetIds) ? scene.assetIds.map((x) => String(x)) : [])
  const before = ids.size
  if (action === 'add') ids.add(assetId)
  else ids.delete(assetId)
  scene.assetIds = Array.from(ids)
  // ② scene.promptAssets（对象镜像，场景出图 prompt 消费）：add 时按 live 资产补同构条目，remove 时按 id 剔除
  const promptAssets = Array.isArray(scene.promptAssets) ? [...scene.promptAssets] : []
  const paIdx = promptAssets.findIndex((x) => String(x && x.id || '') === assetId)
  if (action === 'add' && paIdx < 0) {
    promptAssets.push({
      id: String(asset.id || ''),
      name: String(asset.name || asset.id || ''),
      category: String(asset.category || ''),
      ...(asset.lockProfile ? { lockProfile: String(asset.lockProfile) } : {}),
      ...(asset.lockWorkflow ? { lockWorkflow: String(asset.lockWorkflow) } : {}),
      ...(asset.renderStrategy ? { renderStrategy: String(asset.renderStrategy) } : {}),
      referenceStatus: String(asset.referenceStatus || ''),
      primaryReferenceAssetId: String(asset.primaryReferenceAssetId || ''),
      primaryReferenceAssetUri: String(asset.primaryReferenceAssetUri || ''),
      anchorPrompt: String(asset.anchorPrompt || ''),
      ...(asset.negativePrompt ? { negativePrompt: String(asset.negativePrompt) } : {})
    })
  } else if (action === 'remove' && paIdx >= 0) {
    promptAssets.splice(paIdx, 1)
  }
  scene.promptAssets = promptAssets
  scene.assignedAt = new Date().toISOString()
  // ③ asset.sceneIds（摆位链消费口径）
  const aIds = new Set(Array.isArray(asset.sceneIds) ? asset.sceneIds.map((x) => String(x || '').trim()).filter(Boolean) : [])
  if (action === 'add') aIds.add(sceneId)
  else aIds.delete(sceneId)
  asset.sceneIds = Array.from(aIds)
  const nextPlan = { ...plan, assets, scenes }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
  return c.json({ success: true, sceneId, assetId, action, sceneAssetCount: scene.assetIds.length, changed: before !== scene.assetIds.length })
})

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

  let refTask = null
  try {
    logStage({ stage: 'asset.reference.batch', event: 'start', traceId, project: id, item: assetId, ok: true, detail: 'generate_candidates_only' })
    // 2026-11-10 同资产并发护栏（用户裁决：发起后不得重复触发造成任务叠加）——
    // 客户端按钮防重只覆盖同会话；刷新/另一会话再点时由服务端兜底拒 409。
    const runningRefTask = listAiTasks(id, { includeDone: false }).find((t) => t.kind === 'story.asset.reference_batch' && String(t.assetId || '') === assetId)
    if (runningRefTask) {
      return c.json({ success: false, error: 'reference_batch_running', message: `「${String(asset.name || assetId).trim()}」已有进行中的抽卡任务，请等待完成或先在任务条停止它`, taskId: runningRefTask.taskId }, 409)
    }
    // 2026-08-29 出图可观测（AGENTS.md 强制规则）：参考图抽卡批次必须在 UI 暴露真实进度，禁止黑盒
    // 2026-11-10 根修：refTask 提升到 try 外——此前 const 在 try 块内，catch 里 typeof 恒 'undefined'，
    // 失败时任务永远不被标记 failed，残留"进行中"直到重启被标 interrupted（稻草堆 4 连击悬空事故）。
    refTask = createAiTask(id, 'story.asset.reference_batch', {
      total: batchSize,
      assetId,
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
      // S 波代跑实测根修：补偿重抽时 current 超 total（"第 6/4 张"倒挂）——进度语义改为 尝试序号/尝试上限 + 候选实时计数
      updateAiTask(refTask.taskId, { stage: 'generating', current: rawCandidates.length, total: batchSize, message: `第 ${i + 1}/${maxAttempts} 次尝试（候选 ${rawCandidates.length}/${batchSize}）：${String(asset.name || assetId).trim()}` })
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
      updateAiTask(refTask.taskId, { stage: 'reviewing', current: rawCandidates.length, total: batchSize, message: `第 ${i + 1}/${maxAttempts} 次尝试评审中（候选 ${rawCandidates.length}/${batchSize}）` })
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
  // 2026-10-27 黑盒治理：提示词增强入任务台账（单项一条；批量由编辑器侧串行汇总，逐项进度在此可见）
  const enhanceTask = createAiTask(id, 'story.asset.prompt_enhance', { total: 1, message: `提示词增强：${String(asset?.name || assetId).slice(0, 24)}` })

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
  // 2026-10-27：台账收口（aiError 非空=AI 失败保留原稿——记 failed 带人话原因；否则 done）
  if (aiError) {
    updateAiTask(enhanceTask.taskId, { done: true, stage: 'failed', error: `AI 增强失败（已保留原稿）：${String(aiError.message || aiError).slice(0, 160)}` })
  } else {
    updateAiTask(enhanceTask.taskId, { done: true, stage: 'done', current: 1, message: `提示词增强完成：${String(asset?.name || assetId).slice(0, 24)}` })
  }
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

// ---------------------------------------------------------------------------
// 标准系三视图：支持整 sheet、CharTurn 逐视角和 MV-Adapter 独立视角试验。
// 正面始终使用已锁主参考；试验只写 modelSheet.testRuns，不改变正式候选与锁定凭据。
app.post('/api/projects/:id/ai/story/assets/:assetId/model-sheet/generate', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const assetId = String(c.req.param('assetId') || '').trim()
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = (Array.isArray(plan.assets) ? plan.assets : []).find((a) => String(a && a.id || '').trim() === assetId) || null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)
  const assetName = String(asset.name || assetId).trim()

  // 三视图：角色+道具都出（T 波用户裁决：所有元素都出三视图——房子类道具有角度展示需求）；
  // 地点仍不出（背景封装语义不动）
  const category = String(asset.category || '').trim()
  if (category === 'location') {
    return c.json({ success: false, error: 'model_sheet_location_excluded', message: `「${assetName}」是地点：地点随场景背景出图（背景封装），不出三视图。` }, 400)
  }
  // 前置：主参考已锁（三视图以已锁主参考为身份锚）
  const primaryUri = String(asset.primaryReferenceAssetUri || '').trim()
  if (!primaryUri && !String(asset.primaryReferenceAssetId || '').trim()) {
    return c.json({ success: false, error: 'primary_reference_not_locked', message: `请先锁定「${assetName}」的主参考（参考图抽卡→选定锁定），再生成标准系三视图。` }, 409)
  }

  const body = await c.req.json().catch(() => ({}))
  const viewsIn = Array.isArray(body?.views) ? body.views.map((x) => String(x || '').trim()) : []
  const views = (viewsIn.length ? viewsIn : MODEL_SHEET_VIEWS).filter((v) => MODEL_SHEET_VIEWS.includes(v))
  if (!views.length) return c.json({ success: false, error: 'invalid_views', message: `views 仅支持 ${MODEL_SHEET_VIEWS.join('/')}（逐视角单图）` }, 400)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
  const stylePreset = resolveStoryStylePreset(studio)
  const globalStyleEn = String(stylePreset?.stylePromptEn || '').trim()
  const engine = String(body?.engine || 'charturn').trim().toLowerCase()
  if (!['charturn', 'mvadapter'].includes(engine)) {
    return c.json({ success: false, error: 'invalid_model_sheet_engine', message: 'engine 仅支持 charturn/mvadapter' }, 400)
  }
  const experiment = body?.experiment === true
  const runId = String(body?.runId || (experiment ? `sheet_${Date.now()}_${crypto.randomBytes(4).toString('hex')}` : '')).trim()
  const seed = body?.seed === undefined || body?.seed === null || body?.seed === '' ? null : Number(body.seed)
  if (seed !== null && (!Number.isInteger(seed) || seed < 0 || seed > 4_294_967_295)) {
    return c.json({ success: false, error: 'invalid_model_sheet_seed', message: 'seed 必须是 0 到 4294967295 的整数' }, 400)
  }
  const modelSheetBaseLoras = chooseStoryboardAssetLoras({ asset, requestedLoras: studio.effective.image.loras, stylePreset })
  const withCharturnLora = (charturn) => [
    ...modelSheetBaseLoras.filter((entry) => !String(entry).toLowerCase().startsWith('il-xl-charturn-merged.safetensors:')),
    charturn
  ]
  const sheetTask = createAiTask(id, 'story.asset.model_sheet', {
    total: views.length,
    message: `标准系三视图：${assetName}（${views.map((v) => MODEL_SHEET_VIEW_LABELS[v]).join('/')}，${engine}）`
  })

  // 出图前审核（manual 模式）：挂起并返回 202，批准后自动执行
  const reviewMode = ctx.resolveImageReviewMode(c, body)
  if (reviewMode === 'manual' && !(await ctx.hasApprovedPreGenerate(dir, c))) {
    const targetKey = `model_sheet:${assetId}:${engine}:${runId || views.join(',')}`
    let review = await findPendingReview(dir, { phase: 'pre_generate', targetKey })
    if (!review) {
      review = await createImageReview(dir, {
        phase: 'pre_generate',
        targetKey,
        assetId,
        prompt: views.map((v) => `[${v}] ${buildModelSheetViewPrompt({ asset, viewKey: v, styleEn: globalStyleEn })}`).join('\n'),
        negativePrompt: String(body?.mode || '').trim() === 'per-view'
          ? buildModelSheetNegativePrompt(asset.negativePrompt)
          : buildModelSheetWholeNegativePrompt(asset.negativePrompt),
        params: { kind: 'asset.model_sheet', targetName: assetName, views, engine, ...(runId ? { runId } : {}) },
        execute: { endpoint: `/api/projects/${encodeURIComponent(id)}/ai/story/assets/${encodeURIComponent(assetId)}/model-sheet/generate`, payload: body && typeof body === 'object' ? body : {} }
      })
    }
    updateAiTask(sheetTask.taskId, { stage: 'waiting_review', done: true, message: `出图前审核待批准：${assetName} 三视图` })
    return c.json({ success: true, pendingReview: review, taskId: sheetTask.taskId }, 202)
  }

  const internalHeaders = { 'Content-Type': 'application/json', 'x-image-review-mode': 'off' }
  const postInternal = async (urlPath, payload) => {
    const resp = await app.request(urlPath, { method: 'POST', headers: internalHeaders, body: JSON.stringify(payload || {}) })
    const json = await resp.json().catch(() => ({}))
    if (!resp.ok || !json || json.success !== true) {
      const err = new Error(String((json && (json.message || json.error)) || `http_${resp.status}`))
      err.code = String((json && json.error) || `http_${resp.status}`)
      throw err
    }
    return json
  }
  // Y 波：白底抽检（三视图参考图必须纯白底）——边缘 16px 带近白（RGB≥240）像素占比；
  // 透明底产物先合成纯白底再测（透明区读成黑会误报 0%——RMBG 抠图产物语义上已是统一透明底，合成后恒近白）
  const checkBgPurity = async (absPath) => {
    try {
      const pyCode = [
        "import sys",
        "from PIL import Image",
        "im=Image.open(sys.argv[1])",
        // 透明底先合成纯白再测（RMBG 抠图产物语义上已是统一透明底，合成后恒近白）
        "im=(lambda x: (lambda bg: (bg.alpha_composite(x), bg)[1])(Image.new('RGBA', x.size, (255,255,255,255))) if x.mode=='RGBA' else x)(im).convert('RGB')",
        "w,h=im.size",
        "b=16",
        "d=list(im.getdata())",
        "edge=[d[y*w+x] for y in range(h) for x in range(w) if x<b or x>=w-b or y<b or y>=h-b]",
        "white=sum(1 for p in edge if p[0]>=240 and p[1]>=240 and p[2]>=240)",
        "print(round(white/len(edge),3) if edge else 0)"
      ].join(';')
      const out = await new Promise((resolve, reject) => {
        let stdout = ''
        const py = spawn('python3', ['-c', pyCode, absPath])
        py.stdout.on('data', (d) => { stdout += String(d || '') })
        py.on('exit', (code) => (code === 0 ? resolve(stdout) : reject(new Error('purity_exit_' + code))))
        py.on('error', reject)
      })
      const ratio = Number(String(out).trim())
      return Number.isFinite(ratio) ? ratio : null
    } catch (_) { return null }
  }

  const traceId = createTraceId()
  logStage({ stage: 'asset.model_sheet', event: 'start', traceId, project: id, item: assetId, ok: true, detail: views.join(',') })
  const animalBoost = isAnimalLikeAnchor(`${String(asset.referencePromptEn || asset.anchorPrompt || '')} ${assetName}`)
  const results = []
  if (experiment && String(body?.mode || '').trim() !== 'per-view') {
    updateAiTask(sheetTask.taskId, { stage: 'error', done: true, error: 'experiment_requires_per_view' })
    return c.json({ success: false, error: 'experiment_requires_per_view', message: '三视图 A/B 试验必须使用 per-view 独立视角输出' }, 400)
  }
  const saveExperimentRun = async (status, errorMessage = '') => {
    const run = {
      runId,
      engine,
      mode: 'per-view',
      ...(seed !== null ? { seed } : {}),
      status: status || (results.some((item) => item.reviewStatus === 'pending') ? 'pending' : results.some((item) => item.reviewStatus === 'rejected') ? 'rejected' : 'reviewed'),
      primaryReferenceAssetUri: primaryUri,
      views: results,
      ...(errorMessage ? { error: errorMessage } : {}),
      createdAt: ctx.nowIso()
    }
    const curPlan = await ctx.readStoryAssetPlanIfExists(id)
    if (!curPlan) throw new Error('missing_asset_plan')
    const nextPlan = {
      ...curPlan,
      generatedAt: ctx.nowIso(),
      assets: (Array.isArray(curPlan.assets) ? curPlan.assets : []).map((a) =>
        String(a && a.id || '').trim() === assetId ? { ...a, modelSheet: upsertModelSheetTestRun(a, run) } : a
      )
    }
    await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
    return { run, plan: await ctx.readStoryAssetPlanIfExists(id) }
  }
  let mvAdapterBatch = null
  if (engine === 'mvadapter') {
    if (!experiment) {
      updateAiTask(sheetTask.taskId, { stage: 'error', done: true, error: 'mvadapter_experiment_only' })
      return c.json({ success: false, error: 'mvadapter_experiment_only', message: 'MV-Adapter 目前仅开放三视图 A/B 试验，不用于正式锁定候选' }, 400)
    }
    try {
      const identityAbs = path.join(dir, primaryUri)
      let flatAbs = identityAbs
      if (/\.(png|webp)$/i.test(identityAbs)) {
        const tryFlat = identityAbs.replace(/\.(png|webp)$/i, '') + '_flatwhite.png'
        const s0 = await stat(identityAbs)
        const s1 = await stat(tryFlat).catch(() => null)
        if (!(s1 && s1.mtimeMs >= s0.mtimeMs)) {
          await new Promise((resolve, reject) => {
            const py = spawn('python3', ['-c',
              "import sys; from PIL import Image; im=Image.open(sys.argv[1]).convert('RGBA'); bg=Image.new('RGBA', im.size, (255,255,255,255)); bg.alpha_composite(im); bg.convert('RGB').save(sys.argv[2])",
              identityAbs, tryFlat])
            py.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('flatten_exit_' + code))))
            py.on('error', reject)
          })
        }
        flatAbs = tryFlat
      }
      const identity = String(asset.referencePromptEn || asset.anchorPromptEn || asset.anchorPrompt || '').trim()
      const mvPrompt = [
        'orthographic character turnaround, front side and back views of one single character, identical character in every view',
        'neutral standing pose, full body visible head to toe, pure white background, flat lighting, no perspective',
        identity,
        buildColorAnchorEn(asset),
        globalStyleEn || 'cartoon fairy tale picture book style, flat 2D illustration, clean outlines, cel shading'
      ].filter(Boolean).join(', ')
      updateAiTask(sheetTask.taskId, { stage: 'generating', current: 0, total: 1, message: `MV-Adapter 联合三视图生成中：${assetName}` })
      mvAdapterBatch = await generateComfyuiMvAdapterModelSheet({
        identityReferenceBytes: await readFile(flatAbs),
        identityReferenceFilename: `${String(asset.id || 'asset').trim() || 'asset'}_ref.png`,
        comfyuiBaseUrl: String(process.env.STUDIO_MVADAPTER_COMFYUI_BASE_URL || '').trim() || 'http://127.0.0.1:8189',
        model: String(studio.effective.image.model || '').trim() || undefined,
        prompt: mvPrompt,
        negativePrompt: buildModelSheetWholeNegativePrompt(asset.negativePrompt),
        loras: modelSheetBaseLoras,
        ...(seed !== null ? { seed } : {}),
        timeoutMs: 900_000,
        prefix: `talkscene_mvadapter/${String(assetId).replace(/[^a-z0-9_-]/gi, '_')}`
      })
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      const mapped = classifyAiError(e)
      const failed = await saveExperimentRun('failed', msg).catch(() => null)
      updateAiTask(sheetTask.taskId, { stage: 'error', done: true, error: msg, message: `MV-Adapter 生成失败：${assetName} - ${msg}` })
      return c.json({ success: false, error: mapped.code, message: msg, taskId: sheetTask.taskId, ...(failed ? { experiment: true, run: failed.run } : {}) }, mapped.httpStatus)
    }
  }

  // 整 sheet 一次采样且不切栏，使用允许多视图的独立负向词；评审打回不包装为成功。
  const useSheetMode = String(body?.mode || '').trim() !== 'per-view'
  if (useSheetMode) {
    try {
      const identityAbs = path.join(dir, primaryUri)
      let flatAbs = identityAbs
      if (/\.(png|webp)$/i.test(identityAbs)) {
        const tryFlat = identityAbs.replace(/\.(png|webp)$/i, '') + '_flatwhite.png'
        try {
          const s0 = await stat(identityAbs)
          const s1 = await stat(tryFlat).catch(() => null)
          if (!(s1 && s1.mtimeMs >= s0.mtimeMs)) {
            await new Promise((resolve, reject) => {
              const py = spawn('python3', ['-c',
                "import sys; from PIL import Image; im=Image.open(sys.argv[1]).convert('RGBA'); bg=Image.new('RGBA', im.size, (255,255,255,255)); bg.alpha_composite(im); bg.convert('RGB').save(sys.argv[2])",
                identityAbs, tryFlat])
              py.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('flatten_exit_' + code))))
              py.on('error', reject)
            })
          }
          flatAbs = tryFlat
        } catch (_) { flatAbs = identityAbs }
      }
      const identityBytes = await readFile(flatAbs)
      const identity = String(asset.referencePromptEn || asset.anchorPromptEn || asset.anchorPrompt || '').trim()
      const colorAnchor = buildColorAnchorEn(asset)
      const isPropSheet = category === 'prop'
      const sheetPrompt = [
        'charturn',
        `character turnaround sheet, T-pose neutral standing pose, front side and back view of the same ${isPropSheet ? 'object' : 'character'}`,
        'three panels side by side, evenly spaced, pure white background, full body visible head to toe in each panel',
        identity,
        colorAnchor,
        globalStyleEn || 'cartoon fairy tale picture book style, flat 2D illustration, clean outlines, cel shading'
      ].filter(Boolean).join(', ')
      const sheetNegative = buildModelSheetWholeNegativePrompt([String(asset.negativePrompt || '').trim(), 'platform, stand, base, pedestal, stage, podium, wooden stake'].filter(Boolean).join(', '))
      updateAiTask(sheetTask.taskId, { stage: 'generating', current: 0, total: 1, message: `标准系 sheet 生成中：${assetName}（charturn 主导整图三栏）` })
      const gen = await generateBackgroundImage({
        prompt: sheetPrompt,
        negativePrompt: sheetNegative,
        width: renderSizeOf('model_sheet', stylePreset)[0],
        height: renderSizeOf('model_sheet', stylePreset)[1],
        steps: 28,
        cfgScale: 6,
        ...(seed !== null ? { seed } : {}),
        provider: String(studio.effective.image.provider || '').trim() || undefined,
        sdwebuiBaseUrl: studio.effective.image.sdwebuiBaseUrl,
        comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
        apiUrl: studio.effective.image.apiUrl,
        model: String(studio.effective.image.model || '').trim() || undefined,
        loras: withCharturnLora('il-xl-charturn-merged.safetensors:0.8'),
        continuity: { ipadapterEnabled: true },
        ipadapterModel: 'ip-adapter-plus_sdxl_vit-h',
        referenceImages: [{ bytes: identityBytes, filename: `${String(asset.id || 'asset').trim() || 'asset'}_ref.png`, weight: 0.3, startAt: 0.1, endAt: 0.6 }],
        proxyUrl: studio.effective.network.proxyUrl
      })
      const slug = String(assetId).replace(/[^a-z0-9_-]/gi, '_')
      const sheetRel = `assets/ai/story_assets/${isPropSheet ? 'prop' : 'character'}/${slug}/sheet_whole_${Date.now()}.${gen.ext || 'png'}`
      const sheetAbs = path.join(dir, sheetRel)
      await mkdir(path.dirname(sheetAbs), { recursive: true })
      await writeFile(sheetAbs, gen.bytes)
      // 出图即压：整图无损 WebP
      const opt = await optimizeGeneratedImage(sheetAbs, IMAGE_KIND.SPRITE_LOSSLESS).catch(() => null)
      const sheetFinal = opt && opt.outPath ? String(ctx.assetPathFromAbsolute(id, opt.outPath) || sheetRel) : sheetRel
      // 整图白度抽检（背景纯度维度客观佐证）
      const sheetPurity = await checkBgPurity(path.join(dir, String(sheetFinal).replace(/^\/+/, '')))
      // 整图评审（sheetWhole：视角齐全+身份+配色+底纯）；fail-closed：通道死挂 pending 不盲批
      let score
      let reason = ''
      let reviewStatus = 'pending'
      let reviewViews = null
      try {
        updateAiTask(sheetTask.taskId, { stage: 'reviewing', current: 0, message: `标准系 sheet 整图评审：${assetName}` })
        const reviewJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/pose-review`, { planAssetId: assetId, assetPath: sheetFinal, mode: 'sheetWhole', ...(String(body?.provider || '').trim() ? { provider: String(body.provider).trim() } : {}) })
        if (Number.isFinite(Number(reviewJson.score))) {
          score = Number(reviewJson.score)
          reviewViews = reviewJson.views && typeof reviewJson.views === 'object' ? reviewJson.views : null
          reviewStatus = score < 50 ? 'rejected' : 'reviewed'
        }
        reason = String(reviewJson.reason || '').trim()
      } catch (e) {
        reason = `review_unavailable:${String((e && e.code) || (e && e.message) || e).slice(0, 120)}`
      }
      if (reviewStatus === 'reviewed' && !['front', 'side', 'back'].every((key) => reviewViews?.[key] === true)) {
        reviewStatus = 'rejected'
        reason = `${reason ? reason + '；' : ''}评审未确认正/侧/背三视角齐全`
      }
      if (sheetPurity !== null && !isBgPureEnough(sheetPurity)) {
        reason = `${reason ? reason + '；' : ''}背景纯度 ${(sheetPurity * 100).toFixed(0)}%（低于 85% 阈值）`
        if (reviewStatus === 'reviewed') reviewStatus = 'rejected'
      }
      const curPlan = await ctx.readStoryAssetPlanIfExists(id)
      if (!curPlan) throw new Error('missing_asset_plan')
      const nextPlan = {
        ...curPlan,
        generatedAt: ctx.nowIso(),
        assets: (Array.isArray(curPlan.assets) ? curPlan.assets : []).map((a) => {
          if (String(a && a.id || '').trim() !== assetId) return a
          const oldSheet = String(a.modelSheet?.sheetAssetUri || '').trim()
          const modelSheet = { ...(a.modelSheet && typeof a.modelSheet === 'object' ? a.modelSheet : {}) }
          if (String(modelSheet.sheetLockedAt || '').trim()) {
            modelSheet.prevSheetLockedAt = String(modelSheet.sheetLockedAt)
            delete modelSheet.sheetLockedAt
          }
          return {
            ...a,
            modelSheet: {
              ...modelSheet,
              sheetAssetUri: sheetFinal,
              sheetPrompt,
              sheetNegative,
              sheetGeneration: gen.meta || null,
              sheetAt: ctx.nowIso(),
              ...(oldSheet && oldSheet !== sheetFinal ? { prevSheetAssetUri: oldSheet } : {}),
              ...(score !== undefined ? { sheetReviewScore: score } : {}),
              sheetReviewStatus: reviewStatus,
              ...(reason ? { sheetReviewReason: reason } : {}),
              ...(reviewViews ? { sheetReviewViews: reviewViews } : {}),
              ...(sheetPurity !== null ? { sheetBgPurity: sheetPurity } : {}),
              pendingCells: []
            }
          }
        })
      }
      nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
      await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
      results.push({ sheetAssetUri: sheetFinal, ...(score !== undefined ? { score } : {}), reviewStatus, reason, ...(reviewViews ? { reviewViews } : {}), ...(sheetPurity !== null ? { bgPurity: sheetPurity } : {}), generation: gen.meta || null })
      if (reviewStatus === 'rejected') {
        updateAiTask(sheetTask.taskId, {
          stage: 'error',
          done: true,
          current: 1,
          error: 'sheet_review_rejected',
          message: `标准系 sheet 评审打回：${assetName}${score !== undefined ? `（${score} 分）` : ''}`,
          result: { assetId, mode: 'sheet', sheet: results[0] }
        })
        return c.json({ success: false, error: 'sheet_review_rejected', taskId: sheetTask.taskId, mode: 'sheet', assetId, sheet: results[0], plan: await ctx.readStoryAssetPlanIfExists(id) }, 422)
      }
      updateAiTask(sheetTask.taskId, {
        stage: reviewStatus === 'pending' ? 'waiting_review' : 'done',
        done: true,
        current: 1,
        message: `标准系 sheet ${reviewStatus === 'pending' ? '待人工复核' : '完成'}：${assetName}${score !== undefined ? `（评审 ${score} 分）` : ''}`,
        result: { assetId, mode: 'sheet', sheet: results[0] }
      })
      return c.json({ success: true, taskId: sheetTask.taskId, mode: 'sheet', assetId, sheet: results[0], plan: await ctx.readStoryAssetPlanIfExists(id) })
    } catch (sheetErr) {
      const sheetMsg = sheetErr instanceof Error ? sheetErr.message : String(sheetErr)
      logStage({ stage: 'asset.model_sheet', event: 'sheet_fallback', traceId, project: id, item: assetId, ok: false, err: sheetMsg })
      updateAiTask(sheetTask.taskId, { stage: 'fallback', message: `sheet 模式失败（${sheetMsg.slice(0, 80)}），回退逐视角生成` })
      results.length = 0
    }
  }

  try {
    for (let i = 0; i < views.length; i += 1) {
      const viewKey = views[i]
      const viewLabel = MODEL_SHEET_VIEW_LABELS[viewKey] || viewKey
      // Y 波（2026-10-28 用户裁决）：front 口径钉死——front 永远=主参考登记，不允许生成（采样必漂）
      if (viewKey === 'front') {
        updateAiTask(sheetTask.taskId, { stage: 'generating', current: i, message: `三视图 ${i + 1}/${views.length}：${assetName}·正面 同步主参考登记` })
        const entry = {
          key: 'front',
          assetUri: primaryUri,
          reviewStatus: 'skipped',
          reason: 'front_equals_primary',
          prompt: '',
          createdAt: ctx.nowIso(),
          ...(experiment ? {} : { lockedAt: ctx.nowIso() })
        }
        if (!experiment) {
          const curPlan = await ctx.readStoryAssetPlanIfExists(id)
          if (!curPlan) throw new Error('missing_asset_plan')
          const nextPlan = {
            ...curPlan,
            generatedAt: ctx.nowIso(),
            assets: (Array.isArray(curPlan.assets) ? curPlan.assets : []).map((a) =>
              String(a && a.id || '').trim() === assetId ? { ...a, modelSheet: upsertModelSheetView(a, entry) } : a
            )
          }
          nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
          await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
        }
        results.push({ key: 'front', view: 'front', assetUri: primaryUri, reviewStatus: 'skipped', synced: true })
        updateAiTask(sheetTask.taskId, { current: i + 1, message: `三视图 ${i + 1}/${views.length}：${assetName}·正面 已同步主参考` })
        logStage({ stage: 'asset.model_sheet', event: 'view_ok', traceId, project: id, item: `${assetId}:front`, ok: true, detail: 'front_equals_primary' })
        continue
      }
      updateAiTask(sheetTask.taskId, { stage: 'generating', current: i, message: `三视图 ${i + 1}/${views.length}：${assetName}·${viewLabel} 生成中…` })
      const viewPrompt = buildModelSheetViewPrompt({ asset, viewKey, styleEn: globalStyleEn, charturn: engine === 'charturn' })
      // T 波：side/back 视角负向排除（压正面）叠加多视图禁令
      const viewNegative = buildModelSheetNegativePrompt([String(asset.negativePrompt || '').trim(), MODEL_SHEET_VIEW_NEGATIVE_EXTRA[viewKey] || ''].filter(Boolean).join(', '))
      const ipaBase = MODEL_SHEET_VIEW_IPADAPTER[viewKey] || MODEL_SHEET_VIEW_IPADAPTER.front
      const animalIpa = MODEL_SHEET_VIEW_IPADAPTER_ANIMAL[viewKey] || ipaBase
      const effectiveIpa = animalBoost ? animalIpa : ipaBase
      const ipa = viewKey === 'front'
        ? { enabled: true, weight: animalBoost ? 0.95 : ipaBase.weight, startAt: ipaBase.startAt, endAt: ipaBase.endAt }
        : { enabled: true, weight: effectiveIpa.weight, startAt: effectiveIpa.startAt, endAt: effectiveIpa.endAt }
      let viewAssetPath = ''
      let sourceBgPurity = null
      let generationMeta = null
      // U 波项 3：side/back 有站姿骨架（standing_side/back，openpose 语义程序化生成）——
      // 走 ControlNet 骨架硬约束链（generateComfyuiPoseVariantSprite 骨架+IPAdapter 双约束）：
      // 视角归骨架（强约束），IPAdapter 降权只管身份（0.45 档），配色锚词补强制约。
      // 产物为白底直出图（三视图是参考图非立绘，不抠图，出图即压无损 WebP）。
      const skeletonFile = category === 'character' ? (MODEL_SHEET_VIEW_SKELETON[viewKey] || '') : ''
      if (engine === 'mvadapter') {
        const generated = mvAdapterBatch?.views?.find((item) => item.key === viewKey)
        if (!generated) throw new Error(`mvadapter_missing_view:${viewKey}`)
        const slug = String(assetId).replace(/[^a-z0-9_-]/gi, '_')
        const trialPath = `/model_sheet_trials/${runId.replace(/[^a-z0-9_-]/gi, '_')}`
        const relOut = `assets/ai/story_assets/${category === 'prop' ? 'prop' : 'character'}/${slug}${trialPath}/mv_${viewKey}_${Date.now()}.${generated.ext || 'png'}`
        const outAbs = path.join(dir, relOut)
        await mkdir(path.dirname(outAbs), { recursive: true })
        await writeFile(outAbs, generated.bytes)
        const opt = await optimizeGeneratedImage(outAbs, IMAGE_KIND.SPRITE_LOSSLESS).catch(() => null)
        viewAssetPath = opt && opt.outPath && opt.outPath !== outAbs ? String(ctx.assetPathFromAbsolute(id, opt.outPath) || relOut) : relOut
        sourceBgPurity = await checkBgPurity(path.join(dir, String(viewAssetPath).replace(/^\/+/, '')))
        generationMeta = { ...mvAdapterBatch.meta, azimuth: generated.azimuth, view: generated.meta }
        updateAiTask(sheetTask.taskId, { stage: 'generating', current: i, message: `三视图 ${i + 1}/${views.length}：${assetName}·${viewLabel} 抠图统一透明底…` })
        const cutoutJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/cutout`, { assetPath: viewAssetPath })
        const cutPath = String(cutoutJson.assetPath || '').trim()
        if (cutPath) viewAssetPath = cutPath
      } else if (skeletonFile) {
        const identityAbs = path.join(dir, primaryUri)
        // IPAdapter 吃透明底失效（sprite 端点 2026-09-01 根因）：主参考先合成白底（同款 PIL 缓存）
        let flatAbs = identityAbs
        if (/\.(png|webp)$/i.test(identityAbs)) {
          const tryFlat = identityAbs.replace(/\.(png|webp)$/i, '') + '_flatwhite.png'
          try {
            const s0 = await stat(identityAbs)
            const s1 = await stat(tryFlat).catch(() => null)
            if (!(s1 && s1.mtimeMs >= s0.mtimeMs)) {
              await new Promise((resolve, reject) => {
                const py = spawn('python3', ['-c',
                  "import sys; from PIL import Image; im=Image.open(sys.argv[1]).convert('RGBA'); bg=Image.new('RGBA', im.size, (255,255,255,255)); bg.alpha_composite(im); bg.convert('RGB').save(sys.argv[2])",
                  identityAbs, tryFlat])
                py.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('flatten_exit_' + code))))
                py.on('error', reject)
              })
            }
            flatAbs = tryFlat
          } catch (_) { flatAbs = identityAbs }
        }
        const identityBytes = await readFile(flatAbs)
        const skeletonBytes = await readFile(path.join(ctx.ROOT, '_shared', 'pose_library', skeletonFile))
        updateAiTask(sheetTask.taskId, { stage: 'generating', current: i, message: `三视图 ${i + 1}/${views.length}：${assetName}·${viewLabel} 骨架约束生成中…` })
        const gen = await generateComfyuiPoseVariantSprite({
          identityReferenceBytes: identityBytes,
          identityReferenceFilename: `${String(asset.id || 'asset').trim() || 'asset'}_ref.png`,
          poseSkeletonBytes: skeletonBytes,
          comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
          model: String(studio.effective.image.model || '').trim() || undefined,
          ipadapterModel: 'ip-adapter-plus_sdxl_vit-h',
          prompt: viewPrompt,
          negativePrompt: viewNegative,
          width: renderSizeOf('primary_reference', stylePreset)[0],
          height: renderSizeOf('primary_reference', stylePreset)[1],
          steps: 24,
          cfgScale: 6,
          ...(seed !== null ? { seed } : {}),
          ipadapterWeight: ipa.weight,
          ipadapterStartAt: ipa.startAt,
          ipadapterEndAt: ipa.endAt,
          controlStrength: 0.9,
          controlEndPercent: 0.9,
          timeoutMs: 300_000,
          prefix: `talkscene_sheet/${String(assetId).replace(/[^a-z0-9_-]/gi, '_')}_${viewKey}`,
          loras: withCharturnLora(viewKey === 'back' ? MODEL_SHEET_CHARTURN_LORA_BACK : MODEL_SHEET_CHARTURN_LORA)
        })
        generationMeta = gen.meta || null
        const slug = String(assetId).replace(/[^a-z0-9_-]/gi, '_')
        const trialPath = experiment ? `/model_sheet_trials/${runId.replace(/[^a-z0-9_-]/gi, '_')}` : ''
        const relOut = `assets/ai/story_assets/${category === 'prop' ? 'prop' : 'character'}/${slug}${trialPath}/sheet_${viewKey}_${Date.now()}.${gen.ext || 'png'}`
        const outAbs = path.join(dir, relOut)
        await mkdir(path.dirname(outAbs), { recursive: true })
        await writeFile(outAbs, gen.bytes)
        const opt = await optimizeGeneratedImage(outAbs, IMAGE_KIND.SPRITE_LOSSLESS).catch(() => null)
        viewAssetPath = opt && opt.outPath && opt.outPath !== outAbs ? String(ctx.assetPathFromAbsolute(id, opt.outPath) || relOut) : relOut
        sourceBgPurity = await checkBgPurity(path.join(dir, String(viewAssetPath).replace(/^\/+/, '')))
        // Y 波收口：骨架链白底直出再过 RMBG 抠图=透明底立绘——与 front 主参考/sprite 链产物观感统一为透明底。
        // （白底压白后处理对白毛角色不可行：泛洪/阈值两版实证吃主体——RMBG 语义分割不看颜色，透明底是更稳的统一口径）
        updateAiTask(sheetTask.taskId, { stage: 'generating', current: i, message: `三视图 ${i + 1}/${views.length}：${assetName}·${viewLabel} 抠图统一透明底…` })
        const cutoutJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/cutout`, { assetPath: viewAssetPath })
        const cutPath = String(cutoutJson.assetPath || '').trim()
        if (cutPath) viewAssetPath = cutPath
      } else {
      const spriteJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/sprite`, {
        kind: category === 'prop' ? 'prop' : 'character',
        planAssetId: assetId,
        ipadapter: ipa,
        fingerprintPrompt: String(asset.anchorPrompt || '').trim(),
        globalPrompt: globalStyleEn || 'cartoon fairy tale picture book style, flat 2D illustration, bold clean outlines, cel shading, warm soft color palette',
        posePrompt: viewPrompt,
        negativePrompt: viewNegative,
        style: 'picture_book',
        loras: viewKey !== 'front' ? withCharturnLora(MODEL_SHEET_CHARTURN_LORA) : modelSheetBaseLoras,
        width: renderSizeOf('primary_reference', stylePreset)[0],
        height: renderSizeOf('primary_reference', stylePreset)[1],
        steps: 24,
        cfgScale: 6,
        ...(seed !== null ? { seed } : {})
      })
      generationMeta = spriteJson.generation || spriteJson.meta || null
      const spritePath = String(spriteJson.assetPath || '').trim()
      if (!spritePath) throw new Error('sprite_no_output')
      sourceBgPurity = await checkBgPurity(path.join(dir, String(spritePath).replace(/^\/+/, '')))
      updateAiTask(sheetTask.taskId, { stage: 'generating', current: i, message: `三视图 ${i + 1}/${views.length}：${assetName}·${viewLabel} 抠图中…` })
      const cutoutJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/cutout`, { assetPath: spritePath })
      viewAssetPath = String(cutoutJson.assetPath || '').trim()
      if (!viewAssetPath) throw new Error('cutout_no_output')
      }

      // 一致性视觉评审：side/back 与主参考过同款通道（fail-closed：通道不可用挂 pending 不盲批，绝不自动锁）；
      // front 与主参考同视角，记 front_view_skipped 不评。
      // Y 波：白底抽检先行（参考图必须纯白底）——边缘带近白占比 <0.85 记 bgPurity，作评审打回客观依据
      const bgPurity = sourceBgPurity
      let score
      let reason = ''
      let reviewStatus = 'skipped'
      if (viewKey === 'front') {
        reason = 'front_view_skipped'
      } else {
        try {
          updateAiTask(sheetTask.taskId, { stage: 'reviewing', current: i, message: `三视图 ${i + 1}/${views.length}：${assetName}·${viewLabel} 一致性评审中…` })
          // T 波：expectView 视角硬门槛（视角不符评审指令直接 ≤20 分）
          const reviewJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/pose-review`, { planAssetId: assetId, assetPath: viewAssetPath, expectView: viewKey, ...(String(body?.provider || '').trim() ? { provider: String(body.provider).trim() } : {}) })
          if (Number.isFinite(Number(reviewJson.score))) {
            score = Number(reviewJson.score)
            reviewStatus = score < 50 ? 'rejected' : 'reviewed'
          } else {
            reviewStatus = 'pending'
          }
          reason = String(reviewJson.reason || '').trim()
        } catch (e) {
          reviewStatus = 'pending'
          reason = `review_unavailable:${String((e && e.code) || (e && e.message) || e).slice(0, 120)}`
        }
      }
      // 背景纯度客观佐证：低于阈值附注入 reason（评审打回依据），并随 entry 留痕
      if (bgPurity !== null && !isBgPureEnough(bgPurity)) {
        reason = `${reason ? reason + '；' : ''}背景纯度 ${(bgPurity * 100).toFixed(0)}%（低于 85% 阈值，渐变/投影/场景背景）`
        if (reviewStatus === 'reviewed') reviewStatus = 'rejected'
      }

      const entry = {
        key: viewKey,
        assetUri: viewAssetPath,
        prompt: viewPrompt,
        negativePrompt: viewNegative,
        ...(score !== undefined ? { score } : {}),
        ...(reason ? { reason } : {}),
        ...(bgPurity !== null ? { bgPurity } : {}),
        ...(generationMeta ? { generation: generationMeta } : {}),
        reviewStatus,
        createdAt: ctx.nowIso()
      }
      if (!experiment) {
        const curPlan = await ctx.readStoryAssetPlanIfExists(id)
        if (!curPlan) throw new Error('missing_asset_plan')
        const nextPlan = {
          ...curPlan,
          generatedAt: ctx.nowIso(),
          assets: (Array.isArray(curPlan.assets) ? curPlan.assets : []).map((a) =>
            String(a && a.id || '').trim() === assetId ? { ...a, modelSheet: upsertModelSheetView(a, entry) } : a
          )
        }
        nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
        await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
      }
      results.push({ ...entry, view: viewKey })
      updateAiTask(sheetTask.taskId, { current: i + 1, message: `三视图 ${i + 1}/${views.length}：${assetName}·${viewLabel} 完成${score !== undefined ? `（${score} 分）` : reviewStatus === 'pending' ? '（评审挂起，待人工复核）' : ''}` })
      logStage({ stage: 'asset.model_sheet', event: 'view_ok', traceId, project: id, item: `${assetId}:${viewKey}`, ok: true, detail: reviewStatus })
    }
    if (experiment) {
      const { run, plan: savedPlan } = await saveExperimentRun()
      updateAiTask(sheetTask.taskId, {
        stage: 'done',
        done: true,
        current: views.length,
        message: `三视图试验候选已落盘：${assetName}（${engine}，${run.status}）`,
        result: { assetId, runId, run }
      })
      return c.json({ success: true, taskId: sheetTask.taskId, experiment: true, run, plan: savedPlan })
    }
    updateAiTask(sheetTask.taskId, {
      stage: 'done',
      done: true,
      current: views.length,
      message: `标准系三视图完成：${assetName}（${views.length} 视角候选已落盘，逐张人工锁定后生效）`,
      result: { assetId, views: results }
    })
    return c.json({ success: true, taskId: sheetTask.taskId, assetId, views: results, plan: await ctx.readStoryAssetPlanIfExists(id) })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    const failedExperiment = experiment ? await saveExperimentRun('failed', msg).catch(() => null) : null
    updateAiTask(sheetTask.taskId, { stage: 'error', done: true, error: msg, message: `三视图失败：${assetName}（已完成 ${results.length}/${views.length}）${msg}；可在工作区重试剩余视角` })
    logStage({ stage: 'asset.model_sheet', event: 'fail', traceId, project: id, item: assetId, status: mapped.httpStatus, ok: false, err: msg })
    return c.json({ success: false, error: mapped.code, message: msg, views: results, ...(failedExperiment ? { experiment: true, run: failedExperiment.run } : {}) }, mapped.httpStatus)
  }
})

// 三视图视角锁定（人审后）：写 lockedAt + lock_confirm 审核留痕；三视角全锁时写 modelSheet.lockedAt。
// fail-closed 语义：side/back 无 AI 评审分数（评审通道挂 pending）时不阻断人工锁定（人工看图即人审），但留痕注明。
app.post('/api/projects/:id/ai/story/assets/:assetId/model-sheet/lock', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const assetId = String(c.req.param('assetId') || '').trim()
  const body = await c.req.json().catch(() => ({}))
  const viewKey = String(body?.view || '').trim()
  // AA 波：view='sheet' 锁整 sheet（sheetLockedAt）；view=front/side/back 锁逐视角（原语义）
  if (viewKey !== 'sheet' && !MODEL_SHEET_VIEWS.includes(viewKey)) return c.json({ success: false, error: 'invalid_view', message: `view 仅支持 ${MODEL_SHEET_VIEWS.join('/')}/sheet` }, 400)

  const plan = await ctx.readStoryAssetPlanIfExists(id)
  const asset = (plan && Array.isArray(plan.assets) ? plan.assets : []).find((a) => String(a && a.id || '').trim() === assetId) || null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)
  const assetName = String(asset.name || assetId).trim()

  // AA 波：sheet 整图锁定分支
  if (viewKey === 'sheet') {
    const sheetUri = String(asset.modelSheet?.sheetAssetUri || '').trim()
    if (!sheetUri) {
      return c.json({ success: false, error: 'sheet_candidate_missing', message: `「${assetName}」还没有 sheet 候选图，请先生成。` }, 404)
    }
    if (String(asset.modelSheet?.sheetReviewStatus || '').trim() === 'rejected') {
      return c.json({ success: false, error: 'sheet_review_rejected', message: `「${assetName}」的 sheet 已被评审打回，请重新生成后再锁定。` }, 409)
    }
    if (String(asset.modelSheet?.sheetLockedAt || '').trim()) {
      return c.json({ success: true, assetId, view: 'sheet', alreadyLocked: true, lockedAt: String(asset.modelSheet.sheetLockedAt) })
    }
    const lockedAt = ctx.nowIso()
    const nextPlan = {
      ...plan,
      generatedAt: lockedAt,
      assets: plan.assets.map((a) =>
        String(a && a.id || '').trim() === assetId
          ? { ...a, modelSheet: { ...(a.modelSheet && typeof a.modelSheet === 'object' ? a.modelSheet : {}), sheetLockedAt: lockedAt } }
          : a
      )
    }
    nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
    await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
    try {
      const targetKey = `lock_confirm:${assetId}:modelSheet:sheet:${sheetUri}`
      const decidedBy = ctx.resolveImageReviewMode(c, body) === 'off' ? 'control' : 'user'
      const pendingLock = await findPendingReview(dir, { phase: 'lock_confirm', targetKey })
      if (pendingLock) {
        await decideImageReview(dir, pendingLock.reviewId, { approved: true, decidedBy })
      } else {
        const record = await createImageReview(dir, {
          phase: 'lock_confirm',
          targetKey,
          assetId,
          resultImagePath: sheetUri,
          prompt: String(asset.modelSheet?.sheetPrompt || ''),
          aiReview: Number.isFinite(Number(asset.modelSheet?.sheetReviewScore)) ? { score: Number(asset.modelSheet.sheetReviewScore), reason: String(asset.modelSheet?.sheetReviewReason || '') } : null,
          params: { kind: 'asset.model_sheet.lock', view: 'sheet' }
        })
        await decideImageReview(dir, record.reviewId, { approved: true, decidedBy })
      }
    } catch (_) { /* 留痕失败不阻断锁定结果 */ }
    recordCreationEvent(dir, {
      type: 'model_sheet_locked',
      summary: `标准系 sheet 锁定：${assetName}`,
      actor: 'model_sheet_flow',
      data: { assetId }
    })
    logStage({ stage: 'asset.model_sheet', event: 'lock_ok', traceId: createTraceId(), project: id, item: `${assetId}:sheet`, ok: true, detail: 'sheet_locked' })
    return c.json({ success: true, assetId, view: 'sheet', lockedAt, plan: await ctx.readStoryAssetPlanIfExists(id) })
  }

  const views = Array.isArray(asset.modelSheet?.views) ? asset.modelSheet.views : []
  const target = views.find((v) => String(v && v.key || '').trim() === viewKey && String(v && v.assetUri || '').trim()) || null
  if (!target) {
    return c.json({ success: false, error: 'view_candidate_missing', message: `「${assetName}」的${MODEL_SHEET_VIEW_LABELS[viewKey]}视图还没有候选图，请先生成。` }, 404)
  }
  if (String(target.reviewStatus || '').trim() === 'rejected') {
    return c.json({ success: false, error: 'model_sheet_view_rejected', message: `「${assetName}」的${MODEL_SHEET_VIEW_LABELS[viewKey]}视图已被评审打回，请重新生成后再锁定。` }, 409)
  }
  if (String(target.lockedAt || '').trim()) {
    return c.json({ success: true, assetId, view: viewKey, alreadyLocked: true, lockedAt: String(target.lockedAt) })
  }

  const lockedAt = ctx.nowIso()
  const nextViews = views.map((v) => (String(v && v.key || '').trim() === viewKey ? { ...v, lockedAt } : v))
  const allLocked = MODEL_SHEET_VIEWS.every((k) => nextViews.some((v) => String(v && v.key || '').trim() === k && String(v && v.lockedAt || '').trim()))
  const nextPlan = {
    ...plan,
    generatedAt: lockedAt,
    assets: plan.assets.map((a) =>
      String(a && a.id || '').trim() === assetId
        ? { ...a, modelSheet: { ...(a.modelSheet && typeof a.modelSheet === 'object' ? a.modelSheet : {}), views: nextViews, ...(allLocked ? { lockedAt } : {}) } }
        : a
    )
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })

  // lock_confirm 审核留痕（人工锁定即批准；side/back 未经 AI 评审的注明 review_gap）
  try {
    const targetKey = `lock_confirm:${assetId}:modelSheet:${viewKey}:${String(target.assetUri)}`
    const decidedBy = ctx.resolveImageReviewMode(c, body) === 'off' ? 'control' : 'user'
    const pendingLock = await findPendingReview(dir, { phase: 'lock_confirm', targetKey })
    if (pendingLock) {
      await decideImageReview(dir, pendingLock.reviewId, { approved: true, decidedBy })
    } else {
      const record = await createImageReview(dir, {
        phase: 'lock_confirm',
        targetKey,
        assetId,
        resultImagePath: String(target.assetUri),
        prompt: String(target.prompt || ''),
        aiReview: Number.isFinite(Number(target.score)) ? { score: Number(target.score), reason: String(target.reason || '') } : null,
        params: { kind: 'asset.model_sheet.lock', view: viewKey, ...(viewKey !== 'front' && !Number.isFinite(Number(target.score)) ? { review_gap: 'ai_review_unavailable_manual_lock' } : {}) }
      })
      await decideImageReview(dir, record.reviewId, { approved: true, decidedBy })
    }
  } catch (_) { /* 留痕失败不阻断锁定结果 */ }
  recordCreationEvent(dir, {
    type: 'model_sheet_view_locked',
    summary: `三视图锁定：${assetName}·${MODEL_SHEET_VIEW_LABELS[viewKey]}${allLocked ? '（三视角全锁）' : ''}`,
    actor: 'model_sheet_flow',
    data: { assetId, view: viewKey, allLocked }
  })
  logStage({ stage: 'asset.model_sheet', event: 'lock_ok', traceId: createTraceId(), project: id, item: `${assetId}:${viewKey}`, ok: true, detail: allLocked ? 'all_locked' : '' })
  return c.json({ success: true, assetId, view: viewKey, lockedAt, allLocked, plan: await ctx.readStoryAssetPlanIfExists(id) })
})

// Z 波：sheet 栏序人工指定（评审通道死时兜底，明面执行不猜）——pendingCells 三栏由用户指定 front/side/back 后写 views。
// 人工指定即人工评审（reviewStatus=manual_assigned）；三视角齐且全锁时 modelSheet.lockedAt 更新。
app.post('/api/projects/:id/ai/story/assets/:assetId/model-sheet/assign-views', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const assetId = String(c.req.param('assetId') || '').trim()
  const body = await c.req.json().catch(() => ({}))
  const assignments = body && typeof body.assignments === 'object' && body.assignments ? body.assignments : null
  if (!assignments) return c.json({ success: false, error: 'missing_assignments', message: '缺少 assignments（{"0":"front","1":"side","2":"back"}）' }, 400)

  const plan = await ctx.readStoryAssetPlanIfExists(id)
  const asset = (plan && Array.isArray(plan.assets) ? plan.assets : []).find((a) => String(a && a.id || '').trim() === assetId) || null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)
  const pending = Array.isArray(asset.modelSheet?.pendingCells) ? asset.modelSheet.pendingCells : []
  if (!pending.length) return c.json({ success: false, error: 'no_pending_cells', message: '没有待指定的 sheet 栏（sheet 未生成或已指定过）' }, 400)

  // 校验：三栏都必须指定且 front/side/back 各一
  const viewOf = {}
  for (const cell of pending) {
    const v = String(assignments[String(cell.index)] || '').trim()
    if (!MODEL_SHEET_VIEWS.includes(v)) {
      return c.json({ success: false, error: 'invalid_assignment', message: `栏 ${Number(cell.index) + 1} 未指定视角（front/side/back 各选一）` }, 400)
    }
    viewOf[v] = cell
  }
  if (Object.keys(viewOf).length !== 3) {
    return c.json({ success: false, error: 'duplicate_view', message: '三个栏的视角必须各不相同（front/side/back 各一）' }, 400)
  }

  const now = ctx.nowIso()
  const curViews = (Array.isArray(asset.modelSheet?.views) ? asset.modelSheet.views : []).filter((v) => !pending.some((cell) => String(cell.assetUri || '') === String(v && v.assetUri || '')))
  for (const viewKey of MODEL_SHEET_VIEWS) {
    const cell = viewOf[viewKey]
    curViews.push({
      key: viewKey,
      assetUri: String(cell.assetUri || '').trim(),
      prompt: String(asset.modelSheet?.sheetPrompt || ''),
      negativePrompt: String(asset.modelSheet?.sheetNegative || ''),
      reviewStatus: 'manual_assigned',
      reason: '栏序人工指定（评审通道死时兜底）',
      sheetMode: true,
      createdAt: now
    })
  }
  const nextPlan = {
    ...plan,
    generatedAt: now,
    assets: plan.assets.map((a) =>
      String(a && a.id || '').trim() === assetId
        ? {
            ...a,
            modelSheet: {
              ...(a.modelSheet && typeof a.modelSheet === 'object' ? a.modelSheet : {}),
              views: curViews,
              pendingCells: []
            }
          }
        : a
    )
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
  logStage({ stage: 'asset.model_sheet', event: 'views_assigned', traceId: createTraceId(), project: id, item: assetId, ok: true, detail: Object.keys(viewOf).join(',') })
  return c.json({ success: true, assetId, plan: await ctx.readStoryAssetPlanIfExists(id) })
})
}
