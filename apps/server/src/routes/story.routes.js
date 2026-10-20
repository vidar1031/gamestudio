// ---------------------------------------------------------------------------
// registerStoryRoutes（模块化拆分机械迁出，字义未改；协议层+族内编排，域算法引自 ../ai/*，index 本地辅助经 ctx 注入）
// ---------------------------------------------------------------------------
import path from 'node:path'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rename, stat, writeFile, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import crypto from 'node:crypto'
import { genId, guessTitleFromPrompt, repairScriptDraft } from '../ai/scripts.js'
import { analyzeScriptsForBlueprint } from '../ai/analyze.js'
import { readGlobalRules } from '../ai/globalRules.js'
import { compileBlueprintFromScripts } from '../blueprint/compile.js'
import { validateBlueprintDoc } from '../blueprint/validate.js'
import { getEffectiveStudioConfig } from '../studio/settings.js'
import { recordCreationEvent, snapshotCreationState } from '../creationBuffer.js'
import { storyInputGate } from '../middleware/storyInputGate.js'
import { normalizeProjectDoc } from '../studio/projectState.js'

export function registerStoryRoutes(app, ctx) {
// [拆分] GET /api/ai/prompt/templates 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] POST /api/ai/prompt/templates/generate 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] POST /api/ai/prompt/templates 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] DELETE /api/ai/prompt/templates/:id 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] GET /api/ai/prompt-library 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] POST /api/ai/prompt-library 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] PUT /api/ai/prompt-library/:id 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] DELETE /api/ai/prompt-library/:id 已迁至 apps/server/src/routes/studio.routes.js
app.get('/api/projects', async (c) => {
  await ctx.ensureDirs()
  const items = []
  const dirs = await readdir(ctx.PROJECTS_DIR).catch(() => [])
  for (const id of dirs) {
    const dir = ctx.projectDir(id)
    if (!(await ctx.existsDir(dir))) continue
    try {
      const p0 = await ctx.readJson(path.join(dir, 'project.json'))
      const { project: p, changed } = ctx.normalizeProjectAndDetectChanges(p0)
      // 2026-10-05 草稿标记透传：AI 生成未确认的项目不消失于列表（草稿入口依赖），由前端分开展示
      const meta = await ctx.readJson(path.join(dir, 'meta.json')).catch(() => null)
      items.push({ ...p, aiDraftStatus: String(meta?.aiDraftStatus || 'confirmed') })
      if (changed) await ctx.writeJson(path.join(dir, 'project.json'), p)
    } catch (_) {}
  }
  items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  return c.json({ success: true, items })
})

// 项目库卡片摘要：阶段健康（脚本/蓝图/合成/导出）与可玩性，只读。
app.get('/api/projects/summary', async (c) => {
  await ctx.ensureDirs()
  const items = []
  const dirs = await readdir(ctx.PROJECTS_DIR).catch(() => [])
  for (const id of dirs) {
    const dir = ctx.projectDir(id)
    if (!(await ctx.existsDir(dir))) continue
    try {
      const p0 = await ctx.readJson(path.join(dir, 'project.json'))
      const { project: p } = ctx.normalizeProjectAndDetectChanges(p0)
      const scripts = await ctx.readJson(path.join(dir, 'scripts.json')).catch(() => null)
      const blueprint = await ctx.readJson(path.join(dir, 'blueprint.json')).catch(() => null)
      const story = await ctx.readJson(path.join(dir, 'story.json')).catch(() => null)
      const cards = Array.isArray(scripts?.cards) ? scripts.cards.length : 0
      const blueprintNodes = Array.isArray(blueprint?.nodes) ? blueprint.nodes.length : 0
      const storyNodes = story?.nodes && typeof story.nodes === 'object' ? Object.keys(story.nodes).length : 0
      // 图像完整度：story 场景中带 visuals.backgroundAssetId 真实图像引用的比例
      const storySceneNodes = Array.isArray(story?.nodes) ? story.nodes : Object.values(story?.nodes || {})
      const totalScenes = storySceneNodes.length
      const withImages = storySceneNodes.filter((n) => {
        const bgId = n?.visuals?.backgroundAssetId
        if (typeof bgId === 'string' && bgId.trim()) return true
        const bg = n?.visuals?.background ?? n?.background
        if (!bg) return false
        if (typeof bg === 'string') return bg.trim().length > 0
        if (typeof bg === 'object') return Boolean(bg.uri || bg.src || bg.url || bg.path)
        return false
      }).length
      const imageStats = {
        totalScenes,
        withImages,
        missingImages: Math.max(0, totalScenes - withImages)
      }
      // 2026-10-20 首页画廊封面，优先级：①名称/路径含「封面」或 cover（不区分大小写）的专用封面资产
      // ②首个可解析场景背景图（visuals.backgroundAssetId → assets[].uri；兜底 visuals.background 对象）③ null（前端色卡封面）
      let cover = null
      const projectAssets = Array.isArray(p?.assets) ? p.assets : Array.isArray(p0?.assets) ? p0.assets : []
      for (const a of projectAssets) {
        const uri = String(a?.uri || '').trim()
        if (!uri) continue
        const hay = `${String(a?.name || '')} ${uri}`.toLowerCase()
        if (hay.includes('封面') || hay.includes('cover')) {
          cover = uri
          break
        }
      }
      if (!cover) {
        for (const n of storySceneNodes) {
          const bgId = n?.visuals?.backgroundAssetId
          if (typeof bgId === 'string' && bgId.trim()) {
            const asset = projectAssets.find((a) => String(a?.id || '') === bgId.trim())
            const uri = String(asset?.uri || '').trim()
            if (uri) {
              cover = uri
              break
            }
          }
          const bg = n?.visuals?.background ?? n?.background
          if (bg && typeof bg === 'object') {
            const uri = String(bg.uri || bg.src || bg.url || bg.path || '').trim()
            if (uri) {
              cover = uri
              break
            }
          }
        }
      }
      // 卡片朝向跟随故事横/竖模式（2026-10-20 第二波）：取自 project.json stage
      const stageCfg = p?.stage && typeof p.stage === 'object' ? p.stage : null
      const stageConfig = stageCfg
        ? {
            orientation: stageCfg.orientation === 'landscape' || stageCfg.orientation === 'portrait' ? stageCfg.orientation : null,
            width: Number(stageCfg.width) > 0 ? Number(stageCfg.width) : null,
            height: Number(stageCfg.height) > 0 ? Number(stageCfg.height) : null
          }
        : null
      const distPath = path.join(dir, 'builds', 'latest', 'dist', 'index.html')
      const distExists = await ctx.existsFile(distPath)
      const stages = {
        scripts: cards > 0,
        blueprint: blueprintNodes > 0,
        compose: storyNodes > 2,
        export: distExists
      }
      const stage = ctx.deriveProjectStage({ cards, blueprintNodes, storyNodes, distExists })
      const meta = await ctx.readJson(path.join(dir, 'meta.json')).catch(() => null)
      items.push({
        id: p.id || id,
        title: p.title || '',
        updatedAt: p.updatedAt || '',
        createdAt: p.createdAt || '',
        cards,
        blueprintNodes,
        storyNodes,
        imageStats,
        stages,
        stage,
        aiDraftStatus: String(meta?.aiDraftStatus || 'confirmed'),
        distUrl: distExists ? `/demos/${p.id || id}/latest/dist/index.html` : null,
        cover,
        stageConfig
      })
    } catch (_) {}
  }
  items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  return c.json({ success: true, items })
})

app.post('/api/projects/:id/confirm-draft', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const meta = await ctx.readJson(path.join(dir, 'meta.json')).catch(() => ({}))
  await ctx.writeJson(path.join(dir, 'meta.json'), { ...meta, aiDraftStatus: 'confirmed', confirmedAt: ctx.nowIso() })
  return c.json({ success: true, projectId: id })
})

app.post('/api/projects', storyInputGate('story.project.create'), async (c) => {
  await ctx.ensureDirs()
  const body = await c.req.json().catch(() => ({}))
  const title = String(body?.title || '').trim() || '未命名故事'
  const id = crypto.randomUUID ? crypto.randomUUID() : `p_${Math.random().toString(36).slice(2, 10)}`
  const dir = ctx.projectDir(id)
  await mkdir(path.join(dir, 'assets'), { recursive: true })
  const project = normalizeProjectDoc({
    schemaVersion: '2.0',
    id,
    title,
    pluginId: 'story-pixi',
    pluginVersion: '0.1.0',
    createdAt: ctx.nowIso(),
    updatedAt: ctx.nowIso(),
    characters: [],
    assets: [],
    events: [],
    state: { vars: [] }
  })
  await ctx.writeJson(path.join(dir, 'project.json'), project)
  await ctx.writeJson(path.join(dir, 'story.json'), ctx.defaultStory())

  // 三层工作流：脚本层/蓝图层默认文件（P0）
  await ctx.writeJson(path.join(dir, 'meta.json'), ctx.defaultMeta({ id, title }))
  await ctx.writeJson(path.join(dir, 'scripts.json'), ctx.defaultScripts())
  await ctx.writeJson(path.join(dir, 'blueprint.json'), ctx.defaultBlueprint())

  return c.json({ success: true, project })
})

