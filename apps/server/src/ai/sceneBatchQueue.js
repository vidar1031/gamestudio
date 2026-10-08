// AUTO-E03 / S4-03：批量场景生产队列（scene item 队列）。
//
// 分层取舍：队列放在 GameStudio Server 的项目内，而不是 control 侧任务编排。理由：
// - 仓库硬规则要求批量渲染这类长任务经 /api/projects/:id/ai/tasks 暴露进度，该机制在 GameStudio Server；
// - 项目产物真相源是 storage/projects/<id>/，per-scene checkpoint 含产物 URI，属于项目数据，
//   随项目目录持久化后，无论 GameStudio 还是 control 重启都能从同一真相源恢复；
// - control 侧 persistentQueue 是跨服务工作流编排层，scene 批量是单项目内生产动作，
//   control 通过本队列的 API 提交并观测 /ai/tasks 即可，无需把 per-scene 状态搬离真相源。
//
// 语义：
// - 串行执行（本地出图为单 GPU 资源，串行保证顺序可观测、checkpoint 语义简单）；顺序 = 提交顺序。
// - per-scene checkpoint：每次 item 状态转移立即原子落盘 <project>/story-assets/scene-batch-queue.json。
// - 失败分类与 C02（apps/control-server/src/server/reasoning/retryPolicy.js）同源：
//   显式错误码信号 > HTTP 状态 > 文本模式 > 保守默认；临时故障退避重试，确定性错误不重试，
//   reference gate（E02）阻断单独归类 blocked，不阻塞后续合法 scene。
// - 成功保护：已绑定成功资产（story 节点 backgroundAssetId + 项目资产文件真实）或存在待人工绑定审核
//   的 scene 默认跳过；仅显式 regenerate 意图才重新生成，且重新生成走单 scene render 路由完整门禁。
// - 重启恢复：启动扫描把 running 批次的中断 item 重置后继续；completed/failed/blocked 终态不重跑。
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { verifyStoryAssetReferenceFile } from './storyAssetReferenceGate.js'
import { listImageReviews } from '../review/imageReviewStore.js'

export const SCENE_BATCH_QUEUE_FILENAME = 'scene-batch-queue.json'

// item 终态：重启恢复与成功保护均不重跑
const TERMINAL_ITEM_STATUS = new Set(['completed', 'failed', 'blocked', 'skipped', 'waiting_review'])

function nowIso() {
  return new Date().toISOString()
}

function asStr(v) {
  return typeof v === 'string' ? v.trim() : ''
}

export function sceneBatchQueuePath(dir) {
  return path.join(dir, 'story-assets', SCENE_BATCH_QUEUE_FILENAME)
}

export async function loadSceneBatch(dir) {
  try {
    const parsed = JSON.parse(await readFile(sceneBatchQueuePath(dir), 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) return null
    return parsed
  } catch (_) {
    return null
  }
}

// 原子写：tmp + rename，避免崩溃留下半个 JSON 污染 checkpoint
export async function saveSceneBatch(dir, batch) {
  const file = sceneBatchQueuePath(dir)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify({ ...batch, updatedAt: nowIso() }, null, 2))
  await rename(tmp, file)
  return batch
}

/**
 * 创建批次并落初始 checkpoint。
 * items: [{ sceneId, sceneName }]，顺序即执行顺序；options 原样持久化（含 regenerate 意图与渲染参数）。
 */
export async function createSceneBatch({ dir, projectId, items, options = {} }) {
  const batch = {
    schemaVersion: '1.0',
    batchId: `scenebatch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    projectId: asStr(projectId),
    status: 'queued',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    options: options && typeof options === 'object' ? options : {},
    items: (Array.isArray(items) ? items : []).map((item, index) => ({
      sceneId: asStr(item.sceneId),
      sceneName: asStr(item.sceneName),
      order: index,
      status: asStr(item.status) || 'queued',
      skipReason: asStr(item.skipReason),
      attempts: 0,
      error: '',
      errorCategory: '',
      errorRule: '',
      assetPath: asStr(item.assetPath),
      projectAssetId: asStr(item.projectAssetId),
      updatedAt: nowIso(),
      history: Array.isArray(item.history) ? item.history : []
    }))
  }
  await saveSceneBatch(dir, batch)
  return batch
}

// ---------------------------------------------------------------------------
// 失败分类（C02 同源语义）
// ---------------------------------------------------------------------------

export const SCENE_FAILURE_CATEGORY = Object.freeze({
  RETRYABLE: 'retryable',
  NON_RETRYABLE: 'non_retryable',
  BLOCKED: 'blocked'
})

// E02 reference gate 错误码：门禁阻断不是故障，不重试，归类 blocked
const REFERENCE_GATE_CODES = new Set([
  'scene_reference_missing',
  'reference_file_missing',
  'reference_file_empty',
  'reference_file_invalid',
  'reference_path_outside_project'
])

// 场景绑定 AI 视觉评审门禁（2026-09-27 F5）：评审未通过且换 seed 重渲仍失败，
// 单场景端点内已完成重试预算，属质量门禁阻断而非故障，批次侧不重试、归类 blocked
const REVIEW_GATE_CODES = new Set([
  'scene_ai_review_failed'
])

// 确定性 provider/输入错误：重跑必现（对齐 C02 schema/权限/确定性业务错误）
const NON_RETRYABLE_CODES = new Set([
  'disabled',
  'user_invalid_input',
  'user_provider_not_configured',
  'provider_invalid_output',
  'system_internal',
  'missing_scene_prompt',
  'missing_story_bible',
  'missing_plan',
  'scene_not_found'
])

// 临时故障错误码（对齐 C02 网络瞬断/5xx 可重试）
const RETRYABLE_CODES = new Set([
  'provider_timeout',
  'provider_unavailable',
  'provider_request_failed'
])

const TRANSIENT_PATTERNS = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /socket hang up/i,
  /fetch failed/i,
  /\btimeout\b/i,
  /timed out/i,
  /temporarily unavailable/i,
  /bad gateway/i,
  /service unavailable/i,
  /rate.?limit/i,
  /overloaded/i
]

/**
 * 确定性分类表。输入 render 结果 { httpStatus, error, message }，输出 { category, rule, reason }。
 * 规则顺序与 C02 一致：显式错误码信号 > HTTP 状态 > 文本模式 > 保守默认（不重试）。
 */
export function classifySceneFailure({ httpStatus, error, message } = {}) {
  const code = asStr(error)
  const detail = `${code} | ${asStr(message)}`

  // 1. reference gate（E02）/ AI 视觉评审门禁（F5）：显式阻断语义，单独归类，绝不重试
  if (REFERENCE_GATE_CODES.has(code) || REVIEW_GATE_CODES.has(code)) {
    return { category: SCENE_FAILURE_CATEGORY.BLOCKED, rule: 'reference_gate_blocked', reason: `命中 reference/review gate（${code}），属门禁阻断而非故障，不重试、不阻塞其他场景。` }
  }
  // 2. 显式确定性错误码：重跑必现
  if (NON_RETRYABLE_CODES.has(code)) {
    return { category: SCENE_FAILURE_CATEGORY.NON_RETRYABLE, rule: `explicit_code_${code}`, reason: `错误码 ${code} 属确定性失败（配置/输入/输出校验），重试必现，不重试。` }
  }
  // 3. 显式临时故障错误码
  if (RETRYABLE_CODES.has(code)) {
    return { category: SCENE_FAILURE_CATEGORY.RETRYABLE, rule: `explicit_code_${code}`, reason: `错误码 ${code} 属临时故障（超时/不可用/5xx），可按退避重试。` }
  }
  // 4. HTTP 状态信号（对齐 C02：408/429/5xx 可重试，其余 4xx 不重试）
  const status = Number(httpStatus)
  if (Number.isFinite(status) && status > 0) {
    if (status === 408 || status === 429 || status >= 500) {
      return { category: SCENE_FAILURE_CATEGORY.RETRYABLE, rule: `http_status_${status}_transient`, reason: `HTTP ${status} 属临时故障（限流/服务端错误），可按退避重试。` }
    }
    if (status >= 400 && status < 500) {
      return { category: SCENE_FAILURE_CATEGORY.NON_RETRYABLE, rule: `http_status_${status}_client_error`, reason: `HTTP ${status} 属客户端错误，重试必现，不重试。` }
    }
  }
  // 5. 无状态的网络层错误（对齐 C02：无 status 的网络错误可重试）
  if (!Number.isFinite(status) || status <= 0) {
    if (!code && !asStr(message)) {
      return { category: SCENE_FAILURE_CATEGORY.NON_RETRYABLE, rule: 'unclassified_default', reason: '无任何错误信号，按保守策略不重试。' }
    }
    return { category: SCENE_FAILURE_CATEGORY.RETRYABLE, rule: 'network_error_no_status', reason: '无 HTTP 状态的网络层错误（连接失败等），可按退避重试。' }
  }
  // 6. 文本模式兜底
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(detail))) {
    return { category: SCENE_FAILURE_CATEGORY.RETRYABLE, rule: 'transient_network_pattern', reason: '错误文本命中网络/临时故障模式，可按退避重试。' }
  }
  // 7. 无法归类：保守默认不重试（不盲目重跑有副作用的生成动作）
  return { category: SCENE_FAILURE_CATEGORY.NON_RETRYABLE, rule: 'unclassified_default', reason: '错误无法归入已知分类，按保守策略不重试。' }
}

// 重试预算：STUDIO_SCENE_BATCH_RETRY_MAX_ATTEMPTS 可覆盖，默认 3 次总尝试（首次 + 2 次重试）
export function resolveSceneBatchMaxAttempts(value) {
  const raw = value ?? process.env.STUDIO_SCENE_BATCH_RETRY_MAX_ATTEMPTS
  if (raw === undefined || raw === null || raw === '') return 3
  const num = Number(raw)
  if (!Number.isFinite(num) || num < 1) return 3
  return Math.floor(num)
}

export function resolveSceneBatchRetryBaseMs(value) {
  const raw = value ?? process.env.STUDIO_SCENE_BATCH_RETRY_BASE_MS
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return 5000
  return Math.floor(num)
}

export function resolveSceneBatchRetryMaxDelayMs(value) {
  const raw = value ?? process.env.STUDIO_SCENE_BATCH_RETRY_MAX_DELAY_MS
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return 60000
  return Math.floor(num)
}

// 指数退避（与 C02 computeRetryBackoffMs 同公式）：第 1 次重试 = baseMs，之后翻倍，封顶 maxDelayMs
export function computeSceneRetryBackoffMs(attempt, { baseMs, maxDelayMs } = {}) {
  const base = Math.max(1, Number(baseMs) || 5000)
  const cap = Math.max(base, Number(maxDelayMs) || 60000)
  const n = Math.max(1, Math.floor(Number(attempt) || 1))
  return Math.min(cap, base * 2 ** (n - 1))
}

// ---------------------------------------------------------------------------
// 成功保护判定
// ---------------------------------------------------------------------------

/**
 * 判定 scene 是否已有成功结果或待人工绑定：
 * - story 节点 visuals.backgroundAssetId 存在且项目资产文件真实 → success（已绑定成功资产）
 * - 存在该 scene 的 pending scene_bind / pre_generate 审核 → pendingReview（生成物待人工确认，不得重复生成）
 * 返回 { success, pendingReview, assetId, assetPath }
 */
export async function checkSceneSuccess({ dir, sceneId }) {
  const sid = asStr(sceneId)
  const story = await readFile(path.join(dir, 'story.json'), 'utf-8').then(JSON.parse).catch(() => null)
  const node = Array.isArray(story?.nodes) ? story.nodes.find((n) => asStr(n && n.id) === sid) : null
  const boundAssetId = asStr(node && node.visuals && node.visuals.backgroundAssetId)

  if (boundAssetId) {
    const project = await readFile(path.join(dir, 'project.json'), 'utf-8').then(JSON.parse).catch(() => null)
    const asset = Array.isArray(project?.assets) ? project.assets.find((a) => asStr(a && a.id) === boundAssetId) : null
    const uri = asStr(asset && asset.uri)
    if (uri) {
      const fileGate = await verifyStoryAssetReferenceFile({ dir, assetPath: uri })
      if (fileGate.ok) return { success: true, pendingReview: false, assetId: boundAssetId, assetPath: uri }
    }
    // 绑定存在但文件不真实：不算成功，允许重跑修复
    return { success: false, pendingReview: false, assetId: boundAssetId, assetPath: uri }
  }

  const pending = await listImageReviews(dir, { status: 'pending' }).catch(() => [])
  const pendingForScene = (Array.isArray(pending) ? pending : []).find((review) => {
    if (asStr(review.sceneId) !== sid) return false
    if (review.phase === 'scene_bind') return true
    return review.phase === 'pre_generate' && asStr(review.targetKey) === `scene_render:${sid}`
  })
  if (pendingForScene) return { success: false, pendingReview: true, reviewId: asStr(pendingForScene.reviewId) }
  return { success: false, pendingReview: false }
}

// regenerate 显式意图：true = 本批次全部重新生成；数组 = 指定 sceneId 重新生成
export function isRegenerateRequested(batch, sceneId) {
  const regen = batch && batch.options ? batch.options.regenerate : undefined
  if (regen === true) return true
  if (Array.isArray(regen)) return regen.map(asStr).includes(asStr(sceneId))
  return false
}

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

function pushHistory(item, event, detail = '') {
  item.history.push({ at: nowIso(), event: asStr(event), detail: asStr(detail) })
  if (item.history.length > 50) item.history = item.history.slice(-50)
}

function summarizeBatchStatus(items) {
  const actionable = items.filter((item) => item.status !== 'skipped')
  const okCount = items.filter((item) => item.status === 'completed' || item.status === 'skipped' || item.status === 'waiting_review').length
  const badCount = items.filter((item) => item.status === 'failed' || item.status === 'blocked').length
  if (!actionable.length) return 'completed'
  if (!badCount) return 'completed'
  if (okCount > 0) return 'partial'
  return 'failed'
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 串行执行批次。每次 item 状态转移立即落 checkpoint（saveSceneBatch）。
 * - renderScene(sceneId, item) → { ok, httpStatus, error, message, assetPath, projectAssetId, pendingReview }
 * - onProgress(batch, item, index) 每次转移后回调（用于 /ai/tasks 进度）
 * - 单 scene 失败只影响自身 item，循环继续后续 scene。
 */
export async function runSceneBatch({ dir, batch, renderScene, onProgress, sleep = defaultSleep, maxAttempts, retryBaseMs, retryMaxDelayMs }) {
  const attemptsCap = resolveSceneBatchMaxAttempts(maxAttempts)
  const baseMs = resolveSceneBatchRetryBaseMs(retryBaseMs)
  const capMs = resolveSceneBatchRetryMaxDelayMs(retryMaxDelayMs)

  if (batch.status !== 'running') {
    batch.status = 'running'
    await saveSceneBatch(dir, batch)
  }

  for (let i = 0; i < batch.items.length; i += 1) {
    const item = batch.items[i]
    if (TERMINAL_ITEM_STATUS.has(item.status)) continue

    // 执行时复查成功保护（提交后可能已被其他路径绑定成功）
    if (!isRegenerateRequested(batch, item.sceneId)) {
      const guard = await checkSceneSuccess({ dir, sceneId: item.sceneId })
      if (guard.success) {
        item.status = 'skipped'
        item.skipReason = 'already_succeeded'
        item.assetPath = asStr(guard.assetPath) || item.assetPath
        item.projectAssetId = asStr(guard.assetId) || item.projectAssetId
        item.updatedAt = nowIso()
        pushHistory(item, 'skipped', '已成功绑定资产，按成功保护跳过')
        await saveSceneBatch(dir, batch)
        if (onProgress) await onProgress(batch, item, i)
        continue
      }
      if (guard.pendingReview) {
        item.status = 'skipped'
        item.skipReason = 'pending_review'
        item.updatedAt = nowIso()
        pushHistory(item, 'skipped', `存在待人工审核（${asStr(guard.reviewId)}），按成功保护跳过`)
        await saveSceneBatch(dir, batch)
        if (onProgress) await onProgress(batch, item, i)
        continue
      }
    }

    item.status = 'running'
    item.updatedAt = nowIso()
    pushHistory(item, 'running', `开始渲染（第 ${item.attempts + 1} 次尝试）`)
    await saveSceneBatch(dir, batch)
    if (onProgress) await onProgress(batch, item, i)

    while (item.attempts < attemptsCap) {
      item.attempts += 1
      let result
      try {
        result = await renderScene(item.sceneId, item)
      } catch (e) {
        result = { ok: false, httpStatus: 0, error: '', message: e && e.message ? String(e.message) : String(e) }
      }
      result = result && typeof result === 'object' ? result : { ok: false, httpStatus: 0, message: 'empty_render_result' }

      if (result.pendingReview) {
        item.status = 'waiting_review'
        item.updatedAt = nowIso()
        pushHistory(item, 'waiting_review', asStr(result.message) || '生成物待人工审核绑定')
        break
      }
      if (result.ok) {
        item.status = 'completed'
        item.assetPath = asStr(result.assetPath)
        item.projectAssetId = asStr(result.projectAssetId)
        item.error = ''
        item.updatedAt = nowIso()
        pushHistory(item, 'completed', asStr(result.assetPath) || 'ok')
        break
      }

      const cls = classifySceneFailure(result)
      item.error = asStr(result.message) || asStr(result.error) || 'render_failed'
      item.errorCategory = cls.category
      item.errorRule = cls.rule
      item.updatedAt = nowIso()
      if (cls.category === SCENE_FAILURE_CATEGORY.BLOCKED) {
        item.status = 'blocked'
        pushHistory(item, 'blocked', `${asStr(result.error)} / ${cls.reason}`)
        break
      }
      if (cls.category === SCENE_FAILURE_CATEGORY.NON_RETRYABLE) {
        item.status = 'failed'
        pushHistory(item, 'failed', `${asStr(result.error)} / ${cls.reason}`)
        break
      }
      // retryable：预算内退避重试，预算耗尽收敛 failed
      if (item.attempts < attemptsCap) {
        const waitMs = computeSceneRetryBackoffMs(item.attempts, { baseMs, maxDelayMs: capMs })
        pushHistory(item, 'retry_wait', `${asStr(result.error)} / ${cls.reason} / ${waitMs}ms 后第 ${item.attempts + 1} 次尝试`)
        item.updatedAt = nowIso()
        await saveSceneBatch(dir, batch)
        if (onProgress) await onProgress(batch, item, i)
        await sleep(waitMs)
        continue
      }
      item.status = 'failed'
      pushHistory(item, 'failed', `${asStr(result.error)} / 重试预算耗尽（${item.attempts}/${attemptsCap}）`)
      break
    }

    await saveSceneBatch(dir, batch)
    if (onProgress) await onProgress(batch, item, i)
  }

  batch.status = summarizeBatchStatus(batch.items)
  await saveSceneBatch(dir, batch)
  return batch
}

/**
 * 恢复批次：中断的 running item 重置为 queued 继续；retryFailed=true 时 failed item
 * 获得全新尝试预算重跑（显式人工恢复意图）。completed/blocked/skipped/waiting_review 终态不动。
 * 无可恢复项时返回 { resumed: false, batch }。
 */
export async function resumeSceneBatch({ dir, renderScene, onProgress, sleep, maxAttempts, retryBaseMs, retryMaxDelayMs, retryFailed = false }) {
  const batch = await loadSceneBatch(dir)
  if (!batch) return { resumed: false, batch: null }

  let hasWork = false
  for (const item of batch.items) {
    if (item.status === 'queued') hasWork = true
    if (item.status === 'running') {
      item.status = 'queued'
      pushHistory(item, 'resumed', '中断的 running 状态重置为 queued（重启恢复）')
      item.updatedAt = nowIso()
      hasWork = true
    }
    if (retryFailed && item.status === 'failed') {
      item.status = 'queued'
      item.attempts = 0
      item.error = ''
      item.errorCategory = ''
      item.errorRule = ''
      pushHistory(item, 'resumed', '显式恢复失败场景，重置尝试预算')
      item.updatedAt = nowIso()
      hasWork = true
    }
  }
  if (!hasWork) return { resumed: false, batch }

  batch.status = 'running'
  await saveSceneBatch(dir, batch)
  const done = await runSceneBatch({ dir, batch, renderScene, onProgress, sleep, maxAttempts, retryBaseMs, retryMaxDelayMs })
  return { resumed: true, batch: done }
}

/**
 * 启动扫描：列出 projectsDir 下所有含未完成批次的项目（status running 或存在 queued/running item）。
 * 返回 [{ projectId, dir, batch }]，由调用方装配 renderScene 后逐一 resumeSceneBatch。
 */
export async function findInterruptedSceneBatches(projectsDir) {
  const out = []
  let entries = []
  try {
    entries = await readdir(projectsDir, { withFileTypes: true })
  } catch (_) {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(projectsDir, entry.name)
    const batch = await loadSceneBatch(dir)
    if (!batch) continue
    const hasOpen = batch.status === 'running' || batch.status === 'queued' || batch.items.some((item) => item.status === 'queued' || item.status === 'running')
    if (hasOpen) out.push({ projectId: entry.name, dir, batch })
  }
  return out
}
