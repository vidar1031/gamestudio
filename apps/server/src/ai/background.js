import { spawn } from 'node:child_process'
import { getProxyUrl } from '../net/proxy.js'
import { generateImageViaDoubaoArkImages } from './doubao.js'

/*
  apps/server/src/ai/background.js

// 根据 content-type 猜测文件扩展名（默认 png）。用于从下载响应中选择合适的后缀。


  说明：该模块负责根据不同后端提供者（例如 sdwebui 或 doubao）生成背景图像，
  并包含若干辅助函数用于发起 HTTP 请求（通过 curl 子进程）、下载二进制数据、
  以及对输入参数（尺寸、步数等）做边界裁剪与默认值选择。

  主要导出函数：
  - `generateBackgroundImage(input)`：入口，根据 `input.provider` 选择不同实现返回图片 bytes。

  错误处理：
  - 大量使用抛出 Error 并设置 `status` 字段来为上层路由提供 HTTP 语义化状态码。
*/

function clampInt(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.floor(v)))
}

function normalizeSdwebuiBaseUrl(raw) {
  let s = String(raw || '').trim()
  if (!s) s = String(process.env.SDWEBUI_BASE_URL || 'http://127.0.0.1:7860')
  s = s.replace(/\/+$/, '')
  // Allow users to input either host root or /sdapi/v1 endpoint.
  s = s.replace(/\/sdapi\/v1$/i, '')
  return s || 'http://127.0.0.1:7860'
}

function normalizeComfyuiBaseUrl(raw) {
  let s = String(raw || '').trim()
  if (!s) s = String(process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188')
  s = s.replace(/\/+$/, '')
  return s || 'http://127.0.0.1:8188'
}

function normalizeComfyCheckpointName(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  // SDWebUI 常见展示名：xxx.safetensors [hash]
  // ComfyUI 的 CheckpointLoaderSimple 需要纯文件名：xxx.safetensors
  return s.replace(/\s+\[[^\]]+\]\s*$/, '').trim()
}

function explainRemoteError(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'object') {
    const obj = v
    const msg = obj.message || obj.type || obj.error || obj.detail || ''
    if (typeof msg === 'string' && msg.trim()) return msg.trim()
    try { return JSON.stringify(obj) } catch (_) { return String(obj) }
  }
  return String(v)
}

function splitCsvLike(s) {
  return String(s || '')
    .split(/[,\n，、]+/g)
    .map((x) => x.trim())
    .filter(Boolean)
}

function uniqPhrases(parts) {
  const out = []
  const seen = new Set()
  for (const p of parts) {
    const key = String(p || '').trim().toLowerCase()
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    out.push(String(p || '').trim())
  }
  return out
}

function cleanupAnchorNoise(s) {
  const parts = splitCsvLike(String(s || ''))
  // Keep one WORLD_ANCHOR / ROLE_DEFINITION block at most to reduce repeated injection.
  let anchorKept = false
  let roleKept = false
  const cleaned = []
  for (const p0 of parts) {
    const p = String(p0 || '').trim()
    if (!p) continue
    if (/^WORLD_ANCHOR\s*:/i.test(p)) {
      if (anchorKept) continue
      anchorKept = true
      cleaned.push(p)
      continue
    }
    if (/^ROLE_DEFINITION\s*:/i.test(p)) {
      if (roleKept) continue
      roleKept = true
      cleaned.push(p)
      continue
    }
    cleaned.push(p)
  }
  return uniqPhrases(cleaned).join(', ')
}

function sdStyleProfile(style) {
  const s = String(style || '').trim().toLowerCase()
  if (s === 'cartoon') {
    return {
      pos: 'cartoon illustration, cel shading, bold clean outlines, simplified shapes, stylized character design, non-photorealistic',
      neg: 'photorealistic, realistic skin texture, pores, DSLR photo, cinematic photo, 3d render'
    }
  }
  if (s === 'national_style') {
    return {
      pos: 'Chinese guofeng illustration, ink-and-wash inspired, painterly stylization, elegant brush texture, non-photorealistic',
      neg: 'photorealistic, modern photo look, realistic skin texture, DSLR photo, 3d render'
    }
  }
  if (s === 'watercolor') {
    return {
      pos: 'watercolor illustration, soft brush strokes, paper texture, hand-painted feeling, non-photorealistic',
      neg: 'photorealistic, hard-edged photo texture, realistic skin pores, DSLR photo, 3d render'
    }
  }
  // picture_book default
  return {
    pos: "children's picture book illustration, hand-painted storybook style, soft edges, stylized forms, non-photorealistic",
    neg: 'photorealistic, realistic face, skin texture pores, DSLR photo, cinematic photo, 3d render'
  }
}

function buildSdwebuiPromptAndNegative({ prompt, negativePrompt, style }) {
  const prof = sdStyleProfile(style)
  const pos = uniqPhrases([...splitCsvLike(cleanupAnchorNoise(prompt)), ...splitCsvLike(prof.pos)]).join(', ')
  const neg = uniqPhrases([...splitCsvLike(negativePrompt), ...splitCsvLike(prof.neg)]).join(', ')
  return { prompt: pos, negativePrompt: neg }
}

// 选择默认图片提供者：优先使用环境变量 `STUDIO_BG_PROVIDER`，否则默认为 `sdwebui`。
function pickProvider() {
  return String(process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()
}

// 使用本地 `curl` 发起 HTTP 请求并解析 JSON 响应。
// 特性：支持自定义 headers/body、超时、代理，并将 HTTP 状态解析为返回结果或 Error。
// 注意：依赖系统安装 curl。返回一个 Promise，解析为 JSON 对象或抛出带 `.status` 的 Error。
function curlRequestJson({ url, method, headers, body, timeoutMs, proxyUrl }) {
  const marker = '__CURL_STATUS__'
  const args = [
    '-sS',
    '-X',
    String(method || 'POST').toUpperCase(),
    '--max-time',
    String(Math.max(1, Math.ceil((Number(timeoutMs || 0) || 20000) / 1000))),
    ...(proxyUrl ? ['--proxy', String(proxyUrl)] : []),
    '-w',
    `\\n${marker}:%{http_code}\\n`,
    ...Object.entries(headers || {}).flatMap(([k, v]) => ['-H', `${k}: ${v}`])
  ]
  if (body != null) args.push('--data-binary', '@-')
  args.push(String(url))

  return new Promise((resolve, reject) => {
    const p = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []
    const errChunks = []

    const killTimer = setTimeout(() => {
      try { p.kill('SIGKILL') } catch (_) {}
    }, Math.max(1000, Number(timeoutMs || 0) || 20000) + 1000)

    p.stdout.on('data', (d) => chunks.push(d))
    p.stderr.on('data', (d) => errChunks.push(d))
    p.on('error', (e) => {
      clearTimeout(killTimer)
      reject(e)
    })
    p.on('close', (code) => {
      clearTimeout(killTimer)
      const out = Buffer.concat(chunks).toString('utf-8')
      const errText = Buffer.concat(errChunks).toString('utf-8')
      const idx = out.lastIndexOf(`${marker}:`)
      const statusStr = idx >= 0 ? out.slice(idx + marker.length + 1).trim().split(/\s+/)[0] : ''
      const status = statusStr ? Number(statusStr) : NaN
      const jsonText = idx >= 0 ? out.slice(0, idx).trim() : out.trim()

      if (!Number.isFinite(status)) {
        const e = new Error(`curl_no_status${errText ? `: ${errText.trim()}` : ''}`)
        e.code = code
        reject(e)
        return
      }
      if (status === 0) {
        const e = new Error(errText && errText.trim() ? `curl_transport_error: ${errText.trim()}` : 'curl_transport_error')
        e.status = 0
        e.code = code
        reject(e)
        return
      }
      let json = null
      try {
        json = jsonText ? JSON.parse(jsonText) : null
      } catch (e) {
        const err = new Error('invalid_json_response')
        err.status = status
        err.body = jsonText
        reject(err)
        return
      }
      if (status < 200 || status >= 300) {
        const msg =
          json && typeof json === 'object'
            ? (json.error && (json.error.message || json.error)) || json.message || JSON.stringify(json)
            : `HTTP ${status}`
        const e = new Error(String(msg))
        e.status = status
        e.body = json
        reject(e)
        return
      }
      resolve(json)
    })

    if (body != null) {
      try {
        p.stdin.write(typeof body === 'string' ? body : JSON.stringify(body))
      } catch (_) {}
    }
    try { p.stdin.end() } catch (_) {}
  })
}

function curlDownload({ url, timeoutMs, proxyUrl }) {
  // -D - dumps headers to stdout; we split on last header block.
  const args = [
    '-sS',
    '-L',
    '--max-time',
    String(Math.max(1, Math.ceil((Number(timeoutMs || 0) || 20000) / 1000))),
    ...(proxyUrl ? ['--proxy', String(proxyUrl)] : []),
    '-D',
    '-',
    String(url)
  ]
  return new Promise((resolve, reject) => {
    const p = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    const errChunks = []
    const killTimer = setTimeout(() => {
      try { p.kill('SIGKILL') } catch (_) {}
    }, Math.max(1000, Number(timeoutMs || 0) || 20000) + 1000)
    p.stdout.on('data', (d) => chunks.push(d))
    p.stderr.on('data', (d) => errChunks.push(d))
    p.on('error', (e) => {
      clearTimeout(killTimer)
      reject(e)
    })
    p.on('close', (code) => {
      clearTimeout(killTimer)
      if (code !== 0) {
        const errText = Buffer.concat(errChunks).toString('utf-8').trim()
        const e = new Error(errText ? `curl_download_failed: ${errText}` : 'curl_download_failed')
        e.code = code
        reject(e)
        return
      }
      const buf = Buffer.concat(chunks)
      // There may be multiple header blocks (redirects). Find the last \r\n\r\n boundary before body.
      const marker = Buffer.from('\r\n\r\n')
      let headerEnd = -1
      for (let i = 0; i < buf.length - marker.length; i++) {
        if (buf.slice(i, i + marker.length).equals(marker)) headerEnd = i + marker.length
      }
      if (headerEnd < 0) {
        resolve({ contentType: '', bytes: buf })
        return
      }
      const headerText = buf.slice(0, headerEnd).toString('utf-8')
      const bodyBytes = buf.slice(headerEnd)
      const m = headerText.match(/content-type:\\s*([^\\r\\n]+)/i)
      resolve({ contentType: m ? String(m[1]).trim() : '', bytes: bodyBytes })
    })
  })
}

function extFromContentType(ct) {
  const s = String(ct || '').toLowerCase()
  if (s.includes('image/png')) return 'png'
  if (s.includes('image/webp')) return 'webp'
  if (s.includes('image/jpeg') || s.includes('image/jpg')) return 'jpg'
  if (s.includes('image/gif')) return 'gif'
  return 'png'
}

// 入口函数：根据 `input.provider` 分发到不同的实现。
// 返回对象：{ bytes: Buffer, ext: 'png'|'jpg'|'webp', meta: { provider: 'doubao'|'sdwebui', ... } }
export async function generateBackgroundImage(input) {
  const provider = String(input && input.provider ? input.provider : pickProvider()).toLowerCase()
  if (provider === 'doubao') return generateBackgroundViaDoubao(input)
  if (provider === 'comfyui') return generateBackgroundViaComfyui(input)
  if (provider === 'sdwebui') return generateBackgroundViaSdWebui(input)
  const e = new Error(`unsupported_provider:${provider}`)
  e.status = 501
  throw e
}

// 使用 SD-WebUI 的 txt2img 接口生成图片：
// - 构造 payload，调用 /sdapi/v1/txt2img
// - 解析返回的 base64 图像数据并返回 Buffer
// - 在任何网络或解析错误时抛出带 `.status = 502` 的 Error
async function generateBackgroundViaSdWebui(input) {
  const baseUrl = normalizeSdwebuiBaseUrl(input && input.sdwebuiBaseUrl ? input.sdwebuiBaseUrl : process.env.SDWEBUI_BASE_URL)
  const apiUrl = `${baseUrl}/sdapi/v1/txt2img`
  const model = String(input && input.model ? input.model : '').trim()
  const timeoutMs = clampInt(input && input.timeoutMs != null ? input.timeoutMs : process.env.STUDIO_BG_TIMEOUT_MS, 5_000, 300_000, 180_000)
  const style = String(input && input.style ? input.style : '').trim()
  const cooked = buildSdwebuiPromptAndNegative({
    prompt: String(input.prompt || '').trim(),
    negativePrompt: String(input.negativePrompt || '').trim(),
    style
  })
  const payload = {
    prompt: String(cooked.prompt || '').trim(),
    negative_prompt: String(cooked.negativePrompt || '').trim() || undefined,
    width: clampInt(input.width, 64, 2048, 768),
    height: clampInt(input.height, 64, 2048, 1024),
    steps: clampInt(input.steps, 5, 50, 20),
    cfg_scale: (() => {
      const n = Number(input.cfgScale)
      return Number.isFinite(n) ? Math.max(1, Math.min(15, n)) : 7
    })(),
    sampler_name: String(input.sampler || 'DPM++ 2M'),
    scheduler: String(input.scheduler || 'Automatic')
  }
  if (model) {
    payload.override_settings = {
      sd_model_checkpoint: model
    }
    payload.override_settings_restore_afterwards = true
  }

  let json = null
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    json = await resp.json().catch(() => null)
    if (!resp.ok || !json || !Array.isArray(json.images) || !json.images[0]) {
      if (!resp.ok && Number(resp.status || 0) === 404) {
        const e = new Error(
          `sdwebui_txt2img_not_found: ${apiUrl} (请确认 7860 是 A1111/Forge，并使用 --api 启动；若是 ComfyUI，请改用 ComfyUI 接口)`
        )
        e.status = 502
        throw e
      }
      const msg = json && (json.error || json.detail || json.message) ? String(json.error || json.detail || json.message) : `HTTP ${resp.status}`
      const e = new Error(msg)
      e.status = 502
      throw e
    }
  } catch (e) {
    const err = new Error(e && e.message ? e.message : String(e))
    err.status = 502
    throw err
  } finally {
    clearTimeout(t)
  }

  const b64 = String(json.images[0]).split(',').pop()
  return { bytes: Buffer.from(b64, 'base64'), ext: 'png', meta: { provider: 'sdwebui', model: model || null } }
}

