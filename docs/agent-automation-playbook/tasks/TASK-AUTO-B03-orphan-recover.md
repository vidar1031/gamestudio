# AUTO-B03：orphan 扫描与恢复收敛

## 任务目标

Control Server 启动时识别未终结 session，将其收敛为可恢复的 `orphaned` 或不可恢复的 `blocked`，并能从 B02 checkpoint 的合法位置恢复。

## 前置依赖

- AUTO-A02、AUTO-B01、AUTO-B02 必须完成本地验收。

## 范围内

- 启动/扫描入口、orphan 判定规则和状态事件。
- 基于既有 checkpoint 的恢复资格、恢复次数和原因记录。
- 恢复 API/服务的错误语义与回归测试。

## 范围外

- 不重写 B02 checkpoint 持久化格式。
- 不实现队列调度（AUTO-C01）。
- 不修改生命周期控制语义。

## 必须满足

1. 重启或心跳过期的非终结 session 进入 `orphaned`，并记录判定原因。
2. 证据完整的 orphan 仅从 `nextStepIndex` 恢复，已成功 step 不重跑。
3. checkpoint 缺失、损坏或恢复次数超限时进入 `blocked`，不猜测继续。
4. 已终结 session 不会被扫描为 orphan。
5. 模拟重启、可恢复、不可恢复和重复恢复路径都有测试。

## 建议执行顺序

1. 读取 B01 状态机、B02 checkpoint、现有 orphan/recover 路由及相邻测试。
2. 定义可恢复与阻断的确定性判定函数。
3. 接入启动扫描和 recover 服务，记录 task/session 证据。
4. 先跑模拟重启测试，再跑受影响的控制服务测试。

## 交付证据

- orphan 判定与恢复实现：
  - 新增 `apps/control-server/src/server/reasoning/orphanRecovery.js`：`determineOrphanReason`（重启/心跳过期判定）、`evaluateOrphanRecovery`（恢复资格：checkpoint 缺失/损坏/恢复次数超限）、`buildOrphanedTransition` / `buildOrphanBlockedTransition`（经状态机的转移构造）、`scanAndConvergeOrphanedSessions`（注入式扫描编排）。
  - `apps/control-server/src/server/reasoning/sessionStateMachine.js`：补 `queued -> orphaned`、`pausing -> orphaned` 合法转移。
  - `apps/control-server/src/server/controlServerCore.js` `cleanupOrphanedReasoningSessions()`：启动扫描改为经状态机收敛（非终结 active -> `orphaned` 记录原因；资格不足 -> `blocked` 记录原因），终态与 failed 不触碰。
  - `apps/control-server/src/server/routes/reasoningRoutes.js` recover 路由：仅接受 `orphaned`；资格不足转 blocked 返回 409+原因；仅从 checkpoint 的 `nextStepIndex` 恢复（客户端指定其他 stepIndex 返回 409 `step_index_not_allowed`）；in-flight 集合保证重复恢复幂等。
  - `apps/control-console/src/pages/SessionsPage.vue`：恢复按钮条件由 `failed` 同步为 `orphaned`（前后端同一套控制语义）。
  - 文案同步：`apps/control-server/src/server/workflows/projectStatusWorkflows.js`、`ai/control_architecture.md`。
- 测试：`node --test scripts/test/orphanRecovery.test.mjs` 30/30 通过，覆盖模拟重启扫描（orphaned/blocked/终态跳过/failed 跳过/已 orphaned 幂等/双目录去重/旧隐式状态归一）、恢复资格（缺失/JSON 损坏/结构非法/双侧恢复次数超限）、recover 路由（仅从 nextStepIndex 恢复、非法 stepIndex 409、不可恢复转 blocked、重复恢复幂等不重复执行）。
- 回归：`scripts/test/sessionStateMachine.test.mjs`、`stepCheckpoint.test.mjs`、`orphanRecovery.test.mjs` 合计 50/50 通过；`supervisionAuthGuard`、`memoryGarbageRejection`、`qualityGateEvaluatorFalsePass` 11/11 通过；`node --check apps/control-server/src/index.js` 等全部改动文件通过；`npm --workspace @game-studio/control-console run typecheck` 通过。
- session 状态事件证据：orphan 收敛写入 `stateTransitions`（含 from/to/reason）与 `session_orphaned` / `session_orphan_blocked` / `session_recovered` 事件，阻断原因落在 `artifacts.orphanBlockedReason` 与 `error`。

### 关键设计取舍

- `failed` 不转 orphan：failed 已携带失败证据且有 retry 路径（failed -> retry_wait），orphan 语义仅限"被进程中断"。
- 旧的「failed + orphaned by server restart」恢复语义废弃，由 `orphaned` 状态替代；历史遗留的此类 session 保持 failed，不再经 recover 路由恢复。
- 最新 checkpoint 损坏时不回退到更早 checkpoint（无法证明其间 step 未成功执行），直接 blocked，不猜测继续。
- 恢复次数取 session 侧 `artifacts.checkpointRecoveryCount` 与 checkpoint 侧 `recoveryCount` 的较大值；上限由 `HERMES_REASONING_MAX_RECOVERY_COUNT` 控制，默认 3。
- 心跳判定：session 有心跳证据（artifacts.lastHeartbeatAt / lastHeartbeatAt / updatedAt）且超过 `HERMES_REASONING_ORPHAN_HEARTBEAT_TIMEOUT_MS`（默认 60s）判定 `heartbeat_expired`；无证据不猜测。启动扫描一律以 `server_restart` 判定。

### 风险

- `runAllReasoningStepsFrom` 内部的 checkpoint 恢复分支使用 `effectiveStartIndex`，但其执行循环仍从 `startIndex` 开始（B02 既有行为）。B03 的 recover 路由传入的 startIndex 恒等于 checkpoint.nextStepIndex，该分支对 orphan 恢复路径无影响；其他调用路径（如重规划后从 0 开始）是否应消费 effectiveStartIndex 留给后续任务确认。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: