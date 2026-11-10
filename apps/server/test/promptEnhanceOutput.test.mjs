import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { once } from 'node:events'
import { enhanceStoryAssetPromptWithAi } from '../src/ai/storyAssetPromptEnhance.js'

const valid = {
  promptZh: '砖房，红棕色砖块，清晰灰缝，坚固基础，单物件设计参考图',
  negativePromptZh: '人物，文字，多视图，重复房屋',
  summary: '强化砖房结构、材质与轮廓稳定性'
}

test('提示词增强兼容内容数组、代码围栏与完整 JSON；空响应明确报错', async () => {
  const oldLease = process.env.STUDIO_RESOURCE_LEASE_ENABLED
  process.env.STUDIO_RESOURCE_LEASE_ENABLED = '0'
  let mode = 'array'
  const server = http.createServer((req, res) => {
    const content = mode === 'empty' ? {} : mode === 'plain'
      ? { choices: [{ message: { content: JSON.stringify(valid) } }] }
      : { choices: [{ message: { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`` }] } }] }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(content))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const apiUrl = `http://127.0.0.1:${server.address().port}/v1`
  try {
    let response = await enhanceStoryAssetPromptWithAi({
      input: { asset: { id: 'brick_house', name: '砖房', category: 'prop' } },
      provider: 'localoxml', model: 'Qwen3.6-27B-4bit', apiUrl
    })
    assert.deepEqual(response.result, valid)
    mode = 'plain'
    response = await enhanceStoryAssetPromptWithAi({
      input: { asset: { id: 'brick_house', name: '砖房', category: 'prop' } },
      provider: 'localoxml', model: 'Qwen3.6-27B-4bit', apiUrl
    })
    assert.deepEqual(response.result, valid)
    mode = 'empty'
    await assert.rejects(enhanceStoryAssetPromptWithAi({
      input: { asset: { id: 'brick_house', name: '砖房', category: 'prop' } },
      provider: 'localoxml', model: 'Qwen3.6-27B-4bit', apiUrl
    }), { message: 'empty_story_asset_prompt_enhance_output' })
  } finally {
    server.close()
    await once(server, 'close')
    if (oldLease === undefined) delete process.env.STUDIO_RESOURCE_LEASE_ENABLED
    else process.env.STUDIO_RESOURCE_LEASE_ENABLED = oldLease
  }
})

test('prefill 内存错误只在当前租约内清池一次并重试一次', async () => {
  const oldLease = process.env.STUDIO_RESOURCE_LEASE_ENABLED
  const oldControl = process.env.STUDIO_CONTROL_BASE_URL
  let chatCalls = 0
  let resetCalls = 0
  let releaseCalls = 0
  const server = http.createServer((req, res) => {
    if (req.url === '/api/control/resources/lease') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, leaseId: 'lease-test' }))
      return
    }
    if (req.url === '/api/control/resources/model/prefill-reset') {
      resetCalls += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.url === '/api/control/resources/lease/release') {
      releaseCalls += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.url === '/v1/chat/completions') {
      chatCalls += 1
      if (chatCalls === 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'oMLX prefill memory guard rejected this prompt: metal_cap ceiling' } }))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(valid) } }] }))
      }
      return
    }
    res.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  process.env.STUDIO_RESOURCE_LEASE_ENABLED = '1'
  process.env.STUDIO_CONTROL_BASE_URL = base
  try {
    const response = await enhanceStoryAssetPromptWithAi({
      input: { asset: { id: 'brick_house', name: '砖房', category: 'prop' } },
      provider: 'localoxml', model: 'Qwen3.6-27B-4bit', apiUrl: `${base}/v1`
    })
    assert.deepEqual(response.result, valid)
    assert.equal(chatCalls, 2)
    assert.equal(resetCalls, 1)
    assert.equal(releaseCalls, 1)
  } finally {
    server.close()
    await once(server, 'close')
    if (oldLease === undefined) delete process.env.STUDIO_RESOURCE_LEASE_ENABLED
    else process.env.STUDIO_RESOURCE_LEASE_ENABLED = oldLease
    if (oldControl === undefined) delete process.env.STUDIO_CONTROL_BASE_URL
    else process.env.STUDIO_CONTROL_BASE_URL = oldControl
  }
})
