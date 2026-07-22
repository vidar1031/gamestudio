#!/usr/bin/env node
/**
 * GameStudio 四阶段联调测试仪表盘 - 后端服务
 * 端口: 20990 (避免与现有服务冲突)
 * 功能:
 *   - 静态文件服务 (index.html)
 *   - /api/health - 直接服务健康检查
 *   - /api/run-stage/:stageId - SSE 流式执行测试
 *   - /api/stop - 停止当前测试运行
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../..')

const PORT = Number(process.env.TEST_DASHBOARD_PORT || 20990)
const CONTROL_BASE_URL = process.env.CONTROL_BASE_URL || 'http://127.0.0.1:2099'
const CONTROL_CONSOLE_URL = process.env.CONTROL_CONSOLE_URL || 'http://127.0.0.1:8870'
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || 'http://127.0.0.1:1999'
const EDITOR_BASE_URL = process.env.EDITOR_BASE_URL || 'http://127.0.0.1:8868'
const HERMES_BASE_URL = process.env.HERMES_BASE_URL || 'http://127.0.0.1:8742'
const OMLX_BASE_URL = process.env.OMLX_BASE_URL || 'http://127.0.0.1:18888'
const COMFYUI_BASE_URL = process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188'
const AGENT_ID = 'hermes-manager'

let currentRun = null

// ==================== HTTP Server ====================

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // Static files
  if (url.pathname === '/' || url.pathname === '/index.html') {
    serveFile(res, path.join(__dirname, 'index.html'), 'text/html')
    return
  }
  if (url.pathname === '/style.css') {
    serveFile(res, path.join(__dirname, 'style.css'), 'text/css')
    return
  }

  // API: health
  if (url.pathname === '/api/health' && req.method === 'GET') {
    handleHealthCheck(req, res)
    return
  }

  // API: run stage (SSE)
  const runMatch = url.pathname.match(/^\/api\/run-stage\/([a-z0-9]+)$/)
  if (runMatch && req.method === 'GET') {
    handleRunStage(req, res, runMatch[1])
    return
  }

  // API: stop
  if (url.pathname === '/api/stop' && req.method === 'POST') {
    handleStop(req, res)
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Another test dashboard instance may be running.`)
    process.exit(1)
  }
  throw err
})

server.listen(PORT, () => {
  console.log(`Test Dashboard running at http://127.0.0.1:${PORT}`)
})

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    res.writeHead(200, { 'Content-Type': contentType })
    res.end(data)
  })
}

// ==================== SSE Helpers ====================

function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function setupSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  })
}

// ==================== Health Check ====================

async function handleHealthCheck(req, res) {
  const checks = [
    { id: 'S0-T01', name: 'OMLX 健康检查', fn: checkOmlxHealth },
    { id: 'S0-T02', name: 'GameStudio Server 健康检查', fn: checkGameStudioHealth },
    { id: 'S0-T03', name: 'Control Server 健康检查', fn: checkControlHealth },
    { id: 'S0-T04', name: 'Control Console 可访问', fn: checkControlConsole },
    { id: 'S0-T05', name: 'Hermes Gateway API 就绪', fn: checkHermesGateway },
    { id: 'S0-T06', name: 'ComfyUI system_stats 可达', fn: checkComfyUI },
    { id: 'S0-T07', name: 'GameStudio Editor 可访问', fn: checkEditorHealth },
    { id: 'S0-T08', name: 'OMLX 模型列表非空', fn: checkOmlxModels },
    { id: 'S0-T09', name: '记忆文件权威性检查', fn: checkMemoryFiles },
    { id: 'S0-T10', name: 'Studio Settings 图片配置', fn: checkStudioSettings },
  ]
  const results = []
  for (const test of checks) {
    try {
      const result = await test.fn()
      results.push({ id: test.id, name: test.name, result: result.ok ? 'PASS' : 'FAIL', detail: result.detail })
    } catch (error) {
      results.push({ id: test.id, name: test.name, result: 'FAIL', detail: error.message })
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: results.every(r => r.result === 'PASS'), checks: results }))
}

// ==================== Run Stage ====================

async function handleRunStage(req, res, stageId) {
  if (currentRun) {
    res.writeHead(409, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Another test run is in progress' }))
    return
  }

  setupSSE(res)
  currentRun = { stageId, abort: false, res }

  sendSSE(res, 'start', { stageId, timestamp: new Date().toISOString() })

  try {
    if (stageId === 's0') {
      await runS0Stage(res)
    } else if (stageId === 'l1') {
      await runScriptStage(res, 'l1')
    } else if (stageId === 'l4') {
      await runScriptStage(res, 'l4')
    } else if (stageId === 'p1') {
      await runP1Stage(res)
    } else if (stageId === 'all') {
      await runAllStages(res)
    } else {
      sendSSE(res, 'error', { message: `Unknown stage: ${stageId}` })
    }
  } catch (error) {
    sendSSE(res, 'error', { message: error.message })
  }

  sendSSE(res, 'complete', { stageId, timestamp: new Date().toISOString() })
  currentRun = null
  res.end()
}

function handleStop(req, res) {
  if (currentRun) {
    currentRun.abort = true
    sendSSE(currentRun.res, 'stopped', { message: 'Test run stopped by user' })
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
}

// ==================== S0: Direct API Checks ====================

async function runS0Stage(res) {
  const tests = [
    { id: 'S0-T01', name: 'OMLX 健康检查', fn: checkOmlxHealth },
    { id: 'S0-T02', name: 'GameStudio Server 健康检查', fn: checkGameStudioHealth },
    { id: 'S0-T03', name: 'Control Server 健康检查', fn: checkControlHealth },
    { id: 'S0-T04', name: 'Control Console 可访问', fn: checkControlConsole },
    { id: 'S0-T05', name: 'Hermes Gateway API 就绪', fn: checkHermesGateway },
    { id: 'S0-T06', name: 'ComfyUI system_stats 可达', fn: checkComfyUI },
    { id: 'S0-T07', name: 'GameStudio Editor 可访问', fn: checkEditorHealth },
    { id: 'S0-T08', name: 'OMLX 模型列表非空', fn: checkOmlxModels },
    { id: 'S0-T09', name: '记忆文件权威性检查', fn: checkMemoryFiles },
    { id: 'S0-T10', name: 'Studio Settings 图片配置', fn: checkStudioSettings },
  ]

  for (const test of tests) {
    if (currentRun?.abort) break

    sendSSE(res, 'case_start', { id: test.id, name: test.name, stage: 's0' })
    const start = Date.now()

    try {
      const result = await test.fn()
      const duration = Date.now() - start
      sendSSE(res, 'case_result', {
        id: test.id,
        name: test.name,
        stage: 's0',
        result: result.ok ? 'PASS' : 'FAIL',
        detail: result.detail,
        duration
      })
    } catch (error) {
      sendSSE(res, 'case_result', {
        id: test.id,
        name: test.name,
        stage: 's0',
        result: 'FAIL',
        detail: error.message,
        duration: Date.now() - start
      })
    }
  }
}

async function checkOmlxHealth() {
  const data = await fetchJson(`${OMLX_BASE_URL}/health`, { timeout: 5000 })
  const ok = data?.status === 'healthy' || data?.ok === true
  return { ok, detail: ok ? `status=${data.status}` : JSON.stringify(data) }
}

async function checkGameStudioHealth() {
  const data = await fetchJson(`${SERVER_BASE_URL}/api/health`, { timeout: 5000 })
  const ok = data?.ok === true
  return { ok, detail: ok ? 'ok=true' : JSON.stringify(data) }
}

async function checkControlHealth() {
  const data = await fetchJson(`${CONTROL_BASE_URL}/api/health`, { timeout: 5000 })
  const ok = data?.ok === true
  return { ok, detail: ok ? `service=${data.service}` : JSON.stringify(data) }
}

async function checkControlConsole() {
  const response = await fetchWithTimeout(CONTROL_CONSOLE_URL, { timeout: 5000 })
  const ok = response.status >= 200 && response.status < 500
  return { ok, detail: `http=${response.status}` }
}

async function checkHermesGateway() {
  const data = await fetchJson(`${HERMES_BASE_URL}/v1/models`, { timeout: 5000 })
  const ok = Array.isArray(data?.data) && data.data.length > 0
  return { ok, detail: ok ? `models=${data.data.length}` : JSON.stringify(data) }
}

async function checkComfyUI() {
  const data = await fetchJson(`${COMFYUI_BASE_URL}/system_stats`, { timeout: 5000 })
  const ok = data?.system?.comfyui_version && Array.isArray(data?.devices)
  return { ok, detail: ok ? `version=${data.system.comfyui_version}, devices=${data.devices.length}` : JSON.stringify(data).slice(0, 200) }
}

async function checkEditorHealth() {
  try {
    const response = await fetchWithTimeout(EDITOR_BASE_URL, { timeout: 8000 })
    const ok = response.status >= 200 && response.status < 500
    return { ok, detail: `http=${response.status}` }
  } catch (err) {
    return { ok: false, detail: `fetch failed: ${err.message}` }
  }
}

async function checkOmlxModels() {
  const apiKey = process.env.LOCALOXML_API_KEY || 'omlx123456'
  const data = await fetchJson(`${OMLX_BASE_URL}/v1/models`, { timeout: 5000, headers: { 'Authorization': `Bearer ${apiKey}` } })
  const ok = Array.isArray(data?.data) && data.data.length > 0
  return { ok, detail: ok ? `models=${data.data.length}` : JSON.stringify(data).slice(0, 200) }
}

async function checkMemoryFiles() {
  const memoryDir = path.join(REPO_ROOT, 'ai', 'memory')
  if (!fs.existsSync(memoryDir)) {
    return { ok: false, detail: 'ai/memory/ directory not found' }
  }
  const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md')).sort()
  const expected = ['DECISIONS.md', 'LONG_TASKS.md', 'STATUS.md', 'TASK_QUEUE.md']
  const ok = expected.every(f => files.includes(f))
  return { ok, detail: `files=[${files.join(', ')}]` }
}

async function checkStudioSettings() {
  const data = await fetchJson(`${SERVER_BASE_URL}/api/studio/settings`, { timeout: 5000 })
  const provider = data?.effective?.image?.provider
  const ok = provider === 'comfyui'
  return { ok, detail: `provider=${provider}` }
}

// ==================== Script-based Stages (L1, L4) ====================

async function runScriptStage(res, stageId) {
  const scriptPath = path.join(REPO_ROOT, 'scripts/test/control_production_test.mjs')
  if (!fs.existsSync(scriptPath)) {
    sendSSE(res, 'error', { message: `Test script not found: ${scriptPath}` })
    return
  }

  const args = [
    scriptPath,
    `--stage=${stageId}`,
    '--use-running-control',
    '--review-via=auto',
    '--stop-on-fail',
    '--json-progress'
  ]

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const buffers = { stdout: '', stderr: '' }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      buffers.stdout += text
      const lines = text.split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        sendSSE(res, 'log', { line, source: 'stdout' })
        parseScriptLine(res, stageId, line)
      }
    })

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      buffers.stderr += text
      const lines = text.split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        sendSSE(res, 'log', { line, source: 'stderr' })
      }
    })

    child.on('exit', (code) => {
      sendSSE(res, 'stage_result', {
        stage: stageId,
        exitCode: code,
        stdout: buffers.stdout.slice(-20000),
        stderr: buffers.stderr.slice(-5000)
      })
      resolve()
    })

    child.on('error', (err) => {
      sendSSE(res, 'error', { message: err.message })
      reject(err)
    })
  })
}

function parseScriptLine(res, stageId, line) {
  // JSON progress markers from --json-progress
  const progressMatch = line.match(/^__JSON_PROGRESS__(.+)/)
  if (progressMatch) {
    try {
      const data = JSON.parse(progressMatch[1])
      if (data.type === 'case_start') {
        sendSSE(res, 'case_start', { id: data.case, name: data.title || data.case, stage: data.stage })
      } else if (data.type === 'case_result') {
        sendSSE(res, 'case_result', {
          id: data.case,
          stage: data.stage,
          result: data.result,
          detail: data.detail
        })
      } else if (data.type === 'stage_result') {
        sendSSE(res, 'stage_status', { stage: data.stage, status: data.status })
      } else if (data.type === 'complete') {
        sendSSE(res, 'stage_result', { stage: stageId, status: data.status === 'completed' ? 'passed' : 'failed' })
      }
    } catch {}
    return
  }

  // Fallback: bootstrap checks PASS/FAIL BOOT-XX
  const bootMatch = line.match(/^(PASS|FAIL)\s+(BOOT-\d+)\s+(.+)/)
  if (bootMatch) {
    sendSSE(res, 'case_result', {
      id: bootMatch[2],
      stage: 's0',
      result: bootMatch[1],
      detail: bootMatch[3]
    })
    return
  }

  // Fallback: auto verdict text
  const verdictMatch = line.match(/(\S+)\s+自动判定:\s*(PASS|FAIL|SOFT PASS|BLOCKED)/)
  if (verdictMatch) {
    sendSSE(res, 'case_result', {
      id: verdictMatch[1],
      stage: stageId,
      result: verdictMatch[2],
      detail: line.trim()
    })
    return
  }

  // Stage completion text
  const stageMatch = line.match(/阶段\s+(.+?)\s+(未达成|通过)/)
  if (stageMatch) {
    sendSSE(res, 'stage_status', {
      stage: stageId,
      status: stageMatch[2] === '通过' ? 'passed' : 'failed'
    })
  }
}

// ==================== P1: Scene Lock (Partial) ====================

async function runP1Stage(res) {
  const tests = [
    { id: 'P1-T01', name: '资产计划创建成功', status: 'not-implemented' },
    { id: 'P1-T02', name: '识别 ref_required 锁定资产', status: 'not-implemented' },
    { id: 'P1-T03', name: 'ComfyUI preflight 通过', status: 'not-implemented' },
    { id: 'P1-T04', name: '锁定测试图生成成功', status: 'not-implemented' },
    { id: 'P1-T05', name: '锁定测试图 AI 评审通过', status: 'not-implemented' },
    { id: 'P1-T06', name: '锁定参考图保存成功', status: 'not-implemented' },
    { id: 'P1-T07', name: '缺少锁定参考时场景渲染被阻断', status: 'not-implemented' },
    { id: 'P1-T08', name: '场景渲染生成场景图', status: 'not-implemented' },
    { id: 'P1-T09', name: '场景图资源回填成功', status: 'not-implemented' },
    { id: 'P1-T10', name: '校验与重新导出成功', status: 'not-implemented' },
  ]

  for (const test of tests) {
    sendSSE(res, 'case_result', {
      id: test.id,
      name: test.name,
      stage: 'p1',
      result: 'NOT_IMPLEMENTED',
      detail: 'P1 测试脚本尚未实现，详见 docs/PRODUCTION_DEFECTS.md 4.6 阻塞项'
    })
  }
}

// ==================== Run All ====================

async function runAllStages(res) {
  const stages = ['s0', 'l1', 'l4', 'p1']
  for (const stageId of stages) {
    if (currentRun?.abort) break
    sendSSE(res, 'phase_start', { stageId })
    if (stageId === 's0') await runS0Stage(res)
    else if (stageId === 'l1') await runScriptStage(res, 'l1')
    else if (stageId === 'l4') await runScriptStage(res, 'l4')
    else if (stageId === 'p1') await runP1Stage(res)
    sendSSE(res, 'phase_end', { stageId })
  }
}

// ==================== Fetch Helpers ====================

async function fetchJson(url, opts = {}) {
  const response = await fetchWithTimeout(url, opts)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
  }
  return text ? JSON.parse(text) : null
}

async function fetchWithTimeout(url, opts = {}) {
  const timeout = opts.timeout || 10000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, { ...opts, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}
