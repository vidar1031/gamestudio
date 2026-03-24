import React from 'react'
import type { AiBackgroundRequest } from './api'

export default function AiBackgroundModal(props: {
  open: boolean
  value: AiBackgroundRequest
  imageProvider?: string
  imageModel?: string
  continuityInfo?: {
    bibleReady?: boolean
    bibleSummary?: string
    inheritFromBatch?: boolean
    sceneRoleLocked?: boolean
  }
  referenceScenes?: Array<{
    nodeId: string
    nodeName: string
    summary: string
    selected: boolean
    hasImage: boolean
    sharedCharacterNames: string[]
    previewUrl?: string
    usableUrl?: string
  }>
  continuityCharacters: Array<{
    characterId: string
    characterName: string
    fingerprintPrompt?: string
    assetId?: string
    assetUri?: string
    available: boolean
    selected: boolean
    weight?: number
  }>
  busy: boolean
  analyzing: boolean
  error: string
  result?: null | { url?: string; assetPath?: string; provider?: string; remoteUrl?: string; seed?: number; continuityUsed?: boolean }
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
  const [ratioPreset, setRatioPreset] = React.useState<'custom' | '9:16' | '16:9' | '1:1' | '9:1'>('custom')
  const [elapsedMs, setElapsedMs] = React.useState(0)
  const v = props.value
  const r = props.result || null
  const continuity = v.continuity || { ipadapterEnabled: true, requireCharacterRefs: false, controlnetEnabled: false, seedMode: 'random' }
  const imageProvider = String(props.imageProvider || '').trim().toLowerCase()
  const imageModel = String(props.imageModel || '').trim()
  const isDoubaoImage = imageProvider === 'doubao'
  const continuityInfo = props.continuityInfo || {}
  const referenceScenes = Array.isArray(props.referenceScenes) ? props.referenceScenes : []

  const getDoubaoDefaultSize = (aspectRatio: string) => {
    const ar = String(aspectRatio || '').trim()
    if (ar === '16:9') return '2560x1440'
    if (ar === '1:1') return '1920x1920'
    if (ar === '9:1') return '6480x720'
    return '1440x2560'
  }

  const getDoubaoOrientationLabel = (aspectRatio: string) => {
    const ar = String(aspectRatio || '').trim()
    if (ar === '16:9') return '横图'
    if (ar === '1:1') return '方图'
    if (ar === '9:1') return '超宽横图'
    return '竖图'
  }

  const doubaoAspectRatio = String(v.aspectRatio || '9:16')
  const doubaoDefaultSize = getDoubaoDefaultSize(doubaoAspectRatio)
  const doubaoOrientation = getDoubaoOrientationLabel(doubaoAspectRatio)

  React.useEffect(() => {
    if (!props.open) return
    const ar = String(v.aspectRatio || '').trim()
    if (ar === '9:16' || ar === '16:9' || ar === '1:1' || ar === '9:1') setRatioPreset(ar as any)
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
    if (isDoubaoImage) {
      const nextAspectRatio = preset as '9:16' | '16:9' | '1:1' | '9:1'
      props.onChange({
        ...v,
        aspectRatio: nextAspectRatio,
        size: getDoubaoDefaultSize(nextAspectRatio),
        sequentialImageGeneration: (v.sequentialImageGeneration || 'auto') === 'auto' ? 'auto' : 'disabled'
      })
      return
    }
    if (preset === '9:16') props.onChange({ ...v, aspectRatio: '9:16', width: 768, height: 1344 })
    if (preset === '16:9') props.onChange({ ...v, aspectRatio: '16:9', width: 1024, height: 576 })
    if (preset === '1:1') props.onChange({ ...v, aspectRatio: '1:1', width: 1024, height: 1024 })
    if (preset === '9:1') props.onChange({ ...v, aspectRatio: '9:1', width: 1152, height: 128 })
  }

  const updateContinuity = (patch: Partial<NonNullable<AiBackgroundRequest['continuity']>>) => {
    props.onChange({
      ...v,
      continuity: {
        ipadapterEnabled: Boolean(continuity.ipadapterEnabled),
        requireCharacterRefs: Boolean(continuity.requireCharacterRefs),
        controlnetEnabled: Boolean(continuity.controlnetEnabled),
        seedMode: continuity.seedMode === 'fixed' ? 'fixed' : 'random',
        ...(patch || {})
      }
    })
  }

  const syncCharacterRef = (
    characterId: string,
    patch: {
      selected?: boolean
      weight?: number
    }
  ) => {
    const choices = Array.isArray(props.continuityCharacters) ? props.continuityCharacters : []
    const current = choices.find((x) => x.characterId === characterId)
    if (!current) return
    const nextSelected = patch.selected != null ? patch.selected : current.selected
    const nextWeight = Number.isFinite(Number(patch.weight)) ? Number(patch.weight) : (Number.isFinite(Number(current.weight)) ? Number(current.weight) : 0.85)
    const prev = Array.isArray(v.characterRefs) ? v.characterRefs.filter((x) => String(x.characterId || '').trim() !== characterId) : []
    const nextRefs = nextSelected && current.available && current.assetUri
      ? [
          ...prev,
          {
            characterId,
            characterName: current.characterName,
            assetId: current.assetId,
            assetUri: current.assetUri,
            fingerprintPrompt: current.fingerprintPrompt || undefined,
            weight: nextWeight
          }
        ]
      : prev
    props.onChange({ ...v, characterRefs: nextRefs })
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

        <div className="ai-modal-layout">
          <div className="ai-modal-main">
            <section className="ai-panel">
              <div className="ai-panel-head">
                <div className="ai-panel-title">场景输入</div>
                <div className="hint">{isDoubaoImage ? '先确认当前场景描述，再基于已有连续基线重生成这一张图。' : '先描述场景，再决定是否启用连续锁定'}</div>
              </div>
              <div className="ai-panel-body">
                <div className="ai-modal-row">
                  <label>全局设定</label>
                  <div>
                    <textarea
                      rows={4}
                      value={v.globalPrompt || ''}
                      onChange={(e) => props.onChange({ ...v, globalPrompt: e.target.value })}
                      placeholder="例如：时代/地域、建筑与道具、角色外观锁定、色彩与光照、镜头语言（全故事统一）"
                    />
                    <div className="hint" style={{ marginTop: 6 }}>
                      {isDoubaoImage
                        ? '提交时会自动合并世界观锚点、角色外观约束、关键道具约束和当前场景角色定义。'
                        : '当生图 Provider 为 sdwebui/comfyui 时，AI 解析会优先输出英文提示词，提升本地模型稳定性。'}
                    </div>
                  </div>
                </div>

                <div className="ai-modal-row">
                  <label>全局负面</label>
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
                    <div style={{ fontSize: 12, opacity: 0.75 }}>推荐搭配“透明角色 PNG”工作流</div>
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
                  <label>场景提示词</label>
                  <textarea
                    rows={6}
                    value={v.prompt || ''}
                    onChange={(e) => props.onChange({ ...v, prompt: e.target.value })}
                    placeholder="例如：山坡上放羊的男孩，童话插画风，柔和光线..."
                  />
                </div>

                <div className="ai-modal-row">
                  <label>场景负面</label>
                  <input
                    value={v.negativePrompt || ''}
                    onChange={(e) => props.onChange({ ...v, negativePrompt: e.target.value })}
                    placeholder="lowres, blurry, watermark..."
                  />
                </div>
              </div>
            </section>

            <section className="ai-panel">
              <div className="ai-panel-head">
                <div className="ai-panel-title">{isDoubaoImage ? '连续基线' : '连续锁定'}</div>
                <div className="hint">{isDoubaoImage ? '这一张图会继承当前项目的连续生成基线。' : 'ComfyUI 下可带角色参考图与固定 seed 做连续测试'}</div>
              </div>
              <div className="ai-panel-body">
                {isDoubaoImage ? (
                  <>
                    <div className="ai-summary-row">连续性 Bible：{continuityInfo.bibleReady ? '已建立' : '未建立'}</div>
                    <div className="ai-summary-row">当前生图模型：{imageProvider || 'none'}{imageModel ? ` / ${imageModel}` : ''}</div>
                    <div className="ai-summary-row">继承来源：{continuityInfo.inheritFromBatch ? '批量分镜参数模板' : '当前弹窗参数'}</div>
                    <div className="ai-summary-row">场景角色锁定：{continuityInfo.sceneRoleLocked ? '已注入当前场景角色定义' : '当前场景未检测到角色定义'}</div>
                    {continuityInfo.bibleSummary ? (
                      <div className="ai-summary-block" style={{ marginTop: 10 }}>
                        <strong>连续基线摘要</strong>
                        <div>{continuityInfo.bibleSummary}</div>
                      </div>
                    ) : null}
                    <div className="hint" style={{ marginTop: 8 }}>
                      如果连续性 Bible 未建立，这里仍然可以出图，但角色、道具和画风在多场景之间的稳定性会明显下降。
                    </div>
                    <div className="hint" style={{ marginTop: 8 }}>
                      为了保证与你前一轮批量结果一致，建议保持比例、风格、输出尺寸和组图模式与批量分镜一致。
                    </div>
                    <div style={{ marginTop: 14 }}>
                      <div className="ai-panel-title" style={{ fontSize: 13, marginBottom: 8 }}>参考场景</div>
                      <div className="hint" style={{ marginBottom: 8 }}>
                        可把其它已生成场景作为参考图送入当前生成。优先选择包含花花、猫奶奶且画风稳定的场景。
                      </div>
                      {referenceScenes.length ? (
                        <div style={{ display: 'grid', gap: 10 }}>
                          {referenceScenes.map((scene) => {
                            const checked = Array.isArray(v.referenceSceneIds) && v.referenceSceneIds.includes(scene.nodeId)
                            const usable = Boolean(scene.usableUrl)
                            const nextIds = checked
                              ? (Array.isArray(v.referenceSceneIds) ? v.referenceSceneIds.filter((id) => id !== scene.nodeId) : [])
                              : [...(Array.isArray(v.referenceSceneIds) ? v.referenceSceneIds : []), scene.nodeId]
                            return (
                              <label
                                key={scene.nodeId}
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: scene.previewUrl ? '84px 1fr auto' : '1fr auto',
                                  gap: 10,
                                  alignItems: 'center',
                                  padding: 10,
                                  border: checked ? '1px solid rgba(245, 158, 11, 0.55)' : '1px solid rgba(148,163,184,0.18)',
                                  borderRadius: 12,
                                  background: checked ? 'rgba(245, 158, 11, 0.08)' : 'rgba(15, 23, 42, 0.22)',
                                  opacity: usable ? 1 : 0.72
                                }}
                              >
                                {scene.previewUrl ? (
                                  <img
                                    src={scene.previewUrl}
                                    alt={scene.nodeName}
                                    style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 10, border: '1px solid rgba(148,163,184,0.18)' }}
                                  />
                                ) : null}
                                <div style={{ minWidth: 0 }}>
                                  <div style={{ fontSize: 13, fontWeight: 600 }}>{scene.nodeName}</div>
                                  <div className="hint" style={{ marginTop: 4 }}>
                                    {scene.sharedCharacterNames.length ? `共享角色：${scene.sharedCharacterNames.join('、')}` : '共享角色：无'}
                                  </div>
                                  {scene.summary ? <div className="hint" style={{ marginTop: 4 }}>{scene.summary}</div> : null}
                                  {!usable ? <div className="hint" style={{ marginTop: 4 }}>当前这张图还没有可用的参考源链接；重新生成一次该场景后即可作为参考图使用。</div> : null}
                                </div>
                                <div>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={!usable}
                                    onChange={() => props.onChange({ ...v, referenceSceneIds: nextIds })}
                                  />
                                </div>
                              </label>
                            )
                          })}
                        </div>
                      ) : (
                        <div className="hint">当前没有可作为参考的其它场景图。</div>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="ai-continuity-grid">
                      <label className="ai-check">
                        <input
                          type="checkbox"
                          checked={Boolean(continuity.ipadapterEnabled)}
                          onChange={(e) => updateContinuity({ ipadapterEnabled: e.target.checked })}
                        />
                        <span>启用角色参考锁定（IP-Adapter）</span>
                      </label>
                      <label className="ai-check">
                        <input
                          type="checkbox"
                          checked={Boolean(continuity.requireCharacterRefs)}
                          onChange={(e) => updateContinuity({ requireCharacterRefs: e.target.checked })}
                        />
                        <span>没有参考图时视为未准备好</span>
                      </label>
                      <label className="ai-check">
                        <input
                          type="checkbox"
                          checked={Boolean(continuity.controlnetEnabled)}
                          onChange={(e) => updateContinuity({ controlnetEnabled: e.target.checked })}
                          disabled
                        />
                        <span>ControlNet（开发中，当前禁用）</span>
                      </label>
                      <div className="ai-seed-row">
                        <label>Seed 模式</label>
                        <select
                          className="sel"
                          value={continuity.seedMode === 'fixed' ? 'fixed' : 'random'}
                          onChange={(e) => updateContinuity({ seedMode: e.target.value === 'fixed' ? 'fixed' : 'random' })}
                        >
                          <option value="random">每次随机</option>
                          <option value="fixed">固定 seed</option>
                        </select>
                        <input
                          type="number"
                          value={v.seed ?? ''}
                          disabled={continuity.seedMode !== 'fixed'}
                          placeholder="例如 424242"
                          onChange={(e) => props.onChange({ ...v, seed: e.target.value === '' ? undefined : Number(e.target.value) })}
                        />
                      </div>
                    </div>

                    <div className="ai-ref-list">
                      {(props.continuityCharacters || []).length ? (
                        props.continuityCharacters.map((ch) => {
                          const selected = Array.isArray(v.characterRefs) && v.characterRefs.some((x) => String(x.characterId || '').trim() === ch.characterId)
                          const currentRef = Array.isArray(v.characterRefs)
                            ? v.characterRefs.find((x) => String(x.characterId || '').trim() === ch.characterId)
                            : null
                          return (
                            <div key={ch.characterId} className="ai-ref-item">
                              <label className="ai-check">
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  disabled={!ch.available || !continuity.ipadapterEnabled}
                                  onChange={(e) => syncCharacterRef(ch.characterId, { selected: e.target.checked })}
                                />
                                <span>{ch.characterName}</span>
                              </label>
                              <div className="hint">
                                {ch.available ? 'reference=ok' : 'reference=missing'}
                                {ch.fingerprintPrompt ? ' / fingerprint=ok' : ' / fingerprint=missing'}
                              </div>
                              <div className="ai-ref-controls">
                                <label>权重</label>
                                <input
                                  type="number"
                                  step="0.05"
                                  min="0.1"
                                  max="1.5"
                                  value={Number.isFinite(Number(currentRef?.weight)) ? Number(currentRef?.weight) : (Number.isFinite(Number(ch.weight)) ? Number(ch.weight) : 0.85)}
                                  disabled={!selected || !ch.available || !continuity.ipadapterEnabled}
                                  onChange={(e) => syncCharacterRef(ch.characterId, { weight: Number(e.target.value) })}
                                />
                              </div>
                            </div>
                          )
                        })
                      ) : (
                        <div className="hint">当前场景没有角色 placement，可直接测试纯提示词出图。</div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </section>

            <section className="ai-panel">
              <div className="ai-panel-head">
                <div className="ai-panel-title">生成参数</div>
              </div>
              <div className="ai-panel-body">
                <div className="ai-modal-grid">
                  <div className="ai-modal-row">
                    <label>比例</label>
                    <select className="sel" value={ratioPreset} onChange={(e) => applyPreset(e.target.value as any)}>
                      <option value="custom">自定义</option>
                      <option value="9:16">9:16</option>
                      <option value="16:9">16:9</option>
                      <option value="1:1">1:1</option>
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
                  {isDoubaoImage ? (
                    <>
                      <div className="ai-modal-row">
                        <label>输出尺寸</label>
                        <input
                          value={String(v.size || doubaoDefaultSize)}
                          onChange={(e) => props.onChange({ ...v, size: e.target.value })}
                          placeholder={`默认最小尺寸：${doubaoDefaultSize}`}
                        />
                      </div>
                      <div className="ai-modal-row">
                        <label>返回格式</label>
                        <select
                          className="sel"
                          value={String(v.responseFormat || 'url')}
                          onChange={(e) => props.onChange({ ...v, responseFormat: e.target.value === 'b64_json' ? 'b64_json' : 'url' })}
                        >
                          <option value="url">url</option>
                          <option value="b64_json">b64_json</option>
                        </select>
                      </div>
                      <div className="ai-modal-row">
                        <label>水印</label>
                        <select
                          className="sel"
                          value={typeof v.watermark === 'boolean' ? (v.watermark ? 'on' : 'off') : 'off'}
                          onChange={(e) => props.onChange({ ...v, watermark: e.target.value === 'on' })}
                        >
                          <option value="off">关闭</option>
                          <option value="on">开启</option>
                        </select>
                      </div>
                      <div className="ai-modal-row">
                        <label>组图模式</label>
                        <select
                          className="sel"
                          value={String(v.sequentialImageGeneration || 'auto')}
                          onChange={(e) => props.onChange({ ...v, sequentialImageGeneration: e.target.value === 'disabled' ? 'disabled' : 'auto' })}
                        >
                          <option value="auto">auto</option>
                          <option value="disabled">disabled</option>
                        </select>
                      </div>
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
                </div>
                {isDoubaoImage ? (
                  <div className="hint" style={{ marginTop: 8 }}>
                    当前比例 {doubaoAspectRatio} 会输出 {doubaoOrientation}；默认最小安全尺寸为 {doubaoDefaultSize}。连续场景建议保持“组图模式=auto”，这样单张重生成也会沿用 Doubao 连续模式。
                  </div>
                ) : null}
              </div>
            </section>
          </div>
          <aside className="ai-modal-side">
            {(() => {
              const gp = String(v.globalPrompt || '').replace(/\s+/g, ' ').trim()
              const sp = String(v.prompt || '').replace(/\s+/g, ' ').trim()
              const gneg = String(v.globalNegativePrompt || '').replace(/\s+/g, ' ').trim()
              const sneg = String(v.negativePrompt || '').replace(/\s+/g, ' ').trim()
              const effPrompt = [gp, sp].filter(Boolean).join('，')
              const effNeg = [gneg, sneg].filter(Boolean).join(', ')
              const refCount = Array.isArray(v.characterRefs) ? v.characterRefs.length : 0
              return (
                <section className="ai-panel">
                  <div className="ai-panel-head">
                    <div className="ai-panel-title">提交预览</div>
                  </div>
                  <div className="ai-panel-body">
                    <div className="ai-summary-row">模型：{imageProvider || 'unknown'}{imageModel ? ` / ${imageModel}` : ''}</div>
                    <div className="ai-summary-row">参考图：{refCount} 个</div>
                    <div className="ai-summary-row">连续模式：{isDoubaoImage ? `Doubao / ${String(v.sequentialImageGeneration || 'auto')}` : (continuity.ipadapterEnabled ? 'ComfyUI 锁定已开启' : '关闭')}</div>
                    <div className="ai-summary-row">连续性 Bible：{isDoubaoImage ? (continuityInfo.bibleReady ? '已建立' : '未建立') : '不适用'}</div>
                    <div className="ai-summary-row">Seed：{isDoubaoImage ? '自动管理' : (continuity.seedMode === 'fixed' && v.seed != null ? String(v.seed) : '随机')}</div>
                    {isDoubaoImage ? <div className="ai-summary-row">输出尺寸：{String(v.size || doubaoDefaultSize)}</div> : null}
                    {effPrompt ? <div className="ai-summary-block"><strong>Prompt</strong><div>{effPrompt}</div></div> : null}
                    {effNeg ? <div className="ai-summary-block"><strong>Negative</strong><div>{effNeg}</div></div> : null}
                  </div>
                </section>
              )
            })()}

            {r && (String(r.url || '').trim() || String(r.assetPath || '').trim()) ? (
              <section className="ai-panel">
                <div className="ai-panel-head">
                  <div className="ai-panel-title">最近结果</div>
                </div>
                <div className="ai-panel-body">
                  {String(r.assetPath || '').trim() ? (
                    <div className="ai-summary-row">保存到：{String(r.assetPath || '').trim()}</div>
                  ) : null}
                  {String(r.url || '').trim() ? (
                    <div className="ai-summary-row">项目预览：{String(r.url || '').trim()}</div>
                  ) : null}
                  {String(r.remoteUrl || '').trim() ? (
                    <div className="ai-summary-row">源链接：{String(r.remoteUrl || '').trim()}</div>
                  ) : null}
                  {Number.isFinite(Number(r.seed)) ? <div className="ai-summary-row">返回 seed：{Number(r.seed)}</div> : null}
                  <div className="ai-summary-row">连续引用已使用：{r.continuityUsed ? '是' : '否'}</div>
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
              </section>
            ) : null}
          </aside>
        </div>

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
