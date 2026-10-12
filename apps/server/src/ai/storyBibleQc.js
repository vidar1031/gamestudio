// 2026-10-10 圣经质检步（GS-50）：sceneRefs 与剧情一致性校验+自动修正
// 背景：LLM 生成的 bible 顶层 sceneRefs 映射错绑是最高频生产事故（白雪公主 7/11 场景错绑、
// 小明的工作日2 结局错绑、龟兔赛跑漏绑）。此前全部靠人工读剧情修正——本模块把该环节自动化：
// 确定性规则检查 + 逐场景 LLM 对照复核（1 场 1 调用，防 8K 窗口膨胀）+ 修正留痕。
import { extractResponseOutputText, openaiResponsesJsonForTools, parseModelJsonLenient } from './openai.js'

const asStr = (v) => String(v == null ? '' : v)
const asList = (v) => (Array.isArray(v) ? v : [])

function buildInstructions() {
  return [
    '你是互动故事导演质检员。给你故事的一个场景正文、全部可用实体清单（角色/道具/地点，含 id 与中文名/别名）、以及当前绑定的实体 id 列表。',
    '任务：判断当前绑定是否与场景正文一致，输出修正后的绑定。规则：',
    '- 只保留场景中确实出场或被直接使用/看到的实体；角色"被提到但不在场"（如电话里发消息的人）不算出场。',
    '- 角色：以正文明确在场或正在行动的为准。',
    '- 道具：必须在本场景被看到/使用/携带。',
    '- 地点：恰好 1 个——场景发生的地点；若正文是过渡路途，选最接近的地点。',
    '- id 必须从实体清单中原样照抄，禁止编造不存在的 id。',
    '输出 JSON：{"sceneId":"原样照抄","characters":["id"],"props":["id"],"locations":["id"],"reason":"一句话修正理由，无修正则写 无修正"}'
  ].join('\n')
}

const qcSceneSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: ['sceneId', 'characters', 'props', 'locations', 'reason'],
  properties: {
    sceneId: { type: 'string' },
    characters: { type: 'array', items: { type: 'string' } },
    props: { type: 'array', items: { type: 'string' } },
    locations: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' }
  }
})

// 确定性规则检查（不调模型）：结构完整性 + 覆盖度 + 命中证据
export function qcSceneRefsDeterministic({ scenes, entities }) {
  const issues = []
  const charIds = new Set(asList(entities.characters).map((c) => c.id))
  const propIds = new Set(asList(entities.props).map((p) => p.id))
  const locIds = new Set(asList(entities.locations).map((l) => l.id))
  const charCoverage = new Map()
  for (const scene of scenes) {
    const sid = asStr(scene.sceneId)
    const bound = scene.bound || {}
    const chars = asList(bound.characters)
    const props = asList(bound.props)
    const locs = asList(bound.locations)
    for (const id of chars) if (!charIds.has(id)) issues.push({ sceneId: sid, level: 'error', code: 'unknown_character', detail: id })
    for (const id of props) if (!propIds.has(id)) issues.push({ sceneId: sid, level: 'error', code: 'unknown_prop', detail: id })
    for (const id of locs) if (!locIds.has(id)) issues.push({ sceneId: sid, level: 'error', code: 'unknown_location', detail: id })
    if (!locs.length) issues.push({ sceneId: sid, level: 'error', code: 'missing_location', detail: '场景无地点绑定，背景锚点将退回通用兜底' })
    if (!chars.length) issues.push({ sceneId: sid, level: 'warn', code: 'no_character', detail: '场景无角色绑定' })
    for (const id of chars) charCoverage.set(id, (charCoverage.get(id) || 0) + 1)
  }
  for (const c of asList(entities.characters)) {
    if (!charCoverage.get(c.id)) issues.push({ sceneId: '', level: 'warn', code: 'character_never_appears', detail: `${c.name}(${c.id}) 全故事零出场` })
  }
  // 2026-10-12 灰姑娘实证：QC 只修场景内错绑，漏掉"地点零使用"（舞会大厅 0 场景，全场绑厨房）——补地点覆盖检查
  const locCoverage = new Map()
  for (const scene of scenes) for (const id of asList(scene.bound && scene.bound.locations)) locCoverage.set(id, (locCoverage.get(id) || 0) + 1)
  for (const l of asList(entities.locations)) {
    if (!locCoverage.get(l.id)) issues.push({ sceneId: '', level: 'warn', code: 'location_never_used', detail: `${l.name}(${l.id}) 未被任何场景使用——若剧情有明显对应场景，绑定可能错位` })
  }
  return issues
}

