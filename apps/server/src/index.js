import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import { mkdir, readFile, readdir, rename, stat, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pluginStoryPixi from './plugins/storyPixi.js'
import { genId, generateScriptDraft, guessTitleFromPrompt, repairScriptDraft } from './ai/scripts.js'
import { getAiStatusSnapshot, runAiDiagnostics } from './ai/diagnostics.js'
import { analyzeScriptsForBlueprint } from './ai/analyze.js'
import { readGlobalRules, writeGlobalRules } from './ai/globalRules.js'
import { generateBackgroundImage, generateComfyuiLineartFromReference, generateComfyuiWhiteBackgroundFromReference, mapComfySampler, mapComfyScheduler, normalizeComfyCheckpointName, parseComfyTimeoutMs, runComfyuiPromptWorkflow } from './ai/background.js'
import { generateBackgroundPrompt } from './ai/imagePrompt.js'
import { reviewStoryPromptLocally, reviewStoryPromptWithAi } from './ai/promptReview.js'
import { normalizeStoryboardPromptReviewInput, reviewStoryboardPromptLocally, reviewStoryboardPromptWithAi } from './ai/storyboardPromptReview.js'
import { deletePromptTemplate, generateStoryPromptTemplate, listPromptTemplates, savePromptTemplate } from './ai/promptTemplates.js'
import { enhanceStoryAssetPromptWithAi } from './ai/storyAssetPromptEnhance.js'
import { generateCharacterFingerprint } from './ai/characterPrompt.js'
import { generateStoryBible } from './ai/storyBible.js'
import { translatePromptText } from './ai/translate.js'
import { buildStoryAssetPlan, buildStoryAssetReferenceNegativePrompt, buildStoryAssetReferencePrompt, buildStorySceneRenderSpec, getStoryAssetRenderProfile, summarizeStoryAssetPlan } from './ai/storyAssets.js'
import { buildStoryboardLockTestNegativePrompt, buildStoryboardLockTestPrompt, buildStoryboardLockTestWorkflow, pickStoryboardLockTestAsset, reviewStoryboardLockImageWithAi } from './ai/storyLock.js'
import { getDoubaoImagesConfigSnapshot } from './ai/doubao.js'
import { diagnoseOllamaText } from './ai/ollama.js'
import { classifyAiError, createTraceId, logStage } from './ai/runtime.js'
import { compileBlueprintFromScripts, normalizeScriptCardsForBlueprint } from './blueprint/compile.js'
import { validateBlueprintDoc } from './blueprint/validate.js'
import { loadEnv } from './env.js'
import { diagnoseOpenAI, isOpenAICompatibleProvider, reviewBlueprintViaOpenAI } from './ai/openai.js'
import { reviewBlueprintLocally } from './ai/blueprintReviewLocal.js'
import dns from 'node:dns/promises'
import { getEffectiveStudioConfig, redactStudioSettingsForClient, writeStudioSettings } from './studio/settings.js'
import { normalizeProjectDoc } from './studio/projectState.js'
import { getStudioSecret } from './studio/secrets.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../../..')

const app = new Hono()

// Load .env/.env.local for local development (do not commit secrets).
const envInfo = loadEnv({ startDirs: [PROJECT_ROOT], maxHops: 1 })
try {
  const provider = String(process.env.STUDIO_AI_PROVIDER || 'local')
  const hasOpenAIKey = Boolean(String(process.env.OPENAI_API_KEY || '').trim())
  const hasLocalOxmlKey = Boolean(String(process.env.LOCALOXML_API_KEY || process.env.STUDIO_AI_API_KEY || process.env.OPENAI_API_KEY || '').trim())
  const model = String(process.env.LOCALOXML_MODEL || process.env.STUDIO_AI_MODEL || process.env.OPENAI_MODEL || '')
  console.log(
    `[gamestudio] env loaded=${envInfo.loaded.length ? envInfo.loaded.join(',') : '(none)'} aiProvider=${provider} localoxmlKey=${hasLocalOxmlKey ? 'set' : 'missing'} openaiKey=${hasOpenAIKey ? 'set' : 'missing'}${model ? ` model=${model}` : ''} aiInit=manual_only`
  )
} catch (_) {}

// Basic request logging (opt-out with STUDIO_SERVER_LOG_REQUESTS=0).
app.use('*', async (c, next) => {
  const enabled = String(process.env.STUDIO_SERVER_LOG_REQUESTS || '1').trim() !== '0'
  if (!enabled) return next()
  const start = Date.now()
  const url = c.req.url
  try {
    await next()
  } finally {
    const ms = Date.now() - start
    let pathname = url
    try {
      pathname = new URL(url).pathname
    } catch (_) {}
    const status = c.res && typeof c.res.status === 'number' ? c.res.status : 0
    console.log(`[${new Date().toISOString()}] ${c.req.method} ${pathname} -> ${status} (${ms}ms)`)
  }
})

// P0：允许本地 editor（8868）跨域调用 server（1999）
app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }))

app.get('/api/health', (c) => c.json({ ok: true, service: 'gamestudio_server' }))
app.get('/favicon.ico', (c) => c.body(null, 204))
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
// Storage root should live at repo root by default: gamestudio/storage/*
// For production/real usage, prefer setting STUDIO_STORAGE_ROOT to a repo-external path.
const DEFAULT_ROOT = path.resolve(__dirname, '../../../storage')
const ENV_ROOT = String(process.env.STUDIO_STORAGE_ROOT || '').trim()
const ROOT = ENV_ROOT
  ? (path.isAbsolute(ENV_ROOT) ? ENV_ROOT : path.resolve(process.cwd(), ENV_ROOT))
  : DEFAULT_ROOT
const PROJECTS_DIR = path.join(ROOT, 'projects')
const DEMO_LIBRARY_DIR = path.join(ROOT, 'demo_library')
const TOOL_VERSION = '0.1.0'

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(opts || {}) })
    const out = []
    const err = []
    p.stdout.on('data', (d) => out.push(d))
    p.stderr.on('data', (d) => err.push(d))
    p.on('error', (e) => reject(e))
    p.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(out).toString('utf-8'), stderr: Buffer.concat(err).toString('utf-8') })
        return
      }
      const msg = Buffer.concat(err).toString('utf-8') || `command_failed: ${cmd} exit=${code}`
      reject(new Error(msg))
    })
  })
}

async function packageDistAsZip(outDir, zipName) {
  const attempts = [
    async () => runCommand('zip', ['-qr', zipName, 'dist'], { cwd: outDir }),
    async () => runCommand('7z', ['a', '-tzip', zipName, 'dist'], { cwd: outDir }),
    async () => runCommand('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', 'dist', zipName], { cwd: outDir }),
    async () =>
      runCommand(
        'powershell',
        ['-NoProfile', '-Command', `Compress-Archive -Path "dist\\*" -DestinationPath "${zipName}" -Force`],
        { cwd: outDir }
      )
  ]
  let lastErr = null
  for (const fn of attempts) {
    try {
      await fn()
      return
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('zip_failed')
}

async function sanitizeExportIndexHtml(indexPath) {
  try {
    let html = await readFile(indexPath, 'utf-8')
    let next = html
    // Fix broken regex emitted by older template versions.
    next = next.replaceAll("replace(/^/+/, '')", "replace(/^\\\\/+/, '')")
    // Remove export-only topbar.
    next = next.replace(
      /<div id="topbar">[\s\S]*?<\/div>\s*<div id="stageUI">/m,
      '<div id="stageUI">'
    )
    // Ensure runtime text removes duplicated choice lines (e.g. "选项1: xxx", "Option 1: xxx").
    next = next.replace(
      /const displayText = showEnding[\s\S]*?if \(dialogTextEl\) dialogTextEl\.textContent = hasText \? String\(displayText\) : ''/m,
      `const displayText = showEnding
            ? (String(endingText || '').trim() ? String(endingText) : fallback)
            : (String(text || '').trim() ? String(text) : fallback)
          const filtered = String(displayText)
            .split(/\\r?\\n/)
            .filter((original) => !/^\\s*(?:选项|option)\\s*(?:\\d{1,2}|[A-Z]|[一二三四五六七八九十])\\s*[:：]/i.test(original))
            .map((ln) => ln.trim())
            .filter(Boolean)
            .join('\\n')
          const finalText = filtered || displayText
          const hasText = String(finalText || '').trim().length > 0
          if (dialogTextEl) dialogTextEl.textContent = hasText ? String(finalText) : ''`
    )
    if (next !== html) await writeFile(indexPath, next, 'utf-8')
  } catch (_) {}
}

async function buildProjectDistForExport(id, dir) {
  const buildId = 'latest'
  const out = projectBuildDir(id, buildId)
  try {
    await rm(out, { recursive: true, force: true })
  } catch (_) {}
  const dist = path.join(out, 'dist')
  await mkdir(dist, { recursive: true })
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  await pluginStoryPixi.build({ projectId: id, projectDir: dir, outDir: dist, toolVersion: TOOL_VERSION, logger })
  await sanitizeExportIndexHtml(path.join(dist, 'index.html'))
  return { buildId, out, dist }
}

function normalizeSdwebuiBaseUrl(raw) {
  let s = String(raw || '').trim()
  if (!s) s = String(process.env.SDWEBUI_BASE_URL || 'http://127.0.0.1:7860')
  s = s.replace(/\/+$/, '')
  s = s.replace(/\/sdapi\/v1$/i, '')
  return s || 'http://127.0.0.1:7860'
}

function normalizeComfyuiBaseUrl(raw) {
  let s = String(raw || '').trim()
  if (!s) s = String(process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188')
  s = s.replace(/\/+$/, '')
  return s || 'http://127.0.0.1:8188'
}

function normalizeComfyModelName(raw) {
  return String(raw || '').trim().replace(/\s+\[[^\]]+\]\s*$/, '').trim()
}

function extractComfyChoiceList(raw) {
  // ComfyUI object_info enum field shape is usually:
  // - ["a.safetensors", ...]
  // - [["a.safetensors", ...], {"tooltip":"..."}]
  // This helper normalizes both.
  if (Array.isArray(raw) && raw.length >= 1 && Array.isArray(raw[0])) {
    return raw[0].map((x) => String(x || '').trim()).filter(Boolean)
  }
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x || '').trim()).filter(Boolean)
  }
  return []
}

function extractStringListFromUnknown(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((x) => {
        if (x == null) return ''
        if (typeof x === 'string') return x.trim()
        if (typeof x === 'object') {
          const o = x
          return String(o.name || o.filename || o.file || o.model_name || '').trim()
        }
        return String(x).trim()
      })
      .filter(Boolean)
  }
  return []
}

app.get('/api/studio/settings', async (c) => {
  const { settings, effective } = await getEffectiveStudioConfig(ROOT)
  return c.json({ success: true, settings: redactStudioSettingsForClient(settings) || null, effective })
})

app.put('/api/studio/settings', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const saved = await writeStudioSettings(ROOT, body && body.settings ? body.settings : body)
  return c.json({ success: true, settings: redactStudioSettingsForClient(saved) || null })
})

