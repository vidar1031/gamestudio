import React, { useState } from 'react'
import { resolveUrl, type AiBackgroundRequest, type StoryboardPromptQualityReview } from './api'

export type StoryboardBatchItem = {
  nodeId: string
  nodeName: string
  userInput: string
  promptZh?: string
  prompt: string
  negativePromptZh?: string
  negativePrompt: string
  promptReview?: StoryboardPromptQualityReview | null
  status?: 'idle' | 'generating' | 'generated' | 'applying' | 'applied' | 'error'
  note?: string
}

function getDoubaoDefaultSize(aspectRatio: string) {
  const ar = String(aspectRatio || '').trim()
  if (ar === '16:9') return '2560x1440'
  if (ar === '1:1') return '1920x1920'
  if (ar === '9:1') return '6480x720'
  return '1440x2560'
}

function getDoubaoOrientationLabel(aspectRatio: string) {
  const ar = String(aspectRatio || '').trim()
  if (ar === '16:9' || ar === '9:1') return '横图'
  if (ar === '1:1') return '方图'
  return '竖图'
}

function isDoubaoDefaultSize(size: string) {
  const s = String(size || '').trim()
  return Boolean(s) && ['1440x2560', '2560x1440', '1920x1920', '6480x720'].includes(s)
}

function parseLoraList(raw: string) {
  return String(raw || '')
    .split(/[\n,]/)
    .map((x) => String(x || '').trim())
    .filter(Boolean)
}

function getPromptReviewTone(review: StoryboardPromptQualityReview | null | undefined) {
  const verdict = String(review?.ai?.verdict || '').trim()
  if (verdict === 'ok') return { cls: 'ok', color: '#a7f3d0' }
  if (verdict === 'error') return { cls: 'bad', color: '#fca5a5' }
  return { cls: 'pending', color: '#fde68a' }
}

