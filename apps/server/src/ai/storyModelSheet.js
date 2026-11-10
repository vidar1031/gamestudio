// 标准系三视图纯函数：逐视角提示词、整 sheet 独立负向词、身份锚参数和试验记录写回。
// 正面始终使用已锁主参考；side/back 的身份参考与视角结构约束分离。
// 试验记录与正式 views/锁定凭据分离，重出普通候选时父级锁定必须失效。
import { isAnimalLikeAnchor } from './storyPoseVariants.js'

const asStr = (v) => String(v == null ? '' : v)

export const MODEL_SHEET_VIEWS = ['front', 'side', 'back']

export const MODEL_SHEET_VIEW_LABELS = { front: '正面', side: '侧面', back: '背面' }

const VIEW_SENTENCE_EN = {
  front: 'front view, facing the viewer directly',
  // T 波调参第 3 轮（第 2 轮实测：side 头已纯侧但裁成胸像——full body 被视角词压；back 仍回头）：
  // full body 前置进视角句保构图；back 加头全背禁回头
  // Y 波（2026-10-28 用户实测：骨架链产物带灰底渐变投影——白底不统一）：提示词强化纯白底无光影
  side: 'extreme side view, strict full profile facing left, FULL BODY visible head to toe, only one side of the face visible, only one eye visible, nose pointing directly left, pure white background, flat lighting, no shadow, no gradient',
  back: 'complete back view, rear view, FULL BODY visible head to toe, the character facing directly away from the viewer, back of the head and whole back visible, head facing away completely, head NOT turned, no face visible, no eye visible, pure white background, flat lighting, no shadow, no gradient'
}

// side/back 晚介入以减少正面构图回拉；动物背面使用独立的弱身份锚。
export const MODEL_SHEET_VIEW_IPADAPTER = {
  front: { weight: 0.85, startAt: 0.1, endAt: 0.9 },
  side: { weight: 0.45, startAt: 0.45, endAt: 0.8 },
  back: { weight: 0.35, startAt: 0.5, endAt: 0.8 }
}
export const MODEL_SHEET_VIEW_IPADAPTER_ANIMAL = {
  side: { weight: 0.55, startAt: 0.4, endAt: 0.8 },
  back: { weight: 0.35, startAt: 0.5, endAt: 0.8 }
}

// 视角负向排除（side/back 专属）：把不想要的视角写进负向压住
export const MODEL_SHEET_VIEW_NEGATIVE_EXTRA = {
  front: '',
  side: 'front view, facing viewer, both eyes visible, symmetrical face, three quarter view, gradient background, shadow, studio lighting',
  back: 'front view, side view, face visible, eyes visible, looking at viewer, looking back, head turned, three quarter view, gradient background, shadow, studio lighting'
}

// Y 波：白底抽检判定（骨架链无 alpha 产物——渐变压平会吃白毛，只能提示词强化+抽检作评审打回依据）：
// 边缘 16px 带近白（RGB 均≥240）像素占比 <0.85 视为背景不纯（参考图必须纯白底）
export const MODEL_SHEET_BG_PURITY_THRESHOLD = 0.85
export function isBgPureEnough(ratio) {
  return Number.isFinite(Number(ratio)) && Number(ratio) >= MODEL_SHEET_BG_PURITY_THRESHOLD
}

// U 波项 3（2026-10-28）：姿势库补 standing_side/standing_back 中立站姿骨架（程序化 openpose 语义）——
// side/back 生成切换点落地：走 ControlNet 骨架硬约束（generateComfyuiPoseVariantSprite 骨架+IPAdapter 双约束链），
// IPAdapter 降权只管身份、视角归骨架。front 无骨架保持 sprite 链。
export const MODEL_SHEET_VIEW_SKELETON = { side: 'standing_side.png', back: 'standing_back.png' }

