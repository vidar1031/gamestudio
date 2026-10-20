// 项目间故事资产继承（2026-10-20 index.js 拆分收尾迁出；函数体逐字未改）
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { genId } from '../ai/scripts.js'
import { summarizeStoryAssetPlan } from '../ai/storyAssets.js'
import { createAiTask, updateAiTask } from '../ai/taskProgress.js'
import { createImageReview, decideImageReview, findPendingReview } from '../review/imageReviewStore.js'
import { logStage } from '../ai/runtime.js'
import { existsDir, existsFile, nowIso, projectDir, PROJECTS_DIR, readJson, writeJson } from './storeFs.js'
import { readStoryAssetPlanIfExists, saveStoryAssetPlan } from '../ai/storyAssetPlanStore.js'

// 《小明的工作日2》/《小明的工作日 2》→ 小明的工作日；无数字后缀返回 ''
export function resolveInheritBaseTitle(title) {
  const t = String(title || '').trim()
  const m = /^(.*?)[\s_\-]*\d+$/.exec(t)
  const base = m ? String(m[1] || '').trim() : ''
  return base && base !== t ? base : ''
}

export async function findProjectIdByTitle(title, { excludeId = '' } = {}) {
  const want = String(title || '').trim()
  if (!want) return null
  const dirs = await readdir(PROJECTS_DIR).catch(() => [])
  let best = null
  for (const pid of dirs) {
    if (String(pid) === String(excludeId)) continue
    const dir = projectDir(pid)
    if (!(await existsDir(dir))) continue
    const meta = await readJson(path.join(dir, 'meta.json')).catch(() => null)
    if (String(meta?.title || '').trim() !== want) continue
    const stamp = String(meta?.confirmedAt || meta?.updatedAt || '')
    if (!best || stamp > best.stamp) best = { id: String(pid), stamp }
  }
  return best ? best.id : null
}

// 复制项目内相对路径文件（源项目→目标项目，保持相对路径不变），带越界守卫
export async function copyProjectAssetFile({ sourceDir, targetDir, relPath }) {
  const rel = String(relPath || '').trim().replace(/^\/+/, '')
  if (!rel) return ''
  const srcAbs = path.resolve(sourceDir, rel)
  if (!srcAbs.startsWith(path.resolve(sourceDir) + path.sep)) return ''
  if (!(await existsFile(srcAbs))) return ''
  const dstAbs = path.resolve(targetDir, rel)
  if (!dstAbs.startsWith(path.resolve(targetDir) + path.sep)) return ''
  await mkdir(path.dirname(dstAbs), { recursive: true })
  await copyFile(srcAbs, dstAbs)
  return rel
}

export async function inheritStoryAssetsFromProject({ id, dir, sourceId, force = false }) {
  const srcDir = projectDir(sourceId)
  if (!(await existsDir(srcDir))) {
    const e = new Error(`继承源项目不存在：${sourceId}`)
    e.code = 'inherit_source_not_found'
    throw e
  }
  const srcPlan = await readStoryAssetPlanIfExists(sourceId)
  if (!srcPlan || !Array.isArray(srcPlan.assets)) {
    const e = new Error('继承源项目没有资产计划')
    e.code = 'inherit_source_missing_plan'
    throw e
  }
  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan || !Array.isArray(plan.assets)) {
    const e = new Error('请先生成资产计划，再执行继承。')
    e.code = 'missing_plan'
    throw e
  }
  const srcProject = await readJson(path.join(srcDir, 'project.json')).catch(() => null)
  const srcBg = srcProject?.state?.aiBackground && typeof srcProject.state.aiBackground === 'object' ? srcProject.state.aiBackground : {}
  const srcAssetPrompts = srcBg.storyboardLockAssetPrompts && typeof srcBg.storyboardLockAssetPrompts === 'object' ? srcBg.storyboardLockAssetPrompts : {}
  const normName = (s) => String(s || '').trim().toLowerCase().replace(/[\s《》「」]/g, '')
  const srcByName = new Map()
  for (const a of srcPlan.assets) {
    const key = `${String(a?.category || '').trim()}|${normName(a?.name)}`
    if (key.endsWith('|')) continue
    if (!srcByName.has(key)) srcByName.set(key, a)
  }
  // 2026-10-08 近名模糊匹配（故事2 圣经命名漂移实证：黄色骑手服 vs 黄色外卖骑手服、外卖头盔 vs 骑行头盔）：
  // ①包含匹配（长名含短名且短名 ≥3 字）；②共享 ≥2 字尾缀（头盔/街道/西服类）。
  // 仅当同类别下候选唯一才采纳，多候选/零候选一律未匹配（错配比漏配更糟——错配会锁错参考图）。
  const sharedTailLen = (a, b) => {
    let n = 0
    while (n < Math.min(a.length, b.length) && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1
    return n
  }
  const fuzzyMatchSource = (tCat, tName) => {
    const tn = normName(tName)
    if (tn.length < 2) return null
    const candidates = []
    for (const a of srcPlan.assets) {
      if (String(a?.category || '').trim() !== tCat) continue
      const sn = normName(a?.name)
      if (!sn || sn === tn) continue
      const shorter = tn.length <= sn.length ? tn : sn
      const longer = tn.length <= sn.length ? sn : tn
      if (shorter.length >= 3 && longer.includes(shorter)) { candidates.push(a); continue }
      if (sharedTailLen(tn, sn) >= 2) candidates.push(a)
    }
    return candidates.length === 1 ? candidates[0] : null
  }

  const summary = { sourceId, inherited: [], skipped: [], unmatched: [] }
  const newProjectAssets = []
  const lockTraces = []
  const nextAssets = []
  const matchedSrcByTargetId = new Map()

  for (const target of plan.assets) {
    const tCat = String(target?.category || '').trim()
    const tId = String(target?.id || '').trim()
    const tName = String(target?.name || '').trim()
    if (!tId) { nextAssets.push(target); continue }
    const srcExact = srcByName.get(`${tCat}|${normName(tName)}`) || null
    const src = srcExact || fuzzyMatchSource(tCat, tName)
    if (!src) {
      if (tCat === 'character' || tCat === 'prop') summary.unmatched.push({ assetId: tId, name: tName, category: tCat })
      nextAssets.push(target)
      continue
    }
    if (!force && String(target?.inheritedFrom || '').trim() && String(target?.referenceStatus || '') === 'ready') {
      summary.skipped.push({ assetId: tId, name: tName, reason: 'already_inherited' })
      nextAssets.push(target)
      continue
    }

    const label = `${tName}(${tCat})`
    const patch = { inheritedFrom: String(sourceId) }
    matchedSrcByTargetId.set(tId, src)
    let copied = 0
    // 1) 锁定参考图
    const srcRefUri = String(src?.primaryReferenceAssetUri || '').trim()
    if (srcRefUri) {
      const rel = await copyProjectAssetFile({ sourceDir: srcDir, targetDir: dir, relPath: srcRefUri })
      if (rel) {
        const projectAssetId = genId('asset')
        newProjectAssets.push({
          id: projectAssetId,
          kind: 'image',
          name: `继承参考·${tName}`,
          uri: rel,
          source: { type: 'ai', provider: 'inherit', inheritedFrom: String(sourceId), prompt: String(src?.referencePromptEn || '').trim() }
        })
        patch.primaryReferenceAssetId = projectAssetId
        patch.primaryReferenceAssetUri = rel
        patch.primaryReferenceSelectedAt = nowIso()
        patch.referenceStatus = 'ready'
        copied += 1
        lockTraces.push({ planAssetId: tId, resultImagePath: rel, prompt: String(src?.referencePromptEn || '').trim() })
      }
    }
    // 2) 提示词四套（锚点 + 参考图提示词，与参考图同一证据链，必须整套继承）
    // 2026-10-08 地点锚点不继承（故事2 实证缺陷）：地点锚点含时间/氛围语境（晨光照 vs 夜晚霓虹），
    // 继承会把基底故事的时间覆盖故事2 自有圣经锚点——地点锚点始终保留目标项目圣经原文。
    const skipAnchor = tCat === 'location'
    for (const [sk, tk] of [['anchorPrompt', 'anchorPrompt'], ['negativePrompt', 'negativePrompt'], ['referencePromptZh', 'referencePromptZh'], ['referencePromptEn', 'referencePromptEn'], ['referenceNegativePromptZh', 'referenceNegativePromptZh'], ['referenceNegativePrompt', 'referenceNegativePrompt'], ['referencePromptHint', 'referencePromptHint']]) {
      if (skipAnchor && (sk === 'anchorPrompt' || sk === 'negativePrompt')) continue
      const v = String(src?.[sk] || '').trim()
      if (v) patch[tk] = v
    }
    // 3) 姿势/状态变体（文件复制 + 重新登记；sceneIds 清空，故事2 场景自绑定）
    const srcVariants = [
      ...(Array.isArray(src?.poseVariants) ? src.poseVariants : []),
      ...(Array.isArray(src?.stateVariants) ? src.stateVariants : [])
    ]
    if (srcVariants.length) {
      const variants = []
      for (const v of srcVariants) {
        const cutRel = await copyProjectAssetFile({ sourceDir: srcDir, targetDir: dir, relPath: v?.cutoutPath })
        if (!cutRel) continue
        const greenRel = await copyProjectAssetFile({ sourceDir: srcDir, targetDir: dir, relPath: v?.greenPath })
        const projectAssetId = genId('asset')
        newProjectAssets.push({
          id: projectAssetId,
          kind: 'image',
          name: `继承姿势·${tName}·${String(v?.name || '').trim()}`,
          uri: cutRel,
          source: { type: 'ai', provider: 'inherit', inheritedFrom: String(sourceId), prompt: String(v?.posePrompt || v?.promptEn || '').trim() }
        })
        variants.push({
          id: genId('pose'),
          name: String(v?.name || '').trim(),
          sceneId: '',
          posePrompt: String(v?.posePrompt || '').trim(),
          promptZh: String(v?.promptZh || '').trim(),
          promptEn: String(v?.promptEn || v?.posePrompt || '').trim(),
          ...(String(v?.stateKey || '').trim() ? { stateKey: String(v.stateKey).trim() } : {}),
          greenPath: greenRel || '',
          cutoutPath: cutRel,
          projectAssetId,
          projectAssetUri: cutRel,
          inheritedFrom: String(sourceId),
          createdAt: nowIso()
        })
        copied += 1
      }
      if (variants.length) patch.poseVariants = variants
    }
    // 4) 线稿（文件 + 字段）
    for (const [fk, ik] of [['lineartHintAssetUri', 'lineartHintAssetId'], ['lineartFinalAssetUri', 'lineartFinalAssetId']]) {
      const srcUri = String(src?.[fk] || '').trim()
      if (!srcUri) continue
      const rel = await copyProjectAssetFile({ sourceDir: srcDir, targetDir: dir, relPath: srcUri })
      if (!rel) continue
      const projectAssetId = genId('asset')
      newProjectAssets.push({
        id: projectAssetId,
        kind: 'image',
        name: `继承线稿·${tName}`,
        uri: rel,
        source: { type: 'ai', provider: 'inherit', inheritedFrom: String(sourceId) }
      })
      patch[fk] = rel
      patch[ik] = projectAssetId
      copied += 1
    }
    if (String(src?.lineartStatus || '').trim()) patch.lineartStatus = String(src.lineartStatus).trim()
    if (String(src?.lineartPrompt || '').trim()) patch.lineartPrompt = String(src.lineartPrompt).trim()
    if (String(src?.lineartNegativePrompt || '').trim()) patch.lineartNegativePrompt = String(src.lineartNegativePrompt).trim()

    nextAssets.push({ ...target, ...patch })
    summary.inherited.push({ assetId: tId, name: tName, category: tCat, matchedName: String(src?.name || '').trim(), matchType: srcExact ? 'exact' : 'fuzzy', filesCopied: copied, variants: Array.isArray(patch.poseVariants) ? patch.poseVariants.length : 0 })
  }

  // 5) 全局提示词 + worldAnchor + 提示词闸（基底已批准 → 直接置闸）
  const nextPlan = { ...plan, generatedAt: nowIso(), assets: nextAssets }
  if (String(srcPlan.worldAnchor || '').trim()) nextPlan.worldAnchor = String(srcPlan.worldAnchor).trim()
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })

  // 6) project.json：登记资产 + 提示词/闸/全局（读最新盘 → 写回 → 读回验证，F-63 教训）
  const projPath = path.join(dir, 'project.json')
  const proj = await readJson(projPath)
  const bg = proj?.state?.aiBackground && typeof proj.state.aiBackground === 'object' ? { ...proj.state.aiBackground } : {}
  if (String(srcBg.storyboardGlobalPromptZh || '').trim()) bg.storyboardGlobalPromptZh = String(srcBg.storyboardGlobalPromptZh).trim()
  if (String(srcBg.storyboardGlobalNegativePromptZh || '').trim()) bg.storyboardGlobalNegativePromptZh = String(srcBg.storyboardGlobalNegativePromptZh).trim()
  if (String(srcBg.storyboardGlobalPrompt || '').trim()) bg.storyboardGlobalPrompt = String(srcBg.storyboardGlobalPrompt).trim()
  if (String(srcBg.storyboardGlobalNegativePrompt || '').trim()) bg.storyboardGlobalNegativePrompt = String(srcBg.storyboardGlobalNegativePrompt).trim()
  const promptMap = bg.storyboardLockAssetPrompts && typeof bg.storyboardLockAssetPrompts === 'object' ? { ...bg.storyboardLockAssetPrompts } : {}
  for (const item of summary.inherited) {
    // 源提示词按目标 assetId 重映射（键是 assetId 不是名称）；匹配源复用循环内已定的 exact/fuzzy 结果
    const srcAsset = matchedSrcByTargetId.get(String(item.assetId || '').trim()) || null
    const sp = srcAsset ? srcAssetPrompts[String(srcAsset.id || '').trim()] : null
    if (sp && typeof sp === 'object') {
      promptMap[item.assetId] = {
        promptZh: String(sp.promptZh || '').trim(),
        promptEn: String(sp.promptEn || '').trim(),
        negativePromptZh: String(sp.negativePromptZh || '').trim(),
        negativePrompt: String(sp.negativePrompt || '').trim()
      }
    }
  }
  bg.storyboardLockAssetPrompts = promptMap
  if (summary.inherited.length) bg.storyboardLockPromptGate = { zhConfirmed: true, enApproved: true }
  const nextProj = {
    ...proj,
    state: { ...(proj?.state && typeof proj.state === 'object' ? proj.state : {}), aiBackground: bg },
    assets: [...(Array.isArray(proj?.assets) ? proj.assets : []), ...newProjectAssets],
    updatedAt: nowIso(),
    _rev: Number(proj?._rev || 0) + 1
  }
  await writeJson(projPath, nextProj)
  // 读回验证：登记丢失即抛错（不允许静默失败）
  const verify = await readJson(projPath).catch(() => null)
  const verifyIds = new Set((Array.isArray(verify?.assets) ? verify.assets : []).map((a) => String(a?.id || '')))
  const missing = newProjectAssets.filter((a) => !verifyIds.has(a.id))
  if (missing.length) {
    const e = new Error(`继承登记读回验证失败：${missing.length} 条资产未落盘`)
    e.code = 'inherit_registration_lost'
    throw e
  }

  // 7) lock_confirm 审核留痕（decidedBy=inherit；留痕失败不阻断）
  for (const tr of lockTraces) {
    try {
      const targetKey = `lock_confirm:${tr.planAssetId}:${tr.resultImagePath}`
      const pending = await findPendingReview(dir, { phase: 'lock_confirm', targetKey })
      if (pending) {
        await decideImageReview(dir, pending.reviewId, { approved: true, decidedBy: 'inherit' })
      } else {
        const record = await createImageReview(dir, { phase: 'lock_confirm', targetKey, assetId: tr.planAssetId, resultImagePath: tr.resultImagePath, prompt: tr.prompt })
        await decideImageReview(dir, record.reviewId, { approved: true, decidedBy: 'inherit' })
      }
    } catch (_) { /* 留痕失败不阻断 */ }
  }
  return summary
}

