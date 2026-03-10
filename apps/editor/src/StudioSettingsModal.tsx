import { useEffect, useMemo, useState } from 'react'
import {
  diagnoseStudio,
  getComfyuiModels,
  preflightStudioImage,
  getSdwebuiModels,
  getStudioImageModels,
  getStudioSettings,
  saveStudioSettings,
  testStudioImage,
  type StudioEffectiveConfig,
  type StudioSettings
} from './api'

type Props = {
  open: boolean
  onClose: () => void
}

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
    scripts: { provider: s.scripts?.provider || 'none', model: s.scripts?.model || '' },
    prompt: { provider: s.prompt?.provider || 'none', model: s.prompt?.model || '' },
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
    network: { proxyUrl: s.network?.proxyUrl || '' }
  }
}

const MODEL_MEMORY_KEY = 'studio.model.memory.v1'
type ModelSection = 'scripts' | 'prompt' | 'image'
type ModelMemory = Record<ModelSection, Record<string, string>>
// Curated presets for common local Ollama models. Users can still type a custom id.
const OLLAMA_MODEL_PRESETS = ['gemma3:12b', 'qwen3:8b', 'qwen3-vl:8b', 'qwen3.5:27b']
const SDWEBUI_MODEL_PRESETS = [
  'dreamshaper_8.safetensors [879db523c3]',
  'hellocartoonfilm_V30p.safetensors [a606a40b56]',
  'meinapastel_v6Pastel.safetensors [4679331655]',
  'nigi3d_v20.safetensors [4cb6bd041b]',
  'sd_xl_base_1.0.safetensors',
  'svd_xt.safetensors',
  'v1-5-pruned-emaonly-fp16.safetensors'
]
const COMFYUI_MODEL_PRESETS = [
  'dreamshaper_8.safetensors',
  'hellocartoonfilm_V30p.safetensors',
  'meinapastel_v6Pastel.safetensors',
  'nigi3d_v20.safetensors',
  'sd_xl_base_1.0.safetensors',
  'svd_xt.safetensors',
  'v1-5-pruned-emaonly-fp16.safetensors'
]
const COMFYUI_LORA_PRESETS = [
  'AncientCustomsStyle_Highface',
  'Concept_Art_Ultimatum_Style_LoRA_Pony_XL_v6',
  'DonMM4ch1n3W0rldXL',
  'merge_house_evol_v1_0.7_1.1',
  'J_sci-fi',
  'Mythical_Beasts',
  'sdxl',
  'TileMapStyle_v1',
  'WarcraftStyle_v2',
  'blindbox_v1_mix',
  'mw_charturn3',
  'chibi_3in1_v1',
  'chubby_20230714115856',
  'ouka_V3',
  'watercolor_imagerya_20231214112636'
]

const COMFYUI_STORYBOOK_MODEL_HINTS = [
  'illustrious',
  'dreamshaper',
  'juggernaut',
  'realvisxl',
  'sd_xl_base_1.0',
  'xl'
]

const COMFYUI_STORYBOOK_LORA_HINTS = [
  'storybook',
  'picture',
  'watercolor',
  'cartoon',
  'children',
  'illustration'
]

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

function emptyModelMemory(): ModelMemory {
  return { scripts: {}, prompt: {}, image: {} }
}

function providerKey(v: string | null | undefined) {
  const s = String(v || '').trim().toLowerCase()
  return s || '__default'
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
    return String(effective.image?.model || '')
  }
  if (section === 'scripts' || section === 'prompt') {
    if (p === 'openai') return 'gpt-4o-mini'
    if (p === 'doubao') return 'doubao-1-5-pro-32k-250115'
    if (p === 'ollama') return 'qwen3:8b'
    return ''
  }
  if (section === 'image') {
    if (p === 'doubao') return 'doubao-seedream-4-0-250828'
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
      image: json && typeof json.image === 'object' ? json.image : {}
    }
  } catch (_) {
    return emptyModelMemory()
  }
}

function isOllamaPresetModel(v: string | null | undefined) {
  const s = String(v || '').trim()
  return OLLAMA_MODEL_PRESETS.includes(s)
}

