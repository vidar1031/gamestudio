import {
  type ChoicesAlignV1,
  type ChoicesDirectionV1,
  type DialogPresetV1,
  type NodeV1,
  type ProjectV1,
  type StageConfigV1,
  type StoryV1
} from '../../../api'
import type { EditorDoc } from '../types'
import { numberOr } from './utils'
import { normalizeAdvance } from './runtime'

export function normalizeDialogPreset(v: any): DialogPresetV1 {
  const s = String(v || '').trim()
  const allowed: Record<string, true> = { bottom: true, top: true, left: true, right: true, center: true, custom: true }
  return (allowed[s] ? s : 'bottom') as DialogPresetV1
}

export function normalizeChoicesDirection(v: any): ChoicesDirectionV1 {
  const s = String(v || '').trim()
  return (s === 'column' ? 'column' : 'row') as ChoicesDirectionV1
}

export function normalizeChoicesAlign(v: any): ChoicesAlignV1 {
  const s = String(v || '').trim()
  const allowed: Record<string, true> = { start: true, center: true, end: true, stretch: true }
  return (allowed[s] ? s : 'center') as ChoicesAlignV1
}

export function normalizeStageV1(raw: any): StageConfigV1 {
  const s = raw && typeof raw === 'object' ? raw : {}
  let width = Math.max(1, Math.floor(numberOr((s as any).width, 720)))
  let height = Math.max(1, Math.floor(numberOr((s as any).height, 1280)))

  const orientationIn = String((s as any).orientation || '').trim()
  const orientation =
    orientationIn === 'portrait' || orientationIn === 'landscape'
      ? (orientationIn as any)
      : width >= height
        ? 'landscape'
        : 'portrait'

  // keep ratio consistent with orientation if user provided mismatched values
  if (orientation === 'portrait' && width > height) {
    const t = width
    width = height
    height = t
  }
  if (orientation === 'landscape' && height > width) {
    const t = width
    width = height
    height = t
  }

  const scaleMode = String((s as any).scaleMode || 'contain') === 'cover' ? 'cover' : 'contain'

  // clamp to reasonable bounds (P0)
  width = Math.max(320, Math.min(4096, width))
  height = Math.max(320, Math.min(4096, height))

  return { width, height, orientation, scaleMode }
}

export function normalizeProjectV1(raw: any): ProjectV1 {
  const p = (raw || {}) as any
  const characters = Array.isArray(p.characters) ? p.characters : []
  const assets = Array.isArray(p.assets) ? p.assets : []
  const events = Array.isArray(p.events) ? p.events : []
  const state = p && typeof p.state === 'object' && p.state ? p.state : { vars: [] }
  if (!Array.isArray(state.vars)) state.vars = []
  const stage = normalizeStageV1(p.stage)
  return {
    schemaVersion: String(p.schemaVersion || '1.0'),
    id: String(p.id || ''),
    title: String(p.title || ''),
    pluginId: String(p.pluginId || 'story-pixi'),
    pluginVersion: String(p.pluginVersion || '0.1.0'),
    createdAt: String(p.createdAt || ''),
    updatedAt: String(p.updatedAt || ''),
    characters,
    assets,
    events,
    state,
    stage
  }
}

export function ensureTimelineForNode(n: NodeV1): NodeV1 {
  const nn = (n || {}) as any
  const kind = String(nn.kind || 'scene') === 'ending' ? 'ending' : 'scene'
  const bodyText = String(nn.body?.text || '')
  const bodyTitleRaw = nn.body?.title
  const bodyTitle = typeof bodyTitleRaw === 'string' ? bodyTitleRaw : bodyTitleRaw == null ? '' : String(bodyTitleRaw)
  const body: any = { text: bodyText }
  if (String(bodyTitle || '').trim()) body.title = bodyTitle
  const choices = kind === 'scene' ? (Array.isArray(nn.choices) ? nn.choices : []) : []

  const stepsIn = Array.isArray(nn.timeline?.steps) ? nn.timeline.steps : []
  if (stepsIn.length) {
    const steps = stepsIn.map((s: any, i: number) => ({
      id: String(s && s.id || `st_${nn.id}_${i + 1}`),
      actions: Array.isArray(s && s.actions) ? s.actions : [],
      advance: (s && typeof s.advance === 'object' && s.advance) ? s.advance : { type: 'auto' }
    }))
    return { ...n, kind: kind as any, body, timeline: { steps } }
  }

  // Legacy node → minimal timeline
  if (kind === 'ending') {
    return {
      ...n,
      kind: 'ending',
      body,
      timeline: {
        steps: [
          {
            id: `st_${String(nn.id || 'end')}_1`,
            actions: [
              {
                type: 'ui.showEndingCard',
                card: {
                  title: '',
                  bullets: [],
                  moral: bodyText || '故事结束。',
                  buttons: [{ type: 'restart', label: '重新开始' }]
                }
              }
            ],
            advance: { type: 'end' }
          }
        ]
      }
    }
  }

  return {
    ...n,
    kind: 'scene',
    body,
    timeline: {
      steps: [
        {
          id: `st_${String(nn.id || 'scene')}_1`,
          actions: [{ type: 'ui.setText', mode: 'replace', text: bodyText }],
          advance: { type: choices.length ? 'choice' : 'click' }
        }
      ]
    }
  }
}

export function normalizeStoryV1(raw: any): StoryV1 {
  const s = (raw || {}) as any
  const nodesIn = Array.isArray(s.nodes) ? s.nodes : []
  const nodes = nodesIn.map((n: any) => ensureTimelineForNode(n))
  const startNodeId = String(s.startNodeId || (nodes[0] && nodes[0].id) || '')
  return { schemaVersion: String(s.schemaVersion || '1.0'), startNodeId, nodes }
}

