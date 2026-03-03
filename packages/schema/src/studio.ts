// Shared contracts (P0): editor <-> server

export type AssetV1 = {
  id: string
  kind: 'image'
  name: string
  uri: string
  source?: { type: 'upload' | 'import' | 'ai'; prompt?: string; provider?: 'sdwebui' | 'comfyui' | 'doubao' }
}

export type CharacterV1 = {
  id: string
  name: string
  imageAssetId?: string
  ai?: {
    fingerprintPrompt?: string
    negativePrompt?: string
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

export type ProjectStateDefV1 = {
  vars: StateVarDefV1[]
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
  steps?: number
  cfgScale?: number
  sampler?: string
  scheduler?: string
  // 请求超时（毫秒），用于本地模型较慢场景
  timeoutMs?: number
}
