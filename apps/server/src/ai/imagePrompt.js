import { openaiResponsesJsonForTools } from './openai.js'
import { generateBackgroundPromptViaDoubao } from './doubao.js'
import { generateStrictJsonViaOllamaChat } from './ollama.js'

function backgroundPromptSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      globalPrompt: { type: ['string', 'null'], maxLength: 800 },
      globalNegativePrompt: { type: ['string', 'null'], maxLength: 500 },
      scenePrompt: { type: 'string', minLength: 1, maxLength: 600 },
      sceneNegativePrompt: { type: ['string', 'null'], maxLength: 300 },
      prompt: { type: 'string', minLength: 1, maxLength: 600 },
      negativePrompt: { type: ['string', 'null'], maxLength: 300 },
      aspectRatio: { type: 'string', enum: ['9:16', '16:9', '1:1', '9:1'] },
      style: { type: 'string', enum: ['picture_book', 'cartoon', 'national_style', 'watercolor'] }
    },
    required: [
      'globalPrompt',
      'globalNegativePrompt',
      'scenePrompt',
      'sceneNegativePrompt',
      'prompt',
      'negativePrompt',
      'aspectRatio',
      'style'
    ]
  }
}

function normalizeAspectRatio(v) {
  const s = String(v || '').trim()
  return s === '9:16' || s === '16:9' || s === '1:1' || s === '9:1' ? s : null
}

function normalizeStyle(v) {
  const s = String(v || '').trim()
  return s === 'picture_book' || s === 'cartoon' || s === 'national_style' || s === 'watercolor' ? s : null
}

function clampInt(n, min, max, fallback) {
  const x = Number(n)
  if (!Number.isFinite(x)) return fallback
  return Math.max(min, Math.min(max, Math.floor(x)))
}

function truncatePromptLine(input, maxLen, joiner = ', ') {
  const s = String(input || '').trim()
  if (!s) return ''
  if (s.length <= maxLen) return s
  const parts = uniqPromptPhrases(splitPromptLike(s))
  const out = []
  let total = 0
  for (const p of parts) {
    const seg = String(p || '').trim()
    if (!seg) continue
    const add = (out.length ? joiner.length : 0) + seg.length
    if (out.length && total + add > maxLen) break
    if (!out.length && seg.length > maxLen) return seg.slice(0, maxLen)
    out.push(seg)
    total += add
  }
  const merged = out.join(joiner).trim()
  return merged || s.slice(0, maxLen)
}

