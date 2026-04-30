// Reasoning prompt detectors + deterministic answer builders + answer evaluators.
// Extracted from controlServerCore.js without behavior changes. All functions are
// pure or only touch fs/path under GAMESTUDIO_ROOT.

import fs from 'node:fs'
import path from 'node:path'

import { GAMESTUDIO_ROOT } from '../../config/paths.js'
import { HERMES_REASONING_MIN_ACCEPT_SCORE } from '../../config/constants.js'
import { resolveWorkspacePathFromInput } from '../workspace/inspectors.js'

// ----------------------------------------------------------------------------
// Prompt detectors / inference
// ----------------------------------------------------------------------------

const REASONING_DIRECTORY_KEYWORDS = /目录|文件|有哪些|哪些|列表|列出|查看|包括|包含|找出|盘点/i
const REASONING_DIRECTORY_SEARCH_PREFIXES = ['', 'apps', 'packages', 'storage', 'docs', 'scripts', 'ai', 'config', 'monitor', 'state', 'utils', 'test']

const REASONING_PROJECT_LISTING_KEYWORDS = /storage\/projects|当前已有项目|当前项目|已有项目|现有项目|列出项目|找出项目|盘点项目/i

export function normalizeWorkspaceRelativePath(inputPath) {
  return String(inputPath || '').trim().replace(/\\/g, '/')
}

export function isDirectoryListingPrompt(userPrompt) {
  return REASONING_DIRECTORY_KEYWORDS.test(String(userPrompt || ''))
}

export function isProjectListingPrompt(userPrompt) {
  const prompt = String(userPrompt || '').trim()
  if (!prompt) return false
  if (REASONING_PROJECT_LISTING_KEYWORDS.test(prompt)) return true
  return /项目/i.test(prompt) && /当前|已有|现有|哪些|列表|列出|找出|盘点/i.test(prompt)
}

export function inferWorkspaceDirectoryFromPrompt(userPrompt) {
  const prompt = String(userPrompt || '')
  if (!prompt) return ''

  const rawTokens = prompt.match(/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/g) || []
  const candidates = [...new Set(rawTokens
    .map((token) => String(token || '').trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length))]

  for (const candidate of candidates) {
    const candidatePaths = candidate.includes('/')
      ? [candidate]
      : REASONING_DIRECTORY_SEARCH_PREFIXES.map((prefix) => prefix ? `${prefix}/${candidate}` : candidate)

    for (const candidatePath of candidatePaths) {
      const resolvedPath = resolveWorkspacePathFromInput(candidatePath)
      if (!resolvedPath || !resolvedPath.startsWith(GAMESTUDIO_ROOT)) continue
      if (!fs.existsSync(resolvedPath)) continue
      if (!fs.statSync(resolvedPath).isDirectory()) continue
      return normalizeWorkspaceRelativePath(path.relative(GAMESTUDIO_ROOT, resolvedPath)) || '.'
    }
  }

  return ''
}

export function inferWorkspaceDirectoriesFromPromptText(userPrompt) {
  const prompt = String(userPrompt || '')
  if (!prompt) return []

  const rawTokens = prompt.match(/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/g) || []
  const candidates = [...new Set(rawTokens
    .map((token) => String(token || '').trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length))]
  const directories = []
  const seen = new Set()

  for (const candidate of candidates) {
    const candidatePaths = candidate.includes('/')
      ? [candidate]
      : REASONING_DIRECTORY_SEARCH_PREFIXES.map((prefix) => prefix ? `${prefix}/${candidate}` : candidate)

    for (const candidatePath of candidatePaths) {
      const resolvedPath = resolveWorkspacePathFromInput(candidatePath)
      if (!resolvedPath || !resolvedPath.startsWith(GAMESTUDIO_ROOT)) continue
      if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) continue
      const relativePath = normalizeWorkspaceRelativePath(path.relative(GAMESTUDIO_ROOT, resolvedPath)) || '.'
      if (seen.has(relativePath)) continue
      seen.add(relativePath)
      directories.push(relativePath)
      break
    }
  }

  return directories
}

export function inferWorkspaceFilesFromPrompt(userPrompt) {
  const prompt = String(userPrompt || '')
  if (!prompt) return []

  const rawTokens = prompt.match(/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g) || []
  const files = []
  const seen = new Set()
  for (const rawToken of rawTokens) {
    const candidate = normalizeWorkspaceRelativePath(rawToken).replace(/^\/+|[).,;，。；：]+$/g, '')
    if (!candidate) continue
    const resolvedPath = resolveWorkspacePathFromInput(candidate)
    if (!resolvedPath || !resolvedPath.startsWith(GAMESTUDIO_ROOT)) continue
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) continue
    const relativePath = normalizeWorkspaceRelativePath(path.relative(GAMESTUDIO_ROOT, resolvedPath))
    if (!relativePath || seen.has(relativePath)) continue
    seen.add(relativePath)
    files.push(relativePath)
  }
  return files
}

export function isWorkspaceFileQuestionPrompt(userPrompt) {
  const normalizedPrompt = String(userPrompt || '').trim()
  if (!normalizedPrompt) return false
  if (inferWorkspaceFilesFromPrompt(normalizedPrompt).length === 0) return false
  return /负责|作用|用途|区别|分别|是什么|说明|解释|对比|含义|role|purpose|what|explain|compare/i.test(normalizedPrompt)
}

export function isWorkspaceDirectoryQuestionPrompt(userPrompt) {
  const normalizedPrompt = String(userPrompt || '').trim()
  if (!normalizedPrompt) return false
  if (inferWorkspaceDirectoriesFromPromptText(normalizedPrompt).length === 0) return false
  return /分析|负责|职责|作用|用途|区别|分别|是什么|说明|解释|对比|含义|role|purpose|what|explain|compare/i.test(normalizedPrompt)
}

export function isImageServiceEntrypointPrompt(prompt) {
  return /图片生成|出图|图像生成|image|background|comfyui|sdwebui|服务端入口|入口文件|主要入口|api\/studio\/image/i.test(String(prompt || ''))
}

export function isControlBackendSurfacePrompt(prompt) {
  return /control|hermes|管理器|reasoning|对话|聊天|后端文件|主要后端|backend file|control-server|control-console/i.test(String(prompt || ''))
}

export function isControlLocationPrompt(userPrompt) {
  return /control|控制台|控制面|control-console|control-server/i.test(String(userPrompt || ''))
    && /哪里|在哪|目录|路径|where|location|path/i.test(String(userPrompt || ''))
}

export function isEditorLocationPrompt(userPrompt) {
  return /editor|编辑器|前端编辑器/i.test(String(userPrompt || ''))
    && /哪里|在哪|目录|路径|where|location|path/i.test(String(userPrompt || ''))
}

export function isBusinessServerLocationPrompt(userPrompt) {
  return /业务后端|server目录|apps\/server|backend directory/i.test(String(userPrompt || ''))
    && /哪里|在哪|目录|路径|where|location|path/i.test(String(userPrompt || ''))
}

export function hasWorkspaceLocationEvidence(userPrompt, artifacts) {
  const hasWorkspaceStructure = artifacts?.workspaceStructure && typeof artifacts.workspaceStructure === 'object'
  if (!hasWorkspaceStructure) return false
  return isEditorLocationPrompt(userPrompt) || isControlLocationPrompt(userPrompt) || isBusinessServerLocationPrompt(userPrompt)
}

export function summarizeReasoningArtifactsForAssessment(artifacts) {
  const summary = {}
  if (artifacts?.directoryListing && typeof artifacts.directoryListing === 'object') {
    summary.directoryListing = {
      requestedPath: artifacts.directoryListing.requestedPath,
      resolvedPath: artifacts.directoryListing.resolvedPath,
      count: artifacts.directoryListing.count,
      entries: Array.isArray(artifacts.directoryListing.entries)
        ? artifacts.directoryListing.entries.slice(0, 20)
        : []
    }
  }
  if (artifacts?.imageServiceEntrypoints && typeof artifacts.imageServiceEntrypoints === 'object') {
    summary.imageServiceEntrypoints = artifacts.imageServiceEntrypoints
  }
  if (artifacts?.controlBackendSurfaces && typeof artifacts.controlBackendSurfaces === 'object') {
    summary.controlBackendSurfaces = artifacts.controlBackendSurfaces
  }
  if (artifacts?.workspaceStructure && typeof artifacts.workspaceStructure === 'object') {
    summary.workspaceStructure = artifacts.workspaceStructure
  }
  if (artifacts?.directoryListings && typeof artifacts.directoryListings === 'object') {
    summary.directoryListings = artifacts.directoryListings
  }
  if (artifacts?.directoryListing && typeof artifacts.directoryListing === 'object') {
    summary.directoryListing = artifacts.directoryListing
  }
  return summary
}

