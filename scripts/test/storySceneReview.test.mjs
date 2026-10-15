import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// GS-53 场景图审核单测（2026-10-14）：整图收集（走查截图映射优先/背景图回退）、
// scene_reviews.jsonl 轮次聚合（分片 control reviewId 归并到 roundId）、人工处置追加。
// 纯文件级夹具，不起服务、不调模型。

const {
  collectSceneReviewInputs,
  appendSceneReviewFeedback,
  readLatestSceneReviewRound
} = await import('../../apps/server/src/ai/storySceneReview.js')

function makeProjectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-review-'))
  fs.mkdirSync(path.join(dir, 'walkthrough'), { recursive: true })
  return dir
}

// 故事：scene_a ->(choice)-> scene_b；scene_c 不在走查路径上
function makeStory() {
  return {
    nodes: [
      { id: 'scene_a', kind: 'scene', name: '场景甲', body: { title: '场景甲', text: '甲场景正文。' }, choices: [{ text: '去乙', toNodeId: 'scene_b' }] },
      { id: 'scene_b', kind: 'scene', name: '场景乙', body: { title: '场景乙', text: '乙场景正文。' } },
      { id: 'scene_c', kind: 'scene', name: '场景丙', body: { title: '场景丙', text: '丙场景正文。' } }
    ]
  }
}

