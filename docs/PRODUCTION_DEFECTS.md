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

---

> 本文最后更新：2026-08-19
>
> **元分析更新**：通过右脑 Kimi 对 286 个 reasoning sessions 进行元分析，发现会话悬挂（最长 61.8h）、性能统计埋点 Bug、`read_recent_context` 异常缓慢（平均 4m）、服务器重启导致孤儿会话（33% 失败）、21% 会话状态不明等新缺陷。详见 P1-08 ~ P1-12。
