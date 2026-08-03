# AUTO-B02：step checkpoint 与跨重启恢复

## 任务目标

让任务在 Control Server 重启、Hermes 短暂中断或单 step 失败后，从最近成功 step 继续执行。

## 前置依赖

- AUTO-A02、AUTO-B01 必须通过。

## 范围内

- step 完成后的 checkpoint 持久化。
- orphan session 扫描。
- recover 从 `nextStepIndex` 继续。
- 已完成 step 不重复执行的幂等保护。

## 必须保存

- task_id、session_id、project_id。
- step_id、step_index、nextStepIndex。
- 输入摘要和结果摘要。
- artifacts/evidence 索引。
- startedAt、completedAt、lastHeartbeat。
- 错误分类、重试次数、恢复次数。

## 必须满足

1. 每个成功 step 都写 checkpoint。
2. 进程中断后任务能明确进入 orphaned。
3. recover 只能从合法 checkpoint 开始。
4. 已确认成功的写操作不会重复破坏项目。
5. 无 checkpoint 或证据不完整时进入 BLOCKED，不猜测继续。

## 交付证据

- 模拟重启测试。
- 恢复前后的 step index。
- project evidence 对比。
- 重复执行幂等测试。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by:
