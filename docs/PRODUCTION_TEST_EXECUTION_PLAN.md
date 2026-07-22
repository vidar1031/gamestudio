# GameStudio 生产级测试执行计划

> 版本: 2026-06-06
> 目标: 将 `docs/PRODUCTION_DEFECTS.md` 中的四阶段测试基准转化为可执行的测试手册，覆盖 S0（系统启动）→ L1（交互测试）→ L4（文本闭环）→ P1（图片资产闭环）的完整验证链路。
>
> 关联文档：
> - `docs/PRODUCTION_DEFECTS.md` — 缺陷列表与四阶段测试基准
> - `docs/系统生产级推进方案.md` — 放行标准与系统分工
> - `docs/HERMES_RUNTIME_AND_CONTROL_INTERACTION.md` — Hermes 运行机制
> - `docs/KIMI_RIGHT_BRAIN_SUPERVISION_PLAN.md` — 右脑监督评估机制
> - `docs/KIMI_RIGHT_BRAIN_TEST_PLAN.md` — 左右脑双模型测试规划

---

## 1. 测试总览

### 1.1 测试阶段与放行标准

| 阶段 | 目标 | 题目数 | 放行等级 | 前置条件 |
|------|------|--------|----------|----------|
| **S0** | 系统启动与硬检查 | 10 题 | 控制平面可用 | 无 |
| **L1** | 交互测试（分类/路由/OMLX 调用） | 10 题 | 模型链路可用 | S0 全部通过 |
| **L4** | 故事文本生成闭环 | 10 题 | 文本故事可放行 | L1 全部通过 |
| **P1** | 场景图生成与锁定 | 10 题 | 图文故事可放行 | L4 全部通过 + L4-04 已修复 |

**核心原则**：前一阶段未全部通过，不得进入下一阶段。每阶段有 Must Pass（硬性）和 Should Pass（观察）两类检查项。

### 1.2 测试执行前准备

```bash
# 1. 确认环境
node -v    # >= 18
npm -v     # >= 9
python3 --version  # >= 3.10（Hermes 需要）

# 2. 确认端口占用
lsof -i :18888  # OMLX
lsof -i :1999   # GameStudio Server
lsof -i :8868   # GameStudio Editor
lsof -i :2099   # Control Server
lsof -i :8870   # Control Console
lsof -i :8742   # Hermes Gateway
lsof -i :8188   # ComfyUI

# 3. 确认必要环境变量
cat .env.local | grep -E 'MOONSHOT_API_KEY|OPENAI_API_KEY|COMFYUI_ROOT|HERMES_HOME'

# 4. 确认目录结构
ls ai/memory/        # 应有 STATUS.md、TASK_QUEUE.md、DECISIONS.md、LONG_TASKS.md
ls storage/projects/ # 应可读写
ls config/hermes/    # 应有 manager.left-brain.json
```

### 1.3 测试执行顺序

```
S0 ──▶ L1 ──▶ L4 ──▶ P1
 │      │      │      │
启动   交互   文本   图片
硬检查 分类   闭环   资产
```

---

## 2. 第一阶段：S0 — 系统启动与硬检查

> **目标**：验证所有服务可启动、可检测、可响应。任何一项失败即阻断后续阶段。
> **预期耗时**：5-10 分钟

### 2.1 服务启动顺序

```bash
# Step 1: OMLX 启动（如未运行）
# 方式 A: 通过 Control Console 点击"🚀 启动 OMLX"
# 方式 B: 命令行
/Applications/oMLX.app/Contents/MacOS/omlx-cli serve --port 18888

# Step 2: GameStudio 业务平面启动
./start_project.sh --detached

# Step 3: Control 平面启动
./restart_control.sh

# Step 4: 一键启动 Hermes（通过 Control Console）
# 点击"⚡ 一键启动"

# Step 5: ComfyUI 启动（如未运行）
# Control 自检时会自动检测并启动
```

### 2.2 S0 测试题目执行手册

#### S0-T01: OMLX 健康检查

```bash
# 执行
curl -s http://127.0.0.1:18888/health | jq .

# 通过标准
# - status == "healthy"
# - default_model 已加载（非空）
# - current_model_memory <= 14GB（M2 32GB 上限）
```

