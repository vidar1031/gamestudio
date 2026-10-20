import { extractResponseOutputText, openaiResponsesJsonForTools, parseModelJsonLenient } from './openai.js'
import { generateStrictJsonViaDoubaoChat } from './doubao.js'
import { generateStrictJsonViaOllamaChat } from './ollama.js'
import { buildEntityIdResolver } from './storyAssets.js'

// ============ 剧情状态机·统一状态表提取（2026-10-16） ============
// 背景：道具状态提取（storyPropStates.js）与角色姿势提取（storyPoseStates.js）各管一摊，
// 摆位只道具侧消费 stateRequirements，角色侧不读；也没有"按状态表缺口自动补齐变体"的入口。
// 本模块把提取统一成一张「每场景 × 每资产」的剧情状态表：
//   输入 scripts.json 全文（缺省回退 story 节点正文）+ plan 资产清单（出场场景矩阵），
//   LLM 产出 {sceneId, assetId, stateKey, stateLabel, evidence} 候选（只报非默认状态），
//   确定性后处理把未提及的 场景×资产 标 unchanged；
//   写回 plan.assets[].stateRequirements（合并不覆盖未提及场景）+ 落 story-assets/states.json。
// 模型输出只是候选：状态键/场景/资产一律按输入清单校验归一，编造条目直接丢弃。

function asStr(v) { return String(v == null ? '' : v).trim() }
function asList(v) { return Array.isArray(v) ? v : [] }
function clampText(v, max) { return asStr(v).slice(0, max) }

export const STORY_STATE_UNCHANGED = 'unchanged'

function sanitizeStateKey(v) {
  return asStr(v).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
}

function storyStatesSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      scenes: {
        type: 'array',
        maxItems: 60,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sceneId: { type: 'string', minLength: 1, maxLength: 120 },
            states: {
              type: 'array',
              maxItems: 24,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  assetId: { type: 'string', minLength: 1, maxLength: 120 },
                  stateKey: { type: 'string', minLength: 1, maxLength: 48 },
                  stateLabel: { type: 'string', maxLength: 24 },
                  evidence: { type: 'string', maxLength: 120 },
                  relatedAssetIds: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 120 } }
                },
                required: ['assetId', 'stateKey', 'stateLabel', 'evidence']
              }
            }
          },
          required: ['sceneId', 'states']
        }
      }
    },
    required: ['scenes']
  }
}

function buildStoryStatesInstructions() {
  return (
    '你是儿童绘本互动故事的「剧情状态分析员」。\n' +
    '任务：输入给出故事的若干场景（标题+脚本原文）、故事中登场的资产清单（角色与道具，含各资产出场的场景）。' +
    '对每一个场景，判断每个出场资产在该场景中的「视觉状态」——只输出与资产默认形态（主参考图）不同的状态；' +
    '与默认形态一致或未发生可见变化的资产不要输出（系统会自动标记 unchanged）。\n' +
    '判定标准：\n' +
    '- 状态必须是"视觉可画"的：道具的 空→满/破损/开合/水位；角色的 持物（手里拿什么）/端盘/鼓掌/姿态与表情的剧情性变化。\n' +
    '- 仅位置/朝向变化不算状态（位置由摆位层处理）。\n' +
    '- 同一资产在同一场景只输出一条状态；状态延续到后续场景时，在后续场景也要输出同一 stateKey。\n' +
    '输出要求：\n' +
    '- 只输出一个可 JSON.parse 的 JSON 对象，不要 markdown、不要代码块、不要分析过程。\n' +
    '- 结构：{"scenes":[{"sceneId":"…","states":[{"assetId":"…","stateKey":"…","stateLabel":"…","evidence":"…","relatedAssetIds":["…"]}]}]}\n' +
    '- sceneId、assetId 必须原样照抄输入值；assetId 必须在该场景的出场资产清单内，禁止编造输入没有的资产或场景。\n' +
    '- stateKey：英文小写蛇形短词（≤4词），如 empty_plate / plate_with_pears / holding_big_pear / holding_small_pear / clapping_empty_hands；同一资产内唯一。\n' +
    '- stateLabel：中文短标签（≤8字），如 空盘 / 满盘梨 / 持大梨 / 空手鼓掌。\n' +
    '- evidence：判断依据——从该场景的脚本原文里照抄支撑的那一句（≤40字），禁止自己改写；没有原文依据的判断不允许输出。\n' +
    '- relatedAssetIds：状态涉及的其他资产（如"持大梨"涉及大梨道具、"端盘"涉及盘与梨），原样照抄输入资产 id；不涉及给空数组。\n' +
    '- 只输出有非默认状态的场景条目；某场景全部资产都无变化时，该场景 states 给空数组。'
  )
}

