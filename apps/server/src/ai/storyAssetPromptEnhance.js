import { extractResponseOutputText, openaiResponsesJsonForTools } from './openai.js'
import { generateStrictJsonViaOllamaChat } from './ollama.js'
import { generateStrictJsonViaDoubaoChat } from './doubao.js'

function asStr(v) {
  return typeof v === 'string' ? v : ''
}

function asList(v) {
  return Array.isArray(v) ? v : []
}

function uniq(items, max = 40) {
  const out = []
  const seen = new Set()
  for (const item of items) {
    const s = asStr(item).trim()
    if (!s) continue
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length >= max) break
  }
  return out
}

function safeJsonText(v, max = 6000) {
  const s = asStr(v).trim()
  if (!s) return ''
  return s.slice(0, max)
}

function promptEnhanceSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      promptZh: { type: 'string', minLength: 1, maxLength: 1600 },
      negativePromptZh: { type: 'string', minLength: 1, maxLength: 900 },
      summary: { type: 'string', minLength: 1, maxLength: 220 }
    },
    required: ['promptZh', 'negativePromptZh', 'summary']
  }
}

function validatePromptEnhanceResult(obj) {
  return Boolean(
    obj &&
    typeof obj === 'object' &&
    asStr(obj.promptZh).trim() &&
    asStr(obj.negativePromptZh).trim() &&
    asStr(obj.summary).trim()
  )
}

function buildInstructions(input) {
  const category = asStr(input?.asset?.category).trim() || 'character'
  const lockProfile = asStr(input?.asset?.lockProfile).trim() || 'generic_asset'
  const assetName = asStr(input?.asset?.name).trim().toLowerCase()
  const anchorText = asStr(input?.asset?.anchorPrompt).trim().toLowerCase()
  const wearableHint = /\b(hat|cap|helmet|hood|shoe|shoes|boot|boots|glove|gloves|sandal|sandals|bag|backpack|belt|scarf|glasses)\b/.test(`${assetName} ${anchorText}`)
  return (
    '你是“故事事物锁定提示词增强器”。\n' +
    '任务：针对当前单个事物，基于 Story Bible、全文事件链、事物锚点和使用场景，重写一版更适合“锁定参考图抽卡”的增强提示词。\n' +
    '要求：\n' +
    '- 必须围绕“当前单个事物”重写，不要给通用模板，不要偷懒返回固定句子。\n' +
    '- 输出 JSON，不要解释。\n' +
    '- promptZh：中文，面向图像生成，内容具体，必须体现该事物自身的身份、外观、结构或环境特征。\n' +
    '- negativePromptZh：中文一行，写该事物专属的排除项。\n' +
    '- summary：一句中文，总结你针对这个事物强化了什么。\n' +
    '- 只输出中文增强结果，不要输出英文版本，英文会由单独翻译接口生成。\n' +
    '- 必须优先使用输入中的 assetUsageContext：把“故事职责、典型使用方式、全文事件链里的关键动作、共现事物、关联场景”吸收到提示词里，但这些内容只用于校准当前事物的设计身份，不等于把场景和其他角色画出来。\n' +
    '- 必须阅读 plan.eventChain 和 assetUsageContext.sceneSummaries，判断这个事物在全文情节里是如何被看见、被使用、被误认风险最高的；这些剧情信息必须转译成这个事物自身的识别特征、结构重点、材质重点和比例重点。\n' +
    '- 重点不是复述剧情，而是从剧情反推“观众在后续分镜里需要一眼认出它的哪些特征”。例如：如果它会被远看、被手持、被背着、被放入桶里、浮在水上、从远处观察是否下沉，你就必须把这些叙事需求转成这个物件本身的造型/结构/配色要求。\n' +
    '- 如果 assetUsageContext 已经指出该物件在故事中的功能，例如“背着出发”“装鱼”“挂在肩上”“放在岸边”，你必须把这些功能转译成这个物件自身的结构和造型关注点，而不是只写“白底商品图”。\n' +
    '- 必须避免泛化成空洞模板，例如“单一物件，白底，居中展示”不能成为主要信息；它只能作为末尾约束，前面必须先写清楚这个事物在故事里到底是什么、为什么长这样、哪些结构细节不能丢。\n' +
    '- 如果输入里有 coAssetNames 或 sceneSummaries，只能把它们当作故事语义来源，不能把这些共现角色、地点、其他道具直接写进正向画面。\n' +
    '- 如果 category=character：必须优先服务“角色白底锁定参考图”，强调单主体、全身、正面、纯白背景、空手、无场景、无多余道具，但同时要保留该角色自己的脸型、耳朵、眼睛、毛色/肤色、服装、鞋子、比例等专属性描述。\n' +
    '- 如果 category=prop：必须生成“单物件白底设计图/商品参考图”式提示词，强调材质、结构、比例、轮廓和复用稳定性；必须先补足它在故事里的职责、交互方式和使用语义，再落到结构细节；必须明确禁止人物、头部、脸部、上半身、手持、佩戴展示、模特、人体穿戴关系；必须明确禁止多视图拼贴、联系板、九宫格、重复多个同类物件。\n' +
    '- 如果当前道具属于可穿戴物（如帽子、鞋子、包、眼镜等），必须额外强调：物件单独存在、未佩戴、与角色完全分离、不可出现头模/人体/手持、必要时展示开口或内部结构、不可写成“戴在谁身上”。\n' +
    '- 对于任何 prop，禁止把“儿童、小孩、女孩、男孩、少女、人物绘本风格”写进正向提示词；如果需要风格，只能写成中性商品参考插画、设计图、白底参考图。但你必须允许“儿童故事里的用途”影响结构表达，比如尺寸、耐用性、背携方式、收纳方式。\n' +
    '- 如果输入中提供了 promptReviewFeedbackZh，必须把它当作上一轮失败原因来修正；新输出必须明确回应这些问题，而不是重复原来的泛化写法。\n' +
    '- 如果 lockProfile=slender_prop：必须强调全长完整可见、两端不可裁切、避免透视缩短、孔位/节点/接口清楚。\n' +
    '- 如果 lockProfile=rigid_prop：必须强调主要结构部件清晰、透视稳定、不可变形塌陷。\n' +
    '- 如果 lockProfile=ambient_prop：必须强调“单个氛围元素”而非完整大场景，例如单朵白云、单团雾气、单个光团，不得带地平线、建筑、树木或角色。\n' +
    '- 如果 lockProfile=organic_prop：必须强调单个自然标本或单个自然物，不要带栖息地大背景。\n' +
    '- 如果 category=location：必须生成“地点锚点图”式提示词，强调环境结构、地形、水体、植被、建筑、光线和统一世界观。\n' +
    '- 不要照抄 currentPromptZh/currentPromptEn；应基于故事信息重写和增强。\n' +
    '- 不要引入故事中不存在的新角色、新道具、新时代元素。\n' +
    '- 对于角色参考图，禁止把完整故事场景当背景直接画进去。\n' +
    '- 对于道具参考图，禁止把道具画在人物身上、头上、手里，禁止把道具和角色一起出图。\n' +
    `- 当前事物类别：${category}\n` +
    `- 当前锁定档案：${lockProfile}\n` +
    `- 当前事物是否属于可穿戴物：${wearableHint ? 'yes' : 'no'}\n`
  )
}

