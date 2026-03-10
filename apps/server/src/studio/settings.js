import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

function nowIso() {
  try { return new Date().toISOString() } catch (_) { return String(Date.now()) }
}

function sanitizeProvider(v) {
  const s = String(v || '').trim().toLowerCase()
  return s || null
}

function sanitizeModel(v) {
  const s = String(v || '').trim()
  return s || null
}

function sanitizeUrl(v) {
  const s = String(v || '').trim()
  if (!s) return null
  try {
    const u = new URL(s)
    const p = String(u.protocol || '').toLowerCase()
    if (p !== 'http:' && p !== 'https:' && p !== 'socks:' && p !== 'socks5:' && p !== 'socks5h:' && p !== 'socks4:' && p !== 'socks4a:') return null
    return u.toString().replace(/\/+$/, '')
  } catch (_) {
    return null
  }
}

function sanitizeFsPath(v) {
  const s = String(v || '').trim()
  if (!s) return null
  // Keep it strict: absolute path only (server-side file hints / optional disk checks).
  if (!path.isAbsolute(s)) return null
  return s
}

function sanitizeSize(v) {
  const s = String(v || '').trim()
  if (!s) return null
  if (/^\d{2,5}x\d{2,5}$/i.test(s)) return s.toLowerCase()
  if (/^(?:1k|2k|4k)$/i.test(s)) return s.toUpperCase()
  return null
}

function sanitizeStringList(v, maxLen = 120, maxItems = 64) {
  const arr = Array.isArray(v) ? v : []
  const out = []
  const seen = new Set()
  for (const x of arr) {
    const s = String(x || '').trim()
    if (!s) continue
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s.slice(0, maxLen))
    if (out.length >= maxItems) break
  }
  return out
}

function sanitizeBool(v, fallback) {
  if (typeof v === 'boolean') return v
  if (v == null) return Boolean(fallback)
  const s = String(v).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  return Boolean(fallback)
}

export function studioSettingsFilePath(storageRoot) {
  const root = String(storageRoot || '').trim()
  if (!root) throw new Error('missing_storage_root')
  return path.join(root, '_config', 'studio_settings.json')
}

const cache = {
  mtimeMs: 0,
  value: null
}

export async function readStudioSettings(storageRoot) {
  const p = studioSettingsFilePath(storageRoot)
  try {
    const st = await stat(p)
    if (cache.value && cache.mtimeMs && Number(st.mtimeMs) === Number(cache.mtimeMs)) return cache.value
    const raw = await readFile(p, 'utf-8')
    const json = JSON.parse(raw)
    if (!json || typeof json !== 'object') return null
    cache.mtimeMs = Number(st.mtimeMs) || 0
    cache.value = json
    return json
  } catch (_) {
    return null
  }
}

