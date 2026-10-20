# CONTROL Architecture - TalkScene Control / Hermes 当前结构说明

本文档描述当前已经落地的 `control` 控制平面结构，供本地 agent、维护者和后续重构任务作为事实参考。

这不是计划文档，也不是未来目标草案。未在本文档中明确写出的结构或行为，不应默认视为已完成能力。

## 1. 系统定位

当前 `control` 系统由两个应用组成：

- `apps/control-server`：权威控制后端，负责运行时控制、Hermes 配置、chat/context/reasoning 控制接口。
- `apps/control-console`：权威操作界面，负责把配置、自检、运行控制、chat、context、reasoning 工作流集中暴露给操作者。

当前系统的核心约束：

- 生命周期控制是保护行为，`start / stop / pause / resume / exit / all-restart` 不能被新功能替代。
- 左脑配置、自检、运行启动三者顺序保持不变。
- `control-console` 与 `control-server` 使用同一套控制语义；若一侧调整 contract，另一侧必须同步更新。

## 2. 目录事实

### 2.1 control-server

当前后端目录结构：

```text
apps/control-server/src/
  index.js
  app/
    createApp.js
  config/
    constants.js
    paths.js
  routes/
    registerRoutes.js
  server/
    agentDefinitions.js
    controlServerCore.js
    routes/
      overviewRoutes.js
      runtimeRoutes.js
      configRoutes.js
      contextRoutes.js
      chatRoutes.js
      chatRequestRoutes.js
      reasoningRoutes.js
      agentStreamRoutes.js
```

### 2.2 control-console

当前前端相关结构：

```text
apps/control-console/src/
  App.vue
  lib/
    chatMarkdown.ts
    reasoning.ts
  services/
    controlApi.ts
    chatApi.ts
    reasoningApi.ts
```

## 3. control-server 当前分层

### 3.1 启动层

- `apps/control-server/src/index.js`
  - 只负责创建 app、注册路由、执行启动期 orphan session 清理与持久化队列恢复、启动队列 worker、启动服务。
- `apps/control-server/src/app/createApp.js`
  - 负责创建 Hono app 和挂载基础中间件。
  - 挂载 AUTO-D02 访问边界中间件（`/api/*`）：高风险写类 API 的来源/凭证限制（`CONTROL_API_ACCESS_MODE`，默认 `localhost`）+ 4xx/5xx JSON 响应统一脱敏；并注册全局 `onError` 脱敏出口。
- `apps/control-server/src/routes/registerRoutes.js`
  - 作为统一路由装配入口，把 app 交给 control server 核心注册逻辑。

这一层不再直接承载业务 API 细节。

### 3.2 配置层

- `apps/control-server/src/config/constants.js`
  - 控制端口、Hermes API 基础地址、chat timeout、reasoning lease / timeout / retry 等常量。
- `apps/control-server/src/config/paths.js`
  - Hermes 根目录、控制配置文件、状态文件、session 目录、runtime 日志、context pool、storage 等路径事实。

这一层的职责是提供路径和常量真相，避免在业务逻辑中重复拼接。

### 3.3 核心层

- `apps/control-server/src/server/agentDefinitions.js`
  - 当前静态 agent 定义，仅包含 `hermes-manager`（`openclaw-manager` 已移除）。
- `apps/control-server/src/server/controlServerCore.js`
  - 当前仍是主要规则与状态实现所在文件。
  - 已经从“单入口文件”退化为“核心实现模块”，不再承担启动装配职责。
  - 对外负责：
    - 暴露 `registerControlServerRoutes(app)`
    - 暴露 `cleanupOrphanedReasoningSessions()`（含队列启动恢复）
    - 暴露 `dispatchReasoningSession()` / `startReasoningQueueWorker()` / `stopReasoningQueueWorker()`
    - 提供路由注册共享 context
    - 持有 Hermes chat / reasoning 的活动状态和大量共享 helper

### 3.4 路由域层

当前 `control-server` 已按控制域拆出独立注册模块：

- `apps/control-server/src/server/routes/overviewRoutes.js`
  - 健康检查
  - control overview / bootstrap
  - agent 列表、详情、contract、startup-profile、startup-flow、next-action
  - runtime-status
  - agent logs
  - model load / unload
- `apps/control-server/src/server/routes/runtimeRoutes.js`
  - runtime-action
  - local model catalog
  - local model inspect
  - self-check
- `apps/control-server/src/server/routes/configRoutes.js`
  - config 获取与保存
  - workflow diagnostics
  - reasoning capabilities
  - preflight-check
- `apps/control-server/src/server/routes/contextRoutes.js`
  - context candidates
  - context source content 读写
  - context draft
  - submission preview
  - context pool 列表、详情、文件、open、删除
- `apps/control-server/src/server/routes/chatRoutes.js`
  - chat history
  - chat memory file / chat history file 读写
  - chat history file open
- `apps/control-server/src/server/routes/chatRequestRoutes.js`
  - `ping-model` 聊天请求执行
  - active request / timeout / recovery 相关返回
- `apps/control-server/src/server/routes/reasoningRoutes.js`
  - reasoning session 创建、查询、取消、review
- `apps/control-server/src/server/routes/agentStreamRoutes.js`
  - `POST /api/control/agents/:agentId/agent-stream`：咨询/问答类（answer_only，含 R013 咨询问句）聊天的 agent 流式路径（SSE 透传）；非咨询类返回 `not_consultative` 供 console 回退既有确定性链
