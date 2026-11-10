import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MODEL_SHEET_VIEW_IPADAPTER_ANIMAL,
  buildModelSheetNegativePrompt,
  buildModelSheetWholeNegativePrompt,
  pickPoseIdentityView,
  upsertModelSheetTestRun,
  upsertModelSheetView
} from '../src/ai/storyModelSheet.js'
import { chooseStoryboardAssetLoras } from '../src/ai/storyAssetText.js'
import { mapMvAdapterViews } from '../src/ai/mvAdapterViews.js'

test('整 sheet 与逐视角负向词隔离，整 sheet 不再禁止多视图', () => {
  const base = '森林, multiple views, character sheet, multiple panels, multiple characters, 多主体'
  const perView = buildModelSheetNegativePrompt(base)
  const whole = buildModelSheetWholeNegativePrompt(base)
  assert.match(perView, /multiple views/)
  assert.match(perView, /turnaround sheet/)
  assert.doesNotMatch(whole, /multiple views|character sheet|turnaround sheet|multiple panels|multiple characters|多主体/)
  assert.match(whole, /森林/)
  assert.match(whole, /watermark/)
})

test('动物 side/back 使用独立 IP-Adapter 档位，背面更弱且更晚介入', () => {
  assert.deepEqual(MODEL_SHEET_VIEW_IPADAPTER_ANIMAL.side, { weight: 0.55, startAt: 0.4, endAt: 0.8 })
  assert.deepEqual(MODEL_SHEET_VIEW_IPADAPTER_ANIMAL.back, { weight: 0.35, startAt: 0.5, endAt: 0.8 })
  assert.ok(MODEL_SHEET_VIEW_IPADAPTER_ANIMAL.back.weight < MODEL_SHEET_VIEW_IPADAPTER_ANIMAL.side.weight)
  assert.ok(MODEL_SHEET_VIEW_IPADAPTER_ANIMAL.back.startAt > MODEL_SHEET_VIEW_IPADAPTER_ANIMAL.side.startAt)
})

test('动物角色沿用显式风格 LoRA 并补动物 LoRA，按文件名去重', () => {
  const loras = chooseStoryboardAssetLoras({
    asset: { category: 'character', name: '大灰狼', anchorPrompt: 'anthropomorphic wolf' },
    requestedLoras: ['flat_childrenXX.safetensors:0.7'],
    stylePreset: { loras: { characterAnimal: 'Anime_Furry_Style_SDXL.safetensors:0.7' } }
  })
  assert.deepEqual(loras, ['flat_childrenXX.safetensors:0.7', 'Anime_Furry_Style_SDXL.safetensors:0.7'])
})

test('试验运行写回不改变正式视图或任何既有锁定字段', () => {
  const asset = {
    modelSheet: {
      lockedAt: 'parent-lock',
      sheetLockedAt: 'sheet-lock',
      views: [{ key: 'front', assetUri: 'primary.webp', lockedAt: 'front-lock' }],
      testRuns: [{ runId: 'old', status: 'reviewed' }]
    }
  }
  const next = upsertModelSheetTestRun(asset, { runId: 'new', engine: 'charturn', status: 'rejected', views: [] })
  assert.equal(next.lockedAt, 'parent-lock')
  assert.equal(next.sheetLockedAt, 'sheet-lock')
  assert.deepEqual(next.views, asset.modelSheet.views)
  assert.deepEqual(next.testRuns.map((run) => run.runId), ['old', 'new'])
  const replaced = upsertModelSheetTestRun({ modelSheet: next }, { runId: 'new', engine: 'mvadapter', status: 'pending', views: [] })
  assert.equal(replaced.testRuns.length, 2)
  assert.equal(replaced.testRuns[1].engine, 'mvadapter')
  assert.equal(replaced.testRuns[1].status, 'pending')
})

test('普通候选重出使父级锁定失效，试验辅助函数不承担该语义', () => {
  const asset = {
    modelSheet: {
      lockedAt: 'parent-lock',
      views: [{ key: 'side', assetUri: 'old.webp', lockedAt: 'side-lock' }]
    }
  }
  const next = upsertModelSheetView(asset, { key: 'side', assetUri: 'new.webp', reviewStatus: 'pending' })
  assert.equal(next.lockedAt, undefined)
  assert.equal(next.prevLockedAt, 'parent-lock')
  assert.equal(next.views[0].lockedAt, undefined)
  assert.equal(next.views[0].prevLockedAt, 'side-lock')
})

test('MV-Adapter 按固定角度顺序映射独立视图，数量不符时显式失败', () => {
  const images = ['front bytes', 'side bytes', 'back bytes'].map((bytes, index) => ({ bytes, ext: 'png', meta: { index } }))
  const views = mapMvAdapterViews(images)
  assert.deepEqual(views.map((view) => view.key), ['front', 'side', 'back'])
  assert.deepEqual(views.map((view) => view.azimuth), [0, 90, 180])
  assert.deepEqual(views.map((view) => view.bytes), ['front bytes', 'side bytes', 'back bytes'])
  assert.throws(() => mapMvAdapterViews(images.slice(0, 2)), /mvadapter_view_count_mismatch:expected=3 actual=2/)
})

test('标准系三视图退役后，姿势变体始终使用主参考', () => {
  assert.deepEqual(pickPoseIdentityView({ asset: {}, text: '背面奔跑' }), { viewKey: '', uri: '', source: 'primary' })
  const asset = {
    primaryReferenceAssetUri: 'primary.webp',
    modelSheet: {
      sheetAssetUri: 'sheet.webp',
      sheetLockedAt: 'locked',
      views: [{ key: 'back', assetUri: 'back.webp', lockedAt: 'locked' }]
    }
  }
  assert.deepEqual(pickPoseIdentityView({ asset, text: '背面奔跑' }), { viewKey: '', uri: '', source: 'primary' })
  assert.deepEqual(pickPoseIdentityView({ asset, text: '严格侧面' }), { viewKey: '', uri: '', source: 'primary' })
})
