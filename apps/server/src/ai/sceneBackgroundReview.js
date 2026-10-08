// 场景背景绑定前 AI 视觉评审（2026-09-27 新增，scene_bind 前置门禁，fail-closed）。
// 背景：上轮事故 ≥4/10 背景烤入不一致的角色（猫），场景链路从无 AI 视觉评审，无人发现。
// 评审通道与锁定链路同款双通道结构（characterPoseReview.js）：
// - 本地视觉模型 gemma-4-26b-a4b-it-4bit（经 OMLX 多模态），全程持 resourceLease vision 租约；
// - Kimi(moonshot) 云端视觉，配额受限，由调用方按设置切换。
// 评审项：①纯环境（无角色/动物/人物烤入——人物事物由立绘层合成）②环境内容与 location 锚点匹配
// ③绘本扁平插画风格一致。输出 { passed, score, summary, issues }，调用方写入 scene_bind 记录 aiReview 字段。

import { withResourceLease } from './resourceLease.js'

function asStr(v) {
  return typeof v === 'string' ? v : ''
}

// 与 storyLock.js / characterPoseReview.js 同款：剥离 markdown 围栏后截取首个 JSON 对象
function extractJsonObjectString(raw) {
  let text = asStr(raw).trim()
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return text
  return text.slice(start, end + 1)
}

function buildSceneBackgroundReviewInstructions({ sceneName, environmentAnchors }) {
  const name = asStr(sceneName).trim() || '目标场景'
  const anchors = (Array.isArray(environmentAnchors) ? environmentAnchors : [])
    .map((x) => asStr(x).trim())
    .filter(Boolean)
  return (
    `你是儿童绘本互动故事的「场景背景审核器」。输入是一张待绑定的场景背景图（场景：${name}）。\n` +
    `本项目采用「背景+立绘分层合成」工艺：人物、动物、事物都由透明立绘层在后期合成，背景图必须是纯环境。\n` +
    `审核项（逐项检查）：\n` +
    `1. 纯环境：画面中不得出现任何角色/人物/动物/生物主体（含远景小人、剪影、拟人化物体）。出现任一即判失败。\n` +
    `1b. 无孤立物体主体：画面不得出现书籍、工具、容器、家具、车辆、食物等孤立人造/非环境物体作为视觉主体——特别注意检查前景与视觉中心是否有"打开的书本"（picture book 风格词极易诱导模型画出实体书）。地点锚点明确要求的人造环境元素（如房屋、桥、道路）除外。出现任一即判失败。\n` +
    `2. 环境匹配：画面环境内容应与场景地点锚点一致${anchors.length ? `：${anchors.join('；')}` : '（本场景无地点锚点，只要是一般环境场景即可）'}。环境明显跑题判失败。\n` +
    `3. 画风一致：必须是 flat 2D 儿童绘本插画风格（柔和色彩/粗描边/赛璐璐质感），写实照片风、3D 渲染风判失败。\n` +
    `输出要求：只输出一个合法 JSON 对象，不要 markdown 代码块，不要任何额外文字。\n` +
    `JSON 结构：{"passed": 布尔, "score": 0到100的整数, "issues": ["问题描述"], "summary": "一句话结论"}\n` +
    `判失败纪律：passed=false 当且仅当存在上述任一类明确缺陷；每条 issue 必须指明画面中具体可见的元素与位置；\n` +
    `不得给出无法从图中直接确认的指控；拿不准的轻微风格问题只扣分不判失败。\n`
  )
}

