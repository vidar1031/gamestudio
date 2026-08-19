# AUTO-C01：最小持久化任务队列

## 任务目标

将单 session 执行升级为持久化队列：任务可排队、领取、执行和在重启后恢复调度。

## 前置依赖

- AUTO-B04 必须完成本地验收。

## 范围内

- 队列记录、调度器/worker、领取锁、并发配置和队列事件。
- 同 projectId 串行、跨 project 全局并发上限、重启恢复。

## 范围外

- 不实现重试策略分类（AUTO-C02）。
- 不实现 Console 运维页面（AUTO-D01）。

## 必须满足

1. task 可从 `queued` 被持久化领取为 `running` 并收敛到终态。
2. 同一 projectId 默认串行，不同 project 可受全局并发数限制。
3. 一个 task 失败不会阻塞独立的后续 task。
4. 服务重启后，未终结 queue item 可恢复调度且不重复领取。
5. 三任务顺序/互斥、单任务失败隔离、重启恢复都有测试。

## 交付证据

- 队列数据格式、worker 生命周期和调度测试：
  - 新增 `apps/control-server/src/server/reasoning/persistentQueue.js`：queue item 持久化（`state/reasoning-queue/<sessionId>.json`，`HERMES_REASONING_QUEUE_DIR` 可覆盖，tmp+rename 原子写）；item 含 taskId（与 sessionId 同源）/sessionId/projectId/状态（queued/claimed/running/终态镜像 session 状态机 + waiting_review 释放态）/claim（workerId、claimedAt、单调递增 claimGeneration）/attempts/recoveryCount/resumeFromStep/创建与更新时间/history（上限 30 条）；`claimQueueItem` 仅 queued 可领取（同步 fs，进程内 check-write 不交错）；`selectClaimableQueueItems` 纯函数（FIFO + 同 project 串行 + 全局并发上限）；`recoverPersistentQueueOnStartup`（注入式启动恢复）；`createReasoningQueueWorker`（依赖全注入：reconcile/镜像/领取三段 tick + kick + 心跳扫描定时器）。
  - `apps/control-server/src/server/controlServerCore.js`：`buildReasoningStartBlocker` 上提为 core 单一事实源（routes 与 worker canExecute 共用）；`dispatchReasoningSession`（入队 + kick，幂等）；`executeReasoningQueueItem`（fresh 走 `runReasoningSession`，恢复 item 从 `resumeFromStep` 走 `runAllReasoningStepsFrom`，均含 B04 deadline/cancel）；worker 单例 + `startReasoningQueueWorker`/`stopReasoningQueueWorker`；`cleanupOrphanedReasoningSessions` 改为「先队列恢复、再 orphan 扫描（skip 队列管理 session）」。
  - `apps/control-server/src/server/routes/reasoningRoutes.js`：创建路径改为 `dispatchReasoningSession`（API 形状不变）；`projectId` 透传进 submissionContext；本地 `buildReasoningStartBlocker` 移除改由 context 注入。
  - `apps/control-server/src/index.js`：启动序列 = orphan 清理（含队列恢复）-> `startReasoningQueueWorker()`。
  - `orphanRecovery.js`：`scanAndConvergeOrphanedSessions` 新增可选 `skipSessionIds`（队列管理的 session 跳过，queued 等待不被误判 orphan->blocked；summary 增加 `queueManagedSkipped`）。
  - B03 遗留覆盖：worker 周期挂心跳过期扫描（`HERMES_REASONING_QUEUE_HEARTBEAT_SCAN_INTERVAL_MS` 默认 60s，<=0 关闭），跳过队列管理的 session。
- 三任务执行顺序、并发限制、失败隔离和重启恢复输出（`scripts/test/persistentQueue.test.mjs` 11/11 通过）：
  - S2-08：t1(projA)/t2(projA)/t3(projB) 三任务，maxConcurrency=2——t1 与 t3 执行窗口重叠（跨 project 并发 2），t2.start >= t1.end（同 project 串行）；item 全部收敛 completed，claim 含 workerId/claimGeneration/attempts。
  - S2-09：maxConcurrency=1 下同 project 前序任务 failed 后后续任务仍被领取并完成（f2.start >= f1.end）；执行链未自捕获的异常由 worker 兜底终结为 failed（queue_execute_rejected）并释放槽位。
  - S2-10：重启前新 worker 不偷取死 worker 的 claim；恢复后 a（queued 未开始）保持 queued、b（running+checkpoint）收敛 orphaned 后重排队（resumeFromStep=checkpoint.nextStepIndex=1）、c（无 checkpoint）session/item 双 blocked、d（waiting_review）释放不自动重排队、e（cancelled）镜像终结、g（session 缺失）blocked；orphan 扫描跳过队列管理 session（queueManagedSkipped>=5），遗留无 item 的 queued session 仍按 B03 语义收敛 blocked；恢复后 a/b 各被领取恰好一次（b 的 claimGeneration 1->2 单调递增），c/d/e 零执行。
- task_id/projectId/worker 关联日志：队列事件挂 session 事件流（queue_enqueued/queue_claimed/queue_finished/queue_waiting_review/queue_requeued），data 均含 taskId、projectId、workerId、claimGeneration、attempt；`appendHermesLog` 写 `[REASONING][QUEUE][ENQUEUE|CLAIM]` 行。

### 关键设计取舍

- **执行链零改动复用**：worker 领取后走既有 `runReasoningSession` / `runAllReasoningStepsFrom`（含 B02 checkpoint、B04 deadline/cancel、quality gate），队列只管调度与槽位；item 终态镜像 session 状态机，tick reconcile 以 session 文件为事实源（含 quality gate 重规划派生的后台继续执行，slot 持有到 session 终态）。
- **waiting_review 释放槽位**：人工审核等待不占 project 槽位（人可能永远不审，占用即同 project 死锁）；审核后的继续执行由既有 review/recover 路由人工驱动、不入队——生产任务（productionTest/auto 模式）无 waiting_review，不受影响；manual 模式本就有人的串行判断在环。
- **手动 recover（B03）不入队**：recover 是人工异常处理入口，人在环且路由有 orphanRecoveryInFlight 幂等保护；若排队可能被同 project 任务延后，违背人工优先的运维直觉。自动重启恢复则必须走队列（否则违背串行承诺）。
- **默认全局并发 2**：reasoning 任务 plan/step 都打本地模型（OMLX），更高并发容易打爆本地模型触发 hard timeout；2 允许跨 project 并行又限制模型压力。`HERMES_REASONING_QUEUE_MAX_CONCURRENCY` 可覆盖。
- **projectId 缺失按 sessionId 独立**：无 project 的问答/分析类任务互不阻塞，仅受全局并发上限约束；story 生产任务创建时 projectId 尚未生成，同样按 session 独立（project 在步骤内创建，同 project 冲突由后续 C02/D01 语义补强）。
- **重启恢复先队列后 orphan 扫描**：队列恢复内部复用 B03 同一组 orphan 原语（buildOrphanedTransition/evaluateOrphanRecovery/buildOrphanBlockedTransition）收敛队列管理的 session；orphan 扫描经 skipSessionIds 跳过它们——queued 等待中的 session 不是孤儿，避免被误判 blocked。
- **审核门禁不可绕过**：重启时处于（或刚从 waiting_review 收敛为 orphaned 的）session 不自动重排队，item 释放为 waiting_review，必须走 B03 人工 recover。
- **模型未就绪不领取**：worker canExecute 复用发起门禁（runtime running + 配置/模型/自检就绪），未就绪时任务保持 queued 等待，不把可恢复任务打成 failed。

### 风险

- 循环 glue（dispatch/execute/reconcile 接线）无法直接单测（controlServerCore 写死真实 state/ 目录，不能 import 进测试）；测试以注入式 worker/恢复原语 + Hono 路由 harness 覆盖 S2-08/09/10 语义，残余接线风险靠 code review 与启动冒烟（`sh restart_control.sh` 后健康检查通过、日志无异常）把控——与 B03/B04 同一策略。
- waiting_review 释放后，人工 approve 的继续执行与后续同 project 任务理论上可短暂并行（manual 模式已有此现象，非本任务引入）；生产任务走 auto 模式无此路径。
- 队列 item 文件保留终结记录（证据），清理归 AUTO-C03 保留策略范围。
- supervision session（默认关闭）自建 plan 直接执行，不入队，重启时按既有 B03 语义收敛，行为不变。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: