# Control + GameStudio 生产工作流联调测试说明

本文定义 Control 与 GameStudio 联动时，什么才算“正确的生产工作流测试通过”。

目标不是证明某个接口能返回，也不是证明 ComfyUI 能单独出图，而是证明：

- Control 以任务方式发起。
- GameStudio 显式承担生产执行。
- 每个关键阶段都有可追溯日志、artifacts 和项目落盘证据。
- 最终结果可用于继续生产，而不是停留在临时调试。

相关系统边界见 [系统生产级推进方案.md](系统生产级推进方案.md) 和 [PROJECT_GOVERNANCE.md](PROJECT_GOVERNANCE.md)。

## 1. 测试目标

本联调测试分两段推进，目前两段均已完成验证：

1. **已完成验证**：文本互动故事创建闭环。
2. **已完成验证（2026-08-05）**：图文资产锁定与正式合成闭环——《狼来了》项目实测通过（3 角色锁定 + 线稿、11/11 场景图、资源回填、校验、重新导出、dist 可玩；三级图片审核门禁在案）。

第二段已覆盖最关键的生产阶段：

- Story Bible 生成
- asset plan 生成
- 锁定事物测试与参考图落盘
- 正式场景合成（背景+立绘分层合成）
- 资源回填、校验、重新导出

现行生产操作手册（22 步全链路 + 「生成 → 完整度核实 → 定向修复 → 再核实」内容质量闭环）见 [狼来了内容质量闭环工作流.md](狼来了内容质量闭环工作流.md)。

## 2. 系统分工

### Control 负责

- 接收用户任务
- 生成 plan
- 请求人工 review / approve（`productionTest=true` 时可 bypass）
- 调用 GameStudio Server
- 记录 reasoning session、step artifacts、evaluator 结果
- 基于确定性证据给出结论

### GameStudio 负责

- 读写项目文件
- 生成 Story Bible
- 生成 asset plan
- 触发图片工作流
- 将图片与评审结果落盘
- 执行资源回填、校验、导出

### 不允许的路径

- Control 直接把 ComfyUI 视为生产入口
- 用单独 curl 打 ComfyUI 当作生产通过
- 只看模型回答，不看 GameStudio 落盘结果
- 跳过 Story Bible 阶段直接把缺失数据静默补齐后宣称流程通过

## 3. 当前已验证内容

文本故事创建链路已经具备生产测试价值，验证目标包括：

- Control 将请求分类为 story workflow。
- Control 通过任务流创建项目并写入生成配置。
- Hermes/OMLX 生成 scripts 候选（`productionTest` + `requireModelAnswer=true` 时走真实模型）。
- GameStudio 写入 scripts、编译 blueprint、编译合成层。
- GameStudio 执行 validate / export。
- Control 根据 artifacts 返回结论。
- Story Bible 由 GameStudio 显式生成并持久化到 `project.json`。

这部分可视为 S1 文本互动故事闭环的已验证基础。

## 4. 2026-05-18 阶段联调覆盖的链路（历史记录）

> 本节为 2026-05-18 阶段记录；当前状态以 §8、§11 为准。

截至 2026-05-18，本轮联调已经覆盖到以下真实链路：

- Control 以 reasoning session 发起 story workflow，并完成自动审核流（`productionTest=true` 时 bypass 所有 review）。
- Control 已显式调用 GameStudio 的 Story Bible、asset plan、图片前置检查、资产候选、校验、导出相关步骤。
- GameStudio 的 `step_story_create_bible` 在当前回归样本中已能实际执行并写回结果，不再停在 `invalid_story_bible` 前置失败。
- Story Bible 质量已从保底输出（characters=0）提升到真实内容（characters=4, locations=2）。
- `productionTest` review bypass 已完整实现，自动化测试不再被 review gate 阻塞。
- 生产测试脚本已补上 stale lock 回收和退出清锁，异常中止后不会继续长期堵住后续 case。

当时本轮联调还不是“完整生产验收通过”，原因不是入口错了，而是后段门禁仍未全部打通（后已于 2026-08-05 全部打通，见 §8）。

## 5. 当前 Story Bible 阶段状态

当前测试结论已经更新为：

