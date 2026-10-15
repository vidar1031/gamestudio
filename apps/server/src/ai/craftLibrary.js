/**
 * 工艺知识库（V1.3）：storage/_shared/craft_library/ 的导演手册+表演指导技能件。
 *
 * 五类技能件（carrier 持物/载体、pose 姿态、emotion 情绪、shot 景别、performance 表现度），
 * 每件含 generation/placement/acceptance/aliases；跨故事公共复用（孔融让梨沉淀首发）。
 *
 * 约定：
 * - manifest.json 为注册真相源（skills 数组列相对路径）；件文件损坏/缺失单件跳过不拖垮整库；
 * - 加载带缓存（mtime 变化才重读）；全部 API 纯函数式（显式 reload 可清缓存）；
 * - 未知 id 容错（返回 null/空），不抛。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const DEFAULT_LIBRARY_DIR = path.join(REPO_ROOT, 'storage', '_shared', 'craft_library')

function libraryDir(root) {
  return root ? path.resolve(String(root)) : (process.env.STUDIO_CRAFT_LIBRARY_DIR || DEFAULT_LIBRARY_DIR)
}

let cache = null // { dir, manifestMtimeMs, skills: Map<id, skill>, summaries: [] }

function asStr(v) { return typeof v === 'string' ? v : '' }
function asList(v) { return Array.isArray(v) ? v : [] }

function loadLibrary(root) {
  const dir = libraryDir(root)
  let manifestMtimeMs = 0
  const manifestPath = path.join(dir, 'manifest.json')
  try {
    manifestMtimeMs = fs.statSync(manifestPath).mtimeMs
  } catch {
    // manifest 缺失：按空库处理（降级为现行为，不报错）
    cache = { dir, manifestMtimeMs: 0, skills: new Map(), summaries: [] }
    return cache
  }
  if (cache && cache.dir === dir && cache.manifestMtimeMs === manifestMtimeMs) return cache

  let manifest = null
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    cache = { dir, manifestMtimeMs, skills: new Map(), summaries: [] }
    return cache
  }
  const skills = new Map()
  for (const rel of asList(manifest && manifest.skills)) {
    const relPath = asStr(rel).trim()
    if (!relPath || relPath.includes('..')) continue
    const filePath = path.join(dir, relPath)
    let skill = null
    try {
      skill = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
      continue // 单件损坏/缺失跳过
    }
    const id = asStr(skill && skill.id).trim()
    if (!id) continue
    skills.set(id, skill)
  }
  const summaries = [...skills.values()].map((skill) => ({
    id: skill.id,
    name: asStr(skill.name).trim() || skill.id,
    category: asStr(skill.category).trim() || 'unknown',
    aliases: asList(skill.aliases).map((x) => asStr(x).trim()).filter(Boolean),
    description: asStr(skill.description).trim()
  }))
  cache = { dir, manifestMtimeMs, skills, summaries }
  return cache
}

/** 清缓存（测试/运维显式重读用） */
export function reloadCraftLibrary() {
  cache = null
}

/** 目录摘要：[{ id, name, category, aliases, description }]（manifest 顺序） */
export function listCraftSkills(root) {
  return loadLibrary(root).summaries
}

/** 取单件（未知 id 返回 null，不抛） */
export function getCraftSkill(id, root) {
  const key = asStr(id).trim()
  if (!key) return null
  return loadLibrary(root).skills.get(key) || null
}

/**
 * 文本命中技能件：id/名称/别名 子串命中（小写归一，名称与别名等价命中）。
 * 返回按目录序去重的 id 列表；无命中返回 []。
 */
export function matchCraftSkillsByText(text, root) {
  const hay = asStr(text).trim().toLowerCase()
  if (!hay) return []
  const { summaries } = loadLibrary(root)
  const out = []
  for (const skill of summaries) {
    const keys = [skill.name, ...skill.aliases].map((x) => x.toLowerCase()).filter(Boolean)
    if (keys.some((k) => k.length >= 2 && hay.includes(k))) out.push(skill.id)
  }
  return out
}

/**
 * 表现度规则：performance/levels.json 的 levels[level]（realistic/lite/full）。
 * 未知 level 回落 manifest 声明的 default（缺省 lite）；库缺失返回 null。
 */
export function getPerformanceRules(level, root) {
  const skill = getCraftSkill('performance.levels', root)
  if (!skill) return null
  const levels = skill.levels && typeof skill.levels === 'object' ? skill.levels : {}
  const requested = asStr(level).trim()
  const defaultKey = asStr(skill.default).trim() || 'lite'
  const rules = levels[requested] || levels[defaultKey] || null
  // 未知 level 回落 default：返回的 level 记实际命中的档位（不是请求原值）
  const resolvedKey = levels[requested] ? requested : defaultKey
  return rules ? { level: resolvedKey, ...rules } : null
}

// ---------------------------------------------------------------------------
// V1.3 载体摆位规划（placements 消费载体变体，纯函数便于单测）：
// 构图项带 carrier 类 skillIds 且资产已注册同 skillId 载体变体（poseVariants[].poseKey 命中
// 且有 projectAssetId）时：该角色摆位用变体；变体登记了 carrierPropAssetId 的被承载道具
// 不再独立摆位（covered_by_carrier）；双人载体（placement.mode=replace_both_with_pair）的
// 同场景另一带同 skillId 角色不再独立摆位（covered_by_carrier_pair）。
// 返回 { variantByAssetId: Map, coveredPropIds: Set, pairSkipAssetIds: Set }
// ---------------------------------------------------------------------------
export function resolveCarrierPlacementPlan({ compItems, presentAssets }, root) {
  const variantByAssetId = new Map()
  const coveredPropIds = new Set()
  const pairSkipAssetIds = new Set()
  const items = compItems instanceof Map ? compItems : new Map()
  if (!items.size) return { variantByAssetId, coveredPropIds, pairSkipAssetIds }
  const present = Array.isArray(presentAssets) ? presentAssets : []
  for (const [subjectId, item] of items) {
    const itemSkillIds = (Array.isArray(item && item.skillIds) ? item.skillIds : []).map((x) => asStr(x).trim()).filter(Boolean)
    if (!itemSkillIds.length) continue
    for (const skillId of itemSkillIds) {
      const skill = getCraftSkill(skillId, root)
      if (!skill || asStr(skill.category) !== 'carrier') continue
      const planAsset = present.find((a) => asStr(a && a.id).trim() === asStr(subjectId).trim())
      if (!planAsset) continue
      const variant = asList(planAsset.poseVariants)
        .find((v) => asStr(v && v.poseKey).trim() === skillId && asStr(v && v.projectAssetId).trim())
      if (!variant) continue
      variantByAssetId.set(asStr(planAsset.id), variant)
      const coveredPropId = asStr(variant.carrierPropAssetId).trim()
      if (coveredPropId) coveredPropIds.add(coveredPropId)
      if (asStr(skill.placement && skill.placement.mode) === 'replace_both_with_pair') {
        for (const [otherSubjectId, otherItem] of items) {
          if (otherSubjectId === subjectId) continue
          const otherSkillIds = (Array.isArray(otherItem && otherItem.skillIds) ? otherItem.skillIds : []).map((x) => asStr(x).trim())
          if (otherSkillIds.includes(skillId)) pairSkipAssetIds.add(otherSubjectId)
        }
      }
    }
  }
  return { variantByAssetId, coveredPropIds, pairSkipAssetIds }
}
