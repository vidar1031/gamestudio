import { extractResponseOutputText, openaiResponsesJsonForTools } from './openai.js'
import { generateStrictJsonViaDoubaoChat } from './doubao.js'

function normalizeStyle(v) {
  const s = String(v || '').trim()
  return s === 'picture_book' || s === 'cartoon' || s === 'national_style' || s === 'watercolor' ? s : null
}

function styleName(style) {
  const s = String(style || '').trim()
  if (s === 'picture_book') return '绘本插画'
  if (s === 'cartoon') return '卡通'
  if (s === 'national_style') return '国风'
  if (s === 'watercolor') return '水彩'
  return '插画'
}

function characterFingerprintSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      fingerprintPrompt: { type: 'string', minLength: 1, maxLength: 600 },
      negativePrompt: { type: ['string', 'null'], maxLength: 300 }
    },
    required: ['fingerprintPrompt', 'negativePrompt']
  }
}

function validateCharacterFingerprint(obj) {
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not_object' }
  const fp = typeof obj.fingerprintPrompt === 'string' ? obj.fingerprintPrompt.trim() : ''
  if (!fp) return { ok: false, reason: 'missing_fingerprintPrompt' }
  const negOk = obj.negativePrompt == null || (typeof obj.negativePrompt === 'string' && obj.negativePrompt.length <= 300)
  if (!negOk) return { ok: false, reason: 'invalid_negativePrompt' }
  return { ok: true, reason: 'ok' }
}

export async function generateCharacterFingerprintViaOpenAI({
  storyTitle,
  characterName,
  contextText,
  globalPrompt,
  style,
  model,
  provider,
  apiUrl
}) {
  const st = normalizeStyle(style) || 'picture_book'

  const instructions =
    `你是“交互故事制作工具”的角色设定助手。\n` +
    `任务：为一个角色生成“外观指纹（全局锁定）”，用于后续所有场景/姿势生成，保证同一人物/同一只动物不跑偏。\n` +
    `输出为 JSON（必须严格符合 schema），不要输出解释文字。\n` +
    `要求（重要）：\n` +
    `- fingerprintPrompt 必须是一行中文，建议以“角色设定：”开头。\n` +
    `- 指纹必须包含：年龄段/性别（若适用）/发型或毛发/面部特征/服饰材质与主色/标志性配饰/体型或气质。\n` +
    `- 如果是动物：必须包含“仅一只（唯一）”与颜色/体型/特征（耳朵/花纹/尾巴等）。\n` +
    `- 不要写剧情，不要写场景；只写角色固定外观。\n` +
    `- 风格要与全局一致（${styleName(st)}）。\n` +
    `- negativePrompt 用逗号分隔短词，重点抑制：变脸,换装,发型变化,颜色变化,多只动物,风格漂移；可为 null。\n`

  const user =
    `故事名（可为空）：${String(storyTitle || '').trim()}\n` +
    `全局设定（可为空）：${String(globalPrompt || '').trim()}\n` +
    `角色名：${String(characterName || '').trim()}\n` +
    `上下文（可为空）：${String(contextText || '').trim()}\n`

  const schema = characterFingerprintSchema()
  const body = {
    instructions,
    input: user,
    ...(model ? { model: String(model).trim() } : {}),
    text: {
      format: {
        type: 'json_schema',
        name: 'character_fingerprint',
        strict: true,
        schema
      }
    }
  }

  const { json, meta } = await openaiResponsesJsonForTools({ body, provider, apiUrl })
  let outText = ''
  try {
    outText = typeof json.output_text === 'string' ? json.output_text : ''
  } catch (_) {}
  if (!outText) {
    try {
      const items = Array.isArray(json.output) ? json.output : []
      const parts = []
      for (const it of items) {
        if (!it || typeof it !== 'object' || String(it.type) !== 'message') continue
        const content = Array.isArray(it.content) ? it.content : []
        for (const c of content) {
          if (c && typeof c === 'object' && String(c.type) === 'output_text' && typeof c.text === 'string') parts.push(c.text)
        }
      }
      outText = parts.join('').trim()
    } catch (_) {}
  }
  if (!outText) throw new Error('empty_ai_output')

  const parsed = JSON.parse(outText)
  return {
    result: {
      fingerprintPrompt: String(parsed.fingerprintPrompt || '').trim(),
      negativePrompt: parsed.negativePrompt == null ? '' : String(parsed.negativePrompt || '').trim()
    },
    meta
  }
}

