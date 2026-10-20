// 业务面确定性核心单测：PlanV1 运行时契约校验（W3）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateStoryAssetPlan, assertStoryAssetPlanValid } from '../src/ai/planContract.js'

const GOOD = {
  assets: [{
    id: 'hero', name: '主角', category: 'character',
    poseVariants: [{ id: 'v1', poseKey: 'holding_pear', projectAssetId: 'a1' }],
    stateRequirements: [{ stateKey: 'holding_pear', sceneIds: ['sc1'], relatedAssetIds: ['pear'] }]
  }],
  scenes: [{ sceneId: 'sc1' }]
}

test('契约：合法计划通过', () => {
  assert.equal(validateStoryAssetPlan(GOOD).ok, true)
  assert.doesNotThrow(() => assertStoryAssetPlanValid(GOOD))
})

test('契约：stateKey 非法格式/资产重复 id/sceneIds 非字符串数组均被拦截', () => {
  const bad = {
    assets: [
      { id: 'a', category: 'prop', poseVariants: [{ id: 'v', poseKey: 'Bad Key!' }] },
      { id: 'a', category: 'prop', stateRequirements: [{ stateKey: 'ok', sceneIds: 'not-array' }] }
    ],
    scenes: [{ sceneId: 's' }, { sceneId: 's' }]
  }
  const r = validateStoryAssetPlan(bad)
  assert.equal(r.ok, false)
  assert.ok(r.issues.some((x) => x.includes('duplicate_id')))
  assert.ok(r.issues.some((x) => x.includes('bad_poseKey_format')))
  assert.ok(r.issues.some((x) => x.includes('sceneIds_not_string_array')))
  assert.ok(r.issues.some((x) => x.includes('duplicate_sceneId')))
  assert.throws(() => assertStoryAssetPlanValid(bad), /plan_contract_violation/)
})

test('契约：空值键（null 或空串）视为缺省不判非法（合并语义兼容）', () => {
  const plan = { assets: [{ id: 'a', category: 'prop', poseVariants: [{ id: 'v', poseKey: null }] }] }
  assert.equal(validateStoryAssetPlan(plan).ok, true)
})
