import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import {
  resolveUrl,
  type AssetV1,
  type ChoiceV1,
  type ChoicesLayoutV1,
  type DialogLayoutV1,
  type NodeUiV1,
  type NodeV1,
  type ProjectV1,
  type StageConfigV1,
  type StoryAssetPlan
} from '../../../api'
import type { EditorDoc } from '../types'
import { ensureNode, normalizeChoicesAlign, normalizeChoicesDirection, normalizeDialogPreset, normalizeStageV1 } from '../orchestration/normalize'
import type { RuntimeState } from '../orchestration/runtime'
import { clamp01, numberOr, uid } from '../orchestration/utils'
import type { ComposeRightFoldState } from './RightPanel'

export type NodePropsFoldProps = {
  n: NodeV1
  allNodes: NodeV1[]
  nodes: NodeV1[]
  doc: EditorDoc
  rightFold: ComposeRightFoldState
  toggleRightFold: (key: keyof ComposeRightFoldState) => void
  setNode: (updater: (node: NodeV1) => NodeV1) => void
  fromBlueprint: boolean
  structureBound: boolean
  choicesLocked: boolean
  busy: boolean
  effectivePreviewNode: NodeV1 | null
  handleUploadBackground: (file: File, targetAssetId?: string) => Promise<void>
  bgFileRef: MutableRefObject<HTMLInputElement | null>
  pendingBgAssetIdRef: MutableRefObject<string>
  openAiStoryboardForCurrentNode: () => Promise<void>
  sbAssetPlan: StoryAssetPlan | null
  setDocProject: (updater: (p: ProjectV1) => ProjectV1) => void
  rt: RuntimeState
  setRt: Dispatch<SetStateAction<RuntimeState>>
  setToast: Dispatch<SetStateAction<string>>
}

