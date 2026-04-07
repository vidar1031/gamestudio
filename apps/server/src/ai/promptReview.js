import { extractResponseOutputText, openaiResponsesJsonForTools } from './openai.js'
import { generateStrictJsonViaOllamaChat } from './ollama.js'
import { generateStrictJsonViaDoubaoChat } from './doubao.js'

function clampInt(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.floor(v)))
}

function normalizeFormula(input) {
  const choicePoints = clampInt(input?.choicePoints, 1, 3, 2)
  const optionsPerChoice = Number(input?.optionsPerChoice) === 3 ? 3 : 2
  const endings = optionsPerChoice
  return { choicePoints, optionsPerChoice, endings, format: 'numeric' }
}

function splitLines(s) {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
}

function parsePromptSections(prompt) {
  const sections = {}
  const order = []
  for (const raw of splitLines(prompt)) {
    const line = String(raw || '').trim()
    if (!line) continue
    const m = line.match(/^([^:：]{1,24})[:：]\s*(.+)$/)
    if (!m) continue
    const key = String(m[1] || '').trim()
    const value = String(m[2] || '').trim()
    if (!key || !value) continue
    sections[key] = value
    order.push(key)
  }
  return { sections, order }
}

function estimateDetailLevel(text) {
  const s = String(text || '').trim()
  if (!s) return 0
  const parts = s.split(/[，,、；;]/).map((x) => x.trim()).filter(Boolean)
  return Math.max(parts.length, s.length >= 14 ? 2 : 1)
}

function pushCheck(checks, id, ok, severity, message) {
  checks.push({ id, ok: Boolean(ok), severity: String(severity || 'info'), message: String(message || '') })
}

function containsAny(text, words) {
  const s = String(text || '').trim()
  if (!s) return false
  return (words || []).some((word) => word && s.includes(String(word)))
}

function inferThemeProfile(title) {
  const raw = String(title || '').trim()
  const subjectProfiles = [
    {
      id: 'cat',
      terms: ['小猫', '猫咪', '猫'],
      defaultProtagonist: '一只小猫，戴小草帽，背小鱼桶，拿竹鱼竿，活泼好奇',
      subjectHints: ['小猫', '猫']
    },
    {
      id: 'rabbit',
      terms: ['小兔', '兔子', '兔'],
      defaultProtagonist: '一只小兔，长耳朵，背小布包，动作敏捷，性格胆小又好奇',
      subjectHints: ['小兔', '兔子', '兔']
    },
    {
      id: 'bird',
      terms: ['小鸟', '鸟'],
      defaultProtagonist: '一只小鸟，羽毛柔软，背小叶包，动作轻快，性格机灵',
      subjectHints: ['小鸟', '鸟']
    },
    {
      id: 'boy',
      terms: ['少年', '男孩', '小男孩', '牧童'],
      defaultProtagonist: '一个少年主角，衣着简洁，带有明确关键道具，性格认真但会犹豫',
      subjectHints: ['少年', '男孩', '小男孩', '牧童']
    },
    {
      id: 'girl',
      terms: ['女孩', '小女孩', '少女'],
      defaultProtagonist: '一个女孩主角，外观清晰，带有明确关键道具，性格勇敢又细腻',
      subjectHints: ['女孩', '小女孩', '少女']
    }
  ]
  const actionProfiles = [
    {
      id: 'fishing',
      match: /钓鱼/,
      worldHints: ['湖', '河', '池', '溪', '岸', '水边', '湖边'],
      moralHints: ['专心', '专注', '耐心', '坚持', '认真', '一心一意', '不贪玩'],
      genericMoralConflicts: ['诚实守信', '守诺负责', '团结协作'],
      defaultWorld: '春天清晨，公园湖边，柳树、草地、浅水岸边，阳光明亮，水面平静',
      defaultMoral: '做事要专心，坚持和耐心比贪玩更容易带来收获',
      discouragedWorld: ['古代', '宫廷', '朝堂', '战场', '仙界', '神界']
    },
    {
      id: 'school',
      match: /上学|放学|课堂|校园/,
      worldHints: ['学校', '教室', '操场', '校门', '走廊'],
      moralHints: ['守时', '负责', '认真', '友善', '诚实'],
      genericMoralConflicts: [],
      defaultWorld: '清晨校园，教室与操场相连，阳光温和，学生来往有序',
      defaultMoral: '做事认真负责，比临时慌乱更能解决问题',
      discouragedWorld: ['古代', '宫廷', '仙界', '神界']
    }
  ]

  const subject = subjectProfiles.find((item) => item.terms.some((term) => raw.includes(term))) || null
  const action = actionProfiles.find((item) => item.match.test(raw)) || null
  return {
    title: raw,
    subject,
    action
  }
}

function synthesizeOptimizedPrompt(sections, formula, title) {
  const profile = inferThemeProfile(String(sections['故事主题'] || title || '').trim())
  const styleRaw = String(sections['视觉风格'] || sections['风格'] || '').trim()
  const mainStyle = styleRaw
    .split(/[，,、]/)
    .map((x) => x.trim())
    .filter(Boolean)[0] || '绘本'
  const theme = String(sections['故事主题'] || title || '请填写故事主题').trim()
  const moralRaw = String(sections['核心寓意'] || sections['寓意'] || '').trim()
  const worldRaw = String(sections['世界观锚点'] || '').trim()
  const protagonistRaw = String(sections['主角设定'] || '').trim()
  const worldUse = profile.action && (!worldRaw || !containsAny(worldRaw, profile.action.worldHints))
    ? profile.action.defaultWorld
    : (worldRaw || '请明确时间、天气、地点、环境元素')
  const moralUse = profile.action && (!moralRaw || !containsAny(moralRaw, profile.action.moralHints))
    ? profile.action.defaultMoral
    : (moralRaw || '请明确这个故事希望孩子记住的价值判断')
  const protagonistUse = profile.subject && (!protagonistRaw || !containsAny(protagonistRaw, profile.subject.subjectHints))
    ? profile.subject.defaultProtagonist
    : (protagonistRaw || '请明确主角外观、道具、性格与身份')

  const lines = [
    `模板：${String(sections['模板'] || '寓言标准版（适合“寓意清晰 + 互动选择”）').trim()}`,
    `故事主题：${theme}`,
    `核心寓意：${moralUse}`,
    `世界观锚点：${worldUse}`,
    `主角设定：${protagonistUse}`,
    `视觉风格：${mainStyle}`,
    `叙事语气：${String(sections['叙事语气'] || '温暖积极，轻松幽默').trim()}`,
    `限制条件：${String(sections['限制条件'] || '避免暴力血腥，适合儿童阅读').trim()}`,
    `互动结构：选择点 ${formula.choicePoints}，每点 ${formula.optionsPerChoice} 选，结局 ${formula.endings}`,
    `分镜要求：${String(sections['分镜要求'] || '每卡 1-3 句，必须包含可演出动作/环境变化；选择必须有真实后果，不要伪选择').trim()}`,
    `可视化约束：${String(sections['可视化约束'] || '禁止只写“面临选择/关键节点/后果总结”，必须写可见画面（角色动作、景别、道具、光线）').trim()}`,
    `生图友好：${String(sections['生图友好'] || '每个场景可提炼出“主体+动作+场景+光线+镜头+情绪”，并保持角色外观前后一致').trim()}`,
    `一致性锚点：${String(sections['一致性锚点'] || '主角外观（服装/发型/年龄感/关键道具）在所有场景不漂移').trim()}`,
    `分支连续性约束：${String(sections['分支连续性约束'] || '如果多个分支重新合流到同一场景，该场景只能描述所有分支都成立的共同事实；若某个状态只属于单一路径，就必须拆成不同承接卡，不能写进共享场景').trim()}`,
    `结局约束：${String(sections['结局约束'] || '结局只能总结当前路径真实发生过的事件，不能引用其他分支的经历').trim()}`,
    `命名约束：${String(sections['命名约束'] || '选项使用“选项1..N”，后果卡使用“i后果k”，结局使用“结局1..结局N”').trim()}`,
    `补充说明：${String(sections['补充说明'] || '无').trim()}`
  ]
  return lines.join('\n')
}

