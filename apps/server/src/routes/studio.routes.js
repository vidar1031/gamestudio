// ---------------------------------------------------------------------------
// registerStudioRoutes（模块化拆分机械迁出，字义未改；协议层+族内编排，域算法引自 ../ai/*，index 本地辅助经 ctx 注入）
// ---------------------------------------------------------------------------
import path from 'node:path'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rename, stat, writeFile, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import crypto from 'node:crypto'
import { genId, generateScriptDraft, repairScriptDraft } from '../ai/scripts.js'
import { classifyAiError } from '../ai/runtime.js'
import { generateBackgroundImage } from '../ai/background.js'
import { buildStoryAssetReferenceNegativePrompt, buildStoryAssetReferencePrompt, summarizeStoryAssetPlan } from '../ai/storyAssets.js'
import { sniffImageMetaFromBytes } from '../ai/storyAssetReferenceGate.js'
import { translatePromptText } from '../ai/translate.js'
import { getAiStatusSnapshot, runAiDiagnostics } from '../ai/diagnostics.js'
import { readGlobalRules, writeGlobalRules } from '../ai/globalRules.js'
import { deletePromptTemplate, generateStoryPromptTemplate, listPromptTemplates, savePromptTemplate } from '../ai/promptTemplates.js'
import { addPromptLibraryEntry, deletePromptLibraryEntry, listPromptLibraryEntries, updatePromptLibraryEntry } from '../ai/promptLibrary.js'
import { checkComfyuiCapability } from '../ai/comfyuiCapability.js'
import { diagnoseOpenAI, isOpenAICompatibleProvider } from '../ai/openai.js'
import { getDoubaoImagesConfigSnapshot } from '../ai/doubao.js'
import { diagnoseOllamaText } from '../ai/ollama.js'
import { compileBlueprintFromScripts, normalizeScriptCardsForBlueprint } from '../blueprint/compile.js'
import { validateBlueprintDoc } from '../blueprint/validate.js'
import { getEffectiveStudioConfig, readControlLinkSync, redactEffectiveStudioConfigForClient, redactStudioSettingsForClient, writeStudioSettings } from '../studio/settings.js'
import { controlBaseUrl, isResourceLeaseEnabled, registerControlLinkResolver } from '../ai/resourceLease.js'
import { listTtsVoices, saveTtsPreview, synthesizeTts } from '../ai/tts.js'
import { snapshotCreationState } from '../creationBuffer.js'
import { getStudioSecret } from '../studio/secrets.js'

export function registerStudioRoutes(app, ctx) {
// 2026-10-20 守护台关联：租约开关/地址的设置值解析器在装配处注册（ctx.ROOT 可用点）；未注册时回退 env/默认
registerControlLinkResolver(() => readControlLinkSync(ctx.ROOT))
app.get('/api/health', async (c) => c.json({ ok: true, service: 'talkscene_server', buildId: `${ctx.SERVER_BUILD_ID}:${await ctx.editorDistFingerprint()}` }))

app.get('/favicon.ico', (c) => c.body(null, 204))

// 事件层：暴露 TalkScene 事件注册表（apps/server/events/registry.v1.json）
app.get('/api/events/registry', async (c) => {
  try {
    const registryPath = path.join(ctx.__dirname, '..', 'events', 'registry.v1.json')
    const registry = await ctx.readJson(registryPath)
    return c.json({ success: true, registry })
  } catch (e) {
    return c.json({ success: false, error: 'registry_not_available', message: e && e.message ? e.message : String(e) }, 500)
  }
})

// 能力发现：暴露 TalkScene 全部生产能力（apps/server/events/capabilities.v1.json）
app.get('/api/capabilities', async (c) => {
  try {
    const capabilitiesPath = path.join(ctx.__dirname, '..', 'events', 'capabilities.v1.json')
    const capabilities = await ctx.readJson(capabilitiesPath)
    return c.json({ success: true, capabilities })
  } catch (e) {
    return c.json({ success: false, error: 'capabilities_not_available', message: e && e.message ? e.message : String(e) }, 500)
  }
})

// 事件层：运行状态检查（server 是否运行中 + editor 是否可达）
app.get('/api/runtime/status', async (c) => {
  const editorUrl = String(process.env.STUDIO_EDITOR_URL || 'http://localhost:8868').trim()
  const editorOk = await ctx.probeHttpOk(editorUrl, 3000)
  return c.json({
    success: true,
    runtime: {
      server: { ok: true, url: 'http://127.0.0.1:1999', service: 'talkscene_server' },
      editor: { ok: editorOk, url: editorUrl },
      allRunning: editorOk,
      checkedAt: new Date().toISOString()
    }
  })
})

// 事件层：自检配置项（返回各项配置状态清单，不修改任何状态）
app.get('/api/studio/selfcheck', async (c) => {
  const editorUrl = String(process.env.STUDIO_EDITOR_URL || 'http://localhost:8868').trim()
  const checks = []

  checks.push({ key: 'server-health', label: 'Server 健康检查', status: 'ok', detail: 'talkscene_server 响应正常' })

  const editorOk = await ctx.probeHttpOk(editorUrl, 3000)
  checks.push({
    key: 'editor-reachable',
    label: 'Editor 可访问',
    status: editorOk ? 'ok' : 'fail',
    detail: editorOk ? `${editorUrl} 可访问` : `${editorUrl} 不可达`
  })

  const projectsRoot = path.join(ctx.ROOT, 'projects')
  let storageOk = false
  let storageDetail = `${projectsRoot} 不存在`
  try {
    await mkdir(projectsRoot, { recursive: true })
    const probeFile = path.join(projectsRoot, `.selfcheck_${Date.now()}.tmp`)
    await writeFile(probeFile, 'ok')
    await rm(probeFile)
    storageOk = true
    storageDetail = `${projectsRoot} 可读写`
  } catch (e) {
    storageDetail = `${projectsRoot} 不可写: ${e && e.message ? e.message : String(e)}`
  }
  checks.push({ key: 'storage-projects', label: '项目存储目录', status: storageOk ? 'ok' : 'fail', detail: storageDetail })

  let effective = null
  try {
    const cfg = await getEffectiveStudioConfig(ctx.ROOT)
    effective = cfg?.effective || null
  } catch (_) {}
  checks.push({
    key: 'settings-loaded',
    label: '设置加载',
    status: effective ? 'ok' : 'fail',
    detail: effective ? 'studio settings 已加载' : 'studio settings 加载失败'
  })

  const scriptsProvider = String(effective?.scripts?.provider || '').trim()
  const scriptsOk = Boolean(effective?.enabled?.scripts) && scriptsProvider && scriptsProvider !== 'none'
  checks.push({
    key: 'scripts-provider',
    label: '脚本生成 Provider',
    status: scriptsOk ? 'ok' : 'fail',
    detail: scriptsOk ? `${scriptsProvider} / ${effective?.scripts?.model || '-'}` : '未配置或已禁用'
  })

  const imageProvider = String(effective?.image?.provider || '').trim()
  const imageEnabled = Boolean(effective?.enabled?.image)
  const imageOk = imageEnabled && imageProvider && imageProvider !== 'none'
  checks.push({
    key: 'image-provider',
    label: '图片生成 Provider',
    status: imageOk ? 'ok' : (imageEnabled ? 'warn' : 'fail'),
    detail: imageOk ? `${imageProvider} ${effective?.image?.comfyuiBaseUrl || ''}`.trim() : (imageEnabled ? '已启用但未配置 provider' : '未启用')
  })

  const ok = checks.every((item) => item.status !== 'fail')
  return c.json({ success: true, ok, checks, checkedAt: new Date().toISOString() })
})

app.get('/api/ai/status', async (c) => {
  // Non-sensitive snapshot for debugging effective config + last diagnostics.
  const snap = getAiStatusSnapshot()
  return c.json({ success: true, ai: snap })
})

app.post('/api/ai/diagnose', async (c) => {
  const res = await runAiDiagnostics({ force: true }).catch((e) => ({ ok: false, error: { message: e && e.message ? e.message : String(e) } }))
  return c.json({ success: true, diagnostics: res })
})

app.get('/api/ai/models', async (c) => {
  const q = c.req.query()
  const provider = String(process.env.STUDIO_AI_PROVIDER || 'local').toLowerCase()
  const prefix = String(q.prefix || '').trim()
  const contains = String(q.q || '').trim()
  const limit = Math.max(1, Math.min(5000, Number(q.limit || 500)))

  const diag = await runAiDiagnostics({ force: false }).catch(() => null)
  const ids = diag && diag.ok && diag.models && Array.isArray(diag.models.ids) ? diag.models.ids : []

  let out = ids.map(String)
  if (prefix) out = out.filter((id) => id.startsWith(prefix))
  if (contains) out = out.filter((id) => id.includes(contains))
  out = out.slice(0, limit)

  return c.json({
    success: true,
    provider,
    models: out,
    total: ids.length
  })
})
// Storage root should live at repo root by default: talkscene/storage/*
// For production/real usage, prefer setting STUDIO_STORAGE_ROOT to a repo-external path.
// [拆分回收] 辅助定义 已回 index.js
// [拆分回收] 辅助定义 已回 index.js
// [拆分回收] 辅助定义 已回 index.js
// [拆分回收] 辅助定义 已回 index.js
// [拆分回收] 辅助定义 已回 index.js
// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

app.get('/api/studio/settings', async (c) => {
  const { settings, effective } = await getEffectiveStudioConfig(ctx.ROOT)
  return c.json({ success: true, settings: redactStudioSettingsForClient(settings) || null, effective: redactEffectiveStudioConfigForClient(effective) })
})

app.put('/api/studio/settings', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const saved = await writeStudioSettings(ctx.ROOT, body && body.settings ? body.settings : body)
  return c.json({ success: true, settings: redactStudioSettingsForClient(saved) || null })
})

