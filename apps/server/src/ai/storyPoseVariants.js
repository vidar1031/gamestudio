// 2026-10-10 姿势变体自动编排（自动化②）：提取剧情姿势需求 → 匹配公共骨架库 →
// 骨架驱动生成变体 → 按场景绑定登记。全链串行（本地资源互斥），aiTask 暴露进度。
// 设计约束：站立类姿势不出变体（主参考覆盖）；无骨架匹配的需求记 unmatched 供姿势库扩展；
// 弱标记物种（猪/羊等）提示词显性物种词 + ipadapterWeight 0.95（三只小猪猪变人事故配方）。
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { generateComfyuiPoseVariantSprite } from './background.js'

const asStr = (v) => String(v == null ? '' : v)
const asList = (v) => (Array.isArray(v) ? v : [])

// 弱物种标记提示（三小猪事故配方）：锚点含动物词时显性强化 + 身份权重拉满
// V1.3：表现度落锚共用本判定，补 乌鸦/crow/壁虎/gecko（工艺库 realistic 样例正是这两类）
const ANIMAL_HINT_RE = /兔|rabbit|猪|pig|狼|wolf|猫|cat|狗|dog|猴|monkey|龟|turtle|熊|bear|狐|fox|羊|sheep|鸟|bird|鸭|duck|鸡|chick|乌鸦|crow|壁虎|gecko/i
export function isAnimalLikeAnchor(text) {
  return ANIMAL_HINT_RE.test(asStr(text))
}

export async function loadPoseLibraryManifest(storageRoot) {
  // storageRoot = apps/server 的 ROOT（即 storage/ 目录）
  const libDir = path.join(storageRoot, '_shared', 'pose_library')
  try {
    const manifest = JSON.parse(await readFile(path.join(libDir, 'manifest.json'), 'utf-8'))
    return { libDir, poses: manifest && typeof manifest.poses === 'object' ? manifest.poses : {} }
  } catch (_) {
    return { libDir, poses: {} }
  }
}

// 姿势词（中文，来自 LLM 提取）→ 姿势库 key：别名包含匹配
export function matchPoseKey(poses, poseZh) {
  const t = asStr(poseZh).trim()
  if (!t) return ''
  for (const [key, def] of Object.entries(poses)) {
    for (const alias of asList(def && def.cn)) {
      if (alias && t.includes(alias)) return key
    }
  }
  return ''
}

// 按（角色 × 姿势key）分组场景需求；standing 类不需要变体
export function groupPoseRequirements(poseStates, poses) {
  const groups = new Map()
  const unmatched = []
  for (const scene of asList(poseStates && poseStates.scenes)) {
    const sceneId = asStr(scene && scene.sceneId).trim()
    if (!sceneId) continue
    for (const st of asList(scene && scene.characterStates)) {
      const characterId = asStr(st && st.characterId).trim()
      if (!characterId) continue
      const key = matchPoseKey(poses, st.pose)
      if (!key) {
        if (asStr(st.pose).trim()) unmatched.push({ sceneId, characterId, pose: asStr(st.pose).trim(), action: asStr(st.action).trim() })
        continue
      }
      if (poses[key] && poses[key].skipVariant) continue
      const gk = `${characterId}::${key}`
      const cur = groups.get(gk) || { characterId, poseKey: key, sceneIds: [], action: '', expression: '', evidence: '' }
      if (!cur.sceneIds.includes(sceneId)) cur.sceneIds.push(sceneId)
      if (!cur.action && asStr(st.action).trim()) cur.action = asStr(st.action).trim()
      if (!cur.expression && asStr(st.expression).trim()) cur.expression = asStr(st.expression).trim()
      if (!cur.evidence && asStr(st.evidence).trim()) cur.evidence = asStr(st.evidence).trim()
      groups.set(gk, cur)
    }
  }
  return { groups: [...groups.values()], unmatched }
}

// 变体提示词：身份（英文锚点/参考提示词）+ 姿势（英文）+ 表情/动作 + 单主体 + 白底 + 画风
export function buildPoseVariantPrompt({ asset, poseDef, group, globalStyleEn }) {
  const identity = asStr(asset && (asset.referencePromptEn || asset.anchorPromptEn || asset.anchorPrompt)).trim()
  const speciesBoost = isAnimalLikeAnchor(`${identity} ${asStr(asset && asset.name)}`)
    ? ' IMPORTANT: the character is an animal, keep the animal head and animal features, NOT a human face.'
    : ''
  const parts = [
    'one single character only:',
    identity,
    `${asStr(poseDef && poseDef.en)}`,
    asStr(group && group.action).trim() ? `action: ${asStr(group.action).trim()}` : '',
    asStr(group && group.expression).trim() ? `${asStr(group.expression).trim()} expression` : '',
    'full body, pure white background',
    asStr(globalStyleEn).trim() || 'cartoon fairy tale picture book style, flat 2D illustration, clean outlines, cel shading'
  ].filter(Boolean)
  return parts.join(', ') + '.' + speciesBoost
}

// 生成单组变体：骨架图 + 身份抠图 → pose-variant 链
export async function generatePoseVariantForGroup({ root, libDir, poseDef, identityBytes, identityFilename, prompt, comfyuiBaseUrl, timeoutMs, prefix, ipadapterWeight }) {
  const skeletonBytes = await readFile(path.join(libDir, asStr(poseDef.file)))
  return generateComfyuiPoseVariantSprite({
    identityReferenceBytes: identityBytes,
    identityReferenceFilename: identityFilename,
    poseSkeletonBytes: skeletonBytes,
    comfyuiBaseUrl,
    prompt,
    negativePrompt: 'multiple people, duplicate, text, watermark, realistic, photo, deformed, extra limbs',
    width: 768,
    height: 512,
    steps: 24,
    cfgScale: 6,
    ipadapterWeight: Number.isFinite(Number(ipadapterWeight)) ? Number(ipadapterWeight) : 0.85,
    ipadapterStartAt: 0.25,
    ipadapterEndAt: 0.9,
    controlStrength: 0.9,
    controlEndPercent: 0.9,
    timeoutMs,
    prefix: prefix || 'talkscene_pose/auto_variant'
  })
}
