// 场景批量渲染运行时 + 图像审核模式判定（2026-10-20 index.js 拆分收尾迁出；函数体逐字未改，唯一例外见下）
// 唯一改动：makeSceneBatchRunner 内的 `app.request` → `appRef.request`（app 实例经 registerSceneBatchApp 由装配壳注入，语义不变）
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { genId } from './scripts.js'
import { sniffImageMetaFromBytes, verifyStoryAssetReferenceFile } from './storyAssetReferenceGate.js'
import { reviewSceneBackgroundWithAi, reviewSceneBackgroundWithLocalVl } from './sceneBackgroundReview.js'
import { createAiTask, updateAiTask } from './taskProgress.js'
import { findInterruptedSceneBatches, resumeSceneBatch } from './sceneBatchQueue.js'
import { getImageReview } from '../review/imageReviewStore.js'
import { recordCreationEvent } from '../creationBuffer.js'
import { logStage } from './runtime.js'
import { nowIso, PROJECTS_DIR, readJson, writeJson } from '../studio/storeFs.js'
import { readStoryAssetPlanIfExists, saveStoryAssetPlan } from './storyAssetPlanStore.js'

let appRef = null
export function registerSceneBatchApp(app) {
  appRef = app
}

// [拆分] POST /api/projects/:id/ai/story/assets/inherit 已迁至 apps/server/src/routes/storyAssets.routes.js
// [拆分] POST /api/projects/:id/ai/story/assets/reference 已迁至 apps/server/src/routes/storyAssets.routes.js
// [拆分] POST /api/projects/:id/ai/story/assets/reference/review 已迁至 apps/server/src/routes/storyAssets.routes.js
// [拆分] POST /api/projects/:id/ai/story/assets/reference/optimize 已迁至 apps/server/src/routes/storyAssets.routes.js
// [拆分] GET /api/projects/:id/ai/story/assets/:assetId/gallery 已迁至 apps/server/src/routes/storyAssets.routes.js
// [拆分] POST /api/projects/:id/ai/story/assets/:assetId/prompt-enhance 已迁至 apps/server/src/routes/storyAssets.routes.js
// [拆分] POST /api/projects/:id/ai/story/assets/:assetId/gallery/delete 已迁至 apps/server/src/routes/storyAssets.routes.js
// [拆分] POST /api/projects/:id/ai/story/assets/reference/select 已迁至 apps/server/src/routes/storyAssets.routes.js
// [拆分] POST /api/projects/:id/ai/story/assets/lineart 已迁至 apps/server/src/routes/storyAssets.routes.js
// ---- 图片生成审核门禁 ----
// 模式：manual（人工审核，默认）/ ai_only（AI 评审即终审）/ off（全自动）
// 优先级：请求头 x-image-review-mode > body.reviewMode > 环境变量 STUDIO_IMAGE_REVIEW_MODE > manual
export function resolveImageReviewMode(c, body) {
  const header = String(c.req.header('x-image-review-mode') || '').trim()
  if (header === 'off' || header === 'ai_only' || header === 'manual') return header
  const fromBody = String(body && body.reviewMode || '').trim()
  if (fromBody === 'off' || fromBody === 'ai_only' || fromBody === 'manual') return fromBody
  const fromEnv = String(process.env.STUDIO_IMAGE_REVIEW_MODE || '').trim()
  if (fromEnv === 'off' || fromEnv === 'ai_only' || fromEnv === 'manual') return fromEnv
  return 'manual'
}

// 出图前审核旁路检查：携带已批准的 pre_generate 审核 id 时放行
export async function hasApprovedPreGenerate(dir, c) {
  const token = String(c.req.header('x-pre-generate-approved') || '').trim()
  if (!token) return false
  const review = await getImageReview(dir, token)
  return Boolean(review && review.phase === 'pre_generate' && review.status === 'approved')
}

// 锁定写入（lock test Step D 与 lock_confirm approve 共用）
// S4-01：写入前验证文件真实存在且为有效图片；缺失/损坏时抛出带 code 的错误，禁止写假引用
export async function persistPrimaryReferenceLock(id, dir, assetId, assetPath) {
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
export async function persistSceneBackgroundBinding({ dir, rawProject, story, sceneId, sceneName, assetPath, prompt, provider, remoteUrl, references }) {
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
export async function reviewSceneBackgroundForBind({ id, dir, studio, renderSpec, sceneId, assetPath }) {
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

// 进程内执行守卫：防止 resume/重启扫描与正在执行的批次并发双跑
export const activeSceneBatchProjects = new Set()

// 装配批次执行器：renderScene 经 app.request 走单 scene render 路由完整门禁（reference gate/审核/回填）
export function makeSceneBatchRunner(id, task, { reviewMode, approvedToken, renderPayload } = {}) {
  const renderScene = async (sceneId) => {
    try {
      const resp = await appRef.request(`/api/projects/${encodeURIComponent(id)}/ai/story/scenes/${encodeURIComponent(sceneId)}/render`, {
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

export function finalizeSceneBatchTask(task, done) {
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
export function launchSceneBatch(id, task, run) {
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

export function hasOpenSceneBatch(batch) {
  if (!batch) return false
  if (batch.status === 'running' || batch.status === 'queued') return true
  return batch.items.some((it) => it.status === 'queued' || it.status === 'running')
}

// 重启恢复：扫描所有项目的 per-scene checkpoint，未完成批次从断点继续（已成功场景由成功保护跳过）
export async function resumeInterruptedSceneBatchesAfterRestart() {
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
