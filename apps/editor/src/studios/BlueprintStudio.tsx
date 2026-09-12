import { useEffect, useMemo, useState } from 'react'
import { markStartupReady } from '../startupReady'
import {
  compileCompose,
  getBlueprint,
  getProject,
  getScripts,
  saveBlueprint,
  type BlueprintDocV1,
  type BlueprintNodeV1,
  type PlaceholderKindV1,
  type PlaceholderV1,
  type ScriptDocV1
} from '../api'

type Props = {
  projectId: string
  onBack: () => void
  onNext: () => void
}

type Selection =
  | { type: 'none' }
  | { type: 'node'; id: string }

type CanvasView = 'grid' | 'graph'

function nodeKindLabel(kind: BlueprintNodeV1['kind']) {
  return kind === 'ending' ? '结局' : '场景'
}

function nodeTitleForUI(n: BlueprintNodeV1, scriptCards: ScriptDocV1['cards']) {
  if (n.kind === 'ending') return n.name || n.id
  const sc = (scriptCards || []).find((c) => c.id === n.scriptCardId)
  return sc ? `#${sc.order} ${sc.name || sc.id}` : (n.name || n.id)
}

function elementKindLabel(kind: PlaceholderKindV1) {
  return kind === 'background' ? '背景要素' : kind === 'actor' ? '角色要素' : '事件要素'
}

function joinNames(list: { name?: string; id: string }[]) {
  return list.map((x) => x.name || x.id).filter(Boolean).join('、')
}

function TrashIcon(props: { size?: number }) {
  const size = props.size ?? 16
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 7h2v9h-2v-9Zm4 0h2v9h-2v-9ZM6 8h12l-1 13H7L6 8Z"
        fill="currentColor"
        opacity="0.9"
      />
    </svg>
  )
}

function PlusIcon(props: { size?: number }) {
  const size = props.size ?? 16
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M11 5h2v14h-2V5Zm-6 6h14v2H5v-2Z" fill="currentColor" opacity="0.9" />
    </svg>
  )
}

function XIcon(props: { size?: number }) {
  const size = props.size ?? 16
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3 1.4 1.4Z"
        fill="currentColor"
        opacity="0.9"
      />
    </svg>
  )
}

function uid(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function isCompilerChoiceId(choiceId: string, scriptCardId: string) {
  const cid = String(choiceId || '')
  const cardId = String(scriptCardId || '')
  if (!cid || !cardId) return false
  const base = `bc_${cardId}`
  return cid === base || cid.startsWith(`${base}_`)
}

function ensureManualChoiceId(choiceId: string, scriptCardId: string) {
  const cid = String(choiceId || '')
  if (!cid) return cid
  if (!isCompilerChoiceId(cid, scriptCardId)) return cid
  return `u_${cid}`
}

function sortByName<T extends { name?: string; id: string }>(arr: T[]) {
  return arr.slice().sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)))
}

function buildEdges(nodes: BlueprintNodeV1[]) {
  const edges: { from: string; to: string; text?: string }[] = []
  for (const n of nodes || []) {
    for (const c of n.choices || []) {
      if (!c || !c.toNodeId) continue
      edges.push({ from: n.id, to: c.toNodeId, text: String((c as any).text || '') })
    }
  }
  return edges
}

function computeDepths(startNodeId: string, nodes: BlueprintNodeV1[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const depth = new Map<string, number>()
  const q: string[] = []
  if (startNodeId && byId.has(startNodeId)) {
    depth.set(startNodeId, 0)
    q.push(startNodeId)
  }
  while (q.length) {
    const id = q.shift()!
    const d = depth.get(id) || 0
    const n = byId.get(id)
    const choices = n && Array.isArray(n.choices) ? n.choices : []
    for (const c of choices) {
      const to = String(c && (c as any).toNodeId || '')
      if (!to || !byId.has(to)) continue
      if (!depth.has(to) || (depth.get(to) as number) > d + 1) {
        depth.set(to, d + 1)
        q.push(to)
      }
    }
  }
  return depth
}

function layoutGraph(opts: {
  nodes: BlueprintNodeV1[]
  edges: { from: string; to: string; text?: string }[]
  startNodeId: string
  orderHint: string[]
}) {
  const { nodes, edges, startNodeId, orderHint } = opts
  const depthMap = computeDepths(startNodeId, nodes)

  const maxDepth = Math.max(0, ...Array.from(depthMap.values()))
  const byId = new Map(nodes.map((n) => [n.id, n]))

  const orderIndex = new Map<string, number>()
  orderHint.forEach((id, i) => orderIndex.set(id, i))

  const levels = new Map<number, string[]>()
  const unreachable: string[] = []
  for (const n of nodes) {
    const d = depthMap.has(n.id) ? (depthMap.get(n.id) as number) : -1
    if (d < 0) unreachable.push(n.id)
    else {
      const arr = levels.get(d) || []
      arr.push(n.id)
      levels.set(d, arr)
    }
  }

  for (const [d, arr] of levels.entries()) {
    arr.sort((a, b) => (orderIndex.get(a) ?? 1e9) - (orderIndex.get(b) ?? 1e9))
    levels.set(d, arr)
  }
  unreachable.sort((a, b) => (orderIndex.get(a) ?? 1e9) - (orderIndex.get(b) ?? 1e9))

  const CARD_W = 240
  const CARD_H = 56
  const GAP_X = 18
  const GAP_Y = 48
  const PAD_X = 16
  const PAD_Y = 14

  const pos = new Map<string, { x: number; y: number; w: number; h: number; depth: number; row: number }>()
  let width = PAD_X * 2
  let height = PAD_Y * 2
  let unreachableLabelY: number | null = null

  for (let d = 0; d <= maxDepth; d++) {
    const ids = levels.get(d) || []
    for (let r = 0; r < ids.length; r++) {
      const id = ids[r]
      // Top-down graph: depth is Y, row is X.
      const x = PAD_X + r * (CARD_W + GAP_X)
      const y = PAD_Y + d * (CARD_H + GAP_Y)
      pos.set(id, { x, y, w: CARD_W, h: CARD_H, depth: d, row: r })
      width = Math.max(width, x + CARD_W + PAD_X)
      height = Math.max(height, y + CARD_H + PAD_Y)
    }
  }

  if (unreachable.length) {
    const d = maxDepth + 1
    unreachableLabelY = Math.max(0, PAD_Y + d * (CARD_H + GAP_Y) - 34)
    for (let r = 0; r < unreachable.length; r++) {
      const id = unreachable[r]
      const x = PAD_X + r * (CARD_W + GAP_X)
      const y = PAD_Y + d * (CARD_H + GAP_Y)
      pos.set(id, { x, y, w: CARD_W, h: CARD_H, depth: -1, row: r })
      width = Math.max(width, x + CARD_W + PAD_X)
      height = Math.max(height, y + CARD_H + PAD_Y)
    }
  }

  const drawableEdges = edges
    .filter((e) => pos.has(e.from) && pos.has(e.to))
    .map((e) => ({
      ...e,
      fromNode: byId.get(e.from) || null,
      toNode: byId.get(e.to) || null
    }))

  const columns = maxDepth + 1 + (unreachable.length ? 1 : 0)
  return { pos, width, height, columns, unreachable, drawableEdges, unreachableLabelY }
}

export default function BlueprintStudio(props: Props) {
  const [scripts, setScripts] = useState<ScriptDocV1 | null>(null)
  const [blueprint, setBlueprint] = useState<BlueprintDocV1 | null>(null)
  const [selection, setSelection] = useState<Selection>({ type: 'none' })
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState('')
  const [composeModalOpen, setComposeModalOpen] = useState(false)
  const [canvasView, setCanvasView] = useState<CanvasView>('graph')
  const [elementsOpen, setElementsOpen] = useState<Record<PlaceholderKindV1, boolean>>({ background: false, actor: false, event: false })
  const [deleteElement, setDeleteElement] = useState<{ id: string; kind: PlaceholderKindV1 } | null>(null)
  const [pickActorIds, setPickActorIds] = useState<string[]>([])
  const [pickEventIds, setPickEventIds] = useState<string[]>([])

  async function load() {
    setBusy(true)
    setError('')
    try {
      const [s, b] = await Promise.all([getScripts(props.projectId), getBlueprint(props.projectId)])
      setScripts(s)
      setBlueprint(b)
      setSelection({ type: 'none' })
      setDirty(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      markStartupReady() // 启动覆盖层按真实加载收尾（重复调用安全）
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectId])

  function mutate(updater: (draft: BlueprintDocV1) => BlueprintDocV1) {
    setBlueprint((prev) => (prev ? updater(prev) : prev))
    setDirty(true)
  }

  const scriptCards = useMemo(() => (scripts ? scripts.cards.slice().sort((a, b) => a.order - b.order) : []), [scripts])

  const nodesAll = useMemo(() => (blueprint ? blueprint.nodes || [] : []), [blueprint])
  const placeholdersAll = useMemo(() => (blueprint ? blueprint.placeholders || [] : []), [blueprint])

  const scriptOrderById = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of scriptCards) m.set(c.id, Number(c.order) || 0)
    return m
  }, [scriptCards])

  const sceneNodesAll = useMemo(
    () =>
      (nodesAll || [])
        .filter((n) => n.kind === 'scene')
        .slice()
        .sort((a, b) => (scriptOrderById.get(a.scriptCardId) || 0) - (scriptOrderById.get(b.scriptCardId) || 0)),
    [nodesAll, scriptOrderById]
  )

  const endingNodesAll = useMemo(
    () =>
      (nodesAll || [])
        .filter((n) => n.kind === 'ending')
        .slice()
        .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id))),
    [nodesAll]
  )

  const selectedNode = useMemo(() => {
    if (selection.type !== 'node') return null
    return nodesAll.find((n) => n.id === selection.id) || null
  }, [nodesAll, selection])

  const canvasNodes = useMemo(() => {
    // 蓝图画布：展示 Scene/Ending 结构（不展示要素库条目）
    return [...sceneNodesAll, ...endingNodesAll]
  }, [endingNodesAll, sceneNodesAll])

  const graph = useMemo(() => {
    const b = blueprint
    if (!b) return null
    const nodes = canvasNodes
    const edges = buildEdges(nodes)
    const orderHint = nodes.map((n) => n.id)
    return layoutGraph({ nodes, edges, startNodeId: String(b.startNodeId || ''), orderHint })
  }, [blueprint, canvasNodes])

  const placeholdersByKind = useMemo(() => {
    const m: Record<string, PlaceholderV1[]> = { actor: [], background: [], event: [] }
    for (const p of placeholdersAll) {
      const k = (p.kind || '') as any
      if (m[k]) m[k].push(p)
    }
    return m
  }, [placeholdersAll])

  const placeholdersByKindSorted = useMemo(() => {
    const m = placeholdersByKind
    return {
      background: sortByName(m.background || []),
      actor: sortByName(m.actor || []),
      event: sortByName(m.event || [])
    }
  }, [placeholdersByKind])

  const assignedPlaceholders = useMemo(() => {
    const byId = new Map((placeholdersAll || []).map((p) => [p.id, p]))
    const n = selectedNode
    if (!n) return null
    const bg = n.backgroundId ? byId.get(n.backgroundId) || null : null
    const actors = (n.actorIds || []).map((id) => byId.get(id)).filter(Boolean) as PlaceholderV1[]
    const events = (n.eventIds || []).map((id) => byId.get(id)).filter(Boolean) as PlaceholderV1[]
    return { bg, actors, events }
  }, [placeholdersAll, selectedNode])

  useEffect(() => {
    setPickActorIds([])
    setPickEventIds([])
  }, [selectedNode?.id])

  async function save() {
    if (!blueprint) return
    setBusy(true)
    setError('')
    try {
      const next = await saveBlueprint(props.projectId, blueprint)
      setBlueprint(next)
      setDirty(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function ensureBlueprint(): BlueprintDocV1 {
    return blueprint || { schemaVersion: '1.0', startNodeId: '', placeholders: [], nodes: [], updatedAt: '' }
  }

  function createPlaceholder(kind: PlaceholderKindV1): PlaceholderV1 {
    return {
      id: uid('ph'),
      kind,
      name: kind === 'actor' ? '新角色' : kind === 'background' ? '新背景' : '新事件',
      tags: []
    }
  }

  function createPlaceholderOnly(kind: PlaceholderKindV1) {
    if (!blueprint) return
    mutate((d) => {
      const p = createPlaceholder(kind)
      return { ...d, placeholders: [...(d.placeholders || []), p], updatedAt: new Date().toISOString() }
    })
    setElementsOpen((prev) => ({ ...prev, [kind]: true }))
  }

  function deletePlaceholder(id: string) {
    mutate((d) => {
      const placeholders = (d.placeholders || []).filter((p) => p.id !== id)
      const nodes = (d.nodes || []).map((n) => ({
        ...n,
        backgroundId: n.backgroundId === id ? undefined : n.backgroundId,
        actorIds: (n.actorIds || []).filter((x) => x !== id),
        eventIds: (n.eventIds || []).filter((x) => x !== id)
      }))
      return { ...d, placeholders, nodes, updatedAt: new Date().toISOString() }
    })
  }

  function setNode(updater: (n: BlueprintNodeV1) => BlueprintNodeV1) {
    if (!selectedNode) return
    mutate((d) => ({
      ...d,
      nodes: (d.nodes || []).map((n) => (n.id === selectedNode.id ? updater(n) : n)),
      updatedAt: new Date().toISOString()
    }))
  }

  async function next() {
    if (!blueprint) return

    if (!blueprint.startNodeId) {
      window.alert('请先设置 startNodeId')
      return
    }

    const hasEnding = (blueprint.nodes || []).some((n) => n.kind === 'ending')
    if (!hasEnding) {
      window.alert('当前蓝图还没有任何「结局」节点，请先添加至少一个结局。')
      return
    }

    const hadChanges = dirty
    if (dirty) {
      try {
        await save()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return
      }
    }

    if (!hadChanges) {
      // 合成层需要先从蓝图生成一次，否则会看到旧的 story.json（例如只有 start/end）。
      try {
        setBusy(true)
        setError('')
        const p = await getProject(props.projectId)
        const storyNodes = Array.isArray((p.story as any)?.nodes) ? ((p.story as any).nodes as any[]) : []
        const storyIds = new Set(storyNodes.map((n) => String((n as any)?.id || '')).filter(Boolean))
        const blueprintIds = new Set((blueprint.nodes || []).map((n) => String(n && n.id || '')).filter(Boolean))
        const sameStart = String((p.story as any)?.startNodeId || '') === String(blueprint.startNodeId || '')
        const sameIds = storyIds.size === blueprintIds.size && Array.from(blueprintIds).every((id) => storyIds.has(id))

        if (!sameStart || !sameIds) {
          await compileCompose(props.projectId)
        }
        props.onNext()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
      return
    }

    setComposeModalOpen(true)
  }

  async function handleComposeChoice(action: 'apply' | 'skip') {
    setComposeModalOpen(false)
    if (action === 'skip') {
      props.onNext()
      return
    }
    setBusy(true)
    setError('')
    try {
      await compileCompose(props.projectId)
      props.onNext()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const problems = useMemo(() => {
    const b = blueprint
    if (!b) return []
    const problems: string[] = []
    const ids = new Set((b.nodes || []).map((n) => n.id))
    if (!b.startNodeId || !ids.has(b.startNodeId)) problems.push('startNodeId 无效')
    const hasEnding = (b.nodes || []).some((n) => n.kind === 'ending')
    if (!hasEnding) problems.push('缺少结局节点（请先添加至少一个结局）')
    for (const n of b.nodes || []) {
      for (const c of n.choices || []) {
        if (!c.toNodeId || !ids.has(c.toNodeId)) problems.push(`节点 ${n.id} choice 指向无效：${c.id}`)
      }
    }
    return problems
  }, [blueprint])

  return (
    <div className="app">
      <div className="topbar">
        <div className="left">
          <div className="title">第二层 · 蓝图</div>
          <button className="btn secondary" onClick={props.onBack} disabled={busy}>
            上一步：脚本
          </button>
          <div className="hint">项目ID：{props.projectId}</div>
        </div>
        <div className="right">
          {problems.length ? (
            <div className="hint" style={{ color: '#fca5a5' }}>校验：{problems.length} 个问题</div>
          ) : (
            <div className="hint">校验：通过</div>
          )}
          {dirty ? <div className="hint" style={{ color: '#fde68a' }}>未保存</div> : <div className="hint">已保存</div>}
          <button className="btn" onClick={() => save()} disabled={busy || !dirty || !blueprint}>
            保存
          </button>
          <button className="btn secondary" onClick={() => next()} disabled={busy || !blueprint}>
            下一步：进入合成
          </button>
        </div>
      </div>

      <div className="main">
        <div className="panel">
          <div className="section">
            <div style={{ fontWeight: 800, marginBottom: 8 }}>要素库</div>

            {(['background', 'actor', 'event'] as PlaceholderKindV1[]).map((kind) => (
              <div key={kind} style={{ marginTop: 12 }}>
                <div className="subfold">
                  <div
                    className="subfold-head"
                    onClick={() => setElementsOpen((prev) => ({ ...prev, [kind]: !prev[kind] }))}
                    role="button"
                    aria-label={`${elementKindLabel(kind)} 折叠/展开`}
                  >
                    <div className="subfold-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ opacity: 0.85 }}>{elementsOpen[kind] ? '▾' : '▸'}</span>
                      <span>{elementKindLabel(kind)}</span>
                      <span style={{ opacity: 0.7, fontWeight: 700 }}>({((placeholdersByKind as any)[kind] || []).length || 0})</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button
                        className="icon-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          createPlaceholderOnly(kind)
                        }}
                        disabled={busy || !blueprint}
                        title="新增"
                        aria-label="新增"
                      >
                        <PlusIcon />
                      </button>
                    </div>
                  </div>
                  {elementsOpen[kind] ? (
                    <div className="subfold-body">
                      {((placeholdersByKind as any)[kind] || []).length ? (
                        <div className="form" style={{ gap: 8 }}>
                          {((placeholdersByKind as any)[kind] || []).map((p: PlaceholderV1) => (
                            <div key={p.id} style={{ border: '1px solid rgba(148,163,184,0.16)', borderRadius: 12, padding: 10 }}>
                              <div className="form-row" style={{ gridTemplateColumns: '64px 1fr 36px' }}>
                                <label>名称</label>
                                <input
                                  className="input"
                                  value={p.name || ''}
                                  onChange={(e) =>
                                    mutate((d) => ({
                                      ...d,
                                      placeholders: (d.placeholders || []).map((pp) => (pp.id === p.id ? { ...pp, name: e.target.value } : pp)),
                                      updatedAt: new Date().toISOString()
                                    }))
                                  }
                                />
                                <button
                                  className="icon-btn danger"
                                  onClick={() => setDeleteElement({ id: p.id, kind })}
                                  disabled={busy}
                                  title="删除"
                                  aria-label="删除"
                                >
                                  <TrashIcon />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}

            {error ? <div style={{ marginTop: 10, color: '#fca5a5' }}>{error}</div> : null}
          </div>
        </div>

        <div className="canvas">
          <div className="canvas-wrap">
            <div className="canvas-scroll" style={{ padding: 12, width: 'calc(100% - 24px)', maxWidth: 'none' }}>
              <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                <button
                  className={canvasView === 'grid' ? 'btn' : 'btn secondary'}
                  onClick={() => setCanvasView('grid')}
                  disabled={busy}
                >
                  卡片
                </button>
                <button
                  className={canvasView === 'graph' ? 'btn' : 'btn secondary'}
                  onClick={() => setCanvasView('graph')}
                  disabled={busy || !graph}
                >
                  结构图
                </button>
              </div>

              {canvasView === 'grid' ? (
                <div style={{ width: '100%' }}>
                  <div className="card-grid">
                    {canvasNodes.map((n) => {
                      const sc = n.kind === 'scene' ? scriptCards.find((c) => c.id === n.scriptCardId) : null
                      const title = n.kind === 'scene' && sc ? `#${sc.order} ${sc.name || sc.id}` : (n.name || n.id)
                      return (
                        <div
                          key={n.id}
                          className={`card ${selection.type === 'node' && selection.id === n.id ? 'active' : ''}`}
                          onClick={() => setSelection({ type: 'node', id: n.id })}
                        >
                          <div className="card-title">{title}</div>
                          <div className="card-sub">{nodeKindLabel(n.kind)}</div>
                          <div className="card-sub">{(n.textDraft || '').trim().slice(0, 60) || '（无文本草稿）'}</div>
                          <div className="card-sub">角色: {(n.actorIds || []).length} · 事件: {(n.eventIds || []).length}</div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : graph ? (
                <div className="graph-canvas" style={{ width: '100%' }}>
                  <div className="graph-wrap" style={{ width: graph.width, height: graph.height }}>
                    <svg className="graph-svg" width={graph.width} height={graph.height}>
                      <defs>
                        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                          <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(148,163,184,0.65)" />
                        </marker>
                      </defs>
                      {graph.drawableEdges.map((e, idx) => {
                        const a = graph.pos.get(e.from)!
                        const b = graph.pos.get(e.to)!
                        const x1 = a.x + a.w / 2
                        const y1 = a.y + a.h
                        const x2 = b.x + b.w / 2
                        const y2 = b.y
                        const dy = Math.max(40, (y2 - y1) * 0.5)
                        const d = `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`
                        return <path key={idx} d={d} fill="none" stroke="rgba(148,163,184,0.55)" strokeWidth={2} markerEnd="url(#arrow)" />
                      })}
                    </svg>

                    {canvasNodes.map((n) => {
                      const p = graph.pos.get(n.id)
                      if (!p) return null
                      const sc = n.kind === 'scene' ? scriptCards.find((c) => c.id === n.scriptCardId) : null
                      const title = n.kind === 'scene' && sc ? `#${sc.order} ${sc.name || sc.id}` : (n.name || n.id)
                      return (
                        <div
                          key={n.id}
                          className={`card graph-card ${selection.type === 'node' && selection.id === n.id ? 'active' : ''}`}
                          style={{ position: 'absolute', left: p.x, top: p.y, width: p.w, height: p.h }}
                          onClick={() => setSelection({ type: 'node', id: n.id })}
                        >
                          <div className="card-title">{title}</div>
                        </div>
                      )
                    })}

                    {graph.unreachable.length ? (
                      <div className="graph-label" style={{ position: 'absolute', left: 12, top: graph.unreachableLabelY ?? Math.max(0, graph.height - 34) }}>
                        不可达
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                null
              )}
            </div>
          </div>
        </div>

        <div className="panel right">
          <div className="section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <div style={{ fontWeight: 700 }}>属性</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ fontSize: 12, opacity: 0.85 }}>起始</div>
                <select
                  className="sel"
                  value={(ensureBlueprint().startNodeId || '__unset__') as any}
                  disabled={busy || !blueprint}
                  onChange={(e) => mutate((d) => ({ ...d, startNodeId: e.target.value, updatedAt: new Date().toISOString() }))}
                  style={{ padding: '6px 10px' }}
                >
                  {!ensureBlueprint().startNodeId ? (
                    <option value="__unset__" disabled>
                      （未设置）
                    </option>
                  ) : null}
                  {sceneNodesAll.map((n) => (
                    <option key={n.id} value={n.id}>
                      {nodeTitleForUI(n, scriptCards)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="hr" />

            {selection.type === 'node' && selectedNode ? (
              <div className="form">
                <div style={{ fontWeight: 800 }}>{nodeTitleForUI(selectedNode, scriptCards)}</div>
                <div style={{ fontSize: 12, opacity: 0.8, marginTop: -6 }}>{nodeKindLabel(selectedNode.kind)}</div>

                <div className="hr" />

                <div className="form-row">
                  <label>名称</label>
                  <input className="input" value={selectedNode.name || ''} readOnly />
                </div>

                <div className="form-row">
                  <label>类型</label>
                  <select
                    className="sel"
                    value={selectedNode.kind}
                    disabled
                  >
                    <option value="scene">场景</option>
                    <option value="ending">结局</option>
                  </select>
                </div>

                <div className="form-row">
                  <label>文本草稿</label>
                  <textarea
                    className="textarea"
                    value={selectedNode.textDraft || ''}
                    onChange={(e) => setNode((n) => ({ ...n, textDraft: e.target.value }))}
                  />
                </div>

                <div className="hr" />

                <div style={{ fontWeight: 700 }}>要素分配</div>

                <div className="form-row">
                  <label>背景</label>
                  <select
                    className="sel"
                    value={selectedNode.backgroundId || ''}
                    disabled={busy || !blueprint}
                    onChange={(e) => setNode((n) => ({ ...n, backgroundId: e.target.value || undefined }))}
                  >
                    <option value="">（无）</option>
                    {(placeholdersByKindSorted.background || []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name || p.id}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-row">
                  <label>角色（库）</label>
                  <select
                    multiple
                    className="sel"
                    value={pickActorIds}
                    disabled={busy || !blueprint}
                    onChange={(e) => {
                      setPickActorIds(Array.from(e.target.selectedOptions).map((o) => o.value))
                    }}
                    style={{ height: 120 }}
                  >
                    {(placeholdersByKindSorted.actor || []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name || p.id}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    className="btn secondary"
                    disabled={busy || !blueprint || !pickActorIds.length}
                    onClick={() =>
                      setNode((n) => ({ ...n, actorIds: Array.from(new Set([...(n.actorIds || []), ...pickActorIds])) }))
                    }
                  >
                    添加到场景
                  </button>
                </div>
                {(selectedNode.actorIds || []).length ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {(selectedNode.actorIds || []).map((id) => {
                      const p = (placeholdersAll || []).find((x) => x.id === id)
                      const label = p ? (p.name || p.id) : id
                      return (
                        <div
                          key={id}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 8,
                            border: '1px solid rgba(148,163,184,0.16)',
                            background: 'rgba(2,6,23,0.35)',
                            borderRadius: 999,
                            padding: '6px 10px'
                          }}
                        >
                          <div style={{ fontSize: 12, opacity: 0.9 }}>{label}</div>
                          <button
                            className="icon-btn"
                            onClick={() => setNode((n) => ({ ...n, actorIds: (n.actorIds || []).filter((x) => x !== id) }))}
                            disabled={busy || !blueprint}
                            title="从场景移除"
                            aria-label="从场景移除"
                          >
                            <XIcon size={14} />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                ) : null}

                <div className="form-row">
                  <label>事件（库）</label>
                  <select
                    multiple
                    className="sel"
                    value={pickEventIds}
                    disabled={busy || !blueprint}
                    onChange={(e) => {
                      setPickEventIds(Array.from(e.target.selectedOptions).map((o) => o.value))
                    }}
                    style={{ height: 120 }}
                  >
                    {(placeholdersByKindSorted.event || []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name || p.id}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    className="btn secondary"
                    disabled={busy || !blueprint || !pickEventIds.length}
                    onClick={() =>
                      setNode((n) => ({ ...n, eventIds: Array.from(new Set([...(n.eventIds || []), ...pickEventIds])) }))
                    }
                  >
                    添加到场景
                  </button>
                </div>
                {(selectedNode.eventIds || []).length ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {(selectedNode.eventIds || []).map((id) => {
                      const p = (placeholdersAll || []).find((x) => x.id === id)
                      const label = p ? (p.name || p.id) : id
                      return (
                        <div
                          key={id}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 8,
                            border: '1px solid rgba(148,163,184,0.16)',
                            background: 'rgba(2,6,23,0.35)',
                            borderRadius: 999,
                            padding: '6px 10px'
                          }}
                        >
                          <div style={{ fontSize: 12, opacity: 0.9 }}>{label}</div>
                          <button
                            className="icon-btn"
                            onClick={() => setNode((n) => ({ ...n, eventIds: (n.eventIds || []).filter((x) => x !== id) }))}
                            disabled={busy || !blueprint}
                            title="从场景移除"
                            aria-label="从场景移除"
                          >
                            <XIcon size={14} />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                ) : null}

                <div className="hr" />

                <div style={{ fontWeight: 700 }}>选项（分支）</div>
                <div className="hint" style={{ marginTop: 6 }}>
                  提示：这里修改“指向/文本”会把该选项变为手工覆盖（以后从脚本重新编译蓝图时会保留，不再自动更新）。
                </div>

                {selectedNode.kind !== 'ending' ? (
                  <div className="form" style={{ gap: 8 }}>
                    {(selectedNode.choices || []).map((c) => {
                      const isAuto = isCompilerChoiceId(String(c.id || ''), String(selectedNode.scriptCardId || ''))
                      return (
                        <div key={c.id} style={{ border: '1px solid rgba(148,163,184,0.16)', borderRadius: 12, padding: 10 }}>
                          <div className="hint" style={{ marginBottom: 6, opacity: 0.85 }}>
                            {isAuto ? '自动（来自脚本编译）' : '手工覆盖'}
                          </div>
                          <div className="form-row">
                            <label>文本</label>
                            <input
                              className="input"
                              value={c.text}
                              disabled={busy || !blueprint}
                              onChange={(e) => {
                                const nextText = e.target.value
                                const oldId = String(c.id || '')
                                setNode((n) => ({
                                  ...n,
                                  choices: (n.choices || []).map((x) => {
                                    if (String(x.id || '') !== oldId) return x
                                    const nextId = ensureManualChoiceId(String(x.id || ''), String(n.scriptCardId || ''))
                                    return { ...x, id: nextId || oldId, text: nextText }
                                  })
                                }))
                              }}
                            />
                          </div>
                          <div className="form-row">
                            <label>指向</label>
                            <select
                              className="sel"
                              value={String(c.toNodeId || '')}
                              disabled={busy || !blueprint}
                              onChange={(e) => {
                                const nextTo = String(e.target.value || '')
                                const oldId = String(c.id || '')
                                setNode((n) => ({
                                  ...n,
                                  choices: (n.choices || []).map((x) => {
                                    if (String(x.id || '') !== oldId) return x
                                    const nextId = ensureManualChoiceId(String(x.id || ''), String(n.scriptCardId || ''))
                                    return { ...x, id: nextId || oldId, toNodeId: nextTo }
                                  })
                                }))
                              }}
                            >
                              <optgroup label="场景">
                                {sceneNodesAll.map((n) => (
                                  <option key={n.id} value={n.id}>
                                    {nodeTitleForUI(n, scriptCards)}
                                  </option>
                                ))}
                              </optgroup>
                              <optgroup label="结局">
                                {endingNodesAll.map((n) => (
                                  <option key={n.id} value={n.id}>
                                    {n.name || n.id}
                                  </option>
                                ))}
                              </optgroup>
                            </select>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}

        </div>
      </div>
    </div>
    {composeModalOpen ? (
      <div className="ai-modal" role="dialog" aria-modal="true" aria-label="是否更新合成">
        <div className="ai-modal-card">
          <div className="ai-modal-title">检测到蓝图已修改</div>
          <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.6 }}>
            是否将本次蓝图修改同步到合成层？
            <br />
            不同步将直接进入现有合成层。
          </div>

          <div className="ai-modal-actions">
            <button
              className="btn secondary"
              onClick={() => void handleComposeChoice('skip')}
              disabled={busy}
              title="不更新合成，直接进入"
            >
              直接进入
            </button>
            <button
              className="btn"
              onClick={() => void handleComposeChoice('apply')}
              disabled={busy}
              title="更新合成并进入"
            >
              更新并进入
            </button>
          </div>
        </div>
      </div>
    ) : null}
    {deleteElement ? (
      <div className="ai-modal" role="dialog" aria-modal="true" aria-label="确认删除要素">
        <div className="ai-modal-card">
          <div className="ai-modal-title">确认删除</div>
          <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.6 }}>
            {elementKindLabel(deleteElement.kind)}：
            {(placeholdersAll || []).find((p) => p.id === deleteElement.id)?.name || deleteElement.id}
            <br />
            删除后，所有节点对该要素的引用会被清空。
          </div>
          <div className="ai-modal-actions" style={{ marginTop: 12 }}>
            <button className="btn secondary" onClick={() => setDeleteElement(null)} disabled={busy}>
              取消
            </button>
            <button
              className="btn"
              onClick={() => {
                deletePlaceholder(deleteElement.id)
                setDeleteElement(null)
              }}
              disabled={busy}
              style={{ background: 'rgba(239,68,68,0.85)' }}
              title="确认删除"
            >
              删除
            </button>
          </div>
        </div>
      </div>
    ) : null}
  </div>
  )
}
