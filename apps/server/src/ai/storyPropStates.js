import { extractResponseOutputText, openaiResponsesJsonForTools, parseModelJsonLenient } from './openai.js'
import { generateStrictJsonViaDoubaoChat } from './doubao.js'
import { generateStrictJsonViaOllamaChat } from './ollama.js'
import { buildEntityIdResolver, matchSceneRef, normalizeSceneRefs } from './storyAssets.js'

// ============ 道具状态需求提取（2026-09-16） ============
// 与 storyPoseStates.js（角色剧情姿势）同构：从"故事场景正文 × bible 道具表"识别
// 跨场景存在视觉状态变化的道具（水位/满空/破损/开合…），输出逐道具状态时间线，
// 并识别"终态进入/附着于其他道具"的合并关系（如石子沉进瓶内）。
// 模型输出只是候选：本模块只返回结构化候选，不写项目文件；持久化由编辑器确认后经既有 plan 保存链完成。

function asStr(v) { return String(v == null ? '' : v).trim() }
function asList(v) { return Array.isArray(v) ? v : [] }
function clampText(v, max) { return asStr(v).slice(0, max) }

function propStatesSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      props: {
        type: 'array',
        maxItems: 24,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            propId: { type: 'string', minLength: 1, maxLength: 120 },
            hasStateChanges: { type: 'boolean' },
            states: {
              type: 'array',
              maxItems: 8,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  stateKey: { type: 'string', minLength: 1, maxLength: 48 },
                  label: { type: 'string', maxLength: 24 },
                  description: { type: 'string', maxLength: 120 },
                  sceneIds: { type: 'array', maxItems: 60, items: { type: 'string', maxLength: 120 } },
                  evidence: { type: 'string', maxLength: 120 }
                },
                required: ['stateKey', 'label', 'description', 'sceneIds']
              }
            },
            // 2026-10-06 导演全量分析：每个参演事物在每个出场场景的"使用/呈现方式"，逐场景一条。
            // 与 states（驱动状态变体出图）不同，appearances 只作锁定审阅与提示词参考，不驱动变体生成。
            appearances: {
              type: 'array',
              maxItems: 60,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  sceneId: { type: 'string', minLength: 1, maxLength: 120 },
                  usage: { type: 'string', maxLength: 12 },
                  note: { type: 'string', maxLength: 60 },
                  evidence: { type: 'string', maxLength: 120 }
                },
                required: ['sceneId', 'usage']
              }
            },
            mergeInto: {
              type: ['object', 'null'],
              additionalProperties: false,
              properties: {
                containerPropId: { type: 'string', minLength: 1, maxLength: 120 },
                note: { type: 'string', maxLength: 80 }
              },
              required: ['containerPropId']
            }
          },
          required: ['propId', 'hasStateChanges', 'states', 'appearances', 'mergeInto']
        }
      }
    },
    required: ['props']
  }
}

function buildInstructions() {
  return (
    '你是儿童绘本互动故事的「参演事物导演分析员」。\n' +
    '任务：输入给出故事的若干场景（标题+剧情摘要）、每个场景出场的参演事物清单（道具与地点），以及事物的身份锚定词。' +
    '对每一个参演事物做两件事：① 判断剧情推进中是否存在"视觉状态变化"，输出状态时间线（供状态变体立绘生成）；' +
    '② 无论有无状态变化，都输出该事物在每个出场场景的"使用/呈现方式"（appearances，供锁定审阅与出图提示词参考）。\n' +
    '判定标准：\n' +
    '- 状态变化必须是"视觉可画"的：如 空→装满、水位上升、完整→破碎、关闭→打开、熄灭→点燃、崭新→磨损。\n' +
    '- 仅位置/朝向变化不算状态变化（位置由摆位层处理）；从未变化的事物 hasStateChanges=false 且 states=[]。\n' +
    '- 组合关系：若某道具在剧情终态进入/附着/装载于另一道具（如石子沉进瓶内、钥匙插进锁孔），' +
    '  标 mergeInto.containerPropId=容器道具id，note 简述；组合后的视觉由容器道具的状态变体呈现，被合并道具不再单独画。\n' +
    'appearances 规则：\n' +
    '- 道具 usage（≤6字）：使用方式——手持/穿着/放置/背负/散落/嵌入/悬挂 等。\n' +
    '- 地点 usage（≤6字）：呈现方式——全景/局部/远景/近景/俯视 等。\n' +
    '- note（≤24字）：该场景中该事物的视觉呈现要点（如"球拍被双手握持举在身前"）。\n' +
    '- 每个出场场景恰好一条 appearances；事物未出场的场景禁止输出。\n' +
    '输出要求：\n' +
    '- 只输出一个可 JSON.parse 的 JSON 对象，不要 markdown、不要代码块、不要分析过程。\n' +
    '- 结构：{"props":[{"propId":"…","hasStateChanges":true,"states":[{"stateKey":"…","label":"…","description":"…","sceneIds":["…"],"evidence":"…"}],"appearances":[{"sceneId":"…","usage":"…","note":"…","evidence":"…"}],"mergeInto":null}]}\n' +
    '- propId、sceneIds 必须原样照抄输入值，禁止编造输入中没有的事物或场景。\n' +
    '- stateKey：英文小写蛇形短词（≤4词），如 empty / low_water / rising_with_pebbles / full_to_brim；同一道具内唯一。\n' +
    '- label：中文短标签（≤8字），如 低水位 / 水位上升 / 满到瓶口。\n' +
    '- description：中文视觉描述（≤40字），写清"与基准状态相比多了什么/变了什么"，供生图提示词使用；禁止脱离剧情编造。\n' +
    '- sceneIds：该状态适用的场景（必须是该事物出场的场景）；每个场景至多归属一个状态。\n' +
    '- evidence：该判断的原文依据——从相关场景的剧情摘要里照抄支撑的那一句（≤40字），禁止自己改写。states 与 appearances 都受此约束：没有原文依据的判断不允许输出。\n' +
    '- 输入清单中的每个事物都要输出条目（无状态变化的：hasStateChanges=false, states=[], mergeInto=null，appearances 照常给）。'
  )
}

