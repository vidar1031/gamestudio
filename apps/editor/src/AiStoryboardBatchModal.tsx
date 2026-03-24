import React from 'react'
import type { AiBackgroundRequest } from './api'

export type StoryboardBatchItem = {
  nodeId: string
  nodeName: string
  userInput: string
  prompt: string
  negativePrompt: string
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

export default function AiStoryboardBatchModal(props: {
  open: boolean
  value: AiBackgroundRequest & { entitySpec?: string; storyBibleJson?: string }
  items: StoryboardBatchItem[]
  busyGenerate: boolean
  busyApply: boolean
  busyEntity: boolean
  entityElapsedMs?: number
  continuityReady: boolean
  continuitySummary: string
  continuityBusy: boolean
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
  onChangeItem: (nodeId: string, patch: Partial<StoryboardBatchItem>) => void
  onClearGlobalPrompt: () => void
  onClearGlobalNegativePrompt: () => void
  onClose: () => void
  onGenerateEntity: () => void
  onClearStoryBible: () => void
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
  if (!props.open) return null
  const v = props.value
  const busy = props.busyGenerate || props.busyApply || props.busyEntity
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
  const canRunContinuityTest = !busy && !props.continuityBusy && openChecks.serverOk && openChecks.imageOk
  const envReady = openChecks.ok
  const imageProvider = String(openChecks.imageProvider || '').toLowerCase()
  const promptProvider = String(openChecks.promptProvider || '').toLowerCase()
  const isDoubaoImage = imageProvider === 'doubao'
  const isDoubaoWorkflow = isDoubaoImage && promptProvider === 'doubao'
  const doubaoDefaultSize = getDoubaoDefaultSize(String(v.aspectRatio || '9:16'))
  const doubaoOrientation = getDoubaoOrientationLabel(String(v.aspectRatio || '9:16'))
  const canGenerateAll = !busy && envReady && props.items.length > 0 && props.continuityReady
  const canRetryGenerate = !busy && envReady && props.continuityReady && props.items.some((x) => x.status === 'error' || !String(x.prompt || '').trim())
  const canApplyAll = !busy && envReady && props.continuityReady && props.canApplyAll
  const canRetryApply = !busy && envReady && props.continuityReady && props.items.some((x) => x.status === 'error' || x.status === 'generated')

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

        <div className="ai-storyboard-body">
          <div className="ai-storyboard-pane">
            <div className="ai-storyboard-section">
              <div className="ai-storyboard-section-body">
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <span className="ai-storyboard-status ok">文本模型: {openChecks.promptProvider || 'none'}{openChecks.promptModel ? ` / ${openChecks.promptModel}` : ''}</span>
                  <span className="ai-storyboard-status ok">生图模型: {openChecks.imageProvider || 'none'}{openChecks.imageModel ? ` / ${openChecks.imageModel}` : ''}</span>
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
                  {openChecks.issues.length ? (
                    <div style={{ display: 'grid', gap: 6 }}>
                      {openChecks.issues.map((issue, idx) => (
                        <div key={idx} className="ai-modal-err" style={{ marginTop: 0 }}>{issue}</div>
                      ))}
                    </div>
                  ) : null}
                  {openChecks.details.length ? (
                    <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>
                      {openChecks.details.join('\n')}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="ai-storyboard-section">
              <div className="ai-storyboard-section-head">
                <div className="ai-storyboard-section-title">Step 2. 设定出图参数</div>
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
                {isDoubaoImage ? (
                  <div className="hint" style={{ marginTop: 6 }}>
                    建议参数：返回格式 `url`、水印 `关闭`、组图模式 `auto`。Doubao 模式下无需设置 CFG/采样器/调度器；真正影响连续性的是连续性 Bible、全局锚点、场景提示词和组图模式。
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
                <div className="hint" style={{ marginTop: 8 }}>
                  {isDoubaoWorkflow
                    ? '连续性 Bible 是 Doubao 多场景连续生成的核心输入。后续生成场景提示词/批量出图会自动抽取 WORLD_ANCHOR、角色外观锚点、关键道具、地点约束与禁用替代项。'
                    : 'Story Bible 是“可复用资产库”。后续生成场景提示词/批量出图会自动抽取 WORLD_ANCHOR、角色/道具/地点锚点与禁用替代项。'}
                </div>
              </div>
            </div>

            <div className="ai-storyboard-section">
              <div className="ai-storyboard-section-head">
                <div className="ai-storyboard-section-title">{isDoubaoWorkflow ? 'Step 4. 连续性预检（必须通过才能生成/出图）' : 'Step 4. 连续分镜锁定测试（必须通过才能生成/出图）'}</div>
                <button className="btn secondary" type="button" onClick={props.onRunContinuityTest} disabled={!canRunContinuityTest}>
                  {props.continuityBusy ? '测试中…' : (isDoubaoWorkflow ? '运行连续性预检' : '运行锁定测试')}
                </button>
              </div>
              <div className="ai-storyboard-section-body">
                {isDoubaoWorkflow ? (
                  <div className="ai-storyboard-kv">
                    <div className="hint">Doubao 模式下，这一步会检查三件事：Story Bible 是否有效、Doubao 文本/生图是否可用、以及按当前参数执行一次测试出图。</div>
                    <div className="hint">角色参考图在 Doubao 模式下不是硬门禁；连续性主要依赖连续性 Bible、全局提示词和 `sequential_image_generation`。</div>
                    <div className="hint">
                      门禁：{props.continuityReady ? '已通过' : '未通过'}{props.continuitySummary ? `，${props.continuitySummary}` : ''}
                    </div>
                  </div>
                ) : (
                  <div className="ai-storyboard-kv">
                    <label className="hint ai-storyboard-check">
                      <input
                        type="checkbox"
                        checked={Boolean(cfg.ipadapterEnabled)}
                        onChange={(e) => props.onChangeContinuityConfig({ ipadapterEnabled: e.target.checked })}
                        disabled={busy}
                      />
                      <span>启用 IP-Adapter（锁定角色脸/服装，需要角色参考图）</span>
                    </label>
                    {cfg.ipadapterEnabled ? (
                      <label className="hint ai-storyboard-check">
                        <input
                          type="checkbox"
                          checked={Boolean(cfg.requireCharacterRefs)}
                          onChange={(e) => props.onChangeContinuityConfig({ requireCharacterRefs: e.target.checked })}
                          disabled={busy}
                        />
                        <span>强制要求“出现过的角色”都有参考图（推荐）</span>
                      </label>
                    ) : null}
                    <label className="hint ai-storyboard-check">
                      <input
                        type="checkbox"
                        checked={Boolean(cfg.controlnetEnabled)}
                        onChange={(e) => props.onChangeContinuityConfig({ controlnetEnabled: e.target.checked })}
                        disabled={true}
                      />
                      <span>启用 ControlNet（锁姿态/构图，开发中）</span>
                    </label>
                    <div className="hint">
                      门禁：{props.continuityReady ? '已通过' : '未通过'}{props.continuitySummary ? `，${props.continuitySummary}` : ''}
                    </div>
                  </div>
                )}

                {!isDoubaoWorkflow && cfg.ipadapterEnabled ? (
                  <div style={{ marginTop: 10 }}>
                    <div className="hint" style={{ fontWeight: 800, marginBottom: 6 }}>角色参考绑定（用于连续出图）</div>
                    <div style={{ border: '1px solid rgba(148,163,184,0.22)', borderRadius: 12, overflow: 'hidden' }}>
                      <div style={{ maxHeight: 260, overflow: 'auto' }}>
                        {(props.characters || []).map((ch) => (
                          <div key={ch.id} style={{ borderBottom: '1px solid rgba(148,163,184,0.12)', padding: 10, display: 'grid', gap: 6 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                              <div style={{ fontWeight: 800 }}>{ch.name} <span className="hint">({ch.id})</span></div>
                              <div className="hint">
                                {ch.referenceAssetId ? 'ref=ok' : 'ref=missing'}
                                {ch.hasSprite ? ' / sprite=ok' : ''}
                              </div>
                            </div>
                            {ch.fingerprintPrompt ? <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>{ch.fingerprintPrompt}</div> : <div className="hint">缺少 fingerprintPrompt（建议先生成角色指纹）</div>}
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                              <button className="btn secondary" type="button" onClick={() => props.onGenerateCharacterRef(ch.id)} disabled={busy || !ch.fingerprintPrompt}>
                                生成参考图
                              </button>
                              <button className="btn secondary" type="button" onClick={() => props.onBindCharacterRefFromSprite(ch.id)} disabled={busy || !ch.hasSprite}>
                                绑定角色图
                              </button>
                              <button className="btn secondary" type="button" onClick={() => props.onClearCharacterRef(ch.id)} disabled={busy || !ch.referenceAssetId}>
                                清除
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="ai-storyboard-section">
              <div className="ai-storyboard-section-head">
                <div className="ai-storyboard-section-title">{isDoubaoWorkflow ? 'Step 5. 检查全局连续锚点（全故事）' : 'Step 5. 检查全局提示词（全故事）'}</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn secondary" type="button" onClick={props.onClearGlobalPrompt} disabled={busy || !String(v.globalPrompt || '').trim()}>
                    清空正向
                  </button>
                  <button className="btn secondary" type="button" onClick={props.onClearGlobalNegativePrompt} disabled={busy || !String(v.globalNegativePrompt || '').trim()}>
                    清空负向
                  </button>
                </div>
              </div>
              <div className="ai-storyboard-section-body">
                <div className="hint" style={{ marginBottom: 6 }}>{isDoubaoWorkflow ? '正向（作为全故事连续锚点，自动叠加到每个场景提示词）' : '正向（会自动叠加到每个场景提示词）'}</div>
                <textarea rows={4} value={v.globalPrompt || ''} onChange={(e) => props.onChange({ ...v, globalPrompt: e.target.value })} />
                <div className="hint" style={{ marginTop: 10, marginBottom: 6 }}>{isDoubaoWorkflow ? '负向（作为全故事禁用替代项，自动叠加到每个场景负向）' : '负向（会自动叠加到每个场景负向）'}</div>
                <input value={v.globalNegativePrompt || ''} onChange={(e) => props.onChange({ ...v, globalNegativePrompt: e.target.value })} />
              </div>
            </div>
          </div>

          <div className="ai-storyboard-pane">
            <div className="ai-storyboard-section ai-storyboard-scenes">
              <div className="ai-storyboard-section-head">
                <div className="ai-storyboard-section-title">Step 6. 场景提示词列表（可编辑）</div>
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
                        <textarea rows={3} value={it.prompt || ''} onChange={(e) => props.onChangeItem(it.nodeId, { prompt: e.target.value })} placeholder="AI 生成提示词（用于出图）" />
                        <input
                          style={{ marginTop: 6 }}
                          value={it.negativePrompt || ''}
                          onChange={(e) => props.onChangeItem(it.nodeId, { negativePrompt: e.target.value })}
                          placeholder="场景负向提示词（可选）"
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
                <div className="ai-storyboard-section-title">Step 7. 运行日志</div>
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
        </div>

        <div className="ai-storyboard-actions">
          {!envReady ? (
            <div className="hint" style={{ marginBottom: 8 }}>
              环境检查未通过：请先完成 Step 1 的问题修复，再继续后续步骤。
            </div>
          ) : null}
          {!props.continuityReady ? (
            <div className="hint" style={{ marginBottom: 8 }}>
              门禁未通过：请按 Step 3 → Step 4 完成后，才会开放“生成提示词/批量出图”。
            </div>
          ) : null}
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
        </div>
      </div>
    </div>
  )
}
