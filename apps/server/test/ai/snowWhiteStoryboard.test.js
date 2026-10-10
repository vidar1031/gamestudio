import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildCompositionInput, validateCompositionCoverage } from '../../src/ai/storyComposition.js'
import { expectedDwarfIds, expectedDwarfSceneIds, snowWhitePlan, snowWhiteStory } from '../fixtures/snowWhiteStoryFixture.js'

function reachableNodeIds(story) {
  const nodes = new Map(story.nodes.map((node) => [node.id, node]))
  const visited = new Set()
  const pending = [story.startNodeId]
  while (pending.length) {
    const nodeId = pending.pop()
    if (visited.has(nodeId)) continue
    const node = nodes.get(nodeId)
    assert.ok(node, `choice points to missing node: ${nodeId}`)
    visited.add(nodeId)
    for (const choice of node.choices || []) pending.push(choice.toNodeId)
  }
  return visited
}

function enumerateEndingPaths(story) {
  const nodes = new Map(story.nodes.map((node) => [node.id, node]))
  const paths = []
  const visit = (nodeId, path) => {
    const node = nodes.get(nodeId)
    const nextPath = [...path, nodeId]
    if (node.kind === 'ending') {
      paths.push(nextPath)
      return
    }
    for (const choice of node.choices || []) visit(choice.toNodeId, nextPath)
  }
  visit(story.startNodeId, [])
  return paths
}

function simulatedComposition(input) {
  return {
    scenes: input.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      items: scene.subjects.map((subject, index) => ({
        subjectId: subject.subjectId,
        stateKey: stateForScene(subject, scene.sceneId),
        x: (index + 1) / (scene.subjects.length + 1),
        y: 0.86,
        scale: scene.subjects.length >= 8 ? 0.34 : 0.48,
        zIndex: index + 1,
        flipH: index % 2 === 1,
        blocking: '按剧情关系错位站立',
        evidence: scene.summary.slice(0, 40)
      }))
    }))
  }
}

function stateForScene(subject, sceneId) {
  if (!subject.stateKeys.length) return ''
  if (subject.subjectId === 'snow-white') {
    if (sceneId === 'sw-01-palace') return 'palace-dress'
    if (sceneId === 'sw-03-stream-route' || sceneId === 'sw-04-mine-route' || sceneId === 'sw-05-cottage-arrival') return 'travel-cloak'
    if (sceneId === 'sw-10-dwarfs-wake' || sceneId === 'sw-11-defense-plan' || sceneId === 'sw-12-reveal' || sceneId.startsWith('sw-13-') || sceneId.startsWith('sw-14-') || sceneId.startsWith('sw-15-')) return 'recovered-dress'
    return 'cottage-dress'
  }
  if (subject.subjectId === 'queen') {
    return ['sw-07-vendor', 'sw-08-accept-apple', 'sw-09-refuse-apple'].includes(sceneId)
      ? 'apple-vendor-disguise'
      : 'queen-crowned'
  }
  if (subject.subjectId.startsWith('dwarf-')) {
    return ['sw-11-defense-plan', 'sw-12-reveal', 'sw-13-ending-choice', 'sw-14-ending-justice', 'sw-15-ending-new-life'].includes(sceneId)
      ? 'guard-vest'
      : 'mine-clothes'
  }
  return subject.stateKeys[0]
}

describe('Snow White 15-scene storyboard simulation', () => {
  it('has 15 reachable nodes, valid choice targets, two endings, and three real branch points', () => {
    const reached = reachableNodeIds(snowWhiteStory)
    const endingPaths = enumerateEndingPaths(snowWhiteStory)
    const endings = snowWhiteStory.nodes.filter((node) => node.kind === 'ending')
    const branchPoints = snowWhiteStory.nodes.filter((node) => (node.choices || []).length > 1)
    assert.equal(snowWhiteStory.nodes.length, 15)
    assert.equal(reached.size, 15)
    assert.equal(endings.length, 2)
    assert.deepEqual(endings.map((node) => node.id), ['sw-14-ending-justice', 'sw-15-ending-new-life'])
    assert.equal(branchPoints.length, 3)
    assert.equal(endingPaths.length, 8)
    assert.deepEqual(new Set(endingPaths.map((path) => path.at(-1))), new Set(endings.map((node) => node.id)))
  })

  it('builds complete composition input and simulates valid placements for every scene', () => {
    const input = buildCompositionInput({ project: { title: '白雪公主与七个小矮人' }, story: snowWhiteStory, plan: snowWhitePlan })
    const composition = simulatedComposition(input)
    assert.equal(input.scenes.length, 15)
    assert.deepEqual(validateCompositionCoverage(composition, input.scenes), [])

    for (const sceneId of expectedDwarfSceneIds) {
      const scene = composition.scenes.find((item) => item.sceneId === sceneId)
      const dwarfItems = scene.items.filter((item) => expectedDwarfIds.includes(item.subjectId))
      const sourceScene = input.scenes.find((item) => item.sceneId === sceneId)
      assert.equal(dwarfItems.length, 7, `${sceneId} must include every dwarf`)
      assert.equal(new Set(dwarfItems.map((item) => item.x)).size, 7, `${sceneId} must give dwarves distinct horizontal positions`)
      assert.ok(dwarfItems.every((item) => item.y >= 0.7 && item.scale <= 0.7 && item.zIndex > 0))
      assert.ok(dwarfItems.every((item) => sourceScene.subjects.find((subject) => subject.subjectId === item.subjectId).stateKeys.includes(item.stateKey)))
    }
    for (const scene of composition.scenes) {
      const sourceScene = input.scenes.find((item) => item.sceneId === scene.sceneId)
      assert.ok(scene.items.every((item) => sourceScene.subjects.find((subject) => subject.subjectId === item.subjectId).stateKeys.includes(item.stateKey)))
    }
    const snowWhiteStates = new Set(composition.scenes.flatMap((scene) => scene.items.filter((item) => item.subjectId === 'snow-white').map((item) => item.stateKey)))
    const queenStates = new Set(composition.scenes.flatMap((scene) => scene.items.filter((item) => item.subjectId === 'queen').map((item) => item.stateKey)))
    const dwarfStates = new Set(composition.scenes.flatMap((scene) => scene.items.filter((item) => expectedDwarfIds.includes(item.subjectId)).map((item) => item.stateKey)))
    assert.deepEqual([...snowWhiteStates].sort(), ['cottage-dress', 'palace-dress', 'recovered-dress', 'travel-cloak'])
    assert.deepEqual([...queenStates].sort(), ['apple-vendor-disguise', 'queen-crowned'])
    assert.deepEqual([...dwarfStates].sort(), ['guard-vest', 'mine-clothes'])
  })

  it('keeps costume changes and the queen disguise within each asset identity', () => {
    const input = buildCompositionInput({ project: { title: '白雪公主与七个小矮人' }, story: snowWhiteStory, plan: snowWhitePlan })
    const snowWhite = snowWhitePlan.assets.find((asset) => asset.id === 'snow-white')
    const queen = snowWhitePlan.assets.find((asset) => asset.id === 'queen')
    assert.deepEqual(snowWhite.stateVariants.map((variant) => variant.stateKey), ['palace-dress', 'travel-cloak', 'cottage-dress', 'recovered-dress'])
    assert.deepEqual(queen.stateVariants.map((variant) => variant.stateKey), ['queen-crowned', 'apple-vendor-disguise'])
    assert.ok(input.scenes.find((scene) => scene.sceneId === 'sw-06-seven-dwarfs').subjects.some((subject) => subject.subjectId === 'snow-white'))
  })
})