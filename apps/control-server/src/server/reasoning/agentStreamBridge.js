/**
 * agent 流式咨询桥（chat agent-stream）。
 *
 * 背景：守护台咨询/问答类（answer_only）聊天从「固定计划链」改为「agent 边想边做边展示」。
 * 本模块负责：
 * 1. 复用/创建 hermes 网关会话，调用 POST /api/sessions/{id}/chat/stream 消费 SSE 事件；
 * 2. 只读工具白名单硬边界（v1）：tool.started 一旦出现白名单外工具，立即断开上游
 *    （网关侧 SSE 断开会 cancel agent 任务），并由路由层把 session 收敛为 blocked；
 * 3. 把上游事件翻译为面向 console 的归一化流事件（thinking/action/action_result/answer_delta/...），
 *    同时把关键证据经 appendEvidence 落进 reasoning session 事件流（治理证据不断）。
 *
 * 可测试性：fetch / 存储 / 证据回调全部注入，纯函数部分（白名单、人话摘要、SSE 解析、步骤聚合）单独导出。
 */
import fs from 'node:fs'
import path from 'node:path'

import { GAMESTUDIO_ROOT } from '../../config/paths.js'

// 咨询聊天允许的工具白名单（只读集）：查文件/查会话/查技能/联网检索。
// memory 工具只有 add/replace/remove（全为写），不在白名单内；
// execute_code/terminal/process/write_file/patch/skill_manage 等副作用工具一律默认拒绝。
export const AGENT_STREAM_READONLY_TOOLS = new Set([
  'read_file',
  'search_files',
  'session_search',
  'skill_view',
  'skills_list',
  'web_search',
  'web_extract'
])

const DEFAULT_STATE_DIR = path.join(GAMESTUDIO_ROOT, 'state', 'agent-stream-bridge')
const THINKING_PREVIEW_LIMIT = 600
const TARGET_PREVIEW_LIMIT = 160
// 会话取消感知节流：只在事件间隔中低频读 session 文件，避免 token 级 delta 触发频繁 IO
const CANCEL_CHECK_INTERVAL_MS = 1500

// 咨询只读模式的系统提示（随请求 ephemeral 注入；hermes 核心系统提示仍加载 GameStudio 契约文件）
// 通过 buildAgentStreamSystemPrompt 动态拼接当前项目能力摘要，避免 agent 依赖大段通用上下文猜测。
export function buildAgentStreamSystemPrompt(capabilitySummary = null) {
  const lines = [
    '你是 GameStudio 守护台的咨询答疑 agent，正在回答用户关于 GameStudio / control / 项目事实的问题。',
    '',
    '硬性约束（咨询只读模式）：',
    '1. 你只能使用只读工具查证：read_file、search_files、session_search、skill_view、skills_list、web_search、web_extract。',
    '2. 禁止调用任何有副作用的工具（execute_code、terminal、process、write_file、patch、memory、skill_manage 等）。一旦发起越权工具调用，control 会立即中断本次回答并记录证据。',
    '3. 如果用户需求需要写文件 / 执行命令 / 触发故事生产，不要自己动手，在回答里说明这需要走 control 生产工作流，并给出建议操作。',
    '4. 默认中文回答；先查证再下结论，不编造未观测到的事实；回答简洁、关键结论先行。'
  ]

  if (capabilitySummary && capabilitySummary.available === true) {
    const binding = capabilitySummary.binding || {}
    const runtime = capabilitySummary.runtimeDescriptor || {}
    const caps = Array.isArray(capabilitySummary.capabilities) ? capabilitySummary.capabilities : []
    const readCount = caps.filter((item) => item.type === 'read').length
    const writeCount = caps.filter((item) => item.type === 'write').length
    const reviewCount = caps.filter((item) => item.requiresReview).length
    lines.push('')
    lines.push('当前绑定项目事实（可直接引用，无需再查证）：')
    lines.push(`- 项目名称：${binding.label || runtime.displayName || '未命名'}`)
    lines.push(`- 项目 ID：${binding.id || runtime.projectId || 'unknown'}`)
    lines.push(`- 服务地址：${binding.baseUrl || 'unknown'}`)
    lines.push(`- 仓库路径：${binding.repoPath || runtime.rootDir || 'unknown'}`)
    lines.push(`- 能力总数：${caps.length}（只读 ${readCount} / 写入 ${writeCount} / 需人工审核 ${reviewCount}）`)
    if (caps.length) {
      lines.push('- 能力清单：')
      for (const cap of caps.slice(0, 20)) {
        const reviewMark = cap.requiresReview ? '（需审核）' : ''
        lines.push(`  - ${cap.id}: ${cap.label || cap.id} [${cap.type}]${reviewMark}`)
      }
      if (caps.length > 20) {
        lines.push(`  - … 其余 ${caps.length - 20} 项略`)
      }
    }
  }

  return lines.join('\n')
}

