import { extractResponseOutputText, openaiResponsesJsonForTools, parseModelJsonLenient } from './openai.js'
import { generateStrictJsonViaDoubaoChat } from './doubao.js'
import { generateStrictJsonViaOllamaChat } from './ollama.js'
import { buildEntityIdResolver, matchSceneRef, normalizeSceneRefs } from './storyAssets.js'

// ============ 剧情姿势状态提取（2026-09-10） ============
// 从"故事场景正文 × bible 角色出场表"提取每个场景中每个角色的姿势状态（姿势/朝向/动作/神态），
// 作为姿势变体生成的需求清单。模型输出只是候选：本模块只返回结构化候选，不写项目文件；
// 持久化由编辑器确认后经既有 plan 保存链完成。

function asStr(v) { return String(v == null ? '' : v).trim() }
function asList(v) { return Array.isArray(v) ? v : [] }
function clampText(v, max) { return asStr(v).slice(0, max) }

const VIEW_OPTIONS = ['正面', '侧面', '背面', '微侧', '俯视', '仰视', '全身']

function poseStatesSchema() {
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
            characterStates: {
              type: 'array',
              maxItems: 8,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  characterId: { type: 'string', minLength: 1, maxLength: 120 },
                  pose: { type: 'string', maxLength: 40 },
                  view: { type: 'string', maxLength: 12 },
                  action: { type: 'string', maxLength: 48 },
                  expression: { type: 'string', maxLength: 24 },
                  evidence: { type: 'string', maxLength: 120 }
                },
                required: ['characterId', 'pose', 'view', 'action', 'expression']
              }
            }
          },
          required: ['sceneId', 'characterStates']
        }
      }
    },
    required: ['scenes']
  }
}

function buildInstructions() {
  return (
    '你是儿童绘本互动故事的"剧情姿势提取员"。\n' +
    '任务：输入给出故事的若干场景（标题+剧情摘要）以及每个场景出场的角色清单。' +
    '为每个场景、每个出场角色提取一条"姿势状态"，供后续姿势变体立绘生成使用。\n' +
    '输出要求：\n' +
    '- 只输出一个可 JSON.parse 的 JSON 对象，不要 markdown、不要代码块、不要分析过程。\n' +
    '- 结构：{"scenes":[{"sceneId":"…","characterStates":[{"characterId":"…","pose":"…","view":"…","action":"…","expression":"…","evidence":"…"}]}]}\n' +
    '- sceneId、characterId 必须原样照抄输入值，禁止编造输入中没有的场景或角色。\n' +
    '- pose：身体姿态关键词（≤8字），如 站立/弯腰/蹲下/衔物/探头/飞行/俯身/抬头。\n' +
    `- view：镜头朝向，从 ${VIEW_OPTIONS.join('/')} 中选一个。\n` +
    '- view 镜头语言规则（2026-10-06 补充：视角是导演决策，依据该场景的动作性质选择，不要无理由重复正面）：\n' +
    '  · 行走/奔跑/离去/远去类动作：优先 背面 或 微侧（角色朝向画面深处，观众跟随其行进方向）。\n' +
    '  · 指向/远眺/观察/对话类动作：优先 侧面 或 微侧（展现视线方向与互动对象）。\n' +
    '  · 情绪特写/结局感叹/直视观众类：正面 或 微侧。\n' +
    '  · 同一角色连续场景的 view 禁止超过 2 镜连续重复正面；动作性质相同则保持视角一致。\n' +
    '- action：该场景中角色的可见动作短语（≤16字），必须与剧情摘要语义一致，禁止脱离剧情编造。\n' +
    '- expression：神态/情绪关键词（≤6字），如 急切/专注/开心/沮丧；无明确情绪时输出空字符串。\n' +
    '- evidence：该姿势判断的原文依据——从本场景剧情摘要里照抄支撑该姿势的那一句（≤40字），禁止自己改写。这是姿势变体生成的凭据，没有原文依据的判断不允许输出。\n' +
    '- 每个角色在每个场景恰好一条；某场景无出场角色时 characterStates 输出空数组。\n' +
    '- 同一角色的姿势设计要考虑跨场景连续性：同一连续动作链的场景保持姿势一致。'
  )
}