// 从 story + scripts + plan 构建提取输入：
// 场景矩阵以 story.nodes（scene/ending）为准，脚本原文按 scripts.json 卡片 id 对位
// （node.id = 'bn_' + card.id，名称为兜底）；资产清单与其出场场景取自 plan.assets[].sceneIds。
export function buildStoryStateExtractionInput({ project, story, scripts, plan }) {
  const nodes = asList(story && story.nodes)
    .filter((node) => {
      const kind = asStr(node && node.kind)
      return kind === 'scene' || kind === 'ending'
    })
  const cards = asList(scripts && scripts.cards)
  const cardById = new Map()
  const cardByName = new Map()
  for (const card of cards) {
    const cid = asStr(card && card.id)
    if (cid) {
      cardById.set(cid, card)
      cardById.set(`bn_${cid}`, card)
    }
    const nm = asStr(card && card.name)
    if (nm && !cardByName.has(nm)) cardByName.set(nm, card)
  }
  const assets = asList(plan && plan.assets)
    .map((a) => ({
      assetId: asStr(a && a.id),
      name: asStr(a && a.name),
      category: asStr(a && a.category) || 'prop',
      anchorPrompt: clampText(a && a.anchorPrompt, 200),
      sceneIds: asList(a && a.sceneIds).map((s) => asStr(s)).filter(Boolean)
    }))
    .filter((a) => a.assetId && a.name && (a.category === 'character' || a.category === 'prop'))
  const scenes = nodes.map((node, index) => {
    const sceneId = asStr(node && node.id) || `scene_${index + 1}`
    const sceneName = asStr(node && node.body && node.body.title) || asStr(node && node.name) || sceneId
    const card = cardById.get(sceneId) || cardByName.get(sceneName) || null
    const scriptText = clampText(card && card.text, 800)
    const summary = clampText(`${asStr(node && node.body && node.body.title) || asStr(node && node.name)}：${asStr(node && node.body && node.body.text)}`, 600)
    const assetIds = assets.filter((a) => a.sceneIds.includes(sceneId)).map((a) => a.assetId)
    return { sceneId, sceneName, summary, scriptText, assetIds }
  })
  return {
    storyTitle: asStr(project && project.title),
    assets,
    scenes: scenes.filter((s) => s.assetIds.length > 0),
    allScenes: scenes.map((s) => ({ sceneId: s.sceneId, sceneName: s.sceneName }))
  }
}

// 归一化模型输出：id 解析（id/名称/别名）、stateKey 消毒、场景×资产矩阵校验
// （场景必须合法、资产必须在该场景出场、同场景同资产只留第一条）、relatedAssetIds 限出场资产。
export function normalizeStoryStates(parsed, { assetIds, validSceneIds, assetSceneIds, resolveAssetId }) {
  const scenes = []
  for (const rawScene of asList(parsed && parsed.scenes)) {
    const sceneId = asStr(rawScene && rawScene.sceneId)
    if (!sceneId || !validSceneIds.has(sceneId)) continue
    const states = []
    const claimedAssets = new Set()
    for (const rawState of asList(rawScene && rawScene.states)) {
      const assetId = resolveAssetId(rawState && rawState.assetId)
      if (!assetId || !assetIds.has(assetId)) continue
      const allowedScenes = assetSceneIds.get(assetId) || new Set()
      if (!allowedScenes.has(sceneId)) continue
      if (claimedAssets.has(assetId)) continue
      const stateKey = sanitizeStateKey(rawState && rawState.stateKey)
      if (!stateKey || stateKey === STORY_STATE_UNCHANGED) continue
      const relatedAssetIds = []
      for (const rawRel of asList(rawState && rawState.relatedAssetIds)) {
        const relId = resolveAssetId(rawRel)
        if (relId && assetIds.has(relId) && relId !== assetId && allowedScenes.has(sceneId) && !relatedAssetIds.includes(relId)) {
          relatedAssetIds.push(relId)
        }
        if (relatedAssetIds.length >= 3) break
      }
      claimedAssets.add(assetId)
      states.push({
        assetId,
        stateKey,
        stateLabel: clampText(rawState && rawState.stateLabel, 24),
        evidence: clampText(rawState && rawState.evidence, 120),
        relatedAssetIds
      })
      if (states.length >= 24) break
    }
    scenes.push({ sceneId, states })
    if (scenes.length >= 60) break
  }
  return { scenes }
}

function validateStoryStates(normalized) {
  // 全部场景全无变化也是合法结果（如实返回，不虚构状态）；但必须有 scenes 数组结构
  return Boolean(normalized && Array.isArray(normalized.scenes))
}

// 确定性补全：提取输入矩阵（场景 × 出场资产）中模型未提及的一律标 unchanged，
// 产出完整状态表文档（落 story-assets/states.json）。
export function buildStatesDoc({ input, normalized, generatedAt }) {
  const stateBySceneAsset = new Map()
  for (const scene of asList(normalized && normalized.scenes)) {
    for (const st of asList(scene && scene.states)) {
      stateBySceneAsset.set(`${asStr(scene.sceneId)}::${asStr(st.assetId)}`, st)
    }
  }
  const assetById = new Map(asList(input && input.assets).map((a) => [a.assetId, a]))
  const sceneNameById = new Map(asList(input && input.allScenes).map((s) => [s.sceneId, s.sceneName]))
  const scenes = []
  for (const scene of asList(input && input.scenes)) {
    const states = []
    for (const assetId of asList(scene.assetIds)) {
      const asset = assetById.get(assetId)
      const hit = stateBySceneAsset.get(`${scene.sceneId}::${assetId}`)
      if (hit) {
        states.push({
          assetId,
          assetName: asset ? asset.name : assetId,
          category: asset ? asset.category : '',
          stateKey: hit.stateKey,
          stateLabel: hit.stateLabel || hit.stateKey,
          evidence: hit.evidence || '',
          relatedAssetIds: asList(hit.relatedAssetIds)
        })
      } else {
        states.push({
          assetId,
          assetName: asset ? asset.name : assetId,
          category: asset ? asset.category : '',
          stateKey: STORY_STATE_UNCHANGED,
          stateLabel: '无变化',
          evidence: '',
          relatedAssetIds: []
        })
      }
    }
    scenes.push({ sceneId: scene.sceneId, sceneName: sceneNameById.get(scene.sceneId) || scene.sceneId, states })
  }
  return {
    schemaVersion: 1,
    generatedAt: asStr(generatedAt) || new Date().toISOString(),
    storyTitle: asStr(input && input.storyTitle),
    scenes
  }
}

// 写回 plan.assets[].stateRequirements：本轮提取覆盖到的场景以新判断为准（含 unchanged 即清除），
// 未提及场景的旧需求原样保留（合并不覆盖）。资产本轮无任何条目（未参与提取）时原样不动。
export function mergeStoryStatesIntoPlan(plan, doc) {
  const assets = asList(plan && plan.assets)
  if (!assets.length) return plan
  const entriesByAsset = new Map()
  for (const scene of asList(doc && doc.scenes)) {
    const sceneId = asStr(scene && scene.sceneId)
    if (!sceneId) continue
    for (const st of asList(scene && scene.states)) {
      const assetId = asStr(st && st.assetId)
      if (!assetId) continue
      if (!entriesByAsset.has(assetId)) entriesByAsset.set(assetId, { coveredSceneIds: new Set(), reqsByKey: new Map() })
      const entry = entriesByAsset.get(assetId)
      entry.coveredSceneIds.add(sceneId)
      const stateKey = sanitizeStateKey(st.stateKey)
      if (!stateKey || stateKey === STORY_STATE_UNCHANGED) continue
      if (!entry.reqsByKey.has(stateKey)) {
        entry.reqsByKey.set(stateKey, {
          stateKey,
          label: clampText(st.stateLabel, 24) || stateKey,
          sceneIds: [],
          ...(asStr(st.evidence) ? { evidence: clampText(st.evidence, 120) } : {}),
          ...(asList(st.relatedAssetIds).length ? { relatedAssetIds: asList(st.relatedAssetIds).map((x) => asStr(x)).filter(Boolean) } : {})
        })
      }
      const req = entry.reqsByKey.get(stateKey)
      if (!req.sceneIds.includes(sceneId)) req.sceneIds.push(sceneId)
    }
  }
  if (!entriesByAsset.size) return plan
  return {
    ...plan,
    assets: assets.map((asset) => {
      const assetId = asStr(asset && asset.id)
      const entry = entriesByAsset.get(assetId)
      if (!entry) return asset
      const kept = asList(asset && asset.stateRequirements)
        .map((r) => ({
          ...r,
          sceneIds: asList(r && r.sceneIds).map((s) => asStr(s)).filter((s) => s && !entry.coveredSceneIds.has(s))
        }))
        .filter((r) => r.sceneIds.length > 0)
      return { ...asset, stateRequirements: [...kept, ...entry.reqsByKey.values()] }
    })
  }
}

