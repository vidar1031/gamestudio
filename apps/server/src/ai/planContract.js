// PlanV1 运行时契约校验（零依赖轻量校验器，模块化拆分 W3 首批：只查结构，不评内容）。
// 挂接点：saveStoryAssetPlan 写盘前；校验失败抛 plan_contract_violation（结构错误），存量读取不受影响。
const STATE_KEY_RE = /^[a-z0-9_.]+$/ // 兼容命名空间键（carrier.holding_object 等存量点分键）

function isStr(v) { return typeof v === 'string' }
function isStrArr(v) { return Array.isArray(v) && v.every((x) => isStr(x)) }

export function validateStoryAssetPlan(plan) {
  const issues = []
  if (!plan || typeof plan !== 'object') return { ok: false, issues: ['plan_not_object'] }
  if (!Array.isArray(plan.assets)) return { ok: false, issues: ['plan_assets_not_array'] }
  const assetIds = new Set()
  for (const [i, a] of plan.assets.entries()) {
    const at = `assets[${i}]`
    if (!a || typeof a !== 'object') { issues.push(`${at}:not_object`); continue }
    const id = String(a.id || '').trim()
    if (!id) issues.push(`${at}:missing_id`)
    else if (assetIds.has(id)) issues.push(`${at}:duplicate_id:${id}`)
    else assetIds.add(id)
    if (a.category !== undefined && !isStr(a.category)) issues.push(`${at}/category:not_string`)
    for (const [pool, keyFields] of [['poseVariants', ['poseKey', 'stateKey']], ['stateVariants', ['stateKey']]]) {
      const arr = a[pool]
      if (arr === undefined) continue
      if (!Array.isArray(arr)) { issues.push(`${at}/${pool}:not_array`); continue }
      const seen = new Set()
      for (const [j, v] of arr.entries()) {
        if (!v || typeof v !== 'object') { issues.push(`${at}/${pool}[${j}]:not_object`); continue }
        if (pool === 'poseVariants') {
          const vid = String(v.id || '').trim()
          if (vid) {
            if (seen.has(vid)) issues.push(`${at}/${pool}[${j}]:duplicate_variant_id:${vid}`)
            else seen.add(vid)
          }
        }
        for (const kf of keyFields) {
          const kv = v[kf]
          if (kv !== undefined && kv !== null && kv !== '' && !(isStr(kv) && STATE_KEY_RE.test(kv))) {
            issues.push(`${at}/${pool}[${j}]:bad_${kf}_format`)
          }
        }
      }
    }
    const reqs = a.stateRequirements
    if (reqs !== undefined) {
      if (!Array.isArray(reqs)) issues.push(`${at}/stateRequirements:not_array`)
      else for (const [j, r] of reqs.entries()) {
        if (!r || typeof r !== 'object') { issues.push(`${at}/stateRequirements[${j}]:not_object`); continue }
        const sk = String(r.stateKey || '').trim()
        if (sk && !STATE_KEY_RE.test(sk)) issues.push(`${at}/stateRequirements[${j}]:bad_stateKey_format`)
        if (r.sceneIds !== undefined && !isStrArr(r.sceneIds)) issues.push(`${at}/stateRequirements[${j}]:sceneIds_not_string_array`)
        if (r.relatedAssetIds !== undefined && !isStrArr(r.relatedAssetIds)) issues.push(`${at}/stateRequirements[${j}]:relatedAssetIds_not_string_array`)
      }
    }
  }
  const scenes = plan.scenes
  if (scenes !== undefined) {
    if (!Array.isArray(scenes)) issues.push('plan.scenes:not_array')
    else {
      const seenScenes = new Set()
      for (const [i, s] of scenes.entries()) {
        const sid = String(s && s.sceneId || '').trim()
        if (sid) {
          if (seenScenes.has(sid)) issues.push(`scenes[${i}]:duplicate_sceneId:${sid}`)
          else seenScenes.add(sid)
        }
      }
    }
  }
  return { ok: issues.length === 0, issues }
}

export function assertStoryAssetPlanValid(plan) {
  const r = validateStoryAssetPlan(plan)
  if (!r.ok) {
    const err = new Error(`plan_contract_violation: ${r.issues.slice(0, 5).join(' | ')}`)
    err.code = 'plan_contract_violation'
    err.issues = r.issues
    throw err
  }
}
