# 生产缺陷与不足报告

> 本文是 `docs/` 中唯一集中记录**当前仍然存在**的生产缺陷、未实现项和系统性不足的文档。同时，本文定义了联调测试的**四阶段基准**，所有生产测试必须按阶段严格执行，不得跳过前置阶段。
>
> **关联文档**：
> - `docs/archive/KIMI_RIGHT_BRAIN_SUPERVISION_PLAN.md` — 右脑（Kimi）监督左脑任务执行的实施计划（完成态档案，已落地为 HERMES-H03），定义了评估标准、修正机制和持续测试循环。本文中的缺陷可通过该监督机制自动发现和修正。
>
> 更新规则：发现新缺陷时直接追加；修复后移动到"已修复归档"区或删除；定期清理过期条目。

---

## 联调测试基准（四阶段）

> **核心原则**：测试必须严格分段执行。前一阶段未全部通过，不得进入下一阶段。每个阶段有明确的硬性检查项（Must Pass）和观察项（Should Pass）。

---

### 第一阶段：系统启动与硬检查（S0 基础可用性）

本阶段验证所有服务可启动、可检测、可响应。任何一项失败即阻断后续阶段。

#### 1.1 服务启动顺序与检测

```
Step 1: OMLX 启动（独立进程）
  └─▶ 地址: http://127.0.0.1:18888
  └─▶ 验证: curl http://127.0.0.1:18888/health
  └─▶ 必须返回: status=healthy, default_model 已加载
  └─▶ 内存检查: current_model_memory <= 14GB（M2 32GB 上限）

Step 2: GameStudio Server + Editor 启动
  └─▶ 地址: server:1999, editor:8868
  └─▶ 验证: curl http://127.0.0.1:1999/api/health
  └─▶ editor 可访问: curl http://localhost:8868

Step 3: Control Server + Control Console 启动
  └─▶ 地址: control-server:2099, control-console:8870
  └─▶ 验证: curl http://127.0.0.1:2099/api/health
  └─▶ console 可访问: curl http://127.0.0.1:8870

Step 4: Hermes Gateway 启动
  └─▶ 地址: http://127.0.0.1:8742/v1
  └─▶ 验证: curl http://127.0.0.1:8742/v1/models
  └─▶ 必须返回 hermes-agent

Step 5: ComfyUI 启动（显式窗口）
  └─▶ 地址: http://127.0.0.1:8188
  └─▶ 路径: /Volumes/ovokit2t/ComfyUI
  └─▶ 启动方式: Terminal.app 窗口中执行 `sh ./start.sh`
  └─▶ 禁止: nohup 后台隐藏启动，必须让用户可见 ComfyUI 运行日志
  └─▶ 验证: curl http://127.0.0.1:8188/system_stats
  └─▶ 必须返回: comfyui_version, devices 含 mps
```

#### 1.2 Control 自检执行

调用 `POST /api/control/agents/:agentId/agent-runtime-sessions` with prompt `"GameStudio 自检"`，`productionTest=true`。

**硬性通过标准（Must Pass）：**

| 检查项 | 通过标准 |
|--------|----------|
| `gamestudio_ensure_running` | `ok=true`，serverHealth.ok=true，editorHealth.ok=true |
| `gamestudio_self_check` | `ok=true`，healthOk=true，settingsOk=true，diagnoseOk=true，comfyUiOk=true，imagePreflightOk=true |
| ComfyUI 检测结果 | `comfyUi.ok=true`，若 `started=true` 则必须在 Terminal 窗口中可见启动过程 |
| settings 读取 | `effective.image.provider === 'comfyui'`，`comfyuiBaseUrl` 正确 |
| diagnose | `services.scripts.ok=true`（OMLX 可达），`services.image.ok=true`（ComfyUI 可达） |

**观察项（Should Pass）：**
- `restart_control.sh` 不残留旧进程
- `storage/projects/` 可读写
- `ai/memory/` 下只有 4 个文件

#### 1.3 第一阶段测试题目（10 题）

| # | 测试题目 | 执行方式 | 通过标准 |
|---|----------|----------|----------|
| S0-T01 | OMLX 健康检查 | `curl http://127.0.0.1:18888/health` | 返回 `status=healthy`，`default_model` 已加载 |
| S0-T02 | GameStudio Server 健康检查 | `curl http://127.0.0.1:1999/api/health` | 返回 `ok=true` |
| S0-T03 | Control Server 健康检查 | `curl http://127.0.0.1:2099/api/health` | 返回 `ok=true` |
| S0-T04 | Control Console 可访问 | `curl http://127.0.0.1:8870` | HTTP 200，页面可加载 |
| S0-T05 | Hermes Gateway API 就绪 | `curl http://127.0.0.1:8742/v1/models` | 返回 `hermes-agent` |
| S0-T06 | ComfyUI system_stats 可达 | `curl http://127.0.0.1:8188/system_stats` | 返回 `comfyui_version`，`devices` 含 `mps` |
| S0-T07 | Control `ensure_running` 自检 | 调用 bootstrap workflow `gamestudio_ensure_running` | `ok=true`，`serverHealth.ok=true`，`editorHealth.ok=true` |
| S0-T08 | Control `self_check` 自检（含 ComfyUI） | 调用 bootstrap workflow `gamestudio_self_check` | `ok=true`，`comfyUiOk=true`，`imagePreflightOk=true` |
| S0-T09 | 记忆文件权威性检查 | `ls ai/memory/` | 只有 4 个文件：`STATUS.md`、`TASK_QUEUE.md`、`DECISIONS.md`、`LONG_TASKS.md` |
| S0-T10 | Studio Settings 图片配置检查 | `GET /api/studio/settings` | `effective.image.provider === 'comfyui'`，`comfyuiBaseUrl` 正确 |

---

### 第二阶段：交互测试（Control ↔ Hermes 任务分类与执行）

本阶段验证 Control 的请求分类、任务路由、Hermes 调用和结果返回的准确性。

#### 2.1 请求分类硬检查

| 测试 prompt | 期望分类 | 期望 plan 类型 | 硬性标准 |
|-------------|----------|---------------|----------|
| `"Hermes 和 OMLX 有什么区别"` | `answer_only` | 无 plan，直接回答 | 不调用任何工具，不读写文件 |
| `"GameStudio 自检"` | `gamestudio_bootstrap_execute` | bootstrap workflow | 包含 ensure_running + self_check |
| `"一口气生产一个小红帽互动故事"` | `story_workflow_execute` | **完整 P0 workflow**（13 步） | 必须包含：create_project → configure → generate_scripts → write_scripts → create_bible → compile_blueprint → review_blueprint → repair → preflight_image → compile_compose → validate → export |
| `"创建一个小红帽互动故事"`（无"完整/一口气"） | `story_workflow_execute` | **最小创建 plan**（create + inspect + answer） | 这是预期行为：未声明完整生产时只创建项目 |
| `"检查项目 ABC 的能力状态"` | `capability_status_inspection` | capability status workflow | 只读检查，不修改 |

**硬性规则**：
- `story_workflow_execute` 的 plan 必须按 prompt 中的关键词决定深度：`wantsFullP0` 关键词（完整/闭环/一口气/全链路/生产/P0）触发 13 步完整链路；缺少这些关键词时触发最小创建链路。
- 任何 `workflow_execute` 分类不得落入 `plan_then_answer` 兜底。

#### 2.2 Agent 记忆加载检查

| 检查项 | 通过标准 |
|--------|----------|
| Hermes 启动时记忆注入 | `ai/AGENTS.md`, `ai/USER.md`, `ai/MEMORY.md`, `ai/memory/LONG_TASKS.md`, `ai/memory/STATUS.md`, `ai/memory/TASK_QUEUE.md`, `ai/memory/DECISIONS.md` 全部存在且非空 |
| 记忆文件权威位置 | `ai/memory/` 下只有 4 个文件：`STATUS.md`, `TASK_QUEUE.md`, `DECISIONS.md`, `LONG_TASKS.md` |
| 禁止行为 | `memory/` 根目录下无新增文件 |

#### 2.3 OMLX 调用与响应检查

| 检查项 | 通过标准 |
|--------|----------|
| `response_format: json_schema` | 已知不兼容；必须 fallback 到 `chat/completions` + schema 嵌入 prompt |
| 输出非空 | `content` 字段必须有实质文本，不能全部 token 用于 `reasoning_content` |
| `max_tokens` | 故事脚本生成必须 >= 8192，防止中文截断 |
| timeout | `createStoryBible` >= 300s，`generateScriptsCandidate` >= 300s |

#### 2.4 第二阶段测试题目（10 题）

| # | 测试题目 | 执行方式 | 通过标准 |
|---|----------|----------|----------|
| L1-T01 | `answer_only` 分类准确性 | prompt: `"Hermes 和 OMLX 有什么区别"` | 分类为 `answer_only`，不调用任何工具，直接返回文本 |
| L1-T02 | `gamestudio_bootstrap_execute` 分类准确性 | prompt: `"GameStudio 自检"` | 分类为 `gamestudio_bootstrap_execute`，plan 含 `ensure_running` + `self_check` |
| L1-T03 | 完整 P0 故事 workflow 分类准确性 | prompt: `"一口气生产一个小红帽互动故事"` | 分类为 `story_workflow_execute`，plan 为 **13 步完整 P0**（非最小创建） |
| L1-T04 | 最小创建 plan 分类准确性 | prompt: `"创建一个小红帽互动故事"`（无"完整/一口气"） | 分类为 `story_workflow_execute`，plan 为 **最小创建**（create + inspect + answer） |
| L1-T05 | `capability_status_inspection` 分类准确性 | prompt: `"检查项目 ABC 的能力状态"` | 分类为 `capability_status_inspection`，只读不修改 |
| L1-T06 | `workflow_execute` 不落入 `plan_then_answer` | prompt: `"导出项目为 ZIP"` | 分类为 `workflow_execute` 或 `write_or_invoke_review`，不得落入 `plan_then_answer` |
| L1-T07 | Agent 记忆加载完整性 | 创建任意 reasoning session | Hermes 启动日志显示 7 个记忆文件全部加载成功 |
| L1-T08 | OMLX `response_format` fallback | 触发任意需要 JSON schema 的模型调用 | 请求实际走 `/chat/completions`，`content` 非空，无 `reasoning_content` 独占 token |
| L1-T09 | 中文脚本不截断 | 执行 `story_generate_scripts_candidate`，prompt 为中文长故事 | 返回脚本完整，结尾无截断，字数 > 800 字 |
| L1-T10 | `productionTest` 完整 bypass | `productionTest=true` 执行完整 story workflow | 13 步全部自动执行，无 review gate 阻塞，无人工 approve |

---

### 第三阶段：故事生成测试（P0 文本闭环）

本阶段验证故事文本生成的完整性、结构正确性和可运行性。

#### 3.1 完整 P0 工作流步骤检查

```text
step_story_create_project          → 创建项目，返回 projectId
step_story_configure_project       → 写入 meta.json 配置
step_story_generate_scripts_candidate → OMLX 生成 scripts.json 候选（fallback 必须标记）
step_story_write_scripts           → 写入 scripts.json
step_story_create_bible            → 生成 Story Bible，写入 project.state.aiBackground.storyBible
step_story_compile_blueprint       → 编译 blueprint.json
step_story_review_blueprint_agent  → Agent 评审蓝图
step_story_repair_blueprint_if_needed → 按评审修复
step_story_preflight_image_provider → 图片 provider preflight（含 ComfyUI 检测）
step_story_compile_compose         → 编译 project.json / story.json
step_story_validate_project        → 校验项目结构
step_story_export_project          → 导出 H5
```

**硬性通过标准：**

| 步骤 | 通过标准 |
|------|----------|
| `create_project` | `ok=true`，项目目录存在，含 `meta.json` |
| `generate_scripts_candidate` | `fallback=false`（若 `requireModelAnswer=true`），scripts 内容非空，含至少 2 个选择点 |
| `create_bible` | `ok=true`，`characters.length >= 2`，`locations.length >= 1`，持久化到 `project.state.aiBackground.storyBible` |
| `compile_blueprint` | `ok=true`，`blueprint.json` 存在，节点数 > 0 |
| `validate_project` | `ok=true`，无结构错误 |
| `export_project` | `ok=true`，导出产物存在 |

#### 3.2 故事结构硬检查

| 检查项 | 通过标准 | 失败处理 |
|--------|----------|----------|
| 分镜数量 | scripts.json 中 scene 节点数 >= 3 | 标记为结构不足，需重写脚本 |
| 选择点 | 至少 2 个 choice 节点，每个 choice 至少 2 个选项 | 标记为交互性不足 |
| 多结局 | 至少 2 个 ending 节点 | 标记为结局单一 |
| 剧情连贯性 | Story Bible 中的角色/地点必须在 scripts 中有对应引用 | 标记为 bible-scripts 不一致 |
| 角色一致性 | 同一角色在不同 scene 中的描述不能矛盾 | 需人工复核或 agent 评审 |

#### 3.3 已知阻塞项

- ~~`L4-04` evaluator false-pass~~：已修复（2026-08，`finalizeReasoningSessionWithQualityGate` 收紧：evaluator 失败记为 FAIL 不再自动 PASS；回归测试 `scripts/test/qualityGateEvaluatorFalsePass.test.mjs` 在案，见已修复归档 F-24）。
- `L1-02` 长尾：`step_generate_capability_answer` 耗时过长，可能阻塞测试。**测试时需设置显式超时。**

#### 3.4 第三阶段测试题目（10 题）

