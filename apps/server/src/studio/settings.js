import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { setStudioSecrets } from './secrets.js'

const DEFAULT_COMFYUI_BASE_URL = 'http://127.0.0.1:8188'
const DEFAULT_COMFYUI_MODELS_ROOT = process.env.COMFYUI_MODELS_ROOT || (process.env.COMFYUI_ROOT ? path.join(process.env.COMFYUI_ROOT, 'models') : '/Volumes/ovokit2t/ComfyUI/models')
const DEFAULT_COMFYUI_SDXL_MODEL = 'ivisionIllustration_ivision10.safetensors'
const DEFAULT_COMFYUI_SDXL_SIZE = '1024x1024'

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
  let s = String(v || '').trim()
  if (!s) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && /^[a-z0-9_.-]+(?::\d{1,5})?(?:\/.*)?$/i.test(s)) {
    s = `http://${s}`
  }
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

// 2026-10-20 设置页 V1（ui_设置定义.md §6）：schemaVersion 升 1.1，新增 video/appearance/storage 节与
// tts.voice/speed/format、enabled.video；读取旧文件时缺省节按默认值回填（内存回填，写回时落盘新版本号）。
// 2026-10-20 守护台关联：schemaVersion 升 1.2，新增 control 节（租约运行时开关 + 守护台地址）。
const SETTINGS_SCHEMA_VERSION = '1.2'
const VIDEO_RESOLUTIONS = ['720p', '1080p', '1080x1920']
const TTS_FORMATS = ['mp3', 'wav']
const VIDEO_AUDIO_TRACKS = ['tts', 'none']
const DEFAULT_SUBTITLE_STYLE = { fontSize: 24, position: 'bottom', bgOpacity: 0.6 }
const DEFAULT_APPEARANCE = { theme: 'dark', locale: 'zh-CN' }
const DEFAULT_CONTROL_LINK = { leaseEnabled: true, baseUrl: 'http://127.0.0.1:2099' }

function sanitizeBool(v, fallback) {
  if (typeof v === 'boolean') return v
  if (v == null) return Boolean(fallback)
  const s = String(v).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  return Boolean(fallback)
}

function sanitizeSecret(v) {
  const s = String(v || '').trim()
  if (!s) return null
  // Avoid accidental multi-line secrets; keep it bounded.
  return s.replace(/\r?\n/g, '').slice(0, 512)
}

function sanitizeEnum(v, allowed, fallback) {
  const s = String(v || '').trim().toLowerCase()
  return allowed.includes(s) ? s : fallback
}

function sanitizeVoice(v) {
  const s = String(v || '').trim()
  return s ? s.slice(0, 120) : null
}

function sanitizeSpeed(v, fallback = 1.0) {
  if (v == null || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0.5, Math.min(2.0, Math.round(n * 100) / 100))
}

function sanitizeFps(v, fallback = 30) {
  const n = Number(v)
  return n === 24 ? 24 : n === 30 ? 30 : fallback
}

function sanitizeBitrate(v) {
  if (v == null || v === '') return 'auto'
  const s = String(v).trim().toLowerCase()
  if (s === 'auto') return 'auto'
  const n = Math.round(Number(s))
  if (!Number.isFinite(n) || n <= 0) return 'auto'
  return Math.min(n, 100000)
}

function defaultSubtitleStyle() {
  return { ...DEFAULT_SUBTITLE_STYLE }
}

function sanitizeSubtitleStyle(v) {
  if (!v || typeof v !== 'object') return null
  const fontSize = Number(v.fontSize)
  const bgOpacity = Number(v.bgOpacity)
  const position = String(v.position || '').trim().toLowerCase()
  return {
    fontSize: Number.isFinite(fontSize) ? Math.max(8, Math.min(120, Math.round(fontSize))) : DEFAULT_SUBTITLE_STYLE.fontSize,
    position: position === 'top' || position === 'bottom' ? position : DEFAULT_SUBTITLE_STYLE.position,
    bgOpacity: Number.isFinite(bgOpacity) ? Math.max(0, Math.min(1, Math.round(bgOpacity * 100) / 100)) : DEFAULT_SUBTITLE_STYLE.bgOpacity
  }
}

function sanitizeTheme(v, fallback = 'dark') {
  const s = String(v || '').trim()
  return s ? s.slice(0, 64) : fallback
}

function sanitizeLocale(v, fallback = 'zh-CN') {
  const s = String(v || '').trim()
  return s ? s.slice(0, 32) : fallback
}