export async function generateBackgroundPromptViaOpenAI({
  userInput,
  globalPrompt,
  globalNegativePrompt,
  aspectRatio,
  style,
  model,
  outputLanguage
}) {
  const ar = normalizeAspectRatio(aspectRatio) || '9:16'
  const st = normalizeStyle(style) || 'picture_book'
  const lang = String(outputLanguage || '').trim().toLowerCase() === 'en' ? 'en' : 'zh'
  const langLabel = lang === 'en' ? '英文（English）' : '中文'
  const lineJoinHint = lang === 'en' ? '逗号分隔（英文）' : '逗号分隔（中文）'
  const oneLineHint = lang === 'en' ? 'prompt/negativePrompt 必须是一行英文，不要换行。' : 'prompt/negativePrompt 必须是一行中文，不要换行。'
  const worldAnchorHint =
    lang === 'en'
      ? `- globalPrompt 必须包含“WORLD_ANCHOR”段落：明确时代/地理/建筑、色彩与光照、镜头语言、角色外观锁定（服装/发型/配饰/色彩），并要求所有场景保持连续一致。\n`
      : `- globalPrompt 必须包含“世界观锚点”段落：明确时代/地理/建筑、色彩与光照、镜头语言、角色外观锁定（服装/发型/配饰/色彩），并要求所有场景保持连续一致。\n`

  const instructions =
    `你是“交互故事制作工具”的美术提示词助手。\n` +
    `任务：把用户的自然语言描述，改写成适用于文生图模型的标准提示词。\n` +
    `输出为 JSON（必须严格符合 schema）。\n` +
    `要求（重要）：\n` +
    `- 输出语言固定为：${langLabel}。\n` +
    `- 你需要维护“全局设定”（globalPrompt/globalNegativePrompt），用于锁定整个故事的时代/环境/美术风格/禁用元素，避免后续场景跑偏。\n` +
    worldAnchorHint +
    `- 如果 globalPrompt 尚未包含明确的“角色设定”，且本场景出现人物/动物/关键物体：请在 globalPrompt 中补充一段简短“角色设定/外观指纹”（衣着、发型、面部特征、颜色、配饰等），供后续场景复用以保持一致。\n` +
    `- 当用户提到“锁定/同一人物/保持一致/沿用上一张/同一个角色/同一只动物”等一致性要求时：你必须在 globalPrompt 中新增“角色设定/一致性锁定”段落，明确列出主要角色与关键物体的固定外观（脸型/发型/服饰/颜色/配饰等），并要求后续所有场景保持同一角色与同一只动物（避免变脸/换装/变色/数量变化）。\n` +
    `- 如果场景中出现动物/道具（例如兔子），请明确数量（例如“仅一只兔子（唯一）”），避免模型画出多只。\n` +
    `- 如果用户已提供全局设定：不得改变其含义，只能做“补全/精炼/结构化”；不要把故事内容写成剧情，只写视觉设定。\n` +
    `- scenePrompt/sceneNegativePrompt 只描述“本场景的增量”，不要重复全局设定。\n` +
    `- prompt/negativePrompt 是最终提交给生图服务的合并结果（全局 + 本场景），${oneLineHint}\n` +
    `- prompt 要包含：画面主体 + 场景/动作 + 氛围/光线/镜头 + 细节；并显式写出风格与比例。\n` +
    `- style 使用枚举值：picture_book/cartoon/national_style/watercolor。\n` +
    `- 比例使用枚举值：9:16/16:9/1:1/9:1。\n` +
    `- negativePrompt/globalNegativePrompt/sceneNegativePrompt 以${lineJoinHint}的短词为主；默认补充：无文字、无水印、非真人、低质量、模糊、变形。\n` +
    `- 用户要求中出现“不要/避免/无…”的内容必须反映到 prompt 或 negativePrompt。\n` +
    `- 不要输出解释文字，只输出 JSON。`

  const user =
    `固定参数：style=${st}, aspectRatio=${ar}\n` +
    `全局设定（可为空）：${String(globalPrompt || '').trim()}\n` +
    `全局负面（可为空）：${String(globalNegativePrompt || '').trim()}\n` +
    `本场景描述：${String(userInput || '').trim()}\n`

  const schema = backgroundPromptSchema()

  const body = {
    instructions,
    input: user,
    ...(model ? { model: String(model).trim() } : {}),
    text: {
      format: {
        type: 'json_schema',
        name: 'bg_prompt',
        strict: true,
        schema
      }
    }
  }

  const { json, meta } = await openaiResponsesJsonForTools({ body })
  let outText = ''
  try {
    outText = typeof json.output_text === 'string' ? json.output_text : ''
  } catch (_) {}
  if (!outText) {
    // fallback: collect message output_text
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
      globalPrompt: parsed.globalPrompt == null ? '' : String(parsed.globalPrompt || '').trim(),
      globalNegativePrompt: parsed.globalNegativePrompt == null ? '' : String(parsed.globalNegativePrompt || '').trim(),
      prompt: String(parsed.scenePrompt || parsed.prompt || '').trim(),
      negativePrompt: parsed.sceneNegativePrompt == null ? '' : String(parsed.sceneNegativePrompt || '').trim(),
      finalPrompt: String(parsed.prompt || '').trim(),
      finalNegativePrompt: parsed.negativePrompt == null ? '' : String(parsed.negativePrompt || '').trim(),
      aspectRatio: normalizeAspectRatio(parsed.aspectRatio) || ar,
      style: normalizeStyle(parsed.style) || st
    },
    meta
  }
}

