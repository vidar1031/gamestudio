import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

import {
  AGENT_STREAM_READONLY_TOOLS,
  createAgentStreamSseParser,
  createAgentStreamStepAssembler,
  describeAgentStreamToolCall,
  isAgentStreamToolAllowed,
  runAgentStreamChat,
  truncateAgentStreamText,
} from '../../apps/control-server/src/server/reasoning/agentStreamBridge.js'
import { registerAgentStreamRoutes } from '../../apps/control-server/src/server/routes/agentStreamRoutes.js'
import { applySessionTransition } from '../../apps/control-server/src/server/reasoning/sessionStateMachine.js'

// agent 流式咨询桥测试：只读白名单 / SSE 解析 / 步骤聚合 / 证据落盘 / 越权拦截 / 路由分流。
// 外部依赖全部走注入或 globalThis.fetch stub，不触碰真实网关与 state/ 目录。

function makeSseResponse(events) {
  const text = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function makeStreamFetch(events, recorder = {}) {
  return async (url, options = {}) => {
    recorder.calls = recorder.calls || []
    recorder.calls.push({ url: String(url), method: options.method || 'GET' })
    if (String(url).endsWith('/chat/stream')) {
      return makeSseResponse(events)
    }
    if (String(url).includes('/api/sessions/')) {
      return new Response('{}', { status: 200 })
    }
    if (String(url).endsWith('/api/sessions')) {
      return new Response(JSON.stringify({ session: { id: 'created_1' } }), { status: 201 })
    }
    return new Response('{}', { status: 200 })
  }
}

function makeStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-stream-bridge-'))
}

test('白名单：只读工具放行，副作用工具默认拒绝', () => {
  for (const tool of ['read_file', 'search_files', 'session_search', 'skill_view', 'skills_list', 'web_search', 'web_extract']) {
    assert.equal(isAgentStreamToolAllowed(tool), true, `${tool} 应在白名单内`)
  }
  for (const tool of ['execute_code', 'terminal', 'process', 'write_file', 'patch', 'memory', 'skill_manage', 'delegate', 'browser', '']) {
    assert.equal(isAgentStreamToolAllowed(tool), false, `${tool} 应被拒绝`)
  }
  assert.equal(AGENT_STREAM_READONLY_TOOLS.has('memory'), false, 'memory 工具只有写动作，不在只读白名单')
})

test('人话摘要：工具名映射为动作名 + 关键目标，不铺原始 JSON', () => {
  const read = describeAgentStreamToolCall('read_file', { path: '/a/b/STATUS.md' }, '/a/b/STATUS.md')
  assert.equal(read.actionLabel, '读取文件')
  assert.equal(read.target, '/a/b/STATUS.md')

  const search = describeAgentStreamToolCall('session_search', { query: '乌鸦喝水' }, null)
  assert.equal(search.actionLabel, '检索历史会话')
  assert.equal(search.target, '乌鸦喝水')

  const web = describeAgentStreamToolCall('web_search', { query: 'h5 互动故事' }, null)
  assert.equal(web.actionLabel, '联网搜索')
  assert.equal(web.target, 'h5 互动故事')

  const unknown = describeAgentStreamToolCall('some_tool', null, 'x'.repeat(500))
  assert.equal(unknown.actionLabel, '调用工具 some_tool')
  assert.ok(unknown.target.length <= 161, '超长 preview 应截断')
})

test('truncateAgentStreamText：超长截断', () => {
  assert.equal(truncateAgentStreamText('abc', 10), 'abc')
  assert.equal(truncateAgentStreamText('a'.repeat(20), 10), `${'a'.repeat(10)}…`)
})