function normalizePropStates(parsed, { propIds, validSceneIds, propSceneIds, resolvePropId }) {
  const out = []
  for (const rawProp of asList(parsed && parsed.props)) {
    const propId = resolvePropId(rawProp && rawProp.propId)
    if (!propId || !propIds.has(propId)) continue
    const hasStateChanges = Boolean(rawProp && rawProp.hasStateChanges)
    const allowedScenes = propSceneIds.get(propId) || new Set()
    const states = []
    const seenKeys = new Set()
    const claimedScenes = new Set()
    for (const rawState of asList(rawProp && rawProp.states)) {
      const stateKey = clampText(rawState && rawState.stateKey, 48).toLowerCase().replace(/[^a-z0-9_]/g, '_')
      if (!stateKey || seenKeys.has(stateKey)) continue
      const sceneIds = asList(rawState && rawState.sceneIds)
        .map((s) => asStr(s))
        .filter((s) => s && validSceneIds.has(s) && allowedScenes.has(s) && !claimedScenes.has(s))
      if (!sceneIds.length) continue
      for (const s of sceneIds) claimedScenes.add(s)
      seenKeys.add(stateKey)
      states.push({
        stateKey,
        label: clampText(rawState && rawState.label, 24),
        description: clampText(rawState && rawState.description, 120),
        sceneIds
      })
      if (states.length >= 8) break
    }
    let mergeInto = null
    const rawMerge = rawProp && rawProp.mergeInto
    if (rawMerge && typeof rawMerge === 'object') {
      const containerPropId = resolvePropId(rawMerge.containerPropId)
      if (containerPropId && propIds.has(containerPropId) && containerPropId !== propId) {
        mergeInto = { containerPropId, note: clampText(rawMerge.note, 80) }
      }
    }
    // appearances：逐出场场景的使用/呈现方式（候选制，只保留该事物确实出场的场景）
    const appearances = []
    const seenAppearanceScenes = new Set()
    for (const rawApp of asList(rawProp && rawProp.appearances)) {
      const sceneId = asStr(rawApp && rawApp.sceneId)
      if (!sceneId || !validSceneIds.has(sceneId) || !allowedScenes.has(sceneId) || seenAppearanceScenes.has(sceneId)) continue
      const usage = clampText(rawApp && rawApp.usage, 12)
      if (!usage) continue
      seenAppearanceScenes.add(sceneId)
      appearances.push({
        sceneId,
        usage,
        note: clampText(rawApp && rawApp.note, 60),
        evidence: clampText(rawApp && rawApp.evidence, 120)
      })
    }
    out.push({ propId, hasStateChanges: hasStateChanges && states.length > 0, states, appearances, mergeInto })
    if (out.length >= 24) break
  }
  return { props: out }
}

function validatePropStates(normalized) {
  if (!normalized || !Array.isArray(normalized.props)) return false
  // 全部道具都判定无状态变化也是合法结果（如实返回，不虚构状态）
  return normalized.props.length > 0
}