// AI: Create new project + scripts from prompt (P0: scripts layer only)
// 支持两种模式：
// - 独立编辑器模式：使用 TalkScene Settings 中的 provider/model/apiUrl
// - 守护台受控模式：使用 Control 签发的 modelExecution（含 provider/model/apiUrl/leaseId），
//   此时必须携带有效 leaseId，否则拒绝执行
app.post('/api/projects/ai/create', storyInputGate('story.project.create'), async (c) => {
  await ctx.ensureDirs()
  const body = await c.req.json().catch(() => ({}))
  const prompt = String(body?.prompt || '').trim()
  if (!prompt) return c.json({ success: false, error: 'missing_prompt', message: 'prompt 不能为空' }, 400)

  // 受控模式判定：请求中携带 modelExecution 时进入守护台受控模式
  const modelExecution = body?.modelExecution && typeof body.modelExecution === 'object' ? body.modelExecution : null
  const isControlledMode = Boolean(modelExecution)
  if (isControlledMode) {
    const leaseId = String(modelExecution?.leaseId || '').trim()
    if (!leaseId) {
      return c.json({ success: false, error: 'missing_lease_id', message: '受控模式必须携带有效 leaseId' }, 403)
    }
    // TODO: 校验 leaseId 有效性（与 Control 资源调度器核对）
  }

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.scripts) {
    return c.json({ success: false, error: 'disabled', message: '“写故事（脚本生成）”已在设置中关闭' }, 503)
  }

  const titleIn = String(body?.title || '').trim()
  const formula = ctx.normalizeAiStoryFormula(body)
  const id = crypto.randomUUID ? crypto.randomUUID() : `p_${Math.random().toString(36).slice(2, 10)}`
  const dir = ctx.projectDir(id)

  const startedAt = Date.now()
  // 调用方传入的预算生效（Control 长脚本给 300s），缺省仍为 90s
  const aiTimeoutMs = ctx.clampInt(body?.timeoutMs, 90_000, 300_000, 90_000)

  // 模型路由：受控模式使用 modelExecution，独立模式使用 Studio Settings
  const requestedProvider = isControlledMode
    ? String(modelExecution?.provider || '').toLowerCase()
    : String(studio.effective.scripts.provider || 'local').toLowerCase()
  const requestedModel = isControlledMode
    ? (modelExecution?.model || null)
    : (studio.effective.scripts.model || null)
  const requestedApiUrl = isControlledMode
    ? (modelExecution?.apiUrl || undefined)
    : (studio.effective.scripts.apiUrl || undefined)

  if (!requestedProvider || requestedProvider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“写故事脚本”并选择 Provider/Model' }, 400)
  }
  const globalRules = await readGlobalRules(ctx.ROOT)
  try {
    console.log(
      `[talkscene] ai.create:start project=${id} mode=${isControlledMode ? 'controlled' : 'standalone'} requestedProvider=${requestedProvider}${requestedModel ? ` model=${requestedModel}` : ''} promptChars=${prompt.length}${titleIn ? ` titleChars=${titleIn.length}` : ''} choicePoints=${formula.choicePoints} optionsPerChoice=${formula.optionsPerChoice} endings=${formula.endings}`
    )
  } catch (_) {}
  const closed = await ctx.generateClosedScriptDraft({
    prompt,
    title: titleIn || undefined,
    projectTitle: titleIn || undefined,
    rules: globalRules,
    formula,
    provider: requestedProvider,
    model: requestedModel || undefined,
    apiUrl: requestedApiUrl,
    proxyUrl: studio.effective.network.proxyUrl,
    timeoutMs: aiTimeoutMs,
    prevScripts: null,
    prevBlueprint: null
  })
  const title = titleIn || closed.title || guessTitleFromPrompt(prompt)

  if (!closed.ok) {
    const err = closed.meta && closed.meta.error ? closed.meta.error : null
    const durationMs = Math.max(0, Date.now() - startedAt)
    if (!closed.scripts) {
      const status = Number.isFinite(Number(closed.status)) ? Math.max(400, Math.min(599, Number(closed.status))) : 502
      return c.json({
        success: false,
        error: 'ai_generate_failed',
        message: closed.message || (err && err.message ? String(err.message) : 'ai_generate_failed'),
        gen: {
          ok: false,
          requestedProvider,
          provider: closed.meta?.provider || requestedProvider,
          model: closed.meta?.model || null,
          api: closed.meta?.api || null,
          durationMs,
          formula,
          error: err,
          repaired: Boolean(closed.repaired),
          before: closed.before || null,
          after: closed.after || null
        }
      }, status)
    }
    const project = await ctx.writeAiDraftProject({
      dir,
      id,
      title,
      formula,
      scripts: closed.scripts,
      blueprint: closed.blueprint
    })
    return c.json({
      success: true,
      project,
      scripts: closed.scripts,
      blueprint: closed.blueprint || ctx.defaultBlueprint(),
      gen: {
        ok: false,
        message: closed.message || (err && err.message ? String(err.message) : 'ai_generate_failed'),
        requestedProvider,
        provider: closed.meta?.provider || requestedProvider,
        model: closed.meta?.model || null,
        api: closed.meta?.api || null,
        durationMs,
        formula,
        error: err,
        repaired: Boolean(closed.repaired),
        before: closed.before || null,
        after: closed.after || null
      }
    })
  }

  const project = await ctx.writeAiDraftProject({
    dir,
    id,
    title,
    formula,
    scripts: closed.scripts,
    blueprint: closed.blueprint
  })

  const durationMs = Math.max(0, Date.now() - startedAt)
  try {
    console.log(
      `[talkscene] ai.create project=${id} requestedProvider=${requestedProvider} provider=${closed.meta?.provider || requestedProvider} model=${closed.meta?.model || '-'} api=${closed.meta?.api || '-'} repaired=${closed.repaired ? 'true' : 'false'} cards=${Array.isArray(closed.scripts?.cards) ? closed.scripts.cards.length : 0} ms=${durationMs}`
    )
  } catch (_) {}

  return c.json({
    success: true,
    project,
    scripts: closed.scripts,
    blueprint: closed.blueprint,
    gen: {
      ok: true,
      mode: isControlledMode ? 'controlled' : 'standalone',
      leaseId: isControlledMode ? String(modelExecution?.leaseId || '') : undefined,
      requestedProvider,
      provider: closed.meta?.provider || requestedProvider,
      model: closed.meta?.model || null,
      api: closed.meta?.api || null,
      durationMs,
      formula,
      repaired: Boolean(closed.repaired),
      error: closed.meta && closed.meta.error ? closed.meta.error : null,
      before: closed.before || null,
      after: closed.after || null
    }
  })
})