// 摆位消费（纯函数，供单测）：资产在当前场景的剧情状态变体解析。
// 返回 null = 本场景无状态需求（调用方回退主参考）；
// 返回 { stateKey, variant } —— variant 为 null 表示有需求但未生成变体（调用方同样回退主参考）。
// unchanged 需求显式返回 variant:null（回退主参考）。
export function resolveStateBoundVariant(asset, sceneId) {
  const sid = asStr(sceneId)
  if (!sid) return null
  const reqs = asList(asset && asset.stateRequirements)
  const hitReq = reqs.find((r) => asList(r && r.sceneIds).map((x) => asStr(x)).includes(sid)) || null
  if (!hitReq) return null
  const stateKey = asStr(hitReq.stateKey)
  if (!stateKey || stateKey === STORY_STATE_UNCHANGED) return { stateKey: stateKey || STORY_STATE_UNCHANGED, variant: null }
  const pool = [
    ...asList(asset && asset.poseVariants),
    ...asList(asset && asset.stateVariants)
  ]
  const variant = pool.find((v) => {
    const keys = [asStr(v && v.stateKey), asStr(v && v.poseKey)].filter(Boolean)
    if (!keys.includes(stateKey)) return false
    return Boolean(asStr(v && v.projectAssetId) || asStr(v && v.projectAssetUri))
  }) || null
  return { stateKey, variant }
}

// 变体补齐分类（纯函数，供单测）：
// 道具 → prop_state（state-variants/generate 链）；
// 角色持物/端盘（stateKey 含 holding/carrying/tray）→ carrier（载体变体链，技能件 carrier.holding_object/holding_tray）；
// 角色其他（姿态/表情）→ pose（姿势变体链，layered-produce 登记 poseKey=stateKey）。
export function classifyStateGapKind(asset, stateKey) {
  const category = asStr(asset && asset.category) || 'prop'
  if (category !== 'character') return 'prop_state'
  const key = sanitizeStateKey(stateKey)
  if (key.includes('holding') || key.includes('carrying') || key.includes('tray')) return 'carrier'
  return 'pose'
}

export function carrierSkillIdForStateKey(stateKey) {
  const key = sanitizeStateKey(stateKey)
  return key.includes('tray') ? 'carrier.holding_tray' : 'carrier.holding_object'
}