function mapComfyScheduler(v) {
  const s = String(v || '').trim().toLowerCase()
  // ComfyUI doesn't have "Automatic"; map it to default scheduler.
  if (!s || s === 'automatic') return 'normal'
  const allowed = new Set(['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta'])
  return allowed.has(s) ? s : 'normal'
}

function mapComfySampler(v) {
  const s = String(v || '').trim().toLowerCase()
  if (!s || s === 'dpm++ 2m') return 'dpmpp_2m'
  return s
}

function parseComfyTimeoutMs(raw) {
  if (raw == null || raw === '') return clampInt(process.env.STUDIO_BG_TIMEOUT_MS, 5_000, 300_000, 180_000)
  const n = Number(raw)
  if (Number.isFinite(n) && n <= 0) return 0
  return clampInt(n, 5_000, 300_000, clampInt(process.env.STUDIO_BG_TIMEOUT_MS, 5_000, 300_000, 180_000))
}

async function waitComfyImage({ baseUrl, promptId, timeoutMs }) {
  const started = Date.now()
  while (timeoutMs <= 0 || Date.now() - started < timeoutMs) {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 4000)
    try {
      const r = await fetch(`${baseUrl}/history/${encodeURIComponent(String(promptId))}`, { method: 'GET', signal: controller.signal })
      const j = await r.json().catch(() => null)
      if (r.ok && j && typeof j === 'object') {
        const item = j[String(promptId)]
        const outputs = item && item.outputs && typeof item.outputs === 'object' ? item.outputs : null
        if (outputs) {
          for (const k of Object.keys(outputs)) {
            const out = outputs[k]
            const images = out && Array.isArray(out.images) ? out.images : []
            if (images.length) {
              const im = images[0]
              const filename = String(im && im.filename ? im.filename : '').trim()
              const subfolder = String(im && im.subfolder ? im.subfolder : '').trim()
              const type = String(im && im.type ? im.type : 'output').trim() || 'output'
              if (filename) return { filename, subfolder, type }
            }
          }
        }
      }
    } catch (_) {
      // ignore transient poll errors
    } finally {
      clearTimeout(t)
    }
    await new Promise((r) => setTimeout(r, 800))
  }
  const e = new Error(`comfyui_timeout: prompt_id=${String(promptId)}`)
  e.status = 502
  throw e
}

