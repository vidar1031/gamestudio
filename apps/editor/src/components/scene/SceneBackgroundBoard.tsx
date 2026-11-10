// 场景背景工作台（2026-11-01 抽取自 AiStoryboardBatchModal 场景管理区，向导第 5 步「场景背景」视图与原弹窗共用同一实现）。
// 每幕一张背景卡：状态总账/当前大图/版本条(设为背景·删除)/重新出图/正·负向双稿/AI 评分与强化/编排站位/
// 待审核就地批准（出图前审核·场景图绑定）/全部重渲。轮询与图库自管理；弹窗内嵌时由外层注入数据并关闭自轮询。
import React, { useEffect, useMemo, useState } from 'react'
import {
  approveImageReviewAi,
  bindStorySceneImageAi,
  deleteStorySceneImageAi,
  listImageReviewsAi,
  listProjectAiCoverage,
  listProjectAiTasks,
  listStorySceneImagesAi,
  rejectImageReviewAi,
  renderStorySceneAi,
  resolveUrl,
  subscribeProjectAiEvents,
  type AiCoverage,
  type AiTaskProgress,
  type ImageReviewRecord,
  type StorySceneImageItem
} from '../../api'
import { dlgAlert, dlgConfirm } from '../../dialog'
import { confirmRerun } from '../shared/confirmRerun'
import AutoGrowTextarea from '../shared/AutoGrowTextarea'
import DetailWorkspace from '../shared/DetailWorkspace'
import SceneGenerationStatus from './SceneGenerationStatus'
import { onTaskStop } from '../../tasks/stopTask'
import type { StoryboardBatchItem } from '../../AiStoryboardBatchModal'
import { toProjectAssetUrl } from '../pose/assetUrl'
import { countScenePromptAlignment, getScenePromptAlignment, SCENE_PROMPT_REQUIREMENTS_PATH } from './scenePromptAlignment'

export type SceneBoardAssetRef = { id: string; name: string; category: string; locked: boolean }

type Props = {
  /** 挂载且可见时为 true（控制自轮询；弹窗内嵌由外层注入数据时自轮询自动关闭） */
  active: boolean
  projectId: string
  items: StoryboardBatchItem[]
  planAssets: any[]
  envReady: boolean
  busy: boolean
  focusSceneId?: string
  generatingNodeId?: string
  generatingNodeElapsedMs?: number
  promptReviewingNodeId?: string
  /** 外部注入（弹窗模式）：提供时本组件不再自轮询 */
  coverage?: AiCoverage | null
  pendingReviews?: ImageReviewRecord[]
  onChangeItem: (nodeId: string, patch: Partial<StoryboardBatchItem>) => void
  onReviewItemPrompt: (nodeId: string) => void
  onApplyItemPromptReview: (nodeId: string) => void
  /** 2026-11-01 与事物卡同款提示词流：单场景 AI 生成双稿 / 逐字段中文转英文 / 批量生成 */
  onGeneratePrompt?: (nodeId: string) => void
  onTranslatePrompt?: (nodeId: string, kind: 'positive' | 'negative') => void
  onGenerateAllPrompts?: () => void
  onAlignPrompt?: (nodeId: string) => void
  onAlignAllPrompts?: () => void
  promptGenBusy?: boolean
  alignBusy?: boolean
  aligningNodeId?: string
  translatingScope?: string
  onReloadProject?: () => void
  onArrangeScene?: (nodeId: string) => void
  /** 2026-11-02 跳蓝图层该幕元素编辑（预演+要素分配）：出场事物只读展示，编辑入口单一在蓝图 */
  onEditSceneAssets?: (nodeId: string) => void
  onOpenAssetLock?: (asset: { id: string; name: string; category: string }) => void
}

function getPromptReviewTone(review: any): { cls: string; color: string } {
  const score = Number(review?.ai?.score)
  if (!Number.isFinite(score)) return { cls: 'pending', color: 'rgba(148,163,184,0.9)' }
  if (score >= 80) return { cls: 'ok', color: '#4ade80' }
  if (score >= 60) return { cls: 'warn', color: '#facc15' }
  return { cls: 'bad', color: '#f87171' }
}

const reviewPhaseLabel = (phase: string) => {
  if (phase === 'pre_generate') return '出图前审核'
  if (phase === 'scene_bind') return '场景图绑定'
  return phase || '审核'
}

const formatBindTime = (raw: string) => {
  const v = String(raw || '').trim()
  return v ? v.replace('T', ' ').slice(0, 16) : ''
}

const pairBadge = (status: string) => (
  <span className={`bp-prompt-badge ${status === 'aligned' ? 'is-ok' : status === 'stale' ? 'is-stale' : ''}`}>
    {status === 'aligned' ? '已对齐' : status === 'stale' ? '待同步' : status === 'unverified' ? '待核验' : '缺稿件'}
  </span>
)