export function validate(doc: EditorDoc): string[] {
    const problems: string[] = []
    if (!doc.story || !doc.project) return ['未打开项目']

    const project = normalizeProjectV1(doc.project as any)
    const story = normalizeStoryV1(doc.story as any)

    const nodes = Array.isArray(story.nodes) ? story.nodes : []
    const nodeIds = new Set(nodes.map((n: any) => String(n && n.id)))
    const eventIds = new Set((project.events || []).map((e: any) => String(e && e.id)))
    const stateVarNames = new Set((project.state?.vars || []).map((v: any) => String(v && v.name)))

    if (!story.startNodeId || !nodeIds.has(String(story.startNodeId))) problems.push('startNodeId 无效')

    // state vars: basic validation
    try {
      const names = (project.state?.vars || []).map((v: any) => String(v && v.name || '').trim()).filter(Boolean)
      const dup = names.find((n, idx) => names.indexOf(n) !== idx)
      if (dup) problems.push(`State 变量名重复：${dup}`)
    } catch {}

    // event macros: basic validation
    try {
      const ids = (project.events || []).map((e: any) => String(e && e.id || '').trim()).filter(Boolean)
      const dup = ids.find((n, idx) => ids.indexOf(n) !== idx)
      if (dup) problems.push(`Event 宏 id 重复：${dup}`)
    } catch {}

    for (const n of nodes) {
      const nodeId = String((n as any).id || '')
      const kind = String((n as any).kind || '')
      const name = String((n as any).name || '').trim()
      if (!name) problems.push(`节点 ${nodeId} 缺少名称`)

      const timelineSteps = Array.isArray((n as any).timeline?.steps) ? (n as any).timeline.steps : []
      if (!timelineSteps.length) problems.push(`节点 ${nodeId} 缺少 timeline.steps`)

      for (const [si, st] of timelineSteps.entries()) {
        const stepId = String(st && st.id || `#${si + 1}`)
        const adv = normalizeAdvance(st && st.advance)
        const t = String((adv as any).type || 'auto')
        if (t === 'choice' && kind === 'scene') {
          const cs = Array.isArray((n as any).choices) ? (n as any).choices : []
          if (!cs.length) problems.push(`节点 ${nodeId} 步骤 ${stepId}：choice 但未配置任何选项`)
        }
        if (t === 'event') {
          const name = String((adv as any).name || '').trim()
          if (!name) problems.push(`节点 ${nodeId} 步骤 ${stepId}：event 缺少 name`)
        }
        if (t === 'timer') {
          const ms = Number((adv as any).ms)
          if (!Number.isFinite(ms)) problems.push(`节点 ${nodeId} 步骤 ${stepId}：timer.ms 无效`)
        }
        if (t === 'condition') {
          const expr = (adv as any).expr
          if (!expr) problems.push(`节点 ${nodeId} 步骤 ${stepId}：condition 缺少 expr`)
        }

        const actions = Array.isArray(st && st.actions) ? st.actions : []
        for (const a of actions) {
          const at = String(a && a.type || '')
          if (at === 'flow.gotoNode') {
            const to = String(a && (a as any).nodeId || '').trim()
            if (to && !nodeIds.has(to)) problems.push(`节点 ${nodeId} 动作 flow.gotoNode 指向无效：${to}`)
          }
          if (at === 'event.call') {
            const id = String(a && (a as any).eventId || '').trim()
            if (id && !eventIds.has(id)) problems.push(`节点 ${nodeId} 动作 event.call 不存在：${id}`)
          }
          if (at.startsWith('state.')) {
            const v = String(a && (a as any).var || '').trim()
            if (v && !stateVarNames.has(v)) problems.push(`节点 ${nodeId} 动作 ${at} 变量未定义：${v}`)
          }
        }
      }

      if (kind === 'scene') {
        const choices = Array.isArray((n as any).choices) ? (n as any).choices : []
        for (const c of choices) {
          const to = String(c && c.toNodeId || '')
          const cid = String(c && c.id || '')
          if (!to || !nodeIds.has(to)) problems.push(`节点 ${nodeId} 选项指向无效：${cid}`)
        }
      }

    const placements = Array.isArray((n as any).visuals?.placements) ? (n as any).visuals.placements : []
    for (const p of placements) {
      const pid = String(p && p.id || '')
      const chId = String(p && p.characterId || '')
      if (chId && !project.characters.find((ch: any) => String(ch && ch.id) === chId)) {
        problems.push(`节点 ${nodeId} placement 角色不存在：${pid}`)
      }
      const img = (p as any).imageAssetId
      if (img && !project.assets.find((a: any) => String(a && a.id) === String(img))) {
        problems.push(`节点 ${nodeId} placement ${pid} imageAssetId 不存在：${String(img)}`)
      }
    }

    const bg = (n as any).visuals?.backgroundAssetId
    if (bg && !project.assets.find((a: any) => String(a && a.id) === String(bg))) {
      problems.push(`节点 ${nodeId} backgroundAssetId 不存在：${String(bg)}`)
    }
  }

  for (const ch of project.characters) {
    const chId = String((ch as any).id || '')
    const img = (ch as any).imageAssetId
    if (img && !project.assets.find((a: any) => String(a && a.id) === String(img))) {
      problems.push(`角色 ${chId} imageAssetId 不存在：${String(img)}`)
    }
  }

  return problems
}

export function ensureNode(n: NodeV1): NodeV1 {
  const base = ensureTimelineForNode(n)
  const visuals = base.visuals || {}
  const placements = Array.isArray(visuals.placements) ? visuals.placements : []
  const choices = Array.isArray((base as any).choices) ? (base as any).choices : []
  const normalizedChoices = choices.map((c: any) => ({
          ...c,
          id: String((c as any).id || ''),
          text: String((c as any).text || ''),
          toNodeId: String((c as any).toNodeId || ''),
          effects: Array.isArray((c as any).effects) ? (c as any).effects : [],
          visibleWhen: (c as any).visibleWhen ?? null,
          enabledWhen: (c as any).enabledWhen ?? null
        }))
  return { ...base, choices: normalizedChoices, visuals: { ...visuals, placements } }
}