function buildInput(input) {
  const asset = input?.asset && typeof input.asset === 'object' ? input.asset : {}
  const plan = input?.plan && typeof input.plan === 'object' ? input.plan : {}
  const usageContext = input?.assetUsageContext && typeof input.assetUsageContext === 'object' ? input.assetUsageContext : {}
  const storyBibleJson = safeJsonText(input?.storyBibleJson, 5000)
  const lines = [
    `projectTitle: ${asStr(input?.projectTitle).trim() || '(empty)'}`,
    `asset.id: ${asStr(asset.id).trim() || '(empty)'}`,
    `asset.name: ${asStr(asset.name).trim() || '(empty)'}`,
    `asset.category: ${asStr(asset.category).trim() || '(empty)'}`,
    `asset.lockProfile: ${asStr(asset.lockProfile).trim() || '(empty)'}`,
    `asset.lockWorkflow: ${asStr(asset.lockWorkflow).trim() || '(empty)'}`,
    `asset.anchorPrompt: ${asStr(asset.anchorPrompt).trim() || '(empty)'}`,
    `asset.negativePrompt: ${asStr(asset.negativePrompt).trim() || '(empty)'}`,
    `asset.referencePromptHint: ${asStr(asset.referencePromptHint).trim() || '(empty)'}`,
    `asset.aliases: ${uniq(asList(asset.aliases)).join(', ') || '(empty)'}`,
    `asset.forbiddenSubstitutes: ${uniq(asList(asset.forbiddenSubstitutes)).join(', ') || '(empty)'}`,
    `asset.sceneIds: ${uniq(asList(asset.sceneIds)).join(', ') || '(empty)'}`,
    `plan.worldAnchor: ${asStr(plan.worldAnchor).trim() || '(empty)'}`,
    `plan.eventChain: ${uniq(asList(plan.eventChain), 20).join(' | ') || '(empty)'}`,
    `assetUsageContext.roleLineZh: ${asStr(usageContext.roleLineZh).trim() || '(empty)'}`,
    `assetUsageContext.plotCueLineZh: ${asStr(usageContext.plotCueLineZh).trim() || '(empty)'}`,
    `assetUsageContext.structureLineZh: ${asStr(usageContext.structureLineZh).trim() || '(empty)'}`,
    `assetUsageContext.sceneLineZh: ${asStr(usageContext.sceneLineZh).trim() || '(empty)'}`,
    `assetUsageContext.coAssetLineZh: ${asStr(usageContext.coAssetLineZh).trim() || '(empty)'}`,
    `assetUsageContext.sceneNames: ${uniq(asList(usageContext.sceneNames)).join(' | ') || '(empty)'}`,
    `assetUsageContext.sceneSummaries: ${uniq(asList(usageContext.sceneSummaries), 10).join(' | ') || '(empty)'}`,
    `assetUsageContext.eventMentions: ${uniq(asList(usageContext.eventMentions), 10).join(' | ') || '(empty)'}`,
    `assetUsageContext.coAssetNames: ${uniq(asList(usageContext.coAssetNames), 12).join(', ') || '(empty)'}`,
    `assetUsageContext.roleHints: ${uniq(asList(usageContext.roleHints), 12).join(' | ') || '(empty)'}`,
    `assetUsageContext.plotCueHints: ${uniq(asList(usageContext.plotCueHints), 12).join(' | ') || '(empty)'}`,
    `assetUsageContext.structureHints: ${uniq(asList(usageContext.structureHints), 12).join(' | ') || '(empty)'}`,
    `promptReviewFeedbackZh: ${asStr(input?.promptReviewFeedbackZh).trim() || '(empty)'}`,
    `globalPromptZh: ${asStr(input?.globalPromptZh).trim() || '(empty)'}`,
    `globalNegativePromptZh: ${asStr(input?.globalNegativePromptZh).trim() || '(empty)'}`,
    `currentPromptZh: ${asStr(input?.currentPromptZh).trim() || '(empty)'}`,
    `currentPromptEn: ${asStr(input?.currentPromptEn).trim() || '(empty)'}`,
    `currentNegativePromptZh: ${asStr(input?.currentNegativePromptZh).trim() || '(empty)'}`,
    `currentNegativePrompt: ${asStr(input?.currentNegativePrompt).trim() || '(empty)'}`
  ]
  if (storyBibleJson) lines.push(`storyBibleJson: ${storyBibleJson}`)
  return lines.join('\n')
}