function pickFirstByHints(options: string[], hints: string[]) {
  const list = Array.isArray(options) ? options.map((x) => String(x || '').trim()).filter(Boolean) : []
  for (const h of hints) {
    const key = String(h || '').trim().toLowerCase()
    if (!key) continue
    const found = list.find((x) => x.toLowerCase().includes(key))
    if (found) return found
  }
  return list[0] || ''
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
  const [testingService, setTestingService] = useState<'' | 'scripts' | 'prompt' | 'image'>('')
  const [modelMemory, setModelMemory] = useState<ModelMemory>(() => loadModelMemory())
  const [runLogs, setRunLogs] = useState<string[]>([])
  const [sdModelsBusy, setSdModelsBusy] = useState(false)
  const [sdModelsErr, setSdModelsErr] = useState('')
  const [sdModelsNote, setSdModelsNote] = useState('')
  const [sdModelsSource, setSdModelsSource] = useState<'api' | 'disk'>('api')
  const [sdModelList, setSdModelList] = useState<string[]>([])
  const [comfyLoraList, setComfyLoraList] = useState<string[]>([])
  const [imgPreflightBusy, setImgPreflightBusy] = useState(false)
  const [imgPreflightOk, setImgPreflightOk] = useState(false)
  const [imgPreflightKey, setImgPreflightKey] = useState('')
  const [imgPreflightSummary, setImgPreflightSummary] = useState('')
  const [imgPreflightDiagOpen, setImgPreflightDiagOpen] = useState(false)
  const [imgPreflightDiag, setImgPreflightDiag] = useState<any>(null)
  const [imgTestBusy, setImgTestBusy] = useState(false)
  const [imgTestErr, setImgTestErr] = useState('')
  const [imgTestUrl, setImgTestUrl] = useState('')
  const [foldOpen, setFoldOpen] = useState<{ scripts: boolean; prompt: boolean; image: boolean; tts: boolean }>({
    scripts: true,
    prompt: true,
    image: true,
    tts: false
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(MODEL_MEMORY_KEY, JSON.stringify(modelMemory))
    } catch (_) {}
  }, [modelMemory])

  function nowLabel() {
    try { return new Date().toLocaleTimeString() } catch (_) { return String(Date.now()) }
  }

  function appendLog(msg: string) {
    const line = `[${nowLabel()}] ${String(msg || '').trim()}`
    setRunLogs((prev) => [line, ...prev].slice(0, 200))
  }

  function calcImgPreflightKey(s: StudioSettings) {
    const img: any = (s && (s as any).image) ? (s as any).image : {}
    const loras = Array.isArray(img.loras) ? img.loras.map((x: any) => String(x || '').trim()).filter(Boolean).sort() : []
    return JSON.stringify({
      provider: String(img.provider || '').toLowerCase(),
      baseUrl: String(img.comfyuiBaseUrl || '').trim(),
      model: String(img.model || '').trim(),
      loras,
      modelsRoot: String(img.comfyuiModelsRoot || '').trim()
    })
  }

  const imgPreflightReady =
    String(draft.image?.provider || '').toLowerCase() === 'comfyui' &&
    imgPreflightOk &&
    imgPreflightKey &&
    imgPreflightKey === calcImgPreflightKey(draft)

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

  async function loadImageModels(provider: string, baseUrl?: string, settingsOverride?: StudioSettings | null) {
    const p = String(provider || '').toLowerCase()
    const settings = settingsOverride && typeof settingsOverride === 'object' ? settingsOverride : draft
    if (p !== 'sdwebui' && p !== 'comfyui') {
      setSdModelList([])
      setComfyLoraList([])
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
      const modelsRoot = p === 'comfyui' ? String((settings.image as any)?.comfyuiModelsRoot || '').trim() : ''
      const res =
        p === 'comfyui' && modelsRoot
          ? await getStudioImageModels({ settings })
          : p === 'comfyui'
            ? await getComfyuiModels(baseUrl)
            : await getSdwebuiModels(baseUrl)
      if (p === 'comfyui' && String((res as any).source || '') === 'disk') setSdModelsSource('disk')

      const models = (res.models || []).map((x: any) => normalizeModelOption(x, p)).filter(Boolean)
      setSdModelList(models)
      setComfyLoraList(p === 'comfyui' && Array.isArray((res as any).loras) ? (res as any).loras.map((x: any) => String(x || '').trim()).filter(Boolean) : [])
      setSdModelsNote(String(res.note || ''))
      if (res.currentModel) {
        setDraft((d) => {
          if (String(d.image?.provider || '').toLowerCase() !== p) return d
          if (String(d.image?.model || '').trim()) return d
          return { ...d, image: { ...(d.image || {}), model: p === 'comfyui' ? normalizeComfyModelName(String(res.currentModel || '')) : String(res.currentModel || '') } }
        })
      }
      if (p === 'sdwebui' && String(res.note || '') === 'models_api_not_supported') {
        appendLog('已连接 SDWebUI，但当前版本不支持模型列表接口（可手动填写模型名）')
      } else {
        const isDisk = p === 'comfyui' && String((res as any).source || '') === 'disk'
        appendLog(
          `已${isDisk ? '从磁盘扫描' : '加载'} ${p === 'comfyui' ? 'ComfyUI' : 'SDWebUI'} 模型：${Array.isArray(res.models) ? res.models.length : 0} 个` +
          `${p === 'comfyui' ? `，LoRA：${Array.isArray((res as any).loras) ? (res as any).loras.length : 0} 个` : ''}`
        )
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSdModelsErr(msg)
      appendLog(`加载 ${p === 'comfyui' ? 'ComfyUI' : 'SDWebUI'} 模型失败：${msg}`)
    } finally {
      setSdModelsBusy(false)
    }
  }

  async function runImageTest() {
    if (imgTestBusy) return
    setImgTestBusy(true)
    setImgTestErr('')
    setImgTestUrl('')
    try {
      if (String(draft.image?.provider || '').toLowerCase() === 'comfyui' && !imgPreflightReady) {
        appendLog('未通过连续分镜体检或配置已变更：先运行体检（不出图）')
        await runImagePreflightOnly()
        return
      }

      appendLog('开始测试出图（使用当前草稿设置）...')
      const res = await testStudioImage({
        settings: draft,
        style: 'picture_book',
        width: 512,
        height: 512,
        steps: 18,
        cfgScale: 6.5,
        prompt: "children's picture book illustration, a cute rabbit reading a book under a tree, soft watercolor texture, clean outlines, warm color palette",
        negativePrompt: 'photorealistic, realistic skin texture, text, watermark, logo'
      })
      if (!res.dataUrl) throw new Error('test_no_data_url')
      setImgTestUrl(res.dataUrl)
      appendLog(`测试出图成功（provider=${String(res.meta?.provider || '')} model=${String(res.meta?.model || '')}）`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setImgTestErr(msg)
      if (!imgPreflightSummary) setImgPreflightSummary(`硬检验/测试失败：${msg}`)
      appendLog(`测试出图失败：${msg}`)
    } finally {
      setImgTestBusy(false)
    }
  }

  async function runImagePreflightOnly() {
    if (imgPreflightBusy) return
    setImgPreflightBusy(true)
    setImgPreflightSummary('')
    setImgTestErr('')
    try {
      setImgPreflightOk(false)
      setImgPreflightKey('')
      appendLog('开始运行连续分镜体检（不出图）...')
      const pf = await preflightStudioImage({ settings: draft, timeoutMs: 12000, mode: 'storyboard' })
      const checks = pf.checks || {}
      const baseUrl = String(checks.baseUrl || '')
      const missingNodes = Array.isArray(checks.missingNodes) ? checks.missingNodes : []
      const missingLoras = Array.isArray(checks.missingLoras) ? checks.missingLoras : []
      const modelCfg = String(checks.modelConfigured || '').trim()
      const modelNotFound = modelCfg && checks.modelExists === false ? modelCfg : ''
      if (pf.ok) {
        const msg = `体检通过：${baseUrl || 'comfyui'} 连续分镜依赖就绪`
        setImgPreflightOk(true)
        setImgPreflightKey(calcImgPreflightKey(draft))
        setImgPreflightSummary(msg)
        appendLog(msg)
        return
      }
      const lines = [
        baseUrl ? `baseUrl=${baseUrl}` : '',
        checks.reason ? `reason=${checks.reason}` : '',
        modelNotFound ? `modelNotFound=${modelNotFound}` : '',
        missingNodes.length ? `missingNodes=${missingNodes.join(',')}` : '',
        missingLoras.length ? `missingLoras=${missingLoras.join(',')}` : '',
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

  function normalizeLoraKeyFront(raw: any) {
    const s = String(raw || '').trim()
    if (!s) return ''
    const base = s.replace(/^.*[\\/]/, '')
    return base.replace(/\s+\[[^\]]+\]\s*$/, '').replace(/\.(safetensors|ckpt|pt|pth)$/i, '').trim().toLowerCase()
  }

  function fixMissingLorasByRemoving(missing: string[]) {
    const missKeys = new Set((missing || []).map((x) => normalizeLoraKeyFront(x)).filter(Boolean))
    setDraft((d) => {
      const curr = Array.isArray(d.image?.loras) ? d.image?.loras : []
      const next = curr.filter((x) => !missKeys.has(normalizeLoraKeyFront(String(x).split(':')[0])))
      return { ...d, image: { ...(d.image || {}), loras: next } }
    })
    appendLog('已从配置中移除缺失 LoRA')
  }

  function fixMissingLorasByReplacing(missing: string[]) {
    const currAvail = Array.isArray(comfyLoraList) ? comfyLoraList : []
    const byKey = new Map(currAvail.map((x) => [normalizeLoraKeyFront(x), x]))
    setDraft((d) => {
      const curr = Array.isArray(d.image?.loras) ? d.image?.loras : []
      const next = curr.map((entry) => {
        const raw = String(entry || '').trim()
        if (!raw) return raw
        const parts = raw.split(':')
        const baseName = String(parts[0] || '').trim()
        const key = normalizeLoraKeyFront(baseName)
        if (!key) return raw
        if (!(missing || []).some((m) => normalizeLoraKeyFront(m) === key)) return raw
        const fixed = byKey.get(key)
        if (!fixed) return raw
        parts[0] = fixed
        return parts.join(':')
      })
      return { ...d, image: { ...(d.image || {}), loras: next } }
    })
    appendLog('已尝试按 ComfyUI 实际文件名修正 LoRA')
  }

  function fixMissingModelByPickingFirst() {
    const picked = pickFirstByHints(sdModelOptions, COMFYUI_STORYBOOK_MODEL_HINTS) || (sdModelOptions[0] || '')
    if (!picked) return
    setDraft((d) => ({ ...d, image: { ...(d.image || {}), model: picked } }))
    appendLog(`已自动选择可用模型：${picked}`)
  }

  function applyComfyStorybookProfile() {
    const model = pickFirstByHints(sdModelOptions, COMFYUI_STORYBOOK_MODEL_HINTS)
    const loraBase = Array.isArray(comfyLoraOptions) ? comfyLoraOptions : []
    const selectedLoras = loraBase
      .filter((name) => COMFYUI_STORYBOOK_LORA_HINTS.some((h) => String(name || '').toLowerCase().includes(h)))
      .slice(0, 3)
      .map((name, idx) => {
        const w = idx === 0 ? 0.8 : idx === 1 ? 0.65 : 0.5
        return `${name}:${w}`
      })

    setDraft((d) => ({
      ...d,
      image: withImageDefaults({
        ...(d.image || {}),
        provider: 'comfyui',
        model: model || String(d.image?.model || ''),
        comfyuiBaseUrl: String(d.image?.comfyuiBaseUrl || '').trim() || 'http://127.0.0.1:8188',
        size: String(d.image?.size || '').trim() || '1024x1024',
        loras: selectedLoras
      })
    }))
    appendLog(
      `已应用儿童绘本硬配置：provider=comfyui${model ? ` model=${model}` : ''}` +
      `${selectedLoras.length ? ` loras=${selectedLoras.join(' | ')}` : ' loras=(未匹配到，可手选)'}`
    )
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
      setSavedAt('')
      const imgProvider = String(nextDraft.image?.provider || '').toLowerCase()
      if (imgProvider === 'sdwebui') {
        void loadImageModels('sdwebui', String(nextDraft.image?.sdwebuiBaseUrl || ''), nextDraft)
      } else if (imgProvider === 'comfyui') {
        void loadImageModels('comfyui', String(nextDraft.image?.comfyuiBaseUrl || ''), nextDraft)
      } else {
        setSdModelList([])
        setComfyLoraList([])
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

  const effectiveSummary = useMemo(() => {
    if (!effective) return ''
    const lines: string[] = []
    const scriptsProvider = effective.enabled.scripts ? effective.scripts.provider : 'none'
    const promptProvider = effective.enabled.prompt ? effective.prompt.provider : 'none'
    const imageProvider = effective.enabled.image ? effective.image.provider : 'none'
    lines.push(`故事分镜：${scriptsProvider}${effective.enabled.scripts && effective.scripts.model ? ` / ${effective.scripts.model}` : ''}`)
    lines.push(`图像提示词：${promptProvider}${effective.enabled.prompt && effective.prompt.model ? ` / ${effective.prompt.model}` : ''}`)
    lines.push(`图像生成：${imageProvider}${effective.enabled.image && effective.image.model ? ` / ${effective.image.model}` : ''}`)
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
      const presets = p === 'comfyui' ? COMFYUI_MODEL_PRESETS : SDWEBUI_MODEL_PRESETS
      for (const m of presets) {
        const x = normalizeModelOption(m, p)
        if (x) set.add(x)
      }
    }
    return Array.from(set).filter(Boolean)
  }, [sdModelList, draft.image?.model, draft.image?.provider, sdModelsSource])

  const comfyLoraOptions = useMemo(() => {
    const set = new Set<string>()
    for (const x of COMFYUI_LORA_PRESETS) set.add(String(x || '').trim())
    for (const x of comfyLoraList) set.add(String(x || '').trim())
    for (const x of Array.isArray(draft.image?.loras) ? draft.image?.loras : []) set.add(String(x || '').trim())
    return Array.from(set).filter(Boolean)
  }, [comfyLoraList, draft.image?.loras])

  async function save() {
    setBusy(true)
    setErr('')
    appendLog('开始保存并应用配置')
    try {
      const settingsOut: StudioSettings = {
        ...draft,
        enabled: {
          scripts: String(draft.scripts?.provider || '').toLowerCase() !== 'none',
          prompt: String(draft.prompt?.provider || '').toLowerCase() !== 'none',
          image: String(draft.image?.provider || '').toLowerCase() !== 'none',
          tts: String(draft.tts?.provider || '').toLowerCase() !== 'none'
        }
      }
      const next = await saveStudioSettings(settingsOut)
      const nextDraft = normalizeDraft(next)
      nextDraft.image = withImageDefaults(nextDraft.image)
      setDraft(nextDraft)
      rememberCurrentDraftModels(nextDraft)
      const s = await getStudioSettings()
      setEffective(s.effective)
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

  async function runServiceDiagnose(service: 'scripts' | 'prompt' | 'image') {
    setTestingService(service)
    setErr('')
    appendLog(`开始测试连接：${service}`)
    try {
      const opts: any = {
        service,
        timeoutMs: 12000,
        settings: draft
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

  function toggleFold(key: 'scripts' | 'prompt' | 'image' | 'tts') {
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

            {imgPreflightDiag?.checks?.modelConfigured && imgPreflightDiag?.checks?.modelExists === false ? (
              <div style={{ marginTop: 12 }}>
                <div className="hint">缺少模型：{String(imgPreflightDiag.checks.modelConfigured)}</div>
                <div className="ai-modal-actions" style={{ marginTop: 8 }}>
                  <button className="btn secondary" onClick={() => fixMissingModelByPickingFirst()}>自动选择可用模型</button>
                  <button
                    className="btn secondary"
                    onClick={() => {
                      const u = String(draft.image?.comfyuiBaseUrl || '')
                      void loadImageModels('comfyui', u)
                    }}
                  >
                    刷新模型/LoRA列表
                  </button>
                </div>
                <div className="ai-modal-hint">模型放置目录：{String(imgPreflightDiag?.checks?.hints?.comfyuiModelDir || 'ComfyUI/models/checkpoints')}</div>
              </div>
            ) : null}

            {Array.isArray(imgPreflightDiag?.checks?.missingLoras) && imgPreflightDiag.checks.missingLoras.length ? (
              <div style={{ marginTop: 12 }}>
                <div className="hint">缺少 LoRA：{imgPreflightDiag.checks.missingLoras.join(', ')}</div>
                {Array.isArray(imgPreflightDiag?.checks?.disk?.missingLorasFound) && imgPreflightDiag.checks.disk.missingLorasFound.length ? (
                  <div className="ai-modal-hint">
                    磁盘已存在但 ComfyUI 未识别：{imgPreflightDiag.checks.disk.missingLorasFound.join(', ')}（建议重启 ComfyUI 或刷新缓存）
                  </div>
                ) : null}
                <div className="ai-modal-actions" style={{ marginTop: 8 }}>
                  <button className="btn secondary" onClick={() => fixMissingLorasByReplacing(imgPreflightDiag.checks.missingLoras)}>按实际文件名修正</button>
                  <button className="btn secondary" onClick={() => fixMissingLorasByRemoving(imgPreflightDiag.checks.missingLoras)}>移除缺失 LoRA</button>
                  <button className="btn secondary" onClick={() => setDraft((d) => ({ ...d, image: { ...(d.image || {}), loras: [] } }))}>清空 LoRA</button>
                </div>
                <div className="ai-modal-hint">LoRA 放置目录：{String(imgPreflightDiag?.checks?.hints?.comfyuiLoraDir || 'ComfyUI/models/loras')}</div>
                <div className="ai-modal-hint">{String(imgPreflightDiag?.checks?.hints?.restartHint || '')}</div>
              </div>
            ) : null}

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
              {Boolean(imgPreflightDiag?.checks?.ok) ? (
                <button className="btn" onClick={() => { setImgPreflightDiagOpen(false); void runImageTest() }} disabled={imgTestBusy || imgPreflightBusy}>
                  {imgTestBusy ? '生成中…' : '生成测试图'}
                </button>
              ) : null}
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
              <div>运行日志</div>
              <div style={{ display: 'grid', gap: 8 }}>
                <textarea value={runLogs.length ? runLogs.join('\n') : '(暂无日志)'} readOnly style={{ minHeight: 110, resize: 'vertical' }} />
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
                        const recalled = (modelMemory.scripts || {})[providerKey(nextProvider)] || ''
                        const nextModel = recalled || defaultModelBySectionProvider('scripts', nextProvider, effective)
                        setDraft((d) => ({ ...d, scripts: { ...(d.scripts || {}), provider: nextProvider, model: nextModel } }))
                      }}
                    >
                      <option value="none">none</option>
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
                    ) : (
                      <input
                        value={String(draft.scripts?.model || '')}
                        placeholder="如 qwen3:8b / qwen3-vl:8b / qwen3.5:27b / doubao-1-5-pro-32k-250115（可留空）"
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
                        const recalled = (modelMemory.prompt || {})[providerKey(nextProvider)] || ''
                        const nextModel = recalled || defaultModelBySectionProvider('prompt', nextProvider, effective)
                        setDraft((d) => ({ ...d, prompt: { ...(d.prompt || {}), provider: nextProvider, model: nextModel } }))
                      }}
                    >
                      <option value="none">none</option>
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
                    ) : (
                      <input
                        value={String(draft.prompt?.model || '')}
                        placeholder="如 qwen3:8b / qwen3-vl:8b / qwen3.5:27b / doubao-1-5-pro-32k-250115（可留空）"
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
                        const nextDraft = { ...draft, image: nextImage } as any
                        if (String(nextProvider).toLowerCase() === 'sdwebui') void loadImageModels('sdwebui', String(nextImage.sdwebuiBaseUrl || ''), nextDraft)
                        if (String(nextProvider).toLowerCase() === 'comfyui') void loadImageModels('comfyui', String(nextImage.comfyuiBaseUrl || ''), nextDraft)
                      }}
                    >
                      <option value="none">none</option>
                      <option value="sdwebui">sdwebui</option>
                      <option value="comfyui">comfyui</option>
                      <option value="doubao">doubao</option>
                    </select>
                  </div>
                  <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
                    <div>Model</div>
                    {['sdwebui', 'comfyui'].includes(String(draft.image?.provider || '').toLowerCase()) ? (
                      <select
                        className="sel"
                        value={String(draft.image?.model || '')}
                        onChange={(e) => {
                          const p = String(draft.image?.provider || '').toLowerCase()
                          const v = p === 'comfyui' ? normalizeComfyModelName(e.target.value) : e.target.value
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
                      {String(draft.image?.provider || '').toLowerCase() === 'comfyui' ? (
                        <button className="btn secondary" onClick={() => runImagePreflightOnly()} disabled={busy || diagBusy || imgPreflightBusy}>
                          {imgPreflightBusy ? '体检中…' : '运行体检'}
                        </button>
                      ) : (
                        <button className="btn secondary" onClick={() => runServiceDiagnose('image')} disabled={busy || diagBusy || Boolean(testingService)}>
                          {testingService === 'image' ? '检测中…' : '测试连接'}
                        </button>
                      )}
                    </div>
                  </div>
                  {['sdwebui', 'comfyui'].includes(String(draft.image?.provider || '').toLowerCase()) ? (
                    <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
                      <div>模型列表</div>
                      <div className="hint" style={{ alignSelf: 'center' }}>
                        {sdModelsErr
                          ? `加载失败：${sdModelsErr}`
                          : sdModelsNote === 'models_api_not_supported'
                            ? '当前 SDWebUI 版本不支持模型列表接口（可手动输入模型）'
                            : String(draft.image?.provider || '').toLowerCase() === 'comfyui' && sdModelsSource === 'disk'
                              ? `磁盘扫描 ${sdModelList.length} 个（以 Models Root 为准）`
                              : `接口加载 ${sdModelList.length} 个，预置 ${
                                  String(draft.image?.provider || '').toLowerCase() === 'comfyui'
                                    ? COMFYUI_MODEL_PRESETS.length
                                    : SDWEBUI_MODEL_PRESETS.length
                                } 个`}
                      </div>
                      <button
                        className="btn secondary"
                        onClick={() => {
                          const p = String(draft.image?.provider || '').toLowerCase()
                          const u = p === 'comfyui' ? String(draft.image?.comfyuiBaseUrl || '') : String(draft.image?.sdwebuiBaseUrl || '')
                          void loadImageModels(p, u)
                        }}
                        disabled={sdModelsBusy || busy || diagBusy}
                      >
                        {sdModelsBusy ? '加载中…' : '刷新模型'}
                      </button>
                    </div>
                  ) : null}
                  {String(draft.image?.provider || '').toLowerCase() === 'comfyui' ? (
                    <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr' }}>
                      <div>LoRA</div>
                      <select
                        className="sel"
                        multiple
                        value={Array.isArray(draft.image?.loras) ? draft.image?.loras : []}
                        onChange={(e) => {
                          const vals = Array.from(e.currentTarget.selectedOptions).map((x) => String(x.value || '').trim()).filter(Boolean)
                          setDraft((d) => ({ ...d, image: { ...(d.image || {}), loras: vals } }))
                        }}
                        size={Math.min(8, Math.max(4, comfyLoraOptions.length || 4))}
                      >
                        {comfyLoraOptions.map((x) => (
                          <option key={x} value={x}>{x}</option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                  {String(draft.image?.provider || '').toLowerCase() === 'comfyui' ? (
                    <div className="hint" style={{ marginTop: -4, marginBottom: 8 }}>
                      LoRA 会注入到 ComfyUI workflow（LoraLoader 链式应用）。支持写法：`name` / `name:0.8` / `name:0.8:0.6`（最多 8 个）。
                    </div>
                  ) : null}
                  {String(draft.image?.provider || '').toLowerCase() === 'comfyui' ? (
                    <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
                      <div>推荐配置</div>
                      <div className="hint" style={{ alignSelf: 'center' }}>应用推荐的绘本连续分镜参数（模型/LoRA/尺寸/采样）</div>
                      <button className="btn secondary" onClick={() => applyComfyStorybookProfile()} disabled={busy || diagBusy || sdModelsBusy}>
                        应用推荐配置
                      </button>
                    </div>
                  ) : null}
                  {['sdwebui', 'comfyui'].includes(String(draft.image?.provider || '').toLowerCase()) ? (
                    <div className="hint" style={{ marginTop: -2, marginBottom: 8 }}>
                      {String(draft.image?.provider || '').toLowerCase() === 'comfyui' ? 'ComfyUI' : 'SDWebUI'} 出图会自动注入风格化提示（卡通/国风/绘本）与反写实负面词；建议先点“AI 解析提示词”，优先使用英文提示词。
                    </div>
                  ) : null}
                  {String(draft.image?.provider || '').toLowerCase() === 'comfyui' ? (
                    <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
                      <div>测试出图</div>
                      <div className="hint" style={{ alignSelf: 'center' }}>
                        {imgTestErr
                          ? `失败：${imgTestErr}`
                          : imgTestUrl
                            ? '已生成预览'
                            : imgPreflightReady
                              ? '生成一张 512x512 测试图'
                              : '先运行体检（连续分镜依赖）'}
                      </div>
                      <button className="btn secondary" onClick={() => runImageTest()} disabled={!imgPreflightReady || imgTestBusy || imgPreflightBusy || busy || diagBusy}>
                        {imgTestBusy ? '生成中…' : '生成测试图'}
                      </button>
                    </div>
                  ) : null}
                  {String(draft.image?.provider || '').toLowerCase() === 'comfyui' && imgPreflightSummary ? (
                    <div className="hint" style={{ marginTop: -2, marginBottom: 8 }}>
                      {imgPreflightSummary}
                    </div>
                  ) : null}
                  {imgTestUrl ? (
                    <div style={{ marginTop: 6, marginBottom: 8 }}>
                      <img
                        src={imgTestUrl}
                        alt="image-test"
                        style={{ width: 256, height: 256, objectFit: 'cover', borderRadius: 12, border: '1px solid rgba(148,163,184,.25)' }}
                      />
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
                  {String(draft.image?.provider || '').toLowerCase() === 'comfyui' ? (
                    <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr' }}>
                      <div>ComfyUI</div>
                      <input
                        value={String(draft.image?.comfyuiBaseUrl || '')}
                        placeholder="http://127.0.0.1:8188（可选）"
                        onChange={(e) => setDraft((d) => ({ ...d, image: { ...(d.image || {}), comfyuiBaseUrl: e.target.value } }))}
                        onBlur={() => {
                          if (String(draft.image?.provider || '').toLowerCase() === 'comfyui') {
                            void loadImageModels('comfyui', String(draft.image?.comfyuiBaseUrl || ''))
                          }
                        }}
                      />
                    </div>
                  ) : null}
                  {String(draft.image?.provider || '').toLowerCase() === 'comfyui' ? (
                    <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr' }}>
                      <div>Models Root</div>
                      <input
                        value={String((draft.image as any)?.comfyuiModelsRoot || '')}
                        placeholder="/Users/vidar/works/stable-diffusion-webui/models（可选，用于目录提示/磁盘校验）"
                        onChange={(e) => setDraft((d) => ({ ...d, image: { ...(d.image || {}), comfyuiModelsRoot: e.target.value } as any }))}
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
