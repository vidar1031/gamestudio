// ComfyUI / SD-WebUI 探测与模型扫描助手（2026-10-20 index.js 拆分收尾迁出；函数体逐字未改）
import path from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { normalizeLocalPath } from '../studio/storeFs.js'

export function normalizeSdwebuiBaseUrl(raw) {
  let s = String(raw || '').trim()
  if (!s) s = String(process.env.SDWEBUI_BASE_URL || 'http://127.0.0.1:7860')
  s = s.replace(/\/+$/, '')
  s = s.replace(/\/sdapi\/v1$/i, '')
  return s || 'http://127.0.0.1:7860'
}

export function normalizeComfyuiBaseUrl(raw) {
  let s = String(raw || '').trim()
  if (!s) s = String(process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188')
  s = s.replace(/\/+$/, '')
  return s || 'http://127.0.0.1:8188'
}

export function normalizeComfyModelName(raw) {
  return String(raw || '').trim().replace(/\s+\[[^\]]+\]\s*$/, '').trim()
}

export function extractComfyChoiceList(raw) {
  // ComfyUI object_info enum field shape is usually:
  // - ["a.safetensors", ...]
  // - [["a.safetensors", ...], {"tooltip":"..."}]
  // This helper normalizes both.
  if (Array.isArray(raw) && raw.length >= 1 && Array.isArray(raw[0])) {
    return raw[0].map((x) => String(x || '').trim()).filter(Boolean)
  }
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x || '').trim()).filter(Boolean)
  }
  return []
}

export function extractStringListFromUnknown(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((x) => {
        if (x == null) return ''
        if (typeof x === 'string') return x.trim()
        if (typeof x === 'object') {
          const o = x
          return String(o.name || o.filename || o.file || o.model_name || '').trim()
        }
        return String(x).trim()
      })
      .filter(Boolean)
  }
  return []
}

export function normalizeConfiguredLoraNames(raw) {
  const arr = Array.isArray(raw) ? raw : []
  const out = []
  const seen = new Set()
  for (const item0 of arr) {
    const item = String(item0 || '').trim()
    if (!item) continue
    const name = String(item.split(':')[0] || '').trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

export function normalizeComfyModelKey(raw) {
  return normalizeComfyModelName(raw)
    .replace(/^.*[\\/]/, '')
    .replace(/\.(safetensors|ckpt|pt|pth)$/i, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase()
}

export function normalizeComfyLoraKey(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  const base = s.replace(/^.*[\\/]/, '')
  return base
    .replace(/\s+\[[^\]]+\]\s*$/, '')
    .replace(/\.(safetensors|ckpt|pt|pth)$/i, '')
    .trim()
    .toLowerCase()
}

export async function collectComfyCapabilities(baseUrl, timeoutMs, requiredNodes = null) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const nodes = Array.isArray(requiredNodes) && requiredNodes.length
      ? requiredNodes.map((x) => String(x || '').trim()).filter(Boolean)
      : ['CheckpointLoaderSimple', 'CLIPTextEncode', 'KSampler', 'VAEDecode', 'SaveImage']
    const checks = await Promise.all(nodes.map(async (node) => {
      const resp = await fetch(`${baseUrl}/object_info/${encodeURIComponent(node)}`, { method: 'GET', signal: controller.signal }).catch(() => null)
      return { node, ok: Boolean(resp && resp.ok) }
    }))
    const missingNodes = checks.filter((x) => !x.ok).map((x) => x.node)

    const [ckptInfoResp, ckptListResp, modelsResp, loraListResp, loraInfoResp] = await Promise.all([
      fetch(`${baseUrl}/object_info/CheckpointLoaderSimple`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/models/checkpoints`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/models`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/models/loras`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/object_info/LoraLoader`, { method: 'GET', signal: controller.signal }).catch(() => null)
    ])

    const modelSet = new Set()
    const loraSet = new Set()

    const ckptInfoJson = ckptInfoResp && ckptInfoResp.ok ? await ckptInfoResp.json().catch(() => null) : null
    const ckpts = ckptInfoJson && ckptInfoJson.CheckpointLoaderSimple && ckptInfoJson.CheckpointLoaderSimple.input && ckptInfoJson.CheckpointLoaderSimple.input.required
      ? ckptInfoJson.CheckpointLoaderSimple.input.required.ckpt_name
      : null
    for (const x of extractComfyChoiceList(ckpts)) modelSet.add(String(x || '').trim())

    const ckptListJson = ckptListResp && ckptListResp.ok ? await ckptListResp.json().catch(() => null) : null
    for (const x of extractStringListFromUnknown(ckptListJson)) modelSet.add(String(x || '').trim())

    const modelsJson = modelsResp && modelsResp.ok ? await modelsResp.json().catch(() => null) : null
    if (modelsJson && typeof modelsJson === 'object') {
      for (const x of extractStringListFromUnknown(modelsJson.checkpoints)) modelSet.add(String(x || '').trim())
      for (const x of extractStringListFromUnknown(modelsJson.loras)) loraSet.add(String(x || '').trim())
    }

    const loraListJson = loraListResp && loraListResp.ok ? await loraListResp.json().catch(() => null) : null
    for (const x of extractStringListFromUnknown(loraListJson)) loraSet.add(String(x || '').trim())

    const loraInfoJson = loraInfoResp && loraInfoResp.ok ? await loraInfoResp.json().catch(() => null) : null
    const loraNames = loraInfoJson && loraInfoJson.LoraLoader && loraInfoJson.LoraLoader.input && loraInfoJson.LoraLoader.input.required
      ? loraInfoJson.LoraLoader.input.required.lora_name
      : null
    for (const x of extractComfyChoiceList(loraNames)) loraSet.add(String(x || '').trim())

    return {
      ok: true,
      missingNodes,
      models: Array.from(modelSet).filter(Boolean),
      loras: Array.from(loraSet).filter(Boolean)
    }
  } finally {
    clearTimeout(t)
  }
}