app.get('/api/studio/sdwebui/models', async (c) => {
  const q = c.req.query()
  const baseUrl = normalizeSdwebuiBaseUrl(q.baseUrl || process.env.SDWEBUI_BASE_URL)
  const timeoutMs = clampInt(q.timeoutMs, 1_000, 30_000, 8_000)
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
  const baseUrl = normalizeComfyuiBaseUrl(q.baseUrl || process.env.COMFYUI_BASE_URL)
  const timeoutMs = clampInt(q.timeoutMs, 1_000, 30_000, 8_000)
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
    const modelSet = new Set(extractComfyChoiceList(ckpts))
    const modelsJson = modelsResp && modelsResp.ok ? await modelsResp.json().catch(() => null) : null
    const ckptListJson = ckptListResp && ckptListResp.ok ? await ckptListResp.json().catch(() => null) : null
    for (const x of extractStringListFromUnknown(ckptListJson)) modelSet.add(String(x || '').trim())
    if (modelsJson && typeof modelsJson === 'object') {
      for (const x of extractStringListFromUnknown(modelsJson.checkpoints)) modelSet.add(String(x || '').trim())
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
    for (const x of extractComfyChoiceList(loraA)) {
      const s = String(x || '').trim()
      if (s) loraSet.add(s)
    }
    for (const x of extractComfyChoiceList(loraB)) {
      const s = String(x || '').trim()
      if (s) loraSet.add(s)
    }
    const loraListJson = loraListResp && loraListResp.ok ? await loraListResp.json().catch(() => null) : null
    for (const x of extractStringListFromUnknown(loraListJson)) loraSet.add(String(x || '').trim())
    if (modelsJson && typeof modelsJson === 'object') {
      for (const x of extractStringListFromUnknown(modelsJson.loras)) loraSet.add(String(x || '').trim())
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

function normalizeConfiguredLoraNames(raw) {
  const arr = Array.isArray(raw) ? raw : []
  const out = []
  const seen = new Set()
  for (const item0 of arr) {
    const item = String(item0 || '').trim()
    if (!item) continue
    const name = String(item.split(':')[0] || '').trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

function hasAnimalSignals(text) {
  const s = String(text || '').trim().toLowerCase()
  if (!s) return false
  if (/[猫狗兔狐狼虎狮熊鹿马牛羊猴鸟鼠]/.test(s)) return true
  return [
    'kitten', 'cat', 'feline', 'puppy', 'dog', 'canine', 'rabbit', 'bunny',
    'fox', 'wolf', 'bear', 'tiger', 'lion', 'mouse', 'rat', 'deer',
    'animal', 'furry', 'fur', 'anthropomorphic'
  ].some((token) => s.includes(token))
}

function hasHumanSignals(text) {
  const s = String(text || '').trim().toLowerCase()
  if (!s) return false
  if (/[人物男孩女孩女人男人小孩儿童少女少年]/.test(s)) return true
  return [
    'human', 'person', 'girl', 'boy', 'woman', 'man', 'lady', 'child',
    'kid', 'people', 'portrait'
  ].some((token) => s.includes(token))
}

function chooseStoryboardAssetLoras({ asset, requestedLoras }) {
  const category = String(asset && asset.category || '').trim().toLowerCase()
  const lockProfile = String(asset && asset.lockProfile || '').trim().toLowerCase()
  const rawExplicit = Array.isArray(requestedLoras) ? requestedLoras.map((x) => String(x || '').trim()).filter(Boolean) : []
  const isProtectedProp = category === 'prop' && ['wearable_prop', 'slender_prop', 'rigid_prop', 'soft_prop', 'ambient_prop', 'organic_prop'].includes(lockProfile)
  const isSafePropReferenceLora = (entry) => {
    const name = String(entry || '').trim().toLowerCase()
    if (!name) return false
    if (/(child|children|storybook|picturebook|book_illustration|genrih|furry|portrait|character|face|animal)/i.test(name)) return false
    if (/(flat.?2d|cutout|game.?props?|game.?prop|object|asset)/i.test(name)) return true
    return false
  }
  const explicit = isProtectedProp ? rawExplicit.filter(isSafePropReferenceLora) : rawExplicit
  const byKey = new Map()
  const push = (entry) => {
    const raw = String(entry || '').trim()
    if (!raw) return
    const key = normalizeComfyLoraKey(raw.split(':')[0] || '')
    if (!key || byKey.has(key)) return
    byKey.set(key, raw)
  }

  for (const item of explicit) push(item)

  const styleDefault = 'Childrens_book_illustration_by_Genrih_Valk.safetensors:0.7'
  const furryDefault = 'Anime_Furry_Style_SDXL.safetensors:0.7'
  if (!explicit.length && category !== 'prop') push(styleDefault)
  const signalText = [
    String(asset && asset.name || '').trim(),
    String(asset && asset.anchorPrompt || '').trim(),
    Array.isArray(asset && asset.aliases) ? asset.aliases.map((x) => String(x || '').trim()).join(' ') : ''
  ].join(' ')
  const isAnimalCharacter = category === 'character' && hasAnimalSignals(signalText)
  const isHumanCharacter = category === 'character' && !isAnimalCharacter && hasHumanSignals(signalText)

  if (isAnimalCharacter) push(furryDefault)
  if (isHumanCharacter && !explicit.length) push(styleDefault)

  return Array.from(byKey.values())
}

function normalizeComfyModelKey(raw) {
  return normalizeComfyModelName(raw)
    .replace(/^.*[\\/]/, '')
    .replace(/\.(safetensors|ckpt|pt|pth)$/i, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase()
}

function storyAssetCheckpointCandidates(asset) {
  const category = storyAssetStr(asset && asset.category).trim().toLowerCase()
  const lockProfile = storyAssetStr(asset && asset.lockProfile).trim().toLowerCase()
  const lockWorkflow = storyAssetStr(asset && asset.lockWorkflow).trim().toLowerCase()
  const signalText = [
    storyAssetStr(asset && asset.name),
    storyAssetStr(asset && asset.anchorPrompt),
    ...(Array.isArray(asset && asset.aliases) ? asset.aliases : [])
  ].join(' ').toLowerCase()

  const envCandidates = []
  const pushEnv = (name) => {
    const value = String(process.env[name] || '').trim()
    if (value) envCandidates.push(value)
  }
  pushEnv('STUDIO_ASSET_MODEL_DEFAULT')
  if (category === 'character') pushEnv('STUDIO_ASSET_MODEL_CHARACTER')
  if (category === 'location') pushEnv('STUDIO_ASSET_MODEL_LOCATION')
  if (lockProfile === 'wearable_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_WEARABLE')
  if (lockProfile === 'slender_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_SLENDER')
  if (lockProfile === 'rigid_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_RIGID')
  if (lockProfile === 'soft_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_SOFT')
  if (lockProfile === 'ambient_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_AMBIENT')
  if (lockProfile === 'organic_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_ORGANIC')
  if (category === 'prop') pushEnv('STUDIO_ASSET_MODEL_PROP_GENERIC')

  const byPriority = []
  const push = (...items) => byPriority.push(...items.filter(Boolean))
  push(...envCandidates)

  if (category === 'character' || category === 'location') {
    push('ivisionIllustration_ivision10.safetensors', 'ivisionIllustration', 'sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0')
    return byPriority
  }
  if (lockProfile === 'wearable_prop' || lockProfile === 'soft_prop' || lockProfile === 'ambient_prop' || lockProfile === 'organic_prop') {
    push('ivisionIllustration_ivision10.safetensors', 'ivisionIllustration', 'sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0')
    return byPriority
  }
  if (lockProfile === 'slender_prop') {
    if (/\b(bobber|float)\b|浮漂|漂子/.test(signalText)) {
      push('ivisionIllustration_ivision10.safetensors', 'ivisionIllustration', 'sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0')
    } else {
      push('sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0', 'ivisionIllustration_ivision10.safetensors', 'ivisionIllustration')
    }
    return byPriority
  }
  if (lockProfile === 'rigid_prop' || lockWorkflow === 'prop_product') {
    push('sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0', 'ivisionIllustration_ivision10.safetensors', 'ivisionIllustration')
    return byPriority
  }
  if (category === 'prop') {
    push('ivisionIllustration_ivision10.safetensors', 'ivisionIllustration', 'sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0')
    return byPriority
  }
  push('sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0', 'ivisionIllustration_ivision10.safetensors', 'ivisionIllustration')
  return byPriority
}

function pickBestStoryboardAssetModel(models, asset) {
  const list = Array.isArray(models) ? models.map((x) => String(x || '').trim()).filter(Boolean) : []
  if (!list.length) return ''
  const exactMap = new Map(list.map((item) => [normalizeComfyModelKey(item), item]))
  for (const candidate of storyAssetCheckpointCandidates(asset)) {
    const key = normalizeComfyModelKey(candidate)
    if (key && exactMap.has(key)) return exactMap.get(key) || ''
  }
  for (const candidate of storyAssetCheckpointCandidates(asset)) {
    const key = normalizeComfyModelKey(candidate)
    if (!key) continue
    const hit = list.find((item) => normalizeComfyModelKey(item).includes(key) || key.includes(normalizeComfyModelKey(item)))
    if (hit) return hit
  }
  return list[0] || ''
}

async function resolveStoryboardAssetModel({ studio, imgProvider, requestedModel, asset }) {
  const explicit = normalizeComfyModelName(requestedModel)
  if (explicit || String(imgProvider || '').trim().toLowerCase() !== 'comfyui') {
    return {
      model: explicit || String(studio?.effective?.image?.model || '').trim(),
      source: explicit ? 'explicit' : 'studio_default',
      availableModels: []
    }
  }
  const configured = normalizeComfyModelName(studio?.effective?.image?.model)
  const modelsRoot = normalizeLocalPath(studio?.effective?.image?.comfyuiModelsRoot)
  let availableModels = []
  if (modelsRoot) {
    const base = await resolveSdWebuiModelsBase(modelsRoot)
    const ckptDir = await pickCheckpointDir(base)
    availableModels = ckptDir ? await scanModelFiles(ckptDir, { exts: ['.safetensors', '.ckpt'], maxDepth: 4 }) : []
  }
  if (!availableModels.length) {
    const baseUrl = normalizeComfyuiBaseUrl(studio?.effective?.image?.comfyuiBaseUrl)
    const cap = await collectComfyCapabilities(baseUrl, 12_000, []).catch(() => null)
    availableModels = Array.isArray(cap?.models) ? cap.models : []
  }
  const chosen = pickBestStoryboardAssetModel(availableModels, asset)
  if (chosen) {
    return { model: chosen, source: 'asset_profile_auto', availableModels }
  }
  return { model: configured, source: configured ? 'studio_default' : 'provider_fallback', availableModels }
}

function normalizeComfyLoraKey(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  const base = s.replace(/^.*[\\/]/, '')
  return base
    .replace(/\s+\[[^\]]+\]\s*$/, '')
    .replace(/\.(safetensors|ckpt|pt|pth)$/i, '')
    .trim()
    .toLowerCase()
}

async function collectComfyCapabilities(baseUrl, timeoutMs, requiredNodes = null) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const nodes = Array.isArray(requiredNodes) && requiredNodes.length
      ? requiredNodes.map((x) => String(x || '').trim()).filter(Boolean)
      : ['CheckpointLoaderSimple', 'CLIPTextEncode', 'KSampler', 'VAEDecode', 'SaveImage']
    const checks = await Promise.all(nodes.map(async (node) => {
      const resp = await fetch(`${baseUrl}/object_info/${encodeURIComponent(node)}`, { method: 'GET', signal: controller.signal }).catch(() => null)
      return { node, ok: Boolean(resp && resp.ok) }
    }))
    const missingNodes = checks.filter((x) => !x.ok).map((x) => x.node)

    const [ckptInfoResp, ckptListResp, modelsResp, loraListResp, loraInfoResp] = await Promise.all([
      fetch(`${baseUrl}/object_info/CheckpointLoaderSimple`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/models/checkpoints`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/models`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/models/loras`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/object_info/LoraLoader`, { method: 'GET', signal: controller.signal }).catch(() => null)
    ])

    const modelSet = new Set()
    const loraSet = new Set()

    const ckptInfoJson = ckptInfoResp && ckptInfoResp.ok ? await ckptInfoResp.json().catch(() => null) : null
    const ckpts = ckptInfoJson && ckptInfoJson.CheckpointLoaderSimple && ckptInfoJson.CheckpointLoaderSimple.input && ckptInfoJson.CheckpointLoaderSimple.input.required
      ? ckptInfoJson.CheckpointLoaderSimple.input.required.ckpt_name
      : null
    for (const x of extractComfyChoiceList(ckpts)) modelSet.add(String(x || '').trim())

    const ckptListJson = ckptListResp && ckptListResp.ok ? await ckptListResp.json().catch(() => null) : null
    for (const x of extractStringListFromUnknown(ckptListJson)) modelSet.add(String(x || '').trim())

    const modelsJson = modelsResp && modelsResp.ok ? await modelsResp.json().catch(() => null) : null
    if (modelsJson && typeof modelsJson === 'object') {
      for (const x of extractStringListFromUnknown(modelsJson.checkpoints)) modelSet.add(String(x || '').trim())
      for (const x of extractStringListFromUnknown(modelsJson.loras)) loraSet.add(String(x || '').trim())
    }

    const loraListJson = loraListResp && loraListResp.ok ? await loraListResp.json().catch(() => null) : null
    for (const x of extractStringListFromUnknown(loraListJson)) loraSet.add(String(x || '').trim())

    const loraInfoJson = loraInfoResp && loraInfoResp.ok ? await loraInfoResp.json().catch(() => null) : null
    const loraNames = loraInfoJson && loraInfoJson.LoraLoader && loraInfoJson.LoraLoader.input && loraInfoJson.LoraLoader.input.required
      ? loraInfoJson.LoraLoader.input.required.lora_name
      : null
    for (const x of extractComfyChoiceList(loraNames)) loraSet.add(String(x || '').trim())

    return {
      ok: true,
      missingNodes,
      models: Array.from(modelSet).filter(Boolean),
      loras: Array.from(loraSet).filter(Boolean)
    }
  } finally {
    clearTimeout(t)
  }
}

async function fetchComfyModelList(baseUrl, path, signal) {
  try {
    const resp = await fetch(`${baseUrl}${path}`, { method: 'GET', signal }).catch(() => null)
    if (!resp) return { ok: false, status: 0, supported: false, list: [] }
    if (Number(resp.status || 0) === 404) return { ok: false, status: 404, supported: false, list: [] }
    const json = resp.ok ? await resp.json().catch(() => null) : null
    const list = Array.isArray(json) ? json.map((x) => String(x || '').trim()).filter(Boolean) : []
    return { ok: Boolean(resp.ok), status: Number(resp.status || 0), supported: true, list }
  } catch (_) {
    return { ok: false, status: 0, supported: false, list: [] }
  }
}

async function probeComfyAnyNode(baseUrl, names, signal) {
  const tried = []
  for (const n0 of names) {
    const n = String(n0 || '').trim()
    if (!n) continue
    tried.push(n)
    const resp = await fetch(`${baseUrl}/object_info/${encodeURIComponent(n)}`, { method: 'GET', signal }).catch(() => null)
    if (resp && resp.ok) return { ok: true, found: n, tried }
  }
  return { ok: false, found: '', tried }
}

async function isDir(p) {
  try {
    const st = await stat(String(p))
    return Boolean(st && st.isDirectory())
  } catch (_) {
    return false
  }
}

async function pickExistingDir(root, candidates) {
  const base = String(root || '').trim()
  if (!base) return ''
  for (const c0 of candidates) {
    const c = String(c0 || '').trim()
    if (!c) continue
    const p = path.join(base, c)
    if (await isDir(p)) return p
  }
  return ''
}

async function hasAnyModelInDirs(dirs) {
  const list = Array.isArray(dirs) ? dirs.map((x) => String(x || '').trim()).filter(Boolean) : []
  let total = 0
  for (const d of list) {
    const r = await hasAnyModelFile(d)
    if (r.ok && r.count) {
      total += r.count
      break
    }
  }
  return { ok: true, count: total }
}

async function hasAnyModelFile(dirPath) {
  try {
    const dir = String(dirPath || '').trim()
    if (!dir) return { ok: false, count: 0 }
    if (!(await isDir(dir))) return { ok: true, count: 0 }
    const items = await readdir(dir).catch(() => [])
    let count = 0
    for (const name of items) {
      const s = String(name || '')
      if (!s) continue
      if (!/\.(safetensors|ckpt|pt|pth|bin)$/i.test(s)) continue
      count += 1
      if (count >= 1) break
    }
    return { ok: true, count }
  } catch (_) {
    return { ok: false, count: 0 }
  }
}

app.post('/api/studio/image/preflight', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const timeoutMs = clampInt(body?.timeoutMs, 2_000, 60_000, 10_000)
  const mode = String(body?.mode || 'basic').trim().toLowerCase() === 'storyboard' ? 'storyboard' : 'basic'
  const settingsOverride = body && body.settings && typeof body.settings === 'object' ? body.settings : null
  const { effective } = await getEffectiveStudioConfig(ROOT, { settingsOverride })

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

  const baseUrl = normalizeComfyuiBaseUrl(effective.image.comfyuiBaseUrl)
  const modelsRoot = normalizeLocalPath(effective.image.comfyuiModelsRoot)
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
      // For storyboard continuity we expect ControlNet + IP-Adapter to be available.
      // Note: `extCount` is for SD-WebUI ControlNet extension models, which are not
      // automatically visible to ComfyUI unless the user links/copies/configures paths.
      controlnet: { ok: false, missingNodes: [], modelsOk: false, modelsSupported: false, modelsCount: 0, diskCount: 0, extCount: 0 },
      ipadapter: { ok: false, missingNodes: [], modelsOk: false, modelsSupported: false, modelsCount: 0, diskCount: 0 }
    },
    hints: {
      comfyuiModelsRoot: modelsRoot || null,
      comfyuiModelDir: 'ComfyUI/models/checkpoints',
      comfyuiLoraDir: 'ComfyUI/models/loras',
      comfyuiControlnetDir: 'ComfyUI/models/controlnet',
      comfyuiIpadapterDir: 'ComfyUI/models/ipadapter',
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

    const cap = await collectComfyCapabilities(baseUrl, timeoutMs, requiredNodes)
    check.missingNodes = Array.isArray(cap.missingNodes) ? cap.missingNodes : []
    if (check.missingNodes.length) {
      check.reason = 'missing_required_nodes'
      return c.json({ success: false, error: 'preflight_failed', checks: check }, 400)
    }

    // Update hint dirs if modelsRoot is configured.
    if (modelsRoot) {
      const base = await resolveSdWebuiModelsBase(modelsRoot)
      const ckptDir = await pickCheckpointDir(base)
      const loraDir = await pickLoraDir(base)
      const cnDir = await pickExistingDir(base, ['ControlNet', 'controlnet'])
      const ipaDir = await pickExistingDir(base, ['ipadapter', 'IPAdapter'])
      // SD-WebUI ControlNet extension models (common when sharing SD-WebUI folder):
      // <webuiRoot>/extensions/sd-webui-controlnet/models
      const webuiRoot = path.dirname(base || modelsRoot)
      const cnExtDir = await pickExistingDir(webuiRoot, ['extensions/sd-webui-controlnet/models'])
      if (ckptDir) check.hints.comfyuiModelDir = ckptDir
      if (loraDir) check.hints.comfyuiLoraDir = loraDir
      if (cnDir) check.hints.comfyuiControlnetDir = cnDir
      if (ipaDir) check.hints.comfyuiIpadapterDir = ipaDir
      check.disk.checkpointsDir = ckptDir || check.disk.checkpointsDir
      check.disk.lorasDir = loraDir || check.disk.lorasDir
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
        const cnLoader = await probeComfyAnyNode(baseUrl, ['ControlNetLoader', 'ControlNetLoaderAdvanced'], sig)
        const cnApply = await probeComfyAnyNode(baseUrl, ['ControlNetApply', 'ControlNetApplyAdvanced'], sig)
        const cnMissing = []
        if (!cnLoader.ok) cnMissing.push('ControlNetLoader')
        if (!cnApply.ok) cnMissing.push('ControlNetApply')
        check.extras.controlnet.missingNodes = cnMissing
        // ControlNet models list (best-effort)
        const cnModels = await fetchComfyModelList(baseUrl, '/models/controlnet', sig)
        check.extras.controlnet.modelsSupported = Boolean(cnModels.supported)
        check.extras.controlnet.modelsCount = Array.isArray(cnModels.list) ? cnModels.list.length : 0
        if (check.extras.controlnet.modelsSupported) {
          check.extras.controlnet.modelsOk = check.extras.controlnet.modelsCount > 0
        } else if (modelsRoot) {
          // Disk check should focus on ComfyUI-visible ControlNet dir. SD-WebUI extension models
          // are reported separately as a "can be linked" hint.
          const cnDir = String(check.hints.comfyuiControlnetDir || '').trim()
          if (cnDir) {
            const disk = await hasAnyModelFile(cnDir)
            check.extras.controlnet.diskCount = disk.ok ? disk.count : 0
            check.extras.controlnet.modelsOk = disk.ok && disk.count > 0
          } else {
            check.extras.controlnet.diskCount = 0
            check.extras.controlnet.modelsOk = false
          }
          const extDir = String(check.disk.controlnetExtDir || '').trim()
          if (extDir) {
            const ext = await hasAnyModelFile(extDir)
            check.extras.controlnet.extCount = ext.ok ? ext.count : 0
          }
        } else {
          check.extras.controlnet.modelsOk = false
        }
        check.extras.controlnet.ok = cnMissing.length === 0 && check.extras.controlnet.modelsOk

        // IP-Adapter nodes (ComfyUI_IPAdapter_plus and variants)
        const ipaLoader = await probeComfyAnyNode(baseUrl, ['IPAdapterModelLoader', 'IPAdapterLoader', 'IPAdapterUnifiedLoader'], sig)
        const ipaApply = await probeComfyAnyNode(baseUrl, ['IPAdapterApply', 'IPAdapterApplyAdvanced', 'IPAdapterAdvanced'], sig)
        const ipaMissing = []
        if (!ipaLoader.ok) ipaMissing.push('IPAdapterModelLoader')
        if (!ipaApply.ok) ipaMissing.push('IPAdapterApply')
        check.extras.ipadapter.missingNodes = ipaMissing
        const ipaModels = await fetchComfyModelList(baseUrl, '/models/ipadapter', sig)
        check.extras.ipadapter.modelsSupported = Boolean(ipaModels.supported)
        check.extras.ipadapter.modelsCount = Array.isArray(ipaModels.list) ? ipaModels.list.length : 0
        if (check.extras.ipadapter.modelsSupported) {
          check.extras.ipadapter.modelsOk = check.extras.ipadapter.modelsCount > 0
        } else if (modelsRoot && check.hints.comfyuiIpadapterDir) {
          const disk = await hasAnyModelFile(check.hints.comfyuiIpadapterDir)
          check.extras.ipadapter.diskCount = disk.ok ? disk.count : 0
          check.extras.ipadapter.modelsOk = disk.ok && disk.count > 0
        } else {
          check.extras.ipadapter.modelsOk = false
        }
        check.extras.ipadapter.ok = ipaMissing.length === 0 && check.extras.ipadapter.modelsOk
      } finally {
        clearTimeout(t2)
      }

      if (!check.extras.controlnet.ok || !check.extras.ipadapter.ok) {
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
  const { effective } = await getEffectiveStudioConfig(ROOT, { settingsOverride })

  if (!effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: 'image_disabled' }, 503)
  }

  const provider = String(effective.image.provider || '').toLowerCase()
  if (!provider || provider === 'none') {
    return c.json({ success: false, error: 'provider_not_configured', message: 'provider_none' }, 400)
  }

  const baseUrl =
    provider === 'comfyui'
      ? normalizeComfyuiBaseUrl(effective.image.comfyuiBaseUrl)
      : provider === 'sdwebui'
        ? normalizeSdwebuiBaseUrl(effective.image.sdwebuiBaseUrl)
        : ''

  // Prefer disk scan when a shared Models Root is configured for ComfyUI.
  if (provider === 'comfyui') {
    const modelsRoot = normalizeLocalPath(effective.image.comfyuiModelsRoot)
    if (modelsRoot) {
      const base = await resolveSdWebuiModelsBase(modelsRoot)
      const ckptDir = await pickCheckpointDir(base)
      const loraDir = await pickLoraDir(base)
      const models = ckptDir ? await scanModelFiles(ckptDir, { exts: ['.safetensors', '.ckpt'], maxDepth: 4 }) : []
      const loras = loraDir ? await scanModelFiles(loraDir, { exts: ['.safetensors'], maxDepth: 4 }) : []
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
      const cap = await collectComfyCapabilities(baseUrl, 12_000, [])
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
  const timeoutMs = clampInt(body?.timeoutMs, 5_000, 300_000, 60_000)
  const settingsOverride = body && body.settings && typeof body.settings === 'object' ? body.settings : null
  const { effective } = await getEffectiveStudioConfig(ROOT, { settingsOverride })
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
      const baseUrl = normalizeComfyuiBaseUrl(effective.image.comfyuiBaseUrl)
      const modelConfigured = requestedModel || String(effective.image.model || '').trim()
      const lorasConfigured = normalizeConfiguredLoraNames(requestedLoras.length ? requestedLoras : effective.image.loras)
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
        const cap = await collectComfyCapabilities(baseUrl, Math.min(timeoutMs, 15_000), requiredNodes)
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
        const loraKeySet = new Set(loras.map((x) => normalizeComfyLoraKey(x)).filter(Boolean))
        check.missingLoras = check.lorasConfigured.filter((name) => !loraKeySet.has(normalizeComfyLoraKey(name)))
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

  const width = clampInt(body?.width, 256, 1024, 512)
  const height = clampInt(body?.height, 256, 1024, 512)
  const style = normalizeStyleEnum(body?.style || 'picture_book')
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
  const timeoutMs = clampInt(body?.timeoutMs, 3_000, 60_000, 12_000)

  const settingsOverride = body && body.settings && typeof body.settings === 'object' ? body.settings : null
  const { effective } = await getEffectiveStudioConfig(ROOT, { settingsOverride })

  const out = {
    ok: true,
    checkedAt: new Date().toISOString(),
    effective,
    services: {
      server: { ok: true, note: 'health_ok' },
      scripts: { ok: true, provider: effective.scripts.provider, model: effective.scripts.model, note: '' },
      prompt: { ok: true, provider: effective.prompt.provider, model: effective.prompt.model, note: '' },
      translation: { ok: true, provider: effective.translation?.provider, model: effective.translation?.model, note: '' },
      image: { ok: true, provider: effective.image.provider, model: effective.image.model, note: '' },
      tts: effective.enabled.tts
        ? { ok: false, provider: effective.tts.provider, model: effective.tts.model, note: 'not_implemented' }
        : { ok: true, provider: effective.tts.provider, model: effective.tts.model, note: 'disabled' }
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
    const url = normalizeSdwebuiBaseUrl(baseUrl)
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(`${url}/sdapi/v1/options`, { method: 'GET', signal: controller.signal })
      if (!resp.ok) return { ok: false, provider: 'sdwebui', note: `HTTP_${resp.status}`, baseUrl: url, model: model || null }

      const modelName = normalizeComfyModelName(model)
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
    const url = normalizeComfyuiBaseUrl(baseUrl)
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

  const okTargets = ['server']
  if (checkScripts) okTargets.push('scripts')
  if (checkPrompt) okTargets.push('prompt')
  if (checkTranslation) okTargets.push('translation')
  if (checkImage) okTargets.push('image')
  out.ok = okTargets.every((k) => out.services[k] && out.services[k].ok !== false)
  return c.json({ success: true, diagnostics: out })
})

app.get('/api/ai/rules', async (c) => {
  const rules = await readGlobalRules(ROOT)
  return c.json({ success: true, rules: rules || null })
})

app.put('/api/ai/rules', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const rulesIn = body?.rules
  const saved = await writeGlobalRules(ROOT, rulesIn)
  return c.json({ success: true, rules: saved })
})

app.post('/api/ai/prompt/review', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const prompt = String(body?.prompt || '').trim()
  const title = String(body?.title || '').trim()
  const formula = {
    choicePoints: clampInt(body?.choicePoints, 1, 3, 2),
    optionsPerChoice: Number(body?.optionsPerChoice) === 3 ? 3 : 2,
    endings: Number(body?.optionsPerChoice) === 3 ? 3 : 2
  }

  const localReview = reviewStoryPromptLocally({ prompt, title, formula })
  const studio = await getEffectiveStudioConfig(ROOT).catch(() => null)
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
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const input = normalizeStoryboardPromptReviewInput(body)
  if (!String(input.projectTitle || '').trim()) {
    const project = await readProjectJson(id).catch(() => null)
    input.projectTitle = String(project && project.title ? project.title : '').trim()
  }

  const localReview = reviewStoryboardPromptLocally(input)
  const studio = await getEffectiveStudioConfig(ROOT).catch(() => null)
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

app.get('/api/ai/prompt/templates', async (c) => {
  const items = await listPromptTemplates(ROOT)
  return c.json({ success: true, items })
})

app.post('/api/ai/prompt/templates/generate', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const title = String(body?.title || '').trim()
  if (!title) return c.json({ success: false, error: 'missing_title', message: '故事名称不能为空' }, 400)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.scripts) {
    return c.json({ success: false, error: 'disabled', message: '“写故事（脚本生成）”已在设置中关闭' }, 503)
  }
  const provider = String(studio.effective.scripts.provider || '').trim().toLowerCase()
  if (!provider || provider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“写故事脚本”并选择 Provider/Model' }, 400)
  }

  const formula = {
    choicePoints: clampInt(body?.choicePoints, 1, 3, 2),
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

  const saved = await savePromptTemplate(ROOT, {
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
    choicePoints: clampInt(body?.choicePoints, 1, 3, 2),
    optionsPerChoice: Number(body?.optionsPerChoice) === 3 ? 3 : 2,
    endings: Number(body?.optionsPerChoice) === 3 ? 3 : 2
  }
  const saved = await savePromptTemplate(ROOT, {
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
  const result = await deletePromptTemplate(ROOT, id)
  return c.json({ success: true, removed: Boolean(result.removed), items: result.items || [] })
})

async function ensureDirs() {
  await mkdir(PROJECTS_DIR, { recursive: true })
  await mkdir(DEMO_LIBRARY_DIR, { recursive: true })
}

function projectDir(id) {
  return path.join(PROJECTS_DIR, String(id))
}

function projectBuildsDir(id) {
  return path.join(projectDir(id), 'builds')
}

function projectBuildDir(projectId, buildId) {
  return path.join(projectBuildsDir(projectId), String(buildId))
}

function projectStoryAssetsDir(id) {
  return path.join(projectDir(id), 'story-assets')
}

function projectStoryAssetsPlanPath(id) {
  return path.join(projectStoryAssetsDir(id), 'plan.json')
}

function demoLibDir(demoId) {
  return path.join(DEMO_LIBRARY_DIR, String(demoId))
}

async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf-8'))
}

async function writeJson(p, obj) {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(obj, null, 2), 'utf-8')
}

async function readProjectBundle(id) {
  const dir = projectDir(id)
  const rawProject = await readJson(path.join(dir, 'project.json'))
  const story = await readJson(path.join(dir, 'story.json'))
  return {
    dir,
    rawProject,
    project: normalizeProjectDoc(rawProject),
    story
  }
}

function parseJsonObjectText(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (_) {
    return null
  }
}

function readStoryBibleFromProjectDoc(project) {
  const state = project && project.state && typeof project.state === 'object' ? project.state : {}
  const aiBg = state && state.aiBackground && typeof state.aiBackground === 'object' ? state.aiBackground : {}
  if (aiBg.storyBible && typeof aiBg.storyBible === 'object') return aiBg.storyBible
  return parseJsonObjectText(aiBg.storyBibleJson)
}

async function readStoryAssetPlanIfExists(id) {
  const planPath = projectStoryAssetsPlanPath(id)
  if (!(await existsFile(planPath))) return null
  try {
    const plan = await readJson(planPath)
    return plan && typeof plan === 'object' ? plan : null
  } catch (_) {
    return null
  }
}

async function saveStoryAssetPlan(id, plan) {
  await writeJson(projectStoryAssetsPlanPath(id), plan)
}

function storyAssetStr(v) {
  return typeof v === 'string' ? v : ''
}

function hasCjkText(v) {
  return /[\u3400-\u9fff]/.test(storyAssetStr(v))
}

function looksLikeEnglishPrompt(v) {
  const s = storyAssetStr(v).trim()
  if (!s) return false
  if (hasCjkText(s)) return false
  return /[A-Za-z]{3,}/.test(s)
}

function pickEnglishPrompt(candidate, ...fallbacks) {
  const preferred = storyAssetStr(candidate).trim()
  if (looksLikeEnglishPrompt(preferred)) return preferred
  for (const fallback of fallbacks) {
    const alt = storyAssetStr(fallback).trim()
    if (looksLikeEnglishPrompt(alt)) return alt
  }
  return preferred || storyAssetStr(fallbacks.find(Boolean)).trim()
}

function splitStoryAssetPromptParts(input) {
  return storyAssetStr(input)
    .split(/[,\n，、|]/g)
    .map((x) => x.trim())
    .filter(Boolean)
}

function uniqStoryAssetPromptParts(parts, max = 120) {
  const out = []
  const seen = new Set()
  for (const part of parts) {
    const value = storyAssetStr(part).trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= max) break
  }
  return out
}

function sanitizeStoryAssetPromptZh({ asset, promptZh }) {
  const category = storyAssetStr(asset && asset.category).trim().toLowerCase()
  const lockProfile = storyAssetStr(asset && asset.lockProfile).trim().toLowerCase()
  const raw = storyAssetStr(promptZh).trim()
  if (!raw) return ''
  const isPropLike = category === 'prop' || lockProfile.endsWith('_prop')
  if (!isPropLike) return raw
  const parts = splitStoryAssetPromptParts(raw)
  const out = []
  let seenRole = false
  let seenStructure = false
  for (const part of parts) {
    const value = storyAssetStr(part).trim()
    if (!value) continue
    if (/^(关联场景|常与这些元素同场)\s*[:：]/.test(value)) continue
    if (/^故事职责\s*[:：]/.test(value)) {
      if (seenRole) continue
      seenRole = true
    }
    if (/^结构关注点\s*[:：]/.test(value)) {
      if (seenStructure) continue
      seenStructure = true
    }
    out.push(value)
  }
  return uniqStoryAssetPromptParts(out, 64).join('，')
}

function limitStoryAssetText(v, max = 160) {
  const s = storyAssetStr(v).trim()
  if (!s) return ''
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trim()}…`
}

function findStoryAssetScenes(plan, asset) {
  const wantedIds = new Set((Array.isArray(asset && asset.sceneIds) ? asset.sceneIds : []).map((item) => storyAssetStr(item).trim()).filter(Boolean))
  const scenes = Array.isArray(plan && plan.scenes) ? plan.scenes : []
  if (!wantedIds.size) return []
  return scenes.filter((scene) => {
    const sceneId = storyAssetStr(scene && scene.sceneId).trim()
    const fallbackId = storyAssetStr(scene && scene.id).trim()
    const sourceKey = storyAssetStr(scene && scene.sourceKey).trim()
    return wantedIds.has(sceneId) || wantedIds.has(fallbackId) || wantedIds.has(sourceKey)
  })
}

function storyAssetSignalHay(asset) {
  return [
    storyAssetStr(asset && asset.name),
    storyAssetStr(asset && asset.anchorPrompt),
    ...(Array.isArray(asset && asset.aliases) ? asset.aliases : [])
  ].join(' ').toLowerCase()
}

function isStoryAssetBobberLike(asset) {
  return /\b(bobber|float|fishing float)\b|浮漂|漂子/.test(storyAssetSignalHay(asset))
}

function isStoryAssetRodLike(asset) {
  return /\b(bamboo fishing rod|bamboo rod|fishing rod|fishing pole|pole)\b|竹鱼竿|鱼竿|竹竿/.test(storyAssetSignalHay(asset))
}

function isStoryAssetBucketLike(asset) {
  return /\b(bucket|pail)\b|鱼桶|木桶|水桶|桶/.test(storyAssetSignalHay(asset))
}

function isStoryAssetFishLike(asset) {
  return /\b(minnow|fish|silver fish)\b|小银鱼|小鱼|银鱼|鱼/.test(storyAssetSignalHay(asset))
}

function isStoryAssetButterflyLike(asset) {
  return /\b(butterfly|swallowtail)\b|蝴蝶|彩蝶/.test(storyAssetSignalHay(asset))
}

function buildStoryAssetUsageContext({ asset, plan }) {
  const name = storyAssetStr(asset && asset.name).trim()
  const aliases = uniqStoryAssetPromptParts(Array.isArray(asset && asset.aliases) ? asset.aliases : [], 12)
  const sceneEntries = findStoryAssetScenes(plan, asset)
  const eventChain = Array.isArray(plan && plan.eventChain) ? plan.eventChain : []
  const sceneNames = uniqStoryAssetPromptParts(sceneEntries.map((scene) => storyAssetStr(scene && scene.sceneName).trim()).filter(Boolean), 8)
  const sceneSummaries = uniqStoryAssetPromptParts(sceneEntries.map((scene) => storyAssetStr(scene && scene.summary).trim()).filter(Boolean), 8)
  const eventMentions = uniqStoryAssetPromptParts(sceneEntries.map((scene) => {
    const index = Number(scene && scene.sceneIndex)
    if (!Number.isFinite(index) || index <= 0) return ''
    return storyAssetStr(eventChain[index - 1]).trim()
  }).filter(Boolean), 8)
  const coAssetNames = uniqStoryAssetPromptParts(sceneEntries.flatMap((scene) => {
    const promptAssets = Array.isArray(scene && scene.promptAssets) ? scene.promptAssets : []
    return promptAssets
      .map((item) => storyAssetStr(item && item.name).trim())
      .filter((item) => item && item !== name && !aliases.includes(item))
  }), 12)
  const contextBlobZh = `${sceneSummaries.join('；')}；${sceneNames.join('；')}`
  const contextBlobEn = eventMentions.join(' ; ').toLowerCase()
  const roleHints = []
  if (/(背着|背在|背负|携带|随身|肩带)/.test(contextBlobZh) || /\b(back-carry|carrying|carry|carried)\b/.test(contextBlobEn)) {
    roleHints.push('是角色外出时会随身背携的道具')
  }
  if (/(装鱼|放进桶|放入桶|盛鱼|盛放|收纳)/.test(contextBlobZh) || /\b(place[ds]? into the bucket|fish is placed into the bucket|hold[s]? fish|carry small fish)\b/.test(contextBlobEn)) {
    roleHints.push('承担盛放钓到的小鱼或收纳渔获的剧情职责')
  }
  if (/(湖边|柳树|草地|水面|钓鱼|钓竿|浮漂)/.test(contextBlobZh) || /\b(lakeside|shore|lake|willow|water|fishing|rod|bobber)\b/.test(contextBlobEn)) {
    roleHints.push('属于乡村湖边垂钓语境中的朴素儿童道具')
  }
  if (/(回家|出发|回来|路上)/.test(contextBlobZh) || /\b(arrives?|walks home|path home|returns?)\b/.test(contextBlobEn)) {
    roleHints.push('会跟随角色往返场景，适合做成轻便耐用的小型随行物件')
  }
  const plotCueHints = []
  const fullNarrativeZh = `${sceneSummaries.join('；')}；${eventMentions.join('；')}`
  const signalText = `${storyAssetStr(asset && asset.anchorPrompt)} ${storyAssetStr(asset && asset.name)} ${(Array.isArray(asset && asset.aliases) ? asset.aliases.join(' ') : '')}`.toLowerCase()
  if (/(盯着|观察|看着|等待|远远看|远看|一眼认出|watch|waiting|watching|visible from afar|recognize at a glance)/i.test(`${fullNarrativeZh} ${contextBlobEn}`)) {
    plotCueHints.push('在中远景里也要一眼认出主要色块和外轮廓')
  }
  if (/(摇晃|晃动|下沉|浮在水面|浮起来|watch the bobber|bobber|tremble|sinks?|upright on calm water)/i.test(`${fullNarrativeZh} ${signalText} ${contextBlobEn}`)) {
    plotCueHints.push('要清楚表现直立浮姿、上下配色分区和远看可辨的顶端标记')
  }
  if (/(提着|背着|挂着|拿着|带着|系在|shoulder|carry|carried|hang|hung|held|tied to)/i.test(`${fullNarrativeZh} ${signalText} ${contextBlobEn}`)) {
    plotCueHints.push('连接点、提握点、挂点或绑缚点要清楚')
  }
  if (/(装进|放入|收纳|盛放|开口|容量|placed into|put into|holds?|contain|storage)/i.test(`${fullNarrativeZh} ${signalText} ${contextBlobEn}`)) {
    plotCueHints.push('开口、内部容积或收纳方式要明确')
  }
  if (/(戴着|戴上|佩戴|wearing|worn)/i.test(`${fullNarrativeZh} ${signalText} ${contextBlobEn}`)) {
    plotCueHints.push('虽然会被佩戴使用，但锁定图必须保留独立物件的开口和内侧结构')
  }
  const structureHints = []
  if (/(肩带|strap)/i.test(`${storyAssetStr(asset && asset.anchorPrompt)} ${contextBlobZh} ${contextBlobEn}`)) structureHints.push('肩带连接方式要清楚')
  if (/(提梁|提手|bail|handle)/i.test(`${storyAssetStr(asset && asset.anchorPrompt)} ${contextBlobZh} ${contextBlobEn}`)) structureHints.push('提梁和挂点结构要可读')
  if (/(开口|装鱼|盛放|bucket|pail|桶)/i.test(`${storyAssetStr(asset && asset.anchorPrompt)} ${contextBlobZh} ${contextBlobEn}`)) structureHints.push('开口、桶沿和内部容量感要明确')
  if (/(木|wood|woven|staves|iron band|金属箍|箍)/i.test(`${storyAssetStr(asset && asset.anchorPrompt)} ${contextBlobZh} ${contextBlobEn}`)) structureHints.push('材质分区和连接关系要稳定')

  if (isStoryAssetBucketLike(asset)) {
    roleHints.length = 0
    plotCueHints.length = 0
    structureHints.length = 0
    roleHints.push('是角色外出时会随身背携的小鱼桶')
    roleHints.push('承担盛放钓到的小鱼或临时收纳渔获的剧情职责')
    roleHints.push('属于乡村湖边垂钓语境中的朴素儿童道具')
    plotCueHints.push('在中远景里也要一眼认出桶身轮廓、提梁和肩带连接点')
    plotCueHints.push('要清楚表现开口、桶沿和内部容量感，避免被画成封闭盒子或普通花盆')
    structureHints.push('肩带连接方式要清楚')
    structureHints.push('提梁和挂点结构要可读')
    structureHints.push('开口、桶沿和内部容量感要明确')
    structureHints.push('材质分区和连接关系要稳定')
  } else if (isStoryAssetRodLike(asset)) {
    roleHints.length = 0
    plotCueHints.length = 0
    structureHints.length = 0
    roleHints.push('是角色在湖边垂钓时使用的单根竹制鱼竿')
    roleHints.push('承担抛线、等待、提竿和收鱼这些关键动作的剧情职责')
    roleHints.push('属于乡村湖边垂钓语境中的朴素儿童渔具')
    plotCueHints.push('在中远景里也要一眼认出细长竹竿轮廓和竹节分段')
    plotCueHints.push('要清楚表现无渔轮单竿、竿梢绑线点、末端细线与小钩')
    structureHints.push('竹节分段和由粗到细的渐细关系要清楚')
    structureHints.push('竿梢绑线点、细线和小钩结构要明确')
    structureHints.push('必须保持完整全长，不能裁切两端，不能透视缩短')
  } else if (isStoryAssetBobberLike(asset)) {
    roleHints.length = 0
    plotCueHints.length = 0
    structureHints.length = 0
    roleHints.push('是钓线末端用来观察鱼讯的小型浮漂')
    roleHints.push('承担轻微晃动、直立漂浮和突然下沉这些关键剧情提示职责')
    roleHints.push('属于乡村湖边垂钓语境中的朴素儿童渔具')
    plotCueHints.push('在中远景里也要一眼认出红白配色、葫芦形轮廓和顶部标记')
    plotCueHints.push('要清楚表现直立浮姿、细黑中心针和上下两个小环')
    structureHints.push('红上白下的配色分区要明确')
    structureHints.push('葫芦形软木本体、细黑中心针和上下小环都要完整可读')
    structureHints.push('必须是独立单个浮漂，不连水面、不连人物、不连整根鱼线场景')
  } else if (isStoryAssetFishLike(asset)) {
    roleHints.length = 0
    plotCueHints.length = 0
    structureHints.length = 0
    roleHints.push('是故事里最终钓上来的小型银色小鱼')
    roleHints.push('承担“提竿成功、收获成果、放进鱼桶”这些关键剧情结果展示职责')
    roleHints.push('属于乡村湖边垂钓语境中的朴素自然小鱼，不是观赏鱼或大型鱼类')
    plotCueHints.push('在中近景里要一眼认出银色细长鱼身、叉形尾和小黑眼')
    plotCueHints.push('要清楚表现纺锤形身体轮廓、反光鳞片和简洁小鳍，不要夸张卡通表情')
    structureHints.push('细长纺锤形身体、叉形尾和小黑珠眼要完整可读')
    structureHints.push('背鳍、胸鳍和腹部轮廓要简洁明确')
    structureHints.push('必须是单条独立小鱼，不连钓钩、桶、手、角色或水面环境')
  } else if (isStoryAssetButterflyLike(asset)) {
    roleHints.length = 0
    plotCueHints.length = 0
    structureHints.length = 0
    roleHints.push('是故事里吸引角色分心、飞向野花丛的彩色蝴蝶')
    roleHints.push('承担“短暂停落、绕飞、引向花丛”这些关键剧情触发职责')
    roleHints.push('属于乡村湖边春日环境中的轻盈自然昆虫，不是飞蛾、蜻蜓或小鸟')
    plotCueHints.push('在中近景里要一眼认出鲜艳多彩双翅、黑色翅脉和细长触角')
    plotCueHints.push('要清楚表现停落或展翅时的蝴蝶轮廓，不要被画成鱼、叶子或标本针插展示')
    structureHints.push('左右双翅外轮廓、翅脉分区和尾突形态要明确')
    structureHints.push('细长身体、成对触角和翅膀配色层次要完整可读')
    structureHints.push('必须是单只独立蝴蝶，不连花枝、不连人物、不连场景底座')
  }

  const roleLineZh = roleHints.length ? limitStoryAssetText(`故事职责：${roleHints.join('；')}`, 220) : ''
  const sceneLineZh = sceneNames.length ? limitStoryAssetText(`关联场景：${sceneNames.join('、')}`, 120) : ''
  const coAssetLineZh = coAssetNames.length ? limitStoryAssetText(`常与这些元素同场：${coAssetNames.join('、')}，但它们只用于校准身份，不要画进单资产参考图`, 180) : ''
  const structureLineZh = structureHints.length ? limitStoryAssetText(`结构关注点：${structureHints.join('；')}`, 160) : ''
  const plotCueLineZh = plotCueHints.length ? limitStoryAssetText(`叙事识别重点：${plotCueHints.join('；')}`, 180) : ''

  return {
    sceneNames,
    sceneSummaries,
    eventMentions,
    coAssetNames,
    roleHints,
    plotCueHints,
    structureHints,
    roleLineZh,
    plotCueLineZh,
    sceneLineZh,
    coAssetLineZh,
    structureLineZh
  }
}

function sanitizeProtectedAssetPrompt({ asset, promptEn, negativePrompt }) {
  const lockProfile = storyAssetStr(asset && asset.lockProfile).trim().toLowerCase()
  const lockWorkflow = storyAssetStr(asset && asset.lockWorkflow).trim().toLowerCase()
  const protectedProfiles = new Set(['wearable_prop', 'slender_prop', 'rigid_prop', 'soft_prop', 'ambient_prop', 'organic_prop'])
  const rawPositive = storyAssetStr(promptEn).trim()
  const rawNegative = storyAssetStr(negativePrompt).trim()
  if (!protectedProfiles.has(lockProfile)) {
    return { promptEn: rawPositive, negativePrompt: rawNegative }
  }
  const bannedPositive = [
    /\bchildren'?s?\b/i, /\bchild\b/i, /\bgirl\b/i, /\bboy\b/i, /\bkid\b/i, /\bwoman\b/i, /\bman\b/i,
    /\bportrait\b/i, /\bupper body\b/i, /\bhalf[-\s]?length\b/i, /\bface\b/i, /\bhead\b/i, /\bmodel\b/i,
    /\bwearing\b/i, /\bworn\b/i, /\bon (?:a|the) head\b/i, /\bunder chin\b/i, /\boutfit\b/i, /\bdress\b/i,
    /\bshirt\b/i, /\bskirt\b/i, /\bbook illustration style\b/i, /\bstorybook\b/i, /\bfashion editorial\b/i
  ]
  const positiveParts = splitStoryAssetPromptParts(rawPositive).filter((part) => !bannedPositive.some((re) => re.test(part)))
  const safePositive = uniqStoryAssetPromptParts(positiveParts, 80).join(', ')
  const extraNegative = lockProfile === 'wearable_prop'
    ? ['person', 'girl', 'boy', 'child', 'portrait', 'head', 'face', 'upper body', 'model', 'wearing display', 'worn on head', 'mannequin', 'hair', 'scalp', 'ears']
    : ['person', 'portrait', 'character', 'environment']
  if (lockWorkflow === 'prop_hat') {
    extraNegative.push('woman', 'female body', 'shoulders', 'collarbone', 'neckline', 'bust', 'statue', 'sculpture', 'figurine', 'pedestal', 'display base')
  }
  return {
    promptEn: safePositive,
    negativePrompt: uniqStoryAssetPromptParts([...splitStoryAssetPromptParts(rawNegative), ...extraNegative], 120).join(', ')
  }
}

function normalizeStoryAssetUri(raw) {
  return storyAssetStr(raw).trim().replace(/\\/g, '/').replace(/^\/+/, '')
}

function storyAssetCategoryFolder(category) {
  const value = storyAssetStr(category).trim().toLowerCase()
  if (value === 'character' || value === 'prop' || value === 'location') return value
  return 'asset'
}

function storyAssetSlug(asset) {
  const raw = storyAssetStr(asset && asset.id).trim() || storyAssetStr(asset && asset.name).trim() || 'asset'
  return raw
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'asset'
}

function getStoryAssetTimeZone() {
  return storyAssetStr(process.env.STUDIO_ASSET_TIMEZONE).trim() || 'Asia/Shanghai'
}

function getDatePartsForStoryAssets(date = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: getStoryAssetTimeZone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })
    const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]))
    return {
      year: storyAssetStr(parts.year).trim() || String(date.getFullYear()),
      month: storyAssetStr(parts.month).trim() || String(date.getMonth() + 1).padStart(2, '0'),
      day: storyAssetStr(parts.day).trim() || String(date.getDate()).padStart(2, '0'),
      hour: storyAssetStr(parts.hour).trim() || String(date.getHours()).padStart(2, '0'),
      minute: storyAssetStr(parts.minute).trim() || String(date.getMinutes()).padStart(2, '0'),
      second: storyAssetStr(parts.second).trim() || String(date.getSeconds()).padStart(2, '0')
    }
  } catch (_) {
    const iso = new Date(date.getTime() - (date.getTimezoneOffset() * 60_000)).toISOString()
    return {
      year: iso.slice(0, 4),
      month: iso.slice(5, 7),
      day: iso.slice(8, 10),
      hour: iso.slice(11, 13),
      minute: iso.slice(14, 16),
      second: iso.slice(17, 19)
    }
  }
}

function getStoryAssetDateFolder(date = new Date()) {
  const parts = getDatePartsForStoryAssets(date)
  return `${parts.year}-${parts.month}-${parts.day}`
}

function getStoryAssetTimestampToken(date = new Date()) {
  const parts = getDatePartsForStoryAssets(date)
  return `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}`
}

function buildStoryAssetStorageInfo(asset, date = new Date()) {
  const category = storyAssetCategoryFolder(asset && asset.category)
  const slug = storyAssetSlug(asset)
  const dateFolder = getStoryAssetDateFolder(date)
  const relDir = path.join('assets', 'ai', 'story_assets', category, slug, dateFolder)
  return { category, slug, dateFolder, relDir }
}

function buildStoryAssetFileTarget({ dir, asset, prefix, ext, seed, date = new Date() }) {
  const storage = buildStoryAssetStorageInfo(asset, date)
  const safeExt = storyAssetStr(ext).replace(/[^a-z0-9]+/gi, '') || 'png'
  const stamp = getStoryAssetTimestampToken(date)
  const safePrefix = storyAssetStr(prefix).trim().replace(/[^a-z0-9_.-]+/gi, '_') || 'asset'
  const seedPart = Number.isFinite(Number(seed)) ? `_seed_${Math.max(0, Math.floor(Number(seed)))}` : ''
  const filename = `${safePrefix}${seedPart}_${stamp}.${safeExt}`
  return {
    ...storage,
    filename,
    outDir: path.join(dir, storage.relDir),
    absPath: path.join(dir, storage.relDir, filename),
    assetPath: `${storage.relDir}/${filename}`.replace(/\\/g, '/')
  }
}

function buildStoryAssetComfyPrefix(asset, variant, date = new Date()) {
  const storage = buildStoryAssetStorageInfo(asset, date)
  const safeVariant = storyAssetStr(variant).trim().replace(/[^a-z0-9_.-]+/gi, '_') || 'asset'
  return path.posix.join('gamestudio_story_lock', storage.dateFolder, storage.category, storage.slug, safeVariant)
}

function getManagedStoryAssetPrefixes(asset) {
  const category = storyAssetCategoryFolder(asset && asset.category)
  const slug = storyAssetSlug(asset)
  return {
    current: `assets/ai/story_assets/${category}/${slug}/`,
    legacyRefs: `assets/ai/story_assets/${slug}_`,
    legacyLineart: `assets/ai/story_lineart/${slug}_`,
    legacyLineartDir: `assets/ai/story_lineart/${category}/${slug}/`
  }
}

function isManagedStoryAssetPathForAsset(asset, rawPath) {
  const uri = normalizeStoryAssetUri(rawPath)
  if (!uri) return false
  const prefixes = getManagedStoryAssetPrefixes(asset)
  return (
    uri.startsWith(prefixes.current) ||
    uri.startsWith(prefixes.legacyRefs) ||
    uri.startsWith(prefixes.legacyLineart) ||
    uri.startsWith(prefixes.legacyLineartDir)
  )
}

function labelForStoryAssetGalleryKind(kind) {
  if (kind === 'reference') return '参考图'
  if (kind === 'selected_white_bg') return '白底主参考'
  if (kind === 'lineart_hint') return '线稿 Hint'
  if (kind === 'lineart_final') return '线稿成品'
  return '图片'
}

function inferStoryAssetGalleryKind({ uri, ref, asset }) {
  const normalized = normalizeStoryAssetUri(uri)
  if (!normalized) return 'unknown'
  if (normalized === normalizeStoryAssetUri(asset && asset.lineartHintAssetUri)) return 'lineart_hint'
  if (normalized === normalizeStoryAssetUri(asset && asset.lineartFinalAssetUri)) return 'lineart_final'
  if (storyAssetStr(ref && ref.postprocess).trim() === 'rmbg_white_bg') return 'selected_white_bg'
  const base = path.basename(normalized).toLowerCase()
  if (base.includes('selected_white')) return 'selected_white_bg'
  if (base.includes('lineart_hint') || base.includes('_hint_')) return 'lineart_hint'
  if (base.includes('lineart_final') || base.includes('_lineart_') || base.includes('_final_')) return 'lineart_final'
  return 'reference'
}

function storyAssetCreatedAtFallback(uri) {
  const normalized = normalizeStoryAssetUri(uri)
  const match = normalized.match(/(20\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/)
  if (!match) return ''
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`
}

function buildStoryAssetGalleryEntries({ projectId, project, plan, asset }) {
  const projectAssets = Array.isArray(project && project.assets) ? project.assets : []
  const projectAssetByUri = new Map()
  for (const item of projectAssets) {
    const uri = normalizeStoryAssetUri(item && item.uri)
    if (uri) projectAssetByUri.set(uri, item)
  }
  const generatedRefs = Array.isArray(asset && asset.generatedRefs) ? asset.generatedRefs : []
  const latestBatch = Array.isArray(asset && asset.latestReferenceBatch) ? asset.latestReferenceBatch : []
  const refByUri = new Map()
  for (const ref of generatedRefs) {
    const uri = normalizeStoryAssetUri(ref && ref.projectAssetUri)
    if (uri) refByUri.set(uri, ref)
  }
  const batchByUri = new Map()
  for (const item of latestBatch) {
    const uri = normalizeStoryAssetUri(item && item.assetPath)
    if (uri) batchByUri.set(uri, item)
  }
  const seen = new Set()
  const rows = []
  const candidateUris = new Set()
  for (const ref of generatedRefs) {
    const uri = normalizeStoryAssetUri(ref && ref.projectAssetUri)
    if (uri) candidateUris.add(uri)
  }
  for (const item of latestBatch) {
    const uri = normalizeStoryAssetUri(item && item.assetPath)
    if (uri) candidateUris.add(uri)
  }
  for (const projectAsset of projectAssets) {
    const uri = normalizeStoryAssetUri(projectAsset && projectAsset.uri)
    if (uri && isManagedStoryAssetPathForAsset(asset, uri)) candidateUris.add(uri)
  }
  const specialUris = [
    normalizeStoryAssetUri(asset && asset.primaryReferenceAssetUri),
    normalizeStoryAssetUri(asset && asset.lineartHintAssetUri),
    normalizeStoryAssetUri(asset && asset.lineartFinalAssetUri)
  ].filter(Boolean)
  for (const uri of specialUris) candidateUris.add(uri)

  for (const uri of candidateUris) {
    if (!uri || !isManagedStoryAssetPathForAsset(asset, uri) || seen.has(uri)) continue
    seen.add(uri)
    const ref = refByUri.get(uri) || null
    const batch = batchByUri.get(uri) || null
    const projectAsset = projectAssetByUri.get(uri) || null
    const kind = inferStoryAssetGalleryKind({ uri, ref, asset })
    const analysis = batch && batch.analysis && typeof batch.analysis === 'object'
      ? batch.analysis
      : (normalizeStoryAssetUri(asset && asset.primaryReferenceAssetUri) === uri && asset && asset.latestReferenceReview && typeof asset.latestReferenceReview === 'object'
        ? asset.latestReferenceReview
        : null)
    const createdAt = storyAssetStr(ref && ref.createdAt).trim() || storyAssetCreatedAtFallback(uri)
    const refSeedValue = ref && typeof ref === 'object' ? ref.seed : undefined
    const projectAssetSource = projectAsset && projectAsset.source && typeof projectAsset.source === 'object'
      ? projectAsset.source
      : null
    const projectAssetSeedValue = projectAssetSource ? projectAssetSource.seed : undefined
    rows.push({
      assetPath: uri,
      url: `/project-assets/${encodeURIComponent(String(projectId || ''))}/${uri}`,
      kind,
      label: labelForStoryAssetGalleryKind(kind),
      createdAt: createdAt || undefined,
      seed: Number.isFinite(Number(refSeedValue)) ? Number(refSeedValue) : (Number.isFinite(Number(projectAssetSeedValue)) ? Number(projectAssetSeedValue) : undefined),
      provider: storyAssetStr(ref && ref.provider).trim() || storyAssetStr(projectAssetSource && projectAssetSource.provider).trim() || undefined,
      prompt: storyAssetStr(ref && ref.prompt).trim() || storyAssetStr(projectAssetSource && projectAssetSource.prompt).trim() || undefined,
      negativePrompt: storyAssetStr(ref && ref.negativePrompt).trim() || storyAssetStr(projectAssetSource && projectAssetSource.negativePrompt).trim() || undefined,
      isPrimary: normalizeStoryAssetUri(asset && asset.primaryReferenceAssetUri) === uri,
      isCurrentLineart: (
        normalizeStoryAssetUri(asset && asset.lineartHintAssetUri) === uri ||
        normalizeStoryAssetUri(asset && asset.lineartFinalAssetUri) === uri
      ),
      recommended: Boolean(
        normalizeStoryAssetUri(asset && asset.latestRecommendedReferenceAssetUri) === uri ||
        (batch && batch.recommended)
      ),
      inLatestBatch: batchByUri.has(uri),
      analysis
    })
  }
  rows.sort((a, b) => {
    const priorityA = a.isPrimary ? 30 : (a.isCurrentLineart ? 20 : 0)
    const priorityB = b.isPrimary ? 30 : (b.isCurrentLineart ? 20 : 0)
    if (priorityA !== priorityB) return priorityB - priorityA
    const timeA = Date.parse(String(a.createdAt || ''))
    const timeB = Date.parse(String(b.createdAt || ''))
    if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeB - timeA
    return String(a.assetPath || '').localeCompare(String(b.assetPath || ''))
  })
  return rows
}

async function pruneMissingStoryAssetGalleryEntries({ id, dir, plan, asset }) {
  let currentPlan = plan
  let currentAsset = asset
  let currentProject = null
  let items = []

  while (true) {
    const bundle = await readProjectBundle(id)
    currentProject = normalizeProjectDoc(bundle.rawProject)
    items = buildStoryAssetGalleryEntries({ projectId: id, project: currentProject, plan: currentPlan, asset: currentAsset })
    const missing = []
    for (const item of items) {
      const uri = normalizeStoryAssetUri(item && item.assetPath)
      if (!uri) continue
      const abs = path.join(dir, uri)
      if (!(await existsFile(abs))) missing.push(uri)
    }
    if (!missing.length) break
    for (const missingUri of missing) {
      const liveAsset = (Array.isArray(currentPlan && currentPlan.assets)
        ? currentPlan.assets.find((entry) => storyAssetStr(entry && entry.id).trim() === storyAssetStr(currentAsset && currentAsset.id).trim())
        : null) || currentAsset
      const cleaned = await deleteStoryAssetManagedFile({
        id,
        dir,
        plan: currentPlan,
        asset: liveAsset,
        targetAssetPath: missingUri
      })
      currentPlan = cleaned.plan
      currentAsset = cleaned.asset
    }
  }

  return {
    plan: currentPlan,
    asset: currentAsset,
    project: currentProject,
    items
  }
}

function buildStoryAssetPromptEnhancement({ asset, plan, globalPromptZh, globalNegativePromptZh, currentPromptZh, currentPromptEn, currentNegativePromptZh, currentNegativePrompt }) {
  const category = storyAssetStr(asset && asset.category).trim()
  const lockProfile = storyAssetStr(asset && asset.lockProfile).trim()
  const name = storyAssetStr(asset && asset.name).trim() || '当前资产'
  const anchor = storyAssetStr(asset && asset.anchorPrompt).trim()
  const hint = storyAssetStr(asset && asset.referencePromptHint).trim()
  const zhBase = sanitizeStoryAssetPromptZh({ asset, promptZh: currentPromptZh })
  const enBase = storyAssetStr(currentPromptEn).trim()
  const zhNegBase = storyAssetStr(currentNegativePromptZh).trim()
  const enNegBase = storyAssetStr(currentNegativePrompt).trim()
  const worldAnchor = storyAssetStr(plan && plan.worldAnchor).trim()
  const globalZh = storyAssetStr(globalPromptZh).trim()
  const globalNegZh = storyAssetStr(globalNegativePromptZh).trim()
  const usageContext = buildStoryAssetUsageContext({ asset, plan })
  const usageLines = [
    usageContext.roleLineZh,
    usageContext.plotCueLineZh,
    usageContext.structureLineZh
  ].filter(Boolean)
  const propExclusionNames = usageContext.coAssetNames.slice(0, 8)

  let promptZh = ''
  if (zhBase && category === 'prop') {
    promptZh = uniqStoryAssetPromptParts([
      ...splitStoryAssetPromptParts(zhBase),
      ...usageLines,
      '仅画物件本身',
      '纯白背景',
      '不把共现角色或地点画进去'
    ], 32).join('，')
  } else if (zhBase) {
    promptZh = zhBase
  }
  if (!promptZh) {
    if (lockProfile === 'character_core' || category === 'character') {
      promptZh = [
        `${name}角色参考表，单主体，全身，正面站姿，居中构图`,
        '纯白无缝背景，无地面线，无投影，无场景环境',
        '双手自然下垂且空手，不拿任何道具，不戴帽子',
        '重点锁定脸型、耳朵、眼睛颜色、毛色花纹、服装版型、腰带、鞋子和整体比例',
        '儿童绘本插画，线条干净，配色柔和，细节清晰，不能画成真人小孩或拟人猫娘'
      ].join('，')
    } else if (lockProfile === 'wearable_prop') {
      promptZh = [
        `${name}道具设计图，单一物件，居中展示，仅画物件本身`,
        usageLines.join('，'),
        '纯白背景，无手持，无人物，无头部，无模特，无佩戴展示，无场景，无头模',
        '清楚表现材质、结构、尺寸比例、开口、边缘轮廓和独立摆放关系',
        '强调这是可穿戴但未佩戴的独立物件，必要时开口或内部结构可见',
        '中性商品参考插画，设计图表达，轮廓清晰，便于后续连续场景复用'
      ].filter(Boolean).join('，')
    } else if (lockProfile === 'slender_prop') {
      promptZh = [
        `${name}细长道具锁定图，单一物件，完整显示全长，居中展示`,
        usageLines.join('，'),
        '纯白背景，无人物，无手持，无场景，不允许两端裁切，不允许透视缩短',
        '清楚表现长度比例、端头结构、孔位或节点细节，轮廓笔直可读',
        '中性设计参考图，线条干净，便于后续连续场景复用'
      ].filter(Boolean).join('，')
    } else if (lockProfile === 'rigid_prop') {
      promptZh = [
        `${name}硬结构道具参考图，单一物件，稳定透视，居中展示，仅画物件本身`,
        usageLines.join('，'),
        '纯白背景，无人物，无场景，无额外杂物，不把共现角色或地点画进去',
        '清楚表现主要结构部件、体块关系、材质和比例，不能塌陷变形',
        '中性商品参考插画，轮廓清晰，便于后续连续场景复用'
      ].filter(Boolean).join('，')
    } else if (lockProfile === 'ambient_prop') {
      promptZh = [
        `${name}氛围元素参考图，单一元素，居中展示`,
        usageContext.sceneLineZh,
        '干净浅色背景，不要整张大场景，不要地平线，不要树木建筑人物',
        '清楚表现该元素自身轮廓、体积和内部层次，便于在不同场景中稳定复用',
        '中性参考插画，轮廓清晰，便于后续连续场景复用'
      ].filter(Boolean).join('，')
    } else if (lockProfile === 'organic_prop') {
      if (isStoryAssetButterflyLike(asset)) {
        promptZh = [
          `${name}昆虫参考图，单一物件，居中展示，仅画物件本身`,
          usageLines.join('，'),
          '纯白背景，无人物，无手持，无场景，无花枝，无草地，无栖息地，不把共现角色或地点画进去',
          '清楚表现左右双翅轮廓、翅脉、尾突、细长身体、成对触角和配色分区',
          '必须是单只独立蝴蝶，不要飞蛾，不要蜻蜓，不要小鸟，不要昆虫标本针插展示',
          '中性设计参考图，轮廓清晰，便于后续连续场景复用'
        ].filter(Boolean).join('，')
      } else {
        promptZh = [
          `${name}自然标本道具锁定图，单一物件，居中展示，仅画物件本身`,
          usageLines.join('，'),
          '纯白背景，无人物，无手持，无场景，无水面，无栖息地，不把共现角色或地点画进去',
          '清楚表现整体轮廓、头尾比例、眼睛、鳍、表面纹理和尺寸关系',
          '必须是单个自然标本或单个小鱼，不要夸张表情，不要观赏鱼摆拍，不要生态展示缸',
          '中性设计参考图，轮廓清晰，便于后续连续场景复用'
        ].filter(Boolean).join('，')
      }
    } else if (category === 'prop') {
      promptZh = [
        `${name}道具设计图，单一物件，居中展示，仅画物件本身`,
        usageLines.join('，'),
        '纯白背景，无手持，无人物，无头部，无模特，无佩戴展示，无场景，不把共现角色或地点画进去',
        '清楚表现材质、结构、尺寸比例、开口、边缘轮廓和正反面造型关系',
        '中性商品参考插画，轮廓清晰，便于后续连续场景复用'
      ].filter(Boolean).join('，')
    } else {
      promptZh = [
        `${name}地点参考图，稳定构图，统一环境语言`,
        '突出建筑、地形、植被、水体和光线关系',
        '儿童绘本风格，适合作为连续场景统一地点锚点'
      ].join('，')
    }
  }

  const fallbackPromptEn = buildStoryAssetReferencePrompt({
    plan,
    asset,
    style: 'picture_book',
    globalPrompt: category === 'location' ? worldAnchor : '',
    assetPrompt: hint
  })
  let promptEn = pickEnglishPrompt(enBase, storyAssetStr(asset && asset.referencePromptEn).trim(), hint, fallbackPromptEn)

  const summary = (lockProfile === 'character_core' || category === 'character')
    ? `已强化为角色锁定参考图提示词：去掉场景环境与道具干扰，保留白底、正面全身、空手和外观锁定。`
    : category === 'prop'
      ? `已强化为道具锁定参考图提示词：补入故事职责、结构关注点和共现场景约束，同时保持单物件白底。`
      : `已强化为地点锁定提示词：突出环境构图和统一世界观。`

  const defaultNegativePromptZh = (
    category === 'character'
      ? '多人，多主体，人物脸，真人小孩，拟人猫娘，帽子，鱼竿，水桶，场景背景，树木，草地，水面，桥，侧面，背面，三分之二侧面，投影，地面线，文字，水印'
      : category === 'prop'
        ? ['人物', '角色', '儿童', '女孩', '男孩', '头部', '脸部', '半身像', '上半身', '手持', '佩戴展示', '戴在头上', '模特', '人体穿戴关系', '场景背景', '树木', '草地', '水面', '文字', '水印', ...propExclusionNames].join('，')
        : '人物特写，人群，文字，水印'
  )
  const negativePromptZh = (
    zhNegBase && category === 'prop'
      ? uniqStoryAssetPromptParts([
        ...splitStoryAssetPromptParts(zhNegBase),
        ...propExclusionNames
      ], 40).join('，')
      : zhNegBase
  ) || defaultNegativePromptZh

  return {
    promptZh,
    promptEn,
    negativePromptZh,
    negativePrompt: enNegBase || buildStoryAssetReferenceNegativePrompt({
      plan,
      asset,
      globalNegativePrompt: globalNegZh
    }),
    summary,
    context: {
      anchor,
      hint,
      worldAnchor,
      globalPromptZh: globalZh,
      usageContext
    }
  }
}

function scoreStoryAssetPromptCandidate({ asset, promptZh, promptEn, negativePromptZh, negativePrompt, context }) {
  const name = storyAssetStr(asset && asset.name).trim()
  const category = storyAssetStr(asset && asset.category).trim().toLowerCase()
  const lockProfile = storyAssetStr(asset && asset.lockProfile).trim().toLowerCase()
  const promptZhText = storyAssetStr(promptZh).trim()
  const promptEnText = storyAssetStr(promptEn).trim()
  const negZhText = storyAssetStr(negativePromptZh).trim()
  const negEnText = storyAssetStr(negativePrompt).trim()
  const combinedZh = `${promptZhText}，${negZhText}`
  const combinedEn = `${promptEnText}, ${negEnText}`.toLowerCase()
  const strengths = []
  const risks = []
  const suggestions = []
  let score = 0

  const hasPositive = Boolean(promptZhText || promptEnText)
  const hasNegative = Boolean(negZhText || negEnText)
  if (hasPositive) {
    score += 12
    strengths.push('已生成正向提示词。')
  } else {
    risks.push('缺少正向提示词。')
    suggestions.push('必须先明确这个事物是什么，再补白底和单物件约束。')
  }
  if (hasNegative) {
    score += 8
    strengths.push('已生成负向提示词。')
  } else {
    risks.push('缺少负向提示词。')
    suggestions.push('补齐容易混淆的替代物、人物、场景和多物件排除项。')
  }

  if (/(单一物件|仅画物件本身|single object|isolated object|exactly one object)/i.test(`${promptZhText} ${promptEnText}`)) {
    score += 8
    strengths.push('单物件约束明确。')
  } else if (category === 'prop') {
    risks.push('单物件约束不足。')
    suggestions.push('明确写“单一物件、仅画物件本身、不要重复件”。')
  }

  if (/(纯白背景|白底|pure white background)/i.test(`${promptZhText} ${promptEnText}`)) {
    score += 6
    strengths.push('白底参考图约束明确。')
  } else if (category === 'prop' || category === 'character') {
    risks.push('白底参考图约束不足。')
    suggestions.push('补充纯白背景/无场景背景约束，避免混入故事场景。')
  }

  if (/(无人物|无人|no person|no character|no portrait|无手持|no hand|无场景|no environment)/i.test(`${combinedZh} ${combinedEn}`)) {
    score += 8
    strengths.push('人物和场景排除项明确。')
  } else if (category === 'prop') {
    risks.push('人物/场景排除项不足。')
    suggestions.push('补充无人物、无手持、无场景、无环境杂项。')
  }

  if (context && typeof context === 'object') {
    const roleLineZh = storyAssetStr(context.roleLineZh).trim()
    const plotCueLineZh = storyAssetStr(context.plotCueLineZh).trim()
    const structureLineZh = storyAssetStr(context.structureLineZh).trim()
    if (roleLineZh && containsStoryAssetMeaning(promptZhText, roleLineZh)) {
      score += 10
      strengths.push('提示词吸收了故事职责。')
    } else if (roleLineZh) {
      risks.push('提示词没有明显吸收故事职责。')
      suggestions.push('让提示词体现它在故事里的用途，而不是只剩通用商品图模板。')
    }
    if (plotCueLineZh && containsStoryAssetMeaning(promptZhText, plotCueLineZh)) {
      score += 10
      strengths.push('提示词体现了全文叙事识别重点。')
    } else if (plotCueLineZh) {
      risks.push('提示词没有体现全文情节里的识别重点。')
      suggestions.push('把“远看可辨、浮姿/下沉、连接点、开口/容积”等叙事识别点写进正向词。')
    }
    if (structureLineZh && containsStoryAssetMeaning(promptZhText, structureLineZh)) {
      score += 10
      strengths.push('提示词体现了结构关注点。')
    } else if (structureLineZh) {
      risks.push('提示词缺少结构关注点。')
      suggestions.push('把关键结构部位、连接关系、端头/孔位/节点写清楚。')
    }
  }

  const forbidden = Array.isArray(asset && asset.forbiddenSubstitutes) ? asset.forbiddenSubstitutes.map((x) => storyAssetStr(x).trim()).filter(Boolean) : []
  const forbiddenMentioned = forbidden.filter((item) => combinedZh.includes(item) || combinedEn.includes(item.toLowerCase()))
  if (forbiddenMentioned.length) {
    score += Math.min(12, forbiddenMentioned.length * 3)
    strengths.push(`已排除 ${forbiddenMentioned.length} 个已知易混替代物。`)
  } else if (forbidden.length) {
    risks.push('未明显排除已知易混替代物。')
    suggestions.push(`至少补进这些高风险替代项：${forbidden.slice(0, 4).join('、')}。`)
  }

  if (lockProfile === 'slender_prop' && /(完整显示全长|full length|end to end|两端|孔位|节点|foreshortening|透视缩短)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)) {
    score += 10
    strengths.push('细长道具的长度与端头约束明确。')
  } else if (lockProfile === 'slender_prop') {
    risks.push('细长道具缺少全长/端头/孔位约束。')
    suggestions.push('补充“完整显示全长、两端不可裁切、孔位或节点清楚、避免透视缩短”。')
  }

  const signalText = [name, storyAssetStr(asset && asset.anchorPrompt), ...(Array.isArray(asset && asset.aliases) ? asset.aliases : [])].join(' ').toLowerCase()
  if (/\b(bobber|float)\b|浮漂|漂子/.test(signalText)) {
    const bobberSignals = /(红白|红色.*白色|red-and-white|gourd|葫芦|cork|软木|center pin|中心针|eyelet|小环)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    const badSignals = /(glass|玻璃|aquarium|rectangular box|box|beaker|plastic ball bobber|clip-on|slot|side slit|透明中段|球形)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    if (bobberSignals) {
      score += 14
      strengths.push('已经钉住浮漂的关键身份特征。')
    } else {
      score -= 18
      risks.push('还没有把“红白葫芦形软木漂、中心针、上下小环”钉死。')
      suggestions.push('明确写红上白下、葫芦形软木本体、细黑中心针、顶部和底部小环。')
    }
    if (badSignals) {
      score -= 18
      risks.push('提示词里仍保留会把浮漂引向玻璃盒、球漂或夹扣漂的风险。')
    }
    if (/(鱼竿|竹鱼竿|bucket|pail|开口|容积|肩带|提梁|bamboo rod|handle|strap)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)) {
      score -= 24
      risks.push('浮漂提示词混入了鱼竿/桶类结构语义。')
      suggestions.push('浮漂只能保留红白葫芦形、中心针、上下小环和独立单物件约束。')
    }
  }

  if (/\b(minnow|fish|silver fish)\b|小银鱼|银鱼/.test(signalText)) {
    const fishSignals = /(银色|silver|细长|纺锤|torpedo|叉形尾|forked tail|鳞片|scales|黑珠眼|bead eye|小鳍|fin)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    const badFishSignals = /(开口|容积|桶沿|肩带|提梁|bucket|pail|strap|handle|佩戴|模特|wearing|portrait|human|手持|钓竿|鱼竿|hooked on line|aquarium|fish tank|观赏鱼|goldfish|koi|carp|trout|crab)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    if (fishSignals) {
      score += 14
      strengths.push('已经钉住小银鱼的关键形体特征。')
    } else {
      score -= 18
      risks.push('还没有把“小型银色鱼身、叉形尾、鳞片、小黑眼”钉死。')
      suggestions.push('明确写细长银色小鱼、纺锤形身体、叉形尾、反光鳞片和小黑珠眼。')
    }
    if (badFishSignals) {
      score -= 24
      risks.push('小银鱼提示词混入了鱼桶/人物/钓具/观赏鱼语义。')
      suggestions.push('小银鱼只能保留单条自然小鱼的身体结构，不要写开口、容积、佩戴、手持、鱼竿或观赏鱼场景。')
    }
  }

  if (/\b(butterfly|swallowtail)\b|蝴蝶|彩蝶/.test(signalText)) {
    const butterflySignals = /(蝴蝶|butterfly|swallowtail|双翅|wings|翅脉|veins|触角|antennae|尾突|彩色|cyan|magenta|yellow)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    const badButterflySignals = /(鱼|小鱼|minnow|fish|叉形尾|forked tail|鳍|fin|水面|aquarium|标本针|specimen pin|蜻蜓|dragonfly|飞蛾|moth|bird|小鸟)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    if (butterflySignals) {
      score += 14
      strengths.push('已经钉住蝴蝶的关键形体特征。')
    } else {
      score -= 18
      risks.push('还没有把“彩色双翅、黑色翅脉、细长触角、蝴蝶轮廓”钉死。')
      suggestions.push('明确写单只彩色蝴蝶、双翅轮廓、黑色翅脉、细长触角和轻盈昆虫姿态。')
    }
    if (badButterflySignals) {
      score -= 24
      risks.push('蝴蝶提示词混入了小鱼/标本针/飞蛾/蜻蜓等错误语义。')
      suggestions.push('蝴蝶只能保留双翅、翅脉、触角和配色，不要写鱼身、鱼鳍、水面、标本针或其它昆虫。')
    }
  }

  if (/\b(bamboo fishing rod|bamboo rod|fishing rod|fishing pole|pole)\b|竹鱼竿|鱼竿|竹竿/.test(signalText)) {
    const rodSignals = /(竹节|竹制|bamboo|nodes?|竿梢|tip|no reel|无渔轮|棉线|cotton line|hook|鱼钩)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    const badRodSignals = /(开口|容积|桶沿|肩带|提梁|bucket|pail|strap|handle|红白|葫芦|bobber|float|center pin|eyelet)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    if (rodSignals) {
      score += 14
      strengths.push('已经钉住竹鱼竿的关键身份特征。')
    } else {
      score -= 18
      risks.push('还没有把“竹节、无渔轮、竿梢绑线点、末端细线和小钩”钉死。')
      suggestions.push('明确写单根竹制鱼竿、清楚竹节、无渔轮、竿梢绑线、末端细线与小钩。')
    }
    if (badRodSignals) {
      score -= 24
      risks.push('竹鱼竿提示词混入了鱼桶/浮漂类结构语义。')
      suggestions.push('竹鱼竿只能保留全长、竹节、绑线点、细线和小钩，不要写开口、容积、红白配色或浮姿。')
    }
  }

  if (/(关联场景[:：]|常与这些元素同场[:：])/.test(promptZhText)) {
    score -= 20
    risks.push('正向词仍混入关联场景/共现元素文本。')
    suggestions.push('不要把“关联场景”原样写进正向词，只把它转成结构和识别要求。')
  }

  const dangerousHumanCue =
    /(女孩|男孩|头部|脸部|模特|佩戴展示|戴在头上|girl|boy|portrait|wearing|worn on head|model)/i.test(promptZhText)
  const explicitPersonCue =
    /(人物|角色)/.test(promptZhText) &&
    !/(无人物|无人|非人物|不出现人物|仅画物件本身|无角色|不出现角色)/.test(promptZhText)
  const childCue =
    /儿童/.test(promptZhText) &&
    !/(儿童道具|儿童故事|儿童绘本|storybook|picture book)/i.test(promptZhText)
  if ((dangerousHumanCue || explicitPersonCue || childCue) && category === 'prop') {
    score -= 18
    risks.push('道具正向词混入人物/佩戴展示语义。')
    suggestions.push('道具锁定词必须是独立物件，不要出现人物、佩戴、模特或头部。')
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const passed = score >= 50
  const summary = passed
    ? `提示词评分 ${score}/100，已达到保留阈值。`
    : `提示词评分 ${score}/100，低于保留阈值，需要推倒重生。`
  return {
    passed,
    score,
    summary,
    strengths: uniqStoryAssetPromptParts(strengths, 8),
    risks: uniqStoryAssetPromptParts(risks, 10),
    suggestions: uniqStoryAssetPromptParts(suggestions, 8)
  }
}

function containsStoryAssetMeaning(promptZh, ruleLineZh) {
  const promptParts = splitStoryAssetPromptParts(promptZh)
  const ruleParts = splitStoryAssetPromptParts(ruleLineZh.replace(/^[^:：]+[:：]\s*/, ''))
  if (!promptParts.length || !ruleParts.length) return false
  const promptText = promptParts.join('，')
  return ruleParts.some((part) => {
    const needle = storyAssetStr(part).trim()
    return needle && (promptText.includes(needle) || promptText.includes(needle.replace(/[；。]/g, '')))
  })
}

async function translateStoryAssetPromptPair({ studio, promptZh, negativePromptZh, fallbackPromptEn, fallbackNegativePrompt, timeoutMs = 60_000 }) {
  const translationCfg = studio?.effective?.translation || {}
  const promptCfg = studio?.effective?.prompt || {}
  const providers = [
    {
      provider: storyAssetStr(translationCfg.provider).trim().toLowerCase(),
      model: translationCfg.model || undefined,
      apiUrl: translationCfg.apiUrl || undefined,
      note: null
    },
    {
      provider: storyAssetStr(promptCfg.provider).trim().toLowerCase(),
      model: promptCfg.model || undefined,
      apiUrl: promptCfg.apiUrl || undefined,
      note: 'translation_fallback_to_prompt_provider'
    }
  ].filter((item, index, list) => item.provider && item.provider !== 'none' && list.findIndex((entry) => entry.provider === item.provider && String(entry.apiUrl || '') === String(item.apiUrl || '')) === index)

  if (!providers.length) {
    return {
      promptEn: storyAssetStr(fallbackPromptEn).trim(),
      negativePrompt: storyAssetStr(fallbackNegativePrompt).trim(),
      meta: { provider: 'fallback', model: null, api: null, note: 'translation_provider_missing' }
    }
  }
  const proxyUrl = studio?.effective?.network?.proxyUrl || undefined
  let promptRes = null
  let negativeRes = null
  let providerMeta = null
  let lastError = null
  for (const candidate of providers) {
    try {
      ;[promptRes, negativeRes] = await Promise.all([
        translatePromptText({
          provider: candidate.provider,
          model: candidate.model,
          apiUrl: candidate.apiUrl,
          proxyUrl,
          timeoutMs,
          text: storyAssetStr(promptZh).trim(),
          sourceLang: 'zh',
          targetLang: 'en',
          mode: 'prompt'
        }),
        translatePromptText({
          provider: candidate.provider,
          model: candidate.model,
          apiUrl: candidate.apiUrl,
          proxyUrl,
          timeoutMs,
          text: storyAssetStr(negativePromptZh).trim(),
          sourceLang: 'zh',
          targetLang: 'en',
          mode: 'prompt'
        })
      ])
      providerMeta = {
        provider: promptRes?.meta?.provider || candidate.provider,
        model: promptRes?.meta?.model || candidate.model || null,
        api: promptRes?.meta?.api || candidate.apiUrl || null,
        note: candidate.note
      }
      break
    } catch (e) {
      lastError = e
    }
  }
  if (!promptRes || !negativeRes) throw lastError || new Error('translation_failed')
  return {
    promptEn: pickEnglishPrompt(storyAssetStr(promptRes?.result?.translatedText).trim(), fallbackPromptEn),
    negativePrompt: storyAssetStr(negativeRes?.result?.translatedText).trim() || storyAssetStr(fallbackNegativePrompt).trim(),
    meta: providerMeta || null
  }
}

async function cleanupEmptyStoryAssetDirs(startDir, stopDir) {
  const stop = path.resolve(stopDir)
  let current = path.resolve(startDir)
  while (current.startsWith(stop) && current !== stop) {
    const items = await readdir(current).catch(() => null)
    if (!Array.isArray(items) || items.length > 0) break
    await rm(current, { recursive: true, force: true }).catch(() => null)
    current = path.dirname(current)
  }
}

async function deleteStoryAssetManagedFile({ id, dir, plan, asset, targetAssetPath }) {
  const targetUri = normalizeStoryAssetUri(targetAssetPath)
  if (!targetUri) {
    const e = new Error('missing_asset_path')
    e.status = 400
    throw e
  }
  if (!isManagedStoryAssetPathForAsset(asset, targetUri)) {
    const e = new Error('story_asset_delete_forbidden')
    e.status = 403
    throw e
  }

  const bundle = await readProjectBundle(id)
  const projectAssets = Array.isArray(bundle.rawProject && bundle.rawProject.assets) ? bundle.rawProject.assets : []
  const removedProjectAssets = projectAssets.filter((item) => normalizeStoryAssetUri(item && item.uri) === targetUri)
  const removedProjectAssetIds = new Set(removedProjectAssets.map((item) => storyAssetStr(item && item.id).trim()).filter(Boolean))

  const abs = path.join(dir, targetUri)
  await rm(abs, { force: true }).catch(() => null)
  await cleanupEmptyStoryAssetDirs(path.dirname(abs), path.join(dir, 'assets', 'ai'))

  const nextProject = {
    ...bundle.rawProject,
    assets: projectAssets.filter((item) => normalizeStoryAssetUri(item && item.uri) !== targetUri),
    characters: Array.isArray(bundle.rawProject && bundle.rawProject.characters)
      ? bundle.rawProject.characters.map((ch) => {
          const refId = storyAssetStr(ch && ch.ai && ch.ai.referenceAssetId).trim()
          if (!refId || !removedProjectAssetIds.has(refId)) return ch
          return {
            ...ch,
            ai: {
              ...((ch && ch.ai && typeof ch.ai === 'object') ? ch.ai : {}),
              referenceAssetId: ''
            }
          }
        })
      : bundle.rawProject.characters,
    updatedAt: new Date().toISOString()
  }
  await writeJson(path.join(dir, 'project.json'), nextProject)

  const deletingPrimary = normalizeStoryAssetUri(asset && asset.primaryReferenceAssetUri) === targetUri
  const deletingHint = normalizeStoryAssetUri(asset && asset.lineartHintAssetUri) === targetUri
  const deletingFinal = normalizeStoryAssetUri(asset && asset.lineartFinalAssetUri) === targetUri
  const nextPlan = {
    ...plan,
    generatedAt: new Date().toISOString(),
    assets: Array.isArray(plan && plan.assets) ? plan.assets.map((item) => {
      if (storyAssetStr(item && item.id).trim() !== storyAssetStr(asset && asset.id).trim()) return item
      const nextGeneratedRefs = Array.isArray(item && item.generatedRefs)
        ? item.generatedRefs.filter((ref) => normalizeStoryAssetUri(ref && ref.projectAssetUri) !== targetUri)
        : []
      const nextBatch = Array.isArray(item && item.latestReferenceBatch)
        ? item.latestReferenceBatch.filter((entry) => normalizeStoryAssetUri(entry && entry.assetPath) !== targetUri)
        : []
      const primaryReferenceAssetUri = deletingPrimary ? '' : storyAssetStr(item && item.primaryReferenceAssetUri).trim()
      const primaryReferenceAssetId = deletingPrimary ? '' : storyAssetStr(item && item.primaryReferenceAssetId).trim()
      const lineartHintAssetUri = deletingHint || deletingPrimary ? '' : storyAssetStr(item && item.lineartHintAssetUri).trim()
      const lineartHintAssetId = deletingHint || deletingPrimary ? '' : storyAssetStr(item && item.lineartHintAssetId).trim()
      const lineartFinalAssetUri = deletingFinal || deletingPrimary ? '' : storyAssetStr(item && item.lineartFinalAssetUri).trim()
      const lineartFinalAssetId = deletingFinal || deletingPrimary ? '' : storyAssetStr(item && item.lineartFinalAssetId).trim()
      const lineartReady = Boolean(lineartHintAssetUri && lineartFinalAssetUri)
      let referenceStatus = primaryReferenceAssetUri ? 'ready' : (nextBatch.length || nextGeneratedRefs.length ? 'candidates_ready' : 'missing')
      if (!primaryReferenceAssetUri && storyAssetStr(item && item.renderStrategy).trim() === 'prompt_only') referenceStatus = 'missing'
      return {
        ...item,
        generatedRefs: nextGeneratedRefs,
        latestReferenceBatch: nextBatch,
        latestRecommendedReferenceAssetUri: normalizeStoryAssetUri(item && item.latestRecommendedReferenceAssetUri) === targetUri
          ? ''
          : storyAssetStr(item && item.latestRecommendedReferenceAssetUri).trim(),
        primaryReferenceAssetUri,
        primaryReferenceAssetId,
        primaryReferenceSelectedAt: primaryReferenceAssetUri ? storyAssetStr(item && item.primaryReferenceSelectedAt).trim() : '',
        latestReferenceReview: (
          item && item.latestReferenceReview && typeof item.latestReferenceReview === 'object' &&
          normalizeStoryAssetUri(item.latestReferenceReview.targetAssetUri) === targetUri
        )
          ? null
          : (item.latestReferenceReview || null),
        referenceStatus,
        lineartHintAssetUri,
        lineartHintAssetId,
        lineartFinalAssetUri,
        lineartFinalAssetId,
        lineartStatus: lineartReady ? 'ready' : 'missing',
        lineartPrompt: lineartReady ? storyAssetStr(item && item.lineartPrompt).trim() : '',
        lineartNegativePrompt: lineartReady ? storyAssetStr(item && item.lineartNegativePrompt).trim() : '',
        lineartMeta: lineartReady ? (item && item.lineartMeta && typeof item.lineartMeta === 'object' ? item.lineartMeta : null) : null,
        lineartGeneratedAt: lineartReady ? storyAssetStr(item && item.lineartGeneratedAt).trim() : ''
      }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan)
  return {
    plan: nextPlan,
    asset: (Array.isArray(nextPlan.assets) ? nextPlan.assets.find((item) => storyAssetStr(item && item.id).trim() === storyAssetStr(asset && asset.id).trim()) : null) || null,
    items: buildStoryAssetGalleryEntries({ projectId: id, project: normalizeProjectDoc(nextProject), plan: nextPlan, asset: (Array.isArray(nextPlan.assets) ? nextPlan.assets.find((item) => storyAssetStr(item && item.id).trim() === storyAssetStr(asset && asset.id).trim()) : null) || asset }),
    deleted: true
  }
}

async function existsDir(p) {
  try {
    const st = await stat(p)
    return st.isDirectory()
  } catch (_) {
    return false
  }
}

async function existsFile(p) {
  try {
    const st = await stat(p)
    return st.isFile()
  } catch (_) {
    return false
  }
}

function normalizeLocalPath(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''
  // Strip surrounding quotes copied from shell/GUI.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
  }
  // Drop trailing slashes to reduce join surprises.
  s = s.replace(/[\\/]+$/, '')
  return s
}

async function resolveSdWebuiModelsBase(root) {
  const raw = normalizeLocalPath(root)
  if (!raw) return ''
  if (await isDir(raw)) {
    // If user passed the webui root (contains "models/"), normalize to "<root>/models".
    const maybeModels = path.join(raw, 'models')
    if (await isDir(maybeModels)) return maybeModels
    return raw
  }
  return raw
}

async function pickCheckpointDir(modelsBase) {
  const base = normalizeLocalPath(modelsBase)
  if (!base) return ''
  if (await isDir(base)) {
    // Some users point Models Root directly at the checkpoint folder.
    const items = await readdir(base).catch(() => [])
    if (items.some((x) => /\.(safetensors|ckpt)$/i.test(String(x || '')))) return base
  }
  return await pickExistingDir(base, ['Stable-diffusion', 'checkpoints', 'Checkpoint', 'Checkpoints'])
}

async function pickLoraDir(modelsBase) {
  const base = normalizeLocalPath(modelsBase)
  if (!base) return ''
  if (await isDir(base)) {
    // Some users point Models Root directly at the LoRA folder.
    const items = await readdir(base).catch(() => [])
    if (items.some((x) => /\.safetensors$/i.test(String(x || '')))) return base
  }
  return await pickExistingDir(base, ['Lora', 'loras', 'LoRA', 'lora'])
}

async function scanModelFiles(rootDir, { exts, maxDepth = 4 }) {
  const out = []
  const want = new Set((exts || []).map((x) => String(x || '').toLowerCase()).filter(Boolean))
  if (!rootDir) return out

  async function walk(dir, depth) {
    if (depth > maxDepth) return
    let ents = []
    try {
      ents = await readdir(dir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const ent of ents) {
      const name = String(ent && ent.name ? ent.name : '')
      if (!name || name.startsWith('.')) continue
      const full = path.join(dir, name)
      if (ent.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!ent.isFile()) continue
      const lower = name.toLowerCase()
      // Ignore common sidecar files.
      if (
        lower.endsWith('.civitai.info') ||
        lower.endsWith('.preview.png') ||
        lower.endsWith('.png') ||
        lower.endsWith('.jpg') ||
        lower.endsWith('.jpeg') ||
        lower.endsWith('.webp') ||
        lower.endsWith('.txt') ||
        lower.endsWith('.yaml') ||
        lower.endsWith('.yml')
      ) {
        continue
      }
      const ext = path.extname(lower)
      if (!want.has(ext)) continue
      const rel = path.relative(rootDir, full).split(path.sep).join('/')
      out.push(rel)
    }
  }

  await walk(rootDir, 0)
  out.sort((a, b) => a.localeCompare(b))
  return out
}

function sniffImageMetaFromBytes(buf) {
  try {
    if (!buf || typeof buf.length !== 'number') return null
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', contentType: 'image/jpeg' }
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    )
      return { ext: 'png', contentType: 'image/png' }
    // GIF: GIF87a / GIF89a
    if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { ext: 'gif', contentType: 'image/gif' }
    // WEBP: RIFF....WEBP
    if (
      buf.length >= 12 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    )
      return { ext: 'webp', contentType: 'image/webp' }
  } catch (_) {}
  return null
}

function defaultStory() {
  return {
    schemaVersion: '2.0',
    startNodeId: 'start',
    nodes: [
      {
        id: 'start',
        name: '开始',
        kind: 'scene',
        body: { text: '这是一个新的故事。请在右侧属性面板编辑内容。' },
        timeline: {
          steps: [
            {
              id: 'st_start_1',
              actions: [{ type: 'ui.setText', mode: 'replace', text: '这是一个新的故事。请在右侧属性面板编辑内容。' }],
              advance: { type: 'choice' }
            }
          ]
        },
        choices: [
          { id: 'c1', text: '继续', toNodeId: 'end' }
        ],
        visuals: { placements: [] }
      },
      {
        id: 'end',
        name: '结局',
        kind: 'ending',
        body: { text: '故事结束。' },
        timeline: {
          steps: [
            {
              id: 'st_end_1',
              actions: [
                {
                  type: 'ui.showEndingCard',
                  card: {
                    title: '故事结束',
                    bullets: [],
                    moral: '故事结束。',
                    buttons: [
                      { type: 'restart', label: '重新开始' },
                      { type: 'backToHub', label: '返回工作台' }
                    ]
                  }
                }
              ],
              advance: { type: 'end' }
            }
          ]
        },
        visuals: { placements: [] }
      }
    ]
  }
}

function nowIso() {
  try { return new Date().toISOString() } catch (_) { return String(Date.now()) }
}

function defaultMeta({ id, title }) {
  return {
    schemaVersion: '1.0',
    id: String(id),
    title: String(title || ''),
    stage: 'script',
    createdAt: nowIso(),
    updatedAt: nowIso()
  }
}

function clampInt(x, min, max, fallback) {
  const n = Number(x)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

function defaultScripts() {
  const id = `sc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  return {
    schemaVersion: '1.0',
    cards: [
      {
        id,
        name: '脚本1',
        order: 1,
        text: '',
        updatedAt: nowIso()
      }
    ],
    updatedAt: nowIso()
  }
}

function defaultBlueprint() {
  return {
    schemaVersion: '1.0',
    startNodeId: '',
    placeholders: [],
    nodes: [],
    updatedAt: nowIso()
  }
}

async function writeAiDraftProject({ dir, id, title, formula, scripts, blueprint, projectBase = null }) {
  await mkdir(path.join(dir, 'assets'), { recursive: true })
  const project = normalizeProjectDoc(projectBase || {
    schemaVersion: '2.0',
    id,
    title,
    pluginId: 'story-pixi',
    pluginVersion: '0.1.0',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    characters: [],
    assets: [],
    events: [],
    state: { vars: [] }
  })
  await writeJson(path.join(dir, 'project.json'), project)
  await writeJson(path.join(dir, 'story.json'), defaultStory())
  await writeJson(path.join(dir, 'scripts.json'), scripts || defaultScripts())
  await writeJson(path.join(dir, 'blueprint.json'), blueprint || defaultBlueprint())
  await writeJson(path.join(dir, 'meta.json'), { ...defaultMeta({ id, title }), aiFormula: formula })
  return project
}

function normalizeProjectAndDetectChanges(project) {
  const before = project && typeof project === 'object' ? project : {}
  const after = normalizeProjectDoc(before)
  let changed = false
  try {
    changed = JSON.stringify(before?.state || null) !== JSON.stringify(after?.state || null)
  } catch (_) {
    changed = true
  }
  return { project: after, changed }
}

async function touchProjectUpdatedAt(dir) {
  try {
    const curr = await readJson(path.join(dir, 'project.json'))
    await writeJson(path.join(dir, 'project.json'), { ...curr, updatedAt: nowIso() })
  } catch (_) {}

  try {
    const metaPath = path.join(dir, 'meta.json')
    const meta = (await existsFile(metaPath)) ? await readJson(metaPath) : null
    if (meta && typeof meta === 'object') {
      await writeJson(metaPath, { ...meta, updatedAt: nowIso() })
    }
  } catch (_) {}
}

function normalizeAiStoryFormula(input) {
  const choicePoints = clampInt(input?.choicePoints, 1, 3, 2)
  const optionsPerChoice = Number(input?.optionsPerChoice) === 3 ? 3 : 2
  const endings = optionsPerChoice
  return { schemaVersion: '1.0', format: 'numeric', choicePoints, optionsPerChoice, endings }
}

function buildScriptsFromDraftCards(cardsIn, prevScripts, formula) {
  const sourceCards = Array.isArray(cardsIn) ? cardsIn : []
  const prevCards = prevScripts && typeof prevScripts === 'object' && Array.isArray(prevScripts.cards) ? prevScripts.cards : []
  const preserveIds = prevCards.length > 0 && prevCards.length === sourceCards.length

  const cards = sourceCards
    .map((x, i) => {
      const base = preserveIds ? prevCards[i] : null
      const idUse = base && base.id ? String(base.id) : genId('sc')
      const orderUse = base && base.order != null ? Number(base.order) : i + 1
      return {
        id: idUse,
        name: String(x && x.name ? x.name : `场景${i + 1}`),
        order: Number.isFinite(orderUse) && orderUse > 0 ? orderUse : i + 1,
        text: String(x && x.text ? x.text : ''),
        updatedAt: nowIso()
      }
    })
    .filter((c) => c.text.trim())

  if (!cards.length) return null

  const scripts = { schemaVersion: '1.0', cards, updatedAt: nowIso() }
  scripts.cards = normalizeScriptCardsForBlueprint(scripts.cards, formula)
  return scripts
}

function collectBlockingScriptIssues(report, validation) {
  const out = []
  const blockingReportWarnings = new Set([
    'formula_choicePoints_mismatch',
    'formula_optionsPerChoice_mismatch',
    'formula_endings_too_few',
    'missing_consequence',
    'consequence_index_mismatch'
  ])
  const blockingValidationWarnings = new Set([
    'scene_no_choices',
    'ending_has_choices',
    'unreachable_nodes',
    'no_reachable_endings'
  ])

  for (const item of Array.isArray(report?.errors) ? report.errors : []) {
    if (!item || !item.message) continue
    out.push({ source: 'compile', severity: 'error', code: String(item.code || ''), message: String(item.message) })
  }
  for (const item of Array.isArray(report?.warnings) ? report.warnings : []) {
    const code = String(item?.code || '')
    if (!blockingReportWarnings.has(code) || !item?.message) continue
    out.push({ source: 'compile', severity: 'warning', code, message: String(item.message) })
  }
  for (const item of Array.isArray(validation?.errors) ? validation.errors : []) {
    if (!item || !item.message) continue
    out.push({ source: 'validate', severity: 'error', code: String(item.code || ''), message: String(item.message) })
  }
  for (const item of Array.isArray(validation?.warnings) ? validation.warnings : []) {
    const code = String(item?.code || '')
    if (!blockingValidationWarnings.has(code) || !item?.message) continue
    out.push({ source: 'validate', severity: 'warning', code, message: String(item.message) })
  }
  return out
}

function summarizeScriptIssues(issues) {
  const items = Array.isArray(issues) ? issues : []
  if (!items.length) return ''
  return items.slice(0, 3).map((item) => String(item?.message || '').trim()).filter(Boolean).join('；')
}

async function generateClosedScriptDraft({
  prompt,
  title,
  projectTitle,
  rules,
  formula,
  provider,
  model,
  apiUrl,
  proxyUrl,
  timeoutMs,
  prevScripts,
  prevBlueprint
}) {
  let generated = null
  let genMeta = null
  try {
    generated = await generateScriptDraft({
      prompt,
      title: title || undefined,
      rules,
      formula,
      provider,
      model,
      apiUrl,
      proxyUrl,
      timeoutMs
    })
    if (generated && typeof generated === 'object' && generated.meta) genMeta = generated.meta
    if (generated && typeof generated === 'object' && generated.draft) generated = generated.draft
  } catch (e) {
    const err = {
      message: e instanceof Error ? e.message : String(e),
      status: e && e.status ? Number(e.status) : null,
      code: e && e.code ? String(e.code) : null,
      cause: e && e.cause ? (e.cause.message ? String(e.cause.message) : String(e.cause)) : null
    }
    return {
      ok: false,
      repaired: false,
      status: Number.isFinite(Number(err.status)) ? Math.max(400, Math.min(599, Number(err.status))) : 502,
      message: err.message || 'ai_generate_failed',
      meta: { provider, model: model || null, api: apiUrl || null, error: err },
      scripts: null,
      blueprint: null,
      before: null,
      after: null
    }
  }

  const generatedTitle = generated && typeof generated.title === 'string' ? String(generated.title).trim() : ''
  if (!generated || typeof generated !== 'object' || !Array.isArray(generated.cards)) {
    const err = genMeta && genMeta.error ? genMeta.error : null
    return {
      ok: false,
      repaired: false,
      status: err && Number.isFinite(Number(err.status)) ? Math.max(400, Math.min(599, Number(err.status))) : 502,
      message: err && err.message ? String(err.message) : 'AI 未返回有效脚本卡片',
      title: generatedTitle,
      meta: genMeta || { provider, model: model || null, api: apiUrl || null, error: err },
      scripts: null,
      blueprint: null,
      before: null,
      after: null
    }
  }

  const initialScripts = buildScriptsFromDraftCards(generated.cards, prevScripts, formula)
  if (!initialScripts) {
    return {
      ok: false,
      repaired: false,
      status: 502,
      message: 'AI 返回了空脚本，未生成可用场景卡片',
      title: generatedTitle,
      meta: genMeta || { provider, model: model || null, api: apiUrl || null, error: null },
      scripts: null,
      blueprint: null,
      before: null,
      after: null
    }
  }

  const compiledBefore = compileBlueprintFromScripts({ scripts: initialScripts, prevBlueprint, expectedFormula: formula })
  const validationBefore = validateBlueprintDoc(compiledBefore.blueprint)
  const beforeIssues = collectBlockingScriptIssues(compiledBefore.report, validationBefore)
  const before = { report: compiledBefore.report, validation: validationBefore, issues: beforeIssues }

  if (!beforeIssues.length) {
    return {
      ok: true,
      repaired: false,
      title: generatedTitle,
      scripts: initialScripts,
      blueprint: compiledBefore.blueprint,
      meta: genMeta || { provider, model: model || null, api: apiUrl || null, error: null },
      before,
      after: before
    }
  }

  let fixed = null
  try {
    fixed = await repairScriptDraft({
      projectTitle: String(projectTitle || title || generatedTitle || '').trim(),
      scripts: initialScripts,
      rules,
      formula,
      report: compiledBefore.report,
      validation: validationBefore,
      provider,
      model,
      apiUrl,
      proxyUrl,
      timeoutMs
    })
  } catch (e) {
    const err = {
      message: e instanceof Error ? e.message : String(e),
      status: e && e.status ? Number(e.status) : null,
      code: e && e.code ? String(e.code) : null,
      cause: e && e.cause ? (e.cause.message ? String(e.cause.message) : String(e.cause)) : null
    }
    return {
      ok: false,
      repaired: true,
      status: Number.isFinite(Number(err.status)) ? Math.max(400, Math.min(599, Number(err.status))) : 502,
      message: `脚本初稿未通过校验，AI 修复失败：${err.message || 'unknown_error'}`,
      title: generatedTitle,
      meta: { ...(genMeta || { provider, model: model || null, api: apiUrl || null }), error: err },
      scripts: initialScripts,
      blueprint: compiledBefore.blueprint,
      before,
      after: null
    }
  }

  if (!fixed || typeof fixed !== 'object' || !fixed.draft || typeof fixed.draft !== 'object' || !Array.isArray(fixed.draft.cards)) {
    return {
      ok: false,
      repaired: true,
      status: 502,
      message: `脚本初稿未通过校验，且当前 Provider 没有返回可用修复结果：${summarizeScriptIssues(beforeIssues) || 'unknown_issue'}`,
      title: generatedTitle,
      meta: fixed && typeof fixed === 'object' && fixed.meta
        ? fixed.meta
        : (genMeta || { provider, model: model || null, api: apiUrl || null, error: null }),
      scripts: initialScripts,
      blueprint: compiledBefore.blueprint,
      before,
      after: null
    }
  }

  const repairedTitle = fixed.draft && typeof fixed.draft.title === 'string' ? String(fixed.draft.title).trim() : generatedTitle
  const repairedScripts = buildScriptsFromDraftCards(fixed.draft.cards, prevScripts || initialScripts, formula)
  if (!repairedScripts) {
    return {
      ok: false,
      repaired: true,
      status: 502,
      message: 'AI 修复返回了空脚本，无法生成可用场景卡片',
      title: repairedTitle,
      meta: fixed.meta || genMeta || { provider, model: model || null, api: apiUrl || null, error: null },
      scripts: initialScripts,
      blueprint: compiledBefore.blueprint,
      before,
      after: null
    }
  }

  const compiledAfter = compileBlueprintFromScripts({ scripts: repairedScripts, prevBlueprint, expectedFormula: formula })
  const validationAfter = validateBlueprintDoc(compiledAfter.blueprint)
  const afterIssues = collectBlockingScriptIssues(compiledAfter.report, validationAfter)
  const after = { report: compiledAfter.report, validation: validationAfter, issues: afterIssues }

  if (afterIssues.length) {
    return {
      ok: false,
      repaired: true,
      status: 502,
      message: `AI 修复后仍未通过结构校验：${summarizeScriptIssues(afterIssues) || 'unknown_issue'}`,
      title: repairedTitle,
      meta: fixed.meta || genMeta || { provider, model: model || null, api: apiUrl || null, error: null },
      scripts: repairedScripts,
      blueprint: compiledAfter.blueprint,
      before,
      after
    }
  }

  return {
    ok: true,
    repaired: true,
    title: repairedTitle,
    scripts: repairedScripts,
    blueprint: compiledAfter.blueprint,
    meta: fixed.meta || genMeta || { provider, model: model || null, api: apiUrl || null, error: null },
    before,
    after
  }
}

app.get('/api/projects', async (c) => {
  await ensureDirs()
  const items = []
  const dirs = await readdir(PROJECTS_DIR).catch(() => [])
  for (const id of dirs) {
    const dir = projectDir(id)
    if (!(await existsDir(dir))) continue
    try {
      const p0 = await readJson(path.join(dir, 'project.json'))
      const { project: p, changed } = normalizeProjectAndDetectChanges(p0)
      items.push(p)
      if (changed) await writeJson(path.join(dir, 'project.json'), p)
    } catch (_) {}
  }
  items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  return c.json({ success: true, items })
})

app.post('/api/projects', async (c) => {
  await ensureDirs()
  const body = await c.req.json().catch(() => ({}))
  const title = String(body?.title || '').trim() || '未命名故事'
  const id = crypto.randomUUID ? crypto.randomUUID() : `p_${Math.random().toString(36).slice(2, 10)}`
  const dir = projectDir(id)
  await mkdir(path.join(dir, 'assets'), { recursive: true })
  const project = normalizeProjectDoc({
    schemaVersion: '2.0',
    id,
    title,
    pluginId: 'story-pixi',
    pluginVersion: '0.1.0',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    characters: [],
    assets: [],
    events: [],
    state: { vars: [] }
  })
  await writeJson(path.join(dir, 'project.json'), project)
  await writeJson(path.join(dir, 'story.json'), defaultStory())

  // 三层工作流：脚本层/蓝图层默认文件（P0）
  await writeJson(path.join(dir, 'meta.json'), defaultMeta({ id, title }))
  await writeJson(path.join(dir, 'scripts.json'), defaultScripts())
  await writeJson(path.join(dir, 'blueprint.json'), defaultBlueprint())

  return c.json({ success: true, project })
})

// AI: Create new project + scripts from prompt (P0: scripts layer only)
app.post('/api/projects/ai/create', async (c) => {
  await ensureDirs()
  const body = await c.req.json().catch(() => ({}))
  const prompt = String(body?.prompt || '').trim()
  if (!prompt) return c.json({ success: false, error: 'missing_prompt', message: 'prompt 不能为空' }, 400)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.scripts) {
    return c.json({ success: false, error: 'disabled', message: '“写故事（脚本生成）”已在设置中关闭' }, 503)
  }

  const titleIn = String(body?.title || '').trim()
  const formula = normalizeAiStoryFormula(body)
  const id = crypto.randomUUID ? crypto.randomUUID() : `p_${Math.random().toString(36).slice(2, 10)}`
  const dir = projectDir(id)

  const startedAt = Date.now()
  const aiTimeoutMs = 90_000
  const requestedProvider = String(studio.effective.scripts.provider || 'local').toLowerCase()
  const requestedModel = studio.effective.scripts.model || null
  if (!requestedProvider || requestedProvider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“写故事脚本”并选择 Provider/Model' }, 400)
  }
  const globalRules = await readGlobalRules(ROOT)
  try {
    console.log(
      `[gamestudio] ai.create:start project=${id} requestedProvider=${requestedProvider}${requestedModel ? ` model=${requestedModel}` : ''} promptChars=${prompt.length}${titleIn ? ` titleChars=${titleIn.length}` : ''} choicePoints=${formula.choicePoints} optionsPerChoice=${formula.optionsPerChoice} endings=${formula.endings}`
    )
  } catch (_) {}
  const closed = await generateClosedScriptDraft({
    prompt,
    title: titleIn || undefined,
    projectTitle: titleIn || undefined,
    rules: globalRules,
    formula,
    provider: requestedProvider,
    model: requestedModel || undefined,
    apiUrl: studio.effective.scripts.apiUrl || undefined,
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
    const project = await writeAiDraftProject({
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
      blueprint: closed.blueprint || defaultBlueprint(),
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

  const project = await writeAiDraftProject({
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
      `[gamestudio] ai.create project=${id} requestedProvider=${requestedProvider} provider=${closed.meta?.provider || requestedProvider} model=${closed.meta?.model || '-'} api=${closed.meta?.api || '-'} repaired=${closed.repaired ? 'true' : 'false'} cards=${Array.isArray(closed.scripts?.cards) ? closed.scripts.cards.length : 0} ms=${durationMs}`
    )
  } catch (_) {}

  return c.json({
    success: true,
    project,
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

// AI: Regenerate scripts for an existing project (overwrite scripts.json)
app.post('/api/projects/:id/ai/regenerate', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const prompt = String(body?.prompt || '').trim()
  if (!prompt) return c.json({ success: false, error: 'missing_prompt', message: 'prompt 不能为空' }, 400)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.scripts) {
    return c.json({ success: false, error: 'disabled', message: '“写故事（脚本生成）”已在设置中关闭' }, 503)
  }

  const titleIn = String(body?.title || '').trim()
  const formula = normalizeAiStoryFormula(body)
  const startedAt = Date.now()
  const aiTimeoutMs = 90_000
  const requestedProvider = String(studio.effective.scripts.provider || 'local').toLowerCase()
  const requestedModel = studio.effective.scripts.model || null
  if (!requestedProvider || requestedProvider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“写故事脚本”并选择 Provider/Model' }, 400)
  }
  const globalRules = await readGlobalRules(ROOT)
  try {
    console.log(
      `[gamestudio] ai.regen:start project=${id} requestedProvider=${requestedProvider}${requestedModel ? ` model=${requestedModel}` : ''} promptChars=${prompt.length}${titleIn ? ` titleChars=${titleIn.length}` : ''} choicePoints=${formula.choicePoints} optionsPerChoice=${formula.optionsPerChoice} endings=${formula.endings}`
    )
  } catch (_) {}

  const currProject = normalizeProjectDoc(await readJson(path.join(dir, 'project.json')))
  let currScripts = null
  try { currScripts = await readJson(path.join(dir, 'scripts.json')) } catch (_) { currScripts = defaultScripts() }
  let currBlueprint = null
  try { currBlueprint = await readJson(path.join(dir, 'blueprint.json')) } catch (_) { currBlueprint = defaultBlueprint() }

  const closed = await generateClosedScriptDraft({
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
    await writeJson(path.join(dir, 'scripts.json'), closed.scripts)
    await writeJson(path.join(dir, 'blueprint.json'), closed.blueprint || defaultBlueprint())
    const failedProject = normalizeProjectDoc({ ...(currProject || {}), id, title: nextTitle, updatedAt: nowIso() })
    await writeJson(path.join(dir, 'project.json'), failedProject)
    try {
      const metaPath = path.join(dir, 'meta.json')
      const meta = (await existsFile(metaPath)) ? await readJson(metaPath) : null
      await writeJson(metaPath, { ...(meta && typeof meta === 'object' ? meta : defaultMeta({ id, title: nextTitle })), id, title: nextTitle, updatedAt: nowIso(), aiFormula: formula })
    } catch (_) {}
    return c.json({
      success: true,
      project: failedProject,
      scripts: closed.scripts,
      blueprint: closed.blueprint || defaultBlueprint(),
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
  await writeJson(path.join(dir, 'scripts.json'), closed.scripts)
  await writeJson(path.join(dir, 'blueprint.json'), closed.blueprint)

  // keep titles + timestamps in sync
  const nextProject = normalizeProjectDoc({ ...(currProject || {}), id, title: nextTitle, updatedAt: nowIso() })
  await writeJson(path.join(dir, 'project.json'), nextProject)
  try {
    const metaPath = path.join(dir, 'meta.json')
    const meta = (await existsFile(metaPath)) ? await readJson(metaPath) : null
    if (meta && typeof meta === 'object') {
      await writeJson(metaPath, { ...meta, id, title: nextTitle, updatedAt: nowIso(), aiFormula: formula })
    }
  } catch (_) {}

  const durationMs = Math.max(0, Date.now() - startedAt)
  try {
    console.log(
      `[gamestudio] ai.regen project=${id} requestedProvider=${requestedProvider} provider=${closed.meta?.provider || requestedProvider} model=${closed.meta?.model || '-'} api=${closed.meta?.api || '-'} repaired=${closed.repaired ? 'true' : 'false'} cards=${Array.isArray(closed.scripts?.cards) ? closed.scripts.cards.length : 0} ms=${durationMs}`
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
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const scriptsPath = path.join(dir, 'scripts.json')
  if (!(await existsFile(scriptsPath))) return c.json({ success: false, error: 'missing_scripts' }, 404)
  const scripts = await readJson(scriptsPath)
  const analysis = analyzeScriptsForBlueprint(scripts)

  return c.json({ success: true, analysis })
})

app.post('/api/projects/:id/validate/blueprint', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  let blueprint = null
  try {
    blueprint = await readJson(path.join(dir, 'blueprint.json'))
  } catch (_) {
    blueprint = defaultBlueprint()
    await writeJson(path.join(dir, 'blueprint.json'), blueprint)
  }

  const validation = validateBlueprintDoc(blueprint)
  return c.json({ success: true, validation })
})

app.post('/api/projects/:id/ai/review/blueprint', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const cachePath = path.join(dir, 'ai_blueprint_review.json')
  let meta = null
  try { meta = await readJson(path.join(dir, 'meta.json')) } catch (_) { meta = null }
  let project = null
  try { project = await readJson(path.join(dir, 'project.json')) } catch (_) { project = null }
  let scripts = null
  try { scripts = await readJson(path.join(dir, 'scripts.json')) } catch (_) { scripts = defaultScripts() }
  let currBlueprint = null
  try { currBlueprint = await readJson(path.join(dir, 'blueprint.json')) } catch (_) { currBlueprint = null }

  const expectedFormula = meta && typeof meta === 'object' ? meta.aiFormula : null
  const compiled = compileBlueprintFromScripts({ scripts, prevBlueprint: currBlueprint, expectedFormula })
  const validation = validateBlueprintDoc(compiled.blueprint)

  const studio = await getEffectiveStudioConfig(ROOT)
  const provider = String(studio.effective.scripts.provider || process.env.STUDIO_AI_PROVIDER || 'local').toLowerCase()
  const model = studio.effective.scripts.model || undefined
  const apiUrl = studio.effective.scripts.apiUrl || undefined
  const startedAt = Date.now()
  if (!isOpenAICompatibleProvider(provider)) {
    const review = reviewBlueprintLocally({ formula: expectedFormula, report: compiled.report, validation })
    try {
      await writeJson(cachePath, {
        schemaVersion: '1.0',
        updatedAt: nowIso(),
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
    try {
      console.log(
        `[gamestudio] ai.blueprint_review project=${id} provider=${ai?.meta?.provider || provider || 'localoxml'} model=${ai?.meta?.model || '-'} api=${ai?.meta?.api || '-'} ms=${ai?.meta?.durationMs || 0}`
      )
    } catch (_) {}
    try {
      await writeJson(cachePath, {
        schemaVersion: '1.0',
        updatedAt: nowIso(),
        projectId: id,
        scriptsUpdatedAt: String(scripts && scripts.updatedAt || ''),
        formula: expectedFormula || null,
        review: ai.review,
        meta: ai.meta
      })
    } catch (_) {}
    return c.json({ success: true, review: ai.review, meta: ai.meta, report: compiled.report, validation })
  } catch (e) {
    try {
      console.error('[gamestudio] ai blueprint review failed:', e instanceof Error ? e.message : String(e))
    } catch (_) {}
    const review = reviewBlueprintLocally({ formula: expectedFormula, report: compiled.report, validation })
    try {
      await writeJson(cachePath, {
        schemaVersion: '1.0',
        updatedAt: nowIso(),
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

app.post('/api/projects/:id/ai/fix/scripts', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.scripts) {
    return c.json({ success: false, error: 'disabled', message: '“写故事（脚本生成）”已在设置中关闭' }, 503)
  }

  let meta = null
  try { meta = await readJson(path.join(dir, 'meta.json')) } catch (_) { meta = null }
  let project = null
  try { project = await readJson(path.join(dir, 'project.json')) } catch (_) { project = null }
  let scripts = null
  try { scripts = await readJson(path.join(dir, 'scripts.json')) } catch (_) { scripts = defaultScripts() }
  let currBlueprint = null
  try { currBlueprint = await readJson(path.join(dir, 'blueprint.json')) } catch (_) { currBlueprint = null }

  const expectedFormula = meta && typeof meta === 'object' ? meta.aiFormula : null
  const compiledBefore = compileBlueprintFromScripts({ scripts, prevBlueprint: currBlueprint, expectedFormula })
  const validationBefore = validateBlueprintDoc(compiledBefore.blueprint)

  const requestedProvider = String(studio.effective.scripts.provider || 'local').toLowerCase()
  const requestedModel = studio.effective.scripts.model || null
  const globalRules = await readGlobalRules(ROOT)

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
      console.error('[gamestudio] ai fix scripts failed:', msg, causeMsg ? `cause=${causeMsg}` : '', causeCode ? `code=${causeCode}` : '')
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
        updatedAt: nowIso()
      }
    })
    .filter((c) => c.text.trim())

  const nextScripts = { schemaVersion: '1.0', cards: cardsOut, updatedAt: nowIso() }
  await writeJson(path.join(dir, 'scripts.json'), nextScripts)

  const compiledAfter = compileBlueprintFromScripts({ scripts: nextScripts, prevBlueprint: currBlueprint, expectedFormula })
  const validationAfter = validateBlueprintDoc(compiledAfter.blueprint)

  await writeJson(path.join(dir, 'blueprint.json'), compiledAfter.blueprint)
  await touchProjectUpdatedAt(dir)

  const durationMs = Math.max(0, Date.now() - startedAt)
  try {
    console.log(
      `[gamestudio] ai.scripts_fix project=${id} requestedProvider=${requestedProvider}${requestedModel ? ` model=${requestedModel}` : ''} provider=${fixed?.meta?.provider || 'unknown'} model=${fixed?.meta?.model || '-'} api=${fixed?.meta?.api || '-'} okBefore=${validationBefore?.ok ? 'true' : 'false'} okAfter=${validationAfter?.ok ? 'true' : 'false'} cards=${cardsOut.length} ms=${durationMs}`
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

app.get('/api/projects/:id/ai/review/blueprint', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const cachePath = path.join(dir, 'ai_blueprint_review.json')
  try {
    const cached = await readJson(cachePath)
    return c.json({ success: true, cached })
  } catch (_) {
    return c.json({ success: true, cached: null })
  }
})

app.get('/api/projects/:id', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const p0 = await readJson(path.join(dir, 'project.json'))
  const { project, changed } = normalizeProjectAndDetectChanges(p0)
  if (changed) await writeJson(path.join(dir, 'project.json'), project)
  const story = await readJson(path.join(dir, 'story.json'))
  return c.json({ success: true, project, story })
})

app.put('/api/projects/:id', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const project = body?.project && typeof body.project === 'object' ? body.project : null
  const story = body?.story && typeof body.story === 'object' ? body.story : null

  const curr0 = await readJson(path.join(dir, 'project.json'))
  const { project: curr } = normalizeProjectAndDetectChanges(curr0)
  let mergedProject = project ? { ...curr, ...project, id, updatedAt: nowIso() } : { ...curr, updatedAt: nowIso() }
  if (project && Array.isArray(project.assets)) {
    const incomingAssets = Array.isArray(project.assets) ? project.assets : []
    const incomingKeys = new Set(incomingAssets.map((item) => `${String(item && item.id || '').trim()}::${normalizeStoryAssetUri(item && item.uri)}`))
    const preservedManagedAssets = Array.isArray(curr.assets)
      ? curr.assets.filter((item) => {
          const uri = normalizeStoryAssetUri(item && item.uri)
          if (!uri) return false
          const managed = (
            uri.startsWith('assets/ai/story_assets/') ||
            uri.startsWith('assets/ai/story_lineart/') ||
            uri.startsWith('assets/ai/story_lock_tests/')
          )
          if (!managed) return false
          const key = `${String(item && item.id || '').trim()}::${uri}`
          return !incomingKeys.has(key)
        })
      : []
    mergedProject = {
      ...mergedProject,
      assets: [...incomingAssets, ...preservedManagedAssets]
    }
  }
  const next0 = mergedProject
  const next = normalizeProjectDoc(next0)
  await writeJson(path.join(dir, 'project.json'), next)
  if (story) await writeJson(path.join(dir, 'story.json'), story)

  // Keep meta.json title in sync for Hub list display.
  try {
    const title = (project && typeof project.title === 'string') ? String(project.title) : null
    if (title != null) {
      const metaPath = path.join(dir, 'meta.json')
      const meta = (await existsFile(metaPath)) ? await readJson(metaPath) : null
      if (meta && typeof meta === 'object') {
        await writeJson(metaPath, { ...meta, title: String(title), updatedAt: nowIso() })
      }
    }
  } catch (_) {}

  return c.json({ success: true, project: next })
})

app.delete('/api/projects/:id', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  try {
    await rm(dir, { recursive: true, force: true })
  } catch (e) {
    return c.json({ success: false, error: 'delete_failed', message: e && e.message ? e.message : String(e) }, 500)
  }

  // best-effort: remove exported builds for project
  try {
    await rm(projectBuildsDir(id), { recursive: true, force: true })
  } catch (_) {}

  return c.json({ success: true })
})




// ===== 三层工作流：脚本层 / 蓝图层（P0） =====

app.get('/api/projects/:id/scripts', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const pth = path.join(dir, 'scripts.json')
  let scripts = null
  try {
    scripts = await readJson(pth)
  } catch (_) {
    scripts = defaultScripts()
    await writeJson(pth, scripts)
  }

  return c.json({ success: true, scripts })
})

app.put('/api/projects/:id/scripts', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const next = body && typeof body === 'object' && body.scripts && typeof body.scripts === 'object' ? body.scripts : body

  const cardsIn = Array.isArray(next && next.cards) ? next.cards : []
  const cards = cardsIn.map((x, i) => ({
    id: String(x && x.id || ''),
    name: String(x && x.name || `脚本${i + 1}`),
    order: Number.isFinite(Number(x && x.order)) ? Number(x.order) : (i + 1),
    text: String(x && x.text || ''),
    updatedAt: String(x && x.updatedAt || nowIso())
  })).filter((c) => c.id)

  const scripts = {
    schemaVersion: '1.0',
    cards,
    updatedAt: nowIso()
  }

  await writeJson(path.join(dir, 'scripts.json'), scripts)
  await touchProjectUpdatedAt(dir)
  return c.json({ success: true, scripts })
})

app.get('/api/projects/:id/blueprint', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const pth = path.join(dir, 'blueprint.json')
  let blueprint = null
  try {
    blueprint = await readJson(pth)
  } catch (_) {
    blueprint = defaultBlueprint()
    await writeJson(pth, blueprint)
  }

  return c.json({ success: true, blueprint })
})

app.put('/api/projects/:id/blueprint', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

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
    updatedAt: nowIso()
  }

  await writeJson(path.join(dir, 'blueprint.json'), blueprint)
  await touchProjectUpdatedAt(dir)
  return c.json({ success: true, blueprint })
})

// Script → Blueprint（P0：merge/update）
app.post('/api/projects/:id/compile/blueprint', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  let currBlueprint = null
  try {
    currBlueprint = await readJson(path.join(dir, 'blueprint.json'))
  } catch (_) {
    currBlueprint = null
  }

  let meta = null
  try {
    meta = await readJson(path.join(dir, 'meta.json'))
  } catch (_) {
    meta = null
  }

  let scripts = null
  try {
    scripts = await readJson(path.join(dir, 'scripts.json'))
  } catch (_) {
    scripts = defaultScripts()
    await writeJson(path.join(dir, 'scripts.json'), scripts)
  }

  const expectedFormula = meta && typeof meta === 'object' ? meta.aiFormula : null
  const compiled = compileBlueprintFromScripts({ scripts, prevBlueprint: currBlueprint, expectedFormula })
  const blueprint = compiled.blueprint
  const validation = validateBlueprintDoc(blueprint)

  await writeJson(path.join(dir, 'blueprint.json'), blueprint)
  await touchProjectUpdatedAt(dir)
  return c.json({ success: true, blueprint, report: compiled.report, validation })
})

// Blueprint → Compose（P0：overwrite/reset）
app.post('/api/projects/:id/compile/compose', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  let currProject = null
  try {
    currProject = await readJson(path.join(dir, 'project.json'))
  } catch (_) {
    currProject = null
  }

  let currStory = null
  try {
    currStory = await readJson(path.join(dir, 'story.json'))
  } catch (_) {
    currStory = null
  }

  let blueprint = null
  try {
    blueprint = await readJson(path.join(dir, 'blueprint.json'))
  } catch (_) {
    blueprint = defaultBlueprint()
    await writeJson(path.join(dir, 'blueprint.json'), blueprint)
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
      const timeline = {
        steps: [
          isEnding
            ? {
                id: `st_${nodeId}_1`,
                actions: [
                  {
                    type: 'ui.showEndingCard',
                    card: {
                      title: String(n && n.name || nodeId),
                      bullets: [],
                      moral: textDraft || '故事结束。',
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
      try {
        const prevPlacements = Array.isArray(prevVisuals && prevVisuals.placements) ? prevVisuals.placements : []
        const prevByActor = new Map(prevPlacements.map((p) => [String(p && p.characterId || ''), p]).filter(([id]) => id))
        const nextPlacements = desiredActorIds.map((actorId) => {
          const keep = prevByActor.get(actorId) || null
          if (keep) return keep
          return {
            id: `pl_${nodeId}_${actorId}`,
            characterId: actorId,
            transform: { x: 0.5, y: 1, scale: 1, rotationDeg: 0 },
            visible: true,
            zIndex: 0
          }
        })
        mergedVisuals.placements = nextPlacements
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
    pluginVersion: String(currProject && currProject.pluginVersion || TOOL_VERSION),
    createdAt: String(currProject && currProject.createdAt || nowIso()),
    updatedAt: nowIso(),
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

  await writeJson(path.join(dir, 'project.json'), nextProject)
  await writeJson(path.join(dir, 'story.json'), story)
  await touchProjectUpdatedAt(dir)

  return c.json({ success: true, project: nextProject, story })
})

app.get('/api/demos', async (c) => {
  await ensureDirs()
  const items = []
  const dirs = await readdir(DEMO_LIBRARY_DIR).catch(() => [])
  for (const id of dirs) {
    const dir = demoLibDir(id)
    if (!(await existsDir(dir))) continue
    try {
      const story = await readJson(path.join(dir, 'story.json'))
      const nodes = Array.isArray(story && story.nodes) ? story.nodes : []
      let title = String(id)
      let demoProject = null
      try { demoProject = await readJson(path.join(dir, 'project.json')) } catch (_) {}
      try {
        const meta = await readJson(path.join(dir, 'demo.json'))
        if (meta && typeof meta.title === 'string' && meta.title.trim()) title = meta.title.trim()
      } catch (_) {}
      items.push({ id: String(id), title: (demoProject && demoProject.title) ? String(demoProject.title) : title, nodesCount: nodes.length })
    } catch (_) {}
  }
  items.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return c.json({ success: true, items })
})

app.get('/api/demos/:id', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = demoLibDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const story = await readJson(path.join(dir, 'story.json'))
  let title = String(id)
  let demoProject = null
  try { demoProject = await readJson(path.join(dir, 'project.json')) } catch (_) {}
  try {
    const meta = await readJson(path.join(dir, 'demo.json'))
    if (meta && typeof meta.title === 'string' && meta.title.trim()) title = meta.title.trim()
  } catch (_) {}
  return c.json({
    success: true,
    demo: { id: String(id), title: (demoProject && demoProject.title) ? String(demoProject.title) : title, assetBase: `/demo-library/${encodeURIComponent(String(id))}/` },
    project: demoProject || null,
    story
  })
})

app.post('/api/projects/:id/export', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const { buildId } = await buildProjectDistForExport(id, dir)

  return c.json({
    success: true,
    buildId,
    distUrl: `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/dist/index.html`
  })
})

app.post('/api/projects/:id/export/publish', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const { buildId, out } = await buildProjectDistForExport(id, dir)
  const zipName = `h5_story_${String(id)}_${String(buildId)}.zip`
  const zipAbs = path.join(out, zipName)
  try {
    await packageDistAsZip(out, zipName)
  } catch (e) {
    return c.json({
      success: false,
      error: 'zip_failed',
      message: e && e.message ? String(e.message) : String(e),
      buildId,
      distUrl: `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/dist/index.html`
    }, 500)
  }
  return c.json({
    success: true,
    buildId,
    distUrl: `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/dist/index.html`,
    packageUrl: `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/${encodeURIComponent(zipName)}`,
    packageName: zipName,
    packageBytes: Number((await stat(zipAbs)).size || 0)
  })
})

app.get('/api/projects/:id/exports', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectBuildsDir(id)
  const items = []
  const buildId = 'latest'
  const buildDir = path.join(dir, buildId)
  if (await existsDir(buildDir)) {
    const distIndex = path.join(buildDir, 'dist', 'index.html')
    const hasDist = await existsFile(distIndex)
    const files = await readdir(buildDir).catch(() => [])
    const zip = files.find((f) => /^h5_story_.*\.zip$/i.test(String(f || '')))
    const st = await stat(buildDir).catch(() => null)
    items.push({
      buildId,
      createdAt: st && st.mtime ? st.mtime.toISOString() : '',
      distUrl: hasDist ? `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/dist/index.html` : '',
      packageUrl: zip ? `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/${encodeURIComponent(zip)}` : '',
      packageName: zip || ''
    })
  }
  return c.json({ success: true, items })
})

app.delete('/api/projects/:id/exports/:buildId', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const buildId = String(c.req.param('buildId') || '').trim()
  if (!buildId) return c.json({ success: false, error: 'missing_buildId' }, 400)
  const dir = projectBuildDir(id, buildId)
  if (!(await existsDir(dir))) return c.json({ success: true, removed: false })
  try {
    await rm(dir, { recursive: true, force: true })
    return c.json({ success: true, removed: true })
  } catch (e) {
    return c.json({ success: false, error: 'delete_failed', message: e && e.message ? String(e.message) : String(e) }, 500)
  }
})

// 静态服务 demo 产物（P0：仅 demos）

// 静态服务 demo_library（手动拷贝的 demo 与素材）
app.get('/demo-library/:demoId/:rest{.*}', async (c) => {
  await ensureDirs()
  const demoId = c.req.param('demoId')
  let rest = String(c.req.param('rest') || '')
  try {
    rest = decodeURIComponent(rest)
  } catch (_) {}
  rest = rest.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rest || rest.split('/').some((seg) => seg === '..')) return c.text('Not Found', 404)
  const filePath = path.join(demoLibDir(demoId), rest)
  try {
    const buf = await readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const ct =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      ext === '.js' ? 'application/javascript; charset=utf-8' :
      ext === '.css' ? 'text/css; charset=utf-8' :
      ext in {'.png':1,'.jpg':1,'.jpeg':1,'.gif':1,'.webp':1} ? 'image/' + ext.slice(1) :
      'application/octet-stream'
    c.header('Content-Type', ct)
    return c.body(buf)
  } catch (_) {
    return c.text('Not Found', 404)
  }
})

app.get('/demos/:projectId/:buildId/:rest{.*}', async (c) => {
  await ensureDirs()
  const projectId = c.req.param('projectId')
  const buildId = c.req.param('buildId')
  let rest = String(c.req.param('rest') || '')
  try {
    rest = decodeURIComponent(rest)
  } catch (_) {}
  rest = rest.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rest || rest.split('/').some((seg) => seg === '..')) return c.text('Not Found', 404)
  const baseDir = projectBuildDir(projectId, buildId)
  const filePath = path.join(baseDir, rest)
  try {
    const buf = await readFile(filePath)
    // 简单 content-type
    const ext = path.extname(filePath).toLowerCase()
    const ct =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      ext === '.js' ? 'application/javascript; charset=utf-8' :
      ext === '.css' ? 'text/css; charset=utf-8' :
      ext === '.zip' ? 'application/zip' :
      'application/octet-stream'
    if (ext === '.zip') c.header('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`)
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    c.header('Pragma', 'no-cache')
    c.header('Expires', '0')
    c.header('Content-Type', ct)
    return c.body(buf)
  } catch (_) {
    return c.text('Not Found', 404)
  }
})


// 静态服务 project assets（用于编辑器预览 assets/...）
// 兼容：/project-assets/<pid>/assets/uploads/<file>
app.get('/project-assets/:projectId/assets/uploads/:file', async (c) => {
  await ensureDirs()
  // Ensure cross-origin image loading works in editor (Pixi/WebGL needs CORS-enabled images).
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  const projectId = c.req.param('projectId')
  const file = path.basename(String(c.req.param('file') || ''))
  if (!file) return c.text('Not Found', 404)
  const filePath = path.join(projectDir(projectId), 'assets', 'uploads', file)
  try {
    const buf = await readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const ct =
      ext === '.png' ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      ext === '.webp' ? 'image/webp' :
      ext === '.gif' ? 'image/gif' :
      'application/octet-stream'
    c.header('Content-Type', ct)
    return c.body(buf)
  } catch (_) {
    return c.text('Not Found', 404)
  }
})

app.on('HEAD', '/project-assets/:projectId/assets/uploads/:file', async (c) => {
  await ensureDirs()
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  const projectId = c.req.param('projectId')
  const file = path.basename(String(c.req.param('file') || ''))
  if (!file) return c.text('Not Found', 404)
  const filePath = path.join(projectDir(projectId), 'assets', 'uploads', file)
  if (!(await existsFile(filePath))) return c.text('Not Found', 404)
  const ext = path.extname(filePath).toLowerCase()
  const ct =
    ext === '.png' ? 'image/png' :
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
    ext === '.webp' ? 'image/webp' :
    ext === '.gif' ? 'image/gif' :
    'application/octet-stream'
  c.header('Content-Type', ct)
  return c.text('', 200)
})

app.get('/project-assets/:projectId/:rest{.*}', async (c) => {
  await ensureDirs()
  // Ensure cross-origin image loading works in editor (Pixi/WebGL needs CORS-enabled images).
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  const projectId = c.req.param('projectId')
  let rest = String(c.req.param('rest') || '')
  try {
    rest = decodeURIComponent(rest)
  } catch (_) {}
  rest = rest.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rest || rest.split('/').some((seg) => seg === '..')) return c.text('Not Found', 404)
  const base = projectDir(projectId)
  const candidates = [path.join(base, rest)]
  if (!rest.startsWith('assets/')) candidates.push(path.join(base, 'assets', rest))
  let filePath = ''
  for (const cand of candidates) {
    if (await existsFile(cand)) {
      filePath = cand
      break
    }
  }
  if (!filePath) return c.text('Not Found', 404)
  try {
    const buf = await readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    let ct =
      ext === '.png' ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      ext === '.webp' ? 'image/webp' :
      ext === '.gif' ? 'image/gif' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      'application/octet-stream'
    const sniff = ct.startsWith('image/') ? sniffImageMetaFromBytes(buf) : null
    if (sniff && sniff.contentType) ct = sniff.contentType
    c.header('Content-Type', ct)
    return c.body(buf)
  } catch (_) {
    return c.text('Not Found', 404)
  }
})

app.on('HEAD', '/project-assets/:projectId/:rest{.*}', async (c) => {
  await ensureDirs()
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  const projectId = c.req.param('projectId')
  let rest = String(c.req.param('rest') || '')
  try {
    rest = decodeURIComponent(rest)
  } catch (_) {}
  rest = rest.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rest || rest.split('/').some((seg) => seg === '..')) return c.text('Not Found', 404)
  const base = projectDir(projectId)
  const candidates = [path.join(base, rest)]
  if (!rest.startsWith('assets/')) candidates.push(path.join(base, 'assets', rest))
  let filePath = ''
  for (const cand of candidates) {
    if (await existsFile(cand)) {
      filePath = cand
      break
    }
  }
  if (!filePath) return c.text('Not Found', 404)
  const ext = path.extname(filePath).toLowerCase()
  const ct =
    ext === '.png' ? 'image/png' :
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
    ext === '.webp' ? 'image/webp' :
    ext === '.gif' ? 'image/gif' :
    ext === '.json' ? 'application/json; charset=utf-8' :
    'application/octet-stream'
  c.header('Content-Type', ct)
  return c.text('', 200)
})

// 查看 AI 背景图输出目录（浏览器可打开，便于确认生成位置）
app.get('/api/projects/:id/assets/ai', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.text('Not Found', 404)

  const relDir = path.join('assets', 'ai')
  const outDir = path.join(dir, relDir)
  const items = await readdir(outDir).catch(() => [])
  const files = items
    .map((x) => String(x))
    .filter((x) => /\.(png|jpg|jpeg|webp|gif)$/i.test(x))
    .sort((a, b) => (a < b ? 1 : -1))

  const rows = files
    .map((f) => {
      const safe = encodeURIComponent(f)
      const url = `/project-assets/${encodeURIComponent(String(id))}/${relDir.replace(/\\/g, '/')}/${safe}`
      return `<li><a href="${url}" target="_blank" rel="noopener noreferrer">${f}</a></li>`
    })
    .join('\n')

  const html =
    `<!doctype html><html><head><meta charset="utf-8" />` +
    `<title>AI 背景输出目录</title>` +
    `<style>body{font-family:ui-sans-serif,system-ui;max-width:920px;margin:24px auto;padding:0 16px;line-height:1.6}code{background:#0b1220;color:#e5e7eb;padding:2px 6px;border-radius:6px}a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}</style>` +
    `</head><body>` +
    `<h2>AI 背景输出目录</h2>` +
    `<div>项目：<code>${String(id)}</code></div>` +
    `<div>相对路径：<code>${relDir.replace(/\\/g, '/')}</code></div>` +
    `<div>绝对路径：<code>${outDir}</code></div>` +
    `<hr />` +
    (files.length ? `<ol>${rows}</ol>` : `<div>暂无文件（请先生成背景图）。</div>`) +
    `</body></html>`

  c.header('Content-Type', 'text/html; charset=utf-8')
  return c.body(html)
})

