import assert from 'node:assert/strict'
import { normalizeProjectState } from '../src/studio/projectState.js'

const legacy = {
  vars: [{ name: 'hp', type: 'number', default: 1 }],
  aiBackground: {
    globalPrompt: '古代中国，统一世界观',
    globalNegativePrompt: 'text, watermark',
    storyboardScenes: {
      n1: { prompt: 'scene 1', negativePrompt: 'blur' }
    }
  }
}

const state = normalizeProjectState(legacy)
assert.ok(Array.isArray(state.vars), 'vars should be array')
assert.equal(state.aiBackground.schemaVersion, '1.0')
assert.equal(state.aiBackground.global.prompt, '古代中国，统一世界观')
assert.equal(state.aiBackground.global.negativePrompt, 'text, watermark')
assert.equal(state.aiBackground.globalPrompt, '古代中国，统一世界观')
assert.equal(state.aiBackground.storyboardScenes.n1.nodeId, 'n1')
assert.equal(state.aiBackground.storyboardScenes.n1.prompt, 'scene 1')

console.log('[ok] p1 state migration passed')