// 2026-10-20 设置页 V1：存储区/关于区信息（ui_设置定义.md §9.2/§9.6）
app.get('/api/studio/storage-info', async (c) => {
  const root = ctx.ROOT
  let writable = false
  try {
    await mkdir(root, { recursive: true })
    const probe = path.join(root, `.storage_probe_${Date.now()}.tmp`)
    await writeFile(probe, 'ok')
    await rm(probe)
    writable = true
  } catch (_) {
    writable = false
  }
  let version = ''
  try {
    const pkgRaw = await readFile(path.resolve(ctx.__dirname, '../../../package.json'), 'utf-8')
    version = String(JSON.parse(pkgRaw).version || '')
  } catch (_) {}
  return c.json({ success: true, root, writable, version, docsysUrl: 'http://127.0.0.1:8891/' })
})

// 2026-10-20 守护台关联（设置页卡 + 新建页执行路径）：租约开关/地址/可达性探测
app.get('/api/studio/control-link', async (c) => {
  const link = readControlLinkSync(ctx.ROOT)
  // 运行时生效值：env 显式设定时优先于设置（resourceLease.js 判定顺序一致）
  const envOverride = String(process.env.STUDIO_RESOURCE_LEASE_ENABLED || '').trim() !== ''
  const leaseEnabled = isResourceLeaseEnabled()
  const baseUrl = controlBaseUrl()
  const startedAt = Date.now()
  let reachable = false
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 1500)
  try {
    const resp = await fetch(`${baseUrl}/api/health`, { signal: controller.signal })
    reachable = resp.ok
  } catch (_) {
    reachable = false
  } finally {
    clearTimeout(t)
  }
  return c.json({
    success: true,
    leaseEnabled,
    baseUrl,
    settingsLeaseEnabled: link.leaseEnabled,
    envOverride,
    reachable,
    latencyMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString()
  })
})

// 2026-10-20 语音 TTS（ui_设置定义.md §7.6）：音色预设清单
app.get('/api/studio/tts/voices', (c) => {
  const provider = String(c.req.query('provider') || '').trim().toLowerCase()
  return c.json({ success: true, provider, voices: listTtsVoices(provider) })
})

// 语音试听：真实合成一句样例并返回音频字节；产物留档 storage/_shared/tts_previews/
app.post('/api/studio/tts/preview', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const settingsOverride = body && body.settings && typeof body.settings === 'object' ? body.settings : null
  const { effective } = await getEffectiveStudioConfig(ctx.ROOT, { settingsOverride })
  if (!effective.enabled.tts) {
    return c.json({ success: false, error: { code: 'tts_disabled', message: '「语音合成」已在设置中停用，请先在语音卡启用' } }, 409)
  }
  const provider = String(effective.tts?.provider || '').trim().toLowerCase()
  const text = String(body?.text || '').trim() || '小猫去河边钓鱼'
  const voice = String(body?.voice || '').trim() || String(effective.tts?.voice || '').trim()
  try {
    const res = await synthesizeTts({
      provider,
      voice,
      speed: body?.speed != null ? Number(body.speed) : effective.tts?.speed,
      format: String(body?.format || '').trim() || effective.tts?.format || 'mp3',
      text,
      apiUrl: effective.tts?.apiUrl,
      model: effective.tts?.model,
      secrets: { openaiApiKey: getStudioSecret('openai') },
      proxyUrl: effective.network?.proxyUrl || undefined
    })
    await saveTtsPreview(ctx.ROOT, res.bytes, res.ext).catch(() => null)
    const headerSafe = (v) => String(v || '').replace(/[^\x20-\x7e]+/g, '')
    return c.body(res.bytes, 200, {
      'Content-Type': res.mime,
      'x-tts-voice': headerSafe(voice),
      'x-tts-provider': headerSafe(provider)
    })
  } catch (e) {
    const code = e && e.code ? String(e.code) : 'tts_failed'
    const message = e && e.message ? String(e.message) : String(e)
    const status =
      code === 'tts_provider_pending'
        ? 501
        : code === 'tts_missing_key' || code === 'tts_missing_api_url' || code === 'tts_format_unsupported' || code === 'tts_not_configured' || code === 'tts_empty_text'
          ? 400
          : 502
    return c.json({ success: false, error: { code, message } }, status)
  }
})

app.get('/api/studio/sdwebui/models', async (c) => {
  const q = c.req.query()
  const baseUrl = ctx.normalizeSdwebuiBaseUrl(q.baseUrl || process.env.SDWEBUI_BASE_URL)
  const timeoutMs = ctx.clampInt(q.timeoutMs, 1_000, 30_000, 8_000)
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const [modelsResp, optionsResp] = await Promise.all([
      fetch(`${baseUrl}/sdapi/v1/sd-models`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/sdapi/v1/options`, { method: 'GET', signal: controller.signal }).catch(() => null)
    ])
    const modelsUnsupported = !modelsResp || Number(modelsResp.status || 0) === 404
    if (!modelsUnsupported && (!modelsResp || !modelsResp.ok)) {
      return c.json({ success: false, error: 'sdwebui_models_failed', message: `HTTP_${modelsResp ? modelsResp.status : 0}`, baseUrl }, 502)
    }
    const modelsJson = modelsUnsupported ? [] : await modelsResp.json().catch(() => [])
    const optionsJson = optionsResp && optionsResp.ok ? await optionsResp.json().catch(() => null) : null
    const currentModel = optionsJson && typeof optionsJson === 'object' ? String(optionsJson.sd_model_checkpoint || '').trim() || null : null
    const models = (Array.isArray(modelsJson) ? modelsJson : [])
      .map((x) => {
        if (!x || typeof x !== 'object') return ''
        const title = String(x.title || '').trim()
        const modelName = String(x.model_name || '').trim()
        const name = String(x.name || '').trim()
        return title || modelName || name || ''
      })
      .filter(Boolean)
    return c.json({
      success: true,
      baseUrl,
      currentModel,
      models,
      note: modelsUnsupported ? 'models_api_not_supported' : 'ok'
    })
  } catch (e) {
    return c.json(
      {
        success: false,
        error: 'sdwebui_connect_failed',
        message: e && e.message ? String(e.message) : String(e),
        baseUrl
      },
      502
    )
  } finally {
    clearTimeout(t)
  }
})

app.get('/api/studio/comfyui/models', async (c) => {
  const q = c.req.query()
  const baseUrl = ctx.normalizeComfyuiBaseUrl(q.baseUrl || process.env.COMFYUI_BASE_URL)
  const timeoutMs = ctx.clampInt(q.timeoutMs, 1_000, 30_000, 8_000)
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const [ckptResp, loraRespA, loraRespB, modelsResp, ckptListResp, loraListResp] = await Promise.all([
      fetch(`${baseUrl}/object_info/CheckpointLoaderSimple`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/object_info/LoraLoader`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/object_info/LoraLoaderModelOnly`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/models`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/models/checkpoints`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/models/loras`, { method: 'GET', signal: controller.signal }).catch(() => null)
    ])
    if (!ckptResp || !ckptResp.ok) {
      return c.json({ success: false, error: 'comfyui_models_failed', message: `HTTP_${ckptResp ? ckptResp.status : 0}`, baseUrl }, 502)
    }
    const ckptJson = await ckptResp.json().catch(() => null)
    const ckpts = ckptJson && ckptJson.CheckpointLoaderSimple && ckptJson.CheckpointLoaderSimple.input && ckptJson.CheckpointLoaderSimple.input.required
      ? ckptJson.CheckpointLoaderSimple.input.required.ckpt_name
      : null
    const modelSet = new Set(ctx.extractComfyChoiceList(ckpts))
    const modelsJson = modelsResp && modelsResp.ok ? await modelsResp.json().catch(() => null) : null
    const ckptListJson = ckptListResp && ckptListResp.ok ? await ckptListResp.json().catch(() => null) : null
    for (const x of ctx.extractStringListFromUnknown(ckptListJson)) modelSet.add(String(x || '').trim())
    if (modelsJson && typeof modelsJson === 'object') {
      for (const x of ctx.extractStringListFromUnknown(modelsJson.checkpoints)) modelSet.add(String(x || '').trim())
    }
    const models = Array.from(modelSet).filter(Boolean)
    const loraJsonA = loraRespA && loraRespA.ok ? await loraRespA.json().catch(() => null) : null
    const loraJsonB = loraRespB && loraRespB.ok ? await loraRespB.json().catch(() => null) : null
    const loraA = loraJsonA && loraJsonA.LoraLoader && loraJsonA.LoraLoader.input && loraJsonA.LoraLoader.input.required
      ? loraJsonA.LoraLoader.input.required.lora_name
      : null
    const loraB = loraJsonB && loraJsonB.LoraLoaderModelOnly && loraJsonB.LoraLoaderModelOnly.input && loraJsonB.LoraLoaderModelOnly.input.required
      ? loraJsonB.LoraLoaderModelOnly.input.required.lora_name
      : null
    const loraSet = new Set()
    for (const x of ctx.extractComfyChoiceList(loraA)) {
      const s = String(x || '').trim()
      if (s) loraSet.add(s)
    }
    for (const x of ctx.extractComfyChoiceList(loraB)) {
      const s = String(x || '').trim()
      if (s) loraSet.add(s)
    }
    const loraListJson = loraListResp && loraListResp.ok ? await loraListResp.json().catch(() => null) : null
    for (const x of ctx.extractStringListFromUnknown(loraListJson)) loraSet.add(String(x || '').trim())
    if (modelsJson && typeof modelsJson === 'object') {
      for (const x of ctx.extractStringListFromUnknown(modelsJson.loras)) loraSet.add(String(x || '').trim())
    }
    const loras = Array.from(loraSet)
    return c.json({
      success: true,
      baseUrl,
      currentModel: null,
      models,
      loras,
      note: 'ok'
    })
  } catch (e) {
    return c.json(
      {
        success: false,
        error: 'comfyui_connect_failed',
        message: e && e.message ? String(e.message) : String(e),
        baseUrl
      },
      502
    )
  } finally {
    clearTimeout(t)
  }
})

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

