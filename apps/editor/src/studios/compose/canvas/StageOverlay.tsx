import type { CSSProperties, Dispatch, MutableRefObject, SetStateAction } from 'react'
import {
  type ChoiceV1,
  type DialogPresetV1,
  type NodeV1,
  type ProjectEventV1,
  type StoryV1,
  type TimelineActionV1
} from '../../../api'
import type { EditorDoc, Selection } from '../types'
import {
  ensureNode,
  normalizeChoicesAlign,
  normalizeChoicesDirection,
  normalizeDialogPreset
} from '../orchestration/normalize'
import {
  applyTimelineAction,
  defaultEndingCardForNode,
  evalConditionExpr,
  type RuntimeState
} from '../orchestration/runtime'
import type { StageViewport } from '../orchestration/stageViewport'
import { clamp01, numberOr } from '../orchestration/utils'

export type StageOverlayProps = {
  doc: EditorDoc
  effectivePreviewNode: NodeV1
  stageViewport: StageViewport | null
  stageZoom: number
  stagePan: { x: number; y: number }
  canvasSize: { w: number; h: number }
  stageUiRef: MutableRefObject<HTMLDivElement | null>
  rt: RuntimeState
  setRt: Dispatch<SetStateAction<RuntimeState>>
  rtRef: MutableRefObject<RuntimeState>
  setSelection: Dispatch<SetStateAction<Selection>>
  setToast: Dispatch<SetStateAction<string>>
  setDocStory: (updater: (s: StoryV1) => StoryV1) => void
  clearRuntimeTimers: () => void
  restartRuntime: () => void
  runTimelineStable: (prev: RuntimeState, node: NodeV1) => RuntimeState
  dragDialogRef: MutableRefObject<{
    dragging: boolean
    pointerId: number
    stageW: number
    stageH: number
    deltaX: number
    deltaY: number
  } | null>
}

