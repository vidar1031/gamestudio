import { streamSSE } from 'hono/streaming'
import fs from 'node:fs'
import path from 'node:path'

import { GAMESTUDIO_ROOT } from '../../config/paths.js'
import { classifyReasoningRequest } from '../reasoning/requestClassifier.js'
import { runAgentStreamChat, buildAgentStreamSystemPrompt } from '../reasoning/agentStreamBridge.js'
import { runPhasedAgentStream } from '../reasoning/phasedAgentStream.js'
import { REASONING_SESSION_STATE, applySessionTransition } from '../reasoning/sessionStateMachine.js'
import { getProjectBinding } from '../services/projectBindingService.js'
import { getProjectCapabilities } from '../services/projectCapabilityService.js'

// 项目库实况（确定性读取真相源 storage/projects + 各 project.json 标题）：
// 避免模型凭记忆/旧会话编造项目数量与名称（2026-08-25 实测误答"仅 1 个灰姑娘项目"的修复）。
// 读取失败必须如实标注，不得硬造。体积有界：最多列 10 个。
function buildProjectLibraryFactsBlock() {
  try {
    const projectsDir = path.join(GAMESTUDIO_ROOT, 'storage', 'projects')
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    const items = dirs.slice(0, 10).map((entry) => {
      let title = ''
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(projectsDir, entry.name, 'project.json'), 'utf8'))
        title = String(meta?.title || meta?.name || '').trim()
      } catch {
        // 单个项目元数据缺失不阻断
      }
      return title ? `${title}（${dirs.length <= 5 ? entry.name : entry.name.slice(0, 8)}）` : `${entry.name.slice(0, 8)}（无标题）`
    })
    return [
      `项目库实况（control 刚刚从磁盘直接读取的当前事实）：storage/projects 当前共 ${dirs.length} 个项目。`,
      ...(items.length ? [`项目清单：${items.join('、')}${dirs.length > 10 ? ` 等（共 ${dirs.length} 个）` : ''}`] : []),
      '回答项目数量/名称/列表类问题时必须以上述实况为准——它的优先级高于任何会话记录、记忆或 session_search 结果（那些是历史，不是现状）；查询当前项目实况时禁止再调用 session_search。'
    ].join('\n')
  } catch {
    return '项目库实况：storage/projects 当前不可读或不存在（如实告知用户，禁止编造项目清单）。'
  }
}
export const AGENT_STREAM_EXECUTION_MODE = 'agent_stream'

// ============ 写操作意图 → 结构化可确认提案（2026-08-25，用户指令） ============
// 问题场景：用户在咨询里提写请求（如"能把故事重命名为《三只小猪》吗"），模型只能空说
// "请回复确认"——确认了也没人执行。现改为 control 直接产出 project.update（GS-05）提案，
// 由 console 既有事件确认卡承接：用户点确认 → dispatch（command 审核门）→ 执行 → 证据。
const RENAME_INTENT_PATTERN = /重命名|改名|修改名称|改个名|改名字|换个名字|把.{0,12}名称?改/
const RENAME_NEW_NAME_PATTERN = /《([^》]+)》|「([^」]+)」|『([^』]+)』|"([^"]+)"|“([^”]+)”|叫\s*([一-龥A-Za-z0-9 _-]{2,30})/

function extractRenameNewName(prompt) {
  const match = String(prompt || '').match(RENAME_NEW_NAME_PATTERN)
  if (!match) return ''
  return String(match.slice(1).find((g) => g) || '').trim()
}