app.post('/api/studio/image/preflight', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const timeoutMs = ctx.clampInt(body?.timeoutMs, 2_000, 60_000, 10_000)
  const mode = String(body?.mode || 'basic').trim().toLowerCase() === 'storyboard' ? 'storyboard' : 'basic'
  const settingsOverride = body && body.settings && typeof body.settings === 'object' ? body.settings : null
  const { effective } = await getEffectiveStudioConfig(ctx.ROOT, { settingsOverride })

  const provider = String(effective.image.provider || '').toLowerCase()
  if (!effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', checks: { provider, ok: false, reason: 'image_disabled' } }, 503)
  }
  if (!provider || provider === 'none') {
    return c.json({ success: false, error: 'provider_not_configured', checks: { provider, ok: false, reason: 'provider_none' } }, 400)
  }

  if (provider !== 'comfyui') {
    return c.json({ success: true, checks: { provider, ok: true, note: 'preflight_skipped_non_comfyui' } })
  }

  const baseUrl = ctx.normalizeComfyuiBaseUrl(effective.image.comfyuiBaseUrl)
  const modelsRoot = ctx.normalizeLocalPath(effective.image.comfyuiModelsRoot)
  const requiredNodes = [
    'CheckpointLoaderSimple',
    'CLIPTextEncode',
    'KSampler',
    'VAEDecode',
    'SaveImage'
  ]
  const check = {
    provider,
    baseUrl,
    mode,
    ok: false,
    requiredNodes,
    missingNodes: [],
    extras: {
      // SDXL storyboard continuity uses the lock/reference workflow as the hard gate.
      // ControlNet is treated as an optional lineart enhancer because this local SDXL
      // setup already supports successful storyboard drawing without SD1.5 ControlNet.
      // Note: `extCount` is for SD-WebUI ControlNet extension models, which are not
      // automatically visible to ComfyUI unless the user links/copies/configures paths.
      controlnet: { ok: false, missingNodes: [], modelsOk: false, modelsSupported: false, modelsCount: 0, diskCount: 0, extCount: 0 },
      ipadapter: { ok: false, missingNodes: [], modelsOk: false, modelsSupported: false, modelsCount: 0, diskCount: 0 },
      storyLock: { ok: false, checkpointOk: false, checkpointModel: String(effective.image.model || '').trim() || null, checkpointCount: 0, loraCount: 0 }
    },
    hints: {
      comfyuiModelsRoot: modelsRoot || null,
      comfyuiModelDir: 'ComfyUI/models/checkpoints',
      comfyuiLoraDir: 'ComfyUI/models/loras',
      comfyuiControlnetDir: 'ComfyUI/models/controlnet',
      comfyuiIpadapterDir: 'ComfyUI/models/ipadapter',
      sdxlStoryboardHint: 'SDXL storyboard lock requires a ComfyUI checkpoint and IP-Adapter; ControlNet is optional for lineart enhancement.',
      restartHint: 'if you add/remove models, restart ComfyUI to refresh cache',
      managerHint: 'recommended: install ComfyUI-Manager to manage custom nodes'
    },
    disk: {
      modelsRoot: modelsRoot || null,
      checkpointsDir: null,
      lorasDir: null,
      controlnetDir: null,
      controlnetExtDir: null,
      ipadapterDir: null,
      modelFileFound: null
    },
    reason: ''
  }

  try {
    const statsResp = await fetch(`${baseUrl}/system_stats`, { method: 'GET' }).catch(() => null)
    if (!statsResp || !statsResp.ok) {
      check.reason = `comfyui_unreachable_${statsResp ? statsResp.status : 0}`
      return c.json({ success: false, error: 'preflight_failed', checks: check }, 502)
    }

    const cap = await ctx.collectComfyCapabilities(baseUrl, timeoutMs, requiredNodes)
    check.missingNodes = Array.isArray(cap.missingNodes) ? cap.missingNodes : []
    if (check.missingNodes.length) {
      check.reason = 'missing_required_nodes'
      return c.json({ success: false, error: 'preflight_failed', checks: check }, 400)
    }

    // Update hint dirs if modelsRoot is configured.
    if (modelsRoot) {
      const base = await ctx.resolveSdWebuiModelsBase(modelsRoot)
      const ckptDir = await ctx.pickCheckpointDir(base)
      const loraDir = await ctx.pickLoraDir(base)
      const cnDir = await ctx.pickExistingDir(base, ['ControlNet', 'controlnet'])
      const ipaDir = await ctx.pickExistingDir(base, ['ipadapter', 'IPAdapter'])
      // SD-WebUI ControlNet extension models (common when sharing SD-WebUI folder):
      // <webuiRoot>/extensions/sd-webui-controlnet/models
      const webuiRoot = path.dirname(base || modelsRoot)
      const cnExtDir = await ctx.pickExistingDir(webuiRoot, ['extensions/sd-webui-controlnet/models'])
      if (ckptDir) check.hints.comfyuiModelDir = ckptDir
      if (loraDir) check.hints.comfyuiLoraDir = loraDir
      if (cnDir) check.hints.comfyuiControlnetDir = cnDir
      if (ipaDir) check.hints.comfyuiIpadapterDir = ipaDir
      check.disk.checkpointsDir = ckptDir || check.disk.checkpointsDir
      check.disk.lorasDir = loraDir || check.disk.lorasDir
      if (ckptDir) {
        const disk = await ctx.hasAnyModelFile(ckptDir)
        check.extras.storyLock.checkpointCount = disk.ok ? disk.count : 0
        check.disk.modelFileFound = disk.ok && disk.count > 0
      }
      if (loraDir) {
        const disk = await ctx.hasAnyModelFile(loraDir)
        check.extras.storyLock.loraCount = disk.ok ? disk.count : 0
      }
      check.disk.controlnetDir = cnDir || null
      check.disk.ipadapterDir = ipaDir || null
      if (cnExtDir) check.disk.controlnetExtDir = cnExtDir
    }

    // Optional but required for "continuous storyboard" mode.
    if (mode === 'storyboard') {
      const controller = new AbortController()
      const t2 = setTimeout(() => controller.abort(), Math.min(timeoutMs, 15000))
      try {
        const sig = controller.signal
        // ControlNet nodes: allow variants.
        const cnLoader = await ctx.probeComfyAnyNode(baseUrl, ['ControlNetLoader', 'ControlNetLoaderAdvanced'], sig)
        const cnApply = await ctx.probeComfyAnyNode(baseUrl, ['ControlNetApply', 'ControlNetApplyAdvanced'], sig)
        const cnMissing = []
        if (!cnLoader.ok) cnMissing.push('ControlNetLoader')
        if (!cnApply.ok) cnMissing.push('ControlNetApply')
        check.extras.controlnet.missingNodes = cnMissing
        // ControlNet models list (best-effort)
        const cnModels = await ctx.fetchComfyModelList(baseUrl, '/models/controlnet', sig)
        check.extras.controlnet.modelsSupported = Boolean(cnModels.supported)
        check.extras.controlnet.modelsCount = Array.isArray(cnModels.list) ? cnModels.list.length : 0
        if (check.extras.controlnet.modelsSupported) {
          check.extras.controlnet.modelsOk = check.extras.controlnet.modelsCount > 0
        } else if (modelsRoot) {
          // Disk check should focus on ComfyUI-visible ControlNet dir. SD-WebUI extension models
          // are reported separately as a "can be linked" hint.
          const cnDir = String(check.hints.comfyuiControlnetDir || '').trim()
          if (cnDir) {
            const disk = await ctx.hasAnyModelFile(cnDir)
            check.extras.controlnet.diskCount = disk.ok ? disk.count : 0
            check.extras.controlnet.modelsOk = disk.ok && disk.count > 0
          } else {
            check.extras.controlnet.diskCount = 0
            check.extras.controlnet.modelsOk = false
          }
          const extDir = String(check.disk.controlnetExtDir || '').trim()
          if (extDir) {
            const ext = await ctx.hasAnyModelFile(extDir)
            check.extras.controlnet.extCount = ext.ok ? ext.count : 0
          }
        } else {
          check.extras.controlnet.modelsOk = false
        }
        check.extras.controlnet.ok = cnMissing.length === 0 && check.extras.controlnet.modelsOk

        // IP-Adapter nodes (ComfyUI_IPAdapter_plus and variants)
        const ipaLoader = await ctx.probeComfyAnyNode(baseUrl, ['IPAdapterModelLoader', 'IPAdapterLoader', 'IPAdapterUnifiedLoader'], sig)
        const ipaApply = await ctx.probeComfyAnyNode(baseUrl, ['IPAdapterApply', 'IPAdapterApplyAdvanced', 'IPAdapterAdvanced'], sig)
        const ipaMissing = []
        if (!ipaLoader.ok) ipaMissing.push('IPAdapterModelLoader')
        if (!ipaApply.ok) ipaMissing.push('IPAdapterApply')
        check.extras.ipadapter.missingNodes = ipaMissing
        const ipaModels = await ctx.fetchComfyModelList(baseUrl, '/models/ipadapter', sig)
        check.extras.ipadapter.modelsSupported = Boolean(ipaModels.supported)
        check.extras.ipadapter.modelsCount = Array.isArray(ipaModels.list) ? ipaModels.list.length : 0
        if (check.extras.ipadapter.modelsSupported) {
          check.extras.ipadapter.modelsOk = check.extras.ipadapter.modelsCount > 0
        } else if (modelsRoot && check.hints.comfyuiIpadapterDir) {
          const disk = await ctx.hasAnyModelFile(check.hints.comfyuiIpadapterDir)
          check.extras.ipadapter.diskCount = disk.ok ? disk.count : 0
          check.extras.ipadapter.modelsOk = disk.ok && disk.count > 0
        } else {
          check.extras.ipadapter.modelsOk = false
        }
        check.extras.ipadapter.ok = ipaMissing.length === 0 && check.extras.ipadapter.modelsOk

        const configuredCheckpoint = String(effective.image.model || '').trim()
        const comfyCheckpoints = Array.isArray(cap.models) ? cap.models.map((x) => String(x || '').trim()).filter(Boolean) : []
        const normalizedConfigured = ctx.normalizeComfyModelKey(configuredCheckpoint)
        const checkpointKnownToComfy = normalizedConfigured
          ? comfyCheckpoints.some((item) => {
            const key = ctx.normalizeComfyModelKey(item)
            return key === normalizedConfigured || key.includes(normalizedConfigured) || normalizedConfigured.includes(key)
          })
          : comfyCheckpoints.length > 0
        const checkpointOnDisk = Boolean(check.disk.modelFileFound || check.extras.storyLock.checkpointCount > 0)
        check.extras.storyLock.checkpointOk = Boolean(checkpointKnownToComfy || checkpointOnDisk)
        check.extras.storyLock.checkpointModel = configuredCheckpoint || (comfyCheckpoints[0] || null)
        check.extras.storyLock.ok = Boolean(check.extras.storyLock.checkpointOk && check.extras.ipadapter.ok)
      } finally {
        clearTimeout(t2)
      }

      if (!check.extras.storyLock.ok) {
        check.reason = 'missing_storyboard_extras'
        return c.json({ success: false, error: 'preflight_failed', checks: check }, 400)
      }
    }

    check.ok = true
    check.reason = 'ok'
    return c.json({ success: true, checks: check })
  } catch (e) {
    check.reason = e && e.message ? String(e.message) : String(e)
    return c.json({ success: false, error: 'preflight_failed', checks: check }, 502)
  }
})

