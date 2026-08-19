/**
 * reasoning task 级失败的确定性错误分类与重试退避策略。
 *
 * AUTO-C02：让队列按确定性错误分类执行有限重试——
 * 网络瞬断/503 等临时故障进入 retry_wait 并按指数退避重试；
 * schema、权限、确定性业务错误不重试，直接收敛 failed / blocked。
 *
 * 语义约定：
 * - 分类是纯函数、确定性规则表，首条命中生效；输出 category + rule + reason，
 *   每条分类都可追溯（rule 写进 queue item retryHistory 与 session 事件）。
 * - 与既有 step 结果信号对齐，不另造一套：story/gamestudio workflow 步骤结果
 *   已携带 retryable/failedStage/serverStatus（gameStudioServerClient.classifyRetryable
 *   同源语义：无 status 的网络错误、408/429/5xx 可重试，其余 4xx 不可重试），
 *   显式信号优先于消息模式匹配。
 * - 无法归类时保守按 non_retryable 处理（不盲目重跑可能有副作用的任务），
 *   并以 rule=unclassified_default 记录理由。
 * - 本模块只管 task 级失败后的队列重试调度；step 内重试（recoverReasoningStepFailure、
 *   quality gate 重规划、Hermes 调用瞬态探针）是既有行为，不在此改动。
 */

// 分类结果：retryable（可退避重试）/ non_retryable（直接 failed）/
// needs_review（需人工处理，收敛 blocked）/ blocked（明确阻断，收敛 blocked）
export const REASONING_RETRY_CATEGORY = Object.freeze({
  RETRYABLE: 'retryable',
  NON_RETRYABLE: 'non_retryable',
  NEEDS_REVIEW: 'needs_review',
  BLOCKED: 'blocked'
})

// 重试上限：HERMES_REASONING_RETRY_MAX_ATTEMPTS 可覆盖，默认 3 次（不含首次执行）；0 = 关闭重试
const DEFAULT_RETRY_MAX_ATTEMPTS = 3
// 退避基数：HERMES_REASONING_RETRY_BASE_MS 可覆盖，默认 30000ms（本地模型瞬断恢复的时间尺度）
const DEFAULT_RETRY_BASE_MS = 30000
// 退避上限：HERMES_REASONING_RETRY_MAX_DELAY_MS 可覆盖，默认 300000ms
const DEFAULT_RETRY_MAX_DELAY_MS = 300000

export function resolveRetryMaxAttempts(value) {
  const raw = value ?? process.env.HERMES_REASONING_RETRY_MAX_ATTEMPTS
  if (raw === undefined || raw === null || raw === '') return DEFAULT_RETRY_MAX_ATTEMPTS
  const num = Number(raw)
  if (!Number.isFinite(num) || num < 0) return DEFAULT_RETRY_MAX_ATTEMPTS
  return Math.floor(num)
}

export function resolveRetryBaseMs(value) {
  const raw = value ?? process.env.HERMES_REASONING_RETRY_BASE_MS
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_RETRY_BASE_MS
  return Math.floor(num)
}

export function resolveRetryMaxDelayMs(value) {
  const raw = value ?? process.env.HERMES_REASONING_RETRY_MAX_DELAY_MS
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_RETRY_MAX_DELAY_MS
  return Math.floor(num)
}

/**
 * 指数退避：第 1 次重试 = baseMs，之后每次翻倍，封顶 maxDelayMs。
 */
export function computeRetryBackoffMs(attempt, { baseMs, maxDelayMs } = {}) {
  const base = Math.max(1, Number(baseMs) || DEFAULT_RETRY_BASE_MS)
  const cap = Math.max(base, Number(maxDelayMs) || DEFAULT_RETRY_MAX_DELAY_MS)
  const n = Math.max(1, Math.floor(Number(attempt) || 1))
  return Math.min(cap, base * 2 ** (n - 1))
}

// 审核类：人工审核拒绝/未通过，需要人处理，不自动重试
const REVIEW_PATTERNS = [
  /review_rejected/i,
  /rejected_by_human/i,
  /human_review/i,
  /审核[^，。；]{0,12}(拒绝|未通过)/,
  /人工审核未通过/
]

