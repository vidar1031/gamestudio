# AUTO-F02：proposal 测试、审核、晋级与回滚

## 任务目标

确保 `_inbox` proposal 只能作为候选，经测试和人工审核后才可激活，并可安全回滚且保留规则版本记录。

## 前置依赖

- AUTO-D02、AUTO-F01 必须完成本地验收。

## 范围内

- proposal 生命周期、测试门禁、人工审核、激活、版本记录和回滚。

## 范围外

- 模型不得自行将 proposal 升级为 active intent/workflow/evaluator。
- 不删除历史规则或审计记录。

## 必须满足

1. `_inbox` proposal 默认不可执行、不可自动影响生产 routing、workflow 或 evaluator。
2. proposal 必须通过规定测试并获得人工审核，才可激活。
3. 激活失败可回滚到已知版本，旧规则仍可追溯。
4. 每次审核、激活和回滚有 actor、时间、版本与证据记录。
5. 自动晋级拒绝、审核后激活、失败回滚和版本保留均有测试。

## 交付证据

- proposal 生命周期实现、权限边界和版本记录。
- 自动晋级拒绝、审核激活、失败回滚测试输出。
- 最终 campaign 的任务状态与证据索引。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: AUTO-D02, AUTO-F01
- completed_at: 2026-08-15T10:44Z

## 交付证据索引（kimi-code，2026-08-15）

- 生命周期与权限边界（新增 `apps/control-server/src/server/intents/proposalGovernance.js`）：
  - 状态机 candidate → tested → approved → active / rejected / rolled_back，持久化 `state/proposal-governance.json`（`HERMES_PROPOSAL_GOVERNANCE_FILE` 可覆盖，tmp+rename 原子写，损坏隔离留证）。
  - `_inbox` proposal 默认不可执行：`loadActiveJsonIntents` 只读 active 目录；自动投递（`enqueueHumanCorrectionProposal`/`enqueueSelfReviewOperatorProposals`/`scanProposals`）只写 `_inbox`；原无门禁的 `promoteProposal`/`rejectProposal`/`deactivateActiveIntent` 已从 `proposals.js` 移除，不存在任何自动晋级代码路径（反向搜索：`grep -rn "promoteProposal\|deactivateActiveIntent" apps/control-server/src` 仅余注释说明）。
  - 测试门禁（确定性，最小可行集）：可编译 / provenance 真实样例 prompt 命中 match 规则（intent 分类样例）/ 评估理论最高分可达 minScore；证据（逐 check 明细 + actor + 时间）落治理记录。
  - 人工审核与激活：actor 必填且必须为人类身份，`model:/cron:/agent:` 等自动路径身份与缺失 actor 一律拒绝并审计 blocked；approve 要求已 tested，激活要求已 approved，顺序不可绕过。
  - 版本与回滚：每次激活产生不可删除版本记录（proposal 快照 + sha1 + actor + 时间 + 测试/审核证据指针）；激活写入失败自动回滚到上一已知版本（无上一版本则完全下线，回滚本身失败时保持激活前现场）；人工回滚恢复上一版本快照并重新注册，旧版本永不删除可追溯；受控下线同样保留版本记录。
  - 审计：复用 H01 `governanceAudit.js`（新增可选 `actor` 字段），action `proposal_test` / `proposal_review` / `proposal_activate` / `proposal_rollback` / `proposal_deactivate`，ok 与 blocked 全留证。
- 路由治理化（`apps/control-server/src/server/routes/skillProposalsRoutes.js`）：`POST /:id/test`、`POST /:id/review`、`POST /:id/promote`（治理激活）、`POST /:id/reject`（保留快照驳回）、`POST /api/control/skill-intents/:id/rollback`、`POST .../deactivate`（受控下线）；GET 列表新增 `governance` 视图 + `GET /:id/governance` 单条全量（含版本快照）；错误语义 403 actor 非人类 / 404 无记录 / 409 非法状态流转。
- Console 对齐（`useControlConsoleApp.ts` + `ControlConsoleSkillProposalsPanel.vue`）：治理动作统一携带 `human:control-console` actor；面板新增治理状态 chip、测试门禁/审核通过按钮（按状态启停）、active intent 版本标识与回滚按钮；typecheck 通过。
- 支撑改动：`loadJsonIntents.js` intents 目录解析改惰性 getter（`HERMES_INTENTS_DIR` 可覆盖，测试 env 隔离），`proposals.js` 全部切换 getter。
- 测试：`scripts/test/proposalGovernance.test.mjs` 11/11（S4-06 全覆盖：_inbox 默认不可执行+自动投递只写 inbox、自动晋级拒绝 15 例全 blocked+审计、未测试/未审核激活拒绝、测试门禁三类失败证据、人工审核流转、审核后激活成功含版本证据、激活失败自动回滚（只读目录+只读文件注入）、人工回滚 v2→v1→完全下线且 2 条版本记录保留、驳回保留快照、受控下线保留版本、HTTP 路由全链路）；全量回归 **266/266**（基线 255 + 新增 11）；`node --check` 全部改动文件通过；control-console typecheck 通过；临时目录 env 隔离不污染真实 config/state。
- 文档：`ai/control_architecture.md` 3.4 路由域 + 4.1 已完成能力最小同步；`ai/memory/TASK_QUEUE.md` 已更新。