export default function AiStoryboardBatchModal(props: {
  open: boolean
  projectId?: string
  value: AiBackgroundRequest & { entitySpec?: string; storyBibleJson?: string; globalPromptZh?: string; globalNegativePromptZh?: string }
  items: StoryboardBatchItem[]
  busyGenerate: boolean
  busyApply: boolean
  busyEntity: boolean
  entityElapsedMs?: number
  continuityReady: boolean
  continuitySummary: string
  continuityBusy: boolean
  assetPlan: {
    assets: any[]
    scenes: any[]
    summary: { assetCount: number; sceneCount: number; refRequiredCount: number; refReadyCount: number; refMissingCount: number }
  } | null
  assetPlanBusy: boolean
  assetGeneratingId?: string
  assetAnalyzingId?: string
  assetOptimizingId?: string
  assetConfirmReady: boolean
  assetConfirmSummary: string
  openChecks: {
    checking: boolean
    checkedAt: string
    ok: boolean
    serverOk: boolean
    promptOk: boolean
    imageOk: boolean
    continuityBindingsOk: boolean
    promptProvider: string
    promptModel: string
    imageProvider: string
    imageModel: string
    summary: string
    issues: string[]
    details: string[]
  }
  continuityConfig: {
    ipadapterEnabled: boolean
    requireCharacterRefs: boolean
    controlnetEnabled: boolean
  }
  characters: Array<{
    id: string
    name: string
    fingerprintPrompt: string
    referenceAssetId: string
    hasSprite: boolean
  }>
  elapsedMs: number
  generatingNodeId?: string
  generatingNodeElapsedMs?: number
  testSceneId?: string
  error: string
  logs: string[]
  translatingScope?: string
  translateCountdownSec?: number
  promptOpBusy?: boolean
  onRunOpenChecks: () => void
  onChangeTestSceneId: (nodeId: string) => void
  onChange: (next: AiBackgroundRequest) => void
  onChangeGlobalPromptZh: (value: string) => void
  onChangeGlobalPromptEn: (value: string) => void
  onTranslateGlobalPrompt: () => void
  onChangeGlobalNegativePromptZh: (value: string) => void
  onChangeGlobalNegativePromptEn: (value: string) => void
  onTranslateGlobalNegativePrompt: () => void
  onChangeItem: (nodeId: string, patch: Partial<StoryboardBatchItem>) => void
  globalPromptReview: StoryboardPromptQualityReview | null
  globalPromptReviewBusy: boolean
  promptReviewingNodeId?: string
  onReviewGlobalPrompt: () => void
  onApplyGlobalPromptReview: () => void
  onReviewItemPrompt: (nodeId: string) => void
  onApplyItemPromptReview: (nodeId: string) => void
  onClearGlobalPrompt: () => void
  onClearGlobalNegativePrompt: () => void
  onClose: () => void
  onGenerateEntity: () => void
  onClearStoryBible: () => void
  onBuildAssetPlan: () => void
  onGenerateAssetRef: (assetId: string) => void
  onAnalyzeAssetRef: (assetId: string) => void
  onOptimizeAssetRef: (assetId: string) => void
  onGenerateAllMissingAssetRefs: () => void
  onConfirmAssetPlan: () => void
  onRunContinuityTest: () => void
  onChangeContinuityConfig: (patch: Partial<{ ipadapterEnabled: boolean; requireCharacterRefs: boolean; controlnetEnabled: boolean }>) => void
  onGenerateCharacterRef: (characterId: string) => void
  onBindCharacterRefFromSprite: (characterId: string) => void
  onClearCharacterRef: (characterId: string) => void
  onGenerateAll: () => void
  onRetryPending: () => void
  onApplyAll: () => void
  canApplyAll: boolean
  onRetryApplyPending: () => void
  queuePhase: 'idle' | 'generate' | 'apply'
  queuePaused: boolean
  onPauseQueue: () => void
  onResumeQueue: () => void
  onCancelQueue: () => void
}) {
  const v = props.value
  const busy = props.busyGenerate || props.busyApply || props.busyEntity || props.assetPlanBusy
  const openChecks = props.openChecks || {
    checking: false,
    checkedAt: '',
    ok: false,
    serverOk: false,
    promptOk: false,
    imageOk: false,
    continuityBindingsOk: false,
    promptProvider: '',
    imageProvider: '',
    summary: '',
    issues: [],
    details: []
  }
  const canGenerateEntity = !busy && props.items.length > 0 && openChecks.serverOk && openChecks.promptOk
  const envReady = openChecks.ok
  const imageProvider = String(openChecks.imageProvider || '').toLowerCase()
  const promptProvider = String(openChecks.promptProvider || '').toLowerCase()
  const isDoubaoImage = imageProvider === 'doubao'
  const isDoubaoWorkflow = isDoubaoImage && promptProvider === 'doubao'
  const isComfyuiImage = imageProvider === 'comfyui'
  const assetPlan = props.assetPlan || null
  const planAssets = Array.isArray(assetPlan?.assets) ? assetPlan.assets : []
  const requiredMissingAssets = planAssets.filter((asset) => String(asset?.renderStrategy || '').trim() === 'ref_required' && String(asset?.referenceStatus || '').trim() !== 'ready')
  const doubaoDefaultSize = getDoubaoDefaultSize(String(v.aspectRatio || '9:16'))
  const doubaoOrientation = getDoubaoOrientationLabel(String(v.aspectRatio || '9:16'))
  const scenePromptReadyCount = props.items.filter((item) => Boolean(String(item.promptZh || '').trim()) && Boolean(String(item.prompt || '').trim())).length
  const canGenerateAll = !busy && envReady && props.assetConfirmReady && props.items.length > 0
  const canRetryGenerate = !busy && envReady && props.assetConfirmReady && props.items.some((x) => x.status === 'error' || !String(x.prompt || '').trim() || !String(x.promptZh || '').trim())
  const canApplyAll = !busy && envReady && props.assetConfirmReady && props.continuityReady && props.canApplyAll
  const canRetryApply = !busy && envReady && props.assetConfirmReady && props.continuityReady && props.items.some((x) => x.status === 'error' || x.status === 'generated')
  const imageModelLabel = isComfyuiImage
    ? String((v as any).model || '').trim() || String(openChecks.imageModel || '').trim() || '(在本面板填写)'
    : String(openChecks.imageModel || '').trim()
  const storyBibleReady = Boolean(String((v as any).storyBibleJson || '').trim())
  const sceneRenderOpenReady = envReady && props.assetConfirmReady
  const sceneRenderReady = sceneRenderOpenReady && props.continuityReady
  const configuredLoras = Array.isArray((v as any).loras) ? (v as any).loras.map((x: any) => String(x || '').trim()).filter(Boolean) : []
  const assetPlanReady = Boolean(assetPlan && planAssets.length > 0)
  const readyAssetCount = planAssets.filter((asset) => String(asset?.referenceStatus || '').trim() === 'ready').length
  const requiredAssetCount = planAssets.filter((asset) => String(asset?.renderStrategy || '').trim() === 'ref_required').length
  const readyRequiredAssetCount = planAssets.filter((asset) => String(asset?.renderStrategy || '').trim() === 'ref_required' && String(asset?.referenceStatus || '').trim() === 'ready').length
  const readySceneAssetLockCount = planAssets.filter((asset) => String(asset?.category || '').trim() !== 'character' && String(asset?.primaryReferenceAssetUri || '').trim()).length
  const characterRefReadyCount = props.characters.filter((character) => String(character?.referenceAssetId || '').trim()).length
  const globalPromptReady = Boolean(String(v.globalPrompt || '').trim() || String((v as any).globalPromptZh || '').trim())
  const testSceneOptions = props.items.map((item, index) => ({
    nodeId: String(item.nodeId || '').trim(),
    label: `#${index + 1}`,
    name: String(item.nodeName || item.nodeId || '').trim()
  })).filter((item) => item.nodeId)
  const selectedTestSceneId = String(props.testSceneId || testSceneOptions[0]?.nodeId || '').trim()
  const selectedTestScene = testSceneOptions.find((item) => item.nodeId === selectedTestSceneId) || testSceneOptions[0] || null
  const selectedTestSceneItem = props.items.find((item) => String(item.nodeId || '').trim() === selectedTestSceneId) || null
  const selectedTestScenePromptReady = Boolean(String(selectedTestSceneItem?.promptZh || '').trim()) && Boolean(String(selectedTestSceneItem?.prompt || '').trim())
  const canRunContinuityTest = !busy && !props.continuityBusy && openChecks.serverOk && openChecks.imageOk && props.assetConfirmReady && selectedTestScenePromptReady
  const lockSteps: Array<{
    id: string
    kind: 'env' | 'bible' | 'assets' | 'test' | 'ready'
    label: string
    state: 'ok' | 'warn' | 'pending'
    value: string
    actionLabel?: string
    onAction?: () => void
    actionDisabled?: boolean
  }> = [
    {
      id: 'env',
      kind: 'env',
      label: '环境',
      state: envReady ? 'ok' : 'pending',
      value: envReady ? '通过' : '未通过',
      actionLabel: envReady ? '' : (openChecks.checking ? '检查中…' : '检查'),
      onAction: props.onRunOpenChecks,
      actionDisabled: busy || openChecks.checking
    },
    { id: 'bible', kind: 'bible', label: 'Bible', state: storyBibleReady ? 'ok' : 'pending', value: storyBibleReady ? '已生成' : '未生成' },
    { id: 'assets', kind: 'assets', label: '资产', state: props.assetConfirmReady ? 'ok' : (assetPlanReady ? 'warn' : 'pending'), value: props.assetConfirmReady ? `${readyAssetCount}/${planAssets.length}` : (assetPlanReady ? '待确认' : '未生成') },
    {
      id: 'test',
      kind: 'test',
      label: '场景测试',
      state: props.continuityReady ? 'ok' : (scenePromptReadyCount > 0 ? 'warn' : 'pending'),
      value: props.continuityReady ? '通过' : (scenePromptReadyCount > 0 ? '待运行' : '先生成提示词')
    }
  ] as const
  const primaryAction = (() => {
    if (!envReady) {
      return {
        kind: 'env' as const,
        label: openChecks.checking ? '检查中…' : '先修复环境体检',
        hint: '先确保 server、文本模型、生图模型和连续性依赖可用。',
        onClick: props.onRunOpenChecks,
        disabled: busy || openChecks.checking
      }
    }
    if (!storyBibleReady) {
      return {
        kind: 'bible' as const,
        label: props.busyEntity ? '生成中…' : (isDoubaoWorkflow ? '先生成连续性 Bible' : '先生成 Story Bible'),
        hint: '先生成角色、地点、道具的全文锚点，后面所有锁定和正式出图都依赖这一步。',
        onClick: props.onGenerateEntity,
        disabled: !canGenerateEntity
      }
    }
    if (!assetPlanReady) {
      return {
        kind: 'assets' as const,
        label: props.assetPlanBusy ? '处理中…' : '先生成资产计划',
        hint: '把 Story Bible 映射成当前故事真正需要锁定的角色、道具和地点。',
        onClick: props.onBuildAssetPlan,
        disabled: busy || !storyBibleReady
      }
    }
    if (!props.assetConfirmReady) {
      if (requiredMissingAssets.length > 0) {
        return {
          kind: 'assets' as const,
          label: `先补齐参考资产 (${requiredMissingAssets.length})`,
          hint: '还有必要事物没有可用主参考，先补齐候选图并完成确认。',
          onClick: props.onGenerateAllMissingAssetRefs,
          disabled: busy || requiredMissingAssets.length === 0
        }
      }
      return {
        kind: 'assets' as const,
        label: '确认锁定无误',
        hint: '所有必要事物已具备参考，请人工确认后再运行场景测试。',
        onClick: props.onConfirmAssetPlan,
        disabled: busy || !assetPlanReady
      }
    }
    if (scenePromptReadyCount === 0) {
      return {
        kind: 'test' as const,
        label: '先生成场景提示词',
        hint: '场景图测试之前必须先生成各场景的中英文提示词。',
        onClick: props.onGenerateAll,
        disabled: !canGenerateAll
      }
    }
    if (!props.continuityReady) {
      return {
        kind: 'test' as const,
        label: '先运行场景测试',
        hint: selectedTestScenePromptReady ? '当前测试场景已有中英文提示词，可直接运行场景测试。' : '请先给当前测试场景生成中英文提示词，再运行场景测试。',
        onClick: props.onRunContinuityTest,
        disabled: !canRunContinuityTest
      }
    }
    return {
      kind: 'ready' as const,
      label: '已可正式出图',
      hint: '下方正式场景出图区已可直接生成提示词并批量出图。',
      onClick: props.onGenerateAll,
      disabled: !canGenerateAll
    }
  })()
  const [lockLogsExpanded, setLockLogsExpanded] = useState(false)
  const [baseParamsExpanded, setBaseParamsExpanded] = useState(false)
  const [globalPromptsExpanded, setGlobalPromptsExpanded] = useState(false)
  const [renderPanelExpanded, setRenderPanelExpanded] = useState(true)
  const [renderLogsExpanded, setRenderLogsExpanded] = useState(false)
  const logPreview = props.logs.length ? props.logs.slice(-3).join('\n') : '(暂无日志)'
  const fullLogs = props.logs.length ? props.logs.join('\n') : '暂无日志'
  const promptOpBusy = Boolean(props.promptOpBusy)
  const translateCountdownSec = Number(props.translateCountdownSec || 0)
  const translateCountdownLabel = translateCountdownSec > 0 ? ` ${translateCountdownSec}s` : ''

  if (!props.open) return null

  return (
    <div className="ai-modal" role="dialog" aria-modal="true">
      <div
        className="ai-modal-card ai-background-modal-card ai-storyboard-modal-card"
        style={{ width: 'calc(100vw - 16px)', height: 'calc(100vh - 16px)', maxHeight: 'calc(100vh - 16px)' }}
      >
        <div className="ai-storyboard-head">
          <div className="ai-storyboard-titlebar">
            <div className="ai-modal-title" style={{ marginBottom: 0 }}>AI 分镜批量生成</div>
            <div className={`ai-storyboard-status ${props.continuityReady ? 'ok' : 'bad'}`}>
              {props.continuityReady ? (isDoubaoWorkflow ? 'Doubao 连续生成：已就绪' : '连续分镜：已就绪') : (isDoubaoWorkflow ? 'Doubao 连续生成：未就绪' : '连续分镜：未就绪')}
              {props.continuitySummary ? <span style={{ opacity: 0.9 }}>({props.continuitySummary})</span> : null}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={props.onClose} disabled={busy} aria-label="关闭" title="关闭">
            ✕
          </button>
        </div>

        <div className="ai-storyboard-topline">
          <div className="ai-storyboard-model-strip">
            <div className="ai-storyboard-model-strip-title">当前模型与接口</div>
            <div className="ai-storyboard-model-strip-chips story-lock-workspace-chip-row">
              <span className="ai-storyboard-status ok">文本模型: {openChecks.promptProvider || 'none'}{openChecks.promptModel ? ` / ${openChecks.promptModel}` : ''}</span>
              <span className="ai-storyboard-status ok">生图模型: {openChecks.imageProvider || 'none'}{imageModelLabel ? ` / ${imageModelLabel}` : ''}</span>
              {isDoubaoWorkflow ? <span className="ai-storyboard-status ok">Doubao 连续模式: {String((v as any).sequentialImageGeneration || 'disabled')}</span> : null}
            </div>
          </div>
        </div>

        <div className="ai-storyboard-body">
          <div className="ai-storyboard-lock-wrap">
              <div className="ai-storyboard-gate-toolbar">
                <div className="ai-storyboard-gate-toolbar-title">锁定门禁</div>
                <div className="ai-storyboard-stepper" aria-label="锁定门禁进度">
                {lockSteps.map((step, idx) => (
                  <div key={step.id} className="ai-storyboard-step">
                    <div className={`ai-storyboard-step-dot ${step.state}`}>
                      <span>{idx + 1}</span>
                    </div>
                    <div className="ai-storyboard-step-text">
                      <div className="ai-storyboard-step-label">{step.label}</div>
                      <div className="ai-storyboard-step-value">{step.value}</div>
                      {step.actionLabel ? (
                        <button className="btn secondary ai-storyboard-step-action" type="button" onClick={step.onAction} disabled={step.actionDisabled}>
                          {step.actionLabel}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
                </div>
                <div className="ai-storyboard-lock-overview-side">
                  <span className="hint ai-storyboard-gate-toolbar-meta">
                    {String(v.style || 'picture_book')} / {String(v.aspectRatio || '9:16')} / {String((v as any).model || imageModelLabel || '(default)')}
                  </span>
                  <span className={`ai-storyboard-status ${sceneRenderReady ? 'ok' : (props.assetConfirmReady ? 'warn' : 'pending')}`}>
                    {sceneRenderReady ? '已可正式出图' : (scenePromptReadyCount > 0 ? '待场景测试' : '待生成提示词')}
                  </span>
                  {assetPlanReady ? (
                    <span className="ai-storyboard-status ok">资产 {readyAssetCount}/{planAssets.length}</span>
                  ) : null}
                  {primaryAction.kind !== 'test' && primaryAction.kind !== 'ready' ? (
                    <button className="btn secondary" type="button" onClick={primaryAction.onClick} disabled={primaryAction.disabled}>
                      {primaryAction.label}
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="ai-storyboard-lock-shell">
              <div className="story-lock-workspace-log-section ai-storyboard-logs-top">
                <div className="ai-storyboard-inline-head">
                  <div className="story-lock-workspace-log-title">日志</div>
                  <div className="hint">{props.logs.length ? `共 ${props.logs.length} 条，展开后可完整查看。` : '暂无日志'}</div>
                  <button className="btn secondary" type="button" onClick={() => setLockLogsExpanded((v) => !v)}>
                    {lockLogsExpanded ? '收起' : '展开'}
                  </button>
                </div>
                {lockLogsExpanded ? (
                  <div className="story-lock-workspace-log-box">
                    {props.error ? <div className="hint" style={{ color: '#fca5a5', marginBottom: 8 }}>{props.error}</div> : null}
                    <pre>{fullLogs}</pre>
                  </div>
                ) : null}
              </div>

              <div className="ai-storyboard-lock-main">
                <div className="ai-storyboard-pane ai-storyboard-lock-controls">
                  <div className="ai-storyboard-stack-section">
                    <div className="ai-storyboard-inline-head">
                      <div className="ai-storyboard-section-title">基础参数</div>
                      <div className="hint">控制正式场景出图的风格、比例、Checkpoint、LoRA 和采样参数。</div>
                      <button className="btn secondary" type="button" onClick={() => setBaseParamsExpanded((v) => !v)}>
                        {baseParamsExpanded ? '收起' : '展开'}
                      </button>
                    </div>
                    {baseParamsExpanded ? (
                    <div className="ai-storyboard-section ai-storyboard-stack-card">
                    <div className="ai-storyboard-section-body">
                      <div className="ai-storyboard-kv">
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <span className="ai-storyboard-status ok">风格: {String(v.style || 'picture_book')}</span>
                          <span className="ai-storyboard-status ok">比例: {String(v.aspectRatio || '9:16')}</span>
                          <span className="ai-storyboard-status ok">Checkpoint: {String((v as any).model || imageModelLabel || '(default)')}</span>
                          <span className={`ai-storyboard-status ${configuredLoras.length ? 'ok' : 'pending'}`}>LoRA: {configuredLoras.length ? configuredLoras.length : 0}</span>
                          <span className={`ai-storyboard-status ${readyRequiredAssetCount >= requiredAssetCount ? 'ok' : 'warn'}`}>必要锁定资产: {readyRequiredAssetCount}/{requiredAssetCount}</span>
                          <span className={`ai-storyboard-status ${characterRefReadyCount >= props.characters.length ? 'ok' : 'warn'}`}>角色参考: {characterRefReadyCount}/{props.characters.length}</span>
                        </div>
                        <div className="hint">这里只保留会直接影响正式场景出图一致性的参数，不再重复环境检查结果。</div>
                      </div>
                      <div className="ai-storyboard-fields">
                      <div className="ai-storyboard-field">
                        <label>风格</label>
                        <select value={v.style || 'picture_book'} onChange={(e) => props.onChange({ ...v, style: e.target.value as any })}>
                          <option value="picture_book">绘本</option>
                          <option value="cartoon">卡通</option>
                          <option value="national_style">国风</option>
                          <option value="watercolor">水彩</option>
                        </select>
                      </div>
                      <div className="ai-storyboard-field">
                        <label>比例</label>
                        <select value={v.aspectRatio || '9:16'} onChange={(e) => {
                          const nextAspect = e.target.value as any
                          if (isDoubaoImage) {
                            const currSize = String((v as any).size || '').trim()
                            const nextSize = !currSize || isDoubaoDefaultSize(currSize) ? getDoubaoDefaultSize(nextAspect) : currSize
                            props.onChange({ ...v, aspectRatio: nextAspect, size: nextSize } as any)
                            return
                          }
                          props.onChange({ ...v, aspectRatio: nextAspect } as any)
                        }}>
                          <option value="9:16">9:16</option>
                          <option value="16:9">16:9</option>
                          <option value="1:1">1:1</option>
                          <option value="9:1">9:1</option>
                        </select>
                      </div>
                      {isComfyuiImage ? (
                        <>
                          <div className="ai-storyboard-field">
                            <label>Checkpoint</label>
                            <input
                              value={String((v as any).model || '')}
                              onChange={(e) => props.onChange({ ...v, model: e.target.value } as any)}
                              placeholder="如 ivisionIllustration_ivision10.safetensors"
                            />
                          </div>
                          <div className="ai-storyboard-field" style={{ gridColumn: '1 / -1' }}>
                            <label>LoRA</label>
                            <textarea
                              rows={3}
                              value={configuredLoras.join('\n')}
                              onChange={(e) => props.onChange({ ...v, loras: parseLoraList(e.target.value) } as any)}
                              placeholder={'每行一个，可写 name 或 name:0.8'}
                            />
                          </div>
                        </>
                      ) : null}
                      {isDoubaoImage ? (
                        <>
                          <div className="ai-storyboard-field">
                            <label>输出尺寸</label>
                            <input
                              value={String((v as any).size || doubaoDefaultSize)}
                              onChange={(e) => props.onChange({ ...v, size: e.target.value } as any)}
                              placeholder={`默认最小尺寸：${doubaoDefaultSize}`}
                            />
                          </div>
                          <div className="ai-storyboard-field">
                            <label>返回格式</label>
                            <select value={String((v as any).responseFormat || 'url')} onChange={(e) => props.onChange({ ...v, responseFormat: e.target.value } as any)}>
                              <option value="url">url</option>
                              <option value="b64_json">b64_json</option>
                            </select>
                          </div>
                          <div className="ai-storyboard-field">
                            <label>水印</label>
                            <select value={String(Boolean((v as any).watermark))} onChange={(e) => props.onChange({ ...v, watermark: e.target.value === 'true' } as any)}>
                              <option value="false">关闭</option>
                              <option value="true">开启</option>
                            </select>
                          </div>
                          <div className="ai-storyboard-field">
                            <label>组图模式</label>
                            <select value={String((v as any).sequentialImageGeneration || 'auto')} onChange={(e) => props.onChange({ ...v, sequentialImageGeneration: e.target.value } as any)}>
                              <option value="auto">auto</option>
                              <option value="disabled">disabled</option>
                            </select>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="ai-storyboard-field">
                            <label>宽</label>
                            <input type="number" value={v.width ?? 768} onChange={(e) => props.onChange({ ...v, width: Number(e.target.value) })} />
                          </div>
                          <div className="ai-storyboard-field">
                            <label>高</label>
                            <input type="number" value={v.height ?? 1344} onChange={(e) => props.onChange({ ...v, height: Number(e.target.value) })} />
                          </div>
                          <div className="ai-storyboard-field">
                            <label>步数</label>
                            <select value={String(v.steps ?? 20)} onChange={(e) => props.onChange({ ...v, steps: Number(e.target.value) })}>
                              <option value="20">20</option>
                              <option value="24">24</option>
                              <option value="28">28</option>
                              <option value="30">30</option>
                              <option value="35">35</option>
                            </select>
                          </div>
                          <div className="ai-storyboard-field">
                            <label>CFG</label>
                            <select value={String(v.cfgScale ?? 7)} onChange={(e) => props.onChange({ ...v, cfgScale: Number(e.target.value) })}>
                              <option value="5">5</option>
                              <option value="6">6</option>
                              <option value="6.5">6.5</option>
                              <option value="7">7</option>
                              <option value="7.5">7.5</option>
                              <option value="8">8</option>
                            </select>
                          </div>
                          <div className="ai-storyboard-field">
                            <label>采样器</label>
                            <select value={String((v as any).sampler || 'DPM++ 2M')} onChange={(e) => props.onChange({ ...v, sampler: e.target.value } as any)}>
                              <option value="DPM++ 2M">DPM++ 2M</option>
                              <option value="DPM++ SDE">DPM++ SDE</option>
                              <option value="Euler a">Euler a</option>
                              <option value="Euler">Euler</option>
                              <option value="UniPC">UniPC</option>
                            </select>
                          </div>
                          <div className="ai-storyboard-field">
                            <label>调度器</label>
                            <select value={String((v as any).scheduler || 'Automatic')} onChange={(e) => props.onChange({ ...v, scheduler: e.target.value } as any)}>
                              <option value="Automatic">Automatic</option>
                              <option value="Karras">Karras</option>
                              <option value="Exponential">Exponential</option>
                              <option value="SGM Uniform">SGM Uniform</option>
                              <option value="Simple">Simple</option>
                            </select>
                          </div>
                        </>
                      )}
                    </div>
                    {isDoubaoImage ? (
                      <div className="hint" style={{ marginTop: 8 }}>
                        当前 image provider 为 doubao。{String(v.aspectRatio || '9:16')} 会输出 {doubaoOrientation}；默认最小尺寸为 {doubaoDefaultSize}。连续场景建议保持“组图模式=auto”，让同一套 Story Bible 和全局锚点参与多场景连续生成。若你手动改尺寸，系统将按你填写的尺寸发送请求。
                      </div>
                    ) : null}
                    {isComfyuiImage ? (
                      <div className="hint" style={{ marginTop: 8 }}>
                        锁定事物和正式场景出图共用这里的 checkpoint、LoRA 和采样参数。若此处改动，建议重新跑一次场景测试。
                      </div>
                    ) : null}
                    </div>
                    </div>
                    ) : null}
                  </div>

                  <div className="ai-storyboard-stack-section">
                    <div className="ai-storyboard-inline-head">
                      <div className="ai-storyboard-section-title">全局提示词</div>
                      <div className="hint" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flex: '1 1 auto' }}>
                        <span className={`ai-storyboard-status ${String((v as any).globalPromptZh || v.globalPrompt || '').trim() ? 'ok' : 'bad'}`}>正向</span>
                        <span className={`ai-storyboard-status ${String((v as any).globalNegativePromptZh || v.globalNegativePrompt || '').trim() ? 'ok' : 'bad'}`}>负向</span>
                      </div>
                      <button className="btn secondary" type="button" onClick={() => setGlobalPromptsExpanded((value) => !value)}>
                        {globalPromptsExpanded ? '收起' : '展开'}
                      </button>
                    </div>
                    {globalPromptsExpanded ? (
                    <div className="ai-storyboard-section ai-storyboard-stack-card">
                      <div className="ai-storyboard-section-body">
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                          <button className="btn secondary" type="button" onClick={props.onReviewGlobalPrompt} disabled={busy || props.globalPromptReviewBusy}>
                            {props.globalPromptReviewBusy ? '评分中…' : 'AI 评分'}
                          </button>
                          <button className="btn secondary" type="button" onClick={props.onApplyGlobalPromptReview} disabled={busy || !props.globalPromptReview?.ai?.optimizedGlobalPromptZh}>
                            继续强化提示词
                          </button>
                          <button className="btn secondary" type="button" onClick={props.onClearGlobalPrompt} disabled={busy || !String(v.globalPrompt || '').trim()}>
                            清空正向
                          </button>
                          <button className="btn secondary" type="button" onClick={props.onClearGlobalNegativePrompt} disabled={busy || !String(v.globalNegativePrompt || '').trim()}>
                            清空负向
                          </button>
                        </div>
                        {props.globalPromptReview ? (
                          <div style={{ border: '1px solid rgba(148,163,184,0.22)', borderRadius: 12, padding: 10, marginBottom: 10 }}>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
                              <span className={`ai-storyboard-status ${getPromptReviewTone(props.globalPromptReview).cls}`}>
                                AI 评分：{Number.isFinite(Number(props.globalPromptReview.ai.score)) ? `${Math.round(Number(props.globalPromptReview.ai.score))}/100` : 'n/a'}
                              </span>
                              <span className="hint" style={{ color: getPromptReviewTone(props.globalPromptReview).color }}>{props.globalPromptReview.ai.summary}</span>
                            </div>
                            {props.globalPromptReview.ai.suggestions?.length ? (
                              <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>建议：{props.globalPromptReview.ai.suggestions.slice(0, 3).join('；')}</div>
                            ) : null}
                            {props.globalPromptReview.aiError?.message ? (
                              <div className="hint" style={{ color: '#fca5a5', marginTop: 6 }}>AI 回退：{props.globalPromptReview.aiError.message}</div>
                            ) : null}
                          </div>
                        ) : null}
                        <div className="story-lock-global-sections">
                          <div className="story-lock-global-section">
                            <div className="story-lock-global-subhead">
                              <div className="story-lock-global-subtitle">全局正向提示词</div>
                              <button className="btn secondary" type="button" onClick={props.onTranslateGlobalPrompt} disabled={promptOpBusy}>
                                {props.translatingScope === 'globalPrompt' ? `翻译中…${translateCountdownLabel}` : (promptOpBusy ? '请等待当前任务…' : '中文转英文')}
                              </button>
                            </div>
                            <div className="story-lock-prompt-grid">
                              <label className="story-lock-prompt-field">
                                <span>中文</span>
                                <textarea
                                  className="story-lock-textarea"
                                  value={String((v as any).globalPromptZh || '')}
                                  onChange={(e) => props.onChangeGlobalPromptZh(e.target.value)}
                                  placeholder="在这里编辑中文全局正向提示词"
                                />
                              </label>
                              <label className="story-lock-prompt-field">
                                <span>英文</span>
                                <textarea
                                  className="story-lock-textarea"
                                  value={String(v.globalPrompt || '')}
                                  onChange={(e) => props.onChangeGlobalPromptEn(e.target.value)}
                                  placeholder="翻译后或手工编辑英文正向提示词"
                                />
                              </label>
                            </div>
                          </div>
                          <div className="story-lock-global-section">
                            <div className="story-lock-global-subhead">
                              <div className="story-lock-global-subtitle">全局负向提示词</div>
                              <button className="btn secondary" type="button" onClick={props.onTranslateGlobalNegativePrompt} disabled={promptOpBusy}>
                                {props.translatingScope === 'globalNegativePrompt' ? `翻译中…${translateCountdownLabel}` : (promptOpBusy ? '请等待当前任务…' : '中文转英文')}
                              </button>
                            </div>
                            <div className="story-lock-prompt-grid">
                              <label className="story-lock-prompt-field">
                                <span>中文</span>
                                <textarea
                                  className="story-lock-textarea"
                                  value={String((v as any).globalNegativePromptZh || '')}
                                  onChange={(e) => props.onChangeGlobalNegativePromptZh(e.target.value)}
                                  placeholder="在这里编辑中文全局负向提示词"
                                />
                              </label>
                              <label className="story-lock-prompt-field">
                                <span>英文</span>
                                <textarea
                                  className="story-lock-textarea"
                                  value={String(v.globalNegativePrompt || '')}
                                  onChange={(e) => props.onChangeGlobalNegativePromptEn(e.target.value)}
                                  placeholder="翻译后或手工编辑英文负向提示词"
                                />
                              </label>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    ) : null}
                  </div>

                  <div className="ai-storyboard-stack-section">
                    <div className="ai-storyboard-inline-head">
                      <div className="ai-storyboard-section-title">正式场景出图</div>
                      <div className="hint">放在全局提示词下面。先生成场景提示词，再做场景测试，最后批量出图。</div>
                      <button className="btn secondary" type="button" onClick={() => setRenderPanelExpanded((v) => !v)}>
                        {renderPanelExpanded ? '收起' : '展开'}
                      </button>
                    </div>
                    {renderPanelExpanded ? (
                    <div className="ai-storyboard-section ai-storyboard-stack-card">
                    <div className="ai-storyboard-section-body">
                      <div className="ai-storyboard-section ai-storyboard-scenes">
                        <div className="ai-storyboard-section-head">
                          <div className="ai-storyboard-section-title">场景提示词列表（可编辑）</div>
                          <div className="hint">共 {props.items.length} 个场景，先补齐中英文提示词，再运行场景测试。</div>
                        </div>
                        <div className="ai-storyboard-section-body" style={{ minHeight: 0 }}>
                          <div className="ai-storyboard-scenes-list">
                            <div className="ai-storyboard-scenes-scroll">
                        {props.items.map((it, idx) => {
                          const promptReviewTone = getPromptReviewTone(it.promptReview)
                          const currentStatus = String(it.status || 'idle').trim() || 'idle'
                          const statusTone =
                            currentStatus === 'applied' || currentStatus === 'generated'
                              ? 'ok'
                              : currentStatus === 'error'
                                ? 'bad'
                                : currentStatus === 'generating' || currentStatus === 'applying'
                                  ? 'pending'
                                  : 'warn'
                          return (
                            <div key={it.nodeId} className="story-lock-global-card ai-storyboard-scene-prompt-card">
                              <div className="story-lock-global-head">
                                <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                                  <div className="story-lock-workspace-log-title">
                                    #{idx + 1} {it.nodeName}
                                  </div>
                                  <div className="story-lock-workspace-chip-row">
                                    <span className={`ai-storyboard-status ${statusTone}`}>状态: {currentStatus}</span>
                                    <span className={`ai-storyboard-status ${String(it.promptZh || '').trim() ? 'ok' : 'bad'}`}>正向中文</span>
                                    <span className={`ai-storyboard-status ${String(it.prompt || '').trim() ? 'ok' : 'bad'}`}>正向英文</span>
                                    <span className={`ai-storyboard-status ${String(it.negativePromptZh || '').trim() ? 'ok' : 'warn'}`}>负向中文</span>
                                    <span className={`ai-storyboard-status ${String(it.negativePrompt || '').trim() ? 'ok' : 'warn'}`}>负向英文</span>
                                    <span className="ai-storyboard-status pending">{it.nodeId}</span>
                                    {(props.busyGenerate || props.busyApply) && (it.status === 'generating' || it.status === 'applying') && props.generatingNodeId === it.nodeId ? (
                                      <span className="ai-storyboard-status pending">耗时 {((props.generatingNodeElapsedMs || 0) / 1000).toFixed(1)}s</span>
                                    ) : null}
                                  </div>
                                </div>
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                  <button className="btn secondary" type="button" onClick={() => props.onReviewItemPrompt(it.nodeId)} disabled={busy || props.promptReviewingNodeId === it.nodeId || !String(it.prompt || it.userInput || '').trim()}>
                                    {props.promptReviewingNodeId === it.nodeId ? '评分中…' : 'AI 评分'}
                                  </button>
                                  <button className="btn secondary" type="button" onClick={() => props.onApplyItemPromptReview(it.nodeId)} disabled={busy || !it.promptReview?.ai?.optimizedPrompt}>
                                    继续强化提示词
                                  </button>
                                </div>
                              </div>
                              <div className="story-lock-prompt-stack">
                                <div className="story-lock-prompt-section">
                                  <div className="story-lock-global-subtitle">场景原文</div>
                                  <div className="story-lock-workspace-log-box ai-storyboard-scene-source">
                                    <pre>{it.userInput || '(无场景文本)'}</pre>
                                  </div>
                                </div>
                                {it.promptReview ? (
                                  <div className="story-lock-prompt-section">
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                      <span className={`ai-storyboard-status ${promptReviewTone.cls}`}>
                                        AI 评分：{Number.isFinite(Number(it.promptReview.ai.score)) ? `${Math.round(Number(it.promptReview.ai.score))}/100` : 'n/a'}
                                      </span>
                                      <span className="hint" style={{ color: promptReviewTone.color }}>{it.promptReview.ai.summary}</span>
                                    </div>
                                    {it.promptReview.ai.suggestions?.length ? (
                                      <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>建议：{it.promptReview.ai.suggestions.slice(0, 3).join('；')}</div>
                                    ) : null}
                                    {it.promptReview.aiError?.message ? (
                                      <div className="hint" style={{ color: '#fca5a5' }}>AI 回退：{it.promptReview.aiError.message}</div>
                                    ) : null}
                                  </div>
                                ) : null}
                                <div className="story-lock-prompt-section">
                                  <div className="story-lock-global-subhead">
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                      <div className="story-lock-global-subtitle">正向提示词</div>
                                      {it.promptReview ? (
                                        <span className={`ai-storyboard-status ${promptReviewTone.cls}`}>
                                          评分 {Number.isFinite(Number(it.promptReview.ai.score)) ? `${Math.round(Number(it.promptReview.ai.score))}/100` : 'n/a'}
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>
                                  <div className="story-lock-prompt-grid">
                                    <label className="story-lock-prompt-field">
                                      <span>中文</span>
                                      <textarea className="story-lock-textarea compact-rows" value={it.promptZh || ''} onChange={(e) => props.onChangeItem(it.nodeId, { promptZh: e.target.value })} placeholder="AI 强化后的中文场景提示词" />
                                    </label>
                                    <label className="story-lock-prompt-field">
                                      <span>英文</span>
                                      <textarea className="story-lock-textarea compact-rows" value={it.prompt || ''} onChange={(e) => props.onChangeItem(it.nodeId, { prompt: e.target.value })} placeholder="英文场景提示词（用于出图）" />
                                    </label>
                                  </div>
                                </div>
                                <div className="story-lock-prompt-section">
                                  <div className="story-lock-global-subhead">
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                      <div className="story-lock-global-subtitle">负向提示词</div>
                                      {it.promptReview ? (
                                        <span className={`ai-storyboard-status ${promptReviewTone.cls}`}>
                                          评分 {Number.isFinite(Number(it.promptReview.ai.score)) ? `${Math.round(Number(it.promptReview.ai.score))}/100` : 'n/a'}
                                        </span>
                                      ) : null}
                                    </div>
                                  </div>
                                  <div className="story-lock-prompt-grid">
                                    <label className="story-lock-prompt-field">
                                      <span>中文</span>
                                      <textarea className="story-lock-textarea compact-rows" value={it.negativePromptZh || ''} onChange={(e) => props.onChangeItem(it.nodeId, { negativePromptZh: e.target.value })} placeholder="中文场景负向提示词（可选）" />
                                    </label>
                                    <label className="story-lock-prompt-field">
                                      <span>英文</span>
                                      <textarea className="story-lock-textarea compact-rows" value={it.negativePrompt || ''} onChange={(e) => props.onChangeItem(it.nodeId, { negativePrompt: e.target.value })} placeholder="英文场景负向提示词（用于出图）" />
                                    </label>
                                  </div>
                                </div>
                                {it.note ? <div className="hint">{it.note}</div> : null}
                              </div>
                            </div>
                          )
                        })}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="ai-storyboard-section" style={{ marginTop: 10 }}>
                        <div className="ai-storyboard-section-head">
                          <div className="ai-storyboard-section-title">场景测试</div>
                        </div>
                        <div className="ai-storyboard-section-body">
                          <div className="hint">先选一个已具备中英文提示词的场景做测试渲染，确认正式场景图会带入 Story Bible、全局锚点、角色参考和锁定事物主参考。测试通过后，再批量出图。</div>
                          <div className="ai-storyboard-scene-chip-row" style={{ marginTop: 10 }}>
                            {testSceneOptions.map((scene) => (
                              <button
                                key={scene.nodeId}
                                type="button"
                                className={`btn secondary ai-storyboard-scene-chip ${scene.nodeId === selectedTestSceneId ? 'active' : ''}`}
                                onClick={() => props.onChangeTestSceneId(scene.nodeId)}
                              >
                                {scene.label}
                              </button>
                            ))}
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                            <span className={`ai-storyboard-status ${props.continuityReady ? 'ok' : 'warn'}`}>测试门禁: {props.continuityReady ? '通过' : '待运行'}</span>
                            {selectedTestScene ? <span className="ai-storyboard-status ok">测试场景: {selectedTestScene.label} {selectedTestScene.name}</span> : null}
                            <span className={`ai-storyboard-status ${selectedTestScenePromptReady ? 'ok' : 'bad'}`}>场景提示词: {selectedTestScenePromptReady ? '已就绪' : '缺少中英文提示词'}</span>
                            <span className={`ai-storyboard-status ${storyBibleReady ? 'ok' : 'bad'}`}>Story Bible: {storyBibleReady ? '已就绪' : '缺失'}</span>
                            <span className={`ai-storyboard-status ${globalPromptReady ? 'ok' : 'warn'}`}>全局锚点: {globalPromptReady ? '已就绪' : '待生成'}</span>
                            <span className={`ai-storyboard-status ${readyRequiredAssetCount >= requiredAssetCount ? 'ok' : 'warn'}`}>必要锁定资产: {readyRequiredAssetCount}/{requiredAssetCount}</span>
                            <span className={`ai-storyboard-status ${readySceneAssetLockCount > 0 ? 'ok' : 'pending'}`}>事物主参考: {readySceneAssetLockCount}</span>
                            <span className={`ai-storyboard-status ${characterRefReadyCount >= props.characters.length ? 'ok' : 'warn'}`}>角色参考: {characterRefReadyCount}/{props.characters.length}</span>
                            <span className="ai-storyboard-status ok">Checkpoint: {String((v as any).model || imageModelLabel || '(default)')}</span>
                            <span className={`ai-storyboard-status ${configuredLoras.length ? 'ok' : 'pending'}`}>LoRA: {configuredLoras.length ? configuredLoras.join(' | ') : '(none)'}</span>
                          </div>
                          <div className="hint" style={{ marginTop: 10 }}>
                            场景测试会实际渲染当前选中的场景，并把该场景的中英文提示词与已锁定事物主参考一起带入请求。
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                            <button className="btn secondary" type="button" onClick={props.onRunContinuityTest} disabled={!canRunContinuityTest}>
                              {props.continuityBusy ? '测试中…' : '运行场景测试'}
                            </button>
                            <span className="hint">{props.continuitySummary || '还没有测试结果。'}</span>
                          </div>
                        </div>
                      </div>

                      <div className="ai-storyboard-section" style={{ marginTop: 10 }}>
                        <div className="ai-storyboard-section-head">
                          <div className="ai-storyboard-section-title">运行日志</div>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            {busy ? (
                              <div className="hint">
                                计时：{(props.elapsedMs / 1000).toFixed(1)}s（{props.busyEntity ? '生成 Story Bible 中' : (props.busyGenerate ? '生成提示词中' : '批量出图中')}{props.queuePaused ? '，已暂停' : ''}）
                              </div>
                            ) : (
                              <div className="hint">（仅用于排查，不影响出图）</div>
                            )}
                            <button className="btn secondary" type="button" onClick={() => setRenderLogsExpanded((v) => !v)}>
                              {renderLogsExpanded ? '收起' : '展开'}
                            </button>
                          </div>
                        </div>
                        <div className="ai-storyboard-section-body">
                          {renderLogsExpanded ? (
                            <textarea className="ai-storyboard-log-textarea" readOnly value={props.logs.length ? props.logs.join('\n') : '(暂无日志)'} rows={7} />
                          ) : (
                            <div className="ai-storyboard-log-preview"><pre>{logPreview}</pre></div>
                          )}
                          {props.error ? <div className="ai-modal-err">{props.error}</div> : null}
                        </div>
                      </div>
                    </div>
                    </div>
                    ) : null}
                  </div>

                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="ai-storyboard-actions">
          {!envReady ? (
            <div className="hint" style={{ marginBottom: 8 }}>
              环境检查未通过：请先通过顶部步骤 1 重新检查并修复问题，再继续后续步骤。
            </div>
          ) : null}
          {!props.assetConfirmReady ? (
            <div className="hint" style={{ marginBottom: 8 }}>
              门禁未通过：请先生成并确认锁定结果，再运行场景测试。
            </div>
          ) : !props.continuityReady ? (
            <div className="hint" style={{ marginBottom: 8 }}>
              门禁未通过：请先完成场景测试，随后才会开放“生成提示词/批量出图”。
            </div>
          ) : null}
          <div className="ai-storyboard-actions-row">
            <div className="left">
              <button onClick={props.onGenerateAll} disabled={!canGenerateAll}>
                {props.busyGenerate ? '生成中…' : '批量生成场景提示词'}
              </button>
              <button onClick={props.onRetryPending} disabled={!canRetryGenerate}>
                继续提示词队列
              </button>
            </div>
            <div className="right">
              <button onClick={props.onApplyAll} disabled={!canApplyAll}>
                {props.busyApply ? '应用中…' : '开始批量出图'}
              </button>
              <button onClick={props.onRetryApplyPending} disabled={!canRetryApply}>
                继续出图队列
              </button>
              <button onClick={props.onPauseQueue} disabled={!busy || props.queuePaused}>
                暂停
              </button>
              <button onClick={props.onResumeQueue} disabled={!busy || !props.queuePaused}>
                继续
              </button>
              <button onClick={props.onCancelQueue} disabled={!busy}>
                取消
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
