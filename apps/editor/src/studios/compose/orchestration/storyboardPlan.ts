import {
  type AiBackgroundRequest,
  type ProjectV1,
  type StoryboardPromptQualityReview,
  type StoryAssetGalleryEntry,
  type StoryAssetPlan
} from '../../../api'

export type StoryboardSceneAiBackgroundRequest = AiBackgroundRequest & {
  assetRefs?: Array<{
    assetId?: string
    assetName?: string
    assetType?: string
    assetPath?: string
    assetUri?: string
    weight?: number
  }>
}

export type StoryboardBatchState = {
  entitySpec: string
  storyBibleJson: string
  continuity: {
    ipadapterEnabled: boolean
    requireCharacterRefs: boolean
    controlnetEnabled: boolean
  }
  globalPromptZh: string
  globalPrompt: string
  globalNegativePromptZh: string
  globalNegativePrompt: string
  style: 'picture_book' | 'cartoon' | 'national_style' | 'watercolor'
  aspectRatio: '9:16' | '16:9' | '1:1' | '9:1'
  width: number
  height: number
  model?: string
  loras?: string[]
  size?: string
  responseFormat?: 'url' | 'b64_json'
  watermark?: boolean
  sequentialImageGeneration?: 'auto' | 'disabled'
  steps: number
  cfgScale: number
  sampler: string
  scheduler: string
}

