// 设置页共享模块（ui_设置定义.md §11 settings/settingsApi.ts）：
// 设置读写经 server（不落前端缓存），此处仅做 API 再导出与纯函数移植。
// 模型记忆 / URL 记忆为 UI 便利记忆（沿用 StudioSettingsModal 已验证行为，存 localStorage），不含任何 Key。
import {
  diagnoseStudio,
  getControlLink,
  getSdwebuiModels,
  getStorageInfo,
  getStudioImageModels,
  getStudioSettings,
  getTtsVoices,
  preflightStudioImage,
  previewTts,
  saveStudioSettings
} from '../api'
import type { StudioControlLink, StudioEffectiveConfig, StudioSettings, StudioStorageInfo, TtsPreviewResult, TtsVoiceGroup, TtsVoiceItem } from '../api'

export { diagnoseStudio, getControlLink, getSdwebuiModels, getStorageInfo, getStudioImageModels, getStudioSettings, getTtsVoices, preflightStudioImage, previewTts, saveStudioSettings }
export type { StudioControlLink, StudioEffectiveConfig, StudioSettings, StudioStorageInfo, TtsPreviewResult, TtsVoiceGroup, TtsVoiceItem }

export type SecretField = 'openaiApiKey' | 'localoxmlApiKey' | 'doubaoArkApiKey'
export type SecretDraft = Record<SecretField, string>
export type SecretDirtyState = Record<SecretField, boolean>
export type ModelMemoryEntry = string | string[]
export type ModelSection = 'scripts' | 'prompt' | 'translation' | 'image'
export type TextSection = 'scripts' | 'prompt' | 'translation'
export type ModelMemory = Record<ModelSection, Record<string, ModelMemoryEntry>>
export type UrlMemory = Record<TextSection, Record<string, string>>

export const SECRET_LABELS: Record<SecretField, string> = {
  openaiApiKey: 'OpenAI Key',
  localoxmlApiKey: 'localoxml Key',
  doubaoArkApiKey: 'Doubao Key'
}

// 2026-10-20 任务A：测试连接内联结果（卡片按钮下方成功绿/失败红+原因与建议）
export type ServiceTestResult = { ok: boolean; note: string; at: number }

// 设置页宿主接口：SettingsPage 实现一次，各卡片经 props 取用（避免逐层重写既有逻辑）。
export interface SettingsHost {
  draft: StudioSettings
  effective: StudioEffectiveConfig | null
  settingsRaw: StudioSettings | null
  testingService: string
  diagnostics: any
  modelMemory: ModelMemory
  urlMemory: UrlMemory
  storageInfo: StudioStorageInfo | null
  serviceTestResults: Record<string, ServiceTestResult>
  patchSection: (
    section: 'scripts' | 'prompt' | 'translation' | 'image' | 'tts' | 'video' | 'review' | 'appearance' | 'storage' | 'network' | 'control',
    patch: Record<string, any>
  ) => void
  setEnabled: (key: 'scripts' | 'prompt' | 'image' | 'tts' | 'video', v: boolean) => void
  rememberModel: (section: ModelSection, provider: string, model: string) => void
  forgetModel: (section: ModelSection, provider: string, model: string) => void
  rememberUrl: (section: TextSection, provider: string, apiUrl: string) => void
  runServiceDiagnose: (service: TextSection | 'image' | 'review') => void
  recordServiceTestResult: (service: string, result: ServiceTestResult) => void
  clearServiceTestResult: (service: string) => void
  buildSettingsWithSecrets: () => StudioSettings
  applyAppearance: (appearance: StudioSettings['appearance']) => void
  appendLog: (msg: string) => void
}

function safeBool(v: any, fallback: boolean) {
  return typeof v === 'boolean' ? v : fallback
}

export function clampTtsSpeed(v: any, fallback = 1.0) {
  if (v == null || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0.5, Math.min(2.0, Math.round(n * 100) / 100))
}

export function normalizeBitrateDraft(v: any): 'auto' | number {
  if (v == null || v === '') return 'auto'
  const s = String(v).trim().toLowerCase()
  if (s === 'auto') return 'auto'
  const n = Math.round(Number(s))
  return Number.isFinite(n) && n > 0 ? n : 'auto'
}

export function normalizeSubtitleStyleDraft(v: any): { fontSize: number; position: string; bgOpacity: number } {
  const src = v && typeof v === 'object' ? v : {}
  const fontSize = Number(src.fontSize)
  const bgOpacity = Number(src.bgOpacity)
  const position = String(src.position || '').trim().toLowerCase()
  return {
    fontSize: Number.isFinite(fontSize) ? Math.max(8, Math.min(120, Math.round(fontSize))) : 24,
    position: position === 'top' ? 'top' : 'bottom',
    bgOpacity: Number.isFinite(bgOpacity) ? Math.max(0, Math.min(1, Math.round(bgOpacity * 100) / 100)) : 0.6
  }
}

// 由 server 返回的 settings 归一化为页面草稿（移植自 StudioSettingsModal.normalizeDraft，扩展新节）。
// translation.provider 空串 = 跟随图像提示词（ui_设置定义.md §8 翻译跟随）。
export function normalizeSettingsDraft(settings: StudioSettings | null): StudioSettings {
  const s = settings && typeof settings === 'object' ? settings : {}
  return {
    enabled: {
      scripts: safeBool(s.enabled?.scripts, false),
      prompt: safeBool(s.enabled?.prompt, false),
      image: safeBool(s.enabled?.image, false),
      tts: safeBool(s.enabled?.tts, false),
      video: safeBool(s.enabled?.video, false)
    },
    scripts: { provider: s.scripts?.provider || 'none', model: s.scripts?.model || '', apiUrl: s.scripts?.apiUrl || '' },
    prompt: { provider: s.prompt?.provider || 'none', model: s.prompt?.model || '', apiUrl: s.prompt?.apiUrl || '' },
    translation: {
      provider: s.translation?.provider || '',
      model: s.translation?.model || '',
      apiUrl: s.translation?.apiUrl || ''
    },
    image: {
      provider: s.image?.provider || 'none',
      model: s.image?.model || '',
      loras: Array.isArray(s.image?.loras) ? s.image.loras.map((x: any) => String(x || '')).filter(Boolean) : [],
      apiUrl: s.image?.apiUrl || '',
      size: s.image?.size || '',
      sdwebuiBaseUrl: s.image?.sdwebuiBaseUrl || '',
      comfyuiBaseUrl: s.image?.comfyuiBaseUrl || '',
      comfyuiModelsRoot: s.image?.comfyuiModelsRoot || '',
      activeStylePreset: s.image?.activeStylePreset || '',
      stylePresets: s.image?.stylePresets && typeof s.image.stylePresets === 'object' ? s.image.stylePresets : {}
    },
    tts: {
      provider: s.tts?.provider || '',
      model: s.tts?.model || '',
      apiUrl: s.tts?.apiUrl || '',
      voice: s.tts?.voice || '',
      speed: clampTtsSpeed(s.tts?.speed, 1.0),
      format: s.tts?.format === 'wav' ? 'wav' : 'mp3'
    },
    video: {
      provider: s.video?.provider || 'none',
      resolution: ['720p', '1080p', '1080x1920'].includes(String(s.video?.resolution || '')) ? String(s.video?.resolution) : '1080p',
      fps: Number(s.video?.fps) === 24 ? 24 : 30,
      bitrate: normalizeBitrateDraft(s.video?.bitrate),
      subtitleStyle: normalizeSubtitleStyleDraft(s.video?.subtitleStyle),
      audioTrack: s.video?.audioTrack === 'none' ? 'none' : 'tts',
      apiUrl: s.video?.apiUrl || ''
    },
    appearance: { theme: s.appearance?.theme || 'dark', locale: s.appearance?.locale || 'zh-CN' },
    storage: { root: s.storage?.root || '' },
    control: {
      leaseEnabled: safeBool(s.control?.leaseEnabled, true),
      baseUrl: s.control?.baseUrl || 'http://127.0.0.1:2099'
    },
    // AUTO-E05：完整度核实视觉评审模型（moonshot / omlx）+ 姿势评审独立通道
    review: {
      provider: s.review?.provider || 'moonshot',
      model: s.review?.model || '',
      apiUrl: s.review?.apiUrl || '',
      poseReviewProvider: s.review?.poseReviewProvider || 'auto',
      poseReviewModel: s.review?.poseReviewModel || '',
      poseReviewBaseUrl: s.review?.poseReviewBaseUrl || ''
    },
    secrets: {
      openaiApiKey: s.secrets?.openaiApiKey || '',
      localoxmlApiKey: s.secrets?.localoxmlApiKey || '',
      doubaoArkApiKey: s.secrets?.doubaoArkApiKey || ''
    },
    network: { proxyUrl: s.network?.proxyUrl || '' }
  }
}

