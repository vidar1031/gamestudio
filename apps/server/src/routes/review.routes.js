// ---------------------------------------------------------------------------
// registerReviewRoutes（模块化拆分机械迁出，字义未改；协议层+族内编排，域算法引自 ../ai/*，index 本地辅助经 ctx 注入）
// ---------------------------------------------------------------------------
import path from 'node:path'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rename, stat, writeFile, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import crypto from 'node:crypto'
import { listAiTasks, updateAiTask } from '../ai/taskProgress.js'
import { sniffImageMetaFromBytes, verifyStoryAssetReferenceFile } from '../ai/storyAssetReferenceGate.js'
import { reviewCharacterPoseConsistencyWithAi, reviewCharacterPoseConsistencyWithLocalVl } from '../ai/characterPoseReview.js'
import { reviewStoryPromptLocally, reviewStoryPromptWithAi } from '../ai/promptReview.js'
import { normalizeStoryboardPromptReviewInput, reviewStoryboardPromptLocally, reviewStoryboardPromptWithAi } from '../ai/storyboardPromptReview.js'
import { getStoryImageCoverage } from '../ai/storyCoverage.js'
import { isOpenAICompatibleProvider, reviewBlueprintViaOpenAI } from '../ai/openai.js'
import { reviewBlueprintLocally } from '../ai/blueprintReviewLocal.js'
import { compileBlueprintFromScripts } from '../blueprint/compile.js'
import { validateBlueprintDoc } from '../blueprint/validate.js'
import { getEffectiveStudioConfig } from '../studio/settings.js'
import { decideImageReview, getImageReview, listImageReviews } from '../review/imageReviewStore.js'

export function registerReviewRoutes(app, ctx) {
app.post('/api/ai/prompt/review', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const prompt = String(body?.prompt || '').trim()
  const title = String(body?.title || '').trim()
  const formula = {
    choicePoints: ctx.clampInt(body?.choicePoints, 1, 3, 2),
    optionsPerChoice: Number(body?.optionsPerChoice) === 3 ? 3 : 2,
    endings: Number(body?.optionsPerChoice) === 3 ? 3 : 2
  }

  const localReview = reviewStoryPromptLocally({ prompt, title, formula })
  const studio = await getEffectiveStudioConfig(ctx.ROOT).catch(() => null)
  const provider = String(studio?.effective?.scripts?.provider || '').trim().toLowerCase()
  const model = studio?.effective?.scripts?.model || undefined
  const apiUrl = studio?.effective?.scripts?.apiUrl || undefined
  const proxyUrl = studio?.effective?.network?.proxyUrl || undefined

  let aiReview = {
    verdict: localReview.ok ? 'ok' : 'warn',
    summary: localReview.summary,
    strengths: (localReview.checks || []).filter((x) => x.ok).slice(0, 6).map((x) => String(x.message || '')),
    risks: (localReview.checks || []).filter((x) => !x.ok).slice(0, 8).map((x) => String(x.message || '')),
    suggestions: Array.isArray(localReview.suggestions) ? localReview.suggestions.slice(0, 8) : [],
    optimizedPrompt: String(localReview.optimizedPrompt || prompt || '').trim()
  }
  let meta = { provider: 'local', model: null, api: null, durationMs: 0, note: 'local_precheck_only' }
  let aiError = null

  try {
    if (provider && provider !== 'none') {
      const reviewed = await reviewStoryPromptWithAi({ prompt, provider, model, apiUrl, proxyUrl, formula })
      if (reviewed && reviewed.review) {
        aiReview = reviewed.review
        meta = reviewed.meta || meta
      }
    }
  } catch (e) {
    aiError = {
      message: e instanceof Error ? e.message : String(e),
      status: e && e.status ? Number(e.status) : null,
      code: e && e.code ? String(e.code) : null
    }
  }

  return c.json({
    success: true,
    review: {
      local: localReview,
      ai: aiReview,
      meta,
      aiError
    }
  })
})

