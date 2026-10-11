import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { cors } from 'hono/cors'
import { mkdir, readFile, readdir, rename, stat, writeFile, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pluginStoryPixi from './plugins/storyPixi.js'
import { genId, generateScriptDraft, guessTitleFromPrompt, repairScriptDraft } from './ai/scripts.js'
// 通用小工具（本文件历史代码未集中定义，2026-10-10 姿势编排端点引入）
const asList = (v) => (Array.isArray(v) ? v : [])
const asStr = (v) => String(v == null ? '' : v)
import { getAiStatusSnapshot, runAiDiagnostics } from './ai/diagnostics.js'
import { analyzeScriptsForBlueprint } from './ai/analyze.js'
import { optimizeGeneratedImage, optimizeDirectoryTree, IMAGE_KIND } from './ai/imageOptimize.js'
import { readGlobalRules, writeGlobalRules } from './ai/globalRules.js'
import { generateBackgroundImage, generateComfyuiLineartFromReference, generateComfyuiCutoutFromReference, mapComfySampler, mapComfyScheduler, normalizeComfyCheckpointName, parseComfyTimeoutMs, runComfyuiPromptWorkflow } from './ai/background.js'
import { generateBackgroundPrompt } from './ai/imagePrompt.js'
import { reviewStoryPromptLocally, reviewStoryPromptWithAi } from './ai/promptReview.js'
import { normalizeStoryboardPromptReviewInput, reviewStoryboardPromptLocally, reviewStoryboardPromptWithAi } from './ai/storyboardPromptReview.js'
import { deletePromptTemplate, generateStoryPromptTemplate, listPromptTemplates, savePromptTemplate } from './ai/promptTemplates.js'
import { addPromptLibraryEntry, deletePromptLibraryEntry, listPromptLibraryEntries, updatePromptLibraryEntry } from './ai/promptLibrary.js'
import { enhanceStoryAssetPromptWithAi } from './ai/storyAssetPromptEnhance.js'
import { generateCharacterFingerprint, generateCharacterPosePrompt } from './ai/characterPrompt.js'
import { generateStoryBible } from './ai/storyBible.js'
import { buildPoseStateExtractionInput, extractStoryPoseStates } from './ai/storyPoseStates.js'
import { buildPoseVariantPrompt, generatePoseVariantForGroup, groupPoseRequirements, isAnimalLikeAnchor, loadPoseLibraryManifest } from './ai/storyPoseVariants.js'
import { buildPropStateExtractionInput, extractStoryPropStates } from './ai/storyPropStates.js'
import { buildCompositionInput, extractStoryComposition } from './ai/storyComposition.js'
import { translatePromptText } from './ai/translate.js'
import { buildStoryAssetPlan, buildStoryAssetReferenceNegativePrompt, buildStoryAssetReferencePrompt, buildStorySceneRenderSpec, getStoryAssetRenderProfile, matchSceneRef, normalizeSceneRefs, repairStoryAssetPlanSceneLinks, resolveStoryStylePreset, summarizeStoryAssetPlan } from './ai/storyAssets.js'
import { qcSceneRefsDeterministic, qcStoryBibleSceneRefsWithAi } from './ai/storyBibleQc.js'
import { buildStoryboardLockTestNegativePrompt, buildStoryboardLockTestPrompt, buildStoryboardLockTestWorkflow, pickStoryboardLockTestAsset, reviewStoryboardLockImageWithAi } from './ai/storyLock.js'
import { evaluateStoryAssetReferenceReview, sniffImageMetaFromBytes, verifyStoryAssetReferenceFile } from './ai/storyAssetReferenceGate.js'
import { reviewCharacterPoseConsistencyWithAi, reviewCharacterPoseConsistencyWithLocalVl } from './ai/characterPoseReview.js'
import { reviewSceneBackgroundWithAi, reviewSceneBackgroundWithLocalVl } from './ai/sceneBackgroundReview.js'
import { createAiTask, getAiTask, listAiTasks, loadAiTasksFromDisk, updateAiTask } from './ai/taskProgress.js'
import { checkSceneSuccess, createSceneBatch, findInterruptedSceneBatches, loadSceneBatch, resumeSceneBatch, runSceneBatch } from './ai/sceneBatchQueue.js'
import { COMPLETENESS_TASK_KIND, createNodeVisualReviewer, createPuppeteerBrowserLauncher, loadLatestCompletenessReport, resolveChromeExecutablePath, resolveReviewConfig, runStoryCompletenessCheck } from './ai/storyCompleteness.js'
import { withResourceLease } from './ai/resourceLease.js'
import { checkComfyuiCapability } from './ai/comfyuiCapability.js'
import { attachImageReviewResult, createImageReview, decideImageReview, findPendingReview, getImageReview, listImageReviews } from './review/imageReviewStore.js'
import { getStoryImageCoverage } from './ai/storyCoverage.js'
import { recordCreationEvent, snapshotCreationState } from './creationBuffer.js'
import { getDoubaoImagesConfigSnapshot } from './ai/doubao.js'
import { diagnoseOllamaText } from './ai/ollama.js'
import { classifyAiError, createTraceId, logStage } from './ai/runtime.js'
import { compileBlueprintFromScripts, normalizeScriptCardsForBlueprint } from './blueprint/compile.js'
import { validateBlueprintDoc } from './blueprint/validate.js'
import { loadEnv } from './env.js'
import { diagnoseOpenAI, isOpenAICompatibleProvider, reviewBlueprintViaOpenAI } from './ai/openai.js'
import { reviewBlueprintLocally } from './ai/blueprintReviewLocal.js'
import dns from 'node:dns/promises'
import { getEffectiveStudioConfig, redactEffectiveStudioConfigForClient, redactStudioSettingsForClient, writeStudioSettings } from './studio/settings.js'
import { normalizeProjectDoc } from './studio/projectState.js'
import { getStudioSecret } from './studio/secrets.js'
import { storyInputGate } from './middleware/storyInputGate.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '../../..')

const app = new Hono()

// Load .env/.env.local for local development (do not commit secrets).
const envInfo = loadEnv({ startDirs: [PROJECT_ROOT], maxHops: 1 })
try {
  const provider = String(process.env.STUDIO_AI_PROVIDER || 'local')
  const hasOpenAIKey = Boolean(String(process.env.OPENAI_API_KEY || '').trim())
  const hasLocalOxmlKey = Boolean(String(process.env.LOCALOXML_API_KEY || process.env.STUDIO_AI_API_KEY || process.env.OPENAI_API_KEY || '').trim())
  const model = String(process.env.LOCALOXML_MODEL || process.env.STUDIO_AI_MODEL || process.env.OPENAI_MODEL || '')
  console.log(
    `[gamestudio] env loaded=${envInfo.loaded.length ? envInfo.loaded.join(',') : '(none)'} aiProvider=${provider} localoxmlKey=${hasLocalOxmlKey ? 'set' : 'missing'} openaiKey=${hasOpenAIKey ? 'set' : 'missing'}${model ? ` model=${model}` : ''} aiInit=manual_only`
  )
} catch (_) {}

// Basic request logging (opt-out with STUDIO_SERVER_LOG_REQUESTS=0).
app.use('*', async (c, next) => {
  const enabled = String(process.env.STUDIO_SERVER_LOG_REQUESTS || '1').trim() !== '0'
  if (!enabled) return next()
  const start = Date.now()
  const url = c.req.url
  try {
    await next()
  } finally {
    const ms = Date.now() - start
    let pathname = url
    try {
      pathname = new URL(url).pathname
    } catch (_) {}
    const status = c.res && typeof c.res.status === 'number' ? c.res.status : 0
    console.log(`[${new Date().toISOString()}] ${c.req.method} ${pathname} -> ${status} (${ms}ms)`)
  }
})

// P0：允许本地 editor（8868）跨域调用 server（1999）
app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }))

// AUTO-F01：项目根边界校验——:id 解析结果必须落在 PROJECTS_DIR 内，
// 拒绝路径穿越（../、编码后的 %2e%2e、绝对路径）造成的跨 project / 跨 workspace 读写。
// 与 E01 reference gate 的分工：本中间件守「项目 id 本身」，E01 守「项目内的相对路径参数」。
function isProjectIdWithinRoot(id) {
  const raw = String(id || '').trim()
  if (!raw) return false
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch (_) {
    return false // 非法编码一律拒绝，不猜测
  }
  const resolved = path.resolve(PROJECTS_DIR, decoded)
  return resolved.startsWith(PROJECTS_DIR + path.sep)
}
const projectIdBoundaryGuard = async (c, next) => {
  if (!isProjectIdWithinRoot(c.req.param('id'))) {
    return c.json({ success: false, error: 'invalid_project_id', message: '非法项目 id：越过项目根目录，已拒绝。' }, 400)
  }
  await next()
}
app.use('/api/projects/:id', projectIdBoundaryGuard)
app.use('/api/projects/:id/*', projectIdBoundaryGuard)

// 2026-10-05 构建版本号：服务每次启动生成。前端轮询 /api/health 对比 buildId，
// 不一致即自动刷新——服务端重启/升级后界面无需用户手动强刷。
// 2026-10-06 修订：buildId 追加编辑器 dist 指纹（index.html mtime+size）。此前只反映服务端重启，
// 编辑器重新 build（生产托管模式 dist 由本服务伺服）不触发前端自动刷新，用户标签页一直跑旧 bundle
// （假日出游圣经 400 事件即旧内存 bundle 所致）。
const SERVER_BUILD_ID = `${Date.now().toString(36)}_${process.pid}`
const EDITOR_DIST_INDEX_HTML = path.resolve(__dirname, '..', '..', 'editor', 'dist', 'index.html')
async function editorDistFingerprint() {
  try {
    const st = await stat(EDITOR_DIST_INDEX_HTML)
    return `${Math.round(st.mtimeMs).toString(36)}x${st.size.toString(36)}`
  } catch {
    return 'nodist'
  }
}
app.get('/api/health', async (c) => c.json({ ok: true, service: 'gamestudio_server', buildId: `${SERVER_BUILD_ID}:${await editorDistFingerprint()}` }))
app.get('/favicon.ico', (c) => c.body(null, 204))

// 事件层：暴露 GameStudio 事件注册表（apps/server/events/registry.v1.json）
app.get('/api/events/registry', async (c) => {
  try {
    const registryPath = path.join(__dirname, '..', 'events', 'registry.v1.json')
    const registry = await readJson(registryPath)
    return c.json({ success: true, registry })
  } catch (e) {
    return c.json({ success: false, error: 'registry_not_available', message: e && e.message ? e.message : String(e) }, 500)
  }
})

// 能力发现：暴露 GameStudio 全部生产能力（apps/server/events/capabilities.v1.json）
app.get('/api/capabilities', async (c) => {
  try {
    const capabilitiesPath = path.join(__dirname, '..', 'events', 'capabilities.v1.json')
    const capabilities = await readJson(capabilitiesPath)
    return c.json({ success: true, capabilities })
  } catch (e) {
    return c.json({ success: false, error: 'capabilities_not_available', message: e && e.message ? e.message : String(e) }, 500)
  }
})

// 事件层：运行状态检查（server 是否运行中 + editor 是否可达）
app.get('/api/runtime/status', async (c) => {
  const editorUrl = String(process.env.STUDIO_EDITOR_URL || 'http://localhost:8868').trim()
  const editorOk = await probeHttpOk(editorUrl, 3000)
  return c.json({
    success: true,
    runtime: {
      server: { ok: true, url: 'http://127.0.0.1:1999', service: 'gamestudio_server' },
      editor: { ok: editorOk, url: editorUrl },
      allRunning: editorOk,
      checkedAt: new Date().toISOString()
    }
  })
})

// 事件层：自检配置项（返回各项配置状态清单，不修改任何状态）
app.get('/api/studio/selfcheck', async (c) => {
  const editorUrl = String(process.env.STUDIO_EDITOR_URL || 'http://localhost:8868').trim()
  const checks = []

  checks.push({ key: 'server-health', label: 'Server 健康检查', status: 'ok', detail: 'gamestudio_server 响应正常' })

  const editorOk = await probeHttpOk(editorUrl, 3000)
  checks.push({
    key: 'editor-reachable',
    label: 'Editor 可访问',
    status: editorOk ? 'ok' : 'fail',
    detail: editorOk ? `${editorUrl} 可访问` : `${editorUrl} 不可达`
  })

  const projectsRoot = path.join(ROOT, 'projects')
  let storageOk = false
  let storageDetail = `${projectsRoot} 不存在`
  try {
    await mkdir(projectsRoot, { recursive: true })
    const probeFile = path.join(projectsRoot, `.selfcheck_${Date.now()}.tmp`)
    await writeFile(probeFile, 'ok')
    await rm(probeFile)
    storageOk = true
    storageDetail = `${projectsRoot} 可读写`
  } catch (e) {
    storageDetail = `${projectsRoot} 不可写: ${e && e.message ? e.message : String(e)}`
  }
  checks.push({ key: 'storage-projects', label: '项目存储目录', status: storageOk ? 'ok' : 'fail', detail: storageDetail })

  let effective = null
  try {
    const cfg = await getEffectiveStudioConfig(ROOT)
    effective = cfg?.effective || null
  } catch (_) {}
  checks.push({
    key: 'settings-loaded',
    label: '设置加载',
    status: effective ? 'ok' : 'fail',
    detail: effective ? 'studio settings 已加载' : 'studio settings 加载失败'
  })

  const scriptsProvider = String(effective?.scripts?.provider || '').trim()
  const scriptsOk = Boolean(effective?.enabled?.scripts) && scriptsProvider && scriptsProvider !== 'none'
  checks.push({
    key: 'scripts-provider',
    label: '脚本生成 Provider',
    status: scriptsOk ? 'ok' : 'fail',
    detail: scriptsOk ? `${scriptsProvider} / ${effective?.scripts?.model || '-'}` : '未配置或已禁用'
  })

  const imageProvider = String(effective?.image?.provider || '').trim()
  const imageEnabled = Boolean(effective?.enabled?.image)
  const imageOk = imageEnabled && imageProvider && imageProvider !== 'none'
  checks.push({
    key: 'image-provider',
    label: '图片生成 Provider',
    status: imageOk ? 'ok' : (imageEnabled ? 'warn' : 'fail'),
    detail: imageOk ? `${imageProvider} ${effective?.image?.comfyuiBaseUrl || ''}`.trim() : (imageEnabled ? '已启用但未配置 provider' : '未启用')
  })

  const ok = checks.every((item) => item.status !== 'fail')
  return c.json({ success: true, ok, checks, checkedAt: new Date().toISOString() })
})
app.get('/api/ai/status', async (c) => {
  // Non-sensitive snapshot for debugging effective config + last diagnostics.
  const snap = getAiStatusSnapshot()
  return c.json({ success: true, ai: snap })
})
app.post('/api/ai/diagnose', async (c) => {
  const res = await runAiDiagnostics({ force: true }).catch((e) => ({ ok: false, error: { message: e && e.message ? e.message : String(e) } }))
  return c.json({ success: true, diagnostics: res })
})
app.get('/api/ai/models', async (c) => {
  const q = c.req.query()
  const provider = String(process.env.STUDIO_AI_PROVIDER || 'local').toLowerCase()
  const prefix = String(q.prefix || '').trim()
  const contains = String(q.q || '').trim()
  const limit = Math.max(1, Math.min(5000, Number(q.limit || 500)))

  const diag = await runAiDiagnostics({ force: false }).catch(() => null)
  const ids = diag && diag.ok && diag.models && Array.isArray(diag.models.ids) ? diag.models.ids : []

  let out = ids.map(String)
  if (prefix) out = out.filter((id) => id.startsWith(prefix))
  if (contains) out = out.filter((id) => id.includes(contains))
  out = out.slice(0, limit)

  return c.json({
    success: true,
    provider,
    models: out,
    total: ids.length
  })
})
// Storage root should live at repo root by default: gamestudio/storage/*
// For production/real usage, prefer setting STUDIO_STORAGE_ROOT to a repo-external path.
const DEFAULT_ROOT = path.resolve(__dirname, '../../../storage')
const ENV_ROOT = String(process.env.STUDIO_STORAGE_ROOT || '').trim()
const ROOT = ENV_ROOT
  ? (path.isAbsolute(ENV_ROOT) ? ENV_ROOT : path.resolve(process.cwd(), ENV_ROOT))
  : DEFAULT_ROOT
const PROJECTS_DIR = path.join(ROOT, 'projects')
const DEMO_LIBRARY_DIR = path.join(ROOT, 'demo_library')
const TOOL_VERSION = '0.1.0'

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(opts || {}) })
    const out = []
    const err = []
    p.stdout.on('data', (d) => out.push(d))
    p.stderr.on('data', (d) => err.push(d))
    p.on('error', (e) => reject(e))
    p.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: Buffer.concat(out).toString('utf-8'), stderr: Buffer.concat(err).toString('utf-8') })
        return
      }
      const msg = Buffer.concat(err).toString('utf-8') || `command_failed: ${cmd} exit=${code}`
      reject(new Error(msg))
    })
  })
}

async function packageDistAsZip(outDir, zipName) {
  const attempts = [
    async () => runCommand('zip', ['-qr', zipName, 'dist'], { cwd: outDir }),
    async () => runCommand('7z', ['a', '-tzip', zipName, 'dist'], { cwd: outDir }),
    async () => runCommand('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', 'dist', zipName], { cwd: outDir }),
    async () =>
      runCommand(
        'powershell',
        ['-NoProfile', '-Command', `Compress-Archive -Path "dist\\*" -DestinationPath "${zipName}" -Force`],
        { cwd: outDir }
      )
  ]
  let lastErr = null
  for (const fn of attempts) {
    try {
      await fn()
      return
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('zip_failed')
}

async function sanitizeExportIndexHtml(indexPath) {
  try {
    let html = await readFile(indexPath, 'utf-8')
    let next = html
    // Fix broken regex emitted by older template versions.
    next = next.replaceAll("replace(/^/+/, '')", "replace(/^\\\\/+/, '')")
    // Remove export-only topbar.
    next = next.replace(
      /<div id="topbar">[\s\S]*?<\/div>\s*<div id="stageUI">/m,
      '<div id="stageUI">'
    )
    // Ensure runtime text removes duplicated choice lines (e.g. "选项1: xxx", "Option 1: xxx").
    next = next.replace(
      /const displayText = showEnding[\s\S]*?if \(dialogTextEl\) dialogTextEl\.textContent = hasText \? String\(displayText\) : ''/m,
      `const displayText = showEnding
            ? (String(endingText || '').trim() ? String(endingText) : fallback)
            : (String(text || '').trim() ? String(text) : fallback)
          const filtered = String(displayText)
            .split(/\\r?\\n/)
            .filter((original) => !/^\\s*(?:选项|option)\\s*(?:\\d{1,2}|[A-Z]|[一二三四五六七八九十])\\s*[:：]/i.test(original))
            .map((ln) => ln.trim())
            .filter(Boolean)
            .join('\\n')
          const finalText = filtered || displayText
          const hasText = String(finalText || '').trim().length > 0
          if (dialogTextEl) dialogTextEl.textContent = hasText ? String(finalText) : ''`
    )
    if (next !== html) await writeFile(indexPath, next, 'utf-8')
  } catch (_) {}
}

async function buildProjectDistForExport(id, dir) {
  const buildId = 'latest'
  const out = projectBuildDir(id, buildId)
  try {
    await rm(out, { recursive: true, force: true })
  } catch (_) {}
  const dist = path.join(out, 'dist')
  await mkdir(dist, { recursive: true })
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  await pluginStoryPixi.build({ projectId: id, projectDir: dir, outDir: dist, toolVersion: TOOL_VERSION, logger })
  await sanitizeExportIndexHtml(path.join(dist, 'index.html'))
  return { buildId, out, dist }
}

function normalizeSdwebuiBaseUrl(raw) {
  let s = String(raw || '').trim()
  if (!s) s = String(process.env.SDWEBUI_BASE_URL || 'http://127.0.0.1:7860')
  s = s.replace(/\/+$/, '')
  s = s.replace(/\/sdapi\/v1$/i, '')
  return s || 'http://127.0.0.1:7860'
}

function normalizeComfyuiBaseUrl(raw) {
  let s = String(raw || '').trim()
  if (!s) s = String(process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188')
  s = s.replace(/\/+$/, '')
  return s || 'http://127.0.0.1:8188'
}

function normalizeComfyModelName(raw) {
  return String(raw || '').trim().replace(/\s+\[[^\]]+\]\s*$/, '').trim()
}

function extractComfyChoiceList(raw) {
  // ComfyUI object_info enum field shape is usually:
  // - ["a.safetensors", ...]
  // - [["a.safetensors", ...], {"tooltip":"..."}]
  // This helper normalizes both.
  if (Array.isArray(raw) && raw.length >= 1 && Array.isArray(raw[0])) {
    return raw[0].map((x) => String(x || '').trim()).filter(Boolean)
  }
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x || '').trim()).filter(Boolean)
  }
  return []
}

function extractStringListFromUnknown(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((x) => {
        if (x == null) return ''
        if (typeof x === 'string') return x.trim()
        if (typeof x === 'object') {
          const o = x
          return String(o.name || o.filename || o.file || o.model_name || '').trim()
        }
        return String(x).trim()
      })
      .filter(Boolean)
  }
  return []
}

app.get('/api/studio/settings', async (c) => {
  const { settings, effective } = await getEffectiveStudioConfig(ROOT)
  return c.json({ success: true, settings: redactStudioSettingsForClient(settings) || null, effective: redactEffectiveStudioConfigForClient(effective) })
})

app.put('/api/studio/settings', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const saved = await writeStudioSettings(ROOT, body && body.settings ? body.settings : body)
  return c.json({ success: true, settings: redactStudioSettingsForClient(saved) || null })
})

app.get('/api/studio/sdwebui/models', async (c) => {
  const q = c.req.query()
  const baseUrl = normalizeSdwebuiBaseUrl(q.baseUrl || process.env.SDWEBUI_BASE_URL)
  const timeoutMs = clampInt(q.timeoutMs, 1_000, 30_000, 8_000)
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const [modelsResp, optionsResp] = await Promise.all([
      fetch(`${baseUrl}/sdapi/v1/sd-models`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/sdapi/v1/options`, { method: 'GET', signal: controller.signal }).catch(() => null)
    ])
    const modelsUnsupported = !modelsResp || Number(modelsResp.status || 0) === 404
    if (!modelsUnsupported && (!modelsResp || !modelsResp.ok)) {
      return c.json({ success: false, error: 'sdwebui_models_failed', message: `HTTP_${modelsResp ? modelsResp.status : 0}`, baseUrl }, 502)
    }
    const modelsJson = modelsUnsupported ? [] : await modelsResp.json().catch(() => [])
    const optionsJson = optionsResp && optionsResp.ok ? await optionsResp.json().catch(() => null) : null
    const currentModel = optionsJson && typeof optionsJson === 'object' ? String(optionsJson.sd_model_checkpoint || '').trim() || null : null
    const models = (Array.isArray(modelsJson) ? modelsJson : [])
      .map((x) => {
        if (!x || typeof x !== 'object') return ''
        const title = String(x.title || '').trim()
        const modelName = String(x.model_name || '').trim()
        const name = String(x.name || '').trim()
        return title || modelName || name || ''
      })
      .filter(Boolean)
    return c.json({
      success: true,
      baseUrl,
      currentModel,
      models,
      note: modelsUnsupported ? 'models_api_not_supported' : 'ok'
    })
  } catch (e) {
    return c.json(
      {
        success: false,
        error: 'sdwebui_connect_failed',
        message: e && e.message ? String(e.message) : String(e),
        baseUrl
      },
      502
    )
  } finally {
    clearTimeout(t)
  }
})

app.get('/api/studio/comfyui/models', async (c) => {
  const q = c.req.query()
  const baseUrl = normalizeComfyuiBaseUrl(q.baseUrl || process.env.COMFYUI_BASE_URL)
  const timeoutMs = clampInt(q.timeoutMs, 1_000, 30_000, 8_000)
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const [ckptResp, loraRespA, loraRespB, modelsResp, ckptListResp, loraListResp] = await Promise.all([
      fetch(`${baseUrl}/object_info/CheckpointLoaderSimple`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/object_info/LoraLoader`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/object_info/LoraLoaderModelOnly`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/models`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/models/checkpoints`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/models/loras`, { method: 'GET', signal: controller.signal }).catch(() => null)
    ])
    if (!ckptResp || !ckptResp.ok) {
      return c.json({ success: false, error: 'comfyui_models_failed', message: `HTTP_${ckptResp ? ckptResp.status : 0}`, baseUrl }, 502)
    }
    const ckptJson = await ckptResp.json().catch(() => null)
    const ckpts = ckptJson && ckptJson.CheckpointLoaderSimple && ckptJson.CheckpointLoaderSimple.input && ckptJson.CheckpointLoaderSimple.input.required
      ? ckptJson.CheckpointLoaderSimple.input.required.ckpt_name
      : null
    const modelSet = new Set(extractComfyChoiceList(ckpts))
    const modelsJson = modelsResp && modelsResp.ok ? await modelsResp.json().catch(() => null) : null
    const ckptListJson = ckptListResp && ckptListResp.ok ? await ckptListResp.json().catch(() => null) : null
    for (const x of extractStringListFromUnknown(ckptListJson)) modelSet.add(String(x || '').trim())
    if (modelsJson && typeof modelsJson === 'object') {
      for (const x of extractStringListFromUnknown(modelsJson.checkpoints)) modelSet.add(String(x || '').trim())
    }
    const models = Array.from(modelSet).filter(Boolean)
    const loraJsonA = loraRespA && loraRespA.ok ? await loraRespA.json().catch(() => null) : null
    const loraJsonB = loraRespB && loraRespB.ok ? await loraRespB.json().catch(() => null) : null
    const loraA = loraJsonA && loraJsonA.LoraLoader && loraJsonA.LoraLoader.input && loraJsonA.LoraLoader.input.required
      ? loraJsonA.LoraLoader.input.required.lora_name
      : null
    const loraB = loraJsonB && loraJsonB.LoraLoaderModelOnly && loraJsonB.LoraLoaderModelOnly.input && loraJsonB.LoraLoaderModelOnly.input.required
      ? loraJsonB.LoraLoaderModelOnly.input.required.lora_name
      : null
    const loraSet = new Set()
    for (const x of extractComfyChoiceList(loraA)) {
      const s = String(x || '').trim()
      if (s) loraSet.add(s)
    }
    for (const x of extractComfyChoiceList(loraB)) {
      const s = String(x || '').trim()
      if (s) loraSet.add(s)
    }
    const loraListJson = loraListResp && loraListResp.ok ? await loraListResp.json().catch(() => null) : null
    for (const x of extractStringListFromUnknown(loraListJson)) loraSet.add(String(x || '').trim())
    if (modelsJson && typeof modelsJson === 'object') {
      for (const x of extractStringListFromUnknown(modelsJson.loras)) loraSet.add(String(x || '').trim())
    }
    const loras = Array.from(loraSet)
    return c.json({
      success: true,
      baseUrl,
      currentModel: null,
      models,
      loras,
      note: 'ok'
    })
  } catch (e) {
    return c.json(
      {
        success: false,
        error: 'comfyui_connect_failed',
        message: e && e.message ? String(e.message) : String(e),
        baseUrl
      },
      502
    )
  } finally {
    clearTimeout(t)
  }
})

function normalizeConfiguredLoraNames(raw) {
  const arr = Array.isArray(raw) ? raw : []
  const out = []
  const seen = new Set()
  for (const item0 of arr) {
    const item = String(item0 || '').trim()
    if (!item) continue
    const name = String(item.split(':')[0] || '').trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

function hasAnimalSignals(text) {
  const s = String(text || '').trim().toLowerCase()
  if (!s) return false
  if (/[猫狗兔狐狼虎狮熊鹿马牛羊猴鸟鼠]/.test(s)) return true
  return [
    'kitten', 'cat', 'feline', 'puppy', 'dog', 'canine', 'rabbit', 'bunny',
    'fox', 'wolf', 'bear', 'tiger', 'lion', 'mouse', 'rat', 'deer',
    'animal', 'furry', 'fur', 'anthropomorphic'
  ].some((token) => s.includes(token))
}

function hasHumanSignals(text) {
  const s = String(text || '').trim().toLowerCase()
  if (!s) return false
  if (/[人物男孩女孩女人男人小孩儿童少女少年]/.test(s)) return true
  return [
    'human', 'person', 'girl', 'boy', 'woman', 'man', 'lady', 'child',
    'kid', 'people', 'portrait'
  ].some((token) => s.includes(token))
}

function chooseStoryboardAssetLoras({ asset, requestedLoras, stylePreset }) {
  const category = String(asset && asset.category || '').trim().toLowerCase()
  const lockProfile = String(asset && asset.lockProfile || '').trim().toLowerCase()
  const rawExplicit = Array.isArray(requestedLoras) ? requestedLoras.map((x) => String(x || '').trim()).filter(Boolean) : []
  const isProtectedProp = category === 'prop' && ['wearable_prop', 'slender_prop', 'rigid_prop', 'soft_prop', 'ambient_prop', 'organic_prop'].includes(lockProfile)
  const isSafePropReferenceLora = (entry) => {
    const name = String(entry || '').trim().toLowerCase()
    if (!name) return false
    // 2026-09-27 收窄黑名单：只保留会把 prop 拟人化/生物化的条目——furry/portrait/character/face/animal
    // 风格的 LoRA 会把道具拉向生物体（按原注释意图保留 furry）；child/children/storybook/picturebook/
    // book_illustration/genrih 是绘本风格 LoRA 的名称特征，正是保护类 prop 需要的风格，原黑名单把它们
    // 误杀了（settings 配置的 flat_childrenXX.safetensors 即中招，保护类 prop 抽卡零风格 LoRA 全灭）。
    if (/(furry|portrait|character|face|animal)/i.test(name)) return false
    // 白名单：扁平/绘本/插画/物件类风格 LoRA
    if (/(flat|cutout|storybook|picturebook|book.?illustration|children|game.?props?|object|asset)/i.test(name)) return true
    return false
  }
  const explicit = isProtectedProp ? rawExplicit.filter(isSafePropReferenceLora) : rawExplicit
  const byKey = new Map()
  const push = (entry) => {
    const raw = String(entry || '').trim()
    if (!raw) return
    const key = normalizeComfyLoraKey(raw.split(':')[0] || '')
    if (!key || byKey.has(key)) return
    byKey.set(key, raw)
  }

  for (const item of explicit) push(item)

  // 2026-09-28 默认 LoRA 栈沉淀进 settings 风格预设（loras.defaultStyle/characterAnimal），缺省用内置兜底
  const presetLoras = (stylePreset && stylePreset.loras && typeof stylePreset.loras === 'object') ? stylePreset.loras : {}
  const styleDefault = String(presetLoras.defaultStyle || '').trim() || 'Childrens_book_illustration_by_Genrih_Valk.safetensors:0.7'
  const furryDefault = String(presetLoras.characterAnimal || '').trim() || 'Anime_Furry_Style_SDXL.safetensors:0.7'
  // 2026-09-27：prop 无可用显式 LoRA 时与 character 一样补默认绘本风格 LoRA，不留空
  // （保护类 prop 零风格 LoRA 会产出写实照片风候选，小猫钓鱼鱼竿/浮漂 11+18 张全灭）
  if (!explicit.length) push(styleDefault)
  const signalText = [
    String(asset && asset.name || '').trim(),
    String(asset && asset.anchorPrompt || '').trim(),
    Array.isArray(asset && asset.aliases) ? asset.aliases.map((x) => String(x || '').trim()).join(' ') : ''
  ].join(' ')
  const isAnimalCharacter = category === 'character' && hasAnimalSignals(signalText)
  const isHumanCharacter = category === 'character' && !isAnimalCharacter && hasHumanSignals(signalText)

  if (isAnimalCharacter) push(furryDefault)
  if (isHumanCharacter && !explicit.length) push(styleDefault)

  return Array.from(byKey.values())
}

function normalizeComfyModelKey(raw) {
  return normalizeComfyModelName(raw)
    .replace(/^.*[\\/]/, '')
    .replace(/\.(safetensors|ckpt|pt|pth)$/i, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase()
}

function storyAssetCheckpointCandidates(asset) {
  const category = storyAssetStr(asset && asset.category).trim().toLowerCase()
  const lockProfile = storyAssetStr(asset && asset.lockProfile).trim().toLowerCase()
  const lockWorkflow = storyAssetStr(asset && asset.lockWorkflow).trim().toLowerCase()
  const signalText = [
    storyAssetStr(asset && asset.name),
    storyAssetStr(asset && asset.anchorPrompt),
    ...(Array.isArray(asset && asset.aliases) ? asset.aliases : [])
  ].join(' ').toLowerCase()

  const envCandidates = []
  const pushEnv = (name) => {
    const value = String(process.env[name] || '').trim()
    if (value) envCandidates.push(value)
  }
  pushEnv('STUDIO_ASSET_MODEL_DEFAULT')
  if (category === 'character') pushEnv('STUDIO_ASSET_MODEL_CHARACTER')
  if (category === 'location') pushEnv('STUDIO_ASSET_MODEL_LOCATION')
  if (lockProfile === 'wearable_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_WEARABLE')
  if (lockProfile === 'slender_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_SLENDER')
  if (lockProfile === 'rigid_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_RIGID')
  if (lockProfile === 'soft_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_SOFT')
  if (lockProfile === 'ambient_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_AMBIENT')
  if (lockProfile === 'organic_prop') pushEnv('STUDIO_ASSET_MODEL_PROP_ORGANIC')
  if (category === 'prop') pushEnv('STUDIO_ASSET_MODEL_PROP_GENERIC')

  const byPriority = []
  const push = (...items) => byPriority.push(...items.filter(Boolean))
  push(...envCandidates)

  if (category === 'character' || category === 'location') {
    push('ivisionIllustration_ivision10.safetensors', 'ivisionIllustration', 'sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0')
    return byPriority
  }
  if (lockProfile === 'wearable_prop' || lockProfile === 'soft_prop' || lockProfile === 'ambient_prop' || lockProfile === 'organic_prop') {
    push('ivisionIllustration_ivision10.safetensors', 'ivisionIllustration', 'sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0')
    return byPriority
  }
  if (lockProfile === 'slender_prop') {
    // 2026-09-26：slender_prop 一律 ivision 优先——sd_xl_base 对绘本风细长道具稳定产出跑题图
    // （实测钓鱼线→女性铠甲角色线稿 score 2、鱼竿→多面板技术图解 score 14，AI 评审全灭）；
    // ivision 渲染的 organic/character 资产均通过评审。sd_xl_base 降为回退。
    push('ivisionIllustration_ivision10.safetensors', 'ivisionIllustration', 'sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0')
    return byPriority
  }
  if (lockProfile === 'rigid_prop' || lockWorkflow === 'prop_product') {
    // 2026-09-26：rigid_prop 同样 ivision 优先——sd_xl_base 对绘本风道具稳定产出跑题/版图（与 slender_prop 同款失败）
    push('ivisionIllustration_ivision10.safetensors', 'ivisionIllustration', 'sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0')
    return byPriority
  }
  if (category === 'prop') {
    push('ivisionIllustration_ivision10.safetensors', 'ivisionIllustration', 'sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0')
    return byPriority
  }
  push('sd_xl_base_1.0.safetensors', 'sd_xl_base_1.0', 'ivisionIllustration_ivision10.safetensors', 'ivisionIllustration')
  return byPriority
}

function pickBestStoryboardAssetModel(models, asset) {
  const list = Array.isArray(models) ? models.map((x) => String(x || '').trim()).filter(Boolean) : []
  if (!list.length) return ''
  const exactMap = new Map(list.map((item) => [normalizeComfyModelKey(item), item]))
  for (const candidate of storyAssetCheckpointCandidates(asset)) {
    const key = normalizeComfyModelKey(candidate)
    if (key && exactMap.has(key)) return exactMap.get(key) || ''
  }
  for (const candidate of storyAssetCheckpointCandidates(asset)) {
    const key = normalizeComfyModelKey(candidate)
    if (!key) continue
    const hit = list.find((item) => normalizeComfyModelKey(item).includes(key) || key.includes(normalizeComfyModelKey(item)))
    if (hit) return hit
  }
  return list[0] || ''
}

async function resolveStoryboardAssetModel({ studio, imgProvider, requestedModel, asset }) {
  const explicit = normalizeComfyModelName(requestedModel)
  if (explicit || String(imgProvider || '').trim().toLowerCase() !== 'comfyui') {
    return {
      model: explicit || String(studio?.effective?.image?.model || '').trim(),
      source: explicit ? 'explicit' : 'studio_default',
      availableModels: []
    }
  }
  const configured = normalizeComfyModelName(studio?.effective?.image?.model)
  const modelsRoot = normalizeLocalPath(studio?.effective?.image?.comfyuiModelsRoot)
  let availableModels = []
  if (modelsRoot) {
    const base = await resolveSdWebuiModelsBase(modelsRoot)
    const ckptDir = await pickCheckpointDir(base)
    availableModels = ckptDir ? await scanModelFiles(ckptDir, { exts: ['.safetensors', '.ckpt'], maxDepth: 4 }) : []
  }
  if (!availableModels.length) {
    const baseUrl = normalizeComfyuiBaseUrl(studio?.effective?.image?.comfyuiBaseUrl)
    const cap = await collectComfyCapabilities(baseUrl, 12_000, []).catch(() => null)
    availableModels = Array.isArray(cap?.models) ? cap.models : []
  }
  const chosen = pickBestStoryboardAssetModel(availableModels, asset)
  if (chosen) {
    return { model: chosen, source: 'asset_profile_auto', availableModels }
  }
  return { model: configured, source: configured ? 'studio_default' : 'provider_fallback', availableModels }
}

function normalizeComfyLoraKey(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  const base = s.replace(/^.*[\\/]/, '')
  return base
    .replace(/\s+\[[^\]]+\]\s*$/, '')
    .replace(/\.(safetensors|ckpt|pt|pth)$/i, '')
    .trim()
    .toLowerCase()
}

async function collectComfyCapabilities(baseUrl, timeoutMs, requiredNodes = null) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const nodes = Array.isArray(requiredNodes) && requiredNodes.length
      ? requiredNodes.map((x) => String(x || '').trim()).filter(Boolean)
      : ['CheckpointLoaderSimple', 'CLIPTextEncode', 'KSampler', 'VAEDecode', 'SaveImage']
    const checks = await Promise.all(nodes.map(async (node) => {
      const resp = await fetch(`${baseUrl}/object_info/${encodeURIComponent(node)}`, { method: 'GET', signal: controller.signal }).catch(() => null)
      return { node, ok: Boolean(resp && resp.ok) }
    }))
    const missingNodes = checks.filter((x) => !x.ok).map((x) => x.node)

    const [ckptInfoResp, ckptListResp, modelsResp, loraListResp, loraInfoResp] = await Promise.all([
      fetch(`${baseUrl}/object_info/CheckpointLoaderSimple`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/models/checkpoints`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/models`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/models/loras`, { method: 'GET', signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/object_info/LoraLoader`, { method: 'GET', signal: controller.signal }).catch(() => null)
    ])

    const modelSet = new Set()
    const loraSet = new Set()

    const ckptInfoJson = ckptInfoResp && ckptInfoResp.ok ? await ckptInfoResp.json().catch(() => null) : null
    const ckpts = ckptInfoJson && ckptInfoJson.CheckpointLoaderSimple && ckptInfoJson.CheckpointLoaderSimple.input && ckptInfoJson.CheckpointLoaderSimple.input.required
      ? ckptInfoJson.CheckpointLoaderSimple.input.required.ckpt_name
      : null
    for (const x of extractComfyChoiceList(ckpts)) modelSet.add(String(x || '').trim())

    const ckptListJson = ckptListResp && ckptListResp.ok ? await ckptListResp.json().catch(() => null) : null
    for (const x of extractStringListFromUnknown(ckptListJson)) modelSet.add(String(x || '').trim())

    const modelsJson = modelsResp && modelsResp.ok ? await modelsResp.json().catch(() => null) : null
    if (modelsJson && typeof modelsJson === 'object') {
      for (const x of extractStringListFromUnknown(modelsJson.checkpoints)) modelSet.add(String(x || '').trim())
      for (const x of extractStringListFromUnknown(modelsJson.loras)) loraSet.add(String(x || '').trim())
    }

    const loraListJson = loraListResp && loraListResp.ok ? await loraListResp.json().catch(() => null) : null
    for (const x of extractStringListFromUnknown(loraListJson)) loraSet.add(String(x || '').trim())

    const loraInfoJson = loraInfoResp && loraInfoResp.ok ? await loraInfoResp.json().catch(() => null) : null
    const loraNames = loraInfoJson && loraInfoJson.LoraLoader && loraInfoJson.LoraLoader.input && loraInfoJson.LoraLoader.input.required
      ? loraInfoJson.LoraLoader.input.required.lora_name
      : null
    for (const x of extractComfyChoiceList(loraNames)) loraSet.add(String(x || '').trim())

    return {
      ok: true,
      missingNodes,
      models: Array.from(modelSet).filter(Boolean),
      loras: Array.from(loraSet).filter(Boolean)
    }
  } finally {
    clearTimeout(t)
  }
}

async function fetchComfyModelList(baseUrl, path, signal) {
  try {
    const resp = await fetch(`${baseUrl}${path}`, { method: 'GET', signal }).catch(() => null)
    if (!resp) return { ok: false, status: 0, supported: false, list: [] }
    if (Number(resp.status || 0) === 404) return { ok: false, status: 404, supported: false, list: [] }
    const json = resp.ok ? await resp.json().catch(() => null) : null
    const list = Array.isArray(json) ? json.map((x) => String(x || '').trim()).filter(Boolean) : []
    return { ok: Boolean(resp.ok), status: Number(resp.status || 0), supported: true, list }
  } catch (_) {
    return { ok: false, status: 0, supported: false, list: [] }
  }
}

async function probeComfyAnyNode(baseUrl, names, signal) {
  const tried = []
  for (const n0 of names) {
    const n = String(n0 || '').trim()
    if (!n) continue
    tried.push(n)
    const resp = await fetch(`${baseUrl}/object_info/${encodeURIComponent(n)}`, { method: 'GET', signal }).catch(() => null)
    if (resp && resp.ok) return { ok: true, found: n, tried }
  }
  return { ok: false, found: '', tried }
}

async function isDir(p) {
  try {
    const st = await stat(String(p))
    return Boolean(st && st.isDirectory())
  } catch (_) {
    return false
  }
}

async function pickExistingDir(root, candidates) {
  const base = String(root || '').trim()
  if (!base) return ''
  for (const c0 of candidates) {
    const c = String(c0 || '').trim()
    if (!c) continue
    const p = path.join(base, c)
    if (await isDir(p)) return p
  }
  return ''
}

async function hasAnyModelInDirs(dirs) {
  const list = Array.isArray(dirs) ? dirs.map((x) => String(x || '').trim()).filter(Boolean) : []
  let total = 0
  for (const d of list) {
    const r = await hasAnyModelFile(d)
    if (r.ok && r.count) {
      total += r.count
      break
    }
  }
  return { ok: true, count: total }
}

async function hasAnyModelFile(dirPath) {
  try {
    const dir = String(dirPath || '').trim()
    if (!dir) return { ok: false, count: 0 }
    if (!(await isDir(dir))) return { ok: true, count: 0 }
    const items = await readdir(dir).catch(() => [])
    let count = 0
    for (const name of items) {
      const s = String(name || '')
      if (!s) continue
      if (!/\.(safetensors|ckpt|pt|pth|bin)$/i.test(s)) continue
      count += 1
      if (count >= 1) break
    }
    return { ok: true, count }
  } catch (_) {
    return { ok: false, count: 0 }
  }
}

app.post('/api/studio/image/preflight', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const timeoutMs = clampInt(body?.timeoutMs, 2_000, 60_000, 10_000)
  const mode = String(body?.mode || 'basic').trim().toLowerCase() === 'storyboard' ? 'storyboard' : 'basic'
  const settingsOverride = body && body.settings && typeof body.settings === 'object' ? body.settings : null
  const { effective } = await getEffectiveStudioConfig(ROOT, { settingsOverride })

  const provider = String(effective.image.provider || '').toLowerCase()
  if (!effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', checks: { provider, ok: false, reason: 'image_disabled' } }, 503)
  }
  if (!provider || provider === 'none') {
    return c.json({ success: false, error: 'provider_not_configured', checks: { provider, ok: false, reason: 'provider_none' } }, 400)
  }

  if (provider !== 'comfyui') {
    return c.json({ success: true, checks: { provider, ok: true, note: 'preflight_skipped_non_comfyui' } })
  }

  const baseUrl = normalizeComfyuiBaseUrl(effective.image.comfyuiBaseUrl)
  const modelsRoot = normalizeLocalPath(effective.image.comfyuiModelsRoot)
  const requiredNodes = [
    'CheckpointLoaderSimple',
    'CLIPTextEncode',
    'KSampler',
    'VAEDecode',
    'SaveImage'
  ]
  const check = {
    provider,
    baseUrl,
    mode,
    ok: false,
    requiredNodes,
    missingNodes: [],
    extras: {
      // SDXL storyboard continuity uses the lock/reference workflow as the hard gate.
      // ControlNet is treated as an optional lineart enhancer because this local SDXL
      // setup already supports successful storyboard drawing without SD1.5 ControlNet.
      // Note: `extCount` is for SD-WebUI ControlNet extension models, which are not
      // automatically visible to ComfyUI unless the user links/copies/configures paths.
      controlnet: { ok: false, missingNodes: [], modelsOk: false, modelsSupported: false, modelsCount: 0, diskCount: 0, extCount: 0 },
      ipadapter: { ok: false, missingNodes: [], modelsOk: false, modelsSupported: false, modelsCount: 0, diskCount: 0 },
      storyLock: { ok: false, checkpointOk: false, checkpointModel: String(effective.image.model || '').trim() || null, checkpointCount: 0, loraCount: 0 }
    },
    hints: {
      comfyuiModelsRoot: modelsRoot || null,
      comfyuiModelDir: 'ComfyUI/models/checkpoints',
      comfyuiLoraDir: 'ComfyUI/models/loras',
      comfyuiControlnetDir: 'ComfyUI/models/controlnet',
      comfyuiIpadapterDir: 'ComfyUI/models/ipadapter',
      sdxlStoryboardHint: 'SDXL storyboard lock requires a ComfyUI checkpoint and IP-Adapter; ControlNet is optional for lineart enhancement.',
      restartHint: 'if you add/remove models, restart ComfyUI to refresh cache',
      managerHint: 'recommended: install ComfyUI-Manager to manage custom nodes'
    },
    disk: {
      modelsRoot: modelsRoot || null,
      checkpointsDir: null,
      lorasDir: null,
      controlnetDir: null,
      controlnetExtDir: null,
      ipadapterDir: null,
      modelFileFound: null
    },
    reason: ''
  }

  try {
    const statsResp = await fetch(`${baseUrl}/system_stats`, { method: 'GET' }).catch(() => null)
    if (!statsResp || !statsResp.ok) {
      check.reason = `comfyui_unreachable_${statsResp ? statsResp.status : 0}`
      return c.json({ success: false, error: 'preflight_failed', checks: check }, 502)
    }

    const cap = await collectComfyCapabilities(baseUrl, timeoutMs, requiredNodes)
    check.missingNodes = Array.isArray(cap.missingNodes) ? cap.missingNodes : []
    if (check.missingNodes.length) {
      check.reason = 'missing_required_nodes'
      return c.json({ success: false, error: 'preflight_failed', checks: check }, 400)
    }

    // Update hint dirs if modelsRoot is configured.
    if (modelsRoot) {
      const base = await resolveSdWebuiModelsBase(modelsRoot)
      const ckptDir = await pickCheckpointDir(base)
      const loraDir = await pickLoraDir(base)
      const cnDir = await pickExistingDir(base, ['ControlNet', 'controlnet'])
      const ipaDir = await pickExistingDir(base, ['ipadapter', 'IPAdapter'])
      // SD-WebUI ControlNet extension models (common when sharing SD-WebUI folder):
      // <webuiRoot>/extensions/sd-webui-controlnet/models
      const webuiRoot = path.dirname(base || modelsRoot)
      const cnExtDir = await pickExistingDir(webuiRoot, ['extensions/sd-webui-controlnet/models'])
      if (ckptDir) check.hints.comfyuiModelDir = ckptDir
      if (loraDir) check.hints.comfyuiLoraDir = loraDir
      if (cnDir) check.hints.comfyuiControlnetDir = cnDir
      if (ipaDir) check.hints.comfyuiIpadapterDir = ipaDir
      check.disk.checkpointsDir = ckptDir || check.disk.checkpointsDir
      check.disk.lorasDir = loraDir || check.disk.lorasDir
      if (ckptDir) {
        const disk = await hasAnyModelFile(ckptDir)
        check.extras.storyLock.checkpointCount = disk.ok ? disk.count : 0
        check.disk.modelFileFound = disk.ok && disk.count > 0
      }
      if (loraDir) {
        const disk = await hasAnyModelFile(loraDir)
        check.extras.storyLock.loraCount = disk.ok ? disk.count : 0
      }
      check.disk.controlnetDir = cnDir || null
      check.disk.ipadapterDir = ipaDir || null
      if (cnExtDir) check.disk.controlnetExtDir = cnExtDir
    }

    // Optional but required for "continuous storyboard" mode.
    if (mode === 'storyboard') {
      const controller = new AbortController()
      const t2 = setTimeout(() => controller.abort(), Math.min(timeoutMs, 15000))
      try {
        const sig = controller.signal
        // ControlNet nodes: allow variants.
        const cnLoader = await probeComfyAnyNode(baseUrl, ['ControlNetLoader', 'ControlNetLoaderAdvanced'], sig)
        const cnApply = await probeComfyAnyNode(baseUrl, ['ControlNetApply', 'ControlNetApplyAdvanced'], sig)
        const cnMissing = []
        if (!cnLoader.ok) cnMissing.push('ControlNetLoader')
        if (!cnApply.ok) cnMissing.push('ControlNetApply')
        check.extras.controlnet.missingNodes = cnMissing
        // ControlNet models list (best-effort)
        const cnModels = await fetchComfyModelList(baseUrl, '/models/controlnet', sig)
        check.extras.controlnet.modelsSupported = Boolean(cnModels.supported)
        check.extras.controlnet.modelsCount = Array.isArray(cnModels.list) ? cnModels.list.length : 0
        if (check.extras.controlnet.modelsSupported) {
          check.extras.controlnet.modelsOk = check.extras.controlnet.modelsCount > 0
        } else if (modelsRoot) {
          // Disk check should focus on ComfyUI-visible ControlNet dir. SD-WebUI extension models
          // are reported separately as a "can be linked" hint.
          const cnDir = String(check.hints.comfyuiControlnetDir || '').trim()
          if (cnDir) {
            const disk = await hasAnyModelFile(cnDir)
            check.extras.controlnet.diskCount = disk.ok ? disk.count : 0
            check.extras.controlnet.modelsOk = disk.ok && disk.count > 0
          } else {
            check.extras.controlnet.diskCount = 0
            check.extras.controlnet.modelsOk = false
          }
          const extDir = String(check.disk.controlnetExtDir || '').trim()
          if (extDir) {
            const ext = await hasAnyModelFile(extDir)
            check.extras.controlnet.extCount = ext.ok ? ext.count : 0
          }
        } else {
          check.extras.controlnet.modelsOk = false
        }
        check.extras.controlnet.ok = cnMissing.length === 0 && check.extras.controlnet.modelsOk

        // IP-Adapter nodes (ComfyUI_IPAdapter_plus and variants)
        const ipaLoader = await probeComfyAnyNode(baseUrl, ['IPAdapterModelLoader', 'IPAdapterLoader', 'IPAdapterUnifiedLoader'], sig)
        const ipaApply = await probeComfyAnyNode(baseUrl, ['IPAdapterApply', 'IPAdapterApplyAdvanced', 'IPAdapterAdvanced'], sig)
        const ipaMissing = []
        if (!ipaLoader.ok) ipaMissing.push('IPAdapterModelLoader')
        if (!ipaApply.ok) ipaMissing.push('IPAdapterApply')
        check.extras.ipadapter.missingNodes = ipaMissing
        const ipaModels = await fetchComfyModelList(baseUrl, '/models/ipadapter', sig)
        check.extras.ipadapter.modelsSupported = Boolean(ipaModels.supported)
        check.extras.ipadapter.modelsCount = Array.isArray(ipaModels.list) ? ipaModels.list.length : 0
        if (check.extras.ipadapter.modelsSupported) {
          check.extras.ipadapter.modelsOk = check.extras.ipadapter.modelsCount > 0
        } else if (modelsRoot && check.hints.comfyuiIpadapterDir) {
          const disk = await hasAnyModelFile(check.hints.comfyuiIpadapterDir)
          check.extras.ipadapter.diskCount = disk.ok ? disk.count : 0
          check.extras.ipadapter.modelsOk = disk.ok && disk.count > 0
        } else {
          check.extras.ipadapter.modelsOk = false
        }
        check.extras.ipadapter.ok = ipaMissing.length === 0 && check.extras.ipadapter.modelsOk

        const configuredCheckpoint = String(effective.image.model || '').trim()
        const comfyCheckpoints = Array.isArray(cap.models) ? cap.models.map((x) => String(x || '').trim()).filter(Boolean) : []
        const normalizedConfigured = normalizeComfyModelKey(configuredCheckpoint)
        const checkpointKnownToComfy = normalizedConfigured
          ? comfyCheckpoints.some((item) => {
            const key = normalizeComfyModelKey(item)
            return key === normalizedConfigured || key.includes(normalizedConfigured) || normalizedConfigured.includes(key)
          })
          : comfyCheckpoints.length > 0
        const checkpointOnDisk = Boolean(check.disk.modelFileFound || check.extras.storyLock.checkpointCount > 0)
        check.extras.storyLock.checkpointOk = Boolean(checkpointKnownToComfy || checkpointOnDisk)
        check.extras.storyLock.checkpointModel = configuredCheckpoint || (comfyCheckpoints[0] || null)
        check.extras.storyLock.ok = Boolean(check.extras.storyLock.checkpointOk && check.extras.ipadapter.ok)
      } finally {
        clearTimeout(t2)
      }

      if (!check.extras.storyLock.ok) {
        check.reason = 'missing_storyboard_extras'
        return c.json({ success: false, error: 'preflight_failed', checks: check }, 400)
      }
    }

    check.ok = true
    check.reason = 'ok'
    return c.json({ success: true, checks: check })
  } catch (e) {
    check.reason = e && e.message ? String(e.message) : String(e)
    return c.json({ success: false, error: 'preflight_failed', checks: check }, 502)
  }
})

app.post('/api/studio/image/models', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const settingsOverride = body && body.settings && typeof body.settings === 'object' ? body.settings : null
  const { effective } = await getEffectiveStudioConfig(ROOT, { settingsOverride })

  if (!effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: 'image_disabled' }, 503)
  }

  const provider = String(effective.image.provider || '').toLowerCase()
  if (!provider || provider === 'none') {
    return c.json({ success: false, error: 'provider_not_configured', message: 'provider_none' }, 400)
  }

  const baseUrl =
    provider === 'comfyui'
      ? normalizeComfyuiBaseUrl(effective.image.comfyuiBaseUrl)
      : provider === 'sdwebui'
        ? normalizeSdwebuiBaseUrl(effective.image.sdwebuiBaseUrl)
        : ''

  // Prefer disk scan when a shared Models Root is configured for ComfyUI.
  if (provider === 'comfyui') {
    const modelsRoot = normalizeLocalPath(effective.image.comfyuiModelsRoot)
    if (modelsRoot) {
      const base = await resolveSdWebuiModelsBase(modelsRoot)
      const ckptDir = await pickCheckpointDir(base)
      const loraDir = await pickLoraDir(base)
      const models = ckptDir ? await scanModelFiles(ckptDir, { exts: ['.safetensors', '.ckpt'], maxDepth: 4 }) : []
      const loras = loraDir ? await scanModelFiles(loraDir, { exts: ['.safetensors'], maxDepth: 4 }) : []
      return c.json({
        success: true,
        source: 'disk',
        provider,
        baseUrl,
        modelsRoot: base || modelsRoot,
        dirs: { checkpointsDir: ckptDir || null, lorasDir: loraDir || null },
        models,
        loras,
        note: 'disk_scan'
      })
    }
  }

  // Fallback: query provider API (may include cached names).
  try {
    if (provider === 'comfyui') {
      const cap = await collectComfyCapabilities(baseUrl, 12_000, [])
      return c.json({
        success: true,
        source: 'comfyui',
        provider,
        baseUrl,
        models: Array.isArray(cap.models) ? cap.models : [],
        loras: Array.isArray(cap.loras) ? cap.loras : [],
        note: 'comfyui_api'
      })
    }
    if (provider === 'sdwebui') {
      const res = await fetch(`${baseUrl}/sdapi/v1/sd-models`, { method: 'GET' }).catch(() => null)
      if (!res || !res.ok) return c.json({ success: false, error: 'models_failed', message: `sdwebui_models_http_${res ? res.status : 0}` }, 502)
      const arr = await res.json().catch(() => [])
      const list = Array.isArray(arr) ? arr : []
      const models = list.map((x) => (x && typeof x === 'object' ? String(x.model_name || x.title || x.name || '').trim() : '')).filter(Boolean)
      return c.json({ success: true, source: 'sdwebui', provider, baseUrl, models, loras: [], note: 'sdwebui_api' })
    }
    return c.json({ success: true, source: 'none', provider, baseUrl, models: [], loras: [], note: 'not_supported' })
  } catch (e) {
    return c.json({ success: false, error: 'models_failed', message: e && e.message ? String(e.message) : String(e) }, 502)
  }
})

app.post('/api/studio/image/test', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const timeoutMs = clampInt(body?.timeoutMs, 5_000, 300_000, 60_000)
  const settingsOverride = body && body.settings && typeof body.settings === 'object' ? body.settings : null
  const { effective } = await getEffectiveStudioConfig(ROOT, { settingsOverride })
  const requestedModel = String(body?.model || '').trim()
  const requestedLoras = Array.isArray(body?.loras) ? body.loras.map((x) => String(x || '').trim()).filter(Boolean) : []

  if (!effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
  const provider = String(effective.image.provider || '').toLowerCase()
  if (!provider || provider === 'none') {
    return c.json({ success: false, error: 'provider_not_configured', message: '请先在设置中选择 Provider/Model' }, 400)
  }

  if (provider === 'comfyui') {
    const pre = await (async () => {
      const baseUrl = normalizeComfyuiBaseUrl(effective.image.comfyuiBaseUrl)
      const modelConfigured = requestedModel || String(effective.image.model || '').trim()
      const lorasConfigured = normalizeConfiguredLoraNames(requestedLoras.length ? requestedLoras : effective.image.loras)
      const requiredNodes = [
        'CheckpointLoaderSimple',
        'CLIPTextEncode',
        'KSampler',
        'VAEDecode',
        'SaveImage',
        ...(lorasConfigured.length ? ['LoraLoader'] : [])
      ]
      const check = {
        provider: 'comfyui',
        baseUrl,
        ok: false,
        requiredNodes,
        missingNodes: [],
        modelConfigured,
        modelExists: false,
        lorasConfigured,
        missingLoras: [],
        hints: {
          comfyuiModelDir: 'ComfyUI/models/checkpoints',
          comfyuiLoraDir: 'ComfyUI/models/loras',
          restartHint: 'if you add/remove models, restart ComfyUI to refresh cache',
          managerHint: 'recommended: install ComfyUI-Manager to manage custom nodes'
        },
        reason: ''
      }
      try {
        const statsResp = await fetch(`${baseUrl}/system_stats`, { method: 'GET' }).catch(() => null)
        if (!statsResp || !statsResp.ok) {
          check.reason = `comfyui_unreachable_${statsResp ? statsResp.status : 0}`
          return { ok: false, check }
        }
        const cap = await collectComfyCapabilities(baseUrl, Math.min(timeoutMs, 15_000), requiredNodes)
        check.missingNodes = Array.isArray(cap.missingNodes) ? cap.missingNodes : []
        if (check.missingNodes.length) {
          check.reason = 'missing_required_nodes'
          return { ok: false, check }
        }
        const models = Array.isArray(cap.models) ? cap.models.map((x) => String(x || '').trim()).filter(Boolean) : []
        if (!check.modelConfigured) {
          check.reason = 'missing_model_config'
          return { ok: false, check }
        }
        check.modelExists = models.some((x) => String(x).toLowerCase() === String(check.modelConfigured).toLowerCase())
        if (!check.modelExists) {
          check.reason = 'configured_model_not_found'
          return { ok: false, check }
        }
        const loras = Array.isArray(cap.loras) ? cap.loras.map((x) => String(x || '').trim()).filter(Boolean) : []
        const loraKeySet = new Set(loras.map((x) => normalizeComfyLoraKey(x)).filter(Boolean))
        check.missingLoras = check.lorasConfigured.filter((name) => !loraKeySet.has(normalizeComfyLoraKey(name)))
        if (check.missingLoras.length) {
          check.reason = 'configured_loras_not_found'
          return { ok: false, check }
        }
        check.ok = true
        check.reason = 'ok'
        return { ok: true, check }
      } catch (e) {
        check.reason = e && e.message ? String(e.message) : String(e)
        return { ok: false, check }
      }
    })()
    if (!pre.ok) {
      return c.json({ success: false, error: 'preflight_failed', message: `preflight_failed: ${pre.check.reason}`, checks: pre.check }, 400)
    }
  }

  const width = clampInt(body?.width, 256, 1024, 512)
  const height = clampInt(body?.height, 256, 1024, 512)
  const style = normalizeStyleEnum(body?.style || 'picture_book')
  const prompt = String(body?.prompt || '').trim() || 'a warm children picture book illustration, a cute rabbit reading a book in a cozy forest, soft light, clean outlines'
  const negativePrompt = String(body?.negativePrompt || '').trim()

  try {
    const gen = await generateBackgroundImage({
      prompt,
      negativePrompt,
      style,
      width,
      height,
      size: body?.size,
      responseFormat: body?.responseFormat,
      watermark: body?.watermark,
      sequentialImageGeneration: body?.sequentialImageGeneration,
      steps: body?.steps,
      cfgScale: body?.cfgScale,
      sampler: body?.sampler,
      scheduler: body?.scheduler,
      provider,
      model: requestedModel || effective.image.model,
      loras: requestedLoras.length ? requestedLoras : effective.image.loras,
      sdwebuiBaseUrl: effective.image.sdwebuiBaseUrl,
      comfyuiBaseUrl: effective.image.comfyuiBaseUrl,
      apiUrl: effective.image.apiUrl,
      proxyUrl: effective.network.proxyUrl,
      timeoutMs
    })
    const buf = gen.bytes
    const ext0 = String(gen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
    const sniff = sniffImageMetaFromBytes(buf)
    const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'
    const b64 = buf.toString('base64')
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
    return c.json({
      success: true,
      result: { ext, bytesBase64: b64, dataUrl: `data:${mime};base64,${b64}` },
      meta: gen.meta || null
    })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const status = e && typeof e.status === 'number' ? e.status : null
    return c.json({ success: false, error: 'test_failed', message: msg, status: status == null ? undefined : status }, 502)
  }
})

app.post('/api/studio/diagnose', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const deepText = Boolean(body && body.deepText)
  const deepImages = Boolean(body && body.deepImages)
  const service = String((body && body.service) || 'all').trim().toLowerCase()
  const timeoutMs = clampInt(body?.timeoutMs, 3_000, 60_000, 12_000)

  const settingsOverride = body && body.settings && typeof body.settings === 'object' ? body.settings : null
  const { effective } = await getEffectiveStudioConfig(ROOT, { settingsOverride })

  const out = {
    ok: true,
    checkedAt: new Date().toISOString(),
    effective: redactEffectiveStudioConfigForClient(effective),
    services: {
      server: { ok: true, note: 'health_ok' },
      scripts: { ok: true, provider: effective.scripts.provider, model: effective.scripts.model, note: '' },
      prompt: { ok: true, provider: effective.prompt.provider, model: effective.prompt.model, note: '' },
      translation: { ok: true, provider: effective.translation?.provider, model: effective.translation?.model, note: '' },
      image: { ok: true, provider: effective.image.provider, model: effective.image.model, note: '' },
      tts: effective.enabled.tts
        ? { ok: false, provider: effective.tts.provider, model: effective.tts.model, note: 'not_implemented' }
        : { ok: true, provider: effective.tts.provider, model: effective.tts.model, note: 'disabled' }
    }
  }

  async function dnsCheck(url) {
    try {
      const host = new URL(String(url)).hostname
      const addrs = await dns.lookup(host, { all: true }).catch(() => [])
      return { ok: Array.isArray(addrs) && addrs.length > 0, host, count: Array.isArray(addrs) ? addrs.length : 0 }
    } catch (e) {
      return { ok: false, error: e && e.message ? String(e.message) : String(e) }
    }
  }

  async function diagnoseSdWebui(baseUrl, model) {
    const url = normalizeSdwebuiBaseUrl(baseUrl)
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetch(`${url}/sdapi/v1/options`, { method: 'GET', signal: controller.signal })
      if (!resp.ok) return { ok: false, provider: 'sdwebui', note: `HTTP_${resp.status}`, baseUrl: url, model: model || null }

      const modelName = normalizeComfyModelName(model)
      if (modelName) {
        const mResp = await fetch(`${url}/sdapi/v1/sd-models`, { method: 'GET', signal: controller.signal })
        if (!mResp.ok) {
          if (Number(mResp.status || 0) === 404) {
            return { ok: true, provider: 'sdwebui', note: 'model_check_skipped_models_api_not_supported', baseUrl: url, model: modelName }
          }
          return { ok: false, provider: 'sdwebui', note: `models_HTTP_${mResp.status}`, baseUrl: url, model: modelName }
        }
        const arr = await mResp.json().catch(() => null)
        const list = Array.isArray(arr) ? arr : []
        const names = list
          .map((x) => (x && typeof x === 'object' ? String(x.model_name || x.title || x.name || '').trim() : ''))
          .filter(Boolean)
        const found = names.some((n) => n === modelName || n.includes(modelName) || modelName.includes(n))
        if (!found) {
          return { ok: false, provider: 'sdwebui', note: 'model_not_found', baseUrl: url, model: modelName }
        }
        return { ok: true, provider: 'sdwebui', note: 'configured_model_ok', baseUrl: url, model: modelName }
      }

      return { ok: true, provider: 'sdwebui', note: 'configured', baseUrl: url, model: null }
    } catch (e) {
      return { ok: false, provider: 'sdwebui', note: e && e.message ? String(e.message) : String(e), baseUrl: url, model: model || null }
    } finally {
      clearTimeout(t)
    }
  }

  async function diagnoseComfyui(baseUrl, model) {
    const url = normalizeComfyuiBaseUrl(baseUrl)
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const stats = await fetch(`${url}/system_stats`, { method: 'GET', signal: controller.signal })
      if (!stats.ok) return { ok: false, provider: 'comfyui', note: `HTTP_${stats.status}`, baseUrl: url, model: model || null }

      const modelName = String(model || '').trim()
      if (modelName) {
        const mResp = await fetch(`${url}/object_info/CheckpointLoaderSimple`, { method: 'GET', signal: controller.signal })
        if (!mResp.ok) return { ok: false, provider: 'comfyui', note: `models_HTTP_${mResp.status}`, baseUrl: url, model: modelName }
        const j = await mResp.json().catch(() => null)
        const ckpts = j && j.CheckpointLoaderSimple && j.CheckpointLoaderSimple.input && j.CheckpointLoaderSimple.input.required
          ? j.CheckpointLoaderSimple.input.required.ckpt_name
          : null
        const names = Array.isArray(ckpts) ? ckpts.map((x) => String(x || '').trim()).filter(Boolean) : []
        const found = names.some((n) => n === modelName || n.includes(modelName) || modelName.includes(n))
        if (!found) return { ok: false, provider: 'comfyui', note: 'model_not_found', baseUrl: url, model: modelName }
        return { ok: true, provider: 'comfyui', note: 'configured_model_ok', baseUrl: url, model: modelName }
      }
      return { ok: true, provider: 'comfyui', note: 'configured', baseUrl: url, model: null }
    } catch (e) {
      return { ok: false, provider: 'comfyui', note: e && e.message ? String(e.message) : String(e), baseUrl: url, model: model || null }
    } finally {
      clearTimeout(t)
    }
  }

  async function diagnoseDoubaoText(model, apiUrl) {
    const keyPresent = Boolean(String(getStudioSecret('doubao') || process.env.DOUBAO_ARK_API_KEY || process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY || '').trim())
    const authHeaderPresent = Boolean(String(process.env.DOUBAO_ARK_AUTH_HEADER || process.env.DOUBAO_AUTH_HEADER || '').trim())
    const cfg = {
      provider: 'doubao',
      api: 'chat.completions',
      apiUrl: String(apiUrl || process.env.DOUBAO_ARK_CHAT_URL || process.env.DOUBAO_ARK_TEXT_URL || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'),
      model: String(model || process.env.DOUBAO_ARK_TEXT_MODEL || process.env.DOUBAO_ARK_LLM_MODEL || process.env.DOUBAO_LLM_MODEL || '').trim()
    }
    const dnsRes = await dnsCheck(cfg.apiUrl)
    if (!keyPresent && !authHeaderPresent) return { ok: false, note: 'missing_key', dns: dnsRes, ...cfg }
    if (!deepText) return { ok: Boolean(dnsRes && dnsRes.ok), note: dnsRes.ok ? 'configured' : 'dns_failed', dns: dnsRes, ...cfg }
    try {
      const { parsed, meta } = await (await import('./ai/doubao.js')).generateStrictJsonViaDoubaoChat({
        instructions: '输出一个 JSON：{"ok":true}，只输出 JSON。',
        input: '请输出 {"ok":true}',
        model: cfg.model || undefined,
        apiUrl: cfg.apiUrl || undefined,
        proxyUrl: effective.network.proxyUrl,
        timeoutMs,
        maxRetries: 1,
        validate: (x) => Boolean(x && typeof x === 'object' && x.ok === true)
      })
      return { ok: Boolean(parsed && parsed.ok === true), note: 'verified', dns: dnsRes, meta, ...cfg }
    } catch (e) {
      return { ok: false, note: e && e.message ? String(e.message) : String(e), dns: dnsRes, ...cfg }
    }
  }

  async function diagnoseOllamaTextLocal(model, apiUrl) {
    const cfgModel = String(model || '').trim() || null
    const res = await diagnoseOllamaText({
      model: cfgModel || undefined,
      apiUrl: String(apiUrl || '').trim() || undefined,
      timeoutMs,
      proxyUrl: effective.network.proxyUrl,
      deepText
    })
    return res
  }

  async function diagnoseTranslationText({ provider, model, apiUrl, verify }) {
    const cfg = {
      provider: String(provider || '').trim().toLowerCase() || 'none',
      model: String(model || '').trim() || null,
      apiUrl: String(apiUrl || '').trim() || null
    }
    if (!cfg.provider || cfg.provider === 'none') {
      return { ok: false, note: 'provider_not_configured', ...cfg }
    }
    if (!verify) {
      if (isOpenAICompatibleProvider(cfg.provider)) {
        return await diagnoseOpenAI({
          timeoutMs,
          provider: cfg.provider,
          apiUrl: cfg.apiUrl,
          model: cfg.model,
          proxyUrl: effective.network.proxyUrl
        })
      }
      if (cfg.provider === 'doubao') return await diagnoseDoubaoText(cfg.model, cfg.apiUrl)
      if (cfg.provider === 'ollama') return await diagnoseOllamaTextLocal(cfg.model, cfg.apiUrl)
      return { ok: true, note: 'configured', ...cfg }
    }
    try {
      const { result, meta } = await translatePromptText({
        provider: cfg.provider,
        model: cfg.model || undefined,
        apiUrl: cfg.apiUrl || undefined,
        proxyUrl: effective.network.proxyUrl || undefined,
        timeoutMs,
        text: '红色苹果，白色背景，极简插画',
        sourceLang: 'zh',
        targetLang: 'en',
        mode: 'prompt'
      })
      return {
        ok: Boolean(result && String(result.translatedText || '').trim()),
        note: 'verified',
        result,
        meta,
        ...cfg
      }
    } catch (e) {
      const mapped = classifyAiError(e)
      return {
        ok: false,
        note: e && e.message ? String(e.message) : String(e),
        error: mapped,
        ...cfg
      }
    }
  }

  async function diagnoseDoubaoImages({ apiUrl, model }) {
    const keyPresent = Boolean(String(getStudioSecret('doubao') || process.env.DOUBAO_ARK_API_KEY || process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY || '').trim())
    const authHeaderPresent = Boolean(String(process.env.DOUBAO_ARK_AUTH_HEADER || process.env.DOUBAO_AUTH_HEADER || '').trim())
    const url = String(apiUrl || getDoubaoImagesConfigSnapshot().apiUrl || 'https://ark.cn-beijing.volces.com/api/v3/images/generations')
    const dnsRes = await dnsCheck(url)
    const cfg = { provider: 'doubao', api: 'images', apiUrl: url, model: model || null }
    if (!keyPresent && !authHeaderPresent) return { ok: false, note: 'missing_key', dns: dnsRes, ...cfg }
    if (!deepImages) return { ok: Boolean(dnsRes && dnsRes.ok), note: dnsRes.ok ? 'configured' : 'dns_failed', dns: dnsRes, ...cfg }
    try {
      const res = await (await import('./ai/doubao.js')).generateImageViaDoubaoArkImages({
        prompt: '一张极简风格的红色苹果，纯色背景，无文字',
        size: '1280x720',
        responseFormat: 'url',
        timeoutMs,
        proxyUrl: effective.network.proxyUrl,
        apiUrl: url,
        model: model || undefined
      })
      return { ok: Boolean(res && (res.url || res.bytes)), note: 'verified', dns: dnsRes, ...cfg }
    } catch (e) {
      return { ok: false, note: e && e.message ? String(e.message) : String(e), dns: dnsRes, ...cfg }
    }
  }

  const checkScripts = service === 'all' || service === 'scripts'
  const checkPrompt = service === 'all' || service === 'prompt'
  const checkTranslation = service === 'all' || service === 'translation'
  const checkImage = service === 'all' || service === 'image'

  if (checkScripts) {
    try {
      if (!effective.enabled.scripts) out.services.scripts = { ok: true, provider: effective.scripts.provider, model: effective.scripts.model, note: 'disabled' }
      else if (isOpenAICompatibleProvider(effective.scripts.provider)) out.services.scripts = await diagnoseOpenAI({ timeoutMs, provider: effective.scripts.provider, apiUrl: effective.scripts.apiUrl, model: effective.scripts.model, proxyUrl: effective.network.proxyUrl })
      else if (effective.scripts.provider === 'doubao') out.services.scripts = await diagnoseDoubaoText(effective.scripts.model, effective.scripts.apiUrl)
      else if (effective.scripts.provider === 'ollama') out.services.scripts = await diagnoseOllamaTextLocal(effective.scripts.model, effective.scripts.apiUrl)
      else out.services.scripts = { ok: true, provider: effective.scripts.provider, model: effective.scripts.model, note: 'local' }
    } catch (e) {
      out.services.scripts = { ok: false, provider: effective.scripts.provider, model: effective.scripts.model, note: e && e.message ? String(e.message) : String(e) }
    }
  }

  if (checkPrompt) {
    try {
      if (!effective.enabled.prompt) out.services.prompt = { ok: true, provider: effective.prompt.provider, model: effective.prompt.model, note: 'disabled' }
      else if (isOpenAICompatibleProvider(effective.prompt.provider)) out.services.prompt = await diagnoseOpenAI({ timeoutMs, provider: effective.prompt.provider, apiUrl: effective.prompt.apiUrl, model: effective.prompt.model, proxyUrl: effective.network.proxyUrl })
      else if (effective.prompt.provider === 'doubao') out.services.prompt = await diagnoseDoubaoText(effective.prompt.model, effective.prompt.apiUrl)
      else if (effective.prompt.provider === 'ollama') out.services.prompt = await diagnoseOllamaTextLocal(effective.prompt.model, effective.prompt.apiUrl)
      else out.services.prompt = { ok: true, provider: effective.prompt.provider, model: effective.prompt.model, note: 'local' }
    } catch (e) {
      out.services.prompt = { ok: false, provider: effective.prompt.provider, model: effective.prompt.model, note: e && e.message ? String(e.message) : String(e) }
    }
  }

  if (checkTranslation) {
    try {
      out.services.translation = await diagnoseTranslationText({
        provider: effective.translation?.provider,
        model: effective.translation?.model,
        apiUrl: effective.translation?.apiUrl,
        verify: service === 'translation' || deepText
      })
    } catch (e) {
      out.services.translation = { ok: false, provider: effective.translation?.provider || 'none', model: effective.translation?.model || null, note: e && e.message ? String(e.message) : String(e) }
    }
  }

  if (checkImage) {
    try {
      if (!effective.enabled.image) out.services.image = { ok: true, provider: effective.image.provider, model: effective.image.model, note: 'disabled' }
      else if (effective.image.provider === 'sdwebui') out.services.image = await diagnoseSdWebui(effective.image.sdwebuiBaseUrl, effective.image.model)
      else if (effective.image.provider === 'comfyui') out.services.image = await diagnoseComfyui(effective.image.comfyuiBaseUrl, effective.image.model)
      else if (effective.image.provider === 'doubao') out.services.image = await diagnoseDoubaoImages({ apiUrl: effective.image.apiUrl, model: effective.image.model })
      else out.services.image = { ok: false, provider: effective.image.provider, model: effective.image.model, note: 'unsupported_provider' }
    } catch (e) {
      out.services.image = { ok: false, provider: effective.image.provider, model: effective.image.model, note: e && e.message ? String(e.message) : String(e) }
    }
  }

  const okTargets = ['server']
  if (checkScripts) okTargets.push('scripts')
  if (checkPrompt) okTargets.push('prompt')
  if (checkTranslation) okTargets.push('translation')
  if (checkImage) okTargets.push('image')
  out.ok = okTargets.every((k) => out.services[k] && out.services[k].ok !== false)
  return c.json({ success: true, diagnostics: out })
})

app.get('/api/ai/rules', async (c) => {
  const rules = await readGlobalRules(ROOT)
  return c.json({ success: true, rules: rules || null })
})

app.put('/api/ai/rules', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const rulesIn = body?.rules
  const saved = await writeGlobalRules(ROOT, rulesIn)
  return c.json({ success: true, rules: saved })
})

app.post('/api/ai/prompt/review', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const prompt = String(body?.prompt || '').trim()
  const title = String(body?.title || '').trim()
  const formula = {
    choicePoints: clampInt(body?.choicePoints, 1, 3, 2),
    optionsPerChoice: Number(body?.optionsPerChoice) === 3 ? 3 : 2,
    endings: Number(body?.optionsPerChoice) === 3 ? 3 : 2
  }

  const localReview = reviewStoryPromptLocally({ prompt, title, formula })
  const studio = await getEffectiveStudioConfig(ROOT).catch(() => null)
  const provider = String(studio?.effective?.scripts?.provider || '').trim().toLowerCase()
  const model = studio?.effective?.scripts?.model || undefined
  const apiUrl = studio?.effective?.scripts?.apiUrl || undefined
  const proxyUrl = studio?.effective?.network?.proxyUrl || undefined

  let aiReview = {
    verdict: localReview.ok ? 'ok' : 'warn',
    summary: localReview.summary,
    strengths: (localReview.checks || []).filter((x) => x.ok).slice(0, 6).map((x) => String(x.message || '')),
    risks: (localReview.checks || []).filter((x) => !x.ok).slice(0, 8).map((x) => String(x.message || '')),
    suggestions: Array.isArray(localReview.suggestions) ? localReview.suggestions.slice(0, 8) : [],
    optimizedPrompt: String(localReview.optimizedPrompt || prompt || '').trim()
  }
  let meta = { provider: 'local', model: null, api: null, durationMs: 0, note: 'local_precheck_only' }
  let aiError = null

  try {
    if (provider && provider !== 'none') {
      const reviewed = await reviewStoryPromptWithAi({ prompt, provider, model, apiUrl, proxyUrl, formula })
      if (reviewed && reviewed.review) {
        aiReview = reviewed.review
        meta = reviewed.meta || meta
      }
    }
  } catch (e) {
    aiError = {
      message: e instanceof Error ? e.message : String(e),
      status: e && e.status ? Number(e.status) : null,
      code: e && e.code ? String(e.code) : null
    }
  }

  return c.json({
    success: true,
    review: {
      local: localReview,
      ai: aiReview,
      meta,
      aiError
    }
  })
})

app.post('/api/projects/:id/ai/storyboard/prompt-review', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const input = normalizeStoryboardPromptReviewInput(body)
  if (!String(input.projectTitle || '').trim()) {
    const project = await readProjectJson(id).catch(() => null)
    input.projectTitle = String(project && project.title ? project.title : '').trim()
  }

  const localReview = reviewStoryboardPromptLocally(input)
  const studio = await getEffectiveStudioConfig(ROOT).catch(() => null)
  const provider = String(studio?.effective?.prompt?.provider || '').trim().toLowerCase()
  const model = studio?.effective?.prompt?.model || undefined
  const apiUrl = studio?.effective?.prompt?.apiUrl || undefined
  const proxyUrl = studio?.effective?.network?.proxyUrl || undefined

  let aiReview = { ...localReview }
  let meta = { provider: 'local', model: null, api: null, durationMs: 0, note: 'local_precheck_only' }
  let aiError = null

  try {
    if (provider && provider !== 'none') {
      const reviewed = await reviewStoryboardPromptWithAi({ input, provider, model, apiUrl, proxyUrl })
      if (reviewed && reviewed.review) {
        aiReview = reviewed.review
        meta = reviewed.meta || meta
      }
    }
  } catch (e) {
    aiError = {
      message: e instanceof Error ? e.message : String(e),
      status: e && e.status ? Number(e.status) : null,
      code: e && e.code ? String(e.code) : null
    }
  }

  return c.json({
    success: true,
    review: {
      local: localReview,
      ai: aiReview,
      meta,
      aiError
    }
  })
})

app.get('/api/ai/prompt/templates', async (c) => {
  const items = await listPromptTemplates(ROOT)
  return c.json({ success: true, items })
})

app.post('/api/ai/prompt/templates/generate', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const title = String(body?.title || '').trim()
  if (!title) return c.json({ success: false, error: 'missing_title', message: '故事名称不能为空' }, 400)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.scripts) {
    return c.json({ success: false, error: 'disabled', message: '“写故事（脚本生成）”已在设置中关闭' }, 503)
  }
  const provider = String(studio.effective.scripts.provider || '').trim().toLowerCase()
  if (!provider || provider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“写故事脚本”并选择 Provider/Model' }, 400)
  }

  const formula = {
    choicePoints: clampInt(body?.choicePoints, 1, 3, 2),
    optionsPerChoice: Number(body?.optionsPerChoice) === 3 ? 3 : 2,
    endings: Number(body?.optionsPerChoice) === 3 ? 3 : 2
  }
  const generated = await generateStoryPromptTemplate({
    title,
    templateKey: String(body?.templateKey || '').trim(),
    templateName: String(body?.templateName || '').trim(),
    templateSummary: String(body?.templateSummary || '').trim(),
    fields: body?.fields && typeof body.fields === 'object' ? body.fields : {},
    formula,
    provider,
    model: studio.effective.scripts.model || undefined,
    apiUrl: studio.effective.scripts.apiUrl || undefined,
    proxyUrl: studio.effective.network.proxyUrl
  })

  const saved = await savePromptTemplate(ROOT, {
    title: generated.result?.title || title,
    templateKey: String(body?.templateKey || '').trim() || null,
    templateName: String(body?.templateName || '').trim() || null,
    templateSummary: String(body?.templateSummary || '').trim() || null,
    prompt: String(generated.result?.prompt || '').trim(),
    notes: Array.isArray(generated.result?.notes) ? generated.result.notes : [],
    fields: body?.fields && typeof body.fields === 'object' ? body.fields : {},
    formula,
    meta: generated.meta || null
  })

  return c.json({ success: true, item: saved, generated: generated.result, meta: generated.meta || null })
})

app.post('/api/ai/prompt/templates', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const prompt = String(body?.prompt || '').trim()
  const title = String(body?.title || '').trim()
  if (!prompt) return c.json({ success: false, error: 'missing_prompt', message: '提示词不能为空' }, 400)

  const formula = {
    choicePoints: clampInt(body?.choicePoints, 1, 3, 2),
    optionsPerChoice: Number(body?.optionsPerChoice) === 3 ? 3 : 2,
    endings: Number(body?.optionsPerChoice) === 3 ? 3 : 2
  }
  const saved = await savePromptTemplate(ROOT, {
    title: title || null,
    templateKey: String(body?.templateKey || '').trim() || null,
    templateName: String(body?.templateName || '').trim() || null,
    templateSummary: String(body?.templateSummary || '').trim() || null,
    prompt,
    notes: Array.isArray(body?.notes) ? body.notes.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8) : [],
    fields: body?.fields && typeof body.fields === 'object' ? body.fields : {},
    formula,
    meta: body?.meta && typeof body.meta === 'object' ? body.meta : null
  })
  return c.json({ success: true, item: saved })
})

app.delete('/api/ai/prompt/templates/:id', async (c) => {
  const id = String(c.req.param('id') || '').trim()
  if (!id) return c.json({ success: false, error: 'missing_id', message: '模板 ID 不能为空' }, 400)
  const result = await deletePromptTemplate(ROOT, id)
  return c.json({ success: true, removed: Boolean(result.removed), items: result.items || [] })
})

// ============ 公共提示词库（跨项目共享，storage/_config/prompt_library.json） ============
app.get('/api/ai/prompt-library', async (c) => {
  const entries = await listPromptLibraryEntries(ROOT)
  return c.json({ success: true, entries })
})

app.post('/api/ai/prompt-library', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  try {
    const entry = await addPromptLibraryEntry(ROOT, body)
    return c.json({ success: true, entry })
  } catch (e) {
    return c.json({ success: false, error: e instanceof Error ? e.message : String(e), message: '中文/英文提示词至少填一项' }, 400)
  }
})

app.put('/api/ai/prompt-library/:id', async (c) => {
  const id = String(c.req.param('id') || '').trim()
  const body = await c.req.json().catch(() => ({}))
  try {
    const entry = await updatePromptLibraryEntry(ROOT, id, body)
    if (!entry) return c.json({ success: false, error: 'not_found', message: '条目不存在' }, 404)
    return c.json({ success: true, entry })
  } catch (e) {
    return c.json({ success: false, error: e instanceof Error ? e.message : String(e) }, 400)
  }
})

app.delete('/api/ai/prompt-library/:id', async (c) => {
  const id = String(c.req.param('id') || '').trim()
  if (!id) return c.json({ success: false, error: 'missing_id', message: '条目 ID 不能为空' }, 400)
  const result = await deletePromptLibraryEntry(ROOT, id)
  return c.json({ success: true, removed: Boolean(result.removed), entries: result.entries || [] })
})

async function ensureDirs() {
  await mkdir(PROJECTS_DIR, { recursive: true })
  await mkdir(DEMO_LIBRARY_DIR, { recursive: true })
}

function projectDir(id) {
  return path.join(PROJECTS_DIR, String(id))
}

function projectBuildsDir(id) {
  return path.join(projectDir(id), 'builds')
}

function projectBuildDir(projectId, buildId) {
  return path.join(projectBuildsDir(projectId), String(buildId))
}

function projectStoryAssetsDir(id) {
  return path.join(projectDir(id), 'story-assets')
}

function projectStoryAssetsPlanPath(id) {
  return path.join(projectStoryAssetsDir(id), 'plan.json')
}

function demoLibDir(demoId) {
  return path.join(DEMO_LIBRARY_DIR, String(demoId))
}

async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf-8'))
}

async function probeHttpOk(url, timeoutMs = 3000) {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs || 3000)))
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)
    return res.ok
  } catch (_) {
    return false
  }
}

async function writeJson(p, obj) {
  await mkdir(path.dirname(p), { recursive: true })
  // 2026-08-29 修复：改为临时文件 + 原子重命名。原先直接覆写目标路径，
  // 并发写入（自动保存/批量任务/外部修补）会把两个版本拼接成坏档（实测 project.json 损毁、批量中断）。
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8')
  await rename(tmp, p)
}

async function readProjectBundle(id) {
  const dir = projectDir(id)
  const rawProject = await readJson(path.join(dir, 'project.json'))
  const story = await readJson(path.join(dir, 'story.json'))
  return {
    dir,
    rawProject,
    project: normalizeProjectDoc(rawProject),
    story
  }
}

function parseJsonObjectText(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (_) {
    return null
  }
}

function readStoryBibleFromProjectDoc(project) {
  const state = project && project.state && typeof project.state === 'object' ? project.state : {}
  const aiBg = state && state.aiBackground && typeof state.aiBackground === 'object' ? state.aiBackground : {}
  if (aiBg.storyBible && typeof aiBg.storyBible === 'object') return aiBg.storyBible
  return parseJsonObjectText(aiBg.storyBibleJson)
}

async function readStoryAssetPlanIfExists(id) {
  const planPath = projectStoryAssetsPlanPath(id)
  if (!(await existsFile(planPath))) return null
  try {
    const plan = await readJson(planPath)
    return plan && typeof plan === 'object' ? plan : null
  } catch (_) {
    return null
  }
}

// 2026-09-09 计划写盘竞态治理（实测事故：乌鸦喝水参考图生成期间，瓶子步骤的整计划回写把小石子
// 的 generatedRefs/latestReferenceBatch 反复冲掉，refs 读数在 0/4/8 间翻转，锁定门禁拿不到评审记录）。
// 两板斧：
// 1) 项目级写串行：同一 projectId 的 saveStoryAssetPlan 全部进入进程内 promise 链，写与写不再交错；
// 2) mergeAssetsById 合并写：保存时重读磁盘计划，按资产 id 合并（入站资产条目优先、磁盘独有条目保留），
//    解决"读-改-写"长窗口期内陈旧整计划覆盖他人新数据的问题（生成类写盘点启用；整计划重建/删除类不用）。
const storyAssetPlanWriteChains = new Map()

async function saveStoryAssetPlan(id, plan, options = {}) {
  const prev = storyAssetPlanWriteChains.get(id) || Promise.resolve()
  const run = prev.catch(() => {}).then(async () => {
    let nextPlan = plan
    if (options.mergeAssetsById) {
      const diskPlan = await readStoryAssetPlanIfExists(id).catch(() => null)
      if (diskPlan && Array.isArray(diskPlan.assets) && plan && Array.isArray(plan.assets)) {
        // 字段级合并（2026-09-09 二轮修正：纯按 id 合并仍会被"陈旧空字段"覆盖新数据——
        // 锁定测试携带锁前快照把 primaryReferenceAssetUri 清空回写。规则：
        // - 标量：入站非空覆盖，入站为空（null/''/undefined）保留磁盘值；
        // - 记录数组（generatedRefs/poseCandidates/poseVariants/latestReferenceBatch）：按唯一键并集去重，入站新记录追加、磁盘记录不丢；
        // - 其他数组以入站为准；磁盘独有条目/字段一律保留。
        const RECORD_ARRAY_KEYS = {
          generatedRefs: (x) => String(x && (x.projectAssetUri || x.assetPath) || ''),
          poseCandidates: (x) => String(x && x.assetPath || ''),
          poseVariants: (x) => String(x && x.id || ''),
          latestReferenceBatch: (x) => String(x && x.assetPath || '')
        }
        // 2026-09-12 终端字段保护（实测事故：编辑器陈旧整计划 persist 把已锁定/已出线稿的生产字段
        // 重置回 missing/空，出图总账回退）。protectTerminalFields 仅在编辑器手工保存通道开启：
        // 以下由生产流（锁定/线稿/姿势）写入的字段，磁盘非空时一律以磁盘为准，入站不得回退。
        const TERMINAL_ASSET_KEYS = new Set([
          'referenceStatus', 'primaryReferenceAssetId', 'primaryReferenceAssetUri', 'primaryReferenceSelectedAt',
          'latestReferenceBatch', 'latestRecommendedReferenceAssetUri', 'latestReferenceReview',
          'lineartHintAssetId', 'lineartHintAssetUri', 'lineartFinalAssetId', 'lineartFinalAssetUri',
          'lineartStatus', 'lineartPrompt', 'lineartNegativePrompt', 'lineartMeta', 'lineartGeneratedAt',
          'poseRequirements', 'poseDraft'
        ])
        const protectTerminal = options.protectTerminalFields === true
        const mergeAssetEntry = (diskEntry, incomingEntry) => {
          const disk = diskEntry && typeof diskEntry === 'object' ? diskEntry : {}
          const incoming = incomingEntry && typeof incomingEntry === 'object' ? incomingEntry : {}
          const merged = { ...disk }
          for (const [key, value] of Object.entries(incoming)) {
            if (protectTerminal && TERMINAL_ASSET_KEYS.has(key)) {
              const diskVal = disk[key]
              const diskNonEmpty = diskVal != null && diskVal !== '' && !(Array.isArray(diskVal) && !diskVal.length)
              if (diskNonEmpty) continue // 生产终态字段：磁盘为准，跳过入站回退
            }
            const keyOf = RECORD_ARRAY_KEYS[key]
            if (keyOf && Array.isArray(value)) {
              const diskArr = Array.isArray(disk[key]) ? disk[key] : []
              const seen = new Set(diskArr.map((x) => keyOf(x)).filter(Boolean))
              const appended = value.filter((x) => { const k = keyOf(x); return k && !seen.has(k) })
              if (appended.length || value.length) merged[key] = [...diskArr, ...appended]
              continue
            }
            const isEmpty = value == null || value === ''
            if (!isEmpty) merged[key] = value
          }
          return merged
        }
        const diskIds = new Set(diskPlan.assets.map((a) => String(a && a.id || '')))
        const incomingById = new Map(plan.assets.map((a) => [String(a && a.id || ''), a]))
        const mergedAssets = diskPlan.assets.map((da) => {
          const inc = incomingById.get(String(da && da.id || ''))
          return inc ? mergeAssetEntry(da, inc) : da
        })
        for (const a of plan.assets) {
          if (!diskIds.has(String(a && a.id || ''))) mergedAssets.push(a)
        }
        nextPlan = { ...diskPlan, ...plan, assets: mergedAssets }
      }
    }
    await snapshotCreationState(projectDir(id), { reason: 'plan_save' })
    await writeJson(projectStoryAssetsPlanPath(id), nextPlan)
    // 2026-08-30 修复：同步 project.json 的 aiBackground.storyAssetPlan 副本——编辑器部分读路径走 project.json，
    // 不同步会出现 plan.json 与编辑器看到的不一致（如人工补充的猪妈妈/工具包、repair-links 的场景关联丢失）。
    try {
      const dir = projectDir(id)
      const projectPath = path.join(dir, 'project.json')
      const projectDoc = await readJson(projectPath).catch(() => null)
      if (projectDoc && typeof projectDoc === 'object') {
        if (!projectDoc.state || typeof projectDoc.state !== 'object') projectDoc.state = {}
        if (!projectDoc.state.aiBackground || typeof projectDoc.state.aiBackground !== 'object') projectDoc.state.aiBackground = {}
        projectDoc.state.aiBackground.storyAssetPlan = nextPlan
        projectDoc.updatedAt = nowIso()
        projectDoc._rev = Number(projectDoc._rev || 0) + 1
        await writeJson(projectPath, projectDoc)
      }
    } catch (_) { /* 同步失败不阻断计划保存 */ }
  })
  storyAssetPlanWriteChains.set(id, run)
  return run
}

function storyAssetStr(v) {
  return typeof v === 'string' ? v : ''
}

function hasCjkText(v) {
  return /[\u3400-\u9fff]/.test(storyAssetStr(v))
}

function looksLikeEnglishPrompt(v) {
  const s = storyAssetStr(v).trim()
  if (!s) return false
  if (hasCjkText(s)) return false
  return /[A-Za-z]{3,}/.test(s)
}

function pickEnglishPrompt(candidate, ...fallbacks) {
  const preferred = storyAssetStr(candidate).trim()
  if (looksLikeEnglishPrompt(preferred)) return preferred
  for (const fallback of fallbacks) {
    const alt = storyAssetStr(fallback).trim()
    if (looksLikeEnglishPrompt(alt)) return alt
  }
  return preferred || storyAssetStr(fallbacks.find(Boolean)).trim()
}

function splitStoryAssetPromptParts(input) {
  return storyAssetStr(input)
    .split(/[,\n，、|]/g)
    .map((x) => x.trim())
    .filter(Boolean)
}

function uniqStoryAssetPromptParts(parts, max = 120) {
  const out = []
  const seen = new Set()
  for (const part of parts) {
    const value = storyAssetStr(part).trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= max) break
  }
  return out
}

function sanitizeStoryAssetPromptZh({ asset, promptZh }) {
  const category = storyAssetStr(asset && asset.category).trim().toLowerCase()
  const lockProfile = storyAssetStr(asset && asset.lockProfile).trim().toLowerCase()
  const raw = storyAssetStr(promptZh).trim()
  if (!raw) return ''
  const isPropLike = category === 'prop' || lockProfile.endsWith('_prop')
  if (!isPropLike) return raw
  const parts = splitStoryAssetPromptParts(raw)
  const out = []
  let seenRole = false
  let seenStructure = false
  for (const part of parts) {
    let value = storyAssetStr(part).trim()
    if (!value) continue
    if (/^(关联场景|常与这些元素同场)\s*[:：]/.test(value)) continue
    // 2026-10-07 提示词卫生：语境线标签前缀（叙事识别重点：/结构关注点：/故事职责：）是输入侧元信息，
    // AI 抄进正文会随翻译进入生图模型——剥前缀留内容（公主穿衣三资产实测）
    const hadStructure = /^结构关注点\s*[:：]/.test(value)
    const hadRole = /^故事职责\s*[:：]/.test(value)
    value = value.replace(/^(叙事识别重点|结构关注点|故事职责)\s*[:：]\s*/, '')
    if (!value) continue
    if (hadRole) {
      if (seenRole) continue
      seenRole = true
    }
    if (hadStructure) {
      if (seenStructure) continue
      seenStructure = true
    }
    out.push(value)
  }
  return uniqStoryAssetPromptParts(out, 64).join('，')
}

function limitStoryAssetText(v, max = 160) {
  const s = storyAssetStr(v).trim()
  if (!s) return ''
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trim()}…`
}

function findStoryAssetScenes(plan, asset) {
  const wantedIds = new Set((Array.isArray(asset && asset.sceneIds) ? asset.sceneIds : []).map((item) => storyAssetStr(item).trim()).filter(Boolean))
  const scenes = Array.isArray(plan && plan.scenes) ? plan.scenes : []
  if (!wantedIds.size) return []
  return scenes.filter((scene) => {
    const sceneId = storyAssetStr(scene && scene.sceneId).trim()
    const fallbackId = storyAssetStr(scene && scene.id).trim()
    const sourceKey = storyAssetStr(scene && scene.sourceKey).trim()
    return wantedIds.has(sceneId) || wantedIds.has(fallbackId) || wantedIds.has(sourceKey)
  })
}

function storyAssetSignalHay(asset) {
  return [
    storyAssetStr(asset && asset.name),
    storyAssetStr(asset && asset.anchorPrompt),
    ...(Array.isArray(asset && asset.aliases) ? asset.aliases : [])
  ].join(' ').toLowerCase()
}

function isStoryAssetBobberLike(asset) {
  return /\b(bobber|float|fishing float)\b|浮漂|漂子/.test(storyAssetSignalHay(asset))
}

function isStoryAssetRodLike(asset) {
  // 2026-10-07：裸 "pole" 过宽（衣架 alias "hanger pole" 串台成鱼竿，公主穿衣实测）——只认钓鱼语境词
  return /\b(bamboo fishing rod|bamboo rod|fishing rod|fishing pole)\b|竹鱼竿|鱼竿|竹竿/.test(storyAssetSignalHay(asset))
}

function isStoryAssetBucketLike(asset) {
  return /\b(bucket|pail)\b|鱼桶|木桶|水桶|桶/.test(storyAssetSignalHay(asset))
}

function isStoryAssetFishLike(asset) {
  return /\b(minnow|fish|silver fish)\b|小银鱼|小鱼|银鱼|鱼/.test(storyAssetSignalHay(asset))
}

function isStoryAssetButterflyLike(asset) {
  return /\b(butterfly|swallowtail)\b|蝴蝶|彩蝶/.test(storyAssetSignalHay(asset))
}

function buildStoryAssetUsageContext({ asset, plan }) {
  const name = storyAssetStr(asset && asset.name).trim()
  const aliases = uniqStoryAssetPromptParts(Array.isArray(asset && asset.aliases) ? asset.aliases : [], 12)
  const sceneEntries = findStoryAssetScenes(plan, asset)
  const eventChain = Array.isArray(plan && plan.eventChain) ? plan.eventChain : []
  const sceneNames = uniqStoryAssetPromptParts(sceneEntries.map((scene) => storyAssetStr(scene && scene.sceneName).trim()).filter(Boolean), 8)
  const sceneSummaries = uniqStoryAssetPromptParts(sceneEntries.map((scene) => storyAssetStr(scene && scene.summary).trim()).filter(Boolean), 8)
  const eventMentions = uniqStoryAssetPromptParts(sceneEntries.map((scene) => {
    const index = Number(scene && scene.sceneIndex)
    if (!Number.isFinite(index) || index <= 0) return ''
    return storyAssetStr(eventChain[index - 1]).trim()
  }).filter(Boolean), 8)
  const coAssetNames = uniqStoryAssetPromptParts(sceneEntries.flatMap((scene) => {
    const promptAssets = Array.isArray(scene && scene.promptAssets) ? scene.promptAssets : []
    return promptAssets
      .map((item) => storyAssetStr(item && item.name).trim())
      .filter((item) => item && item !== name && !aliases.includes(item))
  }), 12)
  const contextBlobZh = `${sceneSummaries.join('；')}；${sceneNames.join('；')}`
  const contextBlobEn = eventMentions.join(' ; ').toLowerCase()
  const roleHints = []
  if (/(背着|背在|背负|携带|随身|肩带)/.test(contextBlobZh) || /\b(back-carry|carrying|carry|carried)\b/.test(contextBlobEn)) {
    roleHints.push('是角色外出时会随身背携的道具')
  }
  if (/(装鱼|放进桶|放入桶|盛鱼|盛放|收纳)/.test(contextBlobZh) || /\b(place[ds]? into the bucket|fish is placed into the bucket|hold[s]? fish|carry small fish)\b/.test(contextBlobEn)) {
    roleHints.push('承担盛放钓到的小鱼或收纳渔获的剧情职责')
  }
  if (/(湖边|柳树|草地|水面|钓鱼|钓竿|浮漂)/.test(contextBlobZh) || /\b(lakeside|shore|lake|willow|water|fishing|rod|bobber)\b/.test(contextBlobEn)) {
    roleHints.push('属于乡村湖边垂钓语境中的朴素儿童道具')
  }
  if (/(回家|出发|回来|路上)/.test(contextBlobZh) || /\b(arrives?|walks home|path home|returns?)\b/.test(contextBlobEn)) {
    roleHints.push('会跟随角色往返场景，适合做成轻便耐用的小型随行物件')
  }
  const plotCueHints = []
  const fullNarrativeZh = `${sceneSummaries.join('；')}；${eventMentions.join('；')}`
  const signalText = `${storyAssetStr(asset && asset.anchorPrompt)} ${storyAssetStr(asset && asset.name)} ${(Array.isArray(asset && asset.aliases) ? asset.aliases.join(' ') : '')}`.toLowerCase()
  if (/(盯着|观察|看着|等待|远远看|远看|一眼认出|watch|waiting|watching|visible from afar|recognize at a glance)/i.test(`${fullNarrativeZh} ${contextBlobEn}`)) {
    plotCueHints.push('在中远景里也要一眼认出主要色块和外轮廓')
  }
  if (/(摇晃|晃动|下沉|浮在水面|浮起来|watch the bobber|bobber|tremble|sinks?|upright on calm water)/i.test(`${fullNarrativeZh} ${signalText} ${contextBlobEn}`)) {
    plotCueHints.push('要清楚表现直立浮姿、上下配色分区和远看可辨的顶端标记')
  }
  if (/(提着|背着|挂着|拿着|带着|系在|shoulder|carry|carried|hang|hung|held|tied to)/i.test(`${fullNarrativeZh} ${signalText} ${contextBlobEn}`)) {
    plotCueHints.push('连接点、提握点、挂点或绑缚点要清楚')
  }
  if (/(装进|放入|收纳|盛放|开口|容量|placed into|put into|holds?|contain|storage)/i.test(`${fullNarrativeZh} ${signalText} ${contextBlobEn}`)) {
    plotCueHints.push('开口、内部容积或收纳方式要明确')
  }
  if (/(戴着|戴上|佩戴|wearing|worn)/i.test(`${fullNarrativeZh} ${signalText} ${contextBlobEn}`)) {
    plotCueHints.push('虽然会被佩戴使用，但锁定图必须保留独立物件的开口和内侧结构')
  }
  const structureHints = []
  if (/(肩带|strap)/i.test(`${storyAssetStr(asset && asset.anchorPrompt)} ${contextBlobZh} ${contextBlobEn}`)) structureHints.push('肩带连接方式要清楚')
  if (/(提梁|提手|bail|handle)/i.test(`${storyAssetStr(asset && asset.anchorPrompt)} ${contextBlobZh} ${contextBlobEn}`)) structureHints.push('提梁和挂点结构要可读')
  if (/(开口|装鱼|盛放|bucket|pail|桶)/i.test(`${storyAssetStr(asset && asset.anchorPrompt)} ${contextBlobZh} ${contextBlobEn}`)) structureHints.push('开口、桶沿和内部容量感要明确')
  if (/(木|wood|woven|staves|iron band|金属箍|箍)/i.test(`${storyAssetStr(asset && asset.anchorPrompt)} ${contextBlobZh} ${contextBlobEn}`)) structureHints.push('材质分区和连接关系要稳定')

  if (isStoryAssetBucketLike(asset)) {
    roleHints.length = 0
    plotCueHints.length = 0
    structureHints.length = 0
    roleHints.push('是角色外出时会随身背携的小鱼桶')
    roleHints.push('承担盛放钓到的小鱼或临时收纳渔获的剧情职责')
    roleHints.push('属于乡村湖边垂钓语境中的朴素儿童道具')
    plotCueHints.push('在中远景里也要一眼认出桶身轮廓、提梁和肩带连接点')
    plotCueHints.push('要清楚表现开口、桶沿和内部容量感，避免被画成封闭盒子或普通花盆')
    structureHints.push('肩带连接方式要清楚')
    structureHints.push('提梁和挂点结构要可读')
    structureHints.push('开口、桶沿和内部容量感要明确')
    structureHints.push('材质分区和连接关系要稳定')
  } else if (isStoryAssetRodLike(asset)) {
    roleHints.length = 0
    plotCueHints.length = 0
    structureHints.length = 0
    roleHints.push('是角色在湖边垂钓时使用的单根竹制鱼竿')
    roleHints.push('承担抛线、等待、提竿和收鱼这些关键动作的剧情职责')
    roleHints.push('属于乡村湖边垂钓语境中的朴素儿童渔具')
    plotCueHints.push('在中远景里也要一眼认出细长竹竿轮廓和竹节分段')
    plotCueHints.push('要清楚表现无渔轮单竿、竿梢绑线点、末端细线与小钩')
    structureHints.push('竹节分段和由粗到细的渐细关系要清楚')
    structureHints.push('竿梢绑线点、细线和小钩结构要明确')
    structureHints.push('必须保持完整全长，不能裁切两端，不能透视缩短')
  } else if (isStoryAssetBobberLike(asset)) {
    roleHints.length = 0
    plotCueHints.length = 0
    structureHints.length = 0
    roleHints.push('是钓线末端用来观察鱼讯的小型浮漂')
    roleHints.push('承担轻微晃动、直立漂浮和突然下沉这些关键剧情提示职责')
    roleHints.push('属于乡村湖边垂钓语境中的朴素儿童渔具')
    plotCueHints.push('在中远景里也要一眼认出红白配色、葫芦形轮廓和顶部标记')
    plotCueHints.push('要清楚表现直立浮姿、细黑中心针和上下两个小环')
    structureHints.push('红上白下的配色分区要明确')
    structureHints.push('葫芦形软木本体、细黑中心针和上下小环都要完整可读')
    structureHints.push('必须是独立单个浮漂，不连水面、不连人物、不连整根鱼线场景')
  } else if (isStoryAssetFishLike(asset)) {
    roleHints.length = 0
    plotCueHints.length = 0
    structureHints.length = 0
    roleHints.push('是故事里最终钓上来的小型银色小鱼')
    roleHints.push('承担“提竿成功、收获成果、放进鱼桶”这些关键剧情结果展示职责')
    roleHints.push('属于乡村湖边垂钓语境中的朴素自然小鱼，不是观赏鱼或大型鱼类')
    plotCueHints.push('在中近景里要一眼认出银色细长鱼身、叉形尾和小黑眼')
    plotCueHints.push('要清楚表现纺锤形身体轮廓、反光鳞片和简洁小鳍，不要夸张卡通表情')
    structureHints.push('细长纺锤形身体、叉形尾和小黑珠眼要完整可读')
    structureHints.push('背鳍、胸鳍和腹部轮廓要简洁明确')
    structureHints.push('必须是单条独立小鱼，不连钓钩、桶、手、角色或水面环境')
  } else if (isStoryAssetButterflyLike(asset)) {
    roleHints.length = 0
    plotCueHints.length = 0
    structureHints.length = 0
    roleHints.push('是故事里吸引角色分心、飞向野花丛的彩色蝴蝶')
    roleHints.push('承担“短暂停落、绕飞、引向花丛”这些关键剧情触发职责')
    roleHints.push('属于乡村湖边春日环境中的轻盈自然昆虫，不是飞蛾、蜻蜓或小鸟')
    plotCueHints.push('在中近景里要一眼认出鲜艳多彩双翅、黑色翅脉和细长触角')
    plotCueHints.push('要清楚表现停落或展翅时的蝴蝶轮廓，不要被画成鱼、叶子或标本针插展示')
    structureHints.push('左右双翅外轮廓、翅脉分区和尾突形态要明确')
    structureHints.push('细长身体、成对触角和翅膀配色层次要完整可读')
    structureHints.push('必须是单只独立蝴蝶，不连花枝、不连人物、不连场景底座')
  }

  const roleLineZh = roleHints.length ? limitStoryAssetText(`故事职责：${roleHints.join('；')}`, 220) : ''
  const sceneLineZh = sceneNames.length ? limitStoryAssetText(`关联场景：${sceneNames.join('、')}`, 120) : ''
  const coAssetLineZh = coAssetNames.length ? limitStoryAssetText(`常与这些元素同场：${coAssetNames.join('、')}，但它们只用于校准身份，不要画进单资产参考图`, 180) : ''
  const structureLineZh = structureHints.length ? limitStoryAssetText(`结构关注点：${structureHints.join('；')}`, 160) : ''
  const plotCueLineZh = plotCueHints.length ? limitStoryAssetText(`叙事识别重点：${plotCueHints.join('；')}`, 180) : ''

  return {
    sceneNames,
    sceneSummaries,
    eventMentions,
    coAssetNames,
    roleHints,
    plotCueHints,
    structureHints,
    roleLineZh,
    plotCueLineZh,
    sceneLineZh,
    coAssetLineZh,
    structureLineZh
  }
}

function sanitizeProtectedAssetPrompt({ asset, promptEn, negativePrompt }) {
  const lockProfile = storyAssetStr(asset && asset.lockProfile).trim().toLowerCase()
  const lockWorkflow = storyAssetStr(asset && asset.lockWorkflow).trim().toLowerCase()
  const protectedProfiles = new Set(['wearable_prop', 'slender_prop', 'rigid_prop', 'soft_prop', 'ambient_prop', 'organic_prop'])
  const rawPositive = storyAssetStr(promptEn).trim()
  const rawNegative = storyAssetStr(negativePrompt).trim()
  if (!protectedProfiles.has(lockProfile)) {
    return { promptEn: rawPositive, negativePrompt: rawNegative }
  }
  const bannedPositive = [
    /\bchildren'?s?\b/i, /\bchild\b/i, /\bgirl\b/i, /\bboy\b/i, /\bkid\b/i, /\bwoman\b/i, /\bman\b/i,
    /\bportrait\b/i, /\bupper body\b/i, /\bhalf[-\s]?length\b/i, /\bface\b/i, /\bhead\b/i, /\bmodel\b/i,
    /\bwearing\b/i, /\bworn\b/i, /\bon (?:a|the) head\b/i, /\bunder chin\b/i, /\boutfit\b/i, /\bdress\b/i,
    /\bshirt\b/i, /\bskirt\b/i, /\bbook illustration style\b/i, /\bstorybook\b/i, /\bfashion editorial\b/i
  ]
  const positiveParts = splitStoryAssetPromptParts(rawPositive).filter((part) => !bannedPositive.some((re) => re.test(part)))
  const safePositive = uniqStoryAssetPromptParts(positiveParts, 80).join(', ')
  const extraNegative = lockProfile === 'wearable_prop'
    ? ['person', 'girl', 'boy', 'child', 'portrait', 'head', 'face', 'upper body', 'model', 'wearing display', 'worn on head', 'mannequin', 'hair', 'scalp', 'ears']
    : ['person', 'portrait', 'character', 'environment']
  if (lockWorkflow === 'prop_hat') {
    extraNegative.push('woman', 'female body', 'shoulders', 'collarbone', 'neckline', 'bust', 'statue', 'sculpture', 'figurine', 'pedestal', 'display base')
  }
  return {
    promptEn: safePositive,
    negativePrompt: uniqStoryAssetPromptParts([...splitStoryAssetPromptParts(rawNegative), ...extraNegative], 120).join(', ')
  }
}

function normalizeStoryAssetUri(raw) {
  return storyAssetStr(raw).trim().replace(/\\/g, '/').replace(/^\/+/, '')
}

function storyAssetCategoryFolder(category) {
  const value = storyAssetStr(category).trim().toLowerCase()
  if (value === 'character' || value === 'prop' || value === 'location') return value
  return 'asset'
}

function storyAssetSlug(asset) {
  const raw = storyAssetStr(asset && asset.id).trim() || storyAssetStr(asset && asset.name).trim() || 'asset'
  return raw
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'asset'
}

function getStoryAssetTimeZone() {
  return storyAssetStr(process.env.STUDIO_ASSET_TIMEZONE).trim() || 'Asia/Shanghai'
}

function getDatePartsForStoryAssets(date = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: getStoryAssetTimeZone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })
    const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]))
    return {
      year: storyAssetStr(parts.year).trim() || String(date.getFullYear()),
      month: storyAssetStr(parts.month).trim() || String(date.getMonth() + 1).padStart(2, '0'),
      day: storyAssetStr(parts.day).trim() || String(date.getDate()).padStart(2, '0'),
      hour: storyAssetStr(parts.hour).trim() || String(date.getHours()).padStart(2, '0'),
      minute: storyAssetStr(parts.minute).trim() || String(date.getMinutes()).padStart(2, '0'),
      second: storyAssetStr(parts.second).trim() || String(date.getSeconds()).padStart(2, '0')
    }
  } catch (_) {
    const iso = new Date(date.getTime() - (date.getTimezoneOffset() * 60_000)).toISOString()
    return {
      year: iso.slice(0, 4),
      month: iso.slice(5, 7),
      day: iso.slice(8, 10),
      hour: iso.slice(11, 13),
      minute: iso.slice(14, 16),
      second: iso.slice(17, 19)
    }
  }
}

function getStoryAssetDateFolder(date = new Date()) {
  const parts = getDatePartsForStoryAssets(date)
  return `${parts.year}-${parts.month}-${parts.day}`
}

function getStoryAssetTimestampToken(date = new Date()) {
  const parts = getDatePartsForStoryAssets(date)
  return `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}${parts.second}`
}

function buildStoryAssetStorageInfo(asset, date = new Date()) {
  const category = storyAssetCategoryFolder(asset && asset.category)
  const slug = storyAssetSlug(asset)
  const dateFolder = getStoryAssetDateFolder(date)
  const relDir = path.join('assets', 'ai', 'story_assets', category, slug, dateFolder)
  return { category, slug, dateFolder, relDir }
}

function buildStoryAssetFileTarget({ dir, asset, prefix, ext, seed, date = new Date() }) {
  const storage = buildStoryAssetStorageInfo(asset, date)
  const safeExt = storyAssetStr(ext).replace(/[^a-z0-9]+/gi, '') || 'png'
  const stamp = getStoryAssetTimestampToken(date)
  const safePrefix = storyAssetStr(prefix).trim().replace(/[^a-z0-9_.-]+/gi, '_') || 'asset'
  const seedPart = Number.isFinite(Number(seed)) ? `_seed_${Math.max(0, Math.floor(Number(seed)))}` : ''
  const filename = `${safePrefix}${seedPart}_${stamp}.${safeExt}`
  return {
    ...storage,
    filename,
    outDir: path.join(dir, storage.relDir),
    absPath: path.join(dir, storage.relDir, filename),
    assetPath: `${storage.relDir}/${filename}`.replace(/\\/g, '/')
  }
}

function buildStoryAssetComfyPrefix(asset, variant, date = new Date()) {
  const storage = buildStoryAssetStorageInfo(asset, date)
  const safeVariant = storyAssetStr(variant).trim().replace(/[^a-z0-9_.-]+/gi, '_') || 'asset'
  return path.posix.join('gamestudio_story_lock', storage.dateFolder, storage.category, storage.slug, safeVariant)
}

function getManagedStoryAssetPrefixes(asset) {
  const category = storyAssetCategoryFolder(asset && asset.category)
  const slug = storyAssetSlug(asset)
  return {
    current: `assets/ai/story_assets/${category}/${slug}/`,
    legacyRefs: `assets/ai/story_assets/${slug}_`,
    legacyLineart: `assets/ai/story_lineart/${slug}_`,
    legacyLineartDir: `assets/ai/story_lineart/${category}/${slug}/`
  }
}

function isManagedStoryAssetPathForAsset(asset, rawPath) {
  const uri = normalizeStoryAssetUri(rawPath)
  if (!uri) return false
  const prefixes = getManagedStoryAssetPrefixes(asset)
  if (
    uri.startsWith(prefixes.current) ||
    uri.startsWith(prefixes.legacyRefs) ||
    uri.startsWith(prefixes.legacyLineart) ||
    uri.startsWith(prefixes.legacyLineartDir)
  ) return true
  // 2026-09-16 姿势/状态变体图（assets/ai/characters 共享目录）按变体记录归属纳入图库管理
  for (const v of (Array.isArray(asset && asset.poseVariants) ? asset.poseVariants : [])) {
    if (uri === normalizeStoryAssetUri(v && v.cutoutPath) || uri === normalizeStoryAssetUri(v && v.greenPath)) return true
  }
  for (const v of (Array.isArray(asset && asset.stateVariants) ? asset.stateVariants : [])) {
    if (uri === normalizeStoryAssetUri(v && v.cutoutPath) || uri === normalizeStoryAssetUri(v && v.greenPath)) return true
  }
  return false
}

function labelForStoryAssetGalleryKind(kind) {
  if (kind === 'reference') return '参考图'
  if (kind === 'selected_white_bg') return '主参考立绘'
  if (kind === 'lineart_hint') return '线稿 Hint'
  if (kind === 'lineart_final') return '线稿成品'
  if (kind === 'pose_variant') return '姿势立绘'
  if (kind === 'pose_variant_green') return '姿势绿幕'
  if (kind === 'state_variant') return '状态立绘'
  if (kind === 'state_variant_green') return '状态绿幕'
  return '图片'
}

function inferStoryAssetGalleryKind({ uri, ref, asset }) {
  const normalized = normalizeStoryAssetUri(uri)
  if (!normalized) return 'unknown'
  if (normalized === normalizeStoryAssetUri(asset && asset.lineartHintAssetUri)) return 'lineart_hint'
  if (normalized === normalizeStoryAssetUri(asset && asset.lineartFinalAssetUri)) return 'lineart_final'
  // 2026-09-16 姿势/状态变体：以变体记录的 green/cutout 判定（先于 postprocess/文件名启发式）
  for (const v of (Array.isArray(asset && asset.poseVariants) ? asset.poseVariants : [])) {
    if (normalized === normalizeStoryAssetUri(v && v.cutoutPath)) return 'pose_variant'
    if (normalized === normalizeStoryAssetUri(v && v.greenPath)) return 'pose_variant_green'
  }
  for (const v of (Array.isArray(asset && asset.stateVariants) ? asset.stateVariants : [])) {
    if (normalized === normalizeStoryAssetUri(v && v.cutoutPath)) return 'state_variant'
    if (normalized === normalizeStoryAssetUri(v && v.greenPath)) return 'state_variant_green'
  }
  // 选定主参考（抠图立绘）：历史白底 rmbg_white_bg 与现行透明 rmbg_alpha 共用同一 gallery 类别
  const refPostprocess = storyAssetStr(ref && ref.postprocess).trim()
  if (refPostprocess === 'rmbg_white_bg' || refPostprocess === 'rmbg_alpha') return 'selected_white_bg'
  const base = path.basename(normalized).toLowerCase()
  if (base.includes('selected_white') || base.includes('selected_cutout')) return 'selected_white_bg'
  if (base.includes('lineart_hint') || base.includes('_hint_')) return 'lineart_hint'
  if (base.includes('lineart_final') || base.includes('_lineart_') || base.includes('_final_')) return 'lineart_final'
  return 'reference'
}

function storyAssetCreatedAtFallback(uri) {
  const normalized = normalizeStoryAssetUri(uri)
  const match = normalized.match(/(20\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/)
  if (!match) return ''
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`
}

function buildStoryAssetGalleryEntries({ projectId, project, plan, asset }) {
  const projectAssets = Array.isArray(project && project.assets) ? project.assets : []
  const projectAssetByUri = new Map()
  for (const item of projectAssets) {
    const uri = normalizeStoryAssetUri(item && item.uri)
    if (uri) projectAssetByUri.set(uri, item)
  }
  const generatedRefs = Array.isArray(asset && asset.generatedRefs) ? asset.generatedRefs : []
  const latestBatch = Array.isArray(asset && asset.latestReferenceBatch) ? asset.latestReferenceBatch : []
  const refByUri = new Map()
  for (const ref of generatedRefs) {
    const uri = normalizeStoryAssetUri(ref && ref.projectAssetUri)
    if (uri) refByUri.set(uri, ref)
  }
  const batchByUri = new Map()
  for (const item of latestBatch) {
    const uri = normalizeStoryAssetUri(item && item.assetPath)
    if (uri) batchByUri.set(uri, item)
  }
  const seen = new Set()
  const rows = []
  const candidateUris = new Set()
  for (const ref of generatedRefs) {
    const uri = normalizeStoryAssetUri(ref && ref.projectAssetUri)
    if (uri) candidateUris.add(uri)
  }
  for (const item of latestBatch) {
    const uri = normalizeStoryAssetUri(item && item.assetPath)
    if (uri) candidateUris.add(uri)
  }
  for (const projectAsset of projectAssets) {
    const uri = normalizeStoryAssetUri(projectAsset && projectAsset.uri)
    if (uri && isManagedStoryAssetPathForAsset(asset, uri)) candidateUris.add(uri)
  }
  const specialUris = [
    normalizeStoryAssetUri(asset && asset.primaryReferenceAssetUri),
    normalizeStoryAssetUri(asset && asset.lineartHintAssetUri),
    normalizeStoryAssetUri(asset && asset.lineartFinalAssetUri)
  ].filter(Boolean)
  for (const uri of specialUris) candidateUris.add(uri)
  // 2026-09-16 姿势/状态变体图纳入图库（绿幕+立绘），按变体记录补充元数据
  const variantByUri = new Map()
  for (const v of (Array.isArray(asset && asset.poseVariants) ? asset.poseVariants : [])) {
    for (const [field, kind] of [['greenPath', 'green'], ['cutoutPath', 'cutout']]) {
      const uri = normalizeStoryAssetUri(v && v[field])
      if (uri) {
        candidateUris.add(uri)
        variantByUri.set(uri, { variantId: v.id, variantName: v.name, score: v.score, composite: v.composite, part: kind })
      }
    }
  }
  for (const v of (Array.isArray(asset && asset.stateVariants) ? asset.stateVariants : [])) {
    for (const [field, kind] of [['greenPath', 'green'], ['cutoutPath', 'cutout']]) {
      const uri = normalizeStoryAssetUri(v && v[field])
      if (uri) {
        candidateUris.add(uri)
        variantByUri.set(uri, { variantId: v.id, variantName: v.name, score: v.score, composite: v.composite, part: kind })
      }
    }
  }

  for (const uri of candidateUris) {
    if (!uri || !isManagedStoryAssetPathForAsset(asset, uri) || seen.has(uri)) continue
    seen.add(uri)
    const ref = refByUri.get(uri) || null
    const batch = batchByUri.get(uri) || null
    const projectAsset = projectAssetByUri.get(uri) || null
    const variantMeta = variantByUri.get(uri) || null
    const kind = inferStoryAssetGalleryKind({ uri, ref, asset })
    const analysis = batch && batch.analysis && typeof batch.analysis === 'object'
      ? batch.analysis
      : (normalizeStoryAssetUri(asset && asset.primaryReferenceAssetUri) === uri && asset && asset.latestReferenceReview && typeof asset.latestReferenceReview === 'object'
        ? asset.latestReferenceReview
        : null)
    const createdAt = storyAssetStr(ref && ref.createdAt).trim() || storyAssetCreatedAtFallback(uri)
    const refSeedValue = ref && typeof ref === 'object' ? ref.seed : undefined
    const projectAssetSource = projectAsset && projectAsset.source && typeof projectAsset.source === 'object'
      ? projectAsset.source
      : null
    const projectAssetSeedValue = projectAssetSource ? projectAssetSource.seed : undefined
    rows.push({
      assetPath: uri,
      url: `/project-assets/${encodeURIComponent(String(projectId || ''))}/${uri}`,
      kind,
      label: labelForStoryAssetGalleryKind(kind),
      createdAt: createdAt || undefined,
      seed: Number.isFinite(Number(refSeedValue)) ? Number(refSeedValue) : (Number.isFinite(Number(projectAssetSeedValue)) ? Number(projectAssetSeedValue) : undefined),
      provider: storyAssetStr(ref && ref.provider).trim() || storyAssetStr(projectAssetSource && projectAssetSource.provider).trim() || undefined,
      prompt: storyAssetStr(ref && ref.prompt).trim() || storyAssetStr(projectAssetSource && projectAssetSource.prompt).trim() || undefined,
      negativePrompt: storyAssetStr(ref && ref.negativePrompt).trim() || storyAssetStr(projectAssetSource && projectAssetSource.negativePrompt).trim() || undefined,
      isPrimary: normalizeStoryAssetUri(asset && asset.primaryReferenceAssetUri) === uri,
      isCurrentLineart: (
        normalizeStoryAssetUri(asset && asset.lineartHintAssetUri) === uri ||
        normalizeStoryAssetUri(asset && asset.lineartFinalAssetUri) === uri
      ),
      recommended: Boolean(
        normalizeStoryAssetUri(asset && asset.latestRecommendedReferenceAssetUri) === uri ||
        (batch && batch.recommended)
      ),
      inLatestBatch: batchByUri.has(uri),
      ...(variantMeta ? {
        variantId: variantMeta.variantId,
        variantName: variantMeta.variantName,
        variantScore: Number.isFinite(Number(variantMeta.score)) ? Number(variantMeta.score) : undefined,
        variantComposite: variantMeta.composite || undefined,
        variantPart: variantMeta.part
      } : {}),
      analysis
    })
  }
  rows.sort((a, b) => {
    const priorityA = a.isPrimary ? 30 : (a.isCurrentLineart ? 20 : 0)
    const priorityB = b.isPrimary ? 30 : (b.isCurrentLineart ? 20 : 0)
    if (priorityA !== priorityB) return priorityB - priorityA
    const timeA = Date.parse(String(a.createdAt || ''))
    const timeB = Date.parse(String(b.createdAt || ''))
    if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) return timeB - timeA
    return String(a.assetPath || '').localeCompare(String(b.assetPath || ''))
  })
  return rows
}

async function pruneMissingStoryAssetGalleryEntries({ id, dir, plan, asset }) {
  let currentPlan = plan
  let currentAsset = asset
  let currentProject = null
  let items = []

  while (true) {
    const bundle = await readProjectBundle(id)
    currentProject = normalizeProjectDoc(bundle.rawProject)
    items = buildStoryAssetGalleryEntries({ projectId: id, project: currentProject, plan: currentPlan, asset: currentAsset })
    const missing = []
    for (const item of items) {
      const uri = normalizeStoryAssetUri(item && item.assetPath)
      if (!uri) continue
      const abs = path.join(dir, uri)
      if (!(await existsFile(abs))) missing.push(uri)
    }
    if (!missing.length) break
    for (const missingUri of missing) {
      const liveAsset = (Array.isArray(currentPlan && currentPlan.assets)
        ? currentPlan.assets.find((entry) => storyAssetStr(entry && entry.id).trim() === storyAssetStr(currentAsset && currentAsset.id).trim())
        : null) || currentAsset
      const cleaned = await deleteStoryAssetManagedFile({
        id,
        dir,
        plan: currentPlan,
        asset: liveAsset,
        targetAssetPath: missingUri
      })
      currentPlan = cleaned.plan
      currentAsset = cleaned.asset
    }
  }

  return {
    plan: currentPlan,
    asset: currentAsset,
    project: currentProject,
    items
  }
}

function buildStoryAssetPromptEnhancement({ asset, plan, globalPromptZh, globalNegativePromptZh, currentPromptZh, currentPromptEn, currentNegativePromptZh, currentNegativePrompt }) {
  const category = storyAssetStr(asset && asset.category).trim()
  const lockProfile = storyAssetStr(asset && asset.lockProfile).trim()
  const name = storyAssetStr(asset && asset.name).trim() || '当前资产'
  const anchor = storyAssetStr(asset && asset.anchorPrompt).trim()
  const hint = storyAssetStr(asset && asset.referencePromptHint).trim()
  const zhBase = sanitizeStoryAssetPromptZh({ asset, promptZh: currentPromptZh })
  const enBase = storyAssetStr(currentPromptEn).trim()
  const zhNegBase = storyAssetStr(currentNegativePromptZh).trim()
  const enNegBase = storyAssetStr(currentNegativePrompt).trim()
  const worldAnchor = storyAssetStr(plan && plan.worldAnchor).trim()
  const globalZh = storyAssetStr(globalPromptZh).trim()
  const globalNegZh = storyAssetStr(globalNegativePromptZh).trim()
  const usageContext = buildStoryAssetUsageContext({ asset, plan })
  const usageLines = [
    usageContext.roleLineZh,
    usageContext.plotCueLineZh,
    usageContext.structureLineZh
  ].filter(Boolean)
  const propExclusionNames = usageContext.coAssetNames.slice(0, 8)

  let promptZh = ''
  if (zhBase && category === 'prop') {
    promptZh = uniqStoryAssetPromptParts([
      ...splitStoryAssetPromptParts(zhBase),
      ...usageLines,
      '仅画物件本身',
      '纯白背景',
      '不把共现角色或地点画进去'
    ], 32).join('，')
  } else if (zhBase) {
    promptZh = zhBase
  }
  if (!promptZh) {
    if (lockProfile === 'character_core' || category === 'character') {
      promptZh = [
        `${name}角色参考表，单主体，全身，正面站姿，居中构图`,
        '纯白无缝背景，无地面线，无投影，无场景环境',
        '双手自然下垂且空手，不拿任何道具，不戴帽子',
        '重点锁定脸型、耳朵、眼睛颜色、毛色花纹、服装版型、腰带、鞋子和整体比例',
        '卡通童话绘本风格，扁平 2D 卡通插画，粗净轮廓线，赛璐璐上色，配色温暖柔和，不能画成真人小孩或拟人猫娘，不能写实'
      ].join('，')
    } else if (lockProfile === 'wearable_prop') {
      promptZh = [
        `${name}道具设计图，单一物件，居中展示，仅画物件本身`,
        usageLines.join('，'),
        '纯白背景，无手持，无人物，无头部，无模特，无佩戴展示，无场景，无头模',
        '清楚表现材质、结构、尺寸比例、开口、边缘轮廓和独立摆放关系',
        '强调这是可穿戴但未佩戴的独立物件，必要时开口或内部结构可见',
        '卡通童话绘本风格设计参考插画，扁平 2D 卡通，粗净轮廓线，便于后续连续场景复用'
      ].filter(Boolean).join('，')
    } else if (lockProfile === 'slender_prop') {
      promptZh = [
        `${name}细长道具锁定图，单一物件，完整显示全长，居中展示`,
        usageLines.join('，'),
        '纯白背景，无人物，无手持，无场景，不允许两端裁切，不允许透视缩短',
        '清楚表现长度比例、端头结构、孔位或节点细节，轮廓笔直可读',
        '卡通童话绘本风格设计参考图，扁平 2D 卡通，粗净轮廓线，便于后续连续场景复用'
      ].filter(Boolean).join('，')
    } else if (lockProfile === 'rigid_prop') {
      promptZh = [
        `${name}硬结构道具参考图，单一物件，稳定透视，居中展示，仅画物件本身`,
        usageLines.join('，'),
        '纯白背景，无人物，无场景，无额外杂物，不把共现角色或地点画进去',
        '清楚表现主要结构部件、体块关系、材质和比例，不能塌陷变形',
        '卡通童话绘本风格设计参考插画，扁平 2D 卡通，粗净轮廓线，便于后续连续场景复用'
      ].filter(Boolean).join('，')
    } else if (lockProfile === 'ambient_prop') {
      promptZh = [
        `${name}氛围元素参考图，单一元素，居中展示`,
        usageContext.sceneLineZh,
        '干净浅色背景，不要整张大场景，不要地平线，不要树木建筑人物',
        '清楚表现该元素自身轮廓、体积和内部层次，便于在不同场景中稳定复用',
        '卡通童话绘本风格参考插画，扁平 2D 卡通，粗净轮廓线，便于后续连续场景复用'
      ].filter(Boolean).join('，')
    } else if (lockProfile === 'organic_prop') {
      if (isStoryAssetButterflyLike(asset)) {
        promptZh = [
          `${name}昆虫参考图，单一物件，居中展示，仅画物件本身`,
          usageLines.join('，'),
          '纯白背景，无人物，无手持，无场景，无花枝，无草地，无栖息地，不把共现角色或地点画进去',
          '清楚表现左右双翅轮廓、翅脉、尾突、细长身体、成对触角和配色分区',
          '必须是单只独立蝴蝶，不要飞蛾，不要蜻蜓，不要小鸟，不要昆虫标本针插展示',
          '卡通童话绘本风格设计参考图，扁平 2D 卡通，粗净轮廓线，便于后续连续场景复用'
        ].filter(Boolean).join('，')
      } else {
        promptZh = [
          `${name}自然标本道具锁定图，单一物件，居中展示，仅画物件本身`,
          usageLines.join('，'),
          '纯白背景，无人物，无手持，无场景，无水面，无栖息地，不把共现角色或地点画进去',
          '清楚表现整体轮廓、头尾比例、眼睛、鳍、表面纹理和尺寸关系',
          '必须是单个自然标本或单个小鱼，不要夸张表情，不要观赏鱼摆拍，不要生态展示缸',
          '卡通童话绘本风格设计参考图，扁平 2D 卡通，粗净轮廓线，便于后续连续场景复用'
        ].filter(Boolean).join('，')
      }
    } else if (category === 'prop') {
      promptZh = [
        `${name}道具设计图，单一物件，居中展示，仅画物件本身`,
        usageLines.join('，'),
        '纯白背景，无手持，无人物，无头部，无模特，无佩戴展示，无场景，不把共现角色或地点画进去',
        '清楚表现材质、结构、尺寸比例、开口、边缘轮廓和正反面造型关系',
        '卡通童话绘本风格设计参考插画，扁平 2D 卡通，粗净轮廓线，便于后续连续场景复用'
      ].filter(Boolean).join('，')
    } else {
      promptZh = [
        `${name}地点参考图，稳定构图，统一环境语言`,
        '突出建筑、地形、植被、水体和光线关系',
        // 2026-08-28：H5 文本叠加在场景图上，下部留安静区保证可读
        '画面下部约三分之一保持低细节低对比的安静区域，便于 H5 文本叠加阅读',
        '卡通童话绘本风格，扁平 2D 卡通插画，适合作为连续场景统一地点锚点'
      ].join('，')
    }
  }

  const fallbackPromptEn = buildStoryAssetReferencePrompt({
    plan,
    asset,
    style: 'picture_book',
    globalPrompt: category === 'location' ? worldAnchor : '',
    assetPrompt: hint
  })
  let promptEn = pickEnglishPrompt(enBase, storyAssetStr(asset && asset.referencePromptEn).trim(), hint, fallbackPromptEn)

  const summary = (lockProfile === 'character_core' || category === 'character')
    ? `已强化为角色锁定参考图提示词：去掉场景环境与道具干扰，保留白底、正面全身、空手和外观锁定。`
    : category === 'prop'
      ? `已强化为道具锁定参考图提示词：补入故事职责、结构关注点和共现场景约束，同时保持单物件白底。`
      : `已强化为地点锁定提示词：突出环境构图和统一世界观。`

  // 2026-08-26 去跨故事污染：角色默认反向词删掉钓鱼故事专属的"鱼竿/水桶/水面/桥"，保持故事中立
  // 2026-08-29 统一画风负向：全类别追加反写实排除（用户指令：杜绝写实/卡通混杂）
  const antiRealismZh = '写实，照片级真实，3D渲染，CGI，油画，厚涂，超写实，摄影感'
  const defaultNegativePromptZh = (
    category === 'character'
      ? `多人，多主体，人物脸，真人小孩，拟人猫娘，帽子，场景背景，树木，草地，侧面，背面，三分之二侧面，投影，地面线，文字，水印，${antiRealismZh}`
      : category === 'prop'
        ? ['人物', '角色', '儿童', '女孩', '男孩', '头部', '脸部', '半身像', '上半身', '手持', '佩戴展示', '戴在头上', '模特', '人体穿戴关系', '场景背景', '树木', '草地', '水面', '文字', '水印', '写实', '照片级真实', '3D渲染', 'CGI', '油画', '厚涂', '超写实', '摄影感', ...propExclusionNames].join('，')
        : `人物特写，人群，文字，水印，${antiRealismZh}`
  )
  const negativePromptZh = (
    zhNegBase && category === 'prop'
      ? uniqStoryAssetPromptParts([
        ...splitStoryAssetPromptParts(zhNegBase),
        ...propExclusionNames
      ], 40).join('，')
      : zhNegBase
  ) || defaultNegativePromptZh

  return {
    promptZh,
    promptEn,
    negativePromptZh,
    negativePrompt: enNegBase || buildStoryAssetReferenceNegativePrompt({
      plan,
      asset,
      globalNegativePrompt: globalNegZh
    }),
    summary,
    context: {
      anchor,
      hint,
      worldAnchor,
      globalPromptZh: globalZh,
      usageContext
    }
  }
}

function scoreStoryAssetPromptCandidate({ asset, promptZh, promptEn, negativePromptZh, negativePrompt, context }) {
  const name = storyAssetStr(asset && asset.name).trim()
  const category = storyAssetStr(asset && asset.category).trim().toLowerCase()
  const lockProfile = storyAssetStr(asset && asset.lockProfile).trim().toLowerCase()
  const promptZhText = storyAssetStr(promptZh).trim()
  const promptEnText = storyAssetStr(promptEn).trim()
  const negZhText = storyAssetStr(negativePromptZh).trim()
  const negEnText = storyAssetStr(negativePrompt).trim()
  const combinedZh = `${promptZhText}，${negZhText}`
  const combinedEn = `${promptEnText}, ${negEnText}`.toLowerCase()
  const strengths = []
  const risks = []
  const suggestions = []
  let score = 0

  const hasPositive = Boolean(promptZhText || promptEnText)
  const hasNegative = Boolean(negZhText || negEnText)
  if (hasPositive) {
    score += 12
    strengths.push('已生成正向提示词。')
  } else {
    risks.push('缺少正向提示词。')
    suggestions.push('必须先明确这个事物是什么，再补白底和单物件约束。')
  }
  if (hasNegative) {
    score += 8
    strengths.push('已生成负向提示词。')
  } else {
    risks.push('缺少负向提示词。')
    suggestions.push('补齐容易混淆的替代物、人物、场景和多物件排除项。')
  }

  // 2026-10-07 单物件约束同义词拓宽：AI 常写"单独悬挂/单件展示/单物展示"而非白名单原词（白裙、全身镜实测漏分）
  if (/(单一物件|仅画物件本身|单独(一|的|悬挂|展示|呈现)?|单件|单物|独件|独立物件|单个|仅一件|仅展示|single object|isolated object|exactly one object|single item|one object only)/i.test(`${promptZhText} ${promptEnText}`)) {
    score += 8
    strengths.push('单物件约束明确。')
  } else if (category === 'prop') {
    risks.push('单物件约束不足。')
    suggestions.push('明确写“单一物件、仅画物件本身、不要重复件”。')
  }

  if (/(纯白背景|白底|pure white background)/i.test(`${promptZhText} ${promptEnText}`)) {
    score += 6
    strengths.push('白底参考图约束明确。')
  } else if (category === 'prop' || category === 'character') {
    risks.push('白底参考图约束不足。')
    suggestions.push('补充纯白背景/无场景背景约束，避免混入故事场景。')
  }

  if (/(无人物|无人|no person|no character|no portrait|无手持|no hand|无场景|no environment)/i.test(`${combinedZh} ${combinedEn}`)) {
    score += 8
    strengths.push('人物和场景排除项明确。')
  } else if (category === 'prop') {
    risks.push('人物/场景排除项不足。')
    suggestions.push('补充无人物、无手持、无场景、无环境杂项。')
  }

  // 2026-10-07：三条语境线（故事职责/叙事识别重点/结构关注点）词表全部来自道具语境，
  // 角色提示词永远命中不了——角色跳过道具语境块，走下方专属评分线（公主穿衣 34 分误报根修）
  if (category !== 'character' && context && typeof context === 'object') {
    const roleLineZh = storyAssetStr(context.roleLineZh).trim()
    const plotCueLineZh = storyAssetStr(context.plotCueLineZh).trim()
    const structureLineZh = storyAssetStr(context.structureLineZh).trim()
    if (roleLineZh && containsStoryAssetMeaning(promptZhText, roleLineZh)) {
      score += 10
      strengths.push('提示词吸收了故事职责。')
    } else if (roleLineZh) {
      risks.push('提示词没有明显吸收故事职责。')
      suggestions.push('让提示词体现它在故事里的用途，而不是只剩通用商品图模板。')
    }
    if (plotCueLineZh && containsStoryAssetMeaning(promptZhText, plotCueLineZh)) {
      score += 10
      strengths.push('提示词体现了全文叙事识别重点。')
    } else if (plotCueLineZh) {
      risks.push('提示词没有体现全文情节里的识别重点。')
      suggestions.push('把“远看可辨、浮姿/下沉、连接点、开口/容积”等叙事识别点写进正向词。')
    }
    if (structureLineZh && containsStoryAssetMeaning(promptZhText, structureLineZh)) {
      score += 10
      strengths.push('提示词体现了结构关注点。')
    } else if (structureLineZh) {
      risks.push('提示词缺少结构关注点。')
      suggestions.push('把关键结构部位、连接关系、端头/孔位/节点写清楚。')
    }
  }

  // 2026-10-07 角色评分公平性根修：上面三条语境线的词表全部来自道具语境（浮漂/连接点/开口容积），
  // 角色提示词永远命中不了——角色被钉死在 34 分基线并误报"推倒重生"（公主穿衣佳佳/艾莉实测）。
  // 角色改走专属评分线：身份特征吸收 / 参考图构图约束 / 神态可读性。
  if (category === 'character') {
    // 角色语境线不适用道具词表——补偿分：角色专属三条线（各 10 分，对齐道具的 30 分语境权重）
    const anchorText = storyAssetStr(asset && asset.anchorPrompt)
    const featureTokens = (anchorText.match(/[一-鿿]{2,8}/g) || [])
      .filter((t) => !/^(的|了|与|和|或在|是|有|无|不|单一|纯白|背景|居中|全身|正面|站姿|角色|年轻|一个)/.test(t))
      .slice(0, 12)
    const nameTokens = [name, ...(Array.isArray(asset && asset.aliases) ? asset.aliases : [])]
      .map((x) => storyAssetStr(x).trim())
      .filter((t) => t.length >= 2)
    const identityHits = [...nameTokens, ...featureTokens].filter((t) => promptZhText.includes(t) || combinedEn.includes(t.toLowerCase()))
    if (identityHits.length >= 2) {
      score += 10
      strengths.push('提示词吸收了角色身份特征。')
    } else {
      risks.push('提示词缺少角色身份特征（名字/发型/服装等锚点词）。')
      suggestions.push('把角色的发型、服装、体型等身份锚点特征写进正向词。')
    }
    const frameText = `${promptZhText} ${promptEnText}`
    if (/(全身|full.?body|head to toe)/i.test(frameText) && /(正面|front)/i.test(frameText) && /(单[一个两]?[角色人]|single character|one character|居中)/i.test(frameText)) {
      score += 10
      strengths.push('全身正面单角色构图约束明确。')
    } else {
      risks.push('参考图构图约束不足（全身/正面/单角色）。')
      suggestions.push('补充"全身、正面、单角色、居中、纯白背景"的参考图构图约束。')
    }
    if (/(表情|神态|微笑|开朗|温柔|灵动|眼神|气质)/.test(promptZhText) || /(expression|smile|gentle|cheerful|demeanor)/i.test(promptEnText)) {
      score += 10
      strengths.push('神态/气质可读性约束明确。')
    } else {
      risks.push('缺少神态/气质约束（角色表情是锁定身份的一部分）。')
      suggestions.push('补充角色的神态或气质关键词（如 友好开朗/温柔/眼神灵动）。')
    }
  }

  const forbidden = Array.isArray(asset && asset.forbiddenSubstitutes) ? asset.forbiddenSubstitutes.map((x) => storyAssetStr(x).trim()).filter(Boolean) : []
  const forbiddenMentioned = forbidden.filter((item) => combinedZh.includes(item) || combinedEn.includes(item.toLowerCase()))
  if (forbiddenMentioned.length) {
    score += Math.min(12, forbiddenMentioned.length * 3)
    strengths.push(`已排除 ${forbiddenMentioned.length} 个已知易混替代物。`)
  } else if (forbidden.length) {
    risks.push('未明显排除已知易混替代物。')
    suggestions.push(`至少补进这些高风险替代项：${forbidden.slice(0, 4).join('、')}。`)
  }

  if (lockProfile === 'slender_prop' && /(完整显示全长|full length|end to end|两端|孔位|节点|foreshortening|透视缩短)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)) {
    score += 10
    strengths.push('细长道具的长度与端头约束明确。')
  } else if (lockProfile === 'slender_prop') {
    risks.push('细长道具缺少全长/端头/孔位约束。')
    suggestions.push('补充“完整显示全长、两端不可裁切、孔位或节点清楚、避免透视缩短”。')
  }

  const signalText = [name, storyAssetStr(asset && asset.anchorPrompt), ...(Array.isArray(asset && asset.aliases) ? asset.aliases : [])].join(' ').toLowerCase()
  if (/\b(bobber|float)\b|浮漂|漂子/.test(signalText)) {
    const bobberSignals = /(红白|红色.*白色|red-and-white|gourd|葫芦|cork|软木|center pin|中心针|eyelet|小环)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    const badSignals = /(glass|玻璃|aquarium|rectangular box|box|beaker|plastic ball bobber|clip-on|slot|side slit|透明中段|球形)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    if (bobberSignals) {
      score += 14
      strengths.push('已经钉住浮漂的关键身份特征。')
    } else {
      score -= 18
      risks.push('还没有把“红白葫芦形软木漂、中心针、上下小环”钉死。')
      suggestions.push('明确写红上白下、葫芦形软木本体、细黑中心针、顶部和底部小环。')
    }
    if (badSignals) {
      score -= 18
      risks.push('提示词里仍保留会把浮漂引向玻璃盒、球漂或夹扣漂的风险。')
    }
    if (/(鱼竿|竹鱼竿|bucket|pail|开口|容积|肩带|提梁|bamboo rod|handle|strap)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)) {
      score -= 24
      risks.push('浮漂提示词混入了鱼竿/桶类结构语义。')
      suggestions.push('浮漂只能保留红白葫芦形、中心针、上下小环和独立单物件约束。')
    }
  }

  if (/\b(minnow|fish|silver fish)\b|小银鱼|银鱼/.test(signalText)) {
    const fishSignals = /(银色|silver|细长|纺锤|torpedo|叉形尾|forked tail|鳞片|scales|黑珠眼|bead eye|小鳍|fin)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    const badFishSignals = /(开口|容积|桶沿|肩带|提梁|bucket|pail|strap|handle|佩戴|模特|wearing|portrait|human|手持|钓竿|鱼竿|hooked on line|aquarium|fish tank|观赏鱼|goldfish|koi|carp|trout|crab)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    if (fishSignals) {
      score += 14
      strengths.push('已经钉住小银鱼的关键形体特征。')
    } else {
      score -= 18
      risks.push('还没有把“小型银色鱼身、叉形尾、鳞片、小黑眼”钉死。')
      suggestions.push('明确写细长银色小鱼、纺锤形身体、叉形尾、反光鳞片和小黑珠眼。')
    }
    if (badFishSignals) {
      score -= 24
      risks.push('小银鱼提示词混入了鱼桶/人物/钓具/观赏鱼语义。')
      suggestions.push('小银鱼只能保留单条自然小鱼的身体结构，不要写开口、容积、佩戴、手持、鱼竿或观赏鱼场景。')
    }
  }

  if (/\b(butterfly|swallowtail)\b|蝴蝶|彩蝶/.test(signalText)) {
    const butterflySignals = /(蝴蝶|butterfly|swallowtail|双翅|wings|翅脉|veins|触角|antennae|尾突|彩色|cyan|magenta|yellow)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    const badButterflySignals = /(鱼|小鱼|minnow|fish|叉形尾|forked tail|鳍|fin|水面|aquarium|标本针|specimen pin|蜻蜓|dragonfly|飞蛾|moth|bird|小鸟)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    if (butterflySignals) {
      score += 14
      strengths.push('已经钉住蝴蝶的关键形体特征。')
    } else {
      score -= 18
      risks.push('还没有把“彩色双翅、黑色翅脉、细长触角、蝴蝶轮廓”钉死。')
      suggestions.push('明确写单只彩色蝴蝶、双翅轮廓、黑色翅脉、细长触角和轻盈昆虫姿态。')
    }
    if (badButterflySignals) {
      score -= 24
      risks.push('蝴蝶提示词混入了小鱼/标本针/飞蛾/蜻蜓等错误语义。')
      suggestions.push('蝴蝶只能保留双翅、翅脉、触角和配色，不要写鱼身、鱼鳍、水面、标本针或其它昆虫。')
    }
  }

  // 2026-10-07：裸 pole 串台修复（与 isStoryAssetRodLike 同步）——衣架"hanger pole"不再命中鱼竿分支
  if (/\b(bamboo fishing rod|bamboo rod|fishing rod|fishing pole)\b|竹鱼竿|鱼竿|竹竿/.test(signalText)) {
    const rodSignals = /(竹节|竹制|bamboo|nodes?|竿梢|tip|no reel|无渔轮|棉线|cotton line|hook|鱼钩)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    const badRodSignals = /(开口|容积|桶沿|肩带|提梁|bucket|pail|strap|handle|红白|葫芦|bobber|float|center pin|eyelet)/i.test(`${promptZhText} ${promptEnText} ${combinedZh} ${combinedEn}`)
    if (rodSignals) {
      score += 14
      strengths.push('已经钉住竹鱼竿的关键身份特征。')
    } else {
      score -= 18
      risks.push('还没有把“竹节、无渔轮、竿梢绑线点、末端细线和小钩”钉死。')
      suggestions.push('明确写单根竹制鱼竿、清楚竹节、无渔轮、竿梢绑线、末端细线与小钩。')
    }
    if (badRodSignals) {
      score -= 24
      risks.push('竹鱼竿提示词混入了鱼桶/浮漂类结构语义。')
      suggestions.push('竹鱼竿只能保留全长、竹节、绑线点、细线和小钩，不要写开口、容积、红白配色或浮姿。')
    }
  }

  if (/(关联场景[:：]|常与这些元素同场[:：])/.test(promptZhText)) {
    score -= 20
    risks.push('正向词仍混入关联场景/共现元素文本。')
    suggestions.push('不要把“关联场景”原样写进正向词，只把它转成结构和识别要求。')
  }

  // 2026-10-07 否定盲修复：先剥掉"无/不含/没有/不出现/禁止 X"否定片段再测危险词——
  // 否则"无任何人物，模特或衣架出现"这类正确排除句被误判为混入人物语义（公主穿衣白裙 29 分实测）
  const promptZhPositiveOnly = promptZhText.replace(/(无任何|无|没有|不含|不包括|不出现|禁止|不要|避免|排除|去除)[^，。；,;、]{0,20}/g, '，')
  const dangerousHumanCue =
    /(女孩|男孩|头部|脸部|模特|佩戴展示|戴在头上|girl|boy|portrait|wearing|worn on head|model)/i.test(promptZhPositiveOnly)
  const explicitPersonCue =
    /(人物|角色)/.test(promptZhPositiveOnly) &&
    !/(无人物|无人|非人物|不出现人物|仅画物件本身|无角色|不出现角色)/.test(promptZhPositiveOnly)
  const childCue =
    /儿童/.test(promptZhPositiveOnly) &&
    !/(儿童道具|儿童故事|儿童绘本|storybook|picture book)/i.test(promptZhPositiveOnly)
  if ((dangerousHumanCue || explicitPersonCue || childCue) && category === 'prop') {
    score -= 18
    risks.push('道具正向词混入人物/佩戴展示语义。')
    suggestions.push('道具锁定词必须是独立物件，不要出现人物、佩戴、模特或头部。')
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const passed = score >= 50
  const summary = passed
    ? `提示词评分 ${score}/100，已达到保留阈值。`
    : `提示词评分 ${score}/100，低于保留阈值，需要推倒重生。`
  return {
    passed,
    score,
    summary,
    strengths: uniqStoryAssetPromptParts(strengths, 8),
    risks: uniqStoryAssetPromptParts(risks, 10),
    suggestions: uniqStoryAssetPromptParts(suggestions, 8)
  }
}

function containsStoryAssetMeaning(promptZh, ruleLineZh) {
  const promptParts = splitStoryAssetPromptParts(promptZh)
  const ruleParts = splitStoryAssetPromptParts(ruleLineZh.replace(/^[^:：]+[:：]\s*/, ''))
  if (!promptParts.length || !ruleParts.length) return false
  const promptText = promptParts.join('，')
  return ruleParts.some((part) => {
    const needle = storyAssetStr(part).trim()
    return needle && (promptText.includes(needle) || promptText.includes(needle.replace(/[；。]/g, '')))
  })
}

async function translateStoryAssetPromptPair({ studio, promptZh, negativePromptZh, fallbackPromptEn, fallbackNegativePrompt, timeoutMs = 60_000 }) {
  const translationCfg = studio?.effective?.translation || {}
  const promptCfg = studio?.effective?.prompt || {}
  const providers = [
    {
      provider: storyAssetStr(translationCfg.provider).trim().toLowerCase(),
      model: translationCfg.model || undefined,
      apiUrl: translationCfg.apiUrl || undefined,
      note: null
    },
    {
      provider: storyAssetStr(promptCfg.provider).trim().toLowerCase(),
      model: promptCfg.model || undefined,
      apiUrl: promptCfg.apiUrl || undefined,
      note: 'translation_fallback_to_prompt_provider'
    }
  ].filter((item, index, list) => item.provider && item.provider !== 'none' && list.findIndex((entry) => entry.provider === item.provider && String(entry.apiUrl || '') === String(item.apiUrl || '')) === index)

  if (!providers.length) {
    return {
      promptEn: storyAssetStr(fallbackPromptEn).trim(),
      negativePrompt: storyAssetStr(fallbackNegativePrompt).trim(),
      meta: { provider: 'fallback', model: null, api: null, note: 'translation_provider_missing' }
    }
  }
  const proxyUrl = studio?.effective?.network?.proxyUrl || undefined
  let promptRes = null
  let negativeRes = null
  let providerMeta = null
  let lastError = null
  for (const candidate of providers) {
    try {
      // 2026-08-26 修复：串行执行两次翻译；本地 27B 并发 prefill 会把 KV 峰值翻倍，实测触发 oMLX 内存护栏
      promptRes = await translatePromptText({
        provider: candidate.provider,
        model: candidate.model,
        apiUrl: candidate.apiUrl,
        proxyUrl,
        timeoutMs,
        text: storyAssetStr(promptZh).trim(),
        sourceLang: 'zh',
        targetLang: 'en',
        mode: 'prompt'
      })
      negativeRes = await translatePromptText({
        provider: candidate.provider,
        model: candidate.model,
        apiUrl: candidate.apiUrl,
        proxyUrl,
        timeoutMs,
        text: storyAssetStr(negativePromptZh).trim(),
        sourceLang: 'zh',
        targetLang: 'en',
        mode: 'prompt'
      })
      providerMeta = {
        provider: promptRes?.meta?.provider || candidate.provider,
        model: promptRes?.meta?.model || candidate.model || null,
        api: promptRes?.meta?.api || candidate.apiUrl || null,
        note: candidate.note
      }
      break
    } catch (e) {
      lastError = e
    }
  }
  if (!promptRes || !negativeRes) throw lastError || new Error('translation_failed')
  return {
    promptEn: pickEnglishPrompt(storyAssetStr(promptRes?.result?.translatedText).trim(), fallbackPromptEn),
    negativePrompt: storyAssetStr(negativeRes?.result?.translatedText).trim() || storyAssetStr(fallbackNegativePrompt).trim(),
    meta: providerMeta || null
  }
}

async function cleanupEmptyStoryAssetDirs(startDir, stopDir) {
  const stop = path.resolve(stopDir)
  let current = path.resolve(startDir)
  while (current.startsWith(stop) && current !== stop) {
    const items = await readdir(current).catch(() => null)
    if (!Array.isArray(items) || items.length > 0) break
    await rm(current, { recursive: true, force: true }).catch(() => null)
    current = path.dirname(current)
  }
}

async function deleteStoryAssetManagedFile({ id, dir, plan, asset, targetAssetPath }) {
  const targetUri = normalizeStoryAssetUri(targetAssetPath)
  if (!targetUri) {
    const e = new Error('missing_asset_path')
    e.status = 400
    throw e
  }
  if (!isManagedStoryAssetPathForAsset(asset, targetUri)) {
    const e = new Error('story_asset_delete_forbidden')
    e.status = 403
    throw e
  }

  const bundle = await readProjectBundle(id)
  const projectAssets = Array.isArray(bundle.rawProject && bundle.rawProject.assets) ? bundle.rawProject.assets : []
  const removedProjectAssets = projectAssets.filter((item) => normalizeStoryAssetUri(item && item.uri) === targetUri)
  const removedProjectAssetIds = new Set(removedProjectAssets.map((item) => storyAssetStr(item && item.id).trim()).filter(Boolean))

  // 2026-09-16 摆位引用守卫：图被 story.json 任一摆位引用时禁止删除（与场景图 bound_image 同款语义，防画布白洞）
  if (removedProjectAssetIds.size) {
    const storyDoc = bundle.story && typeof bundle.story === 'object' ? bundle.story : null
    const boundHit = (Array.isArray(storyDoc && storyDoc.nodes) ? storyDoc.nodes : []).find((node) =>
      (Array.isArray(node && node.visuals && node.visuals.placements) ? node.visuals.placements : [])
        .some((p) => removedProjectAssetIds.has(storyAssetStr(p && p.imageAssetId).trim()))
    )
    if (boundHit) {
      const e = new Error(`该图片正被场景「${storyAssetStr(boundHit.name || boundHit.id) || '未命名'}」的摆位引用，请先在合成层解除摆位后再删除`)
      e.code = 'bound_image'
      e.status = 409
      throw e
    }
  }

  const abs = path.join(dir, targetUri)
  await rm(abs, { force: true }).catch(() => null)
  await cleanupEmptyStoryAssetDirs(path.dirname(abs), path.join(dir, 'assets', 'ai'))

  const nextProject = {
    ...bundle.rawProject,
    assets: projectAssets.filter((item) => normalizeStoryAssetUri(item && item.uri) !== targetUri),
    characters: Array.isArray(bundle.rawProject && bundle.rawProject.characters)
      ? bundle.rawProject.characters.map((ch) => {
          const refId = storyAssetStr(ch && ch.ai && ch.ai.referenceAssetId).trim()
          if (!refId || !removedProjectAssetIds.has(refId)) return ch
          return {
            ...ch,
            ai: {
              ...((ch && ch.ai && typeof ch.ai === 'object') ? ch.ai : {}),
              referenceAssetId: ''
            }
          }
        })
      : bundle.rawProject.characters,
    updatedAt: new Date().toISOString()
  }
  await writeJson(path.join(dir, 'project.json'), nextProject)

  const deletingPrimary = normalizeStoryAssetUri(asset && asset.primaryReferenceAssetUri) === targetUri
  const deletingHint = normalizeStoryAssetUri(asset && asset.lineartHintAssetUri) === targetUri
  const deletingFinal = normalizeStoryAssetUri(asset && asset.lineartFinalAssetUri) === targetUri
  const nextPlan = {
    ...plan,
    generatedAt: new Date().toISOString(),
    assets: Array.isArray(plan && plan.assets) ? plan.assets.map((item) => {
      if (storyAssetStr(item && item.id).trim() !== storyAssetStr(asset && asset.id).trim()) return item
      const nextGeneratedRefs = Array.isArray(item && item.generatedRefs)
        ? item.generatedRefs.filter((ref) => normalizeStoryAssetUri(ref && ref.projectAssetUri) !== targetUri)
        : []
      const nextBatch = Array.isArray(item && item.latestReferenceBatch)
        ? item.latestReferenceBatch.filter((entry) => normalizeStoryAssetUri(entry && entry.assetPath) !== targetUri)
        : []
      // 2026-09-16 姿势/状态变体记录联动：立绘被删整条移除；仅绿幕被删则清空 greenPath 保留变体
      const cleanVariants = (variants) => Array.isArray(variants)
        ? variants
            .filter((v) => normalizeStoryAssetUri(v && v.cutoutPath) !== targetUri)
            .map((v) => (normalizeStoryAssetUri(v && v.greenPath) === targetUri ? { ...v, greenPath: '' } : v))
        : variants
      const nextPoseVariants = cleanVariants(item && item.poseVariants)
      const nextStateVariants = cleanVariants(item && item.stateVariants)
      const primaryReferenceAssetUri = deletingPrimary ? '' : storyAssetStr(item && item.primaryReferenceAssetUri).trim()
      const primaryReferenceAssetId = deletingPrimary ? '' : storyAssetStr(item && item.primaryReferenceAssetId).trim()
      const lineartHintAssetUri = deletingHint || deletingPrimary ? '' : storyAssetStr(item && item.lineartHintAssetUri).trim()
      const lineartHintAssetId = deletingHint || deletingPrimary ? '' : storyAssetStr(item && item.lineartHintAssetId).trim()
      const lineartFinalAssetUri = deletingFinal || deletingPrimary ? '' : storyAssetStr(item && item.lineartFinalAssetUri).trim()
      const lineartFinalAssetId = deletingFinal || deletingPrimary ? '' : storyAssetStr(item && item.lineartFinalAssetId).trim()
      const lineartReady = Boolean(lineartHintAssetUri && lineartFinalAssetUri)
      let referenceStatus = primaryReferenceAssetUri ? 'ready' : (nextBatch.length || nextGeneratedRefs.length ? 'candidates_ready' : 'missing')
      if (!primaryReferenceAssetUri && storyAssetStr(item && item.renderStrategy).trim() === 'prompt_only') referenceStatus = 'missing'
      return {
        ...item,
        generatedRefs: nextGeneratedRefs,
        latestReferenceBatch: nextBatch,
        ...(Array.isArray(nextPoseVariants) ? { poseVariants: nextPoseVariants } : {}),
        ...(Array.isArray(nextStateVariants) ? { stateVariants: nextStateVariants } : {}),
        latestRecommendedReferenceAssetUri: normalizeStoryAssetUri(item && item.latestRecommendedReferenceAssetUri) === targetUri
          ? ''
          : storyAssetStr(item && item.latestRecommendedReferenceAssetUri).trim(),
        primaryReferenceAssetUri,
        primaryReferenceAssetId,
        primaryReferenceSelectedAt: primaryReferenceAssetUri ? storyAssetStr(item && item.primaryReferenceSelectedAt).trim() : '',
        latestReferenceReview: (
          item && item.latestReferenceReview && typeof item.latestReferenceReview === 'object' &&
          normalizeStoryAssetUri(item.latestReferenceReview.targetAssetUri) === targetUri
        )
          ? null
          : (item.latestReferenceReview || null),
        referenceStatus,
        lineartHintAssetUri,
        lineartHintAssetId,
        lineartFinalAssetUri,
        lineartFinalAssetId,
        lineartStatus: lineartReady ? 'ready' : 'missing',
        lineartPrompt: lineartReady ? storyAssetStr(item && item.lineartPrompt).trim() : '',
        lineartNegativePrompt: lineartReady ? storyAssetStr(item && item.lineartNegativePrompt).trim() : '',
        lineartMeta: lineartReady ? (item && item.lineartMeta && typeof item.lineartMeta === 'object' ? item.lineartMeta : null) : null,
        lineartGeneratedAt: lineartReady ? storyAssetStr(item && item.lineartGeneratedAt).trim() : ''
      }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan)
  return {
    plan: nextPlan,
    asset: (Array.isArray(nextPlan.assets) ? nextPlan.assets.find((item) => storyAssetStr(item && item.id).trim() === storyAssetStr(asset && asset.id).trim()) : null) || null,
    items: buildStoryAssetGalleryEntries({ projectId: id, project: normalizeProjectDoc(nextProject), plan: nextPlan, asset: (Array.isArray(nextPlan.assets) ? nextPlan.assets.find((item) => storyAssetStr(item && item.id).trim() === storyAssetStr(asset && asset.id).trim()) : null) || asset }),
    deleted: true
  }
}

async function existsDir(p) {
  try {
    const st = await stat(p)
    return st.isDirectory()
  } catch (_) {
    return false
  }
}

async function existsFile(p) {
  try {
    const st = await stat(p)
    return st.isFile()
  } catch (_) {
    return false
  }
}

function normalizeLocalPath(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''
  // Strip surrounding quotes copied from shell/GUI.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
  }
  // Drop trailing slashes to reduce join surprises.
  s = s.replace(/[\\/]+$/, '')
  return s
}

async function resolveSdWebuiModelsBase(root) {
  const raw = normalizeLocalPath(root)
  if (!raw) return ''
  if (await isDir(raw)) {
    // If user passed the webui root (contains "models/"), normalize to "<root>/models".
    const maybeModels = path.join(raw, 'models')
    if (await isDir(maybeModels)) return maybeModels
    return raw
  }
  return raw
}

async function pickCheckpointDir(modelsBase) {
  const base = normalizeLocalPath(modelsBase)
  if (!base) return ''
  if (await isDir(base)) {
    // Some users point Models Root directly at the checkpoint folder.
    const items = await readdir(base).catch(() => [])
    if (items.some((x) => /\.(safetensors|ckpt)$/i.test(String(x || '')))) return base
  }
  return await pickExistingDir(base, ['Stable-diffusion', 'checkpoints', 'Checkpoint', 'Checkpoints'])
}

async function pickLoraDir(modelsBase) {
  const base = normalizeLocalPath(modelsBase)
  if (!base) return ''
  if (await isDir(base)) {
    // Some users point Models Root directly at the LoRA folder.
    const items = await readdir(base).catch(() => [])
    if (items.some((x) => /\.safetensors$/i.test(String(x || '')))) return base
  }
  return await pickExistingDir(base, ['Lora', 'loras', 'LoRA', 'lora'])
}

async function scanModelFiles(rootDir, { exts, maxDepth = 4 }) {
  const out = []
  const want = new Set((exts || []).map((x) => String(x || '').toLowerCase()).filter(Boolean))
  if (!rootDir) return out

  async function walk(dir, depth) {
    if (depth > maxDepth) return
    let ents = []
    try {
      ents = await readdir(dir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const ent of ents) {
      const name = String(ent && ent.name ? ent.name : '')
      if (!name || name.startsWith('.')) continue
      const full = path.join(dir, name)
      if (ent.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!ent.isFile()) continue
      const lower = name.toLowerCase()
      // Ignore common sidecar files.
      if (
        lower.endsWith('.civitai.info') ||
        lower.endsWith('.preview.png') ||
        lower.endsWith('.png') ||
        lower.endsWith('.jpg') ||
        lower.endsWith('.jpeg') ||
        lower.endsWith('.webp') ||
        lower.endsWith('.txt') ||
        lower.endsWith('.yaml') ||
        lower.endsWith('.yml')
      ) {
        continue
      }
      const ext = path.extname(lower)
      if (!want.has(ext)) continue
      const rel = path.relative(rootDir, full).split(path.sep).join('/')
      out.push(rel)
    }
  }

  await walk(rootDir, 0)
  out.sort((a, b) => a.localeCompare(b))
  return out
}

function defaultStory() {
  return {
    schemaVersion: '2.0',
    startNodeId: 'start',
    nodes: [
      {
        id: 'start',
        name: '开始',
        kind: 'scene',
        body: { text: '这是一个新的故事。请在右侧属性面板编辑内容。' },
        timeline: {
          steps: [
            {
              id: 'st_start_1',
              actions: [{ type: 'ui.setText', mode: 'replace', text: '这是一个新的故事。请在右侧属性面板编辑内容。' }],
              advance: { type: 'choice' }
            }
          ]
        },
        choices: [
          { id: 'c1', text: '继续', toNodeId: 'end' }
        ],
        visuals: { placements: [] }
      },
      {
        id: 'end',
        name: '结局',
        kind: 'ending',
        body: { text: '故事结束。' },
        timeline: {
          steps: [
            {
              id: 'st_end_1',
              actions: [
                {
                  type: 'ui.showEndingCard',
                  card: {
                    title: '故事结束',
                    bullets: [],
                    moral: '故事结束。',
                    buttons: [
                      { type: 'restart', label: '重新开始' },
                      { type: 'backToHub', label: '返回工作台' }
                    ]
                  }
                }
              ],
              advance: { type: 'end' }
            }
          ]
        },
        visuals: { placements: [] }
      }
    ]
  }
}

function nowIso() {
  try { return new Date().toISOString() } catch (_) { return String(Date.now()) }
}

function defaultMeta({ id, title }) {
  return {
    schemaVersion: '1.0',
    id: String(id),
    title: String(title || ''),
    stage: 'script',
    createdAt: nowIso(),
    updatedAt: nowIso()
  }
}

function clampInt(x, min, max, fallback) {
  const n = Number(x)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

function defaultScripts() {
  const id = `sc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  return {
    schemaVersion: '1.0',
    cards: [
      {
        id,
        name: '脚本1',
        order: 1,
        text: '',
        updatedAt: nowIso()
      }
    ],
    updatedAt: nowIso()
  }
}

function defaultBlueprint() {
  return {
    schemaVersion: '1.0',
    startNodeId: '',
    placeholders: [],
    nodes: [],
    updatedAt: nowIso()
  }
}

async function writeAiDraftProject({ dir, id, title, formula, scripts, blueprint, projectBase = null }) {
  await mkdir(path.join(dir, 'assets'), { recursive: true })
  const project = normalizeProjectDoc(projectBase || {
    schemaVersion: '2.0',
    id,
    title,
    pluginId: 'story-pixi',
    pluginVersion: '0.1.0',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    characters: [],
    assets: [],
    events: [],
    state: { vars: [] }
  })
  await writeJson(path.join(dir, 'project.json'), project)
  await writeJson(path.join(dir, 'story.json'), defaultStory())
  await writeJson(path.join(dir, 'scripts.json'), scripts || defaultScripts())
  await writeJson(path.join(dir, 'blueprint.json'), blueprint || defaultBlueprint())
  await writeJson(path.join(dir, 'meta.json'), { ...defaultMeta({ id, title }), aiFormula: formula, aiDraftStatus: 'pending' })
  return project
}

function normalizeProjectAndDetectChanges(project) {
  const before = project && typeof project === 'object' ? project : {}
  const after = normalizeProjectDoc(before)
  let changed = false
  try {
    changed = JSON.stringify(before?.state || null) !== JSON.stringify(after?.state || null)
  } catch (_) {
    changed = true
  }
  return { project: after, changed }
}

async function touchProjectUpdatedAt(dir) {
  try {
    const curr = await readJson(path.join(dir, 'project.json'))
    await writeJson(path.join(dir, 'project.json'), { ...curr, updatedAt: nowIso() })
  } catch (_) {}

  try {
    const metaPath = path.join(dir, 'meta.json')
    const meta = (await existsFile(metaPath)) ? await readJson(metaPath) : null
    if (meta && typeof meta === 'object') {
      // 2026-09-27 F8：meta.json.stage 随写盘收口同步回写（创建时写 'script' 后无人更新），
      // 派生逻辑与 /api/projects/summary 的 Hub 展示值保持一致（deriveProjectStage 单一来源）
      const stage = await deriveProjectStageFromDisk(dir)
      await writeJson(metaPath, { ...meta, stage, updatedAt: nowIso() })
    }
  } catch (_) {}
}

// 项目阶段派生（单一来源）：script→blueprint→compose→export→playable，
// 与 /api/projects/summary 的 Hub 列表展示口径一致
function deriveProjectStage({ cards, blueprintNodes, storyNodes, distExists }) {
  return !(Number(cards) > 0) ? 'script'
    : !(Number(blueprintNodes) > 0) ? 'blueprint'
    : !(Number(storyNodes) > 2) ? 'compose'
    : !distExists ? 'export'
    : 'playable'
}

async function deriveProjectStageFromDisk(dir) {
  const scripts = await readJson(path.join(dir, 'scripts.json')).catch(() => null)
  const blueprint = await readJson(path.join(dir, 'blueprint.json')).catch(() => null)
  const story = await readJson(path.join(dir, 'story.json')).catch(() => null)
  const cards = Array.isArray(scripts?.cards) ? scripts.cards.length : 0
  const blueprintNodes = Array.isArray(blueprint?.nodes) ? blueprint.nodes.length : 0
  const storyNodes = story?.nodes && typeof story.nodes === 'object' ? Object.keys(story.nodes).length : 0
  const distExists = await existsFile(path.join(dir, 'builds', 'latest', 'dist', 'index.html'))
  return deriveProjectStage({ cards, blueprintNodes, storyNodes, distExists })
}

function normalizeAiStoryFormula(input) {
  const choicePoints = clampInt(input?.choicePoints, 1, 3, 2)
  const optionsPerChoice = Number(input?.optionsPerChoice) === 3 ? 3 : 2
  const endings = optionsPerChoice
  return { schemaVersion: '1.0', format: 'numeric', choicePoints, optionsPerChoice, endings }
}

function buildScriptsFromDraftCards(cardsIn, prevScripts, formula) {
  const sourceCards = Array.isArray(cardsIn) ? cardsIn : []
  const prevCards = prevScripts && typeof prevScripts === 'object' && Array.isArray(prevScripts.cards) ? prevScripts.cards : []
  const preserveIds = prevCards.length > 0 && prevCards.length === sourceCards.length

  const cards = sourceCards
    .map((x, i) => {
      const base = preserveIds ? prevCards[i] : null
      const idUse = base && base.id ? String(base.id) : genId('sc')
      const orderUse = base && base.order != null ? Number(base.order) : i + 1
      return {
        id: idUse,
        name: String(x && x.name ? x.name : `场景${i + 1}`),
        order: Number.isFinite(orderUse) && orderUse > 0 ? orderUse : i + 1,
        text: String(x && x.text ? x.text : ''),
        updatedAt: nowIso()
      }
    })
    .filter((c) => c.text.trim())

  if (!cards.length) return null

  const scripts = { schemaVersion: '1.0', cards, updatedAt: nowIso() }
  scripts.cards = normalizeScriptCardsForBlueprint(scripts.cards, formula)
  // 2026-10-05 公式硬约束：AI 即兴多写选项时，确定性裁剪到公式值（裁选项句/后果卡/结局卡并重编号），
  // 不再依赖 LLM 修复的自由改写（后者曾幻觉出多余选择点与结局，P1-20 编辑器同款）。
  scripts.cards = fitScriptCardsToFormula(scripts.cards, formula)
  return scripts
}

// 按结构公式确定性拟合卡片（只做"减/重编号"，不编造内容）：
// ①每选择点选项数 > optionsPerChoice：保留前 N 个（重编号选项句），删除被裁选项的后果卡并重编号保留的；
// ②选择点总数 > choicePoints：仅保留前 choicePoints 个选择点，删除多余选择点卡及其全部后果卡；
// ③后果卡与其结局卡之间不得夹普通场景（夹着的删除）；
// ④结局卡裁剪到 endings 个并重编号；⑤重名卡去重。
function fitScriptCardsToFormula(cards, formula) {
  const cp = Math.max(0, Number(formula?.choicePoints) || 0)
  const opt = Math.max(0, Number(formula?.optionsPerChoice) || 0)
  const end = Math.max(0, Number(formula?.endings) || 0)
  if (!cp && !opt && !end) return cards
  const list = cards.map((c) => ({ ...c }))

  // ①+② 选择点发现（按出现顺序编号）与裁剪
  const choiceCards = list.filter((c) => (String(c.text || '').match(/选项\s*\d{1,2}\s*[:：]/g) || []).length >= 2)
  choiceCards.forEach((c, i) => { c.__choiceNo = i + 1 })
  const dropChoiceNos = new Set()
  if (cp > 0 && choiceCards.length > cp) {
    choiceCards.slice(cp).forEach((c) => { c.__drop = true; dropChoiceNos.add(c.__choiceNo) })
  }
  for (const c of choiceCards) {
    if (c.__drop) continue
    const marks = [...String(c.text || '').matchAll(/选项\s*(\d{1,2})\s*[:：]/g)]
    if (opt > 0 && marks.length > opt) {
      const keepOld = marks.slice(0, opt).map((m) => Number(m[1]))
      const dropOld = new Set(marks.map((m) => Number(m[1])).filter((k) => !keepOld.includes(k)))
      const firstIdx = String(c.text).search(/选项\s*\d{1,2}\s*[:：]/)
      const head = firstIdx > 0 ? String(c.text).slice(0, firstIdx).trim() : ''
      const parts = String(c.text).slice(Math.max(0, firstIdx)).split(/(?=选项\s*\d{1,2}\s*[:：])/)
      const segByOld = {}
      for (const seg of parts) {
        const m = seg.match(/选项\s*(\d{1,2})\s*[:：]/)
        if (m) segByOld[Number(m[1])] = seg
      }
      const kept = []
      keepOld.forEach((oldK, i) => {
        const seg = String(segByOld[oldK] || '').replace(/选项\s*\d{1,2}\s*[:：]\s*/, `选项${i + 1}：`).trim()
        if (seg) kept.push(seg)
      })
      c.text = (head ? head + ' ' : '') + kept.join(' ')
      const renum = new Map(keepOld.map((k, i) => [k, i + 1]))
      c.__conseqRenum = { renum, dropOld, choiceNo: c.__choiceNo }
    }
  }
  for (const c of list) {
    const m = c.name.match(/^(\d{1,2})后果(\d{1,2})$/)
    if (!m) continue
    const choiceNo = Number(m[1])
    if (dropChoiceNos.has(choiceNo)) { c.__drop = true; continue }
    const owner = choiceCards.find((x) => x.__choiceNo === choiceNo)
    const fit = owner && owner.__conseqRenum
    if (fit && fit.choiceNo === choiceNo) {
      const k = Number(m[2])
      if (fit.dropOld.has(k)) c.__drop = true
      else c.name = `${choiceNo}后果${fit.renum.get(k)}`
    }
  }

  // ④结局裁剪+重编号
  if (end > 0) {
    const endings = list
      .filter((c) => /^结局\d{1,2}$/.test(c.name) && !c.__drop)
      .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0))
    if (endings.length > end) endings.slice(end).forEach((c) => { c.__drop = true })
    let ei = 0
    for (const c of list) {
      if (/^结局\d{1,2}$/.test(c.name) && !c.__drop) { ei += 1; c.name = `结局${ei}` }
    }
  }

  // ③后果卡与结局卡之间夹着的普通卡删除（保铺垫段与后果卡前的铺垫）
  {
    const alive = list.filter((c) => !c.__drop)
    const firstConseqOrder = Math.min(...alive.filter((c) => /\d{1,2}后果\d{1,2}$/.test(c.name)).map((c) => Number(c.order) || 0).filter(Number.isFinite), Infinity)
    if (Number.isFinite(firstConseqOrder)) {
      for (const c of alive) {
        const o = Number(c.order) || 0
        if (o <= firstConseqOrder) continue
        const isConseq = /\d{1,2}后果\d{1,2}$/.test(c.name)
        const isEnding = /^结局\d{1,2}$/.test(c.name)
        const hasOptions = (String(c.text || '').match(/选项\s*\d{1,2}\s*[:：]/g) || []).length >= 2
        if (!isConseq && !isEnding && !hasOptions) c.__drop = true
      }
    }
  }

  // ⑤重名去重（非后果/结局的叙述卡同名时后缀序号）
  {
    const seen = new Map()
    for (const c of list) {
      if (c.__drop) continue
      if (/\d{1,2}后果\d{1,2}$/.test(c.name) || /^结局\d{1,2}$/.test(c.name)) continue
      const n = seen.get(c.name) || 0
      seen.set(c.name, n + 1)
      if (n > 0) c.name = `${c.name}${n + 1}`
    }
  }

  return list.filter((c) => !c.__drop).map((c) => {
    const { __drop, __choiceNo, __conseqRenum, ...rest } = c
    return rest
  })
}

function collectBlockingScriptIssues(report, validation) {
  const out = []
  const blockingReportWarnings = new Set([
    'formula_choicePoints_mismatch',
    'formula_optionsPerChoice_mismatch',
    'formula_endings_too_few',
    'missing_consequence',
    'consequence_index_mismatch'
  ])
  const blockingValidationWarnings = new Set([
    'scene_no_choices',
    'ending_has_choices',
    'unreachable_nodes',
    'no_reachable_endings'
  ])

  for (const item of Array.isArray(report?.errors) ? report.errors : []) {
    if (!item || !item.message) continue
    out.push({ source: 'compile', severity: 'error', code: String(item.code || ''), message: String(item.message) })
  }
  for (const item of Array.isArray(report?.warnings) ? report.warnings : []) {
    const code = String(item?.code || '')
    if (!blockingReportWarnings.has(code) || !item?.message) continue
    out.push({ source: 'compile', severity: 'warning', code, message: String(item.message) })
  }
  for (const item of Array.isArray(validation?.errors) ? validation.errors : []) {
    if (!item || !item.message) continue
    out.push({ source: 'validate', severity: 'error', code: String(item.code || ''), message: String(item.message) })
  }
  for (const item of Array.isArray(validation?.warnings) ? validation.warnings : []) {
    const code = String(item?.code || '')
    if (!blockingValidationWarnings.has(code) || !item?.message) continue
    out.push({ source: 'validate', severity: 'warning', code, message: String(item.message) })
  }
  return out
}

function summarizeScriptIssues(issues) {
  const items = Array.isArray(issues) ? issues : []
  if (!items.length) return ''
  return items.slice(0, 3).map((item) => String(item?.message || '').trim()).filter(Boolean).join('；')
}

async function generateClosedScriptDraft({
  prompt,
  title,
  projectTitle,
  rules,
  formula,
  provider,
  model,
  apiUrl,
  proxyUrl,
  timeoutMs,
  prevScripts,
  prevBlueprint
}) {
  let generated = null
  let genMeta = null
  try {
    generated = await generateScriptDraft({
      prompt,
      title: title || undefined,
      rules,
      formula,
      provider,
      model,
      apiUrl,
      proxyUrl,
      timeoutMs
    })
    if (generated && typeof generated === 'object' && generated.meta) genMeta = generated.meta
    if (generated && typeof generated === 'object' && generated.draft) generated = generated.draft
  } catch (e) {
    const err = {
      message: e instanceof Error ? e.message : String(e),
      status: e && e.status ? Number(e.status) : null,
      code: e && e.code ? String(e.code) : null,
      cause: e && e.cause ? (e.cause.message ? String(e.cause.message) : String(e.cause)) : null
    }
    return {
      ok: false,
      repaired: false,
      status: Number.isFinite(Number(err.status)) ? Math.max(400, Math.min(599, Number(err.status))) : 502,
      message: err.message || 'ai_generate_failed',
      meta: { provider, model: model || null, api: apiUrl || null, error: err },
      scripts: null,
      blueprint: null,
      before: null,
      after: null
    }
  }

  const generatedTitle = generated && typeof generated.title === 'string' ? String(generated.title).trim() : ''
  if (!generated || typeof generated !== 'object' || !Array.isArray(generated.cards)) {
    const err = genMeta && genMeta.error ? genMeta.error : null
    return {
      ok: false,
      repaired: false,
      status: err && Number.isFinite(Number(err.status)) ? Math.max(400, Math.min(599, Number(err.status))) : 502,
      message: err && err.message ? String(err.message) : 'AI 未返回有效脚本卡片',
      title: generatedTitle,
      meta: genMeta || { provider, model: model || null, api: apiUrl || null, error: err },
      scripts: null,
      blueprint: null,
      before: null,
      after: null
    }
  }

  const initialScripts = buildScriptsFromDraftCards(generated.cards, prevScripts, formula)
  if (!initialScripts) {
    return {
      ok: false,
      repaired: false,
      status: 502,
      message: 'AI 返回了空脚本，未生成可用场景卡片',
      title: generatedTitle,
      meta: genMeta || { provider, model: model || null, api: apiUrl || null, error: null },
      scripts: null,
      blueprint: null,
      before: null,
      after: null
    }
  }

  const compiledBefore = compileBlueprintFromScripts({ scripts: initialScripts, prevBlueprint, expectedFormula: formula })
  const validationBefore = validateBlueprintDoc(compiledBefore.blueprint)
  const beforeIssues = collectBlockingScriptIssues(compiledBefore.report, validationBefore)
  const before = { report: compiledBefore.report, validation: validationBefore, issues: beforeIssues }

  if (!beforeIssues.length) {
    return {
      ok: true,
      repaired: false,
      title: generatedTitle,
      scripts: initialScripts,
      blueprint: compiledBefore.blueprint,
      meta: genMeta || { provider, model: model || null, api: apiUrl || null, error: null },
      before,
      after: before
    }
  }

  let fixed = null
  try {
    fixed = await repairScriptDraft({
      projectTitle: String(projectTitle || title || generatedTitle || '').trim(),
      scripts: initialScripts,
      rules,
      formula,
      report: compiledBefore.report,
      validation: validationBefore,
      provider,
      model,
      apiUrl,
      proxyUrl,
      timeoutMs
    })
  } catch (e) {
    const err = {
      message: e instanceof Error ? e.message : String(e),
      status: e && e.status ? Number(e.status) : null,
      code: e && e.code ? String(e.code) : null,
      cause: e && e.cause ? (e.cause.message ? String(e.cause.message) : String(e.cause)) : null
    }
    return {
      ok: false,
      repaired: true,
      status: Number.isFinite(Number(err.status)) ? Math.max(400, Math.min(599, Number(err.status))) : 502,
      message: `脚本初稿未通过校验，AI 修复失败：${err.message || 'unknown_error'}`,
      title: generatedTitle,
      meta: { ...(genMeta || { provider, model: model || null, api: apiUrl || null }), error: err },
      scripts: initialScripts,
      blueprint: compiledBefore.blueprint,
      before,
      after: null
    }
  }

  if (!fixed || typeof fixed !== 'object' || !fixed.draft || typeof fixed.draft !== 'object' || !Array.isArray(fixed.draft.cards)) {
    return {
      ok: false,
      repaired: true,
      status: 502,
      message: `脚本初稿未通过校验，且当前 Provider 没有返回可用修复结果：${summarizeScriptIssues(beforeIssues) || 'unknown_issue'}`,
      title: generatedTitle,
      meta: fixed && typeof fixed === 'object' && fixed.meta
        ? fixed.meta
        : (genMeta || { provider, model: model || null, api: apiUrl || null, error: null }),
      scripts: initialScripts,
      blueprint: compiledBefore.blueprint,
      before,
      after: null
    }
  }

  const repairedTitle = fixed.draft && typeof fixed.draft.title === 'string' ? String(fixed.draft.title).trim() : generatedTitle
  const repairedScripts = buildScriptsFromDraftCards(fixed.draft.cards, prevScripts || initialScripts, formula)
  if (!repairedScripts) {
    return {
      ok: false,
      repaired: true,
      status: 502,
      message: 'AI 修复返回了空脚本，无法生成可用场景卡片',
      title: repairedTitle,
      meta: fixed.meta || genMeta || { provider, model: model || null, api: apiUrl || null, error: null },
      scripts: initialScripts,
      blueprint: compiledBefore.blueprint,
      before,
      after: null
    }
  }

  const compiledAfter = compileBlueprintFromScripts({ scripts: repairedScripts, prevBlueprint, expectedFormula: formula })
  const validationAfter = validateBlueprintDoc(compiledAfter.blueprint)
  const afterIssues = collectBlockingScriptIssues(compiledAfter.report, validationAfter)
  const after = { report: compiledAfter.report, validation: validationAfter, issues: afterIssues }

  if (afterIssues.length) {
    return {
      ok: false,
      repaired: true,
      status: 502,
      message: `AI 修复后仍未通过结构校验：${summarizeScriptIssues(afterIssues) || 'unknown_issue'}`,
      title: repairedTitle,
      meta: fixed.meta || genMeta || { provider, model: model || null, api: apiUrl || null, error: null },
      scripts: repairedScripts,
      blueprint: compiledAfter.blueprint,
      before,
      after
    }
  }

  return {
    ok: true,
    repaired: true,
    title: repairedTitle,
    scripts: repairedScripts,
    blueprint: compiledAfter.blueprint,
    meta: fixed.meta || genMeta || { provider, model: model || null, api: apiUrl || null, error: null },
    before,
    after
  }
}

app.get('/api/projects', async (c) => {
  await ensureDirs()
  const items = []
  const dirs = await readdir(PROJECTS_DIR).catch(() => [])
  for (const id of dirs) {
    const dir = projectDir(id)
    if (!(await existsDir(dir))) continue
    try {
      const p0 = await readJson(path.join(dir, 'project.json'))
      const { project: p, changed } = normalizeProjectAndDetectChanges(p0)
      // 2026-10-05 草稿标记透传：AI 生成未确认的项目不消失于列表（草稿入口依赖），由前端分开展示
      const meta = await readJson(path.join(dir, 'meta.json')).catch(() => null)
      items.push({ ...p, aiDraftStatus: String(meta?.aiDraftStatus || 'confirmed') })
      if (changed) await writeJson(path.join(dir, 'project.json'), p)
    } catch (_) {}
  }
  items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  return c.json({ success: true, items })
})

// 项目库卡片摘要：阶段健康（脚本/蓝图/合成/导出）与可玩性，只读。
app.get('/api/projects/summary', async (c) => {
  await ensureDirs()
  const items = []
  const dirs = await readdir(PROJECTS_DIR).catch(() => [])
  for (const id of dirs) {
    const dir = projectDir(id)
    if (!(await existsDir(dir))) continue
    try {
      const p0 = await readJson(path.join(dir, 'project.json'))
      const { project: p } = normalizeProjectAndDetectChanges(p0)
      const scripts = await readJson(path.join(dir, 'scripts.json')).catch(() => null)
      const blueprint = await readJson(path.join(dir, 'blueprint.json')).catch(() => null)
      const story = await readJson(path.join(dir, 'story.json')).catch(() => null)
      const cards = Array.isArray(scripts?.cards) ? scripts.cards.length : 0
      const blueprintNodes = Array.isArray(blueprint?.nodes) ? blueprint.nodes.length : 0
      const storyNodes = story?.nodes && typeof story.nodes === 'object' ? Object.keys(story.nodes).length : 0
      // 图像完整度：story 场景中带 visuals.backgroundAssetId 真实图像引用的比例
      const storySceneNodes = Array.isArray(story?.nodes) ? story.nodes : Object.values(story?.nodes || {})
      const totalScenes = storySceneNodes.length
      const withImages = storySceneNodes.filter((n) => {
        const bgId = n?.visuals?.backgroundAssetId
        if (typeof bgId === 'string' && bgId.trim()) return true
        const bg = n?.visuals?.background ?? n?.background
        if (!bg) return false
        if (typeof bg === 'string') return bg.trim().length > 0
        if (typeof bg === 'object') return Boolean(bg.uri || bg.src || bg.url || bg.path)
        return false
      }).length
      const imageStats = {
        totalScenes,
        withImages,
        missingImages: Math.max(0, totalScenes - withImages)
      }
      const distPath = path.join(dir, 'builds', 'latest', 'dist', 'index.html')
      const distExists = await existsFile(distPath)
      const stages = {
        scripts: cards > 0,
        blueprint: blueprintNodes > 0,
        compose: storyNodes > 2,
        export: distExists
      }
      const stage = deriveProjectStage({ cards, blueprintNodes, storyNodes, distExists })
      const meta = await readJson(path.join(dir, 'meta.json')).catch(() => null)
      items.push({
        id: p.id || id,
        title: p.title || '',
        updatedAt: p.updatedAt || '',
        createdAt: p.createdAt || '',
        cards,
        blueprintNodes,
        storyNodes,
        imageStats,
        stages,
        stage,
        aiDraftStatus: String(meta?.aiDraftStatus || 'confirmed'),
        distUrl: distExists ? `/demos/${p.id || id}/latest/dist/index.html` : null
      })
    } catch (_) {}
  }
  items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  return c.json({ success: true, items })
})

app.post('/api/projects/:id/confirm-draft', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const meta = await readJson(path.join(dir, 'meta.json')).catch(() => ({}))
  await writeJson(path.join(dir, 'meta.json'), { ...meta, aiDraftStatus: 'confirmed', confirmedAt: nowIso() })
  return c.json({ success: true, projectId: id })
})

app.post('/api/projects', storyInputGate('story.project.create'), async (c) => {
  await ensureDirs()
  const body = await c.req.json().catch(() => ({}))
  const title = String(body?.title || '').trim() || '未命名故事'
  const id = crypto.randomUUID ? crypto.randomUUID() : `p_${Math.random().toString(36).slice(2, 10)}`
  const dir = projectDir(id)
  await mkdir(path.join(dir, 'assets'), { recursive: true })
  const project = normalizeProjectDoc({
    schemaVersion: '2.0',
    id,
    title,
    pluginId: 'story-pixi',
    pluginVersion: '0.1.0',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    characters: [],
    assets: [],
    events: [],
    state: { vars: [] }
  })
  await writeJson(path.join(dir, 'project.json'), project)
  await writeJson(path.join(dir, 'story.json'), defaultStory())

  // 三层工作流：脚本层/蓝图层默认文件（P0）
  await writeJson(path.join(dir, 'meta.json'), defaultMeta({ id, title }))
  await writeJson(path.join(dir, 'scripts.json'), defaultScripts())
  await writeJson(path.join(dir, 'blueprint.json'), defaultBlueprint())

  return c.json({ success: true, project })
})

// AI: Create new project + scripts from prompt (P0: scripts layer only)
// 支持两种模式：
// - 独立编辑器模式：使用 GameStudio Settings 中的 provider/model/apiUrl
// - 守护台受控模式：使用 Control 签发的 modelExecution（含 provider/model/apiUrl/leaseId），
//   此时必须携带有效 leaseId，否则拒绝执行
app.post('/api/projects/ai/create', storyInputGate('story.project.create'), async (c) => {
  await ensureDirs()
  const body = await c.req.json().catch(() => ({}))
  const prompt = String(body?.prompt || '').trim()
  if (!prompt) return c.json({ success: false, error: 'missing_prompt', message: 'prompt 不能为空' }, 400)

  // 受控模式判定：请求中携带 modelExecution 时进入守护台受控模式
  const modelExecution = body?.modelExecution && typeof body.modelExecution === 'object' ? body.modelExecution : null
  const isControlledMode = Boolean(modelExecution)
  if (isControlledMode) {
    const leaseId = String(modelExecution?.leaseId || '').trim()
    if (!leaseId) {
      return c.json({ success: false, error: 'missing_lease_id', message: '受控模式必须携带有效 leaseId' }, 403)
    }
    // TODO: 校验 leaseId 有效性（与 Control 资源调度器核对）
  }

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.scripts) {
    return c.json({ success: false, error: 'disabled', message: '“写故事（脚本生成）”已在设置中关闭' }, 503)
  }

  const titleIn = String(body?.title || '').trim()
  const formula = normalizeAiStoryFormula(body)
  const id = crypto.randomUUID ? crypto.randomUUID() : `p_${Math.random().toString(36).slice(2, 10)}`
  const dir = projectDir(id)

  const startedAt = Date.now()
  // 调用方传入的预算生效（Control 长脚本给 300s），缺省仍为 90s
  const aiTimeoutMs = clampInt(body?.timeoutMs, 90_000, 300_000, 90_000)

  // 模型路由：受控模式使用 modelExecution，独立模式使用 Studio Settings
  const requestedProvider = isControlledMode
    ? String(modelExecution?.provider || '').toLowerCase()
    : String(studio.effective.scripts.provider || 'local').toLowerCase()
  const requestedModel = isControlledMode
    ? (modelExecution?.model || null)
    : (studio.effective.scripts.model || null)
  const requestedApiUrl = isControlledMode
    ? (modelExecution?.apiUrl || undefined)
    : (studio.effective.scripts.apiUrl || undefined)

  if (!requestedProvider || requestedProvider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“写故事脚本”并选择 Provider/Model' }, 400)
  }
  const globalRules = await readGlobalRules(ROOT)
  try {
    console.log(
      `[gamestudio] ai.create:start project=${id} mode=${isControlledMode ? 'controlled' : 'standalone'} requestedProvider=${requestedProvider}${requestedModel ? ` model=${requestedModel}` : ''} promptChars=${prompt.length}${titleIn ? ` titleChars=${titleIn.length}` : ''} choicePoints=${formula.choicePoints} optionsPerChoice=${formula.optionsPerChoice} endings=${formula.endings}`
    )
  } catch (_) {}
  const closed = await generateClosedScriptDraft({
    prompt,
    title: titleIn || undefined,
    projectTitle: titleIn || undefined,
    rules: globalRules,
    formula,
    provider: requestedProvider,
    model: requestedModel || undefined,
    apiUrl: requestedApiUrl,
    proxyUrl: studio.effective.network.proxyUrl,
    timeoutMs: aiTimeoutMs,
    prevScripts: null,
    prevBlueprint: null
  })
  const title = titleIn || closed.title || guessTitleFromPrompt(prompt)

  if (!closed.ok) {
    const err = closed.meta && closed.meta.error ? closed.meta.error : null
    const durationMs = Math.max(0, Date.now() - startedAt)
    if (!closed.scripts) {
      const status = Number.isFinite(Number(closed.status)) ? Math.max(400, Math.min(599, Number(closed.status))) : 502
      return c.json({
        success: false,
        error: 'ai_generate_failed',
        message: closed.message || (err && err.message ? String(err.message) : 'ai_generate_failed'),
        gen: {
          ok: false,
          requestedProvider,
          provider: closed.meta?.provider || requestedProvider,
          model: closed.meta?.model || null,
          api: closed.meta?.api || null,
          durationMs,
          formula,
          error: err,
          repaired: Boolean(closed.repaired),
          before: closed.before || null,
          after: closed.after || null
        }
      }, status)
    }
    const project = await writeAiDraftProject({
      dir,
      id,
      title,
      formula,
      scripts: closed.scripts,
      blueprint: closed.blueprint
    })
    return c.json({
      success: true,
      project,
      scripts: closed.scripts,
      blueprint: closed.blueprint || defaultBlueprint(),
      gen: {
        ok: false,
        message: closed.message || (err && err.message ? String(err.message) : 'ai_generate_failed'),
        requestedProvider,
        provider: closed.meta?.provider || requestedProvider,
        model: closed.meta?.model || null,
        api: closed.meta?.api || null,
        durationMs,
        formula,
        error: err,
        repaired: Boolean(closed.repaired),
        before: closed.before || null,
        after: closed.after || null
      }
    })
  }

  const project = await writeAiDraftProject({
    dir,
    id,
    title,
    formula,
    scripts: closed.scripts,
    blueprint: closed.blueprint
  })

  const durationMs = Math.max(0, Date.now() - startedAt)
  try {
    console.log(
      `[gamestudio] ai.create project=${id} requestedProvider=${requestedProvider} provider=${closed.meta?.provider || requestedProvider} model=${closed.meta?.model || '-'} api=${closed.meta?.api || '-'} repaired=${closed.repaired ? 'true' : 'false'} cards=${Array.isArray(closed.scripts?.cards) ? closed.scripts.cards.length : 0} ms=${durationMs}`
    )
  } catch (_) {}

  return c.json({
    success: true,
    project,
    scripts: closed.scripts,
    blueprint: closed.blueprint,
    gen: {
      ok: true,
      mode: isControlledMode ? 'controlled' : 'standalone',
      leaseId: isControlledMode ? String(modelExecution?.leaseId || '') : undefined,
      requestedProvider,
      provider: closed.meta?.provider || requestedProvider,
      model: closed.meta?.model || null,
      api: closed.meta?.api || null,
      durationMs,
      formula,
      repaired: Boolean(closed.repaired),
      error: closed.meta && closed.meta.error ? closed.meta.error : null,
      before: closed.before || null,
      after: closed.after || null
    }
  })
})

// AI: Regenerate scripts for an existing project (overwrite scripts.json)
app.post('/api/projects/:id/ai/regenerate', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const prompt = String(body?.prompt || '').trim()
  if (!prompt) return c.json({ success: false, error: 'missing_prompt', message: 'prompt 不能为空' }, 400)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.scripts) {
    return c.json({ success: false, error: 'disabled', message: '“写故事（脚本生成）”已在设置中关闭' }, 503)
  }

  const titleIn = String(body?.title || '').trim()
  const formula = normalizeAiStoryFormula(body)
  const startedAt = Date.now()
  // 调用方传入的预算生效（Control 长脚本给 300s），缺省仍为 90s
  const aiTimeoutMs = clampInt(body?.timeoutMs, 90_000, 300_000, 90_000)
  const requestedProvider = String(studio.effective.scripts.provider || 'local').toLowerCase()
  const requestedModel = studio.effective.scripts.model || null
  if (!requestedProvider || requestedProvider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“写故事脚本”并选择 Provider/Model' }, 400)
  }
  const globalRules = await readGlobalRules(ROOT)
  try {
    console.log(
      `[gamestudio] ai.regen:start project=${id} requestedProvider=${requestedProvider}${requestedModel ? ` model=${requestedModel}` : ''} promptChars=${prompt.length}${titleIn ? ` titleChars=${titleIn.length}` : ''} choicePoints=${formula.choicePoints} optionsPerChoice=${formula.optionsPerChoice} endings=${formula.endings}`
    )
  } catch (_) {}

  const currProject = normalizeProjectDoc(await readJson(path.join(dir, 'project.json')))
  let currScripts = null
  try { currScripts = await readJson(path.join(dir, 'scripts.json')) } catch (_) { currScripts = defaultScripts() }
  let currBlueprint = null
  try { currBlueprint = await readJson(path.join(dir, 'blueprint.json')) } catch (_) { currBlueprint = defaultBlueprint() }

  const closed = await generateClosedScriptDraft({
    prompt,
    title: titleIn || undefined,
    projectTitle: String(currProject?.title || '').trim() || titleIn || undefined,
    rules: globalRules,
    formula,
    provider: requestedProvider,
    model: requestedModel || undefined,
    apiUrl: studio.effective.scripts.apiUrl || undefined,
    proxyUrl: studio.effective.network.proxyUrl,
    timeoutMs: aiTimeoutMs,
    prevScripts: currScripts,
    prevBlueprint: currBlueprint
  })
  const nextTitle = titleIn || String(currProject?.title || '').trim() || closed.title || guessTitleFromPrompt(prompt)

  if (!closed.ok) {
    const err = closed.meta && closed.meta.error ? closed.meta.error : null
    const durationMs = Math.max(0, Date.now() - startedAt)
    if (!closed.scripts) {
      const status = Number.isFinite(Number(closed.status)) ? Math.max(400, Math.min(599, Number(closed.status))) : 502
      return c.json({
        success: false,
        error: 'ai_generate_failed',
        message: closed.message || (err && err.message ? String(err.message) : 'ai_generate_failed'),
        gen: {
          ok: false,
          requestedProvider,
          provider: closed.meta?.provider || requestedProvider,
          model: closed.meta?.model || null,
          api: closed.meta?.api || null,
          durationMs,
          formula,
          error: err,
          repaired: Boolean(closed.repaired),
          before: closed.before || null,
          after: closed.after || null
        }
      }, status)
    }
    await writeJson(path.join(dir, 'scripts.json'), closed.scripts)
    await writeJson(path.join(dir, 'blueprint.json'), closed.blueprint || defaultBlueprint())
    const failedProject = normalizeProjectDoc({ ...(currProject || {}), id, title: nextTitle, updatedAt: nowIso() })
    await writeJson(path.join(dir, 'project.json'), failedProject)
    try {
      const metaPath = path.join(dir, 'meta.json')
      const meta = (await existsFile(metaPath)) ? await readJson(metaPath) : null
      await writeJson(metaPath, { ...(meta && typeof meta === 'object' ? meta : defaultMeta({ id, title: nextTitle })), id, title: nextTitle, updatedAt: nowIso(), aiFormula: formula })
    } catch (_) {}
    return c.json({
      success: true,
      project: failedProject,
      scripts: closed.scripts,
      blueprint: closed.blueprint || defaultBlueprint(),
      gen: {
        ok: false,
        message: closed.message || (err && err.message ? String(err.message) : 'ai_generate_failed'),
        requestedProvider,
        provider: closed.meta?.provider || requestedProvider,
        model: closed.meta?.model || null,
        api: closed.meta?.api || null,
        durationMs,
        formula,
        error: err,
        repaired: Boolean(closed.repaired),
        before: closed.before || null,
        after: closed.after || null
      }
    })
  }
  await writeJson(path.join(dir, 'scripts.json'), closed.scripts)
  await writeJson(path.join(dir, 'blueprint.json'), closed.blueprint)

  // keep titles + timestamps in sync
  const nextProject = normalizeProjectDoc({ ...(currProject || {}), id, title: nextTitle, updatedAt: nowIso() })
  await writeJson(path.join(dir, 'project.json'), nextProject)
  try {
    const metaPath = path.join(dir, 'meta.json')
    const meta = (await existsFile(metaPath)) ? await readJson(metaPath) : null
    if (meta && typeof meta === 'object') {
      await writeJson(metaPath, { ...meta, id, title: nextTitle, updatedAt: nowIso(), aiFormula: formula })
    }
  } catch (_) {}

  const durationMs = Math.max(0, Date.now() - startedAt)
  try {
    console.log(
      `[gamestudio] ai.regen project=${id} requestedProvider=${requestedProvider} provider=${closed.meta?.provider || requestedProvider} model=${closed.meta?.model || '-'} api=${closed.meta?.api || '-'} repaired=${closed.repaired ? 'true' : 'false'} cards=${Array.isArray(closed.scripts?.cards) ? closed.scripts.cards.length : 0} ms=${durationMs}`
    )
  } catch (_) {}

  return c.json({
    success: true,
    project: nextProject,
    scripts: closed.scripts,
    blueprint: closed.blueprint,
    gen: {
      ok: true,
      requestedProvider,
      provider: closed.meta?.provider || requestedProvider,
      model: closed.meta?.model || null,
      api: closed.meta?.api || null,
      durationMs,
      formula,
      repaired: Boolean(closed.repaired),
      error: closed.meta && closed.meta.error ? closed.meta.error : null,
      before: closed.before || null,
      after: closed.after || null
    }
  })
})

app.post('/api/projects/:id/analyze/scripts', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const scriptsPath = path.join(dir, 'scripts.json')
  if (!(await existsFile(scriptsPath))) return c.json({ success: false, error: 'missing_scripts' }, 404)
  const scripts = await readJson(scriptsPath)
  const meta = await readJson(path.join(dir, 'meta.json')).catch(() => null)
  const analysis = analyzeScriptsForBlueprint(scripts, meta?.aiFormula)

  return c.json({ success: true, analysis })
})

app.post('/api/projects/:id/validate/blueprint', storyInputGate('story.validate.blueprint', (c) => ({ projectId: c.req.param('id') })), async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  let blueprint = null
  try {
    blueprint = await readJson(path.join(dir, 'blueprint.json'))
  } catch (_) {
    blueprint = defaultBlueprint()
    await writeJson(path.join(dir, 'blueprint.json'), blueprint)
  }

  const validation = validateBlueprintDoc(blueprint)
  return c.json({ success: true, validation })
})

app.post('/api/projects/:id/ai/review/blueprint', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))

  const cachePath = path.join(dir, 'ai_blueprint_review.json')
  let meta = null
  try { meta = await readJson(path.join(dir, 'meta.json')) } catch (_) { meta = null }
  let project = null
  try { project = await readJson(path.join(dir, 'project.json')) } catch (_) { project = null }
  let scripts = null
  try { scripts = await readJson(path.join(dir, 'scripts.json')) } catch (_) { scripts = defaultScripts() }
  let currBlueprint = null
  try { currBlueprint = await readJson(path.join(dir, 'blueprint.json')) } catch (_) { currBlueprint = null }

  const expectedFormula = meta && typeof meta === 'object' ? meta.aiFormula : null
  const compiled = compileBlueprintFromScripts({ scripts, prevBlueprint: currBlueprint, expectedFormula })
  const validation = validateBlueprintDoc(compiled.blueprint)

  const studio = await getEffectiveStudioConfig(ROOT)
  const routeOverride = body && body.modelRoute && typeof body.modelRoute === 'object'
    ? body.modelRoute
    : (body && typeof body === 'object' ? body : {})
  const provider = String(routeOverride.provider || studio.effective.scripts.provider || process.env.STUDIO_AI_PROVIDER || 'local').toLowerCase()
  const model = routeOverride.model || studio.effective.scripts.model || undefined
  const apiUrl = routeOverride.apiUrl || studio.effective.scripts.apiUrl || undefined
  const startedAt = Date.now()
  if (!isOpenAICompatibleProvider(provider)) {
    const review = reviewBlueprintLocally({ formula: expectedFormula, report: compiled.report, validation })
    try {
      await writeJson(cachePath, {
        schemaVersion: '1.0',
        updatedAt: nowIso(),
        projectId: id,
        scriptsUpdatedAt: String(scripts && scripts.updatedAt || ''),
        formula: expectedFormula || null,
        review,
        meta: { provider: 'local', durationMs: Math.max(0, Date.now() - startedAt) }
      })
    } catch (_) {}
    return c.json({
      success: true,
      review,
      meta: { provider: 'local', durationMs: Math.max(0, Date.now() - startedAt) },
      report: compiled.report,
      validation
    })
  }

  try {
    const ai = await reviewBlueprintViaOpenAI({
      projectTitle: project && project.title ? String(project.title) : '',
      formula: expectedFormula,
      scripts,
      report: compiled.report,
      validation,
      provider,
      apiUrl,
      model
    })
    const reviewMeta = {
      ...(ai.meta || {}),
      routeId: routeOverride.routeId || null,
      strictRoute: Boolean(routeOverride.strict)
    }
    try {
      console.log(
        `[gamestudio] ai.blueprint_review project=${id} provider=${reviewMeta.provider || provider || 'localoxml'} model=${reviewMeta.model || '-'} api=${reviewMeta.api || '-'} routeId=${reviewMeta.routeId || 'default'} ms=${reviewMeta.durationMs || 0}`
      )
    } catch (_) {}
    try {
      await writeJson(cachePath, {
        schemaVersion: '1.0',
        updatedAt: nowIso(),
        projectId: id,
        scriptsUpdatedAt: String(scripts && scripts.updatedAt || ''),
        formula: expectedFormula || null,
        review: ai.review,
        meta: reviewMeta
      })
    } catch (_) {}
    return c.json({ success: true, review: ai.review, meta: reviewMeta, report: compiled.report, validation })
  } catch (e) {
    try {
      console.error('[gamestudio] ai blueprint review failed:', e instanceof Error ? e.message : String(e))
    } catch (_) {}
    const review = reviewBlueprintLocally({ formula: expectedFormula, report: compiled.report, validation })
    try {
      await writeJson(cachePath, {
        schemaVersion: '1.0',
        updatedAt: nowIso(),
        projectId: id,
        scriptsUpdatedAt: String(scripts && scripts.updatedAt || ''),
        formula: expectedFormula || null,
        review,
        meta: { provider: 'local', durationMs: Math.max(0, Date.now() - startedAt) }
      })
    } catch (_) {}
    return c.json({
      success: true,
      review,
      meta: { provider: 'local', durationMs: Math.max(0, Date.now() - startedAt) },
      report: compiled.report,
      validation
    })
  }
})

app.post('/api/projects/:id/ai/fix/scripts', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.scripts) {
    return c.json({ success: false, error: 'disabled', message: '“写故事（脚本生成）”已在设置中关闭' }, 503)
  }

  let meta = null
  try { meta = await readJson(path.join(dir, 'meta.json')) } catch (_) { meta = null }
  let project = null
  try { project = await readJson(path.join(dir, 'project.json')) } catch (_) { project = null }
  let scripts = null
  try { scripts = await readJson(path.join(dir, 'scripts.json')) } catch (_) { scripts = defaultScripts() }
  let currBlueprint = null
  try { currBlueprint = await readJson(path.join(dir, 'blueprint.json')) } catch (_) { currBlueprint = null }

  const expectedFormula = meta && typeof meta === 'object' ? meta.aiFormula : null
  const compiledBefore = compileBlueprintFromScripts({ scripts, prevBlueprint: currBlueprint, expectedFormula })
  const validationBefore = validateBlueprintDoc(compiledBefore.blueprint)

  const requestedProvider = String(studio.effective.scripts.provider || 'local').toLowerCase()
  const requestedModel = studio.effective.scripts.model || null
  const globalRules = await readGlobalRules(ROOT)

  const startedAt = Date.now()
  let fixed = null
  try {
    fixed = await repairScriptDraft({
      projectTitle: project && project.title ? String(project.title) : '',
      scripts,
      rules: globalRules,
      formula: expectedFormula,
      report: compiledBefore.report,
      validation: validationBefore,
      provider: requestedProvider,
      model: requestedModel || undefined,
      apiUrl: studio.effective.scripts.apiUrl || undefined,
      proxyUrl: studio.effective.network.proxyUrl
    })
  } catch (e) {
    try {
      const msg = e instanceof Error ? e.message : String(e)
      const cause = (e && typeof e === 'object' && 'cause' in e) ? e.cause : null
      const causeMsg = cause && typeof cause === 'object' && cause.message ? String(cause.message) : (cause ? String(cause) : '')
      const causeCode = cause && typeof cause === 'object' && cause.code ? String(cause.code) : ''
      console.error('[gamestudio] ai fix scripts failed:', msg, causeMsg ? `cause=${causeMsg}` : '', causeCode ? `code=${causeCode}` : '')
    } catch (_) {}
    return c.json({ success: false, error: 'ai_failed', message: e instanceof Error ? e.message : String(e) }, 502)
  }

  if (!fixed || typeof fixed !== 'object' || !fixed.draft || typeof fixed.draft !== 'object' || !Array.isArray(fixed.draft.cards)) {
    return c.json({ success: false, error: 'no_ai_provider', message: '当前未启用 AI 修复（provider=local）' }, 501)
  }

  const cardsIn = fixed.draft.cards
  const prevCards = scripts && typeof scripts === 'object' && Array.isArray(scripts.cards) ? scripts.cards : []
  const preserveIds = prevCards.length > 0 && prevCards.length === cardsIn.length
  const cardsOut = cardsIn
    .map((x, i) => {
      const base = preserveIds ? prevCards[i] : null
      const idUse = base && base.id ? String(base.id) : genId('sc')
      const orderUse = base && base.order != null ? Number(base.order) : i + 1
      return {
        id: idUse,
        name: String(x && x.name ? x.name : `场景${i + 1}`),
        order: orderUse || (i + 1),
        text: String(x && x.text ? x.text : ''),
        updatedAt: nowIso()
      }
    })
    .filter((c) => c.text.trim())

  const nextScripts = { schemaVersion: '1.0', cards: cardsOut, updatedAt: nowIso() }
  await writeJson(path.join(dir, 'scripts.json'), nextScripts)

  const compiledAfter = compileBlueprintFromScripts({ scripts: nextScripts, prevBlueprint: currBlueprint, expectedFormula })
  const validationAfter = validateBlueprintDoc(compiledAfter.blueprint)

  await writeJson(path.join(dir, 'blueprint.json'), compiledAfter.blueprint)
  await touchProjectUpdatedAt(dir)

  const durationMs = Math.max(0, Date.now() - startedAt)
  try {
    console.log(
      `[gamestudio] ai.scripts_fix project=${id} requestedProvider=${requestedProvider}${requestedModel ? ` model=${requestedModel}` : ''} provider=${fixed?.meta?.provider || 'unknown'} model=${fixed?.meta?.model || '-'} api=${fixed?.meta?.api || '-'} okBefore=${validationBefore?.ok ? 'true' : 'false'} okAfter=${validationAfter?.ok ? 'true' : 'false'} cards=${cardsOut.length} ms=${durationMs}`
    )
  } catch (_) {}

  return c.json({
    success: true,
    scripts: nextScripts,
    meta: fixed.meta || { provider: requestedProvider, model: requestedModel, api: null, durationMs },
    before: { report: compiledBefore.report, validation: validationBefore },
    after: { blueprint: compiledAfter.blueprint, report: compiledAfter.report, validation: validationAfter }
  })
})

app.get('/api/projects/:id/ai/review/blueprint', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const cachePath = path.join(dir, 'ai_blueprint_review.json')
  try {
    const cached = await readJson(cachePath)
    return c.json({ success: true, cached })
  } catch (_) {
    return c.json({ success: true, cached: null })
  }
})

app.get('/api/projects/:id', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const p0 = await readJson(path.join(dir, 'project.json'))
  const { project, changed } = normalizeProjectAndDetectChanges(p0)
  if (changed) await writeJson(path.join(dir, 'project.json'), project)
  const story = await readJson(path.join(dir, 'story.json'))
  return c.json({ success: true, project, story })
})

app.put('/api/projects/:id', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const project = body?.project && typeof body.project === 'object' ? body.project : null
  const story = body?.story && typeof body.story === 'object' ? body.story : null

  const curr0 = await readJson(path.join(dir, 'project.json'))
  const { project: curr } = normalizeProjectAndDetectChanges(curr0)
  // 乐观锁（2026-08-31）：所有项目更新必须携带当前 _rev；缺失或版本不符一律拒绝并返回最新文档。
  // 旧内存态整体覆盖服务端状态（提示词/计划被回滚）的根修——与创作缓冲快照互补。
  const currRev = Number(curr && curr._rev) || 0
  const bodyRev = body && body._rev != null ? Number(body._rev) : null
  if (bodyRev == null || bodyRev !== currRev) {
    return c.json({ success: false, error: 'rev_conflict', message: '项目在其他地方已更新，请刷新后重试。', project: curr, _rev: currRev }, 409)
  }
  let mergedProject = project ? { ...curr, ...project, id, updatedAt: nowIso() } : { ...curr, updatedAt: nowIso() }
  mergedProject = { ...mergedProject, _rev: currRev + 1 }
  if (project && Array.isArray(project.assets)) {
    const incomingAssets0 = Array.isArray(project.assets) ? project.assets : []
    // 2026-09-12 陈旧 URI 守卫（实测事故：编辑器旧内存把已压缩/已迁移的 .png 旧路径整批回写，
    // 覆盖磁盘上真实存在的 .webp 新路径，assets[] 出现 26 条悬挂引用）。规则：入站 uri 指向
    // assets/ai/ 且文件不存在，而磁盘同 id 资产 uri 文件真实存在时，以磁盘 uri 为准。
    const diskAssetUriById = new Map(
      (Array.isArray(curr.assets) ? curr.assets : []).map((item) => [String(item && item.id || '').trim(), String(item && item.uri || '').trim()])
    )
    const incomingAssets = incomingAssets0.map((item) => {
      if (!item || typeof item !== 'object') return item
      const uri = String(item.uri || '').trim()
      if (!uri.startsWith('assets/ai/')) return item
      if (existsSync(path.join(dir, uri))) return item
      const itemId = String(item.id || '').trim()
      const diskUri = diskAssetUriById.get(itemId) || ''
      if (diskUri && existsSync(path.join(dir, diskUri))) {
        return { ...item, uri: diskUri }
      }
      return item
    })
    const incomingKeys = new Set(incomingAssets.map((item) => `${String(item && item.id || '').trim()}::${normalizeStoryAssetUri(item && item.uri)}`))
    // 2026-09-01 修复资产重复：入站已有同 id 且 uri 非空的条目时，不再保留磁盘旧条目。
    // 旧逻辑按 id::uri 判重——同 id 换了 uri（如动作立绘覆盖托管立绘）会把旧条目追加回去，
    // 每次保存多一条同 id 副本，project.json 资产数组无限膨胀。
    const incomingIdsWithUri = new Set(
      incomingAssets
        .filter((item) => normalizeStoryAssetUri(item && item.uri))
        .map((item) => String(item && item.id || '').trim())
    )
    const preservedManagedAssets = Array.isArray(curr.assets)
      ? curr.assets.filter((item) => {
          const uri = normalizeStoryAssetUri(item && item.uri)
          if (!uri) return false
          const managed = (
            uri.startsWith('assets/ai/story_assets/') ||
            uri.startsWith('assets/ai/story_lineart/') ||
            uri.startsWith('assets/ai/story_lock_tests/')
          )
          if (!managed) return false
          const itemId = String(item && item.id || '').trim()
          if (incomingIdsWithUri.has(itemId)) return false
          const key = `${itemId}::${uri}`
          return !incomingKeys.has(key)
        })
      : []
    // 2026-09-03 引用保护（用户实测数据丢失类根因）：旧会话保存把"它没见过的新资产"从 assets 里顶掉，
    // 摆放引用落空画布变白。凡被当前磁盘真相引用的资产（摆放/角色默认/主参考/计划主参考/姿势变体），
    // 入站缺失时一律保留，不论 uri 前缀。
    const referencedIds = new Set()
    try {
      for (const ch of (Array.isArray(curr.characters) ? curr.characters : [])) {
        const a1 = String(ch && ch.imageAssetId || '').trim()
        const a2 = String(ch && ch.ai && ch.ai.referenceAssetId || '').trim()
        if (a1) referencedIds.add(a1)
        if (a2) referencedIds.add(a2)
      }
      const diskStory = await readJson(path.join(dir, 'story.json')).catch(() => null)
      for (const n of (diskStory && Array.isArray(diskStory.nodes) ? diskStory.nodes : [])) {
        const pls = Array.isArray(n && n.visuals && n.visuals.placements) ? n.visuals.placements : []
        for (const p of pls) {
          const a1 = String(p && p.imageAssetId || '').trim()
          if (a1) referencedIds.add(a1)
        }
        const bg = String(n && n.visuals && n.visuals.backgroundAssetId || '').trim()
        if (bg) referencedIds.add(bg)
      }
      const curPlan = curr.state && curr.state.aiBackground && curr.state.aiBackground.storyAssetPlan
      for (const pa of (curPlan && Array.isArray(curPlan.assets) ? curPlan.assets : [])) {
        const p1 = String(pa && pa.primaryReferenceAssetId || '').trim()
        if (p1) referencedIds.add(p1)
        for (const v of (pa && Array.isArray(pa.poseVariants) ? pa.poseVariants : [])) {
          const pv = String(v && v.projectAssetId || '').trim()
          if (pv) referencedIds.add(pv)
        }
      }
    } catch (_) { /* 引用扫描失败不阻断保存 */ }
    const preservedReferencedAssets = Array.isArray(curr.assets)
      ? curr.assets.filter((item) => {
          const itemId = String(item && item.id || '').trim()
          if (!itemId || !referencedIds.has(itemId)) return false
          return !incomingIdsWithUri.has(itemId)
        })
      : []
    // 同 id 去重（保留先出现者 = 入站最新版本），清理历史遗留的重复条目
    const seenAssetIds = new Set()
    const dedupedAssets = [...incomingAssets, ...preservedManagedAssets, ...preservedReferencedAssets].filter((item) => {
      const itemId = String(item && item.id || '').trim()
      if (!itemId) return true
      if (seenAssetIds.has(itemId)) return false
      seenAssetIds.add(itemId)
      return true
    })
    mergedProject = {
      ...mergedProject,
      assets: dedupedAssets
    }
  }
  const next0 = mergedProject
  // 2026-09-01 防污染守卫（服务端，以磁盘真相为准）：弱/空的提示词字段不得覆盖磁盘上更完整的值。
  // 背景：编辑器 sbReq 种子链会把占位垃圾（"故事名：《xx》"、"text, watermark…"）反复写回，清空辛苦恢复的提示词。
  try {
    const weak = (v) => {
      const s = String(v || '').trim()
      return !s || /^story title\s*:/i.test(s) || /^故事名：《.*》$/.test(s) || s.length < 80
    }
    // 2026-09-10 占位垃圾清洗（最后防线，配合编辑器断源与存量清洗脚本）：
    // 匹配"故事名：《…》"/"story title: …"模式的值永远不落盘，入站即置空。
    const junkPlaceholder = (v) => {
      const s = String(v || '').trim()
      return !!s && (/^story title\s*:/i.test(s) || /^故事名：《.*》$/.test(s))
    }
    const inAiBg = next0.state && typeof next0.state === 'object' ? next0.state.aiBackground : null
    const curAiBg = curr.state && typeof curr.state === 'object' ? curr.state.aiBackground : null
    if (inAiBg && typeof inAiBg === 'object') {
      for (const k of ['globalPrompt', 'globalNegativePrompt', 'storyboardGlobalPromptZh', 'storyboardGlobalNegativePromptZh']) {
        if (junkPlaceholder(inAiBg[k])) inAiBg[k] = ''
      }
      const inGlobalJunk = typeof inAiBg.global === 'object' && inAiBg.global ? inAiBg.global : null
      if (inGlobalJunk) {
        if (junkPlaceholder(inGlobalJunk.prompt)) inGlobalJunk.prompt = ''
        if (junkPlaceholder(inGlobalJunk.negativePrompt)) inGlobalJunk.negativePrompt = ''
      }
    }
    if (inAiBg && curAiBg && typeof inAiBg === 'object' && typeof curAiBg === 'object') {
      const inGlobal = typeof inAiBg.global === 'object' && inAiBg.global ? inAiBg.global : null
      const curGlobal = typeof curAiBg.global === 'object' && curAiBg.global ? curAiBg.global : null
      // 顶层与嵌套 global.prompt 是双写分裂位（normalize 时嵌套优先），两列都要守
      const pairs = [
        ['globalPrompt', inAiBg, curAiBg],
        ['globalNegativePrompt', inAiBg, curAiBg],
        ['storyboardGlobalPromptZh', inAiBg, curAiBg],
        ['storyboardGlobalNegativePromptZh', inAiBg, curAiBg],
        ...(inGlobal && curGlobal ? [['prompt', inGlobal, curGlobal], ['negativePrompt', inGlobal, curGlobal]] : [])
      ]
      for (const [k, inObj, curObj] of pairs) {
        if (weak(inObj[k]) && !weak(curObj[k])) inObj[k] = curObj[k]
      }

      const inMap = inAiBg.storyboardLockAssetPrompts
      const curMap = curAiBg.storyboardLockAssetPrompts
      if (curMap && typeof curMap === 'object') {
        if (!inMap || typeof inMap !== 'object' || Object.keys(inMap).length === 0) {
          // 入站整表为空而磁盘有内容：保留磁盘整表
          inAiBg.storyboardLockAssetPrompts = curMap
        } else {
          // 2026-09-01 扩展为并集合并：旧会话内存缺条目（如后加的猪妈妈/工具包）时，整表覆盖会把磁盘条目抹掉。
          // 磁盘条目在入站缺失时保留；入站存在的条目按字段级补齐空值。
          const mergedMap = { ...inMap }
          for (const [aid, entry] of Object.entries(inMap)) {
            const curE = curMap[aid]
            if (!curE || typeof curE !== 'object' || !entry || typeof entry !== 'object') continue
            const filled = { ...entry }
            for (const f of ['promptZh', 'promptEn', 'negativePromptZh', 'negativePrompt']) {
              const iv = String(entry[f] || '').trim()
              const cv = String(curE[f] || '').trim()
              if (!iv && cv) filled[f] = curE[f]
            }
            mergedMap[aid] = filled
          }
          for (const [aid, curE] of Object.entries(curMap)) {
            if (!(aid in mergedMap)) mergedMap[aid] = curE
          }
          inAiBg.storyboardLockAssetPrompts = mergedMap
        }
      }
      // storyboardScenes 同样并集合并：旧会话缺场景条目时不得抹掉磁盘上已写好的场景提示词
      const inScenes = inAiBg.storyboardScenes
      const curScenes = curAiBg.storyboardScenes
      if (curScenes && typeof curScenes === 'object') {
        if (!inScenes || typeof inScenes !== 'object' || Object.keys(inScenes).length === 0) {
          inAiBg.storyboardScenes = curScenes
        } else {
          const mergedScenes = { ...inScenes }
          for (const [nid, entry] of Object.entries(inScenes)) {
            const curE = curScenes[nid]
            if (!curE || typeof curE !== 'object' || !entry || typeof entry !== 'object') continue
            const filled = { ...entry }
            for (const f of ['prompt', 'promptZh', 'negativePrompt', 'negativePromptZh']) {
              const iv = String(entry[f] || '').trim()
              const cv = String(curE[f] || '').trim()
              if (!iv && cv) filled[f] = curE[f]
            }
            mergedScenes[nid] = filled
          }
          for (const [nid, curE] of Object.entries(curScenes)) {
            if (!(nid in mergedScenes)) mergedScenes[nid] = curE
          }
          inAiBg.storyboardScenes = mergedScenes
        }
      }
      // 2026-09-01 资产计划与确认时间戳同样以磁盘为准：编辑器内存缺值时（整表 delete 语义）不得抹掉磁盘真相。
      // 根因：buildStoryboardLockProjectSnapshot 在内存无值时 delete 这两个字段，浅合并后磁盘字段随之丢失，向导被打回「待确认」。
      if (!inAiBg.storyAssetPlan && curAiBg.storyAssetPlan && typeof curAiBg.storyAssetPlan === 'object') {
        inAiBg.storyAssetPlan = curAiBg.storyAssetPlan
      }
      if (!String(inAiBg.storyAssetPlanConfirmedAt || '').trim() && String(curAiBg.storyAssetPlanConfirmedAt || '').trim()) {
        inAiBg.storyAssetPlanConfirmedAt = curAiBg.storyAssetPlanConfirmedAt
      }
    }
  } catch (_) { /* 守卫失败不阻断保存 */ }
  const next = normalizeProjectDoc(next0)
  // 写前快照（创作缓冲）：PUT 是提示词/文档被覆盖的主要通道，先留快照再写
  await snapshotCreationState(dir, { reason: 'project_put' })
  await writeJson(path.join(dir, 'project.json'), next)
  if (story) await writeJson(path.join(dir, 'story.json'), story)
  recordCreationEvent(dir, {
    type: 'project_update',
    summary: `项目文档更新（project${story ? ' + story' : ''}）`,
    actor: 'editor'
  })

  // Keep meta.json title in sync for Hub list display.
  try {
    const title = (project && typeof project.title === 'string') ? String(project.title) : null
    if (title != null) {
      const metaPath = path.join(dir, 'meta.json')
      const meta = (await existsFile(metaPath)) ? await readJson(metaPath) : null
      if (meta && typeof meta === 'object') {
        await writeJson(metaPath, { ...meta, title: String(title), updatedAt: nowIso() })
      }
    }
  } catch (_) {}

  return c.json({ success: true, project: next })
})

app.delete('/api/projects/:id', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  try {
    await rm(dir, { recursive: true, force: true })
  } catch (e) {
    return c.json({ success: false, error: 'delete_failed', message: e && e.message ? e.message : String(e) }, 500)
  }

  // best-effort: remove exported builds for project
  try {
    await rm(projectBuildsDir(id), { recursive: true, force: true })
  } catch (_) {}

  return c.json({ success: true })
})




// ===== 三层工作流：脚本层 / 蓝图层（P0） =====

app.get('/api/projects/:id/scripts', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const pth = path.join(dir, 'scripts.json')
  let scripts = null
  try {
    scripts = await readJson(pth)
  } catch (_) {
    scripts = defaultScripts()
    await writeJson(pth, scripts)
  }

  return c.json({ success: true, scripts })
})

app.put('/api/projects/:id/scripts', storyInputGate('story.scripts.write', (c, body) => ({ projectId: c.req.param('id'), scripts: body?.scripts })), async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const next = body && typeof body === 'object' && body.scripts && typeof body.scripts === 'object' ? body.scripts : body

  const cardsIn = Array.isArray(next && next.cards) ? next.cards : []
  const cards = cardsIn.map((x, i) => ({
    id: String(x && x.id || ''),
    name: String(x && x.name || `脚本${i + 1}`),
    order: Number.isFinite(Number(x && x.order)) ? Number(x.order) : (i + 1),
    text: String(x && x.text || ''),
    updatedAt: String(x && x.updatedAt || nowIso())
  })).filter((c) => c.id)

  const scripts = {
    schemaVersion: '1.0',
    cards,
    updatedAt: nowIso()
  }

  await writeJson(path.join(dir, 'scripts.json'), scripts)
  await touchProjectUpdatedAt(dir)
  return c.json({ success: true, scripts })
})

app.get('/api/projects/:id/blueprint', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const pth = path.join(dir, 'blueprint.json')
  let blueprint = null
  try {
    blueprint = await readJson(pth)
  } catch (_) {
    blueprint = defaultBlueprint()
    await writeJson(pth, blueprint)
  }

  return c.json({ success: true, blueprint })
})

app.put('/api/projects/:id/blueprint', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const next = body && typeof body === 'object' && body.blueprint && typeof body.blueprint === 'object' ? body.blueprint : body

  const placeholdersIn = Array.isArray(next && next.placeholders) ? next.placeholders : []
  const nodesIn = Array.isArray(next && next.nodes) ? next.nodes : []

  const placeholders = placeholdersIn.map((p) => ({
    id: String(p && p.id || ''),
    kind: String(p && p.kind || ''),
    name: String(p && p.name || ''),
    tags: Array.isArray(p && p.tags) ? p.tags.map((t) => String(t)) : []
  })).filter((p) => p.id)

  const nodes = nodesIn.map((n) => ({
    id: String(n && n.id || ''),
    scriptCardId: String(n && n.scriptCardId || ''),
    name: String(n && n.name || ''),
    kind: String(n && n.kind || 'scene'),
    textDraft: (n && typeof n.textDraft === 'string') ? n.textDraft : '',
    backgroundId: n && n.backgroundId ? String(n.backgroundId) : undefined,
    actorIds: Array.isArray(n && n.actorIds) ? n.actorIds.map((x) => String(x)) : [],
    eventIds: Array.isArray(n && n.eventIds) ? n.eventIds.map((x) => String(x)) : [],
    choices: Array.isArray(n && n.choices) ? n.choices.map((c) => ({
      id: String(c && c.id || ''),
      text: String(c && c.text || ''),
      toNodeId: String(c && c.toNodeId || '')
    })) : []
  })).filter((n) => n.id)

  const blueprint = {
    schemaVersion: '1.0',
    startNodeId: String(next && next.startNodeId || ''),
    placeholders,
    nodes,
    updatedAt: nowIso()
  }

  await writeJson(path.join(dir, 'blueprint.json'), blueprint)
  await touchProjectUpdatedAt(dir)
  return c.json({ success: true, blueprint })
})

// Script → Blueprint（P0：merge/update）
app.post('/api/projects/:id/compile/blueprint', storyInputGate('story.blueprint.compile', (c) => ({ projectId: c.req.param('id') })), async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  let currBlueprint = null
  try {
    currBlueprint = await readJson(path.join(dir, 'blueprint.json'))
  } catch (_) {
    currBlueprint = null
  }

  let meta = null
  try {
    meta = await readJson(path.join(dir, 'meta.json'))
  } catch (_) {
    meta = null
  }

  let scripts = null
  try {
    scripts = await readJson(path.join(dir, 'scripts.json'))
  } catch (_) {
    scripts = defaultScripts()
    await writeJson(path.join(dir, 'scripts.json'), scripts)
  }

  const expectedFormula = meta && typeof meta === 'object' ? meta.aiFormula : null
  const compiled = compileBlueprintFromScripts({ scripts, prevBlueprint: currBlueprint, expectedFormula })
  const blueprint = compiled.blueprint
  const validation = validateBlueprintDoc(blueprint)

  await writeJson(path.join(dir, 'blueprint.json'), blueprint)
  await touchProjectUpdatedAt(dir)
  return c.json({ success: true, blueprint, report: compiled.report, validation })
})

// Blueprint → Compose（P0：overwrite/reset）
app.post('/api/projects/:id/compile/compose', storyInputGate('story.compose.compile', (c) => ({ projectId: c.req.param('id') })), async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  let currProject = null
  try {
    currProject = await readJson(path.join(dir, 'project.json'))
  } catch (_) {
    currProject = null
  }

  let currStory = null
  try {
    currStory = await readJson(path.join(dir, 'story.json'))
  } catch (_) {
    currStory = null
  }

  let blueprint = null
  try {
    blueprint = await readJson(path.join(dir, 'blueprint.json'))
  } catch (_) {
    blueprint = defaultBlueprint()
    await writeJson(path.join(dir, 'blueprint.json'), blueprint)
  }

  const placeholders = Array.isArray(blueprint && blueprint.placeholders) ? blueprint.placeholders : []
  const nodes = Array.isArray(blueprint && blueprint.nodes) ? blueprint.nodes : []
  const startNodeId = String(blueprint && blueprint.startNodeId || '')
  if (!startNodeId) return c.json({ success: false, error: 'missing_startNodeId', message: 'blueprint.startNodeId 为空' }, 400)

  const actorPlaceholders = placeholders.filter((p) => String(p && p.kind) === 'actor')
  const bgPlaceholders = placeholders.filter((p) => String(p && p.kind) === 'background')

  const existingCharacters = Array.isArray(currProject && currProject.characters) ? currProject.characters : []
  const existingCharacterById = new Map(existingCharacters.map((x) => [String(x && x.id || ''), x]).filter(([id]) => id))

  const placeholderCharacters = actorPlaceholders
    .map((p) => ({ id: String(p && p.id || ''), name: String(p && p.name || '') }))
    .filter((c) => c.id)

  const characters = placeholderCharacters.map((c) => {
    const prev = existingCharacterById.get(c.id) || null
    if (!prev) return c
    return { ...prev, id: c.id, name: (prev.name ? String(prev.name) : c.name) }
  })

  const existingAssets = Array.isArray(currProject && currProject.assets) ? currProject.assets : []
  const existingAssetById = new Map(existingAssets.map((x) => [String(x && x.id || ''), x]).filter(([id]) => id))

  const placeholderAssets = bgPlaceholders
    .map((p) => ({ id: String(p && p.id || ''), kind: 'image', name: String(p && p.name || ''), uri: '' }))
    .filter((a) => a.id)

  const assets = placeholderAssets.map((a) => {
    const prev = existingAssetById.get(a.id) || null
    if (!prev) return a
    return { ...a, ...prev, id: a.id, kind: 'image', name: (prev.name ? String(prev.name) : a.name) }
  })

  const existingStoryNodes = Array.isArray(currStory && currStory.nodes) ? currStory.nodes : []
  const existingNodeById = new Map(existingStoryNodes.map((x) => [String(x && x.id || ''), x]).filter(([id]) => id))

  const storyNodes = nodes
    .map((n) => {
      const nodeId = String(n && n.id || '')
      const kind = String(n && n.kind || 'scene')
      const choices = Array.isArray(n && n.choices) ? n.choices.map((c) => ({
        id: String(c && c.id || ''),
        text: String(c && c.text || ''),
        toNodeId: String(c && c.toNodeId || ''),
        effects: [],
        visibleWhen: null,
        enabledWhen: null
      })) : []

      const actorIds = Array.isArray(n && n.actorIds) ? n.actorIds.map((x) => String(x)) : []
      const desiredActorIds = actorIds.filter(Boolean)

      const defaultPlacements = desiredActorIds.map((actorId) => ({
        id: `pl_${nodeId}_${actorId}`,
        characterId: actorId,
        transform: { x: 0.5, y: 1, scale: 1, rotationDeg: 0 },
        visible: true,
        zIndex: 0
      }))

      const visuals = { placements: defaultPlacements }
      if (n && n.backgroundId) visuals.backgroundAssetId = String(n.backgroundId)

      const textDraft = String(n && n.textDraft || '')
      const isEnding = kind === 'ending'
      // 2026-09-27 结局卡文本层清理：title 取正文首行（如"空桶叹息"/"满载而归"），moral 不再重复该首行标题；
      // 正文不足两行时 title 回退节点名、moral 取全文
      const endingLines = isEnding ? textDraft.split('\n').map((ln) => ln.trim()).filter(Boolean) : []
      const endingTitle = endingLines.length > 1 ? endingLines[0] : ''
      const endingMoral = (endingTitle ? endingLines.slice(1).join('\n').trim() : textDraft.trim()) || '故事结束。'
      const timeline = {
        steps: [
          isEnding
            ? {
                id: `st_${nodeId}_1`,
                actions: [
                  {
                    type: 'ui.showEndingCard',
                    card: {
                      title: endingTitle || String(n && n.name || nodeId),
                      bullets: [],
                      moral: endingMoral,
                      buttons: [
                        { type: 'restart', label: '重新开始' },
                        { type: 'backToHub', label: '返回工作台' }
                      ]
                    }
                  }
                ],
                advance: { type: 'end' }
              }
            : {
                id: `st_${nodeId}_1`,
                actions: [{ type: 'ui.setText', mode: 'replace', text: textDraft }],
                advance: { type: choices.length ? 'choice' : 'click' }
              }
        ]
      }

      const out = {
        id: nodeId,
        name: String(n && n.name || nodeId),
        kind: (kind === 'ending' ? 'ending' : 'scene'),
        body: { text: textDraft },
        timeline,
        visuals,
        // 预留：P0 只做占位记录，P1 可用于事件执行
        blueprint: {
          scriptCardId: String(n && n.scriptCardId || ''),
          backgroundId: n && n.backgroundId ? String(n.backgroundId) : undefined,
          actorIds,
          eventIds: Array.isArray(n && n.eventIds) ? n.eventIds.map((x) => String(x)) : []
        }
      }
      if (kind !== 'ending') out.choices = choices

      const prev = existingNodeById.get(nodeId) || null
      if (!prev || typeof prev !== 'object') return out

      // Merge policy:
      // - Structure (kind/id/choices targets) from blueprint
      // - Presentation (timeline/visuals/body text) keep existing when present
      const prevBody = (prev && typeof prev.body === 'object' && prev.body) ? prev.body : null
      const prevText = prevBody && typeof prevBody.text === 'string' ? prevBody.text : ''
      const mergedBody = {
        ...out.body,
        ...(prevBody || {}),
        text: prevText && prevText.trim() ? prevText : out.body.text
      }

      const prevVisuals = (prev && typeof prev.visuals === 'object' && prev.visuals) ? prev.visuals : null
      const prevTimeline = (prev && typeof prev.timeline === 'object' && prev.timeline) ? prev.timeline : null

      const mergedVisuals = prevVisuals ? { ...out.visuals, ...prevVisuals } : out.visuals

      // Ensure placements reflect desired actor ids (keep existing transforms when possible)
      // 2026-09-08 事故修复：分层合成工艺后 placements 是人工/工具编排的产物（道具层 characterId 为空、
      // 角色层 imageAssetId 指向姿势变体）。原逻辑用 blueprint.actorIds 重建摆位：actorIds 为空时
      // nextPlacements=[] 清空全部摆位；prop 摆位（characterId=''）被 prevByActor 的 truthy 过滤丢弃。
      // 新策略：prev 已有摆位则保留——desiredActorIds 非空时仅剔除「不再出场且仍指向角色默认图」的条目、
      // 为新增 actor 补默认摆位；actorIds 为空时 prev 摆位原样保留（结构归 blueprint，呈现归既有 story）。
      try {
        const prevPlacements = Array.isArray(prevVisuals && prevVisuals.placements) ? prevVisuals.placements : []
        if (prevPlacements.length && desiredActorIds.length === 0) {
          mergedVisuals.placements = prevPlacements
        } else if (prevPlacements.length) {
          const desired = new Set(desiredActorIds)
          const kept = prevPlacements.filter((p) => {
            const cid = String(p && p.characterId || '')
            if (!cid) return true // 道具层永远保留
            if (desired.has(cid)) return true
            // 蓝图移除该角色时，仅当摆位仍指角色默认图（未绑姿势变体）才剔除；绑了姿势变体的视为人工编排，保留
            return Boolean(String(p && p.imageAssetId || '').trim())
          })
          const existingActorIds = new Set(kept.map((p) => String(p && p.characterId || '')).filter(Boolean))
          for (const actorId of desiredActorIds) {
            if (existingActorIds.has(actorId)) continue
            kept.push({
              id: `pl_${nodeId}_${actorId}`,
              characterId: actorId,
              transform: { x: 0.5, y: 1, scale: 1, rotationDeg: 0 },
              visible: true,
              zIndex: 0
            })
          }
          mergedVisuals.placements = kept
        } else {
          mergedVisuals.placements = desiredActorIds.map((actorId) => ({
            id: `pl_${nodeId}_${actorId}`,
            characterId: actorId,
            transform: { x: 0.5, y: 1, scale: 1, rotationDeg: 0 },
            visible: true,
            zIndex: 0
          }))
        }
      } catch (_) {}

      // Background: keep existing if set, else use blueprint backgroundId
      try {
        if (prevVisuals && prevVisuals.backgroundAssetId) mergedVisuals.backgroundAssetId = String(prevVisuals.backgroundAssetId)
      } catch (_) {}

      // Choices: keep existing effects/conditions when ids match; but enforce graph targets/text from blueprint
      let mergedChoices = out.choices
      if (out.kind === 'scene') {
        const prevChoices = Array.isArray(prev && prev.choices) ? prev.choices : []
        const prevById = new Map(prevChoices.map((c) => [String(c && c.id || ''), c]).filter(([id]) => id))
        mergedChoices = (out.choices || []).map((c) => {
          const keep = prevById.get(c.id) || null
          if (!keep) return c
          return { ...c, ...keep, id: c.id, text: c.text, toNodeId: c.toNodeId }
        })
      }

      const merged = {
        ...prev,
        ...out,
        name: (prev && prev.name ? String(prev.name) : out.name),
        body: mergedBody,
        visuals: mergedVisuals,
        timeline: prevTimeline || out.timeline,
        blueprint: out.blueprint
      }
      if (merged.kind === 'scene') merged.choices = mergedChoices
      return merged
    })
    .filter((n) => n.id)

  const story = { schemaVersion: '2.0', startNodeId, nodes: storyNodes }

  const nextProject = normalizeProjectDoc({
    schemaVersion: '2.0',
    id: String(id),
    title: String(currProject && currProject.title || ''),
    pluginId: String(currProject && currProject.pluginId || 'story-pixi'),
    pluginVersion: String(currProject && currProject.pluginVersion || TOOL_VERSION),
    createdAt: String(currProject && currProject.createdAt || nowIso()),
    updatedAt: nowIso(),
    characters: (() => {
      const ids = new Set(characters.map((c) => String(c && c.id || '')).filter(Boolean))
      const rest = existingCharacters.filter((c) => c && c.id && !ids.has(String(c.id)))
      return [...characters, ...rest]
    })(),
    assets: (() => {
      const ids = new Set(assets.map((a) => String(a && a.id || '')).filter(Boolean))
      const rest = existingAssets.filter((a) => a && a.id && !ids.has(String(a.id)))
      return [...assets, ...rest]
    })(),
    events: Array.isArray(currProject && currProject.events) ? currProject.events : [],
    state: (currProject && typeof currProject.state === 'object' && currProject.state) ? currProject.state : { vars: [] },
    stage: (currProject && typeof currProject.stage === 'object' && currProject.stage) ? currProject.stage : undefined
  })

  await writeJson(path.join(dir, 'project.json'), nextProject)
  await writeJson(path.join(dir, 'story.json'), story)
  await touchProjectUpdatedAt(dir)

  return c.json({ success: true, project: nextProject, story })
})

app.get('/api/demos', async (c) => {
  await ensureDirs()
  const items = []
  const dirs = await readdir(DEMO_LIBRARY_DIR).catch(() => [])
  for (const id of dirs) {
    const dir = demoLibDir(id)
    if (!(await existsDir(dir))) continue
    try {
      const story = await readJson(path.join(dir, 'story.json'))
      const nodes = Array.isArray(story && story.nodes) ? story.nodes : []
      let title = String(id)
      let demoProject = null
      try { demoProject = await readJson(path.join(dir, 'project.json')) } catch (_) {}
      try {
        const meta = await readJson(path.join(dir, 'demo.json'))
        if (meta && typeof meta.title === 'string' && meta.title.trim()) title = meta.title.trim()
      } catch (_) {}
      items.push({ id: String(id), title: (demoProject && demoProject.title) ? String(demoProject.title) : title, nodesCount: nodes.length })
    } catch (_) {}
  }
  items.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return c.json({ success: true, items })
})

app.get('/api/demos/:id', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = demoLibDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const story = await readJson(path.join(dir, 'story.json'))
  let title = String(id)
  let demoProject = null
  try { demoProject = await readJson(path.join(dir, 'project.json')) } catch (_) {}
  try {
    const meta = await readJson(path.join(dir, 'demo.json'))
    if (meta && typeof meta.title === 'string' && meta.title.trim()) title = meta.title.trim()
  } catch (_) {}
  return c.json({
    success: true,
    demo: { id: String(id), title: (demoProject && demoProject.title) ? String(demoProject.title) : title, assetBase: `/demo-library/${encodeURIComponent(String(id))}/` },
    project: demoProject || null,
    story
  })
})

app.post('/api/projects/:id/export', storyInputGate('story.export.project', (c) => ({ projectId: c.req.param('id') })), async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const { buildId } = await buildProjectDistForExport(id, dir)

  return c.json({
    success: true,
    buildId,
    distUrl: `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/dist/index.html`
  })
})

app.post('/api/projects/:id/export/publish', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const { buildId, out } = await buildProjectDistForExport(id, dir)
  const zipName = `h5_story_${String(id)}_${String(buildId)}.zip`
  const zipAbs = path.join(out, zipName)
  try {
    await packageDistAsZip(out, zipName)
  } catch (e) {
    return c.json({
      success: false,
      error: 'zip_failed',
      message: e && e.message ? String(e.message) : String(e),
      buildId,
      distUrl: `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/dist/index.html`
    }, 500)
  }
  return c.json({
    success: true,
    buildId,
    distUrl: `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/dist/index.html`,
    packageUrl: `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/${encodeURIComponent(zipName)}`,
    packageName: zipName,
    packageBytes: Number((await stat(zipAbs)).size || 0)
  })
})

app.get('/api/projects/:id/exports', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectBuildsDir(id)
  const items = []
  const buildId = 'latest'
  const buildDir = path.join(dir, buildId)
  if (await existsDir(buildDir)) {
    const distIndex = path.join(buildDir, 'dist', 'index.html')
    const hasDist = await existsFile(distIndex)
    const files = await readdir(buildDir).catch(() => [])
    const zip = files.find((f) => /^h5_story_.*\.zip$/i.test(String(f || '')))
    const st = await stat(buildDir).catch(() => null)
    items.push({
      buildId,
      createdAt: st && st.mtime ? st.mtime.toISOString() : '',
      distUrl: hasDist ? `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/dist/index.html` : '',
      packageUrl: zip ? `/demos/${encodeURIComponent(id)}/${encodeURIComponent(buildId)}/${encodeURIComponent(zip)}` : '',
      packageName: zip || ''
    })
  }
  return c.json({ success: true, items })
})

app.delete('/api/projects/:id/exports/:buildId', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const buildId = String(c.req.param('buildId') || '').trim()
  if (!buildId) return c.json({ success: false, error: 'missing_buildId' }, 400)
  const dir = projectBuildDir(id, buildId)
  if (!(await existsDir(dir))) return c.json({ success: true, removed: false })
  try {
    await rm(dir, { recursive: true, force: true })
    return c.json({ success: true, removed: true })
  } catch (e) {
    return c.json({ success: false, error: 'delete_failed', message: e && e.message ? String(e.message) : String(e) }, 500)
  }
})

// 静态服务 demo 产物（P0：仅 demos）

// 静态服务 demo_library（手动拷贝的 demo 与素材）
app.get('/demo-library/:demoId/:rest{.*}', async (c) => {
  await ensureDirs()
  const demoId = c.req.param('demoId')
  let rest = String(c.req.param('rest') || '')
  try {
    rest = decodeURIComponent(rest)
  } catch (_) {}
  rest = rest.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rest || rest.split('/').some((seg) => seg === '..')) return c.text('Not Found', 404)
  const filePath = path.join(demoLibDir(demoId), rest)
  try {
    const buf = await readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const ct =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      ext === '.js' ? 'application/javascript; charset=utf-8' :
      ext === '.css' ? 'text/css; charset=utf-8' :
      ext in {'.png':1,'.jpg':1,'.jpeg':1,'.gif':1,'.webp':1} ? 'image/' + ext.slice(1) :
      'application/octet-stream'
    c.header('Content-Type', ct)
    return c.body(buf)
  } catch (_) {
    return c.text('Not Found', 404)
  }
})

app.get('/demos/:projectId/:buildId/:rest{.*}', async (c) => {
  await ensureDirs()
  const projectId = c.req.param('projectId')
  const buildId = c.req.param('buildId')
  let rest = String(c.req.param('rest') || '')
  try {
    rest = decodeURIComponent(rest)
  } catch (_) {}
  rest = rest.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rest || rest.split('/').some((seg) => seg === '..')) return c.text('Not Found', 404)
  const baseDir = projectBuildDir(projectId, buildId)
  const filePath = path.join(baseDir, rest)
  try {
    const buf = await readFile(filePath)
    // 简单 content-type
    const ext = path.extname(filePath).toLowerCase()
    const ct =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      ext === '.js' || ext === '.mjs' ? 'application/javascript; charset=utf-8' :
      ext === '.css' ? 'text/css; charset=utf-8' :
      ext === '.zip' ? 'application/zip' :
      'application/octet-stream'
    if (ext === '.zip') c.header('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`)
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    c.header('Pragma', 'no-cache')
    c.header('Expires', '0')
    c.header('Content-Type', ct)
    return c.body(buf)
  } catch (_) {
    return c.text('Not Found', 404)
  }
})


// 静态服务 project assets（用于编辑器预览 assets/...）
// 兼容：/project-assets/<pid>/assets/uploads/<file>
app.get('/project-assets/:projectId/assets/uploads/:file', async (c) => {
  await ensureDirs()
  // Ensure cross-origin image loading works in editor (Pixi/WebGL needs CORS-enabled images).
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  const projectId = c.req.param('projectId')
  const file = path.basename(String(c.req.param('file') || ''))
  if (!file) return c.text('Not Found', 404)
  const filePath = path.join(projectDir(projectId), 'assets', 'uploads', file)
  try {
    const buf = await readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const ct =
      ext === '.png' ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      ext === '.webp' ? 'image/webp' :
      ext === '.gif' ? 'image/gif' :
      'application/octet-stream'
    c.header('Content-Type', ct)
    return c.body(buf)
  } catch (_) {
    return c.text('Not Found', 404)
  }
})

app.on('HEAD', '/project-assets/:projectId/assets/uploads/:file', async (c) => {
  await ensureDirs()
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  const projectId = c.req.param('projectId')
  const file = path.basename(String(c.req.param('file') || ''))
  if (!file) return c.text('Not Found', 404)
  const filePath = path.join(projectDir(projectId), 'assets', 'uploads', file)
  if (!(await existsFile(filePath))) return c.text('Not Found', 404)
  const ext = path.extname(filePath).toLowerCase()
  const ct =
    ext === '.png' ? 'image/png' :
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
    ext === '.webp' ? 'image/webp' :
    ext === '.gif' ? 'image/gif' :
    'application/octet-stream'
  c.header('Content-Type', ct)
  return c.text('', 200)
})

app.get('/project-assets/:projectId/:rest{.*}', async (c) => {
  await ensureDirs()
  // Ensure cross-origin image loading works in editor (Pixi/WebGL needs CORS-enabled images).
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  const projectId = c.req.param('projectId')
  let rest = String(c.req.param('rest') || '')
  try {
    rest = decodeURIComponent(rest)
  } catch (_) {}
  rest = rest.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rest || rest.split('/').some((seg) => seg === '..')) return c.text('Not Found', 404)
  const base = projectDir(projectId)
  const candidates = [path.join(base, rest)]
  if (!rest.startsWith('assets/')) candidates.push(path.join(base, 'assets', rest))
  let filePath = ''
  for (const cand of candidates) {
    if (await existsFile(cand)) {
      filePath = cand
      break
    }
  }
  if (!filePath) return c.text('Not Found', 404)
  try {
    const buf = await readFile(filePath)
    const ext = path.extname(filePath).toLowerCase()
    let ct =
      ext === '.png' ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      ext === '.webp' ? 'image/webp' :
      ext === '.gif' ? 'image/gif' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      'application/octet-stream'
    const sniff = ct.startsWith('image/') ? sniffImageMetaFromBytes(buf) : null
    if (sniff && sniff.contentType) ct = sniff.contentType
    c.header('Content-Type', ct)
    return c.body(buf)
  } catch (_) {
    return c.text('Not Found', 404)
  }
})

app.on('HEAD', '/project-assets/:projectId/:rest{.*}', async (c) => {
  await ensureDirs()
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  const projectId = c.req.param('projectId')
  let rest = String(c.req.param('rest') || '')
  try {
    rest = decodeURIComponent(rest)
  } catch (_) {}
  rest = rest.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rest || rest.split('/').some((seg) => seg === '..')) return c.text('Not Found', 404)
  const base = projectDir(projectId)
  const candidates = [path.join(base, rest)]
  if (!rest.startsWith('assets/')) candidates.push(path.join(base, 'assets', rest))
  let filePath = ''
  for (const cand of candidates) {
    if (await existsFile(cand)) {
      filePath = cand
      break
    }
  }
  if (!filePath) return c.text('Not Found', 404)
  const ext = path.extname(filePath).toLowerCase()
  const ct =
    ext === '.png' ? 'image/png' :
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
    ext === '.webp' ? 'image/webp' :
    ext === '.gif' ? 'image/gif' :
    ext === '.json' ? 'application/json; charset=utf-8' :
    'application/octet-stream'
  c.header('Content-Type', ct)
  return c.text('', 200)
})

// 查看 AI 背景图输出目录（浏览器可打开，便于确认生成位置）
app.get('/api/projects/:id/assets/ai', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.text('Not Found', 404)

  const relDir = path.join('assets', 'ai')
  const outDir = path.join(dir, relDir)
  const items = await readdir(outDir).catch(() => [])
  const files = items
    .map((x) => String(x))
    .filter((x) => /\.(png|jpg|jpeg|webp|gif)$/i.test(x))
    .sort((a, b) => (a < b ? 1 : -1))

  const rows = files
    .map((f) => {
      const safe = encodeURIComponent(f)
      const url = `/project-assets/${encodeURIComponent(String(id))}/${relDir.replace(/\\/g, '/')}/${safe}`
      return `<li><a href="${url}" target="_blank" rel="noopener noreferrer">${f}</a></li>`
    })
    .join('\n')

  const html =
    `<!doctype html><html><head><meta charset="utf-8" />` +
    `<title>AI 背景输出目录</title>` +
    `<style>body{font-family:ui-sans-serif,system-ui;max-width:920px;margin:24px auto;padding:0 16px;line-height:1.6}code{background:#0b1220;color:#e5e7eb;padding:2px 6px;border-radius:6px}a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}</style>` +
    `</head><body>` +
    `<h2>AI 背景输出目录</h2>` +
    `<div>项目：<code>${String(id)}</code></div>` +
    `<div>相对路径：<code>${relDir.replace(/\\/g, '/')}</code></div>` +
    `<div>绝对路径：<code>${outDir}</code></div>` +
    `<hr />` +
    (files.length ? `<ol>${rows}</ol>` : `<div>暂无文件（请先生成背景图）。</div>`) +
    `</body></html>`

  c.header('Content-Type', 'text/html; charset=utf-8')
  return c.body(html)
})

function resolveAssetPathFromUri(projectId, uri) {
  const id = String(projectId || '').trim()
  const raw = String(uri || '').trim()
  if (!id || !raw) return null
  let s = raw
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s)
      s = String(u.pathname || '')
    }
  } catch (_) {}
  s = s.replace(/\\/g, '/')
  const marker = `/project-assets/${encodeURIComponent(String(id))}/`
  if (s.startsWith(marker)) {
    s = s.slice(marker.length)
  } else if (/^\/project-assets\//.test(s)) {
    const pfx = `/project-assets/${encodeURIComponent(String(id))}/`
    if (!s.startsWith(pfx)) return null
    s = s.slice(pfx.length)
  } else if (s.startsWith('/')) {
    s = s.replace(/^\/+/, '')
  }
  if (!s) return null
  if (!/^assets\//.test(s)) {
    if (/^(uploads|ai)\//.test(s)) s = `assets/${s}`
    else if (!/^assets\//.test(s)) s = `assets/${s}`
  }
  const base = projectDir(id)
  const abs = path.resolve(path.join(base, s))
  const baseNorm = path.resolve(base) + path.sep
  if (!(abs + path.sep).startsWith(baseNorm) && abs !== path.resolve(base)) return null
  return abs
}

function isExternallyReachableReferenceUrl(input) {
  const raw = String(input || '').trim()
  if (!/^https?:\/\//i.test(raw)) return false
  try {
    const u = new URL(raw)
    const host = String(u.hostname || '').trim().toLowerCase()
    if (!host) return false
    if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local')) return false
    if (/^127\./.test(host)) return false
    if (/^10\./.test(host)) return false
    if (/^192\.168\./.test(host)) return false
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false
    return true
  } catch (_) {
    return false
  }
}

async function archiveExistingAssetForReplacement(projectId, uri) {
  const abs = resolveAssetPathFromUri(projectId, uri)
  if (!abs) return null
  if (!(await existsFile(abs))) return null
  const parsed = path.parse(abs)
  for (let i = 1; i <= 999; i += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}_old${i}${parsed.ext}`)
    if (await existsFile(candidate)) continue
    await rename(abs, candidate)
    return candidate
  }
  throw new Error('archive_slot_exhausted')
}

function assetPathFromAbsolute(projectId, absPath) {
  const id = String(projectId || '').trim()
  if (!id || !absPath) return null
  const base = path.resolve(projectDir(id))
  const abs = path.resolve(String(absPath))
  const rel = path.relative(base, abs).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..')) return null
  return rel
}

function openFolderOnHost(folder) {
  const target = String(folder || '').trim()
  if (!target) return Promise.reject(new Error('missing_folder'))
  return new Promise((resolve, reject) => {
    let cmd = ''
    let args = []
    if (process.platform === 'darwin') {
      cmd = 'open'
      args = [target]
    } else if (process.platform === 'win32') {
      cmd = 'explorer'
      args = [target]
    } else {
      cmd = 'xdg-open'
      args = [target]
    }
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true })
    p.on('error', (e) => reject(e))
    p.unref()
    resolve(true)
  })
}

app.post('/api/projects/:id/assets/open-folder', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const uri = String(body?.uri || '').trim()
  // 2026-09-09：不传 uri 时打开项目 AI 素材根目录（assets/ai，不存在退回 assets）——
  // 编辑器顶栏「素材目录」入口，直接管理全部 AI 生成图
  if (!uri) {
    const aiDir = path.join(dir, 'assets', 'ai')
    const target = (await existsDir(aiDir)) ? aiDir : path.join(dir, 'assets')
    try {
      await openFolderOnHost(target)
      return c.json({ success: true, folder: target })
    } catch (e) {
      return c.json({ success: false, error: 'open_folder_failed', message: e && e.message ? e.message : String(e), folder: target }, 500)
    }
  }
  const abs = resolveAssetPathFromUri(id, uri)
  if (!abs) return c.json({ success: false, error: 'invalid_uri', message: '无法从 URI 解析到项目资源路径' }, 400)
  const folder = path.dirname(abs)
  try {
    await openFolderOnHost(folder)
    return c.json({ success: true, folder })
  } catch (e) {
    return c.json({ success: false, error: 'open_folder_failed', message: e && e.message ? String(e.message) : String(e), folder }, 500)
  }
})

// 上传本地资源（P0：仅图片，保存到 projects/<id>/assets/uploads）
app.post('/api/projects/:id/assets/upload', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  let file = null
  try {
    const form = await c.req.parseBody()
    file = form && (form.file || form.image || form.asset) ? (form.file || form.image || form.asset) : null
  } catch (_) {
    file = null
  }

  const isFileLike = (v) => {
    try {
      return v && typeof v === 'object' && typeof v.arrayBuffer === 'function'
    } catch (_) {
      return false
    }
  }
  if (!isFileLike(file)) {
    return c.json({ success: false, error: 'missing_file', message: '请使用 multipart/form-data 上传字段 file' }, 400)
  }

  const name = String(file.name || 'image.png')
  const ext = path.extname(name).toLowerCase()
  const allowed = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
  if (!allowed.has(ext)) {
    return c.json({ success: false, error: 'unsupported_type', message: `仅支持图片：${Array.from(allowed).join(', ')}` }, 415)
  }

  try {
    const relDir = path.join('assets', 'uploads')
    const outDir = path.join(dir, relDir)
    await mkdir(outDir, { recursive: true })
    const safeBase = path.basename(name, ext).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48) || 'image'
    const fname = `${safeBase}_${Date.now()}${ext}`
    const abs = path.join(outDir, fname)
    const buf = Buffer.from(await file.arrayBuffer())
    await writeFile(abs, buf)
    const assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
    return c.json({ success: true, assetPath, url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}` })
  } catch (e) {
    return c.json({ success: false, error: 'save_failed', message: e && e.message ? e.message : String(e) }, 500)
  }
})

// 2026-09-09 素材复用：跨项目素材库（只读聚合，扫描 storage/projects 各项目的图片资产）。
// 用途：故事多了以后，已生成的角色/道具/背景可以直接导入新项目复用，不必重复抽卡。
app.get('/api/assets-library', async (c) => {
  await ensureDirs()
  const excludeProjectId = String(c.req.query('excludeProjectId') || '').trim()
  const items = []
  const projects = await readdir(PROJECTS_DIR).catch(() => [])
  for (const pid of projects) {
    if (pid === excludeProjectId) continue
    const pdir = path.join(PROJECTS_DIR, pid)
    if (!(await existsDir(pdir))) continue
    let proj = null
    try { proj = await readJson(path.join(pdir, 'project.json')) } catch (_) { continue }
    const title = String(proj?.title || pid)
    const list = Array.isArray(proj?.assets) ? proj.assets : []
    for (const a of list) {
      if (!a || String(a.kind || '') !== 'image') continue
      const uri = String(a.uri || '').trim()
      if (!uri.startsWith('assets/')) continue
      const abs = path.join(pdir, uri)
      if (!(await existsFile(abs))) continue
      items.push({ projectId: pid, projectTitle: title, assetId: String(a.id || ''), name: String(a.name || ''), uri, source: a.source ? { type: a.source.type, prompt: String(a.source.prompt || '').slice(0, 160) } : null })
    }
  }
  return c.json({ success: true, count: items.length, items })
})

// 2026-09-09 存量素材批压（用户指令：故事多了图片爆涨，大图必须全部压缩）。
// 扫描 assets/ai 全部 PNG/JPG：场景背景→JPEG q90；立绘/cutout/主参考→无损 WebP（零质量损失）；
// 候选/绿幕/线稿/测试图→WebP q92。扩展名变化同步改写 project.json 与 story-assets/plan.json 的 uri 引用
// （文本级替换，文件路径唯一不会误伤；reviews 等历史记录不改）。幂等，可复跑。
app.post('/api/projects/:id/assets/compress', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const aiDir = path.join(dir, 'assets', 'ai')
  if (!(await existsDir(aiDir))) return c.json({ success: true, stats: null, message: '无 assets/ai 目录' })

  const stats = await optimizeDirectoryTree(aiDir)
  // uri 重写：绝对路径 → 项目内相对路径对
  const uriPairs = (stats.rewrites || [])
    .filter((r) => r && r.from && r.to && !r.error)
    .map((r) => ({
      from: path.relative(dir, r.from).replace(/\\/g, '/'),
      to: path.relative(dir, r.to).replace(/\\/g, '/')
    }))
    .filter((p) => p.from !== p.to)
  let refsRewritten = 0
  if (uriPairs.length) {
    for (const rel of ['project.json', path.join('story-assets', 'plan.json')]) {
      const abs = path.join(dir, rel)
      if (!(await existsFile(abs))) continue
      let text = await readFile(abs, 'utf8')
      let changed = 0
      for (const p of uriPairs) {
        if (text.includes(p.from)) {
          text = text.split(p.from).join(p.to)
          changed += 1
        }
      }
      if (changed > 0) {
        await writeFile(abs, text, 'utf8')
        refsRewritten += changed
      }
    }
  }
  return c.json({
    success: stats.failed === 0,
    stats: {
      total: stats.total,
      compressed: stats.compressed,
      skipped: stats.skipped,
      failed: stats.failed,
      srcMB: Math.round((stats.srcBytes / 1e6) * 10) / 10,
      dstMB: Math.round((stats.dstBytes / 1e6) * 10) / 10,
      refsRewritten,
      failures: (stats.rewrites || []).filter((r) => r.error).slice(0, 10)
    }
  })
})

// 2026-09-09 素材导入：把其他项目（或本项目历史）的图片资产复制进当前项目并登记为新资产。
// 复制到 assets/ai/imported/，source 留痕 {type:'import', fromProject, fromAssetId}。
app.post('/api/projects/:id/assets/import', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const sourceProjectId = String(body?.sourceProjectId || '').trim()
  const assetIds = Array.isArray(body?.assetIds) ? body.assetIds.map((x) => String(x || '').trim()).filter(Boolean) : []
  if (!sourceProjectId || !assetIds.length) {
    return c.json({ success: false, error: 'missing_params', message: 'sourceProjectId 与 assetIds 必填' }, 400)
  }
  const srcDir = projectDir(sourceProjectId)
  if (!(await existsDir(srcDir))) return c.json({ success: false, error: 'source_not_found' }, 404)
  const srcProj = await readJson(path.join(srcDir, 'project.json')).catch(() => null)
  if (!srcProj) return c.json({ success: false, error: 'source_project_invalid' }, 400)
  const dstProj = await readJson(path.join(dir, 'project.json'))
  const dstAssets = Array.isArray(dstProj.assets) ? dstProj.assets : []
  const imported = []
  const errors = []
  for (const aid of assetIds) {
    const srcAsset = (Array.isArray(srcProj.assets) ? srcProj.assets : []).find((a) => String(a?.id || '') === aid)
    const uri = String(srcAsset?.uri || '').trim()
    if (!srcAsset || !uri.startsWith('assets/')) { errors.push({ assetId: aid, error: 'asset_not_found' }); continue }
    const srcAbs = path.join(srcDir, uri)
    if (!srcAbs.startsWith(srcDir) || !(await existsFile(srcAbs))) { errors.push({ assetId: aid, error: 'file_not_found' }); continue }
    try {
      const ext = path.extname(uri) || '.png'
      const relDir = path.join('assets', 'ai', 'imported')
      await mkdir(path.join(dir, relDir), { recursive: true })
      const fname = `${path.basename(uri, ext)}_${Date.now()}${ext}`
      const dstAbs = path.join(dir, relDir, fname)
      await copyFile(srcAbs, dstAbs)
      const rel = `${relDir}/${fname}`.replace(/\\/g, '/')
      const newAsset = {
        id: `asset_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        kind: 'image',
        name: String(srcAsset.name || '导入素材'),
        uri: rel,
        source: { type: 'import', fromProject: sourceProjectId, fromAssetId: aid, prompt: String(srcAsset?.source?.prompt || '').slice(0, 1800) }
      }
      dstAssets.push(newAsset)
      imported.push(newAsset)
    } catch (e) {
      errors.push({ assetId: aid, error: String(e && e.message ? e.message : e) })
    }
  }
  if (imported.length) {
    dstProj.assets = dstAssets
    dstProj.updatedAt = new Date().toISOString()
    await writeJson(path.join(dir, 'project.json'), dstProj)
  }
  return c.json({ success: errors.length === 0, imported, errors })
})


// AI 生成背景图（P0：默认对接 SDWebUI txt2img；ComfyUI 预留）
// 说明：此功能只用于制作阶段生成素材，最终产物仍需通过 app_system 导入。
app.post('/api/projects/:id/ai/background', storyInputGate('story.background.generate', (c, body) => ({ projectId: c.req.param('id'), ...body })), async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

	const body = await c.req.json().catch(() => ({}))
	const scenePrompt = String(body?.prompt || '').trim()
	const sceneNegative = String(body?.negativePrompt || '').trim()
	const globalPrompt = String(body?.globalPrompt || '').trim()
	const globalNegativePrompt = String(body?.globalNegativePrompt || '').trim()
  const requestedModel = String(body?.model || '').trim()
  const requestedLoras = Array.isArray(body?.loras) ? body.loras.map((x) => String(x || '').trim()).filter(Boolean) : []
  const continuity = body && body.continuity && typeof body.continuity === 'object' ? body.continuity : null
	const width = Number(body?.width || 768)
	const height = Number(body?.height || 1024)
	if (!scenePrompt) return c.json({ success: false, error: 'missing_prompt' }, 400)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
	const bgProvider = String(studio.effective.image.provider || process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()
  if (!bgProvider || bgProvider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“出图（背景图）”并选择 Provider/Model' }, 400)
  }
  const timeoutRaw = body?.timeoutMs
  const bgTimeoutMs = (Number.isFinite(Number(timeoutRaw)) && Number(timeoutRaw) <= 0)
    ? 0
    : clampInt(timeoutRaw, 5_000, 300_000, clampInt(process.env.STUDIO_BG_TIMEOUT_MS, 5_000, 300_000, 180_000))
	const startedAt = Date.now()
  const traceId = createTraceId()
  const promptJoiner = (bgProvider === 'sdwebui' || bgProvider === 'comfyui') ? ', ' : '，'
	const effectivePrompt = [globalPrompt, scenePrompt].map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(promptJoiner)
	const effectiveNegative = [globalNegativePrompt, sceneNegative].map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(', ')
  const referenceImageUrls = Array.isArray(body?.referenceImageUrls)
    ? body.referenceImageUrls.map((x) => String(x || '').trim()).filter((x) => isExternallyReachableReferenceUrl(x))
    : []
  const requestedReferenceCount = Array.isArray(body?.referenceImageUrls)
    ? body.referenceImageUrls.map((x) => String(x || '').trim()).filter(Boolean).length
    : 0
  if (requestedReferenceCount > 0 && referenceImageUrls.length === 0) {
    return c.json({ success: false, error: 'reference_image_unreachable', message: '所选参考图链接仅本机可访问，Doubao 云端无法下载。请改用带 remoteUrl 的参考场景图。' }, 400)
  }
  const characterRefsIn = Array.isArray(body?.characterRefs) ? body.characterRefs : []
  const assetRefsIn = Array.isArray(body?.assetRefs) ? body.assetRefs : []
  const referenceImages = []
  for (const item of characterRefsIn) {
    if (!item || typeof item !== 'object') continue
    const characterId = String(item.characterId || '').trim()
    if (!characterId) continue
    const assetAbs = resolveAssetPathFromUri(id, item.assetUri || item.assetPath || '')
    if (!assetAbs || !(await existsFile(assetAbs))) continue
    try {
      const bytes = await readFile(assetAbs)
      referenceImages.push({
        role: 'character',
        characterId,
        characterName: String(item.characterName || characterId).trim() || characterId,
        assetId: String(item.assetId || '').trim() || undefined,
        filename: path.basename(assetAbs),
        bytes,
        weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : undefined,
        fingerprintPrompt: String(item.fingerprintPrompt || '').trim() || undefined
      })
    } catch (_) {}
  }
  for (const item of assetRefsIn) {
    if (!item || typeof item !== 'object') continue
    const assetId = String(item.assetId || '').trim()
    const assetName = String(item.assetName || item.name || assetId || 'reference').trim()
    const assetAbs = resolveAssetPathFromUri(id, item.assetUri || item.assetPath || '')
    if (!assetAbs || !(await existsFile(assetAbs))) continue
    try {
      const bytes = await readFile(assetAbs)
      referenceImages.push({
        role: String(item.assetType || item.category || 'asset').trim() || 'asset',
        assetId: assetId || undefined,
        assetName,
        filename: path.basename(assetAbs),
        bytes,
        weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : undefined
      })
    } catch (_) {}
  }
  logStage({
    stage: 'bg.create',
    event: 'start',
    traceId,
    project: id,
    provider: bgProvider,
    model: requestedModel || studio.effective.image.model || '-',
    item: `w${Math.floor(width || 0)}h${Math.floor(height || 0)} refs:${referenceImages.length}`
  })

	try {
	  const gen = await generateBackgroundImage({
	    prompt: effectivePrompt,
	    negativePrompt: effectiveNegative,
	    aspectRatio: body?.aspectRatio,
	    style: body?.style,
	    size: body?.size || studio.effective.image.size,
	    responseFormat: body?.responseFormat,
      watermark: body?.watermark,
      guidanceScale: body?.guidanceScale,
      sequentialImageGeneration: body?.sequentialImageGeneration,
      width,
      height,
      steps: body?.steps,
      cfgScale: body?.cfgScale,
      sampler: body?.sampler,
	      scheduler: body?.scheduler,
        seed: body?.seed,
        continuity,
          referenceImageUrls,
        referenceImages,
      workflowMode: String(body?.workflowMode || '').trim() || undefined,
      lockProfile: String(body?.lockProfile || '').trim() || undefined,
      provider: bgProvider,
      sdwebuiBaseUrl: studio.effective.image.sdwebuiBaseUrl,
      comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
      apiUrl: studio.effective.image.apiUrl,
      model: requestedModel || studio.effective.image.model,
      loras: requestedLoras.length ? requestedLoras : studio.effective.image.loras,
      proxyUrl: studio.effective.network.proxyUrl,
      timeoutMs: bgTimeoutMs
	    })
	    const buf = gen.bytes
	    const ext0 = String(gen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
	    const sniff = sniffImageMetaFromBytes(buf)
	    const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'
	    const relDir = path.join('assets', 'ai')
	    const outDir = path.join(dir, relDir)
	    await mkdir(outDir, { recursive: true })
      const existingAssetUri = String(body?.existingAssetUri || '').trim()
      const existingAssetAbs = existingAssetUri ? resolveAssetPathFromUri(id, existingAssetUri) : null
      let abs = ''
      let assetPath = ''
      if (existingAssetAbs && await existsFile(existingAssetAbs)) {
        const archived = await archiveExistingAssetForReplacement(id, existingAssetUri)
        abs = existingAssetAbs
        await writeFile(abs, buf)
        assetPath = String(assetPathFromAbsolute(id, abs) || '')
        if (!assetPath) throw new Error('invalid_replacement_asset_path')
        console.log(`[gamestudio] bg replace archived=${archived ? path.basename(archived) : '-'} restored=${path.basename(abs)}`)
      } else {
        const fname = `bg_${Date.now()}.${ext}`
        abs = path.join(outDir, fname)
        await writeFile(abs, buf)
        assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
      }
      { // 2026-09-09 出图即压：背景 JPEG q90（用户指令：源头治理大图爆涨）
        const opt = await optimizeGeneratedImage(abs, IMAGE_KIND.SCENE_BG).catch(() => null)
        if (opt && opt.outPath && opt.outPath !== abs) assetPath = String(assetPathFromAbsolute(id, opt.outPath) || assetPath)
      }
		    const provider = (gen && gen.meta && gen.meta.provider) ? String(gen.meta.provider) : String(process.env.STUDIO_BG_PROVIDER || 'sdwebui')
		    const remoteUrl = (gen && gen.meta && typeof gen.meta.url === 'string' && gen.meta.url.trim()) ? String(gen.meta.url).trim() : ''
        logStage({
          stage: 'bg.create',
          event: 'ok',
          traceId,
          project: id,
          provider,
          model: studio.effective.image.model || '-',
          ok: true,
          durationMs: Math.max(0, Date.now() - startedAt),
          item: `${ext}:${buf.length}`
        })
		    return c.json({
          success: true,
          provider,
          assetPath,
          url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`,
          remoteUrl,
          traceId,
          seed: gen && gen.meta ? gen.meta.seed : undefined,
          continuityUsed: Boolean(gen && gen.meta && gen.meta.continuityUsed)
        })
		  } catch (e) {
		    const msg = e && e.message ? String(e.message) : String(e)
        const mapped = classifyAiError(e)
        logStage({
          stage: 'bg.create',
          event: 'fail',
          traceId,
          project: id,
          provider: bgProvider,
          model: studio.effective.image.model || '-',
          status: mapped.httpStatus,
          ok: false,
          durationMs: Math.max(0, Date.now() - startedAt),
          err: msg
        })
        return c.json({ success: false, error: mapped.code, message: msg, traceId }, mapped.httpStatus)
	  }
})

// AI 解析用户描述 -> 生成标准生图提示词（用于豆包/Seedream）
app.post('/api/projects/:id/ai/background/prompt', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

	const body = await c.req.json().catch(() => ({}))
	const userInput = String(body?.userInput || '').trim()
	const globalPrompt = String(body?.globalPrompt || '').trim()
	const globalNegativePrompt = String(body?.globalNegativePrompt || '').trim()
	const aspectRatio = String(body?.aspectRatio || '').trim()
	const style = String(body?.style || '').trim()
  const outputLanguage = String(body?.outputLanguage || '').trim().toLowerCase() || 'en'
  const promptTimeoutMs = clampInt(
    body?.timeoutMs,
    5_000,
    180_000,
    clampInt(process.env.STUDIO_PROMPT_TIMEOUT_MS, 5_000, 180_000, 90_000)
  )
	if (!userInput) return c.json({ success: false, error: 'missing_userInput' }, 400)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.prompt) {
    return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)
  }
  if (!studio.effective.prompt.provider || studio.effective.prompt.provider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“提示词生成”并选择 Provider/Model' }, 400)
  }

	const startedAt = Date.now()
  const traceId = createTraceId()
  logStage({
    stage: 'bg.prompt',
    event: 'start',
    traceId,
    project: id,
    provider: studio.effective.prompt.provider || 'localoxml',
    model: studio.effective.prompt.model || '-',
    item: `chars:${userInput.length}`
  })
	try {
	  const { result, meta } = await generateBackgroundPrompt({
      userInput,
      globalPrompt,
      globalNegativePrompt,
      aspectRatio,
      style,
      outputLanguage,
      timeoutMs: promptTimeoutMs,
      targetImageProvider: studio.effective.image.provider,
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model,
      apiUrl: studio.effective.prompt.apiUrl,
      proxyUrl: studio.effective.network.proxyUrl
    })
    logStage({
      stage: 'bg.prompt',
      event: 'ok',
      traceId,
      project: id,
      provider: meta && meta.provider ? meta.provider : studio.effective.prompt.provider || 'localoxml',
      model: meta && meta.model ? meta.model : studio.effective.prompt.model || '-',
      ok: true,
      durationMs: Math.max(0, Date.now() - startedAt)
    })
	  return c.json({ success: true, result, meta, traceId })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    logStage({
      stage: 'bg.prompt',
      event: 'fail',
      traceId,
      project: id,
      provider: studio.effective.prompt.provider || 'localoxml',
      model: studio.effective.prompt.model || '-',
      status: mapped.httpStatus,
      ok: false,
      durationMs: Math.max(0, Date.now() - startedAt),
      err: msg
    })
    return c.json({ success: false, error: mapped.code, message: msg, traceId }, mapped.httpStatus)
  }
})

// AI：生成 Story Bible（角色/道具/地点锁定，用于连续分镜）
app.post('/api/projects/:id/ai/story/bible', storyInputGate('story.bible.generate', (c, body) => ({ projectId: c.req.param('id'), ...body })), async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const input = body && typeof body === 'object' ? body.input : null
  if (!input || typeof input !== 'object') return c.json({ success: false, error: 'missing_input' }, 400)

  const timeoutRaw = Number(body?.timeoutMs)
  const timeoutMs = (Number.isFinite(timeoutRaw) && timeoutRaw <= 0)
    ? 0
    : clampInt(
        body?.timeoutMs,
        5_000,
        600_000,
        clampInt(process.env.STUDIO_PROMPT_TIMEOUT_MS, 5_000, 600_000, 90_000)
      )

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.prompt) {
    return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)
  }
  if (!studio.effective.prompt.provider || studio.effective.prompt.provider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“提示词生成”并选择 Provider/Model' }, 400)
  }

  const startedAt = Date.now()
  const traceId = createTraceId()
  logStage({
    stage: 'story.bible',
    event: 'start',
    traceId,
    project: id,
    provider: studio.effective.prompt.provider || 'localoxml',
    model: studio.effective.prompt.model || '-'
  })
  try {
    // draftModel：本地小模型起草（8K 内存机实测 27B 单次大结构生成 12 分钟仍空输出），
    // 质量由下游 27B 评审/修复环节兜底（用户确认的"小模型执行、27B 验证"单链设计）
    const draftModel = String(body?.draftModel || '').trim()
    const { result, meta } = await generateStoryBible({
      provider: studio.effective.prompt.provider,
      model: draftModel || studio.effective.prompt.model,
      apiUrl: studio.effective.prompt.apiUrl,
      proxyUrl: studio.effective.network.proxyUrl,
      timeoutMs,
      input
    })
    logStage({
      stage: 'story.bible',
      event: 'ok',
      traceId,
      project: id,
      provider: meta && meta.provider ? meta.provider : studio.effective.prompt.provider || 'localoxml',
      model: meta && meta.model ? meta.model : studio.effective.prompt.model || '-',
      ok: true,
      durationMs: Math.max(0, Date.now() - startedAt)
    })
    // Persist Story Bible into project document
    try {
      const projectPath = path.join(dir, 'project.json')
      const projectDoc = await readJson(projectPath).catch(() => ({}))
      if (!projectDoc.state || typeof projectDoc.state !== 'object') {
        projectDoc.state = {}
      }
      if (!projectDoc.state.aiBackground || typeof projectDoc.state.aiBackground !== 'object') {
        projectDoc.state.aiBackground = {}
      }
      projectDoc.state.aiBackground.storyBible = result
      projectDoc.state.aiBackground.storyBibleJson = JSON.stringify(result)
      // 新故事必须干净开始：清空可能携带旧故事提示词的草稿/镜像字段
      for (const staleKey of [
        'storyboardGlobalPromptZh', 'storyboardGlobalNegativePromptZh',
        'storyboardLockAssetPrompts', 'storyboardScenes', 'storyboardBatchDraft',
        'storyboardPromptMeta', 'storyAssetPlan', 'storyAssetPlanConfirmedAt',
        'globalPrompt', 'globalNegativePrompt'
      ]) {
        delete projectDoc.state.aiBackground[staleKey]
      }
      projectDoc.updatedAt = nowIso()
      projectDoc._rev = Number(projectDoc._rev || 0) + 1
      await writeJson(projectPath, projectDoc)
      // 新 bible 生成后旧资产计划作废（避免按 id 合并旧故事的锁定状态与提示词）
      await rm(projectStoryAssetsPlanPath(id), { force: true }).catch(() => {})
      // Update meta.json timestamp
      const metaPath = path.join(dir, 'meta.json')
      const metaDoc = await readJson(metaPath).catch(() => ({}))
      metaDoc.updatedAt = nowIso()
      await writeJson(metaPath, metaDoc)
    } catch (persistErr) {
      console.error('[story.bible][PERSIST_ERROR]', persistErr && persistErr.message ? persistErr.message : String(persistErr))
    }
    return c.json({ success: true, result, meta, traceId })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    const debugOutput =
      process.env.NODE_ENV !== 'production' && e && typeof e === 'object' && 'output' in e
        ? String(e.output || '').slice(0, 8000)
        : ''
    logStage({
      stage: 'story.bible',
      event: 'fail',
      traceId,
      project: id,
      provider: studio.effective.prompt.provider || 'localoxml',
      model: studio.effective.prompt.model || '-',
      status: mapped.httpStatus,
      ok: false,
      durationMs: Math.max(0, Date.now() - startedAt),
      err: msg
    })
    return c.json(
      {
        success: false,
        error: mapped.code,
        message: msg,
        traceId,
        ...(debugOutput ? { debugOutput } : {})
      },
      mapped.httpStatus
    )
  }
})

// ---------------------------------------------------------------------------
// 2026-10-10 圣经质检步（GS-50）：sceneRefs 与剧情一致性校验+自动修正。
// 背景：LLM 生成的 bible 顶层 sceneRefs 错绑是最高频生产事故（白雪公主 7/11 场景错绑、
// 小明2 结局错绑、龟兔漏绑），此前全靠人工读剧情修正。本端点：确定性规则检查 +
// 逐场景 LLM 对照复核（1 场 1 调用）+ persist=true 时回写 bible.sceneRefs（写盘带 _rev）。
// 写盘后旧资产计划作废（plan 由 sceneRefs 派生，修正后必须重建）。
// ---------------------------------------------------------------------------
app.post('/api/projects/:id/ai/story/bible/qc', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.prompt) return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)
  if (!studio.effective.prompt.provider || studio.effective.prompt.provider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“提示词生成”并选择 Provider/Model' }, 400)
  }

  const bundle = await readProjectBundle(id)
  const bible = readStoryBibleFromProjectDoc(bundle.project)
  if (!bible || typeof bible !== 'object') return c.json({ success: false, error: 'missing_story_bible', message: '请先生成 Story Bible。' }, 400)
  const storyNodes = (Array.isArray(bundle.story?.nodes) ? bundle.story.nodes : []).filter((n) => ['scene', 'ending'].includes(String(n && n.kind || '')))
  if (!storyNodes.length) return c.json({ success: false, error: 'missing_story', message: '未找到故事场景节点。' }, 400)

  const traceId = createTraceId()
  const task = createAiTask(id, 'story.bible.qc', { total: storyNodes.length, message: '圣经质检：逐场景核对绑定' })
  logStage({ stage: 'story.bible.qc', event: 'start', traceId, project: id, item: `scenes:${storyNodes.length}` })

  try {
    const refsMap = normalizeSceneRefs(bible)
    const entities = {
      characters: (Array.isArray(bible.characters) ? bible.characters : []).map((x) => ({ id: String(x?.id || '').trim(), name: String(x?.name || '').trim(), aliases: x?.aliases })).filter((x) => x.id),
      props: (Array.isArray(bible.props) ? bible.props : []).map((x) => ({ id: String(x?.id || '').trim(), name: String(x?.name || '').trim(), aliases: x?.aliases })).filter((x) => x.id),
      locations: (Array.isArray(bible.locations) ? bible.locations : []).map((x) => ({ id: String(x?.id || '').trim(), name: String(x?.name || '').trim(), aliases: x?.aliases })).filter((x) => x.id)
    }
    const scenesInput = storyNodes.map((node, index) => {
      const hit = matchSceneRef(refsMap, node, index)
      return {
        sceneId: String(node.id || '').trim(),
        sceneName: String(node.name || node.body?.title || '').trim(),
        summary: String(node.body?.text || '').trim().slice(0, 400),
        bound: hit && hit.value ? hit.value : { characters: [], props: [], locations: [] }
      }
    })

    const deterministicIssues = qcSceneRefsDeterministic({ scenes: scenesInput, entities })
    const timeoutMs = clampInt(body?.timeoutMs, 10_000, 600_000, 120_000)
    const { scenes: fixedScenes } = await qcStoryBibleSceneRefsWithAi({
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model,
      apiUrl: studio.effective.prompt.apiUrl,
      proxyUrl: studio.effective.network.proxyUrl,
      timeoutMs,
      input: { storyTitle: String(bundle.project?.title || '').trim(), entities, scenes: scenesInput },
      onProgress: (i, total, sid) => updateAiTask(task.taskId, { stage: 'reviewing', current: i + 1, message: `质检场景 ${i + 1}/${total}：${sid}` })
    })

    // 差异报告：逐场景 added/removed
    const report = []
    const fixedRefs = {}
    for (const fix of fixedScenes) {
      const before = (scenesInput.find((s) => s.sceneId === fix.sceneId) || {}).bound || { characters: [], props: [], locations: [] }
      const diff = (a, b) => ({ added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)) })
      const dChars = diff(before.characters || [], fix.characters)
      const dProps = diff(before.props || [], fix.props)
      const dLocs = diff(before.locations || [], fix.locations)
      const changed = dChars.added.length + dChars.removed.length + dProps.added.length + dProps.removed.length + dLocs.added.length + dLocs.removed.length > 0
      report.push({ sceneId: fix.sceneId, changed, reason: fix.reason, characters: dChars, props: dProps, locations: dLocs, ...(fix.qcFailed ? { qcFailed: true } : {}) })
      fixedRefs[fix.sceneId] = { characters: fix.characters, props: fix.props, locations: fix.locations }
    }
    const changedCount = report.filter((r) => r.changed).length
    const qcFailedCount = report.filter((r) => r.qcFailed).length

    let persisted = false
    if (body?.persist === true && changedCount > 0) {
      const projectPath = path.join(dir, 'project.json')
      const projectDoc = await readJson(projectPath)
      const bg = projectDoc.state && typeof projectDoc.state.aiBackground === 'object' ? projectDoc.state.aiBackground : (projectDoc.state = { ...(projectDoc.state || {}) }, projectDoc.state.aiBackground = {})
      const nextBible = { ...bible, sceneRefs: fixedRefs }
      bg.storyBible = nextBible
      bg.storyBibleJson = JSON.stringify(nextBible)
      projectDoc.updatedAt = nowIso()
      projectDoc._rev = Number(projectDoc._rev || 0) + 1
      await writeJson(projectPath, projectDoc)
      // 旧资产计划作废：sceneRefs 变了，plan 必须重建（与 bible 重新生成同款语义）
      await rm(projectStoryAssetsPlanPath(id), { force: true }).catch(() => {})
      persisted = true
    }

    updateAiTask(task.taskId, { stage: 'done', done: true, current: storyNodes.length, message: `质检完成：${changedCount} 场景修正${qcFailedCount ? `，${qcFailedCount} 场景 LLM 复核失败保留原绑定` : ''}${persisted ? '，已回写并作废旧计划' : ''}`, result: { changedCount, qcFailedCount, deterministicIssueCount: deterministicIssues.length, persisted } })
    logStage({ stage: 'story.bible.qc', event: 'ok', traceId, project: id, item: `changed:${changedCount} failed:${qcFailedCount} persisted:${persisted}` })
    return c.json({ success: true, taskId: task.taskId, changedCount, qcFailedCount, deterministicIssues, report, persisted })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    console.error(`[story.bible.qc] project=${id} error=${msg}`)
    updateAiTask(task.taskId, { stage: 'error', done: true, error: msg, message: `圣经质检失败：${msg}` })
    logStage({ stage: 'story.bible.qc', event: 'error', traceId, project: id, item: msg.slice(0, 300) })
    const mapped = classifyAiError(e)
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

// AI：提取剧情姿势状态（2026-09-10，候选制不写盘）——逐场景×出场角色输出 姿势/朝向/动作/神态，
// 供锁定向导姿势变体区构建"剧情姿势需求清单"；模型输出只是候选，持久化由编辑器确认后走 plan 保存链。
app.post('/api/projects/:id/ai/story/pose-states', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.prompt) {
    return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)
  }
  if (!studio.effective.prompt.provider || studio.effective.prompt.provider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“提示词生成”并选择 Provider/Model' }, 400)
  }

  try {
    const bundle = await readProjectBundle(id)
    const storyBible = readStoryBibleFromProjectDoc(bundle.project)
    if (!storyBible || typeof storyBible !== 'object') {
      return c.json({ success: false, error: 'missing_story_bible', message: '未找到 Story Bible。请先生成 Story Bible。' }, 400)
    }
    const input = buildPoseStateExtractionInput({ project: bundle.project, story: bundle.story, storyBible })
    if (!input.scenes.length) {
      return c.json({ success: false, error: 'no_character_scenes', message: '没有角色出场的场景可提取。' }, 400)
    }
    const body = await c.req.json().catch(() => ({}))
    const timeoutMs = clampInt(body?.timeoutMs, 5_000, 600_000, clampInt(process.env.STUDIO_PROMPT_TIMEOUT_MS, 5_000, 600_000, 90_000))
    const { result, meta } = await extractStoryPoseStates({
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model,
      apiUrl: studio.effective.prompt.apiUrl,
      proxyUrl: studio.effective.network.proxyUrl,
      timeoutMs,
      input
    })
    // 附带角色→计划资产映射（同 id 直接对应），编辑器按资产挂载需求清单
    const plan = await readStoryAssetPlanIfExists(id).catch(() => null)
    const assetByCharacterId = {}
    for (const asset of (plan && Array.isArray(plan.assets) ? plan.assets : [])) {
      if (String(asset?.category || '') === 'character' && String(asset?.id || '').trim()) {
        assetByCharacterId[String(asset.id).trim()] = { assetId: String(asset.id).trim(), assetName: String(asset.name || asset.id).trim() }
      }
    }
    return c.json({ success: true, poseStates: result, assetByCharacterId, meta })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

// AI：提取道具状态需求（2026-09-16，候选制不写盘）——逐道具识别跨场景视觉状态变化（水位/满空/破碎…）
// 与"终态合并关系"（如石子沉进瓶内），供锁定向导道具状态变体区构建需求清单；持久化由编辑器确认后走 plan 保存链。
app.post('/api/projects/:id/ai/story/prop-states', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.prompt) {
    return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)
  }
  if (!studio.effective.prompt.provider || studio.effective.prompt.provider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“提示词生成”并选择 Provider/Model' }, 400)
  }

  try {
    const bundle = await readProjectBundle(id)
    const storyBible = readStoryBibleFromProjectDoc(bundle.project)
    if (!storyBible || typeof storyBible !== 'object') {
      return c.json({ success: false, error: 'missing_story_bible', message: '未找到 Story Bible。请先生成 Story Bible。' }, 400)
    }
    const input = buildPropStateExtractionInput({ project: bundle.project, story: bundle.story, storyBible })
    if (!input.scenes.length) {
      return c.json({ success: false, error: 'no_prop_scenes', message: '没有事物出场的场景可提取。' }, 400)
    }
    const body = await c.req.json().catch(() => ({}))
    const timeoutMs = clampInt(body?.timeoutMs, 5_000, 600_000, clampInt(process.env.STUDIO_PROMPT_TIMEOUT_MS, 5_000, 600_000, 90_000))
    const { result, meta } = await extractStoryPropStates({
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model,
      apiUrl: studio.effective.prompt.apiUrl,
      proxyUrl: studio.effective.network.proxyUrl,
      timeoutMs,
      input
    })
    // 附带道具→计划资产映射（bible propId 与计划资产同 id 直接对应），编辑器按资产挂载需求清单
    const plan = await readStoryAssetPlanIfExists(id).catch(() => null)
    const assetByPropId = {}
    for (const asset of (plan && Array.isArray(plan.assets) ? plan.assets : [])) {
      const aid = String(asset?.id || '').trim()
      if (aid) assetByPropId[aid] = { assetId: aid, assetName: String(asset.name || aid).trim() }
    }
    return c.json({ success: true, propStates: result, assetByPropId, meta })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

app.post('/api/projects/:id/ai/translate', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const textIn = String(body?.text || '').trim()
  if (!textIn) return c.json({ success: false, error: 'missing_text', message: 'text 不能为空' }, 400)

  const timeoutRaw = Number(body?.timeoutMs)
  const timeoutMs = (Number.isFinite(timeoutRaw) && timeoutRaw <= 0)
    ? 0
    : clampInt(body?.timeoutMs, 5_000, 180_000, clampInt(process.env.STUDIO_PROMPT_TIMEOUT_MS, 5_000, 180_000, 60_000))

  const studio = await getEffectiveStudioConfig(ROOT)
  const translationCfg = studio.effective.translation || {}
  const promptCfg = studio.effective.prompt || {}
  const providers = [
    { provider: String(translationCfg.provider || '').trim().toLowerCase(), model: translationCfg.model, apiUrl: translationCfg.apiUrl, note: null },
    { provider: String(promptCfg.provider || '').trim().toLowerCase(), model: promptCfg.model, apiUrl: promptCfg.apiUrl, note: 'translation_fallback_to_prompt_provider' }
  ].filter((item, index, list) => item.provider && item.provider !== 'none' && list.findIndex((entry) => entry.provider === item.provider && String(entry.apiUrl || '') === String(item.apiUrl || '')) === index)

  if (!providers.length) {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中配置“提示词翻译接口”' }, 400)
  }

  const startedAt = Date.now()
  const traceId = createTraceId()
  const primaryProvider = providers[0]
  logStage({ stage: 'prompt.translate', event: 'start', traceId, project: id, provider: primaryProvider.provider || 'localoxml', model: primaryProvider.model || '-' })
  try {
    let translated = null
    let lastError = null
    for (const candidate of providers) {
      try {
        translated = await translatePromptText({
          provider: candidate.provider,
          model: candidate.model,
          apiUrl: candidate.apiUrl,
          proxyUrl: studio.effective.network.proxyUrl,
          timeoutMs,
          text: textIn,
          sourceLang: body?.sourceLang,
          targetLang: body?.targetLang,
          mode: body?.mode
        })
        if (translated && candidate.note) {
          translated.meta = { ...(translated.meta || {}), note: candidate.note }
        }
        break
      } catch (e) {
        lastError = e
      }
    }
    if (!translated) throw lastError || new Error('translation_failed')
    const { result, meta } = translated
    logStage({ stage: 'prompt.translate', event: 'ok', traceId, project: id, provider: meta && meta.provider ? meta.provider : primaryProvider.provider || 'localoxml', model: meta && meta.model ? meta.model : primaryProvider.model || '-', ok: true, durationMs: Math.max(0, Date.now() - startedAt) })
    return c.json({ success: true, result, meta, traceId })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    logStage({ stage: 'prompt.translate', event: 'fail', traceId, project: id, provider: primaryProvider.provider || 'localoxml', model: primaryProvider.model || '-', status: mapped.httpStatus, ok: false, durationMs: Math.max(0, Date.now() - startedAt), err: msg })
    return c.json({ success: false, error: mapped.code, message: msg, traceId }, mapped.httpStatus)
  }

})

// AI：提取场景构图规格（2026-10-04）——逐场景产出元素摆放"需求单"（位置/大小/远近/前后遮挡/朝向/状态+原文依据），
// 替代摆位的纯默认值兜底。候选制：默认只返回不落盘；body.persist=true 时写入 plan.scenes[].composition（生产链审核后调用）。
app.post('/api/projects/:id/ai/story/composition', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.prompt) {
    return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)
  }
  if (!studio.effective.prompt.provider || studio.effective.prompt.provider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“提示词生成”并选择 Provider/Model' }, 400)
  }

  try {
    const bundle = await readProjectBundle(id)
    const plan = await readStoryAssetPlanIfExists(id)
    if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)
    const input = buildCompositionInput({ project: bundle.project, story: bundle.story, plan })
    if (!input.scenes.length) {
      return c.json({ success: false, error: 'no_composable_scenes', message: '没有含出场元素的场景可构图。' }, 400)
    }
    const body = await c.req.json().catch(() => ({}))
    const timeoutMs = clampInt(body?.timeoutMs, 5_000, 600_000, 120_000)
    const { result, meta } = await extractStoryComposition({
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model,
      apiUrl: studio.effective.prompt.apiUrl,
      proxyUrl: studio.effective.network.proxyUrl,
      timeoutMs,
      input
    })

    let persisted = false
    if (body?.persist === true) {
      const byId = new Map((result.scenes || []).map((s) => [String(s.sceneId || '').trim(), s]))
      const nextPlan = {
        ...plan,
        generatedAt: nowIso(),
        scenes: (Array.isArray(plan.scenes) ? plan.scenes : []).map((s) => {
          const hit = byId.get(String(s && s.sceneId || '').trim())
          return hit ? { ...s, composition: { cameraNote: hit.cameraNote || '', items: hit.items || [], source: 'ai', updatedAt: nowIso() } } : s
        })
      }
      nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
      await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
      persisted = true
    }

    return c.json({ success: true, composition: result, persisted, meta })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    // 2026-10-09 构图 500 可诊断（白雪公主 9 人设批次失败一度只能靠猜）：真实错误落日志
    console.error(`[story.composition] project=${id} error=${msg}`)
    logStage({ stage: 'story.composition', event: 'error', traceId: createTraceId(), project: id, item: msg.slice(0, 300) })
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

app.post('/api/projects/:id/ai/story/assets/plan', storyInputGate('story.assets.plan', (c, body) => ({ projectId: c.req.param('id'), ...body })), async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const bundle = await readProjectBundle(id)
  const storyBible = body && body.storyBible && typeof body.storyBible === 'object'
    ? body.storyBible
    : readStoryBibleFromProjectDoc(bundle.project)
  if (!storyBible || typeof storyBible !== 'object') {
    return c.json({ success: false, error: 'missing_story_bible', message: '未找到 Story Bible。请先生成 Story Bible，或在请求中传入 storyBible。' }, 400)
  }

  const prevManifest = body && body.rebuild ? null : await readStoryAssetPlanIfExists(id)
  // 2026-08-30 修复：rebuild:false 且已有持久化计划时直接返回磁盘真相，不再 rebuild 派生——
  // 派生会把人工补充的资产（如猪妈妈）与 repair-links 的场景关联丢掉，编辑器看到并与真相不一致。
  if (!body?.rebuild && prevManifest) {
    return c.json({ success: true, plan: prevManifest })
  }
  const plan = buildStoryAssetPlan({
    project: bundle.project,
    story: bundle.story,
    storyBible,
    prevManifest
  })
  await saveStoryAssetPlan(id, plan)
  // 2026-10-08 《xxxx2》命名约定：plan 落盘后自动继承基底项目已锁定资产（跳过抽卡/锁定/线稿）
  const inherit = await maybeAutoInheritStoryAssets(id).catch((e) => ({ error: String(e && e.message || e) }))
  const finalPlan = inherit && !inherit.error ? await readStoryAssetPlanIfExists(id) || plan : plan
  return c.json({ success: true, plan: finalPlan, ...(inherit ? { inherit } : {}) })
})

app.post('/api/projects/:id/ai/story/assets/plan/persist', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const plan = body && body.plan && typeof body.plan === 'object' ? body.plan : null
  if (!plan) {
    return c.json({ success: false, error: 'missing_plan', message: '缺少要保存的资产计划。' }, 400)
  }
  await saveStoryAssetPlan(id, plan, { mergeAssetsById: true, protectTerminalFields: true })
  // 2026-09-03 返回最新 _rev：saveStoryAssetPlan 会递增 project.json 版本号，
  // 编辑器不采信的话，外部更新检测横幅会把"自己刚才的保存"误报成外部更新（实测假阳性）。
  let rev = 0
  try {
    const doc = await readJson(path.join(projectDir(id), 'project.json'))
    rev = Number(doc && doc._rev) || 0
  } catch (_) {}
  return c.json({ success: true, plan, _rev: rev })
})

// 2026-09-16 资产计划真删除：按 assetId 从磁盘真相计划移除资产并清洗场景引用，全量覆盖写盘。
// 背景：persist 通道 mergeAssetsById 会保留磁盘独有条目，编辑器推"已过滤计划"删不掉（实测删除静默无效）。
// 删除类写按 2026-09-09 治理注释不走 merge（与 repair-links 同款全量覆盖）。
app.post('/api/projects/:id/ai/story/assets/plan/remove-asset', async (c) => {
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)
  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)
  const assets = Array.isArray(plan.assets) ? plan.assets : []
  const target = assets.find((a) => String(a && a.id || '').trim() === assetId) || null
  if (!target) return c.json({ success: false, error: 'asset_not_found', message: '计划中未找到该事物资产。' }, 404)
  const scrubIdList = (list) => (Array.isArray(list) ? list : []).map((x) => String(x || '').trim()).filter((x) => x && x !== assetId)
  const nextPlan = {
    ...plan,
    generatedAt: nowIso(),
    excludedAssetIds: Array.from(new Set([...(Array.isArray(plan.excludedAssetIds) ? plan.excludedAssetIds : []), assetId])),
    assets: assets.filter((a) => String(a && a.id || '').trim() !== assetId),
    scenes: (Array.isArray(plan.scenes) ? plan.scenes : []).map((scene) => ({
      ...scene,
      assetIds: scrubIdList(scene && scene.assetIds),
      promptAssets: (Array.isArray(scene && scene.promptAssets) ? scene.promptAssets : []).filter((x) => String(x && x.id || '').trim() !== assetId),
      missingRequiredAssetIds: scrubIdList(scene && scene.missingRequiredAssetIds),
      readyReferenceAssetIds: scrubIdList(scene && scene.readyReferenceAssetIds)
    }))
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan)
  let rev = 0
  try {
    const doc = await readJson(path.join(dir, 'project.json'))
    rev = Number(doc && doc._rev) || 0
  } catch (_) {}
  return c.json({ success: true, plan: nextPlan, removedAssetId: assetId, removedAssetName: String(target.name || ''), _rev: rev })
})

// 场景↦资产关联确定性修复：按计划资产的名称/别名（+调用方证据别名 aliasOverrides）在场景文本中
// 子串匹配，重建 scene.promptAssets 与 asset.sceneIds/sceneCount。用于修复计划生成器漏写关联的缺陷
//（关联缺失会导致场景渲染 prompt 只剩 worldAnchor，出图同质跑题）。
app.post('/api/projects/:id/ai/story/assets/plan/repair-links', async (c) => {
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)
  const body = await c.req.json().catch(() => ({}))
  const aliasOverrides = body && typeof body.aliasOverrides === 'object' && body.aliasOverrides ? body.aliasOverrides : {}
  const { plan: nextPlan, changes } = repairStoryAssetPlanSceneLinks(plan, { aliasOverrides })
  await saveStoryAssetPlan(id, nextPlan)
  return c.json({ success: true, changes, plan: nextPlan })
})

// ---------------------------------------------------------------------------
// 2026-10-08 故事2 资产继承（《xxxx2》命名约定，用户指令）
// 标题以数字结尾且存在同名基底项目（《小明的工作日2》→《小明的工作日》）时，
// 继承基底项目已锁定的可用资产，跳过抽卡/锁定/线稿等重人工步骤，加速故事2 测试：
//   · 锁定参考图（文件物理复制 + project.json 登记，读回验证——F-63 教训）
//   · 提示词四套（中英正/负：storyboardLockAssetPrompts 按目标 assetId 重映射）
//   · 姿势/状态变体（抠图+绿幕文件复制、重新登记、sceneIds 清空——故事2 场景自绑定）
//   · 线稿（hint/final 文件与字段）
//   · 全局提示词（storyboardGlobal*）+ worldAnchor + 提示词闸（基底已批准→直接置闸）
//   · lock_confirm 审核留痕（decidedBy=inherit）
// 不继承：sceneIds/sceneEvidence/generatedRefs/评审批次历史（故事2 自有剧情数据）。
// 幂等：plan 资产带 inheritedFrom 标记且 referenceStatus=ready 的跳过（force 可重继承）。
// ---------------------------------------------------------------------------

// 《小明的工作日2》/《小明的工作日 2》→ 小明的工作日；无数字后缀返回 ''
function resolveInheritBaseTitle(title) {
  const t = String(title || '').trim()
  const m = /^(.*?)[\s_\-]*\d+$/.exec(t)
  const base = m ? String(m[1] || '').trim() : ''
  return base && base !== t ? base : ''
}

async function findProjectIdByTitle(title, { excludeId = '' } = {}) {
  const want = String(title || '').trim()
  if (!want) return null
  const dirs = await readdir(PROJECTS_DIR).catch(() => [])
  let best = null
  for (const pid of dirs) {
    if (String(pid) === String(excludeId)) continue
    const dir = projectDir(pid)
    if (!(await existsDir(dir))) continue
    const meta = await readJson(path.join(dir, 'meta.json')).catch(() => null)
    if (String(meta?.title || '').trim() !== want) continue
    const stamp = String(meta?.confirmedAt || meta?.updatedAt || '')
    if (!best || stamp > best.stamp) best = { id: String(pid), stamp }
  }
  return best ? best.id : null
}

// 复制项目内相对路径文件（源项目→目标项目，保持相对路径不变），带越界守卫
async function copyProjectAssetFile({ sourceDir, targetDir, relPath }) {
  const rel = String(relPath || '').trim().replace(/^\/+/, '')
  if (!rel) return ''
  const srcAbs = path.resolve(sourceDir, rel)
  if (!srcAbs.startsWith(path.resolve(sourceDir) + path.sep)) return ''
  if (!(await existsFile(srcAbs))) return ''
  const dstAbs = path.resolve(targetDir, rel)
  if (!dstAbs.startsWith(path.resolve(targetDir) + path.sep)) return ''
  await mkdir(path.dirname(dstAbs), { recursive: true })
  await copyFile(srcAbs, dstAbs)
  return rel
}

async function inheritStoryAssetsFromProject({ id, dir, sourceId, force = false }) {
  const srcDir = projectDir(sourceId)
  if (!(await existsDir(srcDir))) {
    const e = new Error(`继承源项目不存在：${sourceId}`)
    e.code = 'inherit_source_not_found'
    throw e
  }
  const srcPlan = await readStoryAssetPlanIfExists(sourceId)
  if (!srcPlan || !Array.isArray(srcPlan.assets)) {
    const e = new Error('继承源项目没有资产计划')
    e.code = 'inherit_source_missing_plan'
    throw e
  }
  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan || !Array.isArray(plan.assets)) {
    const e = new Error('请先生成资产计划，再执行继承。')
    e.code = 'missing_plan'
    throw e
  }
  const srcProject = await readJson(path.join(srcDir, 'project.json')).catch(() => null)
  const srcBg = srcProject?.state?.aiBackground && typeof srcProject.state.aiBackground === 'object' ? srcProject.state.aiBackground : {}
  const srcAssetPrompts = srcBg.storyboardLockAssetPrompts && typeof srcBg.storyboardLockAssetPrompts === 'object' ? srcBg.storyboardLockAssetPrompts : {}
  const normName = (s) => String(s || '').trim().toLowerCase().replace(/[\s《》「」]/g, '')
  const srcByName = new Map()
  for (const a of srcPlan.assets) {
    const key = `${String(a?.category || '').trim()}|${normName(a?.name)}`
    if (key.endsWith('|')) continue
    if (!srcByName.has(key)) srcByName.set(key, a)
  }
  // 2026-10-08 近名模糊匹配（故事2 圣经命名漂移实证：黄色骑手服 vs 黄色外卖骑手服、外卖头盔 vs 骑行头盔）：
  // ①包含匹配（长名含短名且短名 ≥3 字）；②共享 ≥2 字尾缀（头盔/街道/西服类）。
  // 仅当同类别下候选唯一才采纳，多候选/零候选一律未匹配（错配比漏配更糟——错配会锁错参考图）。
  const sharedTailLen = (a, b) => {
    let n = 0
    while (n < Math.min(a.length, b.length) && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1
    return n
  }
  const fuzzyMatchSource = (tCat, tName) => {
    const tn = normName(tName)
    if (tn.length < 2) return null
    const candidates = []
    for (const a of srcPlan.assets) {
      if (String(a?.category || '').trim() !== tCat) continue
      const sn = normName(a?.name)
      if (!sn || sn === tn) continue
      const shorter = tn.length <= sn.length ? tn : sn
      const longer = tn.length <= sn.length ? sn : tn
      if (shorter.length >= 3 && longer.includes(shorter)) { candidates.push(a); continue }
      if (sharedTailLen(tn, sn) >= 2) candidates.push(a)
    }
    return candidates.length === 1 ? candidates[0] : null
  }

  const summary = { sourceId, inherited: [], skipped: [], unmatched: [] }
  const newProjectAssets = []
  const lockTraces = []
  const nextAssets = []
  const matchedSrcByTargetId = new Map()

  for (const target of plan.assets) {
    const tCat = String(target?.category || '').trim()
    const tId = String(target?.id || '').trim()
    const tName = String(target?.name || '').trim()
    if (!tId) { nextAssets.push(target); continue }
    const srcExact = srcByName.get(`${tCat}|${normName(tName)}`) || null
    const src = srcExact || fuzzyMatchSource(tCat, tName)
    if (!src) {
      if (tCat === 'character' || tCat === 'prop') summary.unmatched.push({ assetId: tId, name: tName, category: tCat })
      nextAssets.push(target)
      continue
    }
    if (!force && String(target?.inheritedFrom || '').trim() && String(target?.referenceStatus || '') === 'ready') {
      summary.skipped.push({ assetId: tId, name: tName, reason: 'already_inherited' })
      nextAssets.push(target)
      continue
    }

    const label = `${tName}(${tCat})`
    const patch = { inheritedFrom: String(sourceId) }
    matchedSrcByTargetId.set(tId, src)
    let copied = 0
    // 1) 锁定参考图
    const srcRefUri = String(src?.primaryReferenceAssetUri || '').trim()
    if (srcRefUri) {
      const rel = await copyProjectAssetFile({ sourceDir: srcDir, targetDir: dir, relPath: srcRefUri })
      if (rel) {
        const projectAssetId = genId('asset')
        newProjectAssets.push({
          id: projectAssetId,
          kind: 'image',
          name: `继承参考·${tName}`,
          uri: rel,
          source: { type: 'ai', provider: 'inherit', inheritedFrom: String(sourceId), prompt: String(src?.referencePromptEn || '').trim() }
        })
        patch.primaryReferenceAssetId = projectAssetId
        patch.primaryReferenceAssetUri = rel
        patch.primaryReferenceSelectedAt = nowIso()
        patch.referenceStatus = 'ready'
        copied += 1
        lockTraces.push({ planAssetId: tId, resultImagePath: rel, prompt: String(src?.referencePromptEn || '').trim() })
      }
    }
    // 2) 提示词四套（锚点 + 参考图提示词，与参考图同一证据链，必须整套继承）
    // 2026-10-08 地点锚点不继承（故事2 实证缺陷）：地点锚点含时间/氛围语境（晨光照 vs 夜晚霓虹），
    // 继承会把基底故事的时间覆盖故事2 自有圣经锚点——地点锚点始终保留目标项目圣经原文。
    const skipAnchor = tCat === 'location'
    for (const [sk, tk] of [['anchorPrompt', 'anchorPrompt'], ['negativePrompt', 'negativePrompt'], ['referencePromptZh', 'referencePromptZh'], ['referencePromptEn', 'referencePromptEn'], ['referenceNegativePromptZh', 'referenceNegativePromptZh'], ['referenceNegativePrompt', 'referenceNegativePrompt'], ['referencePromptHint', 'referencePromptHint']]) {
      if (skipAnchor && (sk === 'anchorPrompt' || sk === 'negativePrompt')) continue
      const v = String(src?.[sk] || '').trim()
      if (v) patch[tk] = v
    }
    // 3) 姿势/状态变体（文件复制 + 重新登记；sceneIds 清空，故事2 场景自绑定）
    const srcVariants = [
      ...(Array.isArray(src?.poseVariants) ? src.poseVariants : []),
      ...(Array.isArray(src?.stateVariants) ? src.stateVariants : [])
    ]
    if (srcVariants.length) {
      const variants = []
      for (const v of srcVariants) {
        const cutRel = await copyProjectAssetFile({ sourceDir: srcDir, targetDir: dir, relPath: v?.cutoutPath })
        if (!cutRel) continue
        const greenRel = await copyProjectAssetFile({ sourceDir: srcDir, targetDir: dir, relPath: v?.greenPath })
        const projectAssetId = genId('asset')
        newProjectAssets.push({
          id: projectAssetId,
          kind: 'image',
          name: `继承姿势·${tName}·${String(v?.name || '').trim()}`,
          uri: cutRel,
          source: { type: 'ai', provider: 'inherit', inheritedFrom: String(sourceId), prompt: String(v?.posePrompt || v?.promptEn || '').trim() }
        })
        variants.push({
          id: genId('pose'),
          name: String(v?.name || '').trim(),
          sceneId: '',
          posePrompt: String(v?.posePrompt || '').trim(),
          promptZh: String(v?.promptZh || '').trim(),
          promptEn: String(v?.promptEn || v?.posePrompt || '').trim(),
          ...(String(v?.stateKey || '').trim() ? { stateKey: String(v.stateKey).trim() } : {}),
          greenPath: greenRel || '',
          cutoutPath: cutRel,
          projectAssetId,
          projectAssetUri: cutRel,
          inheritedFrom: String(sourceId),
          createdAt: nowIso()
        })
        copied += 1
      }
      if (variants.length) patch.poseVariants = variants
    }
    // 4) 线稿（文件 + 字段）
    for (const [fk, ik] of [['lineartHintAssetUri', 'lineartHintAssetId'], ['lineartFinalAssetUri', 'lineartFinalAssetId']]) {
      const srcUri = String(src?.[fk] || '').trim()
      if (!srcUri) continue
      const rel = await copyProjectAssetFile({ sourceDir: srcDir, targetDir: dir, relPath: srcUri })
      if (!rel) continue
      const projectAssetId = genId('asset')
      newProjectAssets.push({
        id: projectAssetId,
        kind: 'image',
        name: `继承线稿·${tName}`,
        uri: rel,
        source: { type: 'ai', provider: 'inherit', inheritedFrom: String(sourceId) }
      })
      patch[fk] = rel
      patch[ik] = projectAssetId
      copied += 1
    }
    if (String(src?.lineartStatus || '').trim()) patch.lineartStatus = String(src.lineartStatus).trim()
    if (String(src?.lineartPrompt || '').trim()) patch.lineartPrompt = String(src.lineartPrompt).trim()
    if (String(src?.lineartNegativePrompt || '').trim()) patch.lineartNegativePrompt = String(src.lineartNegativePrompt).trim()

    nextAssets.push({ ...target, ...patch })
    summary.inherited.push({ assetId: tId, name: tName, category: tCat, matchedName: String(src?.name || '').trim(), matchType: srcExact ? 'exact' : 'fuzzy', filesCopied: copied, variants: Array.isArray(patch.poseVariants) ? patch.poseVariants.length : 0 })
  }

  // 5) 全局提示词 + worldAnchor + 提示词闸（基底已批准 → 直接置闸）
  const nextPlan = { ...plan, generatedAt: nowIso(), assets: nextAssets }
  if (String(srcPlan.worldAnchor || '').trim()) nextPlan.worldAnchor = String(srcPlan.worldAnchor).trim()
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })

  // 6) project.json：登记资产 + 提示词/闸/全局（读最新盘 → 写回 → 读回验证，F-63 教训）
  const projPath = path.join(dir, 'project.json')
  const proj = await readJson(projPath)
  const bg = proj?.state?.aiBackground && typeof proj.state.aiBackground === 'object' ? { ...proj.state.aiBackground } : {}
  if (String(srcBg.storyboardGlobalPromptZh || '').trim()) bg.storyboardGlobalPromptZh = String(srcBg.storyboardGlobalPromptZh).trim()
  if (String(srcBg.storyboardGlobalNegativePromptZh || '').trim()) bg.storyboardGlobalNegativePromptZh = String(srcBg.storyboardGlobalNegativePromptZh).trim()
  if (String(srcBg.storyboardGlobalPrompt || '').trim()) bg.storyboardGlobalPrompt = String(srcBg.storyboardGlobalPrompt).trim()
  if (String(srcBg.storyboardGlobalNegativePrompt || '').trim()) bg.storyboardGlobalNegativePrompt = String(srcBg.storyboardGlobalNegativePrompt).trim()
  const promptMap = bg.storyboardLockAssetPrompts && typeof bg.storyboardLockAssetPrompts === 'object' ? { ...bg.storyboardLockAssetPrompts } : {}
  for (const item of summary.inherited) {
    // 源提示词按目标 assetId 重映射（键是 assetId 不是名称）；匹配源复用循环内已定的 exact/fuzzy 结果
    const srcAsset = matchedSrcByTargetId.get(String(item.assetId || '').trim()) || null
    const sp = srcAsset ? srcAssetPrompts[String(srcAsset.id || '').trim()] : null
    if (sp && typeof sp === 'object') {
      promptMap[item.assetId] = {
        promptZh: String(sp.promptZh || '').trim(),
        promptEn: String(sp.promptEn || '').trim(),
        negativePromptZh: String(sp.negativePromptZh || '').trim(),
        negativePrompt: String(sp.negativePrompt || '').trim()
      }
    }
  }
  bg.storyboardLockAssetPrompts = promptMap
  if (summary.inherited.length) bg.storyboardLockPromptGate = { zhConfirmed: true, enApproved: true }
  const nextProj = {
    ...proj,
    state: { ...(proj?.state && typeof proj.state === 'object' ? proj.state : {}), aiBackground: bg },
    assets: [...(Array.isArray(proj?.assets) ? proj.assets : []), ...newProjectAssets],
    updatedAt: nowIso(),
    _rev: Number(proj?._rev || 0) + 1
  }
  await writeJson(projPath, nextProj)
  // 读回验证：登记丢失即抛错（不允许静默失败）
  const verify = await readJson(projPath).catch(() => null)
  const verifyIds = new Set((Array.isArray(verify?.assets) ? verify.assets : []).map((a) => String(a?.id || '')))
  const missing = newProjectAssets.filter((a) => !verifyIds.has(a.id))
  if (missing.length) {
    const e = new Error(`继承登记读回验证失败：${missing.length} 条资产未落盘`)
    e.code = 'inherit_registration_lost'
    throw e
  }

  // 7) lock_confirm 审核留痕（decidedBy=inherit；留痕失败不阻断）
  for (const tr of lockTraces) {
    try {
      const targetKey = `lock_confirm:${tr.planAssetId}:${tr.resultImagePath}`
      const pending = await findPendingReview(dir, { phase: 'lock_confirm', targetKey })
      if (pending) {
        await decideImageReview(dir, pending.reviewId, { approved: true, decidedBy: 'inherit' })
      } else {
        const record = await createImageReview(dir, { phase: 'lock_confirm', targetKey, assetId: tr.planAssetId, resultImagePath: tr.resultImagePath, prompt: tr.prompt })
        await decideImageReview(dir, record.reviewId, { approved: true, decidedBy: 'inherit' })
      }
    } catch (_) { /* 留痕失败不阻断 */ }
  }
  return summary
}

// 《xxxx2》命名自动继承：plan 生成后调用；无基底可解析返回 null
async function maybeAutoInheritStoryAssets(id) {
  const meta = await readJson(path.join(projectDir(id), 'meta.json')).catch(() => null)
  const baseTitle = resolveInheritBaseTitle(meta?.title)
  if (!baseTitle) return null
  const sourceId = await findProjectIdByTitle(baseTitle, { excludeId: id })
  if (!sourceId) return null
  const task = createAiTask(id, 'story.assets.inherit', { total: 1, message: `继承基底项目《${baseTitle}》的已锁定资产` })
  logStage({ stage: 'story.assets.inherit', event: 'start', project: id, item: `${baseTitle} ← ${sourceId}` })
  try {
    const summary = await inheritStoryAssetsFromProject({ id, dir: projectDir(id), sourceId })
    updateAiTask(task.taskId, {
      done: true,
      current: 1,
      stage: 'done',
      message: `继承完成：${summary.inherited.length} 资产（${summary.inherited.map((x) => x.name).join('、') || '无'}），未匹配 ${summary.unmatched.length}`,
      result: summary
    })
    logStage({ stage: 'story.assets.inherit', event: 'ok', project: id, item: `inherited:${summary.inherited.length} unmatched:${summary.unmatched.length}` })
    return { baseTitle, sourceId, ...summary }
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    updateAiTask(task.taskId, { done: true, stage: 'error', error: msg, message: `继承失败：${msg}` })
    logStage({ stage: 'story.assets.inherit', event: 'error', project: id, item: msg })
    return { baseTitle, sourceId, error: msg }
  }
}

// 手动/事件链继承入口：sourceId 可省略（按《xxxx2》命名约定自动解析基底）
app.post('/api/projects/:id/ai/story/assets/inherit', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  let sourceId = String(body?.sourceId || '').trim()
  let baseTitle = ''
  if (!sourceId) {
    const meta = await readJson(path.join(dir, 'meta.json')).catch(() => null)
    baseTitle = resolveInheritBaseTitle(meta?.title)
    if (!baseTitle) return c.json({ success: false, error: 'inherit_base_not_resolved', message: '项目名不含数字后缀，无法按《xxxx2》约定解析基底项目；请显式传 sourceId。' }, 400)
    sourceId = await findProjectIdByTitle(baseTitle, { excludeId: id })
    if (!sourceId) return c.json({ success: false, error: 'inherit_base_not_found', message: `未找到基底项目《${baseTitle}》` }, 404)
  }
  try {
    const summary = await inheritStoryAssetsFromProject({ id, dir, sourceId, force: body?.force === true })
    return c.json({ success: true, baseTitle: baseTitle || undefined, sourceId, ...summary })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const code = String((e && e.code) || 'inherit_failed')
    return c.json({ success: false, error: code, message: msg }, code === 'missing_plan' ? 400 : 500)
  }
})

async function generateAndPersistStoryAssetReference({
  id,
  dir,
  bundle,
  plan,
  asset,
  studio,
  imgProvider,
  style,
  width,
  height,
  steps,
  cfgScale,
  sampler,
  scheduler,
  model,
  loras,
  prompt,
  negativePrompt,
  timeoutMs,
  seed
}) {
  const renderProfile = getStoryAssetRenderProfile(asset)
  const gen = await generateBackgroundImage({
    prompt,
    negativePrompt,
    width,
    height,
    style,
    steps,
    cfgScale,
    sampler,
    scheduler,
    seed,
    provider: imgProvider,
    sdwebuiBaseUrl: studio.effective.image.sdwebuiBaseUrl,
    comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
    apiUrl: studio.effective.image.apiUrl,
    model,
    loras,
    workflowMode: String(renderProfile.workflowMode || '').trim() || undefined,
    lockProfile: String(renderProfile.profile || '').trim() || undefined,
    proxyUrl: studio.effective.network.proxyUrl,
    timeoutMs
  })

  const finalGen = gen
  const buf = finalGen.bytes
  const ext0 = String(finalGen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
  const sniff = sniffImageMetaFromBytes(buf)
  const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'
  const target = buildStoryAssetFileTarget({
    dir,
    asset,
    prefix: 'reference',
    ext,
    seed
  })
  await mkdir(target.outDir, { recursive: true })
  await writeFile(target.absPath, buf)
  const assetPath = target.assetPath

  const projectAssetId = genId('asset')
  const projectAsset = {
    id: projectAssetId,
    kind: 'image',
    name: `故事资产 ${String(asset.name || asset.id || projectAssetId).trim()}`,
    uri: assetPath,
    source: {
      type: 'ai',
      prompt,
      negativePrompt,
      provider: String(finalGen?.meta?.provider || imgProvider || ''),
      model: String(finalGen?.meta?.model || model || '').trim() || undefined,
      remoteUrl: String(finalGen?.meta?.url || '').trim() || undefined,
      loras: Array.isArray(loras) ? loras : undefined,
      seed: Number.isFinite(Number(seed)) ? Number(seed) : (Number.isFinite(Number(finalGen?.meta?.seed)) ? Number(finalGen.meta.seed) : undefined)
    }
  }
  const nextProject = {
    ...bundle.rawProject,
    assets: [...(Array.isArray(bundle.rawProject.assets) ? bundle.rawProject.assets : []), projectAsset],
    updatedAt: new Date().toISOString()
  }
  await writeJson(path.join(dir, 'project.json'), nextProject)

  const nextPlan = {
    ...plan,
    generatedAt: new Date().toISOString(),
    assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
      if (String(item && item.id || '').trim() !== String(asset.id || '').trim()) return item
      const prevRefs = Array.isArray(item.generatedRefs) ? item.generatedRefs : []
      const hasPrimary = Boolean(String(item?.primaryReferenceAssetUri || '').trim())
      return {
        ...item,
        referenceStatus: hasPrimary ? 'ready' : 'candidates_ready',
        generatedRefs: [
          ...prevRefs,
          {
            projectAssetId,
            projectAssetUri: assetPath,
            createdAt: new Date().toISOString(),
            provider: String(finalGen?.meta?.provider || imgProvider || ''),
            model: String(finalGen?.meta?.model || model || '').trim() || undefined,
            remoteUrl: String(finalGen?.meta?.url || '').trim() || undefined,
            loras: Array.isArray(loras) ? loras : undefined,
            prompt,
            negativePrompt,
            width,
            height,
            seed: Number.isFinite(Number(seed)) ? Number(seed) : (Number.isFinite(Number(finalGen?.meta?.seed)) ? Number(finalGen.meta.seed) : undefined)
          }
        ]
      }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })

  return {
    asset: (Array.isArray(nextPlan.assets) ? nextPlan.assets.find((item) => String(item && item.id || '').trim() === String(asset.id || '').trim()) : null) || null,
    projectAsset,
    assetPath,
    url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`,
    provider: String(finalGen?.meta?.provider || imgProvider || ''),
    model: String(finalGen?.meta?.model || model || '').trim() || undefined,
    remoteUrl: String(finalGen?.meta?.url || '').trim() || undefined,
    prompt,
    negativePrompt,
    seed: Number.isFinite(Number(seed)) ? Number(seed) : (Number.isFinite(Number(finalGen?.meta?.seed)) ? Number(finalGen.meta.seed) : undefined),
    plan: nextPlan
  }
}

// 锁定主参考的抠图后处理：character/prop 走 RMBG 透明立绘（分层合成方向），
// 失败时兜底回退为原图引用（catch 语义保留，不阻断 select 主流程）
async function applyCutoutToStoryAssetReference({
  id,
  dir,
  plan,
  asset,
  sourceRef,
  studio,
  timeoutMs
}) {
  const category = String(asset?.category || '').trim()
  const comfyuiBaseUrl = String(studio?.effective?.image?.comfyuiBaseUrl || '').trim()
  if (!['character', 'prop'].includes(category) || !comfyuiBaseUrl) {
    return {
      plan,
      primaryReferenceAssetId: String(sourceRef?.projectAssetId || '').trim(),
      primaryReferenceAssetUri: String(sourceRef?.projectAssetUri || '').trim()
    }
  }

  const sourceUri = String(sourceRef?.projectAssetUri || '').trim().replace(/^\/+/, '')
  if (!sourceUri) {
    return {
      plan,
      primaryReferenceAssetId: String(sourceRef?.projectAssetId || '').trim(),
      primaryReferenceAssetUri: String(sourceRef?.projectAssetUri || '').trim()
    }
  }

  try {
    const abs = path.join(dir, sourceUri)
    const bytes = await readFile(abs)
    // character/prop 一律输出透明立绘（RMBG Alpha），供运行时分层合成
    const post = await generateComfyuiCutoutFromReference({
      referenceBytes: bytes,
      referenceFilename: `${String(asset?.id || 'asset').trim() || 'asset'}_selected.png`,
      comfyuiBaseUrl,
      processRes: Math.max(Number(sourceRef?.width) || 0, Number(sourceRef?.height) || 0, 1024),
      timeoutMs,
      prefix: buildStoryAssetComfyPrefix(asset, 'selected_cutout'),
      transparent: true
    })
    const postprocess = String(post?.meta?.postprocess || '').trim() || 'rmbg_alpha'

    const ext = String(post.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
    const target = buildStoryAssetFileTarget({
      dir,
      asset,
      prefix: 'selected_cutout',
      ext,
      seed: sourceRef && sourceRef.seed
    })
    await mkdir(target.outDir, { recursive: true })
    await writeFile(target.absPath, post.bytes)
    // 2026-09-09 出图即压：选定立绘无损 WebP（真相源零质量损失）
    const optSel = await optimizeGeneratedImage(target.absPath, IMAGE_KIND.SPRITE_LOSSLESS).catch(() => null)
    const relPath = optSel && optSel.outPath && optSel.outPath !== target.absPath
      ? String(assetPathFromAbsolute(id, optSel.outPath) || target.assetPath)
      : target.assetPath

    const projectAssetId = genId('asset')
    const projectAsset = {
      id: projectAssetId,
      kind: 'image',
      name: `故事资产立绘 ${String(asset?.name || asset?.id || projectAssetId).trim()}`,
      uri: relPath,
      source: {
        type: 'ai',
        prompt: String(sourceRef?.prompt || '').trim() || undefined,
        negativePrompt: String(sourceRef?.negativePrompt || '').trim() || undefined,
        provider: String(post?.meta?.provider || 'comfyui'),
        remoteUrl: String(post?.meta?.url || '').trim() || undefined,
        loras: Array.isArray(sourceRef?.loras) ? sourceRef.loras : undefined,
        seed: Number.isFinite(Number(sourceRef?.seed)) ? Number(sourceRef.seed) : undefined,
        postprocess
      }
    }

    const bundle = await readProjectBundle(id)
    const nextProject = {
      ...bundle.rawProject,
      assets: [...(Array.isArray(bundle.rawProject.assets) ? bundle.rawProject.assets : []), projectAsset],
      updatedAt: new Date().toISOString()
    }
    await writeJson(path.join(dir, 'project.json'), nextProject)

    const nextPlan = {
      ...plan,
      generatedAt: new Date().toISOString(),
      assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
        if (String(item && item.id || '').trim() !== String(asset?.id || '').trim()) return item
        const prevRefs = Array.isArray(item.generatedRefs) ? item.generatedRefs : []
        return {
          ...item,
          generatedRefs: [
            ...prevRefs,
            {
              projectAssetId,
              projectAssetUri: relPath,
              createdAt: new Date().toISOString(),
              provider: String(post?.meta?.provider || 'comfyui'),
              remoteUrl: String(post?.meta?.url || '').trim() || undefined,
              loras: Array.isArray(sourceRef?.loras) ? sourceRef.loras : undefined,
              prompt: String(sourceRef?.prompt || '').trim(),
              negativePrompt: String(sourceRef?.negativePrompt || '').trim(),
              width: Number(sourceRef?.width) || undefined,
              height: Number(sourceRef?.height) || undefined,
              seed: Number.isFinite(Number(sourceRef?.seed)) ? Number(sourceRef.seed) : undefined,
              postprocess
            }
          ]
        }
      }) : plan.assets
    }
    nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
    await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
    return { plan: nextPlan, primaryReferenceAssetId: projectAssetId, primaryReferenceAssetUri: relPath }
  } catch (_) {
    return {
      plan,
      primaryReferenceAssetId: String(sourceRef?.projectAssetId || '').trim(),
      primaryReferenceAssetUri: String(sourceRef?.projectAssetUri || '').trim()
    }
  }
}

function deriveStoryAssetReferenceStatus(item) {
  const primaryUri = String(item?.primaryReferenceAssetUri || '').trim()
  if (primaryUri) return 'ready'
  const batch = Array.isArray(item?.latestReferenceBatch) ? item.latestReferenceBatch : []
  const refs = Array.isArray(item?.generatedRefs) ? item.generatedRefs : []
  if (batch.length || refs.length) return 'candidates_ready'
  return String(item?.referenceStatus || 'missing').trim() || 'missing'
}

async function persistStoryAssetReferenceBatch({
  id,
  plan,
  assetId,
  latestReferenceBatch,
  recommendedReferenceAssetUri
}) {
  const nextPlan = {
    ...plan,
    generatedAt: new Date().toISOString(),
    assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
      if (String(item && item.id || '').trim() !== String(assetId || '').trim()) return item
      const batch = Array.isArray(latestReferenceBatch) ? latestReferenceBatch.filter((x) => x && typeof x === 'object') : []
      const refStatus = String(item?.primaryReferenceAssetUri || '').trim() ? 'ready' : (batch.length ? 'candidates_ready' : deriveStoryAssetReferenceStatus(item))
      return {
        ...item,
        referenceStatus: refStatus,
        latestReferenceBatch: batch,
        latestRecommendedReferenceAssetUri: String(recommendedReferenceAssetUri || '').trim(),
        latestReferenceReview: String(item?.primaryReferenceAssetUri || '').trim() ? item.latestReferenceReview || null : null
      }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
  return nextPlan
}

async function writeStoryAssetPrimaryToProject({ id, dir, asset, primaryReferenceAssetId }) {
  const bundle = await readProjectBundle(id)
  const nextProject = {
    ...bundle.rawProject,
    updatedAt: new Date().toISOString(),
    characters: Array.isArray(bundle.rawProject.characters) ? bundle.rawProject.characters.map((ch) => {
      if (String(asset?.category || '').trim() !== 'character') return ch
      if (String(ch && ch.id || '').trim() !== String(asset?.projectCharacterId || '').trim()) return ch
      return {
        ...ch,
        ai: {
          ...((ch && ch.ai && typeof ch.ai === 'object') ? ch.ai : {}),
          referenceAssetId: String(primaryReferenceAssetId || '').trim()
        }
      }
    }) : bundle.rawProject.characters
  }
  await writeJson(path.join(dir, 'project.json'), nextProject)
}

// 2026-09-28：锁定写回时补齐提示词中文稿（确定性模板，不调 LLM、不阻断锁定）。
// 背景：自动生产链不走编辑器「AI 生成提示词」向导，promptZh 从未产生，编辑器打开时只能归一化出
// 英文/负向词骨架，锁定工作区提示词面板首栏（中文稿）空白（《小猫钓鱼》12/12 资产实测全空）。
// 这里用 buildStoryAssetPromptEnhancement 的本地模板兜底中文稿；编辑器「AI 生成提示词」仍可覆盖出更精细的稿子。
async function backfillStoryAssetPromptDraftZh({ id, dir, plan, asset }) {
  const assetId = storyAssetStr(asset && asset.id).trim()
  if (!assetId) return
  const bundle = await readProjectBundle(id)
  const doc = bundle.rawProject && typeof bundle.rawProject === 'object' ? bundle.rawProject : null
  if (!doc) return
  const state = doc.state && typeof doc.state === 'object' ? doc.state : {}
  const aiBg = state.aiBackground && typeof state.aiBackground === 'object' ? state.aiBackground : {}
  const drafts = aiBg.storyboardLockAssetPrompts && typeof aiBg.storyboardLockAssetPrompts === 'object' ? { ...aiBg.storyboardLockAssetPrompts } : {}
  const prev = drafts[assetId] && typeof drafts[assetId] === 'object' ? drafts[assetId] : {}
  if (storyAssetStr(prev.promptZh).trim()) return // 已有中文稿（人工/AI 生成）不覆盖
  const fallback = buildStoryAssetPromptEnhancement({ asset, plan })
  const promptZh = storyAssetStr(fallback && fallback.promptZh).trim()
  if (!promptZh) return
  drafts[assetId] = {
    ...prev,
    promptZh,
    promptEn: storyAssetStr(prev.promptEn).trim() || storyAssetStr(fallback.promptEn).trim(),
    negativePromptZh: storyAssetStr(prev.negativePromptZh).trim() || storyAssetStr(fallback.negativePromptZh).trim(),
    negativePrompt: storyAssetStr(prev.negativePrompt).trim() || storyAssetStr(fallback.negativePrompt).trim()
  }
  await writeJson(path.join(dir, 'project.json'), {
    ...doc,
    updatedAt: new Date().toISOString(),
    state: { ...state, aiBackground: { ...aiBg, storyboardLockAssetPrompts: drafts } }
  })
}

function getStoryAssetRenderSize(asset, stylePreset) {
  const profile = getStoryAssetRenderProfile(asset && typeof asset === 'object' ? asset : { category: asset }, stylePreset)
  return { width: Number(profile.width || 768), height: Number(profile.height || 768) }
}

async function persistStoryAssetLineartResult({
  id,
  dir,
  plan,
  asset,
  hintBytes,
  hintExt,
  finalBytes,
  finalExt,
  meta,
  prompt,
  negativePrompt
}) {
  const hintTarget = buildStoryAssetFileTarget({
    dir,
    asset,
    prefix: 'lineart_hint',
    ext: String(hintExt || 'png'),
    seed: meta && meta.seed
  })
  const finalTarget = buildStoryAssetFileTarget({
    dir,
    asset,
    prefix: 'lineart_final',
    ext: String(finalExt || 'png'),
    seed: meta && meta.seed
  })
  await mkdir(hintTarget.outDir, { recursive: true })
  await writeFile(hintTarget.absPath, hintBytes)
  await writeFile(finalTarget.absPath, finalBytes)
  const hintPath = hintTarget.assetPath
  const finalPath = finalTarget.assetPath

  const hintAssetId = genId('asset')
  const finalAssetId = genId('asset')
  const hintProjectAsset = {
    id: hintAssetId,
    kind: 'image',
    name: `线稿提示 ${String(asset?.name || asset?.id || hintAssetId).trim()}`,
    uri: hintPath,
    source: {
      type: 'ai',
      prompt,
      provider: String(meta?.provider || 'comfyui'),
      remoteUrl: String(meta?.hintUrl || '').trim() || undefined
    }
  }
  const finalProjectAsset = {
    id: finalAssetId,
    kind: 'image',
    name: `线稿成品 ${String(asset?.name || asset?.id || finalAssetId).trim()}`,
    uri: finalPath,
    source: {
      type: 'ai',
      prompt,
      provider: String(meta?.provider || 'comfyui'),
      remoteUrl: String(meta?.finalUrl || '').trim() || undefined
    }
  }

  const bundle = await readProjectBundle(id)
  const nextProject = {
    ...bundle.rawProject,
    assets: [
      ...(Array.isArray(bundle.rawProject.assets) ? bundle.rawProject.assets : []),
      hintProjectAsset,
      finalProjectAsset
    ],
    updatedAt: new Date().toISOString()
  }
  await writeJson(path.join(dir, 'project.json'), nextProject)

  const nextPlan = {
    ...plan,
    generatedAt: new Date().toISOString(),
    assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
      if (String(item && item.id || '').trim() !== String(asset?.id || '').trim()) return item
      return {
        ...item,
        lineartHintAssetId: hintAssetId,
        lineartHintAssetUri: hintPath,
        lineartFinalAssetId: finalAssetId,
        lineartFinalAssetUri: finalPath,
        lineartStatus: 'ready',
        lineartPrompt: String(prompt || '').trim(),
        lineartNegativePrompt: String(negativePrompt || '').trim(),
        lineartMeta: meta && typeof meta === 'object' ? meta : null,
        lineartGeneratedAt: new Date().toISOString()
      }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
  return {
    plan: nextPlan,
    asset: (Array.isArray(nextPlan.assets) ? nextPlan.assets.find((item) => String(item && item.id || '').trim() === String(asset?.id || '').trim()) : null) || null,
    hintProjectAsset,
    finalProjectAsset,
    hintAssetPath: hintPath,
    finalAssetPath: finalPath,
    hintUrl: `/project-assets/${encodeURIComponent(String(id))}/${hintPath}`,
    finalUrl: `/project-assets/${encodeURIComponent(String(id))}/${finalPath}`
  }
}

async function reviewAndPersistStoryAssetReference({
  id,
  dir,
  studio,
  plan,
  asset,
  prompt,
  negativePrompt,
  assetPath
}) {
  const abs = path.join(dir, String(assetPath || '').replace(/^\/+/, ''))
  const buf = await readFile(abs)
  const sniff = sniffImageMetaFromBytes(buf)
  if (!sniff) {
    const e = new Error('invalid_story_asset_reference_image')
    e.status = 400
    throw e
  }
  const analysis = await reviewStoryboardLockImageWithAi({
    provider: process.env.MOONSHOT_API_KEY ? 'moonshot' : studio.effective.prompt.provider,
    model: process.env.MOONSHOT_API_KEY ? 'kimi-for-coding' : studio.effective.prompt.model,
    apiUrl: studio.effective.prompt.apiUrl,
    proxyUrl: studio.effective.network.proxyUrl,
    moonshotApiKey: process.env.MOONSHOT_API_KEY || '',
    moonshotBaseUrl: process.env.MOONSHOT_BASE_URL || 'https://api.kimi.com/coding/v1',
    asset,
    prompt,
    negativePrompt,
    imageDataUrl: `data:${sniff.contentType};base64,${buf.toString('base64')}`,
    attempt: 1,
    maxAttempts: 1
  })

  const review = {
    reviewedAt: new Date().toISOString(),
    targetAssetUri: String(assetPath || '').trim(),
    prompt: String(prompt || '').trim(),
    negativePrompt: String(negativePrompt || '').trim(),
    passed: Boolean(analysis && analysis.passed),
    score: Number.isFinite(Number(analysis && analysis.score)) ? Math.max(0, Math.min(100, Math.round(Number(analysis.score)))) : null,
    summary: String(analysis && analysis.summary || '').trim(),
    issues: Array.isArray(analysis && analysis.issues) ? analysis.issues.map((x) => String(x || '').trim()).filter(Boolean) : [],
    revisedPrompt: String(analysis && analysis.revisedPrompt || '').trim(),
    revisedNegativePrompt: String(analysis && analysis.revisedNegativePrompt || '').trim(),
    skipped: Boolean(analysis && analysis.skipped)
  }
  const nextPlan = {
    ...plan,
    assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
      if (String(item && item.id || '').trim() !== String(asset.id || '').trim()) return item
      return { ...item, latestReferenceReview: review }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })

  return {
    asset: (Array.isArray(nextPlan.assets) ? nextPlan.assets.find((item) => String(item && item.id || '').trim() === String(asset.id || '').trim()) : null) || null,
    analysis: review,
    plan: nextPlan
  }
}

function storyAssetReviewScore(analysis) {
  const score = Number(analysis && analysis.score)
  if (Number.isFinite(score)) return Math.max(0, Math.min(100, Math.round(score)))
  return analysis && analysis.passed ? 100 : -1
}

function shouldDiscardStoryAssetReferenceCandidate(analysis) {
  const score = storyAssetReviewScore(analysis)
  if (score >= 0 && score < 20) return true
  const summary = String(analysis && analysis.summary || '').trim()
  const issues = Array.isArray(analysis && analysis.issues) ? analysis.issues.map((x) => String(x || '').trim()).join(' | ') : ''
  const hay = `${summary} | ${issues}`.toLowerCase()
  if (!hay) return false
  if (/(主体类别错误|严重跑题|人形角色|人物而非|human|humanoid|android|cyborg|robot|person instead|body parts)/i.test(hay)) return true
  return false
}

async function setPrimaryStoryAssetReference({
  id,
  plan,
  assetId,
  primaryReferenceAssetId,
  primaryReferenceAssetUri,
  latestReferenceReview,
  latestReferenceBatch,
  selectedBatchAssetPath,
  resetLineart = true
}) {
  const selectedBatchUri = normalizeStoryAssetUri(selectedBatchAssetPath)
  const normalizedPrimaryUri = normalizeStoryAssetUri(primaryReferenceAssetUri)
  const nextPlan = {
    ...plan,
    generatedAt: new Date().toISOString(),
    assets: Array.isArray(plan.assets) ? plan.assets.map((item) => {
      if (String(item && item.id || '').trim() !== String(assetId || '').trim()) return item
      const nextBatch = Array.isArray(latestReferenceBatch)
        ? latestReferenceBatch
          .filter((x) => x && typeof x === 'object')
          .map((entry) => {
            const entryPath = normalizeStoryAssetUri(entry && entry.assetPath)
            if (!selectedBatchUri || !normalizedPrimaryUri || entryPath !== selectedBatchUri) return entry
            return {
              ...entry,
              assetPath: normalizedPrimaryUri,
              url: `/project-assets/${encodeURIComponent(String(id || ''))}/${normalizedPrimaryUri}`
            }
          })
        : (Array.isArray(item.latestReferenceBatch) ? item.latestReferenceBatch : [])
      const nextItem = {
        ...item,
        primaryReferenceAssetId: String(primaryReferenceAssetId || '').trim(),
        primaryReferenceAssetUri: String(primaryReferenceAssetUri || '').trim(),
        primaryReferenceSelectedAt: new Date().toISOString(),
        referenceStatus: String(primaryReferenceAssetUri || '').trim() ? 'ready' : deriveStoryAssetReferenceStatus(item),
        latestReferenceReview: latestReferenceReview && typeof latestReferenceReview === 'object' ? latestReferenceReview : (item.latestReferenceReview || null),
        latestReferenceBatch: nextBatch
      }
      if (!resetLineart) return nextItem
      return {
        ...nextItem,
        lineartHintAssetId: '',
        lineartHintAssetUri: '',
        lineartFinalAssetId: '',
        lineartFinalAssetUri: '',
        lineartStatus: 'missing',
        lineartPrompt: '',
        lineartNegativePrompt: '',
        lineartMeta: null,
        lineartGeneratedAt: ''
      }
    }) : plan.assets
  }
  nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
  await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
  return nextPlan
}

app.post('/api/projects/:id/ai/story/assets/reference', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const traceId = createTraceId()

  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const bundle = await readProjectBundle(id)
  let plan = await readStoryAssetPlanIfExists(id)
  if (!plan) {
    const storyBible = readStoryBibleFromProjectDoc(bundle.project)
    if (!storyBible || typeof storyBible !== 'object') {
      return c.json({ success: false, error: 'missing_story_bible', message: '未找到 Story Bible。请先生成 Story Bible 并创建资产计划。' }, 400)
    }
    plan = buildStoryAssetPlan({ project: bundle.project, story: bundle.story, storyBible, prevManifest: null })
  }

  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
  const imgProvider = String(studio.effective.image.provider || process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()
  if (!imgProvider || imgProvider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“出图（背景图）”并选择 Provider/Model' }, 400)
  }

  const aiBg = bundle.project && bundle.project.state && bundle.project.state.aiBackground && typeof bundle.project.state.aiBackground === 'object'
    ? bundle.project.state.aiBackground
    : {}
  const draft = aiBg && aiBg.storyboardBatchDraft && typeof aiBg.storyboardBatchDraft === 'object'
    ? aiBg.storyboardBatchDraft
    : {}
  const requestedLoras = Array.isArray(body?.loras)
    ? body.loras.map((x) => String(x || '').trim()).filter(Boolean)
    : (
        Array.isArray(draft?.loras)
          ? draft.loras.map((x) => String(x || '').trim()).filter(Boolean)
          : (Array.isArray(studio.effective.image.loras) ? studio.effective.image.loras.map((x) => String(x || '').trim()).filter(Boolean) : [])
      )
  const stylePreset = resolveStoryStylePreset(studio)
  const effectiveLoras = chooseStoryboardAssetLoras({ asset, requestedLoras, stylePreset })
  const requestedModel = String(body?.model || draft?.model || '').trim()
  const modelResolution = await resolveStoryboardAssetModel({ studio, imgProvider, requestedModel, asset })
  const effectiveModel = String(modelResolution.model || '').trim()
  const style = normalizeStyleEnum(body?.style || draft.style || 'picture_book')
  const { width: widthDefault, height: heightDefault } = getStoryAssetRenderSize(asset, stylePreset)
  const width = clampInt(body?.width, 256, 2048, widthDefault)
  const height = clampInt(body?.height, 256, 2048, heightDefault)
  const batchSize = clampInt(body?.batchSize, 1, 6, 4)
  const globalPrompt = String(body?.globalPrompt || '').trim()
  const globalNegativePrompt = String(body?.globalNegativePrompt || '').trim()
  const sanitizedDraft = sanitizeProtectedAssetPrompt({
    asset,
    promptEn: String(body?.assetPrompt || body?.promptEn || '').trim(),
    negativePrompt: String(body?.assetNegativePrompt || '').trim()
  })
  const assetPrompt = pickEnglishPrompt(
    sanitizedDraft.promptEn,
    storyAssetStr(asset && asset.referencePromptEn).trim(),
    storyAssetStr(asset && asset.referencePromptHint).trim()
  )
  const assetNegativePrompt = sanitizedDraft.negativePrompt
  const prompt = String(body?.prompt || '').trim() || buildStoryAssetReferencePrompt({ plan, asset, style, globalPrompt, assetPrompt, stylePreset })
  const negativePrompt = String(body?.negativePrompt || '').trim() || buildStoryAssetReferenceNegativePrompt({ plan, asset, globalNegativePrompt, assetNegativePrompt })

  try {
    logStage({ stage: 'asset.reference.batch', event: 'start', traceId, project: id, item: assetId, ok: true, detail: 'generate_candidates_only' })
    // 2026-08-29 出图可观测（AGENTS.md 强制规则）：参考图抽卡批次必须在 UI 暴露真实进度，禁止黑盒
    const refTask = createAiTask(id, 'story.asset.reference_batch', {
      total: batchSize,
      message: `参考图抽卡：${String(asset.name || assetId).trim()}`
    })
    let currentPlan = await persistStoryAssetReferenceBatch({
      id,
      plan,
      assetId,
      latestReferenceBatch: [],
      recommendedReferenceAssetUri: ''
    })
    let currentBundle = bundle
    let bestResult = null
    let bestReview = null
    let attemptPrompt = prompt
    let attemptNegativePrompt = negativePrompt
    const baseSeed = Math.floor(Math.random() * 4_294_900_000)
    const rawCandidates = []
    const maxAttempts = Math.max(batchSize, Math.min(12, batchSize + 4))
    for (let i = 0; i < maxAttempts && rawCandidates.length < batchSize; i += 1) {
      const seed = (baseSeed + i * 9973) % 4_294_967_295
      updateAiTask(refTask.taskId, { stage: 'generating', current: i + 1, message: `第 ${i + 1}/${batchSize} 张生成中…（${String(asset.name || assetId).trim()}）` })
      const result = await generateAndPersistStoryAssetReference({
        id,
        dir,
        bundle: currentBundle,
        plan: currentPlan,
        asset,
        studio,
        imgProvider,
        style,
        width,
        height,
        steps: body?.steps,
        cfgScale: body?.cfgScale,
        sampler: body?.sampler,
        scheduler: body?.scheduler,
        model: effectiveModel,
        loras: effectiveLoras,
        prompt: attemptPrompt,
        negativePrompt: attemptNegativePrompt,
        timeoutMs: body?.timeoutMs,
        seed
      })
      currentPlan = result.plan
      currentBundle = await readProjectBundle(id)
      updateAiTask(refTask.taskId, { stage: 'reviewing', current: i + 1, message: `第 ${i + 1}/${batchSize} 张 AI 评审中…` })
      const reviewed = await reviewAndPersistStoryAssetReference({
        id,
        dir,
        studio,
        plan: currentPlan,
        asset,
        prompt: result.prompt,
        negativePrompt: result.negativePrompt,
        assetPath: result.assetPath
      })
      currentPlan = reviewed.plan
      const revisedPrompt = pickEnglishPrompt(String(reviewed.analysis?.revisedPrompt || '').trim(), attemptPrompt)
      const revisedNegativePrompt = String(reviewed.analysis?.revisedNegativePrompt || '').trim() || attemptNegativePrompt
      if (!Boolean(reviewed.analysis?.passed) && (revisedPrompt !== attemptPrompt || revisedNegativePrompt !== attemptNegativePrompt)) {
        attemptPrompt = revisedPrompt
        attemptNegativePrompt = revisedNegativePrompt
      }
      if (!shouldDiscardStoryAssetReferenceCandidate(reviewed.analysis)) {
        rawCandidates.push({
          attempt: i + 1,
          seed,
          assetPath: result.assetPath,
          url: result.url,
          analysis: reviewed.analysis
        })
      }
      if (!bestResult || storyAssetReviewScore(reviewed.analysis) > storyAssetReviewScore(bestReview)) {
        bestResult = result
        bestReview = reviewed.analysis
      }
      const partialRecommendedAssetPath = bestResult ? String(bestResult.assetPath || '').trim() : ''
      const partialCandidates = rawCandidates.map((item) => ({
        ...item,
        recommended: Boolean(partialRecommendedAssetPath && String(item.assetPath || '').trim() === partialRecommendedAssetPath)
      }))
      currentPlan = await persistStoryAssetReferenceBatch({
        id,
        plan: currentPlan,
        assetId,
        latestReferenceBatch: partialCandidates,
        recommendedReferenceAssetUri: partialRecommendedAssetPath
      })
    }
    const recommendedAssetPath = bestResult ? String(bestResult.assetPath || '').trim() : ''
    const candidates = rawCandidates.map((item) => ({
      ...item,
      recommended: Boolean(recommendedAssetPath && String(item.assetPath || '').trim() === recommendedAssetPath)
    }))
    currentPlan = await persistStoryAssetReferenceBatch({
      id,
      plan: currentPlan,
      assetId,
      latestReferenceBatch: candidates,
      recommendedReferenceAssetUri: recommendedAssetPath
    })
    const currentAsset = (Array.isArray(currentPlan.assets) ? currentPlan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null) || null
    updateAiTask(refTask.taskId, { stage: 'done', done: true, current: candidates.length, message: `抽卡完成：${candidates.length} 张候选（${String(asset.name || assetId).trim()}）` })
    logStage({ stage: 'asset.reference.batch', event: 'ok', traceId, project: id, item: assetId, ok: true, detail: 'generate_candidates_only', count: candidates.length })
    return c.json({ success: true, asset: currentAsset, analysis: bestReview, recommendedAssetPath, candidates, model: effectiveModel || undefined, modelSource: modelResolution.source, ...(bestResult || {}), plan: currentPlan })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    if (typeof refTask !== 'undefined' && refTask) updateAiTask(refTask.taskId, { stage: 'error', done: true, error: msg, message: msg })
    logStage({ stage: 'asset.reference.batch', event: 'fail', traceId, project: id, item: assetId, status: mapped.httpStatus, ok: false, err: msg })
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

app.post('/api/projects/:id/ai/story/assets/reference/review', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  const assetPath = String(asset.primaryReferenceAssetUri || '').trim()
  if (!assetPath) return c.json({ success: false, error: 'missing_reference_image', message: '请先从 4 张候选图中手动选择主参考，再执行分析。' }, 400)
  const latestRef = Array.isArray(asset.generatedRefs) ? asset.generatedRefs.find((x) => String(x?.projectAssetUri || '').trim() === assetPath) : null
  const prompt = String(latestRef?.prompt || buildStoryAssetReferencePrompt({ plan, asset, style: 'picture_book' })).trim()
  const negativePrompt = String(latestRef?.negativePrompt || buildStoryAssetReferenceNegativePrompt({ plan, asset })).trim()

  try {
    const studio = await getEffectiveStudioConfig(ROOT)
    const result = await reviewAndPersistStoryAssetReference({
      id,
      dir,
      studio,
      plan,
      asset,
      prompt,
      negativePrompt,
      assetPath
    })
    return c.json({ success: true, ...result })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

app.post('/api/projects/:id/ai/story/assets/reference/optimize', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const bundle = await readProjectBundle(id)
  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  const currentAssetPath = String(asset.primaryReferenceAssetUri || '').trim()
  if (!currentAssetPath) return c.json({ success: false, error: 'missing_reference_image', message: '请先从 4 张候选图中手动选择主参考，再执行增强。' }, 400)

  try {
    const studio = await getEffectiveStudioConfig(ROOT)
    if (!studio.effective.enabled.image) {
      return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
    }
    const imgProvider = String(studio.effective.image.provider || process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()
    if (!imgProvider || imgProvider === 'none') {
      return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“出图（背景图）”并选择 Provider/Model' }, 400)
    }

    const latestRef = Array.isArray(asset.generatedRefs) ? asset.generatedRefs.find((x) => String(x?.projectAssetUri || '').trim() === currentAssetPath) : null
    const globalPrompt = String(body?.globalPrompt || '').trim()
    const globalNegativePrompt = String(body?.globalNegativePrompt || '').trim()
    const sanitizedDraft = sanitizeProtectedAssetPrompt({
      asset,
      promptEn: String(body?.assetPrompt || body?.promptEn || '').trim(),
      negativePrompt: String(body?.assetNegativePrompt || '').trim()
    })
    const assetPrompt = pickEnglishPrompt(
      sanitizedDraft.promptEn,
      storyAssetStr(asset && asset.referencePromptEn).trim(),
      storyAssetStr(asset && asset.referencePromptHint).trim()
    )
    const assetNegativePrompt = sanitizedDraft.negativePrompt
    const prompt = String(latestRef?.prompt || buildStoryAssetReferencePrompt({ plan, asset, style: String(body?.style || 'picture_book'), globalPrompt, assetPrompt })).trim()
    const negativePrompt = String(latestRef?.negativePrompt || buildStoryAssetReferenceNegativePrompt({ plan, asset, globalNegativePrompt, assetNegativePrompt })).trim()
    const reviewed = await reviewAndPersistStoryAssetReference({
      id,
      dir,
      studio,
      plan,
      asset,
      prompt,
      negativePrompt,
      assetPath: currentAssetPath
    })
    const effectiveAnalysis = reviewed.analysis || {}
    const style = normalizeStyleEnum(body?.style || 'picture_book')
    const aiBg = bundle.project && bundle.project.state && bundle.project.state.aiBackground && typeof bundle.project.state.aiBackground === 'object'
      ? bundle.project.state.aiBackground
      : {}
    const draft = aiBg && aiBg.storyboardBatchDraft && typeof aiBg.storyboardBatchDraft === 'object'
      ? aiBg.storyboardBatchDraft
      : {}
    const requestedLoras = Array.isArray(body?.loras)
      ? body.loras.map((x) => String(x || '').trim()).filter(Boolean)
      : (
          Array.isArray(draft?.loras)
            ? draft.loras.map((x) => String(x || '').trim()).filter(Boolean)
            : (Array.isArray(studio.effective.image.loras) ? studio.effective.image.loras.map((x) => String(x || '').trim()).filter(Boolean) : [])
        )
    const effectiveLoras = chooseStoryboardAssetLoras({ asset, requestedLoras, stylePreset: resolveStoryStylePreset(studio) })
    const requestedModel = String(body?.model || draft?.model || '').trim()
    const modelResolution = await resolveStoryboardAssetModel({ studio, imgProvider, requestedModel, asset })
    const effectiveModel = String(modelResolution.model || '').trim()
    const { width: widthDefault, height: heightDefault } = getStoryAssetRenderSize(asset, resolveStoryStylePreset(studio))
    const width = clampInt(body?.width, 256, 2048, widthDefault)
    const height = clampInt(body?.height, 256, 2048, heightDefault)
    const batchSize = clampInt(body?.batchSize, 1, 6, 4)
    let currentPlan = await persistStoryAssetReferenceBatch({
      id,
      plan: reviewed.plan,
      assetId,
      latestReferenceBatch: [],
      recommendedReferenceAssetUri: ''
    })
    let currentBundle = bundle
    let bestResult = null
    let bestReview = effectiveAnalysis
    let attemptPrompt = pickEnglishPrompt(String(effectiveAnalysis.revisedPrompt || '').trim(), prompt)
    let attemptNegativePrompt = String(effectiveAnalysis.revisedNegativePrompt || negativePrompt).trim() || negativePrompt
    const baseSeed = Math.floor(Math.random() * 4_294_900_000)
    const rawCandidates = []
    const maxAttempts = Math.max(batchSize, Math.min(12, batchSize + 4))
    for (let i = 0; i < maxAttempts && rawCandidates.length < batchSize; i += 1) {
      const seed = (baseSeed + i * 9973) % 4_294_967_295
      const result = await generateAndPersistStoryAssetReference({
        id,
        dir,
        bundle: currentBundle,
        plan: currentPlan,
        asset,
        studio,
        imgProvider,
        style,
        width,
        height,
        steps: body?.steps,
        cfgScale: body?.cfgScale,
        sampler: body?.sampler,
        scheduler: body?.scheduler,
        model: effectiveModel,
        loras: effectiveLoras,
        prompt: attemptPrompt,
        negativePrompt: attemptNegativePrompt,
        timeoutMs: body?.timeoutMs,
        seed
      })
      currentPlan = result.plan
      currentBundle = await readProjectBundle(id)
      const rerReviewed = await reviewAndPersistStoryAssetReference({
        id,
        dir,
        studio,
        plan: currentPlan,
        asset,
        prompt: result.prompt,
        negativePrompt: result.negativePrompt,
        assetPath: result.assetPath
      })
      currentPlan = rerReviewed.plan
      const revisedPrompt = pickEnglishPrompt(String(rerReviewed.analysis?.revisedPrompt || '').trim(), attemptPrompt)
      const revisedNegativePrompt = String(rerReviewed.analysis?.revisedNegativePrompt || '').trim() || attemptNegativePrompt
      if (!Boolean(rerReviewed.analysis?.passed) && (revisedPrompt !== attemptPrompt || revisedNegativePrompt !== attemptNegativePrompt)) {
        attemptPrompt = revisedPrompt
        attemptNegativePrompt = revisedNegativePrompt
      }
      if (!shouldDiscardStoryAssetReferenceCandidate(rerReviewed.analysis)) {
        rawCandidates.push({
          attempt: i + 1,
          seed,
          assetPath: result.assetPath,
          url: result.url,
          analysis: rerReviewed.analysis
        })
      }
      if (!bestResult || storyAssetReviewScore(rerReviewed.analysis) > storyAssetReviewScore(bestReview)) {
        bestResult = result
        bestReview = rerReviewed.analysis
      }
      const partialRecommendedAssetPath = bestResult ? String(bestResult.assetPath || '').trim() : ''
      const partialCandidates = rawCandidates.map((item) => ({
        ...item,
        recommended: Boolean(partialRecommendedAssetPath && String(item.assetPath || '').trim() === partialRecommendedAssetPath)
      }))
      currentPlan = await persistStoryAssetReferenceBatch({
        id,
        plan: currentPlan,
        assetId,
        latestReferenceBatch: partialCandidates,
        recommendedReferenceAssetUri: partialRecommendedAssetPath
      })
    }
    const recommendedAssetPath = bestResult ? String(bestResult.assetPath || '').trim() : ''
    const candidates = rawCandidates.map((item) => ({
      ...item,
      recommended: Boolean(recommendedAssetPath && String(item.assetPath || '').trim() === recommendedAssetPath)
    }))
    currentPlan = await persistStoryAssetReferenceBatch({
      id,
      plan: currentPlan,
      assetId,
      latestReferenceBatch: candidates,
      recommendedReferenceAssetUri: recommendedAssetPath
    })
    const currentAsset = (Array.isArray(currentPlan.assets) ? currentPlan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null) || null
    return c.json({ success: true, asset: currentAsset, analysis: bestReview, recommendedAssetPath, model: effectiveModel || undefined, modelSource: modelResolution.source, ...(bestResult || {}), candidates, plan: currentPlan })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

app.get('/api/projects/:id/ai/story/assets/:assetId/gallery', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const assetId = storyAssetStr(c.req.param('assetId')).trim()
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => storyAssetStr(item && item.id).trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)
  const cleaned = await pruneMissingStoryAssetGalleryEntries({ id, dir, plan, asset })
  return c.json({ success: true, asset: cleaned.asset, items: cleaned.items, plan: cleaned.plan })
})

app.post('/api/projects/:id/ai/story/assets/:assetId/prompt-enhance', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const assetId = storyAssetStr(c.req.param('assetId')).trim()
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const body = await c.req.json().catch(() => ({}))
  const rewriteFromScratch = true
  const forceRegenerate = Boolean(body?.forceRegenerate)
  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => storyAssetStr(item && item.id).trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  const bundle = await readProjectBundle(id)
  const fallback = buildStoryAssetPromptEnhancement({
    asset,
    plan,
    globalPromptZh: body?.globalPromptZh,
    globalNegativePromptZh: body?.globalNegativePromptZh,
    currentPromptZh: rewriteFromScratch ? '' : body?.promptZh,
    currentPromptEn: rewriteFromScratch ? '' : body?.promptEn,
    currentNegativePromptZh: rewriteFromScratch ? '' : body?.negativePromptZh,
    currentNegativePrompt: rewriteFromScratch ? '' : body?.negativePrompt
  })
  const fallbackSanitized = sanitizeProtectedAssetPrompt({
    asset,
    promptEn: fallback.promptEn,
    negativePrompt: fallback.negativePrompt
  })
  const studio = await getEffectiveStudioConfig(ROOT).catch(() => null)
  const provider = String(studio?.effective?.prompt?.provider || '').trim().toLowerCase()
  const model = studio?.effective?.prompt?.model || undefined
  const apiUrl = studio?.effective?.prompt?.apiUrl || undefined
  const proxyUrl = studio?.effective?.network?.proxyUrl || undefined
  const traceId = createTraceId()
  const startedAt = Date.now()

  let result = {
    ...fallback,
    promptEn: fallbackSanitized.promptEn || fallback.promptEn,
    negativePrompt: fallbackSanitized.negativePrompt || fallback.negativePrompt
  }
  let meta = { provider: 'local', model: null, api: null, durationMs: 0, note: 'local_template_fallback' }
  let aiError = null
  const promptReviews = []
  const minAcceptScore = 50
  const maxRegenerateAttempts = 3
  try {
    const usageContext = fallback.context && typeof fallback.context.usageContext === 'object' ? fallback.context.usageContext : undefined
    const buildPromptReviewFeedbackZh = (review) => {
      if (!review || typeof review !== 'object') return ''
      const risks = Array.isArray(review.risks) ? review.risks.map((x) => storyAssetStr(x).trim()).filter(Boolean) : []
      const suggestions = Array.isArray(review.suggestions) ? review.suggestions.map((x) => storyAssetStr(x).trim()).filter(Boolean) : []
      const score = Number(review.score)
      const parts = []
      if (Number.isFinite(score)) parts.push(`上一轮提示词评分 ${Math.round(score)}/100`)
      if (risks.length) parts.push(`主要问题：${risks.slice(0, 4).join('；')}`)
      if (suggestions.length) parts.push(`必须修正：${suggestions.slice(0, 4).join('；')}`)
      return parts.join('。')
    }
    const scoreCandidate = (candidate, source, attempt) => {
      const review = scoreStoryAssetPromptCandidate({
        asset,
        promptZh: candidate.promptZh,
        promptEn: candidate.promptEn,
        negativePromptZh: candidate.negativePromptZh,
        negativePrompt: candidate.negativePrompt,
        context: usageContext
      })
      promptReviews.push({ attempt, source, ...review })
      return review
    }

    const fallbackReview = scoreCandidate(result, 'fallback', 0)

    if (provider && provider !== 'none') {
      logStage({ stage: 'asset.prompt_enhance', event: 'start', traceId, project: id, provider: provider || 'local', model: model || '-', item: assetId })
      let feedbackZh = buildPromptReviewFeedbackZh(body?.promptReview)
      if (forceRegenerate && feedbackZh) {
        feedbackZh = `${feedbackZh}。这是一次显式重新生成，必须优先根据这些问题重写，不要沿用原先措辞。`
      }
      // 2026-08-26 重构：循环内只让本地模型写中文稿并打分选优，胜出后才翻译一次。
      // 旧实现每轮 2 次并行翻译 + 增强，27B 在 32G/16K 环境下 KV 峰值翻倍（实测触发 oMLX prefill 内存护栏 400）。
      let aiWinner = null
      for (let attempt = 1; attempt <= maxRegenerateAttempts; attempt += 1) {
        const aiInput = {
          projectTitle: String(bundle?.project?.title || '').trim(),
          storyBibleJson: JSON.stringify(readStoryBibleFromProjectDoc(bundle.project) || {}),
          asset,
          plan,
          assetUsageContext: usageContext,
          promptReviewFeedbackZh: feedbackZh,
          globalPromptZh: body?.globalPromptZh,
          globalNegativePromptZh: body?.globalNegativePromptZh,
          currentPromptZh: rewriteFromScratch ? '' : sanitizeStoryAssetPromptZh({ asset, promptZh: body?.promptZh }),
          currentPromptEn: rewriteFromScratch ? '' : body?.promptEn,
          currentNegativePromptZh: rewriteFromScratch ? '' : body?.negativePromptZh,
          currentNegativePrompt: rewriteFromScratch ? '' : body?.negativePrompt
        }
        let enhanced = null
        try {
          enhanced = await Promise.race([
            enhanceStoryAssetPromptWithAi({
              input: aiInput,
              provider,
              model,
              apiUrl,
              proxyUrl
            }),
            new Promise((_, reject) => setTimeout(() => {
              const e = new Error('asset_prompt_enhance_timeout')
              e.status = 504
              reject(e)
            }, ['localoxml', 'ollama'].includes(provider) ? 300_000 : 60_000))
            // 2026-08-26 修复：本地模型原 15s 掐表必超时（27B 需 1-5 分钟），兜底模板横行；
            // 放宽后 AI 真正写完，模板只在 AI 失败时才上桌
          ])
        } catch (e) {
          const emsg = e instanceof Error ? e.message : String(e)
          // 2026-08-26：oMLX 内存护栏拒绝是瞬态（天花板随系统负载波动，实测差 0.03GB 也被拒），
          // 等待 25s 后重试而非直接兜底——慢可以，掉模板不行
          if (/prefill memory guard|prefill_memory_exceeded/i.test(emsg) && attempt < maxRegenerateAttempts) {
            logStage({ stage: 'asset.prompt_enhance', event: 'retry', traceId, project: id, item: assetId, attempt, err: 'omlx_memory_guard' })
            await new Promise((resolve) => setTimeout(resolve, 25_000))
            continue
          }
          throw e
        }
        if (!enhanced || !enhanced.result) continue
        const nextPromptZh = sanitizeStoryAssetPromptZh({ asset, promptZh: enhanced.result.promptZh }) || fallback.promptZh
        const nextNegativePromptZh = storyAssetStr(enhanced.result.negativePromptZh).trim() || fallback.negativePromptZh
        // 评分阶段英文沿用兜底件（仅供关键词评分参考），中文稿胜出后才翻译
        const review = scoreCandidate({
          promptZh: nextPromptZh,
          promptEn: fallback.promptEn,
          negativePromptZh: nextNegativePromptZh,
          negativePrompt: fallback.negativePrompt
        }, 'ai', attempt)
        if (!aiWinner || review.score > aiWinner.review.score) {
          aiWinner = {
            promptZh: nextPromptZh,
            negativePromptZh: nextNegativePromptZh,
            summary: storyAssetStr(enhanced.result.summary).trim() || fallback.summary,
            review
          }
        }
        meta = {
          ...(enhanced.meta || {}),
          provider: enhanced.meta?.provider || provider,
          model: enhanced.meta?.model || model || null,
          api: enhanced.meta?.api || apiUrl || null,
          durationMs: Math.max(0, Date.now() - startedAt)
        }
        if (!forceRegenerate && (review.passed || review.score >= minAcceptScore)) break
        feedbackZh = `${buildPromptReviewFeedbackZh(review)}。请根据这些问题完全重写，不要保留泛化模板。`
      }
      // 2026-08-26 修复：AI 中文稿有效即上桌。评分器只认固定字面关键词（纯白背景/无场景/单一物件），
      // 模板恰好自带这些词（实测 34 分），27B 语义正确的稿子实测仅 26-34 分，旧规则要求严格超过模板导致 AI 稿永不上桌。
      // 提示词终审是人的审核闸（第 4 步：确认中文稿 → 翻译 → 批准），此处评分仅作顾问；
      // 仅当 AI 稿遭硬性污染罚分（跨道具语义混入等，分数崩到阈值以下）时才保留模板兜底。
      if (aiWinner) {
        const fallbackScore = fallbackReview && Number.isFinite(fallbackReview.score) ? fallbackReview.score : 0
        const aiAcceptFloor = Math.max(20, fallbackScore - 15)
        if (aiWinner.review.score >= aiAcceptFloor) {
          const translated = await translateStoryAssetPromptPair({
            studio,
            promptZh: aiWinner.promptZh,
            negativePromptZh: aiWinner.negativePromptZh,
            fallbackPromptEn: fallback.promptEn,
            fallbackNegativePrompt: fallback.negativePrompt,
            timeoutMs: ['localoxml', 'ollama'].includes(provider) ? 300_000 : 60_000
          }).catch((translateErr) => {
            // 2026-10-07 可观测：内联翻译失败不再静默——落日志说明英文栏将回落到模板兜底件
            logStage({ stage: 'asset.prompt_enhance', event: 'translate_fallback', traceId, project: id, item: assetId, err: translateErr instanceof Error ? translateErr.message : String(translateErr) })
            return {
              promptEn: fallback.promptEn,
              negativePrompt: fallback.negativePrompt,
              meta: { provider: 'fallback', model: null, api: null, note: 'translation_fallback' }
            }
          })
          const sanitizedTranslated = sanitizeProtectedAssetPrompt({
            asset,
            promptEn: translated.promptEn,
            negativePrompt: translated.negativePrompt
          })
          result = {
            promptZh: aiWinner.promptZh,
            promptEn: sanitizedTranslated.promptEn || fallback.promptEn,
            negativePromptZh: aiWinner.negativePromptZh,
            negativePrompt: sanitizedTranslated.negativePrompt || fallback.negativePrompt,
            summary: aiWinner.summary,
            context: {
              ...(fallback.context || {}),
              aiGenerated: true,
              translatedBy: translated.meta || null
            }
          }
        }
      }
      if (!result || !storyAssetStr(result.promptZh).trim()) {
        result = {
          ...fallback,
          promptEn: fallbackSanitized.promptEn || fallback.promptEn,
          negativePrompt: fallbackSanitized.negativePrompt || fallback.negativePrompt
        }
      }
      if (meta.provider || meta.model || meta.api) {
        logStage({ stage: 'asset.prompt_enhance', event: 'ok', traceId, project: id, provider: meta.provider || provider || 'local', model: meta.model || model || '-', item: assetId, ok: true, durationMs: meta.durationMs })
      }
    }
  } catch (e) {
    aiError = {
      message: e instanceof Error ? e.message : String(e),
      status: e && e.status ? Number(e.status) : null,
      code: e && e.code ? String(e.code) : null
    }
    meta = {
      ...meta,
      provider: provider || 'local',
      model: model || null,
      api: apiUrl || null,
      durationMs: Math.max(0, Date.now() - startedAt),
      note: 'ai_failed_fallback_to_local_template'
    }
    logStage({ stage: 'asset.prompt_enhance', event: 'fail', traceId, project: id, provider: provider || 'local', model: model || '-', item: assetId, status: aiError.status || 500, ok: false, durationMs: meta.durationMs, err: aiError.message })
  }
  const finalReview = scoreStoryAssetPromptCandidate({
    asset,
    promptZh: result.promptZh,
    promptEn: result.promptEn,
    negativePromptZh: result.negativePromptZh,
    negativePrompt: result.negativePrompt,
    context: fallback.context && typeof fallback.context.usageContext === 'object' ? fallback.context.usageContext : undefined
  })
  result = {
    ...result,
    context: {
      ...(result.context && typeof result.context === 'object' ? result.context : {}),
      promptReview: finalReview
    }
  }
  recordCreationEvent(dir, {
    type: 'prompt_drafted',
    summary: `资产提示词起草：${assetId}（${meta.provider || 'local'}${finalReview && finalReview.score != null ? `，评分 ${finalReview.score}` : ''}）`,
    actor: 'prompt_flow',
    data: { assetId, provider: String(meta.provider || ''), score: finalReview && finalReview.score != null ? Number(finalReview.score) : null }
  })
  return c.json({ success: true, asset, result, meta, aiError, traceId, promptReview: finalReview, promptReviewAttempts: promptReviews, promptReviewThreshold: minAcceptScore })
})

app.post('/api/projects/:id/ai/story/assets/:assetId/gallery/delete', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const routeAssetId = storyAssetStr(c.req.param('assetId')).trim()
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const assetId = storyAssetStr(body && body.assetId).trim() || routeAssetId
  const assetPath = normalizeStoryAssetUri(body && body.assetPath)
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)
  if (!assetPath) return c.json({ success: false, error: 'missing_asset_path', message: 'assetPath 不能为空' }, 400)

  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => storyAssetStr(item && item.id).trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  try {
    const result = await deleteStoryAssetManagedFile({ id, dir, plan, asset, targetAssetPath: assetPath })
    const cleaned = await pruneMissingStoryAssetGalleryEntries({
      id,
      dir,
      plan: result.plan,
      asset: result.asset || asset
    })
    return c.json({
      success: true,
      ...result,
      plan: cleaned.plan,
      asset: cleaned.asset,
      items: cleaned.items
    })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const status = e && typeof e.status === 'number' ? e.status : 500
    return c.json({ success: false, error: 'story_asset_delete_failed', message: msg }, status)
  }
})

app.post('/api/projects/:id/ai/story/assets/reference/select', storyInputGate('story.assets.reference.lock', (c, body) => ({ projectId: c.req.param('id'), ...body })), async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const traceId = createTraceId()

  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  const targetAssetPath = String(body?.assetPath || body?.primaryReferenceAssetUri || '').trim().replace(/^\/+/, '')
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)
  if (!targetAssetPath) return c.json({ success: false, error: 'missing_asset_path', message: '请选择一个候选图作为主参考。' }, 400)

  let plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  const batch = Array.isArray(asset.latestReferenceBatch) ? asset.latestReferenceBatch : []
  const pickedCandidate = batch.find((item) => String(item?.assetPath || '').trim().replace(/^\/+/, '') === targetAssetPath) || null
  const generatedRef = Array.isArray(asset.generatedRefs)
    ? asset.generatedRefs.find((item) => String(item?.projectAssetUri || '').trim().replace(/^\/+/, '') === targetAssetPath)
    : null
  if (!pickedCandidate && !generatedRef) {
    return c.json({ success: false, error: 'candidate_not_found', message: '所选候选图不在当前资产的候选列表中。' }, 404)
  }

  // S4-01 写入门禁：仅「视觉评审真实通过」且「文件真实存在」的候选可写入 primaryReferenceAssetUri
  const candidateReview = pickedCandidate && pickedCandidate.analysis && typeof pickedCandidate.analysis === 'object'
    ? pickedCandidate.analysis
    : (
        asset.latestReferenceReview && typeof asset.latestReferenceReview === 'object' &&
        String(asset.latestReferenceReview.targetAssetUri || '').trim().replace(/^\/+/, '') === targetAssetPath
          ? asset.latestReferenceReview
          : null
      )
  const reviewGate = evaluateStoryAssetReferenceReview(candidateReview)
  // 人工特批（2026-08-30 用户指令）：AI 评审只是候选意见，人工可点击确认越过门禁；
  // 越权必须显式 manualOverride=true，且全程留痕（locked 记录带 manual_override 与被越过的评审结论）。
  const manualOverride = body?.manualOverride === true
  if (!reviewGate.passed && !manualOverride) {
    logStage({ stage: 'asset.reference.select', event: 'blocked', traceId, project: id, item: assetId, ok: false, err: reviewGate.code })
    return c.json({ success: false, error: reviewGate.code, message: reviewGate.message, review: candidateReview }, 409)
  }
  if (!reviewGate.passed && manualOverride) {
    logStage({ stage: 'asset.reference.select', event: 'manual_override', traceId, project: id, item: assetId, ok: true, err: reviewGate.code, detail: 'human_override_review_gate' })
  }
  const fileGate = await verifyStoryAssetReferenceFile({ dir, assetPath: targetAssetPath })
  if (!fileGate.ok) {
    logStage({ stage: 'asset.reference.select', event: 'fail', traceId, project: id, item: assetId, ok: false, err: fileGate.code })
    return c.json({ success: false, error: fileGate.code, message: fileGate.message }, 400)
  }

  try {
    logStage({ stage: 'asset.reference.select', event: 'start', traceId, project: id, item: assetId, ok: true, detail: 'transparent_cutout' })
    const studio = await getEffectiveStudioConfig(ROOT)
    const sourceRef = generatedRef || {
      projectAssetId: '',
      projectAssetUri: targetAssetPath,
      prompt: '',
      negativePrompt: '',
      width: undefined,
      height: undefined,
      seed: undefined,
      loras: undefined
    }
    const processed = await applyCutoutToStoryAssetReference({
      id,
      dir,
      plan,
      asset,
      sourceRef,
      studio,
      timeoutMs: body?.timeoutMs
    })
    plan = processed.plan
    const primaryReferenceAssetId = String(processed.primaryReferenceAssetId || '').trim()
    const primaryReferenceAssetUri = String(processed.primaryReferenceAssetUri || targetAssetPath).trim()
    plan = await setPrimaryStoryAssetReference({
      id,
      plan,
      assetId,
      primaryReferenceAssetId,
      primaryReferenceAssetUri,
      latestReferenceReview: pickedCandidate?.analysis || asset.latestReferenceReview || null,
      latestReferenceBatch: batch,
      selectedBatchAssetPath: targetAssetPath,
      resetLineart: true
    })
    const nextAsset = (Array.isArray(plan.assets) ? plan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null) || asset
    await writeStoryAssetPrimaryToProject({ id, dir, asset: nextAsset, primaryReferenceAssetId })
    // 2026-09-28：锁定即补齐提示词中文稿（模板兜底，失败不阻断选定）
    try {
      await backfillStoryAssetPromptDraftZh({ id, dir, plan, asset: nextAsset })
    } catch (_) { /* 回填失败不阻断选定结果 */ }
    // 结论留痕：选定即补写 lock_confirm（approved）。control 旁路链路（x-image-review-mode: off）同样落审核事实，
    // 否则出图总账的 locked 状态永远缺这部分资产。
    try {
      const lockTargetKey = `lock_confirm:${assetId}:${primaryReferenceAssetUri}`
      const decidedBy = resolveImageReviewMode(c, body) === 'off' ? 'control' : 'user'
      const pendingLock = await findPendingReview(dir, { phase: 'lock_confirm', targetKey: lockTargetKey })
      if (pendingLock) {
        await decideImageReview(dir, pendingLock.reviewId, { approved: true, decidedBy })
      } else {
        const lockRecord = await createImageReview(dir, {
          phase: 'lock_confirm',
          targetKey: lockTargetKey,
          assetId,
          prompt: String(nextAsset.anchorPrompt || '').trim(),
          resultImagePath: primaryReferenceAssetUri,
          aiReview: pickedCandidate?.analysis || asset.latestReferenceReview || null,
          params: manualOverride
            ? { manual_override: true, overriddenGateCode: reviewGate.code, overriddenGateMessage: reviewGate.message }
            : {}
        })
        await decideImageReview(dir, lockRecord.reviewId, { approved: true, decidedBy })
      }
    } catch (_) { /* 留痕失败不阻断选定结果 */ }
    recordCreationEvent(dir, {
      type: 'asset_locked',
      summary: `资产主参考锁定：${assetId} -> ${primaryReferenceAssetUri}${manualOverride ? '（人工特批）' : ''}`,
      actor: 'select_flow',
      data: { assetId, manualOverride }
    })
    logStage({ stage: 'asset.reference.select', event: 'ok', traceId, project: id, item: assetId, ok: true, detail: 'transparent_cutout' })
    return c.json({ success: true, asset: nextAsset, plan })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    logStage({ stage: 'asset.reference.select', event: 'fail', traceId, project: id, item: assetId, status: mapped.httpStatus, ok: false, err: msg })
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

app.post('/api/projects/:id/ai/story/assets/lineart', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const traceId = createTraceId()

  const body = await c.req.json().catch(() => ({}))
  const assetId = String(body?.assetId || '').trim()
  if (!assetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_asset_plan', message: '请先生成必要事物资产计划。' }, 400)
  const asset = Array.isArray(plan.assets) ? plan.assets.find((item) => String(item && item.id || '').trim() === assetId) : null
  if (!asset) return c.json({ success: false, error: 'asset_not_found', message: `未找到故事资产：${assetId}` }, 404)

  const primaryReferenceAssetUri = String(asset.primaryReferenceAssetUri || '').trim()
  if (!primaryReferenceAssetUri) {
    return c.json({ success: false, error: 'missing_reference_image', message: '请先从 4 张候选图中手动选择主参考，再生成线稿。' }, 400)
  }

  const studio = await getEffectiveStudioConfig(ROOT)
  const comfyuiBaseUrl = String(studio.effective.image.comfyuiBaseUrl || process.env.COMFYUI_BASE_URL || '').trim()
  if (!comfyuiBaseUrl) {
    return c.json({ success: false, error: 'missing_comfyui_base_url', message: '未配置 ComfyUI 地址，无法生成线稿。' }, 400)
  }

  const lineartPrompt = String(body?.prompt || '').trim() || (
    String(asset.category || '').trim() === 'character'
      ? `redraw the uploaded ${String(asset.name || asset.id || 'character').trim()} reference as clean black ink lineart, preserve exact species, face shape, fur markings, outfit silhouette, body proportions and pose, full body, one subject only, white background, monochrome, no color fill, no shading, no gray wash, no painterly rendering`
      : `redraw the uploaded ${String(asset.name || asset.id || 'prop').trim()} reference as clean black ink object lineart, preserve exact silhouette, handle, rim, strap, edge shape and proportions, single object only, centered, white background, monochrome, no color fill, no shading, no extra objects, no person`
  )
  const lineartNegative = String(body?.negativePrompt || '').trim() || 'color, watercolor, gouache, shading, shadow, grayscale wash, background scene, extra character, extra limbs, multiple views, text, logo, realistic photo'

  const lineartTargetName = String(asset.name || assetId).trim()
  const lineartTask = createAiTask(id, 'story.asset.lineart', {
    total: 1,
    message: `线稿准备：${lineartTargetName}`
  })

  // 出图前审核（manual 模式）：挂起并返回 202，批准后自动执行
  const reviewMode = resolveImageReviewMode(c, body)
  if (reviewMode === 'manual' && !(await hasApprovedPreGenerate(dir, c))) {
    const targetKey = `lineart:${assetId}`
    let review = await findPendingReview(dir, { phase: 'pre_generate', targetKey })
    if (!review) {
      review = await createImageReview(dir, {
        phase: 'pre_generate',
        targetKey,
        assetId,
        prompt: lineartPrompt,
        negativePrompt: lineartNegative,
        params: { kind: 'asset.lineart', targetName: String(asset.name || assetId).trim(), primaryReferenceAssetUri },
        execute: { endpoint: `/api/projects/${encodeURIComponent(id)}/ai/story/assets/lineart`, payload: body && typeof body === 'object' ? body : {} }
      })
    }
    updateAiTask(lineartTask.taskId, { stage: 'waiting_review', done: true, message: `出图前审核待批准：${lineartTargetName}` })
    return c.json({ success: true, pendingReview: review, taskId: lineartTask.taskId }, 202)
  }

  try {
    logStage({ stage: 'asset.lineart', event: 'start', traceId, project: id, item: assetId, ok: true, detail: 'controlnet_lineart_only' })
    const abs = path.join(dir, primaryReferenceAssetUri.replace(/^\/+/, ''))
    const refBytes = await readFile(abs)
    const { width: widthDefault, height: heightDefault } = getStoryAssetRenderSize(asset, resolveStoryStylePreset(studio))
    const result = await generateComfyuiLineartFromReference({
      referenceBytes: refBytes,
      referenceFilename: `${String(asset.id || 'asset').trim() || 'asset'}.png`,
      comfyuiBaseUrl,
      model: String(body?.model || studio.effective.image.model || '').trim(),
      controlnetModel: String(body?.controlnetModel || '').trim() || 'SDXL/controlnet-union-sdxl-1.0/diffusion_pytorch_model_promax.safetensors',
      width: clampInt(body?.width, 256, 2048, widthDefault),
      height: clampInt(body?.height, 256, 2048, heightDefault),
      preprocessor: String(asset.category || '').trim() === 'character' ? 'anime' : 'lineart',
      unionType: 'canny/lineart/anime_lineart/mlsd',
      prompt: lineartPrompt,
      negativePrompt: lineartNegative,
      steps: body?.steps,
      cfgScale: body?.cfgScale,
      denoise: body?.denoise,
      seed: body?.seed,
      timeoutMs: body?.timeoutMs,
      hintPrefix: buildStoryAssetComfyPrefix(asset, 'lineart_hint'),
      finalPrefix: buildStoryAssetComfyPrefix(asset, 'lineart_final'),
      onStage: (stage) => {
        if (stage === 'hint') updateAiTask(lineartTask.taskId, { stage: 'preprocessing', message: `线稿预处理中：${lineartTargetName}` })
        else if (stage === 'final') updateAiTask(lineartTask.taskId, { stage: 'redrawing', message: `线稿重绘中：${lineartTargetName}` })
      }
    })
    const persisted = await persistStoryAssetLineartResult({
      id,
      dir,
      plan,
      asset,
      hintBytes: result.hintBytes,
      hintExt: result.hintExt,
      finalBytes: result.finalBytes,
      finalExt: result.finalExt,
      meta: result.meta,
      prompt: lineartPrompt,
      negativePrompt: lineartNegative
    })
    logStage({ stage: 'asset.lineart', event: 'ok', traceId, project: id, item: assetId, ok: true, detail: 'controlnet_lineart_only' })
    recordCreationEvent(dir, {
      type: 'lineart_done',
      summary: `线稿生成完成：${assetId}`,
      actor: 'lineart_flow',
      data: { assetId, finalAssetPath: persisted.finalAssetPath }
    })
    // 同步到 project.json 的 aiBackground.storyAssetPlan，保证工作区线稿门卡立即可见
    try {
      const projectPath = path.join(dir, 'project.json')
      const projectDoc = await readJson(projectPath).catch(() => ({}))
      if (!projectDoc.state || typeof projectDoc.state !== 'object') projectDoc.state = {}
      if (!projectDoc.state.aiBackground || typeof projectDoc.state.aiBackground !== 'object') projectDoc.state.aiBackground = {}
      projectDoc.state.aiBackground.storyAssetPlan = persisted.plan
      projectDoc.updatedAt = nowIso()
      projectDoc._rev = Number(projectDoc._rev || 0) + 1
      await writeJson(projectPath, projectDoc)
    } catch (_) { /* 同步失败不阻断线稿结果 */ }
    updateAiTask(lineartTask.taskId, { stage: 'done', done: true, current: 1, message: `线稿完成：${lineartTargetName}` })
    return c.json({ success: true, taskId: lineartTask.taskId, asset: persisted.asset, plan: persisted.plan, hintAssetPath: persisted.hintAssetPath, finalAssetPath: persisted.finalAssetPath, hintUrl: persisted.hintUrl, finalUrl: persisted.finalUrl, meta: result.meta, prompt: lineartPrompt, negativePrompt: lineartNegative })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    updateAiTask(lineartTask.taskId, { stage: 'error', done: true, error: msg, message: msg })
    logStage({ stage: 'asset.lineart', event: 'fail', traceId, project: id, item: assetId, status: mapped.httpStatus, ok: false, err: msg })
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

// ComfyUI 能力检查：对比工作流所需节点/模型与实装情况，缺失项可自动修复
app.get('/api/ai/comfyui/capability-check', async (c) => {
  const studio = await getEffectiveStudioConfig(ROOT)
  const baseUrl = String(studio.effective.image.comfyuiBaseUrl || process.env.COMFYUI_BASE_URL || 'http://127.0.0.1:8188').trim()
  const result = await checkComfyuiCapability({ baseUrl, comfyRoot: process.env.COMFYUI_ROOT })
  return c.json({ success: true, ...result })
})

// ComfyUI 自动修复：安装缺失 Python 依赖，可选重启 ComfyUI 使节点生效
app.post('/api/ai/comfyui/auto-fix', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const restart = Boolean(body?.restart)
  const scriptPath = path.resolve(__dirname, '../../../scripts/maintenance/comfyui_auto_fix.sh')
  try {
    const args = restart ? ['--restart'] : []
    const result = await runCommand('bash', [scriptPath, ...args], {
      env: { ...process.env },
      maxBuffer: 8 * 1024 * 1024
    })
    return c.json({ success: true, restart, stdout: String(result.stdout || '').slice(-4000), stderr: String(result.stderr || '').slice(-2000) })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    return c.json({ success: false, error: 'auto_fix_failed', message: msg.slice(-2000) }, 500)
  }
})

// ---- 图片生成审核门禁 ----
// 模式：manual（人工审核，默认）/ ai_only（AI 评审即终审）/ off（全自动）
// 优先级：请求头 x-image-review-mode > body.reviewMode > 环境变量 STUDIO_IMAGE_REVIEW_MODE > manual
function resolveImageReviewMode(c, body) {
  const header = String(c.req.header('x-image-review-mode') || '').trim()
  if (header === 'off' || header === 'ai_only' || header === 'manual') return header
  const fromBody = String(body && body.reviewMode || '').trim()
  if (fromBody === 'off' || fromBody === 'ai_only' || fromBody === 'manual') return fromBody
  const fromEnv = String(process.env.STUDIO_IMAGE_REVIEW_MODE || '').trim()
  if (fromEnv === 'off' || fromEnv === 'ai_only' || fromEnv === 'manual') return fromEnv
  return 'manual'
}

// 出图前审核旁路检查：携带已批准的 pre_generate 审核 id 时放行
async function hasApprovedPreGenerate(dir, c) {
  const token = String(c.req.header('x-pre-generate-approved') || '').trim()
  if (!token) return false
  const review = await getImageReview(dir, token)
  return Boolean(review && review.phase === 'pre_generate' && review.status === 'approved')
}

// 锁定写入（lock test Step D 与 lock_confirm approve 共用）
// S4-01：写入前验证文件真实存在且为有效图片；缺失/损坏时抛出带 code 的错误，禁止写假引用
async function persistPrimaryReferenceLock(id, dir, assetId, assetPath) {
  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return null
  const target = (Array.isArray(plan.assets) ? plan.assets : []).find((a) => String(a && a.id || '').trim() === String(assetId || '').trim())
  if (!target || !assetPath) return null
  const fileGate = await verifyStoryAssetReferenceFile({ dir, assetPath })
  if (!fileGate.ok) {
    const e = new Error(fileGate.message)
    e.code = fileGate.code
    e.status = 400
    throw e
  }
  target.primaryReferenceAssetUri = assetPath
  target.primaryReferenceSelectedAt = new Date().toISOString()
  await saveStoryAssetPlan(id, plan, { mergeAssetsById: true })
  // 同步到 project.json 的 aiBackground.storyAssetPlan，保证编辑器锁定工作区立即可见
  try {
    const projectPath = path.join(dir, 'project.json')
    const projectDoc = await readJson(projectPath).catch(() => ({}))
    if (!projectDoc.state || typeof projectDoc.state !== 'object') projectDoc.state = {}
    if (!projectDoc.state.aiBackground || typeof projectDoc.state.aiBackground !== 'object') projectDoc.state.aiBackground = {}
    projectDoc.state.aiBackground.storyAssetPlan = plan
    projectDoc.updatedAt = nowIso()
    projectDoc._rev = Number(projectDoc._rev || 0) + 1
    await writeJson(projectPath, projectDoc)
  } catch (_) { /* 同步失败不阻断锁定写入 */ }
  return plan
}

// 场景背景绑定（场景渲染与 scene_bind approve 共用）
// references：本次渲染实际使用的锁定参考图证据（S4-02），随资产 source 持久化，供审核与导出追溯
async function persistSceneBackgroundBinding({ dir, rawProject, story, sceneId, sceneName, assetPath, prompt, provider, remoteUrl, references }) {
  const projectAssetId = genId('asset')
  const projectAsset = {
    id: projectAssetId,
    kind: 'image',
    name: `故事场景 ${String(sceneName || sceneId || projectAssetId).trim()}`,
    uri: assetPath,
    source: {
      type: 'ai',
      prompt: String(prompt || ''),
      provider: String(provider || ''),
      remoteUrl: String(remoteUrl || '').trim() || undefined,
      references: Array.isArray(references) ? references : []
    }
  }
  const nextStory = {
    ...story,
    nodes: Array.isArray(story.nodes) ? story.nodes.map((node) => {
      if (String(node && node.id || '').trim() !== String(sceneId || '').trim()) return node
      const visuals = node && node.visuals && typeof node.visuals === 'object' ? node.visuals : {}
      return { ...node, visuals: { ...visuals, backgroundAssetId: projectAssetId } }
    }) : story.nodes
  }
  const nextProject = {
    ...rawProject,
    assets: [...(Array.isArray(rawProject.assets) ? rawProject.assets : []), projectAsset],
    updatedAt: new Date().toISOString(),
    _rev: Number((rawProject && rawProject._rev) || 0) + 1
  }
  await writeJson(path.join(dir, 'project.json'), nextProject)
  await writeJson(path.join(dir, 'story.json'), nextStory)
  recordCreationEvent(dir, {
    type: 'scene_bound',
    summary: `场景图绑定：${sceneName || sceneId} -> ${assetPath}`,
    actor: 'render_flow',
    data: { sceneId: String(sceneId || ''), assetPath: String(assetPath || '') }
  })
  return projectAsset
}

// 场景背景绑定前 AI 视觉评审（2026-09-27，F5 fail-closed）：
// x-image-review-mode:off 只旁路人工门禁，本评审照常执行。
// 返回 { status:'completed', passed, score, summary, issues, provider, model, reviewedAt }
//    或 { status:'unavailable', reason, reviewedAt }——视觉通道不可用（模型未加载/租约超时/配置关闭）
// 时调用方必须挂 pending 待人工，禁止盲批 approved。
async function reviewSceneBackgroundForBind({ id, dir, studio, renderSpec, sceneId, assetPath }) {
  const reviewedAt = new Date().toISOString()
  const unavailable = (reason) => ({ status: 'unavailable', reason: String(reason || 'scene_review_unavailable'), reviewedAt })
  try {
    const abs = path.join(dir, String(assetPath || '').replace(/^\/+/, ''))
    const buf = await readFile(abs)
    const sniff = sniffImageMetaFromBytes(buf)
    if (!sniff) return unavailable('invalid_scene_image')
    const reviewCfg = (studio && studio.effective && studio.effective.review && typeof studio.effective.review === 'object') ? studio.effective.review : {}
    // 评审通道解析与姿势一致性评审同源（STUDIO_SCENE_REVIEW_PROVIDER 可独立覆盖）：
    // local_vl（默认，gemma 经 OMLX + vision 租约）/ kimi / auto / off
    const providerSetting = String(process.env.STUDIO_SCENE_REVIEW_PROVIDER || process.env.STUDIO_POSE_REVIEW_PROVIDER || reviewCfg.poseReviewProvider || 'local_vl').trim().toLowerCase()
    if (providerSetting === 'off') return unavailable('scene_review_disabled')
    const moonshotKey = String(process.env.MOONSHOT_API_KEY || '').trim()
    const useKimi = providerSetting === 'kimi' || (providerSetting === 'auto' && Boolean(moonshotKey))
    if (useKimi && !moonshotKey) return unavailable('missing_moonshot_api_key')
    const environmentAnchors = (Array.isArray(renderSpec && renderSpec.environmentLocks) ? renderSpec.environmentLocks : [])
      .map((line) => String(line || '').split(': ').slice(1).join(': ').trim())
      .filter(Boolean)
    const sceneName = String(renderSpec && renderSpec.sceneName || sceneId || '').trim()
    if (!useKimi) {
      // 本地 VL 输入降采样（≤512px，与姿势一致性评审同款 python3+PIL，防 prefill 撞 OMLX 内存护栏）
      let small = null
      try {
        const absOut = abs.replace(/\.(png|jpe?g|webp)$/i, '') + '_vl512.png'
        const s0 = await stat(abs)
        const s1 = await stat(absOut).catch(() => null)
        if (!(s1 && s1.mtimeMs >= s0.mtimeMs)) {
          await new Promise((resolve, reject) => {
            const py = spawn('python3', ['-c',
              "import sys; from PIL import Image; im=Image.open(sys.argv[1]).convert('RGB'); im.thumbnail((512,512)); im.save(sys.argv[2])",
              abs, absOut])
            py.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('shrink_exit_' + code))))
            py.on('error', reject)
          })
        }
        small = await readFile(absOut)
      } catch (_) { small = null }
      const out = await reviewSceneBackgroundWithLocalVl({
        baseUrl: String(reviewCfg.poseReviewBaseUrl || process.env.LOCALOXML_BASE_URL || 'http://127.0.0.1:18888/v1').trim(),
        apiKey: String(process.env.LOCALOXML_API_KEY || 'omlx123').trim(),
        model: String(reviewCfg.poseReviewModel || process.env.STUDIO_SCENE_REVIEW_MODEL || process.env.STUDIO_POSE_REVIEW_MODEL || 'gemma-4-26b-a4b-it-4bit').trim(),
        sceneName,
        environmentAnchors,
        imageDataUrl: small ? `data:image/png;base64,${small.toString('base64')}` : `data:${sniff.contentType};base64,${buf.toString('base64')}`
      })
      return { status: 'completed', passed: out.passed, score: out.score, summary: out.summary, issues: out.issues, provider: out.meta?.provider || 'local_vl', model: out.meta?.model || '', reviewedAt }
    }
    const out = await reviewSceneBackgroundWithAi({
      apiKey: moonshotKey,
      baseUrl: process.env.MOONSHOT_BASE_URL || 'https://api.kimi.com/coding/v1',
      model: 'kimi-for-coding',
      sceneName,
      environmentAnchors,
      imageDataUrl: `data:${sniff.contentType};base64,${buf.toString('base64')}`
    })
    return { status: 'completed', passed: out.passed, score: out.score, summary: out.summary, issues: out.issues, provider: out.meta?.provider || 'moonshot', model: out.meta?.model || '', reviewedAt }
  } catch (e) {
    return unavailable(e && e.message ? e.message : String(e))
  }
}

// 审核记录查询与决策
app.get('/api/projects/:id/ai/reviews', async (c) => {
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const status = String(c.req.query('status') || '').trim()
  const reviews = await listImageReviews(dir, { status })
  return c.json({ success: true, reviews, mode: resolveImageReviewMode(c, {}) })
})

app.post('/api/projects/:id/ai/reviews/:reviewId/approve', async (c) => {
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const review = await getImageReview(dir, c.req.param('reviewId'))
  if (!review) return c.json({ success: false, error: 'review_not_found' }, 404)
  if (review.status !== 'pending') return c.json({ success: false, error: 'review_already_decided', message: `审核已处理（${review.status}）` }, 409)

  if (review.phase === 'pre_generate') {
    const decided = await decideImageReview(dir, review.reviewId, { approved: true })
    // 批准后立即在后台执行原操作（携带旁路令牌，任务进度经 /ai/tasks 可见）
    const exec = review.execute && typeof review.execute === 'object' ? review.execute : null
    if (exec && exec.endpoint) {
      const port = Number(process.env.PORT || 1999)
      ;(async () => {
        try {
          await fetch(`http://127.0.0.1:${port}${exec.endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-pre-generate-approved': review.reviewId },
            body: JSON.stringify(exec.payload || {})
          })
        } catch (_) { /* 执行失败由任务进度/日志体现 */ }
      })()
    }
    return c.json({ success: true, review: decided, executed: Boolean(exec && exec.endpoint) })
  }

  if (review.phase === 'lock_confirm') {
    let plan = null
    try {
      plan = await persistPrimaryReferenceLock(id, dir, review.assetId, review.resultImagePath)
    } catch (e) {
      // 文件缺失/损坏：显式失败，审核保持 pending，不写假引用
      const code = String(e && e.code || 'lock_persist_failed')
      const msg = String(e && e.message || e)
      return c.json({ success: false, error: code, message: msg }, Number(e && e.status) || 400)
    }
    if (!plan) return c.json({ success: false, error: 'lock_target_missing', message: '未找到待锁定的资产或计划' }, 400)
    const decided = await decideImageReview(dir, review.reviewId, { approved: true })
    // 锁定确认后自动跟进线稿生成（manual 模式下会先挂线稿的出图前审核）
    const port = Number(process.env.PORT || 1999)
    ;(async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(id)}/ai/story/assets/lineart`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetId: review.assetId })
        })
      } catch (_) { /* 线稿跟进失败不阻断锁定结果 */ }
    })()
    return c.json({ success: true, review: decided, plan, lineartTriggered: true })
  }

  if (review.phase === 'scene_bind') {
    // S4-02：人工确认绑定行为不变，仅补文件真实性校验；文件缺失/损坏时显式失败，审核保持 pending 不被消费
    const fileGate = await verifyStoryAssetReferenceFile({ dir, assetPath: String(review.resultImagePath || '') })
    if (!fileGate.ok) {
      return c.json({ success: false, error: fileGate.code, message: `场景图绑定被阻断：${fileGate.message}` }, 400)
    }
    const bundle = await readProjectBundle(id)
    const sceneName = String(review.params && review.params.sceneName || review.sceneId || '').trim()
    const projectAsset = await persistSceneBackgroundBinding({
      dir,
      rawProject: bundle.rawProject,
      story: bundle.story,
      sceneId: review.sceneId,
      sceneName,
      assetPath: review.resultImagePath,
      prompt: review.prompt,
      provider: review.params && review.params.provider,
      remoteUrl: review.params && review.params.remoteUrl,
      references: review.params && review.params.references
    })
    const decided = await decideImageReview(dir, review.reviewId, { approved: true })
    await maybeCloseRenderAllBatchTask(id, dir)
    return c.json({ success: true, review: decided, projectAsset })
  }

  return c.json({ success: false, error: 'unknown_review_phase' }, 400)
})

// 2026-10-08 渲染批次收敛钩子（故事2 实证：批次 7 场景全部挂 scene_bind 审核后任务停留 pending_review、
// done=false——2 过 5 拒后批次永久悬挂，后续 render-all 一律 409 render_all_running）。
// scene_bind 审核每决断一条调用一次：当项目已无待决 scene_bind 审核且批次仍开着，收敛批次任务。
async function maybeCloseRenderAllBatchTask(id, dir) {
  try {
    const open = listAiTasks(id, { includeDone: false }).find((t) => t.kind === 'story.scenes.render_all' && String(t.stage || '') === 'pending_review')
    if (!open) return
    const pending = await listImageReviews(dir, { status: 'pending' })
    if ((pending || []).some((r) => r.phase === 'scene_bind')) return
    let coverage = null
    try { coverage = await getStoryImageCoverage(dir) } catch (_) { /* 总账失败不影响收敛 */ }
    const bound = coverage && coverage.scenes && Array.isArray(coverage.scenes.items)
      ? coverage.scenes.items.filter((s) => s.status !== 'pending').length
      : null
    updateAiTask(open.taskId, {
      done: true,
      stage: 'done',
      message: `批量渲染审核全部决断${bound != null ? `，已绑定 ${bound}/${coverage.scenes.items.length}` : ''}（被拒场景可重新渲染）`,
      result: { ...(open.result && typeof open.result === 'object' ? open.result : {}), reviewClosed: true, coverage }
    })
  } catch (_) { /* 收敛失败不阻断审核结果 */ }
}

app.post('/api/projects/:id/ai/reviews/:reviewId/reject', async (c) => {
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const review = await getImageReview(dir, c.req.param('reviewId'))
  if (!review) return c.json({ success: false, error: 'review_not_found' }, 404)
  if (review.status !== 'pending') return c.json({ success: false, error: 'review_already_decided' }, 409)
  const decided = await decideImageReview(dir, review.reviewId, { approved: false, rejectReason: String(body?.reason || '') })
  await maybeCloseRenderAllBatchTask(id, dir)
  return c.json({ success: true, review: decided })
})

// 批量批准某一阶段的全部待审核（典型：批量渲染后的 11 张场景图一次过审）
app.post('/api/projects/:id/ai/reviews/approve-all', async (c) => {
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const phase = String(body?.phase || 'scene_bind').trim()
  const pending = await listImageReviews(dir, { status: 'pending' })
  const targets = pending.filter((item) => item.phase === phase)
  const results = []
  const port = Number(process.env.PORT || 1999)
  for (const review of targets) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(id)}/ai/reviews/${encodeURIComponent(review.reviewId)}/approve`, { method: 'POST' })
      const json = await resp.json().catch(() => ({}))
      results.push({ reviewId: review.reviewId, ok: resp.ok && json.success })
    } catch (e) {
      results.push({ reviewId: review.reviewId, ok: false, error: e && e.message ? String(e.message) : String(e) })
    }
  }
  const okCount = results.filter((r) => r.ok).length
  return c.json({ success: true, total: targets.length, okCount, results })
})

// AI 任务进度查询：编辑器轮询用，让长任务（锁定测试/场景渲染）的阶段在 UI 可见
app.get('/api/projects/:id/ai/tasks', async (c) => {
  const id = c.req.param('id')
  await loadAiTasksFromDisk(id)
  const includeDone = String(c.req.query('includeDone') || '1') !== '0'
  return c.json({ success: true, tasks: listAiTasks(id, { includeDone }) })
})

app.get('/api/projects/:id/ai/tasks/:taskId', async (c) => {
  const id = c.req.param('id')
  await loadAiTasksFromDisk(id)
  const task = getAiTask(c.req.param('taskId'))
  if (!task || task.projectId !== id) return c.json({ success: false, error: 'not_found' }, 404)
  return c.json({ success: true, task })
})

// 出图总账：需要多少图/完成多少/缺哪些，从 plan/story/project/reviews+磁盘确定性聚合（只读）
app.get('/api/projects/:id/ai/coverage', async (c) => {
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const coverage = await getStoryImageCoverage(dir)
  return c.json({ success: true, coverage })
})

// 创作过程缓冲查询（只读）：日志尾部 + 快照列表。恢复时手工把快照目录里的文件复制回项目根即可。
app.get('/api/projects/:id/creation-buffer', async (c) => {
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const bufDir = path.join(dir, 'creation-buffer')
  const journalFile = path.join(bufDir, 'journal.jsonl')
  let journal = []
  try {
    const raw = await readFile(journalFile, 'utf-8')
    journal = raw.split('\n').map((l) => l.trim()).filter(Boolean).slice(-50).map((l) => { try { return JSON.parse(l) } catch (_) { return null } }).filter(Boolean).reverse()
  } catch (_) { /* 尚无日志 */ }
  const snapRoot = path.join(bufDir, 'snapshots')
  const snapEntries = await readdir(snapRoot, { withFileTypes: true }).catch(() => [])
  const snapshots = snapEntries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse().slice(0, 20)
  return c.json({ success: true, journal, snapshots })
})

app.post('/api/projects/:id/ai/story/lock/test', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const bundle = await readProjectBundle(id)
  let plan = await readStoryAssetPlanIfExists(id)
  if (!plan) {
    const storyBible = readStoryBibleFromProjectDoc(bundle.project)
    if (!storyBible || typeof storyBible !== 'object') {
      return c.json({ success: false, error: 'missing_story_bible', message: '未找到 Story Bible。请先生成 Story Bible 并创建资产计划。' }, 400)
    }
    plan = buildStoryAssetPlan({ project: bundle.project, story: bundle.story, storyBible, prevManifest: null })
    await saveStoryAssetPlan(id, plan, { mergeAssetsById: true })
  }

  // 显式 assetId 优先（control/事件链路按资产锁定）；缺省时沿用自动挑选逻辑（第一个未锁定资产）
  const requestedAssetId = String(body?.assetId || '').trim()
  const testTarget = requestedAssetId
    ? ((Array.isArray(plan.assets) ? plan.assets : []).find((a) => String(a && a.id || '').trim() === requestedAssetId) || null)
    : pickStoryboardLockTestAsset(plan)
  if (!testTarget) {
    return c.json({
      success: false,
      error: requestedAssetId ? 'asset_not_found' : 'missing_test_target',
      message: requestedAssetId ? `未找到故事资产：${requestedAssetId}` : '资产计划为空，无法执行锁定测试。'
    }, requestedAssetId ? 404 : 400)
  }

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
  const imgProvider = String(studio.effective.image.provider || process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()
  if (imgProvider !== 'comfyui') {
    return c.json({ success: false, error: 'story_lock_requires_comfyui', message: '锁定测试工作流目前仅支持 ComfyUI。' }, 400)
  }

  const requestedModel = normalizeComfyCheckpointName(body?.model || studio.effective.image.model || '')
  const requestedLoras = Array.isArray(body?.loras) ? body.loras.map((x) => String(x || '').trim()).filter(Boolean) : []
  if (!requestedModel) {
    return c.json({ success: false, error: 'missing_model_config', message: '请先在锁定事物标签中填写 checkpoint。' }, 400)
  }

  const style = normalizeStyleEnum(body?.style || 'picture_book')
  const width = clampInt(body?.width, 256, 2048, 512)
  const height = clampInt(body?.height, 256, 2048, 512)
  const steps = clampInt(body?.steps, 5, 80, 20)
  const cfgScale = Number.isFinite(Number(body?.cfgScale)) ? Number(body.cfgScale) : 7
  const samplerInput = body?.sampler || 'DPM++ 2M'
  const schedulerInput = body?.scheduler || 'Automatic'
  const sampler = mapComfySampler(samplerInput)
  const scheduler = mapComfyScheduler(schedulerInput, samplerInput)
  const timeoutMs = parseComfyTimeoutMs(body?.timeoutMs)
  const maxAttempts = clampInt(body?.maxAttempts, 1, 4, 3)
  const traceId = createTraceId()

  let positivePrompt = buildStoryboardLockTestPrompt({ plan, asset: testTarget, style })
  let negativePrompt = buildStoryboardLockTestNegativePrompt({ plan, asset: testTarget })
  const attempts = []
  let passed = false
  let finalSummary = ''

  logStage({
    stage: 'story.lock_test',
    event: 'start',
    traceId,
    project: id,
    provider: imgProvider,
    model: requestedModel || '-',
    item: `${String(testTarget.name || testTarget.id || 'asset').trim()} / attempts:${maxAttempts}`
  })

  const lockTask = createAiTask(id, 'story.lock_test', {
    total: maxAttempts,
    message: `锁定测试：${String(testTarget.name || testTarget.id || 'asset').trim()}`
  })
  updateAiTask(lockTask.taskId, { stage: 'preparing', message: '准备工作流…' })

  // 出图前审核（manual 模式）：无已批准审核时创建 pending 并挂起，批准后自动执行
  const reviewMode = resolveImageReviewMode(c, body)
  if (reviewMode === 'manual' && !(await hasApprovedPreGenerate(dir, c))) {
    const targetKey = `lock_test:${String(testTarget.id || '').trim()}`
    let review = await findPendingReview(dir, { phase: 'pre_generate', targetKey })
    if (!review) {
      review = await createImageReview(dir, {
        phase: 'pre_generate',
        targetKey,
        assetId: String(testTarget.id || '').trim(),
        prompt: positivePrompt,
        negativePrompt,
        params: { kind: 'story.lock_test', targetName: String(testTarget.name || '').trim(), model: requestedModel, width, height, steps, maxAttempts },
        execute: { endpoint: `/api/projects/${encodeURIComponent(id)}/ai/story/lock/test`, payload: body && typeof body === 'object' ? body : {} }
      })
    }
    updateAiTask(lockTask.taskId, { stage: 'waiting_review', done: true, message: `出图前审核待批准：${String(testTarget.name || testTarget.id || '').trim()}` })
    return c.json({ success: true, pendingReview: review, taskId: lockTask.taskId }, 202)
  }
  let pendingLockReview = null

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      updateAiTask(lockTask.taskId, { stage: 'generating', current: attempt, message: `第 ${attempt}/${maxAttempts} 次生成中…` })
      const workflow = await buildStoryboardLockTestWorkflow({
        model: requestedModel,
        loras: requestedLoras.length ? requestedLoras : studio.effective.image.loras,
        positivePrompt,
        negativePrompt,
        width,
        height,
        steps,
        cfgScale,
        samplerName: sampler,
        scheduler,
        // ComfyUI seed 有效范围 [0, 4294967295]；之前用 9_999_999_999 导致 57% 被 clamp 成固定值 4294967295，命中同一份空缓存
        seed: Math.floor(Math.random() * 4_294_967_296),
        filenamePrefix: buildStoryAssetComfyPrefix(testTarget, 'lock_test')
      })
      const gen = await runComfyuiPromptWorkflow({
        workflow,
        comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
        timeoutMs
      })
      const buf = gen.bytes
      const ext0 = String(gen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
      const sniff = sniffImageMetaFromBytes(buf)
      const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'
      const relDir = path.join('assets', 'ai', 'story_lock_tests')
      const outDir = path.join(dir, relDir)
      await mkdir(outDir, { recursive: true })
      const safeAssetSlug = String(testTarget.id || 'asset').replace(/[^a-z0-9_.-]+/gi, '_')
      const fname = `${safeAssetSlug}_attempt_${attempt}_${Date.now()}.${ext}`
      const abs = path.join(outDir, fname)
      await writeFile(abs, buf)
      let assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
      { // 2026-09-09 出图即压：锁定测试候选 WebP q92
        const opt = await optimizeGeneratedImage(abs, IMAGE_KIND.CANDIDATE).catch(() => null)
        if (opt && opt.outPath && opt.outPath !== abs) assetPath = String(assetPathFromAbsolute(id, opt.outPath) || assetPath)
      }
      const dataUrl = `data:${sniff?.contentType || (ext === 'jpg' ? 'image/jpeg' : 'image/png')};base64,${buf.toString('base64')}`

      updateAiTask(lockTask.taskId, { stage: 'reviewing', current: attempt, message: `第 ${attempt}/${maxAttempts} 次 AI 评审中…` })
      const analysis = await reviewStoryboardLockImageWithAi({
        provider: process.env.MOONSHOT_API_KEY ? 'moonshot' : studio.effective.prompt.provider,
        model: process.env.MOONSHOT_API_KEY ? 'kimi-for-coding' : studio.effective.prompt.model,
        apiUrl: studio.effective.prompt.apiUrl,
        proxyUrl: studio.effective.network.proxyUrl,
        moonshotApiKey: process.env.MOONSHOT_API_KEY || '',
        moonshotBaseUrl: process.env.MOONSHOT_BASE_URL || 'https://api.kimi.com/coding/v1',
        asset: testTarget,
        prompt: positivePrompt,
        negativePrompt,
        imageDataUrl: dataUrl,
        attempt,
        maxAttempts
      })

      attempts.push({
        attempt,
        assetId: String(testTarget.id || '').trim(),
        assetName: String(testTarget.name || testTarget.id || '').trim(),
        prompt: positivePrompt,
        negativePrompt,
        assetPath,
        url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`,
        remoteUrl: String(gen?.meta?.url || '').trim() || undefined,
        analysis
      })

      if (analysis && analysis.passed) {
        passed = true
        finalSummary = String(analysis.summary || '锁定测试已通过').trim() || '锁定测试已通过'
        if (reviewMode === 'manual') {
          // Step D（manual）：AI 评审通过后先挂人工确认，approve 后才真正落锁
          pendingLockReview = await createImageReview(dir, {
            phase: 'lock_confirm',
            targetKey: `lock_confirm:${String(testTarget.id || '').trim()}:${assetPath}`,
            assetId: String(testTarget.id || '').trim(),
            prompt: positivePrompt,
            negativePrompt,
            resultImagePath: assetPath,
            aiReview: analysis
          })
          finalSummary = `AI 评审通过（${Number(analysis.score) || '-'} 分），待人工确认锁定：${String(testTarget.name || testTarget.id || '').trim()}`
        } else {
          // Step D：测试图通过评审后，写入 asset.primaryReferenceAssetUri 并持久化
          try {
            await persistPrimaryReferenceLock(id, dir, String(testTarget.id || '').trim(), assetPath)
          } catch (_) { /* 持久化失败不阻断测试结果 */ }
          // 结论留痕（off/ai_only 模式直接落锁时同样补写 lock_confirm approved 记录，否则出图总账 locked 缺这批资产）
          try {
            const offTargetKey = `lock_confirm:${String(testTarget.id || '').trim()}:${assetPath}`
            const offDecidedBy = reviewMode === 'off' ? 'control' : 'system'
            const pendingLock = await findPendingReview(dir, { phase: 'lock_confirm', targetKey: offTargetKey })
            if (pendingLock) {
              await decideImageReview(dir, pendingLock.reviewId, { approved: true, decidedBy: offDecidedBy })
            } else {
              const lockRec = await createImageReview(dir, {
                phase: 'lock_confirm',
                targetKey: offTargetKey,
                assetId: String(testTarget.id || '').trim(),
                prompt: positivePrompt,
                negativePrompt,
                resultImagePath: assetPath,
                aiReview: analysis
              })
              await decideImageReview(dir, lockRec.reviewId, { approved: true, decidedBy: offDecidedBy })
            }
          } catch (_) { /* 留痕失败不阻断测试结果 */ }
        }
        break
      }

      positivePrompt = String((analysis && analysis.revisedPrompt) || positivePrompt).trim() || positivePrompt
      negativePrompt = String((analysis && analysis.revisedNegativePrompt) || negativePrompt).trim() || negativePrompt
      finalSummary = String((analysis && analysis.summary) || '锁定测试未通过').trim() || '锁定测试未通过'
    }

    if (!passed && !finalSummary) {
      finalSummary = `锁定测试未通过，已达到最大重试次数（${maxAttempts}）`
    } else if (passed) {
      finalSummary = finalSummary || `锁定测试通过：${String(testTarget.name || testTarget.id || 'asset')}`
    }

    logStage({
      stage: 'story.lock_test',
      event: passed ? 'ok' : 'fail',
      traceId,
      project: id,
      provider: imgProvider,
      model: requestedModel || '-',
      item: `${String(testTarget.name || testTarget.id || 'asset').trim()} / attempts:${attempts.length}`
    })

    updateAiTask(lockTask.taskId, {
      stage: pendingLockReview ? 'waiting_review' : (passed ? 'passed' : 'failed'),
      done: true,
      message: finalSummary,
      result: { passed, pendingReviewId: pendingLockReview ? pendingLockReview.reviewId : undefined }
    })
    return c.json({
      success: true,
      passed,
      summary: finalSummary,
      taskId: lockTask.taskId,
      pendingReview: pendingLockReview || undefined,
      testTarget: {
        id: String(testTarget.id || '').trim(),
        name: String(testTarget.name || '').trim(),
        category: String(testTarget.category || '').trim(),
        anchorPrompt: String(testTarget.anchorPrompt || '').trim(),
        referencePromptHint: String(testTarget.referencePromptHint || '').trim()
      },
      attempts
    })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    logStage({
      stage: 'story.lock_test',
      event: 'error',
      traceId,
      project: id,
      provider: imgProvider,
      model: requestedModel || '-',
      item: msg
    })
    updateAiTask(lockTask.taskId, { stage: 'error', done: true, error: msg, message: msg })
    return c.json({ success: false, error: mapped.code, message: msg, taskId: lockTask.taskId }, mapped.httpStatus)
  }
})

app.post('/api/projects/:id/ai/story/scenes/:sceneId/render', storyInputGate('story.scene.render', (c, body) => ({ projectId: c.req.param('id'), sceneId: c.req.param('sceneId'), ...body })), async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const sceneId = c.req.param('sceneId')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const bundle = await readProjectBundle(id)
  let plan = await readStoryAssetPlanIfExists(id)
  if (!plan) {
    const storyBible = readStoryBibleFromProjectDoc(bundle.project)
    if (!storyBible || typeof storyBible !== 'object') {
      return c.json({ success: false, error: 'missing_story_bible', message: '未找到 Story Bible。请先生成 Story Bible 并创建资产计划。' }, 400)
    }
    plan = buildStoryAssetPlan({ project: bundle.project, story: bundle.story, storyBible, prevManifest: null })
    await saveStoryAssetPlan(id, plan, { mergeAssetsById: true })
  }

  // 背景-only 模式（背景+立绘分层合成）：mode='background' 或 backgroundOnly=true 时，
  // 场景只出背景（人物/事物由立绘 placements 合成），不再要求角色锁定引用
  const backgroundOnly = String(body?.mode || '').trim() === 'background' || body?.backgroundOnly === true
  // 2026-09-28 风格预设接入：背景排除词等从 settings 预设读取（缺省内置兜底）
  const sceneStylePreset = resolveStoryStylePreset(await getEffectiveStudioConfig(ROOT).catch(() => null))
  const renderSpec = buildStorySceneRenderSpec({ plan, sceneId, mode: backgroundOnly ? 'background' : '', stylePreset: sceneStylePreset })
  if (!renderSpec) return c.json({ success: false, error: 'scene_not_found', message: `未找到场景：${sceneId}` }, 404)

  // 任务进度：render-all 传入 taskId 时共享批量任务，否则为本场景建独立任务
  const sharedTaskId = String(body?.taskId || '').trim()
  const sharedTask = sharedTaskId ? getAiTask(sharedTaskId) : null
  const sceneTaskId = sharedTask
    ? sharedTask.taskId
    : createAiTask(id, 'story.scene.render', { total: 1, message: `渲染场景：${String(renderSpec.sceneName || sceneId).trim()}` }).taskId
  const ownSceneTask = !sharedTask
  updateAiTask(sceneTaskId, { stage: 'loading_refs', message: `加载参考图（${String(renderSpec.sceneName || sceneId).trim()}）…` })

  const traceId = createTraceId()

  // S4-02 reference required 门禁：场景含「必须参考图」资产但引用未锁定时显式 BLOCKED。
  // 禁止降级为无参考生成；阻断原因经 logStage 与任务进度留痕。
  if (Array.isArray(renderSpec.missingRequiredAssets) && renderSpec.missingRequiredAssets.length) {
    const missing = renderSpec.missingRequiredAssets
    const names = missing.map((asset) => `${asset.name || asset.id}(${asset.id})`).join('、')
    const message = `场景「${String(renderSpec.sceneName || sceneId).trim()}」存在必须参考图但未锁定的资产：${names}。请先完成角色/资产锁定，已阻断渲染。`
    logStage({ stage: 'story.scene.render', event: 'blocked', traceId, project: id, item: `${sceneId} / missing:${missing.map((a) => a.id).join(',')}` })
    // 共享批量任务（render-all/batch）只更新消息，不把整个批次标记 done；独立场景任务才收敛 blocked
    if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'blocked', done: true, error: 'scene_reference_missing', message })
    else updateAiTask(sceneTaskId, { message })
    return c.json({
      success: false,
      error: 'scene_reference_missing',
      message,
      sceneId: String(renderSpec.sceneId || sceneId).trim(),
      missingRequiredAssets: missing,
      taskId: sceneTaskId
    }, 409)
  }

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
  const imgProvider = String(studio.effective.image.provider || process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()
  if (!imgProvider || imgProvider === 'none') {
    return c.json({ success: false, error: 'user_provider_not_configured', message: '请先在设置中启用“出图（背景图）”并选择 Provider/Model' }, 400)
  }

  const aiBg = bundle.project && bundle.project.state && bundle.project.state.aiBackground && typeof bundle.project.state.aiBackground === 'object'
    ? bundle.project.state.aiBackground
    : {}
  const draft = aiBg && aiBg.storyboardBatchDraft && typeof aiBg.storyboardBatchDraft === 'object'
    ? aiBg.storyboardBatchDraft
    : {}
  const style = normalizeStyleEnum(body?.style || draft.style || 'picture_book')
  const width = clampInt(body?.width, 256, 2048, clampInt(draft.width, 256, 2048, 768))
  const height = clampInt(body?.height, 256, 2048, clampInt(draft.height, 256, 2048, 1024))
  const requestedModel = String(body?.model || '').trim()
  const requestedLoras = Array.isArray(body?.loras) ? body.loras.map((x) => String(x || '').trim()).filter(Boolean) : []

  // S4-02 渲染输入绑定：已锁定的参考图必须逐一通过文件真实性校验（复用 S4-01 门禁原语），
  // 校验失败显式 BLOCKED，禁止静默丢弃后降级为无参考生成；通过者记录为渲染输入证据。
  const referenceImages = []
  const referencesUsed = []
  for (const ref of Array.isArray(renderSpec.referenceAssets) ? renderSpec.referenceAssets : []) {
    const assetAbs = resolveAssetPathFromUri(id, ref.assetUri || '')
    const relPath = assetAbs ? path.relative(dir, assetAbs) : String(ref.assetUri || '')
    const fileGate = await verifyStoryAssetReferenceFile({ dir, assetPath: relPath })
    if (!assetAbs || !fileGate.ok) {
      const code = !assetAbs ? 'reference_path_outside_project' : fileGate.code
      const baseMessage = !assetAbs ? `参考图路径无法解析或越出项目目录：${String(ref.assetUri || '')}` : fileGate.message
      const message = `场景「${String(renderSpec.sceneName || sceneId).trim()}」的锁定参考图不可用（资产 ${String(ref.name || ref.id || '').trim()}）：${baseMessage}`
      logStage({ stage: 'story.scene.render', event: 'blocked', traceId, project: id, item: `${sceneId} / asset:${String(ref.id || '').trim()} / ${code}` })
      if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'blocked', done: true, error: code, message })
      else updateAiTask(sceneTaskId, { message })
      return c.json({
        success: false,
        error: code,
        message,
        sceneId: String(renderSpec.sceneId || sceneId).trim(),
        reference: { assetId: String(ref.id || '').trim(), assetName: String(ref.name || '').trim(), assetUri: String(ref.assetUri || '') },
        taskId: sceneTaskId
      }, 409)
    }
    try {
      const bytes = await readFile(fileGate.absPath)
      referenceImages.push({
        role: String(ref.category || 'asset').trim() || 'asset',
        assetId: String(ref.assetId || ref.id || '').trim() || undefined,
        assetName: String(ref.name || ref.id || 'reference').trim(),
        filename: path.basename(fileGate.absPath),
        bytes,
        weight: Number.isFinite(Number(ref.weight)) ? Number(ref.weight) : undefined
      })
      referencesUsed.push({
        assetId: String(ref.id || '').trim(),
        assetName: String(ref.name || ref.id || '').trim(),
        category: String(ref.category || '').trim(),
        assetPath: fileGate.relPath
      })
    } catch (_) {
      const message = `场景「${String(renderSpec.sceneName || sceneId).trim()}」的锁定参考图读取失败（资产 ${String(ref.name || ref.id || '').trim()}）：${fileGate.relPath}`
      logStage({ stage: 'story.scene.render', event: 'blocked', traceId, project: id, item: `${sceneId} / asset:${String(ref.id || '').trim()} / reference_file_missing` })
      if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'blocked', done: true, error: 'reference_file_missing', message })
      else updateAiTask(sceneTaskId, { message })
      return c.json({ success: false, error: 'reference_file_missing', message, taskId: sceneTaskId }, 409)
    }
  }

  const bodyPrompt = String(body?.scenePrompt || body?.prompt || '').trim()
  // 2026-08-30 缺陷修复：剧情描述是中文，图像模型几乎读不懂，渲染前经翻译链转英文（失败保留原文不阻断）；
  // prompt 顺序改为「场景内容 → 资产锚点 → 风格基调」，避免 worldAnchor 支配画面导致全场景同质跑题。
  let sceneContentPrompt = bodyPrompt || ''
  // 背景-only（2026-08-30 最终修正）：不再使用剧情叙事文本——人名剥离后残留的"三个孩子/三人"类叙事
  // 翻译后仍会画出人物/狼（实测三轮）。背景内容只由「地点资产的英文锚点」构成，无锚点时退回通用山谷村庄。
  // 2026-09-27 环境化：锚点来源从 promptLocks（含 prop/character）收窄为 environmentLocks（仅 location）——
  // 道具/角色由分层立绘合成提供，锚点进背景会把主体烘进背景图（并与负面词 animal 禁则自相矛盾）。
  const anchorOnlyBackground = !bodyPrompt && backgroundOnly
  if (anchorOnlyBackground) {
    const anchorParts = (Array.isArray(renderSpec.environmentLocks) ? renderSpec.environmentLocks : [])
      .map((line) => String(line || '').split(': ').slice(1).join(': ').trim())
      .filter(Boolean)
    sceneContentPrompt = anchorParts.length
      ? `empty picture book forest or place background featuring ${anchorParts.join('; ')}, scenery only, no characters, no animals`
      : 'empty rural valley village scene background, scenery only, no characters, no animals'
  } else if (!sceneContentPrompt) {
    sceneContentPrompt = backgroundOnly ? String(renderSpec.backgroundPrompt || '').trim() : String(renderSpec.summary || '').trim()
  }
  if (!anchorOnlyBackground && sceneContentPrompt && /[\u4e00-\u9fff]/.test(sceneContentPrompt)) {
    try {
      const studioCfg = await getEffectiveStudioConfig(ROOT)
      const tr = await translateStoryAssetPromptPair({
        studio: studioCfg,
        promptZh: sceneContentPrompt,
        negativePromptZh: '',
        fallbackPromptEn: '',
        fallbackNegativePrompt: '',
        timeoutMs: 60_000
      })
      const en = String(tr && tr.promptEn || '').trim()
      if (en) sceneContentPrompt = en
    } catch (_) { /* 翻译失败保留原文，不阻断渲染 */ }
  }
  // 背景-only：正向约束放 prompt 最前（权重最高位）
  if (!bodyPrompt && backgroundOnly && sceneContentPrompt) {
    sceneContentPrompt = `empty environment background illustration, scenery only without any characters, no people, no animals. Scene content: ${sceneContentPrompt}`
  }
  const prompt = [
    sceneContentPrompt,
    // 2026-09-27 去重：背景-only 时环境锚点已并入 sceneContentPrompt，不再二次拼接（同一锚点只出现一次）；
    // 全量模式（非背景-only）保留全部锚点拼接——人物/道具直接画进场景，锚点与正文不重复；
    // 显式 bodyPrompt 时行为与此前一致（仍拼 promptLocks）。
    ...(anchorOnlyBackground ? [] : (Array.isArray(renderSpec.promptLocks) ? renderSpec.promptLocks : []).slice(0, 20)),
    // 2026-09-08：显式自定义 prompt（body.scenePrompt/body.prompt）时不再拼 worldAnchor——
    // 锚点里的村庄/建筑词会把背景-only 空景拉回出房子（场景4实测夜景+小屋）。
    // 与下部安静区同规则：显式覆盖即全权生效。
    ...(bodyPrompt ? [] : [String(renderSpec.worldAnchor || plan.worldAnchor || '').trim()]),
    // 2026-08-28：H5 文本叠加在场景图上——拼装路径统一要求下部留安静区（显式自定义 prompt 原样尊重不追加）
    // 2026-09-27：措辞避开 "text"——"text overlay readability" 会被模型读成"画一片写字区"，
    // 在画面下部反复画出打开的书本（结局二三连中招，AI 评审与人工目检双重证实）
    ...(bodyPrompt ? [] : ['composition keeps the lower third as a calm empty low-detail area with soft ground or water only, no objects, no text, no letters'])
  ]
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .join(', ')
  if (!prompt) {
    return c.json({ success: false, error: 'missing_scene_prompt', message: '场景提示词为空，无法渲染。' }, 400)
  }
  const negativePrompt = [
    String(renderSpec.negativePrompt || '').trim(),
    String(body?.negativePrompt || '').trim()
  ].filter(Boolean).join(', ')

  // 出图前审核（manual 模式）：挂起并返回 202，批准后自动执行
  const reviewMode = resolveImageReviewMode(c, body)
  if (reviewMode === 'manual' && !(await hasApprovedPreGenerate(dir, c))) {
    const targetKey = `scene_render:${String(renderSpec.sceneId || sceneId).trim()}`
    let review = await findPendingReview(dir, { phase: 'pre_generate', targetKey })
    if (!review) {
      review = await createImageReview(dir, {
        phase: 'pre_generate',
        targetKey,
        sceneId: String(renderSpec.sceneId || sceneId).trim(),
        prompt,
        negativePrompt,
        referenceImages: referenceImages.map((ref) => ({ role: ref.role, assetId: ref.assetId, assetName: ref.assetName, filename: ref.filename })),
        params: { kind: 'story.scene.render', sceneName: String(renderSpec.sceneName || '').trim(), width, height, style, mode: String(renderSpec.mode || 'full') },
        execute: { endpoint: `/api/projects/${encodeURIComponent(id)}/ai/story/scenes/${encodeURIComponent(String(renderSpec.sceneId || sceneId).trim())}/render`, payload: body && typeof body === 'object' ? body : {} }
      })
    }
    if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'waiting_review', done: true, message: `出图前审核待批准：${String(renderSpec.sceneName || sceneId).trim()}` })
    return c.json({ success: true, pendingReview: review, taskId: sceneTaskId }, 202)
  }

  try {
    updateAiTask(sceneTaskId, { stage: 'generating', message: 'ComfyUI 生成中…' })
    // 生成+写盘+压缩封装为可重试单元：AI 视觉评审未通过时换 seed（seedMode random）重渲 1 次（F5）
    const generateAndPersist = async () => {
      const gen = await generateBackgroundImage({
        prompt,
        negativePrompt,
        width,
        height,
        style,
        steps: body?.steps ?? draft.steps,
        cfgScale: body?.cfgScale ?? draft.cfgScale,
        sampler: body?.sampler ?? draft.sampler,
        scheduler: body?.scheduler ?? draft.scheduler,
        continuity: {
          ipadapterEnabled: referenceImages.length > 0,
          requireCharacterRefs: false,
          controlnetEnabled: false,
          seedMode: 'random'
        },
        referenceImages,
        workflowMode: String(renderSpec.workflow || '').trim() || undefined,
        provider: imgProvider,
        sdwebuiBaseUrl: studio.effective.image.sdwebuiBaseUrl,
        comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
        apiUrl: studio.effective.image.apiUrl,
        model: requestedModel || studio.effective.image.model,
        loras: requestedLoras.length ? requestedLoras : studio.effective.image.loras,
        proxyUrl: studio.effective.network.proxyUrl,
        timeoutMs: body?.timeoutMs
      })

      const buf = gen.bytes
      const ext0 = String(gen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
      const sniff = sniffImageMetaFromBytes(buf)
      const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'
      const safeSceneSlug = String(renderSpec.sceneId || 'scene').replace(/[^a-z0-9_.-]+/gi, '_')
      const relDir = path.join('assets', 'ai', 'story_scenes')
      const outDir = path.join(dir, relDir)
      await mkdir(outDir, { recursive: true })
      const fname = `${safeSceneSlug}_${Date.now()}.${ext}`
      const abs = path.join(outDir, fname)
      await writeFile(abs, buf)
      let outAssetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
      { // 2026-09-09 出图即压：场景背景 JPEG q90
        const opt = await optimizeGeneratedImage(abs, IMAGE_KIND.SCENE_BG).catch(() => null)
        if (opt && opt.outPath && opt.outPath !== abs) outAssetPath = String(assetPathFromAbsolute(id, opt.outPath) || outAssetPath)
      }
      return { gen, assetPath: outAssetPath }
    }

    const bindSceneId = String(renderSpec.sceneId || sceneId).trim()
    let produced = await generateAndPersist()
    // 2026-09-27 F5 场景绑定前 AI 视觉评审（fail-closed）：
    // x-image-review-mode:off 只旁路人工门禁，AI 评审照常执行；
    // 评审未通过换 seed 重渲 1 次，仍失败显式 blocked（不绑定失败图）；
    // 视觉通道不可用挂 pending 待人工，禁止盲批 approved。
    updateAiTask(sceneTaskId, { stage: 'ai_review', message: 'AI 视觉评审（纯环境/环境匹配/绘本画风）…' })
    let aiReview = await reviewSceneBackgroundForBind({ id, dir, studio, renderSpec, sceneId: bindSceneId, assetPath: produced.assetPath })
    if (reviewMode !== 'manual' && aiReview.status === 'completed' && aiReview.passed === false) {
      logStage({ stage: 'story.scene.render', event: 'ai_review_failed', traceId, project: id, provider: imgProvider, item: `${sceneId} / score:${aiReview.score} / 换 seed 重渲 1 次` })
      try { // 首图评审未通过 rejected 留痕（targetKey 含 assetPath，逐图唯一）
        const first = await createImageReview(dir, {
          phase: 'scene_bind',
          targetKey: `scene_bind:${bindSceneId}:${produced.assetPath}`,
          sceneId: bindSceneId,
          prompt,
          negativePrompt,
          resultImagePath: produced.assetPath,
          aiReview,
          params: { sceneName: String(renderSpec.sceneName || '').trim(), mode: String(renderSpec.mode || 'full'), aiReviewAttempt: 1 }
        })
        await decideImageReview(dir, first.reviewId, { approved: false, decidedBy: 'ai', rejectReason: `AI 视觉评审未通过（首图，已换 seed 重渲）：${aiReview.summary}` })
      } catch (_) { /* 留痕失败不阻断重渲 */ }
      updateAiTask(sceneTaskId, { stage: 'generating', message: 'AI 视觉评审未通过，换 seed 重渲 1 次…' })
      produced = await generateAndPersist()
      updateAiTask(sceneTaskId, { stage: 'ai_review', message: '重渲图 AI 视觉评审…' })
      aiReview = await reviewSceneBackgroundForBind({ id, dir, studio, renderSpec, sceneId: bindSceneId, assetPath: produced.assetPath })
    }
    const { gen, assetPath } = produced

    // manual 模式：生成图先挂 scene_bind 审核（附 AI 视觉评审结论），人工 approve 后才绑定到故事节点
    if (reviewMode === 'manual') {
      const review = await createImageReview(dir, {
        phase: 'scene_bind',
        targetKey: `scene_bind:${String(renderSpec.sceneId || sceneId).trim()}:${assetPath}`,
        sceneId: String(renderSpec.sceneId || sceneId).trim(),
        prompt,
        negativePrompt,
        resultImagePath: assetPath,
        aiReview,
        params: {
          sceneName: String(renderSpec.sceneName || '').trim(),
          provider: String(gen?.meta?.provider || imgProvider || ''),
          remoteUrl: String(gen?.meta?.url || '').trim() || undefined,
          references: referencesUsed,
          mode: String(renderSpec.mode || 'full')
        }
      })
      if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'waiting_review', done: true, current: 1, message: `场景图待审核绑定：${String(renderSpec.sceneName || sceneId).trim()}` })
      logStage({ stage: 'story.scene.render', event: 'ok', traceId, project: id, provider: imgProvider, item: `${sceneId} / pending scene_bind / refs:${referencesUsed.map((r) => r.assetId).join(',') || '-'} / ${assetPath}` })
      return c.json({
        success: true,
        pendingReview: review,
        renderSpec,
        assetPath,
        referencesUsed,
        taskId: sceneTaskId,
        url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`,
        provider: String(gen?.meta?.provider || imgProvider || ''),
        prompt,
        negativePrompt,
        aiReview
      })
    }

    // F5 fail-closed：视觉通道不可用（模型未加载/租约超时/配置关闭）→ 挂 pending 待人工审核，禁止盲批
    if (aiReview.status !== 'completed') {
      const review = await createImageReview(dir, {
        phase: 'scene_bind',
        targetKey: `scene_bind:${bindSceneId}:${assetPath}`,
        sceneId: bindSceneId,
        prompt,
        negativePrompt,
        resultImagePath: assetPath,
        aiReview,
        params: {
          sceneName: String(renderSpec.sceneName || '').trim(),
          provider: String(gen?.meta?.provider || imgProvider || ''),
          remoteUrl: String(gen?.meta?.url || '').trim() || undefined,
          references: referencesUsed,
          mode: String(renderSpec.mode || 'full'),
          aiReviewUnavailable: true
        }
      })
      if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'waiting_review', done: true, current: 1, message: `AI 视觉评审不可用（${aiReview.reason}），场景图待人工审核绑定：${String(renderSpec.sceneName || sceneId).trim()}` })
      logStage({ stage: 'story.scene.render', event: 'ok', traceId, project: id, provider: imgProvider, item: `${sceneId} / pending scene_bind (ai_review unavailable: ${aiReview.reason}) / ${assetPath}` })
      return c.json({
        success: true,
        pendingReview: review,
        renderSpec,
        assetPath,
        referencesUsed,
        taskId: sceneTaskId,
        url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`,
        provider: String(gen?.meta?.provider || imgProvider || ''),
        prompt,
        negativePrompt,
        aiReview
      }, 202)
    }

    // F5：AI 评审未通过（含换 seed 重渲 1 次后）→ 标记 rejected 并显式 blocked，不绑定失败图
    if (aiReview.passed === false) {
      try {
        const rejectedRecord = await createImageReview(dir, {
          phase: 'scene_bind',
          targetKey: `scene_bind:${bindSceneId}:${assetPath}`,
          sceneId: bindSceneId,
          prompt,
          negativePrompt,
          resultImagePath: assetPath,
          aiReview,
          params: { sceneName: String(renderSpec.sceneName || '').trim(), mode: String(renderSpec.mode || 'full'), aiReviewAttempt: 2 }
        })
        await decideImageReview(dir, rejectedRecord.reviewId, { approved: false, decidedBy: 'ai', rejectReason: `AI 视觉评审未通过：${aiReview.summary}` })
      } catch (_) { /* 留痕失败不阻断阻断结论 */ }
      const message = `场景「${String(renderSpec.sceneName || sceneId).trim()}」AI 视觉评审未通过（含换 seed 重渲 1 次）：${aiReview.summary}。已阻断绑定，未绑定失败图。`
      logStage({ stage: 'story.scene.render', event: 'blocked', traceId, project: id, provider: imgProvider, item: `${sceneId} / scene_ai_review_failed / score:${aiReview.score}` })
      if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'blocked', done: true, error: 'scene_ai_review_failed', message })
      else updateAiTask(sceneTaskId, { message })
      return c.json({ success: false, error: 'scene_ai_review_failed', message, sceneId: bindSceneId, aiReview, taskId: sceneTaskId }, 409)
    }

    updateAiTask(sceneTaskId, { stage: 'writing', message: '写回项目与故事文档…' })
    const projectAsset = await persistSceneBackgroundBinding({
      dir,
      rawProject: bundle.rawProject,
      story: bundle.story,
      sceneId: String(renderSpec.sceneId || sceneId).trim(),
      sceneName: String(renderSpec.sceneName || '').trim(),
      assetPath,
      prompt,
      provider: String(gen?.meta?.provider || imgProvider || ''),
      remoteUrl: String(gen?.meta?.url || '').trim() || undefined,
      references: referencesUsed
    })
    // 结论留痕：非 manual 模式（control 旁路/全自动）绑定即补写 scene_bind approved 记录（附 AI 视觉评审结论），
    // 否则出图总账的 bound 状态永远缺这批场景。
    try {
      const bindTargetKey = `scene_bind:${bindSceneId}:${assetPath}`
      const bindDecidedBy = reviewMode === 'off' ? 'control' : 'system'
      const pendingBind = await findPendingReview(dir, { phase: 'scene_bind', targetKey: bindTargetKey })
      if (pendingBind) {
        await attachImageReviewResult(dir, pendingBind.reviewId, { aiReview })
        await decideImageReview(dir, pendingBind.reviewId, { approved: true, decidedBy: bindDecidedBy })
      } else {
        const bindRecord = await createImageReview(dir, {
          phase: 'scene_bind',
          targetKey: bindTargetKey,
          sceneId: bindSceneId,
          prompt,
          negativePrompt,
          resultImagePath: assetPath,
          aiReview,
          params: { sceneName: String(renderSpec.sceneName || '').trim(), mode: String(renderSpec.mode || 'full') }
        })
        await decideImageReview(dir, bindRecord.reviewId, { approved: true, decidedBy: bindDecidedBy })
      }
    } catch (_) { /* 留痕失败不阻断绑定结果 */ }

    logStage({ stage: 'story.scene.render', event: 'ok', traceId, project: id, provider: imgProvider, item: `${sceneId} / refs:${referencesUsed.map((r) => r.assetId).join(',') || '-'} / ${assetPath}` })
    if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'done', done: true, current: 1, message: `场景已出图：${String(renderSpec.sceneName || sceneId).trim()}` })
    return c.json({
      success: true,
      projectAsset,
      renderSpec,
      assetPath,
      referencesUsed,
      taskId: sceneTaskId,
      url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`,
      provider: String(gen?.meta?.provider || imgProvider || ''),
      remoteUrl: String(gen?.meta?.url || '').trim() || undefined,
      prompt,
      negativePrompt,
      aiReview
    })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    logStage({ stage: 'story.scene.render', event: 'fail', traceId, project: id, provider: imgProvider, item: `${sceneId} / ${msg}` })
    if (ownSceneTask) updateAiTask(sceneTaskId, { stage: 'error', done: true, error: msg, message: msg })
    return c.json({ success: false, error: mapped.code, message: msg, taskId: sceneTaskId }, mapped.httpStatus)
  }
})

// 批量渲染：异步串行渲染缺失场景，立即返回 taskId，进度经 /ai/tasks 轮询可见
app.post('/api/projects/:id/ai/story/scenes/render-all', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const bundle = await readProjectBundle(id)
  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)

  const storyNodes = Array.isArray(bundle.story?.nodes) ? bundle.story.nodes : []
  const onlyMissing = body?.onlyMissing !== false
  // 缺口以出图总账为准：status=pending（无背景或文件丢失）才算缺口；rendered 未过审不重渲
  const coverageBefore = await getStoryImageCoverage(dir)
  const gapSceneIds = new Set(coverageBefore.scenes.items.filter((s) => s.status === 'pending').map((s) => s.id))
  const targets = storyNodes
    .filter((n) => !onlyMissing || gapSceneIds.has(String(n && n.id || '').trim()))
    .map((n) => String(n && n.id || '').trim())
    .filter(Boolean)
  if (!targets.length) {
    return c.json({ success: true, taskId: null, total: 0, coverage: coverageBefore, message: '所有场景均已有图，无需渲染' })
  }

  const active = listAiTasks(id, { includeDone: false }).find((t) => t.kind === 'story.scenes.render_all')
  if (active) {
    return c.json({ success: false, error: 'render_all_running', message: '批量渲染正在进行中', taskId: active.taskId }, 409)
  }

  // 出图前审核（manual 模式）：整个批次挂一次审核，批准后自动执行；场景绑定仍逐张审核
  const reviewMode = resolveImageReviewMode(c, body)
  if (reviewMode === 'manual' && !(await hasApprovedPreGenerate(dir, c))) {
    const targetKey = 'render_all'
    let review = await findPendingReview(dir, { phase: 'pre_generate', targetKey })
    if (!review) {
      review = await createImageReview(dir, {
        phase: 'pre_generate',
        targetKey,
        prompt: String(plan.worldAnchor || '').trim(),
        params: {
          kind: 'story.scenes.render_all',
          sceneCount: targets.length,
          scenes: targets.slice(0, 20)
        },
        execute: { endpoint: `/api/projects/${encodeURIComponent(id)}/ai/story/scenes/render-all`, payload: body && typeof body === 'object' ? body : {} }
      })
    }
    return c.json({ success: true, pendingReview: review, message: `批量渲染 ${targets.length} 个场景待出图前审核` }, 202)
  }

  const task = createAiTask(id, 'story.scenes.render_all', { total: targets.length, message: `批量渲染 ${targets.length} 个场景` })
  const port = Number(process.env.PORT || 1999)
  const approvedToken = String(c.req.header('x-pre-generate-approved') || '').trim()
  // 2026-10-06 根修：批次内部逐场景渲染必须透传调用方的审核模式（control/自动化旁路 off），
  // 否则每场景按 manual 挂起 pre_generate 审核而批次报"完成 N/N"假完成（假日出游 6 场景零出图事故）
  const reviewModeHeader = String(c.req.header('x-image-review-mode') || '').trim()
  ;(async () => {
    const results = []
    let okCount = 0
    let pendingCount = 0
    for (let i = 0; i < targets.length; i += 1) {
      const sceneId = targets[i]
      updateAiTask(task.taskId, { stage: 'rendering', current: i + 1, message: `渲染场景 ${i + 1}/${targets.length}：${sceneId}` })
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent(id)}/ai/story/scenes/${encodeURIComponent(sceneId)}/render`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(approvedToken ? { 'x-pre-generate-approved': approvedToken } : {}),
            ...(reviewModeHeader ? { 'x-image-review-mode': reviewModeHeader } : {})
          },
          body: JSON.stringify({
            width: body?.width,
            height: body?.height,
            timeoutMs: body?.timeoutMs,
            backgroundOnly: body?.backgroundOnly === true,
            reviewMode: body?.reviewMode,
            taskId: task.taskId
          })
        })
        const json = await resp.json().catch(() => ({}))
        if (resp.ok && json.success && !json.pendingReview) {
          okCount += 1
          results.push({ sceneId, ok: true, assetPath: json.assetPath })
        } else if (json.pendingReview) {
          // 审核挂起不是成功：单独计数并明示，批次不再报假完成
          pendingCount += 1
          results.push({ sceneId, ok: false, pendingReview: true, error: 'pending_review' })
        } else {
          results.push({ sceneId, ok: false, error: String(json.message || json.error || `http_${resp.status}`) })
        }
      } catch (e) {
        results.push({ sceneId, ok: false, error: e && e.message ? String(e.message) : String(e) })
      }
    }
    // 批次结束后刷新出图总账，随任务结果返回（UI 可直接展示完成度）
    let coverageAfter = null
    try { coverageAfter = await getStoryImageCoverage(dir) } catch (_) { /* 总账失败不影响渲染结果 */ }
    updateAiTask(task.taskId, {
      stage: okCount === targets.length ? 'done' : (pendingCount > 0 ? 'pending_review' : 'partial'),
      done: pendingCount > 0 ? false : true,
      current: targets.length,
      message: `批量渲染完成 ${okCount}/${targets.length}${pendingCount ? `（${pendingCount} 个待审核，批准后自动继续）` : ''}`,
      result: { okCount, pendingCount, results, coverage: coverageAfter }
    })
  })().catch((e) => {
    updateAiTask(task.taskId, { stage: 'error', done: true, error: e && e.message ? String(e.message) : String(e) })
  })

  return c.json({ success: true, taskId: task.taskId, total: targets.length }, 202)
})

// ---------------------------------------------------------------------------
// 场景图版本管理（2026-08-30 用户指令：场景图需要可管理——历史版本查看/换绑/删除）
// 文件真相源：assets/ai/story_scenes/<sceneId>_<时间戳>.<ext>
// ---------------------------------------------------------------------------

app.get('/api/projects/:id/ai/story/scenes/:sceneId/images', async (c) => {
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const sceneId = String(c.req.param('sceneId') || '').trim()
  const bundle = await readProjectBundle(id)
  const node = (Array.isArray(bundle.story?.nodes) ? bundle.story.nodes : []).find((n) => String(n && n.id || '').trim() === sceneId)
  const boundAssetId = String(node?.visuals?.backgroundAssetId || '').trim()
  const boundAsset = boundAssetId && Array.isArray(bundle.rawProject?.assets)
    ? bundle.rawProject.assets.find((a) => String(a && a.id || '').trim() === boundAssetId)
    : null
  const boundUri = String(boundAsset?.uri || '').trim().replace(/^\/+/, '')

  const scenesDir = path.join(dir, 'assets', 'ai', 'story_scenes')
  const files = await readdir(scenesDir).catch(() => [])
  const prefix = `${sceneId.replace(/[^a-z0-9_.-]+/gi, '_')}_`
  const items = files
    .filter((f) => f.startsWith(prefix) && /\.(png|jpe?g|webp)$/i.test(f))
    .map((f) => {
      const m = f.slice(prefix.length).match(/^(\d+)\./)
      const ts = m ? Number(m[1]) : 0
      const assetPath = `assets/ai/story_scenes/${f}`
      return {
        assetPath,
        url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`,
        createdAt: ts ? new Date(ts).toISOString() : '',
        isBound: boundUri === assetPath
      }
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return c.json({ success: true, sceneId, items, boundUri })
})

// 换绑：把该场景的某个历史版本设为背景（人工操作，落 scene_bind approved 记录，decidedBy=user）
app.post('/api/projects/:id/ai/story/scenes/:sceneId/bind', async (c) => {
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const sceneId = String(c.req.param('sceneId') || '').trim()
  const body = await c.req.json().catch(() => ({}))
  const assetPath = String(body?.assetPath || '').trim().replace(/^\/+/, '')
  if (!assetPath) return c.json({ success: false, error: 'missing_asset_path', message: 'assetPath 不能为空' }, 400)
  const fileGate = await verifyStoryAssetReferenceFile({ dir, assetPath })
  if (!fileGate.ok) return c.json({ success: false, error: fileGate.code, message: fileGate.message }, 400)

  const bundle = await readProjectBundle(id)
  const node = (Array.isArray(bundle.story?.nodes) ? bundle.story.nodes : []).find((n) => String(n && n.id || '').trim() === sceneId)
  if (!node) return c.json({ success: false, error: 'scene_not_found', message: `未找到场景：${sceneId}` }, 404)
  const sceneName = String(node.name || sceneId).trim()
  const projectAsset = await persistSceneBackgroundBinding({
    dir,
    rawProject: bundle.rawProject,
    story: bundle.story,
    sceneId,
    sceneName,
    assetPath,
    prompt: '',
    provider: '',
    references: []
  })
  try {
    const bindRecord = await createImageReview(dir, {
      phase: 'scene_bind',
      targetKey: `scene_bind:${sceneId}:${assetPath}`,
      sceneId,
      resultImagePath: assetPath,
      params: { sceneName, source: 'manual_rebind' }
    })
    await decideImageReview(dir, bindRecord.reviewId, { approved: true, decidedBy: 'user' })
  } catch (_) { /* 留痕失败不阻断换绑 */ }
  return c.json({ success: true, projectAsset, sceneId, assetPath })
})

// 删除某个历史版本（当前绑定中的图禁止删除）
app.post('/api/projects/:id/ai/story/scenes/:sceneId/images/delete', async (c) => {
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const sceneId = String(c.req.param('sceneId') || '').trim()
  const body = await c.req.json().catch(() => ({}))
  const assetPath = String(body?.assetPath || '').trim().replace(/^\/+/, '')
  if (!assetPath) return c.json({ success: false, error: 'missing_asset_path', message: 'assetPath 不能为空' }, 400)
  const fileGate = await verifyStoryAssetReferenceFile({ dir, assetPath })
  if (!fileGate.ok) return c.json({ success: false, error: fileGate.code, message: fileGate.message }, 400)

  const bundle = await readProjectBundle(id)
  const node = (Array.isArray(bundle.story?.nodes) ? bundle.story.nodes : []).find((n) => String(n && n.id || '').trim() === sceneId)
  const boundAssetId = String(node?.visuals?.backgroundAssetId || '').trim()
  const boundAsset = boundAssetId && Array.isArray(bundle.rawProject?.assets)
    ? bundle.rawProject.assets.find((a) => String(a && a.id || '').trim() === boundAssetId)
    : null
  if (String(boundAsset?.uri || '').trim().replace(/^\/+/, '') === assetPath) {
    return c.json({ success: false, error: 'bound_image', message: '该图是当前绑定背景，请先换绑其他版本再删除。' }, 409)
  }
  await rm(path.join(dir, assetPath))
  return c.json({ success: true, deleted: assetPath })
})

// ---------------------------------------------------------------------------
// AUTO-E05：故事完整度核实——真实浏览器逐节点走查导出的可玩 H5，
// 确定性检查（console 错误/背景/立绘/文本/选项/可达性）+ Kimi 视觉评审 + 截图留证。
// 只读 QA（不生成任何资产），故不挂出图审核门禁；长任务经 /ai/tasks 暴露进度（仓库硬规则）。
// ---------------------------------------------------------------------------
app.post('/api/projects/:id/ai/story/completeness-check', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  // 前置确定性校验：无导出产物 / 无 Chrome / 空故事都直接失败，不进异步任务
  const distIndex = path.join(projectBuildDir(id, 'latest'), 'dist', 'index.html')
  if (!(await existsFile(distIndex))) {
    return c.json({ success: false, error: 'missing_dist', message: '未找到导出产物 builds/latest/dist/index.html，请先导出。' }, 400)
  }
  if (!resolveChromeExecutablePath()) {
    return c.json({ success: false, error: 'chrome_not_found', message: '未找到本机 Chrome（可设 STUDIO_CHROME_PATH 指定）。' }, 400)
  }
  const bundle = await readProjectBundle(id)
  const storyNodes = Array.isArray(bundle.story?.nodes) ? bundle.story.nodes : []
  if (!storyNodes.length) {
    return c.json({ success: false, error: 'empty_story', message: 'story.json 无节点，无法走查。' }, 400)
  }

  const active = listAiTasks(id, { includeDone: false }).find((t) => t.kind === COMPLETENESS_TASK_KIND)
  if (active) {
    return c.json({ success: false, error: 'completeness_check_running', message: '完整度核实正在进行中', taskId: active.taskId }, 409)
  }

  // 评审模型：body 覆盖 > studio settings review 段 > 环境默认（moonshot/kimi-for-coding）
  const body = await c.req.json().catch(() => ({}))
  const studio = await getEffectiveStudioConfig(ROOT)
  const reviewConfig = resolveReviewConfig({ studioEffective: studio.effective, body })

  const port = Number(process.env.PORT || 1999)
  const distUrl = `http://127.0.0.1:${port}/demos/${encodeURIComponent(id)}/latest/dist/index.html`
  const task = createAiTask(id, COMPLETENESS_TASK_KIND, { total: storyNodes.length, message: `完整度核实：${storyNodes.length} 个节点` })
  ;(async () => {
    // 评审器任何配置问题都如实记 review_unavailable（unsupported/missing key），不伪造评审
    const reviewer = createNodeVisualReviewer({
      provider: reviewConfig.provider,
      model: reviewConfig.model,
      apiUrl: reviewConfig.apiUrl,
      timeoutMs: Number(body?.reviewTimeoutMs) || undefined
    })
    // 本地视觉评审全程持 vision 独占租约（一次性换入 gemma，避免逐节点装卸抖动）；
    // 走查浏览器阶段也在租约内——全程只有几分钟，且 llm 等待语义与出图互斥一致
    const runCheck = () => runStoryCompletenessCheck({
      projectId: id,
      dir,
      story: bundle.story,
      project: bundle.project,
      distUrl,
      launchBrowser: createPuppeteerBrowserLauncher(),
      reviewer,
      reviewMeta: reviewConfig,
      onProgress: ({ index, total, nodeId }) => {
        updateAiTask(task.taskId, { stage: 'walking', current: index, total, message: `走查节点 ${index}/${total}：${nodeId}` })
      }
    })
    const { report, reportPath } = reviewConfig.provider === 'omlx'
      ? await withResourceLease('vision', `gs:completeness:${id}`, runCheck)
      : await runCheck()
    updateAiTask(task.taskId, {
      stage: report.verdict === 'pass' ? 'done' : 'failed',
      done: true,
      current: report.summary.total,
      message: `完整度核实完成：${report.verdict}（${report.summary.passed}/${report.summary.total} 通过，AI 评审 ${report.aiReviewStatus}）`,
      result: {
        verdict: report.verdict,
        aiReviewStatus: report.aiReviewStatus,
        summary: report.summary,
        failedNodes: report.failedNodes,
        reportFile: path.relative(dir, reportPath)
      }
    })
  })().catch((e) => {
    updateAiTask(task.taskId, { stage: 'error', done: true, error: e && e.message ? String(e.message) : String(e) })
  })

  return c.json({ success: true, taskId: task.taskId, total: storyNodes.length }, 202)
})

app.get('/api/projects/:id/ai/story/completeness-check/latest', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const latest = await loadLatestCompletenessReport(dir)
  if (!latest) return c.json({ success: false, error: 'no_report', message: '暂无完整度报告，请先执行核实。' }, 404)
  return c.json({ success: true, file: latest.file, report: latest.report })
})

// ---------------------------------------------------------------------------
// AUTO-E03 / S4-03：批量场景生产队列（scene item 队列）
// 与 render-all 的区别：per-scene checkpoint 落盘（story-assets/scene-batch-queue.json）、
// C02 同源失败分类退避重试、成功保护不重复生成、重启后从断点继续。
// 批量入口与 render-all 一致不挂 storyInputGate（契约枚举未覆盖批量类型）。
// ---------------------------------------------------------------------------

// 进程内执行守卫：防止 resume/重启扫描与正在执行的批次并发双跑
const activeSceneBatchProjects = new Set()

// 装配批次执行器：renderScene 经 app.request 走单 scene render 路由完整门禁（reference gate/审核/回填）
function makeSceneBatchRunner(id, task, { reviewMode, approvedToken, renderPayload } = {}) {
  const renderScene = async (sceneId) => {
    try {
      const resp = await app.request(`/api/projects/${encodeURIComponent(id)}/ai/story/scenes/${encodeURIComponent(sceneId)}/render`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(reviewMode ? { 'x-image-review-mode': reviewMode } : {}),
          ...(approvedToken ? { 'x-pre-generate-approved': approvedToken } : {})
        },
        body: JSON.stringify({ ...(renderPayload && typeof renderPayload === 'object' ? renderPayload : {}), taskId: task.taskId })
      })
      const json = await resp.json().catch(() => ({}))
      if (resp.status === 202 && json && json.pendingReview) {
        return { pendingReview: true, message: json.pendingReview.phase === 'scene_bind' ? '场景图待人工审核绑定' : '出图前审核待批准' }
      }
      if (resp.ok && json && json.success) {
        return { ok: true, assetPath: json.assetPath, projectAssetId: json.projectAsset && json.projectAsset.id }
      }
      return { ok: false, httpStatus: resp.status, error: String(json.error || ''), message: String(json.message || json.error || `http_${resp.status}`) }
    } catch (e) {
      return { ok: false, httpStatus: 0, error: '', message: e && e.message ? String(e.message) : String(e) }
    }
  }
  const onProgress = async (batch, item) => {
    const settled = batch.items.filter((it) => ['completed', 'skipped', 'waiting_review', 'failed', 'blocked'].includes(it.status)).length
    updateAiTask(task.taskId, { stage: 'rendering', current: settled, message: `批量渲染 ${settled}/${batch.items.length}：${item.sceneId} → ${item.status}` })
  }
  return { renderScene, onProgress }
}

function finalizeSceneBatchTask(task, done) {
  const okCount = done.items.filter((it) => it.status === 'completed').length
  const skipCount = done.items.filter((it) => it.status === 'skipped').length
  const waitCount = done.items.filter((it) => it.status === 'waiting_review').length
  updateAiTask(task.taskId, {
    stage: done.status === 'completed' ? 'done' : done.status,
    done: true,
    current: done.items.length,
    message: `批量渲染结束：完成 ${okCount}、跳过 ${skipCount}、待审核 ${waitCount}、失败/阻断 ${done.items.length - okCount - skipCount - waitCount}（${done.status}）`,
    result: {
      batchId: done.batchId,
      status: done.status,
      items: done.items.map((it) => ({
        sceneId: it.sceneId,
        status: it.status,
        attempts: it.attempts,
        error: it.error || undefined,
        errorCategory: it.errorCategory || undefined,
        assetPath: it.assetPath || undefined
      }))
    }
  })
}

// 后台启动批次执行（带进程内守卫）；run 返回最终 batch，返回 null 表示无需收尾（如无待恢复场景）
function launchSceneBatch(id, task, run) {
  activeSceneBatchProjects.add(id)
  ;(async () => {
    try {
      const done = await run()
      if (done) finalizeSceneBatchTask(task, done)
      else updateAiTask(task.taskId, { stage: 'done', done: true, message: '无待恢复场景，队列保持原状。' })
    } catch (e) {
      updateAiTask(task.taskId, { stage: 'error', done: true, error: e && e.message ? String(e.message) : String(e) })
    } finally {
      activeSceneBatchProjects.delete(id)
    }
  })()
}

function hasOpenSceneBatch(batch) {
  if (!batch) return false
  if (batch.status === 'running' || batch.status === 'queued') return true
  return batch.items.some((it) => it.status === 'queued' || it.status === 'running')
}

// 提交批量场景队列：sceneIds 缺省 = 计划全部场景（按 sceneIndex 排序），执行顺序 = 提交顺序，串行执行
app.post('/api/projects/:id/ai/story/scenes/batch', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)

  const planScenes = Array.isArray(plan.scenes) ? plan.scenes : []
  const byId = new Map(planScenes.map((s) => [String(s && s.sceneId || '').trim(), s]))
  let sceneIds
  if (Array.isArray(body?.sceneIds) && body.sceneIds.length) {
    sceneIds = [...new Set(body.sceneIds.map((x) => String(x || '').trim()).filter(Boolean))]
    const unknown = sceneIds.filter((sid) => !byId.has(sid))
    if (unknown.length) return c.json({ success: false, error: 'scene_not_found', message: `计划中不存在场景：${unknown.join('、')}` }, 404)
  } else {
    sceneIds = planScenes
      .slice()
      .sort((a, b) => (Number(a && a.sceneIndex) || 0) - (Number(b && b.sceneIndex) || 0))
      .map((s) => String(s && s.sceneId || '').trim())
      .filter(Boolean)
  }
  if (!sceneIds.length) return c.json({ success: false, error: 'empty_batch', message: '批次为空：没有可渲染的场景。' }, 400)

  // 单项目同时刻只允许一个未完成批次（文件 checkpoint + 进程内守卫双重判定）
  const existing = await loadSceneBatch(dir)
  if (activeSceneBatchProjects.has(id) || hasOpenSceneBatch(existing)) {
    return c.json({ success: false, error: 'scene_batch_running', message: '已有批量队列在执行中，可查询状态或等待完成后再提交。', batchId: existing ? existing.batchId : undefined }, 409)
  }

  // 出图前审核（manual 模式）：整个批次挂一次审核，批准后自动执行；场景绑定仍逐张审核（E02 语义保留）
  const reviewMode = resolveImageReviewMode(c, body)
  if (reviewMode === 'manual' && !(await hasApprovedPreGenerate(dir, c))) {
    const targetKey = 'scene_batch'
    let review = await findPendingReview(dir, { phase: 'pre_generate', targetKey })
    if (!review) {
      review = await createImageReview(dir, {
        phase: 'pre_generate',
        targetKey,
        prompt: String(plan.worldAnchor || '').trim(),
        params: { kind: 'story.scenes.batch', sceneCount: sceneIds.length, scenes: sceneIds.slice(0, 20) },
        execute: { endpoint: `/api/projects/${encodeURIComponent(id)}/ai/story/scenes/batch`, payload: body && typeof body === 'object' ? body : {} }
      })
    }
    return c.json({ success: true, pendingReview: review, message: `批量渲染 ${sceneIds.length} 个场景待出图前审核` }, 202)
  }

  // 提交时预判成功保护：已成功绑定/待人工审核的场景直接标 skipped，不进入执行、不重复生成
  const regen = body?.regenerate
  const regenSet = Array.isArray(regen) ? new Set(regen.map((x) => String(x || '').trim())) : null
  const items = []
  for (const sid of sceneIds) {
    const entry = byId.get(sid)
    const sceneName = String(entry && entry.sceneName || '').trim()
    const requested = regen === true || (regenSet ? regenSet.has(sid) : false)
    if (!requested) {
      const guard = await checkSceneSuccess({ dir, sceneId: sid })
      if (guard.success) {
        items.push({ sceneId: sid, sceneName, status: 'skipped', skipReason: 'already_succeeded', assetPath: guard.assetPath, projectAssetId: guard.assetId, history: [{ at: new Date().toISOString(), event: 'skipped', detail: '已成功绑定资产，按成功保护跳过' }] })
        continue
      }
      if (guard.pendingReview) {
        items.push({ sceneId: sid, sceneName, status: 'skipped', skipReason: 'pending_review', history: [{ at: new Date().toISOString(), event: 'skipped', detail: `存在待人工审核（${String(guard.reviewId || '')}），按成功保护跳过` }] })
        continue
      }
    }
    items.push({ sceneId: sid, sceneName })
  }

  const batch = await createSceneBatch({
    dir,
    projectId: id,
    items,
    options: {
      regenerate: regen === true ? true : (regenSet ? [...regenSet] : undefined),
      reviewMode,
      width: body?.width,
      height: body?.height,
      timeoutMs: body?.timeoutMs,
      // 背景-only 模式透传（分层合成方向）：随 checkpoint 持久化，resume/重启恢复后仍生效
      mode: String(body?.mode || '').trim() || undefined,
      backgroundOnly: body?.backgroundOnly === true ? true : undefined
    }
  })

  const task = createAiTask(id, 'story.scenes.batch', { total: batch.items.length, message: `批量渲染 ${batch.items.length} 个场景（队列 ${batch.batchId}）` })
  const approvedToken = String(c.req.header('x-pre-generate-approved') || '').trim()
  const { renderScene, onProgress } = makeSceneBatchRunner(id, task, {
    reviewMode,
    approvedToken,
    renderPayload: { width: body?.width, height: body?.height, timeoutMs: body?.timeoutMs, mode: body?.mode, backgroundOnly: body?.backgroundOnly }
  })
  launchSceneBatch(id, task, () => runSceneBatch({ dir, batch, renderScene, onProgress }))

  logStage({ stage: 'story.scenes.batch', event: 'queued', project: id, item: `${batch.batchId} / scenes:${sceneIds.join(',')}` })
  return c.json({
    success: true,
    batchId: batch.batchId,
    taskId: task.taskId,
    total: batch.items.length,
    items: batch.items.map((it) => ({ sceneId: it.sceneId, status: it.status, skipReason: it.skipReason || undefined }))
  }, 202)
})

// 查询批量队列状态（per-scene checkpoint 原样返回）
app.get('/api/projects/:id/ai/story/scenes/batch', async (c) => {
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const batch = await loadSceneBatch(dir)
  return c.json({ success: true, batch })
})

// 恢复批量队列：中断的 running/queued 继续；retryFailed=true 时失败场景按显式恢复意图重置预算重跑
app.post('/api/projects/:id/ai/story/scenes/batch/resume', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const existing = await loadSceneBatch(dir)
  if (!existing) return c.json({ success: false, error: 'scene_batch_not_found', message: '没有可恢复的批量队列。' }, 404)
  if (activeSceneBatchProjects.has(id)) {
    return c.json({ success: false, error: 'scene_batch_running', message: '批量队列正在执行中，无需恢复。', batchId: existing.batchId }, 409)
  }

  const retryFailed = body?.retryFailed === true
  const reviewMode = String(existing.options && existing.options.reviewMode || '').trim() || resolveImageReviewMode(c, body)
  const task = createAiTask(id, 'story.scenes.batch', { total: existing.items.length, message: `恢复批量渲染（队列 ${existing.batchId}）` })
  const { renderScene, onProgress } = makeSceneBatchRunner(id, task, {
    reviewMode,
    approvedToken: '',
    renderPayload: { width: existing.options?.width, height: existing.options?.height, timeoutMs: existing.options?.timeoutMs, mode: existing.options?.mode, backgroundOnly: existing.options?.backgroundOnly }
  })
  launchSceneBatch(id, task, async () => {
    const { resumed, batch } = await resumeSceneBatch({ dir, renderScene, onProgress, retryFailed })
    return resumed ? batch : null
  })

  logStage({ stage: 'story.scenes.batch', event: 'resume', project: id, item: `${existing.batchId} / retryFailed:${retryFailed}` })
  return c.json({ success: true, batchId: existing.batchId, taskId: task.taskId, retryFailed }, 202)
})

// ---------------------------------------------------------------------------
// AUTO-E04：立绘 placements 生成（背景+立绘分层合成方向）
// 按资产计划 sceneIds 判定各场景出场角色与道具，生成默认站位的 placements 写入 story.json
// 节点 visuals.placements，并把立绘 project asset id 同步到 project.json characters[].imageAssetId
// （运行时解析 p.imageAssetId || ch.imageAssetId；prop 摆位 characterId 置空 + imageAssetId，
// 与编辑器手工拖入的道具摆位同构，编辑器预览与 storyPixi 导出均认 imageAssetId）。
// 幂等：同角色/同道具已存在 placement 时保留其既有站位（编辑器可能已人工调整），仅刷新 imageAssetId；
// 未锁定（无立绘引用）的角色/道具跳过并如实报告，不伪造。
// 与批量入口一致不挂 storyInputGate（契约枚举未覆盖该类型）。
// ---------------------------------------------------------------------------

// 默认站位：1 人 0.5；2 人 0.3/0.7；3 人 0.25/0.5/0.75；>3 人兜底横向均分
function defaultPlacementX(index, count) {
  if (count <= 1) return 0.5
  if (count === 2) return [0.3, 0.7][index]
  if (count === 3) return [0.25, 0.5, 0.75][index]
  return Number(((index + 1) / (count + 1)).toFixed(4))
}

// 立绘默认缩放：运行时按「原始像素 × scale」渲染，1024px 立绘在千像素级舞台上 scale=1 会铺满舞台。
// 按立绘实际像素高度收敛到约 62% 舞台高（参考舞台高 1024px），无尺寸信息时回退 0.62。
function defaultPlacementScale(asset) {
  const refs = Array.isArray(asset?.generatedRefs) ? asset.generatedRefs : []
  const withSize = refs.find((r) => Number(r && r.height) > 0)
  const heightPx = Number(withSize && withSize.height) || 0
  if (!heightPx) return 0.62
  return Math.min(1, Math.max(0.25, Number((640 / heightPx).toFixed(3))))
}

// 为计划中的角色资产匹配 project.json 角色：优先 projectCharacterId，其次名字/别名（不区分大小写）
function findProjectCharacterForStoryAsset(characters, asset) {
  const list = Array.isArray(characters) ? characters : []
  const wantedId = String(asset?.projectCharacterId || '').trim()
  if (wantedId) {
    const hit = list.find((ch) => String(ch && ch.id || '').trim() === wantedId)
    if (hit) return hit
  }
  const keys = new Set(
    [asset?.name, ...(Array.isArray(asset?.aliases) ? asset.aliases : [])]
      .map((x) => String(x || '').trim().toLowerCase())
      .filter(Boolean)
  )
  if (!keys.size) return null
  return list.find((ch) => keys.has(String(ch && ch.id || '').trim().toLowerCase()) || keys.has(String(ch && ch.name || '').trim().toLowerCase())) || null
}

// ---------------------------------------------------------------------------
// prop 分层合成默认位姿（2026-09-27 F6）：确定性规则，不做语义猜测。
// flying：飞虫类（butterfly/dragonfly 等 slender/small prop）放画面上三分之一、scale 0.10-0.18、x 错开角色；
// ground：桶/盆类地面道具放角色侧前方、scale 0.15-0.25；
// fish_near_bucket：结局场景的鱼放桶位置附近（找不到桶退化为 ground）。
// ---------------------------------------------------------------------------
const FLYING_PROP_PATTERN = /(butterfly|dragonfly|bee|beetle|firefl|insect|bug|moth|蝴蝶|蜻蜓|蜜蜂|甲虫|萤火|昆虫|飞蛾)/i
const FISH_PROP_PATTERN = /(fish|鱼)/i
const BUCKET_PROP_PATTERN = /(bucket|tub|barrel|pail|basin|木桶|水桶|桶|盆)/i

function propAssetSignalText(asset) {
  return [asset?.name, asset?.anchorPrompt, ...(Array.isArray(asset?.aliases) ? asset.aliases : [])].map((x) => String(x || '')).join(' ')
}

function propPlacementProfile(asset, { isEndingScene } = {}) {
  const signal = propAssetSignalText(asset)
  if (FLYING_PROP_PATTERN.test(signal)) return 'flying'
  if (isEndingScene && FISH_PROP_PATTERN.test(signal)) return 'fish_near_bucket'
  return 'ground'
}

function propPlacementTransform({ profile, index, characterXs, bucketTransform }) {
  if (profile === 'flying') {
    // 上三分之一（y≈0.30），x 从候选位中取与所有角色水平距离 ≥0.15 的第一个；都太近时取距离最远的
    const xs = Array.isArray(characterXs) ? characterXs : []
    const candidates = [0.2, 0.8, 0.35, 0.65, 0.5]
    let best = candidates[0]
    let bestDist = -1
    for (const cx of candidates) {
      const d = xs.length ? Math.min(...xs.map((x) => Math.abs(x - cx))) : 1
      if (d >= 0.15) { best = cx; break }
      if (d > bestDist) { best = cx; bestDist = d }
    }
    return { x: best, y: Number((0.3 + (index % 2) * 0.06).toFixed(3)), scale: 0.14, rotationDeg: 0 }
  }
  if (profile === 'fish_near_bucket' && bucketTransform) {
    return {
      x: Math.max(0.06, Math.min(0.94, Number((Number(bucketTransform.x) + 0.07 || 0.57).toFixed(3)))),
      y: Math.max(0.3, Math.min(0.95, Number((Number(bucketTransform.y) - 0.05 || 0.83).toFixed(3)))),
      scale: 0.12,
      rotationDeg: 0
    }
  }
  // ground：首个角色侧前方（交替向两侧错开），无角色时从左起横向铺开
  const xs = Array.isArray(characterXs) ? characterXs : []
  if (!xs.length) return { x: Math.max(0.15, Math.min(0.85, Number((0.3 + index * 0.2).toFixed(3)))), y: 0.88, scale: 0.2, rotationDeg: 0 }
  const dir = index % 2 === 0 ? 1 : -1
  const step = 0.16 * (Math.floor(index / 2) + 1)
  return { x: Math.max(0.08, Math.min(0.92, Number((xs[0] + dir * step).toFixed(3)))), y: 0.88, scale: 0.2, rotationDeg: 0 }
}

// prop 摆位所需的「已关联项目资产 id」集合（幂等匹配用）：主参考 + 全部抽卡候选的 projectAssetId
function associatedPropProjectAssetIds(asset) {
  return new Set(
    [
      String(asset?.primaryReferenceAssetId || '').trim(),
      ...(Array.isArray(asset?.generatedRefs) ? asset.generatedRefs : []).map((r) => String(r && r.projectAssetId || '').trim())
    ].filter(Boolean)
  )
}

// 解析 prop 摆位所需的项目图片资产 id：
// primaryReferenceAssetId → 项目资产按 uri 反查 → generatedRefs 按 uri 反查；
// 都解析不到但主参考文件真实存在时，登记一条项目资产（与 select 链路「故事资产立绘」登记同形），
// 并由调用方回写计划 primaryReferenceAssetId。文件不真实返回 null（调用方跳过，不伪造引用）。
async function resolvePropPlacementImageAsset({ dir, asset, projectAssets, sceneId }) {
  const assetId = String(asset?.id || '').trim()
  const assets = Array.isArray(projectAssets) ? projectAssets : []
  const hasAsset = (aid) => Boolean(aid) && assets.some((a) => String(a && a.id || '').trim() === aid)

  // 2026-09-30 状态变体优先：当前场景命中该资产的状态需求（stateRequirements[].sceneIds）
  // 且对应 stateKey 已生成变体图时，摆位用变体而非主参考——乌鸦喝水「瓶水位低→渐升→满」
  // 这类剧情状态由此上场（此前变体生成了却永远不上画布，全场景一张主参考图）。
  const sid = String(sceneId || '').trim()
  if (sid) {
    const reqs = Array.isArray(asset?.stateRequirements) ? asset.stateRequirements : []
    const hitReq = reqs.find((r) => Array.isArray(r?.sceneIds) && r.sceneIds.map((x) => String(x || '').trim()).includes(sid)) || null
    if (hitReq) {
      const stateKey = String(hitReq.stateKey || '').trim()
      const variant = (Array.isArray(asset?.stateVariants) ? asset.stateVariants : [])
        .find((v) => String(v?.stateKey || '').trim() === stateKey && (String(v?.projectAssetId || '').trim() || String(v?.projectAssetUri || '').trim())) || null
      if (variant) {
        const variantAssetId = String(variant.projectAssetId || '').trim()
        if (hasAsset(variantAssetId)) return { imageAssetId: variantAssetId, viaStateKey: stateKey }
        const vUri = String(variant.projectAssetUri || '').trim().replace(/^\/+/, '')
        const byUri = vUri ? assets.find((a) => String(a && a.uri || '').trim().replace(/^\/+/, '') === vUri) : null
        if (byUri) return { imageAssetId: String(byUri.id || '').trim(), viaStateKey: stateKey }
      }
    }
  }

  const uri = String(asset?.primaryReferenceAssetUri || '').trim().replace(/^\/+/, '')
  const primaryId = String(asset?.primaryReferenceAssetId || '').trim()
  if (hasAsset(primaryId)) return { imageAssetId: primaryId }
  if (uri) {
    const byUri = assets.find((a) => String(a && a.uri || '').trim().replace(/^\/+/, '') === uri)
    if (byUri) return { imageAssetId: String(byUri.id || '').trim(), patchedPrimaryId: primaryId ? '' : String(byUri.id || '').trim() }
  }
  const refs = Array.isArray(asset?.generatedRefs) ? asset.generatedRefs : []
  const refHit = refs.find((r) => String(r && r.projectAssetUri || '').trim().replace(/^\/+/, '') === uri && hasAsset(String(r && r.projectAssetId || '').trim()))
  if (refHit) return { imageAssetId: String(refHit.projectAssetId || '').trim(), patchedPrimaryId: primaryId ? '' : String(refHit.projectAssetId || '').trim() }
  if (!uri) return null
  const fileGate = await verifyStoryAssetReferenceFile({ dir, assetPath: uri })
  if (!fileGate.ok) return null
  const created = { id: genId('asset'), kind: 'image', name: `故事资产立绘 ${String(asset?.name || assetId).trim()}`, uri, source: { type: 'ai', via: 'placements_prop_registration' } }
  return { imageAssetId: created.id, createdAsset: created, patchedPrimaryId: created.id }
}

app.post('/api/projects/:id/ai/story/scenes/placements', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const traceId = createTraceId()

  const body = await c.req.json().catch(() => ({}))
  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)
  const bundle = await readProjectBundle(id)
  const story = bundle.story && typeof bundle.story === 'object' ? bundle.story : null
  const storyNodes = Array.isArray(story?.nodes) ? story.nodes : []
  if (!story || !storyNodes.length) return c.json({ success: false, error: 'missing_story', message: '未找到故事文档，无法写入立绘站位。' }, 400)

  // 目标场景：默认计划内全部场景（按 sceneIndex 排序），body.sceneIds 可指定子集
  const planScenes = Array.isArray(plan.scenes) ? plan.scenes : []
  const planSceneIds = new Set(planScenes.map((s) => String(s && s.sceneId || '').trim()).filter(Boolean))
  let targetSceneIds
  if (Array.isArray(body?.sceneIds) && body.sceneIds.length) {
    targetSceneIds = [...new Set(body.sceneIds.map((x) => String(x || '').trim()).filter(Boolean))]
    const unknown = targetSceneIds.filter((sid) => !planSceneIds.has(sid))
    if (unknown.length) return c.json({ success: false, error: 'scene_not_found', message: `计划中不存在场景：${unknown.join('、')}` }, 404)
  } else {
    targetSceneIds = planScenes
      .slice()
      .sort((a, b) => (Number(a && a.sceneIndex) || 0) - (Number(b && b.sceneIndex) || 0))
      .map((s) => String(s && s.sceneId || '').trim())
      .filter(Boolean)
  }

  const planAssets = Array.isArray(plan.assets) ? plan.assets : []
  const characterAssets = planAssets.filter((a) => String(a && a.category || '').trim() === 'character')
  const propAssets = planAssets.filter((a) => String(a && a.category || '').trim() === 'prop')
  const assetSceneIds = (asset) => (Array.isArray(asset?.sceneIds) ? asset.sceneIds : []).map((x) => String(x || '').trim())
  // sceneId→story.json 节点映射：sceneId 即故事节点 id（编译产物约定，与场景渲染回填同源）
  const nodeById = new Map(storyNodes.map((n) => [String(n && n.id || '').trim(), n]))

  // 2026-10-04 构图规格驱动：plan.scenes[].composition（AI 提取+审核的摆放需求单）存在时，
  // 新建摆位按需求单（x/y/scale/zIndex/flipH/stateKey）执行，不再纯默认值兜底；
  // body.applyComposition=true 时既有自动摆位也按需求单刷新（人工编辑器拖动的摆位不在此接口覆盖范围）。
  const compositionByScene = new Map()
  for (const s of planScenes) {
    const comp = s && s.composition && typeof s.composition === 'object' ? s.composition : null
    const items = Array.isArray(comp && comp.items) ? comp.items : []
    if (!items.length) continue
    compositionByScene.set(String(s && s.sceneId || '').trim(), new Map(items.map((it) => [String(it && it.subjectId || '').trim(), it])))
  }
  const applyComposition = body?.applyComposition === true
  const compTransformFor = (sceneId, subjectId) => {
    const item = compositionByScene.get(String(sceneId || '').trim())?.get(String(subjectId || '').trim()) || null
    if (!item) return null
    return {
      transform: {
        x: Math.max(0, Math.min(1, Number(item.x) || 0.5)),
        y: Math.max(0, Math.min(1, Number(item.y) || 0.9)),
        scale: Math.max(0.1, Math.min(2.5, Number(item.scale) || 1)),
        rotationDeg: 0,
        ...(item.flipH === true ? { flipX: true } : {})
      },
      zIndex: Math.max(1, Math.min(99, Math.round(Number(item.zIndex) || 3))),
      stateKey: String(item.stateKey || '').trim()
    }
  }

  logStage({ stage: 'story.scenes.placements', event: 'start', traceId, project: id, item: `scenes:${targetSceneIds.length}` })

  try {
    const characters = (Array.isArray(bundle.rawProject?.characters) ? bundle.rawProject.characters : []).map((ch) => ({ ...ch }))
    let charactersChanged = false
    const projectAssets = (Array.isArray(bundle.rawProject?.assets) ? bundle.rawProject.assets : []).map((a) => ({ ...a }))
    let projectAssetsChanged = false
    const characterIdPatches = new Map() // planAssetId → projectCharacterId（新建/补链时写回计划）
    const propAssetIdPatches = new Map() // planAssetId → primaryReferenceAssetId（补登记项目资产时写回计划）
    const storyPatches = new Map() // nodeId → placements 数组
    const sceneReports = []
    const skippedCharacters = []
    const skippedProps = []
    let placementsCreated = 0
    let placementsUpdated = 0
    let charactersCreated = 0
    let charactersUpdated = 0
    let propsPlaced = 0

    for (const sceneId of targetSceneIds) {
      const node = nodeById.get(sceneId)
      if (!node) {
        sceneReports.push({ sceneId, ok: false, reason: 'story_node_not_found' })
        continue
      }
      // prop 分层合成（2026-09-27 F6）：已锁定（referenceStatus=ready 且有主参考）prop 生成确定性默认摆位；
      // 未锁定或引用不可解析（文件缺失/无法登记项目资产）仍跳过并如实进 skippedProps。
      const placeableProps = []
      for (const prop of propAssets.filter((a) => assetSceneIds(a).includes(sceneId))) {
        const assetId = String(prop.id || '').trim()
        const assetName = String(prop.name || assetId).trim()
        const locked = String(prop.referenceStatus || '').trim() === 'ready' && Boolean(String(prop.primaryReferenceAssetUri || '').trim())
        if (!locked) {
          skippedProps.push({ sceneId, assetId, name: assetName, reason: 'prop_reference_missing' })
          continue
        }
        const resolved = await resolvePropPlacementImageAsset({ dir, asset: prop, projectAssets, sceneId })
        if (!resolved) {
          skippedProps.push({ sceneId, assetId, name: assetName, reason: 'prop_reference_missing' })
          continue
        }
        if (resolved.createdAsset) {
          projectAssets.push(resolved.createdAsset)
          projectAssetsChanged = true
        }
        if (resolved.patchedPrimaryId) propAssetIdPatches.set(assetId, resolved.patchedPrimaryId)
        placeableProps.push({ assetId, name: assetName, imageAssetId: resolved.imageAssetId, associatedIds: associatedPropProjectAssetIds(prop), asset: prop })
      }

      const present = characterAssets.filter((a) => assetSceneIds(a).includes(sceneId))
      const placeable = []
      for (const asset of present) {
        const assetId = String(asset.id || '').trim()
        const assetName = String(asset.name || assetId).trim()
        let character = findProjectCharacterForStoryAsset(characters, asset)
        // 立绘 asset id 来源：select 后计划资产的 primaryReferenceAssetId → 角色 ai.referenceAssetId → 角色 imageAssetId
        // 角色主档写回（创建/回填）始终用主参考 id，姿势变体只影响本场景摆位
        const baseImageAssetId =
          String(asset.primaryReferenceAssetId || '').trim() ||
          String(character?.ai?.referenceAssetId || '').trim() ||
          String(character?.imageAssetId || '').trim()
        // 2026-09-30 剧情姿势上场：该场景已生成姿势/状态变体（poseVariants 或 stateVariants 的
        // sceneId/sceneIds 命中）时，本场景摆位用变体图而非主参考——口渴/衔石/喝水随情节表达。
        const variantPool = [
          ...(Array.isArray(asset.poseVariants) ? asset.poseVariants : []),
          ...(Array.isArray(asset.stateVariants) ? asset.stateVariants : [])
        ]
        const poseHit = variantPool
          .filter((v) => {
            if (!String(v?.projectAssetId || '').trim()) return false
            const one = String(v?.sceneId || '').trim()
            if (one && one === sceneId) return true
            const many = Array.isArray(v?.sceneIds) ? v.sceneIds.map((x) => String(x || '').trim()) : []
            return many.includes(sceneId)
          })
          .pop()
        // 2026-10-04 构图 stateKey 优先：需求单指定本场景状态（如 pushing/crushed）时按状态键选变体，
        // 不再仅靠 sceneIds 命中——同一角色多状态在同场景区的正确性由构图规格保证
        const comp = compTransformFor(sceneId, assetId)
        const compStateHit = comp && comp.stateKey
          ? variantPool.find((v) => String(v?.stateKey || '').trim() === comp.stateKey && String(v?.projectAssetId || '').trim()) || null
          : null
        // 2026-10-06 简谱演绎·表情差分：无场景姿势变体时，按本场景剧情表情（poseRequirements[].expression）
        // 匹配命名约定「表情·{expression}」的表情差分变体——立绘情绪随场景切换，零全身姿势重绘成本
        let expressionHit = null
        if (!compStateHit && !poseHit) {
          const reqs = Array.isArray(asset.poseRequirements) ? asset.poseRequirements : []
          const sceneReq = reqs.find((r) => String(r?.sceneId || '').trim() === sceneId)
          const expr = String(sceneReq?.expression || '').trim()
          if (expr) {
            expressionHit = variantPool.find((v) => {
              if (!String(v?.projectAssetId || '').trim()) return false
              const nm = String(v?.name || '').trim()
              return nm === `表情·${expr}` || nm === `表情:${expr}` || nm === expr
            }) || null
          }
        }
        const imageAssetId = compStateHit
          ? String(compStateHit.projectAssetId || '').trim()
          : (poseHit ? String(poseHit.projectAssetId || '').trim()
            : (expressionHit ? String(expressionHit.projectAssetId || '').trim() : baseImageAssetId))
        if (!imageAssetId) {
          skippedCharacters.push({ sceneId, assetId, name: assetName, reason: 'reference_not_locked' })
          continue
        }
        if (!character) {
          // 项目缺少该角色条目：按真实计划数据补建最小角色记录，并回写计划链接
          // 2026-08-30 修复：同步补 ai.referenceAssetId——体检的连续性绑定检查依赖它（缺了会报"缺少角色参考图"）
          character = { id: genId('char'), name: assetName, imageAssetId: baseImageAssetId, ai: { referenceAssetId: baseImageAssetId } }
          characters.push(character)
          charactersChanged = true
          charactersCreated += 1
        } else {
          const needsImage = String(character.imageAssetId || '').trim() !== baseImageAssetId
          // 2026-08-30 修复：referenceAssetId 缺失时回填（锁定在角色建立前完成时，select 的写回找不到角色条目）
          const needsRef = !String((character.ai && character.ai.referenceAssetId) || '').trim()
          if (needsImage || needsRef) {
            const idx = characters.findIndex((ch) => String(ch && ch.id || '').trim() === String(character.id || '').trim())
            if (idx >= 0) {
              characters[idx] = {
                ...characters[idx],
                ...(needsImage ? { imageAssetId: baseImageAssetId } : {}),
                ai: {
                  ...((characters[idx].ai && typeof characters[idx].ai === 'object') ? characters[idx].ai : {}),
                  referenceAssetId: baseImageAssetId
                }
              }
              character = characters[idx]
              charactersChanged = true
              charactersUpdated += 1
            }
          }
        }
        if (!String(asset.projectCharacterId || '').trim()) characterIdPatches.set(assetId, String(character.id || '').trim())
        placeable.push({ assetId, name: assetName, characterId: String(character.id || '').trim(), imageAssetId })
      }

      if (placeable.length || placeableProps.length) {
        const existing = Array.isArray(node.visuals?.placements) ? node.visuals.placements : []
        const nextPlacements = existing.map((p) => ({ ...p }))
        placeable.forEach((entry, index) => {
          const comp = compTransformFor(sceneId, entry.assetId)
          const existingIdx = nextPlacements.findIndex((p) => String(p && p.characterId || '').trim() === entry.characterId)
          if (existingIdx >= 0) {
            // 幂等/人工站位保护：保留既有 transform/zIndex/visible，仅刷新立绘引用；
            // applyComposition=true 时按构图需求单刷新 transform/zIndex（人工编辑器摆位不走本接口）
            const refresh = applyComposition && comp ? { transform: comp.transform, zIndex: comp.zIndex } : {}
            nextPlacements[existingIdx] = { ...nextPlacements[existingIdx], characterId: entry.characterId, imageAssetId: entry.imageAssetId, ...refresh }
            placementsUpdated += 1
          } else {
            const planAsset = planAssets.find((a) => String(a && a.id || '').trim() === entry.assetId)
            nextPlacements.push({
              characterId: entry.characterId,
              imageAssetId: entry.imageAssetId,
              transform: comp ? comp.transform : { x: defaultPlacementX(index, placeable.length), y: 1, scale: defaultPlacementScale(planAsset), rotationDeg: 0 },
              zIndex: comp ? comp.zIndex : index + 1,
              visible: true
            })
            placementsCreated += 1
          }
        })

        // prop 摆位写入（characterId 置空 + imageAssetId + propAssetId 链接，与编辑器手工拖入的道具摆位同构；
        // 编辑器预览与 storyPixi 导出均按 p.imageAssetId || ch.imageAssetId 解析，运行态无需扩展）
        if (placeableProps.length) {
          const isEndingScene = String(node.kind || '').trim() === 'ending'
          const characterXs = nextPlacements
            .filter((p) => String(p && p.characterId || '').trim())
            .map((p) => Number(p && p.transform && p.transform.x))
            .filter((x) => Number.isFinite(x))
          // 已摆道具（含人工摆位）信号池：供 fish_near_bucket 确定性找桶
          const placedPropSignals = []
          for (const p of nextPlacements) {
            if (String(p && p.characterId || '').trim()) continue
            const img = String(p && p.imageAssetId || '').trim()
            const pa = projectAssets.find((a) => String(a && a.id || '').trim() === img)
            const signal = [pa && pa.name, pa && pa.uri].map((x) => String(x || '')).join(' ')
            if (signal.trim()) placedPropSignals.push({ signal, transform: (p && p.transform && typeof p.transform === 'object') ? p.transform : {} })
          }
          // 结局场景的鱼最后放，保证桶位姿已确定
          const orderedProps = placeableProps.slice().sort((a, b) => {
            const pa = propPlacementProfile(a.asset, { isEndingScene }) === 'fish_near_bucket' ? 1 : 0
            const pb = propPlacementProfile(b.asset, { isEndingScene }) === 'fish_near_bucket' ? 1 : 0
            return pa - pb
          })
          let propIndex = 0
          for (const entry of orderedProps) {
            const existingIdx = nextPlacements.findIndex((p) => {
              if (!p || typeof p !== 'object') return false
              if (String(p.propAssetId || '').trim() && String(p.propAssetId || '').trim() === entry.assetId) return true
              if (String(p.characterId || '').trim()) return false
              const img = String(p.imageAssetId || '').trim()
              if (img && entry.associatedIds.has(img)) return true
              // 人工摆位归队：摆位图片资产 uri 含计划资产 id 路径段（如 /prop.tool_bag/），确定性子串匹配
              const pa = projectAssets.find((a) => String(a && a.id || '').trim() === img)
              const puri = String(pa && pa.uri || '').trim()
              return Boolean(puri && entry.assetId && puri.includes(`/${entry.assetId}/`))
            })
            if (existingIdx >= 0) {
              // 幂等/人工站位保护：保留既有 transform/zIndex/visible，仅刷新立绘引用与 propAssetId 链接；
              // applyComposition=true 时按构图需求单刷新 transform/zIndex
              const comp = compTransformFor(sceneId, entry.assetId)
              const refresh = applyComposition && comp ? { transform: comp.transform, zIndex: comp.zIndex } : {}
              nextPlacements[existingIdx] = { ...nextPlacements[existingIdx], characterId: '', propAssetId: entry.assetId, imageAssetId: entry.imageAssetId, ...refresh }
              placedPropSignals.push({ signal: propAssetSignalText(entry.asset), transform: (nextPlacements[existingIdx].transform && typeof nextPlacements[existingIdx].transform === 'object') ? nextPlacements[existingIdx].transform : {} })
              placementsUpdated += 1
              continue
            }
            let profile = propPlacementProfile(entry.asset, { isEndingScene })
            let bucketTransform = null
            if (profile === 'fish_near_bucket') {
              const hit = placedPropSignals.find((x) => BUCKET_PROP_PATTERN.test(x.signal))
              if (hit) bucketTransform = hit.transform
              else profile = 'ground' // 找不到桶：退化为地面道具默认位
            }
            // 2026-10-04 构图规格优先：需求单指定了道具位置/大小/前后关系时按需求单摆放
            const comp = compTransformFor(sceneId, entry.assetId)
            const transform = comp ? comp.transform : propPlacementTransform({ profile, index: propIndex, characterXs, bucketTransform })
            const zBase = nextPlacements.reduce((acc, p) => Math.max(acc, Number(p && p.zIndex) || 0), 0)
            nextPlacements.push({
              id: `pl_${sceneId}_${entry.assetId}`,
              characterId: '',
              propAssetId: entry.assetId,
              imageAssetId: entry.imageAssetId,
              transform,
              zIndex: comp ? comp.zIndex : zBase + 1,
              visible: true
            })
            placedPropSignals.push({ signal: propAssetSignalText(entry.asset), transform })
            propIndex += 1
            placementsCreated += 1
            propsPlaced += 1
          }
        }
        storyPatches.set(sceneId, nextPlacements)
      }
      sceneReports.push({
        sceneId,
        ok: true,
        characters: placeable,
        props: placeableProps.map((x) => ({ assetId: x.assetId, name: x.name, imageAssetId: x.imageAssetId })),
        placementsTotal: (storyPatches.get(sceneId) || (Array.isArray(node.visuals?.placements) ? node.visuals.placements : [])).length
      })
    }

    const nextStory = {
      ...story,
      nodes: storyNodes.map((node) => {
        const patch = storyPatches.get(String(node && node.id || '').trim())
        if (!patch) return node
        const visuals = node.visuals && typeof node.visuals === 'object' ? node.visuals : {}
        return { ...node, visuals: { ...visuals, placements: patch } }
      })
    }
    await writeJson(path.join(dir, 'story.json'), nextStory)

    if (charactersChanged || projectAssetsChanged) {
      const nextProject = {
        ...bundle.rawProject,
        characters,
        ...(projectAssetsChanged ? { assets: projectAssets } : {}),
        updatedAt: new Date().toISOString()
      }
      await writeJson(path.join(dir, 'project.json'), nextProject)
    }

    if (characterIdPatches.size || propAssetIdPatches.size) {
      const nextPlan = {
        ...plan,
        generatedAt: new Date().toISOString(),
        assets: planAssets.map((a) => {
          const aid = String(a && a.id || '').trim()
          const patchedChar = characterIdPatches.get(aid)
          const patchedPropRef = propAssetIdPatches.get(aid)
          let next = patchedChar ? { ...a, projectCharacterId: patchedChar } : a
          if (patchedPropRef) next = { ...next, primaryReferenceAssetId: patchedPropRef }
          return next
        })
      }
      nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
      await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
    }

    const summary = {
      scenes: targetSceneIds.length,
      placementsCreated,
      placementsUpdated,
      charactersCreated,
      charactersUpdated,
      propsPlaced,
      skippedCharacters: skippedCharacters.length,
      skippedProps: skippedProps.length
    }
    logStage({ stage: 'story.scenes.placements', event: 'ok', traceId, project: id, item: `scenes:${targetSceneIds.length} / created:${placementsCreated} / updated:${placementsUpdated} / skipped:${skippedCharacters.length}` })
    recordCreationEvent(dir, {
      type: 'placements_updated',
      summary: `立绘站位更新：${targetSceneIds.length} 场景，新增 ${placementsCreated} / 更新 ${placementsUpdated}`,
      actor: 'placements_flow',
      data: { scenes: targetSceneIds.length, placementsCreated, placementsUpdated }
    })
    return c.json({ success: true, summary, scenes: sceneReports, skippedCharacters, skippedProps })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const mapped = classifyAiError(e)
    logStage({ stage: 'story.scenes.placements', event: 'fail', traceId, project: id, item: msg })
    return c.json({ success: false, error: mapped.code, message: msg }, mapped.httpStatus)
  }
})

// ---------------------------------------------------------------------------
// 2026-10-10 姿势变体自动编排（asset.poseVariants.autoGenerate，GS-51；自动化②落地）：
// 提取剧情姿势需求（storyPoseStates LLM）→ 按（角色×姿势）分组 → 匹配公共姿势库骨架
// → 骨架驱动生成变体（generateComfyuiPoseVariantSprite）→ layered-produce 登记绑场景。
// 全程 aiTask 进度 + logStage；站立类不出变体；无骨架匹配记 unmatched（姿势库扩展线索）。
// 幂等：同名「自动·<poseKey>」变体已存在则跳过。审图留痕 lock_confirm decidedBy=auto-pose。
// ---------------------------------------------------------------------------
app.post('/api/projects/:id/ai/story/pose-variants/auto', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.prompt) return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)

  const bundle = await readProjectBundle(id)
  const storyBible = readStoryBibleFromProjectDoc(bundle.project)
  if (!storyBible || typeof storyBible !== 'object') return c.json({ success: false, error: 'missing_story_bible', message: '请先生成 Story Bible。' }, 400)
  const plan = await readStoryAssetPlanIfExists(id)
  if (!plan) return c.json({ success: false, error: 'missing_plan', message: '请先生成资产计划。' }, 400)

  const body = await c.req.json().catch(() => ({}))
  const traceId = createTraceId()
  const task = createAiTask(id, 'story.pose_variants.auto', { total: 1, message: '姿势需求提取中…' })
  logStage({ stage: 'story.pose_variants.auto', event: 'start', traceId, project: id })

  ;(async () => {
    const errors = []
    const generated = []
    try {
      // 1) LLM 提取逐场景姿势需求
      const input = buildPoseStateExtractionInput({ project: bundle.project, story: bundle.story, storyBible })
      if (!input.scenes.length) throw new Error('no_scenes_with_characters')
      const { result: poseStates } = await extractStoryPoseStates({
        provider: studio.effective.prompt.provider,
        model: studio.effective.prompt.model,
        apiUrl: studio.effective.prompt.apiUrl,
        proxyUrl: studio.effective.network.proxyUrl,
        timeoutMs: clampInt(body?.timeoutMs, 60_000, 600_000, 300_000),
        input
      })

      // 2) 分组 + 骨架匹配
      const { libDir, poses } = await loadPoseLibraryManifest(ROOT)
      if (!Object.keys(poses).length) throw new Error('pose_library_manifest_missing')
      const { groups, unmatched } = groupPoseRequirements(poseStates, poses)
      updateAiTask(task.taskId, { total: groups.length, stage: 'generating', message: `姿势需求 ${groups.length} 组（未匹配 ${unmatched.length}），开始生成变体` })
      logStage({ stage: 'story.pose_variants.auto', event: 'extracted', traceId, project: id, item: `groups:${groups.length} unmatched:${unmatched.length}` })

      const bibleNameByCharId = new Map((Array.isArray(storyBible.characters) ? storyBible.characters : []).map((x) => [String(x && x.id || '').trim(), String(x && x.name || '').trim()]))
      const normKey = (s) => asStr(s).trim().toLowerCase().replace(/[\s《》「」]/g, '')
      const planAssets = Array.isArray(plan.assets) ? plan.assets : []
      const findPlanCharacter = (characterId) => {
        const name = bibleNameByCharId.get(characterId) || ''
        return planAssets.find((a) => String(a?.category || '') === 'character' && (String(a?.id || '').trim() === characterId || (name && normKey(a?.name) === normKey(name)))) || null
      }

      const globalStyleEn = String(plan.worldAnchor || '').trim()
      let cursor = 0
      for (const group of groups) {
        cursor += 1
        const asset = findPlanCharacter(group.characterId)
        const label = `${asset ? asset.name : group.characterId}·${group.poseKey}`
        if (!asset) { errors.push({ group: label, error: 'character_not_in_plan' }); continue }
        const lockName = `自动·${group.poseKey}`
        if (asList(asset.poseVariants).some((v) => String(v?.name || '').trim() === lockName)) {
          updateAiTask(task.taskId, { current: cursor, message: `已存在跳过：${label}` })
          continue
        }
        const identityRel = asStr(asset.primaryReferenceAssetUri).trim()
        const identityAbs = identityRel ? path.resolve(dir, identityRel) : ''
        if (!identityAbs || !identityAbs.startsWith(path.resolve(dir) + path.sep) || !(await existsFile(identityAbs))) {
          errors.push({ group: label, error: 'identity_reference_missing' })
          updateAiTask(task.taskId, { current: cursor, message: `缺主参考跳过：${label}` })
          continue
        }
        const poseDef = poses[group.poseKey]
        try {
          updateAiTask(task.taskId, { stage: 'generating', current: cursor - 1, message: `生成姿势变体：${label}（${group.sceneIds.length} 场景）` })
          const identityBytes = await readFile(identityAbs)
          const prompt = buildPoseVariantPrompt({ asset, poseDef, group, globalStyleEn })
          const animalBoost = isAnimalLikeAnchor(`${prompt} ${asStr(asset.name)}`)
          const gen = await generatePoseVariantForGroup({
            root: ROOT,
            libDir,
            poseDef,
            identityBytes,
            identityFilename: path.basename(identityAbs),
            prompt,
            comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
            timeoutMs: 300_000,
            prefix: `gamestudio_pose/auto_${String(asset.id).replace(/[^a-z0-9_-]/gi, '_')}`,
            ipadapterWeight: animalBoost ? 0.95 : 0.85
          })
          // 产物落项目资产目录 → layered-produce 正式链登记（抠图/审核留痕/场景绑定）
          const outRel = `assets/ai/story_assets/character/${String(asset.id).replace(/[^a-z0-9_-]/gi, '_')}/pose_auto_${group.poseKey}_${Date.now()}.png`
          const outAbs = path.resolve(dir, outRel)
          await mkdir(path.dirname(outAbs), { recursive: true })
          await writeFile(outAbs, gen.bytes)
          const resp = await app.request(`/api/projects/${encodeURIComponent(id)}/ai/story/scenes/${encodeURIComponent(group.sceneIds[0])}/layered-produce`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-image-review-mode': 'off' },
            body: JSON.stringify({
              poses: [{
                lockName,
                planAssetId: String(asset.id).trim(),
                characterId: String(asset.id).trim(),
                spriteAssetPath: outRel,
                posePrompt: prompt,
                promptZh: `${asStr(group.action).trim()} ${asStr(group.expression).trim()}`.trim(),
                sceneIds: group.sceneIds
              }]
            })
          })
          const json = await resp.json().catch(() => ({}))
          const okEntry = Array.isArray(json?.poses) && json.poses[0] && json.poses[0].projectAssetId
          if (!resp.ok || !okEntry) throw new Error(`register_failed:${String(json?.poses?.[0]?.error || json?.error || resp.status)}`)
          generated.push({ group: label, poseKey: group.poseKey, scenes: group.sceneIds.length, projectAssetId: json.poses[0].projectAssetId })
          updateAiTask(task.taskId, { current: cursor, message: `完成：${label}` })
          logStage({ stage: 'story.pose_variants.auto', event: 'generated', traceId, project: id, item: label })
        } catch (e) {
          const msg = e && e.message ? String(e.message) : String(e)
          errors.push({ group: label, error: msg.slice(0, 200) })
          updateAiTask(task.taskId, { current: cursor, message: `失败：${label}（${msg.slice(0, 60)}）` })
          logStage({ stage: 'story.pose_variants.auto', event: 'fail', traceId, project: id, item: `${label} / ${msg.slice(0, 160)}` })
        }
      }
      updateAiTask(task.taskId, {
        stage: 'done',
        done: true,
        current: groups.length,
        message: `姿势变体编排完成：生成 ${generated.length}，失败 ${errors.length}，未匹配骨架 ${unmatched.length}`,
        result: { generated, errors, unmatched }
      })
      logStage({ stage: 'story.pose_variants.auto', event: 'done', traceId, project: id, item: `generated:${generated.length} failed:${errors.length} unmatched:${unmatched.length}` })
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      console.error('[story.pose_variants.auto]', e && e.stack ? e.stack : msg)
      updateAiTask(task.taskId, { stage: 'error', done: true, error: msg, message: `姿势变体编排失败：${msg}` })
      logStage({ stage: 'story.pose_variants.auto', event: 'error', traceId, project: id, item: msg.slice(0, 300) })
    }
  })()

  return c.json({ success: true, taskId: task.taskId, message: '姿势变体自动编排已启动，进度见 /ai/tasks' }, 202)
})

// ---------------------------------------------------------------------------
// 场景分层出图编排（asset.scene.layeredProduce，2026-09-08 新增）：
// 单场景「背景-only 重画 + 姿势变体生成/复用 + 道具精灵 + 分层摆位写入」串行编排，
// 供 control 事件链与控制台触发。全程经 /ai/tasks 暴露进度（createAiTask/updateAiTask，禁止黑盒）；
// 生成动作经 app.request 内部转发既有端点（sprite/pose-review/cutout/render/bind，
// 参考 makeSceneBatchRunner 的既有用法），统一带 x-image-review-mode: off（control 已有步骤级审核）；
// 产物登记后补写 lock_confirm approved 审核留痕（decidedBy=control，与 select 链路同源写法）。
// 任一步失败记 errors 并继续后续独立步骤，全部失败才 success:false。
// ---------------------------------------------------------------------------
app.post('/api/projects/:id/ai/story/scenes/:sceneId/layered-produce', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const sceneId = String(c.req.param('sceneId') || '').trim()
  if (!sceneId) return c.json({ success: false, error: 'missing_scene_id', message: 'sceneId 不能为空' }, 400)

  // body 内联字段优先；specPath 规格文件（JSON，同结构，notes 等额外字段忽略）作为缺省补充。
  // specPath 必须解析在项目目录内（防越界，与 verifyStoryAssetReferenceFile 同款路径守卫）。
  const body = await c.req.json().catch(() => ({}))
  let spec = {}
  const specPath = String(body?.specPath || '').trim().replace(/^\/+/, '')
  if (specPath) {
    const rootAbs = path.resolve(dir)
    const specAbs = path.resolve(rootAbs, specPath)
    if (specAbs !== rootAbs && !specAbs.startsWith(rootAbs + path.sep)) {
      return c.json({ success: false, error: 'spec_path_outside_project', message: `specPath 越出项目目录，已拒绝：${specPath}` }, 400)
    }
    if (!(await existsFile(specAbs))) {
      return c.json({ success: false, error: 'spec_not_found', message: `规格文件不存在：${specPath}` }, 404)
    }
    try {
      const parsed = JSON.parse(await readFile(specAbs, 'utf-8'))
      spec = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (_) {
      return c.json({ success: false, error: 'spec_invalid_json', message: `规格文件不是有效 JSON：${specPath}` }, 400)
    }
  }
  const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
  const background = asObj(body?.background) || asObj(spec?.background)
  const poses = Array.isArray(body?.poses) ? body.poses : (Array.isArray(spec?.poses) ? spec.poses : [])
  const propSprites = Array.isArray(body?.propSprites) ? body.propSprites : (Array.isArray(spec?.propSprites) ? spec.propSprites : [])
  const placements = Array.isArray(body?.placements) ? body.placements : (Array.isArray(spec?.placements) ? spec.placements : [])
  if (!background && !poses.length && !propSprites.length && !placements.length) {
    return c.json({ success: false, error: 'empty_request', message: 'background/poses/propSprites/placements 至少提供一项' }, 400)
  }

  // 场景存在性前置校验（story.json 节点），保证非法 sceneId 得到干净 4xx 而非 500
  const story = await readJson(path.join(dir, 'story.json')).catch(() => null)
  const storyNodes = Array.isArray(story?.nodes) ? story.nodes : []
  const sceneNode = storyNodes.find((n) => String(n && n.id || '').trim() === sceneId) || null
  if (!sceneNode) return c.json({ success: false, error: 'scene_not_found', message: `未找到场景：${sceneId}` }, 404)
  const sceneName = String(sceneNode.name || sceneId).trim()

  const plan = await readStoryAssetPlanIfExists(id)
  const planAssets = plan && Array.isArray(plan.assets) ? plan.assets : []
  const findPlanAsset = (assetId) => planAssets.find((a) => String(a && a.id || '').trim() === String(assetId || '').trim()) || null

  // 编排总任务：每步串行推进并 updateAiTask，进度经 /api/projects/:id/ai/tasks 可见
  const total = poses.length + propSprites.length + (background ? 1 : 0) + (placements.length ? 1 : 0)
  const task = createAiTask(id, 'story.scene.layered_produce', { total, message: `分层出图编排：${sceneName}` })
  const traceId = createTraceId()
  logStage({ stage: 'story.scene.layered_produce', event: 'start', traceId, project: id, item: `${sceneId} / poses:${poses.length} / props:${propSprites.length} / bg:${background ? 1 : 0} / placements:${placements.length}` })

  const internalHeaders = { 'Content-Type': 'application/json', 'x-image-review-mode': 'off' }
  const postInternal = async (urlPath, payload) => {
    const resp = await app.request(urlPath, { method: 'POST', headers: internalHeaders, body: JSON.stringify(payload || {}) })
    const json = await resp.json().catch(() => ({}))
    if (!resp.ok || !json || json.success !== true) {
      const err = new Error(String((json && (json.message || json.error)) || `http_${resp.status}`))
      err.code = String((json && json.error) || `http_${resp.status}`)
      throw err
    }
    return json
  }
  const readProjectAssets = async () => {
    const proj = await readJson(path.join(dir, 'project.json')).catch(() => null)
    return Array.isArray(proj?.assets) ? proj.assets : []
  }
  // 产物登记：project.json assets 追加（每次读最新盘再写回，避免覆盖编排期间的其他写入）
  const appendProjectAsset = async (asset) => {
    const proj = await readJson(path.join(dir, 'project.json'))
    const next = {
      ...proj,
      assets: [...(Array.isArray(proj?.assets) ? proj.assets : []), asset],
      updatedAt: nowIso(),
      _rev: Number(proj?._rev || 0) + 1
    }
    await writeJson(path.join(dir, 'project.json'), next)
  }
  // lock_confirm 审核留痕（approved / decidedBy=control）；留痕失败不阻断登记结果
  const traceLockConfirm = async ({ planAssetId, resultImagePath, prompt }) => {
    try {
      const targetKey = `lock_confirm:${planAssetId}:${resultImagePath}`
      const pending = await findPendingReview(dir, { phase: 'lock_confirm', targetKey })
      if (pending) {
        await decideImageReview(dir, pending.reviewId, { approved: true, decidedBy: 'control' })
      } else {
        const record = await createImageReview(dir, {
          phase: 'lock_confirm',
          targetKey,
          assetId: planAssetId,
          resultImagePath,
          prompt: String(prompt || '')
        })
        await decideImageReview(dir, record.reviewId, { approved: true, decidedBy: 'control' })
      }
    } catch (_) { /* 留痕失败不阻断登记结果 */ }
  }

  const POSE_GLOBAL_PROMPT = 'cartoon fairy tale picture book style, flat 2D illustration, bold clean outlines, cel shading, warm soft color palette'
  const poseResults = []
  const propResults = []
  const errors = []
  let backgroundResult = null
  let placementsWritten = 0
  let cursor = 0

  // 1) 姿势变体：reuseAssetId 复用跳过生成；否则 sprite → pose-review（可选，失败记 reviewUnavailable）→ cutout → 登记 → 留痕
  for (const poseRaw of poses) {
    const pose = asObj(poseRaw) || {}
    const lockName = String(pose.lockName || '').trim()
    const planAssetId = String(pose.planAssetId || '').trim()
    const characterId = String(pose.characterId || '').trim()
    const reuseAssetId = String(pose.reuseAssetId || '').trim()
    const posePrompt = String(pose.posePrompt || '').trim()
    cursor += 1
    const label = lockName || planAssetId || characterId || `pose_${cursor}`
    try {
      if (reuseAssetId) {
        updateAiTask(task.taskId, { stage: 'pose_reuse', current: cursor - 1, message: `复用姿势资产：${label}` })
        if (!(await readProjectAssets()).some((a) => String(a && a.id || '').trim() === reuseAssetId)) {
          const err = new Error(`复用资产不存在于 project.json assets：${reuseAssetId}`)
          err.code = 'reuse_asset_not_found'
          throw err
        }
        poseResults.push({ lockName, planAssetId, projectAssetId: reuseAssetId, reused: true })
        updateAiTask(task.taskId, { current: cursor, message: `姿势完成（复用）：${label}` })
        continue
      }
      const planAsset = findPlanAsset(planAssetId)
      if (!planAsset) {
        const err = new Error(`未找到故事资产：${planAssetId || '(空)'}`)
        err.code = 'asset_not_found'
        throw err
      }
      if (!characterId) {
        const err = new Error('characterId 不能为空')
        err.code = 'missing_character_id'
        throw err
      }
      if (!posePrompt) {
        const err = new Error('posePrompt 不能为空')
        err.code = 'missing_pose_prompt'
        throw err
      }

      updateAiTask(task.taskId, { stage: 'pose_sprite', current: cursor - 1, message: `生成姿势绿幕图：${label}` })
      // 2026-10-08 骨架驱动姿势变体接入：spriteAssetPath 直接供给预生成姿势图（OpenPose 骨架+IPAdapter 链产物），
      // 跳过绿幕 sprite 生成（绿幕 IPAdapter 会把姿势拉回主参考站姿，坐/骑/走类姿势必须走骨架驱动）。
      // 路径守卫：必须解析在项目目录内（与 specPath 同款防越界）。
      let assetPath = ''
      const presetSprite = String(pose.spriteAssetPath || '').trim().replace(/^\/+/, '')
      if (presetSprite) {
        const rootAbs = path.resolve(dir)
        const spriteAbs = path.resolve(rootAbs, presetSprite)
        if (spriteAbs === rootAbs || !spriteAbs.startsWith(rootAbs + path.sep) || !(await existsFile(spriteAbs))) {
          const err = new Error(`spriteAssetPath 越出项目目录或不存在，已拒绝：${presetSprite}`)
          err.code = 'sprite_path_invalid'
          throw err
        }
        assetPath = presetSprite
      } else {
        const spriteJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/sprite`, {
          characterId,
          fingerprintPrompt: String(planAsset.anchorPrompt || '').trim(),
          globalPrompt: POSE_GLOBAL_PROMPT,
          posePrompt,
          negativePrompt: [String(pose.negativePrompt || '').trim(), String(planAsset.negativePrompt || '').trim()].filter(Boolean).join(', '),
          style: 'picture_book',
          width: 720,
          height: 1280,
          steps: 20,
          cfgScale: 7,
          ipadapter: { enabled: true }
        })
        assetPath = String(spriteJson.assetPath || '').trim()
      }

      let score
      let reason = ''
      let reviewUnavailable = ''
      try {
        const reviewJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/pose-review`, { characterId, assetPath })
        if (Number.isFinite(Number(reviewJson.score))) score = Number(reviewJson.score)
        reason = String(reviewJson.reason || '').trim()
      } catch (e) {
        reviewUnavailable = String((e && e.code) || 'review_unavailable')
      }

      updateAiTask(task.taskId, { stage: 'pose_cutout', current: cursor - 1, message: `姿势抠图：${label}` })
      const cutoutJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/cutout`, { assetPath })
      const cutoutPath = String(cutoutJson.assetPath || '').trim()

      const projectAssetId = genId('asset')
      await appendProjectAsset({
        id: projectAssetId,
        kind: 'image',
        name: `AI 姿势 ${String(planAsset.name || planAssetId).trim()}·${lockName}`,
        uri: cutoutPath,
        source: { type: 'ai', prompt: posePrompt, provider: 'comfyui', postprocess: 'rmbg_alpha' }
      })

      // 计划资产 poseVariants 追加（读最新 plan 再写回，避免覆盖编排期间的其他变体写入）
      const curPlan = await readStoryAssetPlanIfExists(id)
      if (curPlan) {
        const variant = {
          id: genId('pose'),
          name: lockName,
          // 2026-09-30：记录来源场景，placements 按场景选姿势变体（乌鸦喝水口渴/衔石/喝水随情节上场）
          sceneId: String(c.req.param('sceneId') || '').trim(),
          // 2026-10-08：支持一次绑定多场景（同一变体跨后果/结局复用，摆位 sceneIds 命中同样生效）
          ...(Array.isArray(pose.sceneIds) && pose.sceneIds.length
            ? { sceneIds: pose.sceneIds.map((x) => String(x || '').trim()).filter(Boolean) }
            : {}),
          posePrompt,
          promptZh: String(pose.promptZh || '').trim(),
          promptEn: posePrompt,
          greenPath: assetPath,
          cutoutPath,
          projectAssetId,
          projectAssetUri: cutoutPath,
          ...(score !== undefined ? { score } : {}),
          ...(reason ? { reason } : {}),
          createdAt: nowIso()
        }
        const nextPlan = {
          ...curPlan,
          generatedAt: nowIso(),
          assets: (Array.isArray(curPlan.assets) ? curPlan.assets : []).map((a) =>
            String(a && a.id || '').trim() === planAssetId
              ? { ...a, poseVariants: [...(Array.isArray(a.poseVariants) ? a.poseVariants : []), variant] }
              : a
          )
        }
        nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
        await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
      }

      await traceLockConfirm({ planAssetId, resultImagePath: cutoutPath, prompt: posePrompt })
      poseResults.push({
        lockName,
        planAssetId,
        projectAssetId,
        reused: false,
        ...(score !== undefined ? { score } : {}),
        ...(reviewUnavailable ? { reviewUnavailable } : {})
      })
      updateAiTask(task.taskId, { current: cursor, message: `姿势完成：${label}` })
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      errors.push({ step: 'pose', lockName, planAssetId, code: String((e && e.code) || ''), message: msg })
      poseResults.push({ lockName, planAssetId, projectAssetId: '', reused: false, error: msg })
      updateAiTask(task.taskId, { current: cursor, message: `姿势失败：${label}（${msg}）` })
      logStage({ stage: 'story.scene.layered_produce', event: 'pose_fail', traceId, project: id, item: `${label} / ${msg}` })
    }
  }

  // 2) 道具精灵：sprite(kind:'prop') → cutout → 登记 project.json（道具无姿势变体概念，不写 plan poseVariants）
  for (const propRaw of propSprites) {
    const prop = asObj(propRaw) || {}
    const planAssetId = String(prop.planAssetId || '').trim()
    const name = String(prop.name || '').trim()
    const prompt = String(prop.prompt || '').trim()
    cursor += 1
    const label = name || planAssetId || `prop_${cursor}`
    try {
      if (!prompt) {
        const err = new Error('prompt 不能为空')
        err.code = 'missing_prompt'
        throw err
      }
      const planAsset = findPlanAsset(planAssetId)
      updateAiTask(task.taskId, { stage: 'prop_sprite', current: cursor - 1, message: `生成道具精灵：${label}` })
      const spriteJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/sprite`, {
        kind: 'prop',
        fingerprintPrompt: String(planAsset?.anchorPrompt || '').trim(),
        globalPrompt: POSE_GLOBAL_PROMPT,
        posePrompt: prompt,
        negativePrompt: [String(prop.negativePrompt || '').trim(), String(planAsset?.negativePrompt || '').trim()].filter(Boolean).join(', '),
        style: 'picture_book',
        width: 720,
        height: 1280,
        steps: 20,
        cfgScale: 7
      })
      const assetPath = String(spriteJson.assetPath || '').trim()
      updateAiTask(task.taskId, { stage: 'prop_cutout', current: cursor - 1, message: `道具抠图：${label}` })
      const cutoutJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/cutout`, { assetPath })
      const cutoutPath = String(cutoutJson.assetPath || '').trim()

      const projectAssetId = genId('set')
      await appendProjectAsset({
        id: projectAssetId,
        kind: 'image',
        name: `道具立绘 ${name || planAssetId}`,
        uri: cutoutPath,
        source: { type: 'ai', prompt, provider: 'comfyui', postprocess: 'rmbg_alpha' }
      })
      await traceLockConfirm({ planAssetId, resultImagePath: cutoutPath, prompt })
      propResults.push({ planAssetId, name, projectAssetId, cutoutPath })
      updateAiTask(task.taskId, { current: cursor, message: `道具完成：${label}` })
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      errors.push({ step: 'propSprite', planAssetId, name, code: String((e && e.code) || ''), message: msg })
      propResults.push({ planAssetId, name, projectAssetId: '', error: msg })
      updateAiTask(task.taskId, { current: cursor, message: `道具失败：${label}（${msg}）` })
      logStage({ stage: 'story.scene.layered_produce', event: 'prop_fail', traceId, project: id, item: `${label} / ${msg}` })
    }
  }

  // 3) 背景：render(mode:'background') → bind（bind 端点自带 scene_bind 审核留痕，不重复写）
  if (background) {
    cursor += 1
    try {
      const bgPrompt = String(background.prompt || '').trim()
      if (!bgPrompt) {
        const err = new Error('background.prompt 不能为空')
        err.code = 'missing_background_prompt'
        throw err
      }
      updateAiTask(task.taskId, { stage: 'background_render', current: cursor - 1, message: `重画场景背景：${sceneName}` })
      const renderJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/story/scenes/${encodeURIComponent(sceneId)}/render`, {
        mode: 'background',
        prompt: bgPrompt,
        negativePrompt: String(background.negativePrompt || '').trim(),
        ...(Number.isFinite(Number(background.width)) ? { width: Number(background.width) } : {}),
        ...(Number.isFinite(Number(background.height)) ? { height: Number(background.height) } : {})
      })
      const bgUri = String(renderJson?.projectAsset?.uri || renderJson?.assetPath || '').trim()
      if (!bgUri) {
        const err = new Error('背景渲染未返回产物路径')
        err.code = 'background_render_empty'
        throw err
      }
      updateAiTask(task.taskId, { stage: 'background_bind', current: cursor - 1, message: `绑定场景背景：${sceneName}` })
      await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/story/scenes/${encodeURIComponent(sceneId)}/bind`, { assetPath: bgUri })
      backgroundResult = { assetId: String(renderJson?.projectAsset?.id || '').trim(), uri: bgUri }
      updateAiTask(task.taskId, { current: cursor, message: `背景完成：${sceneName}` })
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      errors.push({ step: 'background', code: String((e && e.code) || ''), message: msg })
      updateAiTask(task.taskId, { current: cursor, message: `背景失败：${sceneName}（${msg}）` })
      logStage({ stage: 'story.scene.layered_produce', event: 'background_fail', traceId, project: id, item: `${sceneId} / ${msg}` })
    }
  }

  // 4) 摆位：逐条校验 imageAssetId 存在于 project.json assets，全部通过才整体替换落盘（不部分写入）
  if (placements.length) {
    cursor += 1
    try {
      updateAiTask(task.taskId, { stage: 'placements', current: cursor - 1, message: `写入分层摆位（${placements.length} 条）…` })
      const assetIds = new Set((await readProjectAssets()).map((a) => String(a && a.id || '').trim()))
      const nextPlacements = []
      const missing = []
      placements.forEach((p, index) => {
        const entry = asObj(p)
        const imageAssetId = String(entry?.imageAssetId || '').trim()
        if (!entry || !imageAssetId || !assetIds.has(imageAssetId)) {
          missing.push({ index, id: String(entry?.id || '').trim(), imageAssetId })
          return
        }
        nextPlacements.push(entry)
      })
      if (missing.length) {
        const err = new Error(`摆位引用的图像资产不存在：${missing.map((m) => m.imageAssetId || m.id || `#${m.index}`).join('、')}`)
        err.code = 'placement_asset_missing'
        err.missing = missing
        throw err
      }
      // 读最新 story.json 落盘（与 placements/render 链路同款 writeJson 原子写回）
      const curStory = await readJson(path.join(dir, 'story.json')).catch(() => null)
      const curNodes = Array.isArray(curStory?.nodes) ? curStory.nodes : []
      if (!curNodes.some((n) => String(n && n.id || '').trim() === sceneId)) {
        const err = new Error(`未找到场景：${sceneId}`)
        err.code = 'scene_not_found'
        throw err
      }
      const nextStory = {
        ...curStory,
        nodes: curNodes.map((node) => {
          if (String(node && node.id || '').trim() !== sceneId) return node
          const visuals = node.visuals && typeof node.visuals === 'object' ? node.visuals : {}
          return { ...node, visuals: { ...visuals, placements: nextPlacements } }
        })
      }
      await writeJson(path.join(dir, 'story.json'), nextStory)
      placementsWritten = nextPlacements.length
      recordCreationEvent(dir, {
        type: 'placements_updated',
        summary: `分层摆位写入：${sceneName}（${placementsWritten} 条）`,
        actor: 'layered_produce_flow',
        data: { sceneId, placements: placementsWritten }
      })
      updateAiTask(task.taskId, { current: cursor, message: `摆位完成：${placementsWritten} 条` })
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e)
      errors.push({ step: 'placements', code: String((e && e.code) || ''), message: msg, ...(Array.isArray(e && e.missing) ? { missing: e.missing } : {}) })
      updateAiTask(task.taskId, { current: cursor, message: `摆位失败：${msg}` })
      logStage({ stage: 'story.scene.layered_produce', event: 'placements_fail', traceId, project: id, item: `${sceneId} / ${msg}` })
    }
  }

  const poseOk = poseResults.filter((p) => !p.error).length
  const propOk = propResults.filter((p) => !p.error).length
  const succeeded = poseOk + propOk + (backgroundResult ? 1 : 0) + (placementsWritten > 0 ? 1 : 0)
  const success = succeeded > 0
  const finalMessage = success
    ? `分层出图完成：姿势 ${poseOk}/${poses.length}、道具 ${propOk}/${propSprites.length}、背景 ${backgroundResult ? '已绑定' : background ? '失败' : '未请求'}、摆位 ${placementsWritten} 条${errors.length ? `（${errors.length} 项失败）` : ''}`
    : `分层出图全部失败：${(errors[0] && errors[0].message) || 'unknown'}`
  updateAiTask(task.taskId, {
    stage: success ? (errors.length ? 'done_with_errors' : 'done') : 'error',
    done: true,
    current: total,
    error: errors.length ? errors.map((e) => `${e.step}:${e.message}`).join('；') : '',
    message: finalMessage,
    result: { sceneId, poses: poseResults, propSprites: propResults, background: backgroundResult, placements: { written: placementsWritten }, errors }
  })
  logStage({ stage: 'story.scene.layered_produce', event: success ? 'ok' : 'fail', traceId, project: id, item: `${sceneId} / ok:${succeeded} / errors:${errors.length}` })

  return c.json({
    success,
    taskId: task.taskId,
    sceneId,
    poses: poseResults,
    propSprites: propResults,
    ...(backgroundResult ? { background: backgroundResult } : {}),
    placements: { written: placementsWritten },
    errors
  }, success ? 200 : 502)
})

// 2026-09-16 道具状态变体生成：同一道具的"剧情状态"立绘（水位/满空/破碎…）。
// 链路：sprite(kind:'prop'，锚定词+状态描述) → pose-review（planAssetId 道具泛化评审，可选失败记 reviewUnavailable）
//   → cutout → 登记 project.json → 计划资产 stateVariants 追加 → lock_confirm 审核留痕（decidedBy=control/editor 触发源）。
// 全程经 /ai/tasks 暴露进度；内部转发统一带 x-image-review-mode: off（触发侧已有自己的审核门禁）。
app.post('/api/projects/:id/ai/story/assets/:assetId/state-variants/generate', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)
  const planAssetId = String(c.req.param('assetId') || '').trim()
  if (!planAssetId) return c.json({ success: false, error: 'missing_asset_id', message: 'assetId 不能为空' }, 400)

  const body = await c.req.json().catch(() => ({}))
  const stateKey = String(body?.stateKey || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
  const label = String(body?.label || body?.stateKey || '').trim()
  const description = String(body?.description || body?.promptZh || '').trim()
  const customPrompt = String(body?.prompt || '').trim()
  const strategy = String(body?.strategy || 'ai').trim().toLowerCase() || 'ai'
  if (!stateKey) return c.json({ success: false, error: 'missing_state_key', message: 'stateKey 不能为空' }, 400)
  if (strategy === 'ai' && !description && !customPrompt) return c.json({ success: false, error: 'missing_description', message: 'description/prompt 至少提供一个' }, 400)
  if (!['ai', 'fill_composite', 'transform'].includes(strategy)) return c.json({ success: false, error: 'invalid_strategy', message: 'strategy 仅支持 ai / fill_composite / transform' }, 400)

  const plan = await readStoryAssetPlanIfExists(id)
  const planAssets = plan && Array.isArray(plan.assets) ? plan.assets : []
  const planAsset = planAssets.find((a) => String(a && a.id || '').trim() === planAssetId) || null
  if (!planAsset) return c.json({ success: false, error: 'asset_not_found', message: '计划中未找到该事物资产。' }, 404)
  const assetName = String(planAsset.name || planAssetId).trim()

  const task = createAiTask(id, 'story.prop.state_variant', { total: 1, message: `生成状态变体：${assetName}·${label}` })
  const internalHeaders = { 'Content-Type': 'application/json', 'x-image-review-mode': 'off' }
  const postInternal = async (urlPath, payload) => {
    const resp = await app.request(urlPath, { method: 'POST', headers: internalHeaders, body: JSON.stringify(payload || {}) })
    const json = await resp.json().catch(() => ({}))
    if (!resp.ok || !json || json.success !== true) {
      const err = new Error(String((json && (json.message || json.error)) || `http_${resp.status}`))
      err.code = String((json && json.error) || `http_${resp.status}`)
      throw err
    }
    return json
  }
  const traceLockConfirm = async ({ resultImagePath, prompt }) => {
    try {
      const targetKey = `lock_confirm:${planAssetId}:${resultImagePath}`
      const pending = await findPendingReview(dir, { phase: 'lock_confirm', targetKey })
      if (pending) {
        await decideImageReview(dir, pending.reviewId, { approved: true, decidedBy: 'control' })
      } else {
        const record = await createImageReview(dir, {
          phase: 'lock_confirm',
          targetKey,
          assetId: planAssetId,
          resultImagePath,
          prompt: String(prompt || '')
        })
        await decideImageReview(dir, record.reviewId, { approved: true, decidedBy: 'control' })
      }
    } catch (_) { /* 留痕失败不阻断登记结果 */ }
  }

  // 状态提示词：身份锚定 + "同一个事物"声明 + 状态描述（中文稿，sprite 端点内自动翻译英文稿）
  const statePrompt = customPrompt || `同一个${assetName}，${description}`
  try {
    let assetPath = ''
    let cutoutPath = ''
    let compositeMeta = null

    if (strategy === 'fill_composite') {
      // 2026-09-16 确定性填充合成：以锁定主参考为底，程序化叠加填充层（水位）与内容物抠图（石子等）。
      // 背景：AI 生成对"同一容器+液位递进+内容物"不可靠（锚定压内容词/身份逐张漂移），
      // 本地脚本黑盒合成违反出图可观测——合成收进服务端：/ai/tasks 进度 + 出图即压 + 评审 + lock_confirm 留痕。
      updateAiTask(task.taskId, { stage: 'state_composite', current: 0, message: `确定性合成状态图：${assetName}·${label}` })
      const refUri = String(planAsset.primaryReferenceAssetUri || planAsset.latestRecommendedReferenceAssetUri || '').trim()
        .replace(/^https?:\/\/[^/]+\/project-assets\/[^/]+\//i, '')
        .replace(/^\/project-assets\/[^/]+\//, '')
      if (!refUri.startsWith('assets/')) {
        const err = new Error('该事物没有可用的锁定主参考图，无法合成')
        err.code = 'reference_not_found'
        throw err
      }
      const refAbs = path.join(dir, refUri)
      if (!(await existsFile(refAbs))) {
        const err = new Error(`主参考图文件不存在：${refUri}`)
        err.code = 'reference_not_found'
        throw err
      }
      const overlaySpecs = []
      for (const ov of (Array.isArray(body?.overlays) ? body.overlays : [])) {
        const ovAssetId = String(ov?.planAssetId || '').trim()
        const ovAsset = ovAssetId ? planAssets.find((a) => String(a && a.id || '').trim() === ovAssetId) : null
        const ovUri = String(ov?.imagePath || (ovAsset && (ovAsset.primaryReferenceAssetUri || ovAsset.latestRecommendedReferenceAssetUri)) || '').trim()
          .replace(/^https?:\/\/[^/]+\/project-assets\/[^/]+\//i, '')
          .replace(/^\/project-assets\/[^/]+\//, '')
        if (!ovUri.startsWith('assets/') || !(await existsFile(path.join(dir, ovUri)))) continue
        overlaySpecs.push({
          imagePath: path.join(dir, ovUri),
          ...(Number.isFinite(Number(ov?.count)) ? { count: Number(ov.count) } : {}),
          ...(Number.isFinite(Number(ov?.brightness)) ? { brightness: Number(ov.brightness) } : {}),
          ...(Number.isFinite(Number(ov?.alpha)) ? { alpha: Number(ov.alpha) } : {}),
          ...(Number.isFinite(Number(ov?.blueShift)) ? { blueShift: Number(ov.blueShift) } : {}),
          ...(Array.isArray(ov?.spots) ? { spots: ov.spots } : {})
        })
      }
      const waterLevel = Math.max(0, Math.min(1, Number(body?.fill?.level ?? body?.waterLevel ?? 0) || 0))
      const relOut = `assets/ai/characters/ch_fill_${Date.now()}.webp`
      const outAbs = path.join(dir, relOut)
      // 2026-09-30 修复：合成输出目录可能不存在（未跑过姿势链的项目无 assets/ai/characters/），
      // PIL save 直接 FileNotFoundError（乌鸦喝水实测 fill_composite_exit_1）
      await mkdir(path.dirname(outAbs), { recursive: true })
      const pyArgs = JSON.stringify({
        refPath: refAbs,
        outPath: outAbs,
        waterLevel,
        overlays: overlaySpecs,
        ...(body?.fill && typeof body.fill === 'object' ? {
          ...(Number.isFinite(Number(body.fill.insetL)) ? { insetL: Number(body.fill.insetL) } : {}),
          ...(Number.isFinite(Number(body.fill.insetR)) ? { insetR: Number(body.fill.insetR) } : {}),
          ...(Number.isFinite(Number(body.fill.insetB)) ? { insetB: Number(body.fill.insetB) } : {}),
          ...(Number.isFinite(Number(body.fill.neckRatio)) ? { neckRatio: Number(body.fill.neckRatio) } : {})
        } : {})
      })
      await new Promise((resolve, reject) => {
        const py = spawn('python3', [path.join(__dirname, 'ai', 'fillComposite.py'), pyArgs])
        let stderr = ''
        py.stderr.on('data', (d) => { stderr += String(d || '') })
        py.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fill_composite_exit_${code}: ${stderr.slice(0, 300)}`))))
        py.on('error', reject)
      })
      if (!(await existsFile(outAbs))) throw new Error('fill_composite_no_output')
      // 出图即压：状态立绘走无损 WebP（PIL 已无损落盘，此处经管线统一校验/转换）
      let finalPath = relOut
      const opt = await optimizeGeneratedImage(outAbs, IMAGE_KIND.SPRITE_LOSSLESS).catch(() => null)
      if (opt && opt.outPath && opt.outPath !== outAbs) finalPath = String(assetPathFromAbsolute(id, opt.outPath) || relOut)
      cutoutPath = finalPath
      compositeMeta = {
        waterLevel,
        overlayCount: overlaySpecs.reduce((n, o) => n + Number(o.count || 3), 0),
        overlayFromAssetIds: overlaySpecs.length ? 'plan' : ''
      }
    } else if (strategy === 'transform') {
      // 2026-10-04 确定性变换合成（微主体/简单状态专用，transformComposite.py）：
      // 背景——微主体（蚂蚁级）在纯文本与 IPAdapter 三档下身份/姿势双失控（实测 33 张全废：
      // 鼠耳/翅膀/瓢虫裙），姿势词从不生效；变换合成不重画像素，只对锁定立绘做 倾斜/翻转/压扁/跃起/速度线/汗滴
      // 的确定性变换，身份像素级零漂移。无 GPU/无评审调用（评审对本类无意义：身份由构造保证）。
      updateAiTask(task.taskId, { stage: 'state_transform', current: 0, message: `确定性变换状态图：${assetName}·${label}` })
      const refUri = String(planAsset.primaryReferenceAssetUri || planAsset.latestRecommendedReferenceAssetUri || '').trim()
        .replace(/^https?:\/\/[^/]+\/project-assets\/[^/]+\//i, '')
        .replace(/^\/project-assets\/[^/]+\//, '')
      if (!refUri.startsWith('assets/')) {
        const err = new Error('该事物没有可用的锁定主参考图，无法变换合成')
        err.code = 'reference_not_found'
        throw err
      }
      const refAbs = path.join(dir, refUri)
      if (!(await existsFile(refAbs))) {
        const err = new Error(`主参考图文件不存在：${refUri}`)
        err.code = 'reference_not_found'
        throw err
      }
      const tr = body?.transform && typeof body.transform === 'object' ? body.transform : {}
      const relOut = `assets/ai/characters/ch_tr_${Date.now()}.webp`
      const outAbs = path.join(dir, relOut)
      await mkdir(path.dirname(outAbs), { recursive: true })
      const pyArgs = JSON.stringify({
        refPath: refAbs,
        outPath: outAbs,
        ...(Number.isFinite(Number(tr.rotateDeg)) ? { rotateDeg: Number(tr.rotateDeg) } : {}),
        ...(tr.flipH === true ? { flipH: true } : {}),
        ...(Number.isFinite(Number(tr.squashY)) ? { squashY: Number(tr.squashY) } : {}),
        ...(Number.isFinite(Number(tr.jumpRatio)) ? { jumpRatio: Number(tr.jumpRatio) } : {}),
        ...(Number.isFinite(Number(tr.motionLines)) ? { motionLines: Number(tr.motionLines) } : {}),
        ...(Number.isFinite(Number(tr.sweat)) ? { sweat: Number(tr.sweat) } : {})
      })
      await new Promise((resolve, reject) => {
        const py = spawn('python3', [path.join(__dirname, 'ai', 'transformComposite.py'), pyArgs])
        let stderr = ''
        py.stderr.on('data', (d) => { stderr += String(d || '') })
        py.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`transform_composite_exit_${code}: ${stderr.slice(0, 300)}`))))
        py.on('error', reject)
      })
      if (!(await existsFile(outAbs))) throw new Error('transform_composite_no_output')
      let finalPath = relOut
      const opt = await optimizeGeneratedImage(outAbs, IMAGE_KIND.SPRITE_LOSSLESS).catch(() => null)
      if (opt && opt.outPath && opt.outPath !== outAbs) finalPath = String(assetPathFromAbsolute(id, opt.outPath) || relOut)
      cutoutPath = finalPath
      compositeMeta = {
        transform: {
          ...(Number.isFinite(Number(tr.rotateDeg)) ? { rotateDeg: Number(tr.rotateDeg) } : {}),
          ...(tr.flipH === true ? { flipH: true } : {}),
          ...(Number.isFinite(Number(tr.squashY)) ? { squashY: Number(tr.squashY) } : {}),
          ...(Number.isFinite(Number(tr.jumpRatio)) ? { jumpRatio: Number(tr.jumpRatio) } : {}),
          ...(Number.isFinite(Number(tr.motionLines)) ? { motionLines: Number(tr.motionLines) } : {}),
          ...(Number.isFinite(Number(tr.sweat)) ? { sweat: Number(tr.sweat) } : {})
        }
      }
    } else {
      const spriteJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/sprite`, {
        kind: 'prop',
        planAssetId,
        ipadapter: {
          enabled: true,
          ...(Number.isFinite(Number(body?.ipadapter?.weight)) ? { weight: Number(body.ipadapter.weight) } : {}),
          ...(Number.isFinite(Number(body?.ipadapter?.startAt)) ? { startAt: Number(body.ipadapter.startAt) } : {}),
          ...(Number.isFinite(Number(body?.ipadapter?.endAt)) ? { endAt: Number(body.ipadapter.endAt) } : {})
        },
        fingerprintPrompt: String(planAsset.anchorPrompt || '').trim(),
        globalPrompt: 'cartoon fairy tale picture book style, flat 2D illustration, bold clean outlines, cel shading, warm soft color palette',
        posePrompt: statePrompt,
        negativePrompt: [String(body?.negativePrompt || '').trim(), String(planAsset.negativePrompt || '').trim()].filter(Boolean).join(', '),
        style: 'picture_book',
        width: 720,
        height: 1280,
        steps: 20,
        cfgScale: 7
      })
      assetPath = String(spriteJson.assetPath || '').trim()
      updateAiTask(task.taskId, { stage: 'state_cutout', current: 0, message: `状态抠图：${assetName}·${label}` })
      const cutoutJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/cutout`, { assetPath })
      cutoutPath = String(cutoutJson.assetPath || '').trim()
    }

    let score
    let reason = ''
    let reviewUnavailable = ''
    if (strategy === 'transform') {
      // 变换合成身份由构造保证（同一锁定立绘的像素级变换），AI 姿势评审对本类无意义，跳过
      reason = 'deterministic_transform'
    } else try {
      updateAiTask(task.taskId, { stage: 'state_review', current: 0, message: `状态一致性评审：${assetName}·${label}` })
      const reviewJson = await postInternal(`/api/projects/${encodeURIComponent(id)}/ai/character/pose-review`, { planAssetId, assetPath: cutoutPath })
      if (Number.isFinite(Number(reviewJson.score))) score = Number(reviewJson.score)
      reason = String(reviewJson.reason || '').trim()
    } catch (e) {
      reviewUnavailable = String((e && e.code) || 'review_unavailable')
    }

    // 产物登记：project.json assets 追加（读最新盘再写回）
    const projectAssetId = genId('asset')
    const proj = await readJson(path.join(dir, 'project.json'))
    const nextProject = {
      ...proj,
      assets: [...(Array.isArray(proj?.assets) ? proj.assets : []), {
        id: projectAssetId,
        kind: 'image',
        name: `AI 状态 ${assetName}·${label}`,
        uri: cutoutPath,
        source: strategy === 'fill_composite'
          ? { type: 'composite', prompt: statePrompt, provider: 'deterministic', postprocess: 'ref_water_overlay' }
          : strategy === 'transform'
            ? { type: 'composite', prompt: statePrompt, provider: 'deterministic', postprocess: 'ref_transform' }
            : { type: 'ai', prompt: statePrompt, provider: 'comfyui', postprocess: 'rmbg_alpha' }
      }],
      updatedAt: nowIso(),
      _rev: Number(proj?._rev || 0) + 1
    }
    await writeJson(path.join(dir, 'project.json'), nextProject)

    // 计划资产 stateVariants 追加（读最新 plan 再写回，mergeAssetsById 保并发安全）
    const curPlan = await readStoryAssetPlanIfExists(id)
    if (curPlan) {
      const variant = {
        id: genId('state'),
        stateKey,
        name: label,
        prompt: statePrompt,
        promptZh: String(body?.promptZh || description || customPrompt || '').trim(),
        greenPath: assetPath,
        cutoutPath,
        projectAssetId,
        projectAssetUri: cutoutPath,
        ...(strategy === 'fill_composite' ? { composite: 'ref_water_overlay', compositeMeta } : {}),
        ...(strategy === 'transform' ? { composite: 'ref_transform', compositeMeta } : {}),
        ...(score !== undefined ? { score } : {}),
        ...(reason ? { reason } : {}),
        createdAt: nowIso()
      }
      const nextPlan = {
        ...curPlan,
        generatedAt: nowIso(),
        assets: (Array.isArray(curPlan.assets) ? curPlan.assets : []).map((a) =>
          String(a && a.id || '').trim() === planAssetId
            ? { ...a, stateVariants: [...(Array.isArray(a.stateVariants) ? a.stateVariants : []), variant] }
            : a
        )
      }
      nextPlan.summary = summarizeStoryAssetPlan(nextPlan)
      await saveStoryAssetPlan(id, nextPlan, { mergeAssetsById: true })
    }

    await traceLockConfirm({ resultImagePath: cutoutPath, prompt: statePrompt })
    updateAiTask(task.taskId, {
      stage: 'done',
      done: true,
      current: 1,
      message: `状态变体完成：${assetName}·${label}${score !== undefined ? `（${score} 分）` : ''}`,
      result: { planAssetId, stateKey, label, projectAssetId, ...(score !== undefined ? { score } : {}) }
    })
    return c.json({
      success: true,
      taskId: task.taskId,
      planAssetId,
      stateKey,
      label,
      projectAssetId,
      cutoutPath,
      ...(score !== undefined ? { score } : {}),
      ...(reason ? { reason } : {}),
      ...(reviewUnavailable ? { reviewUnavailable } : {})
    })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    updateAiTask(task.taskId, { stage: 'error', done: true, current: 1, error: msg, message: `状态变体失败：${assetName}·${label}（${msg}）` })
    return c.json({ success: false, error: String((e && e.code) || 'ai_failed'), message: msg, taskId: task.taskId }, 502)
  }
})

// 重启恢复：扫描所有项目的 per-scene checkpoint，未完成批次从断点继续（已成功场景由成功保护跳过）
async function resumeInterruptedSceneBatchesAfterRestart() {
  const interrupted = await findInterruptedSceneBatches(PROJECTS_DIR)
  for (const { projectId, dir, batch } of interrupted) {
    if (activeSceneBatchProjects.has(projectId)) continue
    const reviewMode = String(batch.options && batch.options.reviewMode || '').trim() || 'manual'
    const task = createAiTask(projectId, 'story.scenes.batch', { total: batch.items.length, message: `重启恢复批量渲染（队列 ${batch.batchId}）` })
    const { renderScene, onProgress } = makeSceneBatchRunner(projectId, task, {
      reviewMode,
      approvedToken: '',
      renderPayload: { width: batch.options?.width, height: batch.options?.height, timeoutMs: batch.options?.timeoutMs, mode: batch.options?.mode, backgroundOnly: batch.options?.backgroundOnly }
    })
    logStage({ stage: 'story.scenes.batch', event: 'restart_resume', project: projectId, item: batch.batchId })
    launchSceneBatch(projectId, task, async () => {
      const { batch: done } = await resumeSceneBatch({ dir, renderScene, onProgress })
      return done || batch
    })
  }
  return interrupted.length
}

function normalizeStyleEnum(v) {
  const s = String(v || '').trim()
  return s === 'picture_book' || s === 'cartoon' || s === 'national_style' || s === 'watercolor' ? s : 'picture_book'
}

function styleNameZh(style) {
  const s = normalizeStyleEnum(style)
  if (s === 'picture_book') return '绘本插画'
  if (s === 'cartoon') return '卡通'
  if (s === 'national_style') return '国风'
  if (s === 'watercolor') return '水彩'
  return '插画'
}

// AI：提取角色外观指纹（全局锁定）
app.post('/api/projects/:id/ai/character/fingerprint', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const characterName = String(body?.characterName || '').trim()
  if (!characterName) return c.json({ success: false, error: 'missing_characterName', message: 'characterName 不能为空' }, 400)
  const storyTitle = String(body?.storyTitle || '').trim()
  const contextText = String(body?.contextText || '').trim()
  const globalPrompt = String(body?.globalPrompt || '').trim()
  const style = normalizeStyleEnum(body?.style)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.prompt) {
    return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)
  }

  const startedAt = Date.now()
  try {
    console.log(
      `[gamestudio] ch.fp:start project=${id} provider=${studio.effective.prompt.provider || 'localoxml'} model=${studio.effective.prompt.model || '-'} name=${characterName} storyChars=${storyTitle.length} ctxChars=${contextText.length} globalChars=${globalPrompt.length} style=${style}`
    )
  } catch (_) {}

  try {
    const { result, meta } = await generateCharacterFingerprint({
      storyTitle,
      characterName,
      contextText,
      globalPrompt,
      style,
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model,
      apiUrl: studio.effective.prompt.apiUrl,
      proxyUrl: studio.effective.network.proxyUrl
    })

    try {
      console.log(`[gamestudio] ch.fp:ok project=${id} ms=${Math.max(0, Date.now() - startedAt)} provider=${meta?.provider || '-'} model=${meta?.model || '-'}`)
    } catch (_) {}
    return c.json({ success: true, result, meta })
  } catch (e) {
    try {
      console.log(`[gamestudio] ch.fp:fail project=${id} ms=${Math.max(0, Date.now() - startedAt)} err=${e && e.message ? String(e.message) : String(e)}`)
    } catch (_) {}
    return c.json({ success: false, error: 'ai_failed', message: e && e.message ? String(e.message) : String(e) }, 502)
  }
})

// AI：生成角色绿幕图（前端自动抠图得到透明 PNG）
app.post('/api/projects/:id/ai/character/sprite', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const fingerprintPrompt = String(body?.fingerprintPrompt || '').trim()
  const posePrompt = String(body?.posePrompt || body?.prompt || '').trim()
  const globalPrompt = String(body?.globalPrompt || '').trim()
  const negativePromptIn = String(body?.negativePrompt || '').trim()
  const style = normalizeStyleEnum(body?.style)

  const width = Number(body?.width || 720)
  const height = Number(body?.height || 1280)
  if (!fingerprintPrompt && !posePrompt) return c.json({ success: false, error: 'missing_prompt', message: 'fingerprintPrompt/posePrompt 至少填写一个' }, 400)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
  const imgProvider = String(studio.effective.image.provider || process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()

  // 2026-09-01 身份锁定（IPAdapter）：characterId → 角色锁定主参考（ai.referenceAssetId，回退 imageAssetId）。
  // 背景：纯文本指纹在动作词干扰下会丢角色（实测"大哥指着稻草堆"生成人类少年+宠物猪），
  // 必须用锁定主参考图像锚定身份；ComfyUI 侧 ipadapter 能力已由 capability-check 确认可用。
  const characterId = String(body?.characterId || '').trim()
  // 2026-09-01 IPAdapter 默认关闭（A/B 实测定论）：IPAdapter 各权重/区间档都会锚死主参考的站姿，
  // 动作词完全不生效；纯文本（指纹前置+去人类化+动物主语+动作强调）身份与动作双达标。
  // 仅当纯文本身份不稳时才用 STUDIO_SPRITE_IPADAPTER=on 打开。
  // 2026-09-01 档位入参：body.ipadapter={enabled,weight,startAt,endAt}——enabled=true 时强制走主参考
  // IPAdapter 链（无视 env 默认 off），weight/startAt/endAt 覆盖 env 默认（姿势变体管理区高级参数）。
  const ipaBody = body && typeof body.ipadapter === 'object' && body.ipadapter ? body.ipadapter : null
  const ipadapterOn = ipaBody && ipaBody.enabled === true
    ? true
    : String(process.env.STUDIO_SPRITE_IPADAPTER || '').trim().toLowerCase() === 'on'
  let referenceImages = []
  // 2026-09-16 道具泛化：body.planAssetId（道具状态变体）同样经 IPAdapter 锚定计划资产锁定主参考。
  // 实测无图锚时道具文本锚点会被模型先验带跑（细颈圆腹瓶变红盖圆柱瓶、评分 0）。
  const planAssetIdIn = String(body?.planAssetId || '').trim()
  let ipaRel = ''
  if (ipadapterOn && characterId) {
    try {
      const proj = await readJson(path.join(dir, 'project.json'))
      const ch = (proj && Array.isArray(proj.characters) ? proj.characters : []).find((x) => x && x.id === characterId) || null
      const refId = String((ch && ch.ai && ch.ai.referenceAssetId) || (ch && ch.imageAssetId) || '').trim()
      const asset = refId && proj && Array.isArray(proj.assets) ? proj.assets.find((a) => a && a.id === refId) || null : null
      ipaRel = String((asset && asset.uri) || '').trim()
    } catch (_) {}
  } else if (ipadapterOn && planAssetIdIn) {
    try {
      const planDoc = await readStoryAssetPlanIfExists(id)
      const pa = (planDoc && Array.isArray(planDoc.assets) ? planDoc.assets : []).find((a) => String(a && a.id || '').trim() === planAssetIdIn) || null
      ipaRel = String((pa && (pa.primaryReferenceAssetUri || pa.latestRecommendedReferenceAssetUri)) || '').trim()
    } catch (_) {}
  }
  ipaRel = ipaRel
    .replace(/^https?:\/\/[^/]+\/project-assets\/[^/]+\//i, '')
    .replace(/^\/project-assets\/[^/]+\//, '')
  if (ipaRel && ipadapterOn) {
    try {
      const rel = ipaRel
      if (rel.startsWith('assets/')) {
        // 2026-09-01 实测根因：锁定主参考是 RMBG 透明底 cutout，CLIP vision 对透明区的编码是脏的，
        // IPAdapter 身份锚定完全失效（候选变成人类女性、评分 5/100）。喂给 IPAdapter 前一律合成白底
        // （python3+PIL 本机可用；失败回退原图）。产物缓存为 <原名>_flatwhite.png，源文件较新才重算。
        // 2026-09-16 修复：webp 透明 cutout 同样要合成白底（原仅 .png 生效，乌鸦主参考 webp 直通导致锚定失效生成人类少女）。
        let refAbs = path.join(dir, rel)
        if (/\.(png|webp)$/i.test(refAbs)) {
          try {
            const flatAbs = refAbs.replace(/\.(png|webp)$/i, '') + '_flatwhite.png'
            const s0 = await stat(refAbs)
            const s1 = await stat(flatAbs).catch(() => null)
            if (!(s1 && s1.mtimeMs >= s0.mtimeMs)) {
              await new Promise((resolve, reject) => {
                const py = spawn('python3', ['-c',
                  "import sys; from PIL import Image; im=Image.open(sys.argv[1]).convert('RGBA'); bg=Image.new('RGBA', im.size, (255,255,255,255)); bg.alpha_composite(im); bg.convert('RGB').save(sys.argv[2])",
                  refAbs, flatAbs])
                py.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('flatten_exit_' + code))))
                py.on('error', reject)
              })
            }
            refAbs = flatAbs
          } catch (e) {
            try { console.log(`[gamestudio] ch.sprite:ipadapter_flatten_fail err=${e && e.message ? e.message : e}`) } catch (_) {}
          }
        }
        const bytes = await readFile(refAbs)
        // 权重/区间可调：全程 [0,1] + 0.85 会把主参考站姿锚死；start_at>0 放开早期构图步让动作词生效
        const w = ipaBody && Number.isFinite(Number(ipaBody.weight)) ? Number(ipaBody.weight) : Number(process.env.STUDIO_SPRITE_IPADAPTER_WEIGHT || 0.7)
        const startAt = ipaBody && Number.isFinite(Number(ipaBody.startAt)) ? Number(ipaBody.startAt) : Number(process.env.STUDIO_SPRITE_IPADAPTER_START_AT || 0.25)
        const endAt = ipaBody && Number.isFinite(Number(ipaBody.endAt)) ? Number(ipaBody.endAt) : Number(process.env.STUDIO_SPRITE_IPADAPTER_END_AT || 0.9)
        referenceImages = [{
          bytes,
          filename: `${characterId || planAssetIdIn || 'ref'}_reference.png`,
          characterId,
          weight: Number.isFinite(w) ? w : 0.7,
          startAt: Number.isFinite(startAt) ? startAt : 0.25,
          endAt: Number.isFinite(endAt) ? endAt : 0.9
        }]
      }
    } catch (e) {
      try {
        console.log(`[gamestudio] ch.sprite:ipadapter_ref_fail project=${id} ch=${characterId || planAssetIdIn} err=${e && e.message ? e.message : e}`)
      } catch (_) {}
    }
  }

  // Enforce chroma background for later client-side matting.
  // 2026-09-01 修复：绿幕提示改英文并放 prompt 前部（中文提示模型读不懂、位置靠后被世界锚点压掉，实测出橙底）
  // 2026-09-01 道具模式（kind:'prop'）：角色版提示里的 "single character or single animal / no props"
  // 会把道具生成带成人类少女（实测稻草堆/木柴堆/泥土地全变女孩），道具必须明确 "single object, no character"。
  const spriteKind = String(body?.kind || '').trim().toLowerCase()
  const isPropSprite = spriteKind === 'prop'
  const chromaHint = isPropSprite
    ? `solid pure green screen background (RGB 0,255,0 chroma key green), flat uniform green, no gradient, no texture, no scene, no environment, no ground, no shadow, single object centered, no character, no animal, no person, no face, clean sharp edges`
    : `solid pure green screen background (RGB 0,255,0 chroma key green), flat uniform green, no gradient, no texture, no scene, no environment, no ground, no shadow, no props, single character or single animal centered, full body, clean sharp edges`

  // 2026-09-01 动作描述为中文时先翻译成英文（生图模型读不懂中文，实测中文动作词完全不生效，出来全是站姿）
  let poseUse = posePrompt
  if (/[\u4e00-\u9fff]/.test(poseUse)) {
    try {
      const { result: tr } = await translatePromptText({
        provider: studio.effective.prompt.provider,
        model: studio.effective.prompt.model || undefined,
        apiUrl: studio.effective.prompt.apiUrl || undefined,
        proxyUrl: studio.effective.network.proxyUrl || undefined,
        timeoutMs: 60_000,
        text: poseUse,
        sourceLang: 'zh',
        targetLang: 'en',
        mode: 'prompt'
      })
      const t = String(tr && tr.translatedText || '').trim()
      if (t) poseUse = t
    } catch (_) { /* 翻译失败保留原文，不阻断生成 */ }
  }

  // 2026-09-16 修复：身份指纹为中文时同样先翻译成英文。
  // 实测根因（乌鸦喝水 2026-09-16）：plan 锚定词是中文「一只普通的黑色乌鸦…」，
  // 生图模型读不懂中文 → 身份锚点失效，姿势候选直接漂移成人类少女。
  let fingerprintUse = fingerprintPrompt
  if (/[一-鿿]/.test(fingerprintUse)) {
    try {
      const { result: tr } = await translatePromptText({
        provider: studio.effective.prompt.provider,
        model: studio.effective.prompt.model || undefined,
        apiUrl: studio.effective.prompt.apiUrl || undefined,
        proxyUrl: studio.effective.network.proxyUrl || undefined,
        timeoutMs: 60_000,
        text: fingerprintUse,
        sourceLang: 'zh',
        targetLang: 'en',
        mode: 'prompt'
      })
      const t = String(tr && tr.translatedText || '').trim()
      if (t) fingerprintUse = t
    } catch (_) { /* 翻译失败保留原文，不阻断生成 */ }
  }

  // 2026-09-01 去人类化 + 动物主语包裹（拟人动物角色专用）。
  // 实测根因：指纹/动作里的 "eldest brother" 等人类称谓 + 缺主语的动作句（"pointing at the haystack"），
  // 会把组合构图拉向人类（生成人类少年+宠物猪）。称谓替换为动物角色，动作句补上动物主语。
  // 2026-09-16：物种词表补鸟类（crow/raven/bird 等）——原词表无 crow，乌鸦喝水项目主语只剩 "the character"。
  const speciesHit = String(fingerprintUse || '').match(/pig|wolf|cat|dog|rabbit|fox|bear|duck|chicken|goat|mouse|lion|tiger|panda|monkey|crow|raven|bird|sparrow|owl|eagle|goose|parrot|penguin|swan|crane/i)
  const species = speciesHit ? speciesHit[0].toLowerCase() : ''
  const dehumanize = (s) =>
    String(s || '')
      .replace(/eldest\s+brother|oldest\s+brother|second\s+brother|third\s+brother|big\s+brother|little\s+brother|younger\s+brother/gi, species || 'character')
      .replace(/\b(brother|sister|boy|girl|man|woman|kid|child|children)\b/gi, species ? `${species} character` : 'character')
  const fpUse = isPropSprite ? fingerprintUse : dehumanize(fingerprintUse)
  if (poseUse && !isPropSprite) {
    poseUse = dehumanize(poseUse)
    // 2026-09-01 动作强调：去掉 "pig:" 标签头，动作句加 (…:1.25) 权重（ComfyUI 支持权重语法）。
    // 实测普通语序下动作词会被指纹/绿幕词压掉，出来全是站桩姿势。
    poseUse = poseUse.replace(/^[^:：]{1,40}[:：]\s*/, '').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()
    if (poseUse) {
      const subject = species ? `the ${species} character` : 'the character'
      // 2026-09-16 物种解剖锚点：动作句内补物种解剖词，防止无鸟类词的动作（盘旋/撞击等）被动漫模型先验拽成人类少女
      // （实测乌鸦「原地盘旋」出人类女孩、评审 0 分；带 wings 的动作句则稳定出鸟）。
      const SPECIES_ANATOMY = {
        crow: 'crow wings, black beak, feathered body, bird claws',
        raven: 'raven wings, black beak, feathered body, bird claws',
        bird: 'bird wings, beak, feathered body, bird claws',
        sparrow: 'sparrow wings, small beak, feathered body',
        owl: 'owl wings, hooked beak, feathered body, owl eyes',
        eagle: 'eagle wings, hooked beak, feathered body, talons',
        goose: 'goose wings, flat beak, feathered body',
        duck: 'duck wings, flat beak, feathered body, webbed feet',
        chicken: 'chicken wings, small beak, feathered body, comb',
        parrot: 'parrot wings, curved beak, colorful feathers',
        penguin: 'penguin flippers, beak, feathered body',
        swan: 'swan wings, long neck, feathered body',
        crane: 'crane wings, long legs, long beak, feathered body',
        pig: 'pig snout, pig ears, hooves, curly tail',
        wolf: 'wolf snout, wolf ears, fur, tail',
        cat: 'cat ears, cat tail, fur, whiskers',
        dog: 'dog ears, dog snout, fur, tail',
        rabbit: 'long rabbit ears, rabbit tail, fur',
        fox: 'fox ears, fox snout, bushy tail, fur',
        bear: 'bear ears, bear snout, fur, paws',
        mouse: 'mouse ears, long tail, fur',
        lion: 'lion mane, lion tail, fur, paws',
        tiger: 'tiger stripes, tiger tail, fur, paws',
        panda: 'panda ears, black-and-white fur, round body',
        monkey: 'monkey tail, fur, monkey face',
        goat: 'goat horns, goat beard, hooves, fur'
      }
      const anatomy = species ? (SPECIES_ANATOMY[species] || `${species} anatomy, species-correct body`) : ''
      poseUse = `${subject} (${[poseUse, anatomy].filter(Boolean).join(', ')}:1.25)`
    }
  }

  const prompt = [
    // 2026-09-01 身份锚点放最前：SD 类模型前段 token 权重更高，实测指纹放第 4 位会丢角色（猪变人类少年）
    fpUse,
    chromaHint,
    poseUse,
    `style: ${style}`,
    globalPrompt
  ]
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('，')

  const negBase = [
    'text', 'watermark', 'low quality', 'blurry', 'deformed',
    'complex background', 'scenery', 'landscape', 'indoor',
    'multiple people', 'multiple animals',
    // 2026-09-01 修复：绿幕图必须排除人类与绿色元素（中文负向模型读不懂，实测出绿发绿衣人类少女）
    'human', 'person', 'human girl', 'human boy', 'anime human', 'human face', 'human skin',
    'green clothes', 'green hair', 'green hat', 'green accessories', 'green skin', 'green fur',
    'shadow', 'ground', 'environment',
    // 道具模式：角色版 chromaHint 的人类先验极强，负向必须补死（实测全出人类少女）
    ...(isPropSprite ? ['character', 'animal', 'girl', 'boy', 'woman', 'man', 'face', 'fairy', 'wings', 'person sitting', 'holding book'] : [])
  ].join(', ')

  const negativePrompt = [negativePromptIn, negBase]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(', ')

  const startedAt = Date.now()
  try {
    console.log(
      `[gamestudio] ch.sprite:start project=${id} provider=${imgProvider} model=${studio.effective.image.model || '-'} w=${Math.floor(width || 0)} h=${Math.floor(height || 0)} style=${style} promptChars=${prompt.length} negChars=${negativePrompt.length} ipadapter=${referenceImages.length ? 'on' : 'off'}`
    )
  } catch (_) {}

  try {
    const gen = await generateBackgroundImage({
      prompt,
      negativePrompt,
      width,
      height,
      steps: body?.steps,
      cfgScale: body?.cfgScale,
      guidanceScale: body?.guidanceScale,
      sequentialImageGeneration: body?.sequentialImageGeneration,
      continuity: referenceImages.length ? { ipadapterEnabled: true } : undefined,
      referenceImages,
      // 2026-09-01 动作立绘用通用 plus 模型（plus-face 人脸模型会把猪锚成人类少年，实测）
      ipadapterModel: String(process.env.STUDIO_SPRITE_IPADAPTER_MODEL || 'ip-adapter-plus_sdxl_vit-h.safetensors').trim(),
      provider: imgProvider,
      sdwebuiBaseUrl: studio.effective.image.sdwebuiBaseUrl,
      comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
      apiUrl: studio.effective.image.apiUrl,
      model: studio.effective.image.model,
      loras: studio.effective.image.loras,
      proxyUrl: studio.effective.network.proxyUrl
    })

    const buf = gen.bytes
    const ext0 = String(gen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
    const sniff = sniffImageMetaFromBytes(buf)
    const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'

    const relDir = path.join('assets', 'ai', 'characters')
    const outDir = path.join(dir, relDir)
    await mkdir(outDir, { recursive: true })
    const fname = `ch_${Date.now()}.${ext}`
    const abs = path.join(outDir, fname)
    await writeFile(abs, buf)

    let assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
    { // 2026-09-09 出图即压：姿势候选绿幕图 WebP q92
      const opt = await optimizeGeneratedImage(abs, IMAGE_KIND.CANDIDATE).catch(() => null)
      if (opt && opt.outPath && opt.outPath !== abs) assetPath = String(assetPathFromAbsolute(id, opt.outPath) || assetPath)
    }
    const provider = (gen && gen.meta && gen.meta.provider) ? String(gen.meta.provider) : imgProvider
    const remoteUrl = (gen && gen.meta && typeof gen.meta.url === 'string' && gen.meta.url.trim()) ? String(gen.meta.url).trim() : ''
    try {
      console.log(`[gamestudio] ch.sprite:ok project=${id} provider=${provider} bytes=${buf.length} ext=${ext} ms=${Math.max(0, Date.now() - startedAt)}`)
    } catch (_) {}
    return c.json({ success: true, provider, assetPath, url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`, remoteUrl, prompt, negativePrompt })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const status = e && typeof e.status === 'number' ? e.status : null
    try {
      console.log(`[gamestudio] ch.sprite:fail project=${id} provider=${imgProvider} status=${status == null ? '-' : status} ms=${Math.max(0, Date.now() - startedAt)} err=${msg}`)
    } catch (_) {}
    if (status === 501) return c.json({ success: false, error: 'provider_not_configured', message: msg }, 501)
    return c.json({ success: false, error: 'ai_failed', message: msg }, 502)
  }
})

// AI：绿幕图抠图（RMBG 语义分割，透明 PNG）。
// 2026-09-01:替代前端 chroma key——按颜色抠图对衣服撞色/渐变底完全不可控（实测衣服被挖穿），
// RMBG 是项目故事资产立绘已在用的成熟路径（capability-check rmbg:ok）。
app.post('/api/projects/:id/ai/character/cutout', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const relIn = String(body?.assetPath || '').trim().replace(/^\/+/, '')
  if (!relIn || !relIn.startsWith('assets/')) {
    return c.json({ success: false, error: 'missing_assetPath', message: 'assetPath 必须是项目内 assets/ 相对路径' }, 400)
  }
  const abs = path.join(dir, relIn)
  if (!abs.startsWith(dir)) return c.json({ success: false, error: 'invalid_path' }, 400)
  if (!(await existsFile(abs))) return c.json({ success: false, error: 'file_not_found' }, 404)

  const studio = await getEffectiveStudioConfig(ROOT)
  const comfyuiBaseUrl = String(studio?.effective?.image?.comfyuiBaseUrl || '').trim()
  if (!comfyuiBaseUrl) return c.json({ success: false, error: 'provider_not_configured', message: 'ComfyUI 未配置' }, 501)

  const startedAt = Date.now()
  try {
    const bytes = await readFile(abs)
    const post = await generateComfyuiCutoutFromReference({
      referenceBytes: bytes,
      referenceFilename: `ch_sprite_${Date.now()}.png`,
      comfyuiBaseUrl,
      processRes: 1024,
      prefix: 'gamestudio_ch_sprite/cutout_alpha',
      transparent: true
    })
    const ext = String(post.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
    const relDir = path.join('assets', 'ai', 'characters')
    const outDir = path.join(dir, relDir)
    await mkdir(outDir, { recursive: true })
    const fname = `ch_cut_${Date.now()}.${ext}`
    await writeFile(path.join(outDir, fname), post.bytes)
    let assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
    { // 2026-09-09 出图即压：抠图立绘无损 WebP（真相源零质量损失）
      const absCut = path.join(outDir, fname)
      const opt = await optimizeGeneratedImage(absCut, IMAGE_KIND.SPRITE_LOSSLESS).catch(() => null)
      if (opt && opt.outPath && opt.outPath !== absCut) assetPath = String(assetPathFromAbsolute(id, opt.outPath) || assetPath)
    }
    try {
      console.log(`[gamestudio] ch.cutout:ok project=${id} bytes=${post.bytes.length} ms=${Math.max(0, Date.now() - startedAt)}`)
    } catch (_) {}
    return c.json({ success: true, assetPath, url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}` })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    try {
      console.log(`[gamestudio] ch.cutout:fail project=${id} ms=${Math.max(0, Date.now() - startedAt)} err=${msg}`)
    } catch (_) {}
    return c.json({ success: false, error: 'ai_failed', message: msg }, 502)
  }
})

// AI：动作立绘抽卡池——候选图与角色锁定主参考的一致性评分（Kimi 视觉评审）。
// 2026-09-01 新增：抽卡池模式下每张候选图与主参考对比打分（身份/画风/服装），姿势差异不扣分。
// 评审不可用（无 key/网络失败）返回明确错误，不伪造分数。
app.post('/api/projects/:id/ai/character/pose-review', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const characterId = String(body?.characterId || '').trim()
  const planAssetId = String(body?.planAssetId || '').trim()
  const relIn = String(body?.assetPath || '').trim().replace(/^\/+/, '')
  if (!characterId && !planAssetId) return c.json({ success: false, error: 'missing_characterId', message: 'characterId/planAssetId 至少提供一个' }, 400)
  if (!relIn || !relIn.startsWith('assets/')) {
    return c.json({ success: false, error: 'missing_assetPath', message: 'assetPath 必须是项目内 assets/ 相对路径' }, 400)
  }
  const candAbs = path.join(dir, relIn)
  if (!candAbs.startsWith(dir)) return c.json({ success: false, error: 'invalid_path', message: 'assetPath 越界' }, 400)
  if (!(await existsFile(candAbs))) return c.json({ success: false, error: 'file_not_found', message: '候选图不存在' }, 404)

  // 解析锁定主参考（与 ch.sprite 同款逻辑：characterId → ch.ai.referenceAssetId，回退 imageAssetId → uri 转项目内路径）
  // 2026-09-16 道具泛化：planAssetId → 计划资产 primaryReferenceAssetUri（回退 latestRecommended），供道具状态变体评审复用同一链路。
  let refBytes = null
  let refAbsPath = null
  let characterName = ''
  try {
    if (planAssetId) {
      const plan = await readStoryAssetPlanIfExists(id)
      const pa = (plan && Array.isArray(plan.assets) ? plan.assets : []).find((a) => String(a && a.id || '').trim() === planAssetId) || null
      characterName = String((pa && pa.name) || planAssetId).trim()
      const uri = String((pa && (pa.primaryReferenceAssetUri || pa.latestRecommendedReferenceAssetUri)) || '').trim()
      const rel = uri
        .replace(/^https?:\/\/[^/]+\/project-assets\/[^/]+\//i, '')
        .replace(/^\/project-assets\/[^/]+\//, '')
      if (rel.startsWith('assets/')) {
        const refAbs = path.join(dir, rel)
        if (refAbs.startsWith(dir) && (await existsFile(refAbs))) {
          refBytes = await readFile(refAbs)
          refAbsPath = refAbs
        }
      }
    } else {
      const proj = await readJson(path.join(dir, 'project.json'))
      const ch = (proj && Array.isArray(proj.characters) ? proj.characters : []).find((x) => x && x.id === characterId) || null
      characterName = String((ch && ch.name) || '').trim()
      const refId = String((ch && ch.ai && ch.ai.referenceAssetId) || (ch && ch.imageAssetId) || '').trim()
      const asset = refId && proj && Array.isArray(proj.assets) ? proj.assets.find((a) => a && a.id === refId) || null : null
      const uri = String((asset && asset.uri) || '').trim()
      const rel = uri
        .replace(/^https?:\/\/[^/]+\/project-assets\/[^/]+\//i, '')
        .replace(/^\/project-assets\/[^/]+\//, '')
      if (rel.startsWith('assets/')) {
        const refAbs = path.join(dir, rel)
        if (refAbs.startsWith(dir) && (await existsFile(refAbs))) {
          refBytes = await readFile(refAbs)
          refAbsPath = refAbs
        }
      }
    }
  } catch (e) {
    try {
      console.log(`[gamestudio] ch.pose_review:ref_fail project=${id} ch=${characterId || planAssetId} err=${e && e.message ? e.message : e}`)
    } catch (_) {}
  }
  if (!refBytes) {
    return c.json({ success: false, error: 'reference_not_found', message: '该角色/事物没有可用的锁定主参考图，无法评分' }, 400)
  }

  const apiKey = String(process.env.MOONSHOT_API_KEY || '').trim()
  // 2026-09-08 评审 provider 可切换：local_vl（默认，本地视觉模型 gemma 经 OMLX）/ kimi（云端，用户显式开启）/ auto（有 key 走 Kimi 否则本地）/ off。
  // 背景：Kimi 周配额（7 天窗口）耗尽时评审全灭；gemma-4-26b-a4b-it-4bit 经 OMLX 实测多模态可用（2026-09-08 用户指令：默认本地优先，Kimi 留给用户自行切换）。
  const studio = await getEffectiveStudioConfig(ROOT)
  const reviewCfg = (studio && studio.effective && studio.effective.review && typeof studio.effective.review === 'object') ? studio.effective.review : {}
  const providerSetting = String(process.env.STUDIO_POSE_REVIEW_PROVIDER || reviewCfg.poseReviewProvider || 'local_vl').trim().toLowerCase()
  if (providerSetting === 'off') {
    return c.json({ success: false, error: 'review_disabled', message: 'AI 评分已在设置中关闭（评审不阻断命名锁定，可人工目检后直接锁定）' }, 501)
  }
  const useKimi = providerSetting === 'kimi' || (providerSetting === 'auto' && Boolean(apiKey))
  const useLocalVl = providerSetting === 'local_vl' || (providerSetting === 'auto' && !apiKey)
  if (useKimi && !apiKey) {
    return c.json({ success: false, error: 'review_unavailable', message: '未配置 MOONSHOT_API_KEY，Kimi 评审不可用；可改 local_vl 或 off' }, 501)
  }

  const startedAt = Date.now()
  try {
    const refSniff = sniffImageMetaFromBytes(refBytes)
    const candBytes = await readFile(candAbs)
    const candSniff = sniffImageMetaFromBytes(candBytes)
    if (!refSniff || !candSniff) {
      return c.json({ success: false, error: 'invalid_image', message: '图片格式不可识别' }, 400)
    }
    let out
    if (useLocalVl) {
      // 本地 VL 输入降采样（≤512px）：VL token 化随分辨率放大，原图会把 prefill 推过 OMLX 内存护栏；
      // 身份/画风/服装评审不需要全分辨率（python3+PIL 本机可用，与 ch.sprite 白底合成同款依赖）
      const shrink = async (absIn) => {
        try {
          const absOut = absIn.replace(/\.(png|jpe?g)$/i, '') + '_vl512.png'
          const s0 = await stat(absIn)
          const s1 = await stat(absOut).catch(() => null)
          if (!(s1 && s1.mtimeMs >= s0.mtimeMs)) {
            await new Promise((resolve, reject) => {
              const py = spawn('python3', ['-c',
                "import sys; from PIL import Image; im=Image.open(sys.argv[1]).convert('RGBA'); bg=Image.new('RGBA', im.size, (255,255,255,255)); bg.alpha_composite(im); im=bg.convert('RGB'); im.thumbnail((512,512)); im.save(sys.argv[2])",
                absIn, absOut])
              py.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('shrink_exit_' + code))))
              py.on('error', reject)
            })
          }
          return await readFile(absOut)
        } catch (_) { return null }
      }
      const refSmallBytes = (refAbsPath ? await shrink(refAbsPath) : null) || refBytes
      const candSmallBytes = (await shrink(candAbs)) || candBytes
      const localBaseUrl = String(reviewCfg.poseReviewBaseUrl || process.env.LOCALOXML_BASE_URL || 'http://127.0.0.1:18888/v1').trim()
      const localModel = String(reviewCfg.poseReviewModel || process.env.STUDIO_POSE_REVIEW_MODEL || 'gemma-4-26b-a4b-it-4bit').trim()
      const localKey = String(process.env.LOCALOXML_API_KEY || 'omlx123').trim()
      out = await reviewCharacterPoseConsistencyWithLocalVl({
        baseUrl: localBaseUrl,
        apiKey: localKey,
        model: localModel,
        characterName,
        referenceImageDataUrl: `data:image/png;base64,${refSmallBytes.toString('base64')}`,
        candidateImageDataUrl: `data:image/png;base64,${candSmallBytes.toString('base64')}`
      })
    } else {
      out = await reviewCharacterPoseConsistencyWithAi({
        apiKey,
        baseUrl: process.env.MOONSHOT_BASE_URL || 'https://api.kimi.com/coding/v1',
        model: 'kimi-for-coding',
        characterName,
        referenceImageDataUrl: `data:${refSniff.contentType};base64,${refBytes.toString('base64')}`,
        candidateImageDataUrl: `data:${candSniff.contentType};base64,${candBytes.toString('base64')}`
      })
    }
    try {
      console.log(`[gamestudio] ch.pose_review:ok project=${id} ch=${characterId} score=${out.score} provider=${out.meta?.provider || '?'} ms=${Math.max(0, Date.now() - startedAt)}`)
    } catch (_) {}
    return c.json({ success: true, score: out.score, reason: out.reason, provider: out.meta?.provider || null })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    try {
      console.log(`[gamestudio] ch.pose_review:fail project=${id} ch=${characterId} ms=${Math.max(0, Date.now() - startedAt)} err=${msg}`)
    } catch (_) {}
    return c.json({ success: false, error: 'ai_failed', message: msg }, 502)
  }
})

// AI：姿势变体——AI 生成姿势提示词（中文稿 → 翻译英文稿，与主流程「中文稿→英文稿」双稿一致）。
// 2026-09-01 新增：只写视角/动作/表情/手势 + 服装延续约束，严禁背景场景词；失败显式报错不伪造。
// 中文稿生成与英文稿翻译串行执行（本地模型同模型多次调用禁止并行，OMLX KV 护栏）。
app.post('/api/projects/:id/ai/character/pose-prompt', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const characterName = String(body?.characterName || '').trim()
  if (!characterName) return c.json({ success: false, error: 'missing_characterName', message: 'characterName 不能为空' }, 400)
  const fingerprintPrompt = String(body?.fingerprintPrompt || '').trim()
  const sceneText = String(body?.sceneText || '').trim()
  const userHint = String(body?.userHint || '').trim()
  // 2026-09-02 评分反馈闭环：可选评审理由，生成指令里让模型针对性改进
  const reviewFeedback = String(body?.reviewFeedback || '').trim()

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.prompt) {
    return c.json({ success: false, error: 'disabled', message: '“提示词生成”已在设置中关闭' }, 503)
  }

  const startedAt = Date.now()
  try {
    console.log(
      `[gamestudio] ch.pose_prompt:start project=${id} provider=${studio.effective.prompt.provider || 'localoxml'} model=${studio.effective.prompt.model || '-'} name=${characterName} sceneChars=${sceneText.length} hintChars=${userHint.length}`
    )
  } catch (_) {}

  try {
    // 2026-09-01 实测：OMLX 偶发把 token 烧进 reasoning 导致空输出（empty_ai_output），串行重试一次兜底（不并行，守 KV 护栏）
    let gen = null
    let lastErr = null
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        gen = await generateCharacterPosePrompt({
          characterName,
          fingerprintPrompt,
          sceneText,
          userHint,
          reviewFeedback,
          provider: studio.effective.prompt.provider,
          model: studio.effective.prompt.model,
          apiUrl: studio.effective.prompt.apiUrl,
          proxyUrl: studio.effective.network.proxyUrl
        })
        break
      } catch (e) {
        lastErr = e
        try {
          console.log(`[gamestudio] ch.pose_prompt:retry project=${id} attempt=${attempt} err=${e && e.message ? String(e.message) : String(e)}`)
        } catch (_) {}
      }
    }
    if (!gen) throw lastErr || new Error('pose_prompt_failed')
    const promptZhRaw = String(gen.result?.posePromptZh || '').trim()
    if (!promptZhRaw) throw new Error('invalid_pose_prompt_response')
    // 2026-09-01 轻量清洗：剥掉漏网的背景词（指令已禁背景，模型偶尔仍带「纯白背景」尾巴，会与绿幕提示词打架）
    const promptZh = promptZhRaw
      .replace(/[，,、；;\s]*(纯白|纯绿|纯色|单色|简洁|干净|简单)?背景[^，,、；;]*/g, '')
      .replace(/[，,、；;]{2,}/g, '，')
      .replace(/^[，,、；;\s]+|[，,、；;\s]+$/g, '')
      .trim()
    if (!promptZh) throw new Error('invalid_pose_prompt_response')
    // 中文稿 → 英文稿（生图链路只认英文；与主流程同一翻译 helper）
    const tr = await translatePromptText({
      provider: studio.effective.prompt.provider,
      model: studio.effective.prompt.model || undefined,
      apiUrl: studio.effective.prompt.apiUrl || undefined,
      proxyUrl: studio.effective.network.proxyUrl || undefined,
      timeoutMs: 60_000,
      text: promptZh,
      sourceLang: 'zh',
      targetLang: 'en',
      mode: 'prompt'
    })
    const promptEn = String(tr.result?.translatedText || '').trim()
    if (!promptEn) throw new Error('pose_prompt_translate_empty')
    try {
      console.log(`[gamestudio] ch.pose_prompt:ok project=${id} ms=${Math.max(0, Date.now() - startedAt)} zhChars=${promptZh.length} enChars=${promptEn.length}`)
    } catch (_) {}
    return c.json({ success: true, result: { promptZh, promptEn }, meta: gen.meta || null })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    try {
      console.log(`[gamestudio] ch.pose_prompt:fail project=${id} ms=${Math.max(0, Date.now() - startedAt)} err=${msg}`)
    } catch (_) {}
    return c.json({ success: false, error: 'ai_failed', message: msg }, 502)
  }
})

// AI：生成角色参考图（用于 IP-Adapter 锁定角色一致性；不做绿幕/抠图）
app.post('/api/projects/:id/ai/character/reference', async (c) => {
  await ensureDirs()
  const id = c.req.param('id')
  const dir = projectDir(id)
  if (!(await existsDir(dir))) return c.json({ success: false, error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const characterName = String(body?.characterName || '').trim()
  if (!characterName) return c.json({ success: false, error: 'missing_characterName', message: 'characterName 不能为空' }, 400)
  const globalPrompt = String(body?.globalPrompt || '').trim()
  const fingerprintPrompt = String(body?.fingerprintPrompt || '').trim()
  const negativePromptIn = String(body?.negativePrompt || '').trim()
  const style = normalizeStyleEnum(body?.style)
  const width = clampInt(body?.width, 256, 1536, 768)
  const height = clampInt(body?.height, 256, 1536, 768)

  const studio = await getEffectiveStudioConfig(ROOT)
  if (!studio.effective.enabled.image) {
    return c.json({ success: false, error: 'disabled', message: '“出图（背景图生成）”已在设置中关闭' }, 503)
  }
  const imgProvider = String(studio.effective.image.provider || process.env.STUDIO_BG_PROVIDER || 'sdwebui').toLowerCase()

  const refHint =
    `Reference portrait for a single character,` +
    ` clean simple background (light neutral),` +
    ` chest-up or half-body,` +
    ` looking at camera,` +
    ` consistent outfit and face,` +
    ` no extra characters, no props unless described,` +
    ` no scene environment`

  const prompt = [
    globalPrompt,
    `风格：${styleNameZh(style)}（${style}）`,
    `角色名：${characterName}`,
    fingerprintPrompt,
    refHint
  ]
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('，')

  const negBase = [
    'text',
    'watermark',
    'logo',
    'qr code',
    'low quality',
    'blurry',
    'deformed',
    'photorealistic',
    'realistic skin texture',
    'multiple characters',
    'crowd',
    'complex background',
    'busy environment'
  ].join(', ')

  const negativePrompt = [negativePromptIn, negBase].map((s) => String(s || '').trim()).filter(Boolean).join(', ')

  const startedAt = Date.now()
  try {
    console.log(
      `[gamestudio] ch.ref:start project=${id} provider=${imgProvider} model=${studio.effective.image.model || '-'} name=${characterName} w=${width} h=${height} style=${style} promptChars=${prompt.length}`
    )
  } catch (_) {}

  try {
    const gen = await generateBackgroundImage({
      prompt,
      negativePrompt,
      width,
      height,
      steps: body?.steps,
      cfgScale: body?.cfgScale,
      guidanceScale: body?.guidanceScale,
      sequentialImageGeneration: body?.sequentialImageGeneration,
      provider: imgProvider,
      sdwebuiBaseUrl: studio.effective.image.sdwebuiBaseUrl,
      comfyuiBaseUrl: studio.effective.image.comfyuiBaseUrl,
      apiUrl: studio.effective.image.apiUrl,
      model: studio.effective.image.model,
      loras: studio.effective.image.loras,
      proxyUrl: studio.effective.network.proxyUrl
    })

    const buf = gen.bytes
    const ext0 = String(gen.ext || 'png').replace(/[^a-z0-9]+/gi, '') || 'png'
    const sniff = sniffImageMetaFromBytes(buf)
    const ext = (sniff && sniff.ext ? sniff.ext : ext0) || 'png'

    const relDir = path.join('assets', 'ai', 'character_refs')
    const outDir = path.join(dir, relDir)
    await mkdir(outDir, { recursive: true })
    const safe = String(characterName || 'character').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]+/g, '_').slice(0, 24) || 'character'
    const fname = `ref_${safe}_${Date.now()}.${ext}`
    const abs = path.join(outDir, fname)
    await writeFile(abs, buf)

    let assetPath = `${relDir}/${fname}`.replace(/\\/g, '/')
    { // 2026-09-09 出图即压：角色主参考无损 WebP（真相源零质量损失）
      const opt = await optimizeGeneratedImage(abs, IMAGE_KIND.SPRITE_LOSSLESS).catch(() => null)
      if (opt && opt.outPath && opt.outPath !== abs) assetPath = String(assetPathFromAbsolute(id, opt.outPath) || assetPath)
    }
    const provider = (gen && gen.meta && gen.meta.provider) ? String(gen.meta.provider) : imgProvider
    const remoteUrl = (gen && gen.meta && typeof gen.meta.url === 'string' && gen.meta.url.trim()) ? String(gen.meta.url).trim() : ''
    try {
      console.log(`[gamestudio] ch.ref:ok project=${id} provider=${provider} bytes=${buf.length} ext=${ext} ms=${Math.max(0, Date.now() - startedAt)}`)
    } catch (_) {}
    return c.json({ success: true, provider, assetPath, url: `/project-assets/${encodeURIComponent(String(id))}/${assetPath}`, remoteUrl, prompt, negativePrompt })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e)
    const status = e && typeof e.status === 'number' ? e.status : null
    try {
      console.log(`[gamestudio] ch.ref:fail project=${id} provider=${imgProvider} status=${status == null ? '-' : status} ms=${Math.max(0, Date.now() - startedAt)} err=${msg}`)
    } catch (_) {}
    if (status === 501) return c.json({ success: false, error: 'provider_not_configured', message: msg }, 501)
    return c.json({ success: false, error: 'ai_failed', message: msg }, 502)
  }
})

// 2026-10-05 编辑器生产构建托管：apps/editor/dist 由本服务直接伺服（入口 / 与 /assets/*）。
// 以后编辑器改动 = 构建 + 本服务重启；前端 buildId 探针发现变化即自动刷新——
// 日常不再需要 Vite dev 服务器，也不再有"改了界面浏览器不更新"的缓存纠缠。
const EDITOR_DIST = path.resolve(__dirname, '..', '..', 'editor', 'dist')
const editorDistReady = existsSync(path.join(EDITOR_DIST, 'index.html'))
if (editorDistReady) {
  app.use('/assets/*', serveStatic({ root: EDITOR_DIST }))
  app.get('/', async (c) => {
    const html = await readFile(path.join(EDITOR_DIST, 'index.html'), 'utf-8').catch(() => null)
    if (!html) return c.text('gamestudio_server')
    return c.html(html)
  })
} else {
  app.get('/', (c) => c.text('gamestudio_server'))
}

export default app

function isMainModule() {
  try {
    const entry = process.argv[1]
    if (!entry) return false
    return import.meta.url === pathToFileURL(entry).href
  } catch (_) {
    return false
  }
}

if (isMainModule()) {
  const port = Number(process.env.PORT || 1999)
  serve({ fetch: app.fetch, port })
  // eslint-disable-next-line no-console
  console.log(`[gamestudio] server on :${port}`)
  // AUTO-E03：重启后扫描项目内批量队列 checkpoint，从断点继续（不重复已成功场景）
  resumeInterruptedSceneBatchesAfterRestart()
    .then((count) => { if (count > 0) console.log(`[gamestudio] scene batch restart-resume: ${count} 个未完成批次已恢复`) })
    .catch((e) => { console.warn(`[gamestudio] scene batch restart-resume failed: ${e && e.message ? e.message : e}`) })
}