test('SSE 解析：跨块、keepalive、多事件', () => {
  const parser = createAgentStreamSseParser()
  const payload = JSON.stringify({ delta: '你好' })
  const half = Math.floor(payload.length / 2)
  const chunks = [
    `: keepalive\n\nevent: assistant.delta\ndata: ${payload.slice(0, half)}`,
    `${payload.slice(half)}\n\nevent: run.started\nda`,
    `ta: {"seq":1}\n\n`
  ]
  const events = chunks.flatMap((chunk) => parser.feed(chunk))
  assert.equal(events.length, 2)
  assert.equal(events[0].event, 'assistant.delta')
  assert.equal(events[0].data.delta, '你好')
  assert.equal(events[1].event, 'run.started')
  assert.equal(events[1].data.seq, 1)
})

test('步骤聚合：思考→动作→结果→再思考 归为递增 STEP', () => {
  const asm = createAgentStreamStepAssembler()
  const t1 = asm.thinking('先查记忆。')
  assert.equal(t1.stepIndex, 1)
  const a1 = asm.toolStarted('read_file', { actionLabel: '读取文件', target: '/x' })
  assert.equal(a1.stepIndex, 1)
  const r1 = asm.toolFinished('read_file', true)
  assert.equal(r1.actionId, a1.actionId)
  const t2 = asm.thinking('记忆没有，再搜会话。')
  assert.equal(t2.stepIndex, 2, '动作完成后的新思考应开启新 STEP')
  const a2 = asm.toolStarted('session_search', { actionLabel: '检索历史会话', target: '乌鸦喝水' })
  assert.equal(a2.stepIndex, 2)
  // 同一思考步骤内追加思考不新开 STEP
  const asm2 = createAgentStreamStepAssembler()
  assert.equal(asm2.thinking('第一段').stepIndex, 1)
  assert.equal(asm2.thinking('第二段').stepIndex, 1)
})

test('bridge 全流程：事件透传 + 证据落盘 + 最终回答', async () => {
  const stateDir = makeStateDir()
  const streamed = []
  const evidence = []
  const result = await runAgentStreamChat({
    prompt: '乌鸦喝水之前做过吗？',
    agentId: 'hermes-manager',
    hermesApiBaseUrl: 'http://127.0.0.1:8742/v1',
    hermesApiKey: 'k',
    stateDir,
    fetchImpl: makeStreamFetch([
      { event: 'run.started', data: { user_message: { role: 'user', content: 'q' } } },
      { event: 'message.started', data: { message: { id: 'm1' } } },
      { event: 'tool.progress', data: { tool_name: '_thinking', delta: '先检索历史会话。' } },
      { event: 'tool.started', data: { tool_name: 'session_search', preview: '乌鸦喝水', args: { query: '乌鸦喝水' } } },
      { event: 'tool.completed', data: { tool_name: 'session_search' } },
      { event: 'tool.progress', data: { tool_name: '_thinking', delta: '会话里有记录，直接回答。' } },
      { event: 'assistant.delta', data: { delta: '做过，' } },
      { event: 'assistant.delta', data: { delta: '证据如下。' } },
      { event: 'assistant.completed', data: { content: '做过，证据如下。' } },
      { event: 'run.completed', data: { usage: { total_tokens: 10 } } },
      { event: 'done', data: {} },
    ]),
    onStreamEvent: (evt) => streamed.push(evt),
    appendEvidence: (type, title, summary) => evidence.push({ type, title, summary }),
  })

  assert.equal(result.ok, true)
  assert.equal(result.finalAnswer, '做过，证据如下。')
  assert.deepEqual(result.usage, { total_tokens: 10 })

  const streamTypes = streamed.map((evt) => evt.type)
  assert.deepEqual(streamTypes, ['thinking', 'action', 'action_result', 'thinking', 'answer_delta', 'answer_delta'])
  assert.equal(streamed[0].stepIndex, 1)
  assert.equal(streamed[1].stepIndex, 1)
  assert.equal(streamed[1].actionLabel, '检索历史会话')
  assert.equal(streamed[1].target, '乌鸦喝水')
  assert.equal(streamed[3].stepIndex, 2, '第二个思考块应开启 STEP 2')

  const evidenceTypes = evidence.map((item) => item.type)
  assert.deepEqual(evidenceTypes, ['agent_thinking', 'agent_tool_call', 'agent_tool_result', 'agent_thinking'])
  assert.ok(evidence[1].summary.includes('乌鸦喝水'), '工具证据应含人话目标')
  assert.ok(!evidence[1].summary.includes('{'), '证据摘要不得铺原始 JSON')
})

