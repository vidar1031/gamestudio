import { describe, it } from 'node:test'
import assert from 'node:assert'
import { gateStoryOutput } from '../../src/server/services/storyOutputGate.js'

const validScriptCard = {
  id: 'c1',
  name: '开场',
  order: 1,
  text: '清晨，湖面泛起细碎光点。',
  updatedAt: '2026-06-18T12:00:00.000Z',
}

const validScriptDoc = {
  schemaVersion: '1.0',
  cards: [validScriptCard],
  updatedAt: '2026-06-18T12:00:00.000Z',
}

describe('Story Output Gate', () => {
  it('accepts valid story.scripts.write payload', () => {
    const result = gateStoryOutput('story.scripts.write', {
      projectId: 'p1',
      scripts: validScriptDoc,
    })
    assert.strictEqual(result.ok, true)
  })

  it('rejects scripts text with code blocks', () => {
    const result = gateStoryOutput('story.scripts.write', {
      projectId: 'p1',
      scripts: {
        ...validScriptDoc,
        cards: [{ ...validScriptCard, text: 'Run ```js console.log(1) ```' }],
      },
    })
    assert.strictEqual(result.ok, false)
    assert.ok(result.issues.some((i) => i.path.includes('cards.0.text')))
  })

  it('rejects scripts text with XML-like tags', () => {
    const result = gateStoryOutput('story.scripts.write', {
      projectId: 'p1',
      scripts: {
        ...validScriptDoc,
        cards: [{ ...validScriptCard, text: 'Open <script>alert(1)</script>' }],
      },
    })
    assert.strictEqual(result.ok, false)
  })

  it('rejects unknown story output type', () => {
    const result = gateStoryOutput('story.hacker.command', { projectId: 'p1' })
    assert.strictEqual(result.ok, false)
    assert.ok(result.issues[0].message.includes('Illegal story output type'))
  })

  it('rejects non-story payload fields', () => {
    const result = gateStoryOutput('story.project.create', {
      title: 'ok',
      maliciousCommand: 'rm -rf /',
    })
    assert.strictEqual(result.ok, false)
  })

  it('accepts valid story.project.create payload', () => {
    const result = gateStoryOutput('story.project.create', {
      title: '测试故事',
      choicePoints: 2,
      optionsPerChoice: 2,
      endings: 2,
    })
    assert.strictEqual(result.ok, true)
  })

  it('accepts valid story.scene.render payload', () => {
    const result = gateStoryOutput('story.scene.render', {
      projectId: 'p1',
      sceneId: 'scene1',
      width: 768,
      height: 1024,
    })
    assert.strictEqual(result.ok, true)
  })

  it('rejects scene render with out-of-range dimensions', () => {
    const result = gateStoryOutput('story.scene.render', {
      projectId: 'p1',
      sceneId: 'scene1',
      width: 9999,
    })
    assert.strictEqual(result.ok, false)
  })
})
