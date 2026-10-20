import { extractResponseOutputText, openaiResponsesJsonForTools, parseModelJsonLenient } from './openai.js'
import { generateStrictJsonViaDoubaoChat } from './doubao.js'
import { generateStrictJsonViaOllamaChat, generateTextViaOllamaChat } from './ollama.js'

function clampInt(n, min, max, fallback) {
  const x = Number(n)
  if (!Number.isFinite(x)) return fallback
  return Math.max(min, Math.min(max, Math.floor(x)))
}

function normalizeTranslation(result) {
  const safe = result && typeof result === 'object' ? result : {}
  return {
    translatedText: String(safe.translatedText || '').trim(),
    sourceLanguage: String(safe.sourceLanguage || '').trim() || 'auto',
    targetLanguage: String(safe.targetLanguage || '').trim() || 'en'
  }
}

function validateTranslation(result) {
  const x = normalizeTranslation(result)
  return Boolean(x.translatedText)
}

function translationSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      translatedText: { type: 'string', minLength: 1, maxLength: 4000 },
      sourceLanguage: { type: 'string', maxLength: 16 },
      targetLanguage: { type: 'string', maxLength: 16 }
    },
    required: ['translatedText', 'sourceLanguage', 'targetLanguage']
  }
}

export async function translatePromptText({ provider, model, apiUrl, proxyUrl, timeoutMs, text, sourceLang, targetLang, mode }) {
  const p = String(provider || '').trim().toLowerCase()
  const t = clampInt(timeoutMs, 5_000, 180_000, 60_000)
  const src = String(sourceLang || 'auto').trim().toLowerCase() || 'auto'
  const target = String(targetLang || 'en').trim().toLowerCase() || 'en'
  const promptMode = String(mode || 'prompt').trim().toLowerCase() === 'plain' ? 'plain' : 'prompt'
  const schema = translationSchema()

  const instructions =
    `你是一个中英文提示词翻译助手。\n` +
    `任务：把输入文本从源语言翻译为目标语言，并输出严格 JSON。\n` +
    `要求：\n` +
    `- 只输出一个 JSON 对象，不要输出解释。\n` +
    `- 如果 mode=prompt：保持生图提示词风格，尽量保留逗号分隔的短语、材质/镜头/风格词、LoRA 或模型相关 token，不要扩写成散文。\n` +
    `- 如果 mode=plain：正常准确翻译，但保持简洁。\n` +
    `- 不要无端新增内容，不要删除明显的视觉约束。\n`

  const input = JSON.stringify({ text: String(text || ''), sourceLang: src, targetLang: target, mode: promptMode }, null, 2)

  if (p === 'openai' || p === 'localoxml') {
    const body = {
      instructions,
      input,
      max_output_tokens: 2048, // 2026-08-26：翻译输出短，封顶以压 OMLX KV 预留（默认 8192 会撞内存护栏）
      ...(model ? { model: String(model).trim() } : {}),
      text: { format: { type: 'json_schema', name: 'prompt_translation', strict: true, schema } }
    }
    // 2026-10-18：先宽松解析（模型偶尔在 JSON 外裹说明文字/围栏），仍无有效译文再退纯文本翻译——
    // 短名词短语（如"手持梨"）严格 schema 实测偶发 invalid_translation_response，不该让锚点翻译整体陪葬
    // （孔融兄弟载体锚点中文残留事故）。
    const { json, meta } = await openaiResponsesJsonForTools({ body, provider: p, apiUrl, proxyUrl, timeoutMs: t })
    const outText = String(extractResponseOutputText(json) || '')
    let parsedLenient = null
    try { parsedLenient = parseModelJsonLenient(outText) } catch { /* 落到纯文本兜底 */ }
    if (parsedLenient) {
      const result = normalizeTranslation(parsedLenient)
      if (validateTranslation(result)) return { result, meta }
    }
    const plainInstructions =
      `你是一个中英文翻译助手。\n` +
      `任务：把输入文本从源语言翻译为目标语言。\n` +
      `要求：\n` +
      `- 只输出翻译结果本身，不要 JSON，不要解释，不要引号。\n` +
      `- 如果 mode=prompt：保持提示词短语风格，不扩写成句子。\n`
    const plainBody = {
      instructions: plainInstructions,
      input,
      max_output_tokens: 2048,
      ...(model ? { model: String(model).trim() } : {})
    }
    const { json: plainJson, meta: plainMeta } = await openaiResponsesJsonForTools({ body: plainBody, provider: p, apiUrl, proxyUrl, timeoutMs: t })
    const plainText = String(extractResponseOutputText(plainJson) || '').trim().replace(/^["'「」]+|["'「」]+$/g, '').trim()
    const result = normalizeTranslation({ translatedText: plainText, sourceLanguage: src, targetLanguage: target })
    if (!validateTranslation(result)) throw new Error('invalid_translation_response')
    return { result, meta: { ...plainMeta, note: 'plain_text_fallback' } }
  }

  if (p === 'doubao') {
    const { parsed, meta } = await generateStrictJsonViaDoubaoChat({
      instructions,
      input,
      model: model || undefined,
      timeoutMs: t,
      maxRetries: 2,
      validate: validateTranslation,
      proxyUrl
    })
    const result = normalizeTranslation(parsed)
    if (!validateTranslation(result)) throw new Error('invalid_translation_response')
    return { result, meta }
  }

  if (p === 'ollama') {
    try {
      const { parsed, meta } = await generateStrictJsonViaOllamaChat({
        instructions,
        input,
        model: model || undefined,
        timeoutMs: t,
        maxRetries: 1,
        think: false,
        validate: validateTranslation,
        proxyUrl
      })
      const result = normalizeTranslation(parsed)
      if (!validateTranslation(result)) throw new Error('invalid_translation_response')
      return { result, meta }
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err || '')
      if (!/invalid_json|ollama_invalid_json_output/i.test(message)) throw err
      const fallbackInstructions =
        `你是一个中英文翻译助手。\n` +
        `任务：把输入文本从源语言翻译为目标语言。\n` +
        `要求：\n` +
        `- 只输出翻译结果本身，不要 JSON，不要解释，不要引号。\n` +
        `- 如果 mode=prompt：保持提示词短语风格，不扩写成句子。\n` +
        `- 保留 LoRA、模型名、尺寸、材质词和逗号分隔结构。\n`
      const { text: translatedText, meta } = await generateTextViaOllamaChat({
        instructions: fallbackInstructions,
        input,
        model: model || undefined,
        timeoutMs: t,
        proxyUrl,
        think: false
      })
      const result = normalizeTranslation({ translatedText, sourceLanguage: src, targetLanguage: target })
      if (!validateTranslation(result)) throw err
      return { result, meta: { ...meta, note: 'plain_text_fallback' } }
    }
  }

  const e = new Error(`unsupported_provider:${p || 'none'}`)
  e.status = 400
  throw e
}