**失败处理**：
- 若 `status != "healthy"` → 检查 OMLX 日志，`/tmp/omlx-server.log` 或 `~/.omlx/logs/`
- 若 `default_model` 为空 → 调用 `actOnModel('left', 'load')` 加载模型
- 若内存超限 → 卸载当前模型，切换为更小模型

---

#### S0-T02: GameStudio Server 健康检查

```bash
# 执行
curl -s http://127.0.0.1:1999/api/health | jq .

# 通过标准
# - ok == true
```

**失败处理**：
- 若不可达 → `./restart_server.sh` 重启 GameStudio Server
- 若返回错误 → 检查 `apps/server/src/` 日志

---

#### S0-T03: Control Server 健康检查

```bash
# 执行
curl -s http://127.0.0.1:2099/api/health | jq .

# 通过标准
# - ok == true
```

**失败处理**：
- 若不可达 → `./restart_control.sh` 重启 Control 平面
- 检查 `.run/control-server.log`

---

#### S0-T04: Control Console 可访问

```bash
# 执行
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8870

# 通过标准
# - HTTP 200
```

**失败处理**：
- 若返回非 200 → 检查 `control-console` 进程是否存活，检查 `.run/control-console.log`

---

#### S0-T05: Hermes Gateway API 就绪

```bash
# 执行
curl -s http://127.0.0.1:8742/v1/models | jq .

# 通过标准
# - 返回模型列表，包含 hermes-agent 或已加载模型
```

**失败处理**：
- 若不可达 → Control Console 中点击"⚡ 一键启动"重新启动 Hermes
- 若启动失败 → 检查 `gamestudio_self_check` 结果，确认 OMLX 模型已加载

---

#### S0-T06: ComfyUI system_stats 可达

```bash
# 执行
curl -s http://127.0.0.1:8188/system_stats | jq .

# 通过标准
# - comfyui_version 非空
# - devices 含 mps（Apple Silicon）
```

**失败处理**：
- 若不可达 → Control 自检时会自动尝试启动 ComfyUI（通过 Terminal.app 窗口）
- 手动启动：`cd $COMFYUI_ROOT && sh ./start.sh`
- **禁止**使用 `nohup` 后台启动

---

#### S0-T07: Control `ensure_running` 自检

```bash
# 执行（通过 API）
curl -s -X POST http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"GameStudio 自检","productionTest":true}' | jq .

# 通过标准
# - gamestudio_ensure_running.ok == true
# - serverHealth.ok == true
# - editorHealth.ok == true
```

---

#### S0-T08: Control `self_check` 自检（含 ComfyUI）

```bash
# 执行（通过 API，与 T07 同一 session）
# 等待 T07 完成后，session 会继续执行 self_check

# 通过标准
# - gamestudio_self_check.ok == true
# - healthOk == true
# - settingsOk == true
# - diagnoseOk == true
# - comfyUiOk == true
# - imagePreflightOk == true
```

---

#### S0-T09: 记忆文件权威性检查

```bash
# 执行
ls ai/memory/

# 通过标准
# - 只存在 4 个文件：STATUS.md、TASK_QUEUE.md、DECISIONS.md、LONG_TASKS.md
# - 每个文件非空
```

**失败处理**：
- 若文件缺失 → 手动创建空文件并填入基础内容
- 若存在多余文件 → 移动到 `ai/memory/archive/`

---

#### S0-T10: Studio Settings 图片配置检查

```bash
# 执行
curl -s http://127.0.0.1:1999/api/studio/settings | jq '.effective.image'

# 通过标准
# - provider == "comfyui"
# - comfyuiBaseUrl 正确（默认 http://127.0.0.1:8188）
```

---

### 2.3 S0 阶段通过判定

| 结果 | 条件 | 下一步 |
|------|------|--------|
| **通过** | 10 题全部 Must Pass | 进入 L1 阶段 |
| **阻断** | 任意 Must Pass 失败 | 修复后重新执行 S0 |
| **观察项异常** | Should Pass 异常但 Must Pass 全过 | 记录但不阻断，进入 L1 |

---

## 3. 第二阶段：L1 — 交互测试

> **目标**：验证 Control 的请求分类、任务路由、Hermes 调用和结果返回的准确性。
> **预期耗时**：15-30 分钟
> **前置条件**：S0 全部通过

### 3.1 L1 测试题目执行手册

#### L1-T01: `answer_only` 分类准确性

```bash
# 执行
curl -s -X POST http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Hermes 和 OMLX 有什么区别"}' | jq .

# 通过标准
# - classification == "answer_only"
# - 不调用任何工具（无 tool_called 事件）
# - 直接返回文本回答
```