function normalizePoseStates(parsed, { scenes, resolveCharacterId }) {
  const sceneById = new Map(scenes.map((s) => [s.sceneId, s]))
  const sceneByLoose = new Map(scenes.map((s) => [s.sceneId.toLowerCase(), s]))
  const out = []
  for (const rawScene of asList(parsed && parsed.scenes)) {
    const sceneIdIn = asStr(rawScene && rawScene.sceneId)
    const scene = sceneById.get(sceneIdIn) || sceneByLoose.get(sceneIdIn.toLowerCase()) || null
    if (!scene) continue
    const allowed = new Set(scene.characterIds)
    const states = []
    for (const rawState of asList(rawScene && rawScene.characterStates)) {
      const characterId = resolveCharacterId(rawState && rawState.characterId)
      if (!characterId || !allowed.has(characterId)) continue
      if (states.some((x) => x.characterId === characterId)) continue
      states.push({
        characterId,
        pose: clampText(rawState && rawState.pose, 24),
        view: clampText(rawState && rawState.view, 8),
        action: clampText(rawState && rawState.action, 32),
        expression: clampText(rawState && rawState.expression, 12),
        evidence: clampText(rawState && rawState.evidence, 60)
      })
      if (states.length >= 8) break
    }
    out.push({ sceneId: scene.sceneId, sceneName: scene.sceneName, characterStates: states })
    if (out.length >= 60) break
  }
  return { scenes: out }
}

function validatePoseStates(normalized) {
  if (!normalized || !Array.isArray(normalized.scenes) || !normalized.scenes.length) return false
  return normalized.scenes.some((scene) => scene.characterStates.length > 0)
}

// 从故事文档+bible 构建提取输入：逐场景（scene/ending 节点）+ 出场角色（sceneRefs 匹配，与资产计划同一套匹配器）
export function buildPoseStateExtractionInput({ project, story, storyBible }) {
  const nodes = asList(story && story.nodes)
    .filter((node) => {
      const kind = asStr(node && node.kind)
      return kind === 'scene' || kind === 'ending'
    })
  const sceneRefsMap = normalizeSceneRefs(storyBible)
  const resolveCharacterId = buildEntityIdResolver(storyBible && storyBible.characters)
  const characters = asList(storyBible && storyBible.characters)
    .map((c) => ({ id: asStr(c && c.id), name: asStr(c && c.name) }))
    .filter((c) => c.id && c.name)
  const scenes = nodes.map((node, index) => {
    const matched = matchSceneRef(sceneRefsMap, node, index)
    const sceneId = asStr(node && node.id) || `scene_${index + 1}`
    const summary = clampText(`${asStr(node && node.body && node.body.title) || asStr(node && node.name)}：${asStr(node && node.body && node.body.text)}`, 600)
    const characterIds = []
    for (const raw of asList(matched && matched.value && matched.value.characters)) {
      const id = resolveCharacterId(raw)
      if (id && !characterIds.includes(id)) characterIds.push(id)
    }
    return { sceneId, sceneName: asStr(node && node.body && node.body.title) || asStr(node && node.name) || sceneId, summary, characterIds }
  }).filter((s) => s.characterIds.length > 0)
  return {
    storyTitle: asStr(project && project.title),
    characters,
    scenes
  }
}

export async function extractStoryPoseStates({ provider, model, apiUrl, proxyUrl, timeoutMs, input }) {
  const p = String(provider || '').trim().toLowerCase()
  const t = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 90_000
  const instructions = buildInstructions()
  const user = JSON.stringify({
    storyTitle: input.storyTitle,
    characters: input.characters,
    scenes: input.scenes.map((s) => ({ sceneId: s.sceneId, sceneName: s.sceneName, summary: s.summary, characterIds: s.characterIds }))
  }, null, 2)
  const resolveCharacterId = buildEntityIdResolver(input.characters)
  const normArgs = { scenes: input.scenes, resolveCharacterId }

  if (p === 'openai' || p === 'localoxml') {
    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const body = {
        instructions: attempt === 0 ? instructions : `${instructions}\n再次强调：只输出一个可直接 JSON.parse 的 JSON 对象，不要输出任何其他内容。`,
        input: user,
        ...(model ? { model: String(model).trim() } : {}),
        // 2026-10-13 丑小鸭实测：2048 装不下全故事姿势需求 JSON（9 资产×场景），截断即
        // Expected ',' or ']' after array element（position 5292）；与构图同型根因，提到 4096。
        max_output_tokens: 4096,
        text: { format: { type: 'json_schema', name: 'story_pose_states', strict: true, schema: poseStatesSchema() } }
      }
      try {
        const { json, meta } = await openaiResponsesJsonForTools({ body, provider: p, apiUrl, proxyUrl, timeoutMs: t })
        const parsed = parseModelJsonLenient(extractResponseOutputText(json))
        const normalized = normalizePoseStates(parsed, normArgs)
        if (!validatePoseStates(normalized)) throw new Error('invalid_pose_states')
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
      validate: (x) => validatePoseStates(normalizePoseStates(x, normArgs)),
      proxyUrl
    })
    return { result: normalizePoseStates(parsed, normArgs), meta }
  }

  if (p === 'ollama') {
    const { parsed, meta } = await generateStrictJsonViaOllamaChat({
      instructions,
      input: user,
      model: model || undefined,
      timeoutMs: t,
      maxRetries: 2,
      validate: (x) => validatePoseStates(normalizePoseStates(x, normArgs)),
      proxyUrl
    })
    return { result: normalizePoseStates(parsed, normArgs), meta }
  }

  throw new Error('unsupported_provider')
}
