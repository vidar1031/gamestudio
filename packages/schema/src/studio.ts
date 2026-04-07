// Shared contracts (P0): editor <-> server

export type AssetV1 = {
  id: string
  kind: 'image'
  name: string
  uri: string
  source?: { type: 'upload' | 'import' | 'ai'; prompt?: string; provider?: 'sdwebui' | 'comfyui' | 'doubao'; remoteUrl?: string }
}

export type CharacterV1 = {
  id: string
  name: string
  imageAssetId?: string
  ai?: {
    fingerprintPrompt?: string
    negativePrompt?: string
    // For storyboard continuity (IP-Adapter reference image).
    referenceAssetId?: string
  }
}

export type Transform2DV1 = {
  x: number
  y: number
  scale: number
  rotationDeg: number
}

export type ConditionValueV1 = { var: string } | string | number | boolean | null

export type ConditionExprV1 =
  | { op: 'and' | 'or'; args: ConditionExprV1[] }
  | { op: 'not'; arg: ConditionExprV1 }
  | { op: '==' | '!=' | '<' | '<=' | '>' | '>='; left: ConditionValueV1; right: ConditionValueV1 }
  | { op: 'tags.has'; var: string; value: string }
  | any

export type EndingCardButtonV1 =
  | { type: 'restart'; label: string }
  | { type: 'backToHub'; label: string; url?: string }
  | { type: string; label: string; [k: string]: any }

export type EndingCardV1 = {
  title: string
  bullets: string[]
  moral: string
  buttons: EndingCardButtonV1[]
}

export type TimelineAdvanceTypeV1 = 'auto' | 'click' | 'choice' | 'timer' | 'event' | 'condition' | 'end'

export type TimelineAdvanceV1 =
  | { type: 'auto' }
  | { type: 'click' }
  | { type: 'choice' }
  | { type: 'timer'; ms: number }
  | { type: 'event'; name: string }
  | { type: 'condition'; expr: ConditionExprV1; pollMs?: number }
  | { type: 'end' }
  | { type: TimelineAdvanceTypeV1; [k: string]: any }

export type TimelineActionV1 =
  | { type: 'ui.setText'; mode?: 'replace' | 'append'; text: string }
  | { type: 'ui.appendText'; text: string }
  | { type: 'ui.clearText' }
  | { type: 'ui.toast'; text: string }
  | { type: 'ui.showEndingCard'; card: EndingCardV1 }
  | { type: 'flow.gotoNode'; nodeId: string }
  | { type: 'flow.restart' }
  | { type: 'flow.backToHub'; url?: string }
  | { type: 'flow.stopTimeline' }
  | { type: 'event.call'; eventId: string }
  | { type: 'events.emit'; name: string; payload?: any }
  | { type: 'state.set'; var: string; value: any }
  | { type: 'state.add'; var: string; value: number }
  | { type: 'state.inc'; var: string; value?: number }
  | { type: 'state.toggle'; var: string }
  | { type: 'state.tags.add'; var: string; value: string }
  | { type: 'state.tags.remove'; var: string; value: string }
  | { type: 'stage.setBackground'; assetId?: string; color?: string }
  | { type: 'stage.setPlacements'; placements: CharacterPlacementV1[] }
  | { type: string; [k: string]: any }

export type TimelineStepV1 = {
  id: string
  actions: TimelineActionV1[]
  advance: TimelineAdvanceV1
}

export type NodeTimelineV1 = {
  steps: TimelineStepV1[]
}

export type ProjectEventV1 = {
  id: string
  name: string
  actions: TimelineActionV1[]
}

export type StateVarTypeV1 = 'number' | 'boolean' | 'string' | 'tags'

export type StateVarDefV1 = {
  name: string
  type: StateVarTypeV1
  default: any
}

// P1:state-migration
// Why:
// - aiBackground 已经承载了批量提示词/分镜参数，但历史版本字段分散在根层，容易出现状态丢失。
// Contract:
// - 统一 shape：global/storyboardScenes/storyboardBatchDraft/storyboardPromptMeta
// - 保留 legacy 镜像字段（globalPrompt/globalNegativePrompt）兼容旧 UI
export type AiBackgroundGlobalV1 = {
  prompt: string
  negativePrompt: string
}

export type AiStoryboardScenePromptV1 = {
  nodeId?: string
  sceneName?: string
  prompt: string
  negativePrompt: string
  status?: 'idle' | 'generating' | 'ok' | 'error'
  updatedAt?: string
  error?: string
  [k: string]: any
}

