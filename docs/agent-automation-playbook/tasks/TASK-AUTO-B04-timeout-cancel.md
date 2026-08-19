# AUTO-B04：长任务超时、取消与资源收敛

## 任务目标

为 reasoning task 和 step 建立硬超时、取消信号和终结事件，避免模型调用或恢复流程无限悬挂。

## 前置依赖

- AUTO-B03 必须完成本地验收。

## 范围内

- task/step deadline、timeout 分类、取消传播和资源清理。
- timeout/cancel 状态事件、checkpoint 收敛和测试。

## 范围外

- 不实现持久化队列并发调度（AUTO-C01）。
- 不改变现有 start/stop/pause/resume/exit/all-restart 合同。

## 必须满足

1. 每个 task 和 step 有明确上限，超时后进入 `timeout` 或 `failed` 的既定状态语义。
2. cancel 能中止未开始与运行中的可中断工作，最终为 `cancelled`。
3. 超时或取消后不再执行后续 step，不遗留 active timer、heartbeat 或恢复锁。
4. 同一 task 重复 cancel/timeout 幂等，状态事件可追溯。
5. 模拟卡住调用、取消运行中 task、取消已终结 task 都有测试。

## 交付证据

- timeout/cancel 实现与状态转移测试。
- 模拟卡住调用的时限和最终状态。
- 资源清理、重复取消和后续 step 未执行的证据。

## 交付证据

- timeout/cancel 实现与状态转移测试：
  - 新增 `apps/control-server/src/server/reasoning/taskDeadline.js`：task/step deadline 解析（`HERMES_REASONING_TASK_TIMEOUT_MS` 默认 2h、`HERMES_REASONING_STEP_TIMEOUT_MS` 默认 30min）、取消信号 registry（首因保留、重复请求幂等）、`raceStepExecution`（deadline+取消信号竞速，timer/监听全清理，被遗弃 promise 挂空 catch）、`evaluateExecutionGate`（每步门禁：终态>取消>task 超时）、`resolveStepDeadline`（task 剩余预算更紧时 scope='task'）、`buildTimeoutTransition` / `buildCancelledTransition`（经状态机的转移构造）、`convergeSessionTermination`（注入式幂等终结收敛，写 stateTransitions 与 session 事件）。
  - `apps/control-server/src/server/controlServerCore.js`：`runAllReasoningStepsFrom` 注册取消信号 + task 预算窗口，每步前过门禁，step 执行经 race 包装；新增 `markReasoningSessionTimeout`（abort active execution 后收敛为 `timeout`）；`cancelReasoningSession` 改为先 `requestSessionCancel` 广播信号再经 `convergeSessionTermination` 收敛并立即清理注册项；failed 视为已结束幂等返回（状态机不允许 failed->cancelled，避免 500）。
  - `apps/control-console/src/pages/SessionsPage.vue`：取消按钮条件排除终态（`timeout`/`blocked`），前后端同一套控制语义。
  - 文案同步：`ai/control_architecture.md`。
- 模拟卡住调用的时限和最终状态（S2-06）：`scripts/test/taskDeadline.test.mjs` 中 stepTimeoutMs=25ms 的永不 resolve 调用在 25ms 内收敛为 `timeout`；taskTimeoutMs=60ms 场景以 scope='task' 收敛。
- 资源清理、重复取消和后续 step 未执行的证据：测试断言 executedSteps 仅含已执行 step、stateTransitions/events 仅一条、`getActiveDeadlineTimerCount()` 与 `getSessionCancelRegistrySize()` 归零、迟到 reject 无 unhandledRejection；终态重复 cancel/timeout 返回 `already_terminal` 不重复写事件。
- 测试：`node --test scripts/test/taskDeadline.test.mjs` 27/27 通过（S2-06 卡住调用 step/task 两级、S2-07 取消 queued/running/terminal、门禁兜底、重复取消幂等）。
- 回归：`node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs` 100/100 通过；`node --check` 全部改动文件通过；`npm --workspace @game-studio/control-console run typecheck` 通过。

### 关键设计取舍

- **task deadline 语义为执行预算窗口**：每次 `runAllReasoningStepsFrom` 调用起一个窗口，只约束 step 链执行；人工审核等待不计入（等待时循环已返回）；quality gate/重规划内模型调用仍由既有 `HERMES_REASONING_TASK_HARD_TIMEOUT_MS`（25min）约束；重规划后的递归执行开新窗口。
- **step 默认上限 30min ≥ 模型调用 HARD_TIMEOUT 25min**：单次模型调用卡死通常先由 HARD_TIMEOUT 以 failed 语义收敛；step deadline 是 story/gamestudio 工作流步骤等非 runManagedReasoningTask 调用的兜底。
- **取消传播两级**：`requestSessionCancel` 的 AbortSignal 让运行中的 race 立即醒来（不等 step 上限）；门禁兜底「信号先于状态收敛到达」的路径。cancel 与 timeout 收敛均幂等（updater 内对最新状态判定终态即返回），事件只写一次。
- **failed 不接受 cancel**：failed 已携带失败证据且有 retry 路径（failed->retry_wait），状态机不允许 failed->cancelled；`cancelReasoningSession` 对 failed 幂等返回当前状态，不再报错。
- **TIMEOUT 终态保持 B01 既定语义**：`validateSessionTransition` 的终态守卫先于合法表判定，timeout 不可再转移；checkpoint 不清理，`artifacts.timeoutConvergence` 记录 scope/step/nextStepIndex 供后续恢复机制使用。
- **资源收敛**：race 内部 timer 全路径清理；循环 finally 清理取消信号注册项；timeout 时 abort active execution 让协作式执行器（runManagedReasoningTask）提前释放其 hardTimeout timer，完全不响应 abort 的调用由 HARD_TIMEOUT 兜底自清；被遗弃 promise 挂空 catch 防 unhandledRejection。

### 风险

- 循环 glue（门禁调用顺序、race 参数接线）无法直接单测（controlServerCore 写死真实 state/ 目录，不能 import 进测试）；测试以 harness 镜像同一组 primitives 的相同控制流覆盖 S2-06/S2-07 语义，残余接线风险靠 code review 把控（与 B03 注入式扫描同一策略）。
- 取消/超时后被遗弃的 step promise 若完全不响应 abort（如 story 工作流 fetch），其后台 continuation 在首次 `updateReasoningSession` 写状态时会因终态转移被拒绝而停止，事件写入点之前可能仍有少量后台 I/O；全程 signal 透传留待后续任务。
- B03 遗留观察维持结论：`runAllReasoningStepsFrom` 循环仍从 `startIndex` 而非 `effectiveStartIndex` 开始。本任务评估后不改——recover 路由 startIndex 恒等 checkpoint.nextStepIndex 不受影响；重规划路径旧 checkpoint 属于旧计划，直接消费 effectiveStartIndex 会跳过新计划前序步骤；安全修复需 checkpoint↔plan 一致性校验，超出 B04 范围。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: