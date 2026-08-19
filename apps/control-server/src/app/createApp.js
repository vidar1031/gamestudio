import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createApiAccessBoundary } from '../server/security/apiAccessBoundary.js'
import { redactSecrets } from '../server/security/redaction.js'

export function createApp() {
  const app = new Hono()
  app.use('*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }))

  // AUTO-D02：Control API 访问边界（高风险写类 API 的来源/凭证限制 + 错误响应脱敏）。
  // 默认 localhost 模式：仅本机可访问高风险 API；CONTROL_API_ACCESS_MODE=token 时非本机需 Bearer 凭证。
  const boundary = createApiAccessBoundary()
  app.use('/api/*', boundary)
  console.log(
    `[control-server] api access boundary: mode=${boundary.config.mode}`
    + '（localhost=高风险 API 仅本机可访问；token=本机或 Bearer 凭证；open=不限制）'
    + ` token=${boundary.config.tokenConfigured ? '已配置' : '未配置'}`
  )

  // 未捕获错误统一出口：响应与日志都过脱敏，不回显 secret
  app.onError((err, c) => {
    console.error(`[control-server][ERROR] ${redactSecrets(err instanceof Error ? err.stack || err.message : String(err))}`)
    return c.json(
      { ok: false, error: 'internal_error', detail: redactSecrets(err instanceof Error ? err.message : String(err)) },
      500
    )
  })

  return app
}
