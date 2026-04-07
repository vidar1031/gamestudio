// API client for game_studio editor

import type {
  AiBackgroundRequest,
  BlueprintDocV1,
  DemoItem,
  DemoMeta,
  ProjectV1,
  ScriptDocV1,
  StoryV1
} from '@game-studio/schema'
import { normalizeProjectV1 } from '@game-studio/schema'

export type { AiBackgroundRequest, BlueprintDocV1, DemoItem, DemoMeta, ProjectV1, ScriptDocV1, StoryV1 } from '@game-studio/schema'
export type * from '@game-studio/schema'

// ===== HTTP helpers =====
function base() {
  return (import.meta as any).env?.VITE_STUDIO_API_BASE || 'http://localhost:1999'
}

/**
 * 基础 HTTP 请求工具函数
 * 封装了 fetch 请求，统一处理 JSON 响应和错误
 * @param url - 请求地址
 * @param init - fetch 请求配置（会自动添加 Content-Type: application/json）
 * @returns 解析后的 JSON 数据
 * @throws 当请求失败或响应中 success !== true 时抛出错误
 */
async function j(url: string, init?: RequestInit) {
  let resp: Response
  try {
    resp = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init && init.headers ? init.headers : {})
      }
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Browser fetch throws TypeError("Failed to fetch") on network/CORS failures.
    throw new Error(`Failed to fetch: ${url} (${msg}). 请确认 studio server 正在运行且可访问：${base()}/api/health`)
  }
  const json = (await resp.json().catch(() => null)) as any
  if (!resp.ok || !json || json.success !== true) {
    // 优先使用 message 作为用户可见的错误信息；error 通常是简短代码如 "ai_faile
    const msg = json && (json.message || json.error) ? String(json.message || json.error) : `HTTP ${resp.status}`
    throw new Error(msg)
  }
  return json
}

/**
 * 解析完整 URL
 * @param pathname - API 路径
 * @returns 完整的 API 地址
 */
export function resolveUrl(pathname: string) {
  return `${base()}${pathname}`
}

// ===== Projects =====
/**
 * 获取所有项目列表
 * @returns 项目数组
 */
export async function listProjects(): Promise<ProjectV1[]> {
  const json = await j(`${base()}/api/projects`, { method: 'GET' })
  return Array.isArray(json.items) ? (json.items as any[]).map((p) => normalizeProjectV1(p)) : []
}

/**
 * 创建新项目
 * @param title - 项目标题
 * @returns 创建的项目对象
 */
export async function createProject(title: string): Promise<ProjectV1> {
  const json = await j(`${base()}/api/projects`, { method: 'POST', body: JSON.stringify({ title }) })
  return normalizeProjectV1(json.project)
}

/**
 * 使用 AI 创建项目（简化版）
 * @param prompt - AI 生成提示词
 * @param title - 可选的项目标题
 * @returns 创建的项目对象
 */
export async function createProjectWithAi(prompt: string, title?: string): Promise<ProjectV1> {
  const json = await j(`${base()}/api/projects/ai/create`, {
    method: 'POST',
    body: JSON.stringify({ prompt, title })
  })
  return normalizeProjectV1(json.project)
}

/**
 * AI 创建项目详细结果类型
 * 包含项目、脚本和生成元数据
 */
export type AiCreateResult = {
  project: ProjectV1
  scripts: ScriptDocV1
  blueprint?: BlueprintDocV1
  gen: {
    ok?: boolean
    message?: string | null
    requestedProvider?: string
    provider: string
    model?: string | null
    api?: string | null
    durationMs?: number
    formula?: { choicePoints?: number; optionsPerChoice?: number; endings?: number; format?: string } | null
    error?: { message?: string; status?: number | null; code?: string | null; cause?: string | null } | null
    repaired?: boolean
    before?: { report?: any; validation?: any; issues?: any[] } | null
    after?: { report?: any; validation?: any; issues?: any[] } | null
  }
}


/**
 * 使用 AI 创建项目（详细版）
 * 返回项目、脚本和 AI 生成元数据
 * @param prompt - AI 生成提示词
 * @param title - 可选的项目标题
 * @param opts - 可选的生成参数（选择点数量、选项数、结局数）
 * @returns 包含项目、脚本和生成信息的详细结果
 */
export async function createProjectWithAiDetailed(
  prompt: string,
  title?: string,
  opts?: { choicePoints?: number; optionsPerChoice?: number; endings?: number }
): Promise<AiCreateResult> {
  const json = await j(`${base()}/api/projects/ai/create`, {
    method: 'POST',
    body: JSON.stringify({ prompt, title, ...(opts || {}) })
  })
  return {
    project: normalizeProjectV1(json.project),
    scripts: json.scripts as ScriptDocV1,
    blueprint: json.blueprint as BlueprintDocV1,
    gen: (json.gen as any) || { provider: 'unknown', requestedProvider: 'unknown' }
  }
}

/**
 * 使用 AI 重新生成项目脚本（详细版）
 * @param projectId - 项目 ID
 * @param prompt - AI 生成提示词
 * @param title - 可选的项目标题
 * @param opts - 可选的生成参数
 * @returns 包含项目、脚本和生成信息的详细结果
 */