// 脏态快照：secrets 走独立自动保存，不参与主草稿脏态比较。
export function snapshotSettingsDraft(draft: StudioSettings): string {
  const { secrets: _secrets, ...rest } = draft
  return JSON.stringify(rest)
}

export function withImageDefaults(img: StudioSettings['image']) {
  const inImg = img || {}
  const provider = String(inImg.provider || '').trim().toLowerCase()
  const next = { ...inImg }
  if (!next.size) next.size = '1024x1024'
  if (!Array.isArray(next.loras)) next.loras = []
  if (provider === 'sdwebui') {
    if (!next.sdwebuiBaseUrl) next.sdwebuiBaseUrl = 'http://127.0.0.1:7860'
  } else if (provider === 'comfyui') {
    if (!next.comfyuiBaseUrl) next.comfyuiBaseUrl = 'http://127.0.0.1:8188'
    if (next.model) next.model = normalizeComfyModelName(next.model)
    if (!next.comfyuiModelsRoot) next.comfyuiModelsRoot = ''
  } else if (provider === 'doubao') {
    if (!next.apiUrl) next.apiUrl = 'https://ark.cn-beijing.volces.com/api/v3/images/generations'
  }
  return next
}

const MODEL_MEMORY_KEY = 'studio.model.memory.v1'
const URL_MEMORY_KEY = 'studio.url.memory.v1'
export const OPENAI_MODEL_PRESETS = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4o-mini']
export const SDWEBUI_MODEL_PRESETS = [
  'ivisionIllustration_ivision10.safetensors',
  'sd_xl_base_1.0.safetensors',
  'hellocartoonfilm_V30p.safetensors [a606a40b56]',
  'meinapastel_v6Pastel.safetensors [4679331655]',
  'nigi3d_v20.safetensors [4cb6bd041b]',
  'svd_xt.safetensors'
]

export function textProviderModelPlaceholder(provider: string | null | undefined) {
  const p = String(provider || '').trim().toLowerCase()
  if (p === 'localoxml') return '如 gemma4 / Qwen3.5-27B-Claude-4.6-Opus-Distilled-MLX-4bit'
  if (p === 'openai') return '如 gpt-5 / gpt-5-mini / gpt-5-nano / gpt-4o-mini'
  if (p === 'doubao') return '如 doubao-1-5-pro-32k-250115'
  if (p === 'ollama') return '如 qwen3:8b / qwen3.5:27b'
  return '可留空'
}

export function textProviderUrlMeta(provider: string | null | undefined) {
  const p = String(provider || '').trim().toLowerCase()
  if (p === 'localoxml') {
    return { label: 'OXML URL', placeholder: 'http://127.0.0.1:18888 或 http://127.0.0.1:18888/v1' }
  }
  if (p === 'ollama') {
    return { label: 'Ollama URL', placeholder: 'http://127.0.0.1:11434' }
  }
  if (p === 'openai') {
    return { label: 'Base URL', placeholder: 'https://api.openai.com/v1' }
  }
  if (p === 'doubao') {
    return { label: '接口 URL', placeholder: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions' }
  }
  return null
}

export function normalizeComfyModelName(v: string | null | undefined) {
  return String(v || '').trim().replace(/\s+\[[^\]]+\]\s*$/, '').trim()
}

