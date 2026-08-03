# HERMES-G02：supervision 401 收敛

## 任务目标

修复 supervision 的 `meta_analysis` 401；若缺少可用凭证，则显式关停定时器并记录阻断，禁止继续空转重试。

## 范围内

- supervision 定时器、401 分类、启动/停用状态、日志和测试。

## 范围外

- 不请求、读取、打印或提交真实 Kimi key。
- 不用伪造成功代替外部认证。

## 必须满足

1. 401 被归类为不可自动重试的认证阻断。
2. 无可用凭证时定时器停止调度并记录恢复条件，不再空转。
3. 可用凭证环境下不破坏正常 supervision 调度。
4. 401、显式关停、健康调度三个路径有测试或可重复运行证据。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by:
- completed_at: 2026-08-02T08:15:00.000Z

## 交付报告

### 根因

- supervision 定时器使用匿名 `setTimeout` / `setInterval`，401 失败后无法从外部关停，导致每 30 分钟空转并产生无效 session。
- 没有将 401 归类为认证阻断，也没有持久化恢复条件。

### 修改文件

- `apps/control-server/src/server/controlServerCore.js`
  - 新增模块级变量 `supervisionPostStartupTimeout`、`supervisionPeriodicTimer`、`supervisionAuthFailure`。
  - 新增 `isAuthFailureError(error)`：识别 401 / Unauthorized / 认证失败。
  - 新增 `stopSupervisionTimer(reason)`：清除定时器、写入 `supervisionAuthFailure`（含 stoppedAt、reason、recoveryHint），并记录 Hermes 日志和结构化日志。
  - 新增 `getSupervisionTimerState()`：供测试和外部读取当前定时器/阻断状态。
  - `registerPrimaryControlServerRoutes` 改为使用可管理句柄；周期性触发前检查 `supervisionAuthFailure`。
  - `triggerSupervision` 捕获 401/认证错误后调用 `stopSupervisionTimer`。

### 验证

- `node --test scripts/test/supervisionAuthGuard.test.mjs`：3/3 通过。
- `node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs`：43/43 通过。
- `node --check apps/control-server/src/index.js` / `apps/server/src/index.js`：通过。
- `npm run typecheck`：通过。

### 证据

- 测试产物：`scripts/test/supervisionAuthGuard.test.mjs`
- 代码证据：`apps/control-server/src/server/controlServerCore.js`（supervision 定时器与 401 收敛段）

### Acceptance 自检矩阵

| acceptance | test_or_assertion | result |
| --- | --- | --- |
| 401 被归类为不可自动重试的认证阻断 | `isAuthFailureError` 测试 | pass |
| 无可用凭证时定时器停止调度并记录恢复条件 | `stopSupervisionTimer` 测试 + `getSupervisionTimerState` | pass |
| 可用凭证环境下不破坏正常 supervision 调度 | `registerPrimaryControlServerRoutes` 仅在 `SUPERVISION_ENABLED === 'true'` 时启动 | pass |
| 401、显式关停、健康调度三个路径有测试或可重复运行证据 | `supervisionAuthGuard.test.mjs` 3 用例 | pass |

### 风险

- 401 恢复后需要重启 Control Server 或显式清除 `supervisionAuthFailure` 才能重新启动定时器；恢复条件已写入日志和状态，但无自动重试（符合任务要求）。