export async function regenerateProjectScriptsWithAiDetailed(
  projectId: string,
  prompt: string,
  title?: string,
  opts?: { choicePoints?: number; optionsPerChoice?: number; endings?: number }
): Promise<AiCreateResult> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/regenerate`, {
    method: 'POST',
    body: JSON.stringify({ prompt, title, ...(opts || {}) })
  })
  return {
    project: normalizeProjectV1(json.project),
    scripts: json.scripts as ScriptDocV1,
    blueprint: json.blueprint as BlueprintDocV1,
    gen: (json.gen as any) || { provider: 'unknown', requestedProvider: 'unknown' }
  }
}

/**
 * AI 脚本分析结果类型
 */
export type AiScriptAnalysis = {
  ok: boolean
  summary: string
  stats?: { cardCount?: number; choiceCount?: number; firstChoiceCard?: number | null; endingCount?: number }
  checks: { id: string; ok: boolean; severity: string; message: string; detail?: any }[]
  suggestions: string[]
  proposedRules?: any
}

export type StoryPromptReview = {
  local: {
    ok: boolean
    score: number
    summary: string
    checks: { id: string; ok: boolean; severity: string; message: string }[]
    suggestions: string[]
    optimizedPrompt: string
  }
  ai: {
    verdict: 'ok' | 'warn' | 'error'
    summary: string
    strengths: string[]
    risks: string[]
    suggestions: string[]
    optimizedPrompt: string
  }
  meta: { provider?: string; model?: string | null; api?: string | null; durationMs?: number; note?: string }
  aiError?: { message?: string; status?: number | null; code?: string | null } | null
}

export type StoryboardPromptQualityResult = {
  verdict: 'ok' | 'warn' | 'error'
  score: number
  summary: string
  strengths: string[]
  risks: string[]
  suggestions: string[]
  optimizedGlobalPromptZh: string
  optimizedGlobalNegativePromptZh: string
  optimizedScenePromptZh: string
  optimizedSceneNegativePromptZh: string
  optimizedPrompt: string
  optimizedNegativePrompt: string
}

export type StoryboardPromptQualityReview = {
  local: StoryboardPromptQualityResult
  ai: StoryboardPromptQualityResult
  meta: { provider?: string; model?: string | null; api?: string | null; durationMs?: number; note?: string }
  aiError?: { message?: string; status?: number | null; code?: string | null } | null
}

export type StoryPromptTemplateItem = {
  id: string
  createdAt: string
  title?: string | null
  templateKey?: string | null
  templateName?: string | null
  templateSummary?: string | null
  prompt: string
  notes?: string[]
  fields?: Record<string, any>
  formula?: { choicePoints?: number; optionsPerChoice?: number; endings?: number }
  meta?: { provider?: string; model?: string | null; api?: string | null; durationMs?: number; note?: string | null } | null
}


/**
 * 使用 AI 分析项目脚本
 * 检查脚本结构、提供统计信息和改进建议
 * @param projectId - 项目 ID
 * @returns 分析结果
 */
export async function analyzeProjectScripts(projectId: string): Promise<AiScriptAnalysis> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/analyze/scripts`, { method: 'POST' })
  return json.analysis as AiScriptAnalysis
}

export async function reviewStoryPrompt(
  prompt: string,
  title?: string,
  opts?: { choicePoints?: number; optionsPerChoice?: number; endings?: number }
): Promise<StoryPromptReview> {
  const json = await j(`${base()}/api/ai/prompt/review`, {
    method: 'POST',
    body: JSON.stringify({ prompt, title, ...(opts || {}) })
  })
  return json.review as StoryPromptReview
}

export async function reviewStoryboardPromptAi(
  projectId: string,
  payload: {
    scope?: 'global' | 'scene'
    projectTitle?: string
    storyBibleJson?: string
    globalPromptZh?: string
    globalPrompt?: string
    globalNegativePromptZh?: string
    globalNegativePrompt?: string
    sceneUserInput?: string
    scenePromptZh?: string
    scenePrompt?: string
    sceneNegativePromptZh?: string
    sceneNegativePrompt?: string
    style?: string
    aspectRatio?: string
  }
): Promise<StoryboardPromptQualityReview> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/storyboard/prompt-review`, {
    method: 'POST',
    body: JSON.stringify(payload || {})
  })
  return json.review as StoryboardPromptQualityReview
}

export async function listStoryPromptTemplates(): Promise<StoryPromptTemplateItem[]> {
  const json = await j(`${base()}/api/ai/prompt/templates`, { method: 'GET' })
  return Array.isArray(json.items) ? (json.items as StoryPromptTemplateItem[]) : []
}

export async function saveStoryPromptTemplate(input: {
  prompt: string
  title?: string
  templateKey?: string | null
  templateName?: string | null
  templateSummary?: string | null
  notes?: string[]
  fields?: Record<string, any>
  choicePoints?: number
  optionsPerChoice?: number
  endings?: number
  meta?: Record<string, any> | null
}): Promise<StoryPromptTemplateItem> {
  const json = await j(`${base()}/api/ai/prompt/templates`, {
    method: 'POST',
    body: JSON.stringify(input)
  })
  return json.item as StoryPromptTemplateItem
}

export async function deleteStoryPromptTemplate(id: string): Promise<{ removed: boolean; items: StoryPromptTemplateItem[] }> {
  const json = await j(`${base()}/api/ai/prompt/templates/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return {
    removed: Boolean(json.removed),
    items: Array.isArray(json.items) ? (json.items as StoryPromptTemplateItem[]) : []
  }
}

export async function generateStoryPromptTemplateWithAi(input: {
  title: string
  templateKey?: string
  templateName?: string
  templateSummary?: string
  fields?: Record<string, any>
  choicePoints?: number
  optionsPerChoice?: number
  endings?: number
}): Promise<{ item: StoryPromptTemplateItem; generated: { prompt: string; title?: string | null; notes?: string[] }; meta?: any }> {
  const json = await j(`${base()}/api/ai/prompt/templates/generate`, {
    method: 'POST',
    body: JSON.stringify(input)
  })
  return {
    item: json.item as StoryPromptTemplateItem,
    generated: json.generated as { prompt: string; title?: string | null; notes?: string[] },
    meta: json.meta
  }
}