export function reviewStoryPromptLocally({ prompt, title, formula }) {
  const raw = String(prompt || '').trim()
  const f = normalizeFormula(formula)
  const { sections } = parsePromptSections(raw)
  const checks = []
  const suggestions = []

  pushCheck(checks, 'prompt_present', Boolean(raw), raw ? 'info' : 'error', raw ? '提示词已填写。' : '提示词为空。')
  if (!raw) {
    suggestions.push('请先生成或填写提示词，再做分析。')
    const optimizedPrompt = synthesizeOptimizedPrompt({}, f, String(title || '').trim())
    return {
      ok: false,
      score: 0,
      summary: '提示词为空，无法生成稳定故事。',
      checks,
      suggestions,
      optimizedPrompt
    }
  }

  const theme = String(sections['故事主题'] || title || '').trim()
  const themeProfile = inferThemeProfile(theme)
  const moral = String(sections['核心寓意'] || sections['寓意'] || '').trim()
  const world = String(sections['世界观锚点'] || '').trim()
  const protagonist = String(sections['主角设定'] || '').trim()
  const style = String(sections['视觉风格'] || '').trim()
  const tone = String(sections['叙事语气'] || '').trim()
  const continuity = String(sections['分支连续性约束'] || '').trim()
  const endingConstraint = String(sections['结局约束'] || '').trim()
  const visual = String(sections['可视化约束'] || '').trim()
  const imageFriendly = String(sections['生图友好'] || '').trim()
  const consistency = String(sections['一致性锚点'] || '').trim()

  const worldDetail = estimateDetailLevel(world)
  const protagonistDetail = estimateDetailLevel(protagonist)
  const styleTags = style.split(/[，,、]/).map((x) => x.trim()).filter(Boolean)

  pushCheck(checks, 'theme_present', Boolean(theme), theme ? 'info' : 'error', theme ? '故事主题已明确。' : '缺少“故事主题”。')
  pushCheck(checks, 'moral_present', Boolean(moral), moral ? 'info' : 'warn', moral ? '核心寓意已明确。' : '缺少“核心寓意”，寓言主题可能不够聚焦。')
  pushCheck(checks, 'world_detail', worldDetail >= 2, worldDetail >= 2 ? 'info' : 'warn', worldDetail >= 2 ? '世界观锚点较完整。' : '世界观锚点偏薄，建议补充时间/天气/环境元素。')
  pushCheck(checks, 'protagonist_detail', protagonistDetail >= 2, protagonistDetail >= 2 ? 'info' : 'warn', protagonistDetail >= 2 ? '主角设定较完整。' : '主角设定偏薄，建议补充外观、道具、性格或身份。')
  pushCheck(checks, 'style_focus', styleTags.length === 1, styleTags.length === 1 ? 'info' : 'warn', styleTags.length === 1 ? '视觉风格聚焦。' : '视觉风格含多个主风格，容易让出图风格摇摆。')
  pushCheck(checks, 'tone_present', Boolean(tone), tone ? 'info' : 'warn', tone ? '叙事语气已明确。' : '缺少“叙事语气”。')
  pushCheck(checks, 'visual_constraints', Boolean(visual), visual ? 'info' : 'warn', visual ? '可视化约束已给出。' : '缺少“可视化约束”。')
  pushCheck(checks, 'image_friendly', Boolean(imageFriendly), imageFriendly ? 'info' : 'warn', imageFriendly ? '生图友好约束已给出。' : '缺少“生图友好”约束。')
  pushCheck(checks, 'consistency_anchor', Boolean(consistency), consistency ? 'info' : 'warn', consistency ? '一致性锚点已给出。' : '缺少角色一致性锚点。')
  pushCheck(checks, 'continuity_constraint', Boolean(continuity), continuity ? 'info' : 'warn', continuity ? '分支连续性约束已给出。' : '缺少分支合流约束，容易出现路径状态穿帮。')
  pushCheck(checks, 'ending_constraint', Boolean(endingConstraint), endingConstraint ? 'info' : 'warn', endingConstraint ? '结局路径约束已给出。' : '缺少结局路径约束，结局可能偷用其他分支记忆。')

  if (themeProfile.subject) {
    const protagonistAligned = containsAny(protagonist, themeProfile.subject.subjectHints)
    pushCheck(
      checks,
      'theme_subject_alignment',
      protagonistAligned,
      protagonistAligned ? 'info' : 'error',
      protagonistAligned
        ? '主角设定与故事主题主体一致。'
        : `主角设定与故事主题不一致：当前主题更像“${themeProfile.subject.subjectHints[0]}”视角，但主角字段没有写到对应主体。`
    )
    if (!protagonistAligned) suggestions.push(`把“主角设定”改成围绕“${themeProfile.subject.subjectHints[0]}”展开，至少写清外观、道具和性格。`)
  }

  if (themeProfile.action) {
    const worldAligned = containsAny(world, themeProfile.action.worldHints)
    const moralAligned = containsAny(moral, themeProfile.action.moralHints)
    const discouragedWorld = containsAny(world, themeProfile.action.discouragedWorld)
    const moralConflict = containsAny(moral, themeProfile.action.genericMoralConflicts)
    pushCheck(
      checks,
      'theme_world_alignment',
      worldAligned && !discouragedWorld,
      worldAligned && !discouragedWorld ? 'info' : 'error',
      worldAligned && !discouragedWorld
        ? '世界观锚点与故事动作主题一致。'
        : `世界观锚点与故事主题偏移：当前题材需要出现${themeProfile.action.worldHints.slice(0, 3).join(' / ')}这类场景信息，不宜只写成“${world || '空白'}”。`
    )
    pushCheck(
      checks,
      'theme_moral_alignment',
      moralAligned && !moralConflict,
      moralAligned && !moralConflict ? 'info' : 'error',
      moralAligned && !moralConflict
        ? '核心寓意与故事动作主题贴合。'
        : `核心寓意与故事主题不贴合：当前题材更适合“${themeProfile.action.moralHints.slice(0, 4).join(' / ')}”这类价值判断。`
    )
    if (!worldAligned || discouragedWorld) suggestions.push(`把“世界观锚点”改成与“${theme}”直接相关的可见场景，例如：${themeProfile.action.defaultWorld}。`)
    if (!moralAligned || moralConflict) suggestions.push(`把“核心寓意”改成更贴题的表达，例如：${themeProfile.action.defaultMoral}。`)
  }

  if (!moral) suggestions.push('补一条“核心寓意”，让模型知道两个结局要体现什么价值差异。')
  if (worldDetail < 2) suggestions.push('把世界观锚点写具体：时间、季节、天气、地点、可见环境元素至少写到 3 项。')
  if (protagonistDetail < 2) suggestions.push('把主角设定写具体：外观、关键道具、性格或身份至少写到 2 项。')
  if (styleTags.length !== 1) suggestions.push('视觉风格最好只保留一个主风格，例如“绘本”，其余风格描述放到补充说明。')
  if (!continuity) suggestions.push('补上“分支连续性约束”，明确共享合流场景只能描述共同事实。')
  if (!endingConstraint) suggestions.push('补上“结局约束”，明确结局只能总结当前路径真实发生过的事件。')

  const hasError = checks.some((x) => !x.ok && x.severity === 'error')
  const warnCount = checks.filter((x) => !x.ok && x.severity === 'warn').length
  const score = Math.max(0, Math.min(100, 100 - (hasError ? 35 : 0) - warnCount * 8))
  const ok = !hasError && warnCount <= 1
  const summary = hasError
    ? '提示词存在缺失项，直接生成故事风险较高。'
    : warnCount
      ? '提示词可用，但还有若干薄弱点，建议先补强再生成。'
      : '提示词结构完整，适合进入故事生成。'

  return {
    ok,
    score,
    summary,
    checks,
    suggestions,
    optimizedPrompt: synthesizeOptimizedPrompt(sections, f, theme)
  }
}

function promptReviewSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      verdict: { type: 'string', enum: ['ok', 'warn', 'error'] },
      summary: { type: 'string', minLength: 1, maxLength: 300 },
      strengths: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 120 } },
      risks: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 140 } },
      suggestions: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 160 } },
      optimizedPrompt: { type: 'string', minLength: 1, maxLength: 4000 }
    },
    required: ['verdict', 'summary', 'strengths', 'risks', 'suggestions', 'optimizedPrompt']
  }
}

function validateAiPromptReview(obj) {
  if (!obj || typeof obj !== 'object') return false
  if (!['ok', 'warn', 'error'].includes(String(obj.verdict || ''))) return false
  if (!String(obj.summary || '').trim()) return false
  if (!Array.isArray(obj.strengths) || !Array.isArray(obj.risks) || !Array.isArray(obj.suggestions)) return false
  if (!String(obj.optimizedPrompt || '').trim()) return false
  return true
}

function buildReviewInstructions(formula) {
  const f = normalizeFormula(formula)
  return (
    `你是“交互故事生成提示词”的审稿助手。\n` +
    `任务：审查一段用于生成互动故事脚本的提示词，判断它是否足够稳定，能否产出“适合连续场景出图”的故事脚本。\n` +
    `重点审查：\n` +
    `- 是否明确故事主题与核心寓意\n` +
    `- 是否明确世界观锚点（时间/地点/天气/环境元素）\n` +
    `- 是否明确主角设定（外观/道具/性格/身份）\n` +
    `- 是否和故事主题语义一致：例如标题是“小猫钓鱼”，那么“主角设定”就不应写成“少年主角”；“核心寓意”也应贴合“专心、耐心、坚持、不贪玩”等，而不是无关的泛道德词；“世界观锚点”应与钓鱼场景有关，不应只写成“古代、东方”这类偏题泛词。\n` +
    `- 是否有风格冲突或描述过薄\n` +
    `- 是否明确分支连续性约束：共享合流场景只能描述共同事实，不能引用单一路径专属状态\n` +
    `- 是否明确结局约束：结局只能总结当前路径真实发生过的事件\n` +
    `- 是否足够可视化、可演出、可生图\n` +
    `- 是否与结构公式匹配：选择点 ${f.choicePoints}，每点 ${f.optionsPerChoice} 选，结局 ${f.endings}\n` +
    `输出要求：\n` +
    `- 只输出 JSON，不要解释文字。\n` +
    `- 必须严谨指出“不贴题/不一致/偏题”的字段，不能只说“已填写”。\n` +
    `- optimizedPrompt 必须是一版可以直接替换使用的完整提示词，保留原主题，但补足薄弱点。\n`
  )
}