export type StoryboardLockAssetPromptDraft = {
  promptZh: string
  promptEn: string
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

export type StoryboardScenePromptStore = {
  nodeId: string
  nodeName: string
  userInput: string
  promptZh?: string
  prompt: string
  negativePromptZh?: string
  negativePrompt: string
  promptReview?: StoryboardPromptQualityReview | null
  updatedAt: string
}

export type StoryboardPromptMeta = {
  style: string
  aspectRatio: string
  updatedAt: string
  globalReview?: StoryboardPromptQualityReview | null
}

export type StoryboardOpenCheckState = {
  checking: boolean
  checkedAt: string
  ok: boolean
  serverOk: boolean
  promptOk: boolean
  imageOk: boolean
  continuityBindingsOk: boolean
  promptProvider: string
  promptModel: string
  imageProvider: string
  imageModel: string
  // 2026-09-09：studio 生效 LoRA 列表——项目未配置 batch draft 时状态行应显示全局默认而非 (none)（乌鸦喝水实测显示缺陷）
  imageLoras: string[]
  summary: string
  issues: string[]
  details: string[]
}

export type StoryAssetPlanAsset = {
  id: string
  name: string
  category?: string
  lockProfile?: string
  lockWorkflow?: string
  renderStrategy?: string
  sceneCount?: number
  referenceStatus?: string
  primaryReferenceAssetId?: string
  primaryReferenceAssetUri?: string
  referencePromptHint?: string
  referencePromptZh?: string
  referencePromptEn?: string
}

export type StoryAssetGalleryState = {
  assetId: string
  assetName: string
  items: StoryAssetGalleryEntry[]
}

 export type StoryboardBatchDraft = {
  style: 'picture_book' | 'cartoon' | 'national_style' | 'watercolor'
  aspectRatio: '9:16' | '16:9' | '1:1' | '9:1'
  width: number
  height: number
  model?: string
  loras?: string[]
  size?: string
  responseFormat?: 'url' | 'b64_json'
  watermark?: boolean
  sequentialImageGeneration?: 'auto' | 'disabled'
  steps: number
  cfgScale: number
  sampler: string
  scheduler: string
  updatedAt: string
}

export const DOUBAO_STORYBOARD_DEFAULTS = {
  steps: 30,
  cfgScale: 7.5,
  sampler: 'DPM++ 2M',
  scheduler: 'Karras'
} as const

export function getDoubaoStoryboardDefaultSize(aspectRatio: string) {
  const ar = String(aspectRatio || '').trim()
  if (ar === '16:9') return '2560x1440'
  if (ar === '1:1') return '1920x1920'
  if (ar === '9:1') return '6480x720'
  return '1440x2560'
}

export function normalizeStoryboardAssetPlan(plan: StoryAssetPlan | null | undefined): StoryAssetPlan | null {
  if (!plan || typeof plan !== 'object') return null
  const assets = Array.isArray((plan as any).assets) ? (plan as any).assets : []
  const scenes = Array.isArray((plan as any).scenes) ? (plan as any).scenes : []
  const summaryIn = (plan as any).summary && typeof (plan as any).summary === 'object' ? (plan as any).summary : {}
  return {
    schemaVersion: String((plan as any).schemaVersion || '1.0'),
    generatedAt: String((plan as any).generatedAt || '').trim() || new Date().toISOString(),
    worldAnchor: String((plan as any).worldAnchor || '').trim(),
    forbiddenSubstitutes: Array.isArray((plan as any).forbiddenSubstitutes) ? (plan as any).forbiddenSubstitutes.map((x: any) => String(x || '').trim()).filter(Boolean) : [],
    eventChain: Array.isArray((plan as any).eventChain) ? (plan as any).eventChain.map((x: any) => String(x || '').trim()).filter(Boolean) : [],
    excludedAssetIds: Array.isArray((plan as any).excludedAssetIds) ? (plan as any).excludedAssetIds.map((x: any) => String(x || '').trim()).filter(Boolean) : [],
    assets,
    scenes,
    summary: {
      assetCount: Number(summaryIn.assetCount || assets.length || 0),
      sceneCount: Number(summaryIn.sceneCount || scenes.length || 0),
      refRequiredCount: Number(summaryIn.refRequiredCount || 0),
      refReadyCount: Number(summaryIn.refReadyCount || 0),
      refMissingCount: Number(summaryIn.refMissingCount || 0),
      workflows: (summaryIn.workflows && typeof summaryIn.workflows === 'object') ? summaryIn.workflows : {}
    }
  }
}

export function getStoryboardRequiredMissingAssets(plan: StoryAssetPlan | null | undefined): StoryAssetPlanAsset[] {
  const assets = Array.isArray((plan as any)?.assets) ? ((plan as any).assets as any[]) : []
  return assets
    .filter((asset) => String(asset && asset.renderStrategy ? asset.renderStrategy : '').trim() === 'ref_required')
    .filter((asset) => {
      const primaryUri = String(asset && asset.primaryReferenceAssetUri ? asset.primaryReferenceAssetUri : '').trim()
      const batch = Array.isArray(asset && (asset as any).latestReferenceBatch) ? (asset as any).latestReferenceBatch : []
      const refs = Array.isArray(asset && (asset as any).generatedRefs) ? (asset as any).generatedRefs : []
      return !primaryUri && batch.length === 0 && refs.length === 0
    })
    .map((asset) => ({
      id: String(asset && asset.id ? asset.id : '').trim(),
      name: String(asset && asset.name ? asset.name : '').trim(),
      category: String(asset && asset.category ? asset.category : '').trim(),
      renderStrategy: String(asset && asset.renderStrategy ? asset.renderStrategy : '').trim(),
      sceneCount: Number(asset && asset.sceneCount ? asset.sceneCount : 0),
      referenceStatus: String(asset && asset.referenceStatus ? asset.referenceStatus : '').trim(),
      primaryReferenceAssetId: String(asset && asset.primaryReferenceAssetId ? asset.primaryReferenceAssetId : '').trim(),
      primaryReferenceAssetUri: String(asset && asset.primaryReferenceAssetUri ? asset.primaryReferenceAssetUri : '').trim(),
      referencePromptHint: String(asset && asset.referencePromptHint ? asset.referencePromptHint : '').trim()
    }))
}


export function getStoryboardRequiredUnlockedAssets(plan: StoryAssetPlan | null | undefined): StoryAssetPlanAsset[] {
  const assets = Array.isArray((plan as any)?.assets) ? ((plan as any).assets as any[]) : []
  return assets
    .filter((asset) => String(asset && asset.renderStrategy ? asset.renderStrategy : '').trim() === 'ref_required')
    .filter((asset) => !String(asset && asset.primaryReferenceAssetUri ? asset.primaryReferenceAssetUri : '').trim() || !String(asset && asset.lineartFinalAssetUri ? asset.lineartFinalAssetUri : '').trim())
    .map((asset) => ({
      id: String(asset && asset.id ? asset.id : '').trim(),
      name: String(asset && asset.name ? asset.name : '').trim(),
      category: String(asset && asset.category ? asset.category : '').trim(),
      renderStrategy: String(asset && asset.renderStrategy ? asset.renderStrategy : '').trim(),
      sceneCount: Number(asset && asset.sceneCount ? asset.sceneCount : 0),
      referenceStatus: String(asset && asset.referenceStatus ? asset.referenceStatus : '').trim(),
      primaryReferenceAssetId: String(asset && asset.primaryReferenceAssetId ? asset.primaryReferenceAssetId : '').trim(),
      primaryReferenceAssetUri: String(asset && asset.primaryReferenceAssetUri ? asset.primaryReferenceAssetUri : '').trim(),
      referencePromptHint: String(asset && asset.referencePromptHint ? asset.referencePromptHint : '').trim()
    }))
}

export function getStoryboardAssetPlanSummary(plan: StoryAssetPlan | null | undefined, confirmedAt: string): string {
  const normalized = normalizeStoryboardAssetPlan(plan)
  if (!normalized) return '尚未生成必要事物资产计划'
  const missingRefs = getStoryboardRequiredMissingAssets(normalized)
  const unlocked = getStoryboardRequiredUnlockedAssets(normalized)
  if (missingRefs.length > 0) return `仍有 ${missingRefs.length} 个必要事物尚未生成候选参考图，请先抽卡。`
  if (unlocked.length > 0) return `仍有 ${unlocked.length} 个必要事物尚未完成“手选主参考 + 线稿生成”。`
  if (String(confirmedAt || '').trim()) return '锁定资产已确认，可进入正式场景出图阶段'
  return '所有必要事物已完成主参考与线稿，请确认后进入正式出图。'
}

export function recomputeStoryboardAssetPlanSummary(plan: StoryAssetPlan | null | undefined) {
  const normalized = normalizeStoryboardAssetPlan(plan)
  if (!normalized) return null
  const assets = Array.isArray(normalized.assets) ? normalized.assets : []
  const scenes = Array.isArray(normalized.scenes) ? normalized.scenes : []
  const refRequiredAssets = assets.filter((asset: any) => String(asset?.renderStrategy || '').trim() === 'ref_required')
  const refReadyCount = refRequiredAssets.filter((asset: any) => String(asset?.primaryReferenceAssetUri || '').trim()).length
  const refMissingCount = refRequiredAssets.filter((asset: any) => {
    const primaryUri = String(asset?.primaryReferenceAssetUri || '').trim()
    const batch = Array.isArray(asset?.latestReferenceBatch) ? asset.latestReferenceBatch : []
    const refs = Array.isArray(asset?.generatedRefs) ? asset.generatedRefs : []
    return !primaryUri && batch.length === 0 && refs.length === 0
  }).length
  const workflows: Record<string, number> = {}
  for (const scene of scenes) {
    const key = String((scene as any)?.workflow || '').trim()
    if (!key) continue
    workflows[key] = Number(workflows[key] || 0) + 1
  }
  return {
    ...normalized,
    summary: {
      assetCount: assets.length,
      sceneCount: scenes.length,
      refRequiredCount: refRequiredAssets.length,
      refReadyCount,
      refMissingCount,
      workflows
    }
  }
}

export function hasCjkPromptText(input: string | null | undefined): boolean {
  return /[\u3400-\u9fff]/.test(String(input || ''))
}

export function looksLikeEnglishPromptText(input: string | null | undefined): boolean {
  const value = String(input || '').trim()
  if (!value) return false
  if (hasCjkPromptText(value)) return false
  return /[A-Za-z]{3,}/.test(value)
}

export function chooseEnglishAssetPrompt(candidate: string | null | undefined, fallback: string | null | undefined): string {
  const preferred = String(candidate || '').trim()
  if (looksLikeEnglishPromptText(preferred)) return preferred
  const alt = String(fallback || '').trim()
  if (looksLikeEnglishPromptText(alt)) return alt
  return preferred || alt
}

export function isProtectedAssetLockProfile(asset: any): boolean {
  const profile = String(asset?.lockProfile || '').trim().toLowerCase()
  return ['wearable_prop', 'slender_prop', 'rigid_prop', 'soft_prop', 'ambient_prop', 'organic_prop'].includes(profile)
}

export function looksContaminatedProtectedAssetPrompt(input: string | null | undefined, asset?: any): boolean {
  const value = String(input || '').trim()
  if (!value) return false
  const profile = String(asset?.lockProfile || '').trim().toLowerCase()
  const wearableLike = profile === 'wearable_prop'
  const commonDanger = /\b(girl|boy|portrait|upper body|model|wearing|worn|dress|shirt|mannequin|bust)\b|under chin/i
  if (commonDanger.test(value)) return true
  if (wearableLike) {
    return /\b(face|head|hair|ears|shoulders|neck|collarbone)\b/i.test(value)
  }
  return false
}


export function normalizeStoryboardLockAssetPromptDrafts(
  plan: StoryAssetPlan | null | undefined,
  draftsIn: Record<string, StoryboardLockAssetPromptDraft> | null | undefined
): Record<string, StoryboardLockAssetPromptDraft> {
  const hasOwn = (obj: any, key: string) => Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key)
  function defaultAssetNegativePromptZh(asset: any) {
    const category = String(asset?.category || '').trim().toLowerCase()
    if (category === 'character') {
      return '真人小孩，人类脸，猫娘，拟人少女，帽子，草帽，水桶，鱼竿，复杂背景，场景环境，树木，草地，水面，地面投影，文字，水印'
    }
    if (category === 'prop') {
      return '人物，角色，儿童，女孩，男孩，头部，脸部，半身像，上半身，手持，佩戴展示，戴在头上，模特，人体穿戴关系，场景背景，树木，草地，水面，文字，水印'
    }
    if (category === 'location') {
      return '角色特写，人群，文字，水印'
    }
    return ''
  }

  const incoming = draftsIn && typeof draftsIn === 'object' ? draftsIn : {}
  const assets = Array.isArray((plan as any)?.assets) ? (plan as any).assets : []
  const next: Record<string, StoryboardLockAssetPromptDraft> = {}
  for (const asset of assets) {
    const assetId = String(asset && asset.id ? asset.id : '').trim()
    if (!assetId) continue
    const prev = incoming[assetId] && typeof incoming[assetId] === 'object' ? incoming[assetId] : { promptZh: '', promptEn: '' }
    // 2026-10-13 兜底链补 anchorPrompt：存量计划（生产链只写了出图锚点、未写向导字段）在向导里立即可见，
    // 新计划由生产侧直接填齐 referencePromptEn/referencePromptZh（字段语义不变，仅回退读取）
    const fallbackPromptEn = String(asset?.referencePromptEn || asset?.anchorPrompt || asset?.referencePromptHint || '').trim()
    const preferredPromptEn = chooseEnglishAssetPrompt(hasOwn(prev, 'promptEn') ? prev.promptEn : (asset?.referencePromptEn || ''), fallbackPromptEn)
    const safePromptEn = isProtectedAssetLockProfile(asset) && looksContaminatedProtectedAssetPrompt(preferredPromptEn, asset)
      ? fallbackPromptEn
      : preferredPromptEn
    next[assetId] = {
      promptZh: hasOwn(prev, 'promptZh') ? String(prev.promptZh ?? '') : String(asset?.referencePromptZh || ''),
      promptEn: safePromptEn,
      negativePromptZh: hasOwn(prev, 'negativePromptZh') ? String(prev.negativePromptZh ?? '') : String(asset?.referenceNegativePromptZh || defaultAssetNegativePromptZh(asset) || ''),
      negativePrompt: hasOwn(prev, 'negativePrompt') ? String(prev.negativePrompt ?? '') : String(asset?.referenceNegativePrompt || asset?.negativePrompt || ''),
      promptReview: prev.promptReview && typeof prev.promptReview === 'object' ? prev.promptReview : null,
      enhancedAt: String(prev.enhancedAt || '').trim(),
      enhanceMode: String(prev.enhanceMode || '').trim()
    }
  }
  if (assets.length === 0) {
    for (const [assetId, draft] of Object.entries(incoming)) {
      if (next[assetId]) continue
      next[assetId] = {
        promptZh: String((draft as any)?.promptZh ?? ''),
        promptEn: String((draft as any)?.promptEn ?? ''),
        negativePromptZh: String((draft as any)?.negativePromptZh ?? ''),
        negativePrompt: String((draft as any)?.negativePrompt ?? ''),
        enhancedAt: String((draft as any)?.enhancedAt || '').trim(),
        enhanceMode: String((draft as any)?.enhanceMode || '').trim()
      }
    }
  }
  return next
}