function validateBackgroundPrompt(obj) {
  const arOk = (x) => x === '9:16' || x === '16:9' || x === '1:1' || x === '9:1'
  const stOk = (x) => x === 'picture_book' || x === 'cartoon' || x === 'national_style' || x === 'watercolor'
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'not_object' }
  const keys = [
    'globalPrompt',
    'globalNegativePrompt',
    'scenePrompt',
    'sceneNegativePrompt',
    'prompt',
    'negativePrompt',
    'aspectRatio',
    'style'
  ]
  for (const k of keys) {
    if (!(k in obj)) return { ok: false, reason: `missing_${k}` }
  }
  if (!(obj.globalPrompt == null || typeof obj.globalPrompt === 'string')) return { ok: false, reason: 'invalid_globalPrompt' }
  if (!(obj.globalNegativePrompt == null || typeof obj.globalNegativePrompt === 'string')) return { ok: false, reason: 'invalid_globalNegativePrompt' }
  if (!(typeof obj.scenePrompt === 'string' && obj.scenePrompt.trim())) return { ok: false, reason: 'invalid_scenePrompt' }
  if (!(obj.sceneNegativePrompt == null || typeof obj.sceneNegativePrompt === 'string')) return { ok: false, reason: 'invalid_sceneNegativePrompt' }
  if (!(typeof obj.prompt === 'string' && obj.prompt.trim())) return { ok: false, reason: 'invalid_prompt' }
  if (!(obj.negativePrompt == null || typeof obj.negativePrompt === 'string')) return { ok: false, reason: 'invalid_negativePrompt' }
  if (!(typeof obj.aspectRatio === 'string' && arOk(obj.aspectRatio))) return { ok: false, reason: 'invalid_aspectRatio' }
  if (!(typeof obj.style === 'string' && stOk(obj.style))) return { ok: false, reason: 'invalid_style' }
  return { ok: true, reason: 'ok' }
}

