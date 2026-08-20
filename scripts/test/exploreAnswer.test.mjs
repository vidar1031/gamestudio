import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assembleExploreEvidenceSources,
  buildSelfAwarenessFacts,
  parseRelevanceCheckResult,
  resolveExploreBudgets,
  runExploreAnswer,
  splitSourceIntoChunks,
} from '../../apps/control-server/src/server/reasoning/exploreAnswer.js'
import { classifyReasoningRequest } from '../../apps/control-server/src/server/reasoning/requestClassifier.js'

const EXPLORE_ENV_KEYS = [
  'HERMES_EXPLORE_CONTEXT_BUDGET',
  'HERMES_EXPLORE_CHUNK_CHARS',
  'HERMES_EXPLORE_NOTES_CHAR_LIMIT',
]
const savedEnv = Object.fromEntries(EXPLORE_ENV_KEYS.map((key) => [key, process.env[key]]))

function restoreEnv() {
  for (const key of EXPLORE_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
}

function makeFakeModel(handler) {
  const calls = []
  const requestCompletion = async (request) => {
    calls.push(request)
    const content = await handler(request, calls)
    return {
      choices: [{ message: { content: String(content ?? '') } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }
  }
  return { calls, requestCompletion }
}

function makeEvents() {
  const events = []
  return { events, appendEvent: (type, title, summary, extra) => events.push({ type, title, summary, extra }) }
}

test('预算解析：默认 16K/6000/4000，env 可覆盖，非法值回落默认', () => {
  restoreEnv()
  const defaults = resolveExploreBudgets({})
  assert.equal(defaults.contextBudget, 16000)
  assert.equal(defaults.chunkChars, 6000)
  assert.equal(defaults.notesCharLimit, 4000)

  const overridden = resolveExploreBudgets({
    HERMES_EXPLORE_CONTEXT_BUDGET: '8000',
    HERMES_EXPLORE_CHUNK_CHARS: '1000',
    HERMES_EXPLORE_NOTES_CHAR_LIMIT: '500',
  })
  assert.deepEqual(overridden, { contextBudget: 8000, chunkChars: 1000, notesCharLimit: 500 })

  const invalid = resolveExploreBudgets({ HERMES_EXPLORE_CHUNK_CHARS: 'abc', HERMES_EXPLORE_NOTES_CHAR_LIMIT: '-3' })
  assert.equal(invalid.chunkChars, 6000)
  assert.equal(invalid.notesCharLimit, 4000)
})

test('分块：按 chunkChars 顺序切片，空内容源不出块', () => {
  const source = { id: 's1', label: '源1', content: '甲'.repeat(13000) }
  const chunks = splitSourceIntoChunks(source, 6000)
  assert.equal(chunks.length, 3)
  assert.equal(chunks[0].text.length, 6000)
  assert.equal(chunks[2].text.length, 1000)
  assert.equal(chunks.map((chunk) => chunk.text).join(''), source.content)
  assert.equal(splitSourceIntoChunks({ id: 's2', label: '空', content: '   ' }, 6000).length, 0)
})

test('滚动压缩主流程：逐块提取 → 水位压缩 → 综合 → 自检；综合只装压缩结论', async () => {
  process.env.HERMES_EXPLORE_CHUNK_CHARS = '400'
  process.env.HERMES_EXPLORE_NOTES_CHAR_LIMIT = '260'
  try {
    const sources = [
      { id: 'self', label: '自我认知事实', content: `SELFMARKER ${'甲'.repeat(990)}` },
      { id: 'memory:0', label: '记忆文件 Project Memory', content: `MEMORYMARKER ${'乙'.repeat(890)}` },
    ]
    const { calls, requestCompletion } = makeFakeModel((request) => {
      if (request.phase === 'reasoning_explore_extract') return `事实要点：${'关'.repeat(110)}`
      if (request.phase === 'reasoning_explore_compress') return '压缩结论：关键事实A；关键事实B'
      if (request.phase === 'reasoning_explore_synthesize') return '最终回答：能。依据是压缩结论中的关键事实A。'
      if (request.phase === 'reasoning_explore_check') return '{"onTopic":true,"reason":"切题"}'
      return ''
    })
    const { events, appendEvent } = makeEvents()

    const result = await runExploreAnswer({
      sessionId: 'test-session',
      userPrompt: '你能否使用gamestudio创建故事？',
      sources,
      route: { transport: 'direct', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake' },
      requestCompletion,
      appendEvent,
    })

    // 1000 字 / 400 = 3 块；900 字 / 400 = 3 块
    const extractCalls = calls.filter((call) => call.phase === 'reasoning_explore_extract')
    const compressCalls = calls.filter((call) => call.phase === 'reasoning_explore_compress')
    const synthesizeCalls = calls.filter((call) => call.phase === 'reasoning_explore_synthesize')
    const checkCalls = calls.filter((call) => call.phase === 'reasoning_explore_check')
    assert.equal(extractCalls.length, 6)
    assert.ok(compressCalls.length >= 1, 'notes 水位超阈值必须触发压缩')
    assert.equal(synthesizeCalls.length, 1)
    assert.equal(checkCalls.length, 1)

    // 综合提示词只装压缩结论：已处理原文（SELFMARKER/MEMORYMARKER 长文）不得出现
    const synthesisUser = String(synthesizeCalls[0].messages.at(-1).content)
    assert.ok(synthesisUser.includes('压缩结论：关键事实A'), '综合必须基于压缩 notes')
    assert.ok(!synthesisUser.includes('SELFMARKER'), '已处理原文必须被丢弃')
    assert.ok(!synthesisUser.includes('MEMORYMARKER'), '已处理原文必须被丢弃')

    assert.equal(result.reply, '最终回答：能。依据是压缩结论中的关键事实A。')
    assert.equal(result.stats.chunkCount, 6)
    assert.ok(result.stats.compressions >= 1)
    assert.equal(result.stats.relevanceRetried, false)
    assert.equal(result.usage.total_tokens, calls.length * 15)

    const eventTypes = events.map((event) => event.type)
    assert.equal(eventTypes[0], 'explore_started')
    assert.equal(eventTypes.filter((type) => type === 'explore_chunk').length, 6)
    assert.ok(eventTypes.includes('explore_compress'))
    assert.ok(eventTypes.includes('explore_synthesis'))
    assert.equal(eventTypes.at(-1), 'explore_completed')
    const chunkEvent = events.find((event) => event.type === 'explore_chunk')
    assert.match(chunkEvent.title, /处理证据 1\/6/)
  } finally {
    restoreEnv()
  }
})

test('切题自检：不切题则带修正重答一次，重答结果作为最终回答', async () => {
  restoreEnv()
  const { calls, requestCompletion } = makeFakeModel((request, allCalls) => {
    if (request.phase === 'reasoning_explore_extract') return '事实：control 是守护智能体'
    if (request.phase === 'reasoning_explore_synthesize') {
      return allCalls.filter((call) => call.phase === 'reasoning_explore_synthesize').length === 1
        ? '答非所问：今天天气不错'
        : '修正回答：我是 control 守护智能体，负责编排与审核。'
    }
    if (request.phase === 'reasoning_explore_check') return '{"onTopic":false,"reason":"没有回答是什么系统"}'
    return ''
  })
  const { events, appendEvent } = makeEvents()

  const result = await runExploreAnswer({
    sessionId: 'test-session',
    userPrompt: '你是什么系统？',
    sources: [{ id: 'self', label: '自我认知事实', content: '身份：control 守护智能体。' }],
    route: { transport: 'direct', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake' },
    requestCompletion,
    appendEvent,
  })

  const synthesizeCalls = calls.filter((call) => call.phase === 'reasoning_explore_synthesize')
  assert.equal(synthesizeCalls.length, 2, '不切题必须重答一次且仅一次')
  assert.ok(String(synthesizeCalls[1].messages.at(-1).content).includes('上一轮回答未直接回应问题'), '重答必须带修正要求')
  assert.equal(result.reply, '修正回答：我是 control 守护智能体，负责编排与审核。')
  assert.equal(result.stats.relevanceRetried, true)
  assert.ok(events.some((event) => event.type === 'explore_relevance_retry'))
})

test('模型调用失败显式抛出（exploreFailure），不伪造回答、不再继续后续阶段', async () => {
  restoreEnv()
  const { calls, requestCompletion } = makeFakeModel((request) => {
    if (request.phase === 'reasoning_explore_extract') throw new Error('model_task_http_500')
    return '不应到达'
  })
  const { events, appendEvent } = makeEvents()

  await assert.rejects(
    runExploreAnswer({
      sessionId: 'test-session',
      userPrompt: '测试问题？',
      sources: [{ id: 'self', label: '自我认知事实', content: '一些事实内容。' }],
      route: { transport: 'direct', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake' },
      requestCompletion,
      appendEvent,
    }),
    (error) => {
      assert.equal(error.exploreFailure, true)
      assert.match(error.message, /explore_extract_failed:model_task_http_500/)
      return true
    }
  )
  assert.equal(calls.filter((call) => call.phase === 'reasoning_explore_synthesize').length, 0, '提取失败不得继续综合')
  assert.ok(events.some((event) => event.type === 'explore_chunk_failed'))
})

test('综合返回空正文：显式失败（empty_reply），不伪造', async () => {
  restoreEnv()
  const { requestCompletion } = makeFakeModel((request) => {
    if (request.phase === 'reasoning_explore_extract') return '事实：A'
    if (request.phase === 'reasoning_explore_synthesize') return ''
    return ''
  })
  await assert.rejects(
    runExploreAnswer({
      sessionId: 'test-session',
      userPrompt: '测试问题？',
      sources: [{ id: 'self', label: 's', content: '事实内容。' }],
      route: { transport: 'direct', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake' },
      requestCompletion,
    }),
    /explore_synthesize_failed:empty_reply/
  )
})

test('无证据源：跳过提取，综合提示词显式标注无相关事实，回答仍真实生成', async () => {
  restoreEnv()
  const { calls, requestCompletion } = makeFakeModel((request) => {
    if (request.phase === 'reasoning_explore_synthesize') return '回答：当前证据不足，无法确认。'
    if (request.phase === 'reasoning_explore_check') return '{"onTopic":true,"reason":"切题"}'
    return ''
  })
  const result = await runExploreAnswer({
    sessionId: 'test-session',
    userPrompt: '测试问题？',
    sources: [],
    route: { transport: 'direct', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake' },
    requestCompletion,
  })
  assert.equal(calls.filter((call) => call.phase === 'reasoning_explore_extract').length, 0)
  const synthesisUser = String(calls.find((call) => call.phase === 'reasoning_explore_synthesize').messages.at(-1).content)
  assert.ok(synthesisUser.includes('未提取到相关事实'))
  assert.ok(result.reply.length > 0)
})

test('证据块数超过硬上限：显式丢弃并留痕，不静默吞掉', async () => {
  process.env.HERMES_EXPLORE_CHUNK_CHARS = '200'
  try {
    const { requestCompletion } = makeFakeModel((request) => {
      if (request.phase === 'reasoning_explore_extract') return '事实：x'
      if (request.phase === 'reasoning_explore_compress') return '压缩结论：x'
      if (request.phase === 'reasoning_explore_synthesize') return '回答。'
      if (request.phase === 'reasoning_explore_check') return '{"onTopic":true}'
      return ''
    })
    const { events, appendEvent } = makeEvents()
    const result = await runExploreAnswer({
      sessionId: 'test-session',
      userPrompt: '测试问题？',
      sources: [{ id: 'big', label: '大源', content: '丙'.repeat(4000) }], // 20 块 > 上限 8
      route: { transport: 'direct', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake' },
      requestCompletion,
      appendEvent,
    })
    assert.equal(result.stats.chunkCount, 8)
    assert.equal(result.stats.droppedChunkCount, 12)
    const started = events.find((event) => event.type === 'explore_started')
    assert.match(started.summary, /丢弃 12 块/)
  } finally {
    restoreEnv()
  }
})

test('切题自检结果解析：裸 JSON / 代码块 JSON / 不可解析', () => {
  assert.deepEqual(parseRelevanceCheckResult('{"onTopic":false,"reason":"跑题"}'), { onTopic: false, reason: '跑题' })
  assert.deepEqual(parseRelevanceCheckResult('```json\n{"onTopic": true, "reason": "切题"}\n```'), { onTopic: true, reason: '切题' })
  assert.equal(parseRelevanceCheckResult('无法解析的输出'), null)
  assert.equal(parseRelevanceCheckResult(''), null)
})

test('问句形态优先：咨询问句不再进 story 工作流，祈使句保持强制工作流', () => {
  // 用户实测 bug：咨询问句被"创建+故事"关键词强制进生产工作流（真建了项目）
  const consultativeCreate = classifyReasoningRequest('可以使用gamestudio创建故事《乌鸦喝水》吗？先回答我？')
  assert.equal(consultativeCreate.type, 'answer_only')
  assert.equal(consultativeCreate.reason, 'consultative_question_form_overrides_story_workflow_execute')

  const consultativeCreate2 = classifyReasoningRequest('你能否使用gamestudio创建故事《乌鸦喝水》？')
  assert.equal(consultativeCreate2.type, 'answer_only')

  const consultativeWhy = classifyReasoningRequest('为什么故事生成失败？')
  assert.equal(consultativeWhy.type, 'answer_only')

  // 祈使句保持强制 story 工作流不变
  const imperative = classifyReasoningRequest('创建故事《乌鸦喝水》，一口气做完')
  assert.equal(imperative.type, 'story_workflow_execute')

  const imperative2 = classifyReasoningRequest('请帮我创建一个新的互动故事项目')
  assert.equal(imperative2.type, 'story_workflow_execute')

  // 普通咨询与既有分类不受影响
  assert.equal(classifyReasoningRequest('你是什么系统？').type, 'answer_only')
  assert.equal(classifyReasoningRequest('重启 control 服务').type, 'write_or_invoke_review')
})

test('自我认知事实块：从注入的运行时事实装配（绑定/注册表/健康/能力清单）', async () => {
  const text = await buildSelfAwarenessFacts({
    binding: { provider: 'omlx', model: 'Qwen3.6-27B-4bit', baseUrl: 'http://127.0.0.1:18888/v1' },
    route: { transport: 'direct' },
    deps: {
      getProjectBinding: () => ({ bound: true, id: 'gamestudio', label: 'GameStudio 交互故事', baseUrl: 'http://127.0.0.1:1999', source: 'default' }),
      probeProject: async () => ({ reachable: true, detail: '服务在线' }),
      probeModel: async () => ({ reachable: true, detail: '在线' }),
      probeComfyUi: async () => ({ reachable: false, detail: 'HTTP 503' }),
      readEventRegistry: () => ({ count: 38, version: '1.0.0' }),
    },
  })
  assert.match(text, /control 平面的守护智能体/)
  assert.match(text, /GameStudio 交互故事/)
  assert.match(text, /已注册 38 个事件/)
  assert.match(text, /Qwen3\.6-27B-4bit/)
  assert.match(text, /ComfyUI 出图服务.*不可达/)
  assert.match(text, /可绑定第三方项目/)
})

test('证据源装配：自我认知 + 记忆有界正文 + 近期对话回放，空内容源被过滤', async () => {
  const sources = await assembleExploreEvidenceSources({
    binding: { provider: 'omlx', model: 'm', baseUrl: 'http://x', workflow: { reasoningReplayWindowMessages: 4 } },
    route: { transport: 'direct' },
    userPrompt: '你是什么系统？',
    sessionId: 's1',
    deps: {
      getProjectBinding: () => ({ bound: false }),
      probeModel: async () => ({ reachable: false, detail: 'offline' }),
      probeComfyUi: async () => ({ reachable: false, detail: 'no binding' }),
      readEventRegistry: () => null,
      buildProjectMemorySections: () => [
        { label: 'Project Memory', content: '记忆事实：control 是唯一生产入口' },
        { label: 'Empty', content: '' },
      ],
      collectReplayableMessages: () => [
        { role: 'user', content: '之前的问题' },
        { role: 'assistant', content: '之前的回答' },
      ],
    },
  })
  const ids = sources.map((source) => source.id)
  assert.deepEqual(ids, ['self-awareness', 'memory:0', 'chat-replay'])
  assert.ok(sources[1].content.includes('记忆事实'))
  assert.ok(sources[2].content.includes('[用户] 之前的问题'))
})
