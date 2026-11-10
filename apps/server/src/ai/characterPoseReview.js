// 2026-09-01 动作立绘抽卡池：候选图与角色锁定主参考的一致性视觉评审（Kimi/moonshot）。
// 与 storyLock.js 的锁定测试评审同属 Kimi 视觉路径（本地 OMLX 不支持图像输入），
// 但审核目标不同：这里对比「主参考 vs 新姿势候选」，只评身份/画风/服装一致性，
// 姿势差异明确不扣分（姿势本来就是要变的），且不需要修订提示词。

import { withResourceLease } from './resourceLease.js'

function asStr(v) {
  return typeof v === 'string' ? v : ''
}

// 与 storyLock.js 同款：剥离 markdown 围栏后截取首个 JSON 对象
function extractJsonObjectString(raw) {
  let text = asStr(raw).trim()
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return text
  return text.slice(start, end + 1)
}

// 评审指令：身份（物种/头脸/五官）+ 画风（flat 2D 绘本/赛璐璐/粗描边）+ 服装一致；
// 明确指示不要因姿势/动作/朝向/镜头角度不同扣分。
// T 波（2026-10-28 用户实测根修）：三视图 side/back 评审加「视角正确性」硬门槛——expectView 传入时
// 先判主体视角是否为所要求视角（侧面=只见一侧脸/一只眼；背面=背对观众看不到脸），不符直接低分 fail，不再只看身份一致性。
const EXPECT_VIEW_LABEL = { side: '侧面（full profile，只见一侧脸与一只眼）', back: '背面（背对观众，看不到脸与五官）' }
function buildPoseReviewInstructions({ characterName, expectView }) {
  const name = asStr(characterName).trim() || '目标角色'
  const viewKey = asStr(expectView).trim().toLowerCase()
  const viewLabel = EXPECT_VIEW_LABEL[viewKey] || ''
  return (
    `你是儿童绘本互动故事的「角色立绘一致性审核器」。\n` +
    `你会看到两张图：第一张是角色「${name}」的锁定主参考（身份基准），第二张是同一角色的新姿势候选立绘。\n` +
    `评分维度（满分 100）：\n` +
    `- 角色身份一致：物种、头脸轮廓、五官特征、体型配色必须与主参考是同一个角色。\n` +
    `- 画风一致：保持相同的绘制风格（flat 2D 绘本插画 / 赛璐璐 / 粗描边 / 色彩体系），不能从绘本风退化成写实风或 3D 风。\n` +
    `- 服装一致：服装款式与配色必须与主参考一致，不能换装。\n` +
    `- 配色一致（U 波新增）：毛色/服装的主色与主参考明显不同（如蓝灰变棕灰）即降分；同色系明暗差异不扣分。\n` +
    (viewLabel
      ? `- 背景纯度：三视图参考图必须纯白底；渐变底/投影/场景背景一律打回（score 不过 20）。\n`
      : `- 背景差异（绿幕 vs 纯色 vs 场景）不扣分，只看角色本体。\n`) +
    (viewLabel
      ? `视角硬门槛（最高优先级）：候选图主体必须是「${viewLabel}」视角；若主体仍是正面/四分之三侧/或其他非要求视角，无论身份多一致，score 不得超过 20，且 reason 必须先说明视角不符，再述配色。\n`
      : '') +
    `重要规则（必须遵守）：\n` +
    `- 两张图的姿势/动作/表情/朝向/镜头角度必然不同，这是需求本身，严禁因姿势不同而扣分。\n` +
    `- 物种错误、脸换成人类、画风明显不同、明显换装，才是主要扣分项。\n` +
    `输出要求：只输出一个合法 JSON 对象，不要 markdown 代码块，不要任何额外文字。\n` +
    `格式：{"score": 0到100的整数, "reason": "中文一句话说明主要依据"}\n`
  )
}

// 调 Kimi(moonshot) 视觉评审，返回 { score, reason, meta }；失败抛错（不伪造分数）。
export async function reviewCharacterPoseConsistencyWithAi({
  apiKey,
  baseUrl,
  model,
  characterName,
  referenceImageDataUrl,
  candidateImageDataUrl,
  expectView
}) {
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
      body: JSON.stringify({
        model: reviewModel,
        messages: [
          { role: 'system', content: buildPoseReviewInstructions({ characterName, expectView }) },
          {
            role: 'user',
            content: [
              { type: 'text', text: '第一张：角色锁定主参考（身份基准）。第二张：待评分的新姿势候选立绘。请输出 JSON 评分。' },
              { type: 'image_url', image_url: { url: asStr(referenceImageDataUrl).trim() } },
              { type: 'image_url', image_url: { url: asStr(candidateImageDataUrl).trim() } }
            ]
          }
        ],
        max_tokens: 4000,
        temperature: 1
      })
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      throw new Error(json?.error?.message || `moonshot_http_${res.status}`)
    }
    return parsePoseReviewContent(json?.choices?.[0]?.message?.content, { provider: 'moonshot', api: 'chat.completions', model: reviewModel })
  } finally {
    clearTimeout(timeout)
  }
}

function parsePoseReviewContent(rawContent, meta) {
  const content = asStr(rawContent).trim()
  let parsed
  try {
    parsed = JSON.parse(extractJsonObjectString(content) || '{}')
  } catch (parseErr) {
    console.log(`[ch.pose_review][debug] PARSE_ERROR=${parseErr.message} content_head=${content.slice(0, 120).replace(/\n/g, ' ')}`)
    throw new Error('invalid_pose_review_output')
  }
  const scoreNum = Number(parsed && parsed.score)
  if (!Number.isFinite(scoreNum)) {
    console.log(`[ch.pose_review][debug] VALIDATE_FAIL keys=${Object.keys(parsed || {}).join(',')} score=${String(parsed?.score)} content_head=${content.slice(0, 160).replace(/\n/g, ' ')}`)
    throw new Error('invalid_pose_review_output')
  }
  const score = Math.max(0, Math.min(100, Math.round(scoreNum)))
  const reason = asStr(parsed && (parsed.reason || parsed.summary || parsed.analysis)).trim() || '评审完成'
  return { score, reason, meta }
}

// 2026-09-08 本地视觉评审（gemma-4-26b-a4b-it-4bit 经 OMLX，实测多模态可用）。
// 背景：Kimi 周配额有限（7 天窗口），配额尽时评审全灭；本地 VL 零配额、可复跑。
// 同一套评审指令与 JSON 输出契约，评分语义与 Kimi 路径一致。
export async function reviewCharacterPoseConsistencyWithLocalVl({
  baseUrl,
  apiKey,
  model,
  characterName,
  referenceImageDataUrl,
  candidateImageDataUrl,
  expectView
}) {
  const url = `${asStr(baseUrl).trim().replace(/\/+$/, '')}/chat/completions`
  const reviewModel = asStr(model).trim() || 'gemma-4-26b-a4b-it-4bit'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)
  try {
    // 本地 VL 评审经 control 资源调度器 vision 租约准入（与 LLM/出图互斥换入换出）
    // 2026-09-16 修复：响应体消费必须留在租约内——fetch 在响应头到达即 resolve，
    // 此前租约提前释放 → 调度器 settle 换回 LLM → gemma 生成中途被卸载 → 180s 空响应。
    const { res, json } = await withResourceLease('vision', `ts:pose_review:${asStr(characterName) || '-'}`, async () => {
      const r = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(asStr(apiKey).trim() ? { Authorization: `Bearer ${asStr(apiKey).trim()}` } : {})
        },
        body: JSON.stringify({
          model: reviewModel,
          messages: [
            { role: 'system', content: buildPoseReviewInstructions({ characterName, expectView }) },
            {
              role: 'user',
              content: [
                { type: 'text', text: '第一张：角色锁定主参考（身份基准）。第二张：待评分的新姿势候选立绘。请输出 JSON 评分。' },
                { type: 'image_url', image_url: { url: asStr(referenceImageDataUrl).trim() } },
                { type: 'image_url', image_url: { url: asStr(candidateImageDataUrl).trim() } }
              ]
            }
          ],
          // OMLX 按 max_tokens 预留 KV：评审输出只有一句话 JSON，给有限值防止撞内存护栏
          max_tokens: 2048,
          temperature: 0.2
        })
      })
      const j = await r.json().catch(() => null)
      return { res: r, json: j }
    })
    if (!res.ok) {
      throw new Error(json?.error?.message || `local_vl_http_${res.status}`)
    }
    return parsePoseReviewContent(json?.choices?.[0]?.message?.content, { provider: 'local_vl', api: 'omlx.chat.completions', model: reviewModel })
  } finally {
    clearTimeout(timeout)
  }
}