export async function generateCharacterFingerprintViaDoubao({
  storyTitle,
  characterName,
  contextText,
  globalPrompt,
  style,
  model,
  proxyUrl
}) {
  const st = normalizeStyle(style) || 'picture_book'

  const instructions =
    `你是“交互故事制作工具”的角色设定助手。\n` +
    `任务：为一个角色生成“外观指纹（全局锁定）”，用于后续所有场景/姿势生成，保证同一人物/同一只动物不跑偏。\n` +
    `输出为 JSON（必须严格符合 schema），不要输出解释文字。\n` +
    `要求（重要）：\n` +
    `- fingerprintPrompt 必须是一行中文，建议以“角色设定：”开头。\n` +
    `- 指纹必须包含：年龄段/性别（若适用）/发型或毛发/面部特征/服饰材质与主色/标志性配饰/体型或气质。\n` +
    `- 如果是动物：必须包含“仅一只（唯一）”与颜色/体型/特征（耳朵/花纹/尾巴等）。\n` +
    `- 不要写剧情，不要写场景；只写角色固定外观。\n` +
    `- 风格要与全局一致（${styleName(st)}）。\n` +
    `- negativePrompt 用逗号分隔短词，重点抑制：变脸,换装,发型变化,颜色变化,多只动物,风格漂移；可为 null。\n`

  const user =
    `故事名（可为空）：${String(storyTitle || '').trim()}\n` +
    `全局设定（可为空）：${String(globalPrompt || '').trim()}\n` +
    `角色名：${String(characterName || '').trim()}\n` +
    `上下文（可为空）：${String(contextText || '').trim()}\n`

  const { parsed, meta } = await generateStrictJsonViaDoubaoChat({
    instructions,
    input: user,
    timeoutMs: 60_000,
    model: String(model || '').trim() || undefined,
    proxyUrl,
    maxRetries: 2,
    validate: (obj) => validateCharacterFingerprint(obj).ok
  })

  return {
    result: {
      fingerprintPrompt: String(parsed.fingerprintPrompt || '').trim(),
      negativePrompt: parsed.negativePrompt == null ? '' : String(parsed.negativePrompt || '').trim()
    },
    meta
  }
}

export async function generateCharacterFingerprint(input) {
  const provider = String((input && input.provider) || process.env.STUDIO_AI_PROVIDER || '').trim().toLowerCase() || 'localoxml'
  if (provider === 'doubao') return generateCharacterFingerprintViaDoubao(input)
  return generateCharacterFingerprintViaOpenAI(input)
}

// ============ 2026-09-01 姿势变体：AI 生成姿势提示词中文稿 ============
// 与指纹生成同款链路（openai 兼容 responses JSON schema / doubao strict chat），
// 输出中文稿，英文稿由端点再经 translatePromptText 产出（与主流程「中文稿→翻译→英文稿」一致）。

function characterPosePromptSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      posePromptZh: { type: 'string', minLength: 1, maxLength: 400 }
    },
    required: ['posePromptZh']
  }
}

function buildPosePromptInstructions(reviewFeedback) {
  const fb = String(reviewFeedback || '').trim()
  return (
    `你是“交互故事制作工具”的角色姿势提示词助手。\n` +
    `任务：为一个已锁定外观的角色生成「单张姿势立绘」的中文姿势提示词（后续会翻译成英文用于生图）。\n` +
    `要求（重要）：\n` +
    `- 先读懂剧情文本，判断该角色在此剧情点的视角/动作/表情需求；剧情中有明确的指向、注视、背负、搬运、奔跑等动作时必须在提示词中体现出来。\n` +
    `- 解剖适配（硬约束，2026-09-10 实测修复）：先从角色外观指纹判断物种。动物角色（鸟/兽/鱼等）严禁出现手臂、手指、手势、胳膊等拟人词汇，只能用该动物真实身体部位（如鸟类：翅膀/喙/爪/尾羽/头颈）；姿势必须是该动物天然能做的（乌鸦可以衔、飞、俯身、探头、踱步，不能"伸手指向"）。\n` +
    `- 禁止无剧情依据的正面站桩立绘（plain front view standing）；剧情没有明确动作时，也要结合剧情情绪给出有叙事感的姿势。\n` +
    `- 只描写：视角（正面/侧面/背身）、动作、表情与身体部位位置；一行中文，逗号分隔短语。\n` +
    `- 服装延续约束：动物角色写"毛色/体态与主参考一致"；人物角色写"服装与主参考保持一致、不得换装"。一句短语即可。\n` +
    `- 严禁描写背景/场景/环境/地面/道具陈设（姿势立绘用纯绿幕底，场景词会把生成带跑）；剧情中出现的道具只写动作意图（如"衔物"），严禁写出道具名称（否则道具会被画进立绘）。\n` +
    `- 只写正面描述：否定式约束（严禁/禁止/不要出现某物等）不得写进输出——需要抑制的内容由负向词承担，正向稿里出现否定对象词（如"拟人肢体"）反而会牵引模型去画它。\n` +
    `- 不要照抄角色外观指纹全文；只在延续约束里点名关键特征即可。\n` +
    `- 单主体：仅该角色一个，不要出现其他角色。\n` +
    // 2026-09-02 评分反馈闭环：上次生成经视觉评审未达标时，带评审理由让模型针对性改进
    (fb ? `- 上次生成经视觉评审未达标，理由：${fb}；请针对性改进提示词，剧情动作要求保持不变。\n` : '') +
    `- 输出严格 JSON：{"posePromptZh": "..."}，不要输出解释文字。\n`
  )
}

