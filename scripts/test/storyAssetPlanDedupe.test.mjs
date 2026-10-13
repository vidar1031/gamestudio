import test from 'node:test'
import assert from 'node:assert/strict'

// 2026-10-13（青蛙王子实测）资产计划修复单测：
// 1) 字段对齐：buildStoryAssetPlan 给每个资产填齐向导可见可编字段
//    （referencePromptEn=出图锚点 anchorPrompt 同源；referencePromptZh=中文名/别名种子）；
// 2) 去重合并：bible_qc 重写圣经后同一事物按不同 id 双建档（characters.frog「青蛙」与
//    props.frog_char_01「The Frog」aliases 含 frog）时，计划只保留一个条目——
//    类别优先 character > location > prop，sceneIds/aliases/主参考/生成态并入保留条目，
//    场景引用经 idMap 改写到保留条目。
// 纯函数级测试：buildStoryAssetPlan 直接调用，不起服务、不碰真实 storage。

const { buildStoryAssetPlan } = await import('../../apps/server/src/ai/storyAssets.js')

function makeBible() {
  return {
    schemaVersion: '1.0',
    worldAnchor: '童话绘本世界',
    characters: [
      { id: 'frog', name: '青蛙', aliases: ['绿青蛙', '鼓耳青蛙'], anchorPrompt: 'A large anthropomorphic cartoon green frog, big eyes', negativePrompt: 'ugly, realistic reptile' },
      { id: 'princess', name: '公主', aliases: ['小公主'], anchorPrompt: 'A cute young princess in pink ballgown', negativePrompt: 'scary' }
    ],
    props: [
      // 与 characters.frog 是同一事物：名称 The Frog 规范化后与角色 id 'frog' / 别名相交
      { id: 'frog_char_01', name: 'The Frog', aliases: ['frog', 'green creature', 'talking frog'], anchorPrompt: 'green frog prop duplicate' },
      { id: 'gold_ball_01', name: 'The Golden Ball', aliases: ['golden ball', 'toy ball'], anchorPrompt: 'small handheld golden sphere' }
    ],
    locations: [
      { id: 'loc_well', name: 'Royal Garden Well', aliases: ['Old Well'], anchorPrompt: 'old stone well in royal garden' }
    ],
    sceneRefs: {
      '井边': { characters: ['frog', 'princess'], props: ['frog_char_01', 'gold_ball_01'], locations: ['loc_well'] }
    },
    eventChain: [],
    forbiddenSubstitutes: []
  }
}

function makeStory() {
  return {
    nodes: [
      { id: 'scene_1', kind: 'scene', name: '井边', body: { title: '井边', text: '公主在井边玩耍，青蛙出现了。金球滚落到井边。' } }
    ]
  }
}

test('字段对齐：referencePromptEn 与 anchorPrompt 同源填齐；中文稿取中文名/别名种子', () => {
  const plan = buildStoryAssetPlan({ project: {}, story: makeStory(), storyBible: makeBible(), prevManifest: null })
  const frog = plan.assets.find((a) => a.id === 'frog')
  assert.equal(frog.referencePromptEn, 'A large anthropomorphic cartoon green frog, big eyes')
  assert.equal(frog.referencePromptZh, '青蛙、绿青蛙、鼓耳青蛙')
  const ball = plan.assets.find((a) => a.id === 'gold_ball_01')
  assert.equal(ball.referencePromptEn, 'small handheld golden sphere')
  assert.equal(ball.referencePromptZh, '', '纯英文名/别名（无中文字符）不编造中文稿，留空由向导 AI 生成/人工补齐')
  const well = plan.assets.find((a) => a.id === 'loc_well')
  assert.equal(well.referencePromptEn, 'old stone well in royal garden')
})

test('去重合并：同一事物（prop frog_char_01 = character frog）只保留一个条目，类别优先 character', () => {
  const plan = buildStoryAssetPlan({ project: {}, story: makeStory(), storyBible: makeBible(), prevManifest: null })
  const frogEntries = plan.assets.filter((a) => a.id === 'frog' || a.id === 'frog_char_01')
  assert.equal(frogEntries.length, 1, '青蛙只应有一个资产条目')
  const frog = frogEntries[0]
  assert.equal(frog.id, 'frog')
  assert.equal(frog.category, 'character', '保留角色条目（类别优先级最高）')
  assert.equal(frog.anchorPrompt, 'A large anthropomorphic cartoon green frog, big eyes', '保留条目的锚点词不被被合并条目覆盖')
  // 别名并集：被合并条目的英文别名并入保留条目
  for (const alias of ['绿青蛙', 'frog', 'green creature', 'talking frog']) {
    assert.ok(frog.aliases.includes(alias), `aliases 应含 ${alias}`)
  }
  // 不同事物不误并
  assert.ok(plan.assets.some((a) => a.id === 'gold_ball_01'), '金球不受影响')
  assert.ok(plan.assets.some((a) => a.id === 'princess'), '公主不受影响')
  assert.equal(plan.assets.length, 4, 'frog/princess/gold_ball/loc_well 共 4 条')
})

test('去重合并：场景引用经 idMap 改写到保留条目，sceneIds 并入', () => {
  const plan = buildStoryAssetPlan({ project: {}, story: makeStory(), storyBible: makeBible(), prevManifest: null })
  const scene = plan.scenes.find((s) => s.sceneId === 'scene_1')
  assert.ok(scene, '场景存在')
  assert.ok(!scene.assetIds.includes('frog_char_01'), '场景不再引用被合并的 prop id')
  assert.ok(scene.assetIds.includes('frog'), '场景引用改写为保留的 character id')
  assert.ok(scene.assetIds.includes('gold_ball_01'))
  assert.ok(scene.assetIds.includes('loc_well'))
  const frog = plan.assets.find((a) => a.id === 'frog')
  assert.ok(frog.sceneIds.includes('scene_1'), '被合并条目的 sceneIds 并入保留条目')
})

test('去重合并：被合并条目的既有主参考/生成态并入保留条目（prevManifest 状态不丢）', () => {
  const prevManifest = {
    assets: [
      {
        id: 'frog_char_01',
        name: 'The Frog',
        category: 'prop',
        generatedRefs: [{ assetId: 'ref_frog_a', uri: 'assets/ai/story_assets/frog_char_01/a.png' }],
        primaryReferenceAssetId: 'ref_frog_a',
        primaryReferenceAssetUri: 'assets/ai/story_assets/frog_char_01/a.png',
        referenceStatus: 'ready'
      }
    ]
  }
  const plan = buildStoryAssetPlan({ project: {}, story: makeStory(), storyBible: makeBible(), prevManifest })
  const frog = plan.assets.find((a) => a.id === 'frog')
  assert.equal(frog.primaryReferenceAssetUri, 'assets/ai/story_assets/frog_char_01/a.png', '保留条目缺主参考时继承被合并条目的主参考')
  assert.equal(frog.referenceStatus, 'ready')
  assert.ok(frog.generatedRefs.some((r) => r.assetId === 'ref_frog_a'), '生成候选并入保留条目')
})