export function NodePropsFold(props: NodePropsFoldProps) {
  const {
    n,
    allNodes,
    nodes,
    doc,
    rightFold,
    toggleRightFold,
    setNode,
    fromBlueprint,
    structureBound,
    choicesLocked,
    busy,
    effectivePreviewNode,
    handleUploadBackground,
    bgFileRef,
    pendingBgAssetIdRef,
    openAiStoryboardForCurrentNode,
    sbAssetPlan,
    setDocProject,
    rt,
    setRt,
    setToast
  } = props

  // 收窄护栏：本面板仅在主组件 doc.project/doc.story 非空分支内渲染（与原 IIFE 分支前置守卫等价）
  if (!doc.project || !doc.story) return null

  return (
            <div className="fold">
            <div className="fold-head" onClick={() => toggleRightFold('nodeProps')}>
                <div className="fold-title">{n.kind === 'scene' ? '场景节点属性' : '结局节点属性'}</div>
                <div className="fold-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="icon-btn"
                    title={rightFold.nodeProps ? '折叠' : '展开'}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleRightFold('nodeProps')
                    }}
                  >
                    {rightFold.nodeProps ? '－' : '＋'}
                  </button>
                </div>
              </div>

	              {rightFold.nodeProps ? (
	                <div className="fold-body">
	                  <div className="form" style={{ marginTop: 8 }}>
	                    <div className="form-row">
	                      <label>{n.kind === 'scene' ? '场景名称（必填）' : '结局名称（必填）'}</label>
	                      <input
	                        className="input"
	                        value={n.name}
	                        onChange={(e) => {
	                          const name = e.target.value
	                          if (!String(name).trim()) return
	                          setNode((x) => {
	                            const nn = ensureNode(x)
	                            const steps = Array.isArray(nn.timeline?.steps) ? nn.timeline.steps : []
	                            if (nn.kind === 'ending' && steps.length === 1) {
	                              const s0 = steps[0]
	                              const acts = Array.isArray(s0.actions) ? s0.actions : []
	                              const idx = acts.findIndex((a: any) => String(a && a.type) === 'ui.showEndingCard')
	                              if (idx >= 0) {
	                                const card = (acts[idx] as any).card || {}
	                                const nextActs = acts.slice()
	                                nextActs[idx] = { ...(acts[idx] as any), card: { ...card, title: name || card.title } }
	                                return { ...nn, name, timeline: { steps: [{ ...s0, actions: nextActs }] } }
	                              }
	                            }
	                            return { ...nn, name }
	                          })
	                        }}
	                      />
	                    </div>
	                    <div className="hint" style={{ marginTop: 6 }}>
	                      来源：{fromBlueprint ? '蓝图结构' : '合成层临时节点'}。{fromBlueprint ? '结构调整请返回蓝图层。' : '可在合成层直接删除。'}
	                    </div>
	                    {/* 2026-10-20 外壳升级：说教黄条降级为 dim 弱提示（语义不变） */}
                    {structureBound ? <div className="hint compose-rail-note">合成层用于文案与演出排练；结构（节点/跳转）请回到蓝图层调整。</div> : null}
	                  </div>

	                  <div className="hr" />

	                  <div className="sub-acc">
	                    {(() => {
	                      // 2026-10-05 构图需求单（导演层）UI 呈现：读 plan.scenes[].composition，展示每个元素的
	                      // 状态/位置/大小/层级/关系/原文依据——导演的摆放意图在编辑器里可见可查，不再是黑盒。
	                      const planAny = sbAssetPlan as any
	                      const comp = (Array.isArray(planAny?.scenes) ? planAny.scenes : []).find((s: any) => String(s?.sceneId || '') === String(n.id))?.composition
	                      if (!comp || !Array.isArray(comp.items) || !comp.items.length) return null
	                      const assetNameById = new Map<string, string>((Array.isArray(planAny?.assets) ? planAny.assets : []).map((a: any) => [String(a?.id || ''), String(a?.name || a?.id || '')]))
	                      return (
	                        <div className="subfold">
	                          <div className="subfold-head" onClick={() => toggleRightFold('composition')}>
	                            <div className="subfold-title">构图需求单（导演）</div>
	                            <div className="fold-actions" onClick={(e) => e.stopPropagation()}>
	                              <button type="button" className="icon-btn" title={rightFold.composition ? '折叠' : '展开'} onClick={(e) => { e.stopPropagation(); toggleRightFold('composition') }}>
	                                {rightFold.composition ? '－' : '＋'}
	                              </button>
	                            </div>
	                          </div>
	                          {rightFold.composition ? (
	                            <div className="subfold-body">
	                              {comp.cameraNote ? <div className="hint" style={{ marginBottom: 6 }}>镜头：{comp.cameraNote}</div> : null}
	                              {comp.items.map((it: any, idx: number) => (
	                                <div key={idx} style={{ fontSize: 12, lineHeight: 1.7, marginTop: 4, paddingBottom: 6, borderBottom: idx < comp.items.length - 1 ? '1px solid rgba(148,163,184,0.15)' : 'none' }}>
	                                  <div style={{ color: '#e5e7eb', fontWeight: 600 }}>
	                                    {assetNameById.get(String(it.subjectId || '')) || it.subjectId}
	                                    {it.stateKey ? <span style={{ color: '#7dd3fc' }}>（状态 {it.stateKey}）</span> : null}
	                                  </div>
	                                  <div className="hint">位置 ({it.x}, {it.y}) · 大小 {it.scale} · 层级 {it.zIndex}{it.flipH ? ' · 朝左' : ''}</div>
	                                  {it.blocking ? <div className="hint">关系：{it.blocking}</div> : null}
	                                  {it.evidence ? <div className="hint" style={{ color: '#94a3b8' }}>依据：{it.evidence}</div> : null}
	                                </div>
	                              ))}
	                            </div>
	                          ) : null}
	                        </div>
	                      )
	                    })()}
	                    <div className="subfold subfold-content">
	                      <div className="subfold-head" onClick={() => toggleRightFold('nodeContent')}>
	                        <div className="subfold-title">对话内容</div>
	                        <div className="fold-actions" onClick={(e) => e.stopPropagation()}>
	                          <button
	                            type="button"
	                            className="icon-btn"
	                            title={rightFold.nodeContent ? '折叠' : '展开'}
	                            onClick={(e) => {
	                              e.stopPropagation()
	                              toggleRightFold('nodeContent')
	                            }}
	                          >
	                            {rightFold.nodeContent ? '－' : '＋'}
	                          </button>
	                        </div>
	                      </div>

	                      {rightFold.nodeContent ? (
	                        <div className="subfold-body">
	                          <div className="form">
	                            <div className="form-row">
	                              <label>对话标题（可空）</label>
	                              <input
	                                className="input"
	                                value={String((n as any).body?.title || '')}
	                                onChange={(e) => {
	                                  const title = e.target.value
	                                  setNode((x) => {
	                                    const nn = ensureNode(x)
	                                    const bodyIn = (nn as any).body && typeof (nn as any).body === 'object' ? (nn as any).body : { text: '' }
	                                    const nextBody = { ...bodyIn, title }
	                                    if (!String(title || '').trim()) {
	                                      try {
	                                        delete (nextBody as any).title
	                                      } catch {}
	                                    }
	                                    return { ...nn, body: nextBody }
	                                  })
	                                }}
	                              />
	                            </div>

	                            <div className="form-row">
	                              <label>类型</label>
	                              <select
	                                className="sel"
	                                value={n.kind}
	                                disabled={structureBound}
	                                onChange={(e) => {
	                                  const kind = e.target.value === 'ending' ? 'ending' : 'scene'
                                  setNode((x) => ({
                                    ...x,
                                    kind,
                                    timeline: undefined,
                                    choices: Array.isArray(x.choices) ? x.choices : []
                                  }))
                                }}
                              >
	                                <option value="scene">场景</option>
	                                <option value="ending">结局</option>
	                              </select>
	                            </div>

	                            <div className="form-row">
	                              <label>文本</label>
	                              <textarea
	                                className="textarea"
	                                value={String(n.body?.text || '')}
	                                onChange={(e) => {
	                                  const text = e.target.value
	                                  setNode((x) => {
	                                    const nn = ensureNode(x)
	                                    const steps = Array.isArray(nn.timeline?.steps) ? nn.timeline.steps : []
	                                    if (steps.length === 1) {
	                                      const s0 = steps[0]
	                                      const acts = Array.isArray(s0.actions) ? s0.actions : []
	                                      if (nn.kind === 'scene') {
	                                        const idx = acts.findIndex((a: any) => String(a && a.type) === 'ui.setText')
	                                        if (idx >= 0 && acts.length === 1) {
	                                          const nextActs = acts.slice()
	                                          nextActs[idx] = { ...(acts[idx] as any), text }
	                                          return { ...nn, body: { text }, timeline: { steps: [{ ...s0, actions: nextActs }] } }
	                                        }
	                                      } else if (nn.kind === 'ending') {
	                                        const idx = acts.findIndex((a: any) => String(a && a.type) === 'ui.showEndingCard')
	                                        if (idx >= 0) {
	                                          const card = (acts[idx] as any).card || {}
	                                          const nextActs = acts.slice()
	                                          nextActs[idx] = { ...(acts[idx] as any), card: { ...card, moral: text || card.moral } }
	                                          return { ...nn, body: { text }, timeline: { steps: [{ ...s0, actions: nextActs }] } }
	                                        }
	                                      }
	                                    }
	                                    return { ...nn, body: { text } }
	                                  })
	                                  if (effectivePreviewNode?.id === n.id && rt.stepIndex === 0) {
	                                    setRt((prev) => ({ ...prev, text }))
	                                  }
	                                }}
	                              />
	                            </div>
	                          </div>
	                        </div>
	                      ) : null}
	                    </div>

	                    <div className="subfold subfold-stage">
	                      <div className="subfold-head" onClick={() => toggleRightFold('background')}>
	                        <div className="subfold-title">尺寸与背景</div>
	                        <div className="fold-actions" onClick={(e) => e.stopPropagation()}>
	                          <button
	                            type="button"
	                            className="icon-btn"
	                            title={rightFold.background ? '折叠' : '展开'}
	                            onClick={(e) => {
	                              e.stopPropagation()
	                              toggleRightFold('background')
	                            }}
	                          >
	                            {rightFold.background ? '－' : '＋'}
	                          </button>
	                        </div>
	                      </div>

	                      {rightFold.background ? (
	                        <div className="subfold-body">
	                          {(() => {
	                            const stage = normalizeStageV1((doc.project as any).stage)
	                            const presets = [
	                              { key: 'p720x1280', label: '竖屏 720×1280（9:16）', orientation: 'portrait' as const, w: 720, h: 1280 },
	                              { key: 'p1080x1920', label: '竖屏 1080×1920（9:16）', orientation: 'portrait' as const, w: 1080, h: 1920 },
	                              { key: 'p750x1334', label: '竖屏 750×1334（iPhone）', orientation: 'portrait' as const, w: 750, h: 1334 },
	                              { key: 'l1280x720', label: '横屏 1280×720（16:9）', orientation: 'landscape' as const, w: 1280, h: 720 },
	                              { key: 'l1920x1080', label: '横屏 1920×1080（16:9）', orientation: 'landscape' as const, w: 1920, h: 1080 },
	                              { key: 'l1024x768', label: '横屏 1024×768（4:3）', orientation: 'landscape' as const, w: 1024, h: 768 }
	                            ]
	                            const presetKey =
	                              presets.find((p) => p.w === stage.width && p.h === stage.height && p.orientation === stage.orientation)?.key || ''

	                            const setStage = (patch: Partial<StageConfigV1>) => {
	                              setDocProject((p) => ({ ...p, stage: normalizeStageV1({ ...(p as any).stage, ...patch }) }))
	                            }

	                            return (
	                              <div className="form" style={{ gap: 10 }}>
	                                <div>
	                                  <div style={{ fontWeight: 700, fontSize: 12, opacity: 0.9 }}>设计尺寸（全局）</div>
	                                  <div className="hint" style={{ marginTop: 6 }}>
	                                    影响编辑器预览与导出成品。推荐先选常用尺寸，再微调。
	                                  </div>
	                                </div>

	                                <div className="form-row">
	                                  <label>方向</label>
	                                  <select
	                                    className="sel"
	                                    value={stage.orientation || (stage.width >= stage.height ? 'landscape' : 'portrait')}
	                                    onChange={(e) =>
	                                      setStage({ orientation: e.target.value === 'landscape' ? 'landscape' : 'portrait' })
	                                    }
	                                    disabled={busy}
	                                  >
	                                    <option value="portrait">竖屏</option>
	                                    <option value="landscape">横屏</option>
	                                  </select>
	                                </div>

	                                <div className="form-row">
	                                  <label>常用尺寸</label>
	                                  <select
	                                    className="sel"
	                                    value={presetKey}
	                                    onChange={(e) => {
	                                      const p = presets.find((x) => x.key === e.target.value)
	                                      if (!p) return
	                                      setStage({ orientation: p.orientation, width: p.w, height: p.h })
	                                    }}
	                                    disabled={busy}
	                                  >
	                                    <option value="">自定义</option>
	                                    {presets.map((p) => (
	                                      <option key={p.key} value={p.key}>
	                                        {p.label}
	                                      </option>
	                                    ))}
	                                  </select>
	                                </div>

	                                <div className="form-row">
	                                  <label>宽 × 高</label>
	                                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
	                                    <input
	                                      className="input"
	                                      type="number"
	                                      min={320}
	                                      max={4096}
	                                      value={String(stage.width)}
	                                      onChange={(e) => setStage({ width: Number(e.target.value) })}
	                                      disabled={busy}
	                                      style={{ width: 110 }}
	                                    />
	                                    <span style={{ opacity: 0.7 }}>×</span>
	                                    <input
	                                      className="input"
	                                      type="number"
	                                      min={320}
	                                      max={4096}
	                                      value={String(stage.height)}
	                                      onChange={(e) => setStage({ height: Number(e.target.value) })}
	                                      disabled={busy}
	                                      style={{ width: 110 }}
	                                    />
	                                  </div>
	                                </div>

	                                <div className="form-row">
	                                  <label>适配</label>
	                                  <select
	                                    className="sel"
	                                    value={stage.scaleMode || 'contain'}
	                                    onChange={(e) => setStage({ scaleMode: e.target.value === 'cover' ? 'cover' : 'contain' })}
	                                    disabled={busy}
	                                  >
	                                    <option value="contain">完整显示（留黑边）</option>
	                                    <option value="cover">裁切填满（可能裁剪）</option>
	                                  </select>
	                                </div>
	                              </div>
	                            )
	                          })()}

	                          <div className="hr" />

	                          {(() => {
	                            const bgId = String(n.visuals?.backgroundAssetId || '')
	                            const bgAsset = bgId ? doc.project.assets.find((a) => a.id === bgId) || null : null
	                            const hasImage = !!(bgAsset && String(bgAsset.uri || '').trim())

		                            const createBackgroundAsset = () => {
		                              const id = uid('asset')
		                              const asset: AssetV1 = {
		                                id,
		                                kind: 'image',
		                                name: `背景图 ${new Date().toLocaleTimeString()}`,
		                                uri: '',
		                                source: { type: 'upload' as const }
		                              }
		                              setDocProject((p) => ({ ...p, assets: [...(p.assets || []), asset] }))
		                              setNode((x) => ({ ...x, visuals: { ...ensureNode(x).visuals, backgroundAssetId: id } }))
		                              return id
		                            }

	                            const bgUsed = new Set(
	                              (doc.story?.nodes || [])
	                                .map((x) => String(ensureNode(x).visuals?.backgroundAssetId || '').trim())
	                                .filter(Boolean)
	                            )
	                            const bgAssets = doc.project.assets.filter(
	                              (a) =>
	                                a.kind === 'image' && (bgUsed.has(a.id) || /^背景/.test(String(a.name || '')) || a.source?.type === 'ai')
	                            )
	                            const bgAssetsWithSelected = bgId && bgAsset && !bgAssets.some((a) => a.id === bgId) ? [...bgAssets, bgAsset] : bgAssets

	                            return (
	                              <>
	                                <div style={{ fontWeight: 700, fontSize: 12, opacity: 0.9 }}>背景</div>

	                                <div className="form-row" style={{ marginTop: 8 }}>
	                                  <label>背景资源</label>
	                                  <select
	                                    className="sel"
	                                    value={bgId}
	                                    onChange={(e) => {
	                                      const v = e.target.value || undefined
	                                      setNode((x) => ({ ...x, visuals: { ...ensureNode(x).visuals, backgroundAssetId: v } }))
	                                    }}
	                                  >
	                                    <option value="">（无）</option>
	                                    {doc.project.assets.map((a) => (
	                                      <option key={a.id} value={a.id}>
	                                        {a.name || a.id}
	                                      </option>
	                                    ))}
	                                  </select>
	                                </div>

		                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
			                                  <button
			                                    className="btn secondary"
				                                    onClick={() => openAiStoryboardForCurrentNode()}
			                                    disabled={busy}
			                                  >
		                                    AI 生成分镜图…
		                                  </button>

		                                  <button
		                                    className="btn secondary"
		                                    onClick={() => {
		                                      if (doc.mode !== 'project') return
		                                      const url = resolveUrl(`/api/projects/${encodeURIComponent(String(doc.id))}/assets/ai`)
		                                      window.open(url, '_blank', 'noopener,noreferrer')
		                                    }}
		                                    disabled={busy || doc.mode !== 'project'}
		                                    title="打开 AI 背景输出目录（便于确认生成位置）"
		                                  >
		                                    打开生成目录
		                                  </button>

		                                  <button
		                                    className="btn secondary"
		                                    onClick={() => {
		                                      const targetId = bgId || createBackgroundAsset()
		                                      pendingBgAssetIdRef.current = targetId
		                                      bgFileRef.current?.click()
		                                    }}
		                                    disabled={busy || doc.readonly}
		                                    title="从本地选择图片并上传到项目 assets"
		                                  >
		                                    {bgId ? (hasImage ? '替换本地图片…' : '添加本地图片…') : '添加背景图片…'}
		                                  </button>

		                                  {bgId ? (
		                                    <>
		                                      <button
		                                        className="btn secondary"
		                                        onClick={() => {
	                                          if (!bgId) return
	                                          setDocProject((p) => ({
	                                            ...p,
	                                            assets: (p.assets || []).map((a) =>
	                                              a.id === bgId ? { ...a, uri: '', source: a.source } : a
	                                            )
	                                          }))
	                                          setToast('已删除背景图片')
	                                        }}
	                                        disabled={busy || !hasImage}
	                                        title={hasImage ? '清空该背景资源的图片 URI（保留资源条目）' : '当前背景资源未绑定图片'}
		                                      >
		                                        删除图片
		                                      </button>
		                                    </>
		                                  ) : null}
		                                </div>

	                                {bgId ? (
	                                  <div className="hint" style={{ marginTop: 8 }}>
	                                    当前背景资源：{bgAsset?.name || bgId}
	                                    {hasImage ? '' : '（未绑定图片）'}
	                                  </div>
	                                ) : (
		                                  <div className="hint" style={{ marginTop: 8 }}>
		                                    未选择背景资源：可先从下拉选择已有资源，或点击“添加背景图片…”创建并绑定。
		                                  </div>
		                                )}
		                              </>
		                            )
		                          })()}
	                          <input
	                            ref={bgFileRef}
	                            type="file"
	                            accept="image/png,image/jpeg,image/webp,image/gif"
	                            style={{ display: 'none' }}
	                            onChange={(e) => {
	                              const f = e.target.files && e.target.files[0] ? e.target.files[0] : null
	                              if (!f) return
	                              const target = pendingBgAssetIdRef.current ? String(pendingBgAssetIdRef.current) : undefined
	                              pendingBgAssetIdRef.current = ''
	                              void handleUploadBackground(f, target)
	                              try {
	                                e.currentTarget.value = ''
	                              } catch {}
	                            }}
	                          />
	                        </div>
	                      ) : null}
	                    </div>

		                    <div className="subfold subfold-dialog">
	                      <div className="subfold-head" onClick={() => toggleRightFold('choices')}>
	                        <div className="subfold-title">对话与选项</div>
	                        <div className="fold-actions" onClick={(e) => e.stopPropagation()}>
	                          <button
	                            type="button"
	                            className="icon-btn"
	                            title={rightFold.choices ? '折叠' : '展开'}
	                            onClick={(e) => {
	                              e.stopPropagation()
	                              toggleRightFold('choices')
	                            }}
	                          >
	                            {rightFold.choices ? '－' : '＋'}
	                          </button>
	                        </div>
	                      </div>

                      {rightFold.choices ? (
                        <div className="subfold-body">
                          <div className="form" style={{ gap: 10 }}>
                              {(() => {
	                                const ui = ((n.visuals && (n.visuals as any).ui) || {}) as NodeUiV1
	                                const dialog = (ui.dialog || {}) as DialogLayoutV1
	                                const choicesUi = (ui.choices || {}) as ChoicesLayoutV1
	                                const preset = normalizeDialogPreset((dialog as any).preset)
	                                const x = clamp01(numberOr((dialog as any).x, 0.5))
	                                const y = clamp01(numberOr((dialog as any).y, 0.88))
	                                const opacity = clamp01(numberOr((dialog as any).opacity, 1))
	                                const dir = normalizeChoicesDirection((choicesUi as any).direction)
	                                const align = normalizeChoicesAlign((choicesUi as any).align)

	                                const setUi = (patch: Partial<NodeUiV1>) => {
	                                  setNode((node) => {
	                                    const nn = ensureNode(node)
	                                    const visuals = nn.visuals || {}
	                                    const currUi = (visuals.ui || {}) as NodeUiV1
	                                    return { ...nn, visuals: { ...visuals, ui: { ...currUi, ...patch } } }
	                                  })
	                                }

	                                const setDialog = (patch: Partial<DialogLayoutV1>) => {
	                                  setUi({ dialog: { ...(ui.dialog || { preset: 'bottom' }), ...patch } as DialogLayoutV1 })
	                                }

	                                const setChoicesLayout = (patch: Partial<ChoicesLayoutV1>) => {
	                                  setUi({ choices: { ...(ui.choices || { direction: 'row' }), ...patch } as ChoicesLayoutV1 })
	                                }

	                                return (
	                                  <>
	                                    <div>
	                                      <div style={{ fontWeight: 700, fontSize: 12, opacity: 0.9 }}>对话框位置（本节点）</div>
	                                      <div className="hint" style={{ marginTop: 6 }}>
	                                        选择“自定义坐标”后，可在画布里拖动对话框定位。
	                                      </div>
	                                    </div>

	                                    <div className="form-row">
	                                      <label>预设</label>
	                                      <select
	                                        className="sel"
	                                        value={preset}
	                                        onChange={(e) => setDialog({ preset: normalizeDialogPreset(e.target.value) })}
	                                      >
	                                        <option value="bottom">底部</option>
	                                        <option value="top">顶部</option>
	                                        <option value="center">居中</option>
	                                        <option value="left">左侧</option>
	                                        <option value="right">右侧</option>
	                                        <option value="custom">自定义坐标</option>
	                                      </select>
	                                    </div>

	                                    {preset === 'custom' ? (
	                                      <div className="form-row">
	                                        <label>坐标</label>
	                                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
	                                          <input
	                                            className="input"
	                                            type="number"
	                                            min={0}
	                                            max={1}
	                                            step={0.01}
	                                            value={String(x)}
	                                            onChange={(e) => setDialog({ x: clamp01(Number(e.target.value)) })}
	                                            style={{ width: 110 }}
	                                          />
	                                          <span style={{ opacity: 0.7 }}>×</span>
	                                          <input
	                                            className="input"
	                                            type="number"
	                                            min={0}
	                                            max={1}
	                                            step={0.01}
	                                            value={String(y)}
	                                            onChange={(e) => setDialog({ y: clamp01(Number(e.target.value)) })}
	                                            style={{ width: 110 }}
	                                          />
	                                        </div>
	                                      </div>
	                                    ) : null}

	                                    <div className="form-row">
	                                      <label>底板透明度</label>
	                                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1 }}>
	                                        <input
	                                          type="range"
	                                          min={0}
	                                          max={100}
	                                          step={1}
	                                          value={Math.round(opacity * 100)}
	                                          onChange={(e) => setDialog({ opacity: clamp01(Number(e.target.value) / 100) })}
	                                          style={{ flex: 1 }}
	                                        />
	                                        <span style={{ minWidth: 40, textAlign: 'right', opacity: 0.85 }}>{Math.round(opacity * 100)}%</span>
	                                      </div>
	                                    </div>

	                                    <div className="hr" />

	                                    <div style={{ fontWeight: 700, fontSize: 12, opacity: 0.9 }}>选项按钮布局（本节点）</div>

	                                    <div className="form-row">
	                                      <label>排列</label>
	                                      <select
	                                        className="sel"
	                                        value={dir}
	                                        onChange={(e) => setChoicesLayout({ direction: normalizeChoicesDirection(e.target.value) })}
	                                      >
	                                        <option value="row">横向（自动换行）</option>
	                                        <option value="column">竖向</option>
	                                      </select>
	                                    </div>

	                                    <div className="form-row">
	                                      <label>对齐</label>
	                                      <select
	                                        className="sel"
	                                        value={align}
	                                        onChange={(e) => setChoicesLayout({ align: normalizeChoicesAlign(e.target.value) })}
	                                      >
	                                        <option value="start">靠左</option>
	                                        <option value="center">居中</option>
	                                        <option value="end">靠右</option>
	                                        <option value="stretch">拉伸</option>
	                                      </select>
	                                    </div>

	                                    <div className="hr" />
	                                  </>
	                                )
	                              })()}

	                              {(Array.isArray(n.choices) ? n.choices : []).map((c) => (
	                                <div key={c.id} style={{ border: '1px solid rgba(148,163,184,0.16)', borderRadius: 12, padding: 10 }}>
	                                  <div className="form-row">
	                                    <label>按钮文本</label>
	                                    <input
	                                      className="input"
	                                      value={c.text}
	                                      disabled={choicesLocked}
	                                      onChange={(e) =>
	                                        choicesLocked ? null :
	                                        setNode((x) => ({
	                                          ...x,
	                                          choices: (Array.isArray(x.choices) ? x.choices : []).map((cc) =>
	                                            cc.id === c.id ? { ...cc, text: e.target.value } : cc
	                                          )
	                                        }))
	                                      }
	                                    />
	                                  </div>
	                                  <div className="form-row">
	                                    <label>跳转到</label>
	                                    <select
	                                      className="sel"
	                                      value={c.toNodeId}
	                                      disabled={choicesLocked}
	                                      onChange={(e) =>
	                                        choicesLocked ? null :
	                                        setNode((x) => ({
	                                          ...x,
	                                          choices: (Array.isArray(x.choices) ? x.choices : []).map((cc) =>
	                                            cc.id === c.id ? { ...cc, toNodeId: e.target.value } : cc
	                                          )
	                                        }))
	                                      }
	                                    >
	                                      {allNodes.map((nn) => (
	                                        <option key={nn.id} value={nn.id}>
	                                          {nn.name || nn.id}
	                                        </option>
	                                      ))}
	                                    </select>
	                                  </div>
	                                  {!choicesLocked ? <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
	                                    <button
	                                      className="btn secondary"
	                                      onClick={() =>
	                                        setNode((x) => ({
	                                          ...x,
	                                          choices: (Array.isArray(x.choices) ? x.choices : []).filter((cc) => cc.id !== c.id)
	                                        }))
	                                      }
	                                    >
	                                      删除选项
	                                    </button>
	                                  </div> : null}
	                                </div>
	                              ))}

                              {!choicesLocked ? <button
                                className="btn secondary"
                                onClick={() => {
                                  const toNodeId = doc.story?.startNodeId || nodes[0]?.id || ''
                                  const next: ChoiceV1 = { id: uid('choice'), text: '继续', toNodeId }
                                  setNode((x) => ({ ...x, choices: [...(Array.isArray(x.choices) ? x.choices : []), next] }))
                                }}
                              >
                                + 添加选项
                              </button> : null}
                            </div>
                        </div>
                      ) : null}
	                    </div>
	                  </div>
	                </div>
	              ) : null}
	            </div>
  )
}
