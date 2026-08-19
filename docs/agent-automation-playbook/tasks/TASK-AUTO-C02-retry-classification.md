# AUTO-C02：重试与错误分类

## 任务目标

让队列按确定性错误分类执行有限重试，避免网络瞬断导致无谓失败，也避免 schema/业务错误被盲目重跑。

## 前置依赖

- AUTO-C01 必须完成本地验收。

## 范围内

- `retryable`、`non_retryable`、`needs_review`、`blocked` 分类与重试元数据。
- 指数退避、最大次数、重试事件和终态收敛。

## 范围外

- 不重构模型 provider。
- 不实现 Console 重试交互（AUTO-D01）。

## 必须满足

1. 网络/503 等临时故障进入 `retry_wait` 并在上限内按退避重试。
2. schema、权限和确定性业务错误不得重试，进入 `failed` 或 `blocked`。
3. 达到重试上限后稳定进入 `failed`，且记录每次原因与时间。
4. cancel 后不得重新调度 retry_wait task。
5. 临时故障成功恢复、非重试错误、达到上限和取消路径均有测试。

## 交付证据

- 错误分类表和重试调度实现。
- 退避、上限、非重试与取消测试输出。
- retry_count/last_error/next_attempt_at 记录样例。

## 交付证据

- 错误分类表（`apps/control-server/src/server/reasoning/retryPolicy.js`，确定性规则、首条命中、每条带 rule/reason 可追溯）：
  1. 审核拒绝/人工审核未通过模式 -> `needs_review`（收敛 blocked，需人工处理）；
  2. 既有 step 结果显式信号（`storyProduction/gameStudioBootstrap` 失败 lastResult、gameStudioObserver 失败事件的 `retryable` 布尔）-> 直接生效（与 `gameStudioServerClient.classifyRetryable` 语义对齐，不另造一套）；
  3. 显式 HTTP status：408/429/5xx -> `retryable`，其余 4xx -> `non_retryable`；
  4. 错误文本内嵌状态码（`http_503`/`HTTP 503`/`model_task_http_503_...`）-> 同上分类；
  5. 网络/临时模式（ECONNRESET/ECONNREFUSED/ETIMEDOUT/fetch failed/socket hang up/request_timeout/hard timeout/限流/过载）-> `retryable`；
  6. schema/数据校验模式 -> `non_retryable`；7. 权限/认证模式（含 `not_allowed`）-> `non_retryable`；
  8. 确定性业务模式（missing_/unsupported_/not_found/invalid_ 等）-> `non_retryable`；
  9. 无法归类 -> 保守 `non_retryable`（rule=unclassified_default，记录理由）。
- 重试调度实现：
  - `retryPolicy.js`：`classifyReasoningFailure` / `extractFailureSignals` / `computeRetryBackoffMs`（指数退避 base*2^(n-1) 封顶）/ env 解析（`HERMES_REASONING_RETRY_MAX_ATTEMPTS` 默认 3，`HERMES_REASONING_RETRY_BASE_MS` 默认 30000，`HERMES_REASONING_RETRY_MAX_DELAY_MS` 默认 300000）。
  - `persistentQueue.js`：item 新增 `retryCount`/`nextAttemptAt`/`retryHistory`（上限 30 条）；`claimQueueItem` 领取即清空 `nextAttemptAt`；`selectClaimableQueueItems` 排除未到点 item（`nowMs` 参数）；worker 新增 `settleHeldItemFailure`——拦截 session failed 与 execute 兜底两处终结点：retryable 未达上限 -> item 回 queued 落 `nextAttemptAt` + session `failed -> retry_wait`（`queue_retry_scheduled` 事件 + stateTransitions + `artifacts.retryPolicy` 镜像）；达上限 -> 稳定 `failed`（`queue_retry_exhausted` 事件，item history reason=`queue_retry_exhausted`，`artifacts.retryPolicy.exhausted`）；`needs_review`/`blocked` -> session `failed -> blocked` + item blocked（`queue_blocked_needs_review` 事件）；`non_retryable` -> 按原语义终结 failed（reason/lastError 透传，不覆盖 C01 行为）；重启恢复保留 retry_wait 重试计划（queued 保持、claimed/running 重置回 queued，retryCount/nextAttemptAt/retryHistory 不丢、不消耗 recoveryCount）。
  - `sessionStateMachine.js`：补 `failed -> blocked` 合法转移。
  - `controlServerCore.js`：worker 注入 `updateSession: updateReasoningSession` 与重试参数；retry_wait 被重新领取后走 `runReasoningSession` 全量重跑（失败时 checkpoint 已清理、plan 幂等），execute 链零改动。
