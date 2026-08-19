import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Hono } from 'hono'

import {
  getProjectBinding,
  setProjectBinding,
  normalizeBindingBaseUrl,
  probeProjectBinding
} from '../../apps/control-server/src/server/services/projectBindingService.js'
import { readGameStudioEventRuns } from '../../apps/control-server/src/server/events/eventRunsReader.js'
import { registerEventsRoutes } from '../../apps/control-server/src/server/routes/eventsRoutes.js'
import { registerProjectBindingRoutes } from '../../apps/control-server/src/server/routes/projectBindingRoutes.js'
import { isHighRiskApiRequest } from '../../apps/control-server/src/server/security/apiAccessBoundary.js'

// 项目绑定 + 项目事件端点测试。
// 覆盖：绑定读写/默认回落/解绑、非法 baseUrl 拒绝、registry 不可达降级（不 500）、
// registry 透传成功路径、事件执行历史过滤、PUT 写动作的治理审计与 D02 边界归类。
// 全程使用 env 覆盖指向临时目录，不触碰真实 state。

const ENV_KEYS = ['HERMES_PROJECT_BINDING_FILE', 'HERMES_EVENT_RUNS_FILE', 'HERMES_GOVERNANCE_AUDIT_FILE']

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'binding-events-test-'))
}

function useTempEnv(dir) {
  process.env.HERMES_PROJECT_BINDING_FILE = path.join(dir, 'project-binding.json')
  process.env.HERMES_EVENT_RUNS_FILE = path.join(dir, 'events.jsonl')
  process.env.HERMES_GOVERNANCE_AUDIT_FILE = path.join(dir, 'governance-audit.jsonl')
}

function cleanupEnv() {
  for (const key of ENV_KEYS) delete process.env[key]
}

function makeApp() {
  const app = new Hono()
  registerEventsRoutes(app)
  registerProjectBindingRoutes(app)
  return app
}

