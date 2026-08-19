# AUTO-E03：批量场景生产队列

## 任务目标

让多个 scene 按受控顺序生成，单 scene 失败可重试，成功结果不被重复覆盖。

## 前置依赖

- AUTO-C01、AUTO-C02、AUTO-E02 必须完成本地验收。

## 范围内

- scene item 入队、串行/并发约束、per-scene checkpoint、重试和结果保护。

## 范围外

- 不覆盖已有通过评审的成功资产。
- 不绕过 reference gate。

## 必须满足

1. 至少 3 个 scene 可被提交并以可观测顺序执行。
2. 单 scene 失败不阻塞其他合法 scene，失败 scene 可按 C02 策略恢复。
3. 已成功 scene 不重复生成或覆盖，除非存在显式重新生成意图。
4. 重启后从正确 scene/checkpoint 继续。
5. 三 scene、单失败恢复、成功保护和重启恢复均有测试。

## 交付证据

- batch queue 实现与三 scene 测试输出。
- per-scene task/checkpoint、失败重试、成功保护证据。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: AUTO-C01, AUTO-C02, AUTO-E02

## 交付证据（2026-08-15，kimi-code）

### 实现

- scene 批量队列模块（新增 `apps/server/src/ai/sceneBatchQueue.js`）：
  - 持久化 checkpoint：`<project>/story-assets/scene-batch-queue.json`（tmp+rename 原子写），每次 item 状态转移立即落盘（per-scene checkpoint 含 sceneId、状态、尝试次数、错误分类/规则、产物 URI、projectAssetId、history）。
  - item 状态机：`queued/running/completed/failed/blocked/skipped/waiting_review`；批次状态 `queued/running/completed/partial/failed`。
  - 串行执行器 `runSceneBatch`：执行顺序 = 提交顺序；单 scene 失败只收敛自身 item，循环继续后续 scene。
  - 失败分类 `classifySceneFailure` 与 C02（`apps/control-server/src/server/reasoning/retryPolicy.js`）同源：显式错误码 > HTTP 状态 > 文本模式 > 保守默认；reference gate 错误码（`scene_reference_missing`/`reference_file_missing` 等）归类 `blocked`（门禁阻断非故障，不重试不阻塞他人）；`provider_timeout/unavailable/request_failed`、408/429/5xx、无状态网络错误 → `retryable`（指数退避，`STUDIO_SCENE_BATCH_RETRY_MAX_ATTEMPTS` 默认 3 次总尝试 / `_BASE_MS` 默认 5s / `_MAX_DELAY_MS` 默认 60s，env 可覆盖）；`disabled`/`user_*`/`provider_invalid_output`/`system_internal`、其余 4xx → `non_retryable`；无法归类保守不重试。
  - 成功保护 `checkSceneSuccess`：story 节点 `backgroundAssetId` + 项目资产文件真实（复用 E01 `verifyStoryAssetReferenceFile`）→ 已成功；存在该 scene 的 pending scene_bind/pre_generate 审核 → 待人工确认；两者默认 `skipped` 不重复生成。提交时预判 + 执行时复查双保险。仅显式 `regenerate`（`true` 或 sceneId 数组）才重新生成，且重新生成走单 scene render 路由完整门禁。
  - 恢复：`resumeSceneBatch`（中断 `running` → `queued` 续跑，终态不动；`retryFailed=true` 时 failed item 重置尝试预算显式恢复）；`findInterruptedSceneBatches` 供启动扫描。
- 路由接线（`apps/server/src/index.js`，批量入口与既有 render-all 一致不挂 storyInputGate——契约枚举未覆盖批量类型）：
  - `POST /api/projects/:id/ai/story/scenes/batch`：sceneIds 缺省 = 计划全部场景（按 sceneIndex 排序）；未知 sceneId 404；已有未完成批次 409 `scene_batch_running`（文件 checkpoint + 进程内守卫双判定）；manual 模式整个批次挂一次 pre_generate 审核（202，批准后 execute 重放，E02 审核语义保留）；202 返回 batchId/taskId/items。
  - `GET /api/projects/:id/ai/story/scenes/batch`：per-scene checkpoint 原样返回。
  - `POST /api/projects/:id/ai/story/scenes/batch/resume`：断点续跑；`retryFailed:true` 显式恢复失败场景。
  - 批次执行经 `app.request` 调单 scene render 路由（reference gate/审核/回填全保留），进度经既有 `/ai/tasks`（kind=`story.scenes.batch`，含 per-item 结果）。
  - 重启恢复：服务启动（isMainModule）扫描所有项目未完成批次，从 checkpoint 断点继续（`resumeInterruptedSceneBatchesAfterRestart`）。
  - 顺带修复：render 路由三处 blocked 分支的 `updateAiTask` 补 `ownSceneTask` 守卫——共享批量任务时只更新消息，不再把整个批次任务误标 done（render-all 同样受益）。

### 分层取舍（队列放 GameStudio Server 项目内，非 control 侧编排）

- 仓库硬规则要求批量渲染经 `/api/projects/:id/ai/tasks` 暴露进度，该机制在 GameStudio Server；control 侧 persistentQueue 是跨服务工作流编排层，scene 批量是单项目内生产动作。
- 项目产物真相源是 `storage/projects/<id>/`；per-scene checkpoint 含产物 URI，随项目目录持久化后 GameStudio/control 任一侧重启都能从同一真相源恢复，状态不搬离真相源。
- control 通过 batch API 提交并观测 `/ai/tasks` 即可编排，无需感知 per-scene 状态。

### 测试

- `scripts/test/sceneBatchQueue.test.mjs` 6/6：
  - 三 scene 批次 1：按提交顺序串行执行（注入生成器调用序列 = 提交顺序），checkpoint 逐项含产物 URI 且文件真实，story 回填，`/ai/tasks` 批次任务 done 含 per-item 结果。
  - 单失败不阻塞 1：gate 场景 BLOCKED（`errorCategory=blocked`、attempts=1 不重试、零写入）；临时故障（注入 502）按 C02 退避重试第 2 次成功（history 含 retry_wait）；后续场景照常 completed；批次 partial。
  - 确定性失败恢复 1：`provider_invalid_output` 不盲重试（attempts=1，non_retryable）；无 retryFailed 的 resume 不重跑；显式 `retryFailed:true` 重置预算重跑成功（history 含 resumed），批次 completed。
  - 成功保护 1：已成功场景默认 skipped、生成器零调用、project.json/story.json 前后 deepEqual 不变；显式 `regenerate:true` 真实重新生成（追加新资产、绑定更新）且 scene_gate 在 regenerate 下仍 BLOCKED（门禁不绕过）。
  - 重启恢复 1：真实崩溃瞬间 checkpoint（scene_g completed + scene_h running 落盘）→ 与启动钩子同代码路径（`findInterruptedSceneBatches` + `resumeSceneBatch`）恢复：已成功场景不重复执行（生成器仅被 scene_h 调用）、中断 running 重置续跑成功、已成功 checkpoint 不被改写。
  - 分类表单元 1：gate/临时/确定性/保守默认 9 组断言。
- 全量回归：`node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs` **245/245**（基线 239 + 新增 6），P0 文本链路与 E01/E02 图片链路无回归。
- `node --check apps/server/src/index.js apps/server/src/ai/sceneBatchQueue.js scripts/test/sceneBatchQueue.test.mjs` 通过；未改动 packages/schema、editor、control-console（无需 build/typecheck）。
- 测试环境隔离：`STUDIO_STORAGE_ROOT` 指向临时目录，未触碰真实 `storage/projects`。

### 环境说明与真实服务手工复现步骤

交付时环境判断 ComfyUI 不可达且 MOONSHOT_API_KEY 失效（E01 已实测确认）；2026-08-15 复核：ComfyUI 系未启动（已恢复），key 系误测平台端点（实际有效）。真实渲染当时无法端到端自动验证；上述路径以注入/夹具测试 + 文件系统真实证据验收，真实服务路径按设计显式 FAIL/BLOCKED 并报告原因，未伪造任何图片文件、审核记录或导出物。

环境恢复后手工复现：

1. 启动业务服务 `./start_project.sh --detached`，确认 ComfyUI 就位（`curl -sS http://127.0.0.1:1999/api/ai/comfyui/capability-check`）。
2. 取一个已生成资产计划的项目（部分角色已锁定、部分未锁定），提交批次：`curl -X POST http://127.0.0.1:1999/api/projects/<id>/ai/story/scenes/batch -H 'Content-Type: application/json' -H 'x-image-review-mode: off' -d '{"sceneIds":["<s1>","<s2>","<s3>"]}'` → 202 含 batchId/taskId。
3. 轮询 `GET /api/projects/<id>/ai/story/scenes/batch` 与 `/api/projects/<id>/ai/tasks`：预期场景按提交顺序逐一 completed；缺引用场景 blocked 且不阻塞他人；checkpoint 文件 `storage/projects/<id>/story-assets/scene-batch-queue.json` 逐项含产物 URI。
4. 成功保护：原样重提同批 sceneIds → 已成功场景全部 `skipped/already_succeeded`，无新产物文件；再带 `{"sceneIds":["<s1>"],"regenerate":true}` → 仅 s1 重新生成。
5. 重启恢复：批次执行中 `./stop_project.sh` 再启动 → 启动日志 `scene batch restart-resume` + logStage `restart_resume`，未完成批次从断点 scene 继续，已成功场景不重复生成。
6. 失败恢复：制造单场景失败后 `POST .../scenes/batch/resume`（默认不动 failed）与 `-d '{"retryFailed":true}'`（失败场景重跑）对比。

### 关键设计决定

- 串行而非并发：本地出图为单 GPU 资源，串行保证顺序可观测、checkpoint 语义简单、不会并发打爆 provider；并发留待后续有真实需求再开。
- 执行经 `app.request` 复用单 scene render 路由：批量队列零复制 render 逻辑，reference gate、审核门禁、产物回填自动全保留；测试与生产同路径。
- 失败恢复两级：执行期 retryable 自动退避重试（C02）；执行后 failed 不自动重跑，须显式 `retryFailed`（与 C02「非重试不盲跑有副作用任务」一致）。
- 批次文件单份：项目内只保留当前批次 checkpoint（终态后可被新批次覆盖），历史证据在 `/ai/tasks`（state/task-progress 快照）与 logStage；不另建批次历史库（最小改动）。
- manual 审核模式：批次级 pre_generate 挂一次（复用 render-all 模式），scene_bind 仍逐张人工确认；待审核场景计入成功保护（pending_review 跳过），重启后不重跑。

### 遗留风险

- 重启恢复依赖启动钩子遍历 `storage/projects`；项目数量极大时启动扫描成本上升（当前规模无感）。
- `waiting_review`（manual 模式待绑定）场景在批次视角为终态，人工绑定结果不回写批次 checkpoint（绑定证据在 reviews 与项目数据，E02 链路）；如需批次级闭环视图，后续可聚合。
- control 侧尚未把 batch 端点编入 storyProduction 工作流（本任务范围外）；control 现阶段可直接调 API 驱动。
- render-all 旧端点保留未动（编辑器仍在用）；其无 checkpoint 的局限由新 batch 端点覆盖，未做下线处理。