export type AiStoryboardBatchDraftV1 = {
  style?: 'picture_book' | 'cartoon' | 'national_style' | 'watercolor'
  aspectRatio?: '9:16' | '16:9' | '1:1' | '9:1'
  width?: number
  height?: number
  size?: string
  responseFormat?: 'url' | 'b64_json'
  watermark?: boolean
  sequentialImageGeneration?: 'auto' | 'disabled'
  steps?: number
  cfgScale?: number
  sampler?: string
  scheduler?: string
  model?: string
  lora?: string
  timeoutMs?: number
  [k: string]: any
}

export type AiStoryboardContinuityV1 = {
  ipadapterEnabled?: boolean
  requireCharacterRefs?: boolean
  controlnetEnabled?: boolean
  seedMode?: 'random' | 'fixed'
  [k: string]: any
}

export type AiStoryboardPromptMetaV1 = {
  provider?: string
  model?: string
  timeoutMs?: number
  generatedAt?: string
  sceneCount?: number
  source?: string
  [k: string]: any
}

export type AiBackgroundStateV1 = {
  schemaVersion: '1.0'
  global: AiBackgroundGlobalV1
  storyboardScenes: Record<string, AiStoryboardScenePromptV1>
  storyboardBatchDraft: AiStoryboardBatchDraftV1
  storyboardPromptMeta: AiStoryboardPromptMetaV1
  storyboardEntitySpec?: string
  storyBibleJson?: string
  storyBible?: Record<string, any>
  storyboardContinuity?: AiStoryboardContinuityV1
  // Legacy mirrors for backward compatibility.
  globalPrompt: string
  globalNegativePrompt: string
}

export type ProjectStateDefV1 = {
  vars: StateVarDefV1[]
  aiBackground?: AiBackgroundStateV1 | Record<string, any>
}

export type CharacterPlacementV1 = {
  id: string
  characterId: string
  imageAssetId?: string
  transform: Transform2DV1
  visible?: boolean
  zIndex?: number
}

export type StageOrientationV1 = 'portrait' | 'landscape'
export type StageScaleModeV1 = 'contain' | 'cover'

export type StageConfigV1 = {
  width: number
  height: number
  orientation?: StageOrientationV1
  scaleMode?: StageScaleModeV1
}

export type NodeVisualsV1 = {
  backgroundAssetId?: string
  placements?: CharacterPlacementV1[]
  ui?: NodeUiV1
}

export type DialogPresetV1 = 'bottom' | 'top' | 'left' | 'right' | 'center' | 'custom'

export type DialogLayoutV1 = {
  preset: DialogPresetV1
  x?: number
  y?: number
}

export type ChoicesDirectionV1 = 'row' | 'column'
export type ChoicesAlignV1 = 'start' | 'center' | 'end' | 'stretch'

export type ChoicesLayoutV1 = {
  direction: ChoicesDirectionV1
  align?: ChoicesAlignV1
}

export type NodeUiV1 = {
  dialog?: DialogLayoutV1
  choices?: ChoicesLayoutV1
}

export type ChoiceV1 = {
  id: string
  text: string
  toNodeId: string
  effects?: TimelineActionV1[]
  visibleWhen?: ConditionExprV1 | null
  enabledWhen?: ConditionExprV1 | null
}

export type NodeV1 = {
  id: string
  name: string
  kind: 'scene' | 'ending'
  body: { text: string; title?: string }
  choices?: ChoiceV1[]
  visuals?: NodeVisualsV1
  timeline?: NodeTimelineV1
}

export type StoryV1 = {
  schemaVersion?: '1.0' | '2.0' | string
  startNodeId: string
  nodes: NodeV1[]
}

export type ProjectV1 = {
  schemaVersion: '1.0' | '2.0' | string
  id: string
  title: string
  pluginId: string
  pluginVersion: string
  createdAt: string
  updatedAt: string
  characters: CharacterV1[]
  assets: AssetV1[]
  events?: ProjectEventV1[]
  state?: ProjectStateDefV1
  stage?: StageConfigV1
}

function asObj(v: any): Record<string, any> {
  return v && typeof v === 'object' ? (v as Record<string, any>) : {}
}

function asStr(v: any): string {
  return typeof v === 'string' ? v : ''
}