// ----------------------------------------------------------------------------
// Deterministic answer builders
// ----------------------------------------------------------------------------

export function buildImageServiceEntrypointsAnswer(userPrompt, artifacts) {
  const inspection = artifacts?.imageServiceEntrypoints && typeof artifacts.imageServiceEntrypoints === 'object'
    ? artifacts.imageServiceEntrypoints
    : null
  const entries = Array.isArray(inspection?.entries) ? inspection.entries : []

  if (!entries.length) {
    return [
      '当前没有拿到图片生成服务端入口的可观测结果。',
      inspection?.searchedRoot ? `已检查目录：${inspection.searchedRoot}` : '已检查目录：无',
      `本次问题：${userPrompt}`
    ].filter(Boolean).join('\n\n')
  }

  const lines = entries.map((entry, index) => {
    const evidence = Array.isArray(entry.evidence) && entry.evidence.length
      ? `证据：${entry.evidence.join('；')}`
      : ''
    return [
      `${index + 1}. ${entry.filePath}`,
      `角色：${entry.role}`,
      `原因：${entry.reason}`,
      evidence
    ].filter(Boolean).join('\n')
  })

  return [
    '根据当前仓库里的可观测服务端代码，图片生成相关的主要入口文件如下：',
    lines.join('\n\n'),
    inspection?.searchedRoot ? `已检查目录：${inspection.searchedRoot}` : '',
    '其中最上层 HTTP 入口是 apps/server/src/index.js，真正执行出图的是 apps/server/src/ai/background.js；提示词生成与故事资产渲染规格分别由 apps/server/src/ai/imagePrompt.js 和 apps/server/src/ai/storyAssets.js 承担。'
  ].filter(Boolean).join('\n\n')
}

export function buildControlBackendSurfacesAnswer(userPrompt, artifacts) {
  const inspection = artifacts?.controlBackendSurfaces && typeof artifacts.controlBackendSurfaces === 'object'
    ? artifacts.controlBackendSurfaces
    : null
  const entries = Array.isArray(inspection?.entries) ? inspection.entries : []

  if (!entries.length) {
    return [
      '当前没有拿到 control/Hermes 后端文件的可观测结果。',
      inspection?.searchedRoot ? `已检查目录：${inspection.searchedRoot}` : '已检查目录：无',
      `本次问题：${userPrompt}`
    ].filter(Boolean).join('\n\n')
  }

  const lines = entries.map((entry, index) => {
    const evidence = Array.isArray(entry.evidence) && entry.evidence.length
      ? `证据：${entry.evidence.join('；')}`
      : ''
    return [
      `${index + 1}. ${entry.filePath}`,
      `角色：${entry.role}`,
      `原因：${entry.reason}`,
      evidence
    ].filter(Boolean).join('\n')
  })

  return [
    '根据当前 control 侧可观测代码，负责 Hermes 对话与 reasoning 的主要后端文件如下：',
    lines.join('\n\n'),
    inspection?.searchedRoot ? `已检查目录：${inspection.searchedRoot}` : '',
    '当前这条链路的主后端入口集中在 apps/control-server/src/index.js；如果后续再拆模块，应继续通过同一套可注册 observable action 暴露给 planner，而不是把文件名硬写进 prompt。'
  ].filter(Boolean).join('\n\n')
}

export function shouldUseDeterministicImageServiceAnswer(userPrompt, artifacts) {
  const hasInspection = artifacts?.imageServiceEntrypoints && typeof artifacts.imageServiceEntrypoints === 'object'
  if (!hasInspection) return false
  return isImageServiceEntrypointPrompt(userPrompt)
}

export function shouldUseDeterministicControlBackendAnswer(userPrompt, artifacts) {
  const hasInspection = artifacts?.controlBackendSurfaces && typeof artifacts.controlBackendSurfaces === 'object'
  if (!hasInspection) return false
  return isControlBackendSurfacePrompt(userPrompt)
}

export function shouldUseDeterministicDirectoryListingAnswer(userPrompt, artifacts) {
  if (!isDirectoryListingPrompt(userPrompt)) return false
  if (artifacts?.directoryListings && typeof artifacts.directoryListings === 'object' && Object.keys(artifacts.directoryListings).length > 0) return true
  return Boolean(artifacts?.directoryListing && typeof artifacts.directoryListing === 'object')
}