app.post('/api/studio/image/models', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const settingsOverride = body && body.settings && typeof body.settings === 'object' ? body.settings : null
  const { effective } = await getEffectiveStudioConfig(ctx.ROOT, { settingsOverride })

  if (!effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: 'image_disabled' }, 503)
  }

  const provider = String(effective.image.provider || '').toLowerCase()
  if (!provider || provider === 'none') {
    return c.json({ success: false, error: 'provider_not_configured', message: 'provider_none' }, 400)
  }

  const baseUrl =
    provider === 'comfyui'
      ? ctx.normalizeComfyuiBaseUrl(effective.image.comfyuiBaseUrl)
      : provider === 'sdwebui'
        ? ctx.normalizeSdwebuiBaseUrl(effective.image.sdwebuiBaseUrl)
        : ''

  // Prefer disk scan when a shared Models Root is configured for ComfyUI.
  if (provider === 'comfyui') {
    const modelsRoot = ctx.normalizeLocalPath(effective.image.comfyuiModelsRoot)
    if (modelsRoot) {
      const base = await ctx.resolveSdWebuiModelsBase(modelsRoot)
      const ckptDir = await ctx.pickCheckpointDir(base)
      const loraDir = await ctx.pickLoraDir(base)
      const models = ckptDir ? await ctx.scanModelFiles(ckptDir, { exts: ['.safetensors', '.ckpt'], maxDepth: 4 }) : []
      const loras = loraDir ? await ctx.scanModelFiles(loraDir, { exts: ['.safetensors'], maxDepth: 4 }) : []
      return c.json({
        success: true,
        source: 'disk',
        provider,
        baseUrl,
        modelsRoot: base || modelsRoot,
        dirs: { checkpointsDir: ckptDir || null, lorasDir: loraDir || null },
        models,
        loras,
        note: 'disk_scan'
      })
    }
  }

  // Fallback: query provider API (may include cached names).
  try {
    if (provider === 'comfyui') {
      const cap = await ctx.collectComfyCapabilities(baseUrl, 12_000, [])
      return c.json({
        success: true,
        source: 'comfyui',
        provider,
        baseUrl,
        models: Array.isArray(cap.models) ? cap.models : [],
        loras: Array.isArray(cap.loras) ? cap.loras : [],
        note: 'comfyui_api'
      })
    }
    if (provider === 'sdwebui') {
      const res = await fetch(`${baseUrl}/sdapi/v1/sd-models`, { method: 'GET' }).catch(() => null)
      if (!res || !res.ok) return c.json({ success: false, error: 'models_failed', message: `sdwebui_models_http_${res ? res.status : 0}` }, 502)
      const arr = await res.json().catch(() => [])
      const list = Array.isArray(arr) ? arr : []
      const models = list.map((x) => (x && typeof x === 'object' ? String(x.model_name || x.title || x.name || '').trim() : '')).filter(Boolean)
      return c.json({ success: true, source: 'sdwebui', provider, baseUrl, models, loras: [], note: 'sdwebui_api' })
    }
    return c.json({ success: true, source: 'none', provider, baseUrl, models: [], loras: [], note: 'not_supported' })
  } catch (e) {
    return c.json({ success: false, error: 'models_failed', message: e && e.message ? String(e.message) : String(e) }, 502)
  }
})

