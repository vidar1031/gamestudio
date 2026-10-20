import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import {
  type CharacterPlacementV1,
  type NodeV1
} from '../../../api'
import { dlgAlert } from '../../../dialog'
import type { EditorDoc, LeftTab, Selection } from '../types'
import { ensureNode } from '../orchestration/normalize'
import { clamp01, numberOr, resolveAsset, uid } from '../orchestration/utils'
import type { ComposeRightFoldState } from './RightPanel'

export type NodePlacementsFoldProps = {
  doc: EditorDoc
  rightFold: ComposeRightFoldState
  toggleRightFold: (key: keyof ComposeRightFoldState) => void
  setNode: (updater: (node: NodeV1) => NodeV1) => void
  setNodeUndo: (updater: (node: NodeV1) => NodeV1) => void
  placements: CharacterPlacementV1[]
  activePlacement: CharacterPlacementV1 | null
  activePlacementId: string
  setActivePlacementId: Dispatch<SetStateAction<string>>
  bgAssetId: string
  bgAssetName: string
  bgRowSelected: boolean
  setBgRowSelected: Dispatch<SetStateAction<boolean>>
  placementPoseDraft: string
  setPlacementPoseDraft: Dispatch<SetStateAction<string>>
  placementPropsRef: MutableRefObject<HTMLDivElement | null>
  openPoseVariantManagerForCharacter: (characterIdRaw: string) => Promise<void>
  poseVariantOptionsFor: (characterIdRaw: string) => { id: string; name: string }[]
  pushUndo: () => void
  setSelection: Dispatch<SetStateAction<Selection>>
  setLeftTab: Dispatch<SetStateAction<LeftTab>>
  setToast: Dispatch<SetStateAction<string>>
}

export function NodePlacementsFold(props: NodePlacementsFoldProps) {
  const {
    doc,
    rightFold,
    toggleRightFold,
    setNode,
    setNodeUndo,
    placements,
    activePlacement,
    activePlacementId,
    setActivePlacementId,
    bgAssetId,
    bgAssetName,
    bgRowSelected,
    setBgRowSelected,
    placementPoseDraft,
    setPlacementPoseDraft,
    placementPropsRef,
    openPoseVariantManagerForCharacter,
    poseVariantOptionsFor,
    pushUndo,
    setSelection,
    setLeftTab,
    setToast
  } = props

  // 收窄护栏：本面板仅在主组件 doc.project/doc.story 非空分支内渲染（与原 IIFE 分支前置守卫等价）
  if (!doc.project || !doc.story) return null

  return (
	            <div className="fold">
	              <div className="fold-head" onClick={() => toggleRightFold('placements')}>
	                <div className="fold-title">元素层级（背景 / 摆放）</div>
	                <div className="fold-actions" onClick={(e) => e.stopPropagation()}>
	                  <button
                    type="button"
                    className="icon-btn"
                    title={rightFold.placements ? '折叠' : '展开'}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleRightFold('placements')
                    }}
                  >
                    {rightFold.placements ? '－' : '＋'}
                  </button>
                </div>
              </div>

              {rightFold.placements ? (
                <div className="fold-body">
                  <div className="hint">角色是独立实体；节点只保存摆放 Placement。</div>

            <div className="form" style={{ gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  className="btn secondary"
                  onClick={() => {
                    const choices = doc.project?.characters || []
                    if (!choices.length) {
                      void dlgAlert('请先在左侧创建角色')
                      return
                    }
                    pushUndo()
                    const chId = choices[0].id
                    const p: CharacterPlacementV1 = {
                      id: uid('pl'),
                      characterId: chId,
                      transform: { x: 0.5, y: 1, scale: 1, rotationDeg: 0 },
                      visible: true,
                      zIndex: 0
                    }
                    setNode((x) => ({
                      ...x,
                      visuals: { ...ensureNode(x).visuals, placements: [...(ensureNode(x).visuals?.placements || []), p] }
                    }))
                    setActivePlacementId(p.id)
                  }}
                >
                  + 添加角色摆放
                </button>

                <button className="btn secondary" onClick={() => setActivePlacementId('')}>取消选择摆放</button>
              </div>

              <div className="list stage-layer-list">
                <div
                  className={`item stage-layer-item ${bgRowSelected ? 'active' : ''}`}
                  onClick={() => { setBgRowSelected(true); setActivePlacementId('') }}
                  title="场景背景（在「尺寸与背景」分组中更换）"
                >
                  <div className="stage-layer-thumb stage-layer-thumb-bg">背</div>
                  <div className="stage-layer-main">
                    <div>背景</div>
                    <div className="meta">{bgAssetName || '未设置背景'}</div>
                  </div>
                </div>
                {placements.slice().sort((a, b) => numberOr(b.zIndex, 0) - numberOr(a.zIndex, 0)).map((p) => {
                  const ch = doc.project?.characters.find((c) => c.id === p.characterId)
                  const imgId = String(p.imageAssetId || ch?.imageAssetId || '').trim()
                  const asset = imgId ? (doc.project?.assets || []).find((x) => x.id === imgId) : null
                  const name = String(ch?.name || asset?.name || p.characterId || p.id)
                  const thumbUrl = asset?.uri ? resolveAsset(String(asset.uri), doc.assetBase) : ''
                  const hidden = p.visible === false
                  return (
                    <div
                      key={p.id}
                      className={`item stage-layer-item ${p.id === activePlacementId && !bgRowSelected ? 'active' : ''}${hidden ? ' stage-layer-hidden' : ''}`}
                      onClick={() => { setBgRowSelected(false); setActivePlacementId(p.id) }}
                    >
                      {thumbUrl ? (
                        <img className="stage-layer-thumb" src={thumbUrl} alt="" />
                      ) : (
                        <div className="stage-layer-thumb stage-layer-thumb-fallback">{name.slice(0, 1)}</div>
                      )}
                      <div className="stage-layer-main">
                        <div>{name}</div>
                        <div className="meta">层级 {numberOr(p.zIndex, 0)}</div>
                      </div>
                      <div className="stage-layer-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="icon-btn"
                          title={hidden ? '显示该元素' : '隐藏该元素'}
                          onClick={() => setNodeUndo((x) => ({
                            ...x,
                            visuals: {
                              ...ensureNode(x).visuals,
                              placements: (ensureNode(x).visuals?.placements || []).map((pp) =>
                                pp.id === p.id ? { ...pp, visible: hidden } : pp
                              )
                            }
                          }))}
                        >
                          {hidden ? '隐' : '显'}
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="上移一层"
                          onClick={() => setNodeUndo((x) => ({
                            ...x,
                            visuals: {
                              ...ensureNode(x).visuals,
                              placements: (ensureNode(x).visuals?.placements || []).map((pp) =>
                                pp.id === p.id ? { ...pp, zIndex: numberOr(pp.zIndex, 0) + 1 } : pp
                              )
                            }
                          }))}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="下移一层"
                          onClick={() => setNodeUndo((x) => ({
                            ...x,
                            visuals: {
                              ...ensureNode(x).visuals,
                              placements: (ensureNode(x).visuals?.placements || []).map((pp) =>
                                pp.id === p.id ? { ...pp, zIndex: numberOr(pp.zIndex, 0) - 1 } : pp
                              )
                            }
                          }))}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="删除该摆放"
                          onClick={() => {
                            setNodeUndo((x) => ({
                              ...x,
                              visuals: {
                                ...ensureNode(x).visuals,
                                placements: (ensureNode(x).visuals?.placements || []).filter((pp) => pp.id !== p.id)
                              }
                            }))
                            if (activePlacementId === p.id) setActivePlacementId('')
                          }}
                        >
                          删
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
              {bgRowSelected ? (
                <div className="hint" style={{ marginTop: 6 }}>
                  背景：{bgAssetName || '未设置'}{bgAssetId ? `（${bgAssetId}）` : ''}。更换或生成背景在上方「尺寸与背景」分组。
                </div>
              ) : null}

              {activePlacement ? (
                <div
                  key={activePlacement.id}
                  ref={placementPropsRef}
                  className="placement-props-card"
                  style={{ border: '1px solid rgba(148,163,184,0.16)', borderRadius: 12, padding: 10 }}
                >
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>
                    摆放属性{(() => {
                      const ch = doc.project?.characters.find((c) => c.id === activePlacement.characterId)
                      const imgId = String(activePlacement.imageAssetId || ch?.imageAssetId || '').trim()
                      const asset = imgId ? (doc.project?.assets || []).find((x) => x.id === imgId) : null
                      const label = String(ch?.name || asset?.name || '').trim()
                      return label ? `：${label}` : ''
                    })()}
                  </div>

                  {/* 2026-09-01 图片来源追溯（B）：当前图是哪张、从哪来，一眼可查 */}
                  {(() => {
                    const ch0 = doc.project?.characters.find((c) => c.id === activePlacement.characterId)
                    const imgId0 = String(activePlacement.imageAssetId || ch0?.imageAssetId || '').trim()
                    const asset0 = imgId0 ? (doc.project?.assets || []).find((x) => x.id === imgId0) || null : null
                    if (!asset0) return null
                    const thumb = asset0.uri ? resolveAsset(String(asset0.uri), doc.assetBase) : ''
                    const srcPrompt = String((asset0 as any)?.source?.prompt || '').trim()
                    return (
                      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 10, padding: 8, borderRadius: 10, background: 'rgba(94,204,255,0.06)' }}>
                        {thumb ? <img src={thumb} alt="" style={{ width: 56, height: 56, objectFit: 'contain', borderRadius: 8, background: 'rgba(255,255,255,0.06)', flexShrink: 0 }} /> : null}
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asset0.name || asset0.id}</div>
                          <div className="hint" style={{ fontSize: 11, wordBreak: 'break-all' }}>{asset0.id}</div>
                          {srcPrompt ? (
                            <details style={{ marginTop: 4 }}>
                              <summary className="hint" style={{ cursor: 'pointer', fontSize: 11 }}>生成提示词摘要</summary>
                              <div className="hint" style={{ fontSize: 11, marginTop: 4, maxHeight: 90, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{srcPrompt.slice(0, 600)}</div>
                            </details>
                          ) : null}
                          <div style={{ marginTop: 6 }}>
                            <button
                              type="button"
                              className="btn secondary"
                              style={{ fontSize: 11, padding: '2px 10px' }}
                              onClick={() => {
                                setSelection({ type: 'asset', id: asset0.id })
                                setLeftTab('assets')
                              }}
                            >
                              在资源中打开
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })()}

                  <div className="form-row">
                    <label>角色</label>
                    <select
                      className="sel"
                      value={activePlacement.characterId}
                      onChange={(e) => {
                        const id = e.target.value
                        setNodeUndo((x) => ({
                          ...x,
                          visuals: {
                            ...ensureNode(x).visuals,
                            placements: (ensureNode(x).visuals?.placements || []).map((pp) =>
                              pp.id === activePlacement.id ? { ...pp, characterId: id } : pp
                            )
                          }
                        }))
                      }}
                    >
                      {doc.project.characters.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name || c.id}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-row">
                    <label>图片（修改）</label>
                    {/* 2026-09-01 摆放属性降级为纯消费端：只列「使用角色默认」+ 该角色已锁定姿势变体；
                        当前引用不在列表中（历史遗留）时追加「当前（未纳入管理）」保证不丢显示 */}
                    {(() => {
                      const poseOpts = poseVariantOptionsFor(activePlacement.characterId)
                      const currentId = String(activePlacement.imageAssetId || '').trim()
                      const currentInList = currentId && poseOpts.some((v) => v.id === currentId)
                      return (
                        <select
                          className="sel"
                          value={activePlacement.imageAssetId || ''}
                          onChange={(e) => {
                            const v = e.target.value || undefined
                            setNodeUndo((x) => ({
                              ...x,
                              visuals: {
                                ...ensureNode(x).visuals,
                                placements: (ensureNode(x).visuals?.placements || []).map((pp) =>
                                  pp.id === activePlacement.id ? { ...pp, imageAssetId: v } : pp
                                )
                              }
                            }))
                          }}
                          title="为当前节点的该角色摆放选用一个已锁定姿势变体（覆盖角色默认图片）；姿势变体在「锁定事物」向导第 5 步管理"
                        >
                          <option value="">（使用角色默认）</option>
                          {poseOpts.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.name}
                            </option>
                          ))}
                          {currentId && !currentInList ? <option value={currentId}>当前（未纳入管理）</option> : null}
                        </select>
                      )
                    })()}
                  </div>

                  <div className="form-row">
                    <label>动作描述</label>
                    <textarea
                      className="story-lock-textarea compact-rows"
                      value={placementPoseDraft}
                      onChange={(e) => setPlacementPoseDraft(e.target.value)}
                      placeholder="该角色在当前场景的动作与表情，例如：指着左边稻草堆，得意表情"
                    />
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      className="btn secondary"
                      onClick={() => void openPoseVariantManagerForCharacter(activePlacement.characterId)}
                      title="出图统一管理在锁定向导：打开「锁定事物」第 5 步该角色资产的姿势变体区（抽卡/评分/命名锁定）"
                    >
                      管理姿势变体…
                    </button>
                    {activePlacement.imageAssetId ? (
                      <button
                        className="btn secondary"
                        onClick={() => {
                          setNodeUndo((x) => ({
                            ...x,
                            visuals: {
                              ...ensureNode(x).visuals,
                              placements: (ensureNode(x).visuals?.placements || []).map((pp) =>
                                pp.id === activePlacement.id ? { ...pp, imageAssetId: undefined } : pp
                              )
                            }
                          }))
                        }}
                        title="清除该摆放的图片修改，回退为角色默认图片"
                      >
                        恢复默认
                      </button>
                    ) : null}
                  </div>

                  <div className="form-row">
                    <label>x（0-1）</label>
                    <input
                      className="input"
                      type="number"
                      step="0.01"
                      value={activePlacement.transform.x}
                      onFocus={pushUndo}
                      onChange={(e) => {
                        const v = clamp01(Number(e.target.value))
                        setNode((x) => ({
                          ...x,
                          visuals: {
                            ...ensureNode(x).visuals,
                            placements: (ensureNode(x).visuals?.placements || []).map((pp) =>
                              pp.id === activePlacement.id ? { ...pp, transform: { ...pp.transform, x: v } } : pp
                            )
                          }
                        }))
                      }}
                    />
                  </div>

                  <div className="form-row">
                    <label>y（0-1）</label>
                    <input
                      className="input"
                      type="number"
                      step="0.01"
                      value={activePlacement.transform.y}
                      onFocus={pushUndo}
                      onChange={(e) => {
                        const v = clamp01(Number(e.target.value))
                        setNode((x) => ({
                          ...x,
                          visuals: {
                            ...ensureNode(x).visuals,
                            placements: (ensureNode(x).visuals?.placements || []).map((pp) =>
                              pp.id === activePlacement.id ? { ...pp, transform: { ...pp.transform, y: v } } : pp
                            )
                          }
                        }))
                      }}
                    />
                  </div>

                  <div className="form-row">
                    <label>缩放</label>
                    <input
                      className="input"
                      type="number"
                      step="0.05"
                      value={activePlacement.transform.scale}
                      onFocus={pushUndo}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        setNode((x) => ({
                          ...x,
                          visuals: {
                            ...ensureNode(x).visuals,
                            placements: (ensureNode(x).visuals?.placements || []).map((pp) =>
                              pp.id === activePlacement.id ? { ...pp, transform: { ...pp.transform, scale: v } } : pp
                            )
                          }
                        }))
                      }}
                    />
                  </div>

                  <div className="form-row">
                    <label>角度</label>
                    <input
                      className="input"
                      type="number"
                      step="1"
                      value={activePlacement.transform.rotationDeg}
                      onFocus={pushUndo}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        setNode((x) => ({
                          ...x,
                          visuals: {
                            ...ensureNode(x).visuals,
                            placements: (ensureNode(x).visuals?.placements || []).map((pp) =>
                              pp.id === activePlacement.id ? { ...pp, transform: { ...pp.transform, rotationDeg: v } } : pp
                            )
                          }
                        }))
                      }}
                    />
                  </div>

                  <div className="form-row">
                    <label>层级（zIndex）</label>
                    <input
                      className="input"
                      type="number"
                      step="1"
                      value={numberOr(activePlacement.zIndex, 0)}
                      onFocus={pushUndo}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        setNode((x) => ({
                          ...x,
                          visuals: {
                            ...ensureNode(x).visuals,
                            placements: (ensureNode(x).visuals?.placements || []).map((pp) =>
                              pp.id === activePlacement.id ? { ...pp, zIndex: Number.isFinite(v) ? v : 0 } : pp
                            )
                          }
                        }))
                      }}
                    />
                  </div>

                  <div className="form-row">
                    <label>可见</label>
                    <select
                      className="sel"
                      value={activePlacement.visible === false ? '0' : '1'}
                      onChange={(e) => {
                        const v = e.target.value === '0' ? false : true
                        setNodeUndo((x) => ({
                          ...x,
                          visuals: {
                            ...ensureNode(x).visuals,
                            placements: (ensureNode(x).visuals?.placements || []).map((pp) =>
                              pp.id === activePlacement.id ? { ...pp, visible: v } : pp
                            )
                          }
                        }))
                      }}
                    >
                      <option value="1">显示</option>
                      <option value="0">隐藏</option>
                    </select>
                  </div>

                  {/* 2026-09-01 翻转开关收进面板（B）：与工具栏同一语义，面板内可直接调 */}
                  <div className="form-row">
                    <label>翻转</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {(['flipX', 'flipY'] as const).map((axis) => {
                        const on = Boolean((activePlacement.transform as any)?.[axis])
                        return (
                          <button
                            key={axis}
                            type="button"
                            className={`btn secondary${on ? ' active' : ''}`}
                            style={on ? { borderColor: '#5eccff', color: '#5eccff' } : undefined}
                            onClick={() =>
                              setNodeUndo((x) => ({
                                ...x,
                                visuals: {
                                  ...ensureNode(x).visuals,
                                  placements: (ensureNode(x).visuals?.placements || []).map((pp) =>
                                    pp.id === activePlacement.id
                                      ? { ...pp, transform: { ...pp.transform, [axis]: !Boolean((pp.transform as any)?.[axis]) } as any }
                                      : pp
                                  )
                                }
                              }))
                            }
                          >
                            {axis === 'flipX' ? '左右反转' : '上下反转'}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      className="btn secondary"
                      title="位置/缩放/角度/翻转恢复默认"
                      onClick={() => {
                        setNodeUndo((x) => ({
                          ...x,
                          visuals: {
                            ...ensureNode(x).visuals,
                            placements: (ensureNode(x).visuals?.placements || []).map((pp) =>
                              pp.id === activePlacement.id
                                ? { ...pp, transform: { x: 0.5, y: 1, scale: 1, rotationDeg: 0 } as any }
                                : pp
                            )
                          }
                        }))
                      }}
                    >
                      重置变换
                    </button>
                    <button
                      className="btn secondary"
                      onClick={() => {
                        setNodeUndo((x) => ({
                          ...x,
                          visuals: {
                            ...ensureNode(x).visuals,
                            placements: (ensureNode(x).visuals?.placements || []).filter((pp) => pp.id !== activePlacement.id)
                          }
                        }))
                        setActivePlacementId('')
                      }}
                    >
                      删除摆放
                    </button>
                  </div>

                  {/* 2026-09-01 调试区（B）：数据级排障入口——id/资产/transform 原文可复制 */}
                  <details style={{ marginTop: 10 }}>
                    <summary className="hint" style={{ cursor: 'pointer', fontSize: 11 }}>调试信息</summary>
                    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <pre
                        className="hint"
                        style={{ fontSize: 11, margin: 0, padding: 8, borderRadius: 8, background: 'rgba(0,0,0,0.25)', maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                      >{JSON.stringify(activePlacement, null, 2)}</pre>
                      <div>
                        <button
                          type="button"
                          className="btn secondary"
                          style={{ fontSize: 11, padding: '2px 10px' }}
                          onClick={() => {
                            try {
                              navigator.clipboard.writeText(JSON.stringify(activePlacement, null, 2))
                              setToast('已复制摆放数据')
                            } catch {
                              setToast('复制失败')
                            }
                          }}
                        >
                          复制 JSON
                        </button>
                      </div>
                    </div>
                  </details>
                </div>
              ) : null}
            </div>
                </div>
              ) : null}
            </div>
  )
}
