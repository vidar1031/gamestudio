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

## 交付证据

- Server 修改列表：
  - `apps/control-server/src/server/reasoning/cronGovernance.js`（新增）：cron job 治理模块。job 持久化 `state/cron-jobs.json`（`HERMES_CRON_JOBS_FILE` 可覆盖，tmp+rename 原子写，损坏文件隔离留证）；workflow 白名单 `CRON_WORKFLOW_REGISTRY` 与 `server/workflows/` 注册表对齐（story_production / gamestudio_bootstrap / project_status），创建与触发双重校验，未注册一律拒绝并审计；受控触发适配器 `triggerCronJob`（启动门禁 `checkStartAllowed` 与 HTTP session 入口同一语义 → 幂等去重（`jobId:周期起点` 键，同周期已有未终结任务则 `skipped_duplicate` 并记录）→ `createReasoningSession`（submissionContext.origin='cron' + cronJobId + cronIdempotencyKey + workflow + reviewMode）→ `dispatchReasoningSession` 入队）；`runDueCronJobs` 调度 tick（只触发到点 active job，单 job 异常推进下一周期并审计，不热循环）；暂停/恢复/停用/删除全部留审计。
  - `apps/control-server/src/server/routes/cronRoutes.js`（新增）：`GET /api/control/cron/jobs`（job 列表 + 调度器状态 + 白名单）、`POST /api/control/cron/jobs`（注册，未注册 workflow 400）、`POST .../jobs/:jobId/status`（pause/resume/disable，非法流转 409）、`DELETE .../jobs/:jobId`、`POST .../jobs/:jobId/trigger`（人工触发走同一受控适配器与幂等规则）。写类端点由 AUTO-D02 边界保护（默认仅本机）；调度 tick 是 server 内部调用，不经 HTTP，未为 cron 开任何安全口子。
  - `apps/control-server/src/server/controlServerCore.js`：`startCronScheduler` / `stopCronScheduler` / `getCronSchedulerState`（`HERMES_CRON_TICK_MS` 默认 15s；tick 只把到点 job 交给受控适配器，无注册 job 时仅读文件空转）；共享 context 暴露 `getCronSchedulerState`；注册 cronRoutes。
  - `apps/control-server/src/index.js`：启动时 `startCronScheduler()`。
  - `apps/control-server/src/server/reasoning/governanceAudit.js`：审计记录新增可选 `jobId` 字段（向后兼容，既有断言不受影响）。
- Console 修改列表：
  - `apps/control-console/src/services/reasoningApi.ts`：`listCronJobs` / `setCronJobStatus` / `triggerCronJob` 封装。
  - `apps/control-console/src/pages/GovernancePage.vue`：治理页新增「定时任务」区块（调度器状态、job 卡片含工作流/间隔/审核模式/最近与下次触发、最近 5 条触发记录含 session/task 链接、暂停/恢复/停用/立即触发按钮，成功/阻断原因直接展示 API 返回）；审计动作标签补 cron 系列。
- 测试与回归：
  - `scripts/test/cronGovernance.test.mjs`（新增 11 例）11/11：白名单拒绝+审计（S3-08）、合法注册持久化、prompt/间隔下限拒绝、可追溯 session/task 创建（origin='cron' 标注 + dispatch 入队 + 审计互查）、幂等去重（未终结跳过/终结放行）、启动门禁阻断、暂停/恢复/停用流转+审计、触发时白名单双重校验（防 jobs 文件篡改）、runDueCronJobs 到点触发与异常推进、HTTP 路由全链路（注入 fake createSession/dispatch）。
  - 全量回归 `node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs` 204/204 通过（基线 193 + 新增 11）。
  - `npm --workspace @game-studio/control-console run typecheck` 通过；`node --check` 全部改动文件通过。
- smoke 证据（`sh restart_control.sh` 后）：`bash scripts/test/smoke_cron_governance.sh` SMOKE PASS——cron 端点与白名单可见、未注册 workflow 400 + 审计 blocked、job 注册/列表、暂停→触发 409→恢复→停用→触发 409 全审计、未知 job 404、生命周期 `availableActions` 正常、GovernancePage 编译 200、清理无残留。smoke 只走阻断路径不产生真实模型调用。
- S3-09 真实演练（2026-08-15，OMLX gpt-oss-20b 已加载 + control/server/editor 全启动）：
  - 经治理 API 注册 job `cron_msu2odzo_67aa79`（workflow=story_production，intervalMs=3600000，reviewMode=full-auto）→ 人工触发（与到点触发同一适配器）→ session `reasoning_1786780014155_deaae3d3` 创建（session 文件 submissionContext 含 origin='cron'/cronJobId/cronIdempotencyKey/workflow，文件事实）→ 入队 → worker 执行 12 步计划；同周期第二次触发返回 `skipped_duplicate`（幂等证据，审计留证）。
  - 守护台可见性：队列详情/会话事件流/审计全程可按 jobId↔sessionId↔taskId 互查（计划、步骤、重试、审核模式、日志、产物、终态 verdict）；治理页 cron 区块展示 job、触发记录与 session 链接。
  - 真实产物：`storage/projects/702c8750-dd59-42d6-852d-269a55af73d3`（《狼来了》，含 scripts/story/blueprint/ai_blueprint_review，蓝图评审 verdict=ok）。
  - 终态 verdict：FAILED（首次运行 C02 分类重试 3/3 退避后终结）。失败根因为环境/生产链事实，非 cron 治理缺陷：① ComfyUI 不可达（`capability-check` 实测 reachable=false）致 `story_preflight_image_provider` 失败边界级联；② OMLX 对 memory 同步步 `write_memory_file_rewrite` 持续返回 `model_task_http_500`（12 次尝试全部 500）。治理层行为全部正确：分类重试、退避、终态收敛、审计留证。
  - 治理动作证据：人工重试（retry ok 审计）→ 同样环境失败 → 人工取消（cancelled 终态）；演练 job 先暂停（暂停态触发 409 cron_job_not_active 审计）后停用（disabled，不再自动触发）。
  - 手工复现步骤：`sh restart_control.sh` + `./start_project.sh --detached` → `POST /api/control/cron/jobs` 注册 story_production job → `POST .../jobs/:jobId/trigger` → 观察 `GET /api/control/queue/items/:sessionId` 与治理页。ComfyUI 与 OMLX memory rewrite 500 修复后重跑即可收敛成功 verdict（生产链缺陷超出 H02 范围，未在本任务改动）。
- 安全边界遵守：cron 不直接写 `storage/projects`（只提交受控 session，生产写入全部由既有 story workflow 步骤与审核门禁承担）；cron 不自批准任何审核点（reviewMode 透传既有审核语义，productionTest 未启用）；未注册/越权 workflow 拒绝并审计。
- 文档：`ai/control_architecture.md` 同步（路由域层 + 4.1 能力清单）。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: HERMES-H01
