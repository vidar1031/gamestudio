import crypto from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// ============ 公共提示词库（2026-09-10） ============
// 跨项目共享的出图提示词片段库：儿童绘本互动故事实测沉淀的公共约束（风格锁/参考图约束/排除包），
// 用户可在锁定事物向导每个提示词输入旁打开库选择插入，也可把当前内容存回库中。
// 文件即真相源：storage/_config/prompt_library.json；首次读取时播种内置条目。

function nowIso() {
  try { return new Date().toISOString() } catch (_) { return String(Date.now()) }
}

export function promptLibraryFilePath(storageRoot) {
  const root = String(storageRoot || '').trim()
  if (!root) throw new Error('missing_storage_root')
  return path.join(root, '_config', 'prompt_library.json')
}

// 内置种子：源自《乌鸦喝水》等绘本故事实测提示词沉淀（参考图 hint / 拟人排除 / 多视图排除等）
const SEED_ENTRIES = [
  {
    id: 'seed_pos_picture_book',
    name: '绘本平涂风格锁',
    kind: 'positive',
    textZh: '卡通童话绘本风格，扁平2D插画，粗净轮廓线，赛璐璐上色，暖色柔和配色',
    textEn: 'cartoon fairy tale picture book style, flat 2D illustration, bold clean outlines, cel shading, warm soft color palette'
  },
  {
    id: 'seed_pos_char_ref',
    name: '角色立绘参考约束',
    kind: 'positive',
    textZh: '单一角色全身正面参考图，纯白背景，居中展示，画面只有这一个角色，脸型与服装稳定',
    textEn: 'single full-body front view of one character only, pure white background, centered single view, stable face and outfit'
  },
  {
    id: 'seed_pos_prop_ref',
    name: '道具参考图约束',
    kind: 'positive',
    textZh: '单一物件参考图，稳定透视，居中构图，仅画物件本身，纯白背景，无人物，无场景，无额外杂物',
    textEn: 'single rigid object reference, stable perspective, exactly one object only, centered composition, pure white background, no people, no scene, no extra clutter'
  },
  {
    id: 'seed_pos_scene_ref',
    name: '场景环境约束',
    kind: 'positive',
    textZh: '环境概念图，无角色，稳定布局，空间结构清晰，可复用的地点参考',
    textEn: 'environment concept art, no characters, stable layout, clear spatial structure, reusable location reference'
  },
  {
    id: 'seed_pos_chroma_char',
    name: '绿幕角色约束',
    kind: 'positive',
    textZh: '纯绿幕背景（RGB 0,255,0），单一角色居中，全身，边缘干净清晰',
    textEn: 'solid pure green screen background (RGB 0,255,0 chroma key green), flat uniform green, no gradient, no texture, single character centered, full body, clean sharp edges'
  },
  {
    id: 'seed_pos_chroma_prop',
    name: '绿幕道具约束',
    kind: 'positive',
    textZh: '纯绿幕背景，单件道具居中完整，无角色无人物，边缘干净清晰',
    textEn: 'solid pure green screen background (RGB 0,255,0 chroma key green), single object centered, fully visible, no character, no people, clean sharp edges'
  },
  {
    id: 'seed_pos_back_view',
    name: '背身视角配方',
    kind: 'positive',
    textZh: '背身视角，背对镜头，面朝远离镜头方向（1.4 加权）',
    textEn: '(back view, view from behind, facing away from viewer:1.4)'
  },
  {
    id: 'seed_pos_costume',
    name: '服装延续约束',
    kind: 'positive',
    textZh: '服装与主参考保持一致，不得换装',
    textEn: 'outfit consistent with the main reference, no costume change'
  },
  {
    id: 'seed_neg_general',
    name: '通用负向包',
    kind: 'negative',
    textZh: '文字，水印，低质量，模糊，畸形，多人物，复杂背景',
    textEn: 'text, watermark, low quality, blurry, deformed, multiple people, complex background'
  },
  {
    id: 'seed_neg_realistic',
    name: '写实排除包',
    kind: 'negative',
    textZh: '写实，照片级真实，3D渲染，CGI，油画，厚涂',
    textEn: 'realistic, photorealistic, 3d render, cgi, oil painting, impasto'
  },
  {
    id: 'seed_neg_anthro',
    name: '拟人化排除包（动物角色专用）',
    kind: 'negative',
    textZh: '拟人化，人体，人脸，人形，兽人，福瑞，Q版，肌肉，胸肌，手臂肌肉',
    textEn: 'anthropomorphic, human, human face, human body, humanoid, furry, kemonomimi, chibi, muscular chest, pecs, biceps'
  },
  {
    id: 'seed_neg_multiview',
    name: '多视图排除包',
    kind: 'negative',
    textZh: '多视图，九宫格，网格排列，重复，多个副本，拼接图',
    textEn: 'multiple views, grid layout, 3x3 grid, repeated, duplicates, multiple copies, collage'
  },
  {
    id: 'seed_neg_clutter',
    name: '参考图纯净包（立绘/道具用）',
    kind: 'negative',
    textZh: '人物，角色，场景背景，环境，手持，佩戴展示，额外杂物，文字，水印',
    textEn: 'person, character, scene background, environment, hands, holding, wearing, extra objects, text, watermark'
  }
]