export function truncateAgentStreamText(text, limit = THINKING_PREVIEW_LIMIT) {
  const value = String(text || '')
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…`
}

/**
 * 只读白名单判定（默认拒绝）。
 */
export function isAgentStreamToolAllowed(toolName) {
  return AGENT_STREAM_READONLY_TOOLS.has(String(toolName || '').trim())
}

function pickFirstString(...values) {
  for (const value of values) {
    const text = String(value || '').trim()
    if (text) return text
  }
  return ''
}

/**
 * 工具调用的人话摘要：动作名 + 目标。禁止把原始 args JSON 直接铺到 UI。
 */
export function describeAgentStreamToolCall(toolName, args, preview) {
  const tool = String(toolName || '').trim()
  const safeArgs = args && typeof args === 'object' ? args : {}
  const previewText = truncateAgentStreamText(pickFirstString(preview), TARGET_PREVIEW_LIMIT)
  let actionLabel = '调用工具'
  let target = previewText
  switch (tool) {
    case 'read_file':
      actionLabel = '读取文件'
      target = pickFirstString(safeArgs.path, previewText)
      break
    case 'search_files':
      actionLabel = '搜索文件'
      target = pickFirstString(safeArgs.pattern, safeArgs.query, previewText)
      break
    case 'session_search':
      actionLabel = '检索历史会话'
      target = pickFirstString(safeArgs.query, previewText)
      break
    case 'skill_view':
      actionLabel = '查看技能'
      target = pickFirstString(safeArgs.name, safeArgs.skill, safeArgs.skill_name, previewText)
      break
    case 'skills_list':
      actionLabel = '列出可用技能'
      target = target || '技能目录'
      break
    case 'web_search':
      actionLabel = '联网搜索'
      target = pickFirstString(safeArgs.query, previewText)
      break
    case 'web_extract':
      actionLabel = '读取网页'
      target = pickFirstString(safeArgs.url, previewText)
      break
    default:
      actionLabel = `调用工具 ${tool || 'unknown'}`
      break
  }
  return { tool, actionLabel, target: truncateAgentStreamText(target, TARGET_PREVIEW_LIMIT) }
}

/**
 * 增量 SSE 解析器：feed(文本块) → 返回完整事件数组 [{ event, data }]。
 * 兼容 `: keepalive` 注释、跨块 data、多行 data 拼接。
 */
export function createAgentStreamSseParser() {
  let buffer = ''
  function parseBlock(block) {
    let event = 'message'
    const dataLines = []
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
      }
    }
    if (!dataLines.length) return null
    const raw = dataLines.join('\n')
    let data = null
    try {
      data = JSON.parse(raw)
    } catch {
      data = { raw }
    }
    return { event, data }
  }
  return {
    feed(chunk) {
      buffer += String(chunk || '')
      const events = []
      let index = buffer.indexOf('\n\n')
      while (index >= 0) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const parsed = parseBlock(block.replace(/\r/g, ''))
        if (parsed) events.push(parsed)
        index = buffer.indexOf('\n\n')
      }
      return events
    },
    flush() {
      const rest = buffer.trim() ? parseBlock(buffer.replace(/\r/g, '')) : null
      buffer = ''
      return rest ? [rest] : []
    }
  }
}

/**
 * 步骤聚合器：把上游归一化事件组装为「STEP N：思考 → 动作 → 结果」的 console 事件。
 * 规则（与实证事件序列对齐）：
 * - 思考块到达时，若当前步骤已有动作 → 开启新步骤；否则思考归入当前步骤；
 * - 工具开始时若无当前步骤 → 开启新步骤；
 * - 工具完成/失败按后进先出匹配未完结动作。
 */
export function createAgentStreamStepAssembler() {
  let stepIndex = 0
  let currentHasActions = false
  let currentOpened = false
  const pendingActions = []

  return {
    thinking(text) {
      const value = String(text || '').trim()
      if (!value) return null
      if (!currentOpened || currentHasActions) {
        stepIndex += 1
        currentOpened = true
        currentHasActions = false
      }
      return { type: 'thinking', stepIndex, text: value }
    },
    toolStarted(tool, meta) {
      if (!currentOpened) {
        stepIndex += 1
        currentOpened = true
        currentHasActions = false
      }
      currentHasActions = true
      const actionId = `act_${stepIndex}_${pendingActions.length + 1}`
      pendingActions.push({ actionId, tool, stepIndex })
      return { type: 'action', stepIndex, actionId, tool, ...meta }
    },
    toolFinished(tool, ok, error) {
      // 优先匹配最近一个同名未完结动作；取不到则匹配最近任意未完结动作
      let index = -1
      for (let i = pendingActions.length - 1; i >= 0; i -= 1) {
        if (pendingActions[i].tool === tool) { index = i; break }
      }
      if (index < 0 && pendingActions.length) index = pendingActions.length - 1
      const action = index >= 0 ? pendingActions.splice(index, 1)[0] : null
      return {
        type: 'action_result',
        stepIndex: action?.stepIndex || stepIndex,
        actionId: action?.actionId || null,
        tool,
        ok: Boolean(ok),
        ...(error ? { error: String(error) } : {})
      }
    }
  }
}

function readMappingFile(stateDir, agentId) {
  try {
    const filePath = path.join(stateDir, `${agentId}.json`)
    if (!fs.existsSync(filePath)) return null
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const sessionId = String(parsed?.hermesSessionId || '').trim()
    return sessionId || null
  } catch {
    return null
  }
}

function writeMappingFile(stateDir, agentId, hermesSessionId) {
  fs.mkdirSync(stateDir, { recursive: true })
  const filePath = path.join(stateDir, `${agentId}.json`)
  fs.writeFileSync(filePath, JSON.stringify({ agentId, hermesSessionId, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
}

/**
 * 确保咨询桥使用的 hermes 会话存在。
 * 注意：agent 流式咨询每次强制创建新会话，避免旧会话历史消息累积导致本地模型上下文超限。
 * 失效（404）时重建并更新映射。
 */
export async function ensureAgentStreamHermesSession({ agentId, stateDir = DEFAULT_STATE_DIR, apiOrigin, apiKey, fetchImpl = fetch, forceNew = true }) {
  const headers = { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }
  if (!forceNew) {
    const existing = readMappingFile(stateDir, agentId)
    if (existing) {
      try {
        const check = await fetchImpl(`${apiOrigin}/api/sessions/${encodeURIComponent(existing)}`, { headers })
        if (check.ok) return { hermesSessionId: existing, created: false }
      } catch {
        // 校验失败按重建处理
      }
    }
  }
  const hermesSessionId = `ctrlstream_${agentId}_${Math.random().toString(16).slice(2, 10)}`
  const titleSuffix = Math.random().toString(16).slice(2, 6)
  const response = await fetchImpl(`${apiOrigin}/api/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: hermesSessionId, title: `control 咨询流（${agentId}）#${titleSuffix}` })
  })
  if (!response.ok) {
    throw new Error(`hermes_session_create_http_${response.status}`)
  }
  writeMappingFile(stateDir, agentId, hermesSessionId)
  return { hermesSessionId, created: true }
}