// Z 波（2026-10-28 sheet 模式重生）：三栏视角分类——sheet 切割后栏序不可控，逐栏单图判 front/side/back。
// 与评分不同：这是分类任务（单图即可，不需主参考对比），输出 {view}。
const CLASSIFY_VIEW_INSTRUCTIONS =
  `你是儿童绘本角色三视图的「视角分类器」。\n` +
  `你会看到一张角色单图。判断图中主体的视角是以下三类中的哪一类：\n` +
  `- front：正面（面对观众，双眼/面部正对镜头）\n` +
  `- side：侧面（full profile，只见一侧脸/一只眼，鼻子朝左或朝右）\n` +
  `- back：背面（背对观众，看不到脸，见后脑勺与背部）\n` +
  `输出要求：只输出一个合法 JSON 对象，不要 markdown。\n` +
  `格式：{"view": "front 或 side 或 back", "reason": "中文一句话依据"}\n`

function parseViewClassifyContent(rawContent, meta) {
  const content = asStr(rawContent).trim()
  let parsed
  try {
    parsed = JSON.parse(extractJsonObjectString(content) || '{}')
  } catch (_) {
    throw new Error('invalid_view_classify_output')
  }
  const view = asStr(parsed && parsed.view).trim().toLowerCase()
  if (!['front', 'side', 'back'].includes(view)) throw new Error('invalid_view_classify_output')
  return { view, reason: asStr(parsed && parsed.reason).trim(), meta }
}

export async function classifyCharacterViewWithAi({ apiKey, baseUrl, model, candidateImageDataUrl }) {
  const key = asStr(apiKey).trim()
  if (!key) throw new Error('moonshot_api_key_missing')
  const url = `${asStr(baseUrl).trim().replace(/\/+$/, '') || 'https://api.kimi.com/coding/v1'}/chat/completions`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: asStr(model).trim() || 'kimi-for-coding',
        messages: [
          { role: 'system', content: CLASSIFY_VIEW_INSTRUCTIONS },
          { role: 'user', content: [{ type: 'text', text: '请判这张图的主体视角（front/side/back），输出 JSON。' }, { type: 'image_url', image_url: { url: asStr(candidateImageDataUrl).trim() } }] }
        ],
        max_tokens: 2000,
        temperature: 1
      })
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new Error(json?.error?.message || `moonshot_http_${res.status}`)
    return parseViewClassifyContent(json?.choices?.[0]?.message?.content, { provider: 'moonshot', api: 'chat.completions', model: asStr(model).trim() || 'kimi-for-coding' })
  } finally {
    clearTimeout(timeout)
  }
}

export async function classifyCharacterViewWithLocalVl({ baseUrl, apiKey, model, candidateImageDataUrl }) {
  const url = `${asStr(baseUrl).trim().replace(/\/+$/, '')}/chat/completions`
  const reviewModel = asStr(model).trim() || 'gemma-4-26b-a4b-it-4bit'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)
  try {
    const { res, json } = await withResourceLease('vision', 'ts:view_classify:sheet', async () => {
      const r = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(asStr(apiKey).trim() ? { Authorization: `Bearer ${asStr(apiKey).trim()}` } : {}) },
        body: JSON.stringify({
          model: reviewModel,
          messages: [
            { role: 'system', content: CLASSIFY_VIEW_INSTRUCTIONS },
            { role: 'user', content: [{ type: 'text', text: '请判这张图的主体视角（front/side/back），输出 JSON。' }, { type: 'image_url', image_url: { url: asStr(candidateImageDataUrl).trim() } }] }
          ],
          max_tokens: 2048,
          temperature: 0.2
        })
      })
      const j = await r.json().catch(() => null)
      return { res: r, json: j }
    })
    if (!res.ok) throw new Error(json?.error?.message || `local_vl_http_${res.status}`)
    return parseViewClassifyContent(json?.choices?.[0]?.message?.content, { provider: 'local_vl', api: 'omlx.chat.completions', model: reviewModel })
  } finally {
    clearTimeout(timeout)
  }
}