function readAuditLines(dir) {
  const file = path.join(dir, 'governance-audit.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

// 启动一个临时本机 HTTP 服务充当绑定项目（GameStudio 上游）
async function startFakeGameStudio(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

// ---------------------------------------------------------------------------
// baseUrl 校验
// ---------------------------------------------------------------------------

test('normalizeBindingBaseUrl：本机 http(s) 地址归一化通过', () => {
  assert.deepEqual(normalizeBindingBaseUrl('http://127.0.0.1:1999'), { ok: true, baseUrl: 'http://127.0.0.1:1999' })
  assert.deepEqual(normalizeBindingBaseUrl('http://localhost:1999/'), { ok: true, baseUrl: 'http://localhost:1999' })
  assert.deepEqual(normalizeBindingBaseUrl('http://[::1]:1999'), { ok: true, baseUrl: 'http://[::1]:1999' })
  assert.deepEqual(normalizeBindingBaseUrl(' https://127.0.0.1:8443/path '), { ok: true, baseUrl: 'https://127.0.0.1:8443' })
})

test('normalizeBindingBaseUrl：外部地址/非 http 协议/非法输入一律拒绝', () => {
  assert.equal(normalizeBindingBaseUrl('http://192.168.1.10:1999').error, 'base_url_not_local')
  assert.equal(normalizeBindingBaseUrl('http://example.com').error, 'base_url_not_local')
  assert.equal(normalizeBindingBaseUrl('ftp://127.0.0.1:1999').error, 'invalid_base_url_protocol')
  assert.equal(normalizeBindingBaseUrl('not-a-url').error, 'invalid_base_url')
  assert.equal(normalizeBindingBaseUrl('').error, 'missing_base_url')
})

// ---------------------------------------------------------------------------
// 绑定配置读写
// ---------------------------------------------------------------------------

test('绑定读写 roundtrip：默认回落 -> 写入 -> 文件源读取 -> 解绑', () => {
  const dir = makeTempDir()
  useTempEnv(dir)
  try {
    // 无绑定文件时回落默认绑定（GameStudio 交互故事）
    const fallback = getProjectBinding()
    assert.equal(fallback.bound, true)
    assert.equal(fallback.source, 'default')
    assert.equal(fallback.label, 'GameStudio 交互故事')
    assert.match(fallback.baseUrl, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)

    // 写入绑定
    const saved = setProjectBinding({ label: '测试项目', baseUrl: 'http://127.0.0.1:2999/' })
    assert.equal(saved.bound, true)
    assert.equal(saved.label, '测试项目')
    assert.equal(saved.baseUrl, 'http://127.0.0.1:2999')
    assert.ok(saved.updatedAt)

    // 重新读取命中文件源
    const loaded = getProjectBinding()
    assert.equal(loaded.source, 'file')
    assert.equal(loaded.baseUrl, 'http://127.0.0.1:2999')
    assert.equal(loaded.label, '测试项目')

    // label 缺省时填充默认
    const withDefaultLabel = setProjectBinding({ baseUrl: 'http://127.0.0.1:3999' })
    assert.equal(withDefaultLabel.label, 'GameStudio 交互故事')

    // 解绑
    const unbound = setProjectBinding({ bound: false })
    assert.equal(unbound.bound, false)
    assert.equal(getProjectBinding().bound, false)
  } finally {
    cleanupEnv()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('绑定文件损坏时回落默认绑定，不抛出', () => {
  const dir = makeTempDir()
  useTempEnv(dir)
  try {
    fs.writeFileSync(process.env.HERMES_PROJECT_BINDING_FILE, '{broken json', 'utf8')
    const binding = getProjectBinding()
    assert.equal(binding.source, 'default')
    assert.equal(binding.bound, true)
  } finally {
    cleanupEnv()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('setProjectBinding：非法 baseUrl 抛出带 code 的错误', () => {
  const dir = makeTempDir()
  useTempEnv(dir)
  try {
    assert.throws(() => setProjectBinding({ baseUrl: 'http://example.com' }), /base_url_not_local/)
    assert.throws(() => setProjectBinding({ baseUrl: '' }), /missing_base_url/)
  } finally {
    cleanupEnv()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 绑定路由：GET 探测 + PUT 校验与审计
// ---------------------------------------------------------------------------

test('PUT /api/control/project-binding：非法 baseUrl 返回 400 且写 blocked 审计', async () => {
  const dir = makeTempDir()
  useTempEnv(dir)
  try {
    const app = makeApp()
    const res = await app.request('/api/control/project-binding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://evil.example.com' })
    })
    assert.equal(res.status, 400)
    const payload = await res.json()
    assert.equal(payload.ok, false)
    assert.equal(payload.error, 'base_url_not_local')

    const audit = readAuditLines(dir)
    assert.equal(audit.length, 1)
    assert.equal(audit[0].action, 'project_binding_update')
    assert.equal(audit[0].result, 'blocked')
  } finally {
    cleanupEnv()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('PUT /api/control/project-binding：合法绑定返回 200 且写 ok 审计；GET 返回绑定与探测', async () => {
  const dir = makeTempDir()
  useTempEnv(dir)
  const { server, baseUrl } = await startFakeGameStudio((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  try {
    const app = makeApp()
    const putRes = await app.request('/api/control/project-binding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '本机故事服务', baseUrl })
    })
    assert.equal(putRes.status, 200)
    const putPayload = await putRes.json()
    assert.equal(putPayload.ok, true)
    assert.equal(putPayload.binding.baseUrl, baseUrl)

    const audit = readAuditLines(dir)
    assert.equal(audit.length, 1)
    assert.equal(audit[0].action, 'project_binding_update')
    assert.equal(audit[0].result, 'ok')

    const getRes = await app.request('/api/control/project-binding')
    const getPayload = await getRes.json()
    assert.equal(getPayload.ok, true)
    assert.equal(getPayload.binding.label, '本机故事服务')
    assert.equal(getPayload.probe.reachable, true)
  } finally {
    server.close()
    cleanupEnv()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('PUT /api/control/project-binding 是 /api/ 下写动作，被 D02 高风险边界自动覆盖', () => {
  assert.equal(isHighRiskApiRequest('PUT', '/api/control/project-binding'), true)
  assert.equal(isHighRiskApiRequest('GET', '/api/control/project-binding'), false)
})

// ---------------------------------------------------------------------------
// 事件注册表端点：绑定联动与降级
// ---------------------------------------------------------------------------

test('GET /api/control/events/registry：未绑定时返回明确不可用（project_not_bound），不 500', async () => {
  const dir = makeTempDir()
  useTempEnv(dir)
  try {
    setProjectBinding({ bound: false })
    const app = makeApp()
    const res = await app.request('/api/control/events/registry')
    assert.equal(res.status, 200)
    const payload = await res.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.available, false)
    assert.equal(payload.reason, 'project_not_bound')
    assert.equal(payload.binding.bound, false)
  } finally {
    cleanupEnv()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('GET /api/control/events/registry：绑定项目不可达时降级为 registry_unreachable，不 500', async () => {
  const dir = makeTempDir()
  useTempEnv(dir)
  try {
    // 绑定到一个保证不可达的本机关闭端口
    setProjectBinding({ baseUrl: 'http://127.0.0.1:9' })
    const app = makeApp()
    const res = await app.request('/api/control/events/registry')
    assert.equal(res.status, 200)
    const payload = await res.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.available, false)
    assert.equal(payload.reason, 'registry_unreachable')
    assert.match(payload.error, /gamestudio_registry_unreachable/)
    assert.equal(payload.binding.baseUrl, 'http://127.0.0.1:9')
  } finally {
    cleanupEnv()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('GET /api/control/events/registry：从绑定项目 baseUrl 拉取并透传注册表', async () => {
  const dir = makeTempDir()
  useTempEnv(dir)
  const registry = {
    registryVersion: '1.0.0',
    categories: [{ id: 'project', title: '项目生命周期' }],
    events: [{ code: 'GS-01', eventId: 'project.list', kind: 'query', title: '列出项目', category: 'project' }]
  }
  const { server, baseUrl } = await startFakeGameStudio((req, res) => {
    if (req.url === '/api/events/registry') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, registry }))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  try {
    setProjectBinding({ baseUrl })
    const app = makeApp()
    const res = await app.request('/api/control/events/registry')
    assert.equal(res.status, 200)
    const payload = await res.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.available, true)
    assert.equal(payload.registry.events.length, 1)
    assert.equal(payload.registry.events[0].eventId, 'project.list')
    assert.equal(payload.binding.baseUrl, baseUrl)
    assert.equal(payload.source, `${baseUrl}/api/events/registry`)
  } finally {
    server.close()
    cleanupEnv()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 事件执行历史过滤
// ---------------------------------------------------------------------------

test('readGameStudioEventRuns：按 eventId/code 过滤，倒序返回最近 N 条，损坏行跳过', () => {
  const dir = makeTempDir()
  useTempEnv(dir)
  try {
    const lines = [
      { traceId: 't1', ts: '2026-08-19T01:00:00Z', eventId: 'project.list', code: 'GS-01', ok: true, durationMs: 5 },
      'not-json-line',
      { traceId: 't2', ts: '2026-08-19T02:00:00Z', eventId: 'project.create', code: 'GS-02', ok: true, durationMs: 9 },
      { traceId: 't3', ts: '2026-08-19T03:00:00Z', eventId: 'project.list', code: 'GS-01', ok: false, error: 'http_500' }
    ]
    fs.writeFileSync(process.env.HERMES_EVENT_RUNS_FILE, `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`, 'utf8')

    // 按 eventId 过滤：倒序（新的在前）
    const byEventId = readGameStudioEventRuns({ eventRef: 'project.list', limit: 10 })
    assert.deepEqual(byEventId.map((r) => r.traceId), ['t3', 't1'])

    // 按 code 过滤
    const byCode = readGameStudioEventRuns({ eventRef: 'GS-02', limit: 10 })
    assert.deepEqual(byCode.map((r) => r.traceId), ['t2'])

    // limit 生效
    const limited = readGameStudioEventRuns({ eventRef: 'project.list', limit: 1 })
    assert.deepEqual(limited.map((r) => r.traceId), ['t3'])

    // 无过滤返回全部（损坏行跳过）
    const all = readGameStudioEventRuns({ limit: 10 })
    assert.equal(all.length, 3)
  } finally {
    cleanupEnv()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('GET /api/control/events/runs：路由层过滤与空态', async () => {
  const dir = makeTempDir()
  useTempEnv(dir)
  try {
    const app = makeApp()
    // 空文件 → 空列表而非错误
    const emptyRes = await app.request('/api/control/events/runs?event=project.list')
    assert.equal(emptyRes.status, 200)
    assert.deepEqual((await emptyRes.json()).runs, [])

    fs.writeFileSync(process.env.HERMES_EVENT_RUNS_FILE, `${JSON.stringify({ traceId: 't1', ts: '2026-08-19T01:00:00Z', eventId: 'project.list', code: 'GS-01', ok: true })}\n`, 'utf8')
    const res = await app.request('/api/control/events/runs?event=gs-01&limit=5')
    const payload = await res.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.runs.length, 1)
    assert.equal(payload.runs[0].traceId, 't1')
  } finally {
    cleanupEnv()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('probeProjectBinding：可达与不可达语义', async () => {
  const { server, baseUrl } = await startFakeGameStudio((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
  try {
    const reachable = await probeProjectBinding(baseUrl)
    assert.equal(reachable.reachable, true)
    const unreachable = await probeProjectBinding('http://127.0.0.1:9')
    assert.equal(unreachable.reachable, false)
  } finally {
    server.close()
  }
})
