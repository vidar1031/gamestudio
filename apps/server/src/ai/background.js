import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getProxyUrl } from '../net/proxy.js'
import { generateImageViaDoubaoArkImages } from './doubao.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const HAT_OBJECT_LOCK_TEMPLATE_PATH = path.resolve(__dirname, '../../workflows/comfyui_hat_object_lock_template.json')

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

export { normalizeComfyuiBaseUrl }

function normalizeComfyCheckpointName(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  // SDWebUI 常见展示名：xxx.safetensors [hash]
  // ComfyUI 的 CheckpointLoaderSimple 需要纯文件名：xxx.safetensors
  return s.replace(/\s+\[[^\]]+\]\s*$/, '').trim()
}

export { normalizeComfyCheckpointName }

function getComfyOutputDateFolder(date = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: String(process.env.STUDIO_ASSET_TIMEZONE || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
    const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]))
    return `${String(parts.year || '').trim()}-${String(parts.month || '').trim()}-${String(parts.day || '').trim()}`
  } catch (_) {
    return new Date(date.getTime() - (date.getTimezoneOffset() * 60_000)).toISOString().slice(0, 10)
  }
}

function buildComfySavePrefix(name, date = new Date()) {
  const safeName = String(name || '').trim().replace(/[^a-z0-9_.-]+/gi, '_') || 'image'
  return `game_studio/${getComfyOutputDateFolder(date)}/${safeName}`
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

function isolatedAssetStyleProfile({ workflowMode, lockProfile }) {
  const mode = String(workflowMode || '').trim().toLowerCase()
  const profile = String(lockProfile || '').trim().toLowerCase()
  const key = profile || mode
  if (mode === 'story_asset_prop_hat') {
    return {
      pos: 'neutral hat product reference illustration, isolated accessory catalog render, top-down or three-quarter object-only hat study, empty interior visible, non-photorealistic',
      neg: "children's picture book character, girl portrait, boy portrait, beauty shot, shoulders, collarbone, neckline, person wearing hat, mannequin, mannequin head, bust, statue, sculpture, figurine, pedestal, display base"
    }
  }
  if (key === 'wearable_prop' || mode === 'story_asset_prop_wearable') {
    return {
      pos: 'neutral product reference illustration, isolated accessory design sheet, clean catalog cutout, object-only rendering, non-photorealistic',
      neg: "children's picture book character, girl portrait, boy portrait, fashion model, lifestyle photo, person wearing hat"
    }
  }
  if (key === 'slender_prop' || mode === 'story_asset_prop_slender') {
    return {
      pos: 'neutral object reference illustration, technical design-sheet clarity, isolated single object rendering, non-photorealistic',
      neg: "children's picture book character, hand holding object, person, portrait, lifestyle shot"
    }
  }
  if (key === 'rigid_prop' || mode === 'story_asset_prop_product') {
    return {
      pos: 'neutral product illustration, isolated catalog object render, design reference sheet, non-photorealistic',
      neg: "children's picture book character, room scene, person beside object, portrait, lifestyle shot"
    }
  }
  if (key === 'soft_prop' || mode === 'story_asset_prop_soft') {
    return {
      pos: 'neutral isolated object illustration, simple design reference rendering, non-photorealistic',
      neg: "children's picture book character, person, portrait, model display, environment scene"
    }
  }
  if (key === 'ambient_prop' || mode === 'story_asset_prop_ambient') {
    return {
      pos: 'isolated motif illustration, clean simple cutout rendering, non-photorealistic',
      neg: 'storybook character scene, person, landscape panorama, skyline, full environment composition'
    }
  }
  if (key === 'organic_prop' || mode === 'story_asset_prop_specimen') {
    return {
      pos: 'neutral specimen illustration, isolated single subject study, design reference clarity, non-photorealistic',
      neg: "children's picture book character, habitat scene, person holding specimen, portrait"
    }
  }
  return null
}

function buildWorkflowProfileHints({ workflowMode, lockProfile }) {
  const mode = String(workflowMode || '').trim().toLowerCase()
  const profile = String(lockProfile || '').trim().toLowerCase()
  const key = profile || mode
  if (mode === 'story_asset_prop_hat') {
    return {
      pos: 'standalone hat object lock image, empty hat opening visible, brim contour fully unobstructed, hat placed alone, horizontal object layout, object-only catalog shot, no wearer anatomy, no portrait framing',
      neg: 'girl portrait, female face, shoulders, collarbone, neckline, beauty close-up, head wearing hat, mannequin head, mannequin, fashion editorial, bust, statue, sculpture, figurine, pedestal, display base'
    }
  }
  if (mode === 'scene_ref_composite') {
    return {
      pos: 'storybook scene composition, stable environment, all referenced assets remain visually consistent, readable staging, no extra surprise subjects',
      neg: 'isolated product shot, floating single object on white background, extra random characters, off-story costume changes'
    }
  }
  if (mode === 'scene_prompt_only_fallback') {
    return {
      pos: 'storybook scene illustration, stable composition, controlled visual hierarchy, clear main subjects',
      neg: 'random collage, cluttered framing, disconnected objects, isolated merchandise layout'
    }
  }
  if (mode === 'scene_prompt_only') {
    return {
      pos: 'storybook scene illustration, clear staging, coherent environment language, readable focal point',
      neg: 'floating product render, empty studio background, exploded object sheet, chaotic crowd'
    }
  }
  if (key === 'character_core' || mode === 'story_asset_character_sheet') {
    return {
      pos: 'character turnaround sheet, isolated single subject, pure white studio backdrop, full figure reference, no environment',
      neg: 'scene background, props, crowd, dramatic pose, cinematic composition'
    }
  }
  if (key === 'wearable_prop' || mode === 'story_asset_prop_wearable') {
    return {
      pos: 'standalone accessory product illustration, detached wearable object, isolated merchandise composition, no wearer anatomy',
      neg: 'wearing display, mannequin head, scalp, hair, ears, person, portrait, editorial fashion shot'
    }
  }
  if (key === 'slender_prop' || mode === 'story_asset_prop_slender') {
    return {
      pos: 'full-length isolated object study, straight readable silhouette, end-to-end visibility, minimal foreshortening',
      neg: 'cropped ends, bent object, broken object, hand holding, perspective distortion'
    }
  }
  if (key === 'rigid_prop' || mode === 'story_asset_prop_product') {
    return {
      pos: 'single stable product reference, isolated object, clear structural readability, controlled perspective',
      neg: 'warped perspective, melted shape, cluttered environment, multiple objects'
    }
  }
  if (key === 'soft_prop' || mode === 'story_asset_prop_soft') {
    return {
      pos: 'isolated soft-form reference, stable contour, readable volume, clean simple background',
      neg: 'wearer context, rigid structure, cluttered scene, multiple subjects'
    }
  }
  if (key === 'ambient_prop' || mode === 'story_asset_prop_ambient') {
    return {
      pos: 'isolated atmospheric motif, simple clean background, single motif reference, no landscape',
      neg: 'full landscape, horizon, buildings, characters, complex weather panorama'
    }
  }
  if (key === 'organic_prop' || mode === 'story_asset_prop_specimen') {
    return {
      pos: 'isolated specimen reference, anatomical readability, clear silhouette, no habitat scene',
      neg: 'habitat background, multiple specimens, hand holding, environment clutter'
    }
  }
  if (key === 'location_anchor' || mode === 'story_asset_location_anchor') {
    return {
      pos: 'environment anchor art, stable layout, reusable scene structure, no character close-up',
      neg: 'single object product shot, portrait close-up, isolated merchandise layout'
    }
  }
  return { pos: '', neg: '' }
}

function buildSdwebuiPromptAndNegative({ prompt, negativePrompt, style, workflowMode, lockProfile }) {
  const prof = isolatedAssetStyleProfile({ workflowMode, lockProfile }) || sdStyleProfile(style)
  const wf = buildWorkflowProfileHints({ workflowMode, lockProfile })
  const pos = uniqPhrases([
    ...splitCsvLike(cleanupAnchorNoise(prompt)),
    ...splitCsvLike(prof.pos),
    ...splitCsvLike(wf.pos)
  ]).join(', ')
  const neg = uniqPhrases([
    ...splitCsvLike(negativePrompt),
    ...splitCsvLike(prof.neg),
    ...splitCsvLike(wf.neg)
  ]).join(', ')
  return { prompt: pos, negativePrompt: neg }
}

// 选择默认图片提供者：优先使用环境变量 `STUDIO_BG_PROVIDER`，否则默认为 `sdwebui`。
function pickProvider() {
  return String(process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()
}

function extractComfyChoiceList(raw) {
  if (Array.isArray(raw) && raw.length >= 1 && Array.isArray(raw[0])) {
    return raw[0].map((x) => String(x || '').trim()).filter(Boolean)
  }
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x || '').trim()).filter(Boolean)
  }
  return []
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
  const marker = '__CURL_STATUS__'
  const args = [
    '-sS',
    '-L',
    '--max-time',
    String(Math.max(1, Math.ceil((Number(timeoutMs || 0) || 20000) / 1000))),
    ...(!proxyUrl && isLocalHttpUrl(url) ? ['--noproxy', '*'] : []),
    ...(proxyUrl ? ['--proxy', String(proxyUrl)] : []),
    '-D',
    '-',
    '-w',
    `\n${marker}:%{http_code}\n`,
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
      const errText = Buffer.concat(errChunks).toString('utf-8').trim()
      const buf = Buffer.concat(chunks)
      const statusTag = Buffer.from(`\n${marker}:`)
      const statusIdx = buf.lastIndexOf(statusTag)
      let httpStatus = NaN
      let payload = buf
      if (statusIdx >= 0) {
        const statusLine = buf.slice(statusIdx + statusTag.length).toString('utf-8').trim().split(/\s+/)[0]
        httpStatus = Number(statusLine)
        payload = buf.slice(0, statusIdx)
      }
      if (code !== 0) {
        const e = new Error(errText ? `curl_download_failed: ${errText}` : 'curl_download_failed')
        e.code = code
        reject(e)
        return
      }
      if (!Number.isFinite(httpStatus)) {
        const e = new Error(errText ? `curl_download_no_status: ${errText}` : 'curl_download_no_status')
        e.code = code
        reject(e)
        return
      }
      if (httpStatus < 200 || httpStatus >= 300) {
        const e = new Error(`curl_download_http_error: HTTP ${httpStatus}`)
        e.status = httpStatus
        e.code = code
        e.body = payload.toString('utf-8').trim().slice(0, 400)
        reject(e)
        return
      }
      // There may be multiple header blocks (redirects). Find the last \r\n\r\n boundary before body.
      const headerMarker = Buffer.from('\r\n\r\n')
      let headerEnd = -1
      for (let i = 0; i < payload.length - headerMarker.length; i++) {
        if (payload.slice(i, i + headerMarker.length).equals(headerMarker)) headerEnd = i + headerMarker.length
      }
      if (headerEnd < 0) {
        resolve({ contentType: '', bytes: payload, status: httpStatus })
        return
      }
      const headerText = payload.slice(0, headerEnd).toString('utf-8')
      const bodyBytes = payload.slice(headerEnd)
      const m = headerText.match(/content-type:\\s*([^\\r\\n]+)/i)
      resolve({ contentType: m ? String(m[1]).trim() : '', bytes: bodyBytes, status: httpStatus })
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

function isLocalHttpUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''))
    const host = String(u.hostname || '').trim().toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch (_) {
    return false
  }
}