- Story Bible 阶段在联调路径中是显式执行的，不再用“看不到 `story.bible` 日志”作为当前结论。
- `L4-05` 最近一次回归里，`step_story_create_bible` 为 `PASS`，并继续推进到了 asset plan 和图片 provider preflight。
- 最近一次回归中未再出现 `invalid_story_bible`。

Story Bible 质量已显著提升：

- **此前**：`characters=0, props=0, locations=1`（保底输出）
- **当前**：`characters=4, props=0, locations=2`（小红帽、狼、猎人、奶奶 + 森林、奶奶家）

因此，当前更准确的说法是：

- Story Bible 阶段已经从“前置硬阻断”修到“可执行、可落盘、可生成真实内容”。
- Story Bible 质量**已达到可用水平**，但复杂故事（多角色、多道具）的稳定性仍需更多样本验证。

## 6. 正确的 Control + GameStudio 生产工作流

下面这条链路是下一步实施和验收时必须遵守的标准流程。

### 阶段 A. Control 发起任务

输入：

- 用户 prompt
- projectId 或“新建故事”指令
- 期望风格、模型、生产目标

必须满足：

- 进入 reasoning session
- 生成明确 plan
- 关键 mutation step 需要 review / approve（`productionTest=true` 时可 bypass）
- 所有 step 均可回放

应留证据：

- sessionId
- plan steps
- review records
- step artifacts

### 阶段 B. GameStudio 显式生成 Story Bible

标准入口：

- `POST /api/projects/:id/ai/story/bible`

必须满足：

- 由 Control 调用 GameStudio 发起
- GameStudio 生成 Story Bible
- Story Bible 写入项目或可读持久化结果
- 服务端出现 `story.bible` start / ok / fail 日志

通过标准：

- 不依赖 Control 本地推导数据替代正式 Story Bible
- 日志和项目状态都能证明 Story Bible 已生成
- 结果包含真实角色、地点、事件链（非保底输出）

### 阶段 C. GameStudio 生成 asset plan

标准入口：

- `POST /api/projects/:id/ai/story/assets/plan`

必须满足：

- 读取已存在的 Story Bible
- 输出角色、道具、地点等锁定对象
- 明确哪些对象需要参考图锁定
- 结果持久化到项目目录

应留证据：

- asset plan 文件或可读结果
- Control artifacts
- GameStudio server log

### 阶段 D. GameStudio 执行锁定测试

标准入口：

- `POST /api/projects/:id/ai/story/lock/test`

必须满足：

- GameStudio 选择 lock target
- GameStudio 调用图片工作流生成测试图
- 测试图落盘到项目 `assets/ai/story_lock_tests/`
- 评审结果落盘或可回溯
- Control 只记录 GameStudio 的返回和证据，不替代执行

应留证据：

- `story.lock_test` start / ok / fail / error 日志
- 生成图片路径
- prompt / negative prompt
- 分析结果或人工复核标记
- traceId

### 阶段 E. GameStudio 执行正式场景合成

这是下一步最关键的测试目标。

这里的“合成”包含两层含义：

- 文本合成层：`project.json` / `story.json` 的运行态结构编译
- 视觉合成层：基于锁定角色、地点、道具去执行正式场景出图或分镜出图

下一步联调时，必须重点验证视觉合成层，而不是只停在 lock test。

标准要求：

- 正式场景必须引用前面锁定通过的资产或参考
- 生成结果必须落盘到项目资产目录
- GameStudio 必须负责回填 scene / resource 引用
- 完成后必须重新做资源校验和导出验证

应留证据：

- 场景图片文件
- 资源引用变更
- validate 结果
- re-export 产物
- Control 最终 answer 所引用的 artifacts

### 阶段 F. Control 基于证据收口

Control 的最终职责不是“自己生产成功”，而是基于 GameStudio 已留下的事实收口：

- 哪一步成功
- 哪一步失败
- 失败发生在哪个 GameStudio 阶段
- 哪些文件已经落盘
- 哪些日志可以复查
- 当前是否达到可继续生产的放行条件

## 7. 联调通过标准

只有满足下面条件，才能认定 `control + gamestudio` 故事生产工作流通过：