export async function generateBackgroundPromptViaOllama({
  userInput,
  globalPrompt,
  globalNegativePrompt,
  aspectRatio,
  style,
  model,
  proxyUrl,
  outputLanguage,
  timeoutMs
}) {
  const ar = normalizeAspectRatio(aspectRatio) || '9:16'
  const st = normalizeStyle(style) || 'picture_book'
  const lang = String(outputLanguage || '').trim().toLowerCase() === 'en' ? 'en' : 'zh'
  const langLabel = lang === 'en' ? '英文（English）' : '中文'
  const lineJoinHint = lang === 'en' ? '逗号分隔（英文）' : '逗号分隔（中文）'
  const oneLineHint = lang === 'en' ? 'prompt/negativePrompt 必须是一行英文，不要换行。' : 'prompt/negativePrompt 必须是一行中文，不要换行。'
  const worldAnchorHint =
    lang === 'en'
      ? `- globalPrompt 必须包含“WORLD_ANCHOR”段落：明确时代/地理/建筑、色彩与光照、镜头语言、角色外观锁定（服装/发型/配饰/色彩），并要求所有场景保持连续一致。\n`
      : `- globalPrompt 必须包含“世界观锚点”段落：明确时代/地理/建筑、色彩与光照、镜头语言、角色外观锁定（服装/发型/配饰/色彩），并要求所有场景保持连续一致。\n`

  const instructions =
    `你是“交互故事制作工具”的美术提示词助手。\n` +
    `任务：把用户的自然语言描述，改写成适用于文生图模型的标准提示词。\n` +
    `输出为 JSON（必须严格符合 schema）：\n` +
    `{"globalPrompt":string|null,"globalNegativePrompt":string|null,"scenePrompt":string,"sceneNegativePrompt":string|null,"prompt":string,"negativePrompt":string|null,"aspectRatio":"9:16"|"16:9"|"1:1"|"9:1","style":"picture_book"|"cartoon"|"national_style"|"watercolor"}\n` +
    `要求（重要）：\n` +
    `- 输出语言固定为：${langLabel}。\n` +
    `- 你需要维护“全局设定”（globalPrompt/globalNegativePrompt），用于锁定整个故事的时代/环境/美术风格/禁用元素，避免后续场景跑偏。\n` +
    worldAnchorHint +
    `- 如果 globalPrompt 尚未包含明确的“角色设定”，且本场景出现人物/动物/关键物体：请在 globalPrompt 中补充一段简短“角色设定/外观指纹”（衣着、发型、面部特征、颜色、配饰等），供后续场景复用以保持一致。\n` +
    `- 当用户提到“锁定/同一人物/保持一致/沿用上一张/同一个角色/同一只动物”等一致性要求时：你必须在 globalPrompt 中新增“角色设定/一致性锁定”段落，明确列出主要角色与关键物体的固定外观（脸型/发型/服饰/颜色/配饰等），并要求后续所有场景保持同一角色与同一只动物（避免变脸/换装/变色/数量变化）。\n` +
    `- 如果用户已提供全局设定：不得改变其含义，只能做“补全/精炼/结构化”；不要把故事内容写成剧情，只写视觉设定。\n` +
    `- scenePrompt/sceneNegativePrompt 只描述“本场景的增量”，不要重复全局设定。\n` +
    `- prompt/negativePrompt 是最终提交给生图服务的合并结果（全局 + 本场景），${oneLineHint}\n` +
    `- prompt 要包含：画面主体 + 场景/动作 + 氛围/光线/镜头 + 细节；并显式写出风格与比例。\n` +
    `- style 使用枚举值：picture_book/cartoon/national_style/watercolor。\n` +
    `- 比例使用枚举值：9:16/16:9/1:1/9:1。\n` +
    `- negativePrompt/globalNegativePrompt/sceneNegativePrompt 以${lineJoinHint}的短词为主；默认补充：无文字、无水印、非真人、低质量、模糊、变形。\n` +
    `- 不要输出解释文字，只输出 JSON。`

  const user =
    `固定参数：style=${st}, aspectRatio=${ar}\n` +
    `全局设定（可为空）：${String(globalPrompt || '').trim()}\n` +
    `全局负面（可为空）：${String(globalNegativePrompt || '').trim()}\n` +
    `本场景描述：${String(userInput || '').trim()}\n`

  const { parsed, meta } = await generateStrictJsonViaOllamaChat({
    instructions,
    input: user,
    model: model ? String(model).trim() : undefined,
    proxyUrl,
    timeoutMs: clampInt(timeoutMs, 5_000, 180_000, clampInt(process.env.STUDIO_PROMPT_TIMEOUT_MS, 5_000, 180_000, 90_000)),
    maxRetries: 1,
    validate: (obj) => validateBackgroundPrompt(obj).ok
  })

  return {
    result: {
      globalPrompt: parsed.globalPrompt == null ? '' : String(parsed.globalPrompt || '').trim(),
      globalNegativePrompt: parsed.globalNegativePrompt == null ? '' : String(parsed.globalNegativePrompt || '').trim(),
      prompt: String(parsed.scenePrompt || parsed.prompt || '').trim(),
      negativePrompt: parsed.sceneNegativePrompt == null ? '' : String(parsed.sceneNegativePrompt || '').trim(),
      finalPrompt: String(parsed.prompt || '').trim(),
      finalNegativePrompt: parsed.negativePrompt == null ? '' : String(parsed.negativePrompt || '').trim(),
      aspectRatio: normalizeAspectRatio(parsed.aspectRatio) || ar,
      style: normalizeStyle(parsed.style) || st
    },
    meta
  }
}

function pickPromptProvider() {
  const explicit = String(process.env.STUDIO_BG_PROMPT_PROVIDER || process.env.STUDIO_PROMPT_PROVIDER || '').trim()
  if (explicit) return explicit.toLowerCase()
  const bgProvider = String(process.env.STUDIO_BG_PROVIDER || '').trim().toLowerCase()
  if (bgProvider === 'doubao') return 'doubao'
  return String(process.env.STUDIO_AI_PROVIDER || 'openai').toLowerCase()
}

function styleName(style) {
  const s = String(style || '').trim()
  if (s === 'picture_book') return '绘本插画'
  if (s === 'cartoon') return '卡通'
  if (s === 'national_style') return '国风'
  if (s === 'watercolor') return '水彩'
  return '插画'
}