// V 波（2026-10-28）：charturn SDXL LoRA（il-xl-charturn-merged，435MB 已入 ComfyUI loras 库）接入三视图链——
// 低权档 0.4（任务书 0.3-0.5 区间中值）；触发词 charturn 只在 side/back 提示词（front 与主参考同视角不需要）；
// 仅三视图生成用，不进主参考/姿态/场景出图链（字符串档供 sprite 链 body.loras，对象档供骨架链 parseComfyLoras）。
export const MODEL_SHEET_CHARTURN_LORA = 'il-xl-charturn-merged.safetensors:0.4'
// W 波调参第 5 轮：back 档 0.5（0.3-0.5 上限，back 视角需要 LoRA 更强转向力）
export const MODEL_SHEET_CHARTURN_LORA_BACK = 'il-xl-charturn-merged.safetensors:0.5'
export const MODEL_SHEET_CHARTURN_TRIGGER = 'charturn'

// U 波项 1：配色锚定——从锚点/英文正向稿提取颜色词，显式约束"配色与主参考一致"
// （side/back IPAdapter 降权后身份色漂移风险上升，颜色词补强制约；数据口径=锚点文本，确定性可得）
const COLOR_WORDS = [
  ['灰', 'grey'], ['粉', 'pink'], ['红', 'red'], ['蓝', 'blue'], ['黄', 'yellow'], ['绿', 'green'],
  ['棕', 'brown'], ['黑', 'black'], ['白', 'white'], ['橙', 'orange'], ['紫', 'purple']
]
export function buildColorAnchorEn(asset) {
  const hay = `${asStr(asset && asset.referencePromptEn)} ${asStr(asset && asset.anchorPromptEn)} ${asStr(asset && asset.anchorPrompt)}`
  const hits = []
  for (const [zh, en] of COLOR_WORDS) {
    if (hay.includes(zh) || new RegExp(`\\b${en}\\b`, 'i').test(hay)) hits.push(en)
  }
  if (!hits.length) return ''
  return `color palette strictly consistent with the primary reference (${[...new Set(hits)].join(', ')}), same fur/outfit colors`
}

// 视角语义检测（姿势需求文本 → 期望视角）：背身类姿势吃 back 视图，侧脸/侧身吃 side，缺省 front。
// 供两处消费：①姿势变体参考源选择（pickPoseIdentityView）②锁定状态展示。
export function detectPoseViewKey(text) {
  const t = asStr(text)
  if (/背|背影|背对|背面|背身|rear|back\s*view/i.test(t)) return 'back'
  if (/侧|侧身|侧面|侧脸|侧躺|profile|side\s*view/i.test(t)) return 'side'
  return 'front'
}

// 三视图提示词：已批准英文正向稿 + 视角句 + 中立站姿 + 纯白底单主体 + 画风；弱物种显性强化收尾。
// T 波：道具口径分支（物件本体+视角句，不写 character 词）；视角句加强语义（side 单眼可见/back 无脸）。
export function buildModelSheetViewPrompt({ asset, viewKey, styleEn, charturn }) {
  const identity = asStr(asset && (asset.referencePromptEn || asset.anchorPromptEn || asset.anchorPrompt)).trim()
  // V 波：charturn 触发词仅 side/back（front 与主参考同视角不带）
  const viewSentence = (VIEW_SENTENCE_EN[viewKey] || VIEW_SENTENCE_EN.front) + (charturn && viewKey !== 'front' ? `, ${MODEL_SHEET_CHARTURN_TRIGGER}` : '')
  const colorAnchor = buildColorAnchorEn(asset) // U 波：配色锚（降权后的颜色漂移制约）
  const isProp = asStr(asset && asset.category).trim() === 'prop'
  const parts = isProp
    ? [
        'one single object only:',
        identity,
        `${viewSentence}, static display`,
        'whole object, centered, pure white background, no scene, no environment',
        colorAnchor,
        asStr(styleEn).trim() || 'cartoon fairy tale picture book style, flat 2D illustration, clean outlines, cel shading'
      ].filter(Boolean)
    : [
        'one single character only:',
        identity,
        `${viewSentence}, standing still in a neutral relaxed pose`,
        'full body, head to toe, centered, pure white background, no scene, no environment',
        colorAnchor,
        asStr(styleEn).trim() || 'cartoon fairy tale picture book style, flat 2D illustration, clean outlines, cel shading'
      ].filter(Boolean)
  const speciesBoost = !isProp && isAnimalLikeAnchor(`${identity} ${asStr(asset && asset.name)}`)
    ? ' IMPORTANT: the character is an animal, keep the animal head and animal features, NOT a human face.'
    : ''
  return parts.join(', ') + '.' + speciesBoost
}