function asFiniteNum(v: any): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function asBool(v: any): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function asStyle(v: any): AiStoryboardBatchDraftV1['style'] | undefined {
  const s = asStr(v).trim()
  return s === 'picture_book' || s === 'cartoon' || s === 'national_style' || s === 'watercolor' ? s : undefined
}

function asAspectRatio(v: any): AiStoryboardBatchDraftV1['aspectRatio'] | undefined {
  const s = asStr(v).trim()
  return s === '9:16' || s === '16:9' || s === '1:1' || s === '9:1' ? s : undefined
}

export function normalizeAiBackgroundState(input: any): AiBackgroundStateV1 {
  const raw = asObj(input)
  const rawGlobal = asObj(raw.global)

  const legacyPrompt = asStr(raw.globalPrompt).trim()
  const legacyNegative = asStr(raw.globalNegativePrompt).trim()
  const globalPrompt = asStr(rawGlobal.prompt).trim() || legacyPrompt
  const globalNegativePrompt = asStr(rawGlobal.negativePrompt).trim() || legacyNegative

  const scenesIn = asObj(raw.storyboardScenes)
  const storyboardScenes: Record<string, AiStoryboardScenePromptV1> = {}
  for (const [nodeId, value] of Object.entries(scenesIn)) {
    const scene = asObj(value)
    storyboardScenes[String(nodeId)] = {
      ...scene,
      nodeId: asStr(scene.nodeId).trim() || String(nodeId),
      prompt: asStr(scene.prompt).trim(),
      negativePrompt: asStr(scene.negativePrompt).trim(),
      status:
        scene.status === 'idle' || scene.status === 'generating' || scene.status === 'ok' || scene.status === 'error'
          ? scene.status
          : undefined,
      updatedAt: asStr(scene.updatedAt).trim() || undefined,
      error: asStr(scene.error).trim() || undefined
    }
  }

  const draftIn = asObj(raw.storyboardBatchDraft)
  const metaIn = asObj(raw.storyboardPromptMeta)
  const continuityIn = asObj(raw.storyboardContinuity)
  const storyBibleIn = asObj(raw.storyBible)
  const storyBibleJson = asStr(raw.storyBibleJson).trim() || (Object.keys(storyBibleIn).length ? JSON.stringify(storyBibleIn, null, 2) : '')

  const out: AiBackgroundStateV1 = {
    ...(raw as any),
    schemaVersion: '1.0',
    global: { prompt: globalPrompt, negativePrompt: globalNegativePrompt },
    storyboardScenes,
    storyboardBatchDraft: {
      ...draftIn,
      style: asStyle(draftIn.style),
      aspectRatio: asAspectRatio(draftIn.aspectRatio),
      width: asFiniteNum(draftIn.width),
      height: asFiniteNum(draftIn.height),
      size: asStr(draftIn.size).trim() || undefined,
      responseFormat: asStr(draftIn.responseFormat).trim() === 'b64_json' ? 'b64_json' : (asStr(draftIn.responseFormat).trim() === 'url' ? 'url' : undefined),
      watermark: asBool(draftIn.watermark),
      sequentialImageGeneration: asStr(draftIn.sequentialImageGeneration).trim() === 'disabled' ? 'disabled' : (asStr(draftIn.sequentialImageGeneration).trim() === 'auto' ? 'auto' : undefined),
      steps: asFiniteNum(draftIn.steps),
      cfgScale: asFiniteNum(draftIn.cfgScale),
      sampler: asStr(draftIn.sampler) || undefined,
      scheduler: asStr(draftIn.scheduler) || undefined,
      model: asStr(draftIn.model) || undefined,
      lora: asStr(draftIn.lora) || undefined,
      timeoutMs: asFiniteNum(draftIn.timeoutMs)
    },
    storyboardPromptMeta: {
      ...metaIn,
      provider: asStr(metaIn.provider) || undefined,
      model: asStr(metaIn.model) || undefined,
      timeoutMs: asFiniteNum(metaIn.timeoutMs),
      generatedAt: asStr(metaIn.generatedAt) || undefined,
      sceneCount: asFiniteNum(metaIn.sceneCount),
      source: asStr(metaIn.source) || undefined
    },
    storyboardEntitySpec: asStr(raw.storyboardEntitySpec).trim() || undefined,
    storyBibleJson: storyBibleJson || undefined,
    storyBible: Object.keys(storyBibleIn).length ? storyBibleIn : undefined,
    storyboardContinuity: Object.keys(continuityIn).length
      ? {
          ...continuityIn,
          ipadapterEnabled: asBool(continuityIn.ipadapterEnabled),
          requireCharacterRefs: asBool(continuityIn.requireCharacterRefs),
          controlnetEnabled: asBool(continuityIn.controlnetEnabled),
          seedMode: asStr(continuityIn.seedMode).trim() === 'fixed' ? 'fixed' : (asStr(continuityIn.seedMode).trim() === 'random' ? 'random' : undefined)
        }
      : undefined,
    globalPrompt,
    globalNegativePrompt
  }
  return out
}