**验证方法**：
```bash
# 获取 sessionId 后检查事件流
curl -s http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions/{sessionId} | jq '.events[] | select(.type=="tool_called")'
# 应返回空数组
```

---

#### L1-T02: `gamestudio_bootstrap_execute` 分类准确性

```bash
# 执行
curl -s -X POST http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"GameStudio 自检","productionTest":true}' | jq .

# 通过标准
# - classification == "gamestudio_bootstrap_execute"
# - plan 包含 ensure_running + self_check 步骤
# - bootstrap 执行成功
```

---

#### L1-T03: 完整 P0 故事 workflow 分类准确性

```bash
# 执行（关键词触发完整链路）
curl -s -X POST http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"一口气生产一个小红帽互动故事","productionTest":true,"requireModelAnswer":true}' | jq .

# 通过标准
# - classification == "story_workflow_execute"
# - plan 为 13 步完整 P0（非最小创建）
# - 必须包含：create_project → configure → generate_scripts → write_scripts → create_bible → compile_blueprint → review_blueprint → repair → preflight_image → compile_compose → validate → export
```

**验证方法**：
```bash
# 检查 plan 步骤数
curl -s http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions/{sessionId} | jq '.plan.steps | length'
# 应 >= 13
```

---

#### L1-T04: 最小创建 plan 分类准确性

```bash
# 执行（无"完整/一口气"关键词）
curl -s -X POST http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"创建一个小红帽互动故事"}' | jq .

# 通过标准
# - classification == "story_workflow_execute"
# - plan 为最小创建（create + inspect + answer，约 3-5 步）
# - 不触发完整 13 步链路
```

---

#### L1-T05: `capability_status_inspection` 分类准确性

```bash
# 执行
curl -s -X POST http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"检查项目 ABC 的能力状态"}' | jq .

# 通过标准
# - classification == "capability_status_inspection"
# - 只读检查，不修改任何文件/项目
# - 无 write/edit/create/rename/delete 操作
```

---

#### L1-T06: `workflow_execute` 不落入 `plan_then_answer`

```bash
# 执行
curl -s -X POST http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"导出项目为 ZIP"}' | jq .

# 通过标准
# - classification 为 workflow_execute 或 write_or_invoke_review
# - 不得落入 plan_then_answer
```

---

#### L1-T07: Agent 记忆加载完整性

```bash
# 执行（创建任意 reasoning session 后检查 Hermes 日志）
grep -E 'memory|AGENTS|USER|MEMORY|TASK_QUEUE|DECISIONS|LONG_TASKS' /tmp/gamestudio-hermes-gateway.log | tail -20

# 通过标准
# - 日志显示 7 个记忆文件全部加载成功
# - ai/AGENTS.md、ai/USER.md、ai/MEMORY.md、ai/memory/LONG_TASKS.md、ai/memory/STATUS.md、ai/memory/TASK_QUEUE.md、ai/memory/DECISIONS.md
```

---

#### L1-T08: OMLX `response_format` fallback

```bash
# 执行（触发需要 JSON schema 的模型调用，如 story_generate_scripts_candidate）
# 通过 API 观察请求实际路由

# 检查方式：查看 control-server 日志
grep -E 'response_format|json_schema|chat/completions' .run/control-server.log | tail -10

# 通过标准
# - 请求实际走 /chat/completions（非 /chat/completions#json_schema）
# - content 字段非空
# - 无 reasoning_content 独占全部 token
```

---

#### L1-T09: 中文脚本不截断

```bash
# 执行（在 L1-T03 的 session 中观察 generate_scripts_candidate 结果）
curl -s http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions/{sessionId} | jq '.artifacts.storyScriptsCandidate'

# 通过标准
# - scripts 内容非空
# - 含至少 2 个 choice 节点
# - 字数 > 800 字（中文）
# - 结尾无截断标记（如"..."、未闭合 JSON）
```

---

#### L1-T10: `productionTest` 完整 bypass

```bash
# 执行（同 L1-T03）
# 观察：session 执行过程中是否有 review gate 弹出

# 验证方法
curl -s http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions/{sessionId} | jq '.events[] | select(.type=="review_requested")'
# 应返回空数组（productionTest=true 时 bypass 所有 review）

# 通过标准
# - 13 步全部自动执行
# - 无 review gate 阻塞
# - 无人工 approve 步骤
```