/**
 * 获取全局 AI 规则
 * @returns 全局 AI 规则配置或 null
 */
export async function getGlobalAiRules(): Promise<any | null> {
  const json = await j(`${base()}/api/ai/rules`, { method: 'GET' })
  return (json.rules as any) || null
}

/**
 * 保存全局 AI 规则
 * @param rules - 规则配置
 * @returns 保存后的规则
 */
export async function saveGlobalAiRules(rules: any): Promise<any> {
  const json = await j(`${base()}/api/ai/rules`, { method: 'PUT', body: JSON.stringify({ rules }) })
  return json.rules as any
}

/**
 * 获取项目详情（包含项目和故事）
 * @param id - 项目 ID
 * @returns 项目和故事对象
 */
export async function getProject(id: string): Promise<{ project: ProjectV1; story: StoryV1 }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(id)}`, { method: 'GET' })
  return { project: normalizeProjectV1(json.project), story: json.story as StoryV1 }
}

/**
 * 保存项目（可更新项目信息和故事）
 * @param id - 项目 ID
 * @param payload - 包含项目或故事的更新数据
 * @returns 更新后的项目对象
 */
export async function saveProject(id: string, payload: { project?: Partial<ProjectV1>; story?: StoryV1 }): Promise<ProjectV1> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) })
  return normalizeProjectV1(json.project)
}

/**
 * 删除项目
 * @param id - 项目 ID
 */
export async function deleteProject(id: string): Promise<void> {
  await j(`${base()}/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/**
 * 导出项目
 * @param id - 项目 ID
 * @returns 构建 ID 和分发 URL
 */
export async function exportProject(id: string): Promise<{ buildId: string; distUrl: string }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(id)}/export`, { method: 'POST' })
  return { buildId: String(json.buildId || ''), distUrl: String(json.distUrl || '') }
}

export async function exportPublishPackage(id: string): Promise<{ buildId: string; distUrl: string; packageUrl: string; packageName: string; packageBytes: number }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(id)}/export/publish`, { method: 'POST' })
  return {
    buildId: String(json.buildId || ''),
    distUrl: String(json.distUrl || ''),
    packageUrl: String(json.packageUrl || ''),
    packageName: String(json.packageName || ''),
    packageBytes: Number(json.packageBytes || 0)
  }
}

export type ProjectExportItem = {
  buildId: string
  createdAt: string
  distUrl: string
  packageUrl: string
  packageName: string
}

export async function listProjectExports(id: string): Promise<ProjectExportItem[]> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(id)}/exports`, { method: 'GET' })
  return Array.isArray(json.items) ? (json.items as ProjectExportItem[]) : []
}

export async function deleteProjectExport(id: string, buildId: string): Promise<{ removed: boolean }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(id)}/exports/${encodeURIComponent(buildId)}`, { method: 'DELETE' })
  return { removed: Boolean(json.removed) }
}


// ===== 脚本管理 (Scripts) =====

/**
 * 获取项目脚本
 * @param projectId - 项目 ID
 * @returns 脚本文档
 */
export async function getScripts(projectId: string): Promise<ScriptDocV1> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/scripts`, { method: 'GET' })
  return json.scripts as ScriptDocV1
}

/**
 * 保存项目脚本
 * @param projectId - 项目 ID
 * @param scripts - 脚本文档
 * @returns 保存后的脚本文档
 */
export async function saveScripts(projectId: string, scripts: ScriptDocV1): Promise<ScriptDocV1> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/scripts`, {
    method: 'PUT',
    body: JSON.stringify({ scripts })
  })
  return json.scripts as ScriptDocV1
}


// ===== 蓝图管理 (Blueprint) =====

/**
 * 获取项目蓝图
 * @param projectId - 项目 ID
 * @returns 蓝图文档
 */
export async function getBlueprint(projectId: string): Promise<BlueprintDocV1> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/blueprint`, { method: 'GET' })
  return json.blueprint as BlueprintDocV1
}

/**
 * 保存项目蓝图
 * @param projectId - 项目 ID
 * @param blueprint - 蓝图文档
 * @returns 保存后的蓝图文档
 */
export async function saveBlueprint(projectId: string, blueprint: BlueprintDocV1): Promise<BlueprintDocV1> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/blueprint`, {
    method: 'PUT',
    body: JSON.stringify({ blueprint })
  })
  return json.blueprint as BlueprintDocV1
}

/**
 * 蓝图编译结果类型
 */
export type BlueprintCompileResult = {
  blueprint: BlueprintDocV1
  report?: { errors?: any[]; warnings?: any[]; info?: any[] } | null
  validation?: { ok: boolean; errors?: any[]; warnings?: any[]; stats?: any } | null
}

/**
 * 编译蓝图（简化版）
 * @param projectId - 项目 ID
 * @returns 编译后的蓝图
 */
export async function compileBlueprint(projectId: string): Promise<BlueprintDocV1> {
  const res = await compileBlueprintDetailed(projectId)
  return res.blueprint
}

/**
 * 编译蓝图（详细版）
 * 返回蓝图、报告（错误/警告/信息）和验证结果
 * @param projectId - 项目 ID
 * @returns 编译结果
 */
