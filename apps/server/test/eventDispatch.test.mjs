import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'talkscene-event-dispatch-'))
const registryFile = path.join(TMP_ROOT, 'registry.json')
process.env.TALKSCENE_EVENT_REGISTRY_FILE = registryFile
process.env.TALKSCENE_EVENT_INBOUND_LOG_FILE = path.join(TMP_ROOT, 'inbound.jsonl')

const registry = {
  provider: { id: 'talkscene', dispatchEndpoint: '/api/events/dispatch' },
  events: [
    {
      eventId: 'studio.tasks.list', code: 'TS-59', aliases: ['全局任务台账'], kind: 'query', reviewRequired: false,
      payloadSchema: { type: 'object' }, transport: { http: { method: 'GET', path: '/api/ai/tasks' } }
    },
    {
      eventId: 'project.configure', code: 'TS-03', kind: 'command', reviewRequired: true,
      payloadSchema: { type: 'object', required: ['projectId', 'config'] },
      transport: { http: { method: 'POST', path: '/api/projects/:id/configure' } }
    }
  ]
}
fs.writeFileSync(registryFile, JSON.stringify(registry))

const { dispatchEventInbound } = await import('../src/events/dispatch.js')

function fixture() {
  const app = new Hono()
  const calls = []
  app.get('/api/ai/tasks', (c) => {
    calls.push({ method: 'GET', query: c.req.query() })
    return c.json({ success: true, tasks: [] })
  })
  app.post('/api/projects/:id/configure', async (c) => {
    const body = await c.req.json()
    calls.push({ method: 'POST', projectId: c.req.param('id'), body })
    return c.json({ success: true, project: { projectId: c.req.param('id') } })
  })
  return { app, calls }
}

test('统一接收端支持事件引用、GET 映射与 traceId 留痕', async () => {
  const { app, calls } = fixture()
  const { status, envelope } = await dispatchEventInbound(app, {
    body: { event: 'TS-59', payload: { includeDone: 'true' }, traceId: 'trace-query', caller: 'testcase' }
  })
  assert.equal(status, 200)
  assert.equal(envelope.success, true)
  assert.equal(envelope.traceId, 'trace-query')
  assert.equal(envelope.transport.endpoint, '/api/ai/tasks?includeDone=true')
  assert.equal(calls[0].query.includeDone, 'true')
  assert.equal(fs.readFileSync(process.env.TALKSCENE_EVENT_INBOUND_LOG_FILE, 'utf8').includes('trace-query'), true)
})

test('command 的原始载荷用于校验，兼容载荷用于旧 REST', async () => {
  const { app, calls } = fixture()
  const { status, envelope } = await dispatchEventInbound(app, {
    body: {
      event: 'project.configure',
      payload: { projectId: 'project-fixture', config: { genre: 'fixture' } },
      transportPayload: { project: { generationConfig: { genre: 'fixture' } } },
      confirmed: true,
      traceId: 'trace-configure'
    }
  })
  assert.equal(status, 200)
  assert.equal(envelope.success, true)
  assert.equal(calls[0].projectId, 'project-fixture')
  assert.equal(calls[0].body.project.generationConfig.genre, 'fixture')
  assert.equal(calls[0].body.projectId, undefined)
  assert.equal(calls[0].body.config, undefined)
})

test('command 未确认时阻断且不执行内部路由', async () => {
  const { app, calls } = fixture()
  const { status, envelope } = await dispatchEventInbound(app, {
    body: { event: 'project.configure', payload: { projectId: 'project-fixture', config: {} } }
  })
  assert.equal(status, 409)
  assert.equal(envelope.error, 'review_required')
  assert.equal(calls.length, 0)
})

test('缺少必填参数和未知事件显式失败', async () => {
  const { app, calls } = fixture()
  const missing = await dispatchEventInbound(app, {
    body: { event: 'project.configure', payload: { projectId: 'project-fixture' }, confirmed: true }
  })
  assert.equal(missing.status, 400)
  assert.equal(missing.envelope.error, 'payload_missing_required: config')
  const unknown = await dispatchEventInbound(app, { body: { event: 'event.absent', payload: {} } })
  assert.equal(unknown.status, 404)
  assert.equal(calls.length, 0)
})
