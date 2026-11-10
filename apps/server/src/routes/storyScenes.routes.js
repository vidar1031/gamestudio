// ---------------------------------------------------------------------------
// registerStoryScenesRoutes（模块化拆分机械迁出，字义未改；协议层+族内编排，域算法引自 ../ai/*，index 本地辅助经 ctx 注入）
// ---------------------------------------------------------------------------
import path from 'node:path'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rename, stat, writeFile, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import crypto from 'node:crypto'
import { genId } from '../ai/scripts.js'
import { classifyAiError, createTraceId, logStage } from '../ai/runtime.js'
import { createAiTask, getAiTask, listAiTasks, updateAiTask } from '../ai/taskProgress.js'
import { computeScenePlacements } from '../services/placementDecision.js'
import { generateBackgroundImage } from '../ai/background.js'
import { optimizeGeneratedImage, IMAGE_KIND } from '../ai/imageOptimize.js'
import { buildStoryAssetPlan, buildStorySceneRenderSpec, resolveStoryStylePreset, summarizeStoryAssetPlan } from '../ai/storyAssets.js'
import { sniffImageMetaFromBytes, verifyStoryAssetReferenceFile } from '../ai/storyAssetReferenceGate.js'
import { checkSceneSuccess, createSceneBatch, loadSceneBatch, resumeSceneBatch, runSceneBatch } from '../ai/sceneBatchQueue.js'
import { buildCompositionInput, extractStoryComposition } from '../ai/storyComposition.js'
import { getStoryImageCoverage } from '../ai/storyCoverage.js'
import { runStorySceneReview, appendSceneReviewFeedback, readLatestSceneReviewRound } from '../ai/storySceneReview.js'
import { renderSizeOf } from '../ai/storyRenderSizes.js'
import { runStoryWalkthrough } from '../ai/storyWalkthrough.js'
import { getEffectiveStudioConfig } from '../studio/settings.js'
import { getStudioSecret } from '../studio/secrets.js'
import { synthesizeTts } from '../ai/tts.js'
import { onAiTaskCancel, throwIfAiTaskCancelled } from '../ai/taskCancellation.js'
import { attachImageReviewResult, createImageReview, decideImageReview, findPendingReview } from '../review/imageReviewStore.js'
import { recordCreationEvent } from '../creationBuffer.js'
import { storyInputGate } from '../middleware/storyInputGate.js'

export function registerStoryScenesRoutes(app, ctx) {
// [拆分] POST /api/projects/:id/export 已迁至 apps/server/src/routes/export.routes.js
// ---------------------------------------------------------------------------
// 2026-10-12 ⑤ 走查入链（TS-52）：导出后自动 headless 全结局路径走查 + 截图存档 + 验收报告。
// 脱离监控的最后一道闸：不再人工打开浏览器点——链路自动跑，产出 walkthrough/report_*.json +
// 每屏截图（<project>/walkthrough/）；有破图/空文本/按钮缺失即 issues 明示，不静默放行。
// 前置：必须先有导出构建（先跑 TS-08）。
// ---------------------------------------------------------------------------
app.post('/api/projects/:id/ai/story/walkthrough', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  // 前置检查：导出构建存在
  const distPath = path.join(dir, 'builds', 'latest', 'dist', 'index.html')
  if (!(await ctx.existsFile(distPath))) {
    return c.json({ success: false, error: 'missing_export', message: '请先导出项目（TS-08），再走查。' }, 400)
  }
  const story = await ctx.readJson(path.join(dir, 'story.json')).catch(() => null)
  if (!story || !Array.isArray(story.nodes) || !story.nodes.length) {
    return c.json({ success: false, error: 'missing_story', message: '未找到故事文档。' }, 400)
  }

  const body = await c.req.json().catch(() => ({}))
  const port = Number(process.env.PORT || 1999)
  const demoBaseUrl = `http://127.0.0.1:${port}/demos/${encodeURIComponent(id)}/latest/dist/index.html`
  const task = createAiTask(id, 'story.walkthrough', { total: 1, message: '走查中：headless 全结局路径' })
  const traceId = createTraceId()
  logStage({ stage: 'story.walkthrough', event: 'start', traceId, project: id })
  try {
    const { runStoryWalkthrough } = await import('./ai/storyWalkthrough.js')
    const { report, reportFile, outDir } = await runStoryWalkthrough({
      dir,
      projectId: id,
      story,
      demoBaseUrl,
      maxPaths: ctx.clampInt(body?.maxPaths, 1, 8, 4)
    })
    updateAiTask(task.taskId, {
      stage: report.ok ? 'done' : 'partial',
      done: true,
      current: 1,
      message: report.ok ? `走查通过：${report.paths} 条路径零问题` : `走查完成：${report.paths} 条路径，发现 ${report.issues} 个问题`,
      result: { ok: report.ok, paths: report.paths, issues: report.issues, reportFile: `${outDir}/${reportFile}` }
    })
    logStage({ stage: 'story.walkthrough', event: report.ok ? 'ok' : 'partial', traceId, project: id, item: `paths:${report.paths} issues:${report.issues}` })
    return c.json({ success: true, taskId: task.taskId, ok: report.ok, paths: report.paths, issues: report.issues, reportFile: `${outDir}/${reportFile}`, report })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    updateAiTask(task.taskId, { stage: 'error', done: true, error: msg, message: `走查失败：${msg}` })
    logStage({ stage: 'story.walkthrough', event: 'error', traceId, project: id, item: msg.slice(0, 200) })
    const mapped = classifyAiError(e)
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

// TS-53 场景图审核（2026-10-14，守护台审图中心接入）：逐场景整图（走查截图优先/背景图回退）
// 提交 control 审图中心评审，结果落 reviews/scene_reviews.jsonl，编辑器「场景图审核」面板消费。
// 长任务经 /ai/tasks 暴露进度（kind story.scene.review）；control 不可达/评审失败显式 failed，不写假结论。
app.post('/api/projects/:id/ai/story/scene-review', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const bundle = await ctx.readProjectBundle(id)
  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan || !Array.isArray(plan.scenes) || !plan.scenes.length) {
    return c.json({ success: false, error: 'missing_asset_plan', message: '未找到资产计划（plan.json），请先完成资产计划与场景绑定。' }, 400)
  }
  const story = bundle.story
  if (!story || !Array.isArray(story.nodes) || !story.nodes.length) {
    return c.json({ success: false, error: 'missing_story', message: '未找到故事文档。' }, 400)
  }
  const sceneIds = Array.isArray(body?.sceneIds) ? body.sceneIds.map((x) => String(x || '').trim()).filter(Boolean) : null

  const task = createAiTask(id, 'story.scene.review', { total: 1, message: '场景图审核：收集整图中…' })
  const traceId = createTraceId()
  logStage({ stage: 'story.scene.review', event: 'start', traceId, project: id })
  // 后台执行（VL 评审逐张约 27s，长任务经任务进度轮询）
  void (async () => {
    try {
      const { results, summary, reviewIds, roundId, reviewLogFile } = await runStorySceneReview({
        id,
        dir,
        story,
        plan,
        project: bundle.project,
        sceneIds,
        onProgress: (message) => updateAiTask(task.taskId, { message })
      })
      updateAiTask(task.taskId, {
        stage: 'done',
        done: true,
        current: 1,
        message: `场景图审核完成：通过 ${summary.pass} · 存疑 ${summary.suspect} · 不合格 ${summary.fail}`,
        result: { reviewIds, roundId, summary, results, reviewLogFile: path.relative(dir, reviewLogFile) }
      })
      logStage({ stage: 'story.scene.review', event: 'ok', traceId, project: id, item: `pass:${summary.pass} suspect:${summary.suspect} fail:${summary.fail}` })
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      updateAiTask(task.taskId, { stage: 'error', done: true, error: msg, message: `场景图审核失败：${msg}` })
      logStage({ stage: 'story.scene.review', event: 'error', traceId, project: id, item: msg.slice(0, 200) })
    }
  })()
  return c.json({ success: true, taskId: task.taskId }, 202)
})

// TS-53 读取最新一轮审核记录（含后续人工处置 feedback_pending/human_confirmed）
app.get('/api/projects/:id/ai/story/scene-review', async (c) => {
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const { latest, rounds } = readLatestSceneReviewRound({ dir })
  return c.json({ success: true, latest, rounds })
})

// TS-53 人工处置记录：打回重出待处理（feedback_pending，附建议合入说明）/ 确认通过（human_confirmed）
app.post('/api/projects/:id/ai/story/scene-review/feedback', async (c) => {
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  try {
    const record = appendSceneReviewFeedback({
      dir,
      sceneId: body?.sceneId,
      sceneName: body?.sceneName,
      action: body?.action,
      note: body?.note
    })
    return c.json({ success: true, record })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    return c.json({ success: false, error: e && e.code || 'scene_review_feedback_failed', message: msg }, 400)
  }
})


// [拆分] POST /api/projects/:id/export/publish 已迁至 apps/server/src/routes/export.routes.js
// [拆分] GET /api/projects/:id/exports 已迁至 apps/server/src/routes/export.routes.js
// [拆分] DELETE /api/projects/:id/exports/:buildId 已迁至 apps/server/src/routes/export.routes.js

// AI：提取场景构图规格（2026-10-04）——逐场景产出元素摆放"需求单"（位置/大小/远近/前后遮挡/朝向/状态+原文依据），
// 替代摆位的纯默认值兜底。候选制：默认只返回不落盘；body.persist=true 时写入 plan.scenes[].composition（生产链审核后调用）。
app.post('/api/projects/:id/ai/story/composition', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.prompt) {
    return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)
  }
  if (!studio.effective.prompt.provider || studio.effective.prompt.provider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“提示词生成”并选择 Provider/Model' }, 400)
  }

  try {
    const bundle = await ctx.readProjectBundle(id)
    const plan = await ctx.readStoryAssetPlanIfExists(id)
    if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)
    const input = buildCompositionInput({ project: bundle.project, story: bundle.story, plan })
    if (!input.scenes.length) {
      return c.json({ success: false, error: 'no_composable_scenes', message: '没有含出场元素的场景可构图。' }, 400)
    }
    const body = await c.req.json().catch(() => ({}))
    const timeoutMs = ctx.clampInt(body?.timeoutMs, 5_000, 600_000, 120_000)
    const { result, meta } = await extractStoryComposition({
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model,
      apiUrl: studio.effective.prompt.apiUrl,
      proxyUrl: studio.effective.network.proxyUrl,
      timeoutMs,
      input
    })

    let persisted = false
    if (body?.persist === true) {
      const byId = new Map((result.scenes || []).map((s) => [String(s.sceneId || '').trim(), s]))
      const nextPlan = {
        ...plan,
        generatedAt: ctx.nowIso(),
        scenes: (Array.isArray(plan.scenes) ? plan.scenes : []).map((s) => {
          const hit = byId.get(String(s && s.sceneId || '').trim())
          return hit ? { ...s, composition: { cameraNote: hit.cameraNote || '', items: hit.items || [], source: 'ai', updatedAt: ctx.nowIso() } } : s
        })
      }
      nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
      await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
      persisted = true
    }

    return c.json({ success: true, composition: result, persisted, meta })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    // 2026-10-09 构图 500 可诊断（白雪公主 9 人设批次失败一度只能靠猜）：真实错误落日志
    console.error(`[story.composition] project=${id} error=${msg}`)
    logStage({ stage: 'story.composition', event: 'error', traceId: createTraceId(), project: id, item: msg.slice(0, 300) })
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

