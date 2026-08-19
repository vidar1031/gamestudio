# HERMES-H04：项目与 workflow 注册表

## 所属阶段

阶段 4：生产扩展与平台治理。对应总计划 S4-07。

## 任务目标

将项目和 workflow 从硬编码 story/bootstrap 路径抽象为受治理的注册表，使第二个项目可复用同一治理和自动运行框架，同时保持项目隔离。

## 前置依赖

- AUTO-F01、AUTO-F02 完成阶段验收。
- HERMES-H03 完成阶段验收。

## 范围内

- 项目、workflow、允许 action、输入 schema、审核策略和路由的注册表。
- 第二个项目的最小注册、隔离执行与治理验证。

## 范围外

- 注册表条目不得绕过审核或直接修改 active production rules。
- 不迁移或破坏既有 GameStudio workflow。

## 必须满足

1. 已注册项目和 workflow 才能被 Hermes/cron 选择和触发。
2. 每个 workflow 有明确输入 schema、允许 action、审核策略和证据要求。
3. 第二个项目能完成一个受控 workflow，且其 task、artifact、日志与 GameStudio 隔离。
4. 未注册项目/workflow 或跨项目路径请求被明确拒绝。
5. 通过总计划 S4-07 的测试。

## 交付记录（kimi-code，2026-08-15）

### 实现

1. **注册表模块**（新增 `apps/control-server/src/server/reasoning/projectWorkflowRegistry.js`）：项目条目（projectId/name/rootDir 边界/启用状态/描述）+ workflow 条目（workflowId/所属项目/输入 schema/允许 action 集/审核策略/证据要求/执行器/启用状态）；持久化 `state/project-workflow-registry.json`（`HERMES_PROJECT_WORKFLOW_REGISTRY_FILE` 可覆盖，tmp+rename 原子写，损坏隔离留证），文件只存非内建条目；GameStudio 既有 story_production/gamestudio_bootstrap/project_status 登记为内建条目（代码级治理，只登记元数据不迁移不破坏执行语义，内建条目不可经 API 覆盖/停用/删除）。
2. **条目治理**（与 F02 同级）：注册/启停必须人类 actor（复用 `proposalGovernance.isHumanActor`，model/cron/agent 等自动身份与缺失 actor 一律拒绝 + 审计 blocked）；校验矩阵——reviewPolicy 必填且禁止 `none`/未知值（条目不得声明绕过审核）、allowedActions 与 evidenceRequirements 非空、executor 必须已登记（reasoning_chain/dry_run）、inputSchema 字段类型白名单、rootDir 必须相对且解析在 workspace 内、项目根目录不得互相嵌套、内建 id 受保护；审计 action `registry_project_register`/`registry_workflow_register`/`registry_entry_status` 带 projectId+actor。
3. **触发门禁**（`evaluateRegistryTriggerGate` 纯函数）：workflow 已注册且启用 → 所属项目已注册且启用 → projectId 归属合法（空=无归属兼容既有行为；注册项目本身；项目根目录下实例子目录——story 项目 id 即 gamestudio 实例；命中其他已注册项目或解析越界一律 `cross_project_rejected`）→ 输入 schema 校验（required/类型/未知字段拒绝/path:true 字段必须解析在项目根内，跨项目路径拒绝）。
4. **cron 消费注册表**（`cronGovernance.js` 最小改动）：`isCronWorkflowRegistered` 改以注册表为唯一事实源（内建条目始终满足，H02 白名单语义不回归，`CRON_WORKFLOW_REGISTRY` 导出与 cronRoutes 形状不变）；创建+触发双重校验之外补 projectId 归属校验（跨项目 job 拒绝 `cross_project_rejected` + 审计）；注册表新登记的 workflow 无需改代码即可被 cron 选择。
5. **HTTP session 入口门禁**（`reasoningRoutes.js` createRuntimeSession）：显式携带 `workflow` 的提交过注册表门禁，阻断 403 + 审计 `session_submit` blocked；未携带 workflow 的普通会话行为完全不变。
6. **受控执行 runner**（新增 `reasoning/registryWorkflowRunner.js`）：为新项目 workflow 提供与 GameStudio 同一治理模型的最小执行链——门禁先行（拒绝零写入）；`dry_run` 执行器确定性干跑（回显输入与计划摘要，测试可注入 executor）；执行完成按条目审核策略进入 waiting_review，人类 actor 经 `reviewRegisteredWorkflowRun` approve/reject，approve 前逐项校验证据要求（run_log/artifact/audit，缺证据显式 `evidence_missing` 阻断不静默放行）；run 全部证据（run.json/run.log/artifact.json）只写所属项目注册根目录 `<rootDir>/.workflow-runs/<workflowId>/<runId>/`，项目间物理隔离；审计 `registry_workflow_run`/`registry_run_review` 带 projectId。
7. **治理 API**（新增 `routes/registryRoutes.js`，挂载于 controlServerCore）：`GET /api/control/registry/overview`（Hermes/cron/守护台统一能力发现面——只能看到注册能力）、projects/workflows 列表与详情、受控注册与启停、`POST .../workflows/:id/runs` 触发、`GET .../runs[/:runId]`、`POST .../runs/:runId/review`；错误语义 400 校验 / 403 actor 与门禁 / 404 未注册 / 409 冲突与非法流转。

### 测试（S4-07 全覆盖）

`scripts/test/projectWorkflowRegistry.test.mjs` **12/12 通过**：

- 内建条目对齐：gamestudio 项目 + 3 个内建 workflow 元数据完整（inputSchema/allowedActions/reviewPolicy/evidenceRequirements/executor），`CRON_WORKFLOW_REGISTRY` 与注册表内建对齐，内建均可触发。
- 受控注册：人类 actor 注册成功 + 持久化 + 审计 ok；非人类/缺失 actor 8 例全拒绝 + 审计 blocked。
- 非法条目校验矩阵 14 例：reviewPolicy 缺失/`none`/未知、allowedActions 空、evidenceRequirements 空、未登记 executor、未注册项目、内建覆盖、schema 类型非法、rootDir 绝对路径/越界/嵌套冲突、重复注册、内建项目覆盖。
- 触发门禁：未注册 workflow 拒绝；输入缺 required/未知字段/类型错误/path 字段越界（指向 storage/projects）拒绝；跨项目归属（demo workflow + projectId=gamestudio）`cross_project_rejected`；实例子目录归属合法；story 侧任意项目 id 为实例、指向 demo 项目拒绝。
- 启停治理：workflow/project 停用后触发拒绝（workflow_disabled/project_disabled），恢复后可触发；内建条目停用拒绝；非人类 actor 拒绝；审计留证。
- 第二个项目（demo-image-site + demo_listing dry_run workflow）受控执行全链路：run waiting_review → run.json/run.log/artifact.json 全部落在 demo 根目录 `.workflow-runs/` 内，`storage/projects` 顶层清单前后 deepEqual 零变化（与 GameStudio 隔离），审计带 projectId=demo-image-site；人工 approve → completed（review 记录落 run.json + 审计）；demo 与 gamestudio 的 run 列表互不污染。
- 审核治理：reject 流转、非人类 actor 审核拒绝（run 保持 waiting_review）、终态重复审核 illegal_run_status、未知 run 404。
- 证据强制：executor 不产 artifact → approve 被 `evidence_missing` 阻断 + 审计，run 保持 waiting_review。
- executor 失败显式 failed + 审计；内建 reasoning_chain workflow 经 runner 显式 `executor_not_runnable`（走 reasoning session 链路）。
- cron 消费注册表：新注册 workflow 可被 cron 选择（创建 job 成功，projectId 透传）；停用后 cron 创建拒绝；跨项目归属 job 拒绝 + 审计；H02 语义不回归（ghost workflow 拒绝、story 实例 projectId 合法）。
- HTTP 全链路：overview 内建可见、非人类 actor 403、注册项目/workflow、reviewPolicy 'none' 400、未注册触发 404、跨项目触发 403、输入非法 403、触发 waiting_review、approve completed、run 详情/404、内建停用 409。
- 全量回归：`node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs` → **278/278**（基线 266 + 新增 12）；`node --check` 全部改动文件通过；未改动 console 与 packages（新增纯后端 API，console 无消费方，无需 typecheck）；临时目录 env 隔离，demo 项目根目录在 workspace `.tmp` 下用后清理，未触碰真实 state/ 与 storage/projects。

### 遗留风险

- HTTP session 入口的注册表门禁 glue（reasoningRoutes 中约 15 行）未直接单测（registerReasoningRoutes 依赖重 context），其判定核心 `evaluateRegistryTriggerGate` 与 registryRoutes HTTP 拒绝语义均有测试；glue 依赖全量回归覆盖（与 F01 同一取舍）。
- `resolveRegistryProjectBinding` 对未注册项目 id 按「实例」放行（兼容 F01 任意 story 项目 id）；实例 id 的真实存在性由下游（story workflow 步骤/apps/server 路径边界）保证，注册表只做边界归属判定。
- runner 当前仅 dry_run 执行器可在此执行；第二个项目接真实生产动作时需先在代码登记新 executor（代码级治理，与 executor_not_registered 校验一致）。
- 注册表文件损坏时按空处理（内建条目不受影响）；非内建条目丢失需人工重新注册（有 `.corrupt-*` 隔离文件留证）。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: AUTO-F01, AUTO-F02, HERMES-H03
- completed_at: 2026-08-15T11:07Z