// 逐场景 LLM 对照复核（串行，1 场 1 调用）
export async function qcStoryBibleSceneRefsWithAi({ provider, model, apiUrl, proxyUrl, timeoutMs, input, onProgress }) {
  const p = String(provider || '').trim().toLowerCase()
  if (p !== 'openai' && p !== 'localoxml') {
    const e = new Error(`bible_qc_unsupported_provider:${p || 'unknown'}`)
    e.code = 'unsupported_provider'
    throw e
  }
  const t = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 120_000
  const instructions = buildInstructions()
  const roster = {
    characters: asList(input.entities && input.entities.characters).map((c) => ({ id: c.id, name: c.name, aliases: asList(c.aliases) })),
    props: asList(input.entities && input.entities.props).map((c) => ({ id: c.id, name: c.name, aliases: asList(c.aliases) })),
    locations: asList(input.entities && input.entities.locations).map((c) => ({ id: c.id, name: c.name, aliases: asList(c.aliases) }))
  }
  const validIds = {
    characters: new Set(roster.characters.map((x) => x.id)),
    props: new Set(roster.props.map((x) => x.id)),
    locations: new Set(roster.locations.map((x) => x.id))
  }
  const results = []
  for (let i = 0; i < input.scenes.length; i += 1) {
    const scene = input.scenes[i]
    const sid = asStr(scene.sceneId)
    if (typeof onProgress === 'function') onProgress(i, input.scenes.length, sid)
    const user = JSON.stringify({
      storyTitle: input.storyTitle,
      scene: { sceneId: sid, sceneName: scene.sceneName, summary: scene.summary },
      roster,
      currentBinding: scene.bound || { characters: [], props: [], locations: [] }
    }, null, 2)
    let lastErr = null
    let fixed = null
    for (let attempt = 0; attempt < 2 && !fixed; attempt += 1) {
      try {
        const body = {
          instructions: attempt === 0 ? instructions : `${instructions}\n再次强调：只输出一个可直接 JSON.parse 的 JSON 对象，不要输出任何其他内容。`,
          input: user,
          ...(model ? { model: String(model).trim() } : {}),
          max_output_tokens: 1024,
          text: { format: { type: 'json_schema', name: 'story_bible_scene_qc', strict: true, schema: qcSceneSchema() } }
        }
        const { json } = await openaiResponsesJsonForTools({ body, provider: p, apiUrl, proxyUrl, timeoutMs: t })
        const parsed = parseModelJsonLenient(extractResponseOutputText(json))
        // 清洗：过滤清单外 id；地点恰好 1 个（多则取首个）；sceneId 原样
        const clean = (arr, valid) => asList(arr).map((x) => asStr(x).trim()).filter((x) => x && valid.has(x))
        const out = {
          sceneId: sid,
          characters: clean(parsed && parsed.characters, validIds.characters),
          props: clean(parsed && parsed.props, validIds.props),
          locations: clean(parsed && parsed.locations, validIds.locations).slice(0, 1),
          reason: asStr(parsed && parsed.reason).trim().slice(0, 200)
        }
        if (!out.locations.length) throw new Error('qc_empty_location')
        fixed = out
      } catch (e) {
        lastErr = e
      }
    }
    if (!fixed) {
      // LLM 两次失败：保留原绑定不阻塞（fail-open，原绑定已由确定性检查报告）
      const b = scene.bound || {}
      fixed = { sceneId: sid, characters: asList(b.characters), props: asList(b.props), locations: asList(b.locations), reason: `LLM 复核失败（${asStr(lastErr && lastErr.message || lastErr).slice(0, 80)}），保留原绑定`, qcFailed: true }
    }
    results.push(fixed)
  }
  return { scenes: results }
}
