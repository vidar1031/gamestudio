import { extractResponseOutputText, openaiResponsesJsonForTools } from './openai.js'
import { generateStrictJsonViaOllamaChat } from './ollama.js'
import { generateStrictJsonViaDoubaoChat } from './doubao.js'

function asStr(v) {
  return typeof v === 'string' ? v : ''
}

function asList(v) {
  return Array.isArray(v) ? v : []
}

function clampInt(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.floor(v)))
}

function splitPromptLike(input) {
  return asStr(input)
    .split(/[,\n，、；;|]/g)
    .map((x) => x.trim())
    .filter(Boolean)
}

function uniq(parts, max = 120) {
  const out = []
  const seen = new Set()
  for (const part of parts) {
    const value = asStr(part).trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= max) break
  }
  return out
}

function containsAny(text, parts) {
  const s = asStr(text)
  if (!s) return false
  return (parts || []).some((item) => item && s.includes(String(item)))
}

function parseStoryBible(raw) {
  const s = asStr(raw).trim()
  if (!s) return null
  try {
    const parsed = JSON.parse(s)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (_) {
    return null
  }
}

function buildKittenFishingPreset() {
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

function inferPreset(input) {
  const title = asStr(input && input.projectTitle).trim()
  if (/小猫钓鱼|kitten\s+goes\s+fishing|kitten.*fish/i.test(title)) return buildKittenFishingPreset()
  return null
}

function buildLocalOptimizedGlobalPromptZh(input) {
  const preset = inferPreset(input)
  if (preset) return preset.globalPromptZh
  const bible = parseStoryBible(input && input.storyBibleJson)
  const worldAnchor = asStr(bible && bible.worldAnchor).trim()
  const chars = asList(bible && bible.characters).slice(0, 2).map((x) => asStr(x && x.name).trim()).filter(Boolean)
  const props = asList(bible && bible.props).slice(0, 4).map((x) => asStr(x && x.name).trim()).filter(Boolean)
  const joinedChars = chars.length ? `核心主体固定为${chars.join('、')}` : '核心主体保持同一角色外观和比例'
  const joinedProps = props.length ? `关键道具固定为${props.join('、')}` : '关键道具和环境元素保持一致'
  return [
    '儿童绘本连续分镜，保持统一世界观、统一光线、统一色彩与统一镜头语言',
    worldAnchor ? `世界观锚点以${worldAnchor}为准` : '',
    joinedChars,
    joinedProps,
    '所有场景必须保持同一角色外观、服装、配色、道具和年龄感，不变脸、不换装、不替换核心物件',
    '画面强调可见动作、明确环境、柔和光线、干净构图和连续叙事'
  ].filter(Boolean).join('，')
}

function buildLocalOptimizedGlobalNegativePromptZh(input) {
  const preset = inferPreset(input)
  if (preset) return preset.globalNegativePromptZh
  return '多个主角, 多余人物, 换装, 换色, 变脸, 道具替换, 现代穿帮元素, 文字, 水印, logo, 对话框, 二维码, 模糊, 低质量, 畸形, 写实摄影, 过暗, 过曝'
}

function buildLocalOptimizedScenePromptZh(input) {
  const preset = inferPreset(input)
  const sceneUserInput = asStr(input && input.sceneUserInput).trim()
  const scenePromptZh = asStr(input && input.scenePromptZh).trim()
  if (scenePromptZh) return scenePromptZh
  if (preset && sceneUserInput) {
    return `同一只橘白幼年小猫在春日湖边执行当前情节，保留小草帽、薄荷绿上衣、浅蓝短裤、小鱼桶和竹鱼竿，重点表现${sceneUserInput}，画面写清主体动作、所处位置、水面与岸边环境、晨光方向、镜头景别和情绪变化，保持儿童绘本风格、单主角、连续叙事、干净构图。`
  }
  if (sceneUserInput) {
    return `围绕“${sceneUserInput}”设计单一清晰场景，补足主体动作、环境位置、光线氛围、镜头景别与情绪变化，保持与全局设定一致的角色外观、服装、道具和色彩。`
  }
  return '补足主体动作、环境位置、光线氛围、镜头景别与情绪变化，保持与全局设定一致的角色外观、服装、道具和色彩。'
}

function buildLocalOptimizedSceneNegativePromptZh() {
  return '抽象叙事词, 多个主体, 多余人物, 多余道具, 文字, 水印, logo, 对话框, 模糊, 低质量, 畸形, 写实摄影'
}

function storyboardPromptReviewSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      verdict: { type: 'string', enum: ['ok', 'warn', 'error'] },
      score: { type: 'integer', minimum: 0, maximum: 100 },
      summary: { type: 'string', minLength: 1, maxLength: 300 },
      strengths: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 120 } },
      risks: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 160 } },
      suggestions: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 180 } },
      optimizedGlobalPromptZh: { type: 'string', minLength: 1, maxLength: 1800 },
      optimizedGlobalNegativePromptZh: { type: 'string', minLength: 1, maxLength: 800 },
      optimizedScenePromptZh: { type: 'string', minLength: 1, maxLength: 1600 },
      optimizedSceneNegativePromptZh: { type: 'string', minLength: 1, maxLength: 600 },
      optimizedPrompt: { type: 'string', minLength: 1, maxLength: 1800 },
      optimizedNegativePrompt: { type: 'string', minLength: 1, maxLength: 800 }
    },
    required: [
      'verdict',
      'score',
      'summary',
      'strengths',
      'risks',
      'suggestions',
      'optimizedGlobalPromptZh',
      'optimizedGlobalNegativePromptZh',
      'optimizedScenePromptZh',
      'optimizedSceneNegativePromptZh',
      'optimizedPrompt',
      'optimizedNegativePrompt'
    ]
  }
}

function validateStoryboardPromptReview(obj) {
  return Boolean(
    obj &&
    typeof obj === 'object' &&
    ['ok', 'warn', 'error'].includes(asStr(obj.verdict).trim()) &&
    Number.isFinite(Number(obj.score)) &&
    asStr(obj.summary).trim() &&
    Array.isArray(obj.strengths) &&
    Array.isArray(obj.risks) &&
    Array.isArray(obj.suggestions) &&
    asStr(obj.optimizedGlobalPromptZh).trim() &&
    asStr(obj.optimizedGlobalNegativePromptZh).trim() &&
    asStr(obj.optimizedScenePromptZh).trim() &&
    asStr(obj.optimizedSceneNegativePromptZh).trim() &&
    asStr(obj.optimizedPrompt).trim() &&
    asStr(obj.optimizedNegativePrompt).trim()
  )
}

function buildReviewInstructions(input) {
  const scope = asStr(input && input.scope).trim() === 'global' ? 'global' : 'scene'
  return (
    '你是“连续故事场景图提示词审核器”。\n' +
    `当前任务范围：${scope === 'global' ? '全局锚点' : '单个场景'}。\n` +
    '目标：审查当前用于连续故事出图的提示词包，评估其是否足够稳定、统一、可连续生成，并给出可直接替换使用的强化版本。\n' +
    '评分标准：0-100 分，70 分以下表示风险明显，85 分以上表示可以稳定用于连续场景生成。\n' +
    '必须检查：\n' +
    '- 全局提示词是否明确世界观、时代/地点、色彩、光线、镜头语言、角色与道具锁定\n' +
    '- 全局负向是否覆盖文字、水印、变脸、换装、道具替换、多人乱入、写实跑偏等风险\n' +
    '- 场景提示词是否是“可见画面”，而不是抽象叙事总结\n' +
    '- 场景提示词是否明确主体动作、环境位置、光线、景别/镜头、情绪、关键道具\n' +
    '- 是否有利于保持同一角色/同一道具/同一地点的连续一致性\n' +
    '- 不要改剧情，只强化视觉化表达和锁定约束\n' +
    '输出要求：\n' +
    '- 只输出 JSON，不要解释文字。\n' +
    '- optimizedGlobalPromptZh/optimizedGlobalNegativePromptZh/optimizedScenePromptZh/optimizedSceneNegativePromptZh 必须是中文。\n' +
    '- optimizedPrompt/optimizedNegativePrompt 必须是一行英文，可直接提交给图像模型。\n' +
    '- 如果主题明显是“小猫钓鱼”或同类儿童钓鱼故事，必须保持同一只幼年小猫、竹鱼竿、小草帽、小鱼桶、湖边春日晨光、儿童绘本风格，不得跑成真人小孩或现代钓具。\n'
  )
}

function buildReviewInput(input) {
  const lines = [
    `projectTitle: ${asStr(input && input.projectTitle).trim() || '(empty)'}`,
    `scope: ${asStr(input && input.scope).trim() || 'scene'}`,
    `style: ${asStr(input && input.style).trim() || '(empty)'}`,
    `aspectRatio: ${asStr(input && input.aspectRatio).trim() || '(empty)'}`,
    `globalPromptZh: ${asStr(input && input.globalPromptZh).trim() || '(empty)'}`,
    `globalPromptEn: ${asStr(input && input.globalPrompt).trim() || '(empty)'}`,
    `globalNegativePromptZh: ${asStr(input && input.globalNegativePromptZh).trim() || '(empty)'}`,
    `globalNegativePromptEn: ${asStr(input && input.globalNegativePrompt).trim() || '(empty)'}`,
    `sceneUserInput: ${asStr(input && input.sceneUserInput).trim() || '(empty)'}`,
    `scenePromptZh: ${asStr(input && input.scenePromptZh).trim() || '(empty)'}`,
    `scenePromptEn: ${asStr(input && input.scenePrompt).trim() || '(empty)'}`,
    `sceneNegativePromptZh: ${asStr(input && input.sceneNegativePromptZh).trim() || '(empty)'}`,
    `sceneNegativePromptEn: ${asStr(input && input.sceneNegativePrompt).trim() || '(empty)'}`
  ]
  const storyBibleJson = asStr(input && input.storyBibleJson).trim()
  if (storyBibleJson) lines.push(`storyBibleJson: ${storyBibleJson.slice(0, 4000)}`)
  return lines.join('\n')
}

export function reviewStoryboardPromptLocally(input) {
  const scope = asStr(input && input.scope).trim() === 'global' ? 'global' : 'scene'
  const globalPrompt = asStr(input && (input.globalPromptZh || input.globalPrompt)).trim()
  const globalNegative = asStr(input && (input.globalNegativePromptZh || input.globalNegativePrompt)).trim()
  const scenePrompt = asStr(input && (input.scenePromptZh || input.scenePrompt)).trim()
  const sceneNegative = asStr(input && (input.sceneNegativePromptZh || input.sceneNegativePrompt)).trim()
  const projectTitle = asStr(input && input.projectTitle).trim()

  const strengths = []
  const risks = []
  const suggestions = []
  let errors = 0
  let warns = 0

  const hasWorldAnchor = /世界观|WORLD_ANCHOR|湖边|水边|地点|时代|晨光|光线|镜头/.test(globalPrompt)
  const hasConsistency = /同一|统一|锁定|不变脸|不换装|consistent|lock/.test(globalPrompt)
  const hasStyle = /绘本|卡通|国风|水彩|illustration|picture-book|cartoon/.test(globalPrompt)
  const hasNegCore = containsAny(globalNegative.toLowerCase(), ['文字', 'watermark', 'logo', '模糊', 'blurry', '低质量', 'deformed', '写实', 'photorealistic'])
  const hasSceneVisual = /动作|站|坐|看|拿|提|抬|走|跑|笑|哭|水边|岸边|镜头|光线|构图|姿态/.test(scenePrompt) || splitPromptLike(scenePrompt).length >= 6
  const hasAbstract = /关键节点|面临选择|后果|总结|决定|领悟|感悟/.test(scenePrompt)

  if (hasWorldAnchor) strengths.push('全局提示词包含世界观或环境锚点。')
  else {
    warns += 1
    risks.push('全局提示词缺少稳定的世界观/环境锚点。')
    suggestions.push('补充时间、地点、环境元素、光线和镜头语言，让每个场景共享同一世界观。')
  }
  if (hasConsistency) strengths.push('全局提示词已经强调角色/道具一致性。')
  else {
    warns += 1
    risks.push('全局提示词缺少角色和道具锁定约束。')
    suggestions.push('明确主角外观、服装、配色和关键道具，写清“不变脸、不换装、不替换道具”。')
  }
  if (hasStyle) strengths.push('全局提示词已包含统一风格描述。')
  else {
    warns += 1
    risks.push('全局提示词缺少稳定的美术风格描述。')
    suggestions.push('补充统一风格，例如儿童绘本、低饱和、柔和笔触、干净构图。')
  }
  if (!hasNegCore) {
    warns += 1
    risks.push('全局负向提示词不够完整，容易出现文字、水印或写实跑偏。')
    suggestions.push('在全局负向里补齐文字、水印、logo、对话框、模糊、低质量、写实摄影、多人乱入等禁用项。')
  } else strengths.push('全局负向提示词已覆盖核心风险。')

  if (scope === 'scene') {
    if (scenePrompt) strengths.push('场景提示词已生成。')
    else {
      errors += 1
      risks.push('场景提示词为空。')
      suggestions.push('先生成场景提示词，再做评分和强化。')
    }
    if (hasSceneVisual) strengths.push('场景提示词具备一定画面信息。')
    else {
      warns += 1
      risks.push('场景提示词偏抽象，画面动作与环境信息不足。')
      suggestions.push('把场景写成“谁在什么位置做什么，光线怎样，镜头如何看”的可见画面。')
    }
    if (hasAbstract) {
      warns += 1
      risks.push('场景提示词含抽象叙事词，容易导致画面不可控。')
      suggestions.push('去掉“关键节点、面临选择、后果总结”等抽象词，只保留可见动作与构图。')
    }
    if (!sceneNegative) suggestions.push('补充场景负向，避免多主体、文字和杂物干扰主画面。')
  }

  if (/小猫钓鱼|kitten\s+goes\s+fishing|kitten.*fish/i.test(projectTitle)) {
    const text = [globalPrompt, scenePrompt].join(' ')
    if (!containsAny(text, ['小猫', 'kitten', '猫'])) {
      errors += 1
      risks.push('主题是“小猫钓鱼”，但提示词没有稳定指向小猫主角。')
      suggestions.push('把主角明确写成同一只幼年小猫，并固定脸型、毛色、衣服和帽子。')
    }
    if (!containsAny(text, ['鱼竿', '竹鱼竿', 'bamboo fishing rod', '湖边', '水边', '浮漂', '小鱼桶'])) {
      warns += 1
      risks.push('主题道具或钓鱼场景元素不足，容易跑偏。')
      suggestions.push('明确写入竹鱼竿、小鱼桶、湖边或浮漂等关键钓鱼元素。')
    }
  }

  const score = Math.max(0, Math.min(100, 96 - errors * 22 - warns * 8))
  const verdict = errors > 0 ? 'error' : (warns > 1 ? 'warn' : 'ok')
  const summary =
    verdict === 'error'
      ? '提示词存在明显连续性风险，建议先强化后再批量出图。'
      : verdict === 'warn'
        ? '提示词可用，但一致性和画面控制还有可提升空间。'
        : '提示词结构较完整，适合继续生成连续故事场景图。'

  return {
    verdict,
    score,
    summary,
    strengths: strengths.slice(0, 8),
    risks: risks.slice(0, 10),
    suggestions: suggestions.slice(0, 10),
    optimizedGlobalPromptZh: buildLocalOptimizedGlobalPromptZh(input),
    optimizedGlobalNegativePromptZh: buildLocalOptimizedGlobalNegativePromptZh(input),
    optimizedScenePromptZh: buildLocalOptimizedScenePromptZh(input),
    optimizedSceneNegativePromptZh: buildLocalOptimizedSceneNegativePromptZh(input),
    optimizedPrompt: asStr(input && input.scenePrompt).trim() || asStr(input && input.globalPrompt).trim() || 'children picture-book illustration, consistent character design, clear visible action, stable environment, clean composition',
    optimizedNegativePrompt: uniq([
      ...splitPromptLike(asStr(input && input.sceneNegativePrompt)),
      ...splitPromptLike(asStr(input && input.globalNegativePrompt)),
      'text',
      'watermark',
      'logo',
      'speech bubble',
      'blurry',
      'low quality',
      'deformed',
      'photorealistic'
    ]).join(', ')
  }
}

async function reviewViaOpenAICompatible({ input, provider, model, apiUrl, proxyUrl }) {
  const body = {
    text: {
      format: {
        type: 'json_schema',
        name: 'storyboard_prompt_review',
        strict: true,
        schema: storyboardPromptReviewSchema()
      }
    },
    instructions: buildReviewInstructions(input),
    input: buildReviewInput(input),
    ...(model ? { model: asStr(model).trim() } : {})
  }
  const { json, meta } = await openaiResponsesJsonForTools({ body, provider, apiUrl, proxyUrl, timeoutMs: 60_000, model })
  const parsed = JSON.parse(extractResponseOutputText(json) || '{}')
  if (!validateStoryboardPromptReview(parsed)) throw new Error('invalid_storyboard_prompt_review_output')
  return { review: parsed, meta }
}

async function reviewViaOllama({ input, model, apiUrl, proxyUrl }) {
  const { parsed, meta } = await generateStrictJsonViaOllamaChat({
    instructions:
      buildReviewInstructions(input) +
      '输出 JSON（必须严格符合 schema）：{"verdict":"ok|warn|error","score":0,"summary":"","strengths":[""],"risks":[""],"suggestions":[""],"optimizedGlobalPromptZh":"","optimizedGlobalNegativePromptZh":"","optimizedScenePromptZh":"","optimizedSceneNegativePromptZh":"","optimizedPrompt":"","optimizedNegativePrompt":""}',
    input: buildReviewInput(input),
    model,
    apiUrl,
    proxyUrl,
    timeoutMs: 60_000,
    maxRetries: 2,
    validate: validateStoryboardPromptReview
  })
  return { review: parsed, meta }
}

async function reviewViaDoubao({ input, model, apiUrl, proxyUrl }) {
  const { parsed, meta } = await generateStrictJsonViaDoubaoChat({
    instructions:
      buildReviewInstructions(input) +
      '输出 JSON（必须严格符合 schema）：{"verdict":"ok|warn|error","score":0,"summary":"","strengths":[""],"risks":[""],"suggestions":[""],"optimizedGlobalPromptZh":"","optimizedGlobalNegativePromptZh":"","optimizedScenePromptZh":"","optimizedSceneNegativePromptZh":"","optimizedPrompt":"","optimizedNegativePrompt":""}',
    input: buildReviewInput(input),
    model,
    apiUrl,
    proxyUrl,
    timeoutMs: 60_000,
    maxRetries: 2,
    validate: validateStoryboardPromptReview
  })
  return { review: parsed, meta }
}

export async function reviewStoryboardPromptWithAi({ input, provider, model, apiUrl, proxyUrl }) {
  const p = asStr(provider).trim().toLowerCase()
  if (p === 'openai' || p === 'localoxml') return reviewViaOpenAICompatible({ input, provider: p, model, apiUrl, proxyUrl })
  if (p === 'ollama') return reviewViaOllama({ input, model, apiUrl, proxyUrl })
  if (p === 'doubao') return reviewViaDoubao({ input, model, apiUrl, proxyUrl })
  return null
}

export function normalizeStoryboardPromptReviewInput(body) {
  return {
    scope: asStr(body && body.scope).trim() === 'global' ? 'global' : 'scene',
    projectTitle: asStr(body && body.projectTitle).trim(),
    storyBibleJson: asStr(body && body.storyBibleJson).trim(),
    globalPromptZh: asStr(body && body.globalPromptZh).trim(),
    globalPrompt: asStr(body && body.globalPrompt).trim(),
    globalNegativePromptZh: asStr(body && body.globalNegativePromptZh).trim(),
    globalNegativePrompt: asStr(body && body.globalNegativePrompt).trim(),
    sceneUserInput: asStr(body && body.sceneUserInput).trim(),
    scenePromptZh: asStr(body && body.scenePromptZh).trim(),
    scenePrompt: asStr(body && body.scenePrompt).trim(),
    sceneNegativePromptZh: asStr(body && body.sceneNegativePromptZh).trim(),
    sceneNegativePrompt: asStr(body && body.sceneNegativePrompt).trim(),
    style: asStr(body && body.style).trim(),
    aspectRatio: asStr(body && body.aspectRatio).trim()
  }
}
