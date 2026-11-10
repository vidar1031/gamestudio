import test from 'node:test'
import assert from 'node:assert/strict'
import { withResourceLease } from '../src/ai/resourceLease.js'

test('TalkScene 租约请求携带实际模型和项目，完成后释放', async () => {
  const originalFetch = global.fetch
  const originalBaseUrl = process.env.STUDIO_CONTROL_BASE_URL
  const originalEnabled = process.env.STUDIO_RESOURCE_LEASE_ENABLED
  const requests = []
  try {
    process.env.STUDIO_CONTROL_BASE_URL = 'http://control.test'
    process.env.STUDIO_RESOURCE_LEASE_ENABLED = 'true'
    global.fetch = async (url, options) => {
      const target = String(url)
      requests.push({ target, options })
      if (target.endsWith('/resources/lease')) {
        return new Response(JSON.stringify({ ok: true, leaseId: 'lease_model_test' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (target.endsWith('/resources/lease/release')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`unexpected_fetch:${target}`)
    }
    let runs = 0
    const result = await withResourceLease('llm', 'ts:llm:Qwen3.6-27B-4bit', async () => {
      runs += 1
      return 'done'
    }, { model: 'Qwen3.6-27B-4bit', projectId: 'talkscene-project' })
    assert.equal(result, 'done')
    assert.equal(runs, 1)
    const acquire = requests.find((request) => request.target.endsWith('/resources/lease'))
    const payload = JSON.parse(acquire.options.body)
    assert.equal(payload.kind, 'llm')
    assert.equal(payload.model, 'Qwen3.6-27B-4bit')
    assert.equal(payload.projectId, 'talkscene-project')
    const release = requests.find((request) => request.target.endsWith('/resources/lease/release'))
    assert.ok(release, '完成后必须释放租约')
    assert.equal(JSON.parse(release.options.body).leaseId, 'lease_model_test')
  } finally {
    global.fetch = originalFetch
    if (originalBaseUrl === undefined) delete process.env.STUDIO_CONTROL_BASE_URL
    else process.env.STUDIO_CONTROL_BASE_URL = originalBaseUrl
    if (originalEnabled === undefined) delete process.env.STUDIO_RESOURCE_LEASE_ENABLED
    else process.env.STUDIO_RESOURCE_LEASE_ENABLED = originalEnabled
  }
})

test('未显式指定模型时保持原租约兼容，不伪造模型字段', async () => {
  const originalFetch = global.fetch
  const originalBaseUrl = process.env.STUDIO_CONTROL_BASE_URL
  const originalEnabled = process.env.STUDIO_RESOURCE_LEASE_ENABLED
  try {
    process.env.STUDIO_CONTROL_BASE_URL = 'http://control.test'
    process.env.STUDIO_RESOURCE_LEASE_ENABLED = 'true'
    let requestBody
    global.fetch = async (url, options) => {
      const target = String(url)
      if (target.endsWith('/resources/lease')) {
        requestBody = JSON.parse(options.body)
        return new Response(JSON.stringify({ ok: true, leaseId: 'lease_default_model' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (target.endsWith('/resources/lease/release')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`unexpected_fetch:${target}`)
    }
    await withResourceLease('llm', 'forge:test', async () => 'done')
    assert.equal('model' in requestBody, false)
    assert.equal('projectId' in requestBody, false)
  } finally {
    global.fetch = originalFetch
    if (originalBaseUrl === undefined) delete process.env.STUDIO_CONTROL_BASE_URL
    else process.env.STUDIO_CONTROL_BASE_URL = originalBaseUrl
    if (originalEnabled === undefined) delete process.env.STUDIO_RESOURCE_LEASE_ENABLED
    else process.env.STUDIO_RESOURCE_LEASE_ENABLED = originalEnabled
  }
})

test('Responses 工具链把请求体中的实际模型同步传给租约层', async () => {
  const { openaiResponsesJsonForTools } = await import('../src/ai/openai.js')
  const originalFetch = global.fetch
  const envNames = [
    'STUDIO_CONTROL_BASE_URL',
    'STUDIO_RESOURCE_LEASE_ENABLED',
    'STUDIO_CONTROL_CLIENT_KEY',
    'LOCALOXML_API_KEY',
    'STUDIO_AI_API_KEY',
    'OPENAI_API_KEY',
    'LOCALOXML_MODEL',
    'STUDIO_AI_MODEL',
    'OPENAI_MODEL'
  ]
  const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
  try {
    for (const name of envNames) process.env[name] = ''
    process.env.STUDIO_CONTROL_BASE_URL = 'http://control.test'
    process.env.STUDIO_RESOURCE_LEASE_ENABLED = 'true'
    let leasePayload = null
    global.fetch = async (url, options) => {
      const target = String(url)
      if (target.endsWith('/resources/lease')) {
        leasePayload = JSON.parse(options.body)
        return new Response(JSON.stringify({ ok: false, error: 'lease_not_admitted:model_not_approved' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`unexpected_fetch:${target}`)
    }
    await assert.rejects(() => openaiResponsesJsonForTools({
      provider: 'localoxml',
      apiUrl: 'http://127.0.0.1:18888/v1',
      body: {
        model: 'Qwen3.6-27B-4bit',
        instructions: 'test',
        input: 'test',
        text: { format: { type: 'json_object' } }
      }
    }), /model_not_approved/)
    assert.equal(leasePayload.model, 'Qwen3.6-27B-4bit')
    assert.equal(leasePayload.holder, 'ts:llm:Qwen3.6-27B-4bit')
  } finally {
    global.fetch = originalFetch
    for (const name of envNames) {
      if (savedEnv[name] === undefined) delete process.env[name]
      else process.env[name] = savedEnv[name]
    }
  }
})