export async function compileBlueprintDetailed(projectId: string): Promise<BlueprintCompileResult> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/compile/blueprint`, {
    method: 'POST',
    body: JSON.stringify({})
  })
  return {
    blueprint: json.blueprint as BlueprintDocV1,
    report: (json.report as any) || null,
    validation: (json.validation as any) || null
  }
}

/**
 * 编译组合（生成项目和故事）
 * @param projectId - 项目 ID
 * @returns 项目和故事对象
 */
export async function compileCompose(projectId: string): Promise<{ project: ProjectV1; story: StoryV1 }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/compile/compose`, {
    method: 'POST',
    body: JSON.stringify({})
  })
  return { project: json.project as ProjectV1, story: json.story as StoryV1 }
}

/**
 * AI 蓝图审查结果类型
 */
export type AiBlueprintReview = {
  verdict: 'ok' | 'warn' | 'error'
  summary: string
  rootCauses: string[]
  userFacingExplanation: string[]
  suggestedEdits: { target: string; change: string; example: string | null }[]
}

/**
 * 使用 AI 审查蓝图
 * 检查蓝图结构、提供问题和修复建议
 * @param projectId - 项目 ID
 * @returns 审查结果和元数据
 */
export async function reviewBlueprintWithAi(projectId: string): Promise<{
  review: AiBlueprintReview
  meta: { provider: string; api?: string; model?: string; durationMs?: number }
  report?: any
  validation?: any
}> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/review/blueprint`, { method: 'POST' })
  return { review: json.review as AiBlueprintReview, meta: (json.meta as any) || { provider: 'unknown' }, report: json.report, validation: json.validation }
}

/**
 * 获取缓存的蓝图审查结果
 * @param projectId - 项目 ID
 * @returns 缓存的审查结果或 null
 */
export async function getCachedBlueprintReview(projectId: string): Promise<any | null> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/review/blueprint`, { method: 'GET' })
  return (json.cached as any) || null
}

/**
 * 使用 AI 修复脚本
 * 自动修复脚本中的问题
 * @param projectId - 项目 ID
 * @returns 修复后的脚本和前后对比信息
 */
export async function fixScriptsWithAi(projectId: string): Promise<{
  scripts: ScriptDocV1
  meta: { provider: string; api?: string; model?: string; durationMs?: number }
  before?: { report?: any; validation?: any }
  after?: { blueprint?: BlueprintDocV1; report?: any; validation?: any }
}> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/fix/scripts`, { method: 'POST' })
  return {
    scripts: json.scripts as ScriptDocV1,
    meta: (json.meta as any) || { provider: 'unknown' },
    before: json.before,
    after: json.after
  }
}

// ===== 演示库 (Demo Library) =====

/**
 * 获取演示项目列表（只读模板）
 * @returns 演示项目数组
 */
export async function listDemos(): Promise<DemoItem[]> {
  const json = await j(`${base()}/api/demos`, { method: 'GET' })
  return Array.isArray(json.items) ? (json.items as DemoItem[]) : []
}

/**
 * 获取单个演示项目详情
 * @param id - 演示 ID
 * @returns 演示元数据、项目和故事
 */
export async function getDemo(id: string): Promise<{ demo: DemoMeta; project: ProjectV1 | null; story: StoryV1 }> {
  const json = await j(`${base()}/api/demos/${encodeURIComponent(id)}`, { method: 'GET' })
  return {
    demo: json.demo as DemoMeta,
    project: (json.project as ProjectV1 | null) ?? null,
    story: json.story as StoryV1
  }
}

// ===== AI 图像生成 - 背景 (AI Background) =====

/**
 * 使用 AI 生成背景图像
 * @param projectId - 项目 ID
 * @param payload - 生成请求参数
 * @returns 生成的图像路径、URL 和提供者信息
 */
export async function generateBackgroundAi(
  projectId: string,
  payload: AiBackgroundRequest
): Promise<{ assetPath: string; url: string; provider: string; remoteUrl?: string; seed?: number; continuityUsed?: boolean }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/background`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
  return {
    assetPath: String(json.assetPath || ''),
    url: String(json.url || ''),
    provider: String(json.provider || ''),
    remoteUrl: String(json.remoteUrl || '').trim() || undefined,
    seed: Number.isFinite(Number(json.seed)) ? Number(json.seed) : undefined,
    continuityUsed: Boolean(json.continuityUsed)
  }
}

/**
 * 分析背景生成提示词
 * 处理用户输入，生成最终的提示词和负面提示词
 * @param projectId - 项目 ID
 * @param payload - 包含用户输入和全局提示的参数
 * @returns 处理后的提示词结果和元数据
 */
export async function analyzeBackgroundPromptAi(
  projectId: string,
  payload: Pick<AiBackgroundRequest, 'userInput' | 'globalPrompt' | 'globalNegativePrompt' | 'aspectRatio' | 'style' | 'timeoutMs'> & { outputLanguage?: 'en' | 'zh' }
): Promise<{
  result: {
    globalPrompt: string
    globalNegativePrompt: string
    prompt: string
    negativePrompt: string
    finalPrompt?: string
    finalNegativePrompt?: string
    steps?: number | null
    cfgScale?: number | null
    sampler?: string | null
    scheduler?: string | null
    aspectRatio: string
    style: string
  }
  meta: any
}> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/background/prompt`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
  return {
    result: json.result as any,
    meta: (json.meta as any) || null
  }
}

export async function generateStoryBibleAi(
  projectId: string,
  payload: { input: any; timeoutMs?: number }
): Promise<{ result: any; meta: any }> {
  const resp = await fetch(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/story/bible`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  })
  const json = (await resp.json().catch(() => null)) as any
  if (!resp.ok || !json || json.success !== true) {
    const msg = json && (json.message || json.error) ? String(json.message || json.error) : `HTTP ${resp.status}`
    const err = new Error(msg)
    ;(err as any).debugOutput = json && json.debugOutput ? String(json.debugOutput) : ''
    ;(err as any).traceId = json && json.traceId ? String(json.traceId) : ''
    throw err
  }
  return { result: (json.result as any) || null, meta: (json.meta as any) || null }
}

