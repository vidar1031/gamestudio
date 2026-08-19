import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'

import { GAMESTUDIO_ROOT, STORAGE_PROJECTS_ROOT } from '../../config/paths.js'
import { assertStoryOutput } from './storyOutputGate.js'

export const GAMESTUDIO_SERVER_BASE_URL = String(process.env.GAMESTUDIO_SERVER_BASE_URL || process.env.SERVER_BASE_URL || 'http://127.0.0.1:1999').replace(/\/$/, '')

const DEFAULT_TIMEOUT_MS = Math.max(1000, Number(process.env.GAMESTUDIO_SERVER_CLIENT_TIMEOUT_MS || 120000))

function normalizeProjectId(value) {
  return String(value || '').trim()
}

function toWorkspaceRelativePath(targetPath) {
  const absolutePath = path.resolve(targetPath)
  return absolutePath.startsWith(GAMESTUDIO_ROOT)
    ? path.relative(GAMESTUDIO_ROOT, absolutePath).replace(/\\/g, '/')
    : absolutePath
}

function readProjectFiles(projectId) {
  const dir = path.join(STORAGE_PROJECTS_ROOT, projectId)
  if (!projectId || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function buildProjectEvidence(projectId, extra = {}) {
  const normalizedProjectId = normalizeProjectId(projectId)
  const projectDir = normalizedProjectId ? path.join(STORAGE_PROJECTS_ROOT, normalizedProjectId) : ''
  const files = normalizedProjectId ? readProjectFiles(normalizedProjectId) : []
  const buildId = String(extra.buildId || '').trim()
  const distPath = normalizedProjectId && buildId
    ? path.join(STORAGE_PROJECTS_ROOT, normalizedProjectId, 'builds', buildId, 'dist', 'index.html')
    : ''
  const distStat = distPath && fs.existsSync(distPath) && fs.statSync(distPath).isFile()
    ? fs.statSync(distPath)
    : null
  return {
    projectId: normalizedProjectId,
    projectDir,
    projectDirRelative: projectDir ? toWorkspaceRelativePath(projectDir) : '',
    projectDirExists: Boolean(projectDir && fs.existsSync(projectDir) && fs.statSync(projectDir).isDirectory()),
    files,
    fileNames: files.map((entry) => entry.name),
    buildId: buildId || null,
    distUrl: extra.distUrl || null,
    distPath: distPath || null,
    distPathRelative: distPath ? toWorkspaceRelativePath(distPath) : '',
    distExists: Boolean(distStat),
    distMtime: distStat ? distStat.mtime.toISOString() : null,
    exportedAt: extra.exportedAt || (distStat ? distStat.mtime.toISOString() : null)
  }
}

function classifyRetryable(status, error) {
  if (!status) return true
  if (status === 408 || status === 429) return true
  if (status >= 500) return true
  return /timeout|ECONN|fetch failed|network/i.test(String(error || ''))
}

async function requestGameStudio(pathname, options = {}) {
  const method = String(options.method || 'GET').toUpperCase()
  const endpoint = `${method} ${pathname}`
  const url = `${GAMESTUDIO_SERVER_BASE_URL}${pathname}`
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS))
  try {
    // 使用 node:http 而非全局 fetch：长生成请求（如 Story Bible 需 8 分钟以上）
    // 会被 undici 内置 headersTimeout（约 300s）提前掐断，且不受 AbortController 控制。
    const { status, text } = await new Promise((resolve, reject) => {
      const target = new URL(url)
      const client = target.protocol === 'https:' ? https : http
      const body = options.body === undefined ? undefined : JSON.stringify(options.body)
      const req = client.request({
        method,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: {
          'Content-Type': 'application/json',
          // Control 驱动的调用已走 control 侧步骤级人工审核，GameStudio 图片审核门禁默认旁路，避免双重审核卡死自动化
          'x-image-review-mode': 'off',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
          ...(options.headers || {})
        },
        timeout: timeoutMs
      }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      })
      req.on('timeout', () => req.destroy(new Error(`gamestudio_request_timeout_${timeoutMs}ms`)))
      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    })
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { raw: text }
    }
    const apiSuccess = data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'success')
      ? data.success !== false
      : status >= 200 && status < 300
    if (!(status >= 200 && status < 300) || !apiSuccess) {
      const error = String(data?.error || `http_${status}` || 'gamestudio_server_request_failed')
      return {
        ok: false,
        status,
        endpoint,
        url,
        error,
        message: String(data?.message || error),
        data,
        retryable: classifyRetryable(status, error)
      }
    }
    return { ok: true, status, endpoint, url, data }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      status: 0,
      endpoint,
      url,
      error: detail,
      message: detail,
      data: null,
      retryable: true
    }
  }
}