// 路由不可用：strict 路由声明当前不可满足（如 hermes 通道模型与左脑绑定不一致），
// 配置级问题，重跑必现，收敛 blocked 等待人工修正路由配置
const ROUTE_UNAVAILABLE_PATTERNS = [
  /route_unavailable/i
]

// 网络/临时故障：连接层错误、超时、限流、网关与本地模型过载
const TRANSIENT_PATTERNS = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ECONNABORTED/i,
  /ETIMEDOUT/i,
  /ESOCKETTIMEDOUT/i,
  /EAI_AGAIN/i,
  /ENOTFOUND/i,
  /EPIPE/i,
  /socket hang up/i,
  /fetch failed/i,
  /network( error)?/i,
  /request_timeout/i,
  /hard timeout/i,
  /temporarily unavailable/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
  /too many requests/i,
  /rate.?limit/i,
  /overloaded/i
]

// schema/数据校验：重跑必现，不可重试
const SCHEMA_PATTERNS = [
  /schema/i,
  /invalid[_ ]json/i,
  /json parse/i,
  /unexpected token/i,
  /validation failed/i,
  /parse error/i
]

// 权限/认证：重跑必现，不可重试
const PERMISSION_PATTERNS = [
  /unauthorized/i,
  /forbidden/i,
  /permission[_ ]denied/i,
  /not_allowed/i,
  /access[_ ]denied/i,
  /auth_failed/i
]

// 确定性业务错误：参数缺失/动作不支持/目标不存在/前置未就绪，重跑必现
const DETERMINISTIC_PATTERNS = [
  /missing_/i,
  /unsupported_/i,
  /not_found/i,
  /invalid_/i,
  /_required/i,
  /not_saved/i,
  /not_loaded/i,
  /not_ready/i
]

function classifyByHttpStatus(status) {
  if (status === 408 || status === 429 || status >= 500) {
    return { category: REASONING_RETRY_CATEGORY.RETRYABLE, rule: `http_status_${status}_transient`, reason: `HTTP ${status} 属于临时故障（限流/服务端错误），可按退避重试。` }
  }
  if (status >= 400 && status < 500) {
    return { category: REASONING_RETRY_CATEGORY.NON_RETRYABLE, rule: `http_status_${status}_client_error`, reason: `HTTP ${status} 属于客户端错误（权限/参数/资源不存在），重试必现，不重试。` }
  }
  return null
}

/**
 * 确定性错误分类表。输入（均可选）：
 * - error：主错误文本（session.error 或执行兜底异常）
 * - message：附加错误文本（workflow 步骤结果的 message/error）
 * - failedStage：既有步骤失败阶段信号
 * - httpStatus：既有 HTTP 状态信号（serverStatus / observer status）
 * - retryable：既有步骤结果显式信号（true/false；undefined 表示无信号）
 * 输出：{ category, rule, reason }
 */