// ----------------------------------------------------------------------------
// Deterministic answer-quality evaluators
// ----------------------------------------------------------------------------

export function evaluateControlLocationAnswerQuality(userPrompt, answer, artifacts) {
  const text = String(answer || '')
  const normalized = text.toLowerCase()
  const issues = []
  const strengths = []
  let score = 40

  if (normalized.includes('apps/control-console')) {
    score += 25
    strengths.push('已指出 control 前端目录 apps/control-console')
  } else {
    issues.push('缺少 control 前端目录 apps/control-console')
  }

  if (normalized.includes('apps/control-server')) {
    score += 25
    strengths.push('已指出 control 后端目录 apps/control-server')
  } else {
    issues.push('缺少 control 后端目录 apps/control-server')
  }

  const workspaceStructure = artifacts?.workspaceStructure && typeof artifacts.workspaceStructure === 'object'
    ? artifacts.workspaceStructure
    : null
  const listings = artifacts?.directoryListings && typeof artifacts.directoryListings === 'object'
    ? artifacts.directoryListings
    : {}
  const appsEntries = Array.isArray(listings.apps?.entries) ? listings.apps.entries : []
  const hasWorkspaceControlRoots = Boolean(workspaceStructure?.controlConsoleRoot && workspaceStructure?.controlServerRoot)
  const hasAppsListingEvidence = appsEntries.some((entry) => entry?.name === 'control-console')
    && appsEntries.some((entry) => entry?.name === 'control-server')

  if (hasWorkspaceControlRoots || hasAppsListingEvidence) {
    score += 10
    strengths.push('答案可由 workspaceStructure 或 apps 目录 listing 验证')
  } else {
    issues.push('artifacts 中缺少 control 目录验证证据')
  }

  const wrongControlPaths = [
    'apps/editor',
    'apps/server',
    'control-console/src',
    'control-server/src/index.js'
  ].filter((pathText) => normalized.includes(pathText.toLowerCase()) && !['apps/editor', 'apps/server'].every((allowed) => pathText !== allowed))
  if (wrongControlPaths.length > 0 && /control\s*(前端|后端)|控制.*(前端|后端)/i.test(text)) {
    score -= wrongControlPaths.length * 15
    issues.push(`可能混淆 control 目录与其它入口：${wrongControlPaths.join('、')}`)
  }

  score = Math.max(0, Math.min(100, score))
  const passed = score >= HERMES_REASONING_MIN_ACCEPT_SCORE
  return {
    score,
    passed,
    source: 'deterministic',
    summary: passed ? `Control 目录答案评分 ${score}/100，已通过。` : `Control 目录答案评分 ${score}/100，未达到 ${HERMES_REASONING_MIN_ACCEPT_SCORE} 分。`,
    strengths,
    issues,
    correctionPrompt: passed
      ? '当前答案已通过质量门槛。'
      : [
          '必须直接回答 control 前端目录是 apps/control-console。',
          '必须直接回答 control 后端目录是 apps/control-server。',
          '必须基于 workspaceStructure 或 apps 目录 listing 证据回答，不要混入 editor 或业务 server 目录。'
        ].join('\n')
  }
}

