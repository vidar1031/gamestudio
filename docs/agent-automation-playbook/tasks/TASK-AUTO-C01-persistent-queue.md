# AUTO-C01：最小持久化任务队列

## 任务目标

将单 session 执行升级为持久化队列：任务可排队、领取、执行和在重启后恢复调度。

## 前置依赖

- AUTO-B04 必须完成本地验收。

## 范围内

- 队列记录、调度器/worker、领取锁、并发配置和队列事件。
- 同 projectId 串行、跨 project 全局并发上限、重启恢复。

## 范围外

- 不实现重试策略分类（AUTO-C02）。
- 不实现 Console 运维页面（AUTO-D01）。

## 必须满足

1. task 可从 `queued` 被持久化领取为 `running` 并收敛到终态。
2. 同一 projectId 默认串行，不同 project 可受全局并发数限制。
3. 一个 task 失败不会阻塞独立的后续 task。
4. 服务重启后，未终结 queue item 可恢复调度且不重复领取。
5. 三任务顺序/互斥、单任务失败隔离、重启恢复都有测试。

## 交付证据

- 队列数据格式、worker 生命周期和调度测试。
- 三任务执行顺序、并发限制、失败隔离和重启恢复输出。
- task_id/projectId/worker 关联日志。

## 交付状态

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by: AUTO-B04