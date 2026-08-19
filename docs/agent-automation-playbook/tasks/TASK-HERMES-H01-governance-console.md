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

## 交付证据

- Console 与 API 修改列表：
  - `apps/control-server/src/server/reasoning/governanceAudit.js`（新增）：治理操作审计 JSONL（`state/governance-audit.jsonl`，`HERMES_GOVERNANCE_AUDIT_FILE` 可覆盖）；`appendGovernanceAudit` best-effort 落盘不影响受控动作结果；`readGovernanceAudit` 倒序读取、损坏行跳过计数。
  - `apps/control-server/src/server/routes/reasoningRoutes.js`：`GET /api/control/reviews/pending`（waiting_review session 集中呈现：review 详情 + 队列 item 状态 join + projectId，updatedAt 倒序）；`GET /api/control/governance/audit`（审计读取，limit ≤500）；queue 详情证据索引新增 `evidence.artifacts`（projectRoot / storyIndex / finalAnswer 预览 240 字符截断）；取消/恢复/重试/审核四个既有受控端点接入审计（成功 ok 与阻断 blocked 都留证，含 sessionId/taskId/decision；动作语义与 API 形状均未变）。
  - `apps/control-console/src/pages/GovernancePage.vue`（新增）：治理页三视图——待审核中心（批准/拒绝可附修正意见，走既有受控 review API，成功/阻断原因直接展示）、运行健康（Control/Hermes 运行时/模型服务/Studio/gateway 监督/队列概览聚合卡片 + overview alerts）、操作审计（最近 100 条，sessionId/taskId 可追溯）。
  - `apps/control-console/src/services/reasoningApi.ts`：`listPendingReviews` / `listGovernanceAudit` / `submitReasoningSessionReview` 封装；`services/controlApi.ts`：`getSupervisionState` 封装。
  - `apps/control-console/src/router/index.ts` + `layouts/ConsoleLayout.vue`：`/governance` 路由与「治理」导航项。
  - `apps/control-console/src/pages/SessionsPage.vue`：队列详情新增「产物」区块（项目目录 / 最终回答预览），对应 `evidence.artifacts`。
  - `scripts/test/governanceApi.test.mjs`（新增 10 例）、`scripts/test/smoke_governance_console.sh`（可重复 smoke）；`scripts/test/orphanRecovery.test.mjs` / `queueOperationsApi.test.mjs` harness 补 `readQueueItem` stub 与审计文件 env 隔离（recover/retry 路由新增审计调用后的接口对齐，行为断言未变）；`scripts/test/smoke_queue_operations.sh` cleanup 补审计行清理。
- 测试与回归：
  - `node --test scripts/test/governanceApi.test.mjs` 10/10（S3-05：待审核中心空/详情 join 倒序排除、artifact 证据截断；S3-06：retry/cancel/review 成功与阻断审计留证、audit 端点倒序/limit/损坏行）。
  - 全量回归 `node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs` 193/193 通过（基线 183 + 新增 10）。
  - `npm --workspace @game-studio/control-console run typecheck` 通过；`node --check` 全部改动文件通过。
- smoke 证据（`sh restart_control.sh` 后）：
  - `bash scripts/test/smoke_governance_console.sh` SMOKE PASS：待审核中心 join 一致、artifact 证据返回、非等待审核任务审核 409 阻断反馈（reasoning_session_not_waiting_review）、failed 重试 409 阻断透传（runtime_not_running）、取消成功且刷新后从待审核中心消失（服务端事实）、审计三条记录（review blocked / retry / cancel ok）含 sessionId 可追溯、生命周期 availableActions 正常、console 首页与 GovernancePage 编译 200、清理后无残留。
  - `bash scripts/test/smoke_queue_operations.sh` SMOKE PASS（D01 链路未回归）。
- 生命周期控制未回归的验证：未修改任何 start/stop/pause/resume/exit/all-restart 代码路径（git diff 可证）；smoke 第 8 步验证 `runtime-status` 仍暴露 `availableActions`。
- 文档：`ai/control_architecture.md` 同步。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: AUTO-C02, AUTO-C03, AUTO-C04, AUTO-D01, AUTO-D02