// 解析改名目标项目：当前问题 + 最近 4 条历史消息里的 uuid（全/8位前缀）或非默认标题命中唯一项目
function resolveRenameTargetProject(prompt, history) {
  const projectsDir = path.join(GAMESTUDIO_ROOT, 'storage', 'projects')
  let dirs = []
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return null
  }
  const texts = [String(prompt || '')]
  for (const entry of (Array.isArray(history) ? history : []).slice(-4)) {
    const content = String(entry?.content || '')
    if (content) texts.push(content)
  }
  const haystack = texts.join('\n')
  const matched = []
  for (const id of dirs) {
    let title = ''
    try {
      title = String(JSON.parse(fs.readFileSync(path.join(projectsDir, id, 'project.json'), 'utf8'))?.title || '').trim()
    } catch {
      // 元数据缺失按无标题处理
    }
    const idHit = haystack.includes(id) || (id.length > 8 && haystack.includes(id.slice(0, 8)))
    const titleHit = title && title !== '未命名互动故事' && haystack.includes(title)
    if (idHit || titleHit) matched.push({ id, title })
  }
  const unique = []
  for (const item of matched) {
    if (!unique.some((existing) => existing.id === item.id)) unique.push(item)
  }
  return unique.length === 1 ? unique[0] : null
}

function buildRenameProposal(prompt, history) {
  if (!RENAME_INTENT_PATTERN.test(prompt)) return null
  const newName = extractRenameNewName(prompt)
  if (!newName) return null
  const target = resolveRenameTargetProject(prompt, history)
  if (!target) return null
  return {
    eventId: 'project.update',
    code: 'GS-05',
    title: '更新项目文档',
    kind: 'command',
    reviewRequired: true,
    summary: `将项目「${target.title || target.id.slice(0, 8)}」重命名为《${newName}》（写入 ${target.id}/project.json 的标题字段）`,
    payload: { projectId: target.id, project: { title: newName } }
  }
}

// 生产推进意图 → 资产/出图提案：识别"出场景图/渲染/补齐资产"等推进请求，
// 产出 asset.plan.create（GS-18，P1 资产生成链的入口命令）提案，走同一确认卡门禁。
// 仅当能从当前问题/近期历史唯一解析到已存在项目时才拦截；否则落回模型/工作流。
const ASSET_PROGRESS_INTENT_PATTERN = /场景图|出图|渲染|生成资产|补齐资产|资产计划|立绘|背景图|图片生产|推进.{0,8}(图|资产|生产)|继续.{0,4}(生产|出图|图)/
// 推进动词必须有——纯分析/检查类问题（"分析缺什么""场景图好了吗"）不拦截，落回咨询查证路径
const ASSET_PROGRESS_VERB_PATTERN = /生成|创建|开始|推进|继续|渲染|出图|补齐|绘制/

function buildAssetPlanProposal(prompt, history) {
  if (!ASSET_PROGRESS_INTENT_PATTERN.test(prompt)) return null
  if (!ASSET_PROGRESS_VERB_PATTERN.test(prompt)) return null
  const target = resolveRenameTargetProject(prompt, history)
  if (!target) return null
  return {
    eventId: 'asset.plan.create',
    code: 'GS-18',
    title: '创建故事资产计划',
    kind: 'command',
    reviewRequired: true,
    summary: `为项目「${target.title || target.id.slice(0, 8)}」创建资产计划——场景图生产链第一步（后续：参考图锁定 → 场景渲染 → 校验导出，每步都需你审核确认）`,
    payload: { projectId: target.id, source: 'control_production_delivery' }
  }
}