// AI: Regenerate scripts for an existing project (overwrite scripts.json)
app.post('/api/projects/:id/ai/regenerate', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const prompt = String(body?.prompt || '').trim()
  if (!prompt) return c.json({ success: false, error: 'missing_prompt', message: 'prompt 不能为空' }, 400)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.scripts) {
    return c.json({ success: false, error: 'disabled', message: '“写故事（脚本生成）”已在设置中关闭' }, 503)
  }

  const titleIn = String(body?.title || '').trim()
  const formula = ctx.normalizeAiStoryFormula(body)
  const startedAt = Date.now()
  // 调用方传入的预算生效（Control 长脚本给 300s），缺省仍为 90s
  const aiTimeoutMs = ctx.clampInt(body?.timeoutMs, 90_000, 300_000, 90_000)
  const requestedProvider = String(studio.effective.scripts.provider || 'local').toLowerCase()
  const requestedModel = studio.effective.scripts.model || null
  if (!requestedProvider || requestedProvider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“写故事脚本”并选择 Provider/Model' }, 400)
  }
  const globalRules = await readGlobalRules(ctx.ROOT)
  try {
    console.log(
      `[talkscene] ai.regen:start project=${id} requestedProvider=${requestedProvider}${requestedModel ? ` model=${requestedModel}` : ''} promptChars=${prompt.length}${titleIn ? ` titleChars=${titleIn.length}` : ''} choicePoints=${formula.choicePoints} optionsPerChoice=${formula.optionsPerChoice} endings=${formula.endings}`
    )
  } catch (_) {}

  const currProject = normalizeProjectDoc(await ctx.readJson(path.join(dir, 'project.json')))
  let currScripts = null
  try { currScripts = await ctx.readJson(path.join(dir, 'scripts.json')) } catch (_) { currScripts = ctx.defaultScripts() }
  let currBlueprint = null
  try { currBlueprint = await ctx.readJson(path.join(dir, 'blueprint.json')) } catch (_) { currBlueprint = ctx.defaultBlueprint() }

  const closed = await ctx.generateClosedScriptDraft({
    prompt,
    title: titleIn || undefined,
    projectTitle: String(currProject?.title || '').trim() || titleIn || undefined,
    rules: globalRules,
    formula,
    provider: requestedProvider,
    model: requestedModel || undefined,
    apiUrl: studio.effective.scripts.apiUrl || undefined,
    proxyUrl: studio.effective.network.proxyUrl,
    timeoutMs: aiTimeoutMs,
    prevScripts: currScripts,
    prevBlueprint: currBlueprint
  })
  const nextTitle = titleIn || String(currProject?.title || '').trim() || closed.title || guessTitleFromPrompt(prompt)

  if (!closed.ok) {
    const err = closed.meta && closed.meta.error ? closed.meta.error : null
    const durationMs = Math.max(0, Date.now() - startedAt)
    if (!closed.scripts) {
      const status = Number.isFinite(Number(closed.status)) ? Math.max(400, Math.min(599, Number(closed.status))) : 502
      return c.json({
        success: false,
        error: 'ai_generate_failed',
        message: closed.message || (err && err.message ? String(err.message) : 'ai_generate_failed'),
        gen: {
          ok: false,
          requestedProvider,
          provider: closed.meta?.provider || requestedProvider,
          model: closed.meta?.model || null,
          api: closed.meta?.api || null,
          durationMs,
          formula,
          error: err,
          repaired: Boolean(closed.repaired),
          before: closed.before || null,
          after: closed.after || null
        }
      }, status)
    }
    await ctx.writeJson(path.join(dir, 'scripts.json'), closed.scripts)
    await ctx.writeJson(path.join(dir, 'blueprint.json'), closed.blueprint || ctx.defaultBlueprint())
    const failedProject = normalizeProjectDoc({ ...(currProject || {}), id, title: nextTitle, updatedAt: ctx.nowIso() })
    await ctx.writeJson(path.join(dir, 'project.json'), failedProject)
    try {
      const metaPath = path.join(dir, 'meta.json')
      const meta = (await ctx.existsFile(metaPath)) ? await ctx.readJson(metaPath) : null
      await ctx.writeJson(metaPath, { ...(meta && typeof meta === 'object' ? meta : ctx.defaultMeta({ id, title: nextTitle })), id, title: nextTitle, updatedAt: ctx.nowIso(), aiFormula: formula })
    } catch (_) {}
    return c.json({
      success: true,
      project: failedProject,
      scripts: closed.scripts,
      blueprint: closed.blueprint || ctx.defaultBlueprint(),
      gen: {
        ok: false,
        message: closed.message || (err && err.message ? String(err.message) : 'ai_generate_failed'),
        requestedProvider,
        provider: closed.meta?.provider || requestedProvider,
        model: closed.meta?.model || null,
        api: closed.meta?.api || null,
        durationMs,
        formula,
        error: err,
        repaired: Boolean(closed.repaired),
        before: closed.before || null,
        after: closed.after || null
      }
    })
  }
  await ctx.writeJson(path.join(dir, 'scripts.json'), closed.scripts)
  await ctx.writeJson(path.join(dir, 'blueprint.json'), closed.blueprint)

  // keep titles + timestamps in sync
  const nextProject = normalizeProjectDoc({ ...(currProject || {}), id, title: nextTitle, updatedAt: ctx.nowIso() })
  await ctx.writeJson(path.join(dir, 'project.json'), nextProject)
  try {
    const metaPath = path.join(dir, 'meta.json')
    const meta = (await ctx.existsFile(metaPath)) ? await ctx.readJson(metaPath) : null
    if (meta && typeof meta === 'object') {
      await ctx.writeJson(metaPath, { ...meta, id, title: nextTitle, updatedAt: ctx.nowIso(), aiFormula: formula })
    }
  } catch (_) {}

  const durationMs = Math.max(0, Date.now() - startedAt)
  try {
    console.log(
      `[talkscene] ai.regen project=${id} requestedProvider=${requestedProvider} provider=${closed.meta?.provider || requestedProvider} model=${closed.meta?.model || '-'} api=${closed.meta?.api || '-'} repaired=${closed.repaired ? 'true' : 'false'} cards=${Array.isArray(closed.scripts?.cards) ? closed.scripts.cards.length : 0} ms=${durationMs}`
    )
  } catch (_) {}

  return c.json({
    success: true,
    project: nextProject,
    scripts: closed.scripts,
    blueprint: closed.blueprint,
    gen: {
      ok: true,
      requestedProvider,
      provider: closed.meta?.provider || requestedProvider,
      model: closed.meta?.model || null,
      api: closed.meta?.api || null,
      durationMs,
      formula,
      repaired: Boolean(closed.repaired),
      error: closed.meta && closed.meta.error ? closed.meta.error : null,
      before: closed.before || null,
      after: closed.after || null
    }
  })
})

app.post('/api/projects/:id/analyze/scripts', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const scriptsPath = path.join(dir, 'scripts.json')
  if (!(await ctx.existsFile(scriptsPath))) return c.json({ success: false, error: 'missing_scripts' }, 404)
  const scripts = await ctx.readJson(scriptsPath)
  const meta = await ctx.readJson(path.join(dir, 'meta.json')).catch(() => null)
  const analysis = analyzeScriptsForBlueprint(scripts, meta?.aiFormula)

  return c.json({ success: true, analysis })
})

app.post('/api/projects/:id/validate/blueprint', storyInputGate('story.validate.blueprint', (c) => ({ projectId: c.req.param('id') })), async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  let blueprint = null
  try {
    blueprint = await ctx.readJson(path.join(dir, 'blueprint.json'))
  } catch (_) {
    blueprint = ctx.defaultBlueprint()
    await ctx.writeJson(path.join(dir, 'blueprint.json'), blueprint)
  }

  const validation = validateBlueprintDoc(blueprint)
  return c.json({ success: true, validation })
})

// [拆分] POST /api/projects/:id/ai/review/blueprint 已迁至 apps/server/src/routes/review.routes.js
app.post('/api/projects/:id/ai/fix/scripts', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.scripts) {
    return c.json({ success: false, error: 'disabled', message: '“写故事（脚本生成）”已在设置中关闭' }, 503)
  }

  let meta = null
  try { meta = await ctx.readJson(path.join(dir, 'meta.json')) } catch (_) { meta = null }
  let project = null
  try { project = await ctx.readJson(path.join(dir, 'project.json')) } catch (_) { project = null }
  let scripts = null
  try { scripts = await ctx.readJson(path.join(dir, 'scripts.json')) } catch (_) { scripts = ctx.defaultScripts() }
  let currBlueprint = null
  try { currBlueprint = await ctx.readJson(path.join(dir, 'blueprint.json')) } catch (_) { currBlueprint = null }

  const expectedFormula = meta && typeof meta === 'object' ? meta.aiFormula : null
  const compiledBefore = compileBlueprintFromScripts({ scripts, prevBlueprint: currBlueprint, expectedFormula })
  const validationBefore = validateBlueprintDoc(compiledBefore.blueprint)

  const requestedProvider = String(studio.effective.scripts.provider || 'local').toLowerCase()
  const requestedModel = studio.effective.scripts.model || null
  const globalRules = await readGlobalRules(ctx.ROOT)

  const startedAt = Date.now()
  let fixed = null
  try {
    fixed = await repairScriptDraft({
      projectTitle: project && project.title ? String(project.title) : '',
      scripts,
      rules: globalRules,
      formula: expectedFormula,
      report: compiledBefore.report,
      validation: validationBefore,
      provider: requestedProvider,
      model: requestedModel || undefined,
      apiUrl: studio.effective.scripts.apiUrl || undefined,
      proxyUrl: studio.effective.network.proxyUrl
    })
  } catch (e) {
    try {
      const msg = e instanceof Error ? e.message : String(e)
      const cause = (e && typeof e === 'object' && 'cause' in e) ? e.cause : null
      const causeMsg = cause && typeof cause === 'object' && cause.message ? String(cause.message) : (cause ? String(cause) : '')
      const causeCode = cause && typeof cause === 'object' && cause.code ? String(cause.code) : ''
      console.error('[talkscene] ai fix scripts failed:', msg, causeMsg ? `cause=${causeMsg}` : '', causeCode ? `code=${causeCode}` : '')
    } catch (_) {}
    return c.json({ success: false, error: 'ai_failed', message: e instanceof Error ? e.message : String(e) }, 502)
  }

  if (!fixed || typeof fixed !== 'object' || !fixed.draft || typeof fixed.draft !== 'object' || !Array.isArray(fixed.draft.cards)) {
    return c.json({ success: false, error: 'no_ai_provider', message: '当前未启用 AI 修复（provider=local）' }, 501)
  }

  const cardsIn = fixed.draft.cards
  const prevCards = scripts && typeof scripts === 'object' && Array.isArray(scripts.cards) ? scripts.cards : []
  const preserveIds = prevCards.length > 0 && prevCards.length === cardsIn.length
  const cardsOut = cardsIn
    .map((x, i) => {
      const base = preserveIds ? prevCards[i] : null
      const idUse = base && base.id ? String(base.id) : genId('sc')
      const orderUse = base && base.order != null ? Number(base.order) : i + 1
      return {
        id: idUse,
        name: String(x && x.name ? x.name : `场景${i + 1}`),
        order: orderUse || (i + 1),
        text: String(x && x.text ? x.text : ''),
        updatedAt: ctx.nowIso()
      }
    })
    .filter((c) => c.text.trim())

  const nextScripts = { schemaVersion: '1.0', cards: cardsOut, updatedAt: ctx.nowIso() }
  await ctx.writeJson(path.join(dir, 'scripts.json'), nextScripts)

  const compiledAfter = compileBlueprintFromScripts({ scripts: nextScripts, prevBlueprint: currBlueprint, expectedFormula })
  const validationAfter = validateBlueprintDoc(compiledAfter.blueprint)

  await ctx.writeJson(path.join(dir, 'blueprint.json'), compiledAfter.blueprint)
  await ctx.touchProjectUpdatedAt(dir)

  const durationMs = Math.max(0, Date.now() - startedAt)
  try {
    console.log(
      `[talkscene] ai.scripts_fix project=${id} requestedProvider=${requestedProvider}${requestedModel ? ` model=${requestedModel}` : ''} provider=${fixed?.meta?.provider || 'unknown'} model=${fixed?.meta?.model || '-'} api=${fixed?.meta?.api || '-'} okBefore=${validationBefore?.ok ? 'true' : 'false'} okAfter=${validationAfter?.ok ? 'true' : 'false'} cards=${cardsOut.length} ms=${durationMs}`
    )
  } catch (_) {}

  return c.json({
    success: true,
    scripts: nextScripts,
    meta: fixed.meta || { provider: requestedProvider, model: requestedModel, api: null, durationMs },
    before: { report: compiledBefore.report, validation: validationBefore },
    after: { blueprint: compiledAfter.blueprint, report: compiledAfter.report, validation: validationAfter }
  })
})