test('bridge 白名单拦截：越权工具立即中止并留证据', async () => {
  const stateDir = makeStateDir()
  const streamed = []
  const evidence = []
  const result = await runAgentStreamChat({
    prompt: '帮我跑个脚本',
    agentId: 'hermes-manager',
    hermesApiBaseUrl: 'http://127.0.0.1:8742/v1',
    stateDir,
    fetchImpl: makeStreamFetch([
      { event: 'tool.progress', data: { tool_name: '_thinking', delta: '准备执行代码。' } },
      { event: 'tool.started', data: { tool_name: 'execute_code', preview: 'import os...', args: { code: 'import os' } } },
      // 拦截后上游流会被 cancel，后续事件不应再出现；这里故意提供以验证不被消费
      { event: 'assistant.completed', data: { content: '不应到达' } },
    ]),
    onStreamEvent: (evt) => streamed.push(evt),
    appendEvidence: (type, title, summary) => evidence.push({ type, title, summary }),
  })

  assert.equal(result.ok, false)
  assert.equal(result.blockedTool, 'execute_code')
  assert.ok(result.finalAnswer.includes('已超出咨询只读边界'), '拦截后应给出人话拒绝文案')
  const streamTypes = streamed.map((evt) => evt.type)
  assert.deepEqual(streamTypes, ['thinking', 'blocked'])
  assert.deepEqual(evidence.map((item) => item.type), ['agent_thinking', 'agent_tool_blocked'])
  assert.ok(evidence[1].title.includes('execute_code'))
})

test('bridge 外部取消：isAborted 触发后中止', async () => {
  const stateDir = makeStateDir()
  const result = await runAgentStreamChat({
    prompt: 'q',
    agentId: 'hermes-manager',
    hermesApiBaseUrl: 'http://127.0.0.1:8742/v1',
    stateDir,
    fetchImpl: makeStreamFetch([{ event: 'done', data: {} }]),
    isAborted: () => true,
  })
  assert.equal(result.aborted, true)
  assert.equal(result.ok, false)
})

test('bridge 会话映射失效时重建 hermes 会话', async () => {
  const stateDir = makeStateDir()
  fs.writeFileSync(path.join(stateDir, 'hermes-manager.json'), JSON.stringify({ hermesSessionId: 'gone_session' }), 'utf8')
  const recorder = {}
  const fetchImpl = async (url, options = {}) => {
    recorder.calls = recorder.calls || []
    recorder.calls.push({ url: String(url), method: options.method || 'GET' })
    if (String(url).endsWith('/api/sessions/gone_session')) return new Response('{}', { status: 404 })
    if (String(url).endsWith('/api/sessions')) return new Response(JSON.stringify({ session: { id: 'new_1' } }), { status: 201 })
    if (String(url).includes('/chat/stream')) return makeSseResponse([{ event: 'done', data: {} }])
    return new Response('{}', { status: 200 })
  }
  await runAgentStreamChat({
    prompt: 'q',
    agentId: 'hermes-manager',
    hermesApiBaseUrl: 'http://127.0.0.1:8742/v1',
    stateDir,
    fetchImpl,
  })
  const methods = recorder.calls.map((c) => `${c.method} ${c.url}`)
  assert.ok(methods.some((line) => line.startsWith('POST') && line.includes('/api/sessions')), '旧会话 404 后应重建')
  const mapping = JSON.parse(fs.readFileSync(path.join(stateDir, 'hermes-manager.json'), 'utf8'))
  assert.ok(mapping.hermesSessionId.startsWith('ctrlstream_hermes-manager_'))
})

