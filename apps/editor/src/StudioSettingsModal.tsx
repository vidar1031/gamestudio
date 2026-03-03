import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import {
  diagnoseStudio,
  getAiStatus,
  getComfyuiModels,
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

function safeBool(v: any, fallback: boolean) {
  return typeof v === 'boolean' ? v : fallback
}

function normalizeDraft(settings: StudioSettings | null): StudioSettings {
  const s = settings && typeof settings === 'object' ? settings : {}
  return {
    enabled: {
      scripts: safeBool(s.enabled?.scripts, true),
      prompt: safeBool(s.enabled?.prompt, true),
      image: safeBool(s.enabled?.image, true),
      tts: safeBool(s.enabled?.tts, false)
    },
    scripts: { provider: s.scripts?.provider || '', model: s.scripts?.model || '' },
    prompt: { provider: s.prompt?.provider || '', model: s.prompt?.model || '' },
    image: {
      provider: s.image?.provider || '',
      model: s.image?.model || '',
      loras: Array.isArray(s.image?.loras) ? s.image?.loras.map((x: any) => String(x || '')).filter(Boolean) : [],
      apiUrl: s.image?.apiUrl || '',
      size: s.image?.size || '',
      sdwebuiBaseUrl: s.image?.sdwebuiBaseUrl || '',
      comfyuiBaseUrl: s.image?.comfyuiBaseUrl || ''
    },
    tts: { provider: s.tts?.provider || '', model: s.tts?.model || '', apiUrl: s.tts?.apiUrl || '' },
    network: { proxyUrl: s.network?.proxyUrl || '' }
  }
}

const MODEL_MEMORY_KEY = 'studio.model.memory.v1'
type ModelSection = 'scripts' | 'prompt' | 'image'
type ModelMemory = Record<ModelSection, Record<string, string>>
const OLLAMA_MODEL_PRESETS = ['qwen3:8b', 'qwen3-vl:8b', 'qwen3.5:27b']
const SDWEBUI_SIZE_PRESETS = ['768x1024', '1024x1024', '1024x1536', '1216x832', '832x1216', '1344x768', '768x1344']
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

function normalizeComfyModelName(v: string | null | undefined) {
  return String(v || '').trim().replace(/\s+\[[^\]]+\]\s*$/, '').trim()
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

export default function StudioSettingsModal(props: Props) {
  const [tab, setTab] = useState<'config' | 'diagnose'>('config')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [savedAt, setSavedAt] = useState('')

  const [effective, setEffective] = useState<StudioEffectiveConfig | null>(null)
  const [draft, setDraft] = useState<StudioSettings>(() => normalizeDraft(null))

  const [diagBusy, setDiagBusy] = useState(false)
  const [diagDeepText, setDiagDeepText] = useState(false)
  const [diagDeepImages, setDiagDeepImages] = useState(false)
  const [diagnostics, setDiagnostics] = useState<any>(null)
  const [aiStatus, setAiStatus] = useState<any>(null)
  const [testingService, setTestingService] = useState<'' | 'scripts' | 'prompt' | 'image'>('')
  const [modelMemory, setModelMemory] = useState<ModelMemory>(() => loadModelMemory())
  const [runLogs, setRunLogs] = useState<string[]>([])
  const [sdModelsBusy, setSdModelsBusy] = useState(false)
  const [sdModelsErr, setSdModelsErr] = useState('')
  const [sdModelsNote, setSdModelsNote] = useState('')
  const [sdModelList, setSdModelList] = useState<string[]>([])
  const [comfyLoraList, setComfyLoraList] = useState<string[]>([])

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
    } else if (provider === 'doubao') {
      if (!next.apiUrl) next.apiUrl = 'https://ark.cn-beijing.volces.com/api/v3/images/generations'
    }
    return next
  }

  async function loadImageModels(provider: string, baseUrl?: string) {
    const p = String(provider || '').toLowerCase()
    if (p !== 'sdwebui' && p !== 'comfyui') {
      setSdModelList([])
      setComfyLoraList([])
      setSdModelsErr('')
      setSdModelsNote('')
      return
    }
    setSdModelsBusy(true)
    setSdModelsErr('')
    setSdModelsNote('')
    try {
      const res = p === 'comfyui' ? await getComfyuiModels(baseUrl) : await getSdwebuiModels(baseUrl)
      const models = (res.models || []).map((x) => (p === 'comfyui' ? normalizeComfyModelName(x) : String(x || '').trim())).filter(Boolean)
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
        appendLog(
          `已加载 ${p === 'comfyui' ? 'ComfyUI' : 'SDWebUI'} 模型：${Array.isArray(res.models) ? res.models.length : 0} 个` +
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

  async function refresh() {
    setBusy(true)
    setErr('')
    try {
      const [s, st] = await Promise.all([getStudioSettings(), getAiStatus().catch(() => null)])
      const nextDraft = normalizeDraft(s.settings)
      nextDraft.image = withImageDefaults(nextDraft.image)
      setDraft(nextDraft)
      rememberCurrentDraftModels(nextDraft)
      setEffective(s.effective)
      setAiStatus(st)
      setSavedAt('')
      const imgProvider = String(nextDraft.image?.provider || '').toLowerCase()
      if (imgProvider === 'sdwebui') {
        void loadImageModels('sdwebui', String(nextDraft.image?.sdwebuiBaseUrl || ''))
      } else if (imgProvider === 'comfyui') {
        void loadImageModels('comfyui', String(nextDraft.image?.comfyuiBaseUrl || ''))
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
    lines.push(`写故事：${effective.enabled.scripts ? '启用' : '关闭'} / ${effective.scripts.provider}${effective.scripts.model ? ` / ${effective.scripts.model}` : ''}`)
    lines.push(`提示词：${effective.enabled.prompt ? '启用' : '关闭'} / ${effective.prompt.provider}${effective.prompt.model ? ` / ${effective.prompt.model}` : ''}`)
    lines.push(`出图：${effective.enabled.image ? '启用' : '关闭'} / ${effective.image.provider}${effective.image.model ? ` / ${effective.image.model}` : ''}`)
    if (effective.image.provider === 'doubao') {
      if (effective.image.apiUrl) lines.push(`  imagesUrl：${effective.image.apiUrl}`)
      if (effective.image.size) lines.push(`  size：${effective.image.size}`)
    }
    if (effective.image.provider === 'sdwebui' && effective.image.sdwebuiBaseUrl) lines.push(`  sdwebui：${effective.image.sdwebuiBaseUrl}`)
    if (effective.image.provider === 'comfyui' && effective.image.comfyuiBaseUrl) lines.push(`  comfyui：${effective.image.comfyuiBaseUrl}`)
    if (effective.network.proxyUrl) lines.push(`代理：${effective.network.proxyUrl}`)
    return lines.join('\n')
  }, [effective])

  const sdModelOptions = useMemo(() => {
    const p = String(draft.image?.provider || '').toLowerCase()
    const set = new Set<string>()
    const current = p === 'comfyui' ? normalizeComfyModelName(draft.image?.model) : String(draft.image?.model || '').trim()
    if (current) set.add(current)
    for (const m of sdModelList || []) set.add(String(m || '').trim())
    const presets = p === 'comfyui' ? COMFYUI_MODEL_PRESETS : SDWEBUI_MODEL_PRESETS
    for (const m of presets) set.add(String(m || '').trim())
    return Array.from(set).filter(Boolean)
  }, [sdModelList, draft.image?.model, draft.image?.provider])

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
      const next = await saveStudioSettings(draft)
      const nextDraft = normalizeDraft(next)
      nextDraft.image = withImageDefaults(nextDraft.image)
      setDraft(nextDraft)
      rememberCurrentDraftModels(nextDraft)
      const s = await getStudioSettings()
      setEffective(s.effective)
      setSavedAt(new Date().toLocaleString())
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
      setTab('diagnose')
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

  function onOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) props.onClose()
  }

  if (!props.open) return null

  return (
    <div className="ai-modal" role="dialog" aria-modal="true" aria-label="工具设置" onClick={onOverlayClick}>
      <div className="ai-modal-card" style={{ width: 920, maxHeight: 'calc(100vh - 24px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div className="ai-modal-title" style={{ marginBottom: 0 }}>设置</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn secondary" onClick={() => refresh()} disabled={busy || diagBusy || Boolean(testingService)}>
              重新加载
            </button>
            <button className="btn" onClick={() => save()} disabled={busy || diagBusy || Boolean(testingService)}>
              保存并应用
            </button>
            <button className={`btn secondary ${tab === 'config' ? 'active' : ''}`} onClick={() => setTab('config')} disabled={busy}>
              参数
            </button>
            <button className={`btn secondary ${tab === 'diagnose' ? 'active' : ''}`} onClick={() => setTab('diagnose')} disabled={busy}>
              检测
            </button>
            <button className="btn secondary" onClick={props.onClose} disabled={busy}>
              关闭
            </button>
          </div>
        </div>

        <div className="hr" />

        {tab === 'config' ? (
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

            <div className="ai-modal-row">
              <div>代理</div>
              <input
                value={String(draft.network?.proxyUrl || '')}
                placeholder="http://127.0.0.1:7890（可选）"
                onChange={(e) => setDraft((d) => ({ ...d, network: { ...(d.network || {}), proxyUrl: e.target.value } }))}
              />
            </div>

            <div style={{ display: 'grid', gap: 12 }}>
              <div className="subfold">
                <div className="subfold-head">
                  <div className="subfold-title">写故事脚本</div>
                </div>
                <div className="subfold-body">
                  <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                    <input
                      type="checkbox"
                      checked={safeBool(draft.enabled?.scripts, true)}
                      onChange={(e) => setDraft((d) => ({ ...d, enabled: { ...(d.enabled || {}), scripts: e.target.checked } }))}
                    />
                    启用
                  </label>
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
                      <option value="">跟随环境变量</option>
                      <option value="local">local</option>
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
                </div>
              </div>

              <div className="subfold">
                <div className="subfold-head">
                  <div className="subfold-title">生成图片与图片提示词</div>
                </div>
                <div className="subfold-body">
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>提示词（Seedream）</div>
                  <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                    <input
                      type="checkbox"
                      checked={safeBool(draft.enabled?.prompt, true)}
                      onChange={(e) => setDraft((d) => ({ ...d, enabled: { ...(d.enabled || {}), prompt: e.target.checked } }))}
                    />
                    启用
                  </label>
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
                      <option value="">自动</option>
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

                  <div className="hr" style={{ margin: '10px 0' }} />
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>出图（背景图）</div>
                  <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                    <input
                      type="checkbox"
                      checked={safeBool(draft.enabled?.image, true)}
                      onChange={(e) => setDraft((d) => ({ ...d, enabled: { ...(d.enabled || {}), image: e.target.checked } }))}
                    />
                    启用
                  </label>
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
                        if (String(nextProvider).toLowerCase() === 'comfyui') void loadImageModels('comfyui', String(nextImage.comfyuiBaseUrl || ''))
                      }}
                    >
                      <option value="">跟随环境变量</option>
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
                    <button className="btn secondary" onClick={() => runServiceDiagnose('image')} disabled={busy || diagBusy || Boolean(testingService)}>
                      {testingService === 'image' ? '检测中…' : '测试连接'}
                    </button>
                  </div>
                  {['sdwebui', 'comfyui'].includes(String(draft.image?.provider || '').toLowerCase()) ? (
                    <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr auto' }}>
                      <div>模型列表</div>
                      <div className="hint" style={{ alignSelf: 'center' }}>
                        {sdModelsErr
                          ? `加载失败：${sdModelsErr}`
                          : sdModelsNote === 'models_api_not_supported'
                            ? '当前 SDWebUI 版本不支持模型列表接口（可手动输入模型）'
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
                      <div>LoRA（预留）</div>
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
                      LoRA 仅做配置预留（当前不会参与实际 ComfyUI 出图流程）。
                    </div>
                  ) : null}
                  {['sdwebui', 'comfyui'].includes(String(draft.image?.provider || '').toLowerCase()) ? (
                    <div className="hint" style={{ marginTop: -2, marginBottom: 8 }}>
                      {String(draft.image?.provider || '').toLowerCase() === 'comfyui' ? 'ComfyUI' : 'SDWebUI'} 出图会自动注入风格化提示（卡通/国风/绘本）与反写实负面词；建议先点“AI 解析提示词”，优先使用英文提示词。
                    </div>
                  ) : null}
                  <div className="ai-modal-row" style={{ gridTemplateColumns: '110px 1fr' }}>
                    <div>Size</div>
                    <select
                      className="sel"
                      value={String(draft.image?.size || '1024x1024')}
                      onChange={(e) => setDraft((d) => ({ ...d, image: { ...(d.image || {}), size: e.target.value } }))}
                    >
                      {SDWEBUI_SIZE_PRESETS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
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
                </div>
              </div>

              <div className="subfold">
                <div className="subfold-head">
                  <div className="subfold-title">语音（TTS）</div>
                </div>
                <div className="subfold-body">
                  <div className="hint" style={{ marginBottom: 8 }}>当前项目尚未实现语音生成接口，这里先预留配置。</div>
                  <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                    <input
                      type="checkbox"
                      checked={safeBool(draft.enabled?.tts, false)}
                      onChange={(e) => setDraft((d) => ({ ...d, enabled: { ...(d.enabled || {}), tts: e.target.checked } }))}
                    />
                    启用
                  </label>
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
                </div>
              </div>
            </div>

            {err ? <div className="ai-modal-err">{err}</div> : null}
            {savedAt ? <div className="ai-modal-ok" style={{ marginTop: 10, opacity: 0.95 }}>已保存：{savedAt}</div> : null}

            {aiStatus ? (
              <div className="ai-modal-hint">
                服务器 AI 状态（环境变量快照）：{String(aiStatus?.provider || '')}
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div className="hint" style={{ marginBottom: 10 }}>
              “深度验证出图”会触发一次真实的 Doubao 生图请求（仅取 URL，不下载），可能消耗额度。
            </div>
            <div className="ai-modal-row">
              <div>操作</div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={diagDeepText} onChange={(e) => setDiagDeepText(e.target.checked)} /> 深度验证文本
                </label>
                <label className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={diagDeepImages} onChange={(e) => setDiagDeepImages(e.target.checked)} /> 深度验证出图
                </label>
                <button className="btn secondary" onClick={() => runDiagnose()} disabled={busy || diagBusy}>
                  {diagBusy ? '检测中…' : '重新检测'}
                </button>
              </div>
            </div>
            <div className="ai-modal-row">
              <div>结果</div>
              <textarea value={diagnostics ? JSON.stringify(diagnostics, null, 2) : '(未检测)'} readOnly style={{ minHeight: 320 }} />
            </div>
            {err ? <div className="ai-modal-err">{err}</div> : null}
          </>
        )}
      </div>
    </div>
  )
}