function buildPosePromptUser({ characterName, fingerprintPrompt, sceneText, userHint }) {
  return (
    `角色名：${String(characterName || '').trim()}\n` +
    `角色外观指纹（仅供理解身份与服装，不要照抄）：${String(fingerprintPrompt || '').trim() || '（空）'}\n` +
    `场景上下文（仅供理解动作意图，严禁描写场景本身）：${String(sceneText || '').trim() || '（空）'}\n` +
    // 2026-09-02 实测修复：字段里残留的上版完整草稿会被模型当作"额外要求"整段保留（正面站桩词反复重生）。
    // 明确语义：hint 只是补充约束；与剧情动作冲突时以剧情为准；上一版草稿只参考风格词汇，不得保留其姿势。
    `用户额外要求（可为空；仅作补充约束。若与剧情动作冲突，以剧情为准；若内容像上一版完整姿势稿，只参考其风格词汇，严禁保留其姿势）：${String(userHint || '').trim() || '（无）'}\n`
  )
}

async function generateCharacterPosePromptViaOpenAI(input) {
  const body = {
    instructions: buildPosePromptInstructions(input?.reviewFeedback),
    input: buildPosePromptUser(input),
    max_output_tokens: 2048, // 2026-09-01：输出短，封顶以压 OMLX KV 预留（默认 8192 会撞内存护栏）
    ...(input && input.model ? { model: String(input.model).trim() } : {}),
    text: {
      format: {
        type: 'json_schema',
        name: 'character_pose_prompt',
        strict: true,
        schema: characterPosePromptSchema()
      }
    }
  }
  const { json, meta } = await openaiResponsesJsonForTools({ body, provider: String(input?.provider || 'localoxml'), apiUrl: input?.apiUrl, proxyUrl: input?.proxyUrl })
  // 2026-09-01 实测修复：OMLX 对 json_schema 可能把 token 烧进 reasoning_content 致 output_text 为空，
  // openaiResponsesJsonForTools 会回退 chat/completions；必须用 extractResponseOutputText（兼容两种返回形状），
  // 只读 output_text/output 会在回退路径误判 empty_ai_output。
  const outText = String(extractResponseOutputText(json) || '').trim()
  if (!outText) throw new Error('empty_ai_output')
  const parsed = JSON.parse(outText)
  const posePromptZh = String(parsed && parsed.posePromptZh || '').trim()
  if (!posePromptZh) throw new Error('invalid_pose_prompt_response')
  return { result: { posePromptZh }, meta }
}

async function generateCharacterPosePromptViaDoubao(input) {
  const { parsed, meta } = await generateStrictJsonViaDoubaoChat({
    instructions: buildPosePromptInstructions(input?.reviewFeedback),
    input: buildPosePromptUser(input),
    model: String(input?.model || '').trim() || undefined,
    proxyUrl: input?.proxyUrl,
    timeoutMs: 60_000,
    maxRetries: 2,
    validate: (obj) => Boolean(obj && typeof obj === 'object' && String(obj.posePromptZh || '').trim())
  })
  const posePromptZh = String(parsed && parsed.posePromptZh || '').trim()
  if (!posePromptZh) throw new Error('invalid_pose_prompt_response')
  return { result: { posePromptZh }, meta }
}

export async function generateCharacterPosePrompt(input) {
  const provider = String((input && input.provider) || process.env.STUDIO_AI_PROVIDER || '').trim().toLowerCase() || 'localoxml'
  if (provider === 'doubao') return generateCharacterPosePromptViaDoubao(input)
  return generateCharacterPosePromptViaOpenAI(input)
}
