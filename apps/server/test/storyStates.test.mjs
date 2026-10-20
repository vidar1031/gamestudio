// 业务面确定性核心单测（node:test，零新依赖）：剧情状态缺口计算。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findStateGaps } from '../src/ai/storyStates.js'

const PLAN = {
  assets: [
    {
      id: 'hero', name: '主角', category: 'character',
      stateRequirements: [
        { stateKey: 'holding_pear', label: '手持梨', sceneIds: ['sc2'] },
        { stateKey: 'clapping_hands', label: '鼓掌', sceneIds: ['sc7'] }
      ],
      poseVariants: [
        { id: 'v1', poseKey: 'holding_pear', projectAssetId: 'asset_1' }
      ]
    },
    {
      id: 'plate', name: '盘子', category: 'prop',
      stateRequirements: [
        { stateKey: 'plate_with_two_pears', label: '剩两梨', sceneIds: ['sc2', 'sc3'], relatedAssetIds: ['pear-a', 'pear-b'] }
      ],
      stateVariants: []
    }
  ]
}

test('findStateGaps：已有变体的状态不成缺口', () => {
  const gaps = findStateGaps(PLAN, {})
  assert.equal(gaps.length, 2) // clapping_hands + plate_with_two_pears
  assert.ok(gaps.every((g) => g.stateKey !== 'holding_pear'))
})

test('findStateGaps：sceneId 过滤只算命中场景的需求', () => {
  const gaps2 = findStateGaps(PLAN, { sceneId: 'sc2' })
  assert.equal(gaps2.length, 1)
  assert.equal(gaps2[0].assetId, 'plate')
  const gaps7 = findStateGaps(PLAN, { sceneId: 'sc7' })
  assert.equal(gaps7.length, 1)
  assert.equal(gaps7[0].stateKey, 'clapping_hands')
  assert.equal(findStateGaps(PLAN, { sceneId: 'scX' }).length, 0)
})

test('findStateGaps：缺口携带 kind 与 relatedAssetIds', () => {
  const [g] = findStateGaps(PLAN, { sceneId: 'sc2' })
  assert.equal(g.kind, 'prop_state')
  assert.deepEqual(g.relatedAssetIds, ['pear-a', 'pear-b'])
})