function makePlan() {
  return {
    worldAnchor: '童话绘本世界',
    assets: [
      { id: 'char_a', name: '小猫', category: 'character', anchorPrompt: 'a cute orange kitten' },
      { id: 'prop_a', name: '鱼竿', category: 'prop', anchorPrompt: 'a bamboo fishing rod' }
    ],
    scenes: [
      { sceneId: 'scene_a', sceneName: '场景甲', summary: '甲场景摘要', composition: { cameraNote: '中景', items: [{ subjectId: 'char_a', blocking: '小猫在左侧' }] } },
      { sceneId: 'scene_b', sceneName: '场景乙', summary: '乙场景摘要' },
      { sceneId: 'scene_c', sceneName: '场景丙', summary: '丙场景摘要' }
    ]
  }
}

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('整图收集：走查截图映射优先（sceneId ↔ 截图序号）；不在走查路径的场景回退背景图', () => {
  const dir = makeProjectDir()
  // 走查：报告 + 截图（内容截图对位：p1_01_start↔场景甲，p1_03_hold_2↔场景乙；choice 截图为选项界面不入评）
  fs.writeFileSync(path.join(dir, 'walkthrough', 'report_2026.json'), JSON.stringify({
    paths: 1,
    reports: [{ pathId: 'p1', screenshots: ['p1_01_start.png', 'p1_02_choice_1.png', 'p1_03_hold_2.png'], issues: [], pathNames: ['场景甲', '场景乙'] }]
  }))
  fs.writeFileSync(path.join(dir, 'walkthrough', 'p1_01_start.png'), Buffer.from(PNG_B64, 'base64'))
  fs.writeFileSync(path.join(dir, 'walkthrough', 'p1_02_choice_1.png'), Buffer.from(PNG_B64, 'base64'))
  fs.writeFileSync(path.join(dir, 'walkthrough', 'p1_03_hold_2.png'), Buffer.from(PNG_B64, 'base64'))
  // 背景图回退：scene_c 走 story.visuals.backgroundAssetId -> project.assets[].uri
  fs.mkdirSync(path.join(dir, 'assets', 'ai'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'assets', 'ai', 'bg_c.png'), Buffer.from(PNG_B64, 'base64'))

  const story = makeStory()
  story.nodes[2].visuals = { backgroundAssetId: 'bg_c_asset' }
  const project = { assets: [{ id: 'bg_c_asset', uri: 'assets/ai/bg_c.png' }] }
  const { inputs, anchors, globalRules } = collectSceneReviewInputs({
    dir,
    projectId: 'proj_t',
    story,
    plan: makePlan(),
    project,
    sceneIds: null
  })
  assert.equal(inputs.length, 3)
  const byId = new Map(inputs.map((i) => [i.sceneId, i]))
  assert.equal(byId.get('scene_a').imageSource, 'walkthrough')
  assert.ok(byId.get('scene_a').imagePath.endsWith('p1_01_start.png'))
  assert.equal(byId.get('scene_b').imageSource, 'walkthrough')
  assert.ok(byId.get('scene_b').imagePath.endsWith('p1_03_hold_2.png'), '场景乙取内容截图（hold），不得取 choice 界面截图')
  assert.equal(byId.get('scene_c').imageSource, 'background_only', '不在走查路径的场景回退背景图并标注')
  assert.ok(byId.get('scene_c').imagePath.endsWith('bg_c.png'))
  assert.ok(byId.get('scene_a').description.includes('导演构图'), '描述含构图布局')
  assert.ok(anchors.includes('小猫：a cute orange kitten'), '锚点含角色')
  assert.ok(globalRules.includes('童话绘本世界'), '全局规则含世界锚点')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('无图场景跳过；全部无图时 inputs 为空（调用方显式 scene_review_no_images）', () => {
  const dir = makeProjectDir() // 无走查、无背景
  const { inputs } = collectSceneReviewInputs({
    dir,
    projectId: 'proj_t',
    story: makeStory(),
    plan: makePlan(),
    project: { assets: [] },
    sceneIds: null
  })
  assert.equal(inputs.length, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('sceneIds 过滤：只评审指定场景', () => {
  const dir = makeProjectDir()
  fs.writeFileSync(path.join(dir, 'walkthrough', 'report_2026.json'), JSON.stringify({
    paths: 1,
    reports: [{ pathId: 'p1', screenshots: ['p1_01_start.png'], issues: [], pathNames: ['场景甲'] }]
  }))
  fs.writeFileSync(path.join(dir, 'walkthrough', 'p1_01_start.png'), Buffer.from(PNG_B64, 'base64'))
  const { inputs } = collectSceneReviewInputs({
    dir,
    projectId: 'proj_t',
    story: makeStory(),
    plan: makePlan(),
    project: { assets: [] },
    sceneIds: ['scene_a']
  })
  assert.deepEqual(inputs.map((i) => i.sceneId), ['scene_a'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('处置追加与轮次聚合：分片 control reviewId 归并到同一 roundId；human_confirmed 入账', () => {
  const dir = makeProjectDir()
  const file = path.join(dir, 'reviews', 'scene_reviews.jsonl')
  fs.mkdirSync(path.join(dir, 'reviews'), { recursive: true })
  const rid = 'sround_t_1'
  for (let i = 1; i <= 6; i += 1) {
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), kind: 'review', roundId: rid, reviewId: i <= 4 ? 'imgrev_x' : 'imgrev_y', sceneId: `sc_${i}`, sceneName: `场景${i}`, score: 80, verdict: 'pass', issues: [], suggestions: [] }) + '\n')
  }
  const fb = appendSceneReviewFeedback({ dir, sceneId: 'sc_2', sceneName: '场景2', action: 'human_confirmed', note: '人工确认通过' })
  assert.equal(fb.kind, 'human_confirmed')
  assert.equal(fb.sceneId, 'sc_2')
  const round = readLatestSceneReviewRound({ dir })
  assert.equal(round.latest.reviewId, rid)
  assert.equal(round.latest.records.length, 6, '分片归并为一轮 6 条')
  assert.equal(round.latest.feedback.length, 1)
  assert.equal(round.latest.summary.pass, 6)
  // 非法动作显式拒绝
  assert.throws(() => appendSceneReviewFeedback({ dir, sceneId: 'sc_1', action: 'bogus' }), /未知处置动作/)
  fs.rmSync(dir, { recursive: true, force: true })
})
