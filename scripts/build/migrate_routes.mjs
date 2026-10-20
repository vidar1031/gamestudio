#!/usr/bin/env node
// 通用路由迁移工具（W1 后续各波复用）：按"方法+路径"精确定位 index.js 中的端点块，
// 整块迁出为 routes/<module>.js 的 register*Routes(app, ctx)，index.js 原地留注册装配。
// 安全机制：区间重叠拒绝、ctx/import 按实际引用机械计算、迁后 index.js 与目标文件双双 --check 由调用方执行。
// 用法：node scripts/build/migrate_routes.mjs <spec.json>   （spec 见 scripts/build/routes_spec.json）
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const INDEX = path.join(ROOT, 'apps/server/src/index.js')
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))

const lines = fs.readFileSync(INDEX, 'utf8').split('\n')

// ---- 端点定位（按方法+路径原文精确匹配行首）
function findRouteLine(method, routePath) {
  const needle = `app.${method}('${routePath}'`
  const hits = []
  lines.forEach((l, i) => { if (l.startsWith(needle)) hits.push(i + 1) })
  if (hits.length !== 1) throw new Error(`定位失败 ${method} ${routePath}: ${hits.length} 处命中`)
  return hits[0]
}

// ---- 块探测（同 W1 规则：注释头吞并需空行分隔；边界=下一 app./段落注释/恢复注释/export default/serve 尾部）
const TAIL_MARKERS = [/^app\.(post|get|put|delete|use)\b/, /^\/\/ ---/, /^\/\/ 重启恢复/, /^export default\b/, /^serve\(/]
function blockEndByBraces(arr, appIdx) {
  let depth = 0
  for (let i = appIdx; i < arr.length; i++) {
    for (const ch of arr[i]) { if (ch === '{') depth++; else if (ch === '}') depth-- }
    if (i > appIdx && depth === 0 && /^\}\);?\s*$/.test(arr[i].trim())) return i + 1
  }
  return null
}
function detectBlock(start1) {
  const appIdx = start1 - 1
  let start0 = appIdx
  let j = appIdx - 1
  while (j >= 0 && lines[j].trim().startsWith('//')) j -= 1
  if (j + 1 < appIdx && (lines[j] || '').trim() === '') start0 = j + 1
  let end0 = null
  for (let i = start1; i < lines.length; i++) {
    if (TAIL_MARKERS.some((re) => re.test(lines[i]))) { end0 = i; break }
  }
  if (end0 === null) {
    // 末位端点（其后无任何标记）：按花括号平衡找块尾
    end0 = blockEndByBraces(lines, appIdx)
  }
  if (end0 === null) {
    const tail = lines.slice(start1 - 2, start1 + 8).map((x, k) => `${start1 - 1 + k}: ${x}`).join('\n')
    throw new Error(`边界未找到（行 ${start1}）\n--- 上下文 ---\n${tail}`)
  }
  return { start0, end0 }
}

// ---- index 本地辅助判定（函数声明/const 在 index.js 内定义）
function isIndexLocal(name) {
  return new RegExp(`^(async function|function|const|let) ${name}\\b`, 'm').test(lines.join('\n'))
}

