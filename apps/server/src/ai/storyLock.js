import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildStoryAssetReferenceNegativePrompt, buildStoryAssetReferencePrompt } from './storyAssets.js'
import { extractResponseOutputText, openaiResponsesJsonForTools } from './openai.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const WORKFLOW_TEMPLATE_PATH = path.resolve(__dirname, '../workflows/comfyui_story_lock_test_template.json')

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
  return (
    assets.find((asset) => asStr(asset && asset.category).trim() === 'character' && asStr(asset && asset.renderStrategy).trim() === 'ref_required') ||
    assets.find((asset) => asStr(asset && asset.renderStrategy).trim() === 'ref_required') ||
    assets.find((asset) => asStr(asset && asset.category).trim() === 'character') ||
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
  workflow['5'].inputs.seed = clampInt(seed, 0, 4294967295, Math.floor(Math.random() * 9_999_999_999))
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
  return Boolean(
    obj &&
    typeof obj === 'object' &&
    typeof obj.passed === 'boolean' &&
    Number.isFinite(Number(obj.score)) &&
    asStr(obj.summary).trim() &&
    Array.isArray(obj.issues) &&
    asStr(obj.revisedPrompt).trim() &&
    asStr(obj.revisedNegativePrompt).trim()
  )
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
    `通过标准：\n` +
    `- 必须是单主体，不能出现多个对象/多个角色/成套展示。\n` +
    `- 必须清晰、完整、主体明确，不能被裁切得难以复用。\n` +
    `- 必须符合目标资产描述，不能明显跑题。\n` +
    `- 背景要尽量干净，便于作为锁定参考。\n` +
    `- 如果是角色：重点检查是否身份稳定、物种/脸型/服装/关键特征正确，不能退化成“人脸+动物耳朵”。\n` +
    `- 如果是道具：重点检查是否只有一个主道具，外形是否稳定，不能混入人物手持或场景杂物。\n` +
    `- 如果 lockProfile=wearable_prop：重点检查是否为“独立未佩戴物件”，不得出现头部、头模、人物、手持、穿戴关系。\n` +
    `- 如果 lockProfile=slender_prop：重点检查是否全长完整可见，不能裁切两端，不能过度弯折或透视缩短。\n` +
    `- 如果 lockProfile=rigid_prop：重点检查主体结构是否稳定完整，不能变形塌陷，主要部件必须清楚。\n` +
    `- 如果 lockProfile=ambient_prop：重点检查是否为单个氛围元素，而不是整张大场景。\n` +
    `- 如果 lockProfile=organic_prop：重点检查是否为单个自然物/标本，而不是栖息地场景插画。\n` +
    `- 如果是地点：重点检查是否构图稳定、环境语言统一，不能混入主体角色特写。\n` +
    `- 如果没有达到“可直接进入正式场景出图”的水平，就不要判通过。\n` +
    `目标锚点：${anchorPrompt || '无'}\n` +
    `参考提示：${hint || '无'}\n` +
    `禁止替代：${forbidden.length ? forbidden.join(' / ') : '无'}\n` +
    `输出要求：\n` +
    `- 只输出 JSON，不要解释文字。\n` +
    `- passed=true 只在你确认已经能进入后续正式出图时使用。\n` +
    `- 如果不通过，revisedPrompt 必须是可直接重试的新提示词；revisedNegativePrompt 也必须可直接使用。\n`
  )
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
  maxAttempts
}) {
  const p = asStr(provider).trim().toLowerCase()
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

  const { json, meta } = await openaiResponsesJsonForTools({ body, provider: p, apiUrl, proxyUrl, model, timeoutMs: 90_000 })
  const parsed = JSON.parse(extractResponseOutputText(json) || '{}')
  if (!validateStoryLockReview(parsed)) throw new Error('invalid_story_lock_review_output')
  return { ...parsed, meta }
}
