# AUTO-D02：Control API 访问边界

## 任务目标

限制高风险 Control API 的非受信访问，同时保留明确的 localhost 开发模式并确保日志不泄露密钥。

## 前置依赖

- AUTO-C01 必须完成本地验收。

## 范围内

- API 认证/localhost 限制、中间件、配置、拒绝响应和日志脱敏测试。

## 范围外

- 不把真实 key 写入仓库或 UI。
- 不降低 review gate 或 workspace 边界。

## 必须满足

1. 非 localhost 或无有效凭证的高风险请求被拒绝。
2. localhost 开发模式由显式配置控制，默认行为可解释。
3. 合法凭证请求可访问允许的 API，不影响健康检查与既有受控开发流。
4. 错误、审计日志和 Console 响应不回显 secret。
5. 无凭证拒绝、合法访问、localhost 配置和日志脱敏均有测试。

## 交付证据

- 访问边界配置、中间件和测试。
- 拒绝/允许响应、日志脱敏输出。
- 配置说明和迁移风险。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: AUTO-C01

## 交付证据（2026-08-15）

### 实现

- 访问边界中间件：`apps/control-server/src/server/security/apiAccessBoundary.js`
  - 高风险 API 分类：`/api/` 下非 GET/HEAD/OPTIONS 请求（session create/cancel/recover/retry/review、runtime 生命周期、config/context 写入、events dispatch、maintenance、skill proposals 等写类端点全覆盖）；GET/HEAD/OPTIONS（`/api/health`、overview、queue 只读列表等）保持开放。
  - 模式由 `CONTROL_API_ACCESS_MODE` 显式控制，无效值回落 `localhost`（安全默认，行为可解释）：
    - `localhost`（默认）：高风险 API 仅本机（127.0.0.1/::1/::ffff:127.0.0.1）可访问。
    - `token`：本机免凭证；非本机需 `Authorization: Bearer <CONTROL_API_TOKEN>`（token 只从 env 读，timing-safe 比对；未配置 token 时非本机 fail-closed）。
    - `open`：不做来源限制（仅临时调试）。
  - 来源地址经 `@hono/node-server` `getConnInfo` 判定；取不到连接信息按非本机处理（安全默认）。
- 脱敏工具：`apps/control-server/src/server/security/redaction.js`（Bearer / sk- / key=value 模式 + 敏感 env 值打码）。
- 装配：`apps/control-server/src/app/createApp.js` 挂载中间件于 `/api/*`；中间件在 `next()` 后对全部 4xx/5xx JSON 响应统一脱敏（单点覆盖既有路由错误 detail，无需逐点改 catch）；全局 `onError` 返回 `{ ok:false, error:'internal_error', detail: 已脱敏 }`；启动日志输出当前模式说明。
- 配置登记：`.env.example` 新增 `CONTROL_API_ACCESS_MODE` / `CONTROL_API_TOKEN`（占位说明，无真实值）。

### 拒绝/允许响应样例

- 非本机无凭证（localhost 或 token 模式）：`403 {"ok":false,"error":"api_access_denied"}`，响应体不含任何凭证材料；审计日志 `logs/<date>/control-api-access.log` 记录 `{ event:'api_access_denied', method, path(已脱敏), remoteAddress, mode }`。
- 非本机合法凭证（token 模式）：`200` 正常进入路由。
- 本机（任意模式）：`200`，既有受控开发流不受影响。
- 拒绝响应样例（测试实测）：`{"ok":false,"error":"api_access_denied"}`；脱敏样例：`upstream failed: Authorization: Bearer ***`（token 字面量不出现）。

### 测试

- `scripts/test/apiAccessBoundary.test.mjs` 15/15（S3-07）：高风险分类、localhost 默认放行/拒绝+审计、IPv6 本机、token 合法/错误/未配置 fail-closed、本机免凭证、open 模式、无效 mode 回落、错误响应脱敏、审计日志无 secret、redactSecrets 单元、createApp 集成 onError 脱敏。
- 全量回归：`node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs` 183/183（基线 168 + 新增 15）。
- `node --check` 全部改动文件通过；未改 console（无需 typecheck）。
- 开发流：`sh restart_control.sh` 后 `bash scripts/test/smoke_queue_operations.sh` SMOKE PASS（列表/详情/取消/重试/恢复阻断透传/生命周期 availableActions 未回归）；console :8870 vite 代理链路高风险 POST 返回 404 而非 403（边界不误伤代理来源）；启动日志输出 `api access boundary: mode=localhost ... token=未配置`。

### 配置说明与迁移风险

- 默认零配置：不设置任何新 env 时行为为 `localhost` 模式，本机开发流（console → vite 代理 → control-server，均为 127.0.0.1）完全不受影响。
- 需要非本机访问高风险 API 时：设 `CONTROL_API_ACCESS_MODE=token` 并在 `.env.local`（不提交）配置 `CONTROL_API_TOKEN`，客户端带 `Authorization: Bearer <token>`。
- 迁移风险：
  - 若 control-server 未来绑定到非 127.0.0.1 网卡或被反向代理暴露，localhost 模式下非本机写请求会立即 403——这是预期行为，需显式切 token 模式并配置凭证。
  - 反向代理部署时来源地址为代理地址，当前未信任 `X-Forwarded-For`（防伪造）；如需代理后保留来源判定，需后续显式增加受控开关。
  - 全局 `onError` 将未捕获错误的 500 响应从纯文本改为 JSON（`internal_error`），既有路由均自行 catch，回归与 smoke 未见影响。
- 范围外遵守：未写入任何真实 key；review gate 与 workspace 边界未触碰；生命周期控制语义未动（仅纳入凭证边界）。