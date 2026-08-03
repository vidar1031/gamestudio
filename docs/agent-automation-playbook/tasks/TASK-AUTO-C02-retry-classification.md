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

## 交付状态

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by: AUTO-C01