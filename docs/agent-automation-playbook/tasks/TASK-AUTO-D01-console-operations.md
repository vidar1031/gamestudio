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

- Console 与 API 修改列表：
  - `apps/control-server/src/server/routes/reasoningRoutes.js`：`GET /api/control/queue/items`（queue item join session 摘要：状态/当前步骤/重试次数与下次执行时间/原因/审核状态，非终态在前，损坏 item 计入 errors）、`GET /api/control/queue/items/:sessionId`（item 全量 + 证据索引：checkpoint 指针、artifacts.retryPolicy、最近 20 条事件）、`POST /api/control/agents/:agentId/reasoning-sessions/:sessionId/retry`（人工重试受控端点，仅 failed；阻断原因 409 透传）。
  - `apps/control-server/src/server/reasoning/persistentQueue.js`：新增 `resetQueueItemForManualRetry`（仅终态 item 可重置回 queued；清退避窗口、retryCount 归零、retryHistory 保留）。
  - `apps/control-server/src/server/controlServerCore.js`：路由 context 补 queue/checkpoint 只读函数与 reset 函数（纯装配，无行为变更）。
  - `apps/control-console/src/services/reasoningApi.ts`：`listReasoningQueueItems` / `getReasoningQueueItemDetail` / `retryReasoningSession` 封装。
  - `apps/control-console/src/pages/SessionsPage.vue`：新增「任务队列」区块（状态分组过滤、当前步骤/重试/原因展示、行内详情展开、取消/恢复/重试操作与结果反馈、刷新即重新拉取服务端）。
  - `scripts/test/queueOperationsApi.test.mjs`（新增 13 例）、`scripts/test/smoke_queue_operations.sh`（可重复 smoke）。
- UI typecheck、关键操作 smoke 及状态刷新证据：
  - `npm run typecheck`（editor + control-console）通过。
  - `node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs` 168/168 通过（基线 155 + 新增 13）。
  - `bash scripts/test/smoke_queue_operations.sh` 全绿：列表 join 一致、详情证据索引、缺失 item 404、取消成功且刷新后 queue item 由服务端镜像 cancelled（非本地臆测）、failed 重试与 orphaned 恢复在 runtime 停止时返回 409 阻断原因（runtime_not_running）、清理后列表无残留。
- 生命周期控制未回归的验证：未修改任何 start/stop/pause/resume/exit/all-restart 代码路径（git diff 可证）；smoke 第 7 步验证 `runtime-status` 仍暴露 `availableActions`；console 页面与 SessionsPage 编译均 200。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: AUTO-C01, AUTO-C02, AUTO-C03, AUTO-C04