export function evaluateDirectoryListingAnswerQuality(answer, artifacts) {
  const text = String(answer || '')
  const normalized = text.toLowerCase()
  const listings = artifacts?.directoryListings && typeof artifacts.directoryListings === 'object'
    ? Object.values(artifacts.directoryListings)
    : (artifacts?.directoryListing && typeof artifacts.directoryListing === 'object' ? [artifacts.directoryListing] : [])
  const issues = []
  const strengths = []
  let score = 45

  for (const listing of listings) {
    const relativePath = normalizeWorkspaceRelativePath(path.relative(GAMESTUDIO_ROOT, listing.resolvedPath || listing.dirPath || ''))
    if (relativePath && normalized.includes(relativePath.toLowerCase())) {
      score += 15
      strengths.push(`已指出目录 ${relativePath}`)
    } else if (listing.resolvedPath && normalized.includes(String(listing.resolvedPath).toLowerCase())) {
      score += 15
      strengths.push(`已指出目录 ${listing.resolvedPath}`)
    } else {
      issues.push(`缺少目录路径 ${relativePath || listing.resolvedPath || 'unknown'}`)
    }

    const entries = Array.isArray(listing.entries) ? listing.entries : []
    const matchedEntries = entries.filter((entry) => entry?.name && normalized.includes(String(entry.name).toLowerCase()))
    if (entries.length === 0 || matchedEntries.length === entries.length) {
      score += 25
      strengths.push(`${relativePath || listing.resolvedPath || '目录'} 的直接子项已覆盖`)
    } else {
      issues.push(`${relativePath || listing.resolvedPath || '目录'} 缺少直接子项：${entries.filter((entry) => !matchedEntries.includes(entry)).map((entry) => entry.name).join('、')}`)
    }
  }

  if (/内部结构|src\/.*\.ts|components\/|services\//i.test(text)) {
    score -= 25
    issues.push('回答疑似展开了未扫描的递归目录内容')
  } else {
    score += 10
    strengths.push('回答明确停留在直接子项层级')
  }

  score = Math.max(0, Math.min(100, score))
  const passed = score >= HERMES_REASONING_MIN_ACCEPT_SCORE
  return {
    score,
    passed,
    source: 'deterministic',
    summary: passed ? `目录清单答案评分 ${score}/100，已通过。` : `目录清单答案评分 ${score}/100，未达到 ${HERMES_REASONING_MIN_ACCEPT_SCORE} 分。`,
    strengths,
    issues,
    correctionPrompt: passed
      ? '当前答案已通过质量门槛。'
      : '必须只基于 list_directory_contents 的直接子项回答，不得编造 src/、components/、services/ 等未递归扫描内容。'
  }
}

export function evaluateWorkspaceLocationAnswerQuality(userPrompt, answer, artifacts) {
  const text = String(answer || '')
  const normalized = text.toLowerCase()
  const issues = []
  const strengths = []
  let score = 55

  if (isEditorLocationPrompt(userPrompt)) {
    if (normalized.includes('apps/editor')) {
      score += 35
      strengths.push('已指出编辑器前端目录 apps/editor')
    } else {
      issues.push('缺少编辑器前端目录 apps/editor')
    }
    if (normalized.includes('apps/control-console') || normalized.includes('apps/control-server')) {
      score -= 35
      issues.push('把 editor 问题错误带回了上一题 control 目录')
    }
  }

  if (isBusinessServerLocationPrompt(userPrompt)) {
    if (normalized.includes('apps/server')) {
      score += 35
      strengths.push('已指出业务后端目录 apps/server')
    } else {
      issues.push('缺少业务后端目录 apps/server')
    }
  }

  const workspaceStructure = artifacts?.workspaceStructure && typeof artifacts.workspaceStructure === 'object'
    ? artifacts.workspaceStructure
    : null
  if (workspaceStructure) {
    score += 10
    strengths.push('答案可由 workspaceStructure 验证')
  }

  score = Math.max(0, Math.min(100, score))
  const passed = score >= HERMES_REASONING_MIN_ACCEPT_SCORE
  return {
    score,
    passed,
    source: 'deterministic',
    summary: passed ? `工作区目录答案评分 ${score}/100，已通过。` : `工作区目录答案评分 ${score}/100，未达到 ${HERMES_REASONING_MIN_ACCEPT_SCORE} 分。`,
    strengths,
    issues,
    correctionPrompt: passed
      ? '当前答案已通过质量门槛。'
      : '必须以当前明确问题为准。编辑器前端目录是 apps/editor，不要沿用上一题的 apps/control-console 或 apps/control-server。'
  }
}

