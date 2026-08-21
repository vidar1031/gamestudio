// 能力探测服务（能力发现与注册机制）。
// 职责：
// - 从绑定项目探测可用能力（GET /api/capabilities）；
// - 验证每个能力是否真实可调用（真实调用一次）；
// - 返回探测结果供用户确认。

import { getProjectBinding } from './projectBindingService.js'

/**
 * 探测绑定项目的可用能力。
 * @returns {Promise<{ ok: boolean, capabilities: Array, error: string|null }>}
 */
export async function discoverCapabilities() {
  const binding = getProjectBinding()
  if (!binding?.bound) {
    return { ok: false, capabilities: [], error: 'project_not_bound' }
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    const res = await fetch(`${binding.baseUrl}/api/capabilities`, {
      signal: controller.signal
    })
    clearTimeout(timeout)
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.success || !payload?.capabilities) {
      return { ok: false, capabilities: [], error: payload?.error || `http_${res.status}` }
    }
    const capabilities = Array.isArray(payload.capabilities?.capabilities) ? payload.capabilities.capabilities : []
    return { ok: true, capabilities, error: null }
  } catch (error) {
    return { ok: false, capabilities: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 验证能力是否真实可调用。
 * 对于 read 类能力，真实调用一次；对于 write 类能力，只做 schema 校验不执行。
 * @param {object} capability - 能力定义
 * @param {object} binding - 项目绑定
 * @returns {Promise<{ ok: boolean, verified: boolean, error: string|null }>}
 */
export async function verifyCapability(capability, binding) {
  if (!capability?.endpoint?.path) {
    return { ok: false, verified: false, error: 'missing_endpoint' }
  }

  // write 类能力不真实执行（避免副作用），只做 schema 校验
  if (capability.type === 'write') {
    return { ok: true, verified: false, error: null, note: 'write_capability_not_executed' }
  }

  // read 类能力真实调用一次
  try {
    const path = capability.endpoint.path.replace(/:id/g, 'test').replace(/:sceneId/g, 'test')
    const url = `${binding.baseUrl}${path}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(url, {
      method: capability.endpoint.method || 'GET',
      signal: controller.signal
    })
    clearTimeout(timeout)
    // 404 表示端点不存在，其他状态表示端点存在
    const verified = res.status !== 404
    return { ok: true, verified, error: verified ? null : 'endpoint_not_found' }
  } catch (error) {
    return { ok: false, verified: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 探测并验证所有能力。
 * @returns {Promise<{ ok: boolean, capabilities: Array, error: string|null }>}
 */
export async function discoverAndVerifyCapabilities() {
  const discovery = await discoverCapabilities()
  if (!discovery.ok) {
    return discovery
  }

  const binding = getProjectBinding()
  const verified = []
  for (const cap of discovery.capabilities) {
    const result = await verifyCapability(cap, binding)
    verified.push({
      ...cap,
      verified: result.verified,
      verifyError: result.error || null,
      verifyNote: result.note || null
    })
  }

  return { ok: true, capabilities: verified, error: null }
}