// ============ 锁定/出图阶段意图表（聊天驱动锁定事物阶段，2026-08-25） ============
// 每条形意一个阶段动作：command 走确认卡 + 审核门；query（体检/自检）console 直接执行并读回结果。
// 顺序即优先级：更具体的模式放在前面。
const PRODUCTION_STAGE_INTENTS = [
  {
    kind: 'query', eventId: 'studio.selfcheck', code: 'GS-29', title: '环境自检',
    pattern: /环境体检|环境检查|自检|检查环境|体检/,
    summary: () => '执行工作室环境自检（ComfyUI 连通性、节点与模型完整性等），只读、直接出结果',
    payload: () => ({})
  },
  {
    kind: 'query', eventId: 'project.inspect', code: 'GS-03', title: '读取项目',
    pattern: /检查项目|项目状态|项目完整|校验项目/,
    summary: (t) => `读取项目「${t.title || t.id.slice(0, 8)}」的当前真实状态（只读）`,
    payload: (t) => ({ projectId: t.id })
  },
  {
    kind: 'command', eventId: 'story.bible.generate', code: 'GS-13', title: '生成 Story Bible',
    pattern: /story\s*bible|故事圣经|生成\s*bible/i,
    summary: (t) => `为项目「${t.title || t.id.slice(0, 8)}」生成 Story Bible（经 control 工作流产线执行：自动构造输入、生成、写回、校验，全程留证据）`,
    payload: (t) => ({ projectId: t.id, timeoutMs: 600000 }),
    // 裸事件需要调用方构造结构化 input（编辑器侧逻辑），聊天层没有——走工作流更稳：
    // control 的 story_create_bible 动作自带 buildStoryBibleGenerationInput（从项目文件构造）。
    // 注意措辞经实测校准：含英文 "Story Bible" 会被分类到模型自由规划（产出全链跑偏），
    // 且规划器 bible-only 分支要求显式排除资产计划与锁定测试（wantsStoryBibleOnly && forbids*）。
    // 以下措辞实测稳定产出 2 步链（story_create_bible + answer）。
    workflowPrompt: (t) => `为现有故事项目 ${t.title || ''}（${t.id}）只生成 圣经数据，不做资产计划，不做锁定测试`
  },
  {
    kind: 'command', eventId: 'asset.reference.lock', code: 'GS-20', title: '锁定资产参考图',
    pattern: /主参考锁定|锁定参考图|参考图锁定|锁定主参考|确认锁定/,
    summary: (t) => `锁定项目「${t.title || t.id.slice(0, 8)}」各资产的主参考图`,
    payload: (t) => ({ projectId: t.id })
  },
  {
    kind: 'command', eventId: 'asset.reference.generate', code: 'GS-19', title: '生成资产参考图',
    pattern: /生成.{0,6}参考图|参考图生成|抽卡/,
    summary: (t) => `为项目「${t.title || t.id.slice(0, 8)}」生成资产参考图（抽卡候选，出图前需你审核）`,
    payload: (t) => ({ projectId: t.id })
  },
  {
    kind: 'command', eventId: 'asset.lock.test', code: 'GS-21', title: '锁定测试图生成与评审',
    pattern: /锁定测试|线稿锁定|测试渲染/,
    summary: (t) => `对项目「${t.title || t.id.slice(0, 8)}」执行锁定测试（出测试图 + AI 评审，通过后你确认锁定）`,
    payload: (t) => ({ projectId: t.id })
  },
  {
    kind: 'command', eventId: 'asset.scene.renderAll', code: 'GS-34', title: '批量渲染缺失场景图',
    pattern: /渲染缺失|批量渲染|渲染全部|缺失场景|渲染场景/,
    summary: (t) => `批量渲染项目「${t.title || t.id.slice(0, 8)}」的缺失场景图（onlyMissing，支持断点续跑）`,
    payload: (t) => ({ projectId: t.id, onlyMissing: true })
  }
]

function buildProductionStageProposal(prompt, history) {
  for (const intent of PRODUCTION_STAGE_INTENTS) {
    if (!intent.pattern.test(prompt)) continue
    if (intent.kind === 'query') {
      const needsTarget = intent.eventId === 'project.inspect'
      const target = needsTarget ? resolveRenameTargetProject(prompt, history) : null
      if (needsTarget && !target) return null
      return {
        eventId: intent.eventId, code: intent.code, title: intent.title,
        kind: 'query', reviewRequired: false,
        summary: intent.summary(target),
        payload: intent.payload(target)
      }
    }
    const target = resolveRenameTargetProject(prompt, history)
    if (!target) return null
    return {
      eventId: intent.eventId, code: intent.code, title: intent.title,
      kind: 'command', reviewRequired: true,
      summary: intent.summary(target),
      payload: intent.payload(target),
      ...(typeof intent.workflowPrompt === 'function' ? { workflowPrompt: intent.workflowPrompt(target) } : {})
    }
  }
  return null
}

