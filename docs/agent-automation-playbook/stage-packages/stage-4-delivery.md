# 阶段 4 交付包：生产扩展与平台治理

> 依据 `12-自动生产系统总实施与测试计划.md` 第 10 节编写。
> 交付日期：2026-08-15。执行：kimi-code。复核：project-manager-agent（阶段门）。

## 1. 任务完成清单

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| AUTO-E01 角色资产生产链路 | completed | `scripts/test/storyAssetPrimaryGate.test.mjs`（13） |
| AUTO-E02 锁定资产到场景渲染闭环 | completed | `scripts/test/sceneRenderGate.test.mjs`（8） |
| AUTO-E03 批量场景生产队列 | completed | `scripts/test/sceneBatchQueue.test.mjs`（6） |
| AUTO-F01 多项目隔离与配额 | completed | `scripts/test/multiProjectIsolation.test.mjs`（10） |
| AUTO-F02 proposal 测试、审核、晋级与回滚 | completed | `scripts/test/proposalGovernance.test.mjs`（11） |
| HERMES-H04 项目与 workflow 注册表 | completed | `scripts/test/projectWorkflowRegistry.test.mjs`（12） |

未完成：无。**至此总计划阶段 0-4 全部任务完成。**

## 2. 必测用例结果索引

统一验证命令：`node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs`
当前结果：**278/278 通过**（2026-08-15 复跑确认；阶段 3 基线 218 → 阶段 4 末 278，新增 60 例）。

| 用例 | 覆盖位置 | 结果 |
| --- | --- | --- |
| S4-01 角色锁定图仅在真实文件存在且视觉评审通过后写 `primaryReferenceAssetUri` | `storyAssetPrimaryGate.test.mjs`（评审失败/skipped 假通过/无记录 409、文件缺失 400、三方一致成功路径） | PASS |
| S4-02 缺 reference 场景渲染 BLOCKED；合法 reference 进渲染输入；产物回填过 validate/export | `sceneRenderGate.test.mjs`（输入装配真实字节断言、回填+导出证据、失败隔离 deepEqual） | PASS |
| S4-03 ≥3 scene 入队；单失败按策略恢复；成功 scene 不被覆盖 | `sceneBatchQueue.test.mjs`（顺序证据、退避恢复、显式 regenerate、重启断点继续） | PASS |
| S4-04 双项目并发/交替，projectId/artifacts/日志/配额无串写 | `multiProjectIsolation.test.mjs`（对照证据、429 配额拒绝、失败隔离三对组合） | PASS |
| S4-05 越过项目根写入拒绝；单项目失败不污染另一项目 | 同上（`..%2f` 越界 400、`reference_path_outside_project`） | PASS |
| S4-06 `_inbox` proposal 不可自动激活；测试+人工审核才晋级；失败回滚保留版本 | `proposalGovernance.test.mjs`（非人类 actor 15 例全拒、激活失败自动回滚、v2→v1 版本保留） | PASS |
| S4-07 第二项目注册后 Hermes 只见注册能力；同一治理模型各自隔离 | `projectWorkflowRegistry.test.mjs`（demo-image-site 全链路、storage/projects 零变化、跨项目拒绝） | PASS |

真实服务说明：交付时判断 ComfyUI 不可达、MOONSHOT_API_KEY 失效（401）为环境事实。2026-08-15 复核：ComfyUI 系未启动而非故障（已启动，四项能力验证全 ok）；Kimi key 系误测 api.moonshot.cn，实为 Kimi For Coding 平台有效 key 并已全链路验证。E01-E03 的图片真实生成/视觉评审当时无法端到端验证，机制验收以注入点（`STUDIO_ENABLE_TEST_HOOKS=1`）+ 真实文件系统证据完成，未伪造任何图片/评审/导出物；各任务单附真实服务手工复现步骤。

## 3. 修改文件与关键设计决定

### GameStudio Server（图片链路）

- `apps/server/src/ai/storyAssetReferenceGate.js`（E01 新增）：reference 文件校验（项目边界/存在/非空/格式 sniff）+ 评审真实性判定；`sniffImageMetaFromBytes` 单点化。
- `apps/server/src/index.js`：select/persistPrimaryReferenceLock/lock_confirm 三处写入门禁（E01）；场景渲染缺引用 409 BLOCKED + referenceImages 输入绑定 + scene_bind 文件校验（E02）；scene batch 三路由 + 启动恢复钩子（E03）；`:id` 路径边界中间件（F01）。
- `apps/server/src/ai/storyAssets.js`：renderSpec live 判定替代快照（E02）。
- `apps/server/src/ai/sceneBatchQueue.js`（E03 新增）：per-scene checkpoint、串行执行、C02 同源失败分类、成功保护、断点恢复。
- `apps/server/src/ai/background.js`：测试注入点（仅 `STUDIO_ENABLE_TEST_HOOKS=1`）。

### Control Server（平台治理）

- `persistentQueue.js`：每项目配额 + projectId 回写（F01）。
- `intents/proposalGovernance.js`（F02 新增）：proposal 生命周期状态机、测试门禁、版本快照、回滚；移除无门禁 `promoteProposal` 等旧路径。
- `reasoning/projectWorkflowRegistry.js` + `registryWorkflowRunner.js` + `routes/registryRoutes.js`（H04 新增）：注册表、触发门禁、受控 runner（dry_run + waiting_review + 证据强制）。
- `cronGovernance.js`：白名单改以注册表为唯一事实源（H04）。

### 关键设计决定（详见各任务单）

1. 「写入引用 → 渲染输入 → 场景绑定」三处共用同一套文件+评审真实性判定（E01 门禁原语）。
2. 缺引用一律 BLOCKED，禁止降级无参考生成；人工挑选不视为评审（skipped 兜底假通过判 `review_unavailable`）。
3. scene 批量队列放 GameStudio 项目内（per-scene checkpoint 属项目数据，随真相源持久化，双侧重启都能恢复）；control 经 API 提交 + `/ai/tasks` 观测。
4. 配额计量不含 waiting_review（防同 project 死锁）；双门禁（HTTP 429 前置 + dispatch 兜底），恢复路径不受配额阻断。
5. proposal 治理：actor 是人类身份唯一闸门（model/cron/agent/auto 前缀一律拒绝）；版本记录只增不删，回滚=移动指针+恢复快照。
6. 注册表：内建条目代码级合并不可破坏；reviewPolicy 必填且禁止 `none`；runner 完成强制 waiting_review + 证据逐项校验。

## 4. 已知风险与后续

### 环境风险（最终验收前置）

- **MOONSHOT_API_KEY（2026-08-15 已验证可用）**：直连 api.kimi.com/coding/v1 与系统内右脑监察全链路均 200；早前 401 结论系误测 api.moonshot.cn。
- **ComfyUI 不可达**：E01-E03 真实出图验收前置。
- **OMLX memory rewrite 持续 500**（H02 演练实测）：影响长任务收尾步骤。

### 技术遗留

- core 接线 glue 的注入式测试策略（与阶段 2/3 同一取舍，靠回归 + smoke + review 覆盖）。
- 治理前已激活的 6 个存量 JSON intent 无版本记录（首次回滚返回 `governance_record_not_found`，受控下线可用）。
- runner 当前仅 dry_run executor；第二项目接真实生产需代码登记新 executor。
- 编辑器对 409 阻断仅错误消息呈现，无专门阻断态样式。

## 5. 反向搜索

1. **无门禁 proposal 晋级路径**：`promoteProposal`/`rejectProposal`/`deactivateActiveIntent` 旧函数已移除，`grep -rn "promoteProposal" apps/control-server/src` 仅余注释说明；所有晋级走 `proposalGovernance.js` 状态机（测试断言非人类 actor 全拒）。
2. **缺参考降级生成**：场景渲染缺引用一律 409 `scene_reference_missing`，原静默 `continue` 降级路径已移除（E02 测试断言零写入）。
3. **cron 白名单双轨**：`isCronWorkflowRegistered` 以注册表为唯一事实源，H02 测试不回归。