export function normalizeProjectStateV1(input: any): ProjectStateDefV1 {
  const state = asObj(input)
  const varsIn = Array.isArray(state.vars) ? state.vars : []
  const vars = varsIn
    .map((v) => asObj(v))
    .map((v) => ({
      name: asStr(v.name).trim(),
      type: (asStr(v.type).trim() || 'string') as StateVarTypeV1,
      default: 'default' in v ? v.default : ''
    }))
    .filter((v) => Boolean(v.name))
  return {
    vars,
    aiBackground: normalizeAiBackgroundState(state.aiBackground)
  }
}

export function normalizeProjectV1(input: any): ProjectV1 {
  const project = asObj(input) as ProjectV1
  const state = normalizeProjectStateV1(project && typeof project === 'object' ? (project as any).state : null)
  return {
    ...(project as any),
    state
  } as ProjectV1
}

// ===== Workflow (scripts/blueprint) =====
export type ScriptCardV1 = {
  id: string
  name: string
  order: number
  text: string
  updatedAt: string
}

export type ScriptDocV1 = {
  schemaVersion: '1.0'
  cards: ScriptCardV1[]
  updatedAt: string
}

export type PlaceholderKindV1 = 'actor' | 'background' | 'event'

export type PlaceholderV1 = {
  id: string
  kind: PlaceholderKindV1
  name: string
  tags?: string[]
}

export type BlueprintChoiceV1 = {
  id: string
  text: string
  toNodeId: string
}

export type BlueprintNodeV1 = {
  id: string
  scriptCardId: string
  name: string
  kind: 'scene' | 'ending'
  textDraft?: string
  backgroundId?: string
  actorIds: string[]
  eventIds: string[]
  choices: BlueprintChoiceV1[]
}

export type BlueprintDocV1 = {
  schemaVersion: '1.0'
  startNodeId: string
  placeholders: PlaceholderV1[]
  nodes: BlueprintNodeV1[]
  updatedAt: string
}

// ===== Demo library (read-only templates) =====
export type DemoItem = {
  id: string
  title: string
  nodesCount: number
}

export type DemoMeta = {
  id: string
  title: string
  assetBase: string
}

// ===== AI (background image) =====
export type AiBackgroundRequest = {
  // 用户原始描述（用于 AI 解析/润色提示词；生成图片时服务端仍以 prompt 为准）
  userInput?: string
  // 全局设定（整个故事共享）：用于锁定时代/环境/画风/角色设定等，避免每个场景重复输入
  globalPrompt?: string
  globalNegativePrompt?: string
  // 背景空镜：只生成环境背景，不包含人物/动物（推荐与“透明角色 PNG”工作流搭配）
  backgroundOnly?: boolean
  prompt: string
  negativePrompt?: string
  // Seedream/豆包常用参数
  aspectRatio?: '9:16' | '16:9' | '1:1' | '9:1'
  style?: 'picture_book' | 'cartoon' | 'national_style' | 'watercolor'
  // Ark Images API params (optional)
  size?: string
  responseFormat?: 'url' | 'b64_json'
  watermark?: boolean
  guidanceScale?: number
  sequentialImageGeneration?: 'auto' | 'disabled'
  width?: number
  height?: number
  model?: string
  loras?: string[]
  steps?: number
  cfgScale?: number
  sampler?: string
  scheduler?: string
  seed?: number
  continuity?: {
    ipadapterEnabled?: boolean
    requireCharacterRefs?: boolean
    controlnetEnabled?: boolean
    seedMode?: 'random' | 'fixed'
  }
  referenceSceneIds?: string[]
  referenceImageUrls?: string[]
  existingAssetUri?: string
  characterRefs?: Array<{
    characterId: string
    characterName?: string
    assetId?: string
    assetPath?: string
    assetUri?: string
    fingerprintPrompt?: string
    weight?: number
  }>
  // 请求超时（毫秒），用于本地模型较慢场景
  timeoutMs?: number
}
