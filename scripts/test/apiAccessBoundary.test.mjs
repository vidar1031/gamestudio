import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import {
  createApiAccessBoundary,
  isHighRiskApiRequest,
  resolveApiAccessConfig
} from '../../apps/control-server/src/server/security/apiAccessBoundary.js'
import { redactSecrets } from '../../apps/control-server/src/server/security/redaction.js'

// AUTO-D02 测试：Control API 访问边界（S3-07）。
// 覆盖：无凭证拒绝、合法凭证访问、localhost 模式语义、open 模式、错误响应与日志脱敏。
// 通过注入 getRemoteAddress / auditLogger 模拟不同来源地址与捕获审计日志，不依赖真实网络。

const LOCALHOST = '127.0.0.1'
const REMOTE = '192.168.1.50'
const TEST_TOKEN = 'test-token-d02-0123456789abcdef'

// 构造 harness：一条只读 GET + 一条高风险 POST + 一条会抛出带 secret 错误的 POST
function makeHarness({ mode, token, remoteAddress = LOCALHOST, auditLog = [] } = {}) {
  const app = new Hono()
  const boundary = createApiAccessBoundary({
    mode,
    token,
    getRemoteAddress: () => remoteAddress,
    auditLogger: (record) => auditLog.push(record)
  })
  app.use('/api/*', boundary)
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.get('/api/control/overview', (c) => c.json({ ok: true, agents: [] }))
  app.post('/api/control/agents/:agentId/runtime-action', (c) => c.json({ ok: true, action: 'start' }))
  app.post('/api/control/echo-error', (c) => c.json({ ok: false, error: `upstream failed: Authorization: Bearer ${TEST_TOKEN}` }, 500))
  return { app, auditLog, boundary }
}

function post(app, path, headers = {}) {
  return app.request(path, { method: 'POST', headers, body: '{}' })
}

// ---------------------------------------------------------------------------
// 高风险 API 分类
// ---------------------------------------------------------------------------

test('isHighRiskApiRequest：/api/ 下非 GET/HEAD/OPTIONS 为高风险，只读与非 /api 路径豁免', () => {
  assert.equal(isHighRiskApiRequest('POST', '/api/control/agents/hermes-manager/runtime-action'), true)
  assert.equal(isHighRiskApiRequest('DELETE', '/api/control/projects/p1'), true)
  assert.equal(isHighRiskApiRequest('PUT', '/api/control/agents/hermes-manager/config'), true)
  assert.equal(isHighRiskApiRequest('GET', '/api/control/overview'), false)
  assert.equal(isHighRiskApiRequest('GET', '/api/health'), false)
  assert.equal(isHighRiskApiRequest('OPTIONS', '/api/control/agents/x/runtime-action'), false)
  assert.equal(isHighRiskApiRequest('POST', '/not-api/path'), false)
})

// ---------------------------------------------------------------------------
// localhost 模式（默认）
// ---------------------------------------------------------------------------

test('localhost 模式（默认）：本机高风险请求放行', async () => {
  const { app, auditLog } = makeHarness({ mode: 'localhost', remoteAddress: LOCALHOST })
  const res = await post(app, '/api/control/agents/hermes-manager/runtime-action')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, action: 'start' })
  assert.equal(auditLog.length, 0)
})

test('localhost 模式（默认）：IPv6/映射本机地址同样放行', async () => {
  for (const addr of ['::1', '::ffff:127.0.0.1']) {
    const { app } = makeHarness({ mode: 'localhost', remoteAddress: addr })
    const res = await post(app, '/api/control/agents/hermes-manager/runtime-action')
    assert.equal(res.status, 200, `remote=${addr}`)
  }
})

test('localhost 模式：非本机无凭证高风险请求被拒绝（403 + api_access_denied）并写审计日志', async () => {
  const { app, auditLog } = makeHarness({ mode: 'localhost', remoteAddress: REMOTE })
  const res = await post(app, '/api/control/agents/hermes-manager/runtime-action')
  assert.equal(res.status, 403)
  const body = await res.json()
  assert.deepEqual(body, { ok: false, error: 'api_access_denied' })
  // 拒绝响应不得回显任何凭证材料
  assert.equal(JSON.stringify(body).includes(TEST_TOKEN), false)
  // 审计日志：记录方法/路径/来源/mode
  assert.equal(auditLog.length, 1)
  assert.equal(auditLog[0].event, 'api_access_denied')
  assert.equal(auditLog[0].method, 'POST')
  assert.equal(auditLog[0].remoteAddress, REMOTE)
  assert.equal(auditLog[0].mode, 'localhost')
})

test('localhost 模式：非本机只读请求（GET）不受影响', async () => {
  const { app, auditLog } = makeHarness({ mode: 'localhost', remoteAddress: REMOTE })
  const overview = await app.request('/api/control/overview')
  assert.equal(overview.status, 200)
  const health = await app.request('/api/health')
  assert.equal(health.status, 200)
  assert.equal(auditLog.length, 0)
})

test('无效 mode 配置回落到 localhost（安全默认，行为可解释）', () => {
  const config = resolveApiAccessConfig({ mode: 'bogus-mode' })
  assert.equal(config.mode, 'localhost')
})

// ---------------------------------------------------------------------------
// token 模式
// ---------------------------------------------------------------------------

test('token 模式：非本机携带合法 Bearer 凭证可访问高风险 API', async () => {
  const { app, auditLog } = makeHarness({ mode: 'token', token: TEST_TOKEN, remoteAddress: REMOTE })
  const res = await post(app, '/api/control/agents/hermes-manager/runtime-action', {
    authorization: `Bearer ${TEST_TOKEN}`
  })
  assert.equal(res.status, 200)
  assert.equal(auditLog.length, 0)
})

