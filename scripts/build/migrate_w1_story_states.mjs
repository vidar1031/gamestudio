#!/usr/bin/env node
// W1 迁移脚本（一次性）：把 index.js 中状态机族 6 端点机械切到 routes/storyStates.routes.js。
// 原则：整块搬迁不改字义；index 本地辅助经 ctx 注入；ai/* 依赖在 routes 文件直接 import。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const INDEX = path.join(ROOT, 'apps/server/src/index.js')
const OUT = path.join(ROOT, 'apps/server/src/routes/storyStates.routes.js')

// 端点起始行（1-based，app.post 行）
const STARTS = [6817, 6869, 6922, 11642, 12295, 12617]

const lines = fs.readFileSync(INDEX, 'utf8').split('\n')

// 两遍探测：先各自算注释头起点与原始边界，再让上一边界不越过下一块的注释头起点（防重叠）
function detectRanges() {
  const blocks = STARTS.map((s1) => {
    const appIdx = s1 - 1
    // 注释头起点：app.post 上方紧邻的 // 行块，且该块与前文之间须有空行分隔
    let start0 = appIdx
    let j = appIdx - 1
    while (j >= 0 && lines[j].trim().startsWith('//')) j -= 1
    if (j + 1 < appIdx && (lines[j] || '').trim() === '') start0 = j + 1
    // 原始边界：下一条 app./段落注释/恢复注释
    let rawEnd0 = null
    for (let i = s1; i < lines.length; i++) {
      const l = lines[i]
      if (/^app\.(post|get|put|delete)\b/.test(l) || l.startsWith('// ---') || l.startsWith('// 重启恢复')) { rawEnd0 = i; break }
    }
    return { start0, rawEnd0 }
  })
  for (let i = 0; i < blocks.length; i++) {
    const next = blocks[i + 1]
    blocks[i].end0 = next && next.start0 > blocks[i].start0 ? Math.min(blocks[i].rawEnd0, next.start0) : blocks[i].rawEnd0
  }
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].start0 < blocks[i - 1].end0) throw new Error(`range overlap at ${STARTS[i]}`)
  }
  return blocks
}

const ranges = detectRanges()

const blocks = ranges.map(({ start0, end0 }) => lines.slice(start0, end0).join('\n').replace(/\n+$/, ''))
const blockText = blocks.join('\n\n')

// index.js 本地辅助 → ctx 注入（函数调用形态改写；常量单列）
const CTX_FNS = ['ensureDirs', 'projectDir', 'projectStoryAssetsDir', 'existsDir', 'existsFile', 'readJson', 'writeJson', 'readProjectBundle', 'readStoryAssetPlanIfExists', 'saveStoryAssetPlan', 'readStoryBibleFromProjectDoc', 'nowIso', 'clampInt', 'translateStoryAssetPromptPair']
const CTX_CONSTS = ['BLANK_SKELETON_PNG_BYTES']

let body = blockText
for (const fn of CTX_FNS) {
  body = body.replace(new RegExp(`(?<![.\\w])${fn}\\s*\\(`, 'g'), `ctx.${fn}(`)
}
for (const cn of CTX_CONSTS) {
  body = body.replace(new RegExp(`(?<![.\\w])${cn}\\b`, 'g'), `ctx.${cn}`)
}

// 计算 routes 文件实际用到的 ai/* 依赖
const use = (name) => new RegExp(`(?<![.\\w])${name}\\s*\\(`).test(blockText) || new RegExp(`(?<![.\\w])${name}\\b`).test(blockText)
const aiImports = [
  ['../ai/scripts.js', ['genId']],
  ['../ai/runtime.js', ['classifyAiError', 'createTraceId', 'logStage']],
  ['../ai/taskProgress.js', ['createAiTask', 'updateAiTask']],
  ['../ai/storyStates.js', ['buildStatesDoc', 'buildStoryStateExtractionInput', 'carrierSkillIdForStateKey', 'extractStoryStates', 'findStateGaps', 'mergeStoryStatesIntoPlan']],
  ['../ai/storyPoseStates.js', ['buildPoseStateExtractionInput', 'extractStoryPoseStates']],
  ['../ai/storyPropStates.js', ['buildPropStateExtractionInput', 'extractStoryPropStates']],
  ['../ai/craftLibrary.js', ['getCraftSkill']],
  ['../ai/background.js', ['generateComfyuiPoseVariantSprite']],
  ['../ai/imageOptimize.js', ['optimizeGeneratedImage', 'IMAGE_KIND']],
  ['../ai/storyAssets.js', ['summarizeStoryAssetPlan']],
  ['../ai/storyAssetReferenceGate.js', ['verifyStoryAssetReferenceFile']],
  ['../review/imageReviewStore.js', ['createImageReview', 'decideImageReview', 'findPendingReview']]
]
const importLines = []
for (const [mod, names] of aiImports) {
  const used = names.filter((n) => use(n))
  if (used.length) importLines.push(`import { ${used.join(', ')} } from '${mod}'`)
}

const header = `// ---------------------------------------------------------------------------
// 状态机族路由（W1 模块化拆分，2026-10-19 自 index.js 机械迁出，字义未改）：
// 剧情姿势提取 / 道具状态提取 / 剧情状态提取合并 / 载体变体 / 道具状态变体 / 状态变体编排。
// 规则（见 docsys《模块化拆分设计》）：本文件只做协议层+族内编排；index.js 本地辅助经 ctx 注入；
// 域算法依赖直接引自 ../ai/*；新增端点不得回 index.js。
// ---------------------------------------------------------------------------
import path from 'node:path'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
${importLines.join('\n')}

export function registerStoryStatesRoutes(app, ctx) {
`

const routesContent = `${header}${body}\n}\n`
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, routesContent)
console.log('written', path.relative(ROOT, OUT), routesContent.length, 'bytes')

// index.js：撤除六块；最后一块原位放装配块，其余留指针注释
const registration = `// ---------------------------------------------------------------------------
// [W1 模块化拆分] 状态机族 6 端点已迁至 ./routes/storyStates.routes.js；此处仅装配。
// ---------------------------------------------------------------------------
registerStoryStatesRoutes(app, storyStatesRouteCtx())
`
const pointers = [
  '// [W1] 剧情姿势提取端点已迁至 routes/storyStates.routes.js',
  '// [W1] 道具状态提取端点已迁至 routes/storyStates.routes.js',
  '// [W1] 剧情状态提取端点已迁至 routes/storyStates.routes.js',
  '// [W1] 载体变体端点已迁至 routes/storyStates.routes.js',
  '// [W1] 道具状态变体端点已迁至 routes/storyStates.routes.js'
]

const next = lines.slice()
// 自后往前替换
const replacements = ranges.map((r, i) => ({ ...r, text: i === ranges.length - 1 ? registration : pointers[i] + '\n' }))
for (const r of replacements.slice().reverse()) {
  next.splice(r.start0, r.end0 - r.start0, ...r.text.split('\n'))
}
fs.writeFileSync(INDEX, next.join('\n'))
console.log('index.js updated, new length:', next.length, 'lines')
