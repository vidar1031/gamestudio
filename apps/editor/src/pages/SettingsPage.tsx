// 设置页（ui_设置定义.md §3/§4）：独立页面，页首固定「保存并应用」+ 当前生效摘要条。
// 已验证行为（模型记忆、URL 记忆、接口 Key 自动保存、检测链路）移植自 StudioSettingsModal，语义不变。
import { useEffect, useMemo, useRef, useState } from 'react'
import type { StudioEffectiveConfig, StudioSettings, StudioStorageInfo } from '../api'
import EffectiveSummary from '../settings/EffectiveSummary'
import SectionCard, { SettingsZone } from '../settings/SectionCard'
import { IconMatrix, IconPalette, IconStorage, IconKey, IconNetwork, IconLink, IconDiag, IconAbout } from '../settings/icons'
import ModelSectionCard from '../settings/ModelSectionCard'
import ReviewCard from '../settings/ReviewCard'
import ImageServiceCard from '../settings/ImageServiceCard'
import TtsCard from '../settings/TtsCard'
import VideoCard from '../settings/VideoCard'
import AppearanceCard from '../settings/AppearanceCard'
import StorageCard from '../settings/StorageCard'
import SecretsPanel from '../settings/SecretsPanel'
import NetworkPanel from '../settings/NetworkPanel'
import DiagnosticsPanel from '../settings/DiagnosticsPanel'
import ControlLinkCard from '../settings/ControlLinkCard'
import AboutPanel from '../settings/AboutPanel'
import {
  SECRET_LABELS,
  addRememberedModel,
  diagnoseStudio,
  emptySecretDirtyState,
  emptySecretDraft,
  getEffectiveSecretDraft,
  getRememberedModelValue,
  getStorageInfo,
  getStudioSettings,
  hasDirtySecrets,
  loadModelMemory,
  loadUrlMemory,
  normalizeSecretInput,
  normalizeSettingsDraft,
  persistModelMemory,
  persistUrlMemory,
  previewTts,
  providerKey,
  removeRememberedModelEntry,
  saveStudioSettings,
  snapshotSettingsDraft,
  withImageDefaults,
  type ModelMemory,
  type ModelSection,
  type SecretDirtyState,
  type SecretDraft,
  type SecretField,
  type ServiceTestResult,
  type SettingsHost,
  type TextSection,
  type UrlMemory
} from '../settings/settingsApi'

type DiagnoseService = 'scripts' | 'prompt' | 'translation' | 'image' | 'review'

export default function SettingsPage(props: { onBack: () => void }) {
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [savedAt, setSavedAt] = useState('')
  const [toast, setToast] = useState('')

  const [effective, setEffective] = useState<StudioEffectiveConfig | null>(null)
  const [settingsRaw, setSettingsRaw] = useState<StudioSettings | null>(null)
  const [draft, setDraft] = useState<StudioSettings>(() => normalizeSettingsDraft(null))
  const [savedSnapshot, setSavedSnapshot] = useState('')

  const [diagBusy, setDiagBusy] = useState(false)
  const [diagDeepText, setDiagDeepText] = useState(false)
  const [diagDeepImages, setDiagDeepImages] = useState(false)
  const [diagnostics, setDiagnostics] = useState<any>(null)
  const [testingService, setTestingService] = useState<'' | DiagnoseService>('')
  // 任务A：每卡测试连接的内联结果（成功/失败都落这里，卡片直接可见，不再只进折叠日志）
  const [serviceTestResults, setServiceTestResults] = useState<Record<string, ServiceTestResult>>({})
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
  const [storageInfo, setStorageInfo] = useState<StudioStorageInfo | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [deepTtsBusy, setDeepTtsBusy] = useState(false)

  useEffect(() => persistModelMemory(modelMemory), [modelMemory])
  useEffect(() => persistUrlMemory(urlMemory), [urlMemory])

  const dirty = useMemo(() => Boolean(savedSnapshot) && snapshotSettingsDraft(draft) !== savedSnapshot, [draft, savedSnapshot])
  const anyDirty = dirty || hasDirtySecrets(secretDirty)
  const anyDirtyRef = useRef(anyDirty)
  anyDirtyRef.current = anyDirty

  // §4.2：离开页面有未保存修改时给确认（浏览器刷新/关闭同样拦截）
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!anyDirtyRef.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(t)
  }, [toast])

  function nowLabel() {
    try {
      return new Date().toLocaleTimeString()
    } catch (_) {
      return String(Date.now())
    }
  }

  function appendLog(msg: string) {
    const line = `[${nowLabel()}] ${String(msg || '').trim()}`
    setRunLogs((prev) => [line, ...prev].slice(0, 200))
  }

  function recordServiceTestResult(service: string, result: ServiceTestResult) {
    setServiceTestResults((prev) => ({ ...prev, [service]: result }))
  }

  function clearServiceTestResult(service: string) {
    setServiceTestResults((prev) => {
      if (!(service in prev)) return prev
      const next = { ...prev }
      delete next[service]
      return next
    })
  }

  function patchSection(section: Parameters<SettingsHost['patchSection']>[0], patch: Record<string, any>) {
    // 配置变更即清除该卡上次测试结果（任务A：结果只保留到下次测试或配置变更）
    clearServiceTestResult(section)
    setDraft((d) => ({ ...d, [section]: { ...((d[section] as any) || {}), ...patch } }))
  }

  function setEnabled(key: 'scripts' | 'prompt' | 'image' | 'tts' | 'video', v: boolean) {
    setDraft((d) => ({ ...d, enabled: { ...(d.enabled || {}), [key]: v } }))
  }

  function applyAppearance(appearance: StudioSettings['appearance']) {
    try {
      document.documentElement.dataset.theme = String(appearance?.theme || 'dark')
    } catch (_) {}
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

  function rememberModel(section: ModelSection, provider: string | null | undefined, model: string | null | undefined) {
    const key = providerKey(provider)
    const val = String(model || '').trim()
    if (!val) return
    setModelMemory((prev) => ({
      ...prev,
      [section]: {
        ...(prev[section] || {}),
        [key]: addRememberedModel((prev[section] || {})[key], val)
      }
    }))
  }

  function forgetModel(section: ModelSection, provider: string | null | undefined, model: string | null | undefined) {
    const key = providerKey(provider)
    setModelMemory((prev) => ({
      ...prev,
      [section]: {
        ...(prev[section] || {}),
        [key]: removeRememberedModelEntry((prev[section] || {})[key], model)
      }
    }))
  }

  function rememberCurrentDraftModels(nextDraft: StudioSettings) {
    setModelMemory((prev) => ({
      scripts: {
        ...(prev.scripts || {}),
        [providerKey(nextDraft.scripts?.provider || '')]: addRememberedModel(
          (prev.scripts || {})[providerKey(nextDraft.scripts?.provider || '')],
          nextDraft.scripts?.model
        )
      },
      prompt: {
        ...(prev.prompt || {}),
        [providerKey(nextDraft.prompt?.provider || '')]: addRememberedModel(
          (prev.prompt || {})[providerKey(nextDraft.prompt?.provider || '')],
          nextDraft.prompt?.model
        )
      },
      translation: {
        ...(prev.translation || {}),
        [providerKey(nextDraft.translation?.provider || '')]: addRememberedModel(
          (prev.translation || {})[providerKey(nextDraft.translation?.provider || '')],
          nextDraft.translation?.model
        )
      },
      image: {
        ...(prev.image || {}),
        [providerKey(nextDraft.image?.provider || '')]: addRememberedModel(
          (prev.image || {})[providerKey(nextDraft.image?.provider || '')],
          nextDraft.image?.model
        )
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

  function editSecret(field: SecretField, value: string, cleared?: boolean) {
    const nextValue = normalizeSecretInput(value)
    setSecretDraft((d) => ({ ...d, [field]: nextValue }))
    setSecretDirty((d) => ({ ...d, [field]: true }))
    setSecretSaveOk(null)
    setSecretSaveNote(`${SECRET_LABELS[field]} ${cleared ? '已清空' : '已修改'}，等待保存`)
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

  async function refresh() {
    setBusy(true)
    setErr('')
    try {
      const s = await getStudioSettings()
      const nextDraft = normalizeSettingsDraft(s.settings)
      nextDraft.image = withImageDefaults(nextDraft.image)
      setDraft(nextDraft)
      setSettingsRaw(s.settings)
      setSavedSnapshot(snapshotSettingsDraft(nextDraft))
      rememberCurrentDraftModels(nextDraft)
      setEffective(s.effective)
      setSecretDraft(getEffectiveSecretDraft(s.effective))
      setSecretDirty(emptySecretDirtyState())
      setSecretSaveOk(null)
      setSecretSaveNote('已从 server 读取当前保存的接口 Key 状态')
      setSavedAt('')
      applyAppearance(nextDraft.appearance)
      setLoaded(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function loadStorageInfo() {
    try {
      const info = await getStorageInfo()
      setStorageInfo(info)
    } catch (e) {
      appendLog(`读取存储信息失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  useEffect(() => {
    void refresh()
    void loadStorageInfo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 接口 Key 自动保存（离开字段 450ms 后写回 server，沿用弹窗行为）
  useEffect(() => {
    if (!loaded || !hasDirtySecrets(secretDirty)) return
    const timer = window.setTimeout(() => {
      void persistDirtySecrets('接口 Key 已自动保存到 server 配置')
    }, 450)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, secretDirty, secretDraft])

  async function save() {
    setSaving(true)
    setErr('')
    appendLog('开始保存并应用配置')
    try {
      // enabled 来自各卡启用开关（§5 部件契约），不再按 provider 推导
      const { secrets: _unusedSecrets, ...draftWithoutSecrets } = draft as StudioSettings & { secrets?: StudioSettings['secrets'] }
      const settingsOut: StudioSettings = { ...draftWithoutSecrets }
      const secretPayload: NonNullable<StudioSettings['secrets']> = {}
      if (secretDirty.openaiApiKey) secretPayload.openaiApiKey = secretDraft.openaiApiKey
      if (secretDirty.localoxmlApiKey) secretPayload.localoxmlApiKey = secretDraft.localoxmlApiKey
      if (secretDirty.doubaoArkApiKey) secretPayload.doubaoArkApiKey = secretDraft.doubaoArkApiKey
      if (Object.keys(secretPayload).length) settingsOut.secrets = secretPayload
      const next = await saveStudioSettings(settingsOut)
      const nextDraft = normalizeSettingsDraft(next)
      nextDraft.image = withImageDefaults(nextDraft.image)
      setDraft(nextDraft)
      setSavedSnapshot(snapshotSettingsDraft(nextDraft))
      rememberCurrentDraftModels(nextDraft)
      const s = await getStudioSettings()
      setSettingsRaw(s.settings)
      setEffective(s.effective)
      setSecretDraft(getEffectiveSecretDraft(s.effective))
      setSecretDirty(emptySecretDirtyState())
      setSavedAt(new Date().toLocaleString())
      setToast('设置已保存并应用')
      try {
        window.dispatchEvent(
          new CustomEvent('studio-settings-updated', {
            detail: { effective: s.effective, updatedAt: new Date().toISOString() }
          })
        )
      } catch (_) {}
      appendLog('保存并应用成功')
    } catch (e) {
      // 失败保留编辑内容不清空（§4.2）
      appendLog(`保存失败：${e instanceof Error ? e.message : String(e)}`)
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
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

  function resolveServiceDiagnoseTimeoutMs(service: DiagnoseService) {
    if (service === 'image') return 20_000
    const provider =
      service === 'scripts'
        ? String(draft.scripts?.provider || '').trim().toLowerCase()
        : service === 'prompt'
          ? String(draft.prompt?.provider || '').trim().toLowerCase()
          : service === 'review'
            ? String(draft.review?.provider || '').trim().toLowerCase()
            : String(draft.translation?.provider || '').trim().toLowerCase()
    if (provider === 'ollama') {
      return service === 'translation' ? 60_000 : 45_000
    }
    if (provider === 'localoxml' || provider === 'omlx') return 20_000
    return 12_000
  }

  function serviceTestAdvice(service: DiagnoseService) {
    if (service === 'image') return '请检查出图服务是否已启动（ComfyUI/SDWebUI），或核对服务地址'
    if (service === 'review') return '请检查评审模型服务是否已启动；moonshot 需配置 MOONSHOT_API_KEY'
    return '请检查服务是否已启动，或核对地址与接口 Key'
  }

  async function runServiceDiagnose(service: DiagnoseService) {
    setTestingService(service)
    setErr('')
    const startedAt = Date.now()
    appendLog(`开始测试连接：${service}`)
    try {
      const timeoutMs = resolveServiceDiagnoseTimeoutMs(service)
      const opts: any = {
        service,
        timeoutMs,
        settings: buildSettingsWithSecrets()
      }
      if (service === 'image') opts.deepImages = true
      else opts.deepText = false
      const res = await diagnoseStudio(opts)
      setDiagnostics(res)
      if (res && res.effective) setEffective(res.effective)
      const item = res && res.services ? res.services[service] : null
      const elapsed = Date.now() - startedAt
      const detail = item && item.error
        ? (() => {
            const msg = item.error && item.error.message ? String(item.error.message) : ''
            const code = item.error && item.error.code ? String(item.error.code) : ''
            const extra = [msg, code].filter(Boolean).join(' ')
            return extra ? ` error=${extra}` : ''
          })()
        : ''
      // 任务A：成功/失败都写内联结果（卡片可见），日志照旧保留
      if (item && item.ok !== false) {
        recordServiceTestResult(service, {
          ok: true,
          note: `连接正常 · ${item.provider ? String(item.provider) : '-'}${item.model ? ` / ${String(item.model)}` : ''} · 耗时 ${(elapsed / 1000).toFixed(1)}s`,
          at: Date.now()
        })
      } else {
        const reason = [item && item.note ? String(item.note) : '', detail ? detail.replace(/^ error=/, '') : '']
          .filter(Boolean)
          .join(' ')
        recordServiceTestResult(service, {
          ok: false,
          note: `连接失败：${reason || '未知原因'}；建议：${serviceTestAdvice(service)}`,
          at: Date.now()
        })
      }
      appendLog(
        `测试完成：${service} ok=${item && item.ok !== false ? 'true' : 'false'} provider=${item && item.provider ? String(item.provider) : '-'} model=${item && item.model ? String(item.model) : '-'} timeoutMs=${timeoutMs} note=${item && item.note ? String(item.note) : '-'}${detail}`
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      recordServiceTestResult(service, {
        ok: false,
        note: `测试失败：${msg}；建议：${serviceTestAdvice(service)}`,
        at: Date.now()
      })
      appendLog(`测试失败：${service} ${msg}`)
      setErr(msg)
    } finally {
      setTestingService('')
    }
  }

  // 深检语音（2026-10-20 上线）：实跑一句合成样例，成败进日志与语音卡内联结果
  async function runDeepTts() {
    if (deepTtsBusy) return
    setDeepTtsBusy(true)
    appendLog('开始深检语音：合成样例')
    const startedAt = Date.now()
    try {
      const res = await previewTts({ settings: buildSettingsWithSecrets(), text: '小猫去河边钓鱼，钓到了一条大鱼。' })
      const elapsed = Date.now() - startedAt
      recordServiceTestResult('tts', {
        ok: true,
        note: `深检语音成功 · ${res.provider} / ${res.voice || '默认音色'} · ${(res.bytes / 1024).toFixed(1)}KB · 耗时 ${(elapsed / 1000).toFixed(1)}s`,
        at: Date.now()
      })
      appendLog(`深检语音成功：provider=${res.provider} voice=${res.voice || '-'} bytes=${res.bytes} elapsedMs=${elapsed}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      recordServiceTestResult('tts', {
        ok: false,
        note: `深检语音失败：${msg}；建议：请在语音卡检查 Provider 与启用开关`,
        at: Date.now()
      })
      appendLog(`深检语音失败：${msg}`)
    } finally {
      setDeepTtsBusy(false)
    }
  }

  async function exportDiagnostics() {
    if (exportBusy) return
    setExportBusy(true)
    appendLog('开始打包诊断信息')
    try {
      const s = await getStudioSettings()
      const diag = await diagnoseStudio({ deepText: false, deepImages: false, timeoutMs: 12000 })
      const payload = {
        exportedAt: new Date().toISOString(),
        version: storageInfo?.version || '',
        storageRoot: storageInfo?.root || '',
        effective: s.effective,
        diagnose: diag
      }
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `talkscene-diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 5000)
      appendLog('诊断信息已打包下载')
    } catch (e) {
      appendLog(`诊断打包失败：${e instanceof Error ? e.message : String(e)}`)
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setExportBusy(false)
    }
  }

  function handleBack() {
    if (anyDirty && !window.confirm('有未保存的修改，离开后将从服务器重新载入。确定离开吗？')) return
    props.onBack()
  }

  const host: SettingsHost = {
    draft,
    effective,
    settingsRaw,
    testingService,
    diagnostics,
    modelMemory,
    urlMemory,
    storageInfo,
    serviceTestResults,
    patchSection,
    setEnabled,
    rememberModel,
    forgetModel,
    rememberUrl,
    runServiceDiagnose,
    recordServiceTestResult,
    clearServiceTestResult,
    buildSettingsWithSecrets,
    applyAppearance,
    appendLog
  }

  return (
    <div className="settings-page">
      <div className="settings-sticky">
        <div className="settings-head">
          <button className="btn secondary" type="button" onClick={handleBack} disabled={saving}>
            返回
          </button>
          <div className="settings-title">设置</div>
          <div className="settings-head-status">
            {dirty ? '有未保存修改' : savedAt ? `已保存：${savedAt}` : ''}
          </div>
          <button
            className="btn settings-save"
            type="button"
            onClick={() => void save()}
            disabled={!anyDirty || saving || busy || diagBusy || Boolean(testingService)}
          >
            {saving ? '保存中…' : '保存并应用'}
          </button>
        </div>
        <EffectiveSummary settings={settingsRaw} effective={effective} />
      </div>

      <div className="settings-body">
        {err ? <div className="ai-modal-err">{err}</div> : null}
        {!loaded && !err ? <div className="hint">载入中…</div> : null}

        <SettingsZone title="模型矩阵" icon={<IconMatrix />} defaultOpen>
          <div className="settings-grid">
            <ModelSectionCard section="scripts" title="故事分镜" hint="一句话创意 → 脚本层草稿的生成模型。" host={host} defaultOpen />
            <ModelSectionCard section="prompt" title="图像提示词" hint="出图提示词的增强/扩写模型。" host={host} defaultOpen />
            <ModelSectionCard
              section="translation"
              title="提示词翻译"
              hint="中文提示词 → 英文出图提示词；未单独配置时跟随图像提示词。"
              host={host}
            />
            <ReviewCard host={host} />
            <ImageServiceCard host={host} defaultOpen />
            <TtsCard host={host} />
            <VideoCard host={host} />
          </div>
        </SettingsZone>

        <SettingsZone title="界面" icon={<IconPalette />}>
          <AppearanceCard host={host} defaultOpen />
        </SettingsZone>

        <SettingsZone title="存储" icon={<IconStorage />}>
          <StorageCard host={host} defaultOpen />
        </SettingsZone>

        <SettingsZone title="接口 Key" icon={<IconKey />}>
          <SecretsPanel
            effective={effective}
            secretDraft={secretDraft}
            secretDirty={secretDirty}
            secretAutoSaveBusy={secretAutoSaveBusy}
            secretSaveNote={secretSaveNote}
            secretSaveOk={secretSaveOk}
            showSecret={showSecret}
            onEdit={editSecret}
            onToggleShow={(key) => setShowSecret((s) => ({ ...s, [key]: !s[key] }))}
            onSaveNow={() => void persistDirtySecrets('接口 Key 已手动保存到 server 配置')}
            defaultOpen
          />
        </SettingsZone>

        <SettingsZone title="网络" icon={<IconNetwork />}>
          <NetworkPanel host={host} defaultOpen />
        </SettingsZone>

        <SettingsZone title="守护台关联" icon={<IconLink />}>
          <ControlLinkCard host={host} defaultOpen />
        </SettingsZone>

        <SettingsZone title="诊断" icon={<IconDiag />}>
          <DiagnosticsPanel
            diagBusy={diagBusy}
            deepText={diagDeepText}
            deepImages={diagDeepImages}
            onDeepText={setDiagDeepText}
            onDeepImages={setDiagDeepImages}
            onRun={() => void runDiagnose()}
            deepTtsBusy={deepTtsBusy}
            onDeepTts={() => void runDeepTts()}
            ttsResult={serviceTestResults['tts'] || null}
            diagnostics={diagnostics}
            runLogs={runLogs}
            onClearLogs={() => setRunLogs([])}
            defaultOpen
          />
        </SettingsZone>

        <SettingsZone title="关于" icon={<IconAbout />}>
          <AboutPanel storageInfo={storageInfo} exportBusy={exportBusy} onExport={() => void exportDiagnostics()} defaultOpen />
        </SettingsZone>
      </div>

      {toast ? <div className="settings-toast">{toast}</div> : null}
    </div>
  )
}