async function reviewViaOpenAICompatible({ prompt, provider, model, apiUrl, proxyUrl, formula }) {
  const body = {
    text: {
      format: {
        type: 'json_schema',
        name: 'story_prompt_review',
        strict: true,
        schema: promptReviewSchema()
      }
    },
    instructions: buildReviewInstructions(formula),
    input: `请审查并优化下面这段提示词：\n\n${String(prompt || '').trim()}`
  }
  const { json, meta } = await openaiResponsesJsonForTools({ body, provider, apiUrl, proxyUrl, model, timeoutMs: 60_000 })
  const parsed = JSON.parse(extractResponseOutputText(json) || '{}')
  if (!validateAiPromptReview(parsed)) throw new Error('invalid_prompt_review_output')
  return { review: parsed, meta }
}

async function reviewViaOllama({ prompt, model, apiUrl, proxyUrl, formula }) {
  const { parsed, meta } = await generateStrictJsonViaOllamaChat({
    instructions:
      buildReviewInstructions(formula) +
      `输出 JSON（必须严格符合 schema）：{"verdict":"ok|warn|error","summary":string,"strengths":[string],"risks":[string],"suggestions":[string],"optimizedPrompt":string}`,
    input: `请审查并优化下面这段提示词：\n\n${String(prompt || '').trim()}`,
    model,
    apiUrl,
    proxyUrl,
    timeoutMs: 60_000,
    maxRetries: 2,
    validate: validateAiPromptReview
  })
  return { review: parsed, meta }
}

async function reviewViaDoubao({ prompt, model, apiUrl, proxyUrl, formula }) {
  const { parsed, meta } = await generateStrictJsonViaDoubaoChat({
    instructions:
      buildReviewInstructions(formula) +
      `输出 JSON（必须严格符合 schema）：{"verdict":"ok|warn|error","summary":string,"strengths":[string],"risks":[string],"suggestions":[string],"optimizedPrompt":string}`,
    input: `请审查并优化下面这段提示词：\n\n${String(prompt || '').trim()}`,
    model,
    apiUrl,
    proxyUrl,
    timeoutMs: 60_000,
    maxRetries: 2,
    validate: validateAiPromptReview
  })
  return { review: parsed, meta }
}

export async function reviewStoryPromptWithAi({ prompt, provider, model, apiUrl, proxyUrl, formula }) {
  const p = String(provider || '').trim().toLowerCase()
  if (p === 'openai' || p === 'localoxml') return reviewViaOpenAICompatible({ prompt, provider: p, model, apiUrl, proxyUrl, formula })
  if (p === 'ollama') return reviewViaOllama({ prompt, model, apiUrl, proxyUrl, formula })
  if (p === 'doubao') return reviewViaDoubao({ prompt, model, apiUrl, proxyUrl, formula })
  return null
}