async function generateBackgroundViaComfyui(input) {
  const baseUrl = normalizeComfyuiBaseUrl(input && input.comfyuiBaseUrl ? input.comfyuiBaseUrl : process.env.COMFYUI_BASE_URL)
  let model = normalizeComfyCheckpointName(input && input.model ? input.model : '')
  const timeoutMs = parseComfyTimeoutMs(input && input.timeoutMs != null ? input.timeoutMs : process.env.STUDIO_BG_TIMEOUT_MS)
  const style = String(input && input.style ? input.style : '').trim()
  const cooked = buildSdwebuiPromptAndNegative({
    prompt: String(input.prompt || '').trim(),
    negativePrompt: String(input.negativePrompt || '').trim(),
    style
  })

  const width = clampInt(input.width, 64, 2048, 768)
  const height = clampInt(input.height, 64, 2048, 1024)
  const steps = clampInt(input.steps, 5, 80, 20)
  const cfg = (() => {
    const n = Number(input.cfgScale)
    return Number.isFinite(n) ? Math.max(1, Math.min(20, n)) : 7
  })()
  const samplerName = mapComfySampler(input.sampler || 'DPM++ 2M')
  const scheduler = mapComfyScheduler(input.scheduler || 'Automatic')
  const seed = Math.floor(Math.random() * 9_999_999_999)

  if (!model) {
    let t = null
    try {
      const controller = new AbortController()
      t = setTimeout(() => controller.abort(), 5000)
      const resp = await fetch(`${baseUrl}/object_info/CheckpointLoaderSimple`, { method: 'GET', signal: controller.signal })
      const j = resp.ok ? await resp.json().catch(() => null) : null
      const ckpts = j && j.CheckpointLoaderSimple && j.CheckpointLoaderSimple.input && j.CheckpointLoaderSimple.input.required
        ? j.CheckpointLoaderSimple.input.required.ckpt_name
        : null
      const arr = Array.isArray(ckpts) ? ckpts.map((x) => String(x || '').trim()).filter(Boolean) : []
      if (arr.length) model = arr[0]
    } catch (_) {}
    finally {
      if (t) clearTimeout(t)
    }
  }
  if (!model) {
    const e = new Error('comfyui_missing_model: 请在设置中选择模型，或确保 ComfyUI 可返回 Checkpoint 列表')
    e.status = 501
    throw e
  }

  const workflow = {
    '3': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: String(cooked.prompt || '').trim(), clip: ['3', 1] } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: String(cooked.negativePrompt || '').trim(), clip: ['3', 1] } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: samplerName,
        scheduler,
        denoise: 1,
        model: ['3', 0],
        positive: ['5', 0],
        negative: ['6', 0],
        latent_image: ['4', 0]
      }
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'game_studio', images: ['8', 0] } }
  }

  let promptId = ''
  const controller = new AbortController()
  const submitAbortMs = timeoutMs <= 0 ? 30_000 : Math.min(timeoutMs, 30_000)
  const t = setTimeout(() => controller.abort(), submitAbortMs)
  try {
    const resp = await fetch(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow }),
      signal: controller.signal
    })
    const json = await resp.json().catch(() => null)
    if (!resp.ok || !json || !json.prompt_id) {
      const msg = json && (json.error || json.message || json.detail)
        ? explainRemoteError(json.error || json.message || json.detail)
        : `HTTP ${resp.status}`
      const e = new Error(`comfyui_prompt_failed: ${msg}`)
      e.status = 502
      throw e
    }
    promptId = String(json.prompt_id || '').trim()
  } catch (e) {
    const err = new Error(e && e.message ? e.message : String(e))
    err.status = 502
    throw err
  } finally {
    clearTimeout(t)
  }

  const img = await waitComfyImage({ baseUrl, promptId, timeoutMs })
  const q = new URLSearchParams({ filename: img.filename, type: img.type || 'output' })
  if (img.subfolder) q.set('subfolder', img.subfolder)
  const viewUrl = `${baseUrl}/view?${q.toString()}`
  const dl = await curlDownload({ url: viewUrl, timeoutMs: timeoutMs <= 0 ? 120_000 : timeoutMs, proxyUrl: '' })
  return {
    bytes: dl.bytes,
    ext: extFromContentType(dl.contentType),
    meta: { provider: 'comfyui', model: model || null, url: viewUrl }
  }
}