app.post('/api/studio/image/test', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const timeoutMs = ctx.clampInt(body?.timeoutMs, 5_000, 300_000, 60_000)
  const settingsOverride = body && body.settings && typeof body.settings === 'object' ? body.settings : null
  const { effective } = await getEffectiveStudioConfig(ctx.ROOT, { settingsOverride })
  const requestedModel = String(body?.model || '').trim()
  const requestedLoras = Array.isArray(body?.loras) ? body.loras.map((x) => String(x || '').trim()).filter(Boolean) : []

  if (!effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
  const provider = String(effective.image.provider || '').toLowerCase()
  if (!provider || provider === 'none') {
    return c.json({ success: false, error: 'provider_not_configured', message: '请先在设置中选择 Provider/Model' }, 400)
  }

  if (provider === 'comfyui') {
    const pre = await (async () => {
      const baseUrl = ctx.normalizeComfyuiBaseUrl(effective.image.comfyuiBaseUrl)
      const modelConfigured = requestedModel || String(effective.image.model || '').trim()
      const lorasConfigured = ctx.normalizeConfiguredLoraNames(requestedLoras.length ? requestedLoras : effective.image.loras)
      const requiredNodes = [
        'CheckpointLoaderSimple',
        'CLIPTextEncode',
        'KSampler',
        'VAEDecode',
        'SaveImage',
        ...(lorasConfigured.length ? ['LoraLoader'] : [])
      ]
      const check = {
        provider: 'comfyui',
        baseUrl,
        ok: false,
        requiredNodes,
        missingNodes: [],
        modelConfigured,
        modelExists: false,
        lorasConfigured,
        missingLoras: [],
        hints: {
          comfyuiModelDir: 'ComfyUI/models/checkpoints',
          comfyuiLoraDir: 'ComfyUI/models/loras',
          restartHint: 'if you add/remove models, restart ComfyUI to refresh cache',
          managerHint: 'recommended: install ComfyUI-Manager to manage custom nodes'
        },
        reason: ''
      }
      try {
        const statsResp = await fetch(`${baseUrl}/system_stats`, { method: 'GET' }).catch(() => null)
        if (!statsResp || !statsResp.ok) {
          check.reason = `comfyui_unreachable_${statsResp ? statsResp.status : 0}`
          return { ok: false, check }
        }
        const cap = await ctx.collectComfyCapabilities(baseUrl, Math.min(timeoutMs, 15_000), requiredNodes)
        check.missingNodes = Array.isArray(cap.missingNodes) ? cap.missingNodes : []
        if (check.missingNodes.length) {
          check.reason = 'missing_required_nodes'
          return { ok: false, check }
        }
        const models = Array.isArray(cap.models) ? cap.models.map((x) => String(x || '').trim()).filter(Boolean) : []
        if (!check.modelConfigured) {
          check.reason = 'missing_model_config'
          return { ok: false, check }
        }
        check.modelExists = models.some((x) => String(x).toLowerCase() === String(check.modelConfigured).toLowerCase())
        if (!check.modelExists) {
          check.reason = 'configured_model_not_found'
          return { ok: false, check }
        }
        const loras = Array.isArray(cap.loras) ? cap.loras.map((x) => String(x || '').trim()).filter(Boolean) : []
        const loraKeySet = new Set(loras.map((x) => ctx.normalizeComfyLoraKey(x)).filter(Boolean))
        check.missingLoras = check.lorasConfigured.filter((name) => !loraKeySet.has(ctx.normalizeComfyLoraKey(name)))
        if (check.missingLoras.length) {
          check.reason = 'configured_loras_not_found'
          return { ok: false, check }
        }
        check.ok = true
        check.reason = 'ok'
        return { ok: true, check }
      } catch (e) {
        check.reason = e && e.message ? String(e.message) : String(e)
        return { ok: false, check }
      }
    })()
    if (!pre.ok) {
      return c.json({ success: false, error: 'preflight_failed', message: `preflight_failed: ${pre.check.reason}`, checks: pre.check }, 400)
    }
  }

  const width = ctx.clampInt(body?.width, 256, 1024, 512)
  const height = ctx.clampInt(body?.height, 256, 1024, 512)
  const style = ctx.normalizeStyleEnum(body?.style || 'picture_book')
  const prompt = String(body?.prompt || '').trim() || 'a warm children picture book illustration, a cute rabbit reading a book in a cozy forest, soft light, clean outlines'
  const negativePrompt = String(body?.negativePrompt || '').trim()

  try {
    const gen = await generateBackgroundImage({
      prompt,
      negativePrompt,
      style,
      width,
      height,
      size: body?.size,
      responseFormat: body?.responseFormat,
      watermark: body?.watermark,
      sequentialImageGeneration: body?.sequentialImageGeneration,
      steps: body?.steps,
      cfgScale: body?.cfgScale,
      sampler: body?.sampler,
      scheduler: body?.scheduler,
      provider,
      model: requestedModel || effective.image.model,
      loras: requestedLoras.length ? requestedLoras : effective.image.loras,
      sdwebuiBaseUrl: effective.image.sdwebuiBaseUrl,
      comfyuiBaseUrl: effective.image.comfyuiBaseUrl,
      apiUrl: effective.image.apiUrl,
      proxyUrl: effective.network.proxyUrl,
      timeoutMs
    })
    const buf = gen.bytes
    const ext0 = String(gen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
    const sniff = sniffImageMetaFromBytes(buf)
    const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'
    const b64 = buf.toString('base64')
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
    return c.json({
      success: true,
      result: { ext, bytesBase64: b64, dataUrl: `data:${mime};base64,${b64}` },
      meta: gen.meta || null
    })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const status = e && typeof e.status === 'number' ? e.status : null
    return c.json({ success: false, error: 'test_failed', message: msg, status: status == null ? undefined : status }, 502)
  }
})

app.post('/api/studio/diagnose', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const deepText = Boolean(body && body.deepText)
  const deepImages = Boolean(body && body.deepImages)
  const service = String((body && body.service) || 'all').trim().toLowerCase()
  const timeoutMs = ctx.clampInt(body?.timeoutMs, 3_000, 60_000, 12_000)

  const settingsOverride = body && body.settings && typeof body.settings === 'object' ? body.settings : null
  const { effective } = await getEffectiveStudioConfig(ctx.ROOT, { settingsOverride })

  const out = {
    ok: true,
    checkedAt: new Date().toISOString(),
    effective: redactEffectiveStudioConfigForClient(effective),
    services: {
      server: { ok: true, note: 'health_ok' },
      scripts: { ok: true, provider: effective.scripts.provider, model: effective.scripts.model, note: '' },
      prompt: { ok: true, provider: effective.prompt.provider, model: effective.prompt.model, note: '' },
      translation: { ok: true, provider: effective.translation?.provider, model: effective.translation?.model, note: '' },
      image: { ok: true, provider: effective.image.provider, model: effective.image.model, note: '' },
      tts: effective.enabled.tts
        ? { ok: false, provider: effective.tts.provider, model: effective.tts.model, note: 'not_implemented' }
        : { ok: true, provider: effective.tts.provider, model: effective.tts.model, note: 'disabled' },
      review: { ok: true, provider: effective.review?.provider, model: effective.review?.model, note: '' }
    }
  }

  async function dnsCheck(url) {
    try {
      const host = new URL(String(url)).hostname
      const addrs = await dns.lookup(host, { all: true }).catch(() => [])
      return { ok: Array.isArray(addrs) && addrs.length > 0, host, count: Array.isArray(addrs) ? addrs.length : 0 }
    } catch (e) {
      return { ok: false, error: e && e.message ? String(e.message) : String(e) }
    }
  }

  async function diagnoseSdWebui(baseUrl, model) {
    const url = ctx.normalizeSdwebuiBaseUrl(baseUrl)
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(`${url}/sdapi/v1/options`, { method: 'GET', signal: controller.signal })
      if (!resp.ok) return { ok: false, provider: 'sdwebui', note: `HTTP_${resp.status}`, baseUrl: url, model: model || null }

      const modelName = ctx.normalizeComfyModelName(model)
      if (modelName) {
        const mResp = await fetch(`${url}/sdapi/v1/sd-models`, { method: 'GET', signal: controller.signal })
        if (!mResp.ok) {
          if (Number(mResp.status || 0) === 404) {
            return { ok: true, provider: 'sdwebui', note: 'model_check_skipped_models_api_not_supported', baseUrl: url, model: modelName }
          }
          return { ok: false, provider: 'sdwebui', note: `models_HTTP_${mResp.status}`, baseUrl: url, model: modelName }
        }
        const arr = await mResp.json().catch(() => null)
        const list = Array.isArray(arr) ? arr : []
        const names = list
          .map((x) => (x && typeof x === 'object' ? String(x.model_name || x.title || x.name || '').trim() : ''))
          .filter(Boolean)
        const found = names.some((n) => n === modelName || n.includes(modelName) || modelName.includes(n))
        if (!found) {
          return { ok: false, provider: 'sdwebui', note: 'model_not_found', baseUrl: url, model: modelName }
        }
        return { ok: true, provider: 'sdwebui', note: 'configured_model_ok', baseUrl: url, model: modelName }
      }

      return { ok: true, provider: 'sdwebui', note: 'configured', baseUrl: url, model: null }
    } catch (e) {
      return { ok: false, provider: 'sdwebui', note: e && e.message ? String(e.message) : String(e), baseUrl: url, model: model || null }
    } finally {
      clearTimeout(t)
    }
  }

  async function diagnoseComfyui(baseUrl, model) {
    const url = ctx.normalizeComfyuiBaseUrl(baseUrl)
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const stats = await fetch(`${url}/system_stats`, { method: 'GET', signal: controller.signal })
      if (!stats.ok) return { ok: false, provider: 'comfyui', note: `HTTP_${stats.status}`, baseUrl: url, model: model || null }

      const modelName = String(model || '').trim()
      if (modelName) {
        const mResp = await fetch(`${url}/object_info/CheckpointLoaderSimple`, { method: 'GET', signal: controller.signal })
        if (!mResp.ok) return { ok: false, provider: 'comfyui', note: `models_HTTP_${mResp.status}`, baseUrl: url, model: modelName }
        const j = await mResp.json().catch(() => null)
        const ckpts = j && j.CheckpointLoaderSimple && j.CheckpointLoaderSimple.input && j.CheckpointLoaderSimple.input.required
          ? j.CheckpointLoaderSimple.input.required.ckpt_name
          : null
        const names = Array.isArray(ckpts) ? ckpts.map((x) => String(x || '').trim()).filter(Boolean) : []
        const found = names.some((n) => n === modelName || n.includes(modelName) || modelName.includes(n))
        if (!found) return { ok: false, provider: 'comfyui', note: 'model_not_found', baseUrl: url, model: modelName }
        return { ok: true, provider: 'comfyui', note: 'configured_model_ok', baseUrl: url, model: modelName }
      }
      return { ok: true, provider: 'comfyui', note: 'configured', baseUrl: url, model: null }
    } catch (e) {
      return { ok: false, provider: 'comfyui', note: e && e.message ? String(e.message) : String(e), baseUrl: url, model: model || null }
    } finally {
      clearTimeout(t)
    }
  }

  async function diagnoseDoubaoText(model, apiUrl) {
    const keyPresent = Boolean(String(getStudioSecret('doubao') || process.env.DOUBAO_ARK_API_KEY || process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY || '').trim())
    const authHeaderPresent = Boolean(String(process.env.DOUBAO_ARK_AUTH_HEADER || process.env.DOUBAO_AUTH_HEADER || '').trim())
    const cfg = {
      provider: 'doubao',
      api: 'chat.completions',
      apiUrl: String(apiUrl || process.env.DOUBAO_ARK_CHAT_URL || process.env.DOUBAO_ARK_TEXT_URL || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'),
      model: String(model || process.env.DOUBAO_ARK_TEXT_MODEL || process.env.DOUBAO_ARK_LLM_MODEL || process.env.DOUBAO_LLM_MODEL || '').trim()
    }
    const dnsRes = await dnsCheck(cfg.apiUrl)
    if (!keyPresent && !authHeaderPresent) return { ok: false, note: 'missing_key', dns: dnsRes, ...cfg }
    if (!deepText) return { ok: Boolean(dnsRes && dnsRes.ok), note: dnsRes.ok ? 'configured' : 'dns_failed', dns: dnsRes, ...cfg }
    try {
      const { parsed, meta } = await (await import('./ai/doubao.js')).generateStrictJsonViaDoubaoChat({
        instructions: '输出一个 JSON：{"ok":true}，只输出 JSON。',
        input: '请输出 {"ok":true}',
        model: cfg.model || undefined,
        apiUrl: cfg.apiUrl || undefined,
        proxyUrl: effective.network.proxyUrl,
        timeoutMs,
        maxRetries: 1,
        validate: (x) => Boolean(x && typeof x === 'object' && x.ok === true)
      })
      return { ok: Boolean(parsed && parsed.ok === true), note: 'verified', dns: dnsRes, meta, ...cfg }
    } catch (e) {
      return { ok: false, note: e && e.message ? String(e.message) : String(e), dns: dnsRes, ...cfg }
    }
  }

  async function diagnoseOllamaTextLocal(model, apiUrl) {
    const cfgModel = String(model || '').trim() || null
    const res = await diagnoseOllamaText({
      model: cfgModel || undefined,
      apiUrl: String(apiUrl || '').trim() || undefined,
      timeoutMs,
      proxyUrl: effective.network.proxyUrl,
      deepText
    })
    return res
  }

  // 2026-10-20 任务A：审核模型连通测试（moonshot/omlx 均为 OpenAI 兼容端点，GET /models 探测，不产生评审调用）
  async function diagnoseReviewEndpoint() {
    const provider = String(effective.review?.provider || '').trim().toLowerCase()
    const model = effective.review?.model ? String(effective.review.model) : null
    const baseUrl = String(effective.review?.apiUrl || '').trim().replace(/\/+$/, '')
    const cfg = { provider: provider || 'none', model, apiUrl: baseUrl || null }
    if (!provider || provider === 'none' || provider === 'off') return { ok: true, note: 'disabled', ...cfg }
    if (!baseUrl) return { ok: false, note: 'missing_api_url', ...cfg }
    const key =
      provider === 'moonshot'
        ? String(process.env.MOONSHOT_API_KEY || '').trim()
        : String(getStudioSecret('localoxml') || process.env.LOCALOXML_API_KEY || process.env.STUDIO_AI_API_KEY || '').trim()
    if (provider === 'moonshot' && !key) return { ok: false, note: 'missing_key', ...cfg }
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(`${baseUrl}/models`, { method: 'GET', headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: controller.signal })
      if (resp.ok) return { ok: true, note: 'connected', ...cfg }
      if (Number(resp.status) === 404) return { ok: true, note: 'connected_models_api_not_supported', ...cfg }
      if (Number(resp.status) === 401 || Number(resp.status) === 403) return { ok: false, note: 'auth_failed', ...cfg }
      return { ok: false, note: `HTTP_${resp.status}`, ...cfg }
    } catch (e) {
      return { ok: false, note: e && e.message ? String(e.message) : String(e), ...cfg }
    } finally {
      clearTimeout(t)
    }
  }

  async function diagnoseTranslationText({ provider, model, apiUrl, verify }) {
    const cfg = {
      provider: String(provider || '').trim().toLowerCase() || 'none',
      model: String(model || '').trim() || null,
      apiUrl: String(apiUrl || '').trim() || null
    }
    if (!cfg.provider || cfg.provider === 'none') {
      return { ok: false, note: 'provider_not_configured', ...cfg }
    }
    if (!verify) {
      if (isOpenAICompatibleProvider(cfg.provider)) {
        return await diagnoseOpenAI({
          timeoutMs,
          provider: cfg.provider,
          apiUrl: cfg.apiUrl,
          model: cfg.model,
          proxyUrl: effective.network.proxyUrl
        })
      }
      if (cfg.provider === 'doubao') return await diagnoseDoubaoText(cfg.model, cfg.apiUrl)
      if (cfg.provider === 'ollama') return await diagnoseOllamaTextLocal(cfg.model, cfg.apiUrl)
      return { ok: true, note: 'configured', ...cfg }
    }
    try {
      const { result, meta } = await translatePromptText({
        provider: cfg.provider,
        model: cfg.model || undefined,
        apiUrl: cfg.apiUrl || undefined,
        proxyUrl: effective.network.proxyUrl || undefined,
        timeoutMs,
        text: '红色苹果，白色背景，极简插画',
        sourceLang: 'zh',
        targetLang: 'en',
        mode: 'prompt'
      })
      return {
        ok: Boolean(result && String(result.translatedText || '').trim()),
        note: 'verified',
        result,
        meta,
        ...cfg
      }
    } catch (e) {
      const mapped = classifyAiError(e)
      return {
        ok: false,
        note: e && e.message ? String(e.message) : String(e),
        error: mapped,
        ...cfg
      }
    }
  }

  async function diagnoseDoubaoImages({ apiUrl, model }) {
    const keyPresent = Boolean(String(getStudioSecret('doubao') || process.env.DOUBAO_ARK_API_KEY || process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY || '').trim())
    const authHeaderPresent = Boolean(String(process.env.DOUBAO_ARK_AUTH_HEADER || process.env.DOUBAO_AUTH_HEADER || '').trim())
    const url = String(apiUrl || getDoubaoImagesConfigSnapshot().apiUrl || 'https://ark.cn-beijing.volces.com/api/v3/images/generations')
    const dnsRes = await dnsCheck(url)
    const cfg = { provider: 'doubao', api: 'images', apiUrl: url, model: model || null }
    if (!keyPresent && !authHeaderPresent) return { ok: false, note: 'missing_key', dns: dnsRes, ...cfg }
    if (!deepImages) return { ok: Boolean(dnsRes && dnsRes.ok), note: dnsRes.ok ? 'configured' : 'dns_failed', dns: dnsRes, ...cfg }
    try {
      const res = await (await import('./ai/doubao.js')).generateImageViaDoubaoArkImages({
        prompt: '一张极简风格的红色苹果，纯色背景，无文字',
        size: '1280x720',
        responseFormat: 'url',
        timeoutMs,
        proxyUrl: effective.network.proxyUrl,
        apiUrl: url,
        model: model || undefined
      })
      return { ok: Boolean(res && (res.url || res.bytes)), note: 'verified', dns: dnsRes, ...cfg }
    } catch (e) {
      return { ok: false, note: e && e.message ? String(e.message) : String(e), dns: dnsRes, ...cfg }
    }
  }

  const checkScripts = service === 'all' || service === 'scripts'
  const checkPrompt = service === 'all' || service === 'prompt'
  const checkTranslation = service === 'all' || service === 'translation'
  const checkImage = service === 'all' || service === 'image'
  const checkReview = service === 'all' || service === 'review'

  if (checkScripts) {
    try {
      if (!effective.enabled.scripts) out.services.scripts = { ok: true, provider: effective.scripts.provider, model: effective.scripts.model, note: 'disabled' }
      else if (isOpenAICompatibleProvider(effective.scripts.provider)) out.services.scripts = await diagnoseOpenAI({ timeoutMs, provider: effective.scripts.provider, apiUrl: effective.scripts.apiUrl, model: effective.scripts.model, proxyUrl: effective.network.proxyUrl })
      else if (effective.scripts.provider === 'doubao') out.services.scripts = await diagnoseDoubaoText(effective.scripts.model, effective.scripts.apiUrl)
      else if (effective.scripts.provider === 'ollama') out.services.scripts = await diagnoseOllamaTextLocal(effective.scripts.model, effective.scripts.apiUrl)
      else out.services.scripts = { ok: true, provider: effective.scripts.provider, model: effective.scripts.model, note: 'local' }
    } catch (e) {
      out.services.scripts = { ok: false, provider: effective.scripts.provider, model: effective.scripts.model, note: e && e.message ? String(e.message) : String(e) }
    }
  }

  if (checkPrompt) {
    try {
      if (!effective.enabled.prompt) out.services.prompt = { ok: true, provider: effective.prompt.provider, model: effective.prompt.model, note: 'disabled' }
      else if (isOpenAICompatibleProvider(effective.prompt.provider)) out.services.prompt = await diagnoseOpenAI({ timeoutMs, provider: effective.prompt.provider, apiUrl: effective.prompt.apiUrl, model: effective.prompt.model, proxyUrl: effective.network.proxyUrl })
      else if (effective.prompt.provider === 'doubao') out.services.prompt = await diagnoseDoubaoText(effective.prompt.model, effective.prompt.apiUrl)
      else if (effective.prompt.provider === 'ollama') out.services.prompt = await diagnoseOllamaTextLocal(effective.prompt.model, effective.prompt.apiUrl)
      else out.services.prompt = { ok: true, provider: effective.prompt.provider, model: effective.prompt.model, note: 'local' }
    } catch (e) {
      out.services.prompt = { ok: false, provider: effective.prompt.provider, model: effective.prompt.model, note: e && e.message ? String(e.message) : String(e) }
    }
  }

  if (checkTranslation) {
    try {
      out.services.translation = await diagnoseTranslationText({
        provider: effective.translation?.provider,
        model: effective.translation?.model,
        apiUrl: effective.translation?.apiUrl,
        verify: service === 'translation' || deepText
      })
    } catch (e) {
      out.services.translation = { ok: false, provider: effective.translation?.provider || 'none', model: effective.translation?.model || null, note: e && e.message ? String(e.message) : String(e) }
    }
  }

  if (checkImage) {
    try {
      if (!effective.enabled.image) out.services.image = { ok: true, provider: effective.image.provider, model: effective.image.model, note: 'disabled' }
      else if (effective.image.provider === 'sdwebui') out.services.image = await diagnoseSdWebui(effective.image.sdwebuiBaseUrl, effective.image.model)
      else if (effective.image.provider === 'comfyui') out.services.image = await diagnoseComfyui(effective.image.comfyuiBaseUrl, effective.image.model)
      else if (effective.image.provider === 'doubao') out.services.image = await diagnoseDoubaoImages({ apiUrl: effective.image.apiUrl, model: effective.image.model })
      else out.services.image = { ok: false, provider: effective.image.provider, model: effective.image.model, note: 'unsupported_provider' }
    } catch (e) {
      out.services.image = { ok: false, provider: effective.image.provider, model: effective.image.model, note: e && e.message ? String(e.message) : String(e) }
    }
  }

  if (checkReview) {
    try {
      out.services.review = await diagnoseReviewEndpoint()
    } catch (e) {
      out.services.review = { ok: false, provider: effective.review?.provider || 'none', model: effective.review?.model || null, note: e && e.message ? String(e.message) : String(e) }
    }
  }

  const checkTts = service === 'all' || service === 'tts'
  if (checkTts) {
    // 2026-10-20 语音 TTS 已落地（edge/say 真实合成；openai/local 走接口）：浅检只探引擎与配置，不合成
    try {
      const ttsProvider = String(effective.tts?.provider || '').trim().toLowerCase()
      const ttsCfg = { provider: effective.tts?.provider, model: effective.tts?.model, voice: effective.tts?.voice }
      if (!effective.enabled.tts) {
        out.services.tts = { ok: true, ...ttsCfg, note: 'disabled' }
      } else if (!ttsProvider || ttsProvider === 'none') {
        out.services.tts = { ok: false, ...ttsCfg, note: 'provider_not_configured' }
      } else if (ttsProvider === 'edge') {
        const edgePython = path.resolve(ctx.__dirname, '../../../tools/tts-venv/bin/python')
        out.services.tts = existsSync(edgePython)
          ? { ok: true, ...ttsCfg, note: 'engine_ready' }
          : { ok: false, ...ttsCfg, note: 'engine_missing_tools_tts_venv' }
      } else if (ttsProvider === 'say') {
        out.services.tts = { ok: true, ...ttsCfg, note: 'builtin_say' }
      } else if (ttsProvider === 'doubao') {
        out.services.tts = { ok: false, ...ttsCfg, note: 'tts_provider_pending' }
      } else {
        const hasUrl = Boolean(String(effective.tts?.apiUrl || '').trim())
        out.services.tts = { ok: hasUrl, ...ttsCfg, note: hasUrl ? 'configured' : 'missing_api_url' }
      }
    } catch (e) {
      out.services.tts = { ok: false, provider: effective.tts?.provider, model: effective.tts?.model, note: e && e.message ? String(e.message) : String(e) }
    }
  }

  const okTargets = ['server']
  if (checkScripts) okTargets.push('scripts')
  if (checkPrompt) okTargets.push('prompt')
  if (checkTranslation) okTargets.push('translation')
  if (checkImage) okTargets.push('image')
  if (checkReview) okTargets.push('review')
  if (checkTts) okTargets.push('tts')
  out.ok = okTargets.every((k) => out.services[k] && out.services[k].ok !== false)
  return c.json({ success: true, diagnostics: out })
})

