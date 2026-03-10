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

export default function AiStoryboardBatchModal(props: {
  open: boolean
  value: AiBackgroundRequest & { entitySpec?: string; storyBibleJson?: string }
  items: StoryboardBatchItem[]
  busyGenerate: boolean
  busyApply: boolean
  busyEntity: boolean
  continuityReady: boolean
  continuitySummary: string
  continuityBusy: boolean
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
  const canRunContinuityTest = !busy && !props.continuityBusy
  const canGenerateAll = !busy && props.items.length > 0 && props.continuityReady
  const canRetryGenerate = !busy && props.continuityReady && props.items.some((x) => x.status === 'error' || !String(x.prompt || '').trim())
  const canApplyAll = !busy && props.continuityReady && props.canApplyAll
  const canRetryApply = !busy && props.continuityReady && props.items.some((x) => x.status === 'error' || x.status === 'generated')

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
              {props.continuityReady ? '连续分镜：已就绪' : '连续分镜：未就绪'}
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
              <div className="ai-storyboard-section-head">
                <div className="ai-storyboard-section-title">出图参数</div>
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
                    <select value={v.aspectRatio || '9:16'} onChange={(e) => props.onChange({ ...v, aspectRatio: e.target.value as any })}>
                      <option value="9:16">9:16</option>
                      <option value="16:9">16:9</option>
                      <option value="1:1">1:1</option>
                      <option value="9:1">9:1</option>
                    </select>
                  </div>
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
                </div>
              </div>
            </div>

            <div className="ai-storyboard-section">
              <div className="ai-storyboard-section-head">
                <div className="ai-storyboard-section-title">Story Bible（角色/道具/地点锁定）</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn secondary" type="button" onClick={props.onClearStoryBible} disabled={busy || !String((v as any).storyBibleJson || '').trim()}>
                    Clear
                  </button>
                  <button className="btn secondary" type="button" onClick={props.onGenerateEntity} disabled={busy || !props.items.length}>
                    {props.busyEntity ? '生成中…' : 'AI 生成 Story Bible'}
                  </button>
                </div>
              </div>
              <div className="ai-storyboard-section-body">
                <textarea
                  rows={8}
                  value={String((v as any).storyBibleJson || '')}
                  onChange={(e) => props.onChange({ ...v, storyBibleJson: e.target.value } as any)}
                  placeholder="JSON（可手动修改）。生成后会用于批量提示词与出图，锁定角色/道具/地点的连续性。"
                />
                <div className="hint" style={{ marginTop: 8 }}>
                  Story Bible 是“可复用资产库”。后续生成场景提示词/批量出图会自动抽取 WORLD_ANCHOR、角色/道具/地点锚点与禁用替代项。
                </div>
              </div>
            </div>

            <div className="ai-storyboard-section">
              <div className="ai-storyboard-section-head">
                <div className="ai-storyboard-section-title">连续分镜锁定（必须通过才能生成/出图）</div>
                <button className="btn secondary" type="button" onClick={props.onRunContinuityTest} disabled={!canRunContinuityTest}>
                  {props.continuityBusy ? '测试中…' : '运行锁定测试'}
                </button>
              </div>
              <div className="ai-storyboard-section-body">
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

                {cfg.ipadapterEnabled ? (
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
                <div className="ai-storyboard-section-title">全局提示词（全故事）</div>
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
                <div className="hint" style={{ marginBottom: 6 }}>正向（会自动叠加到每个场景提示词）</div>
                <textarea rows={4} value={v.globalPrompt || ''} onChange={(e) => props.onChange({ ...v, globalPrompt: e.target.value })} />
                <div className="hint" style={{ marginTop: 10, marginBottom: 6 }}>负向（会自动叠加到每个场景负向）</div>
                <input value={v.globalNegativePrompt || ''} onChange={(e) => props.onChange({ ...v, globalNegativePrompt: e.target.value })} />
              </div>
            </div>
          </div>

          <div className="ai-storyboard-pane">
            <div className="ai-storyboard-section ai-storyboard-scenes">
              <div className="ai-storyboard-section-head">
                <div className="ai-storyboard-section-title">场景提示词列表（可编辑）</div>
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
                <div className="ai-storyboard-section-title">运行日志</div>
                {busy ? (
                  <div className="hint">
                    计时：{(props.elapsedMs / 1000).toFixed(1)}s（{props.busyGenerate ? '生成提示词中' : '批量出图中'}{props.queuePaused ? '，已暂停' : ''}）
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
          {!props.continuityReady ? (
            <div className="hint" style={{ marginBottom: 8 }}>
              门禁未通过：请先完成 Story Bible 与“运行锁定测试”，通过后才会开放“生成提示词/批量出图”。
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