export function buildSelectedCharacterRefsFromChoices(choices: Array<{
    characterId: string
    characterName: string
    fingerprintPrompt?: string
    assetId?: string
    assetUri?: string
    available: boolean
    selected: boolean
    weight?: number
  }>) {
    return choices
      .filter((x) => x.selected && x.available && x.assetUri)
      .map((x) => ({
        characterId: x.characterId,
        characterName: x.characterName,
        assetId: x.assetId,
        assetUri: x.assetUri,
        fingerprintPrompt: x.fingerprintPrompt || undefined,
        weight: Number.isFinite(Number(x.weight)) ? Number(x.weight) : 0.85
      }))
  }

export function readStoryboardAssetPlanFromProject(project: ProjectV1 | null | undefined): StoryAssetPlan | null {
    const st = project && (project as any).state && typeof (project as any).state === 'object' ? (project as any).state : {}
    const aiBg = st && (st as any).aiBackground && typeof (st as any).aiBackground === 'object' ? (st as any).aiBackground : {}
    const raw = aiBg && (aiBg as any).storyAssetPlan && typeof (aiBg as any).storyAssetPlan === 'object'
      ? ((aiBg as any).storyAssetPlan as StoryAssetPlan)
      : null
    return normalizeStoryboardAssetPlan(raw)
  }

export function readStoryboardAssetConfirmedAtFromProject(project: ProjectV1 | null | undefined) {
    const st = project && (project as any).state && typeof (project as any).state === 'object' ? (project as any).state : {}
    const aiBg = st && (st as any).aiBackground && typeof (st as any).aiBackground === 'object' ? (st as any).aiBackground : {}
    return String((aiBg as any).storyAssetPlanConfirmedAt || '').trim()
  }