1. 任务由 Control session 发起并完成审核流（`productionTest` 可 bypass）。
2. Story Bible 由 GameStudio 显式生成并有日志，内容非保底。
3. asset plan 由 GameStudio 显式生成并持久化。
4. 锁定测试由 GameStudio 执行，测试图真实落盘，日志可追溯。
5. 正式场景合成由 GameStudio 执行，不以单张 lock test 代替。
6. 合成后完成资源回填、校验、重新导出。
7. Control 最终只基于 artifacts 和 evaluator 给出结论。

## 8. 当前联调结论

> **2026-10-13 重大版本注记**：本节的"生产工作流"已升级为**总监自治体系**。最新分工、契约与版本路线图以三份新文档为准：
> - `docs/总监自治实施方案.md`（版本路线 V0.9→V3.0 与验证门）
> - `docs/可指挥生产项目契约_v1.md`（项目侧义务）
> - local-agent-control `docs/项目总监与看门狗契约_v1.md`（守护台看门狗语义）
>
> 最新实证基线：《青蛙王子》27 步全链完成（走查 4/4 路径零问题，Guardian 人工辅助版 V0.9 达成）；《丑小鸭》无干预自治版（V1.0）验证中。守护台已具备：全链工作流、Guardian 看门狗（瞬断续跑/orphan 自愈/托管批准/失败停摆/门禁自动过闸）、任务中心守护横幅与托管开关、模型交互双源面板、本地 VL 评审兜底。

当前结论按最新事实写（2026-08-19）：

- Control + GameStudio 的 story workflow 全链路已打通：P0 文本闭环（13 步）+ P1 分层合成（资产计划 → 透明立绘锁定 → 背景批量渲染 → placements 站位 → 校验 → 重新导出）均在真实项目实测通过。
- `L4-04` evaluator false-pass 已修复（evaluator 失败记为 FAIL，回归测试 `qualityGateEvaluatorFalsePass.test.mjs` 在案）。
- Story Bible 质量已从保底输出提升到真实内容（characters=4, locations=2），且复杂故事持续靠内容质量闭环收敛。
- `productionTest` review bypass 完整可用；里程碑回归基线 393/393 全绿，里程碑后增量 406 全绿。
- 图片三级审核门禁（`pre_generate` → `lock_confirm` → `scene_bind`）、长任务进度（`/ai/tasks`）、资源互斥调度（AUTO-R01）已落地。

因此，当前工作流的正确判定是：

- P0 文本故事主链路：**达标**
- P1 图片资产闭环：**达标**（2026-08-05《狼来了》实测通过）
- 运维恢复能力：**基本达标**（持久化队列/重试/保留清理/gateway 监督恢复/orphan 收敛已落地）
- 整体生产放行：**通过**（S1/S2 可放行；S3 持续完善，当前推进内容质量闭环，见 `docs/狼来了内容质量闭环工作流.md`）

## 9. 验证检查清单

每次联调测试前，执行以下检查：

### 9.1 服务就绪检查

- [x] OMLX (`:18888`) 健康检查通过：`curl http://127.0.0.1:18888/health`
- [x] OMLX 模型列表可获取：`curl http://127.0.0.1:18888/v1/models`
- [x] GameStudio Server (`:1999`) 健康检查通过：`curl http://127.0.0.1:1999/api/health`
- [x] Control Server (`:2099`) 健康检查通过：`curl http://127.0.0.1:2099/api/health`
- [x] Control Console (`:8870`) 可访问：`curl http://127.0.0.1:8870`
- [x] Hermes Gateway (`:8742`) API 就绪：`curl http://127.0.0.1:8742/v1/models`

### 9.2 配置检查

- [ ] `config/hermes/manager.left-brain.json` 存在且有效
- [ ] `ai/AGENTS.md` 存在且非空
- [ ] `ai/memory/STATUS.md` 存在
- [ ] `ai/memory/TASK_QUEUE.md` 存在
- [ ] `config/hermes/skills/` 目录存在且非空
- [ ] `.env` 或 `.env.local` 中 `LOCALOXML_API_KEY` 已设置

### 9.3 运行时状态检查

- [ ] `getStudioSettings()` 返回有效配置
- [ ] `preflightResult.ready === true`
- [ ] Hermes Gateway 进程运行中：`ps aux | grep hermes-gateway`
- [ ] `storage/projects/` 可读写

