import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import {
  openProjectAssetFolder,
  resolveUrl,
  type AssetV1,
  type CharacterPlacementV1,
  type ChoiceV1,
  type ChoicesLayoutV1,
  type DialogLayoutV1,
  type NodeUiV1,
  type NodeV1,
  type ProjectV1,
  type StageConfigV1,
  type StoryAssetPlan,
  type StoryV1
} from '../../../api'
import { dlgAlert } from '../../../dialog'
import type { EditorDoc, LeftTab, Selection } from '../types'
import {
  ensureNode,
  normalizeChoicesAlign,
  normalizeChoicesDirection,
  normalizeDialogPreset,
  normalizeStageV1
} from '../orchestration/normalize'
import {
  defaultEndingCardForNode,
  normalizeAdvance,
  type RuntimeState
} from '../orchestration/runtime'
import { clamp01, numberOr, resolveAsset, uid } from '../orchestration/utils'
import { NodePlacementsFold } from './NodePlacementsFold'
import { NodePropsFold } from './NodePropsFold'
import { NodeTimelineFold } from './NodeTimelineFold'

export type ComposeRightFoldState = {
  nodeProps: boolean
  nodeContent: boolean
  timeline: boolean
  background: boolean
  choices: boolean
  placements: boolean
  composition: boolean
}

export type ComposeRightPanelProps = {
  doc: EditorDoc
  selection: Selection
  setSelection: Dispatch<SetStateAction<Selection>>
  setLeftTab: Dispatch<SetStateAction<LeftTab>>
  busy: boolean
  error: string
  rightFold: ComposeRightFoldState
  toggleRightFold: (key: keyof ComposeRightFoldState) => void
  setDocProject: (updater: (p: ProjectV1) => ProjectV1) => void
  setDocStory: (updater: (s: StoryV1) => StoryV1) => void
  activePlacementId: string
  setActivePlacementId: Dispatch<SetStateAction<string>>
  bgRowSelected: boolean
  setBgRowSelected: Dispatch<SetStateAction<boolean>>
  placementPoseDraft: string
  setPlacementPoseDraft: Dispatch<SetStateAction<string>>
  bgFileRef: MutableRefObject<HTMLInputElement | null>
  pendingBgAssetIdRef: MutableRefObject<string>
  placementPropsRef: MutableRefObject<HTMLDivElement | null>
  blueprintLoaded: boolean
  blueprintNodeIdSet: Set<string>
  nodeById: Map<string, NodeV1>
  nodes: NodeV1[]
  effectivePreviewNode: NodeV1 | null
  rt: RuntimeState
  setRt: Dispatch<SetStateAction<RuntimeState>>
  setToast: Dispatch<SetStateAction<string>>
  sbAssetPlan: StoryAssetPlan | null
  chFpBusy: boolean
  chFpError: string
  pushUndo: () => void
  deleteAsset: (assetId: string) => Promise<void>
  deleteCharacter: (characterId: string) => Promise<void>
  handleUploadBackground: (file: File, targetAssetId?: string) => Promise<void>
  openAiStoryboardForCurrentNode: () => Promise<void>
  openCharacterSpriteModal: (characterId: string, posePrompt?: string) => void
  openPoseVariantManagerForCharacter: (characterIdRaw: string) => Promise<void>
  poseVariantOptionsFor: (characterIdRaw: string) => { id: string; name: string }[]
  runCharacterFingerprint: (characterId: string) => Promise<void>
}