- `apps/control-server/src/server/routes/cronRoutes.js`
  - cron job 注册、列表、状态操作（pause/resume/disable）、删除、人工触发（HERMES-H02）
- `apps/control-server/src/server/routes/supervisionRoutes.js`
  - 右脑子 agent 监察：身份/白名单/模型可用性查询、人工触发监察、受控建议人工审核（HERMES-H03）
- `apps/control-server/src/server/routes/skillProposalsRoutes.js`
  - skill/intent proposal 治理：列表（含治理状态）、扫描、测试门禁、人工审核、晋级激活、驳回、回滚、受控下线（AUTO-F02）
- `apps/control-server/src/server/routes/registryRoutes.js`
  - 项目/workflow 注册表：能力发现（overview/projects/workflows）、受控注册与启停、受控触发 run、run 查询与人工审核（HERMES-H04）
- `apps/control-server/src/server/routes/resourceRoutes.js`
  - 本地重负载资源互斥调度只读状态：`GET /api/control/resources/state`（AUTO-R01）
- `apps/control-server/src/server/routes/eventsRoutes.js`
  - TalkScene 事件层：`GET /api/control/events/registry`（注册表透传，来源跟随当前绑定项目，未绑定/不可达返回 `available:false` 明确降级不 500）、`GET /api/control/events/runs`（执行历史只读过滤）、`POST /api/control/events/dispatch`（唯一事件执行入口）
- `apps/control-server/src/server/routes/projectBindingRoutes.js`
  - 项目绑定：`GET/PUT /api/control/project-binding`（绑定读取 + 活性探测；PUT 校验本机 baseUrl、写治理审计）

这些模块当前只负责路由与 HTTP 交互，不拥有独立状态源；它们通过 `controlServerCore.js` 提供的共享 context 访问规则函数与运行态。

## 4. control-server 当前能力边界

### 4.1 已完成能力

当前控制后端已稳定承载以下能力：

