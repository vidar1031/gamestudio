// ---------------------------------------------------------------------------
// 状态机族路由（W1 模块化拆分，2026-10-19 自 index.js 机械迁出，字义未改）：
// 剧情姿势提取 / 道具状态提取 / 剧情状态提取合并 / 载体变体 / 道具状态变体 / 状态变体编排。
// 规则（见 docsys《模块化拆分设计》）：本文件只做协议层+族内编排；index.js 本地辅助经 ctx 注入；
// 域算法依赖直接引自 ../ai/*；新增端点不得回 index.js。
// ---------------------------------------------------------------------------
import path from 'node:path'
import { getEffectiveStudioConfig } from '../studio/settings.js'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { genId } from '../ai/scripts.js'
import { classifyAiError, createTraceId, logStage } from '../ai/runtime.js'
import { createAiTask, updateAiTask } from '../ai/taskProgress.js'
import { buildStatesDoc, buildStoryStateExtractionInput, carrierSkillIdForStateKey, extractStoryStates, findStateGaps, mergeStoryStatesIntoPlan } from '../ai/storyStates.js'
import { buildPoseStateExtractionInput, extractStoryPoseStates } from '../ai/storyPoseStates.js'
import { buildPropStateExtractionInput, extractStoryPropStates } from '../ai/storyPropStates.js'
import { getCraftSkill } from '../ai/craftLibrary.js'
import { generateComfyuiPoseVariantSprite } from '../ai/background.js'
import { optimizeGeneratedImage, IMAGE_KIND } from '../ai/imageOptimize.js'
import { summarizeStoryAssetPlan } from '../ai/storyAssets.js'
import { createImageReview, decideImageReview, findPendingReview } from '../review/imageReviewStore.js'

