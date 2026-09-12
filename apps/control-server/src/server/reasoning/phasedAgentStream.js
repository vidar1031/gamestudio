// 分阶段 agent stream（工具调用结果外置 + 最小上下文）。
// 核心思路：
// - 阶段 1：模型决定调用哪些工具（小上下文）
// - 阶段 2：守护台直接执行工具调用，结果存外部文件
// - 阶段 3：把工具结果压缩为摘要
// - 阶段 4：模型基于摘要生成回答（小上下文）
//
// 这样模型永远只看到极小的上下文，27B 模型永远不会因为内存不足而失败。

import fs from 'node:fs'
import path from 'node:path'
import { GAMESTUDIO_ROOT } from '../../config/paths.js'

const TOOL_RESULTS_DIR = path.join(GAMESTUDIO_ROOT, 'state', 'tool-results')

function ensureToolResultsDir() {
  fs.mkdirSync(TOOL_RESULTS_DIR, { recursive: true })
}

function saveToolResult(sessionId, toolCallId, tool, result) {
  ensureToolResultsDir()
  const file = path.join(TOOL_RESULTS_DIR, `${sessionId}_${toolCallId}.json`)
  const data = {
    sessionId,
    toolCallId,
    tool,
    result,
    savedAt: new Date().toISOString()
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  return file
}

// ============ 咨询只读工具：由 control 确定性执行，不交给 gateway 模型侧 ============
// 设计理由（2026-08-25）：gateway api_server 为省 prefill 内存只保留 memory+session_search
// 两个 toolset；恢复 file toolset 会连带 write_file/patch 写能力、绕过审核门禁。
// 因此咨询查证由 control 在工作区内只读执行，write/exec 类永不提供。

const CONSULT_READONLY_TOOLS = new Set(['read_file', 'search_files', 'list_directory'])
const CONSULT_TOOL_MAX_CALLS = 3
const READ_FILE_CHAR_LIMIT = 24000
const LIST_DIR_ENTRY_LIMIT = 200
const SEARCH_MATCH_LIMIT = 20
const SEARCH_VISIT_FILE_LIMIT = 5000
const SEARCH_FILE_CHAR_LIMIT = 200 * 1024
// storage 不跳过（2026-09-06 调整）：项目真相源在 storage/projects，咨询查证必须能检索项目文件；
// 大文件/访问量由 SEARCH_FILE_CHAR_LIMIT 与 SEARCH_VISIT_FILE_LIMIT 封顶，图片等非文本读取失败会跳过。
const SEARCH_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.tmp', '.run', 'state'])

function resolveWorkspaceReadPath(targetPath) {
  const rel = String(targetPath || '').trim().replace(/^\/+/, '')
  if (!rel) return null
  const abs = path.resolve(GAMESTUDIO_ROOT, rel)
  if (abs !== GAMESTUDIO_ROOT && !abs.startsWith(GAMESTUDIO_ROOT + path.sep)) return null
  return abs
}

function executeReadonlyConsultTool(tool, args = {}) {
  if (!CONSULT_READONLY_TOOLS.has(tool)) {
    throw new Error(`tool_not_allowed:${tool}`)
  }
  if (tool === 'read_file') {
    const abs = resolveWorkspaceReadPath(args.path)
    if (!abs) throw new Error('path_out_of_workspace')
    const stat = fs.statSync(abs) // 不存在/不可读会抛错，由调用方收敛为失败结果
    if (!stat.isFile()) throw new Error('not_a_file')
    const raw = fs.readFileSync(abs, 'utf8')
    return {
      path: path.relative(GAMESTUDIO_ROOT, abs),
      sizeBytes: stat.size,
      content: raw.length > READ_FILE_CHAR_LIMIT ? `${raw.slice(0, READ_FILE_CHAR_LIMIT)}…（超出 ${READ_FILE_CHAR_LIMIT} 字符截断）` : raw,
      truncated: raw.length > READ_FILE_CHAR_LIMIT
    }
  }
  if (tool === 'list_directory') {
    const abs = resolveWorkspaceReadPath(args.path || '.')
    if (!abs) throw new Error('path_out_of_workspace')
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .slice(0, LIST_DIR_ENTRY_LIMIT)
      .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'dir' : 'file' }))
    return { path: path.relative(GAMESTUDIO_ROOT, abs) || '.', count: entries.length, entries }
  }
  // search_files：工作区内全文检索（查询按空白拆词、命中任一词即算，限量封顶）
  const query = String(args.query || args.q || '').trim()
  if (!query) throw new Error('query_required')
  const queryTerms = query.split(/\s+/).filter(Boolean)
  const baseAbs = resolveWorkspaceReadPath(args.path || '.')
  if (!baseAbs) throw new Error('path_out_of_workspace')
  const matches = []
  let visited = 0
  const walk = (dir) => {
    if (matches.length >= SEARCH_MATCH_LIMIT || visited >= SEARCH_VISIT_FILE_LIMIT) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (matches.length >= SEARCH_MATCH_LIMIT || visited >= SEARCH_VISIT_FILE_LIMIT) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SEARCH_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(full)
        continue
      }
      visited += 1
      try {
        const stat = fs.statSync(full)
        if (stat.size > SEARCH_FILE_CHAR_LIMIT) continue
        const content = fs.readFileSync(full, 'utf8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i += 1) {
          if (queryTerms.some((term) => lines[i].includes(term))) {
            matches.push({ file: path.relative(GAMESTUDIO_ROOT, full), line: i + 1, preview: lines[i].trim().slice(0, 160) })
            break
          }
        }
      } catch { /* 单文件不可读跳过 */ }
    }
  }
  walk(baseAbs)
  return { query, base: path.relative(GAMESTUDIO_ROOT, baseAbs) || '.', matchCount: matches.length, matches }
}