export type StoryAssetPlan = {
  schemaVersion: string
  generatedAt: string
  worldAnchor: string
  forbiddenSubstitutes: string[]
  eventChain: string[]
  assets: any[]
  scenes: any[]
  summary: {
    assetCount: number
    sceneCount: number
    refRequiredCount: number
    refReadyCount: number
    refMissingCount: number
    workflows: Record<string, number>
  }
}

export type StoryAssetPlanAsset = {
  id: string
  name: string
  category?: string
  lockProfile?: string
  lockWorkflow?: string
  renderStrategy?: string
  sceneCount?: number
  referenceStatus?: string
  primaryReferenceAssetId?: string
  primaryReferenceAssetUri?: string
  referencePromptHint?: string
  referencePromptZh?: string
  referencePromptEn?: string
}

export type StoryAssetGalleryEntry = {
  assetPath: string
  url: string
  kind: 'reference' | 'selected_white_bg' | 'lineart_hint' | 'lineart_final' | 'unknown'
  label: string
  createdAt?: string
  seed?: number
  provider?: string
  prompt?: string
  negativePrompt?: string
  isPrimary?: boolean
  isCurrentLineart?: boolean
  recommended?: boolean
  inLatestBatch?: boolean
  analysis?: any
}

export async function buildStoryAssetPlanAi(
  projectId: string,
  payload?: { storyBible?: any; rebuild?: boolean }
): Promise<StoryAssetPlan> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/story/assets/plan`, {
    method: 'POST',
    body: JSON.stringify(payload || {})
  })
  return json.plan as StoryAssetPlan
}

export async function generateStoryAssetReferenceAi(
  projectId: string,
  payload: {
    assetId: string
    style?: 'picture_book' | 'cartoon' | 'national_style' | 'watercolor'
    width?: number
    height?: number
    steps?: number
    cfgScale?: number
    sampler?: string
    scheduler?: string
    batchSize?: number
    prompt?: string
    negativePrompt?: string
    globalPrompt?: string
    globalNegativePrompt?: string
    assetPrompt?: string
    assetNegativePrompt?: string
    timeoutMs?: number
  }
): Promise<{ asset: any; analysis?: any; candidates?: any[]; projectAsset: any; assetPath: string; url: string; provider: string; remoteUrl?: string; prompt: string; negativePrompt: string; plan: StoryAssetPlan }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/story/assets/reference`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
  return {
    asset: (json.asset as any) || null,
    analysis: (json.analysis as any) || null,
    candidates: Array.isArray(json.candidates) ? json.candidates as any[] : [],
    projectAsset: (json.projectAsset as any) || null,
    assetPath: String(json.assetPath || ''),
    url: String(json.url || ''),
    provider: String(json.provider || ''),
    remoteUrl: String(json.remoteUrl || '').trim() || undefined,
    prompt: String(json.prompt || ''),
    negativePrompt: String(json.negativePrompt || ''),
    plan: json.plan as StoryAssetPlan
  }
}

export async function selectStoryAssetReferenceAi(
  projectId: string,
  payload: { assetId: string; assetPath: string }
): Promise<{ asset: any; plan: StoryAssetPlan }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/story/assets/reference/select`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
  return {
    asset: (json.asset as any) || null,
    plan: json.plan as StoryAssetPlan
  }
}

export async function generateStoryAssetLineartAi(
  projectId: string,
  payload: {
    assetId: string
    model?: string
    width?: number
    height?: number
    steps?: number
    cfgScale?: number
    denoise?: number
    seed?: number
    timeoutMs?: number
  }
): Promise<{ asset: any; plan: StoryAssetPlan; hintAssetPath: string; finalAssetPath: string; hintUrl: string; finalUrl: string; meta?: any; prompt: string; negativePrompt: string }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/story/assets/lineart`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
  return {
    asset: (json.asset as any) || null,
    plan: json.plan as StoryAssetPlan,
    hintAssetPath: String(json.hintAssetPath || ''),
    finalAssetPath: String(json.finalAssetPath || ''),
    hintUrl: String(json.hintUrl || ''),
    finalUrl: String(json.finalUrl || ''),
    meta: (json.meta as any) || null,
    prompt: String(json.prompt || ''),
    negativePrompt: String(json.negativePrompt || '')
  }
}

export async function analyzeStoryAssetReferenceAi(
  projectId: string,
  payload: { assetId: string }
): Promise<{ asset: any; analysis: any; plan: StoryAssetPlan }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/story/assets/reference/review`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
  return {
    asset: (json.asset as any) || null,
    analysis: (json.analysis as any) || null,
    plan: json.plan as StoryAssetPlan
  }
}

export async function optimizeStoryAssetReferenceAi(
  projectId: string,
  payload: {
    assetId: string
    style?: 'picture_book' | 'cartoon' | 'national_style' | 'watercolor'
    width?: number
    height?: number
    steps?: number
    cfgScale?: number
    sampler?: string
    scheduler?: string
    batchSize?: number
    globalPrompt?: string
    globalNegativePrompt?: string
    assetPrompt?: string
    assetNegativePrompt?: string
    timeoutMs?: number
  }
): Promise<{ asset: any; analysis: any; candidates?: any[]; projectAsset: any; assetPath: string; url: string; provider: string; remoteUrl?: string; prompt: string; negativePrompt: string; plan: StoryAssetPlan }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/story/assets/reference/optimize`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
  return {
    asset: (json.asset as any) || null,
    analysis: (json.analysis as any) || null,
    candidates: Array.isArray(json.candidates) ? json.candidates as any[] : [],
    projectAsset: (json.projectAsset as any) || null,
    assetPath: String(json.assetPath || ''),
    url: String(json.url || ''),
    provider: String(json.provider || ''),
    remoteUrl: String(json.remoteUrl || '').trim() || undefined,
    prompt: String(json.prompt || ''),
    negativePrompt: String(json.negativePrompt || ''),
    plan: json.plan as StoryAssetPlan
  }
}

export async function listStoryAssetGalleryAi(
  projectId: string,
  assetId: string
): Promise<{ asset: any; items: StoryAssetGalleryEntry[]; plan: StoryAssetPlan }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/story/assets/${encodeURIComponent(assetId)}/gallery`, {
    method: 'GET'
  })
  return {
    asset: (json.asset as any) || null,
    items: Array.isArray(json.items) ? json.items as StoryAssetGalleryEntry[] : [],
    plan: json.plan as StoryAssetPlan
  }
}

export async function enhanceStoryAssetPromptAi(
  projectId: string,
  assetId: string,
  payload?: {
    promptZh?: string
    promptEn?: string
    negativePromptZh?: string
    negativePrompt?: string
    globalPromptZh?: string
    globalNegativePromptZh?: string
  }
): Promise<{
  asset: any
  result: { promptZh: string; promptEn: string; negativePromptZh?: string; negativePrompt: string; summary: string; context?: any }
  meta?: { provider?: string; model?: string | null; api?: string | null; durationMs?: number; note?: string | null }
  aiError?: { message?: string; status?: number | null; code?: string | null } | null
}> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/story/assets/${encodeURIComponent(assetId)}/prompt-enhance`, {
    method: 'POST',
    body: JSON.stringify(payload || {})
  })
  return {
    asset: (json.asset as any) || null,
    result: (json.result as any) || { promptZh: '', promptEn: '', negativePromptZh: '', negativePrompt: '', summary: '' },
    meta: (json.meta as any) || undefined,
    aiError: (json.aiError as any) || null
  }
}

export async function deleteStoryAssetGalleryItemAi(
  projectId: string,
  payload: { assetId: string; assetPath: string }
): Promise<{ deleted: boolean; asset: any; items: StoryAssetGalleryEntry[]; plan: StoryAssetPlan }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/story/assets/${encodeURIComponent(payload.assetId)}/gallery/delete`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
  return {
    deleted: Boolean(json.deleted),
    asset: (json.asset as any) || null,
    items: Array.isArray(json.items) ? json.items as StoryAssetGalleryEntry[] : [],
    plan: json.plan as StoryAssetPlan
  }
}

export async function translatePromptTextAi(
  projectId: string,
  payload: {
    text: string
    sourceLang?: 'auto' | 'zh' | 'en'
    targetLang: 'zh' | 'en'
    mode?: 'prompt' | 'plain'
    timeoutMs?: number
  }
): Promise<{ result: { translatedText: string; sourceLanguage: string; targetLanguage: string }; meta: any }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/translate`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
  return {
    result: (json.result as any) || { translatedText: '', sourceLanguage: 'auto', targetLanguage: payload.targetLang },
    meta: (json.meta as any) || null
  }
}

export async function runStoryboardLockTestAi(
  projectId: string,
  payload?: {
    style?: 'picture_book' | 'cartoon' | 'national_style' | 'watercolor'
    model?: string
    loras?: string[]
    width?: number
    height?: number
    steps?: number
    cfgScale?: number
    sampler?: string
    scheduler?: string
    maxAttempts?: number
    timeoutMs?: number
  }
): Promise<{
  passed: boolean
  summary: string
  testTarget: any
  attempts: Array<{
    attempt: number
    assetId: string
    assetName: string
    prompt: string
    negativePrompt: string
    url: string
    assetPath: string
    remoteUrl?: string
    analysis: any
  }>
}> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/story/lock/test`, {
    method: 'POST',
    body: JSON.stringify(payload || {})
  })
  return {
    passed: Boolean(json.passed),
    summary: String(json.summary || ''),
    testTarget: json.testTarget || null,
    attempts: Array.isArray(json.attempts) ? json.attempts as any[] : []
  }
}

export async function renderStorySceneAi(
  projectId: string,
  sceneId: string,
  payload?: {
    style?: 'picture_book' | 'cartoon' | 'national_style' | 'watercolor'
    width?: number
    height?: number
    steps?: number
    cfgScale?: number
    sampler?: string
    scheduler?: string
    prompt?: string
    scenePrompt?: string
    negativePrompt?: string
    timeoutMs?: number
  }
): Promise<{ projectAsset: any; renderSpec: any; assetPath: string; url: string; provider: string; remoteUrl?: string; prompt: string; negativePrompt: string }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/story/scenes/${encodeURIComponent(sceneId)}/render`, {
    method: 'POST',
    body: JSON.stringify(payload || {})
  })
  return {
    projectAsset: (json.projectAsset as any) || null,
    renderSpec: (json.renderSpec as any) || null,
    assetPath: String(json.assetPath || ''),
    url: String(json.url || ''),
    provider: String(json.provider || ''),
    remoteUrl: String(json.remoteUrl || '').trim() || undefined,
    prompt: String(json.prompt || ''),
    negativePrompt: String(json.negativePrompt || '')
  }
}

// ===== AI 图像生成 - 角色 (AI Character) =====

/**
 * 使用 AI 生成角色图像
 * @param projectId - 项目 ID
 * @param payload - 生成请求参数
 * @returns 生成的图像路径、URL 和提供者信息
 */
export type AiCharacterFingerprintResult = {
  fingerprintPrompt: string
  negativePrompt: string
}

/**
 * 分析角色生成提示词
 * 处理用户输入，生成最终的提示词和负面提示词
 * @param projectId - 项目 ID
 * @param payload - 包含用户输入和全局提示的参数
 * @returns 处理后的提示词结果和元数据
 */
export async function analyzeCharacterFingerprintAi(
  projectId: string,
  payload: {
    storyTitle?: string
    characterName: string
    contextText?: string
    globalPrompt?: string
    style?: string
  }
): Promise<{ result: AiCharacterFingerprintResult; meta: any }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/character/fingerprint`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
  return { result: (json.result as any) || { fingerprintPrompt: '', negativePrompt: '' }, meta: (json.meta as any) || null }
}

export type AiCharacterSpriteRequest = {
  globalPrompt?: string
  fingerprintPrompt?: string
  posePrompt?: string
  negativePrompt?: string
  style?: string
  width?: number
  height?: number
  steps?: number
  cfgScale?: number
  guidanceScale?: number
  sequentialImageGeneration?: string
}

export async function generateCharacterSpriteAi(
  projectId: string,
  payload: AiCharacterSpriteRequest
): Promise<{ assetPath: string; url: string; provider: string; remoteUrl?: string; prompt?: string; negativePrompt?: string }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/character/sprite`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
  return {
    assetPath: String(json.assetPath || ''),
    url: String(json.url || ''),
    provider: String(json.provider || ''),
    remoteUrl: String(json.remoteUrl || '').trim() || undefined,
    prompt: typeof json.prompt === 'string' ? json.prompt : undefined,
    negativePrompt: typeof json.negativePrompt === 'string' ? json.negativePrompt : undefined
  }
}

export type AiCharacterReferenceRequest = {
  characterName: string
  globalPrompt?: string
  fingerprintPrompt?: string
  negativePrompt?: string
  style?: string
  width?: number
  height?: number
  steps?: number
  cfgScale?: number
  guidanceScale?: number
  sequentialImageGeneration?: string
}