function normalizeKind(kind) {
  return String(kind || '').trim() === 'negative' ? 'negative' : 'positive'
}

function normalizeEntry(input) {
  if (!input || typeof input !== 'object') return null
  const textZh = String(input.textZh || '').trim()
  const textEn = String(input.textEn || '').trim()
  if (!textZh && !textEn) return null
  return {
    id: String(input.id || '').trim() || (crypto.randomUUID ? crypto.randomUUID() : `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    name: String(input.name || '').trim() || '未命名提示词',
    kind: normalizeKind(input.kind),
    textZh,
    textEn,
    builtin: input.builtin === true,
    createdAt: String(input.createdAt || '').trim() || nowIso(),
    updatedAt: String(input.updatedAt || '').trim() || nowIso()
  }
}

async function writeLibrary(storageRoot, entries) {
  const p = promptLibraryFilePath(storageRoot)
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify({ schemaVersion: '1.0', updatedAt: nowIso(), entries }, null, 2), 'utf-8')
}

export async function listPromptLibraryEntries(storageRoot) {
  const p = promptLibraryFilePath(storageRoot)
  let entries = null
  try {
    const raw = await readFile(p, 'utf-8')
    const json = JSON.parse(raw)
    if (Array.isArray(json?.entries)) entries = json.entries.map(normalizeEntry).filter(Boolean)
  } catch (_) {
    entries = null
  }
  if (!entries) {
    // 首次使用：播种内置公共提示词（儿童绘本互动故事实测沉淀）
    entries = SEED_ENTRIES.map((item) => normalizeEntry({ ...item, builtin: true })).filter(Boolean)
    await writeLibrary(storageRoot, entries)
  }
  const rank = { positive: 0, negative: 1 }
  return entries.sort((a, b) => (rank[a.kind] - rank[b.kind]) || String(a.createdAt).localeCompare(String(b.createdAt)))
}

export async function addPromptLibraryEntry(storageRoot, input) {
  const entry = normalizeEntry({ ...input, id: '', builtin: false })
  if (!entry) throw new Error('missing_prompt_text')
  const entries = await listPromptLibraryEntries(storageRoot)
  await writeLibrary(storageRoot, [...entries, entry])
  return entry
}

export async function updatePromptLibraryEntry(storageRoot, id, patch) {
  const target = String(id || '').trim()
  if (!target) throw new Error('missing_id')
  const entries = await listPromptLibraryEntries(storageRoot)
  const index = entries.findIndex((item) => item.id === target)
  if (index < 0) return null
  const merged = normalizeEntry({ ...entries[index], ...(patch && typeof patch === 'object' ? patch : {}), id: target, builtin: entries[index].builtin, createdAt: entries[index].createdAt, updatedAt: nowIso() })
  if (!merged) throw new Error('missing_prompt_text')
  entries[index] = merged
  await writeLibrary(storageRoot, entries)
  return merged
}

export async function deletePromptLibraryEntry(storageRoot, id) {
  const target = String(id || '').trim()
  if (!target) throw new Error('missing_id')
  const entries = await listPromptLibraryEntries(storageRoot)
  const next = entries.filter((item) => item.id !== target)
  const removed = next.length !== entries.length
  if (removed) await writeLibrary(storageRoot, next)
  return { removed, entries: next }
}
