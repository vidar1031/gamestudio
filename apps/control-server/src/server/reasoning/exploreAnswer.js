// 滚动压缩探索回答（rolling-compression explore answer）。
//
// 面向咨询/问答类（answer_only）请求，把「一次性大提示词回答」改为「分块探索」：
//   1. 证据源按预算分块（每块 ≤ HERMES_EXPLORE_CHUNK_CHARS）；
//   2. 逐块让模型提取「与问题相关的最小事实」进 notes（中间结论）；
//   3. notes 水位超过 HERMES_EXPLORE_NOTES_CHAR_LIMIT 时调用模型压缩合并，
//      已处理原文即弃——任何时刻只保留「未处理源 + 压缩结论」；
//   4. 全部块处理完后用压缩 notes 综合最终回答（必须直接回应问题本身）；
//   5. 切题自检：不切题则带修正重答一次；模型调用失败显式抛错（exploreFailure），不伪造。
//
// 证据源全部从运行时真实装配（见 assembleExploreEvidenceSources）：自我认知事实块、
// 记忆文件有界正文（复用 content-injection 有界注入思路）、近期对话回放。禁止写死文本。
// 本路径只读，不触发任何生产副作用。

import fs from 'node:fs'
import path from 'node:path'

import { GAMESTUDIO_ROOT } from '../../config/paths.js'
import { HERMES_CHAT_REQUEST_TIMEOUT_MS } from '../../config/constants.js'
import { requestHermesChatCompletion } from '../model/modelTaskQueue.js'
import { getProjectBinding, probeProjectBinding } from '../services/projectBindingService.js'
import { extractJsonObjectString } from './promptBuilders.js'

const DEFAULT_CONTEXT_BUDGET = 16000
const DEFAULT_CHUNK_CHARS = 6000
const DEFAULT_NOTES_CHAR_LIMIT = 4000
// 块数硬上限：与 modelTaskQueue 每 session 调用预算（默认 16）配套——
// 预留 压缩/综合/自检/重答 约 5 次调用，块处理最多 8 次，超出块上限的剩余源显式记为 dropped。
const MAX_EXPLORE_CHUNKS = 8

const NO_RELATED_FACT_PATTERN = /本块无相关事实/

function pickPositiveInt(value, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.floor(num)
}

// 预算参数（env 可配，字符级）：
// - HERMES_EXPLORE_CONTEXT_BUDGET：上下文总水位预算（默认 16000）
// - HERMES_EXPLORE_CHUNK_CHARS：单块证据字符上限（默认 6000）
// - HERMES_EXPLORE_NOTES_CHAR_LIMIT：notes 水位阈值（默认 4000），超过即压缩
export function resolveExploreBudgets(env = process.env) {
  return {
    contextBudget: pickPositiveInt(env?.HERMES_EXPLORE_CONTEXT_BUDGET, DEFAULT_CONTEXT_BUDGET),
    chunkChars: pickPositiveInt(env?.HERMES_EXPLORE_CHUNK_CHARS, DEFAULT_CHUNK_CHARS),
    notesCharLimit: pickPositiveInt(env?.HERMES_EXPLORE_NOTES_CHAR_LIMIT, DEFAULT_NOTES_CHAR_LIMIT),
  }
}

// 证据源分块：顺序切片，每块 ≤ chunkChars；空内容源不出块。
export function splitSourceIntoChunks(source, chunkChars) {
  const size = Math.max(200, pickPositiveInt(chunkChars, DEFAULT_CHUNK_CHARS))
  const text = String(source?.content || '')
  if (!text.trim()) return []
  const chunks = []
  let index = 0
  for (let offset = 0; offset < text.length; offset += size, index += 1) {
    chunks.push({
      sourceId: String(source?.id || `source_${index}`),
      label: String(source?.label || source?.id || `source_${index}`),
      index,
      text: text.slice(offset, offset + size),
    })
  }
  return chunks
}