function inferEraHint(text) {
  const s = String(text || '')
  if (!s) return ''
  // Heuristic keyword mapping (keep short; meant to seed global prompt when missing).
  const rules = [
    { re: /(画蛇添足|守株待兔|狐假虎威|刻舟求剑|掩耳盗铃|井底之蛙|揠苗助长|亡羊补牢|鹬蚌相争|叶公好龙|滥竽充数|买椟还珠|南辕北辙|自相矛盾|愚公移山|精卫填海|夸父逐日|后羿射日|嫦娥奔月)/, hint: '古代中国寓言' },
    { re: /(古代|古风|古村|古镇|古城|古装|县衙|驿站|书院|私塾|镖局|客栈|青砖|瓦房|茅屋|篱笆)/, hint: '古代中国' },
    { re: /(唐朝|盛唐|大唐|唐代)/, hint: '唐代中国' },
    { re: /(宋朝|两宋|宋代)/, hint: '宋代中国' },
    { re: /(明朝|大明|明代)/, hint: '明代中国' },
    { re: /(清朝|大清|清代)/, hint: '清代中国' },
    { re: /(民国|洋楼|旗袍|长衫|黄包车|电车)/, hint: '民国时期中国' },
    { re: /(现代|当代|城市|地铁|高楼|手机|霓虹|玻璃幕墙)/, hint: '现代城市' },
    { re: /(未来|赛博|科幻|太空|外星|机甲)/, hint: '未来科幻' }
  ]
  for (const r of rules) {
    if (r.re.test(s)) return r.hint
  }
  return ''
}

function eraHintEn(v) {
  const s = String(v || '').trim()
  if (!s) return ''
  const m = new Map([
    ['古代中国寓言', 'ancient Chinese fable world'],
    ['古代中国', 'ancient China'],
    ['唐代中国', 'Tang dynasty China'],
    ['宋代中国', 'Song dynasty China'],
    ['明代中国', 'Ming dynasty China'],
    ['清代中国', 'Qing dynasty China'],
    ['民国时期中国', 'Republic-era China'],
    ['现代城市', 'modern city'],
    ['未来科幻', 'futuristic sci-fi']
  ])
  return m.get(s) || s
}

function splitNeg(s) {
  const raw = String(s || '')
  return raw
    .split(/[,\n，、]+/g)
    .map((x) => x.trim())
    .filter(Boolean)
}

function mergeNeg(a, b) {
  const arr = [...splitNeg(a), ...splitNeg(b)]
  const out = []
  const seen = new Set()
  for (const x of arr) {
    const key = x.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(x)
  }
  return out.join(', ')
}

function mergeGlobalPrompt(a, b, fallback, joiner = '，') {
  const x = String(a || '').trim()
  const y = String(b || '').trim()
  const fb = String(fallback || '').trim()
  if (!x && !y) return fb
  if (!x) return y || fb
  if (!y) return x
  if (x.includes(y)) return x
  if (y.includes(x)) return y
  return `${x}${joiner}${y}`
}

function splitPromptLike(s) {
  return String(s || '')
    .split(/[,\n，、]+/g)
    .map((x) => x.trim())
    .filter(Boolean)
}

function uniqPromptPhrases(parts) {
  const out = []
  const seen = new Set()
  for (const p of parts) {
    const key = String(p || '').trim().toLowerCase()
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(String(p || '').trim())
  }
  return out
}

function stripAnchorFromScenePrompt(s) {
  return splitPromptLike(String(s || ''))
    .filter((p) => !/^WORLD_ANCHOR\s*:/i.test(p) && !/^ROLE_DEFINITION\s*:/i.test(p) && !/^世界观锚点[:：]/.test(p))
    .join(', ')
}

function normalizeBgPromptResult(res, input) {
  const r = res && typeof res === 'object' ? res : {}
  const ar = String(r.aspectRatio || '9:16').trim() || '9:16'
  const st = String(r.style || 'picture_book').trim() || 'picture_book'
  const lang = String(input && input.outputLanguage ? input.outputLanguage : '').trim().toLowerCase() === 'en' ? 'en' : 'zh'

  const DEFAULT_GLOBAL_NEG = lang === 'en' ? 'text, watermark, photorealistic face, low quality, blurry, deformed' : '无文字,无水印,非真人,低质量,模糊,变形'
  const DEFAULT_SCENE_NEG = lang === 'en' ? 'text, watermark, low quality, blurry, deformed' : '无文字,无水印,低质量,模糊,变形'

  const globalPromptIn = String(r.globalPrompt || '').trim()
  const inputGlobalPrompt = String(input && input.globalPrompt ? input.globalPrompt : '').trim()
  const inputGlobalNeg = String(input && input.globalNegativePrompt ? input.globalNegativePrompt : '').trim()

  const eraHintRaw = inferEraHint(
    [String(input && input.userInput ? input.userInput : '').trim(), String(r.prompt || '').trim(), String(r.scenePrompt || '').trim()]
      .filter(Boolean)
      .join('，')
  )
  const eraHint = lang === 'en' ? eraHintEn(eraHintRaw) : eraHintRaw

  const globalPromptDefault = lang === 'en'
    ? `${eraHint ? `${eraHint}, ` : ''}${st} illustration style, soft palette, low saturation, high detail, consistent camera language, clean composition, aspect ratio ${ar}`
    : `${eraHint ? `${eraHint}，` : ''}${styleName(st)}风格，色彩柔和，低饱和，高质量细节，镜头语言一致，画面干净，${ar}比例`

  // Keep user's global prompt, but allow AI to append missing details (style/era/character locks).
  let globalPrompt = mergeGlobalPrompt(inputGlobalPrompt, globalPromptIn, globalPromptDefault, lang === 'en' ? ', ' : '，')
  const worldAnchor = lang === 'en'
    ? 'WORLD_ANCHOR: same era and world setting, consistent architecture and props, consistent palette and lighting, consistent lens language, lock character appearance across all scenes'
    : '世界观锚点：同一时代与地理设定，建筑与道具统一，色彩与光照统一，镜头语言统一，角色外观全程锁定'
  if (!/(WORLD_ANCHOR|世界观锚点)/i.test(globalPrompt)) {
    globalPrompt = globalPrompt ? `${globalPrompt}${lang === 'en' ? ', ' : '，'}${worldAnchor}` : worldAnchor
  }
  globalPrompt = uniqPromptPhrases(splitPromptLike(globalPrompt)).join(lang === 'en' ? ', ' : '，')
  globalPrompt = truncatePromptLine(globalPrompt, 900, lang === 'en' ? ', ' : '，')

  const scenePromptRaw = String(r.prompt || r.scenePrompt || '').trim()
  let scenePrompt = uniqPromptPhrases(splitPromptLike(stripAnchorFromScenePrompt(scenePromptRaw))).join(', ')
  scenePrompt = truncatePromptLine(scenePrompt, 600, ', ')

  // Lock globals: if user already has a global prompt/neg, do not let later scenes override meaning.
  const globalNegativePrompt = mergeNeg(mergeNeg(String(r.globalNegativePrompt || '').trim(), inputGlobalNeg), DEFAULT_GLOBAL_NEG)
  const sceneNegativePrompt = truncatePromptLine(mergeNeg(String(r.negativePrompt || '').trim(), DEFAULT_SCENE_NEG), 300, ', ')
  const finalNegativePrompt =
    truncatePromptLine(String(r.finalNegativePrompt || '').trim(), 800, ', ') || mergeNeg(globalNegativePrompt, sceneNegativePrompt)

  return {
    ...r,
    globalPrompt,
    globalNegativePrompt: truncatePromptLine(globalNegativePrompt, 500, ', '),
    prompt: scenePrompt || String(r.scenePrompt || r.prompt || '').trim(),
    scenePrompt: scenePrompt || String(r.scenePrompt || r.prompt || '').trim(),
    negativePrompt: sceneNegativePrompt,
    finalNegativePrompt
  }
}

export async function generateBackgroundPrompt(input) {
  const provider = String((input && (input.provider || input.promptProvider)) || pickPromptProvider()).toLowerCase()
  const targetImageProvider = String(input && input.targetImageProvider ? input.targetImageProvider : '').trim().toLowerCase()
  const outputLanguage = String(input && input.outputLanguage ? input.outputLanguage : '').trim().toLowerCase() || ((targetImageProvider === 'sdwebui' || targetImageProvider === 'comfyui') ? 'en' : 'zh')
  const in2 = { ...(input || {}), outputLanguage }
  const out =
    provider === 'doubao'
      ? await generateBackgroundPromptViaDoubao(in2)
      : provider === 'ollama'
        ? await generateBackgroundPromptViaOllama(in2)
        : await generateBackgroundPromptViaOpenAI(in2)
  return { ...out, result: normalizeBgPromptResult(out && out.result ? out.result : null, in2) }
}