async function enhanceViaOpenAICompatible({ input, provider, model, apiUrl, proxyUrl }) {
  const body = {
    text: {
      format: {
        type: 'json_schema',
        name: 'story_asset_prompt_enhance',
        strict: true,
        schema: promptEnhanceSchema()
      }
    },
    instructions: buildInstructions(input),
    input: buildInput(input),
    ...(model ? { model: asStr(model).trim() } : {})
  }
  const { json, meta } = await openaiResponsesJsonForTools({ body, provider, apiUrl, proxyUrl, timeoutMs: 60_000, model })
  const parsed = JSON.parse(extractResponseOutputText(json) || '{}')
  if (!validatePromptEnhanceResult(parsed)) throw new Error('invalid_story_asset_prompt_enhance_output')
  return { result: parsed, meta }
}

async function enhanceViaOllama({ input, model, apiUrl, proxyUrl }) {
  const { parsed, meta } = await generateStrictJsonViaOllamaChat({
    instructions:
      buildInstructions(input) +
      '输出 JSON：{"promptZh":"","negativePromptZh":"","summary":""}',
    input: buildInput(input),
    model,
    apiUrl,
    proxyUrl,
    timeoutMs: 60_000,
    maxRetries: 2,
    validate: validatePromptEnhanceResult
  })
  return { result: parsed, meta }
}

async function enhanceViaDoubao({ input, model, apiUrl, proxyUrl }) {
  const { parsed, meta } = await generateStrictJsonViaDoubaoChat({
    instructions:
      buildInstructions(input) +
      '输出 JSON：{"promptZh":"","negativePromptZh":"","summary":""}',
    input: buildInput(input),
    model,
    apiUrl,
    proxyUrl,
    timeoutMs: 60_000,
    maxRetries: 2,
    validate: validatePromptEnhanceResult
  })
  return { result: parsed, meta }
}

export async function enhanceStoryAssetPromptWithAi({ input, provider, model, apiUrl, proxyUrl }) {
  const p = asStr(provider).trim().toLowerCase()
  if (p === 'openai' || p === 'localoxml') return enhanceViaOpenAICompatible({ input, provider: p, model, apiUrl, proxyUrl })
  if (p === 'ollama') return enhanceViaOllama({ input, model, apiUrl, proxyUrl })
  if (p === 'doubao') return enhanceViaDoubao({ input, model, apiUrl, proxyUrl })
  return null
}
