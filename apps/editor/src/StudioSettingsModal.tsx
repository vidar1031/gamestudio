import { useEffect, useMemo, useState } from 'react'
import {
  diagnoseStudio,
  preflightStudioImage,
  getSdwebuiModels,
  getStudioSettings,
  saveStudioSettings,
  type StudioEffectiveConfig,
  type StudioSettings
} from './api'

type Props = {
  open: boolean
  onClose: () => void
}

type SecretField = 'openaiApiKey' | 'localoxmlApiKey' | 'doubaoArkApiKey'

type SecretDraft = Record<SecretField, string>

type SecretDirtyState = Record<SecretField, boolean>

function safeBool(v: any, fallback: boolean) {
  return typeof v === 'boolean' ? v : fallback
}

function normalizeDraft(settings: StudioSettings | null): StudioSettings {
  const s = settings && typeof settings === 'object' ? settings : {}
  return {
    enabled: {
      scripts: safeBool(s.enabled?.scripts, false),
      prompt: safeBool(s.enabled?.prompt, false),
      image: safeBool(s.enabled?.image, false),
      tts: safeBool(s.enabled?.tts, false)
    },
    scripts: { provider: s.scripts?.provider || 'none', model: s.scripts?.model || '', apiUrl: s.scripts?.apiUrl || '' },
    prompt: { provider: s.prompt?.provider || 'none', model: s.prompt?.model || '', apiUrl: s.prompt?.apiUrl || '' },
    translation: {
      provider: s.translation?.provider || s.prompt?.provider || 'none',
      model: s.translation?.model || s.prompt?.model || '',
      apiUrl: s.translation?.apiUrl || s.prompt?.apiUrl || ''
    },
    image: {
      provider: s.image?.provider || 'none',
      model: s.image?.model || '',
      loras: Array.isArray(s.image?.loras) ? s.image?.loras.map((x: any) => String(x || '')).filter(Boolean) : [],
      apiUrl: s.image?.apiUrl || '',
      size: s.image?.size || '',
      sdwebuiBaseUrl: s.image?.sdwebuiBaseUrl || '',
      comfyuiBaseUrl: s.image?.comfyuiBaseUrl || '',
      comfyuiModelsRoot: (s.image as any)?.comfyuiModelsRoot || ''
    },
    tts: { provider: s.tts?.provider || '', model: s.tts?.model || '', apiUrl: s.tts?.apiUrl || '' },
    secrets: {
      openaiApiKey: (s as any)?.secrets?.openaiApiKey || '',
      localoxmlApiKey: (s as any)?.secrets?.localoxmlApiKey || '',
      doubaoArkApiKey: (s as any)?.secrets?.doubaoArkApiKey || ''
    },
    network: { proxyUrl: s.network?.proxyUrl || '' }
  }
}

const MODEL_MEMORY_KEY = 'studio.model.memory.v1'
const URL_MEMORY_KEY = 'studio.url.memory.v1'
type ModelSection = 'scripts' | 'prompt' | 'translation' | 'image'
type TextSection = 'scripts' | 'prompt' | 'translation'
type ModelMemory = Record<ModelSection, Record<string, string>>
type UrlMemory = Record<TextSection, Record<string, string>>
// Curated presets for common local Ollama models. Users can still type a custom id.
const OLLAMA_MODEL_PRESETS = ['gemma3:12b', 'qwen3:8b', 'qwen3-vl:8b', 'qwen3.5:27b']
const OPENAI_MODEL_PRESETS = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4o-mini']
const SDWEBUI_MODEL_PRESETS = [
  'dreamshaper_8.safetensors [879db523c3]',
  'hellocartoonfilm_V30p.safetensors [a606a40b56]',
  'meinapastel_v6Pastel.safetensors [4679331655]',
  'nigi3d_v20.safetensors [4cb6bd041b]',
  'sd_xl_base_1.0.safetensors',
  'svd_xt.safetensors',
  'v1-5-pruned-emaonly-fp16.safetensors'
]

function textProviderModelPlaceholder(provider: string | null | undefined) {
  const p = String(provider || '').trim().toLowerCase()
  if (p === 'localoxml') return '如 Qwen3.5-27B-Claude-4.6-Opus-Distilled-MLX-4bit'
  if (p === 'openai') return '如 gpt-5 / gpt-5-mini / gpt-5-nano / gpt-4o-mini'
  if (p === 'doubao') return '如 doubao-1-5-pro-32k-250115'
  if (p === 'ollama') return '如 qwen3:8b / qwen3.5:27b'
  return '可留空'
}

function textProviderUrlMeta(provider: string | null | undefined) {
  const p = String(provider || '').trim().toLowerCase()
  if (p === 'localoxml') {
    return {
      label: 'OXML URL',
      placeholder: 'http://127.0.0.1:18888 或 http://127.0.0.1:18888/v1'
    }
  }
  if (p === 'ollama') {
    return {
      label: 'Ollama URL',
      placeholder: 'http://127.0.0.1:11434'
    }
  }
  if (p === 'openai') {
    return {
      label: 'Base URL',
      placeholder: 'https://api.openai.com/v1'
    }
  }
  if (p === 'doubao') {
    return {
      label: '接口 URL',
      placeholder: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
    }
  }
  return null
}

function normalizeComfyModelName(v: string | null | undefined) {
  return String(v || '').trim().replace(/\s+\[[^\]]+\]\s*$/, '').trim()
}

function normalizeModelOption(v: any, provider: string) {
  const p = String(provider || '').toLowerCase()
  const s0 = String(v || '').trim()
  if (!s0) return ''
  const s = p === 'comfyui' ? normalizeComfyModelName(s0) : s0
  if (!s) return ''
  // Filter out broken enum metadata values:
  // - comma-joined huge list
  // - [object Object]
  // - JSON/object-like strings
  if (s.includes(',')) return ''
  if (/^\[object\s+object\]$/i.test(s)) return ''
  if (/^\{.*\}$/.test(s)) return ''
  if (p === 'comfyui') {
    if (!/\.(safetensors|ckpt|pt|pth)$/i.test(s)) return ''
  }
  return s
}

function readCurrentModel(v: any) {
  return v && typeof v === 'object' && 'currentModel' in v ? String((v as any).currentModel || '') : ''
}

function emptyModelMemory(): ModelMemory {
  return { scripts: {}, prompt: {}, translation: {}, image: {} } as ModelMemory
}

function emptyUrlMemory(): UrlMemory {
  return { scripts: {}, prompt: {}, translation: {} }
}

function providerKey(v: string | null | undefined) {
  const s = String(v || '').trim().toLowerCase()
  return s || '__default'
}

function defaultTextProviderApiUrl(provider: string | null | undefined) {
  const p = String(provider || '').trim().toLowerCase()
  if (p === 'openai') return 'https://api.openai.com/v1'
  if (p === 'localoxml') return 'http://127.0.0.1:18888/v1'
  if (p === 'ollama') return 'http://127.0.0.1:11434'
  if (p === 'doubao') return 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
  return ''
}

function defaultModelBySectionProvider(
  section: ModelSection,
  provider: string,
  effective: StudioEffectiveConfig | null
) {
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

function loadModelMemory(): ModelMemory {
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

function loadUrlMemory(): UrlMemory {
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

function isOllamaPresetModel(v: string | null | undefined) {
  const s = String(v || '').trim()
  return OLLAMA_MODEL_PRESETS.includes(s)
}


function isOpenAIPresetModel(v: string | null | undefined) {
  const s = String(v || '').trim()
  return OPENAI_MODEL_PRESETS.includes(s)
}

function isLikelyInvalidOpenAIModel(v: string | null | undefined) {
  const s = String(v || '').trim()
  if (!s) return false
  if (OPENAI_MODEL_PRESETS.includes(s)) return false
  if (/^gpt-5\.\d/i.test(s)) return true
  if (/^gpt-5\.0/i.test(s)) return true
  return false
}

function emptySecretDraft(): SecretDraft {
  return {
    openaiApiKey: '',
    localoxmlApiKey: '',
    doubaoArkApiKey: ''
  }
}

function emptySecretDirtyState(): SecretDirtyState {
  return {
    openaiApiKey: false,
    localoxmlApiKey: false,
    doubaoArkApiKey: false
  }
}

function hasDirtySecrets(state: SecretDirtyState) {
  return Boolean(state.openaiApiKey || state.localoxmlApiKey || state.doubaoArkApiKey)
}

function getEffectiveSecretDraft(effective: StudioEffectiveConfig | null): SecretDraft {
  return {
    openaiApiKey: String(effective?.secrets?.openai?.value || ''),
    localoxmlApiKey: String(effective?.secrets?.localoxml?.value || ''),
    doubaoArkApiKey: String(effective?.secrets?.doubao?.value || '')
  }
}

function getRunLogColor(line: string) {
  const text = String(line || '').toLowerCase()
  if (!text) return 'rgba(226,232,240,0.92)'
  if (
    text.includes('ok=false') ||
    text.includes('失败') ||
    text.includes('missing_key') ||
    text.includes('error') ||
    text.includes('failed')
  ) {
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

function normalizeSecretInput(v: string) {
  return String(v || '').replace(/\s+/g, '')
}

export default function StudioSettingsModal(props: Props) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [savedAt, setSavedAt] = useState('')

  const [effective, setEffective] = useState<StudioEffectiveConfig | null>(null)
  const [draft, setDraft] = useState<StudioSettings>(() => normalizeDraft(null))

  const [diagBusy, setDiagBusy] = useState(false)
  const [diagDeepText, setDiagDeepText] = useState(false)
  const [diagDeepImages, setDiagDeepImages] = useState(false)
  const [diagnostics, setDiagnostics] = useState<any>(null)
  const [testingService, setTestingService] = useState<'' | 'scripts' | 'prompt' | 'translation' | 'image'>('')
  const [modelMemory, setModelMemory] = useState<ModelMemory>(() => loadModelMemory())
  const [urlMemory, setUrlMemory] = useState<UrlMemory>(() => loadUrlMemory())
  const [runLogs, setRunLogs] = useState<string[]>([])
  const [secretDraft, setSecretDraft] = useState<SecretDraft>(() => emptySecretDraft())
  const [secretDirty, setSecretDirty] = useState<SecretDirtyState>(() => emptySecretDirtyState())
  const [secretAutoSaveBusy, setSecretAutoSaveBusy] = useState(false)
  const [secretSaveNote, setSecretSaveNote] = useState('未修改')
  const [secretSaveOk, setSecretSaveOk] = useState<boolean | null>(null)
  const [showSecret, setShowSecret] = useState<{ openai: boolean; localoxml: boolean; doubao: boolean }>({
    openai: false,
    localoxml: false,
    doubao: false
  })
  const [sdModelsBusy, setSdModelsBusy] = useState(false)
  const [sdModelsErr, setSdModelsErr] = useState('')
  const [sdModelsNote, setSdModelsNote] = useState('')
  const [sdModelsSource, setSdModelsSource] = useState<'api' | 'disk'>('api')
  const [sdModelList, setSdModelList] = useState<string[]>([])
  const [imgPreflightBusy, setImgPreflightBusy] = useState(false)
  const [imgPreflightSummary, setImgPreflightSummary] = useState('')
  const [imgPreflightDiagOpen, setImgPreflightDiagOpen] = useState(false)
  const [imgPreflightDiag, setImgPreflightDiag] = useState<any>(null)
  const [foldOpen, setFoldOpen] = useState<{ scripts: boolean; prompt: boolean; translation: boolean; image: boolean; tts: boolean }>({
    scripts: true,
    prompt: true,
    translation: false,
    image: true,
    tts: false
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(MODEL_MEMORY_KEY, JSON.stringify(modelMemory))
    } catch (_) {}
  }, [modelMemory])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(URL_MEMORY_KEY, JSON.stringify(urlMemory))
    } catch (_) {}
  }, [urlMemory])

  function nowLabel() {
    try { return new Date().toLocaleTimeString() } catch (_) { return String(Date.now()) }
  }

  function appendLog(msg: string) {
    const line = `[${nowLabel()}] ${String(msg || '').trim()}`
    setRunLogs((prev) => [line, ...prev].slice(0, 200))
  }

  function rememberUrl(section: TextSection, provider: string, apiUrl: string) {
    const pKey = providerKey(provider)
    const value = String(apiUrl || '').trim()
    setUrlMemory((prev) => ({
      ...prev,
      [section]: {
        ...(prev[section] || {}),
        [pKey]: value
      }
    }))
  }

  function buildSettingsWithSecrets(baseSettings?: StudioSettings | null): StudioSettings {
    const src = baseSettings && typeof baseSettings === 'object' ? baseSettings : draft
    return {
      ...src,
      secrets: {
        openaiApiKey: secretDraft.openaiApiKey || null,
        localoxmlApiKey: secretDraft.localoxmlApiKey || null,
        doubaoArkApiKey: secretDraft.doubaoArkApiKey || null
      }
    }
  }

  async function persistDirtySecrets(reason: string) {
    if (secretAutoSaveBusy || !hasDirtySecrets(secretDirty)) return
    const secretPayload: NonNullable<StudioSettings['secrets']> = {}
    if (secretDirty.openaiApiKey) secretPayload.openaiApiKey = secretDraft.openaiApiKey
    if (secretDirty.localoxmlApiKey) secretPayload.localoxmlApiKey = secretDraft.localoxmlApiKey
    if (secretDirty.doubaoArkApiKey) secretPayload.doubaoArkApiKey = secretDraft.doubaoArkApiKey
    if (!Object.keys(secretPayload).length) return

    setSecretAutoSaveBusy(true)
    setSecretSaveOk(null)
    setSecretSaveNote('接口 Key 保存中...')
    try {
      await saveStudioSettings({ secrets: secretPayload } as StudioSettings)
      const s = await getStudioSettings()
      setEffective(s.effective)
      setSecretDraft(getEffectiveSecretDraft(s.effective))
      setSecretDirty(emptySecretDirtyState())
      setSecretSaveOk(true)
      setSecretSaveNote('接口 Key 已保存到 server 配置')
      appendLog(reason)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSecretSaveOk(false)
      setSecretSaveNote(`接口 Key 保存失败：${msg}`)
      appendLog(`接口 Key 自动保存失败：${msg}`)
      setErr(msg)
    } finally {
      setSecretAutoSaveBusy(false)
    }
  }

  function rememberModel(section: ModelSection, provider: string | null | undefined, model: string | null | undefined) {
    const key = providerKey(provider)
    const val = String(model || '')
    setModelMemory((prev) => ({
      ...prev,
      [section]: {
        ...(prev[section] || {}),
        [key]: val
      }
    }))
  }

  function rememberCurrentDraftModels(nextDraft: StudioSettings) {
    setModelMemory((prev) => ({
      scripts: {
        ...(prev.scripts || {}),
        [providerKey(nextDraft.scripts?.provider || '')]: String(nextDraft.scripts?.model || '')
      },
      prompt: {
        ...(prev.prompt || {}),
        [providerKey(nextDraft.prompt?.provider || '')]: String(nextDraft.prompt?.model || '')
      },
      translation: {
        ...(prev.translation || {}),
        [providerKey(nextDraft.translation?.provider || '')]: String(nextDraft.translation?.model || '')
      },
      image: {
        ...(prev.image || {}),
        [providerKey(nextDraft.image?.provider || '')]: String(nextDraft.image?.model || '')
      }
    }))
  }

  function withImageDefaults(img: StudioSettings['image']) {
    const inImg = img || {}
    const provider = String(inImg.provider || '').trim().toLowerCase()
    const next = { ...inImg }
    if (!next.size) next.size = '1024x1024'
    if (!Array.isArray((next as any).loras)) (next as any).loras = []
    if (provider === 'sdwebui') {
      if (!next.sdwebuiBaseUrl) next.sdwebuiBaseUrl = 'http://127.0.0.1:7860'
    } else if (provider === 'comfyui') {
      if (!next.comfyuiBaseUrl) next.comfyuiBaseUrl = 'http://127.0.0.1:8188'
      if (next.model) next.model = normalizeComfyModelName(next.model)
      if (!(next as any).comfyuiModelsRoot) (next as any).comfyuiModelsRoot = ''
    } else if (provider === 'doubao') {
      if (!next.apiUrl) next.apiUrl = 'https://ark.cn-beijing.volces.com/api/v3/images/generations'
    }
    return next
  }

  async function loadImageModels(provider: string, baseUrl?: string) {
    const p = String(provider || '').toLowerCase()
    if (p !== 'sdwebui') {
      setSdModelList([])
      setSdModelsErr('')
      setSdModelsNote('')
      setSdModelsSource('api')
      return
    }
    setSdModelsBusy(true)
    setSdModelsErr('')
    setSdModelsNote('')
    setSdModelsSource('api')
    try {
      const res = await getSdwebuiModels(baseUrl)
      const models = (res.models || []).map((x: any) => normalizeModelOption(x, p)).filter(Boolean)
      setSdModelList(models)
      setSdModelsNote(String(res.note || ''))
      const currentModel = readCurrentModel(res)
      if (currentModel) {
        setDraft((d) => {
          if (String(d.image?.provider || '').toLowerCase() !== p) return d
          if (String(d.image?.model || '').trim()) return d
          return { ...d, image: { ...(d.image || {}), model: currentModel } }
        })
      }
      if (String(res.note || '') === 'models_api_not_supported') {
        appendLog('已连接 SDWebUI，但当前版本不支持模型列表接口（可手动填写模型名）')
      } else {
        appendLog(`已加载 SDWebUI 模型：${Array.isArray(res.models) ? res.models.length : 0} 个`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSdModelsErr(msg)
      appendLog(`加载 SDWebUI 模型失败：${msg}`)
    } finally {
      setSdModelsBusy(false)
    }
  }

  async function runImagePreflightOnly() {
    if (imgPreflightBusy) return
    setImgPreflightBusy(true)
    setImgPreflightSummary('')
    try {
      appendLog('开始运行连续分镜体检（不出图）...')
      const pf = await preflightStudioImage({ settings: buildSettingsWithSecrets(), timeoutMs: 12000, mode: 'storyboard' })
      const checks = pf.checks || {}
      const baseUrl = String(checks.baseUrl || '')
      const missingNodes = Array.isArray(checks.missingNodes) ? checks.missingNodes : []
      if (pf.ok) {
        const msg = `体检通过：${baseUrl || 'comfyui'} 连续分镜依赖就绪`
        setImgPreflightSummary(msg)
        appendLog(msg)
        return
      }
      const lines = [
        baseUrl ? `baseUrl=${baseUrl}` : '',
        checks.reason ? `reason=${checks.reason}` : '',
        missingNodes.length ? `missingNodes=${missingNodes.join(',')}` : '',
        pf.message ? `message=${pf.message}` : ''
      ].filter(Boolean)
      const msg = `检查失败：${lines.join(' ; ')}`
      setImgPreflightSummary(msg)
      appendLog(msg)
      setImgPreflightDiag({ ok: false, checks, message: pf.message || '', details: msg })
      setImgPreflightDiagOpen(true)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setImgPreflightSummary(`体检失败：${msg}`)
      appendLog(`体检失败：${msg}`)
    } finally {
      setImgPreflightBusy(false)
    }
  }

  async function refresh() {
    setBusy(true)
    setErr('')
    try {
      const s = await getStudioSettings()
      const nextDraft = normalizeDraft(s.settings)
      nextDraft.image = withImageDefaults(nextDraft.image)
      setDraft(nextDraft)
      rememberCurrentDraftModels(nextDraft)
      setEffective(s.effective)
      setSecretDraft(getEffectiveSecretDraft(s.effective))
      setSecretDirty(emptySecretDirtyState())
      setSecretSaveOk(null)
      setSecretSaveNote('已从 server 读取当前保存的接口 Key 状态')
      setSavedAt('')
      const imgProvider = String(nextDraft.image?.provider || '').toLowerCase()
      if (imgProvider === 'sdwebui') {
        void loadImageModels('sdwebui', String(nextDraft.image?.sdwebuiBaseUrl || ''))
      } else {
        setSdModelList([])
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!props.open) return
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open])

  useEffect(() => {
    if (!props.open || !hasDirtySecrets(secretDirty)) return
    const timer = window.setTimeout(() => {
      void persistDirtySecrets('接口 Key 已自动保存到 server 配置')
    }, 450)
    return () => window.clearTimeout(timer)
  }, [props.open, secretDirty, secretDraft])

  const effectiveSummary = useMemo(() => {
    if (!effective) return ''
    const lines: string[] = []
    const scriptsProvider = effective.enabled.scripts ? effective.scripts.provider : 'none'
    const promptProvider = effective.enabled.prompt ? effective.prompt.provider : 'none'
    const translationProvider = effective.translation?.provider || promptProvider || 'none'
    const imageProvider = effective.enabled.image ? effective.image.provider : 'none'
    lines.push(`故事分镜：${scriptsProvider}${effective.enabled.scripts && effective.scripts.model ? ` / ${effective.scripts.model}` : ''}`)
    if (effective.enabled.scripts && effective.scripts.apiUrl) lines.push(`  scriptsUrl：${effective.scripts.apiUrl}`)
    lines.push(`图像提示词：${promptProvider}${effective.enabled.prompt && effective.prompt.model ? ` / ${effective.prompt.model}` : ''}`)
    if (effective.enabled.prompt && effective.prompt.apiUrl) lines.push(`  promptUrl：${effective.prompt.apiUrl}`)
    lines.push(`提示词翻译：${translationProvider}${effective.translation?.model ? ` / ${effective.translation.model}` : ''}`)
    if (effective.translation?.apiUrl) lines.push(`  translationUrl：${effective.translation.apiUrl}`)
    lines.push(`图像生成：${imageProvider}${effective.enabled.image && effective.image.provider !== 'comfyui' && effective.image.model ? ` / ${effective.image.model}` : ''}`)
    if (effective.image.provider === 'doubao') {
      if (effective.image.apiUrl) lines.push(`  imagesUrl：${effective.image.apiUrl}`)
    }
    if (effective.image.provider === 'sdwebui' && effective.image.sdwebuiBaseUrl) lines.push(`  sdwebui：${effective.image.sdwebuiBaseUrl}`)
    if (effective.image.provider === 'comfyui' && effective.image.comfyuiBaseUrl) lines.push(`  comfyui：${effective.image.comfyuiBaseUrl}`)
    if (effective.network.proxyUrl) lines.push(`代理：${effective.network.proxyUrl}`)
    return lines.join('\n')
  }, [effective])

  const sdModelOptions = useMemo(() => {
    const p = String(draft.image?.provider || '').toLowerCase()
    const set = new Set<string>()
    const current = normalizeModelOption(draft.image?.model, p)
    if (current) set.add(current)
    for (const m of sdModelList || []) {
      const x = normalizeModelOption(m, p)
      if (x) set.add(x)
    }
    // When disk scan is enabled, only show real models (plus current value for visibility).
    if (!(p === 'comfyui' && sdModelsSource === 'disk')) {
      const presets = SDWEBUI_MODEL_PRESETS
      for (const m of presets) {
        const x = normalizeModelOption(m, p)
        if (x) set.add(x)
      }
    }
    return Array.from(set).filter(Boolean)
  }, [sdModelList, draft.image?.model, draft.image?.provider, sdModelsSource])

  const scriptsUrlMeta = useMemo(() => textProviderUrlMeta(draft.scripts?.provider), [draft.scripts?.provider])
  const promptUrlMeta = useMemo(() => textProviderUrlMeta(draft.prompt?.provider), [draft.prompt?.provider])
  const translationUrlMeta = useMemo(() => textProviderUrlMeta(draft.translation?.provider), [draft.translation?.provider])

  async function save() {
    setBusy(true)
    setErr('')
    appendLog('开始保存并应用配置')
    try {
      const { secrets: _unusedSecrets, ...draftWithoutSecrets } = draft as StudioSettings & { secrets?: StudioSettings['secrets'] }
      const settingsOut: StudioSettings = {
        ...draftWithoutSecrets,
        enabled: {
          scripts: String(draft.scripts?.provider || '').toLowerCase() !== 'none',
          prompt: String(draft.prompt?.provider || '').toLowerCase() !== 'none',
          image: String(draft.image?.provider || '').toLowerCase() !== 'none',
          tts: String(draft.tts?.provider || '').toLowerCase() !== 'none'
        }
      }
      const secretPayload: NonNullable<StudioSettings['secrets']> = {}
      if (secretDirty.openaiApiKey) secretPayload.openaiApiKey = secretDraft.openaiApiKey
      if (secretDirty.localoxmlApiKey) secretPayload.localoxmlApiKey = secretDraft.localoxmlApiKey
      if (secretDirty.doubaoArkApiKey) secretPayload.doubaoArkApiKey = secretDraft.doubaoArkApiKey
      if (Object.keys(secretPayload).length) settingsOut.secrets = secretPayload
      const next = await saveStudioSettings(settingsOut)
      const nextDraft = normalizeDraft(next)
      nextDraft.image = withImageDefaults(nextDraft.image)
      setDraft(nextDraft)
      rememberCurrentDraftModels(nextDraft)
      const s = await getStudioSettings()
      setEffective(s.effective)
      setSecretDraft(getEffectiveSecretDraft(s.effective))
      setSecretDirty(emptySecretDirtyState())
      setSavedAt(new Date().toLocaleString())
      try {
        window.dispatchEvent(
          new CustomEvent('studio-settings-updated', {
            detail: { effective: s.effective, updatedAt: new Date().toISOString() }
          })
        )
      } catch (_) {}
      appendLog('保存并应用成功')
    } catch (e) {
      appendLog(`保存失败：${e instanceof Error ? e.message : String(e)}`)
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function runDiagnose() {
    setDiagBusy(true)
    setErr('')
    appendLog(`开始检测：all deepText=${diagDeepText ? 'on' : 'off'} deepImages=${diagDeepImages ? 'on' : 'off'}`)
    try {
      const res = await diagnoseStudio({ deepText: diagDeepText, deepImages: diagDeepImages, timeoutMs: 12000 })
      setDiagnostics(res)
      if (res && res.effective) setEffective(res.effective)
      appendLog(`检测完成：all ok=${res && res.ok ? 'true' : 'false'}`)
    } catch (e) {
      appendLog(`检测失败：all ${e instanceof Error ? e.message : String(e)}`)
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setDiagBusy(false)
    }
  }

  async function runServiceDiagnose(service: 'scripts' | 'prompt' | 'translation' | 'image') {
    setTestingService(service)
    setErr('')
    appendLog(`开始测试连接：${service}`)
    try {
      const opts: any = {
        service,
        timeoutMs: 12000,
        settings: buildSettingsWithSecrets()
      }
      if (service === 'image') opts.deepImages = true
      else opts.deepText = false
      const res = await diagnoseStudio(opts)
      setDiagnostics(res)
      if (res && res.effective) setEffective(res.effective)
      const item = res && res.services ? res.services[service] : null
      appendLog(
        `测试完成：${service} ok=${item && item.ok !== false ? 'true' : 'false'} provider=${item && item.provider ? String(item.provider) : '-'} model=${item && item.model ? String(item.model) : '-'} note=${item && item.note ? String(item.note) : '-'}`
      )
    } catch (e) {
      appendLog(`测试失败：${service} ${e instanceof Error ? e.message : String(e)}`)
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setTestingService('')
    }
  }

  function toggleFold(key: 'scripts' | 'prompt' | 'translation' | 'image' | 'tts') {
    setFoldOpen((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  if (!props.open) return null

  return (
    <div className="ai-modal" role="dialog" aria-modal="true" aria-label="工具设置" style={{ background: '#040b1a' }}>
      {imgPreflightDiagOpen ? (
        <div
          className="ai-modal"
          role="dialog"
          aria-modal="true"
          aria-label="出图配置检查"
          onClick={() => setImgPreflightDiagOpen(false)}
        >
          <div className="ai-modal-card" style={{ width: 860, maxHeight: 'calc(100vh - 24px)' }} onClick={(e) => e.stopPropagation()}>
            <div className="ai-modal-head">
              <div className="ai-modal-title" style={{ marginBottom: 0 }}>出图配置检查</div>
              <button className="btn secondary" onClick={() => setImgPreflightDiagOpen(false)}>关闭</button>
            </div>

            <div className="hint" style={{ marginBottom: 10 }}>
              {String(imgPreflightDiag?.checks?.provider || '') === 'comfyui'
                ? `ComfyUI baseUrl: ${String(imgPreflightDiag?.checks?.baseUrl || '') || '(未设置)'}`
                : '当前检查仅对 ComfyUI 生效'}
            </div>

            <div className="ai-modal-err">
              {String(imgPreflightDiag?.checks?.reason || 'preflight_failed')}
              {imgPreflightDiag?.message ? ` - ${String(imgPreflightDiag.message)}` : ''}
            </div>

            {Array.isArray(imgPreflightDiag?.checks?.missingNodes) && imgPreflightDiag.checks.missingNodes.length ? (
              <div style={{ marginTop: 12 }}>
                <div className="hint">缺少节点（相当于缺插件/自定义节点）：{imgPreflightDiag.checks.missingNodes.join(', ')}</div>
                <div className="ai-modal-hint">{String(imgPreflightDiag?.checks?.hints?.managerHint || '建议通过 ComfyUI-Manager 安装/更新节点，然后重启 ComfyUI')}</div>
              </div>
            ) : null}

            {imgPreflightDiag?.checks?.mode === 'storyboard' ? (
              <div style={{ marginTop: 12 }}>
                <div className="hint">连续分镜依赖检查</div>
                <div className="ai-modal-hint">
                  ControlNet: {imgPreflightDiag?.checks?.extras?.controlnet?.ok ? 'ok' : 'missing'}{' '}
                  {Array.isArray(imgPreflightDiag?.checks?.extras?.controlnet?.missingNodes) && imgPreflightDiag.checks.extras.controlnet.missingNodes.length
                    ? ` nodes=${imgPreflightDiag.checks.extras.controlnet.missingNodes.join(',')}`
                    : ''}
                  {typeof imgPreflightDiag?.checks?.extras?.controlnet?.modelsCount === 'number'
                    ? ` models=${imgPreflightDiag.checks.extras.controlnet.modelsCount}`
                    : ''}
                  {typeof imgPreflightDiag?.checks?.extras?.controlnet?.diskCount === 'number' && imgPreflightDiag.checks.extras.controlnet.diskCount
                    ? ` diskModels=${imgPreflightDiag.checks.extras.controlnet.diskCount}`
                    : ''}
                  {typeof imgPreflightDiag?.checks?.extras?.controlnet?.extCount === 'number' && imgPreflightDiag.checks.extras.controlnet.extCount
                    ? ` extModels=${imgPreflightDiag.checks.extras.controlnet.extCount}`
                    : ''}
                </div>
                <div className="ai-modal-hint">
                  IP-Adapter: {imgPreflightDiag?.checks?.extras?.ipadapter?.ok ? 'ok' : 'missing'}{' '}
                  {Array.isArray(imgPreflightDiag?.checks?.extras?.ipadapter?.missingNodes) && imgPreflightDiag.checks.extras.ipadapter.missingNodes.length
                    ? ` nodes=${imgPreflightDiag.checks.extras.ipadapter.missingNodes.join(',')}`
                    : ''}
                  {typeof imgPreflightDiag?.checks?.extras?.ipadapter?.modelsCount === 'number'
                    ? ` models=${imgPreflightDiag.checks.extras.ipadapter.modelsCount}`
                    : ''}
                  {typeof imgPreflightDiag?.checks?.extras?.ipadapter?.diskCount === 'number' && imgPreflightDiag.checks.extras.ipadapter.diskCount
                    ? ` diskModels=${imgPreflightDiag.checks.extras.ipadapter.diskCount}`
                    : ''}
                </div>
                <div className="ai-modal-hint">ControlNet 目录：{String(imgPreflightDiag?.checks?.hints?.comfyuiControlnetDir || 'ComfyUI/models/controlnet')}</div>
                {String(imgPreflightDiag?.checks?.disk?.controlnetExtDir || '') ? (
                  <div className="ai-modal-hint">检测到 SD-WebUI ControlNet 扩展模型目录：{String(imgPreflightDiag.checks.disk.controlnetExtDir)}</div>
                ) : null}
                <div className="ai-modal-hint">IP-Adapter 目录：{String(imgPreflightDiag?.checks?.hints?.comfyuiIpadapterDir || 'ComfyUI/models/ipadapter')}</div>
                <div className="ai-modal-hint">提示：`control_v11*_sd15_*.pth` 是 SD1.5 ControlNet，适用于 SD1.5 checkpoint（如 dreamshaper_8）。若使用 SDXL checkpoint，需要 SDXL 对应 ControlNet。</div>
                {Boolean(imgPreflightDiag?.checks?.disk?.controlnetExtDir) && !imgPreflightDiag?.checks?.extras?.controlnet?.modelsSupported ? (
                  <div style={{ marginTop: 10 }}>
                    <div className="hint">快速修复（软链共享 ControlNet 模型）</div>
                    <pre className="ai-modal-hint" style={{ whiteSpace: 'pre-wrap', userSelect: 'text' }}>{`mkdir -p "${String(imgPreflightDiag?.checks?.hints?.comfyuiControlnetDir || '').trim() || 'ComfyUI/models/controlnet'}"
for f in "${String(imgPreflightDiag.checks.disk.controlnetExtDir)}"/control_v11*_sd15_*.pth; do
  [ -e "$f" ] || continue
  ln -sf "$f" "${String(imgPreflightDiag?.checks?.hints?.comfyuiControlnetDir || '').trim() || 'ComfyUI/models/controlnet'}/"
done`}</pre>
                    <div className="ai-modal-hint">软链后建议重启 ComfyUI，再点“重新体检”。</div>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="ai-modal-actions" style={{ marginTop: 14 }}>
              <button className="btn secondary" onClick={() => runImagePreflightOnly()} disabled={imgPreflightBusy}>
                {imgPreflightBusy ? '体检中…' : '重新体检'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="ai-modal-card" style={{ width: 920, maxHeight: 'calc(100vh - 24px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div className="ai-modal-title" style={{ marginBottom: 0 }}>设置</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn" onClick={() => save()} disabled={busy || diagBusy || Boolean(testingService)}>
              保存并应用
            </button>
            <button className="btn secondary" onClick={props.onClose} disabled={busy}>
              关闭
            </button>
          </div>
        </div>

        <div className="hr" />

        <>
            <div className="ai-modal-row">
              <div>快速检测</div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={diagDeepText} onChange={(e) => setDiagDeepText(e.target.checked)} /> 深度验证文本
                </label>
                <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={diagDeepImages} onChange={(e) => setDiagDeepImages(e.target.checked)} /> 深度验证出图（会消耗额度）
                </label>
                <button className="btn secondary" onClick={() => runDiagnose()} disabled={busy || diagBusy}>
                  {diagBusy ? '检测中…' : '运行检测'}
                </button>
              </div>
            </div>

            <div className="ai-modal-row">
              <div>当前生效</div>
              <textarea value={effectiveSummary || '(加载中…)'} readOnly style={{ minHeight: 94, resize: 'none' }} />
            </div>

            <div className="ai-modal-row">
              <div>网络代理</div>
              <div style={{ display: 'grid', gap: 8 }}>
                <input
                  value={String(draft.network?.proxyUrl || '')}
                  placeholder="http://127.0.0.1:7897"
                  onChange={(e) => setDraft((d) => ({
                    ...d,
                    network: { ...(d.network || {}), proxyUrl: e.target.value.trim() }
                  }))}
                  autoComplete="off"
                  spellCheck={false}
                />
                <div className="hint">用于 OpenAI / 其他需要代理的文本请求。留空表示直连；常见本地代理示例：`http://127.0.0.1:7897`。</div>
              </div>
            </div>

            <div className="ai-modal-row">
              <div>接口 Key</div>
              <div style={{ display: 'grid', gap: 10 }}>
                <div className="hint">
                  Doubao：{effective?.secrets?.doubao?.present ? `${String(effective.secrets.doubao.masked || '(已设置)')}（来源：${String(effective.secrets.doubao.source || '-') }）` : '未设置'}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type={showSecret.doubao ? 'text' : 'password'}
                    value={secretDraft.doubaoArkApiKey}
                    placeholder="DOUBAO_ARK_API_KEY"
                    onChange={(e) => {
                      const nextValue = normalizeSecretInput(e.target.value)
                      setSecretDraft((d) => ({ ...d, doubaoArkApiKey: nextValue }))
                      setSecretDirty((d) => ({ ...d, doubaoArkApiKey: true }))
                      setSecretSaveOk(null)
                      setSecretSaveNote('Doubao Key 已修改，等待保存')
                    }}
                    onPaste={(e) => {
                      e.preventDefault()
                      const nextValue = normalizeSecretInput(e.clipboardData.getData('text'))
                      setSecretDraft((d) => ({ ...d, doubaoArkApiKey: nextValue }))
                      setSecretDirty((d) => ({ ...d, doubaoArkApiKey: true }))
                      setSecretSaveOk(null)
                      setSecretSaveNote('Doubao Key 已修改，等待保存')
                    }}
                    autoComplete="off"
                    spellCheck={false}
                    style={{ flex: 1, minWidth: 260 }}
                  />
                  <button className="btn secondary" type="button" onClick={() => setShowSecret((s) => ({ ...s, doubao: !s.doubao }))}>
                    {showSecret.doubao ? '隐藏' : '显示'}
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => {
                      setSecretDraft((d) => ({ ...d, doubaoArkApiKey: '' }))
                      setSecretDirty((d) => ({ ...d, doubaoArkApiKey: true }))
                      setSecretSaveOk(null)
                      setSecretSaveNote('Doubao Key 已清空，等待保存')
                    }}
                  >
                    清空
                  </button>
                </div>

                <div className="hint">
                  OpenAI：{effective?.secrets?.openai?.present ? `${String(effective.secrets.openai.masked || '(已设置)')}（来源：${String(effective.secrets.openai.source || '-') }）` : '未设置'}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type={showSecret.openai ? 'text' : 'password'}
                    value={secretDraft.openaiApiKey}
                    placeholder="OPENAI_API_KEY"
                    onChange={(e) => {
                      const nextValue = normalizeSecretInput(e.target.value)
                      setSecretDraft((d) => ({ ...d, openaiApiKey: nextValue }))
                      setSecretDirty((d) => ({ ...d, openaiApiKey: true }))
                      setSecretSaveOk(null)
                      setSecretSaveNote('OpenAI Key 已修改，等待保存')
                    }}
                    onPaste={(e) => {
                      e.preventDefault()
                      const nextValue = normalizeSecretInput(e.clipboardData.getData('text'))
                      setSecretDraft((d) => ({ ...d, openaiApiKey: nextValue }))
                      setSecretDirty((d) => ({ ...d, openaiApiKey: true }))
                      setSecretSaveOk(null)
                      setSecretSaveNote('OpenAI Key 已修改，等待保存')
                    }}
                    autoComplete="off"
                    spellCheck={false}
                    style={{ flex: 1, minWidth: 260 }}
                  />
                  <button className="btn secondary" type="button" onClick={() => setShowSecret((s) => ({ ...s, openai: !s.openai }))}>
                    {showSecret.openai ? '隐藏' : '显示'}
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => {
                      setSecretDraft((d) => ({ ...d, openaiApiKey: '' }))
                      setSecretDirty((d) => ({ ...d, openaiApiKey: true }))
                      setSecretSaveOk(null)
                      setSecretSaveNote('OpenAI Key 已清空，等待保存')
                    }}
                  >
                    清空
                  </button>
                </div>

                <div className="hint">
                  localoxml：{effective?.secrets?.localoxml?.present ? `${String(effective.secrets.localoxml.masked || '(已设置)')}（来源：${String(effective.secrets.localoxml.source || '-') }）` : '未设置'}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type={showSecret.localoxml ? 'text' : 'password'}
                    value={secretDraft.localoxmlApiKey}
                    placeholder="LOCALOXML_API_KEY"
                    onChange={(e) => {
                      const nextValue = normalizeSecretInput(e.target.value)
                      setSecretDraft((d) => ({ ...d, localoxmlApiKey: nextValue }))
                      setSecretDirty((d) => ({ ...d, localoxmlApiKey: true }))
                      setSecretSaveOk(null)
                      setSecretSaveNote('localoxml Key 已修改，等待保存')
                    }}
                    onPaste={(e) => {
                      e.preventDefault()
                      const nextValue = normalizeSecretInput(e.clipboardData.getData('text'))
                      setSecretDraft((d) => ({ ...d, localoxmlApiKey: nextValue }))
                      setSecretDirty((d) => ({ ...d, localoxmlApiKey: true }))
                      setSecretSaveOk(null)
                      setSecretSaveNote('localoxml Key 已修改，等待保存')
                    }}
                    autoComplete="off"
                    spellCheck={false}
                    style={{ flex: 1, minWidth: 260 }}
                  />
                  <button className="btn secondary" type="button" onClick={() => setShowSecret((s) => ({ ...s, localoxml: !s.localoxml }))}>
                    {showSecret.localoxml ? '隐藏' : '显示'}
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => {
                      setSecretDraft((d) => ({ ...d, localoxmlApiKey: '' }))
                      setSecretDirty((d) => ({ ...d, localoxmlApiKey: true }))
                      setSecretSaveOk(null)
                      setSecretSaveNote('localoxml Key 已清空，等待保存')
                    }}
                  >
                    清空
                  </button>
                </div>

                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => { void persistDirtySecrets('接口 Key 已手动保存到 server 配置') }}
                    disabled={secretAutoSaveBusy || !hasDirtySecrets(secretDirty)}
                  >
                    {secretAutoSaveBusy ? '保存中…' : '立即保存 Key'}
                  </button>
                  <span
                    className="hint"
                    style={{ color: secretSaveOk === false ? '#fca5a5' : secretSaveOk === true ? '#86efac' : 'rgba(226,232,240,0.72)' }}
                  >
                    {secretSaveNote}
                  </span>
                </div>

                <div className="ai-modal-hint">
                  Key 会写入 server 侧 storage/_config/studio_settings.json。当前输入框会显示实际生效值；你修改后会自动写回 server，刷新页面不会再把刚贴入的 key 丢掉。
                </div>
              </div>
            </div>

            <div className="ai-modal-row">
              <div>运行日志</div>
              <div style={{ display: 'grid', gap: 8 }}>
                <div
                  style={{
                    minHeight: 110,
                    maxHeight: 220,
                    overflow: 'auto',
                    resize: 'vertical',
                    border: '1px solid rgba(148,163,184,0.18)',
                    borderRadius: 12,
                    background: 'rgba(15,23,42,0.65)',
                    padding: 12,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    fontSize: 12,
                    lineHeight: 1.5,
                    whiteSpace: 'pre-wrap'
                  }}
                >
                  {runLogs.length ? runLogs.map((line, idx) => (
                    <div key={`${idx}-${line.slice(0, 24)}`} style={{ color: getRunLogColor(line) }}>{line}</div>
                  )) : <div style={{ color: 'rgba(148,163,184,0.9)' }}>(暂无日志)</div>}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button className="btn secondary" onClick={() => setRunLogs([])} disabled={busy || diagBusy || Boolean(testingService)}>
                    Clear
                  </button>
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gap: 12 }}>
              <div className="subfold">
                <div className="subfold-head" onClick={() => toggleFold('scripts')}>
                  <div className="subfold-title">故事分镜</div>
                  <div className="hint">{foldOpen.scripts ? '收起' : '展开'}</div>
                </div>
                {foldOpen.scripts ? <div className="subfold-body">
                  <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr' }}>
                    <div>Provider</div>
                    <select
                      className="sel"
                      value={String(draft.scripts?.provider || '')}
                      onChange={(e) => {
                        const nextProvider = e.target.value
                        rememberModel('scripts', draft.scripts?.provider || '', draft.scripts?.model || '')
                        rememberUrl('scripts', draft.scripts?.provider || '', draft.scripts?.apiUrl || '')
                        const recalled = (modelMemory.scripts || {})[providerKey(nextProvider)] || ''
                        const nextModel = recalled || defaultModelBySectionProvider('scripts', nextProvider, effective)
                        const recalledUrl = (urlMemory.scripts || {})[providerKey(nextProvider)] || ''
                        const nextApiUrl = recalledUrl || defaultTextProviderApiUrl(nextProvider)
                        setDraft((d) => ({ ...d, scripts: { ...(d.scripts || {}), provider: nextProvider, model: nextModel, apiUrl: nextApiUrl } }))
                      }}
                    >
                      <option value="none">none</option>
                      <option value="localoxml">localoxml</option>
                      <option value="openai">openai</option>
                      <option value="doubao">doubao</option>
                      <option value="ollama">ollama</option>
                    </select>
                  </div>
                  <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
                    <div>Model</div>
                    {String(draft.scripts?.provider || '') === 'ollama' ? (
                      <select
                        className="sel"
                        value={isOllamaPresetModel(draft.scripts?.model) ? String(draft.scripts?.model || '') : '__custom__'}
                        onChange={(e) => {
                          const next = e.target.value === '__custom__' ? String(draft.scripts?.model || '') : e.target.value
                          setDraft((d) => ({ ...d, scripts: { ...(d.scripts || {}), model: next } }))
                          rememberModel('scripts', draft.scripts?.provider || '', next)
                        }}
                      >
                        {OLLAMA_MODEL_PRESETS.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                        <option value="__custom__">自定义（手动输入）</option>
                      </select>
                    ) : String(draft.scripts?.provider || '') === 'openai' ? (
                      <div style={{ display: 'grid', gap: 8 }}>
                        <select
                          className="sel"
                          value={isOpenAIPresetModel(draft.scripts?.model) ? String(draft.scripts?.model || '') : '__custom__'}
                          onChange={(e) => {
                            const next = e.target.value === '__custom__' ? String(draft.scripts?.model || '') : e.target.value
                            setDraft((d) => ({ ...d, scripts: { ...(d.scripts || {}), model: next } }))
                            rememberModel('scripts', draft.scripts?.provider || '', next)
                          }}
                        >
                          {OPENAI_MODEL_PRESETS.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                          <option value="__custom__">自定义（手动输入）</option>
                        </select>
                        {!isOpenAIPresetModel(draft.scripts?.model) ? (
                          <input
                            value={String(draft.scripts?.model || '')}
                            placeholder={textProviderModelPlaceholder(draft.scripts?.provider)}
                            onChange={(e) => {
                              const v = e.target.value
                              setDraft((d) => ({ ...d, scripts: { ...(d.scripts || {}), model: v } }))
                              rememberModel('scripts', draft.scripts?.provider || '', v)
                            }}
                          />
                        ) : null}
                        {isLikelyInvalidOpenAIModel(draft.scripts?.model) ? (
                          <div className="hint" style={{ color: '#fca5a5' }}>当前 OpenAI 模型名看起来无效。请改用 `gpt-5`、`gpt-5-mini`、`gpt-5-nano` 或 `gpt-4o-mini`。</div>
                        ) : null}
                      </div>
                    ) : (
                      <input
                        value={String(draft.scripts?.model || '')}
                        placeholder={textProviderModelPlaceholder(draft.scripts?.provider)}
                        onChange={(e) => {
                          const v = e.target.value
                          setDraft((d) => ({ ...d, scripts: { ...(d.scripts || {}), model: v } }))
                          rememberModel('scripts', draft.scripts?.provider || '', v)
                        }}
                      />
                    )}
                    <button className="btn secondary" onClick={() => runServiceDiagnose('scripts')} disabled={busy || diagBusy || Boolean(testingService)}>
                      {testingService === 'scripts' ? '检测中…' : '测试连接'}
                    </button>
                  </div>
                  {scriptsUrlMeta ? (
                    <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr' }}>
                      <div>{scriptsUrlMeta.label}</div>
                      <input
                        value={String(draft.scripts?.apiUrl || '')}
                        placeholder={scriptsUrlMeta.placeholder}
                        onChange={(e) => {
                          const v = e.target.value
                          setDraft((d) => ({ ...d, scripts: { ...(d.scripts || {}), apiUrl: v } }))
                          rememberUrl('scripts', draft.scripts?.provider || '', v)
                        }}
                      />
                    </div>
                  ) : null}
                </div> : null}
              </div>

              <div className="subfold">
                <div className="subfold-head" onClick={() => toggleFold('prompt')}>
                  <div className="subfold-title">图像提示词</div>
                  <div className="hint">{foldOpen.prompt ? '收起' : '展开'}</div>
                </div>
                {foldOpen.prompt ? <div className="subfold-body">
                  <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr' }}>
                    <div>Provider</div>
                    <select
                      className="sel"
                      value={String(draft.prompt?.provider || '')}
                      onChange={(e) => {
                        const nextProvider = e.target.value
                        rememberModel('prompt', draft.prompt?.provider || '', draft.prompt?.model || '')
                        rememberUrl('prompt', draft.prompt?.provider || '', draft.prompt?.apiUrl || '')
                        const recalled = (modelMemory.prompt || {})[providerKey(nextProvider)] || ''
                        const nextModel = recalled || defaultModelBySectionProvider('prompt', nextProvider, effective)
                        const recalledUrl = (urlMemory.prompt || {})[providerKey(nextProvider)] || ''
                        const nextApiUrl = recalledUrl || defaultTextProviderApiUrl(nextProvider)
                        setDraft((d) => ({ ...d, prompt: { ...(d.prompt || {}), provider: nextProvider, model: nextModel, apiUrl: nextApiUrl } }))
                      }}
                    >
                      <option value="none">none</option>
                      <option value="localoxml">localoxml</option>
                      <option value="openai">openai</option>
                      <option value="doubao">doubao</option>
                      <option value="ollama">ollama</option>
                    </select>
                  </div>
                  <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
                    <div>Model</div>
                    {String(draft.prompt?.provider || '') === 'ollama' ? (
                      <select
                        className="sel"
                        value={isOllamaPresetModel(draft.prompt?.model) ? String(draft.prompt?.model || '') : '__custom__'}
                        onChange={(e) => {
                          const next = e.target.value === '__custom__' ? String(draft.prompt?.model || '') : e.target.value
                          setDraft((d) => ({ ...d, prompt: { ...(d.prompt || {}), model: next } }))
                          rememberModel('prompt', draft.prompt?.provider || '', next)
                        }}
                      >
                        {OLLAMA_MODEL_PRESETS.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                        <option value="__custom__">自定义（手动输入）</option>
                      </select>
                    ) : String(draft.prompt?.provider || '') === 'openai' ? (
                      <div style={{ display: 'grid', gap: 8 }}>
                        <select
                          className="sel"
                          value={isOpenAIPresetModel(draft.prompt?.model) ? String(draft.prompt?.model || '') : '__custom__'}
                          onChange={(e) => {
                            const next = e.target.value === '__custom__' ? String(draft.prompt?.model || '') : e.target.value
                            setDraft((d) => ({ ...d, prompt: { ...(d.prompt || {}), model: next } }))
                            rememberModel('prompt', draft.prompt?.provider || '', next)
                          }}
                        >
                          {OPENAI_MODEL_PRESETS.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                          <option value="__custom__">自定义（手动输入）</option>
                        </select>
                        {!isOpenAIPresetModel(draft.prompt?.model) ? (
                          <input
                            value={String(draft.prompt?.model || '')}
                            placeholder={textProviderModelPlaceholder(draft.prompt?.provider)}
                            onChange={(e) => {
                              const v = e.target.value
                              setDraft((d) => ({ ...d, prompt: { ...(d.prompt || {}), model: v } }))
                              rememberModel('prompt', draft.prompt?.provider || '', v)
                            }}
                          />
                        ) : null}
                        {isLikelyInvalidOpenAIModel(draft.prompt?.model) ? (
                          <div className="hint" style={{ color: '#fca5a5' }}>当前 OpenAI 模型名看起来无效。请改用 `gpt-5`、`gpt-5-mini`、`gpt-5-nano` 或 `gpt-4o-mini`。</div>
                        ) : null}
                      </div>
                    ) : (
                      <input
                        value={String(draft.prompt?.model || '')}
                        placeholder={textProviderModelPlaceholder(draft.prompt?.provider)}
                        onChange={(e) => {
                          const v = e.target.value
                          setDraft((d) => ({ ...d, prompt: { ...(d.prompt || {}), model: v } }))
                          rememberModel('prompt', draft.prompt?.provider || '', v)
                        }}
                      />
                    )}
                    <button className="btn secondary" onClick={() => runServiceDiagnose('prompt')} disabled={busy || diagBusy || Boolean(testingService)}>
                      {testingService === 'prompt' ? '检测中…' : '测试连接'}
                    </button>
                  </div>
                  {promptUrlMeta ? (
                    <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr' }}>
                      <div>{promptUrlMeta.label}</div>
                      <input
                        value={String(draft.prompt?.apiUrl || '')}
                        placeholder={promptUrlMeta.placeholder}
                        onChange={(e) => {
                          const v = e.target.value
                          setDraft((d) => ({ ...d, prompt: { ...(d.prompt || {}), apiUrl: v } }))
                          rememberUrl('prompt', draft.prompt?.provider || '', v)
                        }}
                      />
                    </div>
                  ) : null}
                </div> : null}
              </div>

              <div className="subfold">
                <div className="subfold-head" onClick={() => toggleFold('translation')}>
                  <div className="subfold-title">提示词翻译</div>
                  <div className="hint">{foldOpen.translation ? '收起' : '展开'}</div>
                </div>
                {foldOpen.translation ? <div className="subfold-body">
                  <div className="hint" style={{ marginBottom: 8 }}>用于中转英翻译，以及 AI 增强提示词生成中文后自动补写英文。</div>
                  <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr' }}>
                    <div>Provider</div>
                    <select
                      className="sel"
                      value={String(draft.translation?.provider || '')}
                      onChange={(e) => {
                        const nextProvider = e.target.value
                        rememberModel('translation', draft.translation?.provider || '', draft.translation?.model || '')
                        rememberUrl('translation', draft.translation?.provider || '', draft.translation?.apiUrl || '')
                        const recalled = (modelMemory.translation || {})[providerKey(nextProvider)] || ''
                        const nextModel = recalled || defaultModelBySectionProvider('translation', nextProvider, effective)
                        const recalledUrl = (urlMemory.translation || {})[providerKey(nextProvider)] || ''
                        const nextApiUrl = recalledUrl || defaultTextProviderApiUrl(nextProvider)
                        setDraft((d) => ({ ...d, translation: { ...(d.translation || {}), provider: nextProvider, model: nextModel, apiUrl: nextApiUrl } }))
                      }}
                    >
                      <option value="none">none</option>
                      <option value="localoxml">localoxml</option>
                      <option value="openai">openai</option>
                      <option value="doubao">doubao</option>
                      <option value="ollama">ollama</option>
                    </select>
                  </div>
                  <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
                    <div>Model</div>
                    {String(draft.translation?.provider || '') === 'ollama' ? (
                      <select
                        className="sel"
                        value={isOllamaPresetModel(draft.translation?.model) ? String(draft.translation?.model || '') : '__custom__'}
                        onChange={(e) => {
                          const next = e.target.value === '__custom__' ? String(draft.translation?.model || '') : e.target.value
                          setDraft((d) => ({ ...d, translation: { ...(d.translation || {}), model: next } }))
                          rememberModel('translation', draft.translation?.provider || '', next)
                        }}
                      >
                        {OLLAMA_MODEL_PRESETS.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                        <option value="__custom__">自定义（手动输入）</option>
                      </select>
                    ) : String(draft.translation?.provider || '') === 'openai' ? (
                      <div style={{ display: 'grid', gap: 8 }}>
                        <select
                          className="sel"
                          value={isOpenAIPresetModel(draft.translation?.model) ? String(draft.translation?.model || '') : '__custom__'}
                          onChange={(e) => {
                            const next = e.target.value === '__custom__' ? String(draft.translation?.model || '') : e.target.value
                            setDraft((d) => ({ ...d, translation: { ...(d.translation || {}), model: next } }))
                            rememberModel('translation', draft.translation?.provider || '', next)
                          }}
                        >
                          {OPENAI_MODEL_PRESETS.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                          <option value="__custom__">自定义（手动输入）</option>
                        </select>
                        {!isOpenAIPresetModel(draft.translation?.model) ? (
                          <input
                            value={String(draft.translation?.model || '')}
                            placeholder={textProviderModelPlaceholder(draft.translation?.provider)}
                            onChange={(e) => {
                              const v = e.target.value
                              setDraft((d) => ({ ...d, translation: { ...(d.translation || {}), model: v } }))
                              rememberModel('translation', draft.translation?.provider || '', v)
                            }}
                          />
                        ) : null}
                      </div>
                    ) : (
                      <input
                        value={String(draft.translation?.model || '')}
                        placeholder={textProviderModelPlaceholder(draft.translation?.provider)}
                        onChange={(e) => {
                          const v = e.target.value
                          setDraft((d) => ({ ...d, translation: { ...(d.translation || {}), model: v } }))
                          rememberModel('translation', draft.translation?.provider || '', v)
                        }}
                      />
                    )}
                    <button className="btn secondary" onClick={() => runServiceDiagnose('translation')} disabled={busy || diagBusy || Boolean(testingService)}>
                      {testingService === 'translation' ? '检测中…' : '测试连接'}
                    </button>
                  </div>
                  {translationUrlMeta ? (
                    <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr' }}>
                      <div>{translationUrlMeta.label}</div>
                      <input
                        value={String(draft.translation?.apiUrl || '')}
                        placeholder={translationUrlMeta.placeholder}
                        onChange={(e) => {
                          const v = e.target.value
                          setDraft((d) => ({ ...d, translation: { ...(d.translation || {}), apiUrl: v } }))
                          rememberUrl('translation', draft.translation?.provider || '', v)
                        }}
                      />
                    </div>
                  ) : null}
                </div> : null}
              </div>

              <div className="subfold">
                <div className="subfold-head" onClick={() => toggleFold('image')}>
                  <div className="subfold-title">图像生成</div>
                  <div className="hint">{foldOpen.image ? '收起' : '展开'}</div>
                </div>
                {foldOpen.image ? <div className="subfold-body">
                  <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr' }}>
                    <div>Provider</div>
                    <select
                      className="sel"
                      value={String(draft.image?.provider || '')}
                      onChange={(e) => {
                        const nextProvider = e.target.value
                        rememberModel('image', draft.image?.provider || '', draft.image?.model || '')
                        const recalled = (modelMemory.image || {})[providerKey(nextProvider)] || ''
                        const nextModel = recalled || defaultModelBySectionProvider('image', nextProvider, effective)
                        const nextImage = withImageDefaults({ ...(draft.image || {}), provider: nextProvider, model: nextModel })
                        setDraft((d) => ({ ...d, image: nextImage }))
                        if (String(nextProvider).toLowerCase() === 'sdwebui') void loadImageModels('sdwebui', String(nextImage.sdwebuiBaseUrl || ''))
                      }}
                    >
                      <option value="none">none</option>
                      <option value="sdwebui">sdwebui</option>
                      <option value="comfyui">comfyui</option>
                      <option value="doubao">doubao</option>
                    </select>
                  </div>
                  {String(draft.image?.provider || '').toLowerCase() !== 'comfyui' ? (
                    <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
                      <div>Model</div>
                      {String(draft.image?.provider || '').toLowerCase() === 'sdwebui' ? (
                        <select
                          className="sel"
                          value={String(draft.image?.model || '')}
                          onChange={(e) => {
                            const v = e.target.value
                            setDraft((d) => ({ ...d, image: { ...(d.image || {}), model: v } }))
                            rememberModel('image', draft.image?.provider || '', v)
                          }}
                        >
                          <option value="">自动/当前模型</option>
                          {(sdModelOptions || []).map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={String(draft.image?.model || '')}
                          placeholder="如 doubao-seedream-4-0-250828（可留空）"
                          onChange={(e) => {
                            const v = e.target.value
                            setDraft((d) => ({ ...d, image: { ...(d.image || {}), model: v } }))
                            rememberModel('image', draft.image?.provider || '', v)
                          }}
                        />
                      )}
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn secondary" onClick={() => runServiceDiagnose('image')} disabled={busy || diagBusy || Boolean(testingService)}>
                          {testingService === 'image' ? '检测中…' : '测试连接'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {String(draft.image?.provider || '').toLowerCase() === 'sdwebui' ? (
                    <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
                      <div>模型列表</div>
                      <div className="hint" style={{ alignSelf: 'center' }}>
                        {sdModelsErr
                          ? `加载失败：${sdModelsErr}`
                          : sdModelsNote === 'models_api_not_supported'
                            ? '当前 SDWebUI 版本不支持模型列表接口（可手动输入模型）'
                            : `接口加载 ${sdModelList.length} 个，预置 ${SDWEBUI_MODEL_PRESETS.length} 个`}
                      </div>
                      <button
                        className="btn secondary"
                        onClick={() => {
                          void loadImageModels('sdwebui', String(draft.image?.sdwebuiBaseUrl || ''))
                        }}
                        disabled={sdModelsBusy || busy || diagBusy}
                      >
                        {sdModelsBusy ? '加载中…' : '刷新模型'}
                      </button>
                    </div>
                  ) : null}
                  {String(draft.image?.provider || '').toLowerCase() === 'comfyui' ? (
                    <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
                      <div>ComfyUI</div>
                      <input
                        value={String(draft.image?.comfyuiBaseUrl || '')}
                        placeholder="http://127.0.0.1:8188（可选）"
                        onChange={(e) => setDraft((d) => ({ ...d, image: { ...(d.image || {}), comfyuiBaseUrl: e.target.value } }))}
                      />
                      <button className="btn secondary" onClick={() => runImagePreflightOnly()} disabled={busy || diagBusy || imgPreflightBusy}>
                        {imgPreflightBusy ? '体检中…' : '测试连接'}
                      </button>
                    </div>
                  ) : null}
                  {['sdwebui', 'comfyui'].includes(String(draft.image?.provider || '').toLowerCase()) ? (
                    <div className="hint" style={{ marginTop: -2, marginBottom: 8 }}>
                      {String(draft.image?.provider || '').toLowerCase() === 'comfyui'
                        ? 'ComfyUI 设置页只保留地址连通与连续分镜依赖体检；模型、LoRA 与采样参数请在“AI 分镜批量生成”里按当前工作流填写。'
                        : 'SDWebUI 出图会自动注入风格化提示（卡通/国风/绘本）与反写实负面词；建议先点“AI 解析提示词”，优先使用英文提示词。'}
                    </div>
                  ) : null}
                  {String(draft.image?.provider || '').toLowerCase() === 'comfyui' ? (
                    <div className="hint" style={{ marginTop: -2, marginBottom: 8 }}>
                      当前仅校验 `baseUrl`、基础节点和连续分镜依赖节点是否就绪，不在这里绑定 checkpoint / LoRA。
                    </div>
                  ) : null}
                  {String(draft.image?.provider || '').toLowerCase() === 'comfyui' && imgPreflightSummary ? (
                    <div className="hint" style={{ marginTop: -2, marginBottom: 8 }}>
                      {imgPreflightSummary}
                    </div>
                  ) : null}
                  {String(draft.image?.provider || '').toLowerCase() === 'doubao' ? (
                    <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr' }}>
                      <div>Ark URL</div>
                      <input
                        value={String(draft.image?.apiUrl || '')}
                        placeholder="https://ark.../api/v3/images/generations（可选）"
                        onChange={(e) => setDraft((d) => ({ ...d, image: { ...(d.image || {}), apiUrl: e.target.value } }))}
                      />
                    </div>
                  ) : null}
                  {String(draft.image?.provider || '').toLowerCase() === 'sdwebui' ? (
                    <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr' }}>
                      <div>SDWebUI</div>
                      <input
                        value={String(draft.image?.sdwebuiBaseUrl || '')}
                        placeholder="http://127.0.0.1:7860（可选）"
                        onChange={(e) => setDraft((d) => ({ ...d, image: { ...(d.image || {}), sdwebuiBaseUrl: e.target.value } }))}
                        onBlur={() => {
                          if (String(draft.image?.provider || '').toLowerCase() === 'sdwebui') {
                            void loadImageModels('sdwebui', String(draft.image?.sdwebuiBaseUrl || ''))
                          }
                        }}
                      />
                    </div>
                  ) : null}
                </div> : null}
              </div>

              <div className="subfold">
                <div className="subfold-head" onClick={() => toggleFold('tts')}>
                  <div className="subfold-title">语音 TTS</div>
                  <div className="hint">{foldOpen.tts ? '收起' : '展开'}</div>
                </div>
                {foldOpen.tts ? <div className="subfold-body">
                  <div className="hint" style={{ marginBottom: 8 }}>当前项目尚未实现语音生成接口，这里先预留配置。</div>
                  <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr' }}>
                    <div>Provider</div>
                    <select
                      className="sel"
                      value={String(draft.tts?.provider || '')}
                      onChange={(e) => setDraft((d) => ({ ...d, tts: { ...(d.tts || {}), provider: e.target.value } }))}
                    >
                      <option value="">none</option>
                      <option value="doubao">doubao</option>
                      <option value="openai">openai</option>
                    </select>
                  </div>
                  <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr' }}>
                    <div>Model</div>
                    <input
                      value={String(draft.tts?.model || '')}
                      placeholder="可留空"
                      onChange={(e) => setDraft((d) => ({ ...d, tts: { ...(d.tts || {}), model: e.target.value } }))}
                    />
                  </div>
                  <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr' }}>
                    <div>API URL</div>
                    <input
                      value={String(draft.tts?.apiUrl || '')}
                      placeholder="可留空"
                      onChange={(e) => setDraft((d) => ({ ...d, tts: { ...(d.tts || {}), apiUrl: e.target.value } }))}
                    />
                  </div>
                </div> : null}
              </div>
            </div>

            {err ? <div className="ai-modal-err">{err}</div> : null}
            {savedAt ? <div className="ai-modal-ok" style={{ marginTop: 10, opacity: 0.95 }}>已保存：{savedAt}</div> : null}

        </>
      </div>
    </div>
  )
}