app.post('/api/projects/:id/ai/storyboard/prompt-review', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const input = normalizeStoryboardPromptReviewInput(body)
  if (!String(input.projectTitle || '').trim()) {
    const project = await ctx.readProjectJson(id).catch(() => null)
    input.projectTitle = String(project && project.title ? project.title : '').trim()
  }

  const localReview = reviewStoryboardPromptLocally(input)
  const studio = await getEffectiveStudioConfig(ctx.ROOT).catch(() => null)
  const provider = String(studio?.effective?.prompt?.provider || '').trim().toLowerCase()
  const model = studio?.effective?.prompt?.model || undefined
  const apiUrl = studio?.effective?.prompt?.apiUrl || undefined
  const proxyUrl = studio?.effective?.network?.proxyUrl || undefined

  let aiReview = { ...localReview }
  let meta = { provider: 'local', model: null, api: null, durationMs: 0, note: 'local_precheck_only' }
  let aiError = null

  try {
    if (provider && provider !== 'none') {
      const reviewed = await reviewStoryboardPromptWithAi({ input, provider, model, apiUrl, proxyUrl })
      if (reviewed && reviewed.review) {
        aiReview = reviewed.review
        meta = reviewed.meta || meta
      }
    }
  } catch (e) {
    aiError = {
      message: e instanceof Error ? e.message : String(e),
      status: e && e.status ? Number(e.status) : null,
      code: e && e.code ? String(e.code) : null
    }
  }

  return c.json({
    success: true,
    review: {
      local: localReview,
      ai: aiReview,
      meta,
      aiError
    }
  })
})

app.post('/api/projects/:id/ai/review/blueprint', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))

  const cachePath = path.join(dir, 'ai_blueprint_review.json')
  let meta = null
  try { meta = await ctx.readJson(path.join(dir, 'meta.json')) } catch (_) { meta = null }
  let project = null
  try { project = await ctx.readJson(path.join(dir, 'project.json')) } catch (_) { project = null }
  let scripts = null
  try { scripts = await ctx.readJson(path.join(dir, 'scripts.json')) } catch (_) { scripts = ctx.defaultScripts() }
  let currBlueprint = null
  try { currBlueprint = await ctx.readJson(path.join(dir, 'blueprint.json')) } catch (_) { currBlueprint = null }

  const expectedFormula = meta && typeof meta === 'object' ? meta.aiFormula : null
  const compiled = compileBlueprintFromScripts({ scripts, prevBlueprint: currBlueprint, expectedFormula })
  const validation = validateBlueprintDoc(compiled.blueprint)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  const routeOverride = body && body.modelRoute && typeof body.modelRoute === 'object'
    ? body.modelRoute
    : (body && typeof body === 'object' ? body : {})
  const provider = String(routeOverride.provider || studio.effective.scripts.provider || process.env.STUDIO_AI_PROVIDER || 'local').toLowerCase()
  const model = routeOverride.model || studio.effective.scripts.model || undefined
  const apiUrl = routeOverride.apiUrl || studio.effective.scripts.apiUrl || undefined
  const startedAt = Date.now()
  if (!isOpenAICompatibleProvider(provider)) {
    const review = reviewBlueprintLocally({ formula: expectedFormula, report: compiled.report, validation })
    try {
      await ctx.writeJson(cachePath, {
        schemaVersion: '1.0',
        updatedAt: ctx.nowIso(),
        projectId: id,
        scriptsUpdatedAt: String(scripts && scripts.updatedAt || ''),
        formula: expectedFormula || null,
        review,
        meta: { provider: 'local', durationMs: Math.max(0, Date.now() - startedAt) }
      })
    } catch (_) {}
    return c.json({
      success: true,
      review,
      meta: { provider: 'local', durationMs: Math.max(0, Date.now() - startedAt) },
      report: compiled.report,
      validation
    })
  }

  try {
    const ai = await reviewBlueprintViaOpenAI({
      projectTitle: project && project.title ? String(project.title) : '',
      formula: expectedFormula,
      scripts,
      report: compiled.report,
      validation,
      provider,
      apiUrl,
      model
    })
    const reviewMeta = {
      ...(ai.meta || {}),
      routeId: routeOverride.routeId || null,
      strictRoute: Boolean(routeOverride.strict)
    }
    try {
      console.log(
        `[talkscene] ai.blueprint_review project=${id} provider=${reviewMeta.provider || provider || 'localoxml'} model=${reviewMeta.model || '-'} api=${reviewMeta.api || '-'} routeId=${reviewMeta.routeId || 'default'} ms=${reviewMeta.durationMs || 0}`
      )
    } catch (_) {}
    try {
      await ctx.writeJson(cachePath, {
        schemaVersion: '1.0',
        updatedAt: ctx.nowIso(),
        projectId: id,
        scriptsUpdatedAt: String(scripts && scripts.updatedAt || ''),
        formula: expectedFormula || null,
        review: ai.review,
        meta: reviewMeta
      })
    } catch (_) {}
    return c.json({ success: true, review: ai.review, meta: reviewMeta, report: compiled.report, validation })
  } catch (e) {
    try {
      console.error('[talkscene] ai blueprint review failed:', e instanceof Error ? e.message : String(e))
    } catch (_) {}
    const review = reviewBlueprintLocally({ formula: expectedFormula, report: compiled.report, validation })
    try {
      await ctx.writeJson(cachePath, {
        schemaVersion: '1.0',
        updatedAt: ctx.nowIso(),
        projectId: id,
        scriptsUpdatedAt: String(scripts && scripts.updatedAt || ''),
        formula: expectedFormula || null,
        review,
        meta: { provider: 'local', durationMs: Math.max(0, Date.now() - startedAt) }
      })
    } catch (_) {}
    return c.json({
      success: true,
      review,
      meta: { provider: 'local', durationMs: Math.max(0, Date.now() - startedAt) },
      report: compiled.report,
      validation
    })
  }
})

app.get('/api/projects/:id/ai/review/blueprint', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const cachePath = path.join(dir, 'ai_blueprint_review.json')
  try {
    const cached = await ctx.readJson(cachePath)
    return c.json({ success: true, cached })
  } catch (_) {
    return c.json({ success: true, cached: null })
  }
})

// 审核记录查询与决策
app.get('/api/projects/:id/ai/reviews', async (c) => {
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const status = String(c.req.query('status') || '').trim()
  const reviews = await listImageReviews(dir, { status })
  return c.json({ success: true, reviews, mode: ctx.resolveImageReviewMode(c, {}) })
})

app.post('/api/projects/:id/ai/reviews/:reviewId/approve', async (c) => {
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const review = await getImageReview(dir, c.req.param('reviewId'))
  if (!review) return c.json({ success: false, error: 'review_not_found' }, 404)
  if (review.status !== 'pending') return c.json({ success: false, error: 'review_already_decided', message: `审核已处理（${review.status}）` }, 409)

  if (review.phase === 'pre_generate') {
    const decided = await decideImageReview(dir, review.reviewId, { approved: true })
    // 批准后立即在后台执行原操作（携带旁路令牌，任务进度经 /ai/tasks 可见）
    const exec = review.execute && typeof review.execute === 'object' ? review.execute : null
    if (exec && exec.endpoint) {
      const port = Number(process.env.PORT || 1999)
      ;(async () => {
        try {
          await fetch(`http://127.0.0.1:${port}${exec.endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-pre-generate-approved': review.reviewId },
            body: JSON.stringify(exec.payload || {})
          })
        } catch (_) { /* 执行失败由任务进度/日志体现 */ }
      })()
    }
    return c.json({ success: true, review: decided, executed: Boolean(exec && exec.endpoint) })
  }

  if (review.phase === 'lock_confirm') {
    let plan = null
    try {
      plan = await ctx.persistPrimaryReferenceLock(id, dir, review.assetId, review.resultImagePath)
    } catch (e) {
      // 文件缺失/损坏：显式失败，审核保持 pending，不写假引用
      const code = String(e && e.code || 'lock_persist_failed')
      const msg = String(e && e.message || e)
      return c.json({ success: false, error: code, message: msg }, Number(e && e.status) || 400)
    }
    if (!plan) return c.json({ success: false, error: 'lock_target_missing', message: '未找到待锁定的资产或计划' }, 400)
    const decided = await decideImageReview(dir, review.reviewId, { approved: true })
    // 锁定确认后自动跟进线稿生成（manual 模式下会先挂线稿的出图前审核）
    const port = Number(process.env.PORT || 1999)
    ;(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(id)}/ai/story/assets/lineart`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetId: review.assetId })
        })
      } catch (_) { /* 线稿跟进失败不阻断锁定结果 */ }
    })()
    return c.json({ success: true, review: decided, plan, lineartTriggered: true })
  }

  if (review.phase === 'scene_bind') {
    // S4-02：人工确认绑定行为不变，仅补文件真实性校验；文件缺失/损坏时显式失败，审核保持 pending 不被消费
    const fileGate = await verifyStoryAssetReferenceFile({ dir, assetPath: String(review.resultImagePath || '') })
    if (!fileGate.ok) {
      return c.json({ success: false, error: fileGate.code, message: `场景图绑定被阻断：${fileGate.message}` }, 400)
    }
    const bundle = await ctx.readProjectBundle(id)
    const sceneName = String(review.params && review.params.sceneName || review.sceneId || '').trim()
    const projectAsset = await ctx.persistSceneBackgroundBinding({
      dir,
      rawProject: bundle.rawProject,
      story: bundle.story,
      sceneId: review.sceneId,
      sceneName,
      assetPath: review.resultImagePath,
      prompt: review.prompt,
      provider: review.params && review.params.provider,
      remoteUrl: review.params && review.params.remoteUrl,
      references: review.params && review.params.references
    })
    const decided = await decideImageReview(dir, review.reviewId, { approved: true })
    await ctx.maybeCloseRenderAllBatchTask(id, dir)
    return c.json({ success: true, review: decided, projectAsset })
  }

  return c.json({ success: false, error: 'unknown_review_phase' }, 400)
})