app.get('/api/ai/rules', async (c) => {
  const rules = await readGlobalRules(ctx.ROOT)
  return c.json({ success: true, rules: rules || null })
})

app.put('/api/ai/rules', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const rulesIn = body?.rules
  const saved = await writeGlobalRules(ctx.ROOT, rulesIn)
  return c.json({ success: true, rules: saved })
})

app.get('/api/ai/prompt/templates', async (c) => {
  const items = await listPromptTemplates(ctx.ROOT)
  return c.json({ success: true, items })
})

app.post('/api/ai/prompt/templates/generate', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const title = String(body?.title || '').trim()
  if (!title) return c.json({ success: false, error: 'missing_title', message: '故事名称不能为空' }, 400)

  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  if (!studio.effective.enabled.scripts) {
    return c.json({ success: false, error: 'disabled', message: '“写故事（脚本生成）”已在设置中关闭' }, 503)
  }
  const provider = String(studio.effective.scripts.provider || '').trim().toLowerCase()
  if (!provider || provider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“写故事脚本”并选择 Provider/Model' }, 400)
  }

  const formula = {
    choicePoints: ctx.clampInt(body?.choicePoints, 1, 3, 2),
    optionsPerChoice: Number(body?.optionsPerChoice) === 3 ? 3 : 2,
    endings: Number(body?.optionsPerChoice) === 3 ? 3 : 2
  }
  const generated = await generateStoryPromptTemplate({
    title,
    templateKey: String(body?.templateKey || '').trim(),
    templateName: String(body?.templateName || '').trim(),
    templateSummary: String(body?.templateSummary || '').trim(),
    fields: body?.fields && typeof body.fields === 'object' ? body.fields : {},
    formula,
    provider,
    model: studio.effective.scripts.model || undefined,
    apiUrl: studio.effective.scripts.apiUrl || undefined,
    proxyUrl: studio.effective.network.proxyUrl
  })

  const saved = await savePromptTemplate(ctx.ROOT, {
    title: generated.result?.title || title,
    templateKey: String(body?.templateKey || '').trim() || null,
    templateName: String(body?.templateName || '').trim() || null,
    templateSummary: String(body?.templateSummary || '').trim() || null,
    prompt: String(generated.result?.prompt || '').trim(),
    notes: Array.isArray(generated.result?.notes) ? generated.result.notes : [],
    fields: body?.fields && typeof body.fields === 'object' ? body.fields : {},
    formula,
    meta: generated.meta || null
  })

  return c.json({ success: true, item: saved, generated: generated.result, meta: generated.meta || null })
})