// 《xxxx2》命名自动继承：plan 生成后调用；无基底可解析返回 null
export async function maybeAutoInheritStoryAssets(id) {
  const meta = await readJson(path.join(projectDir(id), 'meta.json')).catch(() => null)
  const baseTitle = resolveInheritBaseTitle(meta?.title)
  if (!baseTitle) return null
  const sourceId = await findProjectIdByTitle(baseTitle, { excludeId: id })
  if (!sourceId) return null
  const task = createAiTask(id, 'story.assets.inherit', { total: 1, message: `继承基底项目《${baseTitle}》的已锁定资产` })
  logStage({ stage: 'story.assets.inherit', event: 'start', project: id, item: `${baseTitle} ← ${sourceId}` })
  try {
    const summary = await inheritStoryAssetsFromProject({ id, dir: projectDir(id), sourceId })
    updateAiTask(task.taskId, {
      done: true,
      current: 1,
      stage: 'done',
      message: `继承完成：${summary.inherited.length} 资产（${summary.inherited.map((x) => x.name).join('、') || '无'}），未匹配 ${summary.unmatched.length}`,
      result: summary
    })
    logStage({ stage: 'story.assets.inherit', event: 'ok', project: id, item: `inherited:${summary.inherited.length} unmatched:${summary.unmatched.length}` })
    return { baseTitle, sourceId, ...summary }
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    updateAiTask(task.taskId, { done: true, stage: 'error', error: msg, message: `继承失败：${msg}` })
    logStage({ stage: 'story.assets.inherit', event: 'error', project: id, item: msg })
    return { baseTitle, sourceId, error: msg }
  }
}