/**
 * 执行一轮咨询 agent 流。
 * @returns {Promise<{ok:boolean, finalAnswer:string, usage:object|null, blockedTool:string|null, aborted:boolean, error:string|null}>}
 */
export async function runAgentStreamChat({
  prompt,
  agentId,
  hermesApiBaseUrl,
  hermesApiKey = '',
  fetchImpl = fetch,
  onStreamEvent = () => {},
  appendEvidence = () => {},
  isAborted = () => false,
  log = () => {},
  stateDir = DEFAULT_STATE_DIR,
  systemPrompt = null
}) {
  const apiOrigin = String(hermesApiBaseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '')
  if (!apiOrigin) throw new Error('hermes_api_base_url_missing')
  const parser = createAgentStreamSseParser()
  const assembler = createAgentStreamStepAssembler()
  let finalAnswer = ''
  let usage = null
  let blockedTool = null
  let sawTerminalError = null
  let lastCancelCheckAt = 0

  const { hermesSessionId } = await ensureAgentStreamHermesSession({
    agentId,
    stateDir,
    apiOrigin,
    apiKey: hermesApiKey,
    fetchImpl
  })

  const controller = new AbortController()
  const response = await fetchImpl(`${apiOrigin}/api/sessions/${encodeURIComponent(hermesSessionId)}/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(hermesApiKey ? { Authorization: `Bearer ${hermesApiKey}` } : {})
    },
    body: JSON.stringify({ message: String(prompt || ''), system_message: systemPrompt || buildAgentStreamSystemPrompt() }),
    signal: controller.signal
  })
  if (!response.ok || !response.body) {
    throw new Error(`hermes_chat_stream_http_${response.status}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf8')

  async function abortUpstream() {
    try {
      await reader.cancel()
    } catch {
      // best effort
    }
    try {
      controller.abort()
    } catch {
      // best effort
    }
  }

  function abortIfCancelledExternally() {
    const now = Date.now()
    if (now - lastCancelCheckAt < CANCEL_CHECK_INTERVAL_MS) return false
    lastCancelCheckAt = now
    return Boolean(isAborted())
  }

  async function handleStreamEvent(name, data) {
    if (name === 'tool.progress' && String(data?.tool_name || '') === '_thinking') {
      const text = String(data?.delta || '').trim()
      if (!text) return
      const evt = assembler.thinking(text)
      if (evt) onStreamEvent(evt)
      appendEvidence('agent_thinking', `思考（STEP ${evt?.stepIndex ?? ''}）`, truncateAgentStreamText(text), {
        data: { stepIndex: evt?.stepIndex ?? null }
      })
      return
    }
    if (name === 'tool.started') {
      const tool = String(data?.tool_name || '').trim()
      const described = describeAgentStreamToolCall(tool, data?.args, data?.preview)
      if (!isAgentStreamToolAllowed(tool)) {
        // 只读白名单硬边界：tool.started 先于真实执行，立即断开上游以中止 agent 任务
        blockedTool = tool
        appendEvidence('agent_tool_blocked', `已拦截越权工具：${tool || 'unknown'}`, `咨询只读模式禁止调用 ${tool || 'unknown'}（${described.actionLabel}），已中断本次回答。`, {
          data: { tool, actionLabel: described.actionLabel, target: described.target }
        })
        onStreamEvent({ type: 'blocked', tool, actionLabel: described.actionLabel, target: described.target })
        await abortUpstream()
        return
      }
      const evt = assembler.toolStarted(tool, described)
      onStreamEvent(evt)
      appendEvidence('agent_tool_call', `动作：${described.actionLabel}`, described.target ? `目标：${described.target}` : described.actionLabel, {
        data: { stepIndex: evt.stepIndex, tool, target: described.target }
      })
      return
    }
    if (name === 'tool.completed' || name === 'tool.failed') {
      const tool = String(data?.tool_name || '').trim()
      const ok = name === 'tool.completed'
      const evt = assembler.toolFinished(tool, ok, ok ? null : String(data?.preview || '工具执行失败'))
      onStreamEvent(evt)
      appendEvidence('agent_tool_result', ok ? `完成：${tool}` : `失败：${tool}`, ok ? '只读查证完成。' : '工具执行失败。', {
        data: { stepIndex: evt.stepIndex, tool, ok }
      })
      return
    }
    if (name === 'assistant.delta') {
      const delta = String(data?.delta || '')
      if (delta) onStreamEvent({ type: 'answer_delta', delta })
      return
    }
    if (name === 'assistant.completed') {
      finalAnswer = String(data?.content || '').trim() || finalAnswer
      return
    }
    if (name === 'run.completed') {
      usage = data?.usage && typeof data.usage === 'object' ? data.usage : null
      return
    }
    if (name === 'error') {
      sawTerminalError = String(data?.message || 'hermes_stream_error')
    }
  }

  try {
    for (;;) {
      if (abortIfCancelledExternally()) {
        await abortUpstream()
        return { ok: false, finalAnswer: '', usage, blockedTool, aborted: true, error: 'aborted_by_client' }
      }
      const { done, value } = await reader.read()
      if (done) break
      const events = parser.feed(decoder.decode(value, { stream: true }))
      for (const item of events) {
        await handleStreamEvent(item.event, item.data || {})
        if (blockedTool) break
      }
      if (blockedTool) break
    }
    const tail = parser.flush()
    for (const item of tail) {
      await handleStreamEvent(item.event, item.data || {})
    }
  } catch (error) {
    if (blockedTool) {
      // 白名单拦截后的主动断开，不算失败
    } else if (controller.signal.aborted) {
      return { ok: false, finalAnswer: '', usage, blockedTool, aborted: true, error: 'aborted_by_client' }
    } else {
      throw error
    }
  }

  if (blockedTool) {
    const detail = describeAgentStreamToolCall(blockedTool, null, null)
    return {
      ok: false,
      finalAnswer: `本次咨询尝试调用 ${detail.actionLabel}（${blockedTool}），已超出咨询只读边界，为保护工作区已中断回答。如需执行写入/生产操作，请改用指令式描述（例如「创建故事xxx」）走生产工作流。`,
      usage,
      blockedTool,
      aborted: false,
      error: `tool_blocked:${blockedTool}`
    }
  }
  if (sawTerminalError) {
    return { ok: false, finalAnswer: '', usage, blockedTool, aborted: false, error: sawTerminalError }
  }
  if (isAborted()) {
    return { ok: false, finalAnswer: '', usage, blockedTool, aborted: true, error: 'aborted_by_client' }
  }
  log(`[AGENT_STREAM] done session=${hermesSessionId} answerChars=${finalAnswer.length}`)
  return { ok: Boolean(finalAnswer), finalAnswer, usage, blockedTool, aborted: false, error: finalAnswer ? null : 'empty_final_answer' }
}
