// 蓝图工作室 B1：准备度模型 + 元素标记派生（单一来源；全部只读派生，不写真相源）
// 数据同源：plan.json（project.state.aiBackground.storyAssetPlan）/ story.json / 编译校验 / 设置页语音开关。
import type { ProjectV1, StoryAssetPlan } from '../../api'

export type ReadinessTone = 'ok' | 'warn' | 'muted'
export type ReadinessSegment = { key: '结构' | '元素' | '配音' | '图'; text: string; tone: ReadinessTone }

export type ReadinessInput = {
  /** 结构校验问题清单（BlueprintStudio problems memo） */
  problems: string[]
  /** 资产计划（null=未生成） */
  plan: StoryAssetPlan | null
  /** story.json 场景绑定情况（null=story.json 不存在=未开始） */
  story: { bound: number; total: number } | null
  /** 语音是否启用（effective.enabled.tts；null=未知按未开始） */
  ttsEnabled: boolean | null
  /** 蓝图场景幕 id 集（配音维度分母；缺省回退 sceneVoices 记录数） */
  sceneIds?: string[]
}

// 配音维度单一口径（2026-10-25 B 波）：plan.sceneVoices 有记录=该幕已配；返回 {voiced,total}
export function sceneVoiceCoverage(plan: StoryAssetPlan | null, sceneIds?: string[]): { voiced: number; total: number } {
  const recs = plan && (plan as any).sceneVoices && typeof (plan as any).sceneVoices === 'object' ? (plan as any).sceneVoices : {}
  const ids = Array.isArray(sceneIds) && sceneIds.length ? sceneIds.map(String) : Object.keys(recs)
  const total = ids.length
  const voiced = ids.filter((id) => {
    const v = recs[id]
    return Boolean(v && String(v.audioAssetUri || '').trim() && String(v.status || '') === 'ready')
  }).length
  return { voiced, total }
}

export function computeReadiness(input: ReadinessInput): { segments: ReadinessSegment[]; text: string } {
  const structure: ReadinessSegment =
    input.problems.length === 0
      ? { key: '结构', text: '结构 ✓', tone: 'ok' }
      : { key: '结构', text: `结构 ${input.problems.length} 问题`, tone: 'warn' }

  let elements: ReadinessSegment
  if (!input.plan) {
    elements = { key: '元素', text: '元素 未提取', tone: 'muted' }
  } else {
    const assets = Array.isArray(input.plan.assets) ? input.plan.assets : []
    const total = assets.length
    const locked = assets.filter((a: any) => a?.referenceStatus === 'ready' || a?.primaryReferenceAssetId || a?.primaryReferenceAssetUri).length
    elements = { key: '元素', text: `元素 ${locked}/${total}`, tone: total > 0 && locked >= total ? 'ok' : 'warn' }
  }

  // 配音（2026-10-25 B 波落地）：plan.sceneVoices 真实计数；语音未启用 → 跳过
  let voice: ReadinessSegment
  if (input.ttsEnabled === false) {
    voice = { key: '配音', text: '配音 跳过', tone: 'muted' }
  } else {
    const { voiced, total } = sceneVoiceCoverage(input.plan, input.sceneIds)
    voice =
      total === 0
        ? { key: '配音', text: '配音 未开始', tone: 'muted' }
        : { key: '配音', text: `配音 ${voiced}/${total}`, tone: voiced >= total ? 'ok' : voiced > 0 ? 'warn' : 'muted' }
  }

  let image: ReadinessSegment
  if (!input.story || input.story.total === 0) {
    image = { key: '图', text: '图 未开始', tone: 'muted' }
  } else {
    const { bound, total } = input.story
    image = { key: '图', text: `图 ${bound}/${total}`, tone: bound >= total ? 'ok' : 'warn' }
  }

  const segments = [structure, elements, voice, image]
  return { segments, text: segments.map((s) => s.text).join(' · ') }
}

// ---- 元素标记（与 plan.json 同源）：节点 → 本幕元素徽标 ----
export type ElementMark = { id: string; name: string; category: string; state: ElementStage; stageTitle: string }

function assetMarkState(a: any): ElementStage {
  return elementStageOf(a)
}

/** @deprecated B2+ 起由 elementStageOf 取代（保留导出兼容旧调用；新代码一律用 elementStageOf） */
export function elementAssetState(a: any): ElementStage {
  return elementStageOf(a)
}

// ---- B2+：元素阶段状态（五档，取资产达到的最高阶段） ----
export type ElementStage = 'marked' | 'locked' | 'lineart' | 'variants' | 'imaged'
export const ELEMENT_STAGE_ORDER: ElementStage[] = ['marked', 'locked', 'lineart', 'variants', 'imaged']
export const ELEMENT_STAGE_LABEL: Record<ElementStage, string> = {
  marked: '已标记',
  locked: '已锁定',
  lineart: '线稿完成',
  variants: '变体齐',
  imaged: '已有图'
}

function assetStageFlags(a: any): Record<Exclude<ElementStage, 'marked'>, boolean> {
  const poseV = Array.isArray(a?.poseVariants) ? a.poseVariants.length : 0
  const stateV = Array.isArray(a?.stateVariants) ? a.stateVariants.length : 0
  return {
    locked: a?.referenceStatus === 'ready' || Boolean(a?.primaryReferenceAssetId),
    lineart: a?.lineartStatus === 'ready',
    variants: poseV + stateV > 0,
    imaged: Boolean(a?.primaryReferenceAssetUri)
  }
}

export function elementStageOf(a: any): ElementStage {
  const f = assetStageFlags(a)
  if (f.imaged) return 'imaged'
  if (f.variants) return 'variants'
  if (f.lineart) return 'lineart'
  if (f.locked) return 'locked'
  return 'marked'
}

/** 悬停文案：当前阶段 + 首个未达到阶段的「未完成」（如「已锁定 · 线稿未完成」） */
export function elementStageTitle(a: any): string {
  const stage = elementStageOf(a)
  const f = assetStageFlags(a)
  const order: Exclude<ElementStage, 'marked'>[] = ['locked', 'lineart', 'variants', 'imaged']
  const shortLabel: Record<string, string> = { locked: '锁定', lineart: '线稿', variants: '变体', imaged: '出图' }
  const firstMissing = order.find((k) => !f[k])
  return ELEMENT_STAGE_LABEL[stage] + (firstMissing ? ` · ${shortLabel[firstMissing]}未完成` : '')
}

function hasCjkText(s: string) {
  return /[\u4e00-\u9fff]/.test(String(s || ''))
}

/** 元素显示名（B2 用户验收点）：中文标签优先（name 含中文 → referencePromptZh 首段 → 中文 alias），英文资产名兜底，不编造翻译 */
export function elementDisplayName(a: any): string {
  const name = String(a?.name || '').trim()
  if (hasCjkText(name)) return name
  const zh = String(a?.referencePromptZh || '').trim()
  if (hasCjkText(zh)) {
    const first = zh.split(/[，,；;。\n]/)[0].trim()
    if (first) return first
  }
  const aliases = Array.isArray(a?.aliases) ? a.aliases : []
  const zhAlias = aliases.find((x: any) => hasCjkText(String(x || '')))
  if (zhAlias) return String(zhAlias).trim()
  return name || String(a?.id || '')
}

function dedupeMarksByName(list: ElementMark[]): ElementMark[] {
  const seen = new Set<string>()
  const out: ElementMark[] = []
  for (const m of list) {
    if (seen.has(m.name)) continue
    seen.add(m.name)
    out.push(m)
  }
  return out
}

