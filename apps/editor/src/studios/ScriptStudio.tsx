import { useEffect, useMemo, useRef, useState } from 'react'
import {
  compileBlueprintDetailed,
  getProject,
  getScripts,
  getCachedBlueprintReview,
  reviewBlueprintWithAi,
  fixScriptsWithAi,
  saveProject,
  saveScripts,
  type BlueprintCompileResult,
  type ScriptCardV1,
  type ScriptDocV1
} from '../api'

type Props = {
  projectId: string
  onBack: () => void
  onNext: () => void
}

function uid(prefix = 'sc') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function sortCards(cards: ScriptCardV1[]) {
  return cards.slice().sort((a, b) => Number(a.order) - Number(b.order))
}

function StoryRail(props: {
  ids: string[]
  activeId: string
  onSelect: (id: string) => void
}) {
  const { ids, activeId, onSelect } = props
  if (!ids.length) return null
  return (
    <div className="story-rail" aria-label="故事线侧栏（只读）">
      <div className="story-rail-title">故事线</div>
      <div className="story-rail-track" role="list">
        {ids.map((id, idx) => (
          <button
            key={id}
            type="button"
            className={`story-rail-dot ${id === activeId ? 'active' : ''}`}
            title={`第 ${idx + 1}/${ids.length} 段`}
            aria-label={`选择第 ${idx + 1}/${ids.length} 段`}
            onClick={() => onSelect(id)}
          />
        ))}
      </div>
    </div>
  )
}