function sanitizeStorageRoot(v) {
  const s = String(v || '').trim()
  return s ? s.slice(0, 512) : null
}

// 读旧文件自动补齐：缺省的新节/新键按默认值回填（§6 默认：tts/video 关，video 1080p/30fps/码率自动）。
function withSettingsDefaults(json) {
  if (!json || typeof json !== 'object') return json
  const out = { ...json }
  out.schemaVersion = SETTINGS_SCHEMA_VERSION
  const enabled = out.enabled && typeof out.enabled === 'object' ? out.enabled : {}
  out.enabled = { ...enabled, video: sanitizeBool(enabled.video, false) }
  const tts = out.tts && typeof out.tts === 'object' ? out.tts : {}
  out.tts = {
    ...tts,
    voice: sanitizeVoice(tts.voice),
    speed: sanitizeSpeed(tts.speed, 1.0),
    format: sanitizeEnum(tts.format, TTS_FORMATS, 'mp3')
  }
  const video = out.video && typeof out.video === 'object' ? out.video : {}
  out.video = {
    provider: sanitizeProvider(video.provider),
    resolution: sanitizeEnum(video.resolution, VIDEO_RESOLUTIONS, '1080p'),
    fps: sanitizeFps(video.fps, 30),
    bitrate: sanitizeBitrate(video.bitrate),
    subtitleStyle: sanitizeSubtitleStyle(video.subtitleStyle) || defaultSubtitleStyle(),
    audioTrack: sanitizeEnum(video.audioTrack, VIDEO_AUDIO_TRACKS, 'tts'),
    apiUrl: sanitizeUrl(video.apiUrl)
  }
  const appearance = out.appearance && typeof out.appearance === 'object' ? out.appearance : {}
  out.appearance = {
    theme: sanitizeTheme(appearance.theme, DEFAULT_APPEARANCE.theme),
    locale: sanitizeLocale(appearance.locale, DEFAULT_APPEARANCE.locale)
  }
  const storage = out.storage && typeof out.storage === 'object' ? out.storage : {}
  out.storage = { root: sanitizeStorageRoot(storage.root) }
  const control = out.control && typeof out.control === 'object' ? out.control : {}
  out.control = {
    leaseEnabled: sanitizeBool(control.leaseEnabled, DEFAULT_CONTROL_LINK.leaseEnabled),
    baseUrl: sanitizeUrl(control.baseUrl) || DEFAULT_CONTROL_LINK.baseUrl
  }
  return out
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
    const value = withSettingsDefaults(json)
    cache.mtimeMs = Number(st.mtimeMs) || 0
    cache.value = value
    return value
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
  const inTranslation = inObj?.translation
  const inImage = inObj?.image
  const inTts = inObj?.tts
  const inVideo = inObj?.video
  const inAppearance = inObj?.appearance
  const inStorage = inObj?.storage
  const inNet = inObj?.network
  const inSecrets = inObj?.secrets
  const inReview = inObj?.review
  const inControl = inObj?.control

  const next = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    updatedAt: nowIso(),
    enabled: {
      scripts: sanitizeBool(has(inEnabled, 'scripts') ? inEnabled.scripts : prev?.enabled?.scripts, prev?.enabled?.scripts ?? false),
      prompt: sanitizeBool(has(inEnabled, 'prompt') ? inEnabled.prompt : prev?.enabled?.prompt, prev?.enabled?.prompt ?? false),
      image: sanitizeBool(has(inEnabled, 'image') ? inEnabled.image : prev?.enabled?.image, prev?.enabled?.image ?? false),
      tts: sanitizeBool(has(inEnabled, 'tts') ? inEnabled.tts : prev?.enabled?.tts, prev?.enabled?.tts ?? false),
      video: sanitizeBool(has(inEnabled, 'video') ? inEnabled.video : prev?.enabled?.video, prev?.enabled?.video ?? false)
    },
    scripts: {
      provider: has(inScripts, 'provider') ? sanitizeProvider(inScripts.provider) : sanitizeProvider(prev?.scripts?.provider),
      model: has(inScripts, 'model') ? sanitizeModel(inScripts.model) : sanitizeModel(prev?.scripts?.model),
      apiUrl: has(inScripts, 'apiUrl') ? sanitizeUrl(inScripts.apiUrl) : sanitizeUrl(prev?.scripts?.apiUrl)
    },
    prompt: {
      provider: has(inPrompt, 'provider') ? sanitizeProvider(inPrompt.provider) : sanitizeProvider(prev?.prompt?.provider),
      model: has(inPrompt, 'model') ? sanitizeModel(inPrompt.model) : sanitizeModel(prev?.prompt?.model),
      apiUrl: has(inPrompt, 'apiUrl') ? sanitizeUrl(inPrompt.apiUrl) : sanitizeUrl(prev?.prompt?.apiUrl)
    },
    translation: {
      provider: has(inTranslation, 'provider') ? sanitizeProvider(inTranslation.provider) : sanitizeProvider(prev?.translation?.provider),
      model: has(inTranslation, 'model') ? sanitizeModel(inTranslation.model) : sanitizeModel(prev?.translation?.model),
      apiUrl: has(inTranslation, 'apiUrl') ? sanitizeUrl(inTranslation.apiUrl) : sanitizeUrl(prev?.translation?.apiUrl)
    },
    image: {
      provider: has(inImage, 'provider') ? sanitizeProvider(inImage.provider) : sanitizeProvider(prev?.image?.provider),
      model: has(inImage, 'model') ? sanitizeModel(inImage.model) : sanitizeModel(prev?.image?.model),
      loras: has(inImage, 'loras') ? sanitizeStringList(inImage.loras) : sanitizeStringList(prev?.image?.loras),
      apiUrl: has(inImage, 'apiUrl') ? sanitizeUrl(inImage.apiUrl) : sanitizeUrl(prev?.image?.apiUrl),
      size: has(inImage, 'size') ? sanitizeSize(inImage.size) : sanitizeSize(prev?.image?.size),
      sdwebuiBaseUrl: has(inImage, 'sdwebuiBaseUrl') ? sanitizeUrl(inImage.sdwebuiBaseUrl) : sanitizeUrl(prev?.image?.sdwebuiBaseUrl),
      comfyuiBaseUrl: has(inImage, 'comfyuiBaseUrl') ? sanitizeUrl(inImage.comfyuiBaseUrl) : sanitizeUrl(prev?.image?.comfyuiBaseUrl),
      comfyuiModelsRoot: has(inImage, 'comfyuiModelsRoot') ? sanitizeFsPath(inImage.comfyuiModelsRoot) : sanitizeFsPath(prev?.image?.comfyuiModelsRoot),
      // 2026-09-28 出图风格预设（《小猫钓鱼》样本沉淀）：对象原样透传，保存/读取不丢字段
      activeStylePreset: has(inImage, 'activeStylePreset') ? String(inImage.activeStylePreset || '').trim() : (prev?.image?.activeStylePreset ?? undefined),
      stylePresets: (inImage && typeof inImage.stylePresets === 'object' && inImage.stylePresets) ? inImage.stylePresets : prev?.image?.stylePresets
    },
    tts: {
      provider: has(inTts, 'provider') ? sanitizeProvider(inTts.provider) : sanitizeProvider(prev?.tts?.provider),
      model: has(inTts, 'model') ? sanitizeModel(inTts.model) : sanitizeModel(prev?.tts?.model),
      apiUrl: has(inTts, 'apiUrl') ? sanitizeUrl(inTts.apiUrl) : sanitizeUrl(prev?.tts?.apiUrl),
      voice: has(inTts, 'voice') ? sanitizeVoice(inTts.voice) : sanitizeVoice(prev?.tts?.voice),
      speed: has(inTts, 'speed') ? sanitizeSpeed(inTts.speed, 1.0) : sanitizeSpeed(prev?.tts?.speed, 1.0),
      format: has(inTts, 'format') ? sanitizeEnum(inTts.format, TTS_FORMATS, 'mp3') : sanitizeEnum(prev?.tts?.format, TTS_FORMATS, 'mp3')
    },
    // 设置页 V1 新增：视频合成节（ui_设置定义.md §7.7）
    video: {
      provider: has(inVideo, 'provider') ? sanitizeProvider(inVideo.provider) : sanitizeProvider(prev?.video?.provider),
      resolution: has(inVideo, 'resolution') ? sanitizeEnum(inVideo.resolution, VIDEO_RESOLUTIONS, '1080p') : sanitizeEnum(prev?.video?.resolution, VIDEO_RESOLUTIONS, '1080p'),
      fps: has(inVideo, 'fps') ? sanitizeFps(inVideo.fps, 30) : sanitizeFps(prev?.video?.fps, 30),
      bitrate: has(inVideo, 'bitrate') ? sanitizeBitrate(inVideo.bitrate) : sanitizeBitrate(prev?.video?.bitrate),
      subtitleStyle: has(inVideo, 'subtitleStyle')
        ? (sanitizeSubtitleStyle(inVideo.subtitleStyle) || defaultSubtitleStyle())
        : (sanitizeSubtitleStyle(prev?.video?.subtitleStyle) || defaultSubtitleStyle()),
      audioTrack: has(inVideo, 'audioTrack') ? sanitizeEnum(inVideo.audioTrack, VIDEO_AUDIO_TRACKS, 'tts') : sanitizeEnum(prev?.video?.audioTrack, VIDEO_AUDIO_TRACKS, 'tts'),
      apiUrl: has(inVideo, 'apiUrl') ? sanitizeUrl(inVideo.apiUrl) : sanitizeUrl(prev?.video?.apiUrl)
    },
    // 设置页 V1 新增：界面偏好节（§9.1）
    appearance: {
      theme: has(inAppearance, 'theme') ? sanitizeTheme(inAppearance.theme, DEFAULT_APPEARANCE.theme) : sanitizeTheme(prev?.appearance?.theme, DEFAULT_APPEARANCE.theme),
      locale: has(inAppearance, 'locale') ? sanitizeLocale(inAppearance.locale, DEFAULT_APPEARANCE.locale) : sanitizeLocale(prev?.appearance?.locale, DEFAULT_APPEARANCE.locale)
    },
    // 设置页 V1 新增：存储节（§9.2；root 可空=默认仓内 storage/）
    storage: {
      root: has(inStorage, 'root') ? sanitizeStorageRoot(inStorage.root) : sanitizeStorageRoot(prev?.storage?.root)
    },
    // 2026-10-20 守护台关联节：租约运行时开关 + 守护台地址（env 显式设定时优先，见 resourceLease.js）
    control: {
      leaseEnabled: sanitizeBool(has(inControl, 'leaseEnabled') ? inControl.leaseEnabled : prev?.control?.leaseEnabled, prev?.control?.leaseEnabled ?? DEFAULT_CONTROL_LINK.leaseEnabled),
      baseUrl: has(inControl, 'baseUrl') ? (sanitizeUrl(inControl.baseUrl) || DEFAULT_CONTROL_LINK.baseUrl) : (sanitizeUrl(prev?.control?.baseUrl) || DEFAULT_CONTROL_LINK.baseUrl)
    },
    // AUTO-E05：完整度核实的视觉评审模型（moonshot / omlx），缺省走环境默认
    review: {
      provider: has(inReview, 'provider') ? sanitizeProvider(inReview.provider) : sanitizeProvider(prev?.review?.provider),
      model: has(inReview, 'model') ? sanitizeModel(inReview.model) : sanitizeModel(prev?.review?.model),
      apiUrl: has(inReview, 'apiUrl') ? sanitizeUrl(inReview.apiUrl) : sanitizeUrl(prev?.review?.apiUrl),
      // 2026-10-20 修复：poseReview* 此前不在白名单，任何一次保存都会被丢弃（getEffectiveStudioConfig 在读它们）
      poseReviewProvider: has(inReview, 'poseReviewProvider') ? sanitizeProvider(inReview.poseReviewProvider) : sanitizeProvider(prev?.review?.poseReviewProvider),
      poseReviewModel: has(inReview, 'poseReviewModel') ? sanitizeModel(inReview.poseReviewModel) : sanitizeModel(prev?.review?.poseReviewModel),
      poseReviewBaseUrl: has(inReview, 'poseReviewBaseUrl') ? sanitizeUrl(inReview.poseReviewBaseUrl) : sanitizeUrl(prev?.review?.poseReviewBaseUrl)
    },
    secrets: {
      openaiApiKey: has(inSecrets, 'openaiApiKey') ? sanitizeSecret(inSecrets.openaiApiKey) : sanitizeSecret(prev?.secrets?.openaiApiKey),
      localoxmlApiKey: has(inSecrets, 'localoxmlApiKey') ? sanitizeSecret(inSecrets.localoxmlApiKey) : sanitizeSecret(prev?.secrets?.localoxmlApiKey),
      doubaoArkApiKey: has(inSecrets, 'doubaoArkApiKey') ? sanitizeSecret(inSecrets.doubaoArkApiKey) : sanitizeSecret(prev?.secrets?.doubaoArkApiKey)
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

// 2026-10-20 守护台关联：同步读取 control 节（readFileSync + mtime 缓存，容错回默认）。
// 供 resourceLease.js 等同步路径使用（租约开关判定在 choke point 热路径上，不能 async）。
const controlLinkCache = { mtimeMs: 0, root: '', value: null }
export function readControlLinkSync(storageRoot) {
  const fallback = { ...DEFAULT_CONTROL_LINK }
  try {
    const p = studioSettingsFilePath(storageRoot)
    const st = statSync(p)
    if (controlLinkCache.value && controlLinkCache.root === String(storageRoot) && Number(st.mtimeMs) === controlLinkCache.mtimeMs) {
      return controlLinkCache.value
    }
    const json = JSON.parse(readFileSync(p, 'utf-8'))
    const c = json && typeof json === 'object' && json.control && typeof json.control === 'object' ? json.control : {}
    const value = {
      leaseEnabled: sanitizeBool(c.leaseEnabled, DEFAULT_CONTROL_LINK.leaseEnabled),
      baseUrl: sanitizeUrl(c.baseUrl) || DEFAULT_CONTROL_LINK.baseUrl
    }
    controlLinkCache.mtimeMs = Number(st.mtimeMs) || 0
    controlLinkCache.root = String(storageRoot)
    controlLinkCache.value = value
    return value
  } catch (_) {
    return fallback
  }
}

function maskKey(v) {
  const s = String(v || '').trim()
  if (!s) return null
  const tail = s.slice(-4)
  return `****${tail}`
}

function normalizeSecretStr(v) {
  const s = String(v || '').trim()
  return s ? s.replace(/\r?\n/g, '').slice(0, 512) : ''
}

function pickSecret({ settingsValue, envValue }) {
  const a = normalizeSecretStr(settingsValue)
  if (a) return { value: a, source: 'settings' }
  const b = normalizeSecretStr(envValue)
  if (b) return { value: b, source: 'env' }
  return { value: '', source: 'none' }
}

export function redactStudioSettingsForClient(settings) {
  const s = settings && typeof settings === 'object' ? settings : null
  if (!s) return null
  // Do not leak raw secrets to the browser. UI should use `effective.secrets` (masked).
  const out = { ...s }
  if (out.secrets && typeof out.secrets === 'object') {
    out.secrets = {
      openaiApiKey: null,
      localoxmlApiKey: null,
      doubaoArkApiKey: null
    }
  }
  return out
}

export function redactEffectiveStudioConfigForClient(effective) {
  const e = effective && typeof effective === 'object' ? effective : null
  if (!e) return null
  const out = {
    ...e,
    secrets: e.secrets && typeof e.secrets === 'object'
      ? Object.fromEntries(Object.entries(e.secrets).map(([key, value]) => {
        const item = value && typeof value === 'object' ? value : {}
        return [key, {
          present: Boolean(item.present),
          masked: item.masked || null,
          source: item.source || 'none'
        }]
      }))
      : {}
  }
  return out
}

export async function getEffectiveStudioConfig(storageRoot, options = null) {
  const override = options && typeof options === 'object' ? options.settingsOverride : null
  const settings = (override && typeof override === 'object' ? override : ((await readStudioSettings(storageRoot)) || null))
  const DEFAULT_DOUBAO_TEXT_MODEL = 'doubao-1-5-pro-32k-250115'
  const DEFAULT_OLLAMA_TEXT_MODEL = 'qwen3:8b'

  const env = {
    aiProvider: String(process.env.STUDIO_AI_PROVIDER || 'local').toLowerCase(),
    aiModel: String(process.env.STUDIO_AI_MODEL || '').trim(),
    localoxmlModel: String(process.env.LOCALOXML_MODEL || process.env.STUDIO_AI_MODEL || '').trim(),
    localoxmlBaseUrl: String(process.env.LOCALOXML_BASE_URL || process.env.STUDIO_AI_BASE_URL || '').trim(),
    openaiModel: String(process.env.OPENAI_MODEL || '').trim(),
    openaiBaseUrl: String(process.env.OPENAI_BASE_URL || '').trim(),
    bgProvider: String(process.env.STUDIO_BG_PROVIDER || 'comfyui').toLowerCase(),
    sdwebuiBaseUrl: String(process.env.SDWEBUI_BASE_URL || 'http://127.0.0.1:7860').trim(),
    comfyuiBaseUrl: String(process.env.COMFYUI_BASE_URL || DEFAULT_COMFYUI_BASE_URL).trim(),
    comfyuiModelsRoot: String(process.env.STUDIO_COMFYUI_MODELS_ROOT || process.env.COMFYUI_MODELS_ROOT || DEFAULT_COMFYUI_MODELS_ROOT).trim(),
    comfyuiModel: String(process.env.STUDIO_COMFYUI_MODEL || process.env.COMFYUI_MODEL || DEFAULT_COMFYUI_SDXL_MODEL).trim(),
    doubaoImagesUrl: envFirst('DOUBAO_ARK_IMAGES_URL', 'DOUBAO_ARK_API_URL'),
    doubaoTextUrl: envFirst('DOUBAO_ARK_CHAT_URL', 'DOUBAO_ARK_TEXT_URL'),
    doubaoImagesModel: String(process.env.DOUBAO_ARK_MODEL || '').trim(),
    doubaoTextModel: String(envFirst('DOUBAO_ARK_TEXT_MODEL', 'DOUBAO_ARK_LLM_MODEL', 'DOUBAO_LLM_MODEL') || '').trim(),
    doubaoImageSize: String(process.env.DOUBAO_IMAGE_SIZE || '').trim(),
    ollamaBaseUrl: String(envFirst('STUDIO_OLLAMA_URL', 'OLLAMA_HOST', 'OLLAMA_URL') || '').trim(),
    ollamaTextModel: String(envFirst('STUDIO_OLLAMA_MODEL', 'OLLAMA_MODEL') || '').trim(),
    proxyUrl: envFirst('STUDIO_PROXY_URL', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY')
  }

  const secretsOpenaiEnv = String(process.env.OPENAI_API_KEY || '').trim()
  const secretsLocalOxmlEnv = String(process.env.LOCALOXML_API_KEY || process.env.STUDIO_AI_API_KEY || process.env.OPENAI_API_KEY || '').trim()
  const secretsDoubaoEnv = String(process.env.DOUBAO_ARK_API_KEY || process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY || '').trim()

  const secretsOpenai = pickSecret({ settingsValue: settings?.secrets?.openaiApiKey, envValue: secretsOpenaiEnv })
  const secretsLocaloxml = pickSecret({ settingsValue: settings?.secrets?.localoxmlApiKey, envValue: secretsLocalOxmlEnv })
  const secretsDoubao = pickSecret({ settingsValue: settings?.secrets?.doubaoArkApiKey, envValue: secretsDoubaoEnv })

  // Keep a process-global secret store for provider modules (do not expose raw values via APIs).
  setStudioSecrets({
    openaiApiKey: secretsOpenai.value,
    localoxmlApiKey: secretsLocaloxml.value,
    doubaoArkApiKey: secretsDoubao.value
  })

  const enabled = {
    scripts: settings ? settings?.enabled?.scripts !== false : false,
    prompt: settings ? settings?.enabled?.prompt !== false : false,
    image: settings ? settings?.enabled?.image !== false : false,
    tts: settings?.enabled?.tts === true,
    video: settings?.enabled?.video === true
  }

  const scriptsProvider = (settings?.scripts?.provider ? String(settings.scripts.provider) : 'none') || 'none'
  const scriptsModel = settings?.scripts?.model
    ? String(settings.scripts.model)
    : scriptsProvider === 'openai'
      ? (env.openaiModel || 'gpt-4o-mini')
      : scriptsProvider === 'localoxml'
        ? env.localoxmlModel
      : scriptsProvider === 'ollama'
        ? (env.ollamaTextModel || DEFAULT_OLLAMA_TEXT_MODEL)
        : scriptsProvider === 'doubao'
          ? (env.doubaoTextModel || DEFAULT_DOUBAO_TEXT_MODEL)
          : null
  const scriptsApiUrl = settings?.scripts?.apiUrl
    ? String(settings.scripts.apiUrl)
    : scriptsProvider === 'localoxml'
      ? env.localoxmlBaseUrl
      : scriptsProvider === 'openai'
        ? env.openaiBaseUrl
        : scriptsProvider === 'ollama'
          ? env.ollamaBaseUrl
          : scriptsProvider === 'doubao'
            ? env.doubaoTextUrl
            : null

  const promptProvider = (settings?.prompt?.provider ? String(settings.prompt.provider) : 'none') || 'none'
  const promptModel = settings?.prompt?.model
    ? String(settings.prompt.model)
    : promptProvider === 'openai'
      ? (env.openaiModel || 'gpt-4o-mini')
      : promptProvider === 'localoxml'
        ? env.localoxmlModel
      : promptProvider === 'ollama'
        ? (env.ollamaTextModel || DEFAULT_OLLAMA_TEXT_MODEL)
        : promptProvider === 'doubao'
          ? (env.doubaoTextModel || DEFAULT_DOUBAO_TEXT_MODEL)
          : null
  const promptApiUrl = settings?.prompt?.apiUrl
    ? String(settings.prompt.apiUrl)
    : promptProvider === 'localoxml'
      ? env.localoxmlBaseUrl
      : promptProvider === 'openai'
        ? env.openaiBaseUrl
        : promptProvider === 'ollama'
          ? env.ollamaBaseUrl
          : promptProvider === 'doubao'
            ? env.doubaoTextUrl
            : null

  const translationProvider = (settings?.translation?.provider ? String(settings.translation.provider) : promptProvider || 'none') || 'none'
  const translationModel = settings?.translation?.model
    ? String(settings.translation.model)
    : translationProvider === 'openai'
      ? (env.openaiModel || 'gpt-4o-mini')
      : translationProvider === 'localoxml'
        ? env.localoxmlModel
      : translationProvider === 'ollama'
        ? (env.ollamaTextModel || DEFAULT_OLLAMA_TEXT_MODEL)
        : translationProvider === 'doubao'
          ? (env.doubaoTextModel || DEFAULT_DOUBAO_TEXT_MODEL)
          : promptModel
  const translationApiUrl = settings?.translation?.apiUrl
    ? String(settings.translation.apiUrl)
    : translationProvider === 'localoxml'
      ? env.localoxmlBaseUrl
      : translationProvider === 'openai'
        ? env.openaiBaseUrl
        : translationProvider === 'ollama'
          ? env.ollamaBaseUrl
          : translationProvider === 'doubao'
            ? env.doubaoTextUrl
            : promptApiUrl

  const imageProvider = (settings?.image?.provider ? String(settings.image.provider) : 'none') || 'none'
  const imageModel = settings?.image?.model ? String(settings.image.model) : (imageProvider === 'comfyui' ? env.comfyuiModel : env.doubaoImagesModel)
  const imageLoras = Array.isArray(settings?.image?.loras) ? settings.image.loras.map((x) => String(x || '').trim()).filter(Boolean) : []
  const imageApiUrl = settings?.image?.apiUrl ? String(settings.image.apiUrl) : env.doubaoImagesUrl
  const imageSize = settings?.image?.size ? String(settings.image.size) : (imageProvider === 'comfyui' ? DEFAULT_COMFYUI_SDXL_SIZE : env.doubaoImageSize)
  const sdwebuiBaseUrl = settings?.image?.sdwebuiBaseUrl ? String(settings.image.sdwebuiBaseUrl) : env.sdwebuiBaseUrl
  const comfyuiBaseUrl = settings?.image?.comfyuiBaseUrl ? String(settings.image.comfyuiBaseUrl) : env.comfyuiBaseUrl
  const comfyuiModelsRoot = settings?.image?.comfyuiModelsRoot ? String(settings.image.comfyuiModelsRoot) : env.comfyuiModelsRoot

  const proxyUrl = settings?.network?.proxyUrl ? String(settings.network.proxyUrl) : env.proxyUrl

  const effective = {
    enabled,
    scripts: { provider: scriptsProvider, model: scriptsModel || null, apiUrl: scriptsApiUrl || null },
    prompt: { provider: promptProvider, model: promptModel || null, apiUrl: promptApiUrl || null },
    translation: { provider: translationProvider, model: translationModel || null, apiUrl: translationApiUrl || null },
    image: {
      provider: imageProvider,
      model: imageModel || null,
      loras: imageLoras.length ? imageLoras : null,
      apiUrl: imageApiUrl || null,
      size: imageSize || null,
      sdwebuiBaseUrl: sdwebuiBaseUrl || null,
      comfyuiBaseUrl: comfyuiBaseUrl || null,
      comfyuiModelsRoot: (comfyuiModelsRoot && path.isAbsolute(comfyuiModelsRoot)) ? comfyuiModelsRoot : null,
      // 2026-09-28 出图风格预设透传（提示词/LoRA/尺寸构建端消费）
      activeStylePreset: settings?.image?.activeStylePreset ? String(settings.image.activeStylePreset).trim() || null : null,
      stylePresets: (settings?.image?.stylePresets && typeof settings.image.stylePresets === 'object') ? settings.image.stylePresets : null
    },
    tts: {
      provider: settings?.tts?.provider ? String(settings.tts.provider) : 'none',
      model: settings?.tts?.model ? String(settings.tts.model) : null,
      apiUrl: settings?.tts?.apiUrl ? String(settings.tts.apiUrl) : null,
      voice: settings?.tts?.voice ? String(settings.tts.voice) : null,
      speed: sanitizeSpeed(settings?.tts?.speed, 1.0),
      format: sanitizeEnum(settings?.tts?.format, TTS_FORMATS, 'mp3')
    },
    // 设置页 V1：视频合成/界面偏好/存储节透出（读取侧已默认回填，此处再兜底一次）
    video: {
      provider: settings?.video?.provider ? String(settings.video.provider) : 'none',
      resolution: sanitizeEnum(settings?.video?.resolution, VIDEO_RESOLUTIONS, '1080p'),
      fps: sanitizeFps(settings?.video?.fps, 30),
      bitrate: sanitizeBitrate(settings?.video?.bitrate),
      subtitleStyle: sanitizeSubtitleStyle(settings?.video?.subtitleStyle) || defaultSubtitleStyle(),
      audioTrack: sanitizeEnum(settings?.video?.audioTrack, VIDEO_AUDIO_TRACKS, 'tts'),
      apiUrl: settings?.video?.apiUrl ? String(settings.video.apiUrl) : null
    },
    appearance: {
      theme: sanitizeTheme(settings?.appearance?.theme, DEFAULT_APPEARANCE.theme),
      locale: sanitizeLocale(settings?.appearance?.locale, DEFAULT_APPEARANCE.locale)
    },
    storage: {
      root: sanitizeStorageRoot(settings?.storage?.root)
    },
    control: {
      leaseEnabled: settings?.control?.leaseEnabled !== false,
      baseUrl: sanitizeUrl(settings?.control?.baseUrl) || DEFAULT_CONTROL_LINK.baseUrl
    },
    // AUTO-E05：完整度核实视觉评审模型。默认 moonshot/kimi-for-coding；
    // 选 omlx（本地视觉模型）时默认指向 OMLX 端点与 Qwen3.6-27B。
    review: {
      provider: settings?.review?.provider ? String(settings.review.provider).toLowerCase() : 'moonshot',
      model: settings?.review?.model
        ? String(settings.review.model)
        : (String(settings?.review?.provider || '').toLowerCase() === 'omlx' ? (env.localoxmlModel || 'Qwen3.6-27B-4bit') : 'kimi-for-coding'),
      apiUrl: settings?.review?.apiUrl
        ? String(settings.review.apiUrl)
        : (String(settings?.review?.provider || '').toLowerCase() === 'omlx' ? (env.localoxmlBaseUrl || 'http://127.0.0.1:18888/v1') : (String(process.env.MOONSHOT_BASE_URL || '').trim() || 'https://api.kimi.com/coding/v1')),
      // 2026-09-08 姿势一致性评审 provider 开关（Kimi 周配额耗尽时切本地视觉模型 gemma，实测多模态可用）：
      // poseReviewProvider: auto/kimi/local_vl/off；poseReviewModel/poseReviewBaseUrl 仅在 local_vl 时生效
      poseReviewProvider: settings?.review?.poseReviewProvider ? String(settings.review.poseReviewProvider).toLowerCase() : null,
      poseReviewModel: settings?.review?.poseReviewModel ? String(settings.review.poseReviewModel) : null,
      poseReviewBaseUrl: settings?.review?.poseReviewBaseUrl ? String(settings.review.poseReviewBaseUrl) : null
    },
    secrets: {
      openai: { present: Boolean(secretsOpenai.value), masked: maskKey(secretsOpenai.value), source: secretsOpenai.source, value: secretsOpenai.value || null },
      localoxml: { present: Boolean(secretsLocaloxml.value), masked: maskKey(secretsLocaloxml.value), source: secretsLocaloxml.source, value: secretsLocaloxml.value || null },
      doubao: { present: Boolean(secretsDoubao.value), masked: maskKey(secretsDoubao.value), source: secretsDoubao.source, value: secretsDoubao.value || null }
    },
    network: { proxyUrl: proxyUrl || null }
  }

  return { settings, effective, env }
}