// [拆分] GET /api/projects/:id/ai/review/blueprint 已迁至 apps/server/src/routes/review.routes.js
app.get('/api/projects/:id', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const p0 = await ctx.readJson(path.join(dir, 'project.json'))
  const { project, changed } = ctx.normalizeProjectAndDetectChanges(p0)
  if (changed) await ctx.writeJson(path.join(dir, 'project.json'), project)
  const story = await ctx.readJson(path.join(dir, 'story.json'))
  return c.json({ success: true, project, story })
})

app.put('/api/projects/:id', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const project = body?.project && typeof body.project === 'object' ? body.project : null
  const story = body?.story && typeof body.story === 'object' ? body.story : null

  const curr0 = await ctx.readJson(path.join(dir, 'project.json'))
  const { project: curr } = ctx.normalizeProjectAndDetectChanges(curr0)
  // 乐观锁（2026-08-31）：所有项目更新必须携带当前 _rev；缺失或版本不符一律拒绝并返回最新文档。
  // 旧内存态整体覆盖服务端状态（提示词/计划被回滚）的根修——与创作缓冲快照互补。
  const currRev = Number(curr && curr._rev) || 0
  const bodyRev = body && body._rev != null ? Number(body._rev) : null
  if (bodyRev == null || bodyRev !== currRev) {
    return c.json({ success: false, error: 'rev_conflict', message: '项目在其他地方已更新，请刷新后重试。', project: curr, _rev: currRev }, 409)
  }
  let mergedProject = project ? { ...curr, ...project, id, updatedAt: ctx.nowIso() } : { ...curr, updatedAt: ctx.nowIso() }
  mergedProject = { ...mergedProject, _rev: currRev + 1 }
  if (project && Array.isArray(project.assets)) {
    const incomingAssets0 = Array.isArray(project.assets) ? project.assets : []
    // 2026-09-12 陈旧 URI 守卫（实测事故：编辑器旧内存把已压缩/已迁移的 .png 旧路径整批回写，
    // 覆盖磁盘上真实存在的 .webp 新路径，assets[] 出现 26 条悬挂引用）。规则：入站 uri 指向
    // assets/ai/ 且文件不存在，而磁盘同 id 资产 uri 文件真实存在时，以磁盘 uri 为准。
    const diskAssetUriById = new Map(
      (Array.isArray(curr.assets) ? curr.assets : []).map((item) => [String(item && item.id || '').trim(), String(item && item.uri || '').trim()])
    )
    const incomingAssets = incomingAssets0.map((item) => {
      if (!item || typeof item !== 'object') return item
      const uri = String(item.uri || '').trim()
      if (!uri.startsWith('assets/ai/')) return item
      if (existsSync(path.join(dir, uri))) return item
      const itemId = String(item.id || '').trim()
      const diskUri = diskAssetUriById.get(itemId) || ''
      if (diskUri && existsSync(path.join(dir, diskUri))) {
        return { ...item, uri: diskUri }
      }
      return item
    })
    const incomingKeys = new Set(incomingAssets.map((item) => `${String(item && item.id || '').trim()}::${ctx.normalizeStoryAssetUri(item && item.uri)}`))
    // 2026-09-01 修复资产重复：入站已有同 id 且 uri 非空的条目时，不再保留磁盘旧条目。
    // 旧逻辑按 id::uri 判重——同 id 换了 uri（如动作立绘覆盖托管立绘）会把旧条目追加回去，
    // 每次保存多一条同 id 副本，project.json 资产数组无限膨胀。
    const incomingIdsWithUri = new Set(
      incomingAssets
        .filter((item) => ctx.normalizeStoryAssetUri(item && item.uri))
        .map((item) => String(item && item.id || '').trim())
    )
    const preservedManagedAssets = Array.isArray(curr.assets)
      ? curr.assets.filter((item) => {
          const uri = ctx.normalizeStoryAssetUri(item && item.uri)
          if (!uri) return false
          const managed = (
            uri.startsWith('assets/ai/story_assets/') ||
            uri.startsWith('assets/ai/story_lineart/') ||
            uri.startsWith('assets/ai/story_lock_tests/')
          )
          if (!managed) return false
          const itemId = String(item && item.id || '').trim()
          if (incomingIdsWithUri.has(itemId)) return false
          const key = `${itemId}::${uri}`
          return !incomingKeys.has(key)
        })
      : []
    // 2026-09-03 引用保护（用户实测数据丢失类根因）：旧会话保存把"它没见过的新资产"从 assets 里顶掉，
    // 摆放引用落空画布变白。凡被当前磁盘真相引用的资产（摆放/角色默认/主参考/计划主参考/姿势变体），
    // 入站缺失时一律保留，不论 uri 前缀。
    const referencedIds = new Set()
    try {
      for (const ch of (Array.isArray(curr.characters) ? curr.characters : [])) {
        const a1 = String(ch && ch.imageAssetId || '').trim()
        const a2 = String(ch && ch.ai && ch.ai.referenceAssetId || '').trim()
        if (a1) referencedIds.add(a1)
        if (a2) referencedIds.add(a2)
      }
      const diskStory = await ctx.readJson(path.join(dir, 'story.json')).catch(() => null)
      for (const n of (diskStory && Array.isArray(diskStory.nodes) ? diskStory.nodes : [])) {
        const pls = Array.isArray(n && n.visuals && n.visuals.placements) ? n.visuals.placements : []
        for (const p of pls) {
          const a1 = String(p && p.imageAssetId || '').trim()
          if (a1) referencedIds.add(a1)
        }
        const bg = String(n && n.visuals && n.visuals.backgroundAssetId || '').trim()
        if (bg) referencedIds.add(bg)
      }
      const curPlan = curr.state && curr.state.aiBackground && curr.state.aiBackground.storyAssetPlan
      for (const pa of (curPlan && Array.isArray(curPlan.assets) ? curPlan.assets : [])) {
        const p1 = String(pa && pa.primaryReferenceAssetId || '').trim()
        if (p1) referencedIds.add(p1)
        for (const v of (pa && Array.isArray(pa.poseVariants) ? pa.poseVariants : [])) {
          const pv = String(v && v.projectAssetId || '').trim()
          if (pv) referencedIds.add(pv)
        }
      }
    } catch (_) { /* 引用扫描失败不阻断保存 */ }
    const preservedReferencedAssets = Array.isArray(curr.assets)
      ? curr.assets.filter((item) => {
          const itemId = String(item && item.id || '').trim()
          if (!itemId || !referencedIds.has(itemId)) return false
          return !incomingIdsWithUri.has(itemId)
        })
      : []
    // 同 id 去重（保留先出现者 = 入站最新版本），清理历史遗留的重复条目
    const seenAssetIds = new Set()
    const dedupedAssets = [...incomingAssets, ...preservedManagedAssets, ...preservedReferencedAssets].filter((item) => {
      const itemId = String(item && item.id || '').trim()
      if (!itemId) return true
      if (seenAssetIds.has(itemId)) return false
      seenAssetIds.add(itemId)
      return true
    })
    mergedProject = {
      ...mergedProject,
      assets: dedupedAssets
    }
  }
  const next0 = mergedProject
  // 2026-09-01 防污染守卫（服务端，以磁盘真相为准）：弱/空的提示词字段不得覆盖磁盘上更完整的值。
  // 背景：编辑器 sbReq 种子链会把占位垃圾（"故事名：《xx》"、"text, watermark…"）反复写回，清空辛苦恢复的提示词。
  try {
    const weak = (v) => {
      const s = String(v || '').trim()
      return !s || /^story title\s*:/i.test(s) || /^故事名：《.*》$/.test(s) || s.length < 80
    }
    // 2026-09-10 占位垃圾清洗（最后防线，配合编辑器断源与存量清洗脚本）：
    // 匹配"故事名：《…》"/"story title: …"模式的值永远不落盘，入站即置空。
    const junkPlaceholder = (v) => {
      const s = String(v || '').trim()
      return !!s && (/^story title\s*:/i.test(s) || /^故事名：《.*》$/.test(s))
    }
    const inAiBg = next0.state && typeof next0.state === 'object' ? next0.state.aiBackground : null
    const curAiBg = curr.state && typeof curr.state === 'object' ? curr.state.aiBackground : null
    if (inAiBg && typeof inAiBg === 'object') {
      for (const k of ['globalPrompt', 'globalNegativePrompt', 'storyboardGlobalPromptZh', 'storyboardGlobalNegativePromptZh']) {
        if (junkPlaceholder(inAiBg[k])) inAiBg[k] = ''
      }
      const inGlobalJunk = typeof inAiBg.global === 'object' && inAiBg.global ? inAiBg.global : null
      if (inGlobalJunk) {
        if (junkPlaceholder(inGlobalJunk.prompt)) inGlobalJunk.prompt = ''
        if (junkPlaceholder(inGlobalJunk.negativePrompt)) inGlobalJunk.negativePrompt = ''
      }
    }
    if (inAiBg && curAiBg && typeof inAiBg === 'object' && typeof curAiBg === 'object') {
      const inGlobal = typeof inAiBg.global === 'object' && inAiBg.global ? inAiBg.global : null
      const curGlobal = typeof curAiBg.global === 'object' && curAiBg.global ? curAiBg.global : null
      // 顶层与嵌套 global.prompt 是双写分裂位（normalize 时嵌套优先），两列都要守；
      // 已初始化的锁定向导允许明确清空英文等待重译，其他空/弱值仍保留磁盘好内容
      const pairs = [
        ['globalPrompt', inAiBg, curAiBg],
        ['globalNegativePrompt', inAiBg, curAiBg],
        ['storyboardGlobalPromptZh', inAiBg, curAiBg],
        ['storyboardGlobalNegativePromptZh', inAiBg, curAiBg],
        ...(inGlobal && curGlobal ? [['prompt', inGlobal, curGlobal], ['negativePrompt', inGlobal, curGlobal]] : [])
      ]
      const globalEnglishKeys = new Set(['globalPrompt', 'globalNegativePrompt', 'prompt', 'negativePrompt'])
      const allowEmptyGlobalEnglish = inAiBg.storyboardGlobalPromptStateReady === true
      for (const [k, inObj, curObj] of pairs) {
        const intentionalEmpty = allowEmptyGlobalEnglish && globalEnglishKeys.has(k) && !String(inObj[k] || '').trim()
        if (!intentionalEmpty && weak(inObj[k]) && !weak(curObj[k])) inObj[k] = curObj[k]
      }

      const inMap = inAiBg.storyboardLockAssetPrompts
      const curMap = curAiBg.storyboardLockAssetPrompts
      if (curMap && typeof curMap === 'object') {
        if (!inMap || typeof inMap !== 'object' || Object.keys(inMap).length === 0) {
          // 入站整表为空而磁盘有内容：保留磁盘整表
          inAiBg.storyboardLockAssetPrompts = curMap
        } else {
          // 2026-09-01 扩展为并集合并：旧会话内存缺条目（如后加的猪妈妈/工具包）时，整表覆盖会把磁盘条目抹掉。
          // 磁盘条目在入站缺失时保留；入站存在的条目按字段级补齐空值。
          const mergedMap = { ...inMap }
          for (const [aid, entry] of Object.entries(inMap)) {
            const curE = curMap[aid]
            if (!curE || typeof curE !== 'object' || !entry || typeof entry !== 'object') continue
            const filled = { ...entry }
            for (const f of ['promptZh', 'promptEn', 'negativePromptZh', 'negativePrompt']) {
              const iv = String(entry[f] || '').trim()
              const cv = String(curE[f] || '').trim()
              if (!iv && cv) filled[f] = curE[f]
            }
            mergedMap[aid] = filled
          }
          for (const [aid, curE] of Object.entries(curMap)) {
            if (!(aid in mergedMap)) mergedMap[aid] = curE
          }
          inAiBg.storyboardLockAssetPrompts = mergedMap
        }
      }
      // storyboardScenes 同样并集合并：旧会话缺场景条目时不得抹掉磁盘上已写好的场景提示词
      const inScenes = inAiBg.storyboardScenes
      const curScenes = curAiBg.storyboardScenes
      if (curScenes && typeof curScenes === 'object') {
        if (!inScenes || typeof inScenes !== 'object' || Object.keys(inScenes).length === 0) {
          inAiBg.storyboardScenes = curScenes
        } else {
          const mergedScenes = { ...inScenes }
          for (const [nid, entry] of Object.entries(inScenes)) {
            const curE = curScenes[nid]
            if (!curE || typeof curE !== 'object' || !entry || typeof entry !== 'object') continue
            const filled = { ...entry }
            for (const f of ['prompt', 'promptZh', 'negativePrompt', 'negativePromptZh']) {
              const iv = String(entry[f] || '').trim()
              const cv = String(curE[f] || '').trim()
              if (!iv && cv) filled[f] = curE[f]
            }
            mergedScenes[nid] = filled
          }
          for (const [nid, curE] of Object.entries(curScenes)) {
            if (!(nid in mergedScenes)) mergedScenes[nid] = curE
          }
          inAiBg.storyboardScenes = mergedScenes
        }
      }
      // 2026-09-01 资产计划与确认时间戳同样以磁盘为准：编辑器内存缺值时（整表 delete 语义）不得抹掉磁盘真相。
      // 根因：buildStoryboardLockProjectSnapshot 在内存无值时 delete 这两个字段，浅合并后磁盘字段随之丢失，向导被打回「待确认」。
      if (!inAiBg.storyAssetPlan && curAiBg.storyAssetPlan && typeof curAiBg.storyAssetPlan === 'object') {
        inAiBg.storyAssetPlan = curAiBg.storyAssetPlan
      }
      if (!String(inAiBg.storyAssetPlanConfirmedAt || '').trim() && String(curAiBg.storyAssetPlanConfirmedAt || '').trim()) {
        inAiBg.storyAssetPlanConfirmedAt = curAiBg.storyAssetPlanConfirmedAt
      }
    }
  } catch (_) { /* 守卫失败不阻断保存 */ }
  const next = normalizeProjectDoc(next0)
  // 写前快照（创作缓冲）：PUT 是提示词/文档被覆盖的主要通道，先留快照再写
  await snapshotCreationState(dir, { reason: 'project_put' })
  await ctx.writeJson(path.join(dir, 'project.json'), next)
  if (story) await ctx.writeJson(path.join(dir, 'story.json'), story)
  recordCreationEvent(dir, {
    type: 'project_update',
    summary: `项目文档更新（project${story ? ' + story' : ''}）`,
    actor: 'editor'
  })

  // Keep meta.json title in sync for Hub list display.
  try {
    const title = (project && typeof project.title === 'string') ? String(project.title) : null
    if (title != null) {
      const metaPath = path.join(dir, 'meta.json')
      const meta = (await ctx.existsFile(metaPath)) ? await ctx.readJson(metaPath) : null
      if (meta && typeof meta === 'object') {
        await ctx.writeJson(metaPath, { ...meta, title: String(title), updatedAt: ctx.nowIso() })
      }
    }
  } catch (_) {}

  return c.json({ success: true, project: next })
})