// ---------------------------------------------------------------------------
// 路由层：分流 + SSE 透传 + 证据落盘
// ---------------------------------------------------------------------------

function makeRouteHarness({ streamEvents }) {
  const sessions = new Map()
  const replies = []
  const context = {
    hermesAgentDefinition: { id: 'hermes-manager' },
    HERMES_API_SERVER_BASE_URL: 'http://127.0.0.1:8742/v1',
    readHermesApiServerKey: () => 'k',
    getHermesRuntimeState: () => ({ state: 'running' }),
    getHermesControlState: () => ({}),
    buildReasoningStartBlocker: () => null,
    createReasoningSession: async (agentId, userPrompt, submissionContext) => {
      const session = {
        sessionId: `sess_${sessions.size + 1}`,
        agentId,
        userPrompt,
        submissionContext,
        status: 'queued',
        events: [],
        artifacts: {},
        review: null,
        currentStepId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      sessions.set(session.sessionId, session)
      return session
    },
    readReasoningSession: (sessionId) => sessions.get(sessionId) || null,
    updateReasoningSession: (sessionId, updater) => {
      const current = sessions.get(sessionId)
      if (!current) throw new Error('reasoning_session_not_found')
      const next = { ...updater(current), updatedAt: new Date().toISOString() }
      sessions.set(sessionId, next)
      return next
    },
    appendReasoningEvent: (sessionId, type, title, summary, extra = {}) => {
      const current = sessions.get(sessionId)
      if (!current) throw new Error('reasoning_session_not_found')
      current.events.push({ type, title, summary, ...extra })
      return current
    },
    persistHermesChatPrompt: () => {},
    persistHermesChatReply: (sessionId, reply) => replies.push({ sessionId, reply }),
    markReasoningSessionFailed: (sessionId, error) => {
      const current = sessions.get(sessionId)
      if (current) {
        current.status = 'failed'
        current.error = String(error)
      }
    },
  }
  const app = new Hono()
  registerAgentStreamRoutes(app, context)
  const savedFetch = globalThis.fetch
  globalThis.fetch = makeStreamFetch(streamEvents)
  return {
    app,
    sessions,
    replies,
    restore: () => { globalThis.fetch = savedFetch },
  }
}

test('路由：非咨询类（生产指令）返回 not_consultative 供 console 回退', async () => {
  const harness = makeRouteHarness({ streamEvents: [] })
  try {
    const res = await harness.app.request('/api/control/agents/hermes-manager/agent-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '一口气生产一个小红帽互动故事' }),
    })
    assert.equal(res.status, 200)
    const payload = await res.json()
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'not_consultative')
    assert.equal(payload.classification.route, 'workflow_execute')
    assert.equal(harness.sessions.size, 0, '非咨询类不得创建 session')
  } finally {
    harness.restore()
  }
})

