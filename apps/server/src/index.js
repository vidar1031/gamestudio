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
import { generateBackgroundImage, generateComfyuiLineartFromReference, generateComfyuiCutoutFromReference, generateComfyuiPoseVariantSprite, mapComfySampler, mapComfyScheduler, normalizeComfyCheckpointName, parseComfyTimeoutMs, runComfyuiPromptWorkflow } from './ai/background.js'
import { generateBackgroundPrompt } from './ai/imagePrompt.js'
import { reviewStoryPromptLocally, reviewStoryPromptWithAi } from './ai/promptReview.js'
import { generateStoryboardGlobalPromptWithAi, normalizeStoryboardPromptReviewInput, reviewStoryboardPromptLocally, reviewStoryboardPromptWithAi } from './ai/storyboardPromptReview.js'
import { deletePromptTemplate, generateStoryPromptTemplate, listPromptTemplates, savePromptTemplate } from './ai/promptTemplates.js'
import { addPromptLibraryEntry, deletePromptLibraryEntry, listPromptLibraryEntries, updatePromptLibraryEntry } from './ai/promptLibrary.js'
import { enhanceStoryAssetPromptWithAi } from './ai/storyAssetPromptEnhance.js'
import { generateCharacterFingerprint, generateCharacterPosePrompt } from './ai/characterPrompt.js'
import { generateStoryBible } from './ai/storyBible.js'
import { buildPoseStateExtractionInput, extractStoryPoseStates } from './ai/storyPoseStates.js'
import { buildPoseVariantPrompt, generatePoseVariantForGroup, groupPoseRequirements, isAnimalLikeAnchor, loadPoseLibraryManifest } from './ai/storyPoseVariants.js'
import { buildPropStateExtractionInput, extractStoryPropStates } from './ai/storyPropStates.js'
import { buildStatesDoc, buildStoryStateExtractionInput, carrierSkillIdForStateKey, extractStoryStates, findStateGaps, mergeStoryStatesIntoPlan, resolveStateBoundVariant, STORY_STATE_UNCHANGED } from './ai/storyStates.js'
import { assertStoryAssetPlanValid } from './ai/planContract.js'
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
import { readStudioModelDialogs } from './ai/modelDialogs.js'
import { runStorySceneReview, appendSceneReviewFeedback, readLatestSceneReviewRound } from './ai/storySceneReview.js'
import { getCraftSkill, resolveCarrierPlacementPlan } from './ai/craftLibrary.js'
import { reviewBlueprintLocally } from './ai/blueprintReviewLocal.js'
import { registerStoryStatesRoutes } from './routes/storyStates.routes.js'
import dns from 'node:dns/promises'
import { getEffectiveStudioConfig, redactEffectiveStudioConfigForClient, redactStudioSettingsForClient, writeStudioSettings } from './studio/settings.js'
import { normalizeProjectDoc } from './studio/projectState.js'
import { getStudioSecret } from './studio/secrets.js'
import { storyInputGate } from './middleware/storyInputGate.js'
import { registerStudioRoutes } from './routes/studio.routes.js'
import { registerReviewRoutes } from './routes/review.routes.js'
import { registerStoryAssetsRoutes } from './routes/storyAssets.routes.js'
import { registerProjectOpsRoutes } from './routes/projectOps.routes.js'
import { registerStoryRoutes } from './routes/story.routes.js'
import { registerStoryScenesRoutes } from './routes/storyScenes.routes.js'
import { registerExportRoutes } from './routes/export.routes.js'
import { registerStorySpritesRoutes } from './routes/storySprites.routes.js'