async function generateBackgroundViaDoubao(input) {
  // Doubao (Volcengine Ark Images) 实现：
  // - 尝试通过封装的 `generateImageViaDoubaoArkImages` 获取结果（可能直接返回 bytes 或给出 url）
  // - 如果返回 url，则使用 curlDownload 拉取二进制并根据 content-type 推断扩展名
  // - 对于网络/响应错误，抛出带 status=502 的 Error
  const proxyUrl = String(input && input.proxyUrl ? input.proxyUrl : '').trim() || getProxyUrl()
  const timeoutMs = clampInt(input && input.timeoutMs != null ? input.timeoutMs : process.env.STUDIO_BG_TIMEOUT_MS, 5_000, 300_000, 180_000)

  const prompt = String(input.prompt || '').trim()
  const negativePrompt = String(input.negativePrompt || '').trim()
  const width = clampInt(input.width, 64, 2048, 768)
  const height = clampInt(input.height, 64, 2048, 1024)

  const aspectRatio = String(input.aspectRatio || '').trim() || guessAspectRatio({ width, height })
  const style = String(input.style || '').trim() || String(process.env.DOUBAO_STYLE || '').trim() || 'picture_book'
  const watermark = String(process.env.DOUBAO_WATERMARK || 'false').toLowerCase() === 'true' ? true : false

  // New API doesn't support style/aspectRatio fields directly; we pass them implicitly via prompt+size.
  const res = await generateImageViaDoubaoArkImages({
    prompt,
    negativePrompt,
    aspectRatio,
    style,
    watermark,
    proxyUrl,
    timeoutMs,
    width,
    height,
    cfgScale: input.cfgScale,
    guidanceScale: input.guidanceScale,
    size: input.size,
    model: input.model,
    apiUrl: input.apiUrl,
    responseFormat: input.responseFormat || 'url',
    sequentialImageGeneration: input.sequentialImageGeneration || 'disabled'
  })

  if (res.bytes) {
    return { bytes: res.bytes, ext: res.ext || 'jpg', meta: { provider: 'doubao', api: 'ark', mode: res.mode || 'binary' } }
  }

  if (!res.url) {
    const e = new Error('doubao_invalid_response: missing image url')
    e.status = 502
    throw e
  }

  const dl = await curlDownload({ url: res.url, timeoutMs, proxyUrl })
  return { bytes: dl.bytes, ext: extFromContentType(dl.contentType), meta: { provider: 'doubao', api: 'ark', url: res.url } }
}

// 根据宽高猜测最接近的纵横比预设（用于当未显式提供 aspectRatio 时）
function guessAspectRatio({ width, height }) {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return '9:16'
  const r = w / h
  const presets = [
    { k: '1:1', r: 1 },
    { k: '4:3', r: 4 / 3 },
    { k: '3:4', r: 3 / 4 },
    { k: '3:2', r: 3 / 2 },
    { k: '2:3', r: 2 / 3 },
    { k: '16:9', r: 16 / 9 },
    { k: '9:16', r: 9 / 16 },
    { k: '9:1', r: 9 }
  ]
  let best = presets[0]
  let bestDist = Infinity
  for (const p of presets) {
    const d = Math.abs(r - p.r)
    if (d < bestDist) {
      best = p
      bestDist = d
    }
  }
  return best.k
}
