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

type AssetPromptDraft = {
  promptZh?: string
  promptEn?: string
  negativePromptZh?: string
  negativePrompt?: string
  enhancedAt?: string
  enhanceMode?: string
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
  assetPlanBusy: boolean
  assetGeneratingId?: string
  assetAnalyzingId?: string
  assetOptimizingId?: string
  assetSelectingId?: string
  assetLineartId?: string
  assetGallery?: { assetId: string; assetName: string; items: StoryAssetGalleryEntry[] } | null
  assetGalleryBusy: boolean
  assetGalleryDeletingPath?: string
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
  onDeleteAssetGalleryItem: (assetId: string, assetPath: string) => void
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
            <button className="btn secondary" type="button" onClick={props.onOpenRender} disabled={!props.assetConfirmReady}>进入正确出图</button>
            <button type="button" className="icon-btn" onClick={props.onClose} aria-label="关闭" title="关闭">✕</button>
          </div>
        </div>

        <div className="story-lock-workspace-controls">
          <button className="btn secondary" type="button" onClick={props.onRunOpenChecks} disabled={props.assetPlanBusy || props.busyEntity}>重新体检</button>
          <button className="btn secondary" type="button" onClick={props.onGenerateEntity} disabled={props.assetPlanBusy || props.busyEntity}>{props.busyEntity ? '生成中…' : '生成 Story Bible'}</button>
          <button className="btn secondary" type="button" onClick={props.onBuildAssetPlan} disabled={props.assetPlanBusy || !storyBibleReady}>{props.assetPlanBusy ? '处理中…' : '生成资产计划'}</button>
          <button className="btn secondary" type="button" onClick={props.onGenerateAllMissingAssetRefs} disabled={props.assetPlanBusy || !assetPlan || missingBatchCount === 0}>生成全部缺失参考图 ({missingBatchCount})</button>
          <button className="btn secondary" type="button" onClick={props.onConfirmAssetPlan} disabled={props.assetPlanBusy || !assetPlan || unlockedCount > 0}>{props.assetConfirmReady ? '已确认' : '确认锁定无误'}</button>
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
                    <button className="btn secondary" type="button" onClick={props.onTranslateGlobalPrompt} disabled={props.assetPlanBusy || props.translatingScope === 'globalPrompt'}>{props.translatingScope === 'globalPrompt' ? '翻译中…' : '中文转英文'}</button>
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
                    <button className="btn secondary" type="button" onClick={props.onTranslateGlobalNegativePrompt} disabled={props.assetPlanBusy || props.translatingScope === 'globalNegativePrompt'}>{props.translatingScope === 'globalNegativePrompt' ? '翻译中…' : '中文转英文'}</button>
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
            const promptEnhancedAt = String(promptDraft.enhancedAt || '').trim()
            const promptEnhanced = Boolean(promptEnhancedAt)
            const batch = Array.isArray(asset?.latestReferenceBatch) ? asset.latestReferenceBatch.slice(0, 4) : []
            const primaryUri = String(asset?.primaryReferenceAssetUri || '').trim()
            const lineartHintSrc = toProjectAssetUrl(String(props.projectId || ''), String(asset?.lineartHintAssetUri || '').trim())
            const lineartFinalSrc = toProjectAssetUrl(String(props.projectId || ''), String(asset?.lineartFinalAssetUri || '').trim())
            const bestScore = batch.reduce((max: number | null, item: any) => {
              const s = scoreOf(item)
              if (s == null) return max
              return max == null ? s : Math.max(max, s)
            }, null)
            const selectedReview = (batch.find((item: any) => String(item?.assetPath || '').trim() === primaryUri)?.analysis) || asset?.latestReferenceReview || null
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
                  {Array.from({ length: 4 }).map((_, idx) => {
                    const candidate = batch[idx] || null
                    const candidatePath = String(candidate?.assetPath || '').trim()
                    const candidateSrc = toProjectAssetUrl(String(props.projectId || ''), candidatePath)
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
                  })}
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
                      <button className="btn secondary" type="button" onClick={() => props.onOpenAssetGallery(assetId)} disabled={props.assetPlanBusy || assetBusy || !assetId}>{selecting ? '主参考处理中…' : (props.assetGalleryBusy && props.assetGallery?.assetId === assetId ? '加载管理中…' : '管理图片')}</button>
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
                          disabled={props.assetPlanBusy || assetBusy || !assetId}
                          title={promptEnhanced ? `上次增强时间：${formatGalleryTime(promptEnhancedAt)}。可继续再次增强。` : '调用 AI 根据当前事物重写并增强提示词'}
                        >
                          {selecting ? '主参考处理中…' : (optimizing ? '增强中…' : (promptEnhanced ? '再次增强' : 'AI增强提示词'))}
                        </button>
                      </div>
                    </div>
                    <div className="story-lock-prompt-stack">
                      <div className="story-lock-prompt-section">
                        <div className="story-lock-global-subhead">
                          <div className="story-lock-global-subtitle">正向提示词</div>
                          <button className="btn secondary" type="button" onClick={() => props.onTranslateAssetPromptPositive(assetId)} disabled={props.assetPlanBusy || assetBusy || translatingAssetPositive}>{selecting ? '主参考处理中…' : (translatingAssetPositive ? '翻译中…' : '中转英')}</button>
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
                          <div className="story-lock-global-subtitle">反向提示词</div>
                          <button className="btn secondary" type="button" onClick={() => props.onTranslateAssetPromptNegative(assetId)} disabled={props.assetPlanBusy || assetBusy || translatingAssetNegative}>{selecting ? '主参考处理中…' : (translatingAssetNegative ? '翻译中…' : '中转英')}</button>
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
                <button className="icon-btn" type="button" onClick={props.onCloseAssetGallery} disabled={Boolean(props.assetGalleryDeletingPath)} aria-label="关闭图片管理" title="关闭图片管理">✕</button>
              </div>
              <div className="story-lock-gallery-summary">
                <span className="ai-storyboard-status ok">共 {Array.isArray(props.assetGallery.items) ? props.assetGallery.items.length : 0} 张</span>
                <span className="hint">这里只做已生成图片浏览与删除，删除时会同步清理关联。</span>
              </div>
                <div className="story-lock-gallery-grid">
                  {Array.isArray(props.assetGallery.items) && props.assetGallery.items.length ? props.assetGallery.items.map((item) => {
                  const deleting = String(props.assetGalleryDeletingPath || '').trim() === String(item.assetPath || '').trim()
                  const galleryItemUrl = String(item.url || '').trim()
                  const galleryItemSrc = galleryItemUrl ? resolveUrl(galleryItemUrl) : ''
                  return (
                    <div className="story-lock-gallery-item" key={String(item.assetPath || '')}>
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
                            onClick={() => {
                              if (!window.confirm(`确定删除这张图片吗？\n${String(item.assetPath || '')}`)) return
                              props.onDeleteAssetGalleryItem(props.assetGallery!.assetId, String(item.assetPath || '').trim())
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