// D1（2026-10-25 用户裁决）：占位预演内嵌中栏 + 占位块可拖动编排——拖动结束把该幕各块归一化 x/y/scale
// 写回该幕构图需求单草稿（plan.scenes[].composition，source='previz' 区别于 AI 提取的 'ai'）。
// 窄写口：只接收坐标值（x/y/scale/zIndex），kind/stateKey/blocking/evidence 等语义字段沿用既有项或按资产类目补齐；
// 幂等（同值重写无副作用），经 saveStoryAssetPlan mergeAssetsById 纪律落盘。LLM 提取端点（上方）不动。
app.put('/api/projects/:id/ai/story/scenes/:sceneId/composition-draft', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const sceneId = String(c.req.param('sceneId') || '').trim()
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)
  const scenes = Array.isArray(plan.scenes) ? plan.scenes : []
  const scene = scenes.find((s) => String(s && s.sceneId || '').trim() === sceneId)
  if (!scene) return c.json({ success: false, error: 'missing_scene', message: '资产计划中无该场景条目。' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const itemsIn = Array.isArray(body?.items) ? body.items : []
  const assetById = new Map((Array.isArray(plan.assets) ? plan.assets : []).map((a) => [String(a && a.id || ''), a]))
  const prevItems = Array.isArray(scene.composition && scene.composition.items) ? scene.composition.items : []
  const prevBySubject = new Map(prevItems.map((it) => [String(it && it.subjectId || '').trim(), it]))
  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v)))
  const clampScale = (v) => Math.max(0.05, Math.min(1, Number(v)))

  const items = []
  // 2026-11-09 防静默丢失：被过滤的块如实计数并返回（历史疑似通道——资产被移除/换 id 后，
  // 预演保存把旧块全部静默丢弃，空数组覆盖既有草稿，用户无从察觉）
  let dropped = 0
  const droppedSubjectIds = []
  for (const raw of itemsIn) {
    const subjectId = String(raw && raw.subjectId || '').trim()
    // F 波（2026-10-26 用户裁决：一个大元素可分多个小元素组合）：带 parentAssetId+subName 的项=子元素
    // （演示编排语义，不必是 plan 资产）——豁免资产存在校验；父元素必须存在
    const parentAssetId = String(raw?.parentAssetId || '').trim().slice(0, 64)
    const subName = String(raw?.subName || '').trim().slice(0, 32)
    const isSub = Boolean(parentAssetId && subName)
    if (!subjectId) { dropped += 1; continue }
    if (isSub) {
      if (!assetById.has(parentAssetId)) { dropped += 1; droppedSubjectIds.push(subjectId); continue } // 父元素非计划资产拒收
    } else if (!assetById.has(subjectId)) { dropped += 1; droppedSubjectIds.push(subjectId); continue } // 非计划资产一律拒收（不编造元素）
    if (!Number.isFinite(Number(raw?.x)) || !Number.isFinite(Number(raw?.y))) { dropped += 1; droppedSubjectIds.push(subjectId); continue }
    const prev = prevBySubject.get(subjectId) || {}
    const asset = assetById.get(subjectId) || assetById.get(parentAssetId)
    items.push({
      ...prev,
      subjectId,
      kind: String(prev.kind || '').trim() || String(asset?.category || '').trim() || 'prop',
      x: clamp01(raw.x),
      y: clamp01(raw.y),
      scale: Number.isFinite(Number(raw?.scale)) ? clampScale(raw.scale) : (Number.isFinite(Number(prev.scale)) ? prev.scale : 0.5),
      zIndex: Number.isFinite(Number(raw?.zIndex)) ? Math.round(Number(raw.zIndex)) : (Number.isFinite(Number(prev.zIndex)) ? prev.zIndex : 3),
      // E 波（2026-10-26）：朝向/姿态进编排草稿——flipX/flipY 布尔钳制（与合成层 transform 同语义；LLM 口径 flipH 由消费端兼容），
      // stateKey 字符串消毒（变体选择键，placementDecision 按 stateKey 匹配 poseVariants/stateVariants）
      // 2026-11-01：imageAssetId=占位预览图显式选择（项目资产 id），摆位消费端按它优先选图；空串=清除
      ...(raw?.flipX !== undefined ? { flipX: raw.flipX === true } : {}),
      ...(raw?.flipY !== undefined ? { flipY: raw.flipY === true } : {}),
      ...(raw?.stateKey !== undefined ? { stateKey: String(raw.stateKey || '').trim().slice(0, 64) } : {}),
      ...(raw?.imageAssetId !== undefined ? { imageAssetId: String(raw.imageAssetId || '').trim().slice(0, 128) } : {}),
      ...(isSub ? { parentAssetId, subName } : {})
    })
    if (items.length >= 24) break // F 波：上限 12→24（子元素组合占额）
  }

  const nextPlan = {
    ...plan,
    generatedAt: ctx.nowIso(),
    scenes: scenes.map((s) =>
      String(s && s.sceneId || '').trim() === sceneId
        ? { ...s, composition: { cameraNote: String(scene.composition?.cameraNote || ''), items, source: 'previz', updatedAt: ctx.nowIso() } }
        : s
    )
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
  logStage({ stage: 'story.composition.draft', event: 'ok', traceId: createTraceId(), project: id, item: `${sceneId} items=${items.length}${dropped ? ` dropped=${dropped}` : ''}` })
  return c.json({ success: true, sceneId, items: items.length, dropped, droppedSubjectIds: droppedSubjectIds.slice(0, 12) })
})

// B 波（2026-10-25，ui_蓝图工作室定义.md §4.5）：场景级配音——真实合成（edge/say/openai/local 全通道继承 tts.js），
// 音频落项目 assets/ai/voice/<sceneId>.<ext>，写回 plan.sceneVoices[sceneId]（mergeAssetsById 纪律，幂等覆盖）。
// enabled.tts 关闭时 409 + 设置引导；时长经 afinfo 实测（测不出则 null，不编造）。
app.post('/api/projects/:id/ai/story/scenes/:sceneId/voice', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const sceneId = String(c.req.param('sceneId') || '').trim()
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const { effective } = await getEffectiveStudioConfig(ctx.ROOT)
  if (!effective.enabled.tts) {
    return c.json({ success: false, error: 'tts_disabled', message: '「语音合成」未启用：请到 设置 → 语音 TTS 启用并选择通道后重试' }, 409)
  }
  const provider = String(effective.tts?.provider || '').trim().toLowerCase()
  if (!provider || provider === 'none') {
    return c.json({ success: false, error: 'tts_not_configured', message: '请先在 设置 → 语音 TTS 选择合成通道' }, 400)
  }

  const body = await c.req.json().catch(() => ({}))
  const voiceId = String(body?.voiceId || '').trim() || String(effective.tts?.voice || '').trim()
  const speed = body?.speed != null ? Number(body.speed) : Number(effective.tts?.speed) || 1

  // 文本缺省=该幕故事文本（与场景元素分析同源的 story 节点）；再无则 400 引导
  const bundle = await ctx.readProjectBundle(id)
  const storyNodes = Array.isArray(bundle?.story?.nodes) ? bundle.story.nodes : []
  const node = storyNodes.find((n) => String(n?.id || '') === sceneId)
  const text = String(body?.text || '').trim() || String(node?.body?.text || node?.name || '').trim()
  if (!text) return c.json({ success: false, error: 'tts_empty_text', message: '本幕没有可合成的文本（请先补文本草稿）' }, 400)

  const task = createAiTask(id, 'story.scene.voice', { total: 1, message: `场景配音：${String(node?.name || sceneId).slice(0, 24)}` })
  try {
    const res = await synthesizeTts({
      provider,
      voice: voiceId,
      speed,
      format: String(effective.tts?.format || 'mp3'),
      text,
      apiUrl: effective.tts?.apiUrl,
      model: effective.tts?.model,
      secrets: { openaiApiKey: getStudioSecret('openai') },
      proxyUrl: effective.network?.proxyUrl || undefined
    })
    throwIfAiTaskCancelled()
    const voiceDir = path.join(dir, 'assets', 'ai', 'voice')
    await mkdir(voiceDir, { recursive: true })
    // 2026-11-03 用户裁决：生成即压缩——ffmpeg 可用时统一转码为 mp3 单声道 64k（交互故事导出带宽友好）；
    // 源已是压缩格式且体积很小（<128KB）则保留原件不重复转码。压缩元数据如实记录，不伪造。
    let finalBytes = res.bytes
    let finalExt = res.ext
    let compressed = false
    let compressNote = ''
    let originalBytes = res.bytes.length
    const safeSceneId = sceneId.replace(/[^A-Za-z0-9_.-]+/g, '_')
    const nonce = Date.now()
    const rawAbs = path.join(voiceDir, `${safeSceneId}.source-${nonce}.${res.ext}`)
    let convertedAbs = ''
    await writeFile(rawAbs, res.bytes)
    try {
      const probe = spawn('ffmpeg', ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] })
      const hasFfmpeg = await new Promise((resolve) => {
        probe.on('error', () => resolve(false))
        probe.on('close', (code) => resolve(code === 0))
      })
      throwIfAiTaskCancelled()
      if (hasFfmpeg && originalBytes >= 128 * 1024) {
        convertedAbs = path.join(voiceDir, `${safeSceneId}.next-${nonce}.mp3`)
        await new Promise((resolve, reject) => {
          const p = spawn('ffmpeg', ['-y', '-i', rawAbs, '-vn', '-ac', '1', '-b:a', '64k', convertedAbs], { stdio: ['ignore', 'pipe', 'ignore'] })
          const removeCancel = onAiTaskCancel(() => { try { p.kill('SIGKILL') } catch (_) {} })
          let err = ''
          p.stderr.on('data', (c) => { err += c })
          p.on('error', (error) => { removeCancel(); reject(error) })
          p.on('close', (code) => {
            removeCancel()
            try { throwIfAiTaskCancelled() } catch (error) { reject(error); return }
            if (code === 0) resolve()
            else reject(new Error(`ffmpeg_exit_${code}:${err.slice(0, 200)}`))
          })
        })
        finalBytes = (await readFile(convertedAbs))
        finalExt = 'mp3'
        compressed = true
        compressNote = `已压缩：${originalBytes}B → ${finalBytes.length}B（mp3 单声道 64k）`
      } else if (hasFfmpeg) {
        compressNote = originalBytes < 128 * 1024 ? '源文件已较小，保留原件（未重复转码）' : ''
      } else {
        compressNote = 'ffmpeg 不可用，保留原始音频（未压缩）'
      }
    } catch (e) {
      if (e?.code === 'AI_TASK_CANCELLED') throw e
      compressNote = `压缩失败，保留原始音频：${e && e.message ? e.message : String(e)}`
    } finally {
      await Promise.all([rm(rawAbs, { force: true }), convertedAbs ? rm(convertedAbs, { force: true }) : Promise.resolve()]).catch(() => {})
    }
    throwIfAiTaskCancelled()
    const fileName = `${sceneId.replace(/[^A-Za-z0-9_.-]+/g, '_')}.${finalExt}`
    await writeFile(path.join(voiceDir, fileName), finalBytes)
    const audioAssetUri = `assets/ai/voice/${fileName}`

    // 时长实测（macOS afinfo；测不出=null 诚实）
    let durationMs = null
    try {
      const info = await new Promise((resolve) => {
        const p = spawn('afinfo', [path.join(voiceDir, fileName)], { stdio: ['ignore', 'pipe', 'ignore'] })
        const chunks = []
        p.stdout.on('data', (d) => chunks.push(d))
        p.on('error', () => resolve(''))
        p.on('close', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      })
      const m = String(info).match(/estimated duration:\s*([\d.]+)/i)
      if (m) durationMs = Math.round(Number(m[1]) * 1000)
    } catch {}

    const plan = (await ctx.readStoryAssetPlanIfExists(id)) || {
      schemaVersion: '1.0',
      generatedAt: ctx.nowIso(),
      assets: [],
      scenes: storyNodes.map((n, i) => ({ sceneId: String(n?.id || ''), sceneIndex: i + 1, sceneName: String(n?.name || n?.id || ''), assetIds: [], promptAssets: [] })),
      summary: null
    }
    const sceneVoices = { ...(plan.sceneVoices && typeof plan.sceneVoices === 'object' ? plan.sceneVoices : {}) }
    sceneVoices[sceneId] = {
      voiceId,
      audioAssetUri,
      durationMs,
      text: text.slice(0, 500),
      generatedAt: ctx.nowIso(),
      status: 'ready',
      compressed,
      originalBytes,
      finalBytes: finalBytes.length,
      compressNote
    }
    const nextPlan = { ...plan, sceneVoices, generatedAt: ctx.nowIso() }
    nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
    throwIfAiTaskCancelled()
    await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })

    updateAiTask(task.taskId, { done: true, stage: 'done', current: 1, message: `配音完成：${String(node?.name || sceneId).slice(0, 24)}` })
    logStage({ stage: 'story.scene.voice', event: 'ok', traceId: createTraceId(), project: id, item: `${sceneId} ${audioAssetUri} ${durationMs ?? '-'}ms` })
    return c.json({ success: true, sceneId, voiceId, audioAssetUri, durationMs })
  } catch (e) {
    const code = e?.code === 'AI_TASK_CANCELLED' ? 'task_cancelled_by_user' : e && e.code ? String(e.code) : 'tts_failed'
    const message = e?.code === 'AI_TASK_CANCELLED' ? '配音已停止，未写回新音频' : e && e.message ? String(e.message) : String(e)
    console.error(`[story.scene.voice] project=${id} scene=${sceneId} error=${message}`)
    logStage({ stage: 'story.scene.voice', event: 'error', traceId: createTraceId(), project: id, item: message.slice(0, 300) })
    updateAiTask(task.taskId, { done: true, stage: 'failed', error: message })
    const status = code === 'task_cancelled_by_user' ? 409 : code === 'tts_provider_pending' ? 501 : /^tts_(missing|empty|format|not_configured)/.test(code) ? 400 : 502
    return c.json({ success: false, error: code, message }, status)
  }
})

// [拆分] POST /api/projects/:id/ai/story/assets/plan 已迁至 apps/server/src/routes/storyAssets.routes.js
// [拆分] POST /api/projects/:id/ai/story/assets/plan/persist 已迁至 apps/server/src/routes/storyAssets.routes.js
// [拆分] POST /api/projects/:id/ai/story/assets/plan/remove-asset 已迁至 apps/server/src/routes/storyAssets.routes.js
// [拆分] POST /api/projects/:id/ai/story/assets/plan/repair-links 已迁至 apps/server/src/routes/storyAssets.routes.js

// [拆分] POST /api/projects/:id/ai/story/lock/test 已迁至 apps/server/src/routes/storyAssets.routes.js
app.post('/api/projects/:id/ai/story/scenes/:sceneId/render', storyInputGate('story.scene.render', (c, body) => ({ projectId: c.req.param('id'), sceneId: c.req.param('sceneId'), ...body })), async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const sceneId = c.req.param('sceneId')
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

  // 背景-only 模式（背景+立绘分层合成）：mode='background' 或 backgroundOnly=true 时，
  // 场景只出背景（人物/事物由立绘 placements 合成），不再要求角色锁定引用
  const backgroundOnly = String(body?.mode || '').trim() === 'background' || body?.backgroundOnly === true
  // 2026-09-28 风格预设接入：背景排除词等从 settings 预设读取（缺省内置兜底）
  const sceneStylePreset = resolveStoryStylePreset(await getEffectiveStudioConfig(ctx.ROOT).catch(() => null))
  const renderSpec = buildStorySceneRenderSpec({ plan, sceneId, mode: backgroundOnly ? 'background' : '', stylePreset: sceneStylePreset })
  if (!renderSpec) return c.json({ success: false, error: 'scene_not_found', message: `未找到场景：${sceneId}` }, 404)

  // 任务进度：render-all 传入 taskId 时共享批量任务，否则为本场景建独立任务
  const sharedTaskId = String(body?.taskId || '').trim()
  const sharedTask = sharedTaskId ? getAiTask(sharedTaskId) : null
  const sceneTaskId = sharedTask
    ? sharedTask.taskId
    : createAiTask(id, 'story.scene.render', { total: 1, message: `渲染场景：${String(renderSpec.sceneName || sceneId).trim()}`, sceneId: String(renderSpec.sceneId || sceneId).trim() }).taskId
  const ownSceneTask = !sharedTask
  updateAiTask(sceneTaskId, { stage: 'loading_refs', message: `加载参考图（${String(renderSpec.sceneName || sceneId).trim()}）…` })

  const traceId = createTraceId()

  // S4-02 reference required 门禁：场景含「必须参考图」资产但引用未锁定时显式 BLOCKED。
  // 禁止降级为无参考生成；阻断原因经 logStage 与任务进度留痕。
  if (Array.isArray(renderSpec.missingRequiredAssets) && renderSpec.missingRequiredAssets.length) {
    const missing = renderSpec.missingRequiredAssets
    const names = missing.map((asset) => `${asset.name || asset.id}(${asset.id})`).join('、')
    const message = `场景「${String(renderSpec.sceneName || sceneId).trim()}」存在必须参考图但未锁定的资产：${names}。请先完成角色/资产锁定，已阻断渲染。`
    logStage({ stage: 'story.scene.render', event: 'blocked', traceId, project: id, item: `${sceneId} / missing:${missing.map((a) => a.id).join(',')}` })
    // 共享批量任务（render-all/batch）只更新消息，不把整个批次标记 done；独立场景任务才收敛 blocked
    if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'blocked', done: true, error: 'scene_reference_missing', message })
    else updateAiTask(sceneTaskId, { message })
    return c.json({
      success: false,
      error: 'scene_reference_missing',
      message,
      sceneId: String(renderSpec.sceneId || sceneId).trim(),
      missingRequiredAssets: missing,
      taskId: sceneTaskId
    }, 409)
  }

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
  const style = ctx.normalizeStyleEnum(body?.style || draft.style || 'picture_book')
  const width = ctx.clampInt(body?.width, 256, 2048, ctx.clampInt(draft.width, 256, 2048, 768))
  const height = ctx.clampInt(body?.height, 256, 2048, ctx.clampInt(draft.height, 256, 2048, 1024))
  const requestedModel = String(body?.model || '').trim()
  const requestedLoras = Array.isArray(body?.loras) ? body.loras.map((x) => String(x || '').trim()).filter(Boolean) : []

  // S4-02 渲染输入绑定：已锁定的参考图必须逐一通过文件真实性校验（复用 S4-01 门禁原语），
  // 校验失败显式 BLOCKED，禁止静默丢弃后降级为无参考生成；通过者记录为渲染输入证据。
  const referenceImages = []
  const referencesUsed = []
  for (const ref of Array.isArray(renderSpec.referenceAssets) ? renderSpec.referenceAssets : []) {
    const assetAbs = ctx.resolveAssetPathFromUri(id, ref.assetUri || '')
    const relPath = assetAbs ? path.relative(dir, assetAbs) : String(ref.assetUri || '')
    const fileGate = await verifyStoryAssetReferenceFile({ dir, assetPath: relPath })
    if (!assetAbs || !fileGate.ok) {
      const code = !assetAbs ? 'reference_path_outside_project' : fileGate.code
      const baseMessage = !assetAbs ? `参考图路径无法解析或越出项目目录：${String(ref.assetUri || '')}` : fileGate.message
      const message = `场景「${String(renderSpec.sceneName || sceneId).trim()}」的锁定参考图不可用（资产 ${String(ref.name || ref.id || '').trim()}）：${baseMessage}`
      logStage({ stage: 'story.scene.render', event: 'blocked', traceId, project: id, item: `${sceneId} / asset:${String(ref.id || '').trim()} / ${code}` })
      if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'blocked', done: true, error: code, message })
      else updateAiTask(sceneTaskId, { message })
      return c.json({
        success: false,
        error: code,
        message,
        sceneId: String(renderSpec.sceneId || sceneId).trim(),
        reference: { assetId: String(ref.id || '').trim(), assetName: String(ref.name || '').trim(), assetUri: String(ref.assetUri || '') },
        taskId: sceneTaskId
      }, 409)
    }
    try {
      const bytes = await readFile(fileGate.absPath)
      referenceImages.push({
        role: String(ref.category || 'asset').trim() || 'asset',
        assetId: String(ref.assetId || ref.id || '').trim() || undefined,
        assetName: String(ref.name || ref.id || 'reference').trim(),
        filename: path.basename(fileGate.absPath),
        bytes,
        weight: Number.isFinite(Number(ref.weight)) ? Number(ref.weight) : undefined
      })
      referencesUsed.push({
        assetId: String(ref.id || '').trim(),
        assetName: String(ref.name || ref.id || '').trim(),
        category: String(ref.category || '').trim(),
        assetPath: fileGate.relPath
      })
    } catch (_) {
      const message = `场景「${String(renderSpec.sceneName || sceneId).trim()}」的锁定参考图读取失败（资产 ${String(ref.name || ref.id || '').trim()}）：${fileGate.relPath}`
      logStage({ stage: 'story.scene.render', event: 'blocked', traceId, project: id, item: `${sceneId} / asset:${String(ref.id || '').trim()} / reference_file_missing` })
      if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'blocked', done: true, error: 'reference_file_missing', message })
      else updateAiTask(sceneTaskId, { message })
      return c.json({ success: false, error: 'reference_file_missing', message, taskId: sceneTaskId }, 409)
    }
  }

  const bodyPrompt = String(body?.scenePrompt || body?.prompt || '').trim()
  // 2026-08-30 缺陷修复：剧情描述是中文，图像模型几乎读不懂，渲染前经翻译链转英文（失败保留原文不阻断）；
  // prompt 顺序改为「场景内容 → 资产锚点 → 风格基调」，避免 worldAnchor 支配画面导致全场景同质跑题。
  let sceneContentPrompt = bodyPrompt || ''
  // 背景-only（2026-08-30 最终修正）：不再使用剧情叙事文本——人名剥离后残留的"三个孩子/三人"类叙事
  // 翻译后仍会画出人物/狼（实测三轮）。背景内容只由「地点资产的英文锚点」构成，无锚点时退回通用山谷村庄。
  // 2026-09-27 环境化：锚点来源从 promptLocks（含 prop/character）收窄为 environmentLocks（仅 location）——
  // 道具/角色由分层立绘合成提供，锚点进背景会把主体烘进背景图（并与负面词 animal 禁则自相矛盾）。
  const anchorOnlyBackground = !bodyPrompt && backgroundOnly
  if (anchorOnlyBackground) {
    const anchorParts = (Array.isArray(renderSpec.environmentLocks) ? renderSpec.environmentLocks : [])
      .map((line) => String(line || '').split(': ').slice(1).join(': ').trim())
      .filter(Boolean)
    sceneContentPrompt = anchorParts.length
      ? `empty picture book forest or place background featuring ${anchorParts.join('; ')}, scenery only, no characters, no animals`
      : 'empty rural valley village scene background, scenery only, no characters, no animals'
  } else if (!sceneContentPrompt) {
    sceneContentPrompt = backgroundOnly ? String(renderSpec.backgroundPrompt || '').trim() : String(renderSpec.summary || '').trim()
  }
  if (!anchorOnlyBackground && sceneContentPrompt && /[\u4e00-\u9fff]/.test(sceneContentPrompt)) {
    try {
      const studioCfg = await getEffectiveStudioConfig(ctx.ROOT)
      const tr = await ctx.translateStoryAssetPromptPair({
        studio: studioCfg,
        promptZh: sceneContentPrompt,
        negativePromptZh: '',
        fallbackPromptEn: '',
        fallbackNegativePrompt: '',
        timeoutMs: 60_000
      })
      const en = String(tr && tr.promptEn || '').trim()
      if (en) sceneContentPrompt = en
    } catch (_) { /* 翻译失败保留原文，不阻断渲染 */ }
  }
  // 背景-only：正向约束放 prompt 最前（权重最高位）
  if (!bodyPrompt && backgroundOnly && sceneContentPrompt) {
    sceneContentPrompt = `empty environment background illustration, scenery only without any characters, no people, no animals. Scene content: ${sceneContentPrompt}`
  }
  const prompt = [
    sceneContentPrompt,
    // 2026-09-27 去重：背景-only 时环境锚点已并入 sceneContentPrompt，不再二次拼接（同一锚点只出现一次）；
    // 全量模式（非背景-only）保留全部锚点拼接——人物/道具直接画进场景，锚点与正文不重复；
    // 显式 bodyPrompt 时行为与此前一致（仍拼 promptLocks）。
    ...(anchorOnlyBackground ? [] : (Array.isArray(renderSpec.promptLocks) ? renderSpec.promptLocks : []).slice(0, 20)),
    // 2026-09-08：显式自定义 prompt（body.scenePrompt/body.prompt）时不再拼 worldAnchor——
    // 锚点里的村庄/建筑词会把背景-only 空景拉回出房子（场景4实测夜景+小屋）。
    // 与下部安静区同规则：显式覆盖即全权生效。
    ...(bodyPrompt ? [] : [String(renderSpec.worldAnchor || plan.worldAnchor || '').trim()]),
    // 2026-08-28：H5 文本叠加在场景图上——拼装路径统一要求下部留安静区（显式自定义 prompt 原样尊重不追加）
    // 2026-09-27：措辞避开 "text"——"text overlay readability" 会被模型读成"画一片写字区"，
    // 在画面下部反复画出打开的书本（结局二三连中招，AI 评审与人工目检双重证实）
    ...(bodyPrompt ? [] : ['composition keeps the lower third as a calm empty low-detail area with soft ground or water only, no objects, no text, no letters'])
  ]
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .join(', ')
  if (!prompt) {
    return c.json({ success: false, error: 'missing_scene_prompt', message: '场景提示词为空，无法渲染。' }, 400)
  }
  const negativePrompt = [
    String(renderSpec.negativePrompt || '').trim(),
    String(body?.negativePrompt || '').trim()
  ].filter(Boolean).join(', ')

  // 出图前审核（manual 模式）：挂起并返回 202，批准后自动执行
  const reviewMode = ctx.resolveImageReviewMode(c, body)
  if (reviewMode === 'manual' && !(await ctx.hasApprovedPreGenerate(dir, c))) {
    const targetKey = `scene_render:${String(renderSpec.sceneId || sceneId).trim()}`
    let review = await findPendingReview(dir, { phase: 'pre_generate', targetKey })
    if (!review) {
      review = await createImageReview(dir, {
        phase: 'pre_generate',
        targetKey,
        sceneId: String(renderSpec.sceneId || sceneId).trim(),
        prompt,
        negativePrompt,
        referenceImages: referenceImages.map((ref) => ({ role: ref.role, assetId: ref.assetId, assetName: ref.assetName, filename: ref.filename })),
        params: { kind: 'story.scene.render', sceneName: String(renderSpec.sceneName || '').trim(), width, height, style, mode: String(renderSpec.mode || 'full') },
        execute: { endpoint: `/api/projects/${encodeURIComponent(id)}/ai/story/scenes/${encodeURIComponent(String(renderSpec.sceneId || sceneId).trim())}/render`, payload: body && typeof body === 'object' ? body : {} }
      })
    }
    if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'waiting_review', done: true, message: `出图前审核待批准：${String(renderSpec.sceneName || sceneId).trim()}` })
    return c.json({ success: true, pendingReview: review, taskId: sceneTaskId }, 202)
  }

  try {
    updateAiTask(sceneTaskId, { stage: 'generating', message: 'ComfyUI 生成中…' })
    // 生成+写盘+压缩封装为可重试单元：AI 视觉评审未通过时换 seed（seedMode random）重渲 1 次（F5）
    const generateAndPersist = async () => {
      const gen = await generateBackgroundImage({
        prompt,
        negativePrompt,
        width,
        height,
        style,
        steps: body?.steps ?? draft.steps,
        cfgScale: body?.cfgScale ?? draft.cfgScale,
        sampler: body?.sampler ?? draft.sampler,
        scheduler: body?.scheduler ?? draft.scheduler,
        continuity: {
          ipadapterEnabled: referenceImages.length > 0,
          requireCharacterRefs: false,
          controlnetEnabled: false,
          seedMode: 'random'
        },
        referenceImages,
        workflowMode: String(renderSpec.workflow || '').trim() || undefined,
        provider: imgProvider,
        sdwebuiBaseUrl: studio.effective.image.sdwebuiBaseUrl,
        comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
        apiUrl: studio.effective.image.apiUrl,
        model: requestedModel || studio.effective.image.model,
        loras: requestedLoras.length ? requestedLoras : studio.effective.image.loras,
        proxyUrl: studio.effective.network.proxyUrl,
        timeoutMs: body?.timeoutMs
      })

      const buf = gen.bytes
      const ext0 = String(gen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
      const sniff = sniffImageMetaFromBytes(buf)
      const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'
      const safeSceneSlug = String(renderSpec.sceneId || 'scene').replace(/[^a-z0-9_.-]+/gi, '_')
      const relDir = path.join('assets', 'ai', 'story_scenes')
      const outDir = path.join(dir, relDir)
      await mkdir(outDir, { recursive: true })
      const fname = `${safeSceneSlug}_${Date.now()}.${ext}`
      const abs = path.join(outDir, fname)
      await writeFile(abs, buf)
      let outAssetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
      { // 2026-09-09 出图即压：场景背景 JPEG q90
        const opt = await optimizeGeneratedImage(abs, IMAGE_KIND.SCENE_BG).catch(() => null)
        if (opt && opt.outPath && opt.outPath !== abs) outAssetPath = String(ctx.assetPathFromAbsolute(id, opt.outPath) || outAssetPath)
      }
      return { gen, assetPath: outAssetPath }
    }

    const bindSceneId = String(renderSpec.sceneId || sceneId).trim()
    let produced = await generateAndPersist()
    // 2026-09-27 F5 场景绑定前 AI 视觉评审（fail-closed）：
    // x-image-review-mode:off 只旁路人工门禁，AI 评审照常执行；
    // 评审未通过换 seed 重渲 1 次，仍失败显式 blocked（不绑定失败图）；
    // 视觉通道不可用挂 pending 待人工，禁止盲批 approved。
    updateAiTask(sceneTaskId, { stage: 'ai_review', message: 'AI 视觉评审（纯环境/环境匹配/绘本画风）…' })
    let aiReview = await ctx.reviewSceneBackgroundForBind({ id, dir, studio, renderSpec, sceneId: bindSceneId, assetPath: produced.assetPath })
    if (reviewMode !== 'manual' && aiReview.status === 'completed' && aiReview.passed === false) {
      logStage({ stage: 'story.scene.render', event: 'ai_review_failed', traceId, project: id, provider: imgProvider, item: `${sceneId} / score:${aiReview.score} / 换 seed 重渲 1 次` })
      try { // 首图评审未通过 rejected 留痕（targetKey 含 assetPath，逐图唯一）
        const first = await createImageReview(dir, {
          phase: 'scene_bind',
          targetKey: `scene_bind:${bindSceneId}:${produced.assetPath}`,
          sceneId: bindSceneId,
          prompt,
          negativePrompt,
          resultImagePath: produced.assetPath,
          aiReview,
          params: { sceneName: String(renderSpec.sceneName || '').trim(), mode: String(renderSpec.mode || 'full'), aiReviewAttempt: 1 }
        })
        await decideImageReview(dir, first.reviewId, { approved: false, decidedBy: 'ai', rejectReason: `AI 视觉评审未通过（首图，已换 seed 重渲）：${aiReview.summary}` })
      } catch (_) { /* 留痕失败不阻断重渲 */ }
      updateAiTask(sceneTaskId, { stage: 'generating', message: 'AI 视觉评审未通过，换 seed 重渲 1 次…' })
      produced = await generateAndPersist()
      updateAiTask(sceneTaskId, { stage: 'ai_review', message: '重渲图 AI 视觉评审…' })
      aiReview = await ctx.reviewSceneBackgroundForBind({ id, dir, studio, renderSpec, sceneId: bindSceneId, assetPath: produced.assetPath })
    }
    const { gen, assetPath } = produced

    // manual 模式：生成图先挂 scene_bind 审核（附 AI 视觉评审结论），人工 approve 后才绑定到故事节点
    if (reviewMode === 'manual') {
      const review = await createImageReview(dir, {
        phase: 'scene_bind',
        targetKey: `scene_bind:${String(renderSpec.sceneId || sceneId).trim()}:${assetPath}`,
        sceneId: String(renderSpec.sceneId || sceneId).trim(),
        prompt,
        negativePrompt,
        resultImagePath: assetPath,
        aiReview,
        params: {
          sceneName: String(renderSpec.sceneName || '').trim(),
          provider: String(gen?.meta?.provider || imgProvider || ''),
          remoteUrl: String(gen?.meta?.url || '').trim() || undefined,
          references: referencesUsed,
          mode: String(renderSpec.mode || 'full')
        }
      })
      if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'waiting_review', done: true, current: 1, message: `场景图待审核绑定：${String(renderSpec.sceneName || sceneId).trim()}` })
      logStage({ stage: 'story.scene.render', event: 'ok', traceId, project: id, provider: imgProvider, item: `${sceneId} / pending scene_bind / refs:${referencesUsed.map((r) => r.assetId).join(',') || '-'} / ${assetPath}` })
      return c.json({
        success: true,
        pendingReview: review,
        renderSpec,
        assetPath,
        referencesUsed,
        taskId: sceneTaskId,
        url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`,
        provider: String(gen?.meta?.provider || imgProvider || ''),
        prompt,
        negativePrompt,
        aiReview
      })
    }

    // F5 fail-closed：视觉通道不可用（模型未加载/租约超时/配置关闭）→ 挂 pending 待人工审核，禁止盲批
    if (aiReview.status !== 'completed') {
      const review = await createImageReview(dir, {
        phase: 'scene_bind',
        targetKey: `scene_bind:${bindSceneId}:${assetPath}`,
        sceneId: bindSceneId,
        prompt,
        negativePrompt,
        resultImagePath: assetPath,
        aiReview,
        params: {
          sceneName: String(renderSpec.sceneName || '').trim(),
          provider: String(gen?.meta?.provider || imgProvider || ''),
          remoteUrl: String(gen?.meta?.url || '').trim() || undefined,
          references: referencesUsed,
          mode: String(renderSpec.mode || 'full'),
          aiReviewUnavailable: true
        }
      })
      if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'waiting_review', done: true, current: 1, message: `AI 视觉评审不可用（${aiReview.reason}），场景图待人工审核绑定：${String(renderSpec.sceneName || sceneId).trim()}` })
      logStage({ stage: 'story.scene.render', event: 'ok', traceId, project: id, provider: imgProvider, item: `${sceneId} / pending scene_bind (ai_review unavailable: ${aiReview.reason}) / ${assetPath}` })
      return c.json({
        success: true,
        pendingReview: review,
        renderSpec,
        assetPath,
        referencesUsed,
        taskId: sceneTaskId,
        url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`,
        provider: String(gen?.meta?.provider || imgProvider || ''),
        prompt,
        negativePrompt,
        aiReview
      }, 202)
    }

    // F5：AI 评审未通过（含换 seed 重渲 1 次后）→ 标记 rejected 并显式 blocked，不绑定失败图
    if (aiReview.passed === false) {
      try {
        const rejectedRecord = await createImageReview(dir, {
          phase: 'scene_bind',
          targetKey: `scene_bind:${bindSceneId}:${assetPath}`,
          sceneId: bindSceneId,
          prompt,
          negativePrompt,
          resultImagePath: assetPath,
          aiReview,
          params: { sceneName: String(renderSpec.sceneName || '').trim(), mode: String(renderSpec.mode || 'full'), aiReviewAttempt: 2 }
        })
        await decideImageReview(dir, rejectedRecord.reviewId, { approved: false, decidedBy: 'ai', rejectReason: `AI 视觉评审未通过：${aiReview.summary}` })
      } catch (_) { /* 留痕失败不阻断阻断结论 */ }
      const message = `场景「${String(renderSpec.sceneName || sceneId).trim()}」AI 视觉评审未通过（含换 seed 重渲 1 次）：${aiReview.summary}。已阻断绑定，未绑定失败图。`
      logStage({ stage: 'story.scene.render', event: 'blocked', traceId, project: id, provider: imgProvider, item: `${sceneId} / scene_ai_review_failed / score:${aiReview.score}` })
      if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'blocked', done: true, error: 'scene_ai_review_failed', message })
      else updateAiTask(sceneTaskId, { message })
      return c.json({ success: false, error: 'scene_ai_review_failed', message, sceneId: bindSceneId, aiReview, taskId: sceneTaskId }, 409)
    }

    updateAiTask(sceneTaskId, { stage: 'writing', message: '写回项目与故事文档…' })
    const projectAsset = await ctx.persistSceneBackgroundBinding({
      dir,
      rawProject: bundle.rawProject,
      story: bundle.story,
      sceneId: String(renderSpec.sceneId || sceneId).trim(),
      sceneName: String(renderSpec.sceneName || '').trim(),
      assetPath,
      prompt,
      provider: String(gen?.meta?.provider || imgProvider || ''),
      remoteUrl: String(gen?.meta?.url || '').trim() || undefined,
      references: referencesUsed
    })
    // 结论留痕：非 manual 模式（control 旁路/全自动）绑定即补写 scene_bind approved 记录（附 AI 视觉评审结论），
    // 否则出图总账的 bound 状态永远缺这批场景。
    try {
      const bindTargetKey = `scene_bind:${bindSceneId}:${assetPath}`
      const bindDecidedBy = reviewMode === 'off' ? 'control' : 'system'
      const pendingBind = await findPendingReview(dir, { phase: 'scene_bind', targetKey: bindTargetKey })
      if (pendingBind) {
        await attachImageReviewResult(dir, pendingBind.reviewId, { aiReview })
        await decideImageReview(dir, pendingBind.reviewId, { approved: true, decidedBy: bindDecidedBy })
      } else {
        const bindRecord = await createImageReview(dir, {
          phase: 'scene_bind',
          targetKey: bindTargetKey,
          sceneId: bindSceneId,
          prompt,
          negativePrompt,
          resultImagePath: assetPath,
          aiReview,
          params: { sceneName: String(renderSpec.sceneName || '').trim(), mode: String(renderSpec.mode || 'full') }
        })
        await decideImageReview(dir, bindRecord.reviewId, { approved: true, decidedBy: bindDecidedBy })
      }
    } catch (_) { /* 留痕失败不阻断绑定结果 */ }

    logStage({ stage: 'story.scene.render', event: 'ok', traceId, project: id, provider: imgProvider, item: `${sceneId} / refs:${referencesUsed.map((r) => r.assetId).join(',') || '-'} / ${assetPath}` })
    if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'done', done: true, current: 1, message: `场景已出图：${String(renderSpec.sceneName || sceneId).trim()}` })
    return c.json({
      success: true,
      projectAsset,
      renderSpec,
      assetPath,
      referencesUsed,
      taskId: sceneTaskId,
      url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`,
      provider: String(gen?.meta?.provider || imgProvider || ''),
      remoteUrl: String(gen?.meta?.url || '').trim() || undefined,
      prompt,
      negativePrompt,
      aiReview
    })
  } catch (e) {
    const cancelled = e?.code === 'AI_TASK_CANCELLED' || getAiTask(sceneTaskId)?.stage === 'cancelled'
    const msg = cancelled ? '任务已停止，未绑定新的场景图' : e && e.message ? String(e.message) : String(e)
    const mapped = cancelled ? { code: 'task_cancelled_by_user', httpStatus: 409 } : classifyAiError(e)
    logStage({ stage: 'story.scene.render', event: 'fail', traceId, project: id, provider: imgProvider, item: `${sceneId} / ${msg}` })
    if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'error', done: true, error: msg, message: msg })
    return c.json({ success: false, error: mapped.code, message: msg, taskId: sceneTaskId }, mapped.httpStatus)
  }
})

// 批量渲染：异步串行渲染缺失场景，立即返回 taskId，进度经 /ai/tasks 轮询可见
app.post('/api/projects/:id/ai/story/scenes/render-all', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const bundle = await ctx.readProjectBundle(id)
  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)

  const storyNodes = Array.isArray(bundle.story?.nodes) ? bundle.story.nodes : []
  const onlyMissing = body?.onlyMissing !== false
  // 缺口以出图总账为准：status=pending（无背景或文件丢失）才算缺口；rendered 未过审不重渲
  const coverageBefore = await getStoryImageCoverage(dir)
  const gapSceneIds = new Set(coverageBefore.scenes.items.filter((s) => s.status === 'pending').map((s) => s.id))
  const targets = storyNodes
    .filter((n) => !onlyMissing || gapSceneIds.has(String(n && n.id || '').trim()))
    .map((n) => String(n && n.id || '').trim())
    .filter(Boolean)
  if (!targets.length) {
    return c.json({ success: true, taskId: null, total: 0, coverage: coverageBefore, message: '所有场景均已有图，无需渲染' })
  }

  const active = listAiTasks(id, { includeDone: false }).find((t) => t.kind === 'story.scenes.render_all')
  if (active) {
    return c.json({ success: false, error: 'render_all_running', message: '批量渲染正在进行中', taskId: active.taskId }, 409)
  }

  // 出图前审核（manual 模式）：整个批次挂一次审核，批准后自动执行；场景绑定仍逐张审核
  const reviewMode = ctx.resolveImageReviewMode(c, body)
  if (reviewMode === 'manual' && !(await ctx.hasApprovedPreGenerate(dir, c))) {
    const targetKey = 'render_all'
    let review = await findPendingReview(dir, { phase: 'pre_generate', targetKey })
    if (!review) {
      review = await createImageReview(dir, {
        phase: 'pre_generate',
        targetKey,
        prompt: String(plan.worldAnchor || '').trim(),
        params: {
          kind: 'story.scenes.render_all',
          sceneCount: targets.length,
          scenes: targets.slice(0, 20)
        },
        execute: { endpoint: `/api/projects/${encodeURIComponent(id)}/ai/story/scenes/render-all`, payload: body && typeof body === 'object' ? body : {} }
      })
    }
    return c.json({ success: true, pendingReview: review, message: `批量渲染 ${targets.length} 个场景待出图前审核` }, 202)
  }

  const task = createAiTask(id, 'story.scenes.render_all', { total: targets.length, message: `批量渲染 ${targets.length} 个场景` })
  const port = Number(process.env.PORT || 1999)
  const approvedToken = String(c.req.header('x-pre-generate-approved') || '').trim()
  // 2026-10-06 根修：批次内部逐场景渲染必须透传调用方的审核模式（control/自动化旁路 off），
  // 否则每场景按 manual 挂起 pre_generate 审核而批次报"完成 N/N"假完成（假日出游 6 场景零出图事故）
  const reviewModeHeader = String(c.req.header('x-image-review-mode') || '').trim()
  ;(async () => {
    const results = []
    let okCount = 0
    let pendingCount = 0
    for (let i = 0; i < targets.length; i += 1) {
      const sceneId = targets[i]
      updateAiTask(task.taskId, { stage: 'rendering', current: i + 1, message: `渲染场景 ${i + 1}/${targets.length}：${sceneId}` })
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(id)}/ai/story/scenes/${encodeURIComponent(sceneId)}/render`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(approvedToken ? { 'x-pre-generate-approved': approvedToken } : {}),
            ...(reviewModeHeader ? { 'x-image-review-mode': reviewModeHeader } : {})
          },
          body: JSON.stringify({
            width: body?.width,
            height: body?.height,
            timeoutMs: body?.timeoutMs,
            backgroundOnly: body?.backgroundOnly === true,
            reviewMode: body?.reviewMode,
            taskId: task.taskId
          })
        })
        const json = await resp.json().catch(() => ({}))
        if (resp.ok && json.success && !json.pendingReview) {
          okCount += 1
          results.push({ sceneId, ok: true, assetPath: json.assetPath })
        } else if (json.pendingReview) {
          // 审核挂起不是成功：单独计数并明示，批次不再报假完成
          pendingCount += 1
          results.push({ sceneId, ok: false, pendingReview: true, error: 'pending_review' })
        } else {
          results.push({ sceneId, ok: false, error: String(json.message || json.error || `http_${resp.status}`) })
        }
      } catch (e) {
        results.push({ sceneId, ok: false, error: e && e.message ? String(e.message) : String(e) })
      }
    }
    // 批次结束后刷新出图总账，随任务结果返回（UI 可直接展示完成度）
    let coverageAfter = null
    try { coverageAfter = await getStoryImageCoverage(dir) } catch (_) { /* 总账失败不影响渲染结果 */ }
    updateAiTask(task.taskId, {
      stage: okCount === targets.length ? 'done' : (pendingCount > 0 ? 'pending_review' : 'partial'),
      done: pendingCount > 0 ? false : true,
      current: targets.length,
      message: `批量渲染完成 ${okCount}/${targets.length}${pendingCount ? `（${pendingCount} 个待审核，批准后自动继续）` : ''}`,
      result: { okCount, pendingCount, results, coverage: coverageAfter }
    })
  })().catch((e) => {
    updateAiTask(task.taskId, { stage: 'error', done: true, error: e && e.message ? String(e.message) : String(e) })
  })

  return c.json({ success: true, taskId: task.taskId, total: targets.length }, 202)
})