export function evaluateWorkspaceFileQuestionAnswerQuality(userPrompt, answer, artifacts) {
  const text = String(answer || '')
  const normalized = text.toLowerCase()
  const filePaths = inferWorkspaceFilesFromPrompt(userPrompt)
  const fileContents = artifacts?.fileContents && typeof artifacts.fileContents === 'object'
    ? artifacts.fileContents
    : {}
  const readFilePaths = new Set(Object.keys(fileContents).map((filePath) => normalizeWorkspaceRelativePath(path.relative(GAMESTUDIO_ROOT, filePath))))
  const issues = []
  const strengths = []
  let score = 45

  for (const filePath of filePaths) {
    if (normalized.includes(filePath.toLowerCase()) || normalized.includes(path.basename(filePath).toLowerCase())) {
      score += 12
      strengths.push(`已回答 ${filePath}`)
    } else {
      issues.push(`回答缺少 ${filePath}`)
    }

    if (readFilePaths.has(filePath)) {
      score += 8
      strengths.push(`已读取 ${filePath} 作为证据`)
    } else {
      issues.push(`缺少 ${filePath} 的 read_file_content 证据`)
    }
  }

  if (/短任务|短期|Ready|In Progress|Blocked|待办|进行中|阻塞|验收标准/i.test(text)) {
    score += 12
    strengths.push('已说明短任务队列的执行层职责')
  } else if (filePaths.some((filePath) => filePath.endsWith('TASK_QUEUE.md'))) {
    issues.push('没有说明 TASK_QUEUE.md 的短任务/状态队列职责')
  }

  if (/长任务|长期|主线|LT-0|里程碑|端到端|完成标准/i.test(text)) {
    score += 12
    strengths.push('已说明长任务主线的战略层职责')
  } else if (filePaths.some((filePath) => filePath.endsWith('LONG_TASKS.md'))) {
    issues.push('没有说明 LONG_TASKS.md 的长任务/主线职责')
  }

  if (/写入|已更新|已经修改|删除|重写/.test(text) && !/不需要写入|没有写入|未写入/.test(text)) {
    score -= 20
    issues.push('只读问答不应声称已经修改文件')
  }

  score = Math.max(0, Math.min(100, score))
  const passed = score >= HERMES_REASONING_MIN_ACCEPT_SCORE
  return {
    score,
    passed,
    source: 'deterministic',
    summary: passed ? `文件职责答案评分 ${score}/100，已通过。` : `文件职责答案评分 ${score}/100，未达到 ${HERMES_REASONING_MIN_ACCEPT_SCORE} 分。`,
    strengths,
    issues,
    correctionPrompt: passed
      ? '当前答案已通过质量门槛。'
      : '必须基于 read_file_content 工具读取到的文件内容，分别说明每个文件的职责，不要声称修改文件。'
  }
}

export function evaluateWorkspaceDirectoryQuestionAnswerQuality(userPrompt, answer, artifacts) {
  const text = String(answer || '')
  const normalized = text.toLowerCase()
  const dirPaths = inferWorkspaceDirectoriesFromPromptText(userPrompt)
  const directoryListings = artifacts?.directoryListings && typeof artifacts.directoryListings === 'object'
    ? artifacts.directoryListings
    : {}
  const fileContents = artifacts?.fileContents && typeof artifacts.fileContents === 'object'
    ? artifacts.fileContents
    : {}
  const readFilePaths = new Set(Object.keys(fileContents).map((filePath) => normalizeWorkspaceRelativePath(path.relative(GAMESTUDIO_ROOT, filePath))))
  const issues = []
  const strengths = []
  let score = 20
  let completeEvidenceChains = 0
  let explainedDirectoryResponsibilities = 0

  for (const dirPath of dirPaths) {
    if (normalized.includes(dirPath.toLowerCase())) {
      score += 10
      strengths.push(`已回答 ${dirPath}`)
    } else {
      issues.push(`回答缺少 ${dirPath}`)
    }

    if (directoryListings[dirPath]) {
      score += 12
      strengths.push(`已列出 ${dirPath} 目录作为证据`)
    } else {
      issues.push(`缺少 ${dirPath} 的 list_directory_contents 证据`)
    }

    if (readFilePaths.has(`${dirPath}/package.json`)) {
      score += 12
      strengths.push(`已读取 ${dirPath}/package.json`)
    }

    const hasEntryEvidence = Array.from(readFilePaths).some((filePath) => filePath.startsWith(`${dirPath}/src/`))
    if (hasEntryEvidence) {
      score += 12
      strengths.push(`已读取 ${dirPath} 的 src 入口证据`)
    }

    if (directoryListings[dirPath] && (readFilePaths.has(`${dirPath}/package.json`) || hasEntryEvidence)) {
      completeEvidenceChains += 1
    }

    if (answerExplainsDirectoryResponsibility(dirPath, text)) {
      score += 18
      explainedDirectoryResponsibilities += 1
      strengths.push(`已说明 ${dirPath} 的职责语义`)
    } else {
      issues.push(`没有说明 ${dirPath} 的职责语义`)
    }
  }

  if (dirPaths.includes('apps/editor')) {
    if (/前端|编辑器|react|vite|界面|用户|交互/i.test(text)) {
      score += 10
      strengths.push('已说明 apps/editor 的前端/编辑器职责')
    } else {
      issues.push('没有说明 apps/editor 的前端/编辑器职责')
    }
  }

  if (dirPaths.includes('apps/server')) {
    if (/后端|服务|api|hono|存储|生成|路由/i.test(text)) {
      score += 10
      strengths.push('已说明 apps/server 的后端/API/业务职责')
    } else {
      issues.push('没有说明 apps/server 的后端/API/业务职责')
    }
  }

  if (/read_file_content_not_found|README\.md.*不存在|找不到.*README/i.test(text)) {
    score -= 15
    issues.push('答案不应把 README 缺失作为停止分析的主要结论')
  }

  const unsupportedFileClaims = findUnsupportedReadFileClaims(text, dirPaths, readFilePaths)
  if (unsupportedFileClaims.length > 0) {
    score -= Math.min(45, unsupportedFileClaims.length * 25)
    issues.push(`答案声称读取或基于未观测文件：${unsupportedFileClaims.join('、')}`)
  }

  if (/上一版|上一次|前一轮|重新规划|质量评分|自动质检|校准样本/i.test(text)) {
    score -= 15
    issues.push('最终答案不应把内部质检、重试或上一版回答暴露给用户')
  }

  if (dirPaths.length > 0 && completeEvidenceChains === dirPaths.length && explainedDirectoryResponsibilities === dirPaths.length && issues.length === 0) {
    score += 10
    strengths.push('所有指定目录都有完整证据链和职责解释')
  }

  score = Math.max(0, Math.min(100, score))
  const passed = score >= HERMES_REASONING_MIN_ACCEPT_SCORE
  return {
    score,
    passed,
    source: 'deterministic',
    summary: passed ? `目录职责答案评分 ${score}/100，已通过。` : `目录职责答案评分 ${score}/100，未达到 ${HERMES_REASONING_MIN_ACCEPT_SCORE} 分。`,
    strengths,
    issues,
    correctionPrompt: passed
      ? '当前答案已通过质量门槛。'
      : '必须基于 list_directory_contents、package.json 和入口文件证据，分别说明每个指定目录的职责；不要因为 README 缺失而停止分析。'
  }
}