### 9.4 内存检查（M2 32GB）

- [ ] `vm_stat` 显示空闲内存 > 2GB
- [ ] Swap 使用率 < 1GB
- [ ] OMLX 当前仅加载 1 个模型

## 10. 下一步实施要求

1. ~~收紧 `L4-04` 自动判定~~ —— 已完成（evaluator 失败记为 FAIL，回归测试在案）。
2. 继续压缩 `L1-02` 的长尾回答时间。当前已经不再复现“必须人工杀进程才能继续测试”的现场，但 answer step 停留时间仍明显过长。
3. ~~打通图片资产链~~ —— 已完成（2026-08-05 实测：锁定 → 分层合成 → 落盘 → 回填 → 校验 → 重新导出）。
4. 针对 Story Bible 继续补质量门，扩大回归样本覆盖复杂故事（多角色、多道具、多场景）。
5. 推进内容质量闭环实测：按 `docs/狼来了内容质量闭环工作流.md` 跑「完整度核实 → 定向修复 → 再核实」直到通过。
6. 维护 `productionTest` + `requireModelAnswer=true` 的自动化回归基线，确保模型生成的内容质量稳定（当前基线：里程碑 393/393 + 增量 406 全绿）。

## 11. 当前测试结果

本节只记录当前仍然有效的联调事实，不保留历史升级过程。

### 11.1 当前已确认通过的点

- `L4-01` 通过：创建项目、返回 `projectId`、项目目录和 evaluator 的链路可工作。
- `L4-05` 中的 `step_story_create_bible` 现已通过，最近回归未再出现 `invalid_story_bible`。
- Story Bible 质量提升：从保底输出（characters=0）到真实内容（characters=4, locations=2）。
- `productionTest` review bypass 已完整实现，session `reasoning_1779085704180_ddcc44a5` 13 步完成无阻塞。
- 生产测试脚本的 stale lock 回收与退出清锁已生效，最近回归结束后锁文件均能释放。
- `L5` 阶段可完整跑完，`state/reasoning-sessions`、`agent-runtime-events.jsonl`、`reasoning-review-records.jsonl` 仍具备追溯价值。

### 11.2 当前仍然存在的阻塞项

- `L1-02` 的 `step_generate_capability_answer` 仍会长时间停留。最近回归结果是最终可完成，但当前只能判断为“未根治的长尾问题”。
- ~~`L4-04` 自动误判~~ —— 已修复（evaluator 失败记为 FAIL，回归测试在案）。
- ~~`L4-05` 图片资产链停在 `image_provider_not_ready`~~ —— 已打通（2026-08-05《狼来了》实测：锁定 → 分层合成 → 回填 → 重新导出全链路通过）。
- `L5` 运维恢复：可观测、取消、持久化队列、重试、orphan 收敛、gateway 监督恢复均已落地；剩余「停止 production test」等个别运维入口见 `系统生产级推进方案.md` §13。

### 11.3 当前放行判断

基于最新事实（2026-08-19），当前放行判断为：

- L1 模型链路硬门禁：**达标**（里程碑回归 393/393 全绿，里程碑后增量 406 全绿）
- P0 文本故事生产闭环：**达标，可放行**
- P1 图片资产闭环：**达标，可放行**（2026-08-05《狼来了》实测通过）
- 运维恢复能力：**基本达标**（队列/重试/恢复/收敛已落地，最终验收演练待做）
- Control + GameStudio 整体生产工作流：**通过**（S1/S2 可放行；S3 持续完善）

### 11.4 当前建议的下一轮联调重点

1. 按 `docs/狼来了内容质量闭环工作流.md` 跑内容质量闭环：完整度核实 → 定向修复 → 再核实，直到全节点 PASS。
2. 以 `L1-02` 为准继续处理长回答尾延迟，目标从“能完成”提升到“稳定收口且耗时受控”。
3. 扩大回归样本覆盖复杂故事（多角色、多道具、多场景），沉淀 Story Bible 质量门。
4. 维护 `productionTest` + `requireModelAnswer=true` 的自动化回归基线，覆盖不同故事类型。