function resolveAssetPathFromUri(projectId, uri) {
  const id = String(projectId || '').trim()
  const raw = String(uri || '').trim()
  if (!id || !raw) return null
  let s = raw
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s)
      s = String(u.pathname || '')
    }
  } catch (_) {}
  s = s.replace(/\\/g, '/')
  const marker = `/project-assets/${encodeURIComponent(String(id))}/`
  if (s.startsWith(marker)) {
    s = s.slice(marker.length)
  } else if (/^\/project-assets\//.test(s)) {
    const pfx = `/project-assets/${encodeURIComponent(String(id))}/`
    if (!s.startsWith(pfx)) return null
    s = s.slice(pfx.length)
  } else if (s.startsWith('/')) {
    s = s.replace(/^\/+/, '')
  }
  if (!s) return null
  if (!/^assets\//.test(s)) {
    if (/^(uploads|ai)\//.test(s)) s = `assets/${s}`
    else if (!/^assets\//.test(s)) s = `assets/${s}`
  }
  const base = projectDir(id)
  const abs = path.resolve(path.join(base, s))
  const baseNorm = path.resolve(base) + path.sep
  if (!(abs + path.sep).startsWith(baseNorm) && abs !== path.resolve(base)) return null
  return abs
}

function isExternallyReachableReferenceUrl(input) {
  const raw = String(input || '').trim()
  if (!/^https?:\/\//i.test(raw)) return false
  try {
    const u = new URL(raw)
    const host = String(u.hostname || '').trim().toLowerCase()
    if (!host) return false
    if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local')) return false
    if (/^127\./.test(host)) return false
    if (/^10\./.test(host)) return false
    if (/^192\.168\./.test(host)) return false
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false
    return true
  } catch (_) {
    return false
  }
}

async function archiveExistingAssetForReplacement(projectId, uri) {
  const abs = resolveAssetPathFromUri(projectId, uri)
  if (!abs) return null
  if (!(await existsFile(abs))) return null
  const parsed = path.parse(abs)
  for (let i = 1; i <= 999; i += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}_old${i}${parsed.ext}`)
    if (await existsFile(candidate)) continue
    await rename(abs, candidate)
    return candidate
  }
  throw new Error('archive_slot_exhausted')
}

function assetPathFromAbsolute(projectId, absPath) {
  const id = String(projectId || '').trim()
  if (!id || !absPath) return null
  const base = path.resolve(projectDir(id))
  const abs = path.resolve(String(absPath))
  const rel = path.relative(base, abs).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..')) return null
  return rel
}

function openFolderOnHost(folder) {
  const target = String(folder || '').trim()
  if (!target) return Promise.reject(new Error('missing_folder'))
  return new Promise((resolve, reject) => {
    let cmd = ''
    let args = []
    if (process.platform === 'darwin') {
      cmd = 'open'
      args = [target]
    } else if (process.platform === 'win32') {
      cmd = 'explorer'
      args = [target]
    } else {
      cmd = 'xdg-open'
      args = [target]
    }
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true })
    p.on('error', (e) => reject(e))
    p.unref()
    resolve(true)
  })
}

app.post('/api/projects/:id/assets/open-folder', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const uri = String(body?.uri || '').trim()
  if (!uri) return c.json({ success: false, error: 'missing_uri' }, 400)
  const abs = resolveAssetPathFromUri(id, uri)
  if (!abs) return c.json({ success: false, error: 'invalid_uri', message: '无法从 URI 解析到项目资源路径' }, 400)
  const folder = path.dirname(abs)
  try {
    await openFolderOnHost(folder)
    return c.json({ success: true, folder })
  } catch (e) {
    return c.json({ success: false, error: 'open_folder_failed', message: e && e.message ? String(e.message) : String(e), folder }, 500)
  }
})

// 上传本地资源（P0：仅图片，保存到 projects/<id>/assets/uploads）
app.post('/api/projects/:id/assets/upload', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  let file = null
  try {
    const form = await c.req.parseBody()
    file = form && (form.file || form.image || form.asset) ? (form.file || form.image || form.asset) : null
  } catch (_) {
    file = null
  }

  const isFileLike = (v) => {
    try {
      return v && typeof v === 'object' && typeof v.arrayBuffer === 'function'
    } catch (_) {
      return false
    }
  }
  if (!isFileLike(file)) {
    return c.json({ success: false, error: 'missing_file', message: '请使用 multipart/form-data 上传字段 file' }, 400)
  }

  const name = String(file.name || 'image.png')
  const ext = path.extname(name).toLowerCase()
  const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
  if (!allowed.has(ext)) {
    return c.json({ success: false, error: 'unsupported_type', message: `仅支持图片：${Array.from(allowed).join(', ')}` }, 415)
  }

  try {
    const relDir = path.join('assets', 'uploads')
    const outDir = path.join(dir, relDir)
    await mkdir(outDir, { recursive: true })
    const safeBase = path.basename(name, ext).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48) || 'image'
    const fname = `${safeBase}_${Date.now()}${ext}`
    const abs = path.join(outDir, fname)
    const buf = Buffer.from(await file.arrayBuffer())
    await writeFile(abs, buf)
    const assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
    return c.json({ success: true, assetPath, url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}` })
  } catch (e) {
    return c.json({ success: false, error: 'save_failed', message: e && e.message ? e.message : String(e) }, 500)
  }
})

// AI 生成背景图（P0：默认对接 SDWebUI txt2img；ComfyUI 预留）
// 说明：此功能只用于制作阶段生成素材，最终产物仍需通过 app_system 导入。
app.post('/api/projects/:id/ai/background', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

	const body = await c.req.json().catch(() => ({}))
	const scenePrompt = String(body?.prompt || '').trim()
	const sceneNegative = String(body?.negativePrompt || '').trim()
	const globalPrompt = String(body?.globalPrompt || '').trim()
	const globalNegativePrompt = String(body?.globalNegativePrompt || '').trim()
  const requestedModel = String(body?.model || '').trim()
  const requestedLoras = Array.isArray(body?.loras) ? body.loras.map((x) => String(x || '').trim()).filter(Boolean) : []
  const continuity = body && body.continuity && typeof body.continuity === 'object' ? body.continuity : null
	const width = Number(body?.width || 768)
	const height = Number(body?.height || 1024)
	if (!scenePrompt) return c.json({ success: false, error: 'missing_prompt' }, 400)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
	const bgProvider = String(studio.effective.image.provider || process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()
  if (!bgProvider || bgProvider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“出图（背景图）”并选择 Provider/Model' }, 400)
  }
  const timeoutRaw = body?.timeoutMs
  const bgTimeoutMs = (Number.isFinite(Number(timeoutRaw)) && Number(timeoutRaw) <= 0)
    ? 0
    : clampInt(timeoutRaw, 5_000, 300_000, clampInt(process.env.STUDIO_BG_TIMEOUT_MS, 5_000, 300_000, 180_000))
	const startedAt = Date.now()
  const traceId = createTraceId()
  const promptJoiner = (bgProvider === 'sdwebui' || bgProvider === 'comfyui') ? ', ' : '，'
	const effectivePrompt = [globalPrompt, scenePrompt].map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(promptJoiner)
	const effectiveNegative = [globalNegativePrompt, sceneNegative].map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ')
  const referenceImageUrls = Array.isArray(body?.referenceImageUrls)
    ? body.referenceImageUrls.map((x) => String(x || '').trim()).filter((x) => isExternallyReachableReferenceUrl(x))
    : []
  const requestedReferenceCount = Array.isArray(body?.referenceImageUrls)
    ? body.referenceImageUrls.map((x) => String(x || '').trim()).filter(Boolean).length
    : 0
  if (requestedReferenceCount > 0 && referenceImageUrls.length === 0) {
    return c.json({ success: false, error: 'reference_image_unreachable', message: '所选参考图链接仅本机可访问，Doubao 云端无法下载。请改用带 remoteUrl 的参考场景图。' }, 400)
  }
  const characterRefsIn = Array.isArray(body?.characterRefs) ? body.characterRefs : []
  const assetRefsIn = Array.isArray(body?.assetRefs) ? body.assetRefs : []
  const referenceImages = []
  for (const item of characterRefsIn) {
    if (!item || typeof item !== 'object') continue
    const characterId = String(item.characterId || '').trim()
    if (!characterId) continue
    const assetAbs = resolveAssetPathFromUri(id, item.assetUri || item.assetPath || '')
    if (!assetAbs || !(await existsFile(assetAbs))) continue
    try {
      const bytes = await readFile(assetAbs)
      referenceImages.push({
        role: 'character',
        characterId,
        characterName: String(item.characterName || characterId).trim() || characterId,
        assetId: String(item.assetId || '').trim() || undefined,
        filename: path.basename(assetAbs),
        bytes,
        weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : undefined,
        fingerprintPrompt: String(item.fingerprintPrompt || '').trim() || undefined
      })
    } catch (_) {}
  }
  for (const item of assetRefsIn) {
    if (!item || typeof item !== 'object') continue
    const assetId = String(item.assetId || '').trim()
    const assetName = String(item.assetName || item.name || assetId || 'reference').trim()
    const assetAbs = resolveAssetPathFromUri(id, item.assetUri || item.assetPath || '')
    if (!assetAbs || !(await existsFile(assetAbs))) continue
    try {
      const bytes = await readFile(assetAbs)
      referenceImages.push({
        role: String(item.assetType || item.category || 'asset').trim() || 'asset',
        assetId: assetId || undefined,
        assetName,
        filename: path.basename(assetAbs),
        bytes,
        weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : undefined
      })
    } catch (_) {}
  }
  logStage({
    stage: 'bg.create',
    event: 'start',
    traceId,
    project: id,
    provider: bgProvider,
    model: requestedModel || studio.effective.image.model || '-',
    item: `w${Math.floor(width || 0)}h${Math.floor(height || 0)} refs:${referenceImages.length}`
  })

	try {
	  const gen = await generateBackgroundImage({
	    prompt: effectivePrompt,
	    negativePrompt: effectiveNegative,
	    aspectRatio: body?.aspectRatio,
	    style: body?.style,
	    size: body?.size || studio.effective.image.size,
	    responseFormat: body?.responseFormat,
      watermark: body?.watermark,
      guidanceScale: body?.guidanceScale,
      sequentialImageGeneration: body?.sequentialImageGeneration,
      width,
      height,
      steps: body?.steps,
      cfgScale: body?.cfgScale,
      sampler: body?.sampler,
	      scheduler: body?.scheduler,
        seed: body?.seed,
        continuity,
          referenceImageUrls,
        referenceImages,
      workflowMode: String(body?.workflowMode || '').trim() || undefined,
      lockProfile: String(body?.lockProfile || '').trim() || undefined,
      provider: bgProvider,
      sdwebuiBaseUrl: studio.effective.image.sdwebuiBaseUrl,
      comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
      apiUrl: studio.effective.image.apiUrl,
      model: requestedModel || studio.effective.image.model,
      loras: requestedLoras.length ? requestedLoras : studio.effective.image.loras,
      proxyUrl: studio.effective.network.proxyUrl,
      timeoutMs: bgTimeoutMs
	    })
	    const buf = gen.bytes
	    const ext0 = String(gen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
	    const sniff = sniffImageMetaFromBytes(buf)
	    const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'
	    const relDir = path.join('assets', 'ai')
	    const outDir = path.join(dir, relDir)
	    await mkdir(outDir, { recursive: true })
      const existingAssetUri = String(body?.existingAssetUri || '').trim()
      const existingAssetAbs = existingAssetUri ? resolveAssetPathFromUri(id, existingAssetUri) : null
      let abs = ''
      let assetPath = ''
      if (existingAssetAbs && await existsFile(existingAssetAbs)) {
        const archived = await archiveExistingAssetForReplacement(id, existingAssetUri)
        abs = existingAssetAbs
        await writeFile(abs, buf)
        assetPath = String(assetPathFromAbsolute(id, abs) || '')
        if (!assetPath) throw new Error('invalid_replacement_asset_path')
        console.log(`[gamestudio] bg replace archived=${archived ? path.basename(archived) : '-'} restored=${path.basename(abs)}`)
      } else {
        const fname = `bg_${Date.now()}.${ext}`
        abs = path.join(outDir, fname)
        await writeFile(abs, buf)
        assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
      }
		    const provider = (gen && gen.meta && gen.meta.provider) ? String(gen.meta.provider) : String(process.env.STUDIO_BG_PROVIDER || 'sdwebui')
		    const remoteUrl = (gen && gen.meta && typeof gen.meta.url === 'string' && gen.meta.url.trim()) ? String(gen.meta.url).trim() : ''
        logStage({
          stage: 'bg.create',
          event: 'ok',
          traceId,
          project: id,
          provider,
          model: studio.effective.image.model || '-',
          ok: true,
          durationMs: Math.max(0, Date.now() - startedAt),
          item: `${ext}:${buf.length}`
        })
		    return c.json({
          success: true,
          provider,
          assetPath,
          url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`,
          remoteUrl,
          traceId,
          seed: gen && gen.meta ? gen.meta.seed : undefined,
          continuityUsed: Boolean(gen && gen.meta && gen.meta.continuityUsed)
        })
		  } catch (e) {
		    const msg = e && e.message ? String(e.message) : String(e)
        const mapped = classifyAiError(e)
        logStage({
          stage: 'bg.create',
          event: 'fail',
          traceId,
          project: id,
          provider: bgProvider,
          model: studio.effective.image.model || '-',
          status: mapped.httpStatus,
          ok: false,
          durationMs: Math.max(0, Date.now() - startedAt),
          err: msg
        })
        return c.json({ success: false, error: mapped.code, message: msg, traceId }, mapped.httpStatus)
	  }
})

// AI 解析用户描述 -> 生成标准生图提示词（用于豆包/Seedream）
app.post('/api/projects/:id/ai/background/prompt', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

	const body = await c.req.json().catch(() => ({}))
	const userInput = String(body?.userInput || '').trim()
	const globalPrompt = String(body?.globalPrompt || '').trim()
	const globalNegativePrompt = String(body?.globalNegativePrompt || '').trim()
	const aspectRatio = String(body?.aspectRatio || '').trim()
	const style = String(body?.style || '').trim()
  const outputLanguage = String(body?.outputLanguage || '').trim().toLowerCase() || 'en'
  const promptTimeoutMs = clampInt(
    body?.timeoutMs,
    5_000,
    180_000,
    clampInt(process.env.STUDIO_PROMPT_TIMEOUT_MS, 5_000, 180_000, 90_000)
  )
	if (!userInput) return c.json({ success: false, error: 'missing_userInput' }, 400)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.prompt) {
    return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)
  }
  if (!studio.effective.prompt.provider || studio.effective.prompt.provider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“提示词生成”并选择 Provider/Model' }, 400)
  }

	const startedAt = Date.now()
  const traceId = createTraceId()
  logStage({
    stage: 'bg.prompt',
    event: 'start',
    traceId,
    project: id,
    provider: studio.effective.prompt.provider || 'localoxml',
    model: studio.effective.prompt.model || '-',
    item: `chars:${userInput.length}`
  })
	try {
	  const { result, meta } = await generateBackgroundPrompt({
      userInput,
      globalPrompt,
      globalNegativePrompt,
      aspectRatio,
      style,
      outputLanguage,
      timeoutMs: promptTimeoutMs,
      targetImageProvider: studio.effective.image.provider,
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model,
      apiUrl: studio.effective.prompt.apiUrl,
      proxyUrl: studio.effective.network.proxyUrl
    })
    logStage({
      stage: 'bg.prompt',
      event: 'ok',
      traceId,
      project: id,
      provider: meta && meta.provider ? meta.provider : studio.effective.prompt.provider || 'localoxml',
      model: meta && meta.model ? meta.model : studio.effective.prompt.model || '-',
      ok: true,
      durationMs: Math.max(0, Date.now() - startedAt)
    })
	  return c.json({ success: true, result, meta, traceId })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    logStage({
      stage: 'bg.prompt',
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
    return c.json({ success: false, error: mapped.code, message: msg, traceId }, mapped.httpStatus)
  }
})

// AI：生成 Story Bible（角色/道具/地点锁定，用于连续分镜）
app.post('/api/projects/:id/ai/story/bible', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const input = body && typeof body === 'object' ? body.input : null
  if (!input || typeof input !== 'object') return c.json({ success: false, error: 'missing_input' }, 400)

  const timeoutRaw = Number(body?.timeoutMs)
  const timeoutMs = (Number.isFinite(timeoutRaw) && timeoutRaw <= 0)
    ? 0
    : clampInt(
        body?.timeoutMs,
        5_000,
        180_000,
        clampInt(process.env.STUDIO_PROMPT_TIMEOUT_MS, 5_000, 180_000, 90_000)
      )

  const studio = await getEffectiveStudioConfig(ROOT)
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
    const { result, meta } = await generateStoryBible({
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model,
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

app.post('/api/projects/:id/ai/translate', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const textIn = String(body?.text || '').trim()
  if (!textIn) return c.json({ success: false, error: 'missing_text', message: 'text 不能为空' }, 400)

  const timeoutRaw = Number(body?.timeoutMs)
  const timeoutMs = (Number.isFinite(timeoutRaw) && timeoutRaw <= 0)
    ? 0
    : clampInt(body?.timeoutMs, 5_000, 180_000, clampInt(process.env.STUDIO_PROMPT_TIMEOUT_MS, 5_000, 180_000, 60_000))

  const studio = await getEffectiveStudioConfig(ROOT)
  const translationCfg = studio.effective.translation || {}
  const promptCfg = studio.effective.prompt || {}
  const providers = [
    { provider: String(translationCfg.provider || '').trim().toLowerCase(), model: translationCfg.model, apiUrl: translationCfg.apiUrl, note: null },
    { provider: String(promptCfg.provider || '').trim().toLowerCase(), model: promptCfg.model, apiUrl: promptCfg.apiUrl, note: 'translation_fallback_to_prompt_provider' }
  ].filter((item, index, list) => item.provider && item.provider !== 'none' && list.findIndex((entry) => entry.provider === item.provider && String(entry.apiUrl || '') === String(item.apiUrl || '')) === index)

  if (!providers.length) {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中配置“提示词翻译接口”' }, 400)
  }

  const startedAt = Date.now()
  const traceId = createTraceId()
  const primaryProvider = providers[0]
  logStage({ stage: 'prompt.translate', event: 'start', traceId, project: id, provider: primaryProvider.provider || 'localoxml', model: primaryProvider.model || '-' })
  try {
    let translated = null
    let lastError = null
    for (const candidate of providers) {
      try {
        translated = await translatePromptText({
          provider: candidate.provider,
          model: candidate.model,
          apiUrl: candidate.apiUrl,
          proxyUrl: studio.effective.network.proxyUrl,
          timeoutMs,
          text: textIn,
          sourceLang: body?.sourceLang,
          targetLang: body?.targetLang,
          mode: body?.mode
        })
        if (translated && candidate.note) {
          translated.meta = { ...(translated.meta || {}), note: candidate.note }
        }
        break
      } catch (e) {
        lastError = e
      }
    }
    if (!translated) throw lastError || new Error('translation_failed')
    const { result, meta } = translated
    logStage({ stage: 'prompt.translate', event: 'ok', traceId, project: id, provider: meta && meta.provider ? meta.provider : primaryProvider.provider || 'localoxml', model: meta && meta.model ? meta.model : primaryProvider.model || '-', ok: true, durationMs: Math.max(0, Date.now() - startedAt) })
    return c.json({ success: true, result, meta, traceId })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    logStage({ stage: 'prompt.translate', event: 'fail', traceId, project: id, provider: primaryProvider.provider || 'localoxml', model: primaryProvider.model || '-', status: mapped.httpStatus, ok: false, durationMs: Math.max(0, Date.now() - startedAt), err: msg })
    return c.json({ success: false, error: mapped.code, message: msg, traceId }, mapped.httpStatus)
  }

})

app.post('/api/projects/:id/ai/story/assets/plan', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const bundle = await readProjectBundle(id)
  const storyBible = body && body.storyBible && typeof body.storyBible === 'object'
    ? body.storyBible
    : readStoryBibleFromProjectDoc(bundle.project)
  if (!storyBible || typeof storyBible !== 'object') {
    return c.json({ success: false, error: 'missing_story_bible', message: '未找到 Story Bible。请先生成 Story Bible，或在请求中传入 storyBible。' }, 400)
  }

  const prevManifest = body && body.rebuild ? null : await readStoryAssetPlanIfExists(id)
  const plan = buildStoryAssetPlan({
    project: bundle.project,
    story: bundle.story,
    storyBible,
    prevManifest
  })
  await saveStoryAssetPlan(id, plan)
  return c.json({ success: true, plan })
})

app.post('/api/projects/:id/ai/story/assets/plan/persist', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const plan = body && body.plan && typeof body.plan === 'object' ? body.plan : null
  if (!plan) {
    return c.json({ success: false, error: 'missing_plan', message: '缺少要保存的资产计划。' }, 400)
  }
  await saveStoryAssetPlan(id, plan)
  return c.json({ success: true, plan })
})

async function generateAndPersistStoryAssetReference({
  id,
  dir,
  bundle,
  plan,
  asset,
  studio,
  imgProvider,
  style,
  width,
  height,
  steps,
  cfgScale,
  sampler,
  scheduler,
  model,
  loras,
  prompt,
  negativePrompt,
  timeoutMs,
  seed
}) {
  const renderProfile = getStoryAssetRenderProfile(asset)
  const gen = await generateBackgroundImage({
    prompt,
    negativePrompt,
    width,
    height,
    style,
    steps,
    cfgScale,
    sampler,
    scheduler,
    seed,
    provider: imgProvider,
    sdwebuiBaseUrl: studio.effective.image.sdwebuiBaseUrl,
    comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
    apiUrl: studio.effective.image.apiUrl,
    model,
    loras,
    workflowMode: String(renderProfile.workflowMode || '').trim() || undefined,
    lockProfile: String(renderProfile.profile || '').trim() || undefined,
    proxyUrl: studio.effective.network.proxyUrl,
    timeoutMs
  })

  const finalGen = gen
  const buf = finalGen.bytes
  const ext0 = String(finalGen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
  const sniff = sniffImageMetaFromBytes(buf)
  const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'
  const target = buildStoryAssetFileTarget({
    dir,
    asset,
    prefix: 'reference',
    ext,
    seed
  })
  await mkdir(target.outDir, { recursive: true })
  await writeFile(target.absPath, buf)
  const assetPath = target.assetPath

  const projectAssetId = genId('asset')
  const projectAsset = {
    id: projectAssetId,
    kind: 'image',
    name: `故事资产 ${String(asset.name || asset.id || projectAssetId).trim()}`,
    uri: assetPath,
    source: {
      type: 'ai',
      prompt,
      negativePrompt,
      provider: String(finalGen?.meta?.provider || imgProvider || ''),
      model: String(finalGen?.meta?.model || model || '').trim() || undefined,
      remoteUrl: String(finalGen?.meta?.url || '').trim() || undefined,
      loras: Array.isArray(loras) ? loras : undefined,
      seed: Number.isFinite(Number(seed)) ? Number(seed) : (Number.isFinite(Number(finalGen?.meta?.seed)) ? Number(finalGen.meta.seed) : undefined)
    }
  }
  const nextProject = {
    ...bundle.rawProject,
    assets: [...(Array.isArray(bundle.rawProject.assets) ? bundle.rawProject.assets : []), projectAsset],
    updatedAt: new Date().toISOString()
  }
  await writeJson(path.join(dir, 'project.json'), nextProject)

  const nextPlan = {
    ...plan,
    generatedAt: new Date().toISOString(),
    assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
      if (String(item && item.id || '').trim() !== String(asset.id || '').trim()) return item
      const prevRefs = Array.isArray(item.generatedRefs) ? item.generatedRefs : []
      const hasPrimary = Boolean(String(item?.primaryReferenceAssetUri || '').trim())
      return {
        ...item,
        referenceStatus: hasPrimary ? 'ready' : 'candidates_ready',
        generatedRefs: [
          ...prevRefs,
          {
            projectAssetId,
            projectAssetUri: assetPath,
            createdAt: new Date().toISOString(),
            provider: String(finalGen?.meta?.provider || imgProvider || ''),
            model: String(finalGen?.meta?.model || model || '').trim() || undefined,
            remoteUrl: String(finalGen?.meta?.url || '').trim() || undefined,
            loras: Array.isArray(loras) ? loras : undefined,
            prompt,
            negativePrompt,
            width,
            height,
            seed: Number.isFinite(Number(seed)) ? Number(seed) : (Number.isFinite(Number(finalGen?.meta?.seed)) ? Number(finalGen.meta.seed) : undefined)
          }
        ]
      }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan)

  return {
    asset: (Array.isArray(nextPlan.assets) ? nextPlan.assets.find((item) => String(item && item.id || '').trim() === String(asset.id || '').trim()) : null) || null,
    projectAsset,
    assetPath,
    url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`,
    provider: String(finalGen?.meta?.provider || imgProvider || ''),
    model: String(finalGen?.meta?.model || model || '').trim() || undefined,
    remoteUrl: String(finalGen?.meta?.url || '').trim() || undefined,
    prompt,
    negativePrompt,
    seed: Number.isFinite(Number(seed)) ? Number(seed) : (Number.isFinite(Number(finalGen?.meta?.seed)) ? Number(finalGen.meta.seed) : undefined),
    plan: nextPlan
  }
}

async function applyWhiteBackgroundToStoryAssetReference({
  id,
  dir,
  plan,
  asset,
  sourceRef,
  studio,
  timeoutMs
}) {
  const category = String(asset?.category || '').trim()
  const comfyuiBaseUrl = String(studio?.effective?.image?.comfyuiBaseUrl || '').trim()
  if (!['character', 'prop'].includes(category) || !comfyuiBaseUrl) {
    return {
      plan,
      primaryReferenceAssetId: String(sourceRef?.projectAssetId || '').trim(),
      primaryReferenceAssetUri: String(sourceRef?.projectAssetUri || '').trim()
    }
  }

  const sourceUri = String(sourceRef?.projectAssetUri || '').trim().replace(/^\/+/, '')
  if (!sourceUri) {
    return {
      plan,
      primaryReferenceAssetId: String(sourceRef?.projectAssetId || '').trim(),
      primaryReferenceAssetUri: String(sourceRef?.projectAssetUri || '').trim()
    }
  }

  try {
    const abs = path.join(dir, sourceUri)
    const bytes = await readFile(abs)
    const post = await generateComfyuiWhiteBackgroundFromReference({
      referenceBytes: bytes,
      referenceFilename: `${String(asset?.id || 'asset').trim() || 'asset'}_selected.png`,
      comfyuiBaseUrl,
      processRes: Math.max(Number(sourceRef?.width) || 0, Number(sourceRef?.height) || 0, 1024),
      timeoutMs,
      prefix: buildStoryAssetComfyPrefix(asset, 'selected_white_bg')
    })

    const ext = String(post.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
    const target = buildStoryAssetFileTarget({
      dir,
      asset,
      prefix: 'selected_white_bg',
      ext,
      seed: sourceRef && sourceRef.seed
    })
    await mkdir(target.outDir, { recursive: true })
    await writeFile(target.absPath, post.bytes)
    const relPath = target.assetPath

    const projectAssetId = genId('asset')
    const projectAsset = {
      id: projectAssetId,
      kind: 'image',
      name: `故事资产白底 ${String(asset?.name || asset?.id || projectAssetId).trim()}`,
      uri: relPath,
      source: {
        type: 'ai',
        prompt: String(sourceRef?.prompt || '').trim() || undefined,
        negativePrompt: String(sourceRef?.negativePrompt || '').trim() || undefined,
        provider: String(post?.meta?.provider || 'comfyui'),
        remoteUrl: String(post?.meta?.url || '').trim() || undefined,
        loras: Array.isArray(sourceRef?.loras) ? sourceRef.loras : undefined,
        seed: Number.isFinite(Number(sourceRef?.seed)) ? Number(sourceRef.seed) : undefined,
        postprocess: 'rmbg_white_bg'
      }
    }

    const bundle = await readProjectBundle(id)
    const nextProject = {
      ...bundle.rawProject,
      assets: [...(Array.isArray(bundle.rawProject.assets) ? bundle.rawProject.assets : []), projectAsset],
      updatedAt: new Date().toISOString()
    }
    await writeJson(path.join(dir, 'project.json'), nextProject)

    const nextPlan = {
      ...plan,
      generatedAt: new Date().toISOString(),
      assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
        if (String(item && item.id || '').trim() !== String(asset?.id || '').trim()) return item
        const prevRefs = Array.isArray(item.generatedRefs) ? item.generatedRefs : []
        return {
          ...item,
          generatedRefs: [
            ...prevRefs,
            {
              projectAssetId,
              projectAssetUri: relPath,
              createdAt: new Date().toISOString(),
              provider: String(post?.meta?.provider || 'comfyui'),
              remoteUrl: String(post?.meta?.url || '').trim() || undefined,
              loras: Array.isArray(sourceRef?.loras) ? sourceRef.loras : undefined,
              prompt: String(sourceRef?.prompt || '').trim(),
              negativePrompt: String(sourceRef?.negativePrompt || '').trim(),
              width: Number(sourceRef?.width) || undefined,
              height: Number(sourceRef?.height) || undefined,
              seed: Number.isFinite(Number(sourceRef?.seed)) ? Number(sourceRef.seed) : undefined,
              postprocess: 'rmbg_white_bg'
            }
          ]
        }
      }) : plan.assets
    }
    nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
    await saveStoryAssetPlan(id, nextPlan)
    return { plan: nextPlan, primaryReferenceAssetId: projectAssetId, primaryReferenceAssetUri: relPath }
  } catch (_) {
    return {
      plan,
      primaryReferenceAssetId: String(sourceRef?.projectAssetId || '').trim(),
      primaryReferenceAssetUri: String(sourceRef?.projectAssetUri || '').trim()
    }
  }
}

function deriveStoryAssetReferenceStatus(item) {
  const primaryUri = String(item?.primaryReferenceAssetUri || '').trim()
  if (primaryUri) return 'ready'
  const batch = Array.isArray(item?.latestReferenceBatch) ? item.latestReferenceBatch : []
  const refs = Array.isArray(item?.generatedRefs) ? item.generatedRefs : []
  if (batch.length || refs.length) return 'candidates_ready'
  return String(item?.referenceStatus || 'missing').trim() || 'missing'
}

async function persistStoryAssetReferenceBatch({
  id,
  plan,
  assetId,
  latestReferenceBatch,
  recommendedReferenceAssetUri
}) {
  const nextPlan = {
    ...plan,
    generatedAt: new Date().toISOString(),
    assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
      if (String(item && item.id || '').trim() !== String(assetId || '').trim()) return item
      const batch = Array.isArray(latestReferenceBatch) ? latestReferenceBatch.filter((x) => x && typeof x === 'object') : []
      const refStatus = String(item?.primaryReferenceAssetUri || '').trim() ? 'ready' : (batch.length ? 'candidates_ready' : deriveStoryAssetReferenceStatus(item))
      return {
        ...item,
        referenceStatus: refStatus,
        latestReferenceBatch: batch,
        latestRecommendedReferenceAssetUri: String(recommendedReferenceAssetUri || '').trim(),
        latestReferenceReview: String(item?.primaryReferenceAssetUri || '').trim() ? item.latestReferenceReview || null : null
      }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan)
  return nextPlan
}

async function writeStoryAssetPrimaryToProject({ id, dir, asset, primaryReferenceAssetId }) {
  const bundle = await readProjectBundle(id)
  const nextProject = {
    ...bundle.rawProject,
    updatedAt: new Date().toISOString(),
    characters: Array.isArray(bundle.rawProject.characters) ? bundle.rawProject.characters.map((ch) => {
      if (String(asset?.category || '').trim() !== 'character') return ch
      if (String(ch && ch.id || '').trim() !== String(asset?.projectCharacterId || '').trim()) return ch
      return {
        ...ch,
        ai: {
          ...((ch && ch.ai && typeof ch.ai === 'object') ? ch.ai : {}),
          referenceAssetId: String(primaryReferenceAssetId || '').trim()
        }
      }
    }) : bundle.rawProject.characters
  }
  await writeJson(path.join(dir, 'project.json'), nextProject)
}

function getStoryAssetRenderSize(asset) {
  const profile = getStoryAssetRenderProfile(asset && typeof asset === 'object' ? asset : { category: asset })
  return { width: Number(profile.width || 768), height: Number(profile.height || 768) }
}

async function persistStoryAssetLineartResult({
  id,
  dir,
  plan,
  asset,
  hintBytes,
  hintExt,
  finalBytes,
  finalExt,
  meta,
  prompt,
  negativePrompt
}) {
  const hintTarget = buildStoryAssetFileTarget({
    dir,
    asset,
    prefix: 'lineart_hint',
    ext: String(hintExt || 'png'),
    seed: meta && meta.seed
  })
  const finalTarget = buildStoryAssetFileTarget({
    dir,
    asset,
    prefix: 'lineart_final',
    ext: String(finalExt || 'png'),
    seed: meta && meta.seed
  })
  await mkdir(hintTarget.outDir, { recursive: true })
  await writeFile(hintTarget.absPath, hintBytes)
  await writeFile(finalTarget.absPath, finalBytes)
  const hintPath = hintTarget.assetPath
  const finalPath = finalTarget.assetPath

  const hintAssetId = genId('asset')
  const finalAssetId = genId('asset')
  const hintProjectAsset = {
    id: hintAssetId,
    kind: 'image',
    name: `线稿提示 ${String(asset?.name || asset?.id || hintAssetId).trim()}`,
    uri: hintPath,
    source: {
      type: 'ai',
      prompt,
      provider: String(meta?.provider || 'comfyui'),
      remoteUrl: String(meta?.hintUrl || '').trim() || undefined
    }
  }
  const finalProjectAsset = {
    id: finalAssetId,
    kind: 'image',
    name: `线稿成品 ${String(asset?.name || asset?.id || finalAssetId).trim()}`,
    uri: finalPath,
    source: {
      type: 'ai',
      prompt,
      provider: String(meta?.provider || 'comfyui'),
      remoteUrl: String(meta?.finalUrl || '').trim() || undefined
    }
  }

  const bundle = await readProjectBundle(id)
  const nextProject = {
    ...bundle.rawProject,
    assets: [
      ...(Array.isArray(bundle.rawProject.assets) ? bundle.rawProject.assets : []),
      hintProjectAsset,
      finalProjectAsset
    ],
    updatedAt: new Date().toISOString()
  }
  await writeJson(path.join(dir, 'project.json'), nextProject)

  const nextPlan = {
    ...plan,
    generatedAt: new Date().toISOString(),
    assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
      if (String(item && item.id || '').trim() !== String(asset?.id || '').trim()) return item
      return {
        ...item,
        lineartHintAssetId: hintAssetId,
        lineartHintAssetUri: hintPath,
        lineartFinalAssetId: finalAssetId,
        lineartFinalAssetUri: finalPath,
        lineartStatus: 'ready',
        lineartPrompt: String(prompt || '').trim(),
        lineartNegativePrompt: String(negativePrompt || '').trim(),
        lineartMeta: meta && typeof meta === 'object' ? meta : null,
        lineartGeneratedAt: new Date().toISOString()
      }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan)
  return {
    plan: nextPlan,
    asset: (Array.isArray(nextPlan.assets) ? nextPlan.assets.find((item) => String(item && item.id || '').trim() === String(asset?.id || '').trim()) : null) || null,
    hintProjectAsset,
    finalProjectAsset,
    hintAssetPath: hintPath,
    finalAssetPath: finalPath,
    hintUrl: `/project-assets/${encodeURIComponent(String(id))}/${hintPath}`,
    finalUrl: `/project-assets/${encodeURIComponent(String(id))}/${finalPath}`
  }
}

async function reviewAndPersistStoryAssetReference({
  id,
  dir,
  studio,
  plan,
  asset,
  prompt,
  negativePrompt,
  assetPath
}) {
  const abs = path.join(dir, String(assetPath || '').replace(/^\/+/, ''))
  const buf = await readFile(abs)
  const sniff = sniffImageMetaFromBytes(buf)
  if (!sniff) {
    const e = new Error('invalid_story_asset_reference_image')
    e.status = 400
    throw e
  }
  const analysis = await reviewStoryboardLockImageWithAi({
    provider: studio.effective.prompt.provider,
    model: studio.effective.prompt.model,
    apiUrl: studio.effective.prompt.apiUrl,
    proxyUrl: studio.effective.network.proxyUrl,
    asset,
    prompt,
    negativePrompt,
    imageDataUrl: `data:${sniff.contentType};base64,${buf.toString('base64')}`,
    attempt: 1,
    maxAttempts: 1
  })

  const review = {
    reviewedAt: new Date().toISOString(),
    targetAssetUri: String(assetPath || '').trim(),
    prompt: String(prompt || '').trim(),
    negativePrompt: String(negativePrompt || '').trim(),
    passed: Boolean(analysis && analysis.passed),
    score: Number.isFinite(Number(analysis && analysis.score)) ? Math.max(0, Math.min(100, Math.round(Number(analysis.score)))) : null,
    summary: String(analysis && analysis.summary || '').trim(),
    issues: Array.isArray(analysis && analysis.issues) ? analysis.issues.map((x) => String(x || '').trim()).filter(Boolean) : [],
    revisedPrompt: String(analysis && analysis.revisedPrompt || '').trim(),
    revisedNegativePrompt: String(analysis && analysis.revisedNegativePrompt || '').trim(),
    skipped: Boolean(analysis && analysis.skipped)
  }
  const nextPlan = {
    ...plan,
    assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
      if (String(item && item.id || '').trim() !== String(asset.id || '').trim()) return item
      return { ...item, latestReferenceReview: review }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan)

  return {
    asset: (Array.isArray(nextPlan.assets) ? nextPlan.assets.find((item) => String(item && item.id || '').trim() === String(asset.id || '').trim()) : null) || null,
    analysis: review,
    plan: nextPlan
  }
}

function storyAssetReviewScore(analysis) {
  const score = Number(analysis && analysis.score)
  if (Number.isFinite(score)) return Math.max(0, Math.min(100, Math.round(score)))
  return analysis && analysis.passed ? 100 : -1
}

function shouldDiscardStoryAssetReferenceCandidate(analysis) {
  const score = storyAssetReviewScore(analysis)
  if (score >= 0 && score < 20) return true
  const summary = String(analysis && analysis.summary || '').trim()
  const issues = Array.isArray(analysis && analysis.issues) ? analysis.issues.map((x) => String(x || '').trim()).join(' | ') : ''
  const hay = `${summary} | ${issues}`.toLowerCase()
  if (!hay) return false
  if (/(主体类别错误|严重跑题|人形角色|人物而非|human|humanoid|android|cyborg|robot|person instead|body parts)/i.test(hay)) return true
  return false
}

async function setPrimaryStoryAssetReference({
  id,
  plan,
  assetId,
  primaryReferenceAssetId,
  primaryReferenceAssetUri,
  latestReferenceReview,
  latestReferenceBatch,
  selectedBatchAssetPath,
  resetLineart = true
}) {
  const selectedBatchUri = normalizeStoryAssetUri(selectedBatchAssetPath)
  const normalizedPrimaryUri = normalizeStoryAssetUri(primaryReferenceAssetUri)
  const nextPlan = {
    ...plan,
    generatedAt: new Date().toISOString(),
    assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
      if (String(item && item.id || '').trim() !== String(assetId || '').trim()) return item
      const nextBatch = Array.isArray(latestReferenceBatch)
        ? latestReferenceBatch
          .filter((x) => x && typeof x === 'object')
          .map((entry) => {
            const entryPath = normalizeStoryAssetUri(entry && entry.assetPath)
            if (!selectedBatchUri || !normalizedPrimaryUri || entryPath !== selectedBatchUri) return entry
            return {
              ...entry,
              assetPath: normalizedPrimaryUri,
              url: `/project-assets/${encodeURIComponent(String(id || ''))}/${normalizedPrimaryUri}`
            }
          })
        : (Array.isArray(item.latestReferenceBatch) ? item.latestReferenceBatch : [])
      const nextItem = {
        ...item,
        primaryReferenceAssetId: String(primaryReferenceAssetId || '').trim(),
        primaryReferenceAssetUri: String(primaryReferenceAssetUri || '').trim(),
        primaryReferenceSelectedAt: new Date().toISOString(),
        referenceStatus: String(primaryReferenceAssetUri || '').trim() ? 'ready' : deriveStoryAssetReferenceStatus(item),
        latestReferenceReview: latestReferenceReview && typeof latestReferenceReview === 'object' ? latestReferenceReview : (item.latestReferenceReview || null),
        latestReferenceBatch: nextBatch
      }
      if (!resetLineart) return nextItem
      return {
        ...nextItem,
        lineartHintAssetId: '',
        lineartHintAssetUri: '',
        lineartFinalAssetId: '',
        lineartFinalAssetUri: '',
        lineartStatus: 'missing',
        lineartPrompt: '',
        lineartNegativePrompt: '',
        lineartMeta: null,
        lineartGeneratedAt: ''
      }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan)
  return nextPlan
}

app.post('/api/projects/:id/ai/story/assets/reference', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const traceId = createTraceId()

  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const bundle = await readProjectBundle(id)
  let plan = await readStoryAssetPlanIfExists(id)
  if (!plan) {
    const storyBible = readStoryBibleFromProjectDoc(bundle.project)
    if (!storyBible || typeof storyBible !== 'object') {
      return c.json({ success: false, error: 'missing_story_bible', message: '未找到 Story Bible。请先生成 Story Bible 并创建资产计划。' }, 400)
    }
    plan = buildStoryAssetPlan({ project: bundle.project, story: bundle.story, storyBible, prevManifest: null })
  }

  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  const studio = await getEffectiveStudioConfig(ROOT)
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
  const effectiveLoras = chooseStoryboardAssetLoras({ asset, requestedLoras })
  const requestedModel = String(body?.model || draft?.model || '').trim()
  const modelResolution = await resolveStoryboardAssetModel({ studio, imgProvider, requestedModel, asset })
  const effectiveModel = String(modelResolution.model || '').trim()
  const style = normalizeStyleEnum(body?.style || draft.style || 'picture_book')
  const { width: widthDefault, height: heightDefault } = getStoryAssetRenderSize(asset)
  const width = clampInt(body?.width, 256, 2048, widthDefault)
  const height = clampInt(body?.height, 256, 2048, heightDefault)
  const batchSize = clampInt(body?.batchSize, 1, 6, 4)
  const globalPrompt = String(body?.globalPrompt || '').trim()
  const globalNegativePrompt = String(body?.globalNegativePrompt || '').trim()
  const sanitizedDraft = sanitizeProtectedAssetPrompt({
    asset,
    promptEn: String(body?.assetPrompt || body?.promptEn || '').trim(),
    negativePrompt: String(body?.assetNegativePrompt || '').trim()
  })
  const assetPrompt = pickEnglishPrompt(
    sanitizedDraft.promptEn,
    storyAssetStr(asset && asset.referencePromptEn).trim(),
    storyAssetStr(asset && asset.referencePromptHint).trim()
  )
  const assetNegativePrompt = sanitizedDraft.negativePrompt
  const prompt = String(body?.prompt || '').trim() || buildStoryAssetReferencePrompt({ plan, asset, style, globalPrompt, assetPrompt })
  const negativePrompt = String(body?.negativePrompt || '').trim() || buildStoryAssetReferenceNegativePrompt({ plan, asset, globalNegativePrompt, assetNegativePrompt })

  try {
    logStage({ stage: 'asset.reference.batch', event: 'start', traceId, project: id, item: assetId, ok: true, detail: 'generate_candidates_only' })
    let currentPlan = await persistStoryAssetReferenceBatch({
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
      const result = await generateAndPersistStoryAssetReference({
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
      currentBundle = await readProjectBundle(id)
      const reviewed = await reviewAndPersistStoryAssetReference({
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
      const revisedPrompt = pickEnglishPrompt(String(reviewed.analysis?.revisedPrompt || '').trim(), attemptPrompt)
      const revisedNegativePrompt = String(reviewed.analysis?.revisedNegativePrompt || '').trim() || attemptNegativePrompt
      if (!Boolean(reviewed.analysis?.passed) && (revisedPrompt !== attemptPrompt || revisedNegativePrompt !== attemptNegativePrompt)) {
        attemptPrompt = revisedPrompt
        attemptNegativePrompt = revisedNegativePrompt
      }
      if (!shouldDiscardStoryAssetReferenceCandidate(reviewed.analysis)) {
        rawCandidates.push({
          attempt: i + 1,
          seed,
          assetPath: result.assetPath,
          url: result.url,
          analysis: reviewed.analysis
        })
      }
      if (!bestResult || storyAssetReviewScore(reviewed.analysis) > storyAssetReviewScore(bestReview)) {
        bestResult = result
        bestReview = reviewed.analysis
      }
      const partialRecommendedAssetPath = bestResult ? String(bestResult.assetPath || '').trim() : ''
      const partialCandidates = rawCandidates.map((item) => ({
        ...item,
        recommended: Boolean(partialRecommendedAssetPath && String(item.assetPath || '').trim() === partialRecommendedAssetPath)
      }))
      currentPlan = await persistStoryAssetReferenceBatch({
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
    currentPlan = await persistStoryAssetReferenceBatch({
      id,
      plan: currentPlan,
      assetId,
      latestReferenceBatch: candidates,
      recommendedReferenceAssetUri: recommendedAssetPath
    })
    const currentAsset = (Array.isArray(currentPlan.assets) ? currentPlan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null) || null
    logStage({ stage: 'asset.reference.batch', event: 'ok', traceId, project: id, item: assetId, ok: true, detail: 'generate_candidates_only', count: candidates.length })
    return c.json({ success: true, asset: currentAsset, analysis: bestReview, recommendedAssetPath, candidates, model: effectiveModel || undefined, modelSource: modelResolution.source, ...(bestResult || {}), plan: currentPlan })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    logStage({ stage: 'asset.reference.batch', event: 'fail', traceId, project: id, item: assetId, status: mapped.httpStatus, ok: false, err: msg })
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

app.post('/api/projects/:id/ai/story/assets/reference/review', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  const assetPath = String(asset.primaryReferenceAssetUri || '').trim()
  if (!assetPath) return c.json({ success: false, error: 'missing_reference_image', message: '请先从 4 张候选图中手动选择主参考，再执行分析。' }, 400)
  const latestRef = Array.isArray(asset.generatedRefs) ? asset.generatedRefs.find((x) => String(x?.projectAssetUri || '').trim() === assetPath) : null
  const prompt = String(latestRef?.prompt || buildStoryAssetReferencePrompt({ plan, asset, style: 'picture_book' })).trim()
  const negativePrompt = String(latestRef?.negativePrompt || buildStoryAssetReferenceNegativePrompt({ plan, asset })).trim()

  try {
    const studio = await getEffectiveStudioConfig(ROOT)
    const result = await reviewAndPersistStoryAssetReference({
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
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const bundle = await readProjectBundle(id)
  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  const currentAssetPath = String(asset.primaryReferenceAssetUri || '').trim()
  if (!currentAssetPath) return c.json({ success: false, error: 'missing_reference_image', message: '请先从 4 张候选图中手动选择主参考，再执行增强。' }, 400)

  try {
    const studio = await getEffectiveStudioConfig(ROOT)
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
    const sanitizedDraft = sanitizeProtectedAssetPrompt({
      asset,
      promptEn: String(body?.assetPrompt || body?.promptEn || '').trim(),
      negativePrompt: String(body?.assetNegativePrompt || '').trim()
    })
    const assetPrompt = pickEnglishPrompt(
      sanitizedDraft.promptEn,
      storyAssetStr(asset && asset.referencePromptEn).trim(),
      storyAssetStr(asset && asset.referencePromptHint).trim()
    )
    const assetNegativePrompt = sanitizedDraft.negativePrompt
    const prompt = String(latestRef?.prompt || buildStoryAssetReferencePrompt({ plan, asset, style: String(body?.style || 'picture_book'), globalPrompt, assetPrompt })).trim()
    const negativePrompt = String(latestRef?.negativePrompt || buildStoryAssetReferenceNegativePrompt({ plan, asset, globalNegativePrompt, assetNegativePrompt })).trim()
    const reviewed = await reviewAndPersistStoryAssetReference({
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
    const style = normalizeStyleEnum(body?.style || 'picture_book')
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
    const effectiveLoras = chooseStoryboardAssetLoras({ asset, requestedLoras })
    const requestedModel = String(body?.model || draft?.model || '').trim()
    const modelResolution = await resolveStoryboardAssetModel({ studio, imgProvider, requestedModel, asset })
    const effectiveModel = String(modelResolution.model || '').trim()
    const { width: widthDefault, height: heightDefault } = getStoryAssetRenderSize(asset)
    const width = clampInt(body?.width, 256, 2048, widthDefault)
    const height = clampInt(body?.height, 256, 2048, heightDefault)
    const batchSize = clampInt(body?.batchSize, 1, 6, 4)
    let currentPlan = await persistStoryAssetReferenceBatch({
      id,
      plan: reviewed.plan,
      assetId,
      latestReferenceBatch: [],
      recommendedReferenceAssetUri: ''
    })
    let currentBundle = bundle
    let bestResult = null
    let bestReview = effectiveAnalysis
    let attemptPrompt = pickEnglishPrompt(String(effectiveAnalysis.revisedPrompt || '').trim(), prompt)
    let attemptNegativePrompt = String(effectiveAnalysis.revisedNegativePrompt || negativePrompt).trim() || negativePrompt
    const baseSeed = Math.floor(Math.random() * 4_294_900_000)
    const rawCandidates = []
    const maxAttempts = Math.max(batchSize, Math.min(12, batchSize + 4))
    for (let i = 0; i < maxAttempts && rawCandidates.length < batchSize; i += 1) {
      const seed = (baseSeed + i * 9973) % 4_294_967_295
      const result = await generateAndPersistStoryAssetReference({
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
      currentBundle = await readProjectBundle(id)
      const rerReviewed = await reviewAndPersistStoryAssetReference({
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
      const revisedPrompt = pickEnglishPrompt(String(rerReviewed.analysis?.revisedPrompt || '').trim(), attemptPrompt)
      const revisedNegativePrompt = String(rerReviewed.analysis?.revisedNegativePrompt || '').trim() || attemptNegativePrompt
      if (!Boolean(rerReviewed.analysis?.passed) && (revisedPrompt !== attemptPrompt || revisedNegativePrompt !== attemptNegativePrompt)) {
        attemptPrompt = revisedPrompt
        attemptNegativePrompt = revisedNegativePrompt
      }
      if (!shouldDiscardStoryAssetReferenceCandidate(rerReviewed.analysis)) {
        rawCandidates.push({
          attempt: i + 1,
          seed,
          assetPath: result.assetPath,
          url: result.url,
          analysis: rerReviewed.analysis
        })
      }
      if (!bestResult || storyAssetReviewScore(rerReviewed.analysis) > storyAssetReviewScore(bestReview)) {
        bestResult = result
        bestReview = rerReviewed.analysis
      }
      const partialRecommendedAssetPath = bestResult ? String(bestResult.assetPath || '').trim() : ''
      const partialCandidates = rawCandidates.map((item) => ({
        ...item,
        recommended: Boolean(partialRecommendedAssetPath && String(item.assetPath || '').trim() === partialRecommendedAssetPath)
      }))
      currentPlan = await persistStoryAssetReferenceBatch({
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
    currentPlan = await persistStoryAssetReferenceBatch({
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
  await ensureDirs()
  const id = c.req.param('id')
  const assetId = storyAssetStr(c.req.param('assetId')).trim()
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => storyAssetStr(item && item.id).trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)
  const cleaned = await pruneMissingStoryAssetGalleryEntries({ id, dir, plan, asset })
  return c.json({ success: true, asset: cleaned.asset, items: cleaned.items, plan: cleaned.plan })
})

app.post('/api/projects/:id/ai/story/assets/:assetId/prompt-enhance', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const assetId = storyAssetStr(c.req.param('assetId')).trim()
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const body = await c.req.json().catch(() => ({}))
  const rewriteFromScratch = true
  const forceRegenerate = Boolean(body?.forceRegenerate)
  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => storyAssetStr(item && item.id).trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  const bundle = await readProjectBundle(id)
  const fallback = buildStoryAssetPromptEnhancement({
    asset,
    plan,
    globalPromptZh: body?.globalPromptZh,
    globalNegativePromptZh: body?.globalNegativePromptZh,
    currentPromptZh: rewriteFromScratch ? '' : body?.promptZh,
    currentPromptEn: rewriteFromScratch ? '' : body?.promptEn,
    currentNegativePromptZh: rewriteFromScratch ? '' : body?.negativePromptZh,
    currentNegativePrompt: rewriteFromScratch ? '' : body?.negativePrompt
  })
  const fallbackSanitized = sanitizeProtectedAssetPrompt({
    asset,
    promptEn: fallback.promptEn,
    negativePrompt: fallback.negativePrompt
  })
  const studio = await getEffectiveStudioConfig(ROOT).catch(() => null)
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
      const risks = Array.isArray(review.risks) ? review.risks.map((x) => storyAssetStr(x).trim()).filter(Boolean) : []
      const suggestions = Array.isArray(review.suggestions) ? review.suggestions.map((x) => storyAssetStr(x).trim()).filter(Boolean) : []
      const score = Number(review.score)
      const parts = []
      if (Number.isFinite(score)) parts.push(`上一轮提示词评分 ${Math.round(score)}/100`)
      if (risks.length) parts.push(`主要问题：${risks.slice(0, 4).join('；')}`)
      if (suggestions.length) parts.push(`必须修正：${suggestions.slice(0, 4).join('；')}`)
      return parts.join('。')
    }
    const scoreCandidate = (candidate, source, attempt) => {
      const review = scoreStoryAssetPromptCandidate({
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
      let bestCandidate = { ...result }
      let bestReview = fallbackReview
      const priorReviewScore = Number(body?.promptReview?.score)
      for (let attempt = 1; attempt <= maxRegenerateAttempts; attempt += 1) {
        const aiInput = {
          projectTitle: String(bundle?.project?.title || '').trim(),
          storyBibleJson: JSON.stringify(readStoryBibleFromProjectDoc(bundle.project) || {}, null, 2),
          asset,
          plan,
          assetUsageContext: usageContext,
          promptReviewFeedbackZh: feedbackZh,
          globalPromptZh: body?.globalPromptZh,
          globalNegativePromptZh: body?.globalNegativePromptZh,
          currentPromptZh: rewriteFromScratch ? '' : sanitizeStoryAssetPromptZh({ asset, promptZh: body?.promptZh }),
          currentPromptEn: rewriteFromScratch ? '' : body?.promptEn,
          currentNegativePromptZh: rewriteFromScratch ? '' : body?.negativePromptZh,
          currentNegativePrompt: rewriteFromScratch ? '' : body?.negativePrompt
        }
        const enhanced = await Promise.race([
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
          }, 15_000))
        ])
        if (!enhanced || !enhanced.result) continue
        const nextPromptZh = sanitizeStoryAssetPromptZh({ asset, promptZh: enhanced.result.promptZh }) || fallback.promptZh
        const nextNegativePromptZh = storyAssetStr(enhanced.result.negativePromptZh).trim() || fallback.negativePromptZh
        const translated = await translateStoryAssetPromptPair({
          studio,
          promptZh: nextPromptZh,
          negativePromptZh: nextNegativePromptZh,
          fallbackPromptEn: fallback.promptEn,
          fallbackNegativePrompt: fallback.negativePrompt,
          timeoutMs: 60_000
        }).catch(() => ({
          promptEn: fallback.promptEn,
          negativePrompt: fallback.negativePrompt,
          meta: { provider: 'fallback', model: null, api: null, note: 'translation_fallback' }
        }))
        const sanitizedTranslated = sanitizeProtectedAssetPrompt({
          asset,
          promptEn: translated.promptEn,
          negativePrompt: translated.negativePrompt
        })
        const candidate = {
          promptZh: nextPromptZh,
          promptEn: sanitizedTranslated.promptEn || fallback.promptEn,
          negativePromptZh: nextNegativePromptZh,
          negativePrompt: sanitizedTranslated.negativePrompt || fallback.negativePrompt,
          summary: storyAssetStr(enhanced.result.summary).trim() || fallback.summary,
          context: {
            ...(fallback.context || {}),
            aiGenerated: true,
            translatedBy: translated.meta || null
          }
        }
        const review = scoreCandidate(candidate, 'ai', attempt)
        const shouldPreferCandidate = !bestReview ||
          review.score > bestReview.score ||
          (
            forceRegenerate &&
            Number.isFinite(priorReviewScore) &&
            review.score >= priorReviewScore &&
            review.score >= bestReview.score
          )
        if (shouldPreferCandidate) {
          bestCandidate = candidate
          bestReview = review
        }
        meta = {
          ...(enhanced.meta || {}),
          provider: enhanced.meta?.provider || provider,
          model: enhanced.meta?.model || model || null,
          api: enhanced.meta?.api || apiUrl || null,
          durationMs: Math.max(0, Date.now() - startedAt)
        }
        if (!forceRegenerate && (review.passed || review.score >= minAcceptScore)) {
          result = candidate
          break
        }
        feedbackZh = `${buildPromptReviewFeedbackZh(review)}。请根据这些问题完全重写，不要保留泛化模板。`
        result = bestCandidate
      }
      if (!result || !storyAssetStr(result.promptZh).trim()) result = bestCandidate
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
  const finalReview = scoreStoryAssetPromptCandidate({
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
  return c.json({ success: true, asset, result, meta, aiError, traceId, promptReview: finalReview, promptReviewAttempts: promptReviews, promptReviewThreshold: minAcceptScore })
})

app.post('/api/projects/:id/ai/story/assets/:assetId/gallery/delete', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const routeAssetId = storyAssetStr(c.req.param('assetId')).trim()
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const assetId = storyAssetStr(body && body.assetId).trim() || routeAssetId
  const assetPath = normalizeStoryAssetUri(body && body.assetPath)
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)
  if (!assetPath) return c.json({ success: false, error: 'missing_asset_path', message: 'assetPath 不能为空' }, 400)

  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => storyAssetStr(item && item.id).trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  try {
    const result = await deleteStoryAssetManagedFile({ id, dir, plan, asset, targetAssetPath: assetPath })
    const cleaned = await pruneMissingStoryAssetGalleryEntries({
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

app.post('/api/projects/:id/ai/story/assets/reference/select', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const traceId = createTraceId()

  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  const targetAssetPath = String(body?.assetPath || body?.primaryReferenceAssetUri || '').trim().replace(/^\/+/, '')
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)
  if (!targetAssetPath) return c.json({ success: false, error: 'missing_asset_path', message: '请选择一个候选图作为主参考。' }, 400)

  let plan = await readStoryAssetPlanIfExists(id)
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

  try {
    logStage({ stage: 'asset.reference.select', event: 'start', traceId, project: id, item: assetId, ok: true, detail: 'white_background_only' })
    const studio = await getEffectiveStudioConfig(ROOT)
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
    const processed = await applyWhiteBackgroundToStoryAssetReference({
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
    plan = await setPrimaryStoryAssetReference({
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
    await writeStoryAssetPrimaryToProject({ id, dir, asset: nextAsset, primaryReferenceAssetId })
    logStage({ stage: 'asset.reference.select', event: 'ok', traceId, project: id, item: assetId, ok: true, detail: 'white_background_only' })
    return c.json({ success: true, asset: nextAsset, plan })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    logStage({ stage: 'asset.reference.select', event: 'fail', traceId, project: id, item: assetId, status: mapped.httpStatus, ok: false, err: msg })
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

app.post('/api/projects/:id/ai/story/assets/lineart', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const traceId = createTraceId()

  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  const primaryReferenceAssetUri = String(asset.primaryReferenceAssetUri || '').trim()
  if (!primaryReferenceAssetUri) {
    return c.json({ success: false, error: 'missing_reference_image', message: '请先从 4 张候选图中手动选择主参考，再生成线稿。' }, 400)
  }

  const studio = await getEffectiveStudioConfig(ROOT)
  const comfyuiBaseUrl = String(studio.effective.image.comfyuiBaseUrl || process.env.COMFYUI_BASE_URL || '').trim()
  if (!comfyuiBaseUrl) {
    return c.json({ success: false, error: 'missing_comfyui_base_url', message: '未配置 ComfyUI 地址，无法生成线稿。' }, 400)
  }

  try {
    logStage({ stage: 'asset.lineart', event: 'start', traceId, project: id, item: assetId, ok: true, detail: 'controlnet_lineart_only' })
    const abs = path.join(dir, primaryReferenceAssetUri.replace(/^\/+/, ''))
    const refBytes = await readFile(abs)
    const { width: widthDefault, height: heightDefault } = getStoryAssetRenderSize(asset)
    const lineartPrompt = String(body?.prompt || '').trim() || (
      String(asset.category || '').trim() === 'character'
        ? `redraw the uploaded ${String(asset.name || asset.id || 'character').trim()} reference as clean black ink lineart, preserve exact species, face shape, fur markings, outfit silhouette, body proportions and pose, full body, one subject only, white background, monochrome, no color fill, no shading, no gray wash, no painterly rendering`
        : `redraw the uploaded ${String(asset.name || asset.id || 'prop').trim()} reference as clean black ink object lineart, preserve exact silhouette, handle, rim, strap, edge shape and proportions, single object only, centered, white background, monochrome, no color fill, no shading, no extra objects, no person`
    )
    const lineartNegative = String(body?.negativePrompt || '').trim() || 'color, watercolor, gouache, shading, shadow, grayscale wash, background scene, extra character, extra limbs, multiple views, text, logo, realistic photo'
    const result = await generateComfyuiLineartFromReference({
      referenceBytes: refBytes,
      referenceFilename: `${String(asset.id || 'asset').trim() || 'asset'}.png`,
      comfyuiBaseUrl,
      model: String(body?.model || studio.effective.image.model || '').trim(),
      controlnetModel: String(body?.controlnetModel || '').trim() || 'SDXL/controlnet-union-sdxl-1.0/diffusion_pytorch_model_promax.safetensors',
      width: clampInt(body?.width, 256, 2048, widthDefault),
      height: clampInt(body?.height, 256, 2048, heightDefault),
      preprocessor: String(asset.category || '').trim() === 'character' ? 'anime' : 'lineart',
      unionType: 'canny/lineart/anime_lineart/mlsd',
      prompt: lineartPrompt,
      negativePrompt: lineartNegative,
      steps: body?.steps,
      cfgScale: body?.cfgScale,
      denoise: body?.denoise,
      seed: body?.seed,
      timeoutMs: body?.timeoutMs,
      hintPrefix: buildStoryAssetComfyPrefix(asset, 'lineart_hint'),
      finalPrefix: buildStoryAssetComfyPrefix(asset, 'lineart_final')
    })
    const persisted = await persistStoryAssetLineartResult({
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
    return c.json({ success: true, asset: persisted.asset, plan: persisted.plan, hintAssetPath: persisted.hintAssetPath, finalAssetPath: persisted.finalAssetPath, hintUrl: persisted.hintUrl, finalUrl: persisted.finalUrl, meta: result.meta, prompt: lineartPrompt, negativePrompt: lineartNegative })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    logStage({ stage: 'asset.lineart', event: 'fail', traceId, project: id, item: assetId, status: mapped.httpStatus, ok: false, err: msg })
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

app.post('/api/projects/:id/ai/story/lock/test', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const bundle = await readProjectBundle(id)
  let plan = await readStoryAssetPlanIfExists(id)
  if (!plan) {
    const storyBible = readStoryBibleFromProjectDoc(bundle.project)
    if (!storyBible || typeof storyBible !== 'object') {
      return c.json({ success: false, error: 'missing_story_bible', message: '未找到 Story Bible。请先生成 Story Bible 并创建资产计划。' }, 400)
    }
    plan = buildStoryAssetPlan({ project: bundle.project, story: bundle.story, storyBible, prevManifest: null })
    await saveStoryAssetPlan(id, plan)
  }

  const testTarget = pickStoryboardLockTestAsset(plan)
  if (!testTarget) {
    return c.json({ success: false, error: 'missing_test_target', message: '资产计划为空，无法执行锁定测试。' }, 400)
  }

  const studio = await getEffectiveStudioConfig(ROOT)
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

  const style = normalizeStyleEnum(body?.style || 'picture_book')
  const width = clampInt(body?.width, 256, 2048, 512)
  const height = clampInt(body?.height, 256, 2048, 512)
  const steps = clampInt(body?.steps, 5, 80, 20)
  const cfgScale = Number.isFinite(Number(body?.cfgScale)) ? Number(body.cfgScale) : 7
  const samplerInput = body?.sampler || 'DPM++ 2M'
  const schedulerInput = body?.scheduler || 'Automatic'
  const sampler = mapComfySampler(samplerInput)
  const scheduler = mapComfyScheduler(schedulerInput, samplerInput)
  const timeoutMs = parseComfyTimeoutMs(body?.timeoutMs)
  const maxAttempts = clampInt(body?.maxAttempts, 1, 4, 3)
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

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
        seed: Math.floor(Math.random() * 9_999_999_999),
        filenamePrefix: buildStoryAssetComfyPrefix(testTarget, 'lock_test')
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
      const assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
      const dataUrl = `data:${sniff?.contentType || (ext === 'jpg' ? 'image/jpeg' : 'image/png')};base64,${buf.toString('base64')}`

      const analysis = await reviewStoryboardLockImageWithAi({
        provider: studio.effective.prompt.provider,
        model: studio.effective.prompt.model,
        apiUrl: studio.effective.prompt.apiUrl,
        proxyUrl: studio.effective.network.proxyUrl,
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
        remoteUrl: String(finalGen?.meta?.url || '').trim() || undefined,
        analysis
      })

      if (analysis && analysis.passed) {
        passed = true
        finalSummary = String(analysis.summary || '锁定测试已通过').trim() || '锁定测试已通过'
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

    return c.json({
      success: true,
      passed,
      summary: finalSummary,
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
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

app.post('/api/projects/:id/ai/story/scenes/:sceneId/render', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const sceneId = c.req.param('sceneId')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const bundle = await readProjectBundle(id)
  let plan = await readStoryAssetPlanIfExists(id)
  if (!plan) {
    const storyBible = readStoryBibleFromProjectDoc(bundle.project)
    if (!storyBible || typeof storyBible !== 'object') {
      return c.json({ success: false, error: 'missing_story_bible', message: '未找到 Story Bible。请先生成 Story Bible 并创建资产计划。' }, 400)
    }
    plan = buildStoryAssetPlan({ project: bundle.project, story: bundle.story, storyBible, prevManifest: null })
    await saveStoryAssetPlan(id, plan)
  }

  const renderSpec = buildStorySceneRenderSpec({ plan, sceneId })
  if (!renderSpec) return c.json({ success: false, error: 'scene_not_found', message: `未找到场景：${sceneId}` }, 404)

  const studio = await getEffectiveStudioConfig(ROOT)
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
  const style = normalizeStyleEnum(body?.style || draft.style || 'picture_book')
  const width = clampInt(body?.width, 256, 2048, clampInt(draft.width, 256, 2048, 768))
  const height = clampInt(body?.height, 256, 2048, clampInt(draft.height, 256, 2048, 1024))
  const requestedModel = String(body?.model || '').trim()
  const requestedLoras = Array.isArray(body?.loras) ? body.loras.map((x) => String(x || '').trim()).filter(Boolean) : []

  const referenceImages = []
  for (const ref of Array.isArray(renderSpec.referenceAssets) ? renderSpec.referenceAssets : []) {
    const assetAbs = resolveAssetPathFromUri(id, ref.assetUri || '')
    if (!assetAbs || !(await existsFile(assetAbs))) continue
    try {
      const bytes = await readFile(assetAbs)
      referenceImages.push({
        role: String(ref.category || 'asset').trim() || 'asset',
        assetId: String(ref.assetId || ref.id || '').trim() || undefined,
        assetName: String(ref.name || ref.id || 'reference').trim(),
        filename: path.basename(assetAbs),
        bytes,
        weight: Number.isFinite(Number(ref.weight)) ? Number(ref.weight) : undefined
      })
    } catch (_) {}
  }

  const bodyPrompt = String(body?.scenePrompt || body?.prompt || '').trim()
  const prompt = [
    String(plan.worldAnchor || '').trim(),
    ...((Array.isArray(renderSpec.promptLocks) ? renderSpec.promptLocks : []).slice(0, 20)),
    bodyPrompt || String(renderSpec.summary || '').trim()
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

  try {
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
    const assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')

    const projectAssetId = genId('asset')
    const projectAsset = {
      id: projectAssetId,
      kind: 'image',
      name: `故事场景 ${String(renderSpec.sceneName || renderSpec.sceneId || projectAssetId).trim()}`,
      uri: assetPath,
      source: {
        type: 'ai',
        prompt,
        provider: String(finalGen?.meta?.provider || imgProvider || ''),
        remoteUrl: String(finalGen?.meta?.url || '').trim() || undefined
      }
    }

    const nextStory = {
      ...bundle.story,
      nodes: Array.isArray(bundle.story.nodes) ? bundle.story.nodes.map((node) => {
        if (String(node && node.id || '').trim() !== String(renderSpec.sceneId || '').trim()) return node
        const visuals = node && node.visuals && typeof node.visuals === 'object' ? node.visuals : {}
        return {
          ...node,
          visuals: {
            ...visuals,
            backgroundAssetId: projectAssetId
          }
        }
      }) : bundle.story.nodes
    }
    const nextProject = {
      ...bundle.rawProject,
      assets: [...(Array.isArray(bundle.rawProject.assets) ? bundle.rawProject.assets : []), projectAsset],
      updatedAt: new Date().toISOString()
    }
    await writeJson(path.join(dir, 'project.json'), nextProject)
    await writeJson(path.join(dir, 'story.json'), nextStory)

    return c.json({
      success: true,
      projectAsset,
      renderSpec,
      assetPath,
      url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`,
      provider: String(finalGen?.meta?.provider || imgProvider || ''),
      remoteUrl: String(finalGen?.meta?.url || '').trim() || undefined,
      prompt,
      negativePrompt
    })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

function normalizeStyleEnum(v) {
  const s = String(v || '').trim()
  return s === 'picture_book' || s === 'cartoon' || s === 'national_style' || s === 'watercolor' ? s : 'picture_book'
}

function styleNameZh(style) {
  const s = normalizeStyleEnum(style)
  if (s === 'picture_book') return '绘本插画'
  if (s === 'cartoon') return '卡通'
  if (s === 'national_style') return '国风'
  if (s === 'watercolor') return '水彩'
  return '插画'
}

// AI：提取角色外观指纹（全局锁定）
app.post('/api/projects/:id/ai/character/fingerprint', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const characterName = String(body?.characterName || '').trim()
  if (!characterName) return c.json({ success: false, error: 'missing_characterName', message: 'characterName 不能为空' }, 400)
  const storyTitle = String(body?.storyTitle || '').trim()
  const contextText = String(body?.contextText || '').trim()
  const globalPrompt = String(body?.globalPrompt || '').trim()
  const style = normalizeStyleEnum(body?.style)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.prompt) {
    return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)
  }

  const startedAt = Date.now()
  try {
    console.log(
      `[gamestudio] ch.fp:start project=${id} provider=${studio.effective.prompt.provider || 'localoxml'} model=${studio.effective.prompt.model || '-'} name=${characterName} storyChars=${storyTitle.length} ctxChars=${contextText.length} globalChars=${globalPrompt.length} style=${style}`
    )
  } catch (_) {}

  try {
    const { result, meta } = await generateCharacterFingerprint({
      storyTitle,
      characterName,
      contextText,
      globalPrompt,
      style,
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model,
      apiUrl: studio.effective.prompt.apiUrl,
      proxyUrl: studio.effective.network.proxyUrl
    })

    try {
      console.log(`[gamestudio] ch.fp:ok project=${id} ms=${Math.max(0, Date.now() - startedAt)} provider=${meta?.provider || '-'} model=${meta?.model || '-'}`)
    } catch (_) {}
    return c.json({ success: true, result, meta })
  } catch (e) {
    try {
      console.log(`[gamestudio] ch.fp:fail project=${id} ms=${Math.max(0, Date.now() - startedAt)} err=${e && e.message ? String(e.message) : String(e)}`)
    } catch (_) {}
    return c.json({ success: false, error: 'ai_failed', message: e && e.message ? String(e.message) : String(e) }, 502)
  }
})

// AI：生成角色绿幕图（前端自动抠图得到透明 PNG）
app.post('/api/projects/:id/ai/character/sprite', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const fingerprintPrompt = String(body?.fingerprintPrompt || '').trim()
  const posePrompt = String(body?.posePrompt || body?.prompt || '').trim()
  const globalPrompt = String(body?.globalPrompt || '').trim()
  const negativePromptIn = String(body?.negativePrompt || '').trim()
  const style = normalizeStyleEnum(body?.style)

  const width = Number(body?.width || 720)
  const height = Number(body?.height || 1280)
  if (!fingerprintPrompt && !posePrompt) return c.json({ success: false, error: 'missing_prompt', message: 'fingerprintPrompt/posePrompt 至少填写一个' }, 400)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
  const imgProvider = String(studio.effective.image.provider || process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()

  // Enforce chroma background for later client-side matting.
  const chromaHint =
    `纯色背景（RGB 0,255,0 纯绿，背景必须纯绿单色，无渐变无纹理），` +
    `无场景无环境元素无地面，无遮挡，主体居中，单个角色/单个动物，清晰边缘`

  const prompt = [
    globalPrompt,
    `风格：${styleNameZh(style)}（${style}）`,
    fingerprintPrompt,
    posePrompt,
    chromaHint
  ]
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('，')

  const negBase = [
    '无文字',
    '无水印',
    '非真人',
    '低质量',
    '模糊',
    '变形',
    '禁止复杂背景',
    '禁止风景',
    '禁止室内',
    '禁止多人',
    '禁止多只动物',
    '禁止绿色衣物',
    '禁止绿色帽子',
    '禁止绿色配饰',
    '避免阴影',
    '避免地面'
  ].join(', ')

  const negativePrompt = [negativePromptIn, negBase]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(', ')

  const startedAt = Date.now()
  try {
    console.log(
      `[gamestudio] ch.sprite:start project=${id} provider=${imgProvider} model=${studio.effective.image.model || '-'} w=${Math.floor(width || 0)} h=${Math.floor(height || 0)} style=${style} promptChars=${prompt.length} negChars=${negativePrompt.length}`
    )
  } catch (_) {}

  try {
    const gen = await generateBackgroundImage({
      prompt,
      negativePrompt,
      width,
      height,
      steps: body?.steps,
      cfgScale: body?.cfgScale,
      guidanceScale: body?.guidanceScale,
      sequentialImageGeneration: body?.sequentialImageGeneration,
      provider: imgProvider,
      sdwebuiBaseUrl: studio.effective.image.sdwebuiBaseUrl,
      comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
      apiUrl: studio.effective.image.apiUrl,
      model: studio.effective.image.model,
      loras: studio.effective.image.loras,
      proxyUrl: studio.effective.network.proxyUrl
    })

    const buf = gen.bytes
    const ext0 = String(gen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
    const sniff = sniffImageMetaFromBytes(buf)
    const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'

    const relDir = path.join('assets', 'ai', 'characters')
    const outDir = path.join(dir, relDir)
    await mkdir(outDir, { recursive: true })
    const fname = `ch_${Date.now()}.${ext}`
    const abs = path.join(outDir, fname)
    await writeFile(abs, buf)

    const assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
    const provider = (gen && gen.meta && gen.meta.provider) ? String(gen.meta.provider) : imgProvider
    const remoteUrl = (gen && gen.meta && typeof gen.meta.url === 'string' && gen.meta.url.trim()) ? String(gen.meta.url).trim() : ''
    try {
      console.log(`[gamestudio] ch.sprite:ok project=${id} provider=${provider} bytes=${buf.length} ext=${ext} ms=${Math.max(0, Date.now() - startedAt)}`)
    } catch (_) {}
    return c.json({ success: true, provider, assetPath, url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`, remoteUrl, prompt, negativePrompt })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const status = e && typeof e.status === 'number' ? e.status : null
    try {
      console.log(`[gamestudio] ch.sprite:fail project=${id} provider=${imgProvider} status=${status == null ? '-' : status} ms=${Math.max(0, Date.now() - startedAt)} err=${msg}`)
    } catch (_) {}
    if (status === 501) return c.json({ success: false, error: 'provider_not_configured', message: msg }, 501)
    return c.json({ success: false, error: 'ai_failed', message: msg }, 502)
  }
})

// AI：生成角色参考图（用于 IP-Adapter 锁定角色一致性；不做绿幕/抠图）
app.post('/api/projects/:id/ai/character/reference', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const characterName = String(body?.characterName || '').trim()
  if (!characterName) return c.json({ success: false, error: 'missing_characterName', message: 'characterName 不能为空' }, 400)
  const globalPrompt = String(body?.globalPrompt || '').trim()
  const fingerprintPrompt = String(body?.fingerprintPrompt || '').trim()
  const negativePromptIn = String(body?.negativePrompt || '').trim()
  const style = normalizeStyleEnum(body?.style)
  const width = clampInt(body?.width, 256, 1536, 768)
  const height = clampInt(body?.height, 256, 1536, 768)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
  const imgProvider = String(studio.effective.image.provider || process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()

  const refHint =
    `Reference portrait for a single character,` +
    ` clean simple background (light neutral),` +
    ` chest-up or half-body,` +
    ` looking at camera,` +
    ` consistent outfit and face,` +
    ` no extra characters, no props unless described,` +
    ` no scene environment`

  const prompt = [
    globalPrompt,
    `风格：${styleNameZh(style)}（${style}）`,
    `角色名：${characterName}`,
    fingerprintPrompt,
    refHint
  ]
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('，')

  const negBase = [
    'text',
    'watermark',
    'logo',
    'qr code',
    'low quality',
    'blurry',
    'deformed',
    'photorealistic',
    'realistic skin texture',
    'multiple characters',
    'crowd',
    'complex background',
    'busy environment'
  ].join(', ')

  const negativePrompt = [negativePromptIn, negBase].map((s) => String(s || '').trim()).filter(Boolean).join(', ')

  const startedAt = Date.now()
  try {
    console.log(
      `[gamestudio] ch.ref:start project=${id} provider=${imgProvider} model=${studio.effective.image.model || '-'} name=${characterName} w=${width} h=${height} style=${style} promptChars=${prompt.length}`
    )
  } catch (_) {}

  try {
    const gen = await generateBackgroundImage({
      prompt,
      negativePrompt,
      width,
      height,
      steps: body?.steps,
      cfgScale: body?.cfgScale,
      guidanceScale: body?.guidanceScale,
      sequentialImageGeneration: body?.sequentialImageGeneration,
      provider: imgProvider,
      sdwebuiBaseUrl: studio.effective.image.sdwebuiBaseUrl,
      comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
      apiUrl: studio.effective.image.apiUrl,
      model: studio.effective.image.model,
      loras: studio.effective.image.loras,
      proxyUrl: studio.effective.network.proxyUrl
    })

    const buf = gen.bytes
    const ext0 = String(gen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
    const sniff = sniffImageMetaFromBytes(buf)
    const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'

    const relDir = path.join('assets', 'ai', 'character_refs')
    const outDir = path.join(dir, relDir)
    await mkdir(outDir, { recursive: true })
    const safe = String(characterName || 'character').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]+/g, '_').slice(0, 24) || 'character'
    const fname = `ref_${safe}_${Date.now()}.${ext}`
    const abs = path.join(outDir, fname)
    await writeFile(abs, buf)

    const assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
    const provider = (gen && gen.meta && gen.meta.provider) ? String(gen.meta.provider) : imgProvider
    const remoteUrl = (gen && gen.meta && typeof gen.meta.url === 'string' && gen.meta.url.trim()) ? String(gen.meta.url).trim() : ''
    try {
      console.log(`[gamestudio] ch.ref:ok project=${id} provider=${provider} bytes=${buf.length} ext=${ext} ms=${Math.max(0, Date.now() - startedAt)}`)
    } catch (_) {}
    return c.json({ success: true, provider, assetPath, url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`, remoteUrl, prompt, negativePrompt })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const status = e && typeof e.status === 'number' ? e.status : null
    try {
      console.log(`[gamestudio] ch.ref:fail project=${id} provider=${imgProvider} status=${status == null ? '-' : status} ms=${Math.max(0, Date.now() - startedAt)} err=${msg}`)
    } catch (_) {}
    if (status === 501) return c.json({ success: false, error: 'provider_not_configured', message: msg }, 501)
    return c.json({ success: false, error: 'ai_failed', message: msg }, 502)
  }
})

app.get('/', (c) => c.text('gamestudio_server'))

export default app

function isMainModule() {
  try {
    const entry = process.argv[1]
    if (!entry) return false
    return import.meta.url === pathToFileURL(entry).href
  } catch (_) {
    return false
  }
}

if (isMainModule()) {
  const port = Number(process.env.PORT || 1999)
  serve({ fetch: app.fetch, port })
  // eslint-disable-next-line no-console
  console.log(`[gamestudio] server on :${port}`)
}