export function StageOverlay(props: StageOverlayProps) {
  const {
    doc,
    effectivePreviewNode,
    stageViewport,
    stageZoom,
    stagePan,
    canvasSize,
    stageUiRef,
    rt,
    setRt,
    rtRef,
    setSelection,
    setToast,
    setDocStory,
    clearRuntimeTimers,
    restartRuntime,
    runTimelineStable,
    dragDialogRef
  } = props

  return (
            <div
              className="stage-ui"
              ref={stageUiRef}
              style={
                stageViewport
                  ? (() => {
                      const z = Math.max(0.25, Math.min(4, Number(stageZoom) || 1))
                      const viewW = canvasSize.w || 0
                      const viewH = canvasSize.h || 0
                      const cx0 = viewW / 2
                      const cy0 = viewH / 2
                      const rx = cx0 + (stageViewport.offsetX - cx0) * z + stagePan.x
                      const ry = cy0 + (stageViewport.offsetY - cy0) * z + stagePan.y
                      return {
                        width: stageViewport.stageW,
                        height: stageViewport.stageH,
                        transform: `translate(${rx}px, ${ry}px) scale(${stageViewport.scale * z})`,
                        transformOrigin: '0 0'
                      }
                    })()
                  : { width: '100%', height: '100%' }
              }
            >
              <div className="compose-overlay">
              {(() => {
                const node = ensureNode(effectivePreviewNode)
                const showEnding = Boolean(rt.endingCard) || rt.wait.kind === 'end'

                const eventList = Array.isArray(doc.project?.events) ? doc.project.events : []

                const onContinue = () => {
                  if (rt.wait.kind !== 'click') return
                  clearRuntimeTimers()
                  setRt((prev) => runTimelineStable({ ...prev, stepIndex: prev.stepIndex + 1, wait: { kind: 'auto' } }, node))
                }

                const onChoose = (choice: ChoiceV1) => {
                  if (rt.wait.kind !== 'choice') return
                  const enabled = choice.enabledWhen ? evalConditionExpr(choice.enabledWhen, rt.vars) : true
                  if (!enabled) return

                  const base = rtRef.current
                  let next: RuntimeState = {
                    ...base,
                    vars: { ...base.vars },
                    eventMemory: { ...base.eventMemory },
                    stageOverride: { ...base.stageOverride },
                    nav: null
                  }
                  const effects = Array.isArray((choice as any).effects) ? ((choice as any).effects as TimelineActionV1[]) : []
                  for (const a of effects) {
                    next = applyTimelineAction(next, a as any, eventList, 0)
                    if (next.nav) break
                  }
                  setRt(next)
                  if (next.nav) return
                  const to = String(choice.toNodeId || '').trim()
                  if (!to) return
                  window.setTimeout(() => setSelection({ type: 'node', id: to }), 200)
                }

                const card = showEnding ? (rt.endingCard || (node.kind === 'ending' ? defaultEndingCardForNode(node) : null)) : null

                const dialogPreset = normalizeDialogPreset((node as any)?.visuals?.ui?.dialog?.preset)
                const dialogX = clamp01(numberOr((node as any)?.visuals?.ui?.dialog?.x, 0.5))
                const dialogY = clamp01(numberOr((node as any)?.visuals?.ui?.dialog?.y, 0.88))
                // 对话框底板透明度（节点级，缺省 1）：与导出运行时 storyPixi.js 同一比例（card 0.74×op、textBox 0.35×op）
                const dialogOpacity = Math.max(0, Math.min(1, numberOr((node as any)?.visuals?.ui?.dialog?.opacity, 1)))
                const dialogCardBg = `rgba(2, 6, 23, ${(0.74 * dialogOpacity).toFixed(3)})`
                const dialogTextBg = `rgba(2, 6, 23, ${(0.35 * dialogOpacity).toFixed(3)})`
                const choicesDir = normalizeChoicesDirection((node as any)?.visuals?.ui?.choices?.direction)
                const choicesAlign = normalizeChoicesAlign((node as any)?.visuals?.ui?.choices?.align)

                const dialogWrapStyle: CSSProperties = (() => {
                  if (dialogPreset === 'custom') {
                    return { position: 'absolute', inset: 0, padding: 0, pointerEvents: 'none' }
                  }
                  const base: CSSProperties = {
                    position: 'absolute',
                    inset: 0,
                    padding: 18,
                    boxSizing: 'border-box',
                    display: 'flex',
                    pointerEvents: 'none'
                  }
                  if (dialogPreset === 'top') return { ...base, justifyContent: 'center', alignItems: 'flex-start' }
                  if (dialogPreset === 'center') return { ...base, justifyContent: 'center', alignItems: 'center' }
                  if (dialogPreset === 'left') return { ...base, justifyContent: 'flex-start', alignItems: 'center' }
                  if (dialogPreset === 'right') return { ...base, justifyContent: 'flex-end', alignItems: 'center' }
                  return { ...base, justifyContent: 'center', alignItems: 'flex-end' }
                })()

                const dialogCardStyle: CSSProperties =
                  dialogPreset === 'custom' && stageViewport
                    ? {
                        position: 'absolute',
                        left: stageViewport.stageW * dialogX,
                        top: stageViewport.stageH * dialogY,
                        transform: 'translate(-50%, -50%)',
                        background: dialogCardBg
                      }
                    : dialogPreset === 'bottom'
                      ? {} // 字幕式：bottom 预设不上任何底色/暗幕，文字直接显示在画面上
                      : { background: dialogCardBg }

                const choicesStyle: CSSProperties = (() => {
                  if (choicesDir !== 'column') {
                    // 2026-09-30 字幕式：bottom 预设选项按钮一律右下（用户定稿），其他预设保持右对齐
                    return { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end' }
                  }
                  const ai =
                    choicesAlign === 'start'
                      ? 'flex-start'
                      : choicesAlign === 'center'
                        ? 'center'
                        : choicesAlign === 'stretch'
                          ? 'stretch'
                          : 'flex-end'
                  return { flexDirection: 'column', flexWrap: 'nowrap', alignItems: ai, justifyContent: 'flex-end' }
                })()

                const displayText = (() => {
                  const t = String(rt.text || '')
                  const raw = t.trim() ? t : String((node as any)?.body?.text || '')
                  // Runtime text should not repeat "选项1/选项2" lines; buttons already render choices.
                  const lines = String(raw).split(/\r?\n/)
                  return lines
                    .filter((original) => !/^\s*(?:选项|option)\s*(?:\d{1,2}|[A-Z]|[一二三四五六七八九十])\s*[:：]/i.test(original))
                    .map((ln) => ln.trim())
                    .filter(Boolean)
                    .join('\n')
                })()
                const hasText = String(displayText || '').trim().length > 0

                const setDialogUi = (next: { preset?: DialogPresetV1; x?: number; y?: number }) => {
                  if (doc.readonly) return
                  setDocStory((s) => ({
                    ...s,
                    nodes: (s.nodes || []).map((n) => {
                      if (n.id !== node.id) return n
                      const nn = ensureNode(n)
                      const visuals = nn.visuals || {}
                      const ui = (visuals as any).ui && typeof (visuals as any).ui === 'object' ? (visuals as any).ui : {}
                      const dialog = ui.dialog && typeof ui.dialog === 'object' ? ui.dialog : { preset: 'bottom', x: 0.5, y: 0.88 }
                      const merged = { ...dialog, ...next }
                      return { ...nn, visuals: { ...visuals, ui: { ...ui, dialog: merged } } }
                    })
                  }))
                }

                const startDragDialog = (e: React.PointerEvent) => {
                  if (!stageViewport) return
                  if (dialogPreset !== 'custom') return
                  const uiRect = stageUiRef.current?.getBoundingClientRect()
                  if (!uiRect || !uiRect.width || !uiRect.height) return

                  const cardEl = (e.currentTarget as HTMLElement)?.closest('.dialog-card') as HTMLElement | null
                  if (!cardEl) return
                  const cardRect = cardEl.getBoundingClientRect()
                  if (!cardRect.width || !cardRect.height) return

                  const scale = stageViewport.scale || 1
                  const pointerStageX = (e.clientX - uiRect.left) / scale
                  const pointerStageY = (e.clientY - uiRect.top) / scale
                  const cardCenterStageX = (cardRect.left + cardRect.width / 2 - uiRect.left) / scale
                  const cardCenterStageY = (cardRect.top + cardRect.height / 2 - uiRect.top) / scale

                  const deltaX = pointerStageX - cardCenterStageX
                  const deltaY = pointerStageY - cardCenterStageY

                  dragDialogRef.current = {
                    dragging: true,
                    pointerId: e.pointerId,
                    stageW: stageViewport.stageW,
                    stageH: stageViewport.stageH,
                    deltaX,
                    deltaY
                  }

                  try {
                    ;(e.currentTarget as any).setPointerCapture?.(e.pointerId)
                  } catch {}

                  e.preventDefault()
                  e.stopPropagation()
                }

                const onDragDialogMove = (e: React.PointerEvent) => {
                  const st = dragDialogRef.current
                  if (!st || !st.dragging || st.pointerId !== e.pointerId) return
                  const uiRect = stageUiRef.current?.getBoundingClientRect()
                  if (!uiRect) return
                  const scale = stageViewport?.scale || 1
                  const pointerStageX = (e.clientX - uiRect.left) / scale
                  const pointerStageY = (e.clientY - uiRect.top) / scale
                  const cx = pointerStageX - st.deltaX
                  const cy = pointerStageY - st.deltaY
                  const x = clamp01(cx / st.stageW)
                  const y = clamp01(cy / st.stageH)
                  setDialogUi({ preset: 'custom', x, y })
                  e.preventDefault()
                }

                const endDragDialog = (e: React.PointerEvent) => {
                  const st = dragDialogRef.current
                  if (!st || st.pointerId !== e.pointerId) return
                  dragDialogRef.current = null
                  try {
                    ;(e.currentTarget as any).releasePointerCapture?.(e.pointerId)
                  } catch {}
                  e.preventDefault()
                }

                return showEnding ? (
                  <div style={dialogWrapStyle}>
                    <div className={`dialog-card ${dialogPreset === 'bottom' ? 'subtitle' : ''}`} style={dialogCardStyle}>
                      {card?.bullets?.length ? (
                        <ul className="ending-bullets">
                          {card.bullets.map((b, i) => (
                            <li key={String(i)}>{b}</li>
                          ))}
                        </ul>
                      ) : null}
                      <div className="dialog-text" style={{ background: dialogTextBg }}>{card?.moral || '故事结束。'}</div>
                      <div className={`dialog-choices ${choicesDir === 'column' ? 'vertical' : ''}`} style={choicesStyle}>
                        {(card?.buttons || [])
                          .filter((b) => String((b as any).type || '') !== 'backToHub')
                          .map((b, i) => {
                            const bt = String((b as any).type || '')
                            const label = String((b as any).label || '')
                            const key = `${bt}_${i}`
                            if (bt === 'restart') {
                              return (
                                <button
                                  key={key}
                                  className="choice-btn"
                                  onClick={() => restartRuntime()}
                                  style={choicesDir === 'column' && choicesAlign === 'stretch' ? { width: '100%' } : undefined}
                                >
                                  {label || '重新开始'}
                                </button>
                              )
                            }
                            return (
                              <button
                                key={key}
                                className="choice-btn"
                                onClick={() => setToast(label || '未实现按钮')}
                                style={choicesDir === 'column' && choicesAlign === 'stretch' ? { width: '100%' } : undefined}
                              >
                                {label || '按钮'}
                              </button>
                            )
                          })}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={dialogWrapStyle}>
                    <div className={`dialog-card ${dialogPreset === 'bottom' ? 'subtitle' : ''}`} style={dialogCardStyle}>
                    <div
                      className={`dialog-meta ${dialogPreset === 'custom' ? 'drag-handle' : ''}`}
                      title={dialogPreset === 'custom' ? '拖动定位对话框' : undefined}
                      onPointerDown={dialogPreset === 'custom' ? startDragDialog : undefined}
                      onPointerMove={dialogPreset === 'custom' ? onDragDialogMove : undefined}
                      onPointerUp={dialogPreset === 'custom' ? endDragDialog : undefined}
                      onPointerCancel={dialogPreset === 'custom' ? endDragDialog : undefined}
                    >
                      {String((node as any).body?.title || '').trim() ? (
                        <span className="dialog-node">{String((node as any).body?.title || '').trim()}</span>
                      ) : null}
                      {rt.wait.kind === 'timer' ? <span className="dialog-wait">自动推进…</span> : null}
                      {rt.wait.kind === 'event' ? <span className="dialog-wait">等待事件：{rt.wait.name || '（未命名）'}</span> : null}
                      {rt.wait.kind === 'condition' ? <span className="dialog-wait">等待条件成立…</span> : null}
                    </div>

                    {hasText ? <div className="dialog-text" style={dialogPreset === 'bottom' ? undefined : { background: dialogTextBg }}>{displayText}</div> : null}

                    {rt.wait.kind === 'choice' ? (
                      <div className={`dialog-choices ${choicesDir === 'column' ? 'vertical' : ''}`} style={choicesStyle}>
                        {(Array.isArray(node.choices) ? node.choices : [])
                          .filter((c) => (c.visibleWhen ? evalConditionExpr(c.visibleWhen, rt.vars) : true))
                          .map((c) => {
                            const enabled = c.enabledWhen ? evalConditionExpr(c.enabledWhen, rt.vars) : true
                            return (
                              <button
                                key={c.id}
                                className={`choice-btn ${enabled ? '' : 'disabled'}`}
                                onClick={() => onChoose(c)}
                                disabled={!enabled}
                                style={choicesDir === 'column' && choicesAlign === 'stretch' ? { width: '100%' } : undefined}
                              >
                                {c.text || '选择'}
                              </button>
                            )
                          })}
                      </div>
                    ) : null}

                    {rt.wait.kind === 'click' ? (
                      <div className="dialog-actions">
                        <button className="btn" onClick={onContinue}>
                          继续
                        </button>
                      </div>
                    ) : null}
                    </div>
                  </div>
                )
              })()}

              {rt.toast ? <div className="runtime-toast">{rt.toast}</div> : null}
              </div>
            </div>
  )
}