const AI_SOURCES = [
  ['../ai/scripts.js', ['genId', 'generateScriptDraft', 'guessTitleFromPrompt', 'repairScriptDraft']],
  ['../ai/runtime.js', ['classifyAiError', 'createTraceId', 'logStage']],
  ['../ai/taskProgress.js', ['createAiTask', 'getAiTask', 'listAiTasks', 'loadAiTasksFromDisk', 'updateAiTask']],
  ['../ai/storyStates.js', ['buildStatesDoc', 'buildStoryStateExtractionInput', 'carrierSkillIdForStateKey', 'extractStoryStates', 'findStateGaps', 'mergeStoryStatesIntoPlan', 'resolveStateBoundVariant', 'STORY_STATE_UNCHANGED']],
  ['../ai/storyPoseStates.js', ['buildPoseStateExtractionInput', 'extractStoryPoseStates']],
  ['../ai/storyPropStates.js', ['buildPropStateExtractionInput', 'extractStoryPropStates']],
  ['../ai/storyPoseVariants.js', ['buildPoseVariantPrompt', 'generatePoseVariantForGroup', 'groupPoseRequirements', 'isAnimalLikeAnchor', 'loadPoseLibraryManifest']],
  ['../ai/craftLibrary.js', ['getCraftSkill', 'resolveCarrierPlacementPlan']],
  ['../ai/background.js', ['generateBackgroundImage', 'generateComfyuiLineartFromReference', 'generateComfyuiCutoutFromReference', 'generateComfyuiPoseVariantSprite', 'mapComfySampler', 'mapComfyScheduler', 'normalizeComfyCheckpointName', 'parseComfyTimeoutMs', 'runComfyuiPromptWorkflow']],
  ['../ai/imageOptimize.js', ['optimizeGeneratedImage', 'optimizeDirectoryTree', 'IMAGE_KIND']],
  ['../ai/storyAssets.js', ['buildStoryAssetPlan', 'buildStoryAssetReferenceNegativePrompt', 'buildStoryAssetReferencePrompt', 'buildStorySceneRenderSpec', 'getStoryAssetRenderProfile', 'matchSceneRef', 'normalizeSceneRefs', 'repairStoryAssetPlanSceneLinks', 'resolveStoryStylePreset', 'summarizeStoryAssetPlan']],
  ['../ai/storyBible.js', ['generateStoryBible']],
  ['../ai/storyBibleQc.js', ['qcSceneRefsDeterministic', 'qcStoryBibleSceneRefsWithAi']],
  ['../ai/storyLock.js', ['buildStoryboardLockTestNegativePrompt', 'buildStoryboardLockTestPrompt', 'buildStoryboardLockTestWorkflow', 'pickStoryboardLockTestAsset', 'reviewStoryboardLockImageWithAi']],
  ['../ai/storyAssetReferenceGate.js', ['evaluateStoryAssetReferenceReview', 'sniffImageMetaFromBytes', 'verifyStoryAssetReferenceFile']],
  ['../ai/characterPoseReview.js', ['reviewCharacterPoseConsistencyWithAi', 'reviewCharacterPoseConsistencyWithLocalVl']],
  ['../ai/sceneBackgroundReview.js', ['reviewSceneBackgroundWithAi', 'reviewSceneBackgroundWithLocalVl']],
  ['../ai/sceneBatchQueue.js', ['checkSceneSuccess', 'createSceneBatch', 'findInterruptedSceneBatches', 'loadSceneBatch', 'resumeSceneBatch', 'runSceneBatch']],
  ['../ai/storyCompleteness.js', ['COMPLETENESS_TASK_KIND', 'createNodeVisualReviewer', 'createPuppeteerBrowserLauncher', 'loadLatestCompletenessReport', 'resolveChromeExecutablePath', 'resolveReviewConfig', 'runStoryCompletenessCheck']],
  ['../ai/storyComposition.js', ['buildCompositionInput', 'extractStoryComposition']],
  ['../ai/translate.js', ['translatePromptText']],
  ['../ai/analyze.js', ['analyzeScriptsForBlueprint']],
  ['../ai/diagnostics.js', ['getAiStatusSnapshot', 'runAiDiagnostics']],
  ['../ai/globalRules.js', ['readGlobalRules', 'writeGlobalRules']],
  ['../ai/imagePrompt.js', ['generateBackgroundPrompt']],
  ['../ai/promptReview.js', ['reviewStoryPromptLocally', 'reviewStoryPromptWithAi']],
  ['../ai/storyboardPromptReview.js', ['generateStoryboardGlobalPromptWithAi', 'normalizeStoryboardPromptReviewInput', 'reviewStoryboardPromptLocally', 'reviewStoryboardPromptWithAi']],
  ['../ai/promptTemplates.js', ['deletePromptTemplate', 'generateStoryPromptTemplate', 'listPromptTemplates', 'savePromptTemplate']],
  ['../ai/promptLibrary.js', ['addPromptLibraryEntry', 'deletePromptLibraryEntry', 'listPromptLibraryEntries', 'updatePromptLibraryEntry']],
  ['../ai/storyAssetPromptEnhance.js', ['enhanceStoryAssetPromptWithAi']],
  ['../ai/characterPrompt.js', ['generateCharacterFingerprint', 'generateCharacterPosePrompt']],
  ['../ai/storyCoverage.js', ['getStoryImageCoverage']],
  ['../ai/storySceneReview.js', ['runStorySceneReview', 'appendSceneReviewFeedback', 'readLatestSceneReviewRound']],
  ['../ai/storyWalkthrough.js', ['runStoryWalkthrough']],
  ['../ai/comfyuiCapability.js', ['checkComfyuiCapability']],
  ['../ai/resourceLease.js', ['withResourceLease']],
  ['../ai/openai.js', ['diagnoseOpenAI', 'isOpenAICompatibleProvider', 'reviewBlueprintViaOpenAI']],
  ['../ai/doubao.js', ['getDoubaoImagesConfigSnapshot']],
  ['../ai/ollama.js', ['diagnoseOllamaText']],
  ['../ai/modelDialogs.js', ['readStudioModelDialogs']],
  ['../ai/blueprintReviewLocal.js', ['reviewBlueprintLocally']],
  ['../blueprint/compile.js', ['compileBlueprintFromScripts', 'normalizeScriptCardsForBlueprint']],
  ['../blueprint/validate.js', ['validateBlueprintDoc']],
  ['../studio/settings.js', ['getEffectiveStudioConfig', 'redactEffectiveStudioConfigForClient', 'redactStudioSettingsForClient', 'writeStudioSettings']],
  ['../review/imageReviewStore.js', ['attachImageReviewResult', 'createImageReview', 'decideImageReview', 'findPendingReview', 'getImageReview', 'listImageReviews']],
  ['../creationBuffer.js', ['recordCreationEvent', 'snapshotCreationState']],
  ['../plugins/storyPixi.js', ['pluginStoryPixi']]
]

const JS_BUILTIN = new Set(['String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Promise', 'Map', 'Set', 'Date', 'Math', 'Error', 'RegExp', 'console', 'process', 'Buffer', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'encodeURIComponent', 'decodeURIComponent', 'fetch', 'URL', 'URLSearchParams', 'require', 'parseInt', 'parseFloat', 'isFinite', 'isNaN', 'queueMicrotask', 'AbortController', 'FormData', 'Blob', 'File', 'structuredClone', 'Intl', 'TextEncoder', 'TextDecoder', 'crypto', 'globalThis'])

function collectIdents(text) {
  const calls = new Set([...text.matchAll(/(?<![.\w'"])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]))
  const consts = new Set([...text.matchAll(/(?<![.\w'"])([A-Z][A-Z0-9_]{3,})\b/g)].map((m) => m[1]))
  return { calls, consts }
}

function buildFamily(moduleFile, registerName, entries) {
  // 定位+探测
  const blocks = entries.map((e) => ({ ...e, start1: findRouteLine(e.method, e.path) }))
  blocks.sort((a, b) => a.start1 - b.start1)
  const detected = blocks.map((b) => ({ ...b, ...detectBlock(b.start1) }))
  for (let i = 1; i < detected.length; i++) {
    if (detected[i].start0 < detected[i - 1].end0) {
      // 相邻块注释头相交：截上块边界到下块注释头
      detected[i - 1].end0 = detected[i].start0
    }
    if (detected[i].start0 < detected[i - 1].end0) throw new Error(`区间重叠: ${detected[i].path}`)
  }
  let body = detected.map((d) => lines.slice(d.start0, d.end0).join('\n').replace(/\n+$/, '')).join('\n\n')

  // 依赖计算
  const { calls, consts } = collectIdents(body)
  const importLines = []
  for (const [mod, names] of AI_SOURCES) {
    const used = names.filter((n) => calls.has(n) || consts.has(n))
    if (used.length) importLines.push(`import { ${used.join(', ')} } from '${mod}'`)
  }
  const ctxNames = new Set()
  for (const n of [...calls, ...consts]) {
    if (JS_BUILTIN.has(n)) continue
    if (AI_SOURCES.some(([, names]) => names.includes(n))) continue
    if (['app', 'c', 'ctx', 'path', 'spawn', 'mkdir', 'readFile', 'writeFile', 'readdir', 'rename', 'stat', 'rm', 'copyFile', 'existsSync', 'crypto', 'fileURLToPath', 'pathToFileURL'].includes(n)) continue
    if (/^(if|for|while|switch|catch|return|function|await|async|new|typeof|void|delete|in|of|else|do)$/.test(n)) continue
    if (isIndexLocal(n)) ctxNames.add(n)
  }
  // 中间件形态：storyInputGate('...') 已在 calls 覆盖；常量形态已在 consts 覆盖
  for (const n of [...ctxNames]) {
    body = body.replace(new RegExp(`(?<![.\\w'"])${n}\\s*\\(`, 'g'), `ctx.${n}(`)
  }
  // 常量形态（仅 ALLCAPS 集合）裸引用改写，避免误伤解构参数/对象字面量
  for (const n of [...ctxNames].filter((x) => consts.has(x))) {
    body = body.replace(new RegExp(`(?<![.\\w'"])${n}\\b`, 'g'), `ctx.${n}`)
  }
  body = body.replace(/ctx\.ctx\./g, 'ctx.')

  const header = `// ---------------------------------------------------------------------------
// ${registerName}（模块化拆分机械迁出，字义未改；协议层+族内编排，域算法引自 ../ai/*，index 本地辅助经 ctx 注入）
// ---------------------------------------------------------------------------
import path from 'node:path'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rename, stat, writeFile, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import crypto from 'node:crypto'
${importLines.join('\n')}

export function ${registerName}(app, ctx) {
`
  return { file: moduleFile, content: `${header}${body}\n}\n`, detected, ctxNames: [...ctxNames] }
}

// ---- 主流程
const allCtx = new Set()
const registrations = []
for (const fam of spec.families) {
  const r = buildFamily(fam.file, fam.register, fam.routes)
  fs.mkdirSync(path.dirname(path.join(ROOT, fam.file)), { recursive: true })
  fs.writeFileSync(path.join(ROOT, fam.file), r.content)
  r.ctxNames.forEach((n) => allCtx.add(n))
  const minLine = Math.min(...r.detected.map((d) => d.start0))
  registrations.push({ register: fam.register, file: fam.file, minLine })
  // 自后往前撤除（同族内）
  for (const d of r.detected.slice().reverse()) {
    lines.splice(d.start0, d.end0 - d.start0, `// [拆分] ${d.method.toUpperCase()} ${d.path} 已迁至 ${fam.file}`)
  }
  console.log(`[family] ${fam.file}: ${r.detected.length} 端点, ctx 引用 ${r.ctxNames.length}`)
}

// 装配块：按原始位置序注册，插在重启恢复段前
registrations.sort((a, b) => a.minLine - b.minLine)
const importRegs = registrations.map((r) => `import { ${r.register} } from './${path.relative(path.join(ROOT, 'apps/server/src'), path.join(ROOT, r.file)).replace(/\\/g, '/')}'`)
const asm = `
// ---------------------------------------------------------------------------
// [模块化拆分] 路由装配区：各族端点已迁至 routes/*.routes.js；注册顺序保持原文件相对序。
// ---------------------------------------------------------------------------
function buildRouteCtx() {
  return {
${[...allCtx].sort().map((n) => `    ${n}`).join(',\n')}
  }
}
${registrations.map((r) => `${r.register}(app, buildRouteCtx())`).join('\n')}
`
let insertAt = lines.findIndex((l) => l.startsWith('// 重启恢复'))
if (insertAt < 0) insertAt = lines.length - 20
lines.splice(insertAt, 0, ...asm.split('\n'))

// import 区追加
let lastImport = 0
lines.forEach((l, i) => { if (l.startsWith('import ')) lastImport = i })
lines.splice(lastImport + 1, 0, ...importRegs)

fs.writeFileSync(INDEX, lines.join('\n'))
console.log(`[done] index.js 现有 ${lines.length} 行；ctx 共享辅助 ${allCtx.size} 个`)
console.log('ctx list:', [...allCtx].sort().join(','))
