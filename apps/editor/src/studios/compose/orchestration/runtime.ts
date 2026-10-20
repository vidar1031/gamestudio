import {
  type CharacterPlacementV1,
  type ConditionExprV1,
  type EndingCardV1,
  type NodeV1,
  type ProjectEventV1,
  type StateVarDefV1,
  type TimelineActionV1,
  type TimelineAdvanceV1
} from '../../../api'

export type RuntimeWait =
  | { kind: 'auto' }
  | { kind: 'click' }
  | { kind: 'choice' }
  | { kind: 'timer'; ms: number }
  | { kind: 'event'; name: string }
  | { kind: 'condition'; expr: ConditionExprV1; pollMs: number }
  | { kind: 'end' }

export type RuntimeNav =
  | { type: 'gotoNode'; nodeId: string; delayMs?: number }
  | { type: 'restart' }
  | { type: 'backToHub'; url?: string }
  | null

export type StageOverride = {
  backgroundAssetId?: string
  placements?: CharacterPlacementV1[]
}

export type RuntimeState = {
  stepIndex: number
  text: string
  toast: string
  endingCard: EndingCardV1 | null
  wait: RuntimeWait
  vars: Record<string, any>
  eventMemory: Record<string, any>
  stageOverride: StageOverride
  nav: RuntimeNav
}

export function buildDefaultVars(vars: StateVarDefV1[] | undefined): Record<string, any> {
  const out: Record<string, any> = {}
  const list = Array.isArray(vars) ? vars : []
  for (const v of list) {
    const name = String(v && (v as any).name || '').trim()
    if (!name) continue
    const type = String(v && (v as any).type || 'string') as any
    let d = (v as any).default
    if (type === 'tags') {
      if (!Array.isArray(d)) d = []
      d = d.map((x: any) => String(x)).filter(Boolean)
    } else if (type === 'number') {
      const n = Number(d)
      d = Number.isFinite(n) ? n : 0
    } else if (type === 'boolean') {
      d = Boolean(d)
    } else if (type === 'string') {
      d = String(d ?? '')
    }
    out[name] = d
  }
  return out
}

export function evalConditionValue(val: any, vars: Record<string, any>) {
  try {
    if (val && typeof val === 'object' && typeof val.var === 'string') return vars[String(val.var)]
  } catch {}
  return val
}

export function cmp(a: any, b: any) {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  const sa = String(a)
  const sb = String(b)
  if (sa === sb) return 0
  return sa < sb ? -1 : 1
}

export function evalConditionExpr(expr: ConditionExprV1 | null | undefined, vars: Record<string, any>): boolean {
  if (expr == null) return true
  if (typeof expr !== 'object') return Boolean(expr)
  const op = String((expr as any).op || '')
  if (!op) return Boolean(expr)

  if (op === 'and' || op === 'or') {
    const args = Array.isArray((expr as any).args) ? (expr as any).args : []
    if (!args.length) return true
    return op === 'and'
      ? args.every((x: any) => evalConditionExpr(x, vars))
      : args.some((x: any) => evalConditionExpr(x, vars))
  }
  if (op === 'not') return !evalConditionExpr((expr as any).arg, vars)

  if (op === 'tags.has') {
    const v = String((expr as any).var || '').trim()
    const value = String((expr as any).value || '').trim()
    const list = Array.isArray(vars[v]) ? vars[v] : []
    return list.map(String).includes(value)
  }

  if (op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') {
    const left = evalConditionValue((expr as any).left, vars)
    const right = evalConditionValue((expr as any).right, vars)
    const c = cmp(left, right)
    if (op === '==') return c === 0
    if (op === '!=') return c !== 0
    if (op === '<') return c < 0
    if (op === '<=') return c <= 0
    if (op === '>') return c > 0
    if (op === '>=') return c >= 0
  }

  return Boolean(expr)
}

export function normalizeAdvance(a: TimelineAdvanceV1 | any): TimelineAdvanceV1 {
  if (!a) return { type: 'auto' }
  if (typeof a === 'string') {
    const t = String(a)
    const allowed: Record<string, true> = {
      auto: true,
      click: true,
      choice: true,
      timer: true,
      event: true,
      condition: true,
      end: true
    }
    return { type: (allowed[t] ? (t as any) : 'auto') as any }
  }
  if (typeof a === 'object' && a.type) return a
  return { type: 'auto' }
}

export function defaultEndingCardForNode(node: NodeV1): EndingCardV1 {
  return {
    title: '',
    bullets: [],
    moral: String(node.body?.text || '故事结束。'),
    buttons: [{ type: 'restart', label: '重新开始' }]
  }
}

export function enterNodeRuntime(prev: RuntimeState): RuntimeState {
    return {
      ...prev,
      stepIndex: 0,
      text: '',
      toast: '',
      endingCard: null,
      wait: { kind: 'auto' },
      stageOverride: {},
      nav: null
    }
  }


export function applyTimelineAction(state: RuntimeState, action: TimelineActionV1, events: ProjectEventV1[], depth: number): RuntimeState {
    const t = String((action as any)?.type || '').trim()
    if (!t) return state
    if (state.nav) return state

    if (t === 'ui.setText') {
      const mode = String((action as any).mode || 'replace')
      const text = String((action as any).text ?? '')
      return { ...state, text: mode === 'append' ? `${state.text}${text}` : text }
    }
    if (t === 'ui.appendText') {
      const text = String((action as any).text ?? '')
      return { ...state, text: `${state.text}${text}` }
    }
    if (t === 'ui.clearText') return { ...state, text: '' }
    if (t === 'ui.toast') return { ...state, toast: String((action as any).text ?? '') }

    if (t === 'ui.showEndingCard') {
      const card = (action as any).card as EndingCardV1
      return { ...state, endingCard: card || null, wait: { kind: 'end' } }
    }

    if (t === 'flow.gotoNode') {
      const nodeId = String((action as any).nodeId || '').trim()
      if (!nodeId) return state
      return { ...state, nav: { type: 'gotoNode', nodeId } }
    }
    if (t === 'flow.restart') return { ...state, nav: { type: 'restart' } }
    if (t === 'flow.backToHub') return { ...state, nav: { type: 'backToHub', url: (action as any).url } }
    if (t === 'flow.stopTimeline') return { ...state, wait: { kind: 'end' } }

    if (t === 'event.call') {
      if (depth >= 8) return { ...state, toast: state.toast || '事件嵌套过深，已中止' }
      const eventId = String((action as any).eventId || '').trim()
      if (!eventId) return state
      const ev = events.find((e) => String(e && (e as any).id) === eventId) || null
      if (!ev) return { ...state, toast: state.toast || `事件不存在：${eventId}` }
      const acts = Array.isArray((ev as any).actions) ? (ev as any).actions : []
      let next = state
      for (const a of acts) {
        next = applyTimelineAction(next, a as any, events, depth + 1)
        if (next.nav) break
      }
      return next
    }
    if (t === 'events.emit') {
      const name = String((action as any).name || '').trim()
      if (!name) return state
      const payload = (action as any).payload
      return { ...state, eventMemory: { ...state.eventMemory, [name]: payload ?? true } }
    }

    if (t === 'state.set') {
      const k = String((action as any).var || '').trim()
      if (!k) return state
      return { ...state, vars: { ...state.vars, [k]: (action as any).value } }
    }
    if (t === 'state.add' || t === 'state.inc') {
      const k = String((action as any).var || '').trim()
      if (!k) return state
      const delta = t === 'state.inc' ? Number((action as any).value ?? 1) : Number((action as any).value ?? 0)
      const prev = Number(state.vars[k] ?? 0)
      const next = (Number.isFinite(prev) ? prev : 0) + (Number.isFinite(delta) ? delta : 0)
      return { ...state, vars: { ...state.vars, [k]: next } }
    }
    if (t === 'state.toggle') {
      const k = String((action as any).var || '').trim()
      if (!k) return state
      return { ...state, vars: { ...state.vars, [k]: !Boolean(state.vars[k]) } }
    }
    if (t === 'state.tags.add' || t === 'state.tags.remove') {
      const k = String((action as any).var || '').trim()
      const v = String((action as any).value || '').trim()
      if (!k || !v) return state
      const list = Array.isArray(state.vars[k]) ? state.vars[k].map(String) : []
      const set = new Set(list)
      if (t === 'state.tags.add') set.add(v)
      else set.delete(v)
      return { ...state, vars: { ...state.vars, [k]: Array.from(set) } }
    }

    if (t === 'stage.setBackground') {
      const assetId = (action as any).assetId ? String((action as any).assetId) : undefined
      return { ...state, stageOverride: { ...state.stageOverride, backgroundAssetId: assetId } }
    }
    if (t === 'stage.setPlacements') {
      const placements = Array.isArray((action as any).placements) ? (action as any).placements : []
      return { ...state, stageOverride: { ...state.stageOverride, placements } }
    }

    return state
  }