app.post('/api/ai/prompt/templates', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const prompt = String(body?.prompt || '').trim()
  const title = String(body?.title || '').trim()
  if (!prompt) return c.json({ success: false, error: 'missing_prompt', message: '提示词不能为空' }, 400)

  const formula = {
    choicePoints: ctx.clampInt(body?.choicePoints, 1, 3, 2),
    optionsPerChoice: Number(body?.optionsPerChoice) === 3 ? 3 : 2,
    endings: Number(body?.optionsPerChoice) === 3 ? 3 : 2
  }
  const saved = await savePromptTemplate(ctx.ROOT, {
    title: title || null,
    templateKey: String(body?.templateKey || '').trim() || null,
    templateName: String(body?.templateName || '').trim() || null,
    templateSummary: String(body?.templateSummary || '').trim() || null,
    prompt,
    notes: Array.isArray(body?.notes) ? body.notes.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8) : [],
    fields: body?.fields && typeof body.fields === 'object' ? body.fields : {},
    formula,
    meta: body?.meta && typeof body.meta === 'object' ? body.meta : null
  })
  return c.json({ success: true, item: saved })
})

app.delete('/api/ai/prompt/templates/:id', async (c) => {
  const id = String(c.req.param('id') || '').trim()
  if (!id) return c.json({ success: false, error: 'missing_id', message: '模板 ID 不能为空' }, 400)
  const result = await deletePromptTemplate(ctx.ROOT, id)
  return c.json({ success: true, removed: Boolean(result.removed), items: result.items || [] })
})

// ============ 公共提示词库（跨项目共享，storage/_config/prompt_library.json） ============
app.get('/api/ai/prompt-library', async (c) => {
  const entries = await listPromptLibraryEntries(ctx.ROOT)
  return c.json({ success: true, entries })
})

app.post('/api/ai/prompt-library', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  try {
    const entry = await addPromptLibraryEntry(ctx.ROOT, body)
    return c.json({ success: true, entry })
  } catch (e) {
    return c.json({ success: false, error: e instanceof Error ? e.message : String(e), message: '中文/英文提示词至少填一项' }, 400)
  }
})

app.put('/api/ai/prompt-library/:id', async (c) => {
  const id = String(c.req.param('id') || '').trim()
  const body = await c.req.json().catch(() => ({}))
  try {
    const entry = await updatePromptLibraryEntry(ctx.ROOT, id, body)
    if (!entry) return c.json({ success: false, error: 'not_found', message: '条目不存在' }, 404)
    return c.json({ success: true, entry })
  } catch (e) {
    return c.json({ success: false, error: e instanceof Error ? e.message : String(e) }, 400)
  }
})

app.delete('/api/ai/prompt-library/:id', async (c) => {
  const id = String(c.req.param('id') || '').trim()
  if (!id) return c.json({ success: false, error: 'missing_id', message: '条目 ID 不能为空' }, 400)
  const result = await deletePromptLibraryEntry(ctx.ROOT, id)
  return c.json({ success: true, removed: Boolean(result.removed), entries: result.entries || [] })
})

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// 2026-09-09 计划写盘竞态治理（实测事故：乌鸦喝水参考图生成期间，瓶子步骤的整计划回写把小石子
// 的 generatedRefs/latestReferenceBatch 反复冲掉，refs 读数在 0/4/8 间翻转，锁定门禁拿不到评审记录）。
// 两板斧：
// 1) 项目级写串行：同一 projectId 的 saveStoryAssetPlan 全部进入进程内 promise 链，写与写不再交错；
// 2) mergeAssetsById 合并写：保存时重读磁盘计划，按资产 id 合并（入站资产条目优先、磁盘独有条目保留），
//    解决"读-改-写"长窗口期内陈旧整计划覆盖他人新数据的问题（生成类写盘点启用；整计划重建/删除类不用）。

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// 2026-10-12 角色模板身份注入配套：动物锚点判定（耳朵/毛色词只对动物有意义）
// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// 项目阶段派生（单一来源）：script→blueprint→compose→export→playable，
// 与 /api/projects/summary 的 Hub 列表展示口径一致
// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// 按结构公式确定性拟合卡片（只做"减/重编号"，不编造内容）：
// ①每选择点选项数 > optionsPerChoice：保留前 N 个（重编号选项句），删除被裁选项的后果卡并重编号保留的；
// ②选择点总数 > choicePoints：仅保留前 choicePoints 个选择点，删除多余选择点卡及其全部后果卡；
// ③后果卡与其结局卡之间不得夹普通场景（夹着的删除）；
// ④结局卡裁剪到 endings 个并重编号；⑤重名卡去重。
// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// [拆分回收] 辅助定义 已回 index.js

// ComfyUI 能力检查：对比工作流所需节点/模型与实装情况，缺失项可自动修复
app.get('/api/ai/comfyui/capability-check', async (c) => {
  const studio = await getEffectiveStudioConfig(ctx.ROOT)
  const baseUrl = String(studio.effective.image.comfyuiBaseUrl || process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188').trim()
  const result = await checkComfyuiCapability({ baseUrl, comfyRoot: process.env.COMFYUI_ROOT })
  return c.json({ success: true, ...result })
})

// ComfyUI 自动修复：安装缺失 Python 依赖，可选重启 ComfyUI 使节点生效
app.post('/api/ai/comfyui/auto-fix', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const restart = Boolean(body?.restart)
  const scriptPath = path.resolve(ctx.__dirname, '../../../scripts/maintenance/comfyui_auto_fix.sh')
  try {
    const args = restart ? ['--restart'] : []
    const result = await ctx.runCommand('bash', [scriptPath, ...args], {
      env: { ...process.env },
      maxBuffer: 8 * 1024 * 1024
    })
    return c.json({ success: true, restart, stdout: String(result.stdout || '').slice(-4000), stderr: String(result.stderr || '').slice(-2000) })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    return c.json({ success: false, error: 'auto_fix_failed', message: msg.slice(-2000) }, 500)
  }
})
}
