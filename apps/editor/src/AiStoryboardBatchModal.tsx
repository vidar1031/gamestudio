import React, { useEffect, useState } from 'react'
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

function getAssetCategoryLabel(category: string) {
  const c = String(category || '').trim()
  if (c === 'character') return '角色'
  if (c === 'prop') return '道具'
  if (c === 'location') return '地点'
  return c || '资产'
}

function getAssetStrategyLabel(strategy: string) {
  const s = String(strategy || '').trim()
  if (s === 'ref_required') return '必须先出参考图'
  if (s === 'optional_ref') return '建议准备参考图'
  if (s === 'prompt_only') return '仅提示词约束'
  return s || '未分类'
}

function getAssetStatusLabel(status: string) {
  const s = String(status || '').trim()
  if (s === 'ready') return '已就绪'
  if (s === 'missing') return '缺少参考图'
  return s || '未检查'
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
  error: string
  logs: string[]
  onRunOpenChecks: () => void
  onChange: (next: AiBackgroundRequest) => void
  onChangeGlobalPromptZh: (value: string) => void
  onChangeGlobalNegativePromptZh: (value: string) => void
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
  initialTab?: 'lock' | 'render'
}) {
  const v = props.value
  const busy = props.busyGenerate || props.busyApply || props.busyEntity || props.assetPlanBusy
  const cfg = props.continuityConfig || { ipadapterEnabled: false, requireCharacterRefs: true, controlnetEnabled: false }
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
  const canRunContinuityTest = !busy && !props.continuityBusy && openChecks.serverOk && openChecks.imageOk && props.assetConfirmReady
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
  const canGenerateAll = !busy && envReady && props.assetConfirmReady && props.items.length > 0 && props.continuityReady
  const canRetryGenerate = !busy && envReady && props.assetConfirmReady && props.continuityReady && props.items.some((x) => x.status === 'error' || !String(x.prompt || '').trim())
  const canApplyAll = !busy && envReady && props.assetConfirmReady && props.continuityReady && props.canApplyAll
  const canRetryApply = !busy && envReady && props.assetConfirmReady && props.continuityReady && props.items.some((x) => x.status === 'error' || x.status === 'generated')
  const imageModelLabel = isComfyuiImage
    ? String((v as any).model || '').trim() || String(openChecks.imageModel || '').trim() || '(在本面板填写)'
    : String(openChecks.imageModel || '').trim()
  const storyBibleReady = Boolean(String((v as any).storyBibleJson || '').trim())
  const renderTabReady = envReady && props.assetConfirmReady && props.continuityReady
  const configuredLoras = Array.isArray((v as any).loras) ? (v as any).loras.map((x: any) => String(x || '').trim()).filter(Boolean) : []
  const [activeTab, setActiveTab] = useState<'lock' | 'render'>(props.initialTab === 'render' ? 'render' : 'lock')

  useEffect(() => {
    if (activeTab === 'render' && !renderTabReady) setActiveTab('lock')
  }, [activeTab, renderTabReady])

  useEffect(() => {
    if (!props.open) return
    if (props.initialTab === 'render' && renderTabReady) setActiveTab('render')
    else if (props.initialTab !== 'render') setActiveTab('lock')
  }, [props.open, props.initialTab, renderTabReady])

  if (!props.open) return null

  return (
    <div className="ai-modal" role="dialog" aria-modal="true">
      <div
        className="ai-modal-card ai-background-modal-card ai-storyboard-modal-card"
        style={{ width: 'min(1440px, calc(100vw - 24px))', height: 'min(920px, calc(100vh - 24px))', maxHeight: 'calc(100vh - 24px)' }}
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

        <div className="ai-storyboard-tabs">
          <button
            type="button"
            className={`ai-storyboard-tab ${activeTab === 'lock' ? 'active' : ''}`}
            onClick={() => setActiveTab('lock')}
          >
            <span>锁定事物</span>
            <span className={`ai-storyboard-tab-badge ${props.continuityReady ? 'ok' : (props.assetConfirmReady ? 'warn' : 'pending')}`}>
              {props.continuityReady ? '已通过' : (props.assetConfirmReady ? '待测试' : '进行中')}
            </span>
          </button>
          <button
            type="button"
            className={`ai-storyboard-tab ${activeTab === 'render' ? 'active' : ''}`}
            onClick={() => {
              if (renderTabReady) setActiveTab('render')
            }}
            disabled={!renderTabReady}
            title={renderTabReady ? '进入正式场景出图' : '请先完成锁定事物标签中的前置门禁'}
          >
            <span>正确出图</span>
            <span className={`ai-storyboard-tab-badge ${renderTabReady ? 'ok' : 'pending'}`}>
              {renderTabReady ? '已开放' : '未开放'}
            </span>
          </button>
        </div>

        <div className="ai-storyboard-body">
          {activeTab === 'lock' ? (
            <div className="ai-storyboard-lock-shell">
              <div className="ai-storyboard-section ai-storyboard-gates-top">
                <div className="ai-storyboard-section-head">
                  <div className="ai-storyboard-section-title">锁定门禁概览</div>
                  <div className="hint">通过后才会开放“正确出图”</div>
                </div>
                <div className="ai-storyboard-section-body">
                  <div className="ai-storyboard-gate-strip">
                    <div className={`ai-storyboard-gate-card small ${envReady ? 'ok' : 'pending'}`}>
                      <div className="ai-storyboard-gate-title">1. 环境体检</div>
                      <div className="ai-storyboard-gate-value">{envReady ? '通过' : '未通过'}</div>
                    </div>
                    <div className={`ai-storyboard-gate-card small ${storyBibleReady ? 'ok' : 'pending'}`}>
                      <div className="ai-storyboard-gate-title">2. Story Bible</div>
                      <div className="ai-storyboard-gate-value">{storyBibleReady ? '已生成' : '未生成'}</div>
                    </div>
                    <div className={`ai-storyboard-gate-card small ${props.assetConfirmReady ? 'ok' : 'pending'}`}>
                      <div className="ai-storyboard-gate-title">3. 必要事物资产</div>
                      <div className="ai-storyboard-gate-value">{props.assetConfirmReady ? '已确认' : '待确认'}</div>
                    </div>
                    <div className={`ai-storyboard-gate-card small ${props.continuityReady ? 'ok' : 'pending'}`}>
                      <div className="ai-storyboard-gate-title">4. 锁定测试</div>
                      <div className="ai-storyboard-gate-value">{props.continuityReady ? '已通过' : '未通过'}</div>
                    </div>
                  </div>
                  <div className="hint" style={{ marginTop: 8 }}>
                    当前参数摘要：{String(v.style || 'picture_book')} / {String(v.aspectRatio || '9:16')} / {String((v as any).model || imageModelLabel || '(default)')}
                    {configuredLoras.length ? ` / LoRA ${configuredLoras.join(' | ')}` : ' / 无 LoRA'}
                  </div>
                </div>
              </div>

              <div className="ai-storyboard-section ai-storyboard-logs-top">
                <div className="ai-storyboard-section-head">
                  <div className="ai-storyboard-section-title">锁定阶段日志</div>
                  <div className="hint">用于排查锁定资产和测试门禁</div>
                </div>
                <div className="ai-storyboard-section-body">
                  <textarea readOnly value={props.logs.length ? props.logs.join('\n') : '(暂无日志)'} rows={5} />
                  {props.error ? <div className="ai-modal-err">{props.error}</div> : null}
                </div>
              </div>

              <div className="ai-storyboard-lock-main">
                <div className="ai-storyboard-pane ai-storyboard-lock-controls">
                  <div className="ai-storyboard-section">
                    <div className="ai-storyboard-section-body">
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <span className="ai-storyboard-status ok">文本模型: {openChecks.promptProvider || 'none'}{openChecks.promptModel ? ` / ${openChecks.promptModel}` : ''}</span>
                        <span className="ai-storyboard-status ok">生图模型: {openChecks.imageProvider || 'none'}{imageModelLabel ? ` / ${imageModelLabel}` : ''}</span>
                        {isDoubaoWorkflow ? <span className="ai-storyboard-status ok">Doubao 连续模式: {String((v as any).sequentialImageGeneration || 'disabled')}</span> : null}
                      </div>
                    </div>
                  </div>

                  <div className="ai-storyboard-section">
                    <div className="ai-storyboard-section-head">
                      <div className="ai-storyboard-section-title">Step 1. 打开体检（自动验证接口与生成能力）</div>
                      <button className="btn secondary" type="button" onClick={props.onRunOpenChecks} disabled={busy || openChecks.checking}>
                        {openChecks.checking ? '检查中…' : '重新检查'}
                      </button>
                    </div>
                    <div className="ai-storyboard-section-body">
                      <div className="ai-storyboard-kv">
                        <div className="hint">
                          {openChecks.summary || (isDoubaoWorkflow
                            ? '打开窗口时会自动检查 server、Doubao 文本模型、Doubao 生图模型，以及多场景连续生成前置条件。'
                            : '打开窗口时会自动检查 server、提示词 provider、图像 provider、ComfyUI 体检和角色参考绑定。')}
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <span className={`ai-storyboard-status ${openChecks.serverOk ? 'ok' : 'bad'}`}>server: {openChecks.serverOk ? 'ok' : 'fail'}</span>
                          <span className={`ai-storyboard-status ${openChecks.promptOk ? 'ok' : 'bad'}`}>prompt: {openChecks.promptProvider || 'none'} / {openChecks.promptOk ? 'ok' : 'fail'}</span>
                          <span className={`ai-storyboard-status ${openChecks.imageOk ? 'ok' : 'bad'}`}>image: {openChecks.imageProvider || 'none'} / {openChecks.imageOk ? 'ok' : 'fail'}</span>
                          <span className={`ai-storyboard-status ${openChecks.continuityBindingsOk ? 'ok' : 'bad'}`}>refs: {openChecks.continuityBindingsOk ? 'ok' : 'missing'}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="ai-storyboard-section">
                    <div className="ai-storyboard-section-head">
                      <div className="ai-storyboard-section-title">Step 2. 设定锁定测试参数</div>
                    </div>
                    <div className="ai-storyboard-section-body">
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
                        锁定事物阶段使用这里的 checkpoint、LoRA 和采样参数。正式出图会继承这一组参数；如果要改，先回到这个标签调整后再重新运行锁定测试。
                      </div>
                    ) : null}
                    </div>
                  </div>

                  <div className="ai-storyboard-section">
                    <div className="ai-storyboard-section-head">
                      <div className="ai-storyboard-section-title">{isDoubaoWorkflow ? 'Step 3. 生成连续性 Bible（世界观/角色/地点锚点）' : 'Step 3. 生成 Story Bible（角色/道具/地点锁定）'}</div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button className="btn secondary" type="button" onClick={props.onClearStoryBible} disabled={busy || !String((v as any).storyBibleJson || '').trim()}>
                          Clear
                        </button>
                        <button className="btn secondary" type="button" onClick={props.onGenerateEntity} disabled={!canGenerateEntity}>
                          {props.busyEntity ? `生成中… ${(((props.entityElapsedMs || 0) / 1000).toFixed(1))}s` : (isDoubaoWorkflow ? 'AI 生成连续性 Bible' : 'AI 生成 Story Bible')}
                        </button>
                      </div>
                    </div>
                    <div className="ai-storyboard-section-body">
                      <textarea
                        rows={8}
                        value={String((v as any).storyBibleJson || '')}
                        onChange={(e) => props.onChange({ ...v, storyBibleJson: e.target.value } as any)}
                        placeholder={isDoubaoWorkflow
                          ? 'JSON（可手动修改）。生成后会用于多场景提示词与 Doubao 批量出图，锁定世界观、角色外观、关键道具与地点锚点。'
                          : 'JSON（可手动修改）。生成后会用于批量提示词与出图，锁定角色/道具/地点的连续性。'}
                      />
                    </div>
                  </div>

                  <div className="ai-storyboard-section">
                    <div className="ai-storyboard-section-head">
                      <div className="ai-storyboard-section-title">{isDoubaoWorkflow ? 'Step 5. 连续性预检（必须通过才能进入正确出图）' : 'Step 5. 连续分镜锁定测试（必须通过才能进入正确出图）'}</div>
                      <button className="btn secondary" type="button" onClick={props.onRunContinuityTest} disabled={!canRunContinuityTest}>
                        {props.continuityBusy ? '测试中…' : (isDoubaoWorkflow ? '运行连续性预检' : '运行锁定测试')}
                      </button>
                    </div>
                    <div className="ai-storyboard-section-body">
                      <div className="hint">
                        门禁：{props.continuityReady ? '已通过' : '未通过'}{props.continuitySummary ? `，${props.continuitySummary}` : ''}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="ai-storyboard-pane ai-storyboard-lock-assets-pane">
                  <div className="ai-storyboard-section">
                    <div className="ai-storyboard-section-head">
                      <div className="ai-storyboard-section-title">Step 4. 必要事物资产确认（先生成参考资产，再继续）</div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button className="btn secondary" type="button" onClick={props.onBuildAssetPlan} disabled={busy || !String((v as any).storyBibleJson || '').trim()}>
                          {props.assetPlanBusy && !props.assetGeneratingId ? '生成中…' : '生成资产计划'}
                        </button>
                        <button className="btn secondary" type="button" onClick={props.onGenerateAllMissingAssetRefs} disabled={busy || !assetPlan || requiredMissingAssets.length === 0}>
                          {props.assetPlanBusy && !props.assetGeneratingId ? '处理中…' : `生成全部缺失参考图 (${requiredMissingAssets.length})`}
                        </button>
                        <button className="btn secondary" type="button" onClick={props.onConfirmAssetPlan} disabled={busy || !assetPlan || requiredMissingAssets.length > 0}>
                          {props.assetConfirmReady ? '已确认' : '确认资产无误'}
                        </button>
                      </div>
                    </div>
                    <div className="ai-storyboard-section-body">
                    <div className="hint">先把故事里需要稳定复现的角色 / 道具 / 地点拆成资产计划，生成缺失参考图并由用户确认，再进入后续连续性预检与批量生图。</div>
                    <div className="hint" style={{ marginTop: 6 }}>“生成资产计划”只负责拆解缺失项，不会调用 ComfyUI。真正调用 ComfyUI 的是下面每个资产卡片上的“生成参考图”，或“生成全部缺失参考图”。</div>
                    <div className="hint" style={{ marginTop: 6 }}>当前状态：{props.assetConfirmSummary}</div>
                    {!assetPlan ? (
                      <div className="hint" style={{ marginTop: 10 }}>尚未生成资产计划。请先完成 Step 3，然后点击“生成资产计划”。</div>
                    ) : (
                      <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <span className="ai-storyboard-status ok">资产数: {assetPlan.summary?.assetCount || planAssets.length}</span>
                          <span className={`ai-storyboard-status ${requiredMissingAssets.length ? 'bad' : 'ok'}`}>必需参考: {assetPlan.summary?.refRequiredCount || 0}</span>
                          <span className={`ai-storyboard-status ${requiredMissingAssets.length ? 'bad' : 'ok'}`}>缺失: {requiredMissingAssets.length}</span>
                          <span className="ai-storyboard-status ok">已就绪: {assetPlan.summary?.refReadyCount || 0}</span>
                        </div>
                        <div style={{ border: '1px solid rgba(148,163,184,0.22)', borderRadius: 12, overflow: 'hidden' }}>
                          <div className="ai-storyboard-asset-list">
                            {planAssets.map((asset) => {
                              const assetId = String(asset?.id || '').trim()
                              const generating = props.assetGeneratingId === assetId && props.assetPlanBusy
                              const needsRef = String(asset?.renderStrategy || '').trim() !== 'prompt_only'
                              const generatedRefs = Array.isArray(asset?.generatedRefs) ? asset.generatedRefs : []
                              const latestGeneratedRef = generatedRefs.length ? generatedRefs[generatedRefs.length - 1] : null
                              const rawUri =
                                String(asset?.primaryReferenceAssetUri || '').trim() ||
                                String(latestGeneratedRef?.projectAssetUri || '').trim() ||
                                String(latestGeneratedRef?.remoteUrl || '').trim()
                              const previewSrc = rawUri
                                ? (
                                    /^https?:\/\//i.test(rawUri) || rawUri.startsWith('data:')
                                      ? rawUri
                                      : (props.projectId ? resolveUrl(`/project-assets/${encodeURIComponent(String(props.projectId))}/${rawUri.replace(/^\/+/, '')}`) : '')
                                  )
                                : ''
                              const latestReview = asset?.latestReferenceReview && typeof asset.latestReferenceReview === 'object' ? asset.latestReferenceReview : null
                              const latestReviewTarget = String(latestReview?.targetAssetUri || '').trim()
                              const reviewMatchesPreview = latestReview && latestReviewTarget && rawUri && latestReviewTarget === rawUri
                              const reviewScore = Number(latestReview?.score)
                              const reviewSummary = String(latestReview?.summary || '').trim()
                              const analyzing = props.assetAnalyzingId === assetId && props.assetPlanBusy
                              const batch = Array.isArray(asset?.latestReferenceBatch) ? asset.latestReferenceBatch.slice(0, 4) : []
                              const candidateItems = Array.from({ length: 4 }, (_, idx) => batch[idx] || null)
                              return (
                                <div key={assetId} className="ai-storyboard-asset-row">
                                  <div className="ai-storyboard-asset-meta">
                                    <div className={`ai-storyboard-asset-preview ${previewSrc ? 'ready' : 'missing'}`}>
                                      {previewSrc ? (
                                        <img src={previewSrc} alt={String(asset?.name || assetId || 'asset')} />
                                      ) : (
                                        <div className="ai-storyboard-asset-placeholder">
                                          <div className="ai-storyboard-asset-placeholder-title">{String(asset?.name || assetId || '未命名资产')}</div>
                                          <div className="hint">待生成参考图</div>
                                        </div>
                                      )}
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                                      <div style={{ fontWeight: 800 }}>{String(asset?.name || assetId || '未命名资产')}</div>
                                      <div className={`ai-storyboard-status ${String(asset?.referenceStatus || '').trim() === 'ready' ? 'ok' : 'bad'}`}>{getAssetStatusLabel(String(asset?.referenceStatus || ''))}</div>
                                    </div>
                                    <div className="hint">{getAssetCategoryLabel(String(asset?.category || ''))} / {getAssetStrategyLabel(String(asset?.renderStrategy || ''))} / 涉及 {Number(asset?.sceneCount || 0)} 个场景</div>
                                    {reviewMatchesPreview ? (
                                      <div className="hint" style={{ whiteSpace: 'pre-wrap', color: latestReview?.passed ? '#a7f3d0' : '#fde68a' }}>
                                        {Number.isFinite(reviewScore) ? `最佳评分：${Math.round(reviewScore)} / 100` : '最佳评分：n/a'}
                                        {reviewSummary ? `，${reviewSummary}` : ''}
                                      </div>
                                    ) : null}
                                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                      <button className="btn secondary" type="button" onClick={() => props.onGenerateAssetRef(assetId)} disabled={busy || !needsRef || !assetId}>
                                        {generating ? '生成中…' : (String(asset?.referenceStatus || '').trim() === 'ready' ? '重新生成参考图' : '生成参考图')}
                                      </button>
                                      <button className="btn secondary" type="button" onClick={() => props.onAnalyzeAssetRef(assetId)} disabled={busy || !previewSrc || !assetId}>
                                        {analyzing ? '分析中…' : '分析准确率'}
                                      </button>
                                    </div>
                                  </div>
                                  <div className="ai-storyboard-asset-batch">
                                    {candidateItems.map((candidate, idx) => {
                                      const candidateUri = String(candidate?.assetPath || '').trim()
                                      const candidateSrc = candidateUri && props.projectId ? resolveUrl(`/project-assets/${encodeURIComponent(String(props.projectId))}/${candidateUri.replace(/^\/+/, '')}`) : ''
                                      const candidateScore = Number(candidate?.analysis?.score)
                                      return (
                                        <div key={`${assetId}_candidate_${idx}`} className="ai-storyboard-asset-candidate">
                                          <div className={`ai-storyboard-asset-candidate-preview ${candidateSrc ? 'ready' : 'missing'}`}>
                                            {candidateSrc ? <img src={candidateSrc} alt={`${String(asset?.name || assetId)}_${idx + 1}`} /> : <div className="hint">候选 {idx + 1}</div>}
                                          </div>
                                          <div className="hint">
                                            {candidate
                                              ? `#${idx + 1} ${Number.isFinite(candidateScore) ? `${Math.round(candidateScore)}/100` : 'n/a'}`
                                              : `#${idx + 1} 等待生成`}
                                          </div>
                                        </div>
                                      )
                                    })}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      </div>
                    )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="ai-storyboard-pane">
                <div className="ai-storyboard-section">
                  <div className="ai-storyboard-section-head">
                    <div className="ai-storyboard-section-title">正式出图前检查</div>
                    <button className="btn secondary" type="button" onClick={() => setActiveTab('lock')}>
                      返回锁定事物
                    </button>
                  </div>
                  <div className="ai-storyboard-section-body">
                    <div className="hint">这一阶段只处理“正确出图”。如果需要改 checkpoint、LoRA、采样参数或重跑锁定测试，请返回“锁定事物”标签。</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                      <span className="ai-storyboard-status ok">锁定门禁: 已通过</span>
                      <span className="ai-storyboard-status ok">Checkpoint: {String((v as any).model || imageModelLabel || '(default)')}</span>
                      <span className="ai-storyboard-status ok">LoRA: {configuredLoras.length ? configuredLoras.join(' | ') : '(none)'}</span>
                    </div>
                  </div>
                </div>

                <div className="ai-storyboard-section">
                  <div className="ai-storyboard-section-head">
                    <div className="ai-storyboard-section-title">{isDoubaoWorkflow ? 'Step 6. 检查全局连续锚点（全故事）' : 'Step 6. 检查全局提示词（全故事）'}</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
                  </div>
                  <div className="ai-storyboard-section-body">
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
                    <div className="ai-storyboard-fields" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
                      <div className="ai-storyboard-field" style={{ gridColumn: 'span 1' }}>
                        <label>{isDoubaoWorkflow ? '全局正向（中文）' : '全局正向（中文强化版）'}</label>
                        <textarea rows={5} value={String((v as any).globalPromptZh || '')} onChange={(e) => props.onChangeGlobalPromptZh(e.target.value)} />
                      </div>
                      <div className="ai-storyboard-field" style={{ gridColumn: 'span 1' }}>
                        <label>{isDoubaoWorkflow ? '全局正向（英文）' : '全局正向（英文出图）'}</label>
                        <textarea rows={5} value={v.globalPrompt || ''} onChange={(e) => props.onChange({ ...v, globalPrompt: e.target.value })} />
                      </div>
                      <div className="ai-storyboard-field" style={{ gridColumn: 'span 1' }}>
                        <label>{isDoubaoWorkflow ? '全局负向（中文）' : '全局负向（中文强化版）'}</label>
                        <textarea rows={4} value={String((v as any).globalNegativePromptZh || '')} onChange={(e) => props.onChangeGlobalNegativePromptZh(e.target.value)} />
                      </div>
                      <div className="ai-storyboard-field" style={{ gridColumn: 'span 1' }}>
                        <label>{isDoubaoWorkflow ? '全局负向（英文）' : '全局负向（英文出图）'}</label>
                        <textarea rows={4} value={v.globalNegativePrompt || ''} onChange={(e) => props.onChange({ ...v, globalNegativePrompt: e.target.value })} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="ai-storyboard-pane">
                <div className="ai-storyboard-section ai-storyboard-scenes">
                  <div className="ai-storyboard-section-head">
                    <div className="ai-storyboard-section-title">Step 7. 场景提示词列表（可编辑）</div>
                    <div className="hint">共 {props.items.length} 个场景</div>
                  </div>
                  <div className="ai-storyboard-section-body" style={{ minHeight: 0 }}>
                    <div className="ai-storyboard-scenes-list">
                      <div className="ai-storyboard-scenes-scroll">
                        {props.items.map((it, idx) => (
                          <div key={it.nodeId} style={{ borderBottom: '1px solid rgba(148,163,184,0.12)', padding: 10 }}>
                            <div style={{ fontWeight: 800, marginBottom: 6 }}>
                              #{idx + 1} {it.nodeName} <span className="hint">({it.nodeId})</span> {it.status ? <span className="hint">[{it.status}]</span> : null}
                              {(props.busyGenerate || props.busyApply) && (it.status === 'generating' || it.status === 'applying') && props.generatingNodeId === it.nodeId ? (
                                <span className="hint">（{((props.generatingNodeElapsedMs || 0) / 1000).toFixed(1)}s）</span>
                              ) : null}
                            </div>
                            <div className="hint" style={{ marginBottom: 6, whiteSpace: 'pre-wrap' }}>场景原文：{it.userInput || '(无场景文本)'}</div>
                            {it.promptReview ? (
                              <div style={{ border: '1px solid rgba(148,163,184,0.18)', borderRadius: 10, padding: 10, marginBottom: 8 }}>
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                  <span className={`ai-storyboard-status ${getPromptReviewTone(it.promptReview).cls}`}>
                                    AI 评分：{Number.isFinite(Number(it.promptReview.ai.score)) ? `${Math.round(Number(it.promptReview.ai.score))}/100` : 'n/a'}
                                  </span>
                                  <span className="hint" style={{ color: getPromptReviewTone(it.promptReview).color }}>{it.promptReview.ai.summary}</span>
                                </div>
                                {it.promptReview.ai.suggestions?.length ? (
                                  <div className="hint" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>建议：{it.promptReview.ai.suggestions.slice(0, 3).join('；')}</div>
                                ) : null}
                                {it.promptReview.aiError?.message ? (
                                  <div className="hint" style={{ marginTop: 6, color: '#fca5a5' }}>AI 回退：{it.promptReview.aiError.message}</div>
                                ) : null}
                              </div>
                            ) : null}
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                              <button className="btn secondary" type="button" onClick={() => props.onReviewItemPrompt(it.nodeId)} disabled={busy || props.promptReviewingNodeId === it.nodeId || !String(it.prompt || it.userInput || '').trim()}>
                                {props.promptReviewingNodeId === it.nodeId ? '评分中…' : 'AI 评分'}
                              </button>
                              <button className="btn secondary" type="button" onClick={() => props.onApplyItemPromptReview(it.nodeId)} disabled={busy || !it.promptReview?.ai?.optimizedPrompt}>
                                继续强化提示词
                              </button>
                            </div>
                            <textarea rows={3} value={it.promptZh || ''} onChange={(e) => props.onChangeItem(it.nodeId, { promptZh: e.target.value })} placeholder="AI 强化后的中文场景提示词" />
                            <textarea rows={3} style={{ marginTop: 6 }} value={it.prompt || ''} onChange={(e) => props.onChangeItem(it.nodeId, { prompt: e.target.value })} placeholder="英文场景提示词（用于出图）" />
                            <input
                              style={{ marginTop: 6 }}
                              value={it.negativePromptZh || ''}
                              onChange={(e) => props.onChangeItem(it.nodeId, { negativePromptZh: e.target.value })}
                              placeholder="中文场景负向提示词（可选）"
                            />
                            <input
                              style={{ marginTop: 6 }}
                              value={it.negativePrompt || ''}
                              onChange={(e) => props.onChangeItem(it.nodeId, { negativePrompt: e.target.value })}
                              placeholder="英文场景负向提示词（用于出图）"
                            />
                            {it.note ? <div className="hint" style={{ marginTop: 4 }}>{it.note}</div> : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="ai-storyboard-section" style={{ marginTop: 10 }}>
                  <div className="ai-storyboard-section-head">
                    <div className="ai-storyboard-section-title">Step 8. 运行日志</div>
                    {busy ? (
                      <div className="hint">
                        计时：{(props.elapsedMs / 1000).toFixed(1)}s（{props.busyEntity ? '生成 Story Bible 中' : (props.busyGenerate ? '生成提示词中' : '批量出图中')}{props.queuePaused ? '，已暂停' : ''}）
                      </div>
                    ) : (
                      <div className="hint">（仅用于排查，不影响出图）</div>
                    )}
                  </div>
                  <div className="ai-storyboard-section-body">
                    <textarea readOnly value={props.logs.length ? props.logs.join('\n') : '(暂无日志)'} rows={7} />
                    {props.error ? <div className="ai-modal-err">{props.error}</div> : null}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="ai-storyboard-actions">
          {!envReady ? (
            <div className="hint" style={{ marginBottom: 8 }}>
              环境检查未通过：请先完成 Step 1 的问题修复，再继续后续步骤。
            </div>
          ) : null}
          {!props.assetConfirmReady ? (
            <div className="hint" style={{ marginBottom: 8 }}>
              门禁未通过：请按 Step 3 → Step 4 先生成并确认必要事物资产，再进入 Step 5。
            </div>
          ) : !props.continuityReady ? (
            <div className="hint" style={{ marginBottom: 8 }}>
              门禁未通过：请按 Step 5 完成连续性预检后，才会开放“生成提示词/批量出图”。
            </div>
          ) : null}
          {activeTab === 'lock' ? (
            <div className="ai-storyboard-actions-row">
              <div className="left">
                <button onClick={() => setActiveTab('render')} disabled={!renderTabReady}>
                  进入正确出图
                </button>
              </div>
              <div className="right">
                <span className="hint">锁定事物必须先通过门禁，正式出图标签才会开放。</span>
              </div>
            </div>
          ) : (
            <div className="ai-storyboard-actions-row">
              <div className="left">
                <button onClick={props.onGenerateAll} disabled={!canGenerateAll}>
                  {props.busyGenerate ? '生成中…' : '生成所有场景提示词'}
                </button>
                <button onClick={props.onRetryPending} disabled={!canRetryGenerate}>
                  重试失败/继续未完成
                </button>
              </div>
              <div className="right">
                <button onClick={props.onApplyAll} disabled={!canApplyAll}>
                  {props.busyApply ? '应用中…' : '校验并应用（批量出图）'}
                </button>
                <button onClick={props.onRetryApplyPending} disabled={!canRetryApply}>
                  重试失败/继续未完成出图
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
          )}
        </div>
      </div>
    </div>
  )
}
