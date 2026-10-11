import { extractResponseOutputText, openaiResponsesJsonForTools, parseModelJsonLenient } from './openai.js'
import { generateStrictJsonViaDoubaoChat } from './doubao.js'
import { generateStrictJsonViaOllamaChat } from './ollama.js'
import { buildEntityIdResolver } from './storyAssets.js'

// ============ 场景构图规格提取（2026-10-04） ============
// 从"场景正文 × 出场元素清单（含可用状态变体）"提取每个场景的构图规格：
// 每个元素的位置/大小/远近/前后遮挡/朝向/状态——摆位层的"需求单"，替代纯默认值兜底。
// 与姿势/道具提取同规则：模型输出只是候选，必须带原文依据（evidence），本模块不写盘；
// 持久化经 plan 保存链（scenes[].composition）。

function asStr(v) { return String(v == null ? '' : v).trim() }
function asList(v) { return Array.isArray(v) ? v : [] }
function clampNum(v, lo, hi, dflt) { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt }

const MAX_COMPOSITION_ITEMS = 24

function compositionSchema() {
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
            cameraNote: { type: 'string', maxLength: 80 },
            items: {
              type: 'array',
              maxItems: MAX_COMPOSITION_ITEMS,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  subjectId: { type: 'string', minLength: 1, maxLength: 120 },
                  kind: { type: 'string', enum: ['character', 'prop'] },
                  stateKey: { type: 'string', maxLength: 48 },
                  x: { type: 'number' },
                  y: { type: 'number' },
                  scale: { type: 'number' },
                  zIndex: { type: 'integer' },
                  flipH: { type: 'boolean' },
                  blocking: { type: 'string', maxLength: 60 },
                  evidence: { type: 'string', maxLength: 120 }
                },
                required: ['subjectId', 'kind', 'stateKey', 'x', 'y', 'scale', 'zIndex', 'flipH', 'blocking', 'evidence']
              }
            }
          },
          required: ['sceneId', 'cameraNote', 'items']
        }
      }
    },
    required: ['scenes']
  }
}

function buildInstructions() {
  return (
    '你是儿童绘本互动故事的"场景构图师"（导演）。\n' +
    '任务：输入给出故事的若干场景（标题+剧情摘要）以及每个场景出场元素清单（角色/道具，含各自可用的状态变体 stateKeys）。' +
    '为每个场景输出一份构图规格，指导立绘摆位：元素放哪里、多大、多远、谁挡谁、朝哪边、用什么状态。\n' +
    '【画布刻度（硬事实，不可偏离）】舞台竖屏 720x1280；立绘原图高约 1152px，scale=1.0 时该元素几乎顶满画幅高。\n' +
    'scale 刻度表（务必按此取值，不得超出）：远景 0.25-0.4；中景（主角默认、普通叙事镜头）0.4-0.6；近景高潮单人特写 0.7-0.85；' +
    '小道具按其与角色的真实比例（蚂蚁的豆子约 0.35-0.5；蝴蝶类小物件 0.15-0.25）。**单元素 scale 一律 ≤0.85；场景含 ≥3 个元素时最大 scale ≤0.7。**\n' +
    '【节拍规则（关键）】场景文本若含两个及以上节拍（玩耍→发现、平稳→突变），evidence 必须取**转折/高潮句**' +
    '（含"突然/却/却发现/这时/回头一看/紧接着"等转折标记的句子），stateKey 与构图必须服务该高潮节拍，不是首句。\n' +
    '坐标约定（归一化）：x∈[0,1] 横向（0=左缘，1=右缘）；y∈[0,1] 为元素脚底/底部锚点的纵向位置（0=画面顶，1=画面底）。\n' +
    '透视规则：远处元素 y 更小（约 0.55-0.7）且 scale 更小；近处元素 y 更大（0.85-1.0）且 scale 更大；y<0.7 的元素 scale 不得 ≥0.7。\n' +
    'zIndex：前后遮挡，大的在前（背景 0，远处 1-2，主体 3-5，最前景 6+）。\n' +
    'flipH：true 表示水平翻转（面朝左）；按剧情视线/走向决定。\n' +
    'stateKey：该元素本场景应呈现的状态，必须从输入清单该元素的 stateKeys 里原样照抄一个；没有合适状态或清单为空时输出空字符串。\n' +
    'blocking：元素间关系描述，必须含方位+间距+视线/朝向（≤30字），如"蝴蝶在小鸡右前方一个身位的草叶上方飞，小鸡视线追着它"——只写"狐狸在架下"不合格。\n' +
    'evidence：本构图判断的原文依据——从该场景剧情摘要里照抄**高潮/转折句**（≤40字），禁止自己改写；没有依据的摆放不允许输出。\n' +
    'cameraNote：本场景镜头感一句话（≤24字），如"中景平视，鸡在左蝴蝶在右前方"。\n' +
    '输出要求：\n' +
    '- 只输出一个可 JSON.parse 的 JSON 对象，不要 markdown、不要代码块、不要分析过程。\n' +
    '- 结构：{"scenes":[{"sceneId":"…","cameraNote":"…","items":[{"subjectId":"…","kind":"character","stateKey":"…","x":0.5,"y":0.9,"scale":0.5,"zIndex":3,"flipH":false,"blocking":"…","evidence":"…"}]}]}\n' +
    `- sceneId、subjectId 必须原样照抄输入值；items 必须恰好覆盖输入清单里该场景的全部元素，不多不少（每场最多 ${MAX_COMPOSITION_ITEMS} 项）。\n` +
    `- 同一元素在同场景只出现一次；单场元素超过 ${MAX_COMPOSITION_ITEMS} 项时无法构图，应完整输出而非静默省略。数值必须落在约定区间内。`
  )
}

