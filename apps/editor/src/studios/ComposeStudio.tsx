import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Application, Container, Sprite, Texture } from 'pixi.js'
import AiBackgroundModal from '../AiBackgroundModal'
import AiStoryboardBatchModal, { type StoryboardBatchItem } from '../AiStoryboardBatchModal'
import AiCharacterSpriteModal, { type AiCharacterSpriteDraft } from '../AiCharacterSpriteModal'
import { chromaKeyUrlToPng } from '../chromaKey'
import {
  analyzeBackgroundPromptAi,
  generateStoryBibleAi,
  analyzeCharacterFingerprintAi,
  createProject,
  exportProject,
  exportPublishPackage,
  listProjectExports,
  deleteProjectExport,
  generateBackgroundAi,
  generateCharacterSpriteAi,
  generateCharacterReferenceAi,
  getBlueprint,
  getScripts,
	  getProject,
  getStudioSettings,
	  listProjects,
	  openProjectAssetFolder,
	  resolveUrl,
	  saveProject,
  preflightStudioImage,
  testStudioImage,
	  uploadProjectImage,
  type AiBackgroundRequest,
  type AssetV1,
  type CharacterPlacementV1,
  type CharacterV1,
  type ChoiceV1,
	  type ConditionExprV1,
	  type EndingCardV1,
	  type DialogLayoutV1,
	  type DialogPresetV1,
	  type ChoicesLayoutV1,
	  type ChoicesDirectionV1,
	  type ChoicesAlignV1,
  type NodeV1,
  type NodeUiV1,
  type ProjectV1,
  type ProjectEventV1,
  type StageConfigV1,
  type StateVarDefV1,
  type TimelineActionV1,
  type TimelineAdvanceV1,
  type ScriptDocV1,
  type StoryV1
} from '../api'

type Selection =
  | { type: 'none' }
  | { type: 'node'; id: string }
  | { type: 'character'; id: string }
  | { type: 'asset'; id: string }

type LeftTab = 'nodes' | 'characters' | 'assets'

type StoryboardBatchState = {
  entitySpec: string
  storyBibleJson: string
  continuity: {
    ipadapterEnabled: boolean
    requireCharacterRefs: boolean
    controlnetEnabled: boolean
  }
  globalPrompt: string
  globalNegativePrompt: string
  style: 'picture_book' | 'cartoon' | 'national_style' | 'watercolor'
  aspectRatio: '9:16' | '16:9' | '1:1' | '9:1'
  width: number
  height: number
  steps: number
  cfgScale: number
  sampler: string
  scheduler: string
}

type StoryboardScenePromptStore = {
  nodeId: string
  nodeName: string
  userInput: string
  prompt: string
  negativePrompt: string
  updatedAt: string
}

type StoryboardPromptMeta = {
  style: string
  aspectRatio: string
  updatedAt: string
}

type LatestExportAction = 'overwrite' | 'delete' | 'cancel'

 type StoryboardBatchDraft = {
  style: 'picture_book' | 'cartoon' | 'national_style' | 'watercolor'
  aspectRatio: '9:16' | '16:9' | '1:1' | '9:1'
  width: number
  height: number
  steps: number
  cfgScale: number
  sampler: string
  scheduler: string
  updatedAt: string
}

const DOUBAO_STORYBOARD_DEFAULTS = {
  steps: 30,
  cfgScale: 7.5,
  sampler: 'DPM++ 2M',
  scheduler: 'Karras'
} as const

const COMFYUI_STORYBOARD_DEFAULTS = {
  steps: 24,
  cfgScale: 6.0,
  sampler: 'DPM++ 2M',
  scheduler: 'Karras'
} as const

	type EditorDoc = {
	  mode: 'project' | 'none'
	  readonly: boolean
	  id: string
	  title: string
	  assetBase: string
	  project: ProjectV1 | null
  story: StoryV1 | null
}

function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function nodeKindLabel(kind: NodeV1['kind']) {
  return '场景'
}

function scriptCardLabel(sc: any) {
  const order = Number(sc && sc.order) || 0
  const name = String(sc && sc.name || '').trim()
  if (order && name) return `#${order} ${name}`
  if (name) return name
  if (order) return `#${order}`
  return ''
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

type StageViewport = {
  stageW: number
  stageH: number
  scale: number
  offsetX: number
  offsetY: number
  scaleMode: 'contain' | 'cover'
}

function computeStageViewport(stageCfg: StageConfigV1 | undefined, viewW: number, viewH: number): StageViewport {
  const s = normalizeStageV1(stageCfg)
  const stageW = Math.max(1, Math.floor(numberOr(s.width, 720)))
  const stageH = Math.max(1, Math.floor(numberOr(s.height, 1280)))
  const scaleMode = String(s.scaleMode || 'contain') === 'cover' ? 'cover' : 'contain'
  const sx = viewW / stageW
  const sy = viewH / stageH
  const scale = scaleMode === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy)
  const offsetX = (viewW - stageW * scale) / 2
  const offsetY = (viewH - stageH * scale) / 2
  return { stageW, stageH, scale, offsetX, offsetY, scaleMode }
}

function numberOr(v: unknown, fallback: number) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function resolveAsset(uri: string, assetBase: string) {
  const s = String(uri || '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  if (/^\//.test(s) && /^https?:\/\//i.test(assetBase || '')) {
    try {
      const origin = new URL(assetBase).origin
      return `${origin}${s}`
    } catch {}
  }
  if (!assetBase) return s
  return assetBase.replace(/\/+$/, '/') + s.replace(/^\/+/, '')
}

const textureCache = new Map<string, Promise<Texture> | Texture>()

async function loadTexture(url: string): Promise<Texture | null> {
  const key = String(url || '').trim()
  if (!key) return null

  const cached = textureCache.get(key)
  if (cached) {
    try {
      return cached instanceof Promise ? await cached : cached
    } catch {
      textureCache.delete(key)
    }
  }

  const p = new Promise<Texture>((resolve, reject) => {
    try {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        try {
          resolve(Texture.from(img))
        } catch (e) {
          reject(e)
        }
      }
      img.onerror = () => reject(new Error(`图片加载失败: ${key}`))
      img.src = key
    } catch (e) {
      reject(e)
    }
  })

  textureCache.set(key, p)

  try {
    const tex = await p
    textureCache.set(key, tex)
    return tex
  } catch (e) {
    textureCache.delete(key)
    try {
      console.warn('[game_studio] loadTexture failed:', key, e instanceof Error ? e.message : String(e))
    } catch {}
    return null
  }
}

type RuntimeWait =
  | { kind: 'auto' }
  | { kind: 'click' }
  | { kind: 'choice' }
  | { kind: 'timer'; ms: number }
  | { kind: 'event'; name: string }
  | { kind: 'condition'; expr: ConditionExprV1; pollMs: number }
  | { kind: 'end' }

type RuntimeNav =
  | { type: 'gotoNode'; nodeId: string; delayMs?: number }
  | { type: 'restart' }
  | { type: 'backToHub'; url?: string }
  | null

type RuntimeState = {
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

function buildDefaultVars(vars: StateVarDefV1[] | undefined): Record<string, any> {
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

function evalConditionValue(val: any, vars: Record<string, any>) {
  try {
    if (val && typeof val === 'object' && typeof val.var === 'string') return vars[String(val.var)]
  } catch {}
  return val
}

function cmp(a: any, b: any) {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  const sa = String(a)
  const sb = String(b)
  if (sa === sb) return 0
  return sa < sb ? -1 : 1
}

function evalConditionExpr(expr: ConditionExprV1 | null | undefined, vars: Record<string, any>): boolean {
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

function normalizeAdvance(a: TimelineAdvanceV1 | any): TimelineAdvanceV1 {
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

function defaultEndingCardForNode(node: NodeV1): EndingCardV1 {
  return {
    title: '',
    bullets: [],
    moral: String(node.body?.text || '故事结束。'),
    buttons: [{ type: 'restart', label: '重新开始' }]
  }
}

type StageOverride = {
  backgroundAssetId?: string
  placements?: CharacterPlacementV1[]
}

async function renderStage(args: {
  app: Application
  doc: EditorDoc
  node: NodeV1 | null
  stageOverride?: StageOverride | null
  isStale?: () => boolean
}) {
  const { app, doc, node, stageOverride, isStale } = args

  if (isStale && isStale()) return

  app.stage.removeChildren()
  if (!node || !doc.project || !doc.story) return

  const viewW = app.renderer.width
  const viewH = app.renderer.height
  if (!viewW || !viewH) return

  const stageCfg = (doc.project && (doc.project as any).stage) as StageConfigV1 | undefined
  const vp = computeStageViewport(stageCfg, viewW, viewH)

  const root = new Container()
  root.x = vp.offsetX
  root.y = vp.offsetY
  root.scale.set(vp.scale)
  app.stage.addChild(root)

  // background
  try {
    const bgId = stageOverride?.backgroundAssetId ?? node.visuals?.backgroundAssetId
    if (bgId) {
      const a = (doc.project.assets || []).find((x) => x.id === bgId)
      if (a?.uri) {
        const url = resolveAsset(a.uri, doc.assetBase)
        const tex = await loadTexture(url)
        if (isStale && isStale()) return
        if (!tex) {
          try {
            console.warn('[game_studio] background texture missing:', url)
          } catch {}
        } else {
          const s = new Sprite(tex)
          s.x = 0
          s.y = 0
          s.width = vp.stageW
          s.height = vp.stageH
          root.addChild(s)
        }
      }
    }
  } catch {}

  // placements
  try {
    const placements = Array.isArray(stageOverride?.placements)
      ? stageOverride?.placements
      : Array.isArray(node.visuals?.placements)
        ? node.visuals?.placements
        : []
    const ordered = placements.slice().sort((a, b) => numberOr(a.zIndex, 0) - numberOr(b.zIndex, 0))
    for (const p of ordered) {
      if (p.visible === false) continue
      const ch = (doc.project.characters || []).find((c) => c.id === p.characterId)
      const imageAssetId = String(p.imageAssetId || ch?.imageAssetId || '').trim()
      if (!imageAssetId) continue
      const a = (doc.project.assets || []).find((x) => x.id === imageAssetId)
      if (!a?.uri) continue

      const url = resolveAsset(a.uri, doc.assetBase)
      const tex = await loadTexture(url)
      if (isStale && isStale()) return
      if (!tex) continue
      const sp = new Sprite(tex)
      sp.anchor.set(0.5, 1)

      const x = clamp01(numberOr(p.transform?.x, 0.5))
      const y = clamp01(numberOr(p.transform?.y, 1))
      const scale = numberOr(p.transform?.scale, 1)
      const rot = numberOr(p.transform?.rotationDeg, 0)

      sp.x = vp.stageW * x
      sp.y = vp.stageH * y
      sp.scale.set(scale)
      sp.rotation = (rot * Math.PI) / 180

      root.addChild(sp)
    }
  } catch {}
}

function normalizeDialogPreset(v: any): DialogPresetV1 {
  const s = String(v || '').trim()
  const allowed: Record<string, true> = { bottom: true, top: true, left: true, right: true, center: true, custom: true }
  return (allowed[s] ? s : 'bottom') as DialogPresetV1
}

function normalizeChoicesDirection(v: any): ChoicesDirectionV1 {
  const s = String(v || '').trim()
  return (s === 'column' ? 'column' : 'row') as ChoicesDirectionV1
}

function normalizeChoicesAlign(v: any): ChoicesAlignV1 {
  const s = String(v || '').trim()
  const allowed: Record<string, true> = { start: true, center: true, end: true, stretch: true }
  return (allowed[s] ? s : 'center') as ChoicesAlignV1
}

function normalizeStageV1(raw: any): StageConfigV1 {
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

function normalizeProjectV1(raw: any): ProjectV1 {
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

function ensureTimelineForNode(n: NodeV1): NodeV1 {
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

function normalizeStoryV1(raw: any): StoryV1 {
  const s = (raw || {}) as any
  const nodesIn = Array.isArray(s.nodes) ? s.nodes : []
  const nodes = nodesIn.map((n: any) => ensureTimelineForNode(n))
  const startNodeId = String(s.startNodeId || (nodes[0] && nodes[0].id) || '')
  return { schemaVersion: String(s.schemaVersion || '1.0'), startNodeId, nodes }
}

  function validate(doc: EditorDoc): string[] {
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


export default function ComposeStudio(props: { projectId?: string | null; onBack?: () => void; onBackToHub?: () => void }) {
  const [projects, setProjects] = useState<ProjectV1[]>([])

  const [doc, setDoc] = useState<EditorDoc>({
    mode: 'none',
    readonly: false,
    id: '',
    title: '',
    assetBase: '',
    project: null,
    story: null
  })

  const [selection, setSelection] = useState<Selection>({ type: 'none' })
  const [leftTab, setLeftTab] = useState<LeftTab>('nodes')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [runtimeStartNodeId, setRuntimeStartNodeId] = useState<string>('')
  const [blueprintLoaded, setBlueprintLoaded] = useState(false)
  const [blueprintNodeIds, setBlueprintNodeIds] = useState<string[]>([])
  const [scriptsDoc, setScriptsDoc] = useState<ScriptDocV1 | null>(null)
  const [latestExportModal, setLatestExportModal] = useState<{ open: boolean; mode: 'preview' | 'publish' }>({
    open: false,
    mode: 'preview'
  })
  const latestExportActionResolverRef = useRef<((action: LatestExportAction) => void) | null>(null)

	  const [rightFold, setRightFold] = useState<{
	    nodeProps: boolean
	    nodeContent: boolean
	    timeline: boolean
	    background: boolean
	    choices: boolean
	    placements: boolean
	  }>({
	    nodeProps: true,
	    nodeContent: true,
	    timeline: true,
	    background: true,
	    choices: true,
	    placements: false
	  })

  const toggleRightFold = (key: keyof typeof rightFold) =>
    setRightFold((prev) => ({
      ...prev,
      [key]: !prev[key]
    }))

  const [previewNodeId, setPreviewNodeId] = useState<string>('')
  const [activePlacementId, setActivePlacementId] = useState<string>('')

  const showProjectManager = !props.onBack && !props.onBackToHub && !props.projectId

  const [rt, setRt] = useState<RuntimeState>({
    stepIndex: 0,
    text: '',
    toast: '',
    endingCard: null,
    wait: { kind: 'auto' },
    vars: {},
    eventMemory: {},
    stageOverride: {},
    nav: null
  })
  const rtRef = useRef<RuntimeState>(rt)
  const rtTimersRef = useRef<{ timeoutId: number | null; pollId: number | null }>({ timeoutId: null, pollId: null })

  const [aiOpen, setAiOpen] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiAnalyzing, setAiAnalyzing] = useState(false)
  const [aiError, setAiError] = useState('')
  const HUB_TEMPLATE_FIELDS_KEY = 'game_studio.ai.templateFields'
  const AI_BG_DRAFT_KEY = `game_studio.ai.backgroundDraft.${String(props.projectId || 'global')}`
  const loadAiBackgroundDraft = (key: string): Partial<AiBackgroundRequest> | null => {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return null
      const json = JSON.parse(raw)
      if (!json || typeof json !== 'object') return null
      const v: any = json
      const out: Partial<AiBackgroundRequest> = {}
      if (typeof v.userInput === 'string') out.userInput = v.userInput
      if (typeof v.globalPrompt === 'string') out.globalPrompt = v.globalPrompt
      if (typeof v.globalNegativePrompt === 'string') out.globalNegativePrompt = v.globalNegativePrompt
      if (typeof v.backgroundOnly === 'boolean') out.backgroundOnly = v.backgroundOnly
      if (typeof v.prompt === 'string') out.prompt = v.prompt
      if (typeof v.negativePrompt === 'string') out.negativePrompt = v.negativePrompt
      if (typeof v.aspectRatio === 'string') out.aspectRatio = v.aspectRatio as any
      if (typeof v.style === 'string') out.style = v.style as any
      if (v.width != null && Number.isFinite(Number(v.width))) out.width = Number(v.width)
      if (v.height != null && Number.isFinite(Number(v.height))) out.height = Number(v.height)
      if (v.steps != null && Number.isFinite(Number(v.steps))) out.steps = Number(v.steps)
      if (v.cfgScale != null && Number.isFinite(Number(v.cfgScale))) out.cfgScale = Number(v.cfgScale)
      return out
    } catch {
      return null
    }
  }
  const saveAiBackgroundDraft = (key: string, draft: AiBackgroundRequest) => {
    try {
      localStorage.setItem(
        key,
        JSON.stringify({
          userInput: String(draft.userInput || ''),
          globalPrompt: String(draft.globalPrompt || ''),
          globalNegativePrompt: String(draft.globalNegativePrompt || ''),
          backgroundOnly: Boolean(draft.backgroundOnly),
          prompt: String(draft.prompt || ''),
          negativePrompt: String(draft.negativePrompt || ''),
          aspectRatio: draft.aspectRatio || '9:16',
          style: draft.style || 'picture_book',
          width: draft.width ?? 768,
          height: draft.height ?? 1024,
          steps: draft.steps ?? 20,
          cfgScale: draft.cfgScale ?? 7,
          updatedAt: new Date().toISOString()
        })
      )
    } catch {}
  }

  const readHubTemplateFields = (): {
    theme: string
    moral: string
    world: string
    protagonist: string
    style: string
    tone: string
    constraints: string
    extra: string
  } | null => {
    try {
      const raw = localStorage.getItem(HUB_TEMPLATE_FIELDS_KEY)
      if (!raw) return null
      const json = JSON.parse(raw) as any
      if (!json || typeof json !== 'object') return null
      return {
        theme: String(json.theme || '').trim(),
        moral: String(json.moral || '').trim(),
        world: String(json.world || '').trim(),
        protagonist: String(json.protagonist || '').trim(),
        style: String(json.style || '').trim(),
        tone: String(json.tone || '').trim(),
        constraints: String(json.constraints || '').trim(),
        extra: String(json.extra || '').trim()
      }
    } catch {
      return null
    }
  }

  const mapTemplateStyleToStoryboardStyle = (
    styleText: string
  ): StoryboardBatchState['style'] => {
    const s = String(styleText || '').toLowerCase()
    if (s.includes('国风') || s.includes('national')) return 'national_style'
    if (s.includes('卡通') || s.includes('cartoon') || s.includes('动漫')) return 'cartoon'
    if (s.includes('水彩') || s.includes('watercolor')) return 'watercolor'
    return 'picture_book'
  }

  const buildGlobalPromptFromTemplate = (
    tpl: ReturnType<typeof readHubTemplateFields>,
    projectTitle: string
  ) => {
    const lines: string[] = []
    if (projectTitle) lines.push(`故事名：《${projectTitle}》`)
    if (!tpl) return lines.join('\n').trim()
    if (tpl.theme) lines.push(`故事主题：${tpl.theme}`)
    if (tpl.moral) lines.push(`核心寓意：${tpl.moral}`)
    if (tpl.world) lines.push(`世界观锚点：${tpl.world}`)
    if (tpl.protagonist) lines.push(`主角设定：${tpl.protagonist}`)
    if (tpl.style) lines.push(`视觉风格：${tpl.style}`)
    if (tpl.tone) lines.push(`叙事语气：${tpl.tone}`)
    if (tpl.extra) lines.push(`补充约束：${tpl.extra}`)
    return lines.join('\n').trim()
  }

  const buildGlobalNegativeFromTemplate = (tpl: ReturnType<typeof readHubTemplateFields>) => {
    const base = ['text', 'watermark', 'low quality', 'blurry', 'deformed']
    const c = String(tpl?.constraints || '')
    if (/暴力|血腥/.test(c)) base.push('gore', 'blood')
    if (/恐怖/.test(c)) base.push('horror')
    return Array.from(new Set(base)).join(', ')
  }

  const defaultAiReq: AiBackgroundRequest = {
    userInput: '',
    globalPrompt: '',
    globalNegativePrompt: '',
    backgroundOnly: false,
    prompt: '',
    negativePrompt: '',
    aspectRatio: '9:16',
    style: 'picture_book',
    width: 768,
    height: 1344,
    steps: 20,
    cfgScale: 7
  }

  const [aiReq, setAiReq] = useState<AiBackgroundRequest>(() => {
    const saved = loadAiBackgroundDraft(AI_BG_DRAFT_KEY)
    return { ...defaultAiReq, ...(saved || {}) }
  })
  const [aiLast, setAiLast] = useState<null | { url?: string; assetPath?: string; provider?: string; remoteUrl?: string }>(null)
  const [sbOpen, setSbOpen] = useState(false)
  const [sbBusyGenerate, setSbBusyGenerate] = useState(false)
  const [sbBusyApply, setSbBusyApply] = useState(false)
  const [sbBusyEntity, setSbBusyEntity] = useState(false)
  const [sbQueuePhase, setSbQueuePhase] = useState<'idle' | 'generate' | 'apply'>('idle')
  const [sbQueuePaused, setSbQueuePaused] = useState(false)
  const [sbError, setSbError] = useState('')
  const [sbLogs, setSbLogs] = useState<string[]>([])
  const [sbElapsedMs, setSbElapsedMs] = useState(0)
  const [sbGeneratingNodeId, setSbGeneratingNodeId] = useState('')
  const [sbGeneratingNodeStartedAt, setSbGeneratingNodeStartedAt] = useState(0)
  const [sbGeneratingNodeElapsedMs, setSbGeneratingNodeElapsedMs] = useState(0)
  const [sbItems, setSbItems] = useState<StoryboardBatchItem[]>([])
  const [sbContinuityBusy, setSbContinuityBusy] = useState(false)
  const [sbContinuityReady, setSbContinuityReady] = useState(false)
  const [sbContinuitySummary, setSbContinuitySummary] = useState('')
  const [sbReq, setSbReq] = useState<StoryboardBatchState>({
    entitySpec: '',
    storyBibleJson: '',
    continuity: { ipadapterEnabled: true, requireCharacterRefs: true, controlnetEnabled: false },
    globalPrompt: '',
    globalNegativePrompt: '',
    style: 'picture_book',
    aspectRatio: '9:16',
    width: 768,
    height: 1344,
    steps: 20,
    cfgScale: 7,
    sampler: 'DPM++ 2M',
    scheduler: 'Automatic'
  })
  const bgFileRef = useRef<HTMLInputElement | null>(null)
  const pendingBgAssetIdRef = useRef<string>('')
  const sbQueueRef = useRef<{ paused: boolean; cancelRequested: boolean }>({ paused: false, cancelRequested: false })

  const [chFpBusy, setChFpBusy] = useState(false)
  const [chFpError, setChFpError] = useState('')

  const defaultChDraft: AiCharacterSpriteDraft = {
    globalPrompt: '',
    fingerprintPrompt: '',
    posePrompt: '',
    negativePrompt: '',
    style: 'picture_book',
    width: 720,
    height: 1280,
    steps: 20,
    cfgScale: 7,
    keyThreshold: 80,
    keyFeather: 40,
    crop: true,
    padding: 12
  }

  const [chOpen, setChOpen] = useState(false)
  const [chBusy, setChBusy] = useState(false)
  const [chError, setChError] = useState('')
  const [chDraft, setChDraft] = useState<AiCharacterSpriteDraft>(defaultChDraft)
  const [chGreen, setChGreen] = useState<null | { url?: string; assetPath?: string; provider?: string; remoteUrl?: string }>(null)
  const [chTransparentPreviewUrl, setChTransparentPreviewUrl] = useState<string>('')
  const chTargetRef = useRef<null | { kind: 'character' | 'placement'; characterId: string; nodeId?: string; placementId?: string }>(null)

  useEffect(() => {
    return () => {
      const u = String(chTransparentPreviewUrl || '').trim()
      if (u) {
        try {
          URL.revokeObjectURL(u)
        } catch {}
      }
    }
  }, [chTransparentPreviewUrl])

  useEffect(() => {
    const saved = loadAiBackgroundDraft(AI_BG_DRAFT_KEY)
    if (!saved) return
    setAiReq((prev) => ({ ...defaultAiReq, ...prev, ...saved }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [AI_BG_DRAFT_KEY])

  useEffect(() => {
    saveAiBackgroundDraft(AI_BG_DRAFT_KEY, aiReq)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [AI_BG_DRAFT_KEY, aiReq])

  useEffect(() => {
    if (!(sbBusyGenerate || sbBusyApply)) {
      setSbElapsedMs(0)
      return
    }
    const startedAt = Date.now()
    setSbElapsedMs(0)
    const t = window.setInterval(() => setSbElapsedMs(Date.now() - startedAt), 100)
    return () => window.clearInterval(t)
  }, [sbBusyGenerate, sbBusyApply])

  useEffect(() => {
    if (!(sbBusyGenerate || sbBusyApply) || !sbGeneratingNodeId || sbGeneratingNodeStartedAt <= 0) {
      setSbGeneratingNodeElapsedMs(0)
      return
    }
    const t = window.setInterval(() => setSbGeneratingNodeElapsedMs(Date.now() - sbGeneratingNodeStartedAt), 100)
    return () => window.clearInterval(t)
  }, [sbBusyGenerate, sbBusyApply, sbGeneratingNodeId, sbGeneratingNodeStartedAt])

  const canvasHostRef = useRef<HTMLDivElement | null>(null)
  const appRef = useRef<Application | null>(null)
  const stageRenderSeqRef = useRef(0)
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const stageUiRef = useRef<HTMLDivElement | null>(null)
  const dragDialogRef = useRef<{
    dragging: boolean
    pointerId: number
    stageW: number
    stageH: number
    deltaX: number
    deltaY: number
  } | null>(null)

  async function handleUploadBackground(file: File, targetAssetId?: string) {
    if (!doc.project || !doc.story || doc.readonly) return
    if (selection.type !== 'node') {
      setToast('请先选中一个节点再导入背景')
      return
    }
    const node = (doc.story.nodes || []).find((n) => n.id === selection.id) || null
    const bgId = String(targetAssetId || node?.visuals?.backgroundAssetId || '').trim()
    if (!bgId) {
      setToast('请先在「背景资源」选择一个背景资源')
      return
    }
    const bgAsset = (doc.project.assets || []).find((a) => a.id === bgId) || null
    if (!bgAsset) {
      setToast('当前节点选择的背景资源不存在（请重新选择背景资源）')
      return
    }
    try {
      setBusy(true)
      setError('')
      const { assetPath, url } = await uploadProjectImage(String(doc.project.id), file)
      const nextUri = url ? resolveUrl(url) : assetPath
      setDocProject((p) => {
        const assets = (p.assets || []).map((a) => (a.id === bgId ? { ...a, uri: nextUri, source: { type: 'upload' as const } } : a))
        return { ...p, assets }
      })
      // set as current node background
      setDocStory((s) => ({
        ...s,
        nodes: (s.nodes || []).map((n) =>
          n.id === selection.id
            ? (() => {
                const nn = ensureNode(n)
                return { ...nn, visuals: { ...nn.visuals, backgroundAssetId: bgId } }
              })()
            : n
        )
      }))
      const checkUrl = nextUri
      try {
        const resp = await fetch(checkUrl, { method: 'HEAD' })
        if (!resp.ok) {
          setToast('已上传背景，但访问失败（检查 server 静态路径）')
        } else {
          setToast('已更新背景图片')
        }
      } catch {
        setToast('已上传背景，但访问失败（检查 server 静态路径）')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    rtRef.current = rt
  }, [rt])

  useEffect(() => {
    void (async () => {
      try {
        setProjects(await listProjects())
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [])
  useEffect(() => {
    const host = canvasHostRef.current
    if (!host) return

    let disposed = false
    let app: Application | null = null

    // track viewport size for DOM overlay (virtual stage)
    try {
      const update = () => setCanvasSize({ w: Math.max(0, host.clientWidth), h: Math.max(0, host.clientHeight) })
      update()
      const ro = new ResizeObserver(() => update())
      ro.observe(host)
      ;(host as any).__gs_ro = ro
    } catch {}

    void (async () => {
      try {
        const a = new Application()
        await a.init({ backgroundAlpha: 0, resizeTo: host, antialias: true })
        if (disposed) {
          try {
            a.destroy(true)
          } catch {}
          return
        }
        host.appendChild(a.canvas)
        appRef.current = a
        app = a
      } catch (e) {
        try {
          console.error('[game_studio] pixi init failed:', e)
        } catch {}
      }
    })()

    return () => {
      disposed = true
      try {
        const ro = (host as any).__gs_ro as ResizeObserver | undefined
        if (ro) ro.disconnect()
        delete (host as any).__gs_ro
      } catch {}
      try {
        if (appRef.current === app) appRef.current = null
      } catch {}
      try {
        app?.destroy(true)
      } catch {}
      try {
        host.replaceChildren()
      } catch {}
    }
  }, [])

  const nodes = useMemo(() => (doc.story?.nodes ? doc.story.nodes : []), [doc.story])
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const blueprintNodeIdSet = useMemo(() => new Set(blueprintNodeIds), [blueprintNodeIds])
  const scriptCardById = useMemo(() => {
    const entries: [string, any][] = []
    for (const c of scriptsDoc?.cards || []) {
      const id = String((c as any)?.id || '').trim()
      if (!id) continue
      entries.push([id, c])
    }
    return new Map<string, any>(entries)
  }, [scriptsDoc])

  const nodesForList = useMemo(() => {
    const list = nodes.slice()
    list.sort((a: any, b: any) => {
      if (String(a.kind || '') !== String(b.kind || '')) return String(a.kind || '') === 'scene' ? -1 : 1
      const sa = String(a.blueprint?.scriptCardId || '')
      const sb = String(b.blueprint?.scriptCardId || '')
      const oa = Number((scriptCardById.get(sa) as any)?.order ?? 1e9)
      const ob = Number((scriptCardById.get(sb) as any)?.order ?? 1e9)
      if (oa !== ob) return oa - ob
      return String(a.name || a.id).localeCompare(String(b.name || b.id))
    })
    return list
  }, [nodes, scriptCardById])

  const nodeLabel = (n: any) => {
    if (String(n.kind || '') !== 'scene') return String(n.name || n.id)
    const sc = scriptCardById.get(String(n.blueprint?.scriptCardId || ''))
    return scriptCardLabel(sc) || String(n.name || n.id)
  }

  useEffect(() => {
    if (selection.type === 'node') setPreviewNodeId(selection.id)
  }, [selection])

  const effectivePreviewNode = useMemo(() => {
    const id = previewNodeId
    if (id) return nodeById.get(id) || null
    if (doc.story?.startNodeId) return nodeById.get(doc.story.startNodeId) || null
    return null
  }, [doc.story?.startNodeId, nodeById, previewNodeId])

  const stageViewport = useMemo(() => {
    if (!doc.project) return null
    const viewW = canvasSize.w || appRef.current?.renderer.width || 0
    const viewH = canvasSize.h || appRef.current?.renderer.height || 0
    if (!viewW || !viewH) return null
    return computeStageViewport((doc.project as any).stage as StageConfigV1 | undefined, viewW, viewH)
  }, [canvasSize.h, canvasSize.w, doc.project])

  useEffect(() => {
    clearRuntimeTimers()
    if (!doc.project || !doc.story || !effectivePreviewNode) return
    const node = ensureNode(effectivePreviewNode)
    setRt((prev) => runTimelineStable(enterNodeRuntime(prev), node))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, effectivePreviewNode])

  useEffect(() => {
    const app = appRef.current
    if (!app) return
    const node = effectivePreviewNode ? ensureNode(effectivePreviewNode) : null
    stageRenderSeqRef.current += 1
    const seq = stageRenderSeqRef.current
    void renderStage({
      app,
      doc,
      node,
      stageOverride: rt.stageOverride,
      isStale: () => stageRenderSeqRef.current !== seq
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, effectivePreviewNode, rt.stageOverride])

  useEffect(() => {
    if (!doc.project || !doc.story || !effectivePreviewNode) return
    clearRuntimeTimers()

    const node = ensureNode(effectivePreviewNode)
    const wait = rt.wait

    if (wait.kind === 'timer') {
      const ms = Math.max(0, Math.floor(Number(wait.ms || 0)))
      rtTimersRef.current.timeoutId = window.setTimeout(() => {
        setRt((prev) => runTimelineStable({ ...prev, stepIndex: prev.stepIndex + 1, wait: { kind: 'auto' } }, node))
      }, ms)
      return () => clearRuntimeTimers()
    }

    if (wait.kind === 'condition') {
      const pollMs = Math.max(50, Math.floor(Number(wait.pollMs || 200)))
      rtTimersRef.current.pollId = window.setInterval(() => {
        const cur = rtRef.current
        if (evalConditionExpr(wait.expr, cur.vars)) {
          clearRuntimeTimers()
          setRt((prev) => runTimelineStable({ ...prev, stepIndex: prev.stepIndex + 1, wait: { kind: 'auto' } }, node))
        }
      }, pollMs)
      return () => clearRuntimeTimers()
    }

    return () => clearRuntimeTimers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, effectivePreviewNode?.id, rt.wait])

  useEffect(() => {
    const nav = rt.nav
    if (!nav) return
    if (!doc.story) return

    if (nav.type === 'gotoNode') {
      const delay = Number.isFinite(Number(nav.delayMs)) ? Math.max(0, Math.floor(Number(nav.delayMs))) : 0
      window.setTimeout(() => setSelection({ type: 'node', id: nav.nodeId }), delay)
    } else if (nav.type === 'restart') {
      const defaults = buildDefaultVars(doc.project?.state?.vars)
      setRt((prev) => ({ ...prev, vars: defaults, eventMemory: {}, stageOverride: {}, nav: null }))
      setSelection({ type: 'node', id: runtimeStartNodeId || doc.story.startNodeId })
    } else if (nav.type === 'backToHub') {
      try {
        if (props.onBackToHub) {
          props.onBackToHub()
        } else {
          window.location.reload()
        }
      } catch {
        window.location.reload()
      }
    }

    setRt((prev) => ({ ...prev, nav: null }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt.nav])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(''), 2200)
    return () => window.clearTimeout(t)
  }, [toast])

  useEffect(() => {
    if (!rt.toast) return
    const t = window.setTimeout(() => setRt((prev) => ({ ...prev, toast: '' })), 2200)
    return () => window.clearTimeout(t)
  }, [rt.toast])

  function setDocProject(updater: (p: ProjectV1) => ProjectV1) {
    setDoc((prev) => {
      if (!prev.project) return prev
      return { ...prev, project: updater(prev.project) }
    })
    setDirty(true)
  }

  function setDocStory(updater: (s: StoryV1) => StoryV1) {
    setDoc((prev) => {
      if (!prev.story) return prev
      return { ...prev, story: updater(prev.story) }
    })
    setDirty(true)
  }

  async function refreshProjects() {
    setBusy(true)
    setError('')
    try {
      setProjects(await listProjects())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!props.projectId) return
    // 由上层工作流进入合成层时，自动打开指定项目
    if (doc.mode === 'project' && doc.id === props.projectId) return
    void openProject(String(props.projectId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectId])

  async function openProject(id: string) {
    setBusy(true)
    setError('')
    try {
      const data = await getProject(id)
      let bpLoaded = false
      let bpNodeIds: string[] = []
      try {
        const [bp, sc] = await Promise.all([getBlueprint(id), getScripts(id)])
        bpLoaded = true
        bpNodeIds = Array.isArray((bp as any).nodes) ? (bp as any).nodes.map((x: any) => String(x && x.id || '')).filter(Boolean) : []
        setScriptsDoc(sc)
      } catch {
        bpLoaded = false
        bpNodeIds = []
        setScriptsDoc(null)
      }
      const project = normalizeProjectV1(data.project as any)
      const story = normalizeStoryV1(data.story as any)
      setRt((prev) => ({ ...prev, vars: buildDefaultVars(project.state?.vars), eventMemory: {}, stageOverride: {}, nav: null }))
      setRuntimeStartNodeId(story.startNodeId)
      setBlueprintLoaded(bpLoaded)
      setBlueprintNodeIds(bpNodeIds)
      setDoc({
        mode: 'project',
        readonly: false,
        id: project.id,
        title: project.title,
        assetBase: resolveUrl(`/project-assets/${encodeURIComponent(project.id)}/`),
        project,
        story
      })
      setSelection({ type: 'node', id: story.startNodeId })
      setLeftTab('nodes')
      setDirty(false)
      setToast('项目已打开')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function createNewProject() {
    const title = window.prompt('新项目名称', '未命名故事')
    if (!title) return

    setBusy(true)
    setError('')
    try {
      const p = await createProject(title)
      await refreshProjects()
      await openProject(p.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function saveCurrent() {
    if (doc.mode !== 'project' || !doc.project || !doc.story) return
    setBusy(true)
    setError('')
    try {
      const p = await saveProject(doc.id, { project: doc.project, story: doc.story })
      setDoc((prev) => ({ ...prev, project: p, title: p.title }))
      setDirty(false)
      setToast('已保存')
      await refreshProjects()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function persistCurrentForExport() {
    if (doc.mode !== 'project' || !doc.project || !doc.story) return
    const p = await saveProject(doc.id, { project: doc.project, story: doc.story })
    setDoc((prev) => ({ ...prev, project: p, title: p.title }))
    setDirty(false)
  }

  async function confirmLatestExportAction(): Promise<boolean> {
    if (doc.mode !== 'project') return false
    let items: Array<{ buildId: string }> = []
    try {
      items = await listProjectExports(doc.id)
    } catch {
      items = []
    }
    const hasLatest = items.some((x) => String(x.buildId || '') === 'latest')
    if (!hasLatest) return true
    const pick = await new Promise<LatestExportAction>((resolve) => {
      latestExportActionResolverRef.current = resolve
      setLatestExportModal((prev) => ({ ...prev, open: true }))
    })
    if (pick === 'overwrite') return true
    if (pick === 'delete') {
      try {
        await deleteProjectExport(doc.id, 'latest')
        setToast('已删除旧导出，将继续生成 latest')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return false
      }
      return true
    }
    return false
  }

  function closeLatestExportModal(action: LatestExportAction) {
    const resolver = latestExportActionResolverRef.current
    latestExportActionResolverRef.current = null
    setLatestExportModal((prev) => ({ ...prev, open: false }))
    if (resolver) resolver(action)
  }

  async function saveIfDirty(): Promise<boolean> {
    if (busy) return false
    if (doc.mode !== 'project' || !dirty) return true
    try {
      await saveCurrent()
      return true
    } catch {
      return false
    }
  }

  async function exportCurrent() {
    if (doc.mode !== 'project' || !doc.project) return
    setBusy(true)
    setError('')
    try {
      setLatestExportModal({ open: false, mode: 'preview' })
      const allow = await confirmLatestExportAction()
      if (!allow) return
      if (dirty) await persistCurrentForExport()
      const { distUrl } = await exportProject(doc.id)
      window.open(resolveUrl(distUrl), '_blank', 'noopener,noreferrer')
      setToast('已导出并打开预览')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function exportPublishCurrent() {
    if (doc.mode !== 'project' || !doc.project) return
    setBusy(true)
    setError('')
    try {
      setLatestExportModal({ open: false, mode: 'publish' })
      const allow = await confirmLatestExportAction()
      if (!allow) return
      if (dirty) await persistCurrentForExport()
      const res = await exportPublishPackage(doc.id)
      if (res.packageUrl) {
        window.open(resolveUrl(res.packageUrl), '_blank', 'noopener,noreferrer')
      } else if (res.distUrl) {
        window.open(resolveUrl(res.distUrl), '_blank', 'noopener,noreferrer')
      }
      setToast(`已导出发布包：${res.packageName || 'h5_story.zip'}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function backToStart() {
    if (!doc.story) return
    setSelection({ type: 'node', id: doc.story.startNodeId })
  }

  function restartRuntime() {
    if (!doc.story) return
    const defaults = buildDefaultVars(doc.project?.state?.vars)
    clearRuntimeTimers()
    setRt((prev) => ({ ...prev, vars: defaults, eventMemory: {}, stageOverride: {}, nav: null }))
    setSelection({ type: 'node', id: runtimeStartNodeId || doc.story.startNodeId })
  }

  function clearRuntimeTimers() {
    const t = rtTimersRef.current
    if (t.timeoutId != null) {
      window.clearTimeout(t.timeoutId)
      t.timeoutId = null
    }
    if (t.pollId != null) {
      window.clearInterval(t.pollId)
      t.pollId = null
    }
  }

  function enterNodeRuntime(prev: RuntimeState): RuntimeState {
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

  function applyTimelineAction(state: RuntimeState, action: TimelineActionV1, events: ProjectEventV1[], depth: number): RuntimeState {
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

  function runTimelineStable(prev: RuntimeState, node: NodeV1): RuntimeState {
    if (!doc.project) return prev
    const projectEvents = Array.isArray(doc.project.events) ? doc.project.events : []
    const steps = Array.isArray((node as any).timeline?.steps) ? ((node as any).timeline.steps as any[]) : []

    let state: RuntimeState = {
      ...prev,
      vars: { ...prev.vars },
      eventMemory: { ...prev.eventMemory },
      stageOverride: { ...prev.stageOverride },
      nav: null
    }

    const maxAuto = 60
    let guard = 0
    while (guard++ < maxAuto) {
      if (state.nav) return state
      if (state.endingCard) return { ...state, wait: { kind: 'end' } }

      const step = steps[state.stepIndex] || null
      if (!step) {
        if (Array.isArray(node.choices) && node.choices.length) return { ...state, wait: { kind: 'choice' } }
        if (node.kind === 'ending') return { ...state, wait: { kind: 'end' }, endingCard: state.endingCard || defaultEndingCardForNode(node) }
        return { ...state, wait: { kind: 'end' } }
      }

      const actions = Array.isArray(step.actions) ? step.actions : []
      for (const a of actions) {
        state = applyTimelineAction(state, a as any, projectEvents, 0)
        if (state.nav) return state
        if (state.endingCard) return { ...state, wait: { kind: 'end' } }
      }

      const adv = normalizeAdvance(step.advance)
      const type = String((adv as any).type || 'auto')

      if (type === 'auto') {
        state = { ...state, stepIndex: state.stepIndex + 1, wait: { kind: 'auto' } }
        continue
      }
      if (type === 'click') {
        const cs = Array.isArray(node.choices) ? node.choices : []
        if (cs.length) return { ...state, wait: { kind: 'choice' } }
        return { ...state, wait: { kind: 'click' } }
      }
      if (type === 'choice') {
        const cs = Array.isArray(node.choices) ? node.choices : []
        return cs.length ? { ...state, wait: { kind: 'choice' } } : { ...state, wait: { kind: 'click' }, toast: state.toast || '未配置选项，已降级为「点击继续」' }
      }
      if (type === 'timer') {
        const ms = Math.max(0, Math.floor(Number((adv as any).ms ?? 0)))
        return { ...state, wait: { kind: 'timer', ms } }
      }
      if (type === 'event') {
        const name = String((adv as any).name || '').trim()
        if (!name) return { ...state, wait: { kind: 'click' }, toast: state.toast || 'event 缺少 name，已降级为「点击继续」' }
        if (name && Object.prototype.hasOwnProperty.call(state.eventMemory, name)) {
          const nextMem = { ...state.eventMemory }
          try {
            delete nextMem[name]
          } catch {}
          state = { ...state, stepIndex: state.stepIndex + 1, eventMemory: nextMem, wait: { kind: 'auto' } }
          continue
        }
        return { ...state, wait: { kind: 'event', name } }
      }
      if (type === 'condition') {
        const expr = (adv as any).expr as any
        if (!expr) return { ...state, wait: { kind: 'click' }, toast: state.toast || 'condition 缺少 expr，已降级为「点击继续」' }
        const pollMsRaw = Number((adv as any).pollMs)
        const pollMs = Number.isFinite(pollMsRaw) && pollMsRaw > 0 ? Math.floor(pollMsRaw) : 200
        if (evalConditionExpr(expr, state.vars)) {
          state = { ...state, stepIndex: state.stepIndex + 1, wait: { kind: 'auto' } }
          continue
        }
        return { ...state, wait: { kind: 'condition', expr, pollMs } }
      }
      if (type === 'end') {
        if (node.kind === 'ending') return { ...state, wait: { kind: 'end' }, endingCard: state.endingCard || defaultEndingCardForNode(node) }
        return { ...state, wait: { kind: 'end' } }
      }

      return { ...state, wait: { kind: 'click' } }
    }

    return { ...state, wait: { kind: 'end' }, toast: state.toast || '运行时：auto 步骤过多，已中止' }
  }

function ensureNode(n: NodeV1): NodeV1 {
  const base = ensureTimelineForNode(n)
  const visuals = base.visuals || {}
  const placements = Array.isArray(visuals.placements) ? visuals.placements : []
  const choices = Array.isArray((base as any).choices) ? (base as any).choices : []
  const normalizedChoices = choices.map((c) => ({
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

  function addNode(kind: NodeV1['kind']) {
    if (!doc.story || doc.readonly) return
    window.alert('合成层禁止新增节点；请返回蓝图层调整结构。')
  }

  function deleteNode(nodeId: string) {
    if (!doc.story || doc.readonly) return
    window.alert('合成层禁止删除节点；请返回蓝图层调整结构。')
  }

  function addCharacter() {
    if (!doc.project || doc.readonly) return

    const id = uid('ch')
    const ch: CharacterV1 = { id, name: '新角色' }
    setDocProject((p) => ({ ...p, characters: [...p.characters, ch] }))
    setSelection({ type: 'character', id })
    setLeftTab('characters')
  }

  function deleteCharacter(characterId: string) {
    if (!doc.project || !doc.story || doc.readonly) return
    if (!window.confirm('确定删除该角色？')) return

    setDocProject((p) => ({ ...p, characters: p.characters.filter((c) => c.id !== characterId) }))
    setDocStory((s) => ({
      ...s,
      nodes: s.nodes.map((n) => {
        const nn = ensureNode(n)
        const next = (nn.visuals?.placements || []).filter((p) => p.characterId !== characterId)
        return { ...nn, visuals: { ...nn.visuals, placements: next } }
      })
    }))

    if (selection.type === 'character' && selection.id === characterId) setSelection({ type: 'none' })
  }

  function addAsset() {
    if (!doc.project || doc.readonly) return

    const id = uid('asset')
    const a: AssetV1 = { id, kind: 'image', name: '新资源', uri: '' }
    setDocProject((p) => ({ ...p, assets: [...p.assets, a] }))
    setSelection({ type: 'asset', id })
    setLeftTab('assets')
  }

  function deleteAsset(assetId: string) {
    if (!doc.project || !doc.story || doc.readonly) return
    if (!window.confirm('确定删除该资源？（引用会被清空）')) return

    setDocProject((p) => ({
      ...p,
      assets: p.assets.filter((a) => a.id !== assetId),
      characters: p.characters.map((ch) => (ch.imageAssetId === assetId ? { ...ch, imageAssetId: undefined } : ch))
    }))

    setDocStory((s) => ({
      ...s,
      nodes: s.nodes.map((n) => {
        const nn = ensureNode(n)
        const bg = nn.visuals?.backgroundAssetId === assetId ? undefined : nn.visuals?.backgroundAssetId
        const pls = Array.isArray(nn.visuals?.placements) ? nn.visuals!.placements! : []
        const nextPls = pls.map((p) => (p.imageAssetId === assetId ? { ...p, imageAssetId: undefined } : p))
        return { ...nn, visuals: { ...nn.visuals, backgroundAssetId: bg, placements: nextPls } }
      })
    }))

    if (selection.type === 'asset' && selection.id === assetId) setSelection({ type: 'none' })
  }

  function stageDims() {
    const st = normalizeStageV1((doc.project as any)?.stage)
    return { w: Math.max(1, Math.floor(Number(st.width || 720))), h: Math.max(1, Math.floor(Number(st.height || 1280))) }
  }

  function buildNodeTextSummary(textRaw: string) {
    const lines = String(textRaw || '')
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean)
    const picked: string[] = []
    for (const ln of lines) {
      if (/^选项(?:\d{1,2}|[A-Z])\s*[:：]/i.test(ln)) break
      picked.push(ln)
      if (picked.length >= 8) break
    }
    return picked.join('，').replace(/\s+/g, ' ').trim()
  }

  function buildCharacterContextText(characterId: string) {
    if (!doc.story || !doc.project) return ''
    const ch = (doc.project.characters || []).find((x) => x.id === characterId) || null
    if (!ch) return ''
    const name = String(ch.name || '').trim()
    const out: string[] = []
    for (const n of doc.story.nodes || []) {
      const nn = ensureNode(n as any)
      const placements = Array.isArray(nn.visuals?.placements) ? nn.visuals!.placements! : []
      const hasPlacement = placements.some((p) => p.characterId === characterId)
      const textRaw = String((nn as any).body?.text || '').trim()
      const hasName = name ? textRaw.includes(name) : false
      if (!hasPlacement && !hasName) continue
      const sum = buildNodeTextSummary(textRaw)
      if (sum) out.push(`${String((nn as any).name || nn.id)}：${sum}`)
      if (out.length >= 3) break
    }
    return out.join('\n').slice(0, 900)
  }

  function buildSceneCharacterLocks(node: NodeV1 | null) {
    if (!node || !doc.project) return ''
    const placements = Array.isArray((node as any).visuals?.placements) ? ((node as any).visuals.placements as any[]) : []
    const ids: string[] = []
    for (const p of placements) {
      const id = String(p && p.characterId || '').trim()
      if (id) ids.push(id)
    }
    const uniq = Array.from(new Set(ids))
    const fps: string[] = []
    for (const id of uniq) {
      const ch = (doc.project.characters || []).find((x) => x.id === id) || null
      const fp = String(ch && ch.ai && ch.ai.fingerprintPrompt ? ch.ai.fingerprintPrompt : '').replace(/\s+/g, ' ').trim()
      if (fp) fps.push(fp)
    }
    if (!fps.length) return ''
    return `角色设定（用于一致性锁定，非每个场景都出现）：${fps.join('；')}`.slice(0, 500)
  }

  function nowHms() {
    try {
      return new Date().toLocaleTimeString()
    } catch {
      return String(Date.now())
    }
  }

  function appendSbLog(msg: string) {
    const line = `[${nowHms()}] ${String(msg || '').trim()}`
    setSbLogs((prev) => [line, ...prev].slice(0, 300))
  }

  function resetSbQueueControl() {
    sbQueueRef.current = { paused: false, cancelRequested: false }
    setSbQueuePaused(false)
  }

  function pauseSbQueue() {
    if (!(sbBusyGenerate || sbBusyApply)) return
    if (sbQueueRef.current.paused) return
    sbQueueRef.current = { ...sbQueueRef.current, paused: true }
    setSbQueuePaused(true)
    appendSbLog('任务已暂停：当前场景结束后停止推进，点击“继续任务”可恢复')
  }

  function resumeSbQueue() {
    if (!(sbBusyGenerate || sbBusyApply)) return
    if (!sbQueueRef.current.paused) return
    sbQueueRef.current = { ...sbQueueRef.current, paused: false }
    setSbQueuePaused(false)
    appendSbLog('任务已继续')
  }

  function cancelSbQueue() {
    if (!(sbBusyGenerate || sbBusyApply)) return
    if (sbQueueRef.current.cancelRequested) return
    sbQueueRef.current = { ...sbQueueRef.current, cancelRequested: true, paused: false }
    setSbQueuePaused(false)
    appendSbLog('已请求取消：当前场景结束后停止，已完成项会保留，可稍后继续未完成任务')
  }

  async function waitForSbQueueGate() {
    // P1:storyboard-prompt
    // 任务门控：支持“暂停/取消”，并保证当前项完成后再安全切换状态。
    while (sbQueueRef.current.paused && !sbQueueRef.current.cancelRequested) {
      await new Promise((r) => window.setTimeout(r, 120))
    }
    return !sbQueueRef.current.cancelRequested
  }

  function buildSceneUserInputForBatch(node: NodeV1, projectTitle: string) {
    const nn = ensureNode(node)
    const title = String((nn as any).body?.title || nn.name || '').trim()
    const textRaw = String((nn as any).body?.text || '').trim()
    const main = buildNodeTextSummary(textRaw)
    const core = [title, main].filter(Boolean).join('：').slice(0, 600)
    if (!core) return ''
    if (projectTitle && !/故事名[:：]\s*《/.test(core)) return `故事名：《${projectTitle}》\n${core}`
    return core
  }

  function buildWholeStoryUserInputForGlobal(projectTitle: string) {
    if (!doc.story) return ''
    const scenes = (doc.story.nodes || []).map((n) => ensureNode(n as any)).filter((n) => n.kind === 'scene' || n.kind === 'ending')
    const lines: string[] = []
    if (projectTitle) lines.push(`故事名：《${projectTitle}》`)
    lines.push('任务：基于以下全部场景/结局摘要，提炼全故事统一世界观锚点，并抽取角色、道具、地点、事件链与禁用替代项。')
    let total = lines.join('\n').length
    for (let i = 0; i < scenes.length; i++) {
      const n = scenes[i]
      const title = String((n as any).body?.title || n.name || `场景${i + 1}`).trim()
      const main = buildNodeTextSummary(String((n as any).body?.text || '').trim())
      if (!title && !main) continue
      const ln = `场景${i + 1} ${title}：${main}`
      if (total + ln.length + 1 > 3200) break
      lines.push(ln)
      total += ln.length + 1
    }
    return lines.join('\n').trim()
  }

  function enforceEntitySpecQuality(entitySpec: string) {
    let out = String(entitySpec || '').trim()
    if (!out) return ''
    const ensureSection = (name: string, fallback: string) => {
      const re = new RegExp(`(^|\\n)\\s*${name}\\s*:`, 'i')
      if (!re.test(out)) out = `${out}\n${name}: ${fallback}`
    }
    ensureSection('WORLD_ANCHOR', 'same era, same architecture language, stable palette and lighting, consistent camera language across all scenes')
    ensureSection('CHARACTER_LOCKS', 'for each core character: fixed age range, hairstyle, silhouette, fabric type, accessory, color palette')
    ensureSection('PROP_LOCKS', 'for each key prop/object: canonical name, structure/components, material, shape, scale, how it is held/used')
    ensureSection('EVENT_CHAIN', 'scene-by-scene visible actions and state changes; keep causality and continuity')
    ensureSection('FORBIDDEN_SUBSTITUTES', 'list visually similar but incorrect objects that must never appear')
    return out.trim()
  }

  function normalizeStoryBibleText(raw: any) {
    const s = String(raw || '').trim()
    if (!s) return ''
    // Users may paste with markdown fences.
    return s.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim()
  }

  function tryParseStoryBibleJson(raw: any) {
    const text = normalizeStoryBibleText(raw)
    if (!text) return null
    try {
      const obj = JSON.parse(text)
      if (!obj || typeof obj !== 'object') return null
      return obj
    } catch {
      return null
    }
  }

  function buildEntitySpecFromStoryBible(storyBibleObj: any) {
    const b = storyBibleObj && typeof storyBibleObj === 'object' ? storyBibleObj : {}
    const world = String(b.worldAnchor || '').trim()
    const chars = Array.isArray(b.characters) ? b.characters : []
    const props = Array.isArray(b.props) ? b.props : []
    const ev = Array.isArray(b.eventChain) ? b.eventChain : []
    const forb = Array.isArray(b.forbiddenSubstitutes) ? b.forbiddenSubstitutes : []

    const chLines: string[] = []
    for (const c of chars) {
      if (!c || typeof c !== 'object') continue
      if (c.locked === false) continue
      const name = String((c as any).name || (c as any).id || '').trim()
      const anchor = String((c as any).anchorPrompt || '').trim()
      if (!name || !anchor) continue
      chLines.push(`${name}: ${anchor}`)
      if (chLines.length >= 30) break
    }

    const propLines: string[] = []
    for (const p of props) {
      if (!p || typeof p !== 'object') continue
      if (p.locked === false) continue
      const name = String((p as any).name || (p as any).id || '').trim()
      const anchor = String((p as any).anchorPrompt || '').trim()
      if (!name || !anchor) continue
      const subs = Array.isArray((p as any).forbiddenSubstitutes) ? (p as any).forbiddenSubstitutes : []
      const subsLine = subs.length ? ` (forbidden: ${subs.map((x: any) => String(x || '').trim()).filter(Boolean).slice(0, 6).join(', ')})` : ''
      propLines.push(`${name}: ${anchor}${subsLine}`)
      if (propLines.length >= 40) break
    }

    const eventLines: string[] = []
    for (const x of ev) {
      const s = String(x || '').trim()
      if (!s) continue
      eventLines.push(s)
      if (eventLines.length >= 30) break
    }

    const forbLine = forb.map((x: any) => String(x || '').trim()).filter(Boolean).slice(0, 50).join(', ')

    const out =
      `WORLD_ANCHOR: ${world || 'same story world, same era and geography, stable art direction'}\n` +
      `CHARACTER_LOCKS: ${chLines.length ? chLines.join('; ') : 'for each core character: fixed age range, hairstyle, silhouette, fabric type, accessory, color palette'}\n` +
      `PROP_LOCKS: ${propLines.length ? propLines.join('; ') : 'for each key prop/object: canonical name, structure/components, material, shape, scale, how it is held/used'}\n` +
      `EVENT_CHAIN: ${eventLines.length ? eventLines.join(' | ') : 'scene-by-scene visible actions and state changes; keep causality and continuity'}\n` +
      `FORBIDDEN_SUBSTITUTES: ${forbLine || 'list visually similar but incorrect objects that must never appear'}`

    return enforceEntitySpecQuality(out)
  }

  function collectStoryboardUsedCharacters(): CharacterV1[] {
    if (!doc.project || !doc.story) return []
    const byId = new Map((doc.project.characters || []).map((c) => [String(c.id || ''), c]))
    const used = new Set<string>()
    for (const n0 of doc.story.nodes || []) {
      const n = ensureNode(n0 as any)
      if (!(n.kind === 'scene' || n.kind === 'ending')) continue
      const placements = Array.isArray((n as any).visuals?.placements) ? ((n as any).visuals.placements as any[]) : []
      for (const p of placements) {
        const id = String(p && p.characterId ? p.characterId : '').trim()
        if (id) used.add(id)
      }
    }
    const out: CharacterV1[] = []
    for (const id of Array.from(used)) {
      const ch = byId.get(id) || null
      if (ch) out.push(ch)
    }
    return out
  }

  async function runStoryboardContinuityTest() {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbContinuityBusy || sbBusyGenerate || sbBusyApply || sbBusyEntity) return
    setSbContinuityBusy(true)
    setSbContinuityReady(false)
    setSbContinuitySummary('')
    appendSbLog('开始运行连续分镜锁定测试...')
    try {
      const storyBibleObj = tryParseStoryBibleJson(sbReq.storyBibleJson)
      if (!storyBibleObj) throw new Error('Story Bible 为空或不是合法 JSON')

      // 1) Provider preflight (ComfyUI storyboard extras).
      const pf = await preflightStudioImage({ timeoutMs: 12_000, mode: 'storyboard' })
      if (!pf.ok) throw new Error(`ComfyUI 体检失败：${String(pf.checks?.reason || 'preflight_failed')}`)

      // 2) Character reference binding check.
      const cfg = sbReq.continuity || { ipadapterEnabled: false, requireCharacterRefs: true, controlnetEnabled: false }
      if (cfg.ipadapterEnabled && cfg.requireCharacterRefs) {
        const usedChars = collectStoryboardUsedCharacters()
        const assetsById = new Map((doc.project.assets || []).map((a) => [String(a.id || ''), a]))
        const missing: string[] = []
        for (const ch of usedChars) {
          const refId = String(ch.ai?.referenceAssetId || '').trim()
          if (!refId) {
            missing.push(String(ch.name || ch.id))
            continue
          }
          const asset = assetsById.get(refId) || null
          if (!asset || !String(asset.uri || '').trim()) missing.push(String(ch.name || ch.id))
        }
        if (missing.length) throw new Error(`缺少角色参考图：${missing.slice(0, 8).join(', ')}`)
      }

      // 3) Basic image test (ensures current provider can actually render).
      const test = await testStudioImage({
        prompt: "children's picture book illustration, a simple test scene, clean outlines, warm palette",
        negativePrompt: 'text, watermark, logo, photorealistic',
        style: 'picture_book',
        width: 512,
        height: 512,
        steps: Math.max(10, Math.min(30, Number(sbReq.steps || 20))),
        cfgScale: Number(sbReq.cfgScale || 6.5),
        sampler: String(sbReq.sampler || 'DPM++ 2M'),
        scheduler: String(sbReq.scheduler || 'Karras'),
        timeoutMs: 120_000
      })
      if (!test || !String(test.dataUrl || '').startsWith('data:image/')) throw new Error('测试出图失败：无 dataUrl')

      setSbContinuityReady(true)
      setSbContinuitySummary('通过（ComfyUI 依赖就绪 + 参考绑定满足 + 测试出图成功）')
      appendSbLog('连续分镜锁定测试通过')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbContinuityReady(false)
      setSbContinuitySummary(msg)
      appendSbLog(`连续分镜锁定测试失败：${msg}`)
    } finally {
      setSbContinuityBusy(false)
    }
  }

  async function generateStoryboardCharacterReference(characterId: string) {
    if (doc.mode !== 'project' || !doc.project) return
    const ch = (doc.project.characters || []).find((x) => x.id === characterId) || null
    if (!ch) return
    const fp = String(ch.ai?.fingerprintPrompt || '').trim()
    if (!fp) {
      setToast('缺少 fingerprintPrompt：请先生成角色指纹')
      return
    }
    appendSbLog(`开始生成角色参考图：${String(ch.name || ch.id)}`)
    const dims = { w: 768, h: 768 }
    try {
      const res = await generateCharacterReferenceAi(String(doc.project.id), {
        characterName: String(ch.name || ch.id),
        globalPrompt: String(sbReq.globalPrompt || '').trim(),
        fingerprintPrompt: fp,
        negativePrompt: String(ch.ai?.negativePrompt || '').trim(),
        style: sbReq.style,
        width: dims.w,
        height: dims.h,
        steps: Math.max(12, Math.min(32, Number(sbReq.steps || 24))),
        cfgScale: Number(sbReq.cfgScale || 6.0)
      })
      const nextUri = res.url ? resolveUrl(res.url) : res.assetPath
      const provider = String(res.provider || '') as any
      const usedPrompt = [String(sbReq.globalPrompt || '').trim(), fp, 'reference portrait'].filter(Boolean).join('，').slice(0, 1800)

      setDocProject((p) => {
        const assets = [...(p.assets || [])]
        const currCh = (p.characters || []).find((x) => x.id === characterId) || null
        const refId = String(currCh?.ai?.referenceAssetId || '').trim()
        const idx = refId ? assets.findIndex((a) => a.id === refId) : -1
        let assetId = refId
        if (idx >= 0) {
          const old = assets[idx]
          assets[idx] = { ...old, uri: nextUri, source: { type: 'ai' as const, prompt: usedPrompt, provider } }
        } else {
          assetId = uid('asset')
          assets.push({ id: assetId, kind: 'image', name: `AI 参考 ${String(currCh?.name || currCh?.id || '')}`.trim() || 'AI 参考', uri: nextUri, source: { type: 'ai' as const, prompt: usedPrompt, provider } })
        }
        const nextChars = (p.characters || []).map((x) => {
          if (x.id !== characterId) return x
          const ai = (x.ai && typeof x.ai === 'object') ? x.ai : {}
          return { ...x, ai: { ...ai, referenceAssetId: assetId } }
        })
        return { ...p, assets, characters: nextChars }
      })
      appendSbLog(`角色参考图已生成并绑定：${String(ch.name || ch.id)}`)
      setToast('已生成并绑定角色参考图')
      setSbContinuityReady(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      appendSbLog(`角色参考图生成失败：${String(ch.name || ch.id)} - ${msg}`)
      setToast(msg)
    }
  }

  function bindStoryboardCharacterRefFromSprite(characterId: string) {
    if (doc.mode !== 'project' || !doc.project) return
    const ch = (doc.project.characters || []).find((x) => x.id === characterId) || null
    const spriteId = String(ch?.imageAssetId || '').trim()
    if (!ch || !spriteId) return
    setDocProject((p) => ({
      ...p,
      characters: (p.characters || []).map((x) => {
        if (x.id !== characterId) return x
        const ai = (x.ai && typeof x.ai === 'object') ? x.ai : {}
        return { ...x, ai: { ...ai, referenceAssetId: spriteId } }
      })
    }))
    appendSbLog(`已绑定角色图为参考：${String(ch.name || ch.id)}`)
    setSbContinuityReady(false)
  }

  function clearStoryboardCharacterRef(characterId: string) {
    if (doc.mode !== 'project' || !doc.project) return
    const ch = (doc.project.characters || []).find((x) => x.id === characterId) || null
    if (!ch) return
    setDocProject((p) => ({
      ...p,
      characters: (p.characters || []).map((x) => {
        if (x.id !== characterId) return x
        const ai = (x.ai && typeof x.ai === 'object') ? x.ai : {}
        const nextAi: any = { ...ai }
        delete nextAi.referenceAssetId
        return { ...x, ai: nextAi }
      })
    }))
    appendSbLog(`已清除角色参考绑定：${String(ch.name || ch.id)}`)
    setSbContinuityReady(false)
  }

  function readStoryboardSceneMapFromProject(project: ProjectV1 | null | undefined) {
    const st = project && (project as any).state && typeof (project as any).state === 'object' ? (project as any).state : {}
    const aiBg = st && (st as any).aiBackground && typeof (st as any).aiBackground === 'object' ? (st as any).aiBackground : {}
    const raw = aiBg && (aiBg as any).storyboardScenes && typeof (aiBg as any).storyboardScenes === 'object'
      ? (aiBg as any).storyboardScenes
      : {}
    const out: Record<string, StoryboardScenePromptStore> = {}
    for (const [k, v] of Object.entries(raw || {})) {
      if (!v || typeof v !== 'object') continue
      const id = String((v as any).nodeId || k || '').trim()
      if (!id) continue
      out[id] = {
        nodeId: id,
        nodeName: String((v as any).nodeName || id).trim() || id,
        userInput: String((v as any).userInput || '').trim(),
        prompt: String((v as any).prompt || '').trim(),
        negativePrompt: String((v as any).negativePrompt || '').trim(),
        updatedAt: String((v as any).updatedAt || '').trim() || new Date().toISOString()
      }
    }
    return out
  }

  function readStoryboardPromptMetaFromProject(project: ProjectV1 | null | undefined): StoryboardPromptMeta | null {
    const st = project && (project as any).state && typeof (project as any).state === 'object' ? (project as any).state : {}
    const aiBg = st && (st as any).aiBackground && typeof (st as any).aiBackground === 'object' ? (st as any).aiBackground : {}
    const meta = aiBg && (aiBg as any).storyboardPromptMeta && typeof (aiBg as any).storyboardPromptMeta === 'object'
      ? (aiBg as any).storyboardPromptMeta
      : null
    if (!meta) return null
    const style = String((meta as any).style || '').trim()
    const aspectRatio = String((meta as any).aspectRatio || '').trim()
    if (!style && !aspectRatio) return null
    return {
      style,
      aspectRatio,
      updatedAt: String((meta as any).updatedAt || '').trim() || ''
    }
  }

  function readStoryboardBatchDraftFromProject(project: ProjectV1 | null | undefined): Partial<StoryboardBatchDraft> | null {
    const st = project && (project as any).state && typeof (project as any).state === 'object' ? (project as any).state : {}
    const aiBg = st && (st as any).aiBackground && typeof (st as any).aiBackground === 'object' ? (st as any).aiBackground : {}
    const d = aiBg && (aiBg as any).storyboardBatchDraft && typeof (aiBg as any).storyboardBatchDraft === 'object'
      ? (aiBg as any).storyboardBatchDraft
      : null
    if (!d) return null
    const out: Partial<StoryboardBatchDraft> = {}
    const style = String((d as any).style || '').trim()
    const ar = String((d as any).aspectRatio || '').trim()
    if (style === 'picture_book' || style === 'cartoon' || style === 'national_style' || style === 'watercolor') out.style = style
    if (ar === '9:16' || ar === '16:9' || ar === '1:1' || ar === '9:1') out.aspectRatio = ar
    if (Number.isFinite(Number((d as any).width))) out.width = Number((d as any).width)
    if (Number.isFinite(Number((d as any).height))) out.height = Number((d as any).height)
    if (Number.isFinite(Number((d as any).steps))) out.steps = Number((d as any).steps)
    if (Number.isFinite(Number((d as any).cfgScale))) out.cfgScale = Number((d as any).cfgScale)
    if (String((d as any).sampler || '').trim()) out.sampler = String((d as any).sampler || '').trim()
    if (String((d as any).scheduler || '').trim()) out.scheduler = String((d as any).scheduler || '').trim()
    return out
  }

  function upsertStoryboardBatchDraft(patch: Partial<StoryboardBatchState>) {
    if (doc.mode !== 'project') return
    setDocProject((p) => {
      const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
      const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
      const prev = (aiBgIn as any).storyboardBatchDraft && typeof (aiBgIn as any).storyboardBatchDraft === 'object'
        ? (aiBgIn as any).storyboardBatchDraft
        : {}
      const nextDraft = {
        ...prev,
        ...patch,
        updatedAt: new Date().toISOString()
      }
      const nextState = { ...stateIn, aiBackground: { ...aiBgIn, storyboardBatchDraft: nextDraft } }
      return { ...p, state: nextState }
    })
  }

  function upsertStoryboardScenePrompt(nodeId: string, nodeName: string, patch: Partial<StoryboardScenePromptStore>) {
    if (doc.mode !== 'project') return
    const id = String(nodeId || '').trim()
    if (!id) return
    const name = String(nodeName || id).trim() || id
    setDocProject((p) => {
      const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
      const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
      const mapIn = (aiBgIn as any).storyboardScenes && typeof (aiBgIn as any).storyboardScenes === 'object' ? (aiBgIn as any).storyboardScenes : {}
      const prev = mapIn[id] && typeof mapIn[id] === 'object' ? mapIn[id] : {}
      const nextEntry: StoryboardScenePromptStore = {
        nodeId: id,
        nodeName: String((patch as any).nodeName || prev.nodeName || name || id).trim() || id,
        userInput: patch.userInput != null ? String(patch.userInput || '').trim() : String(prev.userInput || '').trim(),
        prompt: patch.prompt != null ? String(patch.prompt || '').trim() : String(prev.prompt || '').trim(),
        negativePrompt: patch.negativePrompt != null ? String(patch.negativePrompt || '').trim() : String(prev.negativePrompt || '').trim(),
        updatedAt: new Date().toISOString()
      }
      const nextScenes = { ...mapIn, [id]: nextEntry }
      const nextState = { ...stateIn, aiBackground: { ...aiBgIn, storyboardScenes: nextScenes } }
      return { ...p, state: nextState }
    })
  }

  function openAiStoryboardForCurrentNode() {
    if (doc.mode !== 'project' || !doc.project) return
    const st = (doc.project as any).state && typeof (doc.project as any).state === 'object' ? (doc.project as any).state : {}
    const aiBg = st && (st as any).aiBackground && typeof (st as any).aiBackground === 'object' ? (st as any).aiBackground : {}
    const gpRaw = aiBg && typeof (aiBg as any).globalPrompt === 'string' ? String((aiBg as any).globalPrompt) : ''
    const gneg = aiBg && typeof (aiBg as any).globalNegativePrompt === 'string' ? String((aiBg as any).globalNegativePrompt) : ''
    const projectTitle = String((doc.project as any).title || '').trim()
    const tpl = readHubTemplateFields()
    const templateGp = buildGlobalPromptFromTemplate(tpl, projectTitle)
    const templateGneg = buildGlobalNegativeFromTemplate(tpl)
    const gp = gpRaw.trim() ? gpRaw : (templateGp || (projectTitle ? `故事名：《${projectTitle}》` : ''))

    let userInput = String(aiReq.userInput || '')
    let prompt = String(aiReq.prompt || '')
    let negativePrompt = String(aiReq.negativePrompt || '')

    if (selection.type === 'node' && doc.story) {
      const node0 = (doc.story.nodes || []).find((n) => n.id === selection.id) || null
      const node = node0 ? ensureNode(node0 as any) : null
      if (node) {
        const map = readStoryboardSceneMapFromProject(doc.project)
        const saved = map[node.id] || null
        const fallbackInput = buildSceneUserInputForBatch(node, projectTitle)
        userInput = saved && saved.userInput ? saved.userInput : fallbackInput
        prompt = saved && saved.prompt ? saved.prompt : ''
        negativePrompt = saved && saved.negativePrompt ? saved.negativePrompt : ''
      }
    }

    setAiReq((v) => ({
      ...v,
      globalPrompt: gp,
      globalNegativePrompt: String(gneg || '').trim() || templateGneg,
      userInput,
      prompt,
      negativePrompt
    }))
    setAiLast(null)
    setAiError('')
    setAiOpen(true)
  }

  async function initStoryboardBatchFromDoc() {
    if (!doc.project || !doc.story) return
    const aiBg0 = (doc.project as any).state && (doc.project as any).state.aiBackground && typeof (doc.project as any).state.aiBackground === 'object'
      ? (doc.project as any).state.aiBackground
      : {}
    const projectTitle = String((doc.project as any).title || '').trim()
    const tpl = readHubTemplateFields()
    const templateGp = buildGlobalPromptFromTemplate(tpl, projectTitle)
    const templateGneg = buildGlobalNegativeFromTemplate(tpl)
    const templateStyle = mapTemplateStyleToStoryboardStyle(String(tpl?.style || ''))
    const map = readStoryboardSceneMapFromProject(doc.project)
    const sceneNodes = (doc.story.nodes || []).map((n) => ensureNode(n as any)).filter((n) => n.kind === 'scene' || n.kind === 'ending')
    const items: StoryboardBatchItem[] = sceneNodes.map((n) => ({
      nodeId: n.id,
      nodeName: String((n as any).body?.title || n.name || n.id).trim(),
      userInput: (map[n.id] && map[n.id].userInput) ? map[n.id].userInput : buildSceneUserInputForBatch(n, projectTitle),
      prompt: (map[n.id] && map[n.id].prompt) ? map[n.id].prompt : '',
      negativePrompt: (map[n.id] && map[n.id].negativePrompt) ? map[n.id].negativePrompt : '',
      status: 'idle',
      note: ''
    }))
    setSbItems(items)
    const draft0 = readStoryboardBatchDraftFromProject(doc.project)
    setSbReq({
      entitySpec: String(aiBg0.storyboardEntitySpec || '').trim(),
      storyBibleJson: aiBg0.storyBible && typeof aiBg0.storyBible === 'object'
        ? JSON.stringify(aiBg0.storyBible, null, 2)
        : String(aiBg0.storyBibleJson || '').trim(),
      continuity: aiBg0.storyboardContinuity && typeof aiBg0.storyboardContinuity === 'object'
        ? {
            ipadapterEnabled: Boolean((aiBg0.storyboardContinuity as any).ipadapterEnabled),
            requireCharacterRefs: (aiBg0.storyboardContinuity as any).requireCharacterRefs !== false,
            controlnetEnabled: Boolean((aiBg0.storyboardContinuity as any).controlnetEnabled)
          }
        : { ipadapterEnabled: true, requireCharacterRefs: true, controlnetEnabled: false },
      globalPrompt: String(aiBg0.globalPrompt || '').trim() || templateGp,
      globalNegativePrompt: String(aiBg0.globalNegativePrompt || '').trim() || templateGneg,
      style: ((draft0 && draft0.style) || templateStyle || aiReq.style || 'picture_book') as any,
      aspectRatio: ((draft0 && draft0.aspectRatio) || aiReq.aspectRatio || '9:16') as any,
      width: Number((draft0 && draft0.width) || aiReq.width || 768),
      height: Number((draft0 && draft0.height) || aiReq.height || 1344),
      steps: Number((draft0 && draft0.steps) || aiReq.steps || 20),
      cfgScale: Number((draft0 && draft0.cfgScale) || aiReq.cfgScale || 7),
      sampler: String((draft0 && draft0.sampler) || 'DPM++ 2M'),
      scheduler: String((draft0 && draft0.scheduler) || 'Automatic')
    })
    if (!draft0) {
      try {
        const st = await getStudioSettings()
        const imageProvider = String(st?.effective?.image?.provider || '').toLowerCase()
        if (imageProvider === 'doubao') {
          setSbReq((prev) => ({
            ...prev,
            steps: DOUBAO_STORYBOARD_DEFAULTS.steps,
            cfgScale: DOUBAO_STORYBOARD_DEFAULTS.cfgScale,
            sampler: DOUBAO_STORYBOARD_DEFAULTS.sampler,
            scheduler: DOUBAO_STORYBOARD_DEFAULTS.scheduler
          }))
          appendSbLog('检测到图像 Provider=doubao，已应用默认参数：steps=30 / cfg=7.5 / DPM++ 2M / Karras')
        } else if (imageProvider === 'comfyui') {
          setSbReq((prev) => ({
            ...prev,
            style: 'picture_book',
            steps: COMFYUI_STORYBOARD_DEFAULTS.steps,
            cfgScale: COMFYUI_STORYBOARD_DEFAULTS.cfgScale,
            sampler: COMFYUI_STORYBOARD_DEFAULTS.sampler,
            scheduler: COMFYUI_STORYBOARD_DEFAULTS.scheduler
          }))
          appendSbLog('检测到图像 Provider=comfyui，已应用连续场景默认参数：style=picture_book / steps=24 / cfg=6.0 / DPM++ 2M / Karras')
        }
      } catch (_) {}
    }
    setSbError('')
    setSbLogs([])
    if (!String(aiBg0.globalPrompt || '').trim() && templateGp) appendSbLog('已从“故事模板”注入全局正向提示词')
    if (!String(aiBg0.globalNegativePrompt || '').trim() && templateGneg) appendSbLog('已从“故事模板”注入全局负向提示词')
  }

  async function runStoryboardGenerateEntitySpec() {
    if (doc.mode !== 'project' || !doc.project || !doc.story) return
    if (sbBusyGenerate || sbBusyApply || sbBusyEntity) return
    const projectTitle = String((doc.project as any).title || '').trim()
    const wholeStoryInput = buildWholeStoryUserInputForGlobal(projectTitle)
    if (!wholeStoryInput) {
      setSbError('无法生成 Story Bible：故事内容为空')
      return
    }
    setSbBusyEntity(true)
    setSbError('')
    appendSbLog('开始生成 Story Bible（角色/道具/地点锁定）')
    try {
      // Build structured input for Story Bible generation.
      const sceneNodes = (doc.story.nodes || []).map((n) => ensureNode(n as any)).filter((n) => n.kind === 'scene' || n.kind === 'ending')
      const scenes = sceneNodes.slice(0, 60).map((n, idx) => {
        const placements = Array.isArray((n as any).visuals?.placements) ? ((n as any).visuals.placements as any[]) : []
        const charIds = Array.from(new Set(placements.map((p) => String((p && p.characterId) || '').trim()).filter(Boolean)))
        const characters = charIds
          .map((id) => (doc.project!.characters || []).find((c) => c.id === id) || null)
          .filter(Boolean)
          .map((c: any) => ({
            id: String(c.id || '').trim(),
            name: String(c.name || '').trim(),
            fingerprintPrompt: String(c.ai && c.ai.fingerprintPrompt ? c.ai.fingerprintPrompt : '').trim()
          }))
        return {
          index: idx + 1,
          nodeId: n.id,
          nodeName: String((n as any).body?.title || n.name || n.id).trim(),
          summary: buildNodeTextSummary(String((n as any).body?.text || '').trim()),
          characters
        }
      })
      const input = {
        storyTitle: projectTitle || null,
        style: sbReq.style,
        aspectRatio: sbReq.aspectRatio,
        globalPrompt: String(sbReq.globalPrompt || '').trim() || null,
        globalNegativePrompt: String(sbReq.globalNegativePrompt || '').trim() || null,
        storySummary: wholeStoryInput,
        scenes
      }

      const { result } = await generateStoryBibleAi(doc.id, { input, timeoutMs: 120_000 })
      if (!result) throw new Error('empty_story_bible')
      const storyBibleJson = JSON.stringify(result, null, 2)
      const entitySpec = buildEntitySpecFromStoryBible(result)
      if (!entitySpec) throw new Error('empty_entity_spec_from_bible')

      setSbReq((prev) => ({ ...prev, storyBibleJson, entitySpec }))
      setSbContinuityReady(false)
      setDocProject((p) => {
        const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
        const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
        const nextState = {
          ...stateIn,
          aiBackground: {
            ...aiBgIn,
            storyboardEntitySpec: entitySpec,
            storyBible: result,
            storyBibleJson,
            storyboardContinuity: sbReq.continuity
          }
        }
        return { ...p, state: nextState }
      })
      appendSbLog('Story Bible 生成完成（可手动编辑 JSON，随后生成场景提示词/批量出图）')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const debugOutput = e && typeof e === 'object' && (e as any).debugOutput ? String((e as any).debugOutput || '').trim() : ''
      setSbError(msg)
      appendSbLog(`Story Bible 生成失败：${msg}`)
      if (debugOutput) {
        appendSbLog('AI 原始输出（截断，便于排查/手工修正）：')
        appendSbLog(debugOutput.slice(0, 1200))
      }
    } finally {
      setSbBusyEntity(false)
    }
  }

  async function runStoryboardGenerateAllPrompts(mode: 'all' | 'pending' = 'all') {
    if (doc.mode !== 'project' || !doc.story || !doc.project) return
    if (sbBusyGenerate || sbBusyApply || sbBusyEntity) return
    if (!sbContinuityReady) {
      setSbError('请先运行“连续分镜锁定测试”，通过后才能生成场景提示词')
      appendSbLog('阻止执行：连续分镜锁定测试未通过')
      return
    }
    if (!sbItems.length) {
      setSbError('没有可处理的场景节点')
      return
    }
    const onlyPending = mode === 'pending'
    const targets = onlyPending
      ? sbItems.filter((x) => x.status === 'error' || !String(x.prompt || '').trim())
      : sbItems.slice()
    if (!targets.length) {
      setSbError('')
      appendSbLog('没有需要重试的场景（全部已生成）')
      return
    }
    setSbBusyGenerate(true)
    setSbQueuePhase('generate')
    resetSbQueueControl()
    setSbGeneratingNodeId('')
    setSbGeneratingNodeStartedAt(0)
    setSbGeneratingNodeElapsedMs(0)
    setSbError('')
    appendSbLog(
      onlyPending
        ? `开始重试失败/未完成场景提示词，共 ${targets.length} 个场景`
        : `开始生成所有场景提示词，共 ${sbItems.length} 个场景`
    )
    if (!onlyPending) appendSbLog('说明：全量生成会覆盖当前场景提示词（prompt/negativePrompt）')
    const projectTitle = String((doc.project as any).title || '').trim()
    const oldMeta = readStoryboardPromptMetaFromProject(doc.project)
    const styleChanged = Boolean(
      oldMeta && ((oldMeta.style && oldMeta.style !== String(sbReq.style || '')) || (oldMeta.aspectRatio && oldMeta.aspectRatio !== String(sbReq.aspectRatio || '')))
    )
    const storyBibleObj = tryParseStoryBibleJson(sbReq.storyBibleJson)
    const entitySpec = storyBibleObj ? buildEntitySpecFromStoryBible(storyBibleObj) : String(sbReq.entitySpec || '').trim()
    let currGlobalPrompt = String(sbReq.globalPrompt || '').trim()
    let currGlobalNegativePrompt = String(sbReq.globalNegativePrompt || '').trim()
    let recSteps = Number(sbReq.steps || 20)
    let recCfg = Number(sbReq.cfgScale || 7)
    let recSampler = String(sbReq.sampler || 'DPM++ 2M')
    let recScheduler = String(sbReq.scheduler || 'Automatic')
    let recParamLocked = false
    let globalLocked = onlyPending ? Boolean(currGlobalPrompt) : false
    if (!onlyPending && styleChanged) {
      appendSbLog('检测到风格/比例已变更：已重置全局正负提示词，并将重新生成全部场景提示词')
      currGlobalPrompt = ''
      currGlobalNegativePrompt = ''
      globalLocked = false
      setSbReq((prev) => ({ ...prev, globalPrompt: '', globalNegativePrompt: '' }))
      setSbItems((prev) => prev.map((x) => ({ ...x, prompt: '', negativePrompt: '', status: 'idle', note: '' })))
    }
    if (!onlyPending) {
      appendSbLog('全量生成会重建全局正向/负向：以首个成功场景返回为基准，再用于后续场景一致性')
      setSbItems((prev) => prev.map((x) => ({ ...x, status: 'idle', note: '' })))
      const wholeStoryInput = buildWholeStoryUserInputForGlobal(projectTitle)
      if (wholeStoryInput) {
        appendSbLog('开始基于“整个故事”生成全局正向/负向锚点')
        try {
          const globalRes = await analyzeBackgroundPromptAi(doc.id, {
            userInput: wholeStoryInput,
            globalPrompt: [entitySpec, currGlobalPrompt].filter(Boolean).join('，'),
            globalNegativePrompt: currGlobalNegativePrompt,
            aspectRatio: sbReq.aspectRatio,
            style: sbReq.style,
            outputLanguage: 'en',
            timeoutMs: 90_000
          })
          const gp = String(globalRes.result?.globalPrompt || '').trim()
          const gneg = String(globalRes.result?.globalNegativePrompt || '').trim()
          currGlobalPrompt = gp || currGlobalPrompt
          currGlobalNegativePrompt = gneg || currGlobalNegativePrompt
          globalLocked = Boolean(currGlobalPrompt)
          setSbReq((prev) => ({ ...prev, globalPrompt: currGlobalPrompt, globalNegativePrompt: currGlobalNegativePrompt }))
          appendSbLog('全故事全局锚点生成完成')
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          appendSbLog(`全故事全局锚点生成失败：${msg}（回退为逐场景首成功锚点）`)
        }
      }
    } else {
      appendSbLog('续跑模式会复用当前全局正向/负向，仅补齐失败或未完成场景')
    }
    let okCount = 0
    let failCount = 0
    try {
      for (let i = 0; i < targets.length; i++) {
        const canContinue = await waitForSbQueueGate()
        if (!canContinue) {
          appendSbLog('任务已取消：提示词批量生成提前结束')
          break
        }
        const it = targets[i]
        setSbItems((prev) => prev.map((x) => (x.nodeId === it.nodeId ? { ...x, status: 'generating', note: '' } : x)))
        appendSbLog(`开始生成场景提示词：${it.nodeName}（${i + 1}/${targets.length}）`)
        const sceneStartedAt = Date.now()
        setSbGeneratingNodeId(it.nodeId)
        setSbGeneratingNodeStartedAt(sceneStartedAt)
        setSbGeneratingNodeElapsedMs(0)
        const node0 = (doc.story.nodes || []).find((n) => n.id === it.nodeId) || null
        const node = node0 ? ensureNode(node0 as any) : null
        const userInput = it.userInput || (node ? buildSceneUserInputForBatch(node, projectTitle) : '')
        if (!userInput) {
          setSbItems((prev) => prev.map((x) => (x.nodeId === it.nodeId ? { ...x, status: 'error', note: '场景文本为空' } : x)))
          appendSbLog(`场景 ${it.nodeName} 跳过：场景文本为空`)
          failCount += 1
          continue
        }
        try {
          const sceneLocks = node ? buildSceneCharacterLocks(node as any) : ''
          const gpForAi = [entitySpec, currGlobalPrompt, sceneLocks].filter(Boolean).join('，').slice(0, 1200)
          const res = await analyzeBackgroundPromptAi(doc.id, {
            userInput,
            globalPrompt: gpForAi,
            globalNegativePrompt: currGlobalNegativePrompt,
            aspectRatio: sbReq.aspectRatio,
            style: sbReq.style,
            outputLanguage: 'en',
            timeoutMs: 90_000
          })
          const gp = String(res.result?.globalPrompt || '').trim()
          const gneg = String(res.result?.globalNegativePrompt || '').trim()
          const sp = String(res.result?.finalPrompt || res.result?.prompt || '').trim()
          const sneg = String(res.result?.finalNegativePrompt || res.result?.negativePrompt || '').trim()
          if (!sp) throw new Error('empty_scene_prompt')
          if (!recParamLocked) {
            const nSteps = Number((res.result as any)?.steps)
            const nCfg = Number((res.result as any)?.cfgScale)
            const sSampler = String((res.result as any)?.sampler || '').trim()
            const sScheduler = String((res.result as any)?.scheduler || '').trim()
            if (Number.isFinite(nSteps) && nSteps > 0) recSteps = Math.max(8, Math.min(64, Math.floor(nSteps)))
            if (Number.isFinite(nCfg) && nCfg > 0) recCfg = Math.max(1, Math.min(12, nCfg))
            if (sSampler) recSampler = sSampler
            if (sScheduler) recScheduler = sScheduler
            recParamLocked = true
            appendSbLog(`已应用AI推荐参数：steps=${recSteps} cfg=${recCfg} sampler=${recSampler} scheduler=${recScheduler}`)
          }
          if (!globalLocked) {
            currGlobalPrompt = gp || currGlobalPrompt
            currGlobalNegativePrompt = gneg || currGlobalNegativePrompt
            globalLocked = Boolean(currGlobalPrompt)
            if (globalLocked) appendSbLog('全局锚点已建立，后续场景将复用该锚点并仅生成场景增量')
          }
          setSbItems((prev) =>
            prev.map((x) => (x.nodeId === it.nodeId ? { ...x, userInput, prompt: sp, negativePrompt: sneg, status: 'generated', note: 'ok' } : x))
          )
          upsertStoryboardScenePrompt(it.nodeId, it.nodeName, { userInput, prompt: sp, negativePrompt: sneg })
          appendSbLog(`场景提示词已生成：${it.nodeName}（${Math.max(1, Date.now() - sceneStartedAt)}ms）`)
          okCount += 1
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          setSbItems((prev) => prev.map((x) => (x.nodeId === it.nodeId ? { ...x, status: 'error', note: msg } : x)))
          appendSbLog(`场景生成失败：${it.nodeName} - ${msg}`)
          failCount += 1
        }
      }
      setSbReq((prev) => ({
        ...prev,
        globalPrompt: currGlobalPrompt,
        globalNegativePrompt: currGlobalNegativePrompt,
        steps: recSteps,
        cfgScale: recCfg,
        sampler: recSampler,
        scheduler: recScheduler
      }))
      setSbContinuityReady(false)
      setDocProject((p) => {
        const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
        const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
        const nextState = {
          ...stateIn,
          aiBackground: {
            ...aiBgIn,
            globalPrompt: currGlobalPrompt,
            globalNegativePrompt: currGlobalNegativePrompt,
            storyboardContinuity: sbReq.continuity,
            storyboardPromptMeta: {
              style: String(sbReq.style || ''),
              aspectRatio: String(sbReq.aspectRatio || ''),
              updatedAt: new Date().toISOString()
            }
          }
        }
        return { ...p, state: nextState }
      })
      if (failCount > 0) {
        const msg = `本轮完成：成功 ${okCount}，失败 ${failCount}（可点“重试失败/继续未完成”）`
        setSbError(msg)
        appendSbLog(msg)
      } else {
        setSbError('')
        if (sbQueueRef.current.cancelRequested) appendSbLog('提示词任务已取消，已保留已完成结果')
        else {
          appendSbLog('所有场景提示词生成完成')
          setToast('批量提示词已生成')
        }
      }
    } finally {
      resetSbQueueControl()
      setSbQueuePhase('idle')
      setSbGeneratingNodeId('')
      setSbGeneratingNodeStartedAt(0)
      setSbGeneratingNodeElapsedMs(0)
      setSbBusyGenerate(false)
    }
  }

  async function runStoryboardValidateAndApply(mode: 'all' | 'pending' = 'all') {
    if (doc.mode !== 'project' || !doc.project || !doc.story) return
    if (sbBusyGenerate || sbBusyApply || sbBusyEntity) return
    if (!sbContinuityReady) {
      setSbError('请先运行“连续分镜锁定测试”，通过后才能批量出图')
      appendSbLog('阻止执行：连续分镜锁定测试未通过')
      return
    }
    if (!sbItems.length) {
      setSbError('没有可处理的场景节点')
      return
    }
    const onlyPending = mode === 'pending'
    const targets = onlyPending ? sbItems.filter((x) => x.status === 'error' || x.status === 'generated') : sbItems.slice()
    if (!targets.length) {
      setSbError('')
      appendSbLog('没有需要继续出图的场景')
      return
    }
    const missing = targets.filter((x) => !String(x.prompt || '').trim())
    if (missing.length) {
      setSbError(`目标场景中有 ${missing.length} 个缺少提示词，请先补齐或重新生成提示词`)
      return
    }
    const promptMeta = readStoryboardPromptMetaFromProject(doc.project)
    if (promptMeta) {
      const styleMismatch = promptMeta.style && promptMeta.style !== String(sbReq.style || '')
      const arMismatch = promptMeta.aspectRatio && promptMeta.aspectRatio !== String(sbReq.aspectRatio || '')
      if (styleMismatch || arMismatch) {
        setSbError('当前风格/比例与上次“生成所有场景提示词”不一致，请先重新生成提示词后再校验并应用')
        return
      }
    }

    setSbBusyApply(true)
    setSbQueuePhase('apply')
    resetSbQueueControl()
    setSbGeneratingNodeId('')
    setSbGeneratingNodeStartedAt(0)
    setSbGeneratingNodeElapsedMs(0)
    setSbError('')
    appendSbLog(
      onlyPending
        ? `开始重试失败/未完成出图，共 ${targets.length} 个场景`
        : '开始校验并应用：批量调用当前出图 Provider'
    )
    try {
      const st = await getStudioSettings()
      const provider = String(st.effective?.image?.provider || '').toLowerCase()
      const model = String(st.effective?.image?.model || '').trim()
      const providerLabel = provider || 'none'
      appendSbLog(`当前出图 Provider：${providerLabel}`)
      if (model) appendSbLog(`当前出图 Model：${model}`)
      if (!['comfyui', 'sdwebui', 'doubao'].includes(provider)) {
        throw new Error('当前出图 Provider 不可用，请在设置中将图像生成切换为 comfyui / sdwebui / doubao 并保存应用')
      }

      const isFatalImageConfigError = (msg: string) => {
        const s = String(msg || '').toLowerCase()
        if (!s) return false
        if (s.includes('has not activated the model')) return true
        if (s.includes('image size must be at least') || s.includes('parameter `size` specified in the request is not valid')) return true
        if (s.includes('invalid api key') || s.includes('unauthorized') || s.includes('forbidden')) return true
        return false
      }

      let nextProject: ProjectV1 = { ...(doc.project as any), assets: [...((doc.project as any).assets || [])] }
      let nextStory: StoryV1 = { ...(doc.story as any), nodes: [...((doc.story as any).nodes || [])] }
      let okCount = 0
      let failCount = 0

      const storyNodesById = new Map((nextStory.nodes || []).filter(Boolean).map((n) => [String((n as any).id || ''), n as any]))
      const projectCharactersById = new Map((nextProject.characters || []).filter(Boolean).map((ch) => [String((ch as any).id || ''), ch as any]))

      const buildContinuityAnchor = () => {
        return [
          'WORLD_ANCHOR: same story world, same era and geography, stable art direction',
          'CONTINUITY_RULES: keep character identity, outfit palette and key props consistent across scenes; no random replacements'
        ].join(', ')
      }

      const buildRoleDefinitionForNode = (nodeId: string) => {
        try {
          const node = storyNodesById.get(String(nodeId || '')) as any
          if (!node) return ''
          const placements = (node.visuals && Array.isArray(node.visuals.placements)) ? node.visuals.placements : []
          const ids = Array.from(new Set(placements.map((p: any) => String(p && p.characterId ? p.characterId : '')).filter(Boolean)))
          if (!ids.length) return ''
          const lines: string[] = []
          for (const id of ids) {
            const ch = projectCharactersById.get(String(id)) as any
            if (!ch) continue
            const name = String(ch.name || ch.id || '').trim()
            if (!name) continue
            const fp = String(ch.ai && ch.ai.fingerprintPrompt ? ch.ai.fingerprintPrompt : '').trim()
            const neg = String(ch.ai && ch.ai.negativePrompt ? ch.ai.negativePrompt : '').trim()
            const core = fp ? `${name}=${fp}` : name
            lines.push(neg ? `${core} (avoid: ${neg})` : core)
            if (lines.length >= 6) break
          }
          if (!lines.length) return ''
          return `ROLE_DEFINITION: ${lines.join('; ')}`
        } catch (_) {
          return ''
        }
      }

      for (let i = 0; i < targets.length; i++) {
        const canContinue = await waitForSbQueueGate()
        if (!canContinue) {
          appendSbLog('任务已取消：批量出图提前结束')
          break
        }
        const it = targets[i]
        setSbItems((prev) => prev.map((x) => (x.nodeId === it.nodeId ? { ...x, status: 'applying', note: '' } : x)))
        const sceneStartedAt = Date.now()
        setSbGeneratingNodeId(it.nodeId)
        setSbGeneratingNodeStartedAt(sceneStartedAt)
        setSbGeneratingNodeElapsedMs(0)
        appendSbLog(`开始应用分镜图：${it.nodeName}（${i + 1}/${targets.length}）`)
        const gp = String(sbReq.globalPrompt || '').trim()
        const sp = String(it.prompt || '').trim()
        const gneg = String(sbReq.globalNegativePrompt || '').trim()
        const sneg = String(it.negativePrompt || '').trim()
        const continuityAnchor = provider === 'comfyui' ? buildContinuityAnchor() : ''
        const usedPrompt = [gp, continuityAnchor, sp].filter(Boolean).join('，')
        try {
          const roleDef = buildRoleDefinitionForNode(it.nodeId)
          const gpWithRoles = [gp, continuityAnchor, roleDef].filter(Boolean).join('，')
          const payload: AiBackgroundRequest = {
            userInput: String(it.userInput || ''),
            globalPrompt: gpWithRoles,
            globalNegativePrompt: gneg,
            prompt: sp,
            negativePrompt: sneg,
            style: sbReq.style,
            aspectRatio: sbReq.aspectRatio,
            width: sbReq.width,
            height: sbReq.height,
            steps: sbReq.steps,
            cfgScale: sbReq.cfgScale,
            sampler: sbReq.sampler,
            scheduler: sbReq.scheduler,
            timeoutMs: provider === 'doubao' ? 300_000 : 0
          }
          const resp = await generateBackgroundAi(doc.id, payload)
          const rawProvider = String((resp as any).provider || '').trim()
          const bgProvider: AssetV1['source'] extends { provider?: infer P } ? P : any =
            rawProvider === 'sdwebui' || rawProvider === 'comfyui' || rawProvider === 'doubao' ? rawProvider : undefined
          const nextUri = resp.url ? resolveUrl(resp.url) : resp.assetPath

          const nodeIdx = (nextStory.nodes || []).findIndex((n) => n.id === it.nodeId)
          if (nodeIdx < 0) throw new Error(`未找到节点：${it.nodeName}`)
          const nodeNow = ensureNode((nextStory.nodes || [])[nodeIdx] as any)
          const bgId = String((nodeNow as any)?.visuals?.backgroundAssetId || '').trim()
          const assetIdx = bgId ? (nextProject.assets || []).findIndex((a) => a.id === bgId) : -1
          if (assetIdx >= 0) {
            appendSbLog(`覆盖已有场景图：${it.nodeName}`)
            const old = (nextProject.assets || [])[assetIdx]
            const patched = { ...old, uri: nextUri, source: { type: 'ai' as const, prompt: usedPrompt || sp, provider: bgProvider } }
            nextProject = { ...nextProject, assets: (nextProject.assets || []).map((a, i) => (i === assetIdx ? patched : a)) }
            nextStory = {
              ...nextStory,
              nodes: (nextStory.nodes || []).map((n) =>
                n.id === it.nodeId ? { ...ensureNode(n as any), visuals: { ...ensureNode(n as any).visuals, backgroundAssetId: bgId } } : n
              )
            }
          } else {
            const assetId = uid('asset')
            const asset: AssetV1 = {
              id: assetId,
              kind: 'image',
              name: `AI 分镜 ${it.nodeName}`,
              uri: nextUri,
              source: { type: 'ai' as const, prompt: usedPrompt || sp, provider: bgProvider }
            }
            nextProject = { ...nextProject, assets: [...(nextProject.assets || []), asset] }
            nextStory = {
              ...nextStory,
              nodes: (nextStory.nodes || []).map((n) =>
                n.id === it.nodeId ? { ...ensureNode(n as any), visuals: { ...ensureNode(n as any).visuals, backgroundAssetId: assetId } } : n
              )
            }
          }
          okCount += 1
          setSbItems((prev) => prev.map((x) => (x.nodeId === it.nodeId ? { ...x, status: 'applied', note: 'ok' } : x)))
          appendSbLog(`已应用分镜图：${it.nodeName}（${Math.max(1, Date.now() - sceneStartedAt)}ms）`)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          failCount += 1
          setSbItems((prev) => prev.map((x) => (x.nodeId === it.nodeId ? { ...x, status: 'error', note: msg } : x)))
          appendSbLog(`应用失败：${it.nodeName} - ${msg}`)
          if (isFatalImageConfigError(msg)) {
            setSbError(`出图配置错误：${msg}`)
            appendSbLog('检测到致命配置错误，已停止后续场景批量出图（请先修正设置后重试）')
            break
          }
        }
      }

      setDocProject((_p) => nextProject)
      setDocStory((_s) => nextStory)
      if (failCount > 0) {
        const msg = `本轮出图完成：成功 ${okCount}，失败 ${failCount}（可点“重试失败/继续未完成出图”）`
        setSbError(msg)
        appendSbLog(msg)
      } else {
        setSbError('')
        if (sbQueueRef.current.cancelRequested) appendSbLog(`任务已取消：当前进度 ${okCount}/${targets.length}`)
        else {
          setToast(`批量分镜生成完成：${okCount}/${targets.length}`)
          appendSbLog(`批量应用完成：${okCount}/${targets.length}`)
        }
      }
    } finally {
      resetSbQueueControl()
      setSbQueuePhase('idle')
      setSbGeneratingNodeId('')
      setSbGeneratingNodeStartedAt(0)
      setSbGeneratingNodeElapsedMs(0)
      setSbBusyApply(false)
    }
  }

  const sbAllPromptsReady = useMemo(
    () => sbItems.length > 0 && sbItems.every((x) => String(x.prompt || '').trim().length > 0),
    [sbItems]
  )

  async function runCharacterFingerprint(characterId: string) {
    if (!doc.project || !doc.story || doc.mode !== 'project') return
    const ch = (doc.project.characters || []).find((x) => x.id === characterId) || null
    if (!ch) return
    const characterName = String(ch.name || ch.id).trim()
    if (!characterName) {
      setChFpError('请先填写角色名称')
      return
    }
    setChFpBusy(true)
    setChFpError('')
    try {
      const ctx = buildCharacterContextText(characterId)
      const res = await analyzeCharacterFingerprintAi(doc.id, {
        storyTitle: String((doc.project as any).title || '').trim(),
        characterName,
        contextText: ctx,
        globalPrompt: String(aiReq.globalPrompt || '').trim(),
        style: String(aiReq.style || 'picture_book')
      })
      const fp = String(res.result?.fingerprintPrompt || '').trim()
      const neg = String(res.result?.negativePrompt || '').trim()
      if (!fp) throw new Error('AI 未返回 fingerprintPrompt')

      setDocProject((p) => ({
        ...p,
        characters: (p.characters || []).map((x) =>
          x.id === characterId ? { ...x, ai: { ...(x.ai || {}), fingerprintPrompt: fp, negativePrompt: neg } } : x
        )
      }))
      setToast('已提取角色设定（指纹）')
    } catch (e) {
      setChFpError(e instanceof Error ? e.message : String(e))
    } finally {
      setChFpBusy(false)
    }
  }

  function openCharacterSpriteModal(characterId: string, posePrompt?: string) {
    if (!doc.project || doc.mode !== 'project') return
    const ch = (doc.project.characters || []).find((x) => x.id === characterId) || null
    if (!ch) return
    const dims = stageDims()
    const fp = String(ch.ai?.fingerprintPrompt || '').trim()
    const neg = String(ch.ai?.negativePrompt || '').trim()
    const basePose = String(posePrompt || '').trim() || '全身，站立，面朝镜头，单人，居中'
    const st0 = (doc.project as any).state && typeof (doc.project as any).state === 'object' ? (doc.project as any).state : {}
    const aiBg0 = (st0 as any).aiBackground && typeof (st0 as any).aiBackground === 'object' ? (st0 as any).aiBackground : {}
    const gpSaved = typeof (aiBg0 as any).globalPrompt === 'string' ? String((aiBg0 as any).globalPrompt) : ''
    const projectTitle = String((doc.project as any).title || '').trim()
    const gpFallback = gpSaved.trim() ? gpSaved : (projectTitle ? `故事名：《${projectTitle}》` : '')
    const gpUse = String(aiReq.globalPrompt || '').trim() || gpFallback
    chTargetRef.current = { kind: 'character', characterId }
    setChGreen(null)
    setChTransparentPreviewUrl('')
    setChError('')
    setChDraft({
      ...defaultChDraft,
      globalPrompt: gpUse,
      fingerprintPrompt: fp,
      posePrompt: basePose,
      negativePrompt: neg,
      style: (aiReq.style as any) || 'picture_book',
      width: dims.w,
      height: dims.h
    })
    setChOpen(true)
  }

  function openPlacementSpriteModal(args: { nodeId: string; placementId: string; characterId: string; posePrompt?: string }) {
    if (!doc.project || !doc.story || doc.mode !== 'project') return
    const ch = (doc.project.characters || []).find((x) => x.id === args.characterId) || null
    if (!ch) return
    const fp = String(ch.ai?.fingerprintPrompt || '').trim()
    const neg = String(ch.ai?.negativePrompt || '').trim()
    const dims = stageDims()
    const st0 = (doc.project as any).state && typeof (doc.project as any).state === 'object' ? (doc.project as any).state : {}
    const aiBg0 = (st0 as any).aiBackground && typeof (st0 as any).aiBackground === 'object' ? (st0 as any).aiBackground : {}
    const gpSaved = typeof (aiBg0 as any).globalPrompt === 'string' ? String((aiBg0 as any).globalPrompt) : ''
    const projectTitle = String((doc.project as any).title || '').trim()
    const gpFallback = gpSaved.trim() ? gpSaved : (projectTitle ? `故事名：《${projectTitle}》` : '')
    const gpUse = String(aiReq.globalPrompt || '').trim() || gpFallback

    let pose = String(args.posePrompt || '').trim()
    if (!pose) {
      const n0 = (doc.story.nodes || []).find((n) => n.id === args.nodeId) || null
      const nn = n0 ? ensureNode(n0 as any) : null
      const title = nn ? String((nn as any).body?.title || '').trim() : ''
      const sum = nn ? buildNodeTextSummary(String((nn as any).body?.text || '').trim()) : ''
      pose = [title, sum].filter(Boolean).join('，').slice(0, 400)
    }
    if (!pose) pose = '全身，站立，单人，居中'

    chTargetRef.current = { kind: 'placement', characterId: args.characterId, nodeId: args.nodeId, placementId: args.placementId }
    setChGreen(null)
    setChTransparentPreviewUrl('')
    setChError('')
    setChDraft({
      ...defaultChDraft,
      globalPrompt: gpUse,
      fingerprintPrompt: fp,
      posePrompt: pose,
      negativePrompt: neg,
      style: (aiReq.style as any) || 'picture_book',
      width: dims.w,
      height: dims.h
    })
    setChOpen(true)
  }

  async function generateCharacterGreen() {
    if (doc.mode !== 'project') return
    setChBusy(true)
    setChError('')
    try {
      const res = await generateCharacterSpriteAi(doc.id, {
        globalPrompt: String(chDraft.globalPrompt || '').trim(),
        fingerprintPrompt: String(chDraft.fingerprintPrompt || '').trim(),
        posePrompt: String(chDraft.posePrompt || '').trim(),
        negativePrompt: String(chDraft.negativePrompt || '').trim(),
        style: String(chDraft.style || 'picture_book'),
        width: Number(chDraft.width || 720),
        height: Number(chDraft.height || 1280),
        steps: Number(chDraft.steps || 20),
        cfgScale: Number(chDraft.cfgScale || 7)
      })
      const abs = res.url ? resolveUrl(res.url) : res.assetPath
      setChGreen({ url: abs, assetPath: res.assetPath, provider: res.provider, remoteUrl: res.remoteUrl })
      setToast('已生成绿幕图，可继续抠图并应用')
    } catch (e) {
      setChError(e instanceof Error ? e.message : String(e))
    } finally {
      setChBusy(false)
    }
  }

  async function applyCharacterTransparent() {
    if (doc.mode !== 'project' || !doc.project || !doc.story) return
    const target = chTargetRef.current
    if (!target) {
      setChError('内部错误：缺少应用目标')
      return
    }
    const greenUrl = String(chGreen && chGreen.url ? chGreen.url : '').trim()
    if (!greenUrl) {
      setChError('请先生成绿幕图')
      return
    }

    setChBusy(true)
    setChError('')
    try {
      const matte = await chromaKeyUrlToPng(greenUrl, {
        threshold: Number(chDraft.keyThreshold || 80),
        feather: Number(chDraft.keyFeather || 40),
        crop: Boolean(chDraft.crop),
        padding: Number(chDraft.padding || 12)
      })

      try {
        const u0 = String(chTransparentPreviewUrl || '').trim()
        if (u0) URL.revokeObjectURL(u0)
      } catch {}
      const previewUrl = URL.createObjectURL(matte.blob)
      setChTransparentPreviewUrl(previewUrl)

      const ch = (doc.project.characters || []).find((x) => x.id === target.characterId) || null
      const safeName = String(ch?.name || ch?.id || 'character').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]+/g, '_').slice(0, 24) || 'character'
      const fileName = `${safeName}_${Date.now()}.png`
      const file = new File([matte.blob], fileName, { type: 'image/png' })
      const uploaded = await uploadProjectImage(String(doc.project.id), file)
      const nextUri = uploaded.url ? resolveUrl(uploaded.url) : uploaded.assetPath

      const usedPrompt = [String(chDraft.globalPrompt || '').trim(), String(chDraft.fingerprintPrompt || '').trim(), String(chDraft.posePrompt || '').trim()]
        .filter(Boolean)
        .join('，')
        .slice(0, 1800)
      const provider = (chGreen && chGreen.provider ? String(chGreen.provider) : '') as any

      const applyToAsset = (assetId: string) => {
        setDocProject((p) => ({
          ...p,
          assets: (p.assets || []).map((a) =>
            a.id === assetId
              ? { ...a, uri: nextUri, source: { type: 'ai' as const, prompt: usedPrompt, provider } }
              : a
          )
        }))
        return assetId
      }

      const createAsset = (name: string) => {
        const assetId = uid('asset')
        const asset: AssetV1 = {
          id: assetId,
          kind: 'image',
          name,
          uri: nextUri,
          source: { type: 'ai' as const, prompt: usedPrompt, provider }
        }
        setDocProject((p) => ({ ...p, assets: [...(p.assets || []), asset] }))
        return assetId
      }

      if (target.kind === 'character') {
        const existingId = String(ch?.imageAssetId || '').trim()
        const existing = existingId ? (doc.project.assets || []).find((a) => a.id === existingId) || null : null
        const assetId = existing ? applyToAsset(existingId) : createAsset(`AI 角色 ${ch?.name || ch?.id || ''}`.trim() || 'AI 角色')
        setDocProject((p) => ({
          ...p,
          characters: (p.characters || []).map((x) => (x.id === target.characterId ? { ...x, imageAssetId: assetId } : x))
        }))
        setToast('已生成透明 PNG 并应用到角色')
        return
      }

      if (target.kind === 'placement') {
        const nodeId = String(target.nodeId || '').trim()
        const placementId = String(target.placementId || '').trim()
        const node0 = (doc.story.nodes || []).find((n) => n.id === nodeId) || null
        const nn = node0 ? ensureNode(node0 as any) : null
        const placements = Array.isArray(nn?.visuals?.placements) ? (nn!.visuals!.placements as any[]) : []
        const pl = placements.find((p) => String(p && p.id) === placementId) || null
        const existingId = String(pl && pl.imageAssetId ? pl.imageAssetId : '').trim()
        const existing = existingId ? (doc.project.assets || []).find((a) => a.id === existingId) || null : null
        const nodeName = String((node0 as any)?.name || nodeId).trim()
        const assetId =
          existing ? applyToAsset(existingId) : createAsset(`AI 姿势 ${nodeName} · ${ch?.name || ch?.id || ''}`.trim() || 'AI 姿势')

        setDocStory((s) => ({
          ...s,
          nodes: (s.nodes || []).map((n) => {
            if (n.id !== nodeId) return n
            const n2 = ensureNode(n as any)
            const v0 = n2.visuals || {}
            const pls = Array.isArray(v0.placements) ? v0.placements : []
            const next = pls.map((pp) => (pp.id === placementId ? { ...pp, imageAssetId: assetId } : pp))
            return { ...n2, visuals: { ...v0, placements: next } }
          })
        }))
        setToast('已生成透明 PNG 并应用到该摆放（覆盖）')
        return
      }
    } catch (e) {
      setChError(e instanceof Error ? e.message : String(e))
    } finally {
      setChBusy(false)
    }
  }

  const problems = useMemo(() => {
    try {
      return validate(doc)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return [`配置格式错误：${msg}`]
    }
  }, [doc])

  const right = (() => {
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

      const allNodes = nodes

      return (
        <div className="section">
          <div className="right-acc">
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
	                    {structureBound ? <div className="hint" style={{ marginTop: 6, color: '#fde68a' }}>合成层用于文案与演出排练；结构（节点/跳转）请回到蓝图层调整。</div> : null}
	                  </div>

	                  <div className="hr" />

	                  <div className="sub-acc">
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

	            <div className="fold">
	              <div className="fold-head" onClick={() => toggleRightFold('timeline')}>
	                <div className="fold-title">时间线（P0）</div>
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

	            <div className="fold">
	              <div className="fold-head" onClick={() => toggleRightFold('placements')}>
	                <div className="fold-title">角色摆放</div>
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
                      window.alert('请先在左侧创建角色')
                      return
                    }
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

              <div className="list">
                {placements.map((p) => {
                  const ch = doc.project?.characters.find((c) => c.id === p.characterId)
                  return (
                    <div
                      key={p.id}
                      className={`item ${p.id === activePlacementId ? 'active' : ''}`}
                      onClick={() => setActivePlacementId(p.id)}
                    >
                      <div>{ch?.name || p.characterId}</div>
                      <div className="meta">Placement: {p.id}</div>
                    </div>
                  )
                })}
              </div>

              {activePlacement ? (
                <div style={{ border: '1px solid rgba(148,163,184,0.16)', borderRadius: 12, padding: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>摆放属性</div>

                  <div className="form-row">
                    <label>角色</label>
                    <select
                      className="sel"
                      value={activePlacement.characterId}
                      onChange={(e) => {
                        const id = e.target.value
                        setNode((x) => ({
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
                    <label>图片（覆盖）</label>
                    <select
                      className="sel"
                      value={activePlacement.imageAssetId || ''}
                      onChange={(e) => {
                        const v = e.target.value || undefined
                        setNode((x) => ({
                          ...x,
                          visuals: {
                            ...ensureNode(x).visuals,
                            placements: (ensureNode(x).visuals?.placements || []).map((pp) =>
                              pp.id === activePlacement.id ? { ...pp, imageAssetId: v } : pp
                            )
                          }
                        }))
                      }}
                      title="为当前节点的该角色摆放指定一张“姿势图”（覆盖角色默认图片）"
                    >
                      <option value="">（使用角色默认）</option>
                      {doc.project.assets.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name || a.id}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      className="btn secondary"
                      onClick={() =>
                        openPlacementSpriteModal({
                          nodeId: n.id,
                          placementId: activePlacement.id,
                          characterId: activePlacement.characterId
                        })
                      }
                      title="根据当前场景文本生成该角色的“姿势透明 PNG”，并覆盖到该摆放"
                    >
                      AI 生成摆放 PNG（透明）
                    </button>
                    {activePlacement.imageAssetId ? (
                      <button
                        className="btn secondary"
                        onClick={() => {
                          setNode((x) => ({
                            ...x,
                            visuals: {
                              ...ensureNode(x).visuals,
                              placements: (ensureNode(x).visuals?.placements || []).map((pp) =>
                                pp.id === activePlacement.id ? { ...pp, imageAssetId: undefined } : pp
                              )
                            }
                          }))
                        }}
                        title="清除该摆放的图片覆盖，回退为角色默认图片"
                      >
                        清除覆盖
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
                    <label>可见</label>
                    <select
                      className="sel"
                      value={activePlacement.visible === false ? '0' : '1'}
                      onChange={(e) => {
                        const v = e.target.value === '0' ? false : true
                        setNode((x) => ({
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

                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      className="btn secondary"
                      onClick={() => {
                        setNode((x) => ({
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
                </div>
              ) : null}
            </div>
                </div>
              ) : null}
            </div>
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
  })()

  return (
    <div className="app">
      <div className="topbar">
        <div className="left">
          <div className="title">game_studio · 节点式交互故事编辑器（P0）</div>
          {showProjectManager ? (
            <>
              <button className="btn secondary" onClick={() => refreshProjects()} disabled={busy}>
                刷新
              </button>
              <button className="btn" onClick={() => createNewProject()} disabled={busy}>
                新建项目
              </button>
              <select
                className="sel"
                value={doc.mode === 'project' ? doc.id : ''}
                onChange={(e) => {
                  const id = e.target.value
                  if (!id) return
                  void openProject(id)
                }}
              >
                <option value="">打开项目…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title || p.id}
                  </option>
                ))}
              </select>
            </>
          ) : null}
        </div>

	        <div className="right">
	          {props.onBackToHub ? (
	            <button
	              className="btn secondary"
              onClick={async () => {
                const ok = await saveIfDirty()
                if (!ok) return
                props.onBackToHub?.()
              }}
              disabled={busy}
            >
              返回工作台
            </button>
          ) : null}

	          {props.onBack ? (
	            <button
	              className="btn secondary"
              onClick={async () => {
                const ok = await saveIfDirty()
                if (!ok) return
                props.onBack?.()
              }}
              disabled={busy}
            >
	              返回蓝图
	            </button>
	          ) : null}

	          {doc.story ? (
	            <select
	              className="sel"
	              value={runtimeStartNodeId || doc.story.startNodeId}
	              onChange={(e) => setRuntimeStartNodeId(e.target.value)}
	              title="播放起点（不影响蓝图结构/导出）"
	            >
	              {nodesForList.map((n) => (
	                <option key={n.id} value={n.id}>
	                  {nodeLabel(n as any) || '（未命名）'}
	                </option>
	              ))}
	            </select>
	          ) : null}

	          {doc.mode !== 'none' ? <div className="hint">当前：{doc.title}</div> : null}
	          {doc.mode !== 'none' ? (
	            <button className="btn secondary" onClick={() => setSelection({ type: 'none' })} disabled={busy}>
	              全局设置
	            </button>
	          ) : null}
            {doc.mode === 'project' && doc.story ? (
              <button
                className="btn secondary"
                onClick={() => {
                  initStoryboardBatchFromDoc()
                  setSbOpen(true)
                }}
                disabled={busy}
              >
                AI分镜批量
              </button>
            ) : null}
	          {problems.length ? <div className="hint" style={{ color: '#fca5a5' }}>校验：{problems.length} 个问题</div> : <div className="hint">校验：通过</div>}
	          <button className="btn secondary" onClick={() => restartRuntime()} disabled={!doc.story}>播放</button>
	          <button className="btn" onClick={() => saveCurrent()} disabled={busy || doc.mode !== 'project' || !dirty}>保存</button>
	          <button className="btn secondary" onClick={() => exportCurrent()} disabled={busy || doc.mode !== 'project'}>导出预览</button>
	          <button className="btn secondary" onClick={() => exportPublishCurrent()} disabled={busy || doc.mode !== 'project'}>导出发布包(H5)</button>
	        </div>
	      </div>

      <div className="main">
        <div className="panel">
          <div className="tabs">
            <div className={`tab ${leftTab === 'nodes' ? 'active' : ''}`} onClick={() => setLeftTab('nodes')}>节点</div>
            <div className={`tab ${leftTab === 'characters' ? 'active' : ''}`} onClick={() => setLeftTab('characters')}>角色</div>
            <div className={`tab ${leftTab === 'assets' ? 'active' : ''}`} onClick={() => setLeftTab('assets')}>资源</div>
          </div>

	          <div className="section">
	            {doc.project && doc.story ? null : null}

	            {leftTab === 'nodes' && doc.story ? (
	              <>
	                <div className="list">
	                  {nodesForList.map((n) => (
	                    <div
	                      key={n.id}
                      className={`item ${selection.type === 'node' && selection.id === n.id ? 'active' : ''}`}
                      onClick={() => setSelection({ type: 'node', id: n.id })}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <div>{nodeLabel(n as any) || n.id}</div>
                        <div className="meta">{nodeKindLabel((n as any).kind)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {leftTab === 'characters' && doc.project ? (
              <>
                <div className="hr" />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn secondary" onClick={() => addCharacter()} disabled={doc.readonly}>+ 角色</button>
                </div>
                <div className="hr" />
                <div className="list">
                  {doc.project.characters.map((c) => (
                    <div
                      key={c.id}
                      className={`item ${selection.type === 'character' && selection.id === c.id ? 'active' : ''}`}
                      onClick={() => setSelection({ type: 'character', id: c.id })}
                    >
                      <div>{c.name || c.id}</div>
                      <div className="meta">id: {c.id}</div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {leftTab === 'assets' && doc.project ? (
              <>
                <div className="hr" />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn secondary" onClick={() => addAsset()} disabled={doc.readonly}>+ 资源</button>
                </div>
                <div className="hr" />
                <div className="list">
                  {doc.project.assets.map((a) => (
                    <div
                      key={a.id}
                      className={`item ${selection.type === 'asset' && selection.id === a.id ? 'active' : ''}`}
                      onClick={() => setSelection({ type: 'asset', id: a.id })}
                    >
                      <div>{a.name || a.id}</div>
                      <div className="meta">id: {a.id}</div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </div>

        <div className="canvas">
          <div className="canvas-wrap" ref={canvasHostRef} />
          {doc.project && doc.story && effectivePreviewNode ? (
            <div
              className="stage-ui"
              ref={stageUiRef}
              style={
                stageViewport
                  ? {
                      width: stageViewport.stageW,
                      height: stageViewport.stageH,
                      transform: `translate(${stageViewport.offsetX}px, ${stageViewport.offsetY}px) scale(${stageViewport.scale})`,
                      transformOrigin: '0 0'
                    }
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
                        transform: 'translate(-50%, -50%)'
                      }
                    : {}

                const choicesStyle: CSSProperties = (() => {
                  if (choicesDir !== 'column') {
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
                    <div className="dialog-card" style={dialogCardStyle}>
                      {card?.bullets?.length ? (
                        <ul className="ending-bullets">
                          {card.bullets.map((b, i) => (
                            <li key={String(i)}>{b}</li>
                          ))}
                        </ul>
                      ) : null}
                      <div className="dialog-text">{card?.moral || '故事结束。'}</div>
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
                    <div className="dialog-card" style={dialogCardStyle}>
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

                    {hasText ? <div className="dialog-text">{displayText}</div> : null}

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
          ) : null}
        </div>

        <div className="panel right">{right}</div>
      </div>

      {toast ? (
        <div
          style={{
            position: 'fixed',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(2,6,23,0.92)',
            border: '1px solid rgba(148,163,184,0.22)',
            color: '#e5e7eb',
            padding: '8px 12px',
            borderRadius: 12,
            zIndex: 30
          }}
        >
          {toast}
        </div>
      ) : null}

      {latestExportModal.open ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 80,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(2,6,23,0.82)'
          }}
        >
          <div
            style={{
              width: 'min(560px, calc(100vw - 32px))',
              background: 'linear-gradient(180deg, #07163a 0%, #061436 100%)',
              border: '1px solid rgba(96,165,250,0.35)',
              borderRadius: 16,
              boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
              padding: 18
            }}
          >
            <div style={{ fontSize: 20, fontWeight: 700, color: '#e5e7eb', marginBottom: 8 }}>导出确认</div>
            <div style={{ fontSize: 14, color: '#cbd5e1', lineHeight: 1.6 }}>
              已存在 `latest` 导出，当前操作将覆盖之前的预览内容。请选择接下来的动作。
            </div>
            <div
              style={{
                marginTop: 14,
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid rgba(148,163,184,0.25)',
                background: 'rgba(15,23,42,0.75)',
                color: '#bfdbfe',
                fontSize: 13
              }}
            >
              当前任务：{latestExportModal.mode === 'publish' ? '导出发布包(H5)' : '导出预览'}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
              <button className="btn secondary" onClick={() => closeLatestExportModal('cancel')}>
                取消
              </button>
              <button className="btn secondary" onClick={() => closeLatestExportModal('delete')}>
                删除旧导出后继续
              </button>
              <button className="btn" onClick={() => closeLatestExportModal('overwrite')}>
                直接覆盖并继续
              </button>
            </div>
          </div>
        </div>
      ) : null}

	      <AiBackgroundModal
	        open={aiOpen}
	        value={aiReq}
	        busy={aiBusy}
	        analyzing={aiAnalyzing}
	        error={aiError}
          onAutoRecognize={async () => {
            if (doc.mode !== 'project' || !doc.story) return
            if (selection.type !== 'node') {
              setAiError('请先在左侧选择一个节点')
              return
            }
            const node0 = (doc.story.nodes || []).find((n) => n.id === selection.id) || null
            const node = node0 ? ensureNode(node0) : null
            if (!node) {
              setAiError('未找到当前节点')
              return
            }

            const title = String((node as any).body?.title || '').trim()
            const textRaw = String((node as any).body?.text || '').trim()
            const lines = textRaw
              .split(/\r?\n/)
              .map((x) => x.trim())
              .filter(Boolean)
            const picked: string[] = []
            for (const ln of lines) {
              if (/^选项(?:\d{1,2}|[A-Z])\s*[:：]/i.test(ln)) break
              picked.push(ln)
              if (picked.length >= 8) break
            }
            const main = picked.join('，').replace(/\s+/g, ' ').trim()
	            const projectTitle = doc.project ? String((doc.project as any).title || '').trim() : ''
	            const userInput = [title, main].filter(Boolean).join('：').slice(0, 600)
	            const userInputForAi0 =
	              projectTitle && !/故事名[:：]\s*《/.test(userInput)
	                ? `故事名：《${projectTitle}》\n${userInput}`
	                : userInput
              const userInputForAi = aiReq.backgroundOnly
                ? `${userInputForAi0}\n要求：仅生成背景空镜，不包含人物/动物/角色。`
                : userInputForAi0
	            if (!userInput) {
	              setAiError('当前场景没有可识别文本（body.text 为空）')
	              return
	            }

            setAiAnalyzing(true)
            setAiError('')
            try {
              const sceneLocks = aiReq.backgroundOnly ? '' : buildSceneCharacterLocks(node as any)
              const globalPromptForAi = [String(aiReq.globalPrompt || '').trim(), sceneLocks].filter(Boolean).join('，')
	              // Reset per-scene fields; keep global locks.
	              setAiReq((prev) => ({ ...prev, userInput, prompt: '', negativePrompt: '' }))
	              const res = await analyzeBackgroundPromptAi(doc.id, {
	                userInput: userInputForAi,
	                globalPrompt: globalPromptForAi,
	                globalNegativePrompt: aiReq.globalNegativePrompt,
	                aspectRatio: aiReq.aspectRatio,
	                style: aiReq.style,
                  outputLanguage: 'en'
	              })
              const nextGlobalPrompt = String(res.result?.globalPrompt || '').trim()
              const nextGlobalNegativePrompt = String(res.result?.globalNegativePrompt || '').trim()
              const bgOnlyNeg = '无人物,无动物,无角色'
              const nextSceneNeg0 = String(res.result?.finalNegativePrompt || res.result?.negativePrompt || '').trim()
              const nextScenePrompt = String(res.result?.finalPrompt || res.result?.prompt || '').trim()
              const nextSceneNeg = aiReq.backgroundOnly ? [nextSceneNeg0, bgOnlyNeg].filter(Boolean).join(', ') : nextSceneNeg0
              setAiReq((prev) => ({
                ...prev,
                userInput,
                globalPrompt: nextGlobalPrompt,
                globalNegativePrompt: nextGlobalNegativePrompt,
                prompt: nextScenePrompt,
                negativePrompt: nextSceneNeg,
                aspectRatio: (res.result?.aspectRatio as any) || prev.aspectRatio,
                style: (res.result?.style as any) || prev.style
              }))
              if (selection.type === 'node') {
                const nodeName = String((node as any).body?.title || node.name || node.id).trim() || node.id
                upsertStoryboardScenePrompt(selection.id, nodeName, {
                  userInput,
                  prompt: nextScenePrompt,
                  negativePrompt: nextSceneNeg
                })
                setSbItems((prev) =>
                  prev.map((x) =>
                    x.nodeId === selection.id
                      ? { ...x, nodeName, userInput, prompt: nextScenePrompt, negativePrompt: nextSceneNeg }
                      : x
                  )
                )
              }
              setDocProject((p) => {
                const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
                const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
                const nextState = { ...stateIn, aiBackground: { ...aiBgIn, globalPrompt: nextGlobalPrompt, globalNegativePrompt: nextGlobalNegativePrompt } }
                return { ...p, state: nextState }
              })
              setToast('已从当前场景自动识别并解析提示词')
            } catch (e) {
              setAiError(e instanceof Error ? e.message : String(e))
            } finally {
              setAiAnalyzing(false)
            }
          }}
	        onChange={(next) => {
	          setAiReq(next)
          if (doc.mode === 'project' && doc.project && selection.type === 'node' && doc.story) {
            const node0 = (doc.story.nodes || []).find((n) => n.id === selection.id) || null
            const node = node0 ? ensureNode(node0 as any) : null
            const nodeName = node ? String((node as any).body?.title || node.name || node.id).trim() || node.id : selection.id
            upsertStoryboardScenePrompt(selection.id, nodeName, {
              userInput: String(next.userInput || ''),
              prompt: String(next.prompt || ''),
              negativePrompt: String(next.negativePrompt || '')
            })
            setSbItems((prev) =>
              prev.map((x) =>
                x.nodeId === selection.id
                  ? { ...x, nodeName, userInput: String(next.userInput || ''), prompt: String(next.prompt || ''), negativePrompt: String(next.negativePrompt || '') }
                  : x
              )
            )
          }
	          if (doc.mode === 'project' && doc.project) {
	            const gp = String(next.globalPrompt || '')
	            const gneg = String(next.globalNegativePrompt || '')
	            setDocProject((p) => {
	              const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
	              const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
	              const nextState = { ...stateIn, aiBackground: { ...aiBgIn, globalPrompt: gp, globalNegativePrompt: gneg } }
	              return { ...p, state: nextState }
	            })
	          }
	        }}
	        onClose={() => {
	          setAiOpen(false)
	          setAiBusy(false)
	          setAiAnalyzing(false)
	          setAiError('')
	        }}
		        onAnalyze={async () => {
		          if (doc.mode !== 'project') return
		          const userInput = String(aiReq.userInput || '').trim()
		          if (!userInput) {
		            setAiError('请先输入「描述文本」')
		            return
		          }
		          const projectTitle = doc.project ? String((doc.project as any).title || '').trim() : ''
		          const userInputForAi0 =
		            projectTitle && !/故事名[:：]\s*《/.test(userInput)
		              ? `故事名：《${projectTitle}》\n${userInput}`
		              : userInput
              const userInputForAi = aiReq.backgroundOnly
                ? `${userInputForAi0}\n要求：仅生成背景空镜，不包含人物/动物/角色。`
                : userInputForAi0
		          setAiAnalyzing(true)
		          setAiError('')
			          try {
                  const node0 =
                    !aiReq.backgroundOnly && selection.type === 'node' && doc.story
                      ? (doc.story.nodes || []).find((n) => n.id === selection.id) || null
                      : null
                  const sceneLocks = node0 ? buildSceneCharacterLocks(ensureNode(node0 as any)) : ''
                  const globalPromptForAi = [String(aiReq.globalPrompt || '').trim(), sceneLocks].filter(Boolean).join('，')
			            const res = await analyzeBackgroundPromptAi(doc.id, {
			              userInput: userInputForAi,
			              globalPrompt: globalPromptForAi,
			              globalNegativePrompt: aiReq.globalNegativePrompt,
			              aspectRatio: aiReq.aspectRatio,
			              style: aiReq.style,
                      outputLanguage: 'en'
			            })
		            const nextGlobalPrompt = String(res.result?.globalPrompt || '').trim()
		            const nextGlobalNegativePrompt = String(res.result?.globalNegativePrompt || '').trim()
                const bgOnlyNeg = '无人物,无动物,无角色'
                const nextSceneNeg0 = String(res.result?.finalNegativePrompt || res.result?.negativePrompt || '').trim()
                const nextScenePrompt = String(res.result?.finalPrompt || res.result?.prompt || '').trim()
                const nextSceneNeg = aiReq.backgroundOnly ? [nextSceneNeg0, bgOnlyNeg].filter(Boolean).join(', ') : nextSceneNeg0
		            setAiReq((prev) => ({
		              ...prev,
		              globalPrompt: nextGlobalPrompt,
		              globalNegativePrompt: nextGlobalNegativePrompt,
		              prompt: nextScenePrompt,
		              negativePrompt: nextSceneNeg,
		              aspectRatio: (res.result?.aspectRatio as any) || prev.aspectRatio,
		              style: (res.result?.style as any) || prev.style
		            }))
                if (selection.type === 'node' && doc.story) {
                  const node0 = (doc.story.nodes || []).find((n) => n.id === selection.id) || null
                  const node = node0 ? ensureNode(node0 as any) : null
                  const nodeName = node ? String((node as any).body?.title || node.name || node.id).trim() || node.id : selection.id
                  upsertStoryboardScenePrompt(selection.id, nodeName, {
                    userInput,
                    prompt: nextScenePrompt,
                    negativePrompt: nextSceneNeg
                  })
                  setSbItems((prev) =>
                    prev.map((x) =>
                      x.nodeId === selection.id
                        ? { ...x, nodeName, userInput, prompt: nextScenePrompt, negativePrompt: nextSceneNeg }
                        : x
                    )
                  )
                }
		            setDocProject((p) => {
		              const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
		              const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
		              const nextState = { ...stateIn, aiBackground: { ...aiBgIn, globalPrompt: nextGlobalPrompt, globalNegativePrompt: nextGlobalNegativePrompt } }
		              return { ...p, state: nextState }
		            })
		            setToast('已解析提示词，可继续生成图片')
		          } catch (e) {
	            setAiError(e instanceof Error ? e.message : String(e))
	          } finally {
	            setAiAnalyzing(false)
	          }
	        }}
		        onSubmit={async () => {
		          if (doc.mode !== 'project' || !doc.project || !doc.story) return
		          if (selection.type !== 'node') {
		            setAiError('请先在左侧选择一个节点')
		            return
		          }
		          setAiBusy(true)
		          setAiError('')
		          try {
		            let gp = String(aiReq.globalPrompt || '').replace(/\s+/g, ' ').trim()
		            let sp = String(aiReq.prompt || '').replace(/\s+/g, ' ').trim()
                const payload: AiBackgroundRequest = { ...aiReq }
                if (!aiReq.backgroundOnly && selection.type === 'node' && doc.story) {
                  const node0 = (doc.story.nodes || []).find((n) => n.id === selection.id) || null
                  const sceneLocks = node0 ? buildSceneCharacterLocks(ensureNode(node0 as any)) : ''
                  gp = [gp, sceneLocks].filter(Boolean).join('，')
                  payload.globalPrompt = gp
                }
                if (aiReq.backgroundOnly) {
                  const hint = '空镜头，无人物无动物，无角色'
                  sp = sp ? `${sp}，${hint}` : hint
                  const negAdd = '无人物,无动物,无角色'
                  const neg0 = String(aiReq.negativePrompt || '').trim()
                  payload.negativePrompt = [neg0, negAdd].filter(Boolean).join(', ')
                }
                payload.prompt = sp
                if (selection.type === 'node' && doc.story) {
                  const node0 = (doc.story.nodes || []).find((n) => n.id === selection.id) || null
                  const node = node0 ? ensureNode(node0 as any) : null
                  const nodeName = node ? String((node as any).body?.title || node.name || node.id).trim() || node.id : selection.id
                  upsertStoryboardScenePrompt(selection.id, nodeName, {
                    userInput: String(payload.userInput || ''),
                    prompt: String(payload.prompt || ''),
                    negativePrompt: String(payload.negativePrompt || '')
                  })
                }
		            const usedPrompt = [gp, sp].filter(Boolean).join('，')
		            const resp = await generateBackgroundAi(doc.id, payload)
		            const rawProvider = String((resp as any).provider || '').trim()
		            const bgProvider: AssetV1['source'] extends { provider?: infer P } ? P : any =
		              rawProvider === 'sdwebui' || rawProvider === 'comfyui' || rawProvider === 'doubao' ? rawProvider : undefined
		            const nextUri = resp.url ? resolveUrl(resp.url) : resp.assetPath
		            setAiLast({ url: nextUri, assetPath: resp.assetPath, provider: rawProvider || undefined, remoteUrl: (resp as any).remoteUrl || undefined })
		            const node = (doc.story.nodes || []).find((n) => n.id === selection.id) || null
		            const bgId = String((node as any)?.visuals?.backgroundAssetId || '').trim()
		            const existing = bgId ? (doc.project.assets || []).find((a) => a.id === bgId) || null : null

			            if (bgId && existing) {
			              setDocProject((p) => ({
			                ...p,
			                    assets: (p.assets || []).map((a) =>
			                      a.id === bgId
			                    ? { ...a, uri: nextUri, source: { type: 'ai' as const, prompt: usedPrompt || aiReq.prompt, provider: bgProvider } }
			                    : a
			                )
			              }))
	              setDocStory((s) => ({
	                ...s,
                nodes: (s.nodes || []).map((n) =>
                  n.id === selection.id ? { ...ensureNode(n), visuals: { ...ensureNode(n).visuals, backgroundAssetId: bgId } } : n
                )
              }))
		            } else {
		              const assetId = uid('asset')
		                const asset: AssetV1 = {
		                  id: assetId,
		                  kind: 'image',
		                  name: `AI 背景 ${new Date().toLocaleString()}`,
		                  uri: nextUri,
		                source: { type: 'ai' as const, prompt: usedPrompt || aiReq.prompt, provider: bgProvider }
		                }
	              setDocProject((p) => ({ ...p, assets: [...(p.assets || []), asset] }))
	              setDocStory((s) => ({
	                ...s,
	                nodes: (s.nodes || []).map((n) =>
	                  n.id === selection.id ? { ...ensureNode(n), visuals: { ...ensureNode(n).visuals, backgroundAssetId: assetId } } : n
	                )
	              }))
	            }
			            let previewOk = true
			            try {
			              const r = await fetch(nextUri, { method: 'HEAD' })
			              previewOk = Boolean(r && r.ok)
			            } catch {
		              previewOk = false
		            }
		            setToast(previewOk ? '背景已生成并应用' : '背景已生成，但预览加载失败（检查静态服务/CORS）')
			          } catch (e) {
			            setAiError(e instanceof Error ? e.message : String(e))
			          } finally {
	            setAiBusy(false)
	          }
	        }}
	        result={aiLast}
	        onOpenDir={() => {
	          if (doc.mode !== 'project') return
	          const url = resolveUrl(`/api/projects/${encodeURIComponent(String(doc.id))}/assets/ai`)
	          window.open(url, '_blank', 'noopener,noreferrer')
	        }}
	        onOpenImage={() => {
	          const u = String(aiLast && aiLast.url ? aiLast.url : '').trim()
	          if (!u) return
	          window.open(u, '_blank', 'noopener,noreferrer')
	        }}
	        onOpenRemote={() => {
	          const u = String(aiLast && aiLast.remoteUrl ? aiLast.remoteUrl : '').trim()
	          if (!u) return
	          window.open(u, '_blank', 'noopener,noreferrer')
	        }}
	        onDownload={async () => {
	          const u = String(aiLast && aiLast.url ? aiLast.url : '').trim()
	          if (!u) return
	          try {
	            const r = await fetch(u)
	            if (!r.ok) throw new Error(`download_failed: ${r.status}`)
	            const blob = await r.blob()
	            const url = URL.createObjectURL(blob)
	            const a = document.createElement('a')
	            const name = String(aiLast && aiLast.assetPath ? aiLast.assetPath : '').split('/').filter(Boolean).pop() || 'background.png'
	            a.href = url
	            a.download = name
	            a.style.display = 'none'
	            document.body.appendChild(a)
	            a.click()
	            a.remove()
	            setTimeout(() => URL.revokeObjectURL(url), 10_000)
	            setToast('已开始下载图片')
	          } catch (e) {
	            setToast(e instanceof Error ? e.message : String(e))
	          }
	        }}
	      />

        <AiStoryboardBatchModal
          open={sbOpen}
          value={{
            prompt: '',
            entitySpec: sbReq.entitySpec,
            storyBibleJson: sbReq.storyBibleJson,
            globalPrompt: sbReq.globalPrompt,
            globalNegativePrompt: sbReq.globalNegativePrompt,
            style: sbReq.style,
            aspectRatio: sbReq.aspectRatio,
            width: sbReq.width,
            height: sbReq.height,
            steps: sbReq.steps,
            cfgScale: sbReq.cfgScale,
            sampler: sbReq.sampler,
            scheduler: sbReq.scheduler
          }}
          items={sbItems}
          busyGenerate={sbBusyGenerate}
          busyApply={sbBusyApply}
          busyEntity={sbBusyEntity}
          continuityReady={sbContinuityReady}
          continuitySummary={sbContinuitySummary}
          continuityBusy={sbContinuityBusy}
          continuityConfig={sbReq.continuity}
          characters={collectStoryboardUsedCharacters().map((ch) => ({
            id: String(ch.id || ''),
            name: String(ch.name || ch.id || ''),
            fingerprintPrompt: String(ch.ai?.fingerprintPrompt || '').trim(),
            referenceAssetId: String(ch.ai?.referenceAssetId || '').trim(),
            hasSprite: Boolean(String(ch.imageAssetId || '').trim())
          }))}
          elapsedMs={sbElapsedMs}
          generatingNodeId={sbGeneratingNodeId}
          generatingNodeElapsedMs={sbGeneratingNodeElapsedMs}
          error={sbError}
          logs={sbLogs}
          onGenerateEntity={runStoryboardGenerateEntitySpec}
          onClearStoryBible={() => {
            setSbReq((prev) => ({ ...prev, storyBibleJson: '' }))
            setSbContinuityReady(false)
            if (doc.mode === 'project') {
              setDocProject((p) => {
                const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
                const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
                const nextAiBg = { ...aiBgIn }
                delete (nextAiBg as any).storyBible
                delete (nextAiBg as any).storyBibleJson
                const nextState = { ...stateIn, aiBackground: nextAiBg }
                return { ...p, state: nextState }
              })
            }
          }}
          onRunContinuityTest={() => void runStoryboardContinuityTest()}
          onChangeContinuityConfig={(patch) => {
            setSbReq((prev) => ({ ...prev, continuity: { ...(prev.continuity || {}), ...(patch || {}) } }))
            setSbContinuityReady(false)
            if (doc.mode === 'project') {
              setDocProject((p) => {
                const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
                const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
                const nextState = {
                  ...stateIn,
                  aiBackground: { ...aiBgIn, storyboardContinuity: { ...(aiBgIn as any).storyboardContinuity, ...(patch || {}) } }
                }
                return { ...p, state: nextState }
              })
            }
          }}
          onGenerateCharacterRef={(characterId) => void generateStoryboardCharacterReference(characterId)}
          onBindCharacterRefFromSprite={(characterId) => bindStoryboardCharacterRefFromSprite(characterId)}
          onClearCharacterRef={(characterId) => clearStoryboardCharacterRef(characterId)}
          onChange={(next) => {
            setSbReq((prev) => {
              const merged = {
                ...prev,
                storyBibleJson: String((next as any).storyBibleJson || ''),
                entitySpec: String((next as any).entitySpec || ''),
                globalPrompt: String(next.globalPrompt || ''),
                globalNegativePrompt: String(next.globalNegativePrompt || ''),
                style: (next.style || prev.style) as any,
                aspectRatio: (next.aspectRatio || prev.aspectRatio) as any,
                width: Number(next.width ?? prev.width),
                height: Number(next.height ?? prev.height),
                steps: Number(next.steps ?? prev.steps),
                cfgScale: Number(next.cfgScale ?? prev.cfgScale),
                sampler: String(next.sampler || prev.sampler || 'DPM++ 2M'),
                scheduler: String(next.scheduler || prev.scheduler || 'Automatic')
              }
              // When Story Bible JSON is present and valid, keep entitySpec derived (read-only downstream).
              const storyBibleObj = tryParseStoryBibleJson(merged.storyBibleJson)
              if (storyBibleObj) merged.entitySpec = buildEntitySpecFromStoryBible(storyBibleObj)
              setSbContinuityReady(false)
              upsertStoryboardBatchDraft({
                style: merged.style,
                aspectRatio: merged.aspectRatio,
                width: merged.width,
                height: merged.height,
                steps: merged.steps,
                cfgScale: merged.cfgScale,
                sampler: merged.sampler,
                scheduler: merged.scheduler
              })
              return merged
            })
            if (doc.mode === 'project') {
              setDocProject((p) => {
                const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
                const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
                const storyBibleObj = tryParseStoryBibleJson((next as any).storyBibleJson)
                const entitySpecDerived = storyBibleObj ? buildEntitySpecFromStoryBible(storyBibleObj) : String((next as any).entitySpec || '')
                const nextState = {
                  ...stateIn,
                  aiBackground: {
                    ...aiBgIn,
                    storyboardEntitySpec: String(entitySpecDerived || '').trim(),
                    storyBible: storyBibleObj || undefined,
                    storyBibleJson: String((next as any).storyBibleJson || ''),
                    globalPrompt: String(next.globalPrompt || ''),
                    globalNegativePrompt: String(next.globalNegativePrompt || '')
                  }
                }
                return { ...p, state: nextState }
              })
            }
          }}
          onChangeItem={(nodeId, patch) =>
            setSbItems((prev) => {
              const next = prev.map((x) => (x.nodeId === nodeId ? { ...x, ...patch } : x))
              const changed = next.find((x) => x.nodeId === nodeId) || null
              if (changed) {
                upsertStoryboardScenePrompt(nodeId, changed.nodeName, {
                  userInput: patch.userInput != null ? String(patch.userInput || '') : undefined,
                  prompt: patch.prompt != null ? String(patch.prompt || '') : undefined,
                  negativePrompt: patch.negativePrompt != null ? String(patch.negativePrompt || '') : undefined
                })
              }
              return next
            })
          }
          onClearGlobalPrompt={() => {
            setSbReq((prev) => ({ ...prev, globalPrompt: '' }))
            setSbContinuityReady(false)
            if (doc.mode === 'project') {
              setDocProject((p) => {
                const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
                const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
                const nextState = { ...stateIn, aiBackground: { ...aiBgIn, globalPrompt: '' } }
                return { ...p, state: nextState }
              })
            }
            appendSbLog('已清空全局正向提示词')
          }}
          onClearGlobalNegativePrompt={() => {
            setSbReq((prev) => ({ ...prev, globalNegativePrompt: '' }))
            setSbContinuityReady(false)
            if (doc.mode === 'project') {
              setDocProject((p) => {
                const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
                const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
                const nextState = { ...stateIn, aiBackground: { ...aiBgIn, globalNegativePrompt: '' } }
                return { ...p, state: nextState }
              })
            }
            appendSbLog('已清空全局负向提示词')
          }}
          onClose={() => {
            if (sbBusyGenerate || sbBusyApply || sbBusyEntity) return
            setSbOpen(false)
            setSbError('')
          }}
          onGenerateAll={() => void runStoryboardGenerateAllPrompts('all')}
          onRetryPending={() => void runStoryboardGenerateAllPrompts('pending')}
          onApplyAll={() => void runStoryboardValidateAndApply('all')}
          canApplyAll={sbAllPromptsReady}
          onRetryApplyPending={() => void runStoryboardValidateAndApply('pending')}
          queuePhase={sbQueuePhase}
          queuePaused={sbQueuePaused}
          onPauseQueue={pauseSbQueue}
          onResumeQueue={resumeSbQueue}
          onCancelQueue={cancelSbQueue}
        />

        <AiCharacterSpriteModal
          open={chOpen}
          title="AI 生成角色 PNG（透明）"
          value={chDraft}
          busy={chBusy}
          error={chError}
          green={chGreen}
          transparentPreviewUrl={chTransparentPreviewUrl}
          onChange={(next) => setChDraft(next)}
          onClose={() => {
            setChOpen(false)
            setChBusy(false)
            setChError('')
            setChGreen(null)
            setChTransparentPreviewUrl('')
            chTargetRef.current = null
          }}
          onGenerateGreen={() => void generateCharacterGreen()}
          onApplyTransparent={() => void applyCharacterTransparent()}
        />
	    </div>
	  )
}
