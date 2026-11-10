import { useEffect, useMemo, useRef, useState } from 'react'
import { markStartupReady } from '../startupReady'
import { dlgAlert } from '../dialog'
import {
  analyzeSceneElements,
  compileCompose,
  getBlueprint,
  getProject,
  getScripts,
  getStudioSettings,
  getTtsVoices,
  generateSceneVoice,
  listAllAiTasks,
  addPlanAsset,
  assignPlanSceneAsset,
  saveBlueprint,
  saveSceneCompositionDraft,
  saveAssetPoseRequirements,
  extractStoryPoseStatesAi,
  persistStoryAssetPlanAi,
  normalizeAssetNamesAi,
  extractStoryPropStatesAi,
  type BlueprintDocV1,
  type BlueprintNodeV1,
  type PlaceholderKindV1,
  type PlaceholderV1,
  type ScriptDocV1,
  type TtsVoiceGroup
} from '../api'
import { readStoryboardAssetPlanFromProject } from './compose/orchestration/storyboardPlan'
import { computeElementMarks, computeReadiness, computeStageSteps, elementDisplayName, elementGroupLabel, elementStageOf, elementStageTitle, storyImageCoverage, type ElementMark, type StageStep } from './blueprint/readiness'
import PrevizPlayer, { previzGroupScopeOf, type PrevizBlockInfo, type PrevizLayoutOverrides, type PrevizLayoutValue } from './blueprint/PrevizPlayer'
import { deriveSceneLayout, layoutToCompositionItems } from './blueprint/previzLayout'
import { confirmRerun } from '../components/shared/confirmRerun'
import { onTaskStop, stopActiveAiTasks } from '../tasks/stopTask'
import StageStepper from './blueprint/StageStepper'
// R 波项 3（2026-10-27）：姿势提示词组装器/配方应用迁入蓝图姿态需求清单（锁定向导定义期 UI 同款实现，配方库读写路径不变）
// 2026-11-01：需求清单编辑抽至共享组件 components/pose/PoseRequirementEditor（锁定向导定义期 UI 退役，蓝图是唯一定义入口）
import { BUILTIN_POSE_RECIPES } from '../poseRecipes'
import PoseRequirementEditor from '../components/pose/PoseRequirementEditor'
import { usePoseRequirementOps } from '../components/pose/usePoseRequirementOps'
import { toProjectAssetUrl } from '../components/pose/assetUrl'
type Props = {
  projectId: string
  onBack: () => void
  onNext: () => void
}

type Selection =
  | { type: 'none' }
  | { type: 'node'; id: string }
  // D1：预演视图里点选元素块（右栏显示元素位置/大小属性，改数值等同画框拖动）
  | { type: 'previzElement'; nodeId: string; assetId: string }
  // F 波：组编辑激活（双击块进该块所属组）→ 右栏组管理面板（只列本组元素）
  | { type: 'previzGroup'; nodeId: string; group: '背景' | '角色' | '道具' }

// D1（2026-10-25 用户裁决）：中栏三视图——卡片 / 结构图 / 预演（占位预演内嵌，不再是全屏弹窗）
type CanvasView = 'grid' | 'graph' | 'previz'

function nodeKindLabel(kind: BlueprintNodeV1['kind']) {
  return kind === 'ending' ? '结局' : '场景'
}

function nodeTitleForUI(n: BlueprintNodeV1, scriptCards: ScriptDocV1['cards']) {
  if (n.kind === 'ending') return n.name || n.id
  const sc = (scriptCards || []).find((c) => c.id === n.scriptCardId)
  return sc ? `#${sc.order} ${sc.name || sc.id}` : (n.name || n.id)
}

function elementKindLabel(kind: PlaceholderKindV1) {
  // 2026-10-21 B1 波裁决：原「事件要素」无数据源支撑，改标「道具要素」（plan.json category=prop）；
  // 手工占位数据模型 kind 未动（仍 background/actor/event），仅展示名变更。
  return kind === 'background' ? '背景要素' : kind === 'actor' ? '角色要素' : '道具要素'
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
  const [elementsOpen, setElementsOpen] = useState<Record<PlaceholderKindV1, boolean>>({ background: true, actor: true, event: true })
  const [deleteElement, setDeleteElement] = useState<{ id: string; kind: PlaceholderKindV1 } | null>(null)
  const [pickActorIds, setPickActorIds] = useState<string[]>([])
  const [pickEventIds, setPickEventIds] = useState<string[]>([])
  // 2026-10-21 B1/B2/C1：占位预演（唯一演示形态）/ 资产计划（元素标记同源）/ 语音开关（准备度配音维度）
  // D1（2026-10-25 用户裁决）：预演内嵌中栏第三视图——previzOpen 弹窗态退役，改视图切换 + 编排状态
  const [previzSceneId, setPrevizSceneId] = useState('') // 预演视图当前幕（受控于 PrevizPlayer 上报）
  const [previzBlocks, setPrevizBlocks] = useState<PrevizBlockInfo[]>([]) // 当前幕块现状快照（右栏属性数据源）
  const [previzDraftMsg, setPrevizDraftMsg] = useState('') // 需求单草稿写回失败红字（G 波：成功反馈统一到顶栏「已保存·刚刚」）
  const [savedTick, setSavedTick] = useState(false) // 顶栏「已保存·刚刚」（G 波：保存语义翻转后仅在点保存成功后亮）
  const [previzDoneTick, setPrevizDoneTick] = useState(0) // 预演完成标记写入后驱动 previzAt 重读
  // G 波（2026-10-26 用户裁决）：编排改「脏→保存」语义——全部暂存按幕双键记（修跨幕串味），不再自动写盘
  const [previzGroupEdit, setPrevizGroupEdit] = useState<'背景' | '角色' | '道具' | null>(null)
  const [previzOverridesByScene, setPrevizOverridesByScene] = useState<Record<string, PrevizLayoutOverrides>>({}) // sceneId → assetId → 覆盖
  const [previzSubDraftsByScene, setPrevizSubDraftsByScene] = useState<Record<string, Record<string, { parentAssetId: string; subName: string }>>>({}) // sceneId → subId → 子元素
  const [previzRemovedSubsByScene, setPrevizRemovedSubsByScene] = useState<Record<string, Record<string, true>>>({}) // sceneId → 已落盘但被移除的子元素
  const [previzDirtyScenes, setPrevizDirtyScenes] = useState<Record<string, true>>({}) // 脏幕集
  const [subNameInput, setSubNameInput] = useState<Record<string, string>>({}) // 组面板行内拆分输入（F 波）
  // L 波（2026-10-27 设计裁决）：要素库多级管理 state——展开态/行内改名态
  const [elementOpen, setElementOpen] = useState<Record<string, boolean>>({})
  const [renameState, setRenameState] = useState<{ assetId: string; value: string } | null>(null)
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameErr, setRenameErr] = useState('')
  // K 波（2026-10-27 姿态需求前移蓝图）：需求清单写口——2026-11-01 抽至 usePoseRequirementOps + PoseRequirementEditor 共享组件
  // （锁定向导定义期 UI 已退役，蓝图是需求定义唯一入口；编辑清单/组装器/配方/AI 建议/翻译都在共享组件内）
  const poseReqOps = usePoseRequirementOps({
    upsertAll: async (assetId, requirements) => {
      const res = await saveAssetPoseRequirements(props.projectId, assetId, requirements)
      return Boolean(res?.success)
    },
    onSaved: async (assetId) => {
      await load()
      // load 清选中（既有防脏语义）——需求编辑后回到该元素属性面板（C 波配音同款修法）
      setSelection({ type: 'previzElement', nodeId: previzSceneIdRef.current, assetId })
    }
  })
  const [poseExtractBusy, setPoseExtractBusy] = useState(false)
  // M 波（2026-10-27）：AI 补齐中文名 / 补齐多态需求
  const [normalizeNamesBusy, setNormalizeNamesBusy] = useState(false)
  const [fillStatesBusy, setFillStatesBusy] = useState(false)
  const [project, setProject] = useState<any>(null)
  // A 波（2026-10-25）：点预演文本区回场景属性并聚焦文本草稿
  const [textDraftFocusTick, setTextDraftFocusTick] = useState(0)
  const textDraftRef = useRef<HTMLTextAreaElement | null>(null)
  // B 波（2026-10-25，§4.5）：场景属性「声音」区——音色库/选中音色/语速/生成状态
  const [ttsProvider, setTtsProvider] = useState('')
  const [voiceGroups, setVoiceGroups] = useState<TtsVoiceGroup[]>([])
  const [voiceId, setVoiceId] = useState('')
  const [voiceSpeed, setVoiceSpeed] = useState(1)
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [voiceNote, setVoiceNote] = useState('')
  const [voiceErr, setVoiceErr] = useState('')
  const [ttsEnabled, setTtsEnabled] = useState<boolean | null>(null)
  // B2+：结构图缩放/平移（仅存组件态）+ 步骤条提示
  const [graphZoom, setGraphZoom] = useState(1)
  const [graphPan, setGraphPan] = useState({ x: 0, y: 0 })
  const [stepNote, setStepNote] = useState('')
  // B2+：AI 场景分析状态
  const [analyzeBusy, setAnalyzeBusy] = useState(false)
  const analyzeQueueCancelRef = useRef(false)
  useEffect(() => onTaskStop((detail) => {
    if (!detail.projectId || detail.projectId === props.projectId) analyzeQueueCancelRef.current = true
  }), [props.projectId])
  const [analyzeErr, setAnalyzeErr] = useState('')
  const [analyzeNote, setAnalyzeNote] = useState('')
  // B2+ 加项（2026-10-25）：分析全部场景——未分析幕串行逐幕分析（本地模型纪律：同一模型调用禁止并发）
  const [promptReady, setPromptReady] = useState<boolean | null>(null)
  const [analyzeAllBusy, setAnalyzeAllBusy] = useState(false)
  const [analyzeAllProgress, setAnalyzeAllProgress] = useState<{ done: number; total: number } | null>(null)
  const [analyzeAllNote, setAnalyzeAllNote] = useState('')
  const [analyzeAllErr, setAnalyzeAllErr] = useState('')
  // 本项目正在执行的任务（步骤条「正在执行」明示 + 对应步骤蓝脉冲；2026-10-21 用户指令：进度/任务提示必须明面）
  const [liveTasks, setLiveTasks] = useState<Array<{ kind: string; message: string; createdAt: string; current: number; total: number }>>([])

  async function load() {
    setBusy(true)
    setError('')
    try {
      const [s, b, p, st] = await Promise.all([
        getScripts(props.projectId),
        getBlueprint(props.projectId),
        getProject(props.projectId).catch(() => null),
        getStudioSettings().catch(() => null)
      ])
      setScripts(s)
      setBlueprint(b)
      setProject(p)
      setTtsEnabled(st?.effective?.enabled?.tts === true)
      // 提示词能力就绪（场景元素分析走 prompt 通道）：未启用/未选 Provider 时批量按钮禁用给引导；通道不可达由首次调用失败兜底
      setPromptReady(
        Boolean(
          st?.effective?.enabled?.prompt &&
            String(st?.effective?.prompt?.provider || '').trim() &&
            String(st?.effective?.prompt?.provider || '').trim().toLowerCase() !== 'none'
        )
      )
      setSelection({ type: 'none' })
      // D1：中栏视图记忆恢复（卡片/结构图/预演）
      try {
        const v = localStorage.getItem(`bp.canvasView.${props.projectId}`)
        setCanvasView(v === 'grid' || v === 'graph' || v === 'previz' ? v : 'graph')
      } catch {}
      // B 波：语音启用时拉音色库（分组）；通道/默认音色来自 effective.tts
      const ttsProviderNow = String(st?.effective?.tts?.provider || '').trim().toLowerCase()
      setTtsProvider(ttsProviderNow)
      if (st?.effective?.enabled?.tts === true && ttsProviderNow && ttsProviderNow !== 'none') {
        getTtsVoices(ttsProviderNow)
          .then((groups) => setVoiceGroups(groups))
          .catch(() => setVoiceGroups([]))
      } else {
        setVoiceGroups([])
      }
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

  // 2026-11-02 场景背景卡「编辑元素」回跳：消费 talkscene.blueprint.sceneFocus 载荷 → 预演视图落定该幕并选中（右栏=场景属性含要素分配）
  // 守卫窗口内若并发 load 清掉选中则自动复位（实测存在 load 二次执行清选中竞态）
  const sceneFocusRef = useRef<{ sceneId: string; until: number } | null>(null)
  useEffect(() => {
    if (busy || !blueprint) return
    if (!sceneFocusRef.current) {
      try {
        const raw = localStorage.getItem('talkscene.blueprint.sceneFocus') || ''
        if (!raw) return
        const payload = JSON.parse(raw)
        if (!payload || String(payload.projectId || '') !== props.projectId || !String(payload.sceneId || '').trim()) return
        localStorage.removeItem('talkscene.blueprint.sceneFocus')
        const sceneId = String(payload.sceneId).trim()
        sceneFocusRef.current = { sceneId, until: Date.now() + 8000 }
        setCanvasView('previz')
        // 同步视图记忆：防止后续 load() 按旧记忆把视图拉回结构图
        try { localStorage.setItem(`bp.canvasView.${props.projectId}`, 'previz') } catch {}
        setPrevizSceneId(sceneId)
        setSelection({ type: 'node', id: sceneId })
      } catch { /* 载荷异常忽略 */ }
      return
    }
    const f = sceneFocusRef.current
    if (Date.now() > f.until) return
    const nodeHit = Array.isArray(blueprint?.nodes) && blueprint.nodes.some((n: any) => n.id === f.sceneId)
    if (canvasView === 'previz' && selection.type === 'none' && nodeHit) {
      setSelection({ type: 'node', id: f.sceneId })
    }
  }, [busy, blueprint, canvasView, selection, props.projectId])

  // 轮询本项目正在执行的任务（4s；驱动步骤条「正在执行 · 已用秒数」明示与步骤蓝脉冲）
  useEffect(() => {
    let alive = true
    async function poll() {
      if (!alive) return
      try {
        const list = await listAllAiTasks(false)
        if (!alive) return
        setLiveTasks(
          list
            .filter((t) => t.projectId === props.projectId && !t.done)
            .map((t) => ({ kind: t.kind, message: t.message, createdAt: t.createdAt, current: t.current, total: t.total }))
        )
      } catch {
        /* 轮询失败下轮再来 */
      }
    }
    void poll()
    const timer = window.setInterval(poll, 4000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
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
      // G 波：保存=蓝图文档（若脏）+ 逐幕编排草稿落盘（参数化 sceneId——修切幕竞态；逐幕串行）
      if (dirty) {
        const next = await saveBlueprint(props.projectId, blueprint)
        setBlueprint(next)
        setDirty(false)
      }
      const dirtyScenes = Object.keys(previzDirtyScenes)
      let droppedTotal = 0
      const droppedIds: string[] = []
      for (const sid of dirtyScenes) {
        const r = await persistPrevizDraftFor(sid)
        droppedTotal += r.dropped
        droppedIds.push(...r.droppedSubjectIds)
      }
      if (droppedTotal > 0) {
        setError(`保存完成，但有 ${droppedTotal} 个占位块未落盘（对应元素已不在资产计划中，可能已被移除）：${[...new Set(droppedIds)].slice(0, 6).join('、')}`)
      }
      if (dirtyScenes.length) {
        // 落盘后清暂存（draft 读序接管显示）并重拉 plan
        const drop = <T,>(prev: Record<string, T>) => {
          const n = { ...prev }
          dirtyScenes.forEach((s) => delete n[s])
          return n
        }
        setPrevizDirtyScenes({})
        setPrevizOverridesByScene(drop)
        setPrevizSubDraftsByScene(drop)
        setPrevizRemovedSubsByScene(drop)
        await load()
      }
      setSavedTick(true)
      window.setTimeout(() => setSavedTick(false), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // G 波：离开蓝图层守卫（有脏幕编排先 confirm）
  function guardedNext() {
    if (!confirmPrevizLeaveStage()) return
    void next()
  }
  function guardedBack() {
    if (!confirmPrevizLeaveStage()) return
    props.onBack()
  }
  function guardedGotoLockWorkspace() {
    if (!confirmPrevizLeaveStage()) return
    gotoLockWorkspace()
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

  // 2026-10-26 用户实测修正：要素库 + 号产出真实计划资产（plan 同源），不再写废弃占位库；
  // 内联表单开在组顶部（名称+确认/取消，全程可见可达）。
  const [addElementForm, setAddElementForm] = useState<{ kind: PlaceholderKindV1; name: string } | null>(null)
  const [addElementBusy, setAddElementBusy] = useState(false)

  function kindToPlanCategory(kind: PlaceholderKindV1): 'character' | 'location' | 'prop' {
    if (kind === 'actor') return 'character'
    if (kind === 'background') return 'location'
    return 'prop'
  }

  async function addPlanElement() {
    const form = addElementForm
    if (!form || !form.name.trim() || addElementBusy) return
    setAddElementBusy(true)
    setAnalyzeErr('')
    try {
      const res = await addPlanAsset(props.projectId, { name: form.name.trim(), category: kindToPlanCategory(form.kind) })
      if (!res?.success) throw new Error(res?.message || '新增失败')
      setAddElementForm(null)
      await load()
    } catch (e) {
      setAnalyzeErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAddElementBusy(false)
    }
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
      void dlgAlert('请先设置 startNodeId')
      return
    }

    const hasEnding = (blueprint.nodes || []).some((n) => n.kind === 'ending')
    if (!hasEnding) {
      void dlgAlert('当前蓝图还没有任何「结局」节点，请先添加至少一个结局。')
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

  // B1 波：元素标记与准备度（全部只读派生，与 plan.json/story.json 同源）
  // 注意：getProject 返回 { project, story } 包裹——plan 在 project.state，story 在包裹顶层
  const assetPlan = useMemo(() => readStoryboardAssetPlanFromProject(project?.project), [project])
  const storyCoverage = useMemo(() => storyImageCoverage(project), [project])
  const elementMarks = useMemo(() => computeElementMarks(assetPlan, canvasNodes, { storyNodes: Array.isArray(project?.story?.nodes) ? project.story.nodes : [] }), [assetPlan, canvasNodes, project?.story?.nodes])
  const readiness = useMemo(
    () => computeReadiness({ problems, plan: assetPlan, story: storyCoverage, ttsEnabled, sceneIds: canvasNodes.map((n) => n.id) }),
    [problems, assetPlan, storyCoverage, ttsEnabled, canvasNodes]
  )
  // 左栏要素库：plan 元素按真实类目归族（location→背景/character→角色/prop→道具（event 组））
  const planElementsByGroup = useMemo(() => {
    const m: Record<'background' | 'actor' | 'event', (ElementMark & { sceneCount: number })[]> = { background: [], actor: [], event: [] }
    const assets = Array.isArray(assetPlan?.assets) ? (assetPlan!.assets as any[]) : []
    // 实况计数（2026-10-26 用户实测修复）：从各幕 assetIds 现算"几幕在用"，不用计划生成时烘焙的旧字段
    const liveCount = new Map<string, number>()
    const planScenes = Array.isArray(assetPlan?.scenes) ? (assetPlan as any).scenes : []
    for (const sc of planScenes) {
      for (const raw of Array.isArray(sc?.assetIds) ? sc.assetIds : []) {
        const k = String(raw)
        liveCount.set(k, (liveCount.get(k) || 0) + 1)
      }
    }
    const seenNames = new Set<string>()
    for (const a of assets) {
      const name = elementDisplayName(a)
      if (seenNames.has(name)) continue // B2 复查：同名资产只显示一次
      seenNames.add(name)
      const g = elementGroupLabel(String(a?.category || ''))
      // 2026-11-06 背景元素（环境族）归背景组——与预演组归属同口径（背景组=主背景+环境+背景子元素）
      const key = g === '背景' || g === '环境' ? 'background' : g === '角色' ? 'actor' : 'event'
      m[key].push({
        id: String(a?.id || ''),
        name,
        category: String(a?.category || ''),
        state: elementStageOf(a),
        stageTitle: elementStageTitle(a),
        sceneCount: liveCount.get(String(a?.id || '')) || 0
      })
    }
    return m
  }, [assetPlan])

  // L 波：要素库多级管理——子级清单派生（角色：姿态需求+姿势变体按 stateKey 合并；道具：状态需求+状态变体；
  // 背景：环境子元素=构图草稿里带 parentAssetId 的拆分子元素，跨幕按 parentAssetId+subName 去重）
  type ElementChild = { key: string; label: string; tone: 'done' | 'todo'; kind: '姿态' | '状态' | '子元素' }
  const elementChildrenById = useMemo(() => {
    const m = new Map<string, ElementChild[]>()
    const assets = Array.isArray(assetPlan?.assets) ? (assetPlan!.assets as any[]) : []
    for (const a of assets) {
      const aid = String(a?.id || '').trim()
      if (!aid) continue
      const children: ElementChild[] = []
      const cat = String(a?.category || '')
      if (cat === 'character') {
        const variantKeys = new Set(
          (Array.isArray(a?.poseVariants) ? a.poseVariants : []).map((v: any) => String(v?.stateKey || '').trim()).filter(Boolean)
        )
        const reqKeys = new Set<string>()
        for (const r of Array.isArray(a?.poseRequirements) ? a.poseRequirements : []) {
          const k = String(r?.stateKey || r?.reqId || '').trim()
          if (!k || reqKeys.has(k)) continue
          reqKeys.add(k)
          children.push({ key: k, label: String(r?.label || r?.pose || k), tone: variantKeys.has(k) ? 'done' : 'todo', kind: '姿态' })
        }
        for (const v of Array.isArray(a?.poseVariants) ? a.poseVariants : []) {
          const k = String(v?.stateKey || '').trim()
          if (!k || reqKeys.has(k)) continue
          reqKeys.add(k)
          children.push({ key: k, label: String(v?.name || k), tone: 'done', kind: '姿态' })
        }
      } else if (cat === 'prop') {
        const variantKeys = new Set(
          (Array.isArray(a?.stateVariants) ? a.stateVariants : []).map((v: any) => String(v?.stateKey || '').trim()).filter(Boolean)
        )
        const reqKeys = new Set<string>()
        for (const r of Array.isArray(a?.stateRequirements) ? a.stateRequirements : []) {
          const k = String(r?.stateKey || '').trim()
          if (!k || reqKeys.has(k)) continue
          reqKeys.add(k)
          children.push({ key: k, label: String(r?.label || k), tone: variantKeys.has(k) ? 'done' : 'todo', kind: '状态' })
        }
        for (const v of Array.isArray(a?.stateVariants) ? a.stateVariants : []) {
          const k = String(v?.stateKey || '').trim()
          if (!k || reqKeys.has(k)) continue
          reqKeys.add(k)
          children.push({ key: k, label: String(v?.name || k), tone: 'done', kind: '状态' })
        }
      } else if (cat === 'location') {
        // 环境子元素：各幕构图草稿 items 里 parentAssetId=本背景资产的拆分子元素（跨幕去重）
        const seen = new Set<string>()
        for (const sc of Array.isArray(assetPlan?.scenes) ? (assetPlan!.scenes as any[]) : []) {
          for (const it of Array.isArray(sc?.composition?.items) ? sc.composition.items : []) {
            if (String(it?.parentAssetId || '').trim() !== aid) continue
            const sub = String(it?.subName || '').trim()
            if (!sub || seen.has(sub)) continue
            seen.add(sub)
            children.push({ key: String(it?.subjectId || sub), label: sub, tone: 'done', kind: '子元素' })
          }
        }
      }
      if (children.length) m.set(aid, children)
    }
    return m
  }, [assetPlan])

  // L 波：行内改名——写 plan 资产 name 走既有 plan persist 链（mergeAssetsById 纪律；改的是真相源，即时落盘）
  async function renamePlanAsset(assetId: string, newName: string) {
    const name = newName.trim()
    if (!name || renameBusy) return
    setRenameBusy(true)
    setRenameErr('')
    try {
      const assets = Array.isArray(assetPlan?.assets) ? (assetPlan!.assets as any[]) : []
      const nextPlan = {
        ...(assetPlan as any),
        assets: assets.map((a) => (String(a?.id || '').trim() === assetId ? { ...a, name } : a))
      }
      await persistStoryAssetPlanAi(props.projectId, { plan: nextPlan as any })
      setRenameState(null)
      await load()
    } catch (e) {
      setRenameErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRenameBusy(false)
    }
  }

  // L 波：背景子元素改名（锚点词）——逐幕构图草稿 items 里该子元素项改 subName（composition-draft 整组重写语义，串行）
  async function renameSubElementName(parentAssetId: string, oldName: string, newName: string) {
    const name = newName.trim().slice(0, 32)
    if (!name || name === oldName || renameBusy) return
    setRenameBusy(true)
    setRenameErr('')
    try {
      const scenes = Array.isArray(assetPlan?.scenes) ? (assetPlan!.scenes as any[]) : []
      for (const sc of scenes) {
        const items = Array.isArray(sc?.composition?.items) ? sc.composition.items : []
        const hit = items.some((it: any) => String(it?.parentAssetId || '') === parentAssetId && String(it?.subName || '') === oldName)
        if (!hit) continue
        const nextItems = items.map((it: any) =>
          String(it?.parentAssetId || '') === parentAssetId && String(it?.subName || '') === oldName ? { ...it, subName: name } : it
        )
        await saveSceneCompositionDraft(
          props.projectId,
          String(sc.sceneId || ''),
          nextItems.map((it: any) => ({
            subjectId: String(it.subjectId || ''),
            x: Number(it.x) || 0,
            y: Number(it.y) || 0,
            scale: Number(it.scale) || 0.5,
            zIndex: Number(it.zIndex) || 3,
            flipX: it.flipX === true,
            flipY: it.flipY === true,
            stateKey: String(it.stateKey || ''),
            ...(it.parentAssetId ? { parentAssetId: String(it.parentAssetId), subName: String(it.subName || '') } : {})
          }))
        )
      }
      setRenameState(null)
      await load()
    } catch (e) {
      setRenameErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRenameBusy(false)
    }
  }
  const canPreviz = Boolean(blueprint && (blueprint.nodes || []).length) // D1：预演视图可用性（无幕时预演按钮禁用）

  // 已分析幕集合（与步骤条同源口径：analyzedAt 戳 或 assetIds 非空；蓝图 scene 节点 id 与 plan scenes.sceneId 同为故事节点 id）
  const analyzedSceneIds = useMemo(() => {
    const s = new Set<string>()
    for (const sc of Array.isArray(assetPlan?.scenes) ? (assetPlan!.scenes as any[]) : []) {
      if (String(sc?.analyzedAt || '').trim() || (Array.isArray(sc?.assetIds) && sc.assetIds.length)) s.add(String(sc?.sceneId || ''))
    }
    return s
  }, [assetPlan])

  // B2+ 阶段步骤条派生（readiness 单一来源；事件驱动重算——load/保存/工作区关闭回归均重拉）
  const previzAt = useMemo(() => {
    try {
      // C1：新 key 优先；旧试玩 key 读取兼容一次
      return localStorage.getItem(`bp.previz.${props.projectId}`) || localStorage.getItem(`bp.playtested.${props.projectId}`) || ''
    } catch {
      return ''
    }
    // previzDoneTick 变化时重读（走完结局写入标记后步骤条即时变绿）
  }, [props.projectId, previzDoneTick])

  // D1：中栏视图切换（localStorage 记忆；进预演视图时落定当前幕）
  // G 波：离开预演视图时有脏幕编排先 confirm
  function switchView(v: CanvasView) {
    if (canvasView === 'previz' && v !== 'previz' && !remindPrevizUnsaved('view')) return
    setCanvasView(v)
    try {
      localStorage.setItem(`bp.canvasView.${props.projectId}`, v)
    } catch {}
    if (v === 'previz' && !previzSceneId) {
      const start = nodesAll.find((n) => n.id === String(blueprint?.startNodeId || ''))
      const first = start || sceneNodesAll[0] || nodesAll[0]
      if (first) onPrevizSceneChange(first.id)
    }
  }

  // D1：预演视图当前幕兜底落定——刷新/记忆恢复进预演视图时 previzSceneId 为空，
  // 不补会导致拖动/右栏数值写回静默落空（persist 无 sceneId 直接 return；实测踩坑）
  useEffect(() => {
    if (canvasView !== 'previz' || previzSceneId || !nodesAll.length) return
    const start = nodesAll.find((n) => n.id === String(blueprint?.startNodeId || ''))
    const first = start || sceneNodesAll[0] || nodesAll[0]
    if (!first) return
    setPrevizSceneId(first.id)
    // 2026-11-02 只在无选中时兜底选中首幕——不覆盖并发写入的选中（场景背景卡「编辑元素」回跳选中具体幕）
    setSelection((prev) => (prev.type === 'none' ? { type: 'node', id: first.id } : prev))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasView, previzSceneId, nodesAll, blueprint])

  // D1/G 波：预演切幕——有未保存编排先 confirm（确认=丢弃本幕暂存）；组编辑态退出，选择落场景（右栏显示场景属性）
  function onPrevizSceneChange(nodeId: string) {
    if (nodeId !== previzSceneIdRef.current && !remindPrevizUnsaved('scene')) return
    setPrevizSceneId(nodeId)
    setPrevizGroupEdit(null)
    setPrevizDraftMsg('')
    setSelection({ type: 'node', id: nodeId })
  }

  // D1：走完任一幕结局即记预演完成（原弹窗退出写标记的语义内嵌化）
  function onPrevizDone() {
    try {
      localStorage.setItem(`bp.previz.${props.projectId}`, new Date().toISOString())
    } catch {}
    setPrevizDoneTick((t) => t + 1)
  }

  // ---- G 波（2026-10-26 用户裁决）：编排「脏→保存」语义 ----
  // 全部暂存按幕双键记（sceneId→assetId）；编排改动只置脏不写盘；点顶栏「保存」统一落盘。
  // ref 镜像：pointer 事件回调闭包冻结在 pointerdown 时刻渲染——读最新值必须经 ref（D1 实测踩坑）
  const previzOverridesRef = useRef<Record<string, PrevizLayoutOverrides>>({})
  previzOverridesRef.current = previzOverridesByScene
  const previzBlocksRef = useRef<PrevizBlockInfo[]>([])
  previzBlocksRef.current = previzBlocks
  const previzSceneIdRef = useRef('')
  previzSceneIdRef.current = previzSceneId

  function markPrevizDirty(sceneId: string) {
    if (!sceneId) return
    setPrevizDirtyScenes((prev) => (prev[sceneId] ? prev : { ...prev, [sceneId]: true }))
  }

  function setPrevizOverride(sceneId: string, assetId: string, v: PrevizLayoutValue) {
    setPrevizOverridesByScene((prev) => ({ ...prev, [sceneId]: { ...(prev[sceneId] || {}), [assetId]: v } }))
    markPrevizDirty(sceneId)
  }

  // 朝向/姿态等块属性修改 → merge 进当前幕覆盖 + 置脏（不再自动写盘）
  function patchPrevizBlock(assetId: string, patch: Partial<PrevizLayoutValue>) {
    const sceneId = previzSceneIdRef.current
    if (!sceneId) return
    const blk = previzBlocksRef.current.find((b) => b.assetId === assetId)
    const base: PrevizLayoutValue = blk
      ? { x: blk.x, y: blk.y, scale: blk.scale, flipX: blk.flipX, flipY: blk.flipY, stateKey: blk.stateKey }
      : { x: 0.5, y: 0.9, scale: 0.45 }
    setPrevizOverride(sceneId, assetId, { ...base, ...(previzOverridesRef.current[sceneId]?.[assetId] || {}), ...patch })
  }

  // 保存装配（参数化 sceneId——修切幕竞态：写回函数不读「当前幕」引用；
  // 任意幕可不经渲染派生全量编排——共享 deriveSceneLayout 与渲染同源）
  function collectPrevizItemsFor(sceneId: string) {
    const storyNodes = Array.isArray(project?.story?.nodes) ? (project.story.nodes as any[]) : []
    const sn = storyNodes.find((n) => String(n?.id || '') === sceneId)
    const placements = Array.isArray(sn?.visuals?.placements) ? sn.visuals.placements : []
    const blocks = deriveSceneLayout({
      nodeId: sceneId,
      nodes: nodesAll,
      plan: assetPlan,
      placements,
      subDrafts: previzSubDraftsByScene[sceneId] || {},
      overrides: previzOverridesByScene[sceneId] || {}
    })
    return layoutToCompositionItems(blocks, new Set(Object.keys(previzRemovedSubsByScene[sceneId] || {})))
  }

  async function persistPrevizDraftFor(sceneId: string): Promise<{ dropped: number; droppedSubjectIds: string[] }> {
    const items = collectPrevizItemsFor(sceneId)
    if (!items.length) return { dropped: 0, droppedSubjectIds: [] }
    // 2026-11-09 防静默丢失：服务端如实返回被过滤块（元素已不在计划中等），聚到保存结果里亮明
    const res = await saveSceneCompositionDraft(props.projectId, sceneId, items) as any
    return { dropped: Number(res?.dropped) || 0, droppedSubjectIds: Array.isArray(res?.droppedSubjectIds) ? res.droppedSubjectIds : [] }
  }

  // F 波：组内元素拆分子元素（如背景"森林"拆出 花/草/水）——注册进本幕 subDrafts + 默认位覆盖 + 置脏（G 波：不再立即落盘）
  function addSubElement(parentAssetId: string, subName: string) {
    const name = String(subName || '').trim().slice(0, 32)
    const sceneId = previzSceneIdRef.current
    if (!name || !sceneId) return
    const parent = previzBlocksRef.current.find((b) => b.assetId === parentAssetId)
    if (!parent) return
    const subId = `sub_${parentAssetId}_${name.toLowerCase().replace(/\s+/g, '')}`
    setPrevizSubDraftsByScene((prev) => ({ ...prev, [sceneId]: { ...(prev[sceneId] || {}), [subId]: { parentAssetId, subName: name } } }))
    setPrevizOverride(sceneId, subId, { x: Math.min(1, parent.x + 0.08), y: parent.y, scale: 0.2, flipX: false, flipY: false, stateKey: '' })
    setSubNameInput((prev) => ({ ...prev, [parentAssetId]: '' }))
  }

  // F/G 波：移除子元素——暂存剔除（已落盘的记 removedSubs，保存时整组重写剔除；未落盘的纯本地删），不再立即写盘
  function removeSubElement(subId: string) {
    const sceneId = previzSceneIdRef.current
    if (!sceneId) return
    const persisted = (Array.isArray(assetPlan?.scenes) ? (assetPlan!.scenes as any[]) : [])
      .find((s) => String(s?.sceneId || '') === sceneId)
    const inDraft = Boolean((persisted?.composition?.items || []).some((it: any) => String(it?.subjectId || '') === subId))
    if (inDraft) setPrevizRemovedSubsByScene((prev) => ({ ...prev, [sceneId]: { ...(prev[sceneId] || {}), [subId]: true } }))
    setPrevizSubDraftsByScene((prev) => {
      const next = { ...(prev[sceneId] || {}) }
      delete next[subId]
      return { ...prev, [sceneId]: next }
    })
    setPrevizOverridesByScene((prev) => {
      const next = { ...(prev[sceneId] || {}) }
      delete next[subId]
      return { ...prev, [sceneId]: next }
    })
    markPrevizDirty(sceneId)
  }

  // K 波：AI 提取剧情姿势需求（persist=true 服务端直接写回 plan；LLM 调用=用户点击触发）
  async function runExtractPoseRequirements() {
    if (poseExtractBusy) return
    const hasExisting = (assetPlan?.assets || []).some((asset: any) => Array.isArray(asset?.poseRequirements) && asset.poseRequirements.length > 0)
    if (!(await confirmRerun({ action: '提取剧情姿势需求', hasExisting }))) return
    setPoseExtractBusy(true)
    poseReqOps.setErr('')
    try {
      const res = await extractStoryPoseStatesAi(props.projectId, { persist: true })
      poseReqOps.flashNote(`已提取并写回姿态需求清单${res?.persisted ? '' : '（未落盘，见日志）'}`, 3000)
      await load()
    } catch (e) {
      poseReqOps.setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setPoseExtractBusy(false)
    }
  }

  // M 波：AI 补齐中文名（LLM 产映射，确定性双修 plan+圣经；完成 toast 汇总改名明细）
  async function runNormalizeNames() {
    if (normalizeNamesBusy) return
    setNormalizeNamesBusy(true)
    poseReqOps.setErr('')
    try {
      const res = await normalizeAssetNamesAi(props.projectId)
      const changed = Array.isArray(res?.changed) ? res.changed : []
      const skipped = Array.isArray(res?.skipped) ? res.skipped : []
      poseReqOps.flashNote(
        changed.length
          ? `已改 ${changed.length} 个：${changed.map((x) => `${x.from}→${x.to}`).join('、')}${skipped.length ? `；跳过 ${skipped.length} 个（非中文输出）` : ''}`
          : '全部已是中文名，无需改动',
        4000
      )
      await load()
    } catch (e) {
      poseReqOps.setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setNormalizeNamesBusy(false)
    }
  }

  // M 波：AI 补齐多态需求——串行跑角色姿势+道具状态（资源互斥串行纪律；逐项任务台账进度）
  async function runFillStates() {
    if (fillStatesBusy) return
    const hasExisting = (assetPlan?.assets || []).some((asset: any) => asset?.poseRequirements?.length || asset?.stateRequirements?.length)
    if (!(await confirmRerun({ action: '补齐多态需求', hasExisting }))) return
    analyzeQueueCancelRef.current = false
    setFillStatesBusy(true)
    poseReqOps.setErr('')
    try {
      const r1 = await extractStoryPoseStatesAi(props.projectId, { persist: true })
      if (analyzeQueueCancelRef.current) return
      const r2 = await extractStoryPropStatesAi(props.projectId, { persist: true })
      poseReqOps.flashNote(`多态需求已补齐：角色姿势${r1?.persisted ? '已写回' : '未落盘'} · 道具状态${r2?.persisted ? '已写回' : '未落盘'}（要素库子级黄点即新需求）`, 4000)
      await load()
    } catch (e) {
      poseReqOps.setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setFillStatesBusy(false)
    }
  }

  // G 波：离开守卫两级——
  // 切幕/切视图=提醒语义（暂存不丢，多幕编排可累积后统一保存；confirm 起"知晓未保存"作用，取消则留下）
  function remindPrevizUnsaved(kind: 'scene' | 'view'): boolean {
    if (!Object.keys(previzDirtyScenes).length) return true
    return window.confirm(
      kind === 'scene'
        ? '本幕编排未保存（切换幕不丢失，但记得点顶栏「保存」落盘）。继续切换？'
        : '有编排未保存（切换视图不丢失，记得点顶栏「保存」落盘）。继续？'
    )
  }
  // 离开蓝图层=真丢弃（组件卸载暂存即失）——confirm 文案如实，确认后清暂存
  function confirmPrevizLeaveStage(): boolean {
    const dirty = Object.keys(previzDirtyScenes)
    if (!dirty.length) return true
    if (!window.confirm('有场景的编排未保存，离开蓝图层将丢失，确定离开？')) return false
    setPrevizDirtyScenes({})
    setPrevizOverridesByScene({})
    setPrevizSubDraftsByScene({})
    setPrevizRemovedSubsByScene({})
    return true
  }

  // G 波：当前幕暂存切片——空态必须用稳定引用（`|| {}` 每渲染新对象 → PrevizPlayer blocks 重算 → onBlocksChange 上报
  // → 父级 setState → 重渲 → 新引用…… 实测 Maximum update depth 死循环空转）
  const EMPTY_OVERRIDES: PrevizLayoutOverrides = useMemo(() => ({}), [])
  const EMPTY_SUBS: Record<string, { parentAssetId: string; subName: string }> = useMemo(() => ({}), [])
  const curSceneOverrides = useMemo(
    () => previzOverridesByScene[previzSceneId] || EMPTY_OVERRIDES,
    [previzOverridesByScene, previzSceneId, EMPTY_OVERRIDES]
  )
  const curSceneSubDrafts = useMemo(
    () => previzSubDraftsByScene[previzSceneId] || EMPTY_SUBS,
    [previzSubDraftsByScene, previzSceneId, EMPTY_SUBS]
  )

  // ---- D1/E/F/G 波：预演右栏共享辅助（元素属性面板 + 组管理面板同源） ----
  const previzCurOf = (b: PrevizBlockInfo): Required<PrevizLayoutValue> => ({
    // 现状=快照打底 + 当前幕覆盖叠加（双键：sceneId→assetId；两段 spread 拆写：覆盖优先是设计语义）
    ...{ x: b.x, y: b.y, scale: b.scale, flipX: b.flipX === true, flipY: b.flipY === true, stateKey: String(b.stateKey || ''), imageAssetId: String((b as any).imageAssetId || '') },
    ...((previzOverridesByScene[previzSceneId] || {})[b.assetId] || {})
  })
  const previzDepthOf = (y: number) => (y >= 0.667 ? '近' : y >= 0.334 ? '中' : '远')
  const previzVariantsOf = (assetId: string): Array<{ key: string; label: string }> => {
    const a = (Array.isArray(assetPlan?.assets) ? (assetPlan!.assets as any[]) : []).find((x) => String(x?.id || '') === assetId)
    const out: Array<{ key: string; label: string }> = []
    for (const v of Array.isArray(a?.poseVariants) ? a.poseVariants : []) {
      const k = String(v?.stateKey || '').trim()
      if (k) out.push({ key: k, label: String(v?.name || k) })
    }
    for (const v of Array.isArray(a?.stateVariants) ? a.stateVariants : []) {
      const k = String(v?.stateKey || '').trim()
      if (k) out.push({ key: k, label: String(v?.name || k) })
    }
    return out
  }
  const previzNumMini = (b: PrevizBlockInfo, key: 'x' | 'y' | 'scale', hint: string) => {
    const cur = previzCurOf(b)
    return (
      <input
        className="input"
        type="number"
        min={key === 'scale' ? 0.05 : 0}
        max={1}
        step={0.01}
        value={Math.round(cur[key] * 100) / 100}
        disabled={busy}
        title={hint}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (!Number.isFinite(v)) return
          // G 波：数值改动进暂存置脏（不再失焦写盘；点顶栏保存统一落盘）
          patchPrevizBlock(b.assetId, { [key]: Math.max(0, Math.min(1, v)) })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
    )
  }
  const previzFlipBtns = (b: PrevizBlockInfo) => {
    const cur = previzCurOf(b)
    return (
      <span style={{ display: 'inline-flex', gap: 4 }}>
        <button
          type="button"
          className={`bp-flip-btn${cur.flipX ? ' is-on' : ''}`}
          title="左右翻转（flipX，与合成层同语义）"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation()
            patchPrevizBlock(b.assetId, { flipX: !cur.flipX })
          }}
        >
          ⇋
        </button>
        <button
          type="button"
          className={`bp-flip-btn${cur.flipY ? ' is-on' : ''}`}
          title="上下翻转（flipY）"
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation()
            patchPrevizBlock(b.assetId, { flipY: !cur.flipY })
          }}
        >
          ⇕
        </button>
      </span>
    )
  }
  // K 波（2026-10-27 用户裁决：姿态需求定义前移蓝图）：姿态区=需求定义器——
  // 可选项=该元素姿态需求清单（plan poseRequirements 按 stateKey）+已有变体（poseVariants 有 stateKey 的）；
  // 三态徽标：需求未定义（灰）/已定义未出图（黄）/已有锁定变体（绿）；选择即写编排草稿 stateKey（G 波置脏语义）。
  const previzPoseStateOf = (assetId: string): { tone: 'none' | 'defined' | 'locked'; label: string } => {
    const a = (Array.isArray(assetPlan?.assets) ? (assetPlan!.assets as any[]) : []).find((x) => String(x?.id || '') === assetId)
    const reqs = Array.isArray(a?.poseRequirements) ? a.poseRequirements : []
    const variants = Array.isArray(a?.poseVariants) ? a.poseVariants : []
    const hasLockedVariant = variants.some((v: any) => String(v?.projectAssetId || v?.projectAssetUri || '').trim())
    if (hasLockedVariant) return { tone: 'locked', label: '已有锁定变体' }
    if (reqs.length) return { tone: 'defined', label: `已定义 ${reqs.length} 条需求（未出图）` }
    return { tone: 'none', label: '未定义姿态需求' }
  }
  const previzPoseSelect = (b: PrevizBlockInfo) => {
    if (b.parentAssetId) return null // 子元素无姿态（非计划资产）
    const a = (Array.isArray(assetPlan?.assets) ? (assetPlan!.assets as any[]) : []).find((x) => String(x?.id || '') === b.assetId)
    const reqs: any[] = Array.isArray(a?.poseRequirements) ? a.poseRequirements : []
    const variants = previzVariantsOf(b.assetId)
    const st = previzPoseStateOf(b.assetId)
    const cur = previzCurOf(b)
    const toneCls = st.tone === 'locked' ? 'is-ok' : st.tone === 'defined' ? 'is-stale' : ''
    return (
      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className={`bp-prompt-badge ${toneCls}`} style={{ marginLeft: 0 }}>{st.label}</span>
        {reqs.length || variants.length ? (
          <select
            className="sel"
            style={{ padding: '3px 8px', fontSize: 12, maxWidth: 150 }}
            value={cur.stateKey}
            disabled={busy}
            title="姿态/状态（需求清单+锁定链变体；选择写本幕构图草稿 stateKey，点保存落盘）"
            onChange={(e) => patchPrevizBlock(b.assetId, { stateKey: e.target.value })}
          >
            <option value="">默认</option>
            {reqs.map((r) => {
              const k = String(r?.stateKey || r?.reqId || '').trim()
              if (!k) return null
              return (
                <option key={`req_${k}`} value={k}>
                  {String(r?.label || k)}（需求）
                </option>
              )
            })}
            {variants.map((v) => (
              <option key={`var_${v.key}`} value={v.key}>
                {v.label}（变体）
              </option>
            ))}
          </select>
        ) : null}
      </span>
    )
  }

  // 2026-11-01 预演占位预览图候选：主参考 + 已锁定姿势/状态变体（锁定优先排前，显式选择写编排草稿 imageAssetId）
  const previzImageCandidatesOf = (assetId: string) => {
    const a = (Array.isArray(assetPlan?.assets) ? (assetPlan!.assets as any[]) : []).find((x) => String(x?.id || '') === assetId)
    if (!a) return [] as Array<{ key: string; label: string; imageAssetId: string; stateKey: string; uri: string; score: number | null }>
    const out: Array<{ key: string; label: string; imageAssetId: string; stateKey: string; uri: string; score: number | null }> = []
    const primaryId = String(a?.primaryReferenceAssetId || '').trim()
    const primaryUri = String(a?.primaryReferenceAssetUri || '').trim()
    if (primaryUri) out.push({ key: 'primary', label: '主参考', imageAssetId: primaryId, stateKey: '', uri: primaryUri, score: null })
    for (const v of [...(Array.isArray(a?.poseVariants) ? a.poseVariants : []), ...(Array.isArray(a?.stateVariants) ? a.stateVariants : [])]) {
      const uri = String(v?.projectAssetUri || v?.cutoutPath || '').trim()
      const vid = String(v?.projectAssetId || '').trim()
      if (!uri || !vid) continue
      out.push({
        key: `var_${vid}`,
        label: String(v?.name || vid),
        imageAssetId: vid,
        stateKey: String(v?.stateKey || '').trim(),
        uri,
        score: Number.isFinite(Number(v?.score)) ? Math.round(Number(v.score)) : null
      })
    }
    return out
  }

  // 2026-11-01 预演「管理」：带 场景+元素(+当前姿态需求) 深度回跳锁定出图执行台（合成层消费 poseFocus 载荷）。
  // 复用 gotoLockWorkspace 的导航语义（openProject/returnStage），未保存编排先确认（confirmPrevizLeaveStage 同语义）。
  const gotoLockPoseManage = (blk: PrevizBlockInfo) => {
    if (!confirmPrevizLeaveStage()) return
    const a = (Array.isArray(assetPlan?.assets) ? (assetPlan!.assets as any[]) : []).find((x) => String(x?.id || '') === blk.assetId)
    const reqs = Array.isArray(a?.poseRequirements) ? a.poseRequirements : []
    const cur = previzCurOf(blk)
    const reqHit = reqs.find((r: any) => String(r?.stateKey || '') === String(cur.stateKey || '')) || reqs[0] || null
    try {
      localStorage.setItem('talkscene.lockWorkspace.poseFocus', JSON.stringify({
        projectId: props.projectId,
        assetId: blk.assetId,
        sceneId: previzSceneIdRef.current,
        reqId: String(reqHit?.reqId || '')
      }))
    } catch { /* 存储不可用时忽略 */ }
    gotoLockWorkspace()
  }

  // F 波：组管理面板（只列本组元素——E 波"背景组列全部元素"的错误理解已纠正；子元素缩进列父行下，组编辑中可拆分）
  function renderPrevizGroupPanel(scope: '背景' | '角色' | '道具', nodeId: string, anchor?: PrevizBlockInfo) {
    const ownerNode = nodesAll.find((n) => n.id === nodeId)
    const mainBg = scope === '背景' ? previzBlocks.find((b) => b.group === '背景') : null
    const inGroup = previzBlocks.filter((b) => previzGroupScopeOf(b.group) === scope)
    const parents = inGroup.filter((b) => !b.parentAssetId)
    const subsOf = (pid: string) => inGroup.filter((b) => b.parentAssetId === pid)
    const groupEditing = previzGroupEdit === scope
    const renderRow = (b: PrevizBlockInfo, isSub: boolean) => (
      <div
        key={b.assetId}
        className={`bp-group-row${isSub ? ' is-sub-row' : ''}${selection.type === 'previzElement' && selection.assetId === b.assetId ? ' is-active' : ''}`}
        onClick={() => setSelection({ type: 'previzElement', nodeId, assetId: b.assetId })}
        title="点击选中该元素（预演块联动高亮）"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {isSub ? '└ ' : ''}
            {b.name}
          </span>
          <span className="hint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            {isSub ? '子元素' : b.group}
            {!isSub && b.group !== '背景' ? ` · ${previzDepthOf(previzCurOf(b).y)}` : ''}
            {b.unready ? ' · 未锁定' : ''}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'flex-end' }}>
          {previzFlipBtns(b)}
          <button
            type="button"
            className="bp-flip-btn"
            style={{ color: '#fca5a5' }}
            title={isSub ? '移除该子元素（需求单草稿剔除）' : '从本幕移除（写回资产计划）'}
            disabled={busy || assignBusy}
            onClick={(e) => {
              e.stopPropagation()
              if (isSub) void removeSubElement(b.assetId)
              else void removeElementFromScene(nodeId, b.assetId)
            }}
          >
            移
          </button>
        </div>
        {b.group !== '背景' || isSub ? (
          <div className="bp-group-row-nums" onClick={(e) => e.stopPropagation()}>
            {previzNumMini(b, 'x', '横向位置（0=左缘，1=右缘）')}
            {previzNumMini(b, 'y', '纵向位置（0=顶，1=底）')}
            {previzNumMini(b, 'scale', '大小（≈画框宽比例）')}
            <span style={{ minWidth: 64 }}>{previzPoseSelect(b)}</span>
          </div>
        ) : null}
        {/* F 波：组编辑中非子元素行可拆分子元素（一个大元素分多个小元素组合） */}
        {groupEditing && !isSub ? (
          <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
            <input
              className="input"
              style={{ flex: 1, padding: '2px 8px', fontSize: 12 }}
              placeholder="拆分子元素名（如 花 / 草 / 水）"
              value={subNameInput[b.assetId] || ''}
              disabled={busy}
              onChange={(e) => setSubNameInput((prev) => ({ ...prev, [b.assetId]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addSubElement(b.assetId, subNameInput[b.assetId] || '')
              }}
            />
            <button
              type="button"
              className="bp-flip-btn"
              disabled={busy || !(subNameInput[b.assetId] || '').trim()}
              title="拆出子元素块（随父组色系更小一块；可拖动/吸附九宫格；写回需求单草稿）"
              onClick={() => addSubElement(b.assetId, subNameInput[b.assetId] || '')}
            >
              拆
            </button>
          </div>
        ) : null}
      </div>
    )
    return (
      <>
        <button
          type="button"
          className="btn secondary"
          style={{ padding: '3px 10px', fontSize: 12, justifySelf: 'start' }}
          onClick={() => {
            setPrevizGroupEdit(null)
            setSelection({ type: 'node', id: nodeId })
          }}
        >
          ← 返回场景属性
        </button>
        <div style={{ fontWeight: 800 }}>
          {scope}组 · {scope === '背景' ? mainBg?.name || anchor?.name || '主背景' : ownerNode ? nodeTitleForUI(ownerNode, scriptCards) : nodeId}
        </div>
        <div style={{ fontSize: 12, opacity: 0.8, marginTop: -6 }}>
          {groupEditing ? `${scope}组编辑中：仅本组元素可动，右下角手柄调大小，松手吸附九宫格；双击本组元素或空白退出` : '双击画框中本组元素进入组编辑（九宫格吸附）'}
        </div>
        {scope === '背景' && mainBg ? (
          <div className="form-row">
            <label>主背景朝向 / 姿态</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {previzFlipBtns(mainBg)}
              {previzPoseSelect(mainBg)}
            </div>
          </div>
        ) : null}
        <div className="hr" />
        <div className="form-row">
          <label>
            {scope}组元素（{inGroup.length}）
          </label>
          {inGroup.length ? (
            <div style={{ display: 'grid', gap: 6 }}>
              {parents.map((b) => [renderRow(b, false), ...subsOf(b.assetId).map((s) => renderRow(s, true))])}
            </div>
          ) : (
            <div className="hint">本幕无{scope}组元素。</div>
          )}
        </div>
      </>
    )
  }

  // A 波：预演文本区点击 → 回场景属性并聚焦文本草稿编辑框
  useEffect(() => {
    if (!textDraftFocusTick) return
    const ta = textDraftRef.current
    if (!ta) return
    ta.scrollIntoView({ block: 'center', behavior: 'smooth' })
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
  }, [textDraftFocusTick])

  function focusSceneTextDraft(nodeId: string) {
    setSelection({ type: 'node', id: nodeId })
    setTextDraftFocusTick((t) => t + 1)
  }

  // B 波：生成当前幕配音（真实合成；进度明面 busy + 结果行；生成后 load 重拉 plan → 状态行/步骤条配音计数刷新）
  async function runGenerateVoice(nodeId: string) {
    if (voiceBusy) return
    // 2026-11-03 用户裁决：已有配音时先二次确认（防误点覆盖）
    const rec = (assetPlan as any)?.sceneVoices?.[nodeId]
    const ran = await confirmRerun({ action: '生成配音', hasExisting: Boolean(rec?.audioAssetUri), run: async () => {
      setVoiceBusy(true)
      setVoiceErr('')
      setVoiceNote('')
      try {
        const picked = voiceId || voiceGroups[0]?.items[0]?.id || ''
        await generateSceneVoice(props.projectId, nodeId, { voiceId: picked, speed: voiceSpeed })
        await load()
        // load 后状态行已由 plan.sceneVoices 记录承接——清掉即时反馈防双显；load 会清选中（防脏既有语义）故留在本幕属性
        setVoiceNote('')
        setSelection({ type: 'node', id: nodeId })
      } catch (e) {
        setVoiceErr(e instanceof Error ? e.message : String(e))
      } finally {
        setVoiceBusy(false)
      }
    } })
    void ran
  }

  function voiceLabelOf(id: string) {
    for (const g of voiceGroups) for (const it of g.items) if (it.id === id) return it.label
    return id || '默认音色'
  }

  // B 波：试听（同源资产地址；同名覆盖后带时间戳防缓存）
  function playSceneVoice(nodeId: string) {
    const rec = (assetPlan as any)?.sceneVoices?.[nodeId]
    const uri = String(rec?.audioAssetUri || '').trim()
    if (!uri) return
    const url = `http://localhost:1999/project-assets/${encodeURIComponent(props.projectId)}/${uri.replace(/^\/+/, '')}?t=${encodeURIComponent(String(rec?.generatedAt || ''))}`
    void new Audio(url).play().catch(() => setVoiceErr('试听播放失败（浏览器拦截或文件缺失）'))
  }
  const stageSteps = useMemo(() => {
    return computeStageSteps({ problems, plan: assetPlan, previzAt, ttsEnabled, sceneIds: canvasNodes.map((n) => n.id) })
  }, [problems, assetPlan, previzAt, ttsEnabled, canvasNodes])

  function onStepAction(key: string) {
    // D1：占位预演步动作=切到中栏预演视图（不再开弹窗）
    if (key === 'previz') {
      switchView('previz')
      return
    }
    if (key === 'lock') {
      gotoLockWorkspace()
      return
    }
    if (key === 'analyze') {
      // 聚焦左栏要素库（闪烁提示一次）
      setStepNote('左栏为要素库：全部元素与准备状态在此聚合')
      window.setTimeout(() => setStepNote(''), 2500)
      return
    }
    if (key === 'voice') {
      setStepNote('配音能力随 B3 波落地')
      window.setTimeout(() => setStepNote(''), 2500)
      return
    }
    // structure：状态展示步，无动作
  }

  // B2 锁定事物前移：经 localStorage handoff 进合成层并自动打开锁定工作区
  //（ComposeStudio 已有 talkscene.lockWorkspace.openProject 恢复机制；工作区无资产定位参数——缺口点击只打开向导）
  function gotoLockWorkspace() {
    try {
      localStorage.setItem('talkscene.lockWorkspace.openProject', props.projectId)
      localStorage.setItem('talkscene.lockWorkspace.returnStage', 'blueprint')
    } catch {}
    void next()
  }

  // B2+ AI 场景分析：逐场景提取所需元素，写回 plan.json（同源），前端重拉即时刷新徽标/要素库/步骤条
  // 明面执行（2026-10-21 用户指令）：执行中/成功后都必须明面可见——busy 提示 + 成功元素清单内联展示
  const [analyzeElements, setAnalyzeElements] = useState<Array<{ name?: string; category?: string }> | null>(null)
  // 要素分配（2026-10-25 用户指令：右栏分配激活，plan 同源写回场景 assetIds）
  const [assignPicks, setAssignPicks] = useState<Record<string, string>>({})
  const [assignBusy, setAssignBusy] = useState(false)

  // 从本幕移除元素（2026-10-25 用户指令：占位元素可删——合成的编辑能力同步到蓝图；写回计划同源）
  // G 波口径：assign 是计划资产分配（真相源）保持即时写；编排草稿项随保存语义——assign 后该元素已不在幕清单，
  // 派生不再出块，本幕置脏，点保存时整组重写自然剔除草稿孤儿项
  async function removeElementFromScene(nodeId: string, assetId: string) {
    if (assignBusy) return
    setAssignBusy(true)
    setAnalyzeErr('')
    try {
      const res = await assignPlanSceneAsset(props.projectId, nodeId, assetId, 'remove')
      if (!res?.success) throw new Error(res?.message || '移除失败')
      setPrevizOverridesByScene((prev) => {
        const next = { ...(prev[nodeId] || {}) }
        delete next[assetId]
        return { ...prev, [nodeId]: next }
      })
      markPrevizDirty(nodeId)
      await load()
      setSelection({ type: 'node', id: nodeId })
    } catch (e) {
      setAnalyzeErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAssignBusy(false)
    }
  }

  // 预演视图 Delete/Backspace 移除选中块（输入框聚焦时不抢键）
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (selection.type !== 'previzElement') return
      e.preventDefault()
      void removeElementFromScene(selection.nodeId, selection.assetId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection])

  async function assignElement(nodeId: string, assetId: string, action: 'add' | 'remove') {
    if (assignBusy) return
    setAssignBusy(true)
    setAnalyzeErr('')
    try {
      const res = await assignPlanSceneAsset(props.projectId, nodeId, assetId, action)
      if (!res?.success) throw new Error(res?.message || '分配失败')
      setAssignPicks((prev) => ({ ...prev, background: '', character: '', prop: '' }))
      await load()
    } catch (e) {
      setAnalyzeErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAssignBusy(false)
    }
  }

  async function runAnalyzeScene(nodeId: string) {
    if (analyzeBusy) return
    // 2026-11-03 用户裁决：已分析幕再次分析前二次确认（防误点覆盖）
    const ran = await confirmRerun({ action: '场景元素分析', hasExisting: analyzedSceneIds.has(nodeId), run: async () => {
      setAnalyzeBusy(true)
      setAnalyzeErr('')
      setAnalyzeNote('')
      setAnalyzeElements(null)
      try {
        const res = await analyzeSceneElements(props.projectId, nodeId)
        const added = Number(res?.added ?? 0)
        const updated = Number(res?.updated ?? 0)
        const total = Number(res?.sceneElements ?? 0)
        const els = Array.isArray(res?.elements) ? res.elements : []
        setAnalyzeElements(els)
        setAnalyzeNote(`分析完成：本幕 ${total} 个元素（新增 ${added} · 更新 ${updated}），已写回资产计划`)
        await load()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // 租约/守护台阻断给引导语义，其余原样
        setAnalyzeErr(
          /resource_scheduler_unreachable/.test(msg)
            ? `守护台离线且资源租约已启用：请启动守护台，或到 设置 → 守护台关联 关闭后重试。(${msg})`
            : msg
        )
      } finally {
        setAnalyzeBusy(false)
      }
    } })
    void ran
  }

  // 分析全部场景（2026-10-25 加项）：未分析幕串行逐幕调分析端点（禁止并发——本地模型串行纪律）；
  // 进度明面（按钮计数 + 每幕重拉后步骤条递增 + 服务端任务台账每幕一条）；任一失败即停给原因（已分析幕保留，修复后可继续）；
  // 已分析幕幂等跳过；全部完成显示 N/N。
  async function runAnalyzeAll() {
    if (analyzeAllBusy || analyzeBusy) return
    // 2026-11-03 用户裁决：已有分析结果时先二次确认（防误点批量重跑）
    const pending = canvasNodes.filter((n) => !analyzedSceneIds.has(n.id))
    const ran = await confirmRerun({ action: '分析全部场景', hasExisting: analyzedSceneIds.size > 0, run: async () => {
      setAnalyzeAllErr('')
      setAnalyzeAllNote('')
      if (!pending.length) {
        setAnalyzeAllNote('全部场景均已分析过（幂等跳过）')
        return
      }
      analyzeQueueCancelRef.current = false
      setAnalyzeAllBusy(true)
      const total = pending.length
      setAnalyzeAllProgress({ done: 0, total })
      try {
        for (let i = 0; i < pending.length; i++) {
          if (analyzeQueueCancelRef.current) {
            setAnalyzeAllNote(`已停止：完成 ${i}/${total} 幕，已完成结果保留`)
            break
          }
          const n = pending[i]
          try {
            await analyzeSceneElements(props.projectId, n.id)
          } catch (e) {
            if (analyzeQueueCancelRef.current) {
              setAnalyzeAllNote(`已停止：完成 ${i}/${total} 幕，已完成结果保留`)
              return
            }
            const raw = e instanceof Error ? e.message : String(e)
            const msg = /resource_scheduler_unreachable/.test(raw)
              ? `守护台离线且资源租约已启用：请启动守护台，或到 设置 → 守护台关联 关闭后重试。(${raw})`
              : raw
            setAnalyzeAllErr(`第 ${i + 1} 幕「${nodeTitleForUI(n, scriptCards)}」分析失败：${msg}（已分析幕保留，可修复后继续）`)
            return
          }
          setAnalyzeAllProgress({ done: i + 1, total })
          await load() // 每幕写回后重拉：步骤条计数逐幕递增 + 要素库即时刷新
        }
        if (!analyzeQueueCancelRef.current) setAnalyzeAllNote(`全部分析完成 ${total}/${total}`)
      } finally {
        setAnalyzeAllBusy(false)
      }
    } })
    void ran
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="left">
          <div className="title">第二层 · 蓝图</div>
          <button className="btn secondary" onClick={() => guardedBack()} disabled={busy}>
            上一步：脚本
          </button>
        </div>
        <div className="right">
          {problems.length ? (
            <div className="hint" style={{ color: '#fca5a5' }}>校验：{problems.length} 个问题</div>
          ) : (
            <div className="hint">校验：通过</div>
          )}
          {dirty || Object.keys(previzDirtyScenes).length ? <div className="hint" style={{ color: '#fde68a' }}>未保存</div> : <div className="hint">已保存</div>}
          {/* G 波：保存语义翻转（编排不再自动写盘）——「已自动保存」撤销，仅点保存成功后亮「已保存·刚刚」 */}
          {savedTick ? <div className="hint" style={{ color: '#86efac' }}>已保存 · 刚刚</div> : null}
          {/* D1：顶栏「占位预演」按钮撤除——预演已内嵌中栏第三视图（视图切换/步骤条动作进入） */}
          <button className="btn secondary" onClick={() => guardedGotoLockWorkspace()} disabled={busy || !blueprint} title="进入合成层并打开锁定事物工作区（元素锁定/参考图）">
            锁定事物
          </button>
          {/* B1 准备度摘要条（四段固定序；进入合成前的如实呈现，不阻断） */}
          <span className="bp-readiness" title="准备度摘要（结构/元素/配音/图）">
            {readiness.text}
          </span>
          <button className="btn" onClick={() => void save()} disabled={busy || !blueprint || (!dirty && !Object.keys(previzDirtyScenes).length)} title="保存蓝图文档与全部待写幕的编排草稿">
            保存
          </button>
          <button className="btn secondary" onClick={() => guardedNext()} disabled={busy || !blueprint}>
            下一步：进入合成
          </button>
        </div>
      </div>

      <div className="main">
        <div className="panel">
          <div className="section">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{ fontWeight: 800, flex: 1 }}>要素库</div>
              <button
                className="btn secondary"
                type="button"
                style={{ padding: '3px 10px', fontSize: 12 }}
                disabled={busy || analyzeBusy || analyzeAllBusy || promptReady === false || !sceneNodesAll.length}
                title={
                  promptReady === false
                    ? '请先在 设置 → 提示词生成 启用并选择 Provider/Model'
                    : '对未分析的场景逐幕串行分析并写回资产计划（本地模型串行纪律；已分析幕自动跳过）'
                }
                onClick={() => void runAnalyzeAll()}
              >
                {analyzeAllBusy && analyzeAllProgress ? `分析中 第 ${analyzeAllProgress.done + 1}/共 ${analyzeAllProgress.total} 幕` : '分析全部场景'}
              </button>
              {analyzeAllBusy ? (
                <button className="btn secondary" type="button" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => {
                  analyzeQueueCancelRef.current = true
                  void stopActiveAiTasks(props.projectId).catch(() => {})
                }}>停止分析</button>
              ) : null}
              {/* K 波（2026-10-27 用户裁决：姿态需求定义期前移蓝图）：AI 提取剧情姿势需求入口前移至此
                  （锁定向导姿势区的定义期按钮退役）；persist=true 服务端提取后直接写回 plan poseRequirements */}
              <button
                className="btn secondary"
                type="button"
                style={{ padding: '3px 10px', fontSize: 12 }}
                disabled={busy || analyzeBusy || analyzeAllBusy || poseExtractBusy || promptReady === false || !assetPlan}
                title={
                  promptReady === false
                    ? '请先在 设置 → 提示词生成 启用并选择 Provider/Model'
                    : !assetPlan
                      ? '请先生成资产计划'
                      : 'AI 从剧情文本提取各角色的姿态需求清单（吹气/倒地/奔跑…），写回计划供蓝图姿态选择器与锁定期按单生成'
                }
                onClick={() => void runExtractPoseRequirements()}
              >
                {poseExtractBusy ? '提取中…' : '提取剧情姿势需求'}
              </button>
              {/* M 波（2026-10-27）：AI 补齐中文名 / 补齐多态需求（用户触发；生成类挂 aiTask，进度见右下「任务」） */}
              <button
                className="btn secondary"
                type="button"
                style={{ padding: '3px 10px', fontSize: 12 }}
                disabled={busy || analyzeBusy || analyzeAllBusy || normalizeNamesBusy || promptReady === false || !assetPlan}
                title={
                  promptReady === false
                    ? '请先在 设置 → 提示词生成 启用并选择 Provider/Model'
                    : !assetPlan
                      ? '请先生成资产计划'
                      : 'AI 把英文/非中文元素名整理成贴故事的中文名（计划资产与圣经实体名双修；已中文的跳过）'
                }
                onClick={() => void runNormalizeNames()}
              >
                {normalizeNamesBusy ? '补齐中…' : 'AI 补齐中文名'}
              </button>
              <button
                className="btn secondary"
                type="button"
                style={{ padding: '3px 10px', fontSize: 12 }}
                disabled={busy || analyzeBusy || analyzeAllBusy || fillStatesBusy || promptReady === false || !assetPlan}
                title={
                  promptReady === false
                    ? '请先在 设置 → 提示词生成 启用并选择 Provider/Model'
                    : !assetPlan
                      ? '请先生成资产计划'
                      : 'AI 从剧情提取角色姿态需求+道具状态需求并写回计划（串行，资源互斥）；要素库子级黄点即新需求'
                }
                onClick={() => void runFillStates()}
              >
                {fillStatesBusy ? '补齐中…' : 'AI 补齐多态需求'}
              </button>
            </div>
            {analyzeAllNote ? <div className="hint" style={{ color: '#86efac', marginBottom: 8 }}>{analyzeAllNote}</div> : null}
            {analyzeAllErr ? <div className="hint" style={{ color: '#fca5a5', marginBottom: 8 }}>{analyzeAllErr}</div> : null}
            {poseReqOps.note ? <div className="hint" style={{ color: '#86efac', marginBottom: 8 }}>{poseReqOps.note}</div> : null}
            {poseReqOps.err ? <div className="hint" style={{ color: '#fca5a5', marginBottom: 8 }}>{poseReqOps.err}</div> : null}
            {!assetPlan ? (
              <div className="hint" style={{ marginBottom: 8 }}>点场景卡或右栏的「AI 分析」逐幕提取元素；提取后这里自动列出（背景/角色/道具）并带阶段状态。</div>
            ) : null}

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
                      {/* B1：计数 = plan 元素 + 手工占位（徽标同源 plan，手工为既有数据模型）；B2+：附阶段计数摘要（如「锁定 3/4」） */}
                      <span style={{ opacity: 0.7, fontWeight: 700 }}>({(((placeholdersByKind as any)[kind] || []).length || 0) + (planElementsByGroup[kind] || []).length})</span>
                      {(() => {
                        const list = planElementsByGroup[kind] || []
                        if (!list.length) return null
                        const doneCount = list.filter((a) => a.state !== 'marked').length
                        return (
                          <span className="hint" style={{ fontSize: 12 }}>
                            就绪 {doneCount}/{list.length}
                          </span>
                        )
                      })()}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button
                        className="icon-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          setAddElementForm({ kind, name: '' })
                          setElementsOpen((prev) => ({ ...prev, [kind]: true }))
                        }}
                        disabled={busy || !blueprint}
                        title="新增（加入资产计划）"
                        aria-label="新增"
                      >
                        <PlusIcon />
                      </button>
                    </div>
                  </div>
                  {elementsOpen[kind] ? (
                    <div className="subfold-body">
                      {/* 2026-10-26 新增元素内联表单（组顶部，确认/取消全程可见可达） */}
                      {addElementForm?.kind === kind ? (
                        <div className="bp-add-form">
                          <input
                            className="input"
                            autoFocus
                            placeholder={`新${elementKindLabel(kind).replace('要素', '')}名称`}
                            value={addElementForm.name}
                            onChange={(e) => setAddElementForm((f) => (f ? { ...f, name: e.target.value } : f))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void addPlanElement()
                              if (e.key === 'Escape') setAddElementForm(null)
                            }}
                          />
                          <button className="btn secondary" type="button" disabled={addElementBusy || !addElementForm.name.trim()} onClick={() => void addPlanElement()}>
                            {addElementBusy ? '新增中…' : '确认'}
                          </button>
                          <button className="icon-btn" type="button" onClick={() => setAddElementForm(null)} aria-label="取消">
                            ✕
                          </button>
                        </div>
                      ) : null}
                      {/* B1：plan 同源元素行；L 波：多级管理（展开子级=姿态/状态变体·背景环境子元素）+ 行内改名（铅笔） */}
                      {(planElementsByGroup[kind] || []).length ? (
                        <div className="bp-element-list">
                          {(planElementsByGroup[kind] || []).map((a) => {
                            const children = elementChildrenById.get(a.id) || []
                            const open = Boolean(elementOpen[a.id])
                            const renaming = renameState?.assetId === a.id
                            return (
                              <div key={a.id} className="bp-element-block">
                                <div className="bp-element-row is-clickable" title={`${a.name} · ${a.stageTitle} · 点击去锁定`} onClick={() => gotoLockWorkspace()}>
                                  {children.length ? (
                                    <span
                                      className="bp-element-caret"
                                      role="button"
                                      aria-label={`${open ? '收起' : '展开'}子级`}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setElementOpen((prev) => ({ ...prev, [a.id]: !open }))
                                      }}
                                    >
                                      {open ? '▾' : '▸'}
                                    </span>
                                  ) : (
                                    <span className="bp-element-caret is-empty" />
                                  )}
                                  <span className={`bp-mark-dot s-${a.state}`} />
                                  {renaming ? (
                                    <input
                                      className="input"
                                      style={{ flex: 1, padding: '2px 6px', fontSize: 12.5 }}
                                      autoFocus
                                      value={renameState.value}
                                      disabled={renameBusy}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => setRenameState({ assetId: a.id, value: e.target.value })}
                                      onBlur={(e) => void renamePlanAsset(a.id, e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') void renamePlanAsset(a.id, (e.target as HTMLInputElement).value)
                                        if (e.key === 'Escape') setRenameState(null)
                                      }}
                                    />
                                  ) : (
                                    <span className="bp-element-name">{a.name}</span>
                                  )}
                                  <span className="bp-element-scenes">{a.sceneCount ? `${a.sceneCount} 幕` : ''}</span>
                                  {!renaming ? (
                                    <button
                                      type="button"
                                      className="bp-flip-btn"
                                      style={{ padding: '0 6px', fontSize: 12 }}
                                      title="行内改名（写计划资产 name；存量英文名可在此修复为中文）"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setRenameState({ assetId: a.id, value: a.name })
                                      }}
                                    >
                                      ✎
                                    </button>
                                  ) : null}
                                </div>
                                {open && children.length ? (
                                  <div className="bp-element-children">
                                    {children.map((c) => (
                                      <div key={c.key} className="bp-element-child-row" title={`${c.kind} · ${c.tone === 'done' ? '已有变体' : '未出图'}`}>
                                        <span className={`bp-mark-dot ${c.tone === 'done' ? 's-imaged' : 's-marked'}`} />
                                        <span className="bp-element-child-label">
                                          {c.kind} · {c.label}
                                        </span>
                                        {c.kind === '子元素' ? (
                                          <button
                                            type="button"
                                            className="bp-flip-btn"
                                            style={{ padding: '0 6px', fontSize: 12 }}
                                            title="子元素改名（锚点词；逐幕构图草稿改写）"
                                            onClick={(e) => {
                                              e.stopPropagation()
                                              const v = window.prompt('子元素新名称（锚点词）', c.label)
                                              if (v && v.trim()) void renameSubElementName(a.id, c.label, v)
                                            }}
                                          >
                                            ✎
                                          </button>
                                        ) : null}
                                      </div>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            )
                          })}
                        </div>
                      ) : null}
                      {renameErr ? <div className="hint" style={{ color: '#fca5a5' }}>{renameErr}</div> : null}
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

            {/* B1：匹配不上任何节点的元素进「未分配」组（不编造归属） */}
            {elementMarks.unassigned.length ? (
              <div className="bp-unassigned">
                <div className="hint" style={{ fontWeight: 700, marginBottom: 6 }}>未分配（{elementMarks.unassigned.length}）</div>
                {elementMarks.unassigned.map((m) => (
                  <div key={m.id} className="bp-element-row">
                    <span className={`bp-mark-dot s-${m.state}`} />
                    <span className="bp-element-name">{m.name}</span>
                    <span className="bp-element-scenes">{elementGroupLabel(m.category)}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {error ? <div style={{ marginTop: 10, color: '#fca5a5' }}>{error}</div> : null}
          </div>
        </div>

        <div className="canvas bp-canvas">
          {/* 中栏三段式：内容工具条（顶部固定，不随滚动）/ 内容滚动区 / 阶段步骤条（底部独立区，与内容分开） */}
          <div className="bp-content-toolbar">
              <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button
                  className={canvasView === 'grid' ? 'btn' : 'btn secondary'}
                  onClick={() => switchView('grid')}
                  disabled={busy}
                >
                  卡片
                </button>
                <button
                  className={canvasView === 'graph' ? 'btn' : 'btn secondary'}
                  onClick={() => switchView('graph')}
                  disabled={busy || !graph}
                >
                  结构图
                </button>
                {/* D1：第三视图「预演」——占位预演内嵌中栏（占位块可拖动编排，写回需求单草稿） */}
                <button
                  className={canvasView === 'previz' ? 'btn' : 'btn secondary'}
                  onClick={() => switchView('previz')}
                  disabled={busy || !canPreviz}
                  title="无图可交互预演与编排：占位画框 + 文本 + 选择分支；占位块可拖动，写回本幕构图需求单草稿"
                >
                  预演
                </button>
                {/* B2+：结构图缩放/平移工具条（对齐合成层语义；仅存组件态） */}
                {canvasView === 'graph' && graph ? (
                  <span className="bp-graph-tools">
                    <button type="button" className="stage-tool-btn" onClick={() => setGraphZoom((z) => Math.max(0.25, Math.round((z / 1.2) * 100) / 100))} title="缩小">
                      −
                    </button>
                    <span className="stage-toolbar-zoom">{Math.round(graphZoom * 100)}%</span>
                    <button type="button" className="stage-tool-btn" onClick={() => setGraphZoom((z) => Math.min(2, Math.round(z * 1.2 * 100) / 100))} title="放大">
                      ＋
                    </button>
                    <button
                      type="button"
                      className="stage-tool-btn"
                      onClick={() => {
                        setGraphZoom(1)
                        setGraphPan({ x: 0, y: 0 })
                      }}
                      title="适应窗口（重置缩放与平移）"
                    >
                      适应窗口
                    </button>
                  </span>
                ) : null}
              </div>
          </div>
          <div className="canvas-wrap">
            <div className="canvas-scroll" style={{ padding: 12, width: 'calc(100% - 24px)', maxWidth: 'none' }}>

              {canvasView === 'previz' ? (
                /* D1：占位预演内嵌中栏；G 波：编排改动进暂存置脏（不再自动写盘），点顶栏保存统一落盘 */
                blueprint && canvasNodes.length ? (
                  <>
                    <PrevizPlayer
                      projectId={props.projectId}
                      blueprint={blueprint}
                      nodes={canvasNodes}
                      scriptCards={scriptCards}
                      assetPlan={assetPlan}
                      project={project}
                      sceneId={previzSceneId}
                      onSceneChange={onPrevizSceneChange}
                      layoutOverrides={curSceneOverrides}
                      onDragBlock={(assetId, v) => setPrevizOverride(previzSceneIdRef.current, assetId, v)}
                      onDragCommit={() => markPrevizDirty(previzSceneIdRef.current)}
                      onBlocksChange={(_nid, blocks) => setPrevizBlocks(blocks)}
                      selectedAssetId={selection.type === 'previzElement' ? selection.assetId : null}
                      onSelectElement={(nid, aid) => setSelection({ type: 'previzElement', nodeId: nid, assetId: aid })}
                      onSelectScene={(nid) => setSelection({ type: 'node', id: nid })}
                      onFocusSceneText={focusSceneTextDraft}
                      onPrevizDone={onPrevizDone}
                      groupEditGroup={previzGroupEdit}
                      subDrafts={curSceneSubDrafts}
                      dirtyScene={Boolean(previzDirtyScenes[previzSceneId])}
                      onGroupEditChange={(g) => {
                        // F 波：进组编辑 → 右栏切该组管理面板；退出 → 回场景属性
                        setPrevizGroupEdit(g)
                        setSelection(g ? { type: 'previzGroup', nodeId: previzSceneIdRef.current || previzSceneId, group: g } : { type: 'node', id: previzSceneIdRef.current || previzSceneId })
                      }}
                      onChanged={() => {
                        void load()
                      }}
                    />
                    {previzDraftMsg ? (
                      <div className="hint" style={{ marginTop: 8, color: previzDraftMsg.startsWith('草稿写回失败') ? '#fca5a5' : '#86efac' }}>
                        {previzDraftMsg}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="hint" style={{ padding: 24 }}>蓝图还没有任何幕，先在卡片/结构图视图添加场景。</div>
                )
              ) : canvasView === 'grid' ? (
                <div
                  style={{ width: '100%' }}
                  onClick={(e) => {
                    // A 波：卡片视图点画布空白（非节点卡）→ 清空选中回默认
                    if ((e.target as HTMLElement).closest('.card')) return
                    setSelection({ type: 'none' })
                  }}
                >
                  <div className="card-grid">
                    {canvasNodes.map((n) => {
                      const sc = n.kind === 'scene' ? scriptCards.find((c) => c.id === n.scriptCardId) : null
                      const title = n.kind === 'scene' && sc ? `#${sc.order} ${sc.name || sc.id}` : (n.name || n.id)
                      const marks = elementMarks.byNode.get(n.id) || []
                      return (
                        <div
                          key={n.id}
                          className={`card ${selection.type === 'node' && selection.id === n.id ? 'active' : ''}`}
                          onClick={() => setSelection({ type: 'node', id: n.id })}
                        >
                          <div className="card-title">{title}</div>
                          {/* B1 元素徽标行（与 plan.json 同源，只读） */}
                          {marks.length ? (
                            <div className="bp-mark-row">
                              {marks.map((m) => (
                                <span
                                  key={m.id}
                                  className="bp-mark is-clickable"
                                  title={`${m.name} · ${m.stageTitle} · 点击去锁定`}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    gotoLockWorkspace()
                                  }}
                                >
                                  <span className={`bp-mark-dot s-${m.state}`} />
                                  {m.name}
                                </span>
                              ))}
                            </div>
                          ) : null}
                          <div className="card-sub">{nodeKindLabel(n.kind)}</div>
                          <div className="card-sub">{(n.textDraft || '').trim().slice(0, 60) || '（无文本草稿）'}</div>
                          {true ? (
                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                              <button
                                className="btn secondary"
                                type="button"
                                style={{ padding: '3px 10px', fontSize: 12 }}
                                disabled={busy || analyzeBusy}
                                title="AI 分析该场景所需元素并写回资产计划（同源，幂等更新）"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void runAnalyzeScene(n.id)
                                }}
                              >
                                AI 分析
                              </button>
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : graph ? (
                <div
                  className="graph-canvas"
                  style={{ width: '100%' }}
                  onPointerDown={(e) => {
                    // B2+ 平移：只在画布背景按下时启动（节点卡按下保持点选语义）
                    if ((e.target as HTMLElement).closest('.graph-card')) return
                    const startX = e.clientX
                    const startY = e.clientY
                    const startPan = graphPan
                    let moved = false
                    const onMove = (ev: PointerEvent) => {
                      const dx = ev.clientX - startX
                      const dy = ev.clientY - startY
                      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return
                      moved = true
                      setGraphPan({ x: startPan.x + dx, y: startPan.y + dy })
                    }
                    const onUp = () => {
                      window.removeEventListener('pointermove', onMove)
                      window.removeEventListener('pointerup', onUp)
                      // A 波：结构图空白点按（未拖动平移）→ 清空选中回默认
                      if (!moved) setSelection({ type: 'none' })
                    }
                    window.addEventListener('pointermove', onMove)
                    window.addEventListener('pointerup', onUp)
                  }}
                >
                  <div
                    className="graph-wrap"
                    style={{
                      width: graph.width,
                      height: graph.height,
                      transform: `translate(${graphPan.x}px, ${graphPan.y}px) scale(${graphZoom})`,
                      transformOrigin: '0 0'
                    }}
                  >
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
                      const marks = elementMarks.byNode.get(n.id) || []
                      return (
                        <div
                          key={n.id}
                          className={`card graph-card ${selection.type === 'node' && selection.id === n.id ? 'active' : ''}`}
                          style={{ position: 'absolute', left: p.x, top: p.y, width: p.w, height: p.h }}
                          onClick={() => setSelection({ type: 'node', id: n.id })}
                        >
                          {/* B1 结构图微型状态点行（右上，不挤布局） */}
                          {marks.length ? (
                            <div className="bp-graph-marks" title={marks.map((m) => m.name).join('、')}>
                              {marks.map((m) => (
                                <span key={m.id} className={`bp-mark-dot s-${m.state}`} />
                              ))}
                            </div>
                          ) : null}
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
          {/* B2+：蓝图阶段步骤条（固定画布区底部，自成一行不遮结构图） */}
          <StageStepper steps={stageSteps} onAction={onStepAction} note={stepNote} liveTasks={liveTasks} />
        </div>

        <div className="panel right bp-right">
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

            {/* D1：预演视图点选元素块 → 元素属性（名称/所属幕/位置大小数值；改数值等同画框拖动，失焦即写回需求单草稿） */}
            {/* D1/E 波：预演视图点选元素块 → 元素属性（全组同权：名称/所属幕/纵深带/位置/朝向/姿态/移除）；
                点选主背景 → 背景组管理面板（组信息 + 本幕元素列表行内编辑） */}
            {/* F 波：组编辑激活 → 组管理面板（只列本组元素；E 波"背景组列全部元素"的错误已纠正） */}
            {selection.type === 'previzGroup' ? (
              <div className="form">{renderPrevizGroupPanel(selection.group, selection.nodeId)}</div>
            ) : selection.type === 'previzElement' ? (
              <div className="form">
                {(() => {
                  const blk = previzBlocks.find((b) => b.assetId === selection.assetId)
                  if (!blk) return <div className="hint">该元素不在当前预演幕。</div>
                  const ownerNode = nodesAll.find((n) => n.id === selection.nodeId)

                  // —— F 波：点选主背景 → 背景组管理面板（只列背景组：主背景+环境块+背景子元素） ——
                  if (blk.group === '背景' && !blk.parentAssetId) {
                    return renderPrevizGroupPanel('背景', selection.nodeId, blk)
                  }

                  // —— 元素属性面板（角色/道具/环境/其他/子元素 同权） ——
                  const cur = previzCurOf(blk)
                  return (
                    <>
                      {/* A 波：快捷回落——任何时候可点回场景属性（用户实测：点中元素后进得去、回不来） */}
                      <button
                        type="button"
                        className="btn secondary"
                        style={{ padding: '3px 10px', fontSize: 12, justifySelf: 'start' }}
                        onClick={() => setSelection({ type: 'node', id: selection.nodeId })}
                      >
                        ← 返回场景属性
                      </button>
                      <div style={{ fontWeight: 800 }}>{blk.name}</div>
                      <div style={{ fontSize: 12, opacity: 0.8, marginTop: -6 }}>
                        {blk.parentAssetId ? `子元素 · 属于 ${previzBlocks.find((p) => p.assetId === blk.parentAssetId)?.name || blk.parentAssetId}` : `预演元素 · ${blk.group}`}
                        {blk.unready ? ' · 未锁定' : ''}
                      </div>
                      <div className="hr" />
                      <div className="form-row">
                        <label>所属幕</label>
                        <input className="input" value={ownerNode ? nodeTitleForUI(ownerNode, scriptCards) : selection.nodeId} readOnly />
                      </div>
                      {/* 纵深带（2026-10-26 用户指令：竖屏按上/中/下=远/中/近派生，与预演参考线同口径） */}
                      <div className="form-row">
                        <label>纵深带</label>
                        <input className="input" readOnly value={`${previzDepthOf(cur.y)}（${cur.y >= 0.667 ? '下带' : cur.y >= 0.334 ? '中带' : '上带'}）`} title="由纵向位置派生：上带=远、中带=中、下带=近" />
                      </div>
                      <div className="form-row">
                        <label>横向位置</label>
                        {previzNumMini(blk, 'x', '块中心横向（0=左缘，1=右缘）')}
                      </div>
                      <div className="form-row">
                        <label>纵向位置</label>
                        {previzNumMini(blk, 'y', '块底边自上（0=顶，1=底）')}
                      </div>
                      <div className="form-row">
                        <label>大小</label>
                        {previzNumMini(blk, 'scale', '占位块相对尺寸（≈画框宽比例）')}
                      </div>
                      <div className="form-row">
                        <label>朝向</label>
                        <div>{previzFlipBtns(blk)}</div>
                      </div>
                      <div className="form-row">
                        <label>姿态</label>
                        <div>{previzPoseSelect(blk)}</div>
                      </div>
                      {/* 2026-11-01 预演占位预览图：候选=主参考+已锁定姿势/状态变体；点选写编排草稿 imageAssetId（占位块渲染真实图），
                          摆位消费端按 imageAssetId 优先选图；「管理」深度回跳锁定出图执行台 */}
                      {!blk.parentAssetId ? (() => {
                        const cands = previzImageCandidatesOf(blk.assetId)
                        if (!cands.length) return null
                        const cur = previzCurOf(blk)
                        return (
                          <div className="form-row">
                            <label>预览图</label>
                            <div style={{ display: 'grid', gap: 6 }}>
                              <div className="bp-previz-imgcand">
                                {cands.map((c) => {
                                  const active = (cur.imageAssetId || '') === c.imageAssetId || (!cur.imageAssetId && c.key === 'primary')
                                  return (
                                    <button
                                      key={c.key}
                                      type="button"
                                      className={`bp-previz-imgcand-item${active ? ' active' : ''}`}
                                      title={`${c.label}（点选后占位块用此图预演；保存写进构图需求单）`}
                                      disabled={busy}
                                      onClick={() => patchPrevizBlock(blk.assetId, { imageAssetId: c.imageAssetId, ...(c.stateKey ? { stateKey: c.stateKey } : {}) })}
                                    >
                                      <img src={toProjectAssetUrl(props.projectId, c.uri)} alt={c.label} draggable={false} />
                                      <span>{c.label}{c.score != null ? ` · ${c.score}分` : ''}</span>
                                    </button>
                                  )
                                })}
                              </div>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                {cur.imageAssetId ? (
                                  <button type="button" className="bp-flip-btn" disabled={busy} title="清除显式选择：占位块回到按姿态自动选图" onClick={() => patchPrevizBlock(blk.assetId, { imageAssetId: '' })}>恢复默认选图</button>
                                ) : (
                                  <span className="hint" style={{ fontSize: 12 }}>默认=按姿态/状态自动选图；显式选择随「保存」写进构图需求单草稿。</span>
                                )}
                                <span style={{ flex: 1 }} />
                                <button type="button" className="btn secondary" style={{ padding: '3px 10px', fontSize: 12 }} disabled={busy} title="跳到 合成 → 锁定事物 第 5 步出图管理，聚焦该元素的姿态出图执行台" onClick={() => gotoLockPoseManage(blk)}>管理（出图）</button>
                              </div>
                            </div>
                          </div>
                        )
                      })() : null}
                      {/* K 波：姿态需求清单（角色组且非子元素时）——2026-11-01 抽至共享组件 PoseRequirementEditor
                          （蓝图=需求定义唯一入口；锁定向导侧已改只读摘要+回跳，两处不再各维护一份定义 UI） */}
                      {blk.group === '角色' && !blk.parentAssetId ? (
                        <PoseRequirementEditor
                          projectId={props.projectId}
                          asset={(Array.isArray(assetPlan?.assets) ? (assetPlan!.assets as any[]) : []).find((x) => String(x?.id || '') === blk.assetId)}
                          busy={busy}
                          saving={poseReqOps.busy}
                          err={poseReqOps.err}
                          note={poseReqOps.note}
                          recipes={(() => {
                            const st = (project?.project as any)?.state
                            const list = st && st.aiBackground && Array.isArray(st.aiBackground.customPoseRecipes) ? st.aiBackground.customPoseRecipes : []
                            return [
                              ...BUILTIN_POSE_RECIPES.map((x) => ({ name: x.name, promptZh: x.promptZh, promptEn: x.promptEn })),
                              ...list.filter((x: any) => String(x?.name || '').trim()).map((x: any) => ({ name: String(x.name), promptZh: String(x.promptZh || ''), promptEn: String(x.promptEn || '') }))
                            ]
                          })()}
                          sceneTextFor={(sceneId) => String(nodesAll.find((n) => n.id === sceneId)?.textDraft || '').slice(0, 600)}
                          onSave={poseReqOps.save}
                          emptyHint="还没有姿态需求。下方新增，或点要素库顶部「提取剧情姿势需求」由 AI 从剧情提取。"
                        />
                      ) : null}
                      <div className="hint" style={{ fontSize: 12, opacity: 0.75 }}>
                        数值与画框拖动等价；朝向/姿态点选即写回本幕构图需求单草稿（刷新/切幕不丢）。
                      </div>
                      <div className="hr" />
                      <button
                        type="button"
                        className="btn secondary"
                        style={{ color: '#fca5a5', borderColor: 'rgba(239,68,68,0.4)', justifySelf: 'start' }}
                        disabled={busy || assignBusy}
                        onClick={() => (blk.parentAssetId ? void removeSubElement(blk.assetId) : void removeElementFromScene(selection.nodeId, blk.assetId))}
                        title={blk.parentAssetId ? '移除该子元素（需求单草稿剔除）' : '把该元素从当前幕移除（写回资产计划；不从计划中删除该元素本身；Delete 键同效）'}
                      >
                        {blk.parentAssetId ? '移除子元素' : '从本幕移除（Delete）'}
                      </button>
                    </>
                  )
                })()}
              </div>
            ) : selection.type === 'node' && selectedNode ? (
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
                    ref={textDraftRef}
                    className="textarea"
                    value={selectedNode.textDraft || ''}
                    onChange={(e) => setNode((n) => ({ ...n, textDraft: e.target.value }))}
                  />
                </div>

                {/* B 波（2026-10-25，§4.5）：声音区——音色绑定 → 生成配音 → 试听；真相源 plan.sceneVoices（同源派生） */}
                {(() => {
                  const rec = (assetPlan as any)?.sceneVoices?.[selectedNode.id]
                  const ttsOn = ttsEnabled === true && ttsProvider && ttsProvider !== 'none'
                  const picked = voiceId || String(rec?.voiceId || '') || voiceGroups[0]?.items[0]?.id || ''
                  return (
                    <div className="form-row">
                      <label>声音</label>
                      <div style={{ display: 'grid', gap: 8 }}>
                        <div
                          data-testid="scene-voice-status"
                          style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24, flexWrap: 'wrap' }}
                          title={rec?.generatedAt ? `生成时间：${String(rec.generatedAt).replace('T', ' ').slice(0, 19)}` : '当前场景尚未生成配音'}
                        >
                          <span className={`bp-prompt-badge ${rec?.audioAssetUri && !voiceBusy ? 'is-ok' : ''}`} style={{ marginLeft: 0, color: voiceBusy ? '#5eccff' : undefined }}>
                            {voiceBusy ? '生成中…' : rec?.audioAssetUri ? '已生成' : '未生成'}
                          </span>
                          <span className="hint">
                            {voiceBusy
                              ? '正在合成当前场景，进度见右下角「任务」'
                              : rec?.audioAssetUri
                                ? `${rec.durationMs != null ? `${(rec.durationMs / 1000).toFixed(1)} 秒` : '时长未知'} · ${voiceLabelOf(String(rec.voiceId || ''))}`
                                : '当前场景尚未生成配音'}
                          </span>
                        </div>
                        {!ttsOn ? (
                          <div className="hint">语音合成未启用：到 设置 → 语音 TTS 启用并选择通道后可生成配音。</div>
                        ) : (
                          <>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <select
                                className="sel"
                                style={{ flex: 1 }}
                                value={picked}
                                disabled={busy || voiceBusy}
                                onChange={(e) => setVoiceId(e.target.value)}
                                title="音色库预设（设置页语音卡同源）"
                              >
                                {voiceGroups.map((g) => (
                                  <optgroup key={g.group} label={g.group}>
                                    {g.items.map((it) => (
                                      <option key={it.id} value={it.id}>
                                        {it.label}
                                      </option>
                                    ))}
                                  </optgroup>
                                ))}
                              </select>
                              <span className="hint" style={{ whiteSpace: 'nowrap' }}>语速 {voiceSpeed.toFixed(2)}×</span>
                            </div>
                            <input
                              type="range"
                              min={0.5}
                              max={2}
                              step={0.05}
                              value={voiceSpeed}
                              disabled={busy || voiceBusy}
                              onChange={(e) => setVoiceSpeed(Number(e.target.value))}
                              title="语速（0.5–2.0 倍）"
                            />
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button
                                className="btn secondary"
                                type="button"
                                disabled={busy || voiceBusy || !(selectedNode.textDraft || '').trim()}
                                title={(selectedNode.textDraft || '').trim() ? '按本幕文本草稿真实合成配音；已有配音时需二次确认' : '本幕无文本草稿，无法合成'}
                                onClick={() => void runGenerateVoice(selectedNode.id)}
                              >
                                {voiceBusy ? '生成中…' : rec?.audioAssetUri ? '重新生成配音' : '生成配音'}
                              </button>
                              {rec?.audioAssetUri ? (
                                <button className="btn secondary" type="button" disabled={voiceBusy} onClick={() => playSceneVoice(selectedNode.id)}>
                                  试听
                                </button>
                              ) : null}
                            </div>
                            {voiceNote ? <div className="hint" style={{ color: '#86efac' }}>{voiceNote}</div> : null}
                            {voiceErr ? <div className="hint" style={{ color: '#fca5a5' }}>{voiceErr}</div> : null}
                          </>
                        )}
                      </div>
                    </div>
                  )
                })()}

                {/* B2+：AI 场景分析（当前选中场景即分析对象；写回资产计划 plan.json 同源，徽标/要素库/步骤条即时刷新） */}
                {true ? (
                  <div className="form-row">
                    <label>场景元素</label>
                    <div style={{ display: 'grid', gap: 8 }}>
                      <button
                        className="btn secondary"
                        type="button"
                        disabled={busy || analyzeBusy}
                        title="AI 分析该场景内容，得出所需元素并写回资产计划（只报真实存在的元素；重复分析幂等更新）"
                        onClick={() => void runAnalyzeScene(selectedNode.id)}
                      >
                        {analyzeBusy ? '分析中…' : 'AI 分析'}
                      </button>
                      {analyzeBusy ? (
                        <div className="hint">正在分析该场景内容（本地模型约需 10–60 秒），进度见右下角「任务」。</div>
                      ) : null}
                      {analyzeNote ? <div className="hint" style={{ color: '#86efac' }}>{analyzeNote}</div> : null}
                      {/* P4（2026-10-25 用户实测）：分析结果常驻——直接读 plan 同源标记，切换节点不丢；瞬态提示只锦上添花 */}
                      {(() => {
                        const marks = elementMarks.byNode.get(selectedNode.id) || []
                        if (!marks.length) return null
                        return (
                          <div className="bp-analyze-result">
                            {marks.map((m) => (
                              <span key={m.id} className="bp-mark" title={elementStageTitle(m)}>
                                <span className={`bp-mark-dot s-${m.state}`} />
                                {m.name}
                                <span className="bp-analyze-cat">{elementGroupLabel(m.category)}</span>
                              </span>
                            ))}
                          </div>
                        )
                      })()}
                      {analyzeErr ? <div className="hint" style={{ color: '#fca5a5' }}>{analyzeErr}</div> : null}
                    </div>
                  </div>
                ) : null}

                <div className="hr" />

                <div style={{ fontWeight: 700 }}>要素分配</div>
                <div className="hint" style={{ marginTop: 6 }}>
                  把计划里的元素分配到当前幕（预演/构图/出图摆位都从这里长；写资产计划同源）。
                </div>

                {/* 2026-10-25 要素分配激活：数据从手工占位库换成资产计划（plan 同源），分配即写回场景 assetIds */}
                {(() => {
                  const planAssets = Array.isArray((assetPlan as any)?.assets) ? (assetPlan as any).assets : []
                  const planScenes = Array.isArray((assetPlan as any)?.scenes) ? (assetPlan as any).scenes : []
                  const curScene = planScenes.find((sc: any) => String(sc?.sceneId || "") === selectedNode.id)
                  const assignedIds = new Set((Array.isArray(curScene?.assetIds) ? curScene.assetIds : []).map((x: any) => String(x)))
                  if (!planAssets.length) {
                    return <div className="hint">还没有资产计划：先在上方做一次「AI 分析」或「分析全部场景」。</div>
                  }
                  const groups: Array<{ key: string; label: string; match: (a: any) => boolean }> = [
                    { key: "background", label: "背景", match: (a) => elementGroupLabel(String(a?.category || "")) === "背景" },
                    { key: "scenery", label: "背景元素", match: (a) => elementGroupLabel(String(a?.category || "")) === "环境" },
                    { key: "character", label: "角色", match: (a) => elementGroupLabel(String(a?.category || "")) === "角色" },
                    { key: "prop", label: "道具", match: (a) => elementGroupLabel(String(a?.category || "")) === "道具" }
                  ]
                  return groups.map((g) => {
                    const inGroup = planAssets.filter(g.match)
                    const assigned = inGroup.filter((a: any) => assignedIds.has(String(a?.id || "")))
                    const available = inGroup.filter((a: any) => !assignedIds.has(String(a?.id || "")))
                    const pick = assignPicks[g.key] || ""
                    return (
                      <div className="form-row" key={g.key}>
                        <label>{g.label}（计划）</label>
                        <div style={{ display: "grid", gap: 8 }}>
                          {assigned.length ? (
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {assigned.map((a: any) => (
                                <span key={String(a.id)} className="bp-mark">
                                  <span className={`bp-mark-dot s-${elementStageOf(a)}`} />
                                  {elementDisplayName(a)}
                                  <button
                                    type="button"
                                    className="bp-mark-remove"
                                    title="从本幕移除"
                                    aria-label="从本幕移除"
                                    disabled={busy || assignBusy}
                                    onClick={() => void assignElement(selectedNode.id, String(a.id), "remove")}
                                  >
                                    ✕
                                  </button>
                                </span>
                              ))}
                            </div>
                          ) : (
                            <div className="hint">本幕未分配{g.label}</div>
                          )}
                          {available.length ? (
                            <div style={{ display: "flex", gap: 8 }}>
                              <select
                                className="sel"
                                value={pick}
                                onChange={(e) => setAssignPicks((prev) => ({ ...prev, [g.key]: e.target.value }))}
                                disabled={busy || assignBusy}
                              >
                                <option value="">选择要分配的{g.label}…</option>
                                {available.map((a: any) => (
                                  <option key={String(a.id)} value={String(a.id)}>
                                    {elementDisplayName(a)}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="btn secondary"
                                disabled={busy || assignBusy || !pick}
                                onClick={() => void assignElement(selectedNode.id, pick, "add")}
                              >
                                添加到场景
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    )
                  })
                })()}

                <div className="hr" />

                <div style={{ fontWeight: 700 }}>选项（分支）</div>
                <div className="hint" style={{ marginTop: 6 }}>
                  提示：这里修改“指向/文本”会把该选项变为手工覆盖（以后从脚本重新编译蓝图时会保留，不再自动更新）。
                </div>

                {true ? (
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
