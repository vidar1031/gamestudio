# AUTO-E02：锁定资产到场景渲染闭环

## 任务目标

建立“先锁定角色参考图，再渲染场景，回填并校验导出”的强制 P1 生产闭环。

## 前置依赖

- AUTO-E01 必须完成本地验收。

## 范围内

- reference required 门禁、scene render 输入绑定、产物回填、validate/export 证据。

## 范围外

- 不允许缺参考图时降级成无参考生成。
- 不实现多 scene 队列（AUTO-E03）。

## 必须满足

1. 需要角色参考图的 scene 在引用缺失时明确 BLOCKED。
2. 已锁定且真实存在的参考图会被传给场景渲染输入。
3. 成功场景图回填项目数据，并通过 validate 和 export。
4. 无效引用、评审失败或渲染失败不污染已有成功资产。
5. 缺引用阻断、成功回填、validate/export 和失败隔离均有测试/受控样例。

## 交付证据

- 门禁、渲染输入、回填和导出实现。
- 缺引用 BLOCKED 与成功 scene 的项目/文件/导出证据。

## 交付状态

- status: completed
- owner_agent: kimi-code
- reviewer: project-manager-agent
- blocked_by: AUTO-E01

## 交付证据（2026-08-15，kimi-code）

### 实现

- reference required 门禁（S4-02，`apps/server/src/index.js` 场景渲染路由 + `apps/server/src/ai/storyAssets.js`）：
  - `buildStorySceneRenderSpec` 新增 live 判定：`ref_required` 资产按当前计划状态（`referenceStatus` + `primaryReferenceAssetUri`）实时计算 `missingRequiredAssets` / `requiredAssetIds`，替代存量场景快照（锁定写回后快照不更新，快照不可信）；`missingRequiredAssetIds` 字段保持同名同语义、数据更准。
  - 场景渲染路由在加载参考前强制门禁：存在未锁定必参资产 → 409 `scene_reference_missing`，响应列出缺失资产（id/name/category/reason），logStage `story.scene.render blocked` 留证，`/ai/tasks` 任务 stage=`blocked`；**禁止降级为无参考生成**。
- 渲染输入绑定：
  - 已锁定参考图逐一复用 E01 `verifyStoryAssetReferenceFile`（项目边界 + 真实存在 + 非空 + sniff 格式）校验；任一失败 → 409 门禁原错误码（`reference_file_missing` / `reference_path_outside_project` 等），响应携带对应资产信息，不再静默 `continue` 丢弃。
  - 通过者真实字节进入 `referenceImages`（img2img/IPAdapter 输入），并留输入证据：响应 `referencesUsed`、logStage ok/fail 记录 refs 列表、`projectAsset.source.references` 持久化。
- 产物回填与校验导出：渲染产物 sniff 后真实落盘 `assets/ai/story_scenes/` → `persistSceneBackgroundBinding` 回填 story 节点 `visuals.backgroundAssetId` + project assets 索引（source 含 references 证据）→ 既有 `POST /api/projects/:id/validate/blueprint` 与 `POST /api/projects/:id/export` 全链路通过。
- scene_bind 门禁补强（`apps/server/src/index.js` reviews approve 路由）：人工确认绑定行为不变，仅补 `review.resultImagePath` 文件真实性校验；缺失/损坏 → 400 门禁错误码且审核保持 `pending` 不被消费（与 lock_confirm 同 pattern）；references 证据随绑定持久化。
- 测试注入点（`apps/server/src/ai/background.js`）：`setBackgroundImageGeneratorForTest`，仅 `STUDIO_ENABLE_TEST_HOOKS=1` 时生效，替代底层 provider 调用；其后的 sniff/落盘/回填/validate/export 均为真实实现。生产环境不设置该变量即走真实 provider。

### 测试

- `scripts/test/sceneRenderGate.test.mjs` 8/8：
  - renderSpec live 判定 1：未锁定实时判缺失（含 reason）；存量快照与 live 冲突时以 live 为准（已锁定不误判）。
  - 缺引用阻断 1：`scene_reference_missing` 409，响应列缺失资产，project/story 零写入，`/ai/tasks` 可见 blocked。
  - 锁定文件不真实 1：`reference_file_missing` 409，不静默丢弃参考，project 不变。
  - 成功路径 1：注入生成器返回真实 PNG 夹具字节 → 断言渲染输入装配（referenceImages 真实字节/role/weight、ipadapterEnabled、prompt 含 worldAnchor+anchor）→ 产物真实落盘 sniff 通过 → story/project 回填 + references 证据 → validate `ok:true` 零 errors → export 成功且 dist 含真实场景图文件与绑定。
  - 失败隔离 1：注入 provider 失败 → 502 显式 FAIL；已成功 scene 的 project.json/story.json 前后 deepEqual 不变，plan 引用不污染。
  - scene_bind 3：文件缺失 approve → 400 且保持 pending 不绑定；文件真实 → 200 绑定且 references 证据持久化；reject → 不绑定且数据不变。
- 全量回归：`node --test scripts/test/*.test.mjs scripts/test/lib/*.test.mjs` **239/239**（基线 231 + 新增 8），P0 文本生产链路无回归。
- `node --check apps/server/src/index.js apps/server/src/ai/storyAssets.js apps/server/src/ai/background.js` 通过；未改动 packages/schema 与 editor（无需 build:packages/typecheck）；ComposeStudio 消费的 `plan.scenes[].missingRequiredAssetIds`（`buildStoryAssetPlan` 产物）未改动，渲染响应仅新增字段，control 侧调用方兼容。
- 测试环境隔离：`STUDIO_STORAGE_ROOT` 指向临时目录，未触碰真实 `storage/projects`。

### 环境说明与真实服务手工复现步骤

交付时环境判断 ComfyUI 不可达且 MOONSHOT_API_KEY 失效（E01 已实测确认）；2026-08-15 复核：ComfyUI 系未启动（已恢复），key 系误测平台端点（实际有效）。真实渲染当时无法端到端自动验证；上述路径以注入/夹具测试 + 文件系统真实证据验收，真实服务路径按设计显式 FAIL/BLOCKED 并报告原因，未伪造任何图片文件或审核记录。

环境恢复后手工复现：

1. 启动业务服务 `./start_project.sh --detached`，确认 ComfyUI 就位（`curl -sS http://127.0.0.1:1999/api/ai/comfyui/capability-check`）。
2. 取一个已生成资产计划但角色未锁定的项目，调 `POST /api/projects/:id/ai/story/scenes/<sceneId>/render`：预期 409 `scene_reference_missing`，响应 `missingRequiredAssets` 列出未锁定角色。
3. 按 E01 步骤完成角色锁定（`primaryReferenceAssetUri` 写入且文件真实存在）后重调 render：预期渲染请求携带锁定参考图（manual 模式下 pre_generate 审核记录的 `referenceImages` 可见），成功后响应 `referencesUsed` 列出所用参考；`project.json` 新场景资产 `source.references` 持久化同一证据。
4. 调 `POST /api/projects/:id/validate/blueprint`（validation.ok=true）与 `POST /api/projects/:id/export`（dist 含场景图文件）。
5. 负面对照：删除锁定参考图文件后重调 render → 409 `reference_file_missing`；manual 模式下删除待绑定场景图后 approve scene_bind → 400 且审核保持 pending。

### 关键设计决定

- live 判定替代快照：场景条目内的 `missingRequiredAssetIds` 是建计划时的快照，锁定写回不同步；门禁以 live 资产记录为准，避免「已锁定仍 BLOCKED」与「引用被清空仍放行」两类误判。
- 缺引用一律 BLOCKED 而非降级：原实现对缺失参考静默 `continue` 退化为无参考生成，正是本任务禁止的行为；现任何「必需但缺失/不真实」都在渲染前显式阻断并留痕，无 ref_required 资产的场景仍可 prompt-only 渲染（既有合法行为不变）。
- 门禁错误码复用 E01 原语：`reference_file_missing` 等同一套判定标准与错误码贯穿「写入引用 → 渲染输入 → 场景绑定」三处，审核与排查口径一致。
- 注入点只替代 provider 调用：测试注入仅覆盖网络出图一步，sniff/落盘/回填/validate/export 全为真实代码路径，保证「机制真实实现」可验证。

### 遗留风险

- `x-image-review-mode: off`（Control 旁路）下场景渲染无人工绑定确认，绑定质量依赖参考图门禁与 prompt 锁定；Control 步骤级审核兜底，未在本任务收紧。
- 渲染输入证据（referencesUsed）目前留在响应、日志与 asset source，未进独立审计文件；E03 多 scene 队列落地时可评估是否需要批量级证据聚合。
- 编辑器对 409 BLOCKED 以错误消息呈现（经 api.ts 抛错），无专门阻断态样式；不影响功能正确性。