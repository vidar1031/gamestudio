import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// V1.3 工艺知识库加载模块单测：加载/别名匹配/未知 id 容错/缓存失效/损坏件降级。
// 夹具为临时目录的迷你工艺库，不触碰真实 storage/_shared/craft_library。

const {
  listCraftSkills,
  getCraftSkill,
  matchCraftSkillsByText,
  getPerformanceRules,
  resolveCarrierPlacementPlan,
  reloadCraftLibrary
} = await import('../../apps/server/src/ai/craftLibrary.js')

function makeLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-lib-'))
  fs.mkdirSync(path.join(dir, 'carrier'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'performance'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'carrier', 'holding_tray.json'), JSON.stringify({
    schemaVersion: '1.0',
    id: 'carrier.holding_tray',
    category: 'carrier',
    name: '端盘持物',
    nameEn: 'holding tray',
    description: '角色双手端持盘/碗/盆类承载物',
    aliases: ['端盘', '端碗', '端来', '托盘'],
    generation: { mode: 'carrier_variant', promptTemplate: '{characterAnchor}, holding tray, {propOnTray}' },
    placement: { mode: 'replace_prop_with_carrier' },
    acceptance: ['承载物与角色在同一图内']
  }))
  fs.writeFileSync(path.join(dir, 'performance', 'levels.json'), JSON.stringify({
    schemaVersion: '1.0',
    id: 'performance.levels',
    category: 'performance',
    name: '表现度规范',
    levels: {
      realistic: { label: '写实（不拟人）', anchorRule: 'r', reviewRule: 'rr' },
      lite: { label: '轻度拟人', anchorRule: 'l', reviewRule: 'lr' },
      full: { label: '完全拟人', anchorRule: 'f', reviewRule: 'fr' }
    },
    default: 'lite'
  }))
  // 损坏件：不拖垮整库
  fs.writeFileSync(path.join(dir, 'carrier', 'broken.json'), 'not-json{{{')
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schemaVersion: '1.0',
    skills: ['carrier/holding_tray.json', 'performance/levels.json', 'carrier/broken.json', 'carrier/missing.json']
  }))
  return dir
}

