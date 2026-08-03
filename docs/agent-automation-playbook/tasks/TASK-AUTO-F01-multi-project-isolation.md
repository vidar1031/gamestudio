# AUTO-F01：多项目隔离与配额

## 任务目标

确保多项目任务、队列、artifacts、日志和模型资源彼此隔离，并具有明确并发/配额规则。

## 前置依赖

- AUTO-C01、AUTO-C02、AUTO-D01、AUTO-D02 必须完成本地验收。

## 范围内

- projectId 隔离、队列并发/配额、artifact/log 路径验证和测试。

## 范围外

- 不改变 storage/projects 作为项目真相源。
- 不实现 proposal 治理（AUTO-F02）。

## 必须满足

1. 交替或并发项目任务的 task_id、projectId、artifacts 和日志无串写。
2. 项目配额/并发限制可配置且拒绝原因明确。
3. 一个项目失败、取消或阻断不污染另一个项目的任务状态。
4. 路径解析拒绝跨 workspace/project 写入。
5. 双项目并发/交替、配额拒绝、失败隔离和路径边界都有测试。

## 交付证据

- 隔离与配额实现。
- 双项目测试、artifact/log 对照和拒绝路径证据。

## 交付状态

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by: AUTO-C01, AUTO-C02, AUTO-D01, AUTO-D02