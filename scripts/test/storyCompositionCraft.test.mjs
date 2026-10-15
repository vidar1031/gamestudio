import test from 'node:test'
import assert from 'node:assert/strict'

// V1.3 构图 skillIds 兼容单测：schema 可选字段、未知 id 过滤告警、旧无 skillIds 计划不受影响。
// 纯函数级（normalizeCompositionForTest），不起服务不调模型。

const { normalizeCompositionForTest } = await import('../../apps/server/src/ai/storyComposition.js')

function makeScenes() {
  return [{
    sceneId: 'scene_1',
    alias: 'sc_1',
    sceneName: '井边',
    summary: '井边场景',
    subjects: [
      { subjectId: 'father', name: '爸爸', kind: 'character', stateKeys: [] },
      { subjectId: 'prop_tray', name: '托盘', kind: 'prop', stateKeys: [] }
    ],
    resolveSubjectId: (id) => (id === 'father' || id === 'prop_tray' ? id : null)
  }]
}

function makeParsedItem(extra = {}) {
  return {
    subjectId: 'father',
    kind: 'character',
    stateKey: '',
    x: 0.5, y: 0.9, scale: 0.5, zIndex: 3,
    flipH: false,
    blocking: '爸爸在画面中央',
    evidence: '爸爸端来一盘梨',
    ...extra
  }
}

test('normalize：skillIds 保留目录内 id；未知 id 过滤并告警', () => {
  const warnings = []
  const known = new Set(['carrier.holding_tray', 'pose.sitting_gathered'])
  const parsed = {
    scenes: [{
      sceneId: 'sc_1',
      cameraNote: '中景',
      items: [makeParsedItem({ skillIds: ['carrier.holding_tray', 'made.up_skill', 'pose.sitting_gathered', 'another.unknown'] })]
    }]
  }
  const out = normalizeCompositionForTest(parsed, { scenes: makeScenes(), knownSkillIds: known, onWarn: (d) => warnings.push(d) })
  const item = out.scenes[0].items[0]
  assert.deepEqual(item.skillIds, ['carrier.holding_tray', 'pose.sitting_gathered'], '未知 id 被过滤')
  assert.equal(warnings.length, 1, '告警一次（含全部未知 id）')
  assert.ok(warnings[0].includes('made.up_skill'))
})

test('normalize：无 skillIds 的旧输出/计划零变化（向后兼容，不产出该键）', () => {
  const out = normalizeCompositionForTest(
    { scenes: [{ sceneId: 'sc_1', cameraNote: '中景', items: [makeParsedItem()] }] },
    { scenes: makeScenes(), knownSkillIds: new Set(['carrier.holding_tray']), onWarn: () => {} }
  )
  const item = out.scenes[0].items[0]
  assert.equal('skillIds' in item, false, '未提供 skillIds 时不产出该键')
  assert.equal(item.subjectId, 'father')
})

test('normalize：knownSkillIds 缺省（库未加载）时 skillIds 不消费不过滤（降级现行为）', () => {
  const out = normalizeCompositionForTest(
    { scenes: [{ sceneId: 'sc_1', cameraNote: '中景', items: [makeParsedItem({ skillIds: ['made.up_skill'] })] }] },
    { scenes: makeScenes() }
  )
  assert.equal('skillIds' in out.scenes[0].items[0], false, '无目录时不带出 skillIds')
})