export default function ScriptStudio(props: Props) {
  const [scripts, setScripts] = useState<ScriptDocV1 | null>(null)
  const [selectedId, setSelectedId] = useState<string>('')
  const [projectTitle, setProjectTitle] = useState<string>('')
  const [projectTitleDirty, setProjectTitleDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [compileModalOpen, setCompileModalOpen] = useState(false)
  const [compileResult, setCompileResult] = useState<BlueprintCompileResult | null>(null)
  const [aiReviewBusy, setAiReviewBusy] = useState(false)
  const [aiReviewErr, setAiReviewErr] = useState('')
  const [aiReviewText, setAiReviewText] = useState('')
  const [aiFixBusy, setAiFixBusy] = useState(false)
  const [aiFixErr, setAiFixErr] = useState('')
  const [aiFixNote, setAiFixNote] = useState('')

  const cards = useMemo(() => (scripts ? sortCards(scripts.cards || []) : []), [scripts])
  const selected = useMemo(() => cards.find((c) => c.id === selectedId) || null, [cards, selectedId])
  const cardEls = useRef<Record<string, HTMLDivElement | null>>({})

  async function load() {
    setBusy(true)
    setError('')
    try {
      const [p, s] = await Promise.all([getProject(props.projectId), getScripts(props.projectId)])
      setScripts(s)
      setProjectTitle(String(p.project?.title || ''))
      setProjectTitleDirty(false)
      const first = (s.cards || []).slice().sort((a, b) => a.order - b.order)[0]
      setSelectedId(first ? first.id : '')
      setDirty(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectId])

  function mutate(updater: (draft: ScriptDocV1) => ScriptDocV1) {
    setScripts((prev) => (prev ? updater(prev) : prev))
    setDirty(true)
  }

  async function save() {
    if (!scripts) return
    setBusy(true)
    setError('')
    try {
      if (projectTitleDirty) {
        await saveProject(props.projectId, { project: { title: projectTitle } })
        setProjectTitleDirty(false)
      }
      const next = await saveScripts(props.projectId, scripts)
      setScripts(next)
      setDirty(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function addScript() {
    mutate((d) => {
      const maxOrder = d.cards.reduce((m, c) => Math.max(m, Number(c.order) || 0), 0)
      const card: ScriptCardV1 = {
        id: uid('sc'),
        name: `场景${d.cards.length + 1}`,
        order: maxOrder + 1,
        text: '',
        updatedAt: new Date().toISOString()
      }
      const next = { ...d, cards: [...d.cards, card], updatedAt: new Date().toISOString() }
      setSelectedId(card.id)
      return next
    })
  }

  function deleteScript(id: string) {
    if (!scripts) return
    if (!window.confirm('确定删除该场景？')) return

    mutate((d) => {
      const nextCards = d.cards.filter((c) => c.id !== id)
      const next = { ...d, cards: nextCards, updatedAt: new Date().toISOString() }
      const first = sortCards(nextCards)[0]
      setSelectedId(first ? first.id : '')
      return next
    })
  }

  function move(id: string, dir: -1 | 1) {
    if (!scripts) return

    mutate((d) => {
      const sorted = sortCards(d.cards)
      const idx = sorted.findIndex((c) => c.id === id)
      const j = idx + dir
      if (idx < 0 || j < 0 || j >= sorted.length) return d

      const a = sorted[idx]
      const b = sorted[j]

      // swap order
      const nextCards = d.cards.map((c) => {
        if (c.id === a.id) return { ...c, order: b.order }
        if (c.id === b.id) return { ...c, order: a.order }
        return c
      })
      return { ...d, cards: nextCards, updatedAt: new Date().toISOString() }
    })
  }

  async function next() {
    if (!scripts) return

    if (dirty) {
      const ok = window.confirm('场景列表有未保存的修改，是否先保存？')
      if (ok) await save()
    }

    setBusy(true)
    setError('')
    try {
      const res = await compileBlueprintDetailed(props.projectId)
      setCompileResult(res)
      setAiReviewBusy(false)
      setAiReviewErr('')
      setAiReviewText('')
      setCompileModalOpen(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!compileModalOpen) return
    // Load cached AI review (if any) so user can see last explanation without re-running.
    void (async () => {
      try {
        const cached = await getCachedBlueprintReview(props.projectId)
        if (!cached || !cached.review) return
        const review = cached.review as any
        const meta = (cached.meta as any) || null
        const lines: string[] = []
        if (cached.updatedAt) lines.push(`缓存时间：${String(cached.updatedAt)}`)
        if (cached.scriptsUpdatedAt) lines.push(`对应脚本更新时间：${String(cached.scriptsUpdatedAt)}`)
        if (meta) lines.push(`来源：${meta.provider || 'unknown'}${meta.model ? ` / ${meta.model}` : ''}${meta.durationMs != null ? ` / ${meta.durationMs}ms` : ''}`)
        lines.push('')
        lines.push(`结论：${review?.summary || ''}`)
        if (Array.isArray(review?.rootCauses) && review.rootCauses.length) {
          lines.push('')
          lines.push('原因：')
          for (const x of review.rootCauses) lines.push(`- ${x}`)
        }
        if (Array.isArray(review?.userFacingExplanation) && review.userFacingExplanation.length) {
          lines.push('')
          lines.push('解释：')
          for (const x of review.userFacingExplanation) lines.push(`- ${x}`)
        }
        if (Array.isArray(review?.suggestedEdits) && review.suggestedEdits.length) {
          lines.push('')
          lines.push('建议修改：')
          for (const e of review.suggestedEdits) {
            lines.push(`- ${e.target}：${e.change}`)
            if (e.example) lines.push(`  例：${e.example}`)
          }
        }
        setAiReviewText(lines.join('\n').trim())
      } catch (_) {}
    })()
  }, [compileModalOpen, props.projectId])

  return (
    <div className="app">
      <div className="topbar">
        <div className="left">
          <div className="title">第一层 · 分镜</div>
          <button className="btn secondary" onClick={props.onBack} disabled={busy}>
            返回工作台
          </button>
        </div>
        <div className="right">
          {dirty || projectTitleDirty ? (
            <div className="hint" style={{ color: '#fde68a' }}>未保存</div>
          ) : (
            <div className="hint">已保存</div>
          )}
          <button className="btn" onClick={() => save()} disabled={busy || (!dirty && !projectTitleDirty) || !scripts}>
            保存
          </button>
          <button className="btn secondary" onClick={() => next()} disabled={busy || !scripts}>
            下一步：进入蓝图
          </button>
        </div>
      </div>

      <div className="main">
        <div className="panel">
          <div className="section">
            <div style={{ fontWeight: 700, marginBottom: 8 }}>场景列表</div>
            <div className="hint">左侧只管理结构（增删/排序/选择）。</div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              <button className="btn secondary" onClick={() => addScript()} disabled={busy || !scripts}>
                + 新建场景
              </button>
            </div>

            <div className="hr" />

            <div className="list">
              {cards.map((c) => (
                <div
                  key={c.id}
                  className={`item ${selectedId === c.id ? 'active' : ''}`}
                  onClick={() => setSelectedId(c.id)}
                  title={c.name || c.id}
                >
                  <div className="script-item-row">
                    <div className="script-item-order">#{c.order}</div>
                    <div className="script-item-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          move(c.id, -1)
                        }}
                        disabled={busy}
                        title="上移"
                        aria-label="上移"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                          <path d="M12 5l-7 7h4v7h6v-7h4l-7-7z" fill="currentColor" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          move(c.id, 1)
                        }}
                        disabled={busy}
                        title="下移"
                        aria-label="下移"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                          <path d="M12 19l7-7h-4V5H9v7H5l7 7z" fill="currentColor" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="icon-btn danger"
                        onClick={(e) => {
                          e.stopPropagation()
                          deleteScript(c.id)
                        }}
                        disabled={busy}
                        title="删除"
                        aria-label="删除"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                          <path
                            d="M9 3h6l1 2h5v2H3V5h5l1-2zm1 7h2v9h-2v-9zm4 0h2v9h-2v-9zM7 10h2v9H7v-9z"
                            fill="currentColor"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {!cards.length ? <div className="hint">暂无场景</div> : null}
            </div>

            {error ? <div style={{ marginTop: 10, color: '#fca5a5' }}>{error}</div> : null}
          </div>
        </div>

        <div className="canvas">
            <div className="canvas-wrap">
            <div className="canvas-scroll">
              <div className="script-canvas-layout">
                <div className="script-card-list">
                  {cards.map((c) => {
                    const idx = cards.findIndex((x) => x.id === c.id)
                    return (
                      <div
                        key={c.id}
                        ref={(el) => {
                          cardEls.current[c.id] = el
                        }}
                        className={`card script-card ${selectedId === c.id ? 'active' : ''}`}
                        onClick={() => setSelectedId(c.id)}
                      >
                        <div className="card-title">{c.name || '未命名场景'}</div>
                        <div className="mini-graph-caption">第 {Math.max(1, idx + 1)}/{Math.max(1, cards.length)} 段</div>
                        <div className="mini-readonly-text">{String(c.text || '').trim() || '（空）'}</div>
                      </div>
                    )
                  })}
                </div>

                <StoryRail
                  ids={cards.map((x) => x.id)}
                  activeId={selectedId}
                  onSelect={(id) => {
                    setSelectedId(id)
                    const el = cardEls.current[id]
                    try {
                      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    } catch {
                      el?.scrollIntoView()
                    }
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="panel right script-panel-right">
          <div className="section script-right">
            <div className="section-title">故事</div>

            <div className="hr" />

            <div className="form" style={{ marginBottom: 12 }}>
              <div className="form-row no-label">
                <input
                  className="input"
                  value={projectTitle}
                  onChange={(e) => {
                    setProjectTitle(e.target.value)
                    setProjectTitleDirty(true)
                  }}
                  placeholder="故事名称"
                  aria-label="故事名称"
                  disabled={busy}
                />
              </div>
            </div>

            <div className="section-title">场景</div>

            {!selected ? (
              <div className="hint">请选择一个场景</div>
            ) : (
              <div className="form script-form">
                <div className="form-row">
                  <input
                    className="input"
                    value={selected.name}
                    aria-label="场景名称"
                    onChange={(e) =>
                      mutate((d) => ({
                        ...d,
                        cards: d.cards.map((c) => (c.id === selected.id ? { ...c, name: e.target.value } : c)),
                        updatedAt: new Date().toISOString()
                      }))
                    }
                    placeholder="场景名称"
                  />
                </div>

                <div className="form-row grow">
                  <label>文本</label>
                  <textarea
                    className="textarea"
                    value={selected.text}
                    onChange={(e) =>
                      mutate((d) => ({
                        ...d,
                        cards: d.cards.map((c) => (c.id === selected.id ? { ...c, text: e.target.value } : c)),
                        updatedAt: new Date().toISOString()
                      }))
                    }
                    placeholder="写这个分镜发生了什么（纯文本/markdown）"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {compileModalOpen && compileResult ? (
        <div className="ai-modal" role="dialog" aria-modal="true" aria-label="解析脚本并生成蓝图">
          <div className="ai-modal-card" style={{ width: 860, maxHeight: 'calc(100vh - 24px)' }}>
            <div className="ai-modal-title">解析脚本 → 生成蓝图</div>
            <div className="hint" style={{ marginBottom: 10 }}>
              处理内容：识别选择点（选项1/2/3…）→ 识别后果卡（i后果k）→ 生成分支跳转与收束 → 校验可达性与结局。
            </div>

            {compileResult.report?.warnings?.length ? (
              <div style={{ marginBottom: 10 }}>
                <div className="hint" style={{ fontWeight: 700, marginBottom: 6, color: '#fde68a' }}>编译提示</div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {compileResult.report.warnings.slice(0, 20).map((w: any, idx: number) => (
                    <div key={idx} className="hint" style={{ color: '#fde68a' }}>
                      • {String(w?.message || w?.code || 'warning')}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {compileResult.validation && compileResult.validation.ok === false ? (
              <div style={{ marginBottom: 10 }}>
                <div className="hint" style={{ fontWeight: 700, marginBottom: 6, color: '#fca5a5' }}>校验失败</div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {(compileResult.validation.errors || []).slice(0, 20).map((e: any, idx: number) => (
                    <div key={idx} className="hint" style={{ color: '#fca5a5' }}>
                      • {String(e?.message || e?.code || 'error')}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {compileResult.validation?.warnings?.length ? (
              <div style={{ marginBottom: 10 }}>
                <div className="hint" style={{ fontWeight: 700, marginBottom: 6, color: '#fde68a' }}>校验提示</div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {compileResult.validation.warnings.slice(0, 20).map((w: any, idx: number) => (
                    <div key={idx} className="hint" style={{ color: '#fde68a' }}>
                      • {String(w?.message || w?.code || 'warning')}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {compileResult.validation?.ok ? (
              <div className="hint" style={{ marginBottom: 10, color: '#a7f3d0' }}>
                校验通过：蓝图可执行（节点 {compileResult.validation?.stats?.nodes ?? '-'}，可达 {compileResult.validation?.stats?.reachable ?? '-'}）。
              </div>
            ) : null}

            <div className="hr" />
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
              <div className="hint" style={{ fontWeight: 700 }}>AI 解释与建议</div>
                <button
                  className="btn secondary"
                  onClick={async () => {
                    setAiReviewBusy(true)
                    setAiReviewErr('')
                    setAiReviewText('')
                    try {
                      const res = await reviewBlueprintWithAi(props.projectId)
                      const lines: string[] = []
                      lines.push(`来源：${res.meta?.provider || 'unknown'}${res.meta?.model ? ` / ${res.meta.model}` : ''}${res.meta?.durationMs != null ? ` / ${res.meta.durationMs}ms` : ''}`)
                      lines.push('')
                      lines.push(`结论：${res.review?.summary || ''}`)
                    if (res.review?.rootCauses?.length) {
                      lines.push('')
                      lines.push('原因：')
                      for (const x of res.review.rootCauses) lines.push(`- ${x}`)
                    }
                    if (res.review?.userFacingExplanation?.length) {
                      lines.push('')
                      lines.push('解释：')
                      for (const x of res.review.userFacingExplanation) lines.push(`- ${x}`)
                    }
                    if (res.review?.suggestedEdits?.length) {
                      lines.push('')
                      lines.push('建议修改：')
                      for (const e of res.review.suggestedEdits) {
                        lines.push(`- ${e.target}：${e.change}`)
                        if (e.example) lines.push(`  例：${e.example}`)
                      }
                    }
                    setAiReviewText(lines.join('\n').trim())
                  } catch (e) {
                    setAiReviewErr(e instanceof Error ? e.message : String(e))
                  } finally {
                    setAiReviewBusy(false)
                  }
                }}
                disabled={busy || aiReviewBusy}
                title="让 AI 基于脚本+公式+编译/校验结果解释原因并给出修改建议"
              >
                {aiReviewBusy ? '分析中…' : 'AI 解释原因'}
              </button>
              <button
                className="btn secondary"
                onClick={async () => {
                  if (!scripts) return
                  setAiFixErr('')
                  setAiFixNote('')

                  if (dirty || projectTitleDirty) {
                    const ok = window.confirm('脚本或标题有未保存修改。为避免 AI 基于旧内容修复，是否先保存？')
                    if (!ok) return
                    await save()
                    if (dirty || projectTitleDirty) return
                  }

                  const ok = window.confirm('将调用 AI 自动修复脚本中的结构问题（会覆盖脚本内容，并同步更新蓝图文件）。是否继续？')
                  if (!ok) return

                  setAiFixBusy(true)
                  try {
                    const res = await fixScriptsWithAi(props.projectId)
                    setScripts(res.scripts)
                    setDirty(false)

                    const nextCards = (res.scripts.cards || []).slice().sort((a, b) => a.order - b.order)
                    if (!nextCards.find((c) => c.id === selectedId)) {
                      setSelectedId(nextCards[0] ? nextCards[0].id : '')
                    }

                    if (res.after && res.after.blueprint) {
                      setCompileResult({
                        blueprint: res.after.blueprint,
                        report: (res.after.report as any) || null,
                        validation: (res.after.validation as any) || null
                      })
                    }

                    setAiReviewBusy(false)
                    setAiReviewErr('')
                    setAiReviewText('')
                    const beforeUnreachable = (() => {
                      const ws = (res.before && (res.before as any).validation && (res.before as any).validation.warnings) || []
                      const w = Array.isArray(ws) ? ws.find((x: any) => String(x && x.code || '') === 'unreachable_nodes') : null
                      const ids = w && w.detail && Array.isArray(w.detail.ids) ? w.detail.ids : []
                      return Array.isArray(ids) ? ids.length : 0
                    })()
                    const afterUnreachable = (() => {
                      const ws = (res.after && (res.after as any).validation && (res.after as any).validation.warnings) || []
                      const w = Array.isArray(ws) ? ws.find((x: any) => String(x && x.code || '') === 'unreachable_nodes') : null
                      const ids = w && w.detail && Array.isArray(w.detail.ids) ? w.detail.ids : []
                      return Array.isArray(ids) ? ids.length : 0
                    })()
                    const reachDelta = `不可达节点 ${beforeUnreachable} → ${afterUnreachable}`
                    setAiFixNote(
                      `已应用 AI 修复：${res.meta?.provider || 'unknown'}${res.meta?.model ? ` / ${res.meta.model}` : ''}${res.meta?.durationMs != null ? ` / ${res.meta.durationMs}ms` : ''}（${reachDelta}）`
                    )
                  } catch (e) {
                    setAiFixErr(e instanceof Error ? e.message : String(e))
                  } finally {
                    setAiFixBusy(false)
                  }
                }}
                disabled={busy || aiReviewBusy || aiFixBusy}
                title="让 AI 基于编译/校验反馈自动修复脚本，并重新编译蓝图"
              >
                {aiFixBusy ? '修复中…' : 'AI 修复问题'}
              </button>
            </div>
            {aiFixErr ? <div style={{ marginBottom: 10, color: '#fca5a5' }}>{aiFixErr}</div> : null}
            {aiFixNote ? <div className="hint" style={{ marginBottom: 10, color: '#a7f3d0' }}>{aiFixNote}</div> : null}
            {aiReviewErr ? <div style={{ marginBottom: 10, color: '#fca5a5' }}>{aiReviewErr}</div> : null}
            {aiReviewText ? (
              <div className="mini-scroll" style={{ maxHeight: '26vh', overflow: 'auto' }}>
                <div className="mini-readonly-text" style={{ whiteSpace: 'pre-wrap' }}>{aiReviewText}</div>
              </div>
            ) : (
              <div className="hint" style={{ marginBottom: 10 }}>点击“AI 解释原因”获取更直观的解释与修改建议。</div>
            )}

            <div className="ai-modal-actions">
              <button
                className="btn secondary"
                onClick={() => setCompileModalOpen(false)}
                disabled={busy}
              >
                返回继续修改
              </button>
              <button
                className="btn"
                onClick={() => {
                  setCompileModalOpen(false)
                  props.onNext()
                }}
                disabled={busy || compileResult.validation?.ok === false}
                title={compileResult.validation?.ok === false ? '蓝图校验失败，请先修正脚本或蓝图后再进入' : '进入蓝图编辑'}
              >
                进入蓝图
              </button>
            </div>
          </div>
        </div>
      ) : null}

    </div>
  )
}