export function ComposeRightPanel(props: ComposeRightPanelProps) {
  const {
    doc,
    selection,
    setSelection,
    setLeftTab,
    busy,
    error,
    rightFold,
    toggleRightFold,
    setDocProject,
    setDocStory,
    activePlacementId,
    setActivePlacementId,
    bgRowSelected,
    setBgRowSelected,
    placementPoseDraft,
    setPlacementPoseDraft,
    bgFileRef,
    pendingBgAssetIdRef,
    placementPropsRef,
    blueprintLoaded,
    blueprintNodeIdSet,
    nodeById,
    nodes,
    effectivePreviewNode,
    rt,
    setRt,
    setToast,
    sbAssetPlan,
    chFpBusy,
    chFpError,
    pushUndo,
    deleteAsset,
    deleteCharacter,
    handleUploadBackground,
    openAiStoryboardForCurrentNode,
    openCharacterSpriteModal,
    openPoseVariantManagerForCharacter,
    poseVariantOptionsFor,
    runCharacterFingerprint
  } = props

    if (!doc.project || !doc.story) {
      return (
        <div className="section">
          <div className="hint">右侧是唯一编辑入口：请选择项目后开始。</div>
          {error ? <div style={{ marginTop: 10, color: '#fca5a5' }}>{error}</div> : null}
        </div>
      )
    }

    if (doc.readonly) {
      return (
        <div className="section">
          <div className="hint">当前为示例（只读）。如需编辑，请新建/打开项目。</div>
        </div>
      )
    }

    if (selection.type === 'node') {
      const n0 = nodeById.get(selection.id) || null
      if (!n0) return <div className="section"><div className="hint">节点不存在</div></div>
      const n = ensureNode(n0)
      const fromBlueprint = blueprintLoaded ? blueprintNodeIdSet.has(n.id) : true
      const structureBound = fromBlueprint
      const choicesLocked = fromBlueprint
      const placements = n.visuals?.placements || []
      const activePlacement = placements.find((p) => p.id === activePlacementId) || null

      const setNode = (updater: (node: NodeV1) => NodeV1) => {
        setDocStory((s) => ({
          ...s,
          nodes: s.nodes.map((x) => (x.id === n.id ? ensureNode(updater(ensureNode(x))) : x))
        }))
      }
      // 场景编排器：placement 面板的离散编辑统一先压撤销快照（数字输入用 onFocus 压一次）
      const setNodeUndo = (updater: (node: NodeV1) => NodeV1) => {
        pushUndo()
        setNode(updater)
      }
      const bgAssetId = String(n.visuals?.backgroundAssetId || '').trim()
      const bgAsset = bgAssetId ? (doc.project?.assets || []).find((a) => a.id === bgAssetId) : null
      const bgAssetName = String(bgAsset?.name || bgAssetId || '').trim()

      const allNodes = nodes

      return (
        <div className="section">
          <div className="right-acc">
            <NodePropsFold
              n={n}
              allNodes={allNodes}
              nodes={nodes}
              doc={doc}
              rightFold={rightFold}
              toggleRightFold={toggleRightFold}
              setNode={setNode}
              fromBlueprint={fromBlueprint}
              structureBound={structureBound}
              choicesLocked={choicesLocked}
              busy={busy}
              effectivePreviewNode={effectivePreviewNode}
              handleUploadBackground={handleUploadBackground}
              bgFileRef={bgFileRef}
              pendingBgAssetIdRef={pendingBgAssetIdRef}
              openAiStoryboardForCurrentNode={openAiStoryboardForCurrentNode}
              sbAssetPlan={sbAssetPlan}
              setDocProject={setDocProject}
              rt={rt}
              setRt={setRt}
              setToast={setToast}
            />

	            {/*
	            <div className="fold">
	              <div className="fold-head" onClick={() => toggleRightFold('background')}>
	                <div className="fold-title">尺寸与背景</div>
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
	                <div className="fold-body">
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
	                            onChange={(e) => setStage({ orientation: e.target.value === 'landscape' ? 'landscape' : 'portrait' })}
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
	                      (a) => a.kind === 'image' && (bgUsed.has(a.id) || /^背景/.test(String(a.name || '')) || a.source?.type === 'ai')
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
	                                    assets: (p.assets || []).map((a) => (a.id === bgId ? { ...a, uri: '', source: a.source } : a))
	                                  }))
	                                  setToast('已删除背景图片')
	                                }}
	                                disabled={busy || !hasImage}
	                                title={hasImage ? '清空该背景资源的图片 URI（保留资源条目）' : '当前背景资源未绑定图片'}
	                              >
	                                删除图片
	                              </button>

	                              <button
	                                className="btn secondary"
	                                onClick={() => deleteAsset(bgId)}
	                                disabled={busy}
	                                title="删除该背景资源（会从列表中移除，并清空所有引用）"
	                              >
	                                删除资源
	                              </button>

	                              <button
	                                className="btn secondary"
	                                onClick={() =>
	                                  setNode((x) => ({ ...x, visuals: { ...ensureNode(x).visuals, backgroundAssetId: undefined } }))
	                                }
	                                disabled={busy}
	                                title="仅取消当前节点对该背景资源的关联（不删除资源）"
	                              >
	                                取消关联
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

	                        <div className="hr" />

	                        <div style={{ fontWeight: 700, fontSize: 12, opacity: 0.9 }}>背景图片列表</div>
	                        <div className="hint" style={{ marginTop: 6 }}>
	                          删除资源会清空引用并从列表移除。
	                        </div>
	                        <div className="mini-scroll" style={{ marginTop: 8, maxHeight: 160, display: 'flex', flexDirection: 'column', gap: 6 }}>
	                          {bgAssetsWithSelected.length ? (
	                            bgAssetsWithSelected.map((a) => {
	                              const selected = bgId && a.id === bgId
	                              return (
	                                <div
	                                  key={a.id}
	                                  style={{
	                                    display: 'flex',
	                                    gap: 8,
	                                    alignItems: 'center',
	                                    justifyContent: 'space-between',
	                                    border: '1px solid rgba(148,163,184,0.14)',
	                                    borderRadius: 10,
	                                    padding: '6px 8px',
	                                    background: selected ? 'rgba(37,99,235,0.10)' : 'rgba(2,6,23,0.20)'
	                                  }}
	                                >
	                                  <div style={{ minWidth: 0 }}>
	                                    <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
	                                      {a.name || a.id}
	                                    </div>
	                                    <div style={{ fontSize: 11, opacity: 0.7 }}>{String(a.uri || '').trim() ? '已绑定图片' : '未绑定图片'}</div>
	                                  </div>
	                                  <button className="icon-btn" title="删除该背景资源" onClick={() => deleteAsset(a.id)} disabled={busy}>
	                                    ✕
	                                  </button>
	                                </div>
	                              )
	                            })
	                          ) : (
	                            <div className="hint">暂无背景图片资源。</div>
	                          )}
	                        </div>
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

	            <div className="fold">
	              <div className="fold-head" onClick={() => toggleRightFold('choices')}>
	                <div className="fold-title">对话与选项</div>
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
                <div className="fold-body">
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
	                              <select className="sel" value={preset} onChange={(e) => setDialog({ preset: normalizeDialogPreset(e.target.value) })}>
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
	                              <select className="sel" value={dir} onChange={(e) => setChoicesLayout({ direction: normalizeChoicesDirection(e.target.value) })}>
	                                <option value="row">横向（自动换行）</option>
	                                <option value="column">竖向</option>
	                              </select>
	                            </div>

	                            <div className="form-row">
	                              <label>对齐</label>
	                              <select className="sel" value={align} onChange={(e) => setChoicesLayout({ align: normalizeChoicesAlign(e.target.value) })}>
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
	                              onChange={(e) =>
	                                setNode((x) => ({
	                                  ...x,
	                                  choices: (Array.isArray(x.choices) ? x.choices : []).map((cc) => (cc.id === c.id ? { ...cc, text: e.target.value } : cc))
	                                }))
	                              }
	                            />
	                          </div>
	                          <div className="form-row">
	                            <label>跳转到</label>
	                            <select
	                              className="sel"
	                              value={c.toNodeId}
	                              onChange={(e) =>
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
	                          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
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
	                          </div>
	                        </div>
	                      ))}

                      <button
                        className="btn secondary"
                        onClick={() => {
                          const toNodeId = doc.story?.startNodeId || nodes[0]?.id || ''
                          const next: ChoiceV1 = { id: uid('choice'), text: '继续', toNodeId }
                          setNode((x) => ({ ...x, choices: [...(Array.isArray(x.choices) ? x.choices : []), next] }))
                        }}
                      >
                        + 添加选项
                      </button>
                    </div>
                </div>
              ) : null}
	            </div>

	            */}

            <NodeTimelineFold
              n={n}
              allNodes={allNodes}
              doc={doc}
              rightFold={rightFold}
              toggleRightFold={toggleRightFold}
              setNode={setNode}
            />

            <NodePlacementsFold
              doc={doc}
              rightFold={rightFold}
              toggleRightFold={toggleRightFold}
              setNode={setNode}
              setNodeUndo={setNodeUndo}
              placements={placements}
              activePlacement={activePlacement}
              activePlacementId={activePlacementId}
              setActivePlacementId={setActivePlacementId}
              bgAssetId={bgAssetId}
              bgAssetName={bgAssetName}
              bgRowSelected={bgRowSelected}
              setBgRowSelected={setBgRowSelected}
              placementPoseDraft={placementPoseDraft}
              setPlacementPoseDraft={setPlacementPoseDraft}
              placementPropsRef={placementPropsRef}
              openPoseVariantManagerForCharacter={openPoseVariantManagerForCharacter}
              poseVariantOptionsFor={poseVariantOptionsFor}
              pushUndo={pushUndo}
              setSelection={setSelection}
              setLeftTab={setLeftTab}
              setToast={setToast}
            />
          </div>
        </div>
      )
    }

    if (selection.type === 'character') {
      const ch = doc.project.characters.find((c) => c.id === selection.id) || null
      if (!ch) return <div className="section"><div className="hint">角色不存在</div></div>

      return (
        <div className="section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div style={{ fontWeight: 700 }}>角色属性</div>
            <button className="btn secondary" onClick={() => deleteCharacter(ch.id)} disabled={busy}>删除</button>
          </div>

          <div className="hr" />

          <div className="form">
            <div className="form-row">
              <label>名称</label>
              <input
                className="input"
                value={ch.name}
                onChange={(e) =>
                  setDocProject((p) => ({
                    ...p,
                    characters: p.characters.map((x) => (x.id === ch.id ? { ...x, name: e.target.value } : x))
                  }))
                }
              />
            </div>

            <div className="form-row">
              <label>图片资源</label>
              <select
                className="sel"
                value={ch.imageAssetId || ''}
                onChange={(e) => {
                  const v = e.target.value || undefined
                  setDocProject((p) => ({
                    ...p,
                    characters: p.characters.map((x) => (x.id === ch.id ? { ...x, imageAssetId: v } : x))
                  }))
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

            {ch.imageAssetId ? (
              <div className="hint">
                预览：
                <div style={{ marginTop: 8 }}>
                  {(() => {
                    const a = doc.project.assets.find((x) => x.id === ch.imageAssetId)
                    if (!a?.uri) return null
                    return (
                      <img
                        alt={a.name}
                        src={resolveAsset(a.uri, doc.assetBase)}
                        style={{ maxWidth: '100%', borderRadius: 10, border: '1px solid rgba(148,163,184,0.18)' }}
                      />
                    )
                  })()}
                </div>
              </div>
            ) : null}

            <div className="hr" />

            <div style={{ fontWeight: 800 }}>AI 角色一致性</div>
            <div className="hint" style={{ marginTop: 6 }}>
              建议流程：先提取“角色设定指纹”（用于全局锁定），再生成“透明 PNG 角色图”（可用于摆放/覆盖），避免每个场景人物变脸。
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              <button className="btn secondary" onClick={() => void runCharacterFingerprint(ch.id)} disabled={busy || chFpBusy}>
                {chFpBusy ? '提取中…' : 'AI 提取角色设定'}
              </button>
              <button className="btn secondary" onClick={() => openCharacterSpriteModal(ch.id)} disabled={busy}>
                AI 生成角色 PNG（透明）
              </button>
            </div>

            {chFpError ? <div style={{ marginTop: 8, color: '#fca5a5', fontSize: 12 }}>{chFpError}</div> : null}

            <div className="form-row" style={{ marginTop: 10 }}>
              <label>指纹（全局锁定）</label>
              <textarea
                className="textarea"
                rows={3}
                value={String(ch.ai?.fingerprintPrompt || '')}
                onChange={(e) =>
                  setDocProject((p) => ({
                    ...p,
                    characters: (p.characters || []).map((x) =>
                      x.id === ch.id ? { ...x, ai: { ...(x.ai || {}), fingerprintPrompt: e.target.value } } : x
                    )
                  }))
                }
                placeholder="可手动补充更具体的外貌/服饰/标志性特征（后续全局复用）"
              />
            </div>

            <div className="form-row">
              <label>一致性负面（可选）</label>
              <input
                className="input"
                value={String(ch.ai?.negativePrompt || '')}
                onChange={(e) =>
                  setDocProject((p) => ({
                    ...p,
                    characters: (p.characters || []).map((x) =>
                      x.id === ch.id ? { ...x, ai: { ...(x.ai || {}), negativePrompt: e.target.value } } : x
                    )
                  }))
                }
                placeholder="例如：变脸,换装,发型变化,颜色变化,多只动物"
              />
            </div>
          </div>
        </div>
      )
    }

    if (selection.type === 'asset') {
      const a = doc.project.assets.find((x) => x.id === selection.id) || null
      if (!a) return <div className="section"><div className="hint">资源不存在</div></div>
      const assetUrl = String(a.uri || '').trim() ? resolveAsset(a.uri, doc.assetBase) : ''

      return (
        <div className="section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div style={{ fontWeight: 700 }}>资源属性</div>
            <button className="btn secondary" onClick={() => deleteAsset(a.id)} disabled={busy}>删除</button>
          </div>

          <div className="hr" />

          <div className="form">
            <div className="form-row">
              <label>名称</label>
              <input
                className="input"
                value={a.name}
                onChange={(e) =>
                  setDocProject((p) => ({
                    ...p,
                    assets: p.assets.map((x) => (x.id === a.id ? { ...x, name: e.target.value } : x))
                  }))
                }
              />
            </div>

            <div className="form-row">
              <label>URI</label>
              <input
                className="input"
                value={a.uri}
                onChange={(e) =>
                  setDocProject((p) => ({
                    ...p,
                    assets: p.assets.map((x) => (x.id === a.id ? { ...x, uri: e.target.value } : x))
                  }))
                }
                placeholder="例如：assets/bg.png 或 https://..."
              />
            </div>

            <div className="hint">预览</div>
            {a.uri ? (
              <>
                <img
                  alt={a.name}
                  src={assetUrl}
                  style={{ maxWidth: '100%', borderRadius: 10, border: '1px solid rgba(148,163,184,0.18)' }}
                />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  <button
                    className="btn secondary"
                    onClick={() => {
                      if (!assetUrl) return
                      window.open(assetUrl, '_blank', 'noopener,noreferrer')
                    }}
                    disabled={!assetUrl}
                  >
                    预览图片
                  </button>
                  <button
                    className="btn secondary"
                    onClick={async () => {
                      if (doc.mode !== 'project') return
                      try {
                        const res = await openProjectAssetFolder(doc.id, String(a.uri || ''))
                        setToast(res.folder ? `已打开文件夹：${res.folder}` : '已打开文件夹')
                      } catch (e) {
                        setToast(e instanceof Error ? e.message : String(e))
                      }
                    }}
                    disabled={doc.mode !== 'project'}
                  >
                    打开所在文件夹
                  </button>
                </div>
              </>
            ) : (
              <div className="hint">未设置 URI</div>
            )}
          </div>
        </div>
      )
    }

    return (
      <div className="section">
        <div style={{ fontWeight: 800 }}>全局设置（运行时）</div>
        <div className="hint" style={{ marginTop: 6 }}>
          这里配置 State（变量/条件）与 Event（宏）。左侧仅做结构导航；所有编辑都在右侧完成。
        </div>

        <div className="hr" />

        <div style={{ fontWeight: 700 }}>State（变量）</div>
        <div className="hint">变量名用于条件判断与 state.* 动作（例如：trust / liedCount / tags）。</div>

        <div className="form" style={{ gap: 8, marginTop: 8 }}>
          {(Array.isArray(doc.project.state?.vars) ? doc.project.state!.vars : []).map((v, i) => (
            <div key={`${v.name}_${i}`} style={{ border: '1px solid rgba(148,163,184,0.16)', borderRadius: 14, padding: 12 }}>
              <div className="form-row">
                <label>名称</label>
                <input
                  className="input"
                  value={String(v.name || '')}
                  onChange={(e) =>
                    setDocProject((p) => {
                      const state = p.state && typeof p.state === 'object' ? p.state : { vars: [] }
                      const vars = Array.isArray(state.vars) ? state.vars.slice() : []
                      vars[i] = { ...(vars[i] as any), name: e.target.value }
                      return { ...p, state: { ...state, vars } }
                    })
                  }
                />
              </div>
              <div className="form-row">
                <label>类型</label>
                <select
                  className="sel"
                  value={String((v as any).type || 'string')}
                  onChange={(e) =>
                    setDocProject((p) => {
                      const state = p.state && typeof p.state === 'object' ? p.state : { vars: [] }
                      const vars = Array.isArray(state.vars) ? state.vars.slice() : []
                      const type = e.target.value as any
                      const cur = vars[i] as any
                      const def =
                        type === 'number' ? 0 :
                        type === 'boolean' ? false :
                        type === 'tags' ? [] :
                        ''
                      vars[i] = { ...cur, type, default: cur && cur.default != null ? cur.default : def }
                      return { ...p, state: { ...state, vars } }
                    })
                  }
                >
                  <option value="string">字符串</option>
                  <option value="number">数字</option>
                  <option value="boolean">布尔</option>
                  <option value="tags">标签集合（数组）</option>
                </select>
              </div>
              <div className="form-row">
                <label>默认值</label>
                {String((v as any).type || 'string') === 'number' ? (
                  <input
                    className="input"
                    type="number"
                    value={String(Number.isFinite(Number((v as any).default)) ? Number((v as any).default) : 0)}
                    onChange={(e) =>
                      setDocProject((p) => {
                        const state = p.state && typeof p.state === 'object' ? p.state : { vars: [] }
                        const vars = Array.isArray(state.vars) ? state.vars.slice() : []
                        vars[i] = { ...(vars[i] as any), default: Number(e.target.value) }
                        return { ...p, state: { ...state, vars } }
                      })
                    }
                  />
                ) : String((v as any).type || 'string') === 'boolean' ? (
                  <select
                    className="sel"
                    value={String(Boolean((v as any).default))}
                    onChange={(e) =>
                      setDocProject((p) => {
                        const state = p.state && typeof p.state === 'object' ? p.state : { vars: [] }
                        const vars = Array.isArray(state.vars) ? state.vars.slice() : []
                        vars[i] = { ...(vars[i] as any), default: e.target.value === 'true' }
                        return { ...p, state: { ...state, vars } }
                      })
                    }
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : String((v as any).type || 'string') === 'tags' ? (
                  <input
                    className="input"
                    value={Array.isArray((v as any).default) ? (v as any).default.join(',') : ''}
                    onChange={(e) =>
                      setDocProject((p) => {
                        const state = p.state && typeof p.state === 'object' ? p.state : { vars: [] }
                        const vars = Array.isArray(state.vars) ? state.vars.slice() : []
                        const parts = String(e.target.value || '')
                          .split(',')
                          .map((x) => x.trim())
                          .filter(Boolean)
                        vars[i] = { ...(vars[i] as any), default: parts }
                        return { ...p, state: { ...state, vars } }
                      })
                    }
                    placeholder="用逗号分隔，例如：lied,helped"
                  />
                ) : (
                  <input
                    className="input"
                    value={String((v as any).default ?? '')}
                    onChange={(e) =>
                      setDocProject((p) => {
                        const state = p.state && typeof p.state === 'object' ? p.state : { vars: [] }
                        const vars = Array.isArray(state.vars) ? state.vars.slice() : []
                        vars[i] = { ...(vars[i] as any), default: e.target.value }
                        return { ...p, state: { ...state, vars } }
                      })
                    }
                  />
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  className="btn secondary"
                  onClick={() =>
                    setDocProject((p) => {
                      const state = p.state && typeof p.state === 'object' ? p.state : { vars: [] }
                      const vars = Array.isArray(state.vars) ? state.vars.slice() : []
                      vars.splice(i, 1)
                      return { ...p, state: { ...state, vars } }
                    })
                  }
                >
                  删除变量
                </button>
              </div>
            </div>
          ))}

          <button
            className="btn secondary"
            onClick={() =>
              setDocProject((p) => {
                const state = p.state && typeof p.state === 'object' ? p.state : { vars: [] }
                const vars = Array.isArray(state.vars) ? state.vars.slice() : []
                vars.push({ name: `var_${vars.length + 1}`, type: 'number', default: 0 })
                return { ...p, state: { ...state, vars } }
              })
            }
          >
            + 添加变量
          </button>
        </div>

        <div className="hr" />

        <div style={{ fontWeight: 700 }}>Event（宏）</div>
        <div className="hint">事件宏用于复用动作序列（通过 action: event.call 触发）。</div>

        <div className="form" style={{ gap: 8, marginTop: 8 }}>
          {(Array.isArray(doc.project.events) ? doc.project.events : []).map((ev, i) => (
            <div key={ev.id} style={{ border: '1px solid rgba(148,163,184,0.16)', borderRadius: 14, padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <div style={{ fontWeight: 800 }}>事件：{ev.name || ev.id}</div>
                <button
                  className="btn secondary"
                  onClick={() =>
                    setDocProject((p) => ({ ...p, events: (Array.isArray(p.events) ? p.events : []).filter((_, j) => j !== i) }))
                  }
                >
                  删除
                </button>
              </div>

              <div className="hr" />

              <div className="form-row">
                <label>名称</label>
                <input
                  className="input"
                  value={String(ev.name || '')}
                  onChange={(e) =>
                    setDocProject((p) => {
                      const list = Array.isArray(p.events) ? p.events.slice() : []
                      list[i] = { ...(list[i] as any), name: e.target.value }
                      return { ...p, events: list }
                    })
                  }
                />
              </div>

              {(() => {
                const stateVars = Array.isArray(doc.project?.state?.vars) ? (doc.project?.state?.vars || []) : []
                const actions = Array.isArray((ev as any).actions) ? (ev as any).actions : []
                const setActions = (updater: (acts: any[]) => any[]) =>
                  setDocProject((p) => {
                    const list = Array.isArray(p.events) ? p.events.slice() : []
                    const cur = list[i] as any
                    const acts = Array.isArray(cur && cur.actions) ? cur.actions.slice() : []
                    list[i] = { ...cur, actions: updater(acts) }
                    return { ...p, events: list }
                  })

                const makeAction = (type: string): any => {
                  if (type === 'ui.toast') return { type: 'ui.toast', text: '' }
                  if (type === 'ui.setText') return { type: 'ui.setText', mode: 'replace', text: '' }
                  if (type === 'events.emit') return { type: 'events.emit', name: '' }
                  if (type === 'state.set') return { type: 'state.set', var: stateVars[0]?.name || '', value: '' }
                  if (type === 'state.inc') return { type: 'state.inc', var: stateVars[0]?.name || '', value: 1 }
                  if (type === 'state.toggle') return { type: 'state.toggle', var: stateVars[0]?.name || '' }
                  if (type === 'state.tags.add') return { type: 'state.tags.add', var: stateVars[0]?.name || '', value: '' }
                  if (type === 'state.tags.remove') return { type: 'state.tags.remove', var: stateVars[0]?.name || '', value: '' }
                  if (type === 'flow.gotoNode') return { type: 'flow.gotoNode', nodeId: doc.story?.startNodeId || (nodes[0]?.id || '') }
                  if (type === 'flow.restart') return { type: 'flow.restart' }
                  if (type === 'flow.backToHub') return { type: 'flow.backToHub' }
                  return { type }
                }

                const types = [
                  'ui.toast',
                  'ui.setText',
                  'events.emit',
                  'state.set',
                  'state.inc',
                  'state.toggle',
                  'state.tags.add',
                  'state.tags.remove',
                  'flow.gotoNode',
                  'flow.restart',
                  'flow.backToHub'
                ]

                return (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontWeight: 700, fontSize: 12, opacity: 0.9 }}>动作</div>

                    <div className="form" style={{ gap: 8, marginTop: 8 }}>
                      {actions.map((a: any, ai: number) => {
                        const type = String(a && a.type || '')
                        return (
                          <div key={`${ev.id}_a_${ai}`} style={{ border: '1px solid rgba(148,163,184,0.14)', borderRadius: 12, padding: 10 }}>
                            <div className="form-row">
                              <label>类型</label>
                              <select className="sel" value={type} onChange={(e) => setActions((acts) => {
                                const next = acts.slice()
                                next[ai] = makeAction(e.target.value)
                                return next
                              })}>
                                {types.map((t) => (
                                  <option key={t} value={t}>{t}</option>
                                ))}
                              </select>
                            </div>

                            {type === 'ui.toast' ? (
                              <div className="form-row">
                                <label>内容</label>
                                <input className="input" value={String(a?.text || '')} onChange={(e) => setActions((acts) => {
                                  const next = acts.slice()
                                  next[ai] = { ...next[ai], text: e.target.value }
                                  return next
                                })} />
                              </div>
                            ) : null}

                            {type === 'ui.setText' ? (
                              <>
                                <div className="form-row">
                                  <label>模式</label>
                                  <select className="sel" value={String(a?.mode || 'replace')} onChange={(e) => setActions((acts) => {
                                    const next = acts.slice()
                                    next[ai] = { ...next[ai], mode: e.target.value }
                                    return next
                                  })}>
                                    <option value="replace">替换</option>
                                    <option value="append">追加</option>
                                  </select>
                                </div>
                                <div className="form-row">
                                  <label>文本</label>
                                  <textarea className="textarea" value={String(a?.text || '')} onChange={(e) => setActions((acts) => {
                                    const next = acts.slice()
                                    next[ai] = { ...next[ai], text: e.target.value }
                                    return next
                                  })} />
                                </div>
                              </>
                            ) : null}

                            {type === 'events.emit' ? (
                              <div className="form-row">
                                <label>事件名</label>
                                <input className="input" value={String(a?.name || '')} onChange={(e) => setActions((acts) => {
                                  const next = acts.slice()
                                  next[ai] = { ...next[ai], name: e.target.value }
                                  return next
                                })} placeholder="例如：ad_ready" />
                              </div>
                            ) : null}

                            {type === 'state.set' ? (
                              <>
                                <div className="form-row">
                                  <label>变量</label>
                                  <input className="input" value={String(a?.var || '')} onChange={(e) => setActions((acts) => {
                                    const next = acts.slice()
                                    next[ai] = { ...next[ai], var: e.target.value }
                                    return next
                                  })} />
                                </div>
                                <div className="form-row">
                                  <label>值</label>
                                  <input className="input" value={String(a?.value ?? '')} onChange={(e) => setActions((acts) => {
                                    const next = acts.slice()
                                    next[ai] = { ...next[ai], value: e.target.value }
                                    return next
                                  })} />
                                </div>
                              </>
                            ) : null}

                            {type === 'state.inc' ? (
                              <>
                                <div className="form-row">
                                  <label>变量</label>
                                  <input className="input" value={String(a?.var || '')} onChange={(e) => setActions((acts) => {
                                    const next = acts.slice()
                                    next[ai] = { ...next[ai], var: e.target.value }
                                    return next
                                  })} />
                                </div>
                                <div className="form-row">
                                  <label>增量</label>
                                  <input className="input" type="number" value={String(Number.isFinite(Number(a?.value)) ? Number(a.value) : 1)} onChange={(e) => setActions((acts) => {
                                    const next = acts.slice()
                                    next[ai] = { ...next[ai], value: Number(e.target.value) }
                                    return next
                                  })} />
                                </div>
                              </>
                            ) : null}

                            {type === 'state.toggle' ? (
                              <div className="form-row">
                                <label>变量</label>
                                <input className="input" value={String(a?.var || '')} onChange={(e) => setActions((acts) => {
                                  const next = acts.slice()
                                  next[ai] = { ...next[ai], var: e.target.value }
                                  return next
                                })} />
                              </div>
                            ) : null}

                            {type === 'state.tags.add' || type === 'state.tags.remove' ? (
                              <>
                                <div className="form-row">
                                  <label>变量</label>
                                  <input className="input" value={String(a?.var || '')} onChange={(e) => setActions((acts) => {
                                    const next = acts.slice()
                                    next[ai] = { ...next[ai], var: e.target.value }
                                    return next
                                  })} />
                                </div>
                                <div className="form-row">
                                  <label>值</label>
                                  <input className="input" value={String(a?.value || '')} onChange={(e) => setActions((acts) => {
                                    const next = acts.slice()
                                    next[ai] = { ...next[ai], value: e.target.value }
                                    return next
                                  })} />
                                </div>
                              </>
                            ) : null}

                            {type === 'flow.gotoNode' ? (
                              <div className="form-row">
                                <label>跳转到</label>
                                <select className="sel" value={String(a?.nodeId || '')} onChange={(e) => setActions((acts) => {
                                  const next = acts.slice()
                                  next[ai] = { ...next[ai], nodeId: e.target.value }
                                  return next
                                })}>
                                  {nodes.map((nn) => (
                                    <option key={nn.id} value={nn.id}>{nn.name || nn.id}</option>
                                  ))}
                                </select>
                              </div>
                            ) : null}

                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                              <button className="btn secondary" onClick={() => setActions((acts) => acts.filter((_, j) => j !== ai))}>删除动作</button>
                            </div>
                          </div>
                        )
                      })}

                      <button className="btn secondary" onClick={() => setActions((acts) => [...acts, makeAction('ui.toast')])}>+ 添加动作</button>
                    </div>
                  </div>
                )
              })()}
            </div>
          ))}

          <button
            className="btn secondary"
            onClick={() =>
              setDocProject((p) => {
                const list = Array.isArray(p.events) ? p.events.slice() : []
                list.push({ id: uid('ev'), name: `事件${list.length + 1}`, actions: [] })
                return { ...p, events: list }
              })
            }
          >
            + 添加事件宏
          </button>
        </div>
      </div>
    )
}
