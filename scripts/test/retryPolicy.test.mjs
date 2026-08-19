import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REASONING_RETRY_CATEGORY,
  classifyReasoningFailure,
  extractFailureSignals,
  resolveRetryMaxAttempts,
  resolveRetryBaseMs,
  resolveRetryMaxDelayMs,
  computeRetryBackoffMs
} from '../../apps/control-server/src/server/reasoning/retryPolicy.js'

// AUTO-C02 测试：确定性错误分类表与重试退避参数（纯函数，无 fs/env 副作用）。
// env 覆盖用例在用例内恢复，不影响其他测试文件。

const savedMaxAttemptsEnv = process.env.HERMES_REASONING_RETRY_MAX_ATTEMPTS
const savedBaseMsEnv = process.env.HERMES_REASONING_RETRY_BASE_MS
const savedMaxDelayEnv = process.env.HERMES_REASONING_RETRY_MAX_DELAY_MS

function restoreEnv() {
  if (savedMaxAttemptsEnv === undefined) delete process.env.HERMES_REASONING_RETRY_MAX_ATTEMPTS
  else process.env.HERMES_REASONING_RETRY_MAX_ATTEMPTS = savedMaxAttemptsEnv
  if (savedBaseMsEnv === undefined) delete process.env.HERMES_REASONING_RETRY_BASE_MS
  else process.env.HERMES_REASONING_RETRY_BASE_MS = savedBaseMsEnv
  if (savedMaxDelayEnv === undefined) delete process.env.HERMES_REASONING_RETRY_MAX_DELAY_MS
  else process.env.HERMES_REASONING_RETRY_MAX_DELAY_MS = savedMaxDelayEnv
}

test('配置解析：默认上限 3 次 / 基数 30000ms / 封顶 300000ms，env 与非法值回退', () => {
  assert.equal(resolveRetryMaxAttempts(), 3)
  assert.equal(resolveRetryBaseMs(), 30000)
  assert.equal(resolveRetryMaxDelayMs(), 300000)
  process.env.HERMES_REASONING_RETRY_MAX_ATTEMPTS = '5'
  process.env.HERMES_REASONING_RETRY_BASE_MS = '50'
  process.env.HERMES_REASONING_RETRY_MAX_DELAY_MS = '400'
  try {
    assert.equal(resolveRetryMaxAttempts(), 5)
    assert.equal(resolveRetryBaseMs(), 50)
    assert.equal(resolveRetryMaxDelayMs(), 400)
  } finally {
    restoreEnv()
  }
  // 0 是合法的「关闭重试」；负数/非数字回退默认
  assert.equal(resolveRetryMaxAttempts(0), 0)
  assert.equal(resolveRetryMaxAttempts(-1), 3)
  assert.equal(resolveRetryMaxAttempts('abc'), 3)
  assert.equal(resolveRetryBaseMs(0), 30000)
  assert.equal(resolveRetryBaseMs('xyz'), 30000)
  assert.equal(resolveRetryMaxDelayMs(-5), 300000)
})

test('指数退避：base 翻倍递增并封顶 maxDelayMs', () => {
  const opts = { baseMs: 30000, maxDelayMs: 300000 }
  assert.equal(computeRetryBackoffMs(1, opts), 30000)
  assert.equal(computeRetryBackoffMs(2, opts), 60000)
  assert.equal(computeRetryBackoffMs(3, opts), 120000)
  assert.equal(computeRetryBackoffMs(4, opts), 240000)
  assert.equal(computeRetryBackoffMs(5, opts), 300000) // 封顶
  assert.equal(computeRetryBackoffMs(10, opts), 300000)
  // 毫秒级测试参数同样成立
  assert.equal(computeRetryBackoffMs(1, { baseMs: 20, maxDelayMs: 100 }), 20)
  assert.equal(computeRetryBackoffMs(2, { baseMs: 20, maxDelayMs: 100 }), 40)
  assert.equal(computeRetryBackoffMs(3, { baseMs: 20, maxDelayMs: 100 }), 80)
  assert.equal(computeRetryBackoffMs(4, { baseMs: 20, maxDelayMs: 100 }), 100)
})

