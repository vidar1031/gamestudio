export const SCENE_PROMPT_REQUIREMENTS_PATH = '/docs/zhihuazhifang/doc_scene_prompt_requirements.html'
export const SCENE_PROMPT_REQUIREMENTS_VERSION = '1.0'

export type ScenePromptKind = 'positive' | 'negative'
export type ScenePromptTranslationDirection = 'en-zh' | 'zh-en'

export type ScenePromptPairAlignment = {
  sourceHash: string
  targetHash: string
  direction: ScenePromptTranslationDirection
  alignedAt: string
}

export type ScenePromptAlignment = {
  positive?: ScenePromptPairAlignment
  negative?: ScenePromptPairAlignment
}

export type ScenePromptGeneration = {
  createdAt: string
  method: 'scene-en-translation-zh'
  requirementId: 'scene_prompt_requirements'
  requirementVersion: string
  reviewIncluded: boolean
}

export type ScenePromptDraftLike = {
  promptZh?: string
  prompt?: string
  negativePromptZh?: string
  negativePrompt?: string
  promptAlignment?: ScenePromptAlignment
}

type PairStatus = 'missing' | 'unverified' | 'stale' | 'aligned'

function promptTextHash(raw: string) {
  const text = String(raw || '').replace(/\r\n?/g, '\n').trim()
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function createScenePromptPairAlignment(source: string, target: string, direction: ScenePromptTranslationDirection): ScenePromptPairAlignment {
  return {
    sourceHash: promptTextHash(source),
    targetHash: promptTextHash(target),
    direction,
    alignedAt: new Date().toISOString()
  }
}

function pairStatus(item: ScenePromptDraftLike, kind: ScenePromptKind): PairStatus {
  const zh = String(kind === 'negative' ? item.negativePromptZh || '' : item.promptZh || '').trim()
  const en = String(kind === 'negative' ? item.negativePrompt || '' : item.prompt || '').trim()
  if (!zh || !en) return 'missing'
  const pair = item.promptAlignment?.[kind]
  if (!pair || !['en-zh', 'zh-en'].includes(pair.direction)) return 'unverified'
  const source = pair.direction === 'en-zh' ? en : zh
  const target = pair.direction === 'en-zh' ? zh : en
  return pair.sourceHash === promptTextHash(source) && pair.targetHash === promptTextHash(target) ? 'aligned' : 'stale'
}

export function getScenePromptAlignment(item: ScenePromptDraftLike) {
  const positive = pairStatus(item, 'positive')
  const negative = pairStatus(item, 'negative')
  const ready = positive === 'aligned' && negative === 'aligned'
  const status = positive === 'missing' || negative === 'missing'
    ? 'missing'
    : positive === 'stale' || negative === 'stale'
      ? 'stale'
      : positive === 'unverified' || negative === 'unverified'
        ? 'unverified'
        : 'aligned'
  const label = status === 'aligned' ? '双稿已对齐' : status === 'stale' ? '修改后待对齐' : status === 'unverified' ? '双稿待核验' : '提示词待生成'
  const hint = status === 'aligned'
    ? '正向、负向中英文均与同一次翻译记录一致'
    : status === 'stale'
      ? '中文或英文在翻译后被修改，请重新同源翻译'
      : status === 'unverified'
        ? '旧稿没有同源翻译记录，请先对齐中文，再出图'
        : '请先准备完整的正向、负向中英文稿'
  return { ready, status, label, hint, positive, negative }
}

export function scenePromptsCanRender(item: ScenePromptDraftLike) {
  return getScenePromptAlignment(item).ready
}

export function countScenePromptAlignment(items: ScenePromptDraftLike[]) {
  const states = items.map(getScenePromptAlignment)
  return {
    total: items.length,
    aligned: states.filter((item) => item.ready).length,
    pendingGeneration: states.filter((item) => item.status === 'missing').length,
    pendingAlignment: states.filter((item) => !item.ready && item.status !== 'missing').length
  }
}
