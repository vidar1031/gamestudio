import crypto from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { extractResponseOutputText, openaiResponsesJsonForTools } from './openai.js'
import { generateStrictJsonViaOllamaChat } from './ollama.js'
import { generateStrictJsonViaDoubaoChat } from './doubao.js'

function nowIso() {
  try { return new Date().toISOString() } catch (_) { return String(Date.now()) }
}

function clampInt(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.floor(v)))
}

function normalizeFormula(input) {
  const choicePoints = clampInt(input?.choicePoints, 1, 3, 2)
  const optionsPerChoice = Number(input?.optionsPerChoice) === 3 ? 3 : 2
  const endings = optionsPerChoice
  return { choicePoints, optionsPerChoice, endings }
}

function promptTemplateSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      prompt: { type: 'string', minLength: 40, maxLength: 5000 },
      title: { type: ['string', 'null'] },
      notes: { type: 'array', maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 160 } }
    },
    required: ['prompt', 'title', 'notes']
  }
}

function validateGeneratedTemplate(obj) {
  if (!obj || typeof obj !== 'object') return false
  if (!String(obj.prompt || '').trim()) return false
  if (!Array.isArray(obj.notes)) return false
  return true
}

function inferDefaults(title) {
  const t = String(title || '').trim()
  if (/小猫.*钓鱼|钓鱼.*小猫/.test(t)) {
    return {
      moral: '做事要专心，坚持和耐心比贪玩更容易带来收获',
      world: '春天清晨，公园湖边，柳树、草地、浅水岸边，阳光明亮，水面平静',
      protagonist: '一只小猫，戴小草帽，背小鱼桶，拿竹鱼竿，活泼好奇',
      style: '绘本',
      tone: '轻松幽默，悬念递进'
    }
  }
  return {
    moral: '请围绕主题给出贴题、具体、可落地的寓意',
    world: '请给出与主题直接相关的时间、地点、天气和环境元素',
    protagonist: '请给出与主题主体一致的主角设定，包含外观、道具与性格',
    style: '绘本',
    tone: '温暖积极，轻松自然'
  }
}

function localFallbackTemplate({ title, templateName, templateSummary, fields, formula }) {
  const f = normalizeFormula(formula)
  const d = inferDefaults(title)
  const world = String(fields?.world || '').trim() || d.world
  const protagonist = String(fields?.protagonist || '').trim() || d.protagonist
  const style = String(fields?.style || '').trim() || d.style
  const tone = String(fields?.tone || '').trim() || d.tone
  const moral = String(fields?.moral || '').trim() || d.moral
  const constraints = String(fields?.constraints || '').trim() || '避免暴力血腥，适合儿童阅读'
  const extra = String(fields?.extra || '').trim() || '无'
  const formulaRule =
    f.choicePoints === 1
      ? '结构策略：这是单选择点测试版，只验证第 1 个选择点是否自然成立、两条后果是否稳定，不要再引入第二轮升级冲突。'
      : f.choicePoints === 2
        ? '结构策略：第 1 个选择点测试主角行为倾向，第 2 个选择点必须承接前一结果升级，但不能脱离当前路径状态。'
        : '结构策略：第 1 个选择点先测试故事方向，第 2 个选择点升级风险，第 3 个选择点进入最终抉择；三次决策维度不得重复。'
  const prompt = [
    `模板：${String(templateName || '寓言标准版').trim()}（${String(templateSummary || '适合“寓意清晰 + 互动选择”').trim()}）`,
    `故事主题：${String(title || '').trim() || '请填写故事主题'}`,
    `核心寓意：${moral}`,
    `世界观锚点：${world}`,
    `主角设定：${protagonist}`,
    `视觉风格：${style.split(/[，,、]/).map((x) => x.trim()).filter(Boolean)[0] || '绘本'}`,
    `叙事语气：${tone}`,
    `限制条件：${constraints}`,
    `互动结构：选择点 ${f.choicePoints}，每点 ${f.optionsPerChoice} 选，结局 ${f.endings}`,
    `模板目标：根据故事名称自动补全贴题设定，不允许沿用与主题无关的旧字段。`,
    `尺度约束：若题材属于日常童话/生活场景，禁止突然出现神迹奖励、夸张奇观、突兀宝物或越级冲突。`,
    formulaRule,
    `分镜要求：每卡 1-3 句，必须包含可演出动作/环境变化；选择必须有真实后果，不要伪选择`,
    `可视化约束：禁止只写“面临选择/关键节点/后果总结”，必须写可见画面（角色动作、景别、道具、光线）`,
    `生图友好：每个场景可提炼出“主体+动作+场景+光线+镜头+情绪”，并保持角色外观前后一致`,
    `一致性锚点：主角外观（服装/发型/年龄感/关键道具）在所有场景不漂移`,
    `分支连续性约束：如果多个分支重新合流到同一场景，该场景只能描述所有分支都成立的共同事实；若某个状态只属于单一路径，就必须拆成不同承接卡，不能写进共享场景`,
    `结局约束：结局只能总结当前路径真实发生过的事件，不能引用其他分支的经历`,
    `结构顺序约束：当选择点=1时，必须按“铺垫场景 -> 1选择点 -> 1后果1 -> 结局1 -> 1后果2 -> 结局2”的可编译顺序写；若为3选则继续“1后果3 -> 结局3”。不要在 1后果k 和 结局k 之间另起普通场景名。`,
    `编译友好约束：像“钓到大鱼”“再次分心”这类过程，必须直接写进对应后果卡或结局卡的 text，不要拆成游离场景节点；不要夹杂英文单词或英文拟声词。`,
    `命名约束：选项使用“选项1..N”，后果卡使用“i后果k”，结局使用“结局1..结局N”`,
    `补充说明：${extra}`
  ].join('\n')
  return {
    prompt,
    title: String(title || '').trim() || null,
    notes: ['AI 生成失败，已使用本地保底模板。']
  }
}

function buildInstructions({ title, templateName, templateSummary, fields, formula }) {
  const f = normalizeFormula(formula)
  return (
    `你是“交互故事提示词模板生成助手”。\n` +
    `任务：根据“故事名称 + 结构公式 + 模板意图”，生成一份可以直接用于互动故事脚本生成的完整提示词模板。\n` +
    `输出要求：\n` +
    `- 只输出 JSON。\n` +
    `- prompt 字段必须是完整模板，使用固定的逐行结构：\n` +
    `  模板：...\n故事主题：...\n核心寓意：...\n世界观锚点：...\n主角设定：...\n视觉风格：...\n叙事语气：...\n限制条件：...\n互动结构：...\n模板目标：...\n尺度约束：...\n结构策略：...\n分镜要求：...\n可视化约束：...\n生图友好：...\n一致性锚点：...\n分支连续性约束：...\n结局约束：...\n命名约束：...\n补充说明：...\n` +
    `- 不是简单复述输入字段，而是要根据故事名称自动修正不贴题内容。\n` +
    `- 如果标题是动物或具体动作题材，必须让“主角设定、世界观锚点、核心寓意”与标题语义严格一致，不能沿用无关字段。\n` +
    `- 若题材属于日常或儿童童话尺度，禁止模板引导出夸张奇观、神迹奖励、突兀宝物、越级危险或成人化史诗冲突。\n` +
    `- 结构公式必须严格写入：选择点 ${f.choicePoints}，每点 ${f.optionsPerChoice} 选，结局 ${f.endings}。\n` +
    `- 当 choicePoints=1 时，结构策略必须明确：先只测试第一个选择点，不要把故事一次写成多轮升级冲突。\n` +
    `- 当 choicePoints=1 时，模板正文必须明确写出可编译顺序：铺垫场景 -> 1选择点 -> 1后果1 -> 结局1 -> 1后果2 -> 结局2（若为3选则继续 1后果3 -> 结局3）；不要在 1后果k 与 结局k 之间另起普通场景名。\n` +
    `- 当 choicePoints>1 时，结构策略必须说明每一轮选择的职责不同，且后续选择必须继承当前路径状态。\n` +
    `- 模板正文必须强调：额外过程（例如“钓到大鱼”“再次分心”）要写进对应后果卡或结局卡 text，不要拆成游离节点；全篇不要夹杂英文单词或英文拟声词。\n` +
    `- 分支连续性约束与结局约束必须写入模板正文。\n` +
    `- notes 返回 2~4 条，简要说明这份模板的设计重点。`
  )
}

async function generateViaOpenAICompatible({ title, templateName, templateSummary, fields, formula, provider, model, apiUrl, proxyUrl }) {
  const body = {
    text: {
      format: {
        type: 'json_schema',
        name: 'story_prompt_template',
        strict: true,
        schema: promptTemplateSchema()
      }
    },
    instructions: buildInstructions({ title, templateName, templateSummary, fields, formula }),
    input:
      `故事名称：${String(title || '').trim()}\n` +
      `模板名称：${String(templateName || '').trim()}\n` +
      `模板摘要：${String(templateSummary || '').trim()}\n` +
      `用户当前字段：${JSON.stringify(fields || {}, null, 2)}\n` +
      `结构公式：${JSON.stringify(normalizeFormula(formula))}\n`
  }
  const { json, meta } = await openaiResponsesJsonForTools({ body, provider, apiUrl, proxyUrl, model, timeoutMs: 60_000 })
  const parsed = JSON.parse(extractResponseOutputText(json) || '{}')
  if (!validateGeneratedTemplate(parsed)) throw new Error('invalid_prompt_template_output')
  return { result: parsed, meta }
}

async function generateViaOllama({ title, templateName, templateSummary, fields, formula, model, apiUrl, proxyUrl }) {
  const { parsed, meta } = await generateStrictJsonViaOllamaChat({
    instructions: buildInstructions({ title, templateName, templateSummary, fields, formula }) + `输出 JSON（必须严格符合 schema）：{"prompt":string,"title":string|null,"notes":[string]}`,
    input:
      `故事名称：${String(title || '').trim()}\n` +
      `模板名称：${String(templateName || '').trim()}\n` +
      `模板摘要：${String(templateSummary || '').trim()}\n` +
      `用户当前字段：${JSON.stringify(fields || {}, null, 2)}\n` +
      `结构公式：${JSON.stringify(normalizeFormula(formula))}\n`,
    model,
    apiUrl,
    proxyUrl,
    timeoutMs: 60_000,
    maxRetries: 2,
    validate: validateGeneratedTemplate
  })
  return { result: parsed, meta }
}

async function generateViaDoubao({ title, templateName, templateSummary, fields, formula, model, apiUrl, proxyUrl }) {
  const { parsed, meta } = await generateStrictJsonViaDoubaoChat({
    instructions: buildInstructions({ title, templateName, templateSummary, fields, formula }) + `输出 JSON（必须严格符合 schema）：{"prompt":string,"title":string|null,"notes":[string]}`,
    input:
      `故事名称：${String(title || '').trim()}\n` +
      `模板名称：${String(templateName || '').trim()}\n` +
      `模板摘要：${String(templateSummary || '').trim()}\n` +
      `用户当前字段：${JSON.stringify(fields || {}, null, 2)}\n` +
      `结构公式：${JSON.stringify(normalizeFormula(formula))}\n`,
    model,
    apiUrl,
    proxyUrl,
    timeoutMs: 60_000,
    maxRetries: 2,
    validate: validateGeneratedTemplate
  })
  return { result: parsed, meta }
}

export async function generateStoryPromptTemplate(input) {
  const provider = String(input?.provider || '').trim().toLowerCase()
  try {
    if (provider === 'openai' || provider === 'localoxml') {
      return await generateViaOpenAICompatible(input)
    }
    if (provider === 'ollama') return await generateViaOllama(input)
    if (provider === 'doubao') return await generateViaDoubao(input)
    throw new Error('unsupported_provider')
  } catch (e) {
    return {
      result: localFallbackTemplate(input),
      meta: { provider: 'local', api: null, model: null, durationMs: 0, note: e instanceof Error ? e.message : String(e) }
    }
  }
}

export function promptTemplatesFilePath(storageRoot) {
  const root = String(storageRoot || '').trim()
  if (!root) throw new Error('missing_storage_root')
  return path.join(root, '_config', 'prompt_templates.json')
}

export async function listPromptTemplates(storageRoot) {
  const p = promptTemplatesFilePath(storageRoot)
  try {
    const raw = await readFile(p, 'utf-8')
    const json = JSON.parse(raw)
    const items = Array.isArray(json?.items) ? json.items : []
    return items
      .filter((item) => item && typeof item === 'object' && String(item.prompt || '').trim())
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  } catch (_) {
    return []
  }
}

export async function savePromptTemplate(storageRoot, item) {
  const p = promptTemplatesFilePath(storageRoot)
  await mkdir(path.dirname(p), { recursive: true })
  const curr = await listPromptTemplates(storageRoot)
  const nextItem = {
    id: (crypto.randomUUID ? crypto.randomUUID() : `pt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    createdAt: nowIso(),
    ...(item && typeof item === 'object' ? item : {})
  }
  const next = {
    schemaVersion: '1.0',
    updatedAt: nowIso(),
    items: [nextItem, ...curr].slice(0, 200)
  }
  await writeFile(p, JSON.stringify(next, null, 2), 'utf-8')
  return nextItem
}

export async function deletePromptTemplate(storageRoot, id) {
  const p = promptTemplatesFilePath(storageRoot)
  const curr = await listPromptTemplates(storageRoot)
  const nextItems = curr.filter((item) => String(item?.id || '') !== String(id || '').trim())
  const removed = nextItems.length !== curr.length
  const next = {
    schemaVersion: '1.0',
    updatedAt: nowIso(),
    items: nextItems
  }
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(next, null, 2), 'utf-8')
  return { removed, items: nextItems }
}