export function buildModelSheetNegativePrompt(baseNegative) {
  const ban = 'multiple views, character sheet, turnaround sheet, reference sheet, grid, collage, multiple panels, split view, multiple characters, text, watermark, realistic, photo, deformed, extra limbs'
  return [asStr(baseNegative).trim(), ban].filter(Boolean).join(', ')
}

const WHOLE_SHEET_NEGATIVE_CONFLICTS = new Set([
  'multiple views', 'character sheet', 'turnaround sheet', 'reference sheet', 'grid', 'collage',
  'multiple panels', 'split view', 'multiple characters', '多视图', '多面板', '多主体'
])

export function buildModelSheetWholeNegativePrompt(baseNegative) {
  const base = asStr(baseNegative)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !WHOLE_SHEET_NEGATIVE_CONFLICTS.has(part.toLowerCase()))
  return [...base, 'text, watermark, realistic, photo, deformed, extra limbs'].join(', ')
}

// 读取资产的已锁视角图（assetUri + lockedAt 双凭据）
export function lockedModelSheetView(asset, viewKey) {
  const views = Array.isArray(asset?.modelSheet?.views) ? asset.modelSheet.views : []
  return views.find((v) => v && v.key === viewKey && asStr(v.lockedAt).trim() && asStr(v.assetUri).trim()) || null
}

// 标准系三视图已从默认生产链退役；姿态生成只使用主参考，不消费历史 modelSheet。
export function pickPoseIdentityView() {
  return { viewKey: '', uri: '', source: 'primary' }
}

export function upsertModelSheetView(asset, viewEntry) {
  const key = asStr(viewEntry && viewEntry.key).trim()
  const prev = Array.isArray(asset?.modelSheet?.views) ? asset.modelSheet.views : []
  const old = prev.find((v) => asStr(v && v.key).trim() === key) || null
  const rest = prev.filter((v) => asStr(v && v.key).trim() !== key)
  const entry = old && asStr(old.lockedAt).trim() && !asStr(viewEntry.lockedAt).trim()
    ? { ...viewEntry, prevLockedAt: asStr(old.lockedAt).trim() }
    : viewEntry
  const modelSheet = { ...(asset?.modelSheet && typeof asset.modelSheet === 'object' ? asset.modelSheet : {}) }
  if (!asStr(viewEntry.lockedAt).trim() && asStr(modelSheet.lockedAt).trim()) {
    modelSheet.prevLockedAt = asStr(modelSheet.lockedAt).trim()
    delete modelSheet.lockedAt
  }
  return { ...modelSheet, views: [...rest, entry] }
}

export function upsertModelSheetTestRun(asset, run) {
  const modelSheet = { ...(asset?.modelSheet && typeof asset.modelSheet === 'object' ? asset.modelSheet : {}) }
  const runId = asStr(run?.runId).trim()
  const previous = Array.isArray(modelSheet.testRuns) ? modelSheet.testRuns : []
  const remaining = runId ? previous.filter((item) => asStr(item?.runId).trim() !== runId) : previous
  return { ...modelSheet, testRuns: [...remaining, run].slice(-30) }
}
