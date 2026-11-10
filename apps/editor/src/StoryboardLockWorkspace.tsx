import React from 'react'
import { dlgAlert, dlgConfirm } from './dialog'
import { resolveUrl, listProjectAiTasks, listProjectAiCoverage, renderAllStoryScenesAi, listImageReviewsAi, approveImageReviewAi, rejectImageReviewAi, approveAllImageReviewsAi, subscribeProjectAiEvents, getComfyuiModels, getStudioSettings, saveStudioSettings, launchStudioTool, assignPlanSceneAsset, listPromptLibrary, savePromptLibraryEntry, deletePromptLibraryEntryById, type AiBackgroundRequest, type AiCoverage, type AiTaskProgress, type ImageReviewRecord, type PromptLibraryEntry, type StoryAssetGalleryEntry } from './api'
import ScenePoseWorkbench from './components/pose/ScenePoseWorkbench'
import AutoGrowTextarea from './components/shared/AutoGrowTextarea'
import DetailWorkspace from './components/shared/DetailWorkspace'
import BackgroundCenter from './components/scene/BackgroundCenter'
import LocationTemplateBoard, { locationSceneIdsOf } from './components/scene/LocationTemplateBoard'
import SceneryElementBoard from './components/scene/SceneryElementBoard'
import { poseScoreBadgeOf } from './components/pose/poseTypes'
import { toProjectAssetUrl, toRuntimeUrl } from './components/pose/assetUrl'
// R 波项 3：配方/组装器常量消费迁至蓝图姿态需求清单（BlueprintStudio），本组件不再引用 poseRecipes

// 公共提示词库插入目标：某个提示词输入对（中文栏+英文栏）的读写通道
type PromptLibTarget = {
  label: string
  kind: 'positive' | 'negative'
  getZh: () => string
  getEn: () => string
  setZh: (v: string) => void
  setEn: (v: string) => void
}

function getAssetCategoryLabel(category: string) {
  const c = String(category || '').trim()
  if (c === 'character') return '角色'
  if (c === 'prop') return '道具'
  if (c === 'location') return '地点'
  if (c === 'scenery') return '背景元素'
  return c || '资产'
}

function getReferenceStatusLabel(status: string) {
  const s = String(status || '').trim()
  if (s === 'ready') return '主参考已选'
  if (s === 'candidates_ready') return '待选择主参考'
  return '未抽卡'
}

// 2026-10-07 修复误导：prompt_only/optional_ref 事物（多为地点）不出立绘——锚点词烘进场景背景，
// 显示"未抽卡"红标签会让用户误以为漏出图（假日出游四个地点误报事件）。
// 只有 ref_required 资产才需要抽卡；其余显示实现方式。
function getAssetRefChip(asset: any): { label: string; tone: 'ok' | 'bad' } {
  const strategy = String(asset?.renderStrategy || '').trim()
  if (strategy && strategy !== 'ref_required') return { label: '锚点入背景', tone: 'ok' }
  const ready = String(asset?.primaryReferenceAssetUri || '').trim().length > 0
  return { label: getReferenceStatusLabel(String(asset?.referenceStatus || '')), tone: ready ? 'ok' : 'bad' }
}

function scoreOf(candidate: any) {
  const n = Number(candidate?.analysis?.score)
  return Number.isFinite(n) ? Math.round(n) : null
}

function formatGalleryTime(raw: string) {
  const value = String(raw || '').trim()
  if (!value) return ''
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return value
  try {
    return new Date(time).toLocaleString('zh-CN', { hour12: false })
  } catch (_) {
    return new Date(time).toISOString()
  }
}

function normalizeAssetPath(raw: string) {
  return String(raw || '').trim().replace(/^\/+/, '')
}

function buildDisplayedReferenceCandidates(asset: any) {
  const primaryUri = normalizeAssetPath(String(asset?.primaryReferenceAssetUri || ''))
  const batchAll = Array.isArray(asset?.latestReferenceBatch) ? asset.latestReferenceBatch.filter((item: any) => item && typeof item === 'object') : []
  const refsAll = Array.isArray(asset?.generatedRefs) ? asset.generatedRefs.filter((item: any) => item && typeof item === 'object') : []
  const byPath = new Map<string, any>()

  for (let i = 0; i < refsAll.length; i += 1) {
    const ref = refsAll[i]
    const assetPath = normalizeAssetPath(String(ref?.projectAssetUri || ''))
    if (!assetPath) continue
    byPath.set(assetPath, {
      assetPath,
      createdAt: String(ref?.createdAt || '').trim(),
      seed: ref?.seed,
      prompt: ref?.prompt,
      negativePrompt: ref?.negativePrompt,
      provider: ref?.provider,
      _refIndex: i
    })
  }

  for (let i = 0; i < batchAll.length; i += 1) {
    const item = batchAll[i]
    const assetPath = normalizeAssetPath(String(item?.assetPath || ''))
    if (!assetPath) continue
    const prev = byPath.get(assetPath) || {}
    byPath.set(assetPath, {
      ...prev,
      ...item,
      assetPath,
      createdAt: String(prev?.createdAt || item?.createdAt || '').trim(),
      _batchIndex: i
    })
  }

  if (primaryUri && !byPath.has(primaryUri)) {
    byPath.set(primaryUri, { assetPath: primaryUri, analysis: asset?.latestReferenceReview || null })
  }

  const all = Array.from(byPath.values())
  const latestFirst = all.slice().sort((a: any, b: any) => {
    const timeA = Date.parse(String(a?.createdAt || ''))
    const timeB = Date.parse(String(b?.createdAt || ''))
    if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeB - timeA
    if (Number.isFinite(timeA) && !Number.isFinite(timeB)) return -1
    if (!Number.isFinite(timeA) && Number.isFinite(timeB)) return 1
    const refIndexA = Number(a?._refIndex)
    const refIndexB = Number(b?._refIndex)
    if (Number.isFinite(refIndexA) && Number.isFinite(refIndexB) && refIndexA !== refIndexB) return refIndexB - refIndexA
    const batchIndexA = Number(a?._batchIndex)
    const batchIndexB = Number(b?._batchIndex)
    if (Number.isFinite(batchIndexA) && Number.isFinite(batchIndexB) && batchIndexA !== batchIndexB) return batchIndexA - batchIndexB
    return String(a?.assetPath || '').localeCompare(String(b?.assetPath || ''))
  })

  let display: any[] = []
  if (primaryUri) {
    const primary = latestFirst.find((item: any) => normalizeAssetPath(String(item?.assetPath || '')) === primaryUri) || null
    const others = latestFirst.filter((item: any) => normalizeAssetPath(String(item?.assetPath || '')) !== primaryUri)
    display = primary ? [primary, ...others.slice(0, 3)] : others.slice(0, 4)
    if (all.length <= 4) {
      display = primary ? [primary, ...others] : latestFirst.slice(0, 4)
    }
  } else {
    display = latestFirst.slice(0, 4)
  }

  return {
    all: latestFirst,
    display,
    overflow: Math.max(0, latestFirst.length - display.length)
  }
}

type AssetPromptDraft = {
  promptZh?: string
  promptEn?: string
  negativePromptZh?: string
  negativePrompt?: string
  promptReview?: {
    passed?: boolean
    score?: number
    summary?: string
    strengths?: string[]
    risks?: string[]
    suggestions?: string[]
  } | null
  enhancedAt?: string
  enhanceMode?: string
}

function assetPromptReviewTone(review: AssetPromptDraft['promptReview']) {
  const score = Number(review?.score)
  if (Number.isFinite(score) && score >= 70) return { cls: 'ok', color: '#a7f3d0' }
  if (Number.isFinite(score) && score >= 50) return { cls: 'pending', color: '#fde68a' }
  return { cls: 'bad', color: '#fca5a5' }
}

function summarizeStoryBible(raw: string) {  const value = String(raw || '').trim()
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    const characters = Array.isArray(parsed?.characters) ? parsed.characters.length : 0
    const props = Array.isArray(parsed?.props) ? parsed.props.length : 0
    const locations = Array.isArray(parsed?.locations) ? parsed.locations.length : 0
    const worldAnchor = String(parsed?.worldAnchor || '').trim()
    return {
      characters,
      props,
      locations,
      hasWorldAnchor: Boolean(worldAnchor),
      worldAnchorPreview: worldAnchor ? worldAnchor.slice(0, 140) : '',
      invalid: false
    }
  } catch (_) {
    return {
      characters: 0,
      props: 0,
      locations: 0,
      hasWorldAnchor: false,
      worldAnchorPreview: '',
      invalid: true
    }
  }
}

// 2026-10-05 圣经内容明细：解析 storyBibleJson 取出角色/道具/地点的完整条目（名称+设定描述+锚点提示词），
// 供展开区展示——此前展开只显示世界锚点摘要，生成结果内容用户不可见（假日出游手动测试事件）。
function parseStoryBibleDetails(raw: string) {
  const value = String(raw || '').trim()
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    const pick = (list: any[], keys: string[]) => (Array.isArray(list) ? list : []).map((item: any) => {
      const name = String(item?.name || item?.id || '').trim()
      const desc = keys.map((k) => String(item?.[k] || '').trim()).filter(Boolean)[0] || ''
      const anchor = String(item?.anchorPrompt || item?.anchor || item?.fingerprintPrompt || '').trim()
      const scenes = Array.isArray(item?.scenes) ? item.scenes.length : 0
      return { name, desc, anchor, scenes }
    }).filter((x) => x.name)
    return {
      worldAnchor: String(parsed?.worldAnchor || '').trim(),
      characters: pick(parsed?.characters, ['description', 'profile', 'personality', 'identity']),
      props: pick(parsed?.props, ['description', 'appearance', 'shape']),
      locations: pick(parsed?.locations, ['description', 'setting', 'atmosphere']),
      worldRules: Array.isArray(parsed?.worldRules) ? parsed.worldRules.map((x: any) => String(x || '').trim()).filter(Boolean) : []
    }
  } catch (_) {
    return null
  }
}

// ============ 2026-09-02 事物总览卡片墙：状态推导与卡图（纯函数，供一级卡片/二级弹层共用） ============
type AssetLockTone = 'locked' | 'lineart' | 'draw' | 'draft'

// 状态推导：已锁定（主参考+线稿齐）/ 待锁定（有主参考缺线稿）/ 待抽卡（有提示词，主参考未定）/ 待起草（提示词都没有）。
// 与向导门禁同口径：仅 renderStrategy==='ref_required' 需要参考图+线稿；其余资产（prompt_only/未标）不被门禁约束，
// 有第 4 步提示词稿或计划锚点词（anchorPrompt）即视为已锁定。
function assetLockStatusOf(asset: any, promptDrafts: Record<string, any> | undefined): { tone: AssetLockTone; label: string } {
  const refRequired = String(asset?.renderStrategy || '').trim() === 'ref_required'
  const aid = String(asset?.id || '').trim()
  const d = (promptDrafts && promptDrafts[aid]) || {}
  const hasPromptDraft = Boolean(String(d.promptZh || d.promptEn || '').trim())
  if (!refRequired) return (hasPromptDraft || String(asset?.anchorPrompt || '').trim()) ? { tone: 'locked', label: '已锁定' } : { tone: 'draft', label: '待起草' }
  const hasPrimary = Boolean(String(asset?.primaryReferenceAssetUri || '').trim())
  const hasLineart = Boolean(String(asset?.lineartFinalAssetUri || '').trim())
  if (hasPrimary && hasLineart) return { tone: 'locked', label: '已锁定' }
  if (hasPrimary) return { tone: 'lineart', label: '待锁定' }
  if (hasPromptDraft) return { tone: 'draw', label: '待抽卡' }
  return { tone: 'draft', label: '待起草' }
}

// 出图管理总览：四段状态点（提示词→主参考→姿态/状态变体→线稿）
// 口径：全部从 plan 资产字段与提示词草稿派生（done 绿 / partial 黄 / todo 灰）
export type AssetStageKey = 'prompt' | 'ref' | 'pose' | 'lineart'
export type AssetStageTone = 'done' | 'partial' | 'todo'
export function assetFiveStagesOf(asset: any, promptDrafts: Record<string, any> | undefined): { key: AssetStageKey; label: string; tone: AssetStageTone }[] {
  const aid = String(asset?.id || '').trim()
  const d = (promptDrafts && promptDrafts[aid]) || {}
  const zhOk = Boolean(String(d.promptZh || '').trim())
  const enOk = Boolean(String(d.promptEn || '').trim())
  const promptTone: AssetStageTone = zhOk && enOk ? 'done' : zhOk || enOk ? 'partial' : 'todo'
  const hasPrimary = Boolean(String(asset?.primaryReferenceAssetUri || '').trim() || String(asset?.primaryReferenceAssetId || '').trim())
  const hasCandidates = Array.isArray(asset?.generatedRefs) && asset.generatedRefs.length > 0
  const refTone: AssetStageTone = hasPrimary ? 'done' : hasCandidates ? 'partial' : 'todo'
  const poseCount = (Array.isArray(asset?.poseVariants) ? asset.poseVariants.length : 0) + (Array.isArray(asset?.stateVariants) ? asset.stateVariants.length : 0)
  const poseReqCount = Array.isArray(asset?.poseRequirements) ? asset.poseRequirements.length : 0
  const poseTone: AssetStageTone = poseCount > 0 && (poseReqCount === 0 || poseCount >= poseReqCount) ? 'done' : poseCount > 0 ? 'partial' : 'todo'
  const lineartTone: AssetStageTone = String(asset?.lineartFinalAssetUri || '').trim() ? 'done' : String(asset?.lineartHintAssetUri || '').trim() ? 'partial' : 'todo'
  return [
    { key: 'prompt', label: '提示词', tone: promptTone },
    { key: 'ref', label: '主参考', tone: refTone },
    { key: 'pose', label: '姿态', tone: poseTone },
    { key: 'lineart', label: '线稿', tone: lineartTone }
  ]
}

// 卡片图：主参考（透明底垫深色棋盘格）→ 最新候选 → 空（灰占位）
function assetCardImageOf(asset: any, projectId: string): string {
  const primary = String(asset?.primaryReferenceAssetUri || '').trim()
  if (primary) return toProjectAssetUrl(projectId, primary)
  const latest = buildDisplayedReferenceCandidates(asset).all[0]
  const latestUrl = String(latest?.url || '').trim()
  if (latestUrl) return toRuntimeUrl(latestUrl)
  const latestPath = String(latest?.assetPath || '').trim()
  if (latestPath) return toProjectAssetUrl(projectId, latestPath)
  return ''
}

// 重抽/单张重出的生成参数（ScenePoseWorkbench 传入；类型与 components/pose/ScenePoseWorkbench 内 PoseGenOpts 同构）
export type PoseGenOptsForRedraw = {
  posePrompt: string
  posePromptZh?: string
  posePromptEn?: string
  negativePromptZh?: string
  negativePromptEn?: string
  ipadapter?: { enabled: boolean; weight: number; startAt: number; endAt: number }
}

export default function StoryboardLockWorkspace(props: {
  open: boolean
  projectId?: string
  value: AiBackgroundRequest & { entitySpec?: string; storyBibleJson?: string; globalPromptZh?: string; globalNegativePromptZh?: string }
  assetPlan: {
    assets: any[]
    scenes: any[]
    summary: { assetCount: number; sceneCount: number; refRequiredCount: number; refReadyCount: number; refMissingCount: number }
  } | null
  assetPromptDrafts?: Record<string, AssetPromptDraft>
  translatingScope?: string
  translateCountdownSec?: number
  promptOpBusy?: boolean
  assetPlanBusy: boolean
  assetGeneratingId?: string
  assetAnalyzingId?: string
  assetOptimizingId?: string
  assetSelectingId?: string
  assetLineartId?: string
  assetGallery?: { assetId: string; assetName: string; items: StoryAssetGalleryEntry[] } | null
  assetGalleryBusy: boolean
  assetGalleryDeletingPaths?: string[]
  assetConfirmReady: boolean
  assetConfirmSummary: string
  continuityReady: boolean
  continuitySummary: string
  busyEntity: boolean
  openChecks: {
    checking: boolean
    ok: boolean
    serverOk: boolean
    promptOk: boolean
    imageOk: boolean
    continuityBindingsOk: boolean
    summary: string
    // 2026-09-02 配置 drawer 只读摘要用（ComposeStudio 侧 StoryboardOpenCheckState 全量下发，此处声明为可选）
    promptProvider?: string
    promptModel?: string
    imageProvider?: string
    imageModel?: string
    // 2026-11-10：体检定论时间——用于区分"未跑/进行中"与"已出结果"，步骤钳制只在有定论失败后生效
    checkedAt?: string
  }
  logs: string[]
  error?: string
  onClose: () => void
  onReloadProject?: () => void
  // 主动保存（父组件包一层 saveCurrent，返回是否成功；失败经 props.error 横幅显示）
  onSave?: () => Promise<boolean>
  onRunOpenChecks: () => void
  onGenerateEntity: () => void
  onBuildAssetPlan: () => void
  onGenerateAssetRef: (assetId: string, batchSize?: number) => void
  onGenerateAllMissingAssetRefs: () => void
  onAnalyzeAssetRef: (assetId: string) => void
  onOptimizeAssetRef: (assetId: string) => void
  // 2026-11-06 支持按资产子集生成（背景中心地点模板/背景元素页签复用同一链）；空参=全部缺失项
  onEnhanceAllPrompts?: (onlyAssetIds?: string[]) => void
  // K 波（2026-10-27 姿态需求定义前移蓝图）：姿势区「去蓝图编辑需求」链——关向导回蓝图层
  onGotoBlueprint?: () => void
  onDraftGlobalPromptZh?: () => void
  enhanceAllProgress?: { current: number; total: number; busy: boolean }
  // 2026-10-26 缺陷 B：批量增强逐项结果明面化（失败名单+人话原因+一键重试）
  enhanceAllSummary?: { done: number; failures: Array<{ assetId: string; label: string; reason: string }> } | null
  onRetryFailedEnhance?: () => void
  // 2026-10-26 缺陷 C：提示词草稿脏态（向导保存按钮高亮激活感知）
  promptDraftsDirty?: boolean
  // 2026-10-07 一键翻译全部中文稿（enhance 内联翻译会静默兜底，此为显式可观测通道）
  translateAllProgress?: { current: number; total: number; busy: boolean }
  onTranslateAllPrompts?: () => void
  globalDraftBusy?: boolean
  // 2026-08-29 提示词审核闸（中文稿确认/英文稿批准）：服务端项目数据持久化，浏览器存储不再作准
  promptGate?: { zhConfirmed?: boolean; enApproved?: boolean }
  onPromptGateChange?: (patch: { zhConfirmed?: boolean; enApproved?: boolean }) => void
  onSelectAssetRef: (assetId: string, assetPath: string) => void
  onGenerateAssetLineart: (assetId: string) => void
  onOpenAssetGallery: (assetId: string) => void
  onCloseAssetGallery: () => void
  onSelectAssetGalleryPrimary: (assetId: string, assetPath: string) => void
  onDeleteAssetGalleryItems: (assetId: string, assetPaths: string[]) => void
  onDeleteAssetGalleryItem: (assetId: string, assetPath: string) => void
  onDeleteAssetFromPlan: (assetId: string) => void
  onConfirmAssetPlan: () => void
  // 背景中心的场景图与地点模板共用资产计划；场景生产仍由 ComposeStudio 注入的共享组件负责。
  sceneBoard?: React.ReactElement<{ focusSceneId?: string; onEditSceneAssets?: (sceneId: string) => void }>
  onChangeGlobalPromptZh: (value: string) => void
  onChangeGlobalPromptEn: (value: string) => void
  onTranslateGlobalPrompt: () => void
  onChangeGlobalNegativePromptZh: (value: string) => void
  onChangeGlobalNegativePromptEn: (value: string) => void
  onTranslateGlobalNegativePrompt: () => void
  // 2026-10-07 全局提示词评审接入第 4 步（链路此前只挂在分镜出图弹窗，向导侧无入口）
  globalPromptReview?: any
  globalPromptReviewBusy?: boolean
  onReviewGlobalPrompt?: () => void
  onApplyGlobalPromptReview?: () => void
  onChangeAssetPrompt: (assetId: string, patch: AssetPromptDraft) => void
  onTranslateAssetPromptPositive: (assetId: string) => void
  onTranslateAssetPromptNegative: (assetId: string) => void
  // ============ 2026-09-01 姿势变体（出图统一管理在锁定向导，摆放属性降级为纯消费端） ============
  // 2026-11-01 场景姿态/状态变体两段抽至 components/pose/ScenePoseWorkbench（定义 UI 已前移蓝图，向导侧只执行）
  poseGeneratingId?: string
  poseDrawProgress?: { done: number; total: number } | null
  poseReviewingId?: string
  poseLockingKey?: string
  poseReqBusyId?: string
  // 深度回跳聚焦（蓝图「管理」入口）：定位到具体资产的场景姿态区，可指定场景+需求
  poseFocus?: { assetId: string; sceneId?: string; reqId?: string } | null
  // 2026-09-01 剧情感知：该资产关联场景选项（场景序号+名称，节点正文由 ComposeStudio 侧查 doc.story）
  poseSceneOptionsFor?: (assetId: string) => { sceneId: string; label: string }[]
  // 2026-09-01 姿势图片管理画廊（开关状态在 ComposeStudio，复用主参考画廊 overlay 模式）
  poseGalleryAssetId?: string
  onPoseGalleryOpen?: (assetId: string) => void
  onPoseGalleryClose?: () => void
  // 2026-09-02 姿势草稿持久化（高级参数/选中场景等执行态落 plan 资产 poseDraft，不逐键入）
  onPoseDraftSave?: (assetId: string, draft: { promptZh: string; promptEn: string; negativePromptZh: string; negativePromptEn: string; sceneId: string; ipadapterOn: boolean; ipadapterWeight: number; ipadapterStartAt: number; ipadapterEndAt: number; promptZhSource?: string }) => void
  onPoseRequirementGenerate?: (assetId: string, reqId: string, count?: 1 | 4) => void
  onPoseRequirementsBatchGenerate?: (assetId: string) => void
  onPoseReviewAll?: (assetId: string) => void
  onPoseRedraw?: (assetId: string, assetPath: string, opts: PoseGenOptsForRedraw) => void
  onPoseDeleteCandidate?: (assetId: string, assetPath: string) => void
  onPoseLock?: (assetId: string, assetPath: string, name: string, prompts: { posePrompt: string; posePromptZh?: string; posePromptEn?: string }, sceneId?: string) => Promise<{ ok: boolean; projectAssetId?: string; applied?: boolean; message?: string }>
  onPoseDeleteVariant?: (assetId: string, variantId: string) => Promise<{ ok: boolean; message?: string }>
  // ============ 2026-10-27 R 波：标准系三视图（角色专属）生成/锁定 ============
  modelSheetBusyId?: string
  onModelSheetGenerate?: (assetId: string, views?: ('front' | 'side' | 'back')[], mode?: 'sheet' | 'per-view') => void
  onModelSheetLock?: (assetId: string, view: 'front' | 'side' | 'back') => void
  // Z 波：sheet 栏序人工指定（pendingCells 三栏 → views）
  onModelSheetAssign?: (assetId: string, assignments: Record<string, 'front' | 'side' | 'back'>) => void
  // ============ 2026-09-16 道具状态变体（道具/地点等非角色资产专属）：状态需求提取 + 单状态生成（服务端全链写 stateVariants） ============
  propStateBusyId?: string
  propStateGenKey?: string
  onPropStatesExtract?: (assetId: string) => void
  onPropStateGenerate?: (assetId: string, state: { stateKey: string; label: string; description?: string }) => void
  // ============ 2026-10-06 第 3 步场景视图：跨场景姿态/状态批量分析 ============
  sceneAnalysisBusy?: boolean
  sceneAnalysisStage?: string
  sceneAnalysisElapsedMs?: number
  onRunSceneElementAnalysis?: () => void
}) {
  if (!props.open) return null
  const assetPlan = props.assetPlan || null
  const planAssets = Array.isArray(assetPlan?.assets) ? assetPlan.assets : []
  const storyBibleReady = Boolean(String((props.value as any)?.storyBibleJson || '').trim())
  const envReady = Boolean(props.openChecks?.ok)
  // 体检"有定论且未通过"才算失败：未跑/进行中不判失败——异步结果返回前 maxUnlockedStep 短暂偏低，
  // 据此钳制步骤会误降级（与下方"打开对齐"注释同语义）。
  const envFailed = Boolean(props.openChecks?.checkedAt) && !props.openChecks?.checking && !envReady
  // 2026-08-28：就绪计数只统计 ref_required 资产（prompt_only 资产不需要参考图，其主参考/线稿不应计入门槛）
  const primaryReadyCount = planAssets.filter((asset) => String(asset?.renderStrategy || '').trim() === 'ref_required' && String(asset?.primaryReferenceAssetUri || '').trim()).length
  const lineartReadyCount = planAssets.filter((asset) => String(asset?.renderStrategy || '').trim() === 'ref_required' && String(asset?.lineartFinalAssetUri || '').trim()).length
  const unlockedCount = planAssets.filter((asset) => String(asset?.renderStrategy || '').trim() === 'ref_required').filter((asset) => !String(asset?.primaryReferenceAssetUri || '').trim() || !String(asset?.lineartFinalAssetUri || '').trim()).length
  const missingBatchCount = planAssets.filter((asset) => String(asset?.renderStrategy || '').trim() === 'ref_required').filter((asset) => {
    const primary = String(asset?.primaryReferenceAssetUri || '').trim()
    const batch = Array.isArray(asset?.latestReferenceBatch) ? asset.latestReferenceBatch : []
    const refs = Array.isArray(asset?.generatedRefs) ? asset.generatedRefs : []
    return !primary && batch.length === 0 && refs.length === 0
  }).length
  const configuredLoras = Array.isArray((props.value as any)?.loras) ? (props.value as any).loras.map((x: any) => String(x || '').trim()).filter(Boolean) : []
  const [logsExpanded, setLogsExpanded] = React.useState(true) // 2026-10-06 默认展开：用户要求执行逻辑与计时可见（资产计划分配明细等）
  const [globalPromptsExpanded, setGlobalPromptsExpanded] = React.useState(true) // 2026-08-28：默认展开——确认/批准闸与全局稿编辑框必须一眼可见
  const [storyBibleExpanded, setStoryBibleExpanded] = React.useState(false)
  const [gallerySelectedPaths, setGallerySelectedPaths] = React.useState<string[]>([])
  const promptOpBusy = Boolean(props.promptOpBusy)
  const translateCountdownSec = Number(props.translateCountdownSec || 0)
  const translateCountdownLabel = translateCountdownSec > 0 ? ` ${translateCountdownSec}s` : ''
  const storyBibleSummary = summarizeStoryBible(String((props.value as any)?.storyBibleJson || ''))

  // 2026-10-07 背景锚点事物（prompt_only/optional_ref，多为地点）：不出立绘、不参与提示词闸
  const backgroundAnchorAssets = planAssets.filter((a) => {
    const s = String(a?.renderStrategy || '').trim()
    return s !== '' && s !== 'ref_required'
  })
  const promptMissingCount = planAssets.filter((asset) => {
    const id = String(asset?.id || '').trim()
    return !String((props.assetPromptDrafts?.[id]?.promptZh || '')).trim()
  }).length
  const promptGeneratedCount = planAssets.length - promptMissingCount

  // ============ 2026-10-06 第 3 步场景主视图：场景→元素分组 + 每元素跨场景姿态/状态预演 ============
  // 数据源全部来自 plan（scenes 列表 + 资产 sceneIds + 资产上已持久化的 poseRequirements/stateRequirements），无新增接口
  const [planViewMode, setPlanViewMode] = React.useState<'scenes' | 'assets'>('scenes')
  const planScenes: any[] = Array.isArray(assetPlan?.scenes) ? assetPlan.scenes : []
  const knownSceneIds = new Set(planScenes.map((s) => String(s?.sceneId || '').trim()).filter(Boolean))
  const assetsBySceneId = new Map<string, any[]>()
  const unassignedPlanAssets: any[] = []
  for (const asset of planAssets) {
    const sids = (Array.isArray(asset?.sceneIds) ? asset.sceneIds : []).map((x: any) => String(x || '').trim()).filter(Boolean)
    const valid = sids.filter((sid: string) => knownSceneIds.size === 0 || knownSceneIds.has(sid))
    if (!valid.length) {
      unassignedPlanAssets.push(asset)
      continue
    }
    for (const sid of valid) {
      const list = assetsBySceneId.get(sid) || []
      list.push(asset)
      assetsBySceneId.set(sid, list)
    }
  }
  // 元素在指定场景的姿态（角色）/状态（道具·地点）行：未提取过显示「未分析」，提取过但该场景无记录显示「—」
  const sceneElementStateLine = (asset: any, sceneId: string): string => {
    if (String(asset?.category || '') === 'character') {
      if (!Array.isArray(asset?.poseRequirements)) return '姿态：未分析'
      const hit = asset.poseRequirements.find((r: any) => String(r?.sceneId || '').trim() === sceneId)
      if (!hit) return '姿态：—'
      const parts = [hit.pose, hit.view, hit.action, hit.expression].map((x: any) => String(x || '').trim()).filter(Boolean)
      return `姿态：${parts.join('·') || '—'}`
    }
    const mergeName = String(asset?.stateMergeInto?.containerName || '').trim()
    if (mergeName) return `状态：已并入 ${mergeName}`
    if (!Array.isArray(asset?.stateRequirements) && !asset?.stateCheckedAt) return '状态：未分析'
    const stateList = Array.isArray(asset?.stateRequirements) ? asset.stateRequirements : []
    const labels = stateList
      .filter((s: any) => (Array.isArray(s?.sceneIds) ? s.sceneIds : []).map((x: any) => String(x || '').trim()).includes(sceneId))
      .map((s: any) => String(s?.label || s?.stateKey || '').trim())
      .filter(Boolean)
    const stateTxt = labels.length ? labels.join('、') : (stateList.length > 0 ? '—' : '无变化')
    // 2026-10-06 导演全量分析：叠加本场景使用/呈现方式（如"穿着"/"手持对打"）
    const usageHit = (Array.isArray(asset?.sceneUsages) ? asset.sceneUsages : []).find((u: any) => String(u?.sceneId || '').trim() === sceneId)
    const usageTxt = usageHit
      ? ` · ${String(usageHit.usage || '').trim()}${String(usageHit?.note || '').trim() ? `（${String(usageHit.note).trim()}）` : ''}`
      : ''
    return `状态：${stateTxt}${usageTxt}`
  }
  const assetAnalysisSummary = (asset: any): string => {
    if (String(asset?.category || '') === 'character') {
      return Array.isArray(asset?.poseRequirements) ? ` · 姿态 ${asset.poseRequirements.length} 条` : ' · 姿态未分析'
    }
    const mergeName = String(asset?.stateMergeInto?.containerName || '').trim()
    if (mergeName) return ` · 已并入 ${mergeName}`
    if (!Array.isArray(asset?.stateRequirements) && !asset?.stateCheckedAt) return ' · 状态未分析'
    const n = Array.isArray(asset?.stateRequirements) ? asset.stateRequirements.length : 0
    return n > 0 ? ` · 状态 ${n} 条` : ' · 无状态变化'
  }
  // 2026-10-07 导演层可见：构图需求单（plan.scenes[].composition）逐元素摆位规格+布场说明+原文依据
  const directorItemFor = (scene: any, asset: any): any => {
    const items = Array.isArray(scene?.composition?.items) ? scene.composition.items : []
    return items.find((it: any) => String(it?.subjectId || '').trim() === String(asset?.id || '').trim()) || null
  }
  const directorLineOf = (it: any): string => {
    if (!it) return ''
    const pos = `x ${Math.round(Number(it.x || 0) * 100)}% · y ${Math.round(Number(it.y || 0) * 100)}% · 大小 ${Number(it.scale || 1)}x${it.flipH ? ' · 水平翻转' : ''}${it.stateKey ? ` · 状态 ${String(it.stateKey)}` : ''}`
    const blocking = String(it?.blocking || '').trim()
    return blocking ? `${blocking}（${pos}）` : pos
  }
  // 2026-10-07 日志修复：①props.logs 是最新优先数组，此前 slice(-20) 截到的是最旧 20 条（新活动全看不见）；
  // ②打开时载入项目任务历史（跨会话可见——API/其他会话驱动的操作不再"日志不全"）
  const sessionLogLines = (props.logs || []).slice(0, 40).reverse()


  // ============ 分步向导（2026-08-26 界面优化：信息分步、门禁可见、每步一事） ============
  // 步骤与生产序对齐（2026-08-26 用户修正：提示词必须在抽卡出图之前）：
  // ①环境体检 ②Story Bible ③资产计划 ④全局与事物提示词（中文稿→审核→翻译→批准） ⑤参考图与锁定 ⑥线稿锁定 ⑦完成锁定
  // 2026-08-26 向导状态按项目持久化（用户指令：刷新/重开不能丢失正在操作的提示词阶段与审核闸状态）
  const wizardStorageKey = String(props.projectId || '').trim() ? `talkscene.lockWorkspace.wizard.${String(props.projectId || '').trim()}` : ''
  // 2026-11-02 用户裁决：缓冲上次打开位置——视图（卡片总览/步骤模式）、场景背景维度、筛选，重开回到上次位置而非默认页
  const readPersistedWizard = (): { step: number; zh: boolean; en: boolean; view?: 'grid' | 'steps'; scope?: 'assets' | 'scenes'; fd?: 'all' | 'todo' | 'done'; fc?: 'all' | 'character' | 'prop' | 'location' } | null => {
    if (!wizardStorageKey) return null
    try {
      const raw = localStorage.getItem(wizardStorageKey)
      if (!raw) return null
      const obj = JSON.parse(raw)
      const step = Math.max(1, Math.min(7, Math.floor(Number(obj?.step) || 1)))
      const view = obj?.view === 'grid' || obj?.view === 'steps' ? obj.view : undefined
      const scope = obj?.scope === 'scenes' ? ('scenes' as const) : obj?.scope === 'assets' ? ('assets' as const) : undefined
      const fd = obj?.fd === 'todo' || obj?.fd === 'done' ? obj.fd : undefined
      const fc = ['all', 'character', 'prop', 'location'].includes(String(obj?.fc)) ? obj.fc : undefined
      return { step, zh: Boolean(obj?.zh), en: Boolean(obj?.en), view, scope, fd, fc }
    } catch {
      return null
    }
  }
  const persistedWizardRef = React.useRef<{ step: number; zh: boolean; en: boolean; view?: 'grid' | 'steps'; scope?: 'assets' | 'scenes'; fd?: 'all' | 'todo' | 'done'; fc?: 'all' | 'character' | 'prop' | 'location' } | null | undefined>(undefined)
  if (persistedWizardRef.current === undefined) persistedWizardRef.current = readPersistedWizard()
  const restoredWizard = persistedWizardRef.current || null
  const [wizardStep, setWizardStep] = React.useState(() => restoredWizard?.step || 1)
  // 主动保存：保存中禁用按钮；成功后显示 3s 内联成功条（吸附头部内，非系统弹窗）
  const [saveBusy, setSaveBusy] = React.useState(false)
  const [savedAt, setSavedAt] = React.useState('')
  React.useEffect(() => {
    if (!savedAt) return undefined
    const t = window.setTimeout(() => setSavedAt(''), 3000)
    return () => window.clearTimeout(t)
  }, [savedAt])
  const handleSave = async () => {
    if (!props.onSave || saveBusy) return
    setSaveBusy(true)
    try {
      const ok = await props.onSave()
      if (ok !== false) setSavedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
      // ok === false：失败信息由父组件 setError → props.error 横幅显示
    } finally {
      setSaveBusy(false)
    }
  }
  // 提示词审核闸（UI 级）：中文稿确认 → 才允许翻译；英文稿批准 → 才允许进入出图/抽卡
  // 2026-08-29：状态改为服务端项目数据持久化（props.promptGate），浏览器 localStorage 仅作冗余记录
  const promptZhConfirmed = Boolean(props.promptGate?.zhConfirmed)
  const promptEnApproved = Boolean(props.promptGate?.enApproved)
  const [promptGateHint, setPromptGateHint] = React.useState('')
  // 确认中文稿前校验（2026-09-10）：全局正/负向 + 每个事物的中文正向/反向都必须有内容——
  // 与本步"先写中文、全部先生成中文稿"的流程语义一致，防止空稿确认→翻译出垃圾英文→出图错误。
  const missingZhPromptItems = (): string[] => {
    const missing: string[] = []
    const v = props.value as any
    if (!String(v?.globalPromptZh || '').trim()) missing.push('全局正向中文稿')
    if (!String(v?.globalNegativePromptZh || '').trim()) missing.push('全局负向中文稿')
    for (const asset of planAssets) {
      // 2026-10-07 背景锚点事物（不出立绘）不要求提示词稿，与第 4 步列表收窄一致
      const strategy = String(asset?.renderStrategy || '').trim()
      if (strategy && strategy !== 'ref_required') continue
      const aid = String(asset?.id || '').trim()
      const draft = ((props.assetPromptDrafts && props.assetPromptDrafts[aid]) || {}) as any
      const name = String(asset?.name || aid || '未命名')
      if (!String(draft.promptZh || '').trim()) missing.push(`${name} 正向中文稿`)
      if (!String(draft.negativePromptZh || '').trim()) missing.push(`${name} 反向中文稿`)
    }
    return missing
  }
  const togglePromptZhConfirmed = () => {
    if (promptZhConfirmed) {
      setPromptGateHint('')
      props.onPromptGateChange?.({ zhConfirmed: false })
      return
    }
    const missing = missingZhPromptItems()
    if (missing.length > 0) {
      setPromptGateHint(`还不能确认中文稿：${missing.slice(0, 4).join('、')}${missing.length > 4 ? ` 等 ${missing.length} 项` : ''}为空。可先点「AI 生成中文全局稿 / AI 生成全部事物中文提示词」，或从「公共提示词」插入补齐。`)
      return
    }
    setPromptGateHint('')
    props.onPromptGateChange?.({ zhConfirmed: true })
  }
  const togglePromptEnApproved = () => { if (promptZhConfirmed) { setPromptGateHint(''); props.onPromptGateChange?.({ enApproved: !promptEnApproved }) } }
  const refRequiredCount = planAssets.filter((asset) => String(asset?.renderStrategy || '').trim() === 'ref_required').length
  // 2026-08-30 用户修正：第 7 步是「完成锁定」（参考图+线稿全部锁定到位），不是「完成出图」；
  // 场景出图是锁定完成后的独立阶段。
  const refLockReady = refRequiredCount === 0 || primaryReadyCount >= refRequiredCount
  const lineartLockReady = refRequiredCount === 0 || lineartReadyCount >= refRequiredCount
  // 2026-10-27 用户裁决：原 5/6/7 合并——5=出图管理（主参考+标准系+姿态+线稿逐元素工作区），6=完成锁定（总账确认）
  const wizardSteps = [
    { n: 1, label: '环境体检', ready: envReady },
    { n: 2, label: 'Story Bible', ready: storyBibleReady },
    { n: 3, label: '资产计划', ready: planAssets.length > 0 },
    { n: 4, label: '全局与事物提示词', ready: promptZhConfirmed && promptEnApproved },
    { n: 5, label: '出图管理', ready: refLockReady && lineartLockReady },
    { n: 6, label: '完成锁定', ready: refLockReady && lineartLockReady }
  ]
  const firstNotReady = wizardSteps.find((s) => !s.ready && s.n < 6)?.n ?? 6
  const maxUnlockedStep = firstNotReady
  const gotoStep = (n: number) => {
    if (n <= maxUnlockedStep) setWizardStep(n)
  }
  const stepGateHint = (n: number): string => {
    switch (n) {
      case 1: return envReady ? '' : '环境体检未通过：请按检查结果修复（ComfyUI 在线、模型与设置就绪）后重新体检'
      case 2: return storyBibleReady ? '' : '先生成 Story Bible（角色/道具/地点锁定前置数据）'
      case 3: return planAssets.length > 0 ? '' : '先生成资产计划'
      case 4: return promptEnApproved ? '' : (promptZhConfirmed ? '中文稿已确认，请执行翻译并批准英文稿' : '请先完成并确认中文提示词稿（确认后才能翻译）')
      case 5:
        if (!(refRequiredCount === 0 || primaryReadyCount >= refRequiredCount)) return `还有 ${Math.max(0, refRequiredCount - primaryReadyCount)} 个必要事物未锁定主参考`
        if (!(refRequiredCount === 0 || lineartReadyCount >= refRequiredCount)) return '还有资产的线稿未生成'
        return ''
      default: return ''
    }
  }

  // AI 任务进度订阅：优先 SSE 推送（服务端任务台账/审核/总账变化即推信号，按需重拉），
  // 服务端不支持或连不上时回退 1.5s 轮询；两种路径首轮都全量拉一次保证首屏一致。
  const [aiTasks, setAiTasks] = React.useState<AiTaskProgress[]>([])
  const [aiCoverage, setAiCoverage] = React.useState<AiCoverage | null>(null)
  const [pendingReviews, setPendingReviews] = React.useState<ImageReviewRecord[]>([])
  const [reviewBusyIds, setReviewBusyIds] = React.useState<string[]>([])
  const [renderAllBusy, setRenderAllBusy] = React.useState(false)
  const reloadedTaskIdsRef = React.useRef<Set<string>>(new Set())
  const projectId = String(props.projectId || '').trim()

  React.useEffect(() => {
    if (!props.open || !projectId) return undefined
    let stopped = false
    const loadTasks = async () => {
      try {
        const tasks = await listProjectAiTasks(projectId)
        if (stopped) return
        setAiTasks(tasks)
        // 批量渲染/线稿/参考图抽卡完成后自动刷新项目数据（场景图、线稿与抽卡候选都会写回计划）
        // 2026-11-10：参考图抽卡纳入——跨会话/刷新后发起的抽卡完成时，本面板候选就地回填
        for (const t of tasks) {
          const shouldReload = t.kind === 'story.scenes.render_all'
            || (t.kind === 'story.asset.lineart' && t.done && !t.error)
            || (t.kind === 'story.asset.reference_batch' && t.done && !t.error)
          if (shouldReload && !reloadedTaskIdsRef.current.has(t.taskId)) {
            reloadedTaskIdsRef.current.add(t.taskId)
            props.onReloadProject?.()
          }
        }
      } catch (_) { /* 拉取失败忽略，下个信号/轮询再试 */ }
    }
    const loadReviews = async () => {
      const reviews = await listImageReviewsAi(projectId, 'pending').catch(() => [] as ImageReviewRecord[])
      if (!stopped) setPendingReviews(reviews)
    }
    const loadCoverage = async () => {
      const coverage = await listProjectAiCoverage(projectId).catch(() => null)
      if (!stopped) setAiCoverage(coverage)
    }
    const pull = async () => { await Promise.all([loadTasks(), loadReviews(), loadCoverage()]) }
    void pull()
    let timer: number | undefined
    const startPolling = () => {
      if (timer !== undefined) return
      timer = window.setInterval(() => { void pull() }, 1500)
    }
    const dispose = subscribeProjectAiEvents(projectId, {
      tasks: () => { void loadTasks() },
      reviews: () => { void loadReviews() },
      coverage: () => { void loadCoverage() },
      onUnavailable: startPolling
    })
    if (!dispose) startPolling()
    return () => {
      stopped = true
      if (timer !== undefined) window.clearInterval(timer)
      dispose?.()
    }
  }, [props.open, projectId])

  const reviewPhaseLabel = (phase: string) => {
    if (phase === 'pre_generate') return '出图前审核'
    if (phase === 'lock_confirm') return '锁定确认'
    if (phase === 'scene_bind') return '场景图绑定'
    return phase || '审核'
  }

  const decideReview = async (review: ImageReviewRecord, approved: boolean) => {
    if (!projectId || reviewBusyIds.includes(review.reviewId)) return
    setReviewBusyIds((prev) => [...prev, review.reviewId])
    try {
      if (approved) await approveImageReviewAi(projectId, review.reviewId)
      else await rejectImageReviewAi(projectId, review.reviewId)
      const reviews = await listImageReviewsAi(projectId, 'pending').catch(() => [] as ImageReviewRecord[])
      setPendingReviews(reviews)
      if (approved && (review.phase === 'lock_confirm' || review.phase === 'scene_bind')) props.onReloadProject?.()
    } catch (e: any) {
      void dlgAlert(`审核操作失败：${e && e.message ? e.message : String(e)}`)
    } finally {
      setReviewBusyIds((prev) => prev.filter((x) => x !== review.reviewId))
    }
  }

  const approveAllSceneBinds = async () => {
    if (!projectId) return
    try {
      const res = await approveAllImageReviewsAi(projectId, 'scene_bind')
      void dlgAlert(`批量批准完成：${res.okCount}/${res.total}`)
      const reviews = await listImageReviewsAi(projectId, 'pending').catch(() => [] as ImageReviewRecord[])
      setPendingReviews(reviews)
      props.onReloadProject?.()
    } catch (e: any) {
      void dlgAlert(`批量批准失败：${e && e.message ? e.message : String(e)}`)
    }
  }

  const visibleTasks = React.useMemo(() => {
    const now = Date.now()
    return aiTasks.filter((t) => !t.done || now - Date.parse(t.updatedAt) < 20000).slice(0, 4)
  }, [aiTasks])
  const renderAllActive = aiTasks.some((t) => t.kind === 'story.scenes.render_all' && !t.done)

  const taskKindLabel = (kind: string) => {
    if (kind === 'story.lock_test') return '锁定测试'
    if (kind === 'story.scene.render') return '场景渲染'
    if (kind === 'story.scenes.render_all') return '批量渲染'
    if (kind === 'story.scenes.batch') return '批量渲染队列'
    if (kind === 'story.scene.layered_produce') return '分层出图'
    if (kind === 'story.completeness_check') return '完整度核实'
    if (kind === 'story.asset.reference_batch') return '参考图抽卡'
    if (kind === 'story.asset.lineart') return '线稿生成'
    if (kind === 'story.prop.state_variant') return '状态变体生成'
    return kind || '任务'
  }
  const taskStageLabel = (task: AiTaskProgress) => {
    const stageMap: Record<string, string> = {
      queued: '排队中', preparing: '准备中', generating: '生成中', reviewing: '评审中',
      loading_refs: '加载参考图', writing: '写回文档', rendering: '渲染中', walking: '走查中',
      preprocessing: '预处理中', redrawing: '重绘中', ai_review: 'AI 评审中',
      pose_reuse: '复用姿势资产', pose_sprite: '生成姿势绿幕图', pose_cutout: '姿势抠图',
      prop_sprite: '生成道具精灵', prop_cutout: '道具抠图',
      background_render: '重画场景背景', background_bind: '绑定场景背景', placements: '写入摆位',
      state_composite: '合成状态图', state_sprite: '生成状态绿幕图', state_cutout: '状态抠图', state_review: '状态评审',
      waiting_review: '待审核', blocked: '已阻断',
      passed: '已通过', failed: '未通过', done: '完成', partial: '部分完成',
      done_with_errors: '完成（有失败项）', error: '出错', interrupted: '已中断'
    }
    const stageText = stageMap[task.stage] || task.stage || '进行中'
    const progressText = task.total > 0 ? ` ${task.current}/${task.total}` : ''
    return `${stageText}${progressText}`
  }

  // 任务历史日志行（跨会话可见）：由 aiTasks 轮询状态派生，最新 12 条按时间正序
  const taskHistoryLines = aiTasks
    .slice()
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    .slice(-12)
    .map((t) => `[${String(t.createdAt || '').slice(11, 19)}] ${taskKindLabel(String(t.kind || ''))}：${String(t.message || '').trim()}（${taskStageLabel(t)}）`)

  const runRenderAllScenes = async () => {
    if (!projectId || renderAllBusy || renderAllActive) return
    setRenderAllBusy(true)
    try {
      const res = await renderAllStoryScenesAi(projectId, {})
      if (!res.taskId && res.message) void dlgAlert(res.message)
      const tasks = await listProjectAiTasks(projectId).catch(() => [])
      setAiTasks(tasks)
    } catch (e: any) {
      void dlgAlert(`批量渲染启动失败：${e && e.message ? e.message : String(e)}`)
    } finally {
      setRenderAllBusy(false)
    }
  }

  React.useEffect(() => {
    setGallerySelectedPaths([])
  }, [props.assetGallery?.assetId])

  // 打开时落到第一个未完成步骤（只对齐一次，不干扰后续手动切换）；
  // 2026-08-26：有持久化记录时优先恢复离开时的步骤，仅当超出已解锁范围才回退到门禁步
  const wizardSnappedRef = React.useRef(false)
  React.useEffect(() => {
    if (!props.open || wizardSnappedRef.current) return
    wizardSnappedRef.current = true
    if (restoredWizard) return // 恢复离开时的步骤；各面板自身按项目数据与审核闸门禁，无需强制对齐（异步体检完成前 maxUnlockedStep 会短暂偏低，对齐会误降级）
    setWizardStep(firstNotReady)
  }, [props.open, firstNotReady])

  // 2026-11-10 用户裁决：体检明确未通过时向导必须停在第 1 步（覆盖"上次打开位置"恢复，不得落到出图管理）；
  // 只在体检有定论失败后钳制——未跑/进行中不动当前步（同上：异步结果返回前钳制会误降级）。
  React.useEffect(() => {
    if (!props.open || !envFailed) return
    if (wizardStep > 1) setWizardStep(1)
  }, [props.open, envFailed, wizardStep])

  // 2026-11-10：环境体检面板就地拉起本地服务（ComfyUI 走 Terminal.app 可见窗口；OMLX 走 GUI App）；
  // 拉起后自动重新体检，面板就地转绿，无需手动再点。
  const [comfyLaunchBusy, setComfyLaunchBusy] = React.useState(false)
  const [comfyLaunchNote, setComfyLaunchNote] = React.useState('')
  const launchTool = async (tool: 'omlx' | 'comfyui', label: string) => {
    if (comfyLaunchBusy) return
    setComfyLaunchBusy(true)
    setComfyLaunchNote(`正在拉起 ${label}，就绪最长约 90 秒…`)
    try {
      const res = await launchStudioTool(tool)
      setComfyLaunchNote(res.message || (res.alreadyRunning ? `${label} 已在运行` : `${label} 已启动`))
      props.onRunOpenChecks?.()
    } catch (e) {
      // launch_timeout 时窗口/App 其实已开：保留服务端原文提示，面板自动复检会在就绪后转绿
      setComfyLaunchNote(e instanceof Error ? e.message : String(e))
    } finally {
      setComfyLaunchBusy(false)
    }
  }
  const launchComfyUi = () => launchTool('comfyui', 'ComfyUI（终端可见窗口）')

  // 2026-11-10 用户裁决：体检未通过期间每 7s 自动复检——ComfyUI 经终端拉起（含冷启动慢、按钮超时
  // 但窗口仍在初始化）或外部恢复后，面板就地转绿解锁，不再要求手动刷新页面；通过/关闭即停。
  React.useEffect(() => {
    if (!props.open || !envFailed) return undefined
    const timer = window.setInterval(() => {
      if (props.openChecks?.checking) return // 上一轮未结束跳过，防重入
      props.onRunOpenChecks?.()
    }, 7000)
    return () => window.clearInterval(timer)
  }, [props.open, envFailed, props.openChecks?.checking])

  // 向导状态变化即按项目持久化（刷新后恢复到提示词操作阶段与审核闸状态）

  React.useEffect(() => {
    const allowed = new Set((props.assetGallery?.items || []).map((item) => String(item.assetPath || '').trim()).filter(Boolean))
    setGallerySelectedPaths((prev) => prev.filter((item) => allowed.has(item)))
  }, [props.assetGallery?.items])

  const galleryDeletingSet = React.useMemo(() => new Set((props.assetGalleryDeletingPaths || []).map((item) => String(item || '').trim()).filter(Boolean)), [props.assetGalleryDeletingPaths])

  // ============ 2026-09-01 姿势/状态变体区（2026-11-01 起：两段渲染与本地执行态在 components/pose/ScenePoseWorkbench；
  // 此处仅保留展开态——聚焦回跳/锚点滚动在父级读写；数据本体在 plan 资产上） ============
  const [poseExpanded, setPoseExpanded] = React.useState<Record<string, boolean>>({})
  const [stateExpanded, setStateExpanded] = React.useState<Record<string, boolean>>({})

  // U 波项 4：三视图区主图当前视角（按资产记，默认正面）
  const [sheetFocusByAsset, setSheetFocusByAsset] = React.useState<Record<string, string>>({})
  // Z 波：sheet 栏序人工指定的本地选择态（assetId → {cellIndex: view}）
  const [sheetAssignByAsset, setSheetAssignByAsset] = React.useState<Record<string, Record<string, string>>>({})
  // R 波项 3（2026-10-27）：配方/存为配方/槽位组装的本地 UI 态随定义期 UI 退役一并撤（组装器+配方应用迁至蓝图姿态需求清单）

  // 2026-09-01 姿势图片管理画廊：当前打开的资产（候选 + 已锁定变体两组陈列）
  const poseGalleryAsset = props.poseGalleryAssetId
    ? planAssets.find((a) => String(a?.id || '').trim() === String(props.poseGalleryAssetId || '').trim()) || null
    : null

  // ============ 2026-09-02 事物总览大改版：一级卡片墙 / 二级详情弹层 / 配置 drawer ============
  // 视图模式：未手动切换时跟随确认态（计划已确认→卡片总览，否则步骤向导）；切换按钮只写 override
  const [viewModeOverride, setViewModeOverride] = React.useState<null | 'grid' | 'steps'>(() => restoredWizard?.view || null)
  // 第 5 步：角色/道具在事物卡管理；地点模板与每幕场景图统一收进背景中心。
  const [step5Scope, setStep5Scope] = React.useState<'assets' | 'scenes'>(() => restoredWizard?.scope === 'scenes' ? 'scenes' : 'assets')
  const [sceneFocus, setSceneFocus] = React.useState<{ id: string; requestId: number } | null>(null)

  const viewMode: 'grid' | 'steps' = viewModeOverride || (props.assetConfirmReady ? 'grid' : 'steps')
  const [detailAssetId, setDetailAssetId] = React.useState('')
  const [detailAnchor, setDetailAnchor] = React.useState('')
  const [drawerOpen, setDrawerOpen] = React.useState(false)

  // ============ 2026-09-02 配置 drawer：LoRA 挂载管理 + 提示词预设（直接走 api.ts，与该组件 tasks/reviews 轮询同款直连模式） ============
  const [loraLoading, setLoraLoading] = React.useState(false)
  const [loraError, setLoraError] = React.useState('')
  const [loraAvailable, setLoraAvailable] = React.useState<string[]>([])
  const [loraMounted, setLoraMounted] = React.useState<string[]>([]) // 原始条目 "file:strength[:clip]"（服务端 parseComfyLoras 格式，最多 8 个）
  const [loraAddFile, setLoraAddFile] = React.useState('')
  const [loraAddStrength, setLoraAddStrength] = React.useState(0.7)
  const [loraSaving, setLoraSaving] = React.useState(false)
  const [loraSavedAt, setLoraSavedAt] = React.useState('')
  // ============ 公共提示词库（2026-09-10，跨项目共享：服务端 storage/_config/prompt_library.json） ============
  // 每个提示词输入旁的「公共提示词」按钮打开库弹层：按正/负向筛选插入（中英稿分别进中英栏，按片段去重），
  // 也可把当前输入内容存回库中——库随使用不断增强。
  const [promptLibTarget, setPromptLibTarget] = React.useState<PromptLibTarget | null>(null)
  const [promptLibEntries, setPromptLibEntries] = React.useState<PromptLibraryEntry[]>([])
  const [promptLibBusy, setPromptLibBusy] = React.useState(false)
  const [promptLibHint, setPromptLibHint] = React.useState('')
  const [promptLibSaveName, setPromptLibSaveName] = React.useState('')
  const [promptLibKindFilter, setPromptLibKindFilter] = React.useState<'positive' | 'negative'>('positive')

  const globalPromptLibTarget = (kind: 'positive' | 'negative'): PromptLibTarget => (
    kind === 'positive'
      ? {
          label: '全局正向',
          kind,
          getZh: () => String((props.value as any)?.globalPromptZh || ''),
          getEn: () => String(props.value?.globalPrompt || ''),
          setZh: (v) => props.onChangeGlobalPromptZh(v),
          setEn: (v) => props.onChangeGlobalPromptEn(v)
        }
      : {
          label: '全局负向',
          kind,
          getZh: () => String((props.value as any)?.globalNegativePromptZh || ''),
          getEn: () => String(props.value?.globalNegativePrompt || ''),
          setZh: (v) => props.onChangeGlobalNegativePromptZh(v),
          setEn: (v) => props.onChangeGlobalNegativePromptEn(v)
        }
  )

  const assetPromptLibTarget = (targetAsset: any, kind: 'positive' | 'negative'): PromptLibTarget => {
    const targetAssetId = String(targetAsset?.id || '').trim()
    const assetName = String(targetAsset?.name || targetAssetId || '未命名')
    const draftOf = () => ((props.assetPromptDrafts && props.assetPromptDrafts[targetAssetId]) || {}) as any
    return kind === 'positive'
      ? {
          label: `${assetName} · 正向`,
          kind,
          getZh: () => String(draftOf().promptZh || ''),
          getEn: () => String(draftOf().promptEn || ''),
          setZh: (v) => props.onChangeAssetPrompt(targetAssetId, { promptZh: v }),
          setEn: (v) => props.onChangeAssetPrompt(targetAssetId, { promptEn: v })
        }
      : {
          label: `${assetName} · 反向`,
          kind,
          getZh: () => String(draftOf().negativePromptZh || ''),
          getEn: () => String(draftOf().negativePrompt || ''),
          setZh: (v) => props.onChangeAssetPrompt(targetAssetId, { negativePromptZh: v }),
          setEn: (v) => props.onChangeAssetPrompt(targetAssetId, { negativePrompt: v })
        }
  }

  const openPromptLibrary = (target: PromptLibTarget) => {
    setPromptLibTarget(target)
    setPromptLibKindFilter(target.kind)
    setPromptLibSaveName('')
    setPromptLibHint('')
    setPromptLibBusy(true)
    void (async () => {
      try {
        const entries = await listPromptLibrary()
        setPromptLibEntries(entries)
      } catch (e) {
        setPromptLibHint(`公共提示词库加载失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setPromptLibBusy(false)
      }
    })()
  }

  // 片段合并去重（2026-09-10 修正双向包含）：cur 已含 add → 不动；add 已含 cur → 用更全的 add 替换
  // （否则"默认负向包"再插入"通用负向包"会拼出重复前缀）；两者都不含 → 分隔符拼接。
  const mergePromptFragment = (cur: string, add: string, sep: string): string => {
    const c = String(cur || '').trim()
    const a = String(add || '').trim()
    if (!a) return c
    if (!c) return a
    if (c.includes(a)) return c
    if (a.includes(c)) return a
    return [c, a].join(sep)
  }

  // 插入：中文稿进中文栏、英文稿进英文栏（片段级合并去重；无英文稿时提示「待翻译」不自动调翻译）
  const insertPromptLibEntry = (entry: PromptLibraryEntry) => {
    const target = promptLibTarget
    if (!target) return
    const nextZh = mergePromptFragment(target.getZh(), entry.textZh, '，')
    const nextEn = mergePromptFragment(target.getEn(), entry.textEn, ', ')
    target.setZh(nextZh)
    target.setEn(nextEn)
    setPromptLibTarget({ ...target, getZh: () => nextZh, getEn: () => nextEn })
    setPromptLibHint(`已插入「${entry.name}」${entry.textEn ? '' : '（无英文稿：英文栏待翻译）'}`)
  }

  const saveCurrentToPromptLibrary = async () => {
    const target = promptLibTarget
    if (!target || promptLibBusy) return
    const textZh = target.getZh().trim()
    const textEn = target.getEn().trim()
    if (!textZh && !textEn) {
      setPromptLibHint('当前输入为空，没有可保存的内容')
      return
    }
    setPromptLibBusy(true)
    setPromptLibHint('')
    try {
      const entry = await savePromptLibraryEntry({
        name: promptLibSaveName.trim() || `${target.label}沉淀`,
        kind: target.kind,
        textZh,
        textEn
      })
      setPromptLibEntries((prev) => [...prev, entry])
      setPromptLibSaveName('')
      setPromptLibHint(`已保存到公共提示词库：「${entry.name}」`)
    } catch (e) {
      setPromptLibHint(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPromptLibBusy(false)
    }
  }

  const deletePromptLibEntry = async (id: string) => {
    if (promptLibBusy) return
    setPromptLibBusy(true)
    setPromptLibHint('')
    try {
      const result = await deletePromptLibraryEntryById(id)
      setPromptLibEntries(result.entries)
      setPromptLibHint('已从公共提示词库删除')
    } catch (e) {
      setPromptLibHint(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPromptLibBusy(false)
    }
  }

  React.useEffect(() => {
    if (!drawerOpen) return undefined
    // 打开 drawer 时拉可用 LoRA 列表（ComfyUI models）+ 当前挂载（GET settings）
    let stopped = false
    setLoraLoading(true)
    setLoraError('')
    setLoraSavedAt('')
    void (async () => {
      try {
        const models = await getComfyuiModels().catch((e) => ({ loras: [] as string[], note: e instanceof Error ? e.message : String(e) }))
        const settingsRes = await getStudioSettings()
        if (stopped) return
        if (!models.loras.length) setLoraError(models.note ? `ComfyUI 不在线（${models.note}）` : 'ComfyUI 不在线')
        setLoraAvailable(models.loras)
        const mounted = Array.isArray(settingsRes.settings?.image?.loras) ? (settingsRes.settings!.image!.loras as string[]).map((x) => String(x || '').trim()).filter(Boolean) : []
        setLoraMounted(mounted)
      } catch (e) {
        if (!stopped) setLoraError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!stopped) setLoraLoading(false)
      }
    })()
    return () => { stopped = true }
  }, [drawerOpen])

  const parseLoraEntry = (s: string) => {
    const parts = String(s || '').split(':')
    return { file: String(parts[0] || '').trim(), strength: String(parts[1] ?? '').trim(), clip: String(parts[2] ?? '').trim() }
  }
  const formatLoraEntry = (file: string, strength: string, clip: string) => (clip ? `${file}:${strength}:${clip}` : `${file}:${strength}`)
  const saveLoraList = async () => {
    if (loraSaving) return
    setLoraSaving(true)
    setLoraError('')
    setLoraSavedAt('')
    try {
      // 只改 image.loras，其他设置原样带回（先 GET 再 PUT 整对象；服务端最多解析 8 个）
      const cur = await getStudioSettings()
      const settings = (cur.settings || {}) as any
      const image = { ...(settings.image || {}), loras: loraMounted.slice(0, 8) }
      await saveStudioSettings({ ...settings, image })
      setLoraSavedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
    } catch (e) {
      setLoraError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoraSaving(false)
    }
  }

  const [gridFilterDone, setGridFilterDone] = React.useState<'all' | 'todo' | 'done'>(restoredWizard?.fd || 'all')
  const [gridFilterCat, setGridFilterCat] = React.useState<'all' | 'character' | 'prop'>(() => restoredWizard?.fc === 'character' || restoredWizard?.fc === 'prop' ? restoredWizard.fc : 'all')

  React.useEffect(() => {
    if (!props.open || !wizardStorageKey) return
    try {
      localStorage.setItem(wizardStorageKey, JSON.stringify({
        step: wizardStep,
        zh: promptZhConfirmed,
        en: promptEnApproved,
        // 2026-11-02 上次打开位置缓冲（view=有效视图；scope=出图管理维度；fd/fc=卡片筛选）
        view: viewModeOverride || viewMode,
        scope: step5Scope,
        fd: gridFilterDone,
        fc: gridFilterCat,
        updatedAt: Date.now()
      }))
    } catch { /* 存储不可用时忽略 */ }
  }, [props.open, wizardStorageKey, wizardStep, promptZhConfirmed, promptEnApproved, viewModeOverride, viewMode, step5Scope, gridFilterDone, gridFilterCat])
  const statusRank: Record<AssetLockTone, number> = { draft: 0, draw: 1, lineart: 2, locked: 3 }
  const locationAssets = planAssets
    .filter((asset) => String(asset?.category || '') === 'location')
    .slice()
    .sort((x, y) => String(x?.name || x?.id || '').localeCompare(String(y?.name || y?.id || ''), 'zh-CN'))
  // 2026-11-06 背景元素（scenery）：与地点同归背景中心管理，不进事物卡片墙（避免两处重复管理）
  const sceneryAssets = planAssets
    .filter((asset) => String(asset?.category || '') === 'scenery')
    .slice()
    .sort((x, y) => String(x?.name || x?.id || '').localeCompare(String(y?.name || y?.id || ''), 'zh-CN'))
  const gridAssetsAll = planAssets
    .filter((asset) => String(asset?.category || '') !== 'location' && String(asset?.category || '') !== 'scenery')
    .map((asset) => ({ asset, st: assetLockStatusOf(asset, props.assetPromptDrafts as any) }))
    .sort((x, y) => statusRank[x.st.tone] - statusRank[y.st.tone] || String(x.asset?.name || x.asset?.id || '').localeCompare(String(y.asset?.name || y.asset?.id || ''), 'zh-CN'))
  const gridAssets = gridAssetsAll.filter(({ asset, st }) => {
    if (gridFilterDone === 'todo' && st.tone === 'locked') return false
    if (gridFilterDone === 'done' && st.tone !== 'locked') return false
    if (gridFilterCat !== 'all' && String(asset?.category || '') !== gridFilterCat) return false
    return true
  })
  const gridCounts = {
    draft: gridAssetsAll.filter((x) => x.st.tone === 'draft').length,
    draw: gridAssetsAll.filter((x) => x.st.tone === 'draw').length,
    lineart: gridAssetsAll.filter((x) => x.st.tone === 'lineart').length,
    locked: gridAssetsAll.filter((x) => x.st.tone === 'locked').length
  }
  // 2026-11-06 提示词状态计数（与批量生成链同口径：缺中文稿=缺失；绿=全部完成 / 黄=有缺失 / 红=有失败；事物域=gridAssetsAll）
  const promptDraftsMap = (props.assetPromptDrafts as any) || {}
  const thingPromptMissingCount = gridAssetsAll.filter((x) => !String(promptDraftsMap[String(x.asset?.id || '')]?.promptZh || '').trim()).length
  const thingPromptFailedCount = (props.enhanceAllSummary?.failures || []).filter((f) => gridAssetsAll.some((x) => String(x.asset?.id || '') === f.assetId)).length
  const thingPromptStatusTone = thingPromptFailedCount > 0 ? 'bad' : (gridAssetsAll.length > 0 && thingPromptMissingCount === 0 ? 'ok' : 'warn')
  // 下一步建议：按状态缺口给一句可执行建议
  const gridSuggestion = gridCounts.draft > 0
    ? `还有 ${gridCounts.draft} 个事物待起草提示词 → 可先批量生成`
    : gridCounts.draw > 0
      ? `还有 ${gridCounts.draw} 个事物待抽卡 → 可批量生成参考图`
      : gridCounts.lineart > 0
        ? `还有 ${gridCounts.lineart} 个事物待锁线稿 → 打开对应资产生成线稿`
        : (gridAssetsAll.length ? '全部事物已锁定，可进入正式场景出图' : '尚无角色或道具，可直接管理场景背景')
  const openAssetDetail = (assetId: string, anchor?: string) => {
    setDetailAssetId(String(assetId || '').trim())
    setDetailAnchor(String(anchor || '').trim())
  }
  const detailAsset = detailAssetId ? planAssets.find((a) => String(a?.id || '').trim() === detailAssetId) || null : null
  const detailNavAssets = String(detailAsset?.category || '') === 'location'
    ? locationAssets.map((asset) => ({ asset }))
    : String(detailAsset?.category || '') === 'scenery'
      ? sceneryAssets.map((asset) => ({ asset }))
      : gridAssetsAll
  const detailIndex = detailAsset ? detailNavAssets.findIndex((x) => String(x.asset?.id || '').trim() === String(detailAsset.id || '').trim()) : -1
  // 上一个/下一个：地点与角色/道具分别在自己的管理集合内循环。
  const detailNav = (dir: 1 | -1) => {
    if (!detailNavAssets.length) return
    const nextIdx = detailIndex < 0 ? 0 : (detailIndex + dir + detailNavAssets.length) % detailNavAssets.length
    setDetailAssetId(String(detailNavAssets[nextIdx]?.asset?.id || '').trim())
    setDetailAnchor('')
  }

  // 摆放属性「管理姿势变体…」跳转 / 蓝图「管理」深度回跳：打开即定位到该资产的场景姿态区（可指定场景+需求）
  // 2026-09-02 大改版：grid/steps 两模式统一开二级详情弹层并滚到姿势变体区（steps 模式第 5 步是卡片墙，姿态区在详情弹层里）
  React.useEffect(() => {
    if (!props.open || !props.poseFocus) return undefined
    const aid = String(props.poseFocus.assetId || '').trim()
    if (!aid) return undefined
    setPoseExpanded((prev) => ({ ...prev, [aid]: true }))
    setDetailAssetId(aid)
    setDetailAnchor('pose')
    if (viewMode === 'steps') setWizardStep(5)
    const t = window.setTimeout(() => {
      try { document.getElementById(`pose-asset-${aid}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch {}
    }, 400)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.poseFocus])

  // 2026-09-02 二级详情弹层：打开后落到指定环节锚点（快捷动作「起草提示词/抽卡/去锁线稿」直达对应环节）
  React.useEffect(() => {
    if (!detailAssetId || !detailAnchor) return undefined
    const aid = detailAssetId
    if (detailAnchor === 'pose') setPoseExpanded((prev) => ({ ...prev, [aid]: true }))
    const anchorId = detailAnchor === 'pose' ? `pose-asset-${aid}` : `detail-sec-${detailAnchor}-${aid}`
    const t = window.setTimeout(() => {
      try { document.getElementById(anchorId)?.scrollIntoView({ block: 'start' }) } catch {}
    }, 300)
    return () => window.clearTimeout(t)
  }, [detailAssetId, detailAnchor])

  // ============ 2026-09-02 大改版：每资产卡内容抽成共用渲染函数（步骤模式与二级详情弹层共用同一份渲染，零逻辑分叉） ============
  // 徽标按真实来源区分 AI 生成、翻译、已有草稿与计划英文稿；中文稿变更晚于翻译时标记待重译。
  const zhBadge = (hasZh: boolean, aiGenerated = false) =>
    !hasZh
      ? <span className="bp-prompt-badge">空</span>
      : <span className={`bp-prompt-badge ${aiGenerated ? 'is-ok' : ''}`}>{aiGenerated ? 'AI 已生成' : '已有草稿'}</span>
  const enBadge = (enVal: string, zhUpdatedAt: string, translatedAt: string, aiGenerated: boolean) => {
    if (!String(enVal || '').trim()) return <span className="bp-prompt-badge">空</span>
    if (translatedAt && zhUpdatedAt && zhUpdatedAt > translatedAt) return <span className="bp-prompt-badge is-stale">待重译</span>
    if (translatedAt) return <span className="bp-prompt-badge is-ok">已翻译</span>
    return <span className={`bp-prompt-badge ${aiGenerated ? 'is-ok' : ''}`}>{aiGenerated ? 'AI 已生成' : '已有英文稿'}</span>
  }

  const renderAssetPromptCard = (asset: any) => {
            const assetId = String(asset?.id || '').trim()
            const promptDraft = (props.assetPromptDrafts && props.assetPromptDrafts[assetId]) || {}
            const promptReview = promptDraft.promptReview || null
            const promptReviewTone = assetPromptReviewTone(promptReview)
            const promptEnhancedAt = String(promptDraft.enhancedAt || '').trim()
            const promptAiGenerated = Boolean(promptEnhancedAt) && String(promptDraft.enhanceMode || '') === 'ai'
            const isAnchorAsset = Boolean(String(asset?.renderStrategy || '').trim()) && String(asset?.renderStrategy || '').trim() !== 'ref_required'
            const promptZhUpdatedAt = String((promptDraft as any).zhUpdatedAt || '').trim()
            const promptTranslatedAt = String((promptDraft as any).translatedAt || '').trim()
            const optimizing = props.assetOptimizingId === assetId
            const translatingAssetPositive = props.translatingScope === `asset:positive:${assetId}`
            const translatingAssetNegative = props.translatingScope === `asset:negative:${assetId}`
            return (
              <div id={`asset-prompt-${assetId}`} className="story-lock-plan-prompt-card" key={assetId} tabIndex={-1}>
                <div className="story-lock-plan-prompt-head">
                  <span className="story-lock-plan-name">{String(asset?.name || assetId || '未命名')}</span>
                  <span className="hint">{getAssetCategoryLabel(String(asset?.category || ''))}</span>
                  {isAnchorAsset ? <span className="ai-storyboard-status ok">锚点提示词</span> : null}
                  <span
                    className={`ai-storyboard-status ${promptAiGenerated ? 'ok' : ''}`}
                    title={promptAiGenerated ? `本页 AI 生成时间：${promptEnhancedAt}` : isAnchorAsset ? '来自资产计划；没有本页 AI 生成记录' : '已有提示词草稿'}
                  >
                    {promptAiGenerated ? 'AI 已生成' : isAnchorAsset ? '计划已有锚点' : '已有草稿'}
                  </span>
                  {promptReview ? <span className={`ai-storyboard-status ${promptReviewTone.cls}`}>评分 {Number.isFinite(Number(promptReview.score)) ? `${Math.round(Number(promptReview.score))}/100` : 'n/a'}</span> : null}
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => props.onOptimizeAssetRef(assetId)}
                    disabled={promptOpBusy || !assetId}
                    title={promptEnhancedAt ? '重新生成该事物的中英文提示词（会覆盖当前内容）' : '调用 AI 基于故事资产数据生成该事物的中英文提示词'}
                  >{optimizing ? '生成中…' : 'AI 生成提示词'}</button>
                </div>
                {promptReview?.summary ? <div className="hint" style={{ color: promptReviewTone.color }}>AI 评语：{String(promptReview.summary)}</div> : null}
                <div className="story-lock-prompt-grid">
                  {/* 2026-10-07 点击目标 bug 根修：按钮（公共库/中转英）不得放在 <label> 里——
                      HTML label 激活行为会把"点在 label 任意位置"转发给第一个可操作子元素（恰好是按钮），
                      导致点 caption/空白处就打开公共库。改为 div 容器（span 仅是说明文字，无 htmlFor 损失）。 */}
                  <div className="story-lock-prompt-field">
                    <span>正向 · 中文 {zhBadge(Boolean(String(promptDraft.promptZh || '').trim()), promptAiGenerated)} <button className="story-lock-mini-btn" type="button" onClick={() => openPromptLibrary(assetPromptLibTarget(asset, 'positive'))} title="打开公共提示词库，插入到该事物正向中/英文栏，或存入库">公共库</button></span>
                    <AutoGrowTextarea ariaLabel={`${String(asset?.name || assetId)} 正向中文提示词`} value={String(promptDraft.promptZh || '')} onChange={(value) => props.onChangeAssetPrompt(assetId, { promptZh: value })} placeholder="点「AI 生成提示词」先出中文稿，再按需要微调" />
                  </div>
                  <div className="story-lock-prompt-field">
                    <span>正向 · 英文 {enBadge(String(promptDraft.promptEn || ''), promptZhUpdatedAt, promptTranslatedAt, promptAiGenerated)} <button className="story-lock-mini-btn" type="button" onClick={() => props.onTranslateAssetPromptPositive(assetId)} disabled={promptOpBusy} title="中文转英文">{translatingAssetPositive ? '翻译中…' : '中转英'}</button></span>
                    <AutoGrowTextarea ariaLabel={`${String(asset?.name || assetId)} 正向英文提示词`} value={String(promptDraft.promptEn || '')} onChange={(value) => props.onChangeAssetPrompt(assetId, { promptEn: value })} placeholder="中文稿确认后翻译，或手工编辑" />
                  </div>
                  <div className="story-lock-prompt-field">
                    <span>反向 · 中文 {zhBadge(Boolean(String(promptDraft.negativePromptZh || '').trim()), promptAiGenerated)} <button className="story-lock-mini-btn" type="button" onClick={() => openPromptLibrary(assetPromptLibTarget(asset, 'negative'))} title="打开公共提示词库，插入到该事物反向中/英文栏，或存入库">公共库</button></span>
                    <AutoGrowTextarea ariaLabel={`${String(asset?.name || assetId)} 反向中文提示词`} value={String(promptDraft.negativePromptZh || '')} onChange={(value) => props.onChangeAssetPrompt(assetId, { negativePromptZh: value })} placeholder="该事物专属的中文反向提示词" />
                  </div>
                  <div className="story-lock-prompt-field">
                    <span>反向 · 英文 {enBadge(String(promptDraft.negativePrompt || ''), promptZhUpdatedAt, promptTranslatedAt, promptAiGenerated)} <button className="story-lock-mini-btn" type="button" onClick={() => props.onTranslateAssetPromptNegative(assetId)} disabled={promptOpBusy} title="中文转英文">{translatingAssetNegative ? '翻译中…' : '中转英'}</button></span>
                    <AutoGrowTextarea ariaLabel={`${String(asset?.name || assetId)} 反向英文提示词`} value={String(promptDraft.negativePrompt || '')} onChange={(value) => props.onChangeAssetPrompt(assetId, { negativePrompt: value })} placeholder="翻译后或手工编辑" />
                  </div>
                </div>
              </div>
            )
  }

  const renderAssetLineartRow = (asset: any) => {
                  const aid = String(asset?.id || '').trim()
                  const hasPrimary = Boolean(String(asset?.primaryReferenceAssetUri || '').trim())
                  const hasLineart = Boolean(String(asset?.lineartFinalAssetUri || '').trim())
                  const lineartPendingReview = pendingReviews.some((review) => (
                    review.phase === 'pre_generate' && String(review.targetKey || '').trim() === `lineart:${aid}`
                  ))
                  const linearting = props.assetLineartId === aid
                  return (
                    <div className="story-lock-plan-row" key={aid}>
                      <span className="story-lock-plan-name">{String(asset?.name || aid || '未命名')}</span>
                      <span className={`ai-storyboard-status ${hasLineart ? 'ok' : (lineartPendingReview ? 'pending' : 'bad')}`}>{hasLineart ? '线稿已生成' : (lineartPendingReview ? '线稿待审核' : '待生成线稿')}</span>
                      <button className="btn secondary" type="button" onClick={() => props.onGenerateAssetLineart(aid)} disabled={props.assetPlanBusy || linearting || lineartPendingReview || !hasPrimary || !aid}>
                        {linearting ? '线稿生成中…' : (lineartPendingReview ? '待审核批准' : (hasLineart ? '重新生成线稿' : '生成线稿'))}
                      </button>
                    </div>
                  )
  }

  const renderAssetRefRow = (asset: any) => {
            const assetId = String(asset?.id || '').trim()
            const promptDraft = (props.assetPromptDrafts && props.assetPromptDrafts[assetId]) || {}
            const promptReview = promptDraft.promptReview || null
            const promptReviewTone = assetPromptReviewTone(promptReview)
            const promptEnhancedAt = String(promptDraft.enhancedAt || '').trim()
            const promptEnhanced = Boolean(promptEnhancedAt)
            const primaryUri = String(asset?.primaryReferenceAssetUri || '').trim()
            const { all: candidateAll, display: batch, overflow: batchOverflow } = buildDisplayedReferenceCandidates(asset)
            const lineartHintSrc = toProjectAssetUrl(String(props.projectId || ''), String(asset?.lineartHintAssetUri || '').trim())
            const lineartFinalSrc = toProjectAssetUrl(String(props.projectId || ''), String(asset?.lineartFinalAssetUri || '').trim())
            const bestScore = candidateAll.reduce((max: number | null, item: any) => {
              const s = scoreOf(item)
              if (s == null) return max
              return max == null ? s : Math.max(max, s)
            }, null)
            const selectedReview = (candidateAll.find((item: any) => normalizeAssetPath(String(item?.assetPath || '')) === normalizeAssetPath(primaryUri))?.analysis) || asset?.latestReferenceReview || null
            const selectedScore = Number(selectedReview?.score)
            // 2026-11-10：进行中的抽卡任务以服务端任务台账为准（覆盖刷新/跨会话发起，不只信本页内存态）
            const activeRefTask = aiTasks.find((t) => t.kind === 'story.asset.reference_batch' && !t.done && String(t.assetId || '') === assetId) || null
            const generating = props.assetGeneratingId === assetId || Boolean(activeRefTask)
            const analyzing = props.assetAnalyzingId === assetId
            const optimizing = props.assetOptimizingId === assetId
            const selecting = props.assetSelectingId === assetId
            const linearting = props.assetLineartId === assetId
            const lineartPendingReview = pendingReviews.some((review) => (
              review.phase === 'pre_generate' && String(review.targetKey || '').trim() === `lineart:${assetId}`
            ))
            const assetBusy = generating || analyzing || optimizing || selecting || linearting
            const translatingAssetPositive = props.translatingScope === `asset:positive:${assetId}`
            const translatingAssetNegative = props.translatingScope === `asset:negative:${assetId}`
            // 2026-11-01 姿势/状态变体两段抽至 ScenePoseWorkbench（下方渲染）；此处不再派生姿态本地变量
            return (
              <div className="story-lock-asset-row" key={assetId}>
                <div className="story-lock-asset-candidate-strip">
                  {batch.length ? batch.map((candidate: any, idx: number) => {
                    const candidatePath = String(candidate?.assetPath || '').trim()
                    const candidateUrl = String(candidate?.url || '').trim()
                    const candidateSrc = candidateUrl ? toRuntimeUrl(candidateUrl) : toProjectAssetUrl(String(props.projectId || ''), candidatePath)
                    const candidateScore = scoreOf(candidate)
                    const selected = Boolean(candidatePath && candidatePath === primaryUri)
                    const recommended = Boolean(candidate?.recommended || (candidateScore != null && bestScore != null && candidateScore === bestScore))
                    const candidateReviewFailed = Boolean(candidate?.analysis && typeof candidate.analysis === 'object' && candidate.analysis.passed !== true)
                    return (
                      <div className={`story-lock-candidate-card ${selected ? 'selected' : ''}`} key={`${assetId}_${idx}`}>
                        <div className="story-lock-candidate-title">候选 {idx + 1}</div>
                        <div className={`ai-storyboard-asset-candidate-preview ${candidateSrc ? 'ready' : 'missing'}`}>
                          {candidateSrc ? <img src={candidateSrc} alt={`${String(asset?.name || assetId)}_${idx + 1}`} /> : <div className="hint">候选 {idx + 1}</div>}
                        </div>
                        <div className="story-lock-candidate-meta">
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span className="hint">#{idx + 1} {candidateScore != null ? `${candidateScore}/100` : '未评分'}</span>
                            {recommended ? <span className="ai-storyboard-status ok">推荐</span> : null}
                            {candidateReviewFailed ? <span className="ai-storyboard-status pending">评审未过</span> : null}
                          </div>
                          <div className="hint">seed: {candidate?.seed != null ? String(candidate.seed) : '-'}</div>
                          <button className="btn secondary" type="button" onClick={() => props.onSelectAssetRef(assetId, candidatePath)} disabled={props.assetPlanBusy || Boolean(props.assetSelectingId) || assetBusy || !candidatePath || selected}>{selecting && selected ? '设置中…' : (selected ? '当前主参考' : '设为主参考')}</button>
                        </div>
                      </div>
                    )
                  }) : (
                    <div className="story-lock-candidate-card">
                      <div className="story-lock-candidate-title">候选</div>
                      <div className="ai-storyboard-asset-candidate-preview missing">
                        <div className="hint">待生成</div>
                      </div>
                      <div className="story-lock-candidate-meta">
                        <div className="hint">还没有候选图</div>
                      </div>
                    </div>
                  )}
                  <div className={`story-lock-candidate-card story-lock-candidate-card-lineart ${lineartHintSrc ? 'selected' : ''}`}>
                    <div className="story-lock-candidate-title">ControlNet Hint</div>
                    <div className={`ai-storyboard-asset-candidate-preview ${lineartHintSrc ? 'ready' : 'missing'}`}>
                      {lineartHintSrc ? <img src={lineartHintSrc} alt={`${String(asset?.name || assetId)}_hint`} /> : <div className="hint">待生成</div>}
                    </div>
                    <div className="story-lock-candidate-meta">
                      <div className="hint">{lineartHintSrc ? '已生成' : '待生成'}</div>
                    </div>
                  </div>
                  <div className={`story-lock-candidate-card story-lock-candidate-card-lineart ${lineartFinalSrc ? 'selected' : ''}`}>
                    <div className="story-lock-candidate-title">Final Lineart</div>
                    <div className={`ai-storyboard-asset-candidate-preview ${lineartFinalSrc ? 'ready' : 'missing'}`}>
                      {lineartFinalSrc ? <img src={lineartFinalSrc} alt={`${String(asset?.name || assetId)}_lineart`} /> : <div className="hint">待生成</div>}
                    </div>
                    <div className="story-lock-candidate-meta">
                      <div className="hint">{lineartFinalSrc ? '已生成' : '待生成'}</div>
                    </div>
                  </div>
                </div>

                <div className="story-lock-asset-detail">
                  <div className="story-lock-asset-info">
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <div style={{ fontWeight: 800, fontSize: 20, whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }} title={String(asset?.name || assetId || '未命名资产')}>{String(asset?.name || assetId || '未命名资产')}</div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <button
                          className="btn secondary"
                          type="button"
                          onClick={() => props.onDeleteAssetFromPlan(assetId)}
                          disabled={props.assetPlanBusy || !assetId}
                          title="从当前锁定事物计划中移除该资产"
                        >
                          删除此事物
                        </button>
                        {(() => { const chip = getAssetRefChip(asset); return <span className={`ai-storyboard-status ${chip.tone}`}>{chip.label}</span> })()}
                        <span className={`ai-storyboard-status ${String(asset?.lineartFinalAssetUri || '').trim() ? 'ok' : (lineartPendingReview ? 'pending' : 'bad')}`}>{String(asset?.lineartFinalAssetUri || '').trim() ? '线稿已生成' : (lineartPendingReview ? '线稿待审核' : '待生成线稿')}</span>
                      </div>
                    </div>
                    <div className="hint">{getAssetCategoryLabel(String(asset?.category || ''))} / 涉及 {Number(asset?.sceneCount || 0)} 个场景</div>
                    <div className="hint story-lock-score-summary">
                      {Number.isFinite(selectedScore) ? `当前主参考评分：${Math.round(selectedScore)} / 100` : (bestScore != null && Number.isFinite(bestScore) ? `当前批次最佳评分：${bestScore} / 100` : '当前还没有可评分主参考')}
                      {selectedReview?.summary ? `，${String(selectedReview.summary)}` : ''}
                    </div>
                    {String((asset?.generatedRefs?.[asset?.generatedRefs?.length - 1]?.negativePrompt) || '').trim() ? (
                      <div className="hint story-lock-score-summary">
                        当前抽卡会自动附加强负面提示词，已限制纯白背景、无道具、无场景、多主体等干扰项。
                      </div>
                    ) : null}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button className="btn secondary" type="button" onClick={() => props.onGenerateAssetRef(assetId, 1)} disabled={props.assetPlanBusy || assetBusy || !assetId}>{selecting ? '主参考处理中…' : (generating ? '抽卡中…' : '生成 1 张')}</button>
                      <button className="btn secondary" type="button" onClick={() => props.onGenerateAssetRef(assetId, 4)} disabled={props.assetPlanBusy || assetBusy || !assetId}>{selecting ? '主参考处理中…' : (generating ? '抽卡中…' : (batch.length ? '再出 4 张' : '生成 4 张参考图'))}</button>
                      <button className="btn secondary" type="button" onClick={() => props.onAnalyzeAssetRef(assetId)} disabled={props.assetPlanBusy || assetBusy || !String(asset?.primaryReferenceAssetUri || '').trim() || !assetId}>{selecting ? '主参考处理中…' : (analyzing ? '分析当前主参考中…' : '分析当前主参考')}</button>
                      <button className="btn secondary" type="button" onClick={() => props.onGenerateAssetLineart(assetId)} disabled={props.assetPlanBusy || assetBusy || lineartPendingReview || !String(asset?.primaryReferenceAssetUri || '').trim() || !assetId}>{selecting ? '主参考处理中…' : (linearting ? '线稿生成中…' : (lineartPendingReview ? '待审核批准' : '生成线稿'))}</button>
                      <button className="btn secondary" type="button" onClick={() => props.onOpenAssetGallery(assetId)} disabled={props.assetPlanBusy || assetBusy || !assetId}>{selecting ? '主参考处理中…' : (props.assetGalleryBusy && props.assetGallery?.assetId === assetId ? '加载管理中…' : (batchOverflow > 0 ? `管理图片（更多 ${batchOverflow}）` : '管理图片'))}</button>
                    </div>
                    {/* 2026-11-10：抽卡进行中就地状态（蓝=进行中；发起后请勿重复点击——服务端同资产并发护栏兜底拒重） */}
                    {activeRefTask ? (
                      <div className="hint" role="status" style={{ marginTop: 6 }}>
                        <span className="ai-storyboard-status pending">生成中</span>{' '}
                        {activeRefTask.message || '参考图抽卡进行中…'}
                        {Number(activeRefTask.total) > 0 ? `（候选 ${Number(activeRefTask.current) || 0}/${Number(activeRefTask.total)}）` : ''}
                        ，任务完成后候选自动回填，请勿重复点击
                      </div>
                    ) : null}
                  </div>
                </div>

                <ScenePoseWorkbench
                  projectId={String(props.projectId || '')}
                  asset={asset}
                  planAssets={planAssets}
                  assetPlanBusy={props.assetPlanBusy}
                  poseGeneratingId={props.poseGeneratingId}
                  poseDrawProgress={props.poseDrawProgress}
                  poseReviewingId={props.poseReviewingId}
                  poseLockingKey={props.poseLockingKey}
                  poseReqBusyId={props.poseReqBusyId}
                  propStateBusyId={props.propStateBusyId}
                  propStateGenKey={props.propStateGenKey}
                  poseSceneOptions={props.poseSceneOptionsFor?.(assetId) || []}
                  poseExpanded={Boolean(poseExpanded[assetId])}
                  onPoseExpandedChange={(v) => setPoseExpanded((prev) => ({ ...prev, [assetId]: v }))}
                  stateExpanded={Boolean(stateExpanded[assetId])}
                  onStateExpandedChange={(v) => setStateExpanded((prev) => ({ ...prev, [assetId]: v }))}
                  focusReqId={props.poseFocus && String(props.poseFocus.assetId || '') === assetId ? props.poseFocus.reqId : undefined}
                  focusSceneId={props.poseFocus && String(props.poseFocus.assetId || '') === assetId ? props.poseFocus.sceneId : undefined}
                  onGotoBlueprint={props.onGotoBlueprint}
                  onPoseDraftSave={props.onPoseDraftSave}
                  onPoseRequirementGenerate={props.onPoseRequirementGenerate}
                  onPoseRequirementsBatchGenerate={props.onPoseRequirementsBatchGenerate}
                  onPoseReviewAll={props.onPoseReviewAll}
                  onPoseRedraw={props.onPoseRedraw}
                  onPoseDeleteCandidate={props.onPoseDeleteCandidate}
                  onPoseLock={props.onPoseLock}
                  onPoseDeleteVariant={props.onPoseDeleteVariant}
                  onPoseGalleryOpen={props.onPoseGalleryOpen}
                  onPropStatesExtract={props.onPropStatesExtract}
                  onPropStateGenerate={props.onPropStateGenerate}
                />
              </div>
            )
  }

  const renderGlobalPromptSections = () => (
              <div className="story-lock-global-sections">
                <div className="hint">
                  正向必含：美术风格、时代/地点/环境、光线/色彩、镜头/构图、角色与关键道具一致性。负向必含：文字水印、模糊/低质量/畸形、变脸/换装/道具替换、多余人物/多视图及设定冲突。全局只写跨场景共性；单个事物特征和场景动作放到各自专属提示词。
                </div>
                <div className="story-lock-global-section">
                  <div className="story-lock-global-subhead">
                    <div className="story-lock-global-subtitle">全局正向提示词</div>
                    <button className="btn secondary" type="button" onClick={() => openPromptLibrary(globalPromptLibTarget('positive'))} title="打开公共提示词库：选择已沉淀的正向片段插入（去重追加），或把当前内容存入库">公共提示词</button>
                    <button className="btn secondary" type="button" onClick={props.onTranslateGlobalPrompt} disabled={!promptZhConfirmed || promptOpBusy} title={promptZhConfirmed ? '' : '请先确认中文稿'}>{props.translatingScope === 'globalPrompt' ? `翻译中…${translateCountdownLabel}` : (promptOpBusy ? '请等待当前任务…' : (!promptZhConfirmed ? '中文转英文（先确认中文稿）' : '中文转英文'))}</button>
                  </div>
                  <div className="story-lock-prompt-grid">
                    <label className="story-lock-prompt-field">
                      <span>中文 {zhBadge(Boolean(String((props.value as any)?.globalPromptZh || '').trim()))}</span>
                      <textarea className="story-lock-textarea" value={String((props.value as any)?.globalPromptZh || '')} onChange={(e) => props.onChangeGlobalPromptZh(e.target.value)} placeholder="例：统一绘本风格、时代地点、光线色彩与镜头语言；角色外观、服装和关键道具在所有场景保持一致" />
                    </label>
                    <label className="story-lock-prompt-field">
                      <span>英文 {String(props.value?.globalPrompt || '').trim() ? <span className="bp-prompt-badge is-ok">已翻译</span> : <span className="bp-prompt-badge">未翻译</span>}</span>
                      <textarea className="story-lock-textarea" value={String(props.value?.globalPrompt || '')} onChange={(e) => props.onChangeGlobalPromptEn(e.target.value)} placeholder="翻译后或手工编辑英文正向提示词" />
                    </label>
                  </div>
                </div>
                <div className="story-lock-global-section">
                  <div className="story-lock-global-subhead">
                    <div className="story-lock-global-subtitle">全局负向提示词</div>
                    <button className="btn secondary" type="button" onClick={() => openPromptLibrary(globalPromptLibTarget('negative'))} title="打开公共提示词库：选择已沉淀的负向片段插入（去重追加），或把当前内容存入库">公共提示词</button>
                    <button className="btn secondary" type="button" onClick={props.onTranslateGlobalNegativePrompt} disabled={!promptZhConfirmed || promptOpBusy} title={promptZhConfirmed ? '' : '请先确认中文稿'}>{props.translatingScope === 'globalNegativePrompt' ? `翻译中…${translateCountdownLabel}` : (promptOpBusy ? '请等待当前任务…' : (!promptZhConfirmed ? '中文转英文（先确认中文稿）' : '中文转英文'))}</button>
                  </div>
                  <div className="story-lock-prompt-grid">
                    <label className="story-lock-prompt-field">
                      <span>中文 {zhBadge(Boolean(String((props.value as any)?.globalNegativePromptZh || '').trim()))}</span>
                      <textarea className="story-lock-textarea" value={String((props.value as any)?.globalNegativePromptZh || '')} onChange={(e) => props.onChangeGlobalNegativePromptZh(e.target.value)} placeholder="例：文字、水印、模糊、畸形、变脸、换装、道具替换、多余人物、多视图、与故事设定冲突的元素" />
                    </label>
                    <label className="story-lock-prompt-field">
                      <span>英文 {String(props.value?.globalNegativePrompt || '').trim() ? <span className="bp-prompt-badge is-ok">已翻译</span> : <span className="bp-prompt-badge">未翻译</span>}</span>
                      <textarea className="story-lock-textarea" value={String(props.value?.globalNegativePrompt || '')} onChange={(e) => props.onChangeGlobalNegativePromptEn(e.target.value)} placeholder="翻译后或手工编辑英文负向提示词" />
                    </label>
                  </div>
                </div>
              </div>
  )

  // 2026-10-27 J2：卡片墙抽成共享渲染函数——卡片总览与第 5 步出图管理主视图同一组件复用（不抄两套）
  function renderGridWall() {
    return (
          <div className="story-lock-gridview">
            {/* 顶部工具行：出图总账 + 下一步建议 + 批量 + 配置 + 待审核入口 */}
            <div className="story-lock-grid-toolbar">
              <span className="ai-storyboard-status ok">已锁定 {gridCounts.locked}/{gridAssetsAll.length}</span>
              {gridCounts.lineart > 0 ? <span className="ai-storyboard-status pending">待锁线稿 {gridCounts.lineart}</span> : null}
              {gridCounts.draw > 0 ? <span className="story-lock-thing-status draw">待抽卡 {gridCounts.draw}</span> : null}
              {gridCounts.draft > 0 ? <span className="story-lock-thing-status draft">待起草 {gridCounts.draft}</span> : null}
              {pendingReviews.length > 0 ? (
                <button
                  type="button"
                  className="ai-storyboard-status bad story-lock-review-badge"
                  onClick={() => {
                    try { document.getElementById('story-lock-review-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch {}
                  }}
                  title="滚动到待审核区"
                >
                  待审核 {pendingReviews.length}
                </button>
              ) : null}
              <span className="hint story-lock-grid-suggestion">{gridSuggestion}</span>
              <span style={{ flex: 1 }} />
              <span className={`ai-storyboard-status ${thingPromptStatusTone}`} title="事物中文提示词已生成计数（缺中文稿计入缺失）">
                提示词 {gridAssetsAll.length - thingPromptMissingCount}/{gridAssetsAll.length}{thingPromptFailedCount > 0 ? ` · 失败 ${thingPromptFailedCount}` : ''}
              </span>
              <button
                className="btn secondary"
                type="button"
                onClick={() => props.onEnhanceAllPrompts?.()}
                disabled={props.enhanceAllProgress?.busy || promptOpBusy || planAssets.length === 0 || props.assetPlanBusy || thingPromptMissingCount === 0}
                title="AI 逐个为全部资产生成中文正向/反向提示词"
              >
                {props.enhanceAllProgress?.busy ? `生成中…（${props.enhanceAllProgress.current}/${props.enhanceAllProgress.total}）` : `生成全部缺失提示词（${thingPromptMissingCount}）`}
              </button><button
                className="btn secondary"
                type="button"
                onClick={props.onGenerateAllMissingAssetRefs}
                disabled={!promptEnApproved || props.assetPlanBusy || !assetPlan || missingBatchCount === 0}
                title={promptEnApproved ? '为全部缺候选的资产生成参考图' : '请先完成第 4 步提示词批准（步骤模式）'}
              >
                生成全部缺失参考图
              </button>
              <button className="btn secondary" type="button" onClick={() => setDrawerOpen(true)} title="全局提示词 / 模型与接口 / 采样参数">
                配置
              </button>
            </div>

            {/* 2026-10-26 缺陷 B：批量增强失败明面化——逐项汇总卡（成功/失败+名单+人话原因+一键重试），不再静默回 idle */}
            {props.enhanceAllSummary && props.enhanceAllSummary.failures.length ? (
              <div className="story-lock-error-banner" role="alert" style={{ display: 'grid', gap: 6 }}>
                <div style={{ fontWeight: 700 }}>
                  提示词生成：成功 {props.enhanceAllSummary.done} / 失败 {props.enhanceAllSummary.failures.length}（失败项已各自动重试一次）
                </div>
                {props.enhanceAllSummary.failures.map((f) => (
                  <div key={f.assetId} style={{ fontSize: 12.5 }}>
                    · {f.label}：{f.reason}
                  </div>
                ))}
                <div>
                  <button className="btn secondary" type="button" style={{ padding: '3px 12px', fontSize: 12 }} onClick={() => props.onRetryFailedEnhance?.()} disabled={props.enhanceAllProgress?.busy}>
                    重试失败项
                  </button>
                </div>
              </div>
            ) : null}
            {/* 筛选行：前景中心（角色/道具）与背景中心分开管理，地点不再参与前景出图状态筛选。 */}
            <div className="story-lock-grid-filters">
              <span className="story-lock-grid-filter-group" role="tablist" aria-label="出图管理模块" title="前景中心=角色/道具的参考图与线稿（摆在背景之上）；背景中心=每幕背景图、地点锚点与背景内元素">
                {([['assets', '前景中心'], ['scenes', '背景中心']] as const).map(([k, label]) => (
                  <button key={k} type="button" role="tab" aria-selected={step5Scope === k} className={`story-lock-view-toggle-btn ${step5Scope === k ? 'active lock-navigation-primary' : ''}`} onClick={() => setStep5Scope(k)}>{label}</button>
                ))}
              </span>
              {step5Scope === 'assets' ? (
                <>
                  <span className="story-lock-grid-filter-group">
                    {([['all', '全部'], ['todo', '未完成'], ['done', '已完成']] as const).map(([k, label]) => (
                      <button key={k} type="button" className={`story-lock-view-toggle-btn ${gridFilterDone === k ? 'active' : ''}`} onClick={() => setGridFilterDone(k)}>{label}</button>
                    ))}
                  </span>
                  <span className="story-lock-grid-filter-group">
                    {([['all', '全部类型'], ['character', '角色'], ['prop', '道具']] as const).map(([k, label]) => (
                      <button key={k} type="button" className={`story-lock-view-toggle-btn ${gridFilterCat === k ? 'active' : ''}`} onClick={() => setGridFilterCat(k)}>{label}</button>
                    ))}
                  </span>
                </>
              ) : null}
            </div>

            {step5Scope === 'scenes' ? (
              props.sceneBoard ? (
                <div className="story-lock-sceneboard">
                  {(() => {
                    // 2026-11-10 用户裁决：前景内容不进背景中心（前景在「前景中心」维度管理）；
                    // 每幕背景是否已出——由场景背景看板 items 的 backgroundUri 派生（location/scenery 卡片场景 chip 同口径）
                    const sceneItems = Array.isArray((props.sceneBoard as any)?.props?.items) ? (props.sceneBoard as any).props.items : []
                    const bgByNodeId = new Map<string, boolean>(sceneItems.map((it: any) => [String(it?.nodeId || ''), Boolean(String(it?.backgroundUri || it?.backgroundUrl || '').trim())]))
                    const sceneBackgroundOf = (sceneId: string) => bgByNodeId.get(String(sceneId || '')) === true
                    // 背景元素/地点的幕分配管理（服务端三处同步写口：scene.assetIds + scene.promptAssets + asset.sceneIds）：
                    // 分配后场景出图 prompt 与摆位链才真正纳入该元素——这是"合在一起出完整背景"的管理闭环
                    const assignAssetScene = async (assetId: string, targetSceneId: string, action: 'add' | 'remove') => {
                      try {
                        await assignPlanSceneAsset(projectId, targetSceneId, assetId, action)
                        props.onReloadProject?.()
                      } catch (e) {
                        void dlgAlert(`${action === 'add' ? '分配' : '移除'}失败：${e instanceof Error ? e.message : String(e)}`)
                      }
                    }
                    return (
                  <BackgroundCenter
                    sceneBoard={props.sceneBoard}
                    locationCount={locationAssets.length}
                    sceneCount={planScenes.length}
                    sceneryCount={sceneryAssets.length}
                    focusSceneId={sceneFocus?.id}
                    focusRequestId={sceneFocus?.requestId}
                    locationBoard={(
                      <LocationTemplateBoard
                        projectId={projectId}
                        assets={locationAssets}
                        scenes={planScenes}
                        promptDrafts={props.assetPromptDrafts || {}}
                        busy={props.assetPlanBusy}
                        sceneBackgroundOf={sceneBackgroundOf}
                        onAssignScene={assignAssetScene}
                        onGeneratePrompts={(ids) => props.onEnhanceAllPrompts?.(ids)}
                        promptGenBusy={Boolean(props.enhanceAllProgress?.busy)}
                        enhanceProgress={props.enhanceAllProgress}
                        enhanceFailures={props.enhanceAllSummary?.failures || []}
                        onOpenAsset={(assetId) => openAssetDetail(assetId)}
                        onOpenScene={(sceneId) => {
                          if (!planScenes.some((scene) => String(scene?.sceneId || '') === sceneId)) return
                          setStep5Scope('scenes')
                          setSceneFocus((prev) => ({ id: sceneId, requestId: (prev?.requestId || 0) + 1 }))
                        }}
                        onDelete={props.onDeleteAssetFromPlan}
                      />
                    )}
                    sceneryBoard={(
                      <SceneryElementBoard
                        projectId={projectId}
                        assets={sceneryAssets}
                        scenes={planScenes}
                        promptDrafts={props.assetPromptDrafts || {}}
                        busy={props.assetPlanBusy}
                        sceneBackgroundOf={sceneBackgroundOf}
                        onAssignScene={assignAssetScene}
                        onGeneratePrompts={(ids) => props.onEnhanceAllPrompts?.(ids)}
                        promptGenBusy={Boolean(props.enhanceAllProgress?.busy)}
                        enhanceProgress={props.enhanceAllProgress}
                        enhanceFailures={props.enhanceAllSummary?.failures || []}
                        onOpenAsset={(assetId) => openAssetDetail(assetId)}
                        onOpenScene={(sceneId) => {
                          if (!planScenes.some((scene) => String(scene?.sceneId || '') === sceneId)) return
                          setStep5Scope('scenes')
                          setSceneFocus((prev) => ({ id: sceneId, requestId: (prev?.requestId || 0) + 1 }))
                        }}
                        onDelete={props.onDeleteAssetFromPlan}
                      />
                    )}
                  />
                    )
                  })()}
                </div>
              ) : (
                <div className="hint">背景中心未接入（sceneBoard 未注入）。</div>
              )
            ) : null}

            {/* 卡片墙：角色/道具按类型分组；地点模板统一在背景中心维护。 */}
            {step5Scope === 'assets' ? (
            <div className="story-lock-cardwall-groups">
              {(() => {
                const groups = [
                  { key: 'character', label: '角色', items: gridAssets.filter((x) => String(x.asset?.category || '') === 'character') },
                  { key: 'prop', label: '道具', items: gridAssets.filter((x) => String(x.asset?.category || '') === 'prop') },
                  { key: 'other', label: '其他', items: gridAssets.filter((x) => !['character', 'prop'].includes(String(x.asset?.category || ''))) }
                ].filter((g) => g.items.length)
                if (!groups.length) return <div className="hint" style={{ padding: 24 }}>当前筛选下没有事物卡片。</div>
                return groups.map((g) => (
                  <div key={g.key} className="story-lock-cardwall-group">
                    <div className="story-lock-prompt-group-head">
                      <span className="story-lock-prompt-group-title">{g.label}</span>
                      <span className="hint">（{g.items.length}）</span>
                    </div>
                    <div className="story-lock-cardwall">
                      {g.items.map(({ asset, st }) => {
                        const aid = String(asset?.id || '').trim()
                        const img = assetCardImageOf(asset, projectId)
                        const sceneCount = Number(asset?.sceneCount || (Array.isArray(asset?.sceneIds) ? asset.sceneIds.length : 0) || 0)
                        const fiveStages = assetFiveStagesOf(asset, props.assetPromptDrafts as any)
                        const quickAction =
                          st.tone === 'draft' ? { label: '起草提示词', anchor: 'prompt' }
                          : st.tone === 'draw' ? { label: '抽卡', anchor: 'ref' }
                          : st.tone === 'lineart' ? { label: '去锁线稿', anchor: 'lineart' }
                          : null
                        return (
                          <div className="story-lock-thing-card" key={aid} onClick={() => openAssetDetail(aid)}>
                            <div className={`story-lock-thing-img ${img ? 'ready' : 'missing'}`}>
                              {img ? <img src={img} alt={String(asset?.name || aid)} /> : <div className="hint">未生成</div>}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div className="story-lock-thing-name" style={{ flex: 1 }} title={String(asset?.name || aid)}>{String(asset?.name || aid || '未命名')}</div>
                              <button
                                className="btn secondary"
                                type="button"
                                style={{ padding: '2px 7px', fontSize: 11, color: '#fca5a5', flexShrink: 0 }}
                                aria-label={`删除 ${String(asset?.name || aid)}`}
                                title="删除该事物并移除场景分配；已生成图片文件保留"
                                disabled={props.assetPlanBusy || !aid}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  props.onDeleteAssetFromPlan(aid)
                                }}
                              >
                                删除
                              </button>
                            </div>
                            <div className="story-lock-thing-meta">
                              <span className="story-lock-thing-cat">{getAssetCategoryLabel(String(asset?.category || ''))}</span>
                              <span className={`story-lock-thing-status ${st.tone}`}>{st.label}</span>
                            </div>
                            {/* 四段状态点（提示词→主参考→姿态→线稿） */}
                            <div className="story-lock-five-stages" title={fiveStages.map((s) => `${s.label}:${s.tone === 'done' ? '已完成' : s.tone === 'partial' ? '进行中' : '未开始'}`).join(' · ')}>
                              {fiveStages.map((s) => (
                                <span key={s.key} className={`story-lock-stage-dot ${s.tone}`} />
                              ))}
                            </div>
                            <div className="hint" style={{ fontSize: 11 }}>涉及 {sceneCount} 个场景</div>
                            {quickAction ? (
                              <button
                                className="btn secondary"
                                type="button"
                                style={{ fontSize: 12, padding: '4px 8px' }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  openAssetDetail(aid, quickAction.anchor)
                                }}
                              >
                                {quickAction.label}
                              </button>
                            ) : null}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))
              })()}
            </div>
            ) : null}
          </div>
    )
  }

  return (
    <div className="ai-modal story-lock-workspace-overlay" role="dialog" aria-modal="true">
      <div className="story-lock-workspace-card">
        <div className="story-lock-workspace-head">
          <div className="story-lock-workspace-head-main">
            <div className="story-lock-workspace-titlebar">
              <div className="ai-modal-title" style={{ marginBottom: 0 }}>锁定事物</div>
              {/* 2026-09-02 大改版：一级卡片总览（默认，计划已确认时）/ 步骤模式（新项目准备向导）切换 */}
              <div className="story-lock-view-toggle" role="tablist" aria-label="视图切换">
                <button
                  type="button"
                  className={`story-lock-view-toggle-btn ${viewMode === 'grid' ? 'active' : ''}`}
                  onClick={() => setViewModeOverride('grid')}
                >
                  卡片总览
                </button>
                <button
                  type="button"
                  className={`story-lock-view-toggle-btn ${viewMode === 'steps' ? 'active' : ''}`}
                  onClick={() => setViewModeOverride('steps')}
                >
                  步骤模式
                </button>
              </div>
              {/* 2026-10-27 J2 口径修正：全未开始（出图链事物无候选无锁定且无生成任务在跑）→「待开始」（中性）；有进展→「进行中」（黄）；全锁+确认→「已完成锁定」（绿）；全锁未确认→「待确认」 */}
              {(() => {
                const anyGenerationRunning = aiTasks.some((t) => !t.done)
                // 待开始口径按出图链事物（ref_required）判定：地点类「已锁定」是锚点就绪语义，不算出图已开始
                const drawableAll = planAssets.filter((a) => String(a?.renderStrategy || '').trim() === 'ref_required')
                const anyStartedDrawable = drawableAll.some((a) =>
                  String(a?.primaryReferenceAssetUri || '').trim() ||
                  String(a?.primaryReferenceAssetId || '').trim() ||
                  (Array.isArray(a?.generatedRefs) && a.generatedRefs.length > 0)
                )
                const allUntouched = drawableAll.length > 0 && !anyStartedDrawable && !anyGenerationRunning
                const stateText = props.assetConfirmReady ? '已完成锁定' : allUntouched ? '待开始' : (unlockedCount > 0 || anyGenerationRunning) ? '进行中' : '待确认'
                const stateTone = props.assetConfirmReady ? 'ok' : allUntouched ? 'ok' : (unlockedCount > 0 || anyGenerationRunning) ? 'bad' : 'ok'
                return <div className={`ai-storyboard-status ${stateTone}`}>{stateText}</div>
              })()}
            </div>
            {viewMode === 'steps' ? (
            <div className="story-lock-stepper" role="tablist">
              {wizardSteps.map((s) => (
                <button
                  key={s.n}
                  type="button"
                  role="tab"
                  className={`story-lock-step ${wizardStep === s.n ? 'active' : ''} ${s.ready ? 'ready' : ''} ${s.n <= maxUnlockedStep ? 'unlocked' : 'locked'}`}
                  onClick={() => gotoStep(s.n)}
                  disabled={s.n > maxUnlockedStep}
                  title={s.ready ? `${s.label}：已完成` : (stepGateHint(s.n) || `${s.label}：未完成`)}
                >
                  <span className="story-lock-step-icon">{s.ready ? '✓' : (wizardStep === s.n ? '●' : '○')}</span>
                  <span className="story-lock-step-label">{s.n}. {s.label}</span>
                </button>
              ))}
            </div>
            ) : null}
            {/* 错误横幅：操作失败（如主参考被写入门禁拒绝）必须立即可见，不能只进折叠日志 */}
            {props.error ? <div className="story-lock-error-banner" role="alert">{props.error}</div> : null}
            {savedAt ? <div className="story-lock-save-hint" role="status">已保存 · {savedAt}</div> : null}
            <div className="story-lock-workspace-meta-inline">
              <div className="story-lock-workspace-chip-row">
                <span className="ai-storyboard-status ok">资产数: {assetPlan?.summary?.assetCount || planAssets.length}</span>
                <span className={`ai-storyboard-status ${missingBatchCount ? 'bad' : 'ok'}`}>待抽卡: {missingBatchCount}</span>
                <span className={`ai-storyboard-status ${unlockedCount ? 'bad' : 'ok'}`}>待锁定: {unlockedCount}</span>
                <span className="ai-storyboard-status ok">LoRA: {configuredLoras.length ? configuredLoras.join(' | ') : '(none)'}</span>
              </div>
              <div className="story-lock-workspace-summary-main">{props.assetConfirmSummary}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {props.onSave ? (
              <button
                className={`btn lock-action-primary${props.promptDraftsDirty ? ' is-dirty' : ''}`}
                type="button"
                onClick={() => void handleSave()}
                disabled={saveBusy}
                title={props.promptDraftsDirty ? '有提示词草稿未保存——点击落盘' : '保存'}
              >
                {saveBusy ? '保存中…' : props.promptDraftsDirty ? '保存（有未保存提示词草稿）' : '保存'}
              </button>
            ) : null}
            <button type="button" className="icon-btn" onClick={props.onClose} aria-label="关闭" title="关闭">✕</button>
          </div>
        </div>

        {/* ============ 2026-09-02 一级「事物总览」卡片墙（默认主视图；保存/出图在右上头部，两模式共用） ============ */}
        {viewMode === 'grid' ? renderGridWall() : null}

        {viewMode === 'steps' && wizardStep === 1 && (
          <div className="story-lock-step-panel">
            <div className="story-lock-step-panel-title">第 1 步 · 环境体检</div>
            <div className="hint">检查出图前置环境：Server 连通、提示词与出图 Provider/Model、ComfyUI 节点与模型完整性、连续性绑定。全部通过才能进入下一步。</div>
            <div className="story-lock-step-actions">
              <button className="btn secondary" type="button" onClick={props.onRunOpenChecks} disabled={props.assetPlanBusy || props.busyEntity}>{props.openChecks?.checking ? '体检中…' : (props.openChecks?.summary ? '重新体检' : '开始体检')}</button>
              {/* 2026-11-10：提示词能力（OMLX 文本模型）不可用时就地拉起——体检失败项含提示词时显示；GUI App 可见启动 */}
              {(!props.openChecks?.promptOk && String(props.openChecks?.promptProvider || '') === 'localoxml') ? (
                <button className="btn secondary" type="button" onClick={() => void launchTool('omlx', 'OMLX 本地模型')} disabled={comfyLaunchBusy || props.assetPlanBusy || props.busyEntity} title="拉起本机 OMLX 本地模型服务（GUI App 可见启动；拉起成功后自动重新体检）">
                  {comfyLaunchBusy ? '拉起中…' : '拉起 OMLX（App）'}
                </button>
              ) : null}
              {String(props.openChecks?.imageProvider || '') === 'comfyui' ? (
                <button className="btn secondary" type="button" onClick={() => void launchComfyUi()} disabled={comfyLaunchBusy || props.assetPlanBusy || props.busyEntity} title="在终端可见窗口拉起本机 ComfyUI 出图服务（已在运行时不重复拉起；拉起成功后自动重新体检）">
                  {comfyLaunchBusy ? '拉起中…' : '拉起 ComfyUI（终端）'}
                </button>
              ) : null}
            </div>
            {comfyLaunchNote ? <div className="hint">{comfyLaunchNote}</div> : null}
            {props.openChecks?.summary ? (
              <div className={`story-lock-check-result ${props.openChecks.ok ? 'ok' : 'bad'}`}>
                <div className="story-lock-check-summary">{props.openChecks.summary}</div>
              </div>
            ) : null}
            {!props.openChecks?.ok && Array.isArray((props.openChecks as any)?.issues) && (props.openChecks as any).issues.length > 0 ? (
              <div className="story-lock-check-issues">
                <div className="story-lock-check-issues-title">待修复项：</div>
                {((props.openChecks as any).issues as string[]).map((issue, idx) => <div key={idx} className="story-lock-check-issue">· {issue}</div>)}
              </div>
            ) : null}
            {props.openChecks?.ok ? <div className="hint" style={{ color: 'var(--c-success-dim, #4ade80)' }}>✓ 环境就绪，可进入下一步</div> : null}
          </div>
        )}

        {viewMode === 'steps' && wizardStep === 3 && (
          <div className="story-lock-step-panel">
            <div className="story-lock-step-panel-title">第 3 步 · 资产计划</div>
            <div className="hint">基于 Story Bible 生成必要事物资产计划（角色/道具/地点及其锁定提示词档案）。生成后清单只读审阅，不合适的事物可删除。</div>
            <div className="story-lock-step-actions">
              <button className="btn secondary" type="button" onClick={props.onBuildAssetPlan} disabled={props.assetPlanBusy || !storyBibleReady} title="资产计划会在 Story Bible 生成成功后自动派生，通常无需手动点击。仅在以下情况使用：① 自动派生失败需重试；② 圣经来自其他链路、计划缺失；③ 故事结构或画布摆位变更后需要重新对账（纯本地计算，不调用模型）。">
                {props.assetPlanBusy ? '处理中…' : (planAssets.length ? '重新生成资产计划' : '生成资产计划')}
              </button>
              {planAssets.length > 0 ? (
                <>
                  <div className="story-lock-view-toggle" role="tablist" aria-label="计划视图切换">
                    <button type="button" className={`story-lock-view-toggle-btn ${planViewMode === 'scenes' ? 'active' : ''}`} onClick={() => setPlanViewMode('scenes')}>按场景</button>
                    <button type="button" className={`story-lock-view-toggle-btn ${planViewMode === 'assets' ? 'active' : ''}`} onClick={() => setPlanViewMode('assets')}>按事物</button>
                  </div>
                  <button className="btn secondary" type="button" onClick={() => props.onRunSceneElementAnalysis?.()} disabled={props.assetPlanBusy || Boolean(props.sceneAnalysisBusy)} title="AI 读取全故事，分析每个事物在各场景的姿态（角色）与视觉状态（道具/地点）；结果随场景视图展示。简谱演绎默认：角色 1 张主参考 + 表情差分即可，逐场景姿势变体属可选精细档">
                    {props.sceneAnalysisBusy ? '分析中…' : 'AI 分析跨场景姿态/状态'}
                  </button>
                </>
              ) : null}
            </div>
            {props.sceneAnalysisBusy ? (
              <div className="story-lock-analysis-progress">
                <span className="ai-storyboard-status pending">分析中</span>
                <span className="hint">
                  {props.sceneAnalysisStage === 'prop' ? '阶段 2/2：AI 提取事物跨场景视觉状态…' : '阶段 1/2：AI 提取全故事角色姿势…'}
                  （已用时 {Math.floor(Number(props.sceneAnalysisElapsedMs || 0) / 1000)}s；本地模型单次调用可能需 1~3 分钟，过程明细见下方日志）
                </span>
              </div>
            ) : null}
            {planAssets.length > 0 ? (
              planViewMode === 'scenes' ? (
                <div className="story-lock-scene-list">
                  {planScenes.map((scene, sceneIdx) => {
                    const sceneId = String(scene?.sceneId || '').trim()
                    const elements = sceneId ? (assetsBySceneId.get(sceneId) || []) : []
                    const byCategory = (cat: string) => elements.filter((a) => String(a?.category || '') === cat)
                    return (
                      <div className="story-lock-scene-group" key={sceneId || `scene_${sceneIdx}`}>
                        <div className="story-lock-scene-head">
                          <span className="story-lock-scene-title">#{Number(scene?.sceneIndex || sceneIdx + 1)} {String(scene?.sceneName || sceneId || '未命名场景')}</span>
                          {String(scene?.summary || '').trim() ? <span className="hint">{String(scene.summary).slice(0, 80)}{String(scene.summary).length > 80 ? '…' : ''}</span> : null}
                          {/* 2026-10-07 导演层可见：运镜说明（构图需求单 cameraNote） */}
                          {String(scene?.composition?.cameraNote || '').trim() ? (
                            <div className="hint" style={{ width: '100%' }}>导演运镜：{String(scene.composition.cameraNote)}</div>
                          ) : null}
                        </div>
                        {elements.length === 0 ? <div className="hint">本场景暂无锁定事物</div> : (
                          <>
                            {([['character', '角色'], ['prop', '道具'], ['location', '地点']] as const).map(([cat, catLabel]) => {
                              const list = byCategory(cat)
                              if (!list.length) return null
                              return (
                                <div className="story-lock-scene-cat" key={cat}>
                                  <span className="story-lock-scene-cat-label">{catLabel}</span>
                                  {list.map((asset) => {
                                    const aid = String(asset?.id || '').trim()
                                    const directorItem = directorItemFor(scene, asset)
                                    return (
                                      <div className="story-lock-plan-row story-lock-element-row" key={`${sceneId}:${aid}`} style={{ flexWrap: 'wrap' }}>
                                        <span className="story-lock-plan-name">{String(asset?.name || aid || '未命名')}</span>
                                        {(() => { const chip = getAssetRefChip(asset); return <span className={`ai-storyboard-status ${chip.tone}`}>{chip.label}</span> })()}
                                        <span className="hint story-lock-element-state">{sceneElementStateLine(asset, sceneId)}</span>
                                        {/* 导演层：该元素在本场景的摆位规格+布场说明（悬停看原文依据） */}
                                        {directorItem ? (
                                          <span className="hint" style={{ flexBasis: '100%', fontSize: 12 }} title={String(directorItem?.evidence || '').trim() ? `原文依据：${String(directorItem.evidence).trim()}` : undefined}>
                                            导演：{directorLineOf(directorItem)}
                                          </span>
                                        ) : null}
                                      </div>
                                    )
                                  })}
                                </div>
                              )
                            })}
                          </>
                        )}
                      </div>
                    )
                  })}
                  {unassignedPlanAssets.length > 0 ? (
                    <div className="story-lock-scene-group story-lock-scene-group-warn">
                      <div className="story-lock-scene-head">
                        <span className="story-lock-scene-title">未分配到场景（{unassignedPlanAssets.length}）</span>
                        <span className="hint">以下事物未匹配到任何场景——可能圣经场景绑定缺失或正文中确实未出场；不需要的可到「按事物」视图删除。</span>
                      </div>
                      {unassignedPlanAssets.map((asset) => {
                        const aid = String(asset?.id || '').trim()
                        return (
                          <div className="story-lock-plan-row story-lock-element-row" key={aid}>
                            <span className="story-lock-plan-name">{String(asset?.name || aid || '未命名')}</span>
                            <span className="hint">{getAssetCategoryLabel(String(asset?.category || ''))}</span>
                            {(() => { const chip = getAssetRefChip(asset); return <span className={`ai-storyboard-status ${chip.tone}`}>{chip.label}</span> })()}
                          </div>
                        )
                      })}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="story-lock-plan-list">
                  {planAssets.map((asset) => {
                    const aid = String(asset?.id || '').trim()
                    return (
                      <div className="story-lock-plan-row" key={aid}>
                        <span className="story-lock-plan-name">{String(asset?.name || aid || '未命名')}</span>
                        <span className="hint">{getAssetCategoryLabel(String(asset?.category || ''))} / 涉及 {Number(asset?.sceneCount || 0)} 个场景{assetAnalysisSummary(asset)}</span>
                        {(() => { const chip = getAssetRefChip(asset); return <span className={`ai-storyboard-status ${chip.tone}`}>{chip.label}</span> })()}
                        <button className="btn secondary" type="button" onClick={() => props.onDeleteAssetFromPlan(aid)} disabled={props.assetPlanBusy || !aid} title="从当前锁定事物计划中移除该资产">删除</button>
                      </div>
                    )
                  })}
                </div>
              )
            ) : <div className="hint">尚未生成资产计划。请先生成 Story Bible，再生成资产计划。</div>}
          </div>
        )}

        {viewMode === 'steps' && wizardStep === 5 && (
        <div className="story-lock-step-panel">
          <div className="story-lock-step-panel-title">第 5 步 · 出图管理</div>
          <div className="hint">出图管理统一管所有图：维度切「事物」=逐元素完成 主参考抽卡与锁定 → 按需生成场景姿态/状态变体 → 线稿（点卡片进该元素专属工作区）；维度切「场景背景」=每幕背景图 提示词→出图→版本绑定（待审核在卡片上就地处理）。全部锁定后才算完成本步。</div>
          {!promptEnApproved ? <div className="story-lock-wizard-hint" style={{ textAlign: 'left' }}>按正确流程：请先完成第 4 步「全局与事物提示词」（中文稿确认→翻译→英文稿批准）后再开始抽图。</div> : null}
          <div className="story-lock-step-actions">
            <button className="btn secondary" type="button" onClick={props.onGenerateAllMissingAssetRefs} disabled={!promptEnApproved || props.assetPlanBusy || !assetPlan || missingBatchCount === 0} title={promptEnApproved ? '' : '请先完成第 4 步提示词批准'}>生成全部缺失参考图 ({missingBatchCount})</button>
            <button className="btn secondary" type="button" onClick={props.onConfirmAssetPlan} disabled={props.assetPlanBusy || !assetPlan || unlockedCount > 0}>{props.assetConfirmReady ? '已确认 ✓' : '确认锁定无误'}</button>
          </div>
        </div>
        )}

        {/* 2026-10-27 J2 用户裁决：第 5 步主视图=卡片墙（与卡片总览同一 renderGridWall 复用，不抄两套）；
            内联平铺 renderAssetRefRow/LineartRow 行收编进元素工作区弹层（功能不删） */}
        {viewMode === 'steps' && wizardStep === 5 && (
        <div className="story-lock-workspace-assets">
          {planAssets.length ? renderGridWall() : (
            <div className="hint">尚未生成资产计划。请先生成 Story Bible，再生成资产计划。</div>
          )}
        </div>
        )}

        {viewMode === 'steps' && wizardStep === 6 && (
          <div className="story-lock-step-panel">
            <div className="story-lock-step-panel-title">第 6 步 · 完成锁定</div>
            <div className="hint">全部前置就绪后进入场景背景出图——回到第 5 步出图管理，切到「场景背景」维度逐幕出图/绑定；批量渲染缺失场景可断点续跑，出图期间本地模型会自动让出内存给 ComfyUI。</div>
            <div className="story-lock-step-actions">
              <button className="btn secondary" type="button" onClick={() => void runRenderAllScenes()} disabled={renderAllBusy || renderAllActive || !projectId}>{renderAllActive ? '批量渲染进行中…' : '渲染缺失场景'}</button>
            </div>
            {!props.assetConfirmReady ? <div className="hint">提示：建议先在第 5 步出图管理完成「确认锁定无误」再批量出图。</div> : null}
          </div>
        )}

        {viewMode === 'steps' ? (
        <div className="story-lock-wizard-footer">
          <button className="btn secondary" type="button" onClick={() => setWizardStep((v) => Math.max(1, v - 1))} disabled={wizardStep <= 1}>上一步</button>
          <div className="story-lock-wizard-hint">{stepGateHint(Math.min(wizardStep + 1, firstNotReady)) ? `下一步前：${stepGateHint(Math.min(wizardStep + 1, firstNotReady))}` : ''}</div>
          <button className="btn secondary" type="button" onClick={() => gotoStep(wizardStep + 1)} disabled={wizardStep >= 6 || wizardStep + 1 > maxUnlockedStep}>下一步</button>
        </div>
        ) : null}

        {/* 2026-08-30：第 6 步也显示待审核列表——线稿在 manual 模式会挂出图前审核，不显示用户找不到批准入口 */}
        {((viewMode === 'steps' && (wizardStep === 5 || wizardStep === 6)) || viewMode === 'grid') && pendingReviews.length > 0 && (
          <div className="ai-review-pending-list" id="story-lock-review-anchor">
            <div className="ai-review-pending-head">
              <span className="ai-review-pending-title">待审核（{pendingReviews.length}）</span>
              {pendingReviews.filter((r) => r.phase === 'scene_bind').length > 1 && (
                <button className="btn secondary" type="button" onClick={() => void approveAllSceneBinds()}>全部批准场景图</button>
              )}
            </div>
            {pendingReviews.map((review) => {
              const busy = reviewBusyIds.includes(review.reviewId)
              const targetName = String(review.params?.targetName || review.params?.sceneName || review.assetId || review.sceneId || '')
              return (
                <div key={review.reviewId} className="ai-review-pending-item">
                  <div className="ai-review-pending-main">
                    <span className="ai-review-phase">{reviewPhaseLabel(review.phase)}</span>
                    <span className="ai-review-target">{targetName}</span>
                    {review.aiReview && Number.isFinite(Number(review.aiReview.score)) && (
                      <span className="ai-review-score">AI {Math.round(Number(review.aiReview.score))} 分</span>
                    )}
                  </div>
                  {review.resultImagePath && (
                    <img className="ai-review-thumb" src={toProjectAssetUrl(projectId, review.resultImagePath)} alt={targetName} />
                  )}
                  {review.prompt && (
                    <div className="ai-review-prompt" title={review.prompt}>{review.prompt.length > 180 ? `${review.prompt.slice(0, 180)}…` : review.prompt}</div>
                  )}
                  {review.aiReview?.summary && <div className="ai-review-summary">AI 评语：{review.aiReview.summary}</div>}
                  <div className="ai-review-actions">
                    <button className="btn secondary" type="button" disabled={busy} onClick={() => void decideReview(review, true)}>{busy ? '处理中…' : '批准'}</button>
                    <button className="btn secondary" type="button" disabled={busy} onClick={() => void decideReview(review, false)}>拒绝</button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {aiCoverage && (
          <div className="ai-coverage-summary">
            <span className="ai-coverage-summary-label">出图总账</span>
            {aiCoverage.hasPlan ? (
              <span className="ai-coverage-summary-text">
                资产锁定 {aiCoverage.assets.locked}/{aiCoverage.assets.total} · 背景绑定 {aiCoverage.scenes.bound}/{aiCoverage.scenes.total} · 待审核 {aiCoverage.overall.pendingReviews} · 总进度 {aiCoverage.overall.percent}%
              </span>
            ) : (
              <span className="ai-coverage-summary-text">尚未生成资产计划</span>
            )}
          </div>
        )}

        {visibleTasks.length > 0 && (
          <div className="ai-task-progress-list">
            {visibleTasks.map((task) => (
              <div key={task.taskId} className={`ai-task-progress-item ${task.done ? (task.error ? 'error' : 'done') : 'active'}`}>
                <span className="ai-task-progress-kind">{taskKindLabel(task.kind)}</span>
                <span className="ai-task-progress-stage">{taskStageLabel(task)}</span>
                {task.total > 0 && !task.done && (
                  <span className="ai-task-progress-bar"><span className="ai-task-progress-bar-inner" style={{ width: `${Math.min(100, Math.round((task.current / task.total) * 100))}%` }} /></span>
                )}
                <span className="ai-task-progress-message">{task.error || task.message || ''}</span>
              </div>
            ))}
          </div>
        )}

        {viewMode === 'steps' && wizardStep === 2 && (
        <div className="story-lock-global-prompts">
          <div className="story-lock-global-card story-lock-bible-card">
            <div className="story-lock-global-head story-lock-bible-head">
              <div className="story-lock-bible-intro">
                <div className="story-lock-workspace-log-title">Story Bible</div>
                <div className="hint">这里统一处理故事锁定前置数据。Story Bible 生成成功后会自动派生资产计划（第 3 步查看）；进入 AI 分镜后只读取结果，不再重复编辑。</div>
              </div>
              <div className="story-lock-bible-actions">
                <button className="btn secondary" type="button" onClick={() => setStoryBibleExpanded((v) => !v)}>{storyBibleExpanded ? '收起' : '展开'}</button>
                <button className="btn secondary" type="button" onClick={props.onGenerateEntity} disabled={props.assetPlanBusy || props.busyEntity}>
                  {props.busyEntity ? '生成中…' : (storyBibleReady ? '重新生成 Story Bible' : '生成 Story Bible')}
                </button>
              </div>
            </div>
            <div className="story-lock-bible-summary">
              <div className="story-lock-workspace-chip-row">
                <span className={`ai-storyboard-status ${storyBibleReady ? 'ok' : 'pending'}`}>{storyBibleReady ? '已生成' : '未生成'}</span>
                {storyBibleSummary ? <span className={`ai-storyboard-status ${storyBibleSummary.invalid ? 'bad' : 'ok'}`}>{storyBibleSummary.invalid ? 'JSON 无法解析' : '结构可用'}</span> : null}
                {storyBibleSummary && !storyBibleSummary.invalid ? <span className="ai-storyboard-status ok">角色 {storyBibleSummary.characters}</span> : null}
                {storyBibleSummary && !storyBibleSummary.invalid ? <span className="ai-storyboard-status ok">道具 {storyBibleSummary.props}</span> : null}
                {storyBibleSummary && !storyBibleSummary.invalid ? <span className="ai-storyboard-status ok">地点 {storyBibleSummary.locations}</span> : null}
                {storyBibleSummary && !storyBibleSummary.invalid ? <span className={`ai-storyboard-status ${storyBibleSummary.hasWorldAnchor ? 'ok' : 'pending'}`}>世界锚点 {storyBibleSummary.hasWorldAnchor ? '已生成' : '缺失'}</span> : null}
              </div>
              {storyBibleExpanded ? (
                storyBibleSummary ? (
                  <div className="story-lock-bible-details">
                    {storyBibleSummary.worldAnchorPreview ? <div className="hint">世界锚点摘要：{storyBibleSummary.worldAnchorPreview}{storyBibleSummary.worldAnchorPreview.length >= 140 ? '…' : ''}</div> : null}
                    {(() => {
                      const details = parseStoryBibleDetails(String((props.value as any)?.storyBibleJson || ''))
                      if (!details) return null
                      const renderGroup = (title: string, items: { name: string; desc: string; anchor: string; scenes: number }[]) => (
                        items.length ? (
                          <div style={{ marginTop: 8 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#cbd5e1', marginBottom: 4 }}>{title}（{items.length}）</div>
                            <div style={{ display: 'grid', gap: 6 }}>
                              {items.map((it, i) => (
                                <div key={i} style={{ fontSize: 12, lineHeight: 1.7, padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(148,163,184,0.18)', background: 'rgba(2,6,23,0.35)' }}>
                                  <div style={{ color: '#e5e7eb', fontWeight: 600 }}>
                                    {it.name}{it.scenes ? <span className="hint">（涉及 {it.scenes} 场景）</span> : null}
                                  </div>
                                  {it.desc ? <div className="hint" style={{ marginTop: 2 }}>设定：{it.desc}</div> : null}
                                  {it.anchor ? <div className="hint" style={{ marginTop: 2, color: '#94a3b8' }}>锚点提示词：{it.anchor}</div> : null}
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null
                      )
                      return (
                        <>
                          {renderGroup('角色', details.characters)}
                          {renderGroup('道具', details.props)}
                          {renderGroup('地点', details.locations)}
                          {details.worldRules.length ? (
                            <div style={{ marginTop: 8 }}>
                              <div style={{ fontSize: 12, fontWeight: 700, color: '#cbd5e1', marginBottom: 4 }}>世界规则（{details.worldRules.length}）</div>
                              {details.worldRules.map((r: string, i: number) => <div key={i} className="hint" style={{ marginTop: 2 }}>· {r}</div>)}
                            </div>
                          ) : null}
                        </>
                      )
                    })()}
                    <div className="hint">
                      {storyBibleSummary.invalid
                        ? '当前 Story Bible 内容无法解析，建议重新生成。'
                        : '这份摘要会驱动后续资产计划、事物锁定和正式场景提示词。详细锁定处理统一留在当前界面。'}
                    </div>
                  </div>
                ) : (
                  <div className="hint">当前还没有 Story Bible。先生成它，后面的资产计划和锁定资产都会依赖这份前置数据。</div>
                )
              ) : null}
            </div>
          </div>
        </div>
        )}

        {viewMode === 'steps' && wizardStep === 4 && (
        <div className="story-lock-step-panel">
          <div className="story-lock-step-panel-title">第 4 步 · 全局与事物提示词</div>
          <div className="hint">先写中文：全局提示词与每个事物的专属提示词全部先生成中文稿，逐条审阅修改；确认后才允许翻译成英文并批准。批准后才进入抽图阶段——提示词锁定才能把图出对。</div>
          {/* 2026-10-26 缺陷 B：失败汇总卡挂步骤视图同款位置（总览墙那张只在总览可见，第 4 步操作位也要明面可见） */}
          {props.enhanceAllSummary && props.enhanceAllSummary.failures.length ? (
            <div className="story-lock-error-banner" role="alert" style={{ display: 'grid', gap: 6, margin: '8px 0' }}>
              <div style={{ fontWeight: 700 }}>
                提示词生成：成功 {props.enhanceAllSummary.done} / 失败 {props.enhanceAllSummary.failures.length}（失败项已各自动重试一次）
              </div>
              {props.enhanceAllSummary.failures.map((f) => (
                <div key={f.assetId} style={{ fontSize: 12.5 }}>
                  · {f.label}：{f.reason}
                </div>
              ))}
              <div>
                <button className="btn secondary" type="button" style={{ padding: '3px 12px', fontSize: 12 }} onClick={() => props.onRetryFailedEnhance?.()} disabled={props.enhanceAllProgress?.busy}>
                  重试失败项
                </button>
              </div>
            </div>
          ) : null}
          <div className="story-lock-step-actions">
            <button
              className="btn secondary"
              type="button"
              onClick={() => props.onEnhanceAllPrompts?.()}
              disabled={props.enhanceAllProgress?.busy || promptOpBusy || planAssets.length === 0 || promptMissingCount === 0 || props.assetPlanBusy}
              title="只处理中文提示词为空的事物；已有中文稿和人工修改不会覆盖"
            >{props.enhanceAllProgress?.busy ? `生成中…（${props.enhanceAllProgress.current}/${props.enhanceAllProgress.total}）` : promptMissingCount ? `AI 生成缺失事物提示词（${promptMissingCount}）` : `事物提示词已齐全（${planAssets.length}/${planAssets.length}）`}</button>
            <span className="hint" data-testid="prompt-generation-count" style={{ alignSelf: 'center' }}>已生成 {promptGeneratedCount}/{planAssets.length} · 待生成 {promptMissingCount}</span>
            <button
              className="btn secondary"
              type="button"
              onClick={() => props.onTranslateAllPrompts?.()}
              disabled={props.translateAllProgress?.busy || promptOpBusy || !promptZhConfirmed}
              title={promptZhConfirmed ? '把全部中文稿（全局正/负向 + 各抽卡事物正/反向）逐条翻译成英文，已有英文稿的自动跳过；串行执行，进度见日志' : '请先「确认中文稿」再执行翻译'}
            >{props.translateAllProgress?.busy ? `翻译中…（${props.translateAllProgress.current}/${props.translateAllProgress.total}）` : '一键翻译全部中文稿'}</button>
            <button
              className="btn secondary"
              type="button"
              onClick={() => props.onDraftGlobalPromptZh?.()}
              disabled={props.globalDraftBusy || promptOpBusy}
              title="由 AI 结合 Story Bible 与当前设定生成中文全局正向/负向提示词"
            >{props.globalDraftBusy ? '生成中…' : 'AI 生成中文全局稿'}</button>
          </div>
        </div>
        )}

        {viewMode === 'steps' && wizardStep === 4 && (
        <div className="story-lock-global-prompts">
          <div className="story-lock-global-card">
            <div className="story-lock-global-head">
              <div style={{ display: 'grid', gap: 6 }}>
                <div className="story-lock-workspace-log-title">全局提示词</div>
                <div className="story-lock-workspace-chip-row">
                  <span className={`ai-storyboard-status ${String((props.value as any)?.globalPromptZh || props.value?.globalPrompt || '').trim() ? 'ok' : 'bad'}`}>正向</span>
                  <span className={`ai-storyboard-status ${String((props.value as any)?.globalNegativePromptZh || props.value?.globalNegativePrompt || '').trim() ? 'ok' : 'bad'}`}>负向</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn secondary" type="button" onClick={() => setGlobalPromptsExpanded((v) => !v)}>{globalPromptsExpanded ? '收起' : '展开'}</button>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={togglePromptZhConfirmed}
                  title="确认全部中文提示词稿；确认后才允许翻译为英文"
                >{promptZhConfirmed ? '中文稿已确认 ✓' : '确认中文稿'}</button>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={togglePromptEnApproved}
                  disabled={!promptZhConfirmed}
                  title={promptZhConfirmed ? '批准英文稿，批准后才允许进入出图' : '请先确认中文稿'}
                >{promptEnApproved ? '英文稿已批准 ✓' : '批准英文稿'}</button>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => props.onReviewGlobalPrompt?.()}
                  disabled={promptOpBusy || props.globalPromptReviewBusy}
                  title="AI 评审当前全局正/负向提示词（结合 Story Bible），给出 0-100 评分与优化稿"
                >{props.globalPromptReviewBusy ? '评分中…' : 'AI 评分'}</button>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => props.onApplyGlobalPromptReview?.()}
                  disabled={promptOpBusy || !props.globalPromptReview?.ai?.optimizedGlobalPromptZh}
                  title="把评审给出的优化稿回填到中文/英文栏（回填后请重新确认中文稿与翻译批准）"
                >应用优化稿</button>
              </div>
            </div>
            {props.globalPromptReview?.ai ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '0 2px 8px' }}>
                <span className={`ai-storyboard-status ${assetPromptReviewTone(props.globalPromptReview.ai).cls}`}>
                  AI 评分：{Number.isFinite(Number(props.globalPromptReview.ai.score)) ? `${Math.round(Number(props.globalPromptReview.ai.score))}/100` : 'n/a'}
                </span>
                {String(props.globalPromptReview.ai.summary || '').trim() ? (
                  <span className="hint">{String(props.globalPromptReview.ai.summary)}</span>
                ) : null}
              </div>
            ) : null}
            {promptGateHint ? <div className="hint" style={{ color: '#fca5a5', padding: '0 2px 8px' }} role="alert">{promptGateHint}</div> : null}
            {globalPromptsExpanded ? renderGlobalPromptSections() : null}
          </div>
        </div>
        )}

        {viewMode === 'steps' && wizardStep === 4 && planAssets.length > 0 && (
        <div className="story-lock-plan-list">
          {/* 所有计划资产共用同一份提示词草稿；是否抽卡/线稿仍由 renderStrategy 决定。 */}
          {(() => {
            const promptAssets = planAssets.slice()
            const groups = [
              { key: 'character', label: '角色', items: promptAssets.filter((a) => String(a?.category || '').trim() === 'character') },
              { key: 'prop', label: '道具', items: promptAssets.filter((a) => String(a?.category || '').trim() === 'prop') },
              { key: 'other', label: '地点 / 背景模板', items: promptAssets.filter((a) => !['character', 'prop'].includes(String(a?.category || '').trim())) }
            ].filter((g) => g.items.length)
            return groups.map((g) => (
              <div key={g.key} className="story-lock-prompt-group">
                <div className="story-lock-prompt-group-head">
                  <span className="story-lock-prompt-group-title">{g.label}</span>
                  <span className="hint">（{g.items.length}）</span>
                </div>
                {g.items.map((asset) => renderAssetPromptCard(asset))}
              </div>
            ))
          })()}
          {backgroundAnchorAssets.length > 0 ? (
            <div className="hint" style={{ padding: '6px 2px' }}>
              背景锚点事物无需强制抽卡或线稿；其提示词仍用于场景背景，可在上方逐条审阅编辑：{backgroundAnchorAssets.map((a) => String(a?.name || a?.id || '未命名')).join('、')}
            </div>
          ) : null}
        </div>
        )}

        {/* 2026-11-10 用户裁决：日志区统一停靠向导底部（所有步骤/视图共用同一份）——
            必须渲染在所有步骤面板之后（此前夹在 step2/step4 之间，第 4 步时日志跑到内容上方）；
            默认展开，可收起为底部一行；停靠样式见 compose.css .story-lock-workspace-log-section */}
        <div className="story-lock-workspace-log-section">
          <div className="story-lock-section-head">
            <div className="story-lock-workspace-log-title">日志</div>
            <button className="btn secondary" type="button" onClick={() => setLogsExpanded((v) => !v)}>{logsExpanded ? '收起' : '展开'}</button>
          </div>
          {logsExpanded ? (
            <div className="story-lock-workspace-log-box">
              {props.error ? <div className="hint" style={{ color: '#fca5a5', marginBottom: 8 }}>{props.error}</div> : null}
              {taskHistoryLines.length ? (
                <pre style={{ opacity: 0.72, borderBottom: '1px dashed rgba(148,163,184,0.25)', paddingBottom: 6, marginBottom: 6 }}>{`—— 本项目任务历史（跨会话，含 API/其他会话驱动）——\n${taskHistoryLines.join('\n')}`}</pre>
              ) : null}
              <pre>{sessionLogLines.join('\n') || '暂无日志'}</pre>
            </div>
          ) : null}
        </div>



        {props.assetGallery ? (
          <div className="story-lock-gallery-overlay" role="dialog" aria-modal="true" aria-label="图片管理">
            <div className="story-lock-gallery-card">
              <div className="story-lock-gallery-head">
                <div>
                  <div className="story-lock-workspace-log-title">图片管理</div>
                  <div className="hint">{String(props.assetGallery.assetName || props.assetGallery.assetId || '未命名资产')}</div>
                </div>
                <button className="icon-btn" type="button" onClick={props.onCloseAssetGallery} disabled={galleryDeletingSet.size > 0} aria-label="关闭图片管理" title="关闭图片管理">✕</button>
              </div>
              <div className="story-lock-gallery-summary">
                <span className="ai-storyboard-status ok">共 {Array.isArray(props.assetGallery.items) ? props.assetGallery.items.length : 0} 张</span>
                <span className="ai-storyboard-status">{gallerySelectedPaths.length ? `已选择 ${gallerySelectedPaths.length} 张` : '未选择'}</span>
                <span className="hint">支持批量选择删除，也可直接在这里设为主参考。布局固定，不会因删图而拉伸。</span>
                <div className="story-lock-gallery-toolbar">
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => {
                      const items = Array.isArray(props.assetGallery?.items) ? props.assetGallery.items : []
                      if (!items.length) return
                      const allPaths = items.map((item) => String(item.assetPath || '').trim()).filter(Boolean)
                      const next = gallerySelectedPaths.length === allPaths.length ? [] : allPaths
                      setGallerySelectedPaths(next)
                    }}
                    disabled={galleryDeletingSet.size > 0 || !props.assetGallery?.items?.length}
                  >
                    {gallerySelectedPaths.length && gallerySelectedPaths.length === (props.assetGallery?.items?.length || 0) ? '取消全选' : '全选'}
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => setGallerySelectedPaths([])}
                    disabled={galleryDeletingSet.size > 0 || gallerySelectedPaths.length === 0}
                  >
                    清空选择
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={async () => {
                      const paths = gallerySelectedPaths.filter(Boolean)
                      if (!paths.length) return
                      if (!(await dlgConfirm(`确定删除选中的 ${paths.length} 张图片吗？`, { danger: true, okText: '删除' }))) return
                      props.onDeleteAssetGalleryItems(props.assetGallery!.assetId, paths)
                    }}
                    disabled={props.assetPlanBusy || galleryDeletingSet.size > 0 || gallerySelectedPaths.length === 0}
                  >
                    {galleryDeletingSet.size > 1 ? `批量删除中…(${galleryDeletingSet.size})` : `删除选中 (${gallerySelectedPaths.length})`}
                  </button>
                </div>
              </div>
                <div className="story-lock-gallery-grid">
                  {Array.isArray(props.assetGallery.items) && props.assetGallery.items.length ? props.assetGallery.items.map((item) => {
                  const itemPath = String(item.assetPath || '').trim()
                  const deleting = galleryDeletingSet.has(itemPath)
                  const checked = gallerySelectedPaths.includes(itemPath)
                  const galleryItemUrl = String(item.url || '').trim()
                  const galleryItemSrc = galleryItemUrl ? resolveUrl(galleryItemUrl) : ''
                  return (
                    <div className={`story-lock-gallery-item ${checked ? 'selected' : ''}`} key={itemPath}>
                      <label className="story-lock-gallery-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={deleting || galleryDeletingSet.size > 0}
                          onChange={(e) => {
                            setGallerySelectedPaths((prev) => {
                              const next = new Set(prev)
                              if (e.target.checked) next.add(itemPath)
                              else next.delete(itemPath)
                              return Array.from(next)
                            })
                          }}
                        />
                        <span>选择</span>
                      </label>
                      <div className={`ai-storyboard-asset-candidate-preview ${galleryItemSrc ? 'ready' : 'missing'}`}>
                        {galleryItemSrc ? <img src={galleryItemSrc} alt={String(item.label || item.assetPath || 'gallery_item')} /> : <div className="hint">图片不可用</div>}
                      </div>
                      <div className="story-lock-gallery-meta">
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                          <div className="story-lock-gallery-kind">{String(item.label || '图片')}</div>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            {item.isPrimary ? <span className="ai-storyboard-status ok">当前主参考</span> : null}
                            {item.isCurrentLineart ? <span className="ai-storyboard-status ok">当前线稿</span> : null}
                            {item.variantName ? <span className="ai-storyboard-status ok">{String(item.variantName)}</span> : null}
                            {Number.isFinite(Number(item.variantScore)) ? <span className="ai-storyboard-status">评分 {Number(item.variantScore)}</span> : null}
                            {item.variantComposite ? <span className="ai-storyboard-status" title="在主参考/AI 图基础上确定性合成（水位/石子叠加）">合成</span> : null}
                            {item.recommended ? <span className="ai-storyboard-status ok">推荐</span> : null}
                            {item.inLatestBatch ? <span className="ai-storyboard-status">本轮候选</span> : null}
                          </div>
                        </div>
                        <div className="hint">{formatGalleryTime(String(item.createdAt || '')) || '时间未知'}</div>
                        <div className="hint">{item.seed != null ? `seed: ${String(item.seed)}` : '无 seed'}</div>
                        <div className="story-lock-gallery-actions">
                          <button className="btn secondary" type="button" onClick={() => window.open(galleryItemSrc, '_blank', 'noopener,noreferrer')} disabled={!galleryItemSrc}>查看大图</button>
                          <button
                            className="btn secondary"
                            type="button"
                            onClick={() => props.onSelectAssetGalleryPrimary(props.assetGallery!.assetId, itemPath)}
                            disabled={props.assetPlanBusy || galleryDeletingSet.size > 0 || !itemPath || Boolean(item.isPrimary) || Boolean(props.assetSelectingId)}
                          >
                            {props.assetSelectingId === props.assetGallery?.assetId && item.isPrimary ? '设置中…' : (item.isPrimary ? '当前主参考' : '设为主参考')}
                          </button>
                          <button
                            className="btn secondary"
                            type="button"
                            onClick={async () => {
                              if (!(await dlgConfirm(`确定删除这张图片吗？\n${itemPath}`, { danger: true, okText: '删除' }))) return
                              props.onDeleteAssetGalleryItem(props.assetGallery!.assetId, itemPath)
                            }}
                            disabled={props.assetPlanBusy || deleting}
                          >
                            {deleting ? '删除中…' : '删除'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                }) : (
                  <div className="hint">当前资产还没有可管理的图片。</div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {/* 2026-09-01 姿势变体图片管理画廊（复用主参考画廊 overlay 模式；删除语义与区内一致：候选只删条目，变体走引用阻断） */}
        {poseGalleryAsset ? (() => {
          const gAssetId = String(poseGalleryAsset?.id || '').trim()
          const gName = String(poseGalleryAsset?.name || gAssetId || '未命名资产')
          const gCands: any[] = Array.isArray((poseGalleryAsset as any)?.poseCandidates) ? (poseGalleryAsset as any).poseCandidates : []
          const gVariants: any[] = Array.isArray((poseGalleryAsset as any)?.poseVariants) ? (poseGalleryAsset as any).poseVariants : []
          return (
            <div className="story-lock-gallery-overlay" role="dialog" aria-modal="true" aria-label="姿势变体图片管理">
              <div className="story-lock-gallery-card">
                <div className="story-lock-gallery-head">
                  <div>
                    <div className="story-lock-workspace-log-title">姿势变体图片管理</div>
                    <div className="hint">{gName}</div>
                  </div>
                  <button className="icon-btn" type="button" onClick={props.onPoseGalleryClose} aria-label="关闭姿势图片管理" title="关闭">✕</button>
                </div>
                <div className="story-lock-gallery-summary">
                  <span className="ai-storyboard-status ok">候选 {gCands.length} 张</span>
                  <span className="ai-storyboard-status ok">已锁定 {gVariants.length} 个</span>
                  <span className="hint">删除候选只移出候选池；删除已锁定变体若正被摆放引用会被阻断。图片文件均保留在磁盘。</span>
                </div>
                <div style={{ overflow: 'auto', display: 'grid', gap: 16, alignContent: 'start', paddingRight: 4 }}>
                  <div>
                    <div className="story-lock-gallery-kind" style={{ margin: '2px 0 8px' }}>候选（未锁定）</div>
                    {gCands.length ? (
                      <div className="story-lock-gallery-grid">
                        {gCands.map((c: any, idx: number) => {
                          const cPath = String(c?.assetPath || '').trim()
                          const cSrc = toProjectAssetUrl(projectId, cPath)
                          const badge = poseScoreBadgeOf(c)
                          return (
                            <div className="story-lock-gallery-item" key={cPath || idx}>
                              <div className={`ai-storyboard-asset-candidate-preview ${cSrc ? 'ready' : 'missing'}`}>
                                {cSrc ? <img src={cSrc} alt={`姿势候选 ${idx + 1}`} /> : <div className="hint">图片不可用</div>}
                              </div>
                              <div className="story-lock-gallery-meta">
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                                  <span className="story-lock-gallery-kind">候选 {idx + 1}</span>
                                  <span className="pose-pool-score" style={{ position: 'static', color: badge.color }} title={String(c?.reason || '未评分')}>{badge.text}</span>
                                </div>
                                <div className="hint">{formatGalleryTime(String(c?.createdAt || '')) || '时间未知'}</div>
                                <div className="story-lock-gallery-actions">
                                  <button className="btn secondary" type="button" onClick={() => window.open(cSrc, '_blank', 'noopener,noreferrer')} disabled={!cSrc}>查看大图</button>
                                  <button className="btn secondary" type="button" disabled={Boolean(props.poseGeneratingId || props.poseReviewingId || props.poseLockingKey || props.poseReqBusyId || props.assetPlanBusy) || !cPath} onClick={() => props.onPoseDeleteCandidate?.(gAssetId, cPath)}>删除</button>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="hint">暂无候选。</div>
                    )}
                  </div>
                  <div>
                    <div className="story-lock-gallery-kind" style={{ margin: '2px 0 8px' }}>已锁定变体</div>
                    {gVariants.length ? (
                      <div className="story-lock-gallery-grid">
                        {gVariants.map((v: any, idx: number) => {
                          const vSrc = toProjectAssetUrl(projectId, String(v?.projectAssetUri || v?.cutoutPath || '').trim())
                          return (
                            <div className="story-lock-gallery-item" key={String(v?.id || idx)}>
                              <div className={`ai-storyboard-asset-candidate-preview ${vSrc ? 'ready' : 'missing'}`}>
                                {vSrc ? <img src={vSrc} alt={String(v?.name || `姿势 ${idx + 1}`)} /> : <div className="hint">图片不可用</div>}
                              </div>
                              <div className="story-lock-gallery-meta">
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                                  <span className="story-lock-gallery-kind">{String(v?.name || `姿势 ${idx + 1}`)}</span>
                                  {Number.isFinite(Number(v?.score)) ? <span className="hint">评分 {Math.round(Number(v.score))} 分</span> : null}
                                </div>
                                <div className="hint">{formatGalleryTime(String(v?.createdAt || '')) || '时间未知'}</div>
                                <div className="story-lock-gallery-actions">
                                  <button className="btn secondary" type="button" onClick={() => window.open(vSrc, '_blank', 'noopener,noreferrer')} disabled={!vSrc}>查看大图</button>
                                  <button
                                    className="btn secondary"
                                    type="button"
                                    disabled={Boolean(props.poseGeneratingId || props.poseReviewingId || props.poseLockingKey || props.assetPlanBusy)}
                                    onClick={() => void (async () => {
                                      const res = await props.onPoseDeleteVariant?.(gAssetId, String(v?.id || ''))
                                      if (res && !res.ok) void dlgAlert(String(res.message || '该姿势变体正被摆放引用，无法删除'))
                                    })()}
                                  >
                                    删除
                                  </button>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="hint">暂无已锁定变体。</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )
        })() : null}

        {/* ============ 2026-09-02 二级资产详情弹层 → 2026-10-27 升级为「元素出图工作区」（用户裁决：出图管理总览层逐元素工作区） ============ */}
        {detailAsset ? (() => {
          const dAsset = detailAsset
          const dAid = String(dAsset?.id || '').trim()
          const dStatus = assetLockStatusOf(dAsset, props.assetPromptDrafts as any)
          const dIsCharacter = String(dAsset?.category || '') === 'character'
          const dIsLocation = String(dAsset?.category || '') === 'location'
          // 标准系三视图已从默认生产 UI 退役，历史数据仅保留兼容
          const dHasSheet = false
          const dStrategy = String(dAsset?.renderStrategy || '').trim()
          const dDraft = (props.assetPromptDrafts && (props.assetPromptDrafts as any)[dAid]) || {}
          const dPromptReview = dDraft.promptReview && typeof dDraft.promptReview === 'object' ? dDraft.promptReview : null
          const dPromptMissing = [
            !String(dDraft.promptZh || '').trim() ? '正向中文' : '',
            !String(dDraft.promptEn || '').trim() ? '正向英文' : '',
            !String(dDraft.negativePromptZh || '').trim() ? '反向中文' : '',
            !String(dDraft.negativePrompt || '').trim() ? '反向英文' : ''
          ].filter(Boolean)
          const dPromptAiAt = String(dDraft.enhanceMode || '') === 'ai' ? String(dDraft.enhancedAt || '').trim() : ''
          const dPromptTranslatedAt = String(dDraft.translatedAt || '').trim()
          const dPromptSource = [
            dPromptAiAt ? `AI 已生成（${formatGalleryTime(dPromptAiAt) || dPromptAiAt}）` : '',
            dPromptTranslatedAt ? `已翻译（${formatGalleryTime(dPromptTranslatedAt) || dPromptTranslatedAt}）` : ''
          ].filter(Boolean).join(' · ') || (dStrategy && dStrategy !== 'ref_required' ? '计划已有锚点（无本页 AI 生成/翻译记录）' : '已有草稿（无本页 AI 生成/翻译记录）')
          const dStages = assetFiveStagesOf(dAsset, props.assetPromptDrafts as any)
          const dSheetViews = Array.isArray(dAsset?.modelSheet?.views) ? dAsset.modelSheet.views : []
          const dSheetLocked = dSheetViews.filter((v: any) => String(v?.lockedAt || '').trim()).length
          const dPrimaryLocked = Boolean(String(dAsset?.primaryReferenceAssetUri || '').trim() || String(dAsset?.primaryReferenceAssetId || '').trim())
          const dLocationSceneIds = dIsLocation ? locationSceneIdsOf(dAsset, planScenes) : []
          const dLocationImage = dIsLocation ? assetCardImageOf(dAsset, projectId) : ''
          const dLocationReady = Boolean(String(dDraft.promptZh || dDraft.promptEn || dAsset?.anchorPrompt || dAsset?.referencePromptEn || '').trim())
          const navItems = dIsLocation ? [
            { key: 'prompt', label: '提示词', anchor: `detail-sec-prompt-${dAid}` },
            { key: 'ref', label: '环境锚点', anchor: `detail-sec-ref-${dAid}` },
            { key: 'scenes', label: '使用场景', anchor: `detail-sec-scenes-${dAid}` }
          ] : [
            { key: 'prompt', label: '提示词', anchor: `detail-sec-prompt-${dAid}` },
            { key: 'ref', label: '主参考与变体', anchor: `detail-sec-ref-${dAid}` },
            ...(dHasSheet ? [{ key: 'sheet', label: '标准系三视图', anchor: `detail-sec-sheet-${dAid}` }] : []),
            { key: 'lineart', label: '线稿', anchor: `detail-sec-lineart-${dAid}` },
            { key: 'done', label: '完成态', anchor: `detail-sec-done-${dAid}` },
            ...(dIsCharacter ? [{ key: 'pose', label: '姿势变体', anchor: `pose-asset-${dAid}` }] : [{ key: 'state', label: '状态变体', anchor: `state-asset-${dAid}` }])
          ]
          const scrollToAnchor = (anchor: string) => {
            if (dIsCharacter) setPoseExpanded((prev) => ({ ...prev, [dAid]: true }))
            else if (!dIsLocation) setStateExpanded((prev) => ({ ...prev, [dAid]: true }))
            window.setTimeout(() => {
              try { document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch {}
            }, 80)
          }
          return (
            <DetailWorkspace
              ariaLabel={dIsLocation ? '地点模板管理' : '元素出图工作区'}
              title={<span className={dIsLocation ? 'location-template-title' : ''}>{String(dAsset?.name || dAid || '未命名资产')}</span>}
              badges={(
                <>
                  <span className="story-lock-thing-cat">{dIsLocation ? '地点模板' : getAssetCategoryLabel(String(dAsset?.category || ''))}</span>
                  <span className={`story-lock-thing-status ${dIsLocation ? (dLocationReady ? 'locked' : 'draft') : dStatus.tone}`}>{dIsLocation ? (dLocationReady ? '锚点就绪' : '待起草') : dStatus.label}</span>
                  {!dIsLocation ? (
                    <span className="story-lock-five-stages" title={dStages.map((s) => `${s.label}:${s.tone === 'done' ? '已完成' : s.tone === 'partial' ? '进行中' : '未开始'}`).join(' · ')}>
                      {dStages.map((s) => (
                        <span key={s.key} className={`story-lock-stage-dot ${s.tone}`} />
                      ))}
                    </span>
                  ) : null}
                </>
              )}
              previousDisabled={detailNavAssets.length < 2}
              nextDisabled={detailNavAssets.length < 2}
              onPrevious={() => detailNav(-1)}
              onNext={() => detailNav(1)}
              onClose={() => { setDetailAssetId(''); setDetailAnchor('') }}
              navItems={navItems.map((it) => ({
                ...it,
                active: detailAnchor === it.key,
                onClick: () => { setDetailAnchor(it.key); scrollToAnchor(it.anchor) }
              }))}
            >
                  <div className="story-lock-detail-lead">
                    <div id={`detail-sec-prompt-${dAid}`} className="story-lock-detail-sec">
                      <div className="story-lock-detail-sec-title">提示词摘要</div>
                      <div className="story-lock-prompt-summary">
                        <div className="hint" data-testid="prompt-detail-source"><b>来源与状态</b>：{dPromptSource}</div>
                        <div className="hint" data-testid="prompt-detail-completeness"><b>内容缺口</b>：{dPromptMissing.length ? dPromptMissing.join('、') : '无，四个字段均已有内容'}</div>
                        {dPromptReview ? (
                          <div className="hint" data-testid="prompt-detail-review">
                            <div><b>AI 评审</b>：{dPromptReview.score != null && Number.isFinite(Number(dPromptReview.score)) ? `${Math.round(Number(dPromptReview.score))}/100` : '未评分'}</div>
                            {dPromptReview.summary ? <div>评语：{String(dPromptReview.summary)}</div> : null}
                            {Array.isArray(dPromptReview.strengths) && dPromptReview.strengths.length ? <div>优点：{dPromptReview.strengths.map(String).join('；')}</div> : null}
                            {Array.isArray(dPromptReview.risks) && dPromptReview.risks.length ? <div>风险：{dPromptReview.risks.map(String).join('；')}</div> : null}
                            {Array.isArray(dPromptReview.suggestions) && dPromptReview.suggestions.length ? <div>建议：{dPromptReview.suggestions.map(String).join('；')}</div> : null}
                          </div>
                        ) : null}
                        <div className="hint"><b>正向·中</b>：{String(dDraft.promptZh || '').trim() || '（未起草）'}</div>
                        <div className="hint"><b>正向·英</b>：{String(dDraft.promptEn || '').trim() || '（未翻译）'}</div>
                        <div className="hint"><b>反向·中</b>：{String(dDraft.negativePromptZh || '').trim() || '（未起草）'}</div>
                        <div className="hint"><b>反向·英</b>：{String(dDraft.negativePrompt || '').trim() || '（未翻译）'}</div>
                        <button
                          className="btn secondary"
                          type="button"
                          style={{ justifySelf: 'start', padding: '3px 12px', fontSize: 12 }}
                          onClick={() => {
                            setDetailAssetId('')
                            setDetailAnchor('')
                            setViewModeOverride('steps')
                            setWizardStep(4)
                            window.setTimeout(() => {
                              const card = document.getElementById(`asset-prompt-${dAid}`)
                              card?.scrollIntoView({ block: 'center' })
                              card?.focus({ preventScroll: true })
                            }, 120)
                          }}
                        >
                          去第 4 步编辑提示词
                        </button>
                      </div>
                    </div>

                    {dIsLocation ? (
                      <>
                        <div id={`detail-sec-ref-${dAid}`} className="story-lock-detail-sec">
                          <div className="story-lock-detail-sec-title">环境锚点与可选参考图</div>
                          <div className="location-template-detail">
                            <div className="hint"><b>锚点词</b>：{String(dAsset?.anchorPrompt || dAsset?.referencePromptHint || '').trim() || '（无）'}</div>
                            <div className="hint">环境提示词用于每幕场景背景；地点模板不要求独立抽卡、线稿或完成态。</div>
                            {dLocationImage ? (
                              <>
                                <div className="location-template-reference"><img src={dLocationImage} alt={`${String(dAsset?.name || dAid)}参考图`} /></div>
                                <div><button type="button" className="btn secondary" disabled={props.assetPlanBusy} onClick={() => props.onOpenAssetGallery(dAid)}>管理已有参考图</button></div>
                              </>
                            ) : <div className="hint">当前没有独立参考图，不影响用于场景出图。</div>}
                          </div>
                        </div>
                        <div id={`detail-sec-scenes-${dAid}`} className="story-lock-detail-sec">
                          <div className="story-lock-detail-sec-title">使用场景（{dLocationSceneIds.length}）</div>
                          <div className="location-template-scenes">
                            {dLocationSceneIds.map((sceneId) => (
                              <button key={sceneId} type="button" className="btn secondary" onClick={() => {
                                setDetailAssetId('')
                                setDetailAnchor('')
                                setStep5Scope('scenes')
                                setSceneFocus((prev) => ({ id: sceneId, requestId: (prev?.requestId || 0) + 1 }))
                              }}>
                                用于：{String(planScenes.find((scene) => String(scene?.sceneId || '') === sceneId)?.sceneName || sceneId)}
                              </button>
                            ))}
                            {!dLocationSceneIds.length ? (
                              <button type="button" className="btn secondary" disabled={!planScenes.length} onClick={() => {
                                const edit = props.sceneBoard?.props.onEditSceneAssets
                                if (edit) edit(String(planScenes[0]?.sceneId || ''))
                                else void dlgAlert('请返回蓝图选择场景后分配要素。')
                              }}>去蓝图分配场景</button>
                            ) : null}
                          </div>
                          {!dLocationSceneIds.length ? <div className="hint" style={{ marginTop: 8 }}>未分配场景。地点模板会保留，可在蓝图的任意一幕分配后使用。</div> : null}
                        </div>
                      </>
                    ) : (
                      <div id={`detail-sec-ref-${dAid}`} className="story-lock-detail-sec">
                        <div className="story-lock-detail-sec-title">主参考与姿态/状态变体</div>
                        {renderAssetRefRow(dAsset)}
                      </div>
                    )}
                  </div>

                      {/* 区 3：标准系三视图（R 波服务端链落地；T 波扩道具）——角色/道具出，地点不出 */}
                      {dHasSheet ? (
                        <div id={`detail-sec-sheet-${dAid}`} className="story-lock-detail-sec">
                          <div className="story-lock-detail-sec-title">标准系三视图（正/侧/背）</div>
                          {!dPrimaryLocked ? (
                            <div className="hint" style={{ color: '#fde68a' }}>先锁定主参考，再生成标准系三视图（三视图以已锁主参考为身份锚）。</div>
                          ) : (
                            (() => {
                              // U 波项 4（2026-10-28 用户实测：图像占满 UI 太占地）：三视图改左右布局——
                              // 左栏主图（限高，点击进图片管理看大图）+缩略图横排切视角；右栏操作面板（状态/评审/按钮+摘要入口）。
                              // Z 波：sheet 栏序待人工指定（评审通道死时兜底，明面执行不猜）
                              const dSheetPending = (Array.isArray((dAsset as any)?.modelSheet?.pendingCells) ? (dAsset as any).modelSheet.pendingCells : []) as any[]
                              const assignSel = sheetAssignByAsset[dAid] || {}
                              const assignReady = dSheetPending.length >= 3 && ['0', '1', '2'].every((k) => ['front', 'side', 'back'].includes(String(assignSel[k] || ''))) && new Set(['0', '1', '2'].map((k) => String(assignSel[k] || ''))).size === 3
                              const focusKey = (sheetFocusByAsset[dAid] as 'front' | 'side' | 'back') || 'front'
                              const viewOf = (k: string) => dSheetViews.find((v: any) => String(v?.key || '') === k)
                              const focusView = viewOf(focusKey)
                              const focusLocked = Boolean(String(focusView?.lockedAt || '').trim())
                              const focusHas = Boolean(String(focusView?.assetUri || '').trim())
                              const focusLabel = focusKey === 'front' ? '正面' : focusKey === 'side' ? '侧面' : '背面'
                              const sheetBusy = props.modelSheetBusyId === dAid
                              const statusOf = (view: any, vk: string) => {
                                const locked = Boolean(String(view?.lockedAt || '').trim())
                                const hasCandidate = Boolean(String(view?.assetUri || '').trim())
                                if (locked) return '已锁定'
                                if (!hasCandidate) return '待生成'
                                if (String(view?.prevLockedAt || '').trim()) return '重出待锁'
                                if (view?.reviewStatus === 'pending') return '评审挂起·待人工复核'
                                if (view?.reviewStatus === 'rejected') return `评审未过 ${Number(view?.score) || 0} 分`
                                if (Number.isFinite(Number(view?.score))) return `评审 ${Number(view.score)} 分`
                                return vk === 'front' ? '同源主参考' : '待复核'
                              }
                              return (
                                <>
                                  <div className="hint" style={{ marginBottom: 8 }}>
                                    逐视角生成单图（侧面/背面走骨架约束+身份锚定+配色一致评审）；逐张人工锁定后生效；姿势变体出图按视角语义自动吃对应锁定视图。
                                    {dSheetViews.some((v: any) => String(v?.lockedAt || '').trim()) ? <span style={{ color: '#5eccff' }}> 已锁 {dSheetLocked}/3。</span> : null}
                                    {dSheetViews.some((v: any) => String(v?.prevLockedAt || '').trim() && !String(v?.lockedAt || '').trim()) ? <span style={{ color: '#fde68a' }}> 有视角重出待锁（旧锁定图保留在图片管理可查）。</span> : null}
                                  </div>
                                  {/* AA 波（sheet 整图即标准系）：有 sheet 候选时整图大卡优先——正/侧/背同图同源；逐视角小卡仅 fallback 链产物时显示 */}
                                  {(() => {
                                    const sheetUri = String((dAsset as any)?.modelSheet?.sheetAssetUri || '').trim()
                                    if (!sheetUri) return null
                                    const sheetLocked = Boolean(String((dAsset as any)?.modelSheet?.sheetLockedAt || '').trim())
                                    const sheetScore = Number((dAsset as any)?.modelSheet?.sheetReviewScore)
                                    const sheetStatus = String((dAsset as any)?.modelSheet?.sheetReviewStatus || '')
                                    const sheetReason = String((dAsset as any)?.modelSheet?.sheetReviewReason || '').trim()
                                    const statusLabel = sheetLocked
                                      ? '已锁定'
                                      : sheetStatus === 'rejected'
                                        ? `评审未过 ${Number.isFinite(sheetScore) ? sheetScore : 0} 分`
                                        : sheetStatus === 'pending'
                                          ? '评审挂起·待人工复核'
                                          : Number.isFinite(sheetScore)
                                            ? `评审 ${sheetScore} 分`
                                            : '待复核'
                                    return (
                                      <div style={{ marginBottom: 10 }}>
                                        <div className="hint" style={{ marginBottom: 6 }}>
                                          标准系 sheet（正/侧/背同图同源；整图评审：视角齐全+身份+配色+底纯）。
                                          {sheetLocked ? <span style={{ color: '#5eccff' }}> 已锁定，姿势变体出图吃本 sheet。</span> : null}
                                        </div>
                                        <div className="story-lock-sheet2" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)' }}>
                                          <div className="story-lock-sheet2-left">
                                            <button
                                              type="button"
                                              className={`story-lock-sheet2-main ready`}
                                              style={{ maxHeight: 260 }}
                                              title="点击进入图片管理查看大图"
                                              onClick={() => props.onPoseGalleryOpen?.(dAid)}
                                            >
                                              <img src={toProjectAssetUrl(projectId || '', sheetUri)} alt="标准系 sheet" style={{ maxHeight: 260 }} />
                                            </button>
                                          </div>
                                          <div className="story-lock-sheet2-ops">
                                            <div className="story-lock-thing-meta">
                                              <span className="story-lock-thing-cat">整 sheet</span>
                                              <span className={`story-lock-thing-status ${sheetLocked ? 'locked' : 'draft'}`} title={sheetReason}>{statusLabel}</span>
                                            </div>
                                            {sheetReason ? <div className="hint" style={{ fontSize: 12 }}>评审：{sheetReason.slice(0, 90)}</div> : null}
                                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                              <button
                                                className="btn secondary"
                                                type="button"
                                                disabled={props.modelSheetBusyId === dAid}
                                                title="重新生成整 sheet（charturn 主导整图三栏；旧 sheet 留图片管理历史）"
                                                onClick={() => props.onModelSheetGenerate?.(dAid, undefined, 'sheet')}
                                              >
                                                {props.modelSheetBusyId === dAid ? '生成中…' : '重出 sheet'}
                                              </button>
                                              {!sheetLocked ? (
                                                <button
                                                  className="btn secondary"
                                                  type="button"
                                                  disabled={props.modelSheetBusyId === dAid}
                                                  title="人工确认整 sheet 可用并锁定（写入 lock_confirm 审核留痕）；锁定后姿势变体吃本 sheet"
                                                  onClick={() => props.onModelSheetLock?.(dAid, 'sheet' as any)}
                                                >
                                                  锁定 sheet
                                                </button>
                                              ) : null}
                                            </div>
                                          </div>
                                        </div>
                                      </div>
                                    )
                                  })()}
                                  {dSheetPending.length >= 3 ? (
                                    <div className="story-lock-sheet2">
                                      <div className="story-lock-sheet2-left" style={{ gridColumn: '1 / -1' }}>
                                        <div className="hint" style={{ color: '#fde68a', marginBottom: 8 }}>
                                          sheet 已生成并切割为三栏；评审通道不可用，栏序需人工指定（看图指定各栏视角后写入）。
                                        </div>
                                        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                                          {dSheetPending.map((cell: any) => {
                                            const ci = String(cell?.index ?? '')
                                            return (
                                              <div key={ci} style={{ display: 'grid', gap: 4, justifyItems: 'center' }}>
                                                <img src={toProjectAssetUrl(projectId || '', String(cell?.assetUri || ''))} alt={`栏 ${Number(ci) + 1}`} style={{ maxHeight: 160, maxWidth: 110, objectFit: 'contain', borderRadius: 8, border: '1px solid rgba(148,163,184,0.18)' }} />
                                                <select
                                                  className="sel"
                                                  style={{ fontSize: 12, padding: '3px 6px' }}
                                                  value={String(assignSel[ci] || '')}
                                                  onChange={(e) => setSheetAssignByAsset((prev) => ({ ...prev, [dAid]: { ...(prev[dAid] || {}), [ci]: e.target.value } }))}
                                                >
                                                  <option value="">栏 {Number(ci) + 1} 视角…</option>
                                                  <option value="front">正面</option>
                                                  <option value="side">侧面</option>
                                                  <option value="back">背面</option>
                                                </select>
                                              </div>
                                            )
                                          })}
                                        </div>
                                        <div style={{ marginTop: 8 }}>
                                          <button
                                            className="btn secondary"
                                            type="button"
                                            disabled={!assignReady || props.modelSheetBusyId === dAid}
                                            title="确认三栏视角指定并写入三视图（写入后逐张可锁定）"
                                            onClick={() => {
                                              props.onModelSheetAssign?.(dAid, { '0': assignSel['0'], '1': assignSel['1'], '2': assignSel['2'] } as Record<string, 'front' | 'side' | 'back'>)
                                              setSheetAssignByAsset((prev) => ({ ...prev, [dAid]: {} }))
                                            }}
                                          >
                                            确认指定并写入
                                          </button>
                                        </div>
                                      </div>
                                    </div>
                                  ) : null}
                                  <div className="story-lock-sheet2">
                                    <div className="story-lock-sheet2-left">
                                      <button
                                        type="button"
                                        className={`story-lock-sheet2-main ${focusHas ? 'ready' : 'missing'}`}
                                        title={focusHas ? '点击进入图片管理查看大图' : '该视角还没有候选图'}
                                        disabled={!focusHas}
                                        onClick={() => props.onPoseGalleryOpen?.(dAid)}
                                      >
                                        {focusHas ? <img src={toProjectAssetUrl(projectId || '', String(focusView.assetUri))} alt={focusLabel} /> : <span className="hint">待生成</span>}
                                      </button>
                                      <div className="story-lock-sheet2-thumbs">
                                        {(['front', 'side', 'back'] as const).map((vk) => {
                                          const v = viewOf(vk)
                                          const has = Boolean(String(v?.assetUri || '').trim())
                                          const vLabel = vk === 'front' ? '正面' : vk === 'side' ? '侧面' : '背面'
                                          const locked = Boolean(String(v?.lockedAt || '').trim())
                                          return (
                                            <button
                                              key={vk}
                                              type="button"
                                              className={`story-lock-sheet2-thumb ${focusKey === vk ? 'active' : ''}`}
                                              title={`${vLabel} · ${statusOf(v, vk)}`}
                                              onClick={() => setSheetFocusByAsset((prev) => ({ ...prev, [dAid]: vk }))}
                                            >
                                              {has ? <img src={toProjectAssetUrl(projectId || '', String(v.assetUri))} alt={vLabel} /> : <span className="hint">—</span>}
                                              <span className="story-lock-sheet2-thumb-label">{vLabel}{locked ? '·锁' : ''}</span>
                                            </button>
                                          )
                                        })}
                                      </div>
                                    </div>
                                    <div className="story-lock-sheet2-ops">
                                      <div className="story-lock-thing-meta">
                                        <span className="story-lock-thing-cat">{focusLabel}</span>
                                        <span className={`story-lock-thing-status ${focusLocked ? 'locked' : 'draft'}`} title={String(focusView?.reason || '')}>{statusOf(focusView, focusKey)}</span>
                                      </div>
                                      {String(focusView?.reason || '').trim() ? <div className="hint" style={{ fontSize: 12 }}>评审：{String(focusView.reason).slice(0, 80)}</div> : null}
                                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                        {focusKey === 'front' ? (
                                          <button
                                            className="btn secondary"
                                            type="button"
                                            disabled={sheetBusy}
                                            title="正面视角不允许生成（采样必漂）——front 永远=主参考登记；点此把当前主参考同步进三视图正面位并锁定"
                                            onClick={() => props.onModelSheetGenerate?.(dAid, ['front'], 'per-view')}
                                          >
                                            {sheetBusy ? '同步中…' : '同步主参考'}
                                          </button>
                                        ) : (
                                          <button
                                            className="btn secondary"
                                            type="button"
                                            disabled={sheetBusy}
                                            title={focusHas ? '重新生成该视角（新候选需重新人工锁定）' : '生成该视角单图（骨架约束+一致性评审）'}
                                            onClick={() => props.onModelSheetGenerate?.(dAid, [focusKey], 'per-view')}
                                          >
                                            {sheetBusy ? '生成中…' : focusHas ? '再出一张' : '生成'}
                                          </button>
                                        )}
                                        {focusKey !== 'front' && focusHas && !focusLocked ? (
                                          <button
                                            className="btn secondary"
                                            type="button"
                                            disabled={sheetBusy}
                                            title="人工确认该视角候选可用并锁定（写入 lock_confirm 审核留痕）；锁定后姿势变体按视角语义吃本图"
                                            onClick={() => props.onModelSheetLock?.(dAid, focusKey)}
                                          >
                                            锁定
                                          </button>
                                        ) : null}
                                        <button
                                          className="btn secondary"
                                          type="button"
                                          disabled={sheetBusy}
                                          title="侧面/背面逐视角串行生成（正面恒为主参考登记不生成）；已有候选的视角会被新候选覆盖（需重新锁定）"
                                          onClick={() => props.onModelSheetGenerate?.(dAid, ['side', 'back'], 'per-view')}
                                        >
                                          一次生成侧/背
                                        </button>
                                      </div>
                                      <div className="hint" style={{ fontSize: 12 }}>
                                        摘要：<button type="button" className="story-lock-mini-btn" onClick={() => { setDetailAnchor('lineart'); scrollToAnchor(`detail-sec-lineart-${dAid}`) }}>线稿区</button>
                                        {' '}<button type="button" className="story-lock-mini-btn" onClick={() => { setDetailAnchor('done'); scrollToAnchor(`detail-sec-done-${dAid}`) }}>完成态清单</button>
                                      </div>
                                    </div>
                                  </div>
                                  {(() => {
                                    const runs = (Array.isArray((dAsset as any)?.modelSheet?.testRuns) ? (dAsset as any).modelSheet.testRuns : []) as any[]
                                    const latestRuns = runs.slice(-12).reverse()
                                    if (!latestRuns.length) return null
                                    return (
                                      <details style={{ marginTop: 10 }}>
                                        <summary className="hint" style={{ cursor: 'pointer' }}>A/B 试验记录（{latestRuns.length} 组，不影响正式锁定）</summary>
                                        <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
                                          {latestRuns.map((run: any) => (
                                            <div key={String(run.runId)} style={{ border: '1px solid rgba(148,163,184,0.18)', borderRadius: 8, padding: 8 }}>
                                              <div className="hint" style={{ marginBottom: 6 }}>
                                                {run.engine === 'mvadapter' ? 'MV-Adapter' : 'CharTurn'} · seed {run.seed ?? '随机'} · {run.status === 'reviewed' ? '已评审' : run.status === 'rejected' ? '评审打回' : run.status === 'pending' ? '待复核' : '生成失败'}
                                                {run.createdAt ? ` · ${formatGalleryTime(String(run.createdAt))}` : ''}
                                              </div>
                                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                                                {(['front', 'side', 'back'] as const).map((key) => {
                                                  const view = key === 'front'
                                                    ? { assetUri: String(run.primaryReferenceAssetUri || dAsset?.primaryReferenceAssetUri || ''), reviewStatus: 'skipped' }
                                                    : (Array.isArray(run.views) ? run.views : []).find((item: any) => String(item?.key || item?.view || '') === key)
                                                  const label = key === 'front' ? '正面·主参考' : key === 'side' ? '侧面' : '背面'
                                                  const uri = String(view?.assetUri || '')
                                                  return (
                                                    <div key={`${run.runId}-${key}`} title={String(view?.reason || '')}>
                                                      <div style={{ height: 150, display: 'grid', placeItems: 'center', background: 'rgba(255,255,255,0.04)', borderRadius: 6, overflow: 'hidden' }}>
                                                        {uri ? <img src={toProjectAssetUrl(projectId || '', uri)} alt={label} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span className="hint">无候选</span>}
                                                      </div>
                                                      <div className="hint" style={{ fontSize: 12, marginTop: 4 }}>
                                                        {label}{Number.isFinite(Number(view?.score)) ? ` · ${Number(view.score)} 分` : ''}{Number.isFinite(Number(view?.bgPurity)) ? ` · 白底 ${Math.round(Number(view.bgPurity) * 100)}%` : ''}
                                                      </div>
                                                    </div>
                                                  )
                                                })}
                                              </div>
                                              {run.error ? <div className="hint" style={{ color: '#fca5a5', marginTop: 4 }}>{String(run.error)}</div> : null}
                                            </div>
                                          ))}
                                        </div>
                                      </details>
                                    )
                                  })()}
                                </>
                              )
                            })()
                          )}
                        </div>
                      ) : null}

                      {/* 区 4：线稿区（地点不显示） */}
                      {!dIsLocation ? (
                        <div id={`detail-sec-lineart-${dAid}`} className="story-lock-detail-sec">
                          <div className="story-lock-detail-sec-title">线稿</div>
                          {renderAssetLineartRow(dAsset)}
                        </div>
                      ) : null}

                  {!dIsLocation ? (
                    <div id={`detail-sec-done-${dAid}`} className="story-lock-detail-sec">
                      <div className="story-lock-detail-sec-title">完成态</div>
                      <div className="story-lock-prompt-summary">
                        {dStages.map((s) => (
                          <div key={s.key} className="hint" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span className={`story-lock-stage-dot ${s.tone}`} />
                            <span>{s.label}：{s.tone === 'done' ? '已完成' : s.tone === 'partial' ? '进行中' : '未开始'}</span>
                          </div>
                        ))}
                        {dStages.every((s) => s.tone === 'done') ? (
                          <div className="hint" style={{ color: '#86efac' }}>✓ 该元素出图准备全部完成</div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
            </DetailWorkspace>
          )
        })() : null}

        {/* ============ 2026-09-02 右侧配置 drawer（全局提示词四格复用 renderGlobalPromptSections；模型/接口/采样只读摘要） ============ */}
        {drawerOpen ? (
          <div className="story-lock-drawer-mask" onClick={() => setDrawerOpen(false)}>
            <div className="story-lock-drawer" role="dialog" aria-modal="true" aria-label="配置" onClick={(e) => e.stopPropagation()}>
              <div className="story-lock-drawer-head">
                <div style={{ fontWeight: 700 }}>配置</div>
                <button type="button" className="icon-btn" onClick={() => setDrawerOpen(false)} aria-label="关闭配置" title="关闭">✕</button>
              </div>
              <div className="story-lock-drawer-body">
                <div className="story-lock-detail-sec">
                  <div className="story-lock-detail-sec-title">全局提示词</div>
                  {renderGlobalPromptSections()}
                </div>
                {/* 2026-09-10 公共提示词库入口（替代原硬编码预设下拉）：跨项目共享，可插入可回存 */}
                <div className="story-lock-detail-sec">
                  <div className="story-lock-detail-sec-title">公共提示词库</div>
                  <div className="story-lock-drawer-preset-row">
                    <button className="btn secondary" type="button" onClick={() => openPromptLibrary(globalPromptLibTarget('positive'))}>插入到「全局正向」</button>
                    <button className="btn secondary" type="button" onClick={() => openPromptLibrary(globalPromptLibTarget('negative'))}>插入到「全局负向」</button>
                  </div>
                  <div className="hint">跨项目共享的提示词片段库：选择正/负向已存片段去重追加到对应中英文栏；每个提示词输入旁的「公共提示词/公共库」按钮也可打开，并可把当前内容存回库中。保存/翻译闸门不变（步骤模式第 4 步）。</div>
                </div>
                <div className="story-lock-detail-sec">
                  <div className="story-lock-detail-sec-title">模型与接口</div>
                  <div className="story-lock-drawer-kv"><span>文本模型</span><span>{String(props.openChecks?.promptProvider || '-')} / {String(props.openChecks?.promptModel || '-')}</span></div>
                  <div className="story-lock-drawer-kv"><span>出图</span><span>{String(props.openChecks?.imageProvider || '-')} / {String(props.openChecks?.imageModel || '-')}</span></div>
                </div>
                <div className="story-lock-detail-sec">
                  <div className="story-lock-detail-sec-title">采样参数（只读，编辑在场景出图车间）</div>
                  <div className="story-lock-drawer-kv"><span>Checkpoint</span><span>{String(props.value?.model || '-') || '-'}</span></div>
                  <div className="story-lock-drawer-kv"><span>LoRA</span><span>{configuredLoras.length ? configuredLoras.join(' | ') : '(none)'}</span></div>
                  <div className="story-lock-drawer-kv"><span>步数 / CFG</span><span>{Number(props.value?.steps || 0) || '-'} / {Number(props.value?.cfgScale || 0) || '-'}</span></div>
                </div>
                {/* 2026-09-02 出图 LoRA 挂载管理：ComfyUI models 拉可用列表，settings image.loras 读写（只改该字段） */}
                <div className="story-lock-detail-sec">
                  <div className="story-lock-detail-sec-title">出图 LoRA</div>
                  <div className="hint">LoRA 作用于全部出图（角色立绘/道具/背景）。当前验证默认：flat_childrenXX 0.7。</div>
                  {loraLoading ? <div className="hint">加载 LoRA 列表中…</div> : null}
                  {loraError ? <div className="story-lock-drawer-err" role="alert">{loraError}</div> : null}
                  {!loraLoading && !loraError && loraAvailable.length === 0 ? <div className="hint">ComfyUI 不在线或无可用 LoRA</div> : null}
                  {loraMounted.length ? (
                    <div className="story-lock-lora-list">
                      {loraMounted.map((entry, idx) => {
                        const parsed = parseLoraEntry(entry)
                        return (
                          <div className="story-lock-lora-item" key={`${parsed.file}_${idx}`}>
                            <span className="story-lock-lora-name" title={parsed.file}>{parsed.file}</span>
                            <input
                              type="number"
                              step="0.05"
                              min="0"
                              max="1.5"
                              value={parsed.strength || '0.8'}
                              title="模型强度（0-1.5）"
                              onChange={(e) => {
                                const v = e.target.value
                                setLoraMounted((prev) => prev.map((x, i) => (i === idx ? formatLoraEntry(parsed.file, v, parsed.clip) : x)))
                              }}
                            />
                            <button
                              type="button"
                              className="icon-btn danger"
                              title="移除该 LoRA（保存后生效）"
                              onClick={() => setLoraMounted((prev) => prev.filter((_, i) => i !== idx))}
                            >
                              ✕
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="hint">当前未挂载 LoRA</div>
                  )}
                  <div className="story-lock-lora-add">
                    <select className="sel" value={loraAddFile} onChange={(e) => setLoraAddFile(e.target.value)}>
                      <option value="">选择 LoRA 文件…</option>
                      {loraAvailable
                        .filter((f) => !loraMounted.some((m) => parseLoraEntry(m).file === f))
                        .map((f) => (
                          <option key={f} value={f}>{f}</option>
                        ))}
                    </select>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1.5"
                      value={loraAddStrength}
                      title="强度（默认 0.7，范围 0-1.5）"
                      onChange={(e) => setLoraAddStrength(Number(e.target.value))}
                    />
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={!loraAddFile || loraMounted.length >= 8}
                      onClick={() => {
                        const s = Number.isFinite(Number(loraAddStrength)) ? String(Math.max(0, Math.min(1.5, Number(loraAddStrength)))) : '0.7'
                        setLoraMounted((prev) => [...prev, `${loraAddFile}:${s}`])
                        setLoraAddFile('')
                      }}
                    >
                      添加 LoRA
                    </button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button type="button" className="btn secondary" onClick={() => void saveLoraList()} disabled={loraSaving || loraLoading}>
                      {loraSaving ? '保存中…' : '保存 LoRA 设置'}
                    </button>
                    {loraSavedAt ? <span className="hint" style={{ color: '#4ade80' }}>已保存，下次出图生效 · {loraSavedAt}</span> : null}
                  </div>
                </div>
                <div className="hint">姿势变体身份锚定（IPAdapter）默认档位：权重 0.8 / 区间 0.2-0.9，在各资产详情卡的「姿势变体 → 高级参数」里可单张调整。</div>
              </div>
            </div>
          </div>
        ) : null}

        {/* R 波项 3（2026-10-27）：「存为配方」弹窗随定义期 UI 退役撤除（配方应用迁至蓝图姿态需求清单，配方库读写路径不变） */}


        {/* ============ 2026-09-10 公共提示词库弹层：正/负向筛选插入 + 当前内容回存 + 条目删除 ============ */}
        {promptLibTarget ? (
          <div className="story-lock-lib-overlay" role="dialog" aria-modal="true" aria-label="公共提示词库" onClick={() => setPromptLibTarget(null)}>
            <div className="story-lock-lib-card" onClick={(e) => e.stopPropagation()}>
              <div className="story-lock-lib-head">
                <div>
                  <div className="story-lock-workspace-log-title">公共提示词库</div>
                  <div className="hint">插入目标：{promptLibTarget.label}（去重追加到对应中/英文栏）</div>
                </div>
                <button type="button" className="icon-btn" onClick={() => setPromptLibTarget(null)} aria-label="关闭公共提示词库" title="关闭">✕</button>
              </div>
              <div className="story-lock-lib-tabs">
                <button
                  type="button"
                  className={`story-lock-view-toggle-btn ${promptLibKindFilter === 'positive' ? 'active' : ''}`}
                  onClick={() => setPromptLibKindFilter('positive')}
                >正向（{promptLibEntries.filter((x) => x.kind === 'positive').length}）</button>
                <button
                  type="button"
                  className={`story-lock-view-toggle-btn ${promptLibKindFilter === 'negative' ? 'active' : ''}`}
                  onClick={() => setPromptLibKindFilter('negative')}
                >负向（{promptLibEntries.filter((x) => x.kind === 'negative').length}）</button>
              </div>
              <div className="story-lock-lib-list">
                {promptLibBusy && promptLibEntries.length === 0 ? <div className="hint">加载中…</div> : null}
                {!promptLibBusy && promptLibEntries.filter((x) => x.kind === promptLibKindFilter).length === 0 ? (
                  <div className="hint">该分类暂无条目，可在下方把当前内容存入库</div>
                ) : null}
                {promptLibEntries.filter((x) => x.kind === promptLibKindFilter).map((entry) => (
                  <div className="story-lock-lib-item" key={entry.id}>
                    <div className="story-lock-lib-item-main">
                      <div className="story-lock-lib-item-name">
                        {entry.name}
                        {entry.builtin ? <span className="story-lock-lib-builtin">内置</span> : null}
                      </div>
                      {entry.textZh ? <div className="story-lock-lib-item-text">中：{entry.textZh}</div> : null}
                      {entry.textEn ? <div className="story-lock-lib-item-text">英：{entry.textEn}</div> : null}
                    </div>
                    <div className="story-lock-lib-item-actions">
                      <button className="btn secondary" type="button" onClick={() => insertPromptLibEntry(entry)} disabled={promptLibBusy}>插入</button>
                      <button className="icon-btn danger" type="button" onClick={() => void deletePromptLibEntry(entry.id)} disabled={promptLibBusy} title="从公共库删除该条目" aria-label={`删除 ${entry.name}`}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="story-lock-lib-save">
                <div className="story-lock-lib-save-title">把当前「{promptLibTarget.label}」输入内容存入库</div>
                <div className="story-lock-lib-save-row">
                  <input
                    className="input"
                    type="text"
                    value={promptLibSaveName}
                    onChange={(e) => setPromptLibSaveName(e.target.value)}
                    placeholder="条目名称（如：拟人化排除包）"
                  />
                  <button className="btn secondary" type="button" onClick={() => void saveCurrentToPromptLibrary()} disabled={promptLibBusy}>
                    {promptLibBusy ? '处理中…' : '保存到公共库'}
                  </button>
                </div>
              </div>
              {promptLibHint ? <div className="hint story-lock-lib-hint" role="status">{promptLibHint}</div> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