| # | 测试题目 | 执行方式 | 通过标准 |
|---|----------|----------|----------|
| L4-T01 | 创建项目成功 | `step_story_create_project` | `ok=true`，返回有效 `projectId`，`storage/projects/<id>/meta.json` 存在 |
| L4-T02 | 写入配置成功 | `step_story_configure_project` | `ok=true`，`meta.json` 含配置字段 |
| L4-T03 | 脚本候选真实生成（非 fallback） | `step_story_generate_scripts_candidate`，`requireModelAnswer=true` | `fallback=false`，scripts 内容非空，含至少 2 个 choice 节点 |
| L4-T04 | 写入脚本成功 | `step_story_write_scripts` | `ok=true`，`scripts.json` 存在且可读 |
| L4-T05 | Story Bible 生成与持久化 | `step_story_create_bible` | `ok=true`，`characters.length >= 2`，`locations.length >= 1`，持久化到 `project.state.aiBackground.storyBible` |
| L4-T06 | 蓝图编译成功 | `step_story_compile_blueprint` | `ok=true`，`blueprint.json` 存在，节点数 > 0 |
| L4-T07 | 蓝图评审执行 | `step_story_review_blueprint_agent` | 完成执行，返回评审意见（允许 repair 或 pass） |
| L4-T08 | 合成层编译成功 | `step_story_compile_compose` | `ok=true`，`project.json` 和 `story.json` 存在 |
| L4-T09 | 项目校验通过 | `step_story_validate_project` | `ok=true`，无结构错误，evaluator 通过 |
| L4-T10 | 项目导出成功 | `step_story_export_project` | `ok=true`，导出产物存在（如 `builds/` 或 ZIP） |

---

### 第四阶段：场景图生成与锁定（P1 图片资产闭环）

> **核心原则**：场景图生成前，**必须先完成事物锁定**。未锁定的资产不得进入正式场景渲染。锁定流程必须一步一步严格执行，不可跳过。

#### 4.1 事物锁定前置条件（硬性 gate）

在进入任何图片生成之前，必须确认：

```text
1. Story Bible 已生成且有效（characters >= 2, locations >= 1）
2. 资产计划已创建（POST /api/projects/:id/ai/story/assets/plan）
3. 资产计划包含需要锁定的资产（ref_required 策略的资产）
4. ComfyUI 已通过 preflight（system_stats 可达，必要节点存在）
5. image.provider === 'comfyui' 且 settings 中 model 已配置
```

**任何一项不满足，必须阻断，不得进入锁定测试。**

#### 4.2 事物锁定标准流程

```text
Step A: 选择锁定目标
  └─▶ 从 asset plan 中按优先级选择测试目标：
        1. category='character' 且 renderStrategy='ref_required'
        2. 任意 renderStrategy='ref_required'
        3. category='character'
        4. plan.assets[0]
  └─▶ 每个资产必须有：id, name, category, lockProfile, anchorPrompt

Step B: 生成锁定测试图（Lock Test）
  └─▶ 调用 POST /api/projects/:id/ai/story/lock/test
  └─▶ 使用 ComfyUI workflow template: comfyui_story_lock_test_template.json
  └─▶ 参数：
        - model: studio.effective.image.model
        - width/height: 512x512（锁定测试默认）
        - steps: 20, cfgScale: 7
        - positivePrompt: buildStoryboardLockTestPrompt({ plan, asset, style })
        - negativePrompt: buildStoryboardLockTestNegativePrompt({ plan, asset })
        - filenamePrefix: 含 asset slug + 'lock_test'
  └─▶ 输出落盘: assets/ai/story_lock_tests/{assetSlug}_attempt_{n}_{ts}.png
  └─▶ 最多尝试次数: maxAttempts（默认 3）

Step C: AI 视觉评审（Lock Review）
  └─▶ 使用 openaiResponsesJsonForTools 调用模型视觉评审
  └─▶ 输入：生成的测试图 + 正向/负向提示词
  └─▶ 评审标准（硬性）：
        - 单主体，不能出现多个对象/多个角色
        - 清晰、完整、主体明确，不能被裁切
        - 符合目标资产描述，不能跑题
        - 背景尽量干净，便于作为锁定参考
        - 角色：身份稳定、物种/脸型/服装/关键特征正确
        - 道具：只有一个主道具，外形稳定
        - 地点：构图稳定、环境语言统一，不能混入角色特写
  └─▶ 评审输出 JSON：{ passed, score, summary, issues, revisedPrompt, revisedNegativePrompt }
  └─▶ passed=true 才可进入 Step D；否则用 revisedPrompt 重试 Step B

Step D: 保存锁定参考图
  └─▶ 测试图通过评审后，写入 asset.primaryReferenceAssetUri
  └─▶ 同时写入 project.assets 作为项目级资产引用
  └─▶ 路径: assets/ai/story_assets/{assetSlug}_{ts}.png
```

#### 4.3 场景渲染标准流程

```text
Step E: 场景渲染前置检查
  └─▶ 读取 scene render spec（buildStorySceneRenderSpec）
  └─▶ 检查该场景所需的所有 referenceAssets 是否已有 primaryReferenceAssetUri
  └─▶ 缺少任何必需的锁定参考图 → 阻断，返回 missing_required_asset

Step F: 生成场景图
  └─▶ 调用 POST /api/projects/:id/ai/story/scenes/:sceneId/render
  └─▶ prompt 组成：
        - plan.worldAnchor（世界锚点）
        - renderSpec.promptLocks（锁定资产的 anchorPrompt）
        - scene summary / bodyPrompt
  └─▶ referenceImages：所有有 primaryReferenceAssetUri 的资产图
        - category='character' 的 weight=0.9，其他 weight=0.8
  └─▶ 输出落盘: assets/ai/story_scenes/{sceneSlug}_{ts}.png
  └─▶ 项目资产引用自动写入 project.assets

Step G: 资源回填与校验
  └─▶ 场景图生成后，project.json 中对应 scene 的 visuals.background 必须更新为新生成图的 URI
  └─▶ 执行 validate_project 确认所有资源引用可解析
  └─▶ 执行 export_project 重新导出
```

#### 4.4 锁定流程硬性规则

| 规则 | 说明 | 违规后果 |
|------|------|----------|
| **必须先锁定再渲染** | 没有 `primaryReferenceAssetUri` 的资产不得作为 referenceImage 传入场景渲染 | 场景图角色/道具不一致，连续性断裂 |
| **锁定测试必须通过 AI 评审** | `passed=false` 的测试图不得保存为锁定参考 | 参考图质量不足，导致后续场景出图偏差 |
| **单主体原则** | 每张锁定测试图只能包含一个主要对象 | 多主体会导致 IP-Adapter 混淆 |
| **禁止跳过 preflight** | `image_provider_not_ready` 时必须阻断，不能静默继续 | ComfyUI 不可达时生成空图或失败 |
| **禁止直接调用 ComfyUI** | 所有图片生成必须通过 GameStudio Server API | Control 直接调 ComfyUI 会绕过资产管理和引用追踪 |
| **资产计划必须持久化** | `story-assets/plan.json` 必须落盘 | 无计划则无法追踪哪些资产需要锁定 |

#### 4.5 场景图质量检查项

| 检查项 | 通过标准 |
|--------|----------|
| 角色一致性 | 同一角色在不同场景的图中，服装/外貌/关键特征必须一致 |
| 地点一致性 | 同一地点在不同场景的图中，环境语言/色调/构图风格必须一致 |
| 道具一致性 | 同一道具在不同场景的图中，外形/材质必须一致 |
| 无水印/文字 | 图中不得出现水印、logo、文字 |
| 分辨率 | 场景图宽度 >= 768，高度 >= 1024 |
| 文件存在 | 所有引用的场景图文件必须在 `assets/ai/story_scenes/` 中真实存在 |

#### 4.6 当前 P1 阻塞项

| 编号 | 阻塞项 | 状态 | 说明 |
|------|--------|------|------|
| P1-B01 | Character asset pipeline 未实现 | 已修复（2026-08-05） | 3 角色锁定 + 线稿已在《狼来了》项目实测通过（Kimi 视觉评审 + 人工确认） |
| P1-B02 | `generateBackground` 仅支持 ComfyUI background | 已修复（2026-08-05） | 含 IP-Adapter referenceImages 的完整 workflow 已在生产实测（11/11 场景图） |
| P1-B03 | 批量场景渲染未实现 | 已修复（2026-08-05） | `POST /ai/story/scenes/render-all` 异步批量渲染，进度经 `/ai/tasks` 可见 |
| P1-B04 | 锁定评审视觉模型可用性 | 已修复（2026-08-05） | 锁定评审走 Moonshot/Kimi 视觉（`MOONSHOT_API_KEY` 配置后自动启用） |
| P1-B05 | 场景资源回填校验闭环 | 已修复（2026-08-05） | 回填 + validate + re-export 闭环实测通过；manual 模式下回填需 `scene_bind` 人工确认 |

**2026-08-05 新增规则（审核门禁与 UI 感知）：**
- 图片生成三级审核：`pre_generate`（出图前）→ `lock_confirm`（锁定确认）→ `scene_bind`（场景绑定）；`STUDIO_IMAGE_REVIEW_MODE=manual` 时默认启用，审核记录存 `<project>/reviews/image_reviews.jsonl`。
- 长任务进度必须经 `GET /api/projects/:id/ai/tasks` 可见；编辑器锁定工作区实时轮询展示。
- ComfyUI 能力检查 `GET /api/ai/comfyui/capability-check` 与自动修复 `POST /api/ai/comfyui/auto-fix`（Python 依赖安装 + 重启）已具备；生成工具页有对应能力卡片。
- 新 Story Bible 生成后旧资产计划与提示词草稿全部作废；正向 prompt 禁止携带否定词与跨故事硬编码词。
- `comfyui_controlnet_aux` 的 `config.yaml` annotator 路径必须指向本机真实安装目录（历史遗留 Windows 路径已修复）。

#### 4.7 第四阶段测试题目（10 题）

| # | 测试题目 | 执行方式 | 通过标准 |
|---|----------|----------|----------|
| P1-T01 | 资产计划创建成功 | `POST /api/projects/:id/ai/story/assets/plan` | 返回 `plan`，`assets` 数组非空，每个资产含 `id/name/category/lockProfile/renderStrategy` |
| P1-T02 | 识别 `ref_required` 锁定资产 | 读取 asset plan | 至少识别出 1 个 `renderStrategy === 'ref_required'` 的资产（角色或关键道具） |
| P1-T03 | ComfyUI preflight 通过 | `step_story_preflight_image_provider`，mode=`storyboard` | `ok=true`，`comfyUi.ok=true`，`missingNodes` 为空 |
| P1-T04 | 锁定测试图生成成功 | `POST /api/projects/:id/ai/story/lock/test` | 返回 `success=true`，`attempts` 非空，测试图落盘到 `assets/ai/story_lock_tests/` |
| P1-T05 | 锁定测试图 AI 评审通过 | 检查 lock test 返回的 `attempts[n].analysis.passed` | `passed=true`，`score >= 70`，`issues` 不阻塞 |
| P1-T06 | 锁定参考图保存成功 | 检查 asset `primaryReferenceAssetUri` | 非空，指向 `assets/ai/story_assets/` 下真实文件 |
| P1-T07 | 缺少锁定参考时场景渲染被阻断 | `POST /api/projects/:id/ai/story/scenes/:sceneId/render`，故意缺失某资产参考 | 返回 `missing_required_asset` 或 `error`，不得生成图 |
| P1-T08 | 场景渲染生成场景图 | `POST /api/projects/:id/ai/story/scenes/:sceneId/render`，所有必需参考已锁定 | 返回 `success=true`，场景图落盘到 `assets/ai/story_scenes/` |
| P1-T09 | 场景图资源回填成功 | 检查 `project.json` 中对应 scene 的 `visuals.background` | 已更新为新生成场景图的 URI |
| P1-T10 | 校验与重新导出成功 | 执行 `validate_project` + `export_project` | `validate` 通过（无 broken 引用），`export` 成功，产物含新场景图 |

> **第四阶段执行前提**：第三阶段 10 题全部通过，且 `L4-04` evaluator false-pass 已修复。

---

## P0 — 阻塞生产自动化

| # | 缺陷/不足 | 影响 | 状态 | 修复方向 |
|---|-----------|------|------|----------|
| P0-03 | **模型切换回滚可能留空模型** | unload 成功但 rollback load 失败时，OMLX 处于无模型状态 | 待验证 | rollback 失败时自动加载最小可用模型，并标记降级状态 |

---

## P1 — 影响稳定性