test('token 模式：非本机错误凭证 / 无凭证被拒绝', async () => {
  const { app, auditLog } = makeHarness({ mode: 'token', token: TEST_TOKEN, remoteAddress: REMOTE })
  const wrong = await post(app, '/api/control/agents/hermes-manager/runtime-action', {
    authorization: 'Bearer wrong-token'
  })
  assert.equal(wrong.status, 403)
  const none = await post(app, '/api/control/agents/hermes-manager/runtime-action')
  assert.equal(none.status, 403)
  assert.equal(auditLog.length, 2)
})

test('token 模式：本机请求无需凭证（既有受控开发流不断）', async () => {
  const { app } = makeHarness({ mode: 'token', token: TEST_TOKEN, remoteAddress: LOCALHOST })
  const res = await post(app, '/api/control/agents/hermes-manager/runtime-action')
  assert.equal(res.status, 200)
})

test('token 模式但未配置 CONTROL_API_TOKEN：非本机一律拒绝（fail-closed）', async () => {
  const { app } = makeHarness({ mode: 'token', token: '', remoteAddress: REMOTE })
  const res = await post(app, '/api/control/agents/hermes-manager/runtime-action', {
    authorization: `Bearer ${TEST_TOKEN}`
  })
  assert.equal(res.status, 403)
})

// ---------------------------------------------------------------------------
// open 模式
// ---------------------------------------------------------------------------

test('open 模式：不做来源限制（显式配置才生效）', async () => {
  const { app, auditLog } = makeHarness({ mode: 'open', remoteAddress: REMOTE })
  const res = await post(app, '/api/control/agents/hermes-manager/runtime-action')
  assert.equal(res.status, 200)
  assert.equal(auditLog.length, 0)
})

// ---------------------------------------------------------------------------
// 错误响应与日志脱敏
// ---------------------------------------------------------------------------

test('错误响应脱敏：路由返回的 4xx/5xx JSON 中的 Bearer token 被打码', async () => {
  const { app } = makeHarness({ mode: 'localhost', remoteAddress: LOCALHOST })
  const res = await post(app, '/api/control/echo-error')
  assert.equal(res.status, 500)
  const text = await res.text()
  assert.equal(text.includes(TEST_TOKEN), false)
  assert.equal(text.includes('Bearer ***'), true)
})

test('审计日志不含 secret：拒绝记录的路径字段过脱敏', async () => {
  const { app, auditLog } = makeHarness({ mode: 'localhost', remoteAddress: REMOTE })
  await post(app, `/api/control/agents/hermes-manager/runtime-action?key=${TEST_TOKEN}`)
  assert.equal(auditLog.length, 1)
  const logText = JSON.stringify(auditLog[0])
  assert.equal(logText.includes(TEST_TOKEN), false)
})

test('redactSecrets：Bearer / sk- / key=value / 敏感 env 值均被打码', () => {
  const savedEnv = process.env.CONTROL_API_TOKEN
  process.env.CONTROL_API_TOKEN = TEST_TOKEN
  try {
    const cases = [
      [`Authorization: Bearer ${TEST_TOKEN}`, 'Bearer ***'],
      ['key = sk-abcdef1234567890', 'sk-***'],
      ['{"api_key":"abcdef123456"}', '"api_key":"***'],
      [`token from env: ${TEST_TOKEN}`, 'token from env: ***']
    ]
    for (const [input, expectedFragment] of cases) {
      const redacted = redactSecrets(input)
      assert.equal(redacted.includes(expectedFragment), true, `input=${input} redacted=${redacted}`)
      assert.equal(redacted.includes(TEST_TOKEN), false, `input=${input}`)
    }
    // 非字符串输入（对象）也可脱敏
    const obj = redactSecrets({ detail: `Bearer ${TEST_TOKEN}` })
    assert.equal(obj.includes(TEST_TOKEN), false)
    // 普通文本不受影响
    assert.equal(redactSecrets('agent_not_found'), 'agent_not_found')
  } finally {
    if (savedEnv === undefined) delete process.env.CONTROL_API_TOKEN
    else process.env.CONTROL_API_TOKEN = savedEnv
  }
})

// ---------------------------------------------------------------------------
// 集成：createApp 全装配（中间件 + onError 脱敏）
// ---------------------------------------------------------------------------

test('createApp 集成：默认 localhost 模式下 onError 响应与日志脱敏', async () => {
  const { createApp } = await import('../../apps/control-server/src/app/createApp.js')
  const savedMode = process.env.CONTROL_API_ACCESS_MODE
  const savedToken = process.env.CONTROL_API_TOKEN
  process.env.CONTROL_API_ACCESS_MODE = 'token'
  process.env.CONTROL_API_TOKEN = TEST_TOKEN
  try {
    const app = createApp()
    app.post('/api/control/boom', () => { throw new Error(`provider error: Bearer ${TEST_TOKEN}`) })
    // 本机（in-process 无连接信息时按非本机处理）：先验证无凭证被拒绝
    const denied = await post(app, '/api/control/boom')
    assert.equal(denied.status, 403)
    // 合法凭证进入路由，抛错后 onError 返回 500 且 detail 已脱敏
    const res = await post(app, '/api/control/boom', { authorization: `Bearer ${TEST_TOKEN}` })
    assert.equal(res.status, 500)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.error, 'internal_error')
    assert.equal(JSON.stringify(body).includes(TEST_TOKEN), false)
  } finally {
    if (savedMode === undefined) delete process.env.CONTROL_API_ACCESS_MODE
    else process.env.CONTROL_API_ACCESS_MODE = savedMode
    if (savedToken === undefined) delete process.env.CONTROL_API_TOKEN
    else process.env.CONTROL_API_TOKEN = savedToken
  }
})
