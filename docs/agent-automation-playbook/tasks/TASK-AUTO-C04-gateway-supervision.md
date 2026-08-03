# AUTO-C04：Hermes gateway 监督恢复

## 任务目标

当 Hermes gateway 异常退出时，Control 能识别原因、有限退避恢复并将不可恢复状态传播给受影响任务。

## 前置依赖

- AUTO-C01、AUTO-C02 必须完成本地验收。

## 范围内

- gateway health/exit 监测、重启退避、次数上限、事件和任务阻断传播。

## 范围外

- 不更换 gateway provider。
- 不无限重启或绕过生命周期控制。

## 必须满足

1. gateway exit 能被记录为含原因、时间和受影响 task 的事件。
2. 可恢复退出按有限退避尝试恢复，重启次数可观测。
3. 达到上限或不可恢复原因进入 `blocked`/`failed`，不无限循环。
4. 恢复成功后仅恢复合法、未取消的等待任务。
5. 模拟 exit、恢复成功、达到上限和任务状态传播都有测试。

## 交付证据

- 监督器实现、配置和事件记录。
- gateway exit 模拟与退避/上限测试输出。
- 受影响 task 的最终状态证据。

## 交付状态

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by: AUTO-C01, AUTO-C02