// 读取项目事件注册表摘要（计数 + 版本），失败返回 null（不允许编造）。
export function readEventRegistrySummary(root = GAMESTUDIO_ROOT) {
  try {
    const file = path.join(root, 'apps', 'server', 'events', 'registry.v1.json')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const events = Array.isArray(parsed?.events) ? parsed.events : []
    return { count: events.length, version: String(parsed?.registryVersion || ''), file }
  } catch {
    return null
  }
}

async function probeHttp(url, { timeoutMs = 2500, headers = {} } = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 2500))
  try {
    const res = await fetch(url, { signal: controller.signal, headers })
    if (res.ok) return { reachable: true, detail: '在线' }
    return { reachable: false, detail: `HTTP ${res.status}` }
  } catch (error) {
    return { reachable: false, detail: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
  }
}

// 模型服务（OMLX）健康：GET {route.baseUrl}/models，短超时，失败不抛出。
function defaultProbeModel(route) {
  const baseUrl = String(route?.baseUrl || '').replace(/\/+$/, '')
  if (!baseUrl) return Promise.resolve({ reachable: false, detail: '未配置模型 baseUrl' })
  const headers = {
    ...(route?.apiKey ? { Authorization: `Bearer ${route.apiKey}` } : {}),
    ...(route?.headers || {}),
  }
  return probeHttp(`${baseUrl}/models`, { headers })
}

// ComfyUI 出图能力所有权在 GameStudio server，经绑定项目代理探测（与 overviewRoutes 透传口径一致）。
async function defaultProbeComfyUi(projectBinding) {
  if (!projectBinding?.bound || !projectBinding?.baseUrl) {
    return { reachable: false, detail: '未绑定项目，无法探测' }
  }
  const baseUrl = String(projectBinding.baseUrl).replace(/\/+$/, '')
  const probe = await probeHttp(`${baseUrl}/api/ai/comfyui/capability-check`)
  return probe.reachable
    ? { reachable: true, detail: '能力检查接口在线' }
    : { reachable: false, detail: probe.detail }
}

function formatProbe(probe) {
  if (!probe) return '未探测'
  return probe.reachable ? `在线（${probe.detail}）` : `不可达（${probe.detail}）`
}

// 自我认知事实块：回答「你是什么系统」类问题的运行时事实源。
// 绑定/注册表/健康实况全部实时装配；deps 可注入便于测试。
export async function buildSelfAwarenessFacts({ binding, route, deps = {} } = {}) {
  const readBinding = deps.getProjectBinding || getProjectBinding
  const probeProject = deps.probeProject || probeProjectBinding
  const probeModel = deps.probeModel || defaultProbeModel
  const probeComfyUi = deps.probeComfyUi || defaultProbeComfyUi
  const readRegistry = deps.readEventRegistry || readEventRegistrySummary

  const projectBinding = readBinding()
  const registry = readRegistry()
  const [projectHealth, modelHealth, comfyHealth] = await Promise.all([
    projectBinding?.bound && projectBinding?.baseUrl
      ? Promise.resolve(probeProject(projectBinding.baseUrl)).catch((error) => ({ reachable: false, detail: error instanceof Error ? error.message : String(error) }))
      : Promise.resolve(null),
    Promise.resolve(probeModel(route)).catch((error) => ({ reachable: false, detail: error instanceof Error ? error.message : String(error) })),
    Promise.resolve(probeComfyUi(projectBinding)).catch((error) => ({ reachable: false, detail: error instanceof Error ? error.message : String(error) })),
  ])

  const lines = [
    '身份：本 agent 是 GameStudio control 平面的守护智能体（Hermes Manager，运行于 control 守护进程内），负责咨询解答、任务编排、模型路由、审核门禁、可观测执行与生命周期控制。',
    '角色边界：不绕过 control 直接替用户执行故事生产；生产动作由 control 事件机制驱动 GameStudio Server 执行，并受审核门约束。',
    '能力清单：可绑定第三方项目（项目绑定）；可读取说明文档与记忆文件（有界注入）；可查询项目事件映射（事件注册表）；可监控自身与各服务运行状态。',
    projectBinding?.bound
      ? `当前绑定项目：${projectBinding.label || projectBinding.id}（id=${projectBinding.id || 'unknown'}，baseUrl=${projectBinding.baseUrl}，绑定来源=${projectBinding.source || 'unknown'}）；服务健康：${formatProbe(projectHealth)}`
      : '当前绑定项目：未绑定。',
    registry
      ? `项目事件注册表：已注册 ${registry.count} 个事件（registryVersion=${registry.version || 'unknown'}，来源 apps/server/events/registry.v1.json）。`
      : '项目事件注册表：读取失败，无法确认事件计数。',
    `当前模型链路：provider=${binding?.provider || 'unknown'}，model=${binding?.model || 'unknown'}，baseUrl=${binding?.baseUrl || 'unknown'}，transport=${route?.transport || 'unknown'}；模型服务健康：${formatProbe(modelHealth)}`,
    `ComfyUI 出图服务（经绑定项目探测）：${formatProbe(comfyHealth)}`,
  ]
  return lines.join('\n')
}

