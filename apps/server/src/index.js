import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import { mkdir, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pluginStoryPixi from '@game-studio/plugin-story-pixi'
import { genId, generateScriptDraft, generateScriptsFromPrompt, guessTitleFromPrompt, repairScriptDraft } from './ai/scripts.js'
import { getAiStatusSnapshot, runAiDiagnostics } from './ai/diagnostics.js'
import { analyzeScriptsForBlueprint } from './ai/analyze.js'
import { readGlobalRules, writeGlobalRules } from './ai/globalRules.js'
import { generateBackgroundImage } from './ai/background.js'
import { generateBackgroundPrompt } from './ai/imagePrompt.js'
import { generateCharacterFingerprint } from './ai/characterPrompt.js'
import { getDoubaoImagesConfigSnapshot } from './ai/doubao.js'
import { diagnoseOllamaText } from './ai/ollama.js'
import { compileBlueprintFromScripts } from './blueprint/compile.js'
import { validateBlueprintDoc } from './blueprint/validate.js'
import { loadEnv } from './env.js'
import { diagnoseOpenAI, reviewBlueprintViaOpenAI } from './ai/openai.js'
import { reviewBlueprintLocally } from './ai/blueprintReviewLocal.js'
import dns from 'node:dns/promises'
import { getEffectiveStudioConfig, writeStudioSettings } from './studio/settings.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../../..')

const app = new Hono()

// Load .env/.env.local for local development (do not commit secrets).
const envInfo = loadEnv({ startDirs: [PROJECT_ROOT], maxHops: 1 })
try {
  const provider = String(process.env.STUDIO_AI_PROVIDER || 'local')
  const hasKey = Boolean(String(process.env.OPENAI_API_KEY || '').trim())
  const model = String(process.env.STUDIO_AI_MODEL || '')
  console.log(
    `[game_studio] env loaded=${envInfo.loaded.length ? envInfo.loaded.join(',') : '(none)'} aiProvider=${provider} openaiKey=${hasKey ? 'set' : 'missing'}${model ? ` model=${model}` : ''}`
  )
} catch (_) {}

// P0：允许本地 editor（8868）跨域调用 server（1999）
app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }))

app.get('/api/health', (c) => c.json({ ok: true, service: 'game_studio_server' }))
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
// Storage root should live at repo root by default: game_studio/storage/*
// For production/real usage, prefer setting STUDIO_STORAGE_ROOT to a repo-external path.
const DEFAULT_ROOT = path.resolve(__dirname, '../../../storage')
const ENV_ROOT = String(process.env.STUDIO_STORAGE_ROOT || '').trim()
const ROOT = ENV_ROOT
  ? (path.isAbsolute(ENV_ROOT) ? ENV_ROOT : path.resolve(process.cwd(), ENV_ROOT))
  : DEFAULT_ROOT
const PROJECTS_DIR = path.join(ROOT, 'projects')
const DEMOS_DIR = path.join(ROOT, 'demos')
const DEMO_LIBRARY_DIR = path.join(ROOT, 'demo_library')
const TOOL_VERSION = '0.1.0'

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

app.get('/api/studio/settings', async (c) => {
  const { settings, effective } = await getEffectiveStudioConfig(ROOT)
  return c.json({ success: true, settings: settings || null, effective })
})