- 健康检查与 control 概览
- Hermes agent 资源暴露
- Hermes lifecycle 控制
- 左脑配置读取、保存、readiness、自检、workflow diagnostics
- 本地模型目录获取与 inspection
- chat 历史、chat 文件、主动聊天请求
- context source / context pool 工作台能力
- reasoning session 创建、轮询、审批、取消
- 服务器启动时 orphan reasoning session 收敛（非终结 active session 经状态机转 `orphaned`；checkpoint 缺失/损坏/恢复次数超限的转 `blocked`；recover 仅从 checkpoint 的 `nextStepIndex` 恢复）
- reasoning 执行循环超时与取消（AUTO-B04）：task/step deadline（`HERMES_REASONING_TASK_TIMEOUT_MS` 默认 2h / `HERMES_REASONING_STEP_TIMEOUT_MS` 默认 30min），超时经状态机转 `timeout`；取消信号经 `taskDeadline` registry 传播，运行中 step 竞速点立即中止转 `cancelled`；两者不再执行后续 step 且幂等可追溯
- reasoning 持久化任务队列（AUTO-C01）：session 创建后先入队（`state/reasoning-queue/`，`HERMES_REASONING_QUEUE_DIR` 可覆盖），由 worker 领取执行；领取写唯一 workerId + 单调递增 claimGeneration（tmp+rename 原子落盘）；同一 projectId 串行、跨 project 受全局并发上限（`HERMES_REASONING_QUEUE_MAX_CONCURRENCY` 默认 2）；任务终结（含 failed）即释放 project 槽位不阻塞后续任务；重启后未终结 item 按 B03 orphan 语义先收敛再重新入队（从 checkpoint `nextStepIndex` 恢复，不重复领取），证据不足或 session 缺失转 `blocked`；waiting_review 释放槽位、审核门禁不可被队列自动恢复绕过；队列事件（入队/领取/终结/重排队）挂 session 事件流；worker 周期挂心跳过期扫描（跳过队列管理的 session）
- 队列重试与错误分类（AUTO-C02）：session 失败经 `reasoning/retryPolicy.js` 确定性分类（显式 `retryable`/`failedStage`/`serverStatus` 信号优先，其次网络/超时/5xx/限流、schema、权限、确定性业务、审核拒绝模式表，无法归类保守按 non_retryable）；retryable 且未达上限（`HERMES_REASONING_RETRY_MAX_ATTEMPTS` 默认 3）时 session `failed -> retry_wait`、item 回 queued 落 `nextAttemptAt`（指数退避 `HERMES_REASONING_RETRY_BASE_MS` 默认 30s / `HERMES_REASONING_RETRY_MAX_DELAY_MS` 默认 300s，到点前不参与领取），重新领取后全量重跑；达到上限稳定终结 `failed`（item `retryHistory` + session `artifacts.retryPolicy` 记录每次原因与时间）；审核类收敛 `blocked`（状态机新增 `failed -> blocked`）；非重试错误按原语义终结 `failed`；retry_wait 中取消由 tick 镜像终结 `cancelled`，绝不重新领取；重启时 retry_wait 不收敛 orphan，重试计划保留
- 保留清理（AUTO-C03）：`reasoning/retentionCleanup.js` 随既有 `scheduleMemoryLifecycleMaintenance` 调度点低频执行（`HERMES_RETENTION_CLEANUP_ENABLED` 默认开 / `HERMES_RETENTION_CLEANUP_INTERVAL_MS` 默认 6h）；终态/failed session 超 TTL（`HERMES_RETENTION_SESSION_TTL_DAYS` 默认 30）先归档（`state/memory-archive/retention/`）后删除，queue item（`HERMES_RETENTION_QUEUE_ITEM_TTL_DAYS` 默认 30，仅终态超龄且 session 已清理/缺失）与 checkpoint（随已清理 session 随迁；孤儿 checkpoint 超 `HERMES_RETENTION_CHECKPOINT_TTL_DAYS` 默认 30 且 queue item 缺席/终结）同理；非终态 session/item、`waiting_review`、`review.status=pending`、`protectedSessionIds`（进程内活跃句柄）、TTL 内 failed 重试证据一律硬保护，归档失败保留原件不硬删；dry-run 出将删/将留清单零副作用，执行报告落 `state/retention-cleanup/`（latest-report.json + history.jsonl），重复运行幂等；`sessionCallCounts` 上限淘汰（`HERMES_MODEL_TASK_SESSION_CALL_CACHE_MAX_ENTRIES` 默认 500，跳过 global 与活跃 session），`inspectModelAccessCache` TTL+上限淘汰（`HERMES_INSPECT_MODEL_CACHE_TTL_MS` 默认 24h / `HERMES_INSPECT_MODEL_CACHE_MAX_ENTRIES` 默认 200），chat history 归档阈值与条目上限 env 化（`HERMES_CHAT_ARCHIVE_AFTER_DAYS` 默认 30 / `HERMES_CHAT_MAX_ENTRIES_PER_FILE` 默认 120）；与 `maintenance/retention.js`（人工运维归档迁移，不硬删）分工不重叠
- gateway 监督恢复（AUTO-C04）：`reasoning/gatewaySupervision.js` 轮询 pid 进程状态监测 gateway 异常退出（默认关闭，`HERMES_GATEWAY_SUPERVISION_ENABLED=true` 启用，与 G02 一致的安全默认；启用后 health-check 的直接拉起委托给监督器，避免双通道无上限重启）；exit 确定性分类（manual_lifecycle > unrecoverable_auth（复用 G02 `isAuthFailureError`）> unrecoverable_config > recoverable_crash）并落事件（原因/时间/pid/受影响 task，`state/hermes-gateway-supervision/events.jsonl`，`HERMES_GATEWAY_SUPERVISION_DIR` 可覆盖）；可恢复退出按指数退避有限重启（`HERMES_GATEWAY_RESTART_MAX_ATTEMPTS` 默认 3 / `HERMES_GATEWAY_RESTART_BASE_MS` 默认 2s / `HERMES_GATEWAY_RESTART_MAX_DELAY_MS` 默认 30s），次数经 `getGatewaySupervisionState()` 与 `/api/control/supervision/state` 的 `gatewaySupervision` 字段可观测，持续健康超 `HERMES_GATEWAY_HEALTHY_RESET_MS`（默认 5min）后归零；受影响 running/pausing/resuming session 标 failed（错误文本命中 C02 retryPolicy 临时故障模式，由队列调度 retry_wait），达上限或不可恢复时受影响任务（含本窗口标 failed 的）经状态机收敛 `blocked`（终态，item 由 worker tick 镜像终结），不无限循环；恢复成功不新造通道——retry_wait 到点经 canExecute 恢复可领取，仅挑选合法未取消的等待任务写入 `gateway_recovered` 事件并 kick 队列，已 cancelled/终态绝不动；生命周期 stop/pause/exit/all-restart 发起的关停只记 `manual_lifecycle` 事件，绝不自动拉起（`hermesStoppingIntentionally` 标记，startHermesRuntime 成功启动后复位）
- 队列/task 运维入口（AUTO-D01）：`GET /api/control/queue/items` 只读列表（queue item join session 摘要：状态/当前步骤/重试次数与 `nextAttemptAt`/原因/审核状态，非终态在前，损坏 item 计入 errors 不猜测）与 `GET /api/control/queue/items/:sessionId` 只读详情（item 全量含 `retryHistory`/`history` + session 切片 + 证据索引：checkpoint 指针、`artifacts.retryPolicy`、最近 20 条事件）；人工重试受控端点 `POST /api/control/agents/:agentId/reasoning-sessions/:sessionId/retry`（仅 failed session，与 C02 自动重试语义区分的显式动作；非失败状态/item 未终结/runtime 未运行/左脑门禁未就绪一律 409 透传阻断原因；成功路径先转 session `failed -> queued` 再经 `resetQueueItemForManualRetry` 重置 item——仅终态可重置、清退避窗口、retryCount 归零重新获得自动重试预算、retryHistory 保留，最后 dispatch 幂等入队并唤醒 worker）；Console `SessionsPage.vue` 新增「任务队列」区块（状态分组过滤、行内详情展开、取消/恢复/重试操作反馈直接展示 API 返回，刷新即重新拉取服务端不做本地臆测），前后端同一套控制语义
- Control API 访问边界（AUTO-D02）：`server/security/apiAccessBoundary.js` 中间件挂载于 `/api/*`；高风险 API = `/api/` 下非 GET/HEAD/OPTIONS 请求（写类），只读与健康检查保持开放；访问模式由 `CONTROL_API_ACCESS_MODE` 显式控制——`localhost`（默认，高风险仅本机 127.0.0.1/::1/::ffff:127.0.0.1 可访问，无效 mode 回落此安全默认）、`token`（本机免凭证，非本机需 `Authorization: Bearer <CONTROL_API_TOKEN>`，token 只从 env 读、timing-safe 比对、未配置时非本机 fail-closed）、`open`（不限制，仅临时调试）；拒绝固定 403 + `{ ok:false, error:'api_access_denied' }` 不回显凭证材料，拒绝事件写审计日志 `logs/<date>/control-api-access.log`（路径字段过脱敏）；中间件在 `next()` 之后对全部 4xx/5xx JSON 响应统一过 `server/security/redaction.js` 脱敏（Bearer/sk-/key=value 模式 + 敏感 env 值），`createApp` 全局 `onError` 同样脱敏，secret 不出现在错误、审计日志与 Console 响应中
- 守护台治理闭环（HERMES-H01）：`GET /api/control/reviews/pending` 待审核中心（waiting_review session 集中呈现：review 详情 + 队列 item 状态 join，updatedAt 倒序）；`GET /api/control/governance/audit` 治理操作审计（`reasoning/governanceAudit.js` JSONL 落 `state/governance-audit.jsonl`，`HERMES_GOVERNANCE_AUDIT_FILE` 可覆盖；取消/恢复/重试/审核四类受控动作的成功 ok 与阻断 blocked 都留证，含 sessionId/taskId/decision，best-effort 落盘不影响动作结果，损坏行跳过计数）；queue 详情证据索引新增 `evidence.artifacts`（projectRoot/storyIndex/finalAnswer 预览 240 字符截断）；Console 新增 `pages/GovernancePage.vue` 治理页（待审核批准/拒绝可附修正意见走既有受控 review API、运行健康聚合 `/api/health`+overview+runtime-status+supervision/state gateway 监督+队列概览、操作审计表），全部刷新即重新拉取服务端；生命周期控制语义未动
- cron 受控生产触发（HERMES-H02）：`reasoning/cronGovernance.js` + `routes/cronRoutes.js`；job 持久化 `state/cron-jobs.json`（`HERMES_CRON_JOBS_FILE` 可覆盖），字段含 jobId/workflow/prompt/intervalMs/reviewMode/status/nextTriggerAt/recentTriggers（上限 20 条）；workflow 白名单 `CRON_WORKFLOW_REGISTRY` 与 `server/workflows/` 注册表对齐（story_production/talkscene_bootstrap/project_status），创建时与触发时双重校验，未注册一律拒绝并审计；触发走受控适配器（与 HTTP session 入口同一链路：启动门禁 `checkStartAllowed` -> 幂等去重（`jobId:周期起点` 键，同周期已有未终结任务则 skipped_duplicate 并记录）-> `createReasoningSession`（submissionContext.origin='cron' + cronJobId + cronIdempotencyKey + workflow）-> `dispatchReasoningSession` 入队），cron 不直接写 storage/projects、不自批准审核点；调度 tick `startCronScheduler`（`HERMES_CRON_TICK_MS` 默认 15s，`runDueCronJobs` 只触发到点 active job，异常 job 推进下一周期并审计，无 job 时仅读文件空转）；治理端点 `GET/POST /api/control/cron/jobs`、`POST .../jobs/:jobId/status`（pause/resume/disable，非法流转 409）、`DELETE .../jobs/:jobId`、`POST .../jobs/:jobId/trigger`（人工触发走同一适配器），全部写治理审计（action `cron_job_*`/`cron_trigger`，含 jobId）；Console 治理页新增「定时任务」区块（调度器状态、job 卡片含工作流/间隔/审核模式/最近与下次触发、最近 5 条触发记录含 session/task 链接、暂停/恢复/停用/立即触发按钮）
- 右脑子 agent 受控监察（HERMES-H03）：`reasoning/rightBrainSupervision.js` + `routes/supervisionRoutes.js`；固定身份 `hermes-right-brain-supervisor`，模型路由走既有配置 `actionRoutes.right_brain_supervision`（manager.left-brain.json，右脑 moonshot/kimi-for-coding，与 meta_analysis 同一通道），路由缺失/key 失效显式降级 `model_unavailable`、调用失败 `model_error`、输出非 JSON `output_invalid`，全部留证不伪造；运行记录持久化 `state/right-brain-supervision.json`（`HERMES_RIGHT_BRAIN_SUPERVISION_FILE` 可覆盖，tmp+rename 原子写，上限 50 条，损坏隔离），输入摘要仅计数级 digest，证据序列化与输出/错误统一过 D02 `redactSecrets`；能力白名单两级——只读集 `RIGHT_BRAIN_SUPERVISION_READ_ACTIONS`（actionRegistry 注册、16 项、非 write/invoke，对齐关系有测试断言）可直接调用，受控集 `RIGHT_BRAIN_CONTROLLED_ACTIONS`（retry_session/cancel_session）只能建议、人 approve 后经既有受控 API 执行（retry 与守护台人工重试共用核心 `executeGovernedSessionRetry`（reasoningRoutes 提取，HTTP 端点行为不变）、cancel 复用 `cancelReasoningSession`），子 agent 自身无 executor 无法自批准；越权 action（已注册未列入白名单 over_privileged / 未注册 unregistered）逐条拒绝并审计（`right_brain_suggestion_blocked`），监察全程异常隔离不触碰生产任务与 session 状态机；治理端点 `GET /api/control/supervision/right-brain`、`POST .../run`、`POST .../runs/:runId/suggestions/:suggestionId/review`，审计 action `right_brain_supervision`/`right_brain_suggestion_blocked`/`right_brain_suggestion_review`；Console 治理页新增「右脑监察」区块（模型可用性、执行监察按钮、运行记录含发现与建议、待审建议批准/驳回按钮）
- 多项目隔离与配额（AUTO-F01）：每项目在制配额（`HERMES_REASONING_MAX_TASKS_PER_PROJECT` 默认 1，与同 project 串行对齐）由 `persistentQueue.evaluateProjectQuota` 纯函数判定（queued/claimed/running 计入，waiting_review/终态已释放槽位不计入），HTTP 提交前置校验同步 429 `project_quota_exceeded`（响应带 limit/activeCount/activeSessionIds 用量证据并写治理审计 `session_submit`），`dispatchReasoningSession` 对新建 item 的根任务兜底（超限不入队，session queued->blocked 留 `queue_quota_rejected` 事件与审计；幂等入队/人工重试/重试调度/子目标 session 不受配额阻断）；projectId 回写补 C01 窗口——story session 创建时项目未生成以 projectId=null 入队，story workflow 步骤成功定位/创建项目后回写 session `submissionContext.projectId` 与 item.projectId（`backfillQueueItemProjectId`，已有值/终态不覆盖，history 留 `project_id_backfilled`），此后同 project 串行与配额对该任务生效；路径边界——apps/server 挂 `/api/projects/:id[/\*]` 中间件，:id 解析越出 `PROJECTS_DIR`（`..%2f` 等编码穿越、绝对路径）一律 400 `invalid_project_id`，跨 project 相对路径参数由 E01 `verifyStoryAssetReferenceFile` 拒绝（`reference_path_outside_project`），control 侧 `getStoryProjectDir` 越界返回空按项目目录不可用处理；治理审计记录（取消/恢复/重试/审核/cron）补 `projectId` 字段，cron job 支持可选 projectId（透传 submissionContext、配额阻断记 `blocked_quota` 触发记录），审计可按项目对照
- proposal 测试、审核、晋级与回滚（AUTO-F02）：`intents/proposalGovernance.js` 生命周期状态机（candidate → tested → approved → active / rejected / rolled_back）持久化 `state/proposal-governance.json`（`HERMES_PROPOSAL_GOVERNANCE_FILE` 可覆盖，tmp+rename 原子写，损坏隔离）；`_inbox` proposal 默认不可执行（启动加载只读 active 目录），无任何自动晋级代码路径——原 `promoteProposal`/`rejectProposal`/`deactivateActiveIntent` 无门禁函数已移除；测试门禁为确定性检查（可编译 / provenance 真实样例 prompt 命中 match 规则 / 评估理论最高分可达 minScore），证据落治理记录；审核/激活/回滚/下线必须携带人类 actor（model/cron/agent 等自动路径身份与缺失 actor 一律拒绝 + 审计 blocked）；每次激活产生不可删除版本记录（proposal 快照 + sha1 + actor + 时间 + 测试/审核证据指针），激活写入失败自动回滚到上一已知版本（无上一版本则完全下线），人工回滚恢复上一版本快照并重新注册，旧版本全程可追溯；审计复用 H01 governanceAudit（新增可选 actor 字段，action `proposal_test`/`proposal_review`/`proposal_activate`/`proposal_rollback`/`proposal_deactivate`）；intents 目录解析改惰性 getter（`HERMES_INTENTS_DIR` 可覆盖，测试隔离）；Console 提案面板对齐治理流（状态 chip、测试/审核/激活按状态启停、版本与回滚按钮），治理动作统一携带 `human:control-console` actor
- 项目与 workflow 注册表（HERMES-H04）：`reasoning/projectWorkflowRegistry.js` + `reasoning/registryWorkflowRunner.js` + `routes/registryRoutes.js`；项目条目（projectId/name/rootDir 边界/启用状态）与 workflow 条目（workflowId/所属项目/输入 schema/允许 action 集/审核策略/证据要求/执行器）持久化 `state/project-workflow-registry.json`（`HERMES_PROJECT_WORKFLOW_REGISTRY_FILE` 可覆盖，tmp+rename 原子写，损坏隔离），文件只存非内建条目；TalkScene 既有 story/bootstrap/projectStatus 工作流登记为内建条目（代码级治理，只登记元数据不迁移执行语义，内建条目不可经 API 覆盖/停用）；条目创建与启停必须人类 actor（复用 F02 `isHumanActor`），reviewPolicy 必填且禁止 `none`（条目不得声明绕过审核），rootDir 必须解析在 workspace 内且项目根目录不得互相嵌套；触发门禁 `evaluateRegistryTriggerGate`（已注册且启用 + 项目启用 + projectId 归属合法——注册项目本身或根目录下实例，命中其他注册项目/越界一律 `cross_project_rejected`——+ 输入 schema 校验 required/类型/未知字段/path 字段必须在项目根内）被 cron（H02 白名单判定 `isCronWorkflowRegistered` 改以注册表为唯一事实源，创建+触发双重校验含 projectId 归属）与 HTTP session 入口（显式携带 `workflow` 的提交过门禁，未携带的普通会话行为不变）共同消费；受控执行 runner（`runRegisteredWorkflow`）为新项目 workflow 提供同一治理模型的最小执行链——`dry_run` 执行器（或测试注入 executor）执行后进入 waiting_review，人类 actor 经 `reviewRegisteredWorkflowRun` 批准/驳回，批准前逐项校验证据要求（run_log/artifact/audit，缺证据显式 `evidence_missing` 阻断），run 全部证据（run.json/run.log/artifact.json）只写所属项目注册根目录内（`<rootDir>/.workflow-runs/`），项目间物理隔离；治理端点 `GET /api/control/registry/overview`（Hermes/cron/守护台统一能力发现面）+ projects/workflows 注册与启停 + `POST .../workflows/:id/runs` 触发 + `POST .../runs/:runId/review` 审核，审计 action `registry_project_register`/`registry_workflow_register`/`registry_entry_status`/`registry_workflow_run`/`registry_run_review` 带 projectId 可按项目对照
- `productionTest` 完整 bypass 所有 review gate
- 模型路由 strict 语义（2026-08-18 修正）：`normalizeModelRouteEntry`/`resolveModelRouteForPhase` 不再把 hermes+strict 且与左脑绑定不一致的路由静默降级 direct——标记 `unavailableReason`（`route_unavailable:strict_route_model_mismatch:*`），`requestHermesChatCompletion` 显式抛错，C02 retryPolicy 新增 `route_unavailable` 规则收敛 blocked 等人工修配置；strict 可满足时正常走 hermes；非 strict 不一致保持 best-effort 直连但以 `degradedFrom` 留痕；strict 可满足性在 `buildConfigValidation` 自检项（`strict-route-<routeId>`）与 workflow-diagnostics `workflow.modelRouting.strictRoutes/degradedRoutes` 可见
- 记忆注入有界 content-injection（2026-08-18 修正）：`workflow.memoryOverlayMode` 默认 `content-injection`，回答/chat/context-draft 链路把核心记忆文件正文按「每文件上限 + 总量上限」注入系统消息（`HERMES_MEMORY_OVERLAY_FILE_CHAR_LIMIT` 默认 3000 / `HERMES_MEMORY_OVERLAY_TOTAL_CHAR_LIMIT` 默认 12000，超限截尾标注；Agent Definition 默认不注入正文仅列引用，`HERMES_MEMORY_OVERLAY_AGENT_DEFINITION_CHAR_LIMIT` 可开极低上限；空/缺失文件跳过）；`references-only` 保留为可选项，文案明确「正文未注入、不要读文件、不要编造」，两种模式文案分离
- 本地重负载资源互斥调度（AUTO-R01）：`reasoning/resourceScheduler.js` 槽位状态机（idle/llm/gpu/blocked）管理 OMLX 模型与 ComfyUI 出图的内存互斥（32G 机器两者无法长期共存）；action→资源映射（出图类 `story_generate_lock_asset_references`/`story_render_scene`/`story_render_scene_backgrounds`/`story_lock_test`/`story_generate_asset_candidate` 归 gpu，其余默认 llm）；gpu step 前交换编排（卸载全部已加载模型 → health 确认释放 → 放行，unload 失败显式抛 `resource_swap_unload_failed`），gpu 批次终结 settle 窗口（`HERMES_RESOURCE_GPU_SETTLE_MS` 默认 3s，窗口内新 gpu 申请取消回载实现攒批）后回载配置模型（reload 失败显式 blocked 不静默）；reader-writer writer 优先互斥——gpu 申请登记后新 llm 准入等待，运行中 llm step 不掐断（交换只在 step 边界）；队列领取门禁（worker `claimGate`：llm 类任务在 gpu 占用期跳过领取保持 queued 不动 retry 预算，节流事件「等待出图释放」）+ step 边界准入（`admitReasoningStepResource`，llm step 挂起等待可被取消/超时中断，与 B04 同语义收敛）；单模型守卫 reconcile（`HERMES_RESOURCE_RECONCILE_INTERVAL_MS` 默认 30s）卸载非配置模型（如 gpt-oss 被自动拉起）、配置模型缺席且有 llm 需求时回载、漂移纠正与 blocked 自愈；槽位/持有者/获取时间持久化 `state/resource-scheduler.json`（原子写，重启后持有者清空由 reconcile 对齐），交换事件落 `state/resource-scheduler-events.jsonl`（who/when/unload_ms/load_ms/结果）；`GET /api/control/resources/state` 只读状态（槽位/模型在线/OMLX 内存水位/最近 20 条交换事件/reconcile 状态，probe 失败回落缓存），Console 治理页「运行健康」新增「资源互斥」卡片；`HERMES_RESOURCE_SCHEDULER_ENABLED` 默认开
- 项目绑定与事件地图可视化（2026-08-19）：`services/projectBindingService.js` 管理「当前绑定项目」（默认 TalkScene 交互故事 `http://127.0.0.1:1999`，env `TALKSCENE_SERVER_BASE_URL` 可作默认覆盖），持久化 `state/project-binding.json`（tmp+rename 原子写，`HERMES_PROJECT_BINDING_FILE` 可覆盖，损坏/非法回落默认），仅接受本机 http(s) 地址（localhost/127.0.0.1/::1），支持 `bound:false` 显式解绑；`GET /api/control/project-binding` 只读 + `/api/health` 活性探测，`PUT` 校验非法地址 400 且成功/拒绝都写治理审计（action `project_binding_update`，D02 边界自动覆盖）；`GET /api/control/events/registry` 改从绑定项目 baseUrl 拉取注册表，未绑定 `project_not_bound`、不可达 `registry_unreachable`，统一 200 + `available:false` 不 500；`GET /api/control/events/runs` 读 `state/events/events.jsonl`（`events/eventRunsReader.js`，`HERMES_EVENT_RUNS_FILE` 可覆盖）按 eventId/code 过滤返回最近 N 条；dispatch caller 白名单新增 `console`；Console 新增 `pages/EventsPage.vue`「项目事件」页（绑定卡片 + 按 category 分组的事件列表，查询类无必填参数可页内直接执行，命令类保持聊天确认卡片纪律不内联执行，每事件可展开历史执行记录）与 `ProjectsPage.vue` 顶部「当前绑定项目」卡片（名称/baseUrl/可达性/事件数 + 修改绑定/解除绑定入口）
- agent 流式咨询（2026-08-19）：`reasoning/agentStreamBridge.js` + `routes/agentStreamRoutes.js`；咨询/问答类聊天（分类 route=`answer_only`）从「固定计划链」改为「agent 边想边做边展示」——创建 reasoning session（治理证据锚点，`submissionContext.executionMode=agent_stream`）后桥接 hermes 网关 `POST /api/sessions/{id}/chat/stream`（会话跨消息复用，映射存 `state/agent-stream-bridge/<agentId>.json`，失效自动重建），SSE 事件边消费边透传 console（思考/动作/结果/回答增量，经 `createAgentStreamStepAssembler` 聚合为 STEP N 结构），关键事件同步落 session 事件流（`agent_stream_started`/`agent_thinking`/`agent_tool_call`/`agent_tool_result`/`agent_tool_blocked`/`final_answer_ready`/`session_completed`）；只读工具白名单硬边界（`AGENT_STREAM_READONLY_TOOLS`：read_file/search_files/session_search/skill_view/skills_list/web_search/web_extract，默认拒绝其余全部）——越权 `tool.started` 先于执行到达，桥立即断开上游流（网关侧取消 agent 任务），session 收敛 `blocked` 并写回人话拒绝文案；客户端断开/停止按钮（既有 cancel 端点）经节流探测中止桥；完成时最终回答写回 `artifacts.finalAnswer` + chat 历史（照旧显示）；非咨询类输入返回 `not_consultative` 由 console 回退既有确定性执行链，生产链不变；Console 聊天页新增 `AgentStreamSteps.vue` 流式步骤区（💭 思考可展开 / ⚙ 动作名+目标 / 结果状态，无原始 JSON 直铺），审核卡（ReasoningReviewCard）/事件确认卡/事件结果卡（EventResultCard）首屏改人话摘要+关键参数 chips（`lib/humanize.ts`），原始负载统一收进可折叠「技术细节」区
- story workflow 文本闭环（13 步）含 Story Bible 生成
- OMLX `response_format` workaround（fallback 到 `chat/completions`）
- 外部服务可见启动形态（2026-08-15）：Hermes gateway 默认经 `launchHermesInTerminal` 以 Terminal 窗口可见启动（Dock 图标 + 窗口实时日志 tee 同步写日志文件、pid 由 launcher 落 pid 文件保证 stop 语义、关窗即终止进程），`HERMES_LAUNCH_MODE=silent` 或非 macOS 或 osascript 失败时回退原 nohup 静默启动（start/stop/pause/resume/exit/all-restart 生命周期语义不变）；OMLX `startOmlxApp` 改为优先 `open` oMLX GUI App（菜单栏图标 + 自带 Server 开关与监测，App 缺失或 `OMLX_LAUNCH_MODE=cli` 时才退回 `omlx-cli serve` 静默方式），两个 env 已登记 `.env.example`

