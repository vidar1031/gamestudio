import React from 'react'
import type { AiBackgroundRequest } from './api'

export default function AiBackgroundModal(props: {
  open: boolean
  value: AiBackgroundRequest
  busy: boolean
  analyzing: boolean
  error: string
  result?: null | { url?: string; assetPath?: string; provider?: string; remoteUrl?: string }
  onChange: (next: AiBackgroundRequest) => void
  onClose: () => void
  onAnalyze: () => void
  onAutoRecognize?: () => void
  onSubmit: () => void
  onOpenDir?: () => void
  onOpenImage?: () => void
  onOpenRemote?: () => void
  onDownload?: () => void
}) {
  const [ratioPreset, setRatioPreset] = React.useState<'custom' | '9:16' | '16:9' | '9:1'>('custom')
  const [elapsedMs, setElapsedMs] = React.useState(0)
  const v = props.value
  const r = props.result || null

  React.useEffect(() => {
    if (!props.open) return
    const ar = String(v.aspectRatio || '').trim()
    if (ar === '9:16' || ar === '16:9' || ar === '9:1') setRatioPreset(ar as any)
    else setRatioPreset('custom')
  }, [props.open, v.aspectRatio])

  React.useEffect(() => {
    if (!props.open || !props.busy) {
      setElapsedMs(0)
      return
    }
    const startedAt = Date.now()
    setElapsedMs(0)
    const t = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt)
    }, 100)
    return () => window.clearInterval(t)
  }, [props.open, props.busy])

  if (!props.open) return null

  const applyPreset = (preset: typeof ratioPreset) => {
    setRatioPreset(preset)
    if (preset === 'custom') return
    if (preset === '9:16') props.onChange({ ...v, aspectRatio: '9:16', width: 768, height: 1344 })
    if (preset === '16:9') props.onChange({ ...v, aspectRatio: '16:9', width: 1024, height: 576 })
    if (preset === '9:1') props.onChange({ ...v, aspectRatio: '9:1', width: 1152, height: 128 })
  }
  return (
    <div className="ai-modal" role="dialog" aria-modal="true">
      <div
        className="ai-modal-card ai-background-modal-card"
        style={{ width: 'min(980px, calc(100vw - 24px))', maxHeight: 'calc(100vh - 24px)' }}
      >
        <div className="ai-modal-head">
          <div className="ai-modal-title" style={{ marginBottom: 0 }}>AI 生成分镜图</div>
          <button
            type="button"
            className="icon-btn"
            onClick={props.onClose}
            disabled={props.busy}
            aria-label="关闭"
            title="关闭"
          >
            ✕
          </button>
        </div>

        <div className="ai-modal-row">
          <label>全局设定（世界观锚点）</label>
          <textarea
            rows={4}
            value={v.globalPrompt || ''}
            onChange={(e) => props.onChange({ ...v, globalPrompt: e.target.value })}
            placeholder="例如：时代/地域、建筑与道具、角色外观锁定、色彩与光照、镜头语言（全故事统一）"
          />
          <div className="hint" style={{ marginTop: 6 }}>当生图 Provider 为 `sdwebui/comfyui` 时，AI 解析会优先输出英文提示词，提升本地模型稳定性。</div>
        </div>

        <div className="ai-modal-row">
          <label>全局负面（可选）</label>
          <input
            value={v.globalNegativePrompt || ''}
            onChange={(e) => props.onChange({ ...v, globalNegativePrompt: e.target.value })}
            placeholder="例如：现代城市, 汽车, 手机, 霓虹灯, 玻璃幕墙"
          />
        </div>

        <div className="ai-modal-row">
          <label>背景空镜</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, opacity: 0.95 }}>
              <input
                type="checkbox"
                checked={Boolean(v.backgroundOnly)}
                onChange={(e) => props.onChange({ ...v, backgroundOnly: e.target.checked })}
              />
              不画人物/动物（只生成环境背景）
            </label>
            <div style={{ fontSize: 12, opacity: 0.75 }}>推荐搭配「透明角色 PNG」工作流</div>
          </div>
        </div>

        <div className="ai-modal-row">
          <label>描述文本</label>
          <textarea
            rows={6}
            value={v.userInput || ''}
            onChange={(e) => props.onChange({ ...v, userInput: e.target.value })}
            placeholder="例如：绘本风格，狼来了故事，放羊小孩向村民喊话，乡村草地，柔和光线，9:16，无文字"
          />
        </div>

        <div className="ai-modal-row">
          <label>场景提示词（增量）</label>
          <textarea
            rows={6}
            value={v.prompt || ''}
            onChange={(e) => props.onChange({ ...v, prompt: e.target.value })}
            placeholder="例如：山坡上放羊的男孩，童话插画风，柔和光线..."
          />
        </div>

        <div className="ai-modal-row">
          <label>场景负面（可选）</label>
          <input
            value={v.negativePrompt || ''}
            onChange={(e) => props.onChange({ ...v, negativePrompt: e.target.value })}
            placeholder="lowres, blurry, watermark..."
          />
        </div>

        <div className="ai-modal-grid">
          <div className="ai-modal-row">
            <label>比例</label>
            <select className="sel" value={ratioPreset} onChange={(e) => applyPreset(e.target.value as any)}>
              <option value="custom">自定义</option>
              <option value="9:16">9:16</option>
              <option value="16:9">16:9</option>
              <option value="9:1">9:1</option>
            </select>
          </div>
          <div className="ai-modal-row">
            <label>风格</label>
            <select
              className="sel"
              value={v.style || 'picture_book'}
              onChange={(e) => props.onChange({ ...v, style: e.target.value as any })}
            >
              <option value="picture_book">绘本（picture_book）</option>
              <option value="cartoon">卡通（cartoon）</option>
              <option value="national_style">国风（national_style）</option>
              <option value="watercolor">水彩（watercolor）</option>
            </select>
          </div>
          <div className="ai-modal-row">
            <label>宽</label>
            <input
              type="number"
              value={v.width ?? 768}
              onChange={(e) => {
                if (ratioPreset !== 'custom') setRatioPreset('custom')
                props.onChange({ ...v, width: Number(e.target.value) })
              }}
            />
          </div>
          <div className="ai-modal-row">
            <label>高</label>
            <input
              type="number"
              value={v.height ?? 1024}
              onChange={(e) => {
                if (ratioPreset !== 'custom') setRatioPreset('custom')
                props.onChange({ ...v, height: Number(e.target.value) })
              }}
            />
          </div>
          <div className="ai-modal-row">
            <label>步数</label>
            <input type="number" value={v.steps ?? 20} onChange={(e) => props.onChange({ ...v, steps: Number(e.target.value) })} />
          </div>
          <div className="ai-modal-row">
            <label>CFG</label>
            <input type="number" value={v.cfgScale ?? 7} onChange={(e) => props.onChange({ ...v, cfgScale: Number(e.target.value) })} />
          </div>
        </div>

        {(() => {
          const gp = String(v.globalPrompt || '').replace(/\s+/g, ' ').trim()
          const sp = String(v.prompt || '').replace(/\s+/g, ' ').trim()
          const gneg = String(v.globalNegativePrompt || '').replace(/\s+/g, ' ').trim()
          const sneg = String(v.negativePrompt || '').replace(/\s+/g, ' ').trim()
          const effPrompt = [gp, sp].filter(Boolean).join('，')
          const effNeg = [gneg, sneg].filter(Boolean).join(', ')
          if (!effPrompt && !effNeg) return null
          return (
            <div className="ai-modal-ok" style={{ marginTop: 10, opacity: 0.95 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>最终提交预览</div>
              {effPrompt ? <div style={{ fontSize: 12 }}>Prompt：{effPrompt}</div> : null}
              {effNeg ? <div style={{ fontSize: 12, marginTop: 4 }}>Negative：{effNeg}</div> : null}
            </div>
          )
        })()}

        {r && (String(r.url || '').trim() || String(r.assetPath || '').trim()) ? (
          <div className="ai-modal-ok" style={{ marginTop: 10 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>生成成功</div>
            {String(r.assetPath || '').trim() ? (
              <div style={{ opacity: 0.9, fontSize: 12, overflowWrap: 'anywhere' }}>保存到：{String(r.assetPath || '').trim()}</div>
            ) : null}
            {String(r.url || '').trim() ? (
              <div style={{ opacity: 0.9, fontSize: 12, marginTop: 4, overflowWrap: 'anywhere' }}>项目预览地址（本地）：{String(r.url || '').trim()}</div>
            ) : null}
            {String(r.remoteUrl || '').trim() ? (
              <div style={{ opacity: 0.9, fontSize: 12, marginTop: 4, overflowWrap: 'anywhere' }}>源 URL（远程，可能限时）：{String(r.remoteUrl || '').trim()}</div>
            ) : null}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <button className="secondary" onClick={props.onOpenDir} disabled={!props.onOpenDir}>
                打开目录
              </button>
              <button className="secondary" onClick={props.onOpenImage} disabled={!props.onOpenImage || !String(r.url || '').trim()}>
                打开图片
              </button>
              <button
                className="secondary"
                onClick={props.onOpenRemote}
                disabled={!props.onOpenRemote || !String(r.remoteUrl || '').trim()}
                title="打开服务商返回的源链接（可能只有短期有效）"
              >
                打开源链接
              </button>
              <button className="secondary" onClick={props.onDownload} disabled={!props.onDownload || !String(r.url || '').trim()}>
                下载图片
              </button>
            </div>
          </div>
        ) : null}

        {props.error ? <div className="ai-modal-err">{props.error}</div> : null}

        {props.busy ? (
          <div className="hint" style={{ marginTop: 6, marginBottom: 2 }}>
            生成计时：{(elapsedMs / 1000).toFixed(1)}s（等待服务端返回）
          </div>
        ) : null}

        <div className="ai-modal-actions">
          {props.onAutoRecognize ? (
            <button onClick={props.onAutoRecognize} disabled={props.busy || props.analyzing} title="从当前选中场景节点提取文本，并自动解析生成提示词">
              自动识别当前场景
            </button>
          ) : null}
          <button onClick={props.onAnalyze} disabled={props.busy || props.analyzing || !String(v.userInput || '').trim()}>
            {props.analyzing ? '解析中…' : 'AI 解析提示词'}
          </button>
          <button onClick={props.onSubmit} disabled={props.busy || props.analyzing || !String(v.prompt || '').trim()}>
            {props.busy ? '生成中…' : '生成并应用分镜图'}
          </button>
        </div>
      </div>
    </div>
  )
}