function sniffImageMetaFromBytes(buf) {
  try {
    if (!buf || typeof buf.length !== 'number') return null
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', contentType: 'image/jpeg' }
    if (
      buf.length >= 8 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    )
      return { ext: 'png', contentType: 'image/png' }
    if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { ext: 'gif', contentType: 'image/gif' }
    if (
      buf.length >= 12 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    )
      return { ext: 'webp', contentType: 'image/webp' }
  } catch (_) {}
  return null
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
    style,
    workflowMode: input && input.workflowMode,
    lockProfile: input && input.lockProfile
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
  const seed = clampSeed(input && input.seed, null)
  if (seed != null) payload.seed = seed
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
  return {
    bytes: Buffer.from(b64, 'base64'),
    ext: 'png',
    meta: {
      provider: 'sdwebui',
      model: model || null,
      seed,
      workflowMode: String(input && input.workflowMode || '').trim() || undefined,
      lockProfile: String(input && input.lockProfile || '').trim() || undefined
    }
  }
}

function mapComfyScheduler(v) {
  const s = String(v || '').trim().toLowerCase()
  // ComfyUI doesn't have "Automatic"; map it to default scheduler.
  if (!s || s === 'automatic') return 'normal'
  const allowed = new Set(['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform', 'beta'])
  return allowed.has(s) ? s : 'normal'
}

export { mapComfyScheduler }

function mapComfySampler(v) {
  const s = String(v || '').trim().toLowerCase()
  if (!s || s === 'dpm++ 2m') return 'dpmpp_2m'
  return s
}

export { mapComfySampler }

function parseComfyTimeoutMs(raw) {
  if (raw == null || raw === '') return clampInt(process.env.STUDIO_BG_TIMEOUT_MS, 5_000, 300_000, 180_000)
  const n = Number(raw)
  if (Number.isFinite(n) && n <= 0) return 0
  return clampInt(n, 5_000, 300_000, clampInt(process.env.STUDIO_BG_TIMEOUT_MS, 5_000, 300_000, 180_000))
}

export { parseComfyTimeoutMs }

function clampFloat(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, v))
}

function parseComfyLoras(raw) {
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : [])
  const out = []
  const seen = new Set()
  for (const item0 of arr) {
    const item = String(item0 || '').trim()
    if (!item) continue
    // Format:
    // - "lora_name.safetensors"
    // - "lora_name:0.8" (model+clip)
    // - "lora_name:0.8:0.6" (model, clip)
    const parts = item.split(':').map((x) => String(x || '').trim()).filter(Boolean)
    const name = String(parts[0] || '').trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const strengthModel = clampFloat(parts.length >= 2 ? parts[1] : 0.8, 0, 2, 0.8)
    const strengthClip = clampFloat(parts.length >= 3 ? parts[2] : strengthModel, 0, 2, strengthModel)
    out.push({ name, strengthModel, strengthClip })
    if (out.length >= 8) break
  }
  return out
}