- 退避、上限、非重试与取消测试输出：
  - `node --test scripts/test/retryPolicy.test.mjs` 8/8 通过：分类表（临时/非重试/审核/保守默认）、显式信号优先、退避递增封顶、env 解析、extractFailureSignals。
  - `node --test scripts/test/queueRetry.test.mjs` 7/7 通过：
    - S3-01：503（显式 retryable 信号）-> retry_wait（退避窗口=baseMs 精确断言），未到点不领取，到点重试恢复成功（executed=2，item completed，retryCount=1）；schema/403 各执行 1 次直接 failed（retryHistory 为空、无 retry 事件）；审核拒绝 -> session/item 双 blocked。
    - S3-02：ECONNREFUSED 持续失败，maxAttempts=2 -> 共执行 3 次后稳定 failed（retryHistory 2 条含 attempt/backoffMs 20->40/scheduledAt/nextAttemptAt/error，`queue_retry_exhausted` 事件，session `artifacts.retryPolicy.exhausted=true`）；retry_wait 等待中取消 -> item 镜像 cancelled 终结，150ms（数倍退避窗口）内零重新领取。
    - 重启恢复：retry_wait + queued item 保持不动；retry_wait + running item（stale claim）重置回 queued 且 retryCount=2/nextAttemptAt/retryHistory 全保留、recoveryCount=0。
  - 全量回归：`node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs` 126/126 通过（基线 111 + 新增 15）；`node --check` 全部改动文件通过；`sh restart_control.sh` 启动冒烟健康检查通过、日志无异常。
- retry_count/last_error/next_attempt_at 记录样例（S3-02 上限用例实际落盘）：

```json
{
  "status": "failed",
  "attempts": 3,
  "retryCount": 2,
  "nextAttemptAt": null,
  "lastError": "connect ECONNREFUSED 127.0.0.1:18888",
  "retryHistory": [
    { "attempt": 1, "scheduledAt": "2026-08-15T04:40:00.000Z", "nextAttemptAt": "2026-08-15T04:40:00.020Z", "backoffMs": 20, "category": "retryable", "rule": "transient_network_pattern", "reason": "错误文本命中网络/临时故障模式（连接错误/超时/限流/过载），可按退避重试。", "error": "connect ECONNREFUSED 127.0.0.1:18888" },
    { "attempt": 2, "scheduledAt": "2026-08-15T04:40:00.040Z", "nextAttemptAt": "2026-08-15T04:40:00.080Z", "backoffMs": 40, "category": "retryable", "rule": "transient_network_pattern", "reason": "同上", "error": "connect ECONNREFUSED 127.0.0.1:18888" }
  ]
}
```

### 关键设计取舍

- **分类信号对齐既有一套**：显式 `retryable`/`failedStage`/`serverStatus` 直接来自 story/gamestudio workflow 步骤结果与 observer 事件（`gameStudioServerClient.classifyRetryable` 同源语义），消息模式表只兜无信号路径（plan/模型调用/抛错型 step）；无法归类保守按 non_retryable，不盲目重跑可能有副作用的任务。
- **重试=全量重跑**：失败时 `markReasoningSessionFailed` 已清理 checkpoint，retry_wait 重新领取后走 `runReasoningSession` 重新 plan（C01 已确立 plan 幂等无副作用）；不做 checkpoint 续跑，避免与 B02/B03 恢复语义交叉。代价是已成功 step 会重跑一轮，由 maxAttempts=3 上限与退避控制成本。
- **调度挂在 worker reconcile 而非执行链**：session failed 由 tick 第 1 段统一分类收敛，execute 链（B02/B04/quality gate）零改动；执行链未自捕获的兜底异常（queue_execute_rejected）也过同一分类，但仅在 session 确在 failed 时才调度重试，并发取消/推进时不抢状态。
- **cancel 零特判**：retry_wait 等待中的 item 是 queued 态，session 取消后由既有 tick 第 2 段镜像终结 cancelled（镜像先于领取执行），调度器天然不再领取；测试以数倍退避窗口断言零重新调度。
- **审核类走 blocked 而非 failed**：状态机补 `failed -> blocked` 单条转移，人工处理入口（B03 recover 语义）不被重试绕过；非重试错误保持 failed（C01 行为不变，failed 本有人工 retry 路径）。
- **重启保留重试计划**：retry_wait 不收敛 orphan（item 本就 queued，不是孤儿），stale claim 仅重置不消耗 recoveryCount 预算；nextAttemptAt 跨重启继续生效（过期即到点可领）。

### 风险

- 循环 glue（worker 注入 updateSession、retry_wait 重跑走 runReasoningSession）无法直接单测（controlServerCore 写死真实 state/ 目录）；测试以注入式 worker + 临时目录 session store 覆盖全部调度语义，残余接线风险靠 code review 与启动冒烟把控——与 C01 同一策略。
- 全量重跑会重复执行已成功 step（如已创建的项目会走 create 接口幂等返回）；副作用大的 step 本有审核门禁与 productionTest 语义，重试不改变其审核行为。
- 重试期间 session 处于 retry_wait 非终态，Console 会话页若按状态过滤需能识别（D01 运维入口范围）；当前 UI 未做新状态特化展示，不影响 API 语义。
- queue item 文件持续累积 retryHistory/终结记录，清理归 AUTO-C03 保留策略范围。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: