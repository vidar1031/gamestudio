import React from 'react'
import { dlgAlert, dlgConfirm } from './dialog'
import { resolveUrl, listProjectAiTasks, listProjectAiCoverage, renderAllStoryScenesAi, listImageReviewsAi, approveImageReviewAi, rejectImageReviewAi, approveAllImageReviewsAi, getComfyuiModels, getStudioSettings, saveStudioSettings, listPromptLibrary, savePromptLibraryEntry, deletePromptLibraryEntryById, type AiBackgroundRequest, type AiCoverage, type AiTaskProgress, type ImageReviewRecord, type PromptLibraryEntry, type StoryAssetGalleryEntry } from './api'
import { BUILTIN_POSE_RECIPES, POSE_NEGATIVE_CHIPS, POSE_VIEW_OPTIONS, type PoseRecipe } from './poseRecipes'

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

function toProjectAssetUrl(projectId: string, rawUri: string) {
  const uri = String(rawUri || '').trim()
  if (!uri || !projectId) return ''
  if (/^https?:\/\//i.test(uri) || uri.startsWith('data:')) return uri
  return resolveUrl(`/project-assets/${encodeURIComponent(String(projectId))}/${uri.replace(/^\/+/, '')}`)
}

function toRuntimeUrl(rawUrl: string) {
  const value = String(rawUrl || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value
  return resolveUrl(value.startsWith('/') ? value : `/${value}`)
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

// 2026-09-02 姿势变体生成参数（IPAdapter 高级档位随 opts 传给服务端 sprite 端点；
// 中英文双稿随 opts 记录进候选/变体，生图用英文稿优先、空则用中文稿由服务端自动翻译；
// 负向双稿：英文优先，空则生成时由 ComposeStudio 翻译中文稿后下发）
type PoseGenOpts = {
  posePrompt: string
  posePromptZh?: string
  posePromptEn?: string
  negativePromptZh?: string
  negativePromptEn?: string
  ipadapter?: { enabled: boolean; weight: number; startAt: number; endAt: number }
}

// 姿势变体区每资产的本地草稿（中英文双稿/负向/选中剧情场景/高级参数/命名输入），本地是覆盖层；持久化本体在 plan 资产 poseDraft
type PoseDraftEntry = {
  posePromptZh: string
  posePromptEn: string
  negativePromptZh: string
  negativePromptEn: string
  sceneId: string
  advancedOpen: boolean
  ipadapterOn: boolean
  ipadapterWeight: number
  ipadapterStartAt: number
  ipadapterEndAt: number
  lockNames: Record<string, string>
  // 2026-09-10 中文稿来源：user=用户手输（作为「按剧情生成」的额外要求生效）；ai=AI/配方/需求回填（残留不带回模型，防旧姿势重生）
  promptZhSource?: string
}

function defaultPoseDraft(): PoseDraftEntry {
  // 2026-09-01 需求：姿势变体默认延续主参考图（IPAdapter 默认开），高级参数折叠里可关/调档
  // 默认档位取实测中间值（权重 0.8 / 区间 0.2-0.9）：0.7 档姿势自由但裤鞋颜色漂（评分 45），
  // 0.9 档服装全锁但姿势被主参考站姿拉回正身——用户按"保姿势↔保服装"需求在高级参数里微调
  return { posePromptZh: '', posePromptEn: '', negativePromptZh: '', negativePromptEn: '', sceneId: '', advancedOpen: false, ipadapterOn: true, ipadapterWeight: 0.8, ipadapterStartAt: 0.2, ipadapterEndAt: 0.9, lockNames: {}, promptZhSource: '' }
}

// 评分徽标配色：未评分灰，≥70 绿，40-69 黄，<40 红（与抽卡池同款语义）
function poseScoreBadge(c: any): { text: string; color: string } {
  if (!Number.isFinite(Number(c?.score))) return { text: '未评分', color: 'rgba(148,163,184,0.9)' }
  const s = Math.round(Number(c.score))
  const color = s >= 70 ? '#4ade80' : s >= 40 ? '#facc15' : '#f87171'
  return { text: `${s} 分`, color }
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
  onEnhanceAllPrompts?: () => void
  onDraftGlobalPromptZh?: () => void
  enhanceAllProgress?: { current: number; total: number; busy: boolean }
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
  onOpenRender: () => void
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
  poseGeneratingId?: string
  poseDrawProgress?: { done: number; total: number } | null
  poseReviewingId?: string
  poseLockingKey?: string
  posePromptBusyId?: string
  poseFocusAssetId?: string
  // 2026-09-01 剧情感知：该资产关联场景选项（场景序号+名称，节点正文由 ComposeStudio 侧查 doc.story）
  poseSceneOptionsFor?: (assetId: string) => { sceneId: string; label: string }[]
  // 2026-09-01 姿势图片管理画廊（开关状态在 ComposeStudio，复用主参考画廊 overlay 模式）
  poseGalleryAssetId?: string
  onPoseGalleryOpen?: (assetId: string) => void
  onPoseGalleryClose?: () => void
  onPosePrefill?: (assetId: string) => string
  // 2026-09-02 姿势草稿持久化（五个时机落 plan 资产 poseDraft，不逐键入）
  onPoseDraftSave?: (assetId: string, draft: { promptZh: string; promptEn: string; negativePromptZh: string; negativePromptEn: string; sceneId: string; ipadapterOn: boolean; ipadapterWeight: number; ipadapterStartAt: number; ipadapterEndAt: number; promptZhSource?: string }) => void
  onPoseAiPrompt?: (assetId: string, opts: { userHint: string; sceneId: string; reviewFeedback?: string }) => Promise<{ promptZh: string; promptEn: string } | null>
  // 2026-09-10 姿势草稿「中文转英文」：返回译稿，向导侧走填充保护落栏
  onPoseDraftTranslate?: (assetId: string) => Promise<string | null>
  // 2026-09-02 配方库：项目自定义配方（存 project.state.aiBackground.customPoseRecipes）+ 存为配方回调
  customPoseRecipes?: { name: string; promptZh: string; promptEn: string }[]
  onPoseSaveRecipe?: (recipe: { name: string; promptZh: string; promptEn: string }) => void
  onPoseGenerate?: (assetId: string, opts: PoseGenOpts) => void
  onPoseGenerateFour?: (assetId: string, opts: PoseGenOpts) => void
  // 2026-09-10 剧情姿势需求：AI 提取候选清单 → 逐条手改 → 单个/批量手动生成
  poseReqBusyId?: string
  onPoseRequirementsExtract?: (assetId: string) => void
  // 2026-10-06 简谱演绎：表情差分需求一键播种（仅换表情不换姿势，复用姿势链出图）
  onExpressionRequirementsExtract?: (assetId: string) => void
  onPoseRequirementGenerate?: (assetId: string, reqId: string) => void
  onPoseRequirementsBatchGenerate?: (assetId: string) => void
  onPoseRequirementChange?: (assetId: string, reqId: string, patch: { promptZh?: string; promptEn?: string }) => void
  onPoseRequirementDelete?: (assetId: string, reqId: string) => void
  onPoseReviewAll?: (assetId: string) => void
  onPoseRedraw?: (assetId: string, assetPath: string, opts: PoseGenOpts) => void
  onPoseDeleteCandidate?: (assetId: string, assetPath: string) => void
  onPoseLock?: (assetId: string, assetPath: string, name: string, prompts: { posePrompt: string; posePromptZh?: string; posePromptEn?: string }) => void
  onPoseDeleteVariant?: (assetId: string, variantId: string) => Promise<{ ok: boolean; message?: string }>
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
  const wizardStorageKey = String(props.projectId || '').trim() ? `gamestudio.lockWorkspace.wizard.${String(props.projectId || '').trim()}` : ''
  const readPersistedWizard = (): { step: number; zh: boolean; en: boolean } | null => {
    if (!wizardStorageKey) return null
    try {
      const raw = localStorage.getItem(wizardStorageKey)
      if (!raw) return null
      const obj = JSON.parse(raw)
      const step = Math.max(1, Math.min(7, Math.floor(Number(obj?.step) || 1)))
      return { step, zh: Boolean(obj?.zh), en: Boolean(obj?.en) }
    } catch {
      return null
    }
  }
  const persistedWizardRef = React.useRef<{ step: number; zh: boolean; en: boolean } | null | undefined>(undefined)
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
      setPromptGateHint(`还不能确认中文稿：${missing.slice(0, 4).join('、')}${missing.length > 4 ? ` 等 ${missing.length} 项` : ''}为空。可先点「AI 起草中文全局稿 / AI 生成全部事物中文提示词」，或从「公共提示词」插入补齐。`)
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
  const wizardSteps = [
    { n: 1, label: '环境体检', ready: envReady },
    { n: 2, label: 'Story Bible', ready: storyBibleReady },
    { n: 3, label: '资产计划', ready: planAssets.length > 0 },
    { n: 4, label: '全局与事物提示词', ready: promptZhConfirmed && promptEnApproved },
    { n: 5, label: '参考图与锁定', ready: refLockReady },
    { n: 6, label: '线稿锁定', ready: lineartLockReady },
    { n: 7, label: '完成锁定', ready: refLockReady && lineartLockReady }
  ]
  const firstNotReady = wizardSteps.find((s) => !s.ready && s.n < 7)?.n ?? 7
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
      case 5: return (refRequiredCount === 0 || primaryReadyCount >= refRequiredCount) ? '' : `还有 ${Math.max(0, refRequiredCount - primaryReadyCount)} 个必要事物未锁定主参考`
      case 6: return (refRequiredCount === 0 || lineartReadyCount >= refRequiredCount) ? '' : '还有资产的线稿未生成'
      default: return ''
    }
  }

  // AI 任务进度轮询：锁定测试/场景渲染/批量渲染的真实阶段在此可见（非黑盒）
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
    const pull = async () => {
      try {
        const [tasks, reviews, coverage] = await Promise.all([
          listProjectAiTasks(projectId),
          listImageReviewsAi(projectId, 'pending').catch(() => [] as ImageReviewRecord[]),
          listProjectAiCoverage(projectId).catch(() => null)
        ])
        if (stopped) return
        setAiTasks(tasks)
        setAiCoverage(coverage)
        setPendingReviews(reviews)
        // 批量渲染完成后自动刷新项目数据（场景图写回 story.json/project.json）
        for (const t of tasks) {
          if (t.kind === 'story.scenes.render_all' && t.done && !reloadedTaskIdsRef.current.has(t.taskId)) {
            reloadedTaskIdsRef.current.add(t.taskId)
            props.onReloadProject?.()
          }
        }
      } catch (_) { /* 轮询失败忽略，下轮重试 */ }
    }
    void pull()
    const timer = window.setInterval(pull, 1500)
    return () => { stopped = true; window.clearInterval(timer) }
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

  // 向导状态变化即按项目持久化（刷新后恢复到提示词操作阶段与审核闸状态）
  React.useEffect(() => {
    if (!props.open || !wizardStorageKey) return
    try {
      localStorage.setItem(wizardStorageKey, JSON.stringify({ step: wizardStep, zh: promptZhConfirmed, en: promptEnApproved, updatedAt: Date.now() }))
    } catch { /* 存储不可用时忽略 */ }
  }, [props.open, wizardStorageKey, wizardStep, promptZhConfirmed, promptEnApproved])

  React.useEffect(() => {
    const allowed = new Set((props.assetGallery?.items || []).map((item) => String(item.assetPath || '').trim()).filter(Boolean))
    setGallerySelectedPaths((prev) => prev.filter((item) => allowed.has(item)))
  }, [props.assetGallery?.items])

  const galleryDeletingSet = React.useMemo(() => new Set((props.assetGalleryDeletingPaths || []).map((item) => String(item || '').trim()).filter(Boolean)), [props.assetGalleryDeletingPaths])

  // ============ 2026-09-01 姿势变体区本地状态（草稿/展开/阻断提示；数据本体在 plan 资产上） ============
  // 2026-09-02 姿势草稿持久化：本地编辑是覆盖层，未编辑时优先读 plan 资产 poseDraft（刷新/重开不丢）
  const [poseDrafts, setPoseDrafts] = React.useState<Record<string, PoseDraftEntry>>({})
  const [poseExpanded, setPoseExpanded] = React.useState<Record<string, boolean>>({})
  const [poseBlockMsg, setPoseBlockMsg] = React.useState('')
  // 2026-09-16 状态变体区（道具/地点资产）展开态；数据本体在 plan 资产 stateRequirements/stateVariants/stateMergeInto 上
  const [stateExpanded, setStateExpanded] = React.useState<Record<string, boolean>>({})
  const poseDraftOf = (assetId: string, asset?: any): PoseDraftEntry => {
    const local = poseDrafts[assetId]
    if (local) return local
    const base = defaultPoseDraft()
    const p = asset && typeof asset.poseDraft === 'object' && asset.poseDraft ? asset.poseDraft : null
    if (!p) return base
    return {
      ...base,
      // 持久化键为 promptZh/promptEn/negativePromptZh/negativePromptEn（plan 资产 poseDraft），本地草稿键为 posePromptZh/posePromptEn/negativePromptZh/negativePromptEn
      posePromptZh: String(p.promptZh || ''),
      posePromptEn: String(p.promptEn || ''),
      negativePromptZh: String(p.negativePromptZh || ''),
      negativePromptEn: String(p.negativePromptEn || ''),
      sceneId: String(p.sceneId || ''),
      ipadapterOn: p.ipadapterOn !== undefined ? Boolean(p.ipadapterOn) : base.ipadapterOn,
      ipadapterWeight: Number.isFinite(Number(p.ipadapterWeight)) ? Number(p.ipadapterWeight) : base.ipadapterWeight,
      ipadapterStartAt: Number.isFinite(Number(p.ipadapterStartAt)) ? Number(p.ipadapterStartAt) : base.ipadapterStartAt,
      ipadapterEndAt: Number.isFinite(Number(p.ipadapterEndAt)) ? Number(p.ipadapterEndAt) : base.ipadapterEndAt,
      promptZhSource: String((p as any).promptZhSource || ''),
      lockNames: {}
    }
  }
  const patchPoseDraft = (assetId: string, patch: Partial<PoseDraftEntry>, asset?: any) =>
    setPoseDrafts((prev) => ({ ...prev, [assetId]: { ...(prev[assetId] || poseDraftOf(assetId, asset)), ...patch } }))
  // 2026-09-02 草稿持久化时机统一出口（剧情生成完成/场景预填/抽卡点击/切场景/高级参数变更，不逐键入）
  const savePoseDraft = (assetId: string, draft: PoseDraftEntry) => {
    props.onPoseDraftSave?.(assetId, {
      promptZh: String(draft.posePromptZh || ''),
      promptEn: String(draft.posePromptEn || ''),
      negativePromptZh: String(draft.negativePromptZh || ''),
      negativePromptEn: String(draft.negativePromptEn || ''),
      sceneId: String(draft.sceneId || ''),
      ipadapterOn: Boolean(draft.ipadapterOn),
      ipadapterWeight: Number(draft.ipadapterWeight) || 0.8,
      ipadapterStartAt: Number(draft.ipadapterStartAt) || 0.2,
      ipadapterEndAt: Number(draft.ipadapterEndAt) || 0.9,
      promptZhSource: String(draft.promptZhSource || '')
    })
  }

  // ============ 2026-09-10 填充保护（用户指令：非常重要的功能） ============
  // 任何"填充类"动作（配方/按场景预填/填入草稿/槽位组装/AI 生成回填）在目标栏已有内容时：
  // 弹 DIV 确认——追加（拼接保留）/ 覆盖（自动备份，可一键恢复）/ 取消；覆盖前备份存 localStorage，刷新可找回。
  type PoseFillRequest = {
    assetId: string
    asset: any
    sourceLabel: string
    nextZh: string
    nextEn?: string | null // null=不动英文栏；''=清空英文栏等自动翻译
    enOnly?: boolean // 2026-09-10 翻译类填充：只动英文栏，确认弹窗预览与备份针对英文栏，无"追加"选项
    source?: 'user' | 'ai'
    extraPatch?: Partial<PoseDraftEntry>
  }
  const [poseFillGuard, setPoseFillGuard] = React.useState<PoseFillRequest | null>(null)
  const poseFillBackupKey = String(props.projectId || '').trim() ? `gamestudio.poseFillBackup.${String(props.projectId || '').trim()}` : ''
  const [poseDraftBackups, setPoseDraftBackups] = React.useState<Record<string, { zh: string; en: string; savedAt: number; sourceLabel: string }>>(() => {
    if (!poseFillBackupKey) return {}
    try {
      const raw = localStorage.getItem(poseFillBackupKey)
      const obj = raw ? JSON.parse(raw) : {}
      return obj && typeof obj === 'object' ? obj : {}
    } catch {
      return {}
    }
  })
  const persistPoseDraftBackups = (next: Record<string, { zh: string; en: string; savedAt: number; sourceLabel: string }>) => {
    setPoseDraftBackups(next)
    try { if (poseFillBackupKey) localStorage.setItem(poseFillBackupKey, JSON.stringify(next)) } catch { /* 存储不可用时忽略 */ }
  }
  const applyPoseFill = (req: PoseFillRequest, mode: 'overwrite' | 'append') => {
    const cur = poseDraftOf(req.assetId, req.asset)
    if (mode === 'overwrite') {
      const bak = { zh: String(cur.posePromptZh || ''), en: String(cur.posePromptEn || ''), savedAt: Date.now(), sourceLabel: req.sourceLabel }
      if (bak.zh.trim() || bak.en.trim()) persistPoseDraftBackups({ ...poseDraftBackups, [req.assetId]: bak })
    }
    const zh = req.enOnly ? cur.posePromptZh : (mode === 'append' ? mergePromptFragment(cur.posePromptZh, req.nextZh, '，') : req.nextZh)
    const en = req.enOnly ? String(req.nextEn || '') : (req.nextEn == null ? cur.posePromptEn : (mode === 'append' ? mergePromptFragment(cur.posePromptEn, req.nextEn, ', ') : req.nextEn))
    const patch: Partial<PoseDraftEntry> = { posePromptZh: zh, posePromptEn: en, promptZhSource: req.source || 'ai', ...(req.extraPatch || {}) }
    const next = { ...cur, ...patch }
    patchPoseDraft(req.assetId, patch, req.asset)
    savePoseDraft(req.assetId, next)
  }
  const requestPoseFill = (req: PoseFillRequest) => {
    const cur = poseDraftOf(req.assetId, req.asset)
    const curHas = req.enOnly
      ? Boolean(String(cur.posePromptEn || '').trim())
      : Boolean(String(cur.posePromptZh || '').trim() || String(cur.posePromptEn || '').trim())
    const sameContent = req.enOnly
      ? String(cur.posePromptEn || '') === String(req.nextEn || '')
      : String(cur.posePromptZh || '') === String(req.nextZh || '') && (req.nextEn == null || String(cur.posePromptEn || '') === String(req.nextEn || ''))
    // 空栏或内容相同：直接填入，不打扰；有内容才弹确认
    if (!curHas || sameContent) {
      applyPoseFill(req, 'overwrite')
      return
    }
    setPoseFillGuard(req)
  }
  const restorePoseFillBackup = (assetId: string, asset: any) => {
    const bak = poseDraftBackups[assetId]
    if (!bak) return
    const patch: Partial<PoseDraftEntry> = { posePromptZh: bak.zh, posePromptEn: bak.en, promptZhSource: 'user' }
    const next = { ...poseDraftOf(assetId, asset), ...patch }
    patchPoseDraft(assetId, patch, asset)
    savePoseDraft(assetId, next)
    const nextBackups = { ...poseDraftBackups }
    delete nextBackups[assetId]
    persistPoseDraftBackups(nextBackups)
  }
  const poseGenOptsOf = (assetId: string, asset?: any): PoseGenOpts => {
    const d = poseDraftOf(assetId, asset)
    const zh = String(d.posePromptZh || '').trim()
    const en = String(d.posePromptEn || '').trim()
    return {
      // 2026-09-01 生图用英文稿优先，空则用中文稿（sprite 端点本来就会自动翻译中文）
      posePrompt: en || zh,
      posePromptZh: zh,
      posePromptEn: en,
      // 2026-09-02 姿势负向双稿随草稿下发（英文优先；空则 ComposeStudio 生成时翻译中文稿）
      negativePromptZh: String(d.negativePromptZh || '').trim(),
      negativePromptEn: String(d.negativePromptEn || '').trim(),
      ipadapter: d.ipadapterOn
        ? { enabled: true, weight: Number(d.ipadapterWeight) || 0.8, startAt: Number(d.ipadapterStartAt) || 0.2, endAt: Number(d.ipadapterEndAt) || 0.9 }
        : undefined
    }
  }
  const poseBusy = Boolean(props.poseGeneratingId || props.poseReviewingId || props.poseLockingKey || props.posePromptBusyId || props.assetPlanBusy)

  // 2026-09-02 配方库/存为配方/槽位组装的 UI 态（本地，不进 plan）
  const [poseRecipeOpenId, setPoseRecipeOpenId] = React.useState('')
  const [poseSaveRecipeAssetId, setPoseSaveRecipeAssetId] = React.useState('')
  const [poseRecipeName, setPoseRecipeName] = React.useState('')
  // 2026-09-10 剧情姿势需求行内编辑缓存（失焦/生成时才落 plan，不逐键入持久化）
  const [poseReqEdits, setPoseReqEdits] = React.useState<Record<string, string>>({})
  const [poseSlots, setPoseSlots] = React.useState<Record<string, { view: string; action: string; expression: string; costume: string }>>({})
  const poseSlotsOf = (assetId: string) => poseSlots[assetId] || { view: '', action: '', expression: '', costume: '服装与主参考保持一致' }
  const patchPoseSlots = (assetId: string, patch: Partial<{ view: string; action: string; expression: string; costume: string }>) =>
    setPoseSlots((prev) => ({ ...prev, [assetId]: { ...poseSlotsOf(assetId), ...prev[assetId], ...patch } }))
  // 配方列表：内置（按资产类型过滤 forKind，any/character 对角色卡可见）+ 项目自定义
  const poseRecipesFor = (asset: any): { name: string; promptZh: string; promptEn: string }[] => {
    const kind = String(asset?.category || '') === 'prop' ? 'prop' : 'character'
    const builtin = BUILTIN_POSE_RECIPES.filter((r) => r.forKind === 'any' || r.forKind === kind)
    const custom = (Array.isArray(props.customPoseRecipes) ? props.customPoseRecipes : []).filter((r) => String(r?.name || '').trim())
    return [...builtin.map((r) => ({ name: r.name, promptZh: r.promptZh, promptEn: r.promptEn })), ...custom.map((r) => ({ name: String(r.name), promptZh: String(r.promptZh || ''), promptEn: String(r.promptEn || '') }))]
  }

  // 2026-09-01 姿势图片管理画廊：当前打开的资产（候选 + 已锁定变体两组陈列）
  const poseGalleryAsset = props.poseGalleryAssetId
    ? planAssets.find((a) => String(a?.id || '').trim() === String(props.poseGalleryAssetId || '').trim()) || null
    : null

  // ============ 2026-09-02 事物总览大改版：一级卡片墙 / 二级详情弹层 / 配置 drawer ============
  // 视图模式：未手动切换时跟随确认态（计划已确认→卡片总览，否则步骤向导）；切换按钮只写 override
  const [viewModeOverride, setViewModeOverride] = React.useState<null | 'grid' | 'steps'>(null)
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
    const zhCur = target.getZh()
    const enCur = target.getEn()
    target.setZh(mergePromptFragment(zhCur, entry.textZh, '，'))
    target.setEn(mergePromptFragment(enCur, entry.textEn, ', '))
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

  const [gridFilterDone, setGridFilterDone] = React.useState<'all' | 'todo' | 'done'>('all')
  const [gridFilterCat, setGridFilterCat] = React.useState<'all' | 'character' | 'prop' | 'location'>('all')
  const statusRank: Record<AssetLockTone, number> = { draft: 0, draw: 1, lineart: 2, locked: 3 }
  const gridAssetsAll = planAssets
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
  // 下一步建议：按状态缺口给一句可执行建议
  const gridSuggestion = gridCounts.draft > 0
    ? `还有 ${gridCounts.draft} 个事物待起草提示词 → 可先批量生成`
    : gridCounts.draw > 0
      ? `还有 ${gridCounts.draw} 个事物待抽卡 → 可批量生成参考图`
      : gridCounts.lineart > 0
        ? `还有 ${gridCounts.lineart} 个事物待锁线稿 → 打开对应资产生成线稿`
        : (planAssets.length ? '全部事物已锁定，可进入正式场景出图' : '尚无资产计划，请用步骤模式完成初始化')
  const openAssetDetail = (assetId: string, anchor?: string) => {
    setDetailAssetId(String(assetId || '').trim())
    setDetailAnchor(String(anchor || '').trim())
  }
  const detailAsset = detailAssetId ? planAssets.find((a) => String(a?.id || '').trim() === detailAssetId) || null : null
  const detailIndex = detailAsset ? gridAssetsAll.findIndex((x) => String(x.asset?.id || '').trim() === String(detailAsset.id || '').trim()) : -1
  // 上一个/下一个：按一级排序后的数组顺序循环
  const detailNav = (dir: 1 | -1) => {
    if (!gridAssetsAll.length) return
    const nextIdx = detailIndex < 0 ? 0 : (detailIndex + dir + gridAssetsAll.length) % gridAssetsAll.length
    setDetailAssetId(String(gridAssetsAll[nextIdx]?.asset?.id || '').trim())
    setDetailAnchor('')
  }

  // 摆放属性「管理姿势变体…」跳转：打开即定位到该角色资产的姿势变体区
  // 2026-09-02 大改版：grid 模式直接开二级详情弹层并滚到姿势变体区；steps 模式落第 5 步展开资产卡
  React.useEffect(() => {
    if (!props.open || !props.poseFocusAssetId) return undefined
    const aid = String(props.poseFocusAssetId).trim()
    if (!aid) return undefined
    setPoseExpanded((prev) => ({ ...prev, [aid]: true }))
    if (viewMode === 'grid') {
      setDetailAssetId(aid)
      setDetailAnchor('pose')
      const t = window.setTimeout(() => {
        try { document.getElementById(`pose-asset-${aid}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch {}
      }, 400)
      return () => window.clearTimeout(t)
    }
    setWizardStep(5)
    const t = window.setTimeout(() => {
      try { document.getElementById(`pose-asset-${aid}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch {}
    }, 300)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.poseFocusAssetId])

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
  const renderAssetPromptCard = (asset: any) => {
            const assetId = String(asset?.id || '').trim()
            const promptDraft = (props.assetPromptDrafts && props.assetPromptDrafts[assetId]) || {}
            const promptReview = promptDraft.promptReview || null
            const promptReviewTone = assetPromptReviewTone(promptReview)
            const promptEnhancedAt = String(promptDraft.enhancedAt || '').trim()
            const optimizing = props.assetOptimizingId === assetId
            const translatingAssetPositive = props.translatingScope === `asset:positive:${assetId}`
            const translatingAssetNegative = props.translatingScope === `asset:negative:${assetId}`
            return (
              <div className="story-lock-plan-prompt-card" key={assetId}>
                <div className="story-lock-plan-prompt-head">
                  <span className="story-lock-plan-name">{String(asset?.name || assetId || '未命名')}</span>
                  <span className="hint">{getAssetCategoryLabel(String(asset?.category || ''))}</span>
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
                    <span>正向 · 中文 <button className="story-lock-mini-btn" type="button" onClick={() => openPromptLibrary(assetPromptLibTarget(asset, 'positive'))} title="打开公共提示词库，插入到该事物正向中/英文栏，或存入库">公共库</button></span>
                    <textarea className="story-lock-textarea compact-rows" value={String(promptDraft.promptZh || '')} onChange={(e) => props.onChangeAssetPrompt(assetId, { promptZh: e.target.value })} placeholder="点「AI 生成提示词」先出中文稿，再按需要微调" />
                  </div>
                  <div className="story-lock-prompt-field">
                    <span>正向 · 英文 <button className="story-lock-mini-btn" type="button" onClick={() => props.onTranslateAssetPromptPositive(assetId)} disabled={promptOpBusy} title="中文转英文">{translatingAssetPositive ? '翻译中…' : '中转英'}</button></span>
                    <textarea className="story-lock-textarea compact-rows" value={String(promptDraft.promptEn || '')} onChange={(e) => props.onChangeAssetPrompt(assetId, { promptEn: e.target.value })} placeholder="中文稿确认后翻译，或手工编辑" />
                  </div>
                  <div className="story-lock-prompt-field">
                    <span>反向 · 中文 <button className="story-lock-mini-btn" type="button" onClick={() => openPromptLibrary(assetPromptLibTarget(asset, 'negative'))} title="打开公共提示词库，插入到该事物反向中/英文栏，或存入库">公共库</button></span>
                    <textarea className="story-lock-textarea compact-rows" value={String(promptDraft.negativePromptZh || '')} onChange={(e) => props.onChangeAssetPrompt(assetId, { negativePromptZh: e.target.value })} placeholder="该事物专属的中文反向提示词" />
                  </div>
                  <div className="story-lock-prompt-field">
                    <span>反向 · 英文 <button className="story-lock-mini-btn" type="button" onClick={() => props.onTranslateAssetPromptNegative(assetId)} disabled={promptOpBusy} title="中文转英文">{translatingAssetNegative ? '翻译中…' : '中转英'}</button></span>
                    <textarea className="story-lock-textarea compact-rows" value={String(promptDraft.negativePrompt || '')} onChange={(e) => props.onChangeAssetPrompt(assetId, { negativePrompt: e.target.value })} placeholder="翻译后或手工编辑" />
                  </div>
                </div>
              </div>
            )
  }

  const renderAssetLineartRow = (asset: any) => {
                  const aid = String(asset?.id || '').trim()
                  const hasPrimary = Boolean(String(asset?.primaryReferenceAssetUri || '').trim())
                  const hasLineart = Boolean(String(asset?.lineartFinalAssetUri || '').trim())
                  const linearting = props.assetLineartId === aid
                  return (
                    <div className="story-lock-plan-row" key={aid}>
                      <span className="story-lock-plan-name">{String(asset?.name || aid || '未命名')}</span>
                      <span className={`ai-storyboard-status ${hasLineart ? 'ok' : 'bad'}`}>{hasLineart ? '线稿已生成' : '待生成线稿'}</span>
                      <button className="btn secondary" type="button" onClick={() => props.onGenerateAssetLineart(aid)} disabled={props.assetPlanBusy || linearting || !hasPrimary || !aid}>
                        {linearting ? '线稿生成中…' : (hasLineart ? '重新生成线稿' : '生成线稿')}
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
            const generating = props.assetGeneratingId === assetId
            const analyzing = props.assetAnalyzingId === assetId
            const optimizing = props.assetOptimizingId === assetId
            const selecting = props.assetSelectingId === assetId
            const linearting = props.assetLineartId === assetId
            const assetBusy = generating || analyzing || optimizing || selecting || linearting
            const translatingAssetPositive = props.translatingScope === `asset:positive:${assetId}`
            const translatingAssetNegative = props.translatingScope === `asset:negative:${assetId}`
            // 2026-09-01 姿势变体（角色资产专属）：候选/已锁定变体持久化在 plan 资产上
            const isCharacterAsset = String(asset?.category || '') === 'character'
            const poseCands: any[] = Array.isArray((asset as any)?.poseCandidates) ? (asset as any).poseCandidates : []
            const poseVariants: any[] = Array.isArray((asset as any)?.poseVariants) ? (asset as any).poseVariants : []
            const poseDraft = poseDraftOf(assetId, asset)
            const poseExpandedHere = Boolean(poseExpanded[assetId])
            const poseGeneratingHere = props.poseGeneratingId === assetId
            const poseReviewingHere = props.poseReviewingId === assetId
            const poseProgressHere = poseGeneratingHere ? props.poseDrawProgress || null : null
            const poseGenOneLabel = poseProgressHere && poseProgressHere.total === 1 ? '生成中…' : '生成 1 张'
            const poseGenFourLabel = poseProgressHere && poseProgressHere.total > 1 ? `再出 4 张（${poseProgressHere.done}/${poseProgressHere.total}）` : '再出 4 张'
            // 2026-09-01 剧情感知：关联场景选项（默认选中第一个），无关联场景时「按剧情生成提示词」回退到场景摘要逻辑
            const poseSceneOpts = (props.poseSceneOptionsFor?.(assetId) || []).filter((o) => o && String(o.sceneId || '').trim())
            const poseSceneSel = String(poseDraft.sceneId || '').trim() || String(poseSceneOpts[0]?.sceneId || '')
            const poseGalleryCount = poseCands.length + poseVariants.length
            // 2026-09-02 评分反馈闭环：该资产最新一张有评分的候选（按 createdAt 倒序取首）
            const poseLatestScored = poseCands
              .filter((c: any) => Number.isFinite(Number(c?.score)))
              .sort((a: any, b: any) => Date.parse(String(b?.createdAt || '')) - Date.parse(String(a?.createdAt || '')))[0] || null
            const poseSlotsHere = poseSlotsOf(assetId)
            // 2026-09-10 剧情姿势需求：AI 提取的逐场景姿势需求清单（持久化在 plan 资产 poseRequirements）
            const poseReqs: any[] = Array.isArray((asset as any)?.poseRequirements) ? (asset as any).poseRequirements : []
            const poseDoneReqIds = new Set(poseCands.map((c: any) => String(c?.reqId || '')).filter(Boolean))
            const poseReqTodoCount = poseReqs.filter((r) => String(r?.promptZh || r?.promptEn || '').trim() && !poseDoneReqIds.has(String(r?.reqId || ''))).length
            // 2026-09-16 状态变体（道具/地点等非角色资产专属）：需求清单持久化在 plan 资产 stateRequirements，
            // 已锁定变体在 stateVariants（服务端生成时写入）；mergeInto 表示终态并入另一道具，不单独出状态图
            const isPropStateAsset = !isCharacterAsset
            const stateReqs: any[] = Array.isArray((asset as any)?.stateRequirements) ? (asset as any).stateRequirements : []
            const stateVariants: any[] = Array.isArray((asset as any)?.stateVariants) ? (asset as any).stateVariants : []
            const stateMergeInto = (asset as any)?.stateMergeInto && typeof (asset as any).stateMergeInto === 'object' ? (asset as any).stateMergeInto : null
            const stateChecked = Boolean(String((asset as any)?.stateCheckedAt || '').trim())
            const stateExpandedHere = Boolean(stateExpanded[assetId])
            const stateExtractingHere = props.propStateBusyId === assetId
            const stateBusy = poseBusy || Boolean(props.propStateBusyId || props.propStateGenKey)
            const stateMergeContainerId = String(stateMergeInto?.containerPropId || '').trim()
            const stateMergeContainerName = stateMergeInto
              ? (String(stateMergeInto?.containerName || '').trim()
                || String((planAssets.find((a: any) => String(a?.id || '').trim() === stateMergeContainerId) || {})?.name || '').trim()
                || stateMergeContainerId)
              : ''
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
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                      <div style={{ fontWeight: 800, fontSize: 24 }}>{String(asset?.name || assetId || '未命名资产')}</div>
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
                        <span className={`ai-storyboard-status ${String(asset?.lineartFinalAssetUri || '').trim() ? 'ok' : 'bad'}`}>{String(asset?.lineartFinalAssetUri || '').trim() ? '线稿已生成' : '待生成线稿'}</span>
                      </div>
                    </div>
                    <div className="hint">{getAssetCategoryLabel(String(asset?.category || ''))} / 涉及 {Number(asset?.sceneCount || 0)} 个场景</div>
                    <div className="hint story-lock-score-summary">
                      {selectedScore === selectedScore ? `当前主参考评分：${Math.round(selectedScore)} / 100` : (bestScore === bestScore ? `当前批次最佳评分：${bestScore} / 100` : '当前还没有可评分主参考')}
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
                      <button className="btn secondary" type="button" onClick={() => props.onGenerateAssetLineart(assetId)} disabled={props.assetPlanBusy || assetBusy || !String(asset?.primaryReferenceAssetUri || '').trim() || !assetId}>{selecting ? '主参考处理中…' : (linearting ? '线稿生成中…' : '生成线稿')}</button>
                      <button className="btn secondary" type="button" onClick={() => props.onOpenAssetGallery(assetId)} disabled={props.assetPlanBusy || assetBusy || !assetId}>{selecting ? '主参考处理中…' : (props.assetGalleryBusy && props.assetGallery?.assetId === assetId ? '加载管理中…' : (batchOverflow > 0 ? `管理图片（更多 ${batchOverflow}）` : '管理图片'))}</button>
                    </div>
                  </div>
                </div>

                {/* 2026-09-01 姿势变体管理区（角色资产专属）：出图统一在锁定向导，摆放属性只消费已锁定变体 */}
                {isCharacterAsset ? (
                  <div className="pose-variant-section" id={`pose-asset-${assetId}`}>
                    <div className="pose-variant-head" onClick={() => setPoseExpanded((prev) => ({ ...prev, [assetId]: !poseExpandedHere }))}>
                      <span>姿势变体<span className="hint" style={{ fontWeight: 400 }}>（可选 · 精细档；简谱演绎推荐走「表情差分需求」）</span></span>
                      <span className="hint">{poseVariants.length ? `已锁定 ${poseVariants.length} 个 · 候选 ${poseCands.length} 张` : (poseCands.length ? `候选 ${poseCands.length} 张` : '未抽卡')}</span>
                      <span>{poseExpandedHere ? '－' : '＋'}</span>
                    </div>
                    {poseExpandedHere ? (
                      <div className="pose-variant-body">
                        {/* 2026-09-02 评分反馈闭环：最近评分条（最新有分候选：徽标+理由截断+悬停全文）+ 按评语优化提示词 */}
                        {poseLatestScored ? (
                          <div className="pose-review-strip">
                            <span className="pose-pool-score" style={{ position: 'static', color: poseScoreBadge(poseLatestScored).color }}>
                              {poseScoreBadge(poseLatestScored).text}
                            </span>
                            <span className="hint pose-review-strip-reason" title={String(poseLatestScored.reason || '')}>
                              最近评分：{String(poseLatestScored.reason || '（无理由）').slice(0, 60)}{String(poseLatestScored.reason || '').length > 60 ? '…' : ''}
                            </span>
                            <button
                              type="button"
                              className="btn secondary"
                              style={{ fontSize: 12, padding: '4px 8px' }}
                              disabled={poseBusy}
                              title="把评审理由作为改进反馈传给 AI，重新生成中英文稿（剧情动作要求保持不变）"
                              onClick={() => void (async () => {
                                const res = await props.onPoseAiPrompt?.(assetId, {
                                  userHint: String(poseDraft.posePromptZh || '').trim(),
                                  sceneId: poseSceneSel,
                                  reviewFeedback: String(poseLatestScored.reason || '').trim()
                                })
                                if (res && (res.promptZh || res.promptEn)) {
                                  // 2026-09-10 填充保护：栏内已有内容时弹确认（追加/覆盖可恢复/取消）
                                  requestPoseFill({ assetId, asset, sourceLabel: '按评语优化提示词', nextZh: String(res.promptZh || ''), nextEn: String(res.promptEn || '') })
                                }
                              })()}
                            >
                              {props.posePromptBusyId === assetId ? '优化中…' : '按评语优化提示词'}
                            </button>
                          </div>
                        ) : null}
                        {/* 2026-09-01 剧情感知：先选关联场景（节点正文作为剧情上下文），再「按剧情生成提示词」 */}
                        <div className="pose-pool-field">
                          <label>关联场景（剧情上下文）</label>
                          <select
                            className="sel"
                            value={poseSceneSel}
                            disabled={poseBusy || poseSceneOpts.length === 0}
                            onChange={(e) => {
                              // 2026-09-02 持久化时机 d：切换关联场景即存草稿
                              const next = { ...poseDraft, sceneId: e.target.value }
                              patchPoseDraft(assetId, { sceneId: e.target.value }, asset)
                              savePoseDraft(assetId, next)
                            }}
                          >
                            {poseSceneOpts.length === 0 ? (
                              <option value="">（无关联场景）</option>
                            ) : (
                              poseSceneOpts.map((o) => (
                                <option key={o.sceneId} value={o.sceneId}>
                                  {o.label}
                                </option>
                              ))
                            )}
                          </select>
                        </div>
                        {/* 2026-09-10 剧情姿势需求：AI 提取候选清单 → 逐条可改 → 单个/批量手动生成（与上方草稿链互补） */}
                        {isCharacterAsset ? (
                          <div className="pose-req-block">
                            <div className="pose-req-head">
                              <span className="pose-req-title">剧情姿势需求{poseReqs.length ? `（${poseReqs.length} 条）` : ''}</span>
                              <button
                                type="button"
                                className="btn secondary"
                                disabled={poseBusy || props.poseReqBusyId === assetId}
                                title="AI 读取全故事场景与角色出场表，提取该角色在每个剧情点的姿势/朝向/动作/神态需求（候选制，可逐条修改）"
                                onClick={() => props.onPoseRequirementsExtract?.(assetId)}
                              >
                                {props.poseReqBusyId === assetId ? '提取中…' : (poseReqs.length ? '重新提取剧情姿势需求' : '提取剧情姿势需求')}
                              </button>
                              <button
                                type="button"
                                className="btn secondary"
                                disabled={poseBusy || props.poseReqBusyId === assetId}
                                title="简谱演绎推荐：聚合剧情中该角色的全部表情，播种「仅换表情」差分需求（中性站姿+神态特写）。锁定后摆位会按各场景剧情表情自动选用，无需逐场景姿势变体"
                                onClick={() => props.onExpressionRequirementsExtract?.(assetId)}
                              >
                                {props.poseReqBusyId === assetId ? '处理中…' : '表情差分需求'}
                              </button>
                              <button
                                type="button"
                                className="btn secondary"
                                disabled={poseBusy || props.poseReqBusyId === assetId || poseReqTodoCount === 0}
                                title="按需求清单逐条串行出图（已有候选的需求自动跳过；可随时中断，已出候选保留）"
                                onClick={() => props.onPoseRequirementsBatchGenerate?.(assetId)}
                              >
                                {props.poseGeneratingId === assetId && props.poseDrawProgress ? `批量生成中（${props.poseDrawProgress.done}/${props.poseDrawProgress.total}）` : `按需求批量生成（${poseReqTodoCount}）`}
                              </button>
                            </div>
                            {poseReqs.length === 0 ? (
                              <div className="hint">尚未提取剧情姿势需求。提取后每条可单独修改、单个生成，也可一键批量生成。</div>
                            ) : (
                              <div className="pose-req-list">
                                {poseReqs.map((req: any) => {
                                  const reqId = String(req?.reqId || '')
                                  const done = poseDoneReqIds.has(reqId)
                                  const editValue = poseReqEdits[reqId] != null ? poseReqEdits[reqId] : String(req?.promptZh || '')
                                  return (
                                    <div className={`pose-req-row ${done ? 'done' : ''}`} key={reqId}>
                                      <div className="pose-req-meta">
                                        <span className="pose-req-scene" title={String(req?.sceneName || req?.sceneId || '')}>{String(req?.sceneName || req?.sceneId || '未命名场景')}</span>
                                        <span className="pose-req-chips">
                                          {String(req?.pose || '').trim() ? <span className="pose-req-chip">{String(req.pose)}</span> : null}
                                          {String(req?.view || '').trim() ? <span className="pose-req-chip">{String(req.view)}</span> : null}
                                          {String(req?.action || '').trim() ? <span className="pose-req-chip">{String(req.action)}</span> : null}
                                          {String(req?.expression || '').trim() ? <span className="pose-req-chip">{String(req.expression)}</span> : null}
                                          {Array.isArray(req?.excludedProps) && req.excludedProps.length ? (
                                            <span className="pose-req-chip" title="这些道具/地点词已从生成提示词中剔除并加入负向：立绘只画角色本身，道具由独立立绘经摆位合成进场景">已排除：{req.excludedProps.join('、')}</span>
                                          ) : null}
                                        </span>
                                        {done ? <span className="ai-storyboard-status ok">已出候选</span> : null}
                                      </div>
                                      <div className="pose-req-actions">
                                        <input
                                          className="input pose-req-input"
                                          type="text"
                                          value={editValue}
                                          placeholder="姿势需求中文提示词（可改）"
                                          onChange={(e) => setPoseReqEdits((prev) => ({ ...prev, [reqId]: e.target.value }))}
                                          onBlur={() => {
                                            const v = poseReqEdits[reqId]
                                            if (v != null && v !== String(req?.promptZh || '')) props.onPoseRequirementChange?.(assetId, reqId, { promptZh: v })
                                          }}
                                        />
                                        <button
                                          type="button"
                                          className="story-lock-mini-btn"
                                          disabled={poseBusy || !editValue.trim()}
                                          title="把该需求填入下方「姿势需求 · 中文」栏并设为关联场景——即可用现有 生成1张/再出4张/AI评分 草稿链出图"
                                          onClick={() => {
                                            const v = editValue.trim()
                                            if (!v) return
                                            const nextSceneId = String(req?.sceneId || poseDraft.sceneId || '')
                                            // 2026-09-10 填充保护：已有内容时弹确认（追加/覆盖可恢复/取消）；同时设为关联场景
                                            requestPoseFill({ assetId, asset, sourceLabel: `剧情需求「${String(req?.sceneName || req?.sceneId || '')}」`, nextZh: v, nextEn: '', extraPatch: { sceneId: nextSceneId } })
                                            if (poseReqEdits[reqId] != null && poseReqEdits[reqId] !== String(req?.promptZh || '')) props.onPoseRequirementChange?.(assetId, reqId, { promptZh: v })
                                          }}
                                        >
                                          填入草稿
                                        </button>
                                        <button
                                          type="button"
                                          className="btn secondary"
                                          disabled={poseBusy || props.poseReqBusyId === assetId || !editValue.trim()}
                                          title="按这一条需求生成 1 张姿势候选（英文稿缺失时自动生成时翻译）"
                                          onClick={() => {
                                            const v = poseReqEdits[reqId]
                                            if (v != null && v !== String(req?.promptZh || '')) props.onPoseRequirementChange?.(assetId, reqId, { promptZh: v })
                                            props.onPoseRequirementGenerate?.(assetId, reqId)
                                          }}
                                        >
                                          {props.poseGeneratingId === assetId ? '生成中…' : '生成 1 张'}
                                        </button>
                                        <button
                                          type="button"
                                          className="icon-btn danger"
                                          disabled={poseBusy || props.poseReqBusyId === assetId}
                                          title="删除这条姿势需求（不影响已出候选）"
                                          aria-label="删除该条姿势需求"
                                          onClick={() => props.onPoseRequirementDelete?.(assetId, reqId)}
                                        >
                                          ✕
                                        </button>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        ) : null}
                        {/* 2026-09-01 姿势需求改「中文稿→英文稿」双栏（与第 4 步提示词卡同款 story-lock 样式） */}
                        <div className="pose-pool-toolbar">
                          <button
                            type="button"
                            className="btn secondary"
                            disabled={poseBusy || (poseSceneOpts.length > 0 && !poseSceneSel)}
                            title={
                              poseSceneOpts.length > 0 && !poseSceneSel
                                ? '请先选择关联剧情场景'
                                : 'AI 读取选中场景的剧情正文，判断该角色在此剧情点的视角/动作/表情需求，结合物种解剖约束生成中文稿并自动翻译英文稿（可继续手改）；无关联场景时回退用全部关联场景摘要；生成不携带中文栏旧稿，避免残留姿势重生'
                            }
                            onClick={() => void (async () => {
                              const res = await props.onPoseAiPrompt?.(assetId, { userHint: String(poseDraft.posePromptZh || '').trim(), sceneId: poseSceneSel })
                              if (res && (res.promptZh || res.promptEn)) {
                                // 2026-09-10 填充保护：栏内已有内容时弹确认（追加/覆盖可恢复/取消）
                                requestPoseFill({ assetId, asset, sourceLabel: '按剧情生成提示词', nextZh: String(res.promptZh || ''), nextEn: String(res.promptEn || '') })
                              }
                            })()}
                          >
                            {props.posePromptBusyId === assetId ? '生成中…' : '按剧情生成提示词'}
                          </button>
                          {/* 2026-09-02 配方库：内置 + 项目自定义，点选填入双栏（配方无英文稿则英文栏清空等自动翻译） */}
                          <span className="pose-recipe-anchor">
                            <button
                              type="button"
                              className="btn secondary"
                              disabled={poseBusy}
                              title="从配方库选择姿势提示词填入双栏"
                              onClick={() => setPoseRecipeOpenId(poseRecipeOpenId === assetId ? '' : assetId)}
                            >
                              配方
                            </button>
                            {poseRecipeOpenId === assetId ? (
                              <div className="pose-recipe-pop" role="menu">
                                {poseRecipesFor(asset).map((r) => (
                                  <button
                                    key={r.name}
                                    type="button"
                                    className="pose-recipe-item"
                                    onClick={() => {
                                      // 2026-09-10 填充保护：已有内容时弹确认（追加/覆盖可恢复/取消）
                                      requestPoseFill({ assetId, asset, sourceLabel: `配方「${r.name}」`, nextZh: r.promptZh, nextEn: r.promptEn || '' })
                                      setPoseRecipeOpenId('')
                                    }}
                                  >
                                    {r.name}
                                  </button>
                                ))}
                                {poseRecipesFor(asset).length === 0 ? <div className="hint" style={{ padding: 8 }}>暂无配方</div> : null}
                              </div>
                            ) : null}
                          </span>
                          <button
                            type="button"
                            className="btn secondary"
                            disabled={poseBusy || !String(poseDraft.posePromptZh || '').trim()}
                            title="把当前中英文稿存为项目自定义配方（全项目姿势区可用）"
                            onClick={() => {
                              setPoseSaveRecipeAssetId(assetId)
                              setPoseRecipeName('')
                            }}
                          >
                            存为配方
                          </button>
                          <button
                            type="button"
                            className="btn secondary"
                            onClick={() => {
                              // 2026-09-10 填充保护：已有内容时弹确认；预填只动中文栏（英文栏不动）
                              requestPoseFill({ assetId, asset, sourceLabel: '按场景预填', nextZh: String(props.onPosePrefill?.(assetId) || ''), nextEn: null })
                            }}
                            disabled={poseBusy}
                            title="拼接该资产关联场景的文本摘要填入中文栏作为初稿"
                          >
                            按场景预填
                          </button>
                          <button type="button" className="btn secondary" onClick={() => patchPoseDraft(assetId, { advancedOpen: !poseDraft.advancedOpen }, asset)}>
                            {poseDraft.advancedOpen ? '收起高级参数' : '高级参数'}
                          </button>
                          <button
                            type="button"
                            className="btn secondary"
                            onClick={() => props.onPoseGalleryOpen?.(assetId)}
                            disabled={poseBusy}
                            title="集中管理该资产的姿势候选与已锁定变体（查看大图/删除）"
                          >
                            {poseGalleryCount > 0 ? `管理图片（更多 ${poseGalleryCount}）` : '管理图片'}
                          </button>
                        </div>
                        <div className="story-lock-prompt-grid">
                          {/* 同 2026-10-07 修复：label 内嵌按钮会导致点 caption 误触按钮，改 div */}
                          <div className="story-lock-prompt-field">
                            <span>姿势需求 · 中文
                              {poseDraftBackups[assetId] ? (
                                <button
                                  className="story-lock-mini-btn"
                                  type="button"
                                  title={`恢复「${poseDraftBackups[assetId].sourceLabel}」覆盖前的内容（${new Date(poseDraftBackups[assetId].savedAt).toLocaleTimeString('zh-CN', { hour12: false })} 备份）`}
                                  onClick={() => restorePoseFillBackup(assetId, asset)}
                                >↩ 恢复覆盖前内容</button>
                              ) : null}
                            </span>
                            <textarea
                              className="story-lock-textarea compact-rows"
                              value={poseDraft.posePromptZh}
                              onChange={(e) => patchPoseDraft(assetId, { posePromptZh: e.target.value, promptZhSource: e.target.value.trim() ? 'user' : '' }, asset)}
                              placeholder="例如：背身，伸右臂指向泥土地，认真表情，服装与主参考一致"
                            />
                          </div>
                          <div className="story-lock-prompt-field">
                            <span>姿势需求 · 英文
                              <button
                                className="story-lock-mini-btn"
                                type="button"
                                disabled={poseBusy || !String(poseDraft.posePromptZh || '').trim()}
                                title="把中文栏内容翻译成英文稿（已有英文内容时会先弹确认：追加/覆盖可恢复）"
                                onClick={() => void (async () => {
                                  const en = await props.onPoseDraftTranslate?.(assetId)
                                  if (en) requestPoseFill({ assetId, asset, sourceLabel: '中文转英文', nextZh: '', nextEn: en, enOnly: true })
                                })()}
                              >
                                {props.posePromptBusyId === assetId ? '翻译中…' : '中文转英文'}
                              </button>
                            </span>
                            <textarea
                              className="story-lock-textarea compact-rows"
                              value={poseDraft.posePromptEn}
                              onChange={(e) => patchPoseDraft(assetId, { posePromptEn: e.target.value })}
                              placeholder="AI 生成后自动翻译；可手工编辑，例如：(back view, view from behind, facing away from viewer:1.4), pointing left"
                            />
                          </div>
                        </div>
                        {/* 2026-09-02 负向词库 chips + 姿势负向中文栏（英文稿在生成时自动翻译；chips 去重追加） */}
                        <div className="pose-pool-field">
                          <label>姿势负向（可选）</label>
                          <div className="pose-neg-chips">
                            {POSE_NEGATIVE_CHIPS.map((chip) => (
                              <button
                                key={chip.label}
                                type="button"
                                className="pose-neg-chip"
                                disabled={poseBusy}
                                title={`追加排除：${chip.phrase}`}
                                onClick={() => {
                                  const cur = String(poseDraft.negativePromptZh || '').trim()
                                  const parts = cur ? cur.split(/[，,]/).map((s) => s.trim()).filter(Boolean) : []
                                  if (parts.includes(chip.phrase)) return
                                  // 中文栏变更后英文稿失效（生成时重新翻译）
                                  const next = { ...poseDraft, negativePromptZh: [...parts, chip.phrase].join('，'), negativePromptEn: '' }
                                  patchPoseDraft(assetId, { negativePromptZh: next.negativePromptZh, negativePromptEn: '' }, asset)
                                  savePoseDraft(assetId, next)
                                }}
                              >
                                {chip.label}
                              </button>
                            ))}
                          </div>
                          <input
                            value={poseDraft.negativePromptZh}
                            onChange={(e) => patchPoseDraft(assetId, { negativePromptZh: e.target.value }, asset)}
                            onBlur={() => savePoseDraft(assetId, poseDraftOf(assetId, asset))}
                            placeholder="例如：人物，多只动物，换装，写实"
                          />
                        </div>
                        {/* 2026-09-02 槽位组装：视角+动作+表情+服装约束 拼成中文句填入中文栏（英文栏清空等自动翻译） */}
                        <div className="pose-assemble-row">
                          <select className="sel" value={poseSlotsHere.view} disabled={poseBusy} onChange={(e) => patchPoseSlots(assetId, { view: e.target.value })}>
                            <option value="">视角…</option>
                            {POSE_VIEW_OPTIONS.map((v) => (
                              <option key={v} value={v}>{v}</option>
                            ))}
                          </select>
                          <input value={poseSlotsHere.action} disabled={poseBusy} onChange={(e) => patchPoseSlots(assetId, { action: e.target.value })} placeholder="动作（如：指向稻草堆）" />
                          <input value={poseSlotsHere.expression} disabled={poseBusy} onChange={(e) => patchPoseSlots(assetId, { expression: e.target.value })} placeholder="表情（如：得意）" />
                          <input value={poseSlotsHere.costume} disabled={poseBusy} onChange={(e) => patchPoseSlots(assetId, { costume: e.target.value })} placeholder="服装约束" />
                          <button
                            type="button"
                            className="btn secondary"
                            disabled={poseBusy || !poseSlotsHere.view || !String(poseSlotsHere.action || '').trim()}
                            title="把槽位拼成自然中文句填入中文栏（已有内容时弹确认：追加/覆盖可恢复；英文栏清空等自动翻译）"
                            onClick={() => {
                              const sentence = [poseSlotsHere.view, String(poseSlotsHere.action || '').trim(), String(poseSlotsHere.expression || '').trim(), String(poseSlotsHere.costume || '').trim()].filter(Boolean).join('，')
                              // 槽位组装是用户主动操作：来源记 user（下次「按剧情生成」会把它当额外要求参考）
                              requestPoseFill({ assetId, asset, sourceLabel: '槽位组装', nextZh: sentence, nextEn: '', source: 'user' })
                            }}
                          >
                            组装进中文栏
                          </button>
                        </div>
                        {poseDraft.advancedOpen ? (
                          <div className="pose-variant-advanced">
                            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                              <input
                                type="checkbox"
                                checked={poseDraft.ipadapterOn}
                                onChange={(e) => {
                                  // 2026-09-02 持久化时机 e：高级参数变更即存（开关 onChange，数字档 onBlur）
                                  const next = { ...poseDraft, ipadapterOn: e.target.checked }
                                  patchPoseDraft(assetId, { ipadapterOn: e.target.checked }, asset)
                                  savePoseDraft(assetId, next)
                                }}
                              />
                              IPAdapter 身份锚定（2026-09-01 起默认开：姿势变体延续主参考图；可关闭或调权重/区间）
                            </label>
                            {poseDraft.ipadapterOn ? (
                              <div className="hint" style={{ marginBottom: 6 }}>实测档位：权重低（0.7）姿势更自由但服装颜色可能漂；权重高（0.9）服装全锁但姿势会被主参考站姿拉回。默认 0.8 / 0.2-0.9 折中，按评分结果微调。</div>
                            ) : null}
                            {poseDraft.ipadapterOn ? (
                              <div className="pose-pool-grid2" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
                                <div className="pose-pool-field">
                                  <label>权重</label>
                                  <input
                                    type="number"
                                    step="0.05"
                                    value={poseDraft.ipadapterWeight}
                                    onChange={(e) => patchPoseDraft(assetId, { ipadapterWeight: Number(e.target.value) }, asset)}
                                    onBlur={() => savePoseDraft(assetId, poseDraft)}
                                  />
                                </div>
                                <div className="pose-pool-field">
                                  <label>区间 start</label>
                                  <input
                                    type="number"
                                    step="0.05"
                                    value={poseDraft.ipadapterStartAt}
                                    onChange={(e) => patchPoseDraft(assetId, { ipadapterStartAt: Number(e.target.value) }, asset)}
                                    onBlur={() => savePoseDraft(assetId, poseDraft)}
                                  />
                                </div>
                                <div className="pose-pool-field">
                                  <label>区间 end</label>
                                  <input
                                    type="number"
                                    step="0.05"
                                    value={poseDraft.ipadapterEndAt}
                                    onChange={(e) => patchPoseDraft(assetId, { ipadapterEndAt: Number(e.target.value) }, asset)}
                                    onBlur={() => savePoseDraft(assetId, poseDraft)}
                                  />
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        <div className="pose-pool-toolbar">
                          <button
                            type="button"
                            className="btn secondary"
                            onClick={() => {
                              // 2026-09-02 持久化时机 c：抽卡点击先存草稿再生成
                              savePoseDraft(assetId, poseDraft)
                              props.onPoseGenerate?.(assetId, poseGenOptsOf(assetId, asset))
                            }}
                            disabled={poseBusy || !String(poseDraft.posePromptEn || poseDraft.posePromptZh || '').trim()}
                          >
                            {poseGenOneLabel}
                          </button>
                          <button
                            type="button"
                            className="btn secondary"
                            onClick={() => {
                              savePoseDraft(assetId, poseDraft)
                              props.onPoseGenerateFour?.(assetId, poseGenOptsOf(assetId, asset))
                            }}
                            disabled={poseBusy || !String(poseDraft.posePromptEn || poseDraft.posePromptZh || '').trim()}
                          >
                            {poseGenFourLabel}
                          </button>
                          <button type="button" className="btn secondary" onClick={() => props.onPoseReviewAll?.(assetId)} disabled={poseBusy || poseCands.length === 0} title="对未评分候选逐个与锁定主参考对比评分（串行，姿势不同不扣分）">{poseReviewingHere ? '评分中…' : 'AI 评分'}</button>
                        </div>
                        {poseCands.length === 0 ? (
                          <div className="pose-pool-empty">还没有姿势候选：先写姿势需求，再「生成 1 张」或「再出 4 张」。</div>
                        ) : (
                          <div className="pose-pool-grid">
                            {poseCands.map((c: any, idx: number) => {
                              const cPath = String(c?.assetPath || '').trim()
                              const badge = poseScoreBadge(c)
                              const lockingHere = props.poseLockingKey === `${assetId}:${cPath}`
                              const cReqId = String(c?.reqId || '')
                              // 2026-10-06 表情差分：expr::{expression} 需求出的候选，默认锁定名「表情·X」——摆位按剧情表情自动选用
                              const defaultLockName = cReqId.startsWith('expr::') ? `表情·${cReqId.slice(6)}` : `姿势 ${poseVariants.length + 1}`
                              const lockName = String(poseDraft.lockNames[cPath] ?? defaultLockName)
                              return (
                                <div className="pose-pool-card" key={cPath || idx}>
                                  <img alt="姿势候选" src={toProjectAssetUrl(String(props.projectId || ''), cPath)} />
                                  <span className="pose-pool-score" style={{ color: badge.color }} title={String(c?.reason || '未评分')}>{badge.text}</span>
                                  <div className="pose-pool-card-ops">
                                    <span className="hint">候选 {idx + 1}</span>
                                    <span style={{ display: 'inline-flex', gap: 4 }}>
                                      <button type="button" className="icon-btn" title="单张重抽（删除该候选并重新生成 1 张）" disabled={poseBusy} onClick={() => props.onPoseRedraw?.(assetId, cPath, poseGenOptsOf(assetId, asset))}>↻</button>
                                      <button type="button" className="icon-btn danger" title="删除该候选（文件保留在磁盘）" disabled={poseBusy} onClick={() => props.onPoseDeleteCandidate?.(assetId, cPath)}>✕</button>
                                    </span>
                                  </div>
                                  <div className="pose-variant-lock-row">
                                    <input
                                      value={lockName}
                                      onChange={(e) => patchPoseDraft(assetId, { lockNames: { ...poseDraft.lockNames, [cPath]: e.target.value } })}
                                      placeholder={defaultLockName}
                                      disabled={poseBusy}
                                    />
                                    <button
                                      type="button"
                                      className="btn secondary"
                                      disabled={poseBusy || !cPath}
                                      title="RMBG 抠图 → 创建项目资产 → 写入已锁定姿势变体"
                                      onClick={() =>
                                        props.onPoseLock?.(assetId, cPath, String(lockName || defaultLockName).trim(), {
                                          // 2026-09-01 需求 3：候选带的 promptZh/promptEn 随锁写入变体；旧候选无双稿时回退当前草稿
                                          posePrompt: String(c?.promptEn || c?.promptZh || c?.posePrompt || poseDraft.posePromptEn || poseDraft.posePromptZh || '').trim(),
                                          posePromptZh: String(c?.promptZh || poseDraft.posePromptZh || '').trim(),
                                          posePromptEn: String(c?.promptEn || poseDraft.posePromptEn || '').trim()
                                        })
                                      }
                                    >
                                      {lockingHere ? '锁定中…' : '命名锁定'}
                                    </button>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                        {poseVariants.length ? (
                          <div>
                            <div className="hint" style={{ margin: '4px 0 6px' }}>已锁定姿势变体（可在摆放属性「图片（修改）」中选用）：</div>
                            <div className="pose-variant-list">
                              {poseVariants.map((v: any, idx: number) => {
                                const vSrc = toProjectAssetUrl(String(props.projectId || ''), String(v?.projectAssetUri || v?.cutoutPath || '').trim())
                                return (
                                  <div className="pose-variant-item" key={String(v?.id || idx)}>
                                    {vSrc ? <img alt={String(v?.name || '姿势')} src={vSrc} /> : null}
                                    <div style={{ fontWeight: 700, fontSize: 12 }}>{String(v?.name || `姿势 ${idx + 1}`)}</div>
                                    {Number.isFinite(Number(v?.score)) ? <div className="hint">评分 {Math.round(Number(v.score))} 分</div> : null}
                                    <button
                                      type="button"
                                      className="btn secondary"
                                      disabled={poseBusy}
                                      onClick={() => void (async () => {
                                        const res = await props.onPoseDeleteVariant?.(assetId, String(v?.id || ''))
                                        if (res && !res.ok) setPoseBlockMsg(String(res.message || '该姿势变体正被摆放引用，无法删除'))
                                      })()}
                                    >
                                      删除
                                    </button>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* 2026-09-16 状态变体管理区（道具/地点等非角色资产专属）：生成全链在服务端，任务进度见顶部任务条 */}
                {isPropStateAsset ? (
                  <div className="pose-variant-section" id={`state-asset-${assetId}`}>
                    <div className="pose-variant-head" onClick={() => setStateExpanded((prev) => ({ ...prev, [assetId]: !stateExpandedHere }))}>
                      <span>状态变体</span>
                      <span className="hint">{stateVariants.length ? `已锁定 ${stateVariants.length} 个 · 需求 ${stateReqs.length} 条` : (stateReqs.length ? `需求 ${stateReqs.length} 条` : '未提取需求')}</span>
                      <span>{stateExpandedHere ? '－' : '＋'}</span>
                    </div>
                    {stateExpandedHere ? (
                      <div className="pose-variant-body">
                        <div className="pose-req-block">
                          <div className="pose-req-head">
                            <span className="pose-req-title">剧情状态需求{stateReqs.length ? `（${stateReqs.length} 条）` : ''}</span>
                            <button
                              type="button"
                              className="btn secondary"
                              disabled={stateBusy}
                              title="AI 读取全故事场景，提取该事物在剧情中的视觉状态变化（候选制，可重复提取）"
                              onClick={() => props.onPropStatesExtract?.(assetId)}
                            >
                              {stateExtractingHere ? '提取中…' : (stateChecked ? '重新提取状态需求' : '提取状态需求')}
                            </button>
                          </div>
                          {stateMergeInto ? (
                            <div className="hint">已并入 {stateMergeContainerName}，状态在其状态图内呈现，本事物不再单独出状态图。</div>
                          ) : stateReqs.length === 0 ? (
                            <div className="hint">{stateChecked ? '该事物在剧情中无视觉状态变化。' : '尚未提取状态需求。提取后每个状态可单独生成状态立绘，同一状态可生成多个版本。'}</div>
                          ) : (
                            <div className="pose-req-list">
                              {stateReqs.map((req: any) => {
                                const reqKey = String(req?.stateKey || '').trim()
                                const reqSceneCount = Array.isArray(req?.sceneIds) ? req.sceneIds.length : 0
                                const versionCount = stateVariants.filter((v: any) => String(v?.stateKey || '').trim() === reqKey).length
                                const genningHere = Boolean(reqKey) && props.propStateGenKey === `${assetId}:${reqKey}`
                                return (
                                  <div className={`pose-req-row ${versionCount ? 'done' : ''}`} key={reqKey}>
                                    <div className="pose-req-meta">
                                      <span className="pose-req-scene" title={String(req?.label || reqKey)}>{String(req?.label || reqKey || '未命名状态')}</span>
                                      <span className="pose-req-chips">
                                        <span className="pose-req-chip">适用 {reqSceneCount} 个场景</span>
                                        {versionCount ? <span className="pose-req-chip">已出 {versionCount} 版</span> : null}
                                      </span>
                                      {versionCount ? <span className="ai-storyboard-status ok">已出图</span> : null}
                                    </div>
                                    {String(req?.description || '').trim() ? <div className="hint">{String(req.description)}</div> : null}
                                    <div className="pose-req-actions" style={{ justifyContent: 'flex-end' }}>
                                      <button
                                        type="button"
                                        className="btn secondary"
                                        disabled={stateBusy || !reqKey}
                                        title="按该状态生成 1 张状态立绘（生成→评审→抠图→登记全自动，进度见顶部任务条；同一状态可生成多个版本）"
                                        onClick={() => props.onPropStateGenerate?.(assetId, { stateKey: reqKey, label: String(req?.label || reqKey).trim(), description: String(req?.description || '').trim() })}
                                      >
                                        {genningHere ? '生成中…' : '生成'}
                                      </button>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                        {stateVariants.length ? (
                          <div>
                            <div className="hint" style={{ margin: '4px 0 6px' }}>已锁定状态变体：</div>
                            <div className="pose-variant-list">
                              {stateVariants.map((v: any, idx: number) => {
                                const vSrc = toProjectAssetUrl(String(props.projectId || ''), String(v?.projectAssetUri || v?.cutoutPath || '').trim())
                                return (
                                  <div className="pose-variant-item" key={String(v?.id || idx)} title={String(v?.reason || '')}>
                                    {vSrc ? <img alt={String(v?.name || '状态')} src={vSrc} /> : null}
                                    <div style={{ fontWeight: 700, fontSize: 12 }}>{String(v?.name || `状态 ${idx + 1}`)}</div>
                                    {Number.isFinite(Number(v?.score)) ? <div className="hint">评分 {Math.round(Number(v.score))} 分</div> : null}
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
  }

  const renderGlobalPromptSections = () => (
              <div className="story-lock-global-sections">
                <div className="story-lock-global-section">
                  <div className="story-lock-global-subhead">
                    <div className="story-lock-global-subtitle">全局正向提示词</div>
                    <button className="btn secondary" type="button" onClick={() => openPromptLibrary(globalPromptLibTarget('positive'))} title="打开公共提示词库：选择已沉淀的正向片段插入（去重追加），或把当前内容存入库">公共提示词</button>
                    <button className="btn secondary" type="button" onClick={props.onTranslateGlobalPrompt} disabled={!promptZhConfirmed || promptOpBusy} title={promptZhConfirmed ? '' : '请先确认中文稿'}>{props.translatingScope === 'globalPrompt' ? `翻译中…${translateCountdownLabel}` : (promptOpBusy ? '请等待当前任务…' : (!promptZhConfirmed ? '中文转英文（先确认中文稿）' : '中文转英文'))}</button>
                  </div>
                  <div className="story-lock-prompt-grid">
                    <label className="story-lock-prompt-field">
                      <span>中文</span>
                      <textarea className="story-lock-textarea" value={String((props.value as any)?.globalPromptZh || '')} onChange={(e) => props.onChangeGlobalPromptZh(e.target.value)} placeholder="在这里编辑中文全局正向提示词" />
                    </label>
                    <label className="story-lock-prompt-field">
                      <span>英文</span>
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
                      <span>中文</span>
                      <textarea className="story-lock-textarea" value={String((props.value as any)?.globalNegativePromptZh || '')} onChange={(e) => props.onChangeGlobalNegativePromptZh(e.target.value)} placeholder="在这里编辑中文全局负向提示词" />
                    </label>
                    <label className="story-lock-prompt-field">
                      <span>英文</span>
                      <textarea className="story-lock-textarea" value={String(props.value?.globalNegativePrompt || '')} onChange={(e) => props.onChangeGlobalNegativePromptEn(e.target.value)} placeholder="翻译后或手工编辑英文负向提示词" />
                    </label>
                  </div>
                </div>
              </div>
  )

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
              <div className={`ai-storyboard-status ${props.assetConfirmReady ? 'ok' : (unlockedCount > 0 ? 'bad' : 'ok')}`}>
                {props.assetConfirmReady ? '已完成锁定' : (unlockedCount > 0 ? '进行中' : '待确认')}
              </div>
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
              <button className="btn secondary" type="button" onClick={() => void handleSave()} disabled={saveBusy}>
                {saveBusy ? '保存中…' : '保存'}
              </button>
            ) : null}
            <button className="btn secondary" type="button" onClick={props.onOpenRender} disabled={!props.assetConfirmReady}>进入正式场景出图</button>
            <button type="button" className="icon-btn" onClick={props.onClose} aria-label="关闭" title="关闭">✕</button>
          </div>
        </div>

        {/* ============ 2026-09-02 一级「事物总览」卡片墙（默认主视图；保存/出图在右上头部，两模式共用） ============ */}
        {viewMode === 'grid' ? (
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
              <button
                className="btn secondary"
                type="button"
                onClick={() => props.onEnhanceAllPrompts?.()}
                disabled={props.enhanceAllProgress?.busy || promptOpBusy || planAssets.length === 0 || props.assetPlanBusy || gridCounts.draft === 0}
                title="AI 逐个为全部资产生成中文正向/反向提示词"
              >
                {props.enhanceAllProgress?.busy ? `生成中…（${props.enhanceAllProgress.current}/${props.enhanceAllProgress.total}）` : '生成全部缺失提示词'}
              </button>
              <button
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

            {/* 筛选行：完成度 + 类型 */}
            <div className="story-lock-grid-filters">
              <span className="story-lock-grid-filter-group">
                {([['all', '全部'], ['todo', '未完成'], ['done', '已完成']] as const).map(([k, label]) => (
                  <button key={k} type="button" className={`story-lock-view-toggle-btn ${gridFilterDone === k ? 'active' : ''}`} onClick={() => setGridFilterDone(k)}>{label}</button>
                ))}
              </span>
              <span className="story-lock-grid-filter-group">
                {([['all', '全部类型'], ['character', '角色'], ['prop', '道具'], ['location', '地点']] as const).map(([k, label]) => (
                  <button key={k} type="button" className={`story-lock-view-toggle-btn ${gridFilterCat === k ? 'active' : ''}`} onClick={() => setGridFilterCat(k)}>{label}</button>
                ))}
              </span>
            </div>

            {/* 卡片墙：未锁定在前（待起草>待抽卡>待锁定>已锁定），同级按名称 */}
            <div className="story-lock-cardwall">
              {gridAssets.length ? gridAssets.map(({ asset, st }) => {
                const aid = String(asset?.id || '').trim()
                const img = assetCardImageOf(asset, projectId)
                const sceneCount = Number(asset?.sceneCount || (Array.isArray(asset?.sceneIds) ? asset.sceneIds.length : 0) || 0)
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
                    <div className="story-lock-thing-name" title={String(asset?.name || aid)}>{String(asset?.name || aid || '未命名')}</div>
                    <div className="story-lock-thing-meta">
                      <span className="story-lock-thing-cat">{getAssetCategoryLabel(String(asset?.category || ''))}</span>
                      <span className={`story-lock-thing-status ${st.tone}`}>{st.label}</span>
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
              }) : (
                <div className="hint" style={{ padding: 24 }}>当前筛选下没有事物卡片。</div>
              )}
            </div>
          </div>
        ) : null}

        {viewMode === 'steps' && wizardStep === 1 && (
          <div className="story-lock-step-panel">
            <div className="story-lock-step-panel-title">第 1 步 · 环境体检</div>
            <div className="hint">检查出图前置环境：Server 连通、提示词与出图 Provider/Model、ComfyUI 节点与模型完整性、连续性绑定。全部通过才能进入下一步。</div>
            <div className="story-lock-step-actions">
              <button className="btn secondary" type="button" onClick={props.onRunOpenChecks} disabled={props.assetPlanBusy || props.busyEntity}>{props.openChecks?.checking ? '体检中…' : (props.openChecks?.summary ? '重新体检' : '开始体检')}</button>
            </div>
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

        {viewMode === 'steps' && wizardStep === 6 && (
          <div className="story-lock-step-panel">
            <div className="story-lock-step-panel-title">第 6 步 · 线稿锁定</div>
            <div className="hint">为需要参考图的资产生成 ControlNet 线稿（hint → final）。已锁主参考的资产才能生成线稿。</div>
            {planAssets.length > 0 ? (
              <div className="story-lock-plan-list">
                {planAssets.map((asset) => renderAssetLineartRow(asset))}
              </div>
            ) : <div className="hint">还没有资产。请先完成第 3 步资产计划。</div>}
          </div>
        )}

        {viewMode === 'steps' && wizardStep === 7 && (
          <div className="story-lock-step-panel">
            <div className="story-lock-step-panel-title">第 7 步 · 完成锁定</div>
            <div className="hint">全部前置就绪后进入正式场景出图。批量渲染缺失场景可断点续跑；出图期间本地模型会自动让出内存给 ComfyUI。</div>
            <div className="story-lock-step-actions">
              <button className="btn secondary" type="button" onClick={() => void runRenderAllScenes()} disabled={renderAllBusy || renderAllActive || !projectId}>{renderAllActive ? '批量渲染进行中…' : '渲染缺失场景'}</button>
              <button className="btn secondary" type="button" onClick={props.onOpenRender} disabled={!props.assetConfirmReady}>进入正式场景出图</button>
            </div>
            {!props.assetConfirmReady ? <div className="hint">提示：先在第 4 步完成「确认锁定无误」。</div> : null}
          </div>
        )}

        {viewMode === 'steps' ? (
        <div className="story-lock-wizard-footer">
          <button className="btn secondary" type="button" onClick={() => setWizardStep((v) => Math.max(1, v - 1))} disabled={wizardStep <= 1}>上一步</button>
          <div className="story-lock-wizard-hint">{stepGateHint(Math.min(wizardStep + 1, firstNotReady)) ? `下一步前：${stepGateHint(Math.min(wizardStep + 1, firstNotReady))}` : ''}</div>
          <button className="btn secondary" type="button" onClick={() => gotoStep(wizardStep + 1)} disabled={wizardStep >= 7 || wizardStep + 1 > maxUnlockedStep}>下一步</button>
        </div>
        ) : null}

        {/* 2026-08-30：第 6 步也显示待审核列表——线稿在 manual 模式会挂出图前审核，不显示用户找不到批准入口 */}
        {((viewMode === 'steps' && (wizardStep === 5 || wizardStep === 6 || wizardStep === 7)) || viewMode === 'grid') && pendingReviews.length > 0 && (
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

        {viewMode === 'steps' && wizardStep === 4 && (
        <div className="story-lock-step-panel">
          <div className="story-lock-step-panel-title">第 4 步 · 全局与事物提示词</div>
          <div className="hint">先写中文：全局提示词与每个事物的专属提示词全部先生成中文稿，逐条审阅修改；确认后才允许翻译成英文并批准。批准后才进入抽图阶段——提示词锁定才能把图出对。</div>
          <div className="story-lock-step-actions">
            <button
              className="btn secondary"
              type="button"
              onClick={() => props.onEnhanceAllPrompts?.()}
              disabled={props.enhanceAllProgress?.busy || promptOpBusy || planAssets.length === 0 || props.assetPlanBusy}
              title="AI 逐个为需抽卡的事物（角色/道具）生成中文正向/反向提示词；背景锚点事物不参与（它们的锚点词直接写入场景背景）"
            >{props.enhanceAllProgress?.busy ? `生成中…（${props.enhanceAllProgress.current}/${props.enhanceAllProgress.total}）` : 'AI 生成全部事物中文提示词'}</button>
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
              title="由 AI 基于 Story Bible 世界锚点起草中文全局正向/负向提示词"
            >{props.globalDraftBusy ? '起草中…' : 'AI 起草中文全局稿'}</button>
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
          {/* 2026-10-07 只列出需抽卡的事物（角色/道具）：prompt_only/optional_ref 地点不出立绘，
              其锚点词直接烘进场景背景，提示词栏对它们是死重且误导（假日出游用户误报事件） */}
          {planAssets.filter((a) => String(a?.renderStrategy || '').trim() === 'ref_required').map((asset) => renderAssetPromptCard(asset))}
          {backgroundAnchorAssets.length > 0 ? (
            <div className="hint" style={{ padding: '6px 2px' }}>
              背景锚点事物（无需提示词与抽卡，锚点词已直接写入场景背景）：{backgroundAnchorAssets.map((a) => String(a?.name || a?.id || '未命名')).join('、')}
            </div>
          ) : null}
        </div>
        )}

        {viewMode === 'steps' && wizardStep === 5 && (
        <div className="story-lock-step-panel">
          <div className="story-lock-step-panel-title">第 5 步 · 参考图与锁定</div>
          <div className="hint">为每个资产抽卡生成候选参考图，选定主参考并锁定；图片审核在本步内联处理。全部锁定后才能进入下一步。</div>
          {!promptEnApproved ? <div className="story-lock-wizard-hint" style={{ textAlign: 'left' }}>按正确流程：请先完成第 4 步「全局与事物提示词」（中文稿确认→翻译→英文稿批准）后再开始抽图。</div> : null}
          <div className="story-lock-step-actions">
            <button className="btn secondary" type="button" onClick={props.onGenerateAllMissingAssetRefs} disabled={!promptEnApproved || props.assetPlanBusy || !assetPlan || missingBatchCount === 0} title={promptEnApproved ? '' : '请先完成第 4 步提示词批准'}>生成全部缺失参考图 ({missingBatchCount})</button>
            <button className="btn secondary" type="button" onClick={props.onConfirmAssetPlan} disabled={props.assetPlanBusy || !assetPlan || unlockedCount > 0}>{props.assetConfirmReady ? '已确认 ✓' : '确认锁定无误'}</button>
          </div>
        </div>
        )}

        {viewMode === 'steps' && wizardStep === 5 && (
        <div className="story-lock-workspace-assets">
          {planAssets.length ? planAssets.map((asset) => renderAssetRefRow(asset)) : (
            <div className="hint">尚未生成资产计划。请先生成 Story Bible，再生成资产计划。</div>
          )}
        </div>
        )}

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
                          const badge = poseScoreBadge(c)
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
                                  <button className="btn secondary" type="button" disabled={poseBusy || !cPath} onClick={() => props.onPoseDeleteCandidate?.(gAssetId, cPath)}>删除</button>
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
                                    disabled={poseBusy}
                                    onClick={() => void (async () => {
                                      const res = await props.onPoseDeleteVariant?.(gAssetId, String(v?.id || ''))
                                      if (res && !res.ok) setPoseBlockMsg(String(res.message || '该姿势变体正被摆放引用，无法删除'))
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

        {/* ============ 2026-09-02 二级资产详情弹层（环节锚点导航 + 上一个/下一个循环；内容复用 renderAsset*Row 渲染函数） ============ */}
        {detailAsset ? (() => {
          const dAsset = detailAsset
          const dAid = String(dAsset?.id || '').trim()
          const dStatus = assetLockStatusOf(dAsset, props.assetPromptDrafts as any)
          const dIsCharacter = String(dAsset?.category || '') === 'character'
          const navItems = [
            { key: 'prompt', label: '提示词', anchor: `detail-sec-prompt-${dAid}` },
            { key: 'ref', label: '参考图', anchor: `detail-sec-ref-${dAid}` },
            { key: 'lineart', label: '线稿', anchor: `detail-sec-lineart-${dAid}` },
            ...(dIsCharacter ? [{ key: 'pose', label: '姿势变体', anchor: `pose-asset-${dAid}` }] : [{ key: 'state', label: '状态变体', anchor: `state-asset-${dAid}` }])
          ]
          const scrollToAnchor = (anchor: string) => {
            if (dIsCharacter) setPoseExpanded((prev) => ({ ...prev, [dAid]: true }))
            else setStateExpanded((prev) => ({ ...prev, [dAid]: true }))
            window.setTimeout(() => {
              try { document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch {}
            }, 80)
          }
          return (
            <div className="story-lock-detail-overlay" role="dialog" aria-modal="true" aria-label="资产详情">
              <div className="story-lock-detail-card">
                <div className="story-lock-detail-head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <div style={{ fontWeight: 800, fontSize: 18, whiteSpace: 'nowrap' }}>{String(dAsset?.name || dAid || '未命名资产')}</div>
                    <span className="story-lock-thing-cat">{getAssetCategoryLabel(String(dAsset?.category || ''))}</span>
                    <span className={`story-lock-thing-status ${dStatus.tone}`}>{dStatus.label}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button className="btn secondary" type="button" onClick={() => detailNav(-1)} disabled={gridAssetsAll.length < 2}>← 上一个</button>
                    <button className="btn secondary" type="button" onClick={() => detailNav(1)} disabled={gridAssetsAll.length < 2}>下一个 →</button>
                    <button type="button" className="icon-btn" onClick={() => { setDetailAssetId(''); setDetailAnchor('') }} aria-label="关闭资产详情" title="关闭">✕</button>
                  </div>
                </div>
                <div className="story-lock-detail-nav">
                  {navItems.map((it) => (
                    <button key={it.key} type="button" className={`story-lock-view-toggle-btn ${detailAnchor === it.key ? 'active' : ''}`} onClick={() => { setDetailAnchor(it.key); scrollToAnchor(it.anchor) }}>
                      {it.label}
                    </button>
                  ))}
                </div>
                <div className="story-lock-detail-body">
                  <div id={`detail-sec-prompt-${dAid}`} className="story-lock-detail-sec">
                    <div className="story-lock-detail-sec-title">提示词</div>
                    {renderAssetPromptCard(dAsset)}
                  </div>
                  <div id={`detail-sec-ref-${dAid}`} className="story-lock-detail-sec">
                    <div className="story-lock-detail-sec-title">参考图</div>
                    {renderAssetRefRow(dAsset)}
                  </div>
                  <div id={`detail-sec-lineart-${dAid}`} className="story-lock-detail-sec">
                    <div className="story-lock-detail-sec-title">线稿</div>
                    {renderAssetLineartRow(dAsset)}
                  </div>
                </div>
              </div>
            </div>
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

        {/* 2026-09-02 存为配方：小 div 弹窗输入名称（禁止系统弹窗），存 project 自定义配方 */}
        {poseSaveRecipeAssetId ? (() => {
          const rAsset = planAssets.find((a) => String(a?.id || '').trim() === poseSaveRecipeAssetId) || null
          const rDraft = poseDraftOf(poseSaveRecipeAssetId, rAsset)
          const doSave = () => {
            const name = String(poseRecipeName || '').trim()
            if (!name) return
            props.onPoseSaveRecipe?.({ name, promptZh: String(rDraft.posePromptZh || '').trim(), promptEn: String(rDraft.posePromptEn || '').trim() })
            setPoseSaveRecipeAssetId('')
            setPoseRecipeName('')
          }
          return (
            <div className="pose-variant-block-overlay" role="dialog" aria-modal="true">
              <div className="pose-variant-block-card">
                <div style={{ fontWeight: 700 }}>存为配方</div>
                <div className="hint">把当前中英文稿存为项目自定义配方，全项目姿势变体区可用。</div>
                <input
                  className="pose-recipe-name-input"
                  value={poseRecipeName}
                  onChange={(e) => setPoseRecipeName(e.target.value)}
                  placeholder="配方名称（如：背身·指稻草）"
                  autoFocus
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button type="button" className="btn secondary" onClick={() => { setPoseSaveRecipeAssetId(''); setPoseRecipeName('') }}>取消</button>
                  <button type="button" className="btn secondary" disabled={!String(poseRecipeName || '').trim()} onClick={doSave}>保存配方</button>
                </div>
              </div>
            </div>
          )
        })() : null}

        {/* 2026-09-01 姿势变体删除阻断提示（div 弹窗，禁止系统弹窗）：变体正被摆放引用时先解除引用 */}
        {poseBlockMsg ? (
          <div className="pose-variant-block-overlay" role="dialog" aria-modal="true">
            <div className="pose-variant-block-card">
              <div style={{ fontWeight: 700 }}>无法删除姿势变体</div>
              <div className="hint">{poseBlockMsg}</div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button type="button" className="btn secondary" onClick={() => setPoseBlockMsg('')}>知道了</button>
              </div>
            </div>
          </div>
        ) : null}

        {/* 2026-09-10 填充保护确认（div 弹窗）：栏内已有内容时，填充类动作先选 追加/覆盖(可恢复)/取消 */}
        {poseFillGuard ? (
          <div className="pose-variant-block-overlay" role="dialog" aria-modal="true" aria-label="填充确认">
            <div className="pose-variant-block-card">
              <div style={{ fontWeight: 700 }}>{poseFillGuard.enOnly ? '英文栏已有内容' : '姿势需求栏已有内容'}</div>
              <div className="hint">
                {poseFillGuard.enOnly
                  ? '「中文转英文」将用中文栏的新译稿替换英文栏。覆盖=替换现有英文内容（自动备份，栏位旁可一键恢复，刷新不丢）。'
                  : `「${poseFillGuard.sourceLabel}」要填入新内容。追加=保留现有内容并拼接；覆盖=替换现有内容（自动备份，栏位旁可一键恢复，刷新不丢）。`}
              </div>
              <div className="pose-fill-preview">
                <div className="pose-fill-preview-block">
                  <div className="pose-fill-preview-label">{poseFillGuard.enOnly ? '当前英文' : '当前内容'}</div>
                  <div className="pose-fill-preview-text">{String((poseFillGuard.enOnly ? poseDraftOf(poseFillGuard.assetId, poseFillGuard.asset).posePromptEn : poseDraftOf(poseFillGuard.assetId, poseFillGuard.asset).posePromptZh) || '（空）').slice(0, 160)}</div>
                </div>
                <div className="pose-fill-preview-block">
                  <div className="pose-fill-preview-label">{poseFillGuard.enOnly ? '新译稿' : '新内容'}</div>
                  <div className="pose-fill-preview-text">{String((poseFillGuard.enOnly ? poseFillGuard.nextEn : poseFillGuard.nextZh) || '（空）').slice(0, 160)}</div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn secondary" onClick={() => setPoseFillGuard(null)}>取消</button>
                {poseFillGuard.enOnly ? null : (
                  <button type="button" className="btn secondary" onClick={() => { applyPoseFill(poseFillGuard, 'append'); setPoseFillGuard(null) }}>追加到现有内容</button>
                )}
                <button type="button" className="btn secondary" onClick={() => { applyPoseFill(poseFillGuard, 'overwrite'); setPoseFillGuard(null) }}>覆盖（可恢复）</button>
              </div>
            </div>
          </div>
        ) : null}

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
