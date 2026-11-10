// M 波（2026-10-27）：资产名 AI 补齐中文（story.assets.normalize_names）。
// LLM 只产 {id→中文名} 映射（候选）；确定性写回双修——圣经实体名（storyBible characters/props/locations[].name）
// 与 plan 资产名同改；id/aliases/sceneIds/构图引用一律不动。非中文输出项跳过并如实汇总。
import { extractResponseOutputText, openaiResponsesJsonForTools, parseModelJsonLenient } from './openai.js'

function asStr(v) { return String(v == null ? '' : v).trim() }
function hasCjk(v) { return /[\u3400-\u9fff]/.test(asStr(v)) }

function nameMapSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      names: {
        type: 'array',
        maxItems: 40,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 120 },
            nameZh: { type: 'string', minLength: 1, maxLength: 40 }
          },
          required: ['id', 'nameZh']
        }
      }
    },
    required: ['names']
  }
}

function buildInstructions() {
  return [
    '你是儿童绘本互动故事的「资产中文名」整理员。',
    '输入给出故事的资产清单（id/现名/别名/类别/锚点词）与故事标题、各场景摘要。',
    '任务：把现名非中文（如 Straw House / Stone Quarry）的资产整理出贴故事的中文名。',
    '规则：',
    '- nameZh 用故事里对该事物的惯用中文称呼（如 Straw House → 稻草屋）；不确定就用类别+特征的中文短名（如 石场）。',
    '- 已经是中文名的资产不要输出（跳过即跳过）。',
    '- id 必须原样照抄输入值，禁止编造输入中没有的 id。',
    '- 只输出一个可 JSON.parse 的 JSON 对象：{"names":[{"id":"…","nameZh":"…"}]}。'
  ].join('\n')
}

async function callNameLlm({ provider, model, apiUrl, proxyUrl, timeoutMs, user }) {
  const body = {
    instructions: buildInstructions(),
    input: user,
    ...(model ? { model: String(model).trim() } : {}),
    max_output_tokens: 2048,
    text: { format: { type: 'json_schema', name: 'asset_name_normalize', strict: true, schema: nameMapSchema() } }
  }
  const { json, meta } = await openaiResponsesJsonForTools({ body, provider, apiUrl, proxyUrl, timeoutMs })
  return { parsed: parseModelJsonLenient(extractResponseOutputText(json)), meta }
}

/** LLM 映射主入口。callLlm 可注入（单测/探针喂假映射不经模型）。返回 { mapping, skipped, meta } */
export async function normalizeAssetNames({ assets, storyTitle, sceneSummaries, provider, model, apiUrl, proxyUrl, timeoutMs, callLlm }) {
  const list = (Array.isArray(assets) ? assets : [])
    .map((a) => ({
      id: asStr(a?.id),
      name: asStr(a?.name),
      aliases: (Array.isArray(a?.aliases) ? a.aliases : []).map((x) => asStr(x)).filter(Boolean).slice(0, 8),
      category: asStr(a?.category),
      anchorPrompt: asStr(a?.anchorPrompt).slice(0, 160)
    }))
    .filter((a) => a.id && a.name)
  const needFix = list.filter((a) => !hasCjk(a.name))
  if (!needFix.length) return { mapping: {}, skipped: [], meta: { note: 'all_names_already_zh' } }
  const user = JSON.stringify({ storyTitle: asStr(storyTitle), assets: needFix, sceneSummaries: (Array.isArray(sceneSummaries) ? sceneSummaries : []).slice(0, 24) }, null, 2)
  const runLlm = typeof callLlm === 'function' ? callLlm : callNameLlm
  const { parsed, meta } = await runLlm({ provider, model, apiUrl, proxyUrl, timeoutMs, user })
  const mapping = {}
  const skipped = []
  const seenIds = new Set(needFix.map((a) => a.id))
  for (const item of Array.isArray(parsed?.names) ? parsed.names : []) {
    const id = asStr(item?.id)
    const nameZh = asStr(item?.nameZh).slice(0, 40)
    if (!id || !seenIds.has(id)) continue // 编造 id 拒收
    if (!nameZh || !hasCjk(nameZh)) {
      skipped.push(id) // 非中文输出跳过（如实汇总）
      continue
    }
    mapping[id] = nameZh
  }
  for (const a of needFix) if (!mapping[a.id] && !skipped.includes(a.id)) skipped.push(a.id)
  return { mapping, skipped, meta: meta || null }
}

/** 确定性双修写回（纯函数）：plan 资产名 + 圣经实体名同改；返回 { nextPlan, nextBible, changed, skipped } */
export function applyAssetNameMapping({ plan, bible, mapping }) {
  const map = mapping && typeof mapping === 'object' ? mapping : {}
  const ids = Object.keys(map).filter((k) => asStr(map[k]))
  const changed = []
  const nextPlan = plan && typeof plan === 'object'
    ? {
        ...plan,
        assets: (Array.isArray(plan.assets) ? plan.assets : []).map((a) => {
          const id = asStr(a?.id)
          if (!id || !map[id]) return a
          changed.push({ id, from: asStr(a?.name), to: map[id] })
          return { ...a, name: map[id] }
        })
      }
    : plan
  let nextBible = bible
  if (bible && typeof bible === 'object') {
    nextBible = { ...bible }
    for (const key of ['characters', 'props', 'locations']) {
      if (!Array.isArray(bible[key])) continue
      nextBible[key] = bible[key].map((e) => {
        const id = asStr(e?.id)
        if (!id || !map[id]) return e
        return { ...e, name: map[id] }
      })
    }
  }
  const skipped = ids.length ? [] : []
  return { nextPlan, nextBible, changed, skipped }
}
