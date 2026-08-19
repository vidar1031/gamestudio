# 阶段 3 交付包：长期守护与人机协作

> 依据 `12-自动生产系统总实施与测试计划.md` 第 10 节编写。
> 交付日期：2026-08-15。执行：kimi-code。复核：project-manager-agent（阶段门）。

## 1. 任务完成清单

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| AUTO-C02 重试与错误分类 | completed | `scripts/test/retryPolicy.test.mjs`（8）、`queueRetry.test.mjs`（7） |
| AUTO-C03 保留清理 | completed | `scripts/test/retentionCleanup.test.mjs`（16） |
| AUTO-C04 gateway 监督恢复 | completed | `scripts/test/gatewaySupervision.test.mjs`（13） |
| AUTO-D01 Console 任务运维入口 | completed | `scripts/test/queueOperationsApi.test.mjs`（13）、`smoke_queue_operations.sh` |
| AUTO-D02 API 访问边界 | completed | `scripts/test/apiAccessBoundary.test.mjs`（15） |
| HERMES-H01 守护台治理闭环 | completed | `scripts/test/governanceApi.test.mjs`（10）、`smoke_governance_console.sh` |
| HERMES-H02 cron 受控生产触发 | completed | `scripts/test/cronGovernance.test.mjs`（11）、`smoke_cron_governance.sh`、真实演练证据 |
| HERMES-H03 右脑子 agent 监察 | completed | `scripts/test/rightBrainSupervision.test.mjs`（14）、`smoke_right_brain_supervision.sh` |

未完成：无。

## 2. 必测用例结果索引

统一验证命令：`node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs`
当前结果：**218/218 通过**（2026-08-15 复跑确认，duration ~5.4s；阶段 2 基线 111 → 阶段 3 末 218，新增 107 例）。

| 用例 | 覆盖位置 | 结果 |
| --- | --- | --- |
| S3-01 网络/503 → retry_wait 退避；schema/权限/认证不盲重试 | `retryPolicy.test.mjs`、`queueRetry.test.mjs`（退避窗口精确断言、审核类双 blocked） | PASS |
| S3-02 上限后 FAILED；取消后不重试 | `queueRetry.test.mjs`（上限 2 次收敛、retryHistory 完整、取消后零重调度） | PASS |
| S3-03 TTL 清理只删过期终结已归档；活跃/checkpoint/pending review/未归档证据受保护 | `retentionCleanup.test.mjs`（8 种非终态 + 4 种非终态 item 保护反向证据、dry-run 零副作用、幂等） | PASS |
| S3-04 gateway exit 记录；有限重启只恢复合法任务；超限明确阻断 | `gatewaySupervision.test.mjs`（含真状态机 + 真 retryPolicy 验证；人工关停 0 重启） | PASS |
| S3-05 守护台查看 queue/task 步骤/重试/审核/日志/artifact；刷新一致 | `queueOperationsApi.test.mjs`、`governanceApi.test.mjs` + 两个 smoke（取消后刷新镜像 cancelled） | PASS |
| S3-06 守护台取消/恢复/重试/审批有成功/失败/阻断反馈；生命周期不回归 | `governanceApi.test.mjs` + smoke（409 阻断透传、availableActions 未回归） | PASS |
| S3-07 无凭证/非允许来源高风险 API 拒绝；localhost 与合法凭证可用；日志不泄露 secret | `apiAccessBoundary.test.mjs`（15 例含脱敏与 fail-closed） | PASS |
| S3-08 cron 只创建已注册 workflow 任务；未注册拒绝并审计 | `cronGovernance.test.mjs`（白名单双重校验、防持久化篡改） | PASS |
| S3-09 cron 真实 P0 全程守护台可见 | 真实演练（见第 3 节）：task/session/审核/产物/终态 verdict 全程互查 | PASS（verdict=FAILED，环境根因，治理收敛正确） |
| S3-10 子 agent 只读/受控 action；越权拒绝并审计 | `rightBrainSupervision.test.mjs`（越权逐条审计、executor 零触达、凭证零泄露） | PASS |

## 3. 真实服务演练记录（H02，S3-09）

2026-08-15，环境齐备（OMLX gpt-oss-20b 已加载、control/server/editor 全启动）：

- cron job `cron_msu2odzo_67aa79` 触发 → session `reasoning_1786780014155_deaae3d3`（`origin='cron'` + 幂等键，文件事实）→ 12 步计划入队执行；同周期二次触发 `skipped_duplicate`。
- 真实产物：项目 `storage/projects/702c8750-...`《狼来了》（scripts/story/blueprint/蓝图评审 verdict=ok）。
- 终态 verdict：**FAILED**，根因为环境事实：① ComfyUI 不可达（preflight 失败边界级联）；② OMLX 对 memory rewrite 步持续 `model_task_http_500`（12 次）。
- 治理行为全部正确：C02 分类重试 3/3 + 退避 + 终态收敛 + 审计留证；人工重试/取消、job 暂停/停用均有审计；jobId↔sessionId↔taskId 全程互查；未绕过任何审核门禁；cron 未直接写 `storage/projects`。

放行条件核对：cron 真实 P0 完整收敛（FAILED 是正确收敛，故障被正确重试与终态化）✅；人为取消/审批动作可审计 ✅（governance-audit.jsonl）；模型/gateway 故障正确重试或阻断 ✅（演练实测 + C02/C04 单测）。

## 4. 修改文件与关键设计决定

### 新增模块

- `reasoning/retryPolicy.js`（C02）：确定性错误分类表 + 退避/上限 env。
- `reasoning/retentionCleanup.js`（C03）：策略表、三段清理、dry-run、可追溯报告、内存缓存淘汰原语。
- `reasoning/gatewaySupervision.js`（C04）：exit 分类、退避重启、任务传播编排。
- `server/security/apiAccessBoundary.js` + `redaction.js`（D02）：边界中间件 + 脱敏单点防线。
- `reasoning/governanceAudit.js`（H01）：四类受控动作审计 JSONL。
- `reasoning/cronGovernance.js` + `routes/cronRoutes.js`（H02）：job 注册/白名单/受控触发/幂等去重。
- `reasoning/rightBrainSupervision.js` + `routes/supervisionRoutes.js`（H03）：子 agent 身份/白名单/显式降级/建议审核流。

### Console

- `pages/GovernancePage.vue`（H01 新建，H02/H03 扩展）：待审核中心、运行健康、操作审计、定时任务、右脑监察五区块；`/governance` 路由与导航。
- `pages/SessionsPage.vue`：任务队列区块（D01）+ 产物区块（H01）。

### 关键设计决定（详见各任务单）

1. 重试=全量重跑（失败时 checkpoint 已清理，retry_wait 重新 plan），上限 3 + 指数退避控制成本；无法归类的错误保守 non_retryable。
2. 保留清理「先归档后删除」，归档失败保留原件；failed 超 TTL（30 天）才可清。
3. gateway 监督被动恢复不新造通道；人工生命周期操作绝不自动拉起（U-09 类退出只记录）。
4. API 边界按方法分类（非 GET 即高风险），默认 localhost 模式 fail-closed；脱敏做单点防线覆盖全部 4xx/5xx。
5. cron 白名单是代码级注册表，创建+触发双重校验防持久化篡改；cron 只提交受控 session，执行/审核/写入由既有队列与门禁承担。
6. 右脑白名单两级：只读集可直接调，受控集只能建议、approve 后经既有受控 API 执行；模型不可用显式降级，零伪造。

### 兼容性

- 对外 API 只增不改；既有端点形状/状态码保持；生命周期控制零改动（git diff 可证）。
- 默认配置全部安全：gateway 监督默认关、cron 无默认 job、API 边界默认 localhost。

## 5. 已知风险与阶段 4 前置条件

### 环境风险（影响阶段 4 真实验收）

- **ComfyUI 不可达**：E01-E03 图片链路的真实出图依赖，需先恢复。
- **OMLX memory rewrite 持续 500**：H02 演练实测 12 次全 500，影响长任务收尾步骤。
- **MOONSHOT_API_KEY（2026-08-15 已验证恢复）**：交付当日上午 smoke 实测 403 并按设计显式降级；当日复测直连与系统内右脑监察全链路均 200（Kimi For Coding 平台）。此前"失效"结论系误测 api.moonshot.cn 所致。

### 技术遗留

- core 接线段的注入式测试策略（残余接线风险靠 review + smoke），与阶段 2 同一取舍。
- smoke 环境 runtime 停止时重试/恢复只演示阻断路径；正向路径由单测覆盖。
- 右脑受控动作子集当前仅 retry/cancel；监察仅人工触发（可挂 cron 治理扩展）。

### 阶段 4 前置条件核对

- 代码前置全部满足（阶段 0-3 全 completed，218/218 绿）。
- E01-E03 真实出图验收依赖 ComfyUI 恢复；机制开发不依赖（注入测试），真实演练按 H02 先例记录环境说明。

## 6. 反向搜索

阶段 3 声明移除/禁止的语义：

1. **cron 匿名/越权触发**：`cronGovernance.js` 的 `CRON_WORKFLOW_REGISTRY` 白名单为代码级注册表，创建与触发双重校验；`grep -rn "storage/projects" apps/control-server/src/server/reasoning/cronGovernance.js` 无直接写路径——cron 只创建受控 session，结构性保证不直接写项目目录（有测试断言）。
2. **子 agent 越权 action**：白名单两级校验，`RIGHT_BRAIN_SUPERVISION_READ_ACTIONS` 与 actionRegistry 对齐由测试断言保护；越权建议逐条审计且 executor 零触达（测试断言）。
3. **旧 `failed + orphaned by server restart` 恢复语义**（阶段 2 声明）：全仓仅剩 2 处说明性注释，无活代码依赖（阶段 2 交付包已核）。