app.get('/api/projects/:id/ai/story/scenes/:sceneId/images', async (c) => {
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const sceneId = String(c.req.param('sceneId') || '').trim()
  const bundle = await ctx.readProjectBundle(id)
  const node = (Array.isArray(bundle.story?.nodes) ? bundle.story.nodes : []).find((n) => String(n && n.id || '').trim() === sceneId)
  const boundAssetId = String(node?.visuals?.backgroundAssetId || '').trim()
  const boundAsset = boundAssetId && Array.isArray(bundle.rawProject?.assets)
    ? bundle.rawProject.assets.find((a) => String(a && a.id || '').trim() === boundAssetId)
    : null
  const boundUri = String(boundAsset?.uri || '').trim().replace(/^\/+/, '')

  const scenesDir = path.join(dir, 'assets', 'ai', 'story_scenes')
  const files = await readdir(scenesDir).catch(() => [])
  const prefix = `${sceneId.replace(/[^a-z0-9_.-]+/gi, '_')}_`
  const items = files
    .filter((f) => f.startsWith(prefix) && /\.(png|jpe?g|webp)$/i.test(f) && !/_vl\d+\.(png|jpe?g|webp)$/i.test(f))
    .map((f) => {
      const m = f.slice(prefix.length).match(/^(\d+)\./)
      const ts = m ? Number(m[1]) : 0
      const assetPath = `assets/ai/story_scenes/${f}`
      return {
        assetPath,
        url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`,
        createdAt: ts ? new Date(ts).toISOString() : '',
        isBound: boundUri === assetPath
      }
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return c.json({ success: true, sceneId, items, boundUri })
})

// 换绑：把该场景的某个历史版本设为背景（人工操作，落 scene_bind approved 记录，decidedBy=user）
app.post('/api/projects/:id/ai/story/scenes/:sceneId/bind', async (c) => {
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const sceneId = String(c.req.param('sceneId') || '').trim()
  const body = await c.req.json().catch(() => ({}))
  const assetPath = String(body?.assetPath || '').trim().replace(/^\/+/, '')
  if (!assetPath) return c.json({ success: false, error: 'missing_asset_path', message: 'assetPath 不能为空' }, 400)
  const fileGate = await verifyStoryAssetReferenceFile({ dir, assetPath })
  if (!fileGate.ok) return c.json({ success: false, error: fileGate.code, message: fileGate.message }, 400)

  const bundle = await ctx.readProjectBundle(id)
  const node = (Array.isArray(bundle.story?.nodes) ? bundle.story.nodes : []).find((n) => String(n && n.id || '').trim() === sceneId)
  if (!node) return c.json({ success: false, error: 'scene_not_found', message: `未找到场景：${sceneId}` }, 404)
  const sceneName = String(node.name || sceneId).trim()
  const projectAsset = await ctx.persistSceneBackgroundBinding({
    dir,
    rawProject: bundle.rawProject,
    story: bundle.story,
    sceneId,
    sceneName,
    assetPath,
    prompt: '',
    provider: '',
    references: []
  })
  try {
    const bindRecord = await createImageReview(dir, {
      phase: 'scene_bind',
      targetKey: `scene_bind:${sceneId}:${assetPath}`,
      sceneId,
      resultImagePath: assetPath,
      params: { sceneName, source: 'manual_rebind' }
    })
    await decideImageReview(dir, bindRecord.reviewId, { approved: true, decidedBy: 'user' })
  } catch (_) { /* 留痕失败不阻断换绑 */ }
  return c.json({ success: true, projectAsset, sceneId, assetPath })
})

// 删除某个历史版本（当前绑定中的图禁止删除）
app.post('/api/projects/:id/ai/story/scenes/:sceneId/images/delete', async (c) => {
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const sceneId = String(c.req.param('sceneId') || '').trim()
  const body = await c.req.json().catch(() => ({}))
  const assetPath = String(body?.assetPath || '').trim().replace(/^\/+/, '')
  if (!assetPath) return c.json({ success: false, error: 'missing_asset_path', message: 'assetPath 不能为空' }, 400)
  const fileGate = await verifyStoryAssetReferenceFile({ dir, assetPath })
  if (!fileGate.ok) return c.json({ success: false, error: fileGate.code, message: fileGate.message }, 400)

  const bundle = await ctx.readProjectBundle(id)
  const node = (Array.isArray(bundle.story?.nodes) ? bundle.story.nodes : []).find((n) => String(n && n.id || '').trim() === sceneId)
  const boundAssetId = String(node?.visuals?.backgroundAssetId || '').trim()
  const boundAsset = boundAssetId && Array.isArray(bundle.rawProject?.assets)
    ? bundle.rawProject.assets.find((a) => String(a && a.id || '').trim() === boundAssetId)
    : null
  if (String(boundAsset?.uri || '').trim().replace(/^\/+/, '') === assetPath) {
    return c.json({ success: false, error: 'bound_image', message: '该图是当前绑定背景，请先换绑其他版本再删除。' }, 409)
  }
  await rm(path.join(dir, assetPath))
  return c.json({ success: true, deleted: assetPath })
})

// 合成导出上传（2026-11-10 用户裁决：支持"整体一张图"）：合成层画布把 底图+立绘分层结果渲成单图，
// 经此端点存为该幕图库版本（scene_bg 压缩口径 JPEG q90，与场景背景同层）。绑定仍走既有 /bind 链
//（scene_bind AI 评审 + 人工确认，门禁语义不变——上传只是产出一个新版本，不自动绑定）。
app.post('/api/projects/:id/ai/story/scenes/:sceneId/images/upload', async (c) => {
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const sceneId = String(c.req.param('sceneId') || '').trim()
  if (!sceneId) return c.json({ success: false, error: 'missing_scene', message: 'sceneId 不能为空' }, 400)
  const body = await c.req.json().catch(() => ({}))
  const raw = String(body?.dataBase64 || '').trim().replace(/^data:image\/[a-z+.-]+;base64,/i, '')
  if (!raw) return c.json({ success: false, error: 'missing_data', message: '缺少图片数据（dataBase64）' }, 400)
  const bytes = Buffer.from(raw, 'base64')
  if (!bytes.length) return c.json({ success: false, error: 'bad_data', message: '图片数据解码失败' }, 400)
  if (bytes.length > 12 * 1024 * 1024) return c.json({ success: false, error: 'too_large', message: '图片超过 12MB，请降低分辨率再导出' }, 413)
  const safeScene = sceneId.replace(/[^a-z0-9_.-]+/gi, '_')
  const relPath = `assets/ai/story_scenes/${safeScene}_${Date.now()}.png`
  const absPath = path.resolve(dir, relPath)
  if (!absPath.startsWith(path.resolve(dir) + path.sep)) return c.json({ success: false, error: 'path_invalid', message: '路径越出项目目录' }, 400)
  await mkdir(path.dirname(absPath), { recursive: true })
  await writeFile(absPath, bytes)
  // 出图即压（2026-09-09 强制规则同口径）：合成导出属场景背景层，JPEG q90
  const opt = await optimizeGeneratedImage(absPath, IMAGE_KIND.SCENE_BG).catch(() => null)
  const outAbs = String(opt && opt.outPath || absPath)
  const outRel = outAbs.startsWith(path.resolve(dir) + path.sep) ? outAbs.slice(path.resolve(dir).length + 1).split(path.sep).join('/') : relPath
  logStage({ stage: 'story.scene.composite_upload', event: 'ok', traceId: createTraceId(), project: id, item: `${sceneId} / ${outRel}` })
  return c.json({ success: true, sceneId, assetPath: outRel, compressed: outRel !== relPath })
})

// 提交批量场景队列：sceneIds 缺省 = 计划全部场景（按 sceneIndex 排序），执行顺序 = 提交顺序，串行执行
app.post('/api/projects/:id/ai/story/scenes/batch', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)

  const planScenes = Array.isArray(plan.scenes) ? plan.scenes : []
  const byId = new Map(planScenes.map((s) => [String(s && s.sceneId || '').trim(), s]))
  let sceneIds
  if (Array.isArray(body?.sceneIds) && body.sceneIds.length) {
    sceneIds = [...new Set(body.sceneIds.map((x) => String(x || '').trim()).filter(Boolean))]
    const unknown = sceneIds.filter((sid) => !byId.has(sid))
    if (unknown.length) return c.json({ success: false, error: 'scene_not_found', message: `计划中不存在场景：${unknown.join('、')}` }, 404)
  } else {
    sceneIds = planScenes
      .slice()
      .sort((a, b) => (Number(a && a.sceneIndex) || 0) - (Number(b && b.sceneIndex) || 0))
      .map((s) => String(s && s.sceneId || '').trim())
      .filter(Boolean)
  }
  if (!sceneIds.length) return c.json({ success: false, error: 'empty_batch', message: '批次为空：没有可渲染的场景。' }, 400)

  // 单项目同时刻只允许一个未完成批次（文件 checkpoint + 进程内守卫双重判定）
  const existing = await loadSceneBatch(dir)
  if (activeSceneBatchProjects.has(id) || ctx.hasOpenSceneBatch(existing)) {
    return c.json({ success: false, error: 'scene_batch_running', message: '已有批量队列在执行中，可查询状态或等待完成后再提交。', batchId: existing ? existing.batchId : undefined }, 409)
  }

  // 出图前审核（manual 模式）：整个批次挂一次审核，批准后自动执行；场景绑定仍逐张审核（E02 语义保留）
  const reviewMode = ctx.resolveImageReviewMode(c, body)
  if (reviewMode === 'manual' && !(await ctx.hasApprovedPreGenerate(dir, c))) {
    const targetKey = 'scene_batch'
    let review = await findPendingReview(dir, { phase: 'pre_generate', targetKey })
    if (!review) {
      review = await createImageReview(dir, {
        phase: 'pre_generate',
        targetKey,
        prompt: String(plan.worldAnchor || '').trim(),
        params: { kind: 'story.scenes.batch', sceneCount: sceneIds.length, scenes: sceneIds.slice(0, 20) },
        execute: { endpoint: `/api/projects/${encodeURIComponent(id)}/ai/story/scenes/batch`, payload: body && typeof body === 'object' ? body : {} }
      })
    }
    return c.json({ success: true, pendingReview: review, message: `批量渲染 ${sceneIds.length} 个场景待出图前审核` }, 202)
  }

  // 提交时预判成功保护：已成功绑定/待人工审核的场景直接标 skipped，不进入执行、不重复生成
  const regen = body?.regenerate
  const regenSet = Array.isArray(regen) ? new Set(regen.map((x) => String(x || '').trim())) : null
  const items = []
  for (const sid of sceneIds) {
    const entry = byId.get(sid)
    const sceneName = String(entry && entry.sceneName || '').trim()
    const requested = regen === true || (regenSet ? regenSet.has(sid) : false)
    if (!requested) {
      const guard = await checkSceneSuccess({ dir, sceneId: sid })
      if (guard.success) {
        items.push({ sceneId: sid, sceneName, status: 'skipped', skipReason: 'already_succeeded', assetPath: guard.assetPath, projectAssetId: guard.assetId, history: [{ at: new Date().toISOString(), event: 'skipped', detail: '已成功绑定资产，按成功保护跳过' }] })
        continue
      }
      if (guard.pendingReview) {
        items.push({ sceneId: sid, sceneName, status: 'skipped', skipReason: 'pending_review', history: [{ at: new Date().toISOString(), event: 'skipped', detail: `存在待人工审核（${String(guard.reviewId || '')}），按成功保护跳过` }] })
        continue
      }
    }
    items.push({ sceneId: sid, sceneName })
  }

  const batch = await createSceneBatch({
    dir,
    projectId: id,
    items,
    options: {
      regenerate: regen === true ? true : (regenSet ? [...regenSet] : undefined),
      reviewMode,
      width: body?.width,
      height: body?.height,
      timeoutMs: body?.timeoutMs,
      // 背景-only 模式透传（分层合成方向）：随 checkpoint 持久化，resume/重启恢复后仍生效
      mode: String(body?.mode || '').trim() || undefined,
      backgroundOnly: body?.backgroundOnly === true ? true : undefined
    }
  })

  const task = createAiTask(id, 'story.scenes.batch', { total: batch.items.length, message: `批量渲染 ${batch.items.length} 个场景（队列 ${batch.batchId}）` })
  const approvedToken = String(c.req.header('x-pre-generate-approved') || '').trim()
  const { renderScene, onProgress } = ctx.makeSceneBatchRunner(id, task, {
    reviewMode,
    approvedToken,
    renderPayload: { width: body?.width, height: body?.height, timeoutMs: body?.timeoutMs, mode: body?.mode, backgroundOnly: body?.backgroundOnly }
  })
  ctx.launchSceneBatch(id, task, () => runSceneBatch({ dir, batch, renderScene, onProgress }))

  logStage({ stage: 'story.scenes.batch', event: 'queued', project: id, item: `${batch.batchId} / scenes:${sceneIds.join(',')}` })
  return c.json({
    success: true,
    batchId: batch.batchId,
    taskId: task.taskId,
    total: batch.items.length,
    items: batch.items.map((it) => ({ sceneId: it.sceneId, status: it.status, skipReason: it.skipReason || undefined }))
  }, 202)
})

// 查询批量队列状态（per-scene checkpoint 原样返回）
app.get('/api/projects/:id/ai/story/scenes/batch', async (c) => {
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const batch = await loadSceneBatch(dir)
  return c.json({ success: true, batch })
})

// 恢复批量队列：中断的 running/queued 继续；retryFailed=true 时失败场景按显式恢复意图重置预算重跑
app.post('/api/projects/:id/ai/story/scenes/batch/resume', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const existing = await loadSceneBatch(dir)
  if (!existing) return c.json({ success: false, error: 'scene_batch_not_found', message: '没有可恢复的批量队列。' }, 404)
  if (activeSceneBatchProjects.has(id)) {
    return c.json({ success: false, error: 'scene_batch_running', message: '批量队列正在执行中，无需恢复。', batchId: existing.batchId }, 409)
  }

  const retryFailed = body?.retryFailed === true
  const reviewMode = String(existing.options && existing.options.reviewMode || '').trim() || ctx.resolveImageReviewMode(c, body)
  const task = createAiTask(id, 'story.scenes.batch', { total: existing.items.length, message: `恢复批量渲染（队列 ${existing.batchId}）` })
  const { renderScene, onProgress } = ctx.makeSceneBatchRunner(id, task, {
    reviewMode,
    approvedToken: '',
    renderPayload: { width: existing.options?.width, height: existing.options?.height, timeoutMs: existing.options?.timeoutMs, mode: existing.options?.mode, backgroundOnly: existing.options?.backgroundOnly }
  })
  ctx.launchSceneBatch(id, task, async () => {
    const { resumed, batch } = await resumeSceneBatch({ dir, renderScene, onProgress, retryFailed })
    return resumed ? batch : null
  })

  logStage({ stage: 'story.scenes.batch', event: 'resume', project: id, item: `${existing.batchId} / retryFailed:${retryFailed}` })
  return c.json({ success: true, batchId: existing.batchId, taskId: task.taskId, retryFailed }, 202)
})

app.post('/api/projects/:id/ai/story/scenes/placements', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const traceId = createTraceId()

  const body = await c.req.json().catch(() => ({}))
  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)
  const bundle = await ctx.readProjectBundle(id)
  const story = bundle.story && typeof bundle.story === 'object' ? bundle.story : null
  const storyNodes = Array.isArray(story?.nodes) ? story.nodes : []
  if (!story || !storyNodes.length) return c.json({ success: false, error: 'missing_story', message: '未找到故事文档，无法写入立绘站位。' }, 400)

  // 目标场景：默认计划内全部场景（按 sceneIndex 排序），body.sceneIds 可指定子集
  const planScenes = Array.isArray(plan.scenes) ? plan.scenes : []
  const planSceneIds = new Set(planScenes.map((s) => String(s && s.sceneId || '').trim()).filter(Boolean))
  let targetSceneIds
  if (Array.isArray(body?.sceneIds) && body.sceneIds.length) {
    targetSceneIds = [...new Set(body.sceneIds.map((x) => String(x || '').trim()).filter(Boolean))]
    const unknown = targetSceneIds.filter((sid) => !planSceneIds.has(sid))
    if (unknown.length) return c.json({ success: false, error: 'scene_not_found', message: `计划中不存在场景：${unknown.join('、')}` }, 404)
  } else {
    targetSceneIds = planScenes
      .slice()
      .sort((a, b) => (Number(a && a.sceneIndex) || 0) - (Number(b && b.sceneIndex) || 0))
      .map((s) => String(s && s.sceneId || '').trim())
      .filter(Boolean)
  }

  const planAssets = Array.isArray(plan.assets) ? plan.assets : []
  const characterAssets = planAssets.filter((a) => String(a && a.category || '').trim() === 'character')
  const propAssets = planAssets.filter((a) => String(a && a.category || '').trim() === 'prop')
  // 2026-11-06 背景元素（scenery）：与道具同走分层摆位链（placementDecision 内按类目给默认贴地位姿）
  const sceneryAssets = planAssets.filter((a) => String(a && a.category || '').trim() === 'scenery')
  // sceneId→story.json 节点映射：sceneId 即故事节点 id（编译产物约定，与场景渲染回填同源）
  const nodeById = new Map(storyNodes.map((n) => [String(n && n.id || '').trim(), n]))

  // 2026-10-04 构图规格驱动：plan.scenes[].composition（AI 提取+审核的摆放需求单）存在时，
  // 新建摆位按需求单（x/y/scale/zIndex/flipH/stateKey）执行，不再纯默认值兜底；
  // body.applyComposition=true 时既有自动摆位也按需求单刷新（人工编辑器拖动的摆位不在此接口覆盖范围）。
  const compositionByScene = new Map()
  for (const s of planScenes) {
    const comp = s && s.composition && typeof s.composition === 'object' ? s.composition : null
    const items = Array.isArray(comp && comp.items) ? comp.items : []
    if (!items.length) continue
    compositionByScene.set(String(s && s.sceneId || '').trim(), new Map(items.map((it) => [String(it && it.subjectId || '').trim(), it])))
  }
  const applyComposition = body?.applyComposition === true

  logStage({ stage: 'story.scenes.placements', event: 'start', traceId, project: id, item: `scenes:${targetSceneIds.length}` })

  try {
    const characters = (Array.isArray(bundle.rawProject?.characters) ? bundle.rawProject.characters : []).map((ch) => ({ ...ch }))
    let charactersChanged = false
    const projectAssets = (Array.isArray(bundle.rawProject?.assets) ? bundle.rawProject.assets : []).map((a) => ({ ...a }))
    let projectAssetsChanged = false
    const characterIdPatches = new Map() // planAssetId → projectCharacterId（新建/补链时写回计划）
    const propAssetIdPatches = new Map() // planAssetId → primaryReferenceAssetId（补登记项目资产时写回计划）
    const storyPatches = new Map() // nodeId → placements 数组
    const sceneReports = []
    const skippedCharacters = []
    const skippedProps = []
    let placementsCreated = 0
    let placementsUpdated = 0
    let placementsRemoved = 0
    let charactersCreated = 0
    let charactersUpdated = 0
    let propsPlaced = 0

    for (const sceneId of targetSceneIds) {
      const node = nodeById.get(sceneId)
      if (!node) {
        sceneReports.push({ sceneId, ok: false, reason: 'story_node_not_found' })
        continue
      }
      // W2 摆位决策管线化：逐场景计算体已抽为服务层 services/placementDecision.js（字义未改，求值顺序一致）；
      // 本端点只准备输入、调服务、应用结果（写 storyPatches/计数器/审计不变）
      const result = await computeScenePlacements({
        resolvePropPlacementImageAsset: ctx.resolvePropPlacementImageAsset,
        associatedPropProjectAssetIds: ctx.associatedPropProjectAssetIds,
        findProjectCharacterForStoryAsset: ctx.findProjectCharacterForStoryAsset,
        defaultPlacementX: ctx.defaultPlacementX,
        defaultPlacementScale: ctx.defaultPlacementScale,
        propPlacementProfile: ctx.propPlacementProfile,
        BUCKET_PROP_PATTERN: ctx.BUCKET_PROP_PATTERN,
        propAssetSignalText: ctx.propAssetSignalText,
        propPlacementTransform: ctx.propPlacementTransform
      }, {
        sceneId,
        node,
        dir,
        projectId: id,
        traceId,
        planScenes,
        planAssets,
        characterAssets,
        propAssets,
        sceneryAssets,
        compositionByScene,
        applyComposition,
        characters,
        projectAssets
      })
      if (result.charactersChanged) charactersChanged = true
      if (result.projectAssetsChanged) projectAssetsChanged = true
      for (const [k, v] of result.characterIdPatches) characterIdPatches.set(k, v)
      for (const [k, v] of result.propAssetIdPatches) propAssetIdPatches.set(k, v)
      skippedCharacters.push(...result.skippedCharacters)
      skippedProps.push(...result.skippedProps)
      placementsCreated += result.counts.created
      placementsUpdated += result.counts.updated
      placementsRemoved += result.counts.removed
      charactersCreated += result.counts.charactersCreated
      charactersUpdated += result.counts.charactersUpdated
      propsPlaced += result.counts.propsPlaced
      if (result.nextPlacements) storyPatches.set(sceneId, result.nextPlacements)
      sceneReports.push({
        sceneId,
        ok: true,
        characters: result.placeable,
        props: result.placeableProps.map((x) => ({ assetId: x.assetId, name: x.name, imageAssetId: x.imageAssetId })),
        placementsTotal: (storyPatches.get(sceneId) || (Array.isArray(node.visuals?.placements) ? node.visuals.placements : [])).length
      })
    }

    const nextStory = {
      ...story,
      nodes: storyNodes.map((node) => {
        const patch = storyPatches.get(String(node && node.id || '').trim())
        if (!patch) return node
        const visuals = node.visuals && typeof node.visuals === 'object' ? node.visuals : {}
        return { ...node, visuals: { ...visuals, placements: patch } }
      })
    }
    await ctx.writeJson(path.join(dir, 'story.json'), nextStory)

    if (charactersChanged || projectAssetsChanged) {
      const nextProject = {
        ...bundle.rawProject,
        characters,
        ...(projectAssetsChanged ? { assets: projectAssets } : {}),
        updatedAt: new Date().toISOString()
      }
      await ctx.writeJson(path.join(dir, 'project.json'), nextProject)
    }

    if (characterIdPatches.size || propAssetIdPatches.size) {
      const nextPlan = {
        ...plan,
        generatedAt: new Date().toISOString(),
        assets: planAssets.map((a) => {
          const aid = String(a && a.id || '').trim()
          const patchedChar = characterIdPatches.get(aid)
          const patchedPropRef = propAssetIdPatches.get(aid)
          let next = patchedChar ? { ...a, projectCharacterId: patchedChar } : a
          if (patchedPropRef) next = { ...next, primaryReferenceAssetId: patchedPropRef }
          return next
        })
      }
      nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
      await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
    }

    const summary = {
      scenes: targetSceneIds.length,
      placementsCreated,
      placementsUpdated,
      placementsRemoved,
      charactersCreated,
      charactersUpdated,
      propsPlaced,
      skippedCharacters: skippedCharacters.length,
      skippedProps: skippedProps.length
    }
    logStage({ stage: 'story.scenes.placements', event: 'ok', traceId, project: id, item: `scenes:${targetSceneIds.length} / created:${placementsCreated} / updated:${placementsUpdated} / removed:${placementsRemoved} / skipped:${skippedCharacters.length}` })
    recordCreationEvent(dir, {
      type: 'placements_updated',
      summary: `立绘站位更新：${targetSceneIds.length} 场景，新增 ${placementsCreated} / 更新 ${placementsUpdated}`,
      actor: 'placements_flow',
      data: { scenes: targetSceneIds.length, placementsCreated, placementsUpdated }
    })
    return c.json({ success: true, summary, scenes: sceneReports, skippedCharacters, skippedProps })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    logStage({ stage: 'story.scenes.placements', event: 'fail', traceId, project: id, item: msg })
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

// [拆分] POST /api/projects/:id/ai/story/pose-variants/auto 已迁至 apps/server/src/routes/storySprites.routes.js

// ---------------------------------------------------------------------------
// 场景分层出图编排（asset.scene.layeredProduce，2026-09-08 新增）：
// 单场景「背景-only 重画 + 姿势变体生成/复用 + 道具精灵 + 分层摆位写入」串行编排，
// 供 control 事件链与控制台触发。全程经 /ai/tasks 暴露进度（createAiTask/updateAiTask，禁止黑盒）；
// 生成动作经 app.request 内部转发既有端点（sprite/pose-review/cutout/render/bind，
// 参考 makeSceneBatchRunner 的既有用法），统一带 x-image-review-mode: off（control 已有步骤级审核）；
// 产物登记后补写 lock_confirm approved 审核留痕（decidedBy=control，与 select 链路同源写法）。
// 任一步失败记 errors 并继续后续独立步骤，全部失败才 success:false。
// ---------------------------------------------------------------------------
app.post('/api/projects/:id/ai/story/scenes/:sceneId/layered-produce', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const sceneId = String(c.req.param('sceneId') || '').trim()
  if (!sceneId) return c.json({ success: false, error: 'missing_scene_id', message: 'sceneId 不能为空' }, 400)

  // body 内联字段优先；specPath 规格文件（JSON，同结构，notes 等额外字段忽略）作为缺省补充。
  // specPath 必须解析在项目目录内（防越界，与 verifyStoryAssetReferenceFile 同款路径守卫）。
  const body = await c.req.json().catch(() => ({}))
  let spec = {}
  const specPath = String(body?.specPath || '').trim().replace(/^\/+/, '')
  if (specPath) {
    const rootAbs = path.resolve(dir)
    const specAbs = path.resolve(rootAbs, specPath)
    if (specAbs !== rootAbs && !specAbs.startsWith(rootAbs + path.sep)) {
      return c.json({ success: false, error: 'spec_path_outside_project', message: `specPath 越出项目目录，已拒绝：${specPath}` }, 400)
    }
    if (!(await ctx.existsFile(specAbs))) {
      return c.json({ success: false, error: 'spec_not_found', message: `规格文件不存在：${specPath}` }, 404)
    }
    try {
      const parsed = JSON.parse(await readFile(specAbs, 'utf-8'))
      spec = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (_) {
      return c.json({ success: false, error: 'spec_invalid_json', message: `规格文件不是有效 JSON：${specPath}` }, 400)
    }
  }
  const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
  const background = asObj(body?.background) || asObj(spec?.background)
  const poses = Array.isArray(body?.poses) ? body.poses : (Array.isArray(spec?.poses) ? spec.poses : [])
  const propSprites = Array.isArray(body?.propSprites) ? body.propSprites : (Array.isArray(spec?.propSprites) ? spec.propSprites : [])
  const placements = Array.isArray(body?.placements) ? body.placements : (Array.isArray(spec?.placements) ? spec.placements : [])
  if (!background && !poses.length && !propSprites.length && !placements.length) {
    return c.json({ success: false, error: 'empty_request', message: 'background/poses/propSprites/placements 至少提供一项' }, 400)
  }

  // 场景存在性前置校验（story.json 节点），保证非法 sceneId 得到干净 4xx 而非 500
  const story = await ctx.readJson(path.join(dir, 'story.json')).catch(() => null)
  const storyNodes = Array.isArray(story?.nodes) ? story.nodes : []
  const sceneNode = storyNodes.find((n) => String(n && n.id || '').trim() === sceneId) || null
  if (!sceneNode) return c.json({ success: false, error: 'scene_not_found', message: `未找到场景：${sceneId}` }, 404)
  const sceneName = String(sceneNode.name || sceneId).trim()

  const plan = await ctx.readStoryAssetPlanIfExists(id)
  const planAssets = plan && Array.isArray(plan.assets) ? plan.assets : []
  const findPlanAsset = (assetId) => planAssets.find((a) => String(a && a.id || '').trim() === String(assetId || '').trim()) || null

  // 编排总任务：每步串行推进并 updateAiTask，进度经 /api/projects/:id/ai/tasks 可见
  const total = poses.length + propSprites.length + (background ? 1 : 0) + (placements.length ? 1 : 0)
  const task = createAiTask(id, 'story.scene.layered_produce', { total, message: `分层出图编排：${sceneName}` })
  const traceId = createTraceId()
  logStage({ stage: 'story.scene.layered_produce', event: 'start', traceId, project: id, item: `${sceneId} / poses:${poses.length} / props:${propSprites.length} / bg:${background ? 1 : 0} / placements:${placements.length}` })

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
  const readProjectAssets = async () => {
    const proj = await ctx.readJson(path.join(dir, 'project.json')).catch(() => null)
    return Array.isArray(proj?.assets) ? proj.assets : []
  }
  // 产物登记：project.json assets 追加（每次读最新盘再写回，避免覆盖编排期间的其他写入）
  const appendProjectAsset = async (asset) => {
    const proj = await ctx.readJson(path.join(dir, 'project.json'))
    const next = {
      ...proj,
      assets: [...(Array.isArray(proj?.assets) ? proj.assets : []), asset],
      updatedAt: ctx.nowIso(),
      _rev: Number(proj?._rev || 0) + 1
    }
    await ctx.writeJson(path.join(dir, 'project.json'), next)
  }
  // lock_confirm 审核留痕（approved / decidedBy=control）；留痕失败不阻断登记结果
  const traceLockConfirm = async ({ planAssetId, resultImagePath, prompt }) => {
    try {
      const targetKey = `lock_confirm:${planAssetId}:${resultImagePath}`
      const pending = await findPendingReview(dir, { phase: 'lock_confirm', targetKey })
      if (pending) {
        await decideImageReview(dir, pending.reviewId, { approved: true, decidedBy: 'control' })
      } else {
        const record = await createImageReview(dir, {
          phase: 'lock_confirm',
          targetKey,
          assetId: planAssetId,
          resultImagePath,
          prompt: String(prompt || '')
        })
        await decideImageReview(dir, record.reviewId, { approved: true, decidedBy: 'control' })
      }
    } catch (_) { /* 留痕失败不阻断登记结果 */ }
  }

  const POSE_GLOBAL_PROMPT = 'cartoon fairy tale picture book style, flat 2D illustration, bold clean outlines, cel shading, warm soft color palette'
  const poseResults = []
  const propResults = []
  const errors = []
  let backgroundResult = null
  let placementsWritten = 0
  let cursor = 0

  // 1) 姿势变体：reuseAssetId 复用跳过生成；否则 sprite → pose-review（可选，失败记 reviewUnavailable）→ cutout → 登记 → 留痕
  for (const poseRaw of poses) {
    const pose = asObj(poseRaw) || {}
    const lockName = String(pose.lockName || '').trim()
    const planAssetId = String(pose.planAssetId || '').trim()
    const characterId = String(pose.characterId || '').trim()
    const reuseAssetId = String(pose.reuseAssetId || '').trim()
    const posePrompt = String(pose.posePrompt || '').trim()
    cursor += 1
    const label = lockName || planAssetId || characterId || `pose_${cursor}`
    try {
      if (reuseAssetId) {
        updateAiTask(task.taskId, { stage: 'pose_reuse', current: cursor - 1, message: `复用姿势资产：${label}` })
        if (!(await readProjectAssets()).some((a) => String(a && a.id || '').trim() === reuseAssetId)) {
          const err = new Error(`复用资产不存在于 project.json assets：${reuseAssetId}`)
          err.code = 'reuse_asset_not_found'
          throw err
        }
        poseResults.push({ lockName, planAssetId, projectAssetId: reuseAssetId, reused: true })
        updateAiTask(task.taskId, { current: cursor, message: `姿势完成（复用）：${label}` })
        continue
      }
      const planAsset = findPlanAsset(planAssetId)
      if (!planAsset) {
        const err = new Error(`未找到故事资产：${planAssetId || '(空)'}`)
        err.code = 'asset_not_found'
        throw err
      }
      if (!characterId) {
        const err = new Error('characterId 不能为空')
        err.code = 'missing_character_id'
        throw err
      }
      if (!posePrompt) {
        const err = new Error('posePrompt 不能为空')
        err.code = 'missing_pose_prompt'
        throw err
      }

      updateAiTask(task.taskId, { stage: 'pose_sprite', current: cursor - 1, message: `生成姿势绿幕图：${label}` })
      // 2026-10-08 骨架驱动姿势变体接入：spriteAssetPath 直接供给预生成姿势图（OpenPose 骨架+IPAdapter 链产物），
      // 跳过绿幕 sprite 生成（绿幕 IPAdapter 会把姿势拉回主参考站姿，坐/骑/走类姿势必须走骨架驱动）。
      // 路径守卫：必须解析在项目目录内（与 specPath 同款防越界）。
      let assetPath = ''
      const presetSprite = String(pose.spriteAssetPath || '').trim().replace(/^\/+/, '')
      if (presetSprite) {
        const rootAbs = path.resolve(dir)
        const spriteAbs = path.resolve(rootAbs, presetSprite)
        if (spriteAbs === rootAbs || !spriteAbs.startsWith(rootAbs + path.sep) || !(await ctx.existsFile(spriteAbs))) {
          const err = new Error(`spriteAssetPath 越出项目目录或不存在，已拒绝：${presetSprite}`)
          err.code = 'sprite_path_invalid'
          throw err
        }
        assetPath = presetSprite
      } else {
        const spriteJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/sprite`, {
          characterId,
          // R 波项 2 收口（代跑实测缺口）：分层登记链的身份锚同样吃三视图——planAssetId + 视角语义下发 sprite 端点选择
          planAssetId: planAssetId || undefined,
          poseViewText: String(pose.poseViewText || '').trim() || undefined,
          fingerprintPrompt: String(planAsset.anchorPrompt || '').trim(),
          globalPrompt: POSE_GLOBAL_PROMPT,
          posePrompt,
          negativePrompt: [String(pose.negativePrompt || '').trim(), String(planAsset.negativePrompt || '').trim()].filter(Boolean).join(', '),
          style: 'picture_book',
          // X 波尺寸策略表：姿态变体=立绘档 768×1152（原 720×1280 退役）
          width: renderSizeOf('pose_variant')[0],
          height: renderSizeOf('pose_variant')[1],
          steps: 20,
          cfgScale: 7,
          ipadapter: { enabled: true }
        })
        assetPath = String(spriteJson.assetPath || '').trim()
      }

      let score
      let reason = ''
      let reviewUnavailable = ''
      try {
        // S 波代跑实测根修：plan 资产角色不在 project.characters——传 characterId 走角色档案分支必 reference_not_found；
        // 有 planAssetId 优先走计划资产分支（读 plan 主参考，与三视图/状态变体评审同款）
        const reviewJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/pose-review`, { ...(planAssetId ? { planAssetId } : { characterId }), assetPath })
        if (Number.isFinite(Number(reviewJson.score))) score = Number(reviewJson.score)
        reason = String(reviewJson.reason || '').trim()
      } catch (e) {
        reviewUnavailable = String((e && e.code) || 'review_unavailable')
      }

      updateAiTask(task.taskId, { stage: 'pose_cutout', current: cursor - 1, message: `姿势抠图：${label}` })
      const cutoutJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/cutout`, { assetPath })
      const cutoutPath = String(cutoutJson.assetPath || '').trim()

      const projectAssetId = genId('asset')
      await appendProjectAsset({
        id: projectAssetId,
        kind: 'image',
        name: `AI 姿势 ${String(planAsset.name || planAssetId).trim()}·${lockName}`,
        uri: cutoutPath,
        source: { type: 'ai', prompt: posePrompt, provider: 'comfyui', postprocess: 'rmbg_alpha' }
      })

      // 计划资产 poseVariants 追加（读最新 plan 再写回，避免覆盖编排期间的其他变体写入）
      const curPlan = await ctx.readStoryAssetPlanIfExists(id)
      if (curPlan) {
        const variant = {
          id: genId('pose'),
          name: lockName,
          // 2026-09-30：记录来源场景，placements 按场景选姿势变体（乌鸦喝水口渴/衔石/喝水随情节上场）
          sceneId: String(c.req.param('sceneId') || '').trim(),
          // 2026-10-08：支持一次绑定多场景（同一变体跨后果/结局复用，摆位 sceneIds 命中同样生效）
          ...(Array.isArray(pose.sceneIds) && pose.sceneIds.length
            ? { sceneIds: pose.sceneIds.map((x) => String(x || '').trim()).filter(Boolean) }
            : {}),
          posePrompt,
          promptZh: String(pose.promptZh || '').trim(),
          promptEn: posePrompt,
          greenPath: assetPath,
          cutoutPath,
          projectAssetId,
          projectAssetUri: cutoutPath,
          ...(score !== undefined ? { score } : {}),
          ...(reason ? { reason } : {}),
          createdAt: ctx.nowIso()
        }
        const nextPlan = {
          ...curPlan,
          generatedAt: ctx.nowIso(),
          assets: (Array.isArray(curPlan.assets) ? curPlan.assets : []).map((a) =>
            String(a && a.id || '').trim() === planAssetId
              ? { ...a, poseVariants: [...(Array.isArray(a.poseVariants) ? a.poseVariants : []), variant] }
              : a
          )
        }
        nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
        await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
      }

      await traceLockConfirm({ planAssetId, resultImagePath: cutoutPath, prompt: posePrompt })
      poseResults.push({
        lockName,
        planAssetId,
        projectAssetId,
        reused: false,
        ...(score !== undefined ? { score } : {}),
        ...(reviewUnavailable ? { reviewUnavailable } : {})
      })
      updateAiTask(task.taskId, { current: cursor, message: `姿势完成：${label}` })
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      errors.push({ step: 'pose', lockName, planAssetId, code: String((e && e.code) || ''), message: msg })
      poseResults.push({ lockName, planAssetId, projectAssetId: '', reused: false, error: msg })
      updateAiTask(task.taskId, { current: cursor, message: `姿势失败：${label}（${msg}）` })
      logStage({ stage: 'story.scene.layered_produce', event: 'pose_fail', traceId, project: id, item: `${label} / ${msg}` })
    }
  }

  // 2) 道具精灵：sprite(kind:'prop') → cutout → 登记 project.json（道具无姿势变体概念，不写 plan poseVariants）
  for (const propRaw of propSprites) {
    const prop = asObj(propRaw) || {}
    const planAssetId = String(prop.planAssetId || '').trim()
    const name = String(prop.name || '').trim()
    const prompt = String(prop.prompt || '').trim()
    cursor += 1
    const label = name || planAssetId || `prop_${cursor}`
    try {
      if (!prompt) {
        const err = new Error('prompt 不能为空')
        err.code = 'missing_prompt'
        throw err
      }
      const planAsset = findPlanAsset(planAssetId)
      updateAiTask(task.taskId, { stage: 'prop_sprite', current: cursor - 1, message: `生成道具精灵：${label}` })
      const spriteJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/sprite`, {
        kind: 'prop',
        fingerprintPrompt: String(planAsset?.anchorPrompt || '').trim(),
        globalPrompt: POSE_GLOBAL_PROMPT,
        posePrompt: prompt,
        negativePrompt: [String(prop.negativePrompt || '').trim(), String(planAsset?.negativePrompt || '').trim()].filter(Boolean).join(', '),
        style: 'picture_book',
        // X 波尺寸策略表：道具单件=768×768（原 720×1280 退役）
        width: renderSizeOf('prop_single')[0],
        height: renderSizeOf('prop_single')[1],
        steps: 20,
        cfgScale: 7
      })
      const assetPath = String(spriteJson.assetPath || '').trim()
      updateAiTask(task.taskId, { stage: 'prop_cutout', current: cursor - 1, message: `道具抠图：${label}` })
      const cutoutJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/cutout`, { assetPath })
      const cutoutPath = String(cutoutJson.assetPath || '').trim()

      const projectAssetId = genId('set')
      await appendProjectAsset({
        id: projectAssetId,
        kind: 'image',
        name: `道具立绘 ${name || planAssetId}`,
        uri: cutoutPath,
        source: { type: 'ai', prompt, provider: 'comfyui', postprocess: 'rmbg_alpha' }
      })
      await traceLockConfirm({ planAssetId, resultImagePath: cutoutPath, prompt })
      propResults.push({ planAssetId, name, projectAssetId, cutoutPath })
      updateAiTask(task.taskId, { current: cursor, message: `道具完成：${label}` })
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      errors.push({ step: 'propSprite', planAssetId, name, code: String((e && e.code) || ''), message: msg })
      propResults.push({ planAssetId, name, projectAssetId: '', error: msg })
      updateAiTask(task.taskId, { current: cursor, message: `道具失败：${label}（${msg}）` })
      logStage({ stage: 'story.scene.layered_produce', event: 'prop_fail', traceId, project: id, item: `${label} / ${msg}` })
    }
  }

  // 3) 背景：render(mode:'background') → bind（bind 端点自带 scene_bind 审核留痕，不重复写）
  if (background) {
    cursor += 1
    try {
      const bgPrompt = String(background.prompt || '').trim()
      if (!bgPrompt) {
        const err = new Error('background.prompt 不能为空')
        err.code = 'missing_background_prompt'
        throw err
      }
      updateAiTask(task.taskId, { stage: 'background_render', current: cursor - 1, message: `重画场景背景：${sceneName}` })
      const renderJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/story/scenes/${encodeURIComponent(sceneId)}/render`, {
        mode: 'background',
        prompt: bgPrompt,
        negativePrompt: String(background.negativePrompt || '').trim(),
        ...(Number.isFinite(Number(background.width)) ? { width: Number(background.width) } : {}),
        ...(Number.isFinite(Number(background.height)) ? { height: Number(background.height) } : {})
      })
      const bgUri = String(renderJson?.projectAsset?.uri || renderJson?.assetPath || '').trim()
      if (!bgUri) {
        const err = new Error('背景渲染未返回产物路径')
        err.code = 'background_render_empty'
        throw err
      }
      updateAiTask(task.taskId, { stage: 'background_bind', current: cursor - 1, message: `绑定场景背景：${sceneName}` })
      await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/story/scenes/${encodeURIComponent(sceneId)}/bind`, { assetPath: bgUri })
      backgroundResult = { assetId: String(renderJson?.projectAsset?.id || '').trim(), uri: bgUri }
      updateAiTask(task.taskId, { current: cursor, message: `背景完成：${sceneName}` })
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      errors.push({ step: 'background', code: String((e && e.code) || ''), message: msg })
      updateAiTask(task.taskId, { current: cursor, message: `背景失败：${sceneName}（${msg}）` })
      logStage({ stage: 'story.scene.layered_produce', event: 'background_fail', traceId, project: id, item: `${sceneId} / ${msg}` })
    }
  }

  // 4) 摆位：逐条校验 imageAssetId 存在于 project.json assets，全部通过才整体替换落盘（不部分写入）
  if (placements.length) {
    cursor += 1
    try {
      updateAiTask(task.taskId, { stage: 'placements', current: cursor - 1, message: `写入分层摆位（${placements.length} 条）…` })
      const assetIds = new Set((await readProjectAssets()).map((a) => String(a && a.id || '').trim()))
      const nextPlacements = []
      const missing = []
      placements.forEach((p, index) => {
        const entry = asObj(p)
        const imageAssetId = String(entry?.imageAssetId || '').trim()
        if (!entry || !imageAssetId || !assetIds.has(imageAssetId)) {
          missing.push({ index, id: String(entry?.id || '').trim(), imageAssetId })
          return
        }
        nextPlacements.push(entry)
      })
      if (missing.length) {
        const err = new Error(`摆位引用的图像资产不存在：${missing.map((m) => m.imageAssetId || m.id || `#${m.index}`).join('、')}`)
        err.code = 'placement_asset_missing'
        err.missing = missing
        throw err
      }
      // 读最新 story.json 落盘（与 placements/render 链路同款 writeJson 原子写回）
      const curStory = await ctx.readJson(path.join(dir, 'story.json')).catch(() => null)
      const curNodes = Array.isArray(curStory?.nodes) ? curStory.nodes : []
      if (!curNodes.some((n) => String(n && n.id || '').trim() === sceneId)) {
        const err = new Error(`未找到场景：${sceneId}`)
        err.code = 'scene_not_found'
        throw err
      }
      const nextStory = {
        ...curStory,
        nodes: curNodes.map((node) => {
          if (String(node && node.id || '').trim() !== sceneId) return node
          const visuals = node.visuals && typeof node.visuals === 'object' ? node.visuals : {}
          return { ...node, visuals: { ...visuals, placements: nextPlacements } }
        })
      }
      await ctx.writeJson(path.join(dir, 'story.json'), nextStory)
      placementsWritten = nextPlacements.length
      recordCreationEvent(dir, {
        type: 'placements_updated',
        summary: `分层摆位写入：${sceneName}（${placementsWritten} 条）`,
        actor: 'layered_produce_flow',
        data: { sceneId, placements: placementsWritten }
      })
      updateAiTask(task.taskId, { current: cursor, message: `摆位完成：${placementsWritten} 条` })
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      errors.push({ step: 'placements', code: String((e && e.code) || ''), message: msg, ...(Array.isArray(e && e.missing) ? { missing: e.missing } : {}) })
      updateAiTask(task.taskId, { current: cursor, message: `摆位失败：${msg}` })
      logStage({ stage: 'story.scene.layered_produce', event: 'placements_fail', traceId, project: id, item: `${sceneId} / ${msg}` })
    }
  }

  const poseOk = poseResults.filter((p) => !p.error).length
  const propOk = propResults.filter((p) => !p.error).length
  const succeeded = poseOk + propOk + (backgroundResult ? 1 : 0) + (placementsWritten > 0 ? 1 : 0)
  const success = succeeded > 0
  const finalMessage = success
    ? `分层出图完成：姿势 ${poseOk}/${poses.length}、道具 ${propOk}/${propSprites.length}、背景 ${backgroundResult ? '已绑定' : background ? '失败' : '未请求'}、摆位 ${placementsWritten} 条${errors.length ? `（${errors.length} 项失败）` : ''}`
    : `分层出图全部失败：${(errors[0] && errors[0].message) || 'unknown'}`
  updateAiTask(task.taskId, {
    stage: success ? (errors.length ? 'done_with_errors' : 'done') : 'error',
    done: true,
    current: total,
    error: errors.length ? errors.map((e) => `${e.step}:${e.message}`).join('；') : '',
    message: finalMessage,
    result: { sceneId, poses: poseResults, propSprites: propResults, background: backgroundResult, placements: { written: placementsWritten }, errors }
  })
  logStage({ stage: 'story.scene.layered_produce', event: success ? 'ok' : 'fail', traceId, project: id, item: `${sceneId} / ok:${succeeded} / errors:${errors.length}` })

  return c.json({
    success,
    taskId: task.taskId,
    sceneId,
    poses: poseResults,
    propSprites: propResults,
    ...(backgroundResult ? { background: backgroundResult } : {}),
    placements: { written: placementsWritten },
    errors
  }, success ? 200 : 502)
})

// [W1] 道具状态变体端点已迁至 routes/storyStates.routes.js
}