export async function writeStudioSettings(storageRoot, incoming) {
  const p = studioSettingsFilePath(storageRoot)
  const dir = path.dirname(p)
  await mkdir(dir, { recursive: true })

  const prev = (await readStudioSettings(storageRoot)) || {}
  const inObj = incoming && typeof incoming === 'object' ? incoming : {}

  const has = (obj, k) => Boolean(obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, k))
  const inEnabled = inObj?.enabled
  const inScripts = inObj?.scripts
  const inPrompt = inObj?.prompt
  const inImage = inObj?.image
  const inTts = inObj?.tts
  const inNet = inObj?.network

  const next = {
    schemaVersion: '1.0',
    updatedAt: nowIso(),
    enabled: {
      scripts: sanitizeBool(has(inEnabled, 'scripts') ? inEnabled.scripts : prev?.enabled?.scripts, prev?.enabled?.scripts ?? false),
      prompt: sanitizeBool(has(inEnabled, 'prompt') ? inEnabled.prompt : prev?.enabled?.prompt, prev?.enabled?.prompt ?? false),
      image: sanitizeBool(has(inEnabled, 'image') ? inEnabled.image : prev?.enabled?.image, prev?.enabled?.image ?? false),
      tts: sanitizeBool(has(inEnabled, 'tts') ? inEnabled.tts : prev?.enabled?.tts, prev?.enabled?.tts ?? false)
    },
    scripts: {
      provider: has(inScripts, 'provider') ? sanitizeProvider(inScripts.provider) : sanitizeProvider(prev?.scripts?.provider),
      model: has(inScripts, 'model') ? sanitizeModel(inScripts.model) : sanitizeModel(prev?.scripts?.model)
    },
    prompt: {
      provider: has(inPrompt, 'provider') ? sanitizeProvider(inPrompt.provider) : sanitizeProvider(prev?.prompt?.provider),
      model: has(inPrompt, 'model') ? sanitizeModel(inPrompt.model) : sanitizeModel(prev?.prompt?.model)
    },
    image: {
      provider: has(inImage, 'provider') ? sanitizeProvider(inImage.provider) : sanitizeProvider(prev?.image?.provider),
      model: has(inImage, 'model') ? sanitizeModel(inImage.model) : sanitizeModel(prev?.image?.model),
      loras: has(inImage, 'loras') ? sanitizeStringList(inImage.loras) : sanitizeStringList(prev?.image?.loras),
      apiUrl: has(inImage, 'apiUrl') ? sanitizeUrl(inImage.apiUrl) : sanitizeUrl(prev?.image?.apiUrl),
      size: has(inImage, 'size') ? sanitizeSize(inImage.size) : sanitizeSize(prev?.image?.size),
      sdwebuiBaseUrl: has(inImage, 'sdwebuiBaseUrl') ? sanitizeUrl(inImage.sdwebuiBaseUrl) : sanitizeUrl(prev?.image?.sdwebuiBaseUrl),
      comfyuiBaseUrl: has(inImage, 'comfyuiBaseUrl') ? sanitizeUrl(inImage.comfyuiBaseUrl) : sanitizeUrl(prev?.image?.comfyuiBaseUrl),
      comfyuiModelsRoot: has(inImage, 'comfyuiModelsRoot') ? sanitizeFsPath(inImage.comfyuiModelsRoot) : sanitizeFsPath(prev?.image?.comfyuiModelsRoot)
    },
    tts: {
      provider: has(inTts, 'provider') ? sanitizeProvider(inTts.provider) : sanitizeProvider(prev?.tts?.provider),
      model: has(inTts, 'model') ? sanitizeModel(inTts.model) : sanitizeModel(prev?.tts?.model),
      apiUrl: has(inTts, 'apiUrl') ? sanitizeUrl(inTts.apiUrl) : sanitizeUrl(prev?.tts?.apiUrl)
    },
    network: {
      proxyUrl: has(inNet, 'proxyUrl') ? sanitizeUrl(inNet.proxyUrl) : sanitizeUrl(prev?.network?.proxyUrl)
    }
  }

  await writeFile(p, JSON.stringify(next, null, 2), 'utf-8')
  try {
    const st = await stat(p)
    cache.mtimeMs = Number(st.mtimeMs) || 0
    cache.value = next
  } catch (_) {
    cache.mtimeMs = 0
    cache.value = next
  }
  return next
}

function envFirst(...keys) {
  for (const k of keys) {
    const v = String(process.env[k] || '').trim()
    if (v) return v
  }
  return ''
}