// 装配探索证据源（顺序即处理顺序）：
//   1. 自我认知事实块；2. 记忆文件有界正文；3. 近期对话回放。
// deps 注入：buildProjectMemorySections / collectReplayableMessages 由调用方（modelRequests）提供，
// 避免本模块反向依赖 controlServerCore；probe 类 deps 便于单测。
export async function assembleExploreEvidenceSources({
  binding,
  route,
  userPrompt,
  history,
  sessionId,
  contextSelection = {},
  deps = {},
} = {}) {
  const sources = []

  const selfFacts = await buildSelfAwarenessFacts({ binding, route, deps })
  sources.push({ id: 'self-awareness', label: '自我认知事实', kind: 'self', content: selfFacts })

  const memorySections = typeof deps.buildProjectMemorySections === 'function'
    ? deps.buildProjectMemorySections(binding, userPrompt, contextSelection)
    : []
  for (const [index, section] of (Array.isArray(memorySections) ? memorySections : []).entries()) {
    const content = String(section?.content || '')
    if (!content.trim()) continue
    sources.push({
      id: `memory:${index}`,
      label: `记忆文件 ${section.label || index}`,
      kind: 'memory',
      content,
    })
  }

  const replayLimit = Math.max(0, Number(binding?.workflow?.reasoningReplayWindowMessages || 0))
  const replayed = typeof deps.collectReplayableMessages === 'function' && replayLimit > 0
    ? deps.collectReplayableMessages(history, { excludeRequestId: sessionId, limit: replayLimit, userPrompt })
    : []
  // 回放有界截取：单条 600 字符、总量 6000 字符，防止对话历史淹没探索预算。
  const replayLines = []
  let replayChars = 0
  for (const message of Array.isArray(replayed) ? replayed : []) {
    const role = message?.role === 'user' ? '用户' : '助手'
    const content = String(message?.content || '').trim().slice(0, 600)
    if (!content) continue
    if (replayChars + content.length > 6000) break
    replayChars += content.length
    replayLines.push(`[${role}] ${content}`)
  }
  if (replayLines.length > 0) {
    sources.push({ id: 'chat-replay', label: '近期对话回放', kind: 'history', content: replayLines.join('\n') })
  }

  return sources.filter((source) => String(source.content || '').trim())
}