export async function fetchComfyModelList(baseUrl, path, signal) {
  try {
    const resp = await fetch(`${baseUrl}${path}`, { method: 'GET', signal }).catch(() => null)
    if (!resp) return { ok: false, status: 0, supported: false, list: [] }
    if (Number(resp.status || 0) === 404) return { ok: false, status: 404, supported: false, list: [] }
    const json = resp.ok ? await resp.json().catch(() => null) : null
    const list = Array.isArray(json) ? json.map((x) => String(x || '').trim()).filter(Boolean) : []
    return { ok: Boolean(resp.ok), status: Number(resp.status || 0), supported: true, list }
  } catch (_) {
    return { ok: false, status: 0, supported: false, list: [] }
  }
}

export async function probeComfyAnyNode(baseUrl, names, signal) {
  const tried = []
  for (const n0 of names) {
    const n = String(n0 || '').trim()
    if (!n) continue
    tried.push(n)
    const resp = await fetch(`${baseUrl}/object_info/${encodeURIComponent(n)}`, { method: 'GET', signal }).catch(() => null)
    if (resp && resp.ok) return { ok: true, found: n, tried }
  }
  return { ok: false, found: '', tried }
}

export async function isDir(p) {
  try {
    const st = await stat(String(p))
    return Boolean(st && st.isDirectory())
  } catch (_) {
    return false
  }
}

export async function pickExistingDir(root, candidates) {
  const base = String(root || '').trim()
  if (!base) return ''
  for (const c0 of candidates) {
    const c = String(c0 || '').trim()
    if (!c) continue
    const p = path.join(base, c)
    if (await isDir(p)) return p
  }
  return ''
}

export async function hasAnyModelInDirs(dirs) {
  const list = Array.isArray(dirs) ? dirs.map((x) => String(x || '').trim()).filter(Boolean) : []
  let total = 0
  for (const d of list) {
    const r = await hasAnyModelFile(d)
    if (r.ok && r.count) {
      total += r.count
      break
    }
  }
  return { ok: true, count: total }
}

export async function hasAnyModelFile(dirPath) {
  try {
    const dir = String(dirPath || '').trim()
    if (!dir) return { ok: false, count: 0 }
    if (!(await isDir(dir))) return { ok: true, count: 0 }
    const items = await readdir(dir).catch(() => [])
    let count = 0
    for (const name of items) {
      const s = String(name || '')
      if (!s) continue
      if (!/\.(safetensors|ckpt|pt|pth|bin)$/i.test(s)) continue
      count += 1
      if (count >= 1) break
    }
    return { ok: true, count }
  } catch (_) {
    return { ok: false, count: 0 }
  }
}

export async function resolveSdWebuiModelsBase(root) {
  const raw = normalizeLocalPath(root)
  if (!raw) return ''
  if (await isDir(raw)) {
    // If user passed the webui root (contains "models/"), normalize to "<root>/models".
    const maybeModels = path.join(raw, 'models')
    if (await isDir(maybeModels)) return maybeModels
    return raw
  }
  return raw
}

export async function pickCheckpointDir(modelsBase) {
  const base = normalizeLocalPath(modelsBase)
  if (!base) return ''
  if (await isDir(base)) {
    // Some users point Models Root directly at the checkpoint folder.
    const items = await readdir(base).catch(() => [])
    if (items.some((x) => /\.(safetensors|ckpt)$/i.test(String(x || '')))) return base
  }
  return await pickExistingDir(base, ['Stable-diffusion', 'checkpoints', 'Checkpoint', 'Checkpoints'])
}

export async function pickLoraDir(modelsBase) {
  const base = normalizeLocalPath(modelsBase)
  if (!base) return ''
  if (await isDir(base)) {
    // Some users point Models Root directly at the LoRA folder.
    const items = await readdir(base).catch(() => [])
    if (items.some((x) => /\.safetensors$/i.test(String(x || '')))) return base
  }
  return await pickExistingDir(base, ['Lora', 'loras', 'LoRA', 'lora'])
}

export async function scanModelFiles(rootDir, { exts, maxDepth = 4 }) {
  const out = []
  const want = new Set((exts || []).map((x) => String(x || '').toLowerCase()).filter(Boolean))
  if (!rootDir) return out

  async function walk(dir, depth) {
    if (depth > maxDepth) return
    let ents = []
    try {
      ents = await readdir(dir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const ent of ents) {
      const name = String(ent && ent.name ? ent.name : '')
      if (!name || name.startsWith('.')) continue
      const full = path.join(dir, name)
      if (ent.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!ent.isFile()) continue
      const lower = name.toLowerCase()
      // Ignore common sidecar files.
      if (
        lower.endsWith('.civitai.info') ||
        lower.endsWith('.preview.png') ||
        lower.endsWith('.png') ||
        lower.endsWith('.jpg') ||
        lower.endsWith('.jpeg') ||
        lower.endsWith('.webp') ||
        lower.endsWith('.txt') ||
        lower.endsWith('.yaml') ||
        lower.endsWith('.yml')
      ) {
        continue
      }
      const ext = path.extname(lower)
      if (!want.has(ext)) continue
      const rel = path.relative(rootDir, full).split(path.sep).join('/')
      out.push(rel)
    }
  }

  await walk(rootDir, 0)
  out.sort((a, b) => a.localeCompare(b))
  return out
}
