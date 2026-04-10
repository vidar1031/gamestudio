import React from 'react'
import { resolveUrl, type AiBackgroundRequest, type StoryAssetGalleryEntry } from './api'

function getAssetCategoryLabel(category: string) {
  const c = String(category || '').trim()
  if (c === 'character') return '角色'
  if (c === 'prop') return '道具'
  if (c === 'location') return '地点'
  return c || '资产'
}

function getReferenceStatusLabel(status: string) {
  const s = String(status || '').trim()
  if (s === 'ready') return '主参考已选'
  if (s === 'candidates_ready') return '待选择主参考'
  return '未抽卡'
}

function toProjectAssetUrl(projectId: string, rawUri: string) {
  const uri = String(rawUri || '').trim()
  if (!uri || !projectId) return ''
  if (/^https?:\/\//i.test(uri) || uri.startsWith('data:')) return uri
  return resolveUrl(`/project-assets/${encodeURIComponent(String(projectId))}/${uri.replace(/^\/+/, '')}`)
}

function toRuntimeUrl(rawUrl: string) {
  const value = String(rawUrl || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value
  return resolveUrl(value.startsWith('/') ? value : `/${value}`)
}

function scoreOf(candidate: any) {
  const n = Number(candidate?.analysis?.score)
  return Number.isFinite(n) ? Math.round(n) : null
}

function formatGalleryTime(raw: string) {
  const value = String(raw || '').trim()
  if (!value) return ''
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return value
  try {
    return new Date(time).toLocaleString('zh-CN', { hour12: false })
  } catch (_) {
    return new Date(time).toISOString()
  }
}

function normalizeAssetPath(raw: string) {
  return String(raw || '').trim().replace(/^\/+/, '')
}

function buildDisplayedReferenceCandidates(asset: any) {
  const primaryUri = normalizeAssetPath(String(asset?.primaryReferenceAssetUri || ''))
  const batchAll = Array.isArray(asset?.latestReferenceBatch) ? asset.latestReferenceBatch.filter((item: any) => item && typeof item === 'object') : []
  const refsAll = Array.isArray(asset?.generatedRefs) ? asset.generatedRefs.filter((item: any) => item && typeof item === 'object') : []
  const byPath = new Map<string, any>()

  for (let i = 0; i < refsAll.length; i += 1) {
    const ref = refsAll[i]
    const assetPath = normalizeAssetPath(String(ref?.projectAssetUri || ''))
    if (!assetPath) continue
    byPath.set(assetPath, {
      assetPath,
      createdAt: String(ref?.createdAt || '').trim(),
      seed: ref?.seed,
      prompt: ref?.prompt,
      negativePrompt: ref?.negativePrompt,
      provider: ref?.provider,
      _refIndex: i
    })
  }

  for (let i = 0; i < batchAll.length; i += 1) {
    const item = batchAll[i]
    const assetPath = normalizeAssetPath(String(item?.assetPath || ''))
    if (!assetPath) continue
    const prev = byPath.get(assetPath) || {}
    byPath.set(assetPath, {
      ...prev,
      ...item,
      assetPath,
      createdAt: String(prev?.createdAt || item?.createdAt || '').trim(),
      _batchIndex: i
    })
  }

  if (primaryUri && !byPath.has(primaryUri)) {
    byPath.set(primaryUri, { assetPath: primaryUri, analysis: asset?.latestReferenceReview || null })
  }

  const all = Array.from(byPath.values())
  const latestFirst = all.slice().sort((a: any, b: any) => {
    const timeA = Date.parse(String(a?.createdAt || ''))
    const timeB = Date.parse(String(b?.createdAt || ''))
    if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeB - timeA
    if (Number.isFinite(timeA) && !Number.isFinite(timeB)) return -1
    if (!Number.isFinite(timeA) && Number.isFinite(timeB)) return 1
    const refIndexA = Number(a?._refIndex)
    const refIndexB = Number(b?._refIndex)
    if (Number.isFinite(refIndexA) && Number.isFinite(refIndexB) && refIndexA !== refIndexB) return refIndexB - refIndexA
    const batchIndexA = Number(a?._batchIndex)
    const batchIndexB = Number(b?._batchIndex)
    if (Number.isFinite(batchIndexA) && Number.isFinite(batchIndexB) && batchIndexA !== batchIndexB) return batchIndexA - batchIndexB
    return String(a?.assetPath || '').localeCompare(String(b?.assetPath || ''))
  })

  let display: any[] = []
  if (primaryUri) {
    const primary = latestFirst.find((item: any) => normalizeAssetPath(String(item?.assetPath || '')) === primaryUri) || null
    const others = latestFirst.filter((item: any) => normalizeAssetPath(String(item?.assetPath || '')) !== primaryUri)
    display = primary ? [primary, ...others.slice(0, 3)] : others.slice(0, 4)
    if (all.length <= 4) {
      display = primary ? [primary, ...others] : latestFirst.slice(0, 4)
    }
  } else {
    display = latestFirst.slice(0, 4)
  }

  return {
    all: latestFirst,
    display,
    overflow: Math.max(0, latestFirst.length - display.length)
  }
}

type AssetPromptDraft = {
  promptZh?: string
  promptEn?: string
  negativePromptZh?: string
  negativePrompt?: string
  promptReview?: {
    passed?: boolean
    score?: number
    summary?: string
    strengths?: string[]
    risks?: string[]
    suggestions?: string[]
  } | null
  enhancedAt?: string
  enhanceMode?: string
}

function assetPromptReviewTone(review: AssetPromptDraft['promptReview']) {
  const score = Number(review?.score)
  if (Number.isFinite(score) && score >= 70) return { cls: 'ok', color: '#a7f3d0' }
  if (Number.isFinite(score) && score >= 50) return { cls: 'pending', color: '#fde68a' }
  return { cls: 'bad', color: '#fca5a5' }
}

function summarizeStoryBible(raw: string) {
  const value = String(raw || '').trim()
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    const characters = Array.isArray(parsed?.characters) ? parsed.characters.length : 0
    const props = Array.isArray(parsed?.props) ? parsed.props.length : 0
    const locations = Array.isArray(parsed?.locations) ? parsed.locations.length : 0
    const worldAnchor = String(parsed?.worldAnchor || '').trim()
    return {
      characters,
      props,
      locations,
      hasWorldAnchor: Boolean(worldAnchor),
      worldAnchorPreview: worldAnchor ? worldAnchor.slice(0, 140) : '',
      invalid: false
    }
  } catch (_) {
    return {
      characters: 0,
      props: 0,
      locations: 0,
      hasWorldAnchor: false,
      worldAnchorPreview: '',
      invalid: true
    }
  }
}

export default function StoryboardLockWorkspace(props: {
  open: boolean
  projectId?: string
  value: AiBackgroundRequest & { entitySpec?: string; storyBibleJson?: string; globalPromptZh?: string; globalNegativePromptZh?: string }
  assetPlan: {
    assets: any[]
    scenes: any[]
    summary: { assetCount: number; sceneCount: number; refRequiredCount: number; refReadyCount: number; refMissingCount: number }
  } | null
  assetPromptDrafts?: Record<string, AssetPromptDraft>
  translatingScope?: string
  translateCountdownSec?: number
  promptOpBusy?: boolean
  assetPlanBusy: boolean
  assetGeneratingId?: string
  assetAnalyzingId?: string
  assetOptimizingId?: string
  assetSelectingId?: string
  assetLineartId?: string
  assetGallery?: { assetId: string; assetName: string; items: StoryAssetGalleryEntry[] } | null
  assetGalleryBusy: boolean
  assetGalleryDeletingPaths?: string[]
  assetConfirmReady: boolean
  assetConfirmSummary: string
  continuityReady: boolean
  continuitySummary: string
  busyEntity: boolean
  openChecks: {
    checking: boolean
    ok: boolean
    serverOk: boolean
    promptOk: boolean
    imageOk: boolean
    continuityBindingsOk: boolean
    summary: string
  }
  logs: string[]
  error?: string
  onClose: () => void
  onRunOpenChecks: () => void
  onGenerateEntity: () => void
  onBuildAssetPlan: () => void
  onGenerateAssetRef: (assetId: string, batchSize?: number) => void
  onGenerateAllMissingAssetRefs: () => void
  onAnalyzeAssetRef: (assetId: string) => void
  onOptimizeAssetRef: (assetId: string) => void
  onSelectAssetRef: (assetId: string, assetPath: string) => void
  onGenerateAssetLineart: (assetId: string) => void
  onOpenAssetGallery: (assetId: string) => void
  onCloseAssetGallery: () => void
  onSelectAssetGalleryPrimary: (assetId: string, assetPath: string) => void
  onDeleteAssetGalleryItems: (assetId: string, assetPaths: string[]) => void
  onDeleteAssetGalleryItem: (assetId: string, assetPath: string) => void
  onDeleteAssetFromPlan: (assetId: string) => void
  onConfirmAssetPlan: () => void
  onOpenRender: () => void
  onChangeGlobalPromptZh: (value: string) => void
  onChangeGlobalPromptEn: (value: string) => void
  onTranslateGlobalPrompt: () => void
  onChangeGlobalNegativePromptZh: (value: string) => void
  onChangeGlobalNegativePromptEn: (value: string) => void
  onTranslateGlobalNegativePrompt: () => void
  onChangeAssetPrompt: (assetId: string, patch: AssetPromptDraft) => void
  onTranslateAssetPromptPositive: (assetId: string) => void
  onTranslateAssetPromptNegative: (assetId: string) => void
}) {
  if (!props.open) return null
  const assetPlan = props.assetPlan || null
  const planAssets = Array.isArray(assetPlan?.assets) ? assetPlan.assets : []
  const storyBibleReady = Boolean(String((props.value as any)?.storyBibleJson || '').trim())
  const envReady = Boolean(props.openChecks?.ok)
  const primaryReadyCount = planAssets.filter((asset) => String(asset?.primaryReferenceAssetUri || '').trim()).length
  const lineartReadyCount = planAssets.filter((asset) => String(asset?.lineartFinalAssetUri || '').trim()).length
  const unlockedCount = planAssets.filter((asset) => String(asset?.renderStrategy || '').trim() === 'ref_required').filter((asset) => !String(asset?.primaryReferenceAssetUri || '').trim() || !String(asset?.lineartFinalAssetUri || '').trim()).length
  const missingBatchCount = planAssets.filter((asset) => String(asset?.renderStrategy || '').trim() === 'ref_required').filter((asset) => {
    const primary = String(asset?.primaryReferenceAssetUri || '').trim()
    const batch = Array.isArray(asset?.latestReferenceBatch) ? asset.latestReferenceBatch : []
    const refs = Array.isArray(asset?.generatedRefs) ? asset.generatedRefs : []
    return !primary && batch.length === 0 && refs.length === 0
  }).length
  const configuredLoras = Array.isArray((props.value as any)?.loras) ? (props.value as any).loras.map((x: any) => String(x || '').trim()).filter(Boolean) : []
  const [logsExpanded, setLogsExpanded] = React.useState(false)
  const [globalPromptsExpanded, setGlobalPromptsExpanded] = React.useState(false)
  const [storyBibleExpanded, setStoryBibleExpanded] = React.useState(false)
  const [gallerySelectedPaths, setGallerySelectedPaths] = React.useState<string[]>([])
  const promptOpBusy = Boolean(props.promptOpBusy)
  const translateCountdownSec = Number(props.translateCountdownSec || 0)
  const translateCountdownLabel = translateCountdownSec > 0 ? ` ${translateCountdownSec}s` : ''
  const storyBibleSummary = summarizeStoryBible(String((props.value as any)?.storyBibleJson || ''))

  React.useEffect(() => {
    setGallerySelectedPaths([])
  }, [props.assetGallery?.assetId])

  React.useEffect(() => {
    const allowed = new Set((props.assetGallery?.items || []).map((item) => String(item.assetPath || '').trim()).filter(Boolean))
    setGallerySelectedPaths((prev) => prev.filter((item) => allowed.has(item)))
  }, [props.assetGallery?.items])

  const galleryDeletingSet = React.useMemo(() => new Set((props.assetGalleryDeletingPaths || []).map((item) => String(item || '').trim()).filter(Boolean)), [props.assetGalleryDeletingPaths])

  return (
    <div className="ai-modal story-lock-workspace-overlay" role="dialog" aria-modal="true">
      <div className="story-lock-workspace-card">
        <div className="story-lock-workspace-head">
          <div className="story-lock-workspace-head-main">
            <div className="story-lock-workspace-titlebar">
              <div className="ai-modal-title" style={{ marginBottom: 0 }}>锁定事物</div>
              <div className={`ai-storyboard-status ${props.assetConfirmReady ? 'ok' : (unlockedCount > 0 ? 'bad' : 'ok')}`}>
                {props.assetConfirmReady ? '已完成锁定' : (unlockedCount > 0 ? '进行中' : '待确认')}
              </div>
            </div>
            <div className="story-lock-workspace-head-inline">
              <div className="story-lock-workspace-progress-inline">
                <div className={`ai-storyboard-gate-card compact ${envReady ? 'ok' : 'pending'}`}>
                  <div className="ai-storyboard-gate-title">1. 环境体检</div>
                  <div className="ai-storyboard-gate-value">{envReady ? '通过' : '未通过'}</div>
                </div>
                <div className={`ai-storyboard-gate-card compact ${storyBibleReady ? 'ok' : 'pending'}`}>
                  <div className="ai-storyboard-gate-title">2. Story Bible</div>
                  <div className="ai-storyboard-gate-value">{storyBibleReady ? '已生成' : '未生成'}</div>
                </div>
                <div className={`ai-storyboard-gate-card compact ${primaryReadyCount > 0 ? 'ok' : 'pending'}`}>
                  <div className="ai-storyboard-gate-title">3. 主参考锁定</div>
                  <div className="ai-storyboard-gate-value">{primaryReadyCount}/{planAssets.length || 0}</div>
                </div>
                <div className={`ai-storyboard-gate-card compact ${lineartReadyCount > 0 ? 'ok' : 'pending'}`}>
                  <div className="ai-storyboard-gate-title">4. 线稿锁定</div>
                  <div className="ai-storyboard-gate-value">{lineartReadyCount}/{planAssets.length || 0}</div>
                </div>
              </div>
              <div className="story-lock-workspace-meta-inline">
                <div className="story-lock-workspace-chip-row">
                  <span className="ai-storyboard-status ok">资产数: {assetPlan?.summary?.assetCount || planAssets.length}</span>
                  <span className={`ai-storyboard-status ${missingBatchCount ? 'bad' : 'ok'}`}>待抽卡: {missingBatchCount}</span>
                  <span className={`ai-storyboard-status ${unlockedCount ? 'bad' : 'ok'}`}>待锁定: {unlockedCount}</span>
                  <span className="ai-storyboard-status ok">LoRA: {configuredLoras.length ? configuredLoras.join(' | ') : '(none)'}</span>
                </div>
                <div className="story-lock-workspace-summary-main">{props.assetConfirmSummary}</div>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn secondary" type="button" onClick={props.onOpenRender} disabled={!props.assetConfirmReady}>进入正式场景出图</button>
            <button type="button" className="icon-btn" onClick={props.onClose} aria-label="关闭" title="关闭">✕</button>
          </div>
        </div>

        <div className="story-lock-workspace-controls">
          <button className="btn secondary" type="button" onClick={props.onRunOpenChecks} disabled={props.assetPlanBusy || props.busyEntity}>重新体检</button>
          <button className="btn secondary" type="button" onClick={props.onGenerateAllMissingAssetRefs} disabled={props.assetPlanBusy || !assetPlan || missingBatchCount === 0}>生成全部缺失参考图 ({missingBatchCount})</button>
          <button className="btn secondary" type="button" onClick={props.onConfirmAssetPlan} disabled={props.assetPlanBusy || !assetPlan || unlockedCount > 0}>{props.assetConfirmReady ? '已确认' : '确认锁定无误'}</button>
        </div>

        <div className="story-lock-global-prompts">
          <div className="story-lock-global-card story-lock-bible-card">
            <div className="story-lock-global-head story-lock-bible-head">
              <div className="story-lock-bible-intro">
                <div className="story-lock-workspace-log-title">Story Bible</div>
                <div className="hint">这里统一处理故事锁定前置数据。先生成 Story Bible，再生成资产计划；进入 AI 分镜后只读取结果，不再重复编辑。</div>
              </div>
              <div className="story-lock-bible-actions">
                <button className="btn secondary" type="button" onClick={() => setStoryBibleExpanded((v) => !v)}>{storyBibleExpanded ? '收起' : '展开'}</button>
                <button className="btn secondary" type="button" onClick={props.onGenerateEntity} disabled={props.assetPlanBusy || props.busyEntity}>
                  {props.busyEntity ? '生成中…' : (storyBibleReady ? '重新生成 Story Bible' : '生成 Story Bible')}
                </button>
                <button className="btn secondary" type="button" onClick={props.onBuildAssetPlan} disabled={props.assetPlanBusy || !storyBibleReady}>
                  {props.assetPlanBusy ? '处理中…' : '生成资产计划'}
                </button>
              </div>
            </div>
            <div className="story-lock-bible-summary">
              <div className="story-lock-workspace-chip-row">
                <span className={`ai-storyboard-status ${storyBibleReady ? 'ok' : 'pending'}`}>{storyBibleReady ? '已生成' : '未生成'}</span>
                {storyBibleSummary ? <span className={`ai-storyboard-status ${storyBibleSummary.invalid ? 'bad' : 'ok'}`}>{storyBibleSummary.invalid ? 'JSON 无法解析' : '结构可用'}</span> : null}
                {storyBibleSummary && !storyBibleSummary.invalid ? <span className="ai-storyboard-status ok">角色 {storyBibleSummary.characters}</span> : null}
                {storyBibleSummary && !storyBibleSummary.invalid ? <span className="ai-storyboard-status ok">道具 {storyBibleSummary.props}</span> : null}
                {storyBibleSummary && !storyBibleSummary.invalid ? <span className="ai-storyboard-status ok">地点 {storyBibleSummary.locations}</span> : null}
                {storyBibleSummary && !storyBibleSummary.invalid ? <span className={`ai-storyboard-status ${storyBibleSummary.hasWorldAnchor ? 'ok' : 'pending'}`}>世界锚点 {storyBibleSummary.hasWorldAnchor ? '已生成' : '缺失'}</span> : null}
              </div>
              {storyBibleExpanded ? (
                storyBibleSummary ? (
                  <div className="story-lock-bible-details">
                    {storyBibleSummary.worldAnchorPreview ? <div className="hint">世界锚点摘要：{storyBibleSummary.worldAnchorPreview}{storyBibleSummary.worldAnchorPreview.length >= 140 ? '…' : ''}</div> : null}
                    <div className="hint">
                      {storyBibleSummary.invalid
                        ? '当前 Story Bible 内容无法解析，建议重新生成。'
                        : '这份摘要会驱动后续资产计划、事物锁定和正式场景提示词。详细锁定处理统一留在当前界面。'}
                    </div>
                  </div>
                ) : (
                  <div className="hint">当前还没有 Story Bible。先生成它，后面的资产计划和锁定资产都会依赖这份前置数据。</div>
                )
              ) : null}
            </div>
          </div>
        </div>

        <div className="story-lock-workspace-log-section">
          <div className="story-lock-section-head">
            <div className="story-lock-workspace-log-title">日志</div>
            <button className="btn secondary" type="button" onClick={() => setLogsExpanded((v) => !v)}>{logsExpanded ? '收起' : '展开'}</button>
          </div>
          {logsExpanded ? (
            <div className="story-lock-workspace-log-box">
              {props.error ? <div className="hint" style={{ color: '#fca5a5', marginBottom: 8 }}>{props.error}</div> : null}
              <pre>{(props.logs || []).slice(-20).join('\n') || '暂无日志'}</pre>
            </div>
          ) : null}
        </div>

        <div className="story-lock-global-prompts">
          <div className="story-lock-global-card">
            <div className="story-lock-global-head">
              <div style={{ display: 'grid', gap: 6 }}>
                <div className="story-lock-workspace-log-title">全局提示词</div>
                <div className="story-lock-workspace-chip-row">
                  <span className={`ai-storyboard-status ${String((props.value as any)?.globalPromptZh || props.value?.globalPrompt || '').trim() ? 'ok' : 'bad'}`}>正向</span>
                  <span className={`ai-storyboard-status ${String((props.value as any)?.globalNegativePromptZh || props.value?.globalNegativePrompt || '').trim() ? 'ok' : 'bad'}`}>负向</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn secondary" type="button" onClick={() => setGlobalPromptsExpanded((v) => !v)}>{globalPromptsExpanded ? '收起' : '展开'}</button>
              </div>
            </div>
            {globalPromptsExpanded ? (
              <div className="story-lock-global-sections">
                <div className="story-lock-global-section">
                  <div className="story-lock-global-subhead">
                    <div className="story-lock-global-subtitle">全局正向提示词</div>
                    <button className="btn secondary" type="button" onClick={props.onTranslateGlobalPrompt} disabled={promptOpBusy}>{props.translatingScope === 'globalPrompt' ? `翻译中…${translateCountdownLabel}` : (promptOpBusy ? '请等待当前任务…' : '中文转英文')}</button>
                  </div>
                  <div className="story-lock-prompt-grid">
                    <label className="story-lock-prompt-field">
                      <span>中文</span>
                      <textarea className="story-lock-textarea" value={String((props.value as any)?.globalPromptZh || '')} onChange={(e) => props.onChangeGlobalPromptZh(e.target.value)} placeholder="在这里编辑中文全局正向提示词" />
                    </label>
                    <label className="story-lock-prompt-field">
                      <span>英文</span>
                      <textarea className="story-lock-textarea" value={String(props.value?.globalPrompt || '')} onChange={(e) => props.onChangeGlobalPromptEn(e.target.value)} placeholder="翻译后或手工编辑英文正向提示词" />
                    </label>
                  </div>
                </div>
                <div className="story-lock-global-section">
                  <div className="story-lock-global-subhead">
                    <div className="story-lock-global-subtitle">全局负向提示词</div>
                    <button className="btn secondary" type="button" onClick={props.onTranslateGlobalNegativePrompt} disabled={promptOpBusy}>{props.translatingScope === 'globalNegativePrompt' ? `翻译中…${translateCountdownLabel}` : (promptOpBusy ? '请等待当前任务…' : '中文转英文')}</button>
                  </div>
                  <div className="story-lock-prompt-grid">
                    <label className="story-lock-prompt-field">
                      <span>中文</span>
                      <textarea className="story-lock-textarea" value={String((props.value as any)?.globalNegativePromptZh || '')} onChange={(e) => props.onChangeGlobalNegativePromptZh(e.target.value)} placeholder="在这里编辑中文全局负向提示词" />
                    </label>
                    <label className="story-lock-prompt-field">
                      <span>英文</span>
                      <textarea className="story-lock-textarea" value={String(props.value?.globalNegativePrompt || '')} onChange={(e) => props.onChangeGlobalNegativePromptEn(e.target.value)} placeholder="翻译后或手工编辑英文负向提示词" />
                    </label>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="story-lock-workspace-assets">
          {planAssets.length ? planAssets.map((asset) => {
            const assetId = String(asset?.id || '').trim()
            const promptDraft = (props.assetPromptDrafts && props.assetPromptDrafts[assetId]) || {}
            const promptReview = promptDraft.promptReview || null
            const promptReviewTone = assetPromptReviewTone(promptReview)
            const promptEnhancedAt = String(promptDraft.enhancedAt || '').trim()
            const promptEnhanced = Boolean(promptEnhancedAt)
            const primaryUri = String(asset?.primaryReferenceAssetUri || '').trim()
            const { all: candidateAll, display: batch, overflow: batchOverflow } = buildDisplayedReferenceCandidates(asset)
            const lineartHintSrc = toProjectAssetUrl(String(props.projectId || ''), String(asset?.lineartHintAssetUri || '').trim())
            const lineartFinalSrc = toProjectAssetUrl(String(props.projectId || ''), String(asset?.lineartFinalAssetUri || '').trim())
            const bestScore = candidateAll.reduce((max: number | null, item: any) => {
              const s = scoreOf(item)
              if (s == null) return max
              return max == null ? s : Math.max(max, s)
            }, null)
            const selectedReview = (candidateAll.find((item: any) => normalizeAssetPath(String(item?.assetPath || '')) === normalizeAssetPath(primaryUri))?.analysis) || asset?.latestReferenceReview || null
            const selectedScore = Number(selectedReview?.score)
            const generating = props.assetGeneratingId === assetId
            const analyzing = props.assetAnalyzingId === assetId
            const optimizing = props.assetOptimizingId === assetId
            const selecting = props.assetSelectingId === assetId
            const linearting = props.assetLineartId === assetId
            const assetBusy = generating || analyzing || optimizing || selecting || linearting
            const needsRef = String(asset?.renderStrategy || '').trim() !== 'prompt_only'
            const translatingAssetPositive = props.translatingScope === `asset:positive:${assetId}`
            const translatingAssetNegative = props.translatingScope === `asset:negative:${assetId}`
            return (
              <div className="story-lock-asset-row" key={assetId}>
                <div className="story-lock-asset-candidate-strip">
                  {batch.length ? batch.map((candidate: any, idx: number) => {
                    const candidatePath = String(candidate?.assetPath || '').trim()
                    const candidateUrl = String(candidate?.url || '').trim()
                    const candidateSrc = candidateUrl ? toRuntimeUrl(candidateUrl) : toProjectAssetUrl(String(props.projectId || ''), candidatePath)
                    const candidateScore = scoreOf(candidate)
                    const selected = Boolean(candidatePath && candidatePath === primaryUri)
                    const recommended = Boolean(candidate?.recommended || (candidateScore != null && bestScore != null && candidateScore === bestScore))
                    return (
                      <div className={`story-lock-candidate-card ${selected ? 'selected' : ''}`} key={`${assetId}_${idx}`}>
                        <div className="story-lock-candidate-title">候选 {idx + 1}</div>
                        <div className={`ai-storyboard-asset-candidate-preview ${candidateSrc ? 'ready' : 'missing'}`}>
                          {candidateSrc ? <img src={candidateSrc} alt={`${String(asset?.name || assetId)}_${idx + 1}`} /> : <div className="hint">候选 {idx + 1}</div>}
                        </div>
                        <div className="story-lock-candidate-meta">
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span className="hint">#{idx + 1} {candidateScore != null ? `${candidateScore}/100` : '未评分'}</span>
                            {recommended ? <span className="ai-storyboard-status ok">推荐</span> : null}
                          </div>
                          <div className="hint">seed: {candidate?.seed != null ? String(candidate.seed) : '-'}</div>
                          <button className="btn secondary" type="button" onClick={() => props.onSelectAssetRef(assetId, candidatePath)} disabled={props.assetPlanBusy || Boolean(props.assetSelectingId) || assetBusy || !candidatePath || selected}>{selecting && selected ? '设置中…' : (selected ? '当前主参考' : '设为主参考')}</button>
                        </div>
                      </div>
                    )
                  }) : (
                    <div className="story-lock-candidate-card">
                      <div className="story-lock-candidate-title">候选</div>
                      <div className="ai-storyboard-asset-candidate-preview missing">
                        <div className="hint">待生成</div>
                      </div>
                      <div className="story-lock-candidate-meta">
                        <div className="hint">还没有候选图</div>
                      </div>
                    </div>
                  )}
                  <div className={`story-lock-candidate-card story-lock-candidate-card-lineart ${lineartHintSrc ? 'selected' : ''}`}>
                    <div className="story-lock-candidate-title">ControlNet Hint</div>
                    <div className={`ai-storyboard-asset-candidate-preview ${lineartHintSrc ? 'ready' : 'missing'}`}>
                      {lineartHintSrc ? <img src={lineartHintSrc} alt={`${String(asset?.name || assetId)}_hint`} /> : <div className="hint">待生成</div>}
                    </div>
                    <div className="story-lock-candidate-meta">
                      <div className="hint">{lineartHintSrc ? '已生成' : '待生成'}</div>
                    </div>
                  </div>
                  <div className={`story-lock-candidate-card story-lock-candidate-card-lineart ${lineartFinalSrc ? 'selected' : ''}`}>
                    <div className="story-lock-candidate-title">Final Lineart</div>
                    <div className={`ai-storyboard-asset-candidate-preview ${lineartFinalSrc ? 'ready' : 'missing'}`}>
                      {lineartFinalSrc ? <img src={lineartFinalSrc} alt={`${String(asset?.name || assetId)}_lineart`} /> : <div className="hint">待生成</div>}
                    </div>
                    <div className="story-lock-candidate-meta">
                      <div className="hint">{lineartFinalSrc ? '已生成' : '待生成'}</div>
                    </div>
                  </div>
                </div>

                <div className="story-lock-asset-detail">
                  <div className="story-lock-asset-info">
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                      <div style={{ fontWeight: 800, fontSize: 24 }}>{String(asset?.name || assetId || '未命名资产')}</div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <button
                          className="btn secondary"
                          type="button"
                          onClick={() => props.onDeleteAssetFromPlan(assetId)}
                          disabled={props.assetPlanBusy || !assetId}
                          title="从当前锁定事物计划中移除该资产"
                        >
                          删除此事物
                        </button>
                        <span className={`ai-storyboard-status ${String(asset?.primaryReferenceAssetUri || '').trim() ? 'ok' : 'bad'}`}>{getReferenceStatusLabel(String(asset?.referenceStatus || ''))}</span>
                        <span className={`ai-storyboard-status ${String(asset?.lineartFinalAssetUri || '').trim() ? 'ok' : 'bad'}`}>{String(asset?.lineartFinalAssetUri || '').trim() ? '线稿已生成' : '待生成线稿'}</span>
                      </div>
                    </div>
                    <div className="hint">{getAssetCategoryLabel(String(asset?.category || ''))} / 涉及 {Number(asset?.sceneCount || 0)} 个场景</div>
                    <div className="hint story-lock-score-summary">
                      {selectedScore === selectedScore ? `当前主参考评分：${Math.round(selectedScore)} / 100` : (bestScore === bestScore ? `当前批次最佳评分：${bestScore} / 100` : '当前还没有可评分主参考')}
                      {selectedReview?.summary ? `，${String(selectedReview.summary)}` : ''}
                    </div>
                    {String((asset?.generatedRefs?.[asset?.generatedRefs?.length - 1]?.negativePrompt) || '').trim() ? (
                      <div className="hint story-lock-score-summary">
                        当前抽卡会自动附加强负面提示词，已限制纯白背景、无道具、无场景、多主体等干扰项。
                      </div>
                    ) : null}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button className="btn secondary" type="button" onClick={() => props.onGenerateAssetRef(assetId, 1)} disabled={props.assetPlanBusy || assetBusy || !needsRef || !assetId}>{selecting ? '主参考处理中…' : (generating ? '抽卡中…' : '生成 1 张')}</button>
                      <button className="btn secondary" type="button" onClick={() => props.onGenerateAssetRef(assetId, 4)} disabled={props.assetPlanBusy || assetBusy || !needsRef || !assetId}>{selecting ? '主参考处理中…' : (generating ? '抽卡中…' : (batch.length ? '再出 4 张' : '生成 4 张参考图'))}</button>
                      <button className="btn secondary" type="button" onClick={() => props.onAnalyzeAssetRef(assetId)} disabled={props.assetPlanBusy || assetBusy || !String(asset?.primaryReferenceAssetUri || '').trim() || !assetId}>{selecting ? '主参考处理中…' : (analyzing ? '分析当前主参考中…' : '分析当前主参考')}</button>
                      <button className="btn secondary" type="button" onClick={() => props.onGenerateAssetLineart(assetId)} disabled={props.assetPlanBusy || assetBusy || !String(asset?.primaryReferenceAssetUri || '').trim() || !assetId}>{selecting ? '主参考处理中…' : (linearting ? '线稿生成中…' : '生成线稿')}</button>
                      <button className="btn secondary" type="button" onClick={() => props.onOpenAssetGallery(assetId)} disabled={props.assetPlanBusy || assetBusy || !assetId}>{selecting ? '主参考处理中…' : (props.assetGalleryBusy && props.assetGallery?.assetId === assetId ? '加载管理中…' : (batchOverflow > 0 ? `管理图片（更多 ${batchOverflow}）` : '管理图片'))}</button>
                    </div>
                  </div>

                  <div className="story-lock-asset-prompt-panel">
                    <div className="story-lock-global-head">
                      <div className="story-lock-workspace-log-title">提示词</div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          className="btn secondary"
                          type="button"
                          onClick={() => props.onOptimizeAssetRef(assetId)}
                          disabled={promptOpBusy || !assetId}
                          title={promptEnhanced ? `上次增强时间：${formatGalleryTime(promptEnhancedAt)}。再次增强会丢弃当前提示词内容，基于故事资产数据重新生成。` : '调用 AI 基于故事资产数据重新生成提示词'}
                        >
                          {optimizing ? '增强中…' : (promptOpBusy ? '请等待当前任务…' : (promptEnhanced ? '重新生成提示词' : 'AI增强提示词'))}
                        </button>
                      </div>
                    </div>
                    <div className="story-lock-prompt-stack">
                      {promptReview ? (
                        <div className="story-lock-prompt-section">
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                            <span className={`ai-storyboard-status ${promptReviewTone.cls}`}>
                              提示词评分：{Number.isFinite(Number(promptReview.score)) ? `${Math.round(Number(promptReview.score))}/100` : 'n/a'}
                            </span>
                            <span className="hint" style={{ color: promptReviewTone.color }}>
                              {String(promptReview.summary || '').trim() || '暂无说明'}
                            </span>
                          </div>
                          {Array.isArray(promptReview.risks) && promptReview.risks.length ? (
                            <div className="hint" style={{ color: '#fca5a5', marginBottom: 6 }}>
                              风险：{promptReview.risks.slice(0, 3).join('；')}
                            </div>
                          ) : null}
                          {Array.isArray(promptReview.suggestions) && promptReview.suggestions.length ? (
                            <div className="hint">
                              建议：{promptReview.suggestions.slice(0, 3).join('；')}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="story-lock-prompt-section">
                        <div className="story-lock-global-subhead">
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <div className="story-lock-global-subtitle">正向提示词</div>
                            {promptReview ? (
                              <span className={`ai-storyboard-status ${promptReviewTone.cls}`}>
                                评分 {Number.isFinite(Number(promptReview.score)) ? `${Math.round(Number(promptReview.score))}/100` : 'n/a'}
                              </span>
                            ) : null}
                          </div>
                          <button className="btn secondary" type="button" onClick={() => props.onTranslateAssetPromptPositive(assetId)} disabled={promptOpBusy}>{translatingAssetPositive ? `翻译中…${translateCountdownLabel}` : (promptOpBusy ? '请等待当前任务…' : '中转英')}</button>
                        </div>
                        <div className="story-lock-prompt-grid">
                          <label className="story-lock-prompt-field">
                            <span>中文</span>
                            <textarea className="story-lock-textarea compact-rows" value={String(promptDraft.promptZh || '')} onChange={(e) => props.onChangeAssetPrompt(assetId, { promptZh: e.target.value })} placeholder="先点“AI增强提示词”，再按需要微调中文正向提示词" />
                          </label>
                          <label className="story-lock-prompt-field">
                            <span>英文</span>
                            <textarea className="story-lock-textarea compact-rows" value={String(promptDraft.promptEn || asset?.referencePromptHint || '')} onChange={(e) => props.onChangeAssetPrompt(assetId, { promptEn: e.target.value })} placeholder="翻译后或手工编辑英文正向提示词" />
                          </label>
                        </div>
                      </div>
                      <div className="story-lock-prompt-section">
                        <div className="story-lock-global-subhead">
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <div className="story-lock-global-subtitle">反向提示词</div>
                            {promptReview ? (
                              <span className={`ai-storyboard-status ${promptReviewTone.cls}`}>
                                评分 {Number.isFinite(Number(promptReview.score)) ? `${Math.round(Number(promptReview.score))}/100` : 'n/a'}
                              </span>
                            ) : null}
                          </div>
                          <button className="btn secondary" type="button" onClick={() => props.onTranslateAssetPromptNegative(assetId)} disabled={promptOpBusy}>{translatingAssetNegative ? `翻译中…${translateCountdownLabel}` : (promptOpBusy ? '请等待当前任务…' : '中转英')}</button>
                        </div>
                        <div className="story-lock-prompt-grid">
                          <label className="story-lock-prompt-field">
                            <span>中文</span>
                            <textarea className="story-lock-textarea compact-rows" value={String(promptDraft.negativePromptZh || '')} onChange={(e) => props.onChangeAssetPrompt(assetId, { negativePromptZh: e.target.value })} placeholder="这里编辑该事物专属的中文反向提示词" />
                          </label>
                          <label className="story-lock-prompt-field">
                            <span>英文</span>
                            <textarea className="story-lock-textarea compact-rows" value={String(promptDraft.negativePrompt || asset?.referenceNegativePrompt || asset?.negativePrompt || '')} onChange={(e) => props.onChangeAssetPrompt(assetId, { negativePrompt: e.target.value })} placeholder="翻译后或手工编辑英文反向提示词" />
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          }) : (
            <div className="hint">尚未生成资产计划。请先生成 Story Bible，再生成资产计划。</div>
          )}
        </div>

        {props.assetGallery ? (
          <div className="story-lock-gallery-overlay" role="dialog" aria-modal="true" aria-label="图片管理">
            <div className="story-lock-gallery-card">
              <div className="story-lock-gallery-head">
                <div>
                  <div className="story-lock-workspace-log-title">图片管理</div>
                  <div className="hint">{String(props.assetGallery.assetName || props.assetGallery.assetId || '未命名资产')}</div>
                </div>
                <button className="icon-btn" type="button" onClick={props.onCloseAssetGallery} disabled={galleryDeletingSet.size > 0} aria-label="关闭图片管理" title="关闭图片管理">✕</button>
              </div>
              <div className="story-lock-gallery-summary">
                <span className="ai-storyboard-status ok">共 {Array.isArray(props.assetGallery.items) ? props.assetGallery.items.length : 0} 张</span>
                <span className="ai-storyboard-status">{gallerySelectedPaths.length ? `已选择 ${gallerySelectedPaths.length} 张` : '未选择'}</span>
                <span className="hint">支持批量选择删除，也可直接在这里设为主参考。布局固定，不会因删图而拉伸。</span>
                <div className="story-lock-gallery-toolbar">
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => {
                      const items = Array.isArray(props.assetGallery?.items) ? props.assetGallery.items : []
                      if (!items.length) return
                      const allPaths = items.map((item) => String(item.assetPath || '').trim()).filter(Boolean)
                      const next = gallerySelectedPaths.length === allPaths.length ? [] : allPaths
                      setGallerySelectedPaths(next)
                    }}
                    disabled={galleryDeletingSet.size > 0 || !props.assetGallery?.items?.length}
                  >
                    {gallerySelectedPaths.length && gallerySelectedPaths.length === (props.assetGallery?.items?.length || 0) ? '取消全选' : '全选'}
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => setGallerySelectedPaths([])}
                    disabled={galleryDeletingSet.size > 0 || gallerySelectedPaths.length === 0}
                  >
                    清空选择
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => {
                      const paths = gallerySelectedPaths.filter(Boolean)
                      if (!paths.length) return
                      if (!window.confirm(`确定删除选中的 ${paths.length} 张图片吗？`)) return
                      props.onDeleteAssetGalleryItems(props.assetGallery!.assetId, paths)
                    }}
                    disabled={props.assetPlanBusy || galleryDeletingSet.size > 0 || gallerySelectedPaths.length === 0}
                  >
                    {galleryDeletingSet.size > 1 ? `批量删除中…(${galleryDeletingSet.size})` : `删除选中 (${gallerySelectedPaths.length})`}
                  </button>
                </div>
              </div>
                <div className="story-lock-gallery-grid">
                  {Array.isArray(props.assetGallery.items) && props.assetGallery.items.length ? props.assetGallery.items.map((item) => {
                  const itemPath = String(item.assetPath || '').trim()
                  const deleting = galleryDeletingSet.has(itemPath)
                  const checked = gallerySelectedPaths.includes(itemPath)
                  const galleryItemUrl = String(item.url || '').trim()
                  const galleryItemSrc = galleryItemUrl ? resolveUrl(galleryItemUrl) : ''
                  return (
                    <div className={`story-lock-gallery-item ${checked ? 'selected' : ''}`} key={itemPath}>
                      <label className="story-lock-gallery-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={deleting || galleryDeletingSet.size > 0}
                          onChange={(e) => {
                            setGallerySelectedPaths((prev) => {
                              const next = new Set(prev)
                              if (e.target.checked) next.add(itemPath)
                              else next.delete(itemPath)
                              return Array.from(next)
                            })
                          }}
                        />
                        <span>选择</span>
                      </label>
                      <div className={`ai-storyboard-asset-candidate-preview ${galleryItemSrc ? 'ready' : 'missing'}`}>
                        {galleryItemSrc ? <img src={galleryItemSrc} alt={String(item.label || item.assetPath || 'gallery_item')} /> : <div className="hint">图片不可用</div>}
                      </div>
                      <div className="story-lock-gallery-meta">
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                          <div className="story-lock-gallery-kind">{String(item.label || '图片')}</div>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            {item.isPrimary ? <span className="ai-storyboard-status ok">当前主参考</span> : null}
                            {item.isCurrentLineart ? <span className="ai-storyboard-status ok">当前线稿</span> : null}
                            {item.recommended ? <span className="ai-storyboard-status ok">推荐</span> : null}
                            {item.inLatestBatch ? <span className="ai-storyboard-status">本轮候选</span> : null}
                          </div>
                        </div>
                        <div className="hint">{formatGalleryTime(String(item.createdAt || '')) || '时间未知'}</div>
                        <div className="hint">{item.seed != null ? `seed: ${String(item.seed)}` : '无 seed'}</div>
                        <div className="story-lock-gallery-actions">
                          <button className="btn secondary" type="button" onClick={() => window.open(galleryItemSrc, '_blank', 'noopener,noreferrer')} disabled={!galleryItemSrc}>查看大图</button>
                          <button
                            className="btn secondary"
                            type="button"
                            onClick={() => props.onSelectAssetGalleryPrimary(props.assetGallery!.assetId, itemPath)}
                            disabled={props.assetPlanBusy || galleryDeletingSet.size > 0 || !itemPath || Boolean(item.isPrimary) || Boolean(props.assetSelectingId)}
                          >
                            {props.assetSelectingId === props.assetGallery?.assetId && item.isPrimary ? '设置中…' : (item.isPrimary ? '当前主参考' : '设为主参考')}
                          </button>
                          <button
                            className="btn secondary"
                            type="button"
                            onClick={() => {
                              if (!window.confirm(`确定删除这张图片吗？\n${itemPath}`)) return
                              props.onDeleteAssetGalleryItem(props.assetGallery!.assetId, itemPath)
                            }}
                            disabled={props.assetPlanBusy || deleting}
                          >
                            {deleting ? '删除中…' : '删除'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                }) : (
                  <div className="hint">当前资产还没有可管理的图片。</div>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