---

### 3.2 L1 阶段通过判定

| 结果 | 条件 | 下一步 |
|------|------|--------|
| **通过** | 10 题全部 Must Pass | 进入 L4 阶段 |
| **阻断** | 任意 Must Pass 失败 | 修复后重新执行 L1（或从失败项开始） |

---

## 4. 第三阶段：L4 — 故事文本生成闭环（P0）

> **目标**：验证故事文本生成的完整性、结构正确性和可运行性。
> **预期耗时**：20-40 分钟
> **前置条件**：L1 全部通过

### 4.1 P0 完整工作流步骤

```text
step_story_create_project          → 创建项目，返回 projectId
step_story_configure_project       → 写入 meta.json 配置
step_story_generate_scripts_candidate → OMLX 生成 scripts.json 候选
step_story_write_scripts           → 写入 scripts.json
step_story_create_bible            → 生成 Story Bible
step_story_compile_blueprint       → 编译 blueprint.json
step_story_review_blueprint_agent  → Agent 评审蓝图
step_story_repair_blueprint_if_needed → 按评审修复
step_story_preflight_image_provider → 图片 provider preflight
step_story_compile_compose         → 编译 project.json / story.json
step_story_validate_project        → 校验项目结构
step_story_export_project          → 导出 H5
```

### 4.2 L4 测试题目执行手册

#### L4-T01: 创建项目成功

```bash
# 观察 L1-T03 session 的第一步结果
# 或通过独立调用

# 验证
curl -s http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions/{sessionId} | jq '.artifacts.storyProject'

# 通过标准
# - ok == true
# - projectId 非空
# - storage/projects/<id>/meta.json 存在
```

---

#### L4-T02: 写入配置成功

```bash
# 验证
curl -s http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions/{sessionId} | jq '.artifacts.storyProjectConfig'

# 通过标准
# - ok == true
# - meta.json 含配置字段（genre、style、targetAudience 等）
```

---

#### L4-T03: 脚本候选真实生成（非 fallback）

```bash
# 验证
curl -s http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions/{sessionId} | jq '.artifacts.storyScriptsCandidate'

# 通过标准
# - fallback == false（requireModelAnswer=true 时）
# - scripts 内容非空
# - 含至少 2 个 choice 节点
# - scene 节点数 >= 3
```

---

#### L4-T04: 写入脚本成功

```bash
# 验证
curl -s http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions/{sessionId} | jq '.artifacts.storyScriptsWritten'

# 通过标准
# - ok == true
# - scripts.json 存在且可读
```

---

#### L4-T05: Story Bible 生成与持久化

```bash
# 验证
curl -s http://127.0.0.1:1999/api/projects/{projectId} | jq '.state.aiBackground.storyBible'

# 通过标准
# - ok == true（或 bible 对象非空）
# - characters.length >= 2
# - locations.length >= 1
# - 持久化到 project.state.aiBackground.storyBible
```

---

#### L4-T06: 蓝图编译成功

```bash
# 验证
curl -s http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions/{sessionId} | jq '.artifacts.storyBlueprintCompiled'

# 通过标准
# - ok == true
# - blueprint.json 存在
# - 节点数 > 0
```

---

#### L4-T07: 蓝图评审执行

```bash
# 验证
curl -s http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions/{sessionId} | jq '.artifacts.storyBlueprintReviewed'

# 通过标准
# - 完成执行
# - 返回评审意见（允许 repair 或 pass）
# - 若评审要求修复，则进入 repair 步骤
```

---

#### L4-T08: 合成层编译成功

```bash
# 验证
curl -s http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions/{sessionId} | jq '.artifacts.storyComposeCompiled'

# 通过标准
# - ok == true
# - project.json 和 story.json 存在
```

---

#### L4-T09: 项目校验通过

```bash
# 验证
curl -s http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions/{sessionId} | jq '.artifacts.storyValidated'

# 通过标准
# - ok == true
# - 无结构错误
# - evaluator 通过（**注意 L4-04 false-pass 问题**）
```

**⚠️ 关键检查**：L4-09 必须人工确认 evaluator 结果真实有效，不能依赖自动 PASS。

---

#### L4-T10: 项目导出成功