function normalizeComposition(parsed, { scenes }) {
  const sceneById = new Map(scenes.map((s) => [s.sceneId, s]))
  const sceneByLoose = new Map(scenes.map((s) => [s.sceneId.toLowerCase(), s]))
  const out = []
  for (const rawScene of asList(parsed && parsed.scenes)) {
    const sceneIdIn = asStr(rawScene && rawScene.sceneId)
    const scene = sceneById.get(sceneIdIn) || sceneByLoose.get(sceneIdIn.toLowerCase()) || null
    if (!scene) continue
    const allowed = new Map(scene.subjects.map((s) => [s.subjectId, s]))
    const items = []
    for (const rawItem of asList(rawScene && rawScene.items)) {
      const subjectId = scene.resolveSubjectId(rawItem && rawItem.subjectId)
      if (!subjectId || !allowed.has(subjectId)) continue
      if (items.some((x) => x.subjectId === subjectId)) continue
      const subject = allowed.get(subjectId)
      const stateKeyRaw = asStr(rawItem && rawItem.stateKey)
      const stateKey = subject.stateKeys.includes(stateKeyRaw) ? stateKeyRaw : ''
      items.push({
        subjectId,
        kind: subject.kind,
        stateKey,
        x: clampNum(rawItem && rawItem.x, 0, 1, 0.5),
        y: clampNum(rawItem && rawItem.y, 0.35, 1, 0.9),
        scale: clampNum(rawItem && rawItem.scale, 0.1, 2.5, 1),
        zIndex: Math.round(clampNum(rawItem && rawItem.zIndex, 1, 99, 3)),
        flipH: Boolean(rawItem && rawItem.flipH),
        blocking: clampText2(rawItem && rawItem.blocking, 60),
        evidence: clampText2(rawItem && rawItem.evidence, 80)
      })
      if (items.length >= MAX_COMPOSITION_ITEMS) break
    }
    // 2026-10-05 导演后处理（确定性纪律，不依赖模型自觉）：
    // ①scale 硬顶 0.85（单元素不得撑满画幅）；②≥3 元素的群像场景主元素 ≤0.7；
    // ③透视一致性：y<0.7（远景）的元素 scale 不得 ≥0.65。违规项收窄而非拒绝——构图意图保留、数值合规。
    const capScale = (item, cap) => {
      if (item.scale > cap) item.scale = cap
      if (item.y < 0.7 && item.scale > 0.65) item.scale = 0.65
      if (item.y < 0.6 && item.scale > 0.55) item.scale = 0.55
    }
    const crowdCap = items.length >= 3 ? 0.7 : 0.85
    for (const it of items) capScale(it, crowdCap)
    // ④落地纪律（2026-10-07）：角色脚底锚点不得悬在画面上半部（y<0.7）——除非布场/依据含飞行腾空语义。
    // 公主穿衣场景1事故：导演把佳佳当"消息提示"布置 y=0.45，视觉上人浮在墙上。
    const flightHint = /(飞|翔|空中|树上|枝头|飞翔|飞落|停落|绕飞|fly|flying|perch|airborne)/i
    for (const it of items) {
      if (it.kind === 'character' && it.y < 0.7 && !flightHint.test(`${it.blocking} ${it.evidence}`)) {
        it.y = 0.85
        it.blocking = clampText2(`${it.blocking}（落地校正）`, 60)
      }
    }
    out.push({
      sceneId: scene.sceneId,
      sceneName: scene.sceneName,
      cameraNote: clampText2(rawScene && rawScene.cameraNote, 60),
      items
    })
    if (out.length >= 60) break
  }
  return { scenes: out }
}

