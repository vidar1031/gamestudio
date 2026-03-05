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
  value: AiBackgroundRequest & { entitySpec?: string }
  items: StoryboardBatchItem[]
  busyGenerate: boolean
  busyApply: boolean
  busyEntity: boolean
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

  return (
    <div className="ai-modal" role="dialog" aria-modal="true">
      <div className="ai-modal-card ai-background-modal-card" style={{ width: 'min(1100px, calc(100vw - 24px))', maxHeight: 'calc(100vh - 24px)' }}>
        <div className="ai-modal-head">
          <div className="ai-modal-title" style={{ marginBottom: 0 }}>AI 分镜批量生成</div>
          <button type="button" className="icon-btn" onClick={props.onClose} disabled={busy} aria-label="关闭" title="关闭">
            ✕
          </button>
        </div>

        <div className="ai-modal-grid">
          <div className="ai-modal-row">
            <label>风格</label>
            <select className="sel" value={v.style || 'picture_book'} onChange={(e) => props.onChange({ ...v, style: e.target.value as any })}>
              <option value="picture_book">绘本（picture_book）</option>
              <option value="cartoon">卡通（cartoon）</option>
              <option value="national_style">国风（national_style）</option>
              <option value="watercolor">水彩（watercolor）</option>
            </select>
          </div>
          <div className="ai-modal-row">
            <label>比例</label>
            <select className="sel" value={v.aspectRatio || '9:16'} onChange={(e) => props.onChange({ ...v, aspectRatio: e.target.value as any })}>
              <option value="9:16">9:16</option>
              <option value="16:9">16:9</option>
              <option value="1:1">1:1</option>
              <option value="9:1">9:1</option>
            </select>
          </div>
          <div className="ai-modal-row">
            <label>宽</label>
            <input type="number" value={v.width ?? 768} onChange={(e) => props.onChange({ ...v, width: Number(e.target.value) })} />
          </div>
          <div className="ai-modal-row">
            <label>高</label>
            <input type="number" value={v.height ?? 1344} onChange={(e) => props.onChange({ ...v, height: Number(e.target.value) })} />
          </div>
          <div className="ai-modal-row">
            <label>步数</label>
            <select className="sel" value={String(v.steps ?? 20)} onChange={(e) => props.onChange({ ...v, steps: Number(e.target.value) })}>
              <option value="20">20</option>
              <option value="24">24</option>
              <option value="28">28</option>
              <option value="30">30</option>
              <option value="35">35</option>
            </select>
          </div>
          <div className="ai-modal-row">
            <label>CFG</label>
            <select className="sel" value={String(v.cfgScale ?? 7)} onChange={(e) => props.onChange({ ...v, cfgScale: Number(e.target.value) })}>
              <option value="5">5</option>
              <option value="6">6</option>
              <option value="6.5">6.5</option>
              <option value="7">7</option>
              <option value="7.5">7.5</option>
              <option value="8">8</option>
            </select>
          </div>
          <div className="ai-modal-row">
            <label>采样器</label>
            <select className="sel" value={String((v as any).sampler || 'DPM++ 2M')} onChange={(e) => props.onChange({ ...v, sampler: e.target.value } as any)}>
              <option value="DPM++ 2M">DPM++ 2M</option>
              <option value="DPM++ SDE">DPM++ SDE</option>
              <option value="Euler a">Euler a</option>
              <option value="Euler">Euler</option>
              <option value="UniPC">UniPC</option>
            </select>
          </div>
          <div className="ai-modal-row">
            <label>调度器</label>
            <select className="sel" value={String((v as any).scheduler || 'Automatic')} onChange={(e) => props.onChange({ ...v, scheduler: e.target.value } as any)}>
              <option value="Automatic">Automatic</option>
              <option value="Karras">Karras</option>
              <option value="Exponential">Exponential</option>
              <option value="SGM Uniform">SGM Uniform</option>
              <option value="Simple">Simple</option>
            </select>
          </div>
        </div>

        <div className="ai-modal-row">
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span>故事事物设定（角色/道具/禁用项）</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn secondary" type="button" onClick={() => props.onChange({ ...v, entitySpec: '' })} disabled={busy || !String((v as any).entitySpec || '').trim()}>
                Clear
              </button>
              <button className="btn secondary" type="button" onClick={props.onGenerateEntity} disabled={busy || !props.items.length}>
                {props.busyEntity ? '生成中…' : 'AI 生成设定'}
              </button>
            </div>
          </label>
          <textarea
            rows={4}
            value={String((v as any).entitySpec || '')}
            onChange={(e) => props.onChange({ ...v, entitySpec: e.target.value })}
            placeholder="用于锁定全故事角色、道具、关键物体与禁用替代项（可手动修改）"
          />
        </div>

        <div className="ai-modal-row">
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span>全局正向（全故事）</span>
            <button className="btn secondary" type="button" onClick={props.onClearGlobalPrompt} disabled={busy || !String(v.globalPrompt || '').trim()}>
              Clear
            </button>
          </label>
          <textarea rows={4} value={v.globalPrompt || ''} onChange={(e) => props.onChange({ ...v, globalPrompt: e.target.value })} />
        </div>
        <div className="ai-modal-row">
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span>全局负向（全故事）</span>
            <button className="btn secondary" type="button" onClick={props.onClearGlobalNegativePrompt} disabled={busy || !String(v.globalNegativePrompt || '').trim()}>
              Clear
            </button>
          </label>
          <input value={v.globalNegativePrompt || ''} onChange={(e) => props.onChange({ ...v, globalNegativePrompt: e.target.value })} />
        </div>

        <div className="ai-modal-row">
          <label>场景提示词列表（可编辑）</label>
          <div style={{ border: '1px solid rgba(148,163,184,0.22)', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ maxHeight: 360, overflow: 'auto' }}>
              {props.items.map((it, idx) => (
                <div key={it.nodeId} style={{ borderBottom: '1px solid rgba(148,163,184,0.12)', padding: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>
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

        {busy ? (
          <div className="hint" style={{ marginTop: 6, marginBottom: 2 }}>
            任务计时：{(props.elapsedMs / 1000).toFixed(1)}s（{props.busyGenerate ? '生成提示词中' : '批量出图中'}{props.queuePaused ? '，已暂停' : ''}）
          </div>
        ) : null}

        <div className="ai-modal-row">
          <label>运行日志</label>
          <textarea readOnly value={props.logs.length ? props.logs.join('\n') : '(暂无日志)'} rows={6} />
        </div>

        {props.error ? <div className="ai-modal-err">{props.error}</div> : null}

        <div className="ai-modal-actions">
          <button onClick={props.onGenerateAll} disabled={busy || !props.items.length}>
            {props.busyGenerate ? '生成中…' : '生成所有场景提示词'}
          </button>
          <button
            onClick={props.onRetryPending}
            disabled={busy || !props.items.some((x) => x.status === 'error' || !String(x.prompt || '').trim())}
          >
            重试失败/继续未完成
          </button>
          <button onClick={props.onApplyAll} disabled={busy || !props.canApplyAll}>
            {props.busyApply ? '应用中…' : '校验并应用（批量出图）'}
          </button>
          <button
            onClick={props.onRetryApplyPending}
            disabled={busy || !props.items.some((x) => x.status === 'error' || x.status === 'generated')}
          >
            重试失败/继续未完成出图
          </button>
          <button onClick={props.onPauseQueue} disabled={!busy || props.queuePaused}>
            暂停任务
          </button>
          <button onClick={props.onResumeQueue} disabled={!busy || !props.queuePaused}>
            继续任务
          </button>
          <button onClick={props.onCancelQueue} disabled={!busy}>
            取消任务
          </button>
        </div>
      </div>
    </div>
  )
}
