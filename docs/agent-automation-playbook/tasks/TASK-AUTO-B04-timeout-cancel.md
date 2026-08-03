# AUTO-B04：长任务超时、取消与资源收敛

## 任务目标

为 reasoning task 和 step 建立硬超时、取消信号和终结事件，避免模型调用或恢复流程无限悬挂。

## 前置依赖

- AUTO-B03 必须完成本地验收。

## 范围内

- task/step deadline、timeout 分类、取消传播和资源清理。
- timeout/cancel 状态事件、checkpoint 收敛和测试。

## 范围外

- 不实现持久化队列并发调度（AUTO-C01）。
- 不改变现有 start/stop/pause/resume/exit/all-restart 合同。

## 必须满足

1. 每个 task 和 step 有明确上限，超时后进入 `timeout` 或 `failed` 的既定状态语义。
2. cancel 能中止未开始与运行中的可中断工作，最终为 `cancelled`。
3. 超时或取消后不再执行后续 step，不遗留 active timer、heartbeat 或恢复锁。
4. 同一 task 重复 cancel/timeout 幂等，状态事件可追溯。
5. 模拟卡住调用、取消运行中 task、取消已终结 task 都有测试。

## 交付证据

- timeout/cancel 实现与状态转移测试。
- 模拟卡住调用的时限和最终状态。
- 资源清理、重复取消和后续 step 未执行的证据。

## 交付状态

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by: AUTO-B03