export { parseComfyLoras }

function clampSeed(raw, fallback = null) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(4_294_967_295, Math.floor(n)))
}

function sanitizeComfyUploadName(raw, fallback = 'reference.png') {
  const base = String(raw || '').trim() || fallback
  const ext = /\.[a-z0-9]+$/i.test(base) ? '' : '.png'
  return `${base.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'reference'}${ext}`
}

async function fetchComfyJson({ baseUrl, pathname, timeoutMs = 5000 }) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(`${baseUrl}${pathname}`, { method: 'GET', signal: controller.signal })
    if (!resp.ok) return null
    return await resp.json().catch(() => null)
  } catch (_) {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function fetchComfyModelList(baseUrl, pathname, timeoutMs = 5000) {
  const json = await fetchComfyJson({ baseUrl, pathname, timeoutMs })
  if (Array.isArray(json)) return json.map((x) => String(x || '').trim()).filter(Boolean)
  if (json && typeof json === 'object' && Array.isArray(json.models)) return json.models.map((x) => String(x || '').trim()).filter(Boolean)
  return []
}

async function fetchComfyNodeSpec(baseUrl, classType, timeoutMs = 5000) {
  const json = await fetchComfyJson({ baseUrl, pathname: `/object_info/${encodeURIComponent(String(classType))}`, timeoutMs })
  if (!json || typeof json !== 'object') return null
  return json && json[classType] && typeof json[classType] === 'object' ? { ...json[classType], __classType: classType } : null
}

function comfyInputNames(spec) {
  if (!spec || typeof spec !== 'object') return new Set()
  const input = spec.input && typeof spec.input === 'object' ? spec.input : {}
  return new Set([
    ...Object.keys(input.required && typeof input.required === 'object' ? input.required : {}),
    ...Object.keys(input.optional && typeof input.optional === 'object' ? input.optional : {})
  ])
}

function buildInputsForComfyNode(spec, candidates) {
  const allowed = comfyInputNames(spec)
  const out = {}
  for (const [key, value] of Object.entries(candidates || {})) {
    if (!allowed.size || allowed.has(key)) out[key] = value
  }
  const required = spec && spec.input && spec.input.required && typeof spec.input.required === 'object'
    ? Object.keys(spec.input.required)
    : []
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) {
      const e = new Error(`comfyui_missing_node_input:${String(spec?.name || spec?.display_name || 'unknown')}.${key}`)
      e.status = 502
      throw e
    }
  }
  return out
}

function pickPreferredComfyModel(models, preferredNames = []) {
  const list = Array.isArray(models) ? models.map((x) => String(x || '').trim()).filter(Boolean) : []
  const prefs = preferredNames.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)
  for (const pref of prefs) {
    const exact = list.find((x) => x.toLowerCase() === pref)
    if (exact) return exact
    const partial = list.find((x) => x.toLowerCase().includes(pref))
    if (partial) return partial
  }
  return list[0] || ''
}

async function uploadComfyImage({ baseUrl, bytes, filename, overwrite = false, type = 'input', timeoutMs = 15000 }) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const form = new FormData()
    form.set('image', new Blob([bytes]), sanitizeComfyUploadName(filename))
    form.set('type', String(type || 'input'))
    form.set('overwrite', overwrite ? 'true' : 'false')
    const resp = await fetch(`${baseUrl}/upload/image`, {
      method: 'POST',
      body: form,
      signal: controller.signal
    })
    const json = await resp.json().catch(() => null)
    if (!resp.ok || !json) {
      const e = new Error(`comfyui_upload_failed:${resp.status}`)
      e.status = 502
      throw e
    }
    const name = String(json.name || json.filename || filename || '').trim()
    const subfolder = String(json.subfolder || '').trim()
    if (!name) {
      const e = new Error('comfyui_upload_failed:missing_filename')
      e.status = 502
      throw e
    }
    return {
      name,
      subfolder,
      type: String(json.type || type || 'input').trim() || 'input',
      imageValue: subfolder ? `${subfolder}/${name}` : name
    }
  } finally {
    clearTimeout(t)
  }
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

export async function runComfyuiPromptWorkflow({ workflow, comfyuiBaseUrl, timeoutMs }) {
  const baseUrl = normalizeComfyuiBaseUrl(comfyuiBaseUrl)
  const effectiveTimeoutMs = parseComfyTimeoutMs(timeoutMs)
  if (!workflow || typeof workflow !== 'object') {
    const e = new Error('comfyui_invalid_workflow')
    e.status = 400
    throw e
  }

  let promptId = ''
  const controller = new AbortController()
  const submitAbortMs = effectiveTimeoutMs <= 0 ? 30_000 : Math.min(effectiveTimeoutMs, 30_000)
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

  const img = await waitComfyImage({ baseUrl, promptId, timeoutMs: effectiveTimeoutMs })
  const q = new URLSearchParams({ filename: img.filename, type: img.type || 'output' })
  if (img.subfolder) q.set('subfolder', img.subfolder)
  const viewUrl = `${baseUrl}/view?${q.toString()}`
  const dl = await curlDownload({ url: viewUrl, timeoutMs: effectiveTimeoutMs <= 0 ? 120_000 : effectiveTimeoutMs, proxyUrl: '' })
  const sniff = sniffImageMetaFromBytes(dl.bytes)
  if (!sniff) {
    const e = new Error('comfyui_view_download_invalid_image')
    e.status = 502
    throw e
  }
  return {
    bytes: dl.bytes,
    ext: sniff.ext || extFromContentType(dl.contentType),
    meta: {
      provider: 'comfyui',
      url: viewUrl,
      promptId
    }
  }
}

function nextWorkflowNodeId(workflow) {
  return Math.max(0, ...Object.keys(workflow || {}).map((x) => Number(x)).filter(Number.isFinite))
}

async function readHatObjectLockWorkflowTemplate() {
  const raw = await readFile(HAT_OBJECT_LOCK_TEMPLATE_PATH, 'utf-8')
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') {
    const e = new Error('invalid_hat_object_lock_workflow_template')
    e.status = 500
    throw e
  }
  return parsed
}

async function buildHatObjectLockWorkflow({
  model,
  prompt,
  negativePrompt,
  width,
  height,
  seed,
  loras,
  policy,
  params
}) {
  const workflow = await readHatObjectLockWorkflowTemplate()
  workflow['1'].inputs.ckpt_name = model
  workflow['2'].inputs.width = clampInt(width, 512, 2048, 1024)
  workflow['2'].inputs.height = clampInt(height, 512, 1536, 768)
  workflow['3'].inputs.text = String(prompt || '').trim()
  workflow['4'].inputs.text = String(negativePrompt || '').trim()
  workflow['5'].inputs.seed = seed
  workflow['5'].inputs.steps = clampInt(params?.steps, 8, 80, clampInt(policy?.defaultSteps, 8, 80, 28))
  workflow['5'].inputs.cfg = clampFloat(params?.cfg, 1, 20, clampFloat(policy?.defaultCfg, 1, 20, 4.6))
  workflow['5'].inputs.sampler_name = String(params?.samplerName || policy?.defaultSampler || 'dpmpp_2m_sde').trim()
  workflow['5'].inputs.scheduler = String(params?.scheduler || policy?.defaultScheduler || 'karras').trim()
  workflow['7'].inputs.filename_prefix = comfySavePrefixFromPolicy(policy)

  const normalizedLoras = Array.isArray(loras) ? loras : []
  if (!normalizedLoras.length) return { workflow, policy, usedCutout: false }

  let currentModelRef = ['1', 0]
  let currentClipRef = ['1', 1]
  let nid = nextWorkflowNodeId(workflow) + 1
  for (const lora of normalizedLoras) {
    const id = String(nid++)
    workflow[id] = {
      class_type: 'LoraLoader',
      inputs: {
        model: currentModelRef,
        clip: currentClipRef,
        lora_name: String(lora.name),
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
  return { workflow, policy, usedCutout: false }
}

function deriveComfyWorkflowPolicy({ workflowMode, lockProfile }) {
  const mode = String(workflowMode || '').trim().toLowerCase()
  const profile = String(lockProfile || '').trim().toLowerCase()
  if (mode === 'story_asset_prop_hat') {
    return {
      family: 'hat_object_lock',
      outputName: 'story_asset_prop_hat',
      defaultSteps: 28,
      defaultCfg: 4.6,
      defaultSampler: 'dpmpp_2m_sde',
      defaultScheduler: 'karras'
    }
  }
  if (profile === 'character_core' || mode === 'story_asset_character_sheet') {
    return {
      family: 'two_pass_refine',
      outputName: 'story_asset_character_sheet',
      defaultSteps: 28,
      defaultCfg: 6,
      defaultSampler: 'dpmpp_2m_sde',
      defaultScheduler: 'karras',
      refineDenoise: 0.28
    }
  }
  if (profile === 'slender_prop' || mode === 'story_asset_prop_slender') {
    return {
      family: 'two_pass_refine',
      outputName: 'story_asset_prop_slender',
      defaultSteps: 26,
      defaultCfg: 5.2,
      defaultSampler: 'dpmpp_2m_sde',
      defaultScheduler: 'karras',
      refineDenoise: 0.2
    }
  }
  if (
    profile === 'wearable_prop' ||
    profile === 'rigid_prop' ||
    profile === 'organic_prop' ||
    mode === 'story_asset_prop_wearable' ||
    mode === 'story_asset_prop_product' ||
    mode === 'story_asset_prop_specimen'
  ) {
    return {
      family: 'product_cutout',
      outputName: mode || profile || 'story_asset_prop_product',
      defaultSteps: 24,
      defaultCfg: 5.6,
      defaultSampler: 'dpmpp_2m_sde',
      defaultScheduler: 'karras',
      cutoutPreferred: true
    }
  }
  if (profile === 'location_anchor' || mode === 'story_asset_location_anchor') {
    return {
      family: 'basic',
      outputName: 'story_asset_location_anchor',
      defaultSteps: 24,
      defaultCfg: 6.5,
      defaultSampler: 'dpmpp_2m',
      defaultScheduler: 'normal'
    }
  }
  if (profile === 'ambient_prop' || mode === 'story_asset_prop_ambient') {
    return {
      family: 'basic',
      outputName: 'story_asset_prop_ambient',
      defaultSteps: 22,
      defaultCfg: 6,
      defaultSampler: 'dpmpp_2m',
      defaultScheduler: 'normal'
    }
  }
  if (profile === 'soft_prop' || mode === 'story_asset_prop_soft') {
    return {
      family: 'basic',
      outputName: 'story_asset_prop_soft',
      defaultSteps: 22,
      defaultCfg: 5.8,
      defaultSampler: 'dpmpp_2m',
      defaultScheduler: 'normal'
    }
  }
  if (mode === 'scene_ref_composite') {
    return {
      family: 'two_pass_refine',
      outputName: 'story_scene_ref_composite',
      defaultSteps: 26,
      defaultCfg: 6.2,
      defaultSampler: 'dpmpp_2m_sde',
      defaultScheduler: 'karras',
      refineDenoise: 0.24
    }
  }
  if (mode === 'scene_prompt_only_fallback' || mode === 'scene_prompt_only') {
    return {
      family: 'basic',
      outputName: mode || 'story_scene_prompt_only',
      defaultSteps: 24,
      defaultCfg: 6.5,
      defaultSampler: 'dpmpp_2m',
      defaultScheduler: 'normal'
    }
  }
  return {
    family: 'basic',
    outputName: mode || profile || 'background',
    defaultSteps: 20,
    defaultCfg: 7,
    defaultSampler: 'dpmpp_2m',
    defaultScheduler: 'normal'
  }
}

function comfySavePrefixFromPolicy(policy) {
  return buildComfySavePrefix(String(policy?.outputName || 'background').trim() || 'background')
}

function resolveComfySamplerAndSchedule(input, policy) {
  return {
    steps: clampInt(input.steps, 5, 80, clampInt(policy?.defaultSteps, 5, 80, 20)),
    cfg: (() => {
      const n = Number(input.cfgScale)
      if (Number.isFinite(n)) return Math.max(1, Math.min(20, n))
      return clampFloat(policy?.defaultCfg, 1, 20, 7)
    })(),
    samplerName: mapComfySampler(input.sampler || policy?.defaultSampler || 'DPM++ 2M'),
    scheduler: mapComfyScheduler(input.scheduler || policy?.defaultScheduler || 'Automatic')
  }
}

async function buildComfyWorkflowNodes({
  baseUrl,
  model,
  prompt,
  negativePrompt,
  width,
  height,
  seed,
  loras,
  policy,
  params
}) {
  if (String(policy?.family || '') === 'hat_object_lock') {
    return buildHatObjectLockWorkflow({
      model,
      prompt,
      negativePrompt,
      width,
      height,
      seed,
      loras,
      policy,
      params
    })
  }
  const common = params && typeof params === 'object'
    ? params
    : resolveComfySamplerAndSchedule({}, policy)
  const specs = {
    checkpoint: await fetchComfyNodeSpec(baseUrl, 'CheckpointLoaderSimple', 5000),
    emptyLatent: await fetchComfyNodeSpec(baseUrl, 'EmptyLatentImage', 5000),
    clipText: await fetchComfyNodeSpec(baseUrl, 'CLIPTextEncode', 5000),
    ksampler: await fetchComfyNodeSpec(baseUrl, 'KSampler', 5000),
    vaeDecode: await fetchComfyNodeSpec(baseUrl, 'VAEDecode', 5000),
    saveImage: await fetchComfyNodeSpec(baseUrl, 'SaveImage', 5000)
  }
  if (!specs.checkpoint || !specs.emptyLatent || !specs.clipText || !specs.ksampler || !specs.vaeDecode || !specs.saveImage) {
    const e = new Error('comfyui_missing_core_nodes: 缺少基础生成节点')
    e.status = 502
    throw e
  }

  const workflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: buildInputsForComfyNode(specs.checkpoint, { ckpt_name: model }) },
    '2': { class_type: 'EmptyLatentImage', inputs: buildInputsForComfyNode(specs.emptyLatent, { width, height, batch_size: 1 }) }
  }

  let comfyModelRef = ['1', 0]
  let comfyClipRef = ['1', 1]
  let nextId = 10
  for (const l of Array.isArray(loras) ? loras : []) {
    const id = String(nextId++)
    workflow[id] = {
      class_type: 'LoraLoader',
      inputs: {
        model: comfyModelRef,
        clip: comfyClipRef,
        lora_name: String(l.name),
        strength_model: l.strengthModel,
        strength_clip: l.strengthClip
      }
    }
    comfyModelRef = [id, 0]
    comfyClipRef = [id, 1]
  }

  const posId = String(nextId++)
  const negId = String(nextId++)
  workflow[posId] = { class_type: 'CLIPTextEncode', inputs: buildInputsForComfyNode(specs.clipText, { text: String(prompt || '').trim(), clip: comfyClipRef }) }
  workflow[negId] = { class_type: 'CLIPTextEncode', inputs: buildInputsForComfyNode(specs.clipText, { text: String(negativePrompt || '').trim(), clip: comfyClipRef }) }

  if (String(policy?.family || '') === 'two_pass_refine') {
    const imageScaleSpec = await fetchComfyNodeSpec(baseUrl, 'ImageScale', 5000)
    const vaeEncodeSpec = await fetchComfyNodeSpec(baseUrl, 'VAEEncode', 5000)
    if (!imageScaleSpec || !vaeEncodeSpec) {
      policy = { ...policy, family: 'basic' }
    } else {
      const firstSteps = clampInt(Math.round(common.steps * 0.7), 8, 60, Math.max(12, common.steps - 6))
      const refineSteps = clampInt(Math.round(common.steps * 0.45), 6, 40, Math.max(8, Math.round(common.steps / 2)))
      const firstSamplerId = String(nextId++)
      const firstDecodeId = String(nextId++)
      const scaleId = String(nextId++)
      const reencodeId = String(nextId++)
      const refineSamplerId = String(nextId++)
      const finalDecodeId = String(nextId++)
      const saveId = String(nextId++)
      workflow[firstSamplerId] = {
        class_type: 'KSampler',
        inputs: buildInputsForComfyNode(specs.ksampler, {
          seed,
          steps: firstSteps,
          cfg: common.cfg,
          sampler_name: common.samplerName,
          scheduler: common.scheduler,
          denoise: 1,
          model: comfyModelRef,
          positive: [posId, 0],
          negative: [negId, 0],
          latent_image: ['2', 0]
        })
      }
      workflow[firstDecodeId] = { class_type: 'VAEDecode', inputs: buildInputsForComfyNode(specs.vaeDecode, { samples: [firstSamplerId, 0], vae: ['1', 2] }) }
      workflow[scaleId] = {
        class_type: 'ImageScale',
        inputs: buildInputsForComfyNode(imageScaleSpec, {
          image: [firstDecodeId, 0],
          upscale_method: 'lanczos',
          width,
          height,
          crop: 'disabled'
        })
      }
      workflow[reencodeId] = { class_type: 'VAEEncode', inputs: buildInputsForComfyNode(vaeEncodeSpec, { pixels: [scaleId, 0], vae: ['1', 2] }) }
      workflow[refineSamplerId] = {
        class_type: 'KSampler',
        inputs: buildInputsForComfyNode(specs.ksampler, {
          seed: clampSeed(seed + 17, seed),
          steps: refineSteps,
          cfg: clampFloat(common.cfg - 0.4, 1, 20, common.cfg),
          sampler_name: common.samplerName,
          scheduler: common.scheduler,
          denoise: clampFloat(policy?.refineDenoise, 0.1, 0.7, 0.25),
          model: comfyModelRef,
          positive: [posId, 0],
          negative: [negId, 0],
          latent_image: [reencodeId, 0]
        })
      }
      workflow[finalDecodeId] = { class_type: 'VAEDecode', inputs: buildInputsForComfyNode(specs.vaeDecode, { samples: [refineSamplerId, 0], vae: ['1', 2] }) }
      workflow[saveId] = {
        class_type: 'SaveImage',
        inputs: buildInputsForComfyNode(specs.saveImage, { filename_prefix: comfySavePrefixFromPolicy(policy), images: [finalDecodeId, 0] })
      }
      return { workflow, policy, usedCutout: false }
    }
  }

  const samplerId = String(nextId++)
  const decodeId = String(nextId++)
  workflow[samplerId] = {
    class_type: 'KSampler',
    inputs: buildInputsForComfyNode(specs.ksampler, {
      seed,
      steps: common.steps,
      cfg: common.cfg,
      sampler_name: common.samplerName,
      scheduler: common.scheduler,
      denoise: 1,
      model: comfyModelRef,
      positive: [posId, 0],
      negative: [negId, 0],
      latent_image: ['2', 0]
    })
  }
  workflow[decodeId] = { class_type: 'VAEDecode', inputs: buildInputsForComfyNode(specs.vaeDecode, { samples: [samplerId, 0], vae: ['1', 2] }) }

  if (String(policy?.family || '') === 'product_cutout') {
    const rmbgSpec = await fetchComfyNodeSpec(baseUrl, 'RMBG', 5000)
    if (rmbgSpec) {
      const modelChoices = extractComfyChoiceList(rmbgSpec?.input?.required?.model)
      const chosenModel = pickPreferredComfyModel(modelChoices, [
        process.env.COMFYUI_RMBG_MODEL || '',
        'RMBG-2.0',
        'BEN2',
        'BEN',
        'INSPYRENET'
      ]) || 'RMBG-2.0'
      const rmbgId = String(nextId++)
      const saveId = String(nextId++)
      workflow[rmbgId] = {
        class_type: 'RMBG',
        inputs: buildInputsForComfyNode(rmbgSpec, {
          image: [decodeId, 0],
          model: chosenModel,
          sensitivity: 1.0,
          process_res: Math.max(width, height, 1024),
          mask_blur: 0,
          mask_offset: 0,
          invert_output: false,
          refine_foreground: false,
          background: 'Color',
          background_color: '#FFFFFFFF'
        })
      }
      workflow[saveId] = {
        class_type: 'SaveImage',
        inputs: buildInputsForComfyNode(specs.saveImage, { filename_prefix: comfySavePrefixFromPolicy(policy), images: [rmbgId, 0] })
      }
      return { workflow, policy, usedCutout: true }
    }
  }

  const saveId = String(nextId++)
  workflow[saveId] = {
    class_type: 'SaveImage',
    inputs: buildInputsForComfyNode(specs.saveImage, { filename_prefix: comfySavePrefixFromPolicy(policy), images: [decodeId, 0] })
  }
  return { workflow, policy, usedCutout: false }
}


export async function generateComfyuiWhiteBackgroundFromReference({
  referenceBytes,
  referenceFilename,
  comfyuiBaseUrl,
  model,
  sensitivity,
  processRes,
  timeoutMs,
  prefix
}) {
  const baseUrl = normalizeComfyuiBaseUrl(comfyuiBaseUrl)
  const effectiveTimeoutMs = parseComfyTimeoutMs(timeoutMs)

  const [loadImageSpec, rmbgSpec, saveImageSpec] = await Promise.all([
    fetchComfyNodeSpec(baseUrl, 'LoadImage', 5000),
    fetchComfyNodeSpec(baseUrl, 'RMBG', 5000),
    fetchComfyNodeSpec(baseUrl, 'SaveImage', 5000)
  ])
  if (!loadImageSpec || !rmbgSpec || !saveImageSpec) {
    const e = new Error('comfyui_rmbg_not_ready: 缺少 LoadImage/RMBG/SaveImage 节点')
    e.status = 502
    throw e
  }

  const uploaded = await uploadComfyImage({
    baseUrl,
    bytes: referenceBytes,
    filename: referenceFilename || 'story_asset_reference.png',
    overwrite: true,
    type: 'input',
    timeoutMs: effectiveTimeoutMs <= 0 ? 15000 : Math.min(effectiveTimeoutMs, 15000)
  })

  const modelChoices = extractComfyChoiceList(rmbgSpec?.input?.required?.model)
  const chosenModel = pickPreferredComfyModel(modelChoices, [
    String(model || '').trim(),
    'RMBG-2.0',
    'BEN2',
    'BEN',
    'INSPYRENET'
  ]) || 'RMBG-2.0'

  const workflow = {
    '1': { class_type: 'LoadImage', inputs: buildInputsForComfyNode(loadImageSpec, { image: uploaded.imageValue, upload: 'image' }) },
    '2': { class_type: 'RMBG', inputs: buildInputsForComfyNode(rmbgSpec, {
      image: ['1', 0],
      model: chosenModel,
      sensitivity: clampFloat(sensitivity, 0, 1, 1.0),
      process_res: clampInt(processRes, 256, 2048, 1024),
      mask_blur: 0,
      mask_offset: 0,
      invert_output: false,
      refine_foreground: false,
      background: 'Color',
      background_color: '#FFFFFFFF'
    }) },
    '3': { class_type: 'SaveImage', inputs: buildInputsForComfyNode(saveImageSpec, { images: ['2', 0], filename_prefix: String(prefix || 'game_studio_story_lock/white_bg') }) }
  }

  const result = await runComfyuiPromptWorkflow({ workflow, comfyuiBaseUrl: baseUrl, timeoutMs: effectiveTimeoutMs })
  return {
    bytes: result.bytes,
    ext: result.ext,
    meta: {
      provider: 'comfyui',
      postprocess: 'rmbg_white_bg',
      model: chosenModel,
      url: result.meta && result.meta.url ? result.meta.url : ''
    }
  }
}


export async function generateComfyuiLineartFromReference({
  referenceBytes,
  referenceFilename,
  comfyuiBaseUrl,
  model,
  controlnetModel,
  width,
  height,
  preprocessor,
  unionType,
  prompt,
  negativePrompt,
  steps,
  cfgScale,
  denoise,
  seed,
  timeoutMs,
  hintPrefix,
  finalPrefix
}) {
  const baseUrl = normalizeComfyuiBaseUrl(comfyuiBaseUrl)
  const effectiveTimeoutMs = parseComfyTimeoutMs(timeoutMs)
  const w = clampInt(width, 256, 2048, 832)
  const h = clampInt(height, 256, 2048, 832)
  const samplerName = 'dpmpp_2m_sde'
  const scheduler = 'karras'
  const redrawSteps = clampInt(steps, 8, 80, 20)
  const redrawCfg = clampFloat(cfgScale, 1, 20, 3.5)
  const redrawDenoise = clampFloat(denoise, 0.1, 1, 0.55)
  const redrawSeed = clampSeed(seed, null) ?? Math.floor(Math.random() * 4_294_967_295)
  const chosenPreprocessor = String(preprocessor || '').trim() === 'anime' ? 'AnimeLineArtPreprocessor' : 'LineArtPreprocessor'
  const chosenUnionType = String(unionType || '').trim() || 'canny/lineart/anime_lineart/mlsd'

  let checkpoint = normalizeComfyCheckpointName(model)
  if (!checkpoint) {
    let t = null
    try {
      const controller = new AbortController()
      t = setTimeout(() => controller.abort(), 5000)
      const resp = await fetch(`${baseUrl}/object_info/CheckpointLoaderSimple`, { method: 'GET', signal: controller.signal })
      const j = resp.ok ? await resp.json().catch(() => null) : null
      const ckpts = j && j.CheckpointLoaderSimple && j.CheckpointLoaderSimple.input && j.CheckpointLoaderSimple.input.required
        ? j.CheckpointLoaderSimple.input.required.ckpt_name
        : null
      const arr = extractComfyChoiceList(ckpts)
      if (arr.length) checkpoint = arr[0]
    } catch (_) {
    } finally {
      if (t) clearTimeout(t)
    }
  }
  if (!checkpoint) {
    const e = new Error('comfyui_missing_model: 请先配置 checkpoint 后再生成线稿')
    e.status = 501
    throw e
  }

  const [
    loadImageSpec,
    imageScaleSpec,
    preprocessorSpec,
    controlNetLoaderSpec,
    unionSpec,
    clipTextSpec,
    vaeEncodeSpec,
    controlApplySpec,
    ksamplerSpec,
    vaeDecodeSpec,
    saveImageSpec
  ] = await Promise.all([
    fetchComfyNodeSpec(baseUrl, 'LoadImage', 5000),
    fetchComfyNodeSpec(baseUrl, 'ImageScale', 5000),
    fetchComfyNodeSpec(baseUrl, chosenPreprocessor, 5000),
    fetchComfyNodeSpec(baseUrl, 'ControlNetLoader', 5000),
    fetchComfyNodeSpec(baseUrl, 'SetUnionControlNetType', 5000),
    fetchComfyNodeSpec(baseUrl, 'CLIPTextEncode', 5000),
    fetchComfyNodeSpec(baseUrl, 'VAEEncode', 5000),
    fetchComfyNodeSpec(baseUrl, 'ControlNetApplyAdvanced', 5000),
    fetchComfyNodeSpec(baseUrl, 'KSampler', 5000),
    fetchComfyNodeSpec(baseUrl, 'VAEDecode', 5000),
    fetchComfyNodeSpec(baseUrl, 'SaveImage', 5000)
  ])
  if (!loadImageSpec || !imageScaleSpec || !preprocessorSpec || !controlNetLoaderSpec || !unionSpec || !clipTextSpec || !vaeEncodeSpec || !controlApplySpec || !ksamplerSpec || !vaeDecodeSpec || !saveImageSpec) {
    const e = new Error('comfyui_lineart_not_ready: 缺少必要的 LoadImage/ImageScale/Preprocessor/ControlNet 节点')
    e.status = 502
    throw e
  }

  const controlnetModels = await fetchComfyModelList(baseUrl, '/models/controlnet', 5000)
  const chosenControlnet = pickPreferredComfyModel(controlnetModels, [
    String(controlnetModel || '').trim(),
    'controlnet-union-sdxl-1.0',
    'controlnet-union',
    'promax',
    'union'
  ]) || String(controlnetModel || '').trim()
  if (!chosenControlnet) {
    const e = new Error('comfyui_missing_controlnet_model: 未找到可用的 union lineart controlnet 模型')
    e.status = 502
    throw e
  }

  const uploaded = await uploadComfyImage({
    baseUrl,
    bytes: referenceBytes,
    filename: referenceFilename || 'story_lock_reference.png',
    overwrite: true,
    type: 'input',
    timeoutMs: effectiveTimeoutMs <= 0 ? 15000 : Math.min(effectiveTimeoutMs, 15000)
  })

  const hintWorkflow = {
    '1': { class_type: 'LoadImage', inputs: buildInputsForComfyNode(loadImageSpec, { image: uploaded.imageValue, upload: 'image' }) },
    '2': { class_type: 'ImageScale', inputs: buildInputsForComfyNode(imageScaleSpec, { image: ['1', 0], upscale_method: 'lanczos', width: w, height: h, crop: 'disabled' }) },
    '3': { class_type: chosenPreprocessor, inputs: buildInputsForComfyNode(preprocessorSpec, { image: ['2', 0], resolution: Math.max(w, h) }) },
    '4': { class_type: 'SaveImage', inputs: buildInputsForComfyNode(saveImageSpec, { images: ['3', 0], filename_prefix: String(hintPrefix || 'game_studio_story_lock/hint') }) }
  }
  const hint = await runComfyuiPromptWorkflow({ workflow: hintWorkflow, comfyuiBaseUrl: baseUrl, timeoutMs: effectiveTimeoutMs })

  const finalWorkflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint } },
    '2': { class_type: 'LoadImage', inputs: buildInputsForComfyNode(loadImageSpec, { image: uploaded.imageValue, upload: 'image' }) },
    '3': { class_type: 'ImageScale', inputs: buildInputsForComfyNode(imageScaleSpec, { image: ['2', 0], upscale_method: 'lanczos', width: w, height: h, crop: 'disabled' }) },
    '4': { class_type: chosenPreprocessor, inputs: buildInputsForComfyNode(preprocessorSpec, { image: ['3', 0], resolution: Math.max(w, h) }) },
    '5': { class_type: 'ControlNetLoader', inputs: buildInputsForComfyNode(controlNetLoaderSpec, { control_net_name: chosenControlnet }) },
    '6': { class_type: 'SetUnionControlNetType', inputs: buildInputsForComfyNode(unionSpec, { control_net: ['5', 0], type: chosenUnionType }) },
    '7': { class_type: 'CLIPTextEncode', inputs: buildInputsForComfyNode(clipTextSpec, { clip: ['1', 1], text: String(prompt || '').trim() }) },
    '8': { class_type: 'CLIPTextEncode', inputs: buildInputsForComfyNode(clipTextSpec, { clip: ['1', 1], text: String(negativePrompt || '').trim() }) },
    '9': { class_type: 'VAEEncode', inputs: buildInputsForComfyNode(vaeEncodeSpec, { pixels: ['3', 0], vae: ['1', 2] }) },
    '10': { class_type: 'ControlNetApplyAdvanced', inputs: buildInputsForComfyNode(controlApplySpec, { positive: ['7', 0], negative: ['8', 0], control_net: ['6', 0], image: ['4', 0], strength: 1.0, start_percent: 0.0, end_percent: 1.0, vae: ['1', 2] }) },
    '11': { class_type: 'KSampler', inputs: buildInputsForComfyNode(ksamplerSpec, { model: ['1', 0], positive: ['10', 0], negative: ['10', 1], latent_image: ['9', 0], seed: redrawSeed, steps: redrawSteps, cfg: redrawCfg, sampler_name: samplerName, scheduler, denoise: redrawDenoise }) },
    '12': { class_type: 'VAEDecode', inputs: buildInputsForComfyNode(vaeDecodeSpec, { samples: ['11', 0], vae: ['1', 2] }) },
    '13': { class_type: 'SaveImage', inputs: buildInputsForComfyNode(saveImageSpec, { images: ['12', 0], filename_prefix: String(finalPrefix || 'game_studio_story_lock/final') }) }
  }
  const final = await runComfyuiPromptWorkflow({ workflow: finalWorkflow, comfyuiBaseUrl: baseUrl, timeoutMs: effectiveTimeoutMs })

  return {
    hintBytes: hint.bytes,
    hintExt: hint.ext,
    finalBytes: final.bytes,
    finalExt: final.ext,
    meta: {
      provider: 'comfyui',
      checkpoint,
      controlnetModel: chosenControlnet,
      preprocessor: chosenPreprocessor,
      unionType: chosenUnionType,
      width: w,
      height: h,
      steps: redrawSteps,
      cfgScale: redrawCfg,
      denoise: redrawDenoise,
      seed: redrawSeed,
      hintUrl: hint.meta && hint.meta.url ? hint.meta.url : '',
      finalUrl: final.meta && final.meta.url ? final.meta.url : ''
    }
  }
}

