import type { NodeV1 } from '../../../api'
import type { EditorDoc } from '../types'
import { ensureNode } from '../orchestration/normalize'
import { defaultEndingCardForNode, normalizeAdvance } from '../orchestration/runtime'
import { uid } from '../orchestration/utils'
import type { ComposeRightFoldState } from './RightPanel'

export type NodeTimelineFoldProps = {
  n: NodeV1
  allNodes: NodeV1[]
  doc: EditorDoc
  rightFold: ComposeRightFoldState
  toggleRightFold: (key: keyof ComposeRightFoldState) => void
  setNode: (updater: (node: NodeV1) => NodeV1) => void
}

export function NodeTimelineFold(props: NodeTimelineFoldProps) {
  const {
    n,
    allNodes,
    doc,
    rightFold,
    toggleRightFold,
    setNode
  } = props

  return (
	            <div className="fold">
	              <div className="fold-head" onClick={() => toggleRightFold('timeline')}>
	                <div className="fold-title">时间线</div>
	                <div className="fold-actions" onClick={(e) => e.stopPropagation()}>
	                  <button
                    type="button"
                    className="icon-btn"
                    title={rightFold.timeline ? '折叠' : '展开'}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleRightFold('timeline')
                    }}
                  >
                    {rightFold.timeline ? '－' : '＋'}
                  </button>
                </div>
              </div>

              {rightFold.timeline ? (
                <div className="fold-body">
                  <div className="hint">节点内“PPT式”播放/触发：先执行动作（Actions），再按推进方式（Advance）进入下一步。</div>

            {(() => {
              const steps = Array.isArray(n.timeline?.steps) ? n.timeline.steps : []
              const stateVars = Array.isArray(doc.project?.state?.vars) ? doc.project.state.vars : []
              const eventMacros = Array.isArray(doc.project?.events) ? doc.project.events : []

              const updateSteps = (updater: (steps: any[]) => any[]) =>
                setNode((x) => {
                  const nn = ensureNode(x)
                  const curr = Array.isArray(nn.timeline?.steps) ? nn.timeline.steps : []
                  return { ...nn, timeline: { steps: updater(curr.slice()) } }
                })

              const makeDefaultAction = (type: string): any => {
                if (type === 'ui.setText') return { type: 'ui.setText', mode: 'replace', text: '' }
                if (type === 'ui.appendText') return { type: 'ui.appendText', text: '' }
                if (type === 'ui.clearText') return { type: 'ui.clearText' }
                if (type === 'ui.toast') return { type: 'ui.toast', text: '' }
                if (type === 'events.emit') return { type: 'events.emit', name: '' }
                if (type === 'event.call') return { type: 'event.call', eventId: eventMacros[0]?.id || '' }
                if (type === 'state.set') return { type: 'state.set', var: stateVars[0]?.name || '', value: '' }
                if (type === 'state.inc') return { type: 'state.inc', var: stateVars[0]?.name || '', value: 1 }
                if (type === 'state.toggle') return { type: 'state.toggle', var: stateVars[0]?.name || '' }
                if (type === 'state.tags.add') return { type: 'state.tags.add', var: stateVars[0]?.name || '', value: '' }
                if (type === 'state.tags.remove') return { type: 'state.tags.remove', var: stateVars[0]?.name || '', value: '' }
                if (type === 'flow.gotoNode') return { type: 'flow.gotoNode', nodeId: allNodes[0]?.id || '' }
                if (type === 'stage.setBackground') return { type: 'stage.setBackground', assetId: '' }
                if (type === 'ui.showEndingCard') return { type: 'ui.showEndingCard', card: defaultEndingCardForNode(n) }
                return { type }
              }

              const parseCondValue = (raw: string) => {
                const s = String(raw ?? '')
                if (s.trim().toLowerCase() === 'true') return true
                if (s.trim().toLowerCase() === 'false') return false
                const n = Number(s)
                if (Number.isFinite(n) && s.trim() !== '') return n
                return s
              }

              const renderActionEditor = (action: any, onChange: (next: any) => void) => {
                const type = String(action?.type || '')
                const actionTypes = [
                  'ui.setText',
                  'ui.appendText',
                  'ui.clearText',
                  'ui.toast',
                  'events.emit',
                  'event.call',
                  'state.set',
                  'state.inc',
                  'state.toggle',
                  'state.tags.add',
                  'state.tags.remove',
                  'flow.gotoNode',
                  'stage.setBackground',
                  ...(n.kind === 'ending' ? ['ui.showEndingCard'] : [])
                ]

                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div className="form-row">
                      <label>类型</label>
                      <select className="sel" value={type} onChange={(e) => onChange(makeDefaultAction(e.target.value))}>
                        {actionTypes.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </div>

                    {type === 'ui.setText' ? (
                      <>
                        <div className="form-row">
                          <label>模式</label>
                          <select className="sel" value={String(action?.mode || 'replace')} onChange={(e) => onChange({ ...action, mode: e.target.value })}>
                            <option value="replace">替换</option>
                            <option value="append">追加</option>
                          </select>
                        </div>
                        <div className="form-row">
                          <label>文本</label>
                          <textarea className="textarea" value={String(action?.text || '')} onChange={(e) => onChange({ ...action, text: e.target.value })} />
                        </div>
                      </>
                    ) : null}

                    {type === 'ui.appendText' ? (
                      <div className="form-row">
                        <label>文本</label>
                        <textarea className="textarea" value={String(action?.text || '')} onChange={(e) => onChange({ ...action, text: e.target.value })} />
                      </div>
                    ) : null}

                    {type === 'ui.toast' ? (
                      <div className="form-row">
                        <label>内容</label>
                        <input className="input" value={String(action?.text || '')} onChange={(e) => onChange({ ...action, text: e.target.value })} />
                      </div>
                    ) : null}

                    {type === 'events.emit' ? (
                      <div className="form-row">
                        <label>事件名</label>
                        <input className="input" value={String(action?.name || '')} onChange={(e) => onChange({ ...action, name: e.target.value })} placeholder="例如：ad_ready" />
                      </div>
                    ) : null}

                    {type === 'event.call' ? (
                      <div className="form-row">
                        <label>事件（宏）</label>
                        <select className="sel" value={String(action?.eventId || '')} onChange={(e) => onChange({ ...action, eventId: e.target.value })}>
                          <option value="">（未选择）</option>
                          {eventMacros.map((ev) => (
                            <option key={ev.id} value={ev.id}>
                              {ev.name || ev.id}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}

                    {type === 'state.set' ? (
                      <>
                        <div className="form-row">
                          <label>变量</label>
                          <input className="input" value={String(action?.var || '')} onChange={(e) => onChange({ ...action, var: e.target.value })} placeholder="例如：trust" />
                        </div>
                        <div className="form-row">
                          <label>值</label>
                          <input className="input" value={String(action?.value ?? '')} onChange={(e) => onChange({ ...action, value: e.target.value })} placeholder="字符串/数字/true/false" />
                        </div>
                      </>
                    ) : null}

                    {type === 'state.inc' ? (
                      <>
                        <div className="form-row">
                          <label>变量</label>
                          <input className="input" value={String(action?.var || '')} onChange={(e) => onChange({ ...action, var: e.target.value })} placeholder="例如：score" />
                        </div>
                        <div className="form-row">
                          <label>增量</label>
                          <input
                            className="input"
                            type="number"
                            value={String(Number.isFinite(Number(action?.value)) ? Number(action.value) : 1)}
                            onChange={(e) => onChange({ ...action, value: Number(e.target.value) })}
                          />
                        </div>
                      </>
                    ) : null}

                    {type === 'state.toggle' ? (
                      <div className="form-row">
                        <label>变量</label>
                        <input className="input" value={String(action?.var || '')} onChange={(e) => onChange({ ...action, var: e.target.value })} placeholder="例如：flag" />
                      </div>
                    ) : null}

                    {type === 'state.tags.add' || type === 'state.tags.remove' ? (
                      <>
                        <div className="form-row">
                          <label>变量（tags）</label>
                          <input className="input" value={String(action?.var || '')} onChange={(e) => onChange({ ...action, var: e.target.value })} placeholder="例如：tags" />
                        </div>
                        <div className="form-row">
                          <label>值</label>
                          <input className="input" value={String(action?.value || '')} onChange={(e) => onChange({ ...action, value: e.target.value })} placeholder="例如：lied" />
                        </div>
                      </>
                    ) : null}

                    {type === 'flow.gotoNode' ? (
                      <div className="form-row">
                        <label>跳转到</label>
                        <select className="sel" value={String(action?.nodeId || '')} onChange={(e) => onChange({ ...action, nodeId: e.target.value })}>
                          {allNodes.map((nn) => (
                            <option key={nn.id} value={nn.id}>
                              {nn.name || nn.id}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}

                    {type === 'stage.setBackground' ? (
                      <div className="form-row">
                        <label>背景资源</label>
                        <select className="sel" value={String(action?.assetId || '')} onChange={(e) => onChange({ ...action, assetId: e.target.value })}>
                          <option value="">（清除）</option>
                          {(doc.project?.assets || []).map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name || a.id}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}

                    {type === 'ui.showEndingCard' ? (
                      <>
                        <div className="form-row">
                          <label>标题</label>
                          <input
                            className="input"
                            value={String(action?.card?.title || '')}
                            onChange={(e) => onChange({ ...action, card: { ...(action?.card || {}), title: e.target.value } })}
                          />
                        </div>
                        <div className="form-row">
                          <label>结局文案</label>
                          <textarea
                            className="textarea"
                            value={String(action?.card?.moral || '')}
                            onChange={(e) => onChange({ ...action, card: { ...(action?.card || {}), moral: e.target.value } })}
                          />
                        </div>
                      </>
                    ) : null}
                  </div>
                )
              }

              const renderAdvanceEditor = (advanceIn: any, onChange: (next: any) => void) => {
                const adv = normalizeAdvance(advanceIn)
                const type = String((adv as any).type || 'auto')
                const setType = (t: string) => {
                  if (t === 'auto') return onChange({ type: 'auto' })
                  if (t === 'click') return onChange({ type: 'click' })
                  if (t === 'choice') return onChange({ type: 'choice' })
                  if (t === 'timer') return onChange({ type: 'timer', ms: 800 })
                  if (t === 'event') return onChange({ type: 'event', name: '' })
                  if (t === 'condition') return onChange({ type: 'condition', expr: { op: '==', left: { var: stateVars[0]?.name || 'flag' }, right: true }, pollMs: 200 })
                  if (t === 'end') return onChange({ type: 'end' })
                  return onChange({ type: t })
                }

                const expr = (adv as any).expr
                const pollMs = Number.isFinite(Number((adv as any).pollMs)) ? Number((adv as any).pollMs) : 200
                const op = String(expr && (expr as any).op || '==')
                const varName = String(expr && ((expr as any).var || (expr as any).left?.var) || '')
                const rhs =
                  op === 'tags.has'
                    ? String(expr && (expr as any).value || '')
                    : String(expr ? ((expr as any).right ?? '') : '')

                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div className="form-row">
                      <label>推进方式</label>
                      <select className="sel" value={type} onChange={(e) => setType(e.target.value)}>
                        <option value="auto">自动</option>
                        <option value="click">点击继续</option>
                        <option value="choice">分支选择</option>
                        <option value="timer">定时器</option>
                        <option value="event">等待事件</option>
                        <option value="condition">等待条件</option>
                        <option value="end">结束</option>
                      </select>
                    </div>

                    {type === 'timer' ? (
                      <div className="form-row">
                        <label>毫秒</label>
                        <input
                          className="input"
                          type="number"
                          value={String(Number.isFinite(Number((adv as any).ms)) ? Number((adv as any).ms) : 0)}
                          onChange={(e) => onChange({ ...adv, ms: Math.max(0, Math.floor(Number(e.target.value))) })}
                        />
                      </div>
                    ) : null}

                    {type === 'event' ? (
                      <div className="form-row">
                        <label>事件名</label>
                        <input className="input" value={String((adv as any).name || '')} onChange={(e) => onChange({ ...adv, name: e.target.value })} placeholder="例如：ad_ready" />
                      </div>
                    ) : null}

                    {type === 'condition' ? (
                      <>
                        <div className="form-row">
                          <label>变量</label>
                          <input className="input" value={varName} onChange={(e) => {
                            const v = e.target.value
                            const nextExpr = op === 'tags.has'
                              ? { op: 'tags.has', var: v, value: String((expr as any)?.value || '') }
                              : { op, left: { var: v }, right: parseCondValue(rhs) }
                            onChange({ ...adv, expr: nextExpr })
                          }} placeholder="例如：trust" />
                        </div>
                        <div className="form-row">
                          <label>运算</label>
                          <select className="sel" value={op} onChange={(e) => {
                            const nextOp = e.target.value
                            const nextExpr = nextOp === 'tags.has'
                              ? { op: 'tags.has', var: varName, value: String(rhs || '') }
                              : { op: nextOp, left: { var: varName }, right: parseCondValue(rhs) }
                            onChange({ ...adv, expr: nextExpr })
                          }}>
                            <option value="==">==</option>
                            <option value="!=">!=</option>
                            <option value="<">&lt;</option>
                            <option value="<=">&lt;=</option>
                            <option value=">">&gt;</option>
                            <option value=">=">&gt;=</option>
                            <option value="tags.has">tags.has</option>
                          </select>
                        </div>
                        <div className="form-row">
                          <label>值</label>
                          <input className="input" value={rhs} onChange={(e) => {
                            const v = e.target.value
                            const nextExpr = op === 'tags.has'
                              ? { op: 'tags.has', var: varName, value: v }
                              : { op, left: { var: varName }, right: parseCondValue(v) }
                            onChange({ ...adv, expr: nextExpr })
                          }} placeholder="数字/true/false/字符串" />
                        </div>
                        <div className="form-row">
                          <label>轮询（ms）</label>
                          <input className="input" type="number" value={String(pollMs)} onChange={(e) => onChange({ ...adv, pollMs: Math.max(50, Math.floor(Number(e.target.value) || 200)) })} />
                        </div>
                      </>
                    ) : null}
                  </div>
                )
              }

              return (
                <div className="form" style={{ gap: 10 }}>
                  {steps.map((st, idx) => (
                    <div key={st.id} style={{ border: '1px solid rgba(148,163,184,0.16)', borderRadius: 14, padding: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                        <div style={{ fontWeight: 800 }}>步骤 {idx + 1}</div>
                        <div className="script-item-actions">
                          <button className="icon-btn" title="上移" disabled={idx === 0} onClick={() => updateSteps((arr) => {
                            const a = arr.slice()
                            const tmp = a[idx - 1]
                            a[idx - 1] = a[idx]
                            a[idx] = tmp
                            return a
                          })}>↑</button>
                          <button className="icon-btn" title="下移" disabled={idx === steps.length - 1} onClick={() => updateSteps((arr) => {
                            const a = arr.slice()
                            const tmp = a[idx + 1]
                            a[idx + 1] = a[idx]
                            a[idx] = tmp
                            return a
                          })}>↓</button>
                          <button className="icon-btn danger" title="删除步骤" disabled={steps.length <= 1} onClick={() => updateSteps((arr) => arr.filter((_, i) => i !== idx))}>✕</button>
                        </div>
                      </div>

                      <div className="hr" />

                      <div style={{ fontWeight: 700, fontSize: 12, opacity: 0.9 }}>动作</div>
                      <div className="form" style={{ gap: 8 }}>
                        {(Array.isArray(st.actions) ? st.actions : []).map((a: any, ai: number) => (
                          <div key={`${st.id}_a_${ai}`} style={{ border: '1px solid rgba(148,163,184,0.14)', borderRadius: 12, padding: 10 }}>
                            {renderActionEditor(a, (nextA) =>
                              updateSteps((arr) => {
                                const next = arr.slice()
                                const ss = { ...next[idx] }
                                const acts = Array.isArray(ss.actions) ? ss.actions.slice() : []
                                acts[ai] = nextA
                                ss.actions = acts
                                next[idx] = ss
                                return next
                              })
                            )}
                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                              <button
                                className="btn secondary"
                                onClick={() =>
                                  updateSteps((arr) => {
                                    const next = arr.slice()
                                    const ss = { ...next[idx] }
                                    const acts = Array.isArray(ss.actions) ? ss.actions.slice() : []
                                    ss.actions = acts.filter((_: any, j: number) => j !== ai)
                                    next[idx] = ss
                                    return next
                                  })
                                }
                              >
                                删除动作
                              </button>
                            </div>
                          </div>
                        ))}

                        <button
                          className="btn secondary"
                          onClick={() =>
                            updateSteps((arr) => {
                              const next = arr.slice()
                              const ss = { ...next[idx] }
                              const acts = Array.isArray(ss.actions) ? ss.actions.slice() : []
                              acts.push(makeDefaultAction('ui.setText'))
                              ss.actions = acts
                              next[idx] = ss
                              return next
                            })
                          }
                        >
                          + 添加动作
                        </button>
                      </div>

                      <div className="hr" />

                      <div style={{ fontWeight: 700, fontSize: 12, opacity: 0.9 }}>推进</div>
                      {renderAdvanceEditor(st.advance, (nextAdv) =>
                        updateSteps((arr) => {
                          const next = arr.slice()
                          next[idx] = { ...next[idx], advance: nextAdv }
                          return next
                        })
                      )}
                    </div>
                  ))}

                  <button
                    className="btn secondary"
                    onClick={() =>
                      updateSteps((arr) => [
                        ...arr,
                        {
                          id: uid('st'),
                          actions: [makeDefaultAction('ui.setText')],
                          advance: { type: 'click' }
                        }
                      ])
                    }
                  >
                    + 添加步骤
                  </button>
                </div>
              )
            })()}
	                </div>
	              ) : null}
	            </div>
  )
}
