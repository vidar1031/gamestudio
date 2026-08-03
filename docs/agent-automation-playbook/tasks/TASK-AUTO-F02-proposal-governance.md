# AUTO-F02：proposal 测试、审核、晋级与回滚

## 任务目标

确保 `_inbox` proposal 只能作为候选，经测试和人工审核后才可激活，并可安全回滚且保留规则版本记录。

## 前置依赖

- AUTO-D02、AUTO-F01 必须完成本地验收。

## 范围内

- proposal 生命周期、测试门禁、人工审核、激活、版本记录和回滚。

## 范围外

- 模型不得自行将 proposal 升级为 active intent/workflow/evaluator。
- 不删除历史规则或审计记录。

## 必须满足

1. `_inbox` proposal 默认不可执行、不可自动影响生产 routing、workflow 或 evaluator。
2. proposal 必须通过规定测试并获得人工审核，才可激活。
3. 激活失败可回滚到已知版本，旧规则仍可追溯。
4. 每次审核、激活和回滚有 actor、时间、版本与证据记录。
5. 自动晋级拒绝、审核后激活、失败回滚和版本保留均有测试。

## 交付证据

- proposal 生命周期实现、权限边界和版本记录。
- 自动晋级拒绝、审核激活、失败回滚测试输出。
- 最终 campaign 的任务状态与证据索引。

## 交付状态

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by: AUTO-D02, AUTO-F01