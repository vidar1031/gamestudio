# HERMES-H03：右脑子 agent 受控监察

## 所属阶段

阶段 3：长期守护与人机协作。对应总计划 S3-10。

## 任务目标

让右脑强模型驱动的 Hermes 子 agent 对任务健康、失败证据和阻断原因进行监察，同时将其能力限制在只读分析、建议和已注册的受控动作中。

## 前置依赖

- HERMES-H01、HERMES-H02 完成阶段验收。
- HERMES-G02 已确保 supervision 不会在认证阻断时空转。

## 范围内

- 子 agent 身份、模型路由、能力白名单、任务委派记录和审计。
- 监察结果在守护台的展示与受控建议执行。

## 范围外

- 子 agent 不得直接写项目文件、改生产规则或批准自身动作。
- 不得读取或输出真实凭证。

## 必须满足

1. 子 agent 使用已配置右脑模型，身份与调用记录可追溯。
2. 子 agent 可读取任务健康、证据和日志，并输出带依据的建议。
3. 子 agent 只能调用已注册的只读或受控 action；越权 action 被拒绝、记录并不影响生产任务。
4. 人可在守护台查看监察结果，并决定是否执行需要审核的建议。
5. 通过总计划 S3-10 的测试。

## 交付证据

- Server 修改列表：
  - `apps/control-server/src/server/reasoning/rightBrainSupervision.js`（新增）：右脑子 agent 监察模块。固定身份 `RIGHT_BRAIN_SUPERVISOR_ID = 'hermes-right-brain-supervisor'`；运行记录持久化 `state/right-brain-supervision.json`（`HERMES_RIGHT_BRAIN_SUPERVISION_FILE` 可覆盖，tmp+rename 原子写，损坏文件隔离留证，上限 50 条）；每次监察落记录（runId/身份/触发源/模型/输入摘要/输出摘要/发现/建议/usage/时间）并写治理审计，身份与调用可追溯；输入摘要仅计数级 digest，证据序列化（发给模型前）与输出/错误统一过 D02 `redactSecrets`，不含 env/key 材料。能力白名单两级——只读集（actionRegistry `RIGHT_BRAIN_SUPERVISION_READ_ACTIONS`，16 项已注册非 write/invoke action）直接放行；受控集 `RIGHT_BRAIN_CONTROLLED_ACTIONS`（retry_session/cancel_session）只能建议，进入 `pending_review`；越权 action（已注册未列入白名单 `over_privileged` / 未注册 `unregistered`）逐条 `rejected` 并审计（`right_brain_suggestion_blocked`），监察整体仍正常完成，不触碰生产任务与 session 状态机（全程异常隔离，含 evidence/model/parse/executor 四类失败兜底）。模型路由缺失或 key 失效 → 显式 `model_unavailable`（含 unavailableReason）；调用失败 → `model_error`（错误脱敏）；输出非 JSON → `output_invalid`；全部留证，绝不伪造监察结果。`reviewSupervisionSuggestion`：approve 经注入 executor 执行（子 agent 自身无 executor，不能自批准），成功 `approved_executed` / 阻断 `approved_blocked` / 异常保持 `pending_review`；reject → `rejected_by_human`；全部写 `right_brain_suggestion_review` 审计（含 sessionId/decision）。
  - `apps/control-server/src/server/capabilities/actionRegistry.js`：新增 `RIGHT_BRAIN_SUPERVISION_READ_ACTIONS` 只读白名单与 `isRightBrainSupervisionReadAction`；白名单与 REASONING_ACTIONS 注册表的对齐关系（全部已注册、非 write/invoke）由测试断言保护。
  - `apps/control-server/src/server/routes/supervisionRoutes.js`（新增）：`GET /api/control/supervision/right-brain`（身份/只读+受控白名单/右脑模型可用性/最近 20 条监察记录）、`POST .../run`（人工触发监察；deps 全部走 controlServerCore 既有受控入口：证据装配 = runtime 状态 + session 状态分布 + 队列分布 + 失败 session 错误摘要 + 治理审计尾部，只读无写操作；模型路由解析读既有配置 `actionRoutes.right_brain_supervision`；模型调用复用 `requestHermesChatCompletion` 与 meta_analysis 同一通道）、`POST .../runs/:runId/suggestions/:suggestionId/review`（approve/reject；executor 仅注册受控集——retry_session 走 `executeGovernedSessionRetry`、cancel_session 复用 `cancelReasoningSession` + 同一 cancel 审计语义）。写类端点受 AUTO-D02 边界保护（/api/* 全局中间件）。
  - `apps/control-server/src/server/routes/reasoningRoutes.js`：人工重试核心提取为导出函数 `executeGovernedSessionRetry(context, sessionId)`（守护台重试按钮与右脑建议 approve 后执行共用，状态/队列/runtime/启动门禁校验与 `retry` 审计语义不变）；HTTP 端点改为薄包装，响应形状与状态码完全保持（queueOperationsApi 13 例回归通过）。
  - `apps/control-server/src/server/controlServerCore.js`：注册 `registerSupervisionRoutes`；路由 context 新增 `resolveModelRouteForPhase`。
  - `config/hermes/manager.left-brain.json`：`actionRoutes` 新增 `right_brain_supervision`（moonshot / kimi-for-coding / direct，与 meta_analysis 同一右脑路由配置）。
- Console 修改列表：
  - `apps/control-console/src/services/reasoningApi.ts`：`getRightBrainSupervision` / `runRightBrainSupervision` / `reviewRightBrainSuggestion` 封装。
  - `apps/control-console/src/pages/GovernancePage.vue`：治理页新增「右脑监察」区块（右脑模型可用性如实呈现 provider/model 或 unavailableReason、「执行监察」按钮、运行记录卡片含状态/模型/摘要/发现列表/建议列表含依据 evidenceRefs、待审建议「批准并执行」/「驳回」按钮，成功/阻断原因直接展示 API 返回）；审计动作标签补 right_brain 系列。
- 测试与回归：
  - `scripts/test/rightBrainSupervision.test.mjs`（新增 14 例）14/14：S3-10 全覆盖——白名单与注册表对齐、action 分级（只读/受控/越权/未注册/空）、身份与调用记录可追溯（记录字段+审计互查）、只读装配与落盘不含凭证字面量（假密钥注入验证）、白名单内放行（allowed_read / pending_review）、越权拒绝+逐条审计+生产隔离（executor 零触达、监察不中断）、模型不可用显式降级不伪造（route 缺失/key 缺失两分支、零模型调用）、model_error 脱敏与 output_invalid、证据装配失败降级、审核流全路径（无 executor 阻断/approve 执行+审计/reject/终态不可重审/executor 阻断/异常隔离保持待审/非法 decision/未知记录）、HTTP 路由全链路（fake context 注入，approve 后经受控 retry 核心 failed→queued+dispatch，审计链四类记录齐全）、HTTP 错误形状（404/409/模型不可用如实返回）。
  - 全量回归 `node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs` 218/218 通过（基线 204 + 新增 14）。
  - `npm --workspace @game-studio/control-console run typecheck` 通过；`node --check` 全部改动文件通过。
- smoke 证据（`sh restart_control.sh` 后）：`bash scripts/test/smoke_right_brain_supervision.sh` SMOKE PASS——监察端点可见（固定身份 + 16 项只读白名单 + 2 项受控动作）、模型可用性如实报告（moonshot / kimi-for-coding 路由已解析）、真实触发一次监察显式降级 `model_error`（`model_task_http_403_Forbidden`，当时判断 key 失效；2026-08-15 复测 key 有效、全链路 completed）且零伪造（findings/suggestions 为空、error 留证）、治理审计 `right_brain_supervision blocked` 可按 runId 追溯、未知记录审核 404、生命周期 `availableActions` 正常、GovernancePage 编译 200、清理后运行记录与审计行无残留。
- 右脑模型可用性结论：路由配置完整且可解析（moonshot / kimi-for-coding，actionRoutes.right_brain_supervision）。交付当日 smoke 实测 403 Forbidden 并按设计显式降级（零伪造）；2026-08-15 复测确认 key 有效、系统内监察全链路 completed——早前"key 失效"结论系误测 api.moonshot.cn 所致。机制实现与测试均不依赖真实右脑可用：真实调用失败按设计显式降级 `model_error` 并审计 blocked，不伪造监察结果。
- 安全边界遵守：子 agent 不写项目文件、不改生产规则、不批准自身动作（executor 只存在于路由层人工 approve 路径）；输入装配与输出落盘均过 D02 脱敏，不读取或输出真实凭证；越权 action 拒绝+审计且不影响生产任务；生命周期控制未触碰（smoke 验证 availableActions）。
- 文档：`ai/control_architecture.md` 同步（路由域层 + 4.1 能力清单）。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: HERMES-H01, HERMES-H02