// [拆分回收] 迁移波误吸入 routes 的共享辅助定义（函数/常量），回到本文件作为 ctx 装配的真相源。
// [拆分收尾 2026-10-20] 存储与路径常量/助手迁出至 studio/storeFs.js（下方 import 回补，ctx 键名不变）。
// ---------------------------------------------------------------------------
import { DEMO_LIBRARY_DIR, DEFAULT_ROOT, EDITOR_DIST, ENV_ROOT, PROJECT_ROOT, PROJECTS_DIR, ROOT, TOOL_VERSION, demoLibDir, ensureDirs, existsDir, existsFile, normalizeLocalPath, parseJsonObjectText, probeHttpOk, projectBuildDir, projectBuildsDir, projectDir, projectStoryAssetsDir, projectStoryAssetsPlanPath, readJson, readProjectBundle, readStoryBibleFromProjectDoc, writeJson } from './studio/storeFs.js'
// [拆分收尾 2026-10-20] ComfyUI/SD-WebUI 探测助手迁出至 ai/comfyScan.js
import { collectComfyCapabilities, extractComfyChoiceList, extractStringListFromUnknown, fetchComfyModelList, hasAnyModelFile, hasAnyModelInDirs, isDir, normalizeComfyLoraKey, normalizeComfyModelKey, normalizeComfyModelName, normalizeComfyuiBaseUrl, normalizeConfiguredLoraNames, normalizeSdwebuiBaseUrl, pickCheckpointDir, pickExistingDir, pickLoraDir, probeComfyAnyNode, resolveSdWebuiModelsBase, scanModelFiles } from './ai/comfyScan.js'
// [拆分收尾 2026-10-20] 故事资产文本/路径助手迁出至 ai/storyAssetText.js
import { ANIMAL_ANCHOR_RE, buildStoryAssetComfyPrefix, buildStoryAssetFileTarget, buildStoryAssetStorageInfo, buildStoryAssetUsageContext, chooseStoryboardAssetLoras, containsStoryAssetMeaning, findStoryAssetScenes, getDatePartsForStoryAssets, getManagedStoryAssetPrefixes, getStoryAssetDateFolder, getStoryAssetTimeZone, getStoryAssetTimestampToken, hasAnimalSignals, hasCjkText, hasHumanSignals, isManagedStoryAssetPathForAsset, isStoryAssetBobberLike, isStoryAssetBucketLike, isStoryAssetButterflyLike, isStoryAssetFishLike, isStoryAssetRodLike, limitStoryAssetText, looksLikeEnglishPrompt, normalizeStoryAssetUri, pickBestStoryboardAssetModel, pickEnglishPrompt, resolveStoryboardAssetModel, sanitizeProtectedAssetPrompt, sanitizeStoryAssetPromptZh, splitStoryAssetPromptParts, storyAssetCategoryFolder, storyAssetCheckpointCandidates, storyAssetSignalHay, storyAssetSlug, storyAssetStr, uniqStoryAssetPromptParts } from './ai/storyAssetText.js'
import { nowIso } from './studio/storeFs.js'
// [拆分收尾 2026-10-20] 故事资产计划读写迁出至 ai/storyAssetPlanStore.js
import { readStoryAssetPlanIfExists, saveStoryAssetPlan, storyAssetPlanWriteChains } from './ai/storyAssetPlanStore.js'
// [拆分收尾 2026-10-20] 故事资产画廊/提示词增强评分迁出至 ai/storyAssetGalleryPrompt.js
import { buildStoryAssetGalleryEntries, buildStoryAssetPromptEnhancement, cleanupEmptyStoryAssetDirs, deleteStoryAssetManagedFile, inferStoryAssetGalleryKind, labelForStoryAssetGalleryKind, pruneMissingStoryAssetGalleryEntries, scoreStoryAssetPromptCandidate, storyAssetCreatedAtFallback, translateStoryAssetPromptPair } from './ai/storyAssetGalleryPrompt.js'
// [拆分收尾 2026-10-20] 项目文档默认值/阶段派生迁出至 studio/projectDoc.js
import { clampInt, defaultBlueprint, defaultMeta, defaultScripts, defaultStory, deriveProjectStage, deriveProjectStageFromDisk, normalizeAiStoryFormula, normalizeProjectAndDetectChanges, touchProjectUpdatedAt, writeAiDraftProject } from './studio/projectDoc.js'
// [拆分收尾 2026-10-20] 脚本草稿拟合迁出至 ai/scriptDraftFit.js
import { buildScriptsFromDraftCards, collectBlockingScriptIssues, fitScriptCardsToFormula, generateClosedScriptDraft, summarizeScriptIssues } from './ai/scriptDraftFit.js'
// [拆分收尾 2026-10-20] 导出构建/打包迁出至 studio/exportDist.js
import { buildProjectDistForExport, packageDistAsZip, runCommand, sanitizeExportIndexHtml } from './studio/exportDist.js'
// [拆分收尾 2026-10-20] 项目间故事资产继承迁出至 studio/inheritStoryAssets.js
import { copyProjectAssetFile, findProjectIdByTitle, inheritStoryAssetsFromProject, maybeAutoInheritStoryAssets, resolveInheritBaseTitle } from './studio/inheritStoryAssets.js'
// [拆分收尾 2026-10-20] 场景批量渲染运行时迁出至 ai/sceneBatchRuntime.js（app 实例经 registerSceneBatchApp 注入）
import { activeSceneBatchProjects, finalizeSceneBatchTask, hasApprovedPreGenerate, hasOpenSceneBatch, launchSceneBatch, makeSceneBatchRunner, persistPrimaryReferenceLock, persistSceneBackgroundBinding, registerSceneBatchApp, resolveImageReviewMode, resumeInterruptedSceneBatchesAfterRestart, reviewSceneBackgroundForBind } from './ai/sceneBatchRuntime.js'
// [拆分收尾 2026-10-20] 摆放画像迁出至 ai/placementProfile.js
import { BLANK_SKELETON_PNG_BYTES, BUCKET_PROP_PATTERN, FISH_PROP_PATTERN, FLYING_PROP_PATTERN, associatedPropProjectAssetIds, defaultPlacementScale, defaultPlacementX, findProjectCharacterForStoryAsset, propAssetSignalText, propPlacementProfile, propPlacementTransform, resolvePropPlacementImageAsset } from './ai/placementProfile.js'
// [拆分收尾 2026-10-20] 故事资产参考图管线迁出至 ai/storyAssetReferencePipeline.js
import { applyCutoutToStoryAssetReference, archiveExistingAssetForReplacement, assetPathFromAbsolute, backfillStoryAssetPromptDraftZh, deriveStoryAssetReferenceStatus, generateAndPersistStoryAssetReference, getStoryAssetRenderSize, isExternallyReachableReferenceUrl, maybeCloseRenderAllBatchTask, openFolderOnHost, persistStoryAssetLineartResult, persistStoryAssetReferenceBatch, readProjectJson, resolveAssetPathFromUri, reviewAndPersistStoryAssetReference, setPrimaryStoryAssetReference, shouldDiscardStoryAssetReferenceCandidate, storyAssetReviewScore, writeStoryAssetPrimaryToProject } from './ai/storyAssetReferencePipeline.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)



const app = new Hono()
// [拆分收尾 2026-10-20] 场景批量运行时经注册拿 app 实例（sceneBatchRuntime.js 内 appRef.request 进程内调用）
registerSceneBatchApp(app)

// Load .env/.env.local for local development (do not commit secrets).
const envInfo = loadEnv({ startDirs: [PROJECT_ROOT], maxHops: 1 })
try {
  const provider = String(process.env.STUDIO_AI_PROVIDER || 'local')
  const hasOpenAIKey = Boolean(String(process.env.OPENAI_API_KEY || '').trim())
  const hasLocalOxmlKey = Boolean(String(process.env.LOCALOXML_API_KEY || process.env.STUDIO_AI_API_KEY || process.env.OPENAI_API_KEY || '').trim())
  const model = String(process.env.LOCALOXML_MODEL || process.env.STUDIO_AI_MODEL || process.env.OPENAI_MODEL || '')
  console.log(
    `[talkscene] env loaded=${envInfo.loaded.length ? envInfo.loaded.join(',') : '(none)'} aiProvider=${provider} localoxmlKey=${hasLocalOxmlKey ? 'set' : 'missing'} openaiKey=${hasOpenAIKey ? 'set' : 'missing'}${model ? ` model=${model}` : ''} aiInit=manual_only`
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
// [拆分] GET /api/health 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] GET /favicon.ico 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] GET /api/events/registry 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] GET /api/capabilities 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] GET /api/runtime/status 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] GET /api/studio/selfcheck 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] GET /api/ai/status 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] POST /api/ai/diagnose 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] GET /api/ai/models 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] GET /api/studio/settings 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] PUT /api/studio/settings 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] GET /api/studio/sdwebui/models 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] GET /api/studio/comfyui/models 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] POST /api/studio/image/preflight 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] POST /api/studio/image/models 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] POST /api/studio/image/test 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] POST /api/studio/diagnose 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] GET /api/ai/rules 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] PUT /api/ai/rules 已迁至 apps/server/src/routes/studio.routes.js
// [拆分] POST /api/ai/prompt/review 已迁至 apps/server/src/routes/review.routes.js
// [拆分] POST /api/projects/:id/ai/storyboard/prompt-review 已迁至 apps/server/src/routes/review.routes.js
// [拆分] POST /api/projects/:id/ai/storyboard/global-prompt-generate 已迁至 apps/server/src/routes/storyAssets.routes.js
// [拆分] GET /api/demos 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] GET /api/demos/:id 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] GET /demo-library/:demoId/:rest{.*} 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] GET /demos/:projectId/:buildId/:rest{.*} 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] GET /project-assets/:projectId/assets/uploads/:file 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] GET /project-assets/:projectId/:rest{.*} 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] GET /api/projects/:id/assets/ai 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] POST /api/projects/:id/assets/open-folder 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] POST /api/projects/:id/assets/upload 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] GET /api/assets-library 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] POST /api/projects/:id/assets/compress 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] POST /api/projects/:id/assets/import 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] POST /api/projects/:id/ai/background 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] POST /api/projects/:id/ai/background/prompt 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] POST /api/projects/:id/ai/story/bible 已迁至 routes/story.routes.js（扫尾波）
// ---------------------------------------------------------------------------
// 2026-10-10 圣经质检步（GS-50）：sceneRefs 与剧情一致性校验+自动修正。
// 背景：LLM 生成的 bible 顶层 sceneRefs 错绑是最高频生产事故（白雪公主 7/11 场景错绑、
// 小明2 结局错绑、龟兔漏绑），此前全靠人工读剧情修正。本端点：确定性规则检查 +
// 逐场景 LLM 对照复核（1 场 1 调用）+ persist=true 时回写 bible.sceneRefs（写盘带 _rev）。
// 写盘后旧资产计划作废（plan 由 sceneRefs 派生，修正后必须重建）。
// ---------------------------------------------------------------------------
// [拆分] POST /api/projects/:id/ai/story/bible/qc 已迁至 routes/story.routes.js（扫尾波）
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











// [拆分] GET /api/projects/:id/ai/tasks 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] GET /api/projects/:id/ai/model-dialogs 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] GET /api/projects/:id/ai/tasks/:taskId 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] GET /api/projects/:id/ai/coverage 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] GET /api/projects/:id/creation-buffer 已迁至 apps/server/src/routes/projectOps.routes.js
// ---------------------------------------------------------------------------
// 场景图版本管理（2026-08-30 用户指令：场景图需要可管理——历史版本查看/换绑/删除）
// 文件真相源：assets/ai/story_scenes/<sceneId>_<时间戳>.<ext>
// ---------------------------------------------------------------------------

// [拆分] POST /api/projects/:id/ai/story/completeness-check 已迁至 apps/server/src/routes/projectOps.routes.js
// [拆分] GET /api/projects/:id/ai/story/completeness-check/latest 已迁至 apps/server/src/routes/projectOps.routes.js
// ---------------------------------------------------------------------------
// AUTO-E03 / S4-03：批量场景生产队列（scene item 队列）
// 与 render-all 的区别：per-scene checkpoint 落盘（story-assets/scene-batch-queue.json）、
// C02 同源失败分类退避重试、成功保护不重复生成、重启后从断点继续。
// 批量入口与 render-all 一致不挂 storyInputGate（契约枚举未覆盖批量类型）。
// ---------------------------------------------------------------------------






// [拆分] POST /api/projects/:id/ai/story/scenes/batch 已迁至 apps/server/src/routes/storyScenes.routes.js
// [拆分] GET /api/projects/:id/ai/story/scenes/batch 已迁至 apps/server/src/routes/storyScenes.routes.js
// [拆分] POST /api/projects/:id/ai/story/scenes/batch/resume 已迁至 apps/server/src/routes/storyScenes.routes.js
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











// [W1] 载体变体端点已迁至 routes/storyStates.routes.js

// [拆分] POST /api/projects/:id/ai/story/scenes/:sceneId/layered-produce 已迁至 apps/server/src/routes/storyScenes.routes.js
// ---------------------------------------------------------------------------
// [W1 模块化拆分] 状态机族 6 端点已迁至 ./routes/storyStates.routes.js；此处仅装配。
// 注意：storyStatesRouteCtx 引用的 index 本地辅助全部为函数声明（提升可用）；
// BLANK_SKELETON_PNG_BYTES 为 const，定义点（载体变体端点上方）必须早于本装配行。
// ---------------------------------------------------------------------------
function storyStatesRouteCtx() {
  return {
    ensureDirs, projectDir, projectStoryAssetsDir, existsDir, existsFile,
    readJson, writeJson, readProjectBundle, readStoryAssetPlanIfExists, saveStoryAssetPlan,
    readStoryBibleFromProjectDoc, nowIso, clampInt, translateStoryAssetPromptPair,
    BLANK_SKELETON_PNG_BYTES, ROOT, assetPathFromAbsolute
  }
}
registerStoryStatesRoutes(app, storyStatesRouteCtx())





















// [模块化拆分] 路由装配区：各族端点已迁至 routes/*.routes.js；注册顺序保持原文件相对序。
// ---------------------------------------------------------------------------
function buildRouteCtx() {
  return {
    __dirname, readProjectJson,
    ANIMAL_ANCHOR_RE,
    BUCKET_PROP_PATTERN,
    DEFAULT_ROOT,
    DEMO_LIBRARY_DIR,
    EDITOR_DIST,
    ENV_ROOT,
    PROJECTS_DIR,
    ROOT,
    SERVER_BUILD_ID,
    TOOL_VERSION,
    applyCutoutToStoryAssetReference,
    archiveExistingAssetForReplacement,
    asList,
    asStr,
    assetPathFromAbsolute,
    associatedPropProjectAssetIds,
    backfillStoryAssetPromptDraftZh,
    buildProjectDistForExport,
    buildScriptsFromDraftCards,
    buildStoryAssetComfyPrefix,
    buildStoryAssetFileTarget,
    buildStoryAssetGalleryEntries,
    buildStoryAssetPromptEnhancement,
    buildStoryAssetStorageInfo,
    buildStoryAssetUsageContext,
    chooseStoryboardAssetLoras,
    clampInt,
    cleanupEmptyStoryAssetDirs,
    collectBlockingScriptIssues,
    collectComfyCapabilities,
    containsStoryAssetMeaning,
    defaultBlueprint,
    defaultMeta,
    defaultPlacementScale,
    defaultPlacementX,
    defaultScripts,
    defaultStory,
    deleteStoryAssetManagedFile,
    demoLibDir,
    deriveProjectStage,
    deriveProjectStageFromDisk,
    deriveStoryAssetReferenceStatus,
    editorDistFingerprint,
    ensureDirs,
    existsDir,
    existsFile,
    extractComfyChoiceList,
    extractStringListFromUnknown,
    fetchComfyModelList,
    findProjectCharacterForStoryAsset,
    findProjectIdByTitle,
    findStoryAssetScenes,
    fitScriptCardsToFormula,
    generateAndPersistStoryAssetReference,
    generateClosedScriptDraft,
    getDatePartsForStoryAssets,
    getManagedStoryAssetPrefixes,
    getStoryAssetDateFolder,
    getStoryAssetRenderSize,
    getStoryAssetTimeZone,
    getStoryAssetTimestampToken,
    hasAnimalSignals,
    hasAnyModelFile,
    hasAnyModelInDirs,
    hasApprovedPreGenerate,
    hasCjkText,
    hasHumanSignals,
    hasOpenSceneBatch,
    inferStoryAssetGalleryKind,
    inheritStoryAssetsFromProject,
    isDir,
    isExternallyReachableReferenceUrl,
    isManagedStoryAssetPathForAsset,
    isStoryAssetBobberLike,
    isStoryAssetBucketLike,
    isStoryAssetButterflyLike,
    isStoryAssetFishLike,
    isStoryAssetRodLike,
    labelForStoryAssetGalleryKind,
    launchSceneBatch,
    limitStoryAssetText,
    looksLikeEnglishPrompt,
    makeSceneBatchRunner,
    maybeAutoInheritStoryAssets,
    maybeCloseRenderAllBatchTask,
    normalizeAiStoryFormula,
    normalizeComfyLoraKey,
    normalizeComfyModelKey,
    normalizeComfyModelName,
    normalizeComfyuiBaseUrl,
    normalizeConfiguredLoraNames,
    normalizeLocalPath,
    normalizeProjectAndDetectChanges,
    normalizeSdwebuiBaseUrl,
    normalizeStoryAssetUri,
    normalizeStyleEnum,
    nowIso,
    openFolderOnHost,
    packageDistAsZip,
    parseJsonObjectText,
    persistPrimaryReferenceLock,
    persistSceneBackgroundBinding,
    persistStoryAssetLineartResult,
    persistStoryAssetReferenceBatch,
    pickBestStoryboardAssetModel,
    pickCheckpointDir,
    pickEnglishPrompt,
    pickExistingDir,
    pickLoraDir,
    probeComfyAnyNode,
    probeHttpOk,
    projectBuildDir,
    projectBuildsDir,
    projectDir,
    projectStoryAssetsDir,
    projectStoryAssetsPlanPath,
    propAssetSignalText,
    propPlacementProfile,
    propPlacementTransform,
    pruneMissingStoryAssetGalleryEntries,
    readJson,
    readProjectBundle,
    readStoryAssetPlanIfExists,
    readStoryBibleFromProjectDoc,
    resolveAssetPathFromUri,
    resolveImageReviewMode,
    resolveInheritBaseTitle,
    resolvePropPlacementImageAsset,
    resolveSdWebuiModelsBase,
    resolveStoryboardAssetModel,
    reviewAndPersistStoryAssetReference,
    reviewSceneBackgroundForBind,
    runCommand,
    sanitizeExportIndexHtml,
    sanitizeProtectedAssetPrompt,
    sanitizeStoryAssetPromptZh,
    saveStoryAssetPlan,
    scanModelFiles,
    scoreStoryAssetPromptCandidate,
    setPrimaryStoryAssetReference,
    shouldDiscardStoryAssetReferenceCandidate,
    splitStoryAssetPromptParts,
    storyAssetCategoryFolder,
    storyAssetCheckpointCandidates,
    storyAssetCreatedAtFallback,
    storyAssetReviewScore,
    storyAssetSignalHay,
    storyAssetSlug,
    storyAssetStr,
    styleNameZh,
    summarizeScriptIssues,
    touchProjectUpdatedAt,
    translateStoryAssetPromptPair,
    uniqStoryAssetPromptParts,
    writeAiDraftProject,
    writeJson,
    writeStoryAssetPrimaryToProject
  }
}
registerStudioRoutes(app, buildRouteCtx())
registerReviewRoutes(app, buildRouteCtx())
registerStoryAssetsRoutes(app, buildRouteCtx())
registerProjectOpsRoutes(app, buildRouteCtx())
registerStoryRoutes(app, buildRouteCtx())
registerStoryScenesRoutes(app, buildRouteCtx())
registerExportRoutes(app, buildRouteCtx())
registerStorySpritesRoutes(app, buildRouteCtx())


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

// [拆分] POST /api/projects/:id/ai/character/fingerprint 已迁至 apps/server/src/routes/storySprites.routes.js
// [拆分] POST /api/projects/:id/ai/character/sprite 已迁至 apps/server/src/routes/storySprites.routes.js
// [拆分] POST /api/projects/:id/ai/character/cutout 已迁至 apps/server/src/routes/storySprites.routes.js
// [拆分] POST /api/projects/:id/ai/character/pose-prompt 已迁至 apps/server/src/routes/storySprites.routes.js
// [拆分] POST /api/projects/:id/ai/character/reference 已迁至 apps/server/src/routes/storySprites.routes.js
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
  console.log(`[talkscene] server on :${port}`)
  // AUTO-E03：重启后扫描项目内批量队列 checkpoint，从断点继续（不重复已成功场景）
  resumeInterruptedSceneBatchesAfterRestart()
    .then((count) => { if (count > 0) console.log(`[talkscene] scene batch restart-resume: ${count} 个未完成批次已恢复`) })
    .catch((e) => { console.warn(`[talkscene] scene batch restart-resume failed: ${e && e.message ? e.message : e}`) })
}
