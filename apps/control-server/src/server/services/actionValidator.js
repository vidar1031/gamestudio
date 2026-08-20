// 动作结果验证器（阶段 3：项目动作执行器）。
// 职责：
// - 根据 capability 的 outputSchema 对执行结果做结构化校验；
// - 支持自定义 validator 注册（按 capabilityId）；
// - 返回统一验证结论，供 action 状态机决定 completed / failed / need revise。

const customValidators = new Map()

/**
 * 注册自定义验证器。
 * @param {string} capabilityId
 * @param {(result: unknown, action: object) => { ok: boolean, score?: number, issues?: string[] }} validator
 */
export function registerActionValidator(capabilityId, validator) {
  if (typeof validator !== 'function') return
  customValidators.set(String(capabilityId || '').trim(), validator)
}

function validateBySchema(result, schema) {
  if (!schema || typeof schema !== 'object') {
    return { ok: true, issues: [] }
  }
  const issues = []
  if (schema.type === 'object' && (!result || typeof result !== 'object' || Array.isArray(result))) {
    issues.push('result_is_not_object')
    return { ok: false, issues }
  }
  const required = Array.isArray(schema.required) ? schema.required : []
  for (const key of required) {
    if (result[key] === undefined || result[key] === null) {
      issues.push(`missing_required_field:${key}`)
    }
  }
  return { ok: issues.length === 0, issues }
}

/**
 * 验证动作执行结果。
 * @param {object} action - action 记录
 * @param {object} capability - capability 定义
 * @param {unknown} result - 执行结果
 * @returns {{ ok: boolean, score: number, issues: string[], validatedAt: string }}
 */
export function validateActionResult(action, capability, result) {
  const capabilityId = String(action?.capabilityId || capability?.id || '').trim()
  const custom = customValidators.get(capabilityId)
  if (custom) {
    try {
      const outcome = custom(result, action)
      return {
        ok: Boolean(outcome?.ok),
        score: Number(outcome?.score) || (outcome?.ok ? 100 : 0),
        issues: Array.isArray(outcome?.issues) ? outcome.issues : [],
        validatedAt: new Date().toISOString()
      }
    } catch (error) {
      return {
        ok: false,
        score: 0,
        issues: [`custom_validator_error:${error instanceof Error ? error.message : String(error)}`],
        validatedAt: new Date().toISOString()
      }
    }
  }

  const schema = capability?.outputSchema
  const outcome = validateBySchema(result, schema)
  return {
    ok: outcome.ok,
    score: outcome.ok ? 100 : 0,
    issues: outcome.issues,
    validatedAt: new Date().toISOString()
  }
}