test('分类表：网络/超时/限流/5xx 等临时故障 -> retryable', () => {
  const cases = [
    { input: { error: 'fetch failed' }, rule: 'transient_network_pattern' },
    { input: { error: 'connect ECONNREFUSED 127.0.0.1:18888' }, rule: 'transient_network_pattern' },
    { input: { error: 'read ECONNRESET' }, rule: 'transient_network_pattern' },
    { input: { error: 'request ETIMEDOUT after 30000ms' }, rule: 'transient_network_pattern' },
    { input: { error: 'gamestudio_request_timeout_120000ms' }, rule: 'transient_network_pattern' },
    { input: { error: 'plan_task_timeout: exceeded hard timeout 600000ms while waiting through Hermes' }, rule: 'transient_network_pattern' },
    { input: { error: 'socket hang up' }, rule: 'transient_network_pattern' },
    { input: { error: 'http_503' }, rule: 'embedded_http_status_503_transient' },
    { input: { error: 'HTTP 502 Bad Gateway' }, rule: 'embedded_http_status_502_transient' },
    { input: { error: 'model_task_http_504_Gateway Timeout' }, rule: 'embedded_http_status_504_transient' },
    { input: { error: 'gamestudio_registry_http_429' }, rule: 'embedded_http_status_429_transient' },
    { input: { httpStatus: 503 }, rule: 'http_status_503_transient' },
    { input: { httpStatus: 429 }, rule: 'http_status_429_transient' },
    { input: { httpStatus: 408 }, rule: 'http_status_408_transient' },
    { input: { httpStatus: 500 }, rule: 'http_status_500_transient' }
  ]
  for (const { input, rule } of cases) {
    const result = classifyReasoningFailure(input)
    assert.equal(result.category, REASONING_RETRY_CATEGORY.RETRYABLE, `${JSON.stringify(input)} 应分类为 retryable`)
    assert.equal(result.rule, rule)
    assert.ok(result.reason)
  }
})

test('分类表：schema/权限/认证/确定性业务错误 -> non_retryable', () => {
  const cases = [
    { input: { error: 'invalid_scripts_candidate: 脚本候选未通过 schema 验证' }, rule: 'schema_validation_pattern' },
    { input: { error: 'invalid json: Unexpected token < in JSON at position 0' }, rule: 'schema_validation_pattern' },
    { input: { error: 'http_401' }, rule: 'embedded_http_status_401_client_error' },
    { input: { error: 'http_403: forbidden' }, rule: 'embedded_http_status_403_client_error' },
    { input: { error: 'http_404' }, rule: 'embedded_http_status_404_client_error' },
    { input: { error: 'http_422: unprocessable entity' }, rule: 'embedded_http_status_422_client_error' },
    { input: { httpStatus: 403 }, rule: 'http_status_403_client_error' },
    { input: { error: 'run_workspace_script_not_allowed: /tmp/x.sh' }, rule: 'permission_auth_pattern' },
    { input: { error: 'missing_prompt' }, rule: 'deterministic_business_pattern' },
    { input: { error: 'unsupported_reasoning_action_delete_project' }, rule: 'deterministic_business_pattern' },
    { input: { error: 'read_file_content_not_found: /a/b.txt' }, rule: 'deterministic_business_pattern' },
    { input: { error: 'left_brain_config_not_saved' }, rule: 'deterministic_business_pattern' }
  ]
  for (const { input, rule } of cases) {
    const result = classifyReasoningFailure(input)
    assert.equal(result.category, REASONING_RETRY_CATEGORY.NON_RETRYABLE, `${JSON.stringify(input)} 应分类为 non_retryable`)
    assert.equal(result.rule, rule)
  }
})