function clampText2(v, max) { return asStr(v).slice(0, max) }

export function validateCompositionCoverage(normalized, expectedScenes) {
  const issues = []
  if (!normalized || !Array.isArray(normalized.scenes) || !normalized.scenes.length) return ['composition_empty']

  const actualByScene = new Map()
  for (const scene of normalized.scenes) {
    const sceneId = asStr(scene && scene.sceneId)
    if (actualByScene.has(sceneId)) {
      issues.push(`duplicate_scene:${sceneId}`)
      continue
    }
    actualByScene.set(sceneId, scene)
  }
  for (const expected of asList(expectedScenes)) {
    const sceneId = asStr(expected && expected.sceneId)
    const actual = actualByScene.get(sceneId)
    if (!actual) {
      issues.push(`missing_scene:${sceneId}`)
      continue
    }
    const actualIds = new Set(asList(actual.items).map((item) => asStr(item && item.subjectId)))
    for (const subject of asList(expected && expected.subjects)) {
      const subjectId = asStr(subject && subject.subjectId)
      if (subjectId && !actualIds.has(subjectId)) issues.push(`missing_subject:${sceneId}:${subjectId}`)
    }
  }
  return issues
}

function validateComposition(normalized, expectedScenes) {
  return validateCompositionCoverage(normalized, expectedScenes)
}

// 从故事文档+资产计划构建构图输入：逐场景（scene/ending 节点）+ 出场元素（计划资产 sceneIds 命中）+ 各自可用状态变体
export function buildCompositionInput({ project, story, plan }) {
  const nodes = asList(story && story.nodes)
    .filter((node) => {
      const kind = asStr(node && node.kind)
      return kind === 'scene' || kind === 'ending'
    })
  const planAssets = asList(plan && plan.assets)
    .filter((a) => {
      const cat = asStr(a && a.category)
      return cat === 'character' || cat === 'prop'
    })
  const scenes = nodes.map((node, index) => {
    const sceneId = asStr(node && node.id) || `scene_${index + 1}`
    const summary = clampText2(`${asStr(node && node.body && node.body.title) || asStr(node && node.name)}：${asStr(node && node.body && node.body.text)}`, 600)
    const subjects = []
    for (const a of planAssets) {
      const sids = asList(a && a.sceneIds).map((s) => asStr(s))
      if (!sids.includes(sceneId)) continue
      const subjectId = asStr(a && a.id)
      if (!subjectId) continue
      subjects.push({
        subjectId,
        name: asStr(a && a.name) || subjectId,
        kind: asStr(a && a.category) === 'character' ? 'character' : 'prop',
        anchorHint: clampText2(a && a.anchorPrompt, 80),
        stateKeys: asList(a && a.stateVariants).map((v) => asStr(v && v.stateKey)).filter(Boolean)
      })
    }
    return {
      sceneId,
      sceneName: asStr(node && node.body && node.body.title) || asStr(node && node.name) || sceneId,
      summary,
      subjects,
      resolveSubjectId: buildEntityIdResolver(subjects.map((s) => ({ id: s.subjectId, name: s.name })))
    }
  }).filter((s) => s.subjects.length > 0)
  return {
    storyTitle: asStr(project && project.title),
    scenes
  }
}

