import { describe, it } from 'node:test'
import assert from 'node:assert'
import { Hono } from 'hono'
import { storyInputGate } from '../../src/middleware/storyInputGate.js'

function buildApp(type, extractor) {
  const app = new Hono()
  app.post('/test', storyInputGate(type, extractor), (c) => c.json({ success: true }))
  return app
}

async function post(app, body) {
  const req = new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
}

const validScripts = {
  schemaVersion: '1.0',
  cards: [
    { id: 'c1', name: '开场', order: 1, text: '清晨，湖面泛起细碎光点。', updatedAt: '2026-06-18T12:00:00.000Z' },
  ],
  updatedAt: '2026-06-18T12:00:00.000Z',
}

describe('Story Input Gate', () => {
  it('accepts valid story.scripts.write', async () => {
    const app = buildApp('story.scripts.write', (c, body) => ({ projectId: 'p1', scripts: body.scripts }))
    const res = await post(app, { scripts: validScripts })
    assert.strictEqual(res.status, 200)
    const json = await res.json()
    assert.strictEqual(json.success, true)
  })

  it('rejects code block in script text', async () => {
    const app = buildApp('story.scripts.write', (c, body) => ({ projectId: 'p1', scripts: body.scripts }))
    const badScripts = {
      ...validScripts,
      cards: [{ ...validScripts.cards[0], text: 'Run ```js console.log(1)```' }],
    }
    const res = await post(app, { scripts: badScripts })
    assert.strictEqual(res.status, 400)
    const json = await res.json()
    assert.strictEqual(json.error, 'story_input_contract_violation')
    assert.ok(json.issues.some((i) => i.path.includes('cards.0.text')))
  })

  it('rejects unknown story type', async () => {
    const app = buildApp('story.hacker.command')
    const res = await post(app, {})
    assert.strictEqual(res.status, 400)
    const json = await res.json()
    assert.strictEqual(json.error, 'story_input_contract_violation')
  })

  it('accepts valid story.project.create', async () => {
    const app = buildApp('story.project.create')
    const res = await post(app, { title: '测试' })
    assert.strictEqual(res.status, 200)
  })

  it('rejects extra fields in story.project.create', async () => {
    const app = buildApp('story.project.create')
    const res = await post(app, { title: '测试', extra: 'bad' })
    assert.strictEqual(res.status, 400)
  })
})
