// 故事资产计划读写（2026-10-20 index.js 拆分收尾迁出；函数体逐字未改；含写盘串行链竞态治理）
import path from 'node:path'
import { assertStoryAssetPlanValid } from './planContract.js'
import { snapshotCreationState } from '../creationBuffer.js'
import { existsFile, nowIso, projectDir, projectStoryAssetsPlanPath, readJson, writeJson } from '../studio/storeFs.js'

// ---------------------------------------------------------------------------
export const storyAssetPlanWriteChains = new Map() // 计划写盘串行链（恢复自拆分误吸）

export async function readStoryAssetPlanIfExists(id) {
  const planPath = projectStoryAssetsPlanPath(id)
  if (!(await existsFile(planPath))) return null
  try {
    const plan = await readJson(planPath)
    return plan && typeof plan === 'object' ? plan : null
  } catch (_) {
    return null
  }
}

export async function saveStoryAssetPlan(id, plan, options = {}) {
  const prev = storyAssetPlanWriteChains.get(id) || Promise.resolve()
  const run = prev.catch(() => {}).then(async () => {
    let nextPlan = plan
    if (options.mergeAssetsById) {
      const diskPlan = await readStoryAssetPlanIfExists(id).catch(() => null)
      if (diskPlan && Array.isArray(diskPlan.assets) && plan && Array.isArray(plan.assets)) {
        // 字段级合并（2026-09-09 二轮修正：纯按 id 合并仍会被"陈旧空字段"覆盖新数据——
        // 锁定测试携带锁前快照把 primaryReferenceAssetUri 清空回写。规则：
        // - 标量：入站非空覆盖，入站为空（null/''/undefined）保留磁盘值；
        // - 记录数组（generatedRefs/poseCandidates/poseVariants/latestReferenceBatch）：按唯一键并集去重，入站新记录追加、磁盘记录不丢；
        // - 其他数组以入站为准；磁盘独有条目/字段一律保留。
        const RECORD_ARRAY_KEYS = {
          generatedRefs: (x) => String(x && (x.projectAssetUri || x.assetPath) || ''),
          poseCandidates: (x) => String(x && x.assetPath || ''),
          poseVariants: (x) => String(x && x.id || ''),
          latestReferenceBatch: (x) => String(x && x.assetPath || '')
        }
        // 2026-09-12 终端字段保护（实测事故：编辑器陈旧整计划 persist 把已锁定/已出线稿的生产字段
        // 重置回 missing/空，出图总账回退）。protectTerminalFields 仅在编辑器手工保存通道开启：
        // 以下由生产流（锁定/线稿/姿势）写入的字段，磁盘非空时一律以磁盘为准，入站不得回退。
        const TERMINAL_ASSET_KEYS = new Set([
          'referenceStatus', 'primaryReferenceAssetId', 'primaryReferenceAssetUri', 'primaryReferenceSelectedAt',
          'latestReferenceBatch', 'latestRecommendedReferenceAssetUri', 'latestReferenceReview',
          'lineartHintAssetId', 'lineartHintAssetUri', 'lineartFinalAssetId', 'lineartFinalAssetUri',
          'lineartStatus', 'lineartPrompt', 'lineartNegativePrompt', 'lineartMeta', 'lineartGeneratedAt',
          'poseRequirements', 'poseDraft'
        ])
        const protectTerminal = options.protectTerminalFields === true
        // 2026-10-18 根修：RECORD_ARRAY_KEYS 此前对"已存在记录"一律磁盘为准——入站对既有记录的
        // 字段更新（如载体变体回写 poseKey/skillId）被静默丢弃，导致写回永不生效（孔融父亲 3 个
        // 载体变体全部 poseKey=null，幂等与摆位 stateKey 命中失效）。mergeRecordUpdates 声明的
        // 记录数组允许按键浅合并：匹配记录入站非空字段覆盖，新记录照旧追加。
        const MERGE_UPDATES = new Set(Array.isArray(options.mergeRecordUpdates) ? options.mergeRecordUpdates : [])
        const mergeAssetEntry = (diskEntry, incomingEntry) => {
          const disk = diskEntry && typeof diskEntry === 'object' ? diskEntry : {}
          const incoming = incomingEntry && typeof incomingEntry === 'object' ? incomingEntry : {}
          const merged = { ...disk }
          for (const [key, value] of Object.entries(incoming)) {
            if (protectTerminal && TERMINAL_ASSET_KEYS.has(key)) {
              const diskVal = disk[key]
              const diskNonEmpty = diskVal != null && diskVal !== '' && !(Array.isArray(diskVal) && !diskVal.length)
              if (diskNonEmpty) continue // 生产终态字段：磁盘为准，跳过入站回退
            }
            const keyOf = RECORD_ARRAY_KEYS[key]
            if (keyOf && Array.isArray(value)) {
              const diskArr = Array.isArray(disk[key]) ? disk[key] : []
              if (MERGE_UPDATES.has(key)) {
                const incomingByKey = new Map(value.map((x) => [keyOf(x), x]).filter(([k]) => k))
                const mergedArr = diskArr.map((d) => {
                  const inc = incomingByKey.get(keyOf(d))
                  if (!inc || typeof inc !== 'object') return d
                  const next = { ...d }
                  for (const [rk, rv] of Object.entries(inc)) {
                    if (rv !== undefined && rv !== null && rv !== '') next[rk] = rv
                  }
                  return next
                })
                const seenU = new Set(diskArr.map((x) => keyOf(x)).filter(Boolean))
                const appendedU = value.filter((x) => { const k = keyOf(x); return k && !seenU.has(k) })
                merged[key] = [...mergedArr, ...appendedU]
                continue
              }
              const seen = new Set(diskArr.map((x) => keyOf(x)).filter(Boolean))
              const appended = value.filter((x) => { const k = keyOf(x); return k && !seen.has(k) })
              if (appended.length || value.length) merged[key] = [...diskArr, ...appended]
              continue
            }
            const isEmpty = value == null || value === ''
            if (!isEmpty) merged[key] = value
          }
          return merged
        }
        const diskIds = new Set(diskPlan.assets.map((a) => String(a && a.id || '')))
        const incomingById = new Map(plan.assets.map((a) => [String(a && a.id || ''), a]))
        const mergedAssets = diskPlan.assets.map((da) => {
          const inc = incomingById.get(String(da && da.id || ''))
          return inc ? mergeAssetEntry(da, inc) : da
        })
        for (const a of plan.assets) {
          if (!diskIds.has(String(a && a.id || ''))) mergedAssets.push(a)
        }
        nextPlan = { ...diskPlan, ...plan, assets: mergedAssets }
      }
    }
    // W3 契约运行时校验：写盘前结构校验（类型/枚举/键格式/唯一性），非法计划拒绝落盘（2026-10-19）。
    // 只查结构不评内容；存量项目读取不受影响；校验失败抛 plan_contract_violation。
    assertStoryAssetPlanValid(nextPlan)
    await snapshotCreationState(projectDir(id), { reason: 'plan_save' })
    await writeJson(projectStoryAssetsPlanPath(id), nextPlan)
    // 2026-08-30 修复：同步 project.json 的 aiBackground.storyAssetPlan 副本——编辑器部分读路径走 project.json，
    // 不同步会出现 plan.json 与编辑器看到的不一致（如人工补充的猪妈妈/工具包、repair-links 的场景关联丢失）。
    try {
      const dir = projectDir(id)
      const projectPath = path.join(dir, 'project.json')
      const projectDoc = await readJson(projectPath).catch(() => null)
      if (projectDoc && typeof projectDoc === 'object') {
        if (!projectDoc.state || typeof projectDoc.state !== 'object') projectDoc.state = {}
        if (!projectDoc.state.aiBackground || typeof projectDoc.state.aiBackground !== 'object') projectDoc.state.aiBackground = {}
        projectDoc.state.aiBackground.storyAssetPlan = nextPlan
        projectDoc.updatedAt = nowIso()
        projectDoc._rev = Number(projectDoc._rev || 0) + 1
        await writeJson(projectPath, projectDoc)
      }
    } catch (_) { /* 同步失败不阻断计划保存 */ }
  })
  storyAssetPlanWriteChains.set(id, run)
  return run
}