function buildExtractMessages(userPrompt, chunk, chunkIndex, chunkTotal) {
  return [
    {
      role: 'system',
      content: [
        '你是 control 守护智能体的证据提取器。从给定证据块中只提取与问题直接相关的最小事实要点。',
        '规则：逐条列出事实（每条一行）；与问题无关的内容直接丢弃；证据块中没有的事实不得编造；',
        '若问题在问「能否/能不能/可以…吗/会不会/是什么/如何」，证据块中的身份、能力清单、绑定项目、事件映射与运行状态事实均算相关，必须提取；',
        '若问题在问「是什么系统/你是谁/能做什么」，身份、角色边界、能力清单每一行都必须原句提取，不得省略；',
        '其中描述「谁负责执行该事、走什么机制、有什么前提（如审核门）」的句子必须原句提取。',
        '历史对话回放里的旧回答不是事实，不得提取其结论本身；只可提取其中出现的新信息。',
        '若本块没有任何与问题相关的事实，只输出「（本块无相关事实）」。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `问题：${userPrompt}\n\n证据块 ${chunkIndex + 1}/${chunkTotal}（来源：${chunk.label}）：\n${chunk.text}`,
    },
  ]
}

function buildCompressMessages(userPrompt, notesText, notesCharLimit) {
  return [
    {
      role: 'system',
      content: [
        '你是中间结论压缩器。把已有中间结论合并去重，压缩到给定字符上限以内。',
        '规则：只保留与问题相关的事实要点；不得新增事实；不得丢失关键结论；直接输出压缩后的要点文本。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `问题：${userPrompt}\n\n字符上限：${notesCharLimit}\n\n已有中间结论：\n${notesText}`,
    },
  ]
}

function buildSynthesisMessages(userPrompt, notesText, correctionPrompt = '', priorAnswer = '') {
  return [
    {
      role: 'system',
      content: [
        '你是 GameStudio control 守护智能体（Hermes Manager）的回答合成器。证据已分块处理并压缩为下方「中间结论」。',
        '要求：必须直接回应用户问题本身（先给结论——能/不能、是/不是，再给依据）；',
        '只能使用中间结论里出现的事实，结论未覆盖的明确说明「当前证据不足」，不得编造；',
        '中间结论按来源标注；「近期对话回放」来源的旧回答只代表当时结论，不能作为事实依据，事实以身份/能力/运行状态来源为准；',
        '若问题在问「你是什么系统/你是谁/能做什么」，回答必须逐条覆盖中间结论中的能力清单、当前绑定项目与运行状态事实，不得只答一句身份；',
        '中文回答，简洁面向用户，不暴露分块/压缩等内部过程。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `用户问题：${userPrompt}`,
        '',
        '中间结论（压缩后的相关事实）：',
        notesText || '（本轮探索未提取到相关事实）',
        correctionPrompt ? `\n修正要求：${correctionPrompt}` : '',
        priorAnswer ? `\n上一轮回答（未通过切题自检，仅供对照，不得直接复述）：\n${priorAnswer.slice(0, 1200)}` : '',
      ].filter(Boolean).join('\n'),
    },
  ]
}

function buildRelevanceCheckMessages(userPrompt, reply) {
  return [
    {
      role: 'system',
      content: [
        '你是回答切题自检器。判断「回答」是否直接回应了「问题」本身（而不是答非所问、只复述材料、或转移话题）。',
        '只输出一个 JSON 对象：{"onTopic": true|false, "reason": "简短中文理由"}',
      ].join('\n'),
    },
    { role: 'user', content: `问题：${userPrompt}\n\n回答：\n${reply}` },
  ]
}

// 切题自检结果解析（宽松：提取首个 JSON 对象）；不可解析返回 null，由调用方 fail-open。
export function parseRelevanceCheckResult(rawText) {
  const raw = String(rawText || '').trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(extractJsonObjectString(raw))
    if (typeof parsed?.onTopic === 'boolean') {
      return { onTopic: parsed.onTopic, reason: String(parsed.reason || '').trim() }
    }
    return null
  } catch {
    return null
  }
}

function accumulateUsage(acc, usage) {
  if (!usage) return
  acc.calls += 1
  acc.promptTokens += Number(usage.prompt_tokens || usage.promptTokens || 0)
  acc.completionTokens += Number(usage.completion_tokens || usage.completionTokens || 0)
  acc.totalTokens += Number(usage.total_tokens || usage.totalTokens || 0)
}

function toUsagePayload(acc) {
  if (acc.calls <= 0) return null
  return {
    prompt_tokens: acc.promptTokens,
    completion_tokens: acc.completionTokens,
    total_tokens: acc.totalTokens,
  }
}

// 探索路径的失败统一打 exploreFailure 标记：上游据此显式失败，不落确定性兜底、不伪造回答。
function exploreError(stage, error) {
  const detail = error instanceof Error ? error.message : String(error)
  const wrapped = new Error(`explore_${stage}_failed:${detail}`)
  wrapped.exploreFailure = true
  wrapped.cause = error
  return wrapped
}

// 滚动压缩探索主流程。requestCompletion / appendEvent 可注入（单测不依赖真实模型与 session）。
export async function runExploreAnswer({
  sessionId = null,
  userPrompt,
  sources = [],
  binding = null,
  route = null,
  signal = null,
  correctionPrompt = '',
  requestCompletion = requestHermesChatCompletion,
  appendEvent = null,
  env = process.env,
  maxChunks = MAX_EXPLORE_CHUNKS,
} = {}) {
  const budgets = resolveExploreBudgets(env)
  const emit = (type, title, summary, extra = {}) => {
    if (typeof appendEvent === 'function') appendEvent(type, title, summary, extra)
  }
  const usageAcc = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  const callModel = async (phase, messages, { maxTokens, temperature } = {}) => {
    const data = await requestCompletion({
      sessionId,
      phase,
      messages,
      maxTokens,
      temperature,
      route,
      signal,
      timeoutMs: HERMES_CHAT_REQUEST_TIMEOUT_MS,
    })
    accumulateUsage(usageAcc, data?.usage)
    return String(data?.choices?.[0]?.message?.content || '').trim()
  }

  // 1) 证据源按预算分块；超出块数硬上限的剩余源显式丢弃并留痕
  const allChunks = (Array.isArray(sources) ? sources : []).flatMap((source) => splitSourceIntoChunks(source, budgets.chunkChars))
  const chunkLimit = Math.max(1, pickPositiveInt(maxChunks, MAX_EXPLORE_CHUNKS))
  const chunks = allChunks.slice(0, chunkLimit)
  const droppedChunkCount = allChunks.length - chunks.length
  emit('explore_started', '开始滚动压缩探索', `证据源 ${(sources || []).length} 个，分块 ${chunks.length} 块${droppedChunkCount > 0 ? `，超出块上限丢弃 ${droppedChunkCount} 块` : ''}；预算 context=${budgets.contextBudget} chunk=${budgets.chunkChars} notes=${budgets.notesCharLimit}`, {
    data: { sourceCount: (sources || []).length, chunkCount: chunks.length, droppedChunkCount, budgets },
  })

  // 2) 逐块提取「与问题相关的最小事实」进 notes；3) 水位超阈值即压缩 notes，已处理原文即弃
  let notesText = ''
  let compressions = 0
  for (const [index, chunk] of chunks.entries()) {
    let note = ''
    try {
      note = await callModel('reasoning_explore_extract', buildExtractMessages(userPrompt, chunk, index, chunks.length), { maxTokens: 900, temperature: 0.1 })
    } catch (error) {
      emit('explore_chunk_failed', `探索失败：处理证据 ${index + 1}/${chunks.length}`, error instanceof Error ? error.message : String(error))
      throw exploreError('extract', error)
    }
    const trimmedNote = String(note || '').trim()
    if (trimmedNote && !NO_RELATED_FACT_PATTERN.test(trimmedNote)) {
      // 按来源标注进 notes：综合阶段可据此区分「运行时事实」与「历史旧回答」
      const labelledNote = `[来源：${chunk.label}]\n${trimmedNote}`
      notesText = notesText ? `${notesText}\n${labelledNote}` : labelledNote
    }
    emit('explore_chunk', `探索中：处理证据 ${index + 1}/${chunks.length}`, `来源「${chunk.label}」：提取 ${NO_RELATED_FACT_PATTERN.test(trimmedNote) ? 0 : trimmedNote.length} 字符相关事实；当前 notes ${notesText.length} 字符`, {
      data: { chunkIndex: index, chunkTotal: chunks.length, sourceId: chunk.sourceId, label: chunk.label, notesChars: notesText.length },
    })

    if (notesText.length > budgets.notesCharLimit) {
      let compressed = ''
      try {
        compressed = await callModel('reasoning_explore_compress', buildCompressMessages(userPrompt, notesText, budgets.notesCharLimit), { maxTokens: 1200, temperature: 0.1 })
      } catch (error) {
        emit('explore_compress_failed', '探索失败：压缩中间结论', error instanceof Error ? error.message : String(error))
        throw exploreError('compress', error)
      }
      const beforeChars = notesText.length
      if (compressed) notesText = compressed
      // 压缩仍超硬上限（2 倍水位）时确定性截尾并标注，保证「只装压缩结论」契约不被模型违反
      const hardCap = budgets.notesCharLimit * 2
      if (notesText.length > hardCap) {
        notesText = `${notesText.slice(0, hardCap)}\n[超出压缩上限已截尾]`
      }
      compressions += 1
      emit('explore_compress', '探索中：压缩中间结论', `notes 从 ${beforeChars} 字符压缩到 ${notesText.length} 字符`, {
        data: { beforeChars, afterChars: notesText.length, compressions },
      })
    }
  }

  // 4) 全部处理完后用压缩 notes 综合最终回答（必须直接回应问题本身）
  emit('explore_synthesis', '探索中：综合最终回答', `共处理 ${chunks.length} 块证据、压缩 ${compressions} 次；notes ${notesText.length} 字符`)
  let synthesisMessages = buildSynthesisMessages(userPrompt, notesText, correctionPrompt)
  let reply = ''
  try {
    reply = await callModel('reasoning_explore_synthesize', synthesisMessages, { maxTokens: 2048, temperature: 0.2 })
  } catch (error) {
    throw exploreError('synthesize', error)
  }
  if (!reply) {
    throw exploreError('synthesize', new Error('empty_reply'))
  }

  // 5) 切题自检：不切题带修正重答一次；自检通道本身失败按切题放行（fail-open）并显式留痕
  let relevance = null
  let relevanceRetried = false
  try {
    const checkRaw = await callModel('reasoning_explore_check', buildRelevanceCheckMessages(userPrompt, reply), { maxTokens: 200, temperature: 0 })
    relevance = parseRelevanceCheckResult(checkRaw)
    if (!relevance) {
      emit('explore_relevance_check', '切题自检', '自检结果不可解析，按切题处理（fail-open）')
    }
  } catch (error) {
    emit('explore_relevance_check', '切题自检', `自检调用失败（${error instanceof Error ? error.message : String(error)}），按切题处理（fail-open）`)
  }
  if (relevance && relevance.onTopic === false) {
    relevanceRetried = true
    emit('explore_relevance_retry', '切题自检未通过，带修正重答一次', relevance.reason || '回答未直接回应问题')
    const retryCorrection = [
      correctionPrompt,
      `上一轮回答未直接回应问题（${relevance.reason || '答非所问'}）。必须直接回应问题本身：先给结论，再给依据。`,
    ].filter(Boolean).join('\n')
    synthesisMessages = buildSynthesisMessages(userPrompt, notesText, retryCorrection, reply)
    let retryReply = ''
    try {
      retryReply = await callModel('reasoning_explore_synthesize', synthesisMessages, { maxTokens: 2048, temperature: 0.2 })
    } catch (error) {
      throw exploreError('synthesize_retry', error)
    }
    if (retryReply) reply = retryReply
  }
  emit('explore_completed', '探索完成', `最终回答 ${reply.length} 字符；模型调用 ${usageAcc.calls} 次`, {
    data: { replyChars: reply.length, modelCalls: usageAcc.calls, compressions, relevanceRetried },
  })

  return {
    reply,
    usage: toUsagePayload(usageAcc),
    notes: notesText,
    synthesisMessages,
    stats: {
      sourceCount: (sources || []).length,
      chunkCount: chunks.length,
      droppedChunkCount,
      compressions,
      modelCalls: usageAcc.calls,
      relevanceChecked: Boolean(relevance),
      relevanceRetried,
      notesChars: notesText.length,
      budgets,
    },
  }
}