test('分类表：审核拒绝 -> needs_review；无法归类保守按 non_retryable 并记录理由', () => {
  const review = classifyReasoningFailure({ error: 'story_review_rejected: 人工审核未通过' })
  assert.equal(review.category, REASONING_RETRY_CATEGORY.NEEDS_REVIEW)
  assert.equal(review.rule, 'review_rejection')

  const unclassified = classifyReasoningFailure({ error: 'step_boom_something_weird' })
  assert.equal(unclassified.category, REASONING_RETRY_CATEGORY.NON_RETRYABLE)
  assert.equal(unclassified.rule, 'unclassified_default')
  assert.match(unclassified.reason, /保守/)

  const empty = classifyReasoningFailure({})
  assert.equal(empty.category, REASONING_RETRY_CATEGORY.NON_RETRYABLE)
  assert.equal(empty.rule, 'unclassified_default')
})

test('分类表：既有 step 结果显式 retryable 信号优先于消息模式匹配', () => {
  // 与 gameStudioServerClient.classifyRetryable 语义对齐：显式 true/false 直接生效
  const explicitTrue = classifyReasoningFailure({
    error: 'story_workflow_evaluator_failed:failedSteps=story_create_ai_project:create_ai_project_api',
    retryable: true,
    failedStage: 'create_ai_project_api',
    httpStatus: 503
  })
  assert.equal(explicitTrue.category, REASONING_RETRY_CATEGORY.RETRYABLE)
  assert.equal(explicitTrue.rule, 'explicit_retryable_signal')

  const explicitFalse = classifyReasoningFailure({
    error: 'story_workflow_evaluator_failed:failedSteps=story_write_scripts:write_scripts_api',
    retryable: false,
    failedStage: 'write_scripts_api'
  })
  assert.equal(explicitFalse.category, REASONING_RETRY_CATEGORY.NON_RETRYABLE)
  assert.equal(explicitFalse.rule, 'explicit_non_retryable_signal')

  // 审核拒绝优先于显式信号（需要人处理，不自动重试）
  const reviewWins = classifyReasoningFailure({ error: 'review_rejected_by_human', retryable: true })
  assert.equal(reviewWins.category, REASONING_RETRY_CATEGORY.NEEDS_REVIEW)
})

test('extractFailureSignals：从 session artifacts 提取显式信号（失败 lastResult / observer 失败事件）', () => {
  // story workflow 失败：session.error 是 quality gate 汇总，显式信号在 lastResult
  const storySession = {
    error: 'story_workflow_evaluator_failed:failedSteps=story_create_ai_project:create_ai_project_api',
    artifacts: {
      storyProduction: {
        lastResult: { ok: false, retryable: true, failedStage: 'create_ai_project_api', serverStatus: 503, message: 'Service Unavailable' }
      }
    }
  }
  const storySignals = extractFailureSignals(storySession)
  assert.equal(storySignals.retryable, true)
  assert.equal(storySignals.failedStage, 'create_ai_project_api')
  assert.equal(storySignals.httpStatus, 503)
  assert.match(storySignals.error, /story_workflow_evaluator_failed/)
  const storyClassified = classifyReasoningFailure(storySignals)
  assert.equal(storyClassified.category, REASONING_RETRY_CATEGORY.RETRYABLE)

  // bootstrap 失败 lastResult + observer 失败事件兜底
  const bootstrapSession = {
    error: 'step failed',
    artifacts: {
      gameStudioBootstrap: { lastResult: { ok: true } }, // 非失败不取
      gameStudioObserver: { lastEvent: { ok: false, retryable: false, failedStage: 'gamestudio_health', status: 0, error: 'missing_settings' } }
    }
  }
  const bootstrapSignals = extractFailureSignals(bootstrapSession)
  assert.equal(bootstrapSignals.retryable, false)
  assert.equal(bootstrapSignals.failedStage, 'gamestudio_health')

  // 无 artifacts：只有 error，无显式信号
  const plain = extractFailureSignals({ error: 'fetch failed' })
  assert.equal(plain.retryable, undefined)
  assert.equal(plain.httpStatus, undefined)
  assert.equal(plain.error, 'fetch failed')
  assert.equal(classifyReasoningFailure(plain).category, REASONING_RETRY_CATEGORY.RETRYABLE)

  const empty = extractFailureSignals(null)
  assert.equal(empty.error, null)
  assert.equal(empty.retryable, undefined)
})

test('cleanup：恢复 env', () => {
  restoreEnv()
  assert.equal(resolveRetryMaxAttempts(), 3)
})