test('加载：目录摘要含 id/name/category/aliases/description；损坏/缺失件跳过不拖垮整库', () => {
  const dir = makeLibrary()
  const list = listCraftSkills(dir)
  assert.equal(list.length, 2, '损坏/缺失件跳过')
  assert.deepEqual(list.map((s) => s.id), ['carrier.holding_tray', 'performance.levels'])
  assert.equal(list[0].name, '端盘持物')
  assert.equal(list[0].category, 'carrier')
  assert.deepEqual(list[0].aliases, ['端盘', '端碗', '端来', '托盘'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('getCraftSkill：取单件；未知 id 返回 null 不抛', () => {
  const dir = makeLibrary()
  const skill = getCraftSkill('carrier.holding_tray', dir)
  assert.ok(skill)
  assert.equal(skill.generation.mode, 'carrier_variant')
  assert.ok(skill.generation.promptTemplate.includes('{characterAnchor}'))
  assert.equal(getCraftSkill('carrier.not_exist', dir), null)
  assert.equal(getCraftSkill('', dir), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('matchCraftSkillsByText：别名/名称子串命中；无命中返回 []', () => {
  const dir = makeLibrary()
  assert.deepEqual(matchCraftSkillsByText('爸爸端来一盘梨', dir), ['carrier.holding_tray'], '别名「端来」命中')
  assert.deepEqual(matchCraftSkillsByText('他把托盘递过来', dir), ['carrier.holding_tray'])
  assert.deepEqual(matchCraftSkillsByText('小猫在河边钓鱼', dir), [])
  assert.deepEqual(matchCraftSkillsByText('', dir), [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('getPerformanceRules：三档规则取值 + 未知 level 回落默认；库缺失返回 null', () => {
  const dir = makeLibrary()
  assert.equal(getPerformanceRules('realistic', dir)?.label, '写实（不拟人）')
  assert.equal(getPerformanceRules('full', dir)?.anchorRule, 'f')
  assert.equal(getPerformanceRules('weird', dir)?.level, 'lite', '未知回落 default')
  assert.equal(getPerformanceRules('', dir)?.level, 'lite')
  // 库缺失目录：null，不抛
  assert.equal(getPerformanceRules('lite', path.join(dir, 'not-exist')), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('缓存：manifest mtime 变化才重读（reloadCraftLibrary 强制清缓存）', () => {
  const dir = makeLibrary()
  const first = listCraftSkills(dir)
  assert.equal(first.length, 2)
  // 同目录再读（缓存命中，对象引用同一数组）
  assert.equal(listCraftSkills(dir), first)
  reloadCraftLibrary()
  const reloaded = listCraftSkills(dir)
  assert.equal(reloaded.length, 2)
  assert.notEqual(reloaded, first, 'reload 后重新读取')
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------- V1.3 载体摆位规划（placements 消费载体变体） ----------

function makeCarrierLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-lib-carrier-'))
  fs.mkdirSync(path.join(dir, 'carrier'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'carrier', 'holding_tray.json'), JSON.stringify({
    schemaVersion: '1.0',
    id: 'carrier.holding_tray',
    category: 'carrier',
    name: '端盘持物',
    aliases: ['端盘'],
    placement: { mode: 'replace_prop_with_carrier' }
  }))
  fs.writeFileSync(path.join(dir, 'carrier', 'passing_object.json'), JSON.stringify({
    schemaVersion: '1.0',
    id: 'carrier.passing_object',
    category: 'carrier',
    name: '递物交接',
    aliases: ['递给'],
    placement: { mode: 'replace_both_with_pair' }
  }))
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schemaVersion: '1.0',
    skills: ['carrier/holding_tray.json', 'carrier/passing_object.json']
  }))
  return dir
}

test('载体摆位规划：命中（角色用变体 + 被承载道具跳过）；未命中/无变体回退现行为', () => {
  const dir = makeCarrierLibrary()
  const assets = [
    {
      id: 'father',
      poseVariants: [
        { id: 'v1', poseKey: 'carrier.holding_tray', projectAssetId: 'asset_carrier_1', carrierPropAssetId: 'prop_tray' }
      ]
    },
    { id: 'brother', poseVariants: [] }
  ]
  const compItems = new Map([
    ['father', { subjectId: 'father', skillIds: ['carrier.holding_tray'] }],
    ['prop_tray', { subjectId: 'prop_tray' }]
  ])
  const plan = resolveCarrierPlacementPlan({ compItems, presentAssets: assets }, dir)
  assert.equal(plan.variantByAssetId.get('father')?.projectAssetId, 'asset_carrier_1', '角色摆位用载体变体')
  assert.ok(plan.coveredPropIds.has('prop_tray'), '被承载道具不再独立摆位')
  assert.equal(plan.pairSkipAssetIds.size, 0)

  // 未命中：构图项无 skillIds
  const plan2 = resolveCarrierPlacementPlan({ compItems: new Map([['father', { subjectId: 'father' }]]), presentAssets: assets }, dir)
  assert.equal(plan2.variantByAssetId.size, 0)
  assert.equal(plan2.coveredPropIds.size, 0)

  // 无变体回退：skillId 在构图里但资产未注册该变体
  const plan3 = resolveCarrierPlacementPlan({ compItems, presentAssets: [{ id: 'father', poseVariants: [] }] }, dir)
  assert.equal(plan3.variantByAssetId.size, 0, '无已注册变体时回退现行为')
  assert.equal(plan3.coveredPropIds.size, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('载体摆位规划：双人载体（replace_both_with_pair）另一端角色跳过独立摆位', () => {
  const dir = makeCarrierLibrary()
  const assets = [
    { id: 'giver', poseVariants: [{ id: 'v1', poseKey: 'carrier.passing_object', projectAssetId: 'asset_pair_1', carrierPropAssetId: 'prop_pear' }] },
    { id: 'receiver', poseVariants: [] }
  ]
  const compItems = new Map([
    ['giver', { subjectId: 'giver', skillIds: ['carrier.passing_object'] }],
    ['receiver', { subjectId: 'receiver', skillIds: ['carrier.passing_object'] }],
    ['prop_pear', { subjectId: 'prop_pear' }]
  ])
  const plan = resolveCarrierPlacementPlan({ compItems, presentAssets: assets }, dir)
  assert.equal(plan.variantByAssetId.get('giver')?.projectAssetId, 'asset_pair_1')
  assert.ok(plan.coveredPropIds.has('prop_pear'), '传递物不再独立摆位')
  assert.ok(plan.pairSkipAssetIds.has('receiver'), '接者不再独立摆位')
  assert.ok(!plan.pairSkipAssetIds.has('giver'))
  fs.rmSync(dir, { recursive: true, force: true })
})