export async function getEffectiveStudioConfig(storageRoot, options = null) {
  const override = options && typeof options === 'object' ? options.settingsOverride : null
  const settings = (override && typeof override === 'object' ? override : ((await readStudioSettings(storageRoot)) || null))
  const DEFAULT_DOUBAO_TEXT_MODEL = 'doubao-1-5-pro-32k-250115'
  const DEFAULT_OLLAMA_TEXT_MODEL = 'qwen3:8b'

  const env = {
    aiProvider: String(process.env.STUDIO_AI_PROVIDER || 'local').toLowerCase(),
    aiModel: String(process.env.STUDIO_AI_MODEL || '').trim(),
    bgProvider: String(process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase(),
    sdwebuiBaseUrl: String(process.env.SDWEBUI_BASE_URL || 'http://127.0.0.1:7860').trim(),
    comfyuiBaseUrl: String(process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188').trim(),
    comfyuiModelsRoot: String(process.env.STUDIO_COMFYUI_MODELS_ROOT || process.env.COMFYUI_MODELS_ROOT || '').trim(),
    doubaoImagesUrl: envFirst('DOUBAO_ARK_IMAGES_URL', 'DOUBAO_ARK_API_URL'),
    doubaoImagesModel: String(process.env.DOUBAO_ARK_MODEL || '').trim(),
    doubaoTextModel: String(envFirst('DOUBAO_ARK_TEXT_MODEL', 'DOUBAO_ARK_LLM_MODEL', 'DOUBAO_LLM_MODEL') || '').trim(),
    doubaoImageSize: String(process.env.DOUBAO_IMAGE_SIZE || '').trim(),
    ollamaTextModel: String(envFirst('STUDIO_OLLAMA_MODEL', 'OLLAMA_MODEL') || '').trim(),
    proxyUrl: envFirst('STUDIO_PROXY_URL', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY')
  }

  const enabled = {
    scripts: settings ? settings?.enabled?.scripts !== false : false,
    prompt: settings ? settings?.enabled?.prompt !== false : false,
    image: settings ? settings?.enabled?.image !== false : false,
    tts: settings?.enabled?.tts === true
  }

  const scriptsProvider = (settings?.scripts?.provider ? String(settings.scripts.provider) : 'none') || 'none'
  const scriptsModel = settings?.scripts?.model
    ? String(settings.scripts.model)
    : scriptsProvider === 'openai'
      ? env.aiModel
      : scriptsProvider === 'ollama'
        ? (env.ollamaTextModel || DEFAULT_OLLAMA_TEXT_MODEL)
        : scriptsProvider === 'doubao'
          ? (env.doubaoTextModel || DEFAULT_DOUBAO_TEXT_MODEL)
          : null

  const promptProvider = (settings?.prompt?.provider ? String(settings.prompt.provider) : 'none') || 'none'
  const promptModel = settings?.prompt?.model
    ? String(settings.prompt.model)
    : promptProvider === 'openai'
      ? env.aiModel
      : promptProvider === 'ollama'
        ? (env.ollamaTextModel || DEFAULT_OLLAMA_TEXT_MODEL)
        : promptProvider === 'doubao'
          ? (env.doubaoTextModel || DEFAULT_DOUBAO_TEXT_MODEL)
          : null

  const imageProvider = (settings?.image?.provider ? String(settings.image.provider) : 'none') || 'none'
  const imageModel = settings?.image?.model ? String(settings.image.model) : env.doubaoImagesModel
  const imageLoras = Array.isArray(settings?.image?.loras) ? settings.image.loras.map((x) => String(x || '').trim()).filter(Boolean) : []
  const imageApiUrl = settings?.image?.apiUrl ? String(settings.image.apiUrl) : env.doubaoImagesUrl
  const imageSize = settings?.image?.size ? String(settings.image.size) : env.doubaoImageSize
  const sdwebuiBaseUrl = settings?.image?.sdwebuiBaseUrl ? String(settings.image.sdwebuiBaseUrl) : env.sdwebuiBaseUrl
  const comfyuiBaseUrl = settings?.image?.comfyuiBaseUrl ? String(settings.image.comfyuiBaseUrl) : env.comfyuiBaseUrl
  const comfyuiModelsRoot = settings?.image?.comfyuiModelsRoot ? String(settings.image.comfyuiModelsRoot) : env.comfyuiModelsRoot

  const proxyUrl = settings?.network?.proxyUrl ? String(settings.network.proxyUrl) : env.proxyUrl

  const effective = {
    enabled,
    scripts: { provider: scriptsProvider, model: scriptsModel || null },
    prompt: { provider: promptProvider, model: promptModel || null },
    image: {
      provider: imageProvider,
      model: imageModel || null,
      loras: imageLoras.length ? imageLoras : null,
      apiUrl: imageApiUrl || null,
      size: imageSize || null,
      sdwebuiBaseUrl: sdwebuiBaseUrl || null,
      comfyuiBaseUrl: comfyuiBaseUrl || null,
      comfyuiModelsRoot: (comfyuiModelsRoot && path.isAbsolute(comfyuiModelsRoot)) ? comfyuiModelsRoot : null
    },
    tts: {
      provider: settings?.tts?.provider ? String(settings.tts.provider) : 'none',
      model: settings?.tts?.model ? String(settings.tts.model) : null,
      apiUrl: settings?.tts?.apiUrl ? String(settings.tts.apiUrl) : null
    },
    network: { proxyUrl: proxyUrl || null }
  }

  return { settings, effective, env }
}