function parseSceneBackgroundReviewContent(rawContent, meta) {
  const content = asStr(rawContent).trim()
  let parsed
  try {
    parsed = JSON.parse(extractJsonObjectString(content) || '{}')
  } catch (parseErr) {
    console.log(`[scene.bg.review][debug] PARSE_ERROR=${parseErr.message} content_head=${content.slice(0, 120).replace(/\n/g, ' ')}`)
    throw new Error('invalid_scene_review_output')
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid_scene_review_output')
  const out = { ...parsed }
  if (typeof out.passed !== 'boolean') {
    const score = Number(out.score)
    out.passed = Number.isFinite(score) ? score >= 60 : false
  }
  const scoreNum = Number(out.score)
  out.score = Number.isFinite(scoreNum) ? Math.max(0, Math.min(100, Math.round(scoreNum))) : (out.passed ? 80 : 20)
  if (!Array.isArray(out.issues)) {
    const alt = out.problems || out.errors || out.issue
    out.issues = Array.isArray(alt) ? alt : (alt ? [String(alt)] : [])
  }
  out.issues = out.issues.map((x) => asStr(x)).filter(Boolean).slice(0, 20)
  out.summary = asStr(out.summary || out.reason || out.analysis || out.issues[0] || (out.passed ? '视觉评审通过' : '视觉评审未通过'))
  return { passed: out.passed, score: out.score, issues: out.issues, summary: out.summary, meta }
}

function buildReviewRequestBody({ model, sceneName, environmentAnchors, imageDataUrl, maxTokens, temperature }) {
  return {
    model: asStr(model).trim(),
    messages: [
      { role: 'system', content: buildSceneBackgroundReviewInstructions({ sceneName, environmentAnchors }) },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请审核这张场景背景图是否通过（纯环境 / 环境匹配 / 绘本画风）。请输出 JSON。' },
          { type: 'image_url', image_url: { url: asStr(imageDataUrl).trim() } }
        ]
      }
    ],
    // OMLX 按 max_tokens 预留 KV：评审输出只有几句话 JSON，给有限值防止撞内存护栏
    max_tokens: maxTokens,
    ...(temperature != null ? { temperature } : {})
  }
}

// 本地视觉评审（gemma-4-26b-a4b-it-4bit 经 OMLX）：经 control 资源调度器 vision 租约准入。
// 响应体消费必须留在租约内（同 characterPoseReview.js 2026-09-16 修复：fetch 响应头到达即 resolve，
// 提前释放租约会让调度器换回 LLM、视觉模型生成中途被卸载）。
export async function reviewSceneBackgroundWithLocalVl({ baseUrl, apiKey, model, sceneName, environmentAnchors, imageDataUrl }) {
  const url = `${asStr(baseUrl).trim().replace(/\/+$/, '')}/chat/completions`
  const reviewModel = asStr(model).trim() || 'gemma-4-26b-a4b-it-4bit'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)
  try {
    const { res, json } = await withResourceLease('vision', `gs:scene_bg_review:${asStr(sceneName) || '-'}`, async () => {
      const r = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(asStr(apiKey).trim() ? { Authorization: `Bearer ${asStr(apiKey).trim()}` } : {})
        },
        body: JSON.stringify(buildReviewRequestBody({ model: reviewModel, sceneName, environmentAnchors, imageDataUrl, maxTokens: 2048, temperature: 0.2 }))
      })
      const j = await r.json().catch(() => null)
      return { res: r, json: j }
    })
    if (!res.ok) {
      throw new Error(json?.error?.message || `local_vl_http_${res.status}`)
    }
    return parseSceneBackgroundReviewContent(json?.choices?.[0]?.message?.content, { provider: 'local_vl', api: 'omlx.chat.completions', model: reviewModel })
  } finally {
    clearTimeout(timeout)
  }
}

// Kimi(moonshot) 云端视觉评审：与 storyLock.js 锁定评审同款 chat/completions 调用。
export async function reviewSceneBackgroundWithAi({ apiKey, baseUrl, model, sceneName, environmentAnchors, imageDataUrl }) {
  const key = asStr(apiKey).trim()
  if (!key) throw new Error('moonshot_api_key_missing')
  const reviewModel = asStr(model).trim() || 'kimi-for-coding'
  const url = `${asStr(baseUrl).trim().replace(/\/+$/, '') || 'https://api.kimi.com/coding/v1'}/chat/completions`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      // kimi-for-coding 仅允许 temperature=1
      body: JSON.stringify(buildReviewRequestBody({ model: reviewModel, sceneName, environmentAnchors, imageDataUrl, maxTokens: 4000, temperature: 1 }))
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      throw new Error(json?.error?.message || `moonshot_http_${res.status}`)
    }
    return parseSceneBackgroundReviewContent(json?.choices?.[0]?.message?.content, { provider: 'moonshot', api: 'chat.completions', model: reviewModel })
  } finally {
    clearTimeout(timeout)
  }
}