// 8K 基准：外部记忆有界注入——从聊天落盘（ai/chat/YYYY-MM-DD.json）取最近若干对问答，
// 逐条截断、对数封顶（≤2 对 ≈ 460 字符内），让每轮新建会话的咨询流也能感知近期上下文；
// 更早历史不驻留上下文，需要时走 session-search 外部检索。确定性处理，不产生额外模型调用。
// 2026-08-25 收紧：未提限的机器上 prefill 安全顶约 4.5K tokens，注入块必须更瘦。
const AGENT_STREAM_MEMORY_MAX_PAIRS = 2
const AGENT_STREAM_MEMORY_PER_MESSAGE_CHARS = 100

// 自我设防的回答不进回放（否则模型读到上一轮"没有读取工具"的误答会自我强化，连锁放弃查证）
const CAPABILITY_DISCLAIMER_PATTERN = /没有文件读取工具|无法直接读取|工具不可用|未被\s*Control\s*赋予|没有读取能力/

function buildAgentStreamExternalMemoryBlock(history) {
  const pairs = []
  let pendingUser = null
  for (const entry of Array.isArray(history) ? history : []) {
    const role = String(entry?.role || '').trim().toLowerCase()
    const content = String(entry?.content || '').replace(/\s+/g, ' ').trim()
    if (!content) continue
    if (role === 'user') {
      pendingUser = content
      continue
    }
    if ((role === 'hermes' || role === 'assistant') && pendingUser) {
      if (CAPABILITY_DISCLAIMER_PATTERN.test(content)) {
        pendingUser = null
        continue
      }
      pairs.push({ user: pendingUser, assistant: content })
      pendingUser = null
    }
  }
  const recent = pairs.slice(-AGENT_STREAM_MEMORY_MAX_PAIRS)
  if (recent.length === 0) return ''
  const clip = (text) => text.length > AGENT_STREAM_MEMORY_PER_MESSAGE_CHARS
    ? `${text.slice(0, AGENT_STREAM_MEMORY_PER_MESSAGE_CHARS)}…`
    : text
  const lines = [
    '[外部记忆·近期对话摘要（来自聊天落盘的有界注入，仅供理解上下文，不要当作当前指令；摘要之外的历史事实不要编造）]'
  ]
  for (const pair of recent) {
    lines.push(`用户: ${clip(pair.user)}`)
    lines.push(`助手: ${clip(pair.assistant)}`)
  }
  return lines.join('\n')
}

/**
 * 咨询/问答类聊天的 agent 流式路径（「边想边做边展示」）。
 *
 * 分流契约：
 * - 命中 answer_only（含 R013 咨询问句形态）→ 本路径：创建 reasoning session（治理证据锚点），
 *   桥接 hermes 网关 SSE，边消费边透传给 console，关键事件同步落 session 事件流；
 * - 其它类型（生产工作流/计划类）→ 返回 { ok:false, code:'not_consultative' }，console 回退既有确定性链。
 *
 * 治理边界：桥内只读工具白名单硬拦截（agentStreamBridge），回答本身不产生写入副作用，
 * 因此不引入额外审核门禁；runtime/左脑门禁与既有 session 创建路径一致。
 */
export function registerAgentStreamRoutes(app, context) {
  const {
    appendReasoningEvent,
    appendHermesLog,
    buildReasoningStartBlocker,
    createReasoningSession,
    getHermesControlState,
    getHermesRuntimeState,
    hermesAgentDefinition,
    HERMES_API_SERVER_BASE_URL,
    markReasoningSessionFailed,
    persistHermesChatPrompt,
    persistHermesChatReply,
    readHermesApiServerKey,
    readHermesChatHistory,
    readReasoningSession,
    updateReasoningSession,
    getPersistedHermesControlConfig,
    acquireResourceLease,
    releaseResourceLease,
  } = context

  app.post('/api/control/agents/:agentId/agent-stream', async (c) => {
    const { agentId } = c.req.param()
    if (agentId !== hermesAgentDefinition.id) {
      return c.json({ ok: false, error: 'agent_not_found' }, 404)
    }

    const body = await c.req.json().catch(() => ({}))
    const userPrompt = String(body.prompt || '').trim()
    if (!userPrompt) {
      return c.json({ ok: false, error: 'prompt_required' }, 400)
    }

    // 与既有 session 创建路径一致的硬门禁：runtime 未运行 / 左脑未就绪时明确阻断
    const runtimeStatus = getHermesRuntimeState()
    if (runtimeStatus.state !== 'running') {
      return c.json({ ok: false, error: 'runtime_not_running', runtimeStatus }, 409)
    }
    const startBlocker = buildReasoningStartBlocker()
    if (startBlocker) {
      return c.json({ ok: false, ...startBlocker, runtimeStatus, controlState: getHermesControlState() }, 409)
    }

    // 分流：仅咨询/问答类进入 agent 流；其余交由 console 回退到既有确定性执行链
    const classification = classifyReasoningRequest(userPrompt)

    // 写操作/生产推进意图优先产出结构化可确认提案（不调用模型）：用户在咨询/链路中提写请求时，
    // 由 console 事件确认卡承接，确认后走对应 command 审核门禁执行。
    // 目标或新名称无法唯一解析时不拦截——落回正常路径让模型追问。
    const chatHistoryForProposal = typeof readHermesChatHistory === 'function' ? readHermesChatHistory({ includeAllSessions: true }) : []
    // 顺序即优先级：改名 → 具体阶段动作（体检/bible/锁定/渲染缺失）→ 宽泛出图推进（资产计划）
    const writeProposal = buildRenameProposal(userPrompt, chatHistoryForProposal)
      || buildProductionStageProposal(userPrompt, chatHistoryForProposal)
      || buildAssetPlanProposal(userPrompt, chatHistoryForProposal)
    if (writeProposal) {
      appendHermesLog(`[AGENT_STREAM][PROPOSAL] ${writeProposal.eventId} projectId=${writeProposal.payload.projectId}`)
      return c.json({ ok: true, code: 'action_proposal', proposal: writeProposal, classification: {
        type: classification.type,
        route: classification.route,
        ruleId: classification.ruleId || null
      } })
    }

    if (classification.route !== 'answer_only') {
      return c.json({
        ok: false,
        code: 'not_consultative',
        classification: {
          type: classification.type,
          route: classification.route,
          ruleId: classification.ruleId || null,
          reason: classification.reason
        }
      })
    }

    const session = await createReasoningSession(agentId, userPrompt, {
      reviewMode: String(body.reviewMode || '').trim().toLowerCase() || 'manual',
      executionMode: AGENT_STREAM_EXECUTION_MODE,
      // 咨询流不做质检重试/记忆回写，与 answer_only 轻量语义一致
      disableQualityAutoRetry: true,
      disableMemorySync: true,
    })
    persistHermesChatPrompt(session.sessionId, userPrompt)
    const sessionId = session.sessionId

    return streamSSE(c, async (stream) => {
      let clientGone = false
      stream.onAbort(() => {
        clientGone = true
      })

      const send = (type, payload = {}) => stream.writeSSE({ event: type, data: JSON.stringify({ type, ...payload }) })

      await send('session', { sessionId, classification: { type: classification.type, ruleId: classification.ruleId || null } })

      // queued → running（状态机合法转移），随后全程事件落证据
      updateReasoningSession(sessionId, (current) => applySessionTransition(current, REASONING_SESSION_STATE.RUNNING, 'agent_stream_started'))
      appendReasoningEvent(sessionId, 'agent_stream_started', '进入 agent 流式咨询', `分类 ${classification.type}（${classification.ruleId || '规则表'}），咨询走 agent 边想边做路径，工具限定只读集。`, {
        data: { executionMode: AGENT_STREAM_EXECUTION_MODE, classification: { type: classification.type, route: classification.route, ruleId: classification.ruleId || null } }
      })

      // 心跳：agent 长考（无工具事件的模型生成段）期间更新 artifacts.lastHeartbeatAt，
      // 防止孤儿扫描（默认 60s 无心跳）把本 session 误判为 orphaned/blocked。
      // 只写字段时间戳，不产生事件噪音（与 qualityGate 的 task_heartbeat 语义对齐）。
      const heartbeatTimer = setInterval(() => {
        try {
          updateReasoningSession(sessionId, (current) => {
            if (current.status !== REASONING_SESSION_STATE.RUNNING) return current
            return { ...current, artifacts: { ...current.artifacts, lastHeartbeatAt: new Date().toISOString() } }
          })
        } catch {
          // best effort：session 已被并发收敛时忽略
        }
      }, 20000)

      try {
        const binding = getProjectBinding()
        const capabilitySummary = getProjectCapabilities(binding)
        const systemPrompt = buildAgentStreamSystemPrompt({ ...capabilitySummary, binding })
        // 权威模型身份（2026-08-24 修复：SOUL.md 等上下文文件里的型号可能过时，
        // 曾把 gemma 旧记录当当前身份误答；以 control 左脑配置为准并显式声明优先级）
        const controlConfig = typeof getPersistedHermesControlConfig === 'function' ? getPersistedHermesControlConfig() : null
        const identityBlock = [
          `你当前实际运行的本地模型是 ${controlConfig?.provider || 'omlx'} / ${controlConfig?.model || 'unknown'}（OMLX 本地部署）。`,
          '被问到当前模型或部署身份时，必须以这条信息为准如实回答；上下文文件或历史对话里出现的其他型号都是过时信息，不得引用。'
        ].join('\n')
        // 外部记忆有界注入：咨询流每轮新建 gateway 会话，近期上下文只能从聊天落盘补充
        const externalMemoryBlock = buildAgentStreamExternalMemoryBlock(
          typeof readHermesChatHistory === 'function' ? readHermesChatHistory({ includeAllSessions: true }) : []
        )
        // 预发送守卫（2026-08-25）：估计本端出站（system_message + 用户消息）规模，超预算先丢记忆块、再硬截断。
        // 目的：未提限机器上 gateway 前缀（人格+工具 schema）已占 ~2-3K tokens，本端必须自控，
        // 否则 OMLX prefill 安全顶（~4.5K tokens 总）会直接 400 拒答——慢可以，被拒不行。
        const OUTBOUND_CHAR_BUDGET = 2600
        const projectLibraryFacts = buildProjectLibraryFactsBlock()
        const buildOutboundPrompt = (memoryBlock) => [
          identityBlock,
          systemPrompt,
          projectLibraryFacts,
          ...(memoryBlock ? [memoryBlock] : [])
        ].join('\n\n')
        let enrichedSystemPrompt = buildOutboundPrompt(externalMemoryBlock)
        if (enrichedSystemPrompt.length + userPrompt.length > OUTBOUND_CHAR_BUDGET) {
          enrichedSystemPrompt = buildOutboundPrompt('')
        }
        if (enrichedSystemPrompt.length + userPrompt.length > OUTBOUND_CHAR_BUDGET) {
          enrichedSystemPrompt = `${enrichedSystemPrompt.slice(0, Math.max(200, OUTBOUND_CHAR_BUDGET - userPrompt.length))}\n…`
        }
        appendHermesLog(`[AGENT_STREAM][OUTBOUND] systemChars=${enrichedSystemPrompt.length} userChars=${userPrompt.length} hasProjectFacts=${enrichedSystemPrompt.includes('项目库实况')} hasIdentity=${enrichedSystemPrompt.includes('实际运行的本地模型')}`)
        // 使用分阶段 agent stream：工具调用结果外置，模型只看到极小上下文
        // 咨询流模型生成全程持 llm 租约（与出图/视觉评审独占交换互斥；断流即释放）
        const lease = typeof acquireResourceLease === 'function'
          ? await acquireResourceLease({ kind: 'llm', holder: `agent_stream:${sessionId}`, signal: c.req.raw.signal })
          : { ok: true, leaseId: null }
        if (!lease.ok) throw new Error(lease.error || 'resource_lease_denied')
        const usePhasedStream = process.env.HERMES_PHASED_STREAM !== 'false'
        let result
        try {
          result = usePhasedStream
            ? await runPhasedAgentStream({
                prompt: userPrompt,
                agentId,
                hermesApiBaseUrl: HERMES_API_SERVER_BASE_URL,
                hermesApiKey: typeof readHermesApiServerKey === 'function' ? readHermesApiServerKey() : '',
                onStreamEvent: (evt) => send(evt.type, evt),
                appendEvidence: (type, title, summary, extra) => appendReasoningEvent(sessionId, type, title, summary, extra),
                isAborted: () => clientGone || readReasoningSession(sessionId)?.status === REASONING_SESSION_STATE.CANCELLED,
                systemPrompt: enrichedSystemPrompt
              })
            : await runAgentStreamChat({
                prompt: userPrompt,
                agentId,
                hermesApiBaseUrl: HERMES_API_SERVER_BASE_URL,
                hermesApiKey: typeof readHermesApiServerKey === 'function' ? readHermesApiServerKey() : '',
                onStreamEvent: (evt) => send(evt.type, evt),
                appendEvidence: (type, title, summary, extra) => appendReasoningEvent(sessionId, type, title, summary, extra),
                isAborted: () => clientGone || readReasoningSession(sessionId)?.status === REASONING_SESSION_STATE.CANCELLED,
                systemPrompt: enrichedSystemPrompt
              })
        } finally {
          if (lease.leaseId && typeof releaseResourceLease === 'function') releaseResourceLease(lease.leaseId)
        }

        if (result.aborted) {
          // 客户端断开或经停止按钮取消：若仍是 running 则收敛为 cancelled（停止按钮路径已由 cancel 端点转移，幂等跳过）
          const current = readReasoningSession(sessionId)
          if (current && current.status === REASONING_SESSION_STATE.RUNNING) {
            updateReasoningSession(sessionId, (latest) => applySessionTransition(latest, REASONING_SESSION_STATE.CANCELLED, 'agent_stream_aborted'))
            appendReasoningEvent(sessionId, 'session_cancelled', '咨询已中断', '连接断开或人工停止，agent 流式咨询已中止。')
          }
          await send('done')
          return
        }

        if (result.blockedTool) {
          updateReasoningSession(sessionId, (current) => ({
            ...applySessionTransition(current, REASONING_SESSION_STATE.BLOCKED, `tool_blocked:${result.blockedTool}`),
            artifacts: { ...current.artifacts, finalAnswer: result.finalAnswer }
          }))
          appendReasoningEvent(sessionId, 'session_blocked', '咨询被边界拦截', `越权工具 ${result.blockedTool} 已拦截，session 收敛为 blocked。`)
          persistHermesChatReply(sessionId, result.finalAnswer, result.usage || null, { provisional: true })
          await send('final', { answer: result.finalAnswer, blocked: true })
          await send('done')
          return
        }

        if (!result.ok) {
          throw new Error(result.error || 'agent_stream_failed')
        }

        updateReasoningSession(sessionId, (current) => ({
          ...applySessionTransition(current, REASONING_SESSION_STATE.COMPLETED, 'agent_stream_completed'),
          artifacts: {
            ...current.artifacts,
            finalAnswer: result.finalAnswer,
            finalAnswerUsage: result.usage || null,
            finalAnswerPersisted: true,
          }
        }))
        appendReasoningEvent(sessionId, 'final_answer_ready', '最终回答', 'agent 流式咨询已完成，最终回答已写回聊天。', {
          data: { targetType: 'answer', executionMode: AGENT_STREAM_EXECUTION_MODE }
        })
        appendReasoningEvent(sessionId, 'session_completed', '咨询完成', 'agent 流式咨询链路结束。')
        persistHermesChatReply(sessionId, result.finalAnswer, result.usage || null)
        await send('final', { answer: result.finalAnswer, usage: result.usage || null })
        await send('done')
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        markReasoningSessionFailed(sessionId, detail)
        await send('error', { message: detail })
        await send('done')
      } finally {
        clearInterval(heartbeatTimer)
      }
    })
  })
}
