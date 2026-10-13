import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildStoryAssetReferenceNegativePrompt, buildStoryAssetReferencePrompt } from './storyAssets.js'
import { extractResponseOutputText, openaiResponsesJsonForTools } from './openai.js'
import { withResourceLease } from './resourceLease.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const WORKFLOW_TEMPLATE_PATH = path.resolve(__dirname, '../../workflows/comfyui_story_lock_test_template.json')

function asObj(v) {
  return v && typeof v === 'object' ? v : {}
}

function asList(v) {
  return Array.isArray(v) ? v : []
}

function asStr(v) {
  return typeof v === 'string' ? v : ''
}

function clampInt(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.floor(v)))
}

function clampFloat(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, v))
}

function normalizePromptParts(parts, max = 80) {
  const out = []
  const seen = new Set()
  for (const part of parts) {
    const value = asStr(part).trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= max) break
  }
  return out
}

function splitCsvLike(input) {
  return asStr(input)
    .split(/[,\n，、|]/g)
    .map((x) => x.trim())
    .filter(Boolean)
}

export function pickStoryboardLockTestAsset(plan) {
  const assets = asList(plan && plan.assets)
  const unlocked = (asset) => !asStr(asset && asset.primaryReferenceAssetUri).trim()
  return (
    // 优先选第一个未锁定的 ref_required 角色，避免重复锁定已完成的资产
    assets.find((asset) => unlocked(asset) && asStr(asset && asset.category).trim() === 'character' && asStr(asset && asset.renderStrategy).trim() === 'ref_required') ||
    assets.find((asset) => unlocked(asset) && asStr(asset && asset.renderStrategy).trim() === 'ref_required') ||
    assets.find((asset) => unlocked(asset) && asStr(asset && asset.category).trim() === 'character') ||
    assets.find((asset) => asStr(asset && asset.category).trim() === 'character' && asStr(asset && asset.renderStrategy).trim() === 'ref_required') ||
    assets.find((asset) => asStr(asset && asset.renderStrategy).trim() === 'ref_required') ||
    assets[0] ||
    null
  )
}

export function buildStoryboardLockTestPrompt({ plan, asset, style }) {
  const prompt = buildStoryAssetReferencePrompt({ plan, asset, style })
  return normalizePromptParts([
    ...splitCsvLike(prompt),
    'single subject lock test',
    'centered composition',
    'full silhouette',
    'clean background',
    'consistent design language',
    asStr(asset && asset.category).trim() === 'character' ? 'single character portrait reference' : '',
    asStr(asset && asset.category).trim() === 'prop' ? 'single object reference' : '',
    asStr(asset && asset.category).trim() === 'location' ? 'single location reference' : ''
  ]).join(', ')
}

export function buildStoryboardLockTestNegativePrompt({ plan, asset }) {
  const negative = buildStoryAssetReferenceNegativePrompt({ plan, asset })
  return normalizePromptParts([
    ...splitCsvLike(negative),
    'busy background',
    'multiple subjects',
    'multiple views',
    'turnaround sheet',
    'reference sheet',
    'multi-view sheet',
    'collage',
    'front and back views',
    'three views',
    'text',
    'watermark',
    'logo',
    'photorealistic'
  ], 120).join(', ')
}

async function readWorkflowTemplate() {
  const raw = await readFile(WORKFLOW_TEMPLATE_PATH, 'utf-8')
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid_story_lock_workflow_template')
  return parsed
}

function nextNodeId(workflow) {
  return Math.max(...Object.keys(workflow).map((x) => Number(x)).filter(Number.isFinite))
}

export async function buildStoryboardLockTestWorkflow({
  model,
  loras,
  positivePrompt,
  negativePrompt,
  width,
  height,
  steps,
  cfgScale,
  samplerName,
  scheduler,
  seed,
  filenamePrefix
}) {
  const workflow = await readWorkflowTemplate()
  workflow['1'].inputs.ckpt_name = asStr(model).trim()
  workflow['2'].inputs.width = clampInt(width, 256, 2048, 512)
  workflow['2'].inputs.height = clampInt(height, 256, 2048, 512)
  workflow['3'].inputs.text = asStr(positivePrompt).trim()
  workflow['4'].inputs.text = asStr(negativePrompt).trim()
  workflow['5'].inputs.steps = clampInt(steps, 5, 80, 20)
  workflow['5'].inputs.cfg = clampFloat(cfgScale, 1, 20, 7)
  workflow['5'].inputs.sampler_name = asStr(samplerName).trim() || 'dpmpp_2m'
  workflow['5'].inputs.scheduler = asStr(scheduler).trim() || 'normal'
  workflow['5'].inputs.seed = clampInt(seed, 0, 4294967295, Math.floor(Math.random() * 4_294_967_296))
  workflow['7'].inputs.filename_prefix = asStr(filenamePrefix).trim() || 'gamestudio_lock_test'

  const normalizedLoras = asList(loras)
    .map((item) => {
      const raw = asStr(item).trim()
      if (!raw) return null
      const parts = raw.split(':').map((x) => x.trim()).filter(Boolean)
      const name = asStr(parts[0]).trim()
      if (!name) return null
      const strengthModel = clampFloat(parts.length >= 2 ? parts[1] : 0.8, 0, 2, 0.8)
      const strengthClip = clampFloat(parts.length >= 3 ? parts[2] : strengthModel, 0, 2, strengthModel)
      return { name, strengthModel, strengthClip }
    })
    .filter(Boolean)

  if (!normalizedLoras.length) return workflow

  let currentModelRef = ['1', 0]
  let currentClipRef = ['1', 1]
  let nid = nextNodeId(workflow) + 1
  for (const lora of normalizedLoras) {
    const id = String(nid++)
    workflow[id] = {
      class_type: 'LoraLoader',
      inputs: {
        model: currentModelRef,
        clip: currentClipRef,
        lora_name: lora.name,
        strength_model: lora.strengthModel,
        strength_clip: lora.strengthClip
      }
    }
    currentModelRef = [id, 0]
    currentClipRef = [id, 1]
  }
  workflow['3'].inputs.clip = currentClipRef
  workflow['4'].inputs.clip = currentClipRef
  workflow['5'].inputs.model = currentModelRef
  return workflow
}

function storyLockReviewSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      passed: { type: 'boolean' },
      score: { type: 'integer', minimum: 0, maximum: 100 },
      summary: { type: 'string', minLength: 1, maxLength: 300 },
      issues: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 160 } },
      revisedPrompt: { type: 'string', minLength: 1, maxLength: 4000 },
      revisedNegativePrompt: { type: 'string', minLength: 1, maxLength: 3000 }
    },
    required: ['passed', 'score', 'summary', 'issues', 'revisedPrompt', 'revisedNegativePrompt']
  }
}

function validateStoryLockReview(obj) {
  if (!obj || typeof obj !== 'object') return false
  if (typeof obj.passed !== 'boolean') return false
  if (!Number.isFinite(Number(obj.score))) return false
  if (!asStr(obj.summary).trim()) return false
  if (!Array.isArray(obj.issues)) return false
  // 通过（passed=true）时模型通常不返回修订 prompt，允许为空；
  // 未通过（passed=false）时 revisedPrompt/revisedNegativePrompt 必须可直接用于重试
  if (obj.passed === false) {
    if (!asStr(obj.revisedPrompt).trim()) return false
    if (!asStr(obj.revisedNegativePrompt).trim()) return false
  }
  return true
}