// 防御性清理：回答阶段模型偶尔仍把 tool_calls JSON 带进最终回答，剥掉残留；
// 剥完为空则交给调用方显式失败（不伪造回答）
function stripToolCallArtifacts(text) {
  let value = String(text || '')
  const jsonMarker = value.search(/["']?tool_calls["']?\s*:/)
  if (jsonMarker >= 0) {
    const braceIdx = value.lastIndexOf('{', jsonMarker)
    value = value.slice(0, braceIdx >= 0 ? braceIdx : jsonMarker)
  }
  // hermes 原生 XML 工具标记（<tool_call>/<function=...>）同样剥离：咨询路径没有 shell/终端工具
  const xmlIdx = value.search(/<\/?tool_call|<\/?function[=>]/i)
  if (xmlIdx >= 0) value = value.slice(0, xmlIdx)
  return value.trim()
}

// 从模型的规划文本中提取工具调用 JSON（容错：截断 JSON 尝试补闭合括号修复；
// 找不到合法 JSON 或合法工具则返回空，走直接回答）
function parseConsultToolCalls(content) {
  const text = String(content || '')
  const candidates = []
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1))
  const firstBracket = text.indexOf('[')
  const lastBracket = text.lastIndexOf(']')
  if (firstBracket >= 0 && lastBracket > firstBracket) candidates.push(text.slice(firstBracket, lastBracket + 1))
  // 本地模型输出常以截断的 JSON 收尾：按序尝试补闭合
  const repairSuffixes = ['', '}', ']', ']}', '}}', '"}', '"}]', '"}]}', '}}]', ']}"}', ']"}}']
  for (const candidate of candidates) {
    for (const suffix of repairSuffixes) {
      try {
        const parsed = JSON.parse(candidate + suffix)
        const rawCalls = Array.isArray(parsed)
          ? parsed
          : (Array.isArray(parsed?.tool_calls) ? parsed.tool_calls : (parsed?.tool ? [parsed] : []))
        const valid = rawCalls
          .filter((call) => call && typeof call === 'object' && CONSULT_READONLY_TOOLS.has(String(call.tool || '')))
          .map((call) => ({ tool: String(call.tool), args: call.args && typeof call.args === 'object' ? call.args : {} }))
        if (valid.length > 0) return valid
      } catch {
        // 尝试下一个修复后缀/候选片段
      }
    }
  }
  return []
}

/**
 * 阶段 1：模型决定调用哪些工具。
 * 使用极小的上下文，只包含系统提示和用户问题。
 */
export async function planToolCalls({ prompt, systemPrompt, hermesApiBaseUrl, hermesApiKey, fetchImpl = fetch, sessionId }) {
  const apiOrigin = String(hermesApiBaseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60000)

  try {
    // 使用 hermes 的会话流端点，而不是 chat/completions
    const response = await fetchImpl(`${apiOrigin}/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(hermesApiKey ? { Authorization: `Bearer ${hermesApiKey}` } : {})
      },
      body: JSON.stringify({
        message: `${prompt}\n\n请决定是否需要调用只读工具查证后再回答。可用工具（由 control 在工作区内代为执行，只读，直接输出 JSON 即可调用）：\n- read_file {"path":"相对工作区路径"}：读取文件内容\n- list_directory {"path":"目录"}：列出目录内容\n- search_files {"query":"关键词","path":"可选子目录"}：全文搜索\n当问题涉及具体文件、目录、代码、文档或项目事实时，必须先调用工具查证，不得凭记忆回答。\n承接上文指代（它/该/这个/刚才那个）时，先结合系统提示里的项目库实况与近期对话摘要解析出完整目标路径再查证。\n问题问"具体内容/内容是什么/里面有什么"时，必须先 read_file 或 list_directory 查证，禁止直接回答无法读取——这些工具本轮可用。\n不存在 shell/终端/代码执行/写文件工具，禁止输出 <tool_call> 等 XML 工具标记；需要写操作或生产动作时，在回答里说明并建议走 control 生产工作流。\n如果需要查证，只输出 JSON：{"tool_calls":[{"tool":"...","args":{...}}]}，不要输出任何其他内容；如果不需要查证，直接回答用户问题。`,
        system_message: systemPrompt
      }),
      signal: controller.signal
    })
    clearTimeout(timeout)

    if (!response.ok) {
      throw new Error(`hermes_plan_http_${response.status}`)
    }

    // 读取 SSE 流，收集最终回答
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf8')
    let finalAnswer = ''
    let buffer = ''
    let streamError = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // 解析 SSE 事件
      const events = buffer.split('\n\n')
      buffer = events.pop() || ''
      for (const event of events) {
        const lines = event.split('\n')
        let eventName = ''
        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim()
            continue
          }
          if (line.startsWith('data:')) {
            try {
              const data = JSON.parse(line.slice(5).trim())
              const eventType = String(data?.type || eventName || '')
              // gateway 会话流真实 schema（与 agentStreamBridge 对齐）：
              // assistant.delta(delta) 增量、assistant.completed(content) 权威全文、error(message) 失败
              if (eventType === 'assistant.completed' && typeof data?.content === 'string' && data.content.trim()) {
                finalAnswer = data.content
              } else if (eventType === 'assistant.delta' && data?.delta) {
                finalAnswer += data.delta
              } else if (eventType === 'final' && data?.answer) {
                finalAnswer = data.answer
              } else if (eventType === 'answer_delta' && data?.delta) {
                finalAnswer += data.delta
              } else if (eventType === 'error') {
                streamError = String(data?.message || data?.error || 'hermes_stream_error')
              }
            } catch {
              // 忽略解析错误
            }
          }
        }
      }
    }

    // 8K 基准稳定性纪律：gateway 流内错误或空回答必须显式失败，禁止静默吞成"完成"
    if (streamError) return { ok: false, error: streamError, content: finalAnswer }
    if (!String(finalAnswer || '').trim()) return { ok: false, error: 'hermes_empty_answer', content: '' }
    return { ok: true, content: finalAnswer, usage: null }
  } catch (error) {
    clearTimeout(timeout)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 阶段 2：守护台直接执行工具调用，结果存外部文件。
 */
export async function executeToolCalls({ sessionId, toolCalls, appendEvidence = () => {} }) {
  const results = []
  for (const toolCall of toolCalls.slice(0, CONSULT_TOOL_MAX_CALLS)) {
    const { tool, args } = toolCall
    const toolCallId = `tool_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`

    try {
      // control 在工作区内真实执行只读查证（替代原模拟实现）
      const result = executeReadonlyConsultTool(tool, args)
      const file = saveToolResult(sessionId, toolCallId, tool, result)
      results.push({ toolCallId, tool, args, result, file, ok: true })
      appendEvidence('agent_stream_tool', `只读查证：${tool}`, summarizeConsultToolResult(tool, result), {
        data: { tool, args, resultFile: path.relative(GAMESTUDIO_ROOT, file) }
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      results.push({ toolCallId, tool, args, error: detail, ok: false })
      appendEvidence('agent_stream_tool', `只读查证失败：${tool}`, detail, { data: { tool, args } })
    }
  }
  return results
}

function summarizeConsultToolResult(tool, result) {
  if (tool === 'list_directory') return `目录 ${result.path} 共 ${result.count} 项`
  if (tool === 'read_file') return `读取 ${result.path}（${result.sizeBytes} 字节${result.truncated ? '，超长已截断' : ''}）`
  if (tool === 'search_files') return `检索命中 ${result.matchCount} 处`
  return '已执行'
}

/**
 * 阶段 3：把工具结果压缩为摘要（每条上限 1500 字符、总量 4000 字符封顶，完整结果在 state/tool-results/）。
 */
export function compressToolResults(results) {
  const blocks = results.map((r) => {
    if (!r.ok) return `【${r.tool}】执行失败：${r.error || 'unknown'}`
    const body = typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 1)
    const clipped = body.length > 1500 ? `${body.slice(0, 1500)}…（完整结果已存外部存储）` : body
    return `【${r.tool} ${JSON.stringify(r.args || {})}】\n${clipped}`
  })
  const joined = blocks.join('\n\n')
  return joined.length > 4000 ? `${joined.slice(0, 4000)}\n…（证据摘要超限截断，完整结果见 state/tool-results/）` : joined
}

/**
 * 阶段 4：模型基于摘要生成回答。
 */
export async function generateAnswer({ prompt, systemPrompt, toolSummary, hermesApiBaseUrl, hermesApiKey, fetchImpl = fetch, sessionId }) {
  const apiOrigin = String(hermesApiBaseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120000)

  try {
    const response = await fetchImpl(`${apiOrigin}/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(hermesApiKey ? { Authorization: `Bearer ${hermesApiKey}` } : {})
      },
      body: JSON.stringify({
        message: `${prompt}\n\n已收集的证据摘要：\n${toolSummary}\n\n请基于以上证据直接生成最终回答。规则：禁止输出任何 tool_calls 或 JSON 工具调用内容；证据不足就如实说明缺什么，不要编造；回答用中文、结论先行。`,
        system_message: systemPrompt
      }),
      signal: controller.signal
    })
    clearTimeout(timeout)

    if (!response.ok) {
      throw new Error(`hermes_answer_http_${response.status}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf8')
    let finalAnswer = ''
    let buffer = ''
    let streamError = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split('\n\n')
      buffer = events.pop() || ''
      for (const event of events) {
        const lines = event.split('\n')
        let eventName = ''
        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim()
            continue
          }
          if (line.startsWith('data:')) {
            try {
              const data = JSON.parse(line.slice(5).trim())
              const eventType = String(data?.type || eventName || '')
              // gateway 会话流真实 schema（与 agentStreamBridge 对齐）：
              // assistant.delta(delta) 增量、assistant.completed(content) 权威全文、error(message) 失败
              if (eventType === 'assistant.completed' && typeof data?.content === 'string' && data.content.trim()) {
                finalAnswer = data.content
              } else if (eventType === 'assistant.delta' && data?.delta) {
                finalAnswer += data.delta
              } else if (eventType === 'final' && data?.answer) {
                finalAnswer = data.answer
              } else if (eventType === 'answer_delta' && data?.delta) {
                finalAnswer += data.delta
              } else if (eventType === 'error') {
                streamError = String(data?.message || data?.error || 'hermes_stream_error')
              }
            } catch {
              // 忽略解析错误
            }
          }
        }
      }
    }

    // 8K 基准稳定性纪律：gateway 流内错误或空回答必须显式失败，禁止静默吞成"完成"
    if (streamError) return { ok: false, error: streamError, content: finalAnswer }
    if (!String(finalAnswer || '').trim()) return { ok: false, error: 'hermes_empty_answer', content: '' }
    return { ok: true, content: finalAnswer, usage: null }
  } catch (error) {
    clearTimeout(timeout)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 执行分阶段 agent stream。
 */
export async function runPhasedAgentStream({
  prompt,
  agentId,
  hermesApiBaseUrl,
  hermesApiKey = '',
  fetchImpl = fetch,
  onStreamEvent = () => {},
  appendEvidence = () => {},
  isAborted = () => false,
  log = () => {},
  systemPrompt = null
}) {
  const sessionId = `phased_${agentId}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
  const titleSuffix = Math.random().toString(16).slice(2, 6)
  
  // 先创建 hermes 会话
  const apiOrigin = String(hermesApiBaseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '')
  const headers = { 'Content-Type': 'application/json', ...(hermesApiKey ? { Authorization: `Bearer ${hermesApiKey}` } : {}) }
  try {
    await fetchImpl(`${apiOrigin}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: sessionId, title: `分阶段咨询流（${agentId}）#${titleSuffix}` })
    })
  } catch {
    // 会话创建失败不阻断
  }
  
  // 阶段 1：规划工具调用
  onStreamEvent({ type: 'phase', phase: 'planning', message: '正在规划工具调用...' })
  const planResult = await planToolCalls({
    prompt,
    systemPrompt: systemPrompt || '你是 GameStudio 守护台的咨询答疑 agent。',
    hermesApiBaseUrl,
    hermesApiKey,
    fetchImpl,
    sessionId
  })
  
  if (!planResult.ok) {
    return { ok: false, error: planResult.error, finalAnswer: '' }
  }
  
  // 解析规划输出中的只读工具调用；无合法调用则把规划文本当作直接回答
  const toolCalls = parseConsultToolCalls(planResult.content)
  appendEvidence('agent_stream_plan', '规划阶段完成', toolCalls.length > 0
    ? `模型请求查证：${toolCalls.map((c) => c.tool).join('、')}`
    : '模型未请求工具，直接回答', {
    data: { toolCalls, planPreview: String(planResult.content || '').slice(0, 300) }
  })
  if (toolCalls.length > 0) {
    onStreamEvent({ type: 'phase', phase: 'executing', message: `正在查证（${toolCalls.map((c) => c.tool).join('、')}）...` })
    const toolResults = await executeToolCalls({ sessionId, toolCalls, appendEvidence })

    // 阶段 3：压缩工具结果
    onStreamEvent({ type: 'phase', phase: 'compressing', message: '正在压缩证据...' })
    const toolSummary = compressToolResults(toolResults)

    // 阶段 4：生成回答
    onStreamEvent({ type: 'phase', phase: 'answering', message: '正在生成回答...' })
    const answerResult = await generateAnswer({
      prompt,
      systemPrompt: systemPrompt || '你是 GameStudio 守护台的咨询答疑 agent。',
      toolSummary,
      hermesApiBaseUrl,
      hermesApiKey,
      fetchImpl,
      sessionId
    })
    if (!answerResult.ok) {
      return { ok: false, error: answerResult.error, finalAnswer: '' }
    }
    // 回答阶段仍输出 tool_calls JSON 的防御性剥离；剥完为空则显式失败
    const cleanedAnswer = stripToolCallArtifacts(answerResult.content)
    if (!cleanedAnswer) {
      appendEvidence('agent_stream_answer_artifact', '回答内容异常', '回答阶段仅输出了工具调用 JSON，已显式失败（未伪造回答）。')
      return { ok: false, error: 'answer_tool_artifact_only', finalAnswer: '' }
    }
    return {
      ok: true,
      finalAnswer: cleanedAnswer,
      usage: answerResult.usage,
      phases: ['planning', 'executing', 'compressing', 'answering']
    }
  }

  // 模型疑似想调用工具但 JSON 不可解析：显式失败，不把原始 JSON 当回答塞给用户
  if (/"?tool_calls"?/.test(planResult.content)) {
    appendEvidence('agent_stream_plan_unparseable', '工具规划解析失败', '模型输出了工具调用意图但 JSON 不完整，已显式失败（未把原始 JSON 当回答）。', {
      data: { planPreview: String(planResult.content || '').slice(0, 300) }
    })
    return { ok: false, error: 'tool_plan_unparseable', finalAnswer: '' }
  }

  onStreamEvent({ type: 'phase', phase: 'answering', message: '直接生成回答...' })
  return {
    ok: true,
    finalAnswer: planResult.content,
    usage: planResult.usage,
    phases: ['planning', 'answering']
  }
}
