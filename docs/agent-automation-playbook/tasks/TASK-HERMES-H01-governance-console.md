# HERMES-H01：守护台治理闭环

## 所属阶段

阶段 3：长期守护与人机协作。对应总计划 S3-05、S3-06。

## 任务目标

将守护台补齐为治理入口：操作者能查看任务、步骤、审核、日志、证据与健康，并执行受控取消、恢复、重试和审核动作。

## 前置依赖

- AUTO-C02、AUTO-C03、AUTO-C04、AUTO-D01、AUTO-D02 完成阶段验收。

## 范围内

- 守护台任务/审核/健康/日志视图与受控操作。
- 服务端任务、审核、证据 API 的消费与刷新一致性。
- 审计记录与错误反馈。

## 范围外

- 不重定义任务状态机、队列或 API 认证。
- 不删除或改变现有生命周期控制语义。

## 必须满足

1. 操作者可查看 task 状态、当前 step、重试次数、审核、日志和 artifact。
2. 批准、拒绝、取消、恢复和重试均调用受控 API，且有成功、失败或阻断反馈。
3. 刷新后界面状态与服务端一致，证据可追溯 task_id/session_id。
4. start/stop/pause/resume/exit/all-restart 按原语义保留。
5. 通过总计划 S3-05、S3-06 的测试。

## 交付状态

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by: AUTO-C02, AUTO-C03, AUTO-C04, AUTO-D01, AUTO-D02