function findUnsupportedReadFileClaims(answerText, dirPaths, readFilePaths) {
  const text = String(answerText || '')
  const pathTokens = [...new Set((text.match(/`?([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9]+)`?/g) || [])
    .map((token) => token.replace(/`/g, '').replace(/[).,;，。；：]+$/g, ''))
    .filter(Boolean))]
  const unsupported = []

  for (const token of pathTokens) {
    const candidates = normalizeMentionedFilePathCandidates(token, dirPaths)
    const supported = candidates.some((candidate) => readFilePaths.has(candidate))
    const nearbyClaimPattern = new RegExp(`(读取|读了|查看|检查|基于|证据|核心文件)[^。\n]{0,80}${escapeRegExp(token)}|${escapeRegExp(token)}[^。\n]{0,80}(读取|读了|查看|检查|基于|证据|核心文件)`, 'i')
    if (!supported && nearbyClaimPattern.test(text)) {
      unsupported.push(candidates[0] || token)
    }
  }

  return [...new Set(unsupported)]
}

function normalizeMentionedFilePathCandidates(token, dirPaths) {
  const cleaned = normalizeWorkspaceRelativePath(token).replace(/^\.\//, '').replace(/^\/+/, '')
  const candidates = [cleaned]
  for (const dirPath of dirPaths) {
    if (!cleaned.startsWith(`${dirPath}/`)) {
      candidates.push(`${dirPath}/${cleaned}`)
    }
  }
  return [...new Set(candidates)]
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function answerExplainsDirectoryResponsibility(dirPath, answerText) {
  const text = String(answerText || '')
  if (!/职责|负责|作用|用途|控制|服务|前端|后端|编辑器|运行时|接口|路由|管理|存储|生成|构建|schema|配置|文档|脚本|监控/i.test(text)) {
    return false
  }

  const directoryRolePatterns = {
    'apps/control-server': /控制平面|控制服务|control\s*server|http\s*控制|api|路由|hono|reasoning|推理|会话|生命周期|runtime/i,
    'apps/control-console': /控制台|control\s*console|前端|vue|vite|界面|可观测|审核|操作/i,
    'apps/editor': /编辑器|前端|react|vite|h5|交互|故事|studio|用户界面/i,
    'apps/server': /后端|业务服务|api|hono|存储|故事|项目|生成|路由/i,
    storage: /存储|项目数据|demo|素材|内容|state|持久化/i,
    docs: /文档|说明|规范|计划|报告|设计/i,
    scripts: /脚本|自动化|测试|启动|停止|构建|生命周期/i,
    packages: /包|共享|runtime|schema|builder|库|模块/i,
    config: /配置|hermes|模型|技能|intent|状态/i,
    monitor: /监控|dashboard|openclaw|观测|状态/i,
    ai: /记忆|agent|工作流|chat|memory|任务|状态/i
  }

  const exactPattern = directoryRolePatterns[dirPath]
  if (exactPattern) return exactPattern.test(text)

  const prefix = Object.keys(directoryRolePatterns).find((key) => dirPath === key || dirPath.startsWith(`${key}/`))
  if (prefix) return directoryRolePatterns[prefix].test(text)
  return /职责|负责|作用|用途|用于|模块|目录/i.test(text)
}

export function evaluateImageServiceAnswerQuality(answer, artifacts) {
  const text = String(answer || '')
  const normalized = text.toLowerCase()
  const requiredPaths = [
    'apps/server/src/index.js',
    'apps/server/src/ai/background.js',
    'apps/server/src/ai/imagePrompt.js'
  ]
  const optionalPaths = ['apps/server/src/ai/storyAssets.js']
  const hallucinationPatterns = [
    'tools/vision_tools.py',
    'agent/auxiliary_client.py',
    'tools/registry.py',
    'tools/openrouter_client.py',
    'gateway/',
    'web/'
  ]

  let score = 45
  const strengths = []
  const issues = []

  for (const filePath of requiredPaths) {
    if (normalized.includes(filePath.toLowerCase())) {
      score += 15
      strengths.push(`已命中关键入口 ${filePath}`)
    } else {
      issues.push(`缺少关键入口 ${filePath}`)
    }
  }

  for (const filePath of optionalPaths) {
    if (normalized.includes(filePath.toLowerCase())) {
      score += 8
      strengths.push(`已补充扩展入口 ${filePath}`)
    }
  }

  if (/api\/studio\/image\/test|api\/studio\/image\/preflight|api\/studio\/image\/models/i.test(text)) {
    score += 10
    strengths.push('已指出 index.js 中的图片路由证据')
  } else {
    issues.push('没有指出 index.js 中的图片路由证据')
  }

  if (/generatebackgroundimage|generatebackgroundprompt|buildstoryassetplan|buildstoryscenerenderspec/i.test(normalized)) {
    score += 10
    strengths.push('已指出服务端内部调用证据')
  } else {
    issues.push('没有指出服务端内部调用证据')
  }

  const foundHallucinations = hallucinationPatterns.filter((pattern) => normalized.includes(pattern.toLowerCase()))
  if (foundHallucinations.length > 0) {
    score -= foundHallucinations.length * 25
    issues.push(`出现仓库外或错误路径：${foundHallucinations.join('、')}`)
  }

  score = Math.max(0, Math.min(100, score))
  const passed = score >= HERMES_REASONING_MIN_ACCEPT_SCORE
  return {
    score,
    passed,
    source: 'deterministic',
    summary: passed ? `图片入口答案评分 ${score}/100，已通过。` : `图片入口答案评分 ${score}/100，未达到 ${HERMES_REASONING_MIN_ACCEPT_SCORE} 分。`,
    strengths,
    issues,
    correctionPrompt: passed
      ? '当前答案已通过质量门槛。'
      : [
          '必须仅基于当前 GameStudio 仓库回答。',
          '必须明确指出 apps/server/src/index.js、apps/server/src/ai/background.js、apps/server/src/ai/imagePrompt.js。',
          '如涉及故事资产链路，可补充 apps/server/src/ai/storyAssets.js。',
          '必须说明它们为什么是入口文件，并引用 /api/studio/image/* 或 generateBackgroundImage / generateBackgroundPrompt / buildStoryAssetPlan 等可观测证据。',
          '禁止再提 tools/vision_tools.py、gateway、web、agent/auxiliary_client.py 等当前仓库不存在路径。'
        ].join('\n')
  }
}