function withProjectEvidence(result, projectId, extra = {}) {
  const resolvedProjectId = normalizeProjectId(projectId || result?.data?.project?.id || result?.data?.projectId)
  return {
    ...result,
    evidence: buildProjectEvidence(resolvedProjectId, extra)
  }
}

export async function listProjects() {
  const result = await requestGameStudio('/api/projects')
  return result
}

export async function getHealth() {
  return requestGameStudio('/api/health', { timeoutMs: 5000 })
}

export async function getStudioSettings() {
  return requestGameStudio('/api/studio/settings')
}

export async function updateStudioSettings(settings) {
  return requestGameStudio('/api/studio/settings', { method: 'PUT', body: { settings } })
}

export async function diagnoseStudio(payload = {}) {
  return requestGameStudio('/api/studio/diagnose', {
    method: 'POST',
    body: payload || {},
    timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, Number(payload?.timeoutMs || 0) || 0)
  })
}

export async function createProject({ title }) {
  assertStoryOutput('story.project.create', { title })
  const result = await requestGameStudio('/api/projects', { method: 'POST', body: { title } })
  return withProjectEvidence(result, result?.data?.project?.id)
}

export async function createAiProject(payload) {
  assertStoryOutput('story.project.create', payload || {})
  const result = await requestGameStudio('/api/projects/ai/create', {
    method: 'POST',
    body: payload || {},
    timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, Number(payload?.timeoutMs || 0) || 0)
  })
  return withProjectEvidence(result, result?.data?.project?.id)
}

export async function getProject(projectId) {
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}`)
  return withProjectEvidence(result, projectId)
}

export async function updateProject(projectId, payload) {
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}`, { method: 'PUT', body: payload })
  return withProjectEvidence(result, projectId)
}

export async function getScripts(projectId) {
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/scripts`)
  return withProjectEvidence(result, projectId)
}

export async function putScripts(projectId, scripts) {
  assertStoryOutput('story.scripts.write', { projectId, scripts })
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/scripts`, { method: 'PUT', body: { scripts } })
  return withProjectEvidence(result, projectId)
}

export async function compileBlueprint(projectId) {
  assertStoryOutput('story.blueprint.compile', { projectId })
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/compile/blueprint`, { method: 'POST', body: {} })
  return withProjectEvidence(result, projectId)
}

export async function analyzeScripts(projectId) {
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/analyze/scripts`, { method: 'POST', body: {} })
  return withProjectEvidence(result, projectId)
}

export async function reviewBlueprint(projectId, payload = {}) {
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/ai/review/blueprint`, { method: 'POST', body: payload || {}, timeoutMs: DEFAULT_TIMEOUT_MS })
  return withProjectEvidence(result, projectId)
}

export async function fixScripts(projectId) {
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/ai/fix/scripts`, { method: 'POST', body: {}, timeoutMs: DEFAULT_TIMEOUT_MS })
  return withProjectEvidence(result, projectId)
}

export async function compileCompose(projectId) {
  assertStoryOutput('story.compose.compile', { projectId })
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/compile/compose`, { method: 'POST', body: {} })
  return withProjectEvidence(result, projectId)
}

export async function validateBlueprint(projectId) {
  assertStoryOutput('story.validate.blueprint', { projectId })
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/validate/blueprint`, { method: 'POST', body: {} })
  return withProjectEvidence(result, projectId)
}

export async function exportProject(projectId) {
  assertStoryOutput('story.export.project', { projectId })
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/export`, { method: 'POST', body: {} })
  return withProjectEvidence(result, projectId, {
    buildId: result?.data?.buildId || 'latest',
    distUrl: result?.data?.distUrl || null,
    exportedAt: result?.data?.exportedAt || result?.data?.createdAt || null
  })
}

export async function listExports(projectId) {
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/exports`)
  return withProjectEvidence(result, projectId)
}

export async function getAiStatus() {
  const result = await requestGameStudio('/api/ai/status')
  // 适配契约：服务端返回 data.ai = { provider, openai, localoxml, proxy, diagnostics }
  // control-server 期望 data.ai.effective.enabled.image 来判断资产生成可用性
  if (result.ok && result.data?.ai && typeof result.data.ai === 'object') {
    const snap = result.data.ai
    if (!snap.effective || typeof snap.effective !== 'object') {
      const provider = String(snap.provider || 'local').toLowerCase()
      const hasTextProvider = provider === 'local' || provider === 'localoxml' || provider === 'openai' || provider === 'ollama' || provider === 'doubao'
      const hasImageProvider = provider === 'local' || provider === 'localoxml' || provider === 'openai' || provider === 'doubao'
      snap.effective = {
        enabled: {
          scripts: hasTextProvider,
          prompt: hasTextProvider,
          image: hasImageProvider,
          tts: false
        }
      }
    }
  }
  return result
}

export async function preflightImageProvider(payload = {}) {
  return requestGameStudio('/api/studio/image/preflight', {
    method: 'POST',
    body: payload || {},
    timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, Number(payload?.timeoutMs || 0) || 0)
  })
}

export async function generateBackground(projectId, payload) {
  assertStoryOutput('story.background.generate', { projectId, ...payload })
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/ai/background`, {
    method: 'POST',
    body: payload,
    timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, Number(payload?.timeoutMs || 0) || 0)
  })
  return withProjectEvidence(result, projectId)
}

export async function createStoryBible(projectId, payload) {
  assertStoryOutput('story.bible.generate', { projectId, ...payload })
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/ai/story/bible`, {
    method: 'POST',
    body: payload || {},
    timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, Number(payload?.timeoutMs || 0) || 0)
  })
  return withProjectEvidence(result, projectId)
}

export async function regenerateScripts(projectId, payload) {
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/ai/regenerate`, {
    method: 'POST',
    body: payload || {},
    timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, Number(payload?.timeoutMs || 0) || 0)
  })
  return withProjectEvidence(result, projectId)
}

export async function createStoryAssetPlan(projectId, payload) {
  assertStoryOutput('story.assets.plan', { projectId, ...payload })
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/ai/story/assets/plan`, { method: 'POST', body: payload || {} })
  return withProjectEvidence(result, projectId)
}

export async function storyLockTest(projectId, payload) {
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/ai/story/lock/test`, {
    method: 'POST',
    body: payload || {},
    timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, Number(payload?.timeoutMs || 0) || 0)
  })
  return withProjectEvidence(result, projectId)
}

export async function generateStoryAssetReference(projectId, payload) {
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/ai/story/assets/reference`, {
    method: 'POST',
    body: payload || {},
    timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, Number(payload?.timeoutMs || 0) || 0)
  })
  return withProjectEvidence(result, projectId)
}

export async function selectStoryAssetReference(projectId, payload) {
  assertStoryOutput('story.assets.reference.lock', { projectId, ...payload })
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/ai/story/assets/reference/select`, {
    method: 'POST',
    body: payload || {},
    timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, Number(payload?.timeoutMs || 0) || 0)
  })
  return withProjectEvidence(result, projectId)
}

export async function renderStoryScene(projectId, sceneId, payload = {}) {
  assertStoryOutput('story.scene.render', { projectId, sceneId, ...payload })
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const scene = encodeURIComponent(String(sceneId || '').trim())
  const result = await requestGameStudio(`/api/projects/${id}/ai/story/scenes/${scene}/render`, {
    method: 'POST',
    body: payload || {},
    timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, Number(payload?.timeoutMs || 0) || 0)
  })
  return withProjectEvidence(result, projectId)
}

// 分层合成（AUTO-E04）：E03 批量队列提交背景-only 渲染；异步返回 batchId，进度经 getStorySceneBatch 轮询
export async function renderStorySceneBackgroundsBatch(projectId, payload = {}) {
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/ai/story/scenes/batch`, {
    method: 'POST',
    body: { mode: 'background', ...(payload || {}) },
    timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, Number(payload?.timeoutMs || 0) || 0)
  })
  return withProjectEvidence(result, projectId)
}

export async function getStorySceneBatch(projectId) {
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/ai/story/scenes/batch`, { timeoutMs: 15000 })
  return withProjectEvidence(result, projectId)
}

export async function generateStoryScenePlacements(projectId, payload = {}) {
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/ai/story/scenes/placements`, {
    method: 'POST',
    body: payload || {},
    timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, Number(payload?.timeoutMs || 0) || 0)
  })
  return withProjectEvidence(result, projectId)
}

export async function generateAssetLineart(projectId, assetId, payload = {}) {
  const id = encodeURIComponent(normalizeProjectId(projectId))
  const result = await requestGameStudio(`/api/projects/${id}/ai/story/assets/lineart`, {
    method: 'POST',
    body: { ...(payload || {}), assetId },
    timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, Number(payload?.timeoutMs || 0) || 0)
  })
  return withProjectEvidence(result, projectId)
}

export const gameStudioServerClient = {
  baseUrl: GAMESTUDIO_SERVER_BASE_URL,
  getHealth,
  getStudioSettings,
  updateStudioSettings,
  diagnoseStudio,
  listProjects,
  createProject,
  createAiProject,
  getProject,
  updateProject,
  getScripts,
  putScripts,
  compileBlueprint,
  analyzeScripts,
  reviewBlueprint,
  fixScripts,
  compileCompose,
  validateBlueprint,
  exportProject,
  listExports,
  getAiStatus,
  preflightImageProvider,
  generateBackground,
  createStoryBible,
  regenerateScripts,
  createStoryAssetPlan,
  storyLockTest,
  generateStoryAssetReference,
  selectStoryAssetReference,
  renderStoryScene,
  renderStorySceneBackgroundsBatch,
  getStorySceneBatch,
  generateStoryScenePlacements,
  generateAssetLineart
}