export function classifyReasoningFailure(input = {}) {
  const detail = [input.error, input.message, input.failedStage]
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== '')
    .map(String)
    .join(' | ')

  // 1. 审核类优先：即使附带其它信号，也需要人工处理而非自动重试
  if (REVIEW_PATTERNS.some((pattern) => pattern.test(detail))) {
    return { category: REASONING_RETRY_CATEGORY.NEEDS_REVIEW, rule: 'review_rejection', reason: '失败与人工审核拒绝/审核未通过相关，需要人工处理，不自动重试。' }
  }

  // 2. 路由不可用：strict 路由声明不可满足（配置级问题），重试必现，收敛 blocked 等人工修配置
  if (ROUTE_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(detail))) {
    return { category: REASONING_RETRY_CATEGORY.BLOCKED, rule: 'route_unavailable', reason: 'strict 路由声明当前不可满足（如 hermes 通道模型与左脑绑定不一致），需人工修正路由配置，不自动重试。' }
  }

  // 3. 显式 retryable 信号（与 step 结果/gameStudioServerClient 语义对齐）
  if (input.retryable === true) {
    return { category: REASONING_RETRY_CATEGORY.RETRYABLE, rule: 'explicit_retryable_signal', reason: `步骤结果显式标记 retryable=true（failedStage=${input.failedStage || 'unknown'}），按退避重试。` }
  }
  if (input.retryable === false) {
    return { category: REASONING_RETRY_CATEGORY.NON_RETRYABLE, rule: 'explicit_non_retryable_signal', reason: `步骤结果显式标记 retryable=false（failedStage=${input.failedStage || 'unknown'}），确定性失败，不重试。` }
  }

  // 4. 显式 HTTP 状态信号
  const statusNum = Number(input.httpStatus)
  if (Number.isFinite(statusNum) && statusNum > 0) {
    const byStatus = classifyByHttpStatus(statusNum)
    if (byStatus) return byStatus
  }

  // 5. 错误文本内嵌 HTTP 状态码（http_503 / HTTP 503 / model_task_http_503_... 等形态）
  const embedded = detail.match(/http[_ ]?(\d{3})/i)
  if (embedded) {
    const code = Number(embedded[1])
    const byStatus = classifyByHttpStatus(code)
    if (byStatus) return { ...byStatus, rule: `embedded_${byStatus.rule}` }
  }

  // 6. 网络/临时故障模式
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(detail))) {
    return { category: REASONING_RETRY_CATEGORY.RETRYABLE, rule: 'transient_network_pattern', reason: '错误文本命中网络/临时故障模式（连接错误/超时/限流/过载），可按退避重试。' }
  }

  // 7. schema/数据校验
  if (SCHEMA_PATTERNS.some((pattern) => pattern.test(detail))) {
    return { category: REASONING_RETRY_CATEGORY.NON_RETRYABLE, rule: 'schema_validation_pattern', reason: '错误文本命中 schema/数据校验模式，重试必现，不重试。' }
  }

  // 8. 权限/认证
  if (PERMISSION_PATTERNS.some((pattern) => pattern.test(detail))) {
    return { category: REASONING_RETRY_CATEGORY.NON_RETRYABLE, rule: 'permission_auth_pattern', reason: '错误文本命中权限/认证模式，重试必现，不重试。' }
  }

  // 9. 确定性业务错误
  if (DETERMINISTIC_PATTERNS.some((pattern) => pattern.test(detail))) {
    return { category: REASONING_RETRY_CATEGORY.NON_RETRYABLE, rule: 'deterministic_business_pattern', reason: '错误文本命中确定性业务错误模式（参数缺失/动作不支持/目标不存在），重试必现，不重试。' }
  }

  // 10. 无法归类：保守默认不重试（不盲目重跑可能有副作用的任务），记录理由
  return { category: REASONING_RETRY_CATEGORY.NON_RETRYABLE, rule: 'unclassified_default', reason: '错误无法归入已知分类，按保守策略不重试。' }
}

/**
 * 从 session 提取分类输入信号：
 * - 主错误文本取 session.error（markReasoningSessionFailed 写入）；
 * - 显式 retryable/failedStage/httpStatus 取 story/gamestudio workflow 的失败 lastResult，
 *   其次取 gameStudioObserver 最近一次失败观察事件；均无信号则为 undefined。
 */
export function extractFailureSignals(session) {
  const artifacts = session?.artifacts && typeof session.artifacts === 'object' ? session.artifacts : {}
  const lastResults = [
    artifacts?.storyProduction?.lastResult,
    artifacts?.gameStudioBootstrap?.lastResult
  ]
  let failedResult = null
  for (const result of lastResults) {
    if (result && typeof result === 'object' && result.ok === false) {
      failedResult = result
      break
    }
  }
  const observerEvent = artifacts?.gameStudioObserver?.lastEvent
  const failedObserver = observerEvent && typeof observerEvent === 'object' && observerEvent.ok === false
    ? observerEvent
    : null

  const retryable = typeof failedResult?.retryable === 'boolean'
    ? failedResult.retryable
    : (typeof failedObserver?.retryable === 'boolean' ? failedObserver.retryable : undefined)

  const resultStatus = Number(failedResult?.serverStatus)
  const observerStatus = Number(failedObserver?.status)
  const httpStatus = Number.isFinite(resultStatus) && resultStatus > 0
    ? resultStatus
    : (Number.isFinite(observerStatus) && observerStatus > 0 ? observerStatus : undefined)

  const failedStage = failedResult?.failedStage || failedObserver?.failedStage || null
  const message = [failedResult?.message, failedResult?.error, failedObserver?.message, failedObserver?.error]
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== '')
    .map(String)
    .join(' | ') || null

  return {
    error: session?.error || null,
    message,
    failedStage,
    httpStatus,
    retryable
  }
}