```bash
# 验证
curl -s http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions/{sessionId} | jq '.artifacts.storyExported'

# 通过标准
# - ok == true
# - 导出产物存在（builds/ 目录或 ZIP 文件）
# - 产物包含 index.html 和 story.json
```

---

### 4.3 L4 阶段已知阻塞项

| 编号 | 阻塞项 | 处理方案 |
|------|--------|----------|
| L4-04 | evaluator false-pass | **必须在进入第四阶段前修复**。当前方案：人工复核 validate_project 结果，确认 evaluator 真实通过而非自动 PASS。 |
| L1-02 | 长尾回答 | 测试时设置显式超时（60s），超时则标记为 observation 而非 blocker。 |

### 4.4 L4 阶段通过判定

| 结果 | 条件 | 下一步 |
|------|------|--------|
| **通过** | 10 题全部通过 + L4-04 已修复 | 进入 P1 阶段 |
| **阻断** | 任意题目失败或 L4-04 未修复 | 修复后重新执行 L4 |

---

## 5. 第四阶段：P1 — 场景图生成与锁定

> **目标**：验证图片资产生成、锁定、场景渲染和回填的完整闭环。
> **预期耗时**：30-60 分钟
> **前置条件**：L4 全部通过 + L4-04 已修复

### 5.1 P1 前置硬性 Gate

在进入 P1 测试前，必须确认：

```bash
# 1. Story Bible 有效
curl -s http://127.0.0.1:1999/api/projects/{projectId} | jq '.state.aiBackground.storyBible | {characters: .characters | length, locations: .locations | length}'
# 必须：characters >= 2, locations >= 1

# 2. 资产计划已创建
curl -s http://127.0.0.1:1999/api/projects/{projectId}/ai/story/assets/plan | jq '.plan.assets | length'
# 必须：> 0

# 3. ComfyUI preflight 通过
curl -s http://127.0.0.1:8188/system_stats | jq '.comfyui_version'
# 必须：非空

# 4. image.provider == 'comfyui'
curl -s http://127.0.0.1:1999/api/studio/settings | jq '.effective.image.provider'
# 必须："comfyui"
```

### 5.2 P1 测试题目执行手册

#### P1-T01: 资产计划创建成功

```bash
# 执行（在完整 story workflow 中自动执行，或独立调用）
curl -s -X POST http://127.0.0.1:1999/api/projects/{projectId}/ai/story/assets/plan | jq .

# 通过标准
# - plan 非空
# - assets 数组非空
# - 每个资产含 id, name, category, lockProfile, renderStrategy
```

---

#### P1-T02: 识别 `ref_required` 锁定资产

```bash
# 执行
curl -s http://127.0.0.1:1999/api/projects/{projectId}/ai/story/assets/plan | jq '.plan.assets[] | select(.renderStrategy == "ref_required") | {id, name, category}'

# 通过标准
# - 至少识别出 1 个 renderStrategy == 'ref_required' 的资产
```

---

#### P1-T03: ComfyUI preflight 通过

```bash
# 执行（story workflow 中自动执行）
# 或通过 Control API 触发 bootstrap workflow

# 验证
curl -s http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions/{sessionId} | jq '.artifacts.storyImagePreflight'

# 通过标准
# - ok == true
# - comfyUi.ok == true
# - missingNodes 为空
```

---

#### P1-T04: 锁定测试图生成成功

```bash
# 执行
curl -s -X POST http://127.0.0.1:1999/api/projects/{projectId}/ai/story/lock/test \
  -H "Content-Type: application/json" \
  -d '{"assetId":"...","maxAttempts":3}' | jq .

# 通过标准
# - success == true
# - attempts 非空
# - 测试图落盘到 assets/ai/story_lock_tests/
```

---

#### P1-T05: 锁定测试图 AI 评审通过

```bash
# 检查 P1-T04 返回结果
curl -s http://127.0.0.1:1999/api/projects/{projectId}/ai/story/lock/test | jq '.attempts[-1].analysis'

# 通过标准
# - passed == true
# - score >= 70
# - issues 不阻塞
```

---

#### P1-T06: 锁定参考图保存成功

```bash
# 验证
curl -s http://127.0.0.1:1999/api/projects/{projectId}/ai/story/assets/plan | jq '.plan.assets[] | select(.primaryReferenceAssetUri) | {id, primaryReferenceAssetUri}'

# 通过标准
# - primaryReferenceAssetUri 非空
# - 指向 assets/ai/story_assets/ 下真实文件
```