### 4.2 当前未继续拆开的部分

虽然路由已模块化，但以下内容仍集中在 `controlServerCore.js`：

- Hermes runtime 控制规则
- provider/baseUrl 归一化
- 文件读写 helper
- chat history / context / reasoning 的规则实现
- reasoning session 状态流转和执行辅助函数
- route shared context 的装配

也就是说，当前已经完成的是“控制面结构拆分”和“路由域拆分”，还没有把核心规则继续下沉成更细的 service / repository 文件。

## 5. control-console 当前分层

### 5.1 页面层

- `apps/control-console/src/App.vue`
  - 仍是当前顶层页面壳和主要状态容器。
  - 已不再承担所有 HTTP path 拼接工作。

### 5.2 共享工具层

- `apps/control-console/src/lib/chatMarkdown.ts`
  - 负责 chat markdown 渲染。
- `apps/control-console/src/lib/reasoning.ts`
  - 负责 reasoning 时间、事件、持续时长等共享格式化逻辑。

页面内重复 helper 已回收，不再保持双份实现。

### 5.3 API service 层

- `apps/control-console/src/services/controlApi.ts`
  - 健康检查、agent、日志、runtime、config、models、preflight、自检、runtime/model action。
- `apps/control-console/src/services/chatApi.ts`
  - chat history、chat file、ping-model、context candidates、submission preview。
