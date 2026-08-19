// AUTO-D02：Control API 访问边界中间件。
// 语义：
// - 高风险 API = /api/ 下的非 GET/HEAD/OPTIONS 请求（写入/删除/导出/脚本/外部调用类）；
//   GET/HEAD/OPTIONS（健康检查与只读查询）保持开放。
// - 访问模式由 CONTROL_API_ACCESS_MODE 显式控制：
//   - localhost（默认）：高风险 API 仅本机（127.0.0.1/::1）可访问，非本机一律拒绝。
//   - token：本机仍可访问；非本机需携带有效凭证 `Authorization: Bearer <CONTROL_API_TOKEN>`。
//   - open：不做来源限制（仅临时调试使用，不推荐）。
// - 拒绝响应固定为 403 + { ok:false, error:'api_access_denied' }，不回显任何凭证材料；
//   拒绝事件写入审计日志（control-api-access）。
// - 中间件在 next() 之后对 4xx/5xx JSON 响应统一过脱敏，作为单点防线，
//   避免既有/未来路由的错误 detail 夹带 secret。

import { timingSafeEqual } from 'node:crypto'
import { getConnInfo } from '@hono/node-server/conninfo'
import { writeStructuredLog } from '../utils/logger.js'
import { redactSecrets } from './redaction.js'

const LOCALHOST_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])
const VALID_MODES = new Set(['localhost', 'token', 'open'])
const DEFAULT_MODE = 'localhost'

/**
 * 判定请求是否属于高风险（写类）API。
 * @param {string} method HTTP 方法
 * @param {string} path 请求路径
 */
export function isHighRiskApiRequest(method, path) {
  if (!String(path || '').startsWith('/api/')) return false
  const normalized = String(method || '').toUpperCase()
  return normalized !== 'GET' && normalized !== 'HEAD' && normalized !== 'OPTIONS'
}

/**
 * 解析访问边界配置。无效 mode 回落到 localhost（安全默认）。
 */
export function resolveApiAccessConfig(options = {}) {
  const rawMode = String(options.mode ?? process.env.CONTROL_API_ACCESS_MODE ?? DEFAULT_MODE).trim().toLowerCase()
  const mode = VALID_MODES.has(rawMode) ? rawMode : DEFAULT_MODE
  const token = String(options.token ?? process.env.CONTROL_API_TOKEN ?? '').trim()
  return { mode, token, tokenConfigured: token.length > 0 }
}

function normalizeRemoteAddress(address) {
  return String(address || '').trim().toLowerCase()
}

function defaultGetRemoteAddress(c) {
  try {
    const info = getConnInfo(c)
    return info?.remote?.address || ''
  } catch {
    // 非 node-server 环境（如 in-process 测试）拿不到连接信息时按非本机处理（安全默认）
    return ''
  }
}

function defaultAuditLogger(record) {
  try {
    writeStructuredLog('control-api-access', 'warn', '高风险 API 访问被拒绝', record)
  } catch {
    // 审计日志写入失败不阻断拒绝响应
  }
}

function bearerTokenMatches(headerValue, token) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(headerValue || '').trim())
  if (!match) return false
  const presented = match[1]
  if (presented.length !== token.length) return false
  return timingSafeEqual(Buffer.from(presented), Buffer.from(token))
}

/**
 * 创建访问边界中间件。
 * @param {object} options
 * @param {string} [options.mode] 覆盖 CONTROL_API_ACCESS_MODE（测试用）
 * @param {string} [options.token] 覆盖 CONTROL_API_TOKEN（测试用）
 * @param {Function} [options.getRemoteAddress] 覆盖来源地址解析（测试用）：(c) => string
 * @param {Function} [options.auditLogger] 覆盖审计日志 sink（测试用）：(record) => void
 */
export function createApiAccessBoundary(options = {}) {
  const config = resolveApiAccessConfig(options)
  const getRemoteAddress = options.getRemoteAddress || defaultGetRemoteAddress
  const auditLogger = options.auditLogger || defaultAuditLogger

  const middleware = async function apiAccessBoundary(c, next) {
    if (config.mode !== 'open' && isHighRiskApiRequest(c.req.method, c.req.path)) {
      const remoteAddress = normalizeRemoteAddress(getRemoteAddress(c))
      const isLocalhost = LOCALHOST_ADDRESSES.has(remoteAddress)
      const hasValidToken = config.mode === 'token'
        && config.tokenConfigured
        && bearerTokenMatches(c.req.header('authorization'), config.token)

      if (!isLocalhost && !hasValidToken) {
        auditLogger({
          event: 'api_access_denied',
          method: String(c.req.method || '').toUpperCase(),
          path: redactSecrets(c.req.path),
          remoteAddress: remoteAddress || 'unknown',
          mode: config.mode
        })
        return c.json({ ok: false, error: 'api_access_denied' }, 403)
      }
    }

    await next()

    // 错误响应统一脱敏：任何路由返回的 4xx/5xx JSON 都不得夹带 secret
    const response = c.res
    if (response && response.status >= 400) {
      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        // text() 会消费 body，因此无论是否发生脱敏都必须重建响应
        const text = await response.text()
        const redacted = redactSecrets(text)
        const headers = new Headers(response.headers)
        headers.delete('content-length')
        c.res = new Response(redacted, { status: response.status, statusText: response.statusText, headers })
      }
    }
  }

  middleware.config = { mode: config.mode, tokenConfigured: config.tokenConfigured }
  return middleware
}