// 缺口扫描（纯函数，供单测）：有非 unchanged 状态需求但无对应变体（poseVariants/stateVariants
// 按 stateKey/poseKey 匹配且已登记项目资产）的 资产×状态 组合。幂等基础：已有变体的组合不进缺口。
export function findStateGaps(plan, { assetId: filterAssetId, stateKey: filterStateKey, sceneId: filterSceneId } = {}) {
  const gaps = []
  const wantAsset = asStr(filterAssetId)
  const wantKey = sanitizeStateKey(filterStateKey)
  const wantScene = asStr(filterSceneId)
  for (const asset of asList(plan && plan.assets)) {
    const assetId = asStr(asset && asset.id)
    if (!assetId || (wantAsset && assetId !== wantAsset)) continue
    const category = asStr(asset && asset.category) || 'prop'
    if (category !== 'character' && category !== 'prop') continue
    for (const req of asList(asset && asset.stateRequirements)) {
      const stateKey = sanitizeStateKey(req && req.stateKey)
      if (!stateKey || stateKey === STORY_STATE_UNCHANGED) continue
      if (wantKey && stateKey !== wantKey) continue
      const sceneIds = asList(req && req.sceneIds).map((s) => asStr(s)).filter(Boolean)
      if (!sceneIds.length) continue
      if (wantScene && !sceneIds.includes(wantScene)) continue
      const pool = [...asList(asset && asset.poseVariants), ...asList(asset && asset.stateVariants)]
      const hasVariant = pool.some((v) => {
        const keys = [asStr(v && v.stateKey), asStr(v && v.poseKey)].filter(Boolean)
        return keys.includes(stateKey) && Boolean(asStr(v && v.projectAssetId))
      })
      if (hasVariant) continue
      gaps.push({
        assetId,
        assetName: asStr(asset && asset.name) || assetId,
        category,
        stateKey,
        label: clampText(req && req.label, 24) || stateKey,
        description: clampText(req && (req.description || req.label), 120) || stateKey,
        evidence: clampText(req && req.evidence, 120),
        sceneIds,
        relatedAssetIds: asList(req && req.relatedAssetIds).map((x) => asStr(x)).filter(Boolean),
        kind: classifyStateGapKind(asset, stateKey)
      })
    }
  }
  return gaps
}

export async function extractStoryStates({ provider, model, apiUrl, proxyUrl, timeoutMs, input }) {
  const p = String(provider || '').trim().toLowerCase()
  const t = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 90_000
  const instructions = buildStoryStatesInstructions()
  const user = JSON.stringify({
    storyTitle: input.storyTitle,
    assets: input.assets.map((a) => ({ id: a.assetId, name: a.name, category: a.category, anchorPrompt: a.anchorPrompt })),
    scenes: input.scenes.map((s) => ({
      sceneId: s.sceneId,
      sceneName: s.sceneName,
      script: s.scriptText || s.summary,
      assetIds: s.assetIds
    }))
  }, null, 2)

  const assetIds = new Set(input.assets.map((a) => a.assetId))
  const validSceneIds = new Set(input.allScenes.map((s) => s.sceneId))
  const assetSceneIds = new Map()
  for (const a of input.assets) {
    assetSceneIds.set(a.assetId, new Set(a.sceneIds))
  }
  const resolveAssetId = buildEntityIdResolver(input.assets.map((a) => ({ id: a.assetId, name: a.name })))
  const normArgs = { assetIds, validSceneIds, assetSceneIds, resolveAssetId }

  if (p === 'openai' || p === 'localoxml') {
    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const body = {
        instructions: attempt === 0 ? instructions : `${instructions}\n再次强调：只输出一个可直接 JSON.parse 的 JSON 对象，不要输出任何其他内容。`,
        input: user,
        ...(model ? { model: String(model).trim() } : {}),
        // 输出体量随 场景数×资产数 增长；3072 与 prop-states 同款，仍在 KV 预留护栏内
        max_output_tokens: 3072,
        text: { format: { type: 'json_schema', name: 'story_states', strict: true, schema: storyStatesSchema() } }
      }
      try {
        const { json, meta } = await openaiResponsesJsonForTools({ body, provider: p, apiUrl, proxyUrl, timeoutMs: t })
        const parsed = parseModelJsonLenient(extractResponseOutputText(json))
        const normalized = normalizeStoryStates(parsed, normArgs)
        if (!validateStoryStates(normalized)) throw new Error('invalid_story_states')
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
      validate: (x) => validateStoryStates(normalizeStoryStates(x, normArgs)),
      proxyUrl
    })
    return { result: normalizeStoryStates(parsed, normArgs), meta }
  }

  if (p === 'ollama') {
    const { parsed, meta } = await generateStrictJsonViaOllamaChat({
      instructions,
      input: user,
      model: model || undefined,
      timeoutMs: t,
      maxRetries: 2,
      validate: (x) => validateStoryStates(normalizeStoryStates(x, normArgs)),
      proxyUrl
    })
    return { result: normalizeStoryStates(parsed, normArgs), meta }
  }

  throw new Error('unsupported_provider')
}
