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

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by: AUTO-C01