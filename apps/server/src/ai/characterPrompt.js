import { openaiResponsesJsonForTools } from './openai.js'
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
  provider
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

  const { json, meta } = await openaiResponsesJsonForTools({ body, provider })
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
