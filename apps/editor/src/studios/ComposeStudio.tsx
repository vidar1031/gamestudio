import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js'
import AiBackgroundModal from '../AiBackgroundModal'
import AiStoryboardBatchModal, { type StoryboardBatchItem } from '../AiStoryboardBatchModal'
import StoryboardLockWorkspace from '../StoryboardLockWorkspace'
import { translateStoryboardPromptText } from '../storyboardPromptTranslate'
import { markStartupReady } from '../startupReady'
import { dlgAlert, dlgConfirm, dlgPrompt } from '../dialog'
import AiCharacterSpriteModal, { type AiCharacterSpriteDraft } from '../AiCharacterSpriteModal'
import { chromaKeyUrlToPng } from '../chromaKey'
import {
  analyzeBackgroundPromptAi,
  analyzeStoryAssetReferenceAi,
  deleteStoryAssetGalleryItemAi,
  enhanceStoryAssetPromptAi,
  generateStoryAssetLineartAi,
  generateStoryBibleAi,
  buildStoryAssetPlanAi,
  persistStoryAssetPlanAi,
  removeStoryboardAssetFromPlanAi,
  generateStoryAssetReferenceAi,
  optimizeStoryAssetReferenceAi,
  listStoryAssetGalleryAi,
  selectStoryAssetReferenceAi,
  analyzeCharacterFingerprintAi,
  createProject,
  extractStoryPoseStatesAi,
  extractStoryPropStatesAi,
  generatePropStateVariantAi,
  listPromptLibrary,
  exportProject,
  exportPublishPackage,
  listProjectExports,
  deleteProjectExport,
  generateBackgroundAi,
  generateCharacterSpriteAi,
  cutoutCharacterSpriteAi,
  reviewCharacterPoseAi,
  generateCharacterPosePromptAi,
  generateCharacterReferenceAi,
  getBlueprint,
  getScripts,
	  getProject,
  diagnoseStudio,
  getStudioSettings,
	  listProjects,
  openProjectAssetFolder,
  openProjectAiAssetsFolder,
  resolveUrl,
  renderStorySceneAi,
  reviewStoryboardPromptAi,
  generateStoryboardGlobalPromptAi,
  runStoryCompletenessCheckAi,
  getLatestStoryCompletenessReport,
  listProjectAiTasks,
  saveProject,
  preflightStudioImage,
	  uploadProjectImage,
  type AiBackgroundRequest,
  type AiTaskProgress,
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
  type StoryV1,
  type StoryCompletenessReport,
  type StoryboardPromptQualityReview,
  type StoryAssetGalleryEntry,
  type StoryAssetPlan,
  type SceneReviewRecord,
  type SceneReviewRound,
  startStorySceneReview,
  getLatestStorySceneReview,
  submitSceneReviewFeedback,
  compileCompose
} from '../api'