- `apps/control-console/src/services/reasoningApi.ts`
  - reasoning capabilities、reasoning session 创建与取消。

当前前端已经完成的关键变化是：主要请求从 `App.vue` 的直接 `fetch()` 调用改为通过 service 层统一封装。

## 6. 当前控制契约

### 6.1 运行控制契约

当前保护中的运行时动作仍为：

- `start`
- `stop`
- `pause`
- `resume`
- `exit`
- `all-restart`

这些动作仍由 `control-server` 解释并返回统一的 runtime state / control state 结果，console 只是操作界面，不是状态真相源。

### 6.2 配置启动约束

当前依旧要求：

1. 左脑配置先保存。
2. preflight / readiness 通过。
3. 再进入 Hermes runtime 启动或恢复。

任何后续 agent 若直接绕过此顺序调用 runtime-action，应视为违反当前控制契约。

### 6.3 reasoning 与 chat 语义分离

虽然 chat 与 reasoning 都会调用模型，但当前控制语义明确区分：

- `ping-model` 是普通聊天路径。
- `reasoning-sessions` 是可观测推理执行路径。
- `submission-preview` 只做预览，不触发实际模型调用。
- `context-*` 路由属于工作台资源，不等于 chat 请求本身。

### 6.4 Hermes 内建能力边界（session_search / execute_code / Skills Hub）

2026-08-18 起，hermes 网关（api_server）启用三项内建能力，边界如下：

- **execute_code 仅限助手侧任务**（复盘 / 研究 / 质检），用于把多步只读分析压缩成一次推理。
  生产主链（故事生成、出图、锁定测试、导出等）保持 control 确定性编排，**不经过 execute_code**。
  网关在 `config.yaml` 的 `command_allowlist` 永久放行 `execute_code` 整脚本审批（api_server 无人交互，
  一次性审批弹窗永远得不到回答）；脚本内部发起的 `terminal()` 调用仍逐条过危险命令守卫，不因此被放行。
- **session_search 只读检索**有两条入口：agent 侧工具（FTS5 零 LLM 成本）与 control 只读端点
  `GET /api/control/hermes/session-search?q=`。control 端点**直接只读查 state.db FTS5**（trigram/fts5/LIKE
  三分支与 hermes 同源），不代理到网关——一次只读检索不应变成一次完整 agent 推理（实测约 33K tokens/次），
  也不把 control 查询暴露给提示注入面。守护台治理页「历史检索」卡片即此端点的呈现。
- **Skills Hub 安装的技能一律保持候选**，经 `GET /api/control/skills/candidates` 待人审，
  不自动 approve、不自动进入注入清单（同学习循环治理纪律）。
- 模型输出仍是候选不是事实：execute_code 被审批守卫拒绝时，agent 曾把错误编造成"合理结果"上报。
  凡涉及 execute_code / session_search 的验证，必须交叉核对工具真实返回（state.db 中的 tool 消息）
  或独立重算，不得只信 agent 的最终叙述。

容量注记（2026-08-18 实测）：本网关新会话固定前缀（hermes 基础提示 + 工作区 AGENTS.md + 技能索引 +
control ephemeral 契约 + 工具 schema）约 33-36K tokens。本机 34GB 内存 + oMLX safe 档守卫下，
>20K tokens 的新 prefill 会被拒绝。已做的瘦身：`platform_toolsets.api_server` 裁到 8 个工具集
（image_gen 经网关会绕过 TalkScene 出图审核门禁，必须裁）、`context_file_max_chars: 8000`、
`auxiliary.compression.context_length: 65536`（修 OMLX 元数据 32K 误报导致的新会话 500）。
若再遇 `Prefill context too large ... prefill guard`，按 AUTO-R01 同款方式 unload/load 模型清空
Metal 缓冲池后重试；长期解法是释放内存或调高 `iogpu.wired_limit_mb`（需管理员）。

## 7. 本地 agent 使用建议

当任务涉及 `control`、`control-server`、`control-console`、`Hermes manager` 时，建议按以下顺序读取：

1. `README.md`
2. `ai/AGENTS.md`
3. `ai/TOOLS.md`
4. `ai/control_architecture.md`
5. `docs/系统生产级推进方案.md`（系统分工、启动流程、任务流、路由规则）
6. `docs/PRODUCTION_DEFECTS.md`（当需要了解当前缺陷和未实现项时）

使用原则：

- 先按本文档找模块归属，再进入具体文件。
- 若需求只涉及控制路由或控制按钮，不要重新全仓扫描。
- 若改动影响 API contract，必须同时检查 console service 层与对应 UI callsite。
- 若改动 runtime 语义，必须优先保护 lifecycle controls，不要让配置面板覆盖掉运行控制语义。

## 8. 后续演进建议

如果未来继续向更细粒度重构推进，建议从 `controlServerCore.js` 继续往下拆，但应按规则层拆，不要退回“把所有东西扔进 utils”这种结构：

- 先拆 runtime 规则与 control config 规则
- 再拆 chat/context 文件管理规则
- 最后拆 reasoning 执行与 review 规则

判断标准不是文件数量，而是：

- 路由模块是否只负责 HTTP
- 核心规则是否不再混杂文件路径与协议细节
- console 是否继续保持 contract 对齐

## 9. 文档状态

本文档状态：`authoritative-current`

适用范围：

- 本地 agent 读取
- control 模块维护
- 后续 control 相关重构前的结构对齐

不适用范围：

- 未来目标承诺
- 尚未落地的 service / repository 细分设计
- editor / server 非 control 模块说明