test('路由：咨询问句走 agent 流，SSE 透传 + 证据落盘 + 最终回答写回', async () => {
  const harness = makeRouteHarness({
    streamEvents: [
      { event: 'tool.progress', data: { tool_name: '_thinking', delta: '先查证项目记忆。' } },
      { event: 'tool.started', data: { tool_name: 'read_file', preview: '/x/STATUS.md', args: { path: '/x/STATUS.md' } } },
      { event: 'tool.completed', data: { tool_name: 'read_file' } },
      { event: 'assistant.completed', data: { content: '可以创建，依据如下。' } },
      { event: 'run.completed', data: { usage: { total_tokens: 8 } } },
      { event: 'done', data: {} },
    ],
  })
  try {
    const res = await harness.app.request('/api/control/agents/hermes-manager/agent-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // R013 咨询问句形态：命中 answer_only
      body: JSON.stringify({ prompt: '你能否使用gamestudio创建故事《乌鸦喝水》？' }),
    })
    assert.equal(res.status, 200)
    assert.match(String(res.headers.get('content-type')), /text\/event-stream/)
    const body = await res.text()
    assert.ok(body.includes('event: session'), '应先收到 session 事件')
    assert.ok(body.includes('event: thinking'), '应透传思考事件')
    assert.ok(body.includes('event: action'), '应透传动作事件')
    assert.ok(body.includes('event: action_result'), '应透传结果事件')
    assert.ok(body.includes('event: final'), '应有最终回答事件')
    assert.ok(body.includes('可以创建，依据如下。'), '最终回答应出现在 final 事件')
    assert.ok(body.includes('event: done'))

    assert.equal(harness.sessions.size, 1)
    const session = [...harness.sessions.values()][0]
    assert.equal(session.status, 'completed', '流式咨询成功后 session 应收敛为 completed')
    assert.equal(session.artifacts.finalAnswer, '可以创建，依据如下。')
    assert.equal(session.submissionContext.executionMode, 'agent_stream')
    const eventTypes = session.events.map((event) => event.type)
    assert.deepEqual(eventTypes, [
      'agent_stream_started',
      'agent_thinking',
      'agent_tool_call',
      'agent_tool_result',
      'final_answer_ready',
      'session_completed',
    ])
    assert.equal(harness.replies.length, 1, '最终回答应写回聊天历史')
    assert.equal(harness.replies[0].reply, '可以创建，依据如下。')
  } finally {
    harness.restore()
  }
})

test('路由：越权工具时 session 收敛为 blocked 并写回拒绝文案', async () => {
  const harness = makeRouteHarness({
    streamEvents: [
      { event: 'tool.started', data: { tool_name: 'terminal', preview: 'rm -rf /', args: { command: 'rm -rf /' } } },
      { event: 'assistant.completed', data: { content: '不应到达' } },
    ],
  })
  try {
    const res = await harness.app.request('/api/control/agents/hermes-manager/agent-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '你能解释一下故事工作流吗？' }),
    })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.ok(body.includes('event: blocked'), '应收到 blocked 事件')
    const session = [...harness.sessions.values()][0]
    assert.equal(session.status, 'blocked')
    assert.ok(session.artifacts.finalAnswer.includes('只读边界'))
    assert.ok(session.events.some((event) => event.type === 'agent_tool_blocked'))
    assert.ok(session.events.some((event) => event.type === 'session_blocked'))
  } finally {
    harness.restore()
  }
})

test('路由：runtime 未运行时明确阻断', async () => {
  const harness = makeRouteHarness({ streamEvents: [] })
  try {
    harness.app = new Hono()
    const sessions = new Map()
    registerAgentStreamRoutes(harness.app, {
      hermesAgentDefinition: { id: 'hermes-manager' },
      HERMES_API_SERVER_BASE_URL: 'http://127.0.0.1:8742/v1',
      readHermesApiServerKey: () => 'k',
      getHermesRuntimeState: () => ({ state: 'stopped' }),
      getHermesControlState: () => ({}),
      buildReasoningStartBlocker: () => null,
      createReasoningSession: async () => { throw new Error('should_not_create') },
      readReasoningSession: (id) => sessions.get(id) || null,
      updateReasoningSession: () => { throw new Error('should_not_update') },
      appendReasoningEvent: () => { throw new Error('should_not_append') },
      persistHermesChatPrompt: () => {},
      persistHermesChatReply: () => {},
      markReasoningSessionFailed: () => {},
    })
    const res = await harness.app.request('/api/control/agents/hermes-manager/agent-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '什么是故事工作流？' }),
    })
    assert.equal(res.status, 409)
    const payload = await res.json()
    assert.equal(payload.error, 'runtime_not_running')
  } finally {
    harness.restore()
  }
})