// 从故事文档+bible 构建提取输入：逐场景（scene/ending 节点）+ 出场事物（sceneRefs 匹配，与资产计划同一套匹配器）
// 2026-10-06 导演全量分析：道具与地点都纳入（地点走 appearances 呈现方式，通常无状态变化）
export function buildPropStateExtractionInput({ project, story, storyBible }) {
  const nodes = asList(story && story.nodes)
    .filter((node) => {
      const kind = asStr(node && node.kind)
      return kind === 'scene' || kind === 'ending'
    })
  const sceneRefsMap = normalizeSceneRefs(storyBible)
  const resolvePropId = buildEntityIdResolver(storyBible && storyBible.props)
  const resolveLocationId = buildEntityIdResolver(storyBible && storyBible.locations)
  const props = asList(storyBible && storyBible.props)
    .map((p) => ({ id: asStr(p && p.id), name: asStr(p && p.name), kind: 'prop', anchorPrompt: clampText(p && p.anchorPrompt, 200) }))
    .filter((p) => p.id && p.name)
  const locations = asList(storyBible && storyBible.locations)
    .map((p) => ({ id: asStr(p && p.id), name: asStr(p && p.name), kind: 'location', anchorPrompt: clampText(p && p.anchorPrompt, 200) }))
    .filter((p) => p.id && p.name)
  const entities = [...props, ...locations]
  const scenes = nodes.map((node, index) => {
    const matched = matchSceneRef(sceneRefsMap, node, index)
    const sceneId = asStr(node && node.id) || `scene_${index + 1}`
    const summary = clampText(`${asStr(node && node.body && node.body.title) || asStr(node && node.name)}：${asStr(node && node.body && node.body.text)}`, 600)
    const propIds = []
    for (const raw of asList(matched && matched.value && matched.value.props)) {
      const id = resolvePropId(raw)
      if (id && !propIds.includes(id)) propIds.push(id)
    }
    for (const raw of asList(matched && matched.value && matched.value.locations)) {
      const id = resolveLocationId(raw)
      if (id && !propIds.includes(id)) propIds.push(id)
    }
    return { sceneId, sceneName: asStr(node && node.body && node.body.title) || asStr(node && node.name) || sceneId, summary, propIds }
  })
  return {
    storyTitle: asStr(project && project.title),
    props: entities,
    scenes: scenes.filter((s) => s.propIds.length > 0),
    allScenes: scenes.map((s) => ({ sceneId: s.sceneId, sceneName: s.sceneName }))
  }
}

export async function extractStoryPropStates({ provider, model, apiUrl, proxyUrl, timeoutMs, input }) {
  const p = String(provider || '').trim().toLowerCase()
  const t = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 90_000
  const instructions = buildInstructions()
  const user = JSON.stringify({
    storyTitle: input.storyTitle,
    props: input.props.map((x) => ({ id: x.id, name: x.name, kind: x.kind || 'prop', anchorPrompt: x.anchorPrompt })),
    scenes: input.scenes.map((s) => ({ sceneId: s.sceneId, sceneName: s.sceneName, summary: s.summary, propIds: s.propIds }))
  }, null, 2)

  const propIds = new Set(input.props.map((x) => x.id))
  const validSceneIds = new Set(input.allScenes.map((s) => s.sceneId))
  const propSceneIds = new Map()
  for (const s of input.scenes) {
    for (const pid of s.propIds) {
      if (!propSceneIds.has(pid)) propSceneIds.set(pid, new Set())
      propSceneIds.get(pid).add(s.sceneId)
    }
  }
  const resolvePropId = buildEntityIdResolver(input.props)
  const normArgs = { propIds, validSceneIds, propSceneIds, resolvePropId }

  if (p === 'openai' || p === 'localoxml') {
    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const body = {
        instructions: attempt === 0 ? instructions : `${instructions}\n再次强调：只输出一个可直接 JSON.parse 的 JSON 对象，不要输出任何其他内容。`,
        input: user,
        ...(model ? { model: String(model).trim() } : {}),
        // 2026-10-06 appearances 全量分析后输出体量随 事物数×场景数 增长，2048 对大故事会截断（截断即 JSON 解析失败）；
        // 3072 仍在 KV 预留护栏内，给足导演分析输出空间
        max_output_tokens: 3072,
        text: { format: { type: 'json_schema', name: 'story_prop_states', strict: true, schema: propStatesSchema() } }
      }
      try {
        const { json, meta } = await openaiResponsesJsonForTools({ body, provider: p, apiUrl, proxyUrl, timeoutMs: t })
        const parsed = parseModelJsonLenient(extractResponseOutputText(json))
        const normalized = normalizePropStates(parsed, normArgs)
        if (!validatePropStates(normalized)) throw new Error('invalid_prop_states')
        return { result: normalized, meta }
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr || new Error('invalid_json_response')
  }

  if (p === 'doubao') {
    const { parsed, meta } = await generateStrictJsonViaDoubaoChat({
      instructions,
      input: user,
      model: model || undefined,
      timeoutMs: t,
      maxRetries: 2,
      validate: (x) => validatePropStates(normalizePropStates(x, normArgs)),
      proxyUrl
    })
    return { result: normalizePropStates(parsed, normArgs), meta }
  }

  if (p === 'ollama') {
    const { parsed, meta } = await generateStrictJsonViaOllamaChat({
      instructions,
      input: user,
      model: model || undefined,
      timeoutMs: t,
      maxRetries: 2,
      validate: (x) => validatePropStates(normalizePropStates(x, normArgs)),
      proxyUrl
    })
    return { result: normalizePropStates(parsed, normArgs), meta }
  }

  throw new Error('unsupported_provider')
}