// AA 波（2026-10-28 sheet 整图即标准系）：sheet 整图评审——三栏视角齐全性+身份一致+配色一致+底纯。
// 输入：sheet 整图（左中右三栏同角色）+主参考；输出 {score,reason,views:{front,side,back}}。
const SHEET_WHOLE_INSTRUCTIONS =
  `你是儿童绘本角色标准系三视图的「整图审核器」。\n` +
  `你会看到两张图：第一张是角色锁定主参考（身份基准），第二张是该角色的三视图 sheet 整图（横排多栏）。\n` +
  `审核维度（满分 100）：\n` +
  `- 视角齐全性（硬门槛）：sheet 内必须同时包含该角色的正面、侧面、背面三栏；缺任一视角 score 不过 20，reason 先述缺哪个视角。\n` +
  `- 角色身份一致：每一栏都必须与主参考是同一个角色（物种/头脸/体型一致）。\n` +
  `- 配色一致：毛色/服装主色与主参考一致，栏间明显漂移即降分。\n` +
  `- 背景纯度：sheet 底必须纯白/近白统一；渐变底/场景背景/底座台座（platform/stand/pedestal）打回。\n` +
  `输出要求：只输出一个合法 JSON 对象，不要 markdown。\n` +
  `格式：{"score": 0-100 整数, "reason": "中文一句话", "views": {"front": true/false, "side": true/false, "back": true/false}}\n`

function parseSheetWholeContent(rawContent, meta) {
  const content = asStr(rawContent).trim()
  let parsed
  try {
    parsed = JSON.parse(extractJsonObjectString(content) || '{}')
  } catch (_) {
    throw new Error('invalid_sheet_review_output')
  }
  const scoreNum = Number(parsed && parsed.score)
  if (!Number.isFinite(scoreNum)) throw new Error('invalid_sheet_review_output')
  const views = parsed && typeof parsed.views === 'object' ? parsed.views : {}
  return {
    score: Math.max(0, Math.min(100, Math.round(scoreNum))),
    reason: asStr(parsed && parsed.reason).trim() || '评审完成',
    views: { front: Boolean(views.front), side: Boolean(views.side), back: Boolean(views.back) },
    meta
  }
}

export async function reviewModelSheetWholeWithAi({ apiKey, baseUrl, model, referenceImageDataUrl, sheetImageDataUrl }) {
  const key = asStr(apiKey).trim()
  if (!key) throw new Error('moonshot_api_key_missing')
  const url = `${asStr(baseUrl).trim().replace(/\/+$/, '') || 'https://api.kimi.com/coding/v1'}/chat/completions`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: asStr(model).trim() || 'kimi-for-coding',
        messages: [
          { role: 'system', content: SHEET_WHOLE_INSTRUCTIONS },
          {
            role: 'user',
            content: [
              { type: 'text', text: '第一张：角色锁定主参考。第二张：三视图 sheet 整图。请输出 JSON 评审。' },
              { type: 'image_url', image_url: { url: asStr(referenceImageDataUrl).trim() } },
              { type: 'image_url', image_url: { url: asStr(sheetImageDataUrl).trim() } }
            ]
          }
        ],
        max_tokens: 4000,
        temperature: 1
      })
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new Error(json?.error?.message || `moonshot_http_${res.status}`)
    return parseSheetWholeContent(json?.choices?.[0]?.message?.content, { provider: 'moonshot', api: 'chat.completions', model: asStr(model).trim() || 'kimi-for-coding' })
  } finally {
    clearTimeout(timeout)
  }
}

export async function reviewModelSheetWholeWithLocalVl({ baseUrl, apiKey, model, referenceImageDataUrl, sheetImageDataUrl }) {
  const url = `${asStr(baseUrl).trim().replace(/\/+$/, '')}/chat/completions`
  const reviewModel = asStr(model).trim() || 'gemma-4-26b-a4b-it-4bit'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)
  try {
    const { res, json } = await withResourceLease('vision', 'ts:sheet_review:whole', async () => {
      const r = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(asStr(apiKey).trim() ? { Authorization: `Bearer ${asStr(apiKey).trim()}` } : {}) },
        body: JSON.stringify({
          model: reviewModel,
          messages: [
            { role: 'system', content: SHEET_WHOLE_INSTRUCTIONS },
            {
              role: 'user',
              content: [
                { type: 'text', text: '第一张：角色锁定主参考。第二张：三视图 sheet 整图。请输出 JSON 评审。' },
                { type: 'image_url', image_url: { url: asStr(referenceImageDataUrl).trim() } },
                { type: 'image_url', image_url: { url: asStr(sheetImageDataUrl).trim() } }
              ]
            }
          ],
          max_tokens: 2048,
          temperature: 0.2
        })
      })
      const j = await r.json().catch(() => null)
      return { res: r, json: j }
    })
    if (!res.ok) throw new Error(json?.error?.message || `local_vl_http_${res.status}`)
    return parseSheetWholeContent(json?.choices?.[0]?.message?.content, { provider: 'local_vl', api: 'omlx.chat.completions', model: reviewModel })
  } finally {
    clearTimeout(timeout)
  }
}