---

#### P1-T07: 缺少锁定参考时场景渲染被阻断

```bash
# 执行（故意缺失某资产参考）
curl -s -X POST http://127.0.0.1:1999/api/projects/{projectId}/ai/story/scenes/{sceneId}/render \
  -H "Content-Type: application/json" \
  -d '{"skipValidation":false}' | jq .

# 通过标准
# - 返回 missing_required_asset 或 error
# - 不得生成图
```

---

#### P1-T08: 场景渲染生成场景图

```bash
# 执行（所有必需参考已锁定）
curl -s -X POST http://127.0.0.1:1999/api/projects/{projectId}/ai/story/scenes/{sceneId}/render | jq .

# 通过标准
# - success == true
# - 场景图落盘到 assets/ai/story_scenes/
# - 分辨率 >= 768x1024
```

---

#### P1-T09: 场景图资源回填成功

```bash
# 验证
curl -s http://127.0.0.1:1999/api/projects/{projectId} | jq '.story.scenes[] | {sceneId, background: .visuals.background}'

# 通过标准
# - visuals.background 已更新为新生成场景图的 URI
```

---

#### P1-T10: 校验与重新导出成功

```bash
# 执行 validate
curl -s http://127.0.0.1:1999/api/projects/{projectId}/validate | jq .

# 执行 export
curl -s http://127.0.0.1:1999/api/projects/{projectId}/export | jq .

# 通过标准
# - validate 通过（无 broken 引用）
# - export 成功
# - 产物含新场景图
```

---

### 5.3 P1 阶段当前阻塞项

| 编号 | 阻塞项 | 状态 | 处理方案 |
|------|--------|------|----------|
| P1-B01 | Character asset pipeline 未实现 | 活跃 | 当前只能生成 background，角色 sprite 无法生成。测试时跳过 character 相关题目或标记为已知限制。 |
| P1-B02 | generateBackground 仅支持 ComfyUI background | 活跃 | 场景渲染 API 已存在但完整 workflow 未验证。测试时逐步验证。 |
| P1-B03 | 批量场景渲染未实现 | 活跃 | 当前只能单场景渲染。测试时逐场景执行。 |
| P1-B04 | 锁定评审视觉模型可用性 | 活跃 | 若 OMLX 不支持 vision，需降级到 OpenAI 或其他 vision 模型。 |
| P1-B05 | 场景资源回填校验闭环 | 活跃 | 需人工确认 project.json 引用更新正确。 |

### 5.4 P1 阶段通过判定

| 结果 | 条件 | 下一步 |
|------|------|--------|
| **通过** | 10 题全部通过（允许 P1-B01~B05 标记为已知限制） | 进入持续生产阶段 |
| **部分通过** | 文本链路通过 + 图片链路部分通过 | 记录限制，文本故事可放行 |
| **阻断** | 核心图片链路失败 | 修复后重新执行 P1 |

---

## 6. 测试执行方式

### 6.1 手动执行

通过 Control Console UI 或 curl 命令逐个执行上述测试题目，人工验证结果。

### 6.2 半自动执行（推荐）

使用 `productionTest=true` 模式执行完整 workflow，然后通过脚本检查 artifacts：

```bash
# 1. 触发完整 P0 测试
curl -s -X POST http://127.0.0.1:2099/api/control/agents/hermes-manager/agent-runtime-sessions \
  -H "Content-Type: application/json" \
  -d '{"prompt":"一口气生产一个测试用的互动故事","productionTest":true,"requireModelAnswer":true}' | jq -r '.sessionId'

# 2. 等待完成（约 5-15 分钟）
# 3. 检查 artifacts
# 4. 运行验证脚本（见 6.3）
```

### 6.3 自动化验证脚本

