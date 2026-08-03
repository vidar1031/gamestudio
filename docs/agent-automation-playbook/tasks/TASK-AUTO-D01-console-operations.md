# AUTO-D01：Control Console 任务运维入口

## 任务目标

让用户在 Control Console 查看队列与任务证据，并执行取消、恢复和重试等受控运维动作。

## 前置依赖

- AUTO-C01、AUTO-C02、AUTO-C03、AUTO-C04 必须完成本地验收。

## 范围内

- 队列/task API 消费、任务列表/详情、取消/恢复/重试、证据与错误显示。
- 刷新后的状态同步和操作反馈。

## 范围外

- 不替换既有生命周期控制按钮。
- 不改变服务端授权策略（AUTO-D02）。

## 必须满足

1. 可扫描 queued/running/retry_wait/blocked/terminal task 及当前 step、原因和证据。
2. 取消、恢复、重试均调用受控 API，并显示成功、失败或阻断原因。
3. 刷新后 queue/task 状态与服务端一致。
4. start/stop/pause/resume/exit/all-restart 保持可见且语义不变。
5. 关键 UI 流程、错误展示和刷新一致性有测试或可重复 smoke 证据。

## 交付证据

- Console 与 API 修改列表。
- UI typecheck、关键操作 smoke 及状态刷新证据。
- 生命周期控制未回归的验证。

## 交付状态

- status: queued
- owner_agent:
- reviewer: project-manager-agent
- blocked_by: AUTO-C01, AUTO-C02, AUTO-C03, AUTO-C04