| # | 缺陷/不足 | 影响 | 状态 | 修复方向 |
|---|-----------|------|------|----------|
| P1-01 | **`L1-02` 长尾回答** | `step_generate_capability_answer` 耗时过长，虽最终可完成但耗时不受控 | 活跃 | 压缩 answer 生成逻辑，或设置明确的上限超时并返回降级结果 |
| P1-02 | **OMLX `response_format` workaround 脆弱性** | 当前依赖 schema 嵌入 prompt + `chat/completions` fallback；若 OMLX 更新可能再次失败 | 活跃 | 向 OMLX 上游反馈 `response_format` 问题；建立更健壮的 fallback 链 |
| P1-03 | **Control Server 全局错误处理器待观察** | 已添加 `process.on('unhandledRejection')` / `uncaughtException`，但长期稳定性仍需验证 | 待观察 | 增加错误分类、自动恢复和报警机制 |
| P1-04 | **OMLX 503/504 重试逻辑待观察** | 已添加 3 次指数退避重试，但长期效果未验证 | 待观察 | 增加重试 metrics 和失败模式分析 |
| P1-05 | **`sessionCallCounts` / `inspectModelAccessCache` 无清理** | 长期运行内存泄漏 | 活跃 | session 完成时删除旧 entry，或添加 TTL |
| P1-06 | **Port 清理不可靠** | `restart_control.sh` 等重启脚本偶发 port 占用，需手动 kill | 活跃 | 增强脚本中 port 检测和强制清理逻辑 |
| P1-07 | **模型名大小写不一致** | catalog 查找大小写敏感导致 metadata 缺失 | 活跃 | 统一使用小写 `gpt-oss-20b-mxfp4-q8` |
| P1-08 | **会话悬挂与资源泄漏** | 最长会话悬挂 61.8 小时，缺乏 TTL/硬性超时机制 | 活跃 | 设置全局会话 TTL（30~60 分钟），超时会话强制终止 |
| P1-09 | **性能统计埋点 Bug** | 多个不相关 action 出现完全相同的 min/max/avg（如 `story_create_asset_plan` 与 `story_generate_asset_candidate` 统计值完全一致） | 活跃 | 检查 `metaAnalysis.js` 或上游性能统计聚合逻辑，确保每 action 独立计算 |
| P1-10 | **`read_recent_context` 异常缓慢** | 纯读操作平均耗时 4 分钟、最大 11 分钟，存在性能退化 | 活跃 | 引入增量缓存或索引，避免全量扫描历史记录 |
| P1-11 | **服务器重启导致孤儿会话** | 33% 的失败会话明确由服务器重启导致，缺乏优雅关闭机制 | 活跃 | 重启前停止接收新请求，等待活跃会话完成或序列化状态后退出 |
| P1-12 | **会话状态机模糊** | 21% 会话被归类为 `other`（既非成功也非失败），状态流转存在灰色地带 | 活跃 | 细化状态定义：取消/超时/系统中断/未知错误 |
| P1-13 | **L1 自动判定字面词期望过苛** | 2026-07-22 删除生产代码关键词填充后，真实模型回答语义达标但逐字命中不了期望词（如要求中文回答含 `artifact`/`evaluator` 英文字面），L1 三题 FAIL；模型链路本身已被真实 e2e 证明可用 | 已知限制 | 重校准 L1 期望为语义等价子集（仅改测试脚本），或改用 `--manual-verdict` 人工判定 |
| P1-14 | **OMLX 预填内存护栏阻塞** | 双模型常驻（约 18.9GB）时 131072 token 上下文预填峰值 21.6GB 超 20.1GB 安全上限，模型调用被 `prefill_memory_exceeded` 拒绝 | 已知限制 | OMLX 侧调 Memory Guard 为 aggressive / 提高上限 / 控制常驻模型数；文档化启动前内存检查 |
| P1-15 | **规划阶段 prefill 峰值贴线导致 502 风暴** | 2026-09-06 实测：reasoning_plan 经 hermes-gateway 到 OMLX 的 prefill 峰值 ~22.66GB 贴 22.64GB 护栏，4 连 `model_task_http_502`，会话全部 orphan→blocked；同一形状请求时好时坏（机器内存压力浮动），且会话级 KV 残留（current 17.47GB）推高后续请求 | 活跃 | 降低 reasoning_plan 出站上下文与输出预留；plan 失败无 checkpoint 不可恢复，考虑在 plan 阶段前加轻量探针请求；按《运行时能力测试基准》单独治理 |
| P1-16 | **视觉评审单次漏检率**：gemma local_vl 场景评审对同一缺陷（背景画书本）两次 40 分拦下、一次 95 分误放（2026-09-27 结局二实测），单通道单次的 AI 评审不能作为唯一防线。**2026-10-03 加重实证（狐狸与葡萄 T7）**：姿势变体评审把"双尾巴"解剖错误、"攀爬→站立微笑"姿势错配、红心眼徽章服饰污染统统给到 95 分——9 张变体 AI 评审全过（8×95+1×85），人眼复核 9 张全不合格；且身份锚提示若漏写否定项（no shoes/socks/badges），变体链会系统性加鞋加徽章 | 活跃 | 关键场景人工目检兜底（本轮由 kimi 右脑审核履行）；姿势变体提示词必须写全身份锚含否定项（裸足/单尾/无徽章）；考虑评审 prompt 细化（已加"无孤立物体主体"专项）与双评/复核机制；**解剖级错误（多肢/多尾）需专项评审项，现行 prompt 覆盖不到** |
| P1-17 | **细长/小型人造道具出图命中率低**：鱼竿 5 候选仅 1 可用、浮漂两轮 12 候选仅 1 可用，均靠人工特批（manual_override 留痕）兜底；细竹竿易弯成弓、浮漂易跑题为救生圈/蛋形。**2026-10-03 扩展实证（蚂蚁搬豆 T6，微主体探针）**：微主体同样低命中——蚂蚁候选 13 张中 5 张是"老鼠"（白色大耳鼠穿裙/工装，AI 评审拒鼠正确、但把真蚂蚁也一并误拒）、黄豆候选混入老鼠与南瓜；真蚂蚁/真豆全靠人眼从候选尾部挑出特批 | 活跃 | 优化 slender/rigid 小道具与微主体提示词模板（"直竿/经典红白球浮漂/黑亮蚂蚁/带芽黄豆"等可画性措辞）；评估 ControlNet 约束；保留人工特批为正式兜底通道；**物种级误生成（鼠充蚁）需在锁定评审 prompt 加物种一致性专项** |

---

## P2 — 影响可维护性与安全

| # | 缺陷/不足 | 影响 | 状态 | 修复方向 |
|---|-----------|------|------|----------|
| P2-02 | **OMLX API key 硬编码 fallback** | `LOCALOXML_API_KEY` 未设置时回退到 `'omlx123'` | 活跃 | 移除 fallback，强制从 env 读取 |

---

## 未实现功能清单

以下不是缺陷，而是尚未进入生产级实现的能力缺口：

| # | 能力 | 当前状态 | 预期实现方式 |
|---|------|----------|--------------|
| U-01 | 完整任务状态机和阶段机 | 部分实现 | session 状态机、超时取消（B04）、持久化队列（C01）、重试分类（C02）已落地；完整阶段机语义未补全 |
| U-02 | 跨重启 checkpoint 恢复 | 部分实现 | 启动时 orphan 收敛 + 从 checkpoint `nextStepIndex` 恢复已落地（见 `ai/control_architecture.md` §4.1） |
| U-03 | 批量任务队列、暂停、取消、续跑 | 部分实现 | 持久化队列（C01：入队/领取/同项目串行/全局并发上限）、取消（B04）、自动重试（C02）与人工重试（D01）已落地；多项目批量编排未实现 |
| U-04 | `_inbox` proposal 自动化测试与晋级 | 已实现（2026-08，AUTO-F02） | 测试门禁（可编译/样例命中/理论分达标）+ 人工审核 + 晋级激活 + 版本记录与回滚，见 `ai/control_architecture.md` |
| U-05 | 完整图片资产闭环 | 已实现（2026-08-05） | Story Bible → asset plan → 锁定事物 → 分层合成（透明立绘+背景批量渲染+placements）→ 落盘 → 引用回填 → 校验 → 重新导出，《狼来了》实测通过；三级图片审核门禁在案 |
| U-06 | 生产运维 UI：一键取消/恢复 | 已实现主体（2026-08，AUTO-D01/HERMES-H01） | 守护台治理页（待审核/操作审计）+ Sessions 页「任务队列」区块（取消/恢复/重试）已落地；「停止 production test」等个别入口待补 |
| U-07 | 动态模型切换 UI 配置入口 | 未实现（后端已生效） | `workflow.modelRouting` 后端已生效，Control Console 配置面板未开放 |
| U-08 | 安全自我强化闭环 | 已实现（2026-08，AUTO-F02） | `_inbox` 审核、测试、晋级、回滚和可视化审批全流程在案 |
| U-09 | Hermes Gateway 崩溃自动重启 | 已实现（2026-08，AUTO-C04，默认关闭） | `HERMES_GATEWAY_SUPERVISION_ENABLED=true` 启用；exit 分类 + 指数退避有限重启 + 受影响任务收敛，状态见 `/api/control/supervision/state` |

---

## 已修复归档（不删除，只用于追溯）

| # | 缺陷 | 修复时间 | 修复内容 |
|---|------|----------|----------|
| F-01 | `productionTest` 不 bypass story mutation review | 2026-05-18 | `productionTest` 现在 bypass plan review、step review、write/edit review、quality gate |
| F-02 | OMLX `response_format: json_schema` 空输出 | 2026-05-18 | fallback 到 `chat/completions` + schema 嵌入 prompt |
| F-03 | Story Bible JSON 截断 | 2026-05-18 | `max_tokens` 提升到 8192 |
| F-04 | `createStoryBible` timeout 过短 | 2026-05-18 | plan 中 timeout 提升到 300s |
| F-05 | `generateScriptsCandidate` maxTokens 过小 | 2026-05-18 | `maxTokens` 从 1600 提升到 8192 |
| F-06 | Story Bible 未持久化 | 2026-05-18 | `POST /api/projects/:id/ai/story/bible` 写入 `project.state.aiBackground.storyBible` |
| F-07 | P0 workflow 缺少 `story_create_bible` 步骤 | 2026-05-18 | `appendFullP0Steps` 添加 `story_create_bible` 步骤 |
| F-08 | `wantsCreate` 正则未匹配"产出" | 2026-05-18 | 正则添加 `产出` 匹配 |
| F-09 | Control 自检未检测 ComfyUI 运行状态 | 2026-05-18 | `gamestudio_ensure_running` / `gamestudio_self_check` 新增 ComfyUI 自动检测与启动；支持 Terminal.app 显式窗口启动 |
| F-10 | `.env.example` 缺少 `COMFYUI_ROOT` 等变量 | 2026-05-18 | 已补全 `COMFYUI_ROOT`、`COMFYUI_MODELS_ROOT`、`COMFYUI_MODEL`、`HERMES_MODEL_TASK_MAX_CALLS_PER_SESSION` |
| F-11 | 生产代码硬编码测试用例关键词并向模型回答追加关键词过门禁 | 2026-07-22 | 删除 `modelRequests.js` 的 `getProductionTestExpectations` 硬编码分支与 `applyProductionTestTermCoverage`（对应 L1-21/22/23 用例已不存在于测试脚本） |
| F-12 | 非测试模式下脚本生成失败用确定性兜底脚本冒充成功 | 2026-07-22 | `story_generate_scripts_candidate`：GameStudio regenerate 失败/异常改为显式失败（`ok:false`、`retryable:true`），不再伪造模型产物 |
| F-13 | 非测试模式下 Hermes 蓝图评审失败以 `deterministic_fallback` 冒充通过 | 2026-07-22 | `story_review_blueprint_agent`：Hermes 评审失败改为显式阻断（`failedStage:'hermes_blueprint_review'`、evaluator `passed:false`、可重试） |
| F-14 | `gameStudioBootstrapWorkflows.js` 使用 `path.join` 但未 import | 2026-07-22 | 补 `import path from 'node:path'`（设 `COMFYUI_ROOT` 时原会 ReferenceError） |
| F-15 | `story_render_scene` 缺 `REASONING_ACTIONS` 元数据 | 2026-07-22 | 已在 `actionRegistry.js` 补齐注册条目 |
| F-16 | 死代码 `generateStoryScriptsCandidate`（架构修正后遗留） | 2026-07-22 | 已删除（Control 生成脚本只走 GameStudio Server） |
| F-17 | Kimi apiKey 明文存于 git 跟踪的 `manager.left-brain.json` | 2026-07-22 | 密钥移入 `.env`（`MOONSHOT_API_KEY`，`getRightBrainApiKey` 已支持 env 兜底）；`manager.left-brain.state.json` 移出 git 跟踪；git 历史旧 key 已由人工轮换（2026-08-15 验证新 key 可用） |
| F-18 | `story.bible.generate` 契约落后于实现：Control 发送的 `candidateWorldHints`/`candidateEntities`/`scenePresenceRules`/`source` 被 StoryOutputGate 拒绝 | 2026-07-22 | `StoryBibleGeneratePayloadSchema.input` 补齐四个键（服务端 `storyBible.js` 本就消费它们）；由 e2e 真实链路首次暴露——此前该路径只在 productionTest 下跑过且未含 bible 步骤 |
| F-19 | Story Bible 客户端超时不足：服务端实测生成需 513s，plan 仅给 300s | 2026-07-22 | `storyProductionWorkflows.js` 长生成步骤 `timeoutMs` 统一提升至 600000（契约上限） |
| F-20 | 全局 fetch（undici）内置 headersTimeout 约 300s，长请求被掐断且不受 AbortController 控制 | 2026-07-22 | `gameStudioServerClient.requestGameStudio` 改用 `node:http` 实现，超时完全由调用方 `timeoutMs` 控制 |
| F-21 | 记忆改写 fallback 把"刷新指令"当内容落盘：`DECISIONS.md`/`LONG_TASKS.md` 自 2026-06-18 起内容为指令文本且每日注入 planner prompt | 2026-07-23 | 两文件已重建为真实内容；`generateReasoningFileRewrite` 模型未产出有效内容时显式失败，禁止指令落盘 |
| F-22 | supervision 定时器（启动 30s + 每 30 分钟）在 meta_analysis 401 下空转烧钱，已制造 75 个无效 session | 2026-07-23 | 加 `SUPERVISION_ENABLED` 开关，默认关停；Kimi key 已轮换并验证可用（2026-08-15），需要时显式启用 |
| F-23 | 56 个历史 `waiting_review` 会话永久积压（最早 2026-04-28），无超时/升级机制 | 2026-07-23 | 超 7 天的 56 个已批量 cancel；审核队列视图列入守护台 P2 |
| F-24 | `L4-04` evaluator false-pass：`compose evaluator` 失败时 case 仍被自动判为 `PASS`（原 P0-01） | 2026-08 | `finalizeReasoningSessionWithQualityGate` 判定收紧：evaluator 失败记为 FAIL；回归测试 `scripts/test/qualityGateEvaluatorFalsePass.test.mjs` 在案 |
| F-25 | Character asset pipeline 未实现（原 P0-02） | 2026-08-05 | 分层合成路径落地：3 角色透明立绘锁定 + 线稿在《狼来了》项目实测通过（Kimi 视觉评审 + 人工确认），旧失败分支已不存在；同 P1-B01 |
| F-26 | Control API 完全无认证（原 P2-01） | 2026-08 | AUTO-D02 访问边界中间件：`CONTROL_API_ACCESS_MODE`（默认 `localhost`，写类 API 仅本机；`token` 模式支持 Bearer 凭证），拒绝写审计日志，4xx/5xx 统一脱敏 |
| F-27 | Reasoning session 文件永久累积（原 P2-04） | 2026-08 | AUTO-C03 保留清理：终态 session 超 TTL（默认 30 天）先归档后删除，queue item/checkpoint 同理；报告落 `state/retention-cleanup/` |
| F-28 | Chat history JSON 无上限（原 P2-05） | 2026-08 | 归档阈值与条目上限 env 化：`HERMES_CHAT_ARCHIVE_AFTER_DAYS`（默认 30）/ `HERMES_CHAT_MAX_ENTRIES_PER_FILE`（默认 120） |
| F-29 | 锁定步评估器按"候选生成 HTTP ok"计数假通过（"8/8 已锁定"假象，实际 5/8 落锁也放行，且穿透 qualityGate 最后防线） | 2026-09-27 | 改按落锁口径：`selectedCount === requiredAssets.length` 且无 failed/candidate_generated/deferred 残留；分母全量不裁剪；超单轮生成上限记 deferred 显式未达标、重试单调收敛；回归测试 `scripts/test/storyLockAssetReferences.test.mjs` |
| F-30 | 站位步 `skippedProps` 不参与判定（32 个 prop 未合成步骤照常通过） | 2026-09-27 | 已锁定未合成判失败（reason≠prop_reference_missing 一律阻断），计数入 summary；`scripts/test/storyLayeredWorkflow.test.mjs` 在案 |
| F-31 | 审核无身份记录，console 自动批准跨客户端接管 API 创建的 session（24 次"人工审核"10 秒秒批） | 2026-09-27 | review API 接受并审计 `actor`（console 人工 `user-console`、自动 `console-auto-approve`、API 自报）；console 自动批准仅限本页面发起的 session |
| F-32 | 失败步骤经 back 处置后重试被阻断守卫死锁：`getPriorBlockingStoryFailure` 以 lastResult 失败记录阻断一切后续步骤，含失败步骤自身的重试 | 2026-09-27 | 穿透 `blocked_by_previous_story_step` 跳过记录找到真失败步骤；失败步骤本身允许处置后重试（重试成功覆盖 lastResult 解阻断），后续步骤仍阻断 |
| F-33 | scene_bind 零视觉把关：`x-image-review-mode:off` 旁路后 aiReview=null 直接 approved（双猫事故：≥4/10 背景烤入不一致角色无人发现） | 2026-09-27 | 场景背景绑定前 AI 视觉评审（纯环境/环境匹配 location 锚点/绘本画风，新增 `sceneBackgroundReview.js`），aiReview 写入 scene_bind 记录；off 只旁路人工门禁，AI 评审 fail-closed 照常（通道不可用挂 pending 不盲批）；失败换 seed 重渲 1 次仍败则 blocked |
| F-34 | prop 分层合成未实现（"N 个 prop 暂不合成"硬编码跳过，已锁定蝴蝶/鱼/桶等永不上画布） | 2026-09-27 | placements 端点为已锁定 prop 生成确定性站位（飞虫上三分之一/地面道具角色侧前方/结局鱼桶邻位），未锁定如实 prop_reference_missing；三只小猪实测 propsPlaced=4 幂等、导出包 prop 图全入包 |
| F-35 | prop 风格 LoRA 被黑名单误杀：`flat_childrenXX` 因名字含 child 被滤、prop 又不补默认 LoRA → 写实照片风候选全灭（鱼竿 11 张/浮漂 18 张） | 2026-09-27 | 黑名单收窄（删 child/storybook/picturebook/book_illustration/genrih 误杀条目），prop 无显式 LoRA 时与角色一样补默认绘本 LoRA；实测鱼竿/浮漂候选转为绘本风 |
| F-36 | 场景背景 prompt 工程缺陷群：同一锚点中英拼两遍；道具锚点进背景与负面词 animal 自相矛盾；pig/piglet/wolf 动物名硬编码跨项目污染；误删 open book/book/pages 后"picture book"风格词诱导画实体书（3/10 场景中招） | 2026-09-27 | 背景 prompt 去重并环境化（道具改由立绘层合成，environmentLocks/subjectLocks 分离）；动物名排除改由 plan.forbiddenSubstitutes 驱动；open book/book/pages 保留（项目无关的风格词副作用抑制） |
| F-37 | worldAnchor 含"morning→golden hour 光照过渡"句进每个场景：分块生成指令未收口（单块指令已禁），且模型可违抗指令 | 2026-09-27 | 分块指令同步纯风格约束；`normalizeStoryBible` 增加确定性清洗 `sanitizeWorldAnchorText`（按句剔除时间/光照/天气词，剔空回退安全句） |
| F-38 | sceneRefs 实体引用被模型写成 "id(名字)" 复合格式，id 匹配全空 → 资产计划 scenes=0（角色/道具不进任何场景） | 2026-09-27 | `normalizeSceneRefs` 确定性剥括号尾巴；当轮人工重绑 sceneRefs（结局地点互换/鲤鱼误绑纠正）后 rebuild 计划合格 |
| F-39 | 浮漂被 `inferPropLockProfile` 误归 organic_prop（"fishing"含 fish 子串）→ 标本模板"biological silhouette/anatomy"诱导模型画鱼（8/8 候选全画成鱼） | 2026-09-27 | fish 改整词匹配；bobber/fishing float/cork float/reel/浮漂/浮标/鱼漂 归 rigid_prop（产品模板）；当轮修剖面重抽后候选即转为浮漂类物体 |
| F-40 | 安静区构图句 "quiet zone ... for H5 text overlay readability" 被模型读成"画一片写字区"，结局二连续 3 次在画面下部画出打开的书本（AI 评审拦 2 次、漏 1 次经人工目检拒掉） | 2026-09-27 | 措辞改为 "calm empty low-detail area ... no objects, no text, no letters"；同轮重渲即干净 |
| F-41 | 文本层：选择点正文残留"选项1/2"（内联情形未覆盖）、节点名"1后果1/1选择点"工程化且跨选择点重名、结局卡标题重复正文首行；meta.json stage 创建后从不更新 | 2026-09-27 | 编译层：内联选项尾段截除（仅 choices 解析成功时）、"i选择点"→选择点一/二、"i后果k"按编译序全图唯一后果一~四、"结局k"→结局一/二、结局卡 title 取首行否则回退节点名；meta.json stage 由写盘收口按派生逻辑回写（与 Hub 展示口径一致） |
| F-42 | 线稿端点（POST /ai/story/assets/lineart）全程无 /ai/tasks 任务条目，违反"长任务必须暴露进度"守则（自动链跑线稿时编辑器进度区全盲） | 2026-09-28 | 端点补 createAiTask/updateAiTask 全相位（准备/预处理/重绘/完成/失败/待审，文案带资产名），background.js 线稿生成加 onStage 回调区分预处理与重绘；编辑器 taskKindLabel/taskStageLabel 同步补 4 种 kind、19 种 stage 中文映射（全部按服务端真实写入值） |
| F-43 | 自动生产链不走锁定向导明面路径：promptGate（storyboardLockPromptGate）服务端零读写、提示词中文稿无源、story_generate_lineart 执行器写好却从未接进计划器——产物缺三件套，向导第 4 步卡死导致 5/6/7 步全部打不开（《小猫钓鱼》实测） | 2026-09-28 | ①锁定 select 写回时服务端自动模板兜底中文稿（backfillStoryAssetPromptDraftZh，不覆盖人工/AI 稿）；②锁定步 evaluator 通过后 control 写回 promptGate（confirmedBy:'control_workflow' 明示非人工点击，GET→合并→_rev PUT；全局中文稿空时经 /ai/translate 兜底）；③线稿步接入 P1 计划器（锁定步后、场景渲染前，分层/非分层两路径同插；补 mutation 名单、allowedActions、工具映射）；《小猫钓鱼》存量项目已补 8/8 线稿+promptGate，向导 2-7 步按门禁公式全可开 |
| F-44 | control 不消费 GameStudio /ai/tasks：守护台只能看到 operation 级开始/结束，"正在为 X 资产抽卡第 N 张/评审中"级进度不可见 | 2026-09-28 | gameStudioServerClient 加 listAiTasks；appendGameStudioObserverEvent 增 progress 相位（就地更新不刷屏）；锁定/线稿/场景批次三步在长调用期间每 4s 轮询转发资产级进度文案；ReasoningTaskCard 执行中行下加「最新进展」一行 |
| F-45 | 接入注册表 gamestudio baseUrl 陈旧（58227 临时端口，probe ECONNREFUSED）：23 步链 story_create_project fetch failed 全链阻断（《小红帽》首跑） | 2026-09-28/29 | PATCH /api/control/integrations/gamestudio 修正为 1999 并探活；`getPriorBlockingStoryFailure` 穿透改为循环（跳过链可连环：步0失败→步1跳过→步2跳过，单层穿透仍死锁）。**根因已查明并根治（09-29）**：`storyLayeredWorkflow.test.mjs` 设 `GAMESTUDIO_SERVER_BASE_URL` 临时端口且未隔离注册表文件，种子/迁移路径把临时端口持久化进真相源（两连实测 58227/60038）；修复=无 legacy 可迁移时种子只驻内存不落盘（projectsRegistry.js migrateLegacyIfNeeded）+ 测试用 `HERMES_PROJECTS_REGISTRY_FILE` 隔离（跑完实测真实注册表零触碰） |
| F-46 | checkpoint 回灌撤销已成功重试：`runAllReasoningStepsFrom` 在显式回退重跑（back/处置后重试）时 applyCheckpointToSession 回滚 session artifacts，旧失败态 storyProduction.lastResult 复活，把依赖守卫重新毒化（步0重试成功→步1/步2 连环"前置失败"跳过，《小红帽》首跑实测） | 2026-09-28 | 回退语义改为「未来向断点即失效」：startIndex<checkpoint.nextStepIndex 时不回灌，调用 `deleteStepCheckpointsFrom` 清理并记 checkpoint_invalidated 事件；同日补 deleteStepCheckpointsFrom 的 import 遗漏（node --check 查不出的运行期 ReferenceError，已加导入冒烟断言） |
| F-47 | 会话"清空重开"不轮换 chatSessionId、不动历史日文件，跨天回填把旧内容复制进新日文件隔天复活（已删项目链接/其他项目通报/旧错误记录混入当前会话，实测 2026-09-28.json 44 条含 20 个 sessionId） | 2026-09-29 | clear/archive-current 统一走 `sealHermesChatDayFile`（轮换+哨兵条目）；`readStoredHermesChatHistory` 跨天回填只取每个旧日文件最后哨兵之后，无哨兵旧文件整份跳过；哨兵永不泄给 UI |
| F-48 | token 水位按合并全量历史计算（含 inbound 通报/压缩摘要），用户看不到的话也占 token（"没几句话却 77%"错觉） | 2026-09-29 | `buildHermesChatWaterLevel` 统计前过滤 inbound/compacted/哨兵，与 UI 可见子集一致（实测 6311→234 tokens） |
| F-49 | 派发卡片（state/events/events.jsonl）无退役机制：已删项目/失败 session 的派发记录永存当前视图 | 2026-09-29 | 派发时从 endpoint 提取故事项目 UUID 写 `storyProjectId`；新增 `POST /api/control/events/archive` 按时间窗归档（审计不丢）；console 项目会话视图按当前线程窗口+故事项目过滤；已删项目引用渲染置灰标注「项目已删除」 |
| F-50 | 直连模型调用（direct 路由经 requestHermesChatCompletion）不落请求/响应正文，会话页无"与模型对话明细"可查 | 2026-09-29 | 每跳落盘 `state/model-dialogs/<sessionId>.jsonl`（phase/模型/messages 截断/响应截断/usage/耗时/成败），新增只读 API `GET /api/control/agents/:id/model-dialogs`；console 会话页加「模型对话明细」折叠区；乌鸦喝水 session 实测 6 跳在案（含 2 条 resp=0 的失败跳，直接指认 OMLX prefill 拒答） |
| F-51 | fill_composite 状态合成输出目录不存在即 FileNotFoundError（`assets/ai/characters/` 未建，未跑过姿势链的项目必现，乌鸦喝水实测 fill_composite_exit_1 502） | 2026-09-30 | state-variants/generate 在 spawn 前 `mkdir -p` 输出目录 |
| F-52 | 剧情状态/姿势变体"生成了却不上场"：placements 全部场景只用主参考（瓶子水位/乌鸦姿势全程不变）——生成链（prop-states/pose-states 提取 + state-variants 生成 + fill_composite）与摆位链之间缺"按场景选用"环节 | 2026-09-30 | placements 端点新增按场景选变体：道具走 stateRequirements[].sceneIds→stateVariants.stateKey；角色走 poseVariants/stateVariants 的 sceneId/sceneIds 命中；layered-produce 产出的姿势变体自动带 sceneId；角色主档写回保持主参考不被变体污染。乌鸦喝水实测：乌鸦 6 姿势（口渴/急切/思考/衔石/欢快/失落）+ 瓶子 3 态（低水位/渐升含石/满瓶）逐场景正确上场 |
| F-53 | 场景渲染系统性画出"书本"：picture_book 风格正向词含 "hand-painted storybook style"，ivision 模型把 storybook 字面画成草地上的打开书本（蚂蚁搬豆 10 场景 4 个中书中招、换 seed 重渲仍中书；乌鸦喝水时期同款事故） | 2026-10-03 | 双管齐下：正向词 "storybook style"→"watercolor style"（风格由 worldAnchor+LoRA 锚定不受影响）、负向词补 open book/closed book/storybook object/book pages/giant book/text/watermark；修复后 10/10 场景零书本通过评审 |
| F-54 | 场景渲染系统性画进动物/角色主体：三只小猪 12 场景 8 个被评审拦下（森林场景必出鹿/兔/猪剪影，五连重渲全中）——plan 场景 summary 含"大灰狼/猪"直接进入背景 prompt，且 ivision 对"storybook forest"有强动物先验 | 2026-10-03 | 三层修复：①picture_book 负向词补全量动物类（animal/cartoon animal/pig/wolf/fox/rabbit/bear/bird/deer/cow/wildlife/creature/any living being/person/character）；②风格正向改 "empty peaceful scenery, landscape environment only"；③场景内容串去 storybook 字面、明示 "scenery only, no characters, no animals"（index.js anchorOnlyBackground 分支）。修复后 12/12 零动物通过 |
| P1-21 | **资产计划退化为 bible 期 stub**：正式链 createAssetPlan 步调用 `POST assets/plan`（默认 rebuild:false）直接返回 bible 期持久化 stub——scenes 只有 start/end、资产 sceneIds 全空，后续锁定/线稿/渲染/摆位全按残缺计划跑（蚂蚁搬豆首跑：只渲染 2 个 start/end 场景、摆位 0 命中）；rebuild:true 可从 story.json 派生 10 场景但会丢锁定状态与 generatedRefs，需人工合并回填 | 活跃 | 本次人工 rebuild+合并 generatedRefs+重挂锁定恢复；根治方向：createAssetPlan 步在 plan.scenes 与 story 节点数不符时自动 rebuild 并保留既有锁定/候选字段（merge 而非覆盖），或在 bible 步就把 scenes 写全 |
| P1-18 | **可穿戴道具的模型偏置墙与过度绑定**：红色斗篷连抽 16 候选全是"穿戴人物"（ivision+flat LoRA 对 hood 类词强偏置，ghost mannequin/flat lay 强化提示也压不住）；且 bible 把角色固有穿戴物绑进全部场景（prop.hood scenes=11，与角色立绘自带斗篷重复） | 活跃 | 处置路径已验证有效：锚点修单物件化（empty/ghost mannequin）、`plan/remove-asset`+`excludedAssetIds` 固化排除；模板级改进：wearable_prop 模板默认 flat lay 措辞、bible 指令禁绑"角色固有穿戴"，bind 前做"该物件是否独立出现在画面"判定 |
| P1-19 | **OMLX 27B prefill 边际拒答**：池化缓冲残留（换模后 ~1.1GB）+ Metal 帽沿浮动（22.4GB cap）时，蓝图评审等大上下文调用被 prefill guard 拒绝，上层表现为"Unexpected end of JSON input"空响应（乌鸦喝水首跑蓝图评审二连失败；model-dialogs 明细里 resp=0 字符的两跳即铁证）。**2026-10-03 复发形态升级（狐狸与葡萄 T7）**：长产线跨步骤累积的 prompt KV 热缓存把 current 顶到 17.85GB（余量仅 4.32GB），蓝图评审需 KV+SDPA ~4.5GB 被 prefill_memory_exceeded 拒；hermes 网关把 OMLX 的 prefill 拒答**误分类为 context-length 错误**走压缩路径，压缩无可压后抛 "Context length exceeded (2,432 tokens). Cannot compress further"（agent_incomplete）——连单句小消息也 400，极具迷惑性；直连 OMLX 同 key 同窗口正常是鉴别关键。**当日三连复现（T7 蓝图评审/T6 Bible/T8 Bible+蓝图评审）后的定量结论**：8K 窗口 27B + hermes 网关注入 ~4.9K tokens，单次大调用 KV 预留池 ~3GB，OMLX `/health` 的 current_model_memory 看不到该池（实测差 ~1.6GB），金丝雀探测自身又吃池——不存在可靠的轻量预检指标 | 活跃 | **根治已落地（controlServerCore.ensureLocalModelPrefillHeadroom + runManagedReasoningTask 挂钩）**：每个受管理模型任务前确定性 unload 已加载配置模型，真实调用在自动重载（~24s）后的干净池上跑——T8 蓝图评审 4 连失败后立过（score=95）；可用 HERMES_PREFILL_PREFLIGHT_ENABLED=0 关闭。此前验证的临时处置：模型 unload/reload 手动清池；评审 payload 瘦身（已落地）。剩余优化项：gamestudio 侧直连大调用（Bible/脚本）尚未挂同款预检（在 openai.js choke point 做 prefill_400 后自动重载重试为佳） |
| P1-20 | **脚本生成结构缺陷无前置拦截**：结局卡撞名（两张"结局2"）、结局卡插在后果组中间打断邻接分组、末选择点选项直接映射结局导致后果卡孤儿/自环（乌鸦喝水首候选实测，编译出不可达结局+自环）。**2026-10-03 加重实证（三只小猪 T8）**：同款三连（结局一不可达+2后果2自环+逃跑→安居矛盾）；且 **write-scripts 步会用暂存候选覆盖人工修复**（人工修好结构→批准写入→修复被冲掉→评审仍见旧图，二连返工）；编译按卡片的 `order` 字段排序而非数组顺序（仅重排数组无效，必须改 order） | 活跃 | 本次靠右脑审核+本地编译预演发现并重排修复；write-scripts 覆盖问题的工作流级修法：人工修复后须回退到 compile 步重编译验证，不能只过写入步；建议 compile 前加确定性结构校验（结局名唯一/邻接版式/可达性/无自环），不合格显式打回脚本生成步重出 |