export async function generateCharacterReferenceAi(
  projectId: string,
  payload: AiCharacterReferenceRequest
): Promise<{ assetPath: string; url: string; provider: string; remoteUrl?: string; prompt?: string; negativePrompt?: string }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/ai/character/reference`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
  return {
    assetPath: String(json.assetPath || ''),
    url: String(json.url || ''),
    provider: String(json.provider || ''),
    remoteUrl: String(json.remoteUrl || '').trim() || undefined,
    prompt: typeof json.prompt === 'string' ? json.prompt : undefined,
    negativePrompt: typeof json.negativePrompt === 'string' ? json.negativePrompt : undefined
  }
}

// ===== Assets (upload local image) =====
export async function uploadProjectImage(
  projectId: string,
  file: File
): Promise<{ assetPath: string; url: string }> {
  const form = new FormData()
  form.append('file', file)
  const resp = await fetch(`${base()}/api/projects/${encodeURIComponent(projectId)}/assets/upload`, {
    method: 'POST',
    body: form
  })
  const json = (await resp.json().catch(() => null)) as any
  if (!resp.ok || !json || json.success !== true) {
    const msg = json && (json.error || json.message) ? String(json.error || json.message) : `HTTP ${resp.status}`
    throw new Error(msg)
  }
  return { assetPath: String(json.assetPath || ''), url: String(json.url || '') }
}

export async function openProjectAssetFolder(projectId: string, uri: string): Promise<{ folder: string }> {
  const json = await j(`${base()}/api/projects/${encodeURIComponent(projectId)}/assets/open-folder`, {
    method: 'POST',
    body: JSON.stringify({ uri })
  })
  return { folder: String(json.folder || '') }
}

// ===== Studio settings (AI providers/models) =====
export type StudioSettings = {
  schemaVersion?: string
  updatedAt?: string
  enabled?: { scripts?: boolean; prompt?: boolean; image?: boolean; tts?: boolean }
  scripts?: { provider?: string | null; model?: string | null; apiUrl?: string | null }
  prompt?: { provider?: string | null; model?: string | null; apiUrl?: string | null }
  translation?: { provider?: string | null; model?: string | null; apiUrl?: string | null }
  image?: {
    provider?: string | null
    model?: string | null
    loras?: string[] | null
    apiUrl?: string | null
    size?: string | null
    sdwebuiBaseUrl?: string | null
    comfyuiBaseUrl?: string | null
    comfyuiModelsRoot?: string | null
  }
  tts?: { provider?: string | null; model?: string | null; apiUrl?: string | null }
  // NOTE: secrets are accepted on save, but never returned in full by the server.
  secrets?: { openaiApiKey?: string | null; localoxmlApiKey?: string | null; doubaoArkApiKey?: string | null }
  network?: { proxyUrl?: string | null }
}

export type StudioEffectiveConfig = {
  enabled: { scripts: boolean; prompt: boolean; image: boolean; tts: boolean }
  scripts: { provider: string; model: string | null; apiUrl?: string | null }
  prompt: { provider: string; model: string | null; apiUrl?: string | null }
  translation: { provider: string; model: string | null; apiUrl?: string | null }
  image: {
    provider: string
    model: string | null
    loras: string[] | null
    apiUrl: string | null
    size: string | null
    sdwebuiBaseUrl: string | null
    comfyuiBaseUrl: string | null
    comfyuiModelsRoot?: string | null
  }
  tts: { provider: string; model: string | null; apiUrl: string | null }
  secrets?: {
    openai: { present: boolean; masked: string | null; source: string; value?: string | null }
    localoxml: { present: boolean; masked: string | null; source: string; value?: string | null }
    doubao: { present: boolean; masked: string | null; source: string; value?: string | null }
  }
  network: { proxyUrl: string | null }
}

export async function getStudioSettings(): Promise<{ settings: StudioSettings | null; effective: StudioEffectiveConfig }> {
  const json = await j(`${base()}/api/studio/settings`, { method: 'GET' })
  return { settings: (json.settings as any) || null, effective: json.effective as StudioEffectiveConfig }
}

export async function saveStudioSettings(settings: StudioSettings): Promise<StudioSettings> {
  const json = await j(`${base()}/api/studio/settings`, { method: 'PUT', body: JSON.stringify({ settings }) })
  return json.settings as StudioSettings
}

export async function diagnoseStudio(opts?: {
  deepText?: boolean
  deepImages?: boolean
  timeoutMs?: number
  service?: 'all' | 'scripts' | 'prompt' | 'translation' | 'image'
  settings?: StudioSettings
}): Promise<any> {
  const json = await j(`${base()}/api/studio/diagnose`, { method: 'POST', body: JSON.stringify(opts || {}) })
  return json.diagnostics as any
}

export async function getAiStatus(): Promise<any> {
  const json = await j(`${base()}/api/ai/status`, { method: 'GET' })
  return json.ai as any
}

export async function getSdwebuiModels(baseUrl?: string): Promise<{ baseUrl: string; currentModel: string | null; models: string[]; note?: string }> {
  const u = new URL(`${base()}/api/studio/sdwebui/models`, window.location.origin)
  if (baseUrl && String(baseUrl).trim()) u.searchParams.set('baseUrl', String(baseUrl).trim())
  const json = await j(u.toString(), { method: 'GET' })
  return {
    baseUrl: String(json.baseUrl || ''),
    currentModel: json.currentModel == null ? null : String(json.currentModel || ''),
    models: Array.isArray(json.models) ? json.models.map((x: any) => String(x || '')).filter(Boolean) : [],
    note: json && json.note ? String(json.note) : ''
  }
}

export async function getComfyuiModels(baseUrl?: string): Promise<{ baseUrl: string; currentModel: string | null; models: string[]; loras: string[]; note?: string }> {
  const u = new URL(`${base()}/api/studio/comfyui/models`, window.location.origin)
  if (baseUrl && String(baseUrl).trim()) u.searchParams.set('baseUrl', String(baseUrl).trim())
  const json = await j(u.toString(), { method: 'GET' })
  return {
    baseUrl: String(json.baseUrl || ''),
    currentModel: json.currentModel == null ? null : String(json.currentModel || ''),
    models: Array.isArray(json.models) ? json.models.map((x: any) => String(x || '')).filter(Boolean) : [],
    loras: Array.isArray(json.loras) ? json.loras.map((x: any) => String(x || '')).filter(Boolean) : [],
    note: json && json.note ? String(json.note) : ''
  }
}

export async function getStudioImageModels(payload?: { settings?: StudioSettings }): Promise<{ source: string; provider: string; baseUrl?: string; modelsRoot?: string; dirs?: any; models: string[]; loras: string[]; note?: string }> {
  const json = await j(`${base()}/api/studio/image/models`, { method: 'POST', body: JSON.stringify(payload || {}) })
  return {
    source: String(json.source || ''),
    provider: String(json.provider || ''),
    baseUrl: json.baseUrl ? String(json.baseUrl) : '',
    modelsRoot: json.modelsRoot ? String(json.modelsRoot) : '',
    dirs: json.dirs || null,
    models: Array.isArray(json.models) ? json.models.map((x: any) => String(x || '')).filter(Boolean) : [],
    loras: Array.isArray(json.loras) ? json.loras.map((x: any) => String(x || '')).filter(Boolean) : [],
    note: json && json.note ? String(json.note) : ''
  }
}

export async function testStudioImage(payload: {
  settings?: StudioSettings
  prompt?: string
  negativePrompt?: string
  style?: 'picture_book' | 'cartoon' | 'national_style' | 'watercolor'
  model?: string
  loras?: string[]
  width?: number
  height?: number
  size?: string
  responseFormat?: 'url' | 'b64_json'
  watermark?: boolean
  sequentialImageGeneration?: 'auto' | 'disabled'
  steps?: number
  cfgScale?: number
  sampler?: string
  scheduler?: string
  timeoutMs?: number
}): Promise<{ dataUrl: string; meta: any }> {
  const json = await j(`${base()}/api/studio/image/test`, { method: 'POST', body: JSON.stringify(payload || {}) })
  return { dataUrl: String(json.result?.dataUrl || ''), meta: json.meta as any }
}

export async function preflightStudioImage(payload?: {
  settings?: StudioSettings
  timeoutMs?: number
  mode?: 'basic' | 'storyboard'
}): Promise<{ ok: boolean; checks: any; message?: string }> {
  // Unlike other endpoints, preflight must return structured checks even on non-2xx.
  const resp = await fetch(`${base()}/api/studio/image/preflight`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  })
  const json = (await resp.json().catch(() => null)) as any
  const checks = json && typeof json === 'object' ? (json.checks || null) : null
  const ok = Boolean(checks && checks.ok)
  const message = json && (json.message || json.error) ? String(json.message || json.error) : (!resp.ok ? `HTTP ${resp.status}` : '')
  return { ok, checks, message: message || undefined }
}