function buildLockReviewInstructions({ asset, attempt, maxAttempts }) {
  const name = asStr(asset && asset.name).trim() || '目标资产'
  const category = asStr(asset && asset.category).trim() || 'asset'
  const lockProfile = asStr(asset && asset.lockProfile).trim() || 'generic_asset'
  const anchorPrompt = asStr(asset && asset.anchorPrompt).trim()
  const hint = asStr(asset && asset.referencePromptHint).trim()
  const forbidden = asList(asset && asset.forbiddenSubstitutes).map((x) => asStr(x).trim()).filter(Boolean)
  return (
    `你是儿童故事连续场景的“锁定测试审核器”。\n` +
    `当前任务：判断一张测试图是否已经足够适合作为后续连续场景的锁定参考。\n` +
    `审核对象：${name}（category=${category}, lockProfile=${lockProfile}）。\n` +
    `当前是第 ${attempt} / ${maxAttempts} 轮测试。\n` +
    `通过标准（硬门槛）：\n` +
    `- 必须是单主体，不能出现多个对象/多个角色/成套展示/多视图。\n` +
    `- 必须清晰、完整、主体明确，不能被裁切得难以复用。\n` +
    `- 背景要尽量干净，便于作为锁定参考。\n` +
    `- 如果是角色：身份必须稳定，物种/脸型/关键特征正确，不能退化成“人脸+动物耳朵”或“狗代替狼”。\n` +
    `次要细节（不判失败）：\n` +
    `- 服装配色、内搭颜色、局部纹理等次要细节与描述有差异时，只要身份与整体风格一致、可复用，不要仅因此判失败；可在 issues 中标注但 passed 仍可为 true、score 不因单一配色细节低于 70。\n` +
    `- 是否戴帽/手持小物：若目标描述未强制要求，缺失不判失败。\n` +
    `严格失败项：\n` +
    `- 如果是道具：重点检查是否只有一个主道具，外形是否稳定，不能混入人物手持或场景杂物。\n` +
    `- 如果 lockProfile=wearable_prop：重点检查是否为“独立未佩戴物件”，不得出现头部、头模、人物、手持、穿戴关系。\n` +
    `- 如果 lockProfile=slender_prop：重点检查是否全长完整可见，不能裁切两端，不能过度弯折或透视缩短。\n` +
    `- 如果 lockProfile=rigid_prop：重点检查主体结构是否稳定完整，不能变形塌陷，主要部件必须清楚。\n` +
    `- 如果 lockProfile=ambient_prop：重点检查是否为单个氛围元素，而不是整张大场景。\n` +
    `- 如果 lockProfile=organic_prop：重点检查是否为单个自然物/标本，而不是栖息地场景插画。\n` +
    `- 如果是地点：重点检查是否构图稳定、环境语言统一，不能混入主体角色特写。\n` +
    `- 明显跑题（目标身份/物种/场景错误）必须判失败。\n` +
    `目标锚点：${anchorPrompt || '无'}\n` +
    `参考提示：${hint || '无'}\n` +
    `禁止替代：${forbidden.length ? forbidden.join(' / ') : '无'}\n` +
    `输出要求：\n` +
    `- 只输出 JSON，不要解释文字。\n` +
    `- passed=true 只在你确认已经能进入后续正式出图时使用。\n` +
    `- 如果不通过，revisedPrompt 必须是可直接重试的新提示词；revisedNegativePrompt 也必须可直接使用。\n`
  )
}

function extractJsonObjectString(raw) {
  let text = asStr(raw).trim()
  // 剥离 markdown 代码围栏（Kimi 可能输出 ```json ... ```）
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return text
  return text.slice(start, end + 1)
}

// 规范化 Kimi 评审输出的字段名差异（reason→summary、problems→issues、analysis→summary 等）
function normalizeStoryLockReviewOutput(obj, { prompt, negativePrompt }) {
  if (!obj || typeof obj !== 'object') return obj
  const normalized = { ...obj }
  if (!asStr(normalized.summary).trim()) {
    normalized.summary = asStr(normalized.reason || normalized.analysis || normalized.conclusion || normalized.comment || '').trim()
  }
  if (!Array.isArray(normalized.issues)) {
    const alt = normalized.problems || normalized.errors || normalized.issue || normalized.concerns
    normalized.issues = Array.isArray(alt) ? alt : (alt ? [String(alt)] : [])
  }
  // summary 为空时从 issues[0] 或默认值填充，保证评审可用
  if (!asStr(normalized.summary).trim()) {
    normalized.summary = asStr(normalized.issues[0] || (normalized.passed === false ? '视觉评审未通过，需人工复核' : '视觉评审通过')).trim()
  }
  // Kimi 有时省略 score；按 passed 与 issues 数量兜底
  if (!Number.isFinite(Number(normalized.score))) {
    if (normalized.passed === true) {
      normalized.score = 80
    } else {
      const n = Array.isArray(normalized.issues) ? normalized.issues.length : 0
      normalized.score = Math.max(0, 50 - n * 10)
    }
  }
  if (normalized.passed === true) {
    normalized.revisedPrompt = asStr(normalized.revisedPrompt).trim() || asStr(prompt).trim()
    normalized.revisedNegativePrompt = asStr(normalized.revisedNegativePrompt).trim() || asStr(negativePrompt).trim()
  }
  return normalized
}

// P1-B04：用 Kimi(moonshot) 视觉能力评审锁定测试图。
// 本地 OMLX 不支持图像输入，Kimi(kimi-for-coding) 支持 image_url 视觉输入，
// 且 temperature=1 是该模型唯一允许值。
async function reviewStoryboardLockImageWithMoonshot({
  apiKey,
  baseUrl,
  model,
  asset,
  prompt,
  negativePrompt,
  imageDataUrl,
  attempt,
  maxAttempts
}) {
  const instructions = buildLockReviewInstructions({ asset, attempt, maxAttempts })
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
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: reviewModel,
        messages: [
          { role: 'system', content: `${instructions}\n\n重要：只输出一个合法 JSON 对象，不要 markdown 代码块，不要任何额外文字。` },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  `请审核这张锁定测试图是否通过。\n` +
                  `当前正向提示词：${asStr(prompt).trim()}\n` +
                  `当前负向提示词：${asStr(negativePrompt).trim()}`
              },
              { type: 'image_url', image_url: { url: asStr(imageDataUrl).trim() } }
            ]
          }
        ],
        max_tokens: 8000,
        temperature: 1
      })
    })
    const json = await res.json().catch(() => null)
    if (!res.ok) {
      throw new Error(json?.error?.message || `moonshot_http_${res.status}`)
    }
    const content = asStr(json?.choices?.[0]?.message?.content).trim()
    let parsed
    try {
      parsed = normalizeStoryLockReviewOutput(JSON.parse(extractJsonObjectString(content) || '{}'), { prompt, negativePrompt })
    } catch (parseErr) {
      console.log(`[story.lock.review][debug] provider=moonshot branch=moonshot PARSE_ERROR=${parseErr.message} content_head=${content.slice(0, 120).replace(/\n/g, ' ')}`)
      throw new Error('invalid_story_lock_review_output')
    }
    if (!validateStoryLockReview(parsed)) {
      console.log(`[story.lock.review][debug] provider=moonshot branch=moonshot VALIDATE_FAIL keys=${Object.keys(parsed || {}).join(',')} summary=${String(parsed?.summary || '').slice(0, 40)} passed=${parsed?.passed}`)
      throw new Error('invalid_story_lock_review_output')
    }
    return { ...parsed, meta: { provider: 'moonshot', api: 'chat.completions', model: reviewModel } }
  } finally {
    clearTimeout(timeout)
  }
}

// 2026-10-12 本地 VL 评审通道（gemma-4-26b-a4b-it-4bit 经 OMLX 多模态）。
// 与姿势评审 local_vl 同款：vision 租约准入（与 LLM/出图互斥换入换出）、响应体消费留在租约内、
// 有限 max_tokens 防 KV 护栏；同一套评审指令与 JSON 契约，评分语义与 moonshot 路径一致。
async function reviewStoryboardLockImageWithLocalVl({
  baseUrl,
  apiKey,
  model,
  asset,
  prompt,
  negativePrompt,
  imageDataUrl,
  attempt,
  maxAttempts
}) {
  const instructions = buildLockReviewInstructions({ asset, attempt, maxAttempts })
  const reviewModel = asStr(model).trim() || 'gemma-4-26b-a4b-it-4bit'
  const url = `${asStr(baseUrl).trim().replace(/\/+$/, '') || 'http://127.0.0.1:18888/v1'}/chat/completions`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)
  try {
    const { res, json } = await withResourceLease('vision', `gs:lock_review:${asStr(asset && asset.id) || '-'}`, async () => {
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
            { role: 'system', content: `${instructions}\n\n重要：只输出一个合法 JSON 对象，不要 markdown 代码块，不要任何额外文字。` },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text:
                    `请审核这张锁定测试图是否通过。\n` +
                    `当前正向提示词：${asStr(prompt).trim()}\n` +
                    `当前负向提示词：${asStr(negativePrompt).trim()}`
                },
                { type: 'image_url', image_url: { url: asStr(imageDataUrl).trim() } }
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
    if (!res.ok) {
      throw new Error(json?.error?.message || `local_vl_http_${res.status}`)
    }
    const content = asStr(json?.choices?.[0]?.message?.content).trim()
    const parsed = normalizeStoryLockReviewOutput(JSON.parse(extractJsonObjectString(content) || '{}'), { prompt, negativePrompt })
    if (!validateStoryLockReview(parsed)) throw new Error('invalid_story_lock_review_output')
    return { ...parsed, meta: { provider: 'local_vl', api: 'omlx.chat.completions', model: reviewModel } }
  } finally {
    clearTimeout(timeout)
  }
}

export async function reviewStoryboardLockImageWithAi({
  provider,
  model,
  apiUrl,
  proxyUrl,
  asset,
  prompt,
  negativePrompt,
  imageDataUrl,
  attempt,
  maxAttempts,
  moonshotApiKey,
  moonshotBaseUrl
}) {
  const p = asStr(provider).trim().toLowerCase()
  console.log(`[story.lock.review][debug] entry provider=${p} moonshotKeySet=${Boolean(moonshotApiKey)}`)
  if (p === 'moonshot') {
    try {
      return await reviewStoryboardLockImageWithMoonshot({
        apiKey: moonshotApiKey,
        baseUrl: moonshotBaseUrl,
        model,
        asset,
        prompt,
        negativePrompt,
        imageDataUrl,
        attempt,
        maxAttempts
      })
    } catch (error) {
      const detail = asStr(error && error.message).trim() || 'visual_review_failed'
      // 2026-10-12 Kimi 配额兜底：moonshot 评审失败（配额/网络/超时）时自动回退本地 VL
      // （gemma-4-26b-a4b-it-4bit 经 OMLX，vision 租约互斥换入），与姿势评审的 local_vl 通道同款。
      // 本地也失败才返回评审失败——S4-01 门禁语义不变（假通过依然禁止写入主参考）。
      try {
        const fallback = await reviewStoryboardLockImageWithLocalVl({
          baseUrl: process.env.HERMES_VISION_BASE_URL || process.env.LOCALOXML_BASE_URL || apiUrl,
          apiKey: process.env.LOCALOXML_API_KEY || process.env.OPENAI_API_KEY || '',
          model: process.env.HERMES_VISION_MODEL || '',
          asset,
          prompt,
          negativePrompt,
          imageDataUrl,
          attempt,
          maxAttempts
        })
        console.log(`[story.lock.review] moonshot 失败已回退本地 VL 评审：${detail} -> local_vl passed=${fallback?.passed}`)
        return { ...fallback, fallbackFrom: 'moonshot', fallbackReason: detail }
      } catch (fallbackError) {
        const fallbackDetail = asStr(fallbackError && fallbackError.message).trim() || 'local_vl_failed'
        return {
          passed: false,
          score: 0,
          summary: `锁定测试图已生成，但视觉评审失败（Kimi 与本地 VL 均不可用），需人工复核。原因：${detail}；本地回退：${fallbackDetail}`,
          issues: ['visual_review_failed', detail, `local_vl_fallback: ${fallbackDetail}`],
          revisedPrompt: asStr(prompt).trim(),
          revisedNegativePrompt: asStr(negativePrompt).trim(),
          skipped: true,
          reviewError: detail
        }
      }
    }
  }
  if (p !== 'openai' && p !== 'localoxml') {
    return {
      passed: true,
      score: 60,
      summary: '未启用视觉判定，已生成测试图，请人工确认。',
      issues: ['visual_review_unavailable'],
      revisedPrompt: asStr(prompt).trim(),
      revisedNegativePrompt: asStr(negativePrompt).trim(),
      skipped: true
    }
  }

  const body = {
    ...(model ? { model: asStr(model).trim() } : {}),
    instructions: buildLockReviewInstructions({ asset, attempt, maxAttempts }),
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              `请审核这张锁定测试图是否通过。\n` +
              `当前正向提示词：${asStr(prompt).trim()}\n` +
              `当前负向提示词：${asStr(negativePrompt).trim()}`
          },
          {
            type: 'input_image',
            image_url: asStr(imageDataUrl).trim()
          }
        ]
      }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'story_lock_review',
        strict: true,
        schema: storyLockReviewSchema()
      }
    }
  }

  try {
    const { json, meta } = await openaiResponsesJsonForTools({ body, provider: p, apiUrl, proxyUrl, model, timeoutMs: 90_000 })
    const parsed = JSON.parse(extractResponseOutputText(json) || '{}')
    if (!validateStoryLockReview(parsed)) throw new Error('invalid_story_lock_review_output')
    return { ...parsed, meta }
  } catch (error) {
    const detail = asStr(error && error.message).trim() || 'visual_review_failed'
    return {
      passed: false,
      score: 0,
      summary: `锁定测试图已生成，但视觉评审失败，需人工复核。原因：${detail}`,
      issues: ['visual_review_failed', detail],
      revisedPrompt: asStr(prompt).trim(),
      revisedNegativePrompt: asStr(negativePrompt).trim(),
      skipped: true,
      reviewError: detail
    }
  }
}