// 2026-10-08 渲染批次收敛钩子（故事2 实证：批次 7 场景全部挂 scene_bind 审核后任务停留 pending_review、
// done=false——2 过 5 拒后批次永久悬挂，后续 render-all 一律 409 render_all_running）。
// scene_bind 审核每决断一条调用一次：当项目已无待决 scene_bind 审核且批次仍开着，收敛批次任务。
// [拆分回收] 辅助定义 已回 index.js

app.post('/api/projects/:id/ai/reviews/:reviewId/reject', async (c) => {
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const review = await getImageReview(dir, c.req.param('reviewId'))
  if (!review) return c.json({ success: false, error: 'review_not_found' }, 404)
  if (review.status !== 'pending') return c.json({ success: false, error: 'review_already_decided' }, 409)
  const decided = await decideImageReview(dir, review.reviewId, { approved: false, rejectReason: String(body?.reason || '') })
  await ctx.maybeCloseRenderAllBatchTask(id, dir)
  return c.json({ success: true, review: decided })
})

// 批量批准某一阶段的全部待审核（典型：批量渲染后的 11 张场景图一次过审）
app.post('/api/projects/:id/ai/reviews/approve-all', async (c) => {
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const phase = String(body?.phase || 'scene_bind').trim()
  const pending = await listImageReviews(dir, { status: 'pending' })
  const targets = pending.filter((item) => item.phase === phase)
  const results = []
  const port = Number(process.env.PORT || 1999)
  for (const review of targets) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(id)}/ai/reviews/${encodeURIComponent(review.reviewId)}/approve`, { method: 'POST' })
      const json = await resp.json().catch(() => ({}))
      results.push({ reviewId: review.reviewId, ok: resp.ok && json.success })
    } catch (e) {
      results.push({ reviewId: review.reviewId, ok: false, error: e && e.message ? String(e.message) : String(e) })
    }
  }
  const okCount = results.filter((r) => r.ok).length
  return c.json({ success: true, total: targets.length, okCount, results })
})

// AI 任务进度查询：编辑器轮询用，让长任务（锁定测试/场景渲染）的阶段在 UI 可见

// AI：动作立绘抽卡池——候选图与角色锁定主参考的一致性评分（Kimi 视觉评审）。
// 2026-09-01 新增：抽卡池模式下每张候选图与主参考对比打分（身份/画风/服装），姿势差异不扣分。
// 评审不可用（无 key/网络失败）返回明确错误，不伪造分数。
app.post('/api/projects/:id/ai/character/pose-review', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const characterId = String(body?.characterId || '').trim()
  const planAssetId = String(body?.planAssetId || '').trim()
  const relIn = String(body?.assetPath || '').trim().replace(/^\/+/, '')
  if (!characterId && !planAssetId) return c.json({ success: false, error: 'missing_characterId', message: 'characterId/planAssetId 至少提供一个' }, 400)
  if (!relIn || !relIn.startsWith('assets/')) {
    return c.json({ success: false, error: 'missing_assetPath', message: 'assetPath 必须是项目内 assets/ 相对路径' }, 400)
  }
  const candAbs = path.join(dir, relIn)
  if (!candAbs.startsWith(dir)) return c.json({ success: false, error: 'invalid_path', message: 'assetPath 越界' }, 400)
  if (!(await ctx.existsFile(candAbs))) return c.json({ success: false, error: 'file_not_found', message: '候选图不存在' }, 404)

  // 解析锁定主参考（与 ch.sprite 同款逻辑：characterId → ch.ai.referenceAssetId，回退 imageAssetId → uri 转项目内路径）
  // 2026-09-16 道具泛化：planAssetId → 计划资产 primaryReferenceAssetUri（回退 latestRecommended），供道具状态变体评审复用同一链路。
  let refBytes = null
  let refAbsPath = null
  let characterName = ''
  try {
    if (planAssetId) {
      const plan = await ctx.readStoryAssetPlanIfExists(id)
      const pa = (plan && Array.isArray(plan.assets) ? plan.assets : []).find((a) => String(a && a.id || '').trim() === planAssetId) || null
      characterName = String((pa && pa.name) || planAssetId).trim()
      const uri = String((pa && (pa.primaryReferenceAssetUri || pa.latestRecommendedReferenceAssetUri)) || '').trim()
      const rel = uri
        .replace(/^https?:\/\/[^/]+\/project-assets\/[^/]+\//i, '')
        .replace(/^\/project-assets\/[^/]+\//, '')
      if (rel.startsWith('assets/')) {
        const refAbs = path.join(dir, rel)
        if (refAbs.startsWith(dir) && (await ctx.existsFile(refAbs))) {
          refBytes = await readFile(refAbs)
          refAbsPath = refAbs
        }
      }
    } else {
      const proj = await ctx.readJson(path.join(dir, 'project.json'))
      const ch = (proj && Array.isArray(proj.characters) ? proj.characters : []).find((x) => x && x.id === characterId) || null
      characterName = String((ch && ch.name) || '').trim()
      const refId = String((ch && ch.ai && ch.ai.referenceAssetId) || (ch && ch.imageAssetId) || '').trim()
      const asset = refId && proj && Array.isArray(proj.assets) ? proj.assets.find((a) => a && a.id === refId) || null : null
      const uri = String((asset && asset.uri) || '').trim()
      const rel = uri
        .replace(/^https?:\/\/[^/]+\/project-assets\/[^/]+\//i, '')
        .replace(/^\/project-assets\/[^/]+\//, '')
      if (rel.startsWith('assets/')) {
        const refAbs = path.join(dir, rel)
        if (refAbs.startsWith(dir) && (await ctx.existsFile(refAbs))) {
          refBytes = await readFile(refAbs)
          refAbsPath = refAbs
        }
      }
    }
  } catch (e) {
    try {
      console.log(`[talkscene] ch.pose_review:ref_fail project=${id} ch=${characterId || planAssetId} err=${e && e.message ? e.message : e}`)
    } catch (_) {}
  }
  if (!refBytes) {
    return c.json({ success: false, error: 'reference_not_found', message: '该角色/事物没有可用的锁定主参考图，无法评分' }, 400)
  }

  const apiKey = String(process.env.MOONSHOT_API_KEY || '').trim()
  // 2026-09-08 评审 provider 可切换：local_vl（默认，本地视觉模型 gemma 经 OMLX）/ kimi（云端，用户显式开启）/ auto（有 key 走 Kimi 否则本地）/ off。
  // 背景：Kimi 周配额（7 天窗口）耗尽时评审全灭；gemma-4-26b-a4b-it-4bit 经 OMLX 实测多模态可用（2026-09-08 用户指令：默认本地优先，Kimi 留给用户自行切换）。
  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  const reviewCfg = (studio && studio.effective && studio.effective.review && typeof studio.effective.review === 'object') ? studio.effective.review : {}
  const providerSetting = String(process.env.STUDIO_POSE_REVIEW_PROVIDER || reviewCfg.poseReviewProvider || 'local_vl').trim().toLowerCase()
  if (providerSetting === 'off') {
    return c.json({ success: false, error: 'review_disabled', message: 'AI 评分已在设置中关闭（评审不阻断命名锁定，可人工目检后直接锁定）' }, 501)
  }
  const useKimi = providerSetting === 'kimi' || (providerSetting === 'auto' && Boolean(apiKey))
  const useLocalVl = providerSetting === 'local_vl' || (providerSetting === 'auto' && !apiKey)
  if (useKimi && !apiKey) {
    return c.json({ success: false, error: 'review_unavailable', message: '未配置 MOONSHOT_API_KEY，Kimi 评审不可用；可改 local_vl 或 off' }, 501)
  }

  const startedAt = Date.now()
  try {
    const refSniff = sniffImageMetaFromBytes(refBytes)
    const candBytes = await readFile(candAbs)
    const candSniff = sniffImageMetaFromBytes(candBytes)
    if (!refSniff || !candSniff) {
      return c.json({ success: false, error: 'invalid_image', message: '图片格式不可识别' }, 400)
    }
    let out
    if (useLocalVl) {
      // 本地 VL 输入降采样（≤512px）：VL token 化随分辨率放大，原图会把 prefill 推过 OMLX 内存护栏；
      // 身份/画风/服装评审不需要全分辨率（python3+PIL 本机可用，与 ch.sprite 白底合成同款依赖）
      const shrink = async (absIn) => {
        try {
          const absOut = absIn.replace(/\.(png|jpe?g)$/i, '') + '_vl512.png'
          const s0 = await stat(absIn)
          const s1 = await stat(absOut).catch(() => null)
          if (!(s1 && s1.mtimeMs >= s0.mtimeMs)) {
            await new Promise((resolve, reject) => {
              const py = spawn('python3', ['-c',
                "import sys; from PIL import Image; im=Image.open(sys.argv[1]).convert('RGBA'); bg=Image.new('RGBA', im.size, (255,255,255,255)); bg.alpha_composite(im); im=bg.convert('RGB'); im.thumbnail((512,512)); im.save(sys.argv[2])",
                absIn, absOut])
              py.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('shrink_exit_' + code))))
              py.on('error', reject)
            })
          }
          return await readFile(absOut)
        } catch (_) { return null }
      }
      const refSmallBytes = (refAbsPath ? await shrink(refAbsPath) : null) || refBytes
      const candSmallBytes = (await shrink(candAbs)) || candBytes
      const localBaseUrl = String(reviewCfg.poseReviewBaseUrl || process.env.LOCALOXML_BASE_URL || 'http://127.0.0.1:18888/v1').trim()
      const localModel = String(reviewCfg.poseReviewModel || process.env.STUDIO_POSE_REVIEW_MODEL || 'gemma-4-26b-a4b-it-4bit').trim()
      const localKey = String(process.env.LOCALOXML_API_KEY || 'omlx123').trim()
      out = await reviewCharacterPoseConsistencyWithLocalVl({
        baseUrl: localBaseUrl,
        apiKey: localKey,
        model: localModel,
        characterName,
        referenceImageDataUrl: `data:image/png;base64,${refSmallBytes.toString('base64')}`,
        candidateImageDataUrl: `data:image/png;base64,${candSmallBytes.toString('base64')}`
      })
    } else {
      out = await reviewCharacterPoseConsistencyWithAi({
        apiKey,
        baseUrl: process.env.MOONSHOT_BASE_URL || 'https://api.kimi.com/coding/v1',
        model: 'kimi-for-coding',
        characterName,
        referenceImageDataUrl: `data:${refSniff.contentType};base64,${refBytes.toString('base64')}`,
        candidateImageDataUrl: `data:${candSniff.contentType};base64,${candBytes.toString('base64')}`
      })
    }
    try {
      console.log(`[talkscene] ch.pose_review:ok project=${id} ch=${characterId} score=${out.score} provider=${out.meta?.provider || '?'} ms=${Math.max(0, Date.now() - startedAt)}`)
    } catch (_) {}
    return c.json({ success: true, score: out.score, reason: out.reason, provider: out.meta?.provider || null })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    try {
      console.log(`[talkscene] ch.pose_review:fail project=${id} ch=${characterId} ms=${Math.max(0, Date.now() - startedAt)} err=${msg}`)
    } catch (_) {}
    return c.json({ success: false, error: 'ai_failed', message: msg }, 502)
  }
})

// AI：姿势变体——AI 生成姿势提示词（中文稿 → 翻译英文稿，与主流程「中文稿→英文稿」双稿一致）。
// 2026-09-01 新增：只写视角/动作/表情/手势 + 服装延续约束，严禁背景场景词；失败显式报错不伪造。
// 中文稿生成与英文稿翻译串行执行（本地模型同模型多次调用禁止并行，OMLX KV 护栏）。
}
