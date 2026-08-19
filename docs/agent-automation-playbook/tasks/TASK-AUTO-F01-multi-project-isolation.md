# AUTO-F01：多项目隔离与配额

## 任务目标

确保多项目任务、队列、artifacts、日志和模型资源彼此隔离，并具有明确并发/配额规则。

## 前置依赖

- AUTO-C01、AUTO-C02、AUTO-D01、AUTO-D02 必须完成本地验收。

## 范围内

- projectId 隔离、队列并发/配额、artifact/log 路径验证和测试。

## 范围外

- 不改变 storage/projects 作为项目真相源。
- 不实现 proposal 治理（AUTO-F02）。

## 必须满足

1. 交替或并发项目任务的 task_id、projectId、artifacts 和日志无串写。
2. 项目配额/并发限制可配置且拒绝原因明确。
3. 一个项目失败、取消或阻断不污染另一个项目的任务状态。
4. 路径解析拒绝跨 workspace/project 写入。
5. 双项目并发/交替、配额拒绝、失败隔离和路径边界都有测试。

## 交付证据

- 隔离与配额实现。
- 双项目测试、artifact/log 对照和拒绝路径证据。

## 交付记录（kimi-code，2026-08-15）

### 实现

1. **隔离审计结论**（串写风险盘点）：
   - queue item/session artifacts/queue 事件/worker 文本日志均按 sessionId 分载体、projectId 已透传（C01），无共享文件串写；
   - 风险点 1（C01 遗留窗口）：story session 创建时项目未生成，item 以 `projectId=null` 入队按 session 键独立调度，同 project 冲突与配额统计均不可识别 → 本任务以 projectId 回写关闭；
   - 风险点 2：治理审计（H01）与 cron 触发记录（H02）无 projectId 字段，无法按项目对照 → 已补；
   - 风险点 3：apps/server `projectDir(id)` 对 `:id` 无路径穿越校验 → 已加项目根边界中间件。
2. **projectId 回写**（`persistentQueue.backfillQueueItemProjectId` + `controlServerCore.updateStoryWorkflowArtifacts` 接线）：story workflow 步骤成功（`result.ok` 且 projectId 非空）定位/创建项目后，回写 session `submissionContext.projectId` 与 item.projectId（已有值/终态不覆盖，history 留 `project_id_backfilled`，事件流留 `queue_project_id_backfilled`）。仅成功结果回写——失败结果的项目归属未被证实不绑定；`resolveStoryProjectId` 的全局指针 fallback 保持不变（兼容既有「继续最新项目」行为），回写后 session artifacts 优先于全局指针，任务始终绑定自己操作的项目。
3. **每项目在制配额**：`HERMES_REASONING_MAX_TASKS_PER_PROJECT`（默认 1，与同 project 串行对齐）。`evaluateProjectQuota` 纯函数（queued/claimed/running 计入；waiting_review/终态已释放槽位不计入，避免人工不审占配额死锁）。两道门禁：HTTP 提交前置校验同步 429 `project_quota_exceeded`（响应带 limit/activeCount/activeSessionIds + 治理审计 `session_submit` blocked）；`dispatchReasoningSession` 兜底（超限不入队，session `queued -> blocked` 留 `queue_quota_rejected` 事件 + 审计 + hermes log；幂等入队/人工重试/C02 重试调度/子目标 session 不受配额阻断，不扼杀恢复路径）。cron 触发命中配额记 `blocked_quota` 触发记录 + 审计。全局并发上限 `HERMES_REASONING_QUEUE_MAX_CONCURRENCY` 保持不变。
4. **失败隔离**：item 终结/重试/阻断全部按 sessionId 粒度落盘，active 槽位按 sessionId 持有；一个项目的 failed/blocked/cancelled 不进入另一项目的调度判定（双项目对照测试证据，见下）。
5. **路径边界**：apps/server 新增 `/api/projects/:id` 与 `/api/projects/:id/*` 中间件——`:id`（含 URL 解码后形态）解析越出 `PROJECTS_DIR` 一律 400 `invalid_project_id`（纯 `%2e%2e` 在 URL 规范化阶段已被点段消解到不了路由，`..%2f` 等到达路由的穿越形态由中间件拒绝）；跨 project 相对路径参数由 E01 `verifyStoryAssetReferenceFile` 拒绝（`reference_path_outside_project`，目标文件真实存在也拒绝）；control 侧 `getStoryProjectDir` 越界返回空，按项目目录不可用处理，不猜测不越权读写。
6. **日志/审计按项目对照**：`governanceAudit` 记录新增 `projectId` 字段（取消/恢复/重试/审核/session_submit/cron 各调用点透传）；cron job 支持可选 `projectId`（持久化、透传 submissionContext、触发记录与审计带 projectId）；queue 事件与 worker 日志此前已带 projectId（C01），双项目测试逐条对照。

### 测试（S4-04 / S4-05 全覆盖）

`scripts/test/multiProjectIsolation.test.mjs` **10/10 通过**：

- S4-04 双项目并发：worker maxConcurrency=2 下两项目任务真实并发（maxRunning=2），task_id/projectId/session artifacts/queue 事件/worker CLAIM 日志逐项对照无串写。
- S4-04 同项目交替串行：同 project 第二任务在首任务终结前保持 queued；跨 project 任务不被另一项目占用阻塞，终结另一项目任务不释放本项目串行约束。
- S4-04 配额判定：在制计数/排除自身/waiting_review 与终态不计入/显式与 env（`HERMES_REASONING_MAX_TASKS_PER_PROJECT`）上限可配置。
- S4-04 配额拒绝（拒绝路径样例）：`POST /api/control/agents/hermes-manager/reasoning-sessions` 同项目在制 1/1 时 → **429 `project_quota_exceeded`**，body 带 `limit/activeCount/activeSessionIds`，不创建 session 不入队，审计 `session_submit` blocked；不同 projectId 正常 200。
- S4-04 cron：job projectId 持久化并透传 submissionContext；配额阻断记 `blocked_quota` + 审计 blocked；正常提交审计带 projectId。
- S4-05 失败隔离：三对项目（failed/blocked/cancelled vs 正常）同 worker 并发，A 侧按自身语义终结、B 侧 completed 且 artifacts/事件零污染。
- S4-05 路径边界（拒绝路径样例）：`PUT /api/projects/..%2fproj_victim/scripts` → **400 `invalid_project_id`**；合法 id 误伤检查（不存在项目仍走既有 404）；`verifyStoryAssetReferenceFile(dir=projA, '../projB/assets/secret.png')` → **`reference_path_outside_project`**（projB 文件真实存在也拒绝），项目内合法路径放行。
- projectId 回写：null→写入+history 留证+计入配额；已有值/终态/缺失 item 不覆盖。
- 全量回归：`node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs` → **255/255**（基线 245 + 新增 10）；`node --check` 全部改动文件通过；未改动 console（无需 typecheck）与 packages；临时目录隔离，未触碰真实 state/ 与 storage/projects。

### 遗留风险

- `dispatchReasoningSession` 兜底门禁与 story workflow 回写 glue 位于 `controlServerCore.js`（session 目录不可 env 隔离，单测不直接 import 调用），其判定核心（`evaluateProjectQuota`/`backfillQueueItemProjectId`）与两条调用方契约（HTTP 429、cron quotaRejected 标记）均有测试；glue 本身依赖全量回归与 stage-4 联调覆盖。
- 无 projectId 的任务（非 story 生产类）不占项目配额，仅受全局并发约束（设计取舍：配额按项目归属计量，无归属不可计数）。
- `resolveStoryProjectId` 全局指针 fallback 保留（既有行为）；回写机制保证生产中的任务绑定自身项目后不再走 fallback。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: AUTO-C01, AUTO-C02, AUTO-D01, AUTO-D02