import { renderStage } from './compose/canvas/renderStage'
import {
  buildGlobalNegativeFromTemplate,
  defaultAiReq,
  loadAiBackgroundDraft,
  loadStoryboardContinuityBackup,
  mapTemplateStyleToStoryboardStyle,
  readHubTemplateFields,
  saveAiBackgroundDraft,
  saveStoryboardContinuityBackup
} from './compose/orchestration/draftStorage'
import { StageOverlay } from './compose/canvas/StageOverlay'
import { StageToolbar } from './compose/canvas/StageToolbar'
import { CompletenessModal } from './compose/modals/CompletenessModal'
import { LatestExportModal } from './compose/modals/LatestExportModal'
import { SceneReviewPanel } from './compose/modals/SceneReviewPanel'
import { StoryboardOverrideModal } from './compose/modals/StoryboardOverrideModal'
import { ComposeLeftPanel } from './compose/panels/LeftPanel'
import { ComposeRightPanel } from './compose/panels/RightPanel'
import { ComposeTopBar } from './compose/panels/ComposeTopBar'
import { ExternalUpdateBanner } from './compose/panels/ExternalUpdateBanner'
import type { EditorDoc, LatestExportAction, LeftTab, Selection } from './compose/types'
import {
  ensureNode,
  ensureTimelineForNode,
  normalizeChoicesAlign,
  normalizeChoicesDirection,
  normalizeDialogPreset,
  normalizeProjectV1,
  normalizeStageV1,
  normalizeStoryV1,
  validate
} from './compose/orchestration/normalize'
import {
  applyTimelineAction,
  buildDefaultVars,
  defaultEndingCardForNode,
  enterNodeRuntime,
  evalConditionExpr,
  normalizeAdvance,
  type RuntimeState
} from './compose/orchestration/runtime'
import { computeStageViewport } from './compose/orchestration/stageViewport'
import {
  DOUBAO_STORYBOARD_DEFAULTS,
  getDoubaoStoryboardDefaultSize,
  getStoryboardAssetPlanSummary,
  getStoryboardRequiredMissingAssets,
  getStoryboardRequiredUnlockedAssets,
  normalizeStoryboardAssetPlan,
  normalizeStoryboardLockAssetPromptDrafts,
  readStoryboardAssetConfirmedAtFromProject,
  readStoryboardAssetPlanFromProject,
  buildSelectedCharacterRefsFromChoices,
  recomputeStoryboardAssetPlanSummary,
  type StoryAssetGalleryState,
  type StoryboardBatchDraft,
  type StoryboardBatchState,
  type StoryboardLockAssetPromptDraft,
  type StoryboardOpenCheckState,
  type StoryboardPromptMeta,
  type StoryboardSceneAiBackgroundRequest,
  type StoryboardScenePromptStore
} from './compose/orchestration/storyboardPlan'
import { buildNodeTextSummary, clamp01, nodeKindLabel, nowHms, numberOr, resolveAsset, scriptCardLabel, uid } from './compose/orchestration/utils'


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
  // 2026-10-20 外壳升级：顶栏「导出/制作」下拉菜单开合（点击外部或再次点击收起）
  const [openMenu, setOpenMenu] = useState<'' | 'export' | 'produce'>('')

  useEffect(() => {
    if (!openMenu) return
    const close = () => setOpenMenu('')
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [openMenu])
  // 2026-09-03 外部更新检测：服务端 _rev 高于本地时横幅提示刷新。
  // 根因（用户实测"删除不掉/切换不了"）：旧会话内存态保存时 409 重试会把旧内容盖回磁盘，外部修正被回滚。
  const [externalNewerRev, setExternalNewerRev] = useState(0)
  // 2026-09-30 修复「知道了每次还出现」：知道了=按当前服务端版本打盹（snooze），
  // 只有服务端再次更新（rev 超过打盹值）才重新提示；此前点了仅清零、20s 轮询条件仍成立于是循环弹出。
  const [externalDismissedRev, setExternalDismissedRev] = useState(0)

  // 20s 轮询 + 窗口聚焦时检查：服务端 _rev 高于本地 → 提示刷新（自己保存成功后 _rev 同步，不会误报）
  useEffect(() => {
    if (doc.mode !== 'project' || !doc.project) return
    let cancelled = false
    const check = async () => {
      try {
        const fresh = await getProject(doc.id)
        const srvRev = Number((fresh && (fresh.project as any) && (fresh.project as any)._rev) || 0)
        const localRev = Number((doc.project as any)._rev || 0)
        if (!cancelled && srvRev > localRev && srvRev > externalDismissedRev) setExternalNewerRev(srvRev)
      } catch {}
    }
    const t = window.setInterval(check, 20_000)
    const onFocus = () => { void check() }
    window.addEventListener('focus', onFocus)
    void check()
    return () => {
      cancelled = true
      window.clearInterval(t)
      window.removeEventListener('focus', onFocus)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.mode, doc.id, doc.project && (doc.project as any)._rev, externalDismissedRev])
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
  // 主参考人工特批确认弹窗（div 弹窗，不用系统 confirm；2026-08-30 用户指令）
  const [sbOverrideModal, setSbOverrideModal] = useState<{ open: boolean; message: string }>({ open: false, message: '' })
  const sbOverrideResolverRef = useRef<((ok: boolean) => void) | null>(null)

  // AUTO-E05：完整度核实（真实浏览器逐节点走查导出 H5 + AI 视觉评审）
  // 弹窗打开期间经 /ai/tasks 轮询进度，任务完成后拉取最近报告；全程无黑盒等待。
  const [ccOpen, setCcOpen] = useState(false)
  const [ccBusy, setCcBusy] = useState(false)
  const [ccError, setCcError] = useState('')
  const [ccTask, setCcTask] = useState<AiTaskProgress | null>(null)
  const [ccReport, setCcReport] = useState<StoryCompletenessReport | null>(null)
  const [ccReportFile, setCcReportFile] = useState('')
  const ccReportLoadedTaskRef = useRef<string>('')

  // GS-53 场景图审核（2026-10-14，守护台审图中心接入）：逐场景整图评审（分数/问题清单/改图建议），
  // 面板打开期间轮询任务进度，完成后拉取最新一轮记录；打回重出把建议合入重出提示词。
  const [srOpen, setSrOpen] = useState(false)
  const [srBusy, setSrBusy] = useState(false)
  const [srError, setSrError] = useState('')
  const [srTask, setSrTask] = useState<AiTaskProgress | null>(null)
  const [srRound, setSrRound] = useState<SceneReviewRound | null>(null)
  const [srReworkBusy, setSrReworkBusy] = useState('')
  const srLoadedRef = useRef<string>('')

	  const [rightFold, setRightFold] = useState<{
	    nodeProps: boolean
	    nodeContent: boolean
	    timeline: boolean
	    background: boolean
	    choices: boolean
	    placements: boolean
	    composition: boolean
	  }>({
	    nodeProps: true,
	    nodeContent: true,
	    timeline: true,
	    background: true,
	    choices: true,
	    placements: false,
	    composition: true
	  })

  const toggleRightFold = (key: keyof typeof rightFold) =>
    setRightFold((prev) => ({
      ...prev,
      [key]: !prev[key]
    }))

  const [previewNodeId, setPreviewNodeId] = useState<string>('')
  const [activePlacementId, setActivePlacementId] = useState<string>('')
  // 2026-09-01：动作立绘工作流——右侧属性里的「动作描述」草稿（切换摆放时按场景文本预填）
  const [placementPoseDraft, setPlacementPoseDraft] = useState<string>('')
  // 场景编排器：层级列表中「背景」行的选中态（仅用于展示背景信息）
  const [bgRowSelected, setBgRowSelected] = useState(false)

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
  const [aiImageProvider, setAiImageProvider] = useState('')
  const [aiImageModel, setAiImageModel] = useState('')
  const AI_BG_DRAFT_KEY = `talkscene.ai.backgroundDraft.${String(props.projectId || 'global')}`
  const AI_BG_CONTINUITY_KEY = `talkscene.ai.storyboardContinuity.${String(props.projectId || 'global')}`

  const [aiReq, setAiReq] = useState<AiBackgroundRequest>(() => {
    const saved = loadAiBackgroundDraft(AI_BG_DRAFT_KEY)
    return { ...defaultAiReq, ...(saved || {}) }
  })
  const [aiLast, setAiLast] = useState<null | { url?: string; assetPath?: string; provider?: string; remoteUrl?: string; seed?: number; continuityUsed?: boolean }>(null)
  const [sbOpen, setSbOpen] = useState(false)
  const [sbRenderOpen, setSbRenderOpen] = useState(false)
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
  const [sbTestSceneId, setSbTestSceneId] = useState('')
  const [sbContinuityBusy, setSbContinuityBusy] = useState(false)
  const [sbContinuityReady, setSbContinuityReady] = useState(false)
  const [sbContinuitySummary, setSbContinuitySummary] = useState('')
  const [sbOpenChecks, setSbOpenChecks] = useState<StoryboardOpenCheckState>({
    checking: false,
    checkedAt: '',
    ok: false,
    serverOk: false,
    promptOk: false,
    imageOk: false,
    continuityBindingsOk: false,
    promptProvider: '',
    promptModel: '',
    imageProvider: '',
    imageModel: '',
    imageLoras: [],
    summary: '',
    issues: [],
    details: []
  })
  const [sbAssetPlan, setSbAssetPlan] = useState<StoryAssetPlan | null>(null)
  const [sbAssetPlanBusy, setSbAssetPlanBusy] = useState(false)
  const [sbGeneratingAssetId, setSbGeneratingAssetId] = useState('')
  const [sbAnalyzingAssetId, setSbAnalyzingAssetId] = useState('')
  const [sbOptimizingAssetId, setSbOptimizingAssetId] = useState('')
  const [sbSelectingAssetId, setSbSelectingAssetId] = useState('')
  const [sbLineartAssetId, setSbLineartAssetId] = useState('')
  const [sbGallery, setSbGallery] = useState<StoryAssetGalleryState | null>(null)
  const [sbGalleryBusy, setSbGalleryBusy] = useState(false)
  const [sbGalleryDeletingPaths, setSbGalleryDeletingPaths] = useState<string[]>([])
  const [sbAssetsConfirmedAt, setSbAssetsConfirmedAt] = useState('')
  const sbAssetConfirmReady = useMemo(
    () => Boolean(String(sbAssetsConfirmedAt || '').trim()) && getStoryboardRequiredUnlockedAssets(sbAssetPlan).length === 0,
    [sbAssetPlan, sbAssetsConfirmedAt]
  )
  const sbAssetConfirmSummary = useMemo(
    () => getStoryboardAssetPlanSummary(sbAssetPlan, sbAssetsConfirmedAt),
    [sbAssetPlan, sbAssetsConfirmedAt]
  )
  const [sbReq, setSbReq] = useState<StoryboardBatchState>({
    entitySpec: '',
    storyBibleJson: '',
    continuity: { ipadapterEnabled: true, requireCharacterRefs: true, controlnetEnabled: false },
    globalPromptZh: '',
    globalPrompt: '',
    globalNegativePromptZh: '',
    globalNegativePrompt: '',
    style: 'picture_book',
    aspectRatio: '9:16',
    width: 768,
    height: 1344,
    model: '',
    loras: [],
    size: '',
    responseFormat: 'url',
    watermark: false,
    sequentialImageGeneration: 'disabled',
    steps: 20,
    cfgScale: 7,
    sampler: 'DPM++ 2M',
    scheduler: 'Automatic'
  })
  const sbReqRef = useRef(sbReq)
  const sbGlobalPromptStateReadyRef = useRef(false)
  useEffect(() => { sbReqRef.current = sbReq }, [sbReq])
  const [sbAssetPromptDrafts, setSbAssetPromptDrafts] = useState<Record<string, StoryboardLockAssetPromptDraft>>({})
  // 2026-08-26 修复批量串行覆盖：长任务闭包只能读到渲染时的状态快照，批量增强时每个资产的更新会互相覆盖
  // （实测 14 个资产只剩最后一个落盘）。ref 镜像始终持最新草稿，更新函数一律从 ref 读取
  const sbAssetPromptDraftsRef = useRef<Record<string, StoryboardLockAssetPromptDraft>>({})
  useEffect(() => { sbAssetPromptDraftsRef.current = sbAssetPromptDrafts }, [sbAssetPromptDrafts])
  const [sbGlobalPromptReview, setSbGlobalPromptReview] = useState<StoryboardPromptQualityReview | null>(null)
  const [sbGlobalPromptReviewBusy, setSbGlobalPromptReviewBusy] = useState(false)
  const [sbPromptReviewingNodeId, setSbPromptReviewingNodeId] = useState('')
  const [sbTranslatingScope, setSbTranslatingScope] = useState('')
  const [sbTranslateDeadlineAt, setSbTranslateDeadlineAt] = useState(0)
  const [sbTranslateCountdownSec, setSbTranslateCountdownSec] = useState(0)
  const bgFileRef = useRef<HTMLInputElement | null>(null)
  const pendingBgAssetIdRef = useRef<string>('')
  const sbQueueRef = useRef<{ paused: boolean; cancelRequested: boolean }>({ paused: false, cancelRequested: false })

  useEffect(() => {
    setSbAssetPromptDrafts((prev) => normalizeStoryboardLockAssetPromptDrafts(sbAssetPlan, prev))
  }, [sbAssetPlan])

  // ============ 2026-08-26 锁定事物工作区打开状态持久化与恢复（用户指令：刷新不能丢正在操作的流程） ============
  const sbWsOpenStorageKey = 'talkscene.lockWorkspace.openProject'
  const sbWsRestoreDoneRef = useRef(false)
  // 打开即记录（只记最后操作的项目）；清除只发生在用户主动关闭/离开工作区的路径（onClose / onOpenRender），
  // 不能在 effect 里按 sbOpen=false 反推删除——挂载首轮 sbOpen 恒为 false，会先误删再导致恢复失败
  useEffect(() => {
    if (doc.mode !== 'project' || !doc.id || !sbOpen) return
    try { localStorage.setItem(sbWsOpenStorageKey, doc.id) } catch { /* 存储不可用时忽略 */ }
  }, [sbOpen, doc.mode, doc.id])
  // 刷新后项目数据就绪时，若上次离开也开着锁定事物工作区，自动回到该工作区（沿用顶部按钮的打开序列）
  useEffect(() => {
    if (sbWsRestoreDoneRef.current || sbOpen) return
    if (doc.mode !== 'project' || !doc.id || !doc.project || !doc.story) return
    let shouldRestore = false
    try { shouldRestore = localStorage.getItem(sbWsOpenStorageKey) === doc.id } catch {}
    if (!shouldRestore) return
    sbWsRestoreDoneRef.current = true
    void (async () => {
      await initStoryboardBatchFromDoc()
      setSbRenderOpen(false)
      setSbOpen(true)
      void runStoryboardOpenChecks()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.mode, doc.id, sbOpen])

  useEffect(() => {
    if (!sbItems.length) {
      setSbTestSceneId('')
      return
    }
    setSbTestSceneId((prev) => {
      if (prev && sbItems.some((item) => item.nodeId === prev)) return prev
      return String(sbItems[0]?.nodeId || '')
    })
  }, [sbItems])

  useEffect(() => {
    if (!sbTranslatingScope || !sbTranslateDeadlineAt) {
      setSbTranslateCountdownSec(0)
      return
    }
    const tick = () => {
      const remainMs = Math.max(0, sbTranslateDeadlineAt - Date.now())
      setSbTranslateCountdownSec(Math.ceil(remainMs / 1000))
    }
    tick()
    const timer = window.setInterval(tick, 250)
    return () => window.clearInterval(timer)
  }, [sbTranslatingScope, sbTranslateDeadlineAt])

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

  // 2026-09-01 姿势变体（出图统一管理在锁定向导）：busy 态 + 计划 ref 镜像（串行操作读 ref，避免闭包旧 plan）。
  // 候选/已锁定变体持久化在 plan 资产 poseCandidates/poseVariants（plan.json + project.json 副本双写）。
  const [sbPoseGeneratingId, setSbPoseGeneratingId] = useState('')
  const [sbPoseDrawProgress, setSbPoseDrawProgress] = useState<{ done: number; total: number } | null>(null)
  const [sbPoseReviewingId, setSbPoseReviewingId] = useState('')
  const [sbPoseLockingKey, setSbPoseLockingKey] = useState('')
  const [sbPosePromptBusyId, setSbPosePromptBusyId] = useState('')
  const [sbPoseFocusAssetId, setSbPoseFocusAssetId] = useState('')
  const [sbPoseGalleryAssetId, setSbPoseGalleryAssetId] = useState('')
  const sbPosePlanRef = useRef<StoryAssetPlan | null>(null)
  sbPosePlanRef.current = sbAssetPlan

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
    if (!(sbBusyGenerate || sbBusyApply || sbBusyEntity)) {
      setSbElapsedMs(0)
      return
    }
    const startedAt = Date.now()
    setSbElapsedMs(0)
    const t = window.setInterval(() => setSbElapsedMs(Date.now() - startedAt), 100)
    return () => window.clearInterval(t)
  }, [sbBusyGenerate, sbBusyApply, sbBusyEntity])

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
          console.error('[talkscene] pixi init failed:', e)
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
    // 结局等非场景节点同样按 story 顺序编号（#N），与场景节点口径一致
    const idx = (doc.story?.nodes || []).findIndex((x: any) => String(x?.id || '') === String(n?.id || ''))
    if (String(n.kind || '') !== 'scene') {
      const name = String(n.name || n.id)
      return idx >= 0 ? `#${idx + 1} ${name}` : name
    }
    const sc = scriptCardById.get(String(n.blueprint?.scriptCardId || ''))
    return scriptCardLabel(sc) || (idx >= 0 ? `#${idx + 1} ${String(n.name || n.id)}` : String(n.name || n.id))
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

  // 场景编排器：编辑/预览模式、缩放（以画布中心为基准）与平移视图状态
  const [editMode, setEditMode] = useState(true)
  const [stageZoom, setStageZoom] = useState(1)
  const [stagePan, setStagePan] = useState({ x: 0, y: 0 })
  const [panToolActive, setPanToolActive] = useState(false)

  // 场景编排器：会话内撤销栈——placement 变更的 doc.story JSON 快照（栈深 50）
  const undoStackRef = useRef<string[]>([])
  const [undoCount, setUndoCount] = useState(0)
  const pushUndo = () => {
    if (!doc.story) return
    try {
      undoStackRef.current.push(JSON.stringify(doc.story))
      if (undoStackRef.current.length > 50) undoStackRef.current.shift()
      setUndoCount(undoStackRef.current.length)
    } catch {}
  }
  const undoPlacementChange = () => {
    const prev = undoStackRef.current.pop()
    setUndoCount(undoStackRef.current.length)
    if (!prev) return
    try {
      const snap = JSON.parse(prev)
      setDocStory(() => snap)
    } catch {}
  }
  // 切换项目清空撤销栈
  useEffect(() => {
    undoStackRef.current = []
    setUndoCount(0)
  }, [doc.id])
  // Ctrl/Cmd+Z 撤销（输入框/下拉内不拦截，保留原生文本撤销）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return
      if (String(e.key || '').toLowerCase() !== 'z') return
      const t = e.target as HTMLElement | null
      const tag = t && t.tagName ? t.tagName : ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return
      e.preventDefault()
      const prevSnap = undoStackRef.current.pop()
      setUndoCount(undoStackRef.current.length)
      if (!prevSnap) return
      try { setDocStory(() => JSON.parse(prevSnap)) } catch {}
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 场景编排器：写回当前预览节点某个摆放的 transform（拖动提交 / Shift+滚轮缩放共用）
  const updatePreviewPlacementTransform = (placementId: string, patch: Partial<{ x: number; y: number; scale: number; rotationDeg: number }>) => {
    const nodeId = effectivePreviewNode ? String(effectivePreviewNode.id || '') : ''
    if (!nodeId || !placementId) return
    pushUndo()
    setDocStory((s) => ({
      ...s,
      nodes: s.nodes.map((x) => {
        if (x.id !== nodeId) return x
        const nn = ensureNode(x)
        return {
          ...nn,
          visuals: {
            ...nn.visuals,
            placements: (nn.visuals?.placements || []).map((pp) =>
              pp.id === placementId ? { ...pp, transform: { ...pp.transform, ...patch } } : pp
            )
          }
        }
      })
    }))
  }

  // 场景编排器：Shift+滚轮缩放当前选中摆放（原生监听，passive:false 才能 preventDefault）
  // 撤销快照按 700ms 合并，连续滚动只产生一条撤销记录
  const lastWheelUndoAtRef = useRef(0)
  useEffect(() => {
    const host = canvasHostRef.current
    const pid = activePlacementId
    if (!host || !pid || !editMode) return
    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey) return
      e.preventDefault()
      const nodeId = effectivePreviewNode ? String(effectivePreviewNode.id || '') : ''
      if (!nodeId) return
      const now = Date.now()
      if (now - lastWheelUndoAtRef.current > 700) {
        pushUndo()
        lastWheelUndoAtRef.current = now
      }
      const delta = e.deltaY < 0 ? 0.05 : -0.05
      setDocStory((s) => ({
        ...s,
        nodes: s.nodes.map((x) => {
          if (x.id !== nodeId) return x
          const nn = ensureNode(x)
          return {
            ...nn,
            visuals: {
              ...nn.visuals,
              placements: (nn.visuals?.placements || []).map((pp) => {
                if (pp.id !== pid) return pp
                const cur = numberOr(pp.transform?.scale, 1)
                const next = Math.max(0.05, Math.min(4, Math.round((cur + delta) * 1000) / 1000))
                return { ...pp, transform: { ...pp.transform, scale: next } }
              })
            }
          }
        })
      }))
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlacementId, effectivePreviewNode, editMode])

  // 场景编排器：左栏「素材」列表（项目角色 + 已锁定计划资产，仅列可解析出项目图片资产的项）
  const stageMaterials = useMemo(() => {
    const list: Array<{ key: string; name: string; kind: string; characterId?: string; imageAssetId: string }> = []
    for (const c of doc.project?.characters || []) {
      const img = String((c as any).imageAssetId || '').trim()
      if (!img) continue
      if (!(doc.project?.assets || []).some((a) => a.id === img)) continue
      list.push({ key: `ch:${c.id}`, name: String(c.name || c.id), kind: '角色', characterId: c.id, imageAssetId: img })
    }
    const planForMaterials = sbAssetPlan || readStoryboardAssetPlanFromProject(doc.project)
    const planAssets = Array.isArray((planForMaterials as any)?.assets) ? (planForMaterials as any).assets : []
    for (const asset of planAssets) {
      const uri = String(asset?.primaryReferenceAssetUri || '').trim()
      if (!uri) continue
      let imageAssetId = String(asset?.primaryReferenceAssetId || '').trim()
      if (!imageAssetId) {
        const refs = Array.isArray(asset?.generatedRefs) ? asset.generatedRefs : []
        const hit = refs.find((r: any) => String(r?.projectAssetId || '').trim() && String(r?.projectAssetUri || '').trim().replace(/^\/+/, '') === uri.replace(/^\/+/, ''))
          || refs.find((r: any) => String(r?.projectAssetId || '').trim())
        imageAssetId = String(hit?.projectAssetId || '').trim()
      }
      if (!imageAssetId) continue
      if (!(doc.project?.assets || []).some((a) => a.id === imageAssetId)) continue
      const cat = String(asset?.category || '').trim()
      const kind = cat === 'character' ? '角色' : cat === 'prop' ? '道具' : cat === 'location' ? '地点' : '资产'
      list.push({ key: `asset:${String(asset?.id || imageAssetId)}`, name: String(asset?.name || asset?.id || imageAssetId), kind, imageAssetId })
    }
    return list
  }, [doc.project, sbAssetPlan])

  // 场景编排器：素材拖入舞台 → 按落点追加摆放（同素材允许多实例）
  const [canvasDropActive, setCanvasDropActive] = useState(false)
  const handleDropMaterial = (raw: string, clientX: number, clientY: number) => {
    if (doc.readonly || doc.mode !== 'project') return
    if (!editMode) {
      setToast('预览模式下不可编辑，请先在画布上方切换到编辑模式')
      return
    }
    const node = effectivePreviewNode
    if (!node) return
    let payload: any = null
    try { payload = JSON.parse(raw) } catch { payload = null }
    const imageAssetId = String(payload?.imageAssetId || '').trim()
    if (!imageAssetId) return
    const characterId = String(payload?.characterId || '').trim()
    const host = canvasHostRef.current
    let nx = 0.5
    let ny = 0.9
    if (host && stageViewport) {
      const rect = host.getBoundingClientRect()
      const zoom = Math.max(0.25, Math.min(4, Number(stageZoom) || 1))
      const cx0 = rect.width / 2
      const cy0 = rect.height / 2
      const rootX = cx0 + (stageViewport.offsetX - cx0) * zoom + stagePan.x
      const rootY = cy0 + (stageViewport.offsetY - cy0) * zoom + stagePan.y
      const eff = stageViewport.scale * zoom
      nx = clamp01((clientX - rect.left - rootX) / eff / stageViewport.stageW)
      ny = clamp01((clientY - rect.top - rootY) / eff / stageViewport.stageH)
    }
    const p: CharacterPlacementV1 = {
      id: uid('pl'),
      characterId,
      imageAssetId,
      transform: { x: nx, y: ny, scale: 0.62, rotationDeg: 0 },
      visible: true,
      zIndex: 0
    }
    const nodeId = String(node.id || '')
    pushUndo()
    setDocStory((s) => ({
      ...s,
      nodes: s.nodes.map((x) => {
        if (x.id !== nodeId) return x
        const nn = ensureNode(x)
        return { ...nn, visuals: { ...nn.visuals, placements: [...(nn.visuals?.placements || []), p] } }
      })
    }))
    setSelection({ type: 'node', id: nodeId })
    setActivePlacementId(p.id)
    setRightFold((prev) => ({ ...prev, placements: true }))
  }

  // 场景编排器：工具条操作（当前预览节点 + 选中摆放）
  const previewPlacements = useMemo(() => {
    const n = effectivePreviewNode ? ensureNode(effectivePreviewNode) : null
    return (n?.visuals?.placements || []) as CharacterPlacementV1[]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectivePreviewNode])
  const toolbarPlacement = previewPlacements.find((pp) => pp.id === activePlacementId) || null
  // 动作立绘工作流：切换选中摆放时，按当前节点场景文本预填「动作描述」（用户可改后再生成）
  useEffect(() => {
    if (!activePlacementId) return
    const n = effectivePreviewNode ? ensureNode(effectivePreviewNode) : null
    const text = n ? String((n as any).body?.text || '').trim() : ''
    setPlacementPoseDraft(buildNodeTextSummary(text))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlacementId, effectivePreviewNode && (effectivePreviewNode as any).id])
  const mutatePreviewPlacement = (placementId: string, mutate: (pp: CharacterPlacementV1) => CharacterPlacementV1) => {
    const nodeId = effectivePreviewNode ? String(effectivePreviewNode.id || '') : ''
    if (!nodeId || !placementId) return
    pushUndo()
    setDocStory((s) => ({
      ...s,
      nodes: s.nodes.map((x) => {
        if (x.id !== nodeId) return x
        const nn = ensureNode(x)
        return {
          ...nn,
          visuals: {
            ...nn.visuals,
            placements: (nn.visuals?.placements || []).map((pp) => (pp.id === placementId ? mutate(pp) : pp))
          }
        }
      })
    }))
  }
  const togglePlacementFlip = (axis: 'flipX' | 'flipY') => {
    if (!toolbarPlacement) return
    mutatePreviewPlacement(toolbarPlacement.id, (pp) => ({
      ...pp,
      transform: { ...pp.transform, [axis]: !Boolean((pp.transform as any)?.[axis]) } as any
    }))
  }
  const bumpPlacementZ = (delta: number) => {
    if (!toolbarPlacement) return
    mutatePreviewPlacement(toolbarPlacement.id, (pp) => ({ ...pp, zIndex: numberOr(pp.zIndex, 0) + delta }))
  }
  const deleteToolbarPlacement = () => {
    if (!toolbarPlacement) return
    const pid = toolbarPlacement.id
    const nodeId = effectivePreviewNode ? String(effectivePreviewNode.id || '') : ''
    if (!nodeId) return
    pushUndo()
    setDocStory((s) => ({
      ...s,
      nodes: s.nodes.map((x) => {
        if (x.id !== nodeId) return x
        const nn = ensureNode(x)
        return { ...nn, visuals: { ...nn.visuals, placements: (nn.visuals?.placements || []).filter((pp) => pp.id !== pid) } }
      })
    }))
    setActivePlacementId('')
  }

  // 2026-09-01 选中即属性（A）：画布点选摆放 → 切节点上下文 + 左栏回节点页签 + 展开元素层级 + 右栏滚动到摆放属性。
  // 此前 onSelect 只 setActivePlacementId，角色/资源页签下点图右栏毫无反应（用户实测"点击图无法打开属性"）。
  // 双击（400ms 内同摆放两次点选）跳转锁定向导该角色资产的姿势变体区（2026-09-01 起出图统一在锁定向导管理）。
  const stageLastSelectRef = useRef<{ id: string; at: number }>({ id: '', at: 0 })
  const placementPropsRef = useRef<HTMLDivElement | null>(null)
  function handleStageSelect(placementId: string) {
    if (!editMode) return // D：预览态只读（renderStage 的 interactive 已有门控，此处双保险）
    const pid = String(placementId || '').trim()
    if (pid) {
      const now = Date.now()
      const last = stageLastSelectRef.current
      stageLastSelectRef.current = { id: pid, at: now }
      if (last.id === pid && now - last.at < 400) {
        stageLastSelectRef.current = { id: '', at: 0 }
        const n0 = effectivePreviewNode ? ensureNode(effectivePreviewNode) : null
        const pl = n0 ? (n0.visuals?.placements || []).find((pp) => pp.id === pid) : null
        if (n0 && pl) {
          // 2026-09-01 出图统一管理在锁定向导：双击摆放改为跳转该角色资产的姿势变体区（不再开抽卡池弹窗）
          void openPoseVariantManagerForCharacter(String(pl.characterId || ''))
        }
      }
    }
    setActivePlacementId(pid)
    if (!pid) return
    const n = effectivePreviewNode
    if (n) setSelection({ type: 'node', id: String(n.id || '') })
    setLeftTab('nodes')
    setRightFold((prev) => ({ ...prev, placements: true }))
    const nn = n ? ensureNode(n) : null
    const pl = nn ? (nn.visuals?.placements || []).find((pp) => pp.id === pid) : null
    const ch = pl && doc.project ? (doc.project.characters || []).find((c) => c.id === pl.characterId) || null : null
    setToast(`已选中：${ch?.name || '摆放'}（右侧面板可调整属性）`)
  }

  // A：选中摆放后右栏自动滚动到「摆放属性」卡片（key 变化重挂载触发高亮脉冲）
  useEffect(() => {
    if (!activePlacementId) return
    const t = window.setTimeout(() => {
      try {
        placementPropsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      } catch {}
    }, 100)
    return () => window.clearTimeout(t)
  }, [activePlacementId])

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
      isStale: () => stageRenderSeqRef.current !== seq,
      interaction: {
        onSelect: (placementId) => handleStageSelect(placementId),
        onCommitTransform: (placementId, patch) => updatePreviewPlacementTransform(placementId, patch)
      },
      view: {
        zoom: stageZoom,
        panX: stagePan.x,
        panY: stagePan.y,
        panTool: panToolActive,
        editable: editMode,
        onPanCommit: (px, py) => setStagePan({ x: px, y: py })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // 2026-09-30 修复：deps 加入 canvasSize——浏览器伸缩时 ResizeObserver 更新 canvasSize，
    // 缺了它 renderStage 不重跑，舞台 root 仍按旧画布尺寸定位，画面不跟随居中（实测复现）
  }, [doc, effectivePreviewNode, rt.stageOverride, stageZoom, stagePan, panToolActive, editMode, canvasSize])

  // 场景编排器：选中摆放的画布高亮框（独立叠加层，选中变化不触发整棵舞台重建，避免打断拖动）
  useEffect(() => {
    const app = appRef.current
    if (!app) return
    const st: any = app.stage
    const old = st.__selOverlay as Graphics | null | undefined
    if (old) {
      try { st.removeChild(old); old.destroy() } catch {}
      st.__selOverlay = null
    }
    if (!editMode || !activePlacementId || !doc.project) return
    const root: any = st.children && st.children[0]
    if (!root || !Array.isArray(root.children)) return
    const sp: any = root.children.find((c: any) => c && c.__placementId === activePlacementId)
    if (!sp) return
    const w = Math.abs(Number(sp.width) || 0)
    const h = Math.abs(Number(sp.height) || 0)
    if (!w || !h) return
    const g = new Graphics()
    const sw = Math.max(1.5 / Math.max(0.001, Number(root.scale?.x) || 1), 0.5)
    g.rect(sp.x - w / 2, sp.y - h, w, h).stroke({ width: sw, color: 0x5eccff, alpha: 0.95 })
    root.addChild(g)

    // 2026-09-01 四角缩放手柄（C1）：拖拽手柄改缩放，替代必须记住的 Shift+滚轮。
    // 以 sprite 锚点（底中）为缩放中心，按手柄到锚点的距离比实时改 scale，pointerup 一次性提交。
    const handleSize = Math.max(10 / Math.max(0.001, Number(root.scale?.x) || 1), 4)
    const corners: Array<[number, number]> = [
      [sp.x - w / 2, sp.y - h],
      [sp.x + w / 2, sp.y - h],
      [sp.x - w / 2, sp.y],
      [sp.x + w / 2, sp.y]
    ]
    const handles: Graphics[] = []
    for (const [cx, cy] of corners) {
      const hg = new Graphics()
      hg.rect(-handleSize / 2, -handleSize / 2, handleSize, handleSize).fill({ color: 0x5eccff }).stroke({ width: sw, color: 0x0b1720 })
      hg.x = cx
      hg.y = cy
      hg.eventMode = 'static'
      hg.cursor = 'nwse-resize'
      hg.on('pointerdown', (e: any) => {
        e.stopPropagation()
        const anchorGlobal = sp.toGlobal({ x: 0, y: 0 })
        const startDist = Math.max(1, Math.hypot(e.global.x - anchorGlobal.x, e.global.y - anchorGlobal.y))
        const baseScale = Math.abs(Number(sp.scale?.x) || 1)
        const signX = Number(sp.scale?.x) < 0 ? -1 : 1
        const signY = Number(sp.scale?.y) < 0 ? -1 : 1
        let latest = 0
        const onMove = (ev: any) => {
          const dist = Math.hypot(ev.global.x - anchorGlobal.x, ev.global.y - anchorGlobal.y)
          const next = Math.max(0.05, Math.min(4, (baseScale * dist) / startDist))
          latest = next
          sp.scale.set(signX * next, signY * next)
        }
        const onUp = () => {
          st.off('pointermove', onMove)
          st.off('pointerup', onUp)
          st.off('pointerupoutside', onUp)
          if (latest > 0) updatePreviewPlacementTransform(activePlacementId, { scale: Math.round(latest * 1000) / 1000 })
        }
        st.on('pointermove', onMove)
        st.on('pointerup', onUp)
        st.on('pointerupoutside', onUp)
      })
      root.addChild(hg)
      handles.push(hg)
    }
    // 手柄作为高亮框子节点，随框一起销毁（g 无变换，子节点坐标即 root 坐标）
    for (const hg of handles) {
      try { root.removeChild(hg); g.addChild(hg) } catch {}
    }
    st.__selOverlay = g
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePlacementId, doc, effectivePreviewNode, stageZoom, stagePan, editMode])

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
      // 2026-10-05 合成层自动播种：AI 生成只写 scripts/blueprint，story.json 仍是默认"开始/结局"占位——
      // 此时进入合成层会一片空白（用户"进入创建后没有内容"事件）。检测占位态 + 蓝图有真实节点时自动编译合成层。
      let storyRaw = data.story
      try {
        const rawNodes = Array.isArray((storyRaw as any)?.nodes) ? (storyRaw as any).nodes : []
        const hasVisuals = rawNodes.some((n: any) => {
          const v = n?.visuals
          if (!v) return false
          if (v.backgroundAssetId || v.background) return true
          return Array.isArray(v.placements) && v.placements.length > 0
        })
        const isPlaceholder = rawNodes.length <= 2 && !hasVisuals
        if (isPlaceholder && bpNodeIds.length > 2) {
          const compiled = await compileCompose(id)
          if (compiled?.story && Array.isArray((compiled.story as any).nodes) && (compiled.story as any).nodes.length > rawNodes.length) {
            storyRaw = compiled.story
          }
        }
      } catch { /* 播种失败保持原样，不阻断打开 */ }
      const story = normalizeStoryV1(storyRaw as any)
      // 场景编排器：补齐缺失的 placement id（服务端生成的旧摆放可能没有 id，画布拖动与属性面板都依赖 id 寻址）
      let placementsBackfilled = false
      const storyNodesWithIds = (story.nodes || []).map((n) => {
        const pls = (n as any).visuals?.placements
        if (!Array.isArray(pls) || !pls.length) return n
        let changed = false
        const nextPls = pls.map((p: any) => {
          if (String(p?.id || '').trim()) return p
          changed = true
          return { ...p, id: uid('pl') }
        })
        if (!changed) return n
        placementsBackfilled = true
        return { ...n, visuals: { ...(n as any).visuals, placements: nextPls } }
      })
      const storyFinal = placementsBackfilled ? ({ ...story, nodes: storyNodesWithIds } as typeof story) : story
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
        story: storyFinal
      })
      setSelection({ type: 'node', id: story.startNodeId })
      setLeftTab('nodes')
      setDirty(false)
      if (placementsBackfilled) setDirty(true)
      setToast('项目已打开')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      markStartupReady() // 启动覆盖层按真实加载收尾（重复调用安全）
    }
  }

  async function reloadProjectAndStoryboard() {
    if (doc.mode !== 'project') return
    await openProject(doc.id)
    if (sbOpen) await initStoryboardBatchFromDoc()
  }

  async function createNewProject() {
    const title = await dlgPrompt('新项目名称', { defaultValue: '未命名故事', placeholder: '请输入项目名称' })
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

  async function saveCurrent(): Promise<boolean> {
    if (doc.mode !== 'project' || !doc.project || !doc.story) return false
    setBusy(true)
    setError('')
    try {
      const projectToSave = buildStoryboardLockProjectSnapshot(doc.project)
      // 乐观锁：携带当前 _rev；服务端版本不符返回 409（其他地方已更新）时刷新最新内容，避免旧内存态覆盖
      const p = await saveProject(doc.id, { project: projectToSave, story: doc.story, _rev: Number((doc.project as any)._rev || 0) })
      setDoc((prev) => ({ ...prev, project: p, title: p.title }))
      setDirty(false)
      setToast('已保存')
      await refreshProjects()
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/rev_conflict|已更新|409/.test(msg)) {
        // 乐观锁冲突时取最新版本号重试一次（保住用户未保存的编辑，避免"刚拖入的元素突然消失"）；
        // 重试仍冲突才刷新整页（真正的多会话竞争）。
        try {
          const cur = await getProject(doc.id)
          const freshRev = Number((cur && (cur as any).project && (cur as any).project._rev) || 0)
          const p2 = await saveProject(doc.id, { project: buildStoryboardLockProjectSnapshot(doc.project), story: doc.story, _rev: freshRev })
          setDoc((prev) => ({ ...prev, project: p2, title: p2.title }))
          setDirty(false)
          setToast('已保存（已合并最新变更）')
          await refreshProjects()
          return true
        } catch (_) {
          setToast('项目在其他地方已更新，已刷新最新内容，请重试刚才的操作')
          try { await openProject(doc.id) } catch (_) { /* 刷新失败仅提示 */ }
        }
      } else {
        setError(msg)
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  async function persistCurrentForExport() {
    if (doc.mode !== 'project' || !doc.project || !doc.story) return
    const projectToSave = buildStoryboardLockProjectSnapshot(doc.project)
    const p = await saveProject(doc.id, { project: projectToSave, story: doc.story, _rev: Number((doc.project as any)._rev || 0) })
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

  useEffect(() => {
    // 2026-08-31 修复：此前自动保存被 !sbOpen && !sbRenderOpen 门控——只在弹窗打开时才保存，
    // 编排器画布的层级/拖动修改不落盘（用户刷新后层级回退的根因）。改为 dirty 即 1.2s 防抖保存，busy 守卫保留。
    if (busy || sbBusyGenerate || sbBusyApply || sbBusyEntity || sbContinuityBusy) return
    if (doc.mode !== 'project' || !dirty) return
    const t = window.setTimeout(() => {
      void saveCurrent()
    }, 1200)
    return () => window.clearTimeout(t)
  }, [sbOpen, sbRenderOpen, busy, sbBusyGenerate, sbBusyApply, sbBusyEntity, sbContinuityBusy, doc.mode, dirty])

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

  // AUTO-E05：打开完整度核实弹窗（不触发新核实；弹窗内「重新核实」才触发）。
  // 轮询在无活动任务时自动载入最近报告，因此历史报告可直接查看。
  function openCompletenessModal() {
    if (doc.mode !== 'project') return
    setCcError('')
    setCcOpen(true)
  }

  // 触发完整度核实。服务端异步执行（202 + taskId），此处只开弹窗并交给轮询。
  async function runCompletenessCheck() {
    if (doc.mode !== 'project' || ccBusy) return
    setCcOpen(true)
    setCcError('')
    setCcBusy(true)
    try {
      await runStoryCompletenessCheckAi(doc.id, {})
    } catch (e) {
      setCcError(e instanceof Error ? e.message : String(e))
    } finally {
      setCcBusy(false)
    }
  }

  function ccScreenshotUrl(screenshotDir: string, file: string) {
    return resolveUrl(`/project-assets/${encodeURIComponent(doc.id)}/${String(screenshotDir || '').replace(/^\/+/, '')}/${encodeURIComponent(file)}`)
  }

  // 弹窗打开期间轮询任务进度；无活动任务时拉取最近报告（同一 taskId 只拉一次），
  // 覆盖两种场景：任务刚完成出报告、打开弹窗直接查看上次报告。
  useEffect(() => {
    if (!ccOpen || doc.mode !== 'project' || !doc.id) return undefined
    let stopped = false
    const pull = async () => {
      try {
        const tasks = await listProjectAiTasks(doc.id)
        if (stopped) return
        const task = tasks.find((t) => t.kind === 'story.completeness_check') || null
        setCcTask(task)
        const active = Boolean(task && !task.done)
        const loadedKey = task ? task.taskId : 'none'
        if (!active && ccReportLoadedTaskRef.current !== loadedKey) {
          ccReportLoadedTaskRef.current = loadedKey
          const latest = await getLatestStoryCompletenessReport(doc.id).catch(() => null)
          if (stopped) return
          if (latest) {
            setCcReport(latest.report)
            setCcReportFile(latest.file)
          }
        }
      } catch (_) { /* 轮询失败忽略，下轮重试 */ }
    }
    void pull()
    const timer = window.setInterval(pull, 2000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [ccOpen, doc.mode, doc.id])

  // GS-53 场景图审核：面板打开期间轮询 story.scene.review 任务进度；任务终结后拉最新一轮记录
  useEffect(() => {
    if (!srOpen || doc.mode !== 'project' || !doc.id) return undefined
    let stopped = false
    const pull = async () => {
      try {
        const tasks = await listProjectAiTasks(doc.id)
        if (stopped) return
        const task = tasks.find((t) => t.kind === 'story.scene.review') || null
        setSrTask(task)
        const active = Boolean(task && !task.done)
        const loadedKey = task ? `${task.taskId}:${task.done ? 'done' : 'active'}` : 'none'
        if (!active && srLoadedRef.current !== loadedKey) {
          srLoadedRef.current = loadedKey
          const latest = await getLatestStorySceneReview(doc.id).catch(() => null)
          if (stopped) return
          if (latest?.latest) setSrRound(latest.latest)
        }
      } catch (_) { /* 轮询失败忽略，下轮重试 */ }
    }
    void pull()
    const timer = window.setInterval(pull, 2000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [srOpen, doc.mode, doc.id])

  async function openSceneReviewPanel() {
    setSrError('')
    setSrOpen(true)
    srLoadedRef.current = ''
    // 打开即拉已有记录（空态也在面板内提示）
    try {
      const latest = await getLatestStorySceneReview(doc.id)
      if (latest?.latest) setSrRound(latest.latest)
    } catch (e) {
      setSrError(e instanceof Error ? e.message : String(e))
    }
  }

  async function runSceneReview() {
    if (srBusy || doc.mode !== 'project' || !doc.id) return
    setSrBusy(true)
    setSrError('')
    try {
      await startStorySceneReview(doc.id)
      // 任务进度由面板轮询接管（taskId 下一拍经列表出现）
    } catch (e) {
      setSrError(e instanceof Error ? e.message : String(e))
    } finally {
      setSrBusy(false)
    }
  }

  function srFeedbackStatusOf(sceneId: string) {
    const feedback = (srRound?.feedback || []).filter((f) => f.sceneId === sceneId)
    const latest = feedback.length ? feedback[feedback.length - 1] : null
    return latest?.kind || ''
  }

  async function reworkScene(record: SceneReviewRecord) {
    if (!doc.id || srReworkBusy) return
    setSrReworkBusy(record.sceneId)
    setSrError('')
    try {
      const suggestions = (record.suggestions || []).filter(Boolean)
      const note = suggestions.length ? `打回重出（建议合入重出提示词）：${suggestions.join('；')}` : '打回重出'
      // 先留痕（feedback_pending），再调单场景重出端点（建议合入重出提示词 scenePrompt）
      await submitSceneReviewFeedback(doc.id, { sceneId: record.sceneId, sceneName: record.sceneName, action: 'feedback_pending', note })
      await renderStorySceneAi(doc.id, record.sceneId, {
        scenePrompt: suggestions.length ? `重出修正：${suggestions.join('；')}` : undefined
      })
      const latest = await getLatestStorySceneReview(doc.id).catch(() => null)
      if (latest?.latest) setSrRound(latest.latest)
    } catch (e) {
      setSrError(e instanceof Error ? e.message : String(e))
    } finally {
      setSrReworkBusy('')
    }
  }

  async function confirmScenePass(record: SceneReviewRecord) {
    if (!doc.id || srReworkBusy) return
    setSrReworkBusy(record.sceneId)
    setSrError('')
    try {
      await submitSceneReviewFeedback(doc.id, { sceneId: record.sceneId, sceneName: record.sceneName, action: 'human_confirmed', note: '人工确认通过' })
      const latest = await getLatestStorySceneReview(doc.id).catch(() => null)
      if (latest?.latest) setSrRound(latest.latest)
    } catch (e) {
      setSrError(e instanceof Error ? e.message : String(e))
    } finally {
      setSrReworkBusy('')
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

  function addNode(kind: NodeV1['kind']) {
    if (!doc.story || doc.readonly) return
    void dlgAlert('合成层禁止新增节点；请返回蓝图层调整结构。')
  }

  function deleteNode(nodeId: string) {
    if (!doc.story || doc.readonly) return
    void dlgAlert('合成层禁止删除节点；请返回蓝图层调整结构。')
  }

  function addCharacter() {
    if (!doc.project || doc.readonly) return

    const id = uid('ch')
    const ch: CharacterV1 = { id, name: '新角色' }
    setDocProject((p) => ({ ...p, characters: [...p.characters, ch] }))
    setSelection({ type: 'character', id })
    setLeftTab('characters')
  }

  async function deleteCharacter(characterId: string) {
    if (!doc.project || !doc.story || doc.readonly) return
    if (!(await dlgConfirm('确定删除该角色？', { danger: true, okText: '删除' }))) return

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

  async function deleteAsset(assetId: string) {
    if (!doc.project || !doc.story || doc.readonly) return
    if (!(await dlgConfirm('确定删除该资源？（引用会被清空）', { danger: true, okText: '删除' }))) return

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

  function buildRoleDefinitionForNode(node: NodeV1 | null) {
    if (!node || !doc.project) return ''
    const placements = Array.isArray((node as any).visuals?.placements) ? ((node as any).visuals.placements as any[]) : []
    const ids = Array.from(new Set(placements.map((p) => String(p && p.characterId ? p.characterId : '')).filter(Boolean)))
    if (!ids.length) return ''
    const projectCharactersById = new Map((doc.project.characters || []).filter(Boolean).map((ch) => [String((ch as any).id || ''), ch as any]))
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
  }

  function buildNodeCharacterReferenceChoices(
    node: NodeV1 | null,
    prevRefs: NonNullable<AiBackgroundRequest['characterRefs']> = []
  ) {
    if (!node || !doc.project) return []
    const placements = Array.isArray((node as any).visuals?.placements) ? ((node as any).visuals.placements as any[]) : []
    const ids = Array.from(new Set(placements.map((p) => String(p && p.characterId ? p.characterId : '').trim()).filter(Boolean)))
    const assetsById = new Map((doc.project.assets || []).map((a) => [String(a.id || '').trim(), a]))
    const prevById = new Map((prevRefs || []).map((x) => [String(x.characterId || '').trim(), x]))
    return ids.map((characterId) => {
      const ch = (doc.project!.characters || []).find((x) => x.id === characterId) || null
      const refAssetId = String(ch?.ai?.referenceAssetId || ch?.imageAssetId || '').trim()
      const asset = refAssetId ? assetsById.get(refAssetId) || null : null
      const prev = prevById.get(characterId) || null
      return {
        characterId,
        characterName: String(ch?.name || characterId).trim() || characterId,
        fingerprintPrompt: String(ch?.ai?.fingerprintPrompt || '').trim(),
        assetId: refAssetId || undefined,
        assetUri: asset && String(asset.uri || '').trim() ? String(asset.uri || '').trim() : undefined,
        available: Boolean(asset && String(asset.uri || '').trim()),
        selected: prev ? Boolean(prev.assetUri || prev.assetPath || prev.assetId) : Boolean(asset && String(asset.uri || '').trim()),
        weight: Number.isFinite(Number(prev?.weight)) ? Number(prev?.weight) : 0.85
      }
    })
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

  function buildStoryboardPromptSeed(projectTitle: string) {
    const title = String(projectTitle || '').trim()
    if (/小猫钓鱼|kitten\s+goes\s+fishing|kitten.*fish/i.test(title)) {
      return {
        globalPromptZh:
          '儿童绘本连续分镜，统一为中国东方古风春日湖边清晨场景，柳树、浅草、竹林、石桥、平静水面与柔和金色晨光贯穿全片。主角始终是同一只橘白幼年小猫，圆脸、大琥珀眼、小粉鼻，戴绿色系小草帽，穿薄荷绿色短袖上衣和浅蓝短裤，背小鱼桶，使用细长竹鱼竿；所有场景保持同一毛色、体型、年龄感、服装、配色和道具，不变脸、不换装、不增减关键物件。整体采用温暖低饱和绘本插画，线条干净，笔触柔和，构图简洁，以中景、全景和轻微镜头变化呈现等待、观察、提竿、收获等可见动作，保证单主角、叙事连续、风格统一。',
        globalNegativePromptZh:
          '现代城市, 现代塑料渔具, 金属鱼竿, 渔轮, 现代帽子, 双肩包, 写实摄影, 成人比例, 多个主角, 多只猫, 多余人物, 换装, 换色, 变脸, 多余道具, 文字, 水印, logo, 对话框, 二维码, 模糊, 低质量, 畸形, 血腥, 过暗, 过曝',
        globalPrompt:
          'children picture-book storyboard, consistent ancient East Asian spring lakeside morning, willow trees, soft grass, bamboo grove, small stone bridge, calm water, gentle golden morning light across all scenes; the same young orange-and-cream kitten protagonist with round baby face, large amber eyes, pink nose, green small straw hat, mint short-sleeve top, light blue shorts, small wooden fish bucket, slender bamboo fishing rod; keep the same fur pattern, body size, age, outfit, palette, props and facial design in every scene, no face drift, no costume change, no prop substitution; warm low-saturation picture-book illustration, clean linework, soft brush texture, simple composition, medium shots and wide shots focused on visible actions such as waiting, watching the bobber, lifting the rod and catching fish, single protagonist, continuous narrative, unified style.',
        globalNegativePrompt:
          'modern city, modern plastic fishing gear, metal fishing rod, fishing reel, baseball cap, backpack, photorealistic, adult proportions, multiple protagonists, multiple cats, extra people, costume change, color drift, face drift, extra props, text, watermark, logo, speech bubble, qr code, blurry, low quality, deformed, gore, blood, underexposed, overexposed'
      }
    }
    return {
      globalPromptZh:
        '儿童绘本连续分镜，统一美术风格、时代、地点、环境元素、光线、色彩和镜头语言；所有角色的身份、外观、年龄感、服装和配色保持一致，关键道具的造型、材质与尺寸保持一致，不变脸、不换装、不替换核心物件；画面突出可见动作，构图干净，叙事连续。',
      globalNegativePromptZh:
        '多余人物，重复角色，多视图，换装，换色，变脸，道具替换，与故事时代或设定冲突的元素，文字，水印，logo，对话框，二维码，模糊，低质量，畸形，写实摄影，过暗，过曝',
      globalPrompt:
        'children picture-book storyboard, unified art style, consistent era, locations, environment elements, lighting, color palette and camera language; keep every character identity, appearance, age, outfit and colors consistent, and keep the shape, material and scale of key props consistent across all scenes, no face drift, no costume change, no prop substitution; clear visible actions, clean composition, continuous narrative',
      globalNegativePrompt:
        'extra people, duplicate characters, multiple views, costume change, color drift, face drift, prop substitution, anachronistic or story-inconsistent elements, text, watermark, logo, speech bubble, qr code, blurry, low quality, deformed, photorealistic, underexposed, overexposed'
    }
  }

  function isWeakStoryboardGlobalPrompt(value: string) {
    const s = String(value || '').trim()
    if (!s) return true
    if (/^story title\s*:/i.test(s)) return true
    return s.length < 80
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

  function readStoryboardEntitySpecFromProject(project: ProjectV1 | null) {
    if (!project) return ''
    const stateIn = project && (project as any).state && typeof (project as any).state === 'object' ? (project as any).state : {}
    const aiBgIn = stateIn && (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
    const storyBibleObj = aiBgIn.storyBible && typeof aiBgIn.storyBible === 'object'
      ? aiBgIn.storyBible
      : tryParseStoryBibleJson(aiBgIn.storyBibleJson)
    if (storyBibleObj) return buildEntitySpecFromStoryBible(storyBibleObj)
    return String(aiBgIn.storyboardEntitySpec || '').trim()
  }

  function buildStoryboardGlobalPromptForNode(node: NodeV1 | null, baseGlobalPrompt: string) {
    const entitySpec = readStoryboardEntitySpecFromProject(doc.project)
    const roleDef = buildRoleDefinitionForNode(node)
    const sceneLocks = node ? buildSceneCharacterLocks(node) : ''
    return [entitySpec, String(baseGlobalPrompt || '').trim(), roleDef, sceneLocks].filter(Boolean).join('，')
  }

  function buildStoryboardContinuitySummary(project: ProjectV1 | null) {
    const entitySpec = String(readStoryboardEntitySpecFromProject(project) || '').trim()
    if (!entitySpec) return ''
    const lines = entitySpec
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2)
      .map((line) => line.replace(/^([A-Z_]+):\s*/i, ''))
    return lines.join(' / ').slice(0, 220)
  }

  function collectNodeCharacterIds(node: NodeV1 | null) {
    if (!node) return [] as string[]
    const placements = Array.isArray((node as any).visuals?.placements) ? ((node as any).visuals.placements as any[]) : []
    return Array.from(new Set(placements.map((p) => String(p && p.characterId ? p.characterId : '').trim()).filter(Boolean)))
  }

  function isExternallyReachableReferenceUrl(input: string) {
    const raw = String(input || '').trim()
    if (!/^https?:\/\//i.test(raw)) return false
    try {
      const u = new URL(raw)
      const host = String(u.hostname || '').trim().toLowerCase()
      if (!host) return false
      if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local')) return false
      if (/^127\./.test(host)) return false
      if (/^10\./.test(host)) return false
      if (/^192\.168\./.test(host)) return false
      if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false
      return true
    } catch (_) {
      return false
    }
  }

  function buildReferenceSceneOptions(currentNodeId: string, selectedIds: string[] = []) {
    if (!doc.project || !doc.story) return [] as Array<{ nodeId: string; nodeName: string; summary: string; selected: boolean; hasImage: boolean; sharedCharacterNames: string[]; previewUrl?: string; usableUrl?: string }>
    const selectedSet = new Set((selectedIds || []).map((x) => String(x || '').trim()).filter(Boolean))
    const sceneMap = readStoryboardSceneMapFromProject(doc.project)
    const currentNode0 = (doc.story.nodes || []).find((n) => String((n as any).id || '') === String(currentNodeId || '')) || null
    const currentNode = currentNode0 ? ensureNode(currentNode0 as any) : null
    const currentCharacterIds = new Set(collectNodeCharacterIds(currentNode))
    const characterNameById = new Map((doc.project.characters || []).map((ch) => [String(ch.id || '').trim(), String(ch.name || ch.id || '').trim() || String(ch.id || '').trim()]))
    return (doc.story.nodes || [])
      .map((n) => ensureNode(n as any))
      .filter((n) => String(n.id || '') !== String(currentNodeId || ''))
      .map((n) => {
        const bgId = String((n as any).visuals?.backgroundAssetId || '').trim()
        const bgAsset = bgId ? (doc.project!.assets || []).find((a) => String(a.id || '').trim() === bgId) || null : null
        const previewUrl = bgAsset && String(bgAsset.uri || '').trim() ? resolveAsset(String(bgAsset.uri || '').trim(), doc.assetBase || '') : ''
        const remoteUrl = bgAsset && bgAsset.source && typeof bgAsset.source === 'object' && String((bgAsset.source as any).remoteUrl || '').trim()
          ? String((bgAsset.source as any).remoteUrl || '').trim()
          : ''
        const directUrl = bgAsset && /^https?:\/\//i.test(String(bgAsset.uri || '').trim()) ? String(bgAsset.uri || '').trim() : ''
        const usableUrl = isExternallyReachableReferenceUrl(remoteUrl)
          ? remoteUrl
          : (isExternallyReachableReferenceUrl(directUrl) ? directUrl : '')
        const stored = sceneMap[String(n.id || '').trim()] || null
        const summary = String((stored && (stored.prompt || stored.userInput)) || String(bgAsset && bgAsset.source && bgAsset.source.prompt ? bgAsset.source.prompt : '') || '').replace(/\s+/g, ' ').trim()
        const sharedCharacterNames = collectNodeCharacterIds(n)
          .filter((id) => currentCharacterIds.has(id))
          .map((id) => String(characterNameById.get(id) || id).trim())
          .filter(Boolean)
        return {
          nodeId: String(n.id || '').trim(),
          nodeName: String((n as any).body?.title || n.name || n.id).trim() || String(n.id || '').trim(),
          summary: summary.slice(0, 180),
          selected: selectedSet.has(String(n.id || '').trim()),
          hasImage: Boolean(bgAsset && String(bgAsset.uri || '').trim()),
          sharedCharacterNames,
          previewUrl: previewUrl || undefined,
          usableUrl: usableUrl || undefined
        }
      })
      .filter((item) => item.hasImage || item.summary)
      .sort((a, b) => {
        const scoreA = (a.sharedCharacterNames.length ? 100 : 0) + (a.hasImage ? 10 : 0)
        const scoreB = (b.sharedCharacterNames.length ? 100 : 0) + (b.hasImage ? 10 : 0)
        return scoreB - scoreA
      })
  }

  function buildReferenceScenePromptBlock(referenceSceneIds: string[]) {
    if (!doc.project || !doc.story) return ''
    const ids = Array.from(new Set((referenceSceneIds || []).map((x) => String(x || '').trim()).filter(Boolean))).slice(0, 4)
    if (!ids.length) return ''
    const sceneMap = readStoryboardSceneMapFromProject(doc.project)
    const assetsById = new Map((doc.project.assets || []).map((a) => [String(a.id || '').trim(), a]))
    const lines: string[] = []
    for (const id of ids) {
      const node0 = (doc.story.nodes || []).find((n) => String((n as any).id || '').trim() === id) || null
      const node = node0 ? ensureNode(node0 as any) : null
      if (!node) continue
      const nodeName = String((node as any).body?.title || node.name || node.id).trim() || id
      const stored = sceneMap[id] || null
      const bgId = String((node as any).visuals?.backgroundAssetId || '').trim()
      const bgAsset = bgId ? assetsById.get(bgId) || null : null
      const sourcePrompt = String(bgAsset && bgAsset.source && bgAsset.source.prompt ? bgAsset.source.prompt : '').replace(/\s+/g, ' ').trim()
      const scenePrompt = String(stored && stored.prompt ? stored.prompt : '').replace(/\s+/g, ' ').trim()
      const userInput = String(stored && stored.userInput ? stored.userInput : '').replace(/\s+/g, ' ').trim()
      const snapshot = sourcePrompt || scenePrompt || userInput
      if (!snapshot) continue
      lines.push(`${nodeName}: ${snapshot.slice(0, 260)}`)
      if (lines.length >= 4) break
    }
    if (!lines.length) return ''
    return `REFERENCE_SCENES: keep the same character appearance, costume silhouette, prop treatment and visual atmosphere as these approved scenes -> ${lines.join(' | ')}`
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

  async function runStoryboardOpenChecks() {
    if (doc.mode !== 'project' || !doc.project) return
    setSbOpenChecks((prev) => ({
      ...prev,
      checking: true,
      checkedAt: '',
      summary: '',
      issues: [],
      details: []
    }))
    appendSbLog('开始检查批量分镜能力：server / prompt / image / continuity bindings')

    const issues: string[] = []
    const details: string[] = []
    let serverOk = false
    let promptOk = false
    let imageOk = false
    let continuityBindingsOk = false
    let promptProvider = ''
    let promptModel = ''
    let imageProvider = ''
    let imageModel = ''
    let imageLoras: string[] = []

    try {
      try {
        const r = await fetch(resolveUrl('/api/health'), { method: 'GET' })
        serverOk = Boolean(r && r.ok)
        details.push(serverOk ? 'server: ok' : `server: HTTP ${r.status}`)
        if (!serverOk) issues.push(`server 不可用（HTTP ${r.status}）`)
      } catch (e) {
        serverOk = false
        issues.push(`server 不可用：${e instanceof Error ? e.message : String(e)}`)
      }

      let st: Awaited<ReturnType<typeof getStudioSettings>> | null = null
      try {
        st = await getStudioSettings()
        promptProvider = String(st.effective?.prompt?.provider || '').toLowerCase()
        promptModel = String(st.effective?.prompt?.model || '').trim()
        imageProvider = String(st.effective?.image?.provider || '').toLowerCase()
        imageModel = String(st.effective?.image?.model || '').trim()
        imageLoras = Array.isArray(st.effective?.image?.loras) ? st.effective.image.loras.map((x) => String(x || '').trim()).filter(Boolean) : []
        details.push(`prompt provider: ${promptProvider || 'none'}`)
        if (promptModel) details.push(`prompt model: ${promptModel}`)
        details.push(`image provider: ${imageProvider || 'none'}`)
        if (imageModel) details.push(`image model: ${imageModel}`)
      } catch (e) {
        issues.push(`读取 studio settings 失败：${e instanceof Error ? e.message : String(e)}`)
      }

      if (st) {
        try {
          const diag = await diagnoseStudio({ service: 'prompt', timeoutMs: 10_000 })
          const promptSvc = diag && diag.services ? diag.services.prompt : null
          promptOk = Boolean(promptSvc && promptSvc.ok !== false && st.effective.enabled.prompt && promptProvider && promptProvider !== 'none')
          details.push(`prompt diagnose: ${promptOk ? 'ok' : String(promptSvc?.note || 'failed')}`)
          if (!promptOk) issues.push(`提示词能力不可用：${String(promptSvc?.note || 'provider_not_configured')}`)
        } catch (e) {
          promptOk = false
          issues.push(`提示词检查失败：${e instanceof Error ? e.message : String(e)}`)
        }

        try {
          const diag = await diagnoseStudio({ service: 'image', timeoutMs: 10_000 })
          const imageSvc = diag && diag.services ? diag.services.image : null
          imageOk = Boolean(imageSvc && imageSvc.ok !== false && st.effective.enabled.image && imageProvider && imageProvider !== 'none')
          details.push(`image diagnose: ${imageOk ? 'ok' : String(imageSvc?.note || 'failed')}`)
          if (!imageOk) issues.push(`出图能力不可用：${String(imageSvc?.note || 'provider_not_configured')}`)
        } catch (e) {
          imageOk = false
          issues.push(`出图检查失败：${e instanceof Error ? e.message : String(e)}`)
        }

        if (imageProvider === 'comfyui') {
          try {
            const pf = await preflightStudioImage({ timeoutMs: 12_000, mode: 'storyboard' })
            const preflightOk = Boolean(pf.ok)
            details.push(`comfyui storyboard preflight: ${preflightOk ? 'ok' : String(pf.checks?.reason || pf.message || 'failed')}`)
            if (!preflightOk) {
              imageOk = false
              issues.push(`ComfyUI 连续分镜体检失败：${String(pf.checks?.reason || pf.message || 'preflight_failed')}`)
            }
          } catch (e) {
            imageOk = false
            issues.push(`ComfyUI preflight 异常：${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }

      const cfg = sbReq.continuity || { ipadapterEnabled: false, requireCharacterRefs: true, controlnetEnabled: false }
      const needsCharacterRefs = imageProvider === 'comfyui' && cfg.ipadapterEnabled && cfg.requireCharacterRefs
      if (needsCharacterRefs) {
        const usedChars = collectStoryboardUsedCharacters()
        const assetsById = new Map((doc.project.assets || []).map((a) => [String(a.id || ''), a]))
        const missingNames = usedChars
          .filter((ch) => {
            const refId = String(ch.ai?.referenceAssetId || '').trim()
            if (!refId) return true
            const asset = assetsById.get(refId) || null
            return !asset || !String(asset.uri || '').trim()
          })
          .map((ch) => String(ch.name || ch.id))
        continuityBindingsOk = missingNames.length === 0
        details.push(continuityBindingsOk ? 'character refs: ok' : `character refs: missing ${missingNames.slice(0, 6).join(', ')}`)
        if (!continuityBindingsOk) issues.push(`缺少角色参考图：${missingNames.slice(0, 6).join(', ')}`)
      } else {
        continuityBindingsOk = true
        details.push(imageProvider === 'doubao' ? 'character refs: optional for doubao' : 'character refs: skipped')
      }
    } finally {
      const ok = serverOk && promptOk && imageOk && continuityBindingsOk
      const summary = ok
        ? (imageProvider === 'doubao'
            ? '环境检查通过，可继续生成连续性 Bible / 多场景提示词 / Doubao 批量出图。'
            : '环境检查通过，可继续生成 Story Bible / 提示词 / 出图。')
        : '环境检查未通过，请先修复下列问题。'
      setSbOpenChecks({
        checking: false,
        checkedAt: new Date().toISOString(),
        ok,
        serverOk,
        promptOk,
        imageOk,
        continuityBindingsOk,
        promptProvider,
        promptModel,
        imageProvider,
        imageModel,
        imageLoras,
        summary,
        issues,
        details
      })
      appendSbLog(ok ? '批量分镜能力检查通过' : `批量分镜能力检查失败：${issues.join('；') || 'unknown_error'}`)
      if (!ok) setSbError(summary)
      else if (sbError === '环境检查未通过，请先修复下列问题。') setSbError('')
    }
  }

  async function runStoryboardContinuityTest() {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbContinuityBusy || sbBusyGenerate || sbBusyApply || sbBusyEntity) return
    setSbContinuityBusy(true)
    setSbContinuityReady(false)
    setSbContinuitySummary('')
    appendSbLog('开始运行场景测试...')
    try {
      const storyBibleObj = tryParseStoryBibleJson(sbReq.storyBibleJson)
      if (!storyBibleObj) throw new Error('Story Bible 为空或不是合法 JSON')
      if (!sbAssetConfirmReady) throw new Error('请先完成 Step 4：生成并确认必要事物资产')

      const st = await getStudioSettings()
      const promptProvider = String(st.effective?.prompt?.provider || '').toLowerCase()
      const imageProvider = String(st.effective?.image?.provider || '').toLowerCase()
      const isDoubaoStoryboard = promptProvider === 'doubao' && imageProvider === 'doubao'

      if (!promptProvider || promptProvider === 'none') throw new Error('文本模型未配置')
      if (!imageProvider || imageProvider === 'none') throw new Error('生图模型未配置')

      const promptDiag = await diagnoseStudio({ service: 'prompt', timeoutMs: 12_000 })
      const promptSvc = promptDiag && promptDiag.services ? promptDiag.services.prompt : null
      if (!promptSvc || promptSvc.ok === false) throw new Error(`文本能力不可用：${String(promptSvc?.note || 'diagnose_failed')}`)

      const cfg = sbReq.continuity || { ipadapterEnabled: false, requireCharacterRefs: true, controlnetEnabled: false }
      const needsCharacterRefs = imageProvider === 'comfyui' && cfg.ipadapterEnabled && cfg.requireCharacterRefs
      if (needsCharacterRefs) {
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

      const imageDiag = await diagnoseStudio({ service: 'image', timeoutMs: 20_000, deepImages: true })
      const imageSvc = imageDiag && imageDiag.services ? imageDiag.services.image : null
      if (!imageSvc || imageSvc.ok === false) throw new Error(`生图能力不可用：${String(imageSvc?.note || 'diagnose_failed')}`)

      const testSceneId = String(sbTestSceneId || '').trim()
      const testScene = sbItems.find((item) => item.nodeId === testSceneId) || null
      if (!testSceneId || !testScene) throw new Error('请先选择一个测试场景')
      if (!String(testScene.promptZh || '').trim() || !String(testScene.prompt || '').trim()) {
        throw new Error('请先为当前测试场景生成中英文提示词')
      }

      appendSbLog(
        `场景测试参数：scene=${String(testScene.nodeName || testScene.nodeId || '').trim()} / model=${String(sbReq.model || '(default)').trim() || '(default)'} / loras=${Array.isArray(sbReq.loras) && sbReq.loras.length ? sbReq.loras.join(' | ') : '(none)'}`
      )
      const test = await renderStorySceneAi(doc.id, testSceneId, {
        style: sbReq.style || 'picture_book',
        model: String(sbReq.model || '').trim() || undefined,
        loras: Array.isArray(sbReq.loras) && sbReq.loras.length ? sbReq.loras : undefined,
        width: Math.max(512, Math.min(1024, Number(sbReq.width || 768))),
        height: Math.max(512, Math.min(1536, Number(sbReq.height || 1024))),
        steps: Math.max(10, Math.min(40, Number(sbReq.steps || 20))),
        cfgScale: Number(sbReq.cfgScale || 6.5),
        sampler: String(sbReq.sampler || 'DPM++ 2M'),
        scheduler: String(sbReq.scheduler || 'Karras'),
        timeoutMs: imageProvider === 'doubao' ? 300_000 : 180_000
      })
      const renderSpec = test && typeof test.renderSpec === 'object' ? test.renderSpec as any : null
      const refCount = Array.isArray(renderSpec?.referenceAssets) ? renderSpec.referenceAssets.length : 0
      const lockCount = Array.isArray(renderSpec?.promptLocks) ? renderSpec.promptLocks.length : 0
      const sceneLabel = String(renderSpec?.sceneName || testScene.nodeName || testScene.nodeId || '').trim() || testSceneId
      appendSbLog(`场景测试完成：${sceneLabel}`)
      appendSbLog(`场景测试锁定输入：references=${refCount} / locks=${lockCount} / provider=${String(test.provider || imageProvider || 'unknown')}`)
      setSbContinuityReady(true)
      setSbContinuitySummary(
        isDoubaoStoryboard
          ? `通过（测试场景 ${sceneLabel} 渲染成功，已带入 ${refCount} 个锁定参考）`
          : `通过（测试场景 ${sceneLabel} 渲染成功，已带入 ${refCount} 个锁定参考）`
      )
      appendSbLog(`场景测试通过：${sceneLabel}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbContinuityReady(false)
      setSbContinuitySummary(msg)
      appendSbLog(`场景测试失败：${msg}`)
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
        promptZh: String((v as any).promptZh || '').trim(),
        prompt: String((v as any).prompt || '').trim(),
        negativePromptZh: String((v as any).negativePromptZh || '').trim(),
        negativePrompt: String((v as any).negativePrompt || '').trim(),
        promptReview: (v as any).promptReview && typeof (v as any).promptReview === 'object' ? ((v as any).promptReview as StoryboardPromptQualityReview) : null,
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
      updatedAt: String((meta as any).updatedAt || '').trim() || '',
      globalReview: (meta as any).globalReview && typeof (meta as any).globalReview === 'object' ? ((meta as any).globalReview as StoryboardPromptQualityReview) : null
    }
  }

  // 2026-08-30 修复：202 审核挂起响应没有 plan，绝不能用空计划覆盖现有计划（会把向导打回第 3 步）
  function applyStoryboardPlanResponse(res: any): boolean {
    const nextPlan = normalizeStoryboardAssetPlan(res?.plan)
    if (!nextPlan) return false
    setSbAssetPlan(nextPlan)
    persistStoryboardAssetPlan(nextPlan, '')
    return true
  }

  function persistStoryboardAssetPlan(plan: StoryAssetPlan | null, confirmedAt = '') {
    if (doc.mode !== 'project') return
    setDocProject((p) => {
      const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
      const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
      const nextAiBg: any = { ...aiBgIn }
      if (plan) nextAiBg.storyAssetPlan = plan
      // 2026-09-01 修复：plan 为空时不得删除已有 storyAssetPlan 副本（反复被清空导致角色指纹回退失败）
      else if (!nextAiBg.storyAssetPlan && aiBgIn.storyAssetPlan) nextAiBg.storyAssetPlan = aiBgIn.storyAssetPlan
      if (String(confirmedAt || '').trim()) nextAiBg.storyAssetPlanConfirmedAt = confirmedAt
      // 2026-09-01 修复：confirmedAt 为空时保留展开继承的旧值，不得 delete（曾把向导打回「待确认」）
      else if (!String(nextAiBg.storyAssetPlanConfirmedAt || '').trim()) delete nextAiBg.storyAssetPlanConfirmedAt
      const nextState = { ...stateIn, aiBackground: nextAiBg }
      return { ...p, state: nextState }
    })
  }

  function sleepMs(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function startStoryboardAssetBatchProgressPoll(assetId: string, label: string) {
    if (doc.mode !== 'project' || !doc.project) {
      return { stop() {}, task: Promise.resolve() }
    }
    let stopped = false
    let lastSeenBatchCount = -1
    const normalizedAssetId = String(assetId || '').trim()
    const task = (async () => {
      while (!stopped) {
        try {
          const res = await listStoryAssetGalleryAi(doc.id, normalizedAssetId)
          if (stopped) break
          const nextPlan = normalizeStoryboardAssetPlan(res.plan)
          if (nextPlan) {
            const liveAsset = (Array.isArray(nextPlan.assets) ? nextPlan.assets : []).find((item: any) => String(item?.id || '').trim() === normalizedAssetId) || null
            const batchCount = Array.isArray((liveAsset as any)?.latestReferenceBatch) ? (liveAsset as any).latestReferenceBatch.length : 0
            setSbAssetPlan(nextPlan)
            persistStoryboardAssetPlan(nextPlan, '')
            if (batchCount > 0 && batchCount !== lastSeenBatchCount) {
              appendSbLog(`候选图已回填：${label} / 已显示 ${batchCount} 张`)
            }
            lastSeenBatchCount = batchCount
          }
        } catch (_) {
        }
        if (stopped) break
        await sleepMs(1200)
      }
    })()
    return {
      stop() {
        stopped = true
      },
      task
    }
  }

  function buildStoryboardLockProjectSnapshot(
    project: ProjectV1,
    overrides?: {
      assetPlan?: StoryAssetPlan | null
      assetPlanConfirmedAt?: string
      assetPromptDrafts?: Record<string, any>
    }
  ): ProjectV1 {
    const stateIn = (project && (project as any).state && typeof (project as any).state === 'object') ? (project as any).state : {}
    const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
    const currentSbReq = sbReqRef.current
    const nextPromptDrafts = overrides && 'assetPromptDrafts' in overrides
      ? (overrides.assetPromptDrafts && typeof overrides.assetPromptDrafts === 'object' ? overrides.assetPromptDrafts : {})
      : (sbAssetPromptDrafts && typeof sbAssetPromptDrafts === 'object' ? sbAssetPromptDrafts : {})
    const nextAssetPlan = overrides && 'assetPlan' in overrides ? (overrides.assetPlan || null) : sbAssetPlan
    const nextConfirmedAt = overrides && 'assetPlanConfirmedAt' in overrides
      ? String(overrides.assetPlanConfirmedAt || '').trim()
      : String(sbAssetsConfirmedAt || '').trim()
    const nextAiBg: any = {
      ...aiBgIn,
      storyboardGlobalPromptStateReady: sbGlobalPromptStateReadyRef.current,
      global: {
        prompt: String(currentSbReq.globalPrompt || '').trim(),
        negativePrompt: String(currentSbReq.globalNegativePrompt || '').trim()
      },
      // 未初始化或弱占位不得覆盖文档里的好提示词；向导初始化后，用户明确清空允许落盘
      globalPrompt: (() => {
        const fromReq = String(currentSbReq.globalPrompt || '').trim()
        const fromDoc = String((aiBgIn as any).globalPrompt || '').trim()
        if (!fromReq && sbGlobalPromptStateReadyRef.current) return ''
        return isWeakStoryboardGlobalPrompt(fromReq) && fromDoc ? fromDoc : fromReq
      })(),
      globalNegativePrompt: (() => {
        const fromReq = String(currentSbReq.globalNegativePrompt || '').trim()
        const fromDoc = String((aiBgIn as any).globalNegativePrompt || '').trim()
        if (!fromReq && sbGlobalPromptStateReadyRef.current) return ''
        return isWeakStoryboardGlobalPrompt(fromReq) && fromDoc ? fromDoc : fromReq
      })(),
      storyboardGlobalPromptZh: String(currentSbReq.globalPromptZh || '').trim(),
      storyboardGlobalNegativePromptZh: String(currentSbReq.globalNegativePromptZh || '').trim(),
      storyboardLockAssetPrompts: nextPromptDrafts
    }
    if (nextAssetPlan) nextAiBg.storyAssetPlan = nextAssetPlan
    // 2026-09-01 修复：编辑器内存无计划时不得删除 project.json 里的 storyAssetPlan 副本（反复被清空导致角色指纹回退失败）
    else if (!nextAiBg.storyAssetPlan && aiBgIn.storyAssetPlan) nextAiBg.storyAssetPlan = aiBgIn.storyAssetPlan
    if (nextConfirmedAt) nextAiBg.storyAssetPlanConfirmedAt = nextConfirmedAt
    // 2026-09-01 修复：内存无确认时间戳时保留文档旧值，不得 delete（曾把向导打回「待确认」）
    else if (String((aiBgIn as any).storyAssetPlanConfirmedAt || '').trim()) nextAiBg.storyAssetPlanConfirmedAt = String((aiBgIn as any).storyAssetPlanConfirmedAt).trim()
    else delete nextAiBg.storyAssetPlanConfirmedAt
    return {
      ...project,
      state: {
        ...stateIn,
        aiBackground: nextAiBg
      }
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
    if (String((d as any).model || '').trim()) out.model = String((d as any).model || '').trim()
    if (Array.isArray((d as any).loras)) out.loras = (d as any).loras.map((x: any) => String(x || '').trim()).filter(Boolean)
    if (String((d as any).size || '').trim()) out.size = String((d as any).size || '').trim()
    if (String((d as any).responseFormat || '').trim() === 'b64_json') out.responseFormat = 'b64_json'
    else if (String((d as any).responseFormat || '').trim() === 'url') out.responseFormat = 'url'
    if (typeof (d as any).watermark === 'boolean') out.watermark = Boolean((d as any).watermark)
    if (String((d as any).sequentialImageGeneration || '').trim() === 'auto') out.sequentialImageGeneration = 'auto'
    else if (String((d as any).sequentialImageGeneration || '').trim() === 'disabled') out.sequentialImageGeneration = 'disabled'
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
        promptZh: patch.promptZh != null ? String(patch.promptZh || '').trim() : String(prev.promptZh || '').trim(),
        prompt: patch.prompt != null ? String(patch.prompt || '').trim() : String(prev.prompt || '').trim(),
        negativePromptZh: patch.negativePromptZh != null ? String(patch.negativePromptZh || '').trim() : String(prev.negativePromptZh || '').trim(),
        negativePrompt: patch.negativePrompt != null ? String(patch.negativePrompt || '').trim() : String(prev.negativePrompt || '').trim(),
        promptReview: patch.promptReview !== undefined ? ((patch.promptReview as StoryboardPromptQualityReview | null) || null) : (((prev as any).promptReview as StoryboardPromptQualityReview | null) || null),
        updatedAt: new Date().toISOString()
      }
      const nextScenes = { ...mapIn, [id]: nextEntry }
      const nextState = { ...stateIn, aiBackground: { ...aiBgIn, storyboardScenes: nextScenes } }
      return { ...p, state: nextState }
    })
  }

  function persistStoryboardGlobalPromptReview(review: StoryboardPromptQualityReview | null, extra?: Partial<StoryboardPromptMeta>) {
    if (doc.mode !== 'project') return
    setDocProject((p) => {
      const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
      const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
      const prevMeta = (aiBgIn as any).storyboardPromptMeta && typeof (aiBgIn as any).storyboardPromptMeta === 'object'
        ? (aiBgIn as any).storyboardPromptMeta
        : {}
      const nextMeta = {
        ...prevMeta,
        ...(extra || {}),
        globalReview: review,
        updatedAt: new Date().toISOString()
      }
      const nextState = { ...stateIn, aiBackground: { ...aiBgIn, storyboardPromptMeta: nextMeta } }
      return { ...p, state: nextState }
    })
  }

  async function openAiStoryboardForCurrentNode() {
    if (doc.mode !== 'project' || !doc.project) return
    const st = (doc.project as any).state && typeof (doc.project as any).state === 'object' ? (doc.project as any).state : {}
    const aiBg = st && (st as any).aiBackground && typeof (st as any).aiBackground === 'object' ? (st as any).aiBackground : {}
    const draft0 = readStoryboardBatchDraftFromProject(doc.project)
    const gpRaw = aiBg && typeof (aiBg as any).globalPrompt === 'string' ? String((aiBg as any).globalPrompt) : ''
    const gneg = aiBg && typeof (aiBg as any).globalNegativePrompt === 'string' ? String((aiBg as any).globalNegativePrompt) : ''
    const projectTitle = String((doc.project as any).title || '').trim()
    const templateGneg = buildGlobalNegativeFromTemplate(readHubTemplateFields())
    // 2026-09-10 断源：不再用"故事名：《…》"/脚本模板复述种子化英文全局栏——空是合法初始态，
    // 中文全局稿由 Story Bible 世界锚点译写产出（生成 Bible 后自动起草，或第 4 步手动起草）
    const gp = gpRaw.trim()
    let imageProvider = ''
    let imageModel = ''
    try {
      const studio = await getStudioSettings()
      imageProvider = String(studio?.effective?.image?.provider || '').trim().toLowerCase()
      imageModel = String(studio?.effective?.image?.model || '').trim()
    } catch (_) {}
    setAiImageProvider(imageProvider)
    setAiImageModel(imageModel)
    const effectiveAspectRatio = ((draft0 && draft0.aspectRatio) || sbReq.aspectRatio || aiReq.aspectRatio || '9:16') as any
    const doubaoSize = getDoubaoStoryboardDefaultSize(effectiveAspectRatio)

    let userInput = String(aiReq.userInput || '')
    let prompt = String(aiReq.prompt || '')
    let negativePrompt = String(aiReq.negativePrompt || '')
    let characterRefs = Array.isArray(aiReq.characterRefs) ? aiReq.characterRefs : []
    const continuitySeedMode: 'random' | 'fixed' = String((aiReq.continuity as any)?.seedMode || 'random').trim() === 'fixed' ? 'fixed' : 'random'
    const continuityCfg =
      aiBg && (aiBg as any).storyboardContinuity && typeof (aiBg as any).storyboardContinuity === 'object'
        ? {
            ipadapterEnabled: Boolean((aiBg as any).storyboardContinuity.ipadapterEnabled),
            requireCharacterRefs: (aiBg as any).storyboardContinuity.requireCharacterRefs !== false,
            controlnetEnabled: Boolean((aiBg as any).storyboardContinuity.controlnetEnabled),
            seedMode: continuitySeedMode
          }
        : (aiReq.continuity || { ipadapterEnabled: true, requireCharacterRefs: false, controlnetEnabled: false, seedMode: continuitySeedMode })

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
        characterRefs = buildSelectedCharacterRefsFromChoices(buildNodeCharacterReferenceChoices(node, characterRefs || []))
      }
    }

    setAiReq((v) => ({
      ...v,
      globalPrompt: gp,
      globalNegativePrompt: String(gneg || '').trim() || templateGneg,
      userInput,
      prompt,
      negativePrompt,
      referenceSceneIds: Array.isArray(v.referenceSceneIds) && v.referenceSceneIds.length
        ? v.referenceSceneIds
        : buildReferenceSceneOptions(String(selection.type === 'node' ? selection.id : ''), []).filter((item) => item.sharedCharacterNames.length > 0 && item.usableUrl).slice(0, 2).map((item) => item.nodeId),
      style: ((draft0 && draft0.style) || sbReq.style || v.style || 'picture_book') as any,
      aspectRatio: effectiveAspectRatio,
      width: Number((draft0 && draft0.width) || sbReq.width || v.width || 768),
      height: Number((draft0 && draft0.height) || sbReq.height || v.height || 1344),
      size: String((draft0 && draft0.size) || sbReq.size || v.size || '').trim() || (imageProvider === 'doubao' ? doubaoSize : String(v.size || '').trim()),
      responseFormat: ((((draft0 && draft0.responseFormat) || sbReq.responseFormat || v.responseFormat || 'url') === 'b64_json') ? 'b64_json' : 'url') as any,
      watermark: typeof ((draft0 && draft0.watermark) ?? sbReq.watermark ?? v.watermark) === 'boolean' ? Boolean((draft0 && draft0.watermark) ?? sbReq.watermark ?? v.watermark) : false,
      sequentialImageGeneration: ((((draft0 && draft0.sequentialImageGeneration) || sbReq.sequentialImageGeneration || v.sequentialImageGeneration || (imageProvider === 'doubao' ? 'auto' : 'disabled')) === 'auto') ? 'auto' : 'disabled') as any,
      steps: Number((draft0 && draft0.steps) || sbReq.steps || v.steps || 20),
      cfgScale: Number((draft0 && draft0.cfgScale) || sbReq.cfgScale || v.cfgScale || 7),
      continuity: continuityCfg,
      characterRefs
    }))
    setAiLast(null)
    setAiError('')
    setAiOpen(true)
  }

  async function initStoryboardBatchFromDoc() {
    if (!doc.project || !doc.story) return
    sbGlobalPromptStateReadyRef.current = false
    const aiBg0 = (doc.project as any).state && (doc.project as any).state.aiBackground && typeof (doc.project as any).state.aiBackground === 'object'
      ? (doc.project as any).state.aiBackground
      : {}
    const projectTitle = String((doc.project as any).title || '').trim()
    const tpl = readHubTemplateFields()
    // 2026-09-10 断源：英文全局栏不再回落到脚本模板复述（故事名/主题/寓意不是出图提示词）；空即是空
    const templateGneg = buildGlobalNegativeFromTemplate(tpl)
    const storyboardPromptSeed = buildStoryboardPromptSeed(projectTitle)
    const templateStyle = mapTemplateStyleToStoryboardStyle(String(tpl?.style || ''))
    const map = readStoryboardSceneMapFromProject(doc.project)
    const sceneNodes = (doc.story.nodes || []).map((n) => ensureNode(n as any)).filter((n) => n.kind === 'scene' || n.kind === 'ending')
    const projectAssetList = Array.isArray(doc.project.assets) ? doc.project.assets : []
    const projectAssetBase = doc.assetBase
    const items: StoryboardBatchItem[] = sceneNodes.map((n) => {
      const bgAssetId = String((n as any).visuals?.backgroundAssetId || '').trim()
      const bgAsset = bgAssetId ? projectAssetList.find((a) => String((a as any)?.id || '').trim() === bgAssetId) : null
      const bgUri = String((bgAsset as any)?.uri || '').trim()
      return {
        nodeId: n.id,
        nodeName: String((n as any).body?.title || n.name || n.id).trim(),
        userInput: (map[n.id] && map[n.id].userInput) ? map[n.id].userInput : buildSceneUserInputForBatch(n, projectTitle),
        promptZh: (map[n.id] && map[n.id].promptZh) ? map[n.id].promptZh : '',
        prompt: (map[n.id] && map[n.id].prompt) ? map[n.id].prompt : '',
        negativePromptZh: (map[n.id] && map[n.id].negativePromptZh) ? map[n.id].negativePromptZh : '',
        negativePrompt: (map[n.id] && map[n.id].negativePrompt) ? map[n.id].negativePrompt : '',
        promptReview: (map[n.id] && map[n.id].promptReview) ? map[n.id].promptReview : null,
        status: 'idle',
        note: '',
        backgroundAssetId: bgAssetId,
        backgroundUri: bgUri,
        backgroundUrl: bgUri ? resolveAsset(bgUri, projectAssetBase) : ''
      }
    })
    setSbItems(items)
    const meta = readStoryboardPromptMetaFromProject(doc.project)
    const draft0 = readStoryboardBatchDraftFromProject(doc.project)
    let savedAssetPlan = readStoryboardAssetPlanFromProject(doc.project)
    const savedAssetConfirmedAt = readStoryboardAssetConfirmedAtFromProject(doc.project)
    const storyBibleJsonFromState = aiBg0.storyBible && typeof aiBg0.storyBible === 'object'
      ? JSON.stringify(aiBg0.storyBible, null, 2)
      : String(aiBg0.storyBibleJson || '').trim()
    if (storyBibleJsonFromState) {
      try {
        const persistedPlan = normalizeStoryboardAssetPlan(await buildStoryAssetPlanAi(doc.project.id, { rebuild: false }))
        if (persistedPlan) {
          savedAssetPlan = persistedPlan
          persistStoryboardAssetPlan(persistedPlan, savedAssetConfirmedAt)
        }
      } catch (_) {}
    }
    setSbAssetPlan(savedAssetPlan)
    setSbAssetsConfirmedAt(savedAssetConfirmedAt)
    setSbGeneratingAssetId('')
    const continuityBackup = loadStoryboardContinuityBackup(AI_BG_CONTINUITY_KEY)
    const entitySpecFromState = String(aiBg0.storyboardEntitySpec || '').trim()
    const savedGlobalPromptZh = String((aiBg0 as any).storyboardGlobalPromptZh || '').trim()
    const savedGlobalNegativePromptZh = String((aiBg0 as any).storyboardGlobalNegativePromptZh || '').trim()
    const savedGlobalPrompt = isWeakStoryboardGlobalPrompt(String(aiBg0.globalPrompt || '').trim()) ? '' : String(aiBg0.globalPrompt || '').trim()
    const savedGlobalNegativePrompt = String(aiBg0.globalNegativePrompt || '').trim()
    const nextSbReq: StoryboardBatchState = {
      entitySpec: entitySpecFromState || String(continuityBackup?.entitySpec || '').trim(),
      storyBibleJson: storyBibleJsonFromState || String(continuityBackup?.storyBibleJson || '').trim(),
      continuity: aiBg0.storyboardContinuity && typeof aiBg0.storyboardContinuity === 'object'
        ? {
            ipadapterEnabled: Boolean((aiBg0.storyboardContinuity as any).ipadapterEnabled),
            requireCharacterRefs: (aiBg0.storyboardContinuity as any).requireCharacterRefs !== false,
            controlnetEnabled: Boolean((aiBg0.storyboardContinuity as any).controlnetEnabled)
          }
        : continuityBackup?.continuity && typeof continuityBackup.continuity === 'object'
        ? {
            ipadapterEnabled: Boolean((continuityBackup.continuity as any).ipadapterEnabled),
            requireCharacterRefs: (continuityBackup.continuity as any).requireCharacterRefs !== false,
            controlnetEnabled: Boolean((continuityBackup.continuity as any).controlnetEnabled)
          }
        : { ipadapterEnabled: true, requireCharacterRefs: true, controlnetEnabled: false },
      globalPromptZh: savedGlobalPromptZh || String(storyboardPromptSeed?.globalPromptZh || '').trim(),
      globalPrompt: savedGlobalPrompt || (savedGlobalPromptZh ? '' : String(storyboardPromptSeed?.globalPrompt || '').trim()),
      globalNegativePromptZh: savedGlobalNegativePromptZh || String(storyboardPromptSeed?.globalNegativePromptZh || '').trim(),
      globalNegativePrompt: savedGlobalNegativePrompt || (savedGlobalNegativePromptZh ? '' : String(storyboardPromptSeed?.globalNegativePrompt || '').trim() || templateGneg),
      style: ((draft0 && draft0.style) || templateStyle || aiReq.style || 'picture_book') as any,
      aspectRatio: ((draft0 && draft0.aspectRatio) || aiReq.aspectRatio || '9:16') as any,
      width: Number((draft0 && draft0.width) || aiReq.width || 768),
      height: Number((draft0 && draft0.height) || aiReq.height || 1344),
      model: String((draft0 && draft0.model) || aiReq.model || '').trim(),
      loras: Array.isArray((draft0 && draft0.loras) ? draft0.loras : aiReq.loras) ? (((draft0 && draft0.loras) ? draft0.loras : aiReq.loras) as string[]).map((x) => String(x || '').trim()).filter(Boolean) : [],
      size: String((draft0 && draft0.size) || aiReq.size || '').trim() || getDoubaoStoryboardDefaultSize(((draft0 && draft0.aspectRatio) || aiReq.aspectRatio || '9:16') as any),
      responseFormat: (((draft0 && draft0.responseFormat) || aiReq.responseFormat || 'url') === 'b64_json' ? 'b64_json' : 'url') as any,
      watermark: typeof ((draft0 && draft0.watermark) ?? aiReq.watermark) === 'boolean' ? Boolean((draft0 && draft0.watermark) ?? aiReq.watermark) : false,
      sequentialImageGeneration: (((draft0 && draft0.sequentialImageGeneration) || aiReq.sequentialImageGeneration || 'auto') === 'auto' ? 'auto' : 'disabled') as any,
      steps: Number((draft0 && draft0.steps) || aiReq.steps || 20),
      cfgScale: Number((draft0 && draft0.cfgScale) || aiReq.cfgScale || 7),
      sampler: String((draft0 && draft0.sampler) || 'DPM++ 2M'),
      scheduler: String((draft0 && draft0.scheduler) || 'Automatic')
    }
    sbReqRef.current = nextSbReq
    setSbReq(nextSbReq)
    sbGlobalPromptStateReadyRef.current = true
    setSbGlobalPromptReview(meta?.globalReview && typeof meta.globalReview === 'object' ? (meta.globalReview as StoryboardPromptQualityReview) : null)
    setSbPromptReviewingNodeId('')
    const savedPromptDrafts = (aiBg0 as any).storyboardLockAssetPrompts && typeof (aiBg0 as any).storyboardLockAssetPrompts === 'object' ? (aiBg0 as any).storyboardLockAssetPrompts : {}
    setSbAssetPromptDrafts(normalizeStoryboardLockAssetPromptDrafts(savedAssetPlan, savedPromptDrafts))
    setSbTranslatingScope('')
    if (!draft0) {
      try {
        const st = await getStudioSettings()
        const imageProvider = String(st?.effective?.image?.provider || '').toLowerCase()
        if (imageProvider === 'doubao') {
          setSbReq((prev) => ({
            ...prev,
            continuity: { ipadapterEnabled: false, requireCharacterRefs: false, controlnetEnabled: false },
            size: String(prev.size || '').trim() || getDoubaoStoryboardDefaultSize(prev.aspectRatio || '9:16'),
            responseFormat: prev.responseFormat || 'url',
            watermark: typeof prev.watermark === 'boolean' ? prev.watermark : false,
            sequentialImageGeneration: prev.sequentialImageGeneration || 'auto',
            steps: DOUBAO_STORYBOARD_DEFAULTS.steps,
            cfgScale: DOUBAO_STORYBOARD_DEFAULTS.cfgScale,
            sampler: DOUBAO_STORYBOARD_DEFAULTS.sampler,
            scheduler: DOUBAO_STORYBOARD_DEFAULTS.scheduler
          }))
          appendSbLog('检测到图像 Provider=doubao，已切换到 Doubao 多场景参数面板，并应用默认项（连续模式=auto）')
        } else if (imageProvider === 'comfyui') {
          setSbReq((prev) => ({
            ...prev,
            model: String(prev.model || st?.effective?.image?.model || '').trim(),
            loras: Array.isArray(prev.loras) && prev.loras.length
              ? prev.loras
              : Array.isArray(st?.effective?.image?.loras)
                ? st.effective.image.loras.map((x: any) => String(x || '').trim()).filter(Boolean)
                : []
          }))
          appendSbLog('检测到图像 Provider=comfyui，已读取当前生图 fallback；模型与 LoRA 请在当前分镜面板按工作流覆盖')
        }
      } catch (_) {}
    }
    setSbError('')
    setSbLogs([])
    if (!String(aiBg0.globalNegativePrompt || '').trim() && templateGneg) appendSbLog('已从“故事模板”注入全局负向提示词')
  }

  async function buildStoryboardAssetPlanFromStoryBible(storyBibleObj: any, rebuild = true) {
    if (doc.mode !== 'project' || !doc.project) throw new Error('project_not_open')
    if (!storyBibleObj || typeof storyBibleObj !== 'object') throw new Error('Story Bible 为空或不是合法 JSON')
    setSbAssetPlanBusy(true)
    setSbGeneratingAssetId('')
    setSbAssetsConfirmedAt('')
    setSbContinuityReady(false)
    // 2026-10-06 可观测：计时 + 执行逻辑明细日志，让用户明白资产如何被分配到场景
    const startedAt = Date.now()
    const bChars = Array.isArray(storyBibleObj.characters) ? storyBibleObj.characters.length : 0
    const bProps = Array.isArray(storyBibleObj.props) ? storyBibleObj.props.length : 0
    const bLocs = Array.isArray(storyBibleObj.locations) ? storyBibleObj.locations.length : 0
    const sceneTotal = (doc.story?.nodes || []).filter((n) => n.kind === 'scene' || n.kind === 'ending').length
    appendSbLog(`开始生成资产计划：圣经实体 ${bChars + bProps + bLocs} 个（角色 ${bChars} / 道具 ${bProps} / 地点 ${bLocs}）× 场景 ${sceneTotal} 个`)
    appendSbLog('执行逻辑：三路对账（① 圣经场景绑定 sceneRefs ② 画布摆位记录 ③ 正文文本匹配）→ 合并去重 → 推导锁定档案 → 落盘 plan.json')
    try {
      const plan = normalizeStoryboardAssetPlan(await buildStoryAssetPlanAi(doc.id, { storyBible: storyBibleObj, rebuild }))
      if (!plan) throw new Error('empty_story_asset_plan')
      setSbAssetPlan(plan)
      persistStoryboardAssetPlan(plan, '')
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
      appendSbLog(`必要事物资产计划已生成（耗时 ${elapsed}s）：共 ${plan.summary.assetCount} 项，必需参考 ${plan.summary.refRequiredCount} 项，已就绪 ${plan.summary.refReadyCount} 项`)
      const catLabel = (c: any) => (c === 'character' ? '角色' : c === 'prop' ? '道具' : '地点')
      for (const a of plan.assets as any[]) {
        const ev = a?.sceneEvidence && typeof a.sceneEvidence === 'object' ? a.sceneEvidence : {}
        const parts: string[] = []
        if (Array.isArray(ev.bibleRefs) && ev.bibleRefs.length) parts.push(`圣经绑定 ${ev.bibleRefs.length}`)
        if (Array.isArray(ev.placements) && ev.placements.length) parts.push(`摆位 ${ev.placements.length}`)
        if (Array.isArray(ev.text) && ev.text.length) parts.push(`文本匹配 ${ev.text.length}`)
        const name = String(a?.name || a?.id || '未命名')
        if (Number(a?.sceneCount || 0) > 0) {
          appendSbLog(`  分配：${name}（${catLabel(a?.category)}）→ ${Number(a.sceneCount)} 个场景${parts.length ? `（${parts.join(' · ')}）` : ''}`)
        } else {
          appendSbLog(`  未分配：${name}（${catLabel(a?.category)}）——三路证据均无命中，若剧情确实未用到可删除`)
        }
      }
      return plan
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`必要事物资产计划生成失败（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）：${msg}`)
      throw e
    } finally {
      setSbAssetPlanBusy(false)
      setSbGeneratingAssetId('')
    }
  }

  async function runStoryboardBuildAssetPlan() {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbAssetPlanBusy || sbBusyGenerate || sbBusyApply || sbBusyEntity) return
    const storyBibleObj = tryParseStoryBibleJson(sbReq.storyBibleJson)
    if (!storyBibleObj) {
      setSbError('请先生成或填写合法的 Story Bible，再生成必要事物资产计划')
      appendSbLog('阻止执行：Story Bible 为空或不是合法 JSON')
      return
    }
    try {
      await buildStoryboardAssetPlanFromStoryBible(storyBibleObj, true)
    } catch (_) {}
  }

  function getStoryboardAssetRenderSize(asset: any) {
    const category = String(asset?.category || '').trim()
    const lockProfile = String(asset?.lockProfile || '').trim()
    const lockWorkflow = String(asset?.lockWorkflow || '').trim()
    if (category === 'character') return { width: 768, height: 1152, label: '768x1152' }
    if (category === 'location') return { width: 960, height: 544, label: '960x544' }
    if (lockWorkflow === 'prop_hat') return { width: 1024, height: 768, label: '1024x768' }
    if (lockProfile === 'slender_prop') return { width: 640, height: 1024, label: '640x1024' }
    if (lockProfile === 'ambient_prop' || lockProfile === 'soft_prop') return { width: 896, height: 896, label: '896x896' }
    if (lockProfile === 'rigid_prop') return { width: 832, height: 832, label: '832x832' }
    return { width: 768, height: 768, label: '768x768' }
  }

  function updateStoryboardLockGlobalPrompts(patch: Partial<Pick<StoryboardBatchState, 'globalPromptZh' | 'globalPrompt' | 'globalNegativePromptZh' | 'globalNegativePrompt'>>) {
    setSbGlobalPromptReview(null)
    persistStoryboardGlobalPromptReview(null)
    const next = { ...sbReqRef.current, ...(patch || {}) }
    sbReqRef.current = next
    setSbReq(next)
    if (doc.mode === 'project') {
      setDocProject((p) => {
        const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
        const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
        return {
          ...p,
            state: {
              ...stateIn,
              aiBackground: {
                ...aiBgIn,
                global: {
                  prompt: String(next.globalPrompt || ''),
                  negativePrompt: String(next.globalNegativePrompt || '')
                },
                globalPrompt: String(next.globalPrompt || ''),
                globalNegativePrompt: String(next.globalNegativePrompt || ''),
                storyboardGlobalPromptZh: String(next.globalPromptZh || ''),
                storyboardGlobalNegativePromptZh: String(next.globalNegativePromptZh || '')
              }
          }
        }
      })
    }
  }

  function updateStoryboardLockAssetPrompt(
    assetId: string,
    patch: Partial<StoryboardLockAssetPromptDraft>,
    options?: { markEnhanced?: boolean; preserveEnhanced?: boolean; enhanceMode?: string }
  ) {
    const key = String(assetId || '').trim()
    if (!key) return
    const currentDrafts = sbAssetPromptDraftsRef.current
    const prevDraft = currentDrafts[key] && typeof currentDrafts[key] === 'object'
      ? currentDrafts[key]
      : { promptZh: '', promptEn: '', negativePromptZh: '', negativePrompt: '', enhancedAt: '', enhanceMode: '' }
    const enhancedAt = options?.markEnhanced
      ? new Date().toISOString()
      : options?.preserveEnhanced
        ? String(prevDraft.enhancedAt || '').trim()
        : String(patch.enhancedAt || '').trim()
    const enhanceMode = options?.markEnhanced
      ? String(options.enhanceMode || 'ai').trim()
      : options?.preserveEnhanced
        ? String(prevDraft.enhanceMode || '').trim()
        : String(patch.enhanceMode || '').trim()
    const nextDrafts = normalizeStoryboardLockAssetPromptDrafts(sbAssetPlan, {
      ...currentDrafts,
      [key]: {
        promptZh: String(patch.promptZh ?? prevDraft.promptZh ?? ''),
        promptEn: String(patch.promptEn ?? prevDraft.promptEn ?? ''),
        negativePromptZh: String(patch.negativePromptZh ?? prevDraft.negativePromptZh ?? ''),
        negativePrompt: String(patch.negativePrompt ?? prevDraft.negativePrompt ?? ''),
        promptReview: patch.promptReview !== undefined ? (patch.promptReview || null) : (prevDraft.promptReview || null),
        enhancedAt,
        enhanceMode
      }
    })
    sbAssetPromptDraftsRef.current = nextDrafts // 立即同步 ref，保证批量串行的下一次迭代读到最新值
    setSbAssetPromptDrafts(nextDrafts)
    const nextPlan = normalizeStoryboardAssetPlan(sbAssetPlan ? {
      ...sbAssetPlan,
      assets: (Array.isArray(sbAssetPlan.assets) ? sbAssetPlan.assets : []).map((asset: any) => {
        if (String(asset?.id || '').trim() !== key) return asset
        const nextAsset = {
          ...asset,
          referencePromptZh: String(nextDrafts[key]?.promptZh ?? ''),
          referencePromptEn: String(nextDrafts[key]?.promptEn ?? ''),
          referenceNegativePromptZh: String(nextDrafts[key]?.negativePromptZh ?? ''),
          referenceNegativePrompt: String(nextDrafts[key]?.negativePrompt ?? ''),
          negativePrompt: String(nextDrafts[key]?.negativePrompt ?? '')
        }
        if (!String(nextAsset.referencePromptEn || '') && String(nextAsset.referencePromptHint || '').trim()) {
          nextAsset.referencePromptEn = String(nextAsset.referencePromptHint || '')
        }
        return nextAsset
      })
    } : null)
    if (nextPlan) setSbAssetPlan(nextPlan)
    if (doc.mode === 'project') {
      setDocProject((p) => {
        const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
        const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
        const nextAiBg: any = { ...aiBgIn, storyboardLockAssetPrompts: nextDrafts }
        if (nextPlan) nextAiBg.storyAssetPlan = nextPlan
        return { ...p, state: { ...stateIn, aiBackground: nextAiBg } }
      })
    }
  }

  function storyboardPromptOpsBusy() {
    return Boolean(sbOptimizingAssetId || sbTranslatingScope)
  }

  // ============ 2026-08-29 提示词审核闸状态：服务端项目数据持久化 ============
  // 背景：原先闸状态只存浏览器 localStorage，刷新/重启/换浏览器即丢失，用户被门拦回第 4 步（"根本没有同步进度"）。
  // 现在确认/批准写入 project.state.aiBackground.storyboardLockPromptGate，经既有自动保存链路落盘。
  const sbPromptGate = useMemo(() => {
    const g = doc.mode === 'project' ? (doc.project as any)?.state?.aiBackground?.storyboardLockPromptGate : null
    return { zhConfirmed: Boolean(g?.zhConfirmed), enApproved: Boolean(g?.enApproved) }
  }, [doc.mode, doc.project])
  function updateStoryboardLockPromptGate(patch: { zhConfirmed?: boolean; enApproved?: boolean }) {
    setDocProject((p) => {
      const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
      const aiBgIn = stateIn.aiBackground && typeof stateIn.aiBackground === 'object' ? stateIn.aiBackground : {}
      const cur = aiBgIn.storyboardLockPromptGate && typeof aiBgIn.storyboardLockPromptGate === 'object' ? aiBgIn.storyboardLockPromptGate : {}
      return {
        ...p,
        state: {
          ...stateIn,
          aiBackground: {
            ...aiBgIn,
            storyboardLockPromptGate: { ...cur, ...patch, updatedAt: new Date().toISOString() }
          }
        }
      }
    })
  }

  async function removeStoryboardAssetFromPlan(assetId: string) {
    const key = String(assetId || '').trim()
    if (!key) return
    if (sbAssetPlanBusy || sbBusyGenerate || sbBusyApply || sbBusyEntity || Boolean(sbSelectingAssetId) || storyboardPromptOpsBusy()) return
    const plan = normalizeStoryboardAssetPlan(sbAssetPlan)
    if (!plan) {
      setSbError('请先生成必要事物资产计划')
      return
    }
    const asset = (Array.isArray(plan.assets) ? plan.assets : []).find((item: any) => String(item?.id || '').trim() === key) || null
    if (!asset) {
      setSbError('未找到对应的必要事物资产')
      return
    }
    const label = String(asset?.name || key).trim() || key
    const ok = await dlgConfirm(`确认从当前锁定事物计划中删除“${label}”？\n\n这只会从当前锁定计划里移除；如果之后重新从 Story Bible 全量生成资产计划，它仍可能再次出现。`, { danger: true, okText: '删除' })
    if (!ok) return

    const nextDrafts = { ...(sbAssetPromptDraftsRef.current || {}) }
    delete nextDrafts[key]
    sbAssetPromptDraftsRef.current = nextDrafts
    if (doc.mode === 'project' && doc.project) {
      try {
        // 2026-09-16 真删除：persist 合并链按 id 合并会保留磁盘独有条目（删除静默无效），
        // 改走 remove-asset 专用端点（服务端读磁盘真相全量覆盖写），编辑器采信返回的真相计划。
        const res = await removeStoryboardAssetFromPlanAi(doc.id, key)
        const truthPlan = res.plan as any
        setSbAssetPlan(truthPlan)
        setSbAssetsConfirmedAt('')
        setSbContinuityReady(false)
        setSbContinuitySummary('')
        persistStoryboardAssetPlan(truthPlan, '')
        setSbAssetPromptDrafts(nextDrafts)
        const nextProjectSnapshot = buildStoryboardLockProjectSnapshot(doc.project, {
          assetPlan: truthPlan,
          assetPlanConfirmedAt: '',
          assetPromptDrafts: nextDrafts
        })
        setDocProject(() => nextProjectSnapshot)
        if (doc.story) {
          const saved = await saveProject(doc.id, { project: nextProjectSnapshot, story: doc.story, _rev: Number(res._rev || 0) })
          setDoc((prev) => ({ ...prev, project: saved, title: saved.title }))
          setDirty(false)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setSbError(`删除事物失败：${msg}`)
        appendSbLog(`删除事物失败：${msg}`)
        return
      }
    } else {
      // 非项目模式（演示文档）：仅本地移除
      const nextPlan = recomputeStoryboardAssetPlanSummary({
        ...plan,
        excludedAssetIds: Array.from(new Set([...(Array.isArray((plan as any)?.excludedAssetIds) ? (plan as any).excludedAssetIds : []), key])),
        assets: (Array.isArray(plan.assets) ? plan.assets : []).filter((item: any) => String(item?.id || '').trim() !== key)
      })
      setSbAssetPlan(nextPlan)
      setSbAssetsConfirmedAt('')
      setSbContinuityReady(false)
      setSbContinuitySummary('')
      setSbAssetPromptDrafts(nextDrafts)
    }
    if (sbGallery?.assetId === key) closeStoryboardAssetGallery()
    appendSbLog(`已从当前锁定计划移除事物：${label}`)
    setToast(`已移除：${label}`)
  }

  async function translateStoryboardLockGlobalPrompt(kind: 'globalPrompt' | 'globalNegativePrompt') {
    if (doc.mode !== 'project' || !doc.project) return
    if (storyboardPromptOpsBusy()) {
      setSbError('当前已有提示词增强或翻译任务在执行，请等待完成后再操作')
      return
    }
    const zhText = kind === 'globalPrompt' ? String(sbReq.globalPromptZh || '').trim() : String(sbReq.globalNegativePromptZh || '').trim()
    if (!zhText) {
      setSbError('请先填写中文提示词，再执行翻译')
      return
    }
    setSbTranslatingScope(kind)
    setSbTranslateDeadlineAt(Date.now() + 60_000)
    appendSbLog(`开始翻译${kind === 'globalPrompt' ? '全局正向' : '全局负向'}提示词`)
    try {
      const res = await translateStoryboardPromptText(doc.id, { text: zhText, sourceLang: 'zh', targetLang: 'en', mode: 'prompt', timeoutMs: 60_000 })
      const enOut = String(res.result?.translatedText || '').trim()
      if (kind === 'globalPrompt') updateStoryboardLockGlobalPrompts({ globalPrompt: enOut })
      else updateStoryboardLockGlobalPrompts({ globalNegativePrompt: enOut })
      appendSbLog(`${kind === 'globalPrompt' ? '全局正向' : '全局负向'}提示词翻译完成：${enOut.slice(0, 160)}${enOut.length > 160 ? '…' : ''}`)
      setToast('提示词翻译完成')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`提示词翻译失败：${msg}`)
    } finally {
      setSbTranslatingScope('')
      setSbTranslateDeadlineAt(0)
    }
  }

  async function translateStoryboardLockAssetPrompt(assetId: string, kind: 'positive' | 'negative') {
    if (doc.mode !== 'project' || !doc.project) return
    if (storyboardPromptOpsBusy()) {
      setSbError('当前已有提示词增强或翻译任务在执行，请等待完成后再操作')
      return
    }
    const key = String(assetId || '').trim()
    const zhText = kind === 'positive'
      ? String(sbAssetPromptDrafts[key]?.promptZh || '').trim()
      : String(sbAssetPromptDrafts[key]?.negativePromptZh || '').trim()
    if (!zhText) {
      setSbError(`请先填写中文${kind === 'positive' ? '正向' : '反向'}提示词，再执行翻译`)
      return
    }
    setSbTranslatingScope(`asset:${kind}:${key}`)
    setSbTranslateDeadlineAt(Date.now() + 60_000)
    appendSbLog(`开始翻译资产${kind === 'positive' ? '正向' : '反向'}提示词：${key}`)
    try {
      const res = await translateStoryboardPromptText(doc.id, { text: zhText, sourceLang: 'zh', targetLang: 'en', mode: 'prompt', timeoutMs: 60_000 })
      const patch = kind === 'positive'
        ? { promptEn: String(res?.result?.translatedText || sbAssetPromptDrafts[key]?.promptEn || '').trim() }
        : { negativePrompt: String(res?.result?.translatedText || sbAssetPromptDrafts[key]?.negativePrompt || '').trim() }
      updateStoryboardLockAssetPrompt(key, patch, { preserveEnhanced: true })
      const enAssetOut = String((patch as any).promptEn || (patch as any).negativePrompt || '').trim()
      appendSbLog(`资产${kind === 'positive' ? '正向' : '反向'}提示词翻译完成：${key} → ${enAssetOut.slice(0, 120)}${enAssetOut.length > 120 ? '…' : ''}`)
      setToast(`资产${kind === 'positive' ? '正向' : '反向'}提示词翻译完成`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`资产${kind === 'positive' ? '正向' : '反向'}提示词翻译失败：${key} - ${msg}`)
    } finally {
      setSbTranslatingScope('')
      setSbTranslateDeadlineAt(0)
    }
  }

  async function runStoryboardReviewGlobalPrompt() {
    if (doc.mode !== 'project' || !doc.project) return
    setSbGlobalPromptReviewBusy(true)
    appendSbLog('开始评分全局提示词')
    try {
      const review = await reviewStoryboardPromptAi(doc.id, {
        scope: 'global',
        projectTitle: String(doc.project.title || '').trim(),
        storyBibleJson: String(sbReq.storyBibleJson || '').trim(),
        globalPromptZh: String(sbReq.globalPromptZh || '').trim(),
        globalPrompt: String(sbReq.globalPrompt || '').trim(),
        globalNegativePromptZh: String(sbReq.globalNegativePromptZh || '').trim(),
        globalNegativePrompt: String(sbReq.globalNegativePrompt || '').trim(),
        style: String(sbReq.style || '').trim(),
        aspectRatio: String(sbReq.aspectRatio || '').trim()
      })
      setSbGlobalPromptReview(review)
      persistStoryboardGlobalPromptReview(review, {
        style: String(sbReq.style || ''),
        aspectRatio: String(sbReq.aspectRatio || '')
      })
      appendSbLog(`全局提示词评分完成：${Math.round(Number(review.ai.score || 0))}/100`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`全局提示词评分失败：${msg}`)
    } finally {
      setSbGlobalPromptReviewBusy(false)
    }
  }

  function applyStoryboardGlobalPromptReview() {
    const review = sbGlobalPromptReview
    if (!review) return
    const ai = review.ai
    updateStoryboardLockGlobalPrompts({
      globalPromptZh: String(ai.optimizedGlobalPromptZh || sbReq.globalPromptZh || '').trim(),
      globalPrompt: String(ai.optimizedPrompt || sbReq.globalPrompt || '').trim(),
      globalNegativePromptZh: String(ai.optimizedGlobalNegativePromptZh || sbReq.globalNegativePromptZh || '').trim(),
      globalNegativePrompt: String(ai.optimizedNegativePrompt || sbReq.globalNegativePrompt || '').trim()
    })
    setSbGlobalPromptReview(review)
    persistStoryboardGlobalPromptReview(review, {
      style: String(sbReq.style || ''),
      aspectRatio: String(sbReq.aspectRatio || '')
    })
    appendSbLog(`已应用全局强化提示词：${Math.round(Number(ai.score || 0))}/100`)
    setToast('已应用全局强化提示词')
  }

  async function runStoryboardReviewScenePrompt(nodeId: string, opts?: { silent?: boolean }) {
    if (doc.mode !== 'project' || !doc.project) return null
    const item = sbItems.find((x) => x.nodeId === nodeId) || null
    if (!item) return null
    const silent = Boolean(opts && opts.silent)
    setSbPromptReviewingNodeId(nodeId)
    if (!silent) appendSbLog(`开始评分场景提示词：${item.nodeName}`)
    try {
      const review = await reviewStoryboardPromptAi(doc.id, {
        scope: 'scene',
        projectTitle: String(doc.project.title || '').trim(),
        storyBibleJson: String(sbReq.storyBibleJson || '').trim(),
        globalPromptZh: String(sbReq.globalPromptZh || '').trim(),
        globalPrompt: String(sbReq.globalPrompt || '').trim(),
        globalNegativePromptZh: String(sbReq.globalNegativePromptZh || '').trim(),
        globalNegativePrompt: String(sbReq.globalNegativePrompt || '').trim(),
        sceneUserInput: String(item.userInput || '').trim(),
        scenePromptZh: String(item.promptZh || '').trim(),
        scenePrompt: String(item.prompt || '').trim(),
        sceneNegativePromptZh: String(item.negativePromptZh || '').trim(),
        sceneNegativePrompt: String(item.negativePrompt || '').trim(),
        style: String(sbReq.style || '').trim(),
        aspectRatio: String(sbReq.aspectRatio || '').trim()
      })
      const promptZh = String(review.ai.optimizedScenePromptZh || item.promptZh || '').trim()
      const negativePromptZh = String(review.ai.optimizedSceneNegativePromptZh || item.negativePromptZh || '').trim()
      setSbItems((prev) => prev.map((x) => (x.nodeId === nodeId ? { ...x, promptZh, negativePromptZh, promptReview: review } : x)))
      upsertStoryboardScenePrompt(nodeId, item.nodeName, { promptZh, negativePromptZh, promptReview: review })
      if (!silent) appendSbLog(`场景提示词评分完成：${item.nodeName} / ${Math.round(Number(review.ai.score || 0))}/100`)
      return review
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!silent) {
        setSbError(msg)
        appendSbLog(`场景提示词评分失败：${item.nodeName} - ${msg}`)
      }
      return null
    } finally {
      setSbPromptReviewingNodeId('')
    }
  }

  function applyStoryboardScenePromptReview(nodeId: string) {
    const item = sbItems.find((x) => x.nodeId === nodeId) || null
    const review = item && item.promptReview ? item.promptReview : null
    if (!item || !review) return
    const ai = review.ai
    const patch = {
      promptZh: String(ai.optimizedScenePromptZh || item.promptZh || '').trim(),
      prompt: String(ai.optimizedPrompt || item.prompt || '').trim(),
      negativePromptZh: String(ai.optimizedSceneNegativePromptZh || item.negativePromptZh || '').trim(),
      negativePrompt: String(ai.optimizedNegativePrompt || item.negativePrompt || '').trim(),
      promptReview: review
    }
    setSbItems((prev) => prev.map((x) => (x.nodeId === nodeId ? { ...x, ...patch } : x)))
    upsertStoryboardScenePrompt(nodeId, item.nodeName, patch)
    appendSbLog(`已应用场景强化提示词：${item.nodeName}`)
    setToast(`已强化：${item.nodeName}`)
  }

  async function runStoryboardGenerateAssetReference(assetId: string, batchSizeIn?: number) {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbAssetPlanBusy || sbBusyGenerate || sbBusyApply || sbBusyEntity) return
    const plan = normalizeStoryboardAssetPlan(sbAssetPlan)
    if (!plan) {
      setSbError('请先生成必要事物资产计划')
      return
    }
    const asset = (Array.isArray(plan.assets) ? plan.assets : []).find((x: any) => String(x && x.id ? x.id : '').trim() === String(assetId || '').trim()) || null
    if (!asset) {
      setSbError('未找到对应的必要事物资产')
      return
    }
    const label = String(asset && asset.name ? asset.name : assetId).trim() || assetId
    setSbAssetPlanBusy(true)
    setSbGeneratingAssetId(String(assetId || '').trim())
    setSbAnalyzingAssetId('')
    setSbOptimizingAssetId('')
    setSbAssetsConfirmedAt('')
    setSbContinuityReady(false)
    const batchSize = Math.max(1, Math.min(6, Number(batchSizeIn || 4) || 4))
    appendSbLog(`开始生成必要事物参考图：${label}（先出 ${batchSize} 张，仅抽卡，不做白底/线稿；若模型未驻留，ComfyUI 会先预热 SDXL）`)
    const progressPoll = startStoryboardAssetBatchProgressPoll(String(assetId || '').trim(), label)
    try {
      const refSize = getStoryboardAssetRenderSize(asset)
      const res = await generateStoryAssetReferenceAi(doc.id, {
        assetId: String(assetId || '').trim(),
        style: sbReq.style,
        width: refSize.width,
        height: refSize.height,
        batchSize,
        steps: Math.max(12, Math.min(32, Number(sbReq.steps || 24))),
        cfgScale: Number(sbReq.cfgScale || 6.5),
        sampler: String(sbReq.sampler || 'DPM++ 2M'),
        scheduler: String(sbReq.scheduler || 'Automatic'),
        globalPrompt: String(sbReq.globalPrompt || '').trim() || undefined,
        globalNegativePrompt: String(sbReq.globalNegativePrompt || '').trim() || undefined,
        assetPrompt: String(sbAssetPromptDrafts[String(assetId || '').trim()]?.promptEn || '').trim() || undefined,
        assetNegativePrompt: String(sbAssetPromptDrafts[String(assetId || '').trim()]?.negativePrompt || '').trim() || undefined
      })
      // manual 模式：出图前审核挂起（202 无 plan），保留现有计划并提示去待审核列表批准
      if ((res as any)?.pendingReview) {
        appendSbLog(`抽卡出图前审核待批准：${label}（在下方待审核列表批准后自动执行）`)
        setToast(`抽卡待出图前审核批准：${label}`)
        return
      }
      applyStoryboardPlanResponse(res)
      const score = Number(res.analysis?.score)
      const scoreText = Number.isFinite(score) ? `${Math.round(score)} / 100` : 'n/a'
      appendSbLog(`${batchSize} 张候选参考图已生成：${label}（${refSize.label}，AI 推荐=${scoreText}，请手动选择主参考）`)
      setToast(`已生成参考图：${label}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`必要事物参考图生成失败：${label} - ${msg}`)
    } finally {
      progressPoll.stop()
      await progressPoll.task.catch(() => {})
      setSbAssetPlanBusy(false)
      setSbGeneratingAssetId('')
    }
  }

  async function runStoryboardAnalyzeAssetReference(assetId: string) {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbAssetPlanBusy || sbBusyGenerate || sbBusyApply || sbBusyEntity) return
    const plan = normalizeStoryboardAssetPlan(sbAssetPlan)
    if (!plan) {
      setSbError('请先生成必要事物资产计划')
      return
    }
    const asset = (Array.isArray(plan.assets) ? plan.assets : []).find((x: any) => String(x && x.id ? x.id : '').trim() === String(assetId || '').trim()) || null
    if (!asset) {
      setSbError('未找到对应的必要事物资产')
      return
    }
    const label = String(asset && asset.name ? asset.name : assetId).trim() || assetId
    setSbAssetPlanBusy(true)
    setSbGeneratingAssetId('')
    setSbAnalyzingAssetId(String(assetId || '').trim())
    setSbOptimizingAssetId('')
    appendSbLog(`开始分析必要事物参考图：${label}`)
    try {
      const res = await analyzeStoryAssetReferenceAi(doc.id, { assetId: String(assetId || '').trim() })
      const nextPlan = normalizeStoryboardAssetPlan(res.plan)
      setSbAssetPlan(nextPlan)
      persistStoryboardAssetPlan(nextPlan, '')
      const score = Number(res.analysis?.score)
      const scoreText = Number.isFinite(score) ? `${Math.round(score)} / 100` : 'n/a'
      appendSbLog(`参考图分析完成：${label} / score=${scoreText} / ${String(res.analysis?.summary || 'no_summary')}`)
      setToast(`分析完成：${label}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`参考图分析失败：${label} - ${msg}`)
    } finally {
      setSbAssetPlanBusy(false)
      setSbAnalyzingAssetId('')
    }
  }

  async function runStoryboardOptimizeAssetReference(assetId: string) {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbAssetPlanBusy || sbBusyGenerate || sbBusyApply || sbBusyEntity) return
    const plan = normalizeStoryboardAssetPlan(sbAssetPlan)
    if (!plan) {
      setSbError('请先生成必要事物资产计划')
      return
    }
    const asset = (Array.isArray(plan.assets) ? plan.assets : []).find((x: any) => String(x && x.id ? x.id : '').trim() === String(assetId || '').trim()) || null
    if (!asset) {
      setSbError('未找到对应的必要事物资产')
      return
    }
    const label = String(asset && asset.name ? asset.name : assetId).trim() || assetId
    setSbAssetPlanBusy(true)
    setSbGeneratingAssetId('')
    setSbAnalyzingAssetId('')
    setSbOptimizingAssetId(String(assetId || '').trim())
    setSbAssetsConfirmedAt('')
    setSbContinuityReady(false)
    appendSbLog(`开始增强提示并重生参考图：${label}`)
    const progressPoll = startStoryboardAssetBatchProgressPoll(String(assetId || '').trim(), label)
    try {
      const refSize = getStoryboardAssetRenderSize(asset)
      const res = await optimizeStoryAssetReferenceAi(doc.id, {
        assetId: String(assetId || '').trim(),
        style: sbReq.style,
        width: refSize.width,
        height: refSize.height,
        batchSize: 4,
        steps: Math.max(12, Math.min(32, Number(sbReq.steps || 24))),
        cfgScale: Number(sbReq.cfgScale || 6.5),
        sampler: String(sbReq.sampler || 'DPM++ 2M'),
        scheduler: String(sbReq.scheduler || 'Automatic'),
        globalPrompt: String(sbReq.globalPrompt || '').trim() || undefined,
        globalNegativePrompt: String(sbReq.globalNegativePrompt || '').trim() || undefined,
        assetPrompt: String(sbAssetPromptDrafts[String(assetId || '').trim()]?.promptEn || '').trim() || undefined,
        assetNegativePrompt: String(sbAssetPromptDrafts[String(assetId || '').trim()]?.negativePrompt || '').trim() || undefined
      })
      const nextPlan = normalizeStoryboardAssetPlan(res.plan)
      setSbAssetPlan(nextPlan)
      persistStoryboardAssetPlan(nextPlan, '')
      const score = Number(res.analysis?.score)
      const scoreText = Number.isFinite(score) ? `${Math.round(score)} / 100` : 'n/a'
      appendSbLog(`增强重生完成：${label} / ${refSize.label} / 4 张候选 / AI 推荐=${scoreText} / ${String(res.analysis?.summary || 'no_summary')}`)
      setToast(`已增强并重生：${label}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`增强重生失败：${label} - ${msg}`)
    } finally {
      progressPoll.stop()
      await progressPoll.task.catch(() => {})
      setSbAssetPlanBusy(false)
      setSbOptimizingAssetId('')
    }
  }

  async function runStoryboardEnhanceAssetPrompt(assetId: string) {
    if (doc.mode !== 'project' || !doc.project) return
    if (storyboardPromptOpsBusy()) {
      setSbError('当前已有提示词增强或翻译任务在执行，请等待完成后再操作')
      return
    }
    if (sbBusyGenerate || sbBusyApply || sbBusyEntity) return
    const plan = normalizeStoryboardAssetPlan(sbAssetPlan)
    if (!plan) {
      setSbError('请先生成必要事物资产计划')
      return
    }
    const asset = (Array.isArray(plan.assets) ? plan.assets : []).find((x: any) => String(x && x.id ? x.id : '').trim() === String(assetId || '').trim()) || null
    if (!asset) {
      setSbError('未找到对应的必要事物资产')
      return
    }
    const label = String(asset && asset.name ? asset.name : assetId).trim() || assetId
    setSbOptimizingAssetId(String(assetId || '').trim())
    appendSbLog(`开始增强资产提示词：${label}`)
    try {
      const draft = sbAssetPromptDrafts[String(assetId || '').trim()] || { promptZh: '', promptEn: '' }
      const res = await enhanceStoryAssetPromptAi(doc.id, String(assetId || '').trim(), {
        promptZh: String(draft.promptZh || '').trim(),
        promptEn: String(draft.promptEn || '').trim(),
        negativePromptZh: String(draft.negativePromptZh || '').trim(),
        negativePrompt: String(draft.negativePrompt || '').trim(),
        promptReview: draft.promptReview || null,
        forceRegenerate: true,
        globalPromptZh: String(sbReq.globalPromptZh || '').trim(),
        globalNegativePromptZh: String(sbReq.globalNegativePromptZh || '').trim()
      })
      // 2026-08-26 防静默兜底覆盖：AI 调用失败（如 oMLX 内存护栏 400）时路由返回 200+模板兜底，
      // 照样写回会把已有草稿洗成模板（实测批量 14 资产全中招）。只有 AI 稿真正上桌才允许落盘
      if (res.aiError && !(res.result?.context && (res.result.context as any).aiGenerated === true)) {
        const msg = String(res.aiError.message || 'AI 增强失败')
        setSbError(msg)
        appendSbLog(`资产提示词增强失败（已保留原稿）：${label} - ${msg}`)
        return false
      }
      updateStoryboardLockAssetPrompt(String(assetId || '').trim(), {
        promptZh: String(res.result?.promptZh || '').trim(),
        promptEn: String(res.result?.promptEn || '').trim(),
        negativePromptZh: String(res.result?.negativePromptZh || '').trim(),
        negativePrompt: String(res.result?.negativePrompt || '').trim(),
        promptReview: res.promptReview && typeof res.promptReview === 'object' ? res.promptReview : null
      }, {
        markEnhanced: true,
        enhanceMode: String(res.meta?.provider || '').trim() && String(res.meta?.provider || '').trim() !== 'local' ? 'ai' : 'fallback'
      })
      const reviewScore = Number(res.promptReview?.score)
      const reviewText = Number.isFinite(reviewScore) ? `${Math.round(reviewScore)}/100` : '未评分'
      appendSbLog(`资产提示词已增强：${label} / ${reviewText} / ${String(res.promptReview?.summary || res.result?.summary || 'ok')}`)
      setToast(`已增强提示词：${label}`)
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`资产提示词增强失败：${label} - ${msg}`)
      return false
    } finally {
      setSbOptimizingAssetId('')
    }
  }

  // ============ 2026-08-26 提示词流程修正（用户指令：中文优先 → 审核 → 翻译 → 批准 → 出图） ============
  // AI 逐个为全部资产生成中文提示词（串行避开并发限流，进度可见；中文稿先出，再逐条微调确认后翻译）
  const [sbEnhanceAllProgress, setSbEnhanceAllProgress] = useState({ current: 0, total: 0, busy: false })
  async function runStoryboardEnhanceAllAssetPrompts() {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbEnhanceAllProgress.busy) return
    const plan = normalizeStoryboardAssetPlan(sbAssetPlan)
    // 2026-10-07 只增强需抽卡的事物：背景锚点事物（prompt_only/optional_ref）不出立绘，
    // 其提示词无消费端——此前对它们也跑 AI 增强，纯浪费模型调用（每资产 1~2 分钟）
    const assets = (Array.isArray(plan?.assets) ? plan.assets : []).filter((a) => {
      const s = String(a?.renderStrategy || '').trim()
      return !s || s === 'ref_required'
    })
    if (!assets.length) {
      setSbError('请先生成必要事物资产计划')
      return
    }
    setSbEnhanceAllProgress({ current: 0, total: assets.length, busy: true })
    appendSbLog(`开始批量生成全部事物中文提示词（${assets.length} 个资产，逐个串行）`)
    let done = 0
    let failed = 0
    for (const asset of assets) {
      const assetId = String(asset?.id || '').trim()
      if (!assetId) continue
      try {
        // 返回 false 表示 AI 失败已保留原稿（不计入成功）
        const ok = await runStoryboardEnhanceAssetPrompt(assetId)
        if (ok === false) failed += 1
        else done += 1
      } catch {
        failed += 1
      }
      setSbEnhanceAllProgress((prev) => ({ ...prev, current: done + failed }))
    }
    setSbEnhanceAllProgress({ current: done + failed, total: assets.length, busy: false })
    appendSbLog(`批量中文提示词完成：成功 ${done}，失败 ${failed}${failed ? '（失败资产可单独点"AI 生成提示词"重试）' : ''}。请逐条审阅微调，「确认中文稿」后再执行翻译。`)
    setToast(done > 0 ? `已生成 ${done} 个事物的中文提示词` : '批量生成提示词失败')
  }

  // 2026-10-07 一键翻译全部中文稿：全局正/负向 + 每个抽卡事物的正/反向。
  // 背景：AI 增强链内的英文翻译会静默兜底成模板（enhance 端点 catch 吞掉翻译失败），
  // 用户看到英文栏是模板不是译文——提供显式可观测的批量翻译兜底通道。
  const [sbTranslateAllProgress, setSbTranslateAllProgress] = useState<{ current: number; total: number; busy: boolean }>({ current: 0, total: 0, busy: false })
  async function runStoryboardTranslateAllPrompts() {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbTranslateAllProgress.busy || storyboardPromptOpsBusy()) return
    const plan = normalizeStoryboardAssetPlan(sbAssetPlan)
    const assets = (Array.isArray(plan?.assets) ? plan.assets : []).filter((a) => {
      const s = String(a?.renderStrategy || '').trim()
      return !s || s === 'ref_required'
    })
    type Job = { kind: 'globalPrompt' | 'globalNegativePrompt'; label: string; zh: string } | { kind: 'asset'; assetId: string; field: 'prompt' | 'negative'; label: string; zh: string }
    const jobs: Job[] = []
    const gZh = String(sbReq.globalPromptZh || '').trim()
    const gEn = String(sbReq.globalPrompt || '').trim()
    const nZh = String(sbReq.globalNegativePromptZh || '').trim()
    const nEn = String(sbReq.globalNegativePrompt || '').trim()
    if (gZh && !gEn) jobs.push({ kind: 'globalPrompt', label: '全局正向', zh: gZh })
    if (nZh && !nEn) jobs.push({ kind: 'globalNegativePrompt', label: '全局负向', zh: nZh })
    for (const asset of assets) {
      const aid = String(asset?.id || '').trim()
      if (!aid) continue
      const name = String(asset?.name || aid).trim() || aid
      const draft = sbAssetPromptDraftsRef.current[aid] || {}
      const hintEn = String(asset?.referencePromptHint || '').trim()
      const posZh = String(draft.promptZh || '').trim()
      const posEn = String(draft.promptEn || '').trim()
      // 英文栏等于提示词模板 hint 视为未翻译（enhance 静默兜底的标志）
      if (posZh && (!posEn || posEn === hintEn)) jobs.push({ kind: 'asset', assetId: aid, field: 'prompt', label: `${name} 正向`, zh: posZh })
      const negZh = String(draft.negativePromptZh || '').trim()
      const negEn = String(draft.negativePrompt || '').trim()
      if (negZh && !negEn) jobs.push({ kind: 'asset', assetId: aid, field: 'negative', label: `${name} 反向`, zh: negZh })
    }
    if (!jobs.length) {
      setToast('全部中文稿均已有英文稿，无需翻译')
      appendSbLog('一键翻译检查：全部中文稿均已有英文稿，跳过')
      return
    }
    setSbError('')
    setSbTranslateAllProgress({ current: 0, total: jobs.length, busy: true })
    appendSbLog(`一键翻译开始：${jobs.length} 条中文稿 → 英文（串行）`)
    let done = 0
    let failed = 0
    for (const job of jobs) {
      try {
        const res = await translateStoryboardPromptText(doc.id, { text: job.zh, sourceLang: 'zh', targetLang: 'en', mode: 'prompt', timeoutMs: 60_000 })
        const en = String(res?.result?.translatedText || '').trim()
        if (!en) throw new Error('翻译结果为空')
        if (job.kind === 'asset') updateStoryboardLockAssetPrompt(job.assetId, job.field === 'prompt' ? { promptEn: en } : { negativePrompt: en }, { preserveEnhanced: true })
        else if (job.kind === 'globalPrompt') updateStoryboardLockGlobalPrompts({ globalPrompt: en })
        else updateStoryboardLockGlobalPrompts({ globalNegativePrompt: en })
        done += 1
        appendSbLog(`  翻译完成：${job.label} → ${en.slice(0, 80)}${en.length > 80 ? '…' : ''}`)
      } catch (e) {
        failed += 1
        appendSbLog(`  翻译失败：${job.label} - ${e instanceof Error ? e.message : String(e)}`)
      }
      setSbTranslateAllProgress({ current: done + failed, total: jobs.length, busy: true })
    }
    setSbTranslateAllProgress({ current: done + failed, total: jobs.length, busy: false })
    appendSbLog(`一键翻译完成：成功 ${done}，失败 ${failed}${failed ? '（可重试）' : ''}。英文稿齐后点「批准英文稿」。`)
    setToast(done > 0 ? `已翻译 ${done} 条提示词` : '翻译失败')
  }

  // AI 生成中文全局稿：专用生成链只返回正、负向中文稿，结果仍需确认后翻译
  const [sbGlobalDraftBusy, setSbGlobalDraftBusy] = useState(false)
  async function runStoryboardDraftGlobalPromptZh() {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbGlobalDraftBusy) return
    const currentReq = sbReqRef.current
    setSbGlobalDraftBusy(true)
    setSbError('')
    appendSbLog('开始 AI 生成中文全局提示词（结合 Story Bible 与当前设定）')
    try {
      const generated = await generateStoryboardGlobalPromptAi(doc.id, {
        scope: 'global',
        projectTitle: String(doc.project.title || '').trim(),
        storyBibleJson: String(currentReq.storyBibleJson || '').trim(),
        globalPromptZh: String(currentReq.globalPromptZh || '').trim(),
        globalPrompt: String(currentReq.globalPrompt || '').trim(),
        globalNegativePromptZh: String(currentReq.globalNegativePromptZh || '').trim(),
        globalNegativePrompt: String(currentReq.globalNegativePrompt || '').trim(),
        style: String(currentReq.style || '').trim(),
        aspectRatio: String(currentReq.aspectRatio || '').trim()
      })
      const posZh = String(generated.result?.globalPromptZh || '').trim()
      const negZh = String(generated.result?.globalNegativePromptZh || '').trim()
      if (!posZh || !negZh) throw new Error('AI 返回的全局中文稿不完整，请重试')
      updateStoryboardLockGlobalPrompts({
        globalPromptZh: posZh,
        globalNegativePromptZh: negZh,
        globalPrompt: '',
        globalNegativePrompt: ''
      })
      appendSbLog('AI 中文全局稿已生成：请审阅微调后「确认中文稿」，再执行中文转英文')
      appendSbLog(`  正向中文稿：${posZh.slice(0, 160)}${posZh.length > 160 ? '…' : ''}`)
      appendSbLog(`  负向中文稿：${negZh.slice(0, 120)}${negZh.length > 120 ? '…' : ''}`)
      setToast('AI 中文全局稿已生成')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`AI 中文全局稿生成失败：${msg}`)
    } finally {
      setSbGlobalDraftBusy(false)
    }
  }

  const requestStoryboardReferenceOverride = (message: string): Promise<boolean> => (
    new Promise<boolean>((resolve) => {
      sbOverrideResolverRef.current = resolve
      setSbOverrideModal({ open: true, message })
    })
  )

  async function runStoryboardSelectAssetReference(assetId: string, assetPath: string) {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbBusyGenerate || sbBusyApply || sbBusyEntity || Boolean(sbSelectingAssetId)) return
    const plan = normalizeStoryboardAssetPlan(sbAssetPlan)
    if (!plan) {
      setSbError('请先生成必要事物资产计划')
      return
    }
    const asset = (Array.isArray(plan.assets) ? plan.assets : []).find((x: any) => String(x && x.id ? x.id : '').trim() === String(assetId || '').trim()) || null
    if (!asset) {
      setSbError('未找到对应的必要事物资产')
      return
    }
    const label = String(asset && asset.name ? asset.name : assetId).trim() || assetId
    setSbSelectingAssetId(String(assetId || '').trim())
    setSbGeneratingAssetId('')
    setSbAnalyzingAssetId('')
    setSbOptimizingAssetId('')
    setSbLineartAssetId('')
    setSbAssetsConfirmedAt('')
    setSbContinuityReady(false)

    const normalizePath = (value: string) => String(value || '').trim().replace(/^\/+/, '')
    const targetPath = normalizePath(assetPath)
    const batch = Array.isArray(asset.latestReferenceBatch) ? asset.latestReferenceBatch : []
    const generatedRefs = Array.isArray(asset.generatedRefs) ? asset.generatedRefs : []
    const pickedCandidate = batch.find((item: any) => normalizePath(String(item?.assetPath || '')) === targetPath) || null
    const generatedRef = generatedRefs.find((item: any) => normalizePath(String(item?.projectAssetUri || '')) === targetPath) || null
    const latestReview = asset.latestReferenceReview && typeof asset.latestReferenceReview === 'object'
      && normalizePath(String(asset.latestReferenceReview.targetAssetUri || '')) === targetPath
      ? asset.latestReferenceReview
      : null
    const candidateReview = pickedCandidate && pickedCandidate.analysis && typeof pickedCandidate.analysis === 'object'
      ? pickedCandidate.analysis
      : latestReview

    let overrideConfirmed = false
    if (candidateReview && candidateReview.passed !== true) {
      const scoreText = Number.isFinite(Number(candidateReview.score)) ? `（${Math.round(Number(candidateReview.score))} 分）` : ''
      const reason = String(
        candidateReview.summary ||
        candidateReview.reviewError ||
        (Array.isArray(candidateReview.issues) ? candidateReview.issues.filter(Boolean).join('；') : '') ||
        '未提供详细原因'
      ).trim()
      const allow = await requestStoryboardReferenceOverride(`AI 视觉评审未通过${scoreText}。${reason}`)
      if (!allow) {
        appendSbLog(`已取消人工特批设为主参考：${label}`)
        setSbSelectingAssetId('')
        return
      }
      overrideConfirmed = true
      appendSbLog(`人工特批设为主参考：${label}`)
    } else {
      appendSbLog(`开始设置主参考：${label}（将执行白底抠图，生成可锁定主参考）`)
    }

    try {
      const res = await selectStoryAssetReferenceAi(doc.id, {
        assetId: String(assetId || '').trim(),
        assetPath: String(assetPath || '').trim(),
        ...(overrideConfirmed ? { manualOverride: true } : {})
      })
      const nextPlan = normalizeStoryboardAssetPlan(res.plan)
      setSbAssetPlan(nextPlan)
      persistStoryboardAssetPlan(nextPlan, '')
      appendSbLog(`已设置主参考${overrideConfirmed ? '（人工特批）' : ''}：${label}`)
      setToast(`已选择主参考${overrideConfirmed ? '（人工特批）' : ''}：${label}`)
      setSbError('')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/评审|禁止写入主参考/.test(msg) && !overrideConfirmed) {
        const allow = await requestStoryboardReferenceOverride(msg)
        if (allow) {
          appendSbLog(`人工特批设为主参考：${label}`)
          try {
            const res2 = await selectStoryAssetReferenceAi(doc.id, { assetId: String(assetId || '').trim(), assetPath: String(assetPath || '').trim(), manualOverride: true })
            const nextPlan2 = normalizeStoryboardAssetPlan(res2.plan)
            setSbAssetPlan(nextPlan2)
            persistStoryboardAssetPlan(nextPlan2, '')
            appendSbLog(`已设置主参考（人工特批）：${label}`)
            setToast(`已选择主参考（人工特批）：${label}`)
            setSbError('')
            return
          } catch (e2) {
            const msg2 = e2 instanceof Error ? e2.message : String(e2)
            setSbError(msg2)
            appendSbLog(`人工特批设置主参考失败：${label} - ${msg2}`)
            return
          }
        }
      }
      setSbError(msg)
      appendSbLog(`设置主参考失败：${label} - ${msg}`)
    } finally {
      setSbSelectingAssetId('')
    }
  }

  async function runStoryboardGenerateAssetLineart(assetId: string) {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbAssetPlanBusy || sbBusyGenerate || sbBusyApply || sbBusyEntity) return
    const plan = normalizeStoryboardAssetPlan(sbAssetPlan)
    if (!plan) {
      setSbError('请先生成必要事物资产计划')
      return
    }
    const asset = (Array.isArray(plan.assets) ? plan.assets : []).find((x: any) => String(x && x.id ? x.id : '').trim() === String(assetId || '').trim()) || null
    if (!asset) {
      setSbError('未找到对应的必要事物资产')
      return
    }
    if (!String(asset?.primaryReferenceAssetUri || '').trim()) {
      setSbError('请先从 4 张候选图中手动选择主参考，再生成线稿')
      return
    }
    const label = String(asset && asset.name ? asset.name : assetId).trim() || assetId
    setSbAssetPlanBusy(true)
    setSbLineartAssetId(String(assetId || '').trim())
    setSbGeneratingAssetId('')
    setSbAnalyzingAssetId('')
    setSbOptimizingAssetId('')
    setSbSelectingAssetId('')
    setSbAssetsConfirmedAt('')
    setSbContinuityReady(false)
    appendSbLog(`开始生成线稿：${label}（将执行 ControlNet 线稿工作流）`)
    try {
      const lineartSize = getStoryboardAssetRenderSize(asset)
      const res = await generateStoryAssetLineartAi(doc.id, {
        assetId: String(assetId || '').trim(),
        model: String(sbReq.model || '').trim() || undefined,
        width: lineartSize.width,
        height: lineartSize.height,
        steps: 20,
        cfgScale: 3.5,
        denoise: 0.55
      })
      // manual 模式：出图前审核挂起（202 无 plan），保留现有计划并提示去待审核列表批准
      if ((res as any)?.pendingReview) {
        appendSbLog(`线稿出图前审核待批准：${label}（在下方待审核列表批准后自动执行）`)
        setToast(`线稿待出图前审核批准：${label}`)
        return
      }
      applyStoryboardPlanResponse(res)
      appendSbLog(`线稿已生成：${label} / ${lineartSize.label}`)
      setToast(`已生成线稿：${label}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`线稿生成失败：${label} - ${msg}`)
    } finally {
      setSbAssetPlanBusy(false)
      setSbLineartAssetId('')
    }
  }

  async function runStoryboardOpenAssetGallery(assetId: string) {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbAssetPlanBusy || sbBusyGenerate || sbBusyApply || sbBusyEntity) return
    const plan = normalizeStoryboardAssetPlan(sbAssetPlan)
    const asset = (Array.isArray(plan?.assets) ? plan!.assets : []).find((x: any) => String(x && x.id ? x.id : '').trim() === String(assetId || '').trim()) || null
    if (!asset) {
      setSbError('未找到对应的必要事物资产')
      return
    }
    const label = String(asset && asset.name ? asset.name : assetId).trim() || assetId
    setSbGalleryBusy(true)
    setSbGalleryDeletingPaths([])
    setSbGallery({ assetId: String(assetId || '').trim(), assetName: label, items: [] })
    appendSbLog(`加载图片管理列表：${label}`)
    try {
      const res = await listStoryAssetGalleryAi(doc.id, String(assetId || '').trim())
      const nextPlan = normalizeStoryboardAssetPlan(res.plan)
      setSbAssetPlan(nextPlan)
      persistStoryboardAssetPlan(nextPlan, '')
      setSbGallery({
        assetId: String(assetId || '').trim(),
        assetName: String(res.asset?.name || label).trim() || label,
        items: Array.isArray(res.items) ? res.items : []
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`加载图片管理列表失败：${label} - ${msg}`)
      setSbGallery(null)
    } finally {
      setSbGalleryBusy(false)
    }
  }

  function closeStoryboardAssetGallery() {
    if (sbGalleryDeletingPaths.length) return
    setSbGallery(null)
    setSbGalleryBusy(false)
    setSbGalleryDeletingPaths([])
  }

  async function runStoryboardDeleteAssetGalleryItem(assetId: string, assetPath: string) {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbAssetPlanBusy || sbBusyGenerate || sbBusyApply || sbBusyEntity) return
    const plan = normalizeStoryboardAssetPlan(sbAssetPlan)
    const asset = (Array.isArray(plan?.assets) ? plan!.assets : []).find((x: any) => String(x && x.id ? x.id : '').trim() === String(assetId || '').trim()) || null
    if (!asset) {
      setSbError('未找到对应的必要事物资产')
      return
    }
    const label = String(asset && asset.name ? asset.name : assetId).trim() || assetId
    setSbAssetPlanBusy(true)
    setSbGalleryDeletingPaths([String(assetPath || '').trim()])
    appendSbLog(`删除图片：${label} / ${String(assetPath || '').trim()}`)
    try {
      const res = await deleteStoryAssetGalleryItemAi(doc.id, {
        assetId: String(assetId || '').trim(),
        assetPath: String(assetPath || '').trim()
      })
      const nextPlan = normalizeStoryboardAssetPlan(res.plan)
      setSbAssetPlan(nextPlan)
      persistStoryboardAssetPlan(nextPlan, '')
      setSbAssetsConfirmedAt('')
      setSbContinuityReady(false)
      setSbGallery((prev) => {
        if (!prev || prev.assetId !== String(assetId || '').trim()) return prev
        return {
          assetId: prev.assetId,
          assetName: String(res.asset?.name || prev.assetName || label).trim() || label,
          items: Array.isArray(res.items) ? res.items : []
        }
      })
      appendSbLog(`图片已删除：${label}`)
      setToast('图片已删除')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`删除图片失败：${label} - ${msg}`)
    } finally {
      setSbAssetPlanBusy(false)
      setSbGalleryDeletingPaths([])
    }
  }

  async function runStoryboardDeleteAssetGalleryItems(assetId: string, assetPaths: string[]) {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbAssetPlanBusy || sbBusyGenerate || sbBusyApply || sbBusyEntity) return
    const normalizedPaths = Array.from(new Set((Array.isArray(assetPaths) ? assetPaths : []).map((item) => String(item || '').trim()).filter(Boolean)))
    if (!normalizedPaths.length) return
    const plan = normalizeStoryboardAssetPlan(sbAssetPlan)
    const asset = (Array.isArray(plan?.assets) ? plan!.assets : []).find((x: any) => String(x && x.id ? x.id : '').trim() === String(assetId || '').trim()) || null
    if (!asset) {
      setSbError('未找到对应的必要事物资产')
      return
    }
    const label = String(asset && asset.name ? asset.name : assetId).trim() || assetId
    setSbAssetPlanBusy(true)
    setSbGalleryDeletingPaths(normalizedPaths)
    appendSbLog(`批量删除图片：${label} / ${normalizedPaths.length} 张`)
    try {
      let latestPlan = plan
      let latestItems = Array.isArray(sbGallery?.items) ? sbGallery.items : []
      let latestAsset = asset
      for (const itemPath of normalizedPaths) {
        const res = await deleteStoryAssetGalleryItemAi(doc.id, {
          assetId: String(assetId || '').trim(),
          assetPath: itemPath
        })
        latestPlan = normalizeStoryboardAssetPlan(res.plan)
        latestItems = Array.isArray(res.items) ? res.items : []
        latestAsset = (res.asset as any) || latestAsset
      }
      setSbAssetPlan(latestPlan)
      persistStoryboardAssetPlan(latestPlan, '')
      setSbAssetsConfirmedAt('')
      setSbContinuityReady(false)
      setSbGallery((prev) => {
        if (!prev || prev.assetId !== String(assetId || '').trim()) return prev
        return {
          assetId: prev.assetId,
          assetName: String((latestAsset as any)?.name || prev.assetName || label).trim() || label,
          items: latestItems
        }
      })
      appendSbLog(`图片已批量删除：${label} / ${normalizedPaths.length} 张`)
      setToast(`已删除 ${normalizedPaths.length} 张图片`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`批量删除图片失败：${label} - ${msg}`)
    } finally {
      setSbAssetPlanBusy(false)
      setSbGalleryDeletingPaths([])
    }
  }

  async function runStoryboardSelectAssetGalleryPrimary(assetId: string, assetPath: string) {
    if (doc.mode !== 'project' || !doc.project) return
    await runStoryboardSelectAssetReference(assetId, assetPath)
    if (!String(assetPath || '').trim()) return
    try {
      const res = await listStoryAssetGalleryAi(doc.id, String(assetId || '').trim())
      const nextPlan = normalizeStoryboardAssetPlan(res.plan)
      setSbAssetPlan(nextPlan)
      persistStoryboardAssetPlan(nextPlan, '')
      setSbGallery((prev) => {
        if (!prev || prev.assetId !== String(assetId || '').trim()) return prev
        return {
          assetId: prev.assetId,
          assetName: String(res.asset?.name || prev.assetName || '').trim() || prev.assetName,
          items: Array.isArray(res.items) ? res.items : []
        }
      })
    } catch (_) {
      // Ignore gallery refresh failures; the primary selection already updated the main asset plan.
    }
  }

  async function runStoryboardGenerateAllMissingAssetReferences() {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbAssetPlanBusy || sbBusyGenerate || sbBusyApply || sbBusyEntity) return
    const plan = normalizeStoryboardAssetPlan(sbAssetPlan)
    if (!plan) {
      setSbError('请先生成必要事物资产计划')
      return
    }
    const missing = getStoryboardRequiredMissingAssets(plan)
    if (!missing.length) {
      setToast('当前没有缺失的必要事物参考图')
      return
    }
    appendSbLog(`开始批量生成必要事物参考图：共 ${missing.length} 项`)
    for (const item of missing) {
      await runStoryboardGenerateAssetReference(String(item.id || '').trim())
    }
    appendSbLog('批量生成流程已完成，请检查卡片状态并确认资产')
  }

  function confirmStoryboardAssetPlan() {
    const plan = normalizeStoryboardAssetPlan(sbAssetPlan)
    if (!plan) {
      setSbError('请先生成必要事物资产计划')
      return
    }
    const unlocked = getStoryboardRequiredUnlockedAssets(plan)
    if (unlocked.length) {
      const msg = `仍有 ${unlocked.length} 个必要事物尚未完成主参考或线稿：${unlocked.slice(0, 6).map((x) => x.name || x.id).join('、')}`
      setSbError(msg)
      appendSbLog(`阻止确认：${msg}`)
      return
    }
    const confirmedAt = new Date().toISOString()
    setSbAssetsConfirmedAt(confirmedAt)
    persistStoryboardAssetPlan(plan, confirmedAt)
    setSbContinuityReady(false)
    appendSbLog('锁定资产已确认，可进入正式场景出图阶段')
    setToast('已确认锁定资产')
  }

  async function runStoryboardGenerateEntitySpec() {
    if (doc.mode !== 'project' || !doc.project || !doc.story) {
      // 静默 return 会让用户以为按钮坏了——给出可见反馈
      setSbError('无法生成 Story Bible：当前未打开有效的故事项目（请先在合成工作室打开项目）')
      return
    }
    if (sbBusyGenerate || sbBusyApply || sbBusyEntity) {
      // 忙碌守卫原本静默吞点击；bible 生成可能长达数分钟，必须让用户知道在忙
      setSbError('有生成任务正在进行中（Story Bible 生成可能需几分钟），请等待完成后再点击')
      return
    }
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
      // 2026-10-05 门禁契约对齐：story.bible.generate 的 input 是 strict schema（仅 title/brief/scenes/characters/props/locations 等白名单），
      // 此前多传的 style/aspectRatio/globalPrompt/storySummary 会被 StoryInputGate 整包拒绝（假日出游锁定事物第2步卡死事件）
      const input = {
        title: projectTitle || undefined,
        brief: wholeStoryInput || undefined,
        scenes
      }

      // timeoutMs <= 0 means wait indefinitely for Story Bible generation.
      const { result } = await generateStoryBibleAi(doc.id, { input, timeoutMs: 0 })
      if (!result) throw new Error('empty_story_bible')
      const storyBibleJson = JSON.stringify(result, null, 2)
      const entitySpec = buildEntitySpecFromStoryBible(result)
      if (!entitySpec) throw new Error('empty_entity_spec_from_bible')
      saveStoryboardContinuityBackup(AI_BG_CONTINUITY_KEY, { storyBibleJson, entitySpec, continuity: sbReq.continuity })

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
      // 2026-10-06 产出可见：圣经生成了什么，逐类列进日志（实体名/世界锚点/场景绑定覆盖）
      const bCharsOut = Array.isArray((result as any)?.characters) ? (result as any).characters : []
      const bPropsOut = Array.isArray((result as any)?.props) ? (result as any).props : []
      const bLocsOut = Array.isArray((result as any)?.locations) ? (result as any).locations : []
      const nameListOf = (arr: any[]) => arr.map((x) => String(x?.name || x?.id || '').trim()).filter(Boolean).join('、')
      const worldAnchorOut = String((result as any)?.worldAnchor || '').trim()
      const sceneRefCount = Object.keys((result as any)?.sceneRefs || {}).length
      const forbiddenOut = Array.isArray((result as any)?.forbiddenSubstitutes) ? (result as any).forbiddenSubstitutes : []
      appendSbLog(`Story Bible 生成完成：角色 ${bCharsOut.length}（${nameListOf(bCharsOut) || '无'}）· 道具 ${bPropsOut.length}（${nameListOf(bPropsOut) || '无'}）· 地点 ${bLocsOut.length}（${nameListOf(bLocsOut) || '无'}）`)
      if (worldAnchorOut) appendSbLog(`世界锚点：${worldAnchorOut.slice(0, 140)}${worldAnchorOut.length > 140 ? '…' : ''}`)
      appendSbLog(`场景绑定：sceneRefs 覆盖 ${sceneRefCount}/${sceneNodes.length} 个场景；禁用替代物 ${forbiddenOut.length} 条${sceneRefCount === 0 ? '（注意：绑定为空，资产分配将只靠文本匹配）' : ''}`)
      appendSbLog('接下来自动生成必要事物资产计划…')
      try {
        await buildStoryboardAssetPlanFromStoryBible(result, true)
      } catch (planError) {
        const planMsg = planError instanceof Error ? planError.message : String(planError)
        setSbError(planMsg)
        appendSbLog(`必要事物资产计划未生成成功：${planMsg}`)
      }
      // 2026-09-10 自动填好：Bible 产出世界锚点后，若中文全局稿仍为空，自动译写一份——
      // 新项目走到第 4 步时中文稿已就位，用户只做审阅→确认→翻译→批准。
      // 用函数式更新读最新态：已有中文稿（用户手填/此前起草）不覆盖；失败不阻塞主流程。
      try {
        const worldAnchorAuto = String((result as any)?.worldAnchor || '').trim()
        const zhAlready = String(sbReq.globalPromptZh || '').trim() || String((doc.project as any)?.state?.aiBackground?.storyboardGlobalPromptZh || '').trim()
        if (worldAnchorAuto && !zhAlready) {
          appendSbLog('自动起草中文全局提示词（世界锚点译写，可在第 4 步审阅修改）')
          const posResAuto = await translateStoryboardPromptText(doc.id, { text: worldAnchorAuto, sourceLang: 'en', targetLang: 'zh', mode: 'prompt', timeoutMs: 60_000 })
          const posZhAuto = String(posResAuto.result?.translatedText || '').trim()
          const forbiddenAuto = Array.isArray((result as any)?.forbiddenSubstitutes) ? (result as any).forbiddenSubstitutes.map((x: any) => String(x || '').trim()).filter(Boolean) : []
          let negZhAuto = ''
          if (forbiddenAuto.length > 0) {
            const negResAuto = await translateStoryboardPromptText(doc.id, { text: forbiddenAuto.join(', '), sourceLang: 'en', targetLang: 'zh', mode: 'prompt', timeoutMs: 60_000 })
            negZhAuto = String(negResAuto.result?.translatedText || '').trim()
          }
          if (posZhAuto || negZhAuto) {
            setSbReq((prev) => (String(prev.globalPromptZh || '').trim() ? prev : { ...prev, globalPromptZh: posZhAuto, globalNegativePromptZh: negZhAuto }))
            setDocProject((p) => {
              const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
              const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
              if (String((aiBgIn as any).storyboardGlobalPromptZh || '').trim()) return p
              return {
                ...p,
                state: {
                  ...stateIn,
                  aiBackground: {
                    ...aiBgIn,
                    storyboardGlobalPromptZh: posZhAuto,
                    storyboardGlobalNegativePromptZh: negZhAuto
                  }
                }
              }
            })
            appendSbLog('中文全局稿已自动起草（第 4 步审阅后确认→翻译→批准）')
            if (posZhAuto) appendSbLog(`  正向中文稿：${posZhAuto.slice(0, 160)}${posZhAuto.length > 160 ? '…' : ''}`)
            if (negZhAuto) appendSbLog(`  负向中文稿：${negZhAuto.slice(0, 120)}${negZhAuto.length > 120 ? '…' : ''}`)
          }
        }
      } catch (draftAutoError) {
        appendSbLog(`中文全局稿自动起草跳过（可在第 4 步手动点「AI 生成中文全局稿」）：${draftAutoError instanceof Error ? draftAutoError.message : String(draftAutoError)}`)
      }
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
    if (!sbAssetConfirmReady) {
      setSbError('请先完成“必要事物资产确认”，再继续生成场景提示词')
      appendSbLog('阻止执行：必要事物资产尚未确认')
      return
    }
    if (!sbItems.length) {
      setSbError('没有可处理的场景节点')
      return
    }
    const onlyPending = mode === 'pending'
    const targets = onlyPending
      ? sbItems.filter((x) => x.status === 'error' || !String(x.prompt || '').trim() || !String(x.promptZh || '').trim())
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
    const isDoubaoStoryboard =
      String(sbOpenChecks.promptProvider || '').toLowerCase() === 'doubao' &&
      String(sbOpenChecks.imageProvider || '').toLowerCase() === 'doubao'
    let globalLocked = onlyPending ? Boolean(currGlobalPrompt) : false
    if (!onlyPending && styleChanged) {
      appendSbLog('检测到风格/比例已变更：已重置全局正负提示词，并将重新生成全部场景提示词')
      currGlobalPrompt = ''
      currGlobalNegativePrompt = ''
      globalLocked = false
      setSbReq((prev) => ({ ...prev, globalPrompt: '', globalNegativePrompt: '' }))
      setSbItems((prev) => prev.map((x) => ({ ...x, promptZh: '', prompt: '', negativePromptZh: '', negativePrompt: '', promptReview: null, status: 'idle', note: '' })))
    }
    if (!onlyPending) {
      appendSbLog('全量生成会重建全局正向/负向：以首个成功场景返回为基准，再用于后续场景一致性')
      setSbItems((prev) => prev.map((x) => ({ ...x, promptReview: null, status: 'idle', note: '' })))
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
    let stoppedOnFirstError = false
    let firstFailureMessage = ''
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
          let promptReview: StoryboardPromptQualityReview | null = null
          let promptZh = ''
          let negativePromptZh = ''
          try {
            promptReview = await reviewStoryboardPromptAi(doc.id, {
              scope: 'scene',
              projectTitle,
              storyBibleJson: String(sbReq.storyBibleJson || '').trim(),
              globalPromptZh: String(sbReq.globalPromptZh || '').trim(),
              globalPrompt: currGlobalPrompt,
              globalNegativePromptZh: String(sbReq.globalNegativePromptZh || '').trim(),
              globalNegativePrompt: currGlobalNegativePrompt,
              sceneUserInput: userInput,
              scenePrompt: sp,
              sceneNegativePrompt: sneg,
              style: String(sbReq.style || '').trim(),
              aspectRatio: String(sbReq.aspectRatio || '').trim()
            })
            promptZh = String(promptReview.ai.optimizedScenePromptZh || '').trim()
            negativePromptZh = String(promptReview.ai.optimizedSceneNegativePromptZh || '').trim()
          } catch (reviewErr) {
            appendSbLog(`场景评分回退：${it.nodeName} - ${reviewErr instanceof Error ? reviewErr.message : String(reviewErr)}`)
          }
          setSbItems((prev) =>
            prev.map((x) => (
              x.nodeId === it.nodeId
                ? { ...x, userInput, promptZh, prompt: sp, negativePromptZh, negativePrompt: sneg, promptReview, status: 'generated', note: 'ok' }
                : x
            ))
          )
          upsertStoryboardScenePrompt(it.nodeId, it.nodeName, { userInput, promptZh, prompt: sp, negativePromptZh, negativePrompt: sneg, promptReview })
          appendSbLog(`场景提示词已生成：${it.nodeName}（${Math.max(1, Date.now() - sceneStartedAt)}ms）`)
          okCount += 1
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          setSbItems((prev) => prev.map((x) => (x.nodeId === it.nodeId ? { ...x, status: 'error', note: msg } : x)))
          const fullMsg = `场景提示词生成失败：${it.nodeName} - ${msg}`
          appendSbLog(`场景生成失败：${it.nodeName} - ${msg}`)
          setSbError(fullMsg)
          firstFailureMessage = fullMsg
          appendSbLog('已在当前失败场景处停止；请先修正问题，再点“继续提示词队列”恢复。')
          failCount += 1
          stoppedOnFirstError = true
          break
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
      if (isDoubaoStoryboard) {
        const promptsReady = failCount === 0 && okCount > 0 && !sbQueueRef.current.cancelRequested
        setSbContinuityReady(false)
        setSbContinuitySummary(
          promptsReady
            ? '场景提示词已生成，请选择一个场景运行场景测试'
            : '提示词已更新，请重新运行场景测试'
        )
      } else {
        setSbContinuityReady(false)
        setSbContinuitySummary(
          failCount === 0 && okCount > 0 && !sbQueueRef.current.cancelRequested
            ? '场景提示词已生成，请选择一个场景运行场景测试'
            : '提示词已更新，请重新运行场景测试'
        )
      }
      setDocProject((p) => {
        const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
        const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
        const prevMeta = (aiBgIn as any).storyboardPromptMeta && typeof (aiBgIn as any).storyboardPromptMeta === 'object'
          ? (aiBgIn as any).storyboardPromptMeta
          : {}
        const nextState = {
          ...stateIn,
          aiBackground: {
            ...aiBgIn,
            globalPrompt: currGlobalPrompt,
            globalNegativePrompt: currGlobalNegativePrompt,
            storyboardContinuity: sbReq.continuity,
            storyboardPromptMeta: {
              ...prevMeta,
              style: String(sbReq.style || ''),
              aspectRatio: String(sbReq.aspectRatio || ''),
              updatedAt: new Date().toISOString()
            }
          }
        }
        return { ...p, state: nextState }
      })
      if (failCount > 0) {
        const msg = stoppedOnFirstError
          ? `已在首个失败场景处停止：成功 ${okCount}，失败 ${failCount}（修正后可点“继续提示词队列”）`
          : `本轮完成：成功 ${okCount}，失败 ${failCount}（可点“重试失败/继续未完成”）`
        appendSbLog(msg)
        if (!firstFailureMessage) setSbError(msg)
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
    if (!sbAssetConfirmReady) {
      setSbError('请先完成“必要事物资产确认”，再继续批量出图')
      appendSbLog('阻止执行：必要事物资产尚未确认')
      return
    }
    if (!sbContinuityReady) {
      setSbError('请先在正式场景页上半部分运行“场景测试”，通过后才能批量出图')
      appendSbLog('阻止执行：场景测试未通过')
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
      const buildSceneLockedAssetRefs = (sceneId: string) => {
        const plan = sbAssetPlan
        if (!plan || !Array.isArray(plan.scenes) || !Array.isArray(plan.assets)) return []
        const assetsById = new Map((plan.assets || []).filter(Boolean).map((asset: any) => [String(asset?.id || '').trim(), asset]))
        const scene = (plan.scenes || []).find((item: any) => String(item?.sceneId || '').trim() === String(sceneId || '').trim())
        if (!scene) return []
        const promptAssets = Array.isArray(scene?.promptAssets) ? scene.promptAssets : []
        return promptAssets
          .map((item: any) => assetsById.get(String(item?.id || '').trim()) || item)
          .filter((asset: any) => asset && String(asset?.category || '').trim() !== 'character')
          .map((asset: any) => {
            const assetUri = String(asset?.primaryReferenceAssetUri || '').trim()
            if (!assetUri) return null
            return {
              assetId: String(asset?.primaryReferenceAssetId || asset?.id || '').trim() || undefined,
              assetName: String(asset?.name || asset?.id || 'reference').trim(),
              assetType: String(asset?.category || 'asset').trim() || 'asset',
              assetPath: assetUri,
              assetUri,
              weight: String(asset?.category || '').trim() === 'location' ? 0.85 : 0.8
            }
          })
          .filter(Boolean)
      }

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
          const nodeForRefs = storyNodesById.get(String(it.nodeId || '')) as any
          const characterRefs = buildSelectedCharacterRefsFromChoices(
            buildNodeCharacterReferenceChoices(nodeForRefs ? ensureNode(nodeForRefs) : null)
          )
          const assetRefs = buildSceneLockedAssetRefs(it.nodeId)
          if (assetRefs.length > 0) appendSbLog(`场景锁定事物参考：${assetRefs.map((ref: any) => ref.assetName).slice(0, 6).join('、')}`)
          const payloadBase: StoryboardSceneAiBackgroundRequest = {
            userInput: String(it.userInput || ''),
            globalPrompt: gpWithRoles,
            globalNegativePrompt: gneg,
            prompt: sp,
            negativePrompt: sneg,
            style: sbReq.style,
            aspectRatio: sbReq.aspectRatio,
            model: String(sbReq.model || '').trim() || undefined,
            loras: Array.isArray(sbReq.loras) && sbReq.loras.length ? sbReq.loras : undefined,
            continuity: {
              ipadapterEnabled: Boolean(sbReq.continuity?.ipadapterEnabled),
              requireCharacterRefs: Boolean(sbReq.continuity?.requireCharacterRefs),
              controlnetEnabled: Boolean(sbReq.continuity?.controlnetEnabled),
              seedMode: 'random'
            },
            characterRefs,
            assetRefs,
            timeoutMs: provider === 'doubao' ? 300_000 : 0
          }
          const payload: StoryboardSceneAiBackgroundRequest = provider === 'doubao'
            ? {
                ...payloadBase,
                width: undefined,
                height: undefined,
                steps: undefined,
                cfgScale: undefined,
                sampler: undefined,
                scheduler: undefined,
                size: String(sbReq.size || '').trim() || undefined,
                responseFormat: sbReq.responseFormat || 'url',
                watermark: Boolean(sbReq.watermark),
                sequentialImageGeneration: sbReq.sequentialImageGeneration || 'auto'
              }
            : {
                ...payloadBase,
                width: sbReq.width,
                height: sbReq.height,
                steps: sbReq.steps,
                cfgScale: sbReq.cfgScale,
                sampler: sbReq.sampler,
                scheduler: sbReq.scheduler
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
          const existingAsset = bgId ? (nextProject.assets || []).find((a) => a.id === bgId) || null : null
          if (existingAsset && String(existingAsset.uri || '').trim()) {
            payload.existingAssetUri = String(existingAsset.uri || '').trim()
          }
          const assetIdx = bgId ? (nextProject.assets || []).findIndex((a) => a.id === bgId) : -1
          if (assetIdx >= 0) {
            appendSbLog(`覆盖已有场景图：${it.nodeName}`)
            const old = (nextProject.assets || [])[assetIdx]
            const patched = {
              ...old,
              uri: nextUri,
              source: { type: 'ai' as const, prompt: usedPrompt || sp, provider: bgProvider, remoteUrl: String((resp as any).remoteUrl || '').trim() || undefined }
            }
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
              source: { type: 'ai' as const, prompt: usedPrompt || sp, provider: bgProvider, remoteUrl: String((resp as any).remoteUrl || '').trim() || undefined }
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
    // 2026-09-10 断源：空就是空，不再种"故事名：《…》"占位垃圾
    const gpUse = String(aiReq.globalPrompt || '').trim() || gpSaved.trim()
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

  // 2026-09-01 出图统一管理在锁定向导：摆放属性不再承担生成管理。
  // 通用打开器：按 planAssetId 优先、name 兜底匹配 plan.assets（不限 category），打开锁定向导并定位到该资产的详情/姿势变体区。
  async function openAssetLockInWizard(input: { planAssetId?: string; name?: string }) {
    if (!doc.project || !doc.story || doc.mode !== 'project') return
    const planAssetId = String(input?.planAssetId || '').trim()
    const name = String(input?.name || '').trim()
    await initStoryboardBatchFromDoc()
    // init 内部异步回填 sbAssetPlan；此处以 project.json 副本兜底找资产 id（plan.json 权威数据向导打开后自会加载）
    const plan = sbPosePlanRef.current || readStoryboardAssetPlanFromProject(doc.project)
    const planAssets = Array.isArray((plan as any)?.assets) ? (plan as any).assets : []
    const hit = (planAssetId ? planAssets.find((a: any) => String(a?.id || '').trim() === planAssetId) : null)
      || (name ? planAssets.find((a: any) => String(a?.name || '').trim() === name) : null)
      || null
    setSbPoseFocusAssetId(hit ? String(hit.id || '').trim() : '')
    setSbRenderOpen(false)
    setSbOpen(true)
    void runStoryboardOpenChecks()
  }

  // 摆放属性卡「管理姿势变体…」与画布双击都走这里——保持原匹配口径（category=character 且按 projectCharacterId / name 命中），解析出计划资产 id 后走通用打开器。
  async function openPoseVariantManagerForCharacter(characterIdRaw: string) {
    if (!doc.project || !doc.story || doc.mode !== 'project') return
    const characterId = String(characterIdRaw || '').trim()
    const ch = (doc.project.characters || []).find((x) => x.id === characterId) || null
    if (!ch) return
    // 与通用打开器同源的计划数据（同一 tick 内 init 的异步回填尚未反映到 ref，此处语义与原实现一致）
    const plan = sbPosePlanRef.current || readStoryboardAssetPlanFromProject(doc.project)
    const planAssets = Array.isArray((plan as any)?.assets) ? (plan as any).assets : []
    const hit = planAssets.find((a: any) =>
      String(a?.category || '') === 'character' &&
      (String(a?.projectCharacterId || '').trim() === characterId || String(a?.name || '').trim() === String(ch.name || '').trim())
    ) || null
    await openAssetLockInWizard({ planAssetId: hit ? String(hit.id || '').trim() : '' })
  }

  async function generateCharacterGreen() {
    if (doc.mode !== 'project') return
    setChBusy(true)
    setChError('')
    try {
      const res = await generateCharacterSpriteAi(doc.id, {
        // 2026-09-01 身份锁定：传 characterId，服务端取该角色锁定主参考走 IPAdapter（纯文本指纹实测会丢角色：猪变人类少年）
        characterId: String(chTargetRef.current?.characterId || '').trim() || undefined,
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

  // 2026-09-01 抽卡池共用核心：抠图（RMBG 优先，chroma key 回退）→ 建/覆盖资产 → 写回角色/摆放。
  // sharedWithCharacter 保护语义必须保留：摆放与角色默认/锁定主参考共用资产时严禁覆盖，只能新建姿势资产。
  async function applyTransparentCore(args: {
    target: { kind: 'character' | 'placement'; characterId: string; nodeId?: string; placementId?: string }
    greenAssetPath: string
    greenUrl: string
    provider: string
    draft: AiCharacterSpriteDraft
    onPreview?: (url: string) => void
  }): Promise<'character' | 'placement' | null> {
    if (doc.mode !== 'project' || !doc.project || !doc.story) return null
    const { target, draft } = args
    const ch = (doc.project.characters || []).find((x) => x.id === target.characterId) || null

    // 2026-09-01 优先走服务端 RMBG 语义分割抠图（按颜色抠图对衣服撞色/渐变底完全不可控，实测衣服被挖穿）。
    // 失败（如 ComfyUI 未配置 / RMBG 不可用）回退前端 chroma key。
    let nextUri = ''
    let previewUrl = ''
    let blobPreviewUrl = ''
    const greenAssetPath = String(args.greenAssetPath || '').trim()
    if (greenAssetPath) {
      try {
        const cut = await cutoutCharacterSpriteAi(String(doc.project.id), greenAssetPath)
        nextUri = cut.url ? resolveUrl(cut.url) : cut.assetPath
        previewUrl = nextUri
      } catch (_) {
        nextUri = ''
      }
    }
    if (!nextUri) {
      const matte = await chromaKeyUrlToPng(args.greenUrl, {
        threshold: Number(draft.keyThreshold || 80),
        feather: Number(draft.keyFeather || 40),
        crop: Boolean(draft.crop),
        padding: Number(draft.padding || 12)
      })
      blobPreviewUrl = URL.createObjectURL(matte.blob)
      const safeName = String(ch?.name || ch?.id || 'character').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]+/g, '_').slice(0, 24) || 'character'
      const fileName = `${safeName}_${Date.now()}.png`
      const file = new File([matte.blob], fileName, { type: 'image/png' })
      const uploaded = await uploadProjectImage(String(doc.project.id), file)
      nextUri = uploaded.url ? resolveUrl(uploaded.url) : uploaded.assetPath
      previewUrl = blobPreviewUrl
    }

    if (args.onPreview) args.onPreview(previewUrl)

    const usedPrompt = [String(draft.globalPrompt || '').trim(), String(draft.fingerprintPrompt || '').trim(), String(draft.posePrompt || '').trim()]
      .filter(Boolean)
      .join('，')
      .slice(0, 1800)
    const provider = String(args.provider || '') as any

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
      return 'character'
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
      // 2026-09-01 修复：摆放与角色默认/锁定主参考共用资产时严禁覆盖（此前把猪老大主参考覆盖成废图）。
      // 只有摆放已持有独立的姿势资产时才原位覆盖，否则一律新建资产。
      const sharedWithCharacter =
        existingId &&
        (existingId === String(ch?.imageAssetId || '').trim() ||
          existingId === String((ch?.ai as any)?.referenceAssetId || '').trim())
      const assetId =
        existing && !sharedWithCharacter
          ? applyToAsset(existingId)
          : createAsset(`AI 姿势 ${nodeName} · ${ch?.name || ch?.id || ''}`.trim() || 'AI 姿势')

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
      return 'placement'
    }
    return null
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
      const kind = await applyTransparentCore({
        target,
        greenAssetPath: String(chGreen && chGreen.assetPath ? chGreen.assetPath : '').trim(),
        greenUrl,
        provider: chGreen && chGreen.provider ? String(chGreen.provider) : '',
        draft: chDraft,
        onPreview: (url) => {
          try {
            const u0 = String(chTransparentPreviewUrl || '').trim()
            if (u0.startsWith('blob:')) URL.revokeObjectURL(u0)
          } catch {}
          setChTransparentPreviewUrl(url)
        }
      })
      if (kind === 'character') setToast('已生成透明 PNG 并应用到角色')
      else if (kind === 'placement') setToast('已生成透明 PNG 并应用到该摆放（覆盖）')
    } catch (e) {
      setChError(e instanceof Error ? e.message : String(e))
    } finally {
      setChBusy(false)
    }
  }

  // ===== 2026-09-01 姿势变体操作（出图统一管理在锁定向导；全部串行：本地 ComfyUI/OMLX 资源互斥，禁止并行）=====

  type PoseGenOpts = {
    posePrompt: string
    posePromptZh?: string
    posePromptEn?: string
    negativePromptZh?: string
    negativePromptEn?: string
    ipadapter?: { enabled: boolean; weight: number; startAt: number; endAt: number }
    // 2026-09-10 剧情姿势需求：候选回写需求 id，用于"该需求已出候选"标记与批量去重
    reqId?: string
  }

  // 计划资产补丁统一入口：内存 sbAssetPlan + project.json 副本 + plan.json（persist 端点）三处一致。
  // 读 sbPosePlanRef（渲染期镜像）而非闭包 sbAssetPlan，串行抽卡时不会丢前一张候选。
  async function patchStoryboardPoseAsset(assetId: string, updater: (asset: any) => any): Promise<any | null> {
    const plan = normalizeStoryboardAssetPlan(sbPosePlanRef.current) || readStoryboardAssetPlanFromProject(doc.project)
    if (!plan) {
      setSbError('尚未生成资产计划')
      return null
    }
    let patched: any = null
    const nextPlan = {
      ...plan,
      assets: (Array.isArray(plan.assets) ? plan.assets : []).map((a: any) => {
        if (String(a?.id || '').trim() !== assetId) return a
        patched = updater(a)
        return patched
      })
    }
    if (!patched) {
      setSbError('未找到对应的角色资产')
      return null
    }
    sbPosePlanRef.current = nextPlan as any
    setSbAssetPlan(nextPlan as any)
    persistStoryboardAssetPlan(nextPlan as any, '')
    if (doc.mode === 'project' && doc.id) {
      try {
        const res = await persistStoryAssetPlanAi(doc.id, { plan: nextPlan as any })
        // 2026-09-03 采信服务端返回的最新 _rev：plan/persist 会在服务端递增版本号，
        // 不采信则外部更新检测横幅把"自己刚才的保存"误报成外部更新（实测假阳性）
        const srvRev = Number((res as any) && (res as any)._rev) || 0
        if (srvRev > 0) setDocProject((p) => ({ ...p, _rev: srvRev } as any))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setSbError(`姿势变体计划保存失败：${msg}`)
        appendSbLog(`姿势变体计划保存失败：${msg}`)
      }
    }
    return patched
  }

  function poseCharacterForAsset(asset: any): CharacterV1 | null {
    const pid = String(asset?.projectCharacterId || '').trim()
    const chs = doc.project?.characters || []
    return (pid && chs.find((c) => c.id === pid)) || chs.find((c) => String(c.name || '').trim() === String(asset?.name || '').trim()) || null
  }

  function findPosePlanAsset(assetId: string): any | null {
    const plan = normalizeStoryboardAssetPlan(sbPosePlanRef.current) || readStoryboardAssetPlanFromProject(doc.project)
    return (Array.isArray(plan?.assets) ? plan!.assets : []).find((a: any) => String(a?.id || '').trim() === assetId) || null
  }

  // 2026-09-02 姿势草稿持久化：向导五个时机（剧情生成完成/场景预填/抽卡点击/切场景/高级参数变更）落 plan 资产 poseDraft
  // 2026-09-10 姿势草稿手动翻译：姿势区缺「中文转英文」按钮，手改中文后旧英文会被生成链优先采用（en || zh）。
  // 返回译稿由向导侧走填充保护（覆盖确认+可恢复），不在这里直写。
  async function runStoryboardPoseDraftTranslate(assetId: string): Promise<string | null> {
    if (doc.mode !== 'project' || !doc.project) return null
    if (sbPosePromptBusyId || sbPoseGeneratingId || sbPoseReviewingId || sbPoseLockingKey || sbAssetPlanBusy) return null
    const asset = findPosePlanAsset(assetId)
    if (!asset) {
      setSbError('未找到对应的角色资产')
      return null
    }
    const zh = String((asset as any)?.poseDraft?.promptZh || '').trim()
    if (!zh) {
      setSbError('中文栏为空，无法翻译')
      return null
    }
    setSbError('')
    setSbPosePromptBusyId(assetId)
    appendSbLog(`姿势草稿中文转英文开始：${String(asset?.name || assetId)}（${zh.length} 字）`)
    try {
      const res = await translateStoryboardPromptText(doc.id, { text: zh, sourceLang: 'zh', targetLang: 'en', mode: 'prompt', timeoutMs: 60_000 })
      const en = String(res.result?.translatedText || '').trim()
      if (!en) throw new Error('empty_translation')
      appendSbLog('姿势草稿翻译完成')
      return en
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`姿势草稿翻译失败：${msg}`)
      return null
    } finally {
      setSbPosePromptBusyId('')
    }
  }

  async function runStoryboardPoseDraftSave(
    assetId: string,
    draft: { promptZh: string; promptEn: string; negativePromptZh: string; negativePromptEn: string; sceneId: string; ipadapterOn: boolean; ipadapterWeight: number; ipadapterStartAt: number; ipadapterEndAt: number; promptZhSource?: string }
  ) {
    if (doc.mode !== 'project' || !doc.project) return
    await patchStoryboardPoseAsset(assetId, (a) => ({
      ...a,
      poseDraft: {
        promptZh: String(draft.promptZh || ''),
        promptEn: String(draft.promptEn || ''),
        negativePromptZh: String(draft.negativePromptZh || ''),
        negativePromptEn: String(draft.negativePromptEn || ''),
        sceneId: String(draft.sceneId || ''),
        ipadapterOn: Boolean(draft.ipadapterOn),
        ipadapterWeight: Number(draft.ipadapterWeight) || 0.8,
        ipadapterStartAt: Number(draft.ipadapterStartAt) || 0.2,
        ipadapterEndAt: Number(draft.ipadapterEndAt) || 0.9,
        promptZhSource: String(draft.promptZhSource || '')
      }
    }))
  }

  // 单次生成 1 张姿势候选并写进 plan 资产 poseCandidates（忙态由调用方管理，供 生成1张/再出4张/单张重抽 复用）
  async function runStoryboardPoseGenerateOne(assetId: string, opts: PoseGenOpts) {
    if (doc.mode !== 'project' || !doc.project) throw new Error('项目未打开')
    const asset = findPosePlanAsset(assetId)
    if (!asset) throw new Error('未找到对应的角色资产')
    const ch = poseCharacterForAsset(asset)
    const dims = stageDims()
    // 指纹优先角色设定，回退计划资产锚点词（与此前摆放抽卡池同款回退链）
    const fp = String((ch?.ai as any)?.fingerprintPrompt || '').trim() || String(asset?.anchorPrompt || '').trim() || String(asset?.name || assetId).trim()
    // 2026-09-02 姿势负向：草稿负向优先于角色/资产负向；中文稿在生成时翻译（sprite 端点只翻正向姿势词；串行守 KV 护栏）
    const negZh = String(opts.negativePromptZh || '').trim()
    let negEn = String(opts.negativePromptEn || '').trim()
    if (!negEn && negZh) {
      try {
        const tr = await translateStoryboardPromptText(doc.id, { text: negZh, sourceLang: 'zh', targetLang: 'en', mode: 'prompt', timeoutMs: 60_000 })
        negEn = String(tr?.result?.translatedText || '').trim()
      } catch (_) { /* 翻译失败则负向中文原样下发（端点仍拼接内置 negBase 兜底） */ }
    }
    const negPose = negEn || negZh
    const negBaseCh = String((ch?.ai as any)?.negativePrompt || '').trim() || String(asset?.negativePrompt || '').trim()
    const neg = [negPose, negBaseCh].filter(Boolean).join(', ')
    const res = await generateCharacterSpriteAi(doc.id, {
      // 与单发流程同款身份锁定：传 characterId，服务端解析锁定主参考
      characterId: String(ch?.id || '').trim() || undefined,
      // 画风常量，不用世界锚点（锚点里的山谷/城市会把生成带成场景图，2026-09-01 实测）
      globalPrompt: 'cartoon fairy tale picture book style, flat 2D illustration, bold clean outlines, cel shading, warm soft color palette',
      fingerprintPrompt: fp,
      posePrompt: String(opts.posePrompt || '').trim(),
      negativePrompt: neg,
      style: String(sbReq.style || 'picture_book'),
      width: dims.w,
      height: dims.h,
      steps: Number(sbReq.steps || 20),
      cfgScale: Number(sbReq.cfgScale || 7),
      // 高级参数：IPAdapter 开启时以 body.ipadapter 强制走主参考锚定链（覆盖 env 默认 off）
      ipadapter: opts.ipadapter && opts.ipadapter.enabled ? opts.ipadapter : undefined
    })
    const assetPath = String(res.assetPath || '').trim()
    if (!assetPath) throw new Error('生成失败：服务端未返回 assetPath')
    const promptZh = String(opts.posePromptZh || '').trim()
    const promptEn = String(opts.posePromptEn || '').trim()
    // 负向英文稿是生成时翻译产物：回填进 poseDraft（追溯/复用）并随候选记录
    if (negEn && negEn !== String(opts.negativePromptEn || '').trim()) {
      await patchStoryboardPoseAsset(assetId, (a) => ({ ...a, poseDraft: { ...(a.poseDraft || {}), negativePromptEn: negEn } }))
    }
    await patchStoryboardPoseAsset(assetId, (a) => ({
      ...a,
      poseCandidates: [
        ...(Array.isArray(a.poseCandidates) ? a.poseCandidates : []),
        // 2026-09-01 需求 3：候选记录 promptZh/promptEn，便于追溯与复用
        {
          assetPath,
          posePrompt: String(opts.posePrompt || '').trim(),
          ...(promptZh ? { promptZh } : {}),
          ...(promptEn ? { promptEn } : {}),
          ...(negPose ? { negativePrompt: negPose } : {}),
          ...(String(opts.reqId || '').trim() ? { reqId: String(opts.reqId || '').trim() } : {}),
          createdAt: new Date().toISOString()
        }
      ]
    }))
  }

  // ============ 2026-09-10 剧情姿势需求（AI 提取候选 → 逐条手改 → 单个/批量手动生成） ============
  const [sbPoseReqBusyId, setSbPoseReqBusyId] = useState('')

  // 立绘只画角色本身（分层合成工艺：道具/地点由独立立绘摆位合成）——
  // 需求提示词里的共现资产名（瓶子/石子/草地等）必须剔除并进负向，否则模型会把道具画进角色立绘污染抠图。
  function buildPosePropVocab(plan: any, selfAssetId: string): { zh: string[]; en: string[] } {
    const zh = new Set<string>()
    const en = new Set<string>()
    for (const a of (Array.isArray(plan?.assets) ? plan.assets : [])) {
      const id = String(a?.id || '').trim()
      if (!id || id === selfAssetId) continue
      const terms = [a?.name, ...(Array.isArray(a?.aliases) ? a.aliases : [])]
      for (const t0 of terms) {
        const t = String(t0 || '').trim()
        if (t.length < 2) continue
        if (/^[\x20-\x7E]+$/.test(t)) en.add(t)
        else zh.add(t)
      }
    }
    // 计划级禁用替代物（EN）：同为立绘负向排除词
    for (const f of (Array.isArray(plan?.forbiddenSubstitutes) ? plan.forbiddenSubstitutes : [])) {
      const t = String(f || '').trim()
      if (t && /^[\x20-\x7E]+$/.test(t)) en.add(t)
    }
    const byLenDesc = (x: string, y: string) => y.length - x.length
    return { zh: Array.from(zh).sort(byLenDesc), en: Array.from(en).sort(byLenDesc) }
  }

  // 生成层净化：剔除道具/地点词（返回被剔词供负向与 UI 明示）；显示层保留剧情原文
  function sanitizePosePromptForSprite(text: string, vocab: { zh: string[]; en: string[] }): { clean: string; stripped: string[] } {
    let out = String(text || '')
    const stripped: string[] = []
    for (const term of [...vocab.zh, ...vocab.en]) {
      if (!term) continue
      if (out.includes(term)) {
        out = out.split(term).join('')
        stripped.push(term)
      }
    }
    // 2026-09-10 走查实测补充：场景状语「在烈日下/在湖面上/在草丛中…」会把立绘生成带成场景图
    // （"在烈日下艰难飞翔"把太阳与水面倒影画进了立绘）——道具词表之外的确定性剥离
    out = out.replace(/在[^，,、；;]{1,12}[下上里中内]/g, '，')
    out = out
      .replace(/[，,、\s]{2,}/g, '，')
      .replace(/^[，,、的了和与及跟\s]+|[，,、的了和与及跟\s]+$/g, '')
      .trim()
    return { clean: out, stripped }
  }

  const POSE_SPRITE_ONLY_PREFIX = '仅画角色本身，纯白背景，不含道具与场景'

  function buildPoseRequirementFromState(scene: any, st: any, vocab: { zh: string[]; en: string[] }) {
    const poseClean = sanitizePosePromptForSprite(st?.pose, vocab)
    const actionClean = sanitizePosePromptForSprite(st?.action, vocab)
    const parts = [poseClean.clean, st.view ? `${String(st.view).trim()}视角` : '', actionClean.clean, st.expression].map((x) => String(x || '').trim()).filter(Boolean)
    return {
      reqId: `${String(scene?.sceneId || '').trim()}::${String(st?.characterId || '').trim()}`,
      sceneId: String(scene?.sceneId || '').trim(),
      sceneName: String(scene?.sceneName || scene?.sceneId || '').trim(),
      characterId: String(st?.characterId || '').trim(),
      pose: String(st?.pose || '').trim(),
      view: String(st?.view || '').trim(),
      action: String(st?.action || '').trim(),
      expression: String(st?.expression || '').trim(),
      excludedProps: Array.from(new Set([...poseClean.stripped, ...actionClean.stripped])),
      promptZh: [POSE_SPRITE_ONLY_PREFIX, ...parts].join('，'),
      promptEn: '',
      createdAt: new Date().toISOString()
    }
  }

  async function runStoryboardPoseRequirementsExtract(assetId: string) {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbPoseReqBusyId || sbPoseGeneratingId || sbPoseReviewingId || sbPoseLockingKey || sbAssetPlanBusy) return
    const asset = findPosePlanAsset(assetId)
    if (!asset) {
      setSbError('未找到对应的角色资产')
      return
    }
    const label = String(asset?.name || assetId).trim() || assetId
    setSbError('')
    setSbPoseReqBusyId(assetId)
    appendSbLog(`剧情姿势需求提取开始：${label}（AI 读取全故事场景×出场表，候选制）`)
    try {
      const res = await extractStoryPoseStatesAi(doc.id)
      const planForVocab = normalizeStoryboardAssetPlan(sbPosePlanRef.current) || readStoryboardAssetPlanFromProject(doc.project)
      const { reqs, error } = mapPoseExtractionForAsset(res, planForVocab, assetId)
      if (error) throw new Error(error)
      // 2026-10-06 表情差分需求（expr:: 前缀）是手工/快捷播种的，重提剧情姿势时保留不覆盖
      const preservedExpr = (Array.isArray(asset.poseRequirements) ? asset.poseRequirements : []).filter((r: any) => String(r?.reqId || '').startsWith('expr::'))
      await patchStoryboardPoseAsset(assetId, (a) => ({ ...a, poseRequirements: [...reqs, ...preservedExpr] }))
      appendSbLog(`剧情姿势需求提取完成：${label} / ${reqs.length} 条（逐条可改，单个生成或批量生成）`)
      setToast(`已提取 ${reqs.length} 条剧情姿势需求`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`剧情姿势需求提取失败：${label} - ${msg}`)
    } finally {
      setSbPoseReqBusyId('')
    }
  }

  // 2026-10-06 简谱演绎·表情差分：聚合剧情姿势需求里的 distinct 表情，播种「仅换表情」差分需求
  // （reqId=expr::{expression}，无场景绑定；候选锁定默认名「表情·X」，摆位按本场景剧情表情自动选用）。
  // 复用现有 生成/评分/抠图/锁定 全链，不新增服务端通道。
  async function runStoryboardExpressionRequirements(assetId: string) {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbPoseReqBusyId || sbPoseGeneratingId || sbPoseReviewingId || sbPoseLockingKey || sbAssetPlanBusy) return
    const asset = findPosePlanAsset(assetId)
    if (!asset) {
      setSbError('未找到对应的角色资产')
      return
    }
    const label = String(asset?.name || assetId).trim() || assetId
    const existing = Array.isArray(asset.poseRequirements) ? asset.poseRequirements : []
    const storyExprs = Array.from(new Set(existing.map((r: any) => String(r?.expression || '').trim()).filter(Boolean)))
    const exprs = (storyExprs.length ? storyExprs : ['开心', '难过', '惊讶']).slice(0, 8)
    const existingReqIds = new Set(existing.map((r: any) => String(r?.reqId || '')))
    const newReqs = exprs
      .filter((expr) => !existingReqIds.has(`expr::${expr}`))
      .map((expr) => ({
        reqId: `expr::${expr}`,
        sceneId: '',
        sceneName: '通用（表情差分）',
        characterId: String(asset.id || '').trim(),
        pose: '',
        view: '正面',
        action: '',
        expression: expr,
        excludedProps: [],
        promptZh: `${POSE_SPRITE_ONLY_PREFIX}，中性站姿正面，${expr}表情，神态特写`,
        promptEn: '',
        createdAt: new Date().toISOString()
      }))
    if (!newReqs.length) {
      setToast('表情差分需求已覆盖全部剧情表情')
      return
    }
    setSbError('')
    setSbPoseReqBusyId(assetId)
    appendSbLog(`表情差分需求播种：${label} / 新增 ${newReqs.length} 条（${newReqs.map((r) => r.expression).join('、')}）——仅换表情不换姿势，锁定后摆位按剧情表情自动选用`)
    try {
      await patchStoryboardPoseAsset(assetId, (a) => ({
        ...a,
        poseRequirements: [...(Array.isArray(a.poseRequirements) ? a.poseRequirements : []), ...newReqs]
      }))
      setToast(`已播种 ${newReqs.length} 条表情差分需求`)
    } finally {
      setSbPoseReqBusyId('')
    }
  }

  // ============ 2026-09-16 道具状态变体（道具/地点等非角色资产专属）：AI 提取状态需求 → 单状态生成全链（服务端写 stateVariants） ============
  const [sbPropStateBusyId, setSbPropStateBusyId] = useState('')
  const [sbPropStateGenKey, setSbPropStateGenKey] = useState('')

  async function runStoryboardPropStatesExtract(assetId: string) {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbPropStateBusyId || sbPropStateGenKey || sbPoseGeneratingId || sbPoseReviewingId || sbPoseLockingKey || sbAssetPlanBusy) return
    const asset = findPosePlanAsset(assetId)
    if (!asset) {
      setSbError('未找到对应的事物资产')
      return
    }
    const label = String(asset?.name || assetId).trim() || assetId
    setSbError('')
    setSbPropStateBusyId(assetId)
    appendSbLog(`剧情状态需求提取开始：${label}（AI 读取全故事场景，候选制）`)
    try {
      const res = await extractStoryPropStatesAi(doc.id)
      const { states, usages, mergeInfo, error } = mapPropExtractionForAsset(res, assetId)
      if (error) throw new Error(`${error}，可重试提取`)
      // 持久化链与 poseRequirements 同款：patchStoryboardPoseAsset → 内存计划 + project.json 副本 + plan.json persist（merge 保留其他字段）
      await patchStoryboardPoseAsset(assetId, (a) => ({
        ...a,
        stateRequirements: mergeInfo ? [] : states,
        sceneUsages: usages,
        stateMergeInto: mergeInfo,
        stateCheckedAt: new Date().toISOString()
      }))
      if (mergeInfo) {
        appendSbLog(`剧情状态需求提取完成：${label} 已并入 ${mergeInfo.containerName}`)
        setToast(`已并入 ${mergeInfo.containerName}，本事物不再单独出状态图`)
      } else if (states.length === 0) {
        appendSbLog(`剧情状态需求提取完成：${label} 无视觉状态变化`)
        setToast('该事物在剧情中无视觉状态变化')
      } else {
        appendSbLog(`剧情状态需求提取完成：${label} / ${states.length} 条`)
        setToast(`已提取 ${states.length} 条状态需求`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`剧情状态需求提取失败：${label} - ${msg}`)
    } finally {
      setSbPropStateBusyId('')
    }
  }

  // ============ 2026-10-06 第 3 步场景视图：跨场景姿态/状态批量分析 ============
  // 提取结果→资产挂载的纯映射辅助（单资产提取与批量分析共用，防两路径漂移）
  function mapPoseExtractionForAsset(res: any, planForVocab: any, assetId: string): { reqs: any[]; error?: string } {
    const charId = Object.keys(res?.assetByCharacterId || {}).find((cid) => String(res.assetByCharacterId[cid]?.assetId || '').trim() === assetId)
    if (!charId) return { reqs: [], error: '该资产未在剧情姿势映射中（非角色资产或未入资产计划）' }
    const vocab = buildPosePropVocab(planForVocab, assetId)
    const reqs: any[] = []
    for (const scene of (Array.isArray(res?.poseStates?.scenes) ? res.poseStates.scenes : [])) {
      for (const st of (Array.isArray(scene?.characterStates) ? scene.characterStates : [])) {
        if (String(st?.characterId || '').trim() !== charId) continue
        reqs.push(buildPoseRequirementFromState(scene, st, vocab))
      }
    }
    if (!reqs.length) return { reqs: [], error: 'AI 未提取到该角色的剧情姿势状态' }
    return { reqs }
  }

  function mapPropExtractionForAsset(res: any, assetId: string): { states: any[]; usages: any[]; mergeInfo: any | null; error?: string } {
    const props0 = Array.isArray(res?.propStates?.props) ? res.propStates.props : []
    // bible propId 与计划资产同 id 直接对应；兜底走 assetByPropId 映射反查
    let hit = props0.find((p: any) => String(p?.propId || '').trim() === assetId) || null
    if (!hit) {
      const mappedId = Object.keys(res?.assetByPropId || {}).find((pid) => String(res.assetByPropId[pid]?.assetId || '').trim() === assetId)
      if (mappedId) hit = props0.find((p: any) => String(p?.propId || '').trim() === mappedId) || null
    }
    if (!hit) return { states: [], usages: [], mergeInfo: null, error: 'AI 未提取到该事物的状态信息（可能未在剧情中出场）' }
    const states = (Array.isArray(hit.states) ? hit.states : [])
      .map((s: any) => ({
        stateKey: String(s?.stateKey || '').trim(),
        label: String(s?.label || s?.stateKey || '').trim(),
        description: String(s?.description || '').trim(),
        sceneIds: (Array.isArray(s?.sceneIds) ? s.sceneIds : []).map((x: any) => String(x || '').trim()).filter(Boolean)
      }))
      .filter((s: any) => s.stateKey)
    // 2026-10-06 导演全量分析：每场景使用/呈现方式（展示+提示词参考，不驱动变体生成）
    const usages = (Array.isArray(hit.appearances) ? hit.appearances : [])
      .map((a: any) => ({
        sceneId: String(a?.sceneId || '').trim(),
        usage: String(a?.usage || '').trim(),
        note: String(a?.note || '').trim(),
        evidence: String(a?.evidence || '').trim()
      }))
      .filter((a: any) => a.sceneId && a.usage)
    const mergeRaw = hit.mergeInto && typeof hit.mergeInto === 'object' ? hit.mergeInto : null
    const containerId = String(mergeRaw?.containerPropId || '').trim()
    const containerAsset = containerId ? findPosePlanAsset(containerId) : null
    const containerName = containerId
      ? (String(res?.assetByPropId?.[containerId]?.assetName || '').trim() || String(containerAsset?.name || '').trim() || containerId)
      : ''
    const mergeInfo = containerId ? { containerPropId: containerId, containerName, note: String(mergeRaw?.note || '').trim() } : null
    return { states, usages, mergeInfo }
  }

  const [sbSceneAnalysisBusy, setSbSceneAnalysisBusy] = useState(false)
  const [sbSceneAnalysisStage, setSbSceneAnalysisStage] = useState<'pose' | 'prop' | ''>('')
  const [sbSceneAnalysisStartedAt, setSbSceneAnalysisStartedAt] = useState(0)
  const [sbSceneAnalysisElapsedMs, setSbSceneAnalysisElapsedMs] = useState(0)

  // 分析计时器：长模型调用期间驱动向导进度行的"已用时"跳动（与 sbElapsedMs 同款模式）
  useEffect(() => {
    if (!sbSceneAnalysisBusy || sbSceneAnalysisStartedAt <= 0) {
      setSbSceneAnalysisElapsedMs(0)
      return
    }
    const t = window.setInterval(() => setSbSceneAnalysisElapsedMs(Date.now() - sbSceneAnalysisStartedAt), 200)
    return () => window.clearInterval(t)
  }, [sbSceneAnalysisBusy, sbSceneAnalysisStartedAt])

  // 一键分析全部事物的跨场景姿态/状态：提取端点本就是全故事一次提取，
  // 各调一次后逐资产挂载（角色 1 次 + 事物 1 次，比逐资产提取省 N-2 次模型调用）。
  // 2026-10-06 可观测：阶段状态 + 每阶段计时日志，长等待不再沉默。
  async function runStoryboardSceneElementAnalysis() {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbSceneAnalysisBusy || sbPoseReqBusyId || sbPropStateBusyId || sbPropStateGenKey || sbPoseGeneratingId || sbPoseReviewingId || sbPoseLockingKey || sbAssetPlanBusy) return
    const plan = normalizeStoryboardAssetPlan(sbPosePlanRef.current) || readStoryboardAssetPlanFromProject(doc.project)
    const assets = Array.isArray(plan?.assets) ? plan.assets : []
    if (!assets.length) {
      setSbError('尚无资产计划，请先生成资产计划')
      return
    }
    const labelOf = (a: any) => String(a?.name || a?.id || '').trim() || String(a?.id || '')
    setSbError('')
    setSbSceneAnalysisBusy(true)
    setSbSceneAnalysisStartedAt(Date.now())
    appendSbLog('跨场景姿态/状态分析开始（全故事姿势 1 次提取 + 事物状态 1 次提取，逐资产挂载）')
    const missed: string[] = []
    let poseMounted = 0
    let poseReqTotal = 0
    let propMounted = 0
    let stateTotal = 0
    let usageTotal = 0
    try {
      setSbSceneAnalysisStage('pose')
      appendSbLog('阶段 1/2：AI 提取全故事角色姿势（单次模型调用，本地模型可能需 1~3 分钟，请稍候）…')
      const poseStartedAt = Date.now()
      try {
        const poseRes = await extractStoryPoseStatesAi(doc.id)
        const mappedCount = Object.keys(poseRes?.assetByCharacterId || {}).length
        appendSbLog(`阶段 1/2 提取返回（耗时 ${((Date.now() - poseStartedAt) / 1000).toFixed(1)}s）：角色姿势映射 ${mappedCount} 个，逐资产挂载…`)
        for (const asset of assets) {
          const aid = String(asset?.id || '').trim()
          if (!aid || String(asset?.category || '') !== 'character') continue
          const { reqs, error } = mapPoseExtractionForAsset(poseRes, plan, aid)
          if (error) {
            missed.push(`${labelOf(asset)}（姿势）`)
            appendSbLog(`姿势分析未命中：${labelOf(asset)} - ${error}`)
            continue
          }
          const preservedExpr = (Array.isArray(asset.poseRequirements) ? asset.poseRequirements : []).filter((r: any) => String(r?.reqId || '').startsWith('expr::'))
          await patchStoryboardPoseAsset(aid, (a) => ({ ...a, poseRequirements: [...reqs, ...preservedExpr] }))
          poseMounted += 1
          poseReqTotal += reqs.length
        }
        appendSbLog(`阶段 1/2 挂载完成：${poseMounted} 个角色 / ${poseReqTotal} 条姿态`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        appendSbLog(`阶段 1/2 姿势提取失败（耗时 ${((Date.now() - poseStartedAt) / 1000).toFixed(1)}s）：${msg}`)
      }
      setSbSceneAnalysisStage('prop')
      appendSbLog('阶段 2/2：AI 提取事物跨场景视觉状态（单次模型调用）…')
      const propStartedAt = Date.now()
      try {
        const propRes = await extractStoryPropStatesAi(doc.id)
        const mappedCount = Object.keys(propRes?.assetByPropId || {}).length
        appendSbLog(`阶段 2/2 提取返回（耗时 ${((Date.now() - propStartedAt) / 1000).toFixed(1)}s）：事物映射 ${mappedCount} 个，逐资产挂载…`)
        for (const asset of assets) {
          const aid = String(asset?.id || '').trim()
          const cat = String(asset?.category || '')
          if (!aid || cat === 'character') continue
          const { states, usages, mergeInfo, error } = mapPropExtractionForAsset(propRes, aid)
          if (error) {
            missed.push(`${labelOf(asset)}（状态）`)
            appendSbLog(`状态分析未命中：${labelOf(asset)} - ${error}`)
            continue
          }
          await patchStoryboardPoseAsset(aid, (a) => ({
            ...a,
            stateRequirements: mergeInfo ? [] : states,
            sceneUsages: usages,
            stateMergeInto: mergeInfo,
            stateCheckedAt: new Date().toISOString()
          }))
          propMounted += 1
          stateTotal += states.length
          usageTotal += usages.length
        }
        appendSbLog(`阶段 2/2 挂载完成：${propMounted} 个事物 / ${stateTotal} 条状态 / ${usageTotal} 条场景使用方式`)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        appendSbLog(`阶段 2/2 事物状态提取失败（耗时 ${((Date.now() - propStartedAt) / 1000).toFixed(1)}s）：${msg}`)
      }
    } finally {
      setSbSceneAnalysisBusy(false)
      setSbSceneAnalysisStage('')
      setSbSceneAnalysisStartedAt(0)
    }
    const summary = `跨场景分析完成：角色 ${poseMounted} 个 / ${poseReqTotal} 条姿态，事物 ${propMounted} 个 / ${stateTotal} 条状态 / ${usageTotal} 条场景使用方式${missed.length ? `；未命中 ${missed.length}：${missed.join('、')}` : ''}`
    appendSbLog(summary)
    if (poseMounted + propMounted > 0) setToast(summary)
    else setSbError('未分析到任何姿态/状态：请确认 Story Bible 与资产计划已生成')
  }

  async function runStoryboardPropStateVariantGenerate(assetId: string, state: { stateKey: string; label: string; description?: string }) {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbPropStateBusyId || sbPropStateGenKey || sbPoseGeneratingId || sbPoseReviewingId || sbPoseLockingKey || sbAssetPlanBusy) return
    const asset = findPosePlanAsset(assetId)
    if (!asset) {
      setSbError('未找到对应的事物资产')
      return
    }
    const assetLabel = String(asset?.name || assetId).trim() || assetId
    const stateKey = String(state?.stateKey || '').trim()
    const stateLabel = String(state?.label || stateKey).trim()
    const description = String(state?.description || '').trim()
    if (!stateKey) {
      setSbError('该状态缺少标识，请重新提取状态需求')
      return
    }
    setSbError('')
    setSbPropStateGenKey(`${assetId}:${stateKey}`)
    appendSbLog(`状态变体生成开始：${assetLabel}·${stateLabel}（立绘→评审→抠图→登记，进度见任务条）`)
    try {
      const res = await generatePropStateVariantAi(doc.id, assetId, { stateKey, label: stateLabel, description })
      // 服务端已写 project.json（资产登记）与 plan.json（stateVariants 追加），三处对齐：
      // 1) 本地镜像资产追加（姿势变体锁定同款），保持内存与磁盘一致
      const cutoutPath = String(res.cutoutPath || '').trim()
      if (cutoutPath) {
        const projectAsset: AssetV1 = {
          id: String(res.projectAssetId || '').trim() || uid('asset'),
          kind: 'image',
          name: `AI 状态 ${assetLabel}·${stateLabel}`,
          uri: cutoutPath,
          source: { type: 'ai' as const, prompt: `同一个${assetLabel}，${description}`.slice(0, 1800), provider: 'comfyui' as any }
        }
        setDocProject((p) => ({ ...p, assets: [...(p.assets || []), projectAsset] }))
      }
      // 2) 计划真相从服务端重读（既有刷新方式：rebuild:false 读盘），拿到服务端写入的 stateVariants
      const freshPlan = normalizeStoryboardAssetPlan(await buildStoryAssetPlanAi(doc.id, { rebuild: false }))
      if (freshPlan) {
        setSbAssetPlan(freshPlan)
        persistStoryboardAssetPlan(freshPlan, '')
      }
      // 3) 采信服务端最新 _rev（生成链已递增版本号；不采信则外部更新横幅把"自己的生成"误报成外部更新）
      try {
        const cur = await getProject(doc.id)
        const srvRev = Number((cur as any)?.project?._rev || 0)
        if (srvRev > 0) setDocProject((p) => ({ ...p, _rev: srvRev } as any))
      } catch (_) { /* 取版本失败不阻断结果展示 */ }
      const scoreText = Number.isFinite(Number(res.score)) ? ` / 评分 ${Math.round(Number(res.score))} 分` : ''
      const reasonText = String(res.reason || '').trim()
      const unavailableText = String(res.reviewUnavailable || '').trim()
      appendSbLog(`状态变体生成完成：${assetLabel}·${stateLabel}${scoreText}${reasonText ? `（${reasonText.slice(0, 80)}）` : ''}${unavailableText ? ' / 评审不可用，请人工目检' : ''}`)
      setToast(unavailableText ? `已生成状态变体：${stateLabel}（评审不可用，请人工目检）` : `已生成状态变体：${stateLabel}${scoreText}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`状态变体生成失败：${assetLabel}·${stateLabel} - ${msg}`)
    } finally {
      setSbPropStateGenKey('')
    }
  }

  // 公共提示词库负向包（参考图纯净包/多视图排除包/通用负向包）的英文片段，组件级缓存（只读 GET，不耗模型）
  const poseLibNegRef = useRef<string[] | null>(null)
  async function poseLibraryNegativeEn(): Promise<string[]> {
    if (poseLibNegRef.current) return poseLibNegRef.current
    try {
      const entries = await listPromptLibrary()
      const wanted = new Set(['seed_neg_clutter', 'seed_neg_multiview', 'seed_neg_general'])
      const list = entries
        .filter((e) => wanted.has(e.id) && e.kind === 'negative')
        .map((e) => String(e.textEn || '').trim())
        .filter(Boolean)
      poseLibNegRef.current = list
      return list
    } catch (_) {
      return []
    }
  }

  // 需求 → 生成参数：英文稿缺失时先串行翻译（与姿势负向同款生成时翻译链）；负向/IPAdapter 沿用该资产姿势草稿设置。
  // 2026-09-10 立绘纯净防护：生成前再次净化中文稿（兼容净化前提取的旧需求），
  // 被剔道具词进中文负向、计划 EN 道具词表进英文负向——立绘只画角色本身，道具走独立立绘摆位。
  async function poseRequirementGenOpts(asset: any, req: any): Promise<PoseGenOpts> {
    const planForVocab = normalizeStoryboardAssetPlan(sbPosePlanRef.current) || readStoryboardAssetPlanFromProject(doc.project)
    const vocab = buildPosePropVocab(planForVocab, String(asset?.id || '').trim())
    const zhRaw = String(req?.promptZh || '').trim()
    const cleaned = sanitizePosePromptForSprite(zhRaw, vocab)
    const zh = cleaned.clean || zhRaw
    // 净化改变了中文稿时，需求里存的英文稿即失效（属于旧中文的翻译），必须重译——
    // 2026-09-10 实测：复用旧译稿把"scorching sun"带进正向，负向补强也压不住，又出了天空背景
    const zhChangedBySanitize = Boolean(cleaned.clean && cleaned.clean !== zhRaw)
    let en = String(req?.promptEn || '').trim()
    if (!en || zhChangedBySanitize) {
      try {
        const tr = await translateStoryboardPromptText(doc.id, { text: zh, sourceLang: 'zh', targetLang: 'en', mode: 'prompt', timeoutMs: 60_000 })
        en = String(tr?.result?.translatedText || '').trim()
      } catch (_) { /* 翻译失败则直接用中文稿下发（sprite 端点会再翻） */ }
    }
    const draft = (asset && (asset as any).poseDraft) || {}
    const negZhBase = String(draft.negativePromptZh || '').trim()
    const excludedZh = Array.from(new Set([...(Array.isArray(req?.excludedProps) ? req.excludedProps.map((x: any) => String(x || '').trim()).filter(Boolean) : []), ...cleaned.stripped]))
    const negZh = [negZhBase, ...excludedZh.filter((t) => t && !negZhBase.includes(t))].filter(Boolean).join('，')
    const negEnBase = String(draft.negativePromptEn || '').trim()
    const negEnExtra = vocab.en.filter((t) => t && !negEnBase.toLowerCase().includes(t.toLowerCase()))
    // 2026-09-10 走查实测补强：并入公共提示词库负向包（参考图纯净/多视图排除/通用）+ 倒影/多角色硬排除——
    // 首张候选被"烈日"带成天空+水面倒影场景图、且出现双鸟倒影，负向必须显式压住
    const libNeg = await poseLibraryNegativeEn()
    const hardExclusions = ['reflection', 'duplicate', 'second character', 'multiple characters', 'sky', 'sun', 'water surface']
    const negEnPool = [...negEnExtra, ...libNeg, ...hardExclusions].filter((t) => t && !negEnBase.toLowerCase().includes(String(t).toLowerCase()))
    const negEn = [negEnBase, ...negEnPool].filter(Boolean).join(', ')
    return {
      posePrompt: en || zh,
      posePromptZh: zh,
      posePromptEn: en,
      negativePromptZh: negZh,
      negativePromptEn: negEn,
      ipadapter: draft.ipadapterOn
        ? { enabled: true, weight: Number(draft.ipadapterWeight) || 0.8, startAt: Number(draft.ipadapterStartAt) || 0.2, endAt: Number(draft.ipadapterEndAt) || 0.9 }
        : undefined,
      reqId: String(req?.reqId || '').trim() || undefined
    }
  }

  // 英文稿是生成时翻译产物：回填进需求条目（追溯/复用）
  async function patchPoseRequirementPromptEn(assetId: string, reqId: string, promptEn: string) {
    const en = String(promptEn || '').trim()
    if (!en) return
    await patchStoryboardPoseAsset(assetId, (a) => ({
      ...a,
      poseRequirements: (Array.isArray(a.poseRequirements) ? a.poseRequirements : []).map((r: any) =>
        String(r?.reqId || '') === reqId && !String(r?.promptEn || '').trim() ? { ...r, promptEn: en } : r
      )
    }))
  }

  // 单个手动生成：按某一条需求出 1 张姿势候选
  async function runStoryboardPoseRequirementGenerate(assetId: string, reqId: string) {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbPoseGeneratingId || sbPoseReviewingId || sbPoseLockingKey || sbAssetPlanBusy || sbPoseReqBusyId) return
    const asset = findPosePlanAsset(assetId)
    const req = (Array.isArray(asset?.poseRequirements) ? asset.poseRequirements : []).find((r: any) => String(r?.reqId || '') === reqId)
    if (!asset || !req) {
      setSbError('未找到对应的剧情姿势需求')
      return
    }
    if (!String(req.promptZh || '').trim() && !String(req.promptEn || '').trim()) {
      setSbError('该需求提示词为空，请先填写')
      return
    }
    setSbError('')
    setSbPoseGeneratingId(assetId)
    setSbPoseDrawProgress({ done: 0, total: 1 })
    appendSbLog(`姿势需求单张生成：${String(asset?.name || assetId)} / ${String(req.sceneName || req.sceneId)}`)
    try {
      const opts = await poseRequirementGenOpts(asset, req)
      await runStoryboardPoseGenerateOne(assetId, opts)
      await patchPoseRequirementPromptEn(assetId, reqId, opts.posePromptEn || '')
      setToast('已生成 1 张姿势候选')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`姿势需求生成失败：${msg}`)
    } finally {
      setSbPoseGeneratingId('')
      setSbPoseDrawProgress(null)
    }
  }

  // 批量手动生成：一键按需求清单逐条串行出图（已有同需求候选的自动跳过；中断保留已出候选）
  async function runStoryboardPoseRequirementsBatchGenerate(assetId: string) {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbPoseGeneratingId || sbPoseReviewingId || sbPoseLockingKey || sbAssetPlanBusy || sbPoseReqBusyId) return
    const asset = findPosePlanAsset(assetId)
    if (!asset) {
      setSbError('未找到对应的角色资产')
      return
    }
    const label = String(asset?.name || assetId).trim() || assetId
    const reqs = (Array.isArray(asset?.poseRequirements) ? asset.poseRequirements : []).filter((r: any) => String(r?.promptZh || r?.promptEn || '').trim())
    const doneReqIds = new Set((Array.isArray(asset?.poseCandidates) ? asset.poseCandidates : []).map((c: any) => String(c?.reqId || '')).filter(Boolean))
    const todo = reqs.filter((r: any) => !doneReqIds.has(String(r?.reqId || '')))
    if (!todo.length) {
      setToast('全部剧情姿势需求已有候选')
      return
    }
    setSbError('')
    setSbPoseGeneratingId(assetId)
    setSbPoseDrawProgress({ done: 0, total: todo.length })
    appendSbLog(`姿势需求批量生成：${label} / ${todo.length} 条（串行）`)
    try {
      for (let i = 0; i < todo.length; i++) {
        setSbPoseDrawProgress({ done: i, total: todo.length })
        const req = todo[i]
        try {
          const cur = findPosePlanAsset(assetId)
          const opts = await poseRequirementGenOpts(cur, req)
          await runStoryboardPoseGenerateOne(assetId, opts)
          await patchPoseRequirementPromptEn(assetId, String(req.reqId || ''), opts.posePromptEn || '')
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          setSbError(msg)
          appendSbLog(`姿势需求批量生成中断：${String(req.sceneName || req.sceneId)} - ${msg}`)
          return
        }
        setSbPoseDrawProgress({ done: i + 1, total: todo.length })
      }
      appendSbLog(`姿势需求批量生成完成：${label} / ${todo.length} 条`)
      setToast(`已按需求生成 ${todo.length} 张姿势候选`)
    } finally {
      setSbPoseGeneratingId('')
      setSbPoseDrawProgress(null)
    }
  }

  async function runStoryboardPoseRequirementChange(assetId: string, reqId: string, patch: { promptZh?: string; promptEn?: string }) {
    await patchStoryboardPoseAsset(assetId, (a) => ({
      ...a,
      poseRequirements: (Array.isArray(a.poseRequirements) ? a.poseRequirements : []).map((r: any) =>
        String(r?.reqId || '') === reqId ? { ...r, ...(patch.promptZh != null ? { promptZh: String(patch.promptZh) } : {}), ...(patch.promptEn != null ? { promptEn: String(patch.promptEn) } : {}) } : r
      )
    }))
  }

  async function runStoryboardPoseRequirementDelete(assetId: string, reqId: string) {
    await patchStoryboardPoseAsset(assetId, (a) => ({
      ...a,
      poseRequirements: (Array.isArray(a.poseRequirements) ? a.poseRequirements : []).filter((r: any) => String(r?.reqId || '') !== reqId)
    }))
    setToast('已删除该条姿势需求')
  }

  async function runStoryboardPoseDraw(assetId: string, opts: PoseGenOpts, total: number) {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbPoseGeneratingId || sbPoseReviewingId || sbPoseLockingKey || sbAssetPlanBusy) return
    const asset = findPosePlanAsset(assetId)
    const label = String(asset?.name || assetId).trim() || assetId
    setSbError('')
    setSbPoseGeneratingId(assetId)
    setSbPoseDrawProgress({ done: 0, total })
    appendSbLog(`姿势变体抽卡开始：${label} / ${total} 张（串行）`)
    try {
      for (let i = 0; i < total; i++) {
        setSbPoseDrawProgress({ done: i, total })
        try {
          await runStoryboardPoseGenerateOne(assetId, opts)
        } catch (e) {
          // 串行中断：已出的张保留在候选中，错误提示给用户
          const msg = e instanceof Error ? e.message : String(e)
          setSbError(msg)
          appendSbLog(`姿势变体抽卡失败：${label} - ${msg}`)
          return
        }
        setSbPoseDrawProgress({ done: i + 1, total })
      }
      appendSbLog(`姿势变体抽卡完成：${label} / ${total} 张`)
      setToast(total > 1 ? `已出 ${total} 张姿势候选` : '已出 1 张姿势候选')
    } finally {
      setSbPoseGeneratingId('')
      setSbPoseDrawProgress(null)
    }
  }

  async function runStoryboardPoseReviewAll(assetId: string) {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbPoseGeneratingId || sbPoseReviewingId || sbPoseLockingKey || sbAssetPlanBusy) return
    const asset = findPosePlanAsset(assetId)
    if (!asset) {
      setSbError('未找到对应的角色资产')
      return
    }
    const label = String(asset?.name || assetId).trim() || assetId
    const ch = poseCharacterForAsset(asset)
    const characterId = String(ch?.id || '').trim()
    if (!characterId) {
      setSbError('该资产未关联项目角色，无法评分')
      return
    }
    const unscored = (Array.isArray(asset.poseCandidates) ? asset.poseCandidates : []).filter((c: any) => !Number.isFinite(Number(c?.score)))
    if (!unscored.length) {
      setToast('没有待评分的候选')
      return
    }
    setSbError('')
    setSbPoseReviewingId(assetId)
    appendSbLog(`姿势候选 AI 评分开始：${label} / ${unscored.length} 张（串行）`)
    try {
      for (const cand of unscored) {
        const path0 = String(cand?.assetPath || '').trim()
        if (!path0) continue
        const r = await reviewCharacterPoseAi(doc.id, { characterId, assetPath: path0 })
        await patchStoryboardPoseAsset(assetId, (a) => ({
          ...a,
          poseCandidates: (Array.isArray(a.poseCandidates) ? a.poseCandidates : []).map((x: any) =>
            String(x?.assetPath || '') === path0 ? { ...x, score: r.score, reason: r.reason } : x
          )
        }))
      }
      appendSbLog(`姿势候选 AI 评分完成：${label}`)
      setToast('姿势候选 AI 评分完成')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`姿势候选 AI 评分失败：${label} - ${msg}`)
    } finally {
      setSbPoseReviewingId('')
    }
  }

  async function runStoryboardPoseRedraw(assetId: string, assetPath: string, opts: PoseGenOpts) {
    if (doc.mode !== 'project' || !doc.project) return
    if (sbPoseGeneratingId || sbPoseReviewingId || sbPoseLockingKey || sbAssetPlanBusy) return
    setSbError('')
    setSbPoseGeneratingId(assetId)
    setSbPoseDrawProgress({ done: 0, total: 1 })
    try {
      await patchStoryboardPoseAsset(assetId, (a) => ({
        ...a,
        poseCandidates: (Array.isArray(a.poseCandidates) ? a.poseCandidates : []).filter((x: any) => String(x?.assetPath || '') !== assetPath)
      }))
      await runStoryboardPoseGenerateOne(assetId, opts)
      setToast('已重抽 1 张')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`姿势候选重抽失败：${msg}`)
    } finally {
      setSbPoseGeneratingId('')
      setSbPoseDrawProgress(null)
    }
  }

  async function runStoryboardPoseDeleteCandidate(assetId: string, assetPath: string) {
    if (sbPoseGeneratingId || sbPoseReviewingId || sbPoseLockingKey || sbAssetPlanBusy) return
    // 只删 plan 数组条目，候选文件留磁盘（可接受）
    await patchStoryboardPoseAsset(assetId, (a) => ({
      ...a,
      poseCandidates: (Array.isArray(a.poseCandidates) ? a.poseCandidates : []).filter((x: any) => String(x?.assetPath || '') !== assetPath)
    }))
    setToast('已删除候选')
  }

  // 命名锁定：RMBG 抠图 → 创建 project asset → 写 plan 资产 poseVariants（候选移出未锁定池）
  async function runStoryboardPoseLock(assetId: string, assetPath: string, name: string, prompts: { posePrompt: string; posePromptZh?: string; posePromptEn?: string }) {
    if (doc.mode !== 'project' || !doc.project || !doc.story) return
    if (sbPoseGeneratingId || sbPoseReviewingId || sbPoseLockingKey || sbAssetPlanBusy) return
    const asset = findPosePlanAsset(assetId)
    if (!asset) {
      setSbError('未找到对应的角色资产')
      return
    }
    const label = String(asset?.name || assetId).trim() || assetId
    const cand = (Array.isArray(asset.poseCandidates) ? asset.poseCandidates : []).find((x: any) => String(x?.assetPath || '') === assetPath) || null
    const lockName = String(name || '').trim() || `姿势 ${(Array.isArray(asset.poseVariants) ? asset.poseVariants.length : 0) + 1}`
    setSbError('')
    setSbPoseLockingKey(`${assetId}:${assetPath}`)
    appendSbLog(`姿势变体锁定开始：${label} / ${lockName}（RMBG 抠图）`)
    try {
      const cut = await cutoutCharacterSpriteAi(doc.id, assetPath)
      const cutoutPath = String(cut.assetPath || '').trim()
      if (!cutoutPath) throw new Error('抠图失败：服务端未返回 assetPath')
      const projectAssetId = uid('asset')
      const projectAsset: AssetV1 = {
        id: projectAssetId,
        kind: 'image',
        name: `AI 姿势 ${label}·${lockName}`,
        uri: cutoutPath,
        source: { type: 'ai' as const, prompt: String(prompts.posePrompt || '').trim().slice(0, 1800), provider: 'comfyui' as any }
      }
      setDocProject((p) => ({ ...p, assets: [...(p.assets || []), projectAsset] }))
      // 2026-09-01 需求 3：promptZh/promptEn 随姿势词写入变体记录（候选已有的优先，回退入参/旧 posePrompt）
      const variantZh = String(prompts.posePromptZh || cand?.promptZh || '').trim()
      const variantEn = String(prompts.posePromptEn || cand?.promptEn || '').trim()
      const variant = {
        id: uid('pose'),
        name: lockName,
        posePrompt: String(prompts.posePrompt || cand?.posePrompt || '').trim(),
        ...(variantZh ? { promptZh: variantZh } : {}),
        ...(variantEn ? { promptEn: variantEn } : {}),
        greenPath: assetPath,
        cutoutPath,
        projectAssetId,
        projectAssetUri: cutoutPath,
        score: Number.isFinite(Number(cand?.score)) ? Number(cand.score) : undefined,
        reason: String(cand?.reason || '').trim() || undefined,
        createdAt: new Date().toISOString()
      }
      await patchStoryboardPoseAsset(assetId, (a) => ({
        ...a,
        poseCandidates: (Array.isArray(a.poseCandidates) ? a.poseCandidates : []).filter((x: any) => String(x?.assetPath || '') !== assetPath),
        poseVariants: [...(Array.isArray(a.poseVariants) ? a.poseVariants : []), variant]
      }))
      appendSbLog(`姿势变体已锁定：${label} / ${lockName}`)
      setToast(`已锁定姿势变体：${lockName}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`姿势变体锁定失败：${label} - ${msg}`)
    } finally {
      setSbPoseLockingKey('')
    }
  }

  // 2026-09-01 剧情感知：该资产关联场景选项（场景 assetIds 含该角色 → story 节点，按剧情顺序编号）
  function poseSceneOptionsFor(assetId: string): { sceneId: string; label: string }[] {
    if (!doc.story) return []
    const asset = findPosePlanAsset(assetId)
    if (!asset) return []
    const plan = normalizeStoryboardAssetPlan(sbPosePlanRef.current) || readStoryboardAssetPlanFromProject(doc.project)
    const scenes = Array.isArray((plan as any)?.scenes) ? (plan as any).scenes : []
    // 2026-09-10 修复：plan.scenes[].assetIds 装的是"计划资产 id"（如 crow），
    // 原实现误拿 projectCharacterId（char_xxx）去匹配，恒为空 → 关联场景下拉永远「无关联场景」。
    const planAssetId = String(asset?.id || '').trim()
    const hitIds = scenes
      .filter((s: any) => (Array.isArray(s?.assetIds) ? s.assetIds : []).map((x: any) => String(x || '').trim()).includes(planAssetId))
      .map((s: any) => String(s?.sceneId || '').trim())
      .filter(Boolean)
    // 兜底：plan.scenes 缺失时用资产级 sceneIds（计划构建时已汇总 sceneRefs/摆位/文本三路来源）
    const effectiveIds = hitIds.length
      ? hitIds
      : (Array.isArray(asset?.sceneIds) ? asset.sceneIds.map((x: any) => String(x || '').trim()).filter(Boolean) : [])
    const out: { sceneId: string; label: string }[] = []
    const seen = new Set<string>()
    // 按 story 节点顺序编号（#N 与编辑器左栏场景序号一致）
    ;(doc.story.nodes || []).forEach((n, idx) => {
      const nid = String(n.id || '').trim()
      if (!nid || !effectiveIds.includes(nid) || seen.has(nid)) return
      seen.add(nid)
      const nn = ensureNode(n as any)
      const title = String((nn as any).body?.title || (nn as any).name || nid).trim()
      out.push({ sceneId: nid, label: `#${idx + 1} ${title}` })
    })
    return out
  }

  // 选中场景的节点正文（标题+文本摘要），作为「按剧情生成提示词」的剧情上下文
  function buildPoseSceneTextById(sceneId: string): string {
    if (!doc.story) return ''
    const sid = String(sceneId || '').trim()
    const n0 = (doc.story.nodes || []).find((n) => n.id === sid) || null
    const nn = n0 ? ensureNode(n0 as any) : null
    if (!nn) return ''
    const title = String((nn as any).body?.title || '').trim()
    const sum = buildNodeTextSummary(String((nn as any).body?.text || '').trim())
    return [title, sum].filter(Boolean).join('，').slice(0, 600)
  }

  // 2026-09-01 需求 1：按剧情生成姿势提示词（服务端中文稿→翻译英文稿）。
  // sceneId 选中场景的节点正文作为 sceneText；没有关联场景时回退现状逻辑（全部关联场景摘要拼接）。
  async function runStoryboardPoseAiPrompt(assetId: string, opts: { userHint: string; sceneId: string; reviewFeedback?: string }): Promise<{ promptZh: string; promptEn: string } | null> {
    if (doc.mode !== 'project' || !doc.project) return null
    if (sbPosePromptBusyId || sbPoseGeneratingId || sbPoseReviewingId || sbPoseLockingKey || sbAssetPlanBusy) return null
    const asset = findPosePlanAsset(assetId)
    if (!asset) {
      setSbError('未找到对应的角色资产')
      return null
    }
    const ch = poseCharacterForAsset(asset)
    const characterName = String(ch?.name || asset?.name || assetId).trim()
    // 指纹回退链（与生成同款）：角色 ai.fingerprintPrompt → 计划资产 anchorPrompt → 角色名
    const fp = String((ch?.ai as any)?.fingerprintPrompt || '').trim() || String(asset?.anchorPrompt || '').trim() || characterName
    const sceneText = buildPoseSceneTextById(opts?.sceneId) || buildPosePrefillForAsset(assetId)
    // 2026-09-10 实测修复（来源语义）：「按剧情生成」只把"用户亲手输入"的中文稿当额外要求传给模型；
    // AI/配方/需求回填的残留稿（promptZhSource!=='user'）不带——旧稿整段传入会被本地模型保留重生
    // （乌鸦场景产出"背身指向"无关姿势实证）。「按评语优化」路径保留当前稿作 hint（优化现有稿语义）。
    const isReviewOptimize = Boolean(String(opts?.reviewFeedback || '').trim())
    const draftSource = String((asset as any)?.poseDraft?.promptZhSource || '').trim()
    const effectiveHint = isReviewOptimize || draftSource === 'user' ? String(opts?.userHint || '').trim() : ''
    setSbError('')
    setSbPosePromptBusyId(assetId)
    appendSbLog(`按剧情生成姿势提示词开始：${characterName}（剧情上下文 ${sceneText.length} 字）`)
    try {
      const res = await generateCharacterPosePromptAi(doc.id, {
        characterName,
        fingerprintPrompt: fp,
        sceneText,
        userHint: effectiveHint,
        // 2026-09-02 评分反馈闭环：「按评语优化提示词」带评审理由
        reviewFeedback: String(opts?.reviewFeedback || '').trim() || undefined
      })
      if (!res.promptZh && !res.promptEn) throw new Error('服务端未返回提示词')
      appendSbLog(`按剧情生成姿势提示词完成：${characterName}（中 ${res.promptZh.length} 字 / 英 ${res.promptEn.length} 字符）`)
      setToast('已生成姿势提示词（中英文栏可继续编辑）')
      return res
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSbError(msg)
      appendSbLog(`按剧情生成姿势提示词失败：${characterName} - ${msg}`)
      return null
    } finally {
      setSbPosePromptBusyId('')
    }
  }

  // 删除已锁定变体：只删 plan 记录与 project asset 关联（文件留磁盘）；正被摆放引用时阻断（返回 message 由向导 div 弹窗展示）
  async function runStoryboardPoseDeleteVariant(assetId: string, variantId: string): Promise<{ ok: boolean; message?: string }> {
    if (doc.mode !== 'project' || !doc.project || !doc.story) return { ok: false, message: '项目未打开' }
    if (sbPoseGeneratingId || sbPoseReviewingId || sbPoseLockingKey || sbAssetPlanBusy) return { ok: false, message: '当前有生成/评分/锁定任务进行中，请稍候再删' }
    const asset = findPosePlanAsset(assetId)
    const variant = (Array.isArray(asset?.poseVariants) ? asset.poseVariants : []).find((v: any) => String(v?.id || '') === variantId) || null
    if (!variant) return { ok: false, message: '未找到该姿势变体' }
    const refAssetId = String(variant.projectAssetId || '').trim()
    const refNodes: string[] = []
    if (refAssetId) {
      // 2026-09-03 修复：引用检查改为先取服务端磁盘真相（用户实测：编辑器会话开着时，外部/旧内存的摆放数据会把删除误判成"仍被引用"，且旧会话保存会回滚外部修正）
      let storyNodes: any[] = doc.story.nodes || []
      try {
        const fresh = await getProject(String(doc.project.id))
        if (fresh && fresh.story && Array.isArray(fresh.story.nodes)) storyNodes = fresh.story.nodes
      } catch { /* 拉取失败回退内存数据 */ }
      for (const n of storyNodes) {
        const pls = Array.isArray((n as any).visuals?.placements) ? (n as any).visuals.placements : []
        if (pls.some((p: any) => String(p?.imageAssetId || '').trim() === refAssetId)) {
          refNodes.push(String((n as any).body?.title || (n as any).name || n.id).trim() || String(n.id))
        }
      }
    }
    if (refNodes.length) {
      return { ok: false, message: `「${String(variant.name || '姿势')}」正被 ${refNodes.length} 个摆放引用（${refNodes.slice(0, 3).join('、')}${refNodes.length > 3 ? ' 等' : ''}）。请先在摆放属性「图片（修改）」中改回「使用角色默认」或换成其他姿势，再删除。` }
    }
    if (refAssetId) setDocProject((p) => ({ ...p, assets: (p.assets || []).filter((a) => a.id !== refAssetId) }))
    await patchStoryboardPoseAsset(assetId, (a) => ({
      ...a,
      poseVariants: (Array.isArray(a.poseVariants) ? a.poseVariants : []).filter((v: any) => String(v?.id || '') !== variantId)
    }))
    appendSbLog(`姿势变体已删除：${String(asset?.name || assetId)} / ${String(variant.name || variantId)}`)
    setToast(`已删除姿势变体：${String(variant.name || '姿势')}`)
    return { ok: true }
  }

  // 2026-09-02 自定义姿势配方：存 project.state.aiBackground.customPoseRecipes（走既有 setDocProject 防抖保存；同名覆盖幂等）
  function saveCustomPoseRecipe(recipe: { name: string; promptZh: string; promptEn: string }) {
    if (doc.mode !== 'project' || !doc.project) return
    const name = String(recipe?.name || '').trim()
    if (!name) {
      setSbError('配方名称不能为空')
      return
    }
    setDocProject((p) => {
      const stateIn = (p as any).state && typeof (p as any).state === 'object' ? (p as any).state : {}
      const aiBgIn = stateIn.aiBackground && typeof stateIn.aiBackground === 'object' ? stateIn.aiBackground : {}
      const list = Array.isArray((aiBgIn as any).customPoseRecipes) ? (aiBgIn as any).customPoseRecipes : []
      const next = [
        ...list.filter((r: any) => String(r?.name || '').trim() !== name),
        { name, promptZh: String(recipe.promptZh || ''), promptEn: String(recipe.promptEn || ''), createdAt: new Date().toISOString() }
      ]
      return { ...p, state: { ...stateIn, aiBackground: { ...aiBgIn, customPoseRecipes: next } } }
    })
    setToast(`已存为配方：${name}`)
  }

  // 按场景预填：拼接该资产关联场景（场景 assetIds 含该计划资产 id）的文本摘要作为姿势需求初稿
  function buildPosePrefillForAsset(assetId: string): string {
    if (!doc.story) return ''
    const asset = findPosePlanAsset(assetId)
    if (!asset) return ''
    // 2026-09-10 修复：与 poseSceneOptionsFor 同一错配——assetIds 是计划资产 id 空间，不是 projectCharacterId
    const planAssetId = String(asset?.id || '').trim()
    const plan = normalizeStoryboardAssetPlan(sbPosePlanRef.current) || readStoryboardAssetPlanFromProject(doc.project)
    const scenes = Array.isArray((plan as any)?.scenes) ? (plan as any).scenes : []
    const hitSceneIds = scenes
      .filter((s: any) => (Array.isArray(s?.assetIds) ? s.assetIds : []).map((x: any) => String(x || '').trim()).includes(planAssetId))
      .map((s: any) => String(s?.sceneId || '').trim())
      .filter(Boolean)
    const effectiveIds = hitSceneIds.length
      ? hitSceneIds
      : (Array.isArray(asset?.sceneIds) ? asset.sceneIds.map((x: any) => String(x || '').trim()).filter(Boolean) : [])
    const parts: string[] = []
    for (const sid of effectiveIds.slice(0, 3)) {
      const n0 = (doc.story.nodes || []).find((n) => n.id === sid) || null
      const nn = n0 ? ensureNode(n0 as any) : null
      if (!nn) continue
      const title = String((nn as any).body?.title || '').trim()
      const sum = buildNodeTextSummary(String((nn as any).body?.text || '').trim())
      const t = [title, sum].filter(Boolean).join('，')
      if (t) parts.push(t)
    }
    return parts.join('；').slice(0, 400)
  }

  // 摆放属性「图片（修改）」下拉选项：该角色对应 plan 资产的已锁定姿势变体
  function poseVariantOptionsFor(characterIdRaw: string): { id: string; name: string }[] {
    const characterId = String(characterIdRaw || '').trim()
    if (!characterId) return []
    const chName = String((doc.project?.characters || []).find((c) => c.id === characterId)?.name || '').trim()
    const plan = sbAssetPlan || readStoryboardAssetPlanFromProject(doc.project)
    const planAssets = Array.isArray((plan as any)?.assets) ? (plan as any).assets : []
    const hit = planAssets.find((a: any) =>
      String(a?.category || '') === 'character' &&
      (String(a?.projectCharacterId || '').trim() === characterId || (chName && String(a?.name || '').trim() === chName))
    ) || null
    const variants = Array.isArray(hit?.poseVariants) ? hit.poseVariants : []
    return variants
      .filter((v: any) => String(v?.projectAssetId || '').trim())
      .map((v: any) => ({ id: String(v.projectAssetId).trim(), name: String(v?.name || '姿势').trim() }))
  }

  const problems = useMemo(() => {
    try {
      return validate(doc)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return [`配置格式错误：${msg}`]
    }
  }, [doc])

  const right = (
    <ComposeRightPanel
      doc={doc}
      selection={selection}
      setSelection={setSelection}
      setLeftTab={setLeftTab}
      busy={busy}
      error={error}
      rightFold={rightFold}
      toggleRightFold={toggleRightFold}
      setDocProject={setDocProject}
      setDocStory={setDocStory}
      activePlacementId={activePlacementId}
      setActivePlacementId={setActivePlacementId}
      bgRowSelected={bgRowSelected}
      setBgRowSelected={setBgRowSelected}
      placementPoseDraft={placementPoseDraft}
      setPlacementPoseDraft={setPlacementPoseDraft}
      bgFileRef={bgFileRef}
      pendingBgAssetIdRef={pendingBgAssetIdRef}
      placementPropsRef={placementPropsRef}
      blueprintLoaded={blueprintLoaded}
      blueprintNodeIdSet={blueprintNodeIdSet}
      nodeById={nodeById}
      nodes={nodes}
      effectivePreviewNode={effectivePreviewNode}
      rt={rt}
      setRt={setRt}
      setToast={setToast}
      sbAssetPlan={sbAssetPlan}
      chFpBusy={chFpBusy}
      chFpError={chFpError}
      pushUndo={pushUndo}
      deleteAsset={deleteAsset}
      deleteCharacter={deleteCharacter}
      handleUploadBackground={handleUploadBackground}
      openAiStoryboardForCurrentNode={openAiStoryboardForCurrentNode}
      openCharacterSpriteModal={openCharacterSpriteModal}
      openPoseVariantManagerForCharacter={openPoseVariantManagerForCharacter}
      poseVariantOptionsFor={poseVariantOptionsFor}
      runCharacterFingerprint={runCharacterFingerprint}
    />
  )

  return (
    <div className="app">
      <ComposeTopBar
        props={props}
        showProjectManager={showProjectManager}
        busy={busy}
        dirty={dirty}
        doc={doc}
        projects={projects}
        problems={problems}
        openMenu={openMenu}
        runtimeStartNodeId={runtimeStartNodeId}
        nodesForList={nodesForList}
        nodeLabel={nodeLabel}
        refreshProjects={refreshProjects}
        createNewProject={createNewProject}
        openProject={openProject}
        saveIfDirty={saveIfDirty}
        saveCurrent={saveCurrent}
        restartRuntime={restartRuntime}
        exportCurrent={exportCurrent}
        exportPublishCurrent={exportPublishCurrent}
        openCompletenessModal={openCompletenessModal}
        openSceneReviewPanel={openSceneReviewPanel}
        runStoryboardOpenChecks={runStoryboardOpenChecks}
        initStoryboardBatchFromDoc={initStoryboardBatchFromDoc}
        setOpenMenu={setOpenMenu}
        setRuntimeStartNodeId={setRuntimeStartNodeId}
        setSelection={setSelection}
        setSbOpen={setSbOpen}
        setSbRenderOpen={setSbRenderOpen}
        setSbPoseFocusAssetId={setSbPoseFocusAssetId}
        setToast={setToast}
      />

      {externalNewerRev > 0 && doc.mode === 'project' ? (
        <ExternalUpdateBanner
          busy={busy}
          doc={doc}
          externalNewerRev={externalNewerRev}
          openProject={openProject}
          setExternalDismissedRev={setExternalDismissedRev}
          setExternalNewerRev={setExternalNewerRev}
        />
      ) : null}

      <div className="main">
        <ComposeLeftPanel
          doc={doc}
          leftTab={leftTab}
          setLeftTab={setLeftTab}
          selection={selection}
          setSelection={setSelection}
          nodesForList={nodesForList}
          nodeLabel={nodeLabel}
          addCharacter={addCharacter}
          addAsset={addAsset}
          stageMaterials={stageMaterials}
        />

        <div
          className={`canvas${canvasDropActive ? ' canvas-drop-active' : ''}`}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.types).includes('application/x-talkscene-asset')) {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              if (!canvasDropActive) setCanvasDropActive(true)
            }
          }}
          onDragLeave={() => setCanvasDropActive(false)}
          onDrop={(e) => {
            const raw = e.dataTransfer.getData('application/x-talkscene-asset')
            setCanvasDropActive(false)
            if (!raw) return
            e.preventDefault()
            handleDropMaterial(raw, e.clientX, e.clientY)
          }}
        >
          <div className="canvas-wrap" ref={canvasHostRef} />
          {doc.mode === 'project' && doc.project && doc.story ? (
            <StageToolbar
              editMode={editMode}
              setEditMode={setEditMode}
              stageZoom={stageZoom}
              setStageZoom={setStageZoom}
              setStagePan={setStagePan}
              panToolActive={panToolActive}
              setPanToolActive={setPanToolActive}
              undoCount={undoCount}
              undoPlacementChange={undoPlacementChange}
              toolbarPlacement={toolbarPlacement}
              togglePlacementFlip={togglePlacementFlip}
              bumpPlacementZ={bumpPlacementZ}
              deleteToolbarPlacement={deleteToolbarPlacement}
            />
          ) : null}
          {doc.project && doc.story && effectivePreviewNode ? (
            <StageOverlay
              doc={doc}
              effectivePreviewNode={effectivePreviewNode}
              stageViewport={stageViewport}
              stageZoom={stageZoom}
              stagePan={stagePan}
              canvasSize={canvasSize}
              stageUiRef={stageUiRef}
              rt={rt}
              setRt={setRt}
              rtRef={rtRef}
              setSelection={setSelection}
              setToast={setToast}
              setDocStory={setDocStory}
              clearRuntimeTimers={clearRuntimeTimers}
              restartRuntime={restartRuntime}
              runTimelineStable={runTimelineStable}
              dragDialogRef={dragDialogRef}
            />
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

      {sbOverrideModal.open ? (
        <StoryboardOverrideModal
          sbOverrideModal={sbOverrideModal}
          setSbOverrideModal={setSbOverrideModal}
          sbOverrideResolverRef={sbOverrideResolverRef}
        />
      ) : null}

      {latestExportModal.open ? (
        <LatestExportModal
          latestExportModal={latestExportModal}
          closeLatestExportModal={closeLatestExportModal}
        />
      ) : null}

      {/* GS-53 场景图审核面板：逐场景评审卡片（缩略图/分数/判定/问题/建议）+ 打回重出/确认通过 */}
      {srOpen ? (
        <SceneReviewPanel
          srBusy={srBusy}
          srError={srError}
          srRound={srRound}
          srTask={srTask}
          srReworkBusy={srReworkBusy}
          setSrOpen={setSrOpen}
          runSceneReview={runSceneReview}
          reworkScene={reworkScene}
          confirmScenePass={confirmScenePass}
          srFeedbackStatusOf={srFeedbackStatusOf}
        />
      ) : null}

	      {ccOpen ? (
        <CompletenessModal
          ccBusy={ccBusy}
          ccError={ccError}
          ccReport={ccReport}
          ccReportFile={ccReportFile}
          ccTask={ccTask}
          setCcOpen={setCcOpen}
          runCompletenessCheck={runCompletenessCheck}
          ccScreenshotUrl={ccScreenshotUrl}
        />
      ) : null}

      <AiBackgroundModal
	        open={aiOpen}
	        value={aiReq}
          imageProvider={aiImageProvider}
          imageModel={aiImageModel}
          continuityInfo={{
            bibleReady: Boolean(String(readStoryboardEntitySpecFromProject(doc.project) || '').trim()),
            bibleSummary: buildStoryboardContinuitySummary(doc.project),
            inheritFromBatch: true,
            sceneRoleLocked: Boolean(selection.type === 'node' && doc.story && (() => {
              const node0 = (doc.story.nodes || []).find((n) => n.id === selection.id) || null
              return String(buildRoleDefinitionForNode(node0 ? ensureNode(node0 as any) : null) || '').trim()
            })())
          }}
	        referenceScenes={selection.type === 'node' ? buildReferenceSceneOptions(selection.id, Array.isArray(aiReq.referenceSceneIds) ? aiReq.referenceSceneIds : []) : []}
          continuityCharacters={(() => {
            if (selection.type !== 'node' || !doc.story) return []
            const node0 = (doc.story.nodes || []).find((n) => n.id === selection.id) || null
            return buildNodeCharacterReferenceChoices(node0 ? ensureNode(node0 as any) : null, Array.isArray(aiReq.characterRefs) ? aiReq.characterRefs : [])
          })()}
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
              const referenceSceneBlock = buildReferenceScenePromptBlock(Array.isArray(aiReq.referenceSceneIds) ? aiReq.referenceSceneIds : [])
              const globalPromptForAi = aiReq.backgroundOnly
                ? [readStoryboardEntitySpecFromProject(doc.project), referenceSceneBlock, String(aiReq.globalPrompt || '').trim()].filter(Boolean).join('，')
                : [buildStoryboardGlobalPromptForNode(ensureNode(node as any), String(aiReq.globalPrompt || '')), referenceSceneBlock].filter(Boolean).join('，')
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
                  const referenceSceneBlock = buildReferenceScenePromptBlock(Array.isArray(aiReq.referenceSceneIds) ? aiReq.referenceSceneIds : [])
                  const node0 =
                    !aiReq.backgroundOnly && selection.type === 'node' && doc.story
                      ? (doc.story.nodes || []).find((n) => n.id === selection.id) || null
                      : null
                  const nodeForPrompt = node0 ? ensureNode(node0 as any) : null
                  const globalPromptForAi = aiReq.backgroundOnly
                    ? [readStoryboardEntitySpecFromProject(doc.project), referenceSceneBlock, String(aiReq.globalPrompt || '').trim()].filter(Boolean).join('，')
                    : [buildStoryboardGlobalPromptForNode(nodeForPrompt, String(aiReq.globalPrompt || '')), referenceSceneBlock].filter(Boolean).join('，')
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
                const provider = String(aiImageProvider || '').trim().toLowerCase()
                const referenceSceneBlock = buildReferenceScenePromptBlock(Array.isArray(aiReq.referenceSceneIds) ? aiReq.referenceSceneIds : [])
                const referenceSceneOptions = selection.type === 'node'
                  ? buildReferenceSceneOptions(selection.id, Array.isArray(aiReq.referenceSceneIds) ? aiReq.referenceSceneIds : [])
                  : []
                const referenceImageUrls = referenceSceneOptions
                  .filter((scene) => Array.isArray(aiReq.referenceSceneIds) && aiReq.referenceSceneIds.includes(scene.nodeId) && scene.usableUrl)
                  .map((scene) => String(scene.usableUrl || '').trim())
                  .filter(Boolean)
                if (provider === 'doubao' && Array.isArray(aiReq.referenceSceneIds) && aiReq.referenceSceneIds.length > 0 && referenceImageUrls.length === 0) {
                  throw new Error('所选参考场景还没有可被 Doubao 访问的参考图链接。请先选择带有可用参考源的场景图，或先重新生成一次参考场景。')
                }
                if (!aiReq.backgroundOnly && selection.type === 'node' && doc.story) {
                  const node0 = (doc.story.nodes || []).find((n) => n.id === selection.id) || null
                  const nodeForPrompt = node0 ? ensureNode(node0 as any) : null
                  gp = [buildStoryboardGlobalPromptForNode(nodeForPrompt, gp), referenceSceneBlock].filter(Boolean).join('，')
                  payload.globalPrompt = gp
                  payload.characterRefs = buildSelectedCharacterRefsFromChoices(
                    buildNodeCharacterReferenceChoices(node0 ? ensureNode(node0 as any) : null, Array.isArray(aiReq.characterRefs) ? aiReq.characterRefs : [])
                  )
                } else if (provider === 'doubao') {
                  gp = [readStoryboardEntitySpecFromProject(doc.project), referenceSceneBlock, gp].filter(Boolean).join('，')
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
                if (provider === 'doubao') {
                  payload.width = undefined
                  payload.height = undefined
                  payload.steps = undefined
                  payload.cfgScale = undefined
                  payload.sampler = undefined
                  payload.scheduler = undefined
                  payload.size = String(aiReq.size || '').trim() || getDoubaoStoryboardDefaultSize(String(aiReq.aspectRatio || '9:16'))
                  payload.responseFormat = aiReq.responseFormat || 'url'
                  payload.watermark = Boolean(aiReq.watermark)
                  payload.sequentialImageGeneration = aiReq.sequentialImageGeneration || 'auto'
                  payload.referenceSceneIds = Array.isArray(aiReq.referenceSceneIds) ? aiReq.referenceSceneIds : []
                  payload.referenceImageUrls = referenceImageUrls
                  payload.timeoutMs = 300_000
                }
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
                const nodeBefore = (doc.story.nodes || []).find((n) => n.id === selection.id) || null
                const existingBgId = String((nodeBefore as any)?.visuals?.backgroundAssetId || '').trim()
                const existingBgAsset = existingBgId ? (doc.project.assets || []).find((a) => a.id === existingBgId) || null : null
                if (existingBgAsset && String(existingBgAsset.uri || '').trim()) {
                  payload.existingAssetUri = String(existingBgAsset.uri || '').trim()
                }
		            const usedPrompt = [gp, sp].filter(Boolean).join('，')
		            const resp = await generateBackgroundAi(doc.id, payload)
		            const rawProvider = String((resp as any).provider || '').trim()
		            const bgProvider: AssetV1['source'] extends { provider?: infer P } ? P : any =
		              rawProvider === 'sdwebui' || rawProvider === 'comfyui' || rawProvider === 'doubao' ? rawProvider : undefined
		            const nextUri = resp.url ? resolveUrl(resp.url) : resp.assetPath
		            setAiLast({
                  url: nextUri,
                  assetPath: resp.assetPath,
                  provider: rawProvider || undefined,
                  remoteUrl: (resp as any).remoteUrl || undefined,
                  seed: Number.isFinite(Number((resp as any).seed)) ? Number((resp as any).seed) : undefined,
                  continuityUsed: Boolean((resp as any).continuityUsed)
                })
		            const node = (doc.story.nodes || []).find((n) => n.id === selection.id) || null
		            const bgId = String((node as any)?.visuals?.backgroundAssetId || '').trim()
		            const existing = bgId ? (doc.project.assets || []).find((a) => a.id === bgId) || null : null

                  if (bgId && existing) {
                    setDocProject((p) => ({
                      ...p,
                          assets: (p.assets || []).map((a) =>
                            a.id === bgId
                          ? { ...a, uri: nextUri, source: { type: 'ai' as const, prompt: usedPrompt || aiReq.prompt, provider: bgProvider, remoteUrl: String((resp as any).remoteUrl || '').trim() || undefined } }
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
                    source: { type: 'ai' as const, prompt: usedPrompt || aiReq.prompt, provider: bgProvider, remoteUrl: String((resp as any).remoteUrl || '').trim() || undefined }
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

        <StoryboardLockWorkspace
          open={sbOpen}
          projectId={doc.mode === 'project' ? doc.id : ''}
          value={{
            prompt: '',
            entitySpec: sbReq.entitySpec,
            storyBibleJson: sbReq.storyBibleJson,
            globalPromptZh: sbReq.globalPromptZh,
            globalPrompt: sbReq.globalPrompt,
            globalNegativePromptZh: sbReq.globalNegativePromptZh,
            globalNegativePrompt: sbReq.globalNegativePrompt,
            style: sbReq.style,
            aspectRatio: sbReq.aspectRatio,
            width: sbReq.width,
            height: sbReq.height,
            model: sbReq.model,
            loras: sbReq.loras,
            size: sbReq.size,
            responseFormat: sbReq.responseFormat,
            watermark: sbReq.watermark,
            sequentialImageGeneration: sbReq.sequentialImageGeneration,
            steps: sbReq.steps,
            cfgScale: sbReq.cfgScale,
            sampler: sbReq.sampler,
            scheduler: sbReq.scheduler
          }}
          assetPlan={sbAssetPlan}
          assetPromptDrafts={sbAssetPromptDrafts}
          translatingScope={sbTranslatingScope}
          translateCountdownSec={sbTranslateCountdownSec}
          promptOpBusy={Boolean(sbOptimizingAssetId || sbTranslatingScope)}
          assetPlanBusy={sbAssetPlanBusy}
          assetGeneratingId={sbGeneratingAssetId}
          assetAnalyzingId={sbAnalyzingAssetId}
          assetOptimizingId={sbOptimizingAssetId}
          assetSelectingId={sbSelectingAssetId}
          assetLineartId={sbLineartAssetId}
          assetGallery={sbGallery}
          assetGalleryBusy={sbGalleryBusy}
          assetGalleryDeletingPaths={sbGalleryDeletingPaths}
          assetConfirmReady={sbAssetConfirmReady}
          assetConfirmSummary={sbAssetConfirmSummary}
          continuityReady={sbContinuityReady}
          continuitySummary={sbContinuitySummary}
          busyEntity={sbBusyEntity}
          openChecks={sbOpenChecks}
          logs={sbLogs}
          error={sbError}
          onClose={async () => {
            if (sbBusyGenerate || sbBusyApply || sbBusyEntity || sbAssetPlanBusy) return
            const ok = await saveIfDirty()
            if (!ok) return
            closeStoryboardAssetGallery()
            setSbOpen(false)
            setSbError('')
            setSbPoseFocusAssetId('')
            try { if (localStorage.getItem(sbWsOpenStorageKey) === doc.id) localStorage.removeItem(sbWsOpenStorageKey) } catch {}
          }}
          onReloadProject={() => void reloadProjectAndStoryboard()}
          onSave={async () => saveCurrent()}
          onRunOpenChecks={() => void runStoryboardOpenChecks()}
          onGenerateEntity={runStoryboardGenerateEntitySpec}
          onBuildAssetPlan={runStoryboardBuildAssetPlan}
          onGenerateAssetRef={(assetId, batchSize) => void runStoryboardGenerateAssetReference(assetId, batchSize)}
          onGenerateAllMissingAssetRefs={() => void runStoryboardGenerateAllMissingAssetReferences()}
          onAnalyzeAssetRef={(assetId) => void runStoryboardAnalyzeAssetReference(assetId)}
          onOptimizeAssetRef={(assetId) => void runStoryboardEnhanceAssetPrompt(assetId)}
          onEnhanceAllPrompts={() => void runStoryboardEnhanceAllAssetPrompts()}
          translateAllProgress={sbTranslateAllProgress}
          onTranslateAllPrompts={() => void runStoryboardTranslateAllPrompts()}
          onDraftGlobalPromptZh={() => void runStoryboardDraftGlobalPromptZh()}
          enhanceAllProgress={sbEnhanceAllProgress}
          globalDraftBusy={sbGlobalDraftBusy}
          promptGate={sbPromptGate}
          onPromptGateChange={updateStoryboardLockPromptGate}
          globalPromptReview={sbGlobalPromptReview}
          globalPromptReviewBusy={sbGlobalPromptReviewBusy}
          onReviewGlobalPrompt={() => void runStoryboardReviewGlobalPrompt()}
          onApplyGlobalPromptReview={() => applyStoryboardGlobalPromptReview()}
          onSelectAssetRef={(assetId, assetPath) => void runStoryboardSelectAssetReference(assetId, assetPath)}
          onGenerateAssetLineart={(assetId) => void runStoryboardGenerateAssetLineart(assetId)}
          onOpenAssetGallery={(assetId) => void runStoryboardOpenAssetGallery(assetId)}
          onCloseAssetGallery={closeStoryboardAssetGallery}
          onSelectAssetGalleryPrimary={(assetId, assetPath) => void runStoryboardSelectAssetGalleryPrimary(assetId, assetPath)}
          onDeleteAssetGalleryItems={(assetId, assetPaths) => void runStoryboardDeleteAssetGalleryItems(assetId, assetPaths)}
          onDeleteAssetGalleryItem={(assetId, assetPath) => void runStoryboardDeleteAssetGalleryItem(assetId, assetPath)}
          onDeleteAssetFromPlan={(assetId) => removeStoryboardAssetFromPlan(assetId)}
          onChangeGlobalPromptZh={(value) => updateStoryboardLockGlobalPrompts({ globalPromptZh: value })}
          onChangeGlobalPromptEn={(value) => updateStoryboardLockGlobalPrompts({ globalPrompt: value })}
          onTranslateGlobalPrompt={() => void translateStoryboardLockGlobalPrompt('globalPrompt')}
          onChangeGlobalNegativePromptZh={(value) => updateStoryboardLockGlobalPrompts({ globalNegativePromptZh: value })}
          onChangeGlobalNegativePromptEn={(value) => updateStoryboardLockGlobalPrompts({ globalNegativePrompt: value })}
          onTranslateGlobalNegativePrompt={() => void translateStoryboardLockGlobalPrompt('globalNegativePrompt')}
          onChangeAssetPrompt={(assetId, patch) => updateStoryboardLockAssetPrompt(assetId, patch)}
          onTranslateAssetPromptPositive={(assetId) => void translateStoryboardLockAssetPrompt(assetId, 'positive')}
          onTranslateAssetPromptNegative={(assetId) => void translateStoryboardLockAssetPrompt(assetId, 'negative')}
          poseGeneratingId={sbPoseGeneratingId}
          poseDrawProgress={sbPoseDrawProgress}
          poseReviewingId={sbPoseReviewingId}
          poseLockingKey={sbPoseLockingKey}
          posePromptBusyId={sbPosePromptBusyId}
          poseFocusAssetId={sbPoseFocusAssetId}
          poseSceneOptionsFor={(assetId) => poseSceneOptionsFor(assetId)}
          poseGalleryAssetId={sbPoseGalleryAssetId}
          onPoseGalleryOpen={(assetId) => setSbPoseGalleryAssetId(assetId)}
          onPoseGalleryClose={() => setSbPoseGalleryAssetId('')}
          onPosePrefill={(assetId) => buildPosePrefillForAsset(assetId)}
          onPoseDraftSave={(assetId, draft) => void runStoryboardPoseDraftSave(assetId, draft)}
          onPoseAiPrompt={(assetId, opts) => runStoryboardPoseAiPrompt(assetId, opts)}
          onPoseDraftTranslate={(assetId) => runStoryboardPoseDraftTranslate(assetId)}
          customPoseRecipes={(() => {
            const st = (doc.project as any)?.state
            const list = st && st.aiBackground && Array.isArray(st.aiBackground.customPoseRecipes) ? st.aiBackground.customPoseRecipes : []
            return list
          })()}
          onPoseSaveRecipe={(recipe) => saveCustomPoseRecipe(recipe)}
          onPoseGenerate={(assetId, opts) => void runStoryboardPoseDraw(assetId, opts, 1)}
          onPoseGenerateFour={(assetId, opts) => void runStoryboardPoseDraw(assetId, opts, 4)}
          poseReqBusyId={sbPoseReqBusyId}
          onPoseRequirementsExtract={(assetId) => void runStoryboardPoseRequirementsExtract(assetId)}
          onExpressionRequirementsExtract={(assetId) => void runStoryboardExpressionRequirements(assetId)}
          onPoseRequirementGenerate={(assetId, reqId) => void runStoryboardPoseRequirementGenerate(assetId, reqId)}
          onPoseRequirementsBatchGenerate={(assetId) => void runStoryboardPoseRequirementsBatchGenerate(assetId)}
          onPoseRequirementChange={(assetId, reqId, patch) => void runStoryboardPoseRequirementChange(assetId, reqId, patch)}
          onPoseRequirementDelete={(assetId, reqId) => void runStoryboardPoseRequirementDelete(assetId, reqId)}
          onPoseReviewAll={(assetId) => void runStoryboardPoseReviewAll(assetId)}
          onPoseRedraw={(assetId, assetPath, opts) => void runStoryboardPoseRedraw(assetId, assetPath, opts)}
          onPoseDeleteCandidate={(assetId, assetPath) => void runStoryboardPoseDeleteCandidate(assetId, assetPath)}
          onPoseLock={(assetId, assetPath, name, prompts) => void runStoryboardPoseLock(assetId, assetPath, name, prompts)}
          onPoseDeleteVariant={(assetId, variantId) => runStoryboardPoseDeleteVariant(assetId, variantId)}
          propStateBusyId={sbPropStateBusyId}
          propStateGenKey={sbPropStateGenKey}
          onPropStatesExtract={(assetId) => void runStoryboardPropStatesExtract(assetId)}
          onPropStateGenerate={(assetId, state) => void runStoryboardPropStateVariantGenerate(assetId, state)}
          sceneAnalysisBusy={sbSceneAnalysisBusy}
          sceneAnalysisStage={sbSceneAnalysisStage}
          sceneAnalysisElapsedMs={sbSceneAnalysisElapsedMs}
          onRunSceneElementAnalysis={() => void runStoryboardSceneElementAnalysis()}
          onConfirmAssetPlan={confirmStoryboardAssetPlan}
          onOpenRender={async () => {
            if (!sbAssetConfirmReady) return
            const ok = await saveIfDirty()
            if (!ok) return
            closeStoryboardAssetGallery()
            setSbOpen(false)
            setSbRenderOpen(true)
            try { if (localStorage.getItem(sbWsOpenStorageKey) === doc.id) localStorage.removeItem(sbWsOpenStorageKey) } catch {}
          }}
        />

        <AiStoryboardBatchModal
          open={sbRenderOpen}
          projectId={doc.mode === 'project' ? doc.id : ''}
          value={{
            prompt: '',
            entitySpec: sbReq.entitySpec,
            storyBibleJson: sbReq.storyBibleJson,
            globalPromptZh: sbReq.globalPromptZh,
            globalPrompt: sbReq.globalPrompt,
            globalNegativePromptZh: sbReq.globalNegativePromptZh,
            globalNegativePrompt: sbReq.globalNegativePrompt,
            style: sbReq.style,
            aspectRatio: sbReq.aspectRatio,
            width: sbReq.width,
            height: sbReq.height,
            model: sbReq.model,
            loras: sbReq.loras,
            size: sbReq.size,
            responseFormat: sbReq.responseFormat,
            watermark: sbReq.watermark,
            sequentialImageGeneration: sbReq.sequentialImageGeneration,
            steps: sbReq.steps,
            cfgScale: sbReq.cfgScale,
            sampler: sbReq.sampler,
            scheduler: sbReq.scheduler
          }}
          items={sbItems}
          busyGenerate={sbBusyGenerate}
          busyApply={sbBusyApply}
          busyEntity={sbBusyEntity}
          entityElapsedMs={sbBusyEntity ? sbElapsedMs : 0}
          continuityReady={sbContinuityReady}
          continuitySummary={sbContinuitySummary}
          continuityBusy={sbContinuityBusy}
          assetPlan={sbAssetPlan}
          assetPlanBusy={sbAssetPlanBusy}
          assetGeneratingId={sbGeneratingAssetId}
          assetAnalyzingId={sbAnalyzingAssetId}
          assetOptimizingId={sbOptimizingAssetId}
          assetConfirmReady={sbAssetConfirmReady}
          assetConfirmSummary={sbAssetConfirmSummary}
          continuityConfig={sbReq.continuity}
          openChecks={sbOpenChecks}
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
          testSceneId={sbTestSceneId}
          error={sbError}
          logs={sbLogs}
          translatingScope={sbTranslatingScope}
          translateCountdownSec={sbTranslateCountdownSec}
          promptOpBusy={Boolean(sbOptimizingAssetId || sbTranslatingScope)}
          onRunOpenChecks={() => void runStoryboardOpenChecks()}
          onChangeTestSceneId={(nodeId) => {
            const nextId = String(nodeId || '').trim()
            setSbTestSceneId(nextId)
            setSbContinuityReady(false)
            setSbContinuitySummary('')
          }}
          onChangeGlobalPromptZh={(value) => updateStoryboardLockGlobalPrompts({ globalPromptZh: value })}
          onChangeGlobalPromptEn={(value) => updateStoryboardLockGlobalPrompts({ globalPrompt: value })}
          onTranslateGlobalPrompt={() => void translateStoryboardLockGlobalPrompt('globalPrompt')}
          onChangeGlobalNegativePromptZh={(value) => updateStoryboardLockGlobalPrompts({ globalNegativePromptZh: value })}
          onChangeGlobalNegativePromptEn={(value) => updateStoryboardLockGlobalPrompts({ globalNegativePrompt: value })}
          onTranslateGlobalNegativePrompt={() => void translateStoryboardLockGlobalPrompt('globalNegativePrompt')}
          onGenerateEntity={runStoryboardGenerateEntitySpec}
          onClearStoryBible={() => {
            setSbReq((prev) => ({ ...prev, storyBibleJson: '', entitySpec: '' }))
            setSbAssetPlan(null)
            setSbAssetsConfirmedAt('')
            persistStoryboardAssetPlan(null, '')
            setSbContinuityReady(false)
            saveStoryboardContinuityBackup(AI_BG_CONTINUITY_KEY, { storyBibleJson: '', entitySpec: '', continuity: sbReq.continuity })
            if (doc.mode === 'project') {
              setDocProject((p) => {
                const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
                const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
                const nextAiBg = { ...aiBgIn }
                delete (nextAiBg as any).storyBible
                delete (nextAiBg as any).storyBibleJson
                delete (nextAiBg as any).storyboardEntitySpec
                const nextState = { ...stateIn, aiBackground: nextAiBg }
                return { ...p, state: nextState }
              })
            }
          }}
          onBuildAssetPlan={() => void runStoryboardBuildAssetPlan()}
          onGenerateAssetRef={(assetId) => void runStoryboardGenerateAssetReference(assetId)}
          onAnalyzeAssetRef={(assetId) => void runStoryboardAnalyzeAssetReference(assetId)}
          onOptimizeAssetRef={(assetId) => void runStoryboardOptimizeAssetReference(assetId)}
          onGenerateAllMissingAssetRefs={() => void runStoryboardGenerateAllMissingAssetReferences()}
          onConfirmAssetPlan={confirmStoryboardAssetPlan}
          onRunContinuityTest={() => void runStoryboardContinuityTest()}
          onChangeContinuityConfig={(patch) => {
            setSbReq((prev) => {
              const nextReq = { ...prev, continuity: { ...(prev.continuity || {}), ...(patch || {}) } }
              saveStoryboardContinuityBackup(AI_BG_CONTINUITY_KEY, {
                storyBibleJson: nextReq.storyBibleJson,
                entitySpec: nextReq.entitySpec,
                continuity: nextReq.continuity
              })
              return nextReq
            })
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
            const storyBibleChanged = String((next as any).storyBibleJson || '') !== String(sbReq.storyBibleJson || '')
            const globalPromptChanged = Object.prototype.hasOwnProperty.call(next || {}, 'globalPrompt') && String(next.globalPrompt || '') !== String(sbReq.globalPrompt || '')
            const globalNegativeChanged = Object.prototype.hasOwnProperty.call(next || {}, 'globalNegativePrompt') && String(next.globalNegativePrompt || '') !== String(sbReq.globalNegativePrompt || '')
            if (globalPromptChanged || globalNegativeChanged) {
              setSbGlobalPromptReview(null)
              persistStoryboardGlobalPromptReview(null)
            }
            if (storyBibleChanged) {
              setSbAssetPlan(null)
              setSbAssetsConfirmedAt('')
              persistStoryboardAssetPlan(null, '')
            }
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
                model: String((next as any).model ?? prev.model ?? '').trim(),
                loras: Array.isArray((next as any).loras) ? (next as any).loras.map((x: any) => String(x || '').trim()).filter(Boolean) : (Array.isArray(prev.loras) ? prev.loras : []),
                size: String((next as any).size ?? prev.size ?? '').trim(),
                responseFormat: (((next as any).responseFormat || prev.responseFormat || 'url') === 'b64_json' ? 'b64_json' : 'url') as any,
                watermark: typeof ((next as any).watermark ?? prev.watermark) === 'boolean' ? Boolean((next as any).watermark ?? prev.watermark) : false,
                sequentialImageGeneration: (((next as any).sequentialImageGeneration || prev.sequentialImageGeneration || 'disabled') === 'auto' ? 'auto' : 'disabled') as any,
                steps: Number(next.steps ?? prev.steps),
                cfgScale: Number(next.cfgScale ?? prev.cfgScale),
                sampler: String(next.sampler || prev.sampler || 'DPM++ 2M'),
                scheduler: String(next.scheduler || prev.scheduler || 'Automatic')
              }
              // When Story Bible JSON is present and valid, keep entitySpec derived (read-only downstream).
              const storyBibleObj = tryParseStoryBibleJson(merged.storyBibleJson)
              if (storyBibleObj) merged.entitySpec = buildEntitySpecFromStoryBible(storyBibleObj)
              setSbContinuityReady(false)
              saveStoryboardContinuityBackup(AI_BG_CONTINUITY_KEY, {
                storyBibleJson: merged.storyBibleJson,
                entitySpec: merged.entitySpec,
                continuity: merged.continuity
              })
              upsertStoryboardBatchDraft({
                style: merged.style,
                aspectRatio: merged.aspectRatio,
                width: merged.width,
                height: merged.height,
                model: merged.model,
                loras: merged.loras,
                size: merged.size,
                responseFormat: merged.responseFormat,
                watermark: merged.watermark,
                sequentialImageGeneration: merged.sequentialImageGeneration,
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
              const shouldResetReview = patch.promptZh != null || patch.prompt != null || patch.negativePromptZh != null || patch.negativePrompt != null
              const nextPatch = shouldResetReview ? { ...patch, promptReview: null } : patch
              const next = prev.map((x) => (x.nodeId === nodeId ? { ...x, ...nextPatch } : x))
              const changed = next.find((x) => x.nodeId === nodeId) || null
              if (changed) {
                upsertStoryboardScenePrompt(nodeId, changed.nodeName, {
                  userInput: nextPatch.userInput != null ? String(nextPatch.userInput || '') : undefined,
                  promptZh: nextPatch.promptZh != null ? String(nextPatch.promptZh || '') : undefined,
                  prompt: nextPatch.prompt != null ? String(nextPatch.prompt || '') : undefined,
                  negativePromptZh: nextPatch.negativePromptZh != null ? String(nextPatch.negativePromptZh || '') : undefined,
                  negativePrompt: nextPatch.negativePrompt != null ? String(nextPatch.negativePrompt || '') : undefined,
                  promptReview: shouldResetReview ? null : undefined
                })
              }
              return next
            })
          }
          globalPromptReview={sbGlobalPromptReview}
          globalPromptReviewBusy={sbGlobalPromptReviewBusy}
          promptReviewingNodeId={sbPromptReviewingNodeId}
          onReviewGlobalPrompt={() => void runStoryboardReviewGlobalPrompt()}
          onApplyGlobalPromptReview={applyStoryboardGlobalPromptReview}
          onReviewItemPrompt={(nodeId) => void runStoryboardReviewScenePrompt(nodeId)}
          onApplyItemPromptReview={applyStoryboardScenePromptReview}
          onClearGlobalPrompt={() => {
            setSbReq((prev) => ({ ...prev, globalPrompt: '', globalPromptZh: '' }))
            setSbGlobalPromptReview(null)
            persistStoryboardGlobalPromptReview(null)
            setSbContinuityReady(false)
            if (doc.mode === 'project') {
              setDocProject((p) => {
                const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
                const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
                const nextState = { ...stateIn, aiBackground: { ...aiBgIn, globalPrompt: '', storyboardGlobalPromptZh: '' } }
                return { ...p, state: nextState }
              })
            }
            appendSbLog('已清空全局正向提示词')
          }}
          onClearGlobalNegativePrompt={() => {
            setSbReq((prev) => ({ ...prev, globalNegativePrompt: '', globalNegativePromptZh: '' }))
            setSbGlobalPromptReview(null)
            persistStoryboardGlobalPromptReview(null)
            setSbContinuityReady(false)
            if (doc.mode === 'project') {
              setDocProject((p) => {
                const stateIn = (p && (p as any).state && typeof (p as any).state === 'object') ? (p as any).state : {}
                const aiBgIn = (stateIn as any).aiBackground && typeof (stateIn as any).aiBackground === 'object' ? (stateIn as any).aiBackground : {}
                const nextState = { ...stateIn, aiBackground: { ...aiBgIn, globalNegativePrompt: '', storyboardGlobalNegativePromptZh: '' } }
                return { ...p, state: nextState }
              })
            }
            appendSbLog('已清空全局负向提示词')
          }}
          onClose={async () => {
            if (sbBusyGenerate || sbBusyApply || sbBusyEntity || sbAssetPlanBusy) return
            const ok = await saveIfDirty()
            if (!ok) return
            setSbRenderOpen(false)
            setSbError('')
          }}
          onReloadProject={() => { if (doc.mode === 'project') void openProject(doc.id) }}
          onAppendLog={(line) => appendSbLog(line)}
          onArrangeScene={(nodeId) => {
            const id = String(nodeId || '').trim()
            if (!id || !nodeById.has(id)) return
            setSelection({ type: 'node', id })
            setPreviewNodeId(id)
            setRightFold((prev) => ({ ...prev, placements: true }))
          }}
          onOpenAssetLock={(a) => void openAssetLockInWizard({ planAssetId: a.id, name: a.name })}
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