export function normalizeModelOption(v: any, provider: string) {
  const p = String(provider || '').toLowerCase()
  const s0 = String(v || '').trim()
  if (!s0) return ''
  const s = p === 'comfyui' ? normalizeComfyModelName(s0) : s0
  if (!s) return ''
  if (s.includes(',')) return ''
  if (/^\[object\s+object\]$/i.test(s)) return ''
  if (/^\{.*\}$/.test(s)) return ''
  if (p === 'comfyui') {
    if (!/\.(safetensors|ckpt|pt|pth)$/i.test(s)) return ''
  }
  return s
}

export function readCurrentModel(v: any) {
  return v && typeof v === 'object' && 'currentModel' in v ? String((v as any).currentModel || '') : ''
}

export function emptyModelMemory(): ModelMemory {
  return { scripts: {}, prompt: {}, translation: {}, image: {} }
}

export function emptyUrlMemory(): UrlMemory {
  return { scripts: {}, prompt: {}, translation: {} }
}

export function providerKey(v: string | null | undefined) {
  const s = String(v || '').trim().toLowerCase()
  return s || '__default'
}

export function defaultTextProviderApiUrl(provider: string | null | undefined) {
  const p = String(provider || '').trim().toLowerCase()
  if (p === 'openai') return 'https://api.openai.com/v1'
  if (p === 'localoxml') return 'http://127.0.0.1:18888/v1'
  if (p === 'ollama') return 'http://127.0.0.1:11434'
  if (p === 'doubao') return 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
  return ''
}

export function defaultModelBySectionProvider(section: ModelSection, provider: string, effective: StudioEffectiveConfig | null) {
  const p = String(provider || '').trim().toLowerCase()
  if (!p) {
    if (!effective) return ''
    if (section === 'scripts') return String(effective.scripts?.model || '')
    if (section === 'prompt') return String(effective.prompt?.model || '')
    if (section === 'translation') return String(effective.translation?.model || effective.prompt?.model || '')
    return String(effective.image?.model || '')
  }
  if (section === 'scripts' || section === 'prompt' || section === 'translation') {
    if (p === 'openai') return 'gpt-5-mini'
    if (p === 'localoxml') {
      if (!effective) return ''
      if (section === 'scripts') return String(effective.scripts?.model || '')
      if (section === 'translation') return String(effective.translation?.model || effective.prompt?.model || '')
      return String(effective.prompt?.model || '')
    }
    if (p === 'doubao') return 'doubao-1-5-pro-32k-250115'
    if (p === 'ollama') return 'qwen3:8b'
    return ''
  }
  if (section === 'image') {
    if (p === 'doubao') return 'doubao-seedream-5-0-260128'
    return ''
  }
  return ''
}

export function loadModelMemory(): ModelMemory {
  if (typeof window === 'undefined') return emptyModelMemory()
  try {
    const raw = window.localStorage.getItem(MODEL_MEMORY_KEY)
    if (!raw) return emptyModelMemory()
    const json = JSON.parse(raw) as any
    return {
      scripts: json && typeof json.scripts === 'object' ? json.scripts : {},
      prompt: json && typeof json.prompt === 'object' ? json.prompt : {},
      translation: json && typeof json.translation === 'object' ? json.translation : {},
      image: json && typeof json.image === 'object' ? json.image : {}
    }
  } catch (_) {
    return emptyModelMemory()
  }
}

export function persistModelMemory(memory: ModelMemory) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(MODEL_MEMORY_KEY, JSON.stringify(memory))
  } catch (_) {}
}

export function loadUrlMemory(): UrlMemory {
  if (typeof window === 'undefined') return emptyUrlMemory()
  try {
    const raw = window.localStorage.getItem(URL_MEMORY_KEY)
    if (!raw) return emptyUrlMemory()
    const json = JSON.parse(raw) as any
    return {
      scripts: json && typeof json.scripts === 'object' ? json.scripts : {},
      prompt: json && typeof json.prompt === 'object' ? json.prompt : {},
      translation: json && typeof json.translation === 'object' ? json.translation : {}
    }
  } catch (_) {
    return emptyUrlMemory()
  }
}

export function persistUrlMemory(memory: UrlMemory) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(URL_MEMORY_KEY, JSON.stringify(memory))
  } catch (_) {}
}

export function normalizeRememberedModelList(v: any) {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? [v] : []
  const seen = new Set<string>()
  const list: string[] = []
  for (const item of raw) {
    const s = String(item || '').trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    list.push(s)
  }
  return list
}

export function addRememberedModel(listLike: any, model: string | null | undefined) {
  const current = normalizeRememberedModelList(listLike)
  const next = String(model || '').trim()
  if (!next) return current
  return [next, ...current.filter((item) => item !== next)].slice(0, 12)
}

export function removeRememberedModelEntry(listLike: any, model: string | null | undefined) {
  const target = String(model || '').trim()
  if (!target) return normalizeRememberedModelList(listLike)
  return normalizeRememberedModelList(listLike).filter((item) => item !== target)
}

export function getRememberedModelList(memory: ModelMemory, section: ModelSection, provider: string | null | undefined) {
  return normalizeRememberedModelList((memory[section] || {})[providerKey(provider)])
}

export function getRememberedModelValue(memory: ModelMemory, section: ModelSection, provider: string | null | undefined) {
  return getRememberedModelList(memory, section, provider)[0] || ''
}

export function getOllamaModelOptions(memory: ModelMemory, section: TextSection, provider: string | null | undefined, current: string | null | undefined) {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of [...getRememberedModelList(memory, section, provider), String(current || '').trim()]) {
    const v = String(item || '').trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

export function isOpenAIPresetModel(v: string | null | undefined) {
  const s = String(v || '').trim()
  return OPENAI_MODEL_PRESETS.includes(s)
}

export function isLikelyInvalidOpenAIModel(v: string | null | undefined) {
  const s = String(v || '').trim()
  if (!s) return false
  if (OPENAI_MODEL_PRESETS.includes(s)) return false
  if (/^gpt-5\.\d/i.test(s)) return true
  if (/^gpt-5\.0/i.test(s)) return true
  return false
}

export function emptySecretDraft(): SecretDraft {
  return { openaiApiKey: '', localoxmlApiKey: '', doubaoArkApiKey: '' }
}

export function emptySecretDirtyState(): SecretDirtyState {
  return { openaiApiKey: false, localoxmlApiKey: false, doubaoArkApiKey: false }
}

export function hasDirtySecrets(state: SecretDirtyState) {
  return Boolean(state.openaiApiKey || state.localoxmlApiKey || state.doubaoArkApiKey)
}

export function getEffectiveSecretDraft(effective: StudioEffectiveConfig | null): SecretDraft {
  return {
    openaiApiKey: String(effective?.secrets?.openai?.value || ''),
    localoxmlApiKey: String(effective?.secrets?.localoxml?.value || ''),
    doubaoArkApiKey: String(effective?.secrets?.doubao?.value || '')
  }
}

export function normalizeSecretInput(v: string) {
  return String(v || '').replace(/\s+/g, '')
}

export function getRunLogColor(line: string) {
  const text = String(line || '').toLowerCase()
  if (!text) return 'rgba(226,232,240,0.92)'
  if (text.includes('ok=false') || text.includes('失败') || text.includes('missing_key') || text.includes('error') || text.includes('failed')) {
    return '#fca5a5'
  }
  if (
    text.includes('ok=true') ||
    text.includes('成功') ||
    text.includes('通过') ||
    text.includes('已就绪') ||
    text.includes('verified') ||
    text.includes('configured')
  ) {
    return '#86efac'
  }
  if (text.includes('开始') || text.includes('检测中') || text.includes('生成中')) {
    return '#fde68a'
  }
  return 'rgba(226,232,240,0.92)'
}
