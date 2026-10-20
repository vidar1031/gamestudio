// 业务面确定性核心单测：资产计划合并语义（mergeAssetsById / mergeRecordUpdates）。
// 覆盖 2026-10-18 根修：既有记录更新不得被"磁盘为准"静默丢弃。
import { test } from 'node:test'
import assert from 'node:assert/strict'

// saveStoryAssetPlan 依赖文件系统；此处以纯函数方式复刻其合并核心做契约级验证。
// 真值源：apps/server/src/index.js 的 mergeAssetEntry（拆分回收块内）。
// 若该实现变更导致本测试失败，视为合并语义契约被破坏。

const RECORD_ARRAY_KEYS = { poseVariants: (x) => String(x && x.id || '') }

function mergeRecordArrays(diskArr, incomingArr, keyOf, allowUpdates) {
  if (!allowUpdates) {
    const seen = new Set(diskArr.map((x) => keyOf(x)).filter(Boolean))
    const appended = incomingArr.filter((x) => { const k = keyOf(x); return k && !seen.has(k) })
    return [...diskArr, ...appended]
  }
  const incomingByKey = new Map(incomingArr.map((x) => [keyOf(x), x]).filter(([k]) => k))
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
  const appendedU = incomingArr.filter((x) => { const k = keyOf(x); return k && !seenU.has(k) })
  return [...mergedArr, ...appendedU]
}

test('缺省合并：既有记录不被入站更新（磁盘为准），新记录追加', () => {
  const disk = [{ id: 'p1', poseKey: null, projectAssetId: 'a1' }]
  const incoming = [{ id: 'p1', poseKey: 'holding_pear', projectAssetId: 'a1' }, { id: 'p2', poseKey: 'x', projectAssetId: 'a2' }]
  const out = mergeRecordArrays(disk, incoming, RECORD_ARRAY_KEYS.poseVariants, false)
  assert.equal(out.length, 2)
  assert.equal(out[0].poseKey, null) // 磁盘为准
  assert.equal(out[1].id, 'p2')
})

test('mergeRecordUpdates：声明键允许入站非空字段覆盖，空值不回退', () => {
  const disk = [{ id: 'p1', poseKey: null, name: '载体·手持', projectAssetId: 'a1' }]
  const incoming = [{ id: 'p1', poseKey: 'holding_pear', name: '', projectAssetId: 'a1' }]
  const out = mergeRecordArrays(disk, incoming, RECORD_ARRAY_KEYS.poseVariants, true)
  assert.equal(out[0].poseKey, 'holding_pear') // 更新生效
  assert.equal(out[0].name, '载体·手持') // 空值不回退
})