export default function SceneBackgroundBoard(props: Props) {
  const projectId = String(props.projectId || '').trim()
  const externalMode = props.coverage !== undefined || props.pendingReviews !== undefined
  const [selfCoverage, setSelfCoverage] = useState<AiCoverage | null>(null)
  const [selfPendingReviews, setSelfPendingReviews] = useState<ImageReviewRecord[]>([])
  const coverage = externalMode ? (props.coverage || null) : selfCoverage
  const pendingReviews = externalMode ? (props.pendingReviews || []) : selfPendingReviews
  const [reviewBusyIds, setReviewBusyIds] = useState<string[]>([])
  const [renderingSceneIds, setRenderingSceneIds] = useState<string[]>([])
  const [sceneTasks, setSceneTasks] = useState<AiTaskProgress[]>([])
  const [rerenderAllBusy, setRerenderAllBusy] = useState(false)
  // 2026-11-02 卡片正文整体展开/收缩（一个开关管整条卡：场景原文+提示词+图区；样式同「场景原文」的行内展开钮）
  const [bodyCollapsed, setBodyCollapsed] = useState<Record<string, boolean>>({})
  // 2026-11-02 两级管理（与事物卡同构）：列表态 = 每幕一张小卡总览；点卡片进该幕出图详情
  const [selectedSceneId, setSelectedSceneId] = useState('')
  const [sceneDetailSection, setSceneDetailSection] = useState<'prompt' | 'images'>('prompt')
  const sceneIdsKey = props.items.map((item) => item.nodeId).join(',')
  useEffect(() => {
    const id = String(props.focusSceneId || '').trim()
    if (id && props.items.some((item) => item.nodeId === id)) {
      setSelectedSceneId(id)
      setSceneDetailSection('prompt')
    }
  }, [props.focusSceneId, sceneIdsKey])
  const openSceneDetail = (sceneId: string) => {
    setSelectedSceneId(sceneId)
    setSceneDetailSection('prompt')
    setBodyCollapsed((prev) => ({ ...prev, [sceneId]: false }))
  }
  // 2026-11-02 候选制出图：4 张串行生成中的幕 / 候选图尺寸登记表（onLoad 实测，避免编造）
  const [fourBusyId, setFourBusyId] = useState('')
  const [fourProgress, setFourProgress] = useState<{ sceneId: string; done: number } | null>(null)
  const [clockNow, setClockNow] = useState(() => Date.now())
  const [imgSizes, setImgSizes] = useState<Record<string, string>>({})
  const recordImgSize = (src: string, el: HTMLImageElement) => {
    if (!src || imgSizes[src]) return
    const w = el.naturalWidth
    const h = el.naturalHeight
    if (w > 0 && h > 0) setImgSizes((prev) => ({ ...prev, [src]: `${w}×${h}` }))
  }
  const [localBgUrls, setLocalBgUrls] = useState<Record<string, string>>({})
  const [sceneGallery, setSceneGallery] = useState<Record<string, { items: StorySceneImageItem[]; boundUri: string }>>({})
  const [gallerySelected, setGallerySelected] = useState<Record<string, string>>({})
  const [galleryBusy, setGalleryBusy] = useState<Record<string, boolean>>({})
  const [galleryHint, setGalleryHint] = useState<Record<string, string>>({})
  const [actionHint, setActionHint] = useState('')
  const pendingReviewsRef = React.useRef<ImageReviewRecord[]>([])
  const renderCancelRef = React.useRef(false)
  useEffect(() => onTaskStop((detail) => {
    if (!detail.projectId || detail.projectId === projectId) renderCancelRef.current = true
  }), [projectId])

  const refreshReviewsAndCoverage = async () => {
    if (!projectId) return
    const [reviews, cov] = await Promise.all([
      listImageReviewsAi(projectId, 'pending').catch(() => [] as ImageReviewRecord[]),
      listProjectAiCoverage(projectId).catch(() => null)
    ])
    pendingReviewsRef.current = reviews
    setSelfPendingReviews(reviews)
    setSelfCoverage(cov)
  }

  const loadSceneTasks = async () => {
    if (!projectId) {
      setSceneTasks([])
      return
    }
    const tasks = await listProjectAiTasks(projectId).catch(() => null)
    if (tasks) setSceneTasks(tasks)
  }
  useEffect(() => { void loadSceneTasks() }, [projectId])
  useEffect(() => {
    if (!fourBusyId && !sceneTasks.some((task) => !task.done)) return undefined
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [fourBusyId, sceneTasks])
  const sceneTaskOf = (it: StoryboardBatchItem) => sceneTasks
    .filter((task) => task.kind === 'story.scene.render' && (task.sceneId ? task.sceneId === it.nodeId : String(task.message || '').includes(it.nodeName)))
    .slice()
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))[0] || null

  // 自轮询：仅独立模式（向导场景背景视图）且可见时
  useEffect(() => {
    if (externalMode || !props.active || !projectId) return undefined
    let stopped = false
    const pull = async () => {
      const [reviews, cov] = await Promise.all([
        listImageReviewsAi(projectId, 'pending').catch(() => [] as ImageReviewRecord[]),
        listProjectAiCoverage(projectId).catch(() => null)
      ])
      if (stopped) return
      pendingReviewsRef.current = reviews
      setSelfPendingReviews(reviews)
      setSelfCoverage(cov)
    }
    void pull()
    const timer = window.setInterval(pull, 3000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [externalMode, props.active, projectId])

  const refreshSceneGallery = async (sceneId: string): Promise<{ items: StorySceneImageItem[]; boundUri: string } | null> => {
    if (!projectId || !sceneId) return null
    try {
      const res = await listStorySceneImagesAi(projectId, sceneId)
      setSceneGallery((prev) => ({ ...prev, [sceneId]: res }))
      setGalleryHint((prev) => ({ ...prev, [sceneId]: '' }))
      return res
    } catch (_) {
      setGalleryHint((prev) => ({ ...prev, [sceneId]: '图片列表暂未刷新，请点击“刷新图片”重试' }))
      return null
    }
  }
  const refreshSceneGalleryUntil = async (sceneId: string, assetPath = '') => {
    let latest: { items: StorySceneImageItem[]; boundUri: string } | null = null
    for (const delay of [0, 350, 900]) {
      if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay))
      latest = await refreshSceneGallery(sceneId)
      if (latest && (!assetPath || latest.items.some((item) => item.assetPath === assetPath))) return latest
    }
    if (assetPath && !latest?.items.some((item) => item.assetPath === assetPath)) {
      setGalleryHint((prev) => ({ ...prev, [sceneId]: '新图已返回，图片列表仍在同步，请点击“刷新图片”重试' }))
    }
    return latest
  }
  const sceneNodeIdsKey = props.items.map((x) => x.nodeId).join(',')
  useEffect(() => {
    if (!projectId) return
    for (const id of sceneNodeIdsKey.split(',').filter(Boolean)) {
      void refreshSceneGallery(id)
    }
    // 仅按场景 id 集合触发，items 内容变化（编辑提示词）不重复拉取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sceneNodeIdsKey])
  useEffect(() => {
    if (!props.active || !projectId) return undefined
    let refreshTimer: number | undefined
    let pollTimer: number | undefined
    const schedule = () => {
      if (refreshTimer !== undefined) return
      void loadSceneTasks()
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined
        const ids = selectedSceneId ? [selectedSceneId] : sceneNodeIdsKey.split(',').filter(Boolean)
        for (const id of ids) void refreshSceneGallery(id)
      }, 400)
    }
    const startPolling = () => {
      if (pollTimer === undefined) pollTimer = window.setInterval(schedule, 3000)
    }
    const dispose = subscribeProjectAiEvents(projectId, { tasks: schedule, reviews: schedule, coverage: schedule, onUnavailable: startPolling })
    if (!dispose) startPolling()
    schedule()
    return () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      if (pollTimer !== undefined) window.clearInterval(pollTimer)
      dispose?.()
    }
    // 图库随任务、审核和覆盖度信号刷新；选中单幕时只刷新该幕，事件不可用时回退轮询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.active, projectId, sceneNodeIdsKey, selectedSceneId])

  const sceneNameOfReview = (review: ImageReviewRecord) => {
    const hit = props.items.find((x) => String(x.nodeId || '') === String(review.sceneId || '').trim())
    return String(hit?.nodeName || (review.params as any)?.sceneName || review.sceneId || review.targetKey || '场景').trim()
  }

  // 出场事物：优先 plan.scenes[i].promptAssets（场景→事物正向关联）；为空时回退 assets[j].sceneIds 反查
  const sceneAssetsOf = (sceneNodeId: string): SceneBoardAssetRef[] => {
    const nodeId = String(sceneNodeId || '').trim()
    if (!nodeId) return []
    const assets = Array.isArray(props.planAssets) ? props.planAssets : []
    const assetsById = new Map(assets.map((a: any) => [String(a?.id || '').trim(), a]))
    const toEntry = (raw: any) => {
      const id = String(raw?.id || '').trim()
      const full = assetsById.get(id) || raw
      return {
        id,
        name: String(raw?.name || full?.name || id).trim() || id,
        category: String(full?.category || raw?.category || '').trim(),
        locked: Boolean(String(full?.primaryReferenceAssetUri || '').trim())
      }
    }
    const scenes = (props.items || []) as any[]
    const hit = scenes.find((s: any) => String(s?.sceneId || '').trim() === nodeId)
    const promptAssets = Array.isArray(hit?.promptAssets) ? hit.promptAssets : []
    // 2026-11-09 组合视图双源并集：promptAssets（计划快照）∪ assetIds/sceneIds 反推（元素分析新登记的
    // 背景元素/道具只写 assetIds——只读 promptAssets 会在场景要素里漏掉它们）
    const byId = new Map<string, SceneBoardAssetRef>()
    for (const raw of promptAssets) {
      const e = toEntry(raw)
      if (e.id) byId.set(e.id, e)
    }
    for (const a of assets) {
      const aid = String(a?.id || '').trim()
      if (!aid || byId.has(aid)) continue
      const inSceneIds = Array.isArray(a?.sceneIds) && a.sceneIds.map((x: any) => String(x || '').trim()).includes(nodeId)
      const inAssetIds = Array.isArray(hit?.assetIds) && hit.assetIds.map((x: any) => String(x || '').trim()).includes(aid)
      if (inSceneIds || inAssetIds) byId.set(aid, toEntry(a))
    }
    return [...byId.values()]
  }

  const hasSceneImages = (nodeId: string) => {
    const item = props.items.find((it) => it.nodeId === nodeId)
    return Boolean(sceneGallery[nodeId]?.items?.length || sceneGallery[nodeId]?.boundUri || item?.backgroundUri || item?.backgroundUrl)
  }
  const requestRenderScene = async (it: StoryboardBatchItem) => {
    await confirmRerun({ action: '场景出图', hasExisting: hasSceneImages(it.nodeId), run: async () => { await handleRenderScene(it) } })
  }
  // 四张候选按实际出图结果计数；待出图前审核时暂停，不能把等待项算作已生成或继续重复提交。
  const handleRenderFour = async (it: StoryboardBatchItem) => {
    if (fourBusyId || !projectId) return
    if (renderingSceneIds.includes(it.nodeId)) return
    await confirmRerun({ action: '生成 4 张场景候选', hasExisting: hasSceneImages(it.nodeId), run: async () => {
      renderCancelRef.current = false
      setFourBusyId(it.nodeId)
      setFourProgress({ sceneId: it.nodeId, done: 0 })
      setActionHint(`开始生成 4 张候选：${it.nodeName}（串行）`)
      let stopped = false
      try {
        for (let k = 0; k < 4; k++) {
          if (renderCancelRef.current) {
            setActionHint(`已停止：${it.nodeName} 已完成 ${k}/4 张，候选保留`)
            stopped = true
            break
          }
          const outcome = await handleRenderScene(it)
          if (outcome === 'image') {
            setFourProgress({ sceneId: it.nodeId, done: k + 1 })
            continue
          }
          stopped = true
          if (outcome === 'pending') setActionHint(`已暂停：${it.nodeName}需先完成出图前审核，再生成后续候选`)
          if (outcome === 'cancelled') {
            renderCancelRef.current = true
            setActionHint(`已停止：${it.nodeName} 已完成 ${k}/4 张，候选保留`)
          }
          break
        }
        if (!renderCancelRef.current && !stopped) setActionHint(`4 张候选生成完成：${it.nodeName}（在下方候选池选一张「设为背景」）`)
      } finally {
        setFourBusyId('')
      }
    } })
  }
  const handleRenderScene = async (it: StoryboardBatchItem): Promise<'image' | 'pending' | 'error' | 'cancelled'> => {
    if (!projectId || renderingSceneIds.includes(it.nodeId)) return 'error'
    const scenePrompt = String(it.prompt || '').trim()
    if (!scenePrompt) return 'error'
    setRenderingSceneIds((prev) => [...prev, it.nodeId])
    setActionHint(`开始重新出图：${it.nodeName}`)
    try {
      const res = await renderStorySceneAi(projectId, it.nodeId, {
        scenePrompt,
        negativePrompt: String(it.negativePrompt || '').trim(),
        backgroundOnly: true
      })
      if (res.url) setLocalBgUrls((prev) => ({ ...prev, [it.nodeId]: resolveUrl(String(res.url)) }))
      let outcome: 'image' | 'pending' = 'image'
      if (res.pendingReview) {
        const phase = String(res.pendingReview.phase || '')
        if (phase !== 'scene_bind') outcome = 'pending'
        setActionHint(phase === 'scene_bind'
          ? `场景图已生成，待审核绑定：${it.nodeName}（右侧可先预览，审核通过后绑定）`
          : `出图前审核待批准：${it.nodeName}（卡片上可就地批准后自动继续）`)
      } else {
        setActionHint(`场景出图完成：${it.nodeName}`)
        props.onReloadProject?.()
      }
      await Promise.all([refreshReviewsAndCoverage(), refreshSceneGalleryUntil(it.nodeId, res.assetPath)])
      return outcome
    } catch (e: any) {
      const msg = e && e.message ? e.message : String(e)
      const cancelled = Boolean(renderCancelRef.current || msg === 'task_cancelled_by_user')
      setActionHint(cancelled ? `已停止：${it.nodeName}，已有候选保留` : `场景出图失败：${it.nodeName} - ${msg}`)
      return cancelled ? 'cancelled' : 'error'
    } finally {
      setRenderingSceneIds((prev) => prev.filter((x) => x !== it.nodeId))
    }
  }

  const canRerenderAll = Boolean(projectId) && !props.busy && !rerenderAllBusy && props.envReady && props.items.some((x) => getScenePromptAlignment(x).ready)
  const handleRerenderAll = async (confirmed = false) => {
    if (!projectId || rerenderAllBusy) return
    const targets = props.items.filter((x) => getScenePromptAlignment(x).ready)
    if (!targets.length) {
      setActionHint('没有中英文双稿已对齐的场景，请先对齐提示词')
      return
    }
    if (!confirmed) {
      await confirmRerun({ action: '全部场景重渲', hasExisting: targets.some((it) => hasSceneImages(it.nodeId) || it.backgroundUri || it.backgroundUrl), run: () => handleRerenderAll(true) })
      return
    }
    renderCancelRef.current = false
    setRerenderAllBusy(true)
    setActionHint(`开始全部重渲：共 ${targets.length} 个场景（逐个串行）`)
    let ok = 0
    let skipped = 0
    let failed = 0
    try {
      for (const it of targets) {
        if (renderCancelRef.current) {
          setActionHint(`已停止：成功 ${ok} / 待审核或跳过 ${skipped} / 失败 ${failed}，已完成图保留`)
          break
        }
        if (pendingReviewsRef.current.some((r) => String(r.sceneId || '').trim() === String(it.nodeId || '').trim())) {
          skipped += 1
          setActionHint(`跳过：${it.nodeName}（存在待审核项，先就地处理）`)
          continue
        }
        setRenderingSceneIds((prev) => (prev.includes(it.nodeId) ? prev : [...prev, it.nodeId]))
        let resultAssetPath = ''
        try {
          const res = await renderStorySceneAi(projectId, it.nodeId, {
            scenePrompt: String(it.prompt || '').trim(),
            negativePrompt: String(it.negativePrompt || '').trim(),
            backgroundOnly: true
          })
          resultAssetPath = res.assetPath
          if (res.url) setLocalBgUrls((prev) => ({ ...prev, [it.nodeId]: resolveUrl(String(res.url)) }))
          if (res.pendingReview) {
            skipped += 1
            setActionHint(`待审核：${it.nodeName}（已挂起审核，卡片上可就地批准）`)
          } else {
            ok += 1
            setActionHint(`重渲完成：${it.nodeName}`)
          }
        } catch (e: any) {
          if (renderCancelRef.current) {
            setActionHint(`已停止：${it.nodeName}，已完成图保留`)
            break
          }
          failed += 1
          const msg = e && e.message ? e.message : String(e)
          setActionHint(`重渲失败：${it.nodeName} - ${msg}`)
        } finally {
          setRenderingSceneIds((prev) => prev.filter((x) => x !== it.nodeId))
        }
        await Promise.all([refreshReviewsAndCoverage(), refreshSceneGalleryUntil(it.nodeId, resultAssetPath)])
      }
      if (!renderCancelRef.current) setActionHint(`全部重渲结束：成功 ${ok} / 待审核或跳过 ${skipped} / 失败 ${failed}`)
      if (ok > 0) props.onReloadProject?.()
    } finally {
      setRerenderAllBusy(false)
    }
  }

  const handleBindSceneImage = async (it: StoryboardBatchItem, assetPath: string) => {
    if (!projectId || galleryBusy[it.nodeId]) return
    setGalleryBusy((prev) => ({ ...prev, [it.nodeId]: true }))
    setGalleryHint((prev) => ({ ...prev, [it.nodeId]: '' }))
    try {
      await bindStorySceneImageAi(projectId, it.nodeId, assetPath)
      setLocalBgUrls((prev) => ({ ...prev, [it.nodeId]: toProjectAssetUrl(projectId, assetPath) }))
      setActionHint(`已设为背景：${it.nodeName}`)
      setGallerySelected((prev) => ({ ...prev, [it.nodeId]: '' }))
      await Promise.all([refreshSceneGalleryUntil(it.nodeId, assetPath), refreshReviewsAndCoverage()])
      props.onReloadProject?.()
    } catch (e: any) {
      const msg = e && e.message ? e.message : String(e)
      setGalleryHint((prev) => ({ ...prev, [it.nodeId]: `设为背景失败：${msg}` }))
    } finally {
      setGalleryBusy((prev) => ({ ...prev, [it.nodeId]: false }))
    }
  }

  const handleDeleteSceneImage = async (it: StoryboardBatchItem, item: StorySceneImageItem) => {
    if (!projectId || galleryBusy[it.nodeId]) return
    const ok = await dlgConfirm(`确认删除该场景图版本？删除后不可恢复。\n${item.assetPath}`, { danger: true, okText: '删除' })
    if (!ok) return
    setGalleryBusy((prev) => ({ ...prev, [it.nodeId]: true }))
    setGalleryHint((prev) => ({ ...prev, [it.nodeId]: '' }))
    try {
      await deleteStorySceneImageAi(projectId, it.nodeId, item.assetPath)
      setActionHint(`已删除场景图版本：${it.nodeName}`)
      setGallerySelected((prev) => ({ ...prev, [it.nodeId]: '' }))
      await refreshSceneGallery(it.nodeId)
    } catch (e: any) {
      const msg = e && e.message ? e.message : String(e)
      setGalleryHint((prev) => ({ ...prev, [it.nodeId]: /bound_image/i.test(msg) ? '当前绑定背景不可删除' : `删除失败：${msg}` }))
    } finally {
      setGalleryBusy((prev) => ({ ...prev, [it.nodeId]: false }))
    }
  }

  // 待审核就地处置：批准出图前审核后服务端自动继续出图；批准场景图绑定后已写回 story.json
  const decideReview = async (review: ImageReviewRecord, approved: boolean) => {
    if (!projectId || reviewBusyIds.includes(review.reviewId)) return
    setReviewBusyIds((prev) => [...prev, review.reviewId])
    try {
      if (approved) await approveImageReviewAi(projectId, review.reviewId)
      else await rejectImageReviewAi(projectId, review.reviewId)
      setActionHint(`${approved ? '已批准' : '已拒绝'}：${reviewPhaseLabel(review.phase)} / ${sceneNameOfReview(review)}`)
      const resultPath = approved ? String((review as any).resultImagePath || '').trim() : ''
      if (resultPath) setLocalBgUrls((prev) => ({ ...prev, [String(review.sceneId || '').trim()]: toProjectAssetUrl(projectId, resultPath) }))
      if (approved && review.phase === 'scene_bind') props.onReloadProject?.()
      await Promise.all([refreshReviewsAndCoverage(), refreshSceneGalleryUntil(String(review.sceneId || '').trim(), resultPath)])
    } catch (e: any) {
      void dlgAlert(`审核操作失败：${e && e.message ? e.message : String(e)}`)
    } finally {
      setReviewBusyIds((prev) => prev.filter((x) => x !== review.reviewId))
    }
  }

  // 单幕事实派生（列表卡与详情卡共用同一推导）：状态/缩略图/提示词就绪/禁用文案/绑定信息
  const sceneFacts = (it: StoryboardBatchItem) => {
    const task = sceneTaskOf(it)
    const rendering = renderingSceneIds.includes(it.nodeId) || Boolean(task && !task.done)
    const sceneReview = pendingReviews.find((r) => String(r.sceneId || '').trim() === String(it.nodeId || '').trim()) || null
    const covScene = coverage && Array.isArray(coverage.scenes?.items)
      ? coverage.scenes.items.find((s) => String(s.id || '') === String(it.nodeId || '')) || null
      : null
    let sceneStatusLabel = '待出图'
    let sceneStatusTone = ''
    if (rendering) {
      sceneStatusLabel = '出图中…'
      sceneStatusTone = 'pending'
    } else if (sceneReview) {
      sceneStatusLabel = '待审核'
      sceneStatusTone = 'pending'
    } else if (covScene?.status === 'bound') {
      sceneStatusLabel = '已绑定'
      sceneStatusTone = 'ok'
    } else if (task?.stage === 'waiting_review') {
      sceneStatusLabel = '待审核'
      sceneStatusTone = 'pending'
    } else if (task && task.done && ['error', 'failed', 'blocked', 'cancelled'].includes(task.stage)) {
      sceneStatusLabel = task.stage === 'cancelled' ? '已停止' : '出图失败'
      sceneStatusTone = 'bad'
    } else if (covScene?.status === 'rendered') {
      sceneStatusLabel = '已出图待绑定'
      sceneStatusTone = 'warn'
    } else if (String(it.backgroundUrl || '').trim()) {
      sceneStatusLabel = '已绑定'
      sceneStatusTone = 'ok'
    }
    const covThumb = covScene && covScene.backgroundExists ? toProjectAssetUrl(projectId, String(covScene.backgroundUri || '')) : ''
    const gallery = sceneGallery[it.nodeId]
    const galleryThumb = sceneImagesUrl(gallery?.items.find((item) => item.isBound)?.url || gallery?.items[0]?.url || '')
    const thumbUrl = String(localBgUrls[it.nodeId] || '').trim() || covThumb || String(it.backgroundUrl || '').trim() || galleryThumb
    const promptEmpty = !String(it.prompt || '').trim()
    const alignment = getScenePromptAlignment(it)
    const renderDisabled = !projectId || props.busy || rerenderAllBusy || rendering || promptEmpty || !alignment.ready || !props.envReady
    const renderTitle = promptEmpty ? '先生成英文提示词' : (!alignment.ready ? `${alignment.hint}，暂不能出图` : (!props.envReady ? '请先通过环境体检' : '按当前已对齐的英文提示词出图'))
    const bindTimeText = formatBindTime(String(covScene?.bindApprovedAt || ''))
    const bindInfo = covScene
      ? (covScene.status === 'bound' ? `已绑定${bindTimeText ? ` · ${bindTimeText}` : ''}` : (covScene.backgroundExists ? '已出图，待审核绑定' : '未绑定背景'))
      : (gallery?.boundUri ? '已绑定' : (thumbUrl ? '待选择设为背景' : '未绑定背景'))
    const promptReady = alignment.ready
    const displayTask = task && task.stage === 'waiting_review' && (covScene?.status === 'bound' || gallery?.boundUri)
      ? { ...task, stage: 'done', current: Math.max(Number(task.current) || 0, Number(task.total) || 1), message: `场景已绑定：${it.nodeName}`, updatedAt: String(covScene?.bindApprovedAt || task.updatedAt) }
      : task
    return { task: displayTask, rendering, sceneReview, sceneStatusLabel, sceneStatusTone, thumbUrl, promptEmpty, renderDisabled, renderTitle, bindInfo, promptReady }
  }

  const sceneImagesUrl = (rawUrl: string) => {
    const value = String(rawUrl || '').trim()
    if (!value) return ''
    if (/^https?:\/\//i.test(value) || value.startsWith('data:')) return value
    return resolveUrl(value.startsWith('/') ? value : `/${value}`)
  }

  const totalLabel = useMemo(() => {
    if (!coverage) return ''
    if (!coverage.hasPlan) return ''
    return `场景绑定 ${coverage.scenes.bound}/${coverage.scenes.total} · 待审核 ${coverage.overall.pendingReviews} · 总进度 ${coverage.overall.percent}%`
  }, [coverage])
  const promptSummary = countScenePromptAlignment(props.items)
  const openRequirements = () => window.open(resolveUrl(SCENE_PROMPT_REQUIREMENTS_PATH), '_blank', 'noopener,noreferrer')

  if (!projectId) return null

  return (
    <div className="scene-bg-board">
      <div className="scene-bg-board-toolbar story-lock-grid-toolbar">
        <span className="ai-coverage-summary-label">出图总账</span>
        {totalLabel ? <span className={`ai-storyboard-status ${coverage && coverage.scenes.bound === coverage.scenes.total ? 'ok' : 'pending'}`}>{totalLabel}</span> : <span className="hint">等待总账数据…</span>}
        {/* 2026-11-06 三色语义：全对齐=绿 / 有缺=黄（场景提示词失败项经待审核徽标红色呈现，此处不重复） */}
        <span className={`ai-storyboard-status ${promptSummary.total > 0 && promptSummary.aligned >= promptSummary.total ? 'ok' : 'warn'}`} title="场景提示词双稿对齐计数">
          双稿对齐 {promptSummary.aligned}/{promptSummary.total}{promptSummary.pendingGeneration ? ` · 待生成 ${promptSummary.pendingGeneration}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn scene-prompt-doc-link" type="button" onClick={openRequirements}>生成说明与需求文档</button>
        <button
          className={`btn ${promptSummary.pendingGeneration ? 'lock-action-primary' : 'secondary'}`}
          type="button"
          onClick={() => props.onGenerateAllPrompts?.()}
          disabled={Boolean(props.promptGenBusy) || props.busy || !props.items.length}
          title="按全部场景批量生成英文执行稿并同源翻译中文（复用现有全局锚点；全量生成会覆盖场景现稿）"
        >
          {props.alignBusy ? '对齐中…' : props.promptGenBusy ? '生成中…' : '批量生成提示词'}
        </button>
        <button
          className={`btn ${promptSummary.pendingAlignment ? 'lock-action-primary' : 'secondary'}`}
          type="button"
          onClick={() => props.onAlignAllPrompts?.()}
          disabled={Boolean(props.promptGenBusy) || props.busy || !promptSummary.pendingAlignment}
          title="以每幕现有英文执行稿为源，逐项翻译正向与负向中文并记录同源关系"
        >
          {props.alignBusy ? '对齐中…' : `对齐中文（${promptSummary.pendingAlignment}）`}
        </button>
        <button className="btn secondary" type="button" onClick={() => void handleRerenderAll()} disabled={!canRerenderAll} title="按各场景已对齐的英文提示词逐个重新出图（串行；有待审核项的场景会跳过）">
          {rerenderAllBusy ? '重渲中…' : '全部重渲'}
        </button>
      </div>
      {selectedSceneId ? (
        <div className="scene-bg-board-cards">
        {props.items.filter((x) => x.nodeId === selectedSceneId).map((it) => {
          const sceneIndex = props.items.findIndex((item) => item.nodeId === it.nodeId)
          const promptReviewTone = getPromptReviewTone(it.promptReview)
          const sceneAssets = sceneAssetsOf(it.nodeId)
          const { task, rendering, sceneReview, sceneStatusLabel, sceneStatusTone, thumbUrl, promptEmpty, renderDisabled, renderTitle, bindInfo } = sceneFacts(it)
          const gallery = sceneGallery[it.nodeId] || null
          const galleryItems = gallery?.items || []
          const isImageBound = (img: StorySceneImageItem) => Boolean(img.isBound) || (Boolean(gallery?.boundUri) && img.assetPath === String(gallery?.boundUri || ''))
          const galleryBusyNow = Boolean(galleryBusy[it.nodeId])
          const bodyCollapsedNow = Boolean(bodyCollapsed[it.nodeId])
          const alignment = getScenePromptAlignment(it)
          const showSection = (section: 'prompt' | 'images') => {
            setSceneDetailSection(section)
            setBodyCollapsed((prev) => ({ ...prev, [it.nodeId]: false }))
            window.setTimeout(() => {
              try { document.getElementById(`scene-${section}-${it.nodeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } catch {}
            }, 80)
          }
          const navigateScene = (dir: 1 | -1) => {
            const nextIndex = (sceneIndex + dir + props.items.length) % props.items.length
            openSceneDetail(String(props.items[nextIndex]?.nodeId || ''))
          }
          return (
            <DetailWorkspace
              ariaLabel="场景出图工作区"
              title={`#${sceneIndex + 1} ${it.nodeName}`}
              className="scene-detail-card"
              bodyClassName="scene-detail-workspace-body"
              badges={(
                <>
                  <span className="story-lock-thing-cat">场景图</span>
                  <span className={`ai-storyboard-status ${sceneStatusTone}`.trim()}>{sceneStatusLabel}</span>
                  <span className={`ai-storyboard-status ${alignment.ready ? 'ok' : 'pending'}`} title={alignment.hint}>{alignment.label}</span>
                </>
              )}
              previousDisabled={props.items.length < 2}
              nextDisabled={props.items.length < 2}
              onPrevious={() => navigateScene(-1)}
              onNext={() => navigateScene(1)}
              onClose={() => setSelectedSceneId('')}
              navItems={[
                { key: 'prompt', label: '提示词', active: sceneDetailSection === 'prompt', onClick: () => showSection('prompt') },
                { key: 'images', label: '图片管理', active: sceneDetailSection === 'images', onClick: () => showSection('images') }
              ]}
            >
            <div key={it.nodeId} className="scene-detail-content">
              <div className="story-lock-global-head scene-detail-context">
                <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
                  {/* 2026-11-10 背景构成清单（用户裁决：底图/背景内/前景分层不混乱；未锁元素一键去锁）——
                      出图前看清"这张背景由什么合成"：底图锚点 + 背景内元素立绘 + 前景摆位 */}
                  {(() => {
                    const locAssets = sceneAssets.filter((a) => a.category === 'location')
                    const sceneryLayer = sceneAssets.filter((a) => a.category === 'scenery')
                    const thingLayer = sceneAssets.filter((a) => a.category !== 'location' && a.category !== 'scenery')
                    const renderAssetBtn = (a: SceneBoardAssetRef, ai: number) => (
                      <React.Fragment key={a.id || `${a.name}-${ai}`}>
                        {ai > 0 ? '、' : null}
                        <button
                          type="button"
                          className="ai-storyboard-scene-asset-link"
                          title={`打开管理位：${a.name}${a.category === 'scenery' && !a.locked ? '（未锁定，点击去出图锁定）' : ''}`}
                          onClick={() => props.onOpenAssetLock?.({ id: a.id, name: a.name, category: a.category })}
                        >
                          {a.name}（{a.locked ? '已锁' : '未锁'}）
                        </button>
                      </React.Fragment>
                    )
                    return (
                      <div className="ai-storyboard-scene-assets" style={{ display: 'grid', gap: 3 }}>
                        <div>
                          底图锚点：{locAssets.length
                            ? locAssets.map((a, ai) => (
                              <React.Fragment key={a.id || `${a.name}-${ai}`}>
                                {ai > 0 ? '、' : null}
                                <button
                                  type="button"
                                  className="ai-storyboard-scene-asset-link"
                                  title={`地点模板锚点词烘进底图：${a.name}`}
                                  onClick={() => props.onOpenAssetLock?.({ id: a.id, name: a.name, category: a.category })}
                                >
                                  {a.name}
                                </button>
                              </React.Fragment>
                            ))
                            : '无（纯环境）'}
                        </div>
                        <div>
                          背景内元素：{sceneryLayer.length
                            ? sceneryLayer.map((a, ai) => renderAssetBtn(a, ai))
                            : '无'}
                          {sceneryLayer.some((a) => !a.locked) ? <span className="ai-storyboard-status warn" style={{ marginLeft: 6 }}>有未锁元素，出图前建议先锁定</span> : null}
                        </div>
                        <div>
                          前景摆位：{thingLayer.length
                            ? thingLayer.map((a, ai) => renderAssetBtn(a, ai))
                            : '无（纯场景）'}
                        </div>
                      </div>
                    )
                  })()}
                  <div className="story-lock-workspace-chip-row">
                    {it.promptReview ? (
                      <span className={`ai-storyboard-status ${promptReviewTone.cls}`}>
                        AI 评分 {Number.isFinite(Number((it.promptReview as any)?.ai?.score)) ? `${Math.round(Number((it.promptReview as any).ai.score))}/100` : 'n/a'}
                      </span>
                    ) : null}
                    {props.generatingNodeId === it.nodeId && props.busy && (it.status === 'generating' || it.status === 'applying') ? (
                      <span className="ai-storyboard-status pending">耗时 {((props.generatingNodeElapsedMs || 0) / 1000).toFixed(1)}s</span>
                    ) : null}
                  </div>
                  {sceneReview ? (
                    <div className="story-lock-workspace-chip-row">
                      <span className="ai-storyboard-status pending">{reviewPhaseLabel(sceneReview.phase)}待处理</span>
                      <button className="btn secondary" type="button" style={{ padding: '2px 10px', fontSize: 12 }} disabled={reviewBusyIds.includes(sceneReview.reviewId)} onClick={() => void decideReview(sceneReview, true)}>
                        批准
                      </button>
                      <button className="btn secondary" type="button" style={{ padding: '2px 10px', fontSize: 12, color: '#fca5a5' }} disabled={reviewBusyIds.includes(sceneReview.reviewId)} onClick={() => void decideReview(sceneReview, false)}>
                        拒绝
                      </button>
                    </div>
                  ) : null}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn secondary" type="button" onClick={() => props.onReviewItemPrompt(it.nodeId)} disabled={props.busy || props.promptReviewingNodeId === it.nodeId || !String(it.prompt || it.userInput || '').trim()}>
                    {props.promptReviewingNodeId === it.nodeId ? '评分中…' : 'AI 评分'}
                  </button>
                  <button className="btn secondary" type="button" onClick={() => props.onApplyItemPromptReview(it.nodeId)} disabled={props.busy || !it.promptReview?.ai?.optimizedPrompt}>
                    继续强化提示词
                  </button>
                  <button className="btn secondary" type="button" onClick={() => void requestRenderScene(it)} disabled={renderDisabled} title={renderTitle}>
                    {rendering ? '出图中…' : '重新出图'}
                  </button>
                  {props.onArrangeScene ? (
                    <button
                      className="btn secondary"
                      type="button"
                      onClick={() => props.onArrangeScene?.(it.nodeId)}
                      title="关闭本面板，在合成工作室画布中编排该场景的角色与事物站位"
                    >
                      编排站位
                    </button>
                  ) : null}
                  {props.onEditSceneAssets ? (
                    <button
                      className="btn secondary"
                      type="button"
                      onClick={() => props.onEditSceneAssets?.(it.nodeId)}
                      title="跳转到蓝图层该幕：预演视图 + 要素分配（增删本幕元素，写资产计划同源）"
                    >
                      编辑元素
                    </button>
                  ) : null}
                </div>
              </div>
              {/* 2026-11-02 卡片正文整体展开/收缩：一条通栏开关（同「场景原文」行内展开钮样式），收起时只留卡片头 */}
              <div className="scene-bg-card-body-head">
                <span className="scene-bg-card-body-head-label">
                  {thumbUrl ? '已绑定背景' : '未绑定背景'}
                  {String(it.promptZh || '').trim() ? ' · 提示词已生成' : ' · 提示词待生成'}
                </span>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => setBodyCollapsed((prev) => ({ ...prev, [it.nodeId]: !bodyCollapsedNow }))}
                  title={bodyCollapsedNow ? '展开整条卡片：场景原文 + 提示词 + 背景图' : '收起整条卡片，只留标题行'}
                >
                  {bodyCollapsedNow ? '展开' : '收起'}
                </button>
              </div>
              {!bodyCollapsedNow ? (
              <div className="ai-storyboard-scene-card-main scene-bg-detail-col">
                <div id={`scene-prompt-${it.nodeId}`} className="story-lock-prompt-stack" style={{ flex: 1, minWidth: 0 }}>
                  <div className="story-lock-prompt-section">
                    <div className="story-lock-global-subhead">
                      <div className="story-lock-global-subtitle">场景原文</div>
                    </div>
                    <div className="story-lock-workspace-log-box ai-storyboard-scene-source">
                      {/* 2026-11-02 行内展开钮已删：整条卡片的展开/收起来自上方通栏开关 */}
                      <pre>{it.userInput || '(无场景文本)'}</pre>
                    </div>
                  </div>
                  {it.promptReview ? (
                    <div className="story-lock-prompt-section">
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span className={`ai-storyboard-status ${promptReviewTone.cls}`}>
                          AI 评分：{Number.isFinite(Number((it.promptReview as any)?.ai?.score)) ? `${Math.round(Number((it.promptReview as any).ai.score))}/100` : 'n/a'}
                        </span>
                        <span className="hint" style={{ color: promptReviewTone.color }}>{(it.promptReview as any)?.ai?.summary}</span>
                      </div>
                      {(it.promptReview as any)?.ai?.suggestions?.length ? (
                        <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>建议：{(it.promptReview as any).ai.suggestions.slice(0, 3).join('；')}</div>
                      ) : null}
                      {(it.promptReview as any)?.aiError?.message ? (
                        <div className="hint" style={{ color: '#fca5a5' }}>AI 回退：{(it.promptReview as any).aiError.message}</div>
                      ) : null}
                    </div>
                  ) : null}
                  {/* 2026-11-02 提示词区常显全文（AutoGrow 自适应）；整条卡片的展开/收起来自上方通栏开关，此处不再单独设折叠 */}
                  <div className="story-lock-prompt-section">
                    <div className="story-lock-global-subhead">
                      <div className="story-lock-global-subtitle">提示词（正/负向） <span className={`ai-storyboard-status ${alignment.ready ? 'ok' : 'pending'}`} title={alignment.hint}>{alignment.label}</span></div>
                      <div className="scene-prompt-actions">
                        <button
                          className={`btn ${alignment.status === 'missing' ? 'lock-action-primary' : 'secondary'}`}
                          type="button"
                          onClick={() => props.onGeneratePrompt?.(it.nodeId)}
                          disabled={Boolean(props.promptGenBusy) || props.busy}
                          title="AI 基于场景原文与故事设定生成英文执行稿，正向、负向分别同源翻译为中文"
                        >
                          {props.generatingNodeId === it.nodeId && props.promptGenBusy ? '生成中…' : 'AI 生成提示词'}
                        </button>
                        <button
                          className={`btn ${alignment.ready ? 'secondary' : 'lock-action-primary'}`}
                          type="button"
                          onClick={() => props.onAlignPrompt?.(it.nodeId)}
                          disabled={Boolean(props.promptGenBusy) || props.busy || !String(it.prompt || '').trim() || !String(it.negativePrompt || '').trim()}
                          title={alignment.hint}
                        >
                          {props.aligningNodeId === it.nodeId ? '对齐中…' : alignment.ready ? '重新对齐中文' : '对齐中文'}
                        </button>
                      </div>
                    </div>
                    {it.promptGeneration ? (
                      <div className="scene-prompt-generation-note">
                        <span><b>生成说明：</b>场景分析生成英文，正向/负向分别英译中；{it.promptGeneration.reviewIncluded ? '已附评审' : '评审未完成'} · 需求 v{it.promptGeneration.requirementVersion} · {formatBindTime(it.promptGeneration.createdAt)}</span>
                        <button type="button" className="scene-prompt-doc-link" onClick={openRequirements}>打开需求文档</button>
                      </div>
                    ) : null}
                    <>
                        <div className="story-lock-global-subhead" style={{ marginTop: 2 }}>
                          <div className="story-lock-global-subtitle" style={{ fontSize: 12 }}>正向提示词</div>
                        </div>
                        <div className="story-lock-prompt-grid">
                          <div className="story-lock-prompt-field">
                            <span>中文 {pairBadge(alignment.positive)}</span>
                            <AutoGrowTextarea value={it.promptZh || ''} placeholder="AI 生成或手工编辑的中文场景提示词" onChange={(v) => props.onChangeItem(it.nodeId, { promptZh: v })} />
                          </div>
                          <div className="story-lock-prompt-field">
                            <span>
                              英文 {pairBadge(alignment.positive)}
                              <button
                                className="story-lock-mini-btn"
                                type="button"
                                onClick={() => props.onTranslatePrompt?.(it.nodeId, 'positive')}
                                disabled={Boolean(props.translatingScope) || props.busy || !String(it.promptZh || '').trim()}
                                title="以当前正向中文稿翻译英文，并记录新的同源关系"
                              >
                                {props.translatingScope === `scene:positive:${it.nodeId}` ? '翻译中…' : '中转英'}
                              </button>
                            </span>
                            <AutoGrowTextarea value={it.prompt || ''} placeholder="英文场景提示词（用于出图）" onChange={(v) => props.onChangeItem(it.nodeId, { prompt: v })} />
                          </div>
                        </div>
                        <div className="story-lock-global-subhead" style={{ marginTop: 6 }}>
                          <div className="story-lock-global-subtitle" style={{ fontSize: 12 }}>负向提示词</div>
                        </div>
                        <div className="story-lock-prompt-grid">
                          <div className="story-lock-prompt-field">
                            <span>中文 {pairBadge(alignment.negative)}</span>
                            <AutoGrowTextarea value={it.negativePromptZh || ''} placeholder="中文场景负向提示词（AI 生成时随正向一起产出，可手编）" onChange={(v) => props.onChangeItem(it.nodeId, { negativePromptZh: v })} />
                          </div>
                          <div className="story-lock-prompt-field">
                            <span>
                              英文 {pairBadge(alignment.negative)}
                              <button
                                className="story-lock-mini-btn"
                                type="button"
                                onClick={() => props.onTranslatePrompt?.(it.nodeId, 'negative')}
                                disabled={Boolean(props.translatingScope) || props.busy || !String(it.negativePromptZh || '').trim()}
                                title="以当前负向中文稿翻译英文，并记录新的同源关系"
                              >
                                {props.translatingScope === `scene:negative:${it.nodeId}` ? '翻译中…' : '中转英'}
                              </button>
                            </span>
                            <AutoGrowTextarea value={it.negativePrompt || ''} placeholder="英文场景负向提示词（用于出图）" onChange={(v) => props.onChangeItem(it.nodeId, { negativePrompt: v })} />
                          </div>
                        </div>
                    </>
                  </div>
                  {it.note ? <div className="hint">{it.note}</div> : null}
                </div>
                {/* 右侧图片管理：当前预览与真实候选版本，生成/审核信号自动刷新，也可手动刷新。 */}
                <div id={`scene-images-${it.nodeId}`} className="scene-bg-render-sec">
                  <div className="story-lock-global-subhead" style={{ marginTop: 4 }}>
                    <div className="story-lock-global-subtitle">图片管理<span className="hint" style={{ fontWeight: 400 }}>（{galleryItems.length} 个版本）</span></div>
                    <div className="scene-prompt-actions">
                      <button className="btn secondary" type="button" title="重新读取当前场景的图片列表" onClick={() => void (async () => {
                        const refreshed = await refreshSceneGalleryUntil(it.nodeId)
                        if (refreshed) setActionHint(`图片列表已刷新：${it.nodeName}`)
                      })()}>刷新图片</button>
                      <button className="btn lock-action-primary" type="button" disabled={renderDisabled || fourBusyId === it.nodeId} title={renderTitle} onClick={() => void handleRenderFour(it)}>
                        {fourBusyId === it.nodeId ? '出图中（4 张串行）…' : '生成 4 张候选'}
                      </button>
                    </div>
                  </div>
                  <SceneGenerationStatus
                    task={task}
                    batchDone={fourProgress?.sceneId === it.nodeId ? fourProgress.done : null}
                    batchActive={fourBusyId === it.nodeId}
                    now={clockNow}
                  />
                  <div className="scene-bg-current-preview" data-testid="scene-current-preview">
                    {thumbUrl ? (
                      <>
                        <button type="button" className="scene-bg-current-preview-main" title="点击查看大图" onClick={() => window.open(thumbUrl, '_blank', 'noopener,noreferrer')}>
                          <img src={thumbUrl} alt={`${it.nodeName}当前背景预览`} onLoad={(e) => recordImgSize(thumbUrl, e.currentTarget)} />
                        </button>
                        <div className="scene-bg-current-caption">
                          <span>当前预览</span>
                          <span>{bindInfo}</span>
                          <span>{imgSizes[thumbUrl] || ''}</span>
                        </div>
                      </>
                    ) : <div className="scene-bg-current-preview-empty">尚未生成场景图</div>}
                  </div>
                  {galleryItems.length ? (
                    <div className="scene-bg-cand-grid">
                      {galleryItems.map((img) => {
                        const bound = isImageBound(img)
                        const src = sceneImagesUrl(img.url)
                        const size = imgSizes[src] || ''
                        return (
                          <div key={img.assetPath} className={`scene-bg-cand${bound ? ' bound' : ''}`}>
                            <button type="button" className="scene-bg-cand-img" title="点击查看大图" onClick={() => window.open(src, '_blank', 'noopener,noreferrer')}>
                              <img src={src} alt="" onLoad={(e) => recordImgSize(src, e.currentTarget)} />
                              {bound ? <span className="scene-bg-cand-badge">当前背景</span> : null}
                            </button>
                            <span className="scene-bg-cand-size">{size || '…'}</span>
                            <div className="scene-bg-cand-ops">
                              {bound ? <span className="hint">已绑定</span> : (
                                <button className="btn lock-action-primary" type="button" style={{ padding: '2px 8px' }} disabled={galleryBusyNow} onClick={() => void handleBindSceneImage(it, img.assetPath)}>设为背景</button>
                              )}
                              <button className="btn secondary" type="button" style={{ padding: '2px 8px', fontSize: 11, color: '#fca5a5' }} disabled={galleryBusyNow || bound} title={bound ? '当前绑定背景不可删除' : '删除该候选（文件保留磁盘）'} onClick={() => void handleDeleteSceneImage(it, img)}>删除</button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="scene-bg-cand-empty hint">{localBgUrls[it.nodeId] ? '新图已显示，候选列表同步中…' : thumbUrl ? '候选池为空（当前绑定来自历史数据）。点「重新出图」生成候选。' : '还没有候选图。点「生成 4 张候选」或「重新出图」按当前提示词出图。'}</div>
                  )}
                  {galleryHint[it.nodeId] ? <div className="hint ai-storyboard-scene-gallery-hint">{galleryHint[it.nodeId]}</div> : null}
                </div>
              </div>
              ) : null}
            </div>
            </DetailWorkspace>
          )
        })}
        </div>
      ) : (
        <div className="story-lock-cardwall-group scene-bg-list-group">
          <div className="story-lock-prompt-group-head">
            <span className="story-lock-prompt-group-title">场景图</span>
            <span className="hint">（{props.items.length}）</span>
          </div>
          <div className="hint" style={{ margin: '4px 0 10px' }}>点卡片进入该幕工作区；与事物详情共用关闭、上下切换和分区导航。</div>
          {actionHint ? <div className="hint" style={{ color: '#86efac', marginBottom: 8 }}>{actionHint}</div> : null}
          <div className="story-lock-cardwall scene-bg-list">
            {props.items.map((it, idx) => {
              const f = sceneFacts(it)
              return (
                <div key={it.nodeId} className="story-lock-thing-card scene-bg-item">
                  <button type="button" className="scene-bg-item-main story-lock-thing-main" onClick={() => openSceneDetail(it.nodeId)} title="进入该幕出图工作区">
                    <span className={`story-lock-thing-img scene-bg-item-thumb ${f.thumbUrl ? 'ready' : 'missing'}`}>{f.thumbUrl ? <img src={f.thumbUrl} alt={it.nodeName} /> : <span className="hint">暂无场景图</span>}</span>
                    <span className="story-lock-thing-info scene-bg-item-info">
                      <span className="story-lock-thing-name scene-bg-item-title">#{idx + 1} {it.nodeName}</span>
                      <span className="story-lock-thing-meta story-lock-workspace-chip-row">
                        <span className={`ai-storyboard-status ${f.sceneStatusTone}`.trim()}>{f.sceneStatusLabel}</span>
                        <span className={`ai-storyboard-status ${f.promptReady ? 'ok' : 'pending'}`}>双稿{f.promptReady ? '已对齐' : '待处理'}</span>
                      </span>
                    </span>
                  </button>
                  <span className="scene-bg-item-actions">
                    <button type="button" className="btn secondary" disabled={f.renderDisabled} title={f.renderTitle} onClick={() => void requestRenderScene(it)}>
                      {f.rendering ? '出图中…' : '重新出图'}
                    </button>
                    <button type="button" className="btn secondary" onClick={() => openSceneDetail(it.nodeId)} title="进入该幕出图工作区">详情</button>
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