```bash
#!/bin/bash
# scripts/test/production_phase_test.sh

SESSION_ID=$1
BASE_URL="http://127.0.0.1:2099"

function check_artifact() {
  local key=$1
  local expected=$2
  local value=$(curl -s "$BASE_URL/api/control/agents/hermes-manager/agent-runtime-sessions/$SESSION_ID" | jq -r ".$key")
  if [ "$value" == "$expected" ]; then
    echo "✅ $key: $value"
  else
    echo "❌ $key: expected $expected, got $value"
  fi
}

echo "=== L4 测试结果验证 ==="
check_artifact "artifacts.storyProject.ok" "true"
check_artifact "artifacts.storyScriptsCandidate.fallback" "false"
check_artifact "artifacts.storyBlueprintCompiled.ok" "true"
check_artifact "artifacts.storyValidated.ok" "true"
check_artifact "artifacts.storyExported.ok" "true"

echo "=== 项目文件验证 ==="
PROJECT_ID=$(curl -s "$BASE_URL/api/control/agents/hermes-manager/agent-runtime-sessions/$SESSION_ID" | jq -r '.artifacts.storyProject.projectId')
ls "storage/projects/$PROJECT_ID/scripts.json" && echo "✅ scripts.json exists" || echo "❌ scripts.json missing"
ls "storage/projects/$PROJECT_ID/blueprint.json" && echo "✅ blueprint.json exists" || echo "❌ blueprint.json missing"
ls "storage/projects/$PROJECT_ID/project.json" && echo "✅ project.json exists" || echo "❌ project.json missing"
```

### 6.4 右脑监督辅助测试

系统启动后，右脑（Kimi）会自动执行监督评估。可在 Control Console 查看：

1. **引擎配置 panel** 顶部状态条显示监督结果
2. **系统健康 panel** 显示 6 大类别评分和修正建议
3. 若发现问题，按修正建议执行后重新测试

---

## 7. 测试记录模板

每次测试执行后，记录以下信息：

```markdown
# 测试记录 — 2026-06-06

## 执行人
<!-- 执行测试的人员 -->

## 环境
- Node.js: v25.9.0
- OMLX: v0.3.8
- Control Server: v0.1.0
- 模型: gpt-oss-20b-MXFP4-Q8

## S0 结果
| 题目 | 结果 | 备注 |
|------|------|------|
| S0-T01 | ✅ / ❌ | |
| ... | | |

## L1 结果
| 题目 | 结果 | 备注 |
|------|------|------|
| L1-T01 | ✅ / ❌ | |
| ... | | |

## L4 结果
| 题目 | 结果 | 备注 |
|------|------|------|
| L4-T01 | ✅ / ❌ | |
| ... | | |

## P1 结果
| 题目 | 结果 | 备注 |
|------|------|------|
| P1-T01 | ✅ / ❌ | |
| ... | | |

## 监督评估
- 总体评分: XX 分
- 发现问题: N 项
- 修正执行: （列出已执行的修正）

## 最终判定
- [ ] S0 通过
- [ ] L1 通过
- [ ] L4 通过
- [ ] P1 通过
- 放行等级: S0 / S1 / S2 / S3
```

---

## 8. 失败处理与重试策略

### 8.1 服务级失败

| 失败场景 | 重试策略 | 最大重试 |
|----------|----------|----------|
| OMLX 503/504 | 指数退避（1s → 2s → 4s） | 3 次 |
| Hermes Gateway 崩溃 | 自动重启（需 U-09 实现） | 无限 |
| ComfyUI 不可达 | 等待 30s 后重试 | 3 次 |
| Control Server 错误 | 立即重启 control | 3 次 |

### 8.2 测试级失败

| 失败场景 | 处理方案 |
|----------|----------|
| 单题失败 | 记录失败原因，修复后单独重试该题 |
| 阶段内多题失败 | 修复后重新执行整个阶段 |
| 跨阶段依赖失败 | 回退到前一阶段，重新验证 |
| 已知缺陷（如 P1-B01） | 标记为限制，不阻断后续测试 |

---

## 9. 与现有测试脚本的关联

| 本文测试 | 现有脚本/文档 | 关系 |
|----------|--------------|------|
| S0-T01~T10 | `scripts/test/smoke_test_pipeline.sh` | 补充：本文细化每题执行方式和失败处理 |
| L1-T03（完整 P0） | `docs/KIMI_RIGHT_BRAIN_TEST_PLAN.md` TC-07 | 本文聚焦生产验证，TC-07 聚焦元分析功能 |
| L4 全部 | `docs/PRODUCTION_DEFECTS.md` 第三阶段 | 本文将缺陷文档中的测试基准转化为可执行手册 |
| P1 全部 | `docs/PRODUCTION_DEFECTS.md` 第四阶段 | 同上 |
| 监督评估 | `docs/KIMI_RIGHT_BRAIN_SUPERVISION_PLAN.md` | 监督评估作为辅助验证手段，不替代人工测试 |

---

> 本文最后更新：2026-06-06