/** 类目 → 左栏族：location→背景 / character→角色 / prop→道具 / scenery→环境（2026-11-06 背景元素；事件无数据源，裁决见 B1 波报告） */
export function elementGroupLabel(category: string): string {
  const c = String(category || '').toLowerCase()
  if (c === 'location' || c === 'background') return '背景'
  if (c === 'character' || c === 'actor') return '角色'
  if (c === 'prop' || c === 'item') return '道具'
  if (c === 'scenery') return '环境'
  return '其他'
}

export function computeElementMarks(
  plan: StoryAssetPlan | null,
  nodes: { id: string; name?: string }[],
  // D1（2026-10-25）：预演画框出块传 { requireAnalyzed: false }——占位块是演示数据（该幕所需元素来自 plan 归属），
  // 与「节点卡徽标=已分析提示（防误导）」口径分工不同；缺省 true 保持节点卡新口径
  opts?: { requireAnalyzed?: boolean; storyNodes?: any[] }
): { byNode: Map<string, ElementMark[]>; unassigned: ElementMark[] } {
  const requireAnalyzed = opts?.requireAnalyzed !== false
  const byNode = new Map<string, ElementMark[]>()
  const unassigned: ElementMark[] = []
  if (!plan) return { byNode, unassigned }
  const assets = Array.isArray(plan.assets) ? plan.assets : []
  const scenes = Array.isArray(plan.scenes) ? plan.scenes : []
  const assetById = new Map(assets.map((a: any) => [String(a?.id || ''), a]))

  // 场景归属：sceneId 先与节点 id 精确对应；名称子串兜底（与 repair-links 同族思路）；仍无则进未分配
  const nodeById = new Map(nodes.map((n) => [String(n.id), n]))
  const assetSceneNodeIds = new Map<string, Set<string>>()

  // 2026-11-03 用户裁决：地点类资产（prompt_only/optional_ref）不出立绘——其"已有图"就绪判据改为
  // 该资产关联的任一 scene 已有绑定场景背景（story.visuals.backgroundAssetId），而非要求自身主参考。
  const boundSceneIds = new Set<string>(
    (Array.isArray(opts?.storyNodes) ? opts!.storyNodes : [])
      .filter((n) => String((n as any)?.visuals?.backgroundAssetId || '').trim())
      .map((n) => String(n.id))
  )
  const hasBoundBackground = (aid: string): boolean => {
    if (!boundSceneIds.size) return false
    for (const nid of assetSceneNodeIds.get(aid) || []) if (boundSceneIds.has(nid)) return true
    return false
  }
  const markOf = (a: any): ElementMark => {
    const aid = String(a?.id || '')
    const refRequired = String(a?.renderStrategy || '').trim() === 'ref_required'
    // 「绑定背景即已有图」豁免只适用地点类（不出立绘）；scenery 背景元素必须有自己的透明立绘，不适用
    const cat = String(a?.category || '').trim().toLowerCase()
    if (!refRequired && (cat === 'location' || cat === 'background') && hasBoundBackground(aid)) {
      return { id: aid, name: elementDisplayName(a), category: String(a?.category || ''), state: 'imaged', stageTitle: '已有图（已绑定背景）' }
    }
    return { id: aid, name: elementDisplayName(a), category: String(a?.category || ''), state: assetMarkState(a), stageTitle: elementStageTitle(a) }
  }

  for (const sc of scenes) {
    const sceneId = String((sc as any)?.sceneId || '')
    const sceneName = String((sc as any)?.sceneName || '')
    // 2026-10-25 用户口径：只有"已分析"（analyzedAt 戳）或"手工分配"（assignedAt 戳）的场景才在节点上出徽标——未分析未分配不出提示
    if (requireAnalyzed && !(sc as any)?.analyzedAt && !(sc as any)?.assignedAt) continue
    let nodeId = nodeById.has(sceneId) ? sceneId : ''
    if (!nodeId && sceneName) {
      const hit = nodes.find((n) => {
        const nn = String(n.name || '')
        return nn && (sceneName.includes(nn) || nn.includes(sceneName))
      })
      nodeId = hit ? String(hit.id) : ''
    }
    if (!nodeId) continue
    const ids = Array.isArray((sc as any)?.assetIds) ? (sc as any).assetIds : []
    for (const raw of ids) {
      const aid = String(raw || '')
      if (!assetById.has(aid)) continue
      if (!assetSceneNodeIds.has(aid)) assetSceneNodeIds.set(aid, new Set())
      assetSceneNodeIds.get(aid)!.add(nodeId)
    }
  }

  const assignedAssetIds = new Set<string>()
  for (const [aid, nodeIds] of assetSceneNodeIds) {
    const a = assetById.get(aid)
    if (!a) continue
    assignedAssetIds.add(aid)
    const mark = markOf(a)
    for (const nid of nodeIds) {
      if (!byNode.has(nid)) byNode.set(nid, [])
      byNode.get(nid)!.push(mark)
    }
  }
  for (const a of assets) {
    const aid = String(a?.id || '')
    if (!aid || assignedAssetIds.has(aid)) continue
    unassigned.push({ id: aid, name: elementDisplayName(a), category: String(a?.category || ''), state: assetMarkState(a), stageTitle: elementStageTitle(a) })
  }
  // B2 复查修正：同名重复资产（不同 id）在徽标行按显示名去重，只显示一次
  for (const [nid, list] of byNode) byNode.set(nid, dedupeMarksByName(list))
  return { byNode, unassigned: dedupeMarksByName(unassigned) }
}

/** story.json 图维度：场景幕总数与已绑定数（结尾幕不计分母；visuals.backgroundAssetId 为绑定凭据） */
export function storyImageCoverage(project: ProjectV1 | null | undefined): { bound: number; total: number } | null {
  const story = (project as any)?.story
  const nodes = Array.isArray(story?.nodes) ? (story.nodes as any[]) : null
  if (!nodes || !nodes.length) return null
  const scenes = nodes.filter((n) => String((n as any)?.kind || 'scene') !== 'ending')
  const total = scenes.length || nodes.length
  const bound = scenes.filter((n) => {
    const bgId = (n as any)?.visuals?.backgroundAssetId
    if (typeof bgId === 'string' && bgId.trim()) return true
    const bg = (n as any)?.visuals?.background ?? (n as any)?.background
    if (bg && typeof bg === 'object') return Boolean(bg.uri || bg.src || bg.url || bg.path)
    return Boolean(typeof bg === 'string' && bg.trim())
  }).length
  return { bound, total }
}

// ---- B2+（2026-10-21 用户裁决）：蓝图阶段步骤条派生——六步固定序，诚实口径，事件驱动重算 ----
// 裁决：提示词/线稿/变体是出图侧工作，不进蓝图步骤条（它们只在元素阶段标识 elementStageOf 里作反映项）。
// 状态语义（2026-10-21 用户实测修正）：done=完成(绿) / partial=部分完成(黄，0<x<总) / running=正在执行(蓝脉冲，仅当台账真有任务在跑) / todo=未开始(灰) / skipped=跳过(暗)
export type StageStepStatus = 'done' | 'partial' | 'running' | 'todo' | 'skipped'
export type StageStep = { key: string; label: string; status: StageStepStatus; count?: string }

export type StageStepsInput = {
  /** 编译校验问题清单（空=结构确认完成） */
  problems: string[]
  /** 资产计划（null=未生成） */
  plan: StoryAssetPlan | null
  /** 预演完成时间戳（localStorage bp.previz.<projectId>；旧 key bp.playtested.* 读取兼容一次） */
  previzAt: string
  /** 语音是否启用（false→配音跳过） */
  ttsEnabled: boolean | null
  /** 蓝图完整剧情幕 id 集（普通场景与结局都计入；缺省回退资产计划全量口径） */
  sceneIds?: string[]
}