app.put('/api/studio/settings', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const saved = await writeStudioSettings(ROOT, body && body.settings ? body.settings : body)
  return c.json({ success: true, settings: saved })
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
    const [ckptResp, loraRespA, loraRespB] = await Promise.all([
      fetch(`${baseUrl}/object_info/CheckpointLoaderSimple`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/object_info/LoraLoader`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/object_info/LoraLoaderModelOnly`, { method: 'GET', signal: controller.signal }).catch(() => null)
    ])
    if (!ckptResp || !ckptResp.ok) {
      return c.json({ success: false, error: 'comfyui_models_failed', message: `HTTP_${ckptResp ? ckptResp.status : 0}`, baseUrl }, 502)
    }
    const ckptJson = await ckptResp.json().catch(() => null)
    const ckpts = ckptJson && ckptJson.CheckpointLoaderSimple && ckptJson.CheckpointLoaderSimple.input && ckptJson.CheckpointLoaderSimple.input.required
      ? ckptJson.CheckpointLoaderSimple.input.required.ckpt_name
      : null
    const models = Array.isArray(ckpts) ? ckpts.map((x) => String(x || '').trim()).filter(Boolean) : []
    const loraJsonA = loraRespA && loraRespA.ok ? await loraRespA.json().catch(() => null) : null
    const loraJsonB = loraRespB && loraRespB.ok ? await loraRespB.json().catch(() => null) : null
    const loraA = loraJsonA && loraJsonA.LoraLoader && loraJsonA.LoraLoader.input && loraJsonA.LoraLoader.input.required
      ? loraJsonA.LoraLoader.input.required.lora_name
      : null
    const loraB = loraJsonB && loraJsonB.LoraLoaderModelOnly && loraJsonB.LoraLoaderModelOnly.input && loraJsonB.LoraLoaderModelOnly.input.required
      ? loraJsonB.LoraLoaderModelOnly.input.required.lora_name
      : null
    const loraSet = new Set()
    for (const x of Array.isArray(loraA) ? loraA : []) {
      const s = String(x || '').trim()
      if (s) loraSet.add(s)
    }
    for (const x of Array.isArray(loraB) ? loraB : []) {
      const s = String(x || '').trim()
      if (s) loraSet.add(s)
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

  async function diagnoseDoubaoText(model) {
    const keyPresent = Boolean(String(process.env.DOUBAO_ARK_API_KEY || process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY || '').trim())
    const authHeaderPresent = Boolean(String(process.env.DOUBAO_ARK_AUTH_HEADER || process.env.DOUBAO_AUTH_HEADER || '').trim())
    const cfg = {
      provider: 'doubao',
      api: 'chat.completions',
      apiUrl: String(process.env.DOUBAO_ARK_CHAT_URL || process.env.DOUBAO_ARK_TEXT_URL || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'),
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

  async function diagnoseOllamaTextLocal(model) {
    const cfgModel = String(model || '').trim() || null
    const res = await diagnoseOllamaText({
      model: cfgModel || undefined,
      timeoutMs,
      proxyUrl: effective.network.proxyUrl,
      deepText
    })
    return res
  }

  async function diagnoseDoubaoImages({ apiUrl, model }) {
    const keyPresent = Boolean(String(process.env.DOUBAO_ARK_API_KEY || process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY || '').trim())
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
  const checkImage = service === 'all' || service === 'image'

  if (checkScripts) {
    try {
      if (!effective.enabled.scripts) out.services.scripts = { ok: true, provider: effective.scripts.provider, model: effective.scripts.model, note: 'disabled' }
      else if (effective.scripts.provider === 'openai') out.services.scripts = await diagnoseOpenAI({ timeoutMs })
      else if (effective.scripts.provider === 'doubao') out.services.scripts = await diagnoseDoubaoText(effective.scripts.model)
      else if (effective.scripts.provider === 'ollama') out.services.scripts = await diagnoseOllamaTextLocal(effective.scripts.model)
      else out.services.scripts = { ok: true, provider: effective.scripts.provider, model: effective.scripts.model, note: 'local' }
    } catch (e) {
      out.services.scripts = { ok: false, provider: effective.scripts.provider, model: effective.scripts.model, note: e && e.message ? String(e.message) : String(e) }
    }
  }

  if (checkPrompt) {
    try {
      if (!effective.enabled.prompt) out.services.prompt = { ok: true, provider: effective.prompt.provider, model: effective.prompt.model, note: 'disabled' }
      else if (effective.prompt.provider === 'openai') out.services.prompt = await diagnoseOpenAI({ timeoutMs })
      else if (effective.prompt.provider === 'doubao') out.services.prompt = await diagnoseDoubaoText(effective.prompt.model)
      else if (effective.prompt.provider === 'ollama') out.services.prompt = await diagnoseOllamaTextLocal(effective.prompt.model)
      else out.services.prompt = { ok: true, provider: effective.prompt.provider, model: effective.prompt.model, note: 'local' }
    } catch (e) {
      out.services.prompt = { ok: false, provider: effective.prompt.provider, model: effective.prompt.model, note: e && e.message ? String(e.message) : String(e) }
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

async function ensureDirs() {
  await mkdir(PROJECTS_DIR, { recursive: true })
  await mkdir(DEMOS_DIR, { recursive: true })
  await mkdir(DEMO_LIBRARY_DIR, { recursive: true })
}

function projectDir(id) {
  return path.join(PROJECTS_DIR, String(id))
}

function demoLibDir(demoId) {
  return path.join(DEMO_LIBRARY_DIR, String(demoId))
}

function demoDir(projectId, buildId) {
  return path.join(DEMOS_DIR, String(projectId), String(buildId))
}

async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf-8'))
}

async function writeJson(p, obj) {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(obj, null, 2), 'utf-8')
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

app.get('/api/projects', async (c) => {
  await ensureDirs()
  const items = []
  const dirs = await readdir(PROJECTS_DIR).catch(() => [])
  for (const id of dirs) {
    const dir = projectDir(id)
    if (!(await existsDir(dir))) continue
    try {
      const p = await readJson(path.join(dir, 'project.json'))
      items.push(p)
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
  const project = { schemaVersion: '2.0', id, title, pluginId: 'story-pixi', pluginVersion: '0.1.0', createdAt: nowIso(), updatedAt: nowIso(), characters: [], assets: [], events: [], state: { vars: [] } }
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
  const choicePoints = clampInt(body?.choicePoints, 1, 3, 2)
  const optionsPerChoice = clampInt(body?.optionsPerChoice, 2, 5, 2)
  const endings = clampInt(body?.endings, 2, 3, 2)
  const formula = { schemaVersion: '1.0', format: 'numeric', choicePoints, optionsPerChoice, endings }
  const id = crypto.randomUUID ? crypto.randomUUID() : `p_${Math.random().toString(36).slice(2, 10)}`
  const dir = projectDir(id)

  const startedAt = Date.now()
  const aiTimeoutMs = 90_000
  let gen = null
  let genMeta = null
  const requestedProvider = String(studio.effective.scripts.provider || 'local').toLowerCase()
  const requestedModel = studio.effective.scripts.model || null
  const globalRules = await readGlobalRules(ROOT)
  try {
    console.log(
      `[game_studio] ai.create:start project=${id} requestedProvider=${requestedProvider}${requestedModel ? ` model=${requestedModel}` : ''} promptChars=${prompt.length}${titleIn ? ` titleChars=${titleIn.length}` : ''} choicePoints=${choicePoints} optionsPerChoice=${optionsPerChoice} endings=${endings}`
    )
  } catch (_) {}
  try {
    gen = await generateScriptDraft({
      prompt,
      title: titleIn || undefined,
      rules: globalRules,
      formula,
      provider: requestedProvider,
      model: requestedModel || undefined,
      proxyUrl: studio.effective.network.proxyUrl,
      timeoutMs: aiTimeoutMs
    })
    if (gen && typeof gen === 'object' && gen.meta) genMeta = gen.meta
    if (gen && typeof gen === 'object' && gen.draft) gen = gen.draft
  } catch (e) {
    try {
      const msg = e instanceof Error ? e.message : String(e)
      // include low-level cause (DNS / TLS / proxy / etc.)
      const cause = (e && typeof e === 'object' && 'cause' in e) ? e.cause : null
      const causeMsg = cause && typeof cause === 'object' && cause.message ? String(cause.message) : (cause ? String(cause) : '')
      const causeCode = cause && typeof cause === 'object' && cause.code ? String(cause.code) : ''
      console.error('[game_studio] ai generate failed:', msg, causeMsg ? `cause=${causeMsg}` : '', causeCode ? `code=${causeCode}` : '')
    } catch (_) {}
    gen = null
    try {
      // Keep metadata so UI can explain fallback.
      const model = String(process.env.STUDIO_AI_MODEL || '').trim() || null
      genMeta = {
        provider: 'local',
        model,
        api: null,
        error: {
          message: e instanceof Error ? e.message : String(e),
          status: e && e.status ? Number(e.status) : null,
          code: e && e.code ? String(e.code) : null,
          cause: e && e.cause ? (e.cause.message ? String(e.cause.message) : String(e.cause)) : null
        }
      }
    } catch (_) {}
  }

  const genTitle = gen && typeof gen.title === 'string' ? String(gen.title).trim() : ''
  const title = titleIn || genTitle || guessTitleFromPrompt(prompt)

  // For remote providers, if AI call failed, do not create a broken project entry.
  if (requestedProvider !== 'local' && (!gen || !Array.isArray(gen.cards))) {
    const err = genMeta && genMeta.error ? genMeta.error : null
    const msg = err && err.message ? String(err.message) : 'ai_generate_failed'
    const status = err && Number.isFinite(Number(err.status)) ? Math.max(400, Math.min(599, Number(err.status))) : 502
    return c.json({
      success: false,
      error: 'ai_generate_failed',
      message: msg,
      gen: {
        requestedProvider,
        provider: genMeta?.provider || requestedProvider,
        model: genMeta?.model || null,
        api: genMeta?.api || null,
        durationMs: Math.max(0, Date.now() - startedAt),
        formula,
        error: err
      }
    }, status)
  }

  await mkdir(path.join(dir, 'assets'), { recursive: true })

  const project = {
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
  }

  await writeJson(path.join(dir, 'project.json'), project)
  await writeJson(path.join(dir, 'story.json'), defaultStory())

  // scripts (generated)
  let scriptsOut = null
  if (gen && typeof gen === 'object' && Array.isArray(gen.cards)) {
    const cardsIn = gen.cards
    const cards = cardsIn
      .map((x, i) => ({
        id: genId('sc'),
        name: String(x && x.name ? x.name : `场景${i + 1}`),
        order: i + 1,
        text: String(x && x.text ? x.text : ''),
        updatedAt: nowIso()
      }))
      .filter((c) => c.text.trim())

    const scripts = { schemaVersion: '1.0', cards, updatedAt: nowIso() }
    scriptsOut = scripts.cards.length ? scripts : generateScriptsFromPrompt(prompt)
    await writeJson(path.join(dir, 'scripts.json'), scriptsOut)
  } else {
    scriptsOut = generateScriptsFromPrompt(prompt)
    await writeJson(path.join(dir, 'scripts.json'), scriptsOut)
  }

  // keep blueprint placeholder file for workflow
  await writeJson(path.join(dir, 'blueprint.json'), defaultBlueprint())
  await writeJson(path.join(dir, 'meta.json'), { ...defaultMeta({ id, title }), aiFormula: formula })

  const durationMs = Math.max(0, Date.now() - startedAt)
  try {
    console.log(
      `[game_studio] ai.create project=${id} requestedProvider=${requestedProvider} provider=${genMeta?.provider || 'local'} model=${genMeta?.model || '-'} api=${genMeta?.api || '-'} cards=${Array.isArray(scriptsOut?.cards) ? scriptsOut.cards.length : 0} ms=${durationMs}`
    )
  } catch (_) {}

  return c.json({
    success: true,
    project,
    scripts: scriptsOut,
    gen: {
      requestedProvider,
      provider: genMeta?.provider || 'local',
      model: genMeta?.model || null,
      api: genMeta?.api || null,
      durationMs,
      formula,
      error: genMeta && genMeta.error ? genMeta.error : null
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
  const choicePoints = clampInt(body?.choicePoints, 1, 3, 2)
  const optionsPerChoice = clampInt(body?.optionsPerChoice, 2, 5, 2)
  const endings = clampInt(body?.endings, 2, 3, 2)
  const formula = { schemaVersion: '1.0', format: 'numeric', choicePoints, optionsPerChoice, endings }
  const startedAt = Date.now()
  const aiTimeoutMs = 90_000
  let gen = null
  let genMeta = null
  const requestedProvider = String(studio.effective.scripts.provider || 'local').toLowerCase()
  const requestedModel = studio.effective.scripts.model || null
  const globalRules = await readGlobalRules(ROOT)
  try {
    console.log(
      `[game_studio] ai.regen:start project=${id} requestedProvider=${requestedProvider}${requestedModel ? ` model=${requestedModel}` : ''} promptChars=${prompt.length}${titleIn ? ` titleChars=${titleIn.length}` : ''} choicePoints=${choicePoints} optionsPerChoice=${optionsPerChoice} endings=${endings}`
    )
  } catch (_) {}

  try {
    gen = await generateScriptDraft({
      prompt,
      title: titleIn || undefined,
      rules: globalRules,
      formula,
      provider: requestedProvider,
      model: requestedModel || undefined,
      proxyUrl: studio.effective.network.proxyUrl,
      timeoutMs: aiTimeoutMs
    })
    if (gen && typeof gen === 'object' && gen.meta) genMeta = gen.meta
    if (gen && typeof gen === 'object' && gen.draft) gen = gen.draft
  } catch (e) {
    try {
      const msg = e instanceof Error ? e.message : String(e)
      const cause = (e && typeof e === 'object' && 'cause' in e) ? e.cause : null
      const causeMsg = cause && typeof cause === 'object' && cause.message ? String(cause.message) : (cause ? String(cause) : '')
      const causeCode = cause && typeof cause === 'object' && cause.code ? String(cause.code) : ''
      console.error('[game_studio] ai regen failed:', msg, causeMsg ? `cause=${causeMsg}` : '', causeCode ? `code=${causeCode}` : '')
    } catch (_) {}
    gen = null
    try {
      const model = String(process.env.STUDIO_AI_MODEL || '').trim() || null
      genMeta = {
        provider: 'local',
        model,
        api: null,
        error: {
          message: e instanceof Error ? e.message : String(e),
          status: e && e.status ? Number(e.status) : null,
          code: e && e.code ? String(e.code) : null,
          cause: e && e.cause ? (e.cause.message ? String(e.cause.message) : String(e.cause)) : null
        }
      }
    } catch (_) {}
  }

  const currProject = await readJson(path.join(dir, 'project.json'))
  const genTitle = gen && typeof gen.title === 'string' ? String(gen.title).trim() : ''
  const nextTitle = titleIn || String(currProject?.title || '').trim() || genTitle || guessTitleFromPrompt(prompt)

  // scripts (generated) overwrite
  let scriptsOut = null
  if (gen && typeof gen === 'object' && Array.isArray(gen.cards)) {
    const cardsIn = gen.cards
    const cards = cardsIn
      .map((x, i) => ({
        id: genId('sc'),
        name: String(x && x.name ? x.name : `场景${i + 1}`),
        order: i + 1,
        text: String(x && x.text ? x.text : ''),
        updatedAt: nowIso()
      }))
      .filter((c) => c.text.trim())

    const scripts = { schemaVersion: '1.0', cards, updatedAt: nowIso() }
    scriptsOut = scripts.cards.length ? scripts : generateScriptsFromPrompt(prompt)
  } else {
    scriptsOut = generateScriptsFromPrompt(prompt)
  }
  await writeJson(path.join(dir, 'scripts.json'), scriptsOut)

  // keep titles + timestamps in sync
  const nextProject = { ...(currProject || {}), id, title: nextTitle, updatedAt: nowIso() }
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
      `[game_studio] ai.regen project=${id} requestedProvider=${requestedProvider} provider=${genMeta?.provider || 'local'} model=${genMeta?.model || '-'} api=${genMeta?.api || '-'} cards=${Array.isArray(scriptsOut?.cards) ? scriptsOut.cards.length : 0} ms=${durationMs}`
    )
  } catch (_) {}

  return c.json({
    success: true,
    project: nextProject,
    scripts: scriptsOut,
    gen: {
      requestedProvider,
      provider: genMeta?.provider || 'local',
      model: genMeta?.model || null,
      api: genMeta?.api || null,
      durationMs,
      formula,
      error: genMeta && genMeta.error ? genMeta.error : null
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

  const provider = String(process.env.STUDIO_AI_PROVIDER || 'local').toLowerCase()
  const startedAt = Date.now()
  if (provider !== 'openai') {
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
      validation
    })
    try {
      console.log(
        `[game_studio] ai.blueprint_review project=${id} provider=${ai?.meta?.provider || 'openai'} model=${ai?.meta?.model || '-'} api=${ai?.meta?.api || '-'} ms=${ai?.meta?.durationMs || 0}`
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
      console.error('[game_studio] ai blueprint review failed:', e instanceof Error ? e.message : String(e))
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
      proxyUrl: studio.effective.network.proxyUrl
    })
  } catch (e) {
    try {
      const msg = e instanceof Error ? e.message : String(e)
      const cause = (e && typeof e === 'object' && 'cause' in e) ? e.cause : null
      const causeMsg = cause && typeof cause === 'object' && cause.message ? String(cause.message) : (cause ? String(cause) : '')
      const causeCode = cause && typeof cause === 'object' && cause.code ? String(cause.code) : ''
      console.error('[game_studio] ai fix scripts failed:', msg, causeMsg ? `cause=${causeMsg}` : '', causeCode ? `code=${causeCode}` : '')
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
      `[game_studio] ai.scripts_fix project=${id} requestedProvider=${requestedProvider}${requestedModel ? ` model=${requestedModel}` : ''} provider=${fixed?.meta?.provider || 'unknown'} model=${fixed?.meta?.model || '-'} api=${fixed?.meta?.api || '-'} okBefore=${validationBefore?.ok ? 'true' : 'false'} okAfter=${validationAfter?.ok ? 'true' : 'false'} cards=${cardsOut.length} ms=${durationMs}`
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
  const project = await readJson(path.join(dir, 'project.json'))
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

  const curr = await readJson(path.join(dir, 'project.json'))
  const next = project ? { ...curr, ...project, id, updatedAt: nowIso() } : { ...curr, updatedAt: nowIso() }
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

  // best-effort: remove demos for project
  try {
    await rm(path.join(DEMOS_DIR, String(id)), { recursive: true, force: true })
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

  const nextProject = {
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
  }

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

  const buildId = String(Date.now())
  const out = demoDir(id, buildId)
  const dist = path.join(out, 'dist')
  await mkdir(dist, { recursive: true })

  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {}
  }

  // P0：固定 story-pixi 插件
  await pluginStoryPixi.build({ projectId: id, projectDir: dir, outDir: dist, toolVersion: TOOL_VERSION, logger })

  return c.json({
    success: true,
    buildId,
    distUrl: `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/dist/index.html`
  })
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
  const filePath = path.join(demoDir(projectId, buildId), rest)
  try {
    const buf = await readFile(filePath)
    // 简单 content-type
    const ext = path.extname(filePath).toLowerCase()
    const ct =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      ext === '.js' ? 'application/javascript; charset=utf-8' :
      ext === '.css' ? 'text/css; charset=utf-8' :
      'application/octet-stream'
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
	const width = Number(body?.width || 768)
	const height = Number(body?.height || 1024)
	if (!scenePrompt) return c.json({ success: false, error: 'missing_prompt' }, 400)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
	const bgProvider = String(studio.effective.image.provider || process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()
  const timeoutRaw = body?.timeoutMs
  const bgTimeoutMs = (Number.isFinite(Number(timeoutRaw)) && Number(timeoutRaw) <= 0)
    ? 0
    : clampInt(timeoutRaw, 5_000, 300_000, clampInt(process.env.STUDIO_BG_TIMEOUT_MS, 5_000, 300_000, 180_000))
	const startedAt = Date.now()
  const promptJoiner = (bgProvider === 'sdwebui' || bgProvider === 'comfyui') ? ', ' : '，'
	const effectivePrompt = [globalPrompt, scenePrompt].map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(promptJoiner)
	const effectiveNegative = [globalNegativePrompt, sceneNegative].map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ')
	try {
	  console.log(
	    `[game_studio] bg.create:start project=${id} provider=${bgProvider} promptChars=${scenePrompt.length} globalChars=${globalPrompt.length} negChars=${sceneNegative.length} globalNegChars=${globalNegativePrompt.length} w=${Math.floor(width || 0)} h=${Math.floor(height || 0)} size=${String(body?.size || '')} format=${String(body?.responseFormat || '')} ar=${String(body?.aspectRatio || '')} style=${String(body?.style || '')} sampler=${String(body?.sampler || 'DPM++ 2M')} scheduler=${String(body?.scheduler || 'Automatic')} timeoutMs=${bgTimeoutMs <= 0 ? 'none' : bgTimeoutMs}`
	  )
	} catch (_) {}

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
      provider: bgProvider,
      sdwebuiBaseUrl: studio.effective.image.sdwebuiBaseUrl,
      comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
      apiUrl: studio.effective.image.apiUrl,
      model: studio.effective.image.model,
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
	    const fname = `bg_${Date.now()}.${ext}`
		    const abs = path.join(outDir, fname)
		    await writeFile(abs, buf)
		    const assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
		    const provider = (gen && gen.meta && gen.meta.provider) ? String(gen.meta.provider) : String(process.env.STUDIO_BG_PROVIDER || 'sdwebui')
		    const remoteUrl = (gen && gen.meta && typeof gen.meta.url === 'string' && gen.meta.url.trim()) ? String(gen.meta.url).trim() : ''
		    try {
		      console.log(`[game_studio] bg.create:ok project=${id} provider=${provider} bytes=${buf.length} ext=${ext} ms=${Math.max(0, Date.now() - startedAt)}`)
		    } catch (_) {}
		    return c.json({ success: true, provider, assetPath, url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`, remoteUrl })
		  } catch (e) {
		    const msg = e && e.message ? String(e.message) : String(e)
		    const status = e && typeof e.status === 'number' ? e.status : null
		    try {
	      console.log(`[game_studio] bg.create:fail project=${id} provider=${bgProvider} status=${status == null ? '-' : status} ms=${Math.max(0, Date.now() - startedAt)} err=${msg}`)
	    } catch (_) {}
	    if (status === 501) return c.json({ success: false, error: 'provider_not_configured', message: msg }, 501)
	    return c.json({ success: false, error: 'ai_failed', message: msg }, 502)
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

	const startedAt = Date.now()
	try {
	  console.log(
	    `[game_studio] bg.prompt:start project=${id} userChars=${userInput.length} globalChars=${globalPrompt.length} globalNegChars=${globalNegativePrompt.length} ar=${aspectRatio} style=${style} timeoutMs=${promptTimeoutMs}`
	  )
	} catch (_) {}
	try {
	  const { result, meta } = await generateBackgroundPrompt({
      userInput,
      globalPrompt,
      globalNegativePrompt,
      aspectRatio,
      style,
      timeoutMs: promptTimeoutMs,
      targetImageProvider: studio.effective.image.provider,
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model,
      proxyUrl: studio.effective.network.proxyUrl
    })
	  try {
	    console.log(`[game_studio] bg.prompt:ok project=${id} provider=${meta && meta.provider ? meta.provider : 'openai'} model=${meta && meta.model ? meta.model : '-'} ms=${Math.max(0, Date.now() - startedAt)}`)
	  } catch (_) {}
	  return c.json({ success: true, result, meta })
  } catch (e) {
    try {
      console.log(`[game_studio] bg.prompt:fail project=${id} ms=${Math.max(0, Date.now() - startedAt)} err=${e && e.message ? String(e.message) : String(e)}`)
    } catch (_) {}
    return c.json({ success: false, error: 'ai_failed', message: e && e.message ? String(e.message) : String(e) }, 502)
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
      `[game_studio] ch.fp:start project=${id} provider=${studio.effective.prompt.provider || 'openai'} model=${studio.effective.prompt.model || '-'} name=${characterName} storyChars=${storyTitle.length} ctxChars=${contextText.length} globalChars=${globalPrompt.length} style=${style}`
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
      proxyUrl: studio.effective.network.proxyUrl
    })

    try {
      console.log(`[game_studio] ch.fp:ok project=${id} ms=${Math.max(0, Date.now() - startedAt)} provider=${meta?.provider || '-'} model=${meta?.model || '-'}`)
    } catch (_) {}
    return c.json({ success: true, result, meta })
  } catch (e) {
    try {
      console.log(`[game_studio] ch.fp:fail project=${id} ms=${Math.max(0, Date.now() - startedAt)} err=${e && e.message ? String(e.message) : String(e)}`)
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
      `[game_studio] ch.sprite:start project=${id} provider=${imgProvider} model=${studio.effective.image.model || '-'} w=${Math.floor(width || 0)} h=${Math.floor(height || 0)} style=${style} promptChars=${prompt.length} negChars=${negativePrompt.length}`
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
      console.log(`[game_studio] ch.sprite:ok project=${id} provider=${provider} bytes=${buf.length} ext=${ext} ms=${Math.max(0, Date.now() - startedAt)}`)
    } catch (_) {}
    return c.json({ success: true, provider, assetPath, url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`, remoteUrl, prompt, negativePrompt })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const status = e && typeof e.status === 'number' ? e.status : null
    try {
      console.log(`[game_studio] ch.sprite:fail project=${id} provider=${imgProvider} status=${status == null ? '-' : status} ms=${Math.max(0, Date.now() - startedAt)} err=${msg}`)
    } catch (_) {}
    if (status === 501) return c.json({ success: false, error: 'provider_not_configured', message: msg }, 501)
    return c.json({ success: false, error: 'ai_failed', message: msg }, 502)
  }
})

app.get('/', (c) => c.text('game_studio_server'))

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
  console.log(`[game_studio] server on :${port}`)

  // Auto diagnostics (non-blocking): background image provider config + connectivity hints.
  void (async () => {
    try {
      const providerRaw = String(process.env.STUDIO_BG_PROVIDER || '').trim()
      const provider = (providerRaw || 'sdwebui').toLowerCase()
      const providerFromEnv = Boolean(providerRaw)
      const proxy = String(process.env.STUDIO_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || '').trim()
      const proxyOn = Boolean(proxy)
      if (provider === 'doubao') {
        const { apiUrl, model, authMode } = getDoubaoImagesConfigSnapshot()
        const timeoutMs = Number(process.env.STUDIO_BG_TIMEOUT_MS || 180000) || 180000
        let dnsOk = null
        let host = ''
        try {
          host = new URL(apiUrl).hostname
          const addrs = await dns.lookup(host, { all: true }).catch(() => [])
          dnsOk = Array.isArray(addrs) && addrs.length > 0
        } catch (_) {
          dnsOk = false
        }
        console.log(
          `[game_studio] bg.diag provider=doubao${providerFromEnv ? '' : '(default)'} api=${apiUrl} model=${model} auth=${authMode} timeoutMs=${timeoutMs} proxy=${proxyOn ? 'on' : 'off'} dns=${dnsOk === null ? '-' : dnsOk ? 'ok' : 'fail'}${host ? ` host=${host}` : ''}`
        )
      } else if (provider === 'comfyui') {
        const baseUrl = String(process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188').trim()
        const timeoutMs = Number(process.env.STUDIO_BG_TIMEOUT_MS || 180000) || 180000
        console.log(
          `[game_studio] bg.diag provider=comfyui${providerFromEnv ? '' : '(default)'} baseUrl=${baseUrl} timeoutMs=${timeoutMs} proxy=${proxyOn ? 'on' : 'off'}`
        )
      } else {
        const baseUrl = String(process.env.SDWEBUI_BASE_URL || 'http://127.0.0.1:7860').trim()
        const timeoutMs = Number(process.env.STUDIO_BG_TIMEOUT_MS || 180000) || 180000
        const apiKeyPresent = Boolean(String(process.env.DOUBAO_ARK_API_KEY || process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY || '').trim())
        const authHeaderPresent = Boolean(String(process.env.DOUBAO_ARK_AUTH_HEADER || process.env.DOUBAO_AUTH_HEADER || '').trim())
        const hasDoubaoCreds = apiKeyPresent || authHeaderPresent
        console.log(
          `[game_studio] bg.diag provider=sdwebui${providerFromEnv ? '' : '(default)'} baseUrl=${baseUrl} timeoutMs=${timeoutMs} proxy=${proxyOn ? 'on' : 'off'}`
        )
        if (!providerFromEnv && hasDoubaoCreds) {
          console.log('[game_studio] bg.diag:hint 检测到豆包（Ark）鉴权已配置，但未设置 STUDIO_BG_PROVIDER=doubao，当前仍会走 sdwebui。')
        }
      }
    } catch (_) {}
  })()

  // Auto diagnostics (non-blocking): validate OpenAI connectivity and list models.
  // Useful for quickly spotting proxy/DNS/firewall issues and invalid model names.
  void (async () => {
    try {
      const snap = getAiStatusSnapshot()
      if (snap.provider !== 'openai') return
      console.log('[game_studio] ai.diag:start')
      const res = await runAiDiagnostics({ force: true })
      if (res && res.ok) {
        const hasModel = res.models && typeof res.models.hasModel === 'boolean' ? res.models.hasModel : null
        console.log(
          `[game_studio] ai.diag:ok baseUrl=${res.baseUrl} model=${res.model} models=${res.models ? res.models.count : 0}${hasModel === false ? ' (model_not_in_list)' : ''} ms=${res.durationMs}`
        )
      } else {
        const errMsg = res && res.error && res.error.message ? String(res.error.message) : 'unknown_error'
        const dnsOk = res && res.dns && typeof res.dns.ok === 'boolean' ? res.dns.ok : null
        console.log(`[game_studio] ai.diag:failed baseUrl=${res && res.baseUrl ? res.baseUrl : '-'} model=${res && res.model ? res.model : '-'} dnsOk=${dnsOk} error=${errMsg} ms=${res && res.durationMs ? res.durationMs : 0}`)
      }
    } catch (e) {
      try {
        console.log('[game_studio] ai.diag:crash', e && e.message ? e.message : String(e))
      } catch (_) {}
    }
  })()
}
