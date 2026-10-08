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
function buildPoseReviewInstructions({ characterName }) {
  const name = asStr(characterName).trim() || '目标角色'
  return (
    `你是儿童绘本互动故事的「角色立绘一致性审核器」。\n` +
    `你会看到两张图：第一张是角色「${name}」的锁定主参考（身份基准），第二张是同一角色的新姿势候选立绘。\n` +
    `评分维度（满分 100）：\n` +
    `- 角色身份一致：物种、头脸轮廓、五官特征、体型配色必须与主参考是同一个角色。\n` +
    `- 画风一致：保持相同的绘制风格（flat 2D 绘本插画 / 赛璐璐 / 粗描边 / 色彩体系），不能从绘本风退化成写实风或 3D 风。\n` +
    `- 服装一致：服装款式与配色必须与主参考一致，不能换装。\n` +
    `重要规则（必须遵守）：\n` +
    `- 两张图的姿势/动作/表情/朝向/镜头角度必然不同，这是需求本身，严禁因姿势不同而扣分。\n` +
    `- 背景差异（绿幕 vs 纯色 vs 场景）不扣分，只看角色本体。\n` +
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
  candidateImageDataUrl
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
          { role: 'system', content: buildPoseReviewInstructions({ characterName }) },
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
  candidateImageDataUrl
}) {
  const url = `${asStr(baseUrl).trim().replace(/\/+$/, '')}/chat/completions`
  const reviewModel = asStr(model).trim() || 'gemma-4-26b-a4b-it-4bit'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)
  try {
    // 本地 VL 评审经 control 资源调度器 vision 租约准入（与 LLM/出图互斥换入换出）
    // 2026-09-16 修复：响应体消费必须留在租约内——fetch 在响应头到达即 resolve，
    // 此前租约提前释放 → 调度器 settle 换回 LLM → gemma 生成中途被卸载 → 180s 空响应。
    const { res, json } = await withResourceLease('vision', `gs:pose_review:${asStr(characterName) || '-'}`, async () => {
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
            { role: 'system', content: buildPoseReviewInstructions({ characterName }) },
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
