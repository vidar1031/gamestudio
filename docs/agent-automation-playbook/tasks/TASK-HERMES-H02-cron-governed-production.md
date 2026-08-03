# HERMES-H02：cron 受控生产触发

## 所属阶段

阶段 3：长期守护与人机协作。对应总计划 S3-08、S3-09。

## 任务目标

将 Hermes cron 接入治理层：定时任务只能通过受控 API 创建已注册工作流的生产任务，守护台可观察、暂停和审计其全过程。

## 前置依赖

- HERMES-H01 完成阶段验收。
- 阶段 1 真实 P0 生产回归通过。

## 范围内

- cron job 定义、受控触发适配器、工作流白名单、任务关联和审计。
- 守护台对 cron job、触发记录和结果的可见性。

## 范围外

- cron 不直接写 `storage/projects`。
- cron 不得自行批准高风险写入、proposal 或越权 action。

## 必须满足

1. cron 只能提交已注册、被允许的 workflow；未注册 action 被拒绝并审计。
2. 每次触发都创建可追溯 task/session，而非匿名模型调用。
3. cron 触发真实 P0 任务后，守护台显示计划、步骤、审核、日志、产物和最终 verdict。
4. cron 可被治理层暂停、恢复或停用；重复触发符合幂等/去重规则。
5. 通过总计划 S3-08、S3-09 的测试。

## 交付状态

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by: HERMES-H01