---

> 本文最后更新：2026-09-29
>
> **《乌鸦喝水》批次更新**：会话数据治理+模型明细采集上线（回填封印/水位口径/派发卡片 storyProjectId/归档接口/已删项目置灰/model-dialogs 采集+明细区）；23 步链第三次交付成功；新登记 P1-19（OMLX prefill 边际拒答）、P1-20（脚本结构缺陷无前置拦截）；F-45 根治（测试污染注册表：种子不落盘+测试隔离）。验收：剧情完整（口渴→水少→衔石投瓶→喝到水）、6/6 锁定（石子特批）、4/4 线稿、12/12 背景（2 张书本图被评审拦后重渲过）、35 摆位、导出 1.18MB、向导门禁全绿、模型明细 6 跳在案（含失败跳）。
>
> **《小红帽》批次更新**：23 步链（含线稿步）首次端到端交付成功；新发现并修复 F-45（注册表陈旧端口+穿透循环）、F-46（checkpoint 回灌毒化依赖守卫）；登记 P1-18（可穿戴道具偏置墙与过度绑定，处置路径已验证）。验收：10/10 锁定（狼皮/猎枪特批、斗篷过度绑定移除）、7/7 线稿、11/11 背景零阻断零烤入、48 摆位、导出 1.66MB、promptGate 工作流写回、向导门禁全绿。
>
> **《小猫钓鱼》复盘批次更新**：首轮生产复盘发现的双猫事故、锁定口径失真、prop 未分层等 12 项缺陷已全部修复归档（F-29 ~ F-41）；重跑《小猫钓鱼》端到端验收通过（12/12 落锁、10/10 背景纯净、37 摆位全对账、导出 18 引用 1.4MB）。新登记 P1-16（视觉评审单次漏检率）、P1-17（小道具出图命中率）两项限制。
>
> **元分析更新**：通过右脑 Kimi 对 286 个 reasoning sessions 进行元分析，发现会话悬挂（最长 61.8h）、性能统计埋点 Bug、`read_recent_context` 异常缓慢（平均 4m）、服务器重启导致孤儿会话（33% 失败）、21% 会话状态不明等新缺陷。详见 P1-08 ~ P1-12。
>
> **故事测试矩阵批次更新（2026-10-03，T5/T7/T6/T8 四篇全交付）**：四篇经 23 步链（reviewMode=manual，kimi 右脑逐步实质审核）交付。新修复/登记：F-53（storybook 字面偏置画书本，正负向词双修）、F-54（森林场景动物串图三层修复）、P1-19 根治（受管理模型任务前确定性清 KV 池，T8 蓝图评审 4 连失败后立过）、P1-20 加重（T8 脚本三连结构破损+write-scripts 覆盖人工修复+编译按 order 字段排序）、P1-21（资产计划退化为 bible 期 stub，rebuild 恢复）、P1-16 加重（姿势评审对双尾/姿势错配/物种漂移给 95，蚂蚁 9 张 AI 全过人眼全否）、P1-17 扩展（微主体：鼠充蚁 13 候选 5 鼠、姿势链对蚂蚁 3 轮 30 张无成——**蚂蚁姿势变体判定为当前链路不可达，T6 静态交付**）、评审 payload 瘦身（control 蓝图评审 8K 窗口预算）。
>
> 矩阵验收对照：T5《乌龟与兔子》9/9 锁定（3 特批）、12/12 背景、7 姿势上场（兔子骄傲 45→95 教训：身份服装必须进 description）、导出 2.0MB；T7《狐狸与葡萄》6/6 锁定（葡萄藤特批）、11/11 背景零烤入、8 姿势上场（两轮重生成：双尾巴/鞋徽章污染）、导出 2.05MB；T6《蚂蚁搬豆》5/5 锁定（蚁/豆全特批——鼠充蚁/南瓜充豆）、10/10 背景（4 场景书本中招 F-53 根治后零复发）、姿势墙诚实交付、导出 1.32MB；T8《三只小猪盖新房》19/19 锁定（5 特批，单轮 8 资产上限×3 轮）、12/12 背景（8 场景动物串图 F-54 三层修复后零动物）、7 姿势上场（猪变人 4 张拒、狼四足 1 张拒、锯变剑 1 张拒）、导出 2.54MB。四篇正文干净、双结局可达、promptGate 写回。
>
> 矩阵结论（用户关注的三问）：①文本与画面质量已达可用线（风格统一、画面干净）；②真实表达（姿势/道具状态随剧情上场）对"标准毛茸角色"（狐/兔/猪/狼/鸦）可用但需人眼兜底（AI 姿势评审漏检率高），对微主体（蚂蚁级）当前不可达；③稳定性主要瓶颈已非出图而是 OMLX 8K 窗口内存边际（已根治）与脚本结构无前置校验（P1-20 建议 compile 前确定性拦截，仍未做）。
>
> **《蚂蚁搬豆》姿态链重构批次（2026-10-04）**：微主体姿势变体最终定论——IPAdapter 三档矩阵（w0.3/0.5/0.85 × 不同区间）实测全失败：身份仍漂移（长翅膀/鼠耳/尾巴）且姿势词不生效（33 张无一"推豆"），叠加 09-01 历史 A/B（IPAdapter 锚死站姿），判定**生图路径对微主体不可达，参考注入也救不了**。**落地改造**：①新增 `strategy:'transform'` 确定性变换合成（transformComposite.py：倾斜/翻转/压扁/跃起/速度线/汗滴，像素级零身份漂移、无 GPU、免评审），蚂蚁 11 变体（阿力 10 + 工蚁 1）全部上场，导出重打 1.66MB；②提取链有据可依：storyPoseStates/storyPropStates 输出新增 `evidence` 字段（照抄剧情原文句子作为判断凭据，无依据不输出）；③清理 20 张废弃变体（40 文件+20 登记记录）。角色分档规则确立：毛茸标准角色走 AI 姿势变体链（狐/兔/猪/狼/鸦已验证），微主体走 transform 确定性链。
>
> **场景构图规格层落地（2026-10-04）**：摆位纯默认值兜底（角色一律底部居中同比例）的根因修复——新增 `storyComposition.js` + `POST /ai/story/composition`：本地 AI 逐场景产出构图需求单（每元素 x/y/scale/zIndex/flipH/stateKey/blocking + evidence 原文依据，坐标归一化、y 为底部锚点、透视规则入 prompt），persist=true 写入 `plan.scenes[].composition`；摆位端点按需求单执行（新建按规格、stateKey 优先选变体、`applyComposition=true` 刷新既有自动摆位）。蚂蚁搬豆实测：10 场景全规格化（低角度近景突出体型反差、豆大蚁小比例 0.6/1.0 等），导出重打。同类隐患修复：提取类调用（构图/姿势/道具）补 `max_output_tokens` 上限（缺省 8192 预留 KV 撞 prefill 护栏）；构图按场景分批串行（batch=1，单场景 ~1.7GB KV）规避环境 Metal 压力浮动下的边际拒答。
>
> **三篇重构图批次（2026-10-04）**：T5 龟兔/T7 狐狸/T8 三只小猪 全部走新构图层——清理废变体 22 条记录+88 文件（含各自 project.json 登记），AI 提取构图需求单（全带原文依据，persist 落盘），人眼审核修正 stateKey 语义错位（T8 修 8 处：劳作场景误配 scared/卡点场景误配 clever 等；T7 修 3 处：二次挑战→leaping/后果一→climbing/结局二→composed），applyComposition 刷新摆位，全部重导出。过程中 oMLX 长期运行 Metal 碎片化（基线 17.85→19.22 渐进漂移）触发 prefill 护栏连拒——重启 oMLX.app 复位后全通（此坑已第二次实证，建议纳入定期维护）。
>
> **微故事端到端测试《小鸡找妈妈》（2026-10-04）**：6 分镜小体量走完整 23 步链+新构图层，作为非长故事的管线验证。过程中三次复现并处置：①write-scripts 覆盖人工结构修复（P1-20 第三次实证，处置=修脚本+清 session lastResult 阻断链+真重启 control-server）；②脚本结构三连破损（结局不可达+二选点名污染 1后果1_2选择点+结局矛盾）按 T7 范式重建为 10 卡规范式；③compose 重编译换新节点 id 导致旧背景/计划 sceneIds 孤儿化（旧 id 场景"未找到场景"批量渲染失败）——处置=节点 id 重映射+手工补新场景+逐条批 scene_bind 审核链。鸟类角色分档结论：小鸡/母鸡/鸭子属"准微主体"——AI 姿势变体可用（8 变体身份全守住，仅 hen-hugging 人形化拒用、duck 人臂轻污染可用），与蚂蚁（全废）形成光谱。锁定 11/11（hen/bush 特批）、背景 10/10 一轮零动物零书本（F-53/F-54 持续有效）、姿势 7 个上场、构图 10 场景全规格化、导出交付。
>
> **导演层落地（2026-10-05）**：小鸡找妈妈第一幕暴露构图三病灶（主体满画幅、节拍选错、蝴蝶成头饰），修正为三层：①storyComposition 指令升级（画布刻度表 scale≤0.85/群像≤0.7、节拍规则取转折高潮句、blocking 升级为方位+间距+视线语法）；②normalize 确定性后处理（scale 硬顶、群像收窄、y<0.7 远景 scale≤0.65 的透视一致性钳制）；③渲染回验（renderComposite 逐场景出图复核）。导演版重出后：小鸡 0.55 中景可读、蝴蝶 0.2 右前方独立、空旷草地恢复、节拍落到"回头一看妈妈不见了"。已录入 docs/场景验证图/小鸡_*_导演版.webp 对照。
>
> **小鸡找妈妈三处修正（2026-10-05）**：①场景3（选择点一）背景画书（F-53 修复前批次残留）——重渲 5 轮仍退化，经对照实验（后果一同锚点重渲正常）定位为**特定场景提示词确定性空白图**（新限制）：该两场景（选择点一/后果四）连续 7+ 轮输出 9-18KB 白图/浮脸图，同项目其他场景同锚点渲染正常；处置=同地点复用换绑（选择点一←选择点二草坡图、后果四←结局二鸭舍图，bind 端点+scene_bind 留痕）。编辑器结局节点无 #编号修复（nodeLabel 对 kind!=='scene' 直接返回原名）——结局按 story 顺序补 #N。ComfyUI 长时间运行后出图退化的排查记录：先 capability-check 全绿，杀进程经 .run/comfyui-start.command 可见重启后对照实验区分"管线坏 vs 提示词坏"。
>
> **公式化生成修复（2026-10-05）**：编辑器"假日出游"事件（1/2/2 公式生成 3 选+修复幻觉出 2选择/结局3）修复双管齐下：①promptTemplates 加硬约束（按公式显式枚举"选项1、选项2，禁止选项3"，删除"若为3选则继续"逃逸句，结局枚举写死）；②新增 fitScriptCardsToFormula 确定性结构拟合（只做减不做编）：多余选择点整组删除（选择卡+其后果卡）、选项超编裁前 N 并重编号选项句与后果卡、结局裁剪重编号、后果-结局之间夹的普通卡删除、重名去重——LLM 修复的自由改写不再被信任。回归验证：同 prompt 连跑 2 次（带公式入参），均产出规范 1/2/2（铺垫→选择点一(2选)→后果一→结局一/后果二→结局二，全可达）。注意：/ai/regenerate 的公式取自请求体非项目 meta（normalizeAiStoryFormula 默认 2/2/2），测试/调用必须显式传 choicePoints/optionsPerChoice。
>
> **AI 生成草稿入口丢失修复（2026-10-05）**：Hub「AI 生成新故事」弹窗此前 aiResult 仅存组件态，关闭/刷新后无法回到上次生成（用户假日出游事件：只能重新创建）。修复：生成成功写 localStorage 草稿历史（gamestudio.ai.draftHistory，8 条去重）；弹窗表单新增"最近草稿"区（标题/公式/时间，项目已删除标灰），每条三个动作——载入继续生成（拉 scripts 回填表单+resumeDraftId 模式，"生成"变"覆盖生成（该草稿）"走 regenerate 不新建项目）、打开项目（onOpenProject 直达脚本层）、移除；同名旧稿删除逻辑在 resume 模式旁路。编辑器 tsc 通过。
>
> **结构分析公式感知修复（2026-10-05）**：analyze.js 阈值写死（"至少2选择点/结局2~3/卡片8~12"），与编辑器 1/2/2 公式设置矛盾（用户假日出游 1/2/2 被误报选择点不足）。修复：analyzeScriptsForBlueprint 第二参接 meta.aiFormula——卡片数区间按公式推导（2+cp+cp×opt+end ~ +3）、选择点数/每点选项数/结局数均按公式精确判定（新增 option_count 检查项），无公式时回退旧阈值；调用点传 meta.aiFormula。Hub 主界面新增"🕘 继续上次草稿（N）"卡片（有历史时显示，点击进弹窗的最近草稿列表）。
>
> **草稿治理：未确认不落入项目列表（2026-10-05）**：此前 AI 一生成立即成为工作台项目卡片（用户假日出游未确认草稿占位）。修复：writeAiDraftProject 写 meta.aiDraftStatus='pending'；/api/projects 与 /api/projects/summary 透传该标记；Hub 项目画廊过滤 pending（只在弹窗"最近草稿"出现）；新增 POST /api/projects/:id/confirm-draft，"进入脚本人工修改"与草稿列表"打开项目"均触发毕业（confirmed+时间戳）。端到端验证：create→pending→confirm→confirmed 全链路通过。存量无标记项目按 confirmed  grandfathered（用户需手动删旧假日出游卡片）。
>
> **草稿结果快照与"进入创建"（2026-10-05）**：生成结果视图（脚本预览/结构分析/自检）此前只存组件态，退出后无法回到该界面。修复：草稿历史条目新增 result 快照（AiCreateResult 全量，覆盖生成/重新生成/载入续作三路径均写入）；草稿行新增"查看生成结果"——直接恢复 aiResult 视图（含 resumeDraftId，可原地覆盖重出或进入创建）。毕业按钮更名"进入脚本人工修改"→"进入创建"。治理口径再确认：生成结果阶段项目仍是 pending 草稿，只有点"进入创建"才 confirm 进项目列表。
>
> **门禁契约与导演 UI（2026-10-05）**：假日出游锁定事物第 2 步卡死事件（StoryInputGate Input rejected）——编辑器圣经调用多传 style/aspectRatio/globalPrompt/storySummary（schema strict 拒收）且 title 字段名错（storyTitle→服务端读 title）。修复：客户端只发白名单字段（title/brief/scenes）。构图需求单（导演层）进编辑器：合成层右侧"场景节点属性"新增"构图需求单（导演）"折叠区——每个元素的状态/位置/大小/层级/关系/原文依据逐条可读（读 plan.scenes[].composition）。
>
> **编辑器生产托管（2026-10-05）**：dev 服务器形态导致"改了界面浏览器不更新"反复纠缠（HMR 通道随重启断、缓存陈旧）。结构性修复：editor 生产构建（vite build → apps/editor/dist）由业务服务端直接伺服——GET / 返回 index.html、/assets/* 静态资源（@hono/node-server/serve-static，EDITOR_DIST=apps/editor/dist 相对 __dirname）；前端 buildId 探针（main.tsx 轮询 /api/health 的 buildId）发现服务重启即自动 location.reload()。日常使用入口统一为 http://127.0.0.1:1999/（dev 8868 仅开发调试用）。圣经门禁修复另记：向导 input 只发白名单字段（title/brief/scenes）。
>
> **资产计划实体-场景匹配兜底增强（2026-10-05）**：假日出游资产计划 4 资产"涉及 0 个场景"事件——根因双叠加：①污染的圣经 sceneRefs 为空（API 验证调用产生的 bible 未产出 sceneRefs）；②inferSceneIdsFromText 纯包含匹配漏"乒乓球馆 vs 乒乓球台"类变体、英文名道具对中文场景文本零命中。修复：名称片段级模糊匹配（分隔符分片 + 馆/场/口/处尾缀剥离）。验证（沙盒复制项目）：乒乓球馆 0→1 场景命中；英文名道具仍需"圣经重出中文实体"治本（向导路径重生成圣经即可）。
>
> **圣经门禁 400 根治与界面新鲜度（2026-10-06）**：假日出游锁定向导第 2 步"重新生成 Story Bible"持续报 `Input rejected for story.bible.generate` 事件——10-05 客户端白名单修复后仍复发，逐层排查定位双根因：①**契约与处理器语义矛盾**（真根因）：编辑器发 `timeoutMs: 0`（服务端路由明确约定 <=0 为无限等待，本地 27B 圣经生成常超 10 分钟），但 `StoryBibleGeneratePayloadSchema` 的 timeoutMs 写死 `min(1000)`，门禁在处理器之前整包拒收；修复=schema 改为 `min(0)` 对齐处理器语义。②**前端陈旧 bundle 放大混淆**：10-05 修复已进 dist，但 buildId 探针只反映服务端重启，编辑器纯重 build 不触发自动刷新，用户标签页内存里跑旧 bundle 继续发违规字段；修复=`/api/health` 的 buildId 追加编辑器 dist 指纹（index.html mtime+size），此后任何编辑器重构建都会在 15s 内触发页面自动刷新。附带可诊断性修复：StoryInputGate 拒绝时此前只回包不落日志（排查只能靠猜 payload），现拒绝即 `console.error` 记录 type+违规字段路径。验证：schema 本地校验 timeoutMs:0 通过；探针请求（不存在项目 id）过门禁到达处理器返回 not_found（此前 400）；health 返回新形态 buildId。教训：门禁契约的每个约束必须与处理器语义双向核对，前端修复的生效确认必须落到"伺服 bundle 已含修复+用户页面已刷新"两个事实。
>
> **圣经场景上下文断管根治（2026-10-06）**：假日出游资产计划 4/9 资产场景归属错误（3 道具+球台区 0 场景）事件的确定性根因——编辑器圣经调用发 `{nodeId, nodeName, summary}` 场景字段，服务端 `summarizeInputForBibleChunks` 只认 `{sceneId, name, text}` 并按 sceneId 过滤，编辑器形状全灭：5 个生成分块零场景上下文工作，sceneRefs 分块拿空场景列表（两次重生 sceneRefs={} 的必然根因），道具因缺中文语境连 name 都英文化（次生文本匹配零命中）。control 链发正确字段形所以矩阵故事未中招。修复=服务端按文件既有别名惯例容忍双形状（summarizeInputForBibleChunks / 修复链 sceneIds / 兜底 fallbackSceneName 三处），不动编辑器。教训：loose 契约（scenes: z.array(z.any())）下的字段名错位不会在任何校验层报警，只能在消费端别名容忍或收紧契约二选一；本次选容忍（与 normChar 等既有惯例一致）。
>
> **简谱演绎定型 + 《假日出游》全链生产验证批次（2026-10-06）**：本次确立"简谱演绎"为默认档——角色 1 张主参考立绘走天下，演绎靠摆位/翻转/表情差分/字幕/运镜，逐场景姿势变体降级为可选精细档。落地内容：①导出播放器运镜（Ken Burns 式：场景入场背景 1.08→1.0 推近 + 立绘淡入 900ms 缓出，storyPixi.js renderStage）；②表情差分链（姿势需求区新增「表情差分需求」播种 expr:: 前缀需求，候选锁定默认名「表情·X」，摆位变体选择新增 expressionHit 档：compStateHit > poseHit > 表情 > 主参考）；③锁定事物第 3 步重构为场景主视图（场景→元素分组+姿态/状态预演+未分配曝光组）+「AI 分析跨场景姿态/状态」批量分析（全故事 2 次模型调用）+ 道具状态提取器升级为导演全量分析（地点纳入、appearances 逐场景使用方式、token 上限 3072）；④姿势提取提示词补镜头语言规则（行走优先背面/微侧、对话侧面、禁止超 2 镜连续正面）；⑤可观测性全套（资产计划三路对账证据 sceneEvidence 落盘+逐资产分配日志+计时、圣经产出明细日志、分析阶段进度行、门禁拒绝落服务端日志、health buildId 纳入编辑器 dist 指纹）。
>
> 《假日出游》端到端验收（kimi 全链操作+审图）：圣经（断管修复后 sceneRefs 全绑定、中文实体）→ 资产计划 7 项（可穿戴跑鞋按 P1-18 删除并并入角色锚点）→ 提示词闸（7 资产 AI 增强+全局翻译+置闸）→ 参考图抽卡 3/3 锁定（AI 评审门拦 2 张：小红 58 分背景不纯+插兜、球拍 52 分写实风跑偏——按评审修订稿重抽过审，评审闭环有效）→ 表情差分 11 张全拒（身份漂移：服装/发型漂移，IPAdapter 0.8 锁不住——已知墙，简谱档表情差分需专链或更高锚定档位）→ 线稿 3/3 → 构图 6 场景 → 背景 6/6 → 摆位 14 → 导出 3.2MB → headless 走查双结局路径画面达标（角色身份一致、摆位正确、字幕干净、选项可点）。
>
> 新发现并已修缺陷：F-55 render-all 批次内部逐场景渲染丢 `x-image-review-mode` 头（旁路调用被每场景挂 pre_generate 审核且假报"完成 6/6"——6 场景零出图事故）；F-56 同批次 pendingReview 被计为 ok（黑盒假完成）；F-57 render-all 裸跑（无 scenePrompt）走全量模式喂透明抠图参考洗白整图（08-30 已知机制在新入口复发）——处置=本次用 backgroundOnly 重跑达标，**长期修正=render-all 默认应走 backgroundOnly 分层工艺或要求分镜提示词先行（待办）**。空白图（8-18KB）由 AI 场景评审全部正确拦截（零误放进绑定）。
>
> 生产达标判断：**条件达标**。文本/画面/摆位/交互/导出全链可产出可玩作品；剩余硬约束：①表情差分身份漂移墙（本轮拒用）；②render-all 裸跑路径需收口（F-57 待办）；③场景评审重渲率偏高（6 场景 5 次重渲，LLM 评审严格但有效）；④编辑器预览无运镜（仅导出播放器有）。
>
> **地点状态标签误导修复（2026-10-07）**：假日出游验收后用户误报"地点识别了但没出图"——真相是 prompt_only/optional_ref 地点本就不出立绘（锚点词烘进背景，分层工艺设计），且四张背景实际全部达标；但场景视图给它们挂"未抽卡"红标签造成漏出图错觉。修复：新增 getAssetRefChip（非 ref_required 显示"锚点入背景"绿标），4 处用法统一替换。另：地点"状态：未分析"是因导演全量分析（含地点 appearances）升级晚于项目分析数据，重跑分析按钮即可补齐。
>
> **第 4 步提示词范围收窄（2026-10-07）**：假日出游用户二次误报——地点（prompt_only/optional_ref）出现在「全局与事物提示词」列表且被中文稿确认闸强制要求填写，但它们不出立绘、提示词无消费端（锚点词直接烘进背景），纯属误导+浪费。修复三处联动收窄为仅 ref_required：第 4 步事物提示词列表（背景锚点事物改为一行只读说明）、missingZhPromptItems 确认闸校验、AI 批量增强循环（省下每地点 1~2 分钟模型调用）。**待办登记（用户明示本次不改）**：户外球台的"球桌"应从地点锚点中拆出为独立道具资产——目前烤在地点锚点里，球桌作为剧情道具（打球场景核心器物）应独立抽卡摆位；下次资产计划迭代时处理。
>
> **F-58 提示词评分器角色盲区根修（2026-10-07，公主穿衣 34 分误报事件）**：用户手动跑公主穿衣，第 4 步 AI 生成的两个角色提示词（佳佳/艾莉）均评 34 分+"需要推倒重生"。根因：scoreStoryAssetPromptCandidate 的三条语境线（故事职责/叙事识别重点/结构关注点，各 10 分）词表全部来自小猫钓鱼道具语境（浮漂/连接点/开口容积正则），角色提示词结构性永远命中不了，被钉死在 34 分基线（12 正向+8 负向+6 白底+8 排除）并越过 50 分保留阈值误报推倒重生。修复：角色类别跳过道具语境块，改走角色专属三线——身份特征吸收（名字/锚点特征词命中）/全身正面单角色构图/神态气质可读，各 10 分对齐权重。实测：佳佳同内容提示词 34→54 分过阈值。教训：评分/门禁器的词表规则必须按资产类别分流，单语境词表跨类别必然误伤。
>
> **F-59 道具评分器三重误伤根修（2026-10-07，公主穿衣分数下降事件）**：用户重跑提示词后发现道具分数反降——裙子 29/衣架 43。诊断出三个独立误伤+一个歪打正着：①钓鱼专属规则串台：杆类分支触发词含裸 `pole`，衣架 alias "hanger pole" 命中，衣架被按竹鱼竿规则评分（isStoryAssetRodLike 与评分分支同步收紧为钓鱼语境词）；②否定盲扣分：危险人物词扣分不识别否定句，裙子"无任何人物，模特或衣架出现"被当成混入模特语义扣 18（修复=测前剥离"无/不含/没有/不出现"否定片段）；③单物件词表过窄："单独悬挂"不在白名单漏分（同义词拓宽）。④歪打正着：衣架提示词"横杆挂两件衣物"确实违反单物件原则（道具参考图挂了 2 件衣服）——这条扣分方向正确但理由词是钓鱼词表，属于 AI 提示词真实缺陷需重生成。实测：裙子 29→55 风险清零。
>
> **F-60 label 内嵌按钮点击目标 bug（2026-10-07）**：公共提示词库"点附近的 UI 也打开"——根因是 HTML label 激活行为：按钮放在 `<label>` 里时，点 label 任意位置会转发激活第一个可操作子元素（恰好是按钮）。资产提示词卡 4 处 + 姿势需求区 2 处 `<label class="story-lock-prompt-field">` 全部改 `<div>`（caption 是 span、无 htmlFor，零损失）。全局提示词区的按钮本就在 label 外，未受影响。
>
> **F-61 提示词语境标签残留修复（2026-10-07，同批次收尾）**：AI 增强会把输入侧的语境线标签（"叙事识别重点：/结构关注点：/故事职责："）连同前缀抄进提示词正文，随翻译进入生图模型。sanitizeStoryAssetPromptZh 改为剥前缀留内容；公主穿衣三资产存量已清洗重存。白裙 29→64、衣架 43→74（空衣架）、运动套装 0→64（新建），全部过 50 阈值。
>
> **一键翻译全部中文稿（2026-10-07）**：用户确认"AI 生成提示词是否默认带英文"——设计上 enhance 端点内含 zh→en 翻译步骤（translateStoryAssetPromptPair），但实测道具英文栏落的是模板兜底而非译文：内联翻译失败被 catch 静默吞掉。修复：①第 4 步新增「一键翻译全部中文稿」按钮——全局正/负向 + 各抽卡事物正/反向逐条串行翻译，英文栏已有内容或等于模板 hint 的自动跳过，进度（n/m）与逐条译文进日志；②enhance 内联翻译失败改为 logStage 显式留痕（translate_fallback 事件带错误原因）。至此提示词链全程可见：AI 生成中文稿 → 确认 → 一键翻译 → 批准。
>
> **《公主穿衣》全链生产验证批次（2026-10-07，简谱档首跑）**：手动链+修复链混合验证。落地与结论：①提示词评分器三场事故根修（F-58 角色盲区 34 分误报→角色专属三线；F-59 道具三重误伤——pole 串台/否定盲/词表窄；F-61 语境标签残留清洗）；②全局提示词评分接入向导第 4 步（原只挂分镜弹窗）+ 一键翻译全部中文稿（enhance 内联翻译静默兜底改显式留痕）；③label 内嵌按钮点击目标 bug 根修（F-60）；④抽卡链验证：7 资产锁定（佳佳钉发色重抽、镜子/球拍道具升级补入、白裙+套装因穿戴重力墙特批留痕——checkpoint 画不出无人体裙装/套装，平铺词也压不住）；⑤S4-02 门禁硬化（referenceStatus 缓存被过期合并写脏→改以 primaryReferenceAssetUri 为唯一真相，F-62）+ 存量修复；⑥锚点清洗链升级（cleanupPropReferenceAnchorText 剥展示载体从句，圣经道具指令禁展示方式）——裙子/衣架/套装重抽后载体消失。⑦背景 6/6 零重渲（backgroundOnly 正路），摆位 17 刷新，导出 3.6MB，走查双结局全通。
>
> 遗留质量项（导演层已知边界）：场景1 构图把佳佳当"消息提示"浮空布置（y=0.45 上墙，语义巧但视觉穿帮）；卧室背景烤入镜子+道具镜子重复；后果一背景混入书架（地点锚点疑似错配）。处置路径=编辑器摆位人工微调/换绑，属构图人工审核环节（矩阵期已确立的常态）。
>
> 评分器词表脆弱性定论：确定性词表对自然语言提示词结构性脆弱（同义词打地鼠三轮：单独/单件/单物/单个/独立物件…），评分器定位降为"地板检查+顾问"，语义质量归 AI 评审+人工终审，不再为分数追逐重生成。
>
> **《公主穿衣》验收反馈修复批次（2026-10-07 晚）**：用户验收四处修正——①场景内容错配：圣经 sceneRefs 把后果一/后果二错绑图书馆/网球场（正文是在卧室换装），后果一背景出现书架；修正 plan+bible 双层绑定并重渲 2 场景。②导演佳佳"消息提示"浮空上墙（y=0.45）：storyComposition 落地纪律入码（角色非飞行语义 y<0.7 一律校正 y=0.85），本项目构图数据已修正+摆位刷新，复查已落地。③导演层可见性：第 3 步场景视图叠加构图需求单明细（运镜 cameraNote + 逐元素 摆位规格/布场说明/原文依据悬停可见）。④向导日志修复：session 日志最新优先数组被 slice(-20) 截成"最旧 20 条"的顺序 bug + 任务历史跨会话载入（aiTasks 派生，API 驱动的操作也可见）。⑤"场景出图只显示一张"= 会话陈旧，既有"外部更新横幅"机制兜底（20s 轮询 _rev）。
>
> **《公主穿衣》场景1 人工导演修正（2026-10-07 晚二次）**：用户指定场景1正确布场=卧室（落地镜+衣柜）+公主对镜+双公主（真人+镜像）+佳佳不入画（她只是发消息）。执行：背景重渲两次（v1 镜子对了但没衣柜→v2 衣柜带镜门+立镜+窗，显式 prompt 覆盖生效）；摆位手工编排（撤佳佳、艾莉对镜 flipX、镜区内加小尺度正向艾莉作镜像——分层工艺下"玻璃内真反射"不可达，双摆位是简谱档逼近）；构图存档同步防刷新回退。复查通过。经验沉淀：①镜面/镜像类场景是分层合成工艺的合法例外区，镜像用"同角色二次摆位+翻转"近似；②背景缺关键家具时用显式 scenePrompt 重渲（环境锚点不够时的人工通道有效）。
>
> **《公主穿衣》场景2 修正 + F-63 抠图资产登记丢失（2026-10-07）**：场景2按用户导演意图重编——撤佳佳（车声不入画）、衣架中后方落地、白裙左挂位/运动装右挂位、艾莉左前抉择。过程中发现衣架抠图资产在 project.assets 里从未存在（不是被覆盖，是任何快照里都没有）——select 链 applyCutoutToStoryAssetReference 的 writeJson 登记未落盘，疑似写盘竞争/静默失败（同一项目第二次：角色两例+衣架/镜子/球拍三例）。处置=按 plan 的 primaryReferenceAssetId/Uri 补登记（3 条）。**F-63 根因待定位**：建议 select 链的 project.json 写入改为带 _rev 的守护通道（与 PUT 同路），禁止裸 writeJson 与其他写路径竞争。
>
> **《公主穿衣》场景2 导演内涵修正批次（2026-10-07 深夜）**：用户指出导演层没读出故事内涵——①公主在家场景默认应穿睡衣（此前穿礼服在卧室选衣服，违和）：生成艾莉睡衣变体（IPAdapter 0.9 档，散发+浅色睡衣套装，身份守住），登记为场景绑定姿势变体（sceneIds=[场景1,场景2]），摆位自动选用生效——"在家=睡衣"内涵落地。②运动装 4 件拼图错：三轮重抽（网格→平铺带人→平铺 3 件净版），选定无人体三件套平铺（特批留痕）。③场景2 要衣柜+挂衣服：背景重渲 3 轮（墙杆挂衣被拒→负向误伤自纠→敞开衣柜带挂位过审），摆位重编为白裙/运动装进衣柜挂位、艾莉睡衣面向衣柜、撤衣架道具（衣柜取代之）。④过程坑：睡衣资产登记首次写入丢失（F-63 第二次实证，重登记+落盘验证通过），摆位一度写入 null imageAssetId（已修复）。经验：变体按场景绑定（sceneIds）是"剧情阶段换装"的当前最优机制。
>
> **《公主穿衣》后四场景导演内涵修正（2026-10-08 凌晨）**：机制复用"场景绑定服装变体"做剧情阶段换装——艾莉新增两个变体：白裙礼服（绑后果一/结局一，一轮过：白裙+皇冠+身份守住）与运动装（绑后果二/结局二，三轮色彩纠偏后仍偏蓝——**服装颜色保真墙**：IPAdapter 身份锚点的基图服装色（蓝礼服）会持续拉住变体颜色，记档为已知墙，剪影像运动装即交付）。摆位重编：后果 solo 艾莉穿对应装（道具不再重复摆——她穿着了）、结局双人（佳佳入画）、结局二球拍入画。六场景全通复查：家=睡衣、抉择=衣柜挂两套、后果=对应装 solo、结局=双人同框。新增经验：服装变体链在 IPAdapter 0.88-0.9 档可用于"同一角色不同剧情阶段换装"（睡衣/礼服成功），但服装颜色受基图引力强（黑色不可得）。
>
> **《小明的工作日》换装换姿势压力测试批次（2026-10-08，OpenPose 骨架驱动链定型）**：用户指定压力案例——同一角色默认睡衣，选择点后分岔"穿西服坐办公室办公 / 穿黄色骑手服骑电动车送外卖"，直击此前确定性墙（绿幕 IPAdapter 换姿势必被拉回主参考站姿）。**结论：可实现，已端到端验证交付。**
>
> 新能力（本仓落地）：①`extractComfyuiPoseSkeleton`——任意单人图经 DWPose/OpenPose 预处理器提取姿势骨架（公共姿势库烘焙链，`storage/_shared/pose_library/`，README 含补库/用法/参数经验）；②`generateComfyuiPoseVariantSprite`——骨架图直接喂 union ControlNet(type=openpose) 锁姿势 + IPAdapter 锁身份 + 文本锁服装；③layered-produce 正式链接入：poses 项新增 `spriteAssetPath`（预生成骨架产物直供，跳过绿幕 sprite，带项目内路径守卫）与 `sceneIds[]`（一变体绑多场景）。幽灵人对照实验结论：身份参考必须用抠图（白底原图会把站姿构图漏成左侧半透明人）+ ipadapterStartAt=0.25 + 提示词以 "one single person only:" 开头。
>
> 端到端成果：7 场景全通（家=睡衣主参考、衣柜=选装、后果一=坐姿西服办公变体、结局一=站姿西服夜景变体、后果二=骑姿外卖变体、结局二=沙发瘫坐变体），变体按 sceneIds 绑定摆位自动选用全中；公共姿势库入库 3 骨架（sitting_desk / riding_ebike / standing_front）。
>
> 新发现并已修缺陷：
> - **F-64 waitComfyImage 执行错误盲**：ComfyUI 节点报错（execution_error）时 history 无 outputs，轮询一律等满超时（OpenPose 缺 skimage 的真实错误被三次 10 分钟超时掩盖）。修复=轮询识别 status_str='error' 并提取 exception_message 立即抛错（apps/server/src/ai/background.js）。
> - **F-65 资源租约无过期回收（control 仓，待办）**：客户端进程被杀后 gpu 租约永久悬挂（实测 20 分钟+），后续 LLM/出图准入全部排队堵死。本次处置=操作员通道手动 release；**待办=local-agent-control 资源调度器加租约 TTL/心跳清扫**。
> - ComfyUI 环境补齐：venv 装 scikit-image（OpenposePreprocessor 硬依赖）；OpenPose 三件权重归位 `ckpts/lllyasviel/Annotators/`（注意 comfyui_controlnet_aux 下载落盘路径嵌套层级易错）；DWPose 双件归位 `ckpts/yzd-v/DWPose/`；本机 comfyui_controlnet_aux 版本未注册 `DWPreprocessor`（DWPose 节点），骨架提取自动回退 OpenposePreprocessor，质量已达标。
> - 导演层地点错绑（结局一）：圣经 sceneRefs 把"走出公司大楼看夜景"绑到 `loc_office`（办公室内景），anchor 驱动重渲两次仍是办公室；修正 plan 场景绑定为 `loc_company_exterior` 后一次出图达标。**经验：显式 scenePrompt 覆盖不住地点锚点引力（promptLocks 仍拼接），场景地点错绑必须修绑定本身。**
> - 摆位冗余清理规则再实证：角色已穿着/立绘已含的道具（西服/骑手服/头盔/电动车/电脑桌）必须从摆位撤除，否则"穿着西服的人旁边再摆一件西服"；背景已含的事物（衣柜挂装）也不再摆道具抠图。
>
> 已知墙（记档不追修）：服装颜色保真——灰睡衣基图下"黑色西服"变体产出灰蓝西服（款式对、颜色拉不住），与公主穿衣运动装偏蓝同因（IPAdapter 基图服装色引力）。待办登记：骨架驱动姿势变体尚未接入锁定事物向导 UI（当前经 layered-produce API 驱动）；F-65 租约 TTL。
>
> **《小明的工作日2》故事2 继承加速 + 守护台自主链首跑（2026-10-08）**：用户指令——《xxxx2》命名约定继承基底可用资产加速测试，守护台自主跑通。落地：**GS-48 asset.inherit**（标题数字后缀自动解析基底项目，plan 生成后自动继承参考图/提示词四套/姿势变体/线稿/全局提示词+提示词闸；文件物理复制+登记读回验证；lock_confirm 留痕 decidedBy=inherit；幂等）+ **GS-49 story.composition.extract**（构图需求单补注册）。守护台事件链全通：GS-39 创建（61s 出 7 卡 1/2/2）→ 蓝图/合成 → 圣经（分发器 304s fetch 超时但服务端完成，查磁盘判定）→ plan（自动继承触发：7 资产命中含 fuzzy 匹配——黄色骑手服←黄色外卖骑手服、外卖头盔←骑行头盔、城市街道←早高峰街道、小明的卧室←小明卧室；4 新实体正确未匹配）→ 构图 → renderAll → placements → 导出 → 双路径走查全通（继承变体站姿西服/骑姿/瘫坐全部按绑定上场）。**跳过抽卡/锁定/线稿三个重人工环节，从创建到导出约 45 分钟（此前全人工链需数小时）。**
>
> 新发现并已修缺陷：
> - **地点锚点不可继承（继承设计缺陷，首跑即撞）**：地点锚点含时间/氛围语境，继承的"晨光照卧室/早高峰街道"覆盖了故事2 圣经自有的"夜晚卧室（含衣柜挂装）/夜晚霓虹街道"，首轮 5/7 场景时间语境全错。修复=location 类别跳过 anchorPrompt/negativePrompt 继承（锚点始终保留目标圣经原文）+ 故事2 数据回滚重渲。
> - **场景换绑必须同时改 assetIds 与 promptAssets**：首次只改 assetIds 重渲无效（renderSpec 的 environmentLocks 来自 promptAssets 内嵌地点对象），双改后一次出图达标。教训=plan 场景数据修改要经服务端守护通道或双字段同步。
> - **render-all 批次审核悬挂**：批次 7 场景全挂 scene_bind 后任务停留 pending_review（done=false），审核决断后批次不收敛，后续 render-all 一律 409。修复=maybeCloseRenderAllBatchTask 钩子——scene_bind 全部决断后自动收敛批次任务（approve/reject 两端点均挂）。
> - **圣经命名漂移是常态**：同义近名（黄色骑手服/黄色外卖骑手服）必须有 fuzzy 匹配（包含 ≥3 字 / 共享尾缀 ≥2 字，同类别候选唯一才采纳，错配>漏配）。
>
> 自主链判定（对照用户"守护台自己跑通"标准）：**事件链步骤执行已自主**（创建/圣经/计划/继承/构图/渲染/摆位/导出/审核批准全经 GS 事件，零即席 API），**但三个判断点仍是操作员（我）兜底**：①scene_bind 审图（视觉评审模型离线时 fail-closed 挂人工）；②导演层错绑修正（结局一/结局二地点错绑——与故事1 同类，圣经 sceneRefs 质检步缺失）；③变体场景绑定（哪个剧情阶段用哪个变体——需 LLM"服装/姿势连续性"校验步）。沉淀为下一步能力建设清单。
>
> **《白雪公主与七个小矮人》接管修复+全链生产批次（2026-10-09，9 人设群像首验）**：外部模型（GPT 类）此前直调 API 跑此故事——5 个项目 4 残缺（脚本失败/模板残留带病推进）、零守护台、零审核、零出图、`stage:export` 假完成。接管后：删 4 残缺项目，从 GS-18 接入正式链跑完唯一结构完整的 78b57e71。
>
> 接管修复清单：①**圣经 sceneRefs 顶层映射全空/错乱**（LLM 产物把女王+王宫绑到 7/11 场景；per-entity sceneRefs 数组不被 plan 消费，真相源是 bible 顶层 sceneRefs 映射 sc_* id→实体组）——按剧情重写 11 场景映射+补第七矮人 Sneezy（圣经只有 6 矮人），plan 重建后 9 人设全绑对；②oMLX Metal 碎片再撞 resource_swap_load_failed（current 17.63GB），重启复位；③prompt-enhance 端点只回草稿不落盘（编辑器 PUT 负责持久化）——驱动脚本两版踩坑（整 PUT 409 / GET 响应包络误用 rev_conflict），定为逐资产 GET→改→PUT{project,_rev}；④参考图端点是**同步长请求**（客户端 30s 掐死 13 个在途批次成僵尸任务，重启收敛），驱动改 1200s 串行；⑤**矮人造型墙**：checkpoint 把 "dwarf" 画成普通小孩/少女（Bashful 首轮 25/22/35 分全废），强化提示词（old dwarf/long beard/chibi/pointed cap+负向 child girl）后 84 分达标；⑥可穿戴道具人体引力墙再现（裙子两次带人）——按 公主穿衣 惯例特批留痕，屏幕表达走换装变体不摆道具；⑦**构图端点 500 无日志**（11 场景×9-11 元素分批校验，某批两次不过即 500 且不留痕）——已加 console.error+logStage 落日志，重试通过 11/11；⑧变体抠图复制品瑕疵（商贩老妇/森林披风均多出第二个提篮）——PIL 区域清零 alpha 修复，**经验：变体提示词写 "holding ONE basket" 或避免手持物，rembg 会保留全部绘制物**。
>
> **多人设同框结论（能力矩阵解锁项）**：分层合成工艺下 7 矮人+白雪公主同框成立——每个角色独立锁定参考图（造型各异：Doc 眼镜/Grumpy 怒眉/Happy 白须笑/Sneezy 黄帽红鼻/Bashful 尖帽羞/Grumpy 红裤），摆位按构图需求单群摆，走查画面群像清晰可辨。服装阶段连续性四变体（披风→日常裙→白礼服+女王商贩伪装）全部按 sceneIds 正确上场，伪装身份（毒苹果场伪装/后果五真身）双形态切换成立。
>
> 残余瑕疵（记档不追修）：矮人个体差异部分靠发色区分（Dopey/Sleepy 近似度高）；后果三-六背景同为小屋外景视角重复；披风变体披风色蓝非森林绿、手提篮内有苹果（剧情为空篮）。导出双路径走查全通（溪边/矿洞×自我介绍/警惕×接过/拒绝 3 选择点公式）。
>
> **《龟兔赛跑》动物姿势墙验证批次（2026-10-10，90 分白雪后撞最后硬骨头）**：核心问题——OpenPose 人形骨架对动物是否适用。结论：**拟人双足动物完全适用**（绘本兔女郎=人形拓扑），四足动物（乌龟）主参考天然行走姿态无需变体。全程守护台事件链：GS-39 创建（59s 7卡 1/2/2）→ 圣经（304s 分发超时查磁盘确认）→ 计划（圣经后果一漏绑兔子已修：乌龟爬过睡兔必须双角色在场）→ 提示词 4 资产 → 抽卡（兔 88 蓝裙拟人立绘/乌龟四足爬行）→ 线稿 → 构图 → 渲染 7/7 → 摆位（跑姿/睡姿变体命中）→ 导出 → 双路径走查全通。
>
> 姿势实验三路径对照（本次核心产出）：①**DWPose 检测器卡通盲区**：ComfyUI 重启注册 DWPreprocessor/AnimalPosePreprocessor（此前 dwpose 模块未加载是进程陈旧非代码缺失）后实测——拟人兔跑/睡姿源图 DWPose 全黑零检测，OpenPose 旧检测器反而检出；`extractComfyuiPoseSkeleton` 加 `preprocessor` 参数（dw/openpose/auto），姿势库 README 写明"全黑即换 OpenPose"。②跑姿/睡姿骨架入公共库（running_side/lying_sleep_side），pose-variant 出图姿势准+身份守住。③绿幕姿势词对照组：动物能出跑姿但身份漂移（红袖无裙）——失败模式与人形相反（人形拉回站姿），骨架驱动是共同正路。
>
> 备注：结局一乌龟冲线图为单龟画面（兔子未入画——sceneRefs 结局一只绑乌龟，"全场欢呼/兔子羞愧"缺兔子在场，属内容取舍可接受）；冲刺带/发令旗道具抽卡 42-45 分人工特批留痕。
>
> **《三只小猪》GS-50 圣经质检步首验 + 拟人猪配方批次（2026-10-10）**：本批次两个建设目标全部验证。①**GS-50 story.bible.qc（新事件，自动化①落地）**：确定性规则检查 + 逐场景 LLM 对照复核 + persist 自动回写并废旧计划——首跑 229 秒修正 8/9 场景绑定（选择点缺三只小猪、后果一/二 道具互串 hot_pot、结局一 蜂蜜蛋糕错挂、木屋难支漏老大 等），修正语义全部经人工复核正确。**圣经质检从"人工读剧情修"变为链内自动步骤**。②**拟人猪骨架变体配方**：v1 跑姿变体身份全丢（猪变黑发人类小孩——人形骨架+跑步词把头拉成人形），v2 强化"物种显性词（big pig head/snout/ears/pink skin/NOT human face）+ ipadapterWeight 0.95"成功——**物种标记弱的拟人动物（猪/羊）必须显性词强化+身份权重拉满；物种标记强的（兔耳）常规档即可**。
>
> 其他：地点锚点支持"状态语义"（稻草房"完好将塌"/木屋"倾斜将塌"，单场景单锚点表达动态时刻）；背景已含事物撤道具摆位惯例（结局一软垫/砖房道具撤除）；驱动脚本 sed 换 PID 事故（抽卡抽到白雪公主项目，bash-3mr2ljtt 已杀，白雪锁定资产无损）——**脚本模板化教训：PID 必须参数化入参，禁止 sed 复制链**。结局二狼"提及未退场"仍入画（简谱档可接受，记档）。走查双路径全通（死守→软垫陷阱 / 生火→热水陷阱）。
>
> **《小猴子下山》GS-51 姿势变体自动编排首验批次（2026-10-10/11，多姿态表达落地）**：用户批评成立——此前故事全角色全场站姿，狼无吹气/撞门/逃跑姿态。本批次建设自动化②闭环：**GS-51 asset.poseVariants.autoGenerate**（LLM 提取逐场景姿势需求 → 按角色×姿势分组 → 匹配公共姿势库骨架 → 骨架驱动生成变体 → layered-produce 登记绑场景，aiTask 全程进度）。首跑实证：小猴子 walking/running/holding 三变体自动产出并正确上场（换桃子捧桃走/追蝴蝶跑/结局二捧桃献母）。
>
> 首跑修复链：①姿势库路径错（ROOT 即 storage 根，勿再拼 storage/）；②index.js 无 asList/asStr 工具函数（新端点 ReferenceError，补齐+堆栈日志入 catch）；③ComfyUI 隔夜掉线（进程死了）——poseauto 报 comfyui_missing_model，重启恢复；④**验收门禁教训：poseauto 走 dispatch 前必须确认 ComfyUI 在线**。
>
> 已知边界（记档）：①摘取类骨架（reaching_up）手部关键点簇被读成第二个角色（两猴分身两次）——需编辑骨架擦除手簇或换"手贴身"源图，该骨架暂标记慎用；②holding_front 骨架偏弱（无头部点）；③猴子变体毛色漂移（棕→深棕黑，身份权重 0.95 仍漂，属颜色墙同类）；④**姿势提取结果未持久化**（poseRequirements 没落 plan，wizard 看不到分析依据——待办：GS-51 内补写）；⑤多节拍场景 LLM 只选一拍（掰玉米场选了"扛物前行"丢了"掰"）——待办：提取器提示词要求"优先动作动词拍"。
>
> 补充沉淀：姿势库 manifest.json 建立（姿势词中文别名→骨架映射），别名扩两轮（前行/捧/扛/驻足/观望/凝视等）；`reviewUnavailable: reference_not_found` 是 pose-review 角色主档未建的常态噪音（不阻断）。