app.delete('/api/projects/:id', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  try {
    await rm(dir, { recursive: true, force: true })
  } catch (e) {
    return c.json({ success: false, error: 'delete_failed', message: e && e.message ? e.message : String(e) }, 500)
  }

  // best-effort: remove exported builds for project
  try {
    await rm(ctx.projectBuildsDir(id), { recursive: true, force: true })
  } catch (_) {}

  return c.json({ success: true })
})




// ===== 三层工作流：脚本层 / 蓝图层（P0） =====

app.get('/api/projects/:id/scripts', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const pth = path.join(dir, 'scripts.json')
  let scripts = null
  try {
    scripts = await ctx.readJson(pth)
  } catch (_) {
    scripts = ctx.defaultScripts()
    await ctx.writeJson(pth, scripts)
  }

  return c.json({ success: true, scripts })
})

app.put('/api/projects/:id/scripts', storyInputGate('story.scripts.write', (c, body) => ({ projectId: c.req.param('id'), scripts: body?.scripts })), async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const next = body && typeof body === 'object' && body.scripts && typeof body.scripts === 'object' ? body.scripts : body

  const cardsIn = Array.isArray(next && next.cards) ? next.cards : []
  const cards = cardsIn.map((x, i) => ({
    id: String(x && x.id || ''),
    name: String(x && x.name || `脚本${i + 1}`),
    order: Number.isFinite(Number(x && x.order)) ? Number(x.order) : (i + 1),
    text: String(x && x.text || ''),
    updatedAt: String(x && x.updatedAt || ctx.nowIso())
  })).filter((c) => c.id)

  const scripts = {
    schemaVersion: '1.0',
    cards,
    updatedAt: ctx.nowIso()
  }

  await ctx.writeJson(path.join(dir, 'scripts.json'), scripts)
  await ctx.touchProjectUpdatedAt(dir)
  return c.json({ success: true, scripts })
})

app.get('/api/projects/:id/blueprint', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const pth = path.join(dir, 'blueprint.json')
  let blueprint = null
  try {
    blueprint = await ctx.readJson(pth)
  } catch (_) {
    blueprint = ctx.defaultBlueprint()
    await ctx.writeJson(pth, blueprint)
  }

  return c.json({ success: true, blueprint })
})

app.put('/api/projects/:id/blueprint', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const next = body && typeof body === 'object' && body.blueprint && typeof body.blueprint === 'object' ? body.blueprint : body

  const placeholdersIn = Array.isArray(next && next.placeholders) ? next.placeholders : []
  const nodesIn = Array.isArray(next && next.nodes) ? next.nodes : []

  const placeholders = placeholdersIn.map((p) => ({
    id: String(p && p.id || ''),
    kind: String(p && p.kind || ''),
    name: String(p && p.name || ''),
    tags: Array.isArray(p && p.tags) ? p.tags.map((t) => String(t)) : []
  })).filter((p) => p.id)

  const nodes = nodesIn.map((n) => ({
    id: String(n && n.id || ''),
    scriptCardId: String(n && n.scriptCardId || ''),
    name: String(n && n.name || ''),
    kind: String(n && n.kind || 'scene'),
    textDraft: (n && typeof n.textDraft === 'string') ? n.textDraft : '',
    backgroundId: n && n.backgroundId ? String(n.backgroundId) : undefined,
    actorIds: Array.isArray(n && n.actorIds) ? n.actorIds.map((x) => String(x)) : [],
    eventIds: Array.isArray(n && n.eventIds) ? n.eventIds.map((x) => String(x)) : [],
    choices: Array.isArray(n && n.choices) ? n.choices.map((c) => ({
      id: String(c && c.id || ''),
      text: String(c && c.text || ''),
      toNodeId: String(c && c.toNodeId || '')
    })) : []
  })).filter((n) => n.id)

  const blueprint = {
    schemaVersion: '1.0',
    startNodeId: String(next && next.startNodeId || ''),
    placeholders,
    nodes,
    updatedAt: ctx.nowIso()
  }

  await ctx.writeJson(path.join(dir, 'blueprint.json'), blueprint)
  await ctx.touchProjectUpdatedAt(dir)
  return c.json({ success: true, blueprint })
})

// Script → Blueprint（P0：merge/update）
app.post('/api/projects/:id/compile/blueprint', storyInputGate('story.blueprint.compile', (c) => ({ projectId: c.req.param('id') })), async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  let currBlueprint = null
  try {
    currBlueprint = await ctx.readJson(path.join(dir, 'blueprint.json'))
  } catch (_) {
    currBlueprint = null
  }

  let meta = null
  try {
    meta = await ctx.readJson(path.join(dir, 'meta.json'))
  } catch (_) {
    meta = null
  }

  let scripts = null
  try {
    scripts = await ctx.readJson(path.join(dir, 'scripts.json'))
  } catch (_) {
    scripts = ctx.defaultScripts()
    await ctx.writeJson(path.join(dir, 'scripts.json'), scripts)
  }

  const expectedFormula = meta && typeof meta === 'object' ? meta.aiFormula : null
  const compiled = compileBlueprintFromScripts({ scripts, prevBlueprint: currBlueprint, expectedFormula })
  const blueprint = compiled.blueprint
  const validation = validateBlueprintDoc(blueprint)

  await ctx.writeJson(path.join(dir, 'blueprint.json'), blueprint)
  await ctx.touchProjectUpdatedAt(dir)
  return c.json({ success: true, blueprint, report: compiled.report, validation })
})

// Blueprint → Compose（P0：overwrite/reset）
app.post('/api/projects/:id/compile/compose', storyInputGate('story.compose.compile', (c) => ({ projectId: c.req.param('id') })), async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  let currProject = null
  try {
    currProject = await ctx.readJson(path.join(dir, 'project.json'))
  } catch (_) {
    currProject = null
  }

  let currStory = null
  try {
    currStory = await ctx.readJson(path.join(dir, 'story.json'))
  } catch (_) {
    currStory = null
  }

  let blueprint = null
  try {
    blueprint = await ctx.readJson(path.join(dir, 'blueprint.json'))
  } catch (_) {
    blueprint = ctx.defaultBlueprint()
    await ctx.writeJson(path.join(dir, 'blueprint.json'), blueprint)
  }

  const placeholders = Array.isArray(blueprint && blueprint.placeholders) ? blueprint.placeholders : []
  const nodes = Array.isArray(blueprint && blueprint.nodes) ? blueprint.nodes : []
  const startNodeId = String(blueprint && blueprint.startNodeId || '')
  if (!startNodeId) return c.json({ success: false, error: 'missing_startNodeId', message: 'blueprint.startNodeId 为空' }, 400)

  const actorPlaceholders = placeholders.filter((p) => String(p && p.kind) === 'actor')
  const bgPlaceholders = placeholders.filter((p) => String(p && p.kind) === 'background')

  const existingCharacters = Array.isArray(currProject && currProject.characters) ? currProject.characters : []
  const existingCharacterById = new Map(existingCharacters.map((x) => [String(x && x.id || ''), x]).filter(([id]) => id))

  const placeholderCharacters = actorPlaceholders
    .map((p) => ({ id: String(p && p.id || ''), name: String(p && p.name || '') }))
    .filter((c) => c.id)

  const characters = placeholderCharacters.map((c) => {
    const prev = existingCharacterById.get(c.id) || null
    if (!prev) return c
    return { ...prev, id: c.id, name: (prev.name ? String(prev.name) : c.name) }
  })

  const existingAssets = Array.isArray(currProject && currProject.assets) ? currProject.assets : []
  const existingAssetById = new Map(existingAssets.map((x) => [String(x && x.id || ''), x]).filter(([id]) => id))

  const placeholderAssets = bgPlaceholders
    .map((p) => ({ id: String(p && p.id || ''), kind: 'image', name: String(p && p.name || ''), uri: '' }))
    .filter((a) => a.id)

  const assets = placeholderAssets.map((a) => {
    const prev = existingAssetById.get(a.id) || null
    if (!prev) return a
    return { ...a, ...prev, id: a.id, kind: 'image', name: (prev.name ? String(prev.name) : a.name) }
  })

  const existingStoryNodes = Array.isArray(currStory && currStory.nodes) ? currStory.nodes : []
  const existingNodeById = new Map(existingStoryNodes.map((x) => [String(x && x.id || ''), x]).filter(([id]) => id))

  const storyNodes = nodes
    .map((n) => {
      const nodeId = String(n && n.id || '')
      const kind = String(n && n.kind || 'scene')
      const choices = Array.isArray(n && n.choices) ? n.choices.map((c) => ({
        id: String(c && c.id || ''),
        text: String(c && c.text || ''),
        toNodeId: String(c && c.toNodeId || ''),
        effects: [],
        visibleWhen: null,
        enabledWhen: null
      })) : []

      const actorIds = Array.isArray(n && n.actorIds) ? n.actorIds.map((x) => String(x)) : []
      const desiredActorIds = actorIds.filter(Boolean)

      const defaultPlacements = desiredActorIds.map((actorId) => ({
        id: `pl_${nodeId}_${actorId}`,
        characterId: actorId,
        transform: { x: 0.5, y: 1, scale: 1, rotationDeg: 0 },
        visible: true,
        zIndex: 0
      }))

      const visuals = { placements: defaultPlacements }
      if (n && n.backgroundId) visuals.backgroundAssetId = String(n.backgroundId)

      const textDraft = String(n && n.textDraft || '')
      const isEnding = kind === 'ending'
      // 2026-09-27 结局卡文本层清理：title 取正文首行（如"空桶叹息"/"满载而归"），moral 不再重复该首行标题；
      // 正文不足两行时 title 回退节点名、moral 取全文
      const endingLines = isEnding ? textDraft.split('\n').map((ln) => ln.trim()).filter(Boolean) : []
      const endingTitle = endingLines.length > 1 ? endingLines[0] : ''
      const endingMoral = (endingTitle ? endingLines.slice(1).join('\n').trim() : textDraft.trim()) || '故事结束。'
      const timeline = {
        steps: [
          isEnding
            ? {
                id: `st_${nodeId}_1`,
                actions: [
                  {
                    type: 'ui.showEndingCard',
                    card: {
                      title: endingTitle || String(n && n.name || nodeId),
                      bullets: [],
                      moral: endingMoral,
                      buttons: [
                        { type: 'restart', label: '重新开始' },
                        { type: 'backToHub', label: '返回工作台' }
                      ]
                    }
                  }
                ],
                advance: { type: 'end' }
              }
            : {
                id: `st_${nodeId}_1`,
                actions: [{ type: 'ui.setText', mode: 'replace', text: textDraft }],
                advance: { type: choices.length ? 'choice' : 'click' }
              }
        ]
      }

      const out = {
        id: nodeId,
        name: String(n && n.name || nodeId),
        kind: (kind === 'ending' ? 'ending' : 'scene'),
        body: { text: textDraft },
        timeline,
        visuals,
        // 预留：P0 只做占位记录，P1 可用于事件执行
        blueprint: {
          scriptCardId: String(n && n.scriptCardId || ''),
          backgroundId: n && n.backgroundId ? String(n.backgroundId) : undefined,
          actorIds,
          eventIds: Array.isArray(n && n.eventIds) ? n.eventIds.map((x) => String(x)) : []
        }
      }
      if (kind !== 'ending') out.choices = choices

      const prev = existingNodeById.get(nodeId) || null
      if (!prev || typeof prev !== 'object') return out

      // Merge policy:
      // - Structure (kind/id/choices targets) from blueprint
      // - Presentation (timeline/visuals/body text) keep existing when present
      const prevBody = (prev && typeof prev.body === 'object' && prev.body) ? prev.body : null
      const prevText = prevBody && typeof prevBody.text === 'string' ? prevBody.text : ''
      const mergedBody = {
        ...out.body,
        ...(prevBody || {}),
        text: prevText && prevText.trim() ? prevText : out.body.text
      }

      const prevVisuals = (prev && typeof prev.visuals === 'object' && prev.visuals) ? prev.visuals : null
      const prevTimeline = (prev && typeof prev.timeline === 'object' && prev.timeline) ? prev.timeline : null

      const mergedVisuals = prevVisuals ? { ...out.visuals, ...prevVisuals } : out.visuals

      // Ensure placements reflect desired actor ids (keep existing transforms when possible)
      // 2026-09-08 事故修复：分层合成工艺后 placements 是人工/工具编排的产物（道具层 characterId 为空、
      // 角色层 imageAssetId 指向姿势变体）。原逻辑用 blueprint.actorIds 重建摆位：actorIds 为空时
      // nextPlacements=[] 清空全部摆位；prop 摆位（characterId=''）被 prevByActor 的 truthy 过滤丢弃。
      // 新策略：prev 已有摆位则保留——desiredActorIds 非空时仅剔除「不再出场且仍指向角色默认图」的条目、
      // 为新增 actor 补默认摆位；actorIds 为空时 prev 摆位原样保留（结构归 blueprint，呈现归既有 story）。
      try {
        const prevPlacements = Array.isArray(prevVisuals && prevVisuals.placements) ? prevVisuals.placements : []
        if (prevPlacements.length && desiredActorIds.length === 0) {
          mergedVisuals.placements = prevPlacements
        } else if (prevPlacements.length) {
          const desired = new Set(desiredActorIds)
          const kept = prevPlacements.filter((p) => {
            const cid = String(p && p.characterId || '')
            if (!cid) return true // 道具层永远保留
            if (desired.has(cid)) return true
            // 蓝图移除该角色时，仅当摆位仍指角色默认图（未绑姿势变体）才剔除；绑了姿势变体的视为人工编排，保留
            return Boolean(String(p && p.imageAssetId || '').trim())
          })
          const existingActorIds = new Set(kept.map((p) => String(p && p.characterId || '')).filter(Boolean))
          for (const actorId of desiredActorIds) {
            if (existingActorIds.has(actorId)) continue
            kept.push({
              id: `pl_${nodeId}_${actorId}`,
              characterId: actorId,
              transform: { x: 0.5, y: 1, scale: 1, rotationDeg: 0 },
              visible: true,
              zIndex: 0
            })
          }
          mergedVisuals.placements = kept
        } else {
          mergedVisuals.placements = desiredActorIds.map((actorId) => ({
            id: `pl_${nodeId}_${actorId}`,
            characterId: actorId,
            transform: { x: 0.5, y: 1, scale: 1, rotationDeg: 0 },
            visible: true,
            zIndex: 0
          }))
        }
      } catch (_) {}

      // Background: keep existing if set, else use blueprint backgroundId
      try {
        if (prevVisuals && prevVisuals.backgroundAssetId) mergedVisuals.backgroundAssetId = String(prevVisuals.backgroundAssetId)
      } catch (_) {}

      // Choices: keep existing effects/conditions when ids match; but enforce graph targets/text from blueprint
      let mergedChoices = out.choices
      if (out.kind === 'scene') {
        const prevChoices = Array.isArray(prev && prev.choices) ? prev.choices : []
        const prevById = new Map(prevChoices.map((c) => [String(c && c.id || ''), c]).filter(([id]) => id))
        mergedChoices = (out.choices || []).map((c) => {
          const keep = prevById.get(c.id) || null
          if (!keep) return c
          return { ...c, ...keep, id: c.id, text: c.text, toNodeId: c.toNodeId }
        })
      }

      const merged = {
        ...prev,
        ...out,
        name: (prev && prev.name ? String(prev.name) : out.name),
        body: mergedBody,
        visuals: mergedVisuals,
        timeline: prevTimeline || out.timeline,
        blueprint: out.blueprint
      }
      if (merged.kind === 'scene') merged.choices = mergedChoices
      return merged
    })
    .filter((n) => n.id)

  const story = { schemaVersion: '2.0', startNodeId, nodes: storyNodes }

  const nextProject = normalizeProjectDoc({
    schemaVersion: '2.0',
    id: String(id),
    title: String(currProject && currProject.title || ''),
    pluginId: String(currProject && currProject.pluginId || 'story-pixi'),
    pluginVersion: String(currProject && currProject.pluginVersion || ctx.TOOL_VERSION),
    createdAt: String(currProject && currProject.createdAt || ctx.nowIso()),
    updatedAt: ctx.nowIso(),
    characters: (() => {
      const ids = new Set(characters.map((c) => String(c && c.id || '')).filter(Boolean))
      const rest = existingCharacters.filter((c) => c && c.id && !ids.has(String(c.id)))
      return [...characters, ...rest]
    })(),
    assets: (() => {
      const ids = new Set(assets.map((a) => String(a && a.id || '')).filter(Boolean))
      const rest = existingAssets.filter((a) => a && a.id && !ids.has(String(a.id)))
      return [...assets, ...rest]
    })(),
    events: Array.isArray(currProject && currProject.events) ? currProject.events : [],
    state: (currProject && typeof currProject.state === 'object' && currProject.state) ? currProject.state : { vars: [] },
    stage: (currProject && typeof currProject.stage === 'object' && currProject.stage) ? currProject.stage : undefined
  })

  await ctx.writeJson(path.join(dir, 'project.json'), nextProject)
  await ctx.writeJson(path.join(dir, 'story.json'), story)
  await ctx.touchProjectUpdatedAt(dir)

  return c.json({ success: true, project: nextProject, story })
})
app.post('/api/projects/:id/ai/story/bible', storyInputGate('story.bible.generate', (c, body) => ({ projectId: c.req.param('id'), ...body })), async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const input = body && typeof body === 'object' ? body.input : null
  if (!input || typeof input !== 'object') return c.json({ success: false, error: 'missing_input' }, 400)

  const timeoutRaw = Number(body?.timeoutMs)
  const timeoutMs = (Number.isFinite(timeoutRaw) && timeoutRaw <= 0)
    ? 0
    : ctx.clampInt(
        body?.timeoutMs,
        5_000,
        600_000,
        ctx.clampInt(process.env.STUDIO_PROMPT_TIMEOUT_MS, 5_000, 600_000, 90_000)
      )

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.prompt) {
    return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)
  }
  if (!studio.effective.prompt.provider || studio.effective.prompt.provider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“提示词生成”并选择 Provider/Model' }, 400)
  }

  const startedAt = Date.now()
  const traceId = createTraceId()
  logStage({
    stage: 'story.bible',
    event: 'start',
    traceId,
    project: id,
    provider: studio.effective.prompt.provider || 'localoxml',
    model: studio.effective.prompt.model || '-'
  })
  try {
    // draftModel：本地小模型起草（8K 内存机实测 27B 单次大结构生成 12 分钟仍空输出），
    // 质量由下游 27B 评审/修复环节兜底（用户确认的"小模型执行、27B 验证"单链设计）
    const draftModel = String(body?.draftModel || '').trim()
    const { result, meta } = await generateStoryBible({
      provider: studio.effective.prompt.provider,
      model: draftModel || studio.effective.prompt.model,
      apiUrl: studio.effective.prompt.apiUrl,
      proxyUrl: studio.effective.network.proxyUrl,
      timeoutMs,
      input
    })
    logStage({
      stage: 'story.bible',
      event: 'ok',
      traceId,
      project: id,
      provider: meta && meta.provider ? meta.provider : studio.effective.prompt.provider || 'localoxml',
      model: meta && meta.model ? meta.model : studio.effective.prompt.model || '-',
      ok: true,
      durationMs: Math.max(0, Date.now() - startedAt)
    })
    // Persist Story Bible into project document
    try {
      const projectPath = path.join(dir, 'project.json')
      const projectDoc = await ctx.readJson(projectPath).catch(() => ({}))
      if (!projectDoc.state || typeof projectDoc.state !== 'object') {
        projectDoc.state = {}
      }
      if (!projectDoc.state.aiBackground || typeof projectDoc.state.aiBackground !== 'object') {
        projectDoc.state.aiBackground = {}
      }
      projectDoc.state.aiBackground.storyBible = result
      projectDoc.state.aiBackground.storyBibleJson = JSON.stringify(result)
      // 新故事必须干净开始：清空可能携带旧故事提示词的草稿/镜像字段
      for (const staleKey of [
        'storyboardGlobalPromptZh', 'storyboardGlobalNegativePromptZh',
        'storyboardLockAssetPrompts', 'storyboardScenes', 'storyboardBatchDraft',
        'storyboardPromptMeta', 'storyAssetPlan', 'storyAssetPlanConfirmedAt',
        'globalPrompt', 'globalNegativePrompt'
      ]) {
        delete projectDoc.state.aiBackground[staleKey]
      }
      projectDoc.updatedAt = ctx.nowIso()
      projectDoc._rev = Number(projectDoc._rev || 0) + 1
      await ctx.writeJson(projectPath, projectDoc)
      // 新 bible 生成后旧资产计划作废（避免按 id 合并旧故事的锁定状态与提示词）
      await rm(ctx.projectStoryAssetsPlanPath(id), { force: true }).catch(() => {})
      // Update meta.json timestamp
      const metaPath = path.join(dir, 'meta.json')
      const metaDoc = await ctx.readJson(metaPath).catch(() => ({}))
      metaDoc.updatedAt = ctx.nowIso()
      await ctx.writeJson(metaPath, metaDoc)
    } catch (persistErr) {
      console.error('[story.bible][PERSIST_ERROR]', persistErr && persistErr.message ? persistErr.message : String(persistErr))
    }
    return c.json({ success: true, result, meta, traceId })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    const debugOutput =
      process.env.NODE_ENV !== 'production' && e && typeof e === 'object' && 'output' in e
        ? String(e.output || '').slice(0, 8000)
        : ''
    logStage({
      stage: 'story.bible',
      event: 'fail',
      traceId,
      project: id,
      provider: studio.effective.prompt.provider || 'localoxml',
      model: studio.effective.prompt.model || '-',
      status: mapped.httpStatus,
      ok: false,
      durationMs: Math.max(0, Date.now() - startedAt),
      err: msg
    })
    return c.json(
      {
        success: false,
        error: mapped.code,
        message: msg,
        traceId,
        ...(debugOutput ? { debugOutput } : {})
      },
      mapped.httpStatus
    )
  }
})

