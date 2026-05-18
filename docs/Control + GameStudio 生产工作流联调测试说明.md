# Control + GameStudio 生产工作流联调测试说明

本文定义 Control 与 GameStudio 联动时，什么才算“正确的生产工作流测试通过”。

目标不是证明某个接口能返回，也不是证明 ComfyUI 能单独出图，而是证明：

- Control 以任务方式发起。
- GameStudio 显式承担生产执行。
- 每个关键阶段都有可追溯日志、artifacts 和项目落盘证据。
- 最终结果可用于继续生产，而不是停留在临时调试。

相关系统边界见 [系统生产级推进方案.md](系统生产级推进方案.md) 和 [PROJECT_GOVERNANCE.md](PROJECT_GOVERNANCE.md)。

## 1. 测试目标

本联调测试分两段推进：

1. **已完成验证**：文本互动故事创建闭环。
2. **下一步要验证**：图文资产锁定与正式合成闭环。

其中第二段必须覆盖最关键的生产阶段：

- Story Bible 生成
- asset plan 生成
- 锁定事物测试与参考图落盘
- 正式场景合成或场景出图
- 资源回填、校验、重新导出

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

## 4. 当前联调已覆盖的实际链路

截至 2026-05-18，本轮联调已经覆盖到以下真实链路：

- Control 以 reasoning session 发起 story workflow，并完成自动审核流（`productionTest=true` 时 bypass 所有 review）。
- Control 已显式调用 GameStudio 的 Story Bible、asset plan、图片前置检查、资产候选、校验、导出相关步骤。
- GameStudio 的 `step_story_create_bible` 在当前回归样本中已能实际执行并写回结果，不再停在 `invalid_story_bible` 前置失败。
- Story Bible 质量已从保底输出（characters=0）提升到真实内容（characters=4, locations=2）。
- `productionTest` review bypass 已完整实现，自动化测试不再被 review gate 阻塞。
- 生产测试脚本已补上 stale lock 回收和退出清锁，异常中止后不会继续长期堵住后续 case。

本轮联调仍然不是“完整生产验收通过”，原因不是入口错了，而是后段门禁仍未全部打通。

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

当前结论必须按最新回归结果写，不保留旧结论：

- Control + GameStudio 的 story workflow 主链路现在可以显式走到 Story Bible、asset plan 和图片前置检查阶段。
- `L4-01` 创建项目通过，说明 P0 文本链路入口、项目创建和证据回收仍可工作。
- `L4-05` 现在的失败点已经后移到图片资产阶段，不再是 `invalid_story_bible`。
- Story Bible 质量已从保底输出提升到真实内容（characters=4, locations=2）。
- `productionTest` review bypass 已完整实现，自动化测试不再被 review gate 阻塞。
- `L4-04` 仍存在一个当前误判点：最终回答里已明确给出 `compose evaluator` 失败和 `blueprint 节点数=0`，但 case 仍被自动判成 `PASS`。
- `L1-02` 最近回归已能完成并返回 `PASS`，但 `step_generate_capability_answer` 仍会长时间停留，当前只能记为“长尾仍明显”，不能记为“已稳定修复”。
- `L5` 阶段可完整跑完，说明可观测、可取消、追溯和 deterministic final answer 路径仍可用；但自动恢复闭环仍未达标。

因此，当前工作流的正确判定是：

- P0 文本故事主链路：**达标**（文本闭环可完整执行，Story Bible 可生成真实内容）
- P1 图片资产闭环：`未达标`
- 运维恢复能力：`部分达标`
- 整体生产放行：`部分通过`（S1 文本故事可放行，S2 图文资产未放行）

## 9. 验证检查清单

每次联调测试前，执行以下检查：

### 9.1 服务就绪检查

- [ ] OMLX (`:18888`) 健康检查通过：`curl http://127.0.0.1:18888/health`
- [ ] OMLX 模型列表可获取：`curl http://127.0.0.1:18888/v1/models`
- [ ] GameStudio Server (`:1999`) 健康检查通过：`curl http://127.0.0.1:1999/api/health`
- [ ] Control Server (`:2099`) 健康检查通过：`curl http://127.0.0.1:2099/api/health`
- [ ] Control Console (`:8870`) 可访问：`curl http://127.0.0.1:8870`
- [ ] Hermes Gateway (`:8742`) API 就绪：`curl http://127.0.0.1:8742/v1/models`

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

下一步实现和测试时，必须按以下顺序推进：

1. 继续收紧 `L4-04` 这类自动判定。当前 case 已给出 `compose evaluator` 失败和 `blueprint 节点数=0`，不应继续标成业务 `PASS`。
2. 继续压缩 `L1-02` 的长尾回答时间。当前已经不再复现“必须人工杀进程才能继续测试”的现场，但 answer step 停留时间仍明显过长。
3. 继续推进图片资产链，把当前 `image_provider_not_ready` 前置边界真正打通到资产落盘、资源回填、校验、重新导出。
4. 针对 Story Bible 继续补质量门，扩大回归样本覆盖复杂故事（多角色、多道具、多场景）。
5. 建立 `productionTest` + `requireModelAnswer=true` 的自动化回归基线，确保 OMLX 模型生成的内容质量稳定。

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
- `L4-04` 仍存在自动误判：最终回答已明确写出 `compose evaluator` 失败和 `failedStage=validate_project_evaluator`，但 case 仍被自动判为 `PASS`。
- `L4-05` 虽然已不再卡死在 Story Bible 阶段，但图片资产链仍停在 `step_story_generate_asset_candidate: FAIL image_provider_not_ready`，后续 validate/export 只是阻断传播，不是闭环成功。
- `L5` 说明可观测和可取消已基本具备，但恢复 UI、错误分类、自动恢复动作和状态机绑定仍未完成。

### 11.3 当前放行判断

基于最新联调结果，当前放行判断应固定为：

- L1 模型链路硬门禁：`部分达标，未放行`
- P0 文本故事生产闭环：**达标，可放行**（文本闭环完整，Story Bible 可生成真实内容）
- P1 图片资产闭环：`未达标`
- 运维恢复能力：`部分达标，未放行`
- Control + GameStudio 整体生产工作流：`部分通过`（S1 文本故事可放行，S2 图文资产未放行）

### 11.4 当前建议的下一轮联调重点

1. 以 `L4-04` 为准继续收紧自动判定，要求 evaluator 失败不能再被自动记为业务通过。
2. 以 `L4-05` 为准继续打通图片 provider readiness、资产生成、资源回填和重新导出。
3. 以 `L1-02` 为准继续处理长回答尾延迟，目标从“能完成”提升到“稳定收口且耗时受控”。
4. 以 `L5` 为准补恢复 UI 和自动恢复状态机，再谈运维恢复放行。
5. 建立 `productionTest` + `requireModelAnswer=true` 的自动化回归基线，覆盖不同故事类型。