async function generateBackgroundViaComfyui(input) {
  const baseUrl = normalizeComfyuiBaseUrl(input && input.comfyuiBaseUrl ? input.comfyuiBaseUrl : process.env.COMFYUI_BASE_URL)
  let model = normalizeComfyCheckpointName(input && input.model ? input.model : '')
  const timeoutMs = parseComfyTimeoutMs(input && input.timeoutMs != null ? input.timeoutMs : process.env.STUDIO_BG_TIMEOUT_MS)
  const style = String(input && input.style ? input.style : '').trim()
  const loras = parseComfyLoras(input && input.loras ? input.loras : null)
  const continuity = input && input.continuity && typeof input.continuity === 'object' ? input.continuity : {}
  const referenceImages = Array.isArray(input && input.referenceImages) ? input.referenceImages : []
  const policy = deriveComfyWorkflowPolicy({ workflowMode: input && input.workflowMode, lockProfile: input && input.lockProfile })
  const cooked = buildSdwebuiPromptAndNegative({
    prompt: String(input.prompt || '').trim(),
    negativePrompt: String(input.negativePrompt || '').trim(),
    style,
    workflowMode: input && input.workflowMode,
    lockProfile: input && input.lockProfile
  })

  const width = clampInt(input.width, 64, 2048, 768)
  const height = clampInt(input.height, 64, 2048, 1024)
  const comfyParams = resolveComfySamplerAndSchedule(input || {}, policy)
  const seed = clampSeed(input && input.seed, null) ?? Math.floor(Math.random() * 9_999_999_999)

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
      const arr = extractComfyChoiceList(ckpts)
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

  const built = await buildComfyWorkflowNodes({
    baseUrl,
    model,
    prompt: String(cooked.prompt || '').trim(),
    negativePrompt: String(cooked.negativePrompt || '').trim(),
    width,
    height,
    seed,
    loras,
    policy,
    params: comfyParams
  })
  const workflow = built.workflow
  let comfyModelRef = ['1', 0]
  let nextId = Math.max(...Object.keys(workflow).map((x) => Number(x)).filter(Number.isFinite), 10) + 1
  const loraIds = Object.entries(workflow).filter(([, node]) => String(node?.class_type || '') === 'LoraLoader')
  if (loraIds.length) {
    const lastLoraId = String(loraIds[loraIds.length - 1][0])
    comfyModelRef = [lastLoraId, 0]
  }

  if (continuity && continuity.ipadapterEnabled && referenceImages.length) {
    const loaderSpec = await fetchComfyNodeSpec(baseUrl, 'IPAdapterModelLoader', 5000)
    const clipVisionSpec = await fetchComfyNodeSpec(baseUrl, 'CLIPVisionLoader', 5000)
    const applySpec =
      (await fetchComfyNodeSpec(baseUrl, 'IPAdapterAdvanced', 5000)) ||
      (await fetchComfyNodeSpec(baseUrl, 'IPAdapterApplyAdvanced', 5000)) ||
      (await fetchComfyNodeSpec(baseUrl, 'IPAdapterApply', 5000))
    const loadImageSpec = await fetchComfyNodeSpec(baseUrl, 'LoadImage', 5000)
    if (!loaderSpec || !clipVisionSpec || !applySpec || !loadImageSpec) {
      const e = new Error('comfyui_ipadapter_not_ready: missing CLIPVisionLoader/LoadImage/IPAdapter nodes')
      e.status = 502
      throw e
    }
    const ipAdapterModels = await fetchComfyModelList(baseUrl, '/models/ipadapter', 5000)
    const clipVisionModels = await fetchComfyModelList(baseUrl, '/models/clip_vision', 5000)
    const ipAdapterModel =
      pickPreferredComfyModel(ipAdapterModels, [
        process.env.COMFYUI_IPADAPTER_MODEL || '',
        'plus-face',
        'faceid',
        'ip-adapter-plus',
        'ipadapter'
      ]) || String(process.env.COMFYUI_IPADAPTER_MODEL || '').trim()
    const clipVisionModel =
      pickPreferredComfyModel(clipVisionModels, [
        process.env.COMFYUI_CLIP_VISION_MODEL || '',
        'vit-h',
        'clip-vit'
      ]) || String(process.env.COMFYUI_CLIP_VISION_MODEL || '').trim()
    if (!ipAdapterModel || !clipVisionModel) {
      const e = new Error('comfyui_ipadapter_not_ready: missing ipadapter/clip_vision models')
      e.status = 502
      throw e
    }

    const loaderId = String(nextId++)
    workflow[loaderId] = {
      class_type: 'IPAdapterModelLoader',
      inputs: buildInputsForComfyNode(loaderSpec, { ipadapter_file: ipAdapterModel })
    }
    const clipVisionId = String(nextId++)
    workflow[clipVisionId] = {
      class_type: 'CLIPVisionLoader',
      inputs: buildInputsForComfyNode(clipVisionSpec, { clip_name: clipVisionModel })
    }

    for (const ref of referenceImages) {
      if (!ref || !ref.bytes) continue
      const uploaded = await uploadComfyImage({
        baseUrl,
        bytes: ref.bytes,
        filename: ref.filename || `${ref.characterId || 'reference'}.png`,
        timeoutMs: timeoutMs <= 0 ? 15000 : Math.min(timeoutMs, 15000)
      })
      const imageNodeId = String(nextId++)
      workflow[imageNodeId] = {
        class_type: 'LoadImage',
        inputs: buildInputsForComfyNode(loadImageSpec, {
          image: uploaded.imageValue,
          upload: 'image'
        })
      }
      const applyNodeId = String(nextId++)
      const weight = clampFloat(ref.weight, 0.1, 1.5, 0.85)
      workflow[applyNodeId] = {
        class_type: String(applySpec.__classType || 'IPAdapterAdvanced'),
        inputs: buildInputsForComfyNode(applySpec, {
          model: comfyModelRef,
          ipadapter: [loaderId, 0],
          clip_vision: [clipVisionId, 0],
          image: [imageNodeId, 0],
          weight,
          weight_type: 'linear',
          combine_embeds: 'concat',
          start_at: 0,
          end_at: 1,
          embeds_scaling: 'V only'
        })
      }
      comfyModelRef = [applyNodeId, 0]
    }
  }

  for (const node of Object.values(workflow)) {
    if (!node || typeof node !== 'object') continue
    if (String(node.class_type || '') !== 'KSampler') continue
    if (!node.inputs || typeof node.inputs !== 'object') continue
    node.inputs.model = comfyModelRef
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
  const sniff = sniffImageMetaFromBytes(dl.bytes)
  if (!sniff) {
    const e = new Error('comfyui_view_download_invalid_image')
    e.status = 502
    throw e
  }
  return {
    bytes: dl.bytes,
    ext: sniff.ext || extFromContentType(dl.contentType),
    meta: {
      provider: 'comfyui',
      model: model || null,
      loras: loras.length ? loras.map((x) => x.name) : null,
      url: viewUrl,
      seed,
      workflowFamily: String(built?.policy?.family || 'basic'),
      cutoutApplied: Boolean(built?.usedCutout),
      steps: comfyParams.steps,
      cfgScale: comfyParams.cfg,
      sampler: comfyParams.samplerName,
      scheduler: comfyParams.scheduler,
      continuityUsed: Boolean(continuity && continuity.ipadapterEnabled && referenceImages.length),
      workflowMode: String(input && input.workflowMode || '').trim() || undefined,
      lockProfile: String(input && input.lockProfile || '').trim() || undefined
    }
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
    sequentialImageGeneration: input.sequentialImageGeneration || 'disabled',
    referenceImageUrls: Array.isArray(input.referenceImageUrls) ? input.referenceImageUrls : []
  })

  const continuityUsed = Boolean(
    String(input.sequentialImageGeneration || '').trim() === 'auto' ||
    /WORLD_ANCHOR:|CHARACTER_LOCKS:|ROLE_DEFINITION:|PROP_LOCKS:/i.test(String(prompt || ''))
  )

  if (res.bytes) {
    return {
      bytes: res.bytes,
      ext: res.ext || 'jpg',
      meta: { provider: 'doubao', api: 'ark', mode: res.mode || 'binary', continuityUsed }
    }
  }

  if (!res.url) {
    const e = new Error('doubao_invalid_response: missing image url')
    e.status = 502
    throw e
  }

  const dl = await curlDownload({ url: res.url, timeoutMs, proxyUrl })
  const sniff = sniffImageMetaFromBytes(dl.bytes)
  if (!sniff) {
    const e = new Error('doubao_download_invalid_image')
    e.status = 502
    throw e
  }
  return {
    bytes: dl.bytes,
    ext: sniff.ext || extFromContentType(dl.contentType),
    meta: { provider: 'doubao', api: 'ark', url: res.url, continuityUsed }
  }
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