export async function extractStoryComposition({ provider, model, apiUrl, proxyUrl, timeoutMs, input }) {
  const p = String(provider || '').trim().toLowerCase()
  const t = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 120_000
  const instructions = buildInstructions()
  const normArgsFor = (scenes) => ({ scenes })

  const oversizedScene = input.scenes.find((scene) => scene.subjects.length > MAX_COMPOSITION_ITEMS)
  if (oversizedScene) {
    throw new Error(`too_many_composition_items:${oversizedScene.sceneId}:${oversizedScene.subjects.length}`)
  }

  // 2026-10-04 分批提取：全场景一次调用的 prompt 随场景数线性膨胀（15 场景 ≈ 8K+ tokens），
  // OMLX 8K 窗口下 prefill 内存护栏按 prompt 体积拒绝（KV+SDPA ~4GB，环境 GPU 压力浮动时必撞）。
  // 每批 1 场景（prompt ~1.2K + 输出预留 2048 ≈ 1.7GB KV），逐批串行后合并——批间互不依赖（构图按场景独立）。
  // 护栏余量受环境 Metal 占用浮动（实测 ceiling 23.0、基线 current 19.18），批=2（3.99GB）仍可能边际被拒。
  const COMPOSITION_BATCH_SIZE = 1
  const batches = []
  for (let i = 0; i < input.scenes.length; i += COMPOSITION_BATCH_SIZE) batches.push(input.scenes.slice(i, i + COMPOSITION_BATCH_SIZE))

  const runBatch = async (batchScenes, batchIndex) => {
    const user = JSON.stringify({
      storyTitle: input.storyTitle,
      scenes: batchScenes.map((s) => ({
        sceneId: s.sceneId,
        sceneName: s.sceneName,
        summary: s.summary,
        subjects: s.subjects.map((x) => ({ subjectId: x.subjectId, name: x.name, kind: x.kind, anchorHint: x.anchorHint, stateKeys: x.stateKeys }))
      }))
    }, null, 2)
    const normArgs = normArgsFor(batchScenes)

    if (p === 'openai' || p === 'localoxml') {
      let lastErr = null
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const body = {
          instructions: attempt === 0 ? instructions : `${instructions}\n再次强调：只输出一个可直接 JSON.parse 的 JSON 对象，不要输出任何其他内容。`,
          input: user,
          ...(model ? { model: String(model).trim() } : {}),
          // 构图输出有界（1 场景 × ≤10 元素 ≈ 0.5-1K tokens），显式压 max_output_tokens 预算——
          // 缺省 8192 会让 OMLX 按上限预留 KV，撞 prefill 内存护栏
          max_output_tokens: 2048,
          text: { format: { type: 'json_schema', name: 'story_composition', strict: true, schema: compositionSchema() } }
        }
        try {
          const { json, meta } = await openaiResponsesJsonForTools({ body, provider: p, apiUrl, proxyUrl, timeoutMs: t })
          const parsed = parseModelJsonLenient(extractResponseOutputText(json))
          const normalized = normalizeComposition(parsed, normArgs)
          // 2026-10-11 降级规则：missing_subject 降级为 warn 不阻断——漏点元素由摆位默认规格兜底（公主穿衣9人设
          // 与杰克金鹅两连验证：全元素覆盖校验把 LLM 偶发漏点变成整批 500，重试纯碰运气）。
          // duplicate_scene（同场景输出两遍）仍是 error（数据损坏级）。
          const issues = validateComposition(normalized, batchScenes).filter((x) => !String(x).startsWith('missing_subject:'))
          if (issues.length) throw new Error(`incomplete_composition:${issues.join(',')}`)
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
        validate: (x) => validateComposition(normalizeComposition(x, normArgs), batchScenes).length === 0,
        proxyUrl
      })
      return { result: normalizeComposition(parsed, normArgs), meta }
    }

    if (p === 'ollama') {
      const { parsed, meta } = await generateStrictJsonViaOllamaChat({
        instructions,
        input: user,
        model: model || undefined,
        timeoutMs: t,
        maxRetries: 2,
        validate: (x) => validateComposition(normalizeComposition(x, normArgs), batchScenes).length === 0,
        proxyUrl
      })
      return { result: normalizeComposition(parsed, normArgs), meta }
    }

    throw new Error(`unsupported_provider:${p || 'unknown'}`)
  }

  // 串行逐批（本地模型禁止并行 prefill），任一批失败即整体失败（不返残缺构图）
  const merged = []
  let firstMeta = null
  for (let i = 0; i < batches.length; i += 1) {
    const { result, meta } = await runBatch(batches[i], i)
    if (!firstMeta) firstMeta = meta
    merged.push(...(Array.isArray(result?.scenes) ? result.scenes : []))
  }
  const result = { scenes: merged }
  const finalIssues = validateComposition(result, input.scenes).filter((x) => !String(x).startsWith('missing_subject:'))
  if (finalIssues.length) throw new Error(`incomplete_composition:${finalIssues.join(',')}`)
  return { result, meta: firstMeta }
}
