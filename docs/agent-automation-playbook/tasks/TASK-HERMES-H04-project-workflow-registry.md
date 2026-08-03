# HERMES-H04：项目与 workflow 注册表

## 所属阶段

阶段 4：生产扩展与平台治理。对应总计划 S4-07。

## 任务目标

将项目和 workflow 从硬编码 story/bootstrap 路径抽象为受治理的注册表，使第二个项目可复用同一治理和自动运行框架，同时保持项目隔离。

## 前置依赖

- AUTO-F01、AUTO-F02 完成阶段验收。
- HERMES-H03 完成阶段验收。

## 范围内

- 项目、workflow、允许 action、输入 schema、审核策略和路由的注册表。
- 第二个项目的最小注册、隔离执行与治理验证。

## 范围外

- 注册表条目不得绕过审核或直接修改 active production rules。
- 不迁移或破坏既有 GameStudio workflow。

## 必须满足

1. 已注册项目和 workflow 才能被 Hermes/cron 选择和触发。
2. 每个 workflow 有明确输入 schema、允许 action、审核策略和证据要求。
3. 第二个项目能完成一个受控 workflow，且其 task、artifact、日志与 GameStudio 隔离。
4. 未注册项目/workflow 或跨项目路径请求被明确拒绝。
5. 通过总计划 S4-07 的测试。

## 交付状态

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by: AUTO-F01, AUTO-F02, HERMES-H03