export function computeStageSteps(input: StageStepsInput): StageStep[] {
  const assets = input.plan && Array.isArray(input.plan.assets) ? (input.plan.assets as any[]) : []
  const total = assets.length
  const locked = assets.filter((a) => a?.referenceStatus === 'ready' || a?.primaryReferenceAssetId).length
  const allScenes = input.plan && Array.isArray(input.plan.scenes) ? (input.plan.scenes as any[]) : []
  // 分母使用蓝图完整剧情幕（普通场景+结局）；计划中尚无记录的新幕保留为未完成项。
  const sceneById = new Map(allScenes.map((s) => [String(s?.sceneId || ''), s]))
  const scenes = Array.isArray(input.sceneIds) && input.sceneIds.length
    ? input.sceneIds.map((id) => sceneById.get(String(id)) || { sceneId: String(id) })
    : allScenes
  // 场景元素分析：plan scenes 有分析产物计数（analyzedAt 戳 或 assetIds 非空；资产计划整体生成视作全幕已分析）
  const analyzedScenes = scenes.filter((s) => String(s?.analyzedAt || '').trim() || (Array.isArray(s?.assetIds) && s.assetIds.length)).length
  const compScenes = scenes.filter((s) => s?.composition && Array.isArray(s.composition.items) && s.composition.items.length).length

  return [
    {
      key: 'structure',
      label: '结构确认',
      status: input.problems.length === 0 ? 'done' : 'partial'
    },
    {
      key: 'analyze',
      label: '场景元素分析',
      status: !input.plan ? 'todo' : scenes.length > 0 && analyzedScenes >= scenes.length ? 'done' : analyzedScenes > 0 ? 'partial' : 'todo',
      count: input.plan ? `分析 ${analyzedScenes}/${scenes.length}` : undefined
    },
    {
      key: 'lock',
      label: '事物锁定',
      status: !input.plan ? 'todo' : total > 0 && locked >= total ? 'done' : locked > 0 ? 'partial' : 'todo',
      // K 波（2026-10-27 姿态需求前移蓝图）：副计数=ref_required 角色中已定义姿态需求的占比
      count: (() => {
        if (!input.plan) return undefined
        const chars = assets.filter((a) => String(a?.category || '') === 'character' && String(a?.renderStrategy || '').trim() === 'ref_required')
        const withReqs = chars.filter((a) => Array.isArray(a?.poseRequirements) && a.poseRequirements.length).length
        const base = `锁定 ${locked}/${total}`
        return chars.length ? `${base} · 姿态需求 ${withReqs}/${chars.length}` : base
      })()
    },
    {
      // P6（2026-10-25 用户裁决）：唯一演示形态=占位预演；构图预排计数并入本步
      key: 'previz',
      label: '占位预演',
      status: input.previzAt ? 'done' : !input.plan ? 'todo' : scenes.length > 0 && compScenes >= scenes.length ? 'done' : compScenes > 0 ? 'partial' : 'todo',
      count: input.plan ? `构图 ${compScenes}/${scenes.length}` : undefined
    },
    {
      // B 波（2026-10-25）：配音步真实计数（plan.sceneVoices 覆盖蓝图场景幕）；语音未启用 → 跳过
      key: 'voice',
      label: '配音',
      status: (() => {
        if (input.ttsEnabled === false) return 'skipped'
        if (!input.plan || !scenes.length) return 'todo'
        const { voiced } = sceneVoiceCoverage(input.plan, scenes.map((s) => String(s?.sceneId || '')))
        return voiced >= scenes.length ? 'done' : voiced > 0 ? 'partial' : 'todo'
      })(),
      count: input.ttsEnabled === false ? '跳过' : input.plan && scenes.length ? `配音 ${sceneVoiceCoverage(input.plan, scenes.map((s) => String(s?.sceneId || ''))).voiced}/${scenes.length}` : undefined
    }
  ]
}