app.post('/api/projects/:id/ai/story/bible/qc', async (c) => {
  await ctx.ensureDirs()
  const id = c.req.param('id')
  const dir = ctx.projectDir(id)
  if (!(await ctx.existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.prompt) return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)
  if (!studio.effective.prompt.provider || studio.effective.prompt.provider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“提示词生成”并选择 Provider/Model' }, 400)
  }

  const bundle = await ctx.readProjectBundle(id)
  const bible = ctx.readStoryBibleFromProjectDoc(bundle.project)
  if (!bible || typeof bible !== 'object') return c.json({ success: false, error: 'missing_story_bible', message: '请先生成 Story Bible。' }, 400)
  const storyNodes = (Array.isArray(bundle.story?.nodes) ? bundle.story.nodes : []).filter((n) => ['scene', 'ending'].includes(String(n && n.kind || '')))
  if (!storyNodes.length) return c.json({ success: false, error: 'missing_story', message: '未找到故事场景节点。' }, 400)

  const traceId = createTraceId()
  const task = createAiTask(id, 'story.bible.qc', { total: storyNodes.length, message: '圣经质检：逐场景核对绑定' })
  logStage({ stage: 'story.bible.qc', event: 'start', traceId, project: id, item: `scenes:${storyNodes.length}` })

  try {
    const refsMap = normalizeSceneRefs(bible)
    const entities = {
      characters: (Array.isArray(bible.characters) ? bible.characters : []).map((x) => ({ id: String(x?.id || '').trim(), name: String(x?.name || '').trim(), aliases: x?.aliases })).filter((x) => x.id),
      props: (Array.isArray(bible.props) ? bible.props : []).map((x) => ({ id: String(x?.id || '').trim(), name: String(x?.name || '').trim(), aliases: x?.aliases })).filter((x) => x.id),
      locations: (Array.isArray(bible.locations) ? bible.locations : []).map((x) => ({ id: String(x?.id || '').trim(), name: String(x?.name || '').trim(), aliases: x?.aliases })).filter((x) => x.id)
    }
    const scenesInput = storyNodes.map((node, index) => {
      const hit = matchSceneRef(refsMap, node, index)
      return {
        sceneId: String(node.id || '').trim(),
        sceneName: String(node.name || node.body?.title || '').trim(),
        summary: String(node.body?.text || '').trim().slice(0, 400),
        bound: hit && hit.value ? hit.value : { characters: [], props: [], locations: [] }
      }
    })

    const deterministicIssues = qcSceneRefsDeterministic({ scenes: scenesInput, entities })
    const timeoutMs = ctx.clampInt(body?.timeoutMs, 10_000, 600_000, 120_000)
    const { scenes: fixedScenes } = await qcStoryBibleSceneRefsWithAi({
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model,
      apiUrl: studio.effective.prompt.apiUrl,
      proxyUrl: studio.effective.network.proxyUrl,
      timeoutMs,
      input: { storyTitle: String(bundle.project?.title || '').trim(), entities, scenes: scenesInput },
      onProgress: (i, total, sid) => updateAiTask(task.taskId, { stage: 'reviewing', current: i + 1, message: `质检场景 ${i + 1}/${total}：${sid}` })
    })

    // 差异报告：逐场景 added/removed
    const report = []
    const fixedRefs = {}
    for (const fix of fixedScenes) {
      const before = (scenesInput.find((s) => s.sceneId === fix.sceneId) || {}).bound || { characters: [], props: [], locations: [] }
      const diff = (a, b) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) })
      const dChars = diff(before.characters || [], fix.characters)
      const dProps = diff(before.props || [], fix.props)
      const dLocs = diff(before.locations || [], fix.locations)
      const changed = dChars.added.length + dChars.removed.length + dProps.added.length + dProps.removed.length + dLocs.added.length + dLocs.removed.length > 0
      report.push({ sceneId: fix.sceneId, changed, reason: fix.reason, characters: dChars, props: dProps, locations: dLocs, ...(fix.qcFailed ? { qcFailed: true } : {}) })
      fixedRefs[fix.sceneId] = { characters: fix.characters, props: fix.props, locations: fix.locations }
    }
    const changedCount = report.filter((r) => r.changed).length
    const qcFailedCount = report.filter((r) => r.qcFailed).length

    let persisted = false
    if (body?.persist === true && changedCount > 0) {
      const projectPath = path.join(dir, 'project.json')
      const projectDoc = await ctx.readJson(projectPath)
      const bg = projectDoc.state && typeof projectDoc.state.aiBackground === 'object' ? projectDoc.state.aiBackground : (projectDoc.state = { ...(projectDoc.state || {}) }, projectDoc.state.aiBackground = {})
      const nextBible = { ...bible, sceneRefs: fixedRefs }
      bg.storyBible = nextBible
      bg.storyBibleJson = JSON.stringify(nextBible)
      projectDoc.updatedAt = ctx.nowIso()
      projectDoc._rev = Number(projectDoc._rev || 0) + 1
      await ctx.writeJson(projectPath, projectDoc)
      // 旧资产计划作废：sceneRefs 变了，plan 必须重建（与 bible 重新生成同款语义）
      await rm(ctx.projectStoryAssetsPlanPath(id), { force: true }).catch(() => {})
      persisted = true
    }

    updateAiTask(task.taskId, { stage: 'done', done: true, current: storyNodes.length, message: `质检完成：${changedCount} 场景修正${qcFailedCount ? `，${qcFailedCount} 场景 LLM 复核失败保留原绑定` : ''}${persisted ? '，已回写并作废旧计划' : ''}`, result: { changedCount, qcFailedCount, deterministicIssueCount: deterministicIssues.length, persisted } })
    logStage({ stage: 'story.bible.qc', event: 'ok', traceId, project: id, item: `changed:${changedCount} failed:${qcFailedCount} persisted:${persisted}` })
    return c.json({ success: true, taskId: task.taskId, changedCount, qcFailedCount, deterministicIssues, report, persisted })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    console.error(`[story.bible.qc] project=${id} error=${msg}`)
    updateAiTask(task.taskId, { stage: 'error', done: true, error: msg, message: `圣经质检失败：${msg}` })
    logStage({ stage: 'story.bible.qc', event: 'error', traceId, project: id, item: msg.slice(0, 300) })
    const mapped = classifyAiError(e)
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

// [W1] 剧情姿势提取端点已迁至 routes/storyStates.routes.js

// [W1] 道具状态提取端点已迁至 routes/storyStates.routes.js

// [W1] 剧情状态提取端点已迁至 routes/storyStates.routes.js

// [拆分] POST /api/projects/:id/ai/translate 已迁至 apps/server/src/routes/projectOps.routes.js
}