export function registerStoryStatesRoutes(app, ctx) {
// AI：提取剧情姿势状态（2026-09-10，候选制不写盘）——逐场景×出场角色输出 姿势/朝向/动作/神态，
// 供锁定向导姿势变体区构建"剧情姿势需求清单"；模型输出只是候选，持久化由编辑器确认后走 plan 保存链。
app.post('/api/projects/:id/ai/story/pose-states', async (c) => {
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
    const storyBible = ctx.readStoryBibleFromProjectDoc(bundle.project)
    if (!storyBible || typeof storyBible !== 'object') {
      return c.json({ success: false, error: 'missing_story_bible', message: '未找到 Story Bible。请先生成 Story Bible。' }, 400)
    }
    const input = buildPoseStateExtractionInput({ project: bundle.project, story: bundle.story, storyBible })
    if (!input.scenes.length) {
      return c.json({ success: false, error: 'no_character_scenes', message: '没有角色出场的场景可提取。' }, 400)
    }
    const body = await c.req.json().catch(() => ({}))
    const timeoutMs = ctx.clampInt(body?.timeoutMs, 5_000, 600_000, ctx.clampInt(process.env.STUDIO_PROMPT_TIMEOUT_MS, 5_000, 600_000, 90_000))
    const { result, meta } = await extractStoryPoseStates({
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model,
      apiUrl: studio.effective.prompt.apiUrl,
      proxyUrl: studio.effective.network.proxyUrl,
      timeoutMs,
      input
    })
    // 附带角色→计划资产映射（同 id 直接对应），编辑器按资产挂载需求清单
    const plan = await ctx.readStoryAssetPlanIfExists(id).catch(() => null)
    const assetByCharacterId = {}
    for (const asset of (plan && Array.isArray(plan.assets) ? plan.assets : [])) {
      if (String(asset?.category || '') === 'character' && String(asset?.id || '').trim()) {
        assetByCharacterId[String(asset.id).trim()] = { assetId: String(asset.id).trim(), assetName: String(asset.name || asset.id).trim() }
      }
    }
    return c.json({ success: true, poseStates: result, assetByCharacterId, meta })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

// AI：提取道具状态需求（2026-09-16，候选制不写盘）——逐道具识别跨场景视觉状态变化（水位/满空/破碎…）
// 与"终态合并关系"（如石子沉进瓶内），供锁定向导道具状态变体区构建需求清单；持久化由编辑器确认后走 plan 保存链。
app.post('/api/projects/:id/ai/story/prop-states', async (c) => {
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
    const storyBible = ctx.readStoryBibleFromProjectDoc(bundle.project)
    if (!storyBible || typeof storyBible !== 'object') {
      return c.json({ success: false, error: 'missing_story_bible', message: '未找到 Story Bible。请先生成 Story Bible。' }, 400)
    }
    const input = buildPropStateExtractionInput({ project: bundle.project, story: bundle.story, storyBible })
    if (!input.scenes.length) {
      return c.json({ success: false, error: 'no_prop_scenes', message: '没有事物出场的场景可提取。' }, 400)
    }
    const body = await c.req.json().catch(() => ({}))
    const timeoutMs = ctx.clampInt(body?.timeoutMs, 5_000, 600_000, ctx.clampInt(process.env.STUDIO_PROMPT_TIMEOUT_MS, 5_000, 600_000, 90_000))
    const { result, meta } = await extractStoryPropStates({
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model,
      apiUrl: studio.effective.prompt.apiUrl,
      proxyUrl: studio.effective.network.proxyUrl,
      timeoutMs,
      input
    })
    // 附带道具→计划资产映射（bible propId 与计划资产同 id 直接对应），编辑器按资产挂载需求清单
    const plan = await ctx.readStoryAssetPlanIfExists(id).catch(() => null)
    const assetByPropId = {}
    for (const asset of (plan && Array.isArray(plan.assets) ? plan.assets : [])) {
      const aid = String(asset?.id || '').trim()
      if (aid) assetByPropId[aid] = { assetId: aid, assetName: String(asset.name || aid).trim() }
    }
    return c.json({ success: true, propStates: result, assetByPropId, meta })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

// AI：剧情状态机·统一状态表提取（2026-10-16）——每场景×每资产识别剧情视觉状态
// （道具 满空/开合、角色 持物/端盘/鼓掌/姿态表情），候选经确定性补全（未提及=unchanged）后
// 直接写回 plan.assets[].stateRequirements（合并不覆盖未提及场景）+ 落 story-assets/states.json。
// 写 stateRequirements 是安全的：摆位只对已生成变体的状态生效，未生成变体的状态回退主参考。
app.post('/api/projects/:id/ai/story/states/extract', async (c) => {
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

  const task = createAiTask(id, 'story.states.extract', { total: 2, message: '剧情状态表提取中…' })
  try {
    const bundle = await ctx.readProjectBundle(id)
    const plan = await ctx.readStoryAssetPlanIfExists(id)
    if (!plan || !Array.isArray(plan.assets) || !plan.assets.length) {
      return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)
    }
    const scripts = await ctx.readJson(path.join(dir, 'scripts.json')).catch(() => null)
    const input = buildStoryStateExtractionInput({ project: bundle.project, story: bundle.story, scripts, plan })
    if (!input.scenes.length) {
      return c.json({ success: false, error: 'no_state_scenes', message: '没有资产出场的场景可提取。' }, 400)
    }
    const body = await c.req.json().catch(() => ({}))
    // 2026-10-18 实测：剧情状态提取属长 LLM 任务（~150s），默认 90s 会把响应掐成 empty_ai_output；
    // 默认放宽到 900s（显式传参仍可覆盖）。
    const timeoutMs = ctx.clampInt(body?.timeoutMs, 5_000, 900_000, ctx.clampInt(process.env.STUDIO_PROMPT_TIMEOUT_MS, 5_000, 900_000, 900_000))
    const { result, meta } = await extractStoryStates({
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model,
      apiUrl: studio.effective.prompt.apiUrl,
      proxyUrl: studio.effective.network.proxyUrl,
      timeoutMs,
      input
    })

    updateAiTask(task.taskId, { stage: 'writing', current: 1, message: '写回状态需求与 states.json…' })
    const doc = buildStatesDoc({ input, normalized: result, generatedAt: ctx.nowIso() })
    const curPlan = await ctx.readStoryAssetPlanIfExists(id)
    const merged = mergeStoryStatesIntoPlan(curPlan || plan, doc)
    if (merged && merged !== (curPlan || plan)) {
      const nextPlan = { ...merged, generatedAt: ctx.nowIso() }
      nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
      await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
    }
    const statesPath = path.join(ctx.projectStoryAssetsDir(id), 'states.json')
    await ctx.writeJson(statesPath, doc)

    const changed = doc.scenes.reduce((n, s) => n + s.states.filter((st) => st.stateKey !== STORY_STATE_UNCHANGED).length, 0)
    updateAiTask(task.taskId, {
      stage: 'done',
      done: true,
      current: 2,
      message: `状态表提取完成：${doc.scenes.length} 场景，${changed} 条非默认状态`,
      result: { scenes: doc.scenes.length, changed }
    })
    return c.json({ success: true, taskId: task.taskId, states: doc, meta })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    updateAiTask(task.taskId, { stage: 'error', done: true, error: msg, message: `状态表提取失败：${msg}` })
    const mapped = classifyAiError(e)
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

app.post('/api/projects/:id/ai/story/craft/carrier-variant', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }

  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  const skillId = String(body?.skillId || '').trim()
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)
  if (!skillId) return c.json({ success: false, error: 'missing_skill_id', message: 'skillId 不能为空' }, 400)

  const skill = getCraftSkill(skillId)
  if (!skill || String(skill.category || '') !== 'carrier') {
    return c.json({ success: false, error: 'carrier_skill_not_found', message: `工艺库中未找到载体技能件：${skillId}` }, 404)
  }
  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)
  const planAssets = Array.isArray(plan.assets) ? plan.assets : []
  const asset = planAssets.find((a) => String(a && a.id || '').trim() === assetId) || null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `资产不存在：${assetId}` }, 404)
  if (String(asset.category || '') !== 'character') {
    return c.json({ success: false, error: 'carrier_requires_character', message: '载体变体仅适用于角色资产' }, 400)
  }

  // 2026-10-16 剧情状态机：poseKeyOverride 允许登记键覆盖（states/generate 以 stateKey 作登记键，
  // 摆位按 stateKey 命中变体）；缺省仍为 skillId（工艺库直调行为不变）。
  // 幂等键同理取登记键：同资产同登记键且已登记项目资产的变体直接返回
  // （不同 stateKey 复用同一技能件时——如 holding_big_pear/holding_small_pear——不会被彼此跳过）。
  const poseKeyOut = String(body?.poseKeyOverride || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') || skillId
  const existing = (Array.isArray(asset.poseVariants) ? asset.poseVariants : [])
    .find((v) => String(v?.poseKey || '').trim() === poseKeyOut && String(v?.projectAssetId || '').trim())
  if (existing) {
    return c.json({ success: true, existed: true, assetId, skillId, poseKey: poseKeyOut, projectAssetId: String(existing.projectAssetId) })
  }

  // 主参考（锁定）为身份输入
  const identityRel = String(asset.primaryReferenceAssetUri || '').trim()
  const identityAbs = identityRel ? path.resolve(dir, identityRel) : ''
  if (!identityAbs || !identityAbs.startsWith(path.resolve(dir) + path.sep) || !(await ctx.existsFile(identityAbs))) {
    return c.json({ success: false, error: 'identity_reference_missing', message: `资产「${asset.name || assetId}」缺少已锁定的主参考图，请先完成锁定。` }, 409)
  }

  // 模板填槽：角色锚点 + 道具锚点（propAssetId 取道具锚点，或显式 propAnchor 文本覆盖）
  // 2026-10-18 载体出图身份锚点净化：锚点中提及"其他角色"的比较级/关系从句
  // （如 "visibly TALLER than the 4-year-old Kong Rong"、"clearly older sibling"）会让画布多出一个人
  // （哥哥载体实测渲染出双人）。载体变体恒为单人，填槽前剔除该类从句。
  const sanitizeCarrierAnchor = (text) => String(text || '')
    .replace(/,?\s*(?:visibly|clearly|obviously|noticeably)?\s*(?:taller|shorter|older|younger|bigger|smaller)\s+than\s+[^,;.]+/gi, '')
    .replace(/,?\s*clearly\s+(?:older|younger)\s+(?:sibling|brother|sister)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/,\s*,/g, ',')
    .trim()
  const characterAnchor = sanitizeCarrierAnchor(String(asset.referencePromptEn || asset.anchorPromptEn || asset.anchorPrompt || '').trim())
  const propAsset = String(body?.propAssetId || '').trim()
    ? planAssets.find((a) => String(a && a.id || '').trim() === String(body.propAssetId).trim()) || null
    : null
  const propAnchor = String(body?.propAnchor || '').trim() || String(propAsset && (propAsset.referencePromptEn || propAsset.anchorPrompt)).trim()
  const slots = {
    characterAnchor,
    propAnchor,
    // 2026-10-15 根修：propOnTray 优先用调用方显式给的内容物锚点（盘内梨≠盘本身），
    // 此前恒被道具锚点覆盖（孔融"盘内炸物代梨"根因）
    propOnTray: String(body?.propOnTray || '').trim() || propAnchor,
    giverAnchor: characterAnchor,
    receiverAnchor: String(body?.receiverAnchor || '').trim(),
    // 情绪槽：技能模板（如手持单物）可带表情要求，缺省为自然中性
    expressionHint: String(body?.expressionHint || '').trim() || 'natural relaxed expression'
  }
  let prompt = String(skill.generation?.promptTemplate || '').trim()
  for (const [key, value] of Object.entries(slots)) {
    prompt = prompt.split(`{${key}}`).join(value)
  }
  const unfilled = prompt.match(/\{[a-zA-Z]+\w*\}/)
  if (unfilled) {
    return c.json({ success: false, error: 'carrier_template_unresolved', message: `技能模板占位未填满（${unfilled[0]}）：请提供对应锚点（如 propAssetId/propAnchor/receiverAnchor）。` }, 400)
  }
  const negativePrompt = [
    'multiple people, duplicate, text, watermark, realistic, photo, deformed, extra limbs',
    String(skill.generation?.negativeExtra || '').trim()
  ].filter(Boolean).join(', ')

  const task = createAiTask(id, 'story.craft.carrier_variant', { total: 1, message: `载体变体生成：${asset.name || assetId} × ${skill.name}` })
  const traceId = createTraceId()
  logStage({ stage: 'story.craft.carrier_variant', event: 'start', traceId, project: id, item: `${assetId} x ${skillId}` })

  const settled = { result: null, error: null }
  const running = (async () => {
    try {
      updateAiTask(task.taskId, { stage: 'generating', message: `载体变体出图：${skill.name}（提示词驱动）` })
      const identityBytes = await readFile(identityAbs)
      const gen = await generateComfyuiPoseVariantSprite({
        identityReferenceBytes: identityBytes,
        identityFilename: path.basename(identityAbs),
        poseSkeletonBytes: ctx.BLANK_SKELETON_PNG_BYTES,
        comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
        prompt,
        negativePrompt,
        width: 768,
        height: 1152,
        steps: 24,
        cfgScale: 6,
        // 载体变体纯提示词驱动：空白骨架 + 低控制强度（骨架不主导姿势，模板文本驱动持物关系）
        controlStrength: 0.3,
        ipadapterWeight: 0.85,
        timeoutMs: 300_000,
        prefix: `talkscene_craft/carrier_${String(assetId).replace(/[^a-z0-9_-]/gi, '_')}`
      })
      const outRel = `assets/ai/story_assets/character/${String(assetId).replace(/[^a-z0-9_-]/gi, '_')}/carrier_${skillId.replace(/[^a-z0-9_.-]/gi, '_')}_${Date.now()}.png`
      const outAbs = path.resolve(dir, outRel)
      await mkdir(path.dirname(outAbs), { recursive: true })
      await writeFile(outAbs, gen.bytes)

      // 登记：与 GS-51 同通道 layered-produce（抠图/评审/计划写回/审核留痕一致）；
      // 审核模式控制面已做步骤级审核，内部转发带 off 旁路
      updateAiTask(task.taskId, { stage: 'registering', message: '载体变体登记（抠图/评审/写回）' })
      // 2026-10-18 根修：登记场景域优先取调用方显式 sceneIds（states/generate 传剧情状态的需求场景），
      // 缺省回退资产全场景——此前恒用 asset.sceneIds 导致"手持梨"变体在角色所有场景被摆位命中，
      // 没拿梨的场景也抱梨（孔融让梨实测事故）。
      const stateSceneIds = (Array.isArray(body?.sceneIds) ? body.sceneIds : []).map((x) => String(x || '').trim()).filter(Boolean)
      const sceneIds = stateSceneIds.length ? stateSceneIds : (Array.isArray(asset.sceneIds) ? asset.sceneIds : []).map((x) => String(x || '').trim()).filter(Boolean)
      const firstSceneId = sceneIds[0]
      if (!firstSceneId) throw new Error('asset_has_no_scene')
      const resp = await app.request(`/api/projects/${encodeURIComponent(id)}/ai/story/scenes/${encodeURIComponent(firstSceneId)}/layered-produce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-image-review-mode': 'off' },
        body: JSON.stringify({
          poses: [{
            lockName: `载体·${skill.name}`,
            planAssetId: String(assetId).trim(),
            characterId: String(assetId).trim(),
            spriteAssetPath: outRel,
            posePrompt: prompt,
            promptZh: `${asset.name || assetId}·${skill.name}`,
            sceneIds: sceneIds.length ? sceneIds : [firstSceneId]
          }]
        })
      })
      const json = await resp.json().catch(() => ({}))
      const okEntry = Array.isArray(json?.poses) && json.poses[0] && json.poses[0].projectAssetId
      if (!resp.ok || !okEntry) throw new Error(`register_failed:${String(json?.poses?.[0]?.error || json?.error || resp.status)}`)
      const projectAssetId = String(json.poses[0].projectAssetId)

      // 回写 poseKey=登记键（缺省=skillId，摆位消费按 skillId 选载体变体；states/generate 经
      // poseKeyOverride 以 stateKey 登记，摆位剧情状态分支按 stateKey 命中）；
      // skillId 字段始终保留（工艺库载体摆位 resolveCarrierPlacementPlan 的双键匹配依据之一）；
      // carrierPropAssetId 供摆位跳过被承载道具。
      const curPlan = await ctx.readStoryAssetPlanIfExists(id)
      if (curPlan) {
        const nextPlan = {
          ...curPlan,
          generatedAt: ctx.nowIso(),
          assets: (Array.isArray(curPlan.assets) ? curPlan.assets : []).map((a) => {
            if (String(a && a.id || '').trim() !== assetId) return a
            const variants = (Array.isArray(a.poseVariants) ? a.poseVariants : []).map((v) =>
              // 2026-10-15 根修：写回匹配按 projectAssetId 或 projectAssetUri 双键（layered-produce 登记条目两键可能错位）
              (String(v && v.projectAssetId || '').trim() === projectAssetId
                || String(v && v.projectAssetUri || '').trim().replace(/^\/+/, '') === String(json.poses[0].projectAssetUri || '').trim().replace(/^\/+/, ''))
                ? {
                    ...v,
                    poseKey: poseKeyOut,
                    skillId,
                    skillCategory: 'carrier',
                    ...(propAsset ? { carrierPropAssetId: String(propAsset.id || '').trim() } : {})
                  }
                : v
            )
            return { ...a, poseVariants: variants }
          })
        }
        nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
        await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true, mergeRecordUpdates: ['poseVariants'] })
      }

      settled.result = { assetId, skillId, poseKey: poseKeyOut, projectAssetId }
      updateAiTask(task.taskId, {
        stage: 'done',
        done: true,
        current: 1,
        message: `载体变体完成：${asset.name || assetId} × ${skill.name}`,
        result: settled.result
      })
      logStage({ stage: 'story.craft.carrier_variant', event: 'done', traceId, project: id, item: `${assetId} x ${skillId} -> ${projectAssetId}` })
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      settled.error = { code: String((e && e.code) || 'ai_failed'), message: msg }
      updateAiTask(task.taskId, { stage: 'error', done: true, error: msg, message: `载体变体生成失败：${msg}` })
      logStage({ stage: 'story.craft.carrier_variant', event: 'error', traceId, project: id, item: msg.slice(0, 300) })
    }
  })()

  // 2026-10-16 wait 模式（states/generate 串行编排用）：等待生成闭环后直接回结果；缺省保持 202 异步。
  if (body?.wait === true) {
    await running
    if (settled.error) {
      return c.json({ success: false, error: settled.error.code, message: settled.error.message, taskId: task.taskId }, 502)
    }
    return c.json({ success: true, taskId: task.taskId, ...(settled.result || {}) })
  }
  return c.json({ success: true, taskId: task.taskId, message: '载体变体生成已启动，进度见 /ai/tasks' }, 202)
})

// 2026-09-16 道具状态变体生成：同一道具的"剧情状态"立绘（水位/满空/破碎…）。
// 链路：sprite(kind:'prop'，锚定词+状态描述) → pose-review（planAssetId 道具泛化评审，可选失败记 reviewUnavailable）
//   → cutout → 登记 project.json → 计划资产 stateVariants 追加 → lock_confirm 审核留痕（decidedBy=control/editor 触发源）。
// 全程经 /ai/tasks 暴露进度；内部转发统一带 x-image-review-mode: off（触发侧已有自己的审核门禁）。
app.post('/api/projects/:id/ai/story/assets/:assetId/state-variants/generate', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const planAssetId = String(c.req.param('assetId') || '').trim()
  if (!planAssetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const body = await c.req.json().catch(() => ({}))
  const stateKey = String(body?.stateKey || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
  const label = String(body?.label || body?.stateKey || '').trim()
  const description = String(body?.description || body?.promptZh || '').trim()
  const customPrompt = String(body?.prompt || '').trim()
  const strategy = String(body?.strategy || 'ai').trim().toLowerCase() || 'ai'
  if (!stateKey) return c.json({ success: false, error: 'missing_state_key', message: 'stateKey 不能为空' }, 400)
  if (strategy === 'ai' && !description && !customPrompt) return c.json({ success: false, error: 'missing_description', message: 'description/prompt 至少提供一个' }, 400)
  if (!['ai', 'fill_composite', 'transform'].includes(strategy)) return c.json({ success: false, error: 'invalid_strategy', message: 'strategy 仅支持 ai / fill_composite / transform' }, 400)

  const plan = await ctx.readStoryAssetPlanIfExists(id)
  const planAssets = plan && Array.isArray(plan.assets) ? plan.assets : []
  const planAsset = planAssets.find((a) => String(a && a.id || '').trim() === planAssetId) || null
  if (!planAsset) return c.json({ success: false, error: 'asset_not_found', message: '计划中未找到该事物资产。' }, 404)
  const assetName = String(planAsset.name || planAssetId).trim()

  const task = createAiTask(id, 'story.prop.state_variant', { total: 1, message: `生成状态变体：${assetName}·${label}` })
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
  const traceLockConfirm = async ({ resultImagePath, prompt }) => {
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

  // 状态提示词：身份锚定 + "同一个事物"声明 + 状态描述（中文稿，sprite 端点内自动翻译英文稿）
  const statePrompt = customPrompt || `同一个${assetName}，${description}`
  try {
    let assetPath = ''
    let cutoutPath = ''
    let compositeMeta = null

    if (strategy === 'fill_composite') {
      // 2026-09-16 确定性填充合成：以锁定主参考为底，程序化叠加填充层（水位）与内容物抠图（石子等）。
      // 背景：AI 生成对"同一容器+液位递进+内容物"不可靠（锚定压内容词/身份逐张漂移），
      // 本地脚本黑盒合成违反出图可观测——合成收进服务端：/ai/tasks 进度 + 出图即压 + 评审 + lock_confirm 留痕。
      updateAiTask(task.taskId, { stage: 'state_composite', current: 0, message: `确定性合成状态图：${assetName}·${label}` })
      const refUri = String(planAsset.primaryReferenceAssetUri || planAsset.latestRecommendedReferenceAssetUri || '').trim()
        .replace(/^https?:\/\/[^/]+\/project-assets\/[^/]+\//i, '')
        .replace(/^\/project-assets\/[^/]+\//, '')
      if (!refUri.startsWith('assets/')) {
        const err = new Error('该事物没有可用的锁定主参考图，无法合成')
        err.code = 'reference_not_found'
        throw err
      }
      const refAbs = path.join(dir, refUri)
      if (!(await ctx.existsFile(refAbs))) {
        const err = new Error(`主参考图文件不存在：${refUri}`)
        err.code = 'reference_not_found'
        throw err
      }
      const overlaySpecs = []
      for (const ov of (Array.isArray(body?.overlays) ? body.overlays : [])) {
        const ovAssetId = String(ov?.planAssetId || '').trim()
        const ovAsset = ovAssetId ? planAssets.find((a) => String(a && a.id || '').trim() === ovAssetId) : null
        const ovUri = String(ov?.imagePath || (ovAsset && (ovAsset.primaryReferenceAssetUri || ovAsset.latestRecommendedReferenceAssetUri)) || '').trim()
          .replace(/^https?:\/\/[^/]+\/project-assets\/[^/]+\//i, '')
          .replace(/^\/project-assets\/[^/]+\//, '')
        if (!ovUri.startsWith('assets/') || !(await ctx.existsFile(path.join(dir, ovUri)))) continue
        overlaySpecs.push({
          imagePath: path.join(dir, ovUri),
          ...(Number.isFinite(Number(ov?.count)) ? { count: Number(ov.count) } : {}),
          ...(Number.isFinite(Number(ov?.scale)) ? { scale: Number(ov.scale) } : {}),
          ...(Number.isFinite(Number(ov?.brightness)) ? { brightness: Number(ov.brightness) } : {}),
          ...(Number.isFinite(Number(ov?.alpha)) ? { alpha: Number(ov.alpha) } : {}),
          ...(Number.isFinite(Number(ov?.blueShift)) ? { blueShift: Number(ov.blueShift) } : {}),
          ...(Array.isArray(ov?.spots) ? { spots: ov.spots } : {})
        })
      }
      const waterLevel = Math.max(0, Math.min(1, Number(body?.fill?.level ?? body?.waterLevel ?? 0) || 0))
      const relOut = `assets/ai/characters/ch_fill_${Date.now()}.webp`
      const outAbs = path.join(dir, relOut)
      // 2026-09-30 修复：合成输出目录可能不存在（未跑过姿势链的项目无 assets/ai/characters/），
      // PIL save 直接 FileNotFoundError（乌鸦喝水实测 fill_composite_exit_1）
      await mkdir(path.dirname(outAbs), { recursive: true })
      const pyArgs = JSON.stringify({
        refPath: refAbs,
        outPath: outAbs,
        waterLevel,
        overlays: overlaySpecs,
        ...(body?.fill && typeof body.fill === 'object' ? {
          ...(Number.isFinite(Number(body.fill.insetL)) ? { insetL: Number(body.fill.insetL) } : {}),
          ...(Number.isFinite(Number(body.fill.insetR)) ? { insetR: Number(body.fill.insetR) } : {}),
          ...(Number.isFinite(Number(body.fill.insetB)) ? { insetB: Number(body.fill.insetB) } : {}),
          ...(Number.isFinite(Number(body.fill.neckRatio)) ? { neckRatio: Number(body.fill.neckRatio) } : {})
        } : {})
      })
      await new Promise((resolve, reject) => {
        const py = spawn('python3', [path.join(ctx.__dirname, 'ai', 'fillComposite.py'), pyArgs])
        let stderr = ''
        py.stderr.on('data', (d) => { stderr += String(d || '') })
        py.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fill_composite_exit_${code}: ${stderr.slice(0, 300)}`))))
        py.on('error', reject)
      })
      if (!(await ctx.existsFile(outAbs))) throw new Error('fill_composite_no_output')
      // 出图即压：状态立绘走无损 WebP（PIL 已无损落盘，此处经管线统一校验/转换）
      let finalPath = relOut
      const opt = await optimizeGeneratedImage(outAbs, IMAGE_KIND.SPRITE_LOSSLESS).catch(() => null)
      if (opt && opt.outPath && opt.outPath !== outAbs) finalPath = String(ctx.assetPathFromAbsolute(id, opt.outPath) || relOut)
      cutoutPath = finalPath
      compositeMeta = {
        waterLevel,
        overlayCount: overlaySpecs.reduce((n, o) => n + Number(o.count || 3), 0),
        overlayFromAssetIds: overlaySpecs.length ? 'plan' : ''
      }
    } else if (strategy === 'transform') {
      // 2026-10-04 确定性变换合成（微主体/简单状态专用，transformComposite.py）：
      // 背景——微主体（蚂蚁级）在纯文本与 IPAdapter 三档下身份/姿势双失控（实测 33 张全废：
      // 鼠耳/翅膀/瓢虫裙），姿势词从不生效；变换合成不重画像素，只对锁定立绘做 倾斜/翻转/压扁/跃起/速度线/汗滴
      // 的确定性变换，身份像素级零漂移。无 GPU/无评审调用（评审对本类无意义：身份由构造保证）。
      updateAiTask(task.taskId, { stage: 'state_transform', current: 0, message: `确定性变换状态图：${assetName}·${label}` })
      const refUri = String(planAsset.primaryReferenceAssetUri || planAsset.latestRecommendedReferenceAssetUri || '').trim()
        .replace(/^https?:\/\/[^/]+\/project-assets\/[^/]+\//i, '')
        .replace(/^\/project-assets\/[^/]+\//, '')
      if (!refUri.startsWith('assets/')) {
        const err = new Error('该事物没有可用的锁定主参考图，无法变换合成')
        err.code = 'reference_not_found'
        throw err
      }
      const refAbs = path.join(dir, refUri)
      if (!(await ctx.existsFile(refAbs))) {
        const err = new Error(`主参考图文件不存在：${refUri}`)
        err.code = 'reference_not_found'
        throw err
      }
      const tr = body?.transform && typeof body.transform === 'object' ? body.transform : {}
      const relOut = `assets/ai/characters/ch_tr_${Date.now()}.webp`
      const outAbs = path.join(dir, relOut)
      await mkdir(path.dirname(outAbs), { recursive: true })
      const pyArgs = JSON.stringify({
        refPath: refAbs,
        outPath: outAbs,
        ...(Number.isFinite(Number(tr.rotateDeg)) ? { rotateDeg: Number(tr.rotateDeg) } : {}),
        ...(tr.flipH === true ? { flipH: true } : {}),
        ...(Number.isFinite(Number(tr.squashY)) ? { squashY: Number(tr.squashY) } : {}),
        ...(Number.isFinite(Number(tr.jumpRatio)) ? { jumpRatio: Number(tr.jumpRatio) } : {}),
        ...(Number.isFinite(Number(tr.motionLines)) ? { motionLines: Number(tr.motionLines) } : {}),
        ...(Number.isFinite(Number(tr.sweat)) ? { sweat: Number(tr.sweat) } : {})
      })
      await new Promise((resolve, reject) => {
        const py = spawn('python3', [path.join(ctx.__dirname, 'ai', 'transformComposite.py'), pyArgs])
        let stderr = ''
        py.stderr.on('data', (d) => { stderr += String(d || '') })
        py.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`transform_composite_exit_${code}: ${stderr.slice(0, 300)}`))))
        py.on('error', reject)
      })
      if (!(await ctx.existsFile(outAbs))) throw new Error('transform_composite_no_output')
      let finalPath = relOut
      const opt = await optimizeGeneratedImage(outAbs, IMAGE_KIND.SPRITE_LOSSLESS).catch(() => null)
      if (opt && opt.outPath && opt.outPath !== outAbs) finalPath = String(ctx.assetPathFromAbsolute(id, opt.outPath) || relOut)
      cutoutPath = finalPath
      compositeMeta = {
        transform: {
          ...(Number.isFinite(Number(tr.rotateDeg)) ? { rotateDeg: Number(tr.rotateDeg) } : {}),
          ...(tr.flipH === true ? { flipH: true } : {}),
          ...(Number.isFinite(Number(tr.squashY)) ? { squashY: Number(tr.squashY) } : {}),
          ...(Number.isFinite(Number(tr.jumpRatio)) ? { jumpRatio: Number(tr.jumpRatio) } : {}),
          ...(Number.isFinite(Number(tr.motionLines)) ? { motionLines: Number(tr.motionLines) } : {}),
          ...(Number.isFinite(Number(tr.sweat)) ? { sweat: Number(tr.sweat) } : {})
        }
      }
    } else {
      const spriteJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/sprite`, {
        kind: 'prop',
        planAssetId,
        ipadapter: {
          enabled: true,
          ...(Number.isFinite(Number(body?.ipadapter?.weight)) ? { weight: Number(body.ipadapter.weight) } : {}),
          ...(Number.isFinite(Number(body?.ipadapter?.startAt)) ? { startAt: Number(body.ipadapter.startAt) } : {}),
          ...(Number.isFinite(Number(body?.ipadapter?.endAt)) ? { endAt: Number(body.ipadapter.endAt) } : {})
        },
        fingerprintPrompt: String(planAsset.anchorPrompt || '').trim(),
        globalPrompt: 'cartoon fairy tale picture book style, flat 2D illustration, bold clean outlines, cel shading, warm soft color palette',
        posePrompt: statePrompt,
        negativePrompt: [String(body?.negativePrompt || '').trim(), String(planAsset.negativePrompt || '').trim()].filter(Boolean).join(', '),
        style: 'picture_book',
        width: 720,
        height: 1280,
        steps: 20,
        cfgScale: 7
      })
      assetPath = String(spriteJson.assetPath || '').trim()
      updateAiTask(task.taskId, { stage: 'state_cutout', current: 0, message: `状态抠图：${assetName}·${label}` })
      const cutoutJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/cutout`, { assetPath })
      cutoutPath = String(cutoutJson.assetPath || '').trim()
    }

    let score
    let reason = ''
    let reviewUnavailable = ''
    if (strategy === 'transform') {
      // 变换合成身份由构造保证（同一锁定立绘的像素级变换），AI 姿势评审对本类无意义，跳过
      reason = 'deterministic_transform'
    } else try {
      updateAiTask(task.taskId, { stage: 'state_review', current: 0, message: `状态一致性评审：${assetName}·${label}` })
      const reviewJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/pose-review`, { planAssetId, assetPath: cutoutPath })
      if (Number.isFinite(Number(reviewJson.score))) score = Number(reviewJson.score)
      reason = String(reviewJson.reason || '').trim()
    } catch (e) {
      reviewUnavailable = String((e && e.code) || 'review_unavailable')
    }

    // 产物登记：project.json assets 追加（读最新盘再写回）
    const projectAssetId = genId('asset')
    const proj = await ctx.readJson(path.join(dir, 'project.json'))
    const nextProject = {
      ...proj,
      assets: [...(Array.isArray(proj?.assets) ? proj.assets : []), {
        id: projectAssetId,
        kind: 'image',
        name: `AI 状态 ${assetName}·${label}`,
        uri: cutoutPath,
        source: strategy === 'fill_composite'
          ? { type: 'composite', prompt: statePrompt, provider: 'deterministic', postprocess: 'ref_water_overlay' }
          : strategy === 'transform'
            ? { type: 'composite', prompt: statePrompt, provider: 'deterministic', postprocess: 'ref_transform' }
            : { type: 'ai', prompt: statePrompt, provider: 'comfyui', postprocess: 'rmbg_alpha' }
      }],
      updatedAt: ctx.nowIso(),
      _rev: Number(proj?._rev || 0) + 1
    }
    await ctx.writeJson(path.join(dir, 'project.json'), nextProject)

    // 计划资产 stateVariants 追加（读最新 plan 再写回，mergeAssetsById 保并发安全）
    const curPlan = await ctx.readStoryAssetPlanIfExists(id)
    if (curPlan) {
      const variant = {
        id: genId('state'),
        stateKey,
        name: label,
        prompt: statePrompt,
        promptZh: String(body?.promptZh || description || customPrompt || '').trim(),
        greenPath: assetPath,
        cutoutPath,
        projectAssetId,
        projectAssetUri: cutoutPath,
        ...(strategy === 'fill_composite' ? { composite: 'ref_water_overlay', compositeMeta } : {}),
        ...(strategy === 'transform' ? { composite: 'ref_transform', compositeMeta } : {}),
        ...(score !== undefined ? { score } : {}),
        ...(reason ? { reason } : {}),
        createdAt: ctx.nowIso()
      }
      const nextPlan = {
        ...curPlan,
        generatedAt: ctx.nowIso(),
        assets: (Array.isArray(curPlan.assets) ? curPlan.assets : []).map((a) =>
          String(a && a.id || '').trim() === planAssetId
            ? { ...a, stateVariants: [...(Array.isArray(a.stateVariants) ? a.stateVariants : []), variant] }
            : a
        )
      }
      nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
      await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
    }

    await traceLockConfirm({ resultImagePath: cutoutPath, prompt: statePrompt })
    updateAiTask(task.taskId, {
      stage: 'done',
      done: true,
      current: 1,
      message: `状态变体完成：${assetName}·${label}${score !== undefined ? `（${score} 分）` : ''}`,
      result: { planAssetId, stateKey, label, projectAssetId, ...(score !== undefined ? { score } : {}) }
    })
    return c.json({
      success: true,
      taskId: task.taskId,
      planAssetId,
      stateKey,
      label,
      projectAssetId,
      cutoutPath,
      ...(score !== undefined ? { score } : {}),
      ...(reason ? { reason } : {}),
      ...(reviewUnavailable ? { reviewUnavailable } : {})
    })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    updateAiTask(task.taskId, { stage: 'error', done: true, current: 1, error: msg, message: `状态变体失败：${assetName}·${label}（${msg}）` })
    return c.json({ success: false, error: String((e && e.code) || 'ai_failed'), message: msg, taskId: task.taskId }, 502)
  }
})

// ---------------------------------------------------------------------------
// 剧情状态机·状态变体自动补齐（2026-10-16）：
// 扫描 plan.stateRequirements 中"有非 unchanged 状态但无对应变体"的（资产×状态）组合，逐条串行生成：
//   道具         → 既有 state-variants/generate 链（登记 stateVariants，stateKey 命中）；
//   角色持物/端盘 → 载体变体端点（carrier.holding_object/holding_tray 技能件，poseKeyOverride=stateKey，
//                   propAssetId/propAnchor 由状态 relatedAssetIds 推导：盘/托盘类作载体，其余作内容物锚点）；
//   角色姿态/表情 → 姿势变体链（sprite 身份锚定出图 + layered-produce 登记，回写 poseKey=stateKey）。
// 幂等：已有该 stateKey 变体（poseVariants/stateVariants 双池按 stateKey/poseKey 匹配）的组合跳过。
// 全部经 /ai/tasks 暴露进度；单项失败记 errors 继续后续独立项（同 pose-variants/auto 批处理语义）。
// ---------------------------------------------------------------------------
app.post('/api/projects/:id/ai/story/states/generate', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }

  const plan = await ctx.readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)
  const body = await c.req.json().catch(() => ({}))
  const strategy = String(body?.strategy || 'ai').trim().toLowerCase() || 'ai'
  const sceneId = String(body?.sceneId || '').trim()
  const gaps = findStateGaps(plan, { assetId: body?.assetId, stateKey: body?.stateKey, sceneId })
  if (!gaps.length) {
    return c.json({ success: true, gaps: 0, sceneId: sceneId || undefined, message: '没有待补齐的状态变体（全部已有变体或无状态需求）。' })
  }
  // 台账记录的紧凑缺口引用；注意必须在异步批处理外定义——历史 bug：仅在循环内隐式引用未定义的
  // gapRef，成功/失败路径都会抛 ReferenceError 并被 catch 二次抛出，直接打崩进程（表现为 interrupted_by_restart）。
  const gapRef = (gap) => ({
    assetId: gap.assetId,
    assetName: gap.assetName,
    stateKey: gap.stateKey,
    label: gap.label,
    kind: gap.kind,
    sceneIds: gap.sceneIds
  })

  const task = createAiTask(id, 'story.states.generate', { total: gaps.length, message: `状态变体补齐${sceneId ? `（场景 ${sceneId}）` : ''}：${gaps.length} 项` })
  const traceId = createTraceId()
  logStage({ stage: 'story.states.generate', event: 'start', traceId, project: id, item: `gaps:${gaps.length}` })
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

  void (async () => {
    const generated = []
    const errors = []
    let cursor = 0
    for (const gap of gaps) {
      cursor += 1
      const label = `${gap.assetName}·${gap.label}`
      try {
        const curPlan = await ctx.readStoryAssetPlanIfExists(id)
        const curAsset = (curPlan && Array.isArray(curPlan.assets) ? curPlan.assets : [])
          .find((a) => String(a && a.id || '').trim() === gap.assetId) || null
        if (!curAsset) throw new Error('asset_not_found')
        // 载体槽推导：relatedAssetIds 里盘/托盘类作载体道具，第一个非盘类作内容物锚点（盘内梨≠盘本身）
        const relatedAssets = gap.relatedAssetIds
          .map((rid) => (curPlan.assets || []).find((a) => String(a && a.id || '').trim() === rid) || null)
          .filter(Boolean)
        const isTrayLike = (a) => /plate|tray|dish|platter|盘|碟|托盘/i.test([a && a.name, ...(Array.isArray(a && a.aliases) ? a.aliases : []), a && a.anchorPrompt].map((x) => String(x || '')).join(' '))
        const trayAsset = relatedAssets.find(isTrayLike) || null
        const contentAsset = relatedAssets.find((a) => !isTrayLike(a)) || null

        if (gap.kind === 'prop_state') {
          // 确定性合成只落在"盘/容器 + 道具内容物"组合上；无内容物可叠（如 bitten_pear 需改本体）
          // 或本体非容器时回退 AI 出图，避免 fill_composite 产出无语义的底图复制件。
          const contentAssets = relatedAssets.filter((a) => !isTrayLike(a) && String(a && a.category || '') === 'prop')
          const effectiveStrategy = (strategy === 'fill_composite' && isTrayLike(curAsset) && contentAssets.length) ? 'fill_composite' : 'ai'
          updateAiTask(task.taskId, { stage: 'prop_state', current: cursor - 1, message: `道具状态变体：${label}${effectiveStrategy === 'fill_composite' ? '（确定性合成）' : ''}` })
          const statePayload = { stateKey: gap.stateKey, label: gap.label, description: gap.description, strategy: effectiveStrategy }
          if (effectiveStrategy === 'fill_composite') {
            // 叠加内容物：角色排除（如 scene1 的 father 只是端盘人）；盘上摆放非水下场景，
            // 亮度/不透明度还原、不做蓝移；大小按名称关键词分档（大金梨 vs 干瘪小梨）；
            // 单一内容物时出 3 个读作"一盘梨"，多内容物各 1 个读作"剩两梨"。
            const overlays = contentAssets
              .map((a) => {
                const text = [a && a.name, ...(Array.isArray(a && a.aliases) ? a.aliases : [])].map((x) => String(x || '')).join(' ')
                const scale = /小|small|shrivel|mini/i.test(text) ? 0.62 : (/大|large|big|硕大|golden|金/i.test(text) ? 1.1 : 1)
                return { planAssetId: String(a && a.id || '').trim(), count: contentAssets.length > 1 ? 1 : 3, scale, brightness: 1, alpha: 1, blueShift: 0 }
              })
              .filter((o) => o.planAssetId)
            if (overlays.length) statePayload.overlays = overlays
          }
          const json = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/story/assets/${encodeURIComponent(gap.assetId)}/state-variants/generate`, statePayload)
          generated.push({ ...gapRef(gap), projectAssetId: String(json.projectAssetId || '').trim() })
        } else if (gap.kind === 'carrier') {
          const skillId = carrierSkillIdForStateKey(gap.stateKey)
          const carrierProp = trayAsset || contentAsset || null
          // 无关联道具时的锚点兜底：label/description 是中文，直接填进英文技能模板会渲染不出所持物
          // （2026-10-18 孔融兄弟"手持梨"空手事故）——先经翻译链转英文并剥掉前导动作词
          // （模板自带 holding … in one hand），翻译不可用才回退原文。
          let fallbackPropAnchor = `${gap.label}（${gap.description}）`
          if (!carrierProp && /[\u4e00-\u9fff]/.test(fallbackPropAnchor)) {
            try {
              const tr = await ctx.translateStoryAssetPromptPair({ studio, promptZh: fallbackPropAnchor, fallbackPromptEn: '', timeoutMs: 60000 })
              const en = String(tr && tr.promptEn || '').trim().replace(/^(?:holding|carrying|grasping|with|holds?)\s+/i, '').trim()
              if (en) fallbackPropAnchor = en
            } catch (te) { /* 翻译链不可用：保留原文兜底 */
              logStage({ stage: 'story.states.generate', event: 'carrier_anchor_translate_fail', traceId, project: id, item: `${gap.assetId} / ${String(te && te.message || te).slice(0, 120)}` })
            }
          }
          if (!carrierProp) {
            logStage({ stage: 'story.states.generate', event: 'carrier_anchor', traceId, project: id, item: `${gap.assetId} anchor=${fallbackPropAnchor.slice(0, 140)}` })
          }
          updateAiTask(task.taskId, { stage: 'carrier', current: cursor - 1, message: `持物载体变体：${label}（${skillId}）` })
          const json = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/story/craft/carrier-variant`, {
            assetId: gap.assetId,
            skillId,
            ...(carrierProp ? { propAssetId: String(carrierProp.id || '').trim() } : {}),
            ...(trayAsset && contentAsset ? { propOnTray: String(contentAsset.referencePromptEn || contentAsset.anchorPrompt || contentAsset.name || '').trim() } : {}),
            ...(!carrierProp ? { propAnchor: fallbackPropAnchor } : {}),
            poseKeyOverride: gap.stateKey,
            // 登记场景域=剧情状态需求场景（而非资产全场景），摆位按 sceneIds 命中才不会"没拿梨也抱梨"
            sceneIds: gap.sceneIds,
            wait: true
          })
          generated.push({ ...gapRef(gap), skillId, projectAssetId: String(json.projectAssetId || '').trim() })
        } else {
          // 姿态/表情：sprite 身份锚定绿幕出图（planAssetId 经 IPAdapter 锚定锁定主参考，中文提示词端点内自动翻译）
          // → layered-produce 登记（抠图/评审/计划写回同 GS-51）→ 回写 poseKey=stateKey
          updateAiTask(task.taskId, { stage: 'pose_sprite', current: cursor - 1, message: `姿态状态出图：${label}` })
          const statePrompt = `同一个${gap.assetName}，${gap.description}`
          const spriteJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/sprite`, {
            kind: 'character',
            planAssetId: gap.assetId,
            ipadapter: { enabled: true },
            fingerprintPrompt: String(curAsset.anchorPrompt || '').trim(),
            globalPrompt: 'cartoon fairy tale picture book style, flat 2D illustration, bold clean outlines, cel shading, warm soft color palette',
            posePrompt: statePrompt,
            negativePrompt: String(curAsset.negativePrompt || '').trim(),
            style: 'picture_book',
            width: 720,
            height: 1280,
            steps: 20,
            cfgScale: 7
          })
          const spritePath = String(spriteJson.assetPath || '').trim()
          if (!spritePath) throw new Error('sprite_no_output')
          updateAiTask(task.taskId, { stage: 'pose_register', current: cursor - 1, message: `姿态状态登记：${label}` })
          const firstSceneId = gap.sceneIds[0]
          const json = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/story/scenes/${encodeURIComponent(firstSceneId)}/layered-produce`, {
            poses: [{
              lockName: `状态·${gap.label}`,
              planAssetId: gap.assetId,
              characterId: String(curAsset.projectCharacterId || gap.assetId).trim(),
              spriteAssetPath: spritePath,
              posePrompt: statePrompt,
              promptZh: gap.description,
              sceneIds: gap.sceneIds
            }]
          })
          const projectAssetId = String(json?.poses?.[0]?.projectAssetId || '').trim()
          if (!projectAssetId) throw new Error('register_failed')
          // 回写 poseKey=stateKey（摆位剧情状态分支按 stateKey 命中变体）
          const latestPlan = await ctx.readStoryAssetPlanIfExists(id)
          if (latestPlan) {
            const nextPlan = {
              ...latestPlan,
              generatedAt: ctx.nowIso(),
              assets: (Array.isArray(latestPlan.assets) ? latestPlan.assets : []).map((a) =>
                String(a && a.id || '').trim() === gap.assetId
                  ? {
                      ...a,
                      poseVariants: (Array.isArray(a.poseVariants) ? a.poseVariants : []).map((v) =>
                        String(v && v.projectAssetId || '').trim() === projectAssetId ? { ...v, poseKey: gap.stateKey, stateKey: gap.stateKey } : v
                      )
                    }
                  : a
              )
            }
            nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
            await ctx.saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true, mergeRecordUpdates: ['poseVariants'] })
          }
          generated.push({ ...gapRef(gap), projectAssetId })
        }
        updateAiTask(task.taskId, { current: cursor, message: `完成：${label}` })
        logStage({ stage: 'story.states.generate', event: 'generated', traceId, project: id, item: label })
      } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e)
        errors.push({ ...gapRef(gap), error: msg.slice(0, 200) })
        updateAiTask(task.taskId, { current: cursor, message: `失败：${label}（${msg.slice(0, 60)}）` })
        logStage({ stage: 'story.states.generate', event: 'fail', traceId, project: id, item: `${label} / ${msg.slice(0, 160)}` })
      }
    }
    updateAiTask(task.taskId, {
      stage: 'done',
      done: true,
      current: gaps.length,
      message: `状态变体补齐完成：生成 ${generated.length}，失败 ${errors.length}`,
      result: { generated, errors }
    })
    logStage({ stage: 'story.states.generate', event: 'done', traceId, project: id, item: `generated:${generated.length} failed:${errors.length}` })
  })()

  return c.json({ success: true, taskId: task.taskId, gaps: gaps.length, message: '状态变体补齐已启动，进度见 /ai/tasks' }, 202)
})
}
