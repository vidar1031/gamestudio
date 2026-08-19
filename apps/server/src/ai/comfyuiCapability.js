// ComfyUI 能力检查：对比各工作流族所需节点/模型与实装情况，输出可自动修复项
import { readdir } from 'fs/promises'
import path from 'path'

const REQUIRED_FEATURES = {
  core: {
    label: '基础出图',
    nodes: ['CheckpointLoaderSimple', 'EmptyLatentImage', 'CLIPTextEncode', 'KSampler', 'VAEDecode', 'VAEEncode', 'LoadImage', 'SaveImage', 'ImageScale', 'LoraLoader'],
    models: []
  },
  ipadapter: {
    label: '参考图连续性（IPAdapter）',
    nodes: ['IPAdapterModelLoader', 'CLIPVisionLoader', 'IPAdapterAdvanced'],
    models: []
  },
  lineart: {
    label: '线稿锁定（ControlNet）',
    nodes: ['LineArtPreprocessor', 'AnimeLineArtPreprocessor', 'ControlNetLoader', 'SetUnionControlNetType', 'ControlNetApplyAdvanced'],
    anyOfNodes: [['LineArtPreprocessor', 'AnimeLineArtPreprocessor']],
    models: [{ dir: 'controlnet', exts: ['.safetensors', '.pth', '.ckpt', '.pt'], label: 'ControlNet 模型' }]
  },
  rmbg: {
    label: '白底抠图（RMBG）',
    nodes: ['RMBG'],
    models: []
  }
}

async function fetchJson(url, timeoutMs = 5000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { signal: ctrl.signal })
    if (!resp.ok) return null
    return await resp.json()
  } catch (_) {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function listModelFiles(comfyRoot, modelDir, exts) {
  const out = []
  const base = path.join(comfyRoot, 'models', modelDir)
  async function walk(dir, depth) {
    if (depth > 3) return
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(abs, depth + 1)
      else if (exts.some((ext) => entry.name.toLowerCase().endsWith(ext))) out.push(path.relative(base, abs))
    }
  }
  await walk(base, 0)
  return out
}

export async function checkComfyuiCapability({ baseUrl, comfyRoot }) {
  const normalizedBase = String(baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '')
  const root = String(comfyRoot || process.env.COMFYUI_ROOT || '/Volumes/ovokit2t/ComfyUI').trim()
  const objectInfo = await fetchJson(`${normalizedBase}/object_info`, 8000)
  if (!objectInfo) {
    return { ok: false, reachable: false, baseUrl: normalizedBase, features: {}, missingNodes: [], missingModels: [], fixable: false, message: 'ComfyUI 不可达' }
  }
  const installed = new Set(Object.keys(objectInfo))
  const features = {}
  const missingNodesAll = []
  const missingModelsAll = []

  for (const [key, feature] of Object.entries(REQUIRED_FEATURES)) {
    let missingNodes = feature.nodes.filter((node) => !installed.has(node))
    // anyOfNodes：组内任一存在即视为满足（如 LineArtPreprocessor / AnimeLineArtPreprocessor）
    for (const group of Array.isArray(feature.anyOfNodes) ? feature.anyOfNodes : []) {
      if (group.some((node) => installed.has(node))) {
        missingNodes = missingNodes.filter((node) => !group.includes(node))
      }
    }
    const missingModels = []
    for (const modelReq of feature.models) {
      const files = await listModelFiles(root, modelReq.dir, modelReq.exts)
      if (!files.length) missingModels.push({ ...modelReq, fixable: 'download' })
    }
    features[key] = { label: feature.label, ok: missingNodes.length === 0 && missingModels.length === 0, missingNodes, missingModels }
    missingNodesAll.push(...missingNodes)
    missingModelsAll.push(...missingModels.map((m) => m.label || m.dir))
  }

  const ok = Object.values(features).every((f) => f.ok)
  return {
    ok,
    reachable: true,
    baseUrl: normalizedBase,
    comfyRoot: root,
    features,
    missingNodes: [...new Set(missingNodesAll)],
    missingModels: [...new Set(missingModelsAll)],
    // 节点缺失通常由 Python 依赖导致，可通过 auto-fix 安装；模型缺失走下载
    fixable: true
  }
}
