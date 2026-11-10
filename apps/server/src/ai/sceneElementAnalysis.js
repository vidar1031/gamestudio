// 逐场景元素分析（蓝图 B2+，2026-10-21 用户裁决）：场景文本 → LLM 提取所需元素
// （背景 location / 角色 character / 道具 prop，只报真实存在的——没有主角就只出背景）
// → 确定性拟合既有资产（名称/别名归一 fuzzy 去重）→ 合入 plan.json（mergeAssetsById 纪律，幂等：
// 重复分析同场景更新而非重复添加）。
// LLM 调用走既有 provider 链（openai.js/ollama.js/doubao.js 内含租约 choke point），不绕路。
import { extractResponseOutputText, openaiResponsesJsonForTools, parseModelJsonLenient } from './openai.js'
import { generateStrictJsonViaDoubaoChat } from './doubao.js'
import { generateStrictJsonViaOllamaChat } from './ollama.js'

// 2026-11-06 背景元素（scenery）类目：地点内的局部环境元素（地形块/材料堆/植被装饰等，
// 非手持道具、非完整地点）——独立出图透明立绘，经构图锚占摆入背景层与角色层之间。
const ELEMENT_KINDS = ['location', 'character', 'prop', 'scenery']

function normKey(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, '')
}

function elementSchema() {
  return {
    type: 'object',
    properties: {
      elements: {
        type: 'array',
        maxItems: 12,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 40 },
            kind: { type: 'string', enum: ELEMENT_KINDS },
            aliases: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 6 },
            evidence: { type: 'string', maxLength: 120 },
            // 2026-11-10：英文视觉锚点——登记即写 plan 资产 anchorPrompt，场景出图才能把它烘进背景
            anchorEn: { type: 'string', maxLength: 200 }
          },
          required: ['name', 'kind'],
          additionalProperties: false
        }
      }
    },
    required: ['elements'],
    additionalProperties: false
  }
}

function buildInstructions() {
    return [
      '你是互动故事生产链的场景元素分析器。给定一幕（场景）的剧本文本，提取该幕真实出现/被提及的制作元素。',
      '规则：',
      '- kind 只能是 location（背景/地点，整幕环境）/ character（角色/人物/动物拟人）/ prop（道具/手持或可交互事物）/ scenery（背景元素）。',
      '- scenery=地点之内的局部环境元素：地形块（泥巴地/岩石区/草地）、材料堆（稻草堆/砖堆/木材堆）、植被与装饰（树桩/花丛/篱笆）。',
      '  判定边界：能拿在手里或与之交互的物件归 prop；整幕所处的地点环境归 location；地点里可指认的局部物件状/地块状环境点缀归 scenery。',
      '  例：「老大选了路边的稻草堆，老二选了泥巴地，老三走向岩石区」→ 稻草堆/泥巴地/岩石区 都是 scenery（不是 prop，也不是 location）。',
      '- 只报告文本中真实存在或明确提及的元素；没有主角/角色的场景就只出 location；不确定的一律不报。',
      '- name 用中文名词（原文用词）；aliases 可补常见英文/别称。',
      '- evidence 抄一句原文依据（不超过 40 字）。',
      '- anchorEn：该元素的英文视觉锚点（≤30 词，名词短语，描述材质/形态/颜色等可被图像模型识别的特征，如 "a huge golden-yellow dry straw pile, loose conical shape, rough fiber texture"）；用于场景出图提示词，禁止剧情叙述与角色名。',
      '- 只输出一个可直接 JSON.parse 的 JSON 对象：{"elements":[{name,kind,aliases,evidence,anchorEn}]}。'
    ].join('\n')
}

async function callElementLlm({ provider, model, apiUrl, proxyUrl, timeoutMs, user }) {
  const instructions = buildInstructions()
  const validate = (x) => Boolean(x && typeof x === 'object' && Array.isArray(x.elements))
  if (provider === 'openai' || provider === 'localoxml') {
    const body = {
      instructions,
      input: user,
      ...(model ? { model: String(model).trim() } : {}),
      // 输出有界（≤12 元素 ≈ 0.5K tokens），给思考型模型留余量（对齐 storyComposition 的 4096 裁决）
      max_output_tokens: 4096,
      text: { format: { type: 'json_schema', name: 'scene_elements', strict: true, schema: elementSchema() } }
    }
    const { json, meta } = await openaiResponsesJsonForTools({ body, provider, apiUrl, proxyUrl, timeoutMs })
    return { parsed: parseModelJsonLenient(extractResponseOutputText(json)), meta }
  }
  if (provider === 'doubao') {
    return generateStrictJsonViaDoubaoChat({ instructions, input: user, model, apiUrl, proxyUrl, timeoutMs, maxRetries: 1, validate })
  }
  if (provider === 'ollama') {
    return generateStrictJsonViaOllamaChat({ instructions, input: user, model, apiUrl, proxyUrl, timeoutMs, maxRetries: 1, validate })
  }
  throw new Error(`unsupported_prompt_provider:${provider || 'none'}`)
}

function normalizeElements(parsed) {
  const raw = Array.isArray(parsed?.elements) ? parsed.elements : []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    const name = String(item?.name || '').trim().slice(0, 40)
    const kind = String(item?.kind || '').trim().toLowerCase()
    if (!name || !ELEMENT_KINDS.includes(kind)) continue
    const key = normKey(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({
      name,
      kind,
      aliases: (Array.isArray(item?.aliases) ? item.aliases : []).map((x) => String(x || '').trim().slice(0, 40)).filter(Boolean).slice(0, 6),
      evidence: String(item?.evidence || '').trim().slice(0, 120),
      anchorEn: String(item?.anchorEn || '').trim().slice(0, 200)
    })
    if (out.length >= 12) break
  }
  return out
}

/** 确定性拟合：元素 → 既有资产（名称/别名归一 + 长度≥3 的子串互含 fuzzy 匹配），命中返回资产，未命中 null */
function matchExistingAsset(planAssets, element) {
  const key = normKey(element.name)
  const aliasKeys = new Set((element.aliases || []).map(normKey).filter((x) => x.length >= 3))
  for (const a of planAssets) {
    const nameKey = normKey(a?.name)
    if (nameKey && nameKey === key) return a
    const aliases = (Array.isArray(a?.aliases) ? a.aliases : []).map(normKey).filter(Boolean)
    if (aliases.some((x) => aliasKeys.has(x))) return a
    // fuzzy：别名与资产名子串互含（如元素别名 water jar ⊂ 资产 Large Ceramic Water Jar）
    if (nameKey && nameKey.length >= 3) {
      if (key && key.length >= 3 && (nameKey.includes(key) || key.includes(nameKey))) return a
      for (const ak of aliasKeys) {
        if (nameKey.includes(ak) || ak.includes(nameKey)) return a
      }
    }
    for (const ak of aliases) {
      if (ak.length >= 3 && key && key.length >= 3 && (ak.includes(key) || key.includes(ak))) return a
    }
  }
  return null
}

/**
 * 逐场景元素分析主入口。callLlm 可注入（单测用假响应；生产默认真实 provider 链）。
 * @returns {{ elements: Array, added: number, updated: number, plan: object, meta: any }}
 */
export async function analyzeSceneElements({ plan, sceneId, sceneName, sceneText, provider, model, apiUrl, proxyUrl, timeoutMs, callLlm }) {
  const user = JSON.stringify({ sceneName: String(sceneName || ''), sceneText: String(sceneText || '') }, null, 2)
  const runLlm = typeof callLlm === 'function' ? callLlm : callElementLlm
  const { parsed, meta } = await runLlm({ provider, model, apiUrl, proxyUrl, timeoutMs, user })
  const elements = normalizeElements(parsed)

  const planAssets = Array.isArray(plan?.assets) ? plan.assets : []
  const planScenes = Array.isArray(plan?.scenes) ? plan.scenes : []
  const nextAssets = planAssets.map((a) => ({ ...a }))
  const sceneAssetIds = new Set()

  let added = 0
  let updated = 0
  for (const el of elements) {
    const hit = matchExistingAsset(nextAssets, el)
    if (hit) {
      const sceneIds = new Set(Array.isArray(hit.sceneIds) ? hit.sceneIds.map((x) => String(x || '')).filter(Boolean) : [])
      if (!sceneIds.has(sceneId)) {
        sceneIds.add(sceneId)
        hit.sceneIds = [...sceneIds]
        hit.sceneCount = sceneIds.size
        updated += 1
      }
      // 别名补全（新别名合入既有资产）
      const aliasSet = new Set([...(Array.isArray(hit.aliases) ? hit.aliases : []), ...el.aliases].map((x) => String(x || '').trim()).filter(Boolean))
      hit.aliases = [...aliasSet].slice(0, 12)
      // 2026-11-10：既有资产缺锚点时回填（场景出图把元素烘进背景的必需字段；已有锚点不覆盖）
      if (!String(hit.anchorPrompt || '').trim() && el.anchorEn) {
        hit.anchorPrompt = el.anchorEn
        updated += 1
      }
      sceneAssetIds.add(String(hit.id))
    } else {
      const id = `el_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
      nextAssets.push({
        id,
        name: el.name,
        category: el.kind,
        aliases: el.aliases,
        sceneIds: [sceneId],
        sceneCount: 1,
        referenceStatus: 'missing',
        sceneEvidence: el.evidence ? [el.evidence] : [],
        // 2026-11-10：登记即带英文视觉锚点——此前元素无锚点，渲染规格无可烘文本（选址建房元素缺席根因）
        ...(el.anchorEn ? { anchorPrompt: el.anchorEn } : {})
      })
      sceneAssetIds.add(id)
      added += 1
    }
  }

  let sceneFound = false
  // 2026-10-25 批量分析加项：分析过即打 analyzedAt 戳（零元素场景也算已分析，避免批量重扣）
  const analyzedAt = new Date().toISOString()
  const nextScenes = planScenes.map((s) => {
    if (String(s?.sceneId || '') !== sceneId) return s
    sceneFound = true
    const ids = new Set([...(Array.isArray(s.assetIds) ? s.assetIds : []), ...sceneAssetIds].map((x) => String(x || '')).filter(Boolean))
    return { ...s, assetIds: [...ids], analyzedAt }
  })
  if (!sceneFound) {
    const maxIndex = planScenes.reduce((m, s) => Math.max(m, Number(s?.sceneIndex) || 0), 0)
    nextScenes.push({
      sceneId,
      sceneIndex: maxIndex + 1,
      sceneName: String(sceneName || '').trim() || sceneId,
      summary: String(sceneText || '').trim().slice(0, 120),
      sourceKey: sceneId,
      assetIds: [...sceneAssetIds],
      analyzedAt
    })
  }

  const nextPlan = { ...plan, assets: nextAssets, scenes: nextScenes, generatedAt: new Date().toISOString() }
  return { elements, added, updated, plan: nextPlan, meta: